/**
 * Turns a tweet from X's GraphQL API (`tweet_results.result`, the shape
 * x.com's own Bookmarks page receives) into the fields of a new Bookmark.
 * Shared by "Sync from X", the bookmarklet's export file and the bookmarklet
 * endpoint.
 *
 * X moved the author's name and handle from `user.legacy` to `user.core` in
 * 2026; both are read. What is stored as rawJson keeps everything Siftly
 * reads later (text, entities, media, card, note tweet, article, quoted post)
 * but only the author fields of each user object — the rest of a user object
 * is most of a GraphQL tweet's size.
 *
 * Pure functions only — no network, no database.
 */
import { articlePlainText } from '@/lib/search-document'
import { decodeHtmlEntities, parseArticle } from '@/lib/tweet-snapshot'

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export interface ImportedTweetMedia {
  type: 'photo' | 'video' | 'gif'
  url: string
  thumbnailUrl: string | null
}

export interface ImportedTweet {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  hashtags: string[]
  urls: string[]
  media: ImportedTweetMedia[]
  /** What is stored as Bookmark.rawJson */
  rawJson: string
}

/** `TweetWithVisibilityResults` wraps the tweet one level down */
export function unwrapGraphqlTweet(input: unknown): Json | null {
  const tweet = obj(input)
  if (!tweet) return null
  if (tweet.__typename === 'TweetWithVisibilityResults' || tweet.__typename === 'TweetWithVisibilityResult') {
    return obj(tweet.tweet) ?? null
  }
  return tweet
}

/** A GraphQL tweet result, as opposed to v1.1 / API v2 / export-file rows */
export function isGraphqlTweet(input: unknown): boolean {
  const tweet = unwrapGraphqlTweet(input)
  if (!tweet) return false
  return typeof tweet.rest_id === 'string' && (!!obj(tweet.legacy) || !!obj(tweet.core))
}

/** X returns a placeholder instead of the post: deleted, suspended, protected… */
export function isUnavailableGraphqlTweet(input: unknown): boolean {
  const tweet = unwrapGraphqlTweet(input)
  if (!tweet) return true
  const typename = str(tweet.__typename)
  return typename === 'TweetTombstone' || typename === 'TweetUnavailable' || !obj(tweet.legacy)
}

// ── Stored JSON ──────────────────────────────────────────────────────────────

/** Bulky parts of a tweet result nothing in Siftly reads */
const DROPPED_TWEET_KEYS = new Set([
  'views',
  'edit_control',
  'edit_perspective',
  'unmention_data',
  'quick_promote_eligibility',
  'superFollowsReplyUserResult',
  'previous_counts',
])

function slimUser(input: unknown): unknown {
  const user = obj(input)
  if (!user) return input
  const legacy = obj(user.legacy)
  const slim: Json = {}
  for (const key of ['__typename', 'id', 'rest_id', 'core', 'avatar', 'is_blue_verified', 'verification']) {
    if (user[key] !== undefined) slim[key] = user[key]
  }
  if (legacy) {
    const keep: Json = {}
    for (const key of ['name', 'screen_name', 'profile_image_url_https', 'verified']) {
      if (legacy[key] !== undefined) keep[key] = legacy[key]
    }
    slim.legacy = keep
  }
  return slim
}

/** The tweet without what Siftly never reads (see the file comment) */
export function slimGraphqlTweet(input: unknown, depth = 0): Json | null {
  const tweet = unwrapGraphqlTweet(input)
  if (!tweet) return null
  const slim: Json = {}
  for (const [key, value] of Object.entries(tweet)) {
    if (DROPPED_TWEET_KEYS.has(key)) continue
    if (key === 'core' && obj(obj(value)?.user_results)) {
      slim.core = { ...obj(value), user_results: { result: slimUser(obj(obj(value)?.user_results)?.result) } }
    } else if ((key === 'quoted_status_result' || key === 'retweeted_status_result') && obj(value)) {
      const inner = depth < 2 ? slimGraphqlTweet(obj(value)?.result, depth + 1) : null
      slim[key] = inner ? { result: inner } : value
    } else {
      slim[key] = value
    }
  }
  return slim
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** Article posts link to the article; X shows its title and opening instead */
const ARTICLE_TEXT_LIMIT = 1000

function tweetText(tweet: Json): string {
  const legacy = obj(tweet.legacy) ?? {}
  const note = str(obj(obj(obj(tweet.note_tweet)?.note_tweet_results)?.result)?.text)
  const own = decodeHtmlEntities(note ?? str(legacy.full_text) ?? str(legacy.text) ?? '').trim()

  const article = parseArticle(obj(obj(tweet.article)?.article_results)?.result)
  if (!article) return own
  const opening = article.previewText?.trim() || articlePlainText(article).slice(0, ARTICLE_TEXT_LIMIT).trim()
  // The post itself is usually just the t.co link to the article
  const ownText = own.replace(/https?:\/\/t\.co\/\w+/g, '').trim() ? own : ''
  return [ownText, article.title.trim(), opening].filter(Boolean).join('\n\n')
}

function bestMp4(variants: unknown): string | undefined {
  return arr(variants)
    .map((v) => obj(v))
    .filter((v): v is Json => !!v && v.content_type === 'video/mp4' && !!str(v.url))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0]?.url as string | undefined
}

