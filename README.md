# Twitter Bookmark Sync & Export

Sync your Twitter/X bookmarks automatically. AI categorizes them. Export to Obsidian as rich markdown notes.

## Features

- **Auto-sync** – Polls Twitter every 5 minutes for new bookmarks
- **AI categorization** – Claude analyzes and sorts into try/review/knowledge/life/skip
- **Thread-aware** – Fetches parent tweets, replies, quotes, full context
- **Content extraction** – Pulls articles, YouTube transcripts, linked tweets
- **Obsidian export** – Rich markdown with frontmatter, callouts, Dataview support
- **Narrative tracking** – Groups related bookmarks into evolving topics
- **Multi-account** – Sync bookmarks from multiple Twitter accounts

## How it works

| Step | What happens |
|------|--------------|
| **Fetch** | New bookmarks pulled from Twitter API |
| **Enrich** | Thread context, articles, transcripts extracted |
| **Categorize** | Claude analyzes and assigns category, tags, summary |
| **Export** | Markdown notes created in Obsidian vault |

Categories:

| Category | Obsidian Folder | What goes here |
|----------|-----------------|----------------|
| `try` | `Tools/` | Tools, libraries, apps to try |
| `review` | `Read/` | Articles and content to read later |
| `knowledge` | `Insights/` | Reference material, insights |
| `life` | `Life/` | Personal, non-tech content |
| `skip` | — | Filtered out |

## Install

Requires **Node.js 22+**, an [Anthropic API key](https://console.anthropic.com/), and Twitter cookies.

```bash
git clone https://github.com/joeerario/twitter-bookmark-sync-export.git
cd twitter-bookmark-sync-export
npm install
npm run build
```

## Setup

**1. Create `.env`**

```bash
cp .env.example .env
# Add your Anthropic API key
```

**2. Add Twitter account**

```bash
npm run setup -- add
```

Get your cookies from Chrome DevTools → Application → Cookies → x.com:
- `auth_token`
- `ct0`

**3. Configure Obsidian vault**

```bash
node dist/obsidian.js config --vault ~/path/to/vault
```

## Usage

**Start the daemon** (polls every 5 minutes, auto-exports to Obsidian):

```bash
npm start
```

**With PM2** (recommended):

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

**One-time sync**:

```bash
npm run process
```

**Backfill historical bookmarks**:

```bash
node dist/backfill.js --count 50 --max-cycles 100
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start polling daemon |
| `npm run process` | One-time processing pass |
| `npm run backfill` | Backfill historical bookmarks |
| `npm run status` | Show system status |
| `npm run setup -- add` | Add Twitter account |
| `npm run setup -- list` | List configured accounts |

### Obsidian CLI

```bash
node dist/obsidian.js sync      # Export new bookmarks
node dist/obsidian.js review    # Interactive review
node dist/obsidian.js stats     # Export statistics
node dist/obsidian.js index     # Regenerate Dataview index
```

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `TWITTER_AUTH_TOKEN` | No | Default auth_token for setup |
| `TWITTER_CT0` | No | Default ct0 for setup |

### Obsidian config

Created at `obsidian.config.json`:

```json
{
  "vaultPath": "/path/to/vault",
  "bookmarksFolder": "Bookmarks",
  "categoryFolders": {
    "try": "Tools",
    "review": "Read",
    "knowledge": "Insights",
    "life": "Life"
  }
}
```

## Output

Each bookmark becomes a markdown note with:

- **Frontmatter** – id, author, category, tags, priority, engagement metrics
- **Summary** – AI-generated one-liner
- **Tweet** – Original content with thread context
- **Article** – Extracted content from links
- **Key Value** – Why this matters
- **Action Items** – Suggested next steps

Notes work with Dataview. A generated index provides dashboard views.

## Project structure

```
src/
├── index.ts              # Polling daemon
├── processor.ts          # Processing pipeline
├── categorizer.ts        # AI categorization (Claude)
├── content-extractor.ts  # Article/transcript extraction
├── context-fetcher.ts    # Thread context
├── obsidian-exporter.ts  # Markdown export
└── narrative-storage.ts  # Topic tracking
```

## Development

```bash
npm run dev        # Watch mode
npm test           # Run tests
npm run lint       # Lint
npm run format     # Format
```

## License

MIT
