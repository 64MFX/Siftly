/**
 * Full-text search index over everything Siftly knows about a bookmark: the
 * post, quoted post, link card, the full body of X Articles saved in the local
 * archive, AI tags and image analysis (OCR, scenes, objects).
 *
 * Two tables, created on demand with raw SQL (they're not in the Prisma schema):
 *
 *   bookmark_search_doc   one row per bookmark: its SearchDocument as JSON
 *   bookmark_search_fts   FTS5 index, Porter-stemmed; rowid = bookmark_search_doc.id
 *
 * syncSearchIndex() indexes whatever is new (imports) or was extracted by an
 * older SEARCH_DOC_VERSION. It's cheap when nothing changed, so search calls it
 * every time. The archiver re-indexes a bookmark after saving it; the AI
 * pipeline and image analysis refresh rows once tags change.
 */
import { promises as fs } from 'fs'
import path from 'path'
import prisma from '@/lib/db'
import type { ArchiveDocument } from '@/lib/archive-types'
import { archiveFolderName } from '@/lib/archive-storage'
import { getArchiveRoot } from '@/lib/archive-location'
import { mergeSnapshots, snapshotFromArchiveDoc, snapshotFromStoredRaw } from '@/lib/tweet-snapshot'
import {
  SEARCH_DOC_VERSION,
  buildSearchDocument,
  buildSearchRow,
  type SearchDocument,
  type SearchKind,
} from '@/lib/search-document'

const DOC_TABLE = 'bookmark_search_doc'
const FTS_TABLE = 'bookmark_search_fts'
/** The index before article bodies were searchable */
const LEGACY_FTS_TABLE = 'bookmark_fts'

/** Column weights for bm25 (bookmark_id, author, title, body, article, tags, media) */
const BM25_WEIGHTS = '0, 3.0, 4.0, 3.0, 1.5, 2.5, 1.5'
const BATCH = 50

const store = globalThis as unknown as {
  siftlySearchTablesReady?: Promise<void>
  siftlySearchSync?: Promise<number>
  siftlySearchGeneration?: number
}

/** Changes whenever indexed content changes — part of AI search's cache key */
export function searchIndexGeneration(): number {
  return store.siftlySearchGeneration ?? 0
}

function bumpGeneration(): void {
  store.siftlySearchGeneration = searchIndexGeneration() + 1
}

