/**
 * Where the local archive lives. Defaults to `archive/` next to the database
 * (or $SIFTLY_ARCHIVE_DIR); a folder picked in Settings — e.g. inside a
 * Google Drive / iCloud / Dropbox folder — is stored in the `archiveDir` setting
 * and wins over both.
 */
import { promises as fs } from 'fs'
import path from 'path'
import prisma from '@/lib/db'
import {
  archiveFolderName,
  ensureWritableDir,
  getDefaultArchiveRoot,
  isSameOrInside,
  moveArchiveContents,
  normalizeArchiveDir,
  type MoveResult,
} from '@/lib/archive-storage'

export const ARCHIVE_DIR_SETTING = 'archiveDir'

export async function getArchiveRoot(): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: ARCHIVE_DIR_SETTING } })
  return (setting?.value && normalizeArchiveDir(setting.value)) || getDefaultArchiveRoot()
}

export async function getArchiveLocation(): Promise<{ dir: string; defaultDir: string; custom: boolean }> {
  const defaultDir = getDefaultArchiveRoot()
  const dir = await getArchiveRoot()
  return { dir, defaultDir, custom: dir !== defaultDir }
}

const store = globalThis as unknown as { siftlyArchiveRelocating?: boolean }

/** True while files are being moved to a new archive folder — archiving waits */
export function isArchiveRelocating(): boolean {
  return store.siftlyArchiveRelocating === true
}

export interface RelocateResult {
  dir: string
  custom: boolean
  /** Present when existing files were moved */
  moved?: MoveResult
  /** Bookmarks whose saved copy isn't in the new folder; they're "not downloaded" again */
  missing: number
}

export class ArchiveLocationError extends Error {}

/**
 * Point the archive at `input` (null/empty = back to the default).
 * With `moveFiles`, everything in the current folder is moved over first.
 * Afterwards any bookmark whose copy isn't in the new folder is reset to
 * "not downloaded", so the dashboard's Download button fetches it again.
 */
export async function setArchiveDir(input: string | null, options: { moveFiles: boolean }): Promise<RelocateResult> {
  const defaultDir = getDefaultArchiveRoot()
  let target = defaultDir
  if (input && input.trim()) {
    const normalized = normalizeArchiveDir(input)
    if (!normalized) throw new ArchiveLocationError('Enter a full folder path, like /Users/you/Google Drive/Siftly Archive or C:\\Users\\you\\Dropbox\\Siftly')
    target = normalized
  }

  if (isArchiveRelocating()) throw new ArchiveLocationError('The archive folder is already being changed')
  store.siftlyArchiveRelocating = true
  try {
    const current = await getArchiveRoot()
    if (path.resolve(target) !== path.resolve(current) && options.moveFiles) {
      if (isSameOrInside(current, target) || isSameOrInside(target, current)) {
        throw new ArchiveLocationError('To move your saved files, pick a folder that is not inside (or around) the current archive folder')
      }
    }
    try {
      await ensureWritableDir(target)
    } catch (err) {
      throw new ArchiveLocationError(`Can't use that folder: ${err instanceof Error ? err.message : String(err)}`)
    }

    let moved: MoveResult | undefined
    if (path.resolve(target) !== path.resolve(current) && options.moveFiles) {
      moved = await moveArchiveContents(current, target)
      await fs.rmdir(current).catch(() => {}) // remove the old folder only if it's now empty
    }

    if (target === defaultDir) {
      await prisma.setting.deleteMany({ where: { key: ARCHIVE_DIR_SETTING } })
    } else {
      await prisma.setting.upsert({
        where: { key: ARCHIVE_DIR_SETTING },
        update: { value: target },
        create: { key: ARCHIVE_DIR_SETTING, value: target },
      })
    }

    const missing = await resetMissingArchives(target)
    return { dir: target, custom: target !== defaultDir, moved, missing }
  } finally {
    store.siftlyArchiveRelocating = false
  }
}

/**
 * Mark bookmarks whose archive folder isn't under `root` as not downloaded and
 * drop their local media paths. Returns how many were reset.
 */
export async function resetMissingArchives(root: string): Promise<number> {
  const archived = await prisma.bookmark.findMany({
    where: { archivedAt: { not: null } },
    select: { id: true, tweetId: true },
  })
  const missing: string[] = []
  for (const b of archived) {
    const exists = await fs
      .access(path.join(root, archiveFolderName(b.tweetId), 'archive.json'))
      .then(() => true, () => false)
    if (!exists) missing.push(b.id)
  }
  for (let i = 0; i < missing.length; i += 500) {
    const ids = missing.slice(i, i + 500)
    await prisma.$transaction([
      prisma.bookmark.updateMany({
        where: { id: { in: ids } },
        data: { archivedAt: null, archiveStatus: null, archiveError: null },
      }),
      prisma.mediaItem.updateMany({
        where: { bookmarkId: { in: ids } },
        data: { localPath: null, localThumbnailPath: null },
      }),
    ])
  }
  return missing.length
}
