/**
 * The searchable content of one bookmark — what a reader would see: the
 * post's full text, the quoted post, the link card, poll choices and the full
 * body of an X Article — flattened to plain text for the search index and the
 * AI search prompt.
 *
 * Content comes from the local archive when there is one (only it has the
 * full body of most X Articles, fetched with the X login) merged with the JSON
 * stored at import time.
 *
 * Pure functions only — no database, no filesystem.
 */
import type { ArchivedArticle, TextSpan } from '@/lib/archive-types'
import { decodeHtmlEntities, type TweetSnapshot } from '@/lib/tweet-snapshot'

/** Bump when the extracted content changes shape — every bookmark is re-indexed */
export const SEARCH_DOC_VERSION = 1

export type SearchKind = 'article' | 'video' | 'gif' | 'photo' | 'link' | 'quote' | 'poll'

export interface SearchDocument {
  author: { handle: string; name: string }
  /** The post's own text — long-form posts in full, t.co links expanded */
  text: string
  quote?: { handle: string; name: string; text: string }
  link?: { url: string; title: string; description?: string; domain?: string }
  poll?: string[]
  /** `complete` is false when only the article's title and teaser are known */
  article?: { title: string; text: string; complete: boolean }
  /** Links to other sites in the post */
  urls: string[]
  /** Alt text of attached images */
  altText: string[]
  kinds: SearchKind[]
}

export interface SearchSourceBookmark {
  text: string
  authorHandle: string
  authorName: string
  /** MediaItem types — used when the stored JSON couldn't be parsed */
  mediaTypes?: string[]
}

// ── Building the document ────────────────────────────────────────────────────

function spansText(spans: TextSpan[]): string {
  return spans.map((s) => s.text).join('').trim()
}

/** An X Article's body as plain text, one paragraph per block, in reading order */
export function articlePlainText(article: ArchivedArticle): string {
  const parts: string[] = []
  for (const block of article.blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'blockquote':
      case 'heading1':
      case 'heading2':
      case 'heading3':
        parts.push(spansText(block.spans))
        break
      case 'unordered-list':
      case 'ordered-list':
        parts.push(
          block.items
            .map((item, i) => `${block.type === 'ordered-list' ? `${i + 1}.` : '-'} ${spansText(item)}`)
            .join('\n'),
        )
        break
      case 'code':
        parts.push(block.text.trim())
        break
      case 'media':
        parts.push([block.caption, ...block.media.map((m) => m.altText)].filter(Boolean).join(' — '))
        break
      case 'embedded-tweet':
        if (block.text) parts.push(`${block.authorHandle ? `@${block.authorHandle}: ` : ''}${block.text.trim()}`)
        break
      case 'divider':
        break
    }
  }
  const body = parts.filter(Boolean).join('\n\n')
  return body || article.previewText?.trim() || ''
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const X_LINK_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:i\/article\/|[^/]+\/status\/)/i

/** Links to other sites in a post's text (X status and article links are attachments, not links) */
export function externalUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, '')
    if (!X_LINK_RE.test(url)) urls.add(url)
  }
  return [...urls]
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/**
 * Everything searchable about a bookmark. `snapshot` is the stored JSON
 * merged with the archive (see snapshotFromArchiveDoc); null when neither
 * could be read, in which case the text saved at import time is used.
 */
