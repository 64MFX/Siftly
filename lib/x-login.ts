/**
 * "Log in to X" for self-hosted Siftly.
 *
 * Opens the user's own Chrome / Edge / Brave / Chromium in a separate,
 * temporary profile on x.com's login page. The user signs in on x.com itself —
 * password, 2FA and any checks X asks for — so Siftly never sees the password.
 * Siftly only watches that browser's cookie jar over the DevTools protocol (a
 * private pipe, no network port) and, once X has set the session cookies
 * (`auth_token` + `ct0`), hands them to `onLoggedIn`, closes the window and
 * deletes the temporary profile.
 *
 * Nothing attaches to the x.com page itself, and navigator.webdriver stays
 * false, so to X this is an ordinary browser login.
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Readable, Writable } from 'stream'
import { StringDecoder } from 'string_decoder'

export const X_LOGIN_URL = 'https://x.com/i/flow/login'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1000
/** X may replace ct0 right after login; wait this long after auth_token appears */
const SETTLE_MS = 1500

// ── Finding a browser ────────────────────────────────────────────────────────

export interface BrowserInfo {
  name: string
  path: string
}

/** Where Chromium-based browsers are installed, most common first */
export function browserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): BrowserInfo[] {
  if (platform === 'darwin') {
    const apps: [string, string][] = [
      ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
      ['Vivaldi', 'Vivaldi.app/Contents/MacOS/Vivaldi'],
    ]
    const dirs = ['/Applications', path.posix.join(home, 'Applications')]
    return apps.flatMap(([name, rel]) => dirs.map((dir) => ({ name, path: path.posix.join(dir, rel) })))
  }
  if (platform === 'win32') {
    const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((b): b is string => !!b)
    const apps: [string, string][] = [
      ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['Chromium', 'Chromium\\Application\\chrome.exe'],
      ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
    ]
    return apps.flatMap(([name, rel]) => bases.map((base) => ({ name, path: path.win32.join(base, rel) })))
  }
  const bins: [string, string][] = [
    ['Google Chrome', 'google-chrome-stable'],
    ['Google Chrome', 'google-chrome'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Brave', 'brave-browser'],
    ['Brave', 'brave'],
    ['Vivaldi', 'vivaldi-stable'],
  ]
  const dirs = (env.PATH ?? '').split(':').filter(Boolean)
  const found = bins.flatMap(([name, bin]) => dirs.map((dir) => ({ name, path: path.posix.join(dir, bin) })))
  // Snap packages can't see the temporary profile folder — use them only as a last resort
  return [...found.filter((b) => !b.path.startsWith('/snap/')), ...found.filter((b) => b.path.startsWith('/snap/'))]
}

export function findBrowser(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  home: string = os.homedir(),
): BrowserInfo | null {
  const override = env.SIFTLY_BROWSER_PATH?.trim()
  if (override) return exists(override) ? { name: path.basename(override, path.extname(override)), path: override } : null
  return browserCandidates(platform, env, home).find((b) => exists(b.path)) ?? null
}

export interface BrowserLoginAvailability {
  available: boolean
  browser: string | null
  /** Why the login window can't be used here */
  reason: string | null
}

export function browserLoginAvailability(): BrowserLoginAvailability {
  if (existsSync('/.dockerenv')) {
    return { available: false, browser: null, reason: "Siftly is running in Docker, so it can't open a browser window on your computer." }
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { available: false, browser: null, reason: 'No desktop session was found to open a browser window in.' }
  }
  const browser = findBrowser()
  if (!browser) {
    return {
      available: false,
      browser: null,
      reason: process.env.SIFTLY_BROWSER_PATH?.trim()
        ? `SIFTLY_BROWSER_PATH points to a file that doesn't exist (${process.env.SIFTLY_BROWSER_PATH.trim()}).`
        : 'No Chrome, Edge, Brave or Chromium was found. Install one, or set SIFTLY_BROWSER_PATH.',
    }
  }
  return { available: true, browser: browser.name, reason: null }
}

// ── DevTools protocol over a pipe ────────────────────────────────────────────

/**
 * Minimal Chrome DevTools Protocol client for `--remote-debugging-pipe`:
 * JSON messages separated by NUL bytes, written to the browser's fd 3 and read
 * from its fd 4.
 */
export class CdpPipe {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private closedError: Error | null = null

  /** The browser end of the pipe is gone */
  get closed(): boolean {
    return this.closedError !== null
  }

  constructor(private readonly writable: Writable, readable: Readable) {
    readable.on('data', (chunk: Buffer) => this.onData(chunk))
    readable.on('close', () => this.close(new Error('The browser closed')))
    readable.on('error', (err: Error) => this.close(err))
    writable.on('error', (err: Error) => this.close(err))
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      try {
        this.writable.write(`${JSON.stringify({ id, method, params })}\0`)
      } catch (err) {
        this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)))
        this.pending.delete(id)
      }
    })
  }

  close(err: Error = new Error('Connection closed')) {
    if (this.closedError) return
    this.closedError = err
    for (const waiter of this.pending.values()) waiter.reject(err)
    this.pending.clear()
  }

  private onData(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue // an event — not needed here
      const waiter = this.pending.get(message.id)
      if (!waiter) continue
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'DevTools error'))
      else waiter.resolve(message.result)
    }
  }
}

// ── Picking the session out of the cookie jar ────────────────────────────────

export interface BrowserCookie {
  name: string
  value: string
  domain: string
}

export interface CapturedXSession {
  authToken: string
  ct0: string
  /** `twid` cookie — holds the account id */
  twid: string | null
}

function isXDomain(domain: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase()
  return d === 'x.com' || d.endsWith('.x.com')
}

/** The logged-in session, once X has set both auth_token and ct0 */
export function pickXSession(cookies: BrowserCookie[]): CapturedXSession | null {
  const onX = cookies.filter((c) => isXDomain(c.domain) && c.value)
  const get = (name: string) => onX.find((c) => c.name === name)?.value ?? null
  const authToken = get('auth_token')
  const ct0 = get('ct0')
  return authToken && ct0 ? { authToken, ct0, twid: get('twid') } : null
}

// ── The login run ────────────────────────────────────────────────────────────

export type XLoginStatus = 'idle' | 'waiting' | 'saving' | 'success' | 'error' | 'cancelled'

export interface XLoginState {
  status: XLoginStatus
  browser: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Why it failed or was cancelled */
  message: string | null
  screenName: string | null
}

export interface StartXLoginOptions {
  /** Store the captured session. Returns the account's @handle when known. */
  onLoggedIn: (session: CapturedXSession) => Promise<{ screenName: string | null }>
  browser?: BrowserInfo
  url?: string
  timeoutMs?: number
  pollMs?: number
  /** Additional browser flags (used by tests) */
  extraArgs?: string[]
}

export class XLoginError extends Error {}

interface LoginRun {
  cancel: (message: string) => Promise<void>
  kill: () => void
}

const store = globalThis as unknown as {
  siftlyXLogin?: { state: XLoginState; run: LoginRun | null }
  siftlyXLoginExitHook?: boolean
}

function loginStore() {
  store.siftlyXLogin ??= {
    state: { status: 'idle', browser: null, startedAt: null, finishedAt: null, message: null, screenName: null },
    run: null,
  }
  if (!store.siftlyXLoginExitHook) {
    store.siftlyXLoginExitHook = true
    // Don't leave a login window behind if Siftly itself stops
    process.once('exit', () => store.siftlyXLogin?.run?.kill())
  }
  return store.siftlyXLogin
}

export function getXLoginState(): XLoginState {
  return { ...loginStore().state }
}

export function isXLoginRunning(): boolean {
  const { status } = loginStore().state
  return status === 'waiting' || status === 'saving'
}

