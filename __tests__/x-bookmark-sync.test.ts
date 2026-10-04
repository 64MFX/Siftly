/**
 * "Sync from X" against a real SQLite database built from the migrations and
 * a fake X serving a bookmark list in pages, newest first — like x.com does.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { FetchLike } from '@/lib/x-tweet-fetcher'
import { bookmarksResponse, graphqlTweet, tombstone, tweetEntry } from './fixtures/x-bookmarks'
import { createTestDatabase } from './helpers/test-db'

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-x-sync-'))

type Prisma = (typeof import('@/lib/db'))['default']
type SyncModule = typeof import('@/lib/x-bookmark-sync')
let prisma: Prisma
let sync: SyncModule

const credentials = { authToken: 'tok', ct0: 'csrf' }
const noSleep = async () => {}

/** Tweet IDs on X, newest bookmark first. `!123` = a post X only shows a placeholder for */
let onX: string[] = []

interface FakeX {
  fetchImpl: FetchLike
  /** The cursor of each Bookmarks request (null = the first page) */
  cursors: (string | null)[]
}

function fakeX(pageSize = 20, respond?: (cursor: string | null, call: number) => Response | null): FakeX {
  const cursors: (string | null)[] = []
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input)
    if (!url.pathname.endsWith('/Bookmarks')) return new Response(null, { status: 404 })
    const cursor = (JSON.parse(url.searchParams.get('variables')!) as { cursor?: string }).cursor ?? null
    cursors.push(cursor)
    const custom = respond?.(cursor, cursors.length)
    if (custom) return custom
    const offset = cursor ? Number(cursor.slice(1)) : 0
    const entries = onX.slice(offset, offset + pageSize).map((id) => (id.startsWith('!') ? tweetEntry(id.slice(1), tombstone()) : tweetEntry(id)))
    // Like X: past the last bookmark comes a page with only cursors
    return new Response(JSON.stringify(bookmarksResponse(entries, `c${offset + pageSize}`)), { headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, cursors }
}

const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => String(from + i))

function run(x: FakeX, options: Parameters<SyncModule['runXSync']>[0] = {}) {
  return sync.runXSync({ credentials, fetchImpl: x.fetchImpl, sleep: noSleep, ...options })
}

async function storedIds(): Promise<string[]> {
  return (await prisma.bookmark.findMany({ select: { tweetId: true }, orderBy: { tweetId: 'asc' } })).map((b) => b.tweetId)
}

/** Put these posts in Siftly already, as an earlier import did */
async function preload(tweetIds: string[]) {
  for (const tweetId of tweetIds) {
    await prisma.bookmark.create({
      data: { tweetId, text: `Post ${tweetId}`, authorHandle: `user${tweetId}`, authorName: `User ${tweetId}`, rawJson: JSON.stringify(graphqlTweet(tweetId)) },
    })
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = createTestDatabase(path.join(dir, 'test.db'))
  prisma = (await import('@/lib/db')).default
  sync = await import('@/lib/x-bookmark-sync')
  await prisma.setting.create({ data: { key: 'archiveDir', value: path.join(dir, 'archive') } })
})

beforeEach(async () => {
  await prisma.mediaItem.deleteMany()
  await prisma.bookmark.deleteMany()
  await prisma.setting.deleteMany({ where: { key: { not: 'archiveDir' } } })
  onX = []
})

