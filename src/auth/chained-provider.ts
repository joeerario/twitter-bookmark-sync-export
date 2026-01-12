/**
 * Chained Provider
 *
 * Chains multiple providers with fallback behavior.
 * Tries primary first, falls back on failure if enabled.
 */

import type { AuthProvider, AuthProviderInfo, AuthConfig } from './types.js';

export type ChainedProviderOptions = {
  primary: AuthProvider;
  fallback?: AuthProvider;
  config: AuthConfig;
  log?: (msg: string) => void;
};

export class ChainedProvider implements AuthProvider {
  private readonly primary: AuthProvider;
  private readonly fallback: AuthProvider | undefined;
  private readonly config: AuthConfig;
  private readonly log: (msg: string) => void;
  private lastUsed: 'primary' | 'fallback' | null = null;

  constructor(options: ChainedProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.config = options.config;
    this.log = options.log ?? (() => {});
  }

  async getApiKey(): Promise<string> {
    // Try primary
    try {
      if (this.primary.isAvailable()) {
        const key = await this.primary.getApiKey();
        this.lastUsed = 'primary';
        return key;
      }
    } catch (error) {
      if (this.config.verbose) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Primary auth failed: ${msg}`);
      }
    }

    // Try fallback if enabled
    if (this.config.enableFallback && this.fallback?.isAvailable()) {
      try {
        if (this.config.verbose) {
          this.log('Falling back to secondary auth provider');
        }
        const key = await this.fallback.getApiKey();
        this.lastUsed = 'fallback';
        return key;
      } catch (error) {
        if (this.config.verbose) {
          const msg = error instanceof Error ? error.message : String(error);
          this.log(`Fallback auth failed: ${msg}`);
        }
      }
    }

    // All providers failed
    const primaryInfo = this.primary.getProviderInfo();
    const fallbackInfo = this.fallback?.getProviderInfo();

    let message = `Authentication failed. Primary (${primaryInfo.name}): not available`;
    if (fallbackInfo) {
      message += `. Fallback (${fallbackInfo.name}): ${fallbackInfo.available ? 'failed' : 'not available'}`;
    }

    throw new Error(message);
  }

  getProviderInfo(): AuthProviderInfo {
    return {
      type: 'chained',
      name: `${this.primary.getProviderInfo().name} → ${this.fallback?.getProviderInfo().name ?? 'none'}`,
      available: this.primary.isAvailable() || (this.fallback?.isAvailable() ?? false),
    };
  }

  isAvailable(): boolean {
    return this.primary.isAvailable() || (this.fallback?.isAvailable() ?? false);
  }

  /** Get which provider was last used */
  getLastUsedProvider(): 'primary' | 'fallback' | null {
    return this.lastUsed;
  }
}
