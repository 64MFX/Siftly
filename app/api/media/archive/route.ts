import { NextResponse } from 'next/server'
import { getArchiveStats, getArchiveStatus, startArchive, stopArchive } from '@/lib/media-archive'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const stats = await getArchiveStats()
  return NextResponse.json({ ...getArchiveStatus(), ...stats })
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { action?: string }
  if (body.action === 'stop') {
    stopArchive()
    return NextResponse.json({ ok: true })
  }
  if (!startArchive()) {
    return NextResponse.json({ ok: false, error: 'Archive already running' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
