/** Durable direct reminders, missed recurrence, management ordering and Loader registration. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DublinReminders, installDublinReminders } from '../src/dublin-reminders.ts'

let root: string
const owners: DublinReminders[] = [], contexts: Context[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dublin-reminders-'))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-28T02:00:00Z'))
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const owner of owners.splice(0)) await owner.dispose()
  vi.useRealTimers(); vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
function owner(notify = vi.fn()): DublinReminders {
  const service = new DublinReminders(join(root, 'reminders.json'), notify, vi.fn())
  owners.push(service); return service
}
async function id(service: DublinReminders): Promise<string> { return (await service.snapshot()).tasks[0]?.record.id ?? '' }
it('delivers one hour later without invoking a model and keeps one durable unread notice', async () => {
  const notify = vi.fn(), service = owner(notify)
  await service.start()
  await service.invoke({ action: 'create', title: '交文档', message: '该交文档了', afterSeconds: 3600 })
  await vi.advanceTimersByTimeAsync(3_599_000); expect(notify).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await service.snapshot()
  expect(notify).toHaveBeenCalledTimes(1)
  expect((await service.snapshot()).tasks[0]).toMatchObject({ status: 'completed', notice: { unread: true, title: '交文档' } })
  await vi.advanceTimersByTimeAsync(60_000); expect(notify).toHaveBeenCalledTimes(1)
  await service.invoke({ action: 'acknowledge', id: await id(service) })
  expect((await service.snapshot()).tasks[0]?.notice?.unread).toBe(false)
})
it('recovers overdue one-shots on restart and does not duplicate a committed notice', async () => {
  const first = owner(); await first.start()
  await first.invoke({ action: 'create', title: '交文档', message: '该交文档了', afterSeconds: 60 })
  await first.dispose(); vi.setSystemTime(new Date('2026-10-28T04:00:00Z'))
  const notify = vi.fn(), second = owner(notify); await second.start()
  expect(notify).toHaveBeenCalledOnce(); await second.dispose()
  const third = owner(notify); await third.start()
  expect(notify).toHaveBeenCalledOnce()
  expect((await third.snapshot()).tasks[0]?.notice?.unread).toBe(true)
})
it.each([
  { time: '09:00' }, { time: '09:00', weekdays: [1, 3, 5] },
])('collapses missed calendar occurrences and retains one future target: %j', async (rule) => {
  const first = owner(); await first.start()
  await first.invoke({ action: 'create', title: '日报', message: '写日报', ...rule })
  await first.dispose(); vi.setSystemTime(new Date('2026-11-28T12:00:00Z'))
  const notify = vi.fn(), second = owner(notify); await second.start()
  const task = (await second.snapshot()).tasks[0]
  expect(notify).toHaveBeenCalledOnce()
  expect(task?.status).toBe('active')
  expect(Date.parse(task?.record.scheduledAt ?? '')).toBeGreaterThan(Date.now())
  expect(Date.parse(task?.notice?.scheduledAt ?? '')).toBeLessThanOrEqual(Date.now())
})
it('pauses, resumes without replaying the paused backlog, edits and deletes an armed task', async () => {
  const notify = vi.fn(), service = owner(notify); await service.start()
  await service.invoke({ action: 'create', title: '每日', message: '测试', time: '09:00' })
  const taskId = await id(service)
  await service.invoke({ action: 'pause', id: taskId })
  await vi.advanceTimersByTimeAsync(7 * 86400_000); expect(notify).not.toHaveBeenCalled()
  await service.invoke({ action: 'resume', id: taskId })
  expect(Date.parse((await service.snapshot()).tasks[0]?.record.scheduledAt ?? '')).toBeGreaterThan(Date.now())
  await service.invoke({ action: 'update', id: taskId, title: '新名称', message: '新内容', afterSeconds: 120 })
  await vi.advanceTimersByTimeAsync(60_000); expect(notify).not.toHaveBeenCalled()
  await service.invoke({ action: 'delete', id: taskId })
  await vi.advanceTimersByTimeAsync(120_000); expect(notify).not.toHaveBeenCalled()
  expect((await service.snapshot()).tasks).toEqual([])
})
it('keeps committed notice content when a completed task is edited', async () => {
  const service = owner(); await service.start()
  await service.invoke({ action: 'create', title: '旧名称', message: '旧提醒', afterSeconds: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  await service.invoke({ action: 'update', id: await id(service), title: '新名称', message: '新提醒', afterSeconds: 60 })
  expect((await service.snapshot()).tasks[0]?.notice).toMatchObject({ title: '旧名称', message: '旧提醒' })
})
it.each([
  { action: 'create', afterSeconds: -1 }, { action: 'create', time: '25:00' },
  { action: 'create', afterSeconds: 60, at: '2026-10-28T03:00:00Z' },
  { action: 'create', at: '2026-10-28T03:00:00' }, { action: 'create', time: '09:00', weekdays: [] },
  { action: 'create', time: '09:00', weekdays: [8] }, { action: 'create', afterSeconds: 60, shell: 'touch x' },
])('rejects invalid or ambiguous timing without a durable write: %j', async (input) => {
  const service = owner(); await service.start()
  await expect(service.invoke({ title: '任务', message: '内容', ...input })).rejects.toThrow()
  expect((await service.snapshot()).tasks).toEqual([])
})
it('honors cancellation and stops the timer after owner disposal', async () => {
  const notify = vi.fn(), service = owner(notify); await service.start()
  await expect(service.invoke({ action: 'create', title: '任务', message: '内容', afterSeconds: 60 }, AbortSignal.abort())).rejects.toThrow()
  await service.invoke({ action: 'create', title: '任务', message: '内容', afterSeconds: 60 })
  await service.dispose(); await vi.advanceTimersByTimeAsync(120_000)
  expect(notify).not.toHaveBeenCalled()
  await expect(service.invoke({ action: 'delete', id: await id(service) })).rejects.toThrow('reminderUnavailable')
})
it('does not overwrite damaged storage or publish partial recovery', async () => {
  await writeFile(join(root, 'reminders.json'), '{broken')
  const service = owner()
  await expect(service.start()).rejects.toThrow()
  expect(await readFile(join(root, 'reminders.json'), 'utf8')).toBe('{broken')
  owners.splice(owners.indexOf(service), 1)
})
it('does not publish a successful reminder when atomic storage replacement fails', async () => {
  const service = owner(); await service.start()
  await mkdir(join(root, 'reminders.json'))
  await expect(service.invoke({ action: 'create', title: '任务', message: '内容', afterSeconds: 60 })).rejects.toThrow()
  expect((await service.snapshot()).tasks).toEqual([])
})
it('rechecks wall time after sleep or a clock jump rather than replaying timer ticks', async () => {
  const notify = vi.fn(), service = owner(notify); await service.start()
  await service.invoke({ action: 'create', title: '任务', message: '内容', afterSeconds: 3600 })
  vi.setSystemTime(new Date('2026-10-28T01:00:00Z'))
  await vi.advanceTimersByTimeAsync(60_000); await service.snapshot()
  expect(notify).not.toHaveBeenCalled()
  vi.setSystemTime(new Date('2026-10-28T04:00:00Z'))
  await vi.advanceTimersByTimeAsync(60_000); await service.snapshot()
  expect(notify).toHaveBeenCalledOnce()
})
it('loads the real tool from cordis.yml, pins its schema and removes it on unload', async () => {
  const projectRoot = join(root, 'projects'); await mkdir(join(projectRoot, 'Example'), { recursive: true })
  const path = join(root, 'cordis.yml')
  await writeFile(path, '- name: cordis:prompt\n- name: cordis:tools\n- name: cordis:bridge\n')
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.tools = Tools
  ctx.loader.builtins.prompt = SystemPrompt
  let bridge: Context | undefined
  const service = owner()
  ctx.loader.builtins.bridge = { apply(runtime: Context) {
    bridge = runtime; installDublinReminders(runtime, service, projectRoot)
  } }
  await ctx.plugin(Include, { path: pathToFileURL(path).href }); await ctx.loader.await()
  const session = Session.create(SessionId('reminder-fixture'))
  const bound = Session.create(session.id, [], { ...session.header, cwd: join(projectRoot, 'Example') })
  bound.append('turn/start', { turn: 1 })
  const agent = { id: bound.id, session: bound, ctx } as Agent
  const result = await ctx.tools.execute({ name: 'dublin_reminder', callId: 'reminder-fixture' as never,
    arguments: { action: 'create', title: '交文档', message: '该交文档了', afterSeconds: 3600 }, agent, signal: new AbortController().signal })
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result.content)).toContain('2026-10-28T03:00:00.000Z')
  await expect(JSON.stringify(ctx.tools.schemas(agent).find(tool => tool.name === 'dublin_reminder'), null, 2) + '\n')
    .toMatchFileSnapshot(fileURLToPath(new URL('./expected/dublin-reminder.expected.txt', import.meta.url)))
  if (bridge === undefined) throw new Error('Missing bridge')
  await bridge.fiber.dispose(); expect(ctx.tools.get('dublin_reminder')).toBeUndefined()
})
