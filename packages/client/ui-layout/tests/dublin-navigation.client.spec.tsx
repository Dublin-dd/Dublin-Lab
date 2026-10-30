// @vitest-environment jsdom
/** Workbench composition: tool entry placement, drawer access and continuous recording. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SiminShell } from '../src/client/SiminShell.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
import type { CaptureProgress } from '../src/client/dublin-recorder.ts'
import type { DublinToolsApi } from '../src/dublin-tools.ts'

const capture = vi.hoisted(() => ({ constructors: vi.fn(), start: vi.fn(), stop: vi.fn(), pause: vi.fn(),
  progress: undefined as ((value: CaptureProgress) => void) | undefined }))
vi.mock('../src/client/dublin-recorder.ts', async original => ({
  ...await original<typeof import('../src/client/dublin-recorder.ts')>(),
  DublinRecorder: class {
    constructor(_api: DublinToolsApi, progress: (value: CaptureProgress) => void) { capture.constructors(); capture.progress = progress }
    start = capture.start
    stop = capture.stop
    pause = capture.pause
  },
}))
const t = (key: string, params?: Record<string, unknown>): string => {
  let text = siminZh[key as SiminKey]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
function click(key: SiminKey) { fireEvent.click(screen.getByRole('button', { name: t(key) })) }
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  capture.start.mockImplementation(() => { capture.progress?.({ phase: 'recording', duration: 4, source: 'microphone' }) })
  localStorage.setItem('dublin.organizer.v1.first', JSON.stringify({ id: 'first', kind: 'todo', text: '梳理需求', done: false, updatedAt: 1 }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = input instanceof Request ? input.url : input.toString()
    if (path.includes('/aipm/reminders')) return Response.json({ tasks: [{ status: 'active', record: {
      id: 'reminder-one', title: '交文档', prompt: '记得交文档', kind: 'once', scheduledAt: '2026-10-30T01:00:00.000Z',
    } }], timeZone: 'Asia/Shanghai', error: false })
    if (path.includes('/aipm/state')) return Response.json({ root: '/workspace', projects: [], trash: [], proposals: [] })
    return Response.json({})
  }))
  Object.assign(window, { dublinTools: { run: vi.fn(async (op: string) => op === 'transcriptionSettings'
    ? { region: 'beijing', model: 'qwen-audio-3.1-asr-flash-filetrans', summaryModel: 'qwen-plus', configured: false } : []) } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
  delete (window as Window & { dublinTools?: DublinToolsApi }).dublinTools })
async function workbench() {
  const ui = render(<SiminShell t={t} chat={null} nativeSettings={null} />)
  await screen.findByRole('heading', { name: /欢迎回来/u })
  return { ...ui, header: ui.container.querySelector('header')!, nav: screen.getByRole('navigation'),
    side: ui.container.querySelector('aside')! }
}
it('places recording, notes, to-dos and reminders beside search', async () => {
  const ui = await workbench()
  expect(within(ui.header).getByRole('button', { name: t('search') })).toBeTruthy()
  for (const key of ['toolsRecord', 'organizerNotes', 'organizerTodos', 'reminderTasks'] as const) {
    expect(within(ui.header).getByRole('button', { name: t(key) })).toBeTruthy()
    expect(within(ui.side).queryByRole('button', { name: t(key) })).toBeNull()
  }
  for (const key of ['toolsVault', 'appearance'] as const) {
    expect(within(ui.header).queryByRole('button', { name: t(key) })).toBeNull()
  }
  expect(within(ui.nav).getByRole('button', { name: t('toolsVault') })).toBeTruthy()
  expect(screen.queryByRole('region', { name: t('todayAgenda') })).toBeNull()
  expect(screen.queryByText(t('todayAgenda'))).toBeNull()
  for (const key of ['toolsRecord', 'organizerNotes', 'organizerTodos', 'reminderTasks'] as const) {
    expect(within(ui.header).getByRole('button', { name: t(key) }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  }
  expect(localStorage.getItem('dublin.organizer.v1.first')).toContain('梳理需求')
})
it('opens the tools from the header with matching decorative heading marks', async () => {
  await workbench()
  click('organizerTodos')
  expect(screen.getByRole('heading', { name: t('organizerTodos') }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: t('organizerNewTask') }), { target: { value: '准备访谈' } })
  click('organizerAdd')
  expect(screen.getByRole('checkbox', { name: t('organizerToggleTask', { text: '准备访谈' }) })).toBeTruthy()
  click('close'); expect(document.activeElement).toBe(screen.getByRole('button', { name: t('organizerTodos') }))
  click('reminderTasks')
  expect(screen.getByRole('heading', { name: t('reminderTasks') }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  click('organizerNotes')
  expect(screen.getByRole('heading', { name: t('organizerNotes') }).querySelector('[aria-hidden="true"]')).toBeTruthy()
})
it('keeps recording alive when its drawer closes and when the current page changes', async () => {
  const ui = await workbench()
  fireEvent.click(within(ui.header).getByRole('button', { name: t('toolsRecord') }))
  await screen.findByRole('button', { name: t('toolsStart') })
  expect(screen.getByRole('heading', { name: t('toolsRecord') }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  click('close'); expect(document.activeElement).toBe(within(ui.header).getByRole('button', { name: t('toolsRecord') }))
  click('toolsRecord'); click('toolsStart'); click('close')
  const status = within(ui.header).getByRole('button', { name: /正在录音/u })
  expect(status.textContent).toContain('00:04')
  fireEvent.click(within(ui.nav).getByRole('button', { name: t('documents') }))
  expect(capture.constructors).toHaveBeenCalledOnce(); expect(capture.stop).not.toHaveBeenCalled()
  fireEvent.click(status)
  expect(screen.getByRole('button', { name: t('toolsStop') })).toBeTruthy()
  fireEvent.click(within(ui.header).getByRole('button', { name: t('organizerNotes') }))
  expect(screen.queryByRole('region', { name: t('toolsRecord') })).toBeNull()
  expect(screen.getByRole('region', { name: t('organizerNotes') })).toBeTruthy()
  expect(capture.stop).not.toHaveBeenCalled()
})
it('opens the vault from the bottom rail and appearance from settings', async () => {
  const ui = await workbench()
  fireEvent.click(within(ui.nav).getByRole('button', { name: t('toolsVault') }))
  expect(screen.getByRole('region', { name: t('toolsVault') })).toBeTruthy()
  click('close')
  fireEvent.click(within(ui.nav).getByRole('button', { name: t('settings') }))
  expect(screen.getByRole('heading', { name: t('appearanceSettings') })).toBeTruthy()
  click('appearance')
  expect(screen.getByRole('dialog', { name: t('appearance') })).toBeTruthy()
})
