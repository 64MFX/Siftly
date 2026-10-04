import os from 'os'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { detectCloudFolders, listSubfolders, normalizeArchiveDir } from '@/lib/archive-storage'

/**
 * GET — folder picker for the archive location.
 * `?path=` lists that folder's sub-folders (default: home folder) and always
 * includes the cloud-drive folders found on this machine.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requested = request.nextUrl.searchParams.get('path')
  const home = os.homedir()
  const dir = requested ? normalizeArchiveDir(requested) ?? (path.isAbsolute(requested.trim()) ? path.resolve(requested.trim()) : null) : home
  if (!dir) return NextResponse.json({ error: 'Enter a full folder path' }, { status: 400 })

  const [folders, suggestions] = await Promise.all([
    listSubfolders(dir).then(
      (names) => ({ ok: true as const, names }),
      (err: NodeJS.ErrnoException) => ({ ok: false as const, error: err.code === 'ENOENT' ? "That folder doesn't exist yet — it will be created when you save" : `Can't open that folder (${err.code ?? err.message})` }),
    ),
    detectCloudFolders(home),
  ])
  const parent = path.dirname(dir)

  return NextResponse.json({
    path: dir,
    parent: parent !== dir ? parent : null,
    home,
    separator: path.sep,
    folders: folders.ok ? folders.names : [],
    error: folders.ok ? null : folders.error,
    suggestions,
  })
}
