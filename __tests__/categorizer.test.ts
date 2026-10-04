import { describe, it, expect } from 'vitest'
import { buildCategorizationPrompt, mapBookmarkForCategorization } from '@/lib/categorizer'

const card = {
  url: 'https://github.com/liustack/modlens',
  title: 'GitHub - liustack/modlens: The first vision plugin for DeepSeek Harness',
  description: 'Plug-in vision for text-only LLMs.',
  domain: 'github.com',
  imagePath: '1800000000000000001/media/card.jpg',
}

function promptBookmarks(prompt: string): Record<string, unknown>[] {
  return JSON.parse(prompt.slice(prompt.indexOf('BOOKMARKS:') + 'BOOKMARKS:'.length))
}

describe('categorization input', () => {
  it('tells the categorizer what a bare link points at', () => {
    const bookmark = mapBookmarkForCategorization({
      tweetId: '1800000000000000001',
      text: 'https://t.co/kz411EKFNI',
      semanticTags: null,
      entities: null,
      linkCard: JSON.stringify(card),
      mediaItems: [],
    })
    expect(bookmark.link).toEqual(card)

    const prompt = buildCategorizationPrompt([bookmark], { 'dev-tools': 'Software engineering, GitHub' }, ['dev-tools', 'general'])
    expect(promptBookmarks(prompt)).toEqual([
      {
        id: '1800000000000000001',
        text: 'https://t.co/kz411EKFNI',
        link: {
          title: card.title,
          description: card.description,
          site: 'github.com',
          url: card.url,
        },
      },
    ])
    expect(prompt).toContain('the linked page IS the content')
  })

  it('leaves the link out when none is known', () => {
    const bookmark = mapBookmarkForCategorization({ tweetId: '2', text: 'Plain post', semanticTags: null, entities: null, linkCard: null, mediaItems: [] })
    expect(bookmark.link).toBeUndefined()
    expect(promptBookmarks(buildCategorizationPrompt([bookmark], {}, ['general']))).toEqual([{ id: '2', text: 'Plain post' }])
  })
})
