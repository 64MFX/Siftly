import { NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { archiveAllMedia } from '@/lib/media-archive'

export async function GET(): Promise<NextResponse> {
  const [total, saved] = await Promise.all([
    prisma.mediaItem.count(),
    prisma.mediaItem.count({ where: { localPath: { not: null } } }),
  ])
  return NextResponse.json({ total, saved, remaining: total - saved })
}

export async function POST(): Promise<NextResponse> {
  try {
    return NextResponse.json(await archiveAllMedia())
  } catch (err) {
    console.error('Media archive error:', err)
    return NextResponse.json({ error: 'Archive failed' }, { status: 500 })
  }
}
