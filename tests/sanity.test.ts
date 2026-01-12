import { describe, expect, it } from 'vitest';

describe('sanity', () => {
  it('confirms test framework works', () => {
    expect(1 + 1).toBe(2);
  });

  it('supports async tests', async () => {
    const result = await Promise.resolve('async works');
    expect(result).toBe('async works');
  });
});
