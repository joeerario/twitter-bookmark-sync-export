import { readFile, writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  OWNED_SECTION_KEYS,
  exportBookmark,
  extractFrontmatter,
  extractOwnedSections,
  formatDateLocal,
  generateFilename,
  generateIndex,
  generateMarkdown,
  invalidateExportStateCache,
  mergeMarkdown,
  normalizeTags,
  stripTrackingParams,
  validateMarkdown,
} from '../src/obsidian-exporter.js';
import type { ObsidianConfig, ProcessedBookmark } from '../src/types.js';
import { dataPath } from './helpers/data-paths.js';
import { withFileSnapshot } from './helpers/file-snapshot.js';
import { withTempDir } from './helpers/temp-dir.js';

const baseConfig: ObsidianConfig = {
  vaultPath: null,
  bookmarksFolder: 'Bookmarks',
  useCategoryFolders: true,
  categoryFolders: {
    try: 'Tools',
    review: 'Read',
    knowledge: 'Insights',
    life: 'Life',
    skip: null,
  },
  fileNaming: 'date-summary',
  includeTranscripts: false,
  maxContentLength: 5000,
  autoLink: {
    enabled: true,
    linkMappings: {},
  },
  assets: {
    strategy: 'vault-relative',
    assetsDir: 'Bookmarks/Assets',
    perCategoryDirs: {
      try: 'Bookmarks/Assets/Twitter',
      review: 'Bookmarks/Assets/Twitter',
      knowledge: 'Bookmarks/Assets/Twitter',
      life: 'Bookmarks/Assets/Twitter',
      skip: null,
    },
    embedWidth: 600,
  },
  article: {
    mode: 'excerpt-inline',
    separateDir: 'Bookmarks/Articles',
    maxExcerptLength: 800,
  },
  tagPolicy: 'sanitize',
};

const createBookmark = (overrides: Partial<ProcessedBookmark> = {}): ProcessedBookmark => ({
  id: '123',
  account: 'test',
  author: { username: 'user', name: 'User', id: '1' },
  originalText: 'test',
  text: 'test',
  createdAt: '2024-01-15T00:00:00.000Z',
  processedAt: '2024-01-15T00:00:00.000Z',
  likeCount: 0,
  retweetCount: 0,
  replyCount: 0,
  urls: [],
  category: 'review',
  contentType: 'other',
  contentFormat: 'tweet',
  summary: 'Test',
  keyValue: 'Test value',
  quotes: [],
  tags: [],
  actionItems: [],
  priority: 'low',
  isReply: false,
  isPartOfThread: false,
  transcripts: [],
  articles: [],
  media: [],
  ...overrides,
});

const readFrontmatter = (markdown: string): Record<string, unknown> => {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) {
    throw new Error('Missing frontmatter');
  }
  return parseYaml(match[1]) as Record<string, unknown>;
};

beforeEach(() => {
  invalidateExportStateCache();
});

