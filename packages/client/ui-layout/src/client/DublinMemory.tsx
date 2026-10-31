/** Local memory management never reads historical chat bodies until the user selects an operation. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { siminRequest } from './simin-api.ts'
import { siminZh, type SiminKey } from './simin-locales.ts'
import css from './DublinMemory.module.css'
type Copy = PropsLocale<'simin'>['t']
interface Item {
  id: string
  text: string
  kind: 'personal' | 'project' | 'event'
  status: 'active' | 'pending' | 'paused'
  project: string | null
  relatedIds?: string[]
  createdAt: number
  updatedAt: number
  source: {
    sessionId: string
    title: string
    from: number
    through: number
  } | null
}
interface Settings {
  enabled: boolean
  automatic: boolean
  cloud: boolean
  semantic: boolean
  embeddingUrl: string
  embeddingModel: string
  credentialRef: string
}
interface State {
  items: Item[]
  settings: Settings
  usage: {
    sessionId: string
    project: string | null
    at: number
    ids: string[]
  }[]
  jobs: {
    id: string
    title: string
    status: 'running' | 'done' | 'failed'
    error: string
  }[]
  semanticWarning?: string
}
const defaults: Settings = {
  enabled: true,
  automatic: false,
  cloud: false,
  semantic: false,
  embeddingUrl: '',
  embeddingModel: '',
  credentialRef: '',
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('memoryInvalid')
  return value as Record<string, unknown>
}
function parse(value: unknown): State {
  const raw = object(value), settings = object(raw.settings)
  if (!Array.isArray(raw.items) || !Array.isArray(raw.jobs) || !Array.isArray(raw.usage)
    || !['enabled', 'automatic', 'cloud', 'semantic'].every(key => typeof settings[key] === 'boolean')
    || !['embeddingUrl', 'embeddingModel', 'credentialRef'].every(key => typeof settings[key] === 'string')) throw Error('memoryInvalid')
  for (const entry of raw.items) {
    const x = object(entry)
    if (typeof x.id !== 'string' || typeof x.text !== 'string' || !['personal', 'project', 'event'].includes(String(x.kind))
      || !['active', 'pending', 'paused'].includes(String(x.status)) || !(x.project === null || typeof x.project === 'string')
      || typeof x.createdAt !== 'number' || typeof x.updatedAt !== 'number') throw Error('memoryInvalid')
    if (x.source !== null) {
      const s = object(x.source)
      if (typeof s.title !== 'string' || typeof s.sessionId !== 'string'
        || typeof s.from !== 'number' || typeof s.through !== 'number') throw Error('memoryInvalid')
    }
  }
  for (const entry of raw.usage) {
    const x = object(entry)
    if (typeof x.sessionId !== 'string' || typeof x.at !== 'number'
      || !(x.project === null || typeof x.project === 'string') || !Array.isArray(x.ids) || !x.ids.every(id => typeof id === 'string')) throw Error('memoryInvalid')
  }
  for (const entry of raw.jobs) {
    const x = object(entry)
    if (typeof x.id !== 'string' || typeof x.title !== 'string'
      || !['running', 'done', 'failed'].includes(String(x.status))) throw Error('memoryInvalid')
  }
  return {
    items: raw.items as Item[],
    settings: {
      enabled: settings.enabled === true,
      automatic: settings.automatic === true,

      cloud: settings.cloud === true,
      semantic: settings.semantic === true,
      embeddingUrl: String(settings.embeddingUrl),

      embeddingModel: String(settings.embeddingModel),
      credentialRef: String(settings.credentialRef),
    },

    usage: raw.usage as State['usage'],
    jobs: raw.jobs as State['jobs'],

    ...(typeof raw.semanticWarning === 'string' ? { semanticWarning: raw.semanticWarning } : {}),
  }
}
/** Decorative memory glyph, compatible with the sidebar's monochrome icons. */
export function MemoryIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4a3 3 0 0 0-5 3 4 4 0 0 0-1 7 3 3 0 0 0 6 5V4Zm6 0a3 3 0 0 1 5 3 4 4 0 0 1 1 7 3 3 0 0 1-6 5V4ZM5 9h4m6 0h4M5 15h4m6 0h4M9 6h6m-6 12h6" /></svg>
}
/**
 * Render reviewed facts, event diaries and cloud controls.
 * @param props - locale and available project names.
 * @returns local memory page.
 */
