/**
 * The X login Siftly uses to fetch what X only shows to logged-in users —
 * above all the full body of X Articles. It is a normal x.com web session:
 * the `auth_token` + `ct0` cookies, captured by "Log in to X" in Settings
 * (lib/x-login.ts) or pasted in by hand. Stored as Settings rows next to who it
 * belongs to.
 */
import prisma from '@/lib/db'
import type { CapturedXSession } from '@/lib/x-login'
import { isXAuthRejection, sessionHeaders, type FetchLike, type XCredentials } from '@/lib/x-tweet-fetcher'

export const X_AUTH_TOKEN_SETTING = 'x_auth_token'
export const X_CT0_SETTING = 'x_ct0'
export const X_ACCOUNT_SETTING = 'x_account'
export const X_SESSION_REJECTED_SETTING = 'x_session_rejected_at'

export interface XAccountInfo {
  userId: string | null
  screenName: string | null
  /** browser = "Log in to X" window · manual = cookies pasted in Settings */
  source: 'browser' | 'manual'
  loggedInAt: string
  /** X confirmed the login when it was saved */
  verified: boolean
}

export interface XSessionStatus {
  loggedIn: boolean
  account: XAccountInfo | null
  /** When X last refused the saved login (it needs logging in again) */
  rejectedAt: string | null
}

export async function getXCredentials(): Promise<XCredentials | null> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [X_AUTH_TOKEN_SETTING, X_CT0_SETTING] } } })
  const authToken = rows.find((r) => r.key === X_AUTH_TOKEN_SETTING)?.value
  const ct0 = rows.find((r) => r.key === X_CT0_SETTING)?.value
  return authToken && ct0 ? { authToken, ct0 } : null
}

export async function getXSessionStatus(): Promise<XSessionStatus> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [X_AUTH_TOKEN_SETTING, X_CT0_SETTING, X_ACCOUNT_SETTING, X_SESSION_REJECTED_SETTING] } },
  })
  const value = (key: string) => rows.find((r) => r.key === key)?.value || null
  const loggedIn = !!(value(X_AUTH_TOKEN_SETTING) && value(X_CT0_SETTING))
  return {
    loggedIn,
    account: loggedIn ? parseAccount(value(X_ACCOUNT_SETTING)) : null,
    rejectedAt: loggedIn ? value(X_SESSION_REJECTED_SETTING) : null,
  }
}

function parseAccount(json: string | null): XAccountInfo | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<XAccountInfo>
    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      screenName: typeof parsed.screenName === 'string' ? parsed.screenName : null,
      source: parsed.source === 'browser' ? 'browser' : 'manual',
      loggedInAt: typeof parsed.loggedInAt === 'string' ? parsed.loggedInAt : new Date(0).toISOString(),
      verified: parsed.verified === true,
    }
  } catch {
    return null
  }
}

function upsertSetting(key: string, value: string) {
  return prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

export async function saveXSession(
  credentials: XCredentials,
  info: { userId: string | null; screenName: string | null; source: XAccountInfo['source']; verified: boolean },
): Promise<XAccountInfo> {
  const account: XAccountInfo = { ...info, loggedInAt: new Date().toISOString() }
  await prisma.$transaction([
    upsertSetting(X_AUTH_TOKEN_SETTING, credentials.authToken),
    upsertSetting(X_CT0_SETTING, credentials.ct0),
    upsertSetting(X_ACCOUNT_SETTING, JSON.stringify(account)),
    prisma.setting.deleteMany({ where: { key: X_SESSION_REJECTED_SETTING } }),
  ])
  return account
}

/** Save a session captured by the "Log in to X" window (lib/x-login.ts) */
export async function completeBrowserLogin(
  session: CapturedXSession,
  fetchImpl?: FetchLike,
): Promise<{ screenName: string | null; verified: boolean }> {
  const credentials = { authToken: session.authToken, ct0: session.ct0 }
  const check = await verifyXSession(credentials, fetchImpl)
  if (!check.ok && check.rejected) throw new Error(`${check.error}. Try logging in again.`)
  const account = await saveXSession(credentials, {
    userId: userIdFromTwid(session.twid),
    screenName: check.ok ? check.screenName : null,
    source: 'browser',
    verified: check.ok,
  })
  return { screenName: account.screenName, verified: account.verified }
}

/** Forget the login. The session itself stays valid on X until it is ended there. */
export async function clearXSession(): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: { in: [X_AUTH_TOKEN_SETTING, X_CT0_SETTING, X_ACCOUNT_SETTING, X_SESSION_REJECTED_SETTING] } },
  })
}

export async function markXSessionRejected(): Promise<void> {
  try {
    await upsertSetting(X_SESSION_REJECTED_SETTING, new Date().toISOString())
  } catch (err) {
    console.warn('[x-session] Could not record the rejected login:', err instanceof Error ? err.message : err)
  }
}

/**
 * Clean up a pasted cookie value: surrounding whitespace and quotes, and a
 * leading `name=` when the whole cookie was copied. Returns null if what is
 * left can't be a cookie value.
 */
export function normalizeCookieValue(input: string, name: string): string | null {
  let value = input.trim()
  if (value.toLowerCase().startsWith(`${name.toLowerCase()}=`)) value = value.slice(name.length + 1)
  value = value.replace(/;.*$/, '').trim()
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1).trim()
  if (!value || value.length > 4096 || /[\s;,]/.test(value)) return null
  return value
}

/** X's `twid` cookie holds the account id: `u=123` (often URL-encoded as `u%3D123`) */
export function userIdFromTwid(twid: string | null | undefined): string | null {
  if (!twid) return null
  let decoded = twid
  try {
    decoded = decodeURIComponent(twid)
  } catch { /* use as is */ }
  return decoded.replace(/^"|"$/g, '').match(/^u=(\d+)$/)?.[1] ?? null
}

export type VerifyResult =
  | { ok: true; screenName: string | null }
  | { ok: false; rejected: boolean; error: string }

/**
 * Ask X who this session belongs to. `rejected` means X refused the cookies;
 * anything else (offline, X changed the endpoint) is inconclusive.
 */
export async function verifyXSession(credentials: XCredentials, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.x.com/1.1/account/settings.json', {
      headers: sessionHeaders(credentials),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => null)) as { screen_name?: unknown } | null
    if (isXAuthRejection(res.status, body)) {
      return { ok: false, rejected: true, error: `X rejected this login (HTTP ${res.status})` }
    }
    if (!res.ok) return { ok: false, rejected: false, error: `X returned HTTP ${res.status}` }
    return { ok: true, screenName: typeof body?.screen_name === 'string' ? body.screen_name : null }
  } catch (err) {
    return { ok: false, rejected: false, error: `Couldn't reach X (${err instanceof Error ? err.message : String(err)})` }
  }
}