export function buildSearchDocument(snapshot: TweetSnapshot | null, bookmark: SearchSourceBookmark): SearchDocument {
  const handle = snapshot?.authorHandle ?? (bookmark.authorHandle !== 'unknown' ? bookmark.authorHandle : '')
  const name = snapshot?.authorName ?? bookmark.authorName

  const article = snapshot?.article
    ? { title: snapshot.article.title, text: articlePlainText(snapshot.article), complete: snapshot.article.complete }
    : undefined
  // An article post's own text is usually empty; what was saved at import is the article's teaser
  let text = snapshot?.text ?? ''
  if (!text && !article) text = decodeHtmlEntities(bookmark.text).trim()

  const quote = snapshot?.quote && (snapshot.quote.text || snapshot.quote.authorHandle)
    ? { handle: snapshot.quote.authorHandle ?? '', name: snapshot.quote.authorName ?? '', text: snapshot.quote.text }
    : undefined
  const card = snapshot?.card
  const link = card
    ? {
        url: card.url,
        title: card.title,
        ...(card.description ? { description: card.description } : {}),
        ...(card.domain ?? domainOf(card.url) ? { domain: card.domain ?? domainOf(card.url) } : {}),
      }
    : undefined
  const poll = snapshot?.poll?.choices.map((c) => c.label).filter(Boolean)
  const urls = externalUrls(text)

  const mediaTypes = snapshot ? snapshot.media.map((m) => m.type) : bookmark.mediaTypes ?? []
  const kinds = new Set<SearchKind>()
  if (article) kinds.add('article')
  for (const type of mediaTypes) {
    if (type === 'video' || type === 'gif' || type === 'photo') kinds.add(type)
  }
  if (link || urls.length > 0) kinds.add('link')
  if (quote) kinds.add('quote')
  if (poll?.length) kinds.add('poll')

  return {
    author: { handle, name },
    text,
    ...(quote ? { quote } : {}),
    ...(link ? { link } : {}),
    ...(poll?.length ? { poll } : {}),
    ...(article ? { article } : {}),
    urls,
    altText: (snapshot?.media ?? []).map((m) => m.altText).filter((a): a is string => !!a),
    kinds: [...kinds],
  }
}

// ── Index rows ───────────────────────────────────────────────────────────────

export interface SearchRowInput {
  doc: SearchDocument
  semanticTags: string | null
  entities: string | null
  enrichmentMeta: string | null
  imageTags: (string | null)[]
}

/** Columns of the FTS5 index, weighted differently when ranking */
export interface SearchRow {
  author: string
  title: string
  body: string
  article: string
  tags: string
  media: string
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap(strings)
  return []
}

const IMAGE_FIELDS = ['text_ocr', 'meme_template', 'scene', 'action', 'people', 'objects', 'mood', 'style', 'tags']

/** The values of an image analysis (OCR text, scene, objects, tags…) without its JSON keys */
export function flattenImageTags(raw: string | null | undefined): string {
  if (!raw || raw === '{}') return ''
  const parsed = parseJson<Record<string, unknown>>(raw)
  if (!parsed || typeof parsed !== 'object') return raw
  return IMAGE_FIELDS.flatMap((field) => strings(parsed[field])).join(' · ')
}

