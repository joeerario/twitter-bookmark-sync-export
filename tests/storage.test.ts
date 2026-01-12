import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getRecentItems, getSummary, isBookmarkProcessed, saveProcessedBookmark } from '../src/storage.js';
import type { EnrichedBookmark, Categorization } from '../src/types.js';
import { dataPath } from './helpers/data-paths.js';

describe('storage', () => {
  describe('saveProcessedBookmark ID handling', () => {
    it('uses tweetId when available', async () => {
      const account = '__test_id__';
      const bookmark: Partial<EnrichedBookmark> = {
        tweetId: 'tweet123',
        id: 'id456',
        text: 'test',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: account,
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
      };

      try {
        const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
        expect(filepath).toContain('tweet123.json');
      } finally {
        await rm(dataPath('processed', account), { recursive: true, force: true });
      }
    });

    it('falls back to id when tweetId is missing', async () => {
      const account = '__test_id_fallback__';
      const bookmark: Partial<EnrichedBookmark> = {
        id: 'rawid789',
        text: 'test',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: account,
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
      };

      try {
        const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
        expect(filepath).toContain('rawid789.json');
      } finally {
        await rm(dataPath('processed', account), { recursive: true, force: true });
      }
    });

    it('throws when both tweetId and id are missing', async () => {
      const bookmark: Partial<EnrichedBookmark> = {
        text: 'test',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: 'test',
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
      };

      await expect(saveProcessedBookmark(bookmark as EnrichedBookmark, categorization)).rejects.toThrow('missing both tweetId and id');
    });
  });

  it('skips malformed JSON files when reading recent items', async () => {
    const account = '__test__';
    const category = 'review';
    const baseDir = dataPath('processed', account, category);

    await mkdir(baseDir, { recursive: true });

    const goodItem = {
      id: 'good',
      processedAt: new Date().toISOString(),
    };

    await writeFile(path.join(baseDir, 'good.json'), JSON.stringify(goodItem, null, 2));
    await writeFile(path.join(baseDir, 'bad.json'), '{invalid json');

    try {
      const items = await getRecentItems(category, 10, account);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe('good');
    } finally {
      await rm(dataPath('processed', account), { recursive: true, force: true });
    }
  });

  it('detects processed bookmarks by id across categories', async () => {
    const account = '__test__';
    const category = 'review';
    const baseDir = dataPath('processed', account, category);

    await mkdir(baseDir, { recursive: true });

    try {
      await writeFile(path.join(baseDir, '123.json'), JSON.stringify({ id: '123' }, null, 2));
      expect(isBookmarkProcessed(account, '123')).toBe(true);
      expect(isBookmarkProcessed(account, 'missing')).toBe(false);
    } finally {
      await rm(dataPath('processed', account), { recursive: true, force: true });
    }
  });

  it('persists enrichment errors in saved output', async () => {
    const account = '__test_enrich__';
    const bookmark: Partial<EnrichedBookmark> = {
      tweetId: 'tweet-err',
      id: 'id-err',
      text: 'test',
      author: { username: 'test', id: '1', name: 'Test' },
      createdAt: '2024-01-01',
      likeCount: 0,
      retweetCount: 0,
      replyCount: 0,
      urls: [],
      isReply: false,
      isPartOfThread: false,
      transcripts: [],
      articles: [],
      enrichmentErrors: [{ url: 'https://example.com', errorType: 'article', message: 'fail' }],
      _account: account,
    };
    const categorization: Categorization = {
      category: 'review',
      contentType: 'other',
      contentFormat: 'tweet',
      summary: 'test',
      keyValue: 'test',
      quotes: [],
      tags: [],
      actionItems: [],
      priority: 'low',
    };

    try {
      const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
      const saved = JSON.parse(await readFile(filepath, 'utf-8')) as EnrichedBookmark;
      expect(saved.enrichmentErrors).toHaveLength(1);
      expect(saved.enrichmentErrors?.[0]?.errorType).toBe('article');
    } finally {
      await rm(dataPath('processed', account), { recursive: true, force: true });
    }
  });

  it('summarizes counts per account and category', async () => {
    const accountA = '__summary_a__';
    const accountB = '__summary_b__';
    const baseBookmark: Partial<EnrichedBookmark> = {
      id: 'base',
      text: 'test',
      author: { username: 'test', id: '1', name: 'Test' },
      createdAt: '2024-01-01',
      likeCount: 0,
      retweetCount: 0,
      replyCount: 0,
      urls: [],
      isReply: false,
      isPartOfThread: false,
      transcripts: [],
      articles: [],
    };
    const reviewCategorization: Categorization = {
      category: 'review',
      contentType: 'other',
      contentFormat: 'tweet',
      summary: 'review',
      keyValue: 'test',
      quotes: [],
      tags: [],
      actionItems: [],
      priority: 'low',
    };
    const tryCategorization: Categorization = {
      category: 'try',
      contentType: 'other',
      contentFormat: 'tweet',
      summary: 'try',
      keyValue: 'test',
      quotes: [],
      tags: [],
      actionItems: [],
      priority: 'low',
    };

    try {
      await saveProcessedBookmark({ ...baseBookmark, tweetId: 'a1', _account: accountA } as EnrichedBookmark, reviewCategorization, accountA);
      await saveProcessedBookmark({ ...baseBookmark, tweetId: 'a2', _account: accountA } as EnrichedBookmark, tryCategorization, accountA);
      await saveProcessedBookmark({ ...baseBookmark, tweetId: 'b1', _account: accountB } as EnrichedBookmark, reviewCategorization, accountB);

      const summary = await getSummary(null, true);

      expect(summary.byAccount[accountA]?.total).toBe(2);
      expect(summary.byAccount[accountA]?.review).toBe(1);
      expect(summary.byAccount[accountA]?.try).toBe(1);
      expect(summary.byAccount[accountB]?.total).toBe(1);
      expect(summary.byAccount[accountB]?.review).toBe(1);
    } finally {
      await rm(dataPath('processed', accountA), { recursive: true, force: true });
      await rm(dataPath('processed', accountB), { recursive: true, force: true });
    }
  });

  describe('narrative field persistence (R4.3)', () => {
    it('persists narrative fields for high-confidence assignments', async () => {
      const account = '__test_narr_high__';
      const bookmark: Partial<EnrichedBookmark> = {
        tweetId: 'narr-high-1',
        text: 'test narrative',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: account,
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'medium',
        narrativeId: 'narr-abc-123',
        narrativeLabel: 'AI Development',
        narrativeConfidence: 'high',
      };

      try {
        const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
        const saved = JSON.parse(await readFile(filepath, 'utf-8'));

        expect(saved.narrativeId).toBe('narr-abc-123');
        expect(saved.narrativeLabel).toBe('AI Development');
        expect(saved.narrativeConfidence).toBe('high');
        // Should NOT have candidate fields
        expect(saved.narrativeCandidateId).toBeUndefined();
        expect(saved.narrativeCandidateLabel).toBeUndefined();
      } finally {
        await rm(dataPath('processed', account), { recursive: true, force: true });
      }
    });

    it('persists candidate fields for low-confidence assignments', async () => {
      const account = '__test_narr_low__';
      const bookmark: Partial<EnrichedBookmark> = {
        tweetId: 'narr-low-1',
        text: 'test low confidence',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: account,
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        // Low confidence: no narrativeId/Label, only candidates
        narrativeConfidence: 'low',
        narrativeCandidateId: 'maybe-narr-456',
        narrativeCandidateLabel: 'Maybe Machine Learning',
      };

      try {
        const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
        const saved = JSON.parse(await readFile(filepath, 'utf-8'));

        // Should NOT have main narrative fields
        expect(saved.narrativeId).toBeUndefined();
        expect(saved.narrativeLabel).toBeUndefined();
        // Should have confidence and candidate fields
        expect(saved.narrativeConfidence).toBe('low');
        expect(saved.narrativeCandidateId).toBe('maybe-narr-456');
        expect(saved.narrativeCandidateLabel).toBe('Maybe Machine Learning');
      } finally {
        await rm(dataPath('processed', account), { recursive: true, force: true });
      }
    });

    it('does not persist narrativeId: null as undefined', async () => {
      const account = '__test_narr_null__';
      const bookmark: Partial<EnrichedBookmark> = {
        tweetId: 'narr-null-1',
        text: 'test null narrative',
        author: { username: 'test', id: '1', name: 'Test' },
        createdAt: '2024-01-01',
        likeCount: 0,
        retweetCount: 0,
        replyCount: 0,
        urls: [],
        isReply: false,
        isPartOfThread: false,
        transcripts: [],
        articles: [],
        _account: account,
      };
      const categorization: Categorization = {
        category: 'review',
        contentType: 'other',
        contentFormat: 'tweet',
        summary: 'test',
        keyValue: 'test',
        quotes: [],
        tags: [],
        actionItems: [],
        priority: 'low',
        narrativeId: null,
        narrativeLabel: 'New Topic',
        narrativeConfidence: 'high',
      };

      try {
        const filepath = await saveProcessedBookmark(bookmark as EnrichedBookmark, categorization, account);
        const saved = JSON.parse(await readFile(filepath, 'utf-8'));

        // narrativeId: null should NOT be persisted (converted to omitted)
        expect(saved.narrativeId).toBeUndefined();
        expect('narrativeId' in saved).toBe(false);
        // Label and confidence should still be present
        expect(saved.narrativeLabel).toBe('New Topic');
        expect(saved.narrativeConfidence).toBe('high');
      } finally {
        await rm(dataPath('processed', account), { recursive: true, force: true });
      }
    });
  });
});
