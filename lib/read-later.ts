/**
 * Read Later: bookmarks the user set aside to read. Separate from categories —
 * a bookmark is on the list while `Bookmark.readLaterAt` is set.
 */
import prisma from '@/lib/db'

/** Prisma `where` fragment: bookmarks on the Read Later list */
export const READ_LATER_WHERE = { readLaterAt: { not: null } }

/** Read Later order: most recently added first ('desc') or first added first ('asc') */
export function readLaterOrderBy(dir: 'asc' | 'desc') {
  return [{ readLaterAt: dir }, { tweetCreatedAt: dir }, { importedAt: dir }]
}

export interface ReadLaterState {
  id: string
  tweetId: string
  /** ISO time it was added, null when it is not on the list */
  readLaterAt: string | null
}

/**
 * Put a bookmark (by id or tweetId) on the Read Later list or take it off.
 * Adding one that is already there keeps when it was first added.
 * Returns null when there is no such bookmark.
 */
export async function setReadLater(idOrTweetId: string, onList: boolean): Promise<ReadLaterState | null> {
  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id: idOrTweetId }, { tweetId: idOrTweetId }] },
    select: { id: true, tweetId: true, readLaterAt: true },
  })
  if (!bookmark) return null

  let readLaterAt = bookmark.readLaterAt
  if (onList && !readLaterAt) {
    readLaterAt = new Date()
    await prisma.bookmark.update({ where: { id: bookmark.id }, data: { readLaterAt } })
  } else if (!onList && readLaterAt) {
    readLaterAt = null
    await prisma.bookmark.update({ where: { id: bookmark.id }, data: { readLaterAt: null } })
  }

  return { id: bookmark.id, tweetId: bookmark.tweetId, readLaterAt: readLaterAt?.toISOString() ?? null }
}
