import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { isCrossSiteRequest, isLocalRequest } from '@/lib/request-guard'
import { browserLoginAvailability, cancelXLogin, getXLoginState } from '@/lib/x-login'
import { clearXSession, getXSessionStatus, normalizeCookieValue, saveXSession, verifyXSession } from '@/lib/x-session'

const forbidden = () => NextResponse.json({ error: 'Cross-site requests are not allowed' }, { status: 403 })

/** GET — X login status, the "Log in to X" window's progress, and how many archives are incomplete */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const [session, incompleteArchives] = await Promise.all([
      getXSessionStatus(),
      prisma.bookmark.count({ where: { archiveStatus: { in: ['partial', 'failed'] } } }),
    ])
    return NextResponse.json({
      ...session,
      login: getXLoginState(),
      browserLogin: browserLoginAvailability(),
      // The login window opens on the computer running Siftly
      remoteClient: !isLocalRequest(request),
      incompleteArchives,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load X login status: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** PUT — save a session by hand. Body: { authToken, ct0 } (cookie values from x.com) */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) return forbidden()
  let body: { authToken?: unknown; ct0?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const authToken = typeof body.authToken === 'string' ? normalizeCookieValue(body.authToken, 'auth_token') : null
  const ct0 = typeof body.ct0 === 'string' ? normalizeCookieValue(body.ct0, 'ct0') : null
  if (!authToken || !ct0) {
    return NextResponse.json({ error: 'Paste the values of both the auth_token and ct0 cookies' }, { status: 400 })
  }

  const check = await verifyXSession({ authToken, ct0 })
  if (!check.ok && check.rejected) {
    return NextResponse.json(
      { error: "X didn't accept these cookies. Copy them again from a browser where you're logged in to x.com." },
      { status: 400 },
    )
  }
  await saveXSession({ authToken, ct0 }, {
    userId: null,
    screenName: check.ok ? check.screenName : null,
    source: 'manual',
    verified: check.ok,
  })
  return NextResponse.json({
    ...(await getXSessionStatus()),
    warning: check.ok ? null : `Saved, but X couldn't confirm the login right now: ${check.error}`,
  })
}

/** DELETE — log out: forget the saved X session */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) return forbidden()
  await cancelXLogin()
  await clearXSession()
  return NextResponse.json(await getXSessionStatus())
}
