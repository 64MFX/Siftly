/**
 * X's GraphQL Bookmarks timeline, structurally faithful to what x.com's own
 * Bookmarks page receives (2026: the author's name and handle live in
 * `user.core`, `user.legacy` only holds the profile).
 */

export interface FixtureTweetOptions {
  handle?: string
  name?: string
  text?: string
  createdAt?: string
  photo?: boolean
  note?: string
  /** Pre-2026 shape: name and handle in user.legacy */
  legacyUser?: boolean
}

export function graphqlTweet(id: string, opts: FixtureTweetOptions = {}) {
  const handle = opts.handle ?? `user${id}`
  const name = opts.name ?? `User ${id}`
  const profile = {
    description: 'A long profile description that Siftly never reads '.repeat(4),
    followers_count: 1234,
    friends_count: 56,
    profile_banner_url: 'https://pbs.twimg.com/profile_banners/1/1',
    entities: { description: { urls: [] } },
  }
  const user = opts.legacyUser
    ? {
        __typename: 'User',
        rest_id: `9${id}`,
        legacy: { ...profile, name, screen_name: handle, profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/a_normal.jpg` },
      }
    : {
        __typename: 'User',
        rest_id: `9${id}`,
        core: { name, screen_name: handle, created_at: 'Mon Jan 01 00:00:00 +0000 2018' },
        avatar: { image_url: `https://pbs.twimg.com/profile_images/${id}/a_normal.jpg` },
        legacy: profile,
      }
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: user } },
    views: { count: '4200', state: 'EnabledWithCount' },
    edit_control: { edit_tweet_ids: [id], editable_until_msecs: '1', is_edit_eligible: false, edits_remaining: '5' },
    legacy: {
      id_str: id,
      full_text: opts.text ?? `Post ${id} &amp; more https://t.co/abc${id}`,
      created_at: opts.createdAt ?? 'Wed Oct 01 12:00:00 +0000 2026',
      entities: {
        hashtags: [{ text: 'ai', indices: [0, 3] }],
        user_mentions: [],
        urls: [{ url: `https://t.co/abc${id}`, expanded_url: `https://example.com/${id}`, display_url: `example.com/${id}` }],
      },
      ...(opts.photo
        ? {
            extended_entities: {
              media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg`, url: `https://t.co/m${id}` }],
            },
          }
        : {}),
    },
    ...(opts.note ? { note_tweet: { note_tweet_results: { result: { text: opts.note, entity_set: { urls: [] } } } } } : {}),
  }
}

/** X's placeholder for a post it won't show (deleted, suspended, protected) */
export function tombstone() {
  return { __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post is unavailable.' } } }
}

export function tweetEntry(id: string, result: unknown = graphqlTweet(id)) {
  return {
    entryId: `tweet-${id}`,
    sortIndex: `18${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        __typename: 'TimelineTweet',
        tweet_results: { result },
        tweetDisplayType: 'Tweet',
      },
    },
  }
}

export function cursorEntry(cursorType: 'Top' | 'Bottom', value: string) {
  return {
    entryId: `cursor-${cursorType.toLowerCase()}-${value}`,
    sortIndex: '0',
    content: {
      entryType: 'TimelineTimelineCursor',
      __typename: 'TimelineTimelineCursor',
      value,
      cursorType,
      ...(cursorType === 'Bottom' ? { stopOnEmptyResponse: true } : {}),
    },
  }
}

/** One Bookmarks response: these entries, then the top and bottom cursors */
export function bookmarksResponse(entries: unknown[], bottomCursor: string | null) {
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [...entries, cursorEntry('Top', 'top'), ...(bottomCursor ? [cursorEntry('Bottom', bottomCursor)] : [])],
            },
          ],
          responseObjects: { feedbackActions: [] },
        },
      },
    },
  }
}
