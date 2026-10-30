// @vitest-environment jsdom
/** Review-before-upload, masked secret cards, durable results and drawer coordination. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DublinRecording, DublinToolsApi, VaultCard } from '../src/dublin-tools.ts'
import { DublinPersonalTools } from '../src/client/DublinPersonalTools.tsx'
import { DublinOrganizer } from '../src/client/DublinOrganizer.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'

const t = (key: string, params?: Record<string, unknown>): string => {
  let text = siminZh[key as SiminKey]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
const recording: DublinRecording = { id: 'record-one', title: '产品讨论', createdAt: 100000, duration: 23, source: 'mixed', interrupted: false, segments: [], summaries: [] }
let records: DublinRecording[], cards: VaultCard[]
const run = vi.fn()
function click(key: SiminKey) { fireEvent.click(screen.getByRole('button', { name: t(key) })) }
beforeEach(() => {
  records = [structuredClone(recording)]; cards = [{ id: 'card-one', provider: '百炼', account: '我的账号', updatedAt: 1000 }]
  run.mockImplementation(async (op: string, input: Record<string, unknown> | null) => {
    switch (op) {
      case 'recordings': return records
      case 'transcriptionSettings': return { region: 'beijing', model: 'qwen-audio-3.1-asr-flash-filetrans', summaryModel: 'qwen-plus', configured: false }
      case 'vaultList': return cards
      case 'vaultReveal': return 'private-card-key'
      case 'vaultCopy': return
      case 'vaultSave': return { id: 'card-one', provider: input?.provider, account: input?.account, updatedAt: 2000 }
      case 'vaultDelete': return
      case 'transcribe': return { ...recording, segments: [{ start: 1.5, end: 3, speaker: '0', text: '明天整理文档' }] }
      case 'summarize': return { ...recording, segments: [{ start: 1.5, end: 3, speaker: '0', text: '明天整理文档' }], summaries: [{ kind: 'actions', text: '整理文档，负责人待确认。', actions: ['整理文档'] }] }
      case 'transcriptionConfigure': return { ...input, configured: true, apiKey: undefined }
      case 'recordingDelete': records = []; return
      default: throw new Error(`Unexpected ${op}`)
    }
  })
  Object.assign(window, { dublinTools: { run } satisfies DublinToolsApi })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear()
  delete (window as Window & { dublinTools?: DublinToolsApi }).dublinTools })

it('has no automatic audio capture or uploads and clearly explains local/cloud boundaries', async () => {
  render(<DublinPersonalTools t={t} />)
  expect(run).not.toHaveBeenCalled()
  click('toolsRecord'); await screen.findByText('产品讨论')
  expect(run.mock.calls.map(call => String(call[0]))).toEqual(['recordings', 'transcriptionSettings'])
  expect(screen.getByText(t('toolsRecordingPrivacy')).textContent).toMatchInlineSnapshot('"录音默认保存在本机，所有项目共用。仅在你主动转文字时，将所选音频上传至阿里云百炼；整理时仅发送文字。"')
  expect(screen.getByRole('combobox', { name: t('toolsSource') }).textContent).toBe('麦克风电脑声音＋麦克风')
  expect(screen.getByRole('button', { name: t('toolsStart') })).toBeTruthy()
})
it('coordinates non-modal drawers and keeps unsupported environments explicit', async () => {
  const ui = render(<><DublinPersonalTools t={t} /><DublinOrganizer t={t} /></>)
  click('toolsVault'); await screen.findByText('我的账号')
  click('organizerTodos'); expect(screen.getAllByRole('region')).toHaveLength(1)
  expect(screen.queryByRole('heading', { name: t('toolsVault') })).toBeNull()
  click('toolsRecord'); expect(screen.getAllByRole('region')).toHaveLength(1)
  fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
  expect(screen.queryByRole('region')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', { name: t('toolsRecord') }))
  ui.unmount(); delete (window as Window & { dublinTools?: DublinToolsApi }).dublinTools
  render(<DublinPersonalTools t={t} />); click('toolsRecord')
  expect(screen.getByText(t('toolsDesktopOnly'))).toBeTruthy()
})
it('expands masked cards without loading secrets, authenticates reveal/copy and hides on blur', async () => {
  render(<DublinPersonalTools t={t} />); click('toolsVault'); await screen.findByText('我的账号')
  expect(screen.getByText('***')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /百炼/u }))
  const secret = screen.getByLabelText(t('toolsSecret'))
  expect(secret).toHaveProperty('type', 'password'); expect(secret).toHaveProperty('value', '')
  expect(run.mock.calls.filter(call => String(call[0]) === 'vaultReveal')).toEqual([])
  click('toolsReveal'); await waitFor(() => { expect(secret).toHaveProperty('value', 'private-card-key') })
  expect(secret).toHaveProperty('type', 'text')
  expect(fireEvent.copy(secret)).toBe(false)
  await waitFor(() => { expect(run).toHaveBeenCalledWith('vaultCopy', { id: 'card-one' }) })
  act(() => { window.dispatchEvent(new Event('blur')) })
  expect(secret).toHaveProperty('value', ''); expect(secret).toHaveProperty('type', 'password')
  click('toolsCopy'); await screen.findByText(t('toolsCopied'))
  expect(run).toHaveBeenCalledWith('vaultCopy', { id: 'card-one' })
  expect(localStorage.length).toBe(0)
  click('organizerDelete'); expect(run.mock.calls.filter(call => String(call[0]) === 'vaultDelete')).toHaveLength(0)
  click('cancel'); click('organizerDelete'); click('organizerConfirmDelete')
  await waitFor(() => { expect(run).toHaveBeenCalledWith('vaultDelete', { id: 'card-one' }) })
})
it('preserves the masked card after cancelled authentication', async () => {
  render(<DublinPersonalTools t={t} />); click('toolsVault'); await screen.findByText('我的账号')
  fireEvent.click(screen.getByRole('button', { name: /百炼/u }))
  run.mockRejectedValueOnce(new Error('Error invoking remote method: Error: toolsAuthenticationCancelled'))
  click('toolsReveal'); await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe(t('toolsAuthenticationCancelled'))
  expect(screen.getByLabelText(t('toolsSecret'))).toHaveProperty('value', '')
})
it('requires confirmation before uploading and adds AI action items only after an explicit click', async () => {
  render(<DublinPersonalTools t={t} />); click('toolsRecord'); await screen.findByText('产品讨论')
  fireEvent.click(screen.getByRole('button', { name: /产品讨论/u }))
  click('toolsTranscribe'); expect(run.mock.calls.filter(call => String(call[0]) === 'transcribe')).toHaveLength(0)
  expect(screen.getByText(t('toolsTranscribeConfirm'))).toBeTruthy()
  click('cancel'); expect(run.mock.calls.filter(call => String(call[0]) === 'transcribe')).toHaveLength(0)
  click('toolsTranscribe')
  const upload = screen.getAllByRole('button', { name: t('toolsTranscribe') })
  fireEvent.click(upload[0]!)
  await screen.findByText('明天整理文档')
  expect(run).toHaveBeenCalledWith('transcribe', { id: recording.id })
  expect(screen.getByRole('button', { name: '00:01 说话人 1' })).toBeTruthy()
  click('toolsActions'); await screen.findByText('整理文档，负责人待确认。')
  expect(localStorage.length).toBe(0)
  click('toolsAddTodo')
  expect(localStorage.length).toBe(1)
  const savedNote: unknown = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
  expect(savedNote).toMatchObject({ text: '整理文档' })
  expect(screen.getByRole('button', { name: t('toolsAdded') })).toHaveProperty('disabled', true)
})
it('passes transcription credentials to native encryption without storing them in browser storage', async () => {
  render(<DublinPersonalTools t={t} />); click('toolsRecord'); await screen.findByText('产品讨论')
  fireEvent.click(screen.getByText(t('toolsConfig')))
  fireEvent.change(screen.getByLabelText(t('toolsApiKey')), { target: { value: 'private-api-key' } })
  click('organizerSave'); await screen.findByText(t('toolsSaved'))
  expect(run).toHaveBeenCalledWith('transcriptionConfigure', { region: 'beijing', model: 'qwen-audio-3.1-asr-flash-filetrans', summaryModel: 'qwen-plus', apiKey: 'private-api-key' })
  expect(screen.getByLabelText(t('toolsApiKey'))).toHaveProperty('value', '')
  expect(localStorage.length).toBe(0)
})
it('does not retain an audio blob if the panel closes before loading finishes', async () => {
  const pending = Promise.withResolvers<Uint8Array>(), create = vi.fn(), original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  URL.createObjectURL = create
  try {
    render(<DublinPersonalTools t={t} />); click('toolsRecord'); await screen.findByText('产品讨论')
    fireEvent.click(screen.getByRole('button', { name: /产品讨论/u }))
    run.mockReturnValueOnce(pending.promise)
    click('toolsPlay'); click('close')
    await act(async () => { pending.resolve(new Uint8Array(44)); await pending.promise })
    expect(create).not.toHaveBeenCalled()
  } finally { if (original === undefined) Reflect.deleteProperty(URL, 'createObjectURL'); else Object.defineProperty(URL, 'createObjectURL', original) }
})
