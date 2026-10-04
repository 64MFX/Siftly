import { describe, it, expect, beforeEach } from 'vitest'
import {
  BOOKMARKS_FALLBACK_QUERY_ID,
  XBookmarksClient,
  XBookmarksError,
  chunkScriptUrls,
  findBookmarksQueryId,
  parseBookmarksPage,
  resetBookmarksQueryIdCache,
} from '@/lib/x-bookmarks-api'
import type { FetchLike } from '@/lib/x-tweet-fetcher'
import { importedTweetFromGraphql, slimGraphqlTweet } from '@/lib/x-tweet-import'
import { bookmarksResponse, cursorEntry, graphqlTweet, tombstone, tweetEntry } from './fixtures/x-bookmarks'

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

const credentials = { authToken: 'tok', ct0: 'csrf' }
const noSleep = async () => {}

interface SeenRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

/** Records every request; `handler` answers the Bookmarks ones */
function fakeX(handler: (req: SeenRequest) => Response | Promise<Response>, other: (url: URL) => Response = () => new Response(null, { status: 404 })) {
  const requests: SeenRequest[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input)
    if (!url.pathname.endsWith('/Bookmarks')) return other(url)
    const req: SeenRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    requests.push(req)
    return handler(req)
  }
  return { fetchImpl, requests }
}

/** The request's GraphQL variables, whether sent as GET or POST */
function variablesOf(req: SeenRequest): Record<string, unknown> {
  if (req.body) return req.body.variables as Record<string, unknown>
  return JSON.parse(req.url.searchParams.get('variables')!)
}

beforeEach(() => resetBookmarksQueryIdCache())

describe('parseBookmarksPage', () => {
  it('reads posts in order, the bottom cursor, and unwraps visibility results', () => {
    const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: graphqlTweet('3') }
    const page = parseBookmarksPage(bookmarksResponse([tweetEntry('1'), tweetEntry('2'), tweetEntry('3', wrapped)], 'next-1'))
    expect(page?.entries.map((e) => e.tweetId)).toEqual(['1', '2', '3'])
    expect(page?.entries[2].tweet?.rest_id).toBe('3')
    expect(page?.nextCursor).toBe('next-1')
    expect(page?.end).toBe(false)
  })

  it('keeps placeholders for posts X no longer shows, without their content', () => {
    const page = parseBookmarksPage(bookmarksResponse([tweetEntry('7', tombstone()), tweetEntry('8')], 'n'))
    expect(page?.entries).toHaveLength(2)
    expect(page?.entries[0]).toEqual({ tweetId: '7', tweet: null })
    expect(page?.entries[1].tweet).not.toBeNull()
  })

  it('handles replaced cursors, the end marker and other timeline keys', () => {
    const body = {
      data: {
        bookmark_timeline: {
          timeline: {
            instructions: [
              { type: 'TimelineAddEntries', entries: [tweetEntry('1'), cursorEntry('Bottom', 'old')] },
              { type: 'TimelineReplaceEntry', entry_id_to_replace: 'cursor-bottom-old', entry: cursorEntry('Bottom', 'new') },
              { type: 'TimelineTerminateTimeline', direction: 'Bottom' },
            ],
          },
        },
      },
    }
    const page = parseBookmarksPage(body)
    expect(page).toEqual({ entries: [{ tweetId: '1', tweet: expect.any(Object) }], nextCursor: 'new', end: true })
  })

  it('returns null for answers that are not a bookmark list', () => {
    expect(parseBookmarksPage({ errors: [{ message: 'nope' }] })).toBeNull()
    expect(parseBookmarksPage({ data: { user: {} } })).toBeNull()
    expect(parseBookmarksPage(null)).toBeNull()
  })

  it('reads an empty page (the end of the list)', () => {
    expect(parseBookmarksPage(bookmarksResponse([], 'n'))).toEqual({ entries: [], nextCursor: 'n', end: false })
  })
})

