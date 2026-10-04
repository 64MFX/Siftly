'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ExternalLink, FileDown, RefreshCw, AlertTriangle, HardDrive, ImageOff, ChevronDown } from 'lucide-react'
import {
  tweetArchiveFileUrl,
  type ArchiveDocument,
  type ArchivedArticle,
  type ArchivedAuthor,
  type ArchivedLinkCard,
  type ArchivedMedia,
  type ArchivedPoll,
  type ArchivedQuote,
  type ArticleBlock,
  type TextSpan,
} from '@/lib/archive-types'

interface ArchiveResponse {
  bookmarkId: string
  status: string | null
  archivedAt: string | null
  lastError: string | null
  folder: string
  document: ArchiveDocument
}

function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Text ─────────────────────────────────────────────────────────────────────

const TEXT_TOKEN = /(https?:\/\/[^\s<>"']+)|(^|[^\w@])@(\w{1,15})\b/g

function RichText({ text, className }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(TEXT_TOKEN)) {
    const index = match.index ?? 0
    parts.push(text.slice(last, index))
    if (match[1]) {
      let url = match[1]
      let trailing = ''
      while (/[.,;:!?)\]]$/.test(url)) {
        trailing = url.slice(-1) + trailing
        url = url.slice(0, -1)
      }
      const href = safeHref(url)
      parts.push(
        href ? (
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline break-all">
            {url.replace(/^https?:\/\/(www\.)?/, '')}
          </a>
        ) : url,
        trailing,
      )
    } else {
      parts.push(
        match[2],
        <a key={key++} href={`https://x.com/${match[3]}`} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
          @{match[3]}
        </a>,
      )
    }
    last = index + match[0].length
  }
  parts.push(text.slice(last))
  return <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>{parts}</p>
}

function Spans({ spans }: { spans: TextSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        let node: React.ReactNode = s.text
        if (s.code) node = <code className="px-1 py-0.5 rounded bg-zinc-800 font-mono text-[0.9em]">{node}</code>
        if (s.bold) node = <strong className="font-semibold text-zinc-100">{node}</strong>
        if (s.italic) node = <em>{node}</em>
        if (s.strike) node = <s>{node}</s>
        const href = safeHref(s.href)
        if (href) node = <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">{node}</a>
        return <React.Fragment key={i}>{node}</React.Fragment>
      })}
    </>
  )
}

// ── Media ────────────────────────────────────────────────────────────────────

function LocalMedia({ m, folder, fill = false }: { m: ArchivedMedia; folder: string; fill?: boolean }) {
  const src = m.file ? tweetArchiveFileUrl(folder, m.file) : null
  const poster = m.posterFile ? tweetArchiveFileUrl(folder, m.posterFile) : undefined
  const sizing = fill ? 'w-full h-full object-cover' : 'w-full max-h-[75vh] object-contain'

  if (!src) {
    return (
      <div className="relative flex min-h-32 h-full items-center justify-center bg-zinc-800/60 text-xs text-zinc-500">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />}
        <span className="relative flex items-center gap-1.5 px-3 text-center">
          <ImageOff size={13} /> {m.type === 'photo' ? 'Image' : m.type === 'gif' ? 'GIF' : 'Video'} wasn&apos;t saved
        </span>
      </div>
    )
  }
  if (m.type === 'photo') {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block h-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={m.altText ?? ''} title={m.altText} className={`${sizing} bg-black`} loading="lazy" />
      </a>
    )
  }
  if (m.type === 'gif') {
    return <video src={src} poster={poster} autoPlay loop muted playsInline className={`${sizing} bg-black`} />
  }
  return <video src={src} poster={poster} controls preload="metadata" playsInline className={`${sizing} bg-black`} />
}

function MediaGrid({ media, folder }: { media: ArchivedMedia[]; folder: string }) {
  if (media.length === 0) return null
  if (media.length === 1) {
    return (
      <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
        <LocalMedia m={media[0]} folder={folder} />
      </div>
    )
  }
  return (
    <div className="mt-3 grid grid-cols-2 gap-1 overflow-hidden rounded-xl border border-zinc-800">
      {media.map((m, i) => (
        <div key={i} className={`h-56 ${media.length === 3 && i === 0 ? 'row-span-2 h-[28.25rem]' : ''}`}>
          <LocalMedia m={m} folder={folder} fill />
        </div>
      ))}
    </div>
  )
}

// ── Author, card, poll, quote ────────────────────────────────────────────────

