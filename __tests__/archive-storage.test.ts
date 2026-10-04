import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import path from 'path'
import {
  archiveFolderName,
  detectCloudFolders,
  downloadToFile,
  getDefaultArchiveRoot,
  isSameOrInside,
  mediaIdentity,
  moveArchiveContents,
  normalizeArchiveDir,
  originalImageUrl,
  resolveArchivePath,
} from '@/lib/archive-storage'

describe('getDefaultArchiveRoot', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('lives next to the SQLite database', () => {
    vi.stubEnv('SIFTLY_ARCHIVE_DIR', '')
    vi.stubEnv('DATABASE_URL', 'file:/data/siftly.db')
    expect(getDefaultArchiveRoot()).toBe(path.resolve('/data/archive'))
    vi.stubEnv('DATABASE_URL', 'file:./prisma/dev.db')
    expect(getDefaultArchiveRoot()).toBe(path.resolve(process.cwd(), 'prisma/archive'))
  })

  it('honours SIFTLY_ARCHIVE_DIR', () => {
    vi.stubEnv('SIFTLY_ARCHIVE_DIR', '/mnt/backup/x')
    expect(getDefaultArchiveRoot()).toBe(path.resolve('/mnt/backup/x'))
  })
})

describe('normalizeArchiveDir', () => {
  it('accepts absolute paths, strips quotes and expands ~', () => {
    expect(normalizeArchiveDir('  /Users/me/Google Drive/My Drive/Siftly  ')).toBe(path.resolve('/Users/me/Google Drive/My Drive/Siftly'))
    expect(normalizeArchiveDir('"/Users/me/Dropbox/Siftly"')).toBe(path.resolve('/Users/me/Dropbox/Siftly'))
    expect(normalizeArchiveDir('~/Dropbox/Siftly')).toBe(path.join(homedir(), 'Dropbox/Siftly'))
    expect(normalizeArchiveDir('/a/b/../c')).toBe(path.resolve('/a/c'))
  })

  it('rejects relative paths, the filesystem root and junk', () => {
    for (const bad of ['', '   ', 'archive', './archive', '/', 'a\0b']) {
      expect(normalizeArchiveDir(bad)).toBeNull()
    }
  })
})

describe('isSameOrInside', () => {
  it('detects nesting without matching sibling prefixes', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true)
    expect(isSameOrInside('/a/b', '/a/b/c')).toBe(true)
    expect(isSameOrInside('/a/b', '/a/bc')).toBe(false)
    expect(isSameOrInside('/a/b/c', '/a/b')).toBe(false)
  })
})

describe('moveArchiveContents', () => {
  let tmp: string
  beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'siftly-move-')) })
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

  it('moves every tweet folder and merges with what is already there', async () => {
    const from = path.join(tmp, 'old')
    const to = path.join(tmp, 'cloud', 'Siftly')
    await mkdir(path.join(from, '111', 'media'), { recursive: true })
    await writeFile(path.join(from, '111', 'archive.json'), 'old-111')
    await writeFile(path.join(from, '111', 'media', 'photo-a.jpg'), 'A')
    await mkdir(path.join(from, '222'), { recursive: true })
    await writeFile(path.join(from, '222', 'archive.json'), 'old-222')
    await writeFile(path.join(from, '222', 'media.part'), 'half')
    // The destination already has its own copy of 222
    await mkdir(path.join(to, '222'), { recursive: true })
    await writeFile(path.join(to, '222', 'archive.json'), 'new-222')

    const result = await moveArchiveContents(from, to)

    expect(result).toEqual({ moved: 2, skipped: 1 })
    expect(await readFile(path.join(to, '111', 'media', 'photo-a.jpg'), 'utf8')).toBe('A')
    expect(await readFile(path.join(to, '222', 'archive.json'), 'utf8')).toBe('new-222') // never overwritten
    expect(await readdir(from)).toEqual(['222']) // only the conflicting file stays behind
    expect(await readdir(path.join(from, '222'))).toEqual(['archive.json', 'media.part'])
  })

  it('is a no-op when the old folder does not exist', async () => {
    expect(await moveArchiveContents(path.join(tmp, 'missing'), path.join(tmp, 'dest'))).toEqual({ moved: 0, skipped: 0 })
  })
})

describe('detectCloudFolders', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'siftly-home-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('finds Google Drive, iCloud and Dropbox folders that exist', async () => {
    await mkdir(path.join(home, 'Library/CloudStorage/GoogleDrive-me@example.com/My Drive'), { recursive: true })
    await mkdir(path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs'), { recursive: true })
    await mkdir(path.join(home, 'Dropbox'))
    await mkdir(path.join(home, 'Google Drive/My Drive'), { recursive: true })

    const found = await detectCloudFolders(home)
    expect(found).toEqual(expect.arrayContaining([
      { label: 'Google Drive (me@example.com)', path: path.join(home, 'Library/CloudStorage/GoogleDrive-me@example.com/My Drive') },
      { label: 'iCloud Drive', path: path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs') },
      { label: 'Dropbox', path: path.join(home, 'Dropbox') },
      { label: 'Google Drive', path: path.join(home, 'Google Drive/My Drive') },
    ]))
    // ~/Google Drive itself isn't offered separately from its My Drive folder
    expect(found.map((f) => f.path)).not.toContain(path.join(home, 'Google Drive'))
    expect(found.map((f) => f.path)).not.toContain(path.join(home, 'OneDrive'))
  })
})

