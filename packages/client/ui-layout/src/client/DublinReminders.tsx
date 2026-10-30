/** Persistent Host reminders, management drawer and durable in-app notices. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { siminRequest } from './simin-api.ts'
import { DublinToolMark, type DublinToolRequest, type ReminderSummary } from './DublinNavigation.tsx'
import css from './DublinOrganizer.module.css'
import remindersCss from './DublinReminders.module.css'

interface Task {
  record: {
    id: string
    title: string
    prompt: string
    kind: string
    scheduledAt: string
    time?: string
    timeZone?: string
    weekdays?: number[]
  }
  status: 'active' | 'paused' | 'completed'
  notice?: { scheduledAt: string; deliveredAt: string; unread: boolean; title: string; message: string }
}
type Copy = PropsLocale<'simin'>['t']
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('reminderInvalid')
  return value as Record<string, unknown>
}
function catalog(value: unknown): { tasks: Task[]; timeZone: string; error: boolean } {
  const data = object(value)
  if (!Array.isArray(data.tasks) || typeof data.timeZone !== 'string' || typeof data.error !== 'boolean') throw new Error('reminderInvalid')
  const tasks: Task[] = data.tasks.map((raw) => {
    const task = object(raw), record = object(task.record)
    if (!['active', 'paused', 'completed'].includes(String(task.status))
      || ['id', 'title', 'prompt', 'kind', 'scheduledAt'].some(key => typeof record[key] !== 'string')
      || !Number.isFinite(Date.parse(String(record.scheduledAt)))) throw new Error('reminderInvalid')
    const item: Task = { status: task.status as Task['status'], record: {
      id: String(record.id), title: String(record.title), prompt: String(record.prompt), kind: String(record.kind),
      scheduledAt: String(record.scheduledAt),
    } }
    if (record.time !== undefined) {
      if (typeof record.time !== 'string' || typeof record.timeZone !== 'string') throw new Error('reminderInvalid')
      item.record.time = record.time; item.record.timeZone = record.timeZone
    }
    if (record.weekdays !== undefined) {
      if (!Array.isArray(record.weekdays) || record.weekdays.some(day => typeof day !== 'number')) throw new Error('reminderInvalid')
      item.record.weekdays = record.weekdays.map(day => Number(day))
    }
    if (task.notice !== undefined) {
      const notice = object(task.notice)
      if (typeof notice.unread !== 'boolean' || typeof notice.scheduledAt !== 'string' || typeof notice.deliveredAt !== 'string'
        || !Number.isFinite(Date.parse(notice.scheduledAt)) || !Number.isFinite(Date.parse(notice.deliveredAt))) throw new Error('reminderInvalid')
      if (typeof notice.title !== 'string' || typeof notice.message !== 'string') throw new Error('reminderInvalid')
      item.notice = { unread: notice.unread, scheduledAt: notice.scheduledAt, deliveredAt: notice.deliveredAt,
        title: notice.title, message: notice.message }
    }
    return item
  })
  return { tasks, timeZone: data.timeZone, error: data.error }
}
function localDate(value: string): string {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/**
 * Keep the reminder feed mounted across project navigation and drawer changes.
 * @param props - workbench-localized copy.
 * @returns the task entry, one management drawer and pending reminder banners.
 */
