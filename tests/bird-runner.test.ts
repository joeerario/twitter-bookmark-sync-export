import { describe, expect, it } from 'vitest';

import { normalizeBirdBookmark } from '../src/integrations/bird-runner.js';

const baseTweet = {
  id: '1',
  text: 'Check this https://t.co/short',
  author: { username: 'author', name: 'Author' },
};

describe('bird-runner URL entities', () => {
  it('maps raw entity URLs into normalized bookmarks', () => {
    const result = normalizeBirdBookmark({
      ...baseTweet,
      _raw: {
        legacy: {
          entities: {
            urls: [
              {
                url: 'https://t.co/short',
                expanded_url: 'https://example.com/article',
                display_url: 'example.com/article',
                indices: [12, 35],
              },
            ],
          },
        },
      },
    });

    expect(result.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/article');
  });

  it('prefers explicit entities over raw data', () => {
    const result = normalizeBirdBookmark({
      ...baseTweet,
      entities: {
        urls: [
          {
            url: 'https://t.co/short',
            expanded_url: 'https://example.com/from-entities',
            display_url: 'example.com/from-entities',
            start: 12,
            end: 35,
          },
        ],
      },
      _raw: {
        legacy: {
          entities: {
            urls: [
              {
                url: 'https://t.co/short',
                expanded_url: 'https://example.com/from-raw',
                display_url: 'example.com/from-raw',
                indices: [12, 35],
              },
            ],
          },
        },
      },
    });

    expect(result.entities?.urls?.[0]?.expanded_url).toBe('https://example.com/from-entities');
  });

  it('extracts article from Bird v0.7 public output', () => {
    // Bird v0.7+ provides article metadata and full text in public fields
    // (no need to parse _raw - Bird handles Draft.js rendering internally)
    const result = normalizeBirdBookmark({
      ...baseTweet,
      text: 'Article Headline\n\nArticle body with full content...',
      article: {
        title: 'Article Headline',
        previewText: 'Article body preview',
      },
    });

    expect(result.article?.title).toBe('Article Headline');
    // Title is stripped from text to avoid duplication in downstream rendering
    expect(result.article?.text).not.toContain('Article Headline');
    expect(result.article?.text).toContain('Article body');
  });
});
