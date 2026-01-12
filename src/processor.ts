/**
 * Processor
 *
 * Main processing pipeline for bookmarks.
 * Coordinates enrichment, categorization, and storage.
 */

import { getEnabledAccounts } from './accounts.js';
import { getNewBookmarksForAccount, markAsProcessed } from './bookmark-fetcher.js';
import { categorizeBookmark } from './categorizer.js';
import { config } from './config.js';
import { enrichBookmark, extractUrls } from './content-extractor.js';
import {
  clearFailure,
  clearRateLimit,
  isRateLimited,
  recordFailure,
  recordRateLimit,
  shouldSkipRetry,
} from './failure-handler.js';
import {
  addToReviewQueue,
  appendNarrativeAudit,
  getNarrativesForPrompt,
  normalizeLabel,
  upsertNarrativeFromAssignment,
} from './narrative-storage.js';
import { addToKnowledgeBase, getSummary, saveProcessedBookmark } from './storage.js';
import type {
  Account,
  Categorization,
  EnrichedBookmark,
  PollResult,
  ProcessAccountResult,
  ProcessBookmarkResult,
  RawBirdBookmark,
} from './types.js';
import { toErrorMessage } from './utils/errors.js';

const SUMMARY_INTERVAL_MS = Math.max(60_000, config.pollInterval * 5);
let lastSummaryAt = 0;

export interface PollOptions {
  dryRun?: boolean;
  accountFilter?: string[];
}

function getUrlHostname(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function shouldFilterBookmark(bookmark: RawBirdBookmark): { shouldSkip: boolean; reason?: string } {
  const text = bookmark.text?.trim() ?? '';
  const urls = extractUrls(bookmark);
  const minLength = config.filters.minTextLength;

  if (text.length < minLength && urls.length === 0) {
    return { shouldSkip: true, reason: `Text too short (${text.length} chars)` };
  }

  const normalized = text.toLowerCase();
  if (config.filters.spamPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) {
    return { shouldSkip: true, reason: 'Matches spam pattern' };
  }

  if (urls.length > 0 && text.length < minLength) {
    const blocked = urls.filter((url) => {
      const hostname = getUrlHostname(url);
      return hostname
        ? config.filters.blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
        : false;
    });

    if (blocked.length === urls.length) {
      return { shouldSkip: true, reason: 'Only blocked domains present' };
    }
  }

  return { shouldSkip: false };
}

/**
 * Extract keywords from enriched bookmark for narrative relevance scoring (R4.0).
 * Since tags come from LLM categorization, we extract keywords from available content:
 * - Content type indicators (video, github, podcast, etc.)
 * - Author username
 * - Key words from tweet text (simple extraction)
 */
function extractKeywordsFromContent(enriched: EnrichedBookmark): string[] {
  const keywords: string[] = [];

  // Add content type indicators
  if (enriched.hasVideo) keywords.push('video');
  if (enriched.hasPodcast) keywords.push('podcast');
  if (enriched.hasGithub) keywords.push('github', 'code', 'repository');
  if (enriched.hasArticle) keywords.push('article');
  if (enriched.hasImages) keywords.push('image');

  // Add author username as potential topic indicator
  if (enriched.author?.username) {
    keywords.push(normalizeLabel(enriched.author.username));
  }

  // Extract key words from text (simple: words > 4 chars, alphanumeric)
  const textWords = enriched.text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '') // Remove URLs
    .replace(/[^\w\s-]/g, ' ') // Remove special chars
    .split(/\s+/)
    .filter((word) => word.length > 4 && /^[a-z][a-z0-9-]*$/.test(word))
    .slice(0, 10); // Limit to 10 words

  keywords.push(...textWords);

  return [...new Set(keywords)]; // Dedupe
}

/**
 * Process a single bookmark through the full pipeline
 */
