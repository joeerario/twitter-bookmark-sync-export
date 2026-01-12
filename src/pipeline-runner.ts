import { exportBookmarks, generateIndex, loadConfig, loadExportedIdSet } from './obsidian-exporter.js';
import { pollOnce } from './processor.js';
import { getRecentItems } from './storage.js';
import type { PollResult, ProcessedBookmark } from './types.js';

export interface ProcessingOptions {
  dryRun?: boolean;
  accountFilter?: string[];
  syncObsidian?: boolean;
}

export function parseProcessingArgs(argv: string[]): ProcessingOptions {
  const options: ProcessingOptions = { dryRun: false, syncObsidian: true };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--no-obsidian') {
      options.syncObsidian = false;
      continue;
    }
    if (arg === '--account') {
      const value = argv[i + 1];
      if (value) {
        const accounts = value
          .split(',')
          .map((name) => name.replace('@', '').trim())
          .filter(Boolean);
        if (accounts.length > 0) {
          options.accountFilter = [...(options.accountFilter ?? []), ...accounts];
        }
        i += 1;
      }
    }
  }

  return options;
}

async function syncToObsidian(): Promise<{ exported: number; skipped: number }> {
  const config = await loadConfig();
  if (!config.vaultPath) {
    console.log('[Obsidian] Vault not configured, skipping sync');
    return { exported: 0, skipped: 0 };
  }

  const categories = ['try', 'review', 'knowledge', 'life'];
  const toExport: ProcessedBookmark[] = [];
  const exportedIds = await loadExportedIdSet();

  for (const cat of categories) {
    const items = await getRecentItems(cat, 50);
    for (const item of items) {
      if (!exportedIds.has(item.id)) {
        toExport.push(item);
      }
    }
  }

  if (toExport.length === 0) {
    return { exported: 0, skipped: 0 };
  }

  console.log(`[Obsidian] Syncing ${toExport.length} new bookmarks...`);
  const results = await exportBookmarks(toExport, config);

  if (results.exported > 0) {
    await generateIndex(config);
  }

  console.log(`[Obsidian] Exported: ${results.exported}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
  return { exported: results.exported, skipped: results.skipped };
}

export async function runProcessingCycle(options: ProcessingOptions = {}): Promise<PollResult> {
  const result = await pollOnce(options);

  if (options.syncObsidian !== false && !options.dryRun) {
    await syncToObsidian();
  }

  return result;
}
