/** Cold-start the packaged Host twice with a private profile and exercise memory persistence without model credentials. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopHostProcess } from '../../lib/types/host-process.js'
import { createPluginProfile } from '../../lib/types/project-manager.js'
const repository=fileURLToPath(new URL('../../../..',import.meta.url))
const bundle=join(repository,'dist/Dublin Lab.app/Contents')
const runtime=join(bundle,'Resources/app/dsh'), resources=join(bundle,'Resources/runtime')
const home=mkdtempSync(join(tmpdir(),'dublin-memory-built-host-'))
const profile=join(home,'profiles/desktop'), projects=join(home,'projects')
mkdirSync(projects,{recursive:true})
createPluginProfile(profile)
writeFileSync(join(profile,'cordis.patch.yml'),'- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
const environment={HOME:home,DSH_HOME:home,SIMIN_PROJECT_ROOT:projects,PATH:process.env.PATH,TMPDIR:home,DSH_DESKTOP_OPEN_DEVTOOLS:'0'}
const create=()=>new DesktopHostProcess(join(bundle,'MacOS/Dublin'),runtime,profile,undefined,environment,undefined,
  join(resources,'primary-runtime'),{pnpm:join(resources,'pnpm/bin/pnpm.cjs'),nodeBin:join(resources,'bin')})
let host=create()
let timer
try{
  const start=async()=>{
    const ready=await Promise.race([host.start(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Memory Host startup timed out')),45000)})])
    clearTimeout(timer)
    const login=await fetch(ready.url,{redirect:'manual'})
    const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')
    const call=async(payload,origin)=>{
      const response=await fetch(new URL('/aipm/memory',ready.url),{headers:{cookie,...payload?{'content-type':'application/json'}:{},...origin?{origin}:{}},...payload?{method:'POST',body:JSON.stringify(payload)}:{}})
      return {status:response.status,data:await response.json()}
    }
    return {ready,call,cookie}
  }
  const first=await start()
  const empty=await first.call()
  assert.equal(empty.status,200);assert.equal(empty.data.items.length,0)
  assert.equal(empty.data.settings.cloud,false);assert.equal(empty.data.settings.automatic,false)
  const saved=await first.call({op:'save',item:{text:'先确认需求再开始开发。',kind:'personal',status:'active',project:null,source:null}})
  assert.equal(saved.status,200);assert.ok(saved.data.id)
  const foreign=await first.call({op:'delete',id:saved.data.id},'https://foreign.invalid')
  assert.equal(foreign.status,403)
  await host.stop(true);host=create()
  const second=await start()
  const restored=await second.call()
  assert.equal(restored.data.items.length,1);assert.equal(restored.data.items[0].id,saved.data.id)
  const html=await fetch(new URL('/',second.ready.url),{headers:{cookie:second.cookie}})
  assert.equal(html.status,200);assert.ok((await html.text()).includes('<html'))
  const removed=await second.call({op:'delete',id:saved.data.id})
  assert.equal(removed.status,200);assert.equal((await second.call()).data.items.length,0)
  console.log(JSON.stringify({ok:true,packagedHost:true,coldStarts:2,persistence:true,originFence:true,remoteModelCalls:0}))
} catch(error){console.error(error);if(error?.diagnostic)console.error(error.diagnostic);process.exitCode=1}
finally{clearTimeout(timer);await host.stop();rmSync(home,{recursive:true,force:true})}
