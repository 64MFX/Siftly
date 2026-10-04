import { describe, it, expect, vi } from 'vitest'
import {
  fetchLinkCard,
  fetchPagePreview,
  isPrivateUrl,
  isXUrl,
  linkCardFromArchived,
  linkCardFromSnapshot,
  linkContext,
  parseLinkCard,
  postLink,
  tcoDestination,
} from '@/lib/link-card'
import { snapshotFromGraphql, snapshotFromStoredRaw } from '@/lib/tweet-snapshot'
import type { FetchLike } from '@/lib/x-tweet-fetcher'
import { ARTICLE_TWEET_ID, articleTweetGraphql, LINK_TWEET_ID, linkOnlyTweetSyndication, NOTE_TWEET_ID, noteTweetGraphql } from './fixtures/x-tweets'

const TCO = 'https://t.co/kz411EKFNI'
const GITHUB = 'https://github.com/liustack/modlens'

/** What t.co sends a browser: a 200 page that redirects by script */
const tcoPage = (destination: string) =>
  `<head><noscript><META http-equiv="refresh" content="0;URL=${destination}"></noscript><title>${destination}</title></head><script>window.opener = null; location.replace("${destination}")</script>`

const githubPage = `<!DOCTYPE html><html><head>
  <title>GitHub - liustack/modlens</title>
  <meta property="og:site_name" content="GitHub">
  <meta property="og:title" content="GitHub - liustack/modlens: Plug-in vision for text-only LLMs">
  <meta content="Don't paste screenshots &amp; hope — get JSON evidence" property="og:description">
  <meta property="og:image" content="/opengraph/modlens.png">
</head><body>…</body></html>`

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

/** A fake network: routes by URL prefix; anything else is a 404 */
function fakeWeb(routes: Record<string, () => Response>) {
  const calls: string[] = []
  const fetchImpl: FetchLike = vi.fn(async (input: string) => {
    calls.push(input)
    const match = Object.keys(routes).find((prefix) => input.startsWith(prefix))
    return match ? routes[match]() : new Response('not found', { status: 404 })
  })
  return { fetchImpl, calls }
}

const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result'

describe('building cards', () => {
  it("takes X's link card from a stored post, with the real link", () => {
    const card = linkCardFromSnapshot(snapshotFromStoredRaw(JSON.stringify(noteTweetGraphql), NOTE_TWEET_ID))
    expect(card).toEqual({
      url: 'https://github.com/foo/bar',
      title: 'foo/bar on GitHub',
      description: 'A repository',
      domain: 'github.com',
      imageUrl: 'https://pbs.twimg.com/card_img/1/abc?format=jpg&name=orig',
    })
  })

  it('points at the archived image when the card came from the archive', () => {
    const card = linkCardFromArchived(
      { url: GITHUB, title: 'modlens', imageUrl: 'https://pbs.twimg.com/card_img/9/x', imageFile: 'media/card-1.jpg' },
      LINK_TWEET_ID,
    )
    expect(card).toEqual({
      url: GITHUB,
      title: 'modlens',
      domain: 'github.com',
      imageUrl: 'https://pbs.twimg.com/card_img/9/x',
      imagePath: `${LINK_TWEET_ID}/media/card-1.jpg`,
    })
  })

  it('shows an X Article as its title, teaser and cover', () => {
    const card = linkCardFromSnapshot(snapshotFromGraphql(articleTweetGraphql, ARTICLE_TWEET_ID))
    expect(card).toMatchObject({ title: 'How we built it', domain: 'x.com' })
    expect(card?.url).toMatch(/^https:\/\/x\.com\/i\/article\//)
  })

  it('has no card for a post without one', () => {
    expect(linkCardFromSnapshot({ tweetId: '1', text: 'hi', media: [] })).toBeNull()
    expect(linkCardFromSnapshot(null)).toBeNull()
  })

  it('reads saved cards and rejects broken or unsafe ones', () => {
    const saved = { url: GITHUB, title: 'modlens', description: 'modlens', imageUrl: 'javascript:alert(1)', imagePath: 'x/media/a.jpg' }
    // A description that repeats the title and a non-http image are dropped
    expect(parseLinkCard(JSON.stringify(saved))).toEqual({ url: GITHUB, title: 'modlens', domain: 'github.com', imagePath: 'x/media/a.jpg' })
    expect(parseLinkCard(JSON.stringify({ url: 'javascript:alert(1)', title: 'x' }))).toBeNull()
    expect(parseLinkCard(JSON.stringify({ url: GITHUB, title: '  ' }))).toBeNull()
    expect(parseLinkCard('{oops')).toBeNull()
    expect(parseLinkCard(null)).toBeNull()
  })

  it('turns a card into short prompt context', () => {
    const context = linkContext({ url: GITHUB, title: 'T', description: 'd'.repeat(500), domain: 'github.com' })
    expect(context).toEqual({ title: 'T', description: 'd'.repeat(300), site: 'github.com', url: GITHUB })
  })
})

describe('link helpers', () => {
  it("finds the post's link: its last t.co link", () => {
    expect(postLink(`look ${TCO}`)).toBe(TCO)
    expect(postLink('first https://t.co/aaa then https://t.co/bbb…')).toBe('https://t.co/bbb')
    expect(postLink('no links here https://example.com')).toBeNull()
  })

  it("reads t.co's script redirect", () => {
    expect(tcoDestination(tcoPage(GITHUB))).toBe(GITHUB)
    expect(tcoDestination('<meta http-equiv="refresh" content="0;URL=https://a.example/?x=1&amp;y=2">')).toBe('https://a.example/?x=1&y=2')
    expect(tcoDestination('<title>Some page</title>')).toBeNull()
  })

  it('knows X pages and private addresses', () => {
    expect(isXUrl('https://x.com/a/status/1')).toBe(true)
    expect(isXUrl('https://mobile.twitter.com/a')).toBe(true)
    expect(isXUrl('https://notx.com/a')).toBe(false)
    expect(isPrivateUrl('http://127.0.0.1:28417/api')).toBe(true)
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true)
    expect(isPrivateUrl(GITHUB)).toBe(false)
  })
})

