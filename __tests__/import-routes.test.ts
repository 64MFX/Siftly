/**
 * Importing through the API against a real SQLite database: uploading the
 * bookmarklet's export file, and the Sync from X endpoints.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { X_EXPORT_FORMAT } from '@/lib/x-export-script'
import { graphqlTweet } from './fixtures/x-bookmarks'
import { createTestDatabase } from './helpers/test-db'

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-import-routes-'))

type Prisma = (typeof import('@/lib/db'))['default']
let prisma: Prisma
let importRoute: typeof import('@/app/api/import/route')
let syncRoute: typeof import('@/app/api/import/x-sync/route')

function upload(content: unknown) {
  const form = new FormData()
  form.append('file', new File([JSON.stringify(content)], 'x-bookmarks-2026-10-04.json', { type: 'application/json' }))
  form.append('source', 'bookmark')
  return importRoute.POST(new NextRequest('http://localhost/api/import', { method: 'POST', body: form }))
}

const exportFile = {
  format: X_EXPORT_FORMAT,
  version: 2,
  source: 'bookmark',
  complete: true,
  tweets: [graphqlTweet('11', { handle: 'ada', name: 'Ada' }), graphqlTweet('12'), graphqlTweet('13')],
}

beforeAll(async () => {
  process.env.DATABASE_URL = createTestDatabase(path.join(dir, 'test.db'))
  prisma = (await import('@/lib/db')).default
  importRoute = await import('@/app/api/import/route')
  syncRoute = await import('@/app/api/import/x-sync/route')
})

afterAll(async () => {
  await prisma.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('POST /api/import with the bookmarklet export', () => {
  it('imports every post with its author, then skips them the next time', async () => {
    const first = await (await upload(exportFile)).json()
    expect(first).toMatchObject({ imported: 3, skipped: 0, parsed: 3 })
    expect(await prisma.bookmark.findUnique({ where: { tweetId: '11' } })).toMatchObject({ authorHandle: 'ada', authorName: 'Ada', source: 'bookmark' })

    const again = await (await upload(exportFile)).json()
    expect(again).toMatchObject({ imported: 0, skipped: 3 })
  })
})

describe('/api/import/x-sync', () => {
  it('reports the X login and what a sync would do', async () => {
    const res = await syncRoute.GET(new NextRequest('http://localhost/api/import/x-sync'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ xLogin: { loggedIn: false }, job: { status: 'idle' }, nextMode: 'all', last: null })
  })

  it('asks to log in to X before syncing', async () => {
    const res = await syncRoute.POST(new NextRequest('http://localhost/api/import/x-sync', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Log in to X/)
  })

  it('refuses requests from other websites', async () => {
    const res = await syncRoute.POST(
      new NextRequest('http://localhost/api/import/x-sync', { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'cross-site' } }),
    )
    expect(res.status).toBe(403)
  })

  it('has nothing to stop when no sync runs', async () => {
    const res = await syncRoute.DELETE(new NextRequest('http://localhost/api/import/x-sync', { method: 'DELETE' }))
    expect(res.status).toBe(409)
  })
})
