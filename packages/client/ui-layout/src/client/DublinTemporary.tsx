/** Temporary-session history projects the existing durable Session controller. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { saveSiminView, type SiminView } from './simin-state.ts'
import css from './SiminShell.module.css'

interface Item { id: string; title: string; updatedAt: number; running: boolean; blank: boolean }
/**
 * Restore selection only after the catalog confirms a retained identity.
 * @param view - navigation whose temporary identity survives restarts.
 * @returns catalog, connection status and explicit navigation gestures.
 */
export function useDublinTemporary(view: SiminView): {
  items: Item[]
  busy: boolean
  error: boolean
  ready: boolean
  request: (action: 'create' | 'open' | 'transfer' | 'list', sessionId?: string, project?: string) => void
} {
  const [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const requested = useRef<string | null>(null)
  const request = (action: 'create' | 'open' | 'transfer' | 'list', sessionId?: string, project?: string): void => {
    window.dispatchEvent(new CustomEvent('dublin-temporary-request', { detail: { action,
      ...(sessionId === undefined ? {} : { sessionId }), ...(project === undefined ? {} : { project }) } }))
  }
  useEffect(() => {
    const receive = (event: Event): void => {
      const data: unknown = (event as CustomEvent<unknown>).detail
      if (typeof data !== 'object' || data === null) return
      const value = data as Record<string, unknown>
      if (Array.isArray(value.items)) setItems(value.items.filter((item: unknown): item is Item => typeof item === 'object' && item !== null
        && 'id' in item && typeof item.id === 'string' && 'title' in item && typeof item.title === 'string'
        && 'updatedAt' in item && typeof item.updatedAt === 'number' && 'running' in item && typeof item.running === 'boolean'
        && 'blank' in item && typeof item.blank === 'boolean'))
      if (typeof value.busy === 'boolean') setBusy(value.busy)
      if (typeof value.error === 'boolean') { setError(value.error); if (value.error) requested.current = null }
      if (typeof value.selected === 'string') {
        setSelected(value.selected); requested.current = value.selected
        if (typeof value.project === 'string') saveSiminView({ project: value.project, file: null, page: 'project', tab: 'chat' })
        else saveSiminView({ project: null, file: null, page: 'temporary', tab: 'chat', temporarySessionId: value.selected })
      }
    }
    window.addEventListener('dublin-temporary-state', receive)
    request('list')
    return () => { window.removeEventListener('dublin-temporary-state', receive) }
  }, [])
  useEffect(() => {
    if (view.page !== 'temporary') { requested.current = null; setSelected(null); return }
    if (view.temporarySessionId === undefined || requested.current === view.temporarySessionId
      || !items.some(item => item.id === view.temporarySessionId) || busy) return
    requested.current = view.temporarySessionId
    request('open', view.temporarySessionId)
  }, [view.page, view.temporarySessionId, items, busy])
  return { items, busy, error, ready: selected === view.temporarySessionId && !busy && !error, request }
}

/**
 * Render recoverable temporary history without treating it as a project list.
 * @param props - retained chats, navigation callbacks and localized copy.
 * @returns the temporary history sidebar.
 */
export function TemporaryHistory({ state, selected, t }: {
  state: ReturnType<typeof useDublinTemporary>
  selected: string | undefined
  t: PropsLocale<'simin'>['t']
}) {
  return <><div className={css.groupLabel}>{t('temporaryHistory')}<span>{state.items.length}</span></div>
    {state.error && <p role="alert" className={css.notice}>{t('temporaryError')}
      <button type="button" onClick={() => { state.request('list') }}>{t('retry')}</button></p>}
    <div className={css.sideScroll}>{state.items.length === 0 && <p className={css.sideEmpty}>{t('temporaryEmpty')}</p>}
      {state.items.toSorted((a, b) => b.updatedAt - a.updatedAt).map(item => <button type="button" key={item.id}
        className={`${css.navItem} ${selected === item.id ? css.active : ''}`} disabled={state.busy}
        onClick={() => { state.request('open', item.id) }}>
        <span><strong>{item.title || t('temporaryUntitled')}</strong><small className={css.temporaryDate}>
          {new Date(item.updatedAt).toLocaleString()}{item.running ? ` · ${t('temporaryRunning')}` : ''}</small></span>
      </button>)}</div></>
}
