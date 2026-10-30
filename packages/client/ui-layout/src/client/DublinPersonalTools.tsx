/** Desktop personal tools stay mounted while their coordinated drawer is hidden. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DublinRecording, DublinToolsApi, RecordingSource, VaultCard } from '../dublin-tools.ts'
import { DublinRecorder, audioTime, type CaptureProgress } from './dublin-recorder.ts'
import { personalZh } from './personal-tools-locales.ts'
import { DublinVaultPanel } from './DublinVaultPanel.tsx'
import { DublinRecordingPanel } from './DublinRecordingPanel.tsx'
import { DublinToolMark, type DublinToolRequest } from './DublinNavigation.tsx'
import drawer from './DublinOrganizer.module.css'
import css from './DublinPersonalTools.module.css'

export type PersonalCopy = PropsLocale<'simin'>['t']
export function personalError(error: unknown, t: PersonalCopy): string {
  if (error instanceof Error) {
    const key = Object.keys(personalZh).find((key): key is keyof typeof personalZh => error.message.endsWith(key) && key in personalZh)
    if (key !== undefined) return t(key)
    if (error.name === 'NotAllowedError' || error.name === 'NotFoundError' || error.name === 'NotReadableError') return t('toolsCapturePermission')
  }
  return t('toolsOperationFailed')
}
/** Header entry points and a persistent capture owner; no project is required. */
export function DublinPersonalTools({ t, showEntries = true, showRecordingEntry = false, request, restoreFocus }: {
  t: PersonalCopy
  showEntries?: boolean
  showRecordingEntry?: boolean
  request?: DublinToolRequest | null
  restoreFocus?: () => void
}) {
  const api = (window as Window & { dublinTools?: DublinToolsApi }).dublinTools
  const [panel, setPanel] = useState<'recording' | 'vault' | null>(null)
  const [records, setRecords] = useState<DublinRecording[]>([]), [cards, setCards] = useState<VaultCard[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<CaptureProgress>({ phase: 'idle', duration: 0 })
  const [recorder] = useState(() => api === undefined ? undefined : new DublinRecorder(api, setProgress,
    (error) => { setError(personalError(error, t)) },
    (item) => { setRecords(current => [item, ...current.filter(row => row.id !== item.id)]); setSelected(item.id); setNotice(t('toolsSaved')) }))
  const entry = useRef<HTMLButtonElement>(null), vaultEntry = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const openedFromEntry = useRef(false)
  const id = useId()
  const report = (error: unknown): void => { setError(personalError(error, t)) }
  const update = (item: DublinRecording): void => {
    setRecords(current => [item, ...current.filter(row => row.id !== item.id)].sort((a, b) => b.createdAt - a.createdAt))
  }
  const refresh = async (next: 'recording' | 'vault'): Promise<void> => {
    if (api === undefined) return
    try {
      if (next === 'recording') setRecords(await api.run('recordings', null))
      else setCards(await api.run('vaultList', null))
    } catch (error) { report(error) }
  }
  const close = (): void => { if (!openedFromEntry.current && restoreFocus !== undefined) restoreFocus(); else (panel === 'vault' ? vaultEntry : entry).current?.focus(); setPanel(null) }
  const toggle = (next: 'recording' | 'vault'): void => {
    openedFromEntry.current = true
    setError(''); setNotice('')
    if (panel === next) close()
    else { setPanel(next); void refresh(next) }
  }
  useEffect(() => {
    if (panel !== null) { heading.current?.focus(); window.dispatchEvent(new CustomEvent('dublin-drawer-open', { detail: 'personal-tools' })) }
  }, [panel])
  useEffect(() => {
    const other = (event: Event): void => { if ((event as CustomEvent<string>).detail !== 'personal-tools') setPanel(null) }
    window.addEventListener('dublin-drawer-open', other)
    return () => { window.removeEventListener('dublin-drawer-open', other); void recorder?.stop() }
  }, [recorder])
  useEffect(() => {
    if (request?.tool !== 'recording' && request?.tool !== 'vault') return
    openedFromEntry.current = false
    setError(''); setNotice(''); setPanel(request.tool); void refresh(request.tool)
  }, [request])
  const active = progress.phase !== 'idle'
  const recordingLabel = t('toolsRecordingStatus', { state: t(progress.phase === 'starting' ? 'toolsStarting' : progress.phase === 'saving' ? 'toolsSaving' : progress.phase === 'paused' ? 'toolsPaused' : 'toolsRecording'), time: audioTime(progress.duration) })
  return <>
    {(showEntries || showRecordingEntry || active) && <button ref={entry} type="button" className={`${drawer.entry} ${active ? css.recordingEntry : ''}`} aria-expanded={panel === 'recording'}
      aria-controls={panel === 'recording' ? id : undefined} onClick={() => { toggle('recording') }}>
      <DublinToolMark kind="recording" />{active ? recordingLabel : t('toolsRecord')}</button>}
    {showEntries && <button ref={vaultEntry} type="button" className={drawer.entry} aria-expanded={panel === 'vault'} aria-controls={panel === 'vault' ? id : undefined}
      onClick={() => { toggle('vault') }}>{t('toolsVault')}</button>}
    {panel !== null && <aside id={id} role="region" aria-labelledby={`${id}-heading`} className={`${drawer.drawer} ${css.drawer}`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div className={drawer.heading}><div><p>{t('toolsLocal')}</p><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>{panel === 'recording' && <DublinToolMark kind="recording" large />}{t(panel === 'vault' ? 'toolsVault' : 'toolsRecord')}</h2></div>
        <button type="button" className={drawer.close} aria-label={t('close')} onClick={close}>×</button></div>
      {error && <p role="alert" className={css.error}>{error}</p>}
      {notice && <p role="status" className={css.notice}>{notice}</p>}
      {api === undefined ? <p className={drawer.hint}>{t('toolsDesktopOnly')}</p> : <>
        <Button variant="ghost" size="sm" className={css.refresh} onClick={() => { setError(''); void refresh(panel) }}>{t('refresh')}</Button>
        {panel === 'vault' ? <DublinVaultPanel t={t} api={api} cards={cards} update={setCards} report={report} notify={setNotice} />
          : <DublinRecordingPanel t={t} api={api} records={records} selected={selected} select={setSelected} update={update}
            remove={(id) => { setRecords(current => current.filter(item => item.id !== id)); if (selected === id) setSelected(null) }}
            progress={progress} start={(source: RecordingSource) => { setError(''); setNotice(''); void recorder?.start(source) }}
            pause={() => { recorder?.pause() }} stop={() => { void recorder?.stop() }} report={report} notify={setNotice} />}
      </>}
    </aside>}
  </>
}
