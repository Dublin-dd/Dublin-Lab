/** Fixed browser actions over a real child CLI and Loader-owned tool/approval pipeline. */
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Approval from '@deepseek-ai/dsh-user-approval'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DublinBrowser, installDublinBrowser, parseDublinBrowserInput } from '../src/dublin-browser.ts'
import { installSiminProposals, SiminProposals } from '../src/simin-proposals.ts'
import { SiminFiles } from '../src/simin-files.ts'

let root: string
let cli: string
const browsers: DublinBrowser[] = []
const contexts: Context[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dublin-browser-test-'))
  cli = join(root, 'ego-fixture.mjs')
  await writeFile(cli, `#!${process.execPath}
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let observation;
let currentUrl = "";
globalThis.HTMLInputElement = class {
  constructor(type) { this.type = type; this.autocomplete = ""; }
  getAttribute() { return this.type; }
};
globalThis.HTMLTextAreaElement = class {};
globalThis.document = { querySelectorAll(selector) {
  return selector === "#wrapper" ? [{ getAttribute: () => null }] : [new HTMLInputElement(selector === "#password" ? "password" : "text")];
} };
const page = {
  async goto(url) {
    currentUrl = url;
    if (url.includes("stderr.invalid")) console.log = (...args) => console.error(...args);
    if (url.includes("fail.invalid")) throw new Error("User took control");
    if (url.includes("wait.invalid")) { await writeFile(${JSON.stringify(join(root, 'ready'))}, "ready"); await new Promise(resolve => setTimeout(resolve, 60000)); }
  },
  snapshot: async () => currentUrl.includes("big.invalid") ? "x".repeat(10000) : JSON.stringify({ title: "Fixture page", space: typeof observation === "number" ? "reused" : "new", secret: process.env.TEST_API_KEY ?? null }),
  click: async () => {}, fill: async () => {}, press: async () => {},
  evaluate: async (fn, selector) => fn(selector),
  mouse: { move: async () => {}, wheel: async () => {} },
  async screenshot() {
    const directory = await mkdtemp(join(tmpdir(), "dublin-ego-png-"));
    const file = join(directory, "shot.png");
    await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    return file;
  },
};
const taskSpace = async identity => { observation = identity; return { spaceId: 77, page: () => page, finish: async () => {} }; };
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
await new AsyncFunction("taskSpace", process.argv[4])(taskSpace);
`, { mode: 0o700 })
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const browser of browsers.splice(0)) await browser.dispose()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function browser(timeoutMs = 10000, maxOutputBytes = 1024 * 1024): DublinBrowser {
  const owner = new DublinBrowser({ executable: cli, timeoutMs, maxOutputBytes })
  browsers.push(owner)
  return owner
}
const signal = (): AbortSignal => new AbortController().signal

it.each([
  null,
  [],
  'script',
  { action: 'snapshot', keep: true },
  { action: 'eval', script: 'process.exit()' },
  { action: 'open', url: 'file:///etc/passwd' },
  { action: 'open', url: 'javascript:alert(1)' },
  { action: 'open', url: 'https://user:pass@example.com' },
  { action: 'open', url: 'https://example.com', script: 'process.exit()' },
  { action: 'screenshot', path: '/tmp/private-file' },
  { action: 'snapshot', spaceId: 123 },
  { action: 'press', selector: '#search', key: 'Meta+O' },
  { action: 'fill', selector: '@10', text: 'text' },
  { action: 'scroll', deltaY: 2001 },
  { action: 'click', selector: 1 },
])('rejects unsafe or cross-action input at the executor: %j', async (value) => {
  expect(() => parseDublinBrowserInput(value)).toThrow()
  await expect(browser().run('session', value, signal())).rejects.toThrow()
})
it('reuses one space, scrubs credentials, and returns a bounded PNG without accepting a local path', async () => {
  vi.stubEnv('TEST_API_KEY', 'must-not-leak')
  const owner = browser()
  expect(JSON.parse((await owner.run('session', { action: 'open', url: 'https://example.com' }, signal())).text)).toEqual({ title: 'Fixture page', space: 'new', secret: null })
  expect(JSON.parse((await owner.run('session', { action: 'snapshot' }, signal())).text)).toMatchObject({ space: 'reused' })
  const screenshot = await owner.run('session', { action: 'screenshot' }, signal())
  expect(screenshot.image?.startsWith('iVBOR')).toBe(true)
  await owner.run('session', { action: 'finish' }, signal())
  await expect(owner.run('session', { action: 'snapshot' }, signal())).rejects.toThrow('Start')
})
it('accepts REPL results on stderr as emitted by the native ego helper', async () => {
  const result = await browser().run('stderr', { action: 'open', url: 'https://stderr.invalid' }, signal())
  expect(result.text).toContain('Fixture page')
})
it('treats injected-looking form text as data and rejects password fields before fill', async () => {
  const owner = browser()
  await owner.run('session', { action: 'open', url: 'https://example.com' }, signal())
  const text = '\"); throw new Error("injected"); //'
  await expect(owner.run('session', { action: 'fill', selector: '#search', text }, signal())).resolves.toMatchObject({ spaceId: 77 })
  await expect(owner.run('session', { action: 'fill', selector: '#password', text: 'not-entered' }, signal())).rejects.toThrow('failed')
  await expect(owner.run('session', { action: 'open', url: 'https://example.com' }, signal())).rejects.toThrow('paused')
})
it('does not create a replacement space after user takeover or a broken CLI', async () => {
  const owner = browser()
  await expect(owner.run('session', { action: 'open', url: 'https://fail.invalid' }, signal())).rejects.toThrow('Stop')
  await expect(owner.run('session', { action: 'open', url: 'https://example.com' }, signal())).rejects.toThrow('paused')
  const missing = new DublinBrowser({ executable: join(root, 'not-installed'), timeoutMs: 1000, maxOutputBytes: 4096 })
  browsers.push(missing)
  await expect(missing.run('session', { action: 'open', url: 'https://example.com' }, signal())).rejects.toThrow('not installed')
})
it('does not let a wrapper selector bypass protected-input inspection', async () => {
  const owner = browser()
  await owner.run('wrapper', { action: 'open', url: 'https://example.com' }, signal())
  await expect(owner.run('wrapper', { action: 'fill', selector: '#wrapper', text: 'not-entered' }, signal())).rejects.toThrow('failed')
})
it('cancels and awaits an active CLI and refuses later work after disposal', async () => {
  const owner = browser(10000)
  const operation = owner.run('session', { action: 'open', url: 'https://wait.invalid' }, signal())
  const settled = operation.then(() => 'unexpected success', (error: unknown) => error instanceof Error ? error.message : String(error))
  await vi.waitFor(async () => { expect(await readFile(join(root, 'ready'), 'utf8')).toBe('ready') }, { timeout: 5000 })
  await owner.dispose()
  expect(await settled).toContain('interrupted')
  await expect(owner.run('other', { action: 'open', url: 'https://example.com' }, signal())).rejects.toThrow('cancelled')
})
it('enforces deadline and output limits instead of returning partial success', async () => {
  await expect(browser(100).run('slow', { action: 'open', url: 'https://wait.invalid' }, signal())).rejects.toThrow('interrupted')
  await expect(browser(3000, 4096).run('large', { action: 'open', url: 'https://big.invalid' }, signal())).rejects.toThrow('interrupted')
  expect(() => browser(0)).toThrow('configuration')
})

