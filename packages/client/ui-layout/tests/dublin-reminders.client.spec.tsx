// @vitest-environment jsdom
/** Reminder catalog, persistent notices, management writes and drawer coordination. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinRemindersControl } from '../src/client/DublinReminders.tsx'
import { DublinOrganizer } from '../src/client/DublinOrganizer.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
import { siminRequest } from '../src/client/simin-api.ts'
vi.mock('../src/client/simin-api.ts', () => ({ siminRequest: vi.fn() }))
const t = (key: string, params?: Record<string, unknown>): string => {
  let text = siminZh[key as SiminKey]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
const record = { id: 'one', title: '交文档', prompt: '该交文档了', kind: 'daily', time: '09:00:00.000',
  timeZone: 'Asia/Shanghai', scheduledAt: '2026-10-29T01:00:00.000Z' }
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })
function setup(unread = false) {
  let task = { record, status: 'active', notice: {
    scheduledAt: '2026-10-27T01:00:00.000Z', deliveredAt: '2026-10-28T01:00:00.000Z', unread,
    title: '交文档', message: '该交文档了',
  } }
  vi.mocked(siminRequest).mockImplementation(async (_path, payload) => {
    if (payload?.action === 'pause') task = { ...task, status: 'paused' }
    if (payload?.action === 'resume') task = { ...task, status: 'active' }
    if (payload?.action === 'acknowledge') task = { ...task, notice: { ...task.notice, unread: false } }
    return payload === undefined ? { tasks: [task], timeZone: 'Asia/Shanghai', error: false } : {}
  })
}
it('opens a global catalog, pauses and resumes without creating another reminder', async () => {
  setup(); render(<DublinRemindersControl t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('reminderTasks') }))
  await screen.findByText('交文档')
  fireEvent.click(screen.getByRole('button', { name: t('reminderPause') }))
  await screen.findByText(t('reminderPaused'))
  fireEvent.click(screen.getByRole('button', { name: t('reminderResume') }))
  await screen.findByText(t('reminderActive'))
  expect(vi.mocked(siminRequest).mock.calls.some(([, payload]) => payload?.action === 'create')).toBe(false)
})
it('shows a missed notice even with the drawer closed and durably acknowledges it', async () => {
  setup(true); const ui = render(<DublinRemindersControl t={t} />)
  await screen.findByText(t('reminderMissed'))
  expect(screen.queryByRole('region')).toBeNull()
  expect(ui.container.querySelector('section')?.textContent).toContain('交文档该交文档了')
  fireEvent.click(screen.getByRole('button', { name: t('reminderDismiss') }))
  await waitFor(() => { expect(screen.queryByText(t('reminderMissed'))).toBeNull() })
  expect(siminRequest).toHaveBeenCalledWith('/aipm/reminders', { action: 'acknowledge', id: 'one' }, expect.any(AbortSignal))
})
it('edits the complete rule and requests confirmation before cancellation', async () => {
  setup(); render(<DublinRemindersControl t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('reminderTasks') })); await screen.findByText('交文档')
  fireEvent.click(screen.getByRole('button', { name: t('organizerEdit') }))
  fireEvent.change(screen.getByLabelText(t('reminderTime')), { target: { value: '10:30' } })
  fireEvent.click(screen.getByRole('button', { name: t('organizerSave') }))
  await waitFor(() => { expect(screen.queryByLabelText(t('reminderTime'))).toBeNull() })
  expect(siminRequest).toHaveBeenCalledWith('/aipm/reminders', {
    action: 'update', id: 'one', title: '交文档', message: '该交文档了', time: '10:30',
  }, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: t('organizerDelete') }))
  expect(screen.getByText(t('organizerDeleteConfirm'))).toBeTruthy()
  expect(vi.mocked(siminRequest).mock.calls.some(([, payload]) => payload?.action === 'delete')).toBe(false)
})
it('keeps task, note and reminder drawers mutually exclusive', async () => {
  setup(); render(<><DublinRemindersControl t={t} /><DublinOrganizer t={t} /></>)
  fireEvent.click(screen.getByRole('button', { name: t('organizerTodos') }))
  expect(screen.getAllByRole('region')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: t('reminderTasks') }))
  await screen.findByText('交文档'); expect(screen.getAllByRole('region')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: t('organizerNotes') }))
  expect(screen.getAllByRole('region')).toHaveLength(1)
  expect(screen.getByRole('heading', { level: 2, name: t('organizerNotes') })).toBeTruthy()
})
it('reports a failed read and aborts the owned request on unmount', async () => {
  vi.mocked(siminRequest).mockRejectedValue(new Error('offline'))
  const ui = render(<DublinRemindersControl t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('reminderTasks') }))
  await screen.findByRole('alert')
  const signal = vi.mocked(siminRequest).mock.calls[0]?.[2]
  ui.unmount(); expect(signal?.aborted).toBe(true)
})
