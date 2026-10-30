/** Capture, seekable playback, explicit transcription and reviewed AI notes/actions. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DublinRecording, DublinToolsApi, RecordingSource, SummaryKind, TranscriptionSettings } from '../dublin-tools.ts'
import { useDublinOrganizer } from './dublin-organizer.ts'
import { audioTime, type CaptureProgress } from './dublin-recorder.ts'
import type { PersonalCopy } from './DublinPersonalTools.tsx'
import css from './DublinPersonalTools.module.css'

function speakerName(speaker: string, t: PersonalCopy): string {
  return speaker === '?' ? t('toolsUnknownSpeaker') : t('toolsSpeaker', { speaker: /^\d+$/u.test(speaker) ? Number(speaker) + 1 : speaker })
}
const summaryLabels = { idea: 'toolsIdea', meeting: 'toolsMeeting', actions: 'toolsActions' } as const
export function DublinRecordingPanel({ t, api, records, selected, select, update, remove, progress, start, pause, stop, report, notify }: {
  t: PersonalCopy
  api: DublinToolsApi
  records: DublinRecording[]
  selected: string | null
  select: (id: string | null) => void
  update: (item: DublinRecording) => void
  remove: (id: string) => void
  progress: CaptureProgress
  start: (source: RecordingSource) => void
  pause: () => void
  stop: () => void
  report: (error: unknown) => void
  notify: (text: string) => void
}) {
  const [source, setSource] = useState<RecordingSource>('microphone'), [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<'transcribe' | 'delete' | null>(null)
  const [title, setTitle] = useState(''), [audioUrl, setAudioUrl] = useState('')
  const audio = useRef<HTMLAudioElement>(null), seek = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const selectedRef = useRef(selected); selectedRef.current = selected
  const organizer = useDublinOrganizer(), id = useId()
  const item = records.find(item => item.id === selected)
  const capturing = progress.phase !== 'idle'
  useEffect(() => { setTitle(item?.title ?? ''); setConfirm(null); setAudioUrl(''); seek.current = null }, [selected])
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])
  const perform = async (name: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(name)
    try { await action() } catch (error) { report(error) } finally { setBusy('') }
  }
  const load = async (time: number): Promise<void> => {
    if (item === undefined) return
    seek.current = time
    if (audioUrl && audio.current !== null) {
      audio.current.currentTime = time; await audio.current.play(); seek.current = null; return
    }
    await perform('loading', async () => {
      const bytes = await api.run('recordingRead', { id: item.id })
      if (alive.current && selectedRef.current === item.id) setAudioUrl(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })))
    })
  }
  const alreadyAdded = (text: string): boolean => organizer.items.some(item => item.kind === 'todo' && item.text === text)
  return <>
    <p className={css.hint}>{t('toolsRecordingPrivacy')}</p>
    <section className={css.capture}>
      <label htmlFor={`${id}-source`}>{t('toolsSource')}</label>
      <select id={`${id}-source`} disabled={capturing} value={capturing ? progress.source ?? source : source} onChange={(event) => { setSource(event.target.value === 'mixed' ? 'mixed' : 'microphone') }}>
        <option value="microphone">{t('toolsMicrophone')}</option><option value="mixed">{t('toolsMixed')}</option></select>
      <div className={css.timer} role="status"><span className={capturing ? css.dot : css.idleDot} aria-hidden="true" />{audioTime(progress.duration)}
        <small>{progress.phase === 'starting' ? t('toolsStarting') : progress.phase === 'saving' ? t('toolsSaving') : progress.phase === 'paused' ? t('toolsPaused') : capturing ? t('toolsRecording') : t('toolsLocal')}</small></div>
      <div className={css.actions}>{capturing ? <>
        <Button variant="outline" disabled={progress.phase !== 'recording' && progress.phase !== 'paused'} onClick={pause}>{t(progress.phase === 'paused' ? 'toolsResume' : 'toolsPause')}</Button>
        <Button variant="primary" className={css.primary} disabled={progress.phase === 'starting' || progress.phase === 'saving'} onClick={stop}>{t('toolsStop')}</Button>
      </> : <Button variant="primary" className={css.primary} onClick={() => { start(source) }}>{t('toolsStart')}</Button>}</div>
      <p className={css.hint}>{t(capturing ? 'toolsRecordingBackground' : 'toolsCapturePermission')}</p>
    </section>
    <TranscriptionConfig t={t} api={api} report={report} notify={notify} />
    <div className={css.sectionTitle}><h3>{t('toolsHistory')}</h3><span>{records.length}</span></div>
    <div className={css.recordList}>{records.length === 0 && <p className={css.empty}>{t('toolsNoRecordings')}</p>}
      {records.map(record => <button key={record.id} type="button" className={css.recordCard} aria-pressed={selected === record.id} onClick={() => { select(record.id) }}>
        <strong>{record.title}</strong><span>{audioTime(record.duration)} · {t(record.source === 'mixed' ? 'toolsMixed' : 'toolsMicrophone')}</span>
        <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString()}</time>
      </button>)}</div>
    {item !== undefined && <section className={css.detail} aria-label={item.title}>
      <form className={css.rename} onSubmit={(event) => {
        event.preventDefault(); void perform('rename', async () => { update(await api.run('recordingRename', { id: item.id, title })); notify(t('toolsSaved')) })
      }}><input aria-label={t('toolsRecordingTitle')} maxLength={200} value={title} disabled={!!busy} onChange={(event) => { setTitle(event.target.value) }} />
        <Button size="sm" type="submit" disabled={!!busy || !title.trim() || title === item.title}>{t('organizerSave')}</Button></form>
      {item.interrupted && <p className={css.hint}>{t('toolsRecovered')}</p>}
      <audio ref={audio} controls preload="metadata" src={audioUrl || undefined} aria-label={item.title} onLoadedMetadata={() => {
        if (audio.current !== null && seek.current !== null) {
          audio.current.currentTime = seek.current; seek.current = null
          void audio.current.play().catch(report)
        }
      }} onError={() => { if (audioUrl) report(new Error('toolsOperationFailed')) }} />
      <div className={css.actions}><Button size="sm" disabled={!!busy} onClick={() => { void load(0).catch(report) }}>{t('toolsPlay')}</Button>
        <Button size="sm" disabled={!!busy} onClick={() => { void perform('export', async () => { if (await api.run('recordingExport', { id: item.id })) notify(t('toolsExported')) }) }}>{t('toolsExport')}</Button>
        <Button size="sm" disabled={!!busy} onClick={() => { setConfirm('delete') }}>{t('organizerDelete')}</Button></div>
      {busy && <p className={css.hint} role="status">{t(busy === 'transcribe' ? 'toolsTranscribing' : busy === 'summary' ? 'toolsOrganizing' : 'busy')}</p>}
      {confirm !== null && <div className={css.confirm}><p>{t(confirm === 'transcribe' ? 'toolsTranscribeConfirm' : 'toolsDeleteRecording')}</p><div className={css.actions}>
        <Button variant="primary" className={css.primary} disabled={!!busy} onClick={() => {
          const action = confirm; setConfirm(null)
          void perform(action, async () => {
            if (action === 'delete') { await api.run('recordingDelete', { id: item.id }); remove(item.id) }
            else { const next = await api.run('transcribe', { id: item.id }); update(next); notify(t(next.segments.length ? 'toolsSaved' : 'toolsNoSpeech')) }
          })
        }}>{t(confirm === 'transcribe' ? 'toolsTranscribe' : 'organizerConfirmDelete')}</Button>
        <Button disabled={!!busy} onClick={() => { setConfirm(null) }}>{t('cancel')}</Button></div></div>}
      <div className={css.sectionTitle}><h3>{t('toolsTranscript')}</h3>
        {item.segments.length === 0 && <Button size="sm" disabled={!!busy} onClick={() => {
          if (item.job !== undefined) void perform('transcribe', async () => { update(await api.run('transcribe', { id: item.id })) })
          else setConfirm('transcribe')
        }}>{t(item.job === undefined ? 'toolsTranscribe' : 'toolsTranscribeResume')}</Button>}</div>
      {item.segments.length === 0 ? <p className={css.hint}>{t('toolsTranscriptEmpty')}</p> : <>
        <div className={css.transcript}>{item.segments.map((segment, index) => <div key={index} className={css.sentence}>
          <button type="button" disabled={!!busy} onClick={() => { void load(segment.start).catch(report) }} aria-label={`${audioTime(segment.start)} ${speakerName(segment.speaker, t)}`}>
            {audioTime(segment.start)}<span>{speakerName(segment.speaker, t)}</span></button>
          <p>{segment.text}</p></div>)}</div>
        <Button size="sm" onClick={() => {
          void navigator.clipboard.writeText(item.segments.map(segment => `[${audioTime(segment.start)}] ${speakerName(segment.speaker, t)}：${segment.text}`).join('\n')).then(() => { notify(t('copied')) }, report)
        }}>{t('copy')}</Button>
        <h3>{t('toolsOrganize')}</h3><p className={css.hint}>{t('toolsOrganizeHint')}</p>
        <div className={css.actions}>{(['idea', 'meeting', 'actions'] as const).map((kind: SummaryKind) => <Button key={kind} variant="outline" size="sm" disabled={!!busy}
          onClick={() => { void perform('summary', async () => { update(await api.run('summarize', { id: item.id, kind })) }) }}>{t(summaryLabels[kind])}</Button>)}</div>
        {item.summaries.map(summary => <section className={css.summary} key={summary.kind}>
          <h4>{t(summaryLabels[summary.kind])}</h4><div className={css.summaryText}>{summary.text}</div>
          <Button size="sm" disabled={organizer.items.some(note => note.kind === 'note' && note.text === `${item.title}\n\n${summary.text}`)} onClick={() => {
            organizer.put({ id: randomUUID(), kind: 'note', text: `${item.title}\n\n${summary.text}`, done: false, updatedAt: Date.now() })
          }}>{t('toolsSaveNote')}</Button>
          {summary.actions.map((text, index) => <div className={css.actionItem} key={index}><p>{text}</p><Button size="sm" disabled={alreadyAdded(text)} onClick={() => {
            organizer.put({ id: randomUUID(), kind: 'todo', text, done: false, updatedAt: Date.now() })
          }}>{t(alreadyAdded(text) ? 'toolsAdded' : 'toolsAddTodo')}</Button></div>)}
        </section>)}
        {organizer.error && <p role="alert" className={css.error}>{t('organizerStorageError')}<Button size="sm" onClick={organizer.retry}>{t('retry')}</Button></p>}
      </>}
    </section>}
  </>
}

function TranscriptionConfig({ t, api, report, notify }: {
  t: PersonalCopy
  api: DublinToolsApi
  report: (error: unknown) => void
  notify: (text: string) => void
}) {
  const [config, setConfig] = useState<TranscriptionSettings | null>(null), [key, setKey] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void api.run('transcriptionSettings', null).then((value) => { if (active) setConfig(value) }, report); return () => { active = false } }, [api])
  const id = useId()
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() } catch (error) { report(error) } finally { setBusy(false) }
  }
  return <details className={css.config}><summary>{t('toolsConfig')}<small>{t(config?.configured ? 'toolsConfigured' : 'toolsNotConfigured')}</small></summary>
    <p className={css.hint}>{t('toolsConfigHint')}</p><p className={css.hint}>{t('toolsTemporaryUpload')}</p>
    {config !== null && <form className={css.configForm} onSubmit={(event) => {
      event.preventDefault(); void perform(async () => { setConfig(await api.run('transcriptionConfigure', { region: config.region, model: config.model, summaryModel: config.summaryModel, apiKey: key })); setKey(''); notify(t('toolsSaved')) })
    }}>
      <label htmlFor={`${id}-region`}>{t('toolsRegion')}</label><select id={`${id}-region`} value={config.region} disabled={busy} onChange={(event) => { setConfig({ ...config, region: event.target.value === 'beijing' ? 'beijing' : 'singapore' }) }}>
        <option value="beijing">{t('toolsBeijing')}</option><option value="singapore">{t('toolsSingapore')}</option></select>
      <label htmlFor={`${id}-asr`}>{t('toolsAsrModel')}</label><select id={`${id}-asr`} value={config.model} disabled={busy} onChange={(event) => { setConfig({ ...config, model: event.target.value }) }}>
        <option value="qwen-audio-3.1-asr-flash-filetrans">{t('toolsModelQwen')}</option><option value="fun-asr">{t('toolsModelFun')}</option></select>
      <label htmlFor={`${id}-summary`}>{t('toolsSummaryModel')}</label><input id={`${id}-summary`} value={config.summaryModel} required pattern="[A-Za-z0-9_.-]+" maxLength={100} disabled={busy} onChange={(event) => { setConfig({ ...config, summaryModel: event.target.value }) }} />
      <label htmlFor={`${id}-key`}>{t('toolsApiKey')}</label><input id={`${id}-key`} type="password" autoComplete="new-password" spellCheck={false} maxLength={8192}
        value={key} placeholder={config.configured ? t('toolsKeyUnchanged') : undefined} required={!config.configured} disabled={busy} onChange={(event) => { setKey(event.target.value) }} />
      <div className={css.actions}><Button type="submit" variant="primary" className={css.primary} size="sm" disabled={busy}>{t('organizerSave')}</Button>
        {config.configured && <Button size="sm" disabled={busy} onClick={() => { void perform(async () => { await api.run('transcriptionDisconnect', null); setConfig({ ...config, configured: false }); setKey('') }) }}>{t('toolsDisconnect')}</Button>}</div>
    </form>}
  </details>
}
