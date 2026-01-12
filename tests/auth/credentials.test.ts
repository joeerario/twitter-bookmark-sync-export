import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

// Mock modules
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: vi.fn((...parts: string[]) => parts.join('/')),
  },
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/user'),
  },
}));

describe('credentials', () => {
  const mockExecSync = vi.mocked(execSync);
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.resetAllMocks();
    // Clear credential cache before each test
    const { clearCredentialCache } = await import('../../src/auth/credentials.js');
    clearCredentialCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('readClaudeCliCredentials', () => {
    it('returns oauth type when refresh token exists on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockExecSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: 123456789,
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toEqual({
        type: 'oauth',
        provider: 'anthropic',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 123456789,
      });
    });

    it('returns token type when no refresh token on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockExecSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'setup-token',
            expiresAt: 123456789,
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toEqual({
        type: 'token',
        provider: 'anthropic',
        token: 'setup-token',
        expires: 123456789,
      });
    });

    it('falls back to file when keychain fails on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockExecSync.mockImplementation(() => {
        throw new Error('keychain not found');
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'file-token',
            refreshToken: 'file-refresh',
            expiresAt: 987654321,
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds?.type).toBe('oauth');
      expect((creds as { access: string }).access).toBe('file-token');
    });

    it('reads from file on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'linux-token',
            refreshToken: 'linux-refresh',
            expiresAt: 111222333,
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds?.type).toBe('oauth');
      expect((creds as { access: string }).access).toBe('linux-token');
    });

    it('returns null when no credentials file exists', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(false);

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toBeNull();
    });

    it('returns null when credentials file has no claudeAiOauth', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toBeNull();
    });

    it('returns null when accessToken is missing', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            expiresAt: 123456,
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toBeNull();
    });

    it('returns null when expiresAt is missing', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'token',
          },
        })
      );

      const { readClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const creds = readClaudeCliCredentials();

      expect(creds).toBeNull();
    });

    it('uses cached credentials within TTL', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'cached-token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 3600000,
          },
        })
      );

      const { readClaudeCliCredentials, clearCredentialCache } = await import('../../src/auth/credentials.js');
      clearCredentialCache();

      // First call - reads from file
      readClaudeCliCredentials({ ttlMs: 60000 });
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);

      // Second call - uses cache
      const creds = readClaudeCliCredentials({ ttlMs: 60000 });
      expect(mockReadFileSync).toHaveBeenCalledTimes(1); // Not called again
      expect((creds as { access: string }).access).toBe('cached-token');
    });
  });

  describe('writeClaudeCliCredentials', () => {
    it('writes credentials to file on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'old-token',
            refreshToken: 'old-refresh',
            expiresAt: 111,
          },
        })
      );

      const { writeClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const result = writeClaudeCliCredentials({
        type: 'oauth',
        access: 'new-token',
        refresh: 'new-refresh',
        expires: 222,
      });

      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(writtenData.claudeAiOauth.accessToken).toBe('new-token');
      expect(writtenData.claudeAiOauth.refreshToken).toBe('new-refresh');
      expect(writtenData.claudeAiOauth.expiresAt).toBe(222);
    });

    it('returns false when credentials file does not exist', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(false);

      const { writeClaudeCliCredentials } = await import('../../src/auth/credentials.js');
      const result = writeClaudeCliCredentials({
        type: 'oauth',
        access: 'token',
        refresh: 'refresh',
        expires: 123,
      });

      expect(result).toBe(false);
    });
  });

  describe('clearCredentialCache', () => {
    it('clears the credential cache', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 3600000,
          },
        })
      );

      const { readClaudeCliCredentials, clearCredentialCache } = await import('../../src/auth/credentials.js');

      // Read with TTL to populate cache
      readClaudeCliCredentials({ ttlMs: 60000 });
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);

      // Clear cache
      clearCredentialCache();

      // Next read should hit the file again
      readClaudeCliCredentials({ ttlMs: 60000 });
      expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    });
  });
});
