/** Masked cards expand into a local editor; native authentication owns reveal and copy. */
import { useEffect, useId, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DublinToolsApi, VaultCard } from '../dublin-tools.ts'
import type { PersonalCopy } from './DublinPersonalTools.tsx'
import css from './DublinPersonalTools.module.css'

interface Draft { id?: string; provider: string; account: string; secret: string }
export function DublinVaultPanel({ t, api, cards, update, report, notify }: {
  t: PersonalCopy
  api: DublinToolsApi
  cards: VaultCard[]
  update: (cards: VaultCard[]) => void
  report: (error: unknown) => void
  notify: (text: string) => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const id = useId()
  useEffect(() => {
    const hide = (): void => { setVisible(false); setDraft(current => current?.id === undefined ? current : { ...current, secret: '' }) }
    const hidden = (): void => { if (document.hidden) hide() }
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => { setVisible(false); setDraft(current => current?.id === undefined ? current : { ...current, secret: '' }) }, 60000)
    return () => { clearTimeout(timer) }
  }, [visible])
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await action() } catch (error) { report(error) } finally { setBusy(false) }
  }
  const copyStored = (): void => {
    const cardId = draft?.id
    if (cardId === undefined) return
    void perform(async () => { await api.run('vaultCopy', { id: cardId }); notify(t('toolsCopied')) })
  }
  const open = (card?: VaultCard): void => {
    setDraft(card === undefined ? { provider: '', account: '', secret: '' } : { id: card.id, provider: card.provider, account: card.account, secret: '' })
    setVisible(false); setDeleting(false)
  }
  return <>
    <p className={css.hint}>{t('toolsVaultPrivacy')}</p>
    <p className={css.hint}>{t('toolsClipboardHint')}</p>
    <Button variant="primary" className={css.primary} disabled={busy} onClick={() => { open() }}>{t('toolsNewCard')}</Button>
    {draft !== null && <form className={css.expanded} key={draft.id ?? 'new'} aria-label={t('toolsVault')} onSubmit={(event) => {
      event.preventDefault()
      void perform(async () => {
        const saved = await api.run('vaultSave', draft)
        update([saved, ...cards.filter(card => card.id !== saved.id)])
        setDraft(null); setVisible(false); notify(t('toolsSaved'))
      })
    }}>
      <div className={css.cardTop}><span className={css.chip}>{t('toolsVault')}</span><Button size="sm" aria-label={t('close')} disabled={busy} onClick={() => { setDraft(null); setVisible(false) }}>×</Button></div>
      <label htmlFor={`${id}-provider`}>{t('toolsProvider')}</label>
      <input id={`${id}-provider`} autoFocus autoComplete="off" maxLength={100} required value={draft.provider} disabled={busy}
        onChange={(event) => { setDraft({ ...draft, provider: event.target.value }) }} />
      <label htmlFor={`${id}-account`}>{t('toolsAccount')}</label>
      <input id={`${id}-account`} autoComplete="off" maxLength={250} required value={draft.account} disabled={busy}
        onChange={(event) => { setDraft({ ...draft, account: event.target.value }) }} />
      <label htmlFor={`${id}-secret`}>{t('toolsSecret')}</label>
      <input id={`${id}-secret`} type={visible ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} maxLength={8192}
        onCopy={(event) => { event.preventDefault(); copyStored() }} onCut={(event) => { event.preventDefault(); copyStored() }}
        onDragStart={(event) => { event.preventDefault() }} required={draft.id === undefined} value={draft.secret} placeholder={draft.id === undefined ? undefined : '***'} disabled={busy}
        onChange={(event) => { setDraft({ ...draft, secret: event.target.value }) }} />
      {draft.id !== undefined && <small className={css.hint}>{t('toolsEditHint')}</small>}
      <div className={css.actions}>
        <Button size="sm" disabled={busy} onClick={() => {
          if (visible) { setVisible(false); if (draft.id !== undefined) setDraft({ ...draft, secret: '' }); return }
          if (draft.id === undefined) { setVisible(true); return }
          const cardId = draft.id
          void perform(async () => { const secret = await api.run('vaultReveal', { id: cardId }); setDraft({ ...draft, secret }); setVisible(true) })
        }}>{t(visible ? 'toolsHide' : 'toolsReveal')}</Button>
        {draft.id !== undefined && <Button size="sm" disabled={busy} onClick={copyStored}>{t('toolsCopy')}</Button>}
      </div>
      <div className={css.actions}><Button type="submit" variant="primary" className={css.primary} disabled={busy || !draft.provider.trim() || !draft.account.trim() || (draft.id === undefined && !draft.secret.trim())}>{t('organizerSave')}</Button>
        {draft.id !== undefined && <Button disabled={busy} onClick={() => { setDeleting(true) }}>{t('organizerDelete')}</Button>}</div>
      {deleting && <div className={css.confirm}><p>{t('toolsDeleteKey')}</p><div className={css.actions}>
        <Button disabled={busy} onClick={() => {
          const cardId = draft.id
          if (cardId !== undefined) void perform(async () => { await api.run('vaultDelete', { id: cardId }); update(cards.filter(item => item.id !== cardId)); setDraft(null) })
        }}>{t('organizerConfirmDelete')}</Button><Button disabled={busy} onClick={() => { setDeleting(false) }}>{t('cancel')}</Button></div></div>}
    </form>}
    <div className={css.cards}>{cards.length === 0 && draft === null && <p className={css.empty}>{t('toolsNoKeys')}</p>}
      {cards.filter(card => card.id !== draft?.id).map(card => <button key={card.id} type="button" className={css.vaultCard} disabled={busy} onClick={() => { open(card) }}>
        <span className={css.cardTop}><strong>{card.provider}</strong><span aria-hidden="true">↗</span></span>
        <span className={css.account}>{card.account}</span><span className={css.mask}>***</span>
      </button>)}</div>
  </>
}