export async function processBookmark(
  bookmark: RawBirdBookmark,
  options?: { index?: number; total?: number; dryRun?: boolean }
): Promise<ProcessBookmarkResult> {
  const account = bookmark._account || 'unknown';
  const tweetId = bookmark.id;
  const progress = options?.index && options.total ? ` (${options.index}/${options.total})` : '';
  const isDryRun = options?.dryRun ?? false;
  console.log(`\n[@${account}]${progress} Processing: @${bookmark.author?.username}: ${(bookmark.text || '').slice(0, 50)}...`);

  // Check if this tweet should be skipped
  const skipCheck = await shouldSkipRetry(account, tweetId);
  if (skipCheck.shouldSkip) {
    console.log(`  [Skip] ${skipCheck.reason}`);
    return {
      success: false,
      error: skipCheck.reason,
      skipped: true,
      skipType: skipCheck.skipType,
    };
  }

  const filterCheck = shouldFilterBookmark(bookmark);
  if (filterCheck.shouldSkip) {
    console.log(`  [Filtered] ${filterCheck.reason}`);
    if (!isDryRun) {
      await clearFailure(account, tweetId);
    }
    return {
      success: false,
      error: filterCheck.reason,
      skipped: true,
      skipType: 'filtered',
    };
  }

  try {
    // Step 1: Enrich with transcripts/articles
    console.log('  Enriching content...');
    const enriched = await enrichBookmark(bookmark);

    // Step 2: Fetch existing narratives for context (R4.0: include content keywords)
    const bookmarkTags = extractKeywordsFromContent(enriched);
    const existingNarratives = await getNarrativesForPrompt({ topK: 10, topRecent: 5, bookmarkTags });

    // Step 3: Categorize with AI (passing narratives for context)
    console.log('  Categorizing with AI...');
    const categorization = await categorizeBookmark(enriched, existingNarratives);

    console.log(`  Category: ${categorization.category} | Priority: ${categorization.priority}`);
    console.log(`  Summary: ${categorization.summary}`);

    // Step 4: Handle narrative assignment (R4.1)
    if (categorization.narrativeId !== undefined || categorization.narrativeLabel) {
      // Non-low confidence: upsert to narrative index
      const upsertResult = await upsertNarrativeFromAssignment(tweetId, categorization);
      if (upsertResult) {
        // Update categorization with resolved narrative info
        categorization.narrativeId = upsertResult.narrativeId;
        categorization.narrativeLabel = upsertResult.narrativeLabel;
        console.log(`  Narrative: ${upsertResult.narrativeLabel}${upsertResult.created ? ' (new)' : ''}`);
      } else {
        // Clear narrative fields when upsert fails to prevent persisting invalid IDs
        delete categorization.narrativeId;
        delete categorization.narrativeLabel;
        delete categorization.narrativeConfidence;
        console.log('  Narrative: cleared (upsert returned null)');
      }
    }

    // Step 4b: Handle low-confidence candidates - add to review queue (R4.1)
    if (categorization.narrativeCandidateId || categorization.narrativeCandidateLabel) {
      console.log(
        `  Narrative candidate (low confidence): ${categorization.narrativeCandidateLabel || categorization.narrativeCandidateId}`
      );
      // Add to review queue for manual review
      await addToReviewQueue({
        bookmarkId: tweetId,
        candidateId: categorization.narrativeCandidateId,
        candidateLabel: categorization.narrativeCandidateLabel,
      });
    }

    // Step 4c: Append to audit log (R4.2)
    await appendNarrativeAudit({
      timestamp: new Date().toISOString(),
      bookmarkId: tweetId,
      candidatesPresented: existingNarratives.map((n) => ({ id: n.id, label: n.label })),
      decision: {
        narrativeId: categorization.narrativeId ?? null,
        narrativeLabel: categorization.narrativeLabel,
        narrativeConfidence: categorization.narrativeConfidence ?? 'medium',
      },
      ...(categorization.narrativeCandidateId || categorization.narrativeCandidateLabel
        ? {
            lowConfidenceCandidate: {
              id: categorization.narrativeCandidateId,
              label: categorization.narrativeCandidateLabel,
            },
          }
        : {}),
    });

    if (isDryRun) {
      console.log('  [Dry Run] Skipping persistence.');
      return { success: true, enriched, categorization };
    }

    // Step 5: Save to appropriate location
    await saveProcessedBookmark(enriched, categorization);

    // Step 6: If knowledge category, add to knowledge base
    if (categorization.category === 'knowledge') {
      await addToKnowledgeBase(enriched, categorization);
    }

    // Step 7: Clear any previous failure record
    await clearFailure(account, tweetId);

    return { success: true, enriched, categorization };
  } catch (e) {
    const errorMessage = toErrorMessage(e);
    console.error(`  Error: ${errorMessage}`);

    if (isDryRun) {
      return { success: false, error: errorMessage };
    }

    // Record the failure
    const { isPoisonPill: nowPoisonPill, attempts } = await recordFailure(
      account,
      tweetId,
      'processing_error',
      errorMessage
    );

    // Save failed items with category 'review' for manual handling
    if (nowPoisonPill && config.failure.saveFailedAsReview) {
      try {
        const fallbackFormat =
          bookmark.inReplyToStatusId
            ? 'reply'
            : bookmark.conversationId && bookmark.conversationId !== bookmark.id
              ? 'thread'
              : bookmark.media && bookmark.media.length > 0
                ? 'image'
                : bookmark.text?.includes('http')
                  ? 'link'
                  : 'tweet';

        const fallbackCategorization: Categorization = {
          category: 'review',
          contentType: 'other',
          contentFormat: fallbackFormat,
          summary: `Failed after ${attempts} attempts: ${errorMessage.slice(0, 50)}`,
          keyValue: 'Processing failed - needs manual review',
          quotes: [],
          tags: ['needs-manual', 'processing-failed'],
          actionItems: ['Review this bookmark manually'],
          priority: 'low',
        };

        // Create a minimal enriched bookmark for saving
        const minimalEnriched: EnrichedBookmark = {
          tweetId: bookmark.id,
          id: bookmark.id,
          text: bookmark.text,
          author: bookmark.author,
          createdAt: bookmark.createdAt,
          likeCount: bookmark.likeCount ?? 0,
          retweetCount: bookmark.retweetCount ?? 0,
          replyCount: bookmark.replyCount ?? 0,
          urls: [],
          isReply: false,
          isPartOfThread: false,
          transcripts: [],
          articles: [],
          _account: account,
        };

        await saveProcessedBookmark(minimalEnriched, fallbackCategorization);
        console.log(`  Saved as 'review' with needs-manual tag`);
      } catch (saveError) {
        console.error(`  Failed to save fallback: ${toErrorMessage(saveError)}`);
      }
    }

    return { success: false, error: errorMessage, attempts };
  }
}

