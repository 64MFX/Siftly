import { describe, it, expect } from 'vitest'
import {
  articlePlainText,
  buildMatchExpression,
  buildSearchDocument,
  buildSearchRow,
  excerpt,
  externalUrls,
  flattenImageTags,
  ftsTerm,
} from '@/lib/search-document'
import { snapshotFromStoredRaw, snapshotFromGraphql } from '@/lib/tweet-snapshot'
import { extractKeywords } from '@/lib/search-utils'
import {
  ARTICLE_TWEET_ID,
  articleTweetGraphql,
  articleTweetTimelineOnly,
  NOTE_TWEET_ID,
  noteTweetGraphql,
} from './fixtures/x-tweets'

const bookmark = { text: 'stored text', authorHandle: 'someone', authorName: 'Someone' }

describe('buildSearchDocument', () => {
  it('reads the full body of an X Article', () => {
    const doc = buildSearchDocument(snapshotFromGraphql(articleTweetGraphql, ARTICLE_TWEET_ID), bookmark)
    expect(doc.author).toEqual({ handle: 'ada', name: 'Ada Writer' })
    expect(doc.kinds).toContain('article')
    expect(doc.article).toMatchObject({ title: 'How we built it', complete: true })
    // Paragraphs, headings, list items, captions and code — in reading order
    const text = doc.article!.text
    for (const part of ['Intro with bold and a link', 'Section one', 'The dashboard', '- first point\n- second point', 'Quoted wisdom', 'const x = 1', 'Outro']) {
      expect(text).toContain(part)
    }
    expect(text.indexOf('Section one')).toBeLessThan(text.indexOf('Outro'))
    // The post itself is just the article link, which isn't searchable text
    expect(doc.text).toBe('')
    expect(doc.urls).toEqual([])
  })

  it('marks an article with only its teaser as incomplete', () => {
    const doc = buildSearchDocument(snapshotFromGraphql(articleTweetTimelineOnly, ARTICLE_TWEET_ID), bookmark)
    expect(doc.article).toEqual({ title: 'How we built it', text: 'A short teaser', complete: false })
  })

  it('collects long text, quoted post, link card, media kinds and alt text', () => {
    const doc = buildSearchDocument(snapshotFromStoredRaw(JSON.stringify(noteTweetGraphql), NOTE_TWEET_ID), bookmark)
    expect(doc.text).toContain('Second paragraph that X truncates')
    expect(doc.text).toContain('https://github.com/foo/bar')
    expect(doc.quote).toEqual({ handle: 'carol', name: 'Carol', text: 'Quoted text' })
    expect(doc.link).toMatchObject({ title: 'foo/bar on GitHub', description: 'A repository', domain: 'github.com' })
    expect(doc.urls).toEqual(['https://github.com/foo/bar'])
    expect(doc.altText).toEqual(['A cat'])
    expect(doc.kinds.sort()).toEqual(['gif', 'link', 'photo', 'quote', 'video'])
  })

  it('falls back to the text saved at import', () => {
    const doc = buildSearchDocument(null, { text: 'Tom &amp; Jerry', authorHandle: 'unknown', authorName: 'Unknown', mediaTypes: ['video'] })
    expect(doc).toMatchObject({ text: 'Tom & Jerry', author: { handle: '', name: 'Unknown' }, kinds: ['video'] })
  })
})

describe('articlePlainText', () => {
  it('uses the preview when there is no body', () => {
    expect(articlePlainText({ title: 'T', previewText: 'Teaser', blocks: [], complete: false })).toBe('Teaser')
  })

  it('includes embedded posts with their author', () => {
    const text = articlePlainText({
      title: 'T',
      complete: true,
      blocks: [
        { type: 'ordered-list', items: [[{ text: 'one' }], [{ text: 'two' }]] },
        { type: 'embedded-tweet', tweetId: '1', tweetUrl: 'u', authorHandle: 'bob', text: 'embedded words' },
        { type: 'divider' },
      ],
    })
    expect(text).toBe('1. one\n2. two\n\n@bob: embedded words')
  })
})

describe('externalUrls', () => {
  it('skips X posts and articles and trailing punctuation', () => {
    expect(
      externalUrls('see https://example.com/a. and https://x.com/i/article/1 or https://twitter.com/a/status/2 (https://b.dev/x)'),
    ).toEqual(['https://example.com/a', 'https://b.dev/x'])
  })
})

