/**
 * Optional scheduled "Sync from X" (Setting `x_sync_interval`: off | 1h | 4h
 * | 8h | 24h, set through POST /api/import/live). Each run is the same sync
 * as the Import page's (lib/x-bookmark-sync.ts) with the X login from
 * Settings → X Login.
 */
import prisma from '@/lib/db'
import { isXSyncRunning, startXSyncJob } from '@/lib/x-bookmark-sync'
import { getXCredentials } from '@/lib/x-session'

// ── Sync ────────────────────────────────────────────────────────────────────

/** Run a sync now and wait for it. skipped = bookmarks Siftly already had */
export async function syncBookmarks(): Promise<{ imported: number; skipped: number }> {
  const run = startXSyncJob({ mode: 'auto' })
  if (!run) throw new Error('A sync is already in progress')
  const result = await run
  if (result.error) throw new Error(result.error)
  return { imported: result.imported, skipped: result.alreadyHad }
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

type SyncInterval = '1h' | '4h' | '8h' | '24h'

const INTERVAL_MS: Record<SyncInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

export async function startScheduler() {
  stopScheduler()

  const intervalSetting = await prisma.setting.findUnique({ where: { key: 'x_sync_interval' } })
  if (!intervalSetting?.value || intervalSetting.value === 'off') return

  const interval = intervalSetting.value as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalSetting.value}" in database, not starting scheduler`)
    return
  }

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[x-sync] Scheduler stopped')
  }
}

async function runScheduledSync() {
  if (isXSyncRunning()) return
  if (!(await getXCredentials())) {
    console.log('[x-sync] Skipping scheduled sync: not logged in to X')
    return
  }

  console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)
  const run = startXSyncJob({ mode: 'auto' })
  if (!run) return
  const result = await run
  if (result.error) {
    console.error('[x-sync] Scheduled sync failed:', result.error)
    if (result.errorKind === 'auth' || result.errorKind === 'no-login') {
      console.error('[x-sync] X login rejected, stopping scheduler')
      stopScheduler()
    }
    return
  }
  console.log(`[x-sync] Sync complete: ${result.imported} imported, ${result.alreadyHad} already in Siftly`)
}

export function isSchedulerRunning() {
  return schedulerTimer !== null
}

export function isSyncing() {
  return isXSyncRunning()
}
