/**
 * Safe JSON File Reading
 *
 * Provides safe JSON file reading with clear distinction between
 * "file not found" (returns default) and "file corrupted" (throws).
 */

import { readFile } from 'fs/promises';
import { isNotFoundError, toErrorMessage } from './errors.js';

let readJsonFailureCount = 0;

export function getReadJsonFailureCount(): number {
  return readJsonFailureCount;
}

export function resetReadJsonFailureCount(): void {
  readJsonFailureCount = 0;
}

/**
 * Read and parse a JSON file safely.
 *
 * - If file doesn't exist: returns `defaultValue`
 * - If file exists but is invalid JSON: throws Error
 * - If file exists and is valid JSON: returns parsed content
 *
 * @param filepath - Path to the JSON file
 * @param defaultValue - Value to return if file doesn't exist
 * @returns Parsed JSON content or defaultValue
 * @throws Error if file exists but contains invalid JSON
 */
export async function readJsonSafe<T>(filepath: string, defaultValue: T): Promise<T> {
  try {
    const data = await readFile(filepath, 'utf-8');

    // Check for empty file
    if (!data.trim()) {
      readJsonFailureCount += 1;
      throw new Error(`Corrupted JSON file (empty): ${filepath}`);
    }

    try {
      return JSON.parse(data) as T;
    } catch (parseError) {
      readJsonFailureCount += 1;
      throw new Error(`Corrupted JSON file: ${filepath} - ${toErrorMessage(parseError)}`);
    }
  } catch (e) {
    if (isNotFoundError(e)) {
      return defaultValue;
    }
    throw e;
  }
}

/**
 * Read and parse a JSON file, returning defaultValue on any error.
 * Optionally warns on corruption.
 *
 * Use this when you want to be resilient to corrupted files
 * (e.g., state files that can be regenerated).
 *
 * @param filepath - Path to the JSON file
 * @param defaultValue - Value to return on any error
 * @param options - Optional configuration
 * @returns Parsed JSON content or defaultValue
 */
export async function readJsonWithFallback<T>(
  filepath: string,
  defaultValue: T,
  options: { warnOnCorruption?: boolean } = {}
): Promise<T> {
  const { warnOnCorruption = true } = options;

  try {
    return await readJsonSafe(filepath, defaultValue);
  } catch (e) {
    if (warnOnCorruption) {
      console.warn(`Warning: ${toErrorMessage(e)} - using default value`);
    }
    return defaultValue;
  }
}
