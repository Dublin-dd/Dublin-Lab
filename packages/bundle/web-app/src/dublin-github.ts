/** Local GitHub owner: public Trending data and explicitly requested repository jobs. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SiminFileError } from './simin-files.ts'

/** Public repository information; no executable HTML leaves this owner. */
export interface TrendingRepository { repo: string; description: string; language: string; stars: string; added: string }
interface Job { id: string; status: 'running' | 'done' | 'error'; code?: string; error?: string; result?: Record<string, string> }
const fail = (code: string): never => { throw new SiminFileError(code, 400) }
/**
 * Validate a GitHub repository slug before it reaches paths, URLs or CLI arguments.
 * @param value - external repository identity.
 * @returns validated owner/name.
 */
export function githubRepository(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(value) || ['.', '..'].includes(value.split('/')[1] ?? '')) return fail('githubInvalidRepo')
  return value
}
function text(html: string): string {
  return html.replace(/<[^>]*>/gu, ' ').replace(/&#x([a-f0-9]+);/giu, (_match, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&#([0-9]+);/gu, (_match, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name] ?? '').replace(/\s+/gu, ' ').trim()
}
/**
 * Parse only the scoped repository articles from GitHub Trending.
 * @param html - official Trending response.
 * @returns safe text-only cards.
 */
export function parseGithubTrending(html: string): TrendingRepository[] {
  const repositories: TrendingRepository[] = []
  for (const article of html.matchAll(/<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gu)) {
    const source = article[1] ?? ''
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/u.exec(source)?.[1] ?? ''
    const repo = /href="\/([^"?#]+)"/u.exec(heading)?.[1]
    if (repo === undefined) continue
    try { githubRepository(repo) } catch { continue }
    repositories.push({ repo, description: text(/<p\b[^>]*>([\s\S]*?)<\/p>/u.exec(source)?.[1] ?? ''),
      language: text(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/u.exec(source)?.[1] ?? ''),
      stars: text(/href="[^"]*\/stargazers"[^>]*>([\s\S]*?)<\/a>/u.exec(source)?.[1] ?? ''),
      added: text(/<span[^>]*class="[^"]*float-sm-right[^"]*"[^>]*>([\s\S]*?)<\/span>/u.exec(source)?.[1] ?? ''),
    })
  }
  return repositories.slice(0, 30)
}

/** Own subprocesses and fetch cancellation until Host teardown has fully settled. */
export class DublinGithub {
  private readonly jobs = new Map<string, Job>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()
  private readonly cache = new Map<string, { time: number; items: TrendingRepository[] }>()
  private disposed = false
  private readonly translations = new Map<string, string>()
  private readonly translating = new Map<string, Promise<string>>()
  /** @param root - managed local clone root. @param cli - installed GitHub CLI executable. */
  constructor(readonly root: string, private readonly cli: string) {}

  private command(program: string, args: string[], input?: unknown, job?: Job, timeout = 60_000): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('disposed'))
    const promise = new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot,
        GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_BROWSER: process.platform === 'win32' ? 'cmd /c exit' : 'true', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'en_US.UTF-8' }
      const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let output = '', diagnostics = '', failed = false
      const terminate = (): void => { failed = true; child.kill('SIGTERM'); force = setTimeout(() => { child.kill('SIGKILL') }, 1500) }
      let force: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(terminate, timeout)
      this.abort.signal.addEventListener('abort', terminate, { once: true })
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 2_000_000) terminate() })
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-4096)
        const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(diagnostics)?.[1]
        if (job !== undefined && code !== undefined) job.code = code
      })
      let spawnError: Error | undefined
      child.on('error', (error: Error) => { spawnError = error })
      child.stdin.on('error', () => { /* Early process exit is reported by close. */ })
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
      child.once('close', (code) => {
        clearTimeout(timer); clearTimeout(force); this.abort.signal.removeEventListener('abort', terminate)
        if (spawnError !== undefined || code !== 0 || failed) {
          const missing = spawnError !== undefined && 'code' in spawnError && spawnError.code === 'ENOENT'
          const notFound = /HTTP 404/u.test(diagnostics)
          reject(new SiminFileError(missing ? 'githubNotInstalled' : notFound ? 'githubMissing' : 'githubFailed', 400))
        } else resolve(output)
      })
    })
    this.pending.add(promise)
    void promise.then(() => { this.pending.delete(promise) }, () => { this.pending.delete(promise) })
    return promise
  }
  private async api(path: string, method = 'GET', data?: unknown): Promise<unknown> {
    const output = await this.command(this.cli, ['api', '--hostname', 'github.com', path, '--method', method, ...(data === undefined ? [] : ['--input', '-'])], data)
    return output.trim() ? JSON.parse(output) as unknown : null
  }
  private async login(): Promise<string> {
    try {
      const user = await this.api('user') as { login?: unknown }
      if (typeof user.login === 'string' && /^[a-zA-Z0-9-]+$/u.test(user.login)) return user.login
    } catch (error) { if (error instanceof SiminFileError && error.code === 'githubNotInstalled') throw error }
    return fail('githubLoginRequired')
  }
  private start(run: (job: Job) => Promise<Record<string, string>>): Job {
    if (this.disposed) return fail('githubUnavailable')
    if ([...this.jobs.values()].some(job => job.status === 'running')) return fail('githubRunning')
    if (this.jobs.size >= 30) { const first = this.jobs.keys().next().value; if (first !== undefined) this.jobs.delete(first) }
    const job: Job = { id: randomUUID(), status: 'running' }
    this.jobs.set(job.id, job)
    const work = Promise.resolve().then(() => run(job)).then((result) => { job.result = result; job.status = 'done' }, (error: unknown) => { job.status = 'error'; job.error = error instanceof SiminFileError ? error.code : 'githubFailed' })
    this.pending.add(work); void work.finally(() => { this.pending.delete(work) })
    return { ...job }
  }
  /**
   * Read public data, account identity, repositories, or an operation status.
   * @param query - validated local query.
   * @returns JSON data without tokens.
   */
  async read(query: URLSearchParams): Promise<unknown> {
    if (this.disposed) return fail('githubUnavailable')
    const work = this.readInternal(query)
    this.pending.add(work)
    void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }
  private async readInternal(query: URLSearchParams): Promise<unknown> {
    const op = query.get('op')
    if (op === 'translate') {
      const repo = githubRepository(query.get('repo'))
      // Only public text already obtained from Trending may leave this owner; caller-supplied text is refused.
      const source = await this.readInternal(new URLSearchParams({ op: 'trending', period: query.get('period') ?? 'weekly', language: query.get('language') ?? '' })) as { items: TrendingRepository[] }
      const item = source.items.find(item => item.repo === repo)
      if (item === undefined) return fail('githubInvalidRepo')
      return { repo, translated: await this.translate(item.description) }
    }
    if (op === 'status') {
      try { await this.command(this.cli, ['--version']); return { installed: true, login: await this.login(), root: this.root } }
      catch (error) { return { installed: !(error instanceof SiminFileError && error.code === 'githubNotInstalled'), login: null, root: this.root } }
    }
    if (op === 'job') { const job = this.jobs.get(query.get('id') ?? ''); if (job === undefined) return fail('githubFailed'); return { ...job } }
    if (op === 'trending') {
      const period = query.get('period') ?? 'weekly', language = query.get('language') ?? ''
      if (!['daily', 'weekly', 'monthly'].includes(period) || !['', 'typescript', 'javascript', 'python', 'rust', 'go', 'swift'].includes(language)) return fail('githubInvalidRepo')
      const key = `${period}/${language}`, cached = this.cache.get(key)
      if (cached !== undefined && Date.now() - cached.time < 300_000) return { items: cached.items }
      const response = await fetch(`https://github.com/trending${language ? `/${language}` : ''}?since=${period}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]), headers: { accept: 'text/html' } })
      if (!response.ok) return fail('githubUnavailable')
      const html = await response.text()
      if (html.length > 4_000_000) return fail('githubUnavailable')
      const items = parseGithubTrending(html)
      if (!items.length && /Box-row/u.test(html)) return fail('githubUnavailable')
      this.cache.set(key, { time: Date.now(), items }); return { items }
    }
    const login = await this.login()
    if (op === 'repos') {
      const items: unknown[] = []
      for (let page = 1; page <= 10; page++) {
        const batch = await this.api(`user/repos?affiliation=owner&sort=updated&per_page=100&page=${page}`) as { full_name: string; default_branch: string; owner: { login: string } }[]
        items.push(...batch.filter(repo => repo.owner.login.toLowerCase() === login.toLowerCase())
          .map(repo => ({ repo: repo.full_name, branch: repo.default_branch })))
        if (batch.length < 100) break
      }
      return { items }
    }
    return fail('githubFailed')
  }
  private async owned(repo: string): Promise<void> {
    const login = await this.login()
    if (repo.split('/')[0]?.toLowerCase() !== login.toLowerCase()) return fail('githubInvalidRepo')
    await this.api(`repos/${repo}`)
  }
  private translate(description: string): Promise<string> {
    if (!description || !/[a-zA-Z]/u.test(description)) return Promise.resolve(description)
    const cached = this.translations.get(description)
    if (cached !== undefined) return Promise.resolve(cached)
    const pending = this.translating.get(description)
    if (pending !== undefined) return pending
    if (this.translating.size >= 6) return Promise.reject(new SiminFileError('githubTranslationError'))
    const work = (async () => {
      // MyMemory's public lookup API limits each UTF-8 segment to 500 bytes.
      const chunks: string[] = []; let current = ''
      for (const char of description) { if (Buffer.byteLength(current + char) > 480) { chunks.push(current); current = '' } current += char }
      if (current) chunks.push(current)
      if (chunks.length > 8) return fail('githubTranslationError')
      const translated: string[] = []
      for (const q of chunks) {
        const query = new URLSearchParams({ q, langpair: 'en|zh-CN' })
        const response = await fetch(`https://api.mymemory.translated.net/get?${query}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) })
        if (!response.ok) return fail('githubTranslationError')
        const data = await response.json() as {
          responseStatus?: unknown
          quotaFinished?: unknown
          responseData?: { translatedText?: unknown }
        }
        if (data.responseStatus !== 200 || data.quotaFinished === true || typeof data.responseData?.translatedText !== 'string' || data.responseData.translatedText.length > 10_000) return fail('githubTranslationError')
        translated.push(text(data.responseData.translatedText))
      }
      const result = translated.join('')
      if (this.translations.size >= 200) {
        const first = this.translations.keys().next().value
        if (first !== undefined) this.translations.delete(first)
      }
      this.translations.set(description, result)
      return result
    })().catch(() => fail('githubTranslationError'))
    this.translating.set(description, work)
    void work.then(() => { this.translating.delete(description) }, () => { this.translating.delete(description) })
    return work
  }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
    if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) return fail('githubInvalidRepo')
  }
  /**
   * Start a user-confirmed mutation. Remote import never overwrites an existing repository.
   * @param data - explicit operation and target.
   * @returns tracked job identity.
   */
  write(data: Record<string, unknown>): Job {
    if (data.op === 'login') return this.start(async (job) => { await this.command(this.cli, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], undefined, job, 900_000); return { login: await this.login() } })
    const repo = githubRepository(data.repo)
    if (data.op === 'clone') return this.start(async () => {
      const [owner, name] = repo.split('/') as [string, string]
      await this.directory(this.root); const parent = join(this.root, owner); await this.directory(parent)
      const path = join(parent, name)
      try { await lstat(path); return fail('githubExists') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      await this.command('git', ['clone', '--', `https://github.com/${repo}.git`, path], undefined, undefined, 600_000)
      return { path, url: `https://github.com/${repo}` }
    })
    if (data.op === 'fork' || data.op === 'copy') {
      const name = typeof data.name === 'string' ? data.name : ''
      githubRepository(`owner/${name}`)
      if (data.visibility !== 'public' && data.visibility !== 'private') return fail('githubInvalidRepo')
      return this.start(async (job) => {
        const target = `${await this.login()}/${name}`
        try { await this.api(`repos/${target}`); return fail('githubExists') } catch (error) { if (!(error instanceof SiminFileError && error.code === 'githubMissing')) throw error }
        if (data.op === 'fork') {
          await this.command(this.cli, ['repo', 'fork', repo, '--clone=false', '--fork-name', name])
          await this.api(`repos/${target}`)
        }
        else {
          const scratch = await mkdtemp(join(tmpdir(), 'dublin-import-'))
          try {
            const bare = join(scratch, 'source.git')
            await this.command('git', ['clone', '--bare', '--', `https://github.com/${repo}.git`, bare], undefined, undefined, 600_000)
            await this.command(this.cli, ['repo', 'create', target, data.visibility === 'private' ? '--private' : '--public'])
            job.result = { url: `https://github.com/${target}` }
            // The fresh target is never an existing repository; credentials are supplied by gh, not URL tokens.
            const credential = `credential.https://github.com.helper=!"${this.cli.replace(/["\\$`]/gu, '\\$&')}" auth git-credential`
            try {
              for (const refs of ['--all', '--tags']) await this.command('git', ['-c', 'credential.helper=', '-c', credential, '-C', bare, 'push', refs, `https://github.com/${target}.git`], undefined, undefined, 600_000)
            } catch { return fail('githubCopyIncomplete') }
          } finally { await rm(scratch, { recursive: true, force: true }) }
        }
        return { url: `https://github.com/${target}` }
      })
    }
    if (data.op === 'deploy') {
      const branch = typeof data.branch === 'string' ? data.branch : ''
      if (!branch || branch.length > 200 || /[\x00-\x20~^:?*\[\\]/u.test(branch) || branch.startsWith('-') || branch.includes('..') || !['/', '/docs'].includes(String(data.path))) return fail('githubInvalidRepo')
      return this.start(async () => {
        await this.owned(repo)
        const path = data.path as string, prefix = path === '/docs' ? 'docs/' : ''
        let staticEntry = false
        for (const entry of ['index.html', 'index.md']) {
          try { const file = await this.api(`repos/${repo}/contents/${prefix}${entry}?ref=${encodeURIComponent(branch)}`) as { type?: string }; staticEntry = file.type === 'file'; if (staticEntry) break }
          catch (error) { if (!(error instanceof SiminFileError && error.code === 'githubMissing')) throw error }
        }
        if (!staticEntry) return fail('githubNeedsStatic')
        let existing = false
        try { await this.api(`repos/${repo}/pages`); existing = true } catch (error) { if (!(error instanceof SiminFileError && error.code === 'githubMissing')) throw error }
        const result = await this.api(`repos/${repo}/pages`, existing ? 'PUT' : 'POST', { source: { branch, path }, ...(!existing ? { build_type: 'legacy' } : {}) }) as { html_url?: string } | null
        const url = result?.html_url ?? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1] === `${repo.split('/')[0]}.github.io` ? '' : `${repo.split('/')[1]}/`}`
        return { url, state: 'building' }
      })
    }
    return fail('githubFailed')
  }
  /** Abort and await every command/job before owner removal. @returns teardown completion. */
  async dispose(): Promise<void> {
    this.disposed = true; this.abort.abort()
    await Promise.allSettled([...this.pending])
    this.jobs.clear(); this.cache.clear(); this.translations.clear(); this.translating.clear()
  }
}
