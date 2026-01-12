import { describe, expect, it } from 'vitest';

import { deepMerge } from '../src/utils/deep-merge.js';

describe('deepMerge', () => {
  it('preserves nested defaults and applies overrides', () => {
    const base = {
      a: 1,
      nested: { x: 1, y: 2 },
      list: [1, 2],
    };
    const override = {
      nested: { y: 3 },
    };
    const result = deepMerge(base as Record<string, unknown>, override as Record<string, unknown>);

    expect(result).toEqual({
      a: 1,
      nested: { x: 1, y: 3 },
      list: [1, 2],
    });
  });

  it('respects explicit null overrides', () => {
    const base = { autoLink: { enabled: true } };
    const override = { autoLink: null };
    const result = deepMerge(base, override as any);

    expect(result).toEqual({ autoLink: null });
  });
});
