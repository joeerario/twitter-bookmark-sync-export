import { setTimeout as sleep } from 'node:timers/promises';

import { ensureError } from './errors.js';

export interface RetryOptions<T> {
  maxAttempts: number;
  baseDelayMs: number;
  jitterMs?: number;
  shouldRetry?: (result: T) => boolean;
  getRetryError?: (result: T) => unknown;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions<T>): Promise<T> {
  const { maxAttempts, baseDelayMs, jitterMs = 250, shouldRetry, getRetryError, onRetry } = options;
  let lastResult: T | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation();
      lastResult = result;

      if (!shouldRetry || !shouldRetry(result)) {
        return result;
      }

      lastError = getRetryError?.(result) ?? new Error('Retry condition met');
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * jitterMs);
      const retryError = lastError ?? new Error('Retry condition met');
      onRetry?.(attempt, retryError, delayMs);
      await sleep(delayMs);
    }
  }

  if (lastResult !== undefined) {
    return lastResult;
  }

  throw ensureError(lastError ?? new Error('Retry attempts exhausted'));
}
