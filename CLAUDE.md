# Siftly

Self-hosted Twitter/X bookmark manager with AI-powered categorization, search, and visualization.

## Quick Setup

```bash
./start.sh            # installs deps, sets up DB, opens browser
```

Or manually:

```bash
npm install
npx prisma generate && npx prisma db push
npx next dev -p 28417
```

App runs at **http://localhost:28417**

## AI Authentication — No API Key Needed

If the user is signed into Claude Code CLI, **Siftly uses their Claude subscription automatically**. No API key configuration required.

How it works:
- `lib/claude-cli-auth.ts` reads the OAuth token from the macOS keychain (`Claude Code-credentials`)
- Uses `authToken` + `anthropic-beta: oauth-2025-04-20` header in the Anthropic SDK
- Falls back to: DB-saved API key → `ANTHROPIC_API_KEY` env var → local proxy

To verify it's working, hit: `GET /api/settings/cli-status`

## Key Commands

```bash
npx next dev -p 28417  # Start dev server (port 28417)
npx tsc --noEmit      # Type check
npx prisma studio     # Database GUI
npx prisma db push    # Apply schema changes to DB
npm run build         # Production build
```

## Project Structure

```
app/
  api/
    categorize/       # 4-stage AI pipeline (start/stop/status via SSE)
    import/           # Bookmark JSON import + dedup
    search/ai/        # AI search: POST query (questions get an answer), GET index stats
    settings/
      cli-status/     # GET — returns Claude CLI auth status
      test/           # POST — validates API key or CLI auth
      proxy-models/   # GET — lists models from the local OpenAI-compatible proxy
    analyze/images/   # Vision analysis progress + trigger
    archive/          # Local archive: GET stats/job/folder, POST start, PUT change folder, DELETE stop
      [id]/           # GET archived copy, POST archive one bookmark now
      folders/        # GET folder picker listing + detected cloud-drive folders
    x-account/        # X login: GET status, PUT paste cookies, DELETE log out
      login/          # POST open the "Log in to X" browser window, DELETE cancel it
      files/[...path] # Serves archived files (Range support for video)
    bookmarks/        # CRUD + filtering
      [id]/link-card/ # GET the post's link card (looked up and saved the first time)
    categories/       # Category management
    mindmap/          # Graph data
    stats/            # Dashboard counts
  import/             # 3-step import UI
  mindmap/            # Interactive force graph
  settings/           # API keys, model selection
  ai-search/          # Natural language search UI
  bookmarks/          # Browse + filter UI
  categorize/         # Pipeline monitor

lib/
  claude-cli-auth.ts  # Claude CLI OAuth session (macOS keychain)
  proxy-auth.ts       # Local proxy provider (CLIProxyAPI / EasyCLIProxyAPI)
  categorizer.ts      # AI categorization + default categories
  vision-analyzer.ts  # Image vision + semantic tagging
  ai-search.ts        # AI search: understand query → FTS + category/author/kind/date candidates → AI reads & ranks
  search-index.ts     # Search index (raw SQL tables bookmark_search_doc + FTS5 bookmark_search_fts), self-syncing
  search-document.ts  # A bookmark's searchable content (post, quote, link card, full X Article from the archive), excerpts
  link-card.ts        # Link cards (title/description/site/image of the linked page): from snapshots, X syndication, Open Graph (t.co resolved)
  link-card-store.ts  # resolveLinkCard(): Bookmark.linkCard from archive → stored JSON → network, saved + re-indexed
  rawjson-extractor.ts # Entity extraction from tweet JSON
  parser.ts           # Multi-format bookmark JSON parser
  exporter.ts         # CSV / JSON / ZIP export
  bookmark-filters.ts # Shared Prisma where fragments (ARTICLE_WHERE = X Articles)
  archiver.ts         # Local archive orchestration + background download job (never runs on import)
  archive-location.ts # Archive folder (Setting `archiveDir` → SIFTLY_ARCHIVE_DIR → default), moving it
  tweet-snapshot.ts   # Normalizes GraphQL / v1.1 / syndication tweets + X Article content_state
  x-tweet-fetcher.ts  # Fresh tweet copies from X (GraphQL TweetResultByRestId → syndication)
  archive-storage.ts  # Archive root, safe paths, media downloads
  archive-render.ts   # Offline index.html + content.md renderers
  archive-types.ts    # Archive document types (client-safe)
  x-login.ts          # "Log in to X": opens the user's Chromium-family browser (temp profile, DevTools pipe), captures auth_token + ct0
  x-session.ts        # Saved X login (Settings x_auth_token / x_ct0 / x_account), verification, rejection tracking
  request-guard.ts    # Cross-site request check for routes that handle the X login

prisma/schema.prisma  # SQLite schema (Bookmark, Category, MediaItem, Setting, ImportJob)
```

## Tech Stack

- **Next.js 16** (App Router, TypeScript)
- **Prisma 7** + **SQLite** (local, zero setup, FTS5 built in)
- **Anthropic SDK** — vision, tagging, categorization, search
- **@xyflow/react** — mindmap graph
- **Tailwind CSS v4**

