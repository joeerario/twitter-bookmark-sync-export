/**
 * Credential Storage
 *
 * Reads and writes Claude CLI credentials from Keychain (macOS) or file storage.
 * Handles both OAuth (refreshable) and Token (static) credential types.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClaudeCliCredential, OAuthCredential } from './types.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = '.claude/.credentials.json';

type ClaudeCredentialsFile = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

// ============================================
// TTL-based caching (matches clawdbot)
// ============================================
let cachedCredential: ClaudeCliCredential | null = null;
let cachedAt = 0;

/**
 * Read credentials from Claude CLI storage with TTL cache.
 * Returns EITHER oauth OR token type depending on what's stored.
 */
export function readClaudeCliCredentials(options?: {
  ttlMs?: number;
  allowKeychainPrompt?: boolean;
}): ClaudeCliCredential | null {
  const ttlMs = options?.ttlMs ?? 0;
  const now = Date.now();

  // Return cached if within TTL
  if (ttlMs > 0 && cachedCredential && now - cachedAt < ttlMs) {
    return cachedCredential;
  }

  // Try Keychain on macOS
  let cred: ClaudeCliCredential | null = null;
  if (process.platform === 'darwin' && options?.allowKeychainPrompt !== false) {
    cred = readKeychainCredentials();
  }

  // Fall back to file
  if (!cred) {
    cred = readFileCredentials();
  }

  // Update cache
  if (ttlMs > 0) {
    cachedCredential = cred;
    cachedAt = now;
  }

  return cred;
}

function readKeychainCredentials(): ClaudeCliCredential | null {
  try {
    const result = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const data = JSON.parse(result.trim()) as ClaudeCredentialsFile;
    return parseCredentialsData(data);
  } catch {
    return null;
  }
}

function readFileCredentials(): ClaudeCliCredential | null {
  try {
    const credPath = path.join(os.homedir(), CREDENTIALS_FILE);
    if (!fs.existsSync(credPath)) return null;

    const data = JSON.parse(fs.readFileSync(credPath, 'utf8')) as ClaudeCredentialsFile;
    return parseCredentialsData(data);
  } catch {
    return null;
  }
}

/**
 * Parse credentials - returns oauth if refresh token exists, else token.
 * This matches clawdbot's cli-credentials.ts logic.
 */
function parseCredentialsData(data: ClaudeCredentialsFile): ClaudeCliCredential | null {
  const oauth = data?.claudeAiOauth;
  if (!oauth) return null;

  const { accessToken, refreshToken, expiresAt } = oauth;
  if (!accessToken || !expiresAt) return null;

  // If we have a refresh token, it's OAuth (refreshable)
  if (refreshToken) {
    return {
      type: 'oauth',
      provider: 'anthropic',
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }

  // Otherwise it's a static token (from setup-token)
  return {
    type: 'token',
    provider: 'anthropic',
    token: accessToken,
    expires: expiresAt,
  };
}

/**
 * Write refreshed OAuth credentials back to Claude CLI storage.
 * Only works for oauth type (token type can't be refreshed).
 */
export function writeClaudeCliCredentials(creds: OAuthCredential): boolean {
  if (process.platform === 'darwin') {
    if (writeKeychainCredentials(creds)) return true;
  }
  return writeFileCredentials(creds);
}

function writeKeychainCredentials(creds: OAuthCredential): boolean {
  try {
    const existing = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const data = JSON.parse(existing.trim()) as ClaudeCredentialsFile;
    data.claudeAiOauth = {
      ...data.claudeAiOauth,
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: creds.expires,
    };

    const escaped = JSON.stringify(data).replace(/'/g, "'\"'\"'");
    execSync(`security add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "Claude Code" -w '${escaped}'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Invalidate cache
    cachedCredential = null;
    return true;
  } catch {
    return false;
  }
}

function writeFileCredentials(creds: OAuthCredential): boolean {
  try {
    const credPath = path.join(os.homedir(), CREDENTIALS_FILE);
    if (!fs.existsSync(credPath)) return false;

    const data = JSON.parse(fs.readFileSync(credPath, 'utf8')) as ClaudeCredentialsFile;
    data.claudeAiOauth = {
      ...data.claudeAiOauth,
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: creds.expires,
    };

    fs.writeFileSync(credPath, JSON.stringify(data, null, 2));

    // Invalidate cache
    cachedCredential = null;
    return true;
  } catch {
    return false;
  }
}

/** Clear credential cache (for testing) */
export function clearCredentialCache(): void {
  cachedCredential = null;
  cachedAt = 0;
}
