import { describe, expect, it, vi } from 'vitest';

describe('setup CLI', () => {
  it('shows usage when missing command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.resetModules();
    vi.doMock('../src/env.js', () => ({}));
    vi.doMock('../src/accounts.js', () => ({
      addAccount: vi.fn(),
      listAccounts: vi.fn(async () => []),
      loadAccounts: vi.fn(async () => []),
      removeAccount: vi.fn(),
      revalidateAccounts: vi.fn(async () => []),
      setAccountEnabled: vi.fn(),
    }));

    const originalArgv = process.argv;
    process.argv = ['node', 'setup'];

    await import('../src/setup.js');

    expect(logSpy).toHaveBeenCalled();

    process.argv = originalArgv;
    logSpy.mockRestore();
  });

  it('lists accounts from storage', async () => {
    const accounts = [
      {
        id: '1',
        username: 'tester',
        name: 'Tester',
        authToken: 'token',
        ct0: 'ct0',
        enabled: true,
        addedAt: '2024-01-01',
        lastValidated: '2024-01-01',
        validationError: null,
        userId: '123',
      },
    ];

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.resetModules();
    vi.doMock('../src/env.js', () => ({}));
    vi.doMock('../src/accounts.js', () => ({
      addAccount: vi.fn(),
      listAccounts: vi.fn(async () => accounts),
      loadAccounts: vi.fn(async () => accounts),
      removeAccount: vi.fn(),
      revalidateAccounts: vi.fn(async () => []),
      setAccountEnabled: vi.fn(),
    }));

    const originalArgv = process.argv;
    process.argv = ['node', 'setup', 'list'];

    await import('../src/setup.js');

    expect(logSpy).toHaveBeenCalledWith('Configured accounts:\n');

    process.argv = originalArgv;
    logSpy.mockRestore();
  });
});
