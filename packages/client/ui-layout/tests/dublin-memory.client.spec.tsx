// @vitest-environment jsdom
/** Cloud consent, review gating and provenance are verified through the actual memory page. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DublinMemory } from '../src/client/DublinMemory.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
import { siminRequest } from '../src/client/simin-api.ts'
vi.mock('../src/client/simin-api.ts', () => ({ siminRequest: vi.fn() }))
const t = (key: string, params?: Record<string, unknown>): string => {
  let value = siminZh[key as SiminKey]
  for (const [name, text] of Object.entries(params ?? {})) value = value.replace('{' + name + '}', String(text))
  return value
}
let state: {
  items: {
    id: string
    text: string
    kind: string
    status: string
    project: string | null
    createdAt: number
    updatedAt: number
    source: null
  }[]
  settings: {
    enabled: boolean
    automatic: boolean
    cloud: boolean
    semantic: boolean
    embeddingUrl: string
    embeddingModel: string
    credentialRef: string
  }
  usage: unknown[]
  jobs: unknown[]
}
beforeEach(() => {
  state = {
    items: [],
    settings: {
      enabled: true,
      automatic: false,
      cloud: false,
      semantic: false,
      embeddingUrl: '',
      embeddingModel: '',
      credentialRef: '',
    },
    usage: [],
    jobs: [],
  }
  vi.mocked(siminRequest).mockImplementation(async (_path, payload) => {
    if (!payload) return structuredClone(state)
    if (payload.op === 'settings') {
      state.settings = payload.settings as typeof state.settings
      return state.settings
    }
    if (payload.op === 'save') {
      const incoming = payload.item as typeof state.items[number]
      const item = {
        ...incoming,
        id: incoming.id ?? 'manual-memory',
        createdAt: incoming.createdAt ?? 1,
        updatedAt: incoming.updatedAt ?? 1,
        source: incoming.source ?? null,
      }
      state.items = [...state.items.filter(x => x.id !== item.id), item]
      return item
    }
    if (payload.op === 'delete') {
      state.items = state.items.filter(x => x.id !== payload.id)
      return { ok: true }
    }
    if (payload.op === 'sessions') return { items: [{ id: 'old-chat', title: '演示产品讨论' }] }
    if (payload.op === 'extract') return { queued: true }
    throw Error('unexpected request')
  })
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function page() {
  render(<DublinMemory t={t} projects={['旅行助手']} />)
  await screen.findByText(t('memoryEmpty'))
}
function click(key: SiminKey) {
  fireEvent.click(screen.getByRole('button', { name: t(key) }))
}
it('does not enable cloud processing or read history when the page opens', async () => {
  await page()
  expect(screen.getByText(t('memoryLocal'))).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: t('memoryCloud') })).toHaveProperty('checked', false)
  expect(screen.getByRole('checkbox', { name: t('memoryAutomatic') })).toHaveProperty('disabled', true)
  expect(vi.mocked(siminRequest).mock.calls.every(([, payload]) => payload === undefined)).toBe(true)
})
it('saves a manually scoped fact without sending it to a model', async () => {
  await page()
  click('memoryNew')
  fireEvent.change(screen.getByRole('textbox', { name: t('memoryText') }), { target: { value: '先确认需求，再修改代码' } })
  fireEvent.change(screen.getByRole('combobox', { name: t('memoryScope') }), { target: { value: '旅行助手' } })
  click('memorySave')
  await screen.findByText(t('memorySaved'))
  const saved = vi.mocked(siminRequest).mock.calls.find(([, payload]) => payload?.op === 'save')
  expect(saved?.[1]?.item).toMatchObject({ kind: 'project', project: '旅行助手', status: 'active' })
  expect(vi.mocked(siminRequest).mock.calls.some(([, payload]) => payload?.op === 'extract')).toBe(false)
})
it('requires explicit cloud settings and a separate confirmation before importing a selected chat', async () => {
  await page()
  fireEvent.click(screen.getByRole('checkbox', { name: t('memoryCloud') }))
  click('memorySaveSettings')
  await screen.findByText(t('memorySettingsSaved'))
  click('memoryImportHistory')
  await screen.findByRole('option', {
    name: '演示产品讨论',
  })
  click('memoryExtract')
  expect(vi.mocked(siminRequest).mock.calls.some(([, payload]) => payload?.op === 'extract')).toBe(false)
  expect(screen.getByText(t('memoryImportConfirm'))).toBeTruthy()
  click('memoryExtract')
  await screen.findByRole('button', { name: t('memoryExtract') })
  expect(siminRequest).toHaveBeenCalledWith('/aipm/memory', {
    op: 'extract',
    sessionId: 'old-chat',
  }, expect.any(AbortSignal))
})
it('approves pending memory and preserves the ability to pause it and confirm deletion', async () => {
  state.items = [{
    id: 'candidate',
    text: '默认先讨论证据',
    kind: 'personal',
    status: 'pending',
    project: null,
    createdAt: 1,
    updatedAt: 1,
    source: null,
  }]
  await page()
  fireEvent.click(screen.getByRole('tab', { name: /待确认/u }))
  click('memoryApprove')
  await screen.findByText(t('memoryEmpty'))
  fireEvent.click(screen.getByRole('tab', { name: /个人记忆/u }))
  await screen.findByText('默认先讨论证据')
  click('memoryPause')
  await screen.findByText(t('memoryPaused'))
  click('memoryDelete')
  expect(state.items).toHaveLength(1)
  const confirmation = screen.getByRole('alert')
  fireEvent.click(within(confirmation).getByRole('button', {
    name: t('memoryDelete'),
  }))
  await screen.findByText(t('memoryEmpty'))
  expect(state.items).toHaveLength(0)
})
it('reports unavailable storage without presenting an empty memory library as success', async () => {
  vi.mocked(siminRequest).mockRejectedValueOnce(Error('memoryUnavailable'))
  render(<DublinMemory t={t} projects={[]} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('memoryUnavailable'))
})
