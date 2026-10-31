/** Private Markdown memory bodies with a rebuildable SQLite search index and durable deletion guards. */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile, unlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'

/** User-managed memory and its originating conversation. */
export interface MemoryItem {
  id: string
  text: string
  kind: 'personal' | 'project' | 'event'
  status: 'active' | 'pending' | 'paused'
  project: string | null
  createdAt: number
  updatedAt: number
  relatedIds?: string[]
  source: {
    sessionId: string
    title: string
    from: number
    through: number
  } | null
}
/** Explicit cloud-processing controls, separate from stored memory content. */
export interface MemorySettings {
  enabled: boolean
  automatic: boolean
  cloud: boolean
  embeddingUrl: string
  embeddingModel: string
  credentialRef: string
  semantic: boolean
}
/** Safe defaults retain local manual memory while cloud processing remains off until opted in. */
export const memoryDefaults: MemorySettings = {
  enabled: true, automatic: false, cloud: false,
  embeddingUrl: '', embeddingModel: '', credentialRef: '', semantic: false,
}
const uuid = /^[a-f0-9-]{36}$/u
/**
 * Validate one untrusted memory operation object.
 * @param value - decoded wire data.
 * @returns a plain record.
 */
export function memoryObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('memoryInvalid')
  return value as Record<string, unknown>
}
/**
 * Validate bounded memory text and reject likely credentials.
 * @param value - proposed text.
 * @returns normalized content.
 */
export function memoryText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new Error('memoryInvalid')
  const secret = /(?:sk-[a-z0-9_-]{24,}|gh[pousr]_[a-z0-9]{20,}|github_pat_|-----BEGIN .*PRIVATE KEY)/iu
  const labelledSecret = /(?:api[_ -]?key|password|密码|密钥)\s*[:=：]\s*\S{6,}/iu
  if (secret.test(value) || labelledSecret.test(value)) {
    throw new Error('memorySensitive')
  }
  return value.trim()
}
/**
 * Content identity for deletion protection.
 * @param text - body.
 * @returns normalized digest.
 */
export function memoryFingerprint(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')).digest('hex')
}
function item(value: unknown): MemoryItem {
  const data = memoryObject(value)
  if (typeof data.id !== 'string' || !uuid.test(data.id) || !['personal', 'project', 'event'].includes(String(data.kind))
    || !['active', 'pending', 'paused'].includes(String(data.status)) || typeof data.createdAt !== 'number'
    || typeof data.updatedAt !== 'number' || !Number.isFinite(data.createdAt) || !Number.isFinite(data.updatedAt)
    || !(data.project === null || typeof data.project === 'string' && data.project.length <= 180)) throw new Error('memoryInvalid')
  if (data.kind === 'project' && !data.project) throw new Error('memoryInvalid')
  let source: MemoryItem['source'] = null
  if (data.source !== null) {
    const raw = memoryObject(data.source)
    if (typeof raw.sessionId !== 'string' || raw.sessionId.length > 100 || typeof raw.title !== 'string' || raw.title.length > 250
      || !Number.isSafeInteger(raw.from) || !Number.isSafeInteger(raw.through) || Number(raw.from) < 0 || Number(raw.through) < Number(raw.from)) throw new Error('memoryInvalid')
    source = { sessionId: raw.sessionId, title: raw.title, from: Number(raw.from), through: Number(raw.through) }
  }
  return {
    id: data.id,
    text: memoryText(data.text),
    kind: data.kind as MemoryItem['kind'],
    status: data.status as MemoryItem['status'],

    project: data.project,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    source,

    ...(Array.isArray(data.relatedIds) && data.relatedIds.every((x: unknown) => typeof x === 'string' && uuid.test(x)) ? {
      relatedIds: data.relatedIds.map(x => String(x)).slice(0, 30),
    } : {}),
  }
}

