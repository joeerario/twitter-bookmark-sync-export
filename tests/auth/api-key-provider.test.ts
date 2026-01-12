import { describe, expect, it } from 'vitest';
import { ApiKeyProvider } from '../../src/auth/api-key-provider.js';

describe('ApiKeyProvider', () => {
  it('returns configured API key', async () => {
    const provider = new ApiKeyProvider('test-key');
    expect(await provider.getApiKey()).toBe('test-key');
  });

  it('throws when no API key configured', async () => {
    const provider = new ApiKeyProvider(undefined);
    await expect(provider.getApiKey()).rejects.toThrow('ANTHROPIC_API_KEY not configured');
  });

  it('reports availability based on key presence', () => {
    expect(new ApiKeyProvider('key').isAvailable()).toBe(true);
    expect(new ApiKeyProvider(undefined).isAvailable()).toBe(false);
    expect(new ApiKeyProvider('').isAvailable()).toBe(false);
  });

  it('returns correct provider info when available', () => {
    const info = new ApiKeyProvider('key').getProviderInfo();
    expect(info.type).toBe('api_key');
    expect(info.name).toBe('Environment API Key');
    expect(info.available).toBe(true);
  });

  it('returns correct provider info when unavailable', () => {
    const info = new ApiKeyProvider(undefined).getProviderInfo();
    expect(info.type).toBe('api_key');
    expect(info.name).toBe('Environment API Key');
    expect(info.available).toBe(false);
  });
});
