import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { importedTweetFromGraphql } from '@/lib/x-tweet-import'

const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com'])

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://x.com'
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(request)
  let body: { tweets?: unknown[]; source?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }

  const source = body.source === 'like' ? 'like' : 'bookmark'
  const tweets = body.tweets ?? []
  if (!Array.isArray(tweets) || tweets.length === 0) {
    return NextResponse.json({ error: 'No tweets provided' }, { status: 400, headers: cors })
  }

  let imported = 0
  let skipped = 0

  for (const raw of tweets) {
    // GraphQL tweet results, as x.com's own timelines receive them
    const tweet = importedTweetFromGraphql(raw)
    if (!tweet) continue

    const exists = await prisma.bookmark.findUnique({
      where: { tweetId: tweet.tweetId },
      select: { id: true },
    })

    if (exists) {
      skipped++
      continue
    }

    await prisma.bookmark.create({
      data: {
        tweetId: tweet.tweetId,
        text: tweet.text,
        authorHandle: tweet.authorHandle,
        authorName: tweet.authorName,
        tweetCreatedAt: tweet.tweetCreatedAt,
        rawJson: tweet.rawJson,
        source,
        ...(tweet.media.length > 0 ? { mediaItems: { create: tweet.media } } : {}),
      },
    })

    imported++
  }

  return NextResponse.json({ imported, skipped }, { headers: cors })
}
