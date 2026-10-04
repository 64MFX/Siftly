import { NextRequest, NextResponse } from 'next/server'
import { aiSearch } from '@/lib/ai-search'
import { getSearchIndexStats, syncSearchIndex } from '@/lib/search-index'

const MAX_QUERY_LENGTH = 1000

/**
 * GET — what AI search can read: bookmarks indexed and how many X Articles
 * have their full text. Indexes new bookmarks first, so opening the search
 * page gets the index ready before the first search.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await syncSearchIndex()
    return NextResponse.json(await getSearchIndexStats())
  } catch (err) {
    console.error('Search index error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/** POST { query, category? } — natural-language search; questions also get an answer */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { query?: unknown; category?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 })
  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` }, { status: 400 })
  }
  const category = typeof body.category === 'string' ? body.category : undefined

  try {
    return NextResponse.json(await aiSearch(query, { category }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('AI search error:', message)
    return NextResponse.json({ error: `AI search failed: ${message}` }, { status: 500 })
  }
}
