import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('../src/failure-handler.js', () => ({
  shouldSkipRetry: vi.fn(),
  recordFailure: vi.fn(),
  clearFailure: vi.fn(),
  isRateLimited: vi.fn(),
  recordRateLimit: vi.fn(),
  clearRateLimit: vi.fn(),
}));

vi.mock('../src/content-extractor.js', () => ({
  enrichBookmark: vi.fn((b) => Promise.resolve(b)),
  extractUrls: vi.fn(() => []),
}));

vi.mock('../src/categorizer.js', () => ({
  categorizeBookmark: vi.fn(() =>
    Promise.resolve({
      category: 'review',
      contentType: 'other',
      contentFormat: 'tweet',
      summary: 'Test',
      keyValue: 'Test value',
      quotes: [],
      tags: [],
      actionItems: [],
      priority: 'low',
    })
  ),
}));

vi.mock('../src/accounts.js', () => ({
  getEnabledAccounts: vi.fn(),
}));

vi.mock('../src/bookmark-fetcher.js', () => ({
  getNewBookmarksForAccount: vi.fn(),
  markAsProcessed: vi.fn(),
}));

vi.mock('../src/storage.js', () => ({
  saveProcessedBookmark: vi.fn(() => Promise.resolve()),
  addToKnowledgeBase: vi.fn(() => Promise.resolve()),
  getSummary: vi.fn(() => Promise.resolve({ review: 0, try: 0, knowledge: 0, life: 0, skip: 0, total: 0, byAccount: {} })),
}));

vi.mock('../src/narrative-storage.js', () => ({
  getNarrativesForPrompt: vi.fn(() => Promise.resolve([])),
  upsertNarrativeFromAssignment: vi.fn(() => Promise.resolve(null)),
  normalizeLabel: vi.fn((s: string) => s.toLowerCase().trim()),
  addToReviewQueue: vi.fn(() => Promise.resolve()),
  appendNarrativeAudit: vi.fn(() => Promise.resolve()),
}));

import {
  clearFailure,
  isRateLimited,
  recordFailure,
  recordRateLimit,
  shouldSkipRetry,
} from '../src/failure-handler.js';
import { getEnabledAccounts } from '../src/accounts.js';
import { getNewBookmarksForAccount } from '../src/bookmark-fetcher.js';
import { categorizeBookmark } from '../src/categorizer.js';
import {
  addToReviewQueue,
  appendNarrativeAudit,
  getNarrativesForPrompt,
  upsertNarrativeFromAssignment,
} from '../src/narrative-storage.js';
import { pollOnce, processBookmark } from '../src/processor.js';
import { saveProcessedBookmark } from '../src/storage.js';

const mockShouldSkipRetry = shouldSkipRetry as ReturnType<typeof vi.fn>;
const mockRecordFailure = recordFailure as ReturnType<typeof vi.fn>;
const mockClearFailure = clearFailure as ReturnType<typeof vi.fn>;
const mockIsRateLimited = isRateLimited as ReturnType<typeof vi.fn>;
const mockRecordRateLimit = recordRateLimit as ReturnType<typeof vi.fn>;
const mockGetEnabledAccounts = getEnabledAccounts as ReturnType<typeof vi.fn>;
const mockGetNewBookmarksForAccount = getNewBookmarksForAccount as ReturnType<typeof vi.fn>;
const mockCategorizeBookmark = categorizeBookmark as ReturnType<typeof vi.fn>;
const mockSaveProcessedBookmark = saveProcessedBookmark as ReturnType<typeof vi.fn>;
const mockGetNarrativesForPrompt = getNarrativesForPrompt as ReturnType<typeof vi.fn>;
const mockUpsertNarrativeFromAssignment = upsertNarrativeFromAssignment as ReturnType<typeof vi.fn>;
const mockAddToReviewQueue = addToReviewQueue as ReturnType<typeof vi.fn>;
const mockAppendNarrativeAudit = appendNarrativeAudit as ReturnType<typeof vi.fn>;

