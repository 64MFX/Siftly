import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { ArchiveDocument } from '@/lib/archive-types'
import { XTweetFetcher, type FetchLike } from '@/lib/x-tweet-fetcher'
import {
  ARTICLE_TWEET_ID,
  NOTE_TWEET_ID,
  articleTweetGraphql,
  articleTweetTimelineOnly,
  flatExportRawJson,
  noteTweetGraphql,
} from './fixtures/x-tweets'

// buildArchive never touches the database; keep Prisma out of the test
vi.mock('@/lib/db', () => ({ default: {}, prisma: {} }))
const { buildArchive, deleteArchiveFolder, waitForRateLimitReset } = await import('@/lib/archiver')

interface FakeNet {
  fetchImpl: FetchLike
  requested: string[]
}

/** Fake X: GraphQL returns `tweet` (or a tombstone), media hosts return bytes unless `mediaDown` */
function fakeNet(options: { tweet?: unknown; gone?: boolean; mediaDown?: boolean }): FakeNet {
  const requested: string[] = []
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input)
    requested.push(input)
    if (url.pathname.endsWith('/guest/activate.json')) {
      return new Response(JSON.stringify({ guest_token: 'g' }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.includes('/TweetResultByRestId')) {
      const result = options.gone ? { __typename: 'TweetTombstone' } : options.tweet
      return new Response(JSON.stringify({ data: { tweetResult: result ? { result } : {} } }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.hostname === 'cdn.syndication.twimg.com') return new Response(null, { status: 404 })
    if (options.mediaDown) return new Response(null, { status: 404 })
    if (url.hostname === 'video.twimg.com') return new Response(`VIDEO:${url.pathname}`, { headers: { 'content-type': 'video/mp4' } })
    if (url.hostname === 'pbs.twimg.com' || url.hostname === 'unavatar.io') {
      const type = url.pathname.endsWith('.png') || url.searchParams.get('format') === 'png' ? 'image/png' : 'image/jpeg'
      return new Response(`IMAGE:${url.pathname}`, { headers: { 'content-type': type } })
    }
    return new Response(null, { status: 500 })
  }
  return { fetchImpl, requested }
}

function deps(root: string, net: FakeNet, online = true) {
  return {
    root,
    fetchImpl: net.fetchImpl,
    fetcher: online ? new XTweetFetcher({ fetchImpl: net.fetchImpl, queryId: 'Q' }) : null,
    now: new Date('2026-01-01T00:00:00Z'),
  }
}

const bookmarkFrom = (tweetId: string, rawJson: unknown, text = '') => ({
  tweetId,
  text,
  authorHandle: 'unknown',
  authorName: 'Unknown',
  tweetCreatedAt: null,
  rawJson: typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson),
})

describe('buildArchive', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'siftly-archive-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('saves a full X Article with every image and video in place', async () => {
    const net = fakeNet({ tweet: articleTweetGraphql })
    // At import time the Bookmarks timeline only gave us the teaser + cover as a MediaItem
    const result = await buildArchive(
      bookmarkFrom(ARTICLE_TWEET_ID, articleTweetTimelineOnly),
      [{ id: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/COVER1.jpg', thumbnailUrl: 'https://pbs.twimg.com/media/COVER1.jpg' }],
      deps(root, net),
    )

    expect(result.status).toBe('complete')
    expect(result.doc.warnings).toEqual([])
    expect(result.doc.sources).toEqual(['x-graphql', 'stored'])
    const article = result.doc.article!
    expect(article.complete).toBe(true)
    expect(article.coverImage?.file).toMatch(/^media\/photo-[0-9a-f]{12}\.jpg$/)

    const mediaBlocks = article.blocks.filter((b) => b.type === 'media')
    const [image, video] = mediaBlocks.flatMap((b) => (b.type === 'media' ? b.media : []))
    expect(image.file).toMatch(/^media\/photo-.*\.jpg$/)
    expect(video.file).toMatch(/^media\/video-.*\.mp4$/)
    expect(video.posterFile).toMatch(/^media\/poster-.*\.jpg$/)

    // Original resolution was requested, and the highest-bitrate MP4
    expect(net.requested).toContain('https://pbs.twimg.com/media/INLINE1?format=jpg&name=orig')
    expect(net.requested).toContain('https://video.twimg.com/amplify_video/333/vid/1280x720/high.mp4')

    const folder = path.join(root, ARTICLE_TWEET_ID)
    expect(await readFile(path.join(folder, video.file!), 'utf8')).toBe('VIDEO:/amplify_video/333/vid/1280x720/high.mp4')
    expect(result.doc.author).toMatchObject({ name: 'Ada Writer', handle: 'ada' })
    expect(result.doc.author.avatarFile).toMatch(/^media\/avatar-/)

    // The stored cover MediaItem now points at the local cover file
    expect(result.mediaUpdates).toEqual([{ id: 'm1', localPath: `${ARTICLE_TWEET_ID}/${article.coverImage!.file}`, localThumbnailPath: null }])
    expect(result.newMedia).toEqual([])

    // Offline page + markdown + raw source are written alongside
    const html = await readFile(path.join(folder, 'index.html'), 'utf8')
    expect(html.indexOf('<h1>How we built it</h1>')).toBeLessThan(html.indexOf(image.file!))
    expect(html.indexOf(image.file!)).toBeLessThan(html.indexOf(video.file!))
    expect(await readFile(path.join(folder, 'content.md'), 'utf8')).toContain('## How we built it')
    const saved = JSON.parse(await readFile(path.join(folder, 'archive.json'), 'utf8')) as ArchiveDocument
    expect(saved.article?.blocks.length).toBe(article.blocks.length)
    const source = JSON.parse(await readFile(path.join(folder, 'source.json'), 'utf8'))
    expect(source.remote.source).toBe('x-graphql')
    expect(source.stored.rest_id).toBe(ARTICLE_TWEET_ID)
  })

  it('saves tweet media, the quoted post and link card, and records new media rows', async () => {
    const net = fakeNet({ tweet: noteTweetGraphql.tweet })
    const result = await buildArchive(
      bookmarkFrom(NOTE_TWEET_ID, noteTweetGraphql),
      [{ id: 'v1', type: 'video', url: 'https://video.twimg.com/ext_tw_video/444/pu/vid/320x180/a.mp4', thumbnailUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/444/pu/img/thumb.jpg' }],
      deps(root, net),
    )

    expect(result.status).toBe('complete')
    // Stored GraphQL payload → syndication is tried first (404 here), then GraphQL
    const syndicationAt = net.requested.findIndex((u) => u.includes('cdn.syndication.twimg.com'))
    const graphqlAt = net.requested.findIndex((u) => u.includes('TweetResultByRestId'))
    expect(syndicationAt).toBeGreaterThanOrEqual(0)
    expect(syndicationAt).toBeLessThan(graphqlAt)
    expect(result.doc.text).toContain('Second paragraph')
    expect(result.doc.media.map((m) => [m.type, !!m.file])).toEqual([['photo', true], ['video', true], ['gif', true]])
    expect(result.doc.quote?.media[0].file).toMatch(/^media\/photo-.*\.png$/)
    expect(result.doc.card?.imageFile).toMatch(/^media\/card-/)

    // The existing low-bitrate video row is matched to the archived best rendition
    const video = result.doc.media[1]
    expect(result.mediaUpdates).toEqual([
      { id: 'v1', localPath: `${NOTE_TWEET_ID}/${video.file}`, localThumbnailPath: `${NOTE_TWEET_ID}/${video.posterFile}` },
    ])
    // Photo and GIF weren't in the database yet
    expect(result.newMedia.map((m) => m.type)).toEqual(['photo', 'gif'])
    expect(result.newMedia.every((m) => m.localPath?.startsWith(`${NOTE_TWEET_ID}/media/`))).toBe(true)
  })

  it('keeps everything when the post is later deleted from X', async () => {
    const first = await buildArchive(bookmarkFrom(NOTE_TWEET_ID, noteTweetGraphql), [], deps(root, fakeNet({ tweet: noteTweetGraphql.tweet })))
    const filesBefore = await readdir(path.join(root, NOTE_TWEET_ID, 'media'))

    // Re-archive: X says it's gone and every media URL now 404s
    const net = fakeNet({ gone: true, mediaDown: true })
    const second = await buildArchive(bookmarkFrom(NOTE_TWEET_ID, '{}'), [], deps(root, net))

    expect(second.doc.unavailableOnX).toBe(true)
    expect(second.status).toBe('complete')
    expect(second.doc.text).toBe(first.doc.text)
    expect(second.doc.quote?.text).toBe('Quoted text')
    expect(second.doc.media.map((m) => m.file)).toEqual(first.doc.media.map((m) => m.file))
    expect(second.doc.sources).toContain('previous-archive')
    expect(await readdir(path.join(root, NOTE_TWEET_ID, 'media'))).toEqual(filesBefore)
    // Existing files are reused rather than re-downloaded
    expect(net.requested.some((u) => u.includes('twimg.com/media/') || u.includes('video.twimg.com'))).toBe(false)
    expect(await readFile(path.join(root, NOTE_TWEET_ID, 'index.html'), 'utf8')).toContain('no longer available on X')
    // The last good copy from X is preserved in source.json
    const source = JSON.parse(await readFile(path.join(root, NOTE_TWEET_ID, 'source.json'), 'utf8'))
    expect(source.remote.source).toBe('x-graphql')
  })

  it('archives from stored data when X is unreachable and marks it partial', async () => {
    const offlineX: FetchLike = async (input) => {
      const url = new URL(input)
      if (url.hostname === 'pbs.twimg.com') return new Response('IMG', { headers: { 'content-type': 'image/jpeg' } })
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const result = await buildArchive(
      { ...bookmarkFrom('1400000000000000001', flatExportRawJson), text: 'From a flat export https://t.co/m1', authorHandle: 'erin', authorName: 'Erin' },
      [{ id: 'f1', type: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/666/pu/img/only-thumb.jpg', thumbnailUrl: null }],
      { root, fetchImpl: offlineX, fetcher: new XTweetFetcher({ fetchImpl: offlineX, queryId: 'Q' }) },
    )

    expect(result.status).toBe('partial')
    expect(result.doc.text).toBe('From a flat export https://t.co/m1')
    expect(result.doc.warnings.some((w) => w.startsWith("Couldn't fetch the latest version from X"))).toBe(true)
    // Only a thumbnail was ever known for this video: keep the poster, explain the gap
    expect(result.doc.warnings).toContain('Media 1: no downloadable video file is known')
    expect(result.doc.media[0].posterFile).toMatch(/^media\/poster-/)
    expect(result.mediaUpdates[0]).toMatchObject({ id: 'f1', localPath: null })
    expect(result.mediaUpdates[0].localThumbnailPath).toMatch(/\/media\/poster-/)
  })

  it('reports media that could not be saved in document order', async () => {
    const result = await buildArchive(
      bookmarkFrom(NOTE_TWEET_ID, noteTweetGraphql),
      [],
      deps(root, fakeNet({ tweet: noteTweetGraphql.tweet, mediaDown: true })),
    )
    expect(result.status).toBe('partial')
    expect(result.doc.warnings).toEqual([
      "Media 1: couldn't save image (HTTP 404)",
      "Media 2: couldn't save video (HTTP 404)",
      "Media 3: couldn't save GIF (HTTP 404)",
      "Quoted post media 1: couldn't save image (HTTP 404)",
      "Link preview image: couldn't save (HTTP 404)",
    ])
    expect(result.newMedia.every((m) => m.localPath === null)).toBe(true)
  })

  it('flags articles where X only returned the teaser', async () => {
    const result = await buildArchive(
      bookmarkFrom(ARTICLE_TWEET_ID, articleTweetTimelineOnly),
      [],
      deps(root, fakeNet({ tweet: articleTweetTimelineOnly })),
    )
    expect(result.status).toBe('partial')
    expect(result.doc.article?.previewText).toBe('A short teaser')
    // Not logged in: the warning says how to get the full text
    expect(result.doc.warnings).toContain(
      "Only the article's preview was saved: X only shows the full text to logged-in users. Log in to X in Settings → X Login, then retry.",
    )
  })

  it('never writes outside the archive root for odd tweet IDs', async () => {
    const net = fakeNet({})
    const result = await buildArchive(bookmarkFrom('../../escape', '{}', 'hi'), [], deps(root, net, false))
    expect(result.folder).not.toContain('..')
    expect((await stat(path.join(root, result.folder, 'archive.json'))).isFile()).toBe(true)
    expect(result.doc.text).toBe('hi')
  })
})

describe('deleteArchiveFolder', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'siftly-archive-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it("removes only that tweet's folder", async () => {
    const net = fakeNet({})
    await buildArchive(bookmarkFrom('111', '{}', 'one'), [], deps(root, net, false))
    await buildArchive(bookmarkFrom('222', '{}', 'two'), [], deps(root, net, false))

    expect(await deleteArchiveFolder('111', root)).toBe(true)
    expect(await readdir(root)).toEqual(['222'])
    expect(await deleteArchiveFolder('111', root)).toBe(false)
  })

  it('stays inside the archive root for odd tweet IDs', async () => {
    const net = fakeNet({})
    const result = await buildArchive(bookmarkFrom('../../escape', '{}', 'hi'), [], deps(root, net, false))
    expect(await deleteArchiveFolder('../../escape', root)).toBe(true)
    expect(await readdir(root)).not.toContain(result.folder)
    expect((await stat(root)).isDirectory()).toBe(true)
  })
})

describe('X Articles and the X login', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'siftly-archive-')) })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  /**
   * GraphQL answers for the article come from `graphql` in order (the last one
   * repeats); syndication never has the post. `calls` only lists requests for
   * the article itself, not for the post embedded in it.
   */
  function articleNet(graphql: ((loggedIn: boolean) => Response)[]) {
    const calls: { loggedIn: boolean }[] = []
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.pathname.endsWith('/guest/activate.json')) return new Response(JSON.stringify({ guest_token: 'g' }))
      if (url.pathname.includes('/TweetResultByRestId')) {
        const { tweetId } = JSON.parse(url.searchParams.get('variables')!) as { tweetId: string }
        if (tweetId !== ARTICLE_TWEET_ID) return new Response(JSON.stringify({ data: { tweetResult: {} } }))
        const loggedIn = !!headers.Cookie
        calls.push({ loggedIn })
        return graphql[Math.min(calls.length - 1, graphql.length - 1)](loggedIn)
      }
      if (url.hostname === 'cdn.syndication.twimg.com') return new Response(null, { status: 404 })
      if (url.hostname === 'video.twimg.com') return new Response('VIDEO', { headers: { 'content-type': 'video/mp4' } })
      return new Response('IMAGE', { headers: { 'content-type': 'image/jpeg' } })
    }
    return { fetchImpl, calls }
  }
  const tweetResponse = (result: unknown) => new Response(JSON.stringify({ data: { tweetResult: { result } } }))
  const rateLimited = () =>
    new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) } })
  const loggedInFetcher = (fetchImpl: FetchLike, onSessionRejected?: () => void) =>
    new XTweetFetcher({ fetchImpl, queryId: 'Q', credentials: { authToken: 'tok', ct0: 'csrf' }, onSessionRejected })

  it('waits out X\'s rate limit when logged in, then saves the full article', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const net = articleNet([rateLimited, () => tweetResponse(articleTweetGraphql)])
    const waited: number[] = []
    const result = await buildArchive(bookmarkFrom(ARTICLE_TWEET_ID, articleTweetTimelineOnly), [], {
      root,
      fetchImpl: net.fetchImpl,
      fetcher: loggedInFetcher(net.fetchImpl),
      waitForRateLimit: async (until) => {
        waited.push(until)
        vi.setSystemTime(until + 1000) // as if the job slept until the reset
        return true
      },
    })

    expect(waited).toEqual([Date.parse('2026-01-01T12:10:00Z')])
    expect(net.calls).toEqual([{ loggedIn: true }, { loggedIn: true }])
    expect(result.status).toBe('complete')
    expect(result.doc.article?.complete).toBe(true)
    expect(result.doc.warnings).toEqual([])
  })

  it('says when to retry when a one-off archive hits the rate limit', async () => {
    const net = articleNet([rateLimited])
    const result = await buildArchive(bookmarkFrom(ARTICLE_TWEET_ID, articleTweetTimelineOnly), [], {
      root,
      fetchImpl: net.fetchImpl,
      fetcher: loggedInFetcher(net.fetchImpl),
    })
    expect(result.status).toBe('partial')
    expect(net.calls).toHaveLength(1)
    expect(result.doc.warnings.some((w) => /^Only the article's preview was saved: X's rate limit was reached\. Retry after /.test(w))).toBe(true)
  })

  it('records that X rejected the saved login and says to log in again', async () => {
    const net = articleNet([(loggedIn) => (loggedIn ? new Response(null, { status: 401 }) : tweetResponse(articleTweetTimelineOnly))])
    const onSessionRejected = vi.fn()
    const result = await buildArchive(bookmarkFrom(ARTICLE_TWEET_ID, articleTweetTimelineOnly), [], {
      root,
      fetchImpl: net.fetchImpl,
      fetcher: loggedInFetcher(net.fetchImpl, onSessionRejected),
    })
    expect(onSessionRejected).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('partial')
    expect(result.doc.warnings).toContain(
      "Only the article's preview was saved: X rejected your saved login. Log in to X again in Settings → X Login, then retry.",
    )
  })

  it('fetches the article body from GraphQL even when the stored copy looked complete', async () => {
    // Stored as a flat export (no article data) → syndication first; it has nothing, so GraphQL is asked
    const net = articleNet([() => tweetResponse(articleTweetGraphql)])
    const result = await buildArchive(bookmarkFrom(ARTICLE_TWEET_ID, flatExportRawJson), [], {
      root,
      fetchImpl: net.fetchImpl,
      fetcher: loggedInFetcher(net.fetchImpl),
    })
    expect(result.doc.article?.complete).toBe(true)
    expect(net.calls).toEqual([{ loggedIn: true }])
  })
})

describe('waitForRateLimitReset', () => {
  it("doesn't wait for a reset that is too far away", async () => {
    expect(await waitForRateLimitReset(Date.now() + 60 * 60_000, () => false)).toBe(false)
  })

  it('resumes a second after the reset, or stops early', async () => {
    const started = Date.now()
    expect(await waitForRateLimitReset(Date.now() - 900, () => false)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(await waitForRateLimitReset(Date.now() + 5000, () => true)).toBe(false)
  })
})
