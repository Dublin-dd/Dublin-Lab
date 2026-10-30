/** Durable local reminders with calendar recurrence and direct notification delivery. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ScheduleId, createAfterScheduleRecord, createAtScheduleRecord, createDailyScheduleRecord,
  createWeeklyScheduleRecord, decodeScheduleRecord, isRecurringScheduleRecord, resolveRecurringOccurrence,
} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { dublinProjectDirectory } from './simin-proposals.ts'

/** One retained reminder and its latest durable in-app notification. */
export interface DublinReminder {
  record: ScheduleRecord
  status: 'active' | 'paused' | 'completed'
  notice?: { scheduledAt: string; deliveredAt: string; unread: boolean; title: string; message: string }
}
const ACTIONS = ['create', 'list', 'update', 'pause', 'resume', 'delete', 'acknowledge'] as const
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('reminderInvalid')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('reminderInvalid')
  return value.trim()
}
function timing(data: Record<string, unknown>, id: string, now: number): ScheduleRecord {
  const title = text(data.title, 120), message = text(data.message, 2000)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const selectors = ['afterSeconds', 'at', 'time'].filter(key => data[key] !== undefined)
  if (selectors.length !== 1 || (data.weekdays !== undefined && data.time === undefined)) throw new Error('reminderInvalid')
  if (data.afterSeconds !== undefined) {
    if (typeof data.afterSeconds !== 'number') throw new Error('reminderInvalid')
    return createAfterScheduleRecord(ScheduleId(id), message, data.afterSeconds, now, title)
  }
  if (data.at !== undefined) return createAtScheduleRecord(ScheduleId(id), message, text(data.at, 100), now, title)
  const time = text(data.time, 8)
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(time)) throw new Error('reminderInvalid')
  const clock = time.length === 5 ? `${time}:00` : time
  if (data.weekdays === undefined) return createDailyScheduleRecord(ScheduleId(id), message, { time: clock, time_zone: zone }, now, title)
  if (!Array.isArray(data.weekdays) || data.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error('reminderInvalid')
  }
  return createWeeklyScheduleRecord(ScheduleId(id), message, { time: clock, time_zone: zone,
    weekdays: data.weekdays.map(day => Number(day)) }, now, title)
}

/** Serialize management, atomic persistence, due delivery and graceful timer teardown. */
export class DublinReminders {
  private tasks: DublinReminder[] = []
  private readonly ready: Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private running = false
  private blocked = false
  /** @param file - private durable JSON path. @param notify - direct delivery callback. @param report - operational error sink. */
  constructor(private readonly file: string, private readonly notify: (task: DublinReminder) => void,
    private readonly report: (error: unknown) => void) { this.ready = this.load() }

