/**
 * Account Management
 *
 * Manages Twitter/X account credentials and state.
 * Credentials are stored in accounts.json (gitignored, sensitive).
 */

import { chmod, stat } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { validateCredentials } from './integrations/bird-runner.js';
import { ACCOUNTS_FILE } from './paths.js';
import type { Account } from './types.js';
import { isNotFoundError } from './utils/errors.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

// Use UUID for crypto
function generateId(): string {
  return uuidv4();
}

/**
 * Ensure accounts file has secure permissions (owner-only read/write)
 */
async function ensureSecurePermissions(filepath: string): Promise<void> {
  if (!config.security.checkFilePermissions) return;

  try {
    const stats = await stat(filepath);
    const mode = stats.mode & 0o777;

    // Check if world or group readable
    if (mode & 0o077) {
      console.warn(`Warning: ${filepath} has insecure permissions (${mode.toString(8)}), fixing...`);
      await chmod(filepath, config.security.sensitiveFileMode);
    }
  } catch (e) {
    if (!isNotFoundError(e)) {
      console.warn(`Warning: Could not check permissions on ${filepath}`);
    }
  }
}

/**
 * Load all accounts from accounts.json
 */
export async function loadAccounts(): Promise<Account[]> {
  await ensureSecurePermissions(ACCOUNTS_FILE);
  return await readJsonSafe<Account[]>(ACCOUNTS_FILE, []);
}

/**
 * Save accounts to accounts.json
 */
async function saveAccounts(accounts: Account[]): Promise<void> {
  await writeJsonAtomic(ACCOUNTS_FILE, accounts, { mode: config.security.sensitiveFileMode });
}

/**
 * Get enabled accounts only
 */
export async function getEnabledAccounts(): Promise<Account[]> {
  const accounts = await loadAccounts();
  return accounts.filter((a) => a.enabled);
}

/**
 * Get account by username
 */
export async function getAccountByUsername(username: string): Promise<Account | null> {
  const accounts = await loadAccounts();
  return accounts.find((a) => a.username === username) || null;
}

/**
 * Add a new account (validates credentials first)
 */
export async function addAccount(
  authToken: string,
  ct0: string
): Promise<{ success: boolean; account?: Account; updated?: boolean; error?: string }> {
  // Validate credentials
  const validation = await validateCredentials(config.birdPath, { authToken, ct0 });

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const accounts = await loadAccounts();
  const existingIndex = accounts.findIndex((a) => a.username === validation.username);

  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    // Update existing account
    accounts[existingIndex] = {
      ...accounts[existingIndex]!,
      authToken,
      ct0,
      enabled: true,
      lastValidated: now,
      validationError: null,
    };

    await saveAccounts(accounts);
    return { success: true, account: accounts[existingIndex], updated: true };
  }

  // Add new account
  const account: Account = {
    id: generateId(),
    username: validation.username!,
    name: validation.name || validation.username!,
    userId: validation.userId,
    authToken,
    ct0,
    enabled: true,
    addedAt: now,
    lastValidated: now,
    validationError: null,
  };

  accounts.push(account);
  await saveAccounts(accounts);

  return { success: true, account };
}

/**
 * Remove an account
 */
export async function removeAccount(username: string): Promise<{ success: boolean; account?: Account; error?: string }> {
  const accounts = await loadAccounts();
  const index = accounts.findIndex((a) => a.username === username);

  if (index < 0) {
    return { success: false, error: `Account @${username} not found` };
  }

  const [removed] = accounts.splice(index, 1);
  await saveAccounts(accounts);

  return { success: true, account: removed };
}

/**
 * Enable or disable an account
 */
export async function setAccountEnabled(
  username: string,
  enabled: boolean
): Promise<{ success: boolean; account?: Account; error?: string }> {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.username === username);

  if (!account) {
    return { success: false, error: `Account @${username} not found` };
  }

  account.enabled = enabled;
  await saveAccounts(accounts);

  return { success: true, account };
}

/**
 * Revalidate all account credentials
 */
export async function revalidateAccounts(): Promise<Array<{ account: string; valid: boolean; error?: string }>> {
  const accounts = await loadAccounts();
  const results: Array<{ account: string; valid: boolean; error?: string }> = [];

  for (const account of accounts) {
    const validation = await validateCredentials(config.birdPath, {
      authToken: account.authToken,
      ct0: account.ct0,
    });

    account.lastValidated = new Date().toISOString();

    if (validation.valid) {
      account.validationError = null;
      results.push({ account: account.username, valid: true });
    } else {
      account.validationError = validation.error || 'Validation failed';
      results.push({ account: account.username, valid: false, error: validation.error });
    }
  }

  await saveAccounts(accounts);
  return results;
}

/**
 * List accounts (sanitized - no credentials)
 */
export async function listAccounts(): Promise<
  Array<{
    username: string;
    name: string;
    enabled: boolean;
    addedAt: string;
    lastValidated: string;
    hasError: boolean;
  }>
> {
  const accounts = await loadAccounts();

  return accounts.map((a) => ({
    username: a.username,
    name: a.name,
    enabled: a.enabled,
    addedAt: a.addedAt,
    lastValidated: a.lastValidated,
    hasError: !!a.validationError,
  }));
}
