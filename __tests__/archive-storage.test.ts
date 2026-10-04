import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  archiveFolderName,
  downloadToFile,
  getArchiveRoot,
  mediaIdentity,
  originalImageUrl,
  resolveArchivePath,
} from '@/lib/archive-storage'

describe('getArchiveRoot', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('lives next to the SQLite database', () => {
    vi.stubEnv('SIFTLY_ARCHIVE_DIR', '')
    vi.stubEnv('DATABASE_URL', 'file:/data/siftly.db')
    expect(getArchiveRoot()).toBe(path.resolve('/data/archive'))
    vi.stubEnv('DATABASE_URL', 'file:./prisma/dev.db')
    expect(getArchiveRoot()).toBe(path.resolve(process.cwd(), 'prisma/archive'))
  })

  it('honours SIFTLY_ARCHIVE_DIR', () => {
    vi.stubEnv('SIFTLY_ARCHIVE_DIR', '/mnt/backup/x')
    expect(getArchiveRoot()).toBe(path.resolve('/mnt/backup/x'))
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
