import { describe, expect, it, vi } from 'vitest';
import { ChainedProvider } from '../../src/auth/chained-provider.js';
import type { AuthProvider, AuthProviderInfo } from '../../src/auth/types.js';
import { DEFAULT_AUTH_CONFIG } from '../../src/auth/types.js';

function mockProvider(apiKey: string, available: boolean, shouldThrow = false): AuthProvider {
  return {
    getApiKey: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Provider error');
      if (!available) throw new Error('Not available');
      return apiKey;
    }),
    getProviderInfo: (): AuthProviderInfo => ({
      type: 'api_key',
      name: available ? 'Available Provider' : 'Unavailable Provider',
      available,
    }),
    isAvailable: () => available,
  };
}

describe('ChainedProvider', () => {
  it('uses primary provider when available', async () => {
    const primary = mockProvider('primary-key', true);
    const fallback = mockProvider('fallback-key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: DEFAULT_AUTH_CONFIG,
    });

    expect(await provider.getApiKey()).toBe('primary-key');
    expect(provider.getLastUsedProvider()).toBe('primary');
  });

  it('falls back when primary is unavailable', async () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('fallback-key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: true },
    });

    expect(await provider.getApiKey()).toBe('fallback-key');
    expect(provider.getLastUsedProvider()).toBe('fallback');
  });

  it('falls back when primary throws error', async () => {
    const primary = mockProvider('primary-key', true, true);
    const fallback = mockProvider('fallback-key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: true },
    });

    expect(await provider.getApiKey()).toBe('fallback-key');
    expect(provider.getLastUsedProvider()).toBe('fallback');
  });

  it('throws when fallback disabled and primary fails', async () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('fallback-key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: false },
    });

    await expect(provider.getApiKey()).rejects.toThrow('Authentication failed');
  });

  it('throws when both providers fail', async () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('', false);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: true },
    });

    await expect(provider.getApiKey()).rejects.toThrow('Authentication failed');
  });

  it('works without fallback provider', async () => {
    const primary = mockProvider('primary-key', true);

    const provider = new ChainedProvider({
      primary,
      config: DEFAULT_AUTH_CONFIG,
    });

    expect(await provider.getApiKey()).toBe('primary-key');
  });

  it('throws when primary fails and no fallback', async () => {
    const primary = mockProvider('', false);

    const provider = new ChainedProvider({
      primary,
      config: DEFAULT_AUTH_CONFIG,
    });

    await expect(provider.getApiKey()).rejects.toThrow('Authentication failed');
  });

  it('logs when verbose mode enabled', async () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('fallback-key', true);
    const log = vi.fn();

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: true, verbose: true },
      log,
    });

    await provider.getApiKey();

    expect(log).toHaveBeenCalledWith('Falling back to secondary auth provider');
  });

  it('logs errors when verbose mode enabled', async () => {
    const primary = mockProvider('primary-key', true, true);
    const fallback = mockProvider('fallback-key', true);
    const log = vi.fn();

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: { ...DEFAULT_AUTH_CONFIG, enableFallback: true, verbose: true },
      log,
    });

    await provider.getApiKey();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Primary auth failed'));
  });

  it('returns correct provider info', () => {
    const primary = mockProvider('primary-key', true);
    const fallback = mockProvider('fallback-key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: DEFAULT_AUTH_CONFIG,
    });

    const info = provider.getProviderInfo();
    expect(info.type).toBe('chained');
    expect(info.available).toBe(true);
    expect(info.name).toContain('→');
  });

  it('isAvailable returns true when primary available', () => {
    const primary = mockProvider('key', true);
    const fallback = mockProvider('', false);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: DEFAULT_AUTH_CONFIG,
    });

    expect(provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns true when fallback available', () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('key', true);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: DEFAULT_AUTH_CONFIG,
    });

    expect(provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when both unavailable', () => {
    const primary = mockProvider('', false);
    const fallback = mockProvider('', false);

    const provider = new ChainedProvider({
      primary,
      fallback,
      config: DEFAULT_AUTH_CONFIG,
    });

    expect(provider.isAvailable()).toBe(false);
  });
});
