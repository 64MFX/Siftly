#!/usr/bin/env npx tsx
import prisma from '@/lib/db'
import { buildMatchExpression, excerpt } from '@/lib/search-document'
import { loadSearchDocuments, searchIndex, syncSearchIndex } from '@/lib/search-index'
import { aiSearch, fuseRankings } from '@/lib/ai-search'
import { extractKeywords } from '@/lib/search-utils'
import { ARTICLE_WHERE } from '@/lib/bookmark-filters'
import {
  archiveBookmark,
  archiveWhereForMode,
  createXFetcher,
  getArchiveStats,
  waitForRateLimitReset,
  type ArchiveMode,
} from '@/lib/archiver'
import { archiveFolderName } from '@/lib/archive-storage'
import { getArchiveLocation, getArchiveRoot, setArchiveDir } from '@/lib/archive-location'
import { getXSessionStatus } from '@/lib/x-session'
import path from 'path'

// ─── Output ──────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
function output(data: unknown): void {
  const json = isTTY ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(json + '\n')
}

function die(message: string): never {
  output({ error: message })
  process.exit(1)
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSearch(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) die('Usage: siftly search <query>')

  const limit = Math.min(parseInt(flags.limit ?? '20', 10) || 20, 100)
  const keywords = extractKeywords(query)
  if (keywords.length === 0) die('No searchable keywords in query')

  await syncSearchIndex()
  const hits = async (mode: 'all' | 'any') => {
    const match = buildMatchExpression(keywords, mode)
    return match ? (await searchIndex(match, 200)).map((h) => h.id) : []
  }
  // Bookmarks with every keyword first, then any of them
  const ids = fuseRankings([
    { ids: keywords.length > 1 ? await hits('all') : [], weight: 1.5 },
    { ids: await hits('any'), weight: 1 },
  ]).slice(0, limit)

  const [rows, docs] = await Promise.all([
    prisma.bookmark.findMany({
      where: { id: { in: ids } },
      include: {
        mediaItems: { select: { id: true, type: true, url: true } },
        categories: {
          include: { category: { select: { name: true, slug: true } } },
          orderBy: { confidence: 'desc' },
        },
      },
    }),
    loadSearchDocuments(ids),
  ])
  const byId = new Map(rows.map((b) => [b.id, b]))
  const bookmarks = ids.flatMap((id) => {
    const b = byId.get(id)
    if (!b) return []
    const doc = docs.get(id)
    // Where the keywords appear — the X Article body when there is one
    const source = doc?.article?.text || doc?.text || b.text
    return [{ ...formatBookmark(b), ...(doc?.article ? { articleTitle: doc.article.title } : {}), match: excerpt(source, keywords, 400) }]
  })

  output({ query, keywords, count: bookmarks.length, bookmarks })
}

async function cmdAiSearch(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) die('Usage: siftly ai-search <query or question> [--category <slug>]')

  const result = await aiSearch(query, { category: flags.category })
  output({
    query,
    answer: result.answer,
    explanation: result.explanation,
    ...(result.notice ? { notice: result.notice } : {}),
    count: result.bookmarks.length,
    bookmarks: result.bookmarks.map((b, i) => ({
      result: i + 1,
      score: b.aiScore,
      reason: b.aiReason,
      id: b.id,
      tweetId: b.tweetId,
      authorHandle: b.authorHandle,
      text: b.text,
      tweetCreatedAt: b.tweetCreatedAt,
      categories: b.categories.map((c) => c.slug),
    })),
  })
}

async function cmdList(args: string[]) {
  const { flags } = parseArgs(args)

  const limit = Math.min(parseInt(flags.limit ?? '20', 10) || 20, 100)
  const page = parseInt(flags.page ?? '1', 10) || 1
  const skip = (page - 1) * limit
  const sortDir = flags.sort === 'oldest' ? 'asc' as const : 'desc' as const

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {}

  if (flags.source === 'bookmark' || flags.source === 'like') {
    where.source = flags.source
  }
  if (flags.category) {
    where.categories = { some: { category: { slug: flags.category } } }
  }
  if (flags.author) {
    where.authorHandle = flags.author
  }
  if (flags.media === 'photo' || flags.media === 'video') {
    where.mediaItems = { some: { type: flags.media } }
  } else if (flags.media === 'article') {
    where.AND = [ARTICLE_WHERE]
  }

  const [bookmarks, total] = await Promise.all([
    prisma.bookmark.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ tweetCreatedAt: sortDir }, { importedAt: sortDir }],
      include: {
        mediaItems: { select: { id: true, type: true, url: true } },
        categories: {
          include: { category: { select: { name: true, slug: true } } },
          orderBy: { confidence: 'desc' },
        },
      },
    }),
    prisma.bookmark.count({ where }),
  ])

  output({
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    bookmarks: bookmarks.map(formatBookmark),
  })
}

