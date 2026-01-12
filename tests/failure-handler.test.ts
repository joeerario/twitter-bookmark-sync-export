import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearFailure, recordFailure, shouldSkipRetry } from '../src/failure-handler.js';
import { config } from '../src/config.js';
import { dataPath } from './helpers/data-paths.js';

describe('failure-handler', () => {
  const account = '__failure_test__';

  beforeEach(async () => {
    await rm(dataPath('failed', account), { recursive: true, force: true });
  });

  it('increments attempts and marks poison pill at max retries', async () => {
    let lastAttempt = 0;

    for (let attempt = 1; attempt <= config.failure.maxRetries; attempt += 1) {
      const result = await recordFailure(account, 'tweet-1', 'processing_error', `fail-${attempt}`);
      lastAttempt = result.attempts;
    }

    expect(lastAttempt).toBe(config.failure.maxRetries);

    const skip = await shouldSkipRetry(account, 'tweet-1');
    expect(skip.shouldSkip).toBe(true);
    expect(skip.skipType).toBe('poison_pill');
  });

  it('returns backoff skip when retry window has not elapsed', async () => {
    await recordFailure(account, 'tweet-2', 'processing_error', 'fail');
    const skip = await shouldSkipRetry(account, 'tweet-2');

    expect(skip.shouldSkip).toBe(true);
    expect(skip.skipType).toBe('backoff');
    expect(skip.reason).toContain('backoff');
  });

  it('clears failures and allows retry after deletion', async () => {
    await recordFailure(account, 'tweet-3', 'processing_error', 'fail');
    await clearFailure(account, 'tweet-3');

    const skip = await shouldSkipRetry(account, 'tweet-3');
    expect(skip.shouldSkip).toBe(false);
  });

  it('allows retries after backoff has elapsed', async () => {
    const failureDir = dataPath('failed', account);
    const failurePath = path.join(failureDir, 'tweet-4.json');
    const past = new Date(Date.now() - 60_000).toISOString();

    await mkdir(failureDir, { recursive: true });
    await writeFile(
      failurePath,
      JSON.stringify(
        {
          tweetId: 'tweet-4',
          account,
          errorType: 'processing_error',
          errorMessage: 'fail',
          firstSeen: past,
          lastSeen: past,
          nextRetryAt: past,
          attempts: 1,
          poisonPill: false,
        },
        null,
        2
      )
    );

    const skip = await shouldSkipRetry(account, 'tweet-4');
    expect(skip.shouldSkip).toBe(false);
  });
});