afterAll(async () => {
  await prisma.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('the first sync', () => {
  it('reads the whole list, in order, and remembers it did', async () => {
    onX = ids(1000, 55)
    const x = fakeX()
    const result = await run(x)

    expect(result).toMatchObject({ mode: 'all', outcome: 'end', imported: 55, checked: 55, alreadyHad: 0, error: null })
    expect(x.cursors).toEqual([null, 'c20', 'c40', 'c60'])
    expect(await storedIds()).toEqual(onX)
    const status = await sync.getXSyncStatus()
    expect(status.fullCheckAt).toBe(result.finishedAt)
    expect(status.nextMode).toBe('new')
    expect(status.last?.imported).toBe(55)
  })

  it('stores what X shows: author, full text, media; newest bookmark imported last', async () => {
    onX = ['1', '2']
    const x = fakeX(20, (cursor) =>
      cursor
        ? null
        : new Response(JSON.stringify(bookmarksResponse([
            tweetEntry('1', graphqlTweet('1', { handle: 'ada', name: 'Ada', note: 'A long post', photo: true })),
            tweetEntry('2'),
          ], 'c20'))),
    )
    await run(x)
    const [newest, older] = await prisma.bookmark.findMany({ orderBy: { importedAt: 'desc' }, include: { mediaItems: true } })
    expect(newest).toMatchObject({ tweetId: '1', authorHandle: 'ada', authorName: 'Ada', text: 'A long post', source: 'bookmark' })
    expect(newest.mediaItems.map((m) => m.url)).toEqual(['https://pbs.twimg.com/media/1.jpg'])
    expect(older.tweetId).toBe('2')
  })

  it('fills in the newest bookmarks an earlier import missed', async () => {
    // The old bookmarklet only caught what loaded after it started: everything but the first page
    onX = ids(1000, 80)
    await preload(onX.slice(20))
    const result = await run(fakeX())
    expect(result).toMatchObject({ mode: 'all', imported: 20, alreadyHad: 60, outcome: 'end' })
    expect(await storedIds()).toEqual(onX)
  })

  it('fills gaps anywhere in the list, not just at the top', async () => {
    onX = ids(1000, 100)
    await preload([...onX.slice(0, 45), ...onX.slice(70)])
    const result = await run(fakeX())
    expect(result.imported).toBe(25)
    expect(await storedIds()).toEqual(onX)
  })
})

describe('later syncs', () => {
  it('stop once they reach bookmarks Siftly already has', async () => {
    onX = ids(1000, 200)
    await run(fakeX())
    onX = [...ids(5000, 7), ...onX]

    const x = fakeX()
    const result = await run(x)
    expect(result).toMatchObject({ mode: 'new', outcome: 'caught-up', imported: 7 })
    // 7 new + 13 known on page 1, then 27 more known in a row on pages 2-3 → 40 → stop
    expect(x.cursors).toEqual([null, 'c20', 'c40'])
    expect(await prisma.bookmark.count()).toBe(207)
  })

  it("don't stop at posts bookmarked again, which X moves to the top", async () => {
    onX = ids(1000, 200)
    await run(fakeX())
    const rebookmarked = onX.slice(150, 175) // 25 old posts bookmarked again
    const rest = onX.filter((id) => !rebookmarked.includes(id))
    onX = ['5000', ...rebookmarked, '5001', '5002', ...rest]

    const result = await run(fakeX())
    expect(result.imported).toBe(3)
    expect(await prisma.bookmark.count()).toBe(203)
  })

  it('read to the end when asked to check all', async () => {
    onX = ids(1000, 60)
    await run(fakeX())
    const x = fakeX()
    const result = await run(x, { mode: 'all' })
    expect(result).toMatchObject({ mode: 'all', outcome: 'end', imported: 0, alreadyHad: 60 })
    expect(x.cursors).toHaveLength(4)
  })

  it('read everything when the list is shorter than the stopping point', async () => {
    onX = ids(1000, 30)
    await run(fakeX())
    onX = ['2000', ...onX]
    const result = await run(fakeX())
    expect(result).toMatchObject({ mode: 'new', outcome: 'end', imported: 1 })
  })

  it("don't count placeholders as new, and keep going past them", async () => {
    onX = ['1', '!2', '3', '!4', ...ids(100, 10)]
    const result = await run(fakeX(5))
    expect(result).toMatchObject({ imported: 12, unavailable: 2, checked: 14, outcome: 'end' })
  })
})

describe('bookmarks imported before', () => {
  it('get their author and full text from X when the sync passes them', async () => {
    onX = ['42', '43']
    // What the old bookmarklet's file import stored once X moved the author fields
    await prisma.bookmark.create({
      data: {
        tweetId: '42',
        text: 'Post 42 &amp; more https://t.co/abc42',
        authorHandle: 'unknown',
        authorName: 'Unknown',
        rawJson: JSON.stringify({ id_str: '42', full_text: 'Post 42 &amp; more', user: { screen_name: 'unknown', name: 'Unknown' } }),
      },
    })
    await preload(['43'])
    const before = await prisma.bookmark.findUniqueOrThrow({ where: { tweetId: '43' } })

    const result = await run(fakeX())
    expect(result).toMatchObject({ imported: 0, alreadyHad: 2, updated: 1 })
    const fixed = await prisma.bookmark.findUniqueOrThrow({ where: { tweetId: '42' } })
    expect(fixed).toMatchObject({ authorHandle: 'user42', authorName: 'User 42', text: 'Post 42 & more https://t.co/abc42' })
    expect(JSON.parse(fixed.rawJson).rest_id).toBe('42')
    // Already complete: left alone
    expect(await prisma.bookmark.findUniqueOrThrow({ where: { tweetId: '43' } })).toEqual(before)
  })
})

describe('when something goes wrong', () => {
  it('reports a missing login', async () => {
    const result = await sync.runXSync({ credentials: null, sleep: noSleep })
    expect(result).toMatchObject({ outcome: 'error', errorKind: 'no-login', imported: 0 })
  })

  it('reports a rejected login, marks it, and keeps what was imported', async () => {
    onX = ids(1000, 60)
    const x = fakeX(20, (_cursor, call) => (call === 2 ? new Response(null, { status: 401 }) : null))
    const result = await run(x)
    expect(result).toMatchObject({ outcome: 'error', errorKind: 'auth', imported: 20 })
    expect(result.error).toMatch(/Log in to X again/)
    expect(await prisma.setting.findUnique({ where: { key: 'x_session_rejected_at' } })).not.toBeNull()
    // The list wasn't read to the end: the next sync reads it all again
    expect((await sync.getXSyncStatus()).nextMode).toBe('all')
  })

  it('waits out the rate limit and finishes', async () => {
    onX = ids(1000, 30)
    const reset = Math.floor(Date.now() / 1000) + 120
    const x = fakeX(20, (_cursor, call) =>
      call === 2 ? new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } }) : null,
    )
    const waits: number[] = []
    const result = await run(x, { onRateLimit: async (until) => (waits.push(until), true) })
    expect(waits).toEqual([reset * 1000])
    expect(result).toMatchObject({ outcome: 'end', imported: 30 })
  })

  it('counts a stop during a rate-limit wait as stopped, not failed', async () => {
    onX = ids(1000, 60)
    let stop = false
    const x = fakeX(20, (_cursor, call) => (call === 2 ? new Response(null, { status: 429 }) : null))
    const result = await run(x, { shouldStop: () => stop, onRateLimit: async () => ((stop = true), false) })
    expect(result).toMatchObject({ outcome: 'stopped', error: null, imported: 20 })
  })

  it('can be stopped between pages', async () => {
    onX = ids(1000, 100)
    let pages = 0
    const result = await run(fakeX(), { onProgress: (p) => (pages = p.pages), shouldStop: () => pages >= 2 })
    expect(result).toMatchObject({ outcome: 'stopped', imported: 40 })
    expect((await sync.getXSyncStatus()).fullCheckAt).toBeNull()
  })

  it('stops when X hands out the same cursor again', async () => {
    onX = ids(1000, 100)
    const x = fakeX(20, (cursor) =>
      cursor === 'c20' ? new Response(JSON.stringify(bookmarksResponse([tweetEntry('1020')], 'c20'))) : null,
    )
    const result = await run(x)
    expect(x.cursors).toEqual([null, 'c20'])
    expect(result.imported).toBe(21)
    expect((await sync.getXSyncStatus()).fullCheckAt).toBeNull()
  })

  it('remembers the query ID that worked', async () => {
    onX = ids(1000, 3)
    await run(fakeX())
    expect((await prisma.setting.findUnique({ where: { key: sync.SYNC_QUERY_ID_SETTING } }))?.value).toBe('-dgKZ58Dr9YSJYrcgEb5KA')
  })
})

describe('the background job', () => {
  it('runs one sync at a time and reports progress', async () => {
    onX = ids(1000, 10)
    await prisma.setting.createMany({
      data: [
        { key: 'x_auth_token', value: 'tok' },
        { key: 'x_ct0', value: 'csrf' },
      ],
    })
    const originalFetch = globalThis.fetch
    const x = fakeX()
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => x.fetchImpl(String(input), init)) as typeof fetch
    try {
      const run1 = sync.startXSyncJob({ mode: 'auto' })
      expect(run1).not.toBeNull()
      expect(sync.startXSyncJob()).toBeNull()
      expect(sync.isXSyncRunning()).toBe(true)
      const result = await run1!
      expect(result).toMatchObject({ imported: 10, outcome: 'end' })
      const status = await sync.getXSyncStatus()
      expect(status.job.status).toBe('idle')
      expect(status.job.progress?.imported).toBe(10)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
