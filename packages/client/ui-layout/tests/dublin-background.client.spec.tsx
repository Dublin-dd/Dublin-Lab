// @vitest-environment jsdom
/** Workbench background layering across project and conversation navigation. */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SiminShell } from '../src/client/SiminShell.tsx'
import { saveSiminView } from '../src/client/simin-state.ts'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
import { useDublinBackgroundAlignment } from '../src/client/dublin-background.ts'

const appearance = vi.hoisted(() => ({
  appearance: { style: 'light' as const, transparency: 70, chatTransparency: 20 },
  imageUrl: 'blob:local-background' as string | null,
  saving: false, error: false, update: vi.fn(), setBackground: vi.fn(async () => {}),
}))
vi.mock('../src/client/dublin-appearance.ts', async original => ({
  ...await original<typeof import('../src/client/dublin-appearance.ts')>(),
  useDublinAppearance: () => appearance,
}))
const t = (key: string): string => siminZh[key as SiminKey]
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); appearance.imageUrl = 'blob:local-background'; appearance.appearance.chatTransparency = 20 })

function Alignment({ active = true }: { active?: boolean }) {
  const canvas = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  useDublinBackgroundAlignment(canvas, image, active)
  return <div ref={canvas} data-canvas><div data-region><img ref={image} alt="" /></div></div>
}

function boxes() {
  const canvas = { left: 0, top: 0, width: 1440, height: 900 }
  const region = { left: 300, top: 80, width: 1140, height: 820 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = this.hasAttribute('data-canvas') || this.hasAttribute('data-simin-page') ? canvas : region
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height })
  })
  return { canvas, region }
}

it('shares the full canvas crop and realigns on window and sidebar resizing', () => {
  const geometry = boxes()
  let resize: (() => void) | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', vi.fn(function (callback: () => void) { resize = callback; return { observe, disconnect } }))
  const view = render(<Alignment />)
  const image = view.container.querySelector('img')
  expect(image?.style.width).toBe('1440px')
  expect(image?.style.height).toBe('900px')
  expect(image?.style.left).toBe('-300px')
  expect(image?.style.top).toBe('-80px')
  expect(image?.style.visibility).toBe('visible')
  expect(observe).toHaveBeenNthCalledWith(1, view.container.querySelector('[data-canvas]'))
  expect(observe).toHaveBeenNthCalledWith(2, view.container.querySelector('[data-region]'))
  geometry.canvas.width = 1280
  geometry.canvas.height = 760
  geometry.region.left = 220
  geometry.region.top = 96
  act(() => { resize?.() })
  expect(image?.style.width).toBe('1280px')
  expect(image?.style.height).toBe('760px')
  expect(image?.style.left).toBe('-220px')
  expect(image?.style.top).toBe('-96px')
  geometry.canvas.left = 10
  geometry.canvas.top = 12
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(image?.style.left).toBe('-210px')
  expect(image?.style.top).toBe('-84px')
  view.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(image?.style.visibility).toBe('hidden')
  geometry.canvas.width = 1000
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(image?.style.width).toBe('1280px')
})

it('keeps hidden or unmeasured backgrounds invisible and aligns when navigating back', () => {
  const geometry = boxes()
  geometry.region.height = 0
  const view = render(<Alignment />)
  const image = view.container.querySelector('img')
  expect(image?.style.visibility).toBe('hidden')
  geometry.region.height = 820
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(image?.style.visibility).toBe('visible')
  view.rerender(<Alignment active={false} />)
  expect(image?.style.visibility).toBe('hidden')
  geometry.region.top = 100
  view.rerender(<Alignment />)
  expect(image?.style.top).toBe('-100px')
  expect(image?.style.visibility).toBe('visible')
})

it('uses the uploaded image for conversations with independent opacity and removes both layers together', async () => {
  boxes()
  saveSiminView({ page: 'project', project: 'Dublin', file: null, tab: 'chat' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    root: '/projects', projects: [{ name: 'Dublin', path: '/projects/Dublin', files: [], documents: [] }], trash: [], proposals: [],
  }))))
  const view = render(<SiminShell t={t} chat={<div data-phase="hero" />} nativeSettings={null} />)
  const project = view.container.querySelector<HTMLElement>('[data-dublin-chat-background]')
  await waitFor(() => { expect(project?.hidden).toBe(false) })
  const workspaceImage = view.container.querySelector<HTMLImageElement>('[data-simin-page] > img')
  const chatImage = project?.querySelector<HTMLImageElement>(':scope > img')
  expect(chatImage?.src).toBe(workspaceImage?.src)
  expect(chatImage?.style.width).toBe('1440px')
  expect(chatImage?.style.height).toBe('900px')
  expect(chatImage?.style.left).toBe('-300px')
  expect(chatImage?.style.top).toBe('-80px')
  expect(chatImage?.style.visibility).toBe('visible')
  expect(Number(workspaceImage?.style.opacity)).toBeCloseTo(0.3)
  expect(chatImage?.style.opacity).toBe('0.8')
  expect(project?.getAttribute('data-dublin-chat-background')).toBe('true')
  appearance.appearance.chatTransparency = 100
  view.rerender(<SiminShell t={t} chat={<div data-phase="hero" />} nativeSettings={null} />)
  expect(chatImage?.style.opacity).toBe('0')
  appearance.appearance.chatTransparency = 0
  view.rerender(<SiminShell t={t} chat={<div data-phase="hero" />} nativeSettings={null} />)
  expect(chatImage?.style.opacity).toBe('1')
  expect(Number(workspaceImage?.style.opacity)).toBeCloseTo(0.3)
  appearance.imageUrl = null
  view.rerender(<SiminShell t={t} chat={<div data-phase="hero" />} nativeSettings={null} />)
  expect(project?.getAttribute('data-dublin-chat-background')).toBe('false')
  expect(view.container.querySelector('[data-simin-page] img')).toBeNull()
})
