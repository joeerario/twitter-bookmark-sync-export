import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  getReadJsonFailureCount,
  readJsonSafe,
  readJsonWithFallback,
  resetReadJsonFailureCount,
} from '../src/utils/read-json-safe.js';
import { withRetries } from '../src/utils/retry.js';
import { validateUrl } from '../src/utils/safe-fetch.js';
import { withTempDir } from './helpers/temp-dir.js';

describe('readJsonSafe', () => {
  it('returns default value when file does not exist', async () => {
    const result = await readJsonSafe('/nonexistent/path/file.json', { default: true });
    expect(result).toEqual({ default: true });
  });

  it('parses valid JSON file', async () => {
    await withTempDir('json-test-', async (dir) => {
      const filepath = path.join(dir, 'test.json');
      await writeFile(filepath, JSON.stringify({ foo: 'bar' }));

      const result = await readJsonSafe(filepath, {});
      expect(result).toEqual({ foo: 'bar' });
    });
  });

  it('throws on corrupted JSON file', async () => {
    await withTempDir('json-test-', async (dir) => {
      const filepath = path.join(dir, 'corrupted.json');
      await writeFile(filepath, '{invalid json');

      resetReadJsonFailureCount();
      await expect(readJsonSafe(filepath, {})).rejects.toThrow('Corrupted JSON file');
      expect(getReadJsonFailureCount()).toBe(1);
    });
  });

  it('throws on empty JSON file', async () => {
    await withTempDir('json-test-', async (dir) => {
      const filepath = path.join(dir, 'empty.json');
      await writeFile(filepath, '');

      await expect(readJsonSafe(filepath, {})).rejects.toThrow('Corrupted JSON file');
    });
  });
});

describe('readJsonWithFallback', () => {
  it('returns default on corruption without throwing', async () => {
    await withTempDir('json-test-', async (dir) => {
      const filepath = path.join(dir, 'corrupted.json');
      await writeFile(filepath, '{invalid');

      const result = await readJsonWithFallback(filepath, { fallback: true }, { warnOnCorruption: false });
      expect(result).toEqual({ fallback: true });
    });
  });
});

describe('withRetries', () => {
  it('retries until shouldRetry is false', async () => {
    type RetryResult = { success: boolean; error?: string };

    const operation = vi
      .fn<() => Promise<RetryResult>>()
      .mockResolvedValueOnce({ success: false, error: 'first' })
      .mockResolvedValueOnce({ success: false, error: 'second' })
      .mockResolvedValueOnce({ success: true });

    const result = await withRetries<RetryResult>(operation, {
      maxAttempts: 3,
      baseDelayMs: 1,
      jitterMs: 0,
      shouldRetry: (value) => !value.success,
      getRetryError: (value) => new Error(value.error || 'failed'),
    });

    expect(result.success).toBe(true);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('validateUrl', () => {
  describe('blocks dangerous URLs', () => {
    it('blocks localhost', () => {
      const result = validateUrl('http://localhost:8080/admin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked host');
    });

    it('blocks 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1/secret');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked IP');
    });

    it('blocks private 10.x IPs', () => {
      const result = validateUrl('http://10.0.0.1/internal');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked IP');
    });

    it('blocks private 192.168.x IPs', () => {
      const result = validateUrl('http://192.168.1.1/router');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked IP');
    });

    it('blocks AWS metadata endpoint', () => {
      const result = validateUrl('http://169.254.169.254/latest/meta-data');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked IP');
    });

    it('blocks file:// protocol', () => {
      const result = validateUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Blocked protocol');
    });

    it('blocks URLs with credentials', () => {
      const result = validateUrl('http://user:pass@example.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('credentials');
    });
  });

  describe('allows valid URLs', () => {
    it('allows https URLs', () => {
      const result = validateUrl('https://example.com/page');
      expect(result.valid).toBe(true);
    });

    it('allows http URLs to public hosts', () => {
      const result = validateUrl('http://example.com/page');
      expect(result.valid).toBe(true);
    });

    it('allows URLs with ports', () => {
      const result = validateUrl('https://example.com:8443/api');
      expect(result.valid).toBe(true);
    });
  });

  describe('handles edge cases', () => {
    it('rejects invalid URL format', () => {
      const result = validateUrl('not a valid url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('rejects empty string', () => {
      const result = validateUrl('');
      expect(result.valid).toBe(false);
    });
  });
});
