import { NextRequest, NextResponse } from 'next/server'
import { createReadLaterFolder, listReadLaterFolders, ReadLaterFolderError } from '@/lib/read-later'

/** GET — the user's Read Later folders with counts, plus the list's total and Unsorted count */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await listReadLaterFolders())
  } catch (err) {
    console.error('Read Later folders fetch error:', err)
    return NextResponse.json(
      { error: `Failed to load Read Later folders: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

/** POST — create a folder: `{"name"}` */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { name?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    return NextResponse.json({ folder: await createReadLaterFolder(body.name) }, { status: 201 })
  } catch (err) {
    if (err instanceof ReadLaterFolderError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('Read Later folder create error:', err)
    return NextResponse.json(
      { error: `Failed to create folder: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
