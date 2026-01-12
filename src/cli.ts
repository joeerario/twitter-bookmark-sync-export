#!/usr/bin/env node
/**
 * General CLI
 *
 * Query and search processed bookmarks.
 */

import './env.js';

import { getRecentItems, getSummary, searchByTags } from './storage.js';

const command = process.argv[2];
const args = process.argv.slice(3);

async function main(): Promise<void> {
  switch (command) {
    case 'summary': {
      const account = args[0]?.replace(/^@/, '') || null;
      const summary = await getSummary(account);

      console.log('\nBookmark Summary');
      console.log('================');
      console.log(`Review:    ${summary.review}`);
      console.log(`Try:       ${summary.try}`);
      console.log(`Knowledge: ${summary.knowledge}`);
      console.log(`Skip:      ${summary.skip}`);
      console.log('-----------------');
      console.log(`Total:     ${summary.total}`);

      if (Object.keys(summary.byAccount).length > 0) {
        console.log('\nBy Account:');
        for (const [acc, stats] of Object.entries(summary.byAccount)) {
          console.log(
            `  @${acc}: ${stats.total} (R:${stats.review} T:${stats.try} K:${stats.knowledge} S:${stats.skip})`
          );
        }
      }
      break;
    }

    case 'list': {
      const category = args[0] || 'review';
      const limit = parseInt(args[1] || '10');
      const account = args[2]?.replace(/^@/, '') || null;

      const items = await getRecentItems(category, limit, account);

      const accountLabel = account ? ` for @${account}` : '';
      console.log(`\nRecent ${category} items${accountLabel} (${items.length}):`);
      console.log('='.repeat(50));

      for (const item of items) {
        console.log(`\n[@${item.account || 'unknown'}] [${item.priority?.toUpperCase() || 'N/A'}] ${item.summary}`);
        console.log(`  Tags: ${item.tags?.join(', ') || 'none'}`);
        console.log(`  Source: https://x.com/${item.author?.username}/status/${item.id}`);
        if (item.actionItems?.length) {
          console.log(`  Actions: ${item.actionItems.join('; ')}`);
        }
      }

      if (items.length === 0) {
        console.log('\nNo items found.');
      }
      break;
    }

    case 'search': {
      const tags = args.filter((a) => !a.startsWith('@'));
      const accountArg = args.find((a) => a.startsWith('@'));
      const account = accountArg ? accountArg.slice(1) : null;

      if (tags.length === 0) {
        console.log('Usage: node dist/cli.js search <tag1> [tag2] ... [@account]');
        break;
      }

      const results = await searchByTags(tags, account);

      console.log(`\nSearch results for: ${tags.join(', ')}${account ? ` (account: @${account})` : ''}`);
      console.log('='.repeat(50));

      for (const item of results) {
        console.log(`\n[@${item.account || 'unknown'}] ${item.summary}`);
        console.log(`  Tags: ${item.tags?.join(', ')}`);
        console.log(`  Source: ${item.source}`);
      }

      if (results.length === 0) {
        console.log('No results found.');
      }
      break;
    }

    default:
      console.log(`
Bookmark Automation CLI

Commands:
  summary [@account]             Show counts by category
  list [category] [n] [@account] List recent items (default: review, 10)
  search <tags...> [@account]    Search knowledge base by tags

Categories: review, try, knowledge, skip

Examples:
  node dist/cli.js summary
  node dist/cli.js summary @joept_
  node dist/cli.js list try 5
  node dist/cli.js list review 10 @mtnbeer00
  node dist/cli.js search ai tools
  node dist/cli.js search ai @joept_
      `);
  }
}

main().catch(console.error);
