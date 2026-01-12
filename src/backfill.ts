#!/usr/bin/env node
/**
 * Backfill CLI
 *
 * Process historical bookmarks with pagination support.
 */

import './env.js';

import { getAccountByUsername, getEnabledAccounts } from './accounts.js';
import { fetchBookmarksForAccount, markAsProcessed } from './bookmark-fetcher.js';
import { config } from './config.js';
import { processBookmark } from './processor.js';
import { isBookmarkProcessed } from './storage.js';
import type { Account } from './types.js';

interface ParsedArgs {
  count: number | null;
  maxCycles: number;
  account: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = { count: null, maxCycles: 5, account: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--count') {
      result.count = Number.parseInt(args[i + 1] || '', 10);
      i++;
    } else if (arg === '--max-cycles') {
      result.maxCycles = Number.parseInt(args[i + 1] || '', 10);
      i++;
    } else if (arg === '--account') {
      result.account = (args[i + 1] || '').replace('@', '');
      i++;
    }
  }

  return result;
}

async function fetchWithRetry(
  account: Account,
  count: number,
  cursor: string | null
): Promise<{ result: ReturnType<typeof fetchBookmarksForAccount> extends Promise<infer T> ? T : never; cursorRejected: boolean }> {
  const result = await fetchBookmarksForAccount(account, count, cursor);
  const cursorRejected = !result.success && (result.error?.includes('Query: Unspecified') ?? false);
  return { result, cursorRejected };
}

async function runForAccount(account: Account, count: number, maxCycles: number): Promise<void> {
  console.log(`\n=== Backfill @${account.username} (count=${count}, maxCycles=${maxCycles}) ===`);

  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let totalProcessed = 0;
  let cursor: string | null = null;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const { result, cursorRejected } = await fetchWithRetry(account, count, cursor);

    if (!result.success) {
      if (cursor && cursorRejected) {
        console.log(`[@${account.username}] Cursor rejected; assuming end of bookmarks.`);
        break;
      }
      console.error(`[@${account.username}] Error fetching bookmarks: ${result.error}`);
      break;
    }

    const bookmarks = result.bookmarks || [];
    const nextCursor = result.nextCursor || null;
    let cycleProcessed = 0;
    const processedIds: string[] = [];
    const totalToProcess = bookmarks.length;
    let processedIndex = 0;

    for (const bookmark of bookmarks) {
      if (seenIds.has(bookmark.id)) continue;
      seenIds.add(bookmark.id);

      if (isBookmarkProcessed(account.username, bookmark.id)) {
        continue;
      }

      processedIndex += 1;
      const processResult = await processBookmark(bookmark, { index: processedIndex, total: totalToProcess });
      if (processResult.success) {
        cycleProcessed++;
        processedIds.push(bookmark.id);
      }
    }

    if (processedIds.length > 0) {
      await markAsProcessed(account.username, processedIds);
      totalProcessed += cycleProcessed;
    }

    console.log(
      `Cycle ${cycle}: fetched ${bookmarks.length}, new processed ${cycleProcessed}, total processed ${totalProcessed}`
    );

    if (bookmarks.length === 0) {
      console.log(`No bookmarks returned in cycle ${cycle}. Stopping backfill for @${account.username}.`);
      break;
    }

    if (!nextCursor) {
      console.log(`No next cursor returned. Stopping backfill for @${account.username}.`);
      break;
    }

    if (seenCursors.has(nextCursor)) {
      console.log(`Cursor ${nextCursor.slice(0, 20)}... already seen. Stopping backfill for @${account.username}.`);
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function main(): Promise<void> {
  const { count, maxCycles, account } = parseArgs(process.argv);
  const resolvedCount = Number.isFinite(count) && count! > 0 ? count! : config.bookmarkCount;
  const resolvedMaxCycles = Number.isFinite(maxCycles) && maxCycles > 0 ? maxCycles : 5;

  if (account) {
    const acc = await getAccountByUsername(account);
    if (!acc) {
      console.error(`Account @${account} not found.`);
      process.exit(1);
    }
    await runForAccount(acc, resolvedCount, resolvedMaxCycles);
    return;
  }

  const accounts = await getEnabledAccounts();
  if (accounts.length === 0) {
    console.log('No enabled accounts found. Add accounts first.');
    process.exit(1);
  }

  for (const acc of accounts) {
    await runForAccount(acc, resolvedCount, resolvedMaxCycles);
  }
}

main().catch((error) => {
  console.error('Backfill failed:', error.message);
  process.exit(1);
});
