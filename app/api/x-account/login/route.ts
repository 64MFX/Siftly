import { NextRequest, NextResponse } from 'next/server'
import { isCrossSiteRequest } from '@/lib/request-guard'
import { cancelXLogin, getXLoginState, isXLoginRunning, startXLogin, XLoginError } from '@/lib/x-login'
import { completeBrowserLogin } from '@/lib/x-session'

/**
 * POST — open a browser window on x.com's login page. Siftly saves the session
 * once you've logged in there; follow progress with GET /api/x-account.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'Cross-site requests are not allowed' }, { status: 403 })
  }
  try {
    const login = await startXLogin({ onLoggedIn: (session) => completeBrowserLogin(session) })
    return NextResponse.json({ login }, { status: 202 })
  } catch (err) {
    if (err instanceof XLoginError) {
      return NextResponse.json({ error: err.message, login: getXLoginState() }, { status: isXLoginRunning() ? 409 : 400 })
    }
    return NextResponse.json(
      { error: `Couldn't open the login window: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** DELETE — close the login window without logging in */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'Cross-site requests are not allowed' }, { status: 403 })
  }
  if (!(await cancelXLogin())) return NextResponse.json({ error: 'No login window is open' }, { status: 409 })
  return NextResponse.json({ login: getXLoginState() })
}
