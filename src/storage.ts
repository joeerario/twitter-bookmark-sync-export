/**
 * Storage
 *
 * Manages storage and retrieval of processed bookmarks.
 * Structure: data/processed/{account}/{category}/{tweet_id}.json
 */

import { existsSync } from 'fs';
import { mkdir, readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { DATA_DIR, getAccountProcessedDir, KNOWLEDGE_BASE_DIR } from './paths.js';
import type { Categorization, EnrichedBookmark, ProcessedBookmark, StorageSummary } from './types.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

/**
 * Ensure directory exists
 */
async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Check if a bookmark has been processed (exists in any category)
 */
export function isBookmarkProcessed(account: string, tweetId: string): boolean {
  const accountName = account || 'default';

  for (const category of Object.values(config.categories)) {
    const filepath = path.join(DATA_DIR, 'processed', accountName, category, `${tweetId}.json`);
    if (existsSync(filepath)) {
      return true;
    }
  }

  return false;
}

/**
 * Save a processed bookmark
 */
export async function saveProcessedBookmark(
  enrichedBookmark: EnrichedBookmark | { id?: string; tweetId?: string; [key: string]: unknown },
  categorization: Categorization,
  account?: string | null
): Promise<string> {
  const accountName = account || (enrichedBookmark as EnrichedBookmark)._account || 'default';
  const { category } = categorization;
  const categoryDir = getAccountProcessedDir(accountName, category);

  await ensureDir(categoryDir);

  // Derive tweet ID - raw bookmarks have `id`, enriched have `tweetId`
  const tweetId = (enrichedBookmark as EnrichedBookmark).tweetId ?? enrichedBookmark.id;
  if (!tweetId) {
    throw new Error('Cannot save bookmark: missing both tweetId and id');
  }

  const filename = `${tweetId}.json`;
  const filepath = path.join(categoryDir, filename);

  const eb = enrichedBookmark as EnrichedBookmark;

  // Extract narrative fields, converting null to undefined for storage
  const { narrativeId: rawNarrativeId, narrativeLabel, narrativeConfidence, ...restCategorization } =
    categorization;
  const narrativeId = rawNarrativeId === null ? undefined : rawNarrativeId;

  const data: ProcessedBookmark = {
    id: tweetId,
    account: accountName,
    author: eb.author,
    originalText: eb.text,
    text: eb.text,
    createdAt: eb.createdAt,
    processedAt: new Date().toISOString(),
    likeCount: eb.likeCount ?? 0,
    retweetCount: eb.retweetCount ?? 0,
    replyCount: eb.replyCount ?? 0,
    urls: eb.urls ?? [],
    ...restCategorization,
    ...(narrativeId !== undefined && { narrativeId }),
    ...(narrativeLabel !== undefined && { narrativeLabel }),
    ...(narrativeConfidence !== undefined && { narrativeConfidence }),
    isReply: eb.isReply || false,
    isPartOfThread: eb.isPartOfThread || false,
    conversationId: eb.conversationId,
    inReplyToStatusId: eb.inReplyToStatusId,
    threadContext: eb.threadContext,
    transcripts: eb.transcripts ?? [],
    articles: eb.articles ?? [],
    ...(eb.media ? { media: eb.media } : {}),
    ...(eb.enrichmentErrors ? { enrichmentErrors: eb.enrichmentErrors } : {}),
  };

  await writeJsonAtomic(filepath, data);
  console.log(`  Saved to ${accountName}/${category}/${filename}`);

  return filepath;
}

/**
 * Knowledge base entry
 */
interface KnowledgeEntry {
  id: string;
  account: string;
  addedAt: string;
  source: string;
  summary: string;
  keyValue: string;
  quotes: string[];
  tags: string[];
  priority: string;
  originalText?: string;
  isReply?: boolean;
  isPartOfThread?: boolean;
  threadContext?: unknown;
  transcripts?: unknown[];
  articles?: unknown[];
}

/**
 * Add to knowledge base
 */
export async function addToKnowledgeBase(
  enrichedBookmark: EnrichedBookmark,
  categorization: Categorization,
  account?: string | null
): Promise<KnowledgeEntry> {
  const accountName = account || enrichedBookmark._account || 'default';
  await ensureDir(KNOWLEDGE_BASE_DIR);

  const tweetId = enrichedBookmark.tweetId ?? enrichedBookmark.id;
  if (!tweetId) {
    throw new Error('Cannot add to knowledge base: missing both tweetId and id');
  }

  const indexPath = path.join(KNOWLEDGE_BASE_DIR, 'index.json');

  const entry: KnowledgeEntry = {
    id: tweetId,
    account: accountName,
    addedAt: new Date().toISOString(),
    source: `https://x.com/${enrichedBookmark.author?.username}/status/${tweetId}`,
    summary: categorization.summary,
    keyValue: categorization.keyValue,
    quotes: categorization.quotes,
    tags: categorization.tags,
    priority: categorization.priority,
  };

  // Use file lock for the read-modify-write operation
  await withFileLock(getLockPath(indexPath), async () => {
    const index = await readJsonSafe<KnowledgeEntry[]>(indexPath, []);

    const existingIndex = index.findIndex((e) => e.id === entry.id);
    if (existingIndex >= 0) {
      index[existingIndex] = entry;
    } else {
      index.push(entry);
    }

    await writeJsonAtomic(indexPath, index);
  });

  // Save full entry
  const entryPath = path.join(KNOWLEDGE_BASE_DIR, `${tweetId}.json`);
  await writeJsonAtomic(entryPath, {
    ...entry,
    originalText: enrichedBookmark.text,
    isReply: enrichedBookmark.isReply || false,
    isPartOfThread: enrichedBookmark.isPartOfThread || false,
    threadContext: enrichedBookmark.threadContext,
    transcripts: enrichedBookmark.transcripts,
    articles: enrichedBookmark.articles,
  });

  console.log(`  Added to knowledge base: ${categorization.summary.slice(0, 50)}...`);

  return entry;
}

// Cache for summary to avoid repeated filesystem scans
let cachedSummary: StorageSummary | null = null;
let cacheTimestamp = 0;
const SUMMARY_CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Get summary of all processed content.
 *
 * @param account - Optional account filter
 * @param forceRefresh - Force filesystem scan even if cache is valid
 */
export async function getSummary(account?: string | null, forceRefresh = false): Promise<StorageSummary> {
  const now = Date.now();

  // Return cached summary if still valid and no specific account filter
  if (!forceRefresh && !account && cachedSummary && (now - cacheTimestamp) < SUMMARY_CACHE_TTL_MS) {
    return cachedSummary;
  }

  const processedDir = path.join(DATA_DIR, 'processed');

  const summary: StorageSummary = {
    review: 0,
    try: 0,
    knowledge: 0,
    life: 0,
    skip: 0,
    total: 0,
    byAccount: {},
  };

  if (!existsSync(processedDir)) {
    return summary;
  }

  const accounts = await readdir(processedDir);

  for (const acc of accounts) {
    if (account && acc !== account) continue;

    const accountDir = path.join(processedDir, acc);
    const stats = await stat(accountDir);
    if (!stats.isDirectory()) continue;

    summary.byAccount[acc] = { review: 0, try: 0, knowledge: 0, life: 0, skip: 0, total: 0 };

    for (const category of Object.values(config.categories)) {
      const categoryDir = path.join(accountDir, category);
      try {
        const files = await readdir(categoryDir);
        const count = files.filter((f) => f.endsWith('.json')).length;
        (summary as unknown as Record<string, number>)[category] += count;
        summary.total += count;
        (summary.byAccount[acc] as Record<string, number>)[category] = count;
        summary.byAccount[acc]!.total += count;
      } catch {
        // Directory doesn't exist
      }
    }
  }

  // Update cache (only for full summary without account filter)
  if (!account) {
    cachedSummary = summary;
    cacheTimestamp = now;
  }

  return summary;
}

/**
 * Get recent items from a category
 */
export async function getRecentItems(category: string, limit: number = 10, account?: string | null): Promise<ProcessedBookmark[]> {
  const processedDir = path.join(DATA_DIR, 'processed');
  const items: ProcessedBookmark[] = [];

  if (limit <= 0) {
    return items;
  }

  if (!existsSync(processedDir)) {
    return items;
  }

  const accounts = await readdir(processedDir);

  for (const acc of accounts) {
    if (account && acc !== account) continue;

    const categoryDir = path.join(processedDir, acc, category);

    try {
      const files = await readdir(categoryDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const perAccountLimit = Math.min(limit, jsonFiles.length);

      let filesToRead = jsonFiles;
      if (jsonFiles.length > perAccountLimit) {
        const stats = await Promise.all(
          jsonFiles.map(async (file) => {
            try {
              const fileStat = await stat(path.join(categoryDir, file));
              return { file, mtimeMs: fileStat.mtimeMs };
            } catch {
              return null;
            }
          })
        );

        filesToRead = stats
          .filter((entry): entry is { file: string; mtimeMs: number } => !!entry)
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, perAccountLimit)
          .map((entry) => entry.file);
      }

      for (const file of filesToRead) {
        const filepath = path.join(categoryDir, file);
        try {
          const data = await readFile(filepath, 'utf-8');
          items.push(JSON.parse(data) as ProcessedBookmark);
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Sort by processedAt descending and limit
  return items
    .sort((a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime())
    .slice(0, limit);
}

/**
 * Search knowledge base by tags
 */
export async function searchByTags(tags: string[], account?: string | null): Promise<KnowledgeEntry[]> {
  const indexPath = path.join(KNOWLEDGE_BASE_DIR, 'index.json');

  try {
    const data = await readFile(indexPath, 'utf-8');
    let index = JSON.parse(data) as KnowledgeEntry[];

    if (account) {
      index = index.filter((entry) => entry.account === account);
    }

    return index.filter((entry) =>
      entry.tags?.some((tag) => tags.some((searchTag) => tag.toLowerCase().includes(searchTag.toLowerCase())))
    );
  } catch {
    return [];
  }
}

/**
 * Get all items for an account
 */
export async function getAccountItems(
  account: string
): Promise<Record<string, ProcessedBookmark[]>> {
  const limit = Number.MAX_SAFE_INTEGER;

  return {
    review: await getRecentItems('review', limit, account),
    try: await getRecentItems('try', limit, account),
    knowledge: await getRecentItems('knowledge', limit, account),
    skip: await getRecentItems('skip', limit, account),
  };
}

/**
 * Export all data for backup
 */
export async function exportAllData(): Promise<{
  exportedAt: string;
  summary: StorageSummary;
  knowledgeBase: KnowledgeEntry[];
}> {
  const summary = await getSummary();

  let knowledgeBase: KnowledgeEntry[] = [];
  try {
    const data = await readFile(path.join(KNOWLEDGE_BASE_DIR, 'index.json'), 'utf-8');
    knowledgeBase = JSON.parse(data) as KnowledgeEntry[];
  } catch {
    // Empty knowledge base
  }

  return {
    exportedAt: new Date().toISOString(),
    summary,
    knowledgeBase,
  };
}
