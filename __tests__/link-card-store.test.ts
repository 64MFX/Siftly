/**
 * Resolving and saving bookmarks' link cards against a real SQLite database
 * built from the migrations, with an archive folder and a fake network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ARCHIVE_VERSION, type ArchiveDocument } from '@/lib/archive-types'
import { buildMatchExpression } from '@/lib/search-document'
import type { FetchLike } from '@/lib/x-tweet-fetcher'
import { LINK_TWEET_ID, linkOnlyTweetSyndication, NOTE_TWEET_ID, noteTweetGraphql } from './fixtures/x-tweets'
import { createTestDatabase } from './helpers/test-db'

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-link-card-'))
const archiveRoot = path.join(dir, 'archive')
const ARCHIVED_ID = '1810000000000000001'

type StoreModule = typeof import('@/lib/link-card-store')
type IndexModule = typeof import('@/lib/search-index')
type Prisma = (typeof import('@/lib/db'))['default']
let store: StoreModule
let index: IndexModule
let prisma: Prisma

const archived: ArchiveDocument = {
  version: ARCHIVE_VERSION,
  tweetId: ARCHIVED_ID,
  tweetUrl: `https://x.com/aibuilderclub_/status/${ARCHIVED_ID}`,
  author: { name: 'AI Builder Club', handle: 'aibuilderclub_' },
  createdAt: '2026-08-04T14:22:00.000Z',
  archivedAt: '2026-10-04T16:16:00.000Z',
  text: 'github.com/liustack/modlens',
  media: [],
  card: {
    url: 'https://github.com/liustack/modlens',
    title: 'GitHub - liustack/modlens: The first vision plugin for DeepSeek Harness',
    description: 'Paste an image, get structured JSON evidence (OCR, layout, semantics).',
    domain: 'github.com',
    imageUrl: 'https://pbs.twimg.com/card_img/9/modlens',
    imageFile: 'media/card-abc.jpg',
  },
  sources: ['x-syndication'],
  warnings: [],
}

/** The minimal JSON a file import stores for a post it knows little about */
const minimalRaw = (tweetId: string, text: string) => JSON.stringify({ id_str: tweetId, full_text: text, user: { screen_name: 'unknown', name: 'Unknown' } })

function fakeX(syndication: Record<string, unknown>) {
  const fetchImpl: FetchLike = vi.fn(async (input: string) => {
    const id = new URL(input).searchParams.get('id')
    if (input.startsWith('https://cdn.syndication.twimg.com/') && id && syndication[id]) {
      return new Response(JSON.stringify(syndication[id]), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  return fetchImpl
}

async function savedCard(id: string) {
  const row = await prisma.bookmark.findUnique({ where: { id }, select: { linkCard: true } })
  return row?.linkCard ? JSON.parse(row.linkCard) : null
}

async function search(term: string): Promise<string[]> {
  return (await index.searchIndex(buildMatchExpression([term], 'any')!)).map((h) => h.id)
}

beforeAll(async () => {
  process.env.DATABASE_URL = createTestDatabase(path.join(dir, 'test.db'))
  prisma = (await import('@/lib/db')).default
  store = await import('@/lib/link-card-store')
  index = await import('@/lib/search-index')

  await prisma.setting.create({ data: { key: 'archiveDir', value: archiveRoot } })
  await mkdir(path.join(archiveRoot, ARCHIVED_ID), { recursive: true })
  await writeFile(path.join(archiveRoot, ARCHIVED_ID, 'archive.json'), JSON.stringify(archived))

  const text = 'https://t.co/kz411EKFNI'
  await prisma.bookmark.createMany({
    data: [
      { id: 'archived', tweetId: ARCHIVED_ID, text, authorHandle: 'unknown', authorName: 'Unknown', rawJson: minimalRaw(ARCHIVED_ID, text), archivedAt: new Date() },
      { id: 'stored', tweetId: NOTE_TWEET_ID, text: 'Full long text https://t.co/ln1', authorHandle: 'bob', authorName: 'Bob', rawJson: JSON.stringify(noteTweetGraphql) },
      { id: 'bare', tweetId: LINK_TWEET_ID, text, authorHandle: 'unknown', authorName: 'Unknown', rawJson: minimalRaw(LINK_TWEET_ID, text) },
      { id: 'missing', tweetId: '1820000000000000001', text: 'https://t.co/gone', authorHandle: 'unknown', authorName: 'Unknown', rawJson: minimalRaw('1820000000000000001', 'https://t.co/gone') },
    ],
  })
  await prisma.bookmark.create({
    data: {
      id: 'photo',
      tweetId: '1830000000000000001',
      text: 'Look https://t.co/pic',
      authorHandle: 'dee',
      authorName: 'Dee',
      rawJson: minimalRaw('1830000000000000001', 'Look https://t.co/pic'),
      mediaItems: { create: [{ type: 'photo', url: 'https://pbs.twimg.com/media/P.jpg' }] },
    },
  })
  await index.syncSearchIndex()
})

afterAll(async () => {
  await prisma?.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('resolveLinkCard', () => {
  it('takes the card from the archive, with its saved image, without asking X', async () => {
    const fetchImpl = fakeX({})
    const result = await store.resolveLinkCard('archived', { fetchImpl })
    expect(result?.card).toMatchObject({
      url: 'https://github.com/liustack/modlens',
      title: 'GitHub - liustack/modlens: The first vision plugin for DeepSeek Harness',
      domain: 'github.com',
      imagePath: `${ARCHIVED_ID}/media/card-abc.jpg`,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await savedCard('archived')).toEqual(result?.card)
  })

  it('takes the card from the JSON stored at import', async () => {
    const result = await store.resolveLinkCard('stored', { fetchImpl: fakeX({}) })
    expect(result?.card).toMatchObject({ url: 'https://github.com/foo/bar', title: 'foo/bar on GitHub' })
    expect(await savedCard('stored')).toMatchObject({ title: 'foo/bar on GitHub' })
  })

  it("looks a bare link up on X once, then reads the saved card", async () => {
    const fetchImpl = fakeX({ [LINK_TWEET_ID]: linkOnlyTweetSyndication })
    const first = await store.resolveLinkCard('bare', { fetchImpl })
    expect(first?.card).toMatchObject({ url: 'https://github.com/liustack/modlens', domain: 'github.com' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const again = await store.resolveLinkCard('bare', { fetchImpl })
    expect(again?.card).toEqual(first?.card)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('makes saved cards searchable', async () => {
    expect((await search('modlens')).sort()).toEqual(['archived', 'bare'])
  })

  it("saves nothing when no card can be found", async () => {
    const result = await store.resolveLinkCard('missing', { fetchImpl: fakeX({}) })
    expect(result?.card).toBeNull()
    expect(await savedCard('missing')).toBeNull()
  })

  it("doesn't look up posts with media, or skips the network when asked", async () => {
    const fetchImpl = fakeX({})
    expect((await store.resolveLinkCard('photo', { fetchImpl }))?.card).toBeNull()
    expect((await store.resolveLinkCard('missing', { fetchImpl, network: false }))?.card).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null for an unknown bookmark', async () => {
    expect(await store.resolveLinkCard('nope', { fetchImpl: fakeX({}) })).toBeNull()
  })
})

describe('archiving', () => {
  it("saves the post's link card with the archived image", async () => {
    const tweetId = '1840000000000000001'
    await prisma.bookmark.create({
      data: { id: 'to-archive', tweetId, text: 'https://t.co/ln1', authorHandle: 'bob', authorName: 'Bob', rawJson: JSON.stringify({ ...noteTweetGraphql.tweet, rest_id: tweetId }) },
    })
    const images: FetchLike = async (input) =>
      new URL(input).hostname === 'pbs.twimg.com'
        ? new Response('IMAGE', { headers: { 'content-type': 'image/jpeg' } })
        : new Response(null, { status: 404 })

    const { archiveBookmark } = await import('@/lib/archiver')
    const result = await archiveBookmark('to-archive', { fetcher: null, fetchImpl: images, root: archiveRoot })

    expect(result.linkCard).toMatchObject({ url: 'https://github.com/foo/bar', title: 'foo/bar on GitHub' })
    expect(result.linkCard?.imagePath).toMatch(new RegExp(`^${tweetId}/media/card-`))
    expect(await savedCard('to-archive')).toEqual(result.linkCard)
  })
})
