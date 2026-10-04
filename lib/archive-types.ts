/**
 * Shared types for the local bookmark archive.
 *
 * An archive is a folder per tweet under the archive root:
 *
 *   <root>/<tweetId>/archive.json   ← ArchiveDocument (this file's types)
 *   <root>/<tweetId>/index.html     ← self-contained offline page
 *   <root>/<tweetId>/content.md     ← Markdown copy with relative image links
 *   <root>/<tweetId>/source.json    ← raw JSON the archive was built from
 *   <root>/<tweetId>/media/…        ← photos, videos, GIFs, posters, avatars
 *
 * Every `file` / `posterFile` / `avatarFile` / `imageFile` below is relative to
 * the tweet's folder, so the folder can be moved or opened without Siftly.
 *
 * This module is imported by client components — keep it free of Node APIs.
 */

export const ARCHIVE_VERSION = 1

export type ArchiveStatus = 'complete' | 'partial' | 'failed'

export type ArchiveMediaType = 'photo' | 'video' | 'gif'

export interface ArchivedMedia {
  type: ArchiveMediaType
  /** Best-quality remote URL that was found (mp4 for video/gif) */
  url: string
  /** Remote poster frame for video/gif */
  posterUrl?: string
  /** Local copy, relative to the tweet folder — absent when the download failed */
  file?: string
  posterFile?: string
  width?: number
  height?: number
  altText?: string
  durationMs?: number
}

export interface ArchivedAuthor {
  name: string
  handle: string
  avatarUrl?: string
  avatarFile?: string
}

export interface ArchivedLinkCard {
  url: string
  title: string
  description?: string
  domain?: string
  imageUrl?: string
  imageFile?: string
}

export interface ArchivedPoll {
  choices: { label: string; votes?: number }[]
  endsAt?: string
}

export interface ArchivedQuote {
  tweetId: string
  tweetUrl: string
  author: ArchivedAuthor
  createdAt: string | null
  text: string
  media: ArchivedMedia[]
  unavailable?: boolean
}

export interface TextSpan {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  href?: string
}

export type ArticleBlock =
  | { type: 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'blockquote'; spans: TextSpan[] }
  | { type: 'unordered-list' | 'ordered-list'; items: TextSpan[][] }
  | { type: 'code'; text: string }
  | { type: 'media'; media: ArchivedMedia[]; caption?: string }
  | {
      type: 'embedded-tweet'
      tweetId: string
      tweetUrl: string
      authorName?: string
      authorHandle?: string
      text?: string
    }
  | { type: 'divider' }

export interface ArchivedArticle {
  id?: string
  title: string
  previewText?: string
  coverImage?: ArchivedMedia
  /** Body in reading order — images/videos sit where the author placed them */
  blocks: ArticleBlock[]
  /** False when X only returned the teaser (title + preview), not the full body */
  complete: boolean
  publishedAt?: string | null
}

export interface ArchiveDocument {
  version: number
  tweetId: string
  tweetUrl: string
  author: ArchivedAuthor
  createdAt: string | null
  archivedAt: string
  /** Full text — long-form "note tweets" expanded, t.co links replaced by their targets */
  text: string
  media: ArchivedMedia[]
  quote?: ArchivedQuote
  card?: ArchivedLinkCard
  poll?: ArchivedPoll
  article?: ArchivedArticle
  /** Where the content came from: "stored", "x-graphql", "x-syndication" */
  sources: string[]
  /** X reported the post as deleted / unavailable when it was archived */
  unavailableOnX?: boolean
  warnings: string[]
}

/** URL that serves a file from the local archive. `relPath` is relative to the archive root. */
export function archiveFileUrl(relPath: string): string {
  return `/api/archive/files/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

/** URL for a file inside one tweet's archive folder. */
export function tweetArchiveFileUrl(folder: string, relPath: string): string {
  return archiveFileUrl(`${folder}/${relPath}`)
}

export function tweetUrlFor(handle: string | undefined | null, tweetId: string): string {
  return handle && handle !== 'unknown'
    ? `https://x.com/${handle}/status/${tweetId}`
    : `https://x.com/i/web/status/${tweetId}`
}
