/**
 * Failure Handler
 *
 * Tracks failed bookmarks and rate limits to prevent infinite retry loops.
 * Uses exponential backoff for transient failures.
 * Marks bookmarks as "poison pills" after max retries.
 */

import { existsSync } from 'fs';
import { mkdir, readdir } from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { getAccountFailedDir, RATE_LIMIT_FILE } from './paths.js';
import type { FailureRecord, RateLimitState, SkipType } from './types.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

// ============================================
// Failure Tracking
// ============================================

/**
 * Get the failure record path for a tweet
 */
function getFailurePath(account: string, tweetId: string): string {
  return path.join(getAccountFailedDir(account), `${tweetId}.json`);
}

/**
 * Load a failure record
 */
async function loadFailure(account: string, tweetId: string): Promise<FailureRecord | null> {
  const filepath = getFailurePath(account, tweetId);
  const record = await readJsonSafe<FailureRecord | null>(filepath, null);
  return record;
}

/**
 * Save a failure record
 */
async function saveFailure(record: FailureRecord): Promise<void> {
  const dir = getAccountFailedDir(record.account);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const filepath = getFailurePath(record.account, record.tweetId);
  await writeJsonAtomic(filepath, record);
}

/**
 * Calculate next retry time with exponential backoff
 */
function calculateNextRetry(attempts: number): string {
  const baseDelay = config.failure.retryDelayMs;
  const delay = baseDelay * Math.pow(2, attempts - 1);
  return new Date(Date.now() + delay).toISOString();
}

/**
 * Record a processing failure
 */
export async function recordFailure(
  account: string,
  tweetId: string,
  errorType: string,
  errorMessage: string
): Promise<{ isPoisonPill: boolean; attempts: number }> {
  const now = new Date().toISOString();
  let record = await loadFailure(account, tweetId);

  if (record) {
    // Update existing record
    record.attempts += 1;
    record.lastSeen = now;
    record.errorType = errorType;
    record.errorMessage = errorMessage;

    if (record.attempts >= config.failure.maxRetries) {
      record.poisonPill = true;
      record.nextRetryAt = null; // No more retries
    } else {
      record.nextRetryAt = calculateNextRetry(record.attempts);
    }
  } else {
    // Create new record
    record = {
      tweetId,
      account,
      errorType,
      errorMessage,
      firstSeen: now,
      lastSeen: now,
      nextRetryAt: calculateNextRetry(1),
      attempts: 1,
      poisonPill: false,
    };
  }

  await saveFailure(record);

  return { isPoisonPill: record.poisonPill, attempts: record.attempts };
}

/**
 * Clear a failure record (on successful processing)
 */
export async function clearFailure(account: string, tweetId: string): Promise<void> {
  const filepath = getFailurePath(account, tweetId);
  try {
    const { unlink } = await import('fs/promises');
    await unlink(filepath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Check if a tweet should be skipped (poison pill or in backoff)
 */
export async function shouldSkipRetry(
  account: string,
  tweetId: string
): Promise<{ shouldSkip: boolean; reason?: string; skipType?: SkipType }> {
  const record = await loadFailure(account, tweetId);

  if (!record) {
    return { shouldSkip: false };
  }

  // Poison pill - never retry
  if (record.poisonPill) {
    return {
      shouldSkip: true,
      reason: `Poison pill (${record.attempts} failed attempts)`,
      skipType: 'poison_pill',
    };
  }

  // In backoff period
  if (record.nextRetryAt && new Date(record.nextRetryAt) > new Date()) {
    const remainingMs = new Date(record.nextRetryAt).getTime() - Date.now();
    return {
      shouldSkip: true,
      reason: `In backoff (${Math.round(remainingMs / 1000)}s remaining)`,
      skipType: 'backoff',
    };
  }

  return { shouldSkip: false };
}

/**
 * Get all failed tweets for an account
 */
export async function getFailedTweets(account: string): Promise<FailureRecord[]> {
  const dir = getAccountFailedDir(account);

  if (!existsSync(dir)) {
    return [];
  }

  const files = await readdir(dir);
  const records: FailureRecord[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filepath = path.join(dir, file);
    const record = await readJsonSafe<FailureRecord | null>(filepath, null);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

// ============================================
// Rate Limit Tracking
// ============================================

interface RateLimitStore {
  accounts: Record<string, RateLimitState>;
}

/**
 * Load rate limit state
 */
async function loadRateLimitStore(): Promise<RateLimitStore> {
  return await readJsonSafe<RateLimitStore>(RATE_LIMIT_FILE, { accounts: {} });
}

/**
 * Save rate limit state
 */
async function saveRateLimitStore(store: RateLimitStore): Promise<void> {
  const dir = path.dirname(RATE_LIMIT_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeJsonAtomic(RATE_LIMIT_FILE, store);
}

/**
 * Record a rate limit for an account
 */
export async function recordRateLimit(account: string): Promise<RateLimitState> {
  return await withFileLock(getLockPath(RATE_LIMIT_FILE), async () => {
    const store = await loadRateLimitStore();
    const existing = store.accounts[account];

    const consecutive = (existing?.consecutiveRateLimits ?? 0) + 1;
    const backoff = Math.min(
      config.rateLimit.baseBackoffMs * Math.pow(config.rateLimit.backoffMultiplier, consecutive - 1),
      config.rateLimit.maxBackoffMs
    );

    const state: RateLimitState = {
      account,
      nextAllowedPollAt: new Date(Date.now() + backoff).toISOString(),
      consecutiveRateLimits: consecutive,
      lastRateLimitAt: new Date().toISOString(),
    };

    store.accounts[account] = state;
    await saveRateLimitStore(store);

    return state;
  });
}

/**
 * Clear rate limit for an account (on successful request)
 */
export async function clearRateLimit(account: string): Promise<void> {
  await withFileLock(getLockPath(RATE_LIMIT_FILE), async () => {
    const store = await loadRateLimitStore();

    if (store.accounts[account]) {
      store.accounts[account] = {
        account,
        nextAllowedPollAt: null,
        consecutiveRateLimits: 0,
        lastRateLimitAt: store.accounts[account]!.lastRateLimitAt,
      };
      await saveRateLimitStore(store);
    }
  });
}

/**
 * Check if an account is rate limited
 */
export async function isRateLimited(account: string): Promise<{ isLimited: boolean; remainingMs: number }> {
  const store = await loadRateLimitStore();
  const state = store.accounts[account];

  if (!state || !state.nextAllowedPollAt) {
    return { isLimited: false, remainingMs: 0 };
  }

  const nextAllowed = new Date(state.nextAllowedPollAt);
  const now = new Date();

  if (nextAllowed <= now) {
    return { isLimited: false, remainingMs: 0 };
  }

  return {
    isLimited: true,
    remainingMs: nextAllowed.getTime() - now.getTime(),
  };
}

/**
 * Get all rate limit states
 */
export async function getAllRateLimitStates(): Promise<Map<string, RateLimitState>> {
  const store = await loadRateLimitStore();
  return new Map(Object.entries(store.accounts));
}
