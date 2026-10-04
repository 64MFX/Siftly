/**
 * Trimmed-down but structurally faithful X payloads used by the archive tests.
 */

/** GraphQL TweetResultByRestId result for a tweet that links an X Article */
export const ARTICLE_TWEET_ID = '1900000000000000001'
export const articleTweetGraphql = {
  __typename: 'Tweet',
  rest_id: ARTICLE_TWEET_ID,
  core: {
    user_results: {
      result: {
        __typename: 'User',
        core: { name: 'Ada Writer', screen_name: 'ada' },
        avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/ada_normal.jpg' },
        legacy: {},
      },
    },
  },
  legacy: {
    created_at: 'Wed Oct 01 12:00:00 +0000 2025',
    full_text: 'https://t.co/art1',
    entities: {
      hashtags: [],
      user_mentions: [],
      urls: [{ url: 'https://t.co/art1', expanded_url: 'http://x.com/i/article/1900000000000000999' }],
    },
  },
  article: {
    article_results: {
      result: {
        rest_id: '1900000000000000999',
        title: 'How we built it',
        preview_text: 'A short teaser',
        cover_media: {
          media_id: '111',
          media_info: {
            __typename: 'ApiImage',
            original_img_url: 'https://pbs.twimg.com/media/COVER1.jpg',
            original_img_width: 1500,
            original_img_height: 600,
          },
        },
        media_entities: [
          {
            media_id: '222',
            media_info: { __typename: 'ApiImage', original_img_url: 'https://pbs.twimg.com/media/INLINE1.jpg' },
          },
          {
            media_id: '333',
            media_info: {
              __typename: 'ApiVideo',
              preview_image: { original_img_url: 'https://pbs.twimg.com/amplify_video_thumb/333/img/p.jpg' },
              duration_millis: 12000,
              variants: [
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/333/pl/x.m3u8' },
                { content_type: 'video/mp4', bit_rate: 832000, url: 'https://video.twimg.com/amplify_video/333/vid/640x360/low.mp4' },
                { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/amplify_video/333/vid/1280x720/high.mp4' },
              ],
            },
          },
        ],
        metadata: { first_published_at_secs: 1759320000 },
        content_state: {
          blocks: [
            {
              key: 'a1',
              type: 'unstyled',
              text: 'Intro with bold and a link 🚀 here.',
              data: {},
              inlineStyleRanges: [{ offset: 11, length: 4, style: 'Bold' }],
              entityRanges: [{ key: 0, offset: 22, length: 4 }],
            },
            { key: 'a2', type: 'header-two', text: 'Section one', data: {}, inlineStyleRanges: [], entityRanges: [] },
            { key: 'a3', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 1, offset: 0, length: 1 }] },
            { key: 'a4', type: 'unordered-list-item', text: 'first point', data: {}, inlineStyleRanges: [], entityRanges: [] },
            { key: 'a5', type: 'unordered-list-item', text: 'second point', data: {}, inlineStyleRanges: [], entityRanges: [] },
            { key: 'a6', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 2, offset: 0, length: 1 }] },
            { key: 'a7', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 3, offset: 0, length: 1 }] },
            { key: 'a8', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 4, offset: 0, length: 1 }] },
            { key: 'a9', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 5, offset: 0, length: 1 }] },
            { key: 'b1', type: 'blockquote', text: 'Quoted wisdom', data: {}, inlineStyleRanges: [], entityRanges: [] },
            {
              key: 'b2',
              type: 'unstyled',
              text: 'Outro 🎉 done',
              data: {},
              inlineStyleRanges: [{ offset: 6, length: 1, style: 'Italic' }],
              entityRanges: [],
            },
            { key: 'b3', type: 'unstyled', text: '', data: {}, inlineStyleRanges: [], entityRanges: [] },
          ],
          entityMap: [
            { key: '0', value: { type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://example.com/docs' } } },
            {
              key: '1',
              value: {
                type: 'MEDIA',
                mutability: 'IMMUTABLE',
                data: { caption: 'The dashboard', mediaItems: [{ localMediaId: '1', mediaCategory: 'DraftTweetImage', mediaId: '222' }] },
              },
            },
            { key: '2', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaCategory: 'AmplifyVideo', mediaId: '333' }] } } },
            { key: '3', value: { type: 'TWEET', mutability: 'IMMUTABLE', data: { tweetId: '1800000000000000000' } } },
            { key: '4', value: { type: 'DIVIDER', mutability: 'IMMUTABLE', data: {} } },
            { key: '5', value: { type: 'MARKDOWN', mutability: 'IMMUTABLE', data: { markdown: '```ts\nconst x = 1\n```' } } },
          ],
        },
      },
    },
  },
}

