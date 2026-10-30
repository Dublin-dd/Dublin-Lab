/** Native capture grants are single-use, primary-frame scoped and gesture bound. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installDublinTools } from '../src/dublin-tools-native.ts'

const native = vi.hoisted(() => ({ directory: '', handle: vi.fn(), display: vi.fn(), sources: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => native.directory }, clipboard: {}, dialog: {}, safeStorage: {}, systemPreferences: {},
  ipcMain: { handle: native.handle }, session: { defaultSession: { setDisplayMediaRequestHandler: native.display } },
  desktopCapturer: { getSources: native.sources },
}))
beforeEach(async () => { vi.clearAllMocks(); native.directory = await mkdtemp(join(tmpdir(), 'dublin-ipc-')) })
afterEach(async () => { await rm(native.directory, { recursive: true, force: true }) })
function fixture() {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const frame = { url: 'dsh-app://app/' }, event = { senderFrame: frame, sender } as IpcMainInvokeEvent
  const assertSender = vi.fn((value: IpcMainInvokeEvent) => { if (value !== event) throw new Error('unowned') })
  const tools = installDublinTools(assertSender)
  const invoke = native.handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent, op: unknown, input: unknown) => Promise<unknown>
  const capture = native.display.mock.calls[0]![0] as (request: Record<string, unknown>,
    callback: (streams: Record<string, unknown>) => void) => void
  return { frame, event, invoke, capture, tools, sender }
}
it('denies unowned callers before dispatch and exposes only sanitized invalid-operation errors', async () => {
  const f = fixture()
  await expect(f.invoke({} as IpcMainInvokeEvent, 'recordings', null)).rejects.toThrow('unowned')
  await expect(f.invoke(f.event, 'recordingRead', { id: '../../private' })).rejects.toThrow('toolsInvalid')
  await expect(f.invoke(f.event, 'not-an-operation', null)).rejects.toThrow('toolsInvalid')
  expect(await f.invoke(f.event, 'recordings', null)).toEqual([])
})
it('requires an authorization, owned origin and user gesture, consuming each authorization once', async () => {
  const f = fixture(), callback = vi.fn(), request = { frame: f.frame, securityOrigin: 'dsh-app://app', userGesture: true, audioRequested: true }
  f.capture(request, callback); expect(callback).toHaveBeenLastCalledWith({})
  for (const denied of [{ ...request, userGesture: false }, { ...request, securityOrigin: 'https://example.com' }, { ...request, frame: {} }]) {
    await f.invoke(f.event, 'captureAuthorize', null); f.capture(denied, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  }
  expect(native.sources).not.toHaveBeenCalled()
  native.sources.mockResolvedValueOnce([{ id: 'screen:0' }])
  await f.invoke(f.event, 'captureAuthorize', null); f.capture(request, callback)
  await vi.waitFor(() => { expect(callback).toHaveBeenLastCalledWith({ video: { id: 'screen:0' }, audio: 'loopback' }) })
  f.capture(request, callback); expect(callback).toHaveBeenLastCalledWith({})
  expect(native.sources).toHaveBeenCalledOnce()
})
it('finalizes audio and releases capture ownership when the renderer crashes', async () => {
  const f = fixture()
  const raw = await f.invoke(f.event, 'recordingStart', { source: 'microphone' })
  expect(raw).toHaveProperty('id')
  const item = (await f.tools.recordings.list())[0]!
  await f.invoke(f.event, 'recordingAppend', { id: item.id, pcm: new Uint8Array(32000) })
  f.sender.emit('render-process-gone')
  await vi.waitFor(() => { expect(f.tools.capturing).toBe(false) })
  expect((await f.tools.recordings.list())[0]?.duration).toBe(1)
  expect(f.sender.listenerCount('destroyed')).toBe(0)
  await f.invoke(f.event, 'recordingStart', { source: 'mixed' })
  await f.tools.finish()
})
