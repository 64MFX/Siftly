const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'in', 'on', 'at', 'to', 'of', 'from', 'into', 'as',
  'is', 'it', 'its', 'be', 'been', 'was', 'were', 'are', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'done',
  'about', 'that', 'with', 'by', 'this', 'these', 'those', 'there', 'than', 'then', 'so', 'if', 'not', 'no',
  'my', 'me', 'mine', 'i', 'im', 'ive', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'something', 'anything', 'everything', 'some', 'any', 'all', 'more', 'most', 'very', 'really', 'just', 'also',
  'show', 'find', 'get', 'give', 'list', 'tell', 'use', 'search', 'look', 'looking', 'remember', 'recall', 'know',
  'regarding', 'context', 'want', 'need', 'related', 'using', 'used', 'based', 'please',
  'say', 'says', 'said', 'talk', 'talks', 'talked', 'talking', 'mention', 'mentioned', 'mentions',
  'thing', 'things', 'stuff', 'one', 'ones', 'kind', 'sort', 'like', 'someone', 'somebody',
  'saved', 'save', 'bookmark', 'bookmarks', 'bookmarked', 'tweet', 'tweets', 'tweeted', 'post', 'posts', 'posted',
  'thread', 'threads', 'liked', 'likes',
])

/** Meaningful search words in a query — keeps short terms like "AI", "ML", "KYC" and non-English words */
export function extractKeywords(query: string): string[] {
  const words = query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    // Allow short words (2+ chars) so "AI", "ML", "KYC" survive
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
  return [...new Set(words)].slice(0, 12)
}
