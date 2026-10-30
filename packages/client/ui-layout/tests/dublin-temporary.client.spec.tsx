// @vitest-environment jsdom
/** Temporary selection survives restart and never inherits the previously visible project. */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TemporaryHistory, useDublinTemporary } from '../src/client/DublinTemporary.tsx'
import { SiminShell } from '../src/client/SiminShell.tsx'
import { TemporaryHeader } from '../src/client/TemporaryHeader.tsx'
vi.mock('../src/client/simin-api.ts', () => ({
  siminSnapshot: async () => ({ root: '/projects', projects: [], proposals: [], trash: [] }),
  siminRequest: async () => ({ tasks: [], timeZone: 'Asia/Shanghai', error: false }),
  siminDocument: async () => ({ markdown: '', version: '' }),
}))
import { loadSiminView, type SiminView } from '../src/client/simin-state.ts'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
const t = (key: string): string => siminZh[key as SiminKey]
const item = { id: 'temp-one', title: '讨论灵感', updatedAt: 1000, running: false, blank: false }
function publish(detail: Record<string, unknown>) {
  act(() => { window.dispatchEvent(new CustomEvent('dublin-temporary-state', { detail })) })
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
it('restores the exact retained identity and reopens it after visiting a project', () => {
  const requests: unknown[] = []
  const listener = (event: Event) => { requests.push((event as CustomEvent).detail) }
  window.addEventListener('dublin-temporary-request', listener)
  try {
    const view: SiminView = { page: 'temporary', project: null, file: null, temporarySessionId: item.id }
    const ui = renderHook(({ value }: { value: SiminView }) => useDublinTemporary(value), { initialProps: { value: view } })
    publish({ items: [item], busy: false, error: false })
    expect(requests).toContainEqual({ action: 'open', sessionId: item.id })
    publish({ selected: item.id, busy: false, error: false })
    expect(ui.result.current.ready).toBe(true)
    expect(loadSiminView()).toMatchObject({ page: 'temporary', temporarySessionId: item.id, project: null })
    ui.rerender({ value: { project: 'Example', file: null, page: 'project' } })
    expect(ui.result.current.ready).toBe(false)
    ui.rerender({ value: view })
    expect(requests.filter(value => typeof value === 'object' && value !== null && 'action' in value && value.action === 'open'))
      .toHaveLength(2)
  } finally { window.removeEventListener('dublin-temporary-request', listener) }
})
it('keeps catalog items when a request fails and emits explicit history gestures', () => {
  const request = vi.fn()
  render(<TemporaryHistory state={{ items: [item], busy: false, error: true, ready: false, request }} selected={item.id} t={t} />)
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /讨论灵感/u }))
  expect(request).toHaveBeenCalledWith('open', item.id)
  fireEvent.click(screen.getByRole('button', { name: t('retry') }))
  expect(request).toHaveBeenCalledWith('list')
})
it('switches to a project continuation while leaving the original history available', () => {
  const view: SiminView = { page: 'temporary', project: null, file: null, temporarySessionId: item.id }
  const ui = renderHook(() => useDublinTemporary(view))
  publish({ items: [item], busy: false, error: false })
  publish({ selected: 'project-copy', project: 'Example', busy: false, error: false })
  expect(loadSiminView()).toMatchObject({ page: 'project', project: 'Example', tab: 'chat' })
  expect(ui.result.current.items).toEqual([item])
})
it('mounts exactly one chat surface after restoring a temporary conversation', async () => {
  localStorage.setItem('aipm.simin.v1', JSON.stringify({ project: null, file: null, page: 'temporary', temporarySessionId: item.id }))
  render(<SiminShell chat={<div data-testid="chat-surface" />} nativeSettings={null} t={t} />)
  publish({ items: [item], busy: false, selected: item.id, error: false })
  expect(screen.getAllByTestId('chat-surface')).toHaveLength(1)
  expect(screen.getByRole('heading', { name: item.title })).toBeTruthy()
})
it('searches and confirms a project in the floating picker and dismisses it with Escape', () => {
  const onTransfer = vi.fn()
  render(<TemporaryHeader title={item.title} projects={[{ name: 'Alpha', path: '/Alpha' }, { name: 'Beta', path: '/Beta' }]}
    busy={false} canTransfer onTransfer={onTransfer} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('temporaryMove') }))
  const search = screen.getByRole('textbox', { name: t('temporarySearch') })
  expect(document.activeElement).toBe(search)
  fireEvent.change(search, { target: { value: 'Alpha' } })
  expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.click(screen.getByRole('button', { name: t('temporaryTransfer') }))
  expect(onTransfer).toHaveBeenCalledExactlyOnceWith('Alpha')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('temporaryMove') }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: t('temporaryMove') }))
})
