import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock spawn to return a fake child process
const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

import { fetchBookmarksForAccount } from '../src/bookmark-fetcher.js';
import type { Account } from '../src/types.js';

/**
 * Create a mock child process that emits events
 */
function createMockProcess(stdout: string, stderr: string, exitCode: number = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // Simulate async data emission
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

describe('bookmark-fetcher', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    // Mock bird CLI paths as existing
    existsSyncMock.mockImplementation((path: string) => {
      // Return true for bird dist/cli.js to simulate built bird
      if (path.includes('bird') && path.includes('dist/cli.js')) return true;
      if (path.includes('bird') && !path.includes('dist') && !path.includes('src')) return true;
      // For state directory, return false (not exists, will be created)
      if (path.includes('state')) return false;
      return false;
    });
  });

  it('parses JSON with cursor and enriches account', async () => {
    const payload = JSON.stringify(
      {
        tweets: [{ id: '1', text: 'hello', author: { username: 'user', name: 'User', id: '1' } }],
        nextCursor: 'cursor123',
      },
      null,
      2
    );

    spawnMock.mockImplementation(() => {
      return createMockProcess(`WARN: test\n${payload}`, '', 0);
    });

    const account: Account = {
      id: '1',
      username: 'tester',
      name: 'Tester',
      authToken: 'token',
      ct0: 'ct0',
      enabled: true,
      addedAt: '2024-01-01',
      lastValidated: '2024-01-01',
      validationError: null,
    };
    const result = await fetchBookmarksForAccount(account, 50, 'cursor0');

    expect(result.success).toBe(true);
    expect(result.nextCursor).toBe('cursor123');
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]!._account).toBe('tester');

    // Check spawn was called with correct args
    const spawnCall = spawnMock.mock.calls[0];
    expect(['node', 'npx']).toContain(spawnCall[0]);
    expect(spawnCall[1].join(' ')).toContain('bookmarks');
    expect(spawnCall[1]).toContain('--cursor');
    expect(spawnCall[1]).toContain('cursor0');
  });

  it('returns empty list when Bird reports no bookmarks', async () => {
    spawnMock.mockImplementation(() => {
      return createMockProcess('No bookmarks found.', '', 0);
    });

    const account: Account = {
      id: '1',
      username: 'tester',
      name: 'Tester',
      authToken: 'token',
      ct0: 'ct0',
      enabled: true,
      addedAt: '2024-01-01',
      lastValidated: '2024-01-01',
      validationError: null,
    };
    const result = await fetchBookmarksForAccount(account, 20);

    expect(result.success).toBe(true);
    expect(result.bookmarks).toEqual([]);
    expect(result.nextCursor).toBe(null);
  });
});
