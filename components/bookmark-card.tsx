'use client'

import React, { useRef, useEffect, useState } from 'react'
import { ExternalLink, Download, FileText, Play, Pencil, X, Check, ImageOff, Bookmark, BookOpen, Folder, FolderInput, Globe, HardDrive, HardDriveDownload, Loader2, Trash2 } from 'lucide-react'
import type { BookmarkWithMedia, Category, LinkCard, ReadLaterState } from '@/lib/types'
import { archiveFileUrl } from '@/lib/archive-types'
import { fileReadLater, setReadLater, useReadLaterFolders } from '@/lib/read-later-client'
import ArchiveReader from '@/components/archive-reader'
import DeleteBookmarkDialog from '@/components/delete-bookmark-dialog'
import { ReadLaterFolderPicker } from '@/components/read-later-folders'

// ── URL helpers ────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s]+/g
// Twitter always shortens links to t.co — strip these from display text
const TCO_REGEX = /https?:\/\/t\.co\/[^\s]+/g

function extractUrls(text: string): string[] {
  return text.match(URL_REGEX) ?? []
}

/** Always strip t.co shortlinks — Twitter appends them to every tweet with a link or media */
function stripTcoUrls(text: string): string {
  return text.replace(TCO_REGEX, '').trim()
}

// ── Link card ──────────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isXHost(host: string): boolean {
  return /(^|\.)(x|twitter)\.com$/i.test(host)
}

/** Preview image: the archived copy first, then the original; hidden if neither loads */
function LinkCardImage({ card, className }: { card: LinkCard; className: string }) {
  const local = card.imagePath ? archiveFileUrl(card.imagePath) : null
  const [src, setSrc] = useState(local ?? card.imageUrl ?? null)
  if (!src) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={className}
      loading="lazy"
      onError={() => setSrc(src === local && card.imageUrl ? card.imageUrl : null)}
    />
  )
}

/** The page a post links to, like X shows it under the post */
function LinkCardView({ card, prominent = false }: { card: LinkCard; prominent?: boolean }) {
  const site = card.domain || hostOf(card.url)
  const imageKey = card.imagePath ?? card.imageUrl

  // Prominent mode: vertical layout with large image — used for link-only bookmarks
  if (prominent) {
    return (
      <a
        href={card.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-1 flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800/40 hover:border-zinc-700 hover:bg-zinc-800/70 transition-all group/link"
      >
        <LinkCardImage key={imageKey} card={card} className="w-full h-40 object-cover border-b border-zinc-800" />
        <div className="flex flex-col px-3 py-2.5 min-w-0 gap-1">
          <p className="text-sm font-semibold text-zinc-200 line-clamp-2 group-hover/link:text-white transition-colors leading-snug">
            {card.title}
          </p>
          {card.description && (
            <p className="text-xs text-zinc-400 line-clamp-3 leading-relaxed">
              {card.description}
            </p>
          )}
          <div className="flex items-center gap-1 mt-0.5">
            <Globe size={10} className="text-zinc-600 shrink-0" />
            <span className="text-[10px] text-zinc-600 truncate">{site}</span>
          </div>
        </div>
      </a>
    )
  }

  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="mt-2 flex overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800/40 hover:border-zinc-700 hover:bg-zinc-800/70 transition-all group/link"
    >
      <LinkCardImage key={imageKey} card={card} className="w-24 h-full object-cover shrink-0 border-r border-zinc-800" />
      <div className="flex flex-col justify-center px-3 py-2.5 min-w-0 gap-0.5">
        <p className="text-xs font-semibold text-zinc-200 line-clamp-1 group-hover/link:text-white transition-colors">
          {card.title}
        </p>
        {card.description && (
          <p className="text-xs text-zinc-500 line-clamp-2 leading-snug">
            {card.description}
          </p>
        )}
        <div className="flex items-center gap-1 mt-1">
          <Globe size={10} className="text-zinc-600 shrink-0" />
          <span className="text-[10px] text-zinc-600 truncate">{site}</span>
        </div>
      </div>
    </a>
  )
}

