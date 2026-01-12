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

  it('extracts article content from raw payload', () => {
    const result = normalizeBirdBookmark({
      ...baseTweet,
      _raw: {
        article: {
          title: 'Article Headline',
          text: 'Article body',
        },
      },
    });

    expect(result.article?.title).toBe('Article Headline');
    expect(result.article?.text).toContain('Article Headline');
    expect(result.article?.text).toContain('Article body');
  });
});
