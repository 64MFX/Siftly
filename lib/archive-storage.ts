/**
 * Filesystem side of the local archive: where it lives, safe path resolution,
 * and streaming downloads of X media.
 */
import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import type { FetchLike } from '@/lib/x-tweet-fetcher'

/**
 * Archive root: $SIFTLY_ARCHIVE_DIR, otherwise an `archive/` folder next to the
 * SQLite database (prisma/archive locally, /data/archive in Docker) so backups
 * of the data directory include it.
 */
export function getArchiveRoot(): string {
  const override = process.env.SIFTLY_ARCHIVE_DIR?.trim()
  if (override) return path.resolve(override)
  return path.join(path.dirname(databaseFilePath()), 'archive')
}

function databaseFilePath(): string {
  const url = process.env.DATABASE_URL?.trim() ?? ''
  if (url.startsWith('file:')) {
    let file = url.slice('file:'.length).split('?')[0]
    if (file.startsWith('//')) file = file.slice(2)
    if (file) return path.resolve(process.cwd(), file)
  }
  return path.join(process.cwd(), 'prisma', 'dev.db')
}

/** Folder name for a tweet — tweet IDs are numeric, anything else is sanitized */
export function archiveFolderName(tweetId: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(tweetId)) return tweetId
  const slug = tweetId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'tweet'
  return `${slug}-${createHash('sha1').update(tweetId).digest('hex').slice(0, 8)}`
}

/** Resolve a path relative to the archive root, refusing anything that escapes it */
export function resolveArchivePath(root: string, relPath: string): string | null {
  const segments = relPath.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null
  const resolvedRoot = path.resolve(root)
  const full = path.resolve(resolvedRoot, ...segments)
  return full.startsWith(resolvedRoot + path.sep) ? full : null
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

export function contentTypeForPath(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

const EXTENSION_FOR_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

function extensionFor(contentType: string, url: string, fallback: string): string {
  const fromType = EXTENSION_FOR_TYPE[contentType.split(';')[0].trim().toLowerCase()]
  if (fromType) return fromType
  try {
    const u = new URL(url)
    const format = u.searchParams.get('format')
    if (format && CONTENT_TYPES[`.${format.toLowerCase()}`]) return `.${format.toLowerCase()}`
    const ext = path.extname(u.pathname).toLowerCase()
    if (CONTENT_TYPES[ext] && !ext.match(/\.(html|json|md)$/)) return ext === '.jpeg' ? '.jpg' : ext
  } catch { /* fall through */ }
  return fallback
}

// Only X's own CDNs (plus the avatar fallback the UI already uses) — stored
// JSON is user-supplied, so never let it point downloads at arbitrary hosts.
const ALLOWED_MEDIA_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com', 'abs.twimg.com', 'unavatar.io'])

export function isAllowedMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && ALLOWED_MEDIA_HOSTS.has(hostname)
  } catch {
    return false
  }
}

export function isVideoFileUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'video.twimg.com' && !/\.m3u8$/i.test(u.pathname)
  } catch {
    return false
  }
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url)
}

/** Request the original-resolution rendition of pbs.twimg.com/media images */
export function originalImageUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return url
    const m = u.pathname.match(/^\/media\/([^./:]+)(?:\.(\w+))?(?::\w+)?$/)
    if (!m) return url
    const format = u.searchParams.get('format') ?? m[2] ?? 'jpg'
    return `https://pbs.twimg.com/media/${m[1]}?format=${format}&name=orig`
  } catch {
    return url
  }
}

/**
 * Stable identity of a piece of X media regardless of rendition: a video's
 * poster and its MP4 share an identity, as do `?name=small` and `:orig` URLs.
 */
export function mediaIdentity(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const p = u.pathname
    let m = p.match(/^\/media\/([^./:]+)/)
    if (u.hostname === 'pbs.twimg.com' && m) return `media:${m[1]}`
    m = p.match(/^\/(?:ext_tw_video|amplify_video|ext_tw_video_thumb|amplify_video_thumb)\/(\d+)/)
    if (m) return `video:${m[1]}`
    m = p.match(/^\/(?:tweet_video|tweet_video_thumb)\/([^./]+)/)
    if (m) return `gif:${m[1]}`
    return `${u.hostname}${p}`
  } catch {
    return url
  }
}

export function fileKey(kind: string, url: string): string {
  return `${kind}-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`
}

export type DownloadResult =
  | { ok: true; file: string; bytes: number }
  | { ok: false; error: string }

export interface DownloadOptions {
  fetchImpl: FetchLike
  expect: 'image' | 'video'
  timeoutMs?: number
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB per file

/**
 * Stream `url` to `<destBase><ext>` (extension from the response type).
 * Writes to a `.part` file and renames, so a crash never leaves a truncated file.
 */
export async function downloadToFile(url: string, destBase: string, options: DownloadOptions): Promise<DownloadResult> {
  if (!isAllowedMediaUrl(url)) return { ok: false, error: `host not allowed (${safeHost(url)})` }

  const timeoutMs = options.timeoutMs ?? (options.expect === 'video' ? 10 * 60_000 : 60_000)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  // Follow redirects by hand so every hop is checked against the allowlist
  let res: Response
  let current = url
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      res = await options.fetchImpl(current, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer: 'https://x.com/',
          Accept: options.expect === 'video' ? 'video/*,*/*' : 'image/*,*/*',
        },
        redirect: 'manual',
        signal,
      })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) break
      await res.body?.cancel().catch(() => {})
      if (hop >= 5) return { ok: false, error: 'too many redirects' }
      current = new URL(location, current).toString()
      if (!isAllowedMediaUrl(current)) return { ok: false, error: `redirected to a host that isn't allowed (${safeHost(current)})` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, error: `HTTP ${res.status}` }
  }

  const contentType = res.headers.get('content-type') ?? ''
  const major = contentType.split('/')[0].toLowerCase()
  const acceptable =
    major === options.expect ||
    (contentType.startsWith('application/octet-stream') || contentType === '')
  if (!acceptable) {
    await res.body.cancel().catch(() => {})
    return { ok: false, error: `unexpected content type ${contentType}` }
  }

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {})
    return { ok: false, error: `file too large (${Math.round(declared / 1024 / 1024)} MB)` }
  }

  const ext = extensionFor(contentType, current, options.expect === 'video' ? '.mp4' : '.jpg')
  const finalPath = `${destBase}${ext}`
  const partPath = `${finalPath}.part`
  let bytes = 0

  try {
    await fs.mkdir(path.dirname(finalPath), { recursive: true })
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeReadableStream),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length
          if (bytes > maxBytes) throw new Error('file too large')
          yield chunk
        }
      },
      createWriteStream(partPath),
    )
    if (bytes === 0) throw new Error('empty response')
    await fs.rename(partPath, finalPath)
    return { ok: true, file: finalPath, bytes }
  } catch (err) {
    await fs.rm(partPath, { force: true }).catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid URL'
  }
}

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, filePath)
}

/** Total size in bytes of everything under `dir` (0 if it doesn't exist) */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => null))?.size ?? 0
  }
  return total
}
