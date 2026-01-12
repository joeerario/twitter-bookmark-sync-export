#!/usr/bin/env node
/**
 * Process Bookmarks CLI
 *
 * One-shot processing of bookmarks.
 */

import './env.js';

import { parseProcessingArgs, runProcessingCycle } from './pipeline-runner.js';
import { toErrorMessage } from './utils/errors.js';

async function main(): Promise<void> {
  const options = parseProcessingArgs(process.argv);
  const result = await runProcessingCycle(options);
  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error(`Failed to process bookmarks: ${toErrorMessage(error)}`);
  console.error('Next steps: run `npm run status`, verify `ANTHROPIC_API_KEY`, and re-check account credentials.');
  process.exit(1);
});
