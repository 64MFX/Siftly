/**
 * "Sync from X": imports the bookmarks of the X account logged in under
 * Settings → X Login straight from X (lib/x-bookmarks-api.ts), newest first.
 *
 * The first sync reads the whole bookmark list, so anything earlier imports
 * missed gets filled in. After that a sync stops once it has passed
 * STOP_AFTER_KNOWN bookmarks in a row that Siftly already has: X lists
 * bookmarks by when they were bookmarked, so everything bookmarked since the
 * last sync sits above them. A few already-imported posts among the new ones
 * (a post bookmarked again moves to the top) don't stop it. `mode: 'all'`
 * always reads to the end.
 *
 * Bookmarks imported earlier from a lossy source — e.g. the old bookmarklet's
 * file, whose authors read "unknown" since X moved the author fields, with
 * long posts cut short — are completed from X's data when a sync passes them.
 *
 * Runs in the background for the app (startXSyncJob) or in-process for the
 * CLI (runXSync). It only runs when asked, or on the optional schedule set
 * through /api/import/live (lib/x-sync.ts).
 */
import prisma from '@/lib/db'
import { waitForRateLimitReset } from '@/lib/archiver'
import { reindexBookmarks } from '@/lib/search-index'
import { XBookmarksClient, XBookmarksError, type BookmarkEntry, type XBookmarksErrorKind } from '@/lib/x-bookmarks-api'
import { getXCredentials, markXSessionRejected } from '@/lib/x-session'
import type { FetchLike, XCredentials } from '@/lib/x-tweet-fetcher'
import { importedTweetFromGraphql, isGraphqlTweet, type ImportedTweet } from '@/lib/x-tweet-import'

/** Once caught up, a sync stops after this many already-imported bookmarks in a row */
export const STOP_AFTER_KNOWN = 40
/** Pause between pages, about the pace of someone scrolling */
const PAGE_DELAY_MS = 600

/** JSON of the last XSyncResult */
export const SYNC_LAST_SETTING = 'x_bookmark_sync_last'
/** When a sync last read the whole bookmark list to the end */
export const SYNC_FULL_CHECK_SETTING = 'x_bookmark_sync_full_check_at'
/** The Bookmarks query ID that last worked */
export const SYNC_QUERY_ID_SETTING = 'x_bookmarks_query_id'

/** auto = the whole list the first time, then only what's new · new · all = always the whole list */
export type XSyncMode = 'auto' | 'new' | 'all'

/** caught-up = reached bookmarks Siftly already had · end = read the whole list · stopped · error */
export type XSyncOutcome = 'caught-up' | 'end' | 'stopped' | 'error'

export type XSyncErrorKind = 'no-login' | 'database' | 'unexpected' | XBookmarksErrorKind

export interface XSyncProgress {
  mode: 'new' | 'all'
  pages: number
  /** Bookmarks read from X */
  checked: number
  imported: number
  alreadyHad: number
  /** Bookmarks already in Siftly, completed with X's data */
  updated: number
  /** Bookmarks X only shows a placeholder for (deleted, suspended, protected) */
  unavailable: number
}

export interface XSyncResult extends XSyncProgress {
  outcome: XSyncOutcome
  error: string | null
  errorKind: XSyncErrorKind | null
  startedAt: string
  finishedAt: string
}