async function cmdShow(args: string[]) {
  const id = args[0]
  if (!id) die('Usage: siftly show <id|tweetId>')

  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id }, { tweetId: id }] },
    include: {
      mediaItems: true,
      categories: {
        include: { category: { select: { id: true, name: true, slug: true, color: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  if (!bookmark) die(`Bookmark not found: ${id}`)

  const archiveRoot = await getArchiveRoot()
  output({
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
    importedAt: bookmark.importedAt.toISOString(),
    enrichedAt: bookmark.enrichedAt?.toISOString() ?? null,
    archivedAt: bookmark.archivedAt?.toISOString() ?? null,
    archiveStatus: bookmark.archiveStatus,
    archiveDir: bookmark.archivedAt ? path.join(archiveRoot, archiveFolderName(bookmark.tweetId)) : null,
    archiveWarnings: bookmark.archiveError ? bookmark.archiveError.split('\n') : [],
    semanticTags: safeParse(bookmark.semanticTags),
    entities: safeParse(bookmark.entities),
    enrichmentMeta: safeParse(bookmark.enrichmentMeta),
    mediaItems: bookmark.mediaItems.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      localPath: m.localPath ? path.join(archiveRoot, m.localPath) : null,
      imageTags: safeParse(m.imageTags),
    })),
    categories: bookmark.categories.map((bc) => ({
      id: bc.category.id,
      name: bc.category.name,
      slug: bc.category.slug,
      color: bc.category.color,
      confidence: bc.confidence,
    })),
  })
}

async function cmdCategories() {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { bookmarks: true } } },
    orderBy: { name: 'asc' },
  })

  output({
    count: categories.length,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      bookmarkCount: c._count.bookmarks,
    })),
  })
}

async function cmdStats() {
  const [totalBookmarks, totalCategories, totalMedia, sourceGroups, enrichedCount] =
    await Promise.all([
      prisma.bookmark.count(),
      prisma.category.count(),
      prisma.mediaItem.count(),
      prisma.bookmark.groupBy({ by: ['source'], _count: true }),
      prisma.bookmark.count({ where: { enrichedAt: { not: null } } }),
    ])

  const sources: Record<string, number> = {}
  for (const g of sourceGroups) {
    sources[g.source] = g._count
  }

  output({
    totalBookmarks,
    enrichedBookmarks: enrichedCount,
    unenrichedBookmarks: totalBookmarks - enrichedCount,
    totalCategories,
    totalMediaItems: totalMedia,
    sources,
  })
}

async function cmdArchiveStatus() {
  const [location, stats, xSession] = await Promise.all([getArchiveLocation(), getArchiveStats(), getXSessionStatus()])
  output({
    archiveDir: location.dir,
    customArchiveDir: location.custom,
    ...stats,
    // Settings → X Login: needed for the full text of X Articles
    xLogin: { loggedIn: xSession.loggedIn, screenName: xSession.account?.screenName ?? null, rejectedAt: xSession.rejectedAt },
  })
}

async function cmdArchiveDir(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const input = positional.join(' ')
  if (!input && flags.reset !== 'true') {
    const location = await getArchiveLocation()
    output({ archiveDir: location.dir, defaultArchiveDir: location.defaultDir, custom: location.custom })
    return
  }
  const result = await setArchiveDir(flags.reset === 'true' ? null : input, { moveFiles: flags['no-move'] !== 'true' })
  output({ archiveDir: result.dir, custom: result.custom, moved: result.moved ?? null, needDownloadAgain: result.missing })
}

