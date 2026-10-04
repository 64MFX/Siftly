import { describe, it, expect } from 'vitest'
import {
  bestVideoVariant,
  decodeHtmlEntities,
  mergeSnapshots,
  parseArticle,
  snapshotFromGraphql,
  snapshotFromStoredRaw,
  snapshotFromSyndication,
  type TweetSnapshot,
} from '@/lib/tweet-snapshot'
import {
  ARTICLE_TWEET_ID,
  NOTE_TWEET_ID,
  QUOTED_TWEET_ID,
  SYNDICATION_TWEET_ID,
  articleTweetGraphql,
  articleTweetTimelineOnly,
  flatExportRawJson,
  noteTweetGraphql,
  syndicationTweet,
} from './fixtures/x-tweets'

describe('parseArticle', () => {
  const article = parseArticle(articleTweetGraphql.article.article_results.result)!

  it('keeps title, cover and publish date', () => {
    expect(article.title).toBe('How we built it')
    expect(article.complete).toBe(true)
    expect(article.coverImage).toEqual({ type: 'photo', url: 'https://pbs.twimg.com/media/COVER1.jpg', width: 1500, height: 600 })
    expect(article.publishedAt).toBe(new Date(1759320000 * 1000).toISOString())
  })

  it('converts blocks in reading order with media in place', () => {
    expect(article.blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'heading2',
      'media',
      'unordered-list',
      'media',
      'embedded-tweet',
      'divider',
      'code',
      'blockquote',
      'paragraph',
    ])
  })

  it('resolves inline images and picks the best video rendition', () => {
    const [image, video] = article.blocks.filter((b) => b.type === 'media')
    expect(image).toEqual({
      type: 'media',
      caption: 'The dashboard',
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/INLINE1.jpg' }],
    })
    expect(video.type === 'media' && video.media[0]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/amplify_video/333/vid/1280x720/high.mp4',
      posterUrl: 'https://pbs.twimg.com/amplify_video_thumb/333/img/p.jpg',
      durationMs: 12000,
    })
  })

  it('applies inline styles and links using code-point offsets', () => {
    const intro = article.blocks[0]
    expect(intro.type === 'paragraph' && intro.spans).toEqual([
      { text: 'Intro with ' },
      { text: 'bold', bold: true },
      { text: ' and a ' },
      { text: 'link', href: 'https://example.com/docs' },
      { text: ' 🚀 here.' },
    ])
    // The emoji sits at code point 6; UTF-16 indexing would split its surrogate pair
    const outro = article.blocks[article.blocks.length - 1]
    expect(outro.type === 'paragraph' && outro.spans).toEqual([
      { text: 'Outro ' },
      { text: '🎉', italic: true },
      { text: ' done' },
    ])
  })

  it('groups list items, unwraps code fences and keeps embedded posts', () => {
    expect(article.blocks[3]).toEqual({
      type: 'unordered-list',
      items: [[{ text: 'first point' }], [{ text: 'second point' }]],
    })
    expect(article.blocks[7]).toEqual({ type: 'code', text: 'const x = 1' })
    expect(article.blocks[5]).toEqual({
      type: 'embedded-tweet',
      tweetId: '1800000000000000000',
      tweetUrl: 'https://x.com/i/web/status/1800000000000000000',
    })
  })

  it('accepts entityMap as an object keyed by entity id', () => {
    const result = articleTweetGraphql.article.article_results.result
    const asObject = Object.fromEntries(result.content_state.entityMap.map((e) => [e.key, e.value]))
    const parsed = parseArticle({ ...result, content_state: { ...result.content_state, entityMap: asObject } })!
    expect(parsed.blocks.map((b) => b.type)).toEqual(article.blocks.map((b) => b.type))
  })

  it('marks teaser-only articles as incomplete', () => {
    const teaser = parseArticle(articleTweetTimelineOnly.article.article_results.result)!
    expect(teaser.complete).toBe(false)
    expect(teaser.blocks).toEqual([])
    expect(teaser.previewText).toBe('A short teaser')
  })
})

