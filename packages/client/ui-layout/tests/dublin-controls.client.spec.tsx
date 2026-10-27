// @vitest-environment jsdom
/** Local camera lifecycle and appearance metadata boundaries. */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CameraIsland, AppearanceControl } from '../src/client/DublinControls.tsx'
import { loadDublinAppearance, useDublinAppearance } from '../src/client/dublin-appearance.ts'
import { siminZh, type SiminKey } from '../src/client/simin-locales.ts'
const t = (key: string): string => siminZh[key as SiminKey]
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })
function media() {
  const stop = vi.fn(), track = { stop, addEventListener: vi.fn() }, stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  const pending = Promise.withResolvers<MediaStream>()
  const getUserMedia = vi.fn(() => pending.promise)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  return { pending, stream: stream as unknown as MediaStream, stop, getUserMedia }
}
it('requests video only, then stops every track when preview is clicked', async () => {
  const m = media(); const ui = render(<CameraIsland t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('cameraOpen') }))
  expect(m.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
  await act(async () => { m.pending.resolve(m.stream); await m.pending.promise })
  expect(ui.container.querySelector('video')?.srcObject).toBe(m.stream)
  fireEvent.click(screen.getByRole('button', { name: t('cameraClose') }))
  expect(m.stop).toHaveBeenCalledOnce(); expect(ui.container.querySelector('video')).toBeNull()
})
it('keeps the idle island and style entry free of decorative content', () => {
  render(<CameraIsland t={t} />)
  const island = screen.getByRole('button', { name: t('cameraOpen') })
  expect(island.textContent).toBe(''); expect(island.children.length).toBe(0)
})
it('stops a late permission result after the user cancels', async () => {
  const m = media(); render(<CameraIsland t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('cameraOpen') })); fireEvent.click(screen.getByRole('button', { name: t('cameraClose') }))
  await act(async () => { m.pending.resolve(m.stream); await m.pending.promise })
  expect(m.stop).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: t('cameraOpen') })).toBeTruthy()
})
it('stops a late permission result after unmount', async () => {
  const m = media(); const ui = render(<CameraIsland t={t} />); fireEvent.click(screen.getByRole('button', { name: t('cameraOpen') })); ui.unmount()
  await act(async () => { m.pending.resolve(m.stream); await m.pending.promise }); expect(m.stop).toHaveBeenCalledOnce()
})
it('clamps saved transparency and ignores unknown styles', () => {
  localStorage.setItem('dublin.appearance.v1', '{"style":"red","transparency":140}')
  expect(loadDublinAppearance()).toEqual({ style: 'light', transparency: 100, chatTransparency: 100 })
  localStorage.setItem('dublin.appearance.v1', '{"style":"dark","transparency":25}')
  expect(loadDublinAppearance()).toEqual({ style: 'dark', transparency: 25, chatTransparency: 25 })
  localStorage.setItem('dublin.appearance.v1', '{"style":"dark","transparency":25,"chatTransparency":-20}')
  expect(loadDublinAppearance()).toEqual({ style: 'dark', transparency: 25, chatTransparency: 0 })
  localStorage.setItem('dublin.appearance.v1', '{"chatTransparency":null}')
  expect(loadDublinAppearance()).toEqual({ style: 'light', transparency: 70, chatTransparency: 70 })
})
it('opens appearance choices and requests the charcoal style without uploading', () => {
  const update = vi.fn(), setBackground = vi.fn(async () => {})
  render(<AppearanceControl t={t} state={{ appearance: { style: 'light', transparency: 70, chatTransparency: 70 }, imageUrl: null, saving: false, error: false, update, setBackground }} />)
  fireEvent.click(screen.getByRole('button', { name: /工作台风格/u }))
  expect(screen.getByRole('dialog', { name: t('appearance') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('appearanceDark') }))
  expect(update).toHaveBeenCalledWith({ style: 'dark', transparency: 70, chatTransparency: 70 })
  expect(setBackground).not.toHaveBeenCalled()
})
it('adjusts conversation transparency independently and persists both controls', async () => {
  localStorage.setItem('dublin.appearance.v1', '{"style":"light","transparency":70,"chatTransparency":35}')
  const hook = renderHook(() => useDublinAppearance())
  await act(async () => {})
  const ui = render(<AppearanceControl t={t} state={{ ...hook.result.current, imageUrl: 'blob:local-background' }} />)
  fireEvent.click(screen.getByRole('button', { name: t('appearance') }))
  fireEvent.change(screen.getByRole('slider', { name: /对话背景透明度/u }), { target: { value: '20' } })
  expect(loadDublinAppearance()).toEqual({ style: 'light', transparency: 70, chatTransparency: 20 })
  ui.rerender(<AppearanceControl t={t} state={{ ...hook.result.current, imageUrl: 'blob:local-background' }} />)
  fireEvent.change(screen.getByRole('slider', { name: /图片透明度/u }), { target: { value: '90' } })
  expect(loadDublinAppearance()).toEqual({ style: 'light', transparency: 90, chatTransparency: 20 })
})
it('releases a live stream when the page is hidden', async () => {
  const m = media(); render(<CameraIsland t={t} />); fireEvent.click(screen.getByRole('button', { name: t('cameraOpen') }))
  await act(async () => { m.pending.resolve(m.stream); await m.pending.promise })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  fireEvent(document, new Event('visibilitychange'))
  expect(m.stop).toHaveBeenCalledOnce()
})
