/**
 * Local archive: saves each bookmark's full text, media, quoted post, link
 * card and X Article body (with inline images/videos in place) to disk so it
 * survives the original being deleted from X.
 *
 * Content is merged from three places, richest first:
 *   1. a fresh copy from X (GraphQL, then syndication)
 *   2. the JSON stored at import time
 *   3. the previous archive of the same tweet, if any
 * so re-archiving a post that has since been deleted never loses data.
 */
import { promises as fs } from 'fs'
import path from 'path'
import prisma from '@/lib/db'
import {
  ARCHIVE_VERSION,
  tweetUrlFor,
  type ArchiveDocument,
  type ArchivedArticle,
  type ArchivedMedia,
  type ArchiveStatus,
  type ArticleBlock,
} from '@/lib/archive-types'
import { decodeHtmlEntities, mergeSnapshots, parseStoredRaw, type TweetSnapshot } from '@/lib/tweet-snapshot'
import { XTweetFetcher, type FetchLike, type RemoteTweet } from '@/lib/x-tweet-fetcher'
import {
  archiveFolderName,
  downloadToFile,
  fileKey,
  getArchiveRoot,
  isAllowedMediaUrl,
  isHlsUrl,
  isVideoFileUrl,
  mediaIdentity,
  originalImageUrl,
  writeFileAtomic,
} from '@/lib/archive-storage'
import { renderArchiveHtml, renderArchiveMarkdown } from '@/lib/archive-render'

// ── Building one archive (no database access — unit-testable) ───────────────

export interface ArchiveSourceBookmark {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  rawJson: string
}

export interface ArchiveSourceMediaItem {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
}

export interface BuildArchiveDeps {
  root: string
  /** Used for media downloads */
  fetchImpl?: FetchLike
  /** Source of fresh copies from X — null archives from stored data only */
  fetcher: XTweetFetcher | null
  now?: Date
}

export interface MediaItemUpdate {
  id: string
  localPath: string | null
  localThumbnailPath: string | null
}

export interface NewMediaItem {
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
  localThumbnailPath: string | null
}

export interface BuildArchiveResult {
  folder: string
  doc: ArchiveDocument
  status: ArchiveStatus
  mediaUpdates: MediaItemUpdate[]
  newMedia: NewMediaItem[]
}

const MAX_EMBEDDED_TWEETS = 20
const DOWNLOAD_CONCURRENCY = 3

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function snapshotFromArchiveDoc(doc: ArchiveDocument | null): TweetSnapshot | null {
  if (!doc || doc.version !== ARCHIVE_VERSION) return null
  return {
    tweetId: doc.tweetId,
    authorName: doc.author.name,
    authorHandle: doc.author.handle,
    avatarUrl: doc.author.avatarUrl,
    createdAt: doc.createdAt,
    text: doc.text,
    media: doc.media,
    ...(doc.quote
      ? {
          quote: {
            tweetId: doc.quote.tweetId,
            authorName: doc.quote.author.name,
            authorHandle: doc.quote.author.handle,
            avatarUrl: doc.quote.author.avatarUrl,
            createdAt: doc.quote.createdAt,
            text: doc.quote.text,
            media: doc.quote.media,
            unavailable: doc.quote.unavailable,
          },
        }
      : {}),
    ...(doc.card ? { card: doc.card } : {}),
    ...(doc.poll ? { poll: doc.poll } : {}),
    ...(doc.article ? { article: doc.article } : {}),
  }
}

function dbMediaToArchived(item: ArchiveSourceMediaItem): ArchivedMedia {
  const type = item.type === 'video' ? 'video' : item.type === 'gif' ? 'gif' : 'photo'
  return type === 'photo'
    ? { type, url: item.url }
    : { type, url: item.url, ...(item.thumbnailUrl ? { posterUrl: item.thumbnailUrl } : {}) }
}

function identitiesOf(m: ArchivedMedia | undefined): Set<string> {
  const ids = new Set<string>()
  for (const url of [m?.url, m?.posterUrl]) {
    const id = mediaIdentity(url)
    if (id) ids.add(id)
  }
  return ids
}

