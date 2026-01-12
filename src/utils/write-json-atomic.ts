/**
 * Atomic JSON File Writing
 *
 * Ensures JSON files are written atomically to prevent data corruption
 * from partial writes or process crashes.
 */

import { existsSync } from 'fs';
import { chmod, mkdir, rename, writeFile } from 'fs/promises';
import path from 'path';

interface WriteOptions {
  /** File mode (permissions) to set. Default: 0o644 */
  mode?: number;
  /** Whether to create parent directories. Default: true */
  createDir?: boolean;
}

/**
 * Write JSON to a file atomically.
 *
 * Uses write-to-temp-then-rename pattern to ensure the file
 * is never in a partially-written state.
 *
 * @param filepath - Destination file path
 * @param data - Data to serialize as JSON
 * @param options - Optional configuration
 */
export async function writeJsonAtomic(filepath: string, data: unknown, options: WriteOptions = {}): Promise<void> {
  const { mode = 0o644, createDir = true } = options;

  // Ensure parent directory exists
  const dir = path.dirname(filepath);
  if (createDir && !existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Write to temporary file first
  const tempPath = `${filepath}.tmp.${process.pid}.${Date.now()}`;

  try {
    const json = JSON.stringify(data, null, 2);
    await writeFile(tempPath, json, { encoding: 'utf-8' });

    // Set file permissions
    await chmod(tempPath, mode);

    // Atomic rename
    await rename(tempPath, filepath);
  } catch (e) {
    // Clean up temp file on error
    try {
      const { unlink } = await import('fs/promises');
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw e;
  }
}