/** A link without a card: a post on X gets a "View on X" card, anything else a chip */
function LinkDestination({ url, href, prominent }: { url: string; href: string; prominent: boolean }) {
  const host = hostOf(url)
  if (isXHost(host)) {
    const path = (() => {
      try { return new URL(url).pathname } catch { return '' }
    })()
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={`${prominent ? 'mt-1' : 'mt-2'} flex items-center gap-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800/40 hover:border-zinc-700 hover:bg-zinc-800/70 transition-all group/link px-4 py-3`}
      >
        <div className="w-10 h-10 rounded-lg bg-zinc-700/60 flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-zinc-400" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-200 group-hover/link:text-white transition-colors">
            {path.startsWith('/i/article') ? 'View Article on X' : 'View on X'}
          </p>
          <p className="text-xs text-zinc-500 truncate">{host}{path}</p>
        </div>
        <ExternalLink size={14} className="text-zinc-600 group-hover/link:text-zinc-400 transition-colors shrink-0" />
      </a>
    )
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${prominent ? 'mt-1' : 'mt-2'} inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-800/40 hover:border-zinc-700 hover:bg-zinc-800/70 transition-all text-xs text-zinc-400 hover:text-zinc-200 max-w-full overflow-hidden`}
    >
      <Globe size={11} className="shrink-0 text-zinc-600" />
      <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
      <ExternalLink size={10} className="shrink-0 text-zinc-600 ml-auto" />
    </a>
  )
}

interface LinkCardLookup {
  linkCard: LinkCard | null
  /** Where the link leads, when known */
  url: string | null
}

// Module-level cache: bookmark id → looked-up card (found cards are also saved with the bookmark)
const linkCardCache = new Map<string, LinkCardLookup>()

/** Looks up (and saves) the card of a link post whose card isn't known yet. Key it by bookmark id */
function LinkPreview({ bookmarkId, url, tweetUrl, prominent = false }: { bookmarkId: string; url: string; tweetUrl: string; prominent?: boolean }) {
  const [data, setData] = useState<LinkCardLookup | 'loading'>(() => linkCardCache.get(bookmarkId) ?? 'loading')

  useEffect(() => {
    if (linkCardCache.has(bookmarkId)) return
    let cancelled = false
    fetch(`/api/bookmarks/${encodeURIComponent(bookmarkId)}/link-card`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LinkCardLookup | null) => {
        const result: LinkCardLookup = { linkCard: d?.linkCard ?? null, url: d?.url ?? null }
        linkCardCache.set(bookmarkId, result)
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setData({ linkCard: null, url: null })
      })
    return () => { cancelled = true }
  }, [bookmarkId])

  if (data === 'loading') {
    return (
      <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-800/40 h-16 animate-pulse" />
    )
  }
  if (data.linkCard) return <LinkCardView card={data.linkCard} prominent={prominent} />
  // No card: show where the link goes; an unresolved t.co opens the post itself
  return data.url
    ? <LinkDestination url={data.url} href={data.url} prominent={prominent} />
    : <LinkDestination url={url} href={tweetUrl} prominent={prominent} />
}

// Module-level cache so all cards share the same fetched list
let cachedCategories: Category[] | null = null
let cacheFetchPromise: Promise<Category[]> | null = null

if (typeof window !== 'undefined') {
  const clearCache = () => {
    cachedCategories = null
  }
  window.addEventListener('siftly:category-deleted', clearCache)
  window.addEventListener('siftly:category-updated', clearCache)
}

async function fetchAllCategories(): Promise<Category[]> {
  if (cachedCategories !== null) return cachedCategories
  if (cacheFetchPromise !== null) return cacheFetchPromise

  cacheFetchPromise = fetch('/api/categories')
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status}`)
      return res.json()
    })
    .then((data: { categories: Category[] }) => {
      cachedCategories = data.categories
      cacheFetchPromise = null
      return data.categories
    })
    .catch((err) => {
      cacheFetchPromise = null
      throw err
    })

  return cacheFetchPromise
}

const COLOR_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
]

function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length]
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ── Author Avatar ──────────────────────────────────────────────────────────────

