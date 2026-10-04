/**
 * Prisma `where` fragments shared by the bookmarks API and the CLI.
 */

/**
 * X Articles. Every stored format keeps the article under an `article` object
 * (GraphQL `article.article_results`, v1.1, syndication, API v2), and imports
 * that dropped it still carry the article link (x.com/i/article/…) in their
 * URL entities. rawJson is always written with JSON.stringify, so there is no
 * whitespace around the colon. Posts quoting an article match too.
 */
export const ARTICLE_WHERE = {
  OR: [
    { rawJson: { contains: '"article":{' } },
    { rawJson: { contains: '/i/article/' } },
  ],
}