/** Close the login window without logging in */
export async function cancelXLogin(): Promise<boolean> {
  const run = loginStore().run
  if (!run) return false
  await run.cancel('Login cancelled.')
  return true
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Open the login window and return right away; follow progress with
 * getXLoginState(). Throws XLoginError if a login is already running or no
 * browser can be opened here.
 */
export async function startXLogin(options: StartXLoginOptions): Promise<XLoginState> {
  const l = loginStore()
  if (isXLoginRunning()) throw new XLoginError('A login window is already open')

  let browser = options.browser ?? null
  if (!browser) {
    const availability = browserLoginAvailability()
    if (!availability.available) throw new XLoginError(availability.reason ?? 'No browser available')
    browser = findBrowser()
    if (!browser) throw new XLoginError('No supported browser found')
  }

  // Claim the login before the first await so a double click can't open two windows
  l.state = {
    status: 'waiting',
    browser: browser.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: null,
    screenName: null,
  }
  const fail = (message: string): never => {
    l.state = { ...l.state, status: 'error', message, finishedAt: new Date().toISOString() }
    throw new XLoginError(message)
  }

  let profileDir: string
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siftly-x-login-'))
  } catch (err) {
    return fail(`Couldn't create a temporary browser profile: ${err instanceof Error ? err.message : String(err)}`)
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    // The debugging pipe alone flips navigator.webdriver to true, which X can treat as a bot
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    // Keep the throwaway profile away from the OS keychain / keyring (no unlock prompts)
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
    // Chrome refuses to start as root without this
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...(options.extraArgs ?? []),
    options.url ?? X_LOGIN_URL,
  ]

  let child: ChildProcess
  try {
    child = spawn(browser.path, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  } catch (err) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
    return fail(`Couldn't open ${browser.name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable)
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const pollMs = options.pollMs ?? POLL_MS

  let finished = false
  let closing: Promise<void> | null = null

  const closeBrowser = () =>
    (closing ??= (async () => {
      // pid is undefined when the browser never started
      if (child.pid !== undefined) {
        await cdp.send('Browser.close', {}, 3000).catch(() => {})
        if (!(await waitForExit(child, 5000))) {
          child.kill()
          await waitForExit(child, 2000)
        }
      }
      cdp.close()
      await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    })())

  const finish = async (status: 'success' | 'error' | 'cancelled', message: string | null, screenName: string | null = null) => {
    if (finished) return
    finished = true
    await closeBrowser()
    l.run = null
    l.state = { ...l.state, status, message, screenName, finishedAt: new Date().toISOString() }
  }

  l.run = {
    cancel: (message) => finish('cancelled', message),
    kill: () => { if (child.exitCode === null) child.kill() },
  }

  const browserName = browser.name
  child.once('error', (err) => {
    void finish('error', `Couldn't open ${browserName}: ${err.message}`)
  })
  child.once('exit', () => {
    if (!closing) void finish('cancelled', 'The login window was closed before you finished logging in.')
  })

  const watch = async () => {
    const deadline = Date.now() + timeoutMs
    let sawPage = false
    let seenAt: number | null = null
    while (!finished) {
      await sleep(pollMs)
      if (finished) return
      if (Date.now() > deadline) {
        await finish('error', 'Timed out waiting for you to log in. Try again.')
        return
      }

      let session: CapturedXSession | null
      try {
        const { cookies } = await cdp.send<{ cookies: BrowserCookie[] }>('Storage.getCookies')
        session = pickXSession(cookies)
      } catch {
        // A slow first start can time out a command; only a closed pipe means the window is gone
        if (!cdp.closed) continue
        if (!finished && !closing) await finish('cancelled', 'The login window was closed before you finished logging in.')
        return
      }

      if (session) {
        seenAt ??= Date.now()
        if (Date.now() - seenAt < SETTLE_MS) continue
        l.state = { ...l.state, status: 'saving' }
        await closeBrowser()
        try {
          const { screenName } = await options.onLoggedIn(session)
          await finish('success', null, screenName)
        } catch (err) {
          await finish('error', err instanceof Error ? err.message : String(err))
        }
        return
      }

      // On macOS the browser keeps running after its last window is closed
      try {
        const { targetInfos } = await cdp.send<{ targetInfos: { type: string }[] }>('Target.getTargets')
        const pages = targetInfos.filter((t) => t.type === 'page').length
        if (pages > 0) sawPage = true
        else if (sawPage) {
          await finish('cancelled', 'The login window was closed before you finished logging in.')
          return
        }
      } catch { /* the next cookie poll notices a closed browser */ }
    }
  }
  void watch()

  return getXLoginState()
}
