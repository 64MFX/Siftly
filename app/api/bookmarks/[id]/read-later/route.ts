import { NextRequest, NextResponse } from 'next/server'
import { fileReadLater, ReadLaterFolderError, setReadLater } from '@/lib/read-later'
import type { ReadLaterState } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }

async function update(change: () => Promise<ReadLaterState | null>): Promise<NextResponse> {
  try {
    const state = await change()
    if (!state) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    return NextResponse.json(state)
  } catch (err) {
    if (err instanceof ReadLaterFolderError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('Read Later update error:', err)
    return NextResponse.json(
      { error: `Failed to update Read Later: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** POST — put a bookmark (by id or tweetId) on the Read Later list */
export async function POST(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  return update(() => setReadLater(id, true))
}

/**
 * PUT — file a bookmark in a Read Later folder: `{"folderId": "<id>"}`, or
 * `{"folderId": null}` for Unsorted. Puts it on the list if it isn't on it.
 */
export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  let body: { folderId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { folderId } = body
  if (folderId !== null && typeof folderId !== 'string') {
    return NextResponse.json({ error: 'folderId must be a folder id or null' }, { status: 400 })
  }
  return update(() => fileReadLater(id, folderId || null))
}

/** DELETE — take a bookmark (by id or tweetId) off the Read Later list (and out of its folder) */
export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  return update(() => setReadLater(id, false))
}
