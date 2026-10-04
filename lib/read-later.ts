/**
 * Read Later: bookmarks the user set aside to read. Separate from categories —
 * a bookmark is on the list while `Bookmark.readLaterAt` is set, and can be
 * filed in one of the user's own folders (`readLaterFolderId`, null = Unsorted).
 */
import prisma from '@/lib/db'
import { READ_LATER_FOLDER_NAME_MAX, type ReadLaterFolder, type ReadLaterFolders, type ReadLaterState } from '@/lib/types'

/** Prisma `where` fragment: bookmarks on the Read Later list */
export const READ_LATER_WHERE = { readLaterAt: { not: null } }

/** Read Later order: most recently added first ('desc') or first added first ('asc') */
export function readLaterOrderBy(dir: 'asc' | 'desc') {
  return [{ readLaterAt: dir }, { tweetCreatedAt: dir }, { importedAt: dir }]
}

/** A folder problem the user can fix (bad or taken name, unknown folder) — `status` is the HTTP status */
export class ReadLaterFolderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const STATE_SELECT = { id: true, tweetId: true, readLaterAt: true, readLaterFolderId: true } as const

function toState(b: { id: string; tweetId: string; readLaterAt: Date | null; readLaterFolderId: string | null }): ReadLaterState {
  return {
    id: b.id,
    tweetId: b.tweetId,
    readLaterAt: b.readLaterAt?.toISOString() ?? null,
    readLaterFolderId: b.readLaterFolderId,
  }
}

function findBookmark(idOrTweetId: string) {
  return prisma.bookmark.findFirst({
    where: { OR: [{ id: idOrTweetId }, { tweetId: idOrTweetId }] },
    select: STATE_SELECT,
  })
}

/**
 * Put a bookmark (by id or tweetId) on the Read Later list or take it off.
 * Adding one that is already there keeps when it was first added and its
 * folder; taking it off also takes it out of its folder.
 * Returns null when there is no such bookmark.
 */
export async function setReadLater(idOrTweetId: string, onList: boolean): Promise<ReadLaterState | null> {
  const bookmark = await findBookmark(idOrTweetId)
  if (!bookmark) return null

  if (onList && !bookmark.readLaterAt) {
    return toState(await prisma.bookmark.update({ where: { id: bookmark.id }, data: { readLaterAt: new Date() }, select: STATE_SELECT }))
  }
  if (!onList && (bookmark.readLaterAt || bookmark.readLaterFolderId)) {
    return toState(await prisma.bookmark.update({
      where: { id: bookmark.id },
      data: { readLaterAt: null, readLaterFolderId: null },
      select: STATE_SELECT,
    }))
  }
  return toState(bookmark)
}

/**
 * File a bookmark (by id or tweetId) in a Read Later folder, or in Unsorted
 * with `folderId` null. Puts it on the list first if it isn't on it.
 * Returns null when there is no such bookmark; throws ReadLaterFolderError
 * for an unknown folder.
 */
export async function fileReadLater(idOrTweetId: string, folderId: string | null): Promise<ReadLaterState | null> {
  const bookmark = await findBookmark(idOrTweetId)
  if (!bookmark) return null
  if (folderId && !(await prisma.readLaterFolder.findUnique({ where: { id: folderId }, select: { id: true } }))) {
    throw new ReadLaterFolderError('Folder not found', 404)
  }
  return toState(await prisma.bookmark.update({
    where: { id: bookmark.id },
    data: { readLaterAt: bookmark.readLaterAt ?? new Date(), readLaterFolderId: folderId },
    select: STATE_SELECT,
  }))
}

// ── Folders ──────────────────────────────────────────────────────────────────

/** Trimmed, single-spaced folder name; throws ReadLaterFolderError when empty or too long */
export function normalizeFolderName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw new ReadLaterFolderError('Folder name is required', 400)
  if (clean.length > READ_LATER_FOLDER_NAME_MAX) {
    throw new ReadLaterFolderError(`Folder name is too long (max ${READ_LATER_FOLDER_NAME_MAX} characters)`, 400)
  }
  return clean
}

/** Folder names are unique regardless of case */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const folders = await prisma.readLaterFolder.findMany({ select: { id: true, name: true } })
  const lower = name.toLowerCase()
  const taken = folders.find((f) => f.id !== exceptId && f.name.toLowerCase() === lower)
  if (taken) throw new ReadLaterFolderError(`There's already a folder named "${taken.name}"`, 409)
}

/** Every folder in the order they were made, with how many bookmarks each holds */
export async function listReadLaterFolders(): Promise<ReadLaterFolders> {
  const [folders, groups] = await Promise.all([
    prisma.readLaterFolder.findMany({ orderBy: [{ createdAt: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    prisma.bookmark.groupBy({ by: ['readLaterFolderId'], where: READ_LATER_WHERE, _count: true }),
  ])
  const counts = new Map(groups.map((g) => [g.readLaterFolderId, g._count]))
  return {
    total: groups.reduce((sum, g) => sum + g._count, 0),
    unsorted: counts.get(null) ?? 0,
    folders: folders.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 })),
  }
}

/** A folder by id, or by name ignoring case */
export async function findReadLaterFolder(idOrName: string): Promise<{ id: string; name: string } | null> {
  const folders = await prisma.readLaterFolder.findMany({ select: { id: true, name: true } })
  const lower = idOrName.trim().toLowerCase()
  return folders.find((f) => f.id === idOrName) ?? folders.find((f) => f.name.toLowerCase() === lower) ?? null
}

export async function createReadLaterFolder(name: unknown): Promise<ReadLaterFolder> {
  const clean = normalizeFolderName(name)
  await assertNameFree(clean)
  const folder = await prisma.readLaterFolder.create({ data: { name: clean }, select: { id: true, name: true } })
  return { ...folder, count: 0 }
}

export async function renameReadLaterFolder(id: string, name: unknown): Promise<ReadLaterFolder> {
  const clean = normalizeFolderName(name)
  if (!(await prisma.readLaterFolder.findUnique({ where: { id }, select: { id: true } }))) {
    throw new ReadLaterFolderError('Folder not found', 404)
  }
  await assertNameFree(clean, id)
  const [folder, count] = await Promise.all([
    prisma.readLaterFolder.update({ where: { id }, data: { name: clean }, select: { id: true, name: true } }),
    prisma.bookmark.count({ where: { ...READ_LATER_WHERE, readLaterFolderId: id } }),
  ])
  return { ...folder, count }
}

/** Delete a folder; its bookmarks stay on the Read Later list, Unsorted. Returns how many were in it */
export async function deleteReadLaterFolder(id: string): Promise<number> {
  if (!(await prisma.readLaterFolder.findUnique({ where: { id }, select: { id: true } }))) {
    throw new ReadLaterFolderError('Folder not found', 404)
  }
  const [moved] = await prisma.$transaction([
    prisma.bookmark.updateMany({ where: { readLaterFolderId: id }, data: { readLaterFolderId: null } }),
    prisma.readLaterFolder.delete({ where: { id } }),
  ])
  return moved.count
}