/**
 * Process bookmarks for a single account
 */
async function processAccountBookmarks(account: Account, options: PollOptions): Promise<ProcessAccountResult> {
  const isDryRun = options.dryRun ?? false;
  console.log(`\n--- Processing @${account.username} ---`);

  // Check if account is rate limited
  const rateLimitStatus = await isRateLimited(account.username);
  if (rateLimitStatus.isLimited) {
    const remainingSec = Math.round(rateLimitStatus.remainingMs / 1000);
    console.log(`[@${account.username}] Rate limited, skipping (${remainingSec}s remaining)`);
    return {
      account: account.username,
      success: false,
      error: `Rate limited for ${remainingSec}s`,
      rateLimited: true,
      processed: 0,
    };
  }

  const result = await getNewBookmarksForAccount(account);

  if (!result.success) {
    console.error(`[@${account.username}] Error: ${result.error}`);

    if (result.errorType === 'rate_limit') {
      const backoff = await recordRateLimit(account.username);
      return {
        account: account.username,
        success: false,
        error: result.error,
        errorType: result.errorType,
        rateLimited: true,
        nextAllowedAt: backoff.nextAllowedPollAt ?? undefined,
        processed: 0,
      };
    }

    return {
      account: account.username,
      success: false,
      error: result.error,
      errorType: result.errorType,
      processed: 0,
    };
  }

  // Clear rate limit on successful fetch
  await clearRateLimit(account.username);

  if (result.bookmarks.length === 0) {
    console.log(`[@${account.username}] No new bookmarks`);
    return {
      account: account.username,
      success: true,
      processed: 0,
      fetched: result.totalFetched,
    };
  }

  console.log(`[@${account.username}] Found ${result.newCount} new bookmark(s) out of ${result.totalFetched}`);

  const processedIds: string[] = [];
  let successCount = 0;
  let errorCount = 0;
  let skippedPoisonPills = 0;
  let skippedBackoff = 0;
  let skippedFiltered = 0;

  const totalToProcess = result.bookmarks.length;
  let processedIndex = 0;

  for (const bookmark of result.bookmarks) {
    processedIndex += 1;
    const processResult = await processBookmark(bookmark, {
      index: processedIndex,
      total: totalToProcess,
      dryRun: isDryRun,
    });

    if (processResult.success) {
      processedIds.push(bookmark.id);
      successCount++;
    } else if (processResult.skipped) {
      if (processResult.skipType === 'poison_pill') {
        processedIds.push(bookmark.id);
        skippedPoisonPills++;
      } else if (processResult.skipType === 'filtered') {
        processedIds.push(bookmark.id);
        skippedFiltered++;
      } else {
        skippedBackoff++;
      }
    } else {
      errorCount++;
    }
  }

  // Mark processed bookmarks (and poison pills)
  if (!isDryRun && processedIds.length > 0) {
    await markAsProcessed(account.username, processedIds);
  }

  return {
    account: account.username,
    success: true,
    processed: successCount,
    skippedPoisonPills,
    skippedBackoff,
    skippedFiltered,
    errors: errorCount,
    fetched: result.totalFetched,
  };
}

