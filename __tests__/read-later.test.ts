/**
 * The Read Later list against a real SQLite database built from the migrations:
 * adding and removing bookmarks, the user's folders, and listing them through
 * the bookmarks API.
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
type FoldersRoute = typeof import('@/app/api/read-later/folders/route')
type FolderRoute = typeof import('@/app/api/read-later/folders/[id]/route')
let prisma: Prisma
let readLater: ReadLaterModule
let readLaterRoute: ReadLaterRoute
let bookmarksRoute: BookmarksRoute
let foldersRoute: FoldersRoute
let folderRoute: FolderRoute

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
  foldersRoute = await import('@/app/api/read-later/folders/route')
  folderRoute = await import('@/app/api/read-later/folders/[id]/route')

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
    expect(await readLater.setReadLater('a', false)).toEqual({ id: 'a', tweetId: '1001', readLaterAt: null, readLaterFolderId: null })
    expect(await savedAt('a')).toBeNull()
    expect(await readLater.setReadLater('b', false)).toEqual({ id: 'b', tweetId: '1002', readLaterAt: null, readLaterFolderId: null })
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
    expect(await removed.json()).toEqual({ id: 'c', tweetId: '1003', readLaterAt: null, readLaterFolderId: null })

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

describe('Read Later folders', () => {
  const json = (method: string, body: unknown) =>
    new NextRequest('http://localhost/api', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  let tools: string
  let papers: string

  async function folders() {
    return (await foldersRoute.GET()).json()
  }

  it('creates folders; names are trimmed, required, short and unique regardless of case', async () => {
    const created = await foldersRoute.POST(json('POST', { name: '  Dev   tools ' }))
    expect(created.status).toBe(201)
    tools = (await created.json()).folder.id
    papers = (await (await foldersRoute.POST(json('POST', { name: 'Papers' }))).json()).folder.id

    expect((await foldersRoute.POST(json('POST', { name: 'dev TOOLS' }))).status).toBe(409)
    expect((await foldersRoute.POST(json('POST', { name: '   ' }))).status).toBe(400)
    expect((await foldersRoute.POST(json('POST', { name: 'x'.repeat(41) }))).status).toBe(400)

    // In the order they were made; b and c are on the list, Unsorted
    expect(await folders()).toEqual({
      total: 2,
      unsorted: 2,
      folders: [{ id: tools, name: 'Dev tools', count: 0 }, { id: papers, name: 'Papers', count: 0 }],
    })
  })

  it('files bookmarks in a folder, adding them to the list when needed', async () => {
    const put = (id: string, folderId: unknown) => readLaterRoute.PUT(json('PUT', { folderId }), params(id))

    // a is not on the list: filing it adds it
    const filed = await (await put('1001', tools)).json()
    expect(filed).toMatchObject({ id: 'a', readLaterFolderId: tools, readLaterAt: expect.any(String) })
    // b keeps when it was added
    expect(await (await put('b', tools)).json()).toMatchObject({ readLaterFolderId: tools, readLaterAt: '2026-10-03T00:00:00.000Z' })

    expect((await put('c', 'no-such-folder')).status).toBe(404)
    expect((await put('c', 42)).status).toBe(400)
    expect((await put('missing', tools)).status).toBe(404)

    expect(await folders()).toMatchObject({ total: 3, unsorted: 1, folders: [{ count: 2 }, { count: 0 }] })
  })

  it('lists a folder, or Unsorted, through the bookmarks API', async () => {
    expect((await listReadLater(`&readLaterFolder=${tools}`)).ids).toEqual(['a', 'b'])
    expect((await listReadLater('&readLaterFolder=none')).ids).toEqual(['c'])
    expect((await listReadLater(`&readLaterFolder=${papers}`)).ids).toEqual([])
  })

  it('moves a bookmark to another folder or back to Unsorted', async () => {
    expect((await readLater.fileReadLater('b', papers))?.readLaterFolderId).toBe(papers)
    expect((await readLater.fileReadLater('a', null))?.readLaterFolderId).toBeNull()
    expect((await listReadLater('&readLaterFolder=none')).ids).toEqual(['a', 'c'])
  })

  it('renames a folder, keeping names unique', async () => {
    const renamed = await folderRoute.PATCH(json('PATCH', { name: 'Research' }), params(papers))
    expect(await renamed.json()).toEqual({ folder: { id: papers, name: 'Research', count: 1 } })
    // Changing only the case of its own name is fine; taking another folder's name is not
    expect((await folderRoute.PATCH(json('PATCH', { name: 'RESEARCH' }), params(papers))).status).toBe(200)
    expect((await folderRoute.PATCH(json('PATCH', { name: 'dev tools' }), params(papers))).status).toBe(409)
    expect((await folderRoute.PATCH(json('PATCH', { name: 'X' }), params('nope'))).status).toBe(404)
  })

  it('taking a bookmark off the list takes it out of its folder', async () => {
    await readLater.fileReadLater('c', tools)
    expect(await readLater.setReadLater('c', false)).toMatchObject({ readLaterAt: null, readLaterFolderId: null })
    // Adding it back puts it in Unsorted
    expect(await readLater.setReadLater('c', true)).toMatchObject({ readLaterAt: expect.any(String), readLaterFolderId: null })
  })

  it('deleting a folder leaves its bookmarks on the list, Unsorted', async () => {
    const res = await folderRoute.DELETE(new NextRequest('http://localhost/api', { method: 'DELETE' }), params(papers))
    expect(await res.json()).toEqual({ success: true, moved: 1 })
    expect(await prisma.bookmark.findUnique({ where: { id: 'b' }, select: { readLaterAt: true, readLaterFolderId: true } }))
      .toEqual({ readLaterAt: new Date('2026-10-03T00:00:00Z'), readLaterFolderId: null })
    expect(await folders()).toEqual({ total: 3, unsorted: 3, folders: [{ id: tools, name: 'Dev tools', count: 0 }] })
    expect((await folderRoute.DELETE(new NextRequest('http://localhost/api', { method: 'DELETE' }), params(papers))).status).toBe(404)
  })

  it('finds a folder by id or by name, ignoring case', async () => {
    expect(await readLater.findReadLaterFolder(tools)).toEqual({ id: tools, name: 'Dev tools' })
    expect(await readLater.findReadLaterFolder('DEV TOOLS')).toEqual({ id: tools, name: 'Dev tools' })
    expect(await readLater.findReadLaterFolder('Research')).toBeNull()
  })
})
