/** Audio-only PCM capture with an acknowledged, bounded queue to the native WAV writer. */
import type { DublinRecording, DublinToolsApi, RecordingSource } from '../dublin-tools.ts'

const processor = `
class DublinPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Int16Array(4096); this.length = 0; this.paused = false;
    this.port.onmessage = ({data}) => {
      if (data === 'pause') { this.flush(); this.paused = true; }
      if (data === 'resume') this.paused = false;
      if (data === 'stop') { this.paused = true; this.flush(); this.port.postMessage('flushed'); }
    };
  }
  flush() {
    if (!this.length) return;
    const bytes = this.samples.slice(0, this.length).buffer;
    this.port.postMessage(bytes, [bytes]); this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.paused && channels && channels.length) {
      for (let i = 0; i < channels[0].length; i++) {
        let sample = 0;
        for (const channel of channels) sample += channel[i] / channels.length;
        sample = Math.max(-1, Math.min(1, sample));
        this.samples[this.length++] = sample < 0 ? sample * 32768 : sample * 32767;
        if (this.length === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('dublin-pcm', DublinPcm);`

/** Current capture phase and written audio duration in seconds. */
export interface CaptureProgress { phase: 'idle' | 'starting' | 'recording' | 'paused' | 'saving'; duration: number; source?: RecordingSource }
/** Own media resources through a single start/pause/stop lifecycle, independent of the drawer. */
export class DublinRecorder {
  private context: AudioContext | undefined
  private node: AudioWorkletNode | undefined
  private readonly streams: MediaStream[] = []
  private item: DublinRecording | undefined
  private pending: Promise<void> = Promise.resolve()
  private queued = 0
  private duration = 0
  private source: RecordingSource = 'microphone'
  private phase: CaptureProgress['phase'] = 'idle'
  private stopping: Promise<DublinRecording | undefined> | undefined
  private starting: Promise<void> | undefined
  private cancelled = false
  private flushed: (() => void) | undefined
  constructor(private readonly api: DublinToolsApi, private readonly progress: (value: CaptureProgress) => void,
    private readonly failure: (error: unknown) => void, private readonly saved: (item: DublinRecording) => void) {}
  private publish(phase: CaptureProgress['phase']): void { this.phase = phase; this.progress({ phase, duration: this.duration, source: this.source }) }
  /**
   * Begin capture after device authorization.
   * @param source - microphone or mixed audio.
   * @returns capture initialization.
   */
  start(source: RecordingSource): Promise<void> {
    if (this.phase !== 'idle') return Promise.resolve()
    this.cancelled = false; this.source = source
    this.starting = this.begin(source)
    return this.starting.finally(() => { this.starting = undefined })
  }
  private checkCancellation(): void { if (this.cancelled) throw new Error('toolsRecordingCancelled') }
  private async begin(source: RecordingSource): Promise<void> {
    this.duration = 0; this.stopping = undefined; this.pending = Promise.resolve(); this.publish('starting')
    try {
      const devices = (navigator as Partial<Navigator>).mediaDevices
      if (devices === undefined || typeof AudioWorkletNode === 'undefined') throw new Error('toolsRecordingUnsupported')
      if (source === 'mixed') {
        await this.api.run('captureAuthorize', null); this.checkCancellation()
        const stream = await devices.getDisplayMedia({ audio: true, video: true })
        this.streams.push(stream); this.checkCancellation()
        if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('toolsSystemAudioDenied')
      }
      const mic = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      this.streams.push(mic); this.checkCancellation()
      const context = new AudioContext({ sampleRate: 16000 }); this.context = context
      if (context.sampleRate !== 16000) throw new Error('toolsRecordingUnsupported')
      const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }))
      try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
      this.checkCancellation()
      const node = new AudioWorkletNode(context, 'dublin-pcm', { channelCount: 1, channelCountMode: 'explicit' }); this.node = node
      this.item = await this.api.run('recordingStart', { source }); this.checkCancellation()
      const id = this.item.id
      node.port.onmessage = ({ data }: MessageEvent<unknown>): void => {
        if (data === 'flushed') { this.flushed?.(); return }
        if (!(data instanceof ArrayBuffer)) return
        this.queued++
        if (this.queued > 16) { this.failure(new Error('toolsRecordingSlow')); void this.stop(); return }
        this.pending = this.pending.then(async () => {
          try {
            this.duration = await this.api.run('recordingAppend', { id, pcm: new Uint8Array(data) })
            this.progress({ phase: this.phase, duration: this.duration, source: this.source })
          } finally { this.queued-- }
        })
        void this.pending.catch((error: unknown) => { this.failure(error); void this.stop() })
      }
      for (const stream of this.streams) {
        const audio = new MediaStream(stream.getAudioTracks())
        const input = context.createMediaStreamSource(audio), gain = context.createGain()
        gain.gain.value = this.streams.length === 1 ? 1 : 0.5
        input.connect(gain).connect(node)
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
          if (this.phase === 'recording' || this.phase === 'paused') { this.failure(new Error('toolsAudioInterrupted')); void this.stop() }
        }, { once: true })
      }
      node.connect(context.destination)
      await context.resume(); this.checkCancellation(); this.publish('recording')
    } catch (error) { if (!this.cancelled) this.failure(error); await this.finish() }
  }
  /** Toggle pause without releasing authorized devices or the saved recording. */
  pause(): void {
    if (this.phase !== 'recording' && this.phase !== 'paused') return
    const paused = this.phase === 'recording'
    this.node?.port.postMessage(paused ? 'pause' : 'resume'); this.publish(paused ? 'paused' : 'recording')
  }
  /**
   * Stop tracks and finalize written audio.
   * @returns the saved recording when capture was active, otherwise undefined.
   */
  stop(): Promise<DublinRecording | undefined> {
    if (this.phase === 'starting' && this.starting !== undefined) { this.cancelled = true; return this.starting.then(() => undefined) }
    if (this.stopping !== undefined) return this.stopping
    if (this.phase === 'idle') return Promise.resolve(undefined)
    this.stopping = this.finish(); return this.stopping
  }
  private async finish(): Promise<DublinRecording | undefined> {
    this.publish('saving')
    let result: DublinRecording | undefined
    try {
      if (this.node !== undefined && this.item !== undefined) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000)
          this.flushed = () => { clearTimeout(timer); resolve() }
          this.node?.port.postMessage('stop')
        })
      }
      await this.pending.catch((_error: unknown) => { /* Already reported; finalize the safely written prefix. */ })
      if (this.item !== undefined) {
        result = await this.api.run('recordingStop', { id: this.item.id }); this.saved(result)
      }
    } catch (error) { this.failure(error) }
    finally {
      this.node?.disconnect(); this.node = undefined
      for (const stream of this.streams.splice(0)) for (const track of stream.getTracks()) track.stop()
      try { await this.context?.close() } catch (_error) { /* A removed audio device may have already closed the context. */ }
      this.context = undefined; this.item = undefined; this.flushed = undefined
      this.queued = 0; this.publish('idle')
    }
    return result
  }
}

/**
 * Format elapsed audio time.
 * @param seconds - elapsed seconds.
 * @returns mm:ss or hh:mm:ss without wrapping hours.
 */
export function audioTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    : `${Math.floor(value / 60).toString().padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}
