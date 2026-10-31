/** Real Cordis waterfalls verify model logging, scoped recall and opt-in history extraction without a remote provider. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinMemoryStore, memoryDefaults } from '../src/dublin-memory-store.ts'
import { DublinMemoryRuntime } from '../src/dublin-memory-runtime.ts'
const resources: {
  ctx: Context
  owner: DublinMemoryRuntime
  store: DublinMemoryStore
  root: string
}[] = []
afterEach(async () => {
  for (const x of resources.splice(0)) {
    await x.owner.dispose()
    await x.ctx.fiber.dispose()
    await x.store.dispose()
    await rm(x.root, {
      recursive: true,
      force: true,
    })
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dublin-memory-runtime-'))
  await mkdir(join(root, 'Project'))
  const ctx = new Context(), store = new DublinMemoryStore(join(root, '.dublin-memory'))
  await store.snapshot()
  const seed = Session.create(SessionId('memory-demo')), session = Session.create(seed.id, [], {
    ...seed.header,
    cwd: join(root, 'Project'),
  })
  const events: SessionEvent[] = [], calls: GenerateOptions[] = [], tools: ToolDefinition[] = []
  const sections: {
    name: string
    text: (context: { scope?: object }) => string
  }[] = []
  const append = (text: string) => {
    const event = session.append('user/message', createUserMessage({
      source: {
        kind: 'user',
      },
      content: [{
        type: 'text',
        text,
      }],
    }), {
      surfaceOp: 'append',
    })
    events.push(event)
    return event
  }
  ctx.provide('systemPrompt', {
    getSectionOrder: () => 100,
    section: (value: typeof sections[number]) => {
      sections.push(value)
    },
  } as never)
  ctx.provide('tools', {
    register: (tool: ToolDefinition) => {
      tools.push(tool)
    },
  } as never)
  ctx.provide('sessionQuery', {
    observeSession: async (id: string) => {
      if (id !== session.id) throw Error('missing')
      return { header: session.header, events: [...events], cursor: Number(session.seq) - 1, [Symbol.dispose]() { } }
    },
  } as never)
  let answer = JSON.stringify({ events: ['已确认先做用户访谈。'], candidates: [{ kind: 'personal', text: '先讨论证据，再决定方案。' }] })
  const stream = vi.fn(async function*(options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push(options)
    yield {
      type: 'text-delta',
      index: 0,
      text: answer,
    }
    yield {
      type: 'finish',
      reason: {
        kind: 'stop',
      },
    }
  })
  ctx.provide('llm', { stream } as never)
  ctx.provide('sessionController', {
    list: async () => ({
      items: [{
        sessionId: session.id,
        cwd: session.header.cwd,
        updatedAt: 1,
        blank: false,
        running: false,
      }],
    }),
  } as never)
  ctx.on('agent/request', async () => ({ provider: 'mock-provider', model: 'mock-model' }))
  ctx.on('agent/pre-step', async ({ messages }) => ({ kind: 'enter', messages }))
  const owner = new DublinMemoryRuntime(ctx, store, root)
  owner.install()
  resources.push({ ctx, owner, store, root })
  const agent = { id: session.id, session, ctx } as Agent
  await ctx.serial('agent/created', { agent, source: 'resume' })
  await ctx.waterfall('agent/request', {
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    provider: 'mock-provider',
    model: 'mock-model',
  }))
  const step = async (text: string) => ctx.waterfall('agent/pre-step', {
    agent,
    messages: [createUserMessage({
      source: {
        kind: 'user',
      },
      content: [{
        type: 'text',
        text,
      }],
    })],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: 'enter',
    messages: [],
  }))
  return {
    root,
    ctx,
    store,
    owner,
    session,
    agent,
    append,
    calls,
    stream,
    tools,
    sections,
    step,
    answer: (value: string) => {
      answer = value
    },
  }
}
it('uses only approved global and current-project memories and logs usage without an auxiliary model call', async () => {
  const f = await fixture()
  const base = { status: 'active', source: null }
  await f.store.put({ ...base, text: '默认使用中文', kind: 'personal', project: null })
  await f.store.put({ ...base, text: '行程项目要先访谈', kind: 'project', project: 'Project' })
  await f.store.put({ ...base, text: '另一个项目的秘密结论', kind: 'project', project: 'Other' })
  await f.store.put({ ...base, text: '还未确认的偏好', kind: 'personal', project: null, status: 'pending' })
  await f.step('项目访谈')
  const prompt = f.sections[0]!.text({ scope: f.agent })
  expect(prompt).toContain('默认使用中文')
  expect(prompt).toContain('行程项目要先访谈')
  expect(prompt).not.toContain('另一个项目')
  expect(prompt).not.toContain('还未确认')
  expect(f.calls).toHaveLength(0)
  expect((await f.store.snapshot()).usage).toHaveLength(1)
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, enabled: false } })
  await f.step('项目访谈')
  expect(f.sections[0]!.text({ scope: f.agent })).toBe('')
})
it('imports only explicitly selected chat and keeps generated preferences pending', async () => {
  const f = await fixture()
  f.append('先讨论证据，再决定方案。')
  await expect(f.owner.invoke({ op: 'extract', sessionId: f.session.id })).rejects.toThrow('memoryCloudRequired')
  expect(f.calls).toHaveLength(0)
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, cloud: true } })
  await f.owner.invoke({ op: 'extract', sessionId: f.session.id })
  await vi.waitFor(async () => {
    expect((await f.store.snapshot()).jobs).toMatchObject([{ status: 'done' }])
  })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]?.provider).toBe('mock-provider')
  const entries = (await f.store.snapshot()).items
  expect(entries).toMatchObject(expect.arrayContaining([expect.objectContaining({
    kind: 'personal',
    status: 'pending',
  }), expect.objectContaining({
    kind: 'event',
    project: 'Project',
  })]))
  await expect(f.owner.invoke({ op: 'extract', sessionId: 'outside-chat' })).rejects.toThrow('memorySourceUnavailable')
  expect((await f.owner.invoke({ op: 'source', id: entries[0]!.id }) as { text: string }).text).toContain('先讨论证据')
})
it('does not process pre-enable history automatically and processes only newer messages after the idle delay', async () => {
  const f = await fixture()
  f.append('这段旧对话不应自动导入')
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, cloud: true, automatic: true } })
  f.append('新的讨论：先明确证据')
  vi.useFakeTimers()
  f.ctx.emit('agent/status', { agent: f.agent, status: 'idle' })
  await vi.advanceTimersByTimeAsync(15000)
  await vi.waitFor(() => {
    expect(f.calls).toHaveLength(1)
  })
  expect(JSON.stringify(f.calls[0]?.messages)).toContain('新的讨论')
  expect(JSON.stringify(f.calls[0]?.messages)).not.toContain('旧对话')
})
it('records a retryable failure without advancing extraction past a failed batch', async () => {
  const f = await fixture()
  f.append('记录产品讨论')
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, cloud: true } })
  f.answer('not-json')
  await f.owner.invoke({ op: 'extract', sessionId: f.session.id })
  await vi.waitFor(async () => {
    expect((await f.store.snapshot()).jobs).toMatchObject([{ status: 'failed' }])
  })
  expect((await f.store.snapshot()).items).toHaveLength(0)
  f.answer(JSON.stringify({ events: ['记录产品讨论'], candidates: [] }))
  await f.owner.invoke({ op: 'extract', sessionId: f.session.id })
  await vi.waitFor(async () => {
    expect((await f.store.snapshot()).jobs).toMatchObject([{ status: 'done' }])
  })
  expect((await f.store.snapshot()).items).toHaveLength(1)
})
it('redacts credentials before auxiliary calls and logs the exact bounded provider input and result', async () => {
  const f = await fixture()
  const audit = vi.spyOn(f.session, 'append')
  f.append('API_KEY: sk-abcdefghijklmnopqrstuvwxyz123456789\n项目先进行用户访谈')
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, cloud: true } })
  await f.owner.invoke({ op: 'extract', sessionId: f.session.id })
  await vi.waitFor(async () => { expect((await f.store.snapshot()).jobs).toMatchObject([{ status: 'done' }]) })
  const prompt = JSON.stringify(f.calls[0]?.messages)
  expect(prompt).toContain('已移除凭据')
  expect(prompt).not.toContain('abcdefghijklmnopqrstuvwxyz')
  const logged = audit.mock.calls.filter(([type]) => type === 'dublin/memory-call').map(([, data]) => ({ data }))
  expect(logged).toMatchObject([
    { data: { phase: 'request', provider: 'mock-provider', model: 'mock-model' } },
    { data: { phase: 'result' } },
  ])
  expect(JSON.stringify(logged[1])).toContain('events')
})
it('falls back to local keyword results when the explicitly configured embedding service is unavailable', async () => {
  const f = await fixture()
  await f.store.put({ text: '默认用中文沟通', kind: 'personal', status: 'active', project: null, source: null })
  await f.owner.invoke({ op: 'settings', settings: { ...memoryDefaults, cloud: true, semantic: true,
    embeddingUrl: 'https://invalid.example/embeddings', embeddingModel: 'demo', credentialRef: 'MISSING_EMBEDDING_KEY' } })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('must not change providers'))
  await f.step('中文')
  expect(f.sections[0]?.text({ scope: f.agent })).toContain('默认用中文沟通')
  expect((await f.store.snapshot()).semanticWarning).toBe('memorySemanticUnavailable')
  expect(network).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(0)
})
it('rejects cross-site memory management before touching the local store and sanitizes internal errors', async () => {
  const f = await fixture()
  const { handleAipmRequest } = await import('../src/aipm-products.ts')
  const { SiminFiles } = await import('../src/simin-files.ts')
  const request = async (origin: string, payload: string) => {
    let status = 0, response = ''
    const req = { url: '/aipm/memory', method: 'POST', headers: { origin, host: '127.0.0.1:8765' },
      socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(payload) } }
    const res = { writeHead(code: number) { status = code }, end(text: string) { response = text } }
    await handleAipmRequest(req as never, res as never, { files: new SiminFiles(f.root), proposals: {} as never, memory: f.owner })
    return { status, response: JSON.parse(response) as Record<string, unknown> }
  }
  expect(await request('https://foreign.example', JSON.stringify({ op: 'save', item: {} }))).toEqual({ status: 403, response: { error: 'localOnly' } })
  expect((await f.store.snapshot()).items).toHaveLength(0)
  expect((await request('dsh-app://app', JSON.stringify({ op: 'unknown' }))).response).toEqual({ error: 'memoryInvalid' })
  const broken = await request('dsh-app://app', '{bad-json')
  expect(broken.response).toEqual({ error: 'memoryUnavailable' })
  expect(JSON.stringify(broken.response)).not.toContain(f.root)
})
