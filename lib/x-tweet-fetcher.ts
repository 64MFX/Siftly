/**
 * Fetches a fresh, complete copy of a single tweet from X for archiving.
 *
 * 1. GraphQL `TweetResultByRestId` — the only source that returns the full
 *    body of X Articles (`withArticleRichContentState`), long-form note tweets,
 *    quoted tweets and every video variant. Uses the X session cookies saved
 *    for live sync when available, otherwise a guest token.
 * 2. Public syndication API — no auth, used when GraphQL is unavailable,
 *    rate limited or rejects the request.
 *
 * Failures are reported as `errors`, never thrown: the archiver can always fall
 * back to the JSON stored at import time.
 */
import { snapshotFromGraphql, snapshotFromSyndication, type TweetSnapshot } from '@/lib/tweet-snapshot'

/** Public bearer token used by the x.com web client */
export const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Query IDs rotate when X deploys. The current one is discovered from the
// x.com web bundle at runtime; this is only the fallback. Override with
// SIFTLY_X_TWEET_QUERY_ID if both stop working.
const FALLBACK_TWEET_QUERY_ID = 'Xl5pC_lBk_gcO2ItU39DQw'
const QUERY_ID_TTL_MS = 6 * 60 * 60 * 1000

const BASE_FEATURES: Record<string, boolean> = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  payments_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  rweb_video_screen_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
}

const FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withArticleSummaryText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
  withPayments: false,
  withAuxiliaryUserLabels: false,
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface XCredentials {
  authToken: string
  ct0: string
}

export interface RemoteTweet {
  /** Null when X could not be reached or the tweet is gone */
  snapshot: TweetSnapshot | null
  source?: 'x-graphql' | 'x-syndication'
  raw?: unknown
  /** X positively reported the tweet as deleted / unavailable */
  unavailable: boolean
  errors: string[]
}

type GraphqlOutcome =
  | { kind: 'found'; snapshot: TweetSnapshot; raw: unknown }
  | { kind: 'missing'; raw: unknown }

// Shared across fetcher instances so a long-running server discovers once
let discoveredQueryId: { value: string | null; at: number } | null = null
let discoveryInFlight: Promise<string | null> | null = null

export function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '')
}

export function parseMissingFeatures(body: unknown): string[] {
  const errors = (body as { errors?: { message?: string }[] } | null)?.errors ?? []
  for (const e of errors) {
    const m = e.message?.match(/features cannot be null:\s*([\w,\s]+)/i)
    if (m) return m[1].split(',').map((f) => f.trim()).filter(Boolean)
  }
  return []
}

