'use client'

import { Fragment, useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, BookMarked, AlertCircle, ImageIcon, FileText, MessageSquareText } from 'lucide-react'
import BookmarkCard from '@/components/bookmark-card'
import type { BookmarkWithMedia } from '@/lib/types'

// Extends BookmarkWithMedia with AI-specific fields returned by the search API
interface AIBookmark extends BookmarkWithMedia {
  aiScore: number
  aiReason: string
}

/** A result with the number the answer cites it by — kept when others are deleted */
type NumberedResult = AIBookmark & { num: number }

interface SearchResponse {
  bookmarks?: AIBookmark[]
  explanation?: string
  answer?: string | null
  notice?: string
  considered?: number
  error?: string
}

interface IndexStats {
  bookmarks: number
  indexed: number
  articles: number
  fullArticles: number
}

const EXAMPLES = [
  'What have people said about fine-tuning small models?',
  'articles about building a startup',
  'funny meme about AI replacing developers',
  'Solana DeFi tools I should try',
  'that video explaining how transformers work',
  'something about productivity and focus',
]

interface ImageStats {
  total: number
  tagged: number
  remaining: number
}

/** Answer text with [1] / [2, 3] citations as links to the numbered results */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g)
  return (
    <>
      {parts.map((part, i) => {
        const cite = part.match(/^\[(\d+(?:,\s*\d+)*)\]$/)
        if (!cite) return <Fragment key={i}>{part}</Fragment>
        return (
          <span key={i} className="whitespace-nowrap">
            {cite[1].split(',').map((n) => n.trim()).map((n, j) => (
              <a
                key={j}
                href={`#result-${n}`}
                className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 mx-0.5 rounded-md bg-indigo-500/15 text-indigo-400 text-[11px] font-medium align-text-top hover:bg-indigo-500/25 transition-colors"
              >
                {n}
              </a>
            ))}
          </span>
        )
      })}
    </>
  )
}

