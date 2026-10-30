/** Incrementally saved mono PCM/WAV recordings, independent of projects and chat history. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DublinRecording, RecordingSource, RecordingSummary } from '@deepseek-ai/dsh-client-ui-layout/tools'
import { absent, field, identity, object } from './dublin-vault.ts'

const RATE = 16000
const MAX_BYTES = RATE * 2 * 60 * 60 * 2
/** 16-bit mono WAV remains seekable without loading or re-encoding the recording. */
export function wavHeader(bytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40)
  return header
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('toolsStorageError')
  return value
}
function parse(raw: unknown): DublinRecording {
  const value = object(raw)
  if ((value.source !== 'microphone' && value.source !== 'mixed') || typeof value.interrupted !== 'boolean'
    || !Array.isArray(value.segments) || !Array.isArray(value.summaries)) throw new Error('toolsStorageError')
  const segments = value.segments.map((raw) => {
    const segment = object(raw)
    return { start: finite(segment.start), end: finite(segment.end),
      speaker: field(segment.speaker, 100), text: field(segment.text, 50000) }
  })
  const summaries = value.summaries.map((raw): RecordingSummary => {
    const summary = object(raw)
    if ((summary.kind !== 'idea' && summary.kind !== 'meeting' && summary.kind !== 'actions') || !Array.isArray(summary.actions)) throw new Error('toolsStorageError')
    return { kind: summary.kind, text: field(summary.text, 100000), actions: summary.actions.map(text => field(text, 500)) }
  })
  let job: DublinRecording['job']
  if (value.job !== undefined) {
    const raw = object(value.job)
    if (raw.region !== 'beijing' && raw.region !== 'singapore') throw new Error('toolsStorageError')
    job = { taskId: field(raw.taskId, 200), region: raw.region }
  }
  if (finite(value.createdAt) > 8_640_000_000_000_000 || finite(value.duration) > 7200) throw new Error('toolsStorageError')
  return { id: identity(value.id), title: field(value.title, 200), source: value.source, createdAt: finite(value.createdAt),
    duration: finite(value.duration), interrupted: value.interrupted, segments, summaries, ...(job === undefined ? {} : { job }) }
}

/** Single active capture; append acknowledgements bound the renderer's write queue. */
export class DublinRecordings {
  private active: { item: DublinRecording; file: FileHandle; bytes: number } | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private readonly recovery = new Map<string, Promise<number>>()
  constructor(private readonly directory: string) {}
  audioPath(id: string): string { return join(this.directory, `${identity(id)}.wav`) }
  private metadata(id: string): string { return join(this.directory, `${identity(id)}.json`) }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writes.then(action)
    this.writes = result.catch((_error: unknown) => { /* Failed operations are reported by the IPC boundary. */ })
    return result
  }
  async get(id: string): Promise<DublinRecording> {
    try {
      const item = parse(JSON.parse(await readFile(this.metadata(id), 'utf8')))
      if (item.id !== id) throw new Error('toolsStorageError')
      if (item.interrupted && this.active?.item.id !== id) return { ...item, duration: await this.recover(id) / (RATE * 2) }
      return item
    }
    catch (error) { if (absent(error)) throw new Error('toolsMissing'); throw new Error('toolsStorageError') }
  }
  async put(item: DublinRecording): Promise<void> {
    await writeFileAtomic(this.metadata(item.id), JSON.stringify(item), { mode: 0o600, dirMode: 0o700 })
  }
  async list(): Promise<DublinRecording[]> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) { if (absent(error)) return []; throw error }
    return (await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name))
      .map(name => this.get(name.slice(0, -5))))).sort((a, b) => b.createdAt - a.createdAt)
  }
  private recover(id: string): Promise<number> {
    const pending = this.recovery.get(id)
    if (pending !== undefined) return pending
    const operation = (async () => {
      const path = this.audioPath(id), size = (await stat(path)).size
      if (size < 44 || size > MAX_BYTES + 44) throw new Error('toolsStorageError')
      const bytes = Math.floor((size - 44) / 2) * 2, header = wavHeader(bytes)
      const file = await open(path, 'r+')
      try {
        const previous = Buffer.alloc(44); await file.read(previous, 0, 44, 0)
        if (!previous.equals(header) || size !== bytes + 44) {
          await file.truncate(bytes + 44); await file.write(header, 0, 44, 0); await file.sync()
        }
      } finally { await file.close() }
      return bytes
    })()
    this.recovery.set(id, operation)
    void operation.catch((_error: unknown) => { this.recovery.delete(id) })
    // Reads repair only audio; they must never replace newer transcription metadata.
    return operation
  }

  start(source: RecordingSource): Promise<DublinRecording> {
    return this.enqueue(async () => {
      if (this.active !== undefined) throw new Error('toolsRecordingActive')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const item: DublinRecording = { id: randomUUID(), title: new Date().toLocaleString(), createdAt: Date.now(), duration: 0,
        source, interrupted: true, segments: [], summaries: [] }
      const file = await open(this.audioPath(item.id), 'wx+', 0o600)
      try { await file.write(wavHeader(0)); await this.put(item) } catch (error) { await file.close(); throw error }
      this.active = { item, file, bytes: 0 }
      return item
    })
  }
  append(id: string, pcm: unknown): Promise<number> {
    return this.enqueue(async () => {
      const active = this.active
      if (active?.item.id !== id) throw new Error('toolsMissing')
      if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength > 131072 || pcm.byteLength % 2 !== 0) throw new Error('toolsInvalid')
      if (active.bytes + pcm.byteLength > MAX_BYTES) throw new Error('toolsRecordingLimit')
      let offset = 0
      while (offset < pcm.byteLength) {
        const { bytesWritten } = await active.file.write(pcm, offset, pcm.byteLength - offset, 44 + active.bytes + offset)
        if (bytesWritten === 0) throw new Error('toolsStorageError')
        offset += bytesWritten
      }
      active.bytes += pcm.byteLength
      await active.file.write(wavHeader(active.bytes), 0, 44, 0)
      return active.bytes / (RATE * 2)
    })
  }
  stop(id: string): Promise<DublinRecording> {
    return this.enqueue(async () => {
      const active = this.active
      if (active?.item.id !== id) throw new Error('toolsMissing')
      try { await active.file.write(wavHeader(active.bytes), 0, 44, 0); await active.file.sync() }
      finally { try { await active.file.close() } finally { this.active = undefined } }
      const item = { ...active.item, duration: active.bytes / (RATE * 2), interrupted: false }
      await this.put(item)
      return item
    })
  }
  async rename(id: string, title: string): Promise<DublinRecording> {
    if (this.active?.item.id === id) throw new Error('toolsRecordingActive')
    const item = { ...await this.get(id), title: field(title, 200) }; await this.put(item); return item
  }
  async remove(id: string): Promise<void> {
    if (this.active?.item.id === id) throw new Error('toolsRecordingActive')
    await this.get(id)
    await unlink(this.metadata(id)); await unlink(this.audioPath(id)); this.recovery.delete(id)
  }
  get capturing(): boolean { return this.active !== undefined }
  async finish(): Promise<void> { await this.writes; if (this.active !== undefined) await this.stop(this.active.item.id) }
}
