/**
 * Link cards: the title, description, site and image of the page a post links
 * to — what X shows under a post with a link. Bookmark cards display them and
 * the AI categorizer reads them, so a post that is nothing but a t.co link is
 * still filed by what it points at.
 *
 * Where a card comes from, best first (lib/link-card-store.ts saves it in
 * Bookmark.linkCard):
 *   1. the local archive — X's card, with its image saved locally
 *   2. the JSON stored at import (X GraphQL / syndication payloads carry X's card)
 *   3. X's syndication API for the post, then the linked page's Open Graph tags
 *
 * No database access here; network calls take an injectable fetch.
 */
import type { ArchivedArticle, ArchivedLinkCard } from '@/lib/archive-types'
import type { LinkCard } from '@/lib/types'
import { decodeHtmlEntities, type TweetSnapshot } from '@/lib/tweet-snapshot'
import { fetchSyndicationTweet, type FetchLike } from '@/lib/x-tweet-fetcher'

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

// ── Building cards ───────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined
  } catch {
    return undefined
  }
}

/** Pages on X itself (x.com, twitter.com and their subdomains) */
export function isXUrl(url: string): boolean {
  return /(^|\.)(x|twitter)\.com$/i.test(domainOf(url) ?? '')
}

/** A card from loose fields: null without an http(s) URL and a title; empty fields dropped */
function makeCard(fields: Partial<Record<keyof LinkCard, unknown>>): LinkCard | null {
  const url = nonEmpty(fields.url)
  const title = nonEmpty(fields.title)
  if (!url || !title || !isHttpUrl(url)) return null
  const card: LinkCard = { url, title }
  const description = nonEmpty(fields.description)
  if (description && description !== title) card.description = description
  const domain = nonEmpty(fields.domain) ?? domainOf(url)
  if (domain) card.domain = domain
  const imageUrl = nonEmpty(fields.imageUrl)
  if (imageUrl && isHttpUrl(imageUrl)) card.imageUrl = imageUrl
  const imagePath = nonEmpty(fields.imagePath)
  if (imagePath) card.imagePath = imagePath
  return card
}

/** Bookmark.linkCard → LinkCard, or null when empty or unreadable */
export function parseLinkCard(raw: string | null | undefined): LinkCard | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' ? makeCard(value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** X's link card for a post. `folder` is the post's archive folder when the card came from its archive */
export function linkCardFromArchived(card: ArchivedLinkCard, folder?: string): LinkCard | null {
  return makeCard({
    url: card.url,
    title: card.title,
    description: card.description,
    domain: card.domain,
    imageUrl: card.imageUrl,
    imagePath: folder && card.imageFile ? `${folder}/${card.imageFile}` : undefined,
  })
}

/** An X Article as a card: its title, teaser and cover */
export function linkCardFromArticle(article: ArchivedArticle, tweetId: string, folder?: string): LinkCard | null {
  const cover = article.coverImage
  const coverFile = cover?.type === 'photo' ? cover.file : cover?.posterFile
  return makeCard({
    url: `https://x.com/i/article/${article.id || tweetId}`,
    title: article.title,
    description: article.previewText,
    domain: 'x.com',
    imageUrl: cover?.type === 'photo' ? cover.url : cover?.posterUrl,
    imagePath: folder && coverFile ? `${folder}/${coverFile}` : undefined,
  })
}

/** The card a post shows under its text: X's link card, or the X Article it is */
export function linkCardFromSnapshot(snapshot: TweetSnapshot | null | undefined, folder?: string): LinkCard | null {
  if (!snapshot) return null
  const card = snapshot.card ? linkCardFromArchived(snapshot.card, folder) : null
  if (card) return card
  return snapshot.article ? linkCardFromArticle(snapshot.article, snapshot.tweetId, folder) : null
}

/** A card as AI prompt context: what the linked page is, in a few hundred characters */
export function linkContext(card: LinkCard): Record<string, string> {
  return {
    title: card.title.slice(0, 200),
    ...(card.description ? { description: card.description.slice(0, 300) } : {}),
    site: card.domain ?? domainOf(card.url) ?? '',
    url: card.url.slice(0, 200),
  }
}

const TCO_LINK = /https?:\/\/t\.co\/[A-Za-z0-9]+/g

/** The link a post's card is for: its last t.co link (X puts the card's link last) */
export function postLink(text: string): string | null {
  const links = text.match(TCO_LINK)
  return links ? links[links.length - 1] : null
}

// ── Network ──────────────────────────────────────────────────────────────────

