'use client'

import { useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { BookmarkWithMedia } from '@/lib/types'

export interface BookmarkDeletedDetail {
  id: string
  categorySlugs: string[]
}

interface DeleteBookmarkDialogProps {
  bookmark: Pick<BookmarkWithMedia, 'id' | 'text' | 'authorHandle'>
  /** Slugs of the categories it is in now, so the sidebar counts can drop */
  categorySlugs: string[]
  /** Has a local archive copy — offers to delete it too */
  archived: boolean
  open: boolean
  onClose: () => void
  onDeleted: (id: string) => void
}

export default function DeleteBookmarkDialog({ bookmark, categorySlugs, archived, open, onClose, onDeleted }: DeleteBookmarkDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deleteArchive, setDeleteArchive] = useState(true)

  async function handleDelete() {
    setError('')
    setLoading(true)
    try {
      const query = archived && deleteArchive ? '?deleteArchive=true' : ''
      const res = await fetch(`/api/bookmarks/${encodeURIComponent(bookmark.id)}${query}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete bookmark')
      if (data.warning) window.alert(data.warning)
      window.dispatchEvent(new CustomEvent<BookmarkDeletedDetail>('siftly:bookmark-deleted', {
        detail: { id: bookmark.id, categorySlugs },
      }))
      onClose()
      onDeleted(bookmark.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() {
    if (loading) return
    setError('')
    onClose()
  }

  const author = bookmark.authorHandle && bookmark.authorHandle !== 'unknown' ? `@${bookmark.authorHandle}` : null
  const snippet = bookmark.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        {/* Above the compact view's detail modal (z-50) */}
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[calc(100%-2rem)] max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl shadow-black/50 focus:outline-none animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-start gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Trash2 size={18} className="text-red-400" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-zinc-100">Delete bookmark?</Dialog.Title>
              <Dialog.Description className="text-sm text-zinc-400 mt-1 leading-relaxed">
                {author ? <>This post by <span className="font-medium text-zinc-200">{author}</span></> : 'This post'} will be
                permanently removed from Siftly. It stays bookmarked on X, so a later sync or import can add it back.
              </Dialog.Description>
              {snippet && (
                <p className="mt-3 text-xs text-zinc-500 leading-relaxed line-clamp-2 border-l-2 border-zinc-700 pl-2.5">{snippet}</p>
              )}
            </div>
          </div>

          {archived && (
            <label className="flex items-start gap-2.5 mb-5 px-3 py-2.5 rounded-xl bg-zinc-800/50 border border-zinc-800 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deleteArchive}
                onChange={(e) => setDeleteArchive(e.target.checked)}
                disabled={loading}
                className="mt-0.5 accent-red-500"
              />
              <span className="text-sm text-zinc-300 leading-snug">
                Also delete its saved local copy
                <span className="block text-xs text-zinc-500 mt-0.5">Removes its folder (text, images, video) from your archive folder</span>
              </span>
            </label>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">{error}</p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {loading ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
