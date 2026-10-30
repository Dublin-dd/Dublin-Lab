/** Local encryption/authentication, seekable persistence and manual cloud workflows. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinVault, type VaultSecurity } from '../src/dublin-vault.ts'
import { DublinRecordings, wavHeader } from '../src/dublin-recordings.ts'
import { DublinTranscription, parseTranscript } from '../src/dublin-transcription.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dublin-personal-')); roots.push(root)
  const key = randomBytes(32), authenticate = vi.fn<() => Promise<void>>().mockResolvedValue(), copy = vi.fn()
  const security: VaultSecurity = {
    available: () => true, authenticate, copy,
    encrypt(text) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); const body = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]) },
    decrypt(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString() },
  }
  return { root, security, authenticate, copy, vault: new DublinVault(root, security), recordings: new DublinRecordings(join(root, 'recordings')) }
}
it('persists encrypted keys and returns metadata only until successful authentication', async () => {
  const f = await fixture()
  const card = await f.vault.save({ provider: '百炼', account: 'me@example.test', secret: 'private-test-key' })
  expect(f.authenticate).not.toHaveBeenCalled()
  const stored = await readFile(join(f.root, 'secrets.v1.enc'), 'utf8')
  expect(stored).not.toContain('private-test-key'); expect(stored).not.toContain('me@example.test')
  expect((await stat(join(f.root, 'secrets.v1.enc'))).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(await f.vault.list())).not.toContain('secret')
  expect(await new DublinVault(f.root, f.security).reveal(card.id)).toBe('private-test-key')
  f.authenticate.mockRejectedValueOnce(new Error('denied'))
  await expect(f.vault.copy(card.id)).rejects.toThrow('denied'); expect(f.copy).not.toHaveBeenCalled()
  await f.vault.copy(card.id); expect(f.copy).toHaveBeenCalledWith('private-test-key')
  await f.vault.save({ id: card.id, provider: 'Alibaba', account: 'local', secret: '' })
  expect(await f.vault.reveal(card.id)).toBe('private-test-key')
  f.authenticate.mockRejectedValueOnce(new Error('denied'))
  await expect(f.vault.remove(card.id)).rejects.toThrow('denied'); expect(await f.vault.list()).toHaveLength(1)
  await f.vault.remove(card.id); expect(await f.vault.list()).toEqual([])
})
it('never substitutes plaintext or overwrites an unreadable encrypted vault', async () => {
  const f = await fixture()
  const locked = new DublinVault(f.root, { ...f.security, available: () => false })
  await expect(locked.save({ provider: 'x', account: 'y', secret: 'z' })).rejects.toThrow('toolsEncryptionUnavailable')
  await writeFile(join(f.root, 'secrets.v1.enc'), 'damaged')
  await expect(f.vault.list()).rejects.toThrow('toolsStorageError')
  await expect(f.vault.save({ provider: 'x', account: 'y', secret: 'z' })).rejects.toThrow('toolsStorageError')
  expect(await readFile(join(f.root, 'secrets.v1.enc'), 'utf8')).toBe('damaged')
})
it('keeps transcription credentials separate from vault cards and does not reveal them to the UI', async () => {
  const f = await fixture(), settings = await f.vault.settings()
  await f.vault.save({ provider: '百炼', account: 'vault only', secret: 'not-the-transcription-key' })
  await expect(f.vault.credentials()).rejects.toThrow('toolsConfigureFirst')
  await f.vault.configure({ ...settings, apiKey: 'transcription-test-key' })
  expect(await f.vault.settings()).toEqual({ region: 'beijing', model: 'qwen-audio-3.1-asr-flash-filetrans', summaryModel: 'qwen-plus', configured: true })
  await f.vault.configure({ ...settings, apiKey: '', summaryModel: 'qwen-turbo' })
  expect((await f.vault.credentials()).apiKey).toBe('transcription-test-key')
  await f.vault.disconnect(); expect((await f.vault.settings()).configured).toBe(false)
  expect(await f.vault.list()).toHaveLength(1)
})
it('serializes audio chunks, checkpoints a seekable WAV and restores recordings independently of projects', async () => {
  const f = await fixture(), item = await f.recordings.start('mixed')
  try {
    await expect(f.recordings.start('microphone')).rejects.toThrow('toolsRecordingActive')
    expect(await Promise.all([
      f.recordings.append(item.id, new Uint8Array(16000)), f.recordings.append(item.id, new Uint8Array(16000)),
    ])).toEqual([0.5, 1])
    const bytes = await readFile(f.recordings.audioPath(item.id))
    expect(bytes.subarray(0, 44)).toEqual(wavHeader(32000)); expect(bytes.length).toBe(32044)
    await expect(f.recordings.append(item.id, new Uint8Array(3))).rejects.toThrow('toolsInvalid')
    await expect(f.recordings.rename(item.id, 'during capture')).rejects.toThrow('toolsRecordingActive')
  } finally { await f.recordings.finish() }
  const restored = new DublinRecordings(join(f.root, 'recordings'))
  expect((await restored.list())[0]).toMatchObject({ source: 'mixed', duration: 1, interrupted: false })
  await restored.rename(item.id, '我的想法'); expect((await restored.get(item.id)).title).toBe('我的想法')
  await restored.remove(item.id); expect(await restored.list()).toEqual([])
})
it('repairs an interrupted WAV from its written PCM and rejects filesystem traversal', async () => {
  const f = await fixture(), item = await f.recordings.start('microphone')
  await f.recordings.append(item.id, new Uint8Array(64000)); await f.recordings.finish()
  const stored = await f.recordings.get(item.id)
  await f.recordings.put({ ...stored, interrupted: true, duration: 0 })
  await writeFile(f.recordings.audioPath(item.id), Buffer.concat([wavHeader(0), Buffer.alloc(64000)]))
  const recovered = new DublinRecordings(join(f.root, 'recordings'))
  expect((await recovered.list())[0]).toMatchObject({ duration: 2, interrupted: true })
  const refreshing = recovered.list()
  await f.recordings.put({ ...stored, interrupted: true, job: { taskId: 'resume-task', region: 'beijing' } })
  await refreshing
  expect((await recovered.get(item.id)).job?.taskId).toBe('resume-task')
  expect((await readFile(f.recordings.audioPath(item.id))).readUInt32LE(40)).toBe(64000)
  expect(() => f.recordings.audioPath('../../secret')).toThrow('toolsInvalid')
})

it('uploads only on explicit transcription, resumes a saved cloud task and persists timestamped speakers', async () => {
  const f = await fixture(), item = await f.recordings.start('mixed')
  await f.recordings.append(item.id, new Uint8Array(32000)); await f.recordings.finish()
  await f.vault.configure({ ...await f.vault.settings(), apiKey: 'test-cloud-key' })
  const send = vi.fn<typeof fetch>()
  const service = new DublinTranscription(f.recordings, f.vault, send, async () => {})
  expect(send).not.toHaveBeenCalled()
  send.mockResolvedValueOnce(Response.json({ data: { upload_dir: 'private', oss_access_key_id: 'test-id', signature: 'test-signature', policy: 'test-policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', upload_host: 'https://example.oss-cn-beijing.aliyuncs.com' } }))
    .mockResolvedValueOnce(new Response('', { status: 200 }))
    .mockResolvedValueOnce(Response.json({ output: { task_id: 'task-one' } }))
    .mockRejectedValueOnce(new Error('network'))
  await expect(service.transcribe(item.id)).rejects.toThrow('network')
  expect((await f.recordings.get(item.id)).job).toEqual({ taskId: 'task-one', region: 'beijing' })
  send.mockResolvedValueOnce(Response.json({ output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.oss-cn-beijing.aliyuncs.com/transcript.json' }] } }))
    .mockResolvedValueOnce(Response.json({ transcripts: [{ sentences: [{ begin_time: 100, end_time: 900, text: '整理文档', speaker_id: 0 }] }] }))
  const result = await service.transcribe(item.id)
  expect(result.job).toBeUndefined(); expect(result.segments).toEqual([{ start: 0.1, end: 0.9, text: '整理文档', speaker: '0' }])
  expect(send.mock.calls.filter(([url]) => (url instanceof Request ? url.url : url.toString()).includes('getPolicy'))).toHaveLength(1)
  const requestBody = send.mock.calls[2]?.[1]?.body
  const body: unknown = JSON.parse(typeof requestBody === 'string' ? requestBody : '')
  expect(body).toMatchObject({ input: { file_urls: [`oss://private/${item.id}.wav`] }, parameters: { diarization_enabled: true, channel_id: [0] } })
  expect(send.mock.calls[3]?.[1]?.headers).toEqual({ authorization: 'Bearer test-cloud-key' })
  expect(send.mock.calls[5]?.[1]?.headers).toBeUndefined()
  expect(await f.recordings.get(item.id)).toEqual(result)
  send.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '待办：整理文档', actions: ['整理文档'] }) } }] }))
  const summary = await service.summarize(item.id, 'actions')
  expect(summary.summaries).toEqual([{ kind: 'actions', text: '待办：整理文档', actions: ['整理文档'] }])
  expect(JSON.stringify(summary)).not.toContain('test-cloud-key')
})
it('refuses malformed transcripts and never invents speaker identity or time', () => {
  expect(parseTranscript({ transcripts: [{ sentences: [{ begin_time: 0, end_time: 10, text: '你好' }] }] })).toEqual([{ start: 0, end: 0.01, speaker: '?', text: '你好' }])
  expect(() => parseTranscript({ transcripts: [{ sentences: [{ begin_time: 9, end_time: 1, text: 'bad' }] }] })).toThrow()
  expect(() => parseTranscript({ transcripts: [{ sentences: [{ begin_time: 0, end_time: 1, text: 'bad', speaker_id: {} }] }] })).toThrow()
})
