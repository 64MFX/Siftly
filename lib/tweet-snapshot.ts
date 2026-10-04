/**
 * Normalizes the many tweet JSON shapes Siftly sees into one TweetSnapshot:
 *
 *  - X GraphQL `TweetResult` (bookmarklet, live import, sync, TweetResultByRestId)
 *  - Twitter v1.1-style objects (file imports, flat/console/Siftly re-exports, API v2)
 *  - The public syndication API (`cdn.syndication.twimg.com/tweet-result`)
 *
 * X Articles are converted from their Draft.js `content_state` into ordered
 * ArticleBlocks so inline images/videos keep their position in the text.
 *
 * Pure functions only — no network, no filesystem.
 */
import {
  ARCHIVE_VERSION,
  type ArchiveDocument,
  type ArchivedArticle,
  type ArchivedLinkCard,
  type ArchivedMedia,
  type ArchivedPoll,
  type ArticleBlock,
  type TextSpan,
} from '@/lib/archive-types'

export interface TweetSnapshot {
  tweetId: string
  authorName?: string
  authorHandle?: string
  avatarUrl?: string
  createdAt?: string | null
  /** Full text with t.co links expanded and media/quote/article links removed */
  text: string
  media: ArchivedMedia[]
  quote?: TweetSnapshot
  card?: ArchivedLinkCard
  poll?: ArchivedPoll
  article?: ArchivedArticle
  /** Deleted, suspended, protected or otherwise not viewable on X */
  unavailable?: boolean
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

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

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** IDs arrive as strings or (lossy) numbers depending on the source */
function idStr(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function toIso(value: unknown): string | null {
  const raw = str(value)
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Text helpers ─────────────────────────────────────────────────────────────

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => safeFromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeFromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

interface UrlEntity {
  url: string
  expanded: string
}

function urlEntities(list: unknown): UrlEntity[] {
  const out: UrlEntity[] = []
  for (const item of arr(list)) {
    const u = obj(item)
    const url = str(u?.url)
    if (!url) continue
    out.push({ url, expanded: str(u?.expanded_url) ?? str(u?.expanded) ?? url })
  }
  return out
}

/**
 * Replace t.co links with their real targets and drop the ones that only point
 * at attached media, the quoted tweet or the article (X hides those too).
 */
function cleanText(
  raw: string,
  urls: UrlEntity[],
  dropShortUrls: string[],
  shouldDrop: (expanded: string) => boolean,
): string {
  let text = raw
  const sorted = [...urls].sort((a, b) => b.url.length - a.url.length)
  for (const u of sorted) {
    text = text.split(u.url).join(shouldDrop(u.expanded) ? '' : u.expanded)
  }
  for (const short of dropShortUrls) {
    text = text.split(short).join('')
  }
  return decodeHtmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ── Media ────────────────────────────────────────────────────────────────────

/** Highest-bitrate MP4; falls back to any variant (e.g. HLS) so callers can explain the failure */
export function bestVideoVariant(variants: unknown): string | undefined {
  const list = arr(variants)
    .map((v) => obj(v))
    .filter((v): v is Json => !!v)
    .map((v) => ({
      url: str(v.url) ?? str(v.src),
      type: str(v.content_type) ?? str(v.type) ?? '',
      bitrate: num(v.bitrate) ?? num(v.bit_rate) ?? 0,
    }))
    .filter((v): v is { url: string; type: string; bitrate: number } => !!v.url)

  const mp4 = list
    .filter((v) => v.type === 'video/mp4' || /\.mp4(\?|$)/.test(v.url))
    .sort((a, b) => b.bitrate - a.bitrate)
  return mp4[0]?.url ?? list[0]?.url
}

/** v1.1 / GraphQL legacy / syndication `mediaDetails` entity */
function mediaFromEntity(input: unknown): ArchivedMedia | null {
  const m = obj(input)
  if (!m) return null
  const kind = str(m.type)
  const type = kind === 'video' ? 'video' : kind === 'animated_gif' || kind === 'gif' ? 'gif' : 'photo'
  const imageUrl = str(m.media_url_https) ?? str(m.media_url)
  const info = obj(m.original_info)
  const base = {
    width: num(info?.width),
    height: num(info?.height),
    altText: str(m.ext_alt_text) ?? str(m.alt_text),
  }

  if (type === 'photo') {
    const url = imageUrl ?? str(m.original) ?? str(m.url_https)
    return url ? { type, url, ...base } : null
  }

  const videoInfo = obj(m.video_info)
  // twitter-web-exporter style: { type, original, thumbnail }
  const url = bestVideoVariant(videoInfo?.variants) ?? str(m.original) ?? imageUrl
  if (!url) return null
  return {
    type,
    url,
    posterUrl: imageUrl ?? str(m.thumbnail),
    durationMs: num(videoInfo?.duration_millis),
    ...base,
  }
}

function mediaList(entities: unknown[]): ArchivedMedia[] {
  return entities.map(mediaFromEntity).filter((m): m is ArchivedMedia => m !== null)
}

/** Upgrade avatar thumbnails (`_normal`, `_bigger`, `_mini`) to 400×400 */
export function upgradeAvatarUrl(url: string | undefined): string | undefined {
  return url?.replace(/_(normal|bigger|mini)(\.[a-z]+)(\?|$)/i, '_400x400$2$3')
}

// ── Cards & polls ────────────────────────────────────────────────────────────

function cardFromBindings(
  name: string | undefined,
  bindings: Record<string, unknown>,
  fallbackUrl: string | undefined,
  urls: UrlEntity[],
): { card?: ArchivedLinkCard; poll?: ArchivedPoll } {
  const s = (key: string) => str(obj(bindings[key])?.string_value)
  const img = (key: string) => str(obj(obj(bindings[key])?.image_value)?.url)

  if (name && /^poll\d/.test(name)) {
    const choices: ArchivedPoll['choices'] = []
    for (let i = 1; i <= 4; i++) {
      const label = s(`choice${i}_label`)
      if (!label) continue
      choices.push({ label, votes: num(s(`choice${i}_count`)) })
    }
    if (choices.length > 0) {
      return { poll: { choices, endsAt: toIso(s('end_datetime_utc')) ?? undefined } }
    }
  }

  const title = s('title')
  if (!title) return {}
  const shortUrl = s('card_url') ?? fallbackUrl
  const expanded = urls.find((u) => u.url === shortUrl)?.expanded ?? shortUrl ?? ''
  return {
    card: {
      url: expanded,
      title,
      description: s('description'),
      domain: s('vanity_url') ?? s('domain'),
      imageUrl:
        img('thumbnail_image_original') ??
        img('summary_photo_image_original') ??
        img('photo_image_full_size_original') ??
        img('player_image_original') ??
        img('thumbnail_image_large') ??
        img('summary_photo_image') ??
        img('thumbnail_image'),
    },
  }
}

/** GraphQL cards ship binding_values as [{ key, value }] */
function graphqlCard(input: unknown, urls: UrlEntity[]) {
  const card = obj(input)
  const legacy = obj(card?.legacy)
  if (!legacy) return {}
  const bindings: Record<string, unknown> = {}
  for (const entry of arr(legacy.binding_values)) {
    const e = obj(entry)
    const key = str(e?.key)
    if (key) bindings[key] = e?.value
  }
  return cardFromBindings(str(legacy.name), bindings, str(legacy.url), urls)
}

/** Syndication cards ship binding_values as an object map */
function syndicationCard(input: unknown, urls: UrlEntity[]) {
  const card = obj(input)
  const bindings = obj(card?.binding_values)
  if (!bindings) return {}
  return cardFromBindings(str(card?.name), bindings, str(card?.url), urls)
}

// ── X Articles ───────────────────────────────────────────────────────────────

/** `media_entities[]` / `cover_media` entries: { media_id, media_info: { __typename, … } } */
function articleMedia(input: unknown): ArchivedMedia | null {
  const entry = obj(input)
  const info = obj(entry?.media_info)
  if (!info) return null
  const typename = str(info.__typename) ?? ''
  const variants = arr(info.variants)
  const poster = str(obj(info.preview_image)?.original_img_url) ?? str(info.original_img_url)

  if (variants.length > 0 || typename === 'ApiVideo' || typename === 'ApiGif') {
    const url = bestVideoVariant(variants) ?? poster
    if (!url) return null
    return {
      type: typename === 'ApiGif' ? 'gif' : 'video',
      url,
      posterUrl: poster,
      width: num(obj(info.preview_image)?.original_img_width) ?? num(info.original_img_width),
      height: num(obj(info.preview_image)?.original_img_height) ?? num(info.original_img_height),
      durationMs: num(info.duration_millis),
    }
  }

  const url = str(info.original_img_url)
  if (!url) return null
  return {
    type: 'photo',
    url,
    width: num(info.original_img_width),
    height: num(info.original_img_height),
  }
}

/** X serializes entityMap either as [{ key, value }] or as { "0": entity } */
function normalizeEntityMap(input: unknown): Map<string, Json> {
  const map = new Map<string, Json>()
  if (Array.isArray(input)) {
    input.forEach((entry, index) => {
      const e = obj(entry)
      if (!e) return
      const value = obj(e.value)
      if (value) map.set(idStr(e.key) ?? String(index), value)
      else map.set(String(index), e)
    })
  } else {
    for (const [key, value] of Object.entries(obj(input) ?? {})) {
      const v = obj(value)
      if (v) map.set(key, v)
    }
  }
  return map
}

/**
 * Split a block's text into styled spans. Draft.js raw offsets count Unicode
 * code points (not UTF-16 units), so index with Array.from().
 */
function buildSpans(text: string, styleRanges: unknown, entityRanges: unknown, entities: Map<string, Json>): TextSpan[] {
  const chars = Array.from(text)
  if (chars.length === 0) return []
  const styles: Set<string>[] = chars.map(() => new Set<string>())
  const links: (string | undefined)[] = chars.map(() => undefined)

  const eachIndex = (range: Json | undefined, fn: (i: number) => void) => {
    const offset = num(range?.offset) ?? 0
    const length = num(range?.length) ?? 0
    for (let i = Math.max(0, offset); i < Math.min(chars.length, offset + length); i++) fn(i)
  }

  for (const r of arr(styleRanges)) {
    const range = obj(r)
    const style = str(range?.style)?.toLowerCase()
    if (style) eachIndex(range, (i) => styles[i].add(style))
  }

  for (const r of arr(entityRanges)) {
    const range = obj(r)
    const entity = entities.get(idStr(range?.key) ?? '')
    const data = obj(entity?.data)
    const type = str(entity?.type)?.toUpperCase()
    let href: string | undefined
    if (type === 'LINK') href = str(data?.url) ?? str(data?.href)
    else if (type === 'MENTION') {
      const handle = str(data?.screenName) ?? str(data?.screen_name)
      if (handle) href = `https://x.com/${handle.replace(/^@/, '')}`
    }
    if (href) eachIndex(range, (i) => { links[i] = href })
  }

  const spans: TextSpan[] = []
  let lastKey: string | null = null
  chars.forEach((ch, i) => {
    const key = `${[...styles[i]].sort().join(',')}|${links[i] ?? ''}`
    if (key === lastKey) {
      spans[spans.length - 1].text += ch
      return
    }
    lastKey = key
    const s = styles[i]
    spans.push({
      text: ch,
      ...(s.has('bold') ? { bold: true } : {}),
      ...(s.has('italic') ? { italic: true } : {}),
      ...(s.has('strikethrough') ? { strike: true } : {}),
      ...(s.has('code') ? { code: true } : {}),
      ...(links[i] ? { href: links[i] } : {}),
    })
  })
  return spans
}

/** ```lang\ncode\n``` → code */
function stripCodeFences(markdown: string): string {
  const m = markdown.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return m ? m[1] : markdown
}

function convertArticleBlocks(rawBlocks: unknown[], entities: Map<string, Json>, mediaById: Map<string, ArchivedMedia>): ArticleBlock[] {
  const out: ArticleBlock[] = []

  for (const raw of rawBlocks) {
    const block = obj(raw)
    if (!block) continue
    const type = str(block.type) ?? 'unstyled'
    const text = typeof block.text === 'string' ? block.text : ''

    if (type === 'atomic') {
      const range = obj(arr(block.entityRanges)[0])
      const entity = entities.get(idStr(range?.key) ?? '')
      const entityType = str(entity?.type)?.toUpperCase()
      const data = obj(entity?.data) ?? {}

      if (entityType === 'MEDIA' || entityType === 'IMAGE' || entityType === 'VIDEO') {
        const media = arr(data.mediaItems)
          .map((item) => {
            const i = obj(item)
            return mediaById.get(idStr(i?.mediaId) ?? idStr(i?.media_id) ?? idStr(i?.localMediaId) ?? '')
          })
          .filter((m): m is ArchivedMedia => !!m)
        if (media.length > 0) {
          out.push({ type: 'media', media, ...(str(data.caption) ? { caption: str(data.caption) } : {}) })
        }
      } else if (entityType === 'TWEET' || entityType === 'POST') {
        const tweetId = idStr(data.tweetId) ?? idStr(data.tweet_id) ?? idStr(data.id)
        if (tweetId) {
          out.push({ type: 'embedded-tweet', tweetId, tweetUrl: `https://x.com/i/web/status/${tweetId}` })
        }
      } else if (entityType === 'DIVIDER') {
        out.push({ type: 'divider' })
      } else if (entityType === 'MARKDOWN' || entityType === 'LATEX' || entityType === 'CODE') {
        const source = str(data.markdown) ?? str(data.latex) ?? str(data.code) ?? str(data.text)
        if (source) out.push({ type: 'code', text: stripCodeFences(source) })
      } else if (text.trim()) {
        out.push({ type: 'paragraph', spans: [{ text }] })
      }
      continue
    }

    const spans = buildSpans(text, block.inlineStyleRanges, block.entityRanges, entities)
    const last = out[out.length - 1]

    switch (type) {
      case 'header-one':
        if (text.trim()) out.push({ type: 'heading1', spans })
        break
      case 'header-two':
        if (text.trim()) out.push({ type: 'heading2', spans })
        break
      case 'header-three':
      case 'header-four':
      case 'header-five':
      case 'header-six':
        if (text.trim()) out.push({ type: 'heading3', spans })
        break
      case 'unordered-list-item':
      case 'ordered-list-item': {
        const listType = type === 'ordered-list-item' ? 'ordered-list' : 'unordered-list'
        if (last && last.type === listType) last.items.push(spans)
        else out.push({ type: listType, items: [spans] })
        break
      }
      case 'blockquote':
        if (text.trim()) out.push({ type: 'blockquote', spans })
        break
      case 'code-block':
        if (last && last.type === 'code') last.text += `\n${text}`
        else out.push({ type: 'code', text })
        break
      default:
        if (text.trim()) out.push({ type: 'paragraph', spans })
    }
  }

  return out
}

function plainTextBlocks(text: string): ArticleBlock[] {
  return decodeHtmlEntities(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: 'paragraph', spans: [{ text: p }] }))
}

export function parseArticle(input: unknown): ArchivedArticle | null {
  const a = obj(input)
  if (!a) return null

  const mediaById = new Map<string, ArchivedMedia>()
  for (const entry of arr(a.media_entities)) {
    const media = articleMedia(entry)
    const e = obj(entry)
    if (!media || !e) continue
    for (const key of [e.media_id, e.id, e.media_key, e.rest_id]) {
      const id = idStr(key)
      if (id) mediaById.set(id, media)
    }
  }

  const contentState = obj(a.content_state)
  const rawBlocks = arr(contentState?.blocks)
  let blocks: ArticleBlock[] = []
  if (rawBlocks.length > 0) {
    blocks = convertArticleBlocks(rawBlocks, normalizeEntityMap(contentState?.entityMap), mediaById)
  } else if (str(a.plain_text)) {
    blocks = plainTextBlocks(str(a.plain_text)!)
  } else if (str(a.content)) {
    blocks = plainTextBlocks(str(a.content)!)
  }

  const title = decodeHtmlEntities(str(a.title) ?? '')
  const previewText = str(a.preview_text) ? decodeHtmlEntities(str(a.preview_text)!) : undefined
  const coverImage = articleMedia(a.cover_media) ?? (str(obj(a.preview_image)?.url) ? { type: 'photo' as const, url: str(obj(a.preview_image)?.url)! } : null)
  if (!title && blocks.length === 0 && !previewText && !coverImage) return null

  const publishedSecs = num(obj(a.metadata)?.first_published_at_secs)
  return {
    id: idStr(a.rest_id) ?? idStr(a.id),
    title,
    ...(previewText ? { previewText } : {}),
    ...(coverImage ? { coverImage } : {}),
    blocks,
    complete: blocks.length > 0,
    publishedAt: publishedSecs ? new Date(publishedSecs * 1000).toISOString() : null,
  }
}

// ── Source-specific parsers ──────────────────────────────────────────────────

function unavailableSnapshot(tweetId: string): TweetSnapshot {
  return { tweetId, text: '', media: [], unavailable: true }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Drop links X renders as attachments (quoted tweet, article, the tweet's own media page) */
function attachmentLinkFilter(tweetId: string, quoteId: string | undefined, hasArticle: boolean) {
  const quoteLink = quoteId ? new RegExp(`/status(?:es)?/${escapeRegExp(quoteId)}(?:[/?#]|$)`) : null
  const ownMediaLink = new RegExp(`/status/${escapeRegExp(tweetId)}/(?:photo|video)/\\d`)
  return (expanded: string) =>
    (!!quoteLink && quoteLink.test(expanded)) ||
    (hasArticle && /(?:x|twitter)\.com\/i\/article\//.test(expanded)) ||
    ownMediaLink.test(expanded)
}

export function snapshotFromGraphql(input: unknown, tweetIdHint = '', depth = 0): TweetSnapshot | null {
  let tweet = obj(input)
  if (!tweet) return null
  if (tweet.__typename === 'TweetWithVisibilityResults' && obj(tweet.tweet)) tweet = obj(tweet.tweet)!

  const legacy = obj(tweet.legacy) ?? {}
  const tweetId = idStr(tweet.rest_id) ?? idStr(legacy.id_str) ?? tweetIdHint
  const typename = str(tweet.__typename)
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return unavailableSnapshot(tweetId)
  if (!tweetId) return null

  const user = obj(obj(obj(tweet.core)?.user_results)?.result)
  const userLegacy = obj(user?.legacy)
  const userCore = obj(user?.core)

  const entities = obj(legacy.entities)
  const extended = obj(legacy.extended_entities)
  const mediaEntities = arr(extended?.media).length > 0 ? arr(extended?.media) : arr(entities?.media)

  const quoteResult = obj(obj(tweet.quoted_status_result)?.result)
  const quoteId = idStr(legacy.quoted_status_id_str) ?? idStr(quoteResult?.rest_id)
  let quote: TweetSnapshot | undefined
  if (depth === 0 && quoteResult) quote = snapshotFromGraphql(quoteResult, quoteId, depth + 1) ?? undefined
  else if (depth === 0 && quoteId) quote = unavailableSnapshot(quoteId)

  const article = parseArticle(obj(obj(tweet.article)?.article_results)?.result) ?? undefined

  const note = obj(obj(obj(tweet.note_tweet)?.note_tweet_results)?.result)
  const noteText = str(note?.text)
  const urls = [...urlEntities(entities?.urls), ...urlEntities(obj(note?.entity_set)?.urls)]
  const dropShort = mediaEntities.map((m) => str(obj(m)?.url)).filter((u): u is string => !!u)
  const shouldDrop = attachmentLinkFilter(tweetId, quoteId, !!article)

  const { card, poll } = graphqlCard(tweet.card, urls)

  return {
    tweetId,
    authorName: str(userCore?.name) ?? str(userLegacy?.name),
    authorHandle: str(userCore?.screen_name) ?? str(userLegacy?.screen_name),
    avatarUrl: upgradeAvatarUrl(str(obj(user?.avatar)?.image_url) ?? str(userLegacy?.profile_image_url_https)),
    createdAt: toIso(legacy.created_at),
    text: cleanText(noteText ?? str(legacy.full_text) ?? str(legacy.text) ?? '', urls, dropShort, shouldDrop),
    media: mediaList(mediaEntities),
    ...(quote ? { quote } : {}),
    ...(card ? { card } : {}),
    ...(poll ? { poll } : {}),
    ...(article ? { article } : {}),
  }
}

/** v1.1 objects, file-import conversions, API v2 and twitter-web-exporter rows */
export function snapshotFromLegacy(input: unknown, tweetIdHint = '', depth = 0): TweetSnapshot | null {
  const tweet = obj(input)
  if (!tweet) return null
  const tweetId = idStr(tweet.id_str) ?? idStr(tweet.id) ?? tweetIdHint
  if (!tweetId) return null

  const user = obj(tweet.user)
  const entities = obj(tweet.entities)
  const extended = obj(tweet.extended_entities)
  const mediaEntities =
    arr(extended?.media).length > 0 ? arr(extended?.media)
      : arr(entities?.media).length > 0 ? arr(entities?.media)
        : arr(tweet.media)

  const quoted = obj(tweet.quoted_status)
  const quoteId = idStr(tweet.quoted_status_id_str) ?? idStr(quoted?.id_str)
  let quote: TweetSnapshot | undefined
  if (depth === 0 && quoted) quote = snapshotFromLegacy(quoted, quoteId, depth + 1) ?? undefined

  const article = parseArticle(obj(obj(tweet.article)?.article_results)?.result ?? tweet.article) ?? undefined
  const urls = urlEntities(entities?.urls)
  const dropShort = mediaEntities.map((m) => str(obj(m)?.url)).filter((u): u is string => !!u && /^https?:\/\/t\.co\//.test(u))

  return {
    tweetId,
    authorName: str(user?.name) ?? str(tweet.name),
    authorHandle: str(user?.screen_name) ?? str(tweet.screen_name),
    avatarUrl: upgradeAvatarUrl(str(user?.profile_image_url_https) ?? str(tweet.profile_image_url)),
    createdAt: toIso(tweet.created_at),
    text: cleanText(str(tweet.full_text) ?? str(tweet.text) ?? '', urls, dropShort, attachmentLinkFilter(tweetId, quoteId, !!article)),
    media: mediaList(mediaEntities),
    ...(quote ? { quote } : {}),
    ...(article ? { article } : {}),
  }
}

/** cdn.syndication.twimg.com/tweet-result payload */
export function snapshotFromSyndication(input: unknown, tweetIdHint = '', depth = 0): TweetSnapshot | null {
  const tweet = obj(input)
  if (!tweet) return null
  const tweetId = idStr(tweet.id_str) ?? tweetIdHint
  if (tweet.__typename === 'TweetTombstone' || obj(tweet.tombstone)) return unavailableSnapshot(tweetId)
  if (!tweetId) return null

  const user = obj(tweet.user)
  const entities = obj(tweet.entities)
  const mediaDetails = arr(tweet.mediaDetails)
  const quoted = obj(tweet.quoted_tweet)
  const quoteId = idStr(quoted?.id_str)
  let quote: TweetSnapshot | undefined
  if (depth === 0 && quoted) quote = snapshotFromSyndication(quoted, quoteId, depth + 1) ?? undefined

  const article = parseArticle(tweet.article) ?? undefined
  const urls = urlEntities(entities?.urls)
  const dropShort = [...arr(entities?.media), ...mediaDetails]
    .map((m) => str(obj(m)?.url))
    .filter((u): u is string => !!u)
  const { card, poll } = syndicationCard(tweet.card, urls)

  return {
    tweetId,
    authorName: str(user?.name),
    authorHandle: str(user?.screen_name),
    avatarUrl: upgradeAvatarUrl(str(user?.profile_image_url_https)),
    createdAt: toIso(tweet.created_at),
    text: cleanText(str(tweet.text) ?? '', urls, dropShort, attachmentLinkFilter(tweetId, quoteId, !!article)),
    media: mediaList(mediaDetails),
    ...(quote ? { quote } : {}),
    ...(card ? { card } : {}),
    ...(poll ? { poll } : {}),
    ...(article ? { article } : {}),
  }
}

export type StoredFormat = 'graphql' | 'syndication' | 'legacy'

function storedFormat(tweet: Json): StoredFormat {
  if ('rest_id' in tweet || 'legacy' in tweet || tweet.__typename === 'TweetWithVisibilityResults') return 'graphql'
  if ('mediaDetails' in tweet || 'quoted_tweet' in tweet || tweet.__typename === 'Tweet') return 'syndication'
  return 'legacy'
}

/** Parse whatever was stored in Bookmark.rawJson at import time */
export function parseStoredRaw(
  rawJson: string | null | undefined,
  tweetIdHint = '',
): { format: StoredFormat; snapshot: TweetSnapshot | null } | null {
  if (!rawJson) return null
  let data: unknown
  try {
    data = JSON.parse(rawJson)
  } catch {
    return null
  }
  const tweet = obj(data)
  if (!tweet) return null
  const format = storedFormat(tweet)
  const snapshot =
    format === 'graphql' ? snapshotFromGraphql(tweet, tweetIdHint)
      : format === 'syndication' ? snapshotFromSyndication(tweet, tweetIdHint)
        : snapshotFromLegacy(tweet, tweetIdHint)
  return { format, snapshot }
}

export function snapshotFromStoredRaw(rawJson: string | null | undefined, tweetIdHint = ''): TweetSnapshot | null {
  return parseStoredRaw(rawJson, tweetIdHint)?.snapshot ?? null
}

// ── Merging ──────────────────────────────────────────────────────────────────

function betterArticle(a?: ArchivedArticle, b?: ArchivedArticle): ArchivedArticle | undefined {
  if (!a) return b
  if (!b) return a
  let pick = a
  if (b.complete && !a.complete) pick = b
  else if (a.complete === b.complete && b.blocks.length > a.blocks.length) pick = b
  const other = pick === a ? b : a
  return {
    ...pick,
    title: pick.title || other.title,
    previewText: pick.previewText ?? other.previewText,
    coverImage: pick.coverImage ?? other.coverImage,
    publishedAt: pick.publishedAt ?? other.publishedAt,
  }
}

/**
 * Combine a fresh copy from X (`primary`) with what was stored at import time
 * (`fallback`). Fresh data wins where it is richer; stored data fills the gaps
 * and is all we have once the post has been deleted.
 */
export function mergeSnapshots(primary: TweetSnapshot | null, fallback: TweetSnapshot | null): TweetSnapshot | null {
  if (!primary) return fallback
  if (!fallback) return primary

  const text = fallback.text.length > primary.text.length ? fallback.text : primary.text
  const media = fallback.media.length > primary.media.length ? fallback.media : primary.media

  let quote = primary.quote ?? fallback.quote
  if (primary.quote?.unavailable && fallback.quote && !fallback.quote.unavailable) {
    quote = { ...fallback.quote, unavailable: true }
  } else if (primary.quote && fallback.quote && !primary.quote.unavailable) {
    quote = mergeSnapshots(primary.quote, fallback.quote) ?? undefined
  }

  const article = betterArticle(primary.article, fallback.article)
  return {
    tweetId: primary.tweetId || fallback.tweetId,
    authorName: primary.authorName ?? fallback.authorName,
    authorHandle: primary.authorHandle ?? fallback.authorHandle,
    avatarUrl: primary.avatarUrl ?? fallback.avatarUrl,
    createdAt: primary.createdAt ?? fallback.createdAt,
    text,
    media,
    ...(quote ? { quote } : {}),
    ...(primary.card ?? fallback.card ? { card: primary.card ?? fallback.card } : {}),
    ...(primary.poll ?? fallback.poll ? { poll: primary.poll ?? fallback.poll } : {}),
    ...(article ? { article } : {}),
    ...(primary.unavailable || fallback.unavailable ? { unavailable: true } : {}),
  }
}

/** The content of a saved archive.json, or null if it was written by another archive version */
export function snapshotFromArchiveDoc(doc: ArchiveDocument | null): TweetSnapshot | null {
  if (!doc || doc.version !== ARCHIVE_VERSION) return null
  return {
    tweetId: doc.tweetId,
    authorName: doc.author.name,
    authorHandle: doc.author.handle,
    avatarUrl: doc.author.avatarUrl,
    createdAt: doc.createdAt,
    text: doc.text,
    media: doc.media,
    ...(doc.quote
      ? {
          quote: {
            tweetId: doc.quote.tweetId,
            authorName: doc.quote.author.name,
            authorHandle: doc.quote.author.handle,
            avatarUrl: doc.quote.author.avatarUrl,
            createdAt: doc.quote.createdAt,
            text: doc.quote.text,
            media: doc.quote.media,
            unavailable: doc.quote.unavailable,
          },
        }
      : {}),
    ...(doc.card ? { card: doc.card } : {}),
    ...(doc.poll ? { poll: doc.poll } : {}),
    ...(doc.article ? { article: doc.article } : {}),
  }
}
