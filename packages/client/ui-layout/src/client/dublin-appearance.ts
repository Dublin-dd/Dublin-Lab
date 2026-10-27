/** Local appearance metadata and IndexedDB-owned background image. */
import { useEffect, useRef, useState } from 'react'

/** Theme requests are handled by the existing theme service. */
export const DUBLIN_THEME_EVENT = 'dublin-theme-change'
/** Persistent appearance selection, separate from project documents and credentials. */
export interface DublinAppearance { style: 'light' | 'dark'; transparency: number; chatTransparency: number }
const KEY = 'dublin.appearance.v1'
function transparency(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback
}

/**
 * Read metadata; older preferences initialize conversation transparency from the workspace value.
 * @returns style and both transparency values.
 */
export function loadDublinAppearance(): DublinAppearance {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof data !== 'object' || data === null) return { style: 'light', transparency: 70, chatTransparency: 70 }
    const value = data as Record<string, unknown>
    const workspace = transparency(value.transparency, 70)
    return { style: value.style === 'dark' ? 'dark' : 'light', transparency: workspace, chatTransparency: transparency(value.chatTransparency, workspace) }
  } catch (_error) { return { style: 'light', transparency: 70, chatTransparency: 70 } }
}

async function backgroundFile(next?: Blob | null): Promise<Blob | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('dublin-appearance', 1)
    open.onupgradeneeded = () => { open.result.createObjectStore('images') }
    open.onsuccess = () => { resolve(open.result) }
    open.onerror = () => { reject(open.error ?? new Error('imageStorageUnavailable')) }
  })
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction('images', next === undefined ? 'readonly' : 'readwrite')
      const store = tx.objectStore('images')
      const request = next === undefined ? store.get('background') : next === null ? store.delete('background') : store.put(next, 'background')
      let result: Blob | null = next ?? null
      request.onsuccess = () => {
        if (next === undefined) {
          const value: unknown = request.result
          result = value instanceof Blob ? value : null
        }
      }
      tx.oncomplete = () => { resolve(result) }
      tx.onerror = () => { reject(tx.error ?? new Error('imageStorageFailed')) }
      tx.onabort = () => { reject(tx.error ?? new Error('imageStorageAborted')) }
    })
  } finally { db.close() }
}

/**
 * Own persisted appearance and release every background object URL on replacement or unmount.
 * @returns appearance controls and the locally loaded background URL.
 */
export function useDublinAppearance() {
  const [appearance, setAppearance] = useState(loadDublinAppearance)
  const [image, setImage] = useState<Blob | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const revision = useRef(0)
  useEffect(() => {
    let active = true
    const initial = revision.current
    void backgroundFile().then(
      (file) => { if (active && initial === revision.current) setImage(file) },
      () => { if (active) setError(true) },
    )
    return () => { active = false; revision.current++ }
  }, [])
  useEffect(() => {
    if (image === null) { setImageUrl(null); return }
    const url = URL.createObjectURL(image)
    setImageUrl(url)
    return () => { URL.revokeObjectURL(url) }
  }, [image])
  const update = (next: DublinAppearance): void => {
    setAppearance(next)
    try { localStorage.setItem(KEY, JSON.stringify(next)); setError(false) } catch (_error) { setError(true) }
    window.dispatchEvent(new CustomEvent(DUBLIN_THEME_EVENT, { detail: next.style }))
  }
  const setBackground = async (file: File | null): Promise<void> => {
    if (saving) return
    const version = ++revision.current
    setSaving(true); setError(false)
    try {
      if (file !== null) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('invalidImage')
        const preview = URL.createObjectURL(file)
        try { const image = new Image(); image.src = preview; await image.decode() } finally { URL.revokeObjectURL(preview) }
      }
      await backgroundFile(file)
      if (revision.current === version) setImage(file)
    } catch (_error) { if (revision.current === version) setError(true) }
    finally { if (revision.current === version) setSaving(false) }
  }
  return { appearance, imageUrl, error, saving, update, setBackground }
}
