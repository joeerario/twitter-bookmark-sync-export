/**
 * Authentication Types
 *
 * Type definitions for the authentication provider system.
 */

/** Result of obtaining an API key */
export type AuthResult = {
  apiKey: string;
  source: 'oauth' | 'token' | 'api_key';
  expiresAt?: number;
};

/** Provider metadata for logging/debugging */
export type AuthProviderInfo = {
  type: 'oauth' | 'token' | 'api_key' | 'chained';
  name: string;
  available: boolean;
};

/** Core interface all providers implement */
export interface AuthProvider {
  /** Get a valid API key (refreshing OAuth if needed) */
  getApiKey(): Promise<string>;

  /** Get provider metadata */
  getProviderInfo(): AuthProviderInfo;

  /** Check if provider can potentially provide credentials */
  isAvailable(): boolean;
}

// ============================================
// THREE credential types (matching clawdbot)
// ============================================

/** Static API key from environment variable */
export type ApiKeyCredential = {
  type: 'api_key';
  key: string;
};

/**
 * Static bearer token (e.g., from `claude setup-token`).
 * NOT refreshable - when it expires, user must re-authenticate.
 */
export type TokenCredential = {
  type: 'token';
  token: string;
  expires: number; // Unix timestamp ms
};

/**
 * OAuth credentials with refresh capability.
 * CAN be refreshed automatically before expiry.
 */
export type OAuthCredential = {
  type: 'oauth';
  access: string; // Access token (used as API key)
  refresh: string; // Refresh token
  expires: number; // Unix timestamp ms
};

/** Union of all credential types */
export type Credential = ApiKeyCredential | TokenCredential | OAuthCredential;

/**
 * What Claude CLI returns - can be EITHER oauth OR token
 * depending on how the user authenticated.
 */
export type ClaudeCliCredential =
  | (OAuthCredential & { provider: 'anthropic' })
  | (TokenCredential & { provider: 'anthropic' });

/** Configuration for auth behavior */
export type AuthConfig = {
  /** Primary auth method: 'oauth' | 'api_key' | 'auto' */
  primary: 'oauth' | 'api_key' | 'auto';

  /** Enable fallback to secondary method on failure */
  enableFallback: boolean;

  /** Refresh OAuth tokens this many ms before expiry */
  refreshBufferMs: number;

  /** TTL for Claude CLI credential cache (ms) */
  cliCredentialsTtlMs: number;

  /** Log auth events (refresh, fallback) */
  verbose: boolean;
};

/** Default auth configuration */
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  primary: 'auto',
  enableFallback: true,
  refreshBufferMs: 5 * 60 * 1000, // 5 minutes
  cliCredentialsTtlMs: 15 * 60 * 1000, // 15 minutes (matches clawdbot)
  verbose: false,
};
