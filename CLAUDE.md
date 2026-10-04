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
    search/ai/        # FTS5 + Claude semantic search
    settings/
      cli-status/     # GET — returns Claude CLI auth status
      test/           # POST — validates API key or CLI auth
      proxy-models/   # GET — lists models from the local OpenAI-compatible proxy
    analyze/images/   # Vision analysis progress + trigger
    archive/          # Local archive: GET stats/job, POST start, PUT autoArchive, DELETE stop
      [id]/           # GET archived copy, POST archive one bookmark now
      files/[...path] # Serves archived files (Range support for video)
    bookmarks/        # CRUD + filtering
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
  fts.ts              # SQLite FTS5 full-text search
  rawjson-extractor.ts # Entity extraction from tweet JSON
  parser.ts           # Multi-format bookmark JSON parser
  exporter.ts         # CSV / JSON / ZIP export
  archiver.ts         # Local archive orchestration, background job, auto-archive hook
  tweet-snapshot.ts   # Normalizes GraphQL / v1.1 / syndication tweets + X Article content_state
  x-tweet-fetcher.ts  # Fresh tweet copies from X (GraphQL TweetResultByRestId → syndication)
  archive-storage.ts  # Archive root, safe paths, media downloads
  archive-render.ts   # Offline index.html + content.md renderers
  archive-types.ts    # Archive document types (client-safe)

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
npx tsx cli/siftly.ts search "AI agents"             # FTS5 keyword search
npx tsx cli/siftly.ts list --limit 5                 # Recent bookmarks
npx tsx cli/siftly.ts list --source like --category ai-resources --sort oldest
npx tsx cli/siftly.ts show <id|tweetId>              # Full bookmark detail
npx tsx cli/siftly.ts archive --limit 50             # Save bookmarks to the local archive
npx tsx cli/siftly.ts archive --id <tweetId> --offline  # Rebuild one archive from stored data only
npx tsx cli/siftly.ts archive-status                 # Archive statistics
npm run siftly -- stats                              # Alternative via npm script
```

## Common Tasks

| Task | How |
|------|-----|
| Run AI pipeline | `POST /api/categorize` with `{}` body; `GET /api/categorize` for SSE progress |
| Add category | Edit `DEFAULT_CATEGORIES` in `lib/categorizer.ts` — description is passed verbatim to Claude |
| Add known tool | Append domain to `KNOWN_TOOL_DOMAINS` in `lib/rawjson-extractor.ts` |
| Test API auth | `POST /api/settings/test` with `{"provider":"anthropic"}` |
| Check CLI auth | `GET /api/settings/cli-status` |
| Archive bookmarks locally | `POST /api/archive` with `{"mode":"pending"}` (or `retry` / `all`); `GET /api/archive` for progress |
| Archive one bookmark | `POST /api/archive/<id or tweetId>`; read it back with `GET /api/archive/<id>` |

## Database

SQLite at `prisma/dev.db`. After schema changes: `npx prisma db push`

Models: `Bookmark`, `MediaItem`, `BookmarkCategory`, `Category`, `Setting`, `ImportJob` — see `prisma/schema.prisma` for details.

Local archive files live in `archive/` next to the database (`prisma/archive/` by default, override with `SIFTLY_ARCHIVE_DIR`). `MediaItem.localPath` / `localThumbnailPath` are relative to that folder.