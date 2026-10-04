/**
 * Reads the bookmarks of the X account logged in under Settings → X Login the
 * way x.com's own Bookmarks page does: the GraphQL `Bookmarks` timeline, most
 * recently bookmarked first, one page at a time.
 *
 * X changes this API without notice, so each moving part has a fallback:
 *  - Query ID (rotates when X deploys): SIFTLY_X_BOOKMARKS_QUERY_ID, the last
 *    one that worked, the newest one known when this was written, and finally
 *    the one in x.com's current web bundles (looked up when the others fail).
 *  - Feature flags X newly requires ("features cannot be null") are added and
 *    the request repeated.
 *  - X has been moving GraphQL reads from GET to POST; a 404 to GET is retried
 *    as POST.
 *  - Rate limits (429) wait for X's reset time through `onRateLimit`.
 *
 * Errors are thrown as XBookmarksError with a kind the caller can act on.
 */
import {
  BROWSER_UA,
  isXAuthRejection,
  parseMissingFeatures,
  sessionHeaders,
  type FetchLike,
  type XCredentials,
} from '@/lib/x-tweet-fetcher'
import {
  BOOKMARKS_FALLBACK_QUERY_ID,
  BOOKMARKS_FEATURES,
  BOOKMARKS_FIELD_TOGGLES,
  BOOKMARKS_PAGE_SIZE,
} from '@/lib/x-web-client'
import { isUnavailableGraphqlTweet, unwrapGraphqlTweet } from '@/lib/x-tweet-import'

export { BOOKMARKS_FALLBACK_QUERY_ID, BOOKMARKS_FEATURES, BOOKMARKS_FIELD_TOGGLES, BOOKMARKS_PAGE_SIZE }

const QUERY_ID_TTL_MS = 6 * 60 * 60 * 1000
/** A failed lookup (x.com unreachable, page changed) is tried again sooner */
const QUERY_ID_RETRY_MS = 10 * 60 * 1000
const MAX_RATE_LIMIT_WAITS = 4
const MAX_TRANSIENT_RETRIES = 2

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * auth = X refused the saved login · rate-limit = X's limit didn't reset in
 * time · rejected = X refused the request itself (query ID, method, a header
 * X now requires) · http / network = anything else on the way · format = the
 * answer wasn't a bookmark list
 */
export type XBookmarksErrorKind = 'auth' | 'rate-limit' | 'rejected' | 'http' | 'network' | 'format'

