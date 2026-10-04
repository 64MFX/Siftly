import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { archiveBookmark, readArchiveDocument } from '@/lib/archiver'

async function findBookmark(idOrTweetId: string) {
  return prisma.bookmark.findFirst({
    where: { OR: [{ id: idOrTweetId }, { tweetId: idOrTweetId }] },
    select: { id: true, tweetId: true, archivedAt: true, archiveStatus: true, archiveError: true },
  })
}

/** GET — the archived copy of a bookmark (by id or tweetId) */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const bookmark = await findBookmark(id)
  if (!bookmark) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })

  const archive = await readArchiveDocument(bookmark.tweetId)
  if (!archive) return NextResponse.json({ error: 'This bookmark has not been archived yet' }, { status: 404 })

  return NextResponse.json({
    bookmarkId: bookmark.id,
    status: bookmark.archiveStatus,
    archivedAt: bookmark.archivedAt?.toISOString() ?? null,
    lastError: bookmark.archiveError,
    folder: archive.folder,
    document: archive.doc,
  })
}

/** POST — archive (or re-archive) a single bookmark now and wait for the result */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const bookmark = await findBookmark(id)
  if (!bookmark) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })

  try {
    const result = await archiveBookmark(bookmark.id)
    const mediaItems = await prisma.mediaItem.findMany({
      where: { bookmarkId: bookmark.id },
      select: { id: true, type: true, url: true, thumbnailUrl: true, localPath: true, localThumbnailPath: true },
    })
    return NextResponse.json({ ...result, mediaItems })
  } catch (err) {
    return NextResponse.json(
      { error: `Archiving failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
