import { describe, it, expect, vi } from 'vitest'
import { XTweetFetcher, parseMissingFeatures, syndicationToken, type FetchLike } from '@/lib/x-tweet-fetcher'
import { ARTICLE_TWEET_ID, articleTweetGraphql, syndicationTweet, SYNDICATION_TWEET_ID } from './fixtures/x-tweets'

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

function fakeX(routes: { graphql?: (url: URL, headers: Record<string, string>) => Response; syndication?: (url: URL) => Response }) {
  const calls: string[] = []
  const fetchImpl: FetchLike = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    calls.push(`${url.hostname}${url.pathname}`)
    if (url.pathname.endsWith('/guest/activate.json')) return json({ guest_token: 'guest-1' })
    if (url.pathname.includes('/TweetResultByRestId') && routes.graphql) {
      return routes.graphql(url, (init?.headers ?? {}) as Record<string, string>)
    }
    if (url.hostname === 'cdn.syndication.twimg.com' && routes.syndication) return routes.syndication(url)
    return new Response(null, { status: 500 })
  })
  return { fetchImpl, calls }
}

describe('XTweetFetcher', () => {
  it('fetches full articles via GraphQL with a guest token', async () => {
    let seenHeaders: Record<string, string> = {}
    let seenToggles: unknown
    const { fetchImpl } = fakeX({
      graphql: (url, headers) => {
        seenHeaders = headers
        seenToggles = JSON.parse(url.searchParams.get('fieldToggles')!)
        return json({ data: { tweetResult: { result: articleTweetGraphql } } })
      },
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q' })
    const result = await fetcher.fetchTweet(ARTICLE_TWEET_ID)

    expect(result.source).toBe('x-graphql')
    expect(result.unavailable).toBe(false)
    expect(result.snapshot?.article?.complete).toBe(true)
    expect(seenHeaders['X-Guest-Token']).toBe('guest-1')
    expect(seenToggles).toMatchObject({ withArticleRichContentState: true })
  })

  it('uses the saved X session and falls back to guest when it is rejected', async () => {
    const auth: string[] = []
    const { fetchImpl } = fakeX({
      graphql: (_url, headers) => {
        auth.push(headers.Cookie ? 'session' : 'guest')
        return headers.Cookie ? new Response(null, { status: 401 }) : json({ data: { tweetResult: { result: articleTweetGraphql } } })
      },
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q', credentials: { authToken: 'a', ct0: 'c' } })
    expect(fetcher.authMode).toBe('session')
    const result = await fetcher.fetchTweet(ARTICLE_TWEET_ID)
    expect(result.source).toBe('x-graphql')
    expect(auth).toEqual(['session', 'guest'])
    expect(fetcher.authMode).toBe('guest')
  })

  it('reports a rejected login once and keeps going as a guest', async () => {
    const onSessionRejected = vi.fn()
    const { fetchImpl } = fakeX({
      graphql: (_url, headers) =>
        headers.Cookie
          ? json({ errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] }, { status: 403 })
          : json({ data: { tweetResult: { result: articleTweetGraphql } } }),
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q', credentials: { authToken: 'a', ct0: 'c' }, onSessionRejected })
    await fetcher.fetchTweet(ARTICLE_TWEET_ID)
    await fetcher.fetchTweet(ARTICLE_TWEET_ID)
    expect(onSessionRejected).toHaveBeenCalledTimes(1)
    expect(fetcher.sessionRejected).toBe(true)
  })

  it("doesn't blame the login for a 403 from a proxy in the way", async () => {
    const onSessionRejected = vi.fn()
    const { fetchImpl } = fakeX({
      graphql: () => new Response('<html>Blocked by proxy</html>', { status: 403 }),
      syndication: () => json(syndicationTweet),
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q', credentials: { authToken: 'a', ct0: 'c' }, onSessionRejected })
    const result = await fetcher.fetchTweet(SYNDICATION_TWEET_ID)
    expect(result.source).toBe('x-syndication')
    expect(onSessionRejected).not.toHaveBeenCalled()
    expect(fetcher.authMode).toBe('session')
  })

  it('can ask GraphQL only, and reports when its rate limit resets', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600
    const { fetchImpl, calls } = fakeX({
      graphql: () => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } }),
      syndication: () => json(syndicationTweet),
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q' })
    expect(fetcher.graphqlRateLimitedUntil).toBeNull()
    const result = await fetcher.fetchTweet(SYNDICATION_TWEET_ID, { graphqlOnly: true })
    expect(result.snapshot).toBeNull()
    expect(calls.some((c) => c.startsWith('cdn.syndication'))).toBe(false)
    expect(fetcher.graphqlRateLimitedUntil).toBe(reset * 1000)
    expect(fetcher.graphqlPaused).toBe(true)
  })

  it('adds feature flags X reports as missing and retries', async () => {
    const seen: Record<string, boolean>[] = []
    const { fetchImpl } = fakeX({
      graphql: (url) => {
        const features = JSON.parse(url.searchParams.get('features')!)
        seen.push(features)
        return 'brand_new_flag' in features
          ? json({ data: { tweetResult: { result: articleTweetGraphql } } })
          : json({ errors: [{ message: 'The following features cannot be null: brand_new_flag' }] }, { status: 400 })
      },
    })
    const result = await new XTweetFetcher({ fetchImpl, queryId: 'Q' }).fetchTweet(ARTICLE_TWEET_ID)
    expect(result.source).toBe('x-graphql')
    expect(seen).toHaveLength(2)
    expect(seen[1].brand_new_flag).toBe(false)
  })

  it('falls back to syndication when rate limited, then skips GraphQL', async () => {
    const { fetchImpl, calls } = fakeX({
      graphql: () => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) } }),
      syndication: (url) => {
        expect(url.searchParams.get('token')).toBe(syndicationToken(SYNDICATION_TWEET_ID))
        return json(syndicationTweet)
      },
    })
    const fetcher = new XTweetFetcher({ fetchImpl, queryId: 'Q' })
    const first = await fetcher.fetchTweet(SYNDICATION_TWEET_ID)
    expect(first.source).toBe('x-syndication')
    expect(first.errors).toEqual(['X GraphQL: rate limited by X'])

    calls.length = 0
    const second = await fetcher.fetchTweet(SYNDICATION_TWEET_ID)
    expect(second.source).toBe('x-syndication')
    expect(second.errors[0]).toMatch(/^X GraphQL skipped: rate limited until/)
    expect(calls.some((c) => c.includes('TweetResultByRestId'))).toBe(false)
  })

  it('can refresh via syndication first to spare the GraphQL rate limit', async () => {
    const { fetchImpl, calls } = fakeX({
      graphql: () => json({ data: { tweetResult: { result: articleTweetGraphql } } }),
      syndication: () => json(syndicationTweet),
    })
    const result = await new XTweetFetcher({ fetchImpl, queryId: 'Q' }).fetchTweet(SYNDICATION_TWEET_ID, { preferSyndication: true })
    expect(result.source).toBe('x-syndication')
    expect(calls.some((c) => c.includes('TweetResultByRestId'))).toBe(false)
  })

  it('falls back to GraphQL when syndication cannot see the post', async () => {
    const { fetchImpl } = fakeX({
      graphql: () => json({ data: { tweetResult: { result: articleTweetGraphql } } }),
      syndication: () => new Response(null, { status: 404 }),
    })
    const result = await new XTweetFetcher({ fetchImpl, queryId: 'Q' }).fetchTweet(ARTICLE_TWEET_ID, { preferSyndication: true })
    expect(result.source).toBe('x-graphql')
    expect(result.unavailable).toBe(false)
  })

  it('reports deleted posts as unavailable', async () => {
    const { fetchImpl } = fakeX({
      graphql: () => json({ data: { tweetResult: {} } }),
      syndication: () => new Response(null, { status: 404 }),
    })
    const result = await new XTweetFetcher({ fetchImpl, queryId: 'Q' }).fetchTweet('123')
    expect(result).toEqual({ snapshot: null, unavailable: true, errors: [] })
  })

  it('does not claim a post is gone when X is unreachable', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('network down') }
    const result = await new XTweetFetcher({ fetchImpl, queryId: 'Q' }).fetchTweet('123')
    expect(result.unavailable).toBe(false)
    expect(result.snapshot).toBeNull()
    expect(result.errors).toHaveLength(2)
  })
})

describe('parseMissingFeatures', () => {
  it('extracts feature names from X error messages', () => {
    expect(parseMissingFeatures({ errors: [{ message: 'The following features cannot be null: a_b, c_d' }] })).toEqual(['a_b', 'c_d'])
    expect(parseMissingFeatures({ errors: [{ message: 'Something else' }] })).toEqual([])
    expect(parseMissingFeatures(null)).toEqual([])
  })
})
