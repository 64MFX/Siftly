import { describe, it, expect } from 'vitest'
import { ARTICLE_WHERE } from '@/lib/bookmark-filters'
import {
  articleTweetGraphql,
  articleTweetTimelineOnly,
  flatExportRawJson,
  noteTweetGraphql,
  syndicationTweet,
} from './fixtures/x-tweets'

/** What SQLite's LIKE '%…%' (Prisma `contains`) does with the fragment, on rawJson as importers store it */
function matchesArticle(rawJson: string): boolean {
  return ARTICLE_WHERE.OR.some((c) => rawJson.toLowerCase().includes(c.rawJson.contains.toLowerCase()))
}

describe('ARTICLE_WHERE', () => {
  it('matches X Articles in the formats importers store', () => {
    expect(matchesArticle(JSON.stringify(articleTweetGraphql))).toBe(true)
    expect(matchesArticle(JSON.stringify(articleTweetTimelineOnly))).toBe(true)
    // syndication / v1.1 put the article object at the top level
    expect(matchesArticle(JSON.stringify({ ...syndicationTweet, article: { rest_id: '1', title: 'T' } }))).toBe(true)
  })

  it('matches imports that only kept the article link', () => {
    const row = {
      id_str: '1',
      full_text: 'https://t.co/a',
      entities: { urls: [{ url: 'https://t.co/a', expanded_url: 'https://x.com/i/article/1900000000000000999' }] },
    }
    expect(matchesArticle(JSON.stringify(row))).toBe(true)
  })

  it('leaves ordinary posts out', () => {
    expect(matchesArticle(JSON.stringify(noteTweetGraphql))).toBe(false)
    expect(matchesArticle(JSON.stringify(syndicationTweet))).toBe(false)
    expect(matchesArticle(flatExportRawJson)).toBe(false)
    expect(matchesArticle(JSON.stringify({ id_str: '1', full_text: 'no article here', article: null }))).toBe(false)
  })
})
