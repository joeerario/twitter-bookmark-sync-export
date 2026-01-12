import { describe, expect, it, vi } from 'vitest';

import { analyzeBookmark, extractUrls, fetchArticleContent } from '../src/content-extractor.js';
import type { RawBirdBookmark } from '../src/types.js';

describe('content-extractor', () => {
  it('normalizes trailing punctuation in URLs', () => {
    // Create a minimal bookmark with the test text
    const bookmark: RawBirdBookmark = {
      id: '1',
      text: 'Check https://example.com). and https://sub.example.com/path, plus https://example.com/test?x=1&y=2.',
      author: { username: 'test', name: 'Test', id: '1' },
      createdAt: '2024-01-01',
    };
    const urls = extractUrls(bookmark);

    expect(urls).toEqual(['https://example.com', 'https://sub.example.com/path', 'https://example.com/test?x=1&y=2']);
  });

  it('prefers expanded URLs from entities', () => {
    const bookmark: RawBirdBookmark = {
      id: '2',
      text: 'Check https://t.co/short',
      author: { username: 'test', name: 'Test', id: '1' },
      createdAt: '2024-01-01',
      entities: {
        urls: [
          {
            url: 'https://t.co/short',
            expanded_url: 'https://example.com/full',
            display_url: 'example.com/full',
            start: 6,
            end: 22,
          },
        ],
      },
    };

    const urls = extractUrls(bookmark);

    expect(urls).toEqual(['https://example.com/full']);
  });

  it('preserves engagement counts in analyzeBookmark', () => {
    const bookmark: RawBirdBookmark = {
      id: '1',
      text: 'hello',
      author: { username: 'user', name: 'User', id: '1' },
      createdAt: '2024-01-01',
      likeCount: 10,
      retweetCount: 2,
      replyCount: 1,
    };

    const result = analyzeBookmark(bookmark);
    expect(result.likeCount).toBe(10);
    expect(result.retweetCount).toBe(2);
    expect(result.replyCount).toBe(1);
  });

  it('rejects localhost URLs (SSRF protection)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchArticleContent('http://localhost:8080/admin');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked host');
    consoleError.mockRestore();
  });

  it('rejects private IP URLs (SSRF protection)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchArticleContent('http://192.168.1.1/router');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked IP');
    consoleError.mockRestore();
  });
});
