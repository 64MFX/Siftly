export interface MediaItem {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  imageTags?: string | null
  /** Archived copy, relative to the archive root — serve via archiveFileUrl() */
  localPath?: string | null
  localThumbnailPath?: string | null
}

/**
 * Preview of the page a post links to — X's own link card, or the page's Open
 * Graph tags. Shown on bookmark cards and read by the AI categorizer.
 */
export interface LinkCard {
  url: string
  title: string
  description?: string
  /** Site name or domain, e.g. "github.com" */
  domain?: string
  /** Remote preview image */
  imageUrl?: string
  /** Archived copy of the image, relative to the archive root — serve via archiveFileUrl() */
  imagePath?: string
}

export interface BookmarkCategory {
  id: string
  name: string
  slug: string
  color: string
  confidence: number | null
}

export interface BookmarkWithMedia {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string | null
  importedAt?: string
  archivedAt?: string | null
  archiveStatus?: string | null
  /** What the post links to, once known (see lib/link-card.ts) */
  linkCard?: LinkCard | null
  mediaItems: MediaItem[]
  categories: BookmarkCategory[]
}

export interface Category {
  id: string
  name: string
  slug: string
  color: string
  description: string | null
  isAiGenerated: boolean
  createdAt: string
  bookmarkCount: number
}

export interface StatsResponse {
  totalBookmarks: number
  totalCategories: number
  totalMedia: number
  recentBookmarks: BookmarkWithMedia[]
  topCategories: { name: string; slug: string; color: string; count: number }[]
}

export interface BookmarksResponse {
  bookmarks: BookmarkWithMedia[]
  total: number
  page: number
  limit: number
}
