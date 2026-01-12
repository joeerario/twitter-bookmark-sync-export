#!/usr/bin/env node
/**
 * Main Entry Point
 *
 * Bookmark automation service with graceful shutdown.
 */

import './env.js';

import { loadAccounts } from './accounts.js';
import { config } from './config.js';
import { parseProcessingArgs, runProcessingCycle } from './pipeline-runner.js';

/**
 * Graceful Shutdown Manager
 */
class ShutdownManager {
  shuttingDown = false;
  isPolling = false;
  currentPollPromise: Promise<unknown> | null = null;
  shutdownTimeout = 30000;

  async initiateShutdown(): Promise<void> {
    if (this.shuttingDown) return;

    this.shuttingDown = true;
    console.log('\n[Shutdown] Graceful shutdown initiated...');

    try {
      if (this.isPolling && this.currentPollPromise) {
        console.log('[Shutdown] Waiting for current poll to complete...');

        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          setTimeout(() => {
            console.log('[Shutdown] Timeout waiting for poll, forcing exit...');
            resolve('timeout');
          }, this.shutdownTimeout);
        });

        // Wrap in Promise.allSettled to prevent rejection from blocking shutdown
        const [result] = await Promise.allSettled([
          Promise.race([this.currentPollPromise, timeoutPromise])
        ]);

        if (result.status === 'fulfilled' && result.value !== 'timeout') {
          console.log('[Shutdown] Poll completed successfully.');
        } else if (result.status === 'rejected') {
          console.error('[Shutdown] Poll failed during shutdown:', result.reason);
        }
      }
    } catch (e) {
      console.error('[Shutdown] Error during shutdown:', e);
    }

    console.log('[Shutdown] Cleanup complete. Exiting.');
    process.exit(0);
  }
}

const shutdownManager = new ShutdownManager();

/**
 * Start the service
 */
async function start(): Promise<void> {
  console.log('='.repeat(70));
  console.log('BOOKMARK AUTOMATION SERVICE');
  console.log('='.repeat(70));
  console.log(`Poll interval: ${config.pollInterval / 1000} seconds`);

  const accounts = await loadAccounts();

  if (accounts.length === 0) {
    console.log('\nNo accounts configured.');
    console.log('Next steps:');
    console.log('  npm run build');
    console.log('  npm run setup -- add');
    console.log('  npm run start');
    process.exit(1);
  }

  const enabled = accounts.filter((a) => a.enabled);
  console.log(`\nAccounts: ${accounts.length} total, ${enabled.length} enabled`);
  for (const acc of accounts) {
    const status = acc.enabled ? '✓' : '✗';
    const error = acc.validationError ? ` (${acc.validationError})` : '';
    console.log(`  ${status} @${acc.username}${error}`);
  }

  if (enabled.length === 0) {
    console.log('\nNo enabled accounts. Enable at least one account.');
    process.exit(1);
  }

  const options = parseProcessingArgs(process.argv);

  console.log('');

  // Register shutdown handlers
  process.on('SIGINT', () => shutdownManager.initiateShutdown());
  process.on('SIGTERM', () => shutdownManager.initiateShutdown());

  async function safePoll(): Promise<void> {
    if (shutdownManager.isPolling || shutdownManager.shuttingDown) return;

    shutdownManager.isPolling = true;
    shutdownManager.currentPollPromise = runProcessingCycle(options);

    try {
      await shutdownManager.currentPollPromise;
    } finally {
      shutdownManager.isPolling = false;
      shutdownManager.currentPollPromise = null;
    }
  }

  // Initial poll
  await safePoll();

  console.log('\nService running. Press Ctrl+C to stop.');

  while (!shutdownManager.shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
    if (shutdownManager.shuttingDown) break;
    await safePoll();
  }
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