export function buildSearchRow(input: SearchRowInput): SearchRow {
  const { doc } = input
  const entities = parseJson<{ hashtags?: unknown; mentions?: unknown; tools?: unknown }>(input.entities)
  const meta = parseJson<{ people?: unknown; companies?: unknown }>(input.enrichmentMeta)
  const join = (parts: (string | undefined)[], sep = '\n') => parts.filter(Boolean).join(sep)

  return {
    author: join([
      doc.author.handle && `@${doc.author.handle}`,
      doc.author.name,
      doc.quote?.handle && `@${doc.quote.handle}`,
      doc.quote?.name,
    ], ' '),
    title: join([doc.article?.title, doc.link?.title]),
    body: join([
      doc.text,
      doc.quote?.text,
      doc.link?.description,
      doc.link?.domain,
      doc.link?.url,
      ...(doc.poll ?? []),
      ...doc.altText,
    ]),
    article: doc.article?.text ?? '',
    tags: join([
      ...strings(parseJson(input.semanticTags)),
      ...strings(entities?.hashtags),
      ...strings(entities?.tools),
      ...strings(entities?.mentions),
      ...strings(meta?.people),
      ...strings(meta?.companies),
    ], ' · '),
    media: join(input.imageTags.map(flattenImageTags), '\n'),
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** One search term as an FTS5 string: quoted (so it can't inject syntax), prefix-matched when it's a long word */
export function ftsTerm(term: string): string | null {
  const words = term.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return null
  const phrase = `"${words.join(' ')}"`
  return words.length === 1 && words[0].length >= 5 ? `${phrase}*` : phrase
}

/** FTS5 MATCH expression: every term (`all`) or any of them (`any`). Null when nothing is searchable */
export function buildMatchExpression(terms: string[], mode: 'all' | 'any'): string | null {
  const parts = [...new Set(terms.map(ftsTerm).filter((t): t is string => !!t))]
  if (parts.length === 0) return null
  return parts.join(mode === 'all' ? ' AND ' : ' OR ')
}

// ── Excerpts ─────────────────────────────────────────────────────────────────

const EXCERPT_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'your', 'about'])

/** Crude stems of the words in `terms`, for spotting them in text */
export function termStems(terms: string[]): string[] {
  const stems = new Set<string>()
  for (const word of terms.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u))) {
    if (word.length < 2 || EXCERPT_STOP_WORDS.has(word)) continue
    let stem = word
    if (stem.length > 5) stem = stem.replace(/(?:ing|ed|es|ly)$/, '')
    if (stem.length > 3) stem = stem.replace(/s$/, '')
    stems.add(stem)
  }
  return [...stems]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split text into paragraphs, breaking very long ones at sentence ends */
function chunks(text: string, maxChunk: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n\s*\n|\n(?=[-•\d]+[.)]?\s)/)) {
    const p = para.replace(/\s+/g, ' ').trim()
    if (!p) continue
    if (p.length <= maxChunk) {
      out.push(p)
      continue
    }
    let current = ''
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (current && current.length + sentence.length + 1 > maxChunk) {
        out.push(current)
        current = ''
      }
      current = current ? `${current} ${sentence}` : sentence
    }
    if (current) out.push(current)
  }
  return out
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * Up to `maxChars` of `text` for a reader deciding whether it's relevant: the
 * opening (what it's about) plus the passages that mention the search terms,
 * in their original order, gaps marked with "…".
 */
export function excerpt(text: string, terms: string[], maxChars: number): string {
  const clean = text.trim()
  if (clean.length <= maxChars) return clean.replace(/\s+/g, ' ')

  const parts = chunks(clean, Math.max(200, Math.floor(maxChars / 3)))
  const patterns = termStems(terms).map((s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}`, 'iu'))
  const scores = parts.map((p) => patterns.reduce((n, re) => n + (re.test(p) ? 1 : 0), 0))
  const ranked = parts
    .map((_, i) => i)
    .filter((i) => i > 0 && scores[i] > 0)
    .sort((a, b) => scores[b] - scores[a] || a - b)

  // Matching passages, then what surrounds them, then on from the top
  const around = ranked.flatMap((i) => [i + 1, i - 1]).filter((i) => i > 0 && i < parts.length)
  const queue = [...ranked, ...around, ...parts.map((_, i) => i).slice(1)]
  const pieces = new Map<number, string>([[0, clip(parts[0], ranked.length > 0 ? Math.floor(maxChars * 0.35) : maxChars)]])
  let used = pieces.get(0)!.length
  for (const i of queue) {
    if (pieces.has(i)) continue
    const room = maxChars - used - 3
    if (room < 20) break
    // A little room left still fits a short paragraph, but not a clipped stub of a long one
    if (parts[i].length > room && room < 60) continue
    const piece = clip(parts[i], room)
    pieces.set(i, piece)
    used += piece.length + 3
  }

  const order = [...pieces.keys()].sort((a, b) => a - b)
  let out = ''
  order.forEach((i, n) => {
    if (n > 0) out += i === order[n - 1] + 1 || out.endsWith('…') ? ' ' : ' … '
    out += pieces.get(i)
  })
  return order[order.length - 1] < parts.length - 1 && !out.endsWith('…') ? `${out} …` : out
}