function AuthorAvatar({ name, handle, avatarUrl }: { name: string; handle: string; avatarUrl?: string | null }) {
  const [imgFailed, setImgFailed] = useState(false)
  const bg = stringToColor(handle)
  const initials = getInitials(name)

  // Prefer stored avatar URL, fall back to unavatar.io for any Twitter handle
  const cleanHandle = handle.replace(/^@/, '')
  const src = avatarUrl ?? (cleanHandle && cleanHandle !== 'unknown' ? `https://unavatar.io/twitter/${cleanHandle}` : null)

  if (src && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="flex-shrink-0 w-8 h-8 rounded-full object-cover select-none"
        loading="lazy"
        onError={() => setImgFailed(true)}
      />
    )
  }

  return (
    <div
      className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
      style={{ backgroundColor: bg }}
      aria-hidden="true"
    >
      {initials}
    </div>
  )
}

// ── Top media slot (no margins — rendered full-bleed at top of card) ────────

function proxyUrl(url: string): string {
  return `/api/media?url=${encodeURIComponent(url)}`
}

/** Returns true if the URL points to an actual video file (not a thumbnail JPEG) */
function isVideoUrl(url: string): boolean {
  return url.includes('video.twimg.com') || url.includes('.mp4')
}

/** Derive a thumbnail URL from a Twitter video URL */
function deriveVideoThumb(url: string): string | null {
  // amplify_video/{id}/vid/... → pbs.twimg.com/amplify_video_thumb/{id}/img/default.jpg
  const amplify = url.match(/video\.twimg\.com\/amplify_video\/(\d+)/)
  if (amplify) return `https://pbs.twimg.com/amplify_video_thumb/${amplify[1]}/img/default.jpg`
  // ext_tw_video/{id}/pu/vid/... → pbs.twimg.com/ext_tw_video_thumb/{id}/pu/img/default.jpg
  const ext = url.match(/video\.twimg\.com\/ext_tw_video\/(\d+)/)
  if (ext) return `https://pbs.twimg.com/ext_tw_video_thumb/${ext[1]}/pu/img/default.jpg`
  // tweet_video/{id}.mp4 → pbs.twimg.com/tweet_video_thumb/{id}.jpg
  const tweet = url.match(/video\.twimg\.com\/tweet_video\/([^.]+)\.mp4/)
  if (tweet) return `https://pbs.twimg.com/tweet_video_thumb/${tweet[1]}.jpg`
  return null
}

interface TopMediaSlotProps {
  item: BookmarkWithMedia['mediaItems'][number]
  tweetUrl: string
}

/** Consistent overlay shown on top of a thumbnail — used for both video and X-link cases */
function MediaOverlay({ label, icon }: { label?: string; icon?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/50 transition-colors">
      {icon ?? (
        <span className="px-3 py-1.5 rounded-full bg-black/60 text-white text-xs font-semibold backdrop-blur-sm">
          {label ?? 'Watch on X ↗'}
        </span>
      )}
    </div>
  )
}

/** Placeholder shown when no thumbnail is available — styled as a proper video preview */
function MediaPlaceholder({ onClick, label, isVideo }: { onClick?: (e: React.MouseEvent) => void; label: string; isVideo?: boolean }) {
  if (isVideo) {
    return (
      <div
        className="h-48 flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-zinc-800 to-zinc-900 hover:from-zinc-750 hover:to-zinc-850 transition-colors cursor-pointer select-none"
        onClick={onClick}
      >
        <div className="w-14 h-14 rounded-full bg-white/10 hover:bg-white/20 transition-colors flex items-center justify-center border border-white/10">
          <Play size={22} className="text-white fill-white ml-1" />
        </div>
        <span className="text-xs text-zinc-400 font-medium">{label}</span>
      </div>
    )
  }
  return (
    <div
      className="h-48 flex items-center justify-center bg-zinc-800/70 hover:bg-zinc-800 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <span className="px-3 py-1.5 rounded-full bg-zinc-700 text-zinc-300 text-xs font-semibold">
        {label}
      </span>
    </div>
  )
}