/** Block requests to private/loopback addresses to prevent SSRF */
export function isPrivateUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    // IPv4 private ranges
    if (/^127\./.test(hostname)) return true
    if (/^10\./.test(hostname)) return true
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true
    if (/^192\.168\./.test(hostname)) return true
    if (/^169\.254\./.test(hostname)) return true // link-local
    // IPv6 loopback / ULA
    if (hostname === '::1' || /^\[::1\]$/.test(hostname)) return true
    if (/^\[?fd[0-9a-f]{2,}:/i.test(hostname)) return true
    return false
  } catch {
    return true // malformed URL
  }
}

const HEAD_BYTES = 50_000

/** The start of a page — enough for its <head> tags — and where it ended up after redirects */
async function readHead(url: string, fetchImpl: FetchLike): Promise<{ html: string; finalUrl: string }> {
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const finalUrl = res.url || url
  // Re-check after redirects so an open redirect can't lead into the private network
  if (isPrivateUrl(finalUrl)) throw new Error('Invalid URL')

  const reader = res.body?.getReader()
  if (!reader) return { html: '', finalUrl }
  const decoder = new TextDecoder()
  let html = ''
  let bytes = 0
  while (bytes < HEAD_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    html += decoder.decode(value, { stream: true })
    bytes += value.length
    if (html.includes('</head>')) break
  }
  reader.cancel().catch(() => {})
  return { html, finalUrl }
}

/**
 * Where a t.co page sends the browser. With a browser User-Agent, t.co answers
 * 200 with a page that redirects by script (fetch doesn't follow it); the
 * destination is its <title> and meta refresh.
 */
export function tcoDestination(html: string): string | null {
  const title = html.match(/<title[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/title>/i)?.[1]
  const refresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'\s>]+)/i)?.[1]
  const destination = decodeHtmlEntities(title ?? refresh ?? '')
  return isHttpUrl(destination) ? destination : null
}

/** <meta property|name="…" content="…"> values by lower-cased key; the first of each wins */
function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>()
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '')
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase()
    const content = decodeHtmlEntities(attrs.get('content') ?? '').trim()
    if (key && content && !tags.has(key)) tags.set(key, content)
  }
  return tags
}

export interface PagePreview {
  /** Where the link ended up — redirects and t.co resolved */
  url: string
  title: string
  description: string
  image: string
  siteName: string
  domain: string
}

/** Open Graph preview of a page. Throws when it can't be loaded */
export async function fetchPagePreview(url: string, fetchImpl: FetchLike = defaultFetch): Promise<PagePreview> {
  if (isPrivateUrl(url)) throw new Error('Invalid URL')
  let page = await readHead(url, fetchImpl)

  if (domainOf(page.finalUrl) === 't.co') {
    const destination = tcoDestination(page.html)
    if (destination && !isPrivateUrl(destination)) {
      // Keep the destination even if its page won't load
      page = await readHead(destination, fetchImpl).catch(() => ({ html: '', finalUrl: destination }))
    }
  }

  const { html, finalUrl } = page
  const meta = metaTags(html)
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find(Boolean) ?? ''
  const titleTag = decodeHtmlEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '').trim()

  let image = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src')
  try {
    if (image) image = new URL(image, finalUrl).toString()
  } catch {
    image = ''
  }

  return {
    url: finalUrl,
    title: pick('og:title', 'twitter:title') || (isHttpUrl(titleTag) ? '' : titleTag),
    description: pick('og:description', 'twitter:description', 'description'),
    image,
    siteName: pick('og:site_name'),
    domain: domainOf(finalUrl) ?? '',
  }
}

export interface FetchedLinkCard {
  card: LinkCard | null
  /** Where the post's link leads, when known — even without a card (e.g. another post on X) */
  url: string | null
}

/**
 * Look a post's link card up on the network: X's own card for the post (the
 * same one X shows), else the Open Graph tags of the page `link` leads to.
 * Never throws.
 */
export async function fetchLinkCard(tweetId: string, link: string | null, fetchImpl: FetchLike = defaultFetch): Promise<FetchedLinkCard> {
  if (/^\d+$/.test(tweetId)) {
    try {
      const card = linkCardFromSnapshot((await fetchSyndicationTweet(tweetId, fetchImpl)).snapshot)
      if (card) return { card, url: card.url }
    } catch {
      // Fall back to the page itself
    }
  }
  if (!link) return { card: null, url: null }

  try {
    const page = await fetchPagePreview(link, fetchImpl)
    // Pages on X are rendered by script — their tags describe X, not the post
    if (isXUrl(page.url)) return { card: null, url: page.url }
    const card = makeCard({ url: page.url, title: page.title, description: page.description, domain: page.domain, imageUrl: page.image })
    return { card, url: page.url }
  } catch {
    return { card: null, url: null }
  }
}
