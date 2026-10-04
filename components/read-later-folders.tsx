'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { BookOpen, Check, Folder, FolderPlus, Inbox, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { READ_LATER_FOLDER_NAME_MAX, type ReadLaterFolder } from '@/lib/types'
import {
  createReadLaterFolder,
  deleteReadLaterFolder,
  renameReadLaterFolder,
  useReadLaterFolders,
} from '@/lib/read-later-client'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}

// ── Folder picker (on a card) ───────────────────────────────────────────────

interface ReadLaterFolderPickerProps {
  /** The folder the bookmark is in now — null for Unsorted */
  folderId: string | null
  onSelect: (folderId: string | null) => void
  onClose: () => void
}

/** Popover above a card's footer: move the bookmark to a folder, Unsorted, or a new folder */
export function ReadLaterFolderPicker({ folderId, onSelect, onClose }: ReadLaterFolderPickerProps) {
  const { folders } = useReadLaterFolders()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const current = folderId && folders.some((f) => f.id === folderId) ? folderId : null

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Capture phase + preventDefault: the detail view this card may be in stays open
      e.preventDefault()
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!newName.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const folder = await createReadLaterFolder(newName)
      onSelect(folder.id)
    } catch (err) {
      setError(errorMessage(err))
      setCreating(false)
    }
  }

  const option = (key: string, label: string, icon: React.ReactNode, selected: boolean, onClick: () => void, count?: number) => (
    <button
      key={key}
      onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors ${
        selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
      }`}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="text-[11px] text-zinc-600 tabular-nums">{count}</span>}
      <Check size={12} className={`shrink-0 ${selected ? 'text-indigo-400' : 'invisible'}`} />
    </button>
  )

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 bottom-full mb-2 z-50 bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-2xl shadow-black/50"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs font-semibold text-zinc-500 mb-2 uppercase tracking-wide">Read Later folder</p>
      <div className="flex flex-col gap-0.5 max-h-44 overflow-y-auto">
        {option('none', 'Unsorted', <Inbox size={12} className="shrink-0 text-zinc-500" />, current === null, () => onSelect(null))}
        {folders.map((f) =>
          option(f.id, f.name, <Folder size={12} className="shrink-0 text-amber-500 fill-current" />, current === f.id, () => onSelect(f.id), f.count),
        )}
      </div>
      <form onSubmit={(e) => void handleCreate(e)} className="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-800">
        <FolderPlus size={12} className="shrink-0 text-zinc-600" />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={READ_LATER_FOLDER_NAME_MAX}
          placeholder="New folder…"
          aria-label="New folder name"
          className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none py-1"
        />
        <button
          type="submit"
          disabled={!newName.trim() || creating}
          className="px-2.5 py-1 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}

// ── Tabs (on the Read Later page) ───────────────────────────────────────────

/** Selected tab: '' = All, 'none' = Unsorted, otherwise a folder id */
export type ReadLaterTab = string

interface TabProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count: number
  children?: React.ReactNode
}

function Tab({ active, onClick, icon, label, count, children }: TabProps) {
  return (
    <div
      className={`inline-flex items-center rounded-xl border text-sm transition-all ${
        active
          ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
      }`}
    >
      <button onClick={onClick} aria-pressed={active} className="inline-flex items-center gap-2 px-3 py-1.5 font-medium">
        {icon}
        <span className="max-w-[14rem] truncate">{label}</span>
        <span className="text-xs text-zinc-500 tabular-nums font-normal">{count}</span>
      </button>
      {children && <span className="flex items-center -ml-1.5 pr-1">{children}</span>}
    </div>
  )
}

/**
 * Inline name field for a new or renamed folder: Enter saves (a problem shows
 * under it), Escape cancels, and leaving it saves — or cancels if that fails.
 */
function FolderNameInput({ initial = '', placeholder, onSubmit, onCancel }: {
  initial?: string
  placeholder: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closed = useRef(false)

  function cancel() {
    closed.current = true
    onCancel()
  }

  async function submit(leaving: boolean) {
    if (busy || closed.current) return
    const name = value.trim()
    if (!name || name === initial) return cancel()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name)
      closed.current = true
    } catch (err) {
      if (leaving) return cancel()
      // Read-only while saving, so the field kept focus: fix the name and press Enter again
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="relative inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-indigo-500/60 bg-zinc-900 text-sm">
      {busy ? <Loader2 size={13} className="shrink-0 text-zinc-500 animate-spin" /> : <Folder size={13} className="shrink-0 text-amber-500 fill-current" />}
      <input
        autoFocus
        value={value}
        onChange={(e) => { setValue(e.target.value); setError(null) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(false) }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        onBlur={() => void submit(true)}
        readOnly={busy}
        maxLength={READ_LATER_FOLDER_NAME_MAX}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-40 bg-transparent text-zinc-100 placeholder:text-zinc-600 focus:outline-none font-medium"
      />
      {error && (
        <span className="absolute left-0 top-full mt-1 z-10 px-2 py-1 rounded-lg bg-zinc-900 border border-red-500/30 text-xs text-red-400 whitespace-nowrap">
          {error}
        </span>
      )}
    </div>
  )
}

function DeleteFolderDialog({ folder, onClose, onDeleted }: {
  folder: ReadLaterFolder | null
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    if (!folder) return
    setBusy(true)
    setError(null)
    try {
      await deleteReadLaterFolder(folder.id)
      onDeleted(folder.id)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={folder !== null} onOpenChange={(open) => { if (!open && !busy) { setError(null); onClose() } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[calc(100%-2rem)] max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl shadow-black/50 focus:outline-none animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-start gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Trash2 size={18} className="text-red-400" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-zinc-100">Delete folder?</Dialog.Title>
              <Dialog.Description className="text-sm text-zinc-400 mt-1 leading-relaxed">
                <span className="font-medium text-zinc-200">{folder?.name}</span> will be deleted.{' '}
                {folder && folder.count > 0
                  ? `Its ${folder.count === 1 ? 'bookmark stays' : `${folder.count} bookmarks stay`} in Read Later, under Unsorted.`
                  : 'It has no bookmarks in it.'}
              </Dialog.Description>
            </div>
          </div>
          {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button disabled={busy} className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => void handleDelete()}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete folder
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface ReadLaterTabsProps {
  selected: ReadLaterTab
  onSelect: (tab: ReadLaterTab) => void
}

/** All · Unsorted · the user's folders · New folder — the selected folder can be renamed or deleted */
export function ReadLaterTabs({ selected, onSelect }: ReadLaterTabsProps) {
  const { total, unsorted, folders, loaded } = useReadLaterFolders()
  const [adding, setAdding] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ReadLaterFolder | null>(null)

  // The selected folder is gone (deleted, or a stale link): show everything
  const selectedMissing = loaded && selected !== '' && selected !== 'none' && !folders.some((f) => f.id === selected)
  useEffect(() => {
    if (selectedMissing) onSelect('')
  }, [selectedMissing, onSelect])

  return (
    <div className="flex items-center gap-2 flex-wrap mb-5">
      <Tab active={selected === ''} onClick={() => onSelect('')} icon={<BookOpen size={13} className="shrink-0 text-amber-500" />} label="All" count={total} />
      {folders.length > 0 && (
        <Tab active={selected === 'none'} onClick={() => onSelect('none')} icon={<Inbox size={13} className="shrink-0 text-zinc-500" />} label="Unsorted" count={unsorted} />
      )}
      {folders.map((f) =>
        renamingId === f.id ? (
          <FolderNameInput
            key={f.id}
            initial={f.name}
            placeholder="Folder name"
            onSubmit={async (name) => { await renameReadLaterFolder(f.id, name); setRenamingId(null) }}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <Tab
            key={f.id}
            active={selected === f.id}
            onClick={() => onSelect(f.id)}
            icon={<Folder size={13} className="shrink-0 text-amber-500 fill-current" />}
            label={f.name}
            count={f.count}
          >
            {selected === f.id && (
              <>
                <button
                  onClick={() => setRenamingId(f.id)}
                  className="p-1 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60 transition-colors"
                  title="Rename folder"
                  aria-label={`Rename ${f.name}`}
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => setDeleting(f)}
                  className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Delete folder"
                  aria-label={`Delete ${f.name}`}
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
          </Tab>
        ),
      )}
      {adding ? (
        <FolderNameInput
          placeholder="New folder name"
          onSubmit={async (name) => { await createReadLaterFolder(name); setAdding(false) }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
        >
          <Plus size={13} />
          New folder
        </button>
      )}
      <DeleteFolderDialog
        folder={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => { if (selected === id) onSelect('') }}
      />
    </div>
  )
}
