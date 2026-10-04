import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FetchLike } from '@/lib/x-tweet-fetcher'

const settings = vi.hoisted(() => new Map<string, string>())

vi.mock('@/lib/db', () => {
  const prisma = {
    setting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key)! })),
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        settings.set(where.key, update.value)
      },
      deleteMany: async ({ where }: { where: { key: string | { in: string[] } } }) => {
        for (const k of typeof where.key === 'string' ? [where.key] : where.key.in) settings.delete(k)
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  }
  return { default: prisma, prisma }
})

const {
  clearXSession,
  completeBrowserLogin,
  getXCredentials,
  getXSessionStatus,
  markXSessionRejected,
  normalizeCookieValue,
  saveXSession,
  userIdFromTwid,
  verifyXSession,
} = await import('@/lib/x-session')

const respond = (status: number, body?: unknown): FetchLike =>
  async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('cookie helpers', () => {
  it('cleans up pasted cookie values', () => {
    expect(normalizeCookieValue('  abc123  ', 'auth_token')).toBe('abc123')
    expect(normalizeCookieValue('auth_token=abc123; Path=/', 'auth_token')).toBe('abc123')
    expect(normalizeCookieValue('"abc123"', 'ct0')).toBe('abc123')
    expect(normalizeCookieValue('', 'ct0')).toBeNull()
    expect(normalizeCookieValue('two words', 'ct0')).toBeNull()
  })

  it('reads the account id from twid', () => {
    expect(userIdFromTwid('u%3D1234567890')).toBe('1234567890')
    expect(userIdFromTwid('"u=42"')).toBe('42')
    expect(userIdFromTwid('garbage')).toBeNull()
    expect(userIdFromTwid(null)).toBeNull()
  })
})

describe('verifyXSession', () => {
  const creds = { authToken: 'tok', ct0: 'csrf' }

  it('sends the session the way x.com does and returns the handle', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ screen_name: 'ada' }), { status: 200 })
    }
    expect(await verifyXSession(creds, fetchImpl)).toEqual({ ok: true, screenName: 'ada' })
    expect(headers.Cookie).toBe('auth_token=tok; ct0=csrf')
    expect(headers['X-Csrf-Token']).toBe('csrf')
  })

  it('separates a rejected login from an inconclusive check', async () => {
    expect(await verifyXSession(creds, respond(401))).toMatchObject({ ok: false, rejected: true })
    const csrfMismatch = { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] }
    expect(await verifyXSession(creds, respond(403, csrfMismatch))).toMatchObject({ ok: false, rejected: true })
    // A bare 403 is a proxy or firewall in the way, not X refusing the login
    expect(await verifyXSession(creds, respond(403))).toMatchObject({ ok: false, rejected: false, error: 'X returned HTTP 403' })
    expect(await verifyXSession(creds, respond(503))).toMatchObject({ ok: false, rejected: false, error: 'X returned HTTP 503' })
    const offline: FetchLike = async () => { throw new Error('getaddrinfo ENOTFOUND api.x.com') }
    expect(await verifyXSession(creds, offline)).toMatchObject({ ok: false, rejected: false })
  })
})

describe('saved session', () => {
  beforeEach(() => settings.clear())

  it('saves, reports and forgets the login', async () => {
    expect(await getXSessionStatus()).toEqual({ loggedIn: false, account: null, rejectedAt: null })
    await markXSessionRejected()
    await saveXSession({ authToken: 'tok', ct0: 'csrf' }, { userId: '42', screenName: 'ada', source: 'manual', verified: true })

    const status = await getXSessionStatus()
    expect(status.loggedIn).toBe(true)
    expect(status.account).toMatchObject({ userId: '42', screenName: 'ada', source: 'manual', verified: true })
    expect(status.rejectedAt).toBeNull() // a new login clears the old rejection
    expect(await getXCredentials()).toEqual({ authToken: 'tok', ct0: 'csrf' })

    await markXSessionRejected()
    expect((await getXSessionStatus()).rejectedAt).not.toBeNull()

    await clearXSession()
    expect(await getXSessionStatus()).toEqual({ loggedIn: false, account: null, rejectedAt: null })
    expect(settings.size).toBe(0)
  })

  it('is logged out when either cookie is missing', async () => {
    settings.set('x_auth_token', 'tok')
    settings.set('x_account', JSON.stringify({ screenName: 'ada' }))
    expect(await getXSessionStatus()).toEqual({ loggedIn: false, account: null, rejectedAt: null })
    expect(await getXCredentials()).toBeNull()
  })

  it('saves a browser login with the handle X reports', async () => {
    const result = await completeBrowserLogin({ authToken: 'tok', ct0: 'csrf', twid: 'u%3D42' }, respond(200, { screen_name: 'ada' }))
    expect(result).toEqual({ screenName: 'ada', verified: true })
    expect((await getXSessionStatus()).account).toMatchObject({ userId: '42', screenName: 'ada', source: 'browser', verified: true })
  })

  it('keeps a browser login it could not confirm, marked unverified', async () => {
    const result = await completeBrowserLogin({ authToken: 'tok', ct0: 'csrf', twid: null }, respond(503))
    expect(result).toEqual({ screenName: null, verified: false })
    expect((await getXSessionStatus()).account).toMatchObject({ source: 'browser', verified: false })
  })

  it('does not save a browser login X refuses', async () => {
    await expect(completeBrowserLogin({ authToken: 'tok', ct0: 'csrf', twid: null }, respond(401))).rejects.toThrow(/X rejected this login/)
    expect((await getXSessionStatus()).loggedIn).toBe(false)
  })
})
