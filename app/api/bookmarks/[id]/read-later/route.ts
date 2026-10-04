import { NextRequest, NextResponse } from 'next/server'
import { setReadLater } from '@/lib/read-later'

type Params = { params: Promise<{ id: string }> }

async function update(id: string, onList: boolean): Promise<NextResponse> {
  try {
    const state = await setReadLater(id, onList)
    if (!state) return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    return NextResponse.json(state)
  } catch (err) {
    console.error('Read Later update error:', err)
    return NextResponse.json(
      { error: `Failed to update Read Later: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** POST — put a bookmark (by id or tweetId) on the Read Later list */
export async function POST(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  return update((await params).id, true)
}

/** DELETE — take a bookmark (by id or tweetId) off the Read Later list */
export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  return update((await params).id, false)
}
