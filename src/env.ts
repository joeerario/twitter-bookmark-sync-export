/**
 * Environment Configuration
 *
 * Loads environment variables from .env file.
 * Must be imported before any other modules that need env vars.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import { ENV_FILE } from './paths.js';

// Load .env file
dotenv.config({ path: ENV_FILE });

// Export typed environment access
export const env = {
  get ANTHROPIC_API_KEY(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  },
  get ANTHROPIC_OAUTH_TOKEN(): string | undefined {
    return process.env.ANTHROPIC_OAUTH_TOKEN;
  },
  get ANTHROPIC_AUTH_MODE(): 'auto' | 'oauth' | 'api_key' {
    const mode = process.env.ANTHROPIC_AUTH_MODE?.toLowerCase();
    if (mode === 'oauth' || mode === 'api_key') return mode;
    return 'auto';
  },
  get NODE_ENV(): string {
    return process.env.NODE_ENV || 'development';
  },
  get DEBUG(): boolean {
    return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  },
  get AUTH_VERBOSE(): boolean {
    return process.env.AUTH_VERBOSE === 'true' || process.env.AUTH_VERBOSE === '1';
  },
};

/**
 * Validate required env vars.
 * API key is now optional if OAuth credentials are available.
 */
export function validateEnv(): void {
  // API key is optional if OAuth is available
  // The auth provider will handle choosing the right method
  // We just warn if no auth method is configured at all
  const hasApiKey = !!env.ANTHROPIC_API_KEY;
  const hasOAuthToken = !!env.ANTHROPIC_OAUTH_TOKEN;

  // Check for Claude CLI credentials
  let hasClaudeCliCredentials = false;
  try {
    const credPath = path.join(os.homedir(), '.claude/.credentials.json');
    hasClaudeCliCredentials = fs.existsSync(credPath);
  } catch {
    // Ignore errors - this is just a warning
  }

  if (!hasApiKey && !hasOAuthToken && !hasClaudeCliCredentials) {
    console.warn(
      'Warning: No Anthropic authentication configured. ' +
        'Set ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, or run `claude login`.'
    );
  }
}