type MediaLocation =
  | { where: 'media'; index: number }
  | { where: 'cover' }
  | { where: 'article'; block: number; item: number }
  | { where: 'card' }

export async function buildArchive(
  bookmark: ArchiveSourceBookmark,
  dbMedia: ArchiveSourceMediaItem[],
  deps: BuildArchiveDeps,
): Promise<BuildArchiveResult> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const folder = archiveFolderName(bookmark.tweetId)
  const dir = path.join(deps.root, folder)
  const mediaDir = path.join(dir, 'media')
  await fs.mkdir(mediaDir, { recursive: true })

  const warnings: string[] = []
  let incomplete = false
  const warn = (message: string, critical = true) => {
    warnings.push(message)
    if (critical) incomplete = true
  }

  // ── Gather & merge content ──────────────────────────────────────────────
  const parsedStored = parseStoredRaw(bookmark.rawJson, bookmark.tweetId)
  const stored = parsedStored?.snapshot ?? null
  const previousDoc = await readJson<ArchiveDocument>(path.join(dir, 'archive.json'))
  const previous = snapshotFromArchiveDoc(previousDoc)

  // A GraphQL payload from import already has the full text and every video
  // rendition; refreshing it via syndication spares X's GraphQL rate limit for
  // articles and file imports, which need it.
  const knownArticle = stored?.article ?? previous?.article
  const preferSyndication = parsedStored?.format === 'graphql' && !(knownArticle && !knownArticle.complete)
  const remote: RemoteTweet | null = deps.fetcher ? await deps.fetcher.fetchTweet(bookmark.tweetId, { preferSyndication }) : null

  let snap = mergeSnapshots(mergeSnapshots(remote?.snapshot ?? null, stored), previous)
  if (!snap) snap = { tweetId: bookmark.tweetId, text: '', media: [] }

  const unavailableOnX = !!remote?.unavailable || !!remote?.snapshot?.unavailable
  if (!snap.text && !snap.article && bookmark.text) snap.text = decodeHtmlEntities(bookmark.text)
  const authorHandle = snap.authorHandle ?? (bookmark.authorHandle !== 'unknown' ? bookmark.authorHandle : '')
  const authorName = snap.authorName ?? bookmark.authorName

  const sources: string[] = []
  if (remote?.source) sources.push(remote.source)
  if (stored) sources.push('stored')
  if (previous) sources.push('previous-archive')

  if (deps.fetcher && !remote?.snapshot) {
    if (unavailableOnX) {
      warn('This post is no longer available on X — archived from the copy Siftly saved earlier.', false)
    } else {
      warn(`Couldn't fetch the latest version from X (${remote?.errors.join('; ') || 'no response'}). Archived from the data stored at import time.`)
    }
  }

  // Fill in embedded posts of X Articles so they're readable offline
  if (snap.article && deps.fetcher) {
    const previousEmbeds = new Map<string, ArticleBlock>()
    for (const block of previous?.article?.blocks ?? []) {
      if (block.type === 'embedded-tweet') previousEmbeds.set(block.tweetId, block)
    }
    let fetched = 0
    const blocks: ArticleBlock[] = []
    for (const block of snap.article.blocks) {
      if (block.type !== 'embedded-tweet' || block.text) {
        blocks.push(block)
        continue
      }
      let filled: ArticleBlock = previousEmbeds.get(block.tweetId) ?? block
      if (fetched < MAX_EMBEDDED_TWEETS && !(filled.type === 'embedded-tweet' && filled.text)) {
        fetched++
        const embedded = await deps.fetcher.fetchTweet(block.tweetId, { preferSyndication: true })
        if (embedded.snapshot) {
          filled = {
            ...block,
            tweetUrl: tweetUrlFor(embedded.snapshot.authorHandle, block.tweetId),
            authorName: embedded.snapshot.authorName,
            authorHandle: embedded.snapshot.authorHandle,
            text: embedded.snapshot.text,
          }
        }
      }
      blocks.push(filled)
    }
    snap = { ...snap, article: { ...snap.article, blocks } }
  }

  // ── Match existing MediaItem rows to archived media ─────────────────────
  const plannedMedia = [...snap.media]
  const article = snap.article
  const matches = new Map<string, MediaLocation>()
  const matchedIndices = new Set<number>()

  for (const item of dbMedia) {
    const ids = new Set([mediaIdentity(item.url), mediaIdentity(item.thumbnailUrl)].filter((i): i is string => !!i))
    const hit = (m: ArchivedMedia | undefined) => [...identitiesOf(m)].some((i) => ids.has(i))

    let location: MediaLocation | null = null
    const index = plannedMedia.findIndex(hit)
    if (index >= 0) location = { where: 'media', index }
    else if (hit(article?.coverImage)) location = { where: 'cover' }
    else if (snap.card?.imageUrl && ids.has(mediaIdentity(snap.card.imageUrl) ?? '')) location = { where: 'card' }
    else {
      article?.blocks.forEach((block, b) => {
        if (location || block.type !== 'media') return
        const i = block.media.findIndex(hit)
        if (i >= 0) location = { where: 'article', block: b, item: i }
      })
    }
    if (!location) {
      plannedMedia.push(dbMediaToArchived(item))
      location = { where: 'media', index: plannedMedia.length - 1 }
    }
    if (location.where === 'media') matchedIndices.add(location.index)
    matches.set(item.id, location)
  }

  // ── Download everything ─────────────────────────────────────────────────
  const existingFiles = new Map<string, string>()
  for (const name of await fs.readdir(mediaDir).catch(() => [] as string[])) {
    if (name.endsWith('.part') || name.endsWith('.tmp')) continue
    existingFiles.set(name.replace(/\.[^.]+$/, ''), name)
  }

  const inRun = new Map<string, Promise<{ file?: string; error?: string }>>()
  const ensureFile = (url: string, kind: string, expect: 'image' | 'video') => {
    const key = fileKey(kind, url)
    let pending = inRun.get(key)
    if (!pending) {
      pending = (async () => {
        const existing = existingFiles.get(key)
        if (existing) return { file: `media/${existing}` }
        if (!isAllowedMediaUrl(url)) return { error: 'not an X media URL' }
        const candidates = expect === 'image' ? [...new Set([originalImageUrl(url), url])] : [url]
        let error = 'download failed'
        for (const candidate of candidates) {
          const result = await downloadToFile(candidate, path.join(mediaDir, key), { fetchImpl, expect })
          if (result.ok) return { file: `media/${path.basename(result.file)}` }
          error = result.error
        }
        return { error }
      })()
      inRun.set(key, pending)
    }
    return pending
  }

  // Downloads run concurrently; issues are collected per item and reported in document order
  type Localized = { media: ArchivedMedia; issues: string[] }
  const localize = async (m: ArchivedMedia, label: string): Promise<Localized> => {
    const out: ArchivedMedia = { ...m, file: undefined, posterFile: undefined }
    const issues: string[] = []
    if (m.type === 'photo') {
      const r = await ensureFile(m.url, 'photo', 'image')
      if (r.file) out.file = r.file
      else issues.push(`${label}: couldn't save image (${r.error})`)
      return { media: out, issues }
    }

    const noun = m.type === 'gif' ? 'GIF' : 'video'
    if (isVideoFileUrl(m.url)) {
      const r = await ensureFile(m.url, m.type, 'video')
      if (r.file) out.file = r.file
      else issues.push(`${label}: couldn't save ${noun} (${r.error})`)
    } else if (isHlsUrl(m.url)) {
      issues.push(`${label}: X only offers this ${noun} as a stream, which can't be saved`)
    } else {
      issues.push(`${label}: no downloadable ${noun} file is known`)
    }

    const poster = m.posterUrl ?? (!isVideoFileUrl(m.url) && !isHlsUrl(m.url) ? m.url : undefined)
    if (poster) {
      const r = await ensureFile(poster, 'poster', 'image')
      if (r.file) out.posterFile = r.file
    }
    return { media: out, issues }
  }
  const report = (results: Localized[]) => {
    for (const r of results) for (const issue of r.issues) warn(issue)
    return results.map((r) => r.media)
  }

  const media = report(await mapLimit(plannedMedia, DOWNLOAD_CONCURRENCY, (m, i) => localize(m, `Media ${i + 1}`)))

  let localizedArticle: ArchivedArticle | undefined
  if (article) {
    const cover = article.coverImage ? report([await localize(article.coverImage, 'Article cover')])[0] : undefined
    let counter = 0
    const firstLabel = article.blocks.map((block) => {
      const start = counter + 1
      if (block.type === 'media') counter += block.media.length
      return start
    })
    const localizedBlocks = await mapLimit(article.blocks, DOWNLOAD_CONCURRENCY, async (block, b) =>
      block.type === 'media'
        ? { block, results: await Promise.all(block.media.map((m, i) => localize(m, `Article media ${firstLabel[b] + i}`))) }
        : { block, results: [] as Localized[] },
    )
    const blocks = localizedBlocks.map(({ block, results }): ArticleBlock =>
      block.type === 'media' ? { ...block, media: report(results) } : block,
    )
    localizedArticle = { ...article, blocks, ...(cover ? { coverImage: cover } : {}) }
    if (!article.complete) {
      warn("Only the article's preview was available — X didn't return the full text. Saving your X session in Import → Live sync usually fixes this.")
    }
  }

  const quote = snap.quote
  const quoteMedia = quote ? report(await mapLimit(quote.media, DOWNLOAD_CONCURRENCY, (m, i) => localize(m, `Quoted post media ${i + 1}`))) : []

  const avatarSource = snap.avatarUrl ?? (authorHandle ? `https://unavatar.io/twitter/${encodeURIComponent(authorHandle)}?fallback=false` : undefined)
  const avatar = avatarSource ? await ensureFile(avatarSource, 'avatar', 'image') : {}
  const quoteAvatar = quote?.avatarUrl ? await ensureFile(quote.avatarUrl, 'avatar', 'image') : {}

  let card = snap.card
  if (card?.imageUrl) {
    const r = await ensureFile(card.imageUrl, 'card', 'image')
    card = { ...card, imageFile: r.file }
    if (!r.file) warn(`Link preview image: couldn't save (${r.error})`, false)
  }

  // ── Assemble document ───────────────────────────────────────────────────
  const archivedAt = (deps.now ?? new Date()).toISOString()
  const doc: ArchiveDocument = {
    version: ARCHIVE_VERSION,
    tweetId: bookmark.tweetId,
    tweetUrl: tweetUrlFor(authorHandle, bookmark.tweetId),
    author: {
      name: authorName,
      handle: authorHandle,
      ...(snap.avatarUrl ? { avatarUrl: snap.avatarUrl } : {}),
      ...(avatar.file ? { avatarFile: avatar.file } : {}),
    },
    createdAt: snap.createdAt ?? bookmark.tweetCreatedAt?.toISOString() ?? null,
    archivedAt,
    text: snap.text,
    media,
    ...(quote
      ? {
          quote: {
            tweetId: quote.tweetId,
            tweetUrl: tweetUrlFor(quote.authorHandle, quote.tweetId),
            author: {
              name: quote.authorName ?? '',
              handle: quote.authorHandle ?? '',
              ...(quote.avatarUrl ? { avatarUrl: quote.avatarUrl } : {}),
              ...(quoteAvatar.file ? { avatarFile: quoteAvatar.file } : {}),
            },
            createdAt: quote.createdAt ?? null,
            text: quote.text,
            media: quoteMedia,
            ...(quote.unavailable ? { unavailable: true } : {}),
          },
        }
      : {}),
    ...(card ? { card } : {}),
    ...(snap.poll ? { poll: snap.poll } : {}),
    ...(localizedArticle ? { article: localizedArticle } : {}),
    sources,
    ...(unavailableOnX ? { unavailableOnX: true } : {}),
    warnings,
  }

  // ── Write files ─────────────────────────────────────────────────────────
  const previousSource = await readJson<{ remote?: unknown }>(path.join(dir, 'source.json'))
  let storedRaw: unknown = bookmark.rawJson
  try { storedRaw = JSON.parse(bookmark.rawJson) } catch { /* keep string */ }
  const source = {
    savedAt: archivedAt,
    stored: storedRaw,
    // Keep the last good copy from X when this run couldn't get a new one
    remote: remote?.raw ? { source: remote.source, raw: remote.raw } : previousSource?.remote ?? null,
  }

  await writeFileAtomic(path.join(dir, 'archive.json'), JSON.stringify(doc, null, 2))
  await writeFileAtomic(path.join(dir, 'source.json'), JSON.stringify(source, null, 2))
  await writeFileAtomic(path.join(dir, 'index.html'), renderArchiveHtml(doc))
  await writeFileAtomic(path.join(dir, 'content.md'), renderArchiveMarkdown(doc))

  // ── Map results back onto MediaItem rows ────────────────────────────────
  const local = (file: string | undefined) => (file ? `${folder}/${file}` : null)
  const mediaUpdates: MediaItemUpdate[] = dbMedia.map((item) => {
    const location = matches.get(item.id)
    let m: ArchivedMedia | undefined
    if (location?.where === 'media') m = media[location.index]
    else if (location?.where === 'cover') m = localizedArticle?.coverImage
    else if (location?.where === 'article') {
      const block = localizedArticle?.blocks[location.block]
      m = block?.type === 'media' ? block.media[location.item] : undefined
    } else if (location?.where === 'card') {
      return { id: item.id, localPath: local(card?.imageFile), localThumbnailPath: null }
    }
    return { id: item.id, localPath: local(m?.file), localThumbnailPath: local(m?.posterFile) }
  })

  const newMedia: NewMediaItem[] = media
    .map((m, index) => ({ m, index }))
    .filter(({ index }) => !matchedIndices.has(index))
    .map(({ m }) => ({
      type: m.type,
      url: m.url,
      thumbnailUrl: m.posterUrl ?? (m.type === 'photo' ? m.url : null),
      localPath: local(m.file),
      localThumbnailPath: local(m.posterFile),
    }))

  return { folder, doc, status: incomplete ? 'partial' : 'complete', mediaUpdates, newMedia }
}

