import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import prisma from '@/lib/db'

export const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(process.cwd(), 'data', 'media')

export const ALLOWED_MEDIA_HOSTS = new Set([
  'pbs.twimg.com',
  'video.twimg.com',
  'ton.twimg.com',
  'abs.twimg.com',
  'unavatar.io',
])

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
}

export function isAllowedMediaUrl(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr)
    return protocol === 'https:' && ALLOWED_MEDIA_HOSTS.has(hostname)
  } catch {
    return false
  }
}

export function contentTypeForPath(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** Resolve a stored relative localPath to an absolute path, refusing anything outside MEDIA_DIR. */
export function resolveLocalPath(localPath: string): string | null {
  const abs = path.resolve(MEDIA_DIR, localPath)
  return abs.startsWith(path.resolve(MEDIA_DIR) + path.sep) ? abs : null
}

function extensionFor(url: string, contentType: string): string {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase()
  if (fromUrl in CONTENT_TYPES) return fromUrl
  if (contentType.includes('mp4')) return '.mp4'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('gif')) return '.gif'
  if (contentType.includes('webp')) return '.webp'
  return '.jpg'
}

/** Download one media item to disk and record its localPath. Returns true on success. */
export async function archiveMediaItem(item: { id: string; url: string }): Promise<boolean> {
  if (!isAllowedMediaUrl(item.url)) return false
  const res = await fetch(item.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Referer': 'https://twitter.com/',
      'Accept': '*/*',
    },
  })
  if (!res.ok || !res.body) return false

  const fileName = `${item.id}${extensionFor(item.url, res.headers.get('content-type') ?? '')}`
  await fs.promises.mkdir(MEDIA_DIR, { recursive: true })
  const dest = path.join(MEDIA_DIR, fileName)
  const tmp = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp))
    await fs.promises.rename(tmp, dest)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
  await prisma.mediaItem.update({ where: { id: item.id }, data: { localPath: fileName } })
  return true
}

/** Archive all media not yet saved locally. */
export async function archiveAllMedia(limit = 500): Promise<{ saved: number; failed: number; remaining: number }> {
  const pending = await prisma.mediaItem.findMany({
    where: { localPath: null },
    select: { id: true, url: true },
    take: limit,
  })
  let saved = 0
  let failed = 0
  for (const item of pending) {
    try {
      if (await archiveMediaItem(item)) saved++
      else failed++
    } catch (err) {
      console.error('Media archive error:', item.url, err)
      failed++
    }
  }
  const remaining = await prisma.mediaItem.count({ where: { localPath: null } })
  return { saved, failed, remaining }
}
