/**
 * Authentication Provider Public API
 *
 * Factory functions for creating auth providers based on configuration.
 */

import { env } from '../env.js';
import type { AuthProvider, AuthConfig } from './types.js';
import { DEFAULT_AUTH_CONFIG } from './types.js';
import { ApiKeyProvider } from './api-key-provider.js';
import { ClaudeCliProvider } from './claude-cli-provider.js';
import { ChainedProvider } from './chained-provider.js';

export type {
  AuthProvider,
  AuthConfig,
  OAuthCredential,
  TokenCredential,
  ClaudeCliCredential,
  AuthProviderInfo,
  AuthResult,
  Credential,
  ApiKeyCredential,
} from './types.js';
export { ApiKeyProvider } from './api-key-provider.js';
export { ClaudeCliProvider } from './claude-cli-provider.js';
export { ChainedProvider } from './chained-provider.js';
export { readClaudeCliCredentials, writeClaudeCliCredentials, clearCredentialCache } from './credentials.js';
export { refreshOAuthTokens, needsRefresh } from './token-refresh.js';
export { DEFAULT_AUTH_CONFIG } from './types.js';

let defaultProvider: AuthProvider | null = null;

/**
 * Create an auth provider based on configuration.
 *
 * Priority order (matching clawdbot):
 * 1. ANTHROPIC_OAUTH_TOKEN env var (if set)
 * 2. Claude CLI credentials (oauth or token)
 * 3. ANTHROPIC_API_KEY env var
 */
export function createAuthProvider(config: Partial<AuthConfig> = {}, log?: (msg: string) => void): AuthProvider {
  const fullConfig: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...config };

  // Check for ANTHROPIC_OAUTH_TOKEN env var (matches clawdbot)
  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  const apiKey = env.ANTHROPIC_API_KEY;

  const apiKeyProvider = new ApiKeyProvider(oauthToken || apiKey);
  const claudeCliProvider = new ClaudeCliProvider(fullConfig, log);

  // Determine provider order based on config
  switch (fullConfig.primary) {
    case 'api_key':
      return new ChainedProvider({
        primary: apiKeyProvider,
        fallback: claudeCliProvider,
        config: fullConfig,
        log,
      });

    case 'oauth':
      return new ChainedProvider({
        primary: claudeCliProvider,
        fallback: apiKeyProvider,
        config: fullConfig,
        log,
      });

    case 'auto':
    default:
      // Auto: prefer Claude CLI if available, else API key
      // This matches clawdbot's behavior (OAuth > Token > API key)
      if (claudeCliProvider.isAvailable()) {
        return new ChainedProvider({
          primary: claudeCliProvider,
          fallback: apiKeyProvider,
          config: fullConfig,
          log,
        });
      }
      return new ChainedProvider({
        primary: apiKeyProvider,
        fallback: claudeCliProvider,
        config: fullConfig,
        log,
      });
  }
}

/**
 * Get the default auth provider (singleton).
 */
export function getAuthProvider(): AuthProvider {
  if (!defaultProvider) {
    defaultProvider = createAuthProvider();
  }
  return defaultProvider;
}

/**
 * Reset the default provider (for testing).
 */
export function resetAuthProvider(): void {
  defaultProvider = null;
}
