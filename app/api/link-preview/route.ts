import { NextRequest, NextResponse } from 'next/server'
import { domainOf, fetchLinkCard, fetchPagePreview, isPrivateUrl, isXUrl } from '@/lib/link-card'

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400', // cache 24h
}

/** For JS-rendered platforms that can't be scraped, derive a human-readable title */
function syntheticTitle(finalUrl: string, siteName: string): string {
  try {
    const { pathname } = new URL(finalUrl)
    // X / Twitter articles (x.com/i/article/...)
    if (isXUrl(finalUrl) && pathname.startsWith('/i/article')) return 'Article on X'
    // X/Twitter profile or status pages
    if (isXUrl(finalUrl)) return 'View on X'
    // Other platforms with a known site name but no scrape-able title
    if (siteName) return `Article on ${siteName}`
  } catch { /* ignore */ }
  return ''
}

/**
 * GET ?url=…[&tweetId=…] — Open Graph preview of a page (t.co links resolved).
 * Bookmark cards use /api/bookmarks/<id>/link-card, which also saves the card.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'url required' }, { status: 400 })
  }

  if (isPrivateUrl(url)) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  // Also accept an optional tweetId param for X article enrichment
  const rawTweetId = request.nextUrl.searchParams.get('tweetId')
  const tweetId = rawTweetId && /^\d+$/.test(rawTweetId) ? rawTweetId : null

  try {
    const page = await fetchPagePreview(url)

    // X pages are JS-rendered — OG scraping returns nothing useful. X's own data for the post does
    if (isXUrl(page.url) && tweetId) {
      const { card } = await fetchLinkCard(tweetId, null)
      if (card) {
        return NextResponse.json(
          {
            title: card.title,
            description: card.description ?? '',
            image: card.imageUrl ?? '',
            siteName: card.domain ?? 'X',
            domain: domainOf(card.url) ?? 'x.com',
            url: card.url,
          },
          { headers: CACHE_HEADERS },
        )
      }
    }

    return NextResponse.json(
      {
        title: page.title || syntheticTitle(page.url, page.siteName),
        description: page.description,
        image: page.image,
        siteName: page.siteName,
        domain: page.domain,
        url: page.url,
      },
      { headers: CACHE_HEADERS },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'preview failed'
    return NextResponse.json({ error: msg }, { status: 502, headers: CACHE_HEADERS })
  }
}
