// @vitest-environment jsdom
/** GitHub UI defaults and explicit import confirmation over the real request boundary. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinGithub } from '../src/client/DublinGithub.tsx'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
const t = (key: string, args?: Record<string, unknown>): string => Object.entries(args ?? {}).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), siminZh[key as SiminKey])
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture() {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return new Response(JSON.stringify({ id: 'operation', status: 'running' }))
    if (url.includes('op=translate')) return new Response(JSON.stringify({ repo: 'upstream/lab', translated: '示例项目，用于构建工作台' }))
    if (url.includes('op=job')) return new Response(JSON.stringify({ id: 'operation', status: 'done', result: { url: 'https://github.com/dublin/lab' } }))
    if (url.includes('op=status')) return new Response(JSON.stringify({ installed: true, login: 'dublin', root: '/projects/.github-repositories' }))
    return new Response(JSON.stringify({ items: [{ repo: 'upstream/lab', description: 'Sample project', language: 'TypeScript', stars: '100', added: '10 stars this week' }] }))
  })
  vi.stubGlobal('fetch', fetcher); render(<DublinGithub t={t} />); return fetcher
}
it('defaults to weekly and switches to daily without mutation', async () => {
  const fetcher = fixture(); await screen.findByRole('link', { name: 'upstream/lab' })
  expect(fetcher.mock.calls.some(([url]) => url.includes('period=weekly'))).toBe(true)
  expect(screen.getByRole('button', { name: t('githubWeekly') }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: t('githubDaily') }))
  await waitFor(() => { expect(fetcher.mock.calls.some(([url]) => url.includes('period=daily'))).toBe(true) })
  expect(fetcher.mock.calls.every(([_url, options]) => options?.method !== 'POST')).toBe(true)
})
it('offers Fork and independent copying, and writes only after confirmation', async () => {
  const fetcher = fixture(); await screen.findByText('已连接 dublin')
  fireEvent.click(screen.getByRole('button', { name: t('githubImport') }))
  expect(screen.getByRole('dialog', { name: t('githubImport') })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Fork 仓库/u })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /独立仓库/u }))
  expect(screen.getByLabelText(t('githubVisibility'))).toBeTruthy()
  expect(fetcher.mock.calls.every(([_url, options]) => options?.method !== 'POST')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: t('githubImportConfirm') }))
  await waitFor(() => { expect(fetcher.mock.calls.some(([_url, options]) => options?.method === 'POST' && typeof options.body === 'string' && options.body.includes('\"op\":\"copy\"'))).toBe(true) })
})
it('translates on demand and preserves the original project purpose', async () => {
  const fetcher = fixture(); await screen.findByText('Sample project')
  expect(screen.getByText(t('githubPurpose'))).toBeTruthy()
  expect(fetcher.mock.calls.every(([url]) => !url.includes('op=translate'))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: t('githubTranslate') }))
  await screen.findByText('示例项目，用于构建工作台')
  expect(screen.getByText('Sample project')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /翻译成中文/u }))
  expect(screen.queryByText('示例项目，用于构建工作台')).toBeNull()
  expect(screen.getByText('Sample project')).toBeTruthy()
})
