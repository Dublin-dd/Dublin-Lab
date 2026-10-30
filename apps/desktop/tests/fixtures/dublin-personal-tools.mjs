/** Hidden Electron composition smoke. Synthetic tone only: no microphone, screen capture or real keys. */
import { app, BrowserWindow, protocol } from 'electron'
import { build } from 'vite'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installDublinTools } from '../../lib/types/dublin-tools-native.js'

async function run() {
const root = fileURLToPath(new URL('../../../..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'dublin-native-smoke-'))
app.setPath('userData', directory)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
let window
app.on('window-all-closed', () => {})
try {
  await app.whenReady()
  const entry = join(directory, 'synthetic.ts')
  await writeFile(entry, `
    import { DublinRecorder } from ${JSON.stringify(join(root, 'packages/client/ui-layout/src/client/dublin-recorder.ts'))};
    window.syntheticCapture = async () => {
      const tone = new AudioContext();
      const oscillator = tone.createOscillator(); oscillator.frequency.value = 440;
      const destination = tone.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => destination.stream } });
      const failures = []; let saved; let received = 0; const phases = [];
      const recorder = new DublinRecorder(window.dublinTools, value => { phases.push(value.phase); received = value.duration; console.info('capture', value.phase, value.duration); }, error => failures.push(error.message), value => { saved = value; });
      await tone.resume();
      await recorder.start('microphone');
      const deadline = Date.now() + 12000;
      while (!phases.includes('recording') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      while (received < 0.5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      recorder.pause(); await new Promise(resolve => setTimeout(resolve, 100)); recorder.pause();
      while (received < 0.9 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      await recorder.stop(); oscillator.stop(); await tone.close();
      if (failures.length) throw Error(failures.join(','));
      if (!saved || saved.duration < 0.5 || !phases.includes('paused')) throw Error('Missing captured audio');
      const bytes = await window.dublinTools.run('recordingRead', { id: saved.id });
      const blob = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(); audio.src = blob;
      await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = reject; });
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw Error('Unseekable WAV duration');
      audio.currentTime = 0.25;
      await new Promise(resolve => { audio.onseeked = resolve; setTimeout(resolve, 1000); });
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (data.getUint32(40, true) + 44 !== bytes.length || !bytes.slice(44).some(byte => byte !== 0)) throw Error('Invalid PCM');
      URL.revokeObjectURL(blob);
      return { id: saved.id, duration: saved.duration, seekable: audio.currentTime >= 0.24, phases: [...new Set(phases)] };
    };
  `)
  const built = await build({ configFile: false, build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'DublinSyntheticSmoke' } } })
  const bundle = Array.isArray(built) ? built[0] : built
  const javascript = bundle.output.find(item => item.type === 'chunk').code
  const store = installDublinTools((event) => {
    if (window === undefined || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame?.url.startsWith('dsh-app://app/')) throw Error('Rejected foreign frame')
  })
  protocol.handle('dsh-app', () => new Response(`<html><body><script>${javascript}</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: resolve(root, 'apps/desktop/lib/preload-app.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => { if (event.message?.startsWith('capture') || event.level === 'error') console.log(event.message) })
  await window.loadURL('dsh-app://app/')
  const result = await Promise.race([window.webContents.executeJavaScript('window.syntheticCapture()'), new Promise((_, reject) => setTimeout(() => reject(Error('Synthetic capture timed out')), 20000))])
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: resolve(root, 'apps/desktop/lib/preload-app.cjs'), sandbox: true, contextIsolation: true } })
  await foreign.loadURL('dsh-app://app/')
  let rejectedForeign = false
  try { await foreign.webContents.executeJavaScript("window.dublinTools.run('recordings', null)") } catch { rejectedForeign = true }
  foreign.destroy()
  if (!rejectedForeign) throw Error('Foreign window was allowed')
  const restored = await store.recordings.list()
  if (restored.length !== 1 || restored[0].id !== result.id || !result.seekable) throw Error('Persistence or seeking failed')
  let rejected = false
  try { await window.webContents.executeJavaScript("window.dublinTools.run('recordingRead', { id: '../../private' })") } catch { rejected = true }
  if (!rejected) throw Error('Path traversal was allowed')
  await writeFile(join(directory, 'result.json'), JSON.stringify(result))
  const wav = await readFile(store.recordings.audioPath(result.id))
  console.log(JSON.stringify({ ok: true, wavBytes: wav.byteLength, duration: result.duration, seekable: result.seekable, phases: result.phases, rejectedTraversal: rejected, rejectedForeign }))
  await store.finish()
  if (process.argv.includes('--preview') || process.argv.includes('--navigation-preview')) {
    const navigation = process.argv.includes('--navigation-preview')
    const require = createRequire(new URL('../../package.json', import.meta.url))
    const entry = join(directory, 'preview.tsx')
    const client = join(root, 'packages/client/ui-layout/src/client')
    await writeFile(entry, navigation ? `
      import { createRoot } from 'react-dom/client';
      import { SiminShell } from ${JSON.stringify(join(client, 'SiminShell.tsx'))};
      import { siminZh } from ${JSON.stringify(join(client, 'simin-locales.ts'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/base.css'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/design-platform.css'))};
      document.documentElement.dataset.platform = 'darwin';
      localStorage.setItem('dublin.organizer.v1.demo', JSON.stringify({id:'demo',kind:'todo',text:'整理本周产品需求',done:false,updatedAt:1}));
      window.fetch = async input => Response.json(String(input).includes('/aipm/reminders') ? {tasks:[{status:'active',record:{id:'demo-reminder',title:'提交产品方案',prompt:'提交产品方案',kind:'once',scheduledAt:new Date(Date.now()+3600000).toISOString()}}],timeZone:'Asia/Shanghai',error:false} : {root:'/demo',projects:[],trash:[],proposals:[]});
      const t = (key, params = {}) => Object.entries(params).reduce((text,[key,value]) => text.replace('{'+key+'}',String(value)),siminZh[key]);
      createRoot(document.getElementById('root')).render(<SiminShell t={t} chat={null} nativeSettings={null}/>);
    ` : `
      import { createRoot } from 'react-dom/client';
      import { DublinPersonalTools } from ${JSON.stringify(join(client, 'DublinPersonalTools.tsx'))};
      import { siminZh } from ${JSON.stringify(join(client, 'simin-locales.ts'))};
      import shell from ${JSON.stringify(join(client, 'SiminShell.module.css'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/base.css'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/design-platform.css'))};
      const t = (key, params = {}) => Object.entries(params).reduce((text, [key,value]) => text.replace('{'+key+'}', String(value)), siminZh[key]);
      createRoot(document.getElementById('root')).render(<div className={shell.shell} data-dublin-style="light" style={{ display: 'block', width: '100vw', height: '100vh' }}><header className={shell.header}><span style={{ marginRight:'auto' }}>Dublin Lab</span><button>{t('search')}</button><button>{t('reminderTasks')}</button><button>{t('organizerTodos')}</button><button>{t('organizerNotes')}</button><DublinPersonalTools t={t} /></header></div>);
    `)
    const output = await build({ configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}' }, esbuild: { jsx: 'automatic' }, resolve: { alias: [
      { find: '@deepseek-ai/dsh-util-crypto', replacement: join(root, 'packages/util/crypto/src/index.ts') },
      { find: /^react$/, replacement: require.resolve('react') },
      { find: 'react/jsx-runtime', replacement: require.resolve('react/jsx-runtime') },
      { find: 'react-dom/client', replacement: require.resolve('react-dom/client') },
    ] }, build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'DublinPreview' } } })
    const files = (Array.isArray(output) ? output[0] : output).output
    const script = files.find(file => file.type === 'chunk').code
    const styles = files.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')).map(file => file.source).join('\n')
    protocol.unhandle('dsh-app')
    protocol.handle('dsh-app', request => new URL(request.url).pathname === '/preview.js'
      ? new Response(script, { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
      : new Response(`<html><head><meta charset="utf-8"><style>body{margin:0}#root{display:grid;height:100vh;overflow:hidden}${styles}</style></head><body><div id="root"></div><script src="dsh-app://app/preview.js"></script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    window.setContentSize(1280, 900)
    await window.loadURL('dsh-app://app/preview')
    const click = async label => window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(timer); reject(Error('Preview button missing')); }, 10000); const timer = setInterval(() => { const button = [...document.querySelectorAll('button')].find(button => (button.textContent.trim().endsWith(${JSON.stringify(label)}) || button.getAttribute('aria-label') === ${JSON.stringify(label)})); if (button) { clearTimeout(deadline); clearInterval(timer); button.click(); setTimeout(resolve, 500); } }, 50); })`)
    if (navigation) {
      await click('工作台');
      await writeFile('/private/tmp/dublin-navigation-home.png', (await window.webContents.capturePage()).toPNG());
    }
    await click('录音')
    await writeFile('/private/tmp/dublin-recording-preview.png', (await window.webContents.capturePage()).toPNG())
    await click('密钥收纳'); await click('新增密钥')
    await writeFile('/private/tmp/dublin-vault-preview.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`document.body.setAttribute('data-ds-dark-theme',''); document.querySelector('[data-dublin-style]').setAttribute('data-dublin-style','dark'); new Promise(resolve => setTimeout(resolve, 300))`)
    await writeFile('/private/tmp/dublin-vault-dark-preview.png', (await window.webContents.capturePage()).toPNG())
    console.log('Preview screenshots saved under /private/tmp/dublin-*-preview.png')
  }
  window.destroy(); await rm(directory, { recursive: true, force: true }); app.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke failed')
  window?.destroy(); await rm(directory, { recursive: true, force: true }); app.exit(1)
}

}
void run()
