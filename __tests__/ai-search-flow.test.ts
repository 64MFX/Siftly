/**
 * The whole AI search against a real database: the answer to the question
 * only appears in the body of an archived X Article, so finding it proves the
 * archive is read. The AI is a stub that records what it was sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ARCHIVE_VERSION, type ArchiveDocument } from '@/lib/archive-types'
import { ARTICLE_TWEET_ID, articleTweetTimelineOnly } from './fixtures/x-tweets'
import { createTestDatabase } from './helpers/test-db'

const ai = vi.hoisted(() => {
  const state: {
    prompts: string[]
    configured: boolean
    /** Reply to the request-understanding prompt */
    plan: string
    /** Reply to the ranking prompt, given the prompt */
    rank: (prompt: string) => string
  } = { prompts: [], configured: true, plan: '{}', rank: () => '{}' }
  return state
})

// Never reach a real CLI from tests
vi.mock('@/lib/claude-cli-auth', () => ({
  getCliAvailability: async () => false,
  claudePrompt: async () => ({ success: false }),
  modelNameToCliAlias: () => 'sonnet',
}))
vi.mock('@/lib/codex-cli', () => ({
  getCodexCliAvailability: async () => false,
  codexPrompt: async () => ({ success: false }),
}))
vi.mock('@/lib/ai-client', () => ({
  resolveAIClient: async () =>
    ai.configured
      ? {
          provider: 'anthropic',
          createMessage: async ({ messages }: { messages: { content: string }[] }) => {
            const prompt = messages[0].content
            ai.prompts.push(prompt)
            return { text: prompt.startsWith('You prepare searches') ? ai.plan : ai.rank(prompt) }
          },
        }
      : null,
}))

const dir = mkdtempSync(path.join(tmpdir(), 'siftly-ai-search-'))
const archiveRoot = path.join(dir, 'archive')

let aiSearch: (typeof import('@/lib/ai-search'))['aiSearch']
let prisma: (typeof import('@/lib/db'))['default']

/** The ref the ranking prompt gave the bookmark whose entry contains `marker` */
function refOf(prompt: string, marker: string): number {
  const entry = prompt.split('\n---\n').find((e) => e.includes(marker))
  return Number(entry?.match(/\[(\d+)\]/)?.[1] ?? 0)
}

beforeAll(async () => {
  process.env.DATABASE_URL = createTestDatabase(path.join(dir, 'test.db'))
  prisma = (await import('@/lib/db')).default
  aiSearch = (await import('@/lib/ai-search')).aiSearch

  await prisma.setting.create({ data: { key: 'archiveDir', value: archiveRoot } })
  await prisma.category.create({ data: { name: 'Dev Tools', slug: 'dev-tools' } })

  // An X Article whose body (only in the archive) explains how they scaled
  await mkdir(path.join(archiveRoot, ARTICLE_TWEET_ID), { recursive: true })
  const archived: ArchiveDocument = {
    version: ARCHIVE_VERSION,
    tweetId: ARTICLE_TWEET_ID,
    tweetUrl: `https://x.com/ada/status/${ARTICLE_TWEET_ID}`,
    author: { name: 'Ada Writer', handle: 'ada' },
    createdAt: '2025-10-01T12:00:00.000Z',
    archivedAt: '2025-10-02T12:00:00.000Z',
    text: '',
    media: [],
    article: {
      title: 'How we built it',
      complete: true,
      blocks: [
        { type: 'paragraph', spans: [{ text: 'A look back at our first year.' }] },
        ...Array.from({ length: 60 }, (_, i) => ({ type: 'paragraph' as const, spans: [{ text: `Story ${i} about the office, the team and the snacks.` }] })),
        { type: 'paragraph', spans: [{ text: 'To scale the database we moved to consistent hashing across shards.' }] },
      ],
    },
    sources: ['x-graphql'],
    warnings: [],
  }
  await writeFile(path.join(archiveRoot, ARTICLE_TWEET_ID, 'archive.json'), JSON.stringify(archived))
  await prisma.bookmark.create({
    data: {
      id: 'article',
      tweetId: ARTICLE_TWEET_ID,
      text: 'How we built it\n\nA short teaser',
      authorHandle: 'ada',
      authorName: 'Ada Writer',
      rawJson: JSON.stringify(articleTweetTimelineOnly),
      archivedAt: new Date(),
      archiveStatus: 'complete',
    },
  })
  for (let i = 0; i < 60; i++) {
    await prisma.bookmark.create({
      data: {
        id: `filler-${i}`,
        tweetId: String(1000 + i),
        text: i === 7 ? 'Database indexes explained for beginners' : `Random thought number ${i} about cooking`,
        authorHandle: `user${i}`,
        authorName: `User ${i}`,
        rawJson: '{}',
        tweetCreatedAt: new Date(Date.UTC(2025, 0, 1 + i)),
      },
    })
  }
})

