/** Native reminders outlive windows and release native objects on quit. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createReminderNotifications } from '../src/dublin-notifications.ts'
const state = vi.hoisted(() => ({ supported: true, failed: false, notices: [] as EventEmitter[] }))
vi.mock('electron', () => ({ Notification: class extends EventEmitter {
  static isSupported() { return state.supported }
  constructor(readonly options: { title: string; body: string }) { super(); state.notices.push(this) }
  show() { if (state.failed) throw new Error('denied') }
  close() { this.emit('close') }
} }))
afterEach(() => { state.notices.length = 0; state.supported = true; state.failed = false })
it('activates the app on click and drops all listeners during cleanup', () => {
  const click = vi.fn(), report = vi.fn(), owner = createReminderNotifications(click, report)
  owner.show({ id: 'one', title: '交文档', message: '该交文档了' })
  const notice = state.notices[0]
  expect(notice).toBeDefined(); notice?.emit('click'); expect(click).toHaveBeenCalledOnce()
  owner.dispose(); expect(notice?.eventNames()).toEqual([]); expect(report).not.toHaveBeenCalled()
})
it('tolerates denied and unsupported notifications without crashing the Host', () => {
  const report = vi.fn(), owner = createReminderNotifications(vi.fn(), report)
  state.supported = false; owner.show({ id: 'one', title: '任务', message: '内容' })
  expect(state.notices).toHaveLength(0)
  state.supported = true; state.failed = true; owner.show({ id: 'one', title: '任务', message: '内容' })
  expect(report).toHaveBeenCalledOnce(); owner.dispose()
})
