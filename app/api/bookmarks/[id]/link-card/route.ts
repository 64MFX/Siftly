import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveLinkCard } from '@/lib/link-card-store'

/**
 * GET — the link card of a bookmark (by id or tweetId): title, description,
 * site and image of the page it links to. Looked up (archive, stored JSON, X,
 * the page itself) and saved the first time. `url` is where the link leads,
 * also when there's no card (e.g. a quoted post).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id }, { tweetId: id }] },
    select: { id: true },
  })
  if (!bookmark) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })

  try {
    const result = await resolveLinkCard(bookmark.id)
    return NextResponse.json(
      { linkCard: result?.card ?? null, url: result?.url ?? null },
      // A found card is saved and comes with the bookmark from now on; don't retry a miss on every render
      result?.card ? {} : { headers: { 'Cache-Control': 'private, max-age=3600' } },
    )
  } catch (err) {
    console.error('[link-card] Lookup failed:', err)
    return NextResponse.json(
      { error: `Link card lookup failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
