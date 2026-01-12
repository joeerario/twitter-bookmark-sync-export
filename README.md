# Twitter Bookmark Sync & Export

Automatically sync your Twitter/X bookmarks, categorize them with AI, and export to Obsidian as beautifully formatted notes.

## Features

- **Automatic Sync** - Polls Twitter for new bookmarks every 5 minutes
- **AI Categorization** - Claude analyzes each bookmark and assigns categories, tags, and summaries
- **Thread Awareness** - Fetches full thread context, parent tweets, and top replies
- **Article Extraction** - Pulls content from linked articles, YouTube transcripts, and embedded tweets
- **Obsidian Export** - Generates rich markdown notes with frontmatter, callouts, and Dataview compatibility
- **Narrative Tracking** - Groups related bookmarks into evolving topics/themes
- **Multi-Account** - Support for multiple Twitter accounts

## How It Works

```
Twitter Bookmarks → Fetch & Enrich → AI Categorize → Export to Obsidian
                         ↓
              • Thread context
              • Article content
              • YouTube transcripts
              • Linked tweets
```

Bookmarks are sorted into categories:
| Category | Folder | Description |
|----------|--------|-------------|
| `try` | Tools/ | Tools, libraries, apps to try |
| `review` | Read/ | Articles and content to read |
| `knowledge` | Insights/ | Reference material and insights |
| `life` | Life/ | Personal, non-tech content |
| `skip` | — | Low-value, filtered out |

## Quick Start

### Prerequisites

- Node.js 22+
- [Anthropic API key](https://console.anthropic.com/)
- Twitter/X account cookies (`auth_token`, `ct0`)

### Installation

```bash
git clone <your-repo-url>
cd twitter-bookmark-sync-export
npm install
npm run build
```

### Configuration

1. Create `.env` file:
```bash
cp .env.example .env
```

2. Add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-...
```

3. Add a Twitter account:
```bash
npm run setup -- add
```

You'll need your Twitter cookies. In Chrome DevTools → Application → Cookies → x.com, copy `auth_token` and `ct0`.

4. Configure Obsidian vault:
```bash
node dist/obsidian.js config --vault ~/path/to/your/vault
```

### Running

**Start the daemon** (polls every 5 minutes):
```bash
npm start
```

**Or with PM2** (recommended for always-on):
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

**One-time processing**:
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
| `npm run obsidian` | Obsidian export CLI |
| `npm run setup -- add` | Add Twitter account |
| `npm run setup -- list` | List accounts |

### Obsidian Commands

```bash
# Sync new bookmarks to Obsidian
node dist/obsidian.js sync

# Interactive review of pending items
node dist/obsidian.js review

# Show export statistics
node dist/obsidian.js stats

# Regenerate Dataview index
node dist/obsidian.js index
```

## Project Structure

```
├── src/
│   ├── index.ts              # Main polling service
│   ├── processor.ts          # Processing pipeline
│   ├── categorizer.ts        # AI categorization
│   ├── content-extractor.ts  # Article/transcript extraction
│   ├── context-fetcher.ts    # Thread context fetching
│   ├── obsidian-exporter.ts  # Markdown export
│   ├── narrative-storage.ts  # Narrative/topic tracking
│   └── ...
├── data/                     # Runtime data (gitignored)
│   ├── processed/            # Categorized bookmarks
│   ├── state/                # Polling state
│   └── narratives/           # Narrative index
├── ecosystem.config.cjs      # PM2 configuration
└── obsidian.config.json      # Obsidian settings (gitignored)
```

## Obsidian Output

Each bookmark becomes a markdown note with:

- **Frontmatter** - `id`, `author`, `category`, `tags`, `priority`, `status`, engagement metrics
- **Summary** - AI-generated one-liner
- **Tweet** - Original content with thread context
- **Article** - Extracted content from links
- **Key Value** - Why this bookmark matters
- **Action Items** - Suggested next steps
- **Related** - Auto-linked topics

Notes are compatible with Dataview, and a generated index provides dashboard views.

## Configuration

### `obsidian.config.json`

```json
{
  "vaultPath": "/path/to/vault",
  "bookmarksFolder": "Bookmarks",
  "useCategoryFolders": true,
  "categoryFolders": {
    "try": "Tools",
    "review": "Read",
    "knowledge": "Insights",
    "life": "Life"
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `TWITTER_AUTH_TOKEN` | No | Default auth_token for setup |
| `TWITTER_CT0` | No | Default ct0 for setup |

## Development

```bash
# Watch mode
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Format
npm run format
```

## License

MIT
