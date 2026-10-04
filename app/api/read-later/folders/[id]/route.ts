import { NextRequest, NextResponse } from 'next/server'
import { deleteReadLaterFolder, ReadLaterFolderError, renameReadLaterFolder } from '@/lib/read-later'

type Params = { params: Promise<{ id: string }> }

function failure(err: unknown, action: string): NextResponse {
  if (err instanceof ReadLaterFolderError) return NextResponse.json({ error: err.message }, { status: err.status })
  console.error(`Read Later folder ${action} error:`, err)
  return NextResponse.json(
    { error: `Failed to ${action} folder: ${err instanceof Error ? err.message : String(err)}` },
    { status: 500 },
  )
}

/** PATCH — rename a folder: `{"name"}` */
export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  let body: { name?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    return NextResponse.json({ folder: await renameReadLaterFolder(id, body.name) })
  } catch (err) {
    return failure(err, 'rename')
  }
}

/** DELETE — delete a folder; its bookmarks stay on the Read Later list, Unsorted */
export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  try {
    return NextResponse.json({ success: true, moved: await deleteReadLaterFolder(id) })
  } catch (err) {
    return failure(err, 'delete')
  }
}
