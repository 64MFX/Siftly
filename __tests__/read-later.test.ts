/**
 * The Read Later list against a real SQLite database built from the migrations:
 * adding and removing bookmarks, and listing them through the bookmarks API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { createTestDatabase } from './helpers/test-db'

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-read-later-'))

type Prisma = (typeof import('@/lib/db'))['default']
type ReadLaterModule = typeof import('@/lib/read-later')
type ReadLaterRoute = typeof import('@/app/api/bookmarks/[id]/read-later/route')
type BookmarksRoute = typeof import('@/app/api/bookmarks/route')
let prisma: Prisma
let readLater: ReadLaterModule
let readLaterRoute: ReadLaterRoute
let bookmarksRoute: BookmarksRoute

const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function savedAt(id: string): Promise<Date | null> {
  return (await prisma.bookmark.findUnique({ where: { id }, select: { readLaterAt: true } }))?.readLaterAt ?? null
}

async function listReadLater(query = ''): Promise<{ ids: string[]; total: number; readLaterAt: (string | null)[] }> {
  const res = await bookmarksRoute.GET(new NextRequest(`http://localhost/api/bookmarks?readLater=true${query}`))
  const data = await res.json()
  return {
    ids: data.bookmarks.map((b: { id: string }) => b.id),
    total: data.total,
    readLaterAt: data.bookmarks.map((b: { readLaterAt: string | null }) => b.readLaterAt),
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = createTestDatabase(path.join(dir, 'test.db'))
  prisma = (await import('@/lib/db')).default
  readLater = await import('@/lib/read-later')
  readLaterRoute = await import('@/app/api/bookmarks/[id]/read-later/route')
  bookmarksRoute = await import('@/app/api/bookmarks/route')

  const post = (id: string, tweetId: string, day: number) => ({
    id,
    tweetId,
    text: `Post ${id}`,
    authorHandle: 'alice',
    authorName: 'Alice',
    rawJson: '{}',
    tweetCreatedAt: new Date(Date.UTC(2026, 0, day)),
  })
  await prisma.bookmark.createMany({
    data: [post('a', '1001', 1), post('b', '1002', 2), post('c', '1003', 3)],
  })
})

afterAll(async () => {
  await prisma?.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('setReadLater', () => {
  it('starts with nothing on the list', async () => {
    expect(await listReadLater()).toEqual({ ids: [], total: 0, readLaterAt: [] })
  })

  it('adds a bookmark by id or tweetId and keeps when it was first added', async () => {
    const added = await readLater.setReadLater('a', true)
    expect(added).toMatchObject({ id: 'a', tweetId: '1001' })
    expect(added?.readLaterAt).toBe((await savedAt('a'))?.toISOString())

    // Adding it again (here by tweetId) changes nothing
    const again = await readLater.setReadLater('1001', true)
    expect(again?.readLaterAt).toBe(added?.readLaterAt)
  })

  it('removes a bookmark, and removing one that is not on the list is fine', async () => {
    expect(await readLater.setReadLater('a', false)).toEqual({ id: 'a', tweetId: '1001', readLaterAt: null })
    expect(await savedAt('a')).toBeNull()
    expect(await readLater.setReadLater('b', false)).toEqual({ id: 'b', tweetId: '1002', readLaterAt: null })
  })

  it('returns null for an unknown bookmark', async () => {
    expect(await readLater.setReadLater('nope', true)).toBeNull()
  })
})

describe('read-later API', () => {
  it('POST adds and DELETE removes; 404 for an unknown bookmark', async () => {
    const req = new NextRequest('http://localhost/api/bookmarks/x/read-later', { method: 'POST' })

    const added = await readLaterRoute.POST(req, params('1003'))
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ id: 'c', tweetId: '1003', readLaterAt: expect.any(String) })

    const removed = await readLaterRoute.DELETE(req, params('c'))
    expect(await removed.json()).toEqual({ id: 'c', tweetId: '1003', readLaterAt: null })

    expect((await readLaterRoute.POST(req, params('missing'))).status).toBe(404)
  })

  it('lists only the Read Later bookmarks, most recently added first', async () => {
    // Added in the order c, a, b — not the order they were posted
    await prisma.bookmark.update({ where: { id: 'c' }, data: { readLaterAt: new Date('2026-10-01T00:00:00Z') } })
    await prisma.bookmark.update({ where: { id: 'a' }, data: { readLaterAt: new Date('2026-10-02T00:00:00Z') } })
    await prisma.bookmark.update({ where: { id: 'b' }, data: { readLaterAt: new Date('2026-10-03T00:00:00Z') } })
    await readLater.setReadLater('a', false)

    const newest = await listReadLater()
    expect(newest.ids).toEqual(['b', 'c'])
    expect(newest.total).toBe(2)
    expect(newest.readLaterAt).toEqual(['2026-10-03T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])
    expect((await listReadLater('&sort=oldest')).ids).toEqual(['c', 'b'])
  })

  it('returns readLaterAt with every bookmark in the normal list', async () => {
    const res = await bookmarksRoute.GET(new NextRequest('http://localhost/api/bookmarks'))
    const data = await res.json()
    const byId = Object.fromEntries(data.bookmarks.map((b: { id: string; readLaterAt: string | null }) => [b.id, b.readLaterAt]))
    expect(data.total).toBe(3)
    expect(byId).toEqual({ a: null, b: '2026-10-03T00:00:00.000Z', c: '2026-10-01T00:00:00.000Z' })
  })
})