function tweetMedia(tweet: Json): ImportedTweetMedia[] {
  const legacy = obj(tweet.legacy) ?? {}
  const extended = arr(obj(legacy.extended_entities)?.media)
  const entities = extended.length > 0 ? extended : arr(obj(legacy.entities)?.media)
  const media: ImportedTweetMedia[] = []
  for (const item of entities) {
    const m = obj(item)
    if (!m) continue
    const thumb = str(m.media_url_https) ?? str(m.media_url)
    if (m.type === 'video' || m.type === 'animated_gif') {
      const video = bestMp4(obj(m.video_info)?.variants)
      if (video) media.push({ type: m.type === 'animated_gif' ? 'gif' : 'video', url: video, thumbnailUrl: thumb ?? null })
      // No MP4 (e.g. only a stream): keep the poster so the card still shows something
      else if (thumb) media.push({ type: 'photo', url: thumb, thumbnailUrl: thumb })
    } else if (thumb) {
      media.push({ type: 'photo', url: thumb, thumbnailUrl: thumb })
    }
  }
  if (media.length === 0) {
    const article = parseArticle(obj(obj(tweet.article)?.article_results)?.result)
    const cover = article?.coverImage?.url
    if (cover) media.push({ type: 'photo', url: cover, thumbnailUrl: cover })
  }
  return media
}

function entityList(list: unknown, pick: (e: Json) => string | undefined): string[] {
  return arr(list)
    .map((e) => obj(e))
    .map((e) => (e ? pick(e) : undefined))
    .filter((v): v is string => !!v)
}

function createdAt(value: unknown): Date | null {
  const raw = str(value)
  if (!raw) return null
  const date = new Date(raw)
  return isNaN(date.getTime()) ? null : date
}

/**
 * The fields of a new Bookmark, or null when the result isn't a readable tweet
 * (placeholders for deleted or protected posts have nothing to import).
 */
export function importedTweetFromGraphql(input: unknown): ImportedTweet | null {
  const tweet = unwrapGraphqlTweet(input)
  if (!tweet || isUnavailableGraphqlTweet(tweet)) return null
  const legacy = obj(tweet.legacy) ?? {}
  const tweetId = str(tweet.rest_id) ?? str(legacy.id_str)
  if (!tweetId) return null

  const user = obj(obj(obj(tweet.core)?.user_results)?.result)
  const userCore = obj(user?.core)
  const userLegacy = obj(user?.legacy)
  const entities = obj(legacy.entities)
  const noteEntities = obj(obj(obj(obj(tweet.note_tweet)?.note_tweet_results)?.result)?.entity_set)

  return {
    tweetId,
    text: tweetText(tweet),
    authorHandle: str(userCore?.screen_name) ?? str(userLegacy?.screen_name) ?? 'unknown',
    authorName: str(userCore?.name) ?? str(userLegacy?.name) ?? 'Unknown',
    tweetCreatedAt: createdAt(legacy.created_at),
    hashtags: entityList(entities?.hashtags, (h) => str(h.text)),
    urls: [...new Set([
      ...entityList(entities?.urls, (u) => str(u.expanded_url) ?? str(u.url)),
      ...entityList(noteEntities?.urls, (u) => str(u.expanded_url) ?? str(u.url)),
    ])],
    media: tweetMedia(tweet),
    rawJson: JSON.stringify(slimGraphqlTweet(tweet)),
  }
}
