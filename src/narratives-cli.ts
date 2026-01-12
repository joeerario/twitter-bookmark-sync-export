#!/usr/bin/env node
/**
 * Narratives CLI
 *
 * Commands for managing narrative assignments and the narrative index.
 */

import './env.js';

import { existsSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { categorizeBookmark } from './categorizer.js';
import {
  addToReviewQueue,
  appendNarrativeAudit,
  getNarrativeDir,
  getNarrativesForPrompt,
  getProcessedDir,
  loadNarrativeIndex,
  loadReviewQueue,
  mergeNarratives,
  normalizeLabel,
  rebuildNarrativeIndex,
  renameNarrative,
  updateNarrativeSummary,
  upsertNarrativeFromAssignment,
} from './narrative-storage.js';
import type { EnrichedBookmark, ProcessedBookmark } from './types.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

const command = process.argv[2];
const args = process.argv.slice(3);

/**
 * Extract keywords from enriched bookmark for narrative relevance scoring (R4.0).
 */
function extractKeywordsFromEnriched(enriched: EnrichedBookmark): string[] {
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
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 4 && /^[a-z][a-z0-9-]*$/.test(word))
    .slice(0, 10);

  keywords.push(...textWords);

  return [...new Set(keywords)];
}

interface BackfillState {
  lastProcessedId: string | null;
  processedCount: number;
  startedAt: string;
}

interface BackfillOptions {
  limit: number | null;
  since: string | null;
  resume: boolean;
  dryRun: boolean;
}

function parseBackfillArgs(argv: string[]): BackfillOptions {
  const result: BackfillOptions = {
    limit: null,
    since: null,
    resume: true,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit' && argv[i + 1]) {
      result.limit = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--since' && argv[i + 1]) {
      result.since = argv[i + 1];
      i++;
    } else if (arg === '--resume') {
      result.resume = true;
    } else if (arg === '--no-resume') {
      result.resume = false;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    }
  }

  return result;
}

function getBackfillStatePath(): string {
  return path.join(getNarrativeDir(), 'backfill-state.json');
}

async function loadBackfillState(): Promise<BackfillState | null> {
  return readJsonSafe<BackfillState | null>(getBackfillStatePath(), null);
}

async function saveBackfillState(state: BackfillState): Promise<void> {
  await writeJsonAtomic(getBackfillStatePath(), state);
}

interface BookmarkFileInfo {
  filepath: string;
  id: string;
  mtimeMs: number;
  processedAt?: string; // from file content
  createdAt?: string; // from file content (fallback for ordering)
}

/**
 * Scan all processed bookmarks in stable order (processedAt + filepath)
 */