/** Serialize file changes, indexing and query access under one local owner. */
export class DublinMemoryStore {
  private db: DatabaseSync | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private closing = false
  private readonly ready: Promise<void>
  /**
   * @param root - private memory directory, outside document tools.
   */
  constructor(readonly root: string) {
    this.ready = this.open()
    void this.ready.catch (() => undefined)
  }
  private async open(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('memoryInvalid')
    await mkdir(join(this.root, 'entries'), { recursive: true, mode: 0o700 })
    if ((await lstat(join(this.root, 'entries'))).isSymbolicLink()) throw new Error('memoryInvalid')
    const index = await lstat(join(this.root, 'index.db')).catch ((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    })
    if (index?.isSymbolicLink()) throw new Error('memoryInvalid')
    this.db = new DatabaseSync(join(this.root, 'index.db'))
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, body TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, body, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, digest TEXT NOT NULL, source TEXT, throughSeq INTEGER);
      CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, revision TEXT NOT NULL, vector TEXT NOT NULL);`)
    try {
      const guards = memoryObject(JSON.parse(await readFile(join(this.root, 'deletion-guards.json'), 'utf8')))
      if (guards.version !== 1 || !Array.isArray(guards.items)) throw new Error('memoryInvalid')
      for (const raw of guards.items) this.guard(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.refresh()
  }
  private guard(value: unknown, validateOnly = false): void {
    const raw = memoryObject(value)
    if (typeof raw.id !== 'string' || !uuid.test(raw.id) || typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.digest)
      || !(raw.source === null || typeof raw.source === 'string') || !(raw.throughSeq === null || Number.isSafeInteger(raw.throughSeq))) throw new Error('memoryInvalid')
    if (validateOnly) return
    this.database().prepare('INSERT OR REPLACE INTO deleted VALUES (?,?,?,?)').run(raw.id, raw.digest, raw.source, raw.throughSeq === null ? null : Number(raw.throughSeq))
  }
  private async saveGuards(): Promise<void> {
    await this.atomic('deletion-guards.json', JSON.stringify({
      version: 1,
      items: this.database().prepare('SELECT * FROM deleted').all(),
    }))
  }
  private database(): DatabaseSync {
    if (this.db === undefined) throw new Error('memoryUnavailable')
    return this.db
  }
  private run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('memoryUnavailable'))
    const work = this.chain.then(async () => {
      await this.ready
      return fn()
    })
    this.chain = work.catch (() => undefined)
    return work
  }
  private getValue<T>(key: string, fallback: T): T {
    const row = this.database().prepare('SELECT value FROM kv WHERE key=?').get(key)
    return row === undefined ? fallback : JSON.parse(String(row.value)) as T
  }
  private setValue(key: string, value: unknown): void {
    this.database().prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value))
  }
  private async atomic(name: string, text: string): Promise<void> {
    const target = join(this.root, name), temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
      await rename(temp, target)
    }
    finally {
      await unlink(temp).catch ((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }
  private async refresh(): Promise<void> {
    const files = await readdir(join(this.root, 'entries'))
    if (files.length > 5000) throw new Error('memoryLimit')
    const parsed: MemoryItem[] = []
    for (const file of files) {
      if (!file.endsWith('.md') || !uuid.test(file.slice(0, -3))) continue
      const path = join(this.root, 'entries', file), stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64000) throw new Error('memoryInvalid')
      const text = await readFile(path, 'utf8'), end = text.indexOf(' -->\n')
      if (!text.startsWith('<!-- dublin-memory ') || end === -1) throw new Error('memoryInvalid')
      const meta = memoryObject(JSON.parse(text.slice(19, end)))
      const entry = item({ ...meta, text: text.slice(end + 5) })
      if (entry.id + '.md' !== file) throw new Error('memoryInvalid')
      if (this.database().prepare('SELECT id FROM deleted WHERE id=?').get(entry.id) === undefined) parsed.push(entry)
    }
    const db = this.database()
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM entries; DELETE FROM search;')
      for (const entry of parsed) {
        db.prepare('INSERT INTO entries VALUES (?,?,?)').run(entry.id, entry.text, JSON.stringify(entry))
        db.prepare('INSERT INTO search VALUES (?,?)').run(entry.id, entry.text)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  private all(): MemoryItem[] {
    return this.database().prepare('SELECT data FROM entries').all().map(row => item(JSON.parse(String(row.data))))
  }
  private async views(): Promise<void> {
    const diaryPath = join(this.root, 'memory')
    await mkdir(diaryPath, { recursive: true, mode: 0o700 })
    if ((await lstat(diaryPath)).isSymbolicLink()) throw new Error('memoryInvalid')
    const entries = this.all(), active = entries.filter(x => x.status === 'active' && x.kind !== 'event')
    await this.atomic('MEMORY.md', '# Dublin Lab · 长期记忆\n\n> 自动生成的阅读视图。通过界面编辑，或修改 entries/ 中对应 Markdown 正文；备份请导出完整记忆包。\n\n'
      + active.map(x => `## ${x.project ?? '个人通用'} · ${x.id}\n\n${x.text}\n`).join('\n'))
    await mkdir(join(this.root, 'memory'), { recursive: true, mode: 0o700 })
    const diaries = new Map<string, MemoryItem[]>()
    for (const entry of entries.filter(x => x.kind === 'event')) {
      const date = new Date(entry.createdAt).toLocaleDateString('sv-SE')
      const group = diaries.get(date) ?? []
      group.push(entry)
      diaries.set(date, group)
    }
    for (const name of await readdir(join(this.root, 'memory'))) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/u.test(name) && !diaries.has(name.slice(0, -3))) await unlink(join(this.root, 'memory', name))
    }
    for (const [date, group] of diaries) await this.atomic(`memory/${date}.md`, `# ${date} · 事件日记\n\n`
      + group.map(x => `- [${x.project ?? '临时会话'}] ${x.text.replace(/\n/gu, ' ')}（来源：${x.source?.title ?? '手动记录'}）`).join('\n') + '\n')
  }
  /**
   * Read canonical bodies and durable controls.
   * @returns detached UI state, with no credentials.
   */
  async snapshot(): Promise<{
    items: MemoryItem[]
    settings: MemorySettings
    usage: unknown[]
    jobs: unknown[]
    root: string
    semanticWarning: string
  }> {
    return this.run(async () => {
      await this.refresh()
      return {
        items: this.all(),
        settings: this.getValue('settings', memoryDefaults),

        usage: this.getValue('usage', []),
        jobs: this.getValue('jobs', []),
        root: this.root,
        semanticWarning: this.getValue('semanticWarning', ''),
      }
    })
  }
  /**
   * Persist explicit processing controls.
   * @param input - complete settings.
   * @returns saved controls.
   */
  async settings(input?: unknown): Promise<MemorySettings> {
    return this.run(() => {
      if (input === undefined) return this.getValue('settings', memoryDefaults)
      const raw = memoryObject(input)
      for (const key of ['enabled', 'automatic', 'cloud', 'semantic']) if (typeof raw[key] !== 'boolean') throw new Error('memoryInvalid')
      for (const key of ['embeddingUrl', 'embeddingModel', 'credentialRef']) if (typeof raw[key] !== 'string' || raw[key].length > 1000) throw new Error('memoryInvalid')
      const next: MemorySettings = {
        enabled: Boolean(raw.enabled),
        automatic: Boolean(raw.automatic),
        cloud: Boolean(raw.cloud),
        semantic: Boolean(raw.semantic),

        embeddingUrl: String(raw.embeddingUrl).trim(),
        embeddingModel: String(raw.embeddingModel).trim(),
        credentialRef: String(raw.credentialRef).trim(),
      }
      if (next.embeddingUrl) {
        const url = new URL(next.embeddingUrl)
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('memoryInvalid')
      }
      if (next.credentialRef && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(next.credentialRef)) throw new Error('memoryInvalid')
      this.setValue('settings', next)
      return next
    })
  }
  /**
   * Add or edit a bounded fact, suppressing deleted source facts.
   * @param raw - complete entry.
   * @param automatic - enforce pending review.
   * @returns saved item or null for suppression.
   */
  async put(raw: unknown, automatic = false): Promise<MemoryItem | null> {
    return this.run(async () => {
      await this.refresh()
      const data = memoryObject(raw), previous = this.all().find(x => x.id === data.id), now = Date.now()
      const entry = item({
        source: null,
        ...data,
        id: previous?.id ?? data.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? data.createdAt ?? now,
        updatedAt: now,
      })
      if (automatic && entry.kind !== 'event') entry.status = 'pending'
      if (this.all().length >= 2000 && previous === undefined) throw new Error('memoryLimit')
      const digest = memoryFingerprint(entry.text), db = this.database()
      if (automatic && (db.prepare('SELECT id FROM deleted WHERE digest=?').get(digest)
        || entry.source && db.prepare('SELECT id FROM deleted WHERE source=? AND throughSeq>=?').get(entry.source.sessionId, entry.source.through))) return null
      if (automatic && this.all().some(x => memoryFingerprint(x.text) === digest && x.project === entry.project)) return null
      const { text, ...metadata } = entry
      await this.atomic(`entries/${entry.id}.md`, `<!-- dublin-memory ${JSON.stringify(metadata)} -->\n${text}\n`)
      await this.refresh()
      await this.views()
      return entry
    })
  }
  /**
   * Delete the body and retain only hashed/source suppression guards.
   * @param id - retained identity.
   */
  async remove(id: string): Promise<void> {
    return this.run(async () => {
      await this.refresh()
      const previous = this.all().find(x => x.id === id)
      if (!previous) throw new Error('memoryMissing')
      this.database().prepare('INSERT OR REPLACE INTO deleted VALUES (?,?,?,?)').run(id, memoryFingerprint(previous.text),
        previous.source?.sessionId ?? null, previous.source?.through ?? null)
      for (const related of this.all().filter(x => previous.relatedIds?.includes(x.id) && x.source !== null)) {
        this.database().prepare('INSERT OR REPLACE INTO deleted VALUES (?,?,?,?)').run(randomUUID(), memoryFingerprint(previous.text),
          related.source?.sessionId ?? null, related.source?.through ?? null)
      }
      await this.saveGuards()
      await unlink(join(this.root, 'entries', id + '.md'))
      await this.refresh()
      await this.views()
    })
  }
  /**
   * Read/write host-only progress and audit state.
   * @param key - internal key.
   * @param fallback - default when no saved value exists.
   * @param value - new JSON value.
   * @returns current value.
   */
  async state<T>(key: string, fallback: T, value?: T): Promise<T> {
    return this.run(() => {
      if (value !== undefined) this.setValue(key, value)
      return this.getValue(key, fallback)
    })
  }
  /**
   * Rank only eligible scope-local bodies, never pending candidates.
   * @param query - current user intent.
   * @param project - allowed project or null.
   * @returns bounded lexical matches.
   */
  async search(query: string, project: string | null): Promise<MemoryItem[]> {
    return this.run(async () => {
      await this.refresh()
      const settings = this.getValue('settings', memoryDefaults)
      if (!settings.enabled) return []
      const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 30)
      const chunks = [...query.toLocaleLowerCase().matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(m =>
        Array.from(m[0]).slice(0, -1).map((_, i) => m[0].slice(i, i + 2)))
      const eligible = this.all().filter(x => x.status === 'active' && (x.project === null || x.project === project))
      const ranked = eligible.map(entry => ({
        entry,
        score: [...terms, ...chunks].reduce((n, term) => n + (entry.text.toLocaleLowerCase().includes(term) ? 2 : 0), 0)
          + (entry.kind === 'personal' && entry.project === null ? 1 : entry.kind === 'project' && entry.project === project ? .5 : 0),
      })).filter(x => x.score > 0)
      return ranked.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt).slice(0, 12).map(x => x.entry)
    })
  }
  /**
   * Read/save a revision-bound vector.
   * @param id - body id.
   * @param vector - finite embedding, or omit to read.
   * @param route - provider cache identity.
   * @returns cached vector if still current.
   */
  async vector(id: string, vector?: number[], route = ''): Promise<number[] | undefined> {
    return this.run(() => {
      const entry = this.all().find(x => x.id === id)
      if (!entry) return undefined
      const revision = memoryFingerprint(entry.text + route)
      if (vector !== undefined) this.database().prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?)').run(id, revision, JSON.stringify(vector))
      const row = this.database().prepare('SELECT vector FROM vectors WHERE id=? AND revision=?').get(id, revision)
      return row === undefined ? undefined : JSON.parse(String(row.vector)) as number[]
    })
  }
  /**
   * Export portable bodies and deletion guards, excluding vectors and raw secrets.
   * @returns a versioned local backup.
   */
  async export(): Promise<unknown> {
    return this.run(async () => {
      await this.refresh()
      return {
        version: 1,
        items: this.all(),
        deleted: this.database().prepare('SELECT * FROM deleted').all(),
      }
    })
  }
  /**
   * Validate a portable backup before merging reviewed entries.
   * @param value - parsed backup.
   * @returns imported entry count.
   */
  async import(value: unknown): Promise<number> {
    const raw = memoryObject(value)
    if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.length > 2000) throw new Error('memoryInvalid')
    const entries = raw.items.map((x: unknown) => item(x))
    if (raw.deleted !== undefined && (!Array.isArray(raw.deleted) || raw.deleted.length > 10000)) throw new Error('memoryInvalid')
    const guards: unknown[] = Array.isArray(raw.deleted) ? raw.deleted : []
    for (const guard of guards) this.guard(guard, true)
    await this.run(async () => {
      for (const guard of guards) this.guard(guard)
      await this.saveGuards()
    })
    let count = 0
    for (const entry of entries) {
      const blocked = await this.run(() => this.database().prepare('SELECT id FROM deleted WHERE id=? OR digest=? OR (source=? AND throughSeq>=?)').get(entry.id, memoryFingerprint(entry.text), entry.source?.sessionId ?? null, entry.source?.through ?? null))
      if (!blocked) {
        await this.put(entry)
        count++
      }
    }
    return count
  }
  /**
   * Drain accepted work before closing SQLite.
   * @returns completed resource release.
   */
  async dispose(): Promise<void> {
    this.closing = true
    try {
      await this.ready
      await this.chain
    } finally {
      this.db?.close()
      this.db = undefined
    }
  }
}
