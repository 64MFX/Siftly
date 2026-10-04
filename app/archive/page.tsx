'use client'

import { useCallback, useEffect, useState } from 'react'
import { HardDriveDownload, Loader2, CheckCircle, StopCircle, AlertTriangle, Images } from 'lucide-react'
import * as Progress from '@radix-ui/react-progress'

interface ArchiveStatus {
  status: 'idle' | 'running' | 'stopping'
  total: number
  processed: number
  saved: number
  failed: number
  bytes: number
  current: string | null
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  totalItems: number
  savedItems: number
  remainingItems: number
  diskBytes: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function Stat({ label, value, tone = 'text-zinc-100' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl bg-zinc-800/50 border border-zinc-700/40 px-3.5 py-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">{label}</p>
      <p className={`text-lg font-semibold tabular-nums mt-0.5 ${tone}`}>{value}</p>
    </div>
  )
}

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/media/archive', { cache: 'no-store' })
      setData((await res.json()) as ArchiveStatus)
    } catch { /* ignore transient errors */ }
  }, [])

  const active = data?.status === 'running' || data?.status === 'stopping'

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, active ? 1000 : 5000)
    return () => clearInterval(interval)
  }, [active, refresh])

  async function send(action: 'start' | 'stop') {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/media/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? 'Request failed')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const overallPct = data && data.totalItems > 0 ? Math.round((data.savedItems / data.totalItems) * 100) : 0
  const runPct = data && data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0
  const elapsed = data?.startedAt ? (active ? now : (data.finishedAt ?? now)) - data.startedAt : 0
  const etaMs =
    active && data && data.processed > 0 && data.total > data.processed
      ? (elapsed / data.processed) * (data.total - data.processed)
      : null
  const hasRun = !!data?.startedAt
  const finished = !active && hasRun && data.finishedAt !== null
  const allSaved = !!data && data.totalItems > 0 && data.remainingItems === 0

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium mb-4">
          <HardDriveDownload size={12} /> Local Archive
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Archive Media</h1>
        <p className="text-zinc-400 mt-1 text-sm">
          Download every photo, video and GIF from your bookmarks to this machine so they stay available
          even if the original tweet is deleted. Already-saved files are skipped.
        </p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
        {/* Library overview */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-300 font-medium flex items-center gap-2">
              <Images size={14} className="text-zinc-500" /> Library archived
            </span>
            <span className="text-zinc-400 tabular-nums">
              {data ? `${data.savedItems} / ${data.totalItems}` : '—'} ({overallPct}%)
            </span>
          </div>
          <Progress.Root className="relative h-2 overflow-hidden rounded-full bg-zinc-800" value={overallPct}>
            <Progress.Indicator
              className="h-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${overallPct}%` }}
            />
          </Progress.Root>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Saved" value={data?.savedItems ?? '—'} tone="text-emerald-400" />
            <Stat label="Remaining" value={data?.remainingItems ?? '—'} />
            <Stat label="On disk" value={data ? formatBytes(data.diskBytes) : '—'} />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>
        )}

        {/* Active run */}
        {active && data && (
          <div className="space-y-4 border-t border-zinc-800 pt-6">
            <div className="flex items-center gap-3 p-3.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
              <Loader2 size={14} className="text-emerald-400 animate-spin shrink-0" />
              <div className="min-w-0">
                <p className="text-zinc-200 text-sm font-medium">
                  {data.status === 'stopping' ? 'Stopping after current downloads…' : 'Downloading media…'}
                </p>
                <p className="text-zinc-500 text-xs mt-0.5 truncate">{data.current ?? 'Preparing…'}</p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs text-zinc-400 tabular-nums">
                <span>{data.processed} / {data.total} processed</span>
                <span>
                  {runPct}%{etaMs !== null ? ` · ~${formatDuration(etaMs)} left` : ''}
                </span>
              </div>
              <Progress.Root className="relative h-2.5 overflow-hidden rounded-full bg-zinc-800" value={runPct}>
                <Progress.Indicator
                  className="h-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${runPct}%` }}
                />
              </Progress.Root>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <Stat label="Saved" value={data.saved} tone="text-emerald-400" />
              <Stat label="Failed" value={data.failed} tone={data.failed > 0 ? 'text-red-400' : 'text-zinc-100'} />
              <Stat label="Downloaded" value={formatBytes(data.bytes)} />
              <Stat label="Elapsed" value={formatDuration(elapsed)} />
            </div>

            <button
              onClick={() => void send('stop')}
              disabled={busy || data.status === 'stopping'}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-sm font-medium transition-colors border border-zinc-700"
            >
              <StopCircle size={15} /> {data.status === 'stopping' ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        )}

        {/* Idle state */}
        {!active && (
          <div className="space-y-4 border-t border-zinc-800 pt-6">
            {finished && data && (
              <div
                className={`flex items-start gap-3 p-3.5 rounded-xl border ${
                  data.failed > 0
                    ? 'bg-amber-500/10 border-amber-500/20'
                    : 'bg-emerald-500/10 border-emerald-500/20'
                }`}
              >
                {data.failed > 0 ? (
                  <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                )}
                <div className="text-sm min-w-0">
                  <p className="text-zinc-200 font-medium">
                    Last run: saved {data.saved}
                    {data.failed > 0 ? `, ${data.failed} failed` : ''} ({formatBytes(data.bytes)} in{' '}
                    {formatDuration(elapsed)})
                  </p>
                  {data.lastError && (
                    <p className="text-xs text-zinc-500 mt-1 break-all">Last error: {data.lastError}</p>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={() => void send('start')}
              disabled={busy || !data || data.remainingItems === 0}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 text-white font-medium transition-colors"
            >
              <HardDriveDownload size={16} />
              {allSaved
                ? 'Everything is archived'
                : data && data.savedItems > 0
                  ? `Archive remaining ${data.remainingItems} items`
                  : 'Archive all media'}
            </button>
            {data && data.totalItems === 0 && (
              <p className="text-xs text-zinc-500 text-center">No media found. Import your bookmarks first.</p>
            )}
            {data && data.failed > 0 && (
              <p className="text-xs text-zinc-500 text-center">Failed items are retried on the next run.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