export class XBookmarksError extends Error {
  constructor(message: string, readonly kind: XBookmarksErrorKind, readonly status?: number) {
    super(message)
    this.name = 'XBookmarksError'
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export interface BookmarkEntry {
  tweetId: string
  /** The GraphQL tweet; null when X only sent a placeholder (deleted, suspended, protected) */
  tweet: Json | null
}

export interface BookmarksPage {
  /** In X's order: most recently bookmarked first */
  entries: BookmarkEntry[]
  /** Cursor for the next (older) page */
  nextCursor: string | null
  /** X said there is nothing below this page */
  end: boolean
}

/** The bookmark timeline in a response, wherever X keeps it this month */
function findTimeline(data: Json): Json | undefined {
  for (const key of ['bookmark_timeline_v2', 'bookmark_timeline', 'bookmark_collection_timeline']) {
    const timeline = obj(obj(data[key])?.timeline)
    if (timeline && Array.isArray(timeline.instructions)) return timeline
  }
  for (const value of Object.values(data)) {
    const timeline = obj(obj(value)?.timeline)
    if (timeline && Array.isArray(timeline.instructions)) return timeline
  }
  return undefined
}

/** One page of the Bookmarks timeline, or null when the body isn't one */
export function parseBookmarksPage(body: unknown): BookmarksPage | null {
  const data = obj(obj(body)?.data)
  const timeline = data ? findTimeline(data) : undefined
  if (!timeline) return null

  const entries: BookmarkEntry[] = []
  let nextCursor: string | null = null
  let end = false

  const addItem = (itemContent: Json | undefined, entryId: string | undefined) => {
    const result = obj(obj(itemContent?.tweet_results)?.result)
    const idFromEntry = entryId?.match(/^tweet-(\d+)$/)?.[1]
    if (!result && !idFromEntry) return // not a post (a prompt, a header…)
    const tweet = unwrapGraphqlTweet(result)
    const tweetId = str(tweet?.rest_id) ?? idFromEntry
    if (!tweetId) return
    entries.push({ tweetId, tweet: tweet && !isUnavailableGraphqlTweet(tweet) ? tweet : null })
  }

  const addEntry = (entry: Json | undefined) => {
    const content = obj(entry?.content)
    if (!entry || !content) return
    const type = str(content.entryType) ?? str(content.__typename)
    if (type === 'TimelineTimelineCursor') {
      if (content.cursorType === 'Bottom') nextCursor = str(content.value) ?? nextCursor
    } else if (type === 'TimelineTimelineItem') {
      addItem(obj(content.itemContent), str(entry.entryId))
    } else if (type === 'TimelineTimelineModule') {
      for (const item of arr(content.items)) addItem(obj(obj(obj(item)?.item)?.itemContent), str(obj(item)?.entryId))
    }
  }

  for (const raw of arr(timeline.instructions)) {
    const instruction = obj(raw)
    const type = str(instruction?.type) ?? str(instruction?.__typename)
    if (!instruction) continue
    if (type === 'TimelineAddEntries') {
      for (const entry of arr(instruction.entries)) addEntry(obj(entry))
    } else if (type === 'TimelineReplaceEntry') {
      addEntry(obj(instruction.entry))
    } else if (type === 'TimelineAddToModule') {
      for (const item of arr(instruction.moduleItems)) addItem(obj(obj(obj(item)?.item)?.itemContent), str(obj(item)?.entryId))
    } else if (type === 'TimelineTerminateTimeline' && instruction.direction !== 'Top') {
      end = true
    }
  }

  return { entries, nextCursor, end }
}

// ── Query ID discovery ───────────────────────────────────────────────────────

const SCRIPT_URL_RE = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[\w.~-]+\.js/g
const DEFAULT_SCRIPT_BASE = 'https://abs.twimg.com/responsive-web/client-web/'

/** `queryId:"…",operationName:"Bookmarks"` in one of x.com's scripts */
export function findBookmarksQueryId(source: string): string | null {
  return source.match(/queryId\s*:\s*"([\w-]+)"\s*,\s*operationName\s*:\s*"Bookmarks"/)?.[1] ?? null
}

function objectPairs(literal: string): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const m of literal.matchAll(/(?:"([^"]+)"|([\w$]+))\s*:\s*"([^"]*)"/g)) pairs.set(m[1] ?? m[2], m[3])
  return pairs
}

/**
 * URLs of x.com's lazily loaded scripts whose names match `filter`. The
 * webpack runtime inlined in the page maps chunk ids to names
 * ({…:"ondemand.s",…:"bundle.Bookmarks",…}) and, right after, to content
 * hashes; a chunk is served at `<base><name>.<hash>a.js`.
 */
export function chunkScriptUrls(source: string, filter: RegExp, base = DEFAULT_SCRIPT_BASE): string[] {
  const urls: string[] = []
  for (const m of source.matchAll(/\{[^{}]*:\s*"ondemand\.s"[^{}]*\}/g)) {
    const names = objectPairs(m[0])
    const rest = source.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200)
    const hashes = objectPairs(rest.match(/\{[^{}]*\}/)?.[0] ?? '')
    for (const [id, name] of names) {
      const hash = hashes.get(id)
      if (hash && filter.test(name)) urls.push(`${base}${name}.${hash}a.js`)
    }
  }
  return [...new Set(urls)]
}

let discovered: { value: string | null; at: number } | null = null
let discoveryInFlight: Promise<string | null> | null = null

/**
 * Find the current Bookmarks query ID in x.com's web client: the logged-in
 * page (x.com/home) lists the main scripts and the map of lazily loaded ones;
 * the ID sits in the main script or in the Bookmarks bundle. Null when it
 * can't be found. Cached for 6 hours (a failed lookup for 10 minutes).
 */
export function discoverBookmarksQueryId(fetchImpl: FetchLike, credentials?: XCredentials | null): Promise<string | null> {
  if (discovered && Date.now() - discovered.at < (discovered.value ? QUERY_ID_TTL_MS : QUERY_ID_RETRY_MS)) {
    return Promise.resolve(discovered.value)
  }
  discoveryInFlight ??= runDiscovery(fetchImpl, credentials)
    .then((value) => {
      discovered = { value, at: Date.now() }
      return value
    })
    .finally(() => {
      discoveryInFlight = null
    })
  return discoveryInFlight
}

