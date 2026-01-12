import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { getAccountStatePath, STATE_DIR } from './paths.js';
import type { AccountState } from './types.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

const DEFAULT_STATE: AccountState = {
  username: '',
  processedIds: [],
  lastPoll: null,
  lastError: null,
  stats: { total: 0, success: 0, errors: 0 },
};

async function ensureStateDir(): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

export async function loadAccountState(username: string): Promise<AccountState> {
  const statePath = getAccountStatePath(username);
  return readJsonSafe<AccountState>(statePath, { ...DEFAULT_STATE, username });
}

export async function saveAccountState(state: AccountState): Promise<void> {
  await ensureStateDir();
  const statePath = getAccountStatePath(state.username);
  await writeJsonAtomic(statePath, state);
}

export async function withAccountStateLock<T>(
  username: string,
  task: (state: AccountState) => Promise<T>,
  options: { save?: boolean } = {}
): Promise<T> {
  const { save = true } = options;
  const statePath = getAccountStatePath(username);

  return withFileLock(getLockPath(statePath), async () => {
    const state = await loadAccountState(username);
    const result = await task(state);
    if (save) {
      await saveAccountState(state);
    }
    return result;
  });
}

export async function readAccountStateLocked(username: string): Promise<AccountState> {
  return withAccountStateLock(username, async (state) => state, { save: false });
}