describe('buildSearchRow', () => {
  it('spreads content, tags and image analysis over the index columns', () => {
    const doc = buildSearchDocument(snapshotFromStoredRaw(JSON.stringify(noteTweetGraphql), NOTE_TWEET_ID), bookmark)
    const row = buildSearchRow({
      doc,
      semanticTags: '["rust tooling","cli"]',
      entities: '{"hashtags":["rustlang"],"tools":["cargo"],"mentions":["alice"]}',
      enrichmentMeta: '{"people":["Linus"],"companies":["Mozilla"]}',
      imageTags: ['{"text_ocr":["HELLO WORLD"],"tags":["terminal"],"_type":"x"}', null, '{}'],
    })
    expect(row.author).toBe('@bob Bob @carol Carol')
    expect(row.title).toBe('foo/bar on GitHub')
    expect(row.body).toContain('Quoted text')
    expect(row.body).toContain('A repository')
    expect(row.body).toContain('A cat')
    expect(row.tags).toBe('rust tooling · cli · rustlang · cargo · alice · Linus · Mozilla')
    expect(row.media).toBe('HELLO WORLD · terminal')
    expect(row.article).toBe('')
  })

  it('survives broken JSON', () => {
    const row = buildSearchRow({ doc: buildSearchDocument(null, bookmark), semanticTags: '[', entities: '{', enrichmentMeta: null, imageTags: ['not json'] })
    expect(row).toMatchObject({ body: 'stored text', tags: '', media: 'not json' })
  })
})

describe('flattenImageTags', () => {
  it('keeps values, not keys', () => {
    expect(flattenImageTags('{"scene":"office","meme_template":null,"people":["a man"],"objects":["laptop"]}')).toBe('office · a man · laptop')
    expect(flattenImageTags('{}')).toBe('')
    expect(flattenImageTags(null)).toBe('')
  })
})

describe('FTS queries', () => {
  it('quotes every term so query syntax is literal', () => {
    expect(ftsTerm('Agents')).toBe('"agents"*')
    expect(ftsTerm('AI')).toBe('"ai"')
    expect(ftsTerm('fine-tune')).toBe('"fine tune"')
    expect(ftsTerm('"NEAR(" OR *')).toBe('"near or"')
    expect(ftsTerm('***')).toBeNull()
  })

  it('joins terms with AND / OR and drops duplicates', () => {
    expect(buildMatchExpression(['rust', 'Rust', 'cli'], 'all')).toBe('"rust" AND "cli"')
    expect(buildMatchExpression(['kyc', 'identity verification'], 'any')).toBe('"kyc" OR "identity verification"')
    expect(buildMatchExpression(['!!'], 'any')).toBeNull()
  })
})

describe('excerpt', () => {
  const article = [
    'Opening paragraph that says what the piece is about.',
    'Unrelated filler about the weather and the commute.',
    'More filler about lunch.',
    'Here we finally discuss consistent hashing in depth.',
    'Closing thoughts.',
  ].join('\n\n')

  it('returns short text whole', () => {
    expect(excerpt('short', ['x'], 100)).toBe('short')
  })

  it('keeps the opening and the passages mentioning the terms, with what surrounds them', () => {
    const out = excerpt(article, ['hashing'], 160)
    expect(out).toBe(
      'Opening paragraph that says what the piece is about. … More filler about lunch. Here we finally discuss consistent hashing in depth. Closing thoughts.',
    )
    expect(excerpt(article, ['hashing'], 130)).toBe(
      'Opening paragraph that says what the piece… Here we finally discuss consistent hashing in depth. Closing thoughts.',
    )
  })

  it('reads on from the top when nothing matches', () => {
    const out = excerpt(article, ['zebra'], 120)
    expect(out.startsWith('Opening paragraph')).toBe(true)
    expect(out).toContain('Unrelated filler')
    expect(out.endsWith('…')).toBe(true)
  })

  it('matches word forms', () => {
    expect(excerpt(article, ['hashes'], 130)).toContain('consistent hashing')
  })
})

describe('extractKeywords', () => {
  it('drops question and filler words', () => {
    expect(extractKeywords('What did people say about the KYC thread I saved?')).toEqual(['people', 'kyc'])
  })

  it('keeps non-English words and short acronyms', () => {
    expect(extractKeywords('diseño de UI en Figma')).toEqual(['diseño', 'de', 'ui', 'en', 'figma'])
  })
})
