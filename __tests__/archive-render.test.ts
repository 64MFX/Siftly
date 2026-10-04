import { describe, it, expect } from 'vitest'
import { escapeHtml, renderArchiveHtml, renderArchiveMarkdown, safeExternalHref } from '@/lib/archive-render'
import { ARCHIVE_VERSION, type ArchiveDocument } from '@/lib/archive-types'

function doc(overrides: Partial<ArchiveDocument> = {}): ArchiveDocument {
  return {
    version: ARCHIVE_VERSION,
    tweetId: '1',
    tweetUrl: 'https://x.com/ada/status/1',
    author: { name: 'Ada', handle: 'ada', avatarFile: 'media/avatar-abc.jpg' },
    createdAt: '2025-01-01T00:00:00.000Z',
    archivedAt: '2025-02-01T00:00:00.000Z',
    text: 'Hello @bob see https://example.com/page.',
    media: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg', file: 'media/photo-1.jpg', altText: 'alt "text"' },
      { type: 'video', url: 'https://video.twimg.com/v.mp4', file: 'media/video-1.mp4', posterFile: 'media/poster-1.jpg' },
      { type: 'gif', url: 'https://video.twimg.com/g.mp4' },
    ],
    sources: ['stored'],
    warnings: [],
    ...overrides,
  }
}

describe('renderArchiveHtml', () => {
  it('references local media with relative paths', () => {
    const html = renderArchiveHtml(doc())
    expect(html).toContain('<img src="media/photo-1.jpg" alt="alt &quot;text&quot;"')
    expect(html).toContain('<video src="media/video-1.mp4" poster="media/poster-1.jpg" controls')
    expect(html).toContain('<img class="avatar lg" src="media/avatar-abc.jpg"')
    expect(html).toContain("GIF wasn't saved")
    expect(html).not.toMatch(/src="https?:/)
  })

  it('links URLs and mentions, trimming trailing punctuation', () => {
    const html = renderArchiveHtml(doc())
    expect(html).toContain('<a href="https://example.com/page" rel="noopener noreferrer">https://example.com/page</a>.')
    expect(html).toContain('<a href="https://x.com/bob" rel="noopener noreferrer">@bob</a>')
  })

  it('escapes hostile content and drops non-http links', () => {
    const html = renderArchiveHtml(
      doc({
        text: '<script>alert(1)</script> <img src=x onerror=alert(1)>',
        author: { name: '<b>evil</b>', handle: 'x"y' },
        media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg', file: '../../etc/passwd' }],
        article: {
          title: '</title><script>bad()</script>',
          complete: true,
          blocks: [
            { type: 'paragraph', spans: [{ text: 'click', href: 'javascript:alert(1)' }] },
            { type: 'code', text: '<div>' },
          ],
        },
      }),
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('../../etc/passwd')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('<pre><code>&lt;div&gt;</code></pre>')
  })

  it('renders article blocks in order with images in place', () => {
    const html = renderArchiveHtml(
      doc({
        text: '',
        media: [],
        article: {
          title: 'My Article',
          complete: true,
          coverImage: { type: 'photo', url: 'https://pbs.twimg.com/media/C.jpg', file: 'media/cover.jpg' },
          blocks: [
            { type: 'paragraph', spans: [{ text: 'First ' }, { text: 'bold', bold: true }] },
            { type: 'media', media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/I.jpg', file: 'media/inline.jpg' }], caption: 'Cap' },
            { type: 'heading2', spans: [{ text: 'Later' }] },
            { type: 'ordered-list', items: [[{ text: 'one' }], [{ text: 'two' }]] },
          ],
        },
      }),
    )
    const order = ['media/cover.jpg', '<h1>My Article</h1>', 'First <strong>bold</strong>', 'media/inline.jpg', '<figcaption>Cap</figcaption>', '<h3>Later</h3>', '<ol><li>one</li><li>two</li></ol>']
    const positions = order.map((s) => html.indexOf(s))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('flags posts that were gone from X', () => {
    expect(renderArchiveHtml(doc({ unavailableOnX: true }))).toContain('This post was no longer available on X')
  })
})

describe('renderArchiveMarkdown', () => {
  it('writes text, local media and the article body', () => {
    const md = renderArchiveMarkdown(
      doc({
        article: {
          title: 'Art',
          complete: true,
          blocks: [
            { type: 'paragraph', spans: [{ text: 'See ' }, { text: 'docs', href: 'https://example.com' }] },
            { type: 'media', media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/I.jpg', file: 'media/inline.jpg' }] },
          ],
        },
      }),
    )
    expect(md).toContain('# Art')
    expect(md).toContain('Hello @bob see https://example.com/page.')
    expect(md).toContain('![alt "text"](media/photo-1.jpg)')
    expect(md).toContain('[▶ Video](media/video-1.mp4)')
    expect(md).toContain('See [docs](https://example.com/)')
    expect(md).toContain('![Image](media/inline.jpg)')
  })
})

describe('escaping helpers', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  it('only allows http(s) links', () => {
    expect(safeExternalHref('https://a.com/x')).toBe('https://a.com/x')
    expect(safeExternalHref('javascript:alert(1)')).toBeNull()
    expect(safeExternalHref('data:text/html,hi')).toBeNull()
    expect(safeExternalHref('not a url')).toBeNull()
  })
})