export default function AISearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NumberedResult[]>([])
  const [explanation, setExplanation] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [considered, setConsidered] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null)
  const [imageStats, setImageStats] = useState<ImageStats | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // Also indexes new bookmarks, so the first search doesn't wait for it
    fetch('/api/search/ai')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: IndexStats | null) => setIndexStats(data))
      .catch(() => {})
    // Load image analysis progress
    fetch('/api/analyze/images')
      .then((r) => r.json())
      .then((data: ImageStats) => setImageStats(data))
      .catch(() => {})
    // Hide standalone image analysis when the main pipeline is already handling it
    fetch('/api/categorize')
      .then((r) => r.json())
      .then((d: { status: string }) => {
        if (d.status === 'running' || d.status === 'stopping') setPipelineRunning(true)
      })
      .catch(() => {})
  }, [])

  async function handleAnalyzeImages() {
    if (analyzing) return
    setAnalyzing(true)
    try {
      // Run batches until ALL images are processed (no cap)
      while (true) {
        const res = await fetch('/api/analyze/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: 50 }),
        })
        const data = (await res.json()) as { analyzed: number; remaining: number }
        setImageStats((prev) =>
          prev ? { ...prev, tagged: prev.total - data.remaining, remaining: data.remaining } : null,
        )
        if (data.remaining === 0) break
      }
    } catch {
      // silent — refresh stats on error
      const statsRes = await fetch('/api/analyze/images')
      const stats = (await statsRes.json()) as ImageStats
      setImageStats(stats)
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleSearch(text = query) {
    const q = text.trim()
    if (!q || loading) return
    setLoading(true)
    setError('')
    setResults([])
    setExplanation('')
    setAnswer(null)
    setNotice('')
    setSearched(true)
    try {
      const res = await fetch('/api/search/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      const data = (await res.json()) as SearchResponse
      if (!res.ok) throw new Error(data.error ?? 'Search failed')
      setResults((data.bookmarks ?? []).map((b, i) => ({ ...b, num: i + 1 })))
      setExplanation(data.explanation ?? '')
      setAnswer(data.answer ?? null)
      setNotice(data.notice ?? '')
      setConsidered(data.considered ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handleSearch()
    }
  }

  function handleExampleClick(example: string) {
    setQuery(example)
    void handleSearch(example)
  }

  const previewArticles = indexStats ? indexStats.articles - indexStats.fullArticles : 0

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-medium mb-4">
          <Sparkles size={12} /> AI-Powered Search
        </div>
        <h1 className="text-3xl font-bold text-zinc-100 mb-2">
          Find anything in your bookmarks
        </h1>
        <p className="text-zinc-500 text-sm">
          Describe what you&apos;re looking for, or ask a question — the AI reads your posts, quoted posts, links and full X Articles.
        </p>
      </div>

      {/* Search box */}
      <div className="relative mb-3">
        <textarea
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`e.g. "that funny meme about devs crying over AI" or "what did people say about Rust vs Go?"`}
          rows={3}
          className="w-full px-4 py-4 pr-36 rounded-2xl bg-zinc-900 border border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-all resize-none"
        />
        <button
          onClick={() => void handleSearch()}
          disabled={loading || !query.trim()}
          className="absolute bottom-3 right-3 flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>
      <p className="text-xs text-zinc-600 mb-8 text-right">⌘+Enter to search</p>

      {/* What search can read */}
      {indexStats !== null && indexStats.bookmarks > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 mb-3 text-xs">
          <FileText size={13} className="text-zinc-500 shrink-0 mt-px" />
          <div className="flex-1 min-w-0 text-zinc-400 leading-relaxed">
            Searching <span className="text-zinc-200 font-medium">{indexStats.bookmarks.toLocaleString()}</span> bookmarks
            {indexStats.articles > 0 && (
              <>
                {' '}· <span className="text-emerald-400 font-medium">{indexStats.fullArticles.toLocaleString()}</span> of{' '}
                {indexStats.articles.toLocaleString()} X Articles readable in full
              </>
            )}
            {previewArticles > 0 && (
              <span className="block text-zinc-500 mt-0.5">
                {previewArticles.toLocaleString()} {previewArticles === 1 ? 'article only has' : 'articles only have'} a preview.{' '}
                <Link href="/" className="text-indigo-400 hover:text-indigo-300">Download them to the local archive</Link>
                {' '}(logged in to X in{' '}
                <Link href="/settings" className="text-indigo-400 hover:text-indigo-300">Settings</Link>) so search can read the whole text.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Image analysis status — hidden while main pipeline is running (it handles vision internally) */}
      {imageStats !== null && !pipelineRunning && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 mb-6 text-xs">
          <ImageIcon size={13} className="text-zinc-500 shrink-0" />
          <div className="flex-1 min-w-0">
            {imageStats.remaining === 0 ? (
              <span className="text-zinc-400">
                <span className="text-emerald-400 font-medium">{imageStats.tagged}</span> images analyzed for visual search
              </span>
            ) : (
              <span className="text-zinc-400">
                <span className="text-indigo-400 font-medium">{imageStats.tagged}</span> of{' '}
                <span className="font-medium">{imageStats.total}</span> images analyzed —{' '}
                <span className="text-zinc-500">{imageStats.remaining} remaining</span>
              </span>
            )}
          </div>
          {imageStats.remaining > 0 && (
            <button
              onClick={() => void handleAnalyzeImages()}
              disabled={analyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium transition-colors shrink-0"
            >
              {analyzing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              {analyzing ? 'Analyzing…' : 'Analyze images'}
            </button>
          )}
        </div>
      )}

      {/* Example queries — shown only before first search */}
      {!searched && (
        <div className="mb-8">
          <p className="text-xs text-zinc-600 mb-3 uppercase tracking-wider">Try these</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => handleExampleClick(ex)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 text-zinc-400 hover:text-zinc-200 text-xs transition-all"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
          <Loader2 size={15} className="animate-spin text-indigo-400" /> Reading your bookmarks…
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm mb-6">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 text-sm mb-6">
          <AlertCircle size={15} className="shrink-0 mt-0.5" /> {notice}
        </div>
      )}

      {/* Answer to a question, citing the numbered results */}
      {answer && (
        <div className="px-5 py-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/20 mb-6">
          <div className="flex items-center gap-1.5 text-xs font-medium text-indigo-400 mb-2">
            <MessageSquareText size={13} /> From your bookmarks
          </div>
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-line">
            <AnswerText text={answer} />
          </p>
        </div>
      )}

      {/* Empty state */}
      {searched && !loading && results.length === 0 && !error && (
        <div className="text-center py-16 text-zinc-600">
          <BookMarked size={36} className="mx-auto mb-3 opacity-30" />
          <p>{explanation || 'No bookmarks matched that description.'}</p>
          <p className="text-xs mt-1">Try describing it differently.</p>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-4 mb-4">
            <p className="text-sm text-zinc-400">{explanation}</p>
            <span className="text-xs text-zinc-600 shrink-0" title={considered ? `The AI read ${considered} likely bookmarks` : undefined}>
              {results.length} result{results.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex flex-col gap-6">
            {results.map((b) => (
              <div key={b.id} id={`result-${b.num}`} className="scroll-mt-6">
                <div className="flex items-start gap-1.5 mb-2 px-1">
                  <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-md bg-indigo-500/15 text-indigo-400 text-[11px] font-medium shrink-0">
                    {b.num}
                  </span>
                  {b.aiReason && (
                    <span className="text-xs text-indigo-400/80 leading-relaxed pt-0.5">{b.aiReason}</span>
                  )}
                </div>
                {/* Cast to BookmarkWithMedia since BookmarkCard does not use the AI-specific fields */}
                <BookmarkCard
                  bookmark={b as BookmarkWithMedia}
                  onDeleted={(id) => setResults((prev) => prev.filter((r) => r.id !== id))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
