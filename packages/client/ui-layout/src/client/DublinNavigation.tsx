/** Shared navigation types and decorative tool marks. */
import css from './DublinNavigation.module.css'

export type DublinTool = 'todo' | 'note' | 'recording' | 'vault' | 'reminders'
export interface DublinToolRequest { tool: DublinTool; serial: number }
export interface TodoSummary { count: number; items: { id: string; text: string }[]; error: boolean }
export interface ReminderSummary { count: number; items: { id: string; title: string; at: string }[]; error: boolean }

/** Small navigation glyphs use the same size, color and stroke weight. */
export function DublinToolIcon({ kind }: { kind: 'note' | 'recording' | 'vault' }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'recording' ? <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v4m-4 0h8" /></>
      : kind === 'note' ? <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h4" /></>
        : <><circle cx="8" cy="8" r="5" /><path d="m11.5 11.5 9 9H23v-4h-4v-4h-4M6.5 6.5h.01" /></>}
  </svg>
}

/** Decorative marks do not change button or heading accessible names. */
export function DublinToolMark({ kind, large = false }: { kind: Exclude<DublinTool, 'vault'>; large?: boolean }) {
  return <span aria-hidden="true" className={`${css.mark} ${large ? css.large : ''}`}>
    {kind === 'recording' ? <span className={css.dot} /> : kind === 'note' ? '📝' : kind === 'todo' ? '☑️' : '⏰'}
  </span>
}
