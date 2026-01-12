import { writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { readJsonSafe } from '../src/utils/read-json-safe.js';
import { withTempDir } from './helpers/temp-dir.js';

const loadAccountsMock = vi.hoisted(() => vi.fn());
const loadAccountStateMock = vi.hoisted(() => vi.fn());
const getFailedTweetsMock = vi.hoisted(() => vi.fn());
const getAllRateLimitStatesMock = vi.hoisted(() => vi.fn());
const isRateLimitedMock = vi.hoisted(() => vi.fn());
const getSummaryMock = vi.hoisted(() => vi.fn());
const getExportStatsMock = vi.hoisted(() => vi.fn());
const getPreferenceSummaryMock = vi.hoisted(() => vi.fn());

vi.mock('../src/accounts.js', () => ({
  loadAccounts: loadAccountsMock,
}));

vi.mock('../src/account-state.js', () => ({
  loadAccountState: loadAccountStateMock,
}));

vi.mock('../src/failure-handler.js', () => ({
  getFailedTweets: getFailedTweetsMock,
  getAllRateLimitStates: getAllRateLimitStatesMock,
  isRateLimited: isRateLimitedMock,
}));

vi.mock('../src/storage.js', () => ({
  getSummary: getSummaryMock,
}));

vi.mock('../src/obsidian-exporter.js', () => ({
  getExportStats: getExportStatsMock,
}));

vi.mock('../src/preferences.js', () => ({
  getPreferenceSummary: getPreferenceSummaryMock,
}));

describe('status CLI', () => {
  it('surfaces malformed JSON read warnings', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    loadAccountsMock.mockResolvedValue([]);
    loadAccountStateMock.mockResolvedValue({
      username: 'test',
      processedIds: [],
      lastPoll: null,
      lastError: null,
      stats: { total: 0, success: 0, errors: 0 },
    });
    getFailedTweetsMock.mockResolvedValue([]);
    getAllRateLimitStatesMock.mockResolvedValue(new Map());
    isRateLimitedMock.mockResolvedValue({ isLimited: false, remainingMs: 0 });
    getSummaryMock.mockResolvedValue({ review: 0, try: 0, knowledge: 0, life: 0, skip: 0, total: 0, byAccount: {} });
    getExportStatsMock.mockResolvedValue({ totalExported: 0, lastExport: null });

    await withTempDir('prefs-test-', async (dir) => {
      const corruptedPath = `${dir}/preferences.json`;
      await writeFile(corruptedPath, '{broken-json');

      getPreferenceSummaryMock.mockImplementation(() => readJsonSafe(corruptedPath, {} as never));

      const { showStatus } = await import('../src/status.js');
      await showStatus();
      const output = logSpy.mock.calls.flat().join(' ');
      expect(output).toContain('Malformed JSON files detected');
    });

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
