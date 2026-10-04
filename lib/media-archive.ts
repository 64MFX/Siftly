import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import prisma from '@/lib/db'

export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR ?? path.join(process.cwd(), 'data', 'media'))

const ALLOWED_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com'])
const CONCURRENCY = 4
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export interface ArchiveStatus {
  status: 'idle' | 'running' | 'stopping'
  total: number // items to process in the current run
  processed: number
  saved: number
  failed: number
  bytes: number
  current: string | null
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
}

export interface ArchiveStats {
  totalItems: number
  savedItems: number
  remainingItems: number
  diskBytes: number
}

const g = globalThis as unknown as { __mediaArchive?: ArchiveStatus }
const state: ArchiveStatus = (g.__mediaArchive ??= {
  status: 'idle',
  total: 0,
  processed: 0,
  saved: 0,
  failed: 0,
  bytes: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
})

export function getArchiveStatus(): ArchiveStatus {
  return { ...state }
}

function isAllowedUrl(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr)
    return protocol === 'https:' && ALLOWED_HOSTS.has(hostname)
  } catch {
    return false
  }
}

function extensionFor(urlStr: string, type: string, contentType: string): string {
  const ext = path.extname(new URL(urlStr).pathname).toLowerCase()
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext
  if (contentType.includes('mp4')) return '.mp4'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('gif')) return '.gif'
  if (contentType.includes('webp')) return '.webp'
  return type === 'photo' ? '.jpg' : '.mp4'
}

async function archiveItem(item: { id: string; url: string; type: string }): Promise<number> {
  if (!isAllowedUrl(item.url)) throw new Error('URL host not allowed')
  const res = await fetch(item.url, {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://twitter.com/', Accept: '*/*' },
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const fileName = `${item.id}${extensionFor(item.url, item.type, res.headers.get('content-type') ?? '')}`
  const finalPath = path.join(MEDIA_DIR, fileName)
  const tmpPath = `${finalPath}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmpPath))
    await fs.promises.rename(tmpPath, finalPath)
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true })
    throw err
  }
  await prisma.mediaItem.update({ where: { id: item.id }, data: { localPath: fileName } })
  return (await fs.promises.stat(finalPath)).size
}

/** Starts a background archive run. Returns false if one is already running. */
export function startArchive(): boolean {
  if (state.status !== 'idle') return false
  Object.assign(state, {
    status: 'running',
    total: 0,
    processed: 0,
    saved: 0,
    failed: 0,
    bytes: 0,
    current: null,
    startedAt: Date.now(),
    finishedAt: null,
    lastError: null,
  } satisfies ArchiveStatus)
  void run()
  return true
}

export function stopArchive(): void {
  if (state.status === 'running') state.status = 'stopping'
}

async function run(): Promise<void> {
  try {
    await fs.promises.mkdir(MEDIA_DIR, { recursive: true })
    const items = await prisma.mediaItem.findMany({
      where: { localPath: null },
      select: { id: true, url: true, type: true },
    })
    state.total = items.length

    let next = 0
    const worker = async () => {
      while (state.status === 'running') {
        const item = items[next++]
        if (!item) return
        state.current = item.url
        try {
          state.bytes += await archiveItem(item)
          state.saved++
        } catch (err) {
          state.failed++
          state.lastError = `${item.url}: ${err instanceof Error ? err.message : String(err)}`
        }
        state.processed++
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
  } finally {
    state.status = 'idle'
    state.current = null
    state.finishedAt = Date.now()
  }
}

export async function getArchiveStats(): Promise<ArchiveStats> {
  const [totalItems, savedItems] = await Promise.all([
    prisma.mediaItem.count(),
    prisma.mediaItem.count({ where: { localPath: { not: null } } }),
  ])
  let diskBytes = 0
  try {
    for (const f of await fs.promises.readdir(MEDIA_DIR)) {
      try {
        diskBytes += (await fs.promises.stat(path.join(MEDIA_DIR, f))).size
      } catch { /* ignore */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return { totalItems, savedItems, remainingItems: totalItems - savedItems, diskBytes }
}

/** Resolves a stored localPath to an absolute file inside MEDIA_DIR, or null. */
export function resolveLocalFile(localPath: string): string | null {
  const abs = path.resolve(MEDIA_DIR, localPath)
  return abs.startsWith(MEDIA_DIR + path.sep) && fs.existsSync(abs) ? abs : null
}
