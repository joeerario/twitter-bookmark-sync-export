/**
 * Token Refresh
 *
 * OAuth token refresh logic for Claude CLI credentials.
 */

import type { OAuthCredential } from './types.js';

const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

/**
 * Refresh OAuth tokens using the refresh token.
 * Returns new OAuthCredential with updated access token and expiry.
 *
 * Note: This only works for 'oauth' type credentials.
 * 'token' type credentials cannot be refreshed.
 */
export async function refreshOAuthTokens(
  refreshToken: string,
  bufferMs = 5 * 60 * 1000
): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  // Calculate expiry with buffer
  const expires = Date.now() + data.expires_in * 1000 - bufferMs;

  return {
    type: 'oauth',
    access: data.access_token,
    refresh: data.refresh_token ?? refreshToken,
    expires,
  };
}

/**
 * Check if credentials need refresh based on expiry timestamp.
 */
export function needsRefresh(expires: number, bufferMs = 0): boolean {
  return Date.now() >= expires - bufferMs;
}
