'use client'

import { useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Category } from '@/lib/types'

interface DeleteCategoryDialogProps {
  category: Pick<Category, 'name' | 'slug'> & { bookmarkCount?: number }
  open: boolean
  onClose: () => void
  onDeleted: (slug: string) => void
}

export default function DeleteCategoryDialog({ category, open, onClose, onDeleted }: DeleteCategoryDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleDelete() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(category.slug)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete category')
      window.dispatchEvent(new CustomEvent('siftly:category-deleted', { detail: { slug: category.slug } }))
      onDeleted(category.slug)
      onClose()
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

  const count = category.bookmarkCount ?? 0

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl shadow-black/50 focus:outline-none animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-start gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Trash2 size={18} className="text-red-400" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-zinc-100">Delete category?</Dialog.Title>
              <Dialog.Description className="text-sm text-zinc-400 mt-1 leading-relaxed">
                <span className="font-medium text-zinc-200">{category.name}</span> will be permanently removed.
                {count > 0
                  ? ` Its ${count.toLocaleString()} bookmark${count !== 1 ? 's' : ''} will be kept but no longer assigned to it.`
                  : ' Your bookmarks will not be deleted.'}
              </Dialog.Description>
            </div>
          </div>

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
