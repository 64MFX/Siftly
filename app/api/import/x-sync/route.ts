import { NextRequest, NextResponse } from 'next/server'
import { isCrossSiteRequest, isLocalRequest } from '@/lib/request-guard'
import { getXSyncStatus, startXSyncJob, stopXSyncJob, type XSyncMode } from '@/lib/x-bookmark-sync'
import { browserLoginAvailability, getXLoginState } from '@/lib/x-login'
import { getXSessionStatus } from '@/lib/x-session'

const forbidden = () => NextResponse.json({ error: 'Cross-site requests are not allowed' }, { status: 403 })

/** GET — the X login, the running sync's progress, and how the last sync went */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const [sync, session] = await Promise.all([getXSyncStatus(), getXSessionStatus()])
    return NextResponse.json({
      ...sync,
      xLogin: {
        loggedIn: session.loggedIn,
        screenName: session.account?.screenName ?? null,
        rejectedAt: session.rejectedAt,
      },
      // "Log in to X" from the Import page: the window's progress and whether it can open here
      login: getXLoginState(),
      browserLogin: browserLoginAvailability(),
      remoteClient: !isLocalRequest(request),
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load the sync status: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/**
 * POST — start syncing bookmarks from X in the background; follow it with GET.
 * Body: { mode?: 'auto' | 'new' | 'all' } — auto (default) reads the whole
 * list the first time, then only down to the bookmarks Siftly already has.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) return forbidden()
  let body: { mode?: unknown } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const mode: XSyncMode = body.mode === 'new' || body.mode === 'all' ? body.mode : 'auto'

  const session = await getXSessionStatus()
  if (!session.loggedIn) {
    return NextResponse.json({ error: 'Log in to X first, so Siftly can read your bookmarks.' }, { status: 400 })
  }
  const run = startXSyncJob({ mode })
  if (!run) return NextResponse.json({ error: 'A sync is already running' }, { status: 409 })
  return NextResponse.json({ started: true, ...(await getXSyncStatus()) }, { status: 202 })
}

/** DELETE — stop the running sync after the page it is reading */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) return forbidden()
  if (!stopXSyncJob()) return NextResponse.json({ error: 'No sync is running' }, { status: 409 })
  return NextResponse.json({ stopping: true })
}
