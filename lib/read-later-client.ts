'use client'

/**
 * Browser side of Read Later: the folder list with counts, shared by every
 * card, the Read Later tabs and the sidebar, and the calls that change it.
 * Refreshes whenever a bookmark is added, removed, moved or deleted.
 */
import { useSyncExternalStore } from 'react'
import type { ReadLaterFolder, ReadLaterFolders, ReadLaterState } from '@/lib/types'

/** Detail of the `siftly:read-later-changed` window event, sent when a bookmark is added, removed or moved */
export type ReadLaterChangedDetail = ReadLaterState

/** Folders and counts; `loaded` turns true once the first answer is in */
export type ReadLaterFoldersSnapshot = ReadLaterFolders & { loaded: boolean }

const EMPTY: ReadLaterFoldersSnapshot = { total: 0, unsorted: 0, folders: [], loaded: false }
let snapshot = EMPTY
let requested = false
let latestRequest = 0
const listeners = new Set<() => void>()

function publish(next: ReadLaterFolders) {
  snapshot = { ...next, loaded: true }
  for (const listener of listeners) listener()
}

/** Reload folders and counts; only the latest of overlapping requests counts */
export function refreshReadLaterFolders(): Promise<void> {
  requested = true
  const request = ++latestRequest
  return fetch('/api/read-later/folders')
    .then((r) => (r.ok ? r.json() : null))
    .then((d: ReadLaterFolders | null) => {
      if (d && request === latestRequest) publish(d)
    })
    .catch(() => {})
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!requested) void refreshReadLaterFolders()
  return () => {
    listeners.delete(listener)
  }
}

/** Folders with counts, plus the list's total and Unsorted count — loads on first use */
export function useReadLaterFolders(): ReadLaterFoldersSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY)
}

if (typeof window !== 'undefined') {
  const refresh = () => {
    if (requested) void refreshReadLaterFolders()
  }
  window.addEventListener('siftly:read-later-changed', refresh)
  window.addEventListener('siftly:bookmark-deleted', refresh)
  window.addEventListener('siftly:cleared', refresh)
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

function announce(state: ReadLaterState) {
  window.dispatchEvent(new CustomEvent<ReadLaterChangedDetail>('siftly:read-later-changed', { detail: state }))
}

// ── Bookmarks ────────────────────────────────────────────────────────────────

/** Put a bookmark on the Read Later list, or take it off (and out of its folder) */
export async function setReadLater(bookmarkId: string, onList: boolean): Promise<ReadLaterState> {
  const state = await send<ReadLaterState>(`/api/bookmarks/${encodeURIComponent(bookmarkId)}/read-later`, onList ? 'POST' : 'DELETE')
  announce(state)
  return state
}

/** File a bookmark in a folder (null = Unsorted); puts it on the list if needed */
export async function fileReadLater(bookmarkId: string, folderId: string | null): Promise<ReadLaterState> {
  const state = await send<ReadLaterState>(`/api/bookmarks/${encodeURIComponent(bookmarkId)}/read-later`, 'PUT', { folderId })
  announce(state)
  return state
}

// ── Folders ──────────────────────────────────────────────────────────────────

export async function createReadLaterFolder(name: string): Promise<ReadLaterFolder> {
  const { folder } = await send<{ folder: ReadLaterFolder }>('/api/read-later/folders', 'POST', { name })
  await refreshReadLaterFolders()
  return folder
}

export async function renameReadLaterFolder(id: string, name: string): Promise<ReadLaterFolder> {
  const { folder } = await send<{ folder: ReadLaterFolder }>(`/api/read-later/folders/${encodeURIComponent(id)}`, 'PATCH', { name })
  await refreshReadLaterFolders()
  return folder
}

/** Delete a folder — its bookmarks stay on the list, Unsorted */
export async function deleteReadLaterFolder(id: string): Promise<void> {
  await send(`/api/read-later/folders/${encodeURIComponent(id)}`, 'DELETE')
  await refreshReadLaterFolders()
}
