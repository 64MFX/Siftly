/**
 * Saves each bookmark's link card (lib/link-card.ts) in Bookmark.linkCard the
 * first time it's needed — by a bookmark card on screen or the AI pipeline —
 * and re-indexes the bookmark so search reads the card too. The archiver
 * writes it directly whenever it saves a post.
 */
import prisma from '@/lib/db'
import type { LinkCard } from '@/lib/types'
import { tweetUrlFor } from '@/lib/archive-types'
import { readArchiveDocument } from '@/lib/archiver'
import { snapshotFromArchiveDoc, snapshotFromStoredRaw } from '@/lib/tweet-snapshot'
import { fetchLinkCard, linkCardFromSnapshot, parseLinkCard, postLink, type FetchedLinkCard } from '@/lib/link-card'
import type { FetchLike } from '@/lib/x-tweet-fetcher'
import { reindexBookmarks } from '@/lib/search-index'

export interface ResolveLinkCardOptions {
  /** Ask X and the linked page when nothing saved has a card (default true) */
  network?: boolean
  fetchImpl?: FetchLike
  archiveRoot?: string
}

const store = globalThis as unknown as { siftlyLinkCardInFlight?: Map<string, Promise<FetchedLinkCard | null>> }
const inFlight = (store.siftlyLinkCardInFlight ??= new Map())

export async function saveLinkCard(bookmarkId: string, card: LinkCard): Promise<void> {
  await prisma.bookmark.updateMany({ where: { id: bookmarkId }, data: { linkCard: JSON.stringify(card) } })
  await reindexBookmarks([bookmarkId]).catch((err) => console.error(`[link-card] Search index update failed for ${bookmarkId}:`, err))
}

/**
 * A bookmark's link card: the saved one, else the one in its archive or stored
 * JSON, else — for a post with a link and no media — one looked up on the
 * network. A card that wasn't saved yet is saved. Null when the bookmark
 * doesn't exist. Concurrent calls for one bookmark share a lookup.
 */
export function resolveLinkCard(bookmarkId: string, options: ResolveLinkCardOptions = {}): Promise<FetchedLinkCard | null> {
  const running = inFlight.get(bookmarkId)
  if (running) return running
  const run = runResolve(bookmarkId, options).finally(() => inFlight.delete(bookmarkId))
  inFlight.set(bookmarkId, run)
  return run
}

async function runResolve(bookmarkId: string, options: ResolveLinkCardOptions): Promise<FetchedLinkCard | null> {
  const bookmark = await prisma.bookmark.findUnique({
    where: { id: bookmarkId },
    select: {
      id: true,
      tweetId: true,
      text: true,
      rawJson: true,
      linkCard: true,
      archivedAt: true,
      _count: { select: { mediaItems: true } },
    },
  })
  if (!bookmark) return null

  const saved = parseLinkCard(bookmark.linkCard)
  if (saved) return { card: saved, url: saved.url }

  const archive = bookmark.archivedAt ? await readArchiveDocument(bookmark.tweetId, options.archiveRoot).catch(() => null) : null
  const stored = snapshotFromStoredRaw(bookmark.rawJson, bookmark.tweetId)
  let card = (archive ? linkCardFromSnapshot(snapshotFromArchiveDoc(archive.doc), archive.folder) : null) ?? linkCardFromSnapshot(stored)
  let url = card?.url ?? null

  const link = postLink(bookmark.text)
  if (!card && stored?.quote) {
    // The link is the quoted post — nothing to look up
    url = tweetUrlFor(stored.quote.authorHandle, stored.quote.tweetId)
  } else if (!card && options.network !== false && link && bookmark._count.mediaItems === 0) {
    const fetched = await fetchLinkCard(bookmark.tweetId, link, options.fetchImpl)
    card = fetched.card
    url = fetched.url
  }

  if (card) await saveLinkCard(bookmark.id, card)
  return { card, url }
}
