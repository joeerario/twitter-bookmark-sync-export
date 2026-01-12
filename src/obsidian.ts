#!/usr/bin/env node
/**
 * Obsidian Integration CLI
 *
 * Export bookmarks to Obsidian vault.
 */

import { createInterface, Interface } from 'readline';
import './env.js';

import {
  exportBookmark,
  exportBookmarks,
  generateIndex,
  getExportStats,
  loadConfig,
  loadExportedIdSet,
  saveConfig,
} from './obsidian-exporter.js';
import {
  analyzeForExport,
  getPreferenceSummary,
  initializeFromAnalysis,
  recordDecision,
  resetLearning,
} from './preferences.js';
import { getRecentItems, getSummary } from './storage.js';
import type { ProcessedBookmark } from './types.js';

const command = process.argv[2];
const args = process.argv.slice(3);

/** Max items per sync to prevent session timeouts and memory pressure */
const MAX_SYNC_ITEMS = 100;
/** Max items for interactive review to keep sessions manageable */
const MAX_REVIEW_ITEMS = 50;
/** Max items for bulk export to prevent memory exhaustion */
const MAX_EXPORT_ITEMS = 1000;
/** Max items for preference training to limit analysis time */
const MAX_TRAIN_ITEMS = 500;

interface ParsedArgs {
  flags: Record<string, string | boolean | number>;
  positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { flags: {}, positional: [] };

  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith('--')) {
        result.flags[key] = parseValue(nextArg);
        i++;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positional.push(args[i]!);
    }
  }

  return result;
}

function parseValue(str: string): string | boolean | number {
  const lower = str.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(str)) return Number.parseInt(str, 10);
  return str;
}

