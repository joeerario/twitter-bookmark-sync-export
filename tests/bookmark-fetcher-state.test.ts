import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getNewBookmarksForAccount, markAsProcessed } from '../src/bookmark-fetcher.js';
import { loadAccountState, saveAccountState } from '../src/account-state.js';
import type { Account, RawBirdBookmark } from '../src/types.js';
import { dataPath } from './helpers/data-paths.js';

const fetchBookmarksMock = vi.hoisted(() => vi.fn());

vi.mock('../src/integrations/bird-runner.js', () => ({
  fetchBookmarks: fetchBookmarksMock,
}));

describe('bookmark-fetcher account state', () => {
  const account: Account = {
    id: '1',
    username: '__fetch_state__',
    name: 'Fetch State',
    authToken: 'token',
    ct0: 'ct0',
    enabled: true,
    addedAt: '2024-01-01',
    lastValidated: '2024-01-01',
    validationError: null,
  };

  beforeEach(async () => {
    fetchBookmarksMock.mockReset();
    await rm(dataPath('state', account.username), { recursive: true, force: true });
    await rm(dataPath('processed', account.username), { recursive: true, force: true });
  });

  it('filters processed IDs from state and filesystem', async () => {
    const processedId = 'seen-id';
    const filesystemId = 'older-id';

    await saveAccountState({
      username: account.username,
      processedIds: [processedId],
      lastPoll: null,
      lastError: null,
      stats: { total: 0, success: 0, errors: 0 },
    });

    const processedDir = dataPath('processed', account.username, 'review');
    await mkdir(processedDir, { recursive: true });
    await writeFile(path.join(processedDir, `${filesystemId}.json`), JSON.stringify({ id: filesystemId }));

    const bookmarks: RawBirdBookmark[] = [
      { id: processedId, text: 'one', author: { username: 'a', id: '1', name: 'A' }, createdAt: '2024-01-01' },
      { id: filesystemId, text: 'two', author: { username: 'a', id: '1', name: 'A' }, createdAt: '2024-01-01' },
      { id: 'new-id', text: 'three', author: { username: 'a', id: '1', name: 'A' }, createdAt: '2024-01-01' },
    ];

    fetchBookmarksMock.mockResolvedValue({
      success: true,
      bookmarks,
      nextCursor: null,
    });

    const result = await getNewBookmarksForAccount(account);

    expect(result.success).toBe(true);
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]!.id).toBe('new-id');

    const state = await loadAccountState(account.username);
    expect(state.lastPoll).toBeTruthy();
    expect(state.lastError).toBe(null);
  });

  it('truncates processed IDs and updates stats', async () => {
    const manyIds = Array.from({ length: 5000 }, (_, index) => `id-${index}`);

    await saveAccountState({
      username: account.username,
      processedIds: manyIds,
      lastPoll: null,
      lastError: null,
      stats: { total: 0, success: 0, errors: 0 },
    });

    await markAsProcessed(account.username, ['id-1', 'new-1', 'new-2']);

    const state = await loadAccountState(account.username);
    expect(state.processedIds.length).toBe(5000);
    expect(state.stats.total).toBe(2);
    expect(state.stats.success).toBe(2);
  });
});
