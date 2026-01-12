/**
 * Centralized Path Management
 *
 * Single source of truth for all paths in the application.
 * Eliminates scattered __dirname / fileURLToPath patterns.
 */

import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory containing this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Repository root directory (parent of src/)
 */
export const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Source directory
 */
export const SRC_DIR = __dirname;

/**
 * Data directory (gitignored, contains all state)
 */
export const DATA_DIR = path.join(REPO_ROOT, 'data');

/**
 * State directory (per-account poll state)
 */
export const STATE_DIR = path.join(DATA_DIR, 'state');

/**
 * Processed bookmarks directory
 */
export const PROCESSED_DIR = path.join(DATA_DIR, 'processed');

/**
 * Failed bookmarks directory (for failure tracking)
 */
export const FAILED_DIR = path.join(DATA_DIR, 'failed');

/**
 * Knowledge base directory
 */
export const KNOWLEDGE_BASE_DIR = path.join(DATA_DIR, 'knowledge-base');

/**
 * Accounts configuration file (sensitive)
 */
export const ACCOUNTS_FILE = path.join(REPO_ROOT, 'accounts.json');

/**
 * Rate limits state file
 */
export const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate-limits.json');

/**
 * Preferences file
 */
export const PREFERENCES_FILE = path.join(DATA_DIR, 'preferences.json');

/**
 * Obsidian config file
 */
export const OBSIDIAN_CONFIG_FILE = path.join(REPO_ROOT, 'obsidian.config.json');

/**
 * Obsidian export state file
 */
export const OBSIDIAN_EXPORT_STATE_FILE = path.join(DATA_DIR, 'obsidian-export-state.json');

/**
 * .env file path
 */
export const ENV_FILE = path.join(REPO_ROOT, '.env');

/**
 * Get state file path for an account
 */
export function getAccountStatePath(username: string): string {
  return path.join(STATE_DIR, `${username}.json`);
}

/**
 * Get failed bookmarks directory for an account
 */
export function getAccountFailedDir(username: string): string {
  return path.join(FAILED_DIR, username);
}

/**
 * Get processed bookmarks directory for an account
 */
export function getAccountProcessedDir(account: string, category?: string): string {
  const base = path.join(PROCESSED_DIR, account || 'default');
  return category ? path.join(base, category) : base;
}

/**
 * Get the Bird CLI directory path
 */
export function getBirdDir(birdPath: string): string {
  return path.resolve(REPO_ROOT, birdPath);
}