export function DublinRemindersControl({ t, showEntry = true, request, restoreFocus, onSummary }: {
  t: Copy
  showEntry?: boolean
  request?: DublinToolRequest | null
  restoreFocus?: () => void
  onSummary?: (summary: ReminderSummary) => void
}) {
  const [data, setData] = useState<{ tasks: Task[]; timeZone: string; error: boolean }>({ tasks: [], timeZone: '', error: false })
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const entry = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const abort = useRef<AbortController | null>(null), version = useRef(0)
  const id = useId()
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const serial = ++version.current
    try {
      const next = catalog(await siminRequest('/aipm/reminders', undefined, signal))
      if (!signal?.aborted && serial === version.current) { setData(next); setError(false) }
    } catch (_error) { if (!signal?.aborted && serial === version.current) setError(true) }
  }, [])
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, document.hidden ? 30_000 : 3000)
    }
    const visible = (): void => { if (!document.hidden) void refresh(controller.signal) }
    const drawers = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== 'reminders') setOpen(false)
    }
    void poll()
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('dublin-drawer-open', drawers)
    return () => {
      controller.abort(); clearTimeout(timer); version.current++
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('dublin-drawer-open', drawers)
    }
  }, [refresh])
  useEffect(() => {
    if (open) { window.dispatchEvent(new CustomEvent('dublin-drawer-open', { detail: 'reminders' })); heading.current?.focus() }
  }, [open])
  const close = (): void => { setOpen(false); if (restoreFocus !== undefined) restoreFocus(); else entry.current?.focus() }
  const mutate = async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await siminRequest('/aipm/reminders', payload, abort.current?.signal)
      await refresh(abort.current?.signal)
      return true
    } catch (_error) { if (!abort.current?.signal.aborted) setError(true); return false }
    finally { if (!abort.current?.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    if (request?.tool === 'reminders') { setOpen(true); void refresh(abort.current?.signal) }
  }, [request, refresh])
  useEffect(() => {
    const active = data.tasks.filter(task => task.status === 'active')
      .sort((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt))
    onSummary?.({ count: active.length, items: active.slice(0, 3).map(task => ({
      id: task.record.id, title: task.record.title, at: task.record.scheduledAt,
    })), error: error || data.error })
  }, [data, error, onSummary])
  const days = [t('reminderMon'), t('reminderTue'), t('reminderWed'), t('reminderThu'), t('reminderFri'), t('reminderSat'), t('reminderSun')]
  const frequency = (task: Task): string => {
    if (task.record.kind === 'daily') return t('reminderDaily', { time: task.record.time ?? '', zone: task.record.timeZone ?? '' })
    if (task.record.kind === 'weekly') return t('reminderWeekly', {
      days: (task.record.weekdays ?? []).map(day => days[day - 1]).join('、'), time: task.record.time ?? '', zone: task.record.timeZone ?? '',
    })
    return t('reminderOnce')
  }
  return <>
    {showEntry && <button ref={entry} type="button" className={css.entry} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) close(); else { setOpen(true); void refresh(abort.current?.signal) } }}>{t('reminderTasks')}</button>}
    {open && <aside className={css.drawer} id={id} role="region" aria-labelledby={`${id}-title`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div className={css.heading}><div><p>{t('organizerPersonal')}</p><h2 ref={heading} tabIndex={-1} id={`${id}-title`}><DublinToolMark kind="reminders" large />{t('reminderTasks')}</h2></div>
        <button type="button" className={css.close} aria-label={t('close')} onClick={close}>×</button></div>
      <p className={css.hint}>{t('reminderHint')}</p><p className={css.hint}>{t('reminderZone', { zone: data.timeZone })}</p>
      {(error || data.error) && <div className={css.error} role="alert">{t('reminderError')}
        <button type="button" onClick={() => { void refresh(abort.current?.signal) }}>{t('retry')}</button></div>}
      {editing !== null && <ReminderEditor key={editing.record.id} task={editing} t={t} days={days} busy={busy}
        cancel={() => { setEditing(null) }} save={async (payload) => { if (await mutate(payload)) setEditing(null) }} />}
      {data.tasks.length === 0 && <p className={css.empty}>{t('reminderEmpty')}</p>}
      {data.tasks.toSorted((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt)).map(task => <section
        className={remindersCss.card} key={task.record.id}>
        <div className={remindersCss.row}><h3>{task.record.title}</h3><small>{t(task.status === 'active' ? 'reminderActive' : task.status === 'paused' ? 'reminderPaused' : 'reminderCompleted')}</small></div>
        <p>{task.record.prompt}</p><small>{frequency(task)}</small>
        <time dateTime={task.record.scheduledAt}>{t(task.status === 'completed' ? 'reminderLastTime' : 'reminderNextTime')}{new Date(task.record.scheduledAt).toLocaleString()}</time>
        <div className={css.actions}>
          <button type="button" disabled={busy} onClick={() => { setEditing(task) }}>{t('organizerEdit')}</button>
          {task.status !== 'completed' && <button type="button" disabled={busy}
            onClick={() => { void mutate({ action: task.status === 'paused' ? 'resume' : 'pause', id: task.record.id }) }}>{t(task.status === 'paused' ? 'reminderResume' : 'reminderPause')}</button>}
          <button type="button" disabled={busy} onClick={() => { setDeleting(task.record.id) }}>{t('organizerDelete')}</button>
        </div>
        {deleting === task.record.id && <div className={css.confirm}><span>{t('organizerDeleteConfirm')}</span>
          <button type="button" disabled={busy} onClick={() => { void mutate({ action: 'delete', id: task.record.id }).then((ok) => { if (ok) setDeleting(null) }) }}>{t('organizerConfirmDelete')}</button>
          <button type="button" onClick={() => { setDeleting(null) }}>{t('cancel')}</button></div>}
      </section>)}
    </aside>}
    <div className={remindersCss.notices} aria-live="polite" aria-relevant="additions">
      {data.tasks.filter(task => task.notice?.unread).map(task => <section className={remindersCss.notice} key={`${task.record.id}-${task.notice?.scheduledAt}`}>
        <small>{t(Date.parse(task.notice?.deliveredAt ?? '') - Date.parse(task.notice?.scheduledAt ?? '') > 60_000 ? 'reminderMissed' : 'reminderDue')}</small>
        <h3>{task.notice?.title}</h3><p>{task.notice?.message}</p>
        <time>{new Date(task.notice?.scheduledAt ?? '').toLocaleString()}</time>
        <button type="button" disabled={busy} onClick={() => { void mutate({ action: 'acknowledge', id: task.record.id }) }}>{t('reminderDismiss')}</button>
      </section>)}
    </div>
  </>
}

