'use client'

import { useState } from 'react'
import { Pencil, Loader2, X } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Category } from '@/lib/types'

export const PRESET_COLORS = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
]

export interface CategoryUpdatedDetail {
  category: Category
}

interface EditCategoryDialogProps {
  category: Pick<Category, 'name' | 'slug' | 'color' | 'description'>
  open: boolean
  onClose: () => void
  onSaved: (category: Category) => void
}

export default function EditCategoryDialog({ category, open, onClose, onSaved }: EditCategoryDialogProps) {
  const [name, setName] = useState(category.name)
  const [description, setDescription] = useState(category.description ?? '')
  const [color, setColor] = useState(category.color)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Keep the category's current color pickable even when it isn't one of the presets
  const colors = PRESET_COLORS.includes(category.color) ? PRESET_COLORS : [category.color, ...PRESET_COLORS]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Category name is required')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(category.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, color }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to update category')
      window.dispatchEvent(new CustomEvent<CategoryUpdatedDetail>('siftly:category-updated', {
        detail: { category: data.category },
      }))
      onSaved(data.category)
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

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl shadow-black/50 focus:outline-none animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between mb-6">
            <div>
              <Dialog.Title className="text-lg font-semibold text-zinc-100">Edit Category</Dialog.Title>
              <Dialog.Description className="text-sm text-zinc-500 mt-0.5">
                The description guides AI categorization
              </Dialog.Description>
            </div>
            <button
              onClick={handleClose}
              disabled={loading}
              aria-label="Close"
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
                className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all duration-200"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Color</label>
              <div className="flex gap-2.5 flex-wrap">
                {colors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    title={c}
                    className={`w-8 h-8 rounded-full transition-all duration-150 focus:outline-none ${
                      color === c
                        ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110'
                        : 'hover:scale-110 hover:ring-1 hover:ring-white/30 hover:ring-offset-1 hover:ring-offset-zinc-900'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                Description{' '}
                <span className="text-zinc-600 font-normal">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this category..."
                maxLength={1000}
                rows={4}
                className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all duration-200 resize-none"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <X size={14} className="shrink-0" />
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors border border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={14} />}
                {loading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
