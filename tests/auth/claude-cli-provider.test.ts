import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClaudeCliProvider } from '../../src/auth/claude-cli-provider.js';
import { DEFAULT_AUTH_CONFIG } from '../../src/auth/types.js';
import * as credentials from '../../src/auth/credentials.js';
import * as tokenRefresh from '../../src/auth/token-refresh.js';

vi.mock('../../src/auth/credentials.js', () => ({
  readClaudeCliCredentials: vi.fn(),
  writeClaudeCliCredentials: vi.fn(),
}));

vi.mock('../../src/auth/token-refresh.js', () => ({
  refreshOAuthTokens: vi.fn(),
}));

describe('ClaudeCliProvider', () => {
  const mockReadCredentials = vi.mocked(credentials.readClaudeCliCredentials);
  const mockWriteCredentials = vi.mocked(credentials.writeClaudeCliCredentials);
  const mockRefreshTokens = vi.mocked(tokenRefresh.refreshOAuthTokens);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ============================================
  // OAuth credentials (refreshable)
  // ============================================

  it('reads oauth credentials from Claude CLI', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'oauth-token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const key = await provider.getApiKey();

    expect(key).toBe('oauth-token');
  });

  it('refreshes expired oauth tokens', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'old-token',
      refresh: 'refresh',
      expires: Date.now() - 1000, // Expired
    });
    mockRefreshTokens.mockResolvedValue({
      type: 'oauth',
      access: 'new-token',
      refresh: 'new-refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const key = await provider.getApiKey();

    expect(key).toBe('new-token');
    expect(mockRefreshTokens).toHaveBeenCalled();
  });

  it('refreshes tokens expiring soon (within buffer)', async () => {
    const config = { ...DEFAULT_AUTH_CONFIG, refreshBufferMs: 5 * 60 * 1000 };
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'old-token',
      refresh: 'refresh',
      expires: Date.now() + 2 * 60 * 1000, // Expires in 2 minutes, buffer is 5 minutes
    });
    mockRefreshTokens.mockResolvedValue({
      type: 'oauth',
      access: 'new-token',
      refresh: 'new-refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(config);
    const key = await provider.getApiKey();

    expect(key).toBe('new-token');
    expect(mockRefreshTokens).toHaveBeenCalled();
  });

  it('deduplicates concurrent refresh calls', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'old-token',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    });
    mockRefreshTokens.mockResolvedValue({
      type: 'oauth',
      access: 'new-token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);

    await Promise.all([provider.getApiKey(), provider.getApiKey(), provider.getApiKey()]);

    expect(mockRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it('syncs refreshed tokens to Claude CLI', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'old-token',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    });
    const newCreds = {
      type: 'oauth' as const,
      access: 'new-token',
      refresh: 'new-refresh',
      expires: Date.now() + 3600000,
    };
    mockRefreshTokens.mockResolvedValue(newCreds);
    mockWriteCredentials.mockReturnValue(true);

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    await provider.getApiKey();

    expect(mockWriteCredentials).toHaveBeenCalledWith(newCreds);
  });

  it('logs when verbose mode enabled', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'old-token',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    });
    mockRefreshTokens.mockResolvedValue({
      type: 'oauth',
      access: 'new-token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
    });
    mockWriteCredentials.mockReturnValue(true);

    const log = vi.fn();
    const provider = new ClaudeCliProvider({ ...DEFAULT_AUTH_CONFIG, verbose: true }, log);
    await provider.getApiKey();

    expect(log).toHaveBeenCalledWith('Refreshing OAuth token...');
    expect(log).toHaveBeenCalledWith('Token refreshed and synced to Claude CLI');
  });

  // ============================================
  // Token credentials (NOT refreshable)
  // ============================================

  it('reads token credentials from Claude CLI', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'token',
      provider: 'anthropic',
      token: 'setup-token',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const key = await provider.getApiKey();

    expect(key).toBe('setup-token');
  });

  it('throws when token credentials expire (cannot refresh)', async () => {
    mockReadCredentials.mockReturnValue({
      type: 'token',
      provider: 'anthropic',
      token: 'expired-token',
      expires: Date.now() - 1000, // Expired
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    await expect(provider.getApiKey()).rejects.toThrow('Claude CLI token has expired');
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  // ============================================
  // No credentials
  // ============================================

  it('throws when no credentials found', async () => {
    mockReadCredentials.mockReturnValue(null);

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    await expect(provider.getApiKey()).rejects.toThrow('No Claude CLI credentials found');
  });

  // ============================================
  // Provider info
  // ============================================

  it('reports correct provider info for oauth', () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const info = provider.getProviderInfo();

    expect(info.type).toBe('oauth');
    expect(info.name).toBe('Claude CLI OAuth');
    expect(info.available).toBe(true);
  });

  it('reports correct provider info for token', () => {
    mockReadCredentials.mockReturnValue({
      type: 'token',
      provider: 'anthropic',
      token: 'token',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const info = provider.getProviderInfo();

    expect(info.type).toBe('token');
    expect(info.name).toBe('Claude CLI Token');
    expect(info.available).toBe(true);
  });

  it('reports unavailable when no credentials', () => {
    mockReadCredentials.mockReturnValue(null);

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    const info = provider.getProviderInfo();

    expect(info.available).toBe(false);
  });

  it('isAvailable returns true when credentials exist', () => {
    mockReadCredentials.mockReturnValue({
      type: 'oauth',
      provider: 'anthropic',
      access: 'token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
    });

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    expect(provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no credentials', () => {
    mockReadCredentials.mockReturnValue(null);

    const provider = new ClaudeCliProvider(DEFAULT_AUTH_CONFIG);
    expect(provider.isAvailable()).toBe(false);
  });
});
