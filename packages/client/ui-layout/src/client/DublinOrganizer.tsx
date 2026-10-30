/** Global task and note drawers; the workspace stays mounted during editing. */
import { useEffect, useId, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useDublinOrganizer, type OrganizerItem } from './dublin-organizer.ts'
import { DublinToolMark, type DublinToolRequest, type TodoSummary } from './DublinNavigation.tsx'
import css from './DublinOrganizer.module.css'

type Copy = PropsLocale<'simin'>['t']

/**
 * Render mutually exclusive task/note drawers beside the search control.
 * @param props - workbench-localized labels.
 * @returns header entries and a non-modal right-side panel.
 */
export function DublinOrganizer({ t, showEntries = true, request, restoreFocus, onSummary }: {
  t: Copy
  showEntries?: boolean
  request?: DublinToolRequest | null
  restoreFocus?: () => void
  onSummary?: (summary: TodoSummary) => void
}) {
  const store = useDublinOrganizer()
  const [panel, setPanel] = useState<'todo' | 'note' | null>(null)
  const [completed, setCompleted] = useState(false)
  const [task, setTask] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [noteId, setNoteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const todoButton = useRef<HTMLButtonElement>(null)
  const noteButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const notes = store.items.filter(item => item.kind === 'note').sort((a, b) => b.updatedAt - a.updatedAt)
  const note = notes.find(item => item.id === noteId)
  const tasks = store.items.filter(item => item.kind === 'todo' && item.done === completed)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  useEffect(() => { if (panel !== null) heading.current?.focus() }, [panel])
  useEffect(() => {
    const closeOther = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== 'organizer') setPanel(null)
    }
    window.addEventListener('dublin-drawer-open', closeOther)
    return () => { window.removeEventListener('dublin-drawer-open', closeOther) }
  }, [])
  useEffect(() => {
    if (panel !== null) window.dispatchEvent(new CustomEvent('dublin-drawer-open', { detail: 'organizer' }))
  }, [panel])
  useEffect(() => { if (panel === 'note') noteInput.current?.focus() }, [panel, noteId])
  const close = (): void => {
    const target = panel === 'todo' ? todoButton : noteButton
    setPanel(null); setDeleting(null)
    if (restoreFocus !== undefined) restoreFocus(); else target.current?.focus()
  }
  const toggle = (next: 'todo' | 'note'): void => {
    if (panel === next) close()
    else { setPanel(next); setDeleting(null) }
  }
  useEffect(() => {
    if (request?.tool === 'todo' || request?.tool === 'note') { setPanel(request.tool); setDeleting(null) }
  }, [request])
  useEffect(() => {
    const pending = store.items.filter(item => item.kind === 'todo' && !item.done).sort((a, b) => b.updatedAt - a.updatedAt)
    onSummary?.({ count: pending.length, items: pending.slice(0, 3).map(({ id, text }) => ({ id, text })), error: store.error })
  }, [store.items, store.error, onSummary])
  const put = (item: OrganizerItem): void => { store.put({ ...item, updatedAt: Date.now() }) }
  const createNote = (): void => {
    const next = randomUUID()
    put({ id: next, kind: 'note', text: '', done: false, updatedAt: Date.now() })
    setNoteId(next); setDeleting(null)
  }
  return <>
    {showEntries && <><button ref={todoButton} type="button" className={css.entry} aria-expanded={panel === 'todo'}
      aria-controls={panel === 'todo' ? id : undefined} onClick={() => { toggle('todo') }}>{t('organizerTodos')}</button>
    <button ref={noteButton} type="button" className={css.entry} aria-expanded={panel === 'note'}
      aria-controls={panel === 'note' ? id : undefined} onClick={() => { toggle('note') }}>{t('organizerNotes')}</button></>}
    {panel !== null && <aside id={id} role="region" aria-labelledby={`${id}-title`} className={css.drawer}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div className={css.heading}><div><p>{t('organizerPersonal')}</p>
        <h2 ref={heading} tabIndex={-1} id={`${id}-title`}><DublinToolMark kind={panel} large />{t(panel === 'todo' ? 'organizerTodos' : 'organizerNotes')}</h2></div>
      <button type="button" className={css.close} aria-label={t('close')} onClick={close}>×</button></div>
      <p className={css.hint}>{t('organizerShared')}</p>
      {store.error && <div role="alert" className={css.error}>{t('organizerStorageError')}
        <button type="button" onClick={store.retry}>{t('organizerRetry')}</button></div>}
      {panel === 'todo' ? <>
        <form className={css.add} onSubmit={(event) => {
          event.preventDefault()
          if (!task.trim()) return
          put({ id: randomUUID(), kind: 'todo', text: task.trim(), done: false, updatedAt: Date.now() })
          setTask(''); setCompleted(false)
        }}><input aria-label={t('organizerNewTask')} placeholder={t('organizerTaskPlaceholder')}
            maxLength={500} value={task} onChange={(event) => { setTask(event.target.value) }} />
          <button type="submit" disabled={!task.trim()}>{t('organizerAdd')}</button></form>
        <div className={css.filters}>{[false, true].map(done => <button key={String(done)} type="button"
          aria-pressed={completed === done} onClick={() => { setCompleted(done); setEditing(null) }}>
          {t(done ? 'organizerCompleted' : 'organizerPending')}
          <span>{store.items.filter(item => item.kind === 'todo' && item.done === done).length}</span></button>)}</div>
        <div className={css.list}>{tasks.length === 0 && <p className={css.empty}>{t(completed ? 'organizerNoCompleted' : 'organizerNoTasks')}</p>}
          {tasks.map(item => <div key={item.id} className={css.task}>
            <input type="checkbox" checked={item.done} aria-label={t('organizerToggleTask', { text: item.text })}
              onChange={() => { put({ ...item, done: !item.done }) }} />
            {editing === item.id ? <form className={css.editTask} onSubmit={(event) => {
              event.preventDefault(); if (!editText.trim()) return
              put({ ...item, text: editText.trim() }); setEditing(null)
            }}><input autoFocus aria-label={t('organizerEditTask')} maxLength={500} value={editText}
                onChange={(event) => { setEditText(event.target.value) }} />
              <button type="submit" disabled={!editText.trim()}>{t('organizerSave')}</button>
              <button type="button" onClick={() => { setEditing(null) }}>{t('cancel')}</button></form>
              : <><span className={item.done ? css.done : undefined}>{item.text}</span><div className={css.actions}>
                <button type="button" aria-label={t('organizerEditItem', { text: item.text })}
                  onClick={() => { setEditing(item.id); setEditText(item.text) }}>{t('organizerEdit')}</button>
                <button type="button" aria-label={t('organizerDeleteItem', { text: item.text })}
                  onClick={() => { setDeleting(item.id) }}>{t('organizerDelete')}</button></div></>}
            {deleting === item.id && <div className={css.confirm}><span>{t('organizerDeleteConfirm')}</span>
              <button type="button" onClick={() => { store.remove(item.id); setDeleting(null) }}>{t('organizerConfirmDelete')}</button>
              <button type="button" onClick={() => { setDeleting(null) }}>{t('cancel')}</button></div>}
          </div>)}</div>
      </> : <>
        <button type="button" className={css.newNote} onClick={createNote}>{t('organizerNewNote')}</button>
        {note !== undefined && <section className={css.editor}>
          <textarea ref={noteInput} aria-label={t('organizerNoteContent')} placeholder={t('organizerNotePlaceholder')}
            maxLength={20000} value={note.text} onChange={(event) => { put({ ...note, text: event.target.value }) }} />
          <div className={css.editorFoot}><small>{t(store.error ? 'organizerUnsaved' : 'organizerSaved')}</small>
            <button type="button" onClick={() => { setDeleting(note.id) }}>{t('organizerDelete')}</button></div>
          {deleting === note.id && <div className={css.confirm}><span>{t('organizerDeleteConfirm')}</span>
            <button type="button" onClick={() => { store.remove(note.id); setNoteId(null); setDeleting(null) }}>{t('organizerConfirmDelete')}</button>
            <button type="button" onClick={() => { setDeleting(null) }}>{t('cancel')}</button></div>}
        </section>}
        <div className={css.noteList}><h3>{t('organizerHistory')}</h3>
          {notes.length === 0 && <p className={css.empty}>{t('organizerNoNotes')}</p>}
          {notes.map(item => <button type="button" key={item.id} className={css.note} aria-pressed={noteId === item.id}
            onClick={() => { setNoteId(item.id); setDeleting(null) }}>
            <strong>{item.text.trim().split('\n')[0] || t('organizerUntitled')}</strong>
            <span>{item.text.trim() || t('organizerNotePlaceholder')}</span>
            <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleString()}</time>
          </button>)}</div>
      </>}
    </aside>}
  </>
}