async function createTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${DOC_TABLE} (
      id INTEGER PRIMARY KEY,
      bookmark_id TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      kinds TEXT NOT NULL DEFAULT '',
      article TEXT NOT NULL DEFAULT '',
      indexed_at INTEGER NOT NULL,
      doc TEXT NOT NULL
    )
  `)
  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      bookmark_id UNINDEXED,
      author,
      title,
      body,
      article,
      tags,
      media,
      tokenize = 'porter unicode61 remove_diacritics 2'
    )
  `)
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${LEGACY_FTS_TABLE}`)
}

export function ensureSearchTables(): Promise<void> {
  store.siftlySearchTablesReady ??= createTables().catch((err) => {
    store.siftlySearchTablesReady = undefined
    throw err
  })
  return store.siftlySearchTablesReady
}

// ── Writing ──────────────────────────────────────────────────────────────────

interface IndexSource {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  rawJson: string
  archivedAt: Date | null
  mediaItems: { type: string }[]
}

interface RowSource {
  id: string
  semanticTags: string | null
  entities: string | null
  enrichmentMeta: string | null
  mediaItems: { imageTags: string | null }[]
}

const ROW_SELECT = {
  id: true,
  semanticTags: true,
  entities: true,
  enrichmentMeta: true,
  mediaItems: { select: { imageTags: true } },
} as const

async function readArchive(root: string, tweetId: string): Promise<ArchiveDocument | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, archiveFolderName(tweetId), 'archive.json'), 'utf8')) as ArchiveDocument
  } catch {
    return null
  }
}

/** A bookmark's searchable content: its archived copy merged with the JSON stored at import */
export async function extractSearchDocument(bookmark: IndexSource, archiveRoot: string | null): Promise<SearchDocument> {
  const stored = snapshotFromStoredRaw(bookmark.rawJson, bookmark.tweetId)
  const archived = bookmark.archivedAt && archiveRoot ? snapshotFromArchiveDoc(await readArchive(archiveRoot, bookmark.tweetId)) : null
  return buildSearchDocument(mergeSnapshots(archived, stored), {
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    mediaTypes: bookmark.mediaItems.map((m) => m.type),
  })
}

function articleState(doc: SearchDocument): string {
  return doc.article ? (doc.article.complete ? 'full' : 'preview') : ''
}

/** Statements that rewrite one bookmark's FTS row from its document */
function rowStatements(bookmarkId: string, doc: SearchDocument, source: RowSource) {
  const row = buildSearchRow({
    doc,
    semanticTags: source.semanticTags,
    entities: source.entities,
    enrichmentMeta: source.enrichmentMeta,
    imageTags: source.mediaItems.map((m) => m.imageTags),
  })
  return [
    prisma.$executeRaw`DELETE FROM bookmark_search_fts WHERE rowid = (SELECT id FROM bookmark_search_doc WHERE bookmark_id = ${bookmarkId})`,
    prisma.$executeRaw`
      INSERT INTO bookmark_search_fts (rowid, bookmark_id, author, title, body, article, tags, media)
      VALUES ((SELECT id FROM bookmark_search_doc WHERE bookmark_id = ${bookmarkId}), ${bookmarkId},
        ${row.author}, ${row.title}, ${row.body}, ${row.article}, ${row.tags}, ${row.media})
    `,
  ]
}

/** Statements that save one bookmark's document, then rewrite its FTS row */
function writeStatements(bookmarkId: string, doc: SearchDocument, source: RowSource) {
  const kinds = doc.kinds.length > 0 ? `,${doc.kinds.join(',')},` : ''
  const [deleteRow, insertRow] = rowStatements(bookmarkId, doc, source)
  return [
    deleteRow,
    prisma.$executeRaw`
      INSERT INTO bookmark_search_doc (bookmark_id, version, kinds, article, indexed_at, doc)
      VALUES (${bookmarkId}, ${SEARCH_DOC_VERSION}, ${kinds}, ${articleState(doc)}, ${Date.now()}, ${JSON.stringify(doc)})
      ON CONFLICT(bookmark_id) DO UPDATE SET
        version = excluded.version, kinds = excluded.kinds, article = excluded.article,
        indexed_at = excluded.indexed_at, doc = excluded.doc
    `,
    insertRow,
  ]
}

async function archiveRootOrNull(): Promise<string | null> {
  try {
    return await getArchiveRoot()
  } catch {
    return null
  }
}

/** Extract and index these bookmarks from scratch (their stored JSON and archive) */
async function indexBatch(ids: string[], archiveRoot: string | null): Promise<number> {
  const bookmarks = await prisma.bookmark.findMany({
    where: { id: { in: ids } },
    select: {
      ...ROW_SELECT,
      tweetId: true,
      text: true,
      authorHandle: true,
      authorName: true,
      rawJson: true,
      archivedAt: true,
      mediaItems: { select: { type: true, imageTags: true } },
    },
  })
  const statements = []
  for (const b of bookmarks) {
    statements.push(...writeStatements(b.id, await extractSearchDocument(b, archiveRoot), b))
  }
  if (statements.length > 0) await prisma.$transaction(statements)
  return bookmarks.length
}

async function runSync(): Promise<number> {
  await ensureSearchTables()

  // Deleted bookmarks
  await prisma.$executeRawUnsafe(
    `DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM ${DOC_TABLE} WHERE bookmark_id NOT IN (SELECT id FROM Bookmark))`,
  )
  const pruned = await prisma.$executeRawUnsafe(`DELETE FROM ${DOC_TABLE} WHERE bookmark_id NOT IN (SELECT id FROM Bookmark)`)

  // New bookmarks, and ones extracted by an older version
  const stale = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT b.id AS id FROM Bookmark b LEFT JOIN ${DOC_TABLE} d ON d.bookmark_id = b.id
     WHERE d.id IS NULL OR d.version != ?`,
    SEARCH_DOC_VERSION,
  )
  if (stale.length === 0) {
    if (pruned > 0) bumpGeneration()
    return 0
  }

  const root = await archiveRootOrNull()
  let indexed = 0
  try {
    for (let i = 0; i < stale.length; i += BATCH) {
      indexed += await indexBatch(stale.slice(i, i + BATCH).map((r) => r.id), root)
    }
  } finally {
    // Batches written before a failure still change results
    if (indexed > 0 || pruned > 0) bumpGeneration()
  }
  return indexed
}

/**
 * Bring the index up to date: drop deleted bookmarks, index new ones. Returns
 * how many were indexed. Concurrent calls share one run.
 */
export function syncSearchIndex(): Promise<number> {
  store.siftlySearchSync ??= runSync().finally(() => {
    store.siftlySearchSync = undefined
  })
  return store.siftlySearchSync
}

/** Re-extract these bookmarks — call after their archive was (re)written */
export async function reindexBookmarks(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await ensureSearchTables()
  const root = await archiveRootOrNull()
  for (let i = 0; i < ids.length; i += BATCH) await indexBatch(ids.slice(i, i + BATCH), root)
  bumpGeneration()
}

async function refreshRows(sources: RowSource[]): Promise<void> {
  const docs = await loadSearchDocuments(sources.map((s) => s.id))
  const statements = sources.flatMap((s) => {
    const doc = docs.get(s.id)
    return doc ? rowStatements(s.id, doc, s) : []
  })
  if (statements.length > 0) await prisma.$transaction(statements)
}

