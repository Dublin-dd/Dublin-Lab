/** Temporary chat identities, scope isolation and explicit destination validation. */
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { DublinTemporarySessions } from '../src/dublin-temporary.ts'
let root: string, ctx: Context
let items: SessionSummary[]
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dublin-temporary-')); ctx = new Context(); items = [] })
afterEach(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
function setup() {
  const create = vi.fn(async (request: { cwd: string; agentPreset: string }) => {
    const sessionId = SessionId(`session-${items.length}`)
    items.push({ sessionId, cwd: request.cwd, agentAvailable: true, blank: true, updatedAt: 1, running: false })
    return { sessionId }
  })
  const fork = vi.fn(async () => ({ sessionId: SessionId('project-continuation') }))
  const createWorkspace = vi.fn(async () => ({ id: 'target' }))
  ctx.provide('sessionController', { list: async () => ({ items }), create, fork } as never)
  ctx.provide('workspaceRegistry', { create: createWorkspace } as never)
  return { owner: new DublinTemporarySessions(ctx, root), create, fork, createWorkspace }
}
it('creates independent private directories with a standard preset and restores them from the Host catalog', async () => {
  const { owner, create } = setup()
  await owner.invoke({ action: 'create' }); await owner.invoke({ action: 'create' })
  expect(create.mock.calls[0]?.[0].cwd).not.toBe(create.mock.calls[1]?.[0].cwd)
  expect(create.mock.calls[0]?.[0]).toMatchObject({ agentPreset: 'standard' })
  expect(await new DublinTemporarySessions(ctx, root).list()).toMatchObject({ sessions: [{ sessionId: 'session-0' }, { sessionId: 'session-1' }] })
  expect(await owner.invoke({ action: 'open', sessionId: 'session-0' })).toEqual({ sessionId: 'session-0' })
})
it('continues only an idle completed temporary chat into an existing project', async () => {
  const { owner, fork } = setup(); await owner.invoke({ action: 'create' })
  await expect(owner.invoke({ action: 'transfer', sessionId: 'session-0', project: 'Example' })).rejects.toThrow('temporaryBusy')
  const source = items[0]
  if (source === undefined) throw new Error('missing source')
  items = [{ ...source, blank: false }]; await mkdir(join(root, 'Example'))
  const result = await owner.invoke({ action: 'transfer', sessionId: 'session-0', project: 'Example' })
  expect(result).toMatchObject({ project: 'Example', sessionId: 'project-continuation' })
  expect(fork).toHaveBeenCalledWith({ sessionId: 'session-0', workspaceId: 'target' })
  expect(items[0]?.cwd).toBe(source.cwd)
  await expect(owner.invoke({ action: 'transfer', sessionId: 'session-0', project: '../elsewhere' })).rejects.toThrow('temporaryInvalid')
})
it('rejects arbitrary directories, forged sessions and undeclared request fields', async () => {
  const { owner, create } = setup()
  await expect(owner.invoke({ action: 'create', cwd: '/anywhere' })).rejects.toThrow('temporaryInvalid')
  await expect(owner.invoke({ action: 'open', sessionId: 'missing' })).rejects.toThrow('temporaryMissing')
  expect(create).not.toHaveBeenCalled()
  const cwd = join(root, 'Project'); await mkdir(cwd)
  items = [{ sessionId: SessionId('project-session'), cwd, blank: false, agentAvailable: true, running: false, updatedAt: 1 }]
  expect(await owner.list()).toEqual({ sessions: [] })
  await expect(owner.invoke({ action: 'open', sessionId: 'project-session' })).rejects.toThrow('temporaryMissing')
})
it('rejects a replaced private-root symlink before creating execution directories', async () => {
  const { owner, create } = setup()
  const other = join(root, 'other'); await mkdir(other)
  await symlink(other, join(root, '.dublin-chats'))
  await expect(owner.invoke({ action: 'create' })).rejects.toThrow('temporaryInvalid')
  expect(create).not.toHaveBeenCalled(); expect(await readdir(other)).toEqual([])
})