async function discoverTweetQueryId(fetchImpl: FetchLike): Promise<string | null> {
  try {
    const home = await fetchImpl('https://x.com/', {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!home.ok) return null
    const html = await home.text()
    const bundle = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/main\.[\w]+\.js/)?.[0]
    if (!bundle) return null
    const js = await fetchImpl(bundle, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15_000) })
    if (!js.ok) return null
    const source = await js.text()
    return source.match(/queryId:"([\w-]+)",operationName:"TweetResultByRestId"/)?.[1] ?? null
  } catch {
    return null
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class XTweetFetcher {
  private readonly fetchImpl: FetchLike
  private credentials: XCredentials | null
  private readonly queryIdOverride?: string
  private guestToken: { value: string; expires: number } | null = null
  private graphqlPausedUntil = 0
  private graphqlPauseReason = ''
  private extraFeatures: Record<string, boolean> = {}

  constructor(options: { fetchImpl?: FetchLike; credentials?: XCredentials | null; queryId?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.credentials = options.credentials ?? null
    this.queryIdOverride = options.queryId ?? (process.env.SIFTLY_X_TWEET_QUERY_ID?.trim() || undefined)
  }

  get authMode(): 'session' | 'guest' {
    return this.credentials ? 'session' : 'guest'
  }

  /**
   * `preferSyndication`: try the public syndication API first. Use it when the
   * stored copy is already a rich GraphQL payload and only needs refreshing —
   * this saves X's tight GraphQL rate limit for articles and file imports.
   */
  async fetchTweet(tweetId: string, options: { preferSyndication?: boolean } = {}): Promise<RemoteTweet> {
    const errors: string[] = []
    let gone = false

    const viaGraphql = async (): Promise<RemoteTweet | null> => {
      if (Date.now() < this.graphqlPausedUntil) {
        errors.push(`X GraphQL skipped: ${this.graphqlPauseReason}`)
        return null
      }
      try {
        const outcome = await this.fetchGraphql(tweetId)
        if (outcome.kind === 'found') {
          return { snapshot: outcome.snapshot, source: 'x-graphql', raw: outcome.raw, unavailable: !!outcome.snapshot.unavailable, errors }
        }
        gone = true
      } catch (err) {
        errors.push(`X GraphQL: ${errorMessage(err)}`)
      }
      return null
    }

    const viaSyndication = async (): Promise<RemoteTweet | null> => {
      try {
        const synd = await this.fetchSyndication(tweetId)
        if (synd.snapshot && !synd.snapshot.unavailable) {
          return { snapshot: synd.snapshot, source: 'x-syndication', raw: synd.raw, unavailable: false, errors }
        }
        gone = true
      } catch (err) {
        errors.push(`X syndication: ${errorMessage(err)}`)
      }
      return null
    }

    const steps = options.preferSyndication ? [viaSyndication, viaGraphql] : [viaGraphql, viaSyndication]
    for (const step of steps) {
      const result = await step()
      if (result) return result
    }
    return { snapshot: null, unavailable: gone, errors }
  }

  // ── GraphQL ──────────────────────────────────────────────────────────────

  private pauseGraphql(until: number, reason: string) {
    this.graphqlPausedUntil = until
    this.graphqlPauseReason = reason
  }

  private async queryId(): Promise<string> {
    if (this.queryIdOverride) return this.queryIdOverride
    if (discoveredQueryId && Date.now() - discoveredQueryId.at < QUERY_ID_TTL_MS) {
      return discoveredQueryId.value ?? FALLBACK_TWEET_QUERY_ID
    }
    if (!discoveryInFlight) {
      discoveryInFlight = discoverTweetQueryId(this.fetchImpl).finally(() => { discoveryInFlight = null })
    }
    const value = await discoveryInFlight
    discoveredQueryId = { value, at: Date.now() }
    return value ?? FALLBACK_TWEET_QUERY_ID
  }

  private async activateGuestToken(): Promise<string> {
    if (this.guestToken && Date.now() < this.guestToken.expires) return this.guestToken.value
    const res = await this.fetchImpl('https://api.x.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: { Authorization: `Bearer ${X_WEB_BEARER}`, 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`guest token request failed (HTTP ${res.status})`)
    const body = (await res.json()) as { guest_token?: string }
    if (!body.guest_token) throw new Error('guest token missing from response')
    this.guestToken = { value: body.guest_token, expires: Date.now() + 2 * 60 * 60 * 1000 }
    return body.guest_token
  }

  private async headers(): Promise<Record<string, string>> {
    const common: Record<string, string> = {
      Authorization: `Bearer ${X_WEB_BEARER}`,
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'en',
      Referer: 'https://x.com/',
      Origin: 'https://x.com',
    }
    if (this.credentials) {
      return {
        ...common,
        Cookie: `auth_token=${this.credentials.authToken}; ct0=${this.credentials.ct0}`,
        'X-Csrf-Token': this.credentials.ct0,
        'X-Twitter-Auth-Type': 'OAuth2Session',
      }
    }
    return { ...common, 'X-Guest-Token': await this.activateGuestToken() }
  }

  private async fetchGraphql(tweetId: string): Promise<GraphqlOutcome> {
    const queryId = await this.queryId()
    const variables = { tweetId, withCommunity: false, includePromotedContent: false, withVoice: false }

    for (let attempt = 0; attempt < 4; attempt++) {
      const features = { ...BASE_FEATURES, ...this.extraFeatures }
      const url =
        `https://x.com/i/api/graphql/${queryId}/TweetResultByRestId` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(features))}` +
        `&fieldToggles=${encodeURIComponent(JSON.stringify(FIELD_TOGGLES))}`

      const res = await this.fetchImpl(url, { headers: await this.headers(), signal: AbortSignal.timeout(20_000) })

      if (res.status === 429) {
        const resetSecs = Number(res.headers.get('x-rate-limit-reset'))
        const until = Number.isFinite(resetSecs) && resetSecs > 0 ? resetSecs * 1000 : Date.now() + 15 * 60 * 1000
        this.pauseGraphql(until, `rate limited until ${new Date(until).toLocaleTimeString()}`)
        throw new Error('rate limited by X')
      }

      if (res.status === 401 || res.status === 403) {
        if (this.credentials) {
          // Saved session expired — continue this run as a guest
          this.credentials = null
          continue
        }
        if (attempt === 0) {
          this.guestToken = null
          continue
        }
      }

      const body = (await res.json().catch(() => null)) as {
        data?: { tweetResult?: { result?: unknown } }
        errors?: { message?: string }[]
      } | null

      const missing = parseMissingFeatures(body)
      if (missing.length > 0) {
        for (const feature of missing) this.extraFeatures[feature] = false
        continue
      }

      if (!res.ok) {
        // Stale query ID or a request X refuses — stop hammering it for this run
        this.pauseGraphql(Date.now() + 30 * 60 * 1000, `X GraphQL returned HTTP ${res.status}`)
        throw new Error(`HTTP ${res.status}`)
      }

      const result = body?.data?.tweetResult?.result
      if (!result) return { kind: 'missing', raw: body }
      const snapshot = snapshotFromGraphql(result, tweetId)
      return snapshot ? { kind: 'found', snapshot, raw: result } : { kind: 'missing', raw: body }
    }

    throw new Error('X GraphQL request kept failing')
  }

  // ── Syndication ──────────────────────────────────────────────────────────

  private async fetchSyndication(tweetId: string): Promise<{ snapshot: TweetSnapshot | null; raw: unknown }> {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&lang=en&token=${syndicationToken(tweetId)}`
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) return { snapshot: null, raw: null }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.json().catch(() => null)
    if (!raw || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) return { snapshot: null, raw }
    return { snapshot: snapshotFromSyndication(raw, tweetId), raw }
  }
}
