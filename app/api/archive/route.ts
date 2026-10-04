import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import {
  AUTO_ARCHIVE_SETTING,
  getArchiveJobState,
  getArchiveStats,
  isAutoArchiveEnabled,
  startArchiveJob,
  stopArchiveJob,
  type ArchiveMode,
} from '@/lib/archiver'
import { directorySize, getArchiveRoot } from '@/lib/archive-storage'

/** GET — archive stats, background job progress and settings. `?usage=1` adds disk usage. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const root = getArchiveRoot()
    const withUsage = request.nextUrl.searchParams.get('usage') === '1'
    const [stats, autoArchive, xSession, bytes] = await Promise.all([
      getArchiveStats(),
      isAutoArchiveEnabled(),
      prisma.setting.count({ where: { key: { in: ['x_auth_token', 'x_ct0'] }, value: { not: '' } } }),
      withUsage ? directorySize(root) : Promise.resolve(null),
    ])
    return NextResponse.json({
      stats,
      job: getArchiveJobState(),
      autoArchive,
      archiveDir: root,
      diskUsageBytes: bytes,
      xAccess: xSession === 2 ? 'session' : 'guest',
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
    return NextResponse.json({ error: 'Archiving is already running' }, { status: 409 })
  }
  return NextResponse.json({ started: true, job: getArchiveJobState() }, { status: 202 })
}

/** PUT — update archive settings. Body: { autoArchive: boolean } */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: { autoArchive?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.autoArchive !== 'boolean') {
    return NextResponse.json({ error: 'autoArchive must be a boolean' }, { status: 400 })
  }
  const value = body.autoArchive ? 'true' : 'false'
  await prisma.setting.upsert({
    where: { key: AUTO_ARCHIVE_SETTING },
    update: { value },
    create: { key: AUTO_ARCHIVE_SETTING, value },
  })
  return NextResponse.json({ autoArchive: body.autoArchive })
}

/** DELETE — stop the running job after the bookmarks currently in progress */
export async function DELETE(): Promise<NextResponse> {
  if (!stopArchiveJob()) {
    return NextResponse.json({ error: 'Archiving is not running' }, { status: 409 })
  }
  return NextResponse.json({ stopping: true })
}