describe('obsidian-exporter', () => {
  describe('generateFilename collision prevention', () => {
    it('includes ID suffix to prevent collisions', () => {
      const bookmark1 = createBookmark({
        id: '1234567890123456789',
        summary: 'AI News',
        createdAt: '2024-01-15T00:00:00.000Z',
      });
      const bookmark2 = createBookmark({
        id: '9876543210987654321',
        summary: 'AI News',
        createdAt: '2024-01-15T00:00:00.000Z',
      });

      const filename1 = generateFilename(bookmark1, baseConfig);
      const filename2 = generateFilename(bookmark2, baseConfig);

      expect(filename1).not.toBe(filename2);
      expect(filename1).toContain('2024-01-15');
      expect(filename2).toContain('2024-01-15');
      expect(filename1).toContain('ai-news');
      expect(filename2).toContain('ai-news');
      expect(filename1).toContain('456789');
      expect(filename2).toContain('654321');
    });

    it('uses last 6 chars of ID as suffix', () => {
      const bookmark = createBookmark({
        id: 'abcdefghijklmnop',
        summary: 'Test',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      const filename = generateFilename(bookmark, baseConfig);
      expect(filename).toMatch(/lmnop\.md$/);
    });
  });

  it('generateFilename falls back to id when slug is empty', () => {
    const bookmark = createBookmark({
      id: '123',
      summary: '',
      text: '',
      createdAt: '2020-01-02T00:00:00.000Z',
    });
    const filename = generateFilename(bookmark, baseConfig);
    expect(filename).toMatch(/2020-01-02-123-123\.md$/);
  });

  it('generateFilename handles invalid createdAt', () => {
    const bookmark = createBookmark({
      id: '123',
      summary: 'Test',
      text: 'Test',
      createdAt: 'not-a-date',
    });
    const filename = generateFilename(bookmark, baseConfig);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-test-123\.md$/);
  });

  describe('normalizeTags', () => {
    it('sanitize policy filters numeric-only tags', () => {
      const result = normalizeTags(['123', 'valid-tag', '456'], 'sanitize');
      expect(result.tags).toEqual(['valid-tag']);
      expect(result.adjusted).toBe(true);
    });

    it('sanitize policy filters empty-after-sanitization tags', () => {
      const result = normalizeTags(['!!!', 'good-tag'], 'sanitize');
      expect(result.tags).toEqual(['good-tag']);
    });
  });

  describe('YAML escaping', () => {
    it('escapes colons in author names', () => {
      const bookmark = createBookmark({
        author: { username: 'user', name: 'Key: Value Name', id: '1' },
      });
      const markdown = generateMarkdown(bookmark, baseConfig);
      const frontmatter = readFrontmatter(markdown);
      expect(frontmatter.author_name).toBe('Key: Value Name');
    });

    it('escapes quotes in author names', () => {
      const bookmark = createBookmark({
        author: { username: 'user', name: 'Said "hello"', id: '1' },
      });
      const markdown = generateMarkdown(bookmark, baseConfig);
      const frontmatter = readFrontmatter(markdown);
      expect(frontmatter.author_name).toBe('Said "hello"');
    });

    it('handles special YAML keywords in category', () => {
      const bookmark = createBookmark({
        category: 'true' as any,
      });
      const markdown = generateMarkdown(bookmark, baseConfig);
      const frontmatter = readFrontmatter(markdown);
      expect(frontmatter.category).toBe('true');
    });

    it('handles arrays with special characters', () => {
      const bookmark = createBookmark({
        tags: ['ai:ml', 'has#hash', 'normal'],
      });
      const config: ObsidianConfig = { ...baseConfig, tagPolicy: 'preserve' };
      const markdown = generateMarkdown(bookmark, config);
      const frontmatter = readFrontmatter(markdown);
      expect(frontmatter.tags).toEqual(['ai:ml', 'has#hash', 'normal']);
    });
  });

  it('frontmatter uses schema version and list fields', () => {
    const bookmark = createBookmark({ tags: ['Alpha', 'Beta'] });
    const markdown = generateMarkdown(bookmark, baseConfig);
    const frontmatter = readFrontmatter(markdown);
    expect(frontmatter.schema_version).toBe(1);
    expect(frontmatter.tags).toEqual(['alpha', 'beta']);
    expect(frontmatter.aliases).toHaveLength(3);
    expect(frontmatter.aliases).toEqual(expect.arrayContaining(['@user', '123', 'Test']));
  });

  it('validateMarkdown accepts generated content', () => {
    const markdown = generateMarkdown(createBookmark(), baseConfig);
    expect(() => validateMarkdown(markdown, baseConfig)).not.toThrow();
  });

  it('generateMarkdown auto-links phrases with regex characters', () => {
    const config: ObsidianConfig = {
      ...baseConfig,
      autoLink: {
        enabled: true,
        linkMappings: {
          'node.js': 'NodeJS',
        },
      },
    };
    const bookmark = createBookmark({
      id: '1',
      text: 'node.js is great',
      originalText: 'node.js is great',
      summary: 'node.js',
    });

    const markdown = generateMarkdown(bookmark, config);
    expect(markdown).toContain('[[NodeJS|node.js]]');
  });

  it('generates expected output for full-featured bookmark (golden test)', () => {
    const bookmark = createBookmark({
      id: 'golden-test-001',
      summary: 'Golden Test Summary',
      text: 'This is the tweet text with a link https://example.com',
      originalText: 'This is the tweet text with a link https://example.com',
      keyValue: 'This is the key value explaining why this matters',
      quotes: ['Notable quote one', 'Notable quote two'],
      actionItems: ['Try this tool', 'Read the documentation'],
      tags: ['ai', 'tools', 'automation'],
      urls: ['https://example.com', 'https://github.com/test/repo'],
      articles: [
        { url: 'https://example.com/article', title: 'Test Article', content: 'Article content here...' },
      ],
      likeCount: 100,
      retweetCount: 25,
      replyCount: 10,
    });

    const markdown = generateMarkdown(bookmark, baseConfig);
    expect(markdown).toMatchSnapshot();
  });

  it('includes media embeds when provided', () => {
    const mediaAssets = [
      {
        sourceUrl: 'https://example.com/image.jpg',
        embedPath: 'Bookmarks/Assets/123-1.jpg',
        localPath: '/tmp/123-1.jpg',
        filename: '123-1.jpg',
        status: 'downloaded' as const,
      },
    ];

    const bookmark = createBookmark();
    const markdown = generateMarkdown(bookmark, baseConfig, { mediaAssets });
    expect(markdown).toContain('![[Bookmarks/Assets/123-1.jpg|600]]');
  });

  it('includes article callout excerpt', () => {
    const bookmark = createBookmark({
      articles: [
        {
          url: 'https://example.com/article?utm_source=test',
          title: 'Example Article',
          content: 'Article content here',
        },
      ],
    });

    const markdown = generateMarkdown(bookmark, baseConfig, {
      articlePayloads: [
        {
          title: 'Example Article',
          url: 'https://example.com/article',
          excerpt: 'Article content here',
        },
      ],
    });

    expect(markdown).toContain('> [!abstract]- Article: Example Article');
    expect(markdown).toContain('> Article content here');
  });

  it('handles article with missing content', () => {
    const bookmark = createBookmark({
      articles: [
        {
          url: 'https://example.com',
          title: 'Test Article',
        },
      ],
    });

    expect(() => generateMarkdown(bookmark, baseConfig)).not.toThrow();
  });

  it('preserves user notes on re-export while updating owned sections', async () => {
    await withTempDir('bookmark-vault-', async (vaultPath) => {
      const config: ObsidianConfig = {
        ...baseConfig,
        vaultPath,
        useCategoryFolders: false,
        fileNaming: 'id',
      };

      const bookmark = createBookmark({ id: 'test1', summary: 'Original Summary' });
      const result = await exportBookmark(bookmark, config);

      let content = await readFile(result.filepath!, 'utf-8');
      content = content.replace(
        '<!-- exporter:end footer -->',
        '<!-- exporter:end footer -->\n\n## My Personal Notes\nThis is user content that should be preserved.'
      );
      await writeFile(result.filepath!, content);

      const updatedBookmark = createBookmark({ id: 'test1', summary: 'Updated Summary' });
      await exportBookmark(updatedBookmark, config);

      const finalContent = await readFile(result.filepath!, 'utf-8');
      expect(finalContent).toContain('Updated Summary');
      expect(finalContent).not.toContain('Original Summary');
      expect(finalContent).toContain('## My Personal Notes');
      expect(finalContent).toContain('This is user content that should be preserved.');
    });
  });

  it('mergeMarkdown updates owned sections while preserving user content', () => {
    const original = generateMarkdown(createBookmark({ summary: 'Original Summary' }), baseConfig);
    const existing = `${original}\n\n## User Notes\nKeep this note`;
    const updated = generateMarkdown(createBookmark({ summary: 'Updated Summary' }), baseConfig);

    const merged = mergeMarkdown(existing, updated);
    expect(merged).toContain('Updated Summary');
    expect(merged).not.toContain('Original Summary');
    expect(merged).toContain('## User Notes');
  });

  it('extractOwnedSections finds exporter blocks', () => {
    const markdown = generateMarkdown(createBookmark(), baseConfig);
    const sections = extractOwnedSections(markdown);
    expect(sections.get('title')).toContain('exporter:begin title');
    expect(sections.get('footer')).toContain('exporter:end footer');
  });

  it('OWNED_SECTION_KEYS matches all generated sections', () => {
    const fullBookmark = createBookmark({
      summary: 'Test summary',
      keyValue: 'Key value',
      quotes: ['Quote 1'],
      actionItems: ['Action 1'],
      urls: ['https://example.com'],
      tags: ['tag1'],
      articles: [{ url: 'https://example.com', title: 'Article', content: 'Content' }],
      media: [{ type: 'photo', url: 'https://example.com/image.jpg' }],
      threadContext: {
        authorThread: [
          {
            id: '1',
            text: 'Tweet 1',
            createdAt: '2024-01-15T00:00:00.000Z',
            author: { username: 'user', name: 'User', id: '1' },
          },
          {
            id: '2',
            text: 'Tweet 2',
            createdAt: '2024-01-15T00:00:00.000Z',
            author: { username: 'user', name: 'User', id: '1' },
          },
        ],
        parentChain: [],
        totalInThread: 2,
        hasMoreReplies: false,
        topReplies: [],
      },
      transcripts: [{ videoId: 'abc', url: 'https://youtube.com/watch?v=abc', transcript: 'Transcript' }],
    });

    const markdown = generateMarkdown(fullBookmark, { ...baseConfig, includeTranscripts: true });
    const sectionMatches = [...markdown.matchAll(/<!-- exporter:begin ([\w-]+) -->/g)];
    const generatedKeys = sectionMatches.map((match) => match[1]).sort();

    expect(generatedKeys).toEqual([...OWNED_SECTION_KEYS].sort());
  });

  it('generateIndex respects categoryFolders config', async () => {
    await withTempDir('bookmark-vault-', async (vaultPath) => {
      const config: ObsidianConfig = {
        ...baseConfig,
        vaultPath,
        bookmarksFolder: 'Notes',
        categoryFolders: {
          try: 'Experiments',
          review: 'Reading',
          knowledge: 'Insights',
          life: 'Life',
          skip: null,
        },
      };

      const indexPath = await generateIndex(config);
      const content = await readFile(indexPath, 'utf-8');
      expect(content).toContain('FROM "Notes/Experiments"');
      expect(content).toContain('FROM "Notes/Reading"');
      expect(content).toContain('FROM "Notes/Insights"');
      expect(content).toContain('FROM "Notes/Life"');
    });
  });

  describe('error handling', () => {
    it('extractFrontmatter handles malformed YAML gracefully', () => {
      const malformed = '---\nkey: [unclosed\n---\nBody content';
      const result = extractFrontmatter(malformed);
      expect(result.frontmatter).toBeNull();
      expect(result.body.trim()).toBe('Body content');
    });

    it('validateMarkdown rejects non-array tags', () => {
      const markdown =
        '---\n' +
        'schema_version: 1\n' +
        'id: "123"\n' +
        'source_url: "http://x.com"\n' +
        'created: 2024-01-01\n' +
        'processed: 2024-01-01T00:00:00Z\n' +
        'captured_at: 2024-01-01T00:00:00Z\n' +
        'category: review\n' +
        'priority: low\n' +
        'status: unread\n' +
        'engagement:\n' +
        '  likes: 0\n' +
        '  retweets: 0\n' +
        '  replies: 0\n' +
        'tags: single-tag\n' +
        'aliases: []\n' +
        'cssclasses: []\n' +
        '---\n' +
        'Body';
      expect(() => validateMarkdown(markdown, baseConfig)).toThrow(/must be a list/);
    });

    it('formatDateLocal returns null for invalid dates', () => {
      expect(formatDateLocal('not-a-date')).toBeNull();
      expect(formatDateLocal('')).toBeNull();
      expect(formatDateLocal(null)).toBeNull();
    });

    it('stripTrackingParams handles malformed URLs', () => {
      expect(stripTrackingParams('not-a-url')).toBe('not-a-url');
      expect(stripTrackingParams('')).toBe('');
    });

    it('exportBookmark throws on missing bookmark', async () => {
      await expect(exportBookmark(null as unknown as ProcessedBookmark, baseConfig)).rejects.toThrow(/bookmark is required/);
    });

    it('exportBookmark throws on missing id', async () => {
      const invalid = { ...createBookmark(), id: undefined } as unknown as ProcessedBookmark;
      await expect(exportBookmark(invalid, baseConfig)).rejects.toThrow(/bookmark\.id is required/);
    });
  });

  it('export state lock retains all IDs under concurrency', async () => {
    await withTempDir('bookmark-vault-', async (vaultPath) => {
      const config: ObsidianConfig = {
        ...baseConfig,
        vaultPath,
      };
      const statePath = dataPath('obsidian-export-state.json');

      await withFileSnapshot(statePath, async () => {
        const bookmarks = [
          createBookmark({ id: 'a1', summary: 'One', text: 'One' }),
          createBookmark({ id: 'b2', summary: 'Two', text: 'Two' }),
        ];

        await Promise.all(bookmarks.map((b) => exportBookmark(b, config)));

        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.exportedIds).toContain('a1');
        expect(state.exportedIds).toContain('b2');
      });
    });
  });
});
