/** Public Trending browser and explicit GitHub import/publishing dialogs. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { siminRequest } from './simin-api.ts'
import { siminZh, type SiminKey } from './simin-locales.ts'
import css from './Dublin.module.css'
type Copy = PropsLocale<'simin'>['t']
type Period = 'daily' | 'weekly' | 'monthly'
interface Repo { repo: string; description: string; language: string; stars: string; added: string }
interface Account { installed: boolean; login: string | null; root: string }
interface Job { id: string; status: 'running' | 'done' | 'error'; code?: string; error?: string; result?: Record<string, string> }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('githubFailed')
  return value as Record<string, unknown>
}
function string(value: unknown): string { if (typeof value !== 'string') throw new Error('githubFailed'); return value }
function slug(value: unknown): string { const repo = string(value); if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error('githubFailed'); return repo }
function items(value: unknown): unknown[] { const data = object(value); if (!Array.isArray(data.items)) throw new Error('githubFailed'); return data.items }
function active(controller: AbortController): boolean { return !controller.signal.aborted }
function parseJob(value: unknown): Job {
  const data = object(value), status = data.status
  if (status !== 'running' && status !== 'done' && status !== 'error') throw new Error('githubFailed')
  const result = data.result === undefined ? undefined
    : Object.fromEntries(Object.entries(object(data.result)).map(([key, value]) => [key, string(value)]))
  return { id: string(data.id), status, ...(typeof data.code === 'string' ? { code: data.code } : {}), ...(typeof data.error === 'string' ? { error: data.error } : {}), ...(result === undefined ? {} : { result }) }
}
function errorKey(error: unknown): SiminKey { const key = error instanceof Error ? error.message : String(error); return key.startsWith('github') && key in siminZh ? key as SiminKey : 'githubFailed' }
function resultUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && (url.hostname === 'github.com' || /^[a-zA-Z0-9-]+\.github\.io$/u.test(url.hostname)) ? url.href : undefined } catch { return undefined }
}
function savedJob(): string | null { try { return sessionStorage.getItem('dublin.github.job') } catch { return null } }
/** GitHub mark within the existing navigation icon system. @returns decorative repository navigation glyph. */
export function GithubIcon() { return <svg className={css.repoIcon} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.18-3.37-1.18-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.58c0 .27.18.58.69.48A10 10 0 0 0 12 2z" /></svg> }
/** Render weekly-first Trending and authenticated actions. @param props - workbench dictionary. @returns repository explorer. */
export function DublinGithub({ t }: { t: Copy }) {
  const [period, setPeriod] = useState<Period>('weekly'), [language, setLanguage] = useState('')
  const [repos, setRepos] = useState<Repo[]>([]), [loading, setLoading] = useState(true)
  const [error, setError] = useState<SiminKey | null>(null)
  const [account, setAccount] = useState<Account | null>(null), [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<{ kind: 'clone' | 'import' | 'deploy'; repo: string } | null>(null)
  const [mode, setMode] = useState<'fork' | 'copy'>('fork'), [name, setName] = useState(''), [visibility, setVisibility] = useState('public')
  const [owned, setOwned] = useState<{ repo: string; branch: string }[]>([]), [branch, setBranch] = useState('main'), [path, setPath] = useState('/')
  const [jobId, setJobId] = useState(savedJob), [job, setJob] = useState<Job | null>(null), [busy, setBusy] = useState(false)
  const [translate, setTranslate] = useState(false)
  const [translations, setTranslations] = useState<Partial<Record<string, string | null>>>({})
  useEffect(() => {
    setTranslations({})
    if (!translate || loading) return
    const abort = new AbortController(), source = repos.filter(repo => repo.description)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (active(abort)) {
        const item = source.at(cursor++); if (item === undefined) return
        try {
          const query = new URLSearchParams({ op: 'translate', repo: item.repo, period, language })
          const data = object(await siminRequest(`/aipm/github?${query}`, undefined, abort.signal))
          if (data.repo !== item.repo) throw new Error('githubTranslationError')
          const result = string(data.translated)
          if (active(abort)) setTranslations(previous => ({ ...previous, [item.repo]: result }))
        } catch { if (active(abort)) setTranslations(previous => ({ ...previous, [item.repo]: null })) }
      }
    }
    void Promise.all([worker(), worker(), worker()])
    return () => { abort.abort() }
  }, [translate, repos, period, language, loading])
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(null)
    void siminRequest(`/aipm/github?op=trending&period=${period}&language=${language}`, undefined, abort.signal).then((value) => {
      const next = items(value).map((value) => {
        const data = object(value)
        return { repo: slug(data.repo), description: string(data.description), language: string(data.language),
          stars: string(data.stars), added: string(data.added) }
      })
      if (!abort.signal.aborted) setRepos(next)
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) { setRepos([]); setError(errorKey(error)) }
    }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [period, language, refresh])
  useEffect(() => {
    const abort = new AbortController()
    void siminRequest('/aipm/github?op=status', undefined, abort.signal).then((value) => {
      const data = object(value); if (typeof data.installed !== 'boolean' || (data.login !== null && typeof data.login !== 'string')) throw new Error('githubFailed')
      if (!abort.signal.aborted) setAccount({ installed: data.installed, login: data.login, root: string(data.root) })
    }).catch((error: unknown) => { if (!abort.signal.aborted) setError(errorKey(error)) })
    return () => { abort.abort() }
  }, [refresh])
  useEffect(() => {
    if (jobId === null) return
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = parseJob(await siminRequest(`/aipm/github?op=job&id=${encodeURIComponent(jobId)}`, undefined, abort.signal))
        if (abort.signal.aborted) return
        setJob(next)
        if (next.status === 'running') timer = setTimeout(() => { void poll() }, 1500)
        else { setJobId(null); try { sessionStorage.removeItem('dublin.github.job') } catch { /* Optional tab-local recovery. */ } setRefresh(value => value + 1) }
      } catch (error) { if (!abort.signal.aborted) { setError(errorKey(error)); setJobId(null) } }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [jobId])
  useEffect(() => {
    if (dialog?.kind !== 'deploy') return
    const abort = new AbortController(); setBusy(true); setError(null)
    void siminRequest('/aipm/github?op=repos', undefined, abort.signal).then((value) => {
      const next = items(value).map((value) => {
        const data = object(value)
        return { repo: slug(data.repo), branch: string(data.branch) }
      })
      if (!abort.signal.aborted) { setOwned(next); const first = next[0]; if (first !== undefined) { setDialog({ kind: 'deploy', repo: first.repo }); setBranch(first.branch) } }
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setError(errorKey(error))
    }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => { abort.abort() }
  }, [dialog?.kind])
  const start = async (data: Record<string, unknown>): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const next = parseJob(await siminRequest('/aipm/github', data)); setJob(next); setJobId(next.id); setDialog(null)
      try { sessionStorage.setItem('dublin.github.job', next.id) } catch { /* Jobs still run without tab recovery. */ }
    } catch (error) { setError(errorKey(error)) } finally { setBusy(false) }
  }
  const pending = busy || jobId !== null
  const open = (kind: 'clone' | 'import' | 'deploy', repo = ''): void => { setError(null); setName(repo.split('/')[1] ?? ''); setMode('fork'); setOwned([]); setPath('/'); setDialog({ kind, repo }) }
  const url = resultUrl(job?.result?.url)
  return <div className={css.githubPage}>
    <div className={css.githubHeading}><div><h1>{t('githubTitle')}</h1><p>{t('githubHint')}</p></div><div className={css.actionRow}>
      {account?.login ? <span>{t('githubConnected', { login: account.login })}</span> : <button className={css.secondary} disabled={pending || account?.installed === false} onClick={() => { void start({ op: 'login' }) }}><GithubIcon />{t('githubConnect')}</button>}
      <button className={css.solid} disabled={pending || !account?.login} onClick={() => { open('deploy') }}>{t('githubDeploy')}</button>
    </div></div>
    {account?.installed === false && <div className={css.status}>{t('githubNotInstalled')} <a href="https://cli.github.com/" target="_blank" rel="noreferrer">{t('githubCliInstall')}</a></div>}
    {job !== null && <div className={css.status} role="status">{t(job.status === 'running' ? 'githubRunning' : job.status === 'done' ? job.result?.state === 'building' ? 'githubPagesBuilding' : 'githubDone' : errorKey(new Error(job.error)))}
      {job.code !== undefined && job.status === 'running' && <><p>{t('githubLoginHint')}</p><code>{job.code}</code><a className={css.secondary} href="https://github.com/login/device" target="_blank" rel="noreferrer">{t('githubLoginOpen')}</a></>}
      {job.result?.path !== undefined && <code>{job.result.path}</code>}{url !== undefined && <div className={css.actionRow}><a className={css.secondary} href={url} target="_blank" rel="noreferrer">{t(job.result?.state === 'building' ? 'githubWebsite' : 'githubOpenResult')}</a></div>}
    </div>}
    {error !== null && <p className={css.error} role="alert">{t(error)} <button className={css.quiet} onClick={() => { setRefresh(value => value + 1) }}>{t('retry')}</button></p>}
    <div className={css.filters}><div className={css.periods}>{(['daily', 'weekly', 'monthly'] as const).map(value => <button key={value} aria-pressed={period === value} onClick={() => { setPeriod(value) }}>{t(value === 'daily' ? 'githubDaily' : value === 'weekly' ? 'githubWeekly' : 'githubMonthly')}</button>)}</div>
      <div className={css.actionRow}><button className={css.secondary} aria-pressed={translate} onClick={() => { setTranslate(value => !value) }}>{t('githubTranslate')}{translate ? ' ✓' : ''}</button><select aria-label={t('githubLanguage')} value={language} onChange={(event) => { setLanguage(event.target.value) }}><option value="">{t('githubAllLanguages')}</option>{['TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Swift'].map(value => <option key={value} value={value.toLowerCase()}>{value}</option>)}</select></div>
    </div>
    <p className={css.translationNotice}>{t('githubTranslationNotice')}</p>
    {loading ? <p className={css.loading}>{t('githubLoading')}</p> : repos.length === 0 && error === null ? <p className={css.loading}>{t('githubNoResults')}</p> : <div className={css.repoList}>{repos.map((repo, index) => <article key={repo.repo} className={css.repoCard}><span className={css.rank}>{String(index + 1).padStart(2, '0')}</span><div>
      <h2><a href={`https://github.com/${repo.repo}`} target="_blank" rel="noreferrer">{repo.repo}</a></h2><small className={css.purposeLabel}>{t('githubPurpose')}</small><p>{(translate ? translations[repo.repo] : undefined) ?? (repo.description || t('githubNoDescription'))}</p>
      {translate && repo.description && <>{translations[repo.repo] === undefined ? <small className={css.translationState}>{t('githubTranslating')}</small> : translations[repo.repo] === null ? <small className={css.translationState}>{t('githubTranslationError')}</small> : <details className={css.original}><summary>{t('githubOriginal')}</summary><p>{repo.description}</p></details>}</>}
      <div className={css.repoMeta}>{repo.language && <span><i className={css.languageDot} />{repo.language}</span>}<span>☆ {repo.stars} {t('githubStars')}</span>{repo.added && <span>↗ {repo.added}</span>}</div>
      <div className={css.actionRow}><button className={css.secondary} disabled={pending} onClick={() => { open('clone', repo.repo) }}>{t('githubClone')}</button><button className={css.secondary} disabled={pending || !account?.login} onClick={() => { open('import', repo.repo) }}>{t('githubImport')}</button><a className={css.quiet} href={`https://github.com/${repo.repo}`} target="_blank" rel="noreferrer">{t('githubVisit')} ↗</a></div>
    </div></article>)}</div>}
    <Modal open={dialog !== null} onClose={() => { if (!busy) setDialog(null) }} title={t(dialog?.kind === 'clone' ? 'githubClone' : dialog?.kind === 'deploy' ? 'githubDeploy' : 'githubImport')} closeLabel={t('close')} className={css.githubDialog ?? ''} footer={<div className={css.actionRow}><button className={css.quiet} disabled={busy} onClick={() => { setDialog(null) }}>{t('cancel')}</button><button className={css.solid} disabled={pending || (dialog?.kind === 'deploy' && !dialog.repo)} onClick={() => { if (dialog !== null) void start({ op: dialog.kind === 'import' ? mode : dialog.kind, repo: dialog.repo, name, visibility, branch, path }) }}>{t(dialog?.kind === 'deploy' ? 'githubDeployConfirm' : dialog?.kind === 'clone' ? 'githubClone' : 'githubImportConfirm')}</button></div>}>
      {dialog?.kind === 'clone' && <><p className={css.dialogHint}>{t('githubCloneHint')}</p><code>{account?.root}/{dialog.repo}</code></>}
      {dialog?.kind === 'import' && <><p className={css.dialogHint}>{dialog.repo}</p><div className={css.choice}>{(['fork', 'copy'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value) }}><strong>{t(value === 'fork' ? 'githubFork' : 'githubCopy')}</strong><small>{t(value === 'fork' ? 'githubForkHint' : 'githubCopyHint')}</small></button>)}</div><label className={css.field}>{t('githubRepoName')}<input value={name} onChange={(event) => { setName(event.target.value) }} /></label>{mode === 'copy' && <label className={css.field}>{t('githubVisibility')}<select value={visibility} onChange={(event) => { setVisibility(event.target.value) }}><option value="public">{t('githubPublic')}</option><option value="private">{t('githubPrivate')}</option></select></label>}</>}
      {dialog?.kind === 'deploy' && <><p className={css.dialogHint}>{t('githubDeployHint')}</p><label className={css.field}>{t('githubRepositories')}<select value={dialog.repo} disabled={busy} onChange={(event) => { const repo = event.target.value; setDialog({ kind: 'deploy', repo }); setBranch(owned.find(item => item.repo === repo)?.branch ?? 'main') }}><option value="">{t('githubRepositories')}</option>{owned.map(repo => <option key={repo.repo}>{repo.repo}</option>)}</select></label>{!busy && owned.length === 0 && <p className={css.dialogHint}>{t('githubNoRepositories')}</p>}<label className={css.field}>{t('githubBranch')}<input value={branch} onChange={(event) => { setBranch(event.target.value) }} /></label><label className={css.field}>{t('githubSource')}<select value={path} onChange={(event) => { setPath(event.target.value) }}><option value="/">{t('githubRoot')}</option><option value="/docs">{t('githubDocs')}</option></select></label><p className={css.status}>{t('githubDeployNotice')}</p></>}
      {error !== null && <p className={css.error} role="alert">{t(error)}</p>}
    </Modal>
  </div>
}
