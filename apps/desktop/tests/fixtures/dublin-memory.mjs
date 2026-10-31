/** Isolated hidden memory-page QA with fictional data; no user profile or provider calls. */
import { app, BrowserWindow, protocol } from 'electron'
import { build } from 'vite'
import { mkdtempSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
async function run() {
  const root = fileURLToPath(new URL('../../../..', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'dublin-memory-preview-'))
  app.setPath('userData', directory)
  protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  app.on('window-all-closed', () => {})
  let window
  try {
    await app.whenReady()
    const entry = join(directory, 'memory.tsx'), client = join(root, 'packages/client/ui-layout/src/client')
    await writeFile(entry, `
      import { createRoot } from 'react-dom/client';
      import { SiminShell } from ${JSON.stringify(join(client, 'SiminShell.tsx'))};
      import { siminZh } from ${JSON.stringify(join(client, 'simin-locales.ts'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/base.css'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/design-platform.css'))};
      document.documentElement.dataset.platform = 'darwin';
      const settings = {enabled:true,automatic:false,cloud:false,semantic:false,embeddingUrl:'',embeddingModel:'',credentialRef:''};
      const items = [
        {id:'11111111-1111-4111-8111-111111111111',text:'讨论需求时先确认问题和证据，再决定是否进入开发。',kind:'personal',project:null,status:'active',source:null,createdAt:Date.now(),updatedAt:Date.now()},
        {id:'22222222-2222-4222-8222-222222222222',text:'界面优先使用简洁的中文表达，避免展示无关的实现细节。',kind:'personal',project:null,status:'active',source:null,createdAt:Date.now(),updatedAt:Date.now()},
        {id:'33333333-3333-4333-8333-333333333333',text:'旅行助手第一版优先支持行程整理。',kind:'project',project:'旅行助手',status:'pending',source:{sessionId:'demo',title:'需求讨论',from:1,through:8},createdAt:Date.now(),updatedAt:Date.now()}
      ];
      window.memoryCalls = [];
      window.fetch = async (input,init) => {
        const url=String(input);
        if(url.includes('/aipm/memory')) {
          const payload=init?.body?JSON.parse(init.body):null; window.memoryCalls.push(payload?.op??'get');
          if(payload?.op==='save') items.push({...payload.item,id:crypto.randomUUID(),createdAt:Date.now(),updatedAt:Date.now(),source:null});
          return Response.json(payload ? {} : {items,settings,usage:[],jobs:[]});
        }
        return Response.json(url.includes('/aipm/reminders')?{tasks:[],timeZone:'Asia/Shanghai',error:false}:{root:'/demo',projects:[{name:'旅行助手',path:'/demo/旅行助手',documents:[],files:[]}],trash:[],proposals:[]});
      };
      const t=(key,params={})=>Object.entries(params).reduce((text,[key,value])=>text.replace('{'+key+'}',String(value)),siminZh[key]);
      createRoot(document.getElementById('root')).render(<SiminShell t={t} chat={<div/>} nativeSettings={<div/>}/>);
    `)
    const require = createRequire(new URL('../../package.json', import.meta.url))
    const output = await build({ configFile: false, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
      esbuild: { jsx: 'automatic' }, resolve: { alias: [
        { find: /^react$/, replacement: require.resolve('react') }, { find: /^react\//, replacement: require.resolve('react/package.json').replace('package.json','') },
        { find: /^react-dom\//, replacement: require.resolve('react-dom/package.json').replace('package.json','') },
        { find: '@deepseek-ai/dsh-util-crypto', replacement: join(root, 'packages/util/crypto/src/index.ts') },
      ] }, build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'MemoryPreview' } } })
    const files = (Array.isArray(output) ? output[0] : output).output
    const javascript = files.find(x => x.type === 'chunk').code
    const css = files.filter(x => x.type === 'asset' && x.fileName.endsWith('.css')).map(x => x.source).join('\n')
    protocol.handle('dsh-app', req => new URL(req.url).pathname === '/memory.js'
      ? new Response(javascript,{headers:{'content-type':'application/javascript; charset=utf-8'}})
      : new Response(`<html><head><meta charset="utf-8"><style>body{margin:0}#root{display:grid;height:100vh;overflow:hidden}${css}</style></head><body><div id="root"></div><script src="dsh-app://app/memory.js"></script></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}}))
    window = new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
    const errors=[]
    window.webContents.on('console-message', event => {if(event.level==='error')errors.push(event.message)})
    await window.loadURL('dsh-app://app/')
    const click = label => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const stop=setTimeout(()=>{clearInterval(timer);reject(Error('Missing '+${JSON.stringify(label)}))},10000);const timer=setInterval(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}||x.textContent.trim().startsWith(${JSON.stringify(label)}));if(button){clearTimeout(stop);clearInterval(timer);button.click();setTimeout(resolve,350)}},50)})`)
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,500))')
    await click('长期记忆')
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await writeFile('/private/tmp/dublin-memory-light.png',(await window.webContents.capturePage()).toPNG())
    const initial=await window.webContents.executeJavaScript(`({calls:window.memoryCalls,text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth})`)
    if(initial.overflow||!initial.text.includes('先确认问题')||initial.calls.some(x=>x!=='get'))throw Error('Memory mounting/scoping preview failed')
    await click('待确认')
    await writeFile('/private/tmp/dublin-memory-review.png',(await window.webContents.capturePage()).toPNG())
    await click('新增记忆')
    await window.webContents.executeJavaScript(`document.body.setAttribute('data-ds-dark-theme','');document.querySelector('[data-dublin-style]').setAttribute('data-dublin-style','dark');new Promise(r=>setTimeout(r,300))`)
    await writeFile('/private/tmp/dublin-memory-dark.png',(await window.webContents.capturePage()).toPNG())
    if(errors.length)throw Error(errors.join('\n'))
    console.log(JSON.stringify({ok:true,isolated:true,screenshots:['light','review','dark'],mountCalls:initial.calls}))
    window.destroy();await rm(directory,{recursive:true,force:true});app.exit(0)
  } catch(error) { console.error(error);window?.destroy();await rm(directory,{recursive:true,force:true});app.exit(1) }
}
void run()
