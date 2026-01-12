import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichBookmark, fetchArticleContent } from '../src/content-extractor.js';
import type { RawBirdBookmark } from '../src/types.js';

const readTweetMock = vi.hoisted(() => vi.fn());
const safeFetchMock = vi.hoisted(() => vi.fn());
const fetchConversationContextMock = vi.hoisted(() => vi.fn());
const getAccountByUsernameMock = vi.hoisted(() => vi.fn());

vi.mock('../src/integrations/bird-runner.js', () => ({
  readTweet: readTweetMock,
}));

vi.mock('../src/utils/safe-fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    safeFetch: safeFetchMock,
  };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetries: async <T>(operation: () => Promise<T>) => operation(),
}));

vi.mock('../src/context-fetcher.js', () => ({
  fetchConversationContext: fetchConversationContextMock,
}));

vi.mock('../src/accounts.js', () => ({
  getAccountByUsername: getAccountByUsernameMock,
}));

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
}));

describe('content-extractor enrichment', () => {
  beforeEach(() => {
    readTweetMock.mockReset();
    safeFetchMock.mockReset();
    fetchConversationContextMock.mockResolvedValue(null);
    getAccountByUsernameMock.mockResolvedValue({ authToken: 'token', ct0: 'ct0' });
  });

  it('uses Bird tweet content when available', async () => {
    readTweetMock.mockResolvedValue({
      success: true,
      tweet: {
        id: 't1',
        text: 'Bird content',
        author: { username: 'bird', name: 'Bird', id: '1' },
        createdAt: '2024-01-01',
      },
    });

    const bookmark: RawBirdBookmark = {
      id: 'b1',
      text: 'https://twitter.com/user/status/123',
      author: { username: 'author', name: 'Author', id: '1' },
      createdAt: '2024-01-01',
      _account: 'testuser',
    };

    const enriched = await enrichBookmark(bookmark);

    expect(enriched.articles[0]?.content).toBe('Bird content');
    expect(enriched.enrichmentErrors).toBeUndefined();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to oEmbed when Bird fails', async () => {
    readTweetMock.mockResolvedValue({ success: false, error: 'failed' });
    safeFetchMock.mockResolvedValue({
      success: true,
      data: JSON.stringify({ html: '<p>Fallback</p>', author_name: 'Someone' }),
      contentType: 'application/json',
    });

    const bookmark: RawBirdBookmark = {
      id: 'b2',
      text: 'https://twitter.com/user/status/456',
      author: { username: 'author', name: 'Author', id: '1' },
      createdAt: '2024-01-01',
      _account: 'testuser',
    };

    const enriched = await enrichBookmark(bookmark);

    expect(enriched.articles[0]?.content).toBe('Fallback');
    expect(enriched.enrichmentErrors).toBeUndefined();
  });


  it('uses Bird article content when available', async () => {
    const bookmark: RawBirdBookmark = {
      id: 'b-article',
      text: 'https://x.com/i/article/123',
      author: { username: 'author', name: 'Author', id: '1' },
      createdAt: '2024-01-01',
      article: {
        title: 'Article Title',
        text: 'Article body from Bird.',
      },
    };

    safeFetchMock.mockResolvedValue({ success: false, error: 'nope' });

    const enriched = await enrichBookmark(bookmark);

    expect(enriched.articles[0]?.title).toBe('Article Title');
    expect(enriched.articles[0]?.content).toBe('Article body from Bird.');
  });


  it('records transcript failures in enrichment errors', async () => {
    const { YoutubeTranscript } = await import('youtube-transcript');
    (YoutubeTranscript.fetchTranscript as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const bookmark: RawBirdBookmark = {
      id: 'b3',
      text: 'https://youtube.com/watch?v=abcdefghijk',
      author: { username: 'author', name: 'Author', id: '1' },
      createdAt: '2024-01-01',
    };

    const enriched = await enrichBookmark(bookmark);

    expect(enriched.enrichmentErrors?.[0]?.errorType).toBe('transcript');
    expect(enriched.enrichmentErrors?.[0]?.message).toContain('boom');
  });

  it('rejects non-HTML content types for article fetch', async () => {
    safeFetchMock.mockResolvedValue({
      success: true,
      data: 'PDF',
      contentType: 'application/pdf',
      finalUrl: 'https://example.com/file.pdf',
    });

    const result = await fetchArticleContent('https://example.com/file.pdf');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported content type');
  });

  describe('X article extraction edge cases', () => {
    it('extracts article from bookmark.article when URL is a t.co shortlink', async () => {
      // Scenario: Tweet text only has t.co link, but bookmark.article has the content
      // This simulates bookmarks like 2008073837372641733 and 2007820142860812424
      const bookmark: RawBirdBookmark = {
        id: 'x-article-tco',
        text: 'https://t.co/K5hVq8UX7d', // Only a t.co link, no x.com/i/article URL
        author: { username: 'author', name: 'Author', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
        article: {
          title: 'My X Article',
          text: 'This is the full article content that should be extracted.',
        },
      };

      const enriched = await enrichBookmark(bookmark);

      // Should extract the article even though URL doesn't contain /i/article/
      expect(enriched.articles.length).toBeGreaterThan(0);
      expect(enriched.articles[0]?.title).toBe('My X Article');
      expect(enriched.articles[0]?.content).toBe('This is the full article content that should be extracted.');
      expect(enriched.hasArticle).toBe(true);
    });

    it('extracts article from thread context authorThread', async () => {
      // Scenario: Main tweet is link-only but thread contains the article
      // This simulates bookmark 2010157660885176767
      const bookmark: RawBirdBookmark = {
        id: 'thread-article',
        text: 'https://t.co/x8ky37TEwb',
        author: { username: 'mrexodia', name: 'Duncan', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
        conversationId: 'thread-article',
      };

      // Thread context has the article in authorThread
      fetchConversationContextMock.mockResolvedValue({
        parentChain: [],
        authorThread: [
          {
            id: 'thread-article',
            text: 'https://t.co/x8ky37TEwb',
            author: { username: 'mrexodia', name: 'Duncan', id: '1' },
            createdAt: '2024-01-01',
            article: {
              title: 'Vibe Engineering: What I Learned',
              text: 'Full article about AI coding workflows and best practices.',
            },
          },
        ],
        totalInThread: 1,
        hasMoreReplies: false,
        topReplies: [],
      });

      const enriched = await enrichBookmark(bookmark);

      // Should extract article from thread context
      expect(enriched.articles.length).toBeGreaterThan(0);
      expect(enriched.articles[0]?.title).toBe('Vibe Engineering: What I Learned');
      expect(enriched.articles[0]?.content).toContain('AI coding workflows');
    });

    it('extracts article from thread context quotedTweet', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'quote-with-article',
        text: 'Great article!',
        author: { username: 'quoter', name: 'Quoter', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
      };

      fetchConversationContextMock.mockResolvedValue({
        parentChain: [],
        authorThread: [],
        totalInThread: 1,
        hasMoreReplies: false,
        topReplies: [],
        quotedTweet: {
          id: 'original-article',
          text: 'Check out my article',
          author: { username: 'original', name: 'Original', id: '2' },
          createdAt: '2024-01-01',
          article: {
            title: 'Quoted Article Title',
            text: 'This is the quoted article content.',
          },
        },
      });

      const enriched = await enrichBookmark(bookmark);

      expect(enriched.articles.length).toBeGreaterThan(0);
      expect(enriched.articles[0]?.title).toBe('Quoted Article Title');
    });

    it('sets hasArticle true when bookmark.article exists without URL detection', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'has-article-flag',
        text: 'https://t.co/abc123', // t.co link won't be classified as article
        author: { username: 'author', name: 'Author', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
        article: {
          title: 'Direct Article',
          text: 'Article content available directly.',
        },
      };

      const enriched = await enrichBookmark(bookmark);

      expect(enriched.hasArticle).toBe(true);
    });

    it('extracts article from thread context parentChain', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'reply-to-article',
        text: 'Great points!',
        author: { username: 'replier', name: 'Replier', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
        inReplyToStatusId: 'parent-article',
      };

      fetchConversationContextMock.mockResolvedValue({
        parentChain: [
          {
            id: 'parent-article',
            text: 'Check out my article',
            author: { username: 'parent', name: 'Parent', id: '2' },
            createdAt: '2024-01-01',
            article: {
              title: 'Parent Chain Article',
              text: 'Article content from parent tweet.',
            },
          },
        ],
        authorThread: [],
        totalInThread: 2,
        hasMoreReplies: false,
        topReplies: [],
      });

      const enriched = await enrichBookmark(bookmark);

      expect(enriched.articles.length).toBeGreaterThan(0);
      expect(enriched.articles[0]?.title).toBe('Parent Chain Article');
    });

    it('extracts article from thread context topReplies as last resort', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'tweet-with-article-reply',
        text: 'Anyone have thoughts on this?',
        author: { username: 'asker', name: 'Asker', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
      };

      fetchConversationContextMock.mockResolvedValue({
        parentChain: [],
        authorThread: [],
        totalInThread: 3,
        hasMoreReplies: false,
        topReplies: [
          {
            id: 'reply-with-article',
            text: 'Here is a relevant article',
            author: { username: 'helper', name: 'Helper', id: '2' },
            createdAt: '2024-01-01',
            article: {
              title: 'Reply Article',
              text: 'Helpful article content from a reply.',
            },
          },
        ],
      });

      const enriched = await enrichBookmark(bookmark);

      expect(enriched.articles.length).toBeGreaterThan(0);
      expect(enriched.articles[0]?.title).toBe('Reply Article');
    });

    it('sets hasArticle true when article found in thread context', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'thread-article-flag',
        text: 'Just a tweet', // No article URL, no bookmark.article
        author: { username: 'author', name: 'Author', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
      };

      fetchConversationContextMock.mockResolvedValue({
        parentChain: [],
        authorThread: [
          {
            id: 'thread-article-flag',
            text: 'Just a tweet',
            author: { username: 'author', name: 'Author', id: '1' },
            createdAt: '2024-01-01',
            article: {
              title: 'Thread Context Article',
              text: 'Article found in thread context.',
            },
          },
        ],
        totalInThread: 1,
        hasMoreReplies: false,
        topReplies: [],
      });

      const enriched = await enrichBookmark(bookmark);

      expect(enriched.hasArticle).toBe(true);
      expect(enriched.articles.length).toBe(1);
    });

    it('prioritizes authorThread over parentChain over topReplies', async () => {
      const bookmark: RawBirdBookmark = {
        id: 'priority-test',
        text: 'Testing priority',
        author: { username: 'author', name: 'Author', id: '1' },
        createdAt: '2024-01-01',
        _account: 'testuser',
      };

      fetchConversationContextMock.mockResolvedValue({
        parentChain: [
          {
            id: 'parent',
            text: 'Parent',
            author: { username: 'parent', name: 'Parent', id: '2' },
            createdAt: '2024-01-01',
            article: { title: 'Parent Article', text: 'From parent' },
          },
        ],
        authorThread: [
          {
            id: 'priority-test',
            text: 'Testing priority',
            author: { username: 'author', name: 'Author', id: '1' },
            createdAt: '2024-01-01',
            article: { title: 'Author Thread Article', text: 'From author thread' },
          },
        ],
        totalInThread: 3,
        hasMoreReplies: false,
        topReplies: [
          {
            id: 'reply',
            text: 'Reply',
            author: { username: 'replier', name: 'Replier', id: '3' },
            createdAt: '2024-01-01',
            article: { title: 'Reply Article', text: 'From reply' },
          },
        ],
      });

      const enriched = await enrichBookmark(bookmark);

      // Should pick authorThread article (highest priority)
      expect(enriched.articles[0]?.title).toBe('Author Thread Article');
    });
  });
});