// ── Database wrapper ─────────────────────────────────────────────────────────

export interface ArchiveBookmarkResult {
  bookmarkId: string
  tweetId: string
  status: ArchiveStatus
  warnings: string[]
  archivedAt: string | null
}

const store = globalThis as unknown as {
  siftlyArchiveInFlight?: Map<string, Promise<ArchiveBookmarkResult>>
  siftlyArchiveJob?: ArchiveJob
}
const inFlight = (store.siftlyArchiveInFlight ??= new Map())

export async function createXFetcher(fetchImpl?: FetchLike): Promise<XTweetFetcher> {
  const [authToken, ct0] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
    prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
  ])
  const credentials = authToken?.value && ct0?.value ? { authToken: authToken.value, ct0: ct0.value } : null
  return new XTweetFetcher({ credentials, fetchImpl })
}

/** Archive one bookmark now. Concurrent calls for the same bookmark share one run. */
export function archiveBookmark(
  bookmarkId: string,
  options: { fetcher?: XTweetFetcher | null; fetchImpl?: FetchLike; root?: string } = {},
): Promise<ArchiveBookmarkResult> {
  const running = inFlight.get(bookmarkId)
  if (running) return running
  const run = runArchiveBookmark(bookmarkId, options).finally(() => inFlight.delete(bookmarkId))
  inFlight.set(bookmarkId, run)
  return run
}

