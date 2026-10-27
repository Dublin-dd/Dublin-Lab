/** Gesture-started camera preview and locally persisted appearance controls. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { useDublinAppearance } from './dublin-appearance.ts'
import css from './Dublin.module.css'

type Copy = PropsLocale<'simin'>['t']
function cameraDevices(): MediaDevices | undefined { return (navigator as Partial<Navigator>).mediaDevices }

/**
 * Stop camera tracks on click, page hiding, late authorization or unmount.
 * @param props - localized camera labels.
 * @returns a compact island that expands into a live preview.
 */
export function CameraIsland({ t }: { t: Copy }) {
  const [phase, setPhase] = useState<'off' | 'starting' | 'live'>('off')
  const [error, setError] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const attempt = useRef(0)
  const stop = (): void => {
    attempt.current++
    stream.current?.getTracks().forEach((track) => { track.stop() })
    stream.current = null
    if (video.current !== null) video.current.srcObject = null
    setPhase('off')
  }
  useEffect(() => {
    const hide = (): void => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      attempt.current++
      stream.current?.getTracks().forEach((track) => { track.stop() })
      stream.current = null
    }
  }, [])
  useEffect(() => {
    if (phase === 'live' && video.current !== null) {
      const version = attempt.current
      video.current.srcObject = stream.current
      void video.current.play().catch(() => { if (attempt.current === version) { stop(); setError(true) } })
    }
  }, [phase])
  const start = async (): Promise<void> => {
    if (phase !== 'off') { stop(); return }
    const version = ++attempt.current
    setError(false); setPhase('starting')
    try {
      const devices = cameraDevices()
      if (devices === undefined) throw new Error('unsupported')
      const next = await devices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      if (attempt.current !== version) { next.getTracks().forEach((track) => { track.stop() }); return }
      stream.current = next
      next.getVideoTracks().forEach((track) => { track.addEventListener('ended', () => { if (attempt.current === version) stop() }, { once: true }) })
      setPhase('live')
    } catch (_error) { if (attempt.current === version) { setPhase('off'); setError(true) } }
  }
  return <div className={css.islandSeat}>
    <button type="button" className={`${css.island} ${phase === 'live' ? css.islandLive : ''}`} onClick={() => { void start() }} aria-label={t(phase === 'off' ? 'cameraOpen' : 'cameraClose')} aria-expanded={phase === 'live'} aria-busy={phase === 'starting'}>
      {phase === 'live' && <video ref={video} autoPlay playsInline muted />}
    </button>
    {error && <div role="alert" className={css.cameraError}>{t(cameraDevices() === undefined ? 'cameraUnsupported' : 'cameraError')}</div>}
  </div>
}

/**
 * Appearance dialog, image picker and transparency control.
 * @param props - local appearance state and localized labels.
 * @returns the right-aligned style selector.
 */
export function AppearanceControl({ t, state }: { t: Copy; state: ReturnType<typeof useDublinAppearance> }) {
  const [open, setOpen] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const { appearance, imageUrl, saving, error, update, setBackground } = state
  return <>
    <button type="button" className={css.styleButton} onClick={() => { setOpen(true) }} aria-haspopup="dialog">{t('appearance')}</button>
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('appearance')} closeLabel={t('close')} className={css.appearanceDialog ?? ''}>
      <p className={css.dialogHint}>{t('appearanceHint')}</p>
      <div className={css.styleOptions}>{(['light', 'dark'] as const).map(style => <button type="button" key={style} className={`${css.styleOption} ${appearance.style === style ? css.styleChosen : ''}`} onClick={() => { update({ ...appearance, style }) }} aria-pressed={appearance.style === style}>
        <span className={css.stylePreview} data-style={style}><i /><span /><b /><em /></span><span>{t(style === 'dark' ? 'appearanceDark' : 'appearanceLight')}</span><small>{appearance.style === style ? '✓' : ''}</small>
      </button>)}</div>
      <div className={css.appearanceSection}><h3>{t('appearanceBackground')}</h3>
        {imageUrl !== null && <img className={css.backgroundPreview} src={imageUrl} alt={t('appearanceBackground')} />}
        <div className={css.actionRow}><button type="button" className={css.secondary} disabled={saving} onClick={() => { file.current?.click() }}>{t('appearanceChoose')}</button>{imageUrl !== null && <button type="button" className={css.quiet} disabled={saving} onClick={() => { void setBackground(null) }}>{t('appearanceRemove')}</button>}</div>
        <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const next = event.currentTarget.files?.[0]; if (next !== undefined) void setBackground(next); event.currentTarget.value = '' }} />
        <p className={css.dialogHint}>{t('appearanceLocal')}</p>
        <label className={css.rangeLabel}>{t('appearanceTransparency')}<output>{Math.round(appearance.transparency)}%</output><input aria-label={t('appearanceTransparency')} type="range" min="0" max="100" value={appearance.transparency} disabled={imageUrl === null} onChange={(event) => { update({ ...appearance, transparency: Number(event.target.value) }) }} /></label>
        <label className={css.rangeLabel}>{t('appearanceChatTransparency')}<output>{Math.round(appearance.chatTransparency)}%</output><input aria-label={t('appearanceChatTransparency')} type="range" min="0" max="100" value={appearance.chatTransparency} disabled={imageUrl === null} onChange={(event) => { update({ ...appearance, chatTransparency: Number(event.target.value) }) }} /></label>
        <p className={css.dialogHint}>{t('appearanceChatHint')}</p>
        {error && <p role="alert" className={css.error}>{t('appearanceImageError')}</p>}
      </div>
    </Modal>
  </>
}
