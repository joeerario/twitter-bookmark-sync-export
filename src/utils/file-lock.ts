/**
 * File Locking Utility
 *
 * Provides simple, cross-process file locking using lock files.
 * Uses exponential backoff for retries.
 *
 * Safety guarantees:
 * - Uses exclusive file creation (wx flag) for atomic lock acquisition
 * - Proper EEXIST error handling for lock contention
 * - PID checking before considering a lock stale
 * - Parse errors don't cause lock stealing
 */

import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { isFileExistsError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_AGE_MS = 60_000; // 60 seconds

interface LockInfo {
  pid: number;
  timestamp: number;
}

/**
 * Get the lock file path for a given file
 */
export function getLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/**
 * Check if a process is running (cross-platform)
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't send a signal, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = No such process
    // EPERM = Process exists but we don't have permission (still running)
    if (e && typeof e === 'object' && 'code' in e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
    return false;
  }
}

/**
 * Check if a lock file is stale (process died without releasing)
 *
 * A lock is stale if:
 * 1. The lock file exists AND
 * 2. The owning PID is no longer running
 *
 * We do NOT treat parse errors as stale to prevent concurrent writers
 * from stealing a lock that's being written.
 */
async function isLockStale(lockPath: string): Promise<{ stale: boolean; error?: string }> {
  try {
    // First check file age using mtime (works even if file is being written)
    let fileAge: number;
    try {
      const stats = await stat(lockPath);
      fileAge = Date.now() - stats.mtimeMs;
    } catch {
      // Can't stat the file - might be being created, don't treat as stale
      return { stale: false, error: 'Cannot stat lock file' };
    }

    // Try to read and parse lock info
    let info: LockInfo;
    try {
      const data = await readFile(lockPath, 'utf-8');
      info = JSON.parse(data);
    } catch {
      // Parse error - only consider stale if file is old (likely abandoned/corrupted)
      if (fileAge > STALE_LOCK_AGE_MS) {
        return { stale: true };
      }
      // Otherwise, assume it's being written - not stale
      return { stale: false, error: 'Cannot parse lock file' };
    }

    // Check if the owning process is still running
    const pidAlive = isProcessRunning(info.pid);

    if (!pidAlive) {
      // Process is dead - lock is stale
      return { stale: true };
    }

    // Process is alive - never treat as stale (prevents lock stealing)
    return { stale: false };
  } catch {
    // Any other error - don't treat as stale to be safe
    return { stale: false, error: 'Unknown error checking lock' };
  }
}

/**
 * Attempt to acquire a lock file
 */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
  // Ensure lock directory exists
  const lockDir = path.dirname(lockPath);
  if (!existsSync(lockDir)) {
    try {
      await mkdir(lockDir, { recursive: true });
    } catch {
      // Directory might have been created by another process
    }
  }

  // Try to create lock file exclusively
  const info: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
  };

  try {
    // Use wx flag to fail if file exists (atomic check-and-create)
    await writeFile(lockPath, JSON.stringify(info), { flag: 'wx' });
    return true;
  } catch (e) {
    // Check for EEXIST (file already exists) - this is the expected error
    if (!isFileExistsError(e)) {
      // Some other error (permission, etc) - treat as failure
      return false;
    }

    // Lock file exists - check if it's stale
    const staleResult = await isLockStale(lockPath);
    if (!staleResult.stale) {
      // Lock is held by another active process
      return false;
    }

    // Lock is stale - try to remove and re-acquire
    try {
      await rm(lockPath, { force: true });
    } catch {
      // Failed to remove - another process might be working on it
      return false;
    }

    // Try to create again after removing stale lock
    try {
      const newInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
      };
      await writeFile(lockPath, JSON.stringify(newInfo), { flag: 'wx' });
      return true;
    } catch {
      // Another process beat us to it
      return false;
    }
  }
}

/**
 * Release a lock file
 */
async function releaseLock(lockPath: string): Promise<void> {
  try {
    // Only release if we own the lock
    const data = await readFile(lockPath, 'utf-8');
    const info: LockInfo = JSON.parse(data);
    if (info.pid === process.pid) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Ignore errors when releasing lock
  }
}

/**
 * Execute a function while holding a file lock.
 * Uses exponential backoff if lock is held by another process.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const startTime = Date.now();
  let retryInterval = DEFAULT_RETRY_INTERVAL_MS;

  while (Date.now() - startTime < timeoutMs) {
    if (await tryAcquireLock(lockPath)) {
      try {
        return await fn();
      } finally {
        await releaseLock(lockPath);
      }
    }

    // Wait before retrying (exponential backoff capped at 1s)
    await new Promise((resolve) => setTimeout(resolve, retryInterval));
    retryInterval = Math.min(retryInterval * 2, 1000);
  }

  throw new Error(`Failed to acquire lock at ${lockPath} within ${timeoutMs}ms`);
}
