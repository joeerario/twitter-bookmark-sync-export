import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProcessedBookmarkFixture,
  readJson,
  writeJson,
  writeProcessedBookmarkFixture,
} from './fs.js';
import { makeTempDir, withTempDir } from './temp-dir.js';

describe('fs-tempdir', () => {
  it('creates a temp directory that can be written to', async () => {
    await withTempDir('test-fs-', async (dir) => {
      expect(existsSync(dir)).toBe(true);
      const stats = await stat(dir);
      expect(stats.isDirectory()).toBe(true);

      // Write a file to prove it's usable
      const testFile = path.join(dir, 'test.txt');
      await writeFile(testFile, 'hello');
      const content = await readFile(testFile, 'utf-8');
      expect(content).toBe('hello');
    });
  });

  it('cleans up temp directory after function completes', async () => {
    let capturedDir: string | null = null;

    await withTempDir('test-cleanup-', async (dir) => {
      capturedDir = dir;
      await writeFile(path.join(dir, 'test.txt'), 'data');
    });

    expect(capturedDir).not.toBeNull();
    expect(existsSync(capturedDir!)).toBe(false);
  });

  it('cleans up temp directory even after errors', async () => {
    let capturedDir: string | null = null;

    try {
      await withTempDir('test-error-', async (dir) => {
        capturedDir = dir;
        throw new Error('test error');
      });
    } catch {
      // Expected
    }

    expect(capturedDir).not.toBeNull();
    expect(existsSync(capturedDir!)).toBe(false);
  });

  it('returns the value from the callback', async () => {
    const result = await withTempDir('test-return-', async () => {
      return 'returned value';
    });
    expect(result).toBe('returned value');
  });

  it('makeTempDir returns dir and cleanup function', async () => {
    const { dir, cleanup } = await makeTempDir('test-make-');
    try {
      expect(existsSync(dir)).toBe(true);
      await writeFile(path.join(dir, 'test.txt'), 'data');
    } finally {
      await cleanup();
    }
    expect(existsSync(dir)).toBe(false);
  });
});

describe('helpers/fs', () => {
  it('writeJson and readJson roundtrip', async () => {
    await withTempDir('test-json-', async (dir) => {
      const filePath = path.join(dir, 'test.json');
      const data = { foo: 'bar', num: 42, nested: { arr: [1, 2, 3] } };
      await writeJson(filePath, data);
      const result = await readJson<typeof data>(filePath);
      expect(result).toEqual(data);
    });
  });

  it('writeJson creates nested directories', async () => {
    await withTempDir('test-nested-', async (dir) => {
      const filePath = path.join(dir, 'a', 'b', 'c', 'test.json');
      await writeJson(filePath, { key: 'value' });
      const result = await readJson<{ key: string }>(filePath);
      expect(result.key).toBe('value');
    });
  });

  it('createProcessedBookmarkFixture produces valid bookmark', () => {
    const bookmark = createProcessedBookmarkFixture({ id: 'custom-id' });
    expect(bookmark.id).toBe('custom-id');
    expect(bookmark.account).toBe('testaccount');
    expect(bookmark.category).toBe('review');
    expect(bookmark.author.username).toBe('testuser');
  });

  it('createProcessedBookmarkFixture merges overrides', () => {
    const bookmark = createProcessedBookmarkFixture({
      id: 'test-123',
      category: 'knowledge',
      tags: ['ai', 'ml'],
      narrativeId: 'narr-1',
    });
    expect(bookmark.id).toBe('test-123');
    expect(bookmark.category).toBe('knowledge');
    expect(bookmark.tags).toEqual(['ai', 'ml']);
    expect((bookmark as unknown as { narrativeId: string }).narrativeId).toBe('narr-1');
  });

  it('writeProcessedBookmarkFixture writes to correct path', async () => {
    await withTempDir('test-fixture-', async (dir) => {
      const filePath = await writeProcessedBookmarkFixture(dir, { id: 'bookmark-123' });
      expect(filePath).toContain('data/processed/testaccount/bookmark-123.json');
      const result = await readJson<{ id: string }>(filePath);
      expect(result.id).toBe('bookmark-123');
    });
  });

  it('writeProcessedBookmarkFixture uses custom account', async () => {
    await withTempDir('test-account-', async (dir) => {
      const filePath = await writeProcessedBookmarkFixture(
        dir,
        { id: 'bm-456' },
        { account: 'customaccount' }
      );
      expect(filePath).toContain('customaccount/bm-456.json');
    });
  });
});
