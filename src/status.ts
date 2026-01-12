#!/usr/bin/env node
/**
 * Status CLI
 *
 * Displays system health and status information.
 */

import './env.js';

import { loadAccounts } from './accounts.js';
import { loadAccountState } from './account-state.js';
import { getAllRateLimitStates, getFailedTweets, isRateLimited } from './failure-handler.js';
import { getExportStats } from './obsidian-exporter.js';
import { getPreferenceSummary } from './preferences.js';
import { getSummary } from './storage.js';
import type { AccountState } from './types.js';
import { toErrorMessage } from './utils/errors.js';
import { getReadJsonFailureCount, resetReadJsonFailureCount } from './utils/read-json-safe.js';

/**
 * Format date for display
 */
function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return 'never';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

/**
 * Format remaining time
 */
function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function getEmptyAccountState(username: string): AccountState {
  return {
    username,
    processedIds: [],
    lastPoll: null,
    lastError: null,
    stats: { total: 0, success: 0, errors: 0 },
  };
}

async function safeRead<T>(label: string, fallback: T, reader: () => Promise<T>): Promise<T> {
  try {
    return await reader();
  } catch (e) {
    console.error(`Warning: ${label} read failed: ${toErrorMessage(e)}`);
    return fallback;
  }
}

export async function showStatus(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('BOOKMARK AUTOMATION STATUS');
  console.log('='.repeat(60));

  resetReadJsonFailureCount();

  // Accounts
  console.log('\n## Accounts\n');
  const accounts = await safeRead('accounts', [], () => loadAccounts());

  if (accounts.length === 0) {
    console.log('No accounts configured.');
  } else {
    for (const account of accounts) {
      const state = await safeRead(
        `account state for @${account.username}`,
        getEmptyAccountState(account.username),
        () => loadAccountState(account.username)
      );
      const status = account.enabled ? '\x1b[32m[enabled]\x1b[0m' : '\x1b[31m[disabled]\x1b[0m';
      const lastPoll = formatDate(state.lastPoll);

      console.log(`@${account.username} ${status}`);
      console.log(`  Last poll: ${lastPoll}`);
      console.log(`  Processed: ${state.processedIds?.length || 0} total`);

      if (state.lastError) {
        console.log(
          `  \x1b[33mLast error:\x1b[0m ${state.lastError.message?.slice(0, 50)} (${formatDate(state.lastError.at)})`
        );
      }

      const rateLimit = await isRateLimited(account.username);
      if (rateLimit.isLimited) {
        console.log(`  \x1b[31mRate limited:\x1b[0m ${formatRemaining(rateLimit.remainingMs)} remaining`);
      }

      console.log('');
    }
  }

  // Rate Limits
  const rateLimitStates = await safeRead('rate limit state', new Map(), () => getAllRateLimitStates());
  const activeRateLimits = [...rateLimitStates.values()].filter((s) => s.consecutiveRateLimits > 0);

  if (activeRateLimits.length > 0) {
    console.log('## Rate Limit Status\n');
    for (const state of activeRateLimits) {
      const rateLimit = await isRateLimited(state.account);
      const status = rateLimit.isLimited
        ? `\x1b[31mLimited\x1b[0m (${formatRemaining(rateLimit.remainingMs)})`
        : '\x1b[32mCleared\x1b[0m';
      console.log(`@${state.account}: ${status} (${state.consecutiveRateLimits} consecutive)`);
    }
    console.log('');
  }

  // Failed Bookmarks
  console.log('## Failed Bookmarks\n');
  let totalFailed = 0;
  let totalPoisonPills = 0;

  for (const account of accounts) {
    const failed = await safeRead(`failed bookmarks for @${account.username}`, [], () => getFailedTweets(account.username));
    if (failed.length === 0) continue;

    const poisonPills = failed.filter((f) => f.poisonPill);
    totalFailed += failed.length;
    totalPoisonPills += poisonPills.length;

    console.log(`@${account.username}:`);
    console.log(`  Total failed: ${failed.length}`);
    console.log(`  Poison pills: ${poisonPills.length}`);

    const recent = failed.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()).slice(0, 3);
    for (const f of recent) {
      const pill = f.poisonPill ? '\x1b[31m[POISON]\x1b[0m ' : '';
      console.log(`    ${pill}${f.tweetId}: ${f.errorType} (${f.attempts} attempts)`);
    }
    console.log('');
  }

  if (totalFailed === 0) {
    console.log('No failed bookmarks.\n');
  }

  // Processing Statistics
  console.log('## Processing Statistics\n');
  const summary = await safeRead(
    'storage summary',
    { review: 0, try: 0, knowledge: 0, life: 0, skip: 0, total: 0, byAccount: {} },
    () => getSummary()
  );

  console.log(`Total processed: ${summary.total}`);
  console.log(`  Review: ${summary.review}`);
  console.log(`  Try: ${summary.try}`);
  console.log(`  Knowledge: ${summary.knowledge}`);
  console.log(`  Skip: ${summary.skip}`);
  console.log('');

  if (Object.keys(summary.byAccount).length > 1) {
    console.log('By account:');
    for (const [acc, stats] of Object.entries(summary.byAccount)) {
      console.log(`  @${acc}: ${stats.total} (R:${stats.review} T:${stats.try} K:${stats.knowledge} S:${stats.skip})`);
    }
    console.log('');
  }

  // Export Statistics
  console.log('## Obsidian Export\n');
  const exportStats = await safeRead('export stats', { totalExported: 0, lastExport: null }, () => getExportStats());
  console.log(`Exported to Obsidian: ${exportStats.totalExported}`);
  console.log(`Last export: ${formatDate(exportStats.lastExport)}`);
  console.log('');

  // Learning Statistics
  console.log('## Learning System\n');
  const prefs = await safeRead(
    'preference summary',
    {
      stats: { totalReviewed: 0, exported: 0, skipped: 0, autoApproved: 0, autoSkipped: 0 },
      trustedAuthors: [],
      blockedAuthors: [],
      interestedTopics: [],
      learnedInterests: [],
      learnedAvoid: [],
      exampleCount: { exported: 0, skipped: 0 },
    },
    () => getPreferenceSummary()
  );
  console.log(`Reviews: ${prefs.stats.totalReviewed} total`);
  console.log(`  Exported: ${prefs.stats.exported}`);
  console.log(`  Skipped: ${prefs.stats.skipped}`);
  console.log(`Trusted authors: ${prefs.trustedAuthors.length}`);
  console.log(`Blocked authors: ${prefs.blockedAuthors.length}`);
  console.log(`Examples stored: ${prefs.exampleCount.exported + prefs.exampleCount.skipped}`);
  console.log('');

  const readFailures = getReadJsonFailureCount();
  if (readFailures > 0) {
    console.log('## Storage Read Warnings\n');
    console.log(`Malformed JSON files detected: ${readFailures}`);
    console.log('');
  }

  console.log('='.repeat(60));
  console.log(`Status generated at ${new Date().toISOString()}`);
}


