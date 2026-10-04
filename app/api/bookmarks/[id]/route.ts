import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { deleteArchiveFolder, isBookmarkArchiving } from '@/lib/archiver'
import { isArchiveRelocating } from '@/lib/archive-location'
import { removeFromSearchIndex } from '@/lib/search-index'

/**
 * DELETE — remove one bookmark (by id or tweetId) from Siftly. It stays
 * bookmarked on X. `?deleteArchive=true` also deletes its local archive folder.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const deleteArchive = new URL(request.url).searchParams.get('deleteArchive') === 'true'

  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id }, { tweetId: id }] },
    select: { id: true, tweetId: true },
  })
  if (!bookmark) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })

  if (isBookmarkArchiving(bookmark.id)) {
    return NextResponse.json(
      { error: 'This bookmark is being saved to the local archive right now — try again when it finishes' },
      { status: 409 },
    )
  }
  if (deleteArchive && isArchiveRelocating()) {
    return NextResponse.json({ error: 'The archive folder is being moved — try again in a moment' }, { status: 409 })
  }

  try {
    // Remove the rows that point at it explicitly, like the bulk clear does
    await prisma.$transaction([
      prisma.bookmarkCategory.deleteMany({ where: { bookmarkId: bookmark.id } }),
      prisma.mediaItem.deleteMany({ where: { bookmarkId: bookmark.id } }),
      prisma.bookmark.delete({ where: { id: bookmark.id } }),
    ])
  } catch (err) {
    console.error('Delete bookmark error:', err)
    return NextResponse.json(
      { error: `Failed to delete bookmark: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }

  await removeFromSearchIndex(bookmark.id).catch((err) => console.error('Search index delete error:', err))

  let archiveDeleted = false
  let warning: string | undefined
  if (deleteArchive) {
    try {
      archiveDeleted = await deleteArchiveFolder(bookmark.tweetId)
    } catch (err) {
      warning = `Bookmark deleted, but its local archive copy could not be removed: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[archive] ${warning}`)
    }
  }

  return NextResponse.json({
    success: true,
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    archiveDeleted,
    ...(warning ? { warning } : {}),
  })
}
