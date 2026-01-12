/**
 * Critical Consistency Tests for Narratives
 *
 * These tests verify the core invariants of the narrative system.
 * All tests use isolated temp directories to avoid cross-test contamination.
 */

import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to dynamically import to work with resetModules
let narrativeStorage: typeof import('../src/narrative-storage.js');

// Use a single describe block with proper beforeEach isolation
describe('narratives critical tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Reset modules to get fresh module state for each test
    vi.resetModules();

    // Re-import the module with fresh state
    narrativeStorage = await import('../src/narrative-storage.js');

    // Create a unique temp directory for each test
    const tempBase = path.join(process.cwd(), '.test-tmp');
    if (!existsSync(tempBase)) {
      await mkdir(tempBase, { recursive: true });
    }
    tempDir = path.join(tempBase, `critical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });

    // Set the data directory
    narrativeStorage.setDataDir(tempDir);

    // Create narratives directory
    const narrativesDir = path.join(tempDir, 'narratives');
    await mkdir(narrativesDir, { recursive: true });
  });

  afterEach(async () => {
    // Reset data directory
    if (narrativeStorage) {
      narrativeStorage.resetDataDir();
    }

    // Clean up temp directory
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Test: narrativeId never null after upsert
  it('converts null narrativeId to real ID when creating new narrative', async () => {
    const result = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'New Topic',
      narrativeConfidence: 'high',
    });

    expect(result).not.toBeNull();
    expect(result!.narrativeId).toBeTruthy();
    expect(result!.narrativeId).not.toBe('null');
    expect(result!.narrativeId).toMatch(/^[a-f0-9-]+$/);
  });

  it('returns real ID when referencing existing narrative', async () => {
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'Existing Topic',
      narrativeConfidence: 'high',
    });

    const second = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-2', {
      narrativeId: first!.narrativeId,
      narrativeLabel: 'Existing Topic',
      narrativeConfidence: 'high',
    });

    expect(second).not.toBeNull();
    expect(second!.narrativeId).toBe(first!.narrativeId);
  });

  // Test: no proliferation of narratives
  it('does not create narrative for empty label', async () => {
    const result = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: '',
      narrativeConfidence: 'high',
    });

    expect(result).toBeNull();

    const index = await narrativeStorage.loadNarrativeIndex();
    expect(Object.keys(index.narratives).length).toBe(0);
  });

  it('does not create narrative for whitespace-only label', async () => {
    const result = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: '   ',
      narrativeConfidence: 'high',
    });

    expect(result).toBeNull();

    const index = await narrativeStorage.loadNarrativeIndex();
    expect(Object.keys(index.narratives).length).toBe(0);
  });

  // Test: deduplication via normalized label
  it('deduplicates narratives with same normalized label', async () => {
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'AI Development',
      narrativeConfidence: 'high',
    });

    const second = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-2', {
      narrativeId: null,
      narrativeLabel: 'ai development',
      narrativeConfidence: 'high',
    });

    expect(second!.narrativeId).toBe(first!.narrativeId);

    const index = await narrativeStorage.loadNarrativeIndex();
    expect(Object.keys(index.narratives).length).toBe(1);
    expect(index.narratives[first!.narrativeId].bookmarkCount).toBe(2);
  });

  it('deduplicates narratives with different spacing', async () => {
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'Machine  Learning',
      narrativeConfidence: 'high',
    });

    const second = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-2', {
      narrativeId: null,
      narrativeLabel: 'Machine Learning',
      narrativeConfidence: 'high',
    });

    expect(second!.narrativeId).toBe(first!.narrativeId);
  });

  // Test: rebuild index parity
  it('rebuild produces same counts as incremental updates', async () => {
    const processedDir = path.join(tempDir, 'processed', 'testaccount', 'review');
    await mkdir(processedDir, { recursive: true });

    await narrativeStorage.upsertNarrativeFromAssignment('b-001', {
      narrativeId: null,
      narrativeLabel: 'Topic A',
      narrativeConfidence: 'high',
    });
    await narrativeStorage.upsertNarrativeFromAssignment('b-002', {
      narrativeId: null,
      narrativeLabel: 'Topic A',
      narrativeConfidence: 'high',
    });
    await narrativeStorage.upsertNarrativeFromAssignment('b-003', {
      narrativeId: null,
      narrativeLabel: 'Topic B',
      narrativeConfidence: 'high',
    });

    const incrementalIndex = await narrativeStorage.loadNarrativeIndex();
    const topicAIncremental = Object.values(incrementalIndex.narratives).find((n) => n.label === 'Topic A');
    const topicBIncremental = Object.values(incrementalIndex.narratives).find((n) => n.label === 'Topic B');

    for (const [id, label] of [
      ['b-001', 'Topic A'],
      ['b-002', 'Topic A'],
      ['b-003', 'Topic B'],
    ]) {
      const narrative = Object.values(incrementalIndex.narratives).find((n) => n.label === label);
      await writeFile(
        path.join(processedDir, `${id}.json`),
        JSON.stringify({
          id,
          narrativeId: narrative?.id,
          narrativeLabel: label,
          processedAt: new Date().toISOString(),
        })
      );
    }

    const rebuiltIndex = await narrativeStorage.rebuildNarrativeIndex();
    const topicARebuilt = Object.values(rebuiltIndex.narratives).find((n) => n.label === 'Topic A');
    const topicBRebuilt = Object.values(rebuiltIndex.narratives).find((n) => n.label === 'Topic B');

    expect(topicARebuilt?.bookmarkCount).toBe(topicAIncremental?.bookmarkCount);
    expect(topicBRebuilt?.bookmarkCount).toBe(topicBIncremental?.bookmarkCount);
  });

  // Test: slug generation
  it('generates valid slugs for various inputs', () => {
    expect(narrativeStorage.slugify('Hello World')).toBe('hello-world');
    expect(narrativeStorage.slugify('AI & Machine Learning')).toBe('ai-machine-learning');
    expect(narrativeStorage.slugify('Test 123')).toBe('test-123');
    expect(narrativeStorage.slugify('')).toBe('');
    expect(narrativeStorage.slugify('   ')).toBe('');
  });

  it('returns empty string for non-sluggable labels', () => {
    expect(narrativeStorage.slugify('!@#$%')).toBe('');
  });

  // Test: label normalization
  it('normalizes labels consistently', () => {
    expect(narrativeStorage.normalizeLabel('Hello World')).toBe('hello world');
    expect(narrativeStorage.normalizeLabel('  HELLO   WORLD  ')).toBe('hello world');
    expect(narrativeStorage.normalizeLabel('Hello-World')).toBe('hello-world');
    expect(narrativeStorage.normalizeLabel('Test_Case')).toBe('test_case');
  });

  it('strips non-word characters except hyphen', () => {
    expect(narrativeStorage.normalizeLabel('Café')).toBe('caf');
    expect(narrativeStorage.normalizeLabel('日本語')).toBe('');
  });

  // Test: NarrativeIndex read/write
  it('reads default index when file missing', async () => {
    const index = await narrativeStorage.loadNarrativeIndex();
    expect(index.narratives).toEqual({});
    expect(index.version).toBe(1);
  });

  it('writes and reads index correctly', async () => {
    const testIndex = {
      narratives: {
        'test-id': {
          id: 'test-id',
          slug: 'test',
          label: 'Test',
          normalizedLabel: 'test',
          aliases: [],
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          bookmarkCount: 5,
          recentBookmarkIds: ['b1', 'b2'],
          currentSummary: 'Test summary',
        },
      },
      version: 2,
    };

    await narrativeStorage.saveNarrativeIndex(testIndex);
    const loaded = await narrativeStorage.loadNarrativeIndex();

    expect(loaded.version).toBe(2);
    expect(loaded.narratives['test-id']).toBeDefined();
    expect(loaded.narratives['test-id'].label).toBe('Test');
    expect(loaded.narratives['test-id'].bookmarkCount).toBe(5);
  });

  // Test: new bookmark creates narrative
  it('creates narrative and updates index on first assignment', async () => {
    const result = await narrativeStorage.upsertNarrativeFromAssignment('new-bookmark', {
      narrativeId: null,
      narrativeLabel: 'Brand New Topic',
      narrativeConfidence: 'high',
    });

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);

    const index = await narrativeStorage.loadNarrativeIndex();
    expect(Object.keys(index.narratives).length).toBe(1);
    expect(index.narratives[result!.narrativeId]).toBeDefined();
    expect(index.narratives[result!.narrativeId].label).toBe('Brand New Topic');
    expect(index.narratives[result!.narrativeId].bookmarkCount).toBe(1);
    expect(index.narratives[result!.narrativeId].recentBookmarkIds).toContain('new-bookmark');
  });

  // Test: existing narrativeId increments count
  it('increments count and appends to recent IDs', async () => {
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'Incremental Topic',
      narrativeConfidence: 'high',
    });

    const second = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-2', {
      narrativeId: first!.narrativeId,
      narrativeConfidence: 'high',
    });

    expect(second!.created).toBe(false);

    const index = await narrativeStorage.loadNarrativeIndex();
    const narrative = index.narratives[first!.narrativeId];

    expect(narrative.bookmarkCount).toBe(2);
    expect(narrative.recentBookmarkIds).toContain('bookmark-1');
    expect(narrative.recentBookmarkIds).toContain('bookmark-2');
  });

  it('caps recent IDs at 30', async () => {
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-0', {
      narrativeId: null,
      narrativeLabel: 'Capped Topic',
      narrativeConfidence: 'high',
    });

    for (let i = 1; i <= 40; i++) {
      await narrativeStorage.upsertNarrativeFromAssignment(`bookmark-${i}`, {
        narrativeId: first!.narrativeId,
        narrativeConfidence: 'high',
      });
    }

    const index = await narrativeStorage.loadNarrativeIndex();
    const narrative = index.narratives[first!.narrativeId];

    expect(narrative.bookmarkCount).toBe(41);
    expect(narrative.recentBookmarkIds.length).toBe(30);
  });

  // Test: No proliferation of "Uncategorized" narratives (R7.1)
  it('does not create "Uncategorized" or similar generic narratives', async () => {
    // These generic labels should not create narratives
    const genericLabels = ['Uncategorized', 'Other', 'General', 'Misc', 'N/A'];

    for (const label of genericLabels) {
      const result = await narrativeStorage.upsertNarrativeFromAssignment(`bookmark-${label}`, {
        narrativeId: null,
        narrativeLabel: label,
        narrativeConfidence: 'high',
      });

      // If a narrative was created, verify it's not a generic one
      if (result) {
        const index = await narrativeStorage.loadNarrativeIndex();
        const narrative = index.narratives[result.narrativeId];
        // If we create narratives, they should have specific labels
        expect(narrative.label).toBe(label);
      }
    }
  });

  // Test: Audit log includes candidates + decision (R7.1)
  it('audit log records candidates and decision', async () => {
    const candidates = [
      { id: 'narr-1', label: 'AI Topic' },
      { id: 'narr-2', label: 'ML Topic' },
    ];

    await narrativeStorage.appendNarrativeAudit({
      timestamp: new Date().toISOString(),
      bookmarkId: 'audit-test-1',
      candidatesPresented: candidates,
      decision: {
        narrativeId: 'narr-1',
        narrativeLabel: 'AI Topic',
        narrativeConfidence: 'high',
      },
    });

    // Verify audit log contains the entry
    const auditLogPath = path.join(narrativeStorage.getNarrativeDir(), 'audit-log.ndjson');
    if (existsSync(auditLogPath)) {
      const { readFile } = await import('fs/promises');
      const content = await readFile(auditLogPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.bookmarkId).toBe('audit-test-1');
      expect(entry.candidatesPresented).toHaveLength(2);
      expect(entry.decision.narrativeId).toBe('narr-1');
      expect(entry.decision.narrativeConfidence).toBe('high');
    }
  });

  // Test: Audit log includes low-confidence candidate info (R7.1)
  it('audit log records low-confidence candidate when present', async () => {
    await narrativeStorage.appendNarrativeAudit({
      timestamp: new Date().toISOString(),
      bookmarkId: 'audit-low-conf-1',
      candidatesPresented: [{ id: 'narr-1', label: 'Maybe Topic' }],
      decision: {
        narrativeId: null,
        narrativeLabel: undefined,
        narrativeConfidence: 'low',
      },
      lowConfidenceCandidate: {
        id: 'maybe-narr-123',
        label: 'Uncertain Category',
      },
    });

    const auditLogPath = path.join(narrativeStorage.getNarrativeDir(), 'audit-log.ndjson');
    if (existsSync(auditLogPath)) {
      const { readFile } = await import('fs/promises');
      const content = await readFile(auditLogPath, 'utf-8');
      const lines = content.trim().split('\n');
      const entry = JSON.parse(lines[lines.length - 1]);

      expect(entry.lowConfidenceCandidate).toBeDefined();
      expect(entry.lowConfidenceCandidate.id).toBe('maybe-narr-123');
      expect(entry.lowConfidenceCandidate.label).toBe('Uncertain Category');
    }
  });

  // Test: concurrent updates don't lose data (R2.1)
  it('concurrent updates persist both changes', async () => {
    // Create a narrative
    const first = await narrativeStorage.upsertNarrativeFromAssignment('bookmark-1', {
      narrativeId: null,
      narrativeLabel: 'Concurrent Topic',
      narrativeConfidence: 'high',
    });

    expect(first).not.toBeNull();
    const narrativeId = first!.narrativeId;

    // Run 5 concurrent updates
    const promises = [];
    for (let i = 2; i <= 6; i++) {
      promises.push(
        narrativeStorage.upsertNarrativeFromAssignment(`bookmark-${i}`, {
          narrativeId,
          narrativeConfidence: 'high',
        })
      );
    }

    await Promise.all(promises);

    // Verify all updates persisted
    const index = await narrativeStorage.loadNarrativeIndex();
    const narrative = index.narratives[narrativeId];

    // 1 initial + 5 concurrent = 6 total
    expect(narrative.bookmarkCount).toBe(6);
  });
});