afterAll(async () => {
  await prisma?.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  ai.prompts = []
  ai.configured = true
})

describe('aiSearch', () => {
  it('finds and answers from the full text of an archived X Article', async () => {
    ai.plan = JSON.stringify({
      intent: 'how they scaled their database',
      terms: ['sharding', 'consistent hashing', 'database scaling'],
      categories: ['dev-tools', 'not-a-category'],
      question: true,
    })
    ai.rank = (prompt) =>
      JSON.stringify({
        matches: [
          { ref: refOf(prompt, 'consistent hashing'), score: 0.95, reason: 'explains sharding with consistent hashing' },
          { ref: refOf(prompt, 'Database indexes'), score: 0.4, reason: 'about databases' },
        ],
        explanation: 'One article explains it.',
        answer: `They moved to consistent hashing across shards [${refOf(prompt, 'consistent hashing')}].`,
      })

    const result = await aiSearch('How did they scale the database?')

    expect(ai.prompts).toHaveLength(2)
    const rankPrompt = ai.prompts[1]
    // The AI read the article's opening and the passage near its end that answers the question
    const entry = rankPrompt.split('\n---\n').find((e) => e.includes('@ada'))!
    expect(entry).toContain('[1] @ada (Ada Writer) · X Article')
    expect(entry).toContain('article "How we built it": A look back at our first year.')
    expect(entry).toContain('… Story 59 about the office, the team and the snacks. To scale the database we moved to consistent hashing across shards.')
    expect(entry).not.toContain('Story 45 ')
    // The best match is listed first
    expect(rankPrompt.indexOf('@ada')).toBeLessThan(rankPrompt.indexOf('Database indexes'))
    expect(rankPrompt).toContain('Understood as: how they scaled their database')

    expect(result.bookmarks.map((b) => b.id)).toEqual(['article', 'filler-7'])
    expect(result.bookmarks[0]).toMatchObject({ aiScore: 0.95, aiReason: 'explains sharding with consistent hashing', archiveStatus: 'complete' })
    expect(result.answer).toBe('They moved to consistent hashing across shards [1].')
    expect(result.explanation).toBe('One article explains it.')
    expect(result.considered).toBeGreaterThanOrEqual(40)
  })

  it('serves a repeated search from the cache', async () => {
    const result = await aiSearch('how did they scale the database?')
    expect(ai.prompts).toHaveLength(0)
    expect(result.bookmarks[0].id).toBe('article')
  })

  it('searches again once the library changes', async () => {
    await prisma.bookmark.create({
      data: { id: 'new', tweetId: '9999', text: 'Postgres sharding war stories', authorHandle: 'pg', authorName: 'PG', rawJson: '{}' },
    })
    ai.rank = () => '{"matches": [], "explanation": "Nothing new."}'
    const result = await aiSearch('how did they scale the database?')
    expect(ai.prompts.some((p) => p.includes('Postgres sharding war stories'))).toBe(true)
    expect(result).toMatchObject({ bookmarks: [], explanation: 'Nothing new.', answer: null })
  })

  it('puts posts of the kind and time asked for first', async () => {
    ai.plan = JSON.stringify({ terms: ['database'], kinds: ['article'], after: '2020-01-01', before: '2030-01-01' })
    ai.rank = () => '{"matches": []}'
    await aiSearch('database articles from this decade')
    const prompt = ai.prompts[1]
    expect(prompt).toContain('They asked for: kind: X Articles; posted on/after 2020-01-01; posted on/before 2030-01-01')
    expect(prompt.split('\n---\n')[0]).toContain('[1] @ada (Ada Writer) · X Article')
  })

  it('lists keyword matches when no AI is set up', async () => {
    ai.configured = false
    const result = await aiSearch('consistent hashing')
    expect(ai.prompts).toHaveLength(0)
    expect(result.notice).toContain('AI ranking unavailable')
    expect(result.bookmarks.map((b) => b.id)).toEqual(['article'])
    expect(result.answer).toBeNull()
  })

  it('falls back to keyword matches when the AI reply is unreadable', async () => {
    ai.plan = 'not json'
    ai.rank = () => 'I could not do that'
    const result = await aiSearch('database indexes beginners')
    expect(result.notice).toContain('could not be read')
    expect(result.bookmarks[0].id).toBe('filler-7')
  })
})