  private async load(): Promise<void> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') }
    catch (error) { if (object(error).code === 'ENOENT') return; throw error }
    const data = object(JSON.parse(raw))
    if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 1000) throw new Error('reminderStorageInvalid')
    const ids = new Set<string>()
    this.tasks = data.tasks.map((rawTask) => {
      const task = object(rawTask), record = decodeScheduleRecord(task.record)
      if (!['active', 'paused', 'completed'].includes(String(task.status)) || ids.has(record.id)) throw new Error('reminderStorageInvalid')
      ids.add(record.id)
      const result: DublinReminder = { record, status: task.status as DublinReminder['status'] }
      if (task.notice !== undefined) {
        const notice = object(task.notice)
        if (typeof notice.unread !== 'boolean' || typeof notice.scheduledAt !== 'string' || typeof notice.deliveredAt !== 'string'
          || !Number.isFinite(Date.parse(notice.scheduledAt)) || !Number.isFinite(Date.parse(notice.deliveredAt))) throw new Error('reminderStorageInvalid')
        result.notice = { scheduledAt: notice.scheduledAt, deliveredAt: notice.deliveredAt, unread: notice.unread,
          title: text(notice.title, 120), message: text(notice.message, 2000) }
      }
      return result
    })
  }
  private async commit(tasks: DublinReminder[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, tasks }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
    } finally {
      try { await unlink(temporary) } catch (error) { if (object(error).code !== 'ENOENT') this.report(error) }
    }
    this.tasks = tasks
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('reminderUnavailable'))
    const result = this.chain.then(async () => { await this.ready; return work() })
    this.chain = result.catch(() => undefined)
    return result
  }
  private arm(): void {
    clearTimeout(this.timer)
    if (this.stopped || !this.running || this.blocked) return
    const targets = this.tasks.filter(task => task.status === 'active').map(task => Date.parse(task.record.scheduledAt))
    if (targets.length === 0) return
    const delay = Math.max(1, Math.min(60_000, Math.min(...targets) - Date.now()))
    this.timer = setTimeout(() => {
      void this.tick().catch((error: unknown) => { this.blocked = true; this.report(error) }).finally(() => { this.arm() })
    }, delay)
  }
  private tick(): Promise<void> {
    return this.serialize(async () => {
      const now = Date.now(), next = structuredClone(this.tasks), due: DublinReminder[] = []
      for (const task of next) {
        if (task.status !== 'active' || Date.parse(task.record.scheduledAt) > now) continue
        let scheduledAt = task.record.scheduledAt
        if (isRecurringScheduleRecord(task.record)) {
          const occurrence = resolveRecurringOccurrence(task.record, now)
          scheduledAt = occurrence.occurrenceAt
          if (occurrence.nextScheduledAt === undefined) task.status = 'completed'
          else task.record = { ...task.record, scheduledAt: occurrence.nextScheduledAt }
        } else task.status = 'completed'
        task.notice = { scheduledAt, deliveredAt: new Date(now).toISOString(), unread: true,
          title: task.record.title, message: task.record.prompt }
        due.push(task)
      }
      if (due.length === 0) return
      await this.commit(next)
      for (const task of due) {
        try { this.notify(task) } catch (error) { this.report(error) /* The durable in-app notice remains available. */ }
      }
    })
  }
  /** Recover due reminders and start delivery. @returns readiness after durable recovery and latest-only missed delivery. */
  async start(): Promise<void> { await this.ready; this.running = true; await this.tick(); this.arm() }
  /** Read current reminder state.
   * @returns a detached global catalog, host clock and scheduler health.
    */
  async snapshot(): Promise<{ tasks: DublinReminder[]; now: string; timeZone: string; error: boolean }> {
    await this.ready; await this.chain
    return { tasks: structuredClone(this.tasks), now: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, error: this.blocked }
  }
  /**
   * Validate a model/HTTP request before queued creation, update or cancellation.
   * @param input - fixed reminder action and timing fields.
   * @param signal - caller cancellation, honored before the durable write begins.
   * @returns the committed record, or the current catalog for list.
   */
  async invoke(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const data = object(input), action = data.action
    if (!ACTIONS.some(value => value === action)) throw new Error('reminderInvalid')
    const allowed = action === 'create' || action === 'update'
      ? ['action', 'id', 'title', 'message', 'afterSeconds', 'at', 'time', 'weekdays'] : ['action', 'id']
    if (Object.keys(data).some(key => !allowed.includes(key)) || (action === 'create' && data.id !== undefined)) throw new Error('reminderInvalid')
    if (action === 'list') return this.snapshot()
    const result = await this.serialize(async () => {
      signal?.throwIfAborted()
      const next = structuredClone(this.tasks)
      if (action === 'create') {
        if (next.length >= 1000) throw new Error('reminderLimit')
        const task: DublinReminder = { record: timing(data, randomUUID(), Date.now()), status: 'active' }
        next.push(task); signal?.throwIfAborted(); await this.commit(next); return task
      }
      const id = text(data.id, 100), index = next.findIndex(task => task.record.id === id), task = next[index]
      if (task === undefined) throw new Error('reminderMissing')
      if (action === 'delete') next.splice(index, 1)
      else if (action === 'acknowledge') { if (task.notice !== undefined) task.notice.unread = false }
      else if (action === 'pause') { if (task.status !== 'completed') task.status = 'paused' }
      else if (action === 'update') {
        task.record = timing(data, id, Date.now()); task.status = 'active'
      } else if (action === 'resume') {
        if (task.status !== 'paused') throw new Error('reminderInvalid')
        if (isRecurringScheduleRecord(task.record) && Date.parse(task.record.scheduledAt) <= Date.now()) {
          const nextAt = resolveRecurringOccurrence(task.record, Date.now()).nextScheduledAt
          if (nextAt === undefined) throw new Error('reminderInvalid')
          task.record = { ...task.record, scheduledAt: nextAt }
        }
        task.status = 'active'
      }
      signal?.throwIfAborted(); await this.commit(next); return action === 'delete' ? { id, deleted: true } : task
    })
    this.blocked = false; this.arm(); return result
  }
  /** Stop future delivery and drain accepted work. @returns settlement after cancelling the owned timer. */
  async dispose(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.ready; await this.chain }
}

/**
 * Register the durable reminder owner and the model-facing workbench tool.
 * @param ctx - Host lifecycle and tool registry.
 * @param owner - reminder persistence and delivery owner.
 * @param projectRoot - allowed workbench conversations.
 */
export function installDublinReminders(ctx: Context, owner: DublinReminders, projectRoot: string): void {
  ctx.effect(async () => { await owner.start(); return () => owner.dispose() })
  ctx.inject(['tools'], (runtime) => {
    runtime.tools.register(defineTool({
      name: 'dublin_reminder',
      description: 'Create and manage Dublin Lab reminders. Use this tool for user reminders, not schedule_create. '
        + 'Ask for a time if ambiguous. Create/update requires title, message and exactly one of afterSeconds, at, or time. '
        + 'at is an ISO instant with an explicit offset. time is HH:mm for daily reminders; add weekdays (ISO Monday=1 to Sunday=7) '
        + 'for weekly reminders. Calendar rules use the Mac time zone at creation, returned by list. '
        + 'Confirm the actual saved time and rule only after success. Notifications are direct, with no later AI call. '
        + 'The app must stay running (window may close); missed occurrences surface on restart, latest only per recurring task. '
        + 'Use id for update/pause/resume/delete. update replaces the full title, message and timing and activates the task. '
        + 'Never claim to have scheduled a reminder without a successful create/update result.',
      parameters: {
        action: { type: 'string', enum: ACTIONS, required: true }, id: { type: 'string' },
        title: { type: 'string' }, message: { type: 'string' }, afterSeconds: { type: 'integer' },
        at: { type: 'string' }, time: { type: 'string' }, weekdays: { type: 'array', items: { type: 'integer' } },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined || await dublinProjectDirectory(cwd, projectRoot) === undefined) throw new Error('reminderProjectRequired')
        return JSON.stringify(await owner.invoke(args, exec.signal))
      },
      presentCall: args => ({ card: 'generic', title: `Dublin reminder · ${args.action}`, kind: 'edit' }),
    }))
  })
}
