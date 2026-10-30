/** Bridge unbound chat gestures to durable Host Sessions and the existing main selection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Own temporary-chat requests, catalog polling and selected-session adoption.
 * @param ctx - existing pure Session controller and workspace navigation.
 */
export function installDublinTemporaryNavigation(ctx: Context): void {
  ctx.effect(() => {
    const lifetime = new AbortController()
    let busy = false, navigation = 0, revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = async (payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetch('/aipm/temporary', { signal: lifetime.signal,
        ...(payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) })
      const value: unknown = await response.json()
      if (!response.ok || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('temporaryUnavailable')
      return value as Record<string, unknown>
    }
    const publish = (detail: Record<string, unknown>): void => {
      if (!lifetime.signal.aborted) window.dispatchEvent(new CustomEvent('dublin-temporary-state', { detail: { busy, ...detail } }))
    }
    const refresh = async (): Promise<void> => {
      const serial = ++revision
      try {
        const data = await request()
        if (!Array.isArray(data.sessions)) throw new Error('temporaryInvalid')
        await ctx.sessions.refresh()
        if (lifetime.signal.aborted || serial !== revision) return
        const state = ctx.sessions.list.getSnapshot()
        const items = data.sessions.flatMap((value: unknown) => {
          if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') return []
          const row = state.byId[SessionId(value.sessionId)]
          return row === undefined ? [] : [{ id: row.id, title: row.title ?? '', updatedAt: row.updatedAt, running: row.running, blank: row.blank }]
        })
        publish({ items, error: false })
      } catch (_error) { publish({ error: true }) }
    }
    const act = (event: Event): void => {
      const value: unknown = (event as CustomEvent<unknown>).detail
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const data = value as Record<string, unknown>
      if (!['create', 'open', 'transfer', 'list'].includes(String(data.action))) return
      if (data.action === 'list') { void refresh(); return }
      if (busy) return
      busy = true; publish({ error: false })
      const token = ++navigation
      void (async () => {
        try {
          const result = await request(data)
          if (typeof result.sessionId !== 'string') throw new Error('temporaryInvalid')
          await ctx.sessions.refresh()
          if (lifetime.signal.aborted || token !== navigation) return
          ctx.uiWorkspace.openSession(SessionId(result.sessionId))
          if (typeof result.path === 'string') {
            const saved: unknown = JSON.parse(localStorage.getItem('aipm.simin.sessions.v1') ?? '{}')
            const mapping = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved : {}
            localStorage.setItem('aipm.simin.sessions.v1', JSON.stringify({ ...mapping, [result.path]: result.sessionId }))
          }
          busy = false
          publish({ selected: result.sessionId, project: result.project, error: false })
          await refresh()
        } catch (_error) { busy = false; publish({ error: true }) }
      })()
    }
    const poll = async (): Promise<void> => {
      await refresh()
      if (!lifetime.signal.aborted) timer = setTimeout(() => { void poll() }, 5000)
    }
    window.addEventListener('dublin-temporary-request', act)
    void poll()
    return () => {
      lifetime.abort(); navigation++; revision++; clearTimeout(timer)
      window.removeEventListener('dublin-temporary-request', act)
    }
  }, 'Dublin: temporary conversation navigation')
}