describe('resolveArchivePath', () => {
  const root = path.resolve('/srv/archive')

  it('resolves paths inside the root', () => {
    expect(resolveArchivePath(root, '123/media/a.jpg')).toBe(path.join(root, '123/media/a.jpg'))
  })

  it('rejects traversal and odd segments', () => {
    for (const bad of ['../etc/passwd', '123/../../x', '..', '', 'a\\..\\b', 'a/\0/b', './x']) {
      expect(resolveArchivePath(root, bad)).toBeNull()
    }
  })
})

describe('archiveFolderName', () => {
  it('uses numeric tweet IDs as-is and sanitizes anything else', () => {
    expect(archiveFolderName('1900000000000000001')).toBe('1900000000000000001')
    const odd = archiveFolderName('../weird id')
    expect(odd).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(odd).not.toBe(archiveFolderName('../weird-id'))
  })
})

describe('media URL helpers', () => {
  it('requests original-resolution images', () => {
    expect(originalImageUrl('https://pbs.twimg.com/media/ABC.jpg')).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=orig')
    expect(originalImageUrl('https://pbs.twimg.com/media/ABC?format=png&name=small')).toBe('https://pbs.twimg.com/media/ABC?format=png&name=orig')
    expect(originalImageUrl('https://pbs.twimg.com/media/ABC.jpg:large')).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=orig')
    expect(originalImageUrl('https://pbs.twimg.com/card_img/1/x?format=jpg')).toBe('https://pbs.twimg.com/card_img/1/x?format=jpg')
  })

  it('gives a video and its poster the same identity', () => {
    expect(mediaIdentity('https://video.twimg.com/ext_tw_video/444/pu/vid/1280x720/b.mp4')).toBe('video:444')
    expect(mediaIdentity('https://pbs.twimg.com/ext_tw_video_thumb/444/pu/img/thumb.jpg')).toBe('video:444')
    expect(mediaIdentity('https://video.twimg.com/tweet_video/GIFKEY.mp4')).toBe(mediaIdentity('https://pbs.twimg.com/tweet_video_thumb/GIFKEY.jpg'))
    expect(mediaIdentity('https://pbs.twimg.com/media/ABC.jpg')).toBe(mediaIdentity('https://pbs.twimg.com/media/ABC?format=jpg&name=orig'))
  })
})

describe('downloadToFile', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'siftly-dl-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const respond = (body: string | null, init: ResponseInit) => vi.fn(async () => new Response(body, init))

  it('streams to disk with an extension from the content type', async () => {
    const fetchImpl = respond('PNGDATA', { headers: { 'content-type': 'image/png' } })
    const result = await downloadToFile('https://pbs.twimg.com/media/A?format=jpg', path.join(dir, 'photo-1'), { fetchImpl, expect: 'image' })
    expect(result).toEqual({ ok: true, file: path.join(dir, 'photo-1.png'), bytes: 7 })
    expect(await readFile(path.join(dir, 'photo-1.png'), 'utf8')).toBe('PNGDATA')
  })

  it('refuses hosts outside X media CDNs without fetching', async () => {
    const fetchImpl = respond('x', {})
    expect(await downloadToFile('https://evil.example/a.jpg', path.join(dir, 'a'), { fetchImpl, expect: 'image' })).toEqual({
      ok: false,
      error: 'host not allowed (evil.example)',
    })
    expect(await downloadToFile('http://pbs.twimg.com/a.jpg', path.join(dir, 'a'), { fetchImpl, expect: 'image' })).toMatchObject({ ok: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('follows redirects only within the allowlist', async () => {
    const hops = vi.fn(async (input: string) =>
      input.includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://video.twimg.com/final.mp4' } })
        : new Response('MP4', { headers: { 'content-type': 'video/mp4' } }),
    )
    const ok = await downloadToFile('https://video.twimg.com/start', path.join(dir, 'v'), { fetchImpl: hops, expect: 'video' })
    expect(ok).toEqual({ ok: true, file: path.join(dir, 'v.mp4'), bytes: 3 })
    expect(hops.mock.calls.map((c) => c[0])).toEqual(['https://video.twimg.com/start', 'https://video.twimg.com/final.mp4'])

    const sneaky = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } }))
    const blocked = await downloadToFile('https://pbs.twimg.com/a.jpg', path.join(dir, 'a'), { fetchImpl: sneaky, expect: 'image' })
    expect(blocked).toEqual({ ok: false, error: "redirected to a host that isn't allowed (169.254.169.254)" })
    expect(sneaky).toHaveBeenCalledTimes(1)
  })

  it('rejects error pages, HTTP errors and oversized files without leaving files behind', async () => {
    const html = await downloadToFile('https://pbs.twimg.com/a.jpg', path.join(dir, 'a'), {
      fetchImpl: respond('<html>', { headers: { 'content-type': 'text/html' } }),
      expect: 'image',
    })
    expect(html).toEqual({ ok: false, error: 'unexpected content type text/html' })

    const missing = await downloadToFile('https://pbs.twimg.com/a.jpg', path.join(dir, 'a'), {
      fetchImpl: respond(null, { status: 404 }),
      expect: 'image',
    })
    expect(missing).toEqual({ ok: false, error: 'HTTP 404' })

    const big = await downloadToFile('https://video.twimg.com/a.mp4', path.join(dir, 'v'), {
      fetchImpl: respond('0123456789', { headers: { 'content-type': 'video/mp4' } }),
      expect: 'video',
      maxBytes: 5,
    })
    expect(big).toEqual({ ok: false, error: 'file too large' })
    expect(await readdir(dir)).toEqual([])
  })
})
