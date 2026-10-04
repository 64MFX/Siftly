'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle2, HardDriveDownload, Loader2, Square } from 'lucide-react'

interface JobState {
  status: 'idle' | 'running' | 'stopping'
  total: number
  done: number
  complete: number
  partial: number
  failed: number
  waitingUntil?: string | null
}

interface ArchiveStatus {
  stats: { pending: number }
  job: JobState
}

/**
 * Dashboard button that downloads every bookmark not saved locally yet.
 * Downloads only ever start from here or Settings — never on import.
 */
export default function ArchiveDownloadButton({ initialPending }: { initialPending: number }) {
  const router = useRouter()
  const [pending, setPending] = useState(initialPending)
  const [job, setJob] = useState<JobState | null>(null)
  const [starting, setStarting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const wasRunning = useRef(false)

  const running = job?.status === 'running' || job?.status === 'stopping'

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/archive')
      if (!res.ok) return
      const data = (await res.json()) as ArchiveStatus
      setPending(data.stats.pending)
      setJob(data.job)
    } catch { /* keep the last known state */ }
  }, [])

  // Pick up a download that was started elsewhere (e.g. Settings)
  useEffect(() => { void load() }, [load])

  useEffect(() => { setPending(initialPending) }, [initialPending])

  useEffect(() => {
    if (!running) return
    wasRunning.current = true
    const timer = setInterval(() => { void load() }, 1500)
    return () => clearInterval(timer)
  }, [running, load])

  // When a run finishes, summarise it and refresh the cards so they show "Saved"
  useEffect(() => {
    if (running || !wasRunning.current || !job) return
    wasRunning.current = false
    const parts = [`Downloaded ${job.complete + job.partial} bookmark${job.complete + job.partial === 1 ? '' : 's'}`]
    if (job.partial > 0) parts.push(`${job.partial} incomplete`)
    if (job.failed > 0) parts.push(`${job.failed} failed`)
    setMessage({ type: job.failed > 0 || job.partial > 0 ? 'error' : 'success', text: parts.join(' · ') })
    router.refresh()
    const timer = setTimeout(() => setMessage(null), 8000)
    return () => clearTimeout(timer)
  }, [running, job, router])

  async function start() {
    setStarting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'pending' }),
      })
      const data = await res.json()
      if (!res.ok && res.status !== 409) throw new Error(data.error ?? 'Could not start downloading')
      if (res.status === 409 && !/already running/i.test(data.error ?? '')) throw new Error(data.error)
      await load()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not start downloading' })
    } finally {
      setStarting(false)
    }
  }

  async function stop() {
    await fetch('/api/archive', { method: 'DELETE' }).catch(() => {})
    await load()
  }

  if (running && job) {
    const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0
    return (
      <div className="flex min-w-[220px] items-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-2">
        <Loader2 size={15} className="shrink-0 animate-spin text-indigo-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200 tabular-nums">
            {job.status === 'stopping'
              ? 'Stopping…'
              : job.waitingUntil
                ? `Paused for X until ${new Date(job.waitingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : `Downloading ${job.done.toLocaleString()} / ${job.total.toLocaleString()}`}
          </p>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button
          onClick={() => void stop()}
          disabled={job.status === 'stopping'}
          title="Stop after the bookmarks in progress"
          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        >
          <Square size={12} />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      {pending > 0 ? (
        <button
          onClick={() => void start()}
          disabled={starting}
          title="Save the full text, images, videos and articles of every bookmark that isn't downloaded yet"
          className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-60"
        >
          {starting ? <Loader2 size={15} className="animate-spin" /> : <HardDriveDownload size={15} />}
          Download {pending.toLocaleString()} bookmark{pending === 1 ? '' : 's'}
        </button>
      ) : (
        <Link
          href="/settings"
          title="Every bookmark is saved locally — manage the archive in Settings"
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <CheckCircle2 size={15} className="text-emerald-500" />
          All downloaded
        </Link>
      )}
      {message && (
        <p className={`absolute left-1 top-full mt-1 whitespace-nowrap text-xs ${message.type === 'error' ? 'text-amber-400' : 'text-emerald-400'}`}>{message.text}</p>
      )}
    </div>
  )
}
