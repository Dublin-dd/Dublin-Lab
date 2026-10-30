// @vitest-environment jsdom
/** Media lifecycle tests never acquire real devices or write user audio. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DublinRecording, DublinToolsApi } from '../src/dublin-tools.ts'
import { DublinRecorder, audioTime } from '../src/client/dublin-recorder.ts'

class Track extends EventTarget {
  readyState = 'live'
  stop = vi.fn(() => { this.readyState = 'ended' })
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getAudioTracks() { return this.tracks }
  getTracks() { return this.tracks }
}
const devices = { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() }
const contexts: AudioContextMock[] = [], nodes: NodeMock[] = []
class NodeMock {
  port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> } = {
    onmessage: null, postMessage: vi.fn((message: string) => {
      if (message === 'stop') queueMicrotask(() => { this.port.onmessage?.(new MessageEvent('message', { data: 'flushed' })) })
    }),
  }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() { nodes.push(this) }
  receive(samples: number) { this.port.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(samples * 2) })) }
}
class AudioContextMock {
  sampleRate = 16000
  destination = {}
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  close = vi.fn().mockResolvedValue(undefined)
  resume = vi.fn().mockResolvedValue(undefined)
  createGain() { return { gain: { value: 1 }, connect: vi.fn() } }
  createMediaStreamSource() { return { connect: (next: ReturnType<AudioContextMock['createGain']>) => next } }
  constructor() { contexts.push(this) }
}
const item: DublinRecording = { id: 'fake-record', title: '录音', duration: 0, createdAt: 1, interrupted: false, source: 'microphone', segments: [], summaries: [] }
const run = vi.fn(), progress = vi.fn(), failure = vi.fn(), saved = vi.fn()
beforeEach(() => {
  nodes.length = 0; contexts.length = 0
  vi.stubGlobal('AudioContext', AudioContextMock); vi.stubGlobal('AudioWorkletNode', NodeMock); vi.stubGlobal('MediaStream', Stream)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices })
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-worklet'), revokeObjectURL: vi.fn() })
  run.mockImplementation(async (op: string, data: { pcm?: Uint8Array }) => {
    if (op === 'recordingStart') return item
    if (op === 'recordingAppend') return (data.pcm?.byteLength ?? 0) / 32000
    if (op === 'recordingStop') return { ...item, duration: 1 }
    return undefined
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
function recorder() { return new DublinRecorder({ run } as DublinToolsApi, progress, failure, saved) }
it('does nothing until start, pauses/resumes and drains pending PCM before saving and releasing devices', async () => {
  const track = new Track(); devices.getUserMedia.mockResolvedValue(new Stream([track]))
  const capture = recorder(); expect(run).not.toHaveBeenCalled()
  await capture.start('microphone')
  nodes[0]!.receive(16000)
  await vi.waitFor(() => { expect(run).toHaveBeenCalledWith('recordingAppend', expect.objectContaining({ id: item.id })) })
  capture.pause(); expect(nodes[0]!.port.postMessage).toHaveBeenLastCalledWith('pause')
  capture.pause(); expect(nodes[0]!.port.postMessage).toHaveBeenLastCalledWith('resume')
  await capture.stop()
  expect(run.mock.calls.map(call => String(call[0]))).toEqual(['recordingStart', 'recordingAppend', 'recordingStop'])
  expect(saved).toHaveBeenCalledWith({ ...item, duration: 1 }); expect(track.stop).toHaveBeenCalledOnce()
  expect(contexts[0]!.close).toHaveBeenCalledOnce(); expect(progress).toHaveBeenLastCalledWith({ phase: 'idle', duration: 1, source: 'microphone' })
  expect(failure).not.toHaveBeenCalled()
})
it('requires a live system-audio track for mixed capture and releases it if microphone access is refused', async () => {
  const track = new Track(); devices.getDisplayMedia.mockResolvedValue(new Stream([track])); devices.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
  const capture = recorder(); await capture.start('mixed')
  expect(run.mock.calls.map(call => String(call[0]))).toEqual(['captureAuthorize'])
  expect(track.stop).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce()
  expect(progress).toHaveBeenLastCalledWith({ phase: 'idle', duration: 0, source: 'mixed' })
})
it('cancels late device authorization on disposal without starting an orphan recording', async () => {
  const permission = Promise.withResolvers<Stream>(); devices.getUserMedia.mockReturnValue(permission.promise)
  const track = new Track(), capture = recorder(), starting = capture.start('microphone'), stopping = capture.stop()
  permission.resolve(new Stream([track])); await Promise.all([starting, stopping])
  expect(track.stop).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled()
})
it('saves the written prefix when an audio source ends and stops only once', async () => {
  const track = new Track(); devices.getUserMedia.mockResolvedValue(new Stream([track]))
  const capture = recorder(); await capture.start('microphone')
  track.dispatchEvent(new Event('ended'))
  await capture.stop()
  expect(saved).toHaveBeenCalledOnce(); expect(run.mock.calls.filter(call => String(call[0]) === 'recordingStop')).toHaveLength(1)
  expect(failure.mock.calls[0]?.[0]).toMatchObject({ message: 'toolsAudioInterrupted' })
})
it('formats seconds and long recordings without wrapping the hour', () => {
  expect([audioTime(0), audioTime(61), audioTime(3661)]).toEqual(['00:00', '01:01', '1:01:01'])
})
