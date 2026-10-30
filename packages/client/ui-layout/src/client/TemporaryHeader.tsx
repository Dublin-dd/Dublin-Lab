/** Compact chat title and an anchored project-continuation picker. */
import { useEffect, useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TemporaryHeader.module.css'

/**
 * Show a quiet title row; project selection stays in a dismissible floating panel.
 * @param props - current title, available projects and the existing continuation action.
 * @returns the transparent temporary-chat header.
 */
export function TemporaryHeader({ title, projects, busy, canTransfer, onTransfer, t }: {
  title: string
  projects: readonly { name: string; path: string }[]
  busy: boolean
  canTransfer: boolean
  onTransfer: (project: string) => void
  t: PropsLocale<'simin'>['t']
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [selected, setSelected] = useState('')
  const root = useRef<HTMLDivElement>(null), entry = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); entry.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const rows = projects.filter(project => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className={css.header}>
    <h1 title={title}>{title}</h1>
    <div ref={root} className={css.anchor}>
      <button ref={entry} type="button" className={css.trigger} disabled={busy} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
          setOpen(!open); setQuery(''); setSelected('')
        }}><IconFolderCloseRegular size={14} />{t('temporaryMove')}</button>
      {open && <section className={css.picker} role="dialog" aria-label={t('temporaryChoose')} id={id}>
        <div className={css.pickerHeading}><strong>{t('temporaryChoose')}</strong>
          <button type="button" aria-label={t('close')} onClick={() => { setOpen(false); entry.current?.focus() }}>×</button></div>
        <input ref={search} className={css.search} aria-label={t('temporarySearch')} placeholder={t('temporarySearch')}
          value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <div className={css.projects}>
          {rows.map(project => <button type="button" key={project.path} className={css.project} aria-pressed={selected === project.name}
            onClick={() => { setSelected(project.name) }}><IconFolderCloseRegular size={16} />
            <span>{project.name}</span><span className={css.check} aria-hidden="true">{selected === project.name ? '✓' : ''}</span></button>)}
          {rows.length === 0 && <p className={css.empty}>{t(projects.length === 0 ? 'temporaryNoProjects' : 'noResults')}</p>}
        </div>
        <div className={css.footer}><p>{t(canTransfer ? 'temporaryKeepOriginal' : 'temporaryCompleteFirst')}</p>
          <button type="button" className={css.confirm} disabled={busy || !canTransfer || !projects.some(project => project.name === selected)}
            onClick={() => { setOpen(false); onTransfer(selected) }}>{t('temporaryTransfer')}</button></div>
      </section>}
    </div>
  </div>
}