## Environment Variables

See `.env.example` for the full list. Only `DATABASE_URL` is required (defaults to `file:./prisma/dev.db`).

## CLI for AI Agents

`cli/siftly.ts` provides direct database access without the Next.js server. Outputs JSON (pretty-printed on TTY, compact when piped). Must run from project root.

```bash
npx tsx cli/siftly.ts stats                          # Library statistics
npx tsx cli/siftly.ts categories                     # Categories with counts
npx tsx cli/siftly.ts search "AI agents"             # Keyword search (posts, quotes, links, full X Articles)
npx tsx cli/siftly.ts ai-search "how do people fine-tune small models?"  # AI search; questions get an answer
npx tsx cli/siftly.ts list --limit 5                 # Recent bookmarks
npx tsx cli/siftly.ts list --source like --category ai-resources --sort oldest
npx tsx cli/siftly.ts list --media article           # X Articles only (also photo / video)
npx tsx cli/siftly.ts show <id|tweetId>              # Full bookmark detail
npx tsx cli/siftly.ts archive --limit 50             # Save bookmarks to the local archive
npx tsx cli/siftly.ts archive --id <tweetId> --offline  # Rebuild one archive from stored data only
npx tsx cli/siftly.ts archive-status                 # Archive statistics
npx tsx cli/siftly.ts archive-dir "/path/to/Google Drive/Siftly"  # Change archive folder (moves files; --no-move, --reset)
npm run siftly -- stats                              # Alternative via npm script
```

## Common Tasks

| Task | How |
|------|-----|
| Run AI pipeline | `POST /api/categorize` with `{}` body; `GET /api/categorize` for SSE progress |
| Add category | Edit `DEFAULT_CATEGORIES` in `lib/categorizer.ts` — description is passed verbatim to Claude |
| Rename / re-describe a category | `PATCH /api/categories/<slug>` with any of `{"name","description","color"}`. Slug stays the same; sets `userEdited` so default seeding won't overwrite it |
| Add known tool | Append domain to `KNOWN_TOOL_DOMAINS` in `lib/rawjson-extractor.ts` |
| Test API auth | `POST /api/settings/test` with `{"provider":"anthropic"}` |
| Check CLI auth | `GET /api/settings/cli-status` |
| Archive bookmarks locally | `POST /api/archive` with `{"mode":"pending"}` (not downloaded yet), `retry` (incomplete + failed only) or `all`; `GET /api/archive` for progress. Imports never start it |
| X login for full X Articles | Settings → X Login, or `PUT /api/x-account` with `{"authToken","ct0"}`; status via `GET /api/x-account`. The archiver reads it with `getXCredentials()` |
| Change archive folder | `PUT /api/archive` with `{"archiveDir":"/abs/path","moveFiles":true}` (`null` = default) |
| Archive one bookmark | `POST /api/archive/<id or tweetId>`; read it back with `GET /api/archive/<id>` |
| Filter X Articles | `GET /api/bookmarks?mediaType=article` (matches the stored `article` object or an `x.com/i/article/` link) |
| AI search | `POST /api/search/ai` with `{"query"}` → ranked bookmarks with `aiReason`, plus `answer` (citing results as [1], [2]…) for questions. `GET /api/search/ai` = index stats (how many X Articles are readable in full) |
| Change what search can read | `buildSearchDocument` / `buildSearchRow` in `lib/search-document.ts`; bump `SEARCH_DOC_VERSION` so every bookmark is re-indexed |
| Link-only posts | `Bookmark.linkCard` (JSON) holds the linked page's card; cards show it, the categorizer and tag enrichment read it (`link` field). Filled by the archiver, the AI pipeline and `GET /api/bookmarks/<id>/link-card` via `resolveLinkCard()` |
| Delete one bookmark | `DELETE /api/bookmarks/<id or tweetId>`; add `?deleteArchive=true` to remove its archive folder too. Siftly only — it stays bookmarked on X, so a later sync can re-add it |

## Database

SQLite at `prisma/dev.db`. After schema changes: `npx prisma db push`

Models: `Bookmark`, `MediaItem`, `BookmarkCategory`, `Category`, `Setting`, `ImportJob` — see `prisma/schema.prisma` for details.

The search index is two runtime-managed tables (not in the Prisma schema): `bookmark_search_doc` (extracted content per bookmark) and FTS5 `bookmark_search_fts`. `syncSearchIndex()` indexes new bookmarks before every search; the archiver re-indexes a bookmark after saving it (so archived X Articles become searchable in full), and the AI pipeline / image analysis call `refreshSearchRows()`.

Local archive files live in the folder chosen in Settings (Setting `archiveDir`), else `SIFTLY_ARCHIVE_DIR`, else `archive/` next to the database (`prisma/archive/`). Always resolve it with `getArchiveRoot()` from `lib/archive-location.ts`. `MediaItem.localPath` / `localThumbnailPath` are relative to that folder.