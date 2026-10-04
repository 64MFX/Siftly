/**
 * The search index against a real SQLite database built from the migrations,
 * with an archive folder holding the full text of an X Article.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ARCHIVE_VERSION, type ArchiveDocument } from '@/lib/archive-types'
import { buildMatchExpression } from '@/lib/search-document'
import { ARTICLE_TWEET_ID, articleTweetTimelineOnly, NOTE_TWEET_ID, noteTweetGraphql } from './fixtures/x-tweets'
import { createTestDatabase } from './helpers/test-db'

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-search-'))
const archiveRoot = path.join(dir, 'archive')

type IndexModule = typeof import('@/lib/search-index')
type Prisma = (typeof import('@/lib/db'))['default']
let index: IndexModule
let prisma: Prisma

const archivedArticle: ArchiveDocument = {
  version: ARCHIVE_VERSION,
  tweetId: ARTICLE_TWEET_ID,
  tweetUrl: `https://x.com/ada/status/${ARTICLE_TWEET_ID}`,
  author: { name: 'Ada Writer', handle: 'ada' },
  createdAt: '2025-10-01T12:00:00.000Z',
  archivedAt: '2025-10-02T12:00:00.000Z',
  text: '',
  media: [],
  article: {
    title: 'How we built it',
    previewText: 'A short teaser',
    complete: true,
    blocks: [
      { type: 'paragraph', spans: [{ text: 'We started with a single SQLite file.' }] },
      { type: 'heading2', spans: [{ text: 'Scaling' }] },
      { type: 'paragraph', spans: [{ text: 'Later we sharded everything with consistent hashing across zeppelin nodes.' }] },
    ],
  },
  sources: ['x-graphql'],
  warnings: [],
}

async function search(terms: string[]): Promise<string[]> {
  const match = buildMatchExpression(terms, 'any')
  return match ? (await index.searchIndex(match)).map((h) => h.id) : []
}

beforeAll(async () => {
  // With the index this replaces, which should be dropped
  process.env.DATABASE_URL = createTestDatabase(
    path.join(dir, 'test.db'),
    'CREATE VIRTUAL TABLE bookmark_fts USING fts5(bookmark_id UNINDEXED, text)',
  )
  prisma = (await import('@/lib/db')).default
  index = await import('@/lib/search-index')

  await prisma.setting.create({ data: { key: 'archiveDir', value: archiveRoot } })
  await mkdir(path.join(archiveRoot, ARTICLE_TWEET_ID), { recursive: true })

  await prisma.bookmark.create({
    data: {
      id: 'article',
      tweetId: ARTICLE_TWEET_ID,
      text: 'How we built it\n\nA short teaser',
      authorHandle: 'ada',
      authorName: 'Ada Writer',
      rawJson: JSON.stringify(articleTweetTimelineOnly),
      semanticTags: JSON.stringify(['engineering blog']),
    },
  })
  await prisma.bookmark.create({
    data: {
      id: 'note',
      tweetId: NOTE_TWEET_ID,
      text: 'Full long text',
      authorHandle: 'bob',
      authorName: 'Bob',
      rawJson: JSON.stringify(noteTweetGraphql),
      mediaItems: { create: [{ type: 'photo', url: 'https://pbs.twimg.com/media/PHOTO1.jpg', imageTags: JSON.stringify({ text_ocr: ['QUARTERLY REVENUE'], tags: ['bar chart'] }) }] },
    },
  })
  await prisma.bookmark.create({
    data: { id: 'plain', tweetId: '42', text: 'Just a plain post about gardening', authorHandle: 'cy', authorName: 'Cy', rawJson: 'not json' },
  })
})

afterAll(async () => {
  await prisma?.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('search index', () => {
  it('indexes every bookmark on first sync and drops the old table', async () => {
    expect(await index.syncSearchIndex()).toBe(3)
    expect(await index.syncSearchIndex()).toBe(0)
    const legacy = await prisma.$queryRawUnsafe<unknown[]>("SELECT name FROM sqlite_master WHERE name = 'bookmark_fts'")
    expect(legacy).toHaveLength(0)
  })

  it('searches the post, quoted post, link card, image text, tags and author', async () => {
    expect(await search(['truncates'])).toEqual(['note'])
    expect(await search(['carol'])).toEqual(['note'])
    expect(await search(['repository'])).toEqual(['note'])
    expect(await search(['quarterly revenue'])).toEqual(['note'])
    expect(await search(['engineering'])).toEqual(['article'])
    expect(await search(['gardening'])).toEqual(['plain'])
    expect(await search(['@ada'])).toEqual(['article'])
  })

  it('only knows the article preview until it is archived', async () => {
    expect(await search(['zeppelin'])).toEqual([])
    expect(await index.getSearchIndexStats()).toMatchObject({ bookmarks: 3, indexed: 3, articles: 1, fullArticles: 0 })
  })

  it('reads the full X Article from the archive once it is saved', async () => {
    await writeFile(path.join(archiveRoot, ARTICLE_TWEET_ID, 'archive.json'), JSON.stringify(archivedArticle))
    await prisma.bookmark.update({ where: { id: 'article' }, data: { archivedAt: new Date() } })
    const before = index.searchIndexGeneration()
    await index.reindexBookmarks(['article'])
    expect(index.searchIndexGeneration()).toBeGreaterThan(before)

    expect(await search(['zeppelin'])).toEqual(['article'])
    expect(await search(['sharding'])).toEqual(['article']) // Porter stemming
    expect(await index.getSearchIndexStats()).toMatchObject({ articles: 1, fullArticles: 1 })

    const doc = (await index.loadSearchDocuments(['article'])).get('article')
    expect(doc?.article).toMatchObject({ title: 'How we built it', complete: true })
    expect(doc?.article?.text).toContain('consistent hashing')
  })

  it('filters by kind', async () => {
    expect(await index.bookmarksOfKinds(['article'], 10)).toEqual(['article'])
    expect((await index.bookmarksOfKinds(['video', 'quote'], 10)).sort()).toEqual(['note'])
  })

  it('refreshes rows when AI tags change', async () => {
    await prisma.bookmark.update({ where: { id: 'plain' }, data: { semanticTags: JSON.stringify(['horticulture']) } })
    expect(await search(['horticulture'])).toEqual([])
    await index.refreshSearchRows(['plain'])
    expect(await search(['horticulture'])).toEqual(['plain'])
    await index.refreshSearchRows()
    expect(await search(['horticulture'])).toEqual(['plain'])
  })

  it('drops deleted bookmarks', async () => {
    await prisma.bookmark.delete({ where: { id: 'plain' } })
    await index.syncSearchIndex()
    expect(await search(['gardening'])).toEqual([])
    await index.removeFromSearchIndex('note')
    expect(await search(['carol'])).toEqual([])
    // Back on the next sync, since the bookmark still exists
    expect(await index.syncSearchIndex()).toBe(1)
    expect(await search(['carol'])).toEqual(['note'])
  })

  it('treats query syntax as plain words and never throws', async () => {
    // "and" is just a word here (the note contains it), not an operator
    expect(await search(['"); DROP TABLE Bookmark; --', 'AND', 'NEAR(', '*'])).toEqual(['note'])
    expect(await prisma.bookmark.count()).toBe(2)
    expect(await index.searchIndex('(((')).toEqual([])
  })
})
