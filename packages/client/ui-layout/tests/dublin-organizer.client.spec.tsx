// @vitest-environment jsdom
/** Shared organizer editing, durable reloads and failed-save recovery. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinOrganizer } from '../src/client/DublinOrganizer.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
const t = (key: string, params?: Record<string, unknown>): string => {
  let text = siminZh[key as SiminKey]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
function click(name: string) { fireEvent.click(screen.getByRole('button', { name })) }
function addTask(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: t('organizerNewTask') }), { target: { value: text } })
  click(t('organizerAdd'))
}
it('keeps one non-modal drawer open and restores focus when closing', () => {
  render(<DublinOrganizer t={t} />)
  click(t('organizerTodos'))
  expect(screen.getByRole('region').getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { level: 2 }).id)
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }))
  expect(screen.getByRole('region').textContent).toMatchInlineSnapshot(
    '"我的日常☑️待办事项×所有项目共用 · 仅保存在本机添加未完成0已完成0暂时没有待办，让思路轻一点。"',
  )
  click(t('organizerNotes'))
  expect(screen.getAllByRole('region')).toHaveLength(1)
  expect(screen.getByRole('heading', { level: 2, name: t('organizerNotes') })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
  expect(screen.queryByRole('region')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: t('organizerNotes') }))
})
it('adds, edits, completes, restores and deletes tasks across remounts', () => {
  const ui = render(<DublinOrganizer t={t} />)
  click(t('organizerTodos')); addTask('写计划')
  click(t('organizerEditItem', { text: '写计划' }))
  fireEvent.change(screen.getByRole('textbox', { name: t('organizerEditTask') }), { target: { value: '完成计划' } })
  click(t('organizerSave'))
  fireEvent.click(screen.getByRole('checkbox'))
  expect(screen.queryByText('完成计划')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /已完成/u }))
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', true)
  ui.unmount(); render(<DublinOrganizer t={t} />); click(t('organizerTodos'))
  fireEvent.click(screen.getByRole('button', { name: /已完成/u }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: /未完成/u }))
  click(t('organizerDeleteItem', { text: '完成计划' }))
  click(t('cancel')); expect(screen.getByText('完成计划')).toBeTruthy()
  click(t('organizerDeleteItem', { text: '完成计划' })); click(t('organizerConfirmDelete'))
  expect(screen.queryByText('完成计划')).toBeNull()
  expect(localStorage.length).toBe(0)
})
it('auto-saves literal note text and retains it after switching drawers and restarting', () => {
  const ui = render(<DublinOrganizer t={t} />)
  click(t('organizerNotes')); click(t('organizerNewNote'))
  const text = '<script>alert(1)</script>\n第二行灵感'
  fireEvent.change(screen.getByRole('textbox', { name: t('organizerNoteContent') }), { target: { value: text } })
  expect(screen.getByText(t('organizerSaved'))).toBeTruthy()
  expect(ui.container.querySelector('script')).toBeNull()
  click(t('organizerTodos')); click(t('organizerNotes'))
  expect(screen.getByRole('textbox')).toHaveProperty('value', text)
  ui.unmount(); render(<DublinOrganizer t={t} />); click(t('organizerNotes'))
  fireEvent.click(screen.getByRole('button', { name: /<script>alert/u }))
  expect(screen.getByRole('textbox')).toHaveProperty('value', text)
  click(t('organizerDelete')); click(t('organizerConfirmDelete'))
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(localStorage.length).toBe(0)
})
it('keeps failed edits visible and retries pending writes without reporting success', () => {
  render(<DublinOrganizer t={t} />); click(t('organizerNotes')); click(t('organizerNewNote'))
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '不能丢的想法' } })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.queryByText(t('organizerSaved'))).toBeNull()
  expect(screen.getByRole('textbox')).toHaveProperty('value', '不能丢的想法')
  failure.mockRestore(); click(t('organizerRetry'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(localStorage.getItem(localStorage.key(0) ?? '')).toContain('不能丢的想法')
})
it('merges other-window writes and removes its storage listener on unmount', () => {
  const off = vi.spyOn(window, 'removeEventListener')
  const ui = render(<DublinOrganizer t={t} />); click(t('organizerTodos'))
  act(() => { window.dispatchEvent(new StorageEvent('storage', {
    key: 'dublin.organizer.v1.other',
    newValue: JSON.stringify({ id: 'other', kind: 'todo', text: '另一个窗口', done: false, updatedAt: 1 }),
  })) })
  expect(within(screen.getByRole('region')).getByText('另一个窗口')).toBeTruthy()
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'dublin.organizer.v1.other', newValue: null })) })
  expect(screen.queryByText('另一个窗口')).toBeNull()
  ui.unmount(); expect(off).toHaveBeenCalledWith('storage', expect.any(Function))
})
it('preserves unreadable records and reports their storage error', () => {
  localStorage.setItem('dublin.organizer.v1.broken', '{invalid')
  localStorage.setItem('dublin.organizer.v1.date', JSON.stringify({
    id: 'date', kind: 'note', text: 'damaged date', done: false, updatedAt: 1e30,
  }))
  render(<DublinOrganizer t={t} />); click(t('organizerNotes'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(localStorage.getItem('dublin.organizer.v1.broken')).toBe('{invalid')
  expect(screen.queryByText('damaged date')).toBeNull()
})
it('retries failed deletion rather than allowing the deleted item to reappear', () => {
  render(<DublinOrganizer t={t} />); click(t('organizerTodos')); addTask('删除测试')
  const failure = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
  click(t('organizerDeleteItem', { text: '删除测试' })); click(t('organizerConfirmDelete'))
  expect(screen.queryByText('删除测试')).toBeNull()
  expect(screen.getByRole('alert')).toBeTruthy()
  failure.mockRestore(); click(t('organizerRetry'))
  expect(localStorage.length).toBe(0)
  expect(screen.queryByRole('alert')).toBeNull()
})