describe('processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processBookmark', () => {
    it('returns skipType=poison_pill for poison pill items', async () => {
      mockShouldSkipRetry.mockResolvedValue({
        shouldSkip: true,
        skipType: 'poison_pill',
        reason: 'poison_pill',
      });

      const bookmark = { id: '123', text: 'test', _account: 'testuser', author: { username: 'author', id: '1', name: 'Author' }, createdAt: '2024-01-01' };
      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipType).toBe('poison_pill');
    });

    it('filters low-value bookmarks before enrichment', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });

      const bookmark = {
        id: '111',
        text: 'ok',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };
      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipType).toBe('filtered');
      expect(mockClearFailure).toHaveBeenCalledWith('testuser', '111');
    });

    it('skips persistence during dry run', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockSaveProcessedBookmark.mockClear();

      const bookmark = {
        id: '222',
        text: 'This is a longer message for dry run testing.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any, { dryRun: true });

      expect(result.success).toBe(true);
      expect(mockSaveProcessedBookmark).not.toHaveBeenCalled();
    });

    it('returns skipType=backoff for items in backoff period', async () => {
      mockShouldSkipRetry.mockResolvedValue({
        shouldSkip: true,
        skipType: 'backoff',
        reason: 'backoff_30s',
      });

      const bookmark = { id: '456', text: 'test', _account: 'testuser', author: { username: 'author', id: '1', name: 'Author' }, createdAt: '2024-01-01' };
      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipType).toBe('backoff');
    });

    it('clears failure record on successful processing', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });

      const bookmark = {
        id: '789',
        text: 'This is a longer test message for processing.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };
      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(true);
      expect(mockClearFailure).toHaveBeenCalledWith('testuser', '789');
    });

    it('saves fallback review entry when processing repeatedly fails', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockCategorizeBookmark.mockRejectedValueOnce(new Error('LLM failed'));
      mockRecordFailure.mockResolvedValue({ isPoisonPill: true, attempts: 3 });

      const bookmark = {
        id: '999',
        text: 'This is a longer test message for fallback.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(false);
      expect(mockSaveProcessedBookmark).toHaveBeenCalled();

      const savedArgs = mockSaveProcessedBookmark.mock.calls[0];
      expect(savedArgs).toBeDefined();
      const categorization = savedArgs?.[1];
      expect(categorization?.category).toBe('review');
      expect(categorization?.tags).toEqual(expect.arrayContaining(['needs-manual', 'processing-failed']));
    });

    it('fetches narratives before categorization', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockGetNarrativesForPrompt.mockResolvedValue([
        { id: 'narr-1', label: 'Test Narrative', slug: 'test-narrative' },
      ]);

      const bookmark = {
        id: 'narr-test-1',
        text: 'This is a test message for narrative processing.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      await processBookmark(bookmark as any);

      expect(mockGetNarrativesForPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ topK: 10, topRecent: 5, bookmarkTags: expect.any(Array) })
      );
      expect(mockCategorizeBookmark).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ id: 'narr-1' })])
      );
    });

    it('upserts narrative when categorization includes narrative assignment', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        narrativeId: 'narr-existing',
        narrativeLabel: 'Existing Narrative',
        narrativeConfidence: 'high',
      });
      mockUpsertNarrativeFromAssignment.mockResolvedValue({
        narrativeId: 'narr-existing',
        narrativeLabel: 'Existing Narrative',
        created: false,
      });

      const bookmark = {
        id: 'narr-test-2',
        text: 'This is a test message for narrative upsert.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any);

      expect(mockUpsertNarrativeFromAssignment).toHaveBeenCalledWith(
        'narr-test-2',
        expect.objectContaining({
          narrativeId: 'narr-existing',
          narrativeLabel: 'Existing Narrative',
          narrativeConfidence: 'high',
        })
      );
      expect(result.success).toBe(true);
      expect(result.categorization?.narrativeId).toBe('narr-existing');
    });

    it('creates new narrative when categorization has null narrativeId', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        narrativeId: null,
        narrativeLabel: 'New Narrative Topic',
        narrativeConfidence: 'high',
      });
      mockUpsertNarrativeFromAssignment.mockResolvedValue({
        narrativeId: 'narr-new-abc123',
        narrativeLabel: 'New Narrative Topic',
        created: true,
      });

      const bookmark = {
        id: 'narr-test-3',
        text: 'This is a test message for new narrative creation.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any);

      expect(mockUpsertNarrativeFromAssignment).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.categorization?.narrativeId).toBe('narr-new-abc123');
    });

    it('adds low-confidence candidates to review queue (R4.1)', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      // validateCategorization converts low-confidence to candidate fields
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        // Low confidence: main narrative fields cleared, candidate fields set
        narrativeConfidence: 'low',
        narrativeCandidateId: 'narr-uncertain',
        narrativeCandidateLabel: 'Uncertain Topic',
      });

      const bookmark = {
        id: 'narr-test-4',
        text: 'This is a test message for low confidence narrative.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(true);
      expect(result.categorization?.narrativeConfidence).toBe('low');
      // Candidate fields should be present
      expect(result.categorization?.narrativeCandidateId).toBe('narr-uncertain');
      expect(result.categorization?.narrativeCandidateLabel).toBe('Uncertain Topic');
      // Main narrative fields should not be set
      expect(result.categorization?.narrativeId).toBeUndefined();
      // Should NOT call upsert (no narrativeId/narrativeLabel)
      expect(mockUpsertNarrativeFromAssignment).not.toHaveBeenCalled();
      // Should add to review queue
      expect(mockAddToReviewQueue).toHaveBeenCalledWith({
        bookmarkId: 'narr-test-4',
        candidateId: 'narr-uncertain',
        candidateLabel: 'Uncertain Topic',
      });
    });

    it('does not add to review queue for high-confidence assignments', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        narrativeId: 'narr-123',
        narrativeLabel: 'High Confidence Topic',
        narrativeConfidence: 'high',
      });
      mockUpsertNarrativeFromAssignment.mockResolvedValue({
        narrativeId: 'narr-123',
        narrativeLabel: 'High Confidence Topic',
        created: false,
      });

      const bookmark = {
        id: 'narr-test-5',
        text: 'High confidence narrative test.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      const result = await processBookmark(bookmark as any);

      expect(result.success).toBe(true);
      expect(mockUpsertNarrativeFromAssignment).toHaveBeenCalled();
      // Should NOT add to review queue
      expect(mockAddToReviewQueue).not.toHaveBeenCalled();
    });

    it('appends audit log entry for every processed bookmark (R4.2)', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockGetNarrativesForPrompt.mockResolvedValue([
        { id: 'narr-1', label: 'Topic A' },
        { id: 'narr-2', label: 'Topic B' },
      ]);
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'medium',
        narrativeId: 'narr-1',
        narrativeLabel: 'Topic A',
        narrativeConfidence: 'high',
      });
      mockUpsertNarrativeFromAssignment.mockResolvedValue({
        narrativeId: 'narr-1',
        narrativeLabel: 'Topic A',
        created: false,
      });

      const bookmark = {
        id: 'audit-test-1',
        text: 'Test bookmark for audit.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      await processBookmark(bookmark as any);

      expect(mockAppendNarrativeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          bookmarkId: 'audit-test-1',
          candidatesPresented: [
            { id: 'narr-1', label: 'Topic A' },
            { id: 'narr-2', label: 'Topic B' },
          ],
          decision: expect.objectContaining({
            narrativeId: 'narr-1',
            narrativeLabel: 'Topic A',
            narrativeConfidence: 'high',
          }),
        })
      );
    });

    it('includes low-confidence candidate in audit log (R4.2)', async () => {
      mockShouldSkipRetry.mockResolvedValue({ shouldSkip: false });
      mockGetNarrativesForPrompt.mockResolvedValue([]);
      mockCategorizeBookmark.mockResolvedValue({
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'Test',
        keyValue: 'Test value',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        narrativeConfidence: 'low',
        narrativeCandidateId: 'maybe-narr-1',
        narrativeCandidateLabel: 'Maybe Topic',
      });

      const bookmark = {
        id: 'audit-test-2',
        text: 'Low confidence audit test.',
        _account: 'testuser',
        author: { username: 'author', id: '1', name: 'Author' },
        createdAt: '2024-01-01',
      };

      await processBookmark(bookmark as any);

      expect(mockAppendNarrativeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          bookmarkId: 'audit-test-2',
          decision: expect.objectContaining({
            narrativeId: null,
            narrativeConfidence: 'low',
          }),
          lowConfidenceCandidate: {
            id: 'maybe-narr-1',
            label: 'Maybe Topic',
          },
        })
      );
    });
  });

  describe('pollOnce', () => {
    it('short-circuits when account is rate limited', async () => {
      mockGetEnabledAccounts.mockResolvedValue([
        {
          id: '1',
          username: 'testuser',
          name: 'Test',
          authToken: 'token',
          ct0: 'ct0',
          enabled: true,
          addedAt: '2024-01-01',
          lastValidated: '2024-01-01',
          validationError: null,
        },
      ]);
      mockIsRateLimited.mockResolvedValue({ isLimited: true, remainingMs: 45_000 });

      const result = await pollOnce();

      expect(mockGetNewBookmarksForAccount).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.results[0]?.rateLimited).toBe(true);
    });

    it('records rate limit errors from fetch', async () => {
      mockGetEnabledAccounts.mockResolvedValue([
        {
          id: '2',
          username: 'ratelimited',
          name: 'Rate',
          authToken: 'token',
          ct0: 'ct0',
          enabled: true,
          addedAt: '2024-01-01',
          lastValidated: '2024-01-01',
          validationError: null,
        },
      ]);
      mockIsRateLimited.mockResolvedValue({ isLimited: false, remainingMs: 0 });
      mockGetNewBookmarksForAccount.mockResolvedValue({
        success: false,
        bookmarks: [],
        newCount: 0,
        totalFetched: 0,
        error: 'Rate limit',
        errorType: 'rate_limit',
      });
      mockRecordRateLimit.mockResolvedValue({
        account: 'ratelimited',
        nextAllowedPollAt: '2024-01-02T00:00:00.000Z',
        consecutiveRateLimits: 1,
        lastRateLimitAt: '2024-01-01T00:00:00.000Z',
      });

      const result = await pollOnce();

      expect(mockRecordRateLimit).toHaveBeenCalledWith('ratelimited');
      expect(result.success).toBe(true);
      expect(result.results[0]?.rateLimited).toBe(true);
      expect(result.results[0]?.nextAllowedAt).toBe('2024-01-02T00:00:00.000Z');
    });
  });
});
