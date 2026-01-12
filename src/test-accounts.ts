#!/usr/bin/env node
/**
 * Test Accounts CLI
 *
 * Test account setup and bookmark processing.
 */

import './env.js';

import { getEnabledAccounts } from './accounts.js';
import { getNewBookmarksForAccount, markAsProcessed } from './bookmark-fetcher.js';
import { categorizeBookmark } from './categorizer.js';
import { enrichBookmark } from './content-extractor.js';
import { addToKnowledgeBase, getSummary, saveProcessedBookmark } from './storage.js';

async function testAccounts(): Promise<void> {
  const accounts = await getEnabledAccounts();
  console.log(`Testing ${accounts.length} accounts...\n`);

  for (const acc of accounts) {
    console.log(`\n=== @${acc.username} ===`);

    const result = await getNewBookmarksForAccount(acc);

    if (!result.success) {
      console.log(`Error: ${result.error}`);
      continue;
    }

    console.log(`Found ${result.newCount} new bookmarks out of ${result.totalFetched}`);

    // Process first 2 bookmarks as a test
    const toProcess = result.bookmarks.slice(0, 2);
    const processedIds: string[] = [];

    for (const bm of toProcess) {
      console.log(`\nProcessing: ${bm.text.slice(0, 50)}...`);
      console.log(`  _account from bookmark: ${bm._account}`);

      const enriched = await enrichBookmark(bm);
      console.log(`  _account after enrich: ${enriched._account}`);

      const cat = await categorizeBookmark(enriched);
      console.log(`  Category: ${cat.category} | Priority: ${cat.priority}`);

      await saveProcessedBookmark(enriched, cat);

      if (cat.category === 'knowledge') {
        await addToKnowledgeBase(enriched, cat);
      }

      processedIds.push(bm.id);
    }

    if (processedIds.length > 0) {
      await markAsProcessed(acc.username, processedIds);
      console.log(`\nMarked ${processedIds.length} as processed`);
    }
  }

  const summary = await getSummary();
  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${summary.total}`);
  console.log('By account:', JSON.stringify(summary.byAccount, null, 2));
}

testAccounts().catch(console.error);