export function DublinMemory({ t, projects }: {
  t: Copy
  projects: string[]
}) {
  const [state, setState] = useState<State>({ items: [], settings: defaults, usage: [], jobs: [] })
  const [settings, setSettings] = useState(defaults), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [tab, setTab] = useState('personal'), [query, setQuery] = useState('')
  const [edit, setEdit] = useState<Partial<Item> | null>(null), [text, setText] = useState(''), [scope, setScope] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null), [source, setSource] = useState<string | null>(null)
  const [sessions, setSessions] = useState<{
      id: string
      title: string
    }[]>([]), [sessionId, setSessionId] = useState('')
  const [history, setHistory] = useState(false), [confirm, setConfirm] = useState(false)
  const active = useRef(true), working = useRef(false), revision = useRef(0), request = useRef<AbortController | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const label = (value: string | null): string => value === null ? t('memoryGlobal') : value.startsWith('@chat/') ? t('memoryPrivateChat') : value
  const report = (failure: unknown): void => {
    if (active.current) setError(failure instanceof Error ? failure.message : 'memoryUnavailable')
  }
  const refresh = async (initial = false): Promise<void> => {
    const version = ++revision.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const next = parse(await siminRequest('/aipm/memory', undefined, controller.signal))
      if (active.current && version === revision.current) {
        setState(next)
        if (initial) setSettings(next.settings)
        setLoading(false)
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        report(failure)
        setLoading(false)
      }
    }
  }
  useEffect(() => {
    active.current = true
    void refresh(true)
    const timer = window.setInterval(() => {
      if (!working.current) void refresh()
    }, 2500)
    return () => {
      active.current = false
      revision.current++
      request.current?.abort()
      window.clearInterval(timer)
    }
  }, [])
  const perform = async (payload: Record<string, unknown>, done?: (value: unknown) => void): Promise<void> => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError('')
    setNotice('')
    revision.current++
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const result = await siminRequest('/aipm/memory', payload, controller.signal)
      if (active.current) {
        done?.(result)
        await refresh()
      }
    } catch (failure) {
      if (!controller.signal.aborted) report(failure)
    }
    finally {
      working.current = false
      if (active.current) setBusy(false)
    }
  }
  const startEdit = (entry?: Item): void => {
    setEdit(entry ?? {})
    setText(entry?.text ?? '')
    setScope(entry?.project ?? '')
    setNotice('')
  }
  const save = (): void => {
    void perform({
      op: 'save',
      item: {
        ...edit,
        text,
        project: scope || null,
        kind: edit?.kind === 'event' ? 'event' : scope ? 'project' : 'personal',

        status: edit?.status ?? 'active',
        source: edit?.source ?? null,
      },
    }, () => {
      setEdit(null)
      setNotice(t('memorySaved'))
    })
  }
  const download = (value: unknown): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'Dublin-Lab-memory-backup.json'
    anchor.click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1000)
  }
  const openHistory = (): void => {
    setHistory(value => !value)
    if (!history) void perform({ op: 'sessions' }, (value) => {
      const raw = object(value)
      if (!Array.isArray(raw.items)) throw Error('memoryInvalid')
      const next = raw.items.map((x: unknown) => {
        const item = object(x)
        if (typeof item.id !== 'string' || typeof item.title !== 'string') throw Error('memoryInvalid')
        return {
          id: item.id,
          title: item.title,
        }
      })
      setSessions(next)
      setSessionId(next[0]?.id ?? '')
    })
  }
  const visible = state.items.filter(x => (tab === 'pending' ? x.status === 'pending' : x.kind === tab && x.status !== 'pending')
    && `${x.text} ${x.project ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return <div className={css.page}>
    <div className={css.header}><div><h1><MemoryIcon /> {t('memoryTitle')}</h1><p>{t('memorySubtitle')}</p></div>
      <div className={css.actions}><button onClick={() => {
        void refresh(true)
      }} disabled={busy}>{t('memoryRefresh')}</button>
      <button className={css.primary} onClick={() => {
        startEdit()
      }}>{t('memoryNew')}</button></div></div>
    <p className={css.privacy}>{t('memoryLocal')}</p>
    {error && <p role="alert" className={css.error}>{t((error in siminZh ? error : 'memoryUnavailable') as SiminKey)}</p>}
    {notice && <p role="status" className={css.hint}>{notice}</p>}
    {state.semanticWarning && <p role="status" className={css.hint}>{t('memorySemanticUnavailable')}</p>}
    <div className={css.filters}><div className={css.tabs} role="tablist" aria-label={t('memoryTitle')}>
      {(['personal', 'project', 'event', 'pending'] as const).map(key => <button role="tab" key={key} aria-selected={tab === key} onClick={() => {
        setTab(key)
      }}>
        {t(key === 'personal' ? 'memoryPersonal' : key === 'project' ? 'memoryProject' : key === 'event' ? 'memoryEvents' : 'memoryPending')}
        {' '}{state.items.filter(x => key === 'pending' ? x.status === 'pending' : x.kind === key && x.status !== 'pending').length}</button>)}</div>
    <input aria-label={t('memorySearch')} placeholder={t('memorySearch')} value={query} onChange={(event) => {
      setQuery(event.target.value)
    }} /></div>
    {edit !== null && <section className={css.editor} aria-label={t('memoryEdit')}>
      <label>{t('memoryText')}<textarea value={text} maxLength={12000} onChange={(event) => {
        setText(event.target.value)
      }} /></label>
      <label>{t('memoryScope')}<select value={scope} onChange={(event) => {
        setScope(event.target.value)
      }}>
        <option value="">{t('memoryGlobal')}</option>{scope.startsWith('@chat/') && <option value={scope}>{t('memoryPrivateChat')}</option>}
        {projects.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <div className={css.actions}><button className={css.primary} disabled={busy || !text.trim()} onClick={save}>{t('memorySave')}</button>
        <button disabled={busy} onClick={() => {
          setEdit(null)
        }}>{t('memoryCancel')}</button></div>
    </section>}
    {loading ? <p className={css.empty}>{t('memoryLoading')}</p> : visible.length === 0 && !error ? <p className={css.empty}>{t('memoryEmpty')}</p>
      : <div className={css.grid}>{visible.map(entry => <article className={css.card} key={entry.id}>
        <header><span>{label(entry.project)}</span><span>{t(entry.status === 'active' ? 'memoryActive' : entry.status === 'paused' ? 'memoryPaused' : 'memoryReview')}</span></header>
        <p className={css.body}>{entry.text}</p><small className={css.hint}>{new Date(entry.updatedAt).toLocaleString()}</small>
        <footer><button disabled={busy} onClick={() => {
          if (!entry.source && !entry.relatedIds?.length) {
            setSource(t('memorySourceNo'))
            return
          }
          void perform({
            op: 'source',
            id: entry.id,
          }, (value) => {
            const raw = object(value)
            if (typeof raw.text !== 'string') throw Error('memoryInvalid')
            setSource(raw.text)
          })
        }}>{entry.source || entry.relatedIds?.length ? t('memorySource') : t('memoryManual')}</button><div className={css.actions}>
          <button onClick={() => {
            startEdit(entry)
          }} disabled={busy}>{t('memoryEdit')}</button>
          <button disabled={busy} onClick={() => {
            void perform({
              op: 'save',
              item: {
                ...entry,
                status: entry.status === 'active' ? 'paused' : 'active',
              },
            })
          }}>
            {t(entry.status === 'pending' ? 'memoryApprove' : entry.status === 'active' ? 'memoryPause' : 'memoryResume')}</button>
          <button disabled={busy} onClick={() => {
            setDeleting(entry.id)
          }}>{t('memoryDelete')}</button></div></footer>
        {deleting === entry.id && <div role="alert"><p className={css.hint}>{t('memoryDeleteConfirm')}</p><div className={css.actions}>
          <button disabled={busy} onClick={() => {
            void perform({
              op: 'delete',
              id: entry.id,
            }, () => {
              setDeleting(null)
            })
          }}>{t('memoryDelete')}</button>
          <button onClick={() => {
            setDeleting(null)
          }}>{t('memoryCancel')}</button></div></div>}
      </article>)}</div>}
    {source !== null && <section className={css.source}><h2>{t('memorySourceTitle')}</h2><pre>{source}</pre>
      <button onClick={() => {
        setSource(null)
      }}>{t('close')}</button></section>}
    <details className={css.settings}><summary>{t('memorySettings')}</summary>
      {(['enabled', 'cloud', 'automatic'] as const).map(key => <label className={css.toggle} key={key}><input type="checkbox" checked={settings[key]}
        disabled={busy || key === 'automatic' && !settings.cloud} onChange={(event) => {
          setSettings({
            ...settings,
            [key]: event.target.checked,

            ...(key === 'cloud' && !event.target.checked ? { automatic: false, semantic: false } : {}),
          })
        }} />
      {t(key === 'enabled' ? 'memoryEnabled' : key === 'cloud' ? 'memoryCloud' : 'memoryAutomatic')}</label>)}
      <p className={css.hint}>{t('memoryConsent')}</p>
      <details className={css.settings}><summary>{t('memorySemantic')}</summary><p className={css.hint}>{t('memorySemanticHint')}</p>
        <label className={css.toggle}><input type="checkbox" checked={settings.semantic} disabled={!settings.cloud || busy}
          onChange={(event) => {
            setSettings({
              ...settings,
              semantic: event.target.checked,
            })
          }} />{t('memorySemantic')}</label>
        {(['embeddingUrl', 'embeddingModel', 'credentialRef'] as const).map(key => <label className={css.field} key={key}>
          {t(key === 'embeddingUrl' ? 'memoryEndpoint' : key === 'embeddingModel' ? 'memoryModel' : 'memoryCredential')}
          <input value={settings[key]} onChange={(event) => {
            setSettings({
              ...settings,
              [key]: event.target.value,
            })
          }} maxLength={1000} /></label>)}
        <p className={css.hint}>{t('memoryCredentialHint')}</p></details>
      <button className={css.primary} disabled={busy} onClick={() => {
        void perform({
          op: 'settings',
          settings,
        }, () => {
          setNotice(t('memorySettingsSaved'))
        })
      }}>{t('memorySaveSettings')}</button>
    </details>
    <section className={css.audit}><div className={css.actions}><button onClick={openHistory} disabled={busy}>{t('memoryImportHistory')}</button>
      <button disabled={busy} onClick={() => {
        void perform({ op: 'export' }, download)
      }}>{t('memoryExport')}</button>
      <button disabled={busy} onClick={() => {
        file.current?.click()
      }}>{t('memoryImport')}</button></div><p className={css.hint}>{t('memoryBackupHint')}</p>
    <input ref={file} type="file" hidden accept=".json,application/json" onChange={(event) => {
      const selected = event.target.files?.[0]
      event.target.value = ''
      if (!selected) return
      if (selected.size > 100_000_000) {
        setError('memoryLimit')
        return
      }
      if (!window.confirm(t('memoryImportBackupConfirm'))) return
      void selected.text().then((text) => {
        const backup: unknown = JSON.parse(text)
        return perform({
          op: 'import',
          backup,
        }, () => {
          setNotice(t('memoryImportComplete'))
        })
      }).catch (report)
    }} />
    {history && <section className={css.editor}><p className={css.hint}>{t('memoryHistoryHint')}</p>
      <label>{t('memorySessions')}<select value={sessionId} onChange={(event) => {
        setSessionId(event.target.value)
        setConfirm(false)
      }}>
        {sessions.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      {!confirm ? <button disabled={busy || !sessionId || !state.settings.cloud} onClick={() => {
        setConfirm(true)
      }}>{t('memoryExtract')}</button>
        : <div><p className={css.hint}>{t('memoryImportConfirm')}</p><button disabled={busy} onClick={() => {
          void perform({
            op: 'extract',
            sessionId,
          }, () => {
            setConfirm(false)
          })
        }}>{t('memoryExtract')}</button>
        <button onClick={() => {
          setConfirm(false)
        }}>{t('memoryCancel')}</button></div>}</section>}
    {state.jobs.length > 0 && <><h2>{t('memoryJobs')}</h2><ul>{state.jobs.map(job => <li key={job.id}>{job.title} · {t(job.status === 'running' ? 'memoryRunning' : job.status === 'done' ? 'memoryDone' : 'memoryFailed')}</li>)}</ul></>}
    </section>
    <section className={css.audit}><h2>{t('memoryUsage')}</h2><p className={css.hint}>{t('memoryUsageHint')}</p>
      {state.usage.length === 0 ? <p className={css.hint}>{t('memoryUsageEmpty')}</p> : <ul>{state.usage.slice(0, 8).map((use, index) => <li key={`${use.at}-${index}`}>
        {new Date(use.at).toLocaleString()} · {label(use.project)} · {use.ids.length === 0 ? t('memoryNoHits') : use.ids.map(id => state.items.find(x => x.id === id)?.text.slice(0, 65) ?? id).join('；')}</li>)}</ul>}
    </section>
  </div>
}
