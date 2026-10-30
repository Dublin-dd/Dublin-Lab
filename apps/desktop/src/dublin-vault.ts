/** Encrypted local storage. Authentication precedes every read, copy, update and removal of a secret. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { VaultCard, TranscriptionSettings } from '@deepseek-ai/dsh-client-ui-layout/tools'

interface SecretCard extends VaultCard { secret: string }
interface VaultData { version: 1; cards: SecretCard[]; transcription?: Omit<TranscriptionSettings, 'configured'> & { apiKey: string } }
export interface VaultSecurity {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  authenticate(): Promise<void>
  copy(value: string): void | Promise<void>
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('toolsInvalid')
  return value as Record<string, unknown>
}
export function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('toolsInvalid')
  return value.trim()
}
export function identity(value: unknown): string {
  const id = field(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new Error('toolsInvalid')
  return id
}
export function absent(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }

/** One process owns writes; failed authentication never releases a key to the renderer. */
export class DublinVault {
  private writes: Promise<unknown> = Promise.resolve()
  private readonly path: string
  constructor(directory: string, private readonly security: VaultSecurity) { this.path = join(directory, 'secrets.v1.enc') }
  private async read(): Promise<VaultData> {
    if (!this.security.available()) throw new Error('toolsEncryptionUnavailable')
    let bytes: Buffer
    try { bytes = await readFile(this.path) } catch (error) { if (absent(error)) return { version: 1, cards: [] }; throw new Error('toolsStorageError') }
    try {
      const raw = object(JSON.parse(this.security.decrypt(Buffer.from(bytes.toString('utf8'), 'base64'))))
      if (raw.version !== 1 || !Array.isArray(raw.cards)) throw new Error('toolsInvalid')
      const cards = raw.cards.map((item) => {
        const card = object(item)
        if (typeof card.updatedAt !== 'number' || !Number.isFinite(card.updatedAt)) throw new Error('toolsInvalid')
        return { id: identity(card.id), provider: field(card.provider, 100), account: field(card.account, 250),
          secret: field(card.secret, 8192), updatedAt: card.updatedAt }
      })
      return { version: 1, cards, ...(raw.transcription === undefined ? {} : { transcription: this.parseConfig(raw.transcription) }) }
    } catch (_error) { throw new Error('toolsStorageError') }
  }
  private parseConfig(value: unknown): NonNullable<VaultData['transcription']> {
    const item = object(value)
    if (item.region !== 'beijing' && item.region !== 'singapore') throw new Error('toolsInvalid')
    const model = field(item.model, 100), summaryModel = field(item.summaryModel, 100)
    if (!/^[\w.-]+$/u.test(model) || !/^[\w.-]+$/u.test(summaryModel)) throw new Error('toolsInvalid')
    return { region: item.region, model, summaryModel, apiKey: field(item.apiKey, 8192) }
  }
  private change<T>(update: (data: VaultData) => T): Promise<T> {
    const next = this.writes.then(async () => {
      const data = await this.read(), result = update(data)
      const encrypted = this.security.encrypt(JSON.stringify(data)).toString('base64')
      await writeFileAtomic(this.path, encrypted, { mode: 0o600, dirMode: 0o700 })
      return result
    })
    this.writes = next.catch((_error: unknown) => { /* The caller reports a sanitized failure; later writes can retry. */ })
    return next
  }
  async list(): Promise<VaultCard[]> {
    await this.writes
    return (await this.read()).cards.map(({ id, provider, account, updatedAt }) => ({ id, provider, account, updatedAt }))
  }
  async save(raw: unknown): Promise<VaultCard> {
    const item = object(raw), id = item.id === undefined ? randomUUID() : identity(item.id)
    const provider = field(item.provider, 100), account = field(item.account, 250)
    const secret = item.secret === '' && item.id !== undefined ? undefined : field(item.secret, 8192)
    if (item.id !== undefined) await this.security.authenticate()
    return this.change((data) => {
      const previous = data.cards.find(row => row.id === id)
      if (item.id !== undefined && previous === undefined) throw new Error('toolsMissing')
      const resolvedSecret = secret ?? previous?.secret
      if (resolvedSecret === undefined) throw new Error('toolsInvalid')
      const card = { id, provider, account, secret: resolvedSecret, updatedAt: Date.now() }
      data.cards = [...data.cards.filter(row => row.id !== id), card]
      const { secret: _secret, ...metadata } = card
      return metadata
    })
  }
  async reveal(id: string): Promise<string> {
    await this.security.authenticate(); await this.writes
    const item = (await this.read()).cards.find(card => card.id === id)
    if (item === undefined) throw new Error('toolsMissing')
    return item.secret
  }
  async copy(id: string): Promise<void> { await this.security.copy(await this.reveal(id)) }
  async remove(id: string): Promise<void> {
    await this.security.authenticate()
    await this.change((data) => { data.cards = data.cards.filter(card => card.id !== id) })
  }
  async settings(): Promise<TranscriptionSettings> {
    await this.writes
    const config = (await this.read()).transcription
    return config === undefined ? { region: 'beijing', model: 'qwen-audio-3.1-asr-flash-filetrans', summaryModel: 'qwen-plus', configured: false }
      : { region: config.region, model: config.model, summaryModel: config.summaryModel, configured: true }
  }
  async configure(raw: unknown): Promise<TranscriptionSettings> {
    await this.security.authenticate()
    const item = object(raw)
    const previous = (await this.read()).transcription
    const config = this.parseConfig({ ...item, apiKey: item.apiKey === '' ? previous?.apiKey : item.apiKey })
    await this.change((data) => { data.transcription = config })
    return this.settings()
  }
  async disconnect(): Promise<void> {
    await this.security.authenticate()
    await this.change((data) => { delete data.transcription })
  }
  async credentials(): Promise<NonNullable<VaultData['transcription']>> {
    await this.writes
    const config = (await this.read()).transcription
    if (config === undefined) throw new Error('toolsConfigureFirst')
    return config
  }
}