describe('importedTweetFromGraphql', () => {
  it('reads the author from user.core (2026) and from user.legacy (before)', () => {
    const now = importedTweetFromGraphql(graphqlTweet('1', { handle: 'ada', name: 'Ada' }))
    const before = importedTweetFromGraphql(graphqlTweet('2', { handle: 'bob', name: 'Bob', legacyUser: true }))
    expect(now).toMatchObject({ tweetId: '1', authorHandle: 'ada', authorName: 'Ada' })
    expect(before).toMatchObject({ tweetId: '2', authorHandle: 'bob', authorName: 'Bob' })
  })

  it('keeps the full text of long posts, decoded, with media and dates', () => {
    const tweet = importedTweetFromGraphql(graphqlTweet('3', { note: 'A very long post &amp; then some', photo: true }))
    expect(tweet?.text).toBe('A very long post & then some')
    expect(tweet?.media).toEqual([{ type: 'photo', url: 'https://pbs.twimg.com/media/3.jpg', thumbnailUrl: 'https://pbs.twimg.com/media/3.jpg' }])
    expect(tweet?.tweetCreatedAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z')
    expect(tweet?.hashtags).toEqual(['ai'])
    expect(tweet?.urls).toEqual(['https://example.com/3'])
  })

  it('stores the tweet without the bulky parts nothing reads', () => {
    const tweet = importedTweetFromGraphql(graphqlTweet('4'))!
    const stored = JSON.parse(tweet.rawJson)
    expect(stored.views).toBeUndefined()
    expect(stored.edit_control).toBeUndefined()
    expect(stored.legacy.entities.urls).toHaveLength(1)
    const user = stored.core.user_results.result
    expect(user.core).toEqual({ name: 'User 4', screen_name: 'user4', created_at: expect.any(String) })
    expect(user.avatar.image_url).toContain('/profile_images/4/')
    expect(user.legacy).toEqual({})
    expect(tweet.rawJson.length).toBeLessThan(JSON.stringify(graphqlTweet('4')).length)
  })

  it('slims quoted posts too and skips placeholders', () => {
    const quoting = { ...graphqlTweet('5'), quoted_status_result: { result: graphqlTweet('6') } }
    const slim = slimGraphqlTweet(quoting)!
    expect(((slim.quoted_status_result as { result: Record<string, unknown> }).result).views).toBeUndefined()
    expect(importedTweetFromGraphql(tombstone())).toBeNull()
  })
})

describe('XBookmarksClient', () => {
  it('asks for bookmarks the way x.com does', async () => {
    const { fetchImpl, requests } = fakeX(() => json(bookmarksResponse([tweetEntry('1')], 'c1')))
    const client = new XBookmarksClient({ credentials, fetchImpl, discover: false })
    const page = await client.fetchPage()
    await client.fetchPage('c1')

    expect(page.entries.map((e) => e.tweetId)).toEqual(['1'])
    const [first, second] = requests
    expect(first.method).toBe('GET')
    expect(first.url.pathname).toBe(`/i/api/graphql/${BOOKMARKS_FALLBACK_QUERY_ID}/Bookmarks`)
    expect(variablesOf(first)).toEqual({ count: 100, includePromotedContent: false })
    expect(variablesOf(second)).toEqual({ count: 100, includePromotedContent: false, cursor: 'c1' })
    expect(JSON.parse(first.url.searchParams.get('features')!)).toMatchObject({ longform_notetweets_consumption_enabled: true })
    expect(JSON.parse(first.url.searchParams.get('fieldToggles')!)).toMatchObject({ withArticleRichContentState: true })
    expect(first.headers.Cookie).toBe('auth_token=tok; ct0=csrf')
    expect(first.headers['X-Csrf-Token']).toBe('csrf')
    expect(first.headers.Authorization).toMatch(/^Bearer /)
    expect(client.queryId).toBe(BOOKMARKS_FALLBACK_QUERY_ID)
  })

  it('switches to POST when X answers GET with an empty 404', async () => {
    const { fetchImpl, requests } = fakeX((req) =>
      req.method === 'GET' ? new Response(null, { status: 404 }) : json(bookmarksResponse([tweetEntry('1')], 'c1')),
    )
    const client = new XBookmarksClient({ credentials, fetchImpl, discover: false })
    await client.fetchPage()
    await client.fetchPage('c1')
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST', 'POST'])
    expect(requests[1].body).toMatchObject({ queryId: BOOKMARKS_FALLBACK_QUERY_ID, variables: { count: 100 }, fieldToggles: expect.any(Object) })
    expect(requests[2].body?.variables).toMatchObject({ cursor: 'c1' })
  })

  it('adds feature flags X newly requires', async () => {
    const { fetchImpl, requests } = fakeX((req) => {
      const features = JSON.parse(req.url.searchParams.get('features')!)
      return 'brand_new_flag' in features
        ? json(bookmarksResponse([], null))
        : json({ errors: [{ message: 'The following features cannot be null: brand_new_flag' }] }, { status: 400 })
    })
    await new XBookmarksClient({ credentials, fetchImpl, discover: false }).fetchPage()
    expect(requests).toHaveLength(2)
    expect(JSON.parse(requests[1].url.searchParams.get('features')!).brand_new_flag).toBe(false)
  })

  it('waits for the rate limit to reset, then carries on', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60
    let calls = 0
    const { fetchImpl } = fakeX(() =>
      ++calls === 1
        ? new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } })
        : json(bookmarksResponse([tweetEntry('1')], 'c1')),
    )
    const waited: number[] = []
    const client = new XBookmarksClient({ credentials, fetchImpl, discover: false, onRateLimit: async (until) => (waited.push(until), true) })
    const page = await client.fetchPage()
    expect(waited).toEqual([reset * 1000])
    expect(page.entries).toHaveLength(1)
  })

  it('gives up on the rate limit when told to', async () => {
    const { fetchImpl } = fakeX(() => new Response(null, { status: 429 }))
    const client = new XBookmarksClient({ credentials, fetchImpl, discover: false, onRateLimit: async () => false })
    await expect(client.fetchPage()).rejects.toMatchObject({ kind: 'rate-limit' })
  })

  it('reports a rejected login', async () => {
    const { fetchImpl } = fakeX(() => json({ errors: [{ code: 32, message: 'Could not authenticate you.' }] }, { status: 401 }))
    const err = await new XBookmarksClient({ credentials, fetchImpl, discover: false }).fetchPage().catch((e) => e)
    expect(err).toBeInstanceOf(XBookmarksError)
    expect(err.kind).toBe('auth')
  })

  it("doesn't blame the login for a bare 403 from a proxy", async () => {
    const { fetchImpl } = fakeX(() => new Response('<html>blocked</html>', { status: 403 }))
    await expect(new XBookmarksClient({ credentials, fetchImpl, discover: false }).fetchPage()).rejects.toMatchObject({ kind: 'http', status: 403 })
  })

  it('moves on from a retired query ID to the next one it knows', async () => {
    const { fetchImpl, requests } = fakeX((req) =>
      req.url.pathname.includes('/OLD/') ? new Response(null, { status: 404 }) : json(bookmarksResponse([tweetEntry('1')], 'c1')),
    )
    const client = new XBookmarksClient({ credentials, fetchImpl, discover: false, queryIds: ['OLD'] })
    await client.fetchPage()
    expect(requests.map((r) => `${r.method} ${r.url.pathname.split('/')[4]}`)).toEqual([
      'GET OLD',
      'POST OLD',
      `GET ${BOOKMARKS_FALLBACK_QUERY_ID}`,
    ])
    expect(client.queryId).toBe(BOOKMARKS_FALLBACK_QUERY_ID)
  })

  it("looks up the current query ID in x.com's scripts when none it knows works", async () => {
    const html = `<html><head>
      <link rel="preload" as="script" href="https://abs.twimg.com/responsive-web/client-web/vendor.aaa111.js" />
      <script src="https://abs.twimg.com/responsive-web/client-web/main.bbb222.js"></script>
      <script>window.__SCRIPTS_LOADED__={};!function(){var e=function(e){return"https://abs.twimg.com/responsive-web/client-web/"+({12:"ondemand.s",345:"bundle.Bookmarks",678:"bundle.Explore"}[e]||e)+"."+{12:"0a1b2c3d4e5f6a7b",345:"7ac84c434b2fdd30",678:"ffff"}[e]+"a.js"}}()</script>
      </head></html>`
    const scripts: string[] = []
    const other = (url: URL) => {
      if (url.href === 'https://x.com/home') return new Response(html)
      scripts.push(url.href)
      if (url.href.endsWith('bundle.Bookmarks.7ac84c434b2fdd30a.js')) {
        return new Response('e.exports={queryId:"NEW_ID-1",operationName:"Bookmarks",operationType:"query",metadata:{}}')
      }
      return new Response('nothing here')
    }
    const { fetchImpl, requests } = fakeX(
      (req) => (req.url.pathname.includes('/NEW_ID-1/') ? json(bookmarksResponse([tweetEntry('1')], 'c1')) : new Response(null, { status: 404 })),
      other,
    )
    const client = new XBookmarksClient({ credentials, fetchImpl })
    const page = await client.fetchPage()
    expect(page.entries).toHaveLength(1)
    expect(client.queryId).toBe('NEW_ID-1')
    expect(scripts).toEqual(['https://abs.twimg.com/responsive-web/client-web/bundle.Bookmarks.7ac84c434b2fdd30a.js'])
    expect(requests.at(-1)?.method).toBe('GET')
  })

  it('says X refused the request when no query ID works', async () => {
    const { fetchImpl } = fakeX(
      () => new Response(null, { status: 404 }),
      () => new Response('down', { status: 503 }),
    )
    await expect(new XBookmarksClient({ credentials, fetchImpl }).fetchPage()).rejects.toMatchObject({ kind: 'rejected', status: 404 })
  })

  it('retries network errors and 5xx a couple of times', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      if (calls === 2) return new Response(null, { status: 503 })
      return json(bookmarksResponse([tweetEntry('1')], 'c1'))
    }
    const page = await new XBookmarksClient({ credentials, fetchImpl, discover: false, sleep: noSleep }).fetchPage()
    expect(page.entries).toHaveLength(1)
    expect(calls).toBe(3)
  })
})

describe('query ID discovery helpers', () => {
  it('finds the Bookmarks query ID in a script', () => {
    expect(findBookmarksQueryId('{queryId:"abc-_1",operationName:"Bookmarks",operationType:"query"}')).toBe('abc-_1')
    expect(findBookmarksQueryId('{queryId: "zz", operationName: "Bookmarks"}')).toBe('zz')
    expect(findBookmarksQueryId('{queryId:"abc",operationName:"BookmarkFolderTimeline"}')).toBeNull()
  })

  it('builds lazily loaded chunk URLs from the webpack runtime maps', () => {
    const runtime = '({1:"ondemand.s","22":"shared~bundle.BookmarkFolders~bundle.Bookmarks",3:"bundle.Home"}[e]||e)+"."+{1:"aa",22:"bb",3:"cc"}[e]+"a.js"'
    expect(chunkScriptUrls(runtime, /Bookmarks/)).toEqual([
      'https://abs.twimg.com/responsive-web/client-web/shared~bundle.BookmarkFolders~bundle.Bookmarks.bba.js',
    ])
  })
})