/**
 * Rewrite FTS rows from the stored documents after AI tags or image analysis
 * changed — for these bookmarks, or all of them.
 */
export async function refreshSearchRows(ids?: string[]): Promise<void> {
  await syncSearchIndex()
  if (ids) {
    for (let i = 0; i < ids.length; i += BATCH) {
      await refreshRows(await prisma.bookmark.findMany({ where: { id: { in: ids.slice(i, i + BATCH) } }, select: ROW_SELECT }))
    }
  } else {
    let cursor: string | undefined
    while (true) {
      const page = await prisma.bookmark.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: 'asc' },
        take: BATCH,
        select: ROW_SELECT,
      })
      if (page.length === 0) break
      await refreshRows(page)
      cursor = page[page.length - 1].id
      if (page.length < BATCH) break
    }
  }
  bumpGeneration()
}

export async function removeFromSearchIndex(bookmarkId: string): Promise<void> {
  await ensureSearchTables()
  await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM bookmark_search_fts WHERE rowid = (SELECT id FROM bookmark_search_doc WHERE bookmark_id = ${bookmarkId})`,
    prisma.$executeRaw`DELETE FROM bookmark_search_doc WHERE bookmark_id = ${bookmarkId}`,
  ])
  bumpGeneration()
}

export async function clearSearchIndex(): Promise<void> {
  await ensureSearchTables()
  await prisma.$executeRawUnsafe(`DELETE FROM ${FTS_TABLE}`)
  await prisma.$executeRawUnsafe(`DELETE FROM ${DOC_TABLE}`)
  bumpGeneration()
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string
  /** bm25 — lower is better */
  score: number
}

/** Bookmarks matching an FTS5 expression (see buildMatchExpression), best first */
export async function searchIndex(match: string, limit = 150): Promise<SearchHit[]> {
  try {
    await ensureSearchTables()
    const rows = await prisma.$queryRawUnsafe<{ bookmark_id: string; score: number }[]>(
      `SELECT bookmark_id, bm25(${FTS_TABLE}, ${BM25_WEIGHTS}) AS score FROM ${FTS_TABLE}
       WHERE ${FTS_TABLE} MATCH ? ORDER BY score LIMIT ?`,
      match,
      limit,
    )
    return rows.map((r) => ({ id: r.bookmark_id, score: Number(r.score) }))
  } catch (err) {
    console.warn('[search] FTS query failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Bookmarks of these kinds (any of them), newest posts first */
export async function bookmarksOfKinds(kinds: SearchKind[], limit: number): Promise<string[]> {
  if (kinds.length === 0) return []
  await ensureSearchTables()
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT b.id AS id FROM ${DOC_TABLE} d JOIN Bookmark b ON b.id = d.bookmark_id
     WHERE ${kinds.map(() => 'd.kinds LIKE ?').join(' OR ')}
     ORDER BY b.tweetCreatedAt DESC LIMIT ?`,
    ...kinds.map((k) => `%,${k},%`),
    limit,
  )
  return rows.map((r) => r.id)
}

export async function loadSearchDocuments(ids: string[]): Promise<Map<string, SearchDocument>> {
  const docs = new Map<string, SearchDocument>()
  if (ids.length === 0) return docs
  await ensureSearchTables()
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const rows = await prisma.$queryRawUnsafe<{ bookmark_id: string; doc: string }[]>(
      `SELECT bookmark_id, doc FROM ${DOC_TABLE} WHERE bookmark_id IN (${slice.map(() => '?').join(',')})`,
      ...slice,
    )
    for (const row of rows) {
      try {
        docs.set(row.bookmark_id, JSON.parse(row.doc) as SearchDocument)
      } catch { /* re-extracted on the next version bump */ }
    }
  }
  return docs
}

export interface SearchIndexStats {
  bookmarks: number
  indexed: number
  /** X Articles, and how many of them have their full text (the rest only a preview) */
  articles: number
  fullArticles: number
}

export async function getSearchIndexStats(): Promise<SearchIndexStats> {
  await ensureSearchTables()
  const [bookmarks, rows] = await Promise.all([
    prisma.bookmark.count(),
    prisma.$queryRawUnsafe<{ indexed: number | bigint; articles: number | bigint; full: number | bigint }[]>(
      `SELECT COUNT(*) AS indexed,
        COALESCE(SUM(CASE WHEN article != '' THEN 1 ELSE 0 END), 0) AS articles,
        COALESCE(SUM(CASE WHEN article = 'full' THEN 1 ELSE 0 END), 0) AS full
       FROM ${DOC_TABLE} WHERE bookmark_id IN (SELECT id FROM Bookmark)`,
    ),
  ])
  const row = rows[0]
  return {
    bookmarks,
    indexed: Number(row?.indexed ?? 0),
    articles: Number(row?.articles ?? 0),
    fullArticles: Number(row?.full ?? 0),
  }
}
