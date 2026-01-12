/**
 * API Key Provider
 *
 * Simple provider that returns a static API key from environment.
 * No refresh logic - key is assumed to be long-lived.
 */

import type { AuthProvider, AuthProviderInfo } from './types.js';

export class ApiKeyProvider implements AuthProvider {
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  async getApiKey(): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    return this.apiKey;
  }

  getProviderInfo(): AuthProviderInfo {
    return {
      type: 'api_key',
      name: 'Environment API Key',
      available: !!this.apiKey,
    };
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }
}
