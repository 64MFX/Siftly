import { describe, it, expect } from 'vitest'
import { X_EXPORT_BOOKMARKLET, X_EXPORT_FORMAT, X_EXPORT_SCRIPT } from '@/lib/x-export-script'
import { BOOKMARKS_FALLBACK_QUERY_ID } from '@/lib/x-web-client'

describe('the export bookmarklet', () => {
  it('is valid JavaScript, as a console script and as a bookmark', () => {
    expect(() => new Function(X_EXPORT_SCRIPT)).not.toThrow()
    expect(X_EXPORT_BOOKMARKLET.startsWith('javascript:')).toBe(true)
    const fromBookmark = decodeURIComponent(X_EXPORT_BOOKMARKLET.slice('javascript:'.length))
    expect(() => new Function(fromBookmark)).not.toThrow()
  })

  it('fits in a bookmark in every browser', () => {
    // Firefox drops bookmark URLs longer than 65,536 characters
    expect(X_EXPORT_BOOKMARKLET.length).toBeLessThan(60_000)
  })

  it('asks X with the current query ID and writes the format the importer reads', () => {
    expect(X_EXPORT_SCRIPT).toContain(BOOKMARKS_FALLBACK_QUERY_ID)
    expect(X_EXPORT_SCRIPT).toContain(`"format":"${X_EXPORT_FORMAT}"`)
  })
})
