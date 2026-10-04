import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { NextRequest, NextResponse } from 'next/server'
import { getArchiveRoot } from '@/lib/archive-location'
import { contentTypeForPath, resolveArchivePath } from '@/lib/archive-storage'

// Archived pages are static: no scripts, and nothing may load from outside the archive
const HTML_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // suffix range: last N bytes
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start <= end && start < size ? { start, end } : null
}

/** GET — serve a file from the local archive (with Range support for video seeking) */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await params
  const filePath = resolveArchivePath(await getArchiveRoot(), segments.join('/'))
  if (!filePath || filePath.endsWith('.part') || filePath.endsWith('.tmp')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const contentType = contentTypeForPath(filePath)
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Last-Modified': stat.mtime.toUTCString(),
  }
  if (contentType.startsWith('text/html')) headers['Content-Security-Policy'] = HTML_CSP
  if (request.nextUrl.searchParams.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${segments[segments.length - 1].replace(/["\\\r\n]/g, '_')}"`
  }

  const rangeHeader = request.headers.get('range')
  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size)
    if (!range) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } })
    }
    const stream = createReadStream(filePath, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    })
  }

  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(stat.size) },
  })
}
