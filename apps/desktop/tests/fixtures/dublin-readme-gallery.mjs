/** Render actual workbench components with fictional data in an isolated, hidden desktop window. */
import { app, BrowserWindow, protocol } from 'electron'
import { build } from 'vite'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

async function main() {
  const root = fileURLToPath(new URL('../../../..', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'dublin-readme-gallery-'))
  const output = join(root, 'docs/assets/readme')
  mkdirSync(join(directory, 'profile'), { recursive: true })
  app.setPath('userData', join(directory, 'profile'))
  protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  app.on('window-all-closed', () => {})
  let window
  try {
    await app.whenReady()
    await mkdir(output, { recursive: true })
    const client = join(root, 'packages/client/ui-layout/src/client')
    const entry = join(directory, 'gallery.tsx')
    await writeFile(entry, `
      import { createRoot } from 'react-dom/client';
      import { SiminShell } from ${JSON.stringify(join(client, 'SiminShell.tsx'))};
      import { siminZh } from ${JSON.stringify(join(client, 'simin-locales.ts'))};
      import { saveSiminView } from ${JSON.stringify(join(client, 'simin-state.ts'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/base.css'))};
      import ${JSON.stringify(join(root, 'packages/client/ui-theme/src/styles/design-platform.css'))};
      document.documentElement.dataset.platform = 'darwin';
      const now = Date.parse('2026-10-30T09:00:00+08:00');
      const project = { name:'旅行规划助手',path:'/demo/projects/旅行规划助手',documents:['需求梳理.md','访谈记录.md'],files:[
        {name:'需求梳理.md',modifiedAt:now,bytes:600,preview:'把分散的目的地收藏，整理成可执行的旅行计划。'},
        {name:'访谈记录.md',modifiedAt:now-3600000,bytes:320,preview:'示例研究：行程规划前需要哪些信息？'}] };
      const markdown = '# 旅行规划助手 · 需求梳理\\n\\n> 演示项目，非个人真实资料。\\n\\n## 要解决的问题\\n\\n用户收藏了许多目的地，却仍需反复切换地图与笔记，才能排出一天的行程。\\n\\n## 第一版范围\\n\\n- 收集目的地、日期和同行人数\\n- 按距离与营业时间组织每日安排\\n- 将确定的行程保存为可编辑文档\\n\\n## 需要补充的证据\\n\\n1. 用户现有规划方式与耗时\\n2. 临时调整时最容易遗漏的信息\\n3. 用户愿意交给 AI 的决定边界\\n\\n## 下一步\\n\\n先访谈，再确认范围；关键判断与助手讨论后写入文档。';
      const record = {id:'demo-recording',title:'产品想法 · 旅行规划助手',createdAt:now,duration:86,source:'mixed',interrupted:false,
        segments:[{start:1,end:12,speaker:'0',text:'我想做一个旅行规划助手，把收藏的地点整理成每天的安排。'},
        {start:14,end:29,speaker:'1',text:'先确认用户现在怎样规划，以及他们在哪一步最容易卡住。'},
        {start:32,end:48,speaker:'0',text:'第一步访谈五位经常自由行的用户，整理现有流程与痛点。'}],
        summaries:[{kind:'idea',text:'想法：帮助自由行用户，将分散的地点收藏整理成可调整的每日行程。\\n\\n待验证：规划耗时、调整频率，以及用户愿意交给 AI 的决定。',actions:[]} ]};
      const todos=[{id:'demo-todo-1',kind:'todo',text:'整理五位用户的访谈问题',done:false,updatedAt:now},
        {id:'demo-todo-2',kind:'todo',text:'明确第一版范围与不做的事项',done:false,updatedAt:now-1000},
        {id:'demo-todo-3',kind:'todo',text:'收集三个竞品的行程编辑流程',done:false,updatedAt:now-2000},
        {id:'demo-todo-4',kind:'todo',text:'创建旅行规划助手项目',done:true,updatedAt:now-3000},
        {id:'demo-note',kind:'note',text:'旅行规划助手 · 随手想法\\n\\n先把问题说清楚：用户缺的是推荐，还是把收藏变成行程的能力？\\n\\n下次访谈追问：\\n• 最近一次出行是怎样规划的？\\n• 临时调整时，最麻烦的环节是什么？\\n• 哪些判断希望自己保留？',done:false,updatedAt:now}];
      for (const item of todos) localStorage.setItem('dublin.organizer.v1.'+item.id,JSON.stringify(item));
      const reminders={tasks:[{status:'active',record:{id:'demo-reminder-1',title:'提交需求梳理文档',prompt:'检查证据和范围后，提交需求梳理文档。',kind:'once',scheduledAt:'2026-10-30T09:00:00Z'}},
        {status:'active',record:{id:'demo-reminder-2',title:'每周整理项目进展',prompt:'整理本周已确认的结论与下周待验证的问题。',kind:'weekly',time:'17:00:00',timeZone:'Asia/Shanghai',weekdays:[5],scheduledAt:'2026-11-06T09:00:00Z'}}],timeZone:'Asia/Shanghai',error:false};
      window.fetch=async input=>{const url=new URL(input instanceof Request?input.url:input.toString(),'https://demo.invalid');
        if(url.pathname==='/aipm/state')return Response.json({root:'/demo/projects',projects:[project],trash:[],proposals:[]});
        if(url.pathname==='/aipm/file')return Response.json({markdown,version:'demo-version'});
        if(url.pathname==='/aipm/reminders')return Response.json(reminders);
        if(url.pathname==='/aipm/github'){
          if(url.searchParams.get('op')==='status')return Response.json({installed:true,login:'demo-user',root:'/demo/github'});
          if(url.searchParams.get('op')==='trending')return Response.json({items:[
            {repo:'example/research-notebook',description:'A local notebook for organizing research evidence and product decisions.',language:'TypeScript',stars:'2,480',added:'126'},
            {repo:'example/voice-notes',description:'Turn recorded ideas into structured notes and reviewable action items.',language:'Python',stars:'1,860',added:'98'},
            {repo:'example/agent-workbench',description:'Tools for building personal AI workspaces and document workflows.',language:'TypeScript',stars:'3,210',added:'152'}]});
          if(url.searchParams.get('op')==='translate')return Response.json({repo:url.searchParams.get('repo'),translated:'演示简介：整理研究证据、记录产品判断，帮助团队沉淀可复用的结论。'});
        }
        throw Error('Documentation fixture rejected an unexpected network request');
      };
      window.dublinTools={run:async(op,input)=>{
        if(op==='recordings')return [record];
        if(op==='transcriptionSettings')return {region:'beijing',model:'qwen-audio-3.1-asr-flash-filetrans',summaryModel:'qwen-plus',configured:true};
        if(op==='vaultList')return [{id:'demo-vault',provider:'模型服务（演示）',account:'demo@example.invalid',updatedAt:now}];
        if(op==='recordingRead'){const bytes=new Uint8Array(44+32000);const v=new DataView(bytes.buffer);
          const text=(at,s)=>[...s].forEach((c,i)=>bytes[at+i]=c.charCodeAt(0));text(0,'RIFF');v.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,32000,true);return bytes;}
        throw Error('Documentation fixture rejected a native mutation');
      }};
      window.docsNavigate=saveSiminView;
      const t=(key,params={})=>Object.entries(params).reduce((text,[key,value])=>text.replace('{'+key+'}',String(value)),siminZh[key]);
      createRoot(document.getElementById('root')).render(<SiminShell t={t} chat={null} nativeSettings={null}/>);
    `)
    const require = createRequire(new URL('../../package.json', import.meta.url))
    const result = await build({ configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}' },
      esbuild: { jsx: 'automatic' }, resolve: { alias: [
        { find: '@deepseek-ai/dsh-util-crypto', replacement: join(root, 'packages/util/crypto/src/index.ts') },
        { find: /^react$/, replacement: require.resolve('react') },
        { find: 'react/jsx-runtime', replacement: require.resolve('react/jsx-runtime') },
        { find: 'react-dom/client', replacement: require.resolve('react-dom/client') },
      ] }, build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'DublinReadmeGallery' } } })
    const files = (Array.isArray(result) ? result[0] : result).output
    const script = files.find(file => file.type === 'chunk').code
    const css = files.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')).map(file => file.source).join('\n')
    protocol.handle('dsh-app', request => new URL(request.url).pathname === '/gallery.js'
      ? new Response(script, { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
      : new Response(`<html><head><meta charset="utf-8"><style>body{margin:0}#root{display:grid;height:100vh;overflow:hidden}${css}</style></head><body><div id="root"></div><script src="dsh-app://app/gallery.js"></script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    window.setContentSize(1440, 1000)
    window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => { callback(false) })
    await window.loadURL('dsh-app://app/gallery')
    const evaluate = code => window.webContents.executeJavaScript(code)
    const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,350))')
    const click = async (label, index = 0) => {
      await evaluate(`(() => {const buttons=[...document.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')===${JSON.stringify(label)} || b.textContent.trim().endsWith(${JSON.stringify(label)}));const button=buttons[${index}];if(!button)throw Error('Missing gallery control: '+${JSON.stringify(label)});button.click()})()`)
      await settle()
    }
    const capture = async name => {
      await settle()
      let picture = await window.webContents.capturePage()
      if (['project', 'todos', 'notes', 'reminders', 'transcript', 'vault'].includes(name)) {
        const scale = picture.getSize().width / 1440
        const selector = name === 'project' ? "document.querySelector('article')?.closest('section')" : "document.querySelector('aside[role=region]')"
        const region = await evaluate(`(() => { const element=${selector}; if(!element)throw Error('Missing capture region'); return element.getBoundingClientRect().toJSON() })()`)
        picture = picture.crop({ x: Math.round(region.left * scale), y: Math.round(region.top * scale),
          width: Math.round(region.width * scale), height: Math.round(region.height * scale) })
      }
      await writeFile(join(output, `dublin-${name}.png`), picture.toPNG())
      console.log(`Captured ${name}`)
    }
    await settle()
    await capture('home')
    await evaluate(`window.docsNavigate({project:'旅行规划助手',file:'需求梳理.md',page:'project',tab:'document'})`)
    await settle(); await click('专注阅读'); await capture('project'); await click('退出专注')
    await click('工作台')
    await click('待办事项'); await capture('todos'); await click('关闭')
    await click('随手记')
    await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('旅行规划助手 · 随手想法'));if(!button)throw Error('Missing example note');button.click()})()`)
    await capture('notes'); await click('关闭')
    await click('定时任务'); await capture('reminders'); await click('关闭')
    await click('GitHub 热门'); await click('翻译成中文'); await capture('github')
    await click('录音'); await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('产品想法 · 旅行规划助手'));if(!button)throw Error('Missing example recording');button.click()})()`)
    await evaluate(`document.querySelector('audio')?.closest('section')?.scrollIntoView({block:'start'})`)
    await capture('transcript'); await click('关闭')
    await click('密钥收纳'); await capture('vault'); await click('关闭')
    await click('设置'); await click('工作台风格')
    await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=700;const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,1000,700);gradient.addColorStop(0,'#d9e1f7');gradient.addColorStop(.5,'#edf0fa');gradient.addColorStop(1,'#eaded4');ctx.fillStyle=gradient;ctx.fillRect(0,0,1000,700);const blob=await new Promise(resolve=>canvas.toBlob(resolve));const transfer=new DataTransfer();transfer.items.add(new File([blob],'demo-background.png',{type:'image/png'}));const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await settle(); await capture('appearance')
    console.log('DUBLIN_README_GALLERY_OK')
    window.destroy(); window = undefined
    await rm(directory, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gallery generation failed')
    window?.destroy(); await rm(directory, { recursive: true, force: true }); app.exit(1)
  }
}
void main()