function TopMediaSlot({ item, tweetUrl }: TopMediaSlotProps) {
  const [imgError, setImgError] = useState(false)
  const [localFailed, setLocalFailed] = useState(false)

  // Prefer the locally archived copy; fall back to X if it's missing
  const localSrc = item.localPath && !localFailed ? archiveFileUrl(item.localPath) : null
  const localPoster = item.localThumbnailPath ? archiveFileUrl(item.localThumbnailPath) : null

  // ── Photo: show inline ─────────────────────────────────────────────────────
  if (item.type === 'photo') {
    if (imgError) {
      return (
        <a href={tweetUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <div className="h-48 flex flex-col items-center justify-center gap-2 bg-zinc-800/50 hover:bg-zinc-800/70 transition-colors">
            <ImageOff size={18} className="text-zinc-600" />
            <span className="px-3 py-1.5 rounded-full bg-zinc-700 text-zinc-400 text-xs font-semibold">
              View on X ↗
            </span>
          </div>
        </a>
      )
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={localSrc ?? proxyUrl(item.url)}
        alt="Bookmark media"
        className="w-full h-48 object-cover"
        loading="lazy"
        onError={() => (localSrc ? setLocalFailed(true) : setImgError(true))}
      />
    )
  }

  // ── Video/GIF saved locally: play inline ──────────────────────────────────
  if (localSrc) {
    return item.type === 'gif' ? (
      <video
        src={localSrc}
        poster={localPoster ?? undefined}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-48 object-cover bg-black"
        onError={() => setLocalFailed(true)}
      />
    ) : (
      <video
        src={localSrc}
        poster={localPoster ?? undefined}
        controls
        preload="metadata"
        playsInline
        className="w-full max-h-96 bg-black"
        onError={() => setLocalFailed(true)}
      />
    )
  }

  // ── Video/GIF not archived: redirect to tweet ─────────────────────────────
  // Guard: thumbnailUrl that is itself a video URL is not usable as an <img>
  const rawThumb = item.thumbnailUrl ?? null
  const thumb = rawThumb && !isVideoUrl(rawThumb) ? rawThumb
    : (!isVideoUrl(item.url) ? item.url : deriveVideoThumb(item.url))
  const thumbSrc = localPoster ?? (thumb ? proxyUrl(thumb) : null)

  return (
    <a href={tweetUrl} target="_blank" rel="noopener noreferrer" className="relative block" onClick={(e) => e.stopPropagation()}>
      {thumbSrc && !imgError ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbSrc}
            alt=""
            className="w-full h-48 object-cover"
            loading="lazy"
            onError={() => setImgError(true)}
          />
          <MediaOverlay />
        </div>
      ) : (
        <MediaPlaceholder label="Watch on X ↗" isVideo={item.type === 'video'} />
      )}
    </a>
  )
}

// ── Category chip ──────────────────────────────────────────────────────────────

function CategoryChip({
  category,
  onRemove,
}: {
  category: BookmarkWithMedia['categories'][number]
  onRemove?: (id: string) => void
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{
        backgroundColor: `${category.color}18`,
        color: category.color,
        border: `1px solid ${category.color}30`,
      }}
    >
      <Bookmark
        size={9}
        className="flex-shrink-0"
        style={{ color: category.color, fill: category.color }}
      />
      {category.name}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove(category.id)
          }}
          className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity"
          aria-label={`Remove ${category.name}`}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

// ── Inline category editor ─────────────────────────────────────────────────────

interface CategoryEditorProps {
  bookmarkId: string
  currentCategoryIds: Set<string>
  onSave: (newIds: string[]) => void
  onClose: () => void
}