async function runArchiveBookmark(
  bookmarkId: string,
  options: { fetcher?: XTweetFetcher | null; fetchImpl?: FetchLike; root?: string },
): Promise<ArchiveBookmarkResult> {
  const bookmark = await prisma.bookmark.findUnique({
    where: { id: bookmarkId },
    include: { mediaItems: { select: { id: true, type: true, url: true, thumbnailUrl: true } } },
  })
  if (!bookmark) throw new Error(`Bookmark not found: ${bookmarkId}`)

  try {
    const fetcher = options.fetcher === undefined ? await createXFetcher(options.fetchImpl) : options.fetcher
    const result = await buildArchive(bookmark, bookmark.mediaItems, {
      root: options.root ?? getArchiveRoot(),
      fetcher,
      fetchImpl: options.fetchImpl,
    })
    const archivedAt = new Date(result.doc.archivedAt)

    await prisma.$transaction([
      prisma.bookmark.update({
        where: { id: bookmark.id },
        data: {
          archivedAt,
          archiveStatus: result.status,
          archiveError: result.doc.warnings.length > 0 ? result.doc.warnings.join('\n').slice(0, 4000) : null,
        },
      }),
      ...result.mediaUpdates.map((u) =>
        prisma.mediaItem.update({
          where: { id: u.id },
          data: { localPath: u.localPath, localThumbnailPath: u.localThumbnailPath },
        }),
      ),
      ...(result.newMedia.length > 0
        ? [prisma.mediaItem.createMany({ data: result.newMedia.map((m) => ({ ...m, bookmarkId: bookmark.id })) })]
        : []),
    ])

    return {
      bookmarkId: bookmark.id,
      tweetId: bookmark.tweetId,
      status: result.status,
      warnings: result.doc.warnings,
      archivedAt: archivedAt.toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[archive] Failed to archive tweet ${bookmark.tweetId}:`, message)
    // A failed re-run leaves the previous archive (and its status) untouched
    await prisma.bookmark.update({
      where: { id: bookmark.id },
      data: bookmark.archivedAt
        ? { archiveError: `Last re-archive failed: ${message}`.slice(0, 4000) }
        : { archiveStatus: 'failed', archiveError: message.slice(0, 4000) },
    })
    return {
      bookmarkId: bookmark.id,
      tweetId: bookmark.tweetId,
      status: bookmark.archivedAt ? ((bookmark.archiveStatus as ArchiveStatus | null) ?? 'failed') : 'failed',
      warnings: [message],
      archivedAt: bookmark.archivedAt?.toISOString() ?? null,
    }
  }
}

/** Read a bookmark's archive document from disk, or null if it was never archived */
export async function readArchiveDocument(tweetId: string, root = getArchiveRoot()): Promise<{ folder: string; doc: ArchiveDocument } | null> {
  const folder = archiveFolderName(tweetId)
  const doc = await readJson<ArchiveDocument>(path.join(root, folder, 'archive.json'))
  return doc ? { folder, doc } : null
}

// ── Background job ───────────────────────────────────────────────────────────

/** pending = never attempted · retry = pending + partial + failed · all = everything */
export type ArchiveMode = 'pending' | 'retry' | 'all'

export interface ArchiveJobState {
  status: 'idle' | 'running' | 'stopping'
  mode: ArchiveMode | null
  total: number
  done: number
  complete: number
  partial: number
  failed: number
  current: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

interface ArchiveJob {
  state: ArchiveJobState
  abort: boolean
  /** New bookmarks arrived while a job was running — pick them up afterwards */
  rerun: boolean
}

const JOB_CONCURRENCY = 3

function job(): ArchiveJob {
  store.siftlyArchiveJob ??= {
    state: {
      status: 'idle',
      mode: null,
      total: 0,
      done: 0,
      complete: 0,
      partial: 0,
      failed: 0,
      current: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    abort: false,
    rerun: false,
  }
  return store.siftlyArchiveJob
}

export function getArchiveJobState(): ArchiveJobState {
  return { ...job().state }
}

export function stopArchiveJob(): boolean {
  const j = job()
  if (j.state.status !== 'running') return false
  j.abort = true
  j.rerun = false
  j.state = { ...j.state, status: 'stopping' }
  return true
}

function whereForMode(mode: ArchiveMode) {
  if (mode === 'all') return {}
  if (mode === 'retry') return { OR: [{ archiveStatus: null }, { archiveStatus: { in: ['partial', 'failed'] } }] }
  return { archiveStatus: null }
}

export function startArchiveJob(options: { mode?: ArchiveMode; bookmarkIds?: string[] } = {}): boolean {
  const j = job()
  if (j.state.status !== 'idle') return false
  const mode = options.mode ?? 'pending'
  j.abort = false
  j.state = {
    status: 'running',
    mode,
    total: 0,
    done: 0,
    complete: 0,
    partial: 0,
    failed: 0,
    current: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  }
  void runJob(mode, options.bookmarkIds)
  return true
}

async function runJob(mode: ArchiveMode, bookmarkIds?: string[]): Promise<void> {
  const j = job()
  try {
    const where = bookmarkIds && bookmarkIds.length > 0 ? { id: { in: bookmarkIds } } : whereForMode(mode)
    const queue = await prisma.bookmark.findMany({
      where,
      select: { id: true, tweetId: true, authorHandle: true },
      orderBy: { importedAt: 'desc' },
    })
    j.state = { ...j.state, total: queue.length }
    const fetcher = await createXFetcher()

    let next = 0
    const worker = async () => {
      while (!j.abort && next < queue.length) {
        const item = queue[next++]
        j.state = { ...j.state, current: item.authorHandle !== 'unknown' ? `@${item.authorHandle}` : item.tweetId }
        try {
          const result = await archiveBookmark(item.id, { fetcher })
          j.state = {
            ...j.state,
            done: j.state.done + 1,
            complete: j.state.complete + (result.status === 'complete' ? 1 : 0),
            partial: j.state.partial + (result.status === 'partial' ? 1 : 0),
            failed: j.state.failed + (result.status === 'failed' ? 1 : 0),
          }
        } catch (err) {
          j.state = { ...j.state, done: j.state.done + 1, failed: j.state.failed + 1, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, Math.max(queue.length, 1)) }, worker))
  } catch (err) {
    j.state = { ...j.state, error: err instanceof Error ? err.message : String(err) }
    console.error('[archive] Job failed:', err)
  } finally {
    j.state = { ...j.state, status: 'idle', current: null, finishedAt: new Date().toISOString() }
    if (j.rerun && !j.abort) {
      j.rerun = false
      startArchiveJob({ mode: 'pending' })
    }
  }
}

export const AUTO_ARCHIVE_SETTING = 'autoArchive'

export async function isAutoArchiveEnabled(): Promise<boolean> {
  const setting = await prisma.setting.findUnique({ where: { key: AUTO_ARCHIVE_SETTING } })
  return setting?.value === 'true'
}

/** Call after any import: archives new bookmarks in the background when enabled */
export async function triggerAutoArchive(): Promise<void> {
  try {
    if (!(await isAutoArchiveEnabled())) return
    const j = job()
    if (j.state.status !== 'idle') {
      j.rerun = true
      return
    }
    startArchiveJob({ mode: 'pending' })
  } catch (err) {
    console.warn('[archive] Auto-archive could not start:', err instanceof Error ? err.message : err)
  }
}

export async function getArchiveStats() {
  const [total, complete, partial, failed, pending] = await Promise.all([
    prisma.bookmark.count(),
    prisma.bookmark.count({ where: { archiveStatus: 'complete' } }),
    prisma.bookmark.count({ where: { archiveStatus: 'partial' } }),
    prisma.bookmark.count({ where: { archiveStatus: 'failed' } }),
    prisma.bookmark.count({ where: { archiveStatus: null } }),
  ])
  return { total, archived: complete + partial, complete, partial, failed, pending }
}
