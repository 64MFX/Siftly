import { existsSync } from 'fs'
import { NextRequest, NextResponse } from 'next/server'
import {
  getArchiveJobState,
  getArchiveStats,
  isArchiveBusy,
  startArchiveJob,
  stopArchiveJob,
  type ArchiveMode,
} from '@/lib/archiver'
import { ArchiveLocationError, getArchiveLocation, isArchiveRelocating, setArchiveDir } from '@/lib/archive-location'
import { directorySize } from '@/lib/archive-storage'
import { getXSessionStatus } from '@/lib/x-session'

/** GET — archive stats, background job progress and the archive folder. `?usage=1` adds disk usage. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const location = await getArchiveLocation()
    const withUsage = request.nextUrl.searchParams.get('usage') === '1'
    const [stats, xSession, bytes] = await Promise.all([
      getArchiveStats(),
      getXSessionStatus(),
      withUsage ? directorySize(location.dir) : Promise.resolve(null),
    ])
    return NextResponse.json({
      stats,
      job: getArchiveJobState(),
      archiveDir: location.dir,
      defaultArchiveDir: location.defaultDir,
      customArchiveDir: location.custom,
      relocating: isArchiveRelocating(),
      // Inside Docker a folder only reaches the host if it is mounted as a volume
      inDocker: existsSync('/.dockerenv'),
      diskUsageBytes: bytes,
      xAccess: xSession.loggedIn ? 'session' : 'guest',
      xLogin: {
        loggedIn: xSession.loggedIn,
        screenName: xSession.account?.screenName ?? null,
        rejectedAt: xSession.rejectedAt,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load archive status: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** POST — start archiving in the background. Body: { mode?: 'pending' | 'retry' | 'all', bookmarkIds?: string[] } */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { mode?: string; bookmarkIds?: unknown } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const mode: ArchiveMode = body.mode === 'retry' || body.mode === 'all' ? body.mode : 'pending'
  const bookmarkIds = Array.isArray(body.bookmarkIds)
    ? body.bookmarkIds.filter((id): id is string => typeof id === 'string')
    : undefined

  if (!startArchiveJob({ mode, bookmarkIds })) {
    const error = isArchiveRelocating() ? 'The archive folder is being moved — try again in a moment' : 'Downloading is already running'
    return NextResponse.json({ error }, { status: 409 })
  }
  return NextResponse.json({ started: true, job: getArchiveJobState() }, { status: 202 })
}

/**
 * PUT — change the archive folder.
 * Body: { archiveDir: string | null, moveFiles?: boolean } — null or "" goes back to the default.
 * With moveFiles (default true) the files already saved are moved to the new folder.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: { archiveDir?: unknown; moveFiles?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (body.archiveDir !== null && typeof body.archiveDir !== 'string') {
    return NextResponse.json({ error: 'archiveDir must be a folder path or null' }, { status: 400 })
  }
  if (isArchiveBusy()) {
    return NextResponse.json({ error: 'Wait for the current download to finish (or stop it) before changing the folder' }, { status: 409 })
  }

  try {
    const result = await setArchiveDir(body.archiveDir, { moveFiles: body.moveFiles !== false })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ArchiveLocationError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[archive] Changing the archive folder failed:', err)
    return NextResponse.json(
      { error: `Changing the archive folder failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** DELETE — stop the running job after the bookmarks currently in progress */
export async function DELETE(): Promise<NextResponse> {
  if (!stopArchiveJob()) {
    return NextResponse.json({ error: 'Downloading is not running' }, { status: 409 })
  }
  return NextResponse.json({ stopping: true })
}