async function boot(): Promise<{ ctx: Context; agent: Agent; bridge: Context }> {
  const projectRoot = join(root, 'projects')
  await mkdir(join(projectRoot, 'Project'), { recursive: true })
  const legacy = join(root, 'legacy-projects')
  await symlink(projectRoot, legacy)
  const path = join(root, 'cordis.yml')
  await writeFile(path, '- name: cordis:prompt\n- name: cordis:tools\n- name: cordis:approval\n- id: bridge\n  name: cordis:bridge\n')
  const ctx = new Context()
  const mounted: { bridge?: Context } = {}
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.prompt = SystemPrompt
  ctx.loader.builtins.tools = Tools
  ctx.loader.builtins.approval = Approval
  ctx.loader.builtins.bridge = { apply(runtime: Context) {
    mounted.bridge = runtime
    installSiminProposals(runtime, new SiminProposals(new SiminFiles(projectRoot)))
    installDublinBrowser(runtime, projectRoot, { executable: cli, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 })
  } }
  await ctx.plugin(Include, { path: pathToFileURL(path).href })
  await ctx.loader.await()
  const header = Session.create(SessionId('browser-fixture')).header
  const session = Session.create(header.id, [], { ...header, cwd: join(legacy, 'Project') })
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx } as Agent
  await ctx.serial('agent/created', { agent, source: 'startup' })
  if (mounted.bridge === undefined) throw new Error('Workbench bridge did not mount')
  return { ctx, agent, bridge: mounted.bridge }
}

it('loads the tool through cordis.yml, requires one-shot approval, and keeps legacy-cwd shell denial', async () => {
  const { ctx, agent, bridge } = await boot()
  const invoke = (args: unknown, name = 'dublin_browser') => ctx.tools.execute({ name, callId: 'browser-test' as never, arguments: args, signal: signal(), agent })
  const denied = await invoke({ action: 'open', url: 'https://example.com' })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('not approved')
  const decisions: string[] = []
  ctx.on('approval/request', async (request) => { decisions.push(request.toolName); return 'allowed-once' })
  const allowed = await invoke({ action: 'open', url: 'https://example.com' })
  expect(allowed.isError).not.toBe(true)
  expect(decisions).toEqual(['dublin_browser'])
  const injected = await invoke({ action: 'snapshot', script: 'process.exit()' })
  expect(injected.isError).toBe(true)
  ctx.tools.register(Tools.defineTool({ name: 'bash', description: 'fixture shell', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'must not execute' }))
  const shell = await invoke({}, 'bash')
  expect(shell.isError).toBe(true)
  const prompt = (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(section => section.name === 'app:simin-project')?.text
  expect(prompt).toContain('Dublin Lab')
  expect(prompt).not.toContain('思敏')
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'dublin_browser')
  await expect(JSON.stringify({ prompt, schema, result: allowed.content, denied: shell.content }, null, 2) + '\n').toMatchFileSnapshot(fileURLToPath(new URL('./expected/dublin-browser.expected.txt', import.meta.url)))
  await bridge.fiber.dispose()
  expect(ctx.tools.get('dublin_browser')).toBeUndefined()
})