function createRL(): Interface {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(args);

  switch (command) {
    case 'config': {
      const config = await loadConfig();

      if (parsed.flags.vault) {
        config.vaultPath = String(parsed.flags.vault);
        await saveConfig(config);
        console.log(`Vault path set to: ${config.vaultPath}`);
      }

      if (parsed.flags.folder) {
        config.bookmarksFolder = String(parsed.flags.folder);
        await saveConfig(config);
        console.log(`Bookmarks folder set to: ${config.bookmarksFolder}`);
      }

      if (!parsed.flags.vault && !parsed.flags.folder) {
        console.log('Current configuration:');
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }

    case 'sync': {
      const config = await loadConfig();

      if (!config.vaultPath) {
        console.log('Vault path not configured.');
        console.log('Run: node dist/obsidian.js config --vault /path/to/vault');
        process.exit(1);
      }

      console.log(`Syncing to: ${config.vaultPath}/${config.bookmarksFolder}`);
      console.log('');

      const exportOptions = {
        regenerate: parsed.flags.regenerate === true,
        validate: parsed.flags.validate === true,
      };

      // Collect unexported items efficiently (stop early once we have enough)
      const categories = ['try', 'review', 'knowledge', 'life'];
      const toExport: ProcessedBookmark[] = [];
      const exportedIds = await loadExportedIdSet();

      for (const cat of categories) {
        if (toExport.length >= MAX_SYNC_ITEMS) break;

        // Fetch in smaller batches to avoid loading everything
        const batchSize = Math.min(200, MAX_SYNC_ITEMS * 2);
        const items = await getRecentItems(cat, batchSize);

        for (const item of items) {
          if (toExport.length >= MAX_SYNC_ITEMS) break;
          if (!exportedIds.has(item.id)) {
            toExport.push(item);
          }
        }
      }

      console.log(`${toExport.length} new bookmarks to export${toExport.length >= MAX_SYNC_ITEMS ? ` (limited to ${MAX_SYNC_ITEMS})` : ''}`);
      console.log('Run multiple times to process more.');

      if (toExport.length === 0) {
        console.log('Nothing to sync.');
        break;
      }

      const autoExport: Array<{ bookmark: ProcessedBookmark; analysis: { action: string; confidence: number; reasons: string[] } }> = [];
      const autoSkip: Array<{ bookmark: ProcessedBookmark; analysis: { action: string; confidence: number; reasons: string[] } }> = [];
      const needsReview: Array<{ bookmark: ProcessedBookmark; analysis: { action: string; confidence: number; reasons: string[] } }> = [];

      for (const bookmark of toExport) {
        const analysis = await analyzeForExport(bookmark, bookmark);

        if (analysis.action === 'export') {
          autoExport.push({ bookmark, analysis });
        } else if (analysis.action === 'skip') {
          autoSkip.push({ bookmark, analysis });
        } else {
          needsReview.push({ bookmark, analysis });
        }
      }

      console.log('');
      console.log(`Auto-export: ${autoExport.length}`);
      console.log(`Auto-skip: ${autoSkip.length}`);
      console.log(`Needs review: ${needsReview.length}`);
      console.log('');

      if (autoExport.length > 0) {
        console.log('Exporting auto-approved bookmarks...');
        for (const { bookmark } of autoExport) {
          try {
            const result = await exportBookmark(bookmark, config, exportOptions);
            if (result.exported) {
              console.log(`  ${result.folder}/${result.filename}`);
              await recordDecision(bookmark, bookmark, 'export');
            }
          } catch (error) {
            console.log(`  Error: ${error}`);
          }
        }
      }

      for (const { bookmark } of autoSkip) {
        await recordDecision(bookmark, bookmark, 'skip', 'Auto-skipped by preferences');
      }

      if (needsReview.length > 0 && process.stdin.isTTY) {
        console.log('');
        console.log('Items needing review:');

        const rl = createRL();

        for (const { bookmark, analysis } of needsReview) {
          console.log('');
          console.log('-'.repeat(60));
          console.log(
            `@${bookmark.author?.username}: ${bookmark.originalText?.slice(0, 100) || bookmark.text?.slice(0, 100)}...`
          );
          console.log(`Category: ${bookmark.category} | Priority: ${bookmark.priority}`);
          console.log(`Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
          console.log(`Reasons: ${analysis.reasons.join(', ')}`);
          console.log('');

          const answer = await prompt(rl, '[E]xport / [S]kip / [Q]uit? ');

          if (answer.toLowerCase() === 'e' || answer === '') {
            try {
            const result = await exportBookmark(bookmark, config, exportOptions);

              if (result.exported) {
                console.log(`  Exported to ${result.folder}/${result.filename}`);
                await recordDecision(bookmark, bookmark, 'export');
              }
            } catch (error) {
              console.log(`  Error: ${error}`);
            }
          } else if (answer.toLowerCase() === 's') {
            await recordDecision(bookmark, bookmark, 'skip', 'User skipped');
            console.log('  Skipped');
          } else if (answer.toLowerCase() === 'q') {
            console.log('Quitting review...');
            break;
          }
        }

        rl.close();
      } else if (needsReview.length > 0) {
        console.log(`\n${needsReview.length} items need manual review.`);
        console.log('Run in interactive mode: node dist/obsidian.js review');
      }

      if (parsed.flags.index !== false) {
        await generateIndex(config);
        console.log('');
        console.log('Updated Bookmark Index.md');
      }

      break;
    }

    case 'review': {
      const config = await loadConfig();

      if (!config.vaultPath) {
        console.log('Vault path not configured.');
        process.exit(1);
      }

      const exportOptions = {
        regenerate: parsed.flags.regenerate === true,
        validate: parsed.flags.validate === true,
      };

      // Collect unexported items efficiently with limit
      const categories = ['try', 'review', 'knowledge', 'life'];
      const allBookmarks: ProcessedBookmark[] = [];
      const exportedIds = await loadExportedIdSet();

      for (const cat of categories) {
        if (allBookmarks.length >= MAX_REVIEW_ITEMS) break;

        const batchSize = Math.min(100, MAX_REVIEW_ITEMS * 2);
        const items = await getRecentItems(cat, batchSize);

        for (const item of items) {
          if (allBookmarks.length >= MAX_REVIEW_ITEMS) break;
          if (!exportedIds.has(item.id)) {
            allBookmarks.push(item);
          }
        }
      }

      if (allBookmarks.length === 0) {
        console.log('No bookmarks to review.');
        break;
      }

      console.log(`${allBookmarks.length} bookmarks to review${allBookmarks.length >= MAX_REVIEW_ITEMS ? ` (limited to ${MAX_REVIEW_ITEMS})` : ''}`);
      console.log('');

      const rl = createRL();

      let exported = 0;
      let skipped = 0;

      for (const bookmark of allBookmarks) {
        if (exportedIds.has(bookmark.id)) continue;

        const analysis = await analyzeForExport(bookmark, bookmark);

        console.log('-'.repeat(60));
        console.log(`\n@${bookmark.author?.username}: ${(bookmark.originalText || bookmark.text || '').slice(0, 150)}...`);
        console.log(`\nCategory: ${bookmark.category} | Priority: ${bookmark.priority}`);
        console.log(`Summary: ${bookmark.summary || 'N/A'}`);
        console.log(`Tags: ${(bookmark.tags || []).join(', ')}`);
        console.log(
          `\nAI Recommendation: ${analysis.action.toUpperCase()} (${(analysis.confidence * 100).toFixed(0)}% confidence)`
        );
        console.log(`Reasons: ${analysis.reasons.slice(0, 3).join(', ')}`);
        console.log('');

        const answer = await prompt(rl, '[E]xport / [S]kip / [V]iew full / [Q]uit? ');

        if (answer.toLowerCase() === 'v') {
          console.log('\n--- Full Content ---');
          console.log(bookmark.originalText || bookmark.text || 'No content');
          console.log('\n--- Key Value ---');
          console.log(bookmark.keyValue || 'N/A');
          console.log('');

          const answer2 = await prompt(rl, '[E]xport / [S]kip? ');
          if (answer2.toLowerCase() === 'e' || answer2 === '') {
            try {
              const result = await exportBookmark(bookmark, config, exportOptions);
              console.log(`Exported to ${result.filepath ?? 'unknown'}`);
              await recordDecision(bookmark, bookmark, 'export');
              if (result.exported) {
                exportedIds.add(bookmark.id);
              }
              exported++;
            } catch (error) {
              console.log(`  Error: ${error}`);
            }
          } else {
            await recordDecision(bookmark, bookmark, 'skip');
            skipped++;
          }
        } else if (answer.toLowerCase() === 'e' || answer === '') {
          try {
            const result = await exportBookmark(bookmark, config, exportOptions);
            console.log(`Exported to ${result.filepath ?? 'unknown'}`);
            await recordDecision(bookmark, bookmark, 'export');
            if (result.exported) {
              exportedIds.add(bookmark.id);
            }
            exported++;
          } catch (error) {
            console.log(`  Error: ${error}`);
          }
        } else if (answer.toLowerCase() === 's') {
          await recordDecision(bookmark, bookmark, 'skip');
          console.log('Skipped');
          skipped++;
        } else if (answer.toLowerCase() === 'q') {
          break;
        }
      }

      rl.close();

      console.log('');
      console.log('-'.repeat(60));
      console.log(`Review complete: ${exported} exported, ${skipped} skipped`);
      break;
    }

    case 'train': {
      console.log('Training preferences from your bookmarks...\n');

      const allBookmarks: ProcessedBookmark[] = [];
      const categories = ['try', 'review', 'knowledge', 'life', 'skip'];

      // Limit total items to prevent memory issues
      const perCategoryLimit = Math.ceil(MAX_TRAIN_ITEMS / categories.length);

      for (const cat of categories) {
        const items = await getRecentItems(cat, perCategoryLimit);
        allBookmarks.push(...items);
      }

      console.log(`Analyzing ${allBookmarks.length} bookmarks (limit: ${MAX_TRAIN_ITEMS})...`);

      const result = await initializeFromAnalysis(allBookmarks);

      console.log('\nPreferences initialized:');
      console.log(`  Trusted authors: ${result.trustedAuthors.join(', ') || 'none yet'}`);
      console.log(`  Interest topics: ${result.interestedTopics.slice(0, 10).join(', ')}`);

      console.log('\nThe system will continue learning from your export/skip decisions.');
      break;
    }

    case 'export': {
      const config = await loadConfig();

      if (!config.vaultPath) {
        console.log('Vault path not configured.');
        process.exit(1);
      }

      const exportOptions = {
        regenerate: parsed.flags.regenerate === true,
        validate: parsed.flags.validate === true,
      };

      const category = parsed.flags.category as string | undefined;
      const categories = category ? [category] : ['try', 'review', 'knowledge', 'life'];
      const allBookmarks: ProcessedBookmark[] = [];

      // Distribute limit across categories
      const perCategoryLimit = Math.ceil(MAX_EXPORT_ITEMS / categories.length);

      for (const cat of categories) {
        const items = await getRecentItems(cat, perCategoryLimit);
        allBookmarks.push(...items);
      }

      console.log(`Exporting ${allBookmarks.length} bookmarks${allBookmarks.length >= MAX_EXPORT_ITEMS ? ` (limited to ${MAX_EXPORT_ITEMS})` : ''}...`);

      const results = await exportBookmarks(allBookmarks, config, exportOptions);

      console.log(`\nExported: ${results.exported}`);
      console.log(`  Skipped: ${results.skipped}`);
      console.log(`  Errors: ${results.errors}`);

      await generateIndex(config);
      console.log('Updated index');
      break;
    }

    case 'index': {
      const config = await loadConfig();

      if (!config.vaultPath) {
        console.log('Vault path not configured.');
        process.exit(1);
      }

      const indexPath = await generateIndex(config);
      console.log(`Generated index: ${indexPath}`);
      break;
    }

    case 'stats': {
      const exportStats = await getExportStats();
      const prefSummary = await getPreferenceSummary();
      const dataSummary = await getSummary();

      console.log('\n=== Export Statistics ===');
      console.log(`Total exported to Obsidian: ${exportStats.totalExported}`);
      console.log(`Last export: ${exportStats.lastExport || 'never'}`);

      console.log('\n=== Learning Statistics ===');
      console.log(`Total reviewed: ${prefSummary.stats.totalReviewed}`);
      console.log(`Exported: ${prefSummary.stats.exported}`);
      console.log(`Skipped: ${prefSummary.stats.skipped}`);
      console.log(
        `Export rate: ${
          prefSummary.stats.totalReviewed > 0
            ? ((prefSummary.stats.exported / prefSummary.stats.totalReviewed) * 100).toFixed(1)
            : 0
        }%`
      );

      console.log('\n=== Data Summary ===');
      console.log(`Total processed: ${dataSummary.total}`);
      Object.entries(dataSummary.byAccount || {}).forEach(([acc, stats]) => {
        console.log(`  @${acc}: ${stats.total}`);
      });
      break;
    }

    case 'prefs': {
      const summary = await getPreferenceSummary();

      console.log('\n=== Learned Preferences ===\n');

      console.log('Trusted Authors:');
      if (summary.trustedAuthors.length > 0) {
        summary.trustedAuthors.forEach((a) => console.log(`  @${a}`));
      } else {
        console.log('  (none yet - system is still learning)');
      }

      console.log('\nBlocked Authors:');
      if (summary.blockedAuthors.length > 0) {
        summary.blockedAuthors.forEach((a) => console.log(`  @${a}`));
      } else {
        console.log('  (none)');
      }

      console.log('\nInterested Topics:');
      summary.interestedTopics.slice(0, 15).forEach((t) => console.log(`  ${t}`));

      console.log('\nLearned Interests (from your decisions):');
      if (summary.learnedInterests.length > 0) {
        summary.learnedInterests.slice(0, 10).forEach((t) => console.log(`  + ${t}`));
      } else {
        console.log('  (still learning...)');
      }

      console.log('\nExamples stored:');
      console.log(`  Exported: ${summary.exampleCount.exported}`);
      console.log(`  Skipped: ${summary.exampleCount.skipped}`);
      break;
    }

    case 'reset': {
      const rl = createRL();
      const answer = await prompt(rl, 'Reset all learned preferences? This cannot be undone. [y/N] ');
      rl.close();

      if (answer.toLowerCase() === 'y') {
        await resetLearning();
        console.log('Preferences reset');
      } else {
        console.log('Cancelled');
      }
      break;
    }

    default:
      console.log(`
Obsidian Integration CLI

Commands:
  config --vault <path>    Set Obsidian vault path
  config --folder <name>   Set bookmarks folder name (default: Bookmarks)

  sync                     Sync new bookmarks to Obsidian
                           - Auto-exports high-confidence items
                           - Prompts for uncertain items
                           - Learns from your decisions

  review                   Interactive review of all pending bookmarks

  train                    Initialize preferences from existing bookmarks

  export --all             Export all bookmarks (overwrite existing)
  export --category <cat>  Export specific category (try, review, knowledge)

  index                    Regenerate Dataview index

  stats                    Show export and learning statistics
  prefs                    Show learned preferences
  reset                    Reset learned preferences

Examples:
  node dist/obsidian.js config --vault ~/Obsidian/MyVault
  node dist/obsidian.js train
  node dist/obsidian.js sync
  node dist/obsidian.js review
  node dist/obsidian.js stats
      `);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