function Author({ author, date, folder, small = false }: { author: ArchivedAuthor; date: string | null; folder: string; small?: boolean }) {
  const size = small ? 'w-6 h-6 text-[10px]' : 'w-10 h-10 text-sm'
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      {author.avatarFile ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={tweetArchiveFileUrl(folder, author.avatarFile)} alt="" className={`${size} shrink-0 rounded-full object-cover`} />
      ) : (
        <div className={`${size} shrink-0 rounded-full bg-indigo-600 flex items-center justify-center font-bold text-white`}>
          {(author.name || author.handle || '?').slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <p className={`${small ? 'text-xs' : 'text-sm'} font-semibold text-zinc-100 truncate`}>{author.name || 'Unknown'}</p>
        <p className="text-xs text-zinc-500 truncate">
          {author.handle && author.handle !== 'unknown' ? `@${author.handle}` : ''}
          {author.handle && date ? ' · ' : ''}
          {formatDateTime(date)}
        </p>
      </div>
    </div>
  )
}

function LinkCard({ card, folder }: { card: ArchivedLinkCard; folder: string }) {
  const href = safeHref(card.url)
  const body = (
    <>
      {card.imageFile && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={tweetArchiveFileUrl(folder, card.imageFile)} alt="" className="w-full max-h-64 object-cover border-b border-zinc-800" />
      )}
      <div className="px-3 py-2.5">
        <p className="text-sm font-semibold text-zinc-200">{card.title}</p>
        {card.description && <p className="text-xs text-zinc-400 mt-0.5 line-clamp-3">{card.description}</p>}
        {card.domain && <p className="text-[11px] text-zinc-600 mt-1">{card.domain}</p>}
      </div>
    </>
  )
  const className = 'mt-3 block overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800/40'
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className={`${className} hover:border-zinc-700`}>{body}</a> : <div className={className}>{body}</div>
}

function Poll({ poll }: { poll: ArchivedPoll }) {
  const total = poll.choices.reduce((sum, c) => sum + (c.votes ?? 0), 0)
  return (
    <div className="mt-3 space-y-1.5 rounded-xl border border-zinc-800 p-3">
      {poll.choices.map((c, i) => {
        const pct = total > 0 && c.votes !== undefined ? Math.round((c.votes / total) * 100) : null
        return (
          <div key={i} className="relative overflow-hidden rounded-lg px-3 py-1.5 text-sm text-zinc-200">
            <div className="absolute inset-y-0 left-0 bg-indigo-500/20" style={{ width: `${pct ?? 0}%` }} />
            <div className="relative flex justify-between gap-3">
              <span>{c.label}</span>
              {pct !== null && <span className="text-zinc-500">{pct}%</span>}
            </div>
          </div>
        )
      })}
      {total > 0 && <p className="text-xs text-zinc-500">{total.toLocaleString()} votes</p>}
    </div>
  )
}

function Quote({ quote, folder }: { quote: ArchivedQuote; folder: string }) {
  const href = safeHref(quote.tweetUrl)
  if (quote.unavailable && !quote.text && quote.media.length === 0) {
    return <div className="mt-3 rounded-xl border border-zinc-800 p-3 text-xs text-zinc-500">Quoted post unavailable</div>
  }
  return (
    <div className="mt-3 rounded-xl border border-zinc-800 p-3">
      <Author author={quote.author} date={quote.createdAt} folder={folder} small />
      {quote.text && <RichText text={quote.text} className="mt-2 text-sm text-zinc-300 leading-relaxed" />}
      <MediaGrid media={quote.media} folder={folder} />
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300">
          View quoted post on X <ExternalLink size={10} />
        </a>
      )}
    </div>
  )
}

// ── Article ──────────────────────────────────────────────────────────────────

function Block({ block, folder }: { block: ArticleBlock; folder: string }) {
  switch (block.type) {
    case 'paragraph':
      return <p className="whitespace-pre-wrap"><Spans spans={block.spans} /></p>
    case 'heading1':
      return <h2 className="text-2xl font-bold text-zinc-100 pt-4"><Spans spans={block.spans} /></h2>
    case 'heading2':
      return <h3 className="text-xl font-bold text-zinc-100 pt-3"><Spans spans={block.spans} /></h3>
    case 'heading3':
      return <h4 className="text-lg font-semibold text-zinc-100 pt-2"><Spans spans={block.spans} /></h4>
    case 'blockquote':
      return <blockquote className="border-l-2 border-indigo-500 pl-4 text-zinc-400 italic"><Spans spans={block.spans} /></blockquote>
    case 'unordered-list':
      return <ul className="list-disc pl-6 space-y-1">{block.items.map((item, i) => <li key={i}><Spans spans={item} /></li>)}</ul>
    case 'ordered-list':
      return <ol className="list-decimal pl-6 space-y-1">{block.items.map((item, i) => <li key={i}><Spans spans={item} /></li>)}</ol>
    case 'code':
      return <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm"><code className="font-mono text-zinc-300">{block.text}</code></pre>
    case 'media':
      return (
        <figure className="space-y-2">
          {block.media.map((m, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-zinc-800">
              <LocalMedia m={m} folder={folder} />
            </div>
          ))}
          {block.caption && <figcaption className="text-center text-sm text-zinc-500">{block.caption}</figcaption>}
        </figure>
      )
    case 'embedded-tweet': {
      const href = safeHref(block.tweetUrl)
      return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-800/30 p-3 text-sm">
          {block.authorName && (
            <p className="font-semibold text-zinc-200">
              {block.authorName} {block.authorHandle && <span className="font-normal text-zinc-500">@{block.authorHandle}</span>}
            </p>
          )}
          {block.text ? <RichText text={block.text} className="mt-1 text-zinc-300" /> : <p className="text-zinc-500">Embedded post</p>}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300">
              View on X <ExternalLink size={10} />
            </a>
          )}
        </div>
      )
    }
    case 'divider':
      return <hr className="border-zinc-800" />
  }
}