describe('fetchPagePreview', () => {
  it('follows t.co to the page and reads its Open Graph tags', async () => {
    const { fetchImpl, calls } = fakeWeb({ [TCO]: () => html(tcoPage(GITHUB)), [GITHUB]: () => html(githubPage) })
    const page = await fetchPagePreview(TCO, fetchImpl)
    expect(calls).toEqual([TCO, GITHUB])
    expect(page).toEqual({
      url: GITHUB,
      title: 'GitHub - liustack/modlens: Plug-in vision for text-only LLMs',
      description: "Don't paste screenshots & hope — get JSON evidence",
      image: 'https://github.com/opengraph/modlens.png',
      siteName: 'GitHub',
      domain: 'github.com',
    })
  })

  it('keeps the destination when its page fails to load', async () => {
    const { fetchImpl } = fakeWeb({ [TCO]: () => html(tcoPage(GITHUB)) })
    expect(await fetchPagePreview(TCO, fetchImpl)).toMatchObject({ url: GITHUB, title: '', domain: 'github.com' })
  })

  it("won't follow t.co into the private network", async () => {
    const { fetchImpl, calls } = fakeWeb({ [TCO]: () => html(tcoPage('http://192.168.1.1/admin')) })
    const page = await fetchPagePreview(TCO, fetchImpl)
    expect(calls).toEqual([TCO])
    expect(page.url).toBe(TCO)
    await expect(fetchPagePreview('http://localhost:28417/', fetchImpl)).rejects.toThrow('Invalid URL')
  })

  it('falls back to the <title> tag', async () => {
    const { fetchImpl } = fakeWeb({ 'https://plain.example/': () => html('<head><title>Plain &amp; simple</title></head>') })
    expect(await fetchPagePreview('https://plain.example/', fetchImpl)).toMatchObject({ title: 'Plain & simple', image: '' })
  })
})

describe('fetchLinkCard', () => {
  it("uses X's own card for the post first", async () => {
    const { fetchImpl, calls } = fakeWeb({ [SYNDICATION]: () => json(linkOnlyTweetSyndication) })
    const result = await fetchLinkCard(LINK_TWEET_ID, TCO, fetchImpl)
    expect(result.card).toEqual({
      url: GITHUB,
      title: 'GitHub - liustack/modlens: The first vision plugin for DeepSeek Harness',
      description: 'Plug-in vision for text-only LLMs. Paste an image, get structured JSON evidence.',
      domain: 'github.com',
      imageUrl: 'https://pbs.twimg.com/card_img/9/modlens?format=jpg&name=orig',
    })
    expect(result.url).toBe(GITHUB)
    expect(calls).toHaveLength(1)
  })

  it("reads the linked page when X has no card", async () => {
    const { fetchImpl } = fakeWeb({
      [SYNDICATION]: () => json({}),
      [TCO]: () => html(tcoPage(GITHUB)),
      [GITHUB]: () => html(githubPage),
    })
    const result = await fetchLinkCard(LINK_TWEET_ID, TCO, fetchImpl)
    expect(result.card).toMatchObject({ url: GITHUB, title: 'GitHub - liustack/modlens: Plug-in vision for text-only LLMs', domain: 'github.com' })
  })

  it("makes no card from a page on X, but says where the link goes", async () => {
    const status = 'https://x.com/carol/status/1600000000000000001'
    const { fetchImpl } = fakeWeb({
      [SYNDICATION]: () => json({ __typename: 'Tweet', id_str: LINK_TWEET_ID, text: TCO }),
      [TCO]: () => html(tcoPage(status)),
      [status]: () => html('<head><meta property="og:title" content="X"></head>'),
    })
    expect(await fetchLinkCard(LINK_TWEET_ID, TCO, fetchImpl)).toEqual({ card: null, url: status })
  })

  it('never throws when nothing answers', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => { throw new Error('offline') })
    expect(await fetchLinkCard(LINK_TWEET_ID, TCO, fetchImpl)).toEqual({ card: null, url: null })
    expect(await fetchLinkCard('not-a-tweet-id', null, fetchImpl)).toEqual({ card: null, url: null })
  })
})
