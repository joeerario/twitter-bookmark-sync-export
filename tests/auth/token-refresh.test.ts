import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { refreshOAuthTokens, needsRefresh } from '../../src/auth/token-refresh.js';

describe('token-refresh', () => {
  const mockFetch = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('refreshOAuthTokens', () => {
    it('refreshes tokens successfully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
      });

      const result = await refreshOAuthTokens('old-refresh');

      expect(result.type).toBe('oauth');
      expect(result.access).toBe('new-access');
      expect(result.refresh).toBe('new-refresh');
      expect(result.expires).toBeGreaterThan(Date.now());
    });

    it('keeps old refresh token if not returned', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            expires_in: 3600,
          }),
      });

      const result = await refreshOAuthTokens('old-refresh');
      expect(result.refresh).toBe('old-refresh');
    });

    it('throws on refresh failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid refresh token'),
      });

      await expect(refreshOAuthTokens('bad-token')).rejects.toThrow('Token refresh failed: 401');
    });

    it('applies buffer to expiry', async () => {
      const bufferMs = 5 * 60 * 1000;
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            expires_in: 3600,
          }),
      });

      const before = Date.now();
      const result = await refreshOAuthTokens('refresh', bufferMs);
      const after = Date.now();

      // Expiry should be approximately (now + 3600s - buffer)
      const expectedMin = before + 3600 * 1000 - bufferMs;
      const expectedMax = after + 3600 * 1000 - bufferMs;
      expect(result.expires).toBeGreaterThanOrEqual(expectedMin - 100);
      expect(result.expires).toBeLessThanOrEqual(expectedMax + 100);
    });

    it('sends correct request body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            expires_in: 3600,
          }),
      });

      await refreshOAuthTokens('my-refresh-token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://console.anthropic.com/v1/oauth/token');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.grant_type).toBe('refresh_token');
      expect(body.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(body.refresh_token).toBe('my-refresh-token');
    });
  });

  describe('needsRefresh', () => {
    it('returns true for expired credentials', () => {
      expect(needsRefresh(Date.now() - 1000)).toBe(true);
    });

    it('returns false for valid credentials', () => {
      expect(needsRefresh(Date.now() + 3600000)).toBe(false);
    });

    it('accounts for buffer', () => {
      const bufferMs = 5 * 60 * 1000;
      // Expires in 4 minutes, buffer is 5 minutes -> needs refresh
      expect(needsRefresh(Date.now() + 4 * 60 * 1000, bufferMs)).toBe(true);
      // Expires in 6 minutes, buffer is 5 minutes -> doesn't need refresh
      expect(needsRefresh(Date.now() + 6 * 60 * 1000, bufferMs)).toBe(false);
    });

    it('returns true at exact boundary', () => {
      // At exactly the expiry time
      expect(needsRefresh(Date.now(), 0)).toBe(true);
    });
  });
});
