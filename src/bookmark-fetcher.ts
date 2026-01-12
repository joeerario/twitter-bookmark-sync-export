/**
 * Bookmark Fetcher
 *
 * Fetches bookmarks from Twitter/X using the Bird CLI.
 * Manages per-account state (processed IDs, last poll time, errors).
 *
 * Uses file locking to prevent concurrent modifications to account state.
 */

import { config } from './config.js';
import { fetchBookmarks } from './integrations/bird-runner.js';
import { isBookmarkProcessed } from './storage.js';
import type { Account, AccountState, RawBirdBookmark } from './types.js';
import { readAccountStateLocked, withAccountStateLock } from './account-state.js';

// Maximum number of processed IDs to keep in state
// Older items will be checked via filesystem existence
const MAX_PROCESSED_IDS = 5000;

/**
 * Fetch bookmarks for an account
 */
export async function fetchBookmarksForAccount(
  account: Account,
  count: number = config.bookmarkCount,
  cursor?: string | null
): Promise<{
  success: boolean;
  bookmarks: RawBirdBookmark[];
  nextCursor: string | null;
  totalFetched: number;
  error?: string;
  errorType?: string;
}> {
  const result = await fetchBookmarks(
    config.birdPath,
    { authToken: account.authToken, ct0: account.ct0 },
    count,
    cursor
  );

  if (!result.success) {
    // Record error in state (with locking to prevent lost updates)
    await withAccountStateLock(account.username, async (state) => {
      state.lastError = {
        message: result.error || 'Unknown error',
        type: result.errorType || 'unknown',
        at: new Date().toISOString(),
      };
    });

    return {
      success: false,
      bookmarks: [],
      nextCursor: null,
      totalFetched: 0,
      error: result.error,
      errorType: result.errorType,
    };
  }

  // Enrich bookmarks with account info
  const enrichedBookmarks = result.bookmarks.map((b) => ({
    ...b,
    _account: account.username,
  }));

  return {
    success: true,
    bookmarks: enrichedBookmarks,
    nextCursor: result.nextCursor,
    totalFetched: result.bookmarks.length,
  };
}

/**
 * Get new bookmarks (not already processed)
 */
export async function getNewBookmarksForAccount(account: Account): Promise<{
  success: boolean;
  bookmarks: RawBirdBookmark[];
  newCount: number;
  totalFetched: number;
  error?: string;
  errorType?: string;
}> {
  // Read processedIds under lock to get consistent view
  const state = await readAccountStateLocked(account.username);
  const processedSet = new Set(state.processedIds);

  const result = await fetchBookmarksForAccount(account);

  if (!result.success) {
    return {
      success: false,
      bookmarks: [],
      newCount: 0,
      totalFetched: 0,
      error: result.error,
      errorType: result.errorType,
    };
  }

  // Filter out already processed (check both in-memory set and filesystem)
  // Filesystem check is needed because older IDs may have been trimmed from the set
  const newBookmarks = result.bookmarks.filter((b) => {
    // First check in-memory set (fast)
    if (processedSet.has(b.id)) return false;
    // Then check filesystem (for older items that may have been trimmed)
    return !isBookmarkProcessed(account.username, b.id);
  });

  // Update last poll time (with locking)
  await withAccountStateLock(account.username, async (state) => {
    state.lastPoll = new Date().toISOString();
    state.lastError = null;
  });

  return {
    success: true,
    bookmarks: newBookmarks,
    newCount: newBookmarks.length,
    totalFetched: result.totalFetched,
  };
}

/**
 * Mark bookmarks as processed
 */
export async function markAsProcessed(username: string, ids: string[]): Promise<void> {
  await withAccountStateLock(username, async (state) => {
    // Use a Set to avoid duplicates
    const processedSet = new Set(state.processedIds);
    const beforeSize = processedSet.size;

    for (const id of ids) {
      processedSet.add(id);
    }

    // Only count newly added IDs (not duplicates)
    const newlyAdded = processedSet.size - beforeSize;

    // Convert to array (newest first since we always add at the end)
    let processedArray = Array.from(processedSet);

    // Trim to MAX_PROCESSED_IDS if needed (keep most recent)
    // Note: older IDs will be checked via filesystem existence in isBookmarkProcessed
    if (processedArray.length > MAX_PROCESSED_IDS) {
      processedArray = processedArray.slice(-MAX_PROCESSED_IDS);
    }

    state.processedIds = processedArray;
    state.stats.total += newlyAdded;
    state.stats.success += newlyAdded;
  });
}

/**
 * Get stats for all accounts
 */
export async function getAllAccountStats(): Promise<Map<string, AccountState>> {
  const stats = new Map<string, AccountState>();

  // This would need to list files in STATE_DIR
  // For now, return empty map - actual implementation would iterate directory
  return stats;
}