/**
 * Main polling loop - processes all enabled accounts once
 */
export async function pollOnce(options: PollOptions = {}): Promise<PollResult> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Polling at ${new Date().toISOString()}`);
  console.log('='.repeat(70));
  if (options.dryRun) {
    console.log('[Dry Run] No files will be written or marked as processed.');
  }

  const accounts = await getEnabledAccounts();
  const filterSet = options.accountFilter?.length
    ? new Set(options.accountFilter.map((name) => name.replace('@', '').toLowerCase()))
    : null;
  const filteredAccounts = filterSet
    ? accounts.filter((account) => filterSet.has(account.username.toLowerCase()))
    : accounts;

  if (filteredAccounts.length === 0) {
    console.log(filterSet ? 'No matching enabled accounts found for filter.' : 'No enabled accounts found. Add accounts first.');
    return { success: false, results: [] };
  }

  console.log(`Processing ${filteredAccounts.length} account(s): ${filteredAccounts.map((a) => '@' + a.username).join(', ')}`);

  const results: ProcessAccountResult[] = [];

  // Process accounts sequentially
  for (const account of filteredAccounts) {
    try {
      const result = await processAccountBookmarks(account, options);
      results.push(result);

      // Delay between accounts
      if (filteredAccounts.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (e) {
      console.error(`[@${account.username}] Unexpected error: ${toErrorMessage(e)}`);
      results.push({
        account: account.username,
        success: false,
        error: toErrorMessage(e),
        processed: 0,
      });
    }
  }

  // Summary
  console.log('\n--- Poll Summary ---');
  for (const r of results) {
    if (r.success) {
      const parts = [`${r.processed} processed`, `${r.fetched} fetched`];
      if (r.skippedBackoff && r.skippedBackoff > 0) parts.push(`${r.skippedBackoff} in backoff`);
      if (r.skippedPoisonPills && r.skippedPoisonPills > 0) parts.push(`${r.skippedPoisonPills} poison pills`);
      if (r.skippedFiltered && r.skippedFiltered > 0) parts.push(`${r.skippedFiltered} filtered`);
      if (r.errors && r.errors > 0) parts.push(`${r.errors} errors`);
      console.log(`@${r.account}: ${parts.join(', ')}`);
    } else {
      console.log(`@${r.account}: ERROR - ${r.error}`);
    }
  }

  const now = Date.now();
  if (now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    const summary = await getSummary();
    console.log('\nTotal across all accounts:');
    console.log(
      `  Review: ${summary.review} | Try: ${summary.try} | Knowledge: ${summary.knowledge} | Skip: ${summary.skip}`
    );
    console.log(`  Total: ${summary.total}`);

    if (Object.keys(summary.byAccount).length > 1) {
      console.log('\nBy account:');
      for (const [acc, stats] of Object.entries(summary.byAccount)) {
        console.log(`  @${acc}: ${stats.total} (R:${stats.review} T:${stats.try} K:${stats.knowledge} S:${stats.skip})`);
      }
    }

    lastSummaryAt = now;
  }

  // Success means all accounts either succeeded or were rate-limited (expected condition)
  const success = results.every((r) => r.success || r.rateLimited);
  return { success, results };
}