function Article({ article, folder }: { article: ArchivedArticle; folder: string }) {
  return (
    <article className="mt-6 border-t border-zinc-800 pt-6">
      {article.coverImage && (
        <div className="mb-5 overflow-hidden rounded-xl border border-zinc-800">
          <LocalMedia m={article.coverImage} folder={folder} />
        </div>
      )}
      <h1 className="text-3xl font-bold leading-tight text-zinc-100">{article.title || 'Untitled article'}</h1>
      <div className="mt-5 space-y-4 text-[15px] leading-7 text-zinc-300">
        {article.blocks.length > 0 ? (
          article.blocks.map((block, i) => <Block key={i} block={block} folder={folder} />)
        ) : (
          <>
            {article.previewText && <p>{article.previewText}</p>}
            <p className="text-sm italic text-zinc-500">Only the article preview was available when this was saved.</p>
          </>
        )}
      </div>
    </article>
  )
}

// ── Reader modal ─────────────────────────────────────────────────────────────

interface ArchiveReaderProps {
  bookmarkId: string
  onClose: () => void
  /** Called after a successful re-archive so the caller can refresh its copy */
  onArchived?: () => void
}

export default function ArchiveReader({ bookmarkId, onClose, onArchived }: ArchiveReaderProps) {
  const [data, setData] = useState<ArchiveResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showWarnings, setShowWarnings] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/archive/${encodeURIComponent(bookmarkId)}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setData(body as ArchiveResponse)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load archived copy')
    }
  }, [bookmarkId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    // Capture phase so Escape closes only the reader when it sits on top of another modal
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/archive/${encodeURIComponent(bookmarkId)}`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      await load()
      onArchived?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-archive failed')
    } finally {
      setRefreshing(false)
    }
  }

  const doc = data?.document
  const folder = data?.folder ?? ''

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="relative mx-auto my-12 w-full max-w-2xl px-4" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-4 rounded-full p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 sm:p-6">
          {!doc && !error && <div className="h-40 animate-pulse rounded-xl bg-zinc-800/60" />}
          {error && !doc && <p className="text-sm text-red-400">{error}</p>}

          {doc && (
            <>
              {/* Archive banner */}
              <div className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 text-xs ${
                doc.unavailableOnX ? 'border-amber-600/40 bg-amber-500/10 text-amber-400' : 'border-zinc-800 bg-zinc-800/40 text-zinc-400'
              }`}>
                <span className="flex items-center gap-1.5">
                  <HardDrive size={12} />
                  {doc.unavailableOnX ? 'No longer on X — ' : ''}Saved locally {formatDateTime(doc.archivedAt)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                    title="Fetch the latest version from X and update the local copy"
                  >
                    <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Updating…' : 'Update'}
                  </button>
                  <a
                    href={tweetArchiveFileUrl(folder, 'index.html')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                    title="Open the standalone offline page"
                  >
                    <FileDown size={11} /> Offline page
                  </a>
                  <a
                    href={doc.tweetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <ExternalLink size={11} /> X
                  </a>
                </div>
              </div>

              {doc.warnings.length > 0 && (
                <div className="mb-4 rounded-xl border border-amber-600/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
                  <button onClick={() => setShowWarnings((v) => !v)} className="flex w-full items-center gap-1.5 text-left">
                    <AlertTriangle size={12} className="shrink-0" />
                    {data?.status === 'partial' ? 'Some content could not be saved' : 'Notes from archiving'} ({doc.warnings.length})
                    <ChevronDown size={12} className={`ml-auto transition-transform ${showWarnings ? 'rotate-180' : ''}`} />
                  </button>
                  {showWarnings && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-300/80">
                      {doc.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}
                </div>
              )}
              {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

              <Author author={doc.author} date={doc.createdAt} folder={folder} />
              {doc.text && <RichText text={doc.text} className="mt-3 text-[15px] leading-relaxed text-zinc-200" />}
              <MediaGrid media={doc.media} folder={folder} />
              {doc.poll && <Poll poll={doc.poll} />}
              {doc.card && <LinkCard card={doc.card} folder={folder} />}
              {doc.quote && <Quote quote={doc.quote} folder={folder} />}
              {doc.article && <Article article={doc.article} folder={folder} />}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