/** Forget the cached discovery (tests) */
export function resetBookmarksQueryIdCache(): void {
  discovered = null
  discoveryInFlight = null
}

async function runDiscovery(fetchImpl: FetchLike, credentials?: XCredentials | null): Promise<string | null> {
  const getText = async (url: string, headers: Record<string, string>) => {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) })
      return res.ok ? await res.text() : null
    } catch {
      return null
    }
  }

  // Logged out, x.com/ now serves a different web app; /home still serves the one with the bookmarks page
  const html = await getText('https://x.com/home', {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(credentials ? { Cookie: `auth_token=${credentials.authToken}; ct0=${credentials.ct0}` } : {}),
  })
  if (!html) return null
  const inPage = findBookmarksQueryId(html)
  if (inPage) return inPage

  const scripts = [...new Set(html.match(SCRIPT_URL_RE) ?? [])]
  const main = scripts.find((u) => /\/main\.[\w]+\.js$/.test(u))
  const base = main ? main.slice(0, main.lastIndexOf('/') + 1) : DEFAULT_SCRIPT_BASE
  const scriptHeaders = { 'User-Agent': BROWSER_UA, Accept: '*/*', Referer: 'https://x.com/' }

  const fromChunks = async (source: string) => {
    for (const url of chunkScriptUrls(source, /Bookmarks/, base)) {
      const js = await getText(url, scriptHeaders)
      const id = js ? findBookmarksQueryId(js) : null
      if (id) return id
    }
    return null
  }

  const viaPageChunks = await fromChunks(html)
  if (viaPageChunks) return viaPageChunks
  for (const url of main ? [main] : []) {
    const js = await getText(url, scriptHeaders)
    if (!js) continue
    const id = findBookmarksQueryId(js) ?? (await fromChunks(js))
    if (id) return id
  }
  return null
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface XBookmarksClientOptions {
  credentials: XCredentials
  fetchImpl?: FetchLike
  /** Query IDs to try first, best first (an override, the last one that worked) */
  queryIds?: (string | null | undefined)[]
  /** Look up the current query ID on x.com once the known ones stop working (default true) */
  discover?: boolean
  pageSize?: number
  /**
   * X's rate limit is used up until `until` (ms). Resolve true once it has
   * passed to try again, false to give up.
   */
  onRateLimit?: (until: number) => Promise<boolean>
  /** For tests */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class XBookmarksClient {
  private readonly credentials: XCredentials
  private readonly fetchImpl: FetchLike
  private readonly pageSize: number
  private readonly onRateLimit?: (until: number) => Promise<boolean>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly candidates: string[]
  private discoverWhenStuck: boolean
  private readonly tried = new Set<string>()
  private current: string | null = null
  private working: string | null = null
  private method: 'GET' | 'POST' = 'GET'
  private extraFeatures: Record<string, boolean> = {}

  constructor(options: XBookmarksClientOptions) {
    this.credentials = options.credentials
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.pageSize = options.pageSize ?? BOOKMARKS_PAGE_SIZE
    this.onRateLimit = options.onRateLimit
    this.sleep = options.sleep ?? defaultSleep
    this.discoverWhenStuck = options.discover ?? true
    const ids = [...(options.queryIds ?? []), BOOKMARKS_FALLBACK_QUERY_ID]
    this.candidates = [...new Set(ids.map((id) => id?.trim()).filter((id): id is string => !!id && /^[\w-]+$/.test(id)))]
  }

  /** The query ID that last returned a page */
  get queryId(): string | null {
    return this.working
  }

  /** One page of bookmarks: the newest without a cursor, older ones with the previous page's cursor */
  async fetchPage(cursor?: string | null): Promise<BookmarksPage> {
    let lastError: XBookmarksError | null = null
    while (true) {
      this.current ??= await this.nextQueryId()
      if (!this.current) {
        throw lastError ?? new XBookmarksError('No query ID for X bookmarks is known', 'rejected')
      }
      try {
        const page = await this.fetchWith(this.current, cursor ?? null)
        this.working = this.current
        return page
      } catch (err) {
        // A retired query ID (or a request X now refuses): try the next one
        if (!(err instanceof XBookmarksError) || err.kind !== 'rejected') throw err
        lastError = err
        this.current = null
        this.method = 'GET'
      }
    }
  }

  private async nextQueryId(): Promise<string | null> {
    let next = this.candidates.shift()
    if (!next && this.discoverWhenStuck) {
      this.discoverWhenStuck = false
      next = (await discoverBookmarksQueryId(this.fetchImpl, this.credentials)) ?? undefined
    }
    if (!next || this.tried.has(next)) return next ? this.nextQueryId() : null
    this.tried.add(next)
    return next
  }

  private request(queryId: string, cursor: string | null): Promise<Response> {
    const variables = { count: this.pageSize, includePromotedContent: false, ...(cursor ? { cursor } : {}) }
    const features = { ...BOOKMARKS_FEATURES, ...this.extraFeatures }
    const url = `https://x.com/i/api/graphql/${queryId}/Bookmarks`
    const headers = { ...sessionHeaders(this.credentials), Referer: 'https://x.com/i/bookmarks' }
    if (this.method === 'POST') {
      return this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ variables, features, fieldToggles: BOOKMARKS_FIELD_TOGGLES, queryId }),
        signal: AbortSignal.timeout(30_000),
      })
    }
    const query =
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(features))}` +
      `&fieldToggles=${encodeURIComponent(JSON.stringify(BOOKMARKS_FIELD_TOGGLES))}`
    return this.fetchImpl(url + query, { headers, signal: AbortSignal.timeout(30_000) })
  }

  private async fetchWith(queryId: string, cursor: string | null): Promise<BookmarksPage> {
    let rateLimitWaits = 0
    let transientRetries = 0
    let featureRetries = 0

    while (true) {
      let res: Response
      try {
        res = await this.request(queryId, cursor)
      } catch (err) {
        if (transientRetries++ < MAX_TRANSIENT_RETRIES) {
          await this.sleep(2000 * transientRetries)
          continue
        }
        throw new XBookmarksError(`Couldn't reach X (${err instanceof Error ? err.message : String(err)})`, 'network')
      }

      if (res.status === 429) {
        const resetSecs = Number(res.headers.get('x-rate-limit-reset'))
        const until = Number.isFinite(resetSecs) && resetSecs > 0 ? resetSecs * 1000 : Date.now() + 15 * 60_000
        if (rateLimitWaits++ < MAX_RATE_LIMIT_WAITS && this.onRateLimit && (await this.onRateLimit(until))) continue
        throw new XBookmarksError(
          `X's limit for reading bookmarks is used up until ${new Date(until).toLocaleTimeString()}. Try again after that.`,
          'rate-limit',
          429,
        )
      }

      const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null

      if (isXAuthRejection(res.status, body)) {
        throw new XBookmarksError(`X rejected the saved login (HTTP ${res.status})`, 'auth', res.status)
      }

      const missing = parseMissingFeatures(body).filter((f) => !(f in this.extraFeatures))
      if (missing.length > 0 && featureRetries++ < 3) {
        for (const feature of missing) this.extraFeatures[feature] = false
        continue
      }

      // X answers an empty 404 when a read has to be a POST now
      if ((res.status === 404 || res.status === 405) && this.method === 'GET') {
        this.method = 'POST'
        continue
      }

      const xError = body?.errors?.map((e) => e.message).filter(Boolean).join('; ')
      if (res.status === 400 || res.status === 404 || res.status === 405 || res.status === 422) {
        throw new XBookmarksError(`X refused the bookmarks request (HTTP ${res.status}${xError ? `: ${xError}` : ''})`, 'rejected', res.status)
      }
      if (!res.ok) {
        if (res.status >= 500 && transientRetries++ < MAX_TRANSIENT_RETRIES) {
          await this.sleep(2000 * transientRetries)
          continue
        }
        throw new XBookmarksError(`X returned HTTP ${res.status}${xError ? `: ${xError}` : ''}`, 'http', res.status)
      }

      const page = parseBookmarksPage(body)
      if (!page) {
        throw new XBookmarksError(
          xError ? `X returned an error instead of bookmarks: ${xError}` : "X's answer didn't contain a bookmark list",
          'format',
          res.status,
        )
      }
      return page
    }
  }
}
