import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import prisma from '@/lib/db'
import { resolveLocalFile } from '@/lib/media-archive'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
}

/** Serves the archived copy (with Range support), or null if none exists. */
async function serveLocal(mediaUrl: string, rangeHeader: string | null, isDownload: boolean): Promise<NextResponse | null> {
  const item = await prisma.mediaItem.findFirst({
    where: { OR: [{ url: mediaUrl }, { thumbnailUrl: mediaUrl }], localPath: { not: null } },
    select: { localPath: true },
  })
  const file = item?.localPath ? resolveLocalFile(item.localPath) : null
  if (!file) return null

  const size = (await fs.promises.stat(file)).size
  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
  }
  if (isDownload) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`

  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    const start = Math.max(m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10), 0)
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(end - start + 1)
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream
    return new NextResponse(stream, { status: 206, headers })
  }
  headers['Content-Length'] = String(size)
  return new NextResponse(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers })
}

const ALLOWED_HOSTS = new Set([
  'pbs.twimg.com',
  'video.twimg.com',
  'ton.twimg.com',
  'abs.twimg.com',
  'unavatar.io',
])

function isAllowedUrl(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr)
    return protocol === 'https:' && ALLOWED_HOSTS.has(hostname)
  } catch {
    return false
  }
}

function getFilename(urlStr: string, contentType: string): string {
  try {
    const pathname = new URL(urlStr).pathname
    const last = pathname.split('/').pop()?.split('?')[0] ?? ''
    if (last.includes('.')) return last
  } catch { /* ignore */ }
  if (contentType.includes('mp4')) return 'video.mp4'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'photo.jpg'
  if (contentType.includes('png')) return 'photo.png'
  if (contentType.includes('gif')) return 'animation.gif'
  if (contentType.includes('webp')) return 'photo.webp'
  return 'media.bin'
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const mediaUrl = searchParams.get('url')
  const isDownload = searchParams.get('download') === '1'

  if (!mediaUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  if (!isAllowedUrl(mediaUrl)) {
    return NextResponse.json({ error: 'URL not allowed' }, { status: 403 })
  }

  try {
    const local = await serveLocal(mediaUrl, request.headers.get('range'), isDownload)
    if (local) return local
  } catch (err) {
    console.error('Local media lookup failed, falling back to upstream:', err)
  }

  try {
    // Forward Range header so video seeking / partial content works correctly
    const rangeHeader = request.headers.get('range')

    const upstream = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://twitter.com/',
        'Origin': 'https://twitter.com',
        'Accept': '*/*',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    })

    // 206 Partial Content is success for range requests
    if (!upstream.ok) {
      return new NextResponse(null, { status: upstream.status })
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }

    // Forward range-related headers so browser can seek into videos
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) responseHeaders['Content-Range'] = contentRange
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) responseHeaders['Content-Length'] = contentLength

    if (isDownload) {
      const filename = getFilename(mediaUrl, contentType)
      responseHeaders['Content-Disposition'] = `attachment; filename="${filename}"`
    }

    // Preserve upstream status (200 or 206) — critical for video range requests
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (err) {
    console.error('Media proxy error:', err)
    return NextResponse.json({ error: 'Upstream fetch failed' }, { status: 502 })
  }
}
