/**
 * Claude CLI Provider
 *
 * Provider using Claude CLI credentials.
 * Handles both oauth (refreshable) and token (static) credentials.
 */

import type { AuthProvider, AuthProviderInfo, AuthConfig, ClaudeCliCredential, OAuthCredential } from './types.js';
import { readClaudeCliCredentials, writeClaudeCliCredentials } from './credentials.js';
import { refreshOAuthTokens } from './token-refresh.js';

export class ClaudeCliProvider implements AuthProvider {
  private credential: ClaudeCliCredential | null = null;
  private refreshPromise: Promise<OAuthCredential> | null = null;
  private readonly config: AuthConfig;
  private readonly log: (msg: string) => void;

  constructor(config: AuthConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? (() => {});
  }

  async getApiKey(): Promise<string> {
    // Re-read credentials with TTL cache (matches clawdbot behavior)
    this.credential = readClaudeCliCredentials({
      ttlMs: this.config.cliCredentialsTtlMs,
      allowKeychainPrompt: true,
    });

    if (!this.credential) {
      throw new Error(
        'No Claude CLI credentials found. ' + 'Run `claude login` or `claude setup-token` to authenticate.'
      );
    }

    const now = Date.now();
    const needsRefresh = now >= this.credential.expires - this.config.refreshBufferMs;

    if (!needsRefresh) {
      // Credentials still valid
      return this.credential.type === 'oauth' ? this.credential.access : this.credential.token;
    }

    // Credentials expired or expiring soon
    if (this.credential.type === 'token') {
      // Token type cannot be refreshed
      throw new Error('Claude CLI token has expired. ' + 'Run `claude setup-token` to generate a new token.');
    }

    // OAuth type - can refresh
    const refreshed = await this.refreshWithDedup(this.credential);
    return refreshed.access;
  }

  private async refreshWithDedup(cred: OAuthCredential): Promise<OAuthCredential> {
    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh(cred);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(cred: OAuthCredential): Promise<OAuthCredential> {
    if (this.config.verbose) {
      this.log('Refreshing OAuth token...');
    }

    const newCreds = await refreshOAuthTokens(cred.refresh, this.config.refreshBufferMs);

    // Update local cache
    this.credential = { ...newCreds, provider: 'anthropic' };

    // Sync back to Claude CLI storage (bidirectional sync)
    const synced = writeClaudeCliCredentials(newCreds);
    if (this.config.verbose) {
      this.log(synced ? 'Token refreshed and synced to Claude CLI' : 'Token refreshed (sync to Claude CLI failed)');
    }

    return newCreds;
  }

  getProviderInfo(): AuthProviderInfo {
    const cred = this.credential ?? readClaudeCliCredentials({ ttlMs: 0 });
    return {
      type: cred?.type ?? 'oauth',
      name: cred?.type === 'token' ? 'Claude CLI Token' : 'Claude CLI OAuth',
      available: cred !== null,
    };
  }

  isAvailable(): boolean {
    return readClaudeCliCredentials({ ttlMs: this.config.cliCredentialsTtlMs }) !== null;
  }
}