function CategoryEditor({ bookmarkId, currentCategoryIds, onSave, onClose }: CategoryEditorProps) {
  const [allCategories, setAllCategories] = useState<Category[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set(currentCategoryIds))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetchAllCategories()
      .then((cats) => {
        if (!cancelled) { setAllCategories(cats); setLoading(false) }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load categories')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (editorRef.current && !editorRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  function toggleCategory(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    const ids = Array.from(selected)
    try {
      const res = await fetch(`/api/bookmarks/${bookmarkId}/categories`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryIds: ids }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      onSave(ids)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={editorRef}
      className="absolute left-0 right-0 bottom-full mb-2 z-50 bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-2xl shadow-black/50"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs font-semibold text-zinc-500 mb-2 uppercase tracking-wide">Edit categories</p>

      {loading && <p className="text-xs text-zinc-600 py-2">Loading…</p>}

      {!loading && allCategories.length === 0 && (
        <p className="text-xs text-zinc-600 py-2">No categories found.</p>
      )}

      {!loading && allCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {allCategories.map((cat) => {
            const isSelected = selected.has(cat.id)
            return (
              <button
                key={cat.id}
                onClick={() => toggleCategory(cat.id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-all"
                style={
                  isSelected
                    ? { backgroundColor: `${cat.color}33`, color: cat.color, border: `1px solid ${cat.color}88` }
                    : { backgroundColor: 'transparent', color: '#71717a', border: '1px solid #3f3f46' }
                }
              >
                {isSelected
                  ? <Check size={10} className="flex-shrink-0" />
                  : <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-40" style={{ backgroundColor: cat.color }} />
                }
                {cat.name}
              </button>
            )
          })}
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}

      <div className="flex items-center justify-end gap-2 mt-3 pt-2 border-t border-zinc-800">
        <button onClick={onClose} className="px-2.5 py-1 text-xs rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Main card ──────────────────────────────────────────────────────────────────

interface BookmarkCardProps {
  bookmark: BookmarkWithMedia
  /** Called after the bookmark was deleted — the card hides itself either way */
  onDeleted?: (id: string) => void
  /** Called after the bookmark was put on or taken off the Read Later list, or moved to another folder */
  onReadLaterChange?: (id: string, state: ReadLaterState) => void
}

export default function BookmarkCard({ bookmark, onDeleted, onReadLaterChange }: BookmarkCardProps) {
  const [categories, setCategories] = useState(bookmark.categories)
  const [expanded, setExpanded] = useState(false)
  const [editingCategories, setEditingCategories] = useState(false)
  const [mediaItems, setMediaItems] = useState(bookmark.mediaItems)
  const [archiveStatus, setArchiveStatus] = useState(bookmark.archiveStatus ?? null)
  const [archivedAt, setArchivedAt] = useState(bookmark.archivedAt ?? null)
  const [archiving, setArchiving] = useState(false)
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null)
  const [linkCard, setLinkCard] = useState<LinkCard | null>(bookmark.linkCard ?? null)
  const [readerOpen, setReaderOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [readLaterAt, setReadLaterAt] = useState(bookmark.readLaterAt ?? null)
  const [readLaterFolderId, setReadLaterFolderId] = useState(bookmark.readLaterFolderId ?? null)
  const [readLaterSaving, setReadLaterSaving] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const { folders: readLaterFolders } = useReadLaterFolders()

  const tweetUrl = (bookmark.authorHandle && bookmark.authorHandle !== 'unknown')
    ? `https://twitter.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`
    : `https://twitter.com/i/web/status/${bookmark.tweetId}`
  const firstMedia = mediaItems[0] ?? null
  const hasMedia = mediaItems.length > 0
  const isArchived = archivedAt !== null
  const isReadLater = readLaterAt !== null
  const readLaterFolder = isReadLater ? readLaterFolders.find((f) => f.id === readLaterFolderId) ?? null : null
  const dateStr = formatDate(bookmark.tweetCreatedAt ?? bookmark.importedAt ?? null)
  const isKnownAuthor = bookmark.authorHandle !== 'unknown'

  // Always strip t.co shortlinks from display text — Twitter appends them to every tweet
  const tcoUrls = bookmark.text.match(TCO_REGEX) ?? []
  const cleanText = stripTcoUrls(bookmark.text)
  // Show the link card only when there's no real media attached (X shows one or the other)
  const showLinkCard = !hasMedia && linkCard !== null
  // Card not known yet: look it up from the post's link
  const previewUrl = !hasMedia && !linkCard && tcoUrls.length > 0 ? tcoUrls[tcoUrls.length - 1] : null

  const TEXT_LIMIT = 280
  const isLong = cleanText.length > TEXT_LIMIT
  const displayText = expanded || !isLong ? cleanText : cleanText.slice(0, TEXT_LIMIT)

  const currentCategoryIds = new Set(categories.map((c) => c.id))

  function handleRemoveCategory(categoryId: string) {
    const newIds = categories.filter((c) => c.id !== categoryId).map((c) => c.id)
    setCategories((prev) => prev.filter((c) => c.id !== categoryId))
    fetch(`/api/bookmarks/${bookmark.id}/categories`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryIds: newIds }),
    }).catch(() => { setCategories(bookmark.categories) })
  }

  function handleSaveCategories(newIds: string[]) {
    const allCats = cachedCategories ?? []
    const newCategories = newIds
      .map((id) => {
        const found = allCats.find((c) => c.id === id)
        if (!found) return null
        return { id: found.id, name: found.name, slug: found.slug, color: found.color, confidence: 1.0 }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
    setCategories(newCategories)
    setEditingCategories(false)
  }

  async function handleArchive() {
    setArchiving(true)
    setArchiveMessage(null)
    try {
      const res = await fetch(`/api/archive/${bookmark.id}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setArchiveStatus(data.status)
      setArchivedAt(data.archivedAt)
      if (Array.isArray(data.mediaItems)) setMediaItems(data.mediaItems)
      if (data.linkCard) setLinkCard(data.linkCard)
      if (data.status === 'failed') setArchiveMessage(data.warnings?.[0] ?? 'Archiving failed')
      else if (data.status === 'partial') setArchiveMessage('Saved, but some content could not be downloaded')
    } catch (err) {
      setArchiveMessage(err instanceof Error ? err.message : 'Archiving failed')
    } finally {
      setArchiving(false)
    }
  }

  async function handleToggleReadLater() {
    if (readLaterSaving) return
    const previous = { readLaterAt, readLaterFolderId }
    // Fill / empty the icon right away; put it back if saving fails
    setReadLaterAt(previous.readLaterAt ? null : new Date().toISOString())
    if (previous.readLaterAt) {
      setReadLaterFolderId(null)
      setPickingFolder(false)
    }
    setReadLaterSaving(true)
    try {
      const state = await setReadLater(bookmark.id, !previous.readLaterAt)
      setReadLaterAt(state.readLaterAt)
      setReadLaterFolderId(state.readLaterFolderId)
      onReadLaterChange?.(bookmark.id, state)
    } catch (err) {
      console.error('Read Later update failed:', err)
      setReadLaterAt(previous.readLaterAt)
      setReadLaterFolderId(previous.readLaterFolderId)
    } finally {
      setReadLaterSaving(false)
    }
  }

  async function handleMoveToFolder(folderId: string | null) {
    setPickingFolder(false)
    if (readLaterSaving || folderId === (readLaterFolder?.id ?? null)) return
    const previous = readLaterFolderId
    setReadLaterFolderId(folderId)
    setReadLaterSaving(true)
    try {
      const state = await fileReadLater(bookmark.id, folderId)
      setReadLaterAt(state.readLaterAt)
      setReadLaterFolderId(state.readLaterFolderId)
      onReadLaterChange?.(bookmark.id, state)
    } catch (err) {
      console.error('Moving to a Read Later folder failed:', err)
      setReadLaterFolderId(previous)
    } finally {
      setReadLaterSaving(false)
    }
  }

  function togglePicker(e: React.MouseEvent) {
    e.stopPropagation()
    setEditingCategories(false)
    setPickingFolder((v) => !v)
  }

  function handleDownload() {
    if (!firstMedia) return
    const a = document.createElement('a')
    a.href = firstMedia.localPath
      ? `${archiveFileUrl(firstMedia.localPath)}?download=1`
      : `/api/media?url=${encodeURIComponent(firstMedia.url)}&download=1`
    a.download = ''
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function handleDownloadMarkdown() {
    const lines: string[] = []

    // Header
    if (isKnownAuthor) {
      lines.push(`# Tweet by @${bookmark.authorHandle}`)
      lines.push('')
      lines.push(`**Author:** ${bookmark.authorName} (@${bookmark.authorHandle})`)
    } else {
      lines.push(`# Bookmarked Tweet`)
    }
    if (dateStr) lines.push(`**Date:** ${dateStr}`)
    lines.push(`**URL:** ${tweetUrl}`)
    if (categories.length > 0) {
      lines.push(`**Categories:** ${categories.map((c) => c.name).join(', ')}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')

    // Full stored text — keep URLs so truncated threads show the continuation link
    if (bookmark.text) lines.push(bookmark.text)

    if (linkCard) {
      lines.push('')
      lines.push(`**Link:** [${linkCard.title}](${linkCard.url})`)
      if (linkCard.description) lines.push(`> ${linkCard.description.replace(/\s*\n\s*/g, ' ')}`)
    }

    // If text ends with a t.co link the tweet may be part of a longer thread
    if (TCO_REGEX.test(bookmark.text)) {
      lines.push('')
      lines.push(`> *This tweet may be part of a longer thread. [Read on X ↗](${tweetUrl})*`)
    }

    // Media
    if (mediaItems.length > 0) {
      lines.push('')
      lines.push('---')
      lines.push('')
      for (const m of mediaItems) {
        if (m.type === 'photo') {
          lines.push(`![Image](${m.url})`)
        } else {
          lines.push(`[${m.type === 'video' ? 'Video' : 'GIF'} — view on X](${tweetUrl})`)
        }
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tweet-${bookmark.tweetId}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function handleDeleted(id: string) {
    setDeleted(true)
    onDeleted?.(id)
  }

  // Only show download if media is a photo or a real video (not a thumbnail JPEG stored as video)
  const isDownloadable = firstMedia !== null &&
    (firstMedia.type === 'photo' || isVideoUrl(firstMedia.url) || !!firstMedia.localPath)

  if (deleted) return null

  return (
    <div className="group relative bg-zinc-900 border border-zinc-800 rounded-2xl hover:border-zinc-700 hover:shadow-xl hover:shadow-black/30 transition-all duration-200 flex flex-col flex-1">

      {/* Top media — full bleed, no padding */}
      {firstMedia && (
        <div className="border-b border-zinc-800/60 rounded-t-2xl overflow-hidden shrink-0">
          <TopMediaSlot item={firstMedia} tweetUrl={tweetUrl} />
        </div>
      )}

      {/* Card body */}
      <div className="p-4 flex flex-col flex-1">

        {/* Author row + hover actions */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {isKnownAuthor && (
              <AuthorAvatar name={bookmark.authorName} handle={bookmark.authorHandle} />
            )}
            <div className="min-w-0">
              {isKnownAuthor && (
                <p className="text-sm font-semibold text-zinc-100 truncate leading-tight">
                  {bookmark.authorName}
                </p>
              )}
              <p className="text-xs text-zinc-500 truncate">
                {isKnownAuthor ? `@${bookmark.authorHandle}` : dateStr}
              </p>
            </div>
          </div>

          {/* Actions — visible on hover; Read Later stays visible (filled) while it's on the list */}
          <div className="flex items-center gap-0.5 flex-shrink-0 mt-0.5">
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => void handleArchive()}
                disabled={archiving}
                className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-60 transition-colors"
                title={isArchived ? 'Update local copy from X' : 'Save a full local copy (text, images, video, article)'}
              >
                {archiving ? <Loader2 size={13} className="animate-spin" /> : <HardDriveDownload size={13} />}
              </button>
              <button
                onClick={handleDownloadMarkdown}
                className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="Download as Markdown"
              >
                <FileText size={13} />
              </button>
              {isDownloadable && (
                <button
                  onClick={handleDownload}
                  className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  title="Download media"
                >
                  <Download size={13} />
                </button>
              )}
              <a
                href={tweetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="Open on X"
              >
                <ExternalLink size={13} />
              </a>
              <button
                onClick={() => setDeleteOpen(true)}
                className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete from Siftly"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <button
              onClick={() => void handleToggleReadLater()}
              aria-pressed={isReadLater}
              aria-label={isReadLater ? 'Remove from Read Later' : 'Read later'}
              className={`p-1.5 rounded-lg transition-all ${
                isReadLater
                  ? 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/10'
                  : 'text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100'
              }`}
              title={isReadLater ? 'In Read Later — click to remove' : 'Read later'}
            >
              <BookOpen size={13} className={isReadLater ? 'fill-current' : undefined} />
            </button>
          </div>
        </div>

        {/* Tweet text */}
        <div className={`flex-1 ${(showLinkCard || previewUrl) && !displayText ? '' : 'min-h-[4.5rem]'}`}>
          {displayText.length > 0 && (
            <p className="text-sm text-zinc-200 leading-relaxed">
              {displayText}
              {isLong && !expanded && (
                <span>
                  {'… '}
                  <button
                    onClick={() => setExpanded(true)}
                    className="text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    more
                  </button>
                </span>
              )}
              {isLong && expanded && (
                <span>
                  {' '}
                  <button
                    onClick={() => setExpanded(false)}
                    className="text-zinc-500 hover:text-zinc-400 transition-colors text-xs"
                  >
                    less
                  </button>
                </span>
              )}
            </p>
          )}
          {!displayText && !firstMedia && !showLinkCard && !previewUrl && (
            <p className="text-xs text-zinc-700 italic">No text content</p>
          )}
          {showLinkCard && <LinkCardView card={linkCard} prominent={!displayText} />}
          {previewUrl && (
            <LinkPreview key={bookmark.id} bookmarkId={bookmark.id} url={previewUrl} tweetUrl={tweetUrl} prominent={!displayText} />
          )}
        </div>

        {/* Footer: categories + meta — fixed two-row structure keeps all cards aligned */}
        <div className="relative mt-auto pt-3 border-t border-zinc-800/50">
          {/* Row 1: chips + date — consistent height across all cards */}
          <div className="flex items-center gap-1.5 flex-wrap min-h-[1.5rem]">
            {readLaterFolder && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={togglePicker}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/25 hover:bg-amber-500/20 transition-colors max-w-[11rem]"
                title="Read Later folder — click to move it"
              >
                <Folder size={10} className="shrink-0 fill-current" />
                <span className="truncate">{readLaterFolder.name}</span>
              </button>
            )}
            {categories.map((cat) => (
              <CategoryChip key={cat.id} category={cat} onRemove={handleRemoveCategory} />
            ))}
            {categories.length === 0 && (
              <span className="text-xs text-zinc-700 italic">Uncategorized</span>
            )}
            {(isArchived || (isKnownAuthor && dateStr)) && (
              <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                {isArchived && (
                  <button
                    onClick={() => setReaderOpen(true)}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                      archiveStatus === 'partial'
                        ? 'text-amber-400 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20'
                        : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20'
                    }`}
                    title={archiveStatus === 'partial'
                      ? 'Saved locally, but some content could not be downloaded — click to read'
                      : 'Saved locally — click to read the archived copy'}
                  >
                    <HardDrive size={10} />
                    Saved
                  </button>
                )}
                {isKnownAuthor && dateStr && (
                  <span className="text-xs text-zinc-600">{dateStr}</span>
                )}
              </span>
            )}
          </div>
          {archiveMessage && (
            <p className={`mt-1.5 text-[11px] ${archiveStatus === 'partial' ? 'text-amber-400' : 'text-red-400'}`}>
              {archiveMessage}
            </p>
          )}

          {/* Row 2: edit buttons — always in DOM to reserve space; invisible until hover */}
          <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => { setPickingFolder(false); setEditingCategories((v) => !v) }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs text-zinc-700 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent hover:border-zinc-700 transition-all"
              title="Edit categories"
            >
              <Pencil size={10} />
              edit
            </button>
            {isReadLater && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={togglePicker}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs text-zinc-700 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent hover:border-zinc-700 transition-all"
                title="Move to a Read Later folder"
              >
                <FolderInput size={10} />
                folder
              </button>
            )}
          </div>

          {pickingFolder && isReadLater && (
            <ReadLaterFolderPicker
              folderId={readLaterFolder?.id ?? null}
              onSelect={(folderId) => void handleMoveToFolder(folderId)}
              onClose={() => setPickingFolder(false)}
            />
          )}

          {editingCategories && (
            <CategoryEditor
              bookmarkId={bookmark.id}
              currentCategoryIds={currentCategoryIds}
              onSave={handleSaveCategories}
              onClose={() => setEditingCategories(false)}
            />
          )}
        </div>

      </div>

      {readerOpen && <ArchiveReader bookmarkId={bookmark.id} onClose={() => setReaderOpen(false)} />}
      {deleteOpen && (
        <DeleteBookmarkDialog
          bookmark={bookmark}
          categorySlugs={categories.map((c) => c.slug)}
          archived={isArchived}
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