async function cmdArchive(args: string[]) {
  const { flags } = parseArgs(args)
  const mode: ArchiveMode = flags.mode === 'retry' || flags.mode === 'all' ? flags.mode : 'pending'
  const limit = flags.limit ? Math.max(parseInt(flags.limit, 10) || 0, 0) : undefined

  const where = flags.id ? { OR: [{ id: flags.id }, { tweetId: flags.id }] } : archiveWhereForMode(mode)

  const bookmarks = await prisma.bookmark.findMany({
    where,
    select: { id: true, tweetId: true },
    orderBy: { importedAt: 'desc' },
    ...(limit ? { take: limit } : {}),
  })
  if (flags.id && bookmarks.length === 0) die(`Bookmark not found: ${flags.id}`)

  // --offline: build archives from stored data only, without contacting X
  const fetcher = flags.offline === 'true' ? null : await createXFetcher()
  const waitForRateLimit = (until: number) => {
    process.stderr.write(`X rate limit reached — waiting until ${new Date(until).toLocaleTimeString()} to fetch the full article…\n`)
    return waitForRateLimitReset(until, () => false)
  }
  const results = []
  for (const b of bookmarks) {
    const r = await archiveBookmark(b.id, { fetcher, waitForRateLimit })
    results.push({ tweetId: r.tweetId, status: r.status, warnings: r.warnings })
    if (isTTY) process.stderr.write(`[${results.length}/${bookmarks.length}] ${r.tweetId} ${r.status}\n`)
  }

  output({
    archiveDir: await getArchiveRoot(),
    processed: results.length,
    complete: results.filter((r) => r.status === 'complete').length,
    partial: results.filter((r) => r.status === 'partial').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(json: string | null): unknown {
  if (!json) return null
  try { return JSON.parse(json) } catch { return json }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatBookmark(b: any) {
  return {
    id: b.id,
    tweetId: b.tweetId,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    source: b.source,
    tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
    mediaItems: b.mediaItems.map((m: { id: string; type: string; url: string }) => ({
      id: m.id,
      type: m.type,
      url: m.url,
    })),
    categories: b.categories.map(
      (bc: { category: { name: string; slug: string }; confidence: number }) => ({
        name: bc.category.name,
        slug: bc.category.slug,
        confidence: bc.confidence,
      })
    ),
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  search: 'search <query>           Keyword search over posts, quoted posts, links and full X Articles',
  'ai-search': 'ai-search <query> [--category <slug>]   AI search; questions get an answer citing the results',
  list: 'list [--source] [--category] [--author] [--media photo|video|article] [--sort] [--limit] [--page]',
  show: 'show <id|tweetId>         Full bookmark detail',
  categories: 'categories                List categories with counts',
  stats: 'stats                     Library statistics',
  archive: 'archive [--mode pending|retry|all] [--id <id|tweetId>] [--limit N] [--offline]   Save bookmarks locally',
  'archive-status': 'archive-status            Local archive statistics',
  'archive-dir': 'archive-dir [<folder>] [--no-move] [--reset]   Show or change the archive folder (moves saved files unless --no-move)',
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const rest = args.slice(1)

  if (!command || command === '--help' || command === '-h') {
    output({
      usage: 'siftly <command> [options]',
      commands: COMMANDS,
    })
    process.exit(0)
  }

  try {
    switch (command) {
      case 'search':
        await cmdSearch(rest)
        break
      case 'ai-search':
        await cmdAiSearch(rest)
        break
      case 'list':
        await cmdList(rest)
        break
      case 'show':
        await cmdShow(rest)
        break
      case 'categories':
        await cmdCategories()
        break
      case 'stats':
        await cmdStats()
        break
      case 'archive':
        await cmdArchive(rest)
        break
      case 'archive-status':
        await cmdArchiveStatus()
        break
      case 'archive-dir':
        await cmdArchiveDir(rest)
        break
      default:
        die(`Unknown command: ${command}. Run 'siftly --help' for usage.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table')) {
      die('Prisma client not generated or database not set up. Run: npx prisma generate && npx prisma db push')
    }
    throw err
  } finally {
    await prisma.$disconnect()
  }
}

main()
