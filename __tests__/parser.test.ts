import { describe, it, expect } from 'vitest'
import { parseBookmarksJson } from '@/lib/parser'
import { X_EXPORT_FORMAT } from '@/lib/x-export-script'
import { importedTweetFromGraphql } from '@/lib/x-tweet-import'
import { graphqlTweet, tombstone } from './fixtures/x-bookmarks'

describe('parseBookmarksJson', () => {
  it("reads the bookmarklet's export: X's own data for each post", () => {
    const file = {
      format: X_EXPORT_FORMAT,
      version: 2,
      source: 'bookmark',
      complete: true,
      tweets: [graphqlTweet('1', { handle: 'ada', name: 'Ada', photo: true }), graphqlTweet('2', { note: 'The whole long post' }), tombstone()],
    }
    const parsed = parseBookmarksJson(JSON.stringify(file))
    expect(parsed.map((b) => b.tweetId)).toEqual(['1', '2'])
    expect(parsed[0]).toMatchObject({ authorHandle: 'ada', authorName: 'Ada', hashtags: ['ai'], urls: ['https://example.com/1'] })
    expect(parsed[0].media).toEqual([{ type: 'photo', url: 'https://pbs.twimg.com/media/1.jpg', thumbnailUrl: 'https://pbs.twimg.com/media/1.jpg' }])
    expect(parsed[1].text).toBe('The whole long post')
    expect(parsed[0].rawJson).toBe(importedTweetFromGraphql(graphqlTweet('1', { handle: 'ada', name: 'Ada', photo: true }))!.rawJson)
  })

  it('reads a plain array of GraphQL tweets', () => {
    const parsed = parseBookmarksJson(JSON.stringify([graphqlTweet('5'), { __typename: 'TweetWithVisibilityResults', tweet: graphqlTweet('6') }]))
    expect(parsed.map((b) => [b.tweetId, b.authorHandle])).toEqual([['5', 'user5'], ['6', 'user6']])
  })

  it("still reads the old bookmarklet's files", () => {
    const old = {
      bookmarks: [{ id: '9', author: 'Bob', handle: '@bob', timestamp: 'Wed Oct 01 12:00:00 +0000 2026', text: 'hi', media: [], hashtags: [], urls: [] }],
      source: 'bookmark',
    }
    expect(parseBookmarksJson(JSON.stringify(old))).toMatchObject([{ tweetId: '9', authorHandle: 'bob', authorName: 'Bob', text: 'hi' }])
  })
})