async function showAccountDetail(username: string): Promise<void> {
  const accounts = await safeRead('accounts', [], () => loadAccounts());
  const account = accounts.find((a) => a.username === username);

  if (!account) {
    console.log(`Account @${username} not found.`);
    return;
  }

  console.log(`\n## Account: @${username}\n`);

  const state = await safeRead(`account state for @${username}`, getEmptyAccountState(username), () => loadAccountState(username));
  const failed = await safeRead(`failed bookmarks for @${username}`, [], () => getFailedTweets(username));
  const rateLimit = await isRateLimited(username);

  console.log('### Basic Info');
  console.log(`Username: @${account.username}`);
  console.log(`Name: ${account.name}`);
  console.log(`Enabled: ${account.enabled}`);
  console.log(`Added: ${formatDate(account.addedAt)}`);
  console.log(`Last validated: ${formatDate(account.lastValidated)}`);
  if (account.validationError) {
    console.log(`Validation error: ${account.validationError}`);
  }
  console.log('');

  console.log('### Polling State');
  console.log(`Last poll: ${formatDate(state.lastPoll)}`);
  console.log(`Processed IDs tracked: ${state.processedIds?.length || 0}`);
  console.log(`Total processed: ${state.stats?.total || 0}`);
  console.log(`Successful: ${state.stats?.success || 0}`);
  console.log(`Errors: ${state.stats?.errors || 0}`);

  if (state.lastError) {
    console.log(`\nLast error: ${state.lastError.message}`);
    console.log(`  Type: ${state.lastError.type}`);
    console.log(`  At: ${formatDate(state.lastError.at)}`);
  }
  console.log('');

  console.log('### Rate Limit');
  if (rateLimit.isLimited) {
    console.log('Status: RATE LIMITED');
    console.log(`Remaining: ${formatRemaining(rateLimit.remainingMs)}`);
  } else {
    console.log('Status: OK');
  }
  console.log('');

  console.log('### Failed Bookmarks');
  if (failed.length === 0) {
    console.log('No failures recorded.');
  } else {
    console.log(`Total: ${failed.length}`);
    console.log(`Poison pills: ${failed.filter((f) => f.poisonPill).length}`);
    console.log('\nRecent failures:');
    const recent = failed.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()).slice(0, 10);
    for (const f of recent) {
      const pill = f.poisonPill ? '[POISON] ' : '';
      console.log(`  ${pill}${f.tweetId}`);
      console.log(`    Error: ${f.errorType} - ${f.errorMessage?.slice(0, 50)}`);
      console.log(`    Attempts: ${f.attempts}`);
      console.log(`    First: ${formatDate(f.firstSeen)}, Last: ${formatDate(f.lastSeen)}`);
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const arg = process.argv[3];

  switch (command) {
    case 'account':
      if (!arg) {
        console.log('Usage: node dist/status.js account <username>');
        process.exit(1);
      }
      await showAccountDetail(arg.replace('@', ''));
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`
Health/Status CLI

Commands:
  node dist/status.js              Show overall system status
  node dist/status.js account <u>  Show detailed status for account @u

Examples:
  node dist/status.js
  node dist/status.js account joept_
      `);
      break;

    default:
      await showStatus();
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
