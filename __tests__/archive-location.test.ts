import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// Minimal in-memory stand-in for the Prisma calls archive-location makes
const db = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  bookmarks: [] as { id: string; tweetId: string; archivedAt: Date | null; archiveStatus: string | null; archiveError: string | null }[],
  media: [] as { bookmarkId: string; localPath: string | null; localThumbnailPath: string | null }[],
}))

vi.mock('@/lib/db', () => {
  const prisma = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        db.settings.has(where.key) ? { key: where.key, value: db.settings.get(where.key)! } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        db.settings.set(where.key, update.value)
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        db.settings.delete(where.key)
      },
    },
    bookmark: {
      findMany: async () => db.bookmarks.filter((b) => b.archivedAt !== null).map(({ id, tweetId }) => ({ id, tweetId })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: object }) => {
        for (const b of db.bookmarks) if (where.id.in.includes(b.id)) Object.assign(b, data)
      },
    },
    mediaItem: {
      updateMany: async ({ where, data }: { where: { bookmarkId: { in: string[] } }; data: object }) => {
        for (const m of db.media) if (where.bookmarkId.in.includes(m.bookmarkId)) Object.assign(m, data)
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  }
  return { default: prisma, prisma }
})

const { getArchiveLocation, getArchiveRoot, setArchiveDir, ArchiveLocationError } = await import('@/lib/archive-location')

describe('archive location', () => {
  let tmp: string
  let defaultRoot: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'siftly-loc-'))
    defaultRoot = path.join(tmp, 'default')
    vi.stubEnv('SIFTLY_ARCHIVE_DIR', defaultRoot)
    db.settings.clear()
    db.bookmarks = [
      { id: 'b1', tweetId: '111', archivedAt: new Date(), archiveStatus: 'complete', archiveError: null },
      { id: 'b2', tweetId: '222', archivedAt: new Date(), archiveStatus: 'partial', archiveError: 'video missing' },
      { id: 'b3', tweetId: '333', archivedAt: null, archiveStatus: null, archiveError: null },
    ]
    db.media = [
      { bookmarkId: 'b1', localPath: '111/media/photo-a.jpg', localThumbnailPath: null },
      { bookmarkId: 'b2', localPath: '222/media/video-b.mp4', localThumbnailPath: '222/media/thumb-b.jpg' },
    ]
    for (const id of ['111', '222']) {
      await mkdir(path.join(defaultRoot, id, 'media'), { recursive: true })
      await writeFile(path.join(defaultRoot, id, 'archive.json'), `{"tweetId":"${id}"}`)
    }
    await writeFile(path.join(defaultRoot, '111', 'media', 'photo-a.jpg'), 'A')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(tmp, { recursive: true, force: true })
  })

  it('uses the default folder until one is chosen', async () => {
    expect(await getArchiveLocation()).toEqual({ dir: defaultRoot, defaultDir: defaultRoot, custom: false })
  })

  it('moves saved files into a chosen cloud folder and keeps every bookmark downloaded', async () => {
    const cloud = path.join(tmp, 'Google Drive', 'My Drive', 'Siftly Archive')
    const result = await setArchiveDir(cloud, { moveFiles: true })

    expect(result).toEqual({ dir: cloud, custom: true, moved: { moved: 3, skipped: 0 }, missing: 0 })
    expect(await getArchiveRoot()).toBe(cloud)
    expect(await readFile(path.join(cloud, '111', 'media', 'photo-a.jpg'), 'utf8')).toBe('A')
    await expect(stat(defaultRoot)).rejects.toThrow() // emptied and removed
    expect(db.bookmarks.map((b) => b.archiveStatus)).toEqual(['complete', 'partial', null])
    expect(db.media[0].localPath).toBe('111/media/photo-a.jpg')
  })

  it('without moving, bookmarks whose copy is not in the new folder become "not downloaded"', async () => {
    const cloud = path.join(tmp, 'Dropbox', 'Siftly')
    // Pretend the user already copied 111 over by hand
    await mkdir(path.join(cloud, '111'), { recursive: true })
    await writeFile(path.join(cloud, '111', 'archive.json'), '{}')

    const result = await setArchiveDir(cloud, { moveFiles: false })

    expect(result).toEqual({ dir: cloud, custom: true, moved: undefined, missing: 1 })
    expect(db.bookmarks.find((b) => b.id === 'b1')).toMatchObject({ archiveStatus: 'complete' })
    expect(db.bookmarks.find((b) => b.id === 'b2')).toMatchObject({ archivedAt: null, archiveStatus: null, archiveError: null })
    expect(db.media[1]).toMatchObject({ localPath: null, localThumbnailPath: null })
    // The old files are left alone
    expect(await readFile(path.join(defaultRoot, '222', 'archive.json'), 'utf8')).toBe('{"tweetId":"222"}')
  })

  it('can go back to the default folder', async () => {
    const cloud = path.join(tmp, 'iCloud', 'Siftly')
    await setArchiveDir(cloud, { moveFiles: true })
    const result = await setArchiveDir(null, { moveFiles: true })
    expect(result).toMatchObject({ dir: defaultRoot, custom: false, missing: 0 })
    expect(db.settings.size).toBe(0)
    expect(await readFile(path.join(defaultRoot, '111', 'media', 'photo-a.jpg'), 'utf8')).toBe('A')
  })

  it('refuses relative paths and moving into a sub-folder of the archive', async () => {
    await expect(setArchiveDir('Siftly Archive', { moveFiles: true })).rejects.toBeInstanceOf(ArchiveLocationError)
    await expect(setArchiveDir(path.join(defaultRoot, 'nested'), { moveFiles: true })).rejects.toThrow(/not inside/)
    expect(await getArchiveRoot()).toBe(defaultRoot)
  })

  it('refuses a path that is a file', async () => {
    const file = path.join(tmp, 'a-file')
    await writeFile(file, 'x')
    await expect(setArchiveDir(file, { moveFiles: false })).rejects.toThrow(/Can't use that folder/)
  })
})