/** What the Bookmarks timeline returns for the same article: teaser only */
export const articleTweetTimelineOnly = {
  ...articleTweetGraphql,
  article: {
    article_results: {
      result: {
        rest_id: '1900000000000000999',
        title: 'How we built it',
        preview_text: 'A short teaser',
        cover_media: articleTweetGraphql.article.article_results.result.cover_media,
      },
    },
  },
}

/** Long-form note tweet with photo, video, GIF, quoted tweet and link card */
export const NOTE_TWEET_ID = '1700000000000000001'
export const QUOTED_TWEET_ID = '1600000000000000001'
export const noteTweetGraphql = {
  __typename: 'TweetWithVisibilityResults',
  tweet: {
    __typename: 'Tweet',
    rest_id: NOTE_TWEET_ID,
    core: {
      user_results: {
        result: {
          legacy: {
            name: 'Bob',
            screen_name: 'bob',
            profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/bob_normal.png',
          },
        },
      },
    },
    note_tweet: {
      note_tweet_results: {
        result: {
          text: 'Full long text with &amp; entity and link https://t.co/ln1\n\nSecond paragraph that X truncates in legacy.full_text',
          entity_set: { urls: [{ url: 'https://t.co/ln1', expanded_url: 'https://github.com/foo/bar' }] },
        },
      },
    },
    legacy: {
      created_at: 'Mon Jan 01 00:00:00 +0000 2024',
      full_text: 'Full long text with &amp; entity and link https://t.co/ln1 https://t.co/q https://t.co/pic',
      quoted_status_id_str: QUOTED_TWEET_ID,
      entities: {
        urls: [
          { url: 'https://t.co/ln1', expanded_url: 'https://github.com/foo/bar' },
          { url: 'https://t.co/q', expanded_url: `https://twitter.com/carol/status/${QUOTED_TWEET_ID}` },
        ],
        media: [{ url: 'https://t.co/pic' }],
      },
      extended_entities: {
        media: [
          {
            type: 'photo',
            url: 'https://t.co/pic',
            media_url_https: 'https://pbs.twimg.com/media/PHOTO1.jpg',
            ext_alt_text: 'A cat',
            original_info: { width: 1200, height: 800 },
          },
          {
            type: 'video',
            url: 'https://t.co/pic',
            media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/444/pu/img/thumb.jpg',
            video_info: {
              duration_millis: 5000,
              variants: [
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/444/pu/pl/a.m3u8' },
                { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/444/pu/vid/320x180/a.mp4' },
                { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/ext_tw_video/444/pu/vid/1280x720/b.mp4' },
              ],
            },
          },
          {
            type: 'animated_gif',
            url: 'https://t.co/pic',
            media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/GIFKEY.jpg',
            video_info: { variants: [{ content_type: 'video/mp4', bitrate: 0, url: 'https://video.twimg.com/tweet_video/GIFKEY.mp4' }] },
          },
        ],
      },
    },
    quoted_status_result: {
      result: {
        __typename: 'Tweet',
        rest_id: QUOTED_TWEET_ID,
        core: { user_results: { result: { legacy: { name: 'Carol', screen_name: 'carol' } } } },
        legacy: {
          created_at: 'Sun Dec 31 00:00:00 +0000 2023',
          full_text: 'Quoted text https://t.co/qpic',
          entities: { urls: [], media: [{ url: 'https://t.co/qpic' }] },
          extended_entities: { media: [{ type: 'photo', url: 'https://t.co/qpic', media_url_https: 'https://pbs.twimg.com/media/QUOTE1.png' }] },
        },
      },
    },
    card: {
      rest_id: 'card://1',
      legacy: {
        name: 'summary_large_image',
        url: 'https://t.co/ln1',
        binding_values: [
          { key: 'title', value: { string_value: 'foo/bar on GitHub', type: 'STRING' } },
          { key: 'description', value: { string_value: 'A repository', type: 'STRING' } },
          { key: 'vanity_url', value: { string_value: 'github.com', type: 'STRING' } },
          { key: 'card_url', value: { string_value: 'https://t.co/ln1', type: 'STRING' } },
          {
            key: 'thumbnail_image_original',
            value: { image_value: { url: 'https://pbs.twimg.com/card_img/1/abc?format=jpg&name=orig' }, type: 'IMAGE' },
          },
        ],
      },
    },
  },
}

/** Syndication API payload (cdn.syndication.twimg.com/tweet-result) */
export const SYNDICATION_TWEET_ID = '1500000000000000001'
export const syndicationTweet = {
  __typename: 'Tweet',
  id_str: SYNDICATION_TWEET_ID,
  text: 'Hello &amp; welcome @alice https://t.co/v1',
  created_at: '2022-03-01T10:00:00.000Z',
  user: { name: 'Dee', screen_name: 'dee', profile_image_url_https: 'https://pbs.twimg.com/profile_images/3/dee_normal.jpg' },
  entities: { hashtags: [], urls: [], user_mentions: [], media: [{ url: 'https://t.co/v1' }] },
  mediaDetails: [
    {
      type: 'video',
      url: 'https://t.co/v1',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/555/pu/img/t.jpg',
      video_info: {
        variants: [
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/320x180/a.mp4' },
          { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/b.mp4' },
        ],
      },
    },
  ],
  card: {
    name: 'poll2choice_text_only',
    url: 'https://t.co/poll',
    binding_values: {
      choice1_label: { string_value: 'Yes', type: 'STRING' },
      choice1_count: { string_value: '30', type: 'STRING' },
      choice2_label: { string_value: 'No', type: 'STRING' },
      choice2_count: { string_value: '10', type: 'STRING' },
      end_datetime_utc: { string_value: '2022-03-02T10:00:00Z', type: 'STRING' },
    },
  },
}

/** What Siftly's file importer stores for a flat CSV-style export row */
export const flatExportRawJson = JSON.stringify({
  id_str: '1400000000000000001',
  full_text: 'From a flat export https://t.co/m1',
  created_at: 'Tue Feb 01 09:00:00 +0000 2022',
  user: { screen_name: 'erin', name: 'Erin' },
  entities: {
    hashtags: [],
    urls: [],
    media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/666/pu/img/only-thumb.jpg', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 0, url: 'https://pbs.twimg.com/ext_tw_video_thumb/666/pu/img/only-thumb.jpg' }] } }],
  },
})

/** A post that is nothing but a link — X's syndication payload, with the link card X shows */
export const LINK_TWEET_ID = '1800000000000000001'
export const linkOnlyTweetSyndication = {
  __typename: 'Tweet',
  id_str: LINK_TWEET_ID,
  text: 'https://t.co/kz411EKFNI',
  created_at: '2026-08-04T14:22:00.000Z',
  user: { name: 'AI Builder Club', screen_name: 'aibuilderclub_' },
  entities: { hashtags: [], urls: [{ url: 'https://t.co/kz411EKFNI', expanded_url: 'https://github.com/liustack/modlens' }], user_mentions: [] },
  card: {
    name: 'summary_large_image',
    url: 'https://t.co/kz411EKFNI',
    binding_values: {
      title: { string_value: 'GitHub - liustack/modlens: The first vision plugin for DeepSeek Harness', type: 'STRING' },
      description: { string_value: 'Plug-in vision for text-only LLMs. Paste an image, get structured JSON evidence.', type: 'STRING' },
      vanity_url: { string_value: 'github.com', type: 'STRING' },
      card_url: { string_value: 'https://t.co/kz411EKFNI', type: 'STRING' },
      thumbnail_image_original: { image_value: { url: 'https://pbs.twimg.com/card_img/9/modlens?format=jpg&name=orig' }, type: 'IMAGE' },
    },
  },
}