function ReminderEditor({ task, t, days, busy, cancel, save }: {
  task: Task
  t: Copy
  days: string[]
  busy: boolean
  cancel: () => void
  save: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [title, setTitle] = useState(task.record.title), [message, setMessage] = useState(task.record.prompt)
  const [kind, setKind] = useState(task.record.kind === 'daily' || task.record.kind === 'weekly' ? task.record.kind : 'once')
  const [at, setAt] = useState(localDate(task.record.scheduledAt)), [time, setTime] = useState(task.record.time?.slice(0, 5) ?? '09:00')
  const [weekdays, setWeekdays] = useState(task.record.weekdays ?? [1]), [invalid, setInvalid] = useState(false)
  return <form className={remindersCss.editor} onSubmit={(event) => {
    event.preventDefault(); setInvalid(false)
    const date = new Date(at)
    if (kind === 'once' && (!Number.isFinite(date.getTime()) || localDate(date.toISOString()) !== at)) { setInvalid(true); return }
    void save({ action: 'update', id: task.record.id, title, message,
      ...(kind === 'once' ? { at: date.toISOString() } : { time, ...(kind === 'weekly' ? { weekdays } : {}) }) })
  }}>
    <label>{t('reminderTitle')}<input required maxLength={120} value={title} onChange={(event) => { setTitle(event.target.value) }} /></label>
    <label>{t('reminderMessage')}<textarea required maxLength={2000} value={message} onChange={(event) => { setMessage(event.target.value) }} /></label>
    <label>{t('reminderRepeat')}<select value={kind} onChange={(event) => { setKind(event.target.value) }}>
      <option value="once">{t('reminderOnce')}</option><option value="daily">{t('reminderDailyOption')}</option><option value="weekly">{t('reminderWeeklyOption')}</option>
    </select></label>
    {kind === 'once' ? <label>{t('reminderTime')}<input required type="datetime-local" value={at} onChange={(event) => { setAt(event.target.value) }} /></label>
      : <label>{t('reminderTime')}<input required type="time" value={time} onChange={(event) => { setTime(event.target.value) }} /></label>}
    {kind === 'weekly' && <div className={remindersCss.days}>{days.map((day, index) => <label key={day}>
      <input type="checkbox" checked={weekdays.includes(index + 1)} onChange={(event) => { setWeekdays(event.target.checked ? [...weekdays, index + 1] : weekdays.filter(value => value !== index + 1)) }} />{day}</label>)}</div>}
    {invalid && <p role="alert">{t('reminderInvalid')}</p>}
    <div className={css.actions}><button type="submit" disabled={busy || !title.trim() || !message.trim() || (kind === 'weekly' && weekdays.length === 0)}>{t('organizerSave')}</button>
      <button type="button" onClick={cancel}>{t('cancel')}</button></div>
  </form>
}
