import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addToReviewQueue,
  appendNarrativeAudit,
  dedupePreserveOrder,
  generateNarrativeId,
  getAuditPath,
  getNarrativesForPrompt,
  loadNarrativeIndex,
  loadReviewQueue,
  mergeNarratives,
  normalizeLabel,
  renameNarrative,
  resetDataDir,
  setDataDir,
  slugify,
  updateNarrativeSummary,
  upsertNarrativeFromAssignment,
} from '../src/narrative-storage.js';
import type { NarrativeIndex } from '../src/types.js';

describe('narrative-storage', () => {
  describe('normalizeLabel', () => {
    it('lowercases and trims', () => {
      expect(normalizeLabel('  AI Models  ')).toBe('ai models');
    });

    it('collapses whitespace', () => {
      expect(normalizeLabel('AI    ML   Models')).toBe('ai ml models');
    });

    it('strips punctuation', () => {
      expect(normalizeLabel("AI's Future: Now!")).toBe('ais future now');
    });

    it('handles empty string', () => {
      expect(normalizeLabel('')).toBe('');
    });
  });

  describe('dedupePreserveOrder', () => {
    it('removes duplicates', () => {
      expect(dedupePreserveOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('preserves order of first occurrence', () => {
      expect(dedupePreserveOrder(['z', 'y', 'x', 'y', 'z'])).toEqual(['z', 'y', 'x']);
    });

    it('handles empty array', () => {
      expect(dedupePreserveOrder([])).toEqual([]);
    });
  });

  describe('slugify', () => {
    it('converts to lowercase with dashes', () => {
      expect(slugify('AI Models')).toBe('ai-models');
    });

    it('removes special characters', () => {
      expect(slugify("What's Next?")).toBe('whats-next');
    });

    it('collapses multiple dashes', () => {
      expect(slugify('AI -- ML -- Models')).toBe('ai-ml-models');
    });

    it('removes leading/trailing dashes', () => {
      expect(slugify('  --AI-- ')).toBe('ai');
    });

    it('returns empty for non-sluggable input', () => {
      expect(slugify('!!!')).toBe('');
    });
  });

  describe('generateNarrativeId', () => {
    it('returns a UUID and slug', () => {
      const result = generateNarrativeId('AI Models');
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.slug).toBe('ai-models');
    });

    it('generates different IDs for same label', () => {
      const a = generateNarrativeId('Test');
      const b = generateNarrativeId('Test');
      expect(a.id).not.toBe(b.id);
      expect(a.slug).toBe(b.slug);
    });

    it('falls back to "narrative" for non-sluggable labels', () => {
      const result = generateNarrativeId('!!!');
      expect(result.slug).toBe('narrative');
    });
  });
});

describe('narrative-storage integration', () => {
  let tempDir: string;
  let mockNarrativeDir: string;
  let mockIndexPath: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), '.test-temp-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    await mkdir(tempDir, { recursive: true });
    setDataDir(tempDir);
    mockNarrativeDir = path.join(tempDir, 'narratives');
    mockIndexPath = path.join(mockNarrativeDir, 'index.json');
  });

  afterEach(async () => {
    resetDataDir();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadNarrativeIndex', () => {
    it('returns default when file missing', async () => {
      const index = await loadNarrativeIndex();
      expect(index).toEqual({ narratives: {}, version: 1 });
    });

    it('loads valid index', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const testIndex: NarrativeIndex = {
        narratives: {
          'test-id': {
            id: 'test-id',
            slug: 'test',
            label: 'Test',
            normalizedLabel: 'test',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: ['a', 'b', 'c'],
            currentSummary: 'A test narrative',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(testIndex));

      const index = await loadNarrativeIndex();
      expect(index.narratives['test-id'].label).toBe('Test');
      expect(index.version).toBe(1);
    });

    it('throws on invalid JSON', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      await writeFile(mockIndexPath, 'not valid json {{{');

      await expect(loadNarrativeIndex()).rejects.toThrow('invalid JSON');
    });

    it('preserves version', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const testIndex: NarrativeIndex = { narratives: {}, version: 42 };
      await writeFile(mockIndexPath, JSON.stringify(testIndex));

      const index = await loadNarrativeIndex();
      expect(index.version).toBe(42);
    });
  });

  describe('upsertNarrativeFromAssignment', () => {
    it('creates narrative when narrativeId is null with valid label', async () => {
      const result = await upsertNarrativeFromAssignment('bookmark-1', {
        narrativeId: null,
        narrativeLabel: 'AI Research',
        narrativeConfidence: 'high',
      });

      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.narrativeLabel).toBe('AI Research');
      expect(result!.narrativeId).toMatch(/^[0-9a-f-]+$/);

      // Verify index was updated
      const index = await loadNarrativeIndex();
      const narrative = index.narratives[result!.narrativeId];
      expect(narrative.bookmarkCount).toBe(1);
      expect(narrative.recentBookmarkIds).toContain('bookmark-1');
    });

    it('dedupes when label normalizes to existing narrative', async () => {
      // Create initial narrative
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'existing-id': {
            id: 'existing-id',
            slug: 'ai-research',
            label: 'AI Research',
            normalizedLabel: 'ai research',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      // Try to create with same normalized label
      const result = await upsertNarrativeFromAssignment('bookmark-2', {
        narrativeId: null,
        narrativeLabel: '  AI   Research  ', // Different spacing
        narrativeConfidence: 'high',
      });

      expect(result).not.toBeNull();
      expect(result!.created).toBe(false);
      expect(result!.narrativeId).toBe('existing-id');

      // Verify no new narrative was created
      const index = await loadNarrativeIndex();
      expect(Object.keys(index.narratives)).toHaveLength(1);
      expect(index.narratives['existing-id'].bookmarkCount).toBe(6);
    });

    it('updates existing narrative count and lastUpdatedAt', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'existing-id': {
            id: 'existing-id',
            slug: 'test',
            label: 'Test',
            normalizedLabel: 'test',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: ['old-1', 'old-2'],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      const result = await upsertNarrativeFromAssignment('bookmark-new', {
        narrativeId: 'existing-id',
        narrativeConfidence: 'medium',
      });

      expect(result).not.toBeNull();
      const index = await loadNarrativeIndex();
      const narrative = index.narratives['existing-id'];
      expect(narrative.bookmarkCount).toBe(6);
      expect(new Date(narrative.lastUpdatedAt).getTime()).toBeGreaterThan(new Date('2024-01-01').getTime());
    });

    it('caps ring buffer at 30 and dedupes', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const recentIds = Array.from({ length: 30 }, (_, i) => `old-${i}`);
      const existingIndex: NarrativeIndex = {
        narratives: {
          'existing-id': {
            id: 'existing-id',
            slug: 'test',
            label: 'Test',
            normalizedLabel: 'test',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 30,
            recentBookmarkIds: recentIds,
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      await upsertNarrativeFromAssignment('new-bookmark', {
        narrativeId: 'existing-id',
        narrativeConfidence: 'medium',
      });

      const index = await loadNarrativeIndex();
      const narrative = index.narratives['existing-id'];
      expect(narrative.recentBookmarkIds).toHaveLength(30);
      expect(narrative.recentBookmarkIds[0]).toBe('new-bookmark');
      expect(narrative.recentBookmarkIds).not.toContain('old-29');
    });

    it('returns null for low confidence', async () => {
      const result = await upsertNarrativeFromAssignment('bookmark-low-conf', {
        narrativeId: null,
        narrativeLabel: 'Test Topic',
        narrativeConfidence: 'low',
      });

      expect(result).toBeNull();
    });

    it('skips when unknown ID + medium confidence + no label match', async () => {
      const result = await upsertNarrativeFromAssignment('bookmark-1', {
        narrativeId: 'unknown-id',
        narrativeConfidence: 'medium',
      });

      expect(result).toBeNull();
    });

    it('follows merged narrative redirect', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'merged-id': {
            id: 'merged-id',
            slug: 'old',
            label: 'Old Name',
            normalizedLabel: 'old name',
            aliases: [],
            status: 'merged',
            mergedInto: 'target-id',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 0,
            recentBookmarkIds: [],
            currentSummary: '',
          },
          'target-id': {
            id: 'target-id',
            slug: 'new',
            label: 'New Name',
            normalizedLabel: 'new name',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      const result = await upsertNarrativeFromAssignment('bookmark-new', {
        narrativeId: 'merged-id',
        narrativeConfidence: 'medium',
      });

      expect(result).not.toBeNull();
      expect(result!.narrativeId).toBe('target-id');

      const index = await loadNarrativeIndex();
      expect(index.narratives['target-id'].bookmarkCount).toBe(6);
    });
  });

  describe('appendNarrativeAudit', () => {
    it('appends valid NDJSON lines', async () => {
      const auditPath = getAuditPath();

      await appendNarrativeAudit({
        timestamp: '2024-01-01T00:00:00.000Z',
        bookmarkId: 'bm-1',
        candidatesPresented: [{ id: 'n-1', label: 'Test' }],
        decision: { narrativeId: 'n-1', narrativeConfidence: 'high' },
      });

      await appendNarrativeAudit({
        timestamp: '2024-01-02T00:00:00.000Z',
        bookmarkId: 'bm-2',
        candidatesPresented: [],
        decision: { narrativeId: null, narrativeLabel: 'New', narrativeConfidence: 'medium' },
      });

      const content = await readFile(auditPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).bookmarkId).toBe('bm-1');
      expect(JSON.parse(lines[1]).bookmarkId).toBe('bm-2');
    });
  });

  describe('updateNarrativeSummary', () => {
    it('updates summary and timestamp', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'test-id': {
            id: 'test-id',
            slug: 'test',
            label: 'Test',
            normalizedLabel: 'test',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      await updateNarrativeSummary('test-id', 'This is a new summary.');

      const index = await loadNarrativeIndex();
      expect(index.narratives['test-id'].currentSummary).toBe('This is a new summary.');
      expect(index.narratives['test-id'].lastSummaryUpdatedAt).toBeDefined();
    });

    it('follows merged narrative redirect', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'merged-id': {
            id: 'merged-id',
            slug: 'old',
            label: 'Old',
            normalizedLabel: 'old',
            aliases: [],
            status: 'merged',
            mergedInto: 'target-id',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 0,
            recentBookmarkIds: [],
            currentSummary: '',
          },
          'target-id': {
            id: 'target-id',
            slug: 'new',
            label: 'New',
            normalizedLabel: 'new',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      await updateNarrativeSummary('merged-id', 'Updated summary');

      const index = await loadNarrativeIndex();
      expect(index.narratives['target-id'].currentSummary).toBe('Updated summary');
    });
  });

  describe('mergeNarratives', () => {
    it('marks source as merged and updates target', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'source-id': {
            id: 'source-id',
            slug: 'source',
            label: 'Source Topic',
            normalizedLabel: 'source topic',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 3,
            recentBookmarkIds: ['a', 'b'],
            currentSummary: '',
          },
          'target-id': {
            id: 'target-id',
            slug: 'target',
            label: 'Target Topic',
            normalizedLabel: 'target topic',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: ['c', 'd'],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      await mergeNarratives('source-id', 'target-id');

      const index = await loadNarrativeIndex();
      expect(index.narratives['source-id'].status).toBe('merged');
      expect(index.narratives['source-id'].mergedInto).toBe('target-id');
      expect(index.narratives['target-id'].bookmarkCount).toBe(8);
      expect(index.narratives['target-id'].aliases).toContain('Source Topic');
    });

    it('throws when merging into self', async () => {
      await expect(mergeNarratives('same-id', 'same-id')).rejects.toThrow('into itself');
    });
  });

  describe('renameNarrative', () => {
    it('updates label and adds old as alias', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'test-id': {
            id: 'test-id',
            slug: 'old-name',
            label: 'Old Name',
            normalizedLabel: 'old name',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      await renameNarrative('test-id', 'New Name');

      const index = await loadNarrativeIndex();
      expect(index.narratives['test-id'].label).toBe('New Name');
      expect(index.narratives['test-id'].normalizedLabel).toBe('new name');
      expect(index.narratives['test-id'].slug).toBe('new-name');
      expect(index.narratives['test-id'].aliases).toContain('Old Name');
    });
  });

  describe('getNarrativesForPrompt', () => {
    it('returns recent narratives', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          n1: {
            id: 'n1',
            slug: 'n1',
            label: 'Narrative 1',
            normalizedLabel: 'narrative 1',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-05T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
          n2: {
            id: 'n2',
            slug: 'n2',
            label: 'Narrative 2',
            normalizedLabel: 'narrative 2',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 10,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      const result = await getNarrativesForPrompt({ topRecent: 2 });

      expect(result).toHaveLength(2);
      // Most recent first
      expect(result[0].id).toBe('n1');
      expect(result[1].id).toBe('n2');
    });

    it('returns deterministic ordering', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          n1: {
            id: 'n1',
            slug: 'n1',
            label: 'AI',
            normalizedLabel: 'ai',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: '',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      const result1 = await getNarrativesForPrompt();
      const result2 = await getNarrativesForPrompt();

      expect(result1.map((n) => n.id)).toEqual(result2.map((n) => n.id));
    });

    it('prioritizes narratives matching bookmark tags (R4.0)', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'narr-old': {
            id: 'narr-old',
            slug: 'old-topic',
            label: 'Old Topic',
            normalizedLabel: 'old topic',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 100,
            recentBookmarkIds: [],
            currentSummary: 'An older narrative',
          },
          'narr-ai': {
            id: 'narr-ai',
            slug: 'ai-development',
            label: 'AI Development',
            normalizedLabel: 'ai development',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-02T00:00:00.000Z',
            lastUpdatedAt: '2024-01-02T00:00:00.000Z',
            bookmarkCount: 10,
            recentBookmarkIds: [],
            currentSummary: 'Machine learning and AI topics',
          },
          'narr-github': {
            id: 'narr-github',
            slug: 'github-repos',
            label: 'GitHub Repos',
            normalizedLabel: 'github repos',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-03T00:00:00.000Z',
            lastUpdatedAt: '2024-01-03T00:00:00.000Z',
            bookmarkCount: 5,
            recentBookmarkIds: [],
            currentSummary: 'Open source code repositories',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      // Tags matching AI and machine learning
      const result = await getNarrativesForPrompt({
        topRecent: 1,
        topK: 5,
        bookmarkTags: ['machine', 'learning', 'ai'],
      });

      // AI Development should be in results due to tag match
      const narrativeIds = result.map((n) => n.id);
      expect(narrativeIds).toContain('narr-ai');
    });

    it('includes relevant narratives based on summary keyword overlap', async () => {
      await mkdir(mockNarrativeDir, { recursive: true });
      const existingIndex: NarrativeIndex = {
        narratives: {
          'narr-ml': {
            id: 'narr-ml',
            slug: 'ml-research',
            label: 'ML Research',
            normalizedLabel: 'ml research',
            aliases: [],
            status: 'active',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastUpdatedAt: '2024-01-01T00:00:00.000Z',
            bookmarkCount: 10,
            recentBookmarkIds: [],
            currentSummary: 'Neural networks and transformers for video analysis',
          },
        },
        version: 1,
      };
      await writeFile(mockIndexPath, JSON.stringify(existingIndex));

      // Tag "video" matches the summary
      const result = await getNarrativesForPrompt({
        topRecent: 0,
        topK: 5,
        bookmarkTags: ['video'],
      });

      expect(result.map((n) => n.id)).toContain('narr-ml');
    });
  });

  describe('review queue', () => {
    it('adds and loads entries', async () => {
      await addToReviewQueue({ bookmarkId: 'bm-1', candidateLabel: 'Maybe AI' });
      await addToReviewQueue({ bookmarkId: 'bm-2', candidateId: 'n-1' });

      const queue = await loadReviewQueue();
      expect(queue.entries).toHaveLength(2);
      expect(queue.entries[0].bookmarkId).toBe('bm-1');
      expect(queue.entries[1].bookmarkId).toBe('bm-2');
      expect(queue.entries[0].addedAt).toBeDefined();
    });
  });
});
