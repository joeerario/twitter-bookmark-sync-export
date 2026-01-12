import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { makeTempDir } from './helpers/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before imports
// Use vi.hoisted to define mock functions before vi.mock is hoisted
const { mockAddToReviewQueue, mockAppendNarrativeAudit, mockMessagesCreate } = vi.hoisted(() => ({
  mockAddToReviewQueue: vi.fn(() => Promise.resolve()),
  mockAppendNarrativeAudit: vi.fn(() => Promise.resolve()),
  mockMessagesCreate: vi.fn(() =>
    Promise.resolve({
      content: [{ type: 'text', text: 'This is a mocked AI-generated summary.' }],
    })
  ),
}));

vi.mock('../src/categorizer.js', () => ({
  categorizeBookmark: vi.fn(() =>
    Promise.resolve({
      category: 'review',
      contentType: 'other',
      contentFormat: 'tweet',
      summary: 'Test summary',
      keyValue: 'Test value',
      quotes: [],
      tags: ['test'],
      actionItems: [],
      priority: 'medium',
      narrativeId: 'narr-test-123',
      narrativeLabel: 'Test Narrative',
      narrativeConfidence: 'high',
    })
  ),
  getClient: vi.fn(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  })),
}));

vi.mock('../src/narrative-storage.js', async () => {
  const actual = await vi.importActual('../src/narrative-storage.js');
  return {
    ...actual,
    getNarrativesForPrompt: vi.fn(() => Promise.resolve([])),
    upsertNarrativeFromAssignment: vi.fn(() =>
      Promise.resolve({
        narrativeId: 'narr-test-123',
        narrativeLabel: 'Test Narrative',
        created: false,
      })
    ),
    addToReviewQueue: mockAddToReviewQueue,
    appendNarrativeAudit: mockAppendNarrativeAudit,
  };
});

import { setDataDir, resetDataDir, getNarrativeDir } from '../src/narrative-storage.js';
import { readJsonSafe } from '../src/utils/read-json-safe.js';
import { writeJsonAtomic } from '../src/utils/write-json-atomic.js';
import { categorizeBookmark } from '../src/categorizer.js';
import {
  parseBackfillArgs,
  parseListArgs,
  parseRefreshArgs,
  runBackfill,
  runRefreshSummaries,
  runTopicHeatmap,
  runNarrativeHeatmap,
  scanProcessedBookmarks,
  normalizeTag,
  applyTagMapping,
  loadTagMap,
  generateRawTagsReport,
  getIsoWeek,
  calculateTrend,
  showHelp,
  showNarrativesSummary,
  runListNarratives,
  runShowNarrative,
  type TagMapConfig,
  type Heatmap,
} from '../src/narratives-cli.js';

