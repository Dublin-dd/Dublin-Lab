/** Per-item local storage shared by all projects in this browser profile. */
import { useEffect, useRef, useState } from 'react'

/** One locally stored task or plain-text note. */
export interface OrganizerItem {
  id: string
  kind: 'todo' | 'note'
  text: string
  done: boolean
  updatedAt: number
}
const PREFIX = 'dublin.organizer.v1.'
const CHANGE_EVENT = 'dublin-organizer-change'
function parse(raw: string, id: string): OrganizerItem {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) throw new Error('Invalid organizer item')
  const item = value as Record<string, unknown>
  if (item.id !== id || (item.kind !== 'todo' && item.kind !== 'note') || typeof item.text !== 'string'
    || typeof item.done !== 'boolean' || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)
    || Math.abs(item.updatedAt) > 8_640_000_000_000_000) {
    throw new Error('Invalid organizer item')
  }
  return { id, kind: item.kind, text: item.text, done: item.done, updatedAt: item.updatedAt }
}
function read(): { items: OrganizerItem[]; error: boolean } {
  const items: OrganizerItem[] = []
  let error = false
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      try { items.push(parse(localStorage.getItem(key) ?? '', key.slice(PREFIX.length))) }
      catch (_error) { error = true /* Preserve unreadable records without overwriting them. */ }
    }
  } catch (_error) { error = true /* Keep the panel usable when browser storage is unavailable. */ }
  return { items, error }
}

/**
 * Persist each edit immediately; retain failed writes in memory for explicit retry.
 * Storage events merge other windows without replacing locally unsaved items.
 * @returns records, storage status and local mutation functions.
 */
export function useDublinOrganizer(): {
  items: OrganizerItem[]
  error: boolean
  put: (item: OrganizerItem) => void
  remove: (id: string) => void
  retry: () => void
} {
  const [initial] = useState(read)
  const [items, setItems] = useState(initial.items)
  const [error, setError] = useState(initial.error)
  const pending = useRef(new Map<string, OrganizerItem | null>())
  const persist = (id: string, item: OrganizerItem | null): void => {
    pending.current.set(id, item)
    try {
      if (item === null) localStorage.removeItem(PREFIX + id)
      else localStorage.setItem(PREFIX + id, JSON.stringify(item))
      pending.current.delete(id)
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: PREFIX + id }))
      setError(initial.error || pending.current.size > 0)
    } catch (_error) { setError(true) }
  }
  useEffect(() => {
    const sync = (event: Pick<StorageEvent, 'key' | 'newValue'>): void => {
      if (event.key === null) {
        setItems(current => current.filter(item => pending.current.has(item.id)))
        return
      }
      if (!event.key.startsWith(PREFIX)) return
      const id = event.key.slice(PREFIX.length)
      if (pending.current.has(id)) return
      try {
        const item = event.newValue === null ? null : parse(event.newValue, id)
        setItems(current => [...current.filter(row => row.id !== id), ...(item === null ? [] : [item])])
      } catch (_error) { setError(true) }
    }
    const local = (event: Event): void => {
      const key: unknown = (event as CustomEvent<unknown>).detail
      if (typeof key !== 'string' || !key.startsWith(PREFIX)) return
      try { sync({ key, newValue: localStorage.getItem(key) }) } catch (_error) { setError(true) }
    }
    window.addEventListener('storage', sync)
    window.addEventListener(CHANGE_EVENT, local)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(CHANGE_EVENT, local) }
  }, [])
  return {
    items, error,
    put(item) {
      persist(item.id, item)
      setItems(current => [...current.filter(row => row.id !== item.id), item])
    },
    remove(id) {
      persist(id, null)
      setItems(current => current.filter(row => row.id !== id))
    },
    retry() { for (const [id, item] of pending.current) persist(id, item) },
  }
}
