/** GitHub owner validation, parsing, credential boundaries and awaited cancellation. */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DublinGithub, githubRepository, parseGithubTrending } from '../src/dublin-github.ts'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const owners: DublinGithub[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.mocked(spawn).mockReset()
})
const html = '<article class="Box-row"><h2><a href="/dublin/lab"> dublin / lab </a></h2><p>Build &amp; learn <script>ignored text</script></p><span itemprop="programmingLanguage">TypeScript</span><a href="/dublin/lab/stargazers"><svg></svg>1,234</a><span class="float-sm-right">42 stars this week</span></article>'
function owner(): DublinGithub { const value = new DublinGithub('/tmp/dublin-github-test', 'gh'); owners.push(value); return value }
function command(output = '', diagnostic = '', code = 0, stay = false): ChildProcess {
  const value = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => value.emit('close', null)); return true }) })
  if (!stay) queueMicrotask(() => { value.stdout.emit('data', Buffer.from(output)); value.stderr.emit('data', Buffer.from(diagnostic)); value.emit('close', code) })
  return value as unknown as ChildProcess
}
async function jobResult(service: DublinGithub, id: string): Promise<unknown> {
  let result: unknown
  await vi.waitFor(async () => { result = await service.read(new URLSearchParams({ op: 'job', id })); expect(result).not.toMatchObject({ status: 'running' }) })
  return result
}
it.each(['../../evil', 'a/..', '-x/y', 'owner/repo/extra', 'owner/repo;touch bad', 'https://github.com/a/b'])('rejects unsafe identity %s', (repo) => { expect(() => githubRepository(repo)).toThrow('githubInvalidRepo') })
it('extracts text-only ranked cards from official articles', () => {
  expect(parseGithubTrending(html)).toEqual([{ repo: 'dublin/lab', description: 'Build & learn ignored text', language: 'TypeScript', stars: '1,234', added: '42 stars this week' }])
  expect(parseGithubTrending('<article class="Box-row"><h2><a href="//evil/path">bad</a></h2></article>')).toEqual([])
})
it('uses weekly Trending and caches without requiring account credentials', async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(html)); vi.stubGlobal('fetch', fetcher)
  const service = owner(), query = new URLSearchParams({ op: 'trending' })
  expect(await service.read(query)).toMatchObject({ items: [{ repo: 'dublin/lab' }] })
  await service.read(query)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://github.com/trending?since=weekly')
  expect(spawn).not.toHaveBeenCalled()
})
it('translates only public Trending descriptions and reuses the translation cache', async () => {
  const fetcher = vi.fn(async (url: string) => url.startsWith('https://github.com/') ? new Response(html) : new Response(JSON.stringify({ responseStatus: 200, quotaFinished: false, responseData: { translatedText: '构建并学习' } })))
  vi.stubGlobal('fetch', fetcher)
  const service = owner(), query = new URLSearchParams({ op: 'translate', repo: 'dublin/lab' })
  expect(await service.read(query)).toEqual({ repo: 'dublin/lab', translated: '构建并学习' })
  expect(await service.read(query)).toEqual({ repo: 'dublin/lab', translated: '构建并学习' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  const url = new URL(fetcher.mock.calls[1]![0])
  expect(url.hostname).toBe('api.mymemory.translated.net'); expect(url.searchParams.get('q')).toBe('Build & learn ignored text')
  await expect(service.read(new URLSearchParams({ op: 'translate', repo: 'private/secrets', text: 'do not send' }))).rejects.toThrow('githubInvalidRepo')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('reports translation quota exhaustion instead of returning a fabricated description', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('https://github.com/') ? new Response(html) : new Response(JSON.stringify({ responseStatus: 403, quotaFinished: true, responseData: { translatedText: 'quota exceeded' } }))))
  await expect(owner().read(new URLSearchParams({ op: 'translate', repo: 'dublin/lab' }))).rejects.toThrow('githubTranslationError')
})
it('will not overwrite a repository already owned by the user', async () => {
  vi.mocked(spawn).mockImplementation((_program, args) => command(args?.includes('user') ? '{"login":"dublin"}' : '{}'))
  const service = owner(), job = service.write({ op: 'copy', repo: 'upstream/lab', name: 'lab', visibility: 'private' })
  expect(await jobResult(service, job.id)).toMatchObject({ status: 'error', error: 'githubExists' })
  expect(vi.mocked(spawn).mock.calls.every(([_program, args]) => !args?.includes('create') && !args?.includes('push'))).toBe(true)
})
it('does not publish a different account repository', async () => {
  vi.mocked(spawn).mockImplementation(() => command('{"login":"dublin"}'))
  const service = owner(), job = service.write({ op: 'deploy', repo: 'upstream/lab', branch: 'main', path: '/' })
  expect(await jobResult(service, job.id)).toMatchObject({ error: 'githubInvalidRepo' })
  expect(spawn).toHaveBeenCalledTimes(1)
})
it('requires a static entry before changing Pages settings', async () => {
  vi.mocked(spawn).mockImplementation((_program, args) => args?.includes('user') ? command('{"login":"dublin"}') : args?.some(arg => arg.includes('contents/')) ? command('', 'HTTP 404', 1) : command('{}'))
  const service = owner(), job = service.write({ op: 'deploy', repo: 'dublin/lab', branch: 'main', path: '/' })
  expect(await jobResult(service, job.id)).toMatchObject({ error: 'githubNeedsStatic' })
  expect(vi.mocked(spawn).mock.calls.every(([_program, args]) => !args?.includes('POST') && !args?.includes('PUT'))).toBe(true)
})
it('refuses a symlink clone root before spawning git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dublin-github-')); roots.push(root); await symlink(tmpdir(), join(root, 'redirect'))
  const service = new DublinGithub(join(root, 'redirect'), 'gh'); owners.push(service)
  const job = service.write({ op: 'clone', repo: 'upstream/lab' })
  expect(await jobResult(service, job.id)).toMatchObject({ error: 'githubInvalidRepo' })
  expect(spawn).not.toHaveBeenCalled()
})
it('awaits login process closure and never inherits model tokens', async () => {
  vi.stubEnv('MODEL_API_KEY', 'do-not-forward'); vi.stubEnv('GH_TOKEN', 'do-not-forward')
  const child = command('', '', 0, true); vi.mocked(spawn).mockReturnValue(child)
  const service = owner(); service.write({ op: 'login' }); await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce() })
  const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env
  expect(env?.MODEL_API_KEY).toBeUndefined(); expect(env?.GH_TOKEN).toBeUndefined()
  const kill = vi.spyOn(child, 'kill')
  await service.dispose(); expect(kill).toHaveBeenCalledWith('SIGTERM')
  expect(() => service.write({ op: 'login' })).toThrow('githubUnavailable')
})