describe('snapshotFromGraphql', () => {
  it('parses an article tweet and drops the bare article link from the text', () => {
    const snap = snapshotFromGraphql(articleTweetGraphql)!
    expect(snap.tweetId).toBe(ARTICLE_TWEET_ID)
    expect(snap.authorName).toBe('Ada Writer')
    expect(snap.authorHandle).toBe('ada')
    expect(snap.avatarUrl).toBe('https://pbs.twimg.com/profile_images/1/ada_400x400.jpg')
    expect(snap.text).toBe('')
    expect(snap.article?.complete).toBe(true)
  })

  it('uses the full note-tweet text and expands t.co links', () => {
    const snap = snapshotFromGraphql(noteTweetGraphql)!
    expect(snap.tweetId).toBe(NOTE_TWEET_ID)
    expect(snap.text).toBe(
      'Full long text with & entity and link https://github.com/foo/bar\n\nSecond paragraph that X truncates in legacy.full_text',
    )
    expect(snap.createdAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('extracts photo, highest-bitrate video and GIF', () => {
    const snap = snapshotFromGraphql(noteTweetGraphql)!
    expect(snap.media).toEqual([
      { type: 'photo', url: 'https://pbs.twimg.com/media/PHOTO1.jpg', width: 1200, height: 800, altText: 'A cat' },
      {
        type: 'video',
        url: 'https://video.twimg.com/ext_tw_video/444/pu/vid/1280x720/b.mp4',
        posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/444/pu/img/thumb.jpg',
        durationMs: 5000,
        width: undefined,
        height: undefined,
        altText: undefined,
      },
      {
        type: 'gif',
        url: 'https://video.twimg.com/tweet_video/GIFKEY.mp4',
        posterUrl: 'https://pbs.twimg.com/tweet_video_thumb/GIFKEY.jpg',
        durationMs: undefined,
        width: undefined,
        height: undefined,
        altText: undefined,
      },
    ])
  })

  it('captures the quoted tweet and the link card', () => {
    const snap = snapshotFromGraphql(noteTweetGraphql)!
    expect(snap.quote).toMatchObject({
      tweetId: QUOTED_TWEET_ID,
      authorHandle: 'carol',
      text: 'Quoted text',
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/QUOTE1.png' }],
    })
    expect(snap.card).toEqual({
      url: 'https://github.com/foo/bar',
      title: 'foo/bar on GitHub',
      description: 'A repository',
      domain: 'github.com',
      imageUrl: 'https://pbs.twimg.com/card_img/1/abc?format=jpg&name=orig',
    })
  })

  it('reports tombstones as unavailable', () => {
    expect(snapshotFromGraphql({ __typename: 'TweetTombstone', tombstone: {} }, '42')).toEqual({
      tweetId: '42',
      text: '',
      media: [],
      unavailable: true,
    })
  })
})

describe('snapshotFromSyndication', () => {
  it('parses text, video and polls', () => {
    const snap = snapshotFromSyndication(syndicationTweet)!
    expect(snap.tweetId).toBe(SYNDICATION_TWEET_ID)
    expect(snap.text).toBe('Hello & welcome @alice')
    expect(snap.media[0]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/b.mp4',
      posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/555/pu/img/t.jpg',
    })
    expect(snap.poll).toEqual({
      choices: [{ label: 'Yes', votes: 30 }, { label: 'No', votes: 10 }],
      endsAt: '2022-03-02T10:00:00.000Z',
    })
  })
})

describe('snapshotFromStoredRaw', () => {
  it('detects GraphQL, syndication and v1.1 shapes', () => {
    expect(snapshotFromStoredRaw(JSON.stringify(noteTweetGraphql))?.tweetId).toBe(NOTE_TWEET_ID)
    expect(snapshotFromStoredRaw(JSON.stringify(syndicationTweet))?.poll).toBeDefined()
    const flat = snapshotFromStoredRaw(flatExportRawJson)!
    expect(flat).toMatchObject({ tweetId: '1400000000000000001', authorHandle: 'erin', text: 'From a flat export https://t.co/m1' })
    expect(flat.media[0].type).toBe('video')
  })

  it('handles API v2 rows and junk', () => {
    expect(snapshotFromStoredRaw(JSON.stringify({ id: '99', text: 'v2 text' }))).toMatchObject({ tweetId: '99', text: 'v2 text' })
    expect(snapshotFromStoredRaw('not json')).toBeNull()
    expect(snapshotFromStoredRaw('')).toBeNull()
  })
})

describe('mergeSnapshots', () => {
  const stored = snapshotFromGraphql(noteTweetGraphql)!

  it('keeps stored content when X says the post is gone', () => {
    const gone: TweetSnapshot = { tweetId: NOTE_TWEET_ID, text: '', media: [], unavailable: true }
    const merged = mergeSnapshots(gone, stored)!
    expect(merged.unavailable).toBe(true)
    expect(merged.text).toBe(stored.text)
    expect(merged.media).toHaveLength(3)
    expect(merged.quote?.tweetId).toBe(QUOTED_TWEET_ID)
    expect(merged.authorHandle).toBe('bob')
  })

  it('prefers a complete article body over a teaser', () => {
    const teaser = snapshotFromGraphql(articleTweetTimelineOnly)!
    const full = snapshotFromGraphql(articleTweetGraphql)!
    expect(mergeSnapshots(teaser, full)?.article?.complete).toBe(true)
    expect(mergeSnapshots(full, teaser)?.article?.complete).toBe(true)
  })

  it('prefers the longer text', () => {
    const truncated: TweetSnapshot = { ...stored, text: 'Full long text…' }
    expect(mergeSnapshots(truncated, stored)?.text).toBe(stored.text)
  })
})

describe('helpers', () => {
  it('decodes HTML entities without double-decoding', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x1F680; &amp;lt;')).toBe("a & b <c> 'd' 🚀 &lt;")
  })

  it('falls back to a stream variant only when there is no MP4', () => {
    expect(bestVideoVariant([{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' }])).toBe(
      'https://video.twimg.com/a.m3u8',
    )
    expect(bestVideoVariant([])).toBeUndefined()
  })
})
