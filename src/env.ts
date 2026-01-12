/**
 * Environment Configuration
 *
 * Loads environment variables from .env file.
 * Must be imported before any other modules that need env vars.
 */

import dotenv from 'dotenv';
import { ENV_FILE } from './paths.js';

// Load .env file
dotenv.config({ path: ENV_FILE });

// Export typed environment access
export const env = {
  get ANTHROPIC_API_KEY(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  },
  get NODE_ENV(): string {
    return process.env.NODE_ENV || 'development';
  },
  get DEBUG(): boolean {
    return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  },
};

// Validate required env vars
export function validateEnv(): void {
  const missing: string[] = [];

  if (!env.ANTHROPIC_API_KEY) {
    missing.push('ANTHROPIC_API_KEY');
  }

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
  }
}