describe('narratives-cli', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const result = await makeTempDir('narratives-cli');
    tempDir = result.dir;
    cleanup = result.cleanup;
    setDataDir(tempDir);
  });

  afterEach(async () => {
    resetDataDir();
    await cleanup();
  });

  describe('argument parsing (production code)', () => {
    it('parses --limit flag', () => {
      const options = parseBackfillArgs(['--limit', '50']);
      expect(options.limit).toBe(50);
    });

    it('parses --since flag', () => {
      const options = parseBackfillArgs(['--since', '2024-01-01']);
      expect(options.since).toBe('2024-01-01');
    });

    it('parses --no-resume flag', () => {
      const options = parseBackfillArgs(['--no-resume']);
      expect(options.resume).toBe(false);
    });

    it('parses --dry-run flag', () => {
      const options = parseBackfillArgs(['--dry-run']);
      expect(options.dryRun).toBe(true);
    });

    it('defaults resume to true', () => {
      const options = parseBackfillArgs([]);
      expect(options.resume).toBe(true);
    });

    it('parses multiple flags', () => {
      const options = parseBackfillArgs(['--limit', '100', '--since', '2024-06-01', '--dry-run']);
      expect(options.limit).toBe(100);
      expect(options.since).toBe('2024-06-01');
      expect(options.dryRun).toBe(true);
      expect(options.resume).toBe(true);
    });

    it('parses list --sort flag', () => {
      const options = parseListArgs(['--sort', 'count']);
      expect(options.sort).toBe('count');
    });

    it('parses list --limit flag', () => {
      const options = parseListArgs(['--limit', '25']);
      expect(options.limit).toBe(25);
    });

    it('parses refresh --dry-run flag', () => {
      const options = parseRefreshArgs(['--dry-run']);
      expect(options.dryRun).toBe(true);
    });

    it('parses refresh --limit flag', () => {
      const options = parseRefreshArgs(['--limit', '10']);
      expect(options.limit).toBe(10);
    });
  });

  describe('state file', () => {
    it('writes and reads state file correctly', async () => {
      const stateDir = getNarrativeDir();
      await mkdir(stateDir, { recursive: true });

      const statePath = path.join(stateDir, 'backfill-state.json');
      const state = {
        lastProcessedId: 'tweet-123',
        processedCount: 42,
        startedAt: '2024-01-01T00:00:00.000Z',
      };

      await writeJsonAtomic(statePath, state);

      const loaded = await readJsonSafe(statePath, null);
      expect(loaded).toEqual(state);
    });

    it('returns null when state file does not exist', async () => {
      const statePath = path.join(getNarrativeDir(), 'backfill-state.json');
      const loaded = await readJsonSafe(statePath, null);
      expect(loaded).toBeNull();
    });
  });

  describe('bookmark scanning (production code)', () => {
    it('scans bookmarks in stable order', async () => {
      // Create test fixture structure in the configured data dir
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });
      await mkdir(path.join(processedDir, 'account2', 'try'), { recursive: true });

      // Create test bookmarks
      const bookmark1 = { id: 'b-001', text: 'Bookmark 1', account: 'account1' };
      const bookmark2 = { id: 'b-002', text: 'Bookmark 2', account: 'account1' };
      const bookmark3 = { id: 'b-003', text: 'Bookmark 3', account: 'account2' };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'b-001.json'),
        JSON.stringify(bookmark1)
      );
      await writeFile(
        path.join(processedDir, 'account1', 'review', 'b-002.json'),
        JSON.stringify(bookmark2)
      );
      await writeFile(
        path.join(processedDir, 'account2', 'try', 'b-003.json'),
        JSON.stringify(bookmark3)
      );

      // Use production scanProcessedBookmarks
      const files = await scanProcessedBookmarks();

      // Should find all 3 files
      expect(files.length).toBe(3);
      expect(files.map((f) => f.id)).toContain('b-001');
      expect(files.map((f) => f.id)).toContain('b-002');
      expect(files.map((f) => f.id)).toContain('b-003');

      // Verify stable ordering (by filepath)
      const files2 = await scanProcessedBookmarks();
      expect(files.map((f) => f.id)).toEqual(files2.map((f) => f.id));
    });

    it('returns empty array when no processed dir exists', async () => {
      // Don't create any processed directory
      const files = await scanProcessedBookmarks();
      expect(files).toEqual([]);
    });

    it('skips bookmarks that already have narrativeId', async () => {
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      // Bookmark without narrative
      const bookmark1 = { id: 'b-001', text: 'No narrative', account: 'account1' };
      // Bookmark with narrative already assigned
      const bookmark2 = {
        id: 'b-002',
        text: 'Has narrative',
        account: 'account1',
        narrativeId: 'narr-existing',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'b-001.json'),
        JSON.stringify(bookmark1)
      );
      await writeFile(
        path.join(processedDir, 'account1', 'review', 'b-002.json'),
        JSON.stringify(bookmark2)
      );

      // Production scanProcessedBookmarks scans all files
      const files = await scanProcessedBookmarks();

      // Both files are scanned
      expect(files.length).toBe(2);

      // But when checking content, only b-001 has no narrativeId
      const content1 = JSON.parse(await readFile(files.find((f) => f.id === 'b-001')!.filepath, 'utf-8'));
      const content2 = JSON.parse(await readFile(files.find((f) => f.id === 'b-002')!.filepath, 'utf-8'));

      expect(content1.narrativeId).toBeUndefined();
      expect(content2.narrativeId).toBe('narr-existing');
    });
  });

  describe('resume functionality', () => {
    it('resumes from lastProcessedId', async () => {
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      // Create multiple bookmarks
      for (let i = 1; i <= 5; i++) {
        const bookmark = { id: `b-00${i}`, text: `Bookmark ${i}`, account: 'account1' };
        await writeFile(
          path.join(processedDir, 'account1', 'review', `b-00${i}.json`),
          JSON.stringify(bookmark)
        );
      }

      // Create state indicating we've processed up to b-002
      const stateDir = getNarrativeDir();
      await mkdir(stateDir, { recursive: true });
      await writeJsonAtomic(path.join(stateDir, 'backfill-state.json'), {
        lastProcessedId: 'b-002',
        processedCount: 2,
        startedAt: '2024-01-01T00:00:00.000Z',
      });

      const files = await scanProcessedBookmarks();

      // All 5 files are scanned
      expect(files.length).toBe(5);

      // Find index of lastProcessedId
      const lastIndex = files.findIndex((f) => f.id === 'b-002');
      expect(lastIndex).toBeGreaterThanOrEqual(0);

      // Remaining to process would be from lastIndex + 1
      const remainingIds = files.slice(lastIndex + 1).map((f) => f.id);
      expect(remainingIds).not.toContain('b-001');
      expect(remainingIds).not.toContain('b-002');
    });
  });

  describe('heatmap helpers (production code)', () => {
    it('normalizes tags consistently', () => {
      expect(normalizeTag('AI')).toBe('ai');
      expect(normalizeTag('  Machine Learning  ')).toBe('machine learning');
      expect(normalizeTag('GPT-4')).toBe('gpt4');
      expect(normalizeTag('TypeScript_React')).toBe('typescriptreact');
    });

    it('calculates ISO week correctly', () => {
      // Test that the function returns consistent format YYYY-Www
      const jan1 = new Date('2024-01-01T00:00:00Z');
      const week1 = getIsoWeek(jan1);
      expect(week1).toMatch(/^\d{4}-W\d{2}$/);

      // Different dates should produce consistent results
      const jan8 = new Date('2024-01-08T00:00:00Z');
      const week8 = getIsoWeek(jan8);
      expect(week8).toMatch(/^\d{4}-W\d{2}$/);

      // Same date should always return the same week
      expect(getIsoWeek(jan1)).toBe(week1);
      expect(getIsoWeek(jan8)).toBe(week8);
    });

    it('calculates trend as stable with few weeks', () => {
      const byWeek = {
        '2024-W01': 5,
        '2024-W02': 5,
      };
      expect(calculateTrend(byWeek)).toBe('stable');
    });

    it('calculates trend as rising with significant increase', () => {
      const byWeek = {
        '2024-W01': 2,
        '2024-W02': 2,
        '2024-W03': 5,
        '2024-W04': 6,
      };
      expect(calculateTrend(byWeek)).toBe('rising');
    });

    it('calculates trend as declining with significant decrease', () => {
      const byWeek = {
        '2024-W01': 10,
        '2024-W02': 10,
        '2024-W03': 3,
        '2024-W04': 2,
      };
      expect(calculateTrend(byWeek)).toBe('declining');
    });

    it('calculates trend as stable with insufficient volume', () => {
      const byWeek = {
        '2024-W01': 2,
        '2024-W02': 2,
        '2024-W03': 0,
        '2024-W04': 0,
      };
      // Even though there's a 100% decrease, baseline < 5 so it's stable
      expect(calculateTrend(byWeek)).toBe('stable');
    });
  });

  describe('tag normalization + mapping (R6.1)', () => {
    it('normalizes punctuation consistently', () => {
      // Hyphens and underscores are stripped
      expect(normalizeTag('GPT-4')).toBe('gpt4');
      expect(normalizeTag('machine_learning')).toBe('machinelearning');
      expect(normalizeTag('AI-ML_Research')).toBe('aimlresearch');
      // Multiple hyphens/underscores
      expect(normalizeTag('large--language--model')).toBe('largelanguagemodel');
      // Mixed case and punctuation - all punctuation stripped per spec
      expect(normalizeTag('  Claude-3.5  ')).toBe('claude35');
      // Other punctuation also stripped
      expect(normalizeTag('node.js')).toBe('nodejs');
      expect(normalizeTag('AI/ML')).toBe('aiml');
    });

    it('normalizes whitespace correctly', () => {
      // Leading/trailing whitespace
      expect(normalizeTag('  AI  ')).toBe('ai');
      // Multiple spaces collapsed to single
      expect(normalizeTag('natural   language   processing')).toBe('natural language processing');
      // Tabs and newlines
      expect(normalizeTag('deep\t\tlearning')).toBe('deep learning');
    });

    it('applies tag mapping after normalization', () => {
      const tagMap: TagMapConfig = {
        mappings: {
          'machinelearning': 'ml',
          'artificialintelligence': 'ai',
          'gpt4': 'llm',
        },
      };

      // Direct mapping
      expect(applyTagMapping('machine_learning', tagMap)).toBe('ml');
      expect(applyTagMapping('GPT-4', tagMap)).toBe('llm');
      // No mapping - returns normalized
      expect(applyTagMapping('deep learning', tagMap)).toBe('deep learning');
    });

    it('loads tag map from file', async () => {
      const narrativeDir = getNarrativeDir();
      await mkdir(narrativeDir, { recursive: true });

      const tagMap: TagMapConfig = {
        mappings: {
          'test': 'verified',
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'tag-map.json'), tagMap);

      const loaded = await loadTagMap();
      expect(loaded.mappings['test']).toBe('verified');
    });

    it('returns empty mappings when tag-map.json does not exist', async () => {
      // Ensure no tag-map.json exists
      const loaded = await loadTagMap();
      expect(loaded.mappings).toEqual({});
    });

    it('generates raw tags report from fixtures', async () => {
      // Create test fixture with bookmarks
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      // Note: "Machine Learning" normalizes to "machine learning" (with space)
      // while "machine_learning" normalizes to "machinelearning" (no space)
      const bookmark1 = {
        id: 'tag-1',
        text: 'Test',
        tags: ['AI', 'machine_learning', 'GPT-4'],
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      const bookmark2 = {
        id: 'tag-2',
        text: 'Test2',
        tags: ['AI', 'machine_learning', 'Python'],
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-02',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'tag-1.json'),
        JSON.stringify(bookmark1)
      );
      await writeFile(
        path.join(processedDir, 'account1', 'review', 'tag-2.json'),
        JSON.stringify(bookmark2)
      );

      const report = await generateRawTagsReport(10);

      // AI appears twice (both "AI")
      const aiEntry = report.find((r) => r.normalized === 'ai');
      expect(aiEntry).toBeDefined();
      expect(aiEntry!.count).toBe(2);

      // machinelearning appears twice (same normalized form)
      const mlEntry = report.find((r) => r.normalized === 'machinelearning');
      expect(mlEntry).toBeDefined();
      expect(mlEntry!.count).toBe(2);

      // gpt4 appears once
      const gptEntry = report.find((r) => r.normalized === 'gpt4');
      expect(gptEntry).toBeDefined();
      expect(gptEntry!.count).toBe(1);

      // python appears once
      const pythonEntry = report.find((r) => r.normalized === 'python');
      expect(pythonEntry).toBeDefined();
      expect(pythonEntry!.count).toBe(1);

      // Report is sorted by count descending
      expect(report[0].count).toBeGreaterThanOrEqual(report[report.length - 1].count);
    });

    it('limits raw tags report to specified count', async () => {
      // Create test fixture with many tags
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const manyTags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const bookmark = {
        id: 'many-tags',
        text: 'Test',
        tags: manyTags,
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'many-tags.json'),
        JSON.stringify(bookmark)
      );

      const report = await generateRawTagsReport(5);
      expect(report.length).toBe(5);
    });
  });

  describe('backfill parity with pipeline (R5.1)', () => {
    it('calls addToReviewQueue for low-confidence candidates', async () => {
      // Create test fixture
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const bookmark = {
        id: 'backfill-low-conf',
        text: 'Test bookmark for low confidence',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'backfill-low-conf.json'),
        JSON.stringify(bookmark)
      );

      // Mock categorizeBookmark to return low-confidence result
      vi.mocked(categorizeBookmark).mockResolvedValueOnce({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test summary',
        keyValue: 'Test value',
        quotes: [],
        tags: ['test'],
        actionItems: [],
        priority: 'low',
        narrativeConfidence: 'low',
        narrativeCandidateId: 'maybe-narr-789',
        narrativeCandidateLabel: 'Maybe AI Topic',
      });

      await runBackfill({ limit: 1, since: null, resume: false, dryRun: false });

      expect(mockAddToReviewQueue).toHaveBeenCalledWith({
        bookmarkId: 'backfill-low-conf',
        candidateId: 'maybe-narr-789',
        candidateLabel: 'Maybe AI Topic',
      });
    });

    it('calls appendNarrativeAudit for every processed bookmark', async () => {
      // Create test fixture
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const bookmark = {
        id: 'backfill-audit',
        text: 'Test bookmark for audit log',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'backfill-audit.json'),
        JSON.stringify(bookmark)
      );

      await runBackfill({ limit: 1, since: null, resume: false, dryRun: false });

      expect(mockAppendNarrativeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          bookmarkId: 'backfill-audit',
          decision: expect.objectContaining({
            narrativeConfidence: expect.any(String),
          }),
        })
      );
    });

    it('persists candidate fields in updated bookmark file', async () => {
      // Create test fixture
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const filepath = path.join(processedDir, 'account1', 'review', 'backfill-persist.json');
      const bookmark = {
        id: 'backfill-persist',
        text: 'Test bookmark for persistence',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(filepath, JSON.stringify(bookmark));

      // Mock categorizeBookmark to return low-confidence with candidate fields
      vi.mocked(categorizeBookmark).mockResolvedValueOnce({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test summary',
        keyValue: 'Test value',
        quotes: [],
        tags: ['test'],
        actionItems: [],
        priority: 'low',
        narrativeConfidence: 'low',
        narrativeCandidateId: 'persist-cand-123',
        narrativeCandidateLabel: 'Candidate Topic',
      });

      await runBackfill({ limit: 1, since: null, resume: false, dryRun: false });

      // Verify the file was updated with candidate fields
      const content = await readFile(filepath, 'utf-8');
      const updated = JSON.parse(content);

      expect(updated.narrativeCandidateId).toBe('persist-cand-123');
      expect(updated.narrativeCandidateLabel).toBe('Candidate Topic');
      expect(updated.narrativeConfidence).toBe('low');
    });
  });

  describe('CLI output formatting (R5.2)', () => {
    it('help output contains expected sections', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await showHelp();
        const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

        // Check for key sections
        expect(output).toContain('Narratives CLI');
        expect(output).toContain('Commands:');
        expect(output).toContain('backfill [options]');
        expect(output).toContain('summary');
        expect(output).toContain('list [options]');
        expect(output).toContain('show <narrativeId>');
        expect(output).toContain('merge <fromId> <toId>');
        expect(output).toContain('rename <id>');
        expect(output).toContain('review');
        expect(output).toContain('refresh [options]');
        expect(output).toContain('export-obsidian');
        expect(output).toContain('heatmap');
        expect(output).toContain('Backfill Options:');
        expect(output).toContain('--limit');
        expect(output).toContain('--since');
        expect(output).toContain('--resume');
        expect(output).toContain('--dry-run');
        expect(output).toContain('Examples:');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('summary shows active and merged counts', async () => {
      // Create narrative index fixture
      const narrativeDir = getNarrativeDir();
      await mkdir(narrativeDir, { recursive: true });

      const index = {
        version: 1,
        narratives: {
          'narr-active-1': {
            id: 'narr-active-1',
            label: 'AI Topic',
            slug: 'ai-topic',
            normalizedLabel: 'ai topic',
            status: 'active',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-02T00:00:00Z',
          },
          'narr-active-2': {
            id: 'narr-active-2',
            label: 'ML Models',
            slug: 'ml-models',
            normalizedLabel: 'ml models',
            status: 'active',
            bookmarkCount: 3,
            recentBookmarkIds: [],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-02T00:00:00Z',
          },
          'narr-merged': {
            id: 'narr-merged',
            label: 'Old Topic',
            slug: 'old-topic',
            normalizedLabel: 'old topic',
            status: 'merged',
            mergedInto: 'narr-active-1',
            bookmarkCount: 0,
            recentBookmarkIds: [],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-02T00:00:00Z',
          },
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'index.json'), index);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await showNarrativesSummary();
        const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

        expect(output).toContain('Narratives Summary');
        expect(output).toContain('Active narratives: 2');
        expect(output).toContain('Merged narratives: 1');
        expect(output).toContain('Total: 3');
        expect(output).toContain('Top narratives by bookmark count:');
        expect(output).toContain('[5] AI Topic');
        expect(output).toContain('[3] ML Models');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('list shows narratives with configured sort and limit', async () => {
      // Create narrative index fixture
      const narrativeDir = getNarrativeDir();
      await mkdir(narrativeDir, { recursive: true });

      const index = {
        version: 1,
        narratives: {
          'narr-1': {
            id: 'narr-1',
            label: 'First Topic',
            slug: 'first-topic',
            normalizedLabel: 'first topic',
            status: 'active',
            bookmarkCount: 10,
            recentBookmarkIds: [],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-05T00:00:00Z',
            currentSummary: 'A topic about first things with lots of interesting content here',
          },
          'narr-2': {
            id: 'narr-2',
            label: 'Second Topic',
            slug: 'second-topic',
            normalizedLabel: 'second topic',
            status: 'active',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            aliases: [],
            createdAt: '2024-01-02T00:00:00Z',
            lastUpdatedAt: '2024-01-03T00:00:00Z',
          },
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'index.json'), index);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runListNarratives({ sort: 'count', limit: 10 });
        const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

        expect(output).toContain('Narratives (sorted by count, limit 10)');
        expect(output).toContain('narr-1');
        expect(output).toContain('Label: First Topic');
        expect(output).toContain('Count: 10');
        expect(output).toContain('narr-2');
        expect(output).toContain('Label: Second Topic');
        expect(output).toContain('Count: 5');
        expect(output).toContain('Summary: A topic about first things');
        expect(output).toContain('Total: 2 / 2 active narratives');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('show displays full narrative details', async () => {
      // Create narrative index fixture
      const narrativeDir = getNarrativeDir();
      await mkdir(narrativeDir, { recursive: true });

      const index = {
        version: 1,
        narratives: {
          'narr-detail': {
            id: 'narr-detail',
            label: 'Detailed Topic',
            slug: 'detailed-topic',
            normalizedLabel: 'detailed topic',
            status: 'active',
            bookmarkCount: 7,
            recentBookmarkIds: ['bm-1', 'bm-2', 'bm-3'],
            aliases: ['alias1', 'alias2'],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-10T00:00:00Z',
            lastSummaryUpdatedAt: '2024-01-09T00:00:00Z',
            currentSummary: 'This is a detailed summary of the topic.',
          },
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'index.json'), index);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runShowNarrative('narr-detail');
        const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

        expect(output).toContain('Narrative Details');
        expect(output).toContain('ID:         narr-detail');
        expect(output).toContain('Label:      Detailed Topic');
        expect(output).toContain('Slug:       detailed-topic');
        expect(output).toContain('Status:     active');
        expect(output).toContain('Count:      7');
        expect(output).toContain('Created:    2024-01-01');
        expect(output).toContain('Updated:    2024-01-10');
        expect(output).toContain('Summary Updated: 2024-01-09');
        expect(output).toContain('Normalized: detailed topic');
        expect(output).toContain('Aliases:    alias1, alias2');
        expect(output).toContain('Recent Bookmark IDs (3):');
        expect(output).toContain('- bm-1');
        expect(output).toContain('- bm-2');
        expect(output).toContain('- bm-3');
        expect(output).toContain('This is a detailed summary of the topic.');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('heatmap outputs and tests (R6.2)', () => {
    it('generates topic heatmap with correct schema', async () => {
      // Create test fixture with bookmarks with tags
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const now = new Date();
      const bookmark1 = {
        id: 'hm-1',
        text: 'Test',
        tags: ['AI', 'ML'],
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: now.toISOString(),
        processedAt: now.toISOString(),
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'hm-1.json'),
        JSON.stringify(bookmark1)
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runTopicHeatmap();

        // Verify heatmap file was created
        const narrativeDir = getNarrativeDir();
        const heatmapPath = path.join(narrativeDir, 'topic-heatmap.json');
        const heatmap = await readJsonSafe<Heatmap | null>(heatmapPath, null);

        expect(heatmap).not.toBeNull();
        expect(heatmap!.generatedAt).toBeDefined();
        expect(Array.isArray(heatmap!.topics)).toBe(true);

        // Each entry should have correct schema
        for (const entry of heatmap!.topics) {
          expect(typeof entry.topic).toBe('string');
          expect(typeof entry.total).toBe('number');
          expect(typeof entry.byWeek).toBe('object');
          expect(['rising', 'stable', 'declining']).toContain(entry.trend);
        }
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('generates narrative heatmap with correct counts', async () => {
      // Create test fixture with bookmarks with narratives
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const now = new Date();

      // Create 3 bookmarks for narrative-1
      for (let i = 1; i <= 3; i++) {
        const bookmark = {
          id: `nhm-${i}`,
          text: 'Test',
          narrativeId: 'narr-test-1',
          narrativeLabel: 'Test Narrative',
          author: { username: 'test', id: '1', name: 'Test' },
          createdAt: now.toISOString(),
          processedAt: now.toISOString(),
          account: 'account1',
        };

        await writeFile(
          path.join(processedDir, 'account1', 'review', `nhm-${i}.json`),
          JSON.stringify(bookmark)
        );
      }

      // Create 1 bookmark for narrative-2
      const bookmark2 = {
        id: 'nhm-4',
        text: 'Test',
        narrativeId: 'narr-test-2',
        narrativeLabel: 'Second Narrative',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: now.toISOString(),
        processedAt: now.toISOString(),
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'nhm-4.json'),
        JSON.stringify(bookmark2)
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runNarrativeHeatmap();

        // Verify heatmap file was created (uses same Heatmap schema with topics)
        const narrativeDir = getNarrativeDir();
        const heatmapPath = path.join(narrativeDir, 'narrative-heatmap.json');
        const heatmap = await readJsonSafe<Heatmap | null>(heatmapPath, null);

        expect(heatmap).not.toBeNull();
        expect(heatmap!.generatedAt).toBeDefined();
        expect(Array.isArray(heatmap!.topics)).toBe(true);

        // Check counts are correct - topics use narrative labels
        const narr1 = heatmap!.topics.find((t) => t.topic === 'Test Narrative');
        expect(narr1).toBeDefined();
        expect(narr1!.total).toBe(3);

        const narr2 = heatmap!.topics.find((t) => t.topic === 'Second Narrative');
        expect(narr2).toBeDefined();
        expect(narr2!.total).toBe(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('classifies trend correctly with threshold matching', () => {
      // Test rising: pctChange >= 0.5 and recent >= 5
      const risingWeeks = {
        '2024-W01': 2,
        '2024-W02': 2,
        '2024-W03': 5,
        '2024-W04': 6,
      };
      expect(calculateTrend(risingWeeks)).toBe('rising');

      // Test declining: pctChange <= -0.3 and baseline >= 5
      const decliningWeeks = {
        '2024-W01': 6,
        '2024-W02': 6,
        '2024-W03': 2,
        '2024-W04': 2,
      };
      expect(calculateTrend(decliningWeeks)).toBe('declining');

      // Test stable: pctChange between thresholds
      const stableWeeks = {
        '2024-W01': 5,
        '2024-W02': 5,
        '2024-W03': 5,
        '2024-W04': 5,
      };
      expect(calculateTrend(stableWeeks)).toBe('stable');

      // Test stable: not enough data
      const tooFewWeeks = {
        '2024-W01': 10,
        '2024-W02': 1,
      };
      expect(calculateTrend(tooFewWeeks)).toBe('stable');

      // Test stable: recent volume too low for rising (recent must be >= 5)
      const lowVolumeRising = {
        '2024-W01': 1,
        '2024-W02': 1,
        '2024-W03': 2,
        '2024-W04': 2,
      };
      // pctChange = (4-2)/2 = 100%, but recent = 4 < 5 so stable
      expect(calculateTrend(lowVolumeRising)).toBe('stable');

      // Test stable: baseline volume too low for declining
      const lowVolumeDeclining = {
        '2024-W01': 2,
        '2024-W02': 2,
        '2024-W03': 0,
        '2024-W04': 0,
      };
      expect(calculateTrend(lowVolumeDeclining)).toBe('stable');
    });

    it('heatmap topics are sorted by total descending', async () => {
      // Create test fixture with bookmarks with different tag frequencies
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const now = new Date();

      // Create bookmarks with "common" tag appearing 3 times
      for (let i = 1; i <= 3; i++) {
        await writeFile(
          path.join(processedDir, 'account1', 'review', `sort-${i}.json`),
          JSON.stringify({
            id: `sort-${i}`,
            text: 'Test',
            tags: ['common'],
            author: { username: 'test', id: '1', name: 'Test' },
            createdAt: now.toISOString(),
            processedAt: now.toISOString(),
            account: 'account1',
          })
        );
      }

      // Create 1 bookmark with "rare" tag
      await writeFile(
        path.join(processedDir, 'account1', 'review', 'sort-rare.json'),
        JSON.stringify({
          id: 'sort-rare',
          text: 'Test',
          tags: ['rare'],
          author: { username: 'test', id: '1', name: 'Test' },
          createdAt: now.toISOString(),
          processedAt: now.toISOString(),
          account: 'account1',
        })
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runTopicHeatmap();

        const narrativeDir = getNarrativeDir();
        const heatmapPath = path.join(narrativeDir, 'topic-heatmap.json');
        const heatmap = await readJsonSafe<Heatmap | null>(heatmapPath, null);

        expect(heatmap).not.toBeNull();
        expect(heatmap!.topics.length).toBeGreaterThanOrEqual(2);

        // Verify sorted by total descending
        for (let i = 1; i < heatmap!.topics.length; i++) {
          expect(heatmap!.topics[i - 1].total).toBeGreaterThanOrEqual(heatmap!.topics[i].total);
        }

        // Common should come before rare
        const commonIdx = heatmap!.topics.findIndex((t) => t.topic === 'common');
        const rareIdx = heatmap!.topics.findIndex((t) => t.topic === 'rare');
        expect(commonIdx).toBeLessThan(rareIdx);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('summary refresh uses shared LLM config (R5.3)', () => {
    it('updates summary and timestamp via mocked LLM', async () => {
      // Create narrative index and processed bookmarks
      const narrativeDir = getNarrativeDir();
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(narrativeDir, { recursive: true });
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      // Create narrative with bookmark reference
      const index = {
        version: 1,
        narratives: {
          'narr-refresh': {
            id: 'narr-refresh',
            label: 'Refresh Topic',
            slug: 'refresh-topic',
            normalizedLabel: 'refresh topic',
            status: 'active',
            bookmarkCount: 1,
            recentBookmarkIds: ['bm-refresh-1'],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-05T00:00:00Z',
          },
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'index.json'), index);

      // Create corresponding bookmark file
      const bookmark = {
        id: 'bm-refresh-1',
        text: 'This is a test bookmark about AI development and machine learning.',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'bm-refresh-1.json'),
        JSON.stringify(bookmark)
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRefreshSummaries({ limit: 1, dryRun: false });

        // Verify LLM was called
        expect(mockMessagesCreate).toHaveBeenCalled();

        // Verify the index was updated with summary
        const updatedIndex = await readJsonSafe<{ narratives: Record<string, { currentSummary?: string; lastSummaryUpdatedAt?: string }> } | null>(path.join(narrativeDir, 'index.json'), null);
        expect(updatedIndex).not.toBeNull();
        expect(updatedIndex!.narratives['narr-refresh'].currentSummary).toBe('This is a mocked AI-generated summary.');
        expect(updatedIndex!.narratives['narr-refresh'].lastSummaryUpdatedAt).toBeDefined();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('uses shared config model in LLM call', async () => {
      // Create narrative index and processed bookmarks
      const narrativeDir = getNarrativeDir();
      const processedDir = path.join(tempDir, 'processed');
      await mkdir(narrativeDir, { recursive: true });
      await mkdir(path.join(processedDir, 'account1', 'review'), { recursive: true });

      const index = {
        version: 1,
        narratives: {
          'narr-model-test': {
            id: 'narr-model-test',
            label: 'Model Test',
            slug: 'model-test',
            normalizedLabel: 'model test',
            status: 'active',
            bookmarkCount: 1,
            recentBookmarkIds: ['bm-model-1'],
            aliases: [],
            createdAt: '2024-01-01T00:00:00Z',
            lastUpdatedAt: '2024-01-05T00:00:00Z',
          },
        },
      };

      await writeJsonAtomic(path.join(narrativeDir, 'index.json'), index);

      const bookmark = {
        id: 'bm-model-1',
        text: 'Test content',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        account: 'account1',
      };

      await writeFile(
        path.join(processedDir, 'account1', 'review', 'bm-model-1.json'),
        JSON.stringify(bookmark)
      );

      mockMessagesCreate.mockClear();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRefreshSummaries({ limit: 1, dryRun: false });

        // Verify the model is from shared config (not hardcoded)
        expect(mockMessagesCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            model: expect.stringContaining('claude'),
            max_tokens: 200,
          })
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