export interface RunXSyncOptions {
  mode?: XSyncMode
  /** Defaults to the login saved in Settings → X Login */
  credentials?: XCredentials | null
  fetchImpl?: FetchLike
  shouldStop?: () => boolean
  onProgress?: (progress: XSyncProgress) => void
  /** X's rate limit is used up until `until` (ms): resolve true once it has passed to carry on */
  onRateLimit?: (until: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  pageDelayMs?: number
}

class SyncError extends Error {
  constructor(message: string, readonly kind: XSyncErrorKind) {
    super(message)
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function readSetting(key: string): Promise<string | null> {
  return (await prisma.setting.findUnique({ where: { key } }))?.value ?? null
}

function writeSetting(key: string, value: string) {
  return prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

// ── Importing a page ─────────────────────────────────────────────────────────

interface KnownBookmark {
  id: string
  tweetId: string
  authorHandle: string
  rawJson: string
  tweetCreatedAt: Date | null
  _count: { mediaItems: number }
}

function storedAsGraphql(rawJson: string): boolean {
  try {
    return isGraphqlTweet(JSON.parse(rawJson))
  } catch {
    return false
  }
}

/** Imported from a source that lost the author or the full post */
function needsCompleting(known: KnownBookmark): boolean {
  return known.authorHandle === 'unknown' || !storedAsGraphql(known.rawJson)
}

async function completeBookmark(known: KnownBookmark, fresh: ImportedTweet): Promise<void> {
  const authorKnown = fresh.authorHandle !== 'unknown'
  await prisma.$transaction([
    prisma.bookmark.update({
      where: { id: known.id },
      data: {
        rawJson: fresh.rawJson,
        ...(fresh.text ? { text: fresh.text } : {}),
        ...(known.authorHandle === 'unknown' && authorKnown ? { authorHandle: fresh.authorHandle, authorName: fresh.authorName } : {}),
        ...(!known.tweetCreatedAt && fresh.tweetCreatedAt ? { tweetCreatedAt: fresh.tweetCreatedAt } : {}),
      },
    }),
    ...(known._count.mediaItems === 0 && fresh.media.length > 0
      ? [prisma.mediaItem.createMany({ data: fresh.media.map((m) => ({ ...m, bookmarkId: known.id })) })]
      : []),
  ])
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002' || /unique constraint/i.test(err instanceof Error ? err.message : '')
}

/** False when the post was already there (another import got to it first) */
async function createBookmark(tweet: ImportedTweet, importedAt: Date): Promise<boolean> {
  try {
    await prisma.bookmark.create({
      data: {
        tweetId: tweet.tweetId,
        text: tweet.text,
        authorHandle: tweet.authorHandle,
        authorName: tweet.authorName,
        tweetCreatedAt: tweet.tweetCreatedAt,
        rawJson: tweet.rawJson,
        source: 'bookmark',
        importedAt,
        ...(tweet.media.length > 0 ? { mediaItems: { create: tweet.media } } : {}),
      },
    })
    return true
  } catch (err) {
    if (isUniqueViolation(err)) return false
    throw err
  }
}

interface PageContext {
  progress: XSyncProgress
  /** Newest bookmark first: each one imported gets an importedAt 1 ms earlier, so "recently imported" keeps X's order */
  importedAtBase: number
  updatedIds: string[]
  knownInARow: number
}

async function importEntries(entries: BookmarkEntry[], ctx: PageContext): Promise<void> {
  if (entries.length === 0) return
  let known: KnownBookmark[]
  try {
    known = await prisma.bookmark.findMany({
      where: { tweetId: { in: entries.map((e) => e.tweetId) } },
      select: { id: true, tweetId: true, authorHandle: true, rawJson: true, tweetCreatedAt: true, _count: { select: { mediaItems: true } } },
    })
  } catch (err) {
    throw new SyncError(`Couldn't read the Siftly database: ${err instanceof Error ? err.message : String(err)}`, 'database')
  }
  const byTweetId = new Map(known.map((b) => [b.tweetId, b]))
  const { progress } = ctx

  for (const entry of entries) {
    progress.checked++
    const existing = byTweetId.get(entry.tweetId)
    const fresh = entry.tweet ? importedTweetFromGraphql(entry.tweet) : null
    if (existing) {
      progress.alreadyHad++
      ctx.knownInARow++
      if (fresh && needsCompleting(existing)) {
        try {
          await completeBookmark(existing, fresh)
          progress.updated++
          ctx.updatedIds.push(existing.id)
        } catch (err) {
          console.error(`[x-sync] Couldn't complete bookmark ${existing.tweetId}:`, err instanceof Error ? err.message : err)
        }
      }
      continue
    }
    if (!fresh) {
      // Nothing to import — and no sign of where the new bookmarks end, so the run of known ones isn't broken either
      progress.unavailable++
      continue
    }
    let created: boolean
    try {
      created = await createBookmark(fresh, new Date(ctx.importedAtBase - progress.imported))
    } catch (err) {
      throw new SyncError(`Couldn't save bookmark ${fresh.tweetId}: ${err instanceof Error ? err.message : String(err)}`, 'database')
    }
    if (created) {
      progress.imported++
      ctx.knownInARow = 0
    } else {
      progress.alreadyHad++
      ctx.knownInARow++
    }
  }
}

// ── A sync run ───────────────────────────────────────────────────────────────

/** The mode `auto` resolves to: the whole list until a sync has read it all once */
export async function resolveSyncMode(mode: XSyncMode = 'auto'): Promise<'new' | 'all'> {
  if (mode === 'new' || mode === 'all') return mode
  return (await readSetting(SYNC_FULL_CHECK_SETTING)) ? 'new' : 'all'
}

function errorMessage(err: unknown): { message: string; kind: XSyncErrorKind } {
  if (err instanceof SyncError) return { message: err.message, kind: err.kind }
  if (err instanceof XBookmarksError) {
    if (err.kind === 'auth') {
      return {
        message: 'X rejected the saved login — it may have expired or been logged out on X. Log in to X again, then sync.',
        kind: 'auth',
      }
    }
    if (err.kind === 'rejected') {
      return {
        message: `${err.message}. X may have changed how its bookmarks page loads — use the bookmarklet on the Import page instead (it reads your bookmarks inside your own x.com tab).`,
        kind: 'rejected',
      }
    }
    return { message: err.message, kind: err.kind }
  }
  return { message: err instanceof Error ? err.message : String(err), kind: 'unexpected' }
}

/**
 * Import new bookmarks from X. Never throws: a failure is reported in the
 * result (bookmarks imported before it stay imported).
 */
export async function runXSync(options: RunXSyncOptions = {}): Promise<XSyncResult> {
  const startedAt = new Date()
  const sleep = options.sleep ?? defaultSleep
  const progress: XSyncProgress = { mode: 'new', pages: 0, checked: 0, imported: 0, alreadyHad: 0, updated: 0, unavailable: 0 }
  const ctx: PageContext = { progress, importedAtBase: startedAt.getTime(), updatedIds: [], knownInARow: 0 }
  let outcome: XSyncOutcome = 'end'
  let reachedEnd = false
  let failure: { message: string; kind: XSyncErrorKind } | null = null
  let client: XBookmarksClient | null = null

  try {
    progress.mode = await resolveSyncMode(options.mode)
    options.onProgress?.({ ...progress })

    const credentials = options.credentials === undefined ? await getXCredentials() : options.credentials
    if (!credentials) {
      throw new SyncError('Log in to X first (Settings → X Login, or "Log in to X" on the Import page).', 'no-login')
    }
    client = new XBookmarksClient({
      credentials,
      fetchImpl: options.fetchImpl,
      onRateLimit: options.onRateLimit,
      sleep: options.sleep,
      queryIds: [process.env.SIFTLY_X_BOOKMARKS_QUERY_ID, await readSetting(SYNC_QUERY_ID_SETTING)],
    })

    const seen = new Set<string>()
    const usedCursors = new Set<string>()
    let cursor: string | null = null
    while (true) {
      if (options.shouldStop?.()) {
        outcome = 'stopped'
        break
      }
      const page = await client.fetchPage(cursor)
      progress.pages++
      // X can repeat a post at a page boundary
      const fresh = page.entries.filter((e) => !seen.has(e.tweetId))
      for (const e of fresh) seen.add(e.tweetId)
      await importEntries(fresh, ctx)
      options.onProgress?.({ ...progress })

      if (progress.mode === 'new' && ctx.knownInARow >= STOP_AFTER_KNOWN) {
        outcome = 'caught-up'
        break
      }
      // X's own page stops at an empty page; `end` and a missing cursor say the same
      if (page.entries.length === 0 || page.end || !page.nextCursor) {
        reachedEnd = true
        break
      }
      if (usedCursors.has(page.nextCursor)) {
        console.warn('[x-sync] X sent a page cursor again — stopping here')
        break
      }
      usedCursors.add(page.nextCursor)
      cursor = page.nextCursor
      await sleep(options.pageDelayMs ?? PAGE_DELAY_MS)
    }
  } catch (err) {
    if (options.shouldStop?.()) {
      // Stopped while waiting for X's rate limit
      outcome = 'stopped'
    } else {
      outcome = 'error'
      failure = errorMessage(err)
      if (failure.kind === 'auth') await markXSessionRejected()
      if (failure.kind === 'unexpected') console.error('[x-sync] Sync failed:', err)
    }
  }

  // Search reads rawJson — re-extract the bookmarks that just got their full text
  if (ctx.updatedIds.length > 0) {
    await reindexBookmarks(ctx.updatedIds).catch((err) => console.error('[x-sync] Search index update failed:', err))
  }

  const result: XSyncResult = {
    ...progress,
    outcome,
    error: failure?.message ?? null,
    errorKind: failure?.kind ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  }
  try {
    await writeSetting(SYNC_LAST_SETTING, JSON.stringify(result))
    if (reachedEnd && outcome === 'end') await writeSetting(SYNC_FULL_CHECK_SETTING, result.finishedAt)
    if (client?.queryId) await writeSetting(SYNC_QUERY_ID_SETTING, client.queryId)
  } catch (err) {
    console.error('[x-sync] Could not save the sync status:', err instanceof Error ? err.message : err)
  }
  return result
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface XSyncJobState {
  status: 'idle' | 'running' | 'stopping'
  startedAt: string | null
  progress: XSyncProgress | null
  /** Paused until X's rate limit resets (ISO time) */
  waitingUntil: string | null
}

export interface XSyncStatus {
  job: XSyncJobState
  /** The last finished sync */
  last: XSyncResult | null
  /** When a sync last read the whole bookmark list */
  fullCheckAt: string | null
  /** What a sync started now with mode `auto` does */
  nextMode: 'new' | 'all'
}

interface SyncJob {
  state: XSyncJobState
  abort: boolean
  run: Promise<XSyncResult> | null
}

const store = globalThis as unknown as { siftlyXSyncJob?: SyncJob }

function job(): SyncJob {
  store.siftlyXSyncJob ??= {
    state: { status: 'idle', startedAt: null, progress: null, waitingUntil: null },
    abort: false,
    run: null,
  }
  return store.siftlyXSyncJob
}

function parseResult(json: string | null): XSyncResult | null {
  if (!json) return null
  try {
    return JSON.parse(json) as XSyncResult
  } catch {
    return null
  }
}

export async function getXSyncStatus(): Promise<XSyncStatus> {
  // Job first: a run saves its result before it goes idle, so an idle job comes with its own result
  const state = { ...job().state }
  const [last, fullCheckAt] = await Promise.all([readSetting(SYNC_LAST_SETTING), readSetting(SYNC_FULL_CHECK_SETTING)])
  return { job: state, last: parseResult(last), fullCheckAt, nextMode: fullCheckAt ? 'new' : 'all' }
}

export function isXSyncRunning(): boolean {
  return job().state.status !== 'idle'
}

/**
 * Start a sync in the background. Returns the run (it never rejects), or
 * null when one is already going.
 */
export function startXSyncJob(options: { mode?: XSyncMode } = {}): Promise<XSyncResult> | null {
  const j = job()
  if (j.state.status !== 'idle') return null
  j.abort = false
  j.state = { status: 'running', startedAt: new Date().toISOString(), progress: null, waitingUntil: null }
  j.run = runXSync({
    mode: options.mode,
    shouldStop: () => j.abort,
    onProgress: (progress) => {
      j.state = { ...j.state, progress }
    },
    onRateLimit: async (until) => {
      j.state = { ...j.state, waitingUntil: new Date(until).toISOString() }
      try {
        return await waitForRateLimitReset(until, () => j.abort)
      } finally {
        j.state = { ...j.state, waitingUntil: null }
      }
    },
  }).finally(() => {
    j.state = { ...j.state, status: 'idle', waitingUntil: null }
    j.run = null
  })
  return j.run
}

/** Stop after the page being read. False when no sync is running */
export function stopXSyncJob(): boolean {
  const j = job()
  if (j.state.status !== 'running') return false
  j.abort = true
  j.state = { ...j.state, status: 'stopping' }
  return true
}