async function scanProcessedBookmarks(): Promise<BookmarkFileInfo[]> {
  const processedDir = getProcessedDir();
  const files: BookmarkFileInfo[] = [];

  if (!existsSync(processedDir)) {
    return files;
  }

  const accounts = await readdir(processedDir);

  for (const account of accounts) {
    const accountDir = path.join(processedDir, account);
    const accountStats = await stat(accountDir);
    if (!accountStats.isDirectory()) continue;

    const categories = await readdir(accountDir);
    for (const category of categories) {
      const categoryDir = path.join(accountDir, category);
      try {
        const categoryStats = await stat(categoryDir);
        if (!categoryStats.isDirectory()) continue;

        const jsonFiles = (await readdir(categoryDir)).filter((f) => f.endsWith('.json'));
        for (const file of jsonFiles) {
          const filepath = path.join(categoryDir, file);
          const fileStats = await stat(filepath);
          const id = path.basename(file, '.json');

          // Read file content to extract processedAt and createdAt for stable ordering
          let processedAt: string | undefined;
          let createdAt: string | undefined;
          try {
            const content = JSON.parse(await readFile(filepath, 'utf-8')) as ProcessedBookmark;
            processedAt = content.processedAt;
            createdAt = content.createdAt;
          } catch {
            // Fall back to mtime if file content can't be read
          }

          files.push({ filepath, id, mtimeMs: fileStats.mtimeMs, processedAt, createdAt });
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  // Sort by processedAt (primary) with filepath tie-breaker for deterministic order
  return files.sort((a, b) => {
    const timeA = a.processedAt ? new Date(a.processedAt).getTime() : a.mtimeMs;
    const timeB = b.processedAt ? new Date(b.processedAt).getTime() : b.mtimeMs;
    const timeCmp = timeA - timeB;
    if (timeCmp !== 0) return timeCmp;
    return a.filepath.localeCompare(b.filepath);
  });
}

/**
 * Convert ProcessedBookmark to EnrichedBookmark for categorization
 */
function processedToEnriched(bookmark: ProcessedBookmark): EnrichedBookmark {
  return {
    tweetId: bookmark.id,
    id: bookmark.id,
    text: bookmark.text || bookmark.originalText,
    author: bookmark.author,
    createdAt: bookmark.createdAt,
    likeCount: bookmark.likeCount ?? 0,
    retweetCount: bookmark.retweetCount ?? 0,
    replyCount: bookmark.replyCount ?? 0,
    urls: bookmark.urls ?? [],
    isReply: bookmark.isReply ?? false,
    isPartOfThread: bookmark.isPartOfThread ?? false,
    conversationId: bookmark.conversationId,
    inReplyToStatusId: bookmark.inReplyToStatusId,
    threadContext: bookmark.threadContext,
    transcripts: bookmark.transcripts ?? [],
    articles: bookmark.articles ?? [],
    _account: bookmark.account,
  };
}

async function runBackfill(options: BackfillOptions): Promise<void> {
  console.log('\n=== Narratives Backfill ===');
  console.log(`Options: limit=${options.limit ?? 'none'}, since=${options.since ?? 'all'}, resume=${options.resume}`);
  if (options.dryRun) {
    console.log('[Dry Run] No files will be modified.');
  }

  // Load or initialize state
  let state: BackfillState | null = null;
  if (options.resume) {
    state = await loadBackfillState();
    if (state) {
      console.log(`Resuming from previous run (processed ${state.processedCount} bookmarks)`);
    }
  }

  if (!state) {
    state = {
      lastProcessedId: null,
      processedCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  // Scan all bookmarks
  console.log('Scanning processed bookmarks...');
  const allFiles = await scanProcessedBookmarks();
  console.log(`Found ${allFiles.length} processed bookmarks`);

  // Filter to find starting point if resuming
  let startIndex = 0;
  if (state.lastProcessedId) {
    const lastIndex = allFiles.findIndex((f) => f.id === state!.lastProcessedId);
    if (lastIndex >= 0) {
      startIndex = lastIndex + 1;
      console.log(`Resuming after bookmark ${state.lastProcessedId} (index ${startIndex})`);
    }
  }

  // Filter by --since date if specified (uses processedAt for consistency with ordering)
  let filesToProcess = allFiles.slice(startIndex);
  if (options.since) {
    const sinceMs = new Date(options.since).getTime();
    filesToProcess = filesToProcess.filter((f) => {
      const timestamp = f.processedAt ? new Date(f.processedAt).getTime() : f.mtimeMs;
      return timestamp >= sinceMs;
    });
    console.log(`Filtered to ${filesToProcess.length} bookmarks since ${options.since}`);
  }

  // Apply limit
  if (options.limit && options.limit > 0) {
    filesToProcess = filesToProcess.slice(0, options.limit);
  }

  console.log(`Processing ${filesToProcess.length} bookmarks...`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < filesToProcess.length; i++) {
    const { filepath, id } = filesToProcess[i];

    try {
      // Read the bookmark
      const content = await readFile(filepath, 'utf-8');
      const bookmark = JSON.parse(content) as ProcessedBookmark;

      // Skip if already has narrative assignment
      if (bookmark.narrativeId !== undefined) {
        skipped++;
        continue;
      }

      console.log(`\n[${i + 1}/${filesToProcess.length}] Processing ${id}...`);

      if (!options.dryRun) {
        // Convert to enriched format first (for keyword extraction)
        const enriched = processedToEnriched(bookmark);

        // Get existing narratives for context (R4.0: include content keywords)
        const bookmarkTags = extractKeywordsFromEnriched(enriched);
        const existingNarratives = await getNarrativesForPrompt({ topK: 10, topRecent: 5, bookmarkTags });

        // Re-categorize with narrative context
        const categorization = await categorizeBookmark(enriched, existingNarratives);

        // Handle narrative assignment (R5.1: parity with pipeline)
        if (categorization.narrativeId !== undefined || categorization.narrativeLabel) {
          // Non-low confidence: upsert to narrative index
          const upsertResult = await upsertNarrativeFromAssignment(id, categorization);
          if (upsertResult) {
            categorization.narrativeId = upsertResult.narrativeId;
            categorization.narrativeLabel = upsertResult.narrativeLabel;
            console.log(`  Narrative: ${upsertResult.narrativeLabel}${upsertResult.created ? ' (new)' : ''}`);
          }
        }

        // Handle low-confidence candidates - add to review queue (R5.1)
        if (categorization.narrativeCandidateId || categorization.narrativeCandidateLabel) {
          console.log(
            `  Narrative candidate (low confidence): ${categorization.narrativeCandidateLabel || categorization.narrativeCandidateId}`
          );
          await addToReviewQueue({
            bookmarkId: id,
            candidateId: categorization.narrativeCandidateId,
            candidateLabel: categorization.narrativeCandidateLabel,
          });
        }

        // Append to audit log (R5.1)
        await appendNarrativeAudit({
          timestamp: new Date().toISOString(),
          bookmarkId: id,
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

        // Update the bookmark file with narrative/candidate fields (R5.1)
        const updatedBookmark: ProcessedBookmark = {
          ...bookmark,
          // Clear stale null values
          narrativeId: categorization.narrativeId ?? undefined,
          narrativeLabel: categorization.narrativeLabel,
          narrativeConfidence: categorization.narrativeConfidence,
          // Include candidate fields if present
          ...(categorization.narrativeCandidateId && { narrativeCandidateId: categorization.narrativeCandidateId }),
          ...(categorization.narrativeCandidateLabel && { narrativeCandidateLabel: categorization.narrativeCandidateLabel }),
        };

        await writeJsonAtomic(filepath, updatedBookmark);
      } else {
        console.log(`  [Dry Run] Would re-categorize and update`);
      }

      processed++;
      state.lastProcessedId = id;
      state.processedCount++;

      // Save state every 10 bookmarks
      if (!options.dryRun && processed % 10 === 0) {
        await saveBackfillState(state);
        console.log(`  [State saved: ${state.processedCount} total processed]`);
      }

      // Delay between LLM calls (500ms)
      if (!options.dryRun && i < filesToProcess.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`  Error processing ${id}:`, error instanceof Error ? error.message : error);
      errors++;
    }
  }

  // Final state save
  if (!options.dryRun && processed > 0) {
    await saveBackfillState(state);
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`Processed: ${processed}`);
  console.log(`Skipped (already assigned): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total in state: ${state.processedCount}`);
}

async function showNarrativesSummary(): Promise<void> {
  const index = await loadNarrativeIndex();
  const narratives = Object.values(index.narratives);
  const active = narratives.filter((n) => n.status === 'active');
  const merged = narratives.filter((n) => n.status === 'merged');

  console.log('\nNarratives Summary');
  console.log('==================');
  console.log(`Active narratives: ${active.length}`);
  console.log(`Merged narratives: ${merged.length}`);
  console.log(`Total: ${narratives.length}`);

  if (active.length > 0) {
    console.log('\nTop narratives by bookmark count:');
    const sorted = [...active].sort((a, b) => b.bookmarkCount - a.bookmarkCount).slice(0, 10);
    for (const n of sorted) {
      console.log(`  [${n.bookmarkCount}] ${n.label}`);
    }
  }
}

interface ListOptions {
  sort: 'updated' | 'count' | 'created';
  limit: number;
}

function parseListArgs(argv: string[]): ListOptions {
  const result: ListOptions = { sort: 'updated', limit: 50 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sort' && argv[i + 1]) {
      const sortValue = argv[i + 1];
      if (sortValue === 'updated' || sortValue === 'count' || sortValue === 'created') {
        result.sort = sortValue;
      }
      i++;
    } else if (arg === '--limit' && argv[i + 1]) {
      result.limit = parseInt(argv[i + 1], 10);
      i++;
    }
  }

  return result;
}

async function runRebuildIndex(): Promise<void> {
  console.log('\n=== Rebuilding Narrative Index ===');
  console.log('Scanning processed bookmarks...');

  const newIndex = await rebuildNarrativeIndex();

  console.log('\nRebuild Complete:');
  console.log(`  Narratives: ${Object.keys(newIndex.narratives).length}`);
  console.log(`  Version: ${newIndex.version}`);
}

async function runListNarratives(options: ListOptions): Promise<void> {
  const index = await loadNarrativeIndex();
  const narratives = Object.values(index.narratives).filter((n) => n.status === 'active');

  // Sort
  let sorted = [...narratives];
  switch (options.sort) {
    case 'updated':
      sorted.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
      break;
    case 'count':
      sorted.sort((a, b) => b.bookmarkCount - a.bookmarkCount);
      break;
    case 'created':
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      break;
  }

  // Limit
  sorted = sorted.slice(0, options.limit);

  console.log(`\nNarratives (sorted by ${options.sort}, limit ${options.limit}):`);
  console.log('='.repeat(60));

  for (const n of sorted) {
    const date = options.sort === 'created' ? n.createdAt : n.lastUpdatedAt;
    console.log(`\n  ${n.id}`);
    console.log(`    Label: ${n.label}`);
    console.log(`    Count: ${n.bookmarkCount} | Updated: ${date.slice(0, 10)}`);
    if (n.currentSummary) {
      console.log(`    Summary: ${n.currentSummary.slice(0, 80)}...`);
    }
  }

  console.log(`\nTotal: ${sorted.length} / ${narratives.length} active narratives`);
}

async function runShowNarrative(narrativeId: string): Promise<void> {
  const index = await loadNarrativeIndex();
  const narrative = index.narratives[narrativeId];

  if (!narrative) {
    console.error(`Narrative not found: ${narrativeId}`);
    process.exit(1);
  }

  console.log('\nNarrative Details');
  console.log('=================');
  console.log(`ID:         ${narrative.id}`);
  console.log(`Label:      ${narrative.label}`);
  console.log(`Slug:       ${narrative.slug}`);
  console.log(`Status:     ${narrative.status}`);
  if (narrative.mergedInto) {
    console.log(`Merged Into: ${narrative.mergedInto}`);
  }
  console.log(`Count:      ${narrative.bookmarkCount}`);
  console.log(`Created:    ${narrative.createdAt}`);
  console.log(`Updated:    ${narrative.lastUpdatedAt}`);
  if (narrative.lastSummaryUpdatedAt) {
    console.log(`Summary Updated: ${narrative.lastSummaryUpdatedAt}`);
  }
  console.log(`\nNormalized: ${narrative.normalizedLabel}`);
  if (narrative.aliases.length > 0) {
    console.log(`Aliases:    ${narrative.aliases.join(', ')}`);
  }
  console.log(`\nRecent Bookmark IDs (${narrative.recentBookmarkIds.length}):`);
  for (const id of narrative.recentBookmarkIds.slice(0, 10)) {
    console.log(`  - ${id}`);
  }
  if (narrative.recentBookmarkIds.length > 10) {
    console.log(`  ... and ${narrative.recentBookmarkIds.length - 10} more`);
  }
  console.log('\nSummary:');
  console.log(`  ${narrative.currentSummary || '(none)'}`);
}

async function runMergeNarratives(fromId: string, toId: string): Promise<void> {
  console.log(`\nMerging narrative: ${fromId} -> ${toId}`);

  await mergeNarratives(fromId, toId);

  console.log('Merge complete.');
  console.log(`  ${fromId} is now marked as "merged"`);
  console.log(`  Future references will redirect to ${toId}`);
}

async function runRenameNarrative(narrativeId: string, newLabel: string): Promise<void> {
  console.log(`\nRenaming narrative: ${narrativeId}`);
  console.log(`  New label: ${newLabel}`);

  await renameNarrative(narrativeId, newLabel);

  console.log('Rename complete.');
}

async function runReviewQueue(): Promise<void> {
  const queue = await loadReviewQueue();

  console.log('\nLow-Confidence Review Queue');
  console.log('===========================');

  if (queue.entries.length === 0) {
    console.log('\nNo items in the review queue.');
    return;
  }

  console.log(`\nTotal: ${queue.entries.length} items`);
  console.log('');

  for (const entry of queue.entries.slice(0, 20)) {
    console.log(`  Bookmark: ${entry.bookmarkId}`);
    console.log(`    Candidate: ${entry.candidateLabel || 'unknown'}`);
    if (entry.candidateId) {
      console.log(`    Candidate ID: ${entry.candidateId}`);
    }
    console.log(`    Added: ${entry.addedAt}`);
    console.log('');
  }

  if (queue.entries.length > 20) {
    console.log(`  ... and ${queue.entries.length - 20} more items`);
  }
}

interface RefreshOptions {
  limit: number | null;
  dryRun: boolean;
}

function parseRefreshArgs(argv: string[]): RefreshOptions {
  const result: RefreshOptions = { limit: null, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit' && argv[i + 1]) {
      result.limit = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    }
  }

  return result;
}

async function runRefreshSummaries(options: RefreshOptions): Promise<void> {
  // Import shared LLM config and client (R5.3)
  const { getClient } = await import('./categorizer.js');
  const { config } = await import('./config.js');
  const client = await getClient();

  console.log('\n=== Refreshing Narrative Summaries ===');
  if (options.dryRun) {
    console.log('[Dry Run] No changes will be made.');
  }

  const index = await loadNarrativeIndex();
  const narratives = Object.values(index.narratives)
    .filter((n) => n.status === 'active')
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount);

  const toProcess = options.limit ? narratives.slice(0, options.limit) : narratives;
  console.log(`Processing ${toProcess.length} narratives...`);

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const narrative = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${narrative.label}`);

    // Get recent bookmarks for context
    const recentIds = narrative.recentBookmarkIds.slice(0, 10);
    if (recentIds.length === 0) {
      console.log('  Skipping: no recent bookmarks');
      continue;
    }

    // Load bookmark content
    const bookmarkTexts: string[] = [];
    for (const bookmarkId of recentIds) {
      // Search for the bookmark file
      const processedDir = getProcessedDir();
      if (existsSync(processedDir)) {
        try {
          const accounts = await readdir(processedDir);
          for (const account of accounts) {
            const accountDir = path.join(processedDir, account);
            const categories = await readdir(accountDir);
            for (const category of categories) {
              const filepath = path.join(accountDir, category, `${bookmarkId}.json`);
              if (existsSync(filepath)) {
                const content = await readFile(filepath, 'utf-8');
                const bookmark = JSON.parse(content) as ProcessedBookmark;
                if (bookmark.text || bookmark.originalText) {
                  bookmarkTexts.push(bookmark.text || bookmark.originalText || '');
                }
              }
            }
          }
        } catch {
          // Skip errors
        }
      }
    }

    if (bookmarkTexts.length === 0) {
      console.log('  Skipping: no bookmark content found');
      continue;
    }

    try {
      if (!options.dryRun) {
        // Generate summary using Claude
        const prompt = `Based on the following ${bookmarkTexts.length} bookmark(s) about "${narrative.label}", write a 2-3 sentence summary that captures the key themes and insights.

Bookmarks:
${bookmarkTexts.map((text, idx) => `${idx + 1}. ${text.slice(0, 500)}`).join('\n\n')}

Summary:`;

        const response = await client.messages.create({
          model: config.llm.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        });

        const summary =
          response.content[0].type === 'text'
            ? response.content[0].text.trim()
            : '';

        if (summary) {
          await updateNarrativeSummary(narrative.id, summary);
          console.log(`  Summary: ${summary.slice(0, 80)}...`);
          updated++;
        }

        // Rate limit delay
        if (i < toProcess.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } else {
        console.log(`  [Dry Run] Would generate summary from ${bookmarkTexts.length} bookmarks`);
        updated++;
      }
    } catch (error) {
      console.error(`  Error: ${error instanceof Error ? error.message : error}`);
      errors++;
    }
  }

  console.log('\n=== Refresh Complete ===');
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
}

async function runExportObsidian(): Promise<void> {
  const { mkdir: mkdirFn, writeFile: writeFileFn } = await import('fs/promises');

  console.log('\n=== Exporting Narratives to Obsidian ===');

  const index = await loadNarrativeIndex();
  const narratives = Object.values(index.narratives)
    .filter((n) => n.status === 'active')
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount);

  const outputDir = path.join(getNarrativeDir(), 'obsidian');
  await mkdirFn(outputDir, { recursive: true });

  const lines: string[] = [
    '# Narratives',
    '',
    `> Generated at ${new Date().toISOString()}`,
    '',
    `Total: ${narratives.length} active narratives`,
    '',
    '---',
    '',
  ];

  for (const n of narratives.slice(0, 50)) {
    lines.push(`## ${n.label}`);
    lines.push('');
    lines.push(`**ID:** \`${n.id}\``);
    lines.push(`**Bookmarks:** ${n.bookmarkCount}`);
    lines.push(`**Last Updated:** ${n.lastUpdatedAt.slice(0, 10)}`);
    lines.push('');

    if (n.currentSummary) {
      lines.push(`### Summary`);
      lines.push('');
      lines.push(n.currentSummary);
      lines.push('');
    }

    if (n.recentBookmarkIds.length > 0) {
      lines.push(`### Recent Bookmarks`);
      lines.push('');
      for (const id of n.recentBookmarkIds.slice(0, 5)) {
        lines.push(`- [[${id}]]`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  const outputPath = path.join(outputDir, 'narratives.md');
  await writeFileFn(outputPath, lines.join('\n'));

  console.log(`Exported to ${outputPath}`);
  console.log(`  ${narratives.length} narratives written`);
}

/**
 * Normalize a tag for consistent heatmap aggregation.
 * Follows documented order: lowercase → trim → collapse whitespace → strip punctuation
 */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '') // Remove all punctuation (keeps word chars and whitespace)
    .replace(/_/g, ''); // Also strip underscores for consistent tag matching
}

/**
 * Get ISO week string (YYYY-Www)
 */
function getIsoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

interface TagMapConfig {
  mappings: Record<string, string>;
}

async function loadTagMap(): Promise<TagMapConfig> {
  const tagMapPath = path.join(getNarrativeDir(), 'tag-map.json');
  return readJsonSafe<TagMapConfig>(tagMapPath, { mappings: {} });
}

function applyTagMapping(tag: string, tagMap: TagMapConfig): string {
  const normalized = normalizeTag(tag);
  return tagMap.mappings[normalized] ?? normalized;
}

/**
 * Generate a report of top raw tags for manual tag-map seeding (R6.1)
 */
async function generateRawTagsReport(limit: number = 50): Promise<{ rawTag: string; normalized: string; count: number }[]> {
  const processedDir = getProcessedDir();
  const rawTagCounts: Record<string, { raw: string; count: number }> = {};

  if (!existsSync(processedDir)) {
    return [];
  }

  const accounts = await readdir(processedDir);

  for (const account of accounts) {
    const accountDir = path.join(processedDir, account);
    try {
      const accountStats = await stat(accountDir);
      if (!accountStats.isDirectory()) continue;

      const categories = await readdir(accountDir);
      for (const category of categories) {
        const categoryDir = path.join(accountDir, category);
        try {
          const categoryStats = await stat(categoryDir);
          if (!categoryStats.isDirectory()) continue;

          const files = (await readdir(categoryDir)).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            try {
              const content = await readFile(path.join(categoryDir, file), 'utf-8');
              const bookmark = JSON.parse(content) as ProcessedBookmark;
              if (bookmark.tags && Array.isArray(bookmark.tags)) {
                for (const tag of bookmark.tags) {
                  const normalized = normalizeTag(tag);
                  if (!rawTagCounts[normalized]) {
                    rawTagCounts[normalized] = { raw: tag, count: 0 };
                  }
                  rawTagCounts[normalized].count++;
                }
              }
            } catch {
              // Skip invalid files
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return Object.entries(rawTagCounts)
    .map(([normalized, { raw, count }]) => ({ rawTag: raw, normalized, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

interface HeatmapEntry {
  topic: string;
  total: number;
  byWeek: Record<string, number>;
  trend: 'rising' | 'stable' | 'declining';
}

interface Heatmap {
  generatedAt: string;
  topics: HeatmapEntry[];
}

function calculateTrend(byWeek: Record<string, number>): 'rising' | 'stable' | 'declining' {
  // Get sorted weeks
  const weeks = Object.keys(byWeek).sort();
  if (weeks.length < 4) return 'stable';

  // Recent = last 2 weeks, Baseline = previous 2 weeks
  const recentWeeks = weeks.slice(-2);
  const baselineWeeks = weeks.slice(-4, -2);

  const recent = recentWeeks.reduce((sum, w) => sum + (byWeek[w] || 0), 0);
  const baseline = baselineWeeks.reduce((sum, w) => sum + (byWeek[w] || 0), 0);

  const pctChange = (recent - baseline) / Math.max(1, baseline);

  // Rising if pctChange >= 0.5 and recent >= 5
  if (pctChange >= 0.5 && recent >= 5) return 'rising';
  // Declining if pctChange <= -0.3 and baseline >= 5
  if (pctChange <= -0.3 && baseline >= 5) return 'declining';
  return 'stable';
}

async function runTopicHeatmap(): Promise<void> {
  const { mkdir: mkdirFn, writeFile: writeFileFn } = await import('fs/promises');

  console.log('\n=== Generating Topic Heatmap ===');

  // Load tag mapping
  const tagMap = await loadTagMap();
  console.log(`Tag mappings loaded: ${Object.keys(tagMap.mappings).length}`);

  // Scan all processed bookmarks
  const processedDir = getProcessedDir();
  const topicCounts: Record<string, Record<string, number>> = {}; // topic -> week -> count

  if (!existsSync(processedDir)) {
    console.log('No processed bookmarks found.');
    return;
  }

  const accounts = await readdir(processedDir);
  let bookmarkCount = 0;

  for (const account of accounts) {
    const accountDir = path.join(processedDir, account);
    const accountStats = await stat(accountDir);
    if (!accountStats.isDirectory()) continue;

    const categories = await readdir(accountDir);
    for (const category of categories) {
      const categoryDir = path.join(accountDir, category);
      try {
        const categoryStats = await stat(categoryDir);
        if (!categoryStats.isDirectory()) continue;

        const files = (await readdir(categoryDir)).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filepath = path.join(categoryDir, file);
          try {
            const content = await readFile(filepath, 'utf-8');
            const bookmark = JSON.parse(content) as ProcessedBookmark;
            bookmarkCount++;

            // Get date for week bucketing
            const date = bookmark.processedAt
              ? new Date(bookmark.processedAt)
              : bookmark.createdAt
                ? new Date(bookmark.createdAt)
                : new Date();
            const week = getIsoWeek(date);

            // Extract and normalize tags
            const tags = bookmark.tags ?? [];
            for (const rawTag of tags) {
              const tag = applyTagMapping(rawTag, tagMap);
              if (!topicCounts[tag]) {
                topicCounts[tag] = {};
              }
              topicCounts[tag][week] = (topicCounts[tag][week] || 0) + 1;
            }
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  console.log(`Scanned ${bookmarkCount} bookmarks`);
  console.log(`Found ${Object.keys(topicCounts).length} unique topics`);

  // Build heatmap entries
  const entries: HeatmapEntry[] = Object.entries(topicCounts)
    .map(([topic, byWeek]) => ({
      topic,
      total: Object.values(byWeek).reduce((a, b) => a + b, 0),
      byWeek,
      trend: calculateTrend(byWeek),
    }))
    .sort((a, b) => b.total - a.total);

  const heatmap: Heatmap = {
    generatedAt: new Date().toISOString(),
    topics: entries,
  };

  // Write output
  const outputDir = getNarrativeDir();
  await mkdirFn(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'topic-heatmap.json');
  await writeFileFn(outputPath, JSON.stringify(heatmap, null, 2));

  console.log(`\nHeatmap written to ${outputPath}`);

  // Show summary
  const rising = entries.filter((e) => e.trend === 'rising');
  const declining = entries.filter((e) => e.trend === 'declining');

  console.log(`\nTrend Summary:`);
  console.log(`  Rising: ${rising.length}`);
  console.log(`  Declining: ${declining.length}`);
  console.log(`  Stable: ${entries.length - rising.length - declining.length}`);

  if (rising.length > 0) {
    console.log('\nTop Rising Topics:');
    for (const e of rising.slice(0, 5)) {
      console.log(`  ${e.topic}: ${e.total} (rising)`);
    }
  }
}

async function runNarrativeHeatmap(): Promise<void> {
  const { mkdir: mkdirFn, writeFile: writeFileFn } = await import('fs/promises');

  console.log('\n=== Generating Narrative Heatmap ===');

  // Scan all processed bookmarks
  const processedDir = getProcessedDir();
  const narrativeCounts: Record<string, { label: string; byWeek: Record<string, number> }> = {};

  if (!existsSync(processedDir)) {
    console.log('No processed bookmarks found.');
    return;
  }

  const accounts = await readdir(processedDir);
  let bookmarkCount = 0;

  for (const account of accounts) {
    const accountDir = path.join(processedDir, account);
    const accountStats = await stat(accountDir);
    if (!accountStats.isDirectory()) continue;

    const categories = await readdir(accountDir);
    for (const category of categories) {
      const categoryDir = path.join(accountDir, category);
      try {
        const categoryStats = await stat(categoryDir);
        if (!categoryStats.isDirectory()) continue;

        const files = (await readdir(categoryDir)).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filepath = path.join(categoryDir, file);
          try {
            const content = await readFile(filepath, 'utf-8');
            const bookmark = JSON.parse(content) as ProcessedBookmark;
            bookmarkCount++;

            // Skip if no narrative assigned
            if (!bookmark.narrativeId) continue;

            // Get date for week bucketing
            const date = bookmark.processedAt
              ? new Date(bookmark.processedAt)
              : bookmark.createdAt
                ? new Date(bookmark.createdAt)
                : new Date();
            const week = getIsoWeek(date);

            const narrativeId = bookmark.narrativeId;
            if (!narrativeCounts[narrativeId]) {
              narrativeCounts[narrativeId] = {
                label: bookmark.narrativeLabel || narrativeId,
                byWeek: {},
              };
            }
            narrativeCounts[narrativeId].byWeek[week] =
              (narrativeCounts[narrativeId].byWeek[week] || 0) + 1;
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  console.log(`Scanned ${bookmarkCount} bookmarks`);
  console.log(`Found ${Object.keys(narrativeCounts).length} narratives with assignments`);

  // Build heatmap entries
  const entries: HeatmapEntry[] = Object.entries(narrativeCounts)
    .map(([_id, { label, byWeek }]) => ({
      topic: label,
      total: Object.values(byWeek).reduce((a, b) => a + b, 0),
      byWeek,
      trend: calculateTrend(byWeek),
    }))
    .sort((a, b) => b.total - a.total);

  const heatmap: Heatmap = {
    generatedAt: new Date().toISOString(),
    topics: entries,
  };

  // Write output
  const outputDir = getNarrativeDir();
  await mkdirFn(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'narrative-heatmap.json');
  await writeFileFn(outputPath, JSON.stringify(heatmap, null, 2));

  console.log(`\nHeatmap written to ${outputPath}`);

  // Show summary
  const rising = entries.filter((e) => e.trend === 'rising');
  const declining = entries.filter((e) => e.trend === 'declining');

  console.log(`\nTrend Summary:`);
  console.log(`  Rising: ${rising.length}`);
  console.log(`  Declining: ${declining.length}`);
  console.log(`  Stable: ${entries.length - rising.length - declining.length}`);

  if (rising.length > 0) {
    console.log('\nTop Rising Narratives:');
    for (const e of rising.slice(0, 5)) {
      console.log(`  ${e.topic}: ${e.total} (rising)`);
    }
  }
}

async function showHelp(): Promise<void> {
  console.log(`
Narratives CLI

Commands:
  backfill [options]          Assign narratives to existing bookmarks
  summary                     Show narratives summary
  rebuild-index               Rebuild narrative index from processed bookmarks
  list [options]              List narratives
  show <narrativeId>          Show narrative details
  merge <fromId> <toId>       Merge two narratives
  rename <id> "New Label"     Rename a narrative
  review                      Show low-confidence review queue
  refresh [options]           Refresh narrative summaries using AI
  export-obsidian             Export narratives to Obsidian markdown
  heatmap                     Generate topic heatmap from tags
  narrative-heatmap           Generate narrative heatmap

Backfill Options:
  --limit N                   Process at most N bookmarks
  --since DATE                Only process bookmarks modified after DATE
  --resume                    Resume from previous run (default)
  --no-resume                 Start fresh, ignore previous state
  --dry-run                   Show what would be done without making changes

List Options:
  --sort <updated|count|created>   Sort order (default: updated)
  --limit N                        Number of results (default: 50)

Refresh Options:
  --limit N                   Process at most N narratives
  --dry-run                   Show what would be done without making changes

Examples:
  npm run narratives:backfill
  npm run narratives:backfill -- --limit 100
  npm run narratives:summary
  npm run narratives -- rebuild-index
  npm run narratives -- list --sort count --limit 20
  npm run narratives -- show narr-abc123
  npm run narratives -- merge narr-old narr-new
  npm run narratives -- rename narr-abc123 "Better Label"
  npm run narratives -- review
  npm run narratives -- refresh --limit 10
  npm run narratives -- export-obsidian
  npm run narratives:heatmap
  npm run narratives:narrative-heatmap
`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'backfill': {
      const options = parseBackfillArgs(args);
      await runBackfill(options);
      break;
    }

    case 'summary': {
      await showNarrativesSummary();
      break;
    }

    case 'rebuild-index': {
      await runRebuildIndex();
      break;
    }

    case 'list': {
      const options = parseListArgs(args);
      await runListNarratives(options);
      break;
    }

    case 'show': {
      const narrativeId = args[0];
      if (!narrativeId) {
        console.error('Usage: narratives show <narrativeId>');
        process.exit(1);
      }
      await runShowNarrative(narrativeId);
      break;
    }

    case 'merge': {
      const fromId = args[0];
      const toId = args[1];
      if (!fromId || !toId) {
        console.error('Usage: narratives merge <fromId> <toId>');
        process.exit(1);
      }
      await runMergeNarratives(fromId, toId);
      break;
    }

    case 'rename': {
      const narrativeId = args[0];
      const newLabel = args[1];
      if (!narrativeId || !newLabel) {
        console.error('Usage: narratives rename <narrativeId> "New Label"');
        process.exit(1);
      }
      await runRenameNarrative(narrativeId, newLabel);
      break;
    }

    case 'review': {
      await runReviewQueue();
      break;
    }

    case 'refresh': {
      const options = parseRefreshArgs(args);
      await runRefreshSummaries(options);
      break;
    }

    case 'export-obsidian': {
      await runExportObsidian();
      break;
    }

    case 'heatmap': {
      await runTopicHeatmap();
      break;
    }

    case 'narrative-heatmap': {
      await runNarrativeHeatmap();
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      await showHelp();
  }
}

main().catch((error) => {
  console.error('Narratives CLI failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

// Export for testing
export {
  parseBackfillArgs,
  parseListArgs,
  parseRefreshArgs,
  runBackfill,
  runRefreshSummaries,
  runTopicHeatmap,
  runNarrativeHeatmap,
  scanProcessedBookmarks,
  normalizeTag,
  applyTagMapping,
  loadTagMap,
  generateRawTagsReport,
  getIsoWeek,
  calculateTrend,
  showHelp,
  showNarrativesSummary,
  runListNarratives,
  runShowNarrative,
  type BackfillOptions,
  type ListOptions,
  type RefreshOptions,
  type BookmarkFileInfo,
  type HeatmapEntry,
  type Heatmap,
  type TagMapConfig,
};
