/**
 * Narrative Storage
 *
 * Manages storage and retrieval of narrative records.
 * Uses crash-safe atomic writes and file locking for consistency.
 */

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import type {
  Categorization,
  NarrativeAssignment,
  NarrativeConfidence,
  NarrativeIndex,
  NarrativeRecord,
  ProcessedBookmark,
} from './types.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

// ============================================
// Constants
// ============================================

const RECENT_BOOKMARK_IDS_CAP = 30;
const DEFAULT_INDEX: NarrativeIndex = { narratives: {}, version: 1 };

// ============================================
// Configurable Paths (for testing)
// ============================================

let dataDir = DATA_DIR;

export function setDataDir(dir: string): void {
  dataDir = dir;
}

export function resetDataDir(): void {
  dataDir = DATA_DIR;
}

export function getNarrativeDir(): string {
  return path.join(dataDir, 'narratives');
}

export function getIndexPath(): string {
  return path.join(getNarrativeDir(), 'index.json');
}

export function getAuditPath(): string {
  return path.join(getNarrativeDir(), 'assignments.ndjson');
}

export function getReviewQueuePath(): string {
  return path.join(getNarrativeDir(), 'review-queue.json');
}

export function getProcessedDir(): string {
  return path.join(dataDir, 'processed');
}

// Legacy exports for backwards compatibility
export const NARRATIVE_DIR = path.join(DATA_DIR, 'narratives');
export const INDEX_PATH = path.join(NARRATIVE_DIR, 'index.json');
export const AUDIT_PATH = path.join(NARRATIVE_DIR, 'assignments.ndjson');
export const REVIEW_QUEUE_PATH = path.join(NARRATIVE_DIR, 'review-queue.json');

// ============================================
// Normalization Helpers (M2.5)
// ============================================

/**
 * Normalize a label for matching/deduplication.
 * Lowercase, trim, collapse whitespace, strip punctuation.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '');
}

/**
 * Remove duplicates from an array while preserving order.
 */
export function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// ============================================
// ID Generation (M2.4)
// ============================================

/**
 * Generate a slug from a label.
 * Lowercase, replace spaces with dashes, remove special chars.
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a unique narrative ID and slug from a label.
 */
export function generateNarrativeId(label: string): { id: string; slug: string } {
  return {
    id: crypto.randomUUID(),
    slug: slugify(label) || 'narrative',
  };
}

// ============================================
// Index Load/Save (M2.2, M2.3, R2.1)
// ============================================

/**
 * Internal: load index without acquiring lock (caller must hold lock)
 */
async function loadNarrativeIndexUnlocked(): Promise<NarrativeIndex> {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) {
    return { ...DEFAULT_INDEX };
  }

  const content = await readFile(indexPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Corrupt narrative index at ${indexPath}: invalid JSON`);
  }

  // Basic shape validation
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('narratives' in parsed) ||
    !('version' in parsed)
  ) {
    throw new Error(`Corrupt narrative index at ${indexPath}: invalid shape`);
  }

  return parsed as NarrativeIndex;
}

/**
 * Internal: save index without acquiring lock (caller must hold lock)
 */
async function saveNarrativeIndexUnlocked(index: NarrativeIndex): Promise<void> {
  const indexPath = getIndexPath();
  await writeJsonAtomic(indexPath, index);
}

/**
 * Execute a function while holding the narrative index lock.
 * Use for read-modify-write operations to prevent race conditions.
 */
export async function withNarrativeIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const indexPath = getIndexPath();
  const lockPath = getLockPath(indexPath);
  return withFileLock(lockPath, fn);
}

/**
 * Load the narrative index from disk.
 * Returns default empty index if file doesn't exist.
 * Throws on corrupt JSON.
 */
export async function loadNarrativeIndex(): Promise<NarrativeIndex> {
  return withNarrativeIndexLock(loadNarrativeIndexUnlocked);
}

/**
 * Save the narrative index to disk atomically.
 */
export async function saveNarrativeIndex(index: NarrativeIndex): Promise<void> {
  return withNarrativeIndexLock(() => saveNarrativeIndexUnlocked(index));
}

// ============================================
// Ring Buffer Helper
// ============================================

/**
 * Add a bookmark ID to the recent ring buffer.
 * Dedupes, caps at RECENT_BOOKMARK_IDS_CAP, newest first.
 */
function addToRingBuffer(ids: string[], newId: string): string[] {
  const filtered = ids.filter((id) => id !== newId);
  return [newId, ...filtered].slice(0, RECENT_BOOKMARK_IDS_CAP);
}

// ============================================
// Upsert Logic (M2.6)
// ============================================

export interface UpsertResult {
  narrativeId: string;
  narrativeLabel: string;
  created: boolean;
}

/**
 * Upsert a narrative from an assignment.
 * Returns null if assignment should be skipped (low confidence or invalid).
 * Uses single lock for the entire read-modify-write operation (R2.1).
 */
export async function upsertNarrativeFromAssignment(
  bookmarkId: string,
  assignment: NarrativeAssignment | Categorization
): Promise<UpsertResult | null> {
  const confidence: NarrativeConfidence = assignment.narrativeConfidence ?? 'medium';

  // Low confidence: skip index update
  if (confidence === 'low') {
    return null;
  }

  const narrativeId = assignment.narrativeId;
  const narrativeLabel = assignment.narrativeLabel;

  // Wrap entire read-modify-write in a single lock
  return withNarrativeIndexLock(async () => {
    const index = await loadNarrativeIndexUnlocked();
    const now = new Date().toISOString();

    let targetNarrative: NarrativeRecord | null = null;
    let created = false;

    if (typeof narrativeId === 'string') {
      // Existing ID provided
      const existing = index.narratives[narrativeId];
      if (existing) {
        if (existing.status === 'merged' && existing.mergedInto) {
          // Follow merge redirect
          targetNarrative = index.narratives[existing.mergedInto] ?? null;
        } else if (existing.status === 'active') {
          targetNarrative = existing;
        }
      }

      // Unknown ID: try to match by normalized label
      if (!targetNarrative && narrativeLabel) {
        const normalizedInput = normalizeLabel(narrativeLabel);
        targetNarrative =
          Object.values(index.narratives).find(
            (n) => n.status === 'active' && n.normalizedLabel === normalizedInput
          ) ?? null;
      }

      // Still unknown: skip unless high confidence
      if (!targetNarrative && confidence !== 'high') {
        return null;
      }
    } else {
      // narrativeId is null: create new or match existing
      if (!narrativeLabel || narrativeLabel.trim() === '') {
        // No label: skip
        return null;
      }

      const normalizedInput = normalizeLabel(narrativeLabel);

      // Try to match existing by normalized label (dedupe)
      targetNarrative =
        Object.values(index.narratives).find(
          (n) => n.status === 'active' && n.normalizedLabel === normalizedInput
        ) ?? null;

      if (!targetNarrative) {
        // Create new narrative
        const { id, slug } = generateNarrativeId(narrativeLabel);
        const newNarrative: NarrativeRecord = {
          id,
          slug,
          label: narrativeLabel.trim(),
          normalizedLabel: normalizedInput,
          aliases: [],
          status: 'active',
          createdAt: now,
          lastUpdatedAt: now,
          bookmarkCount: 0,
          recentBookmarkIds: [],
          currentSummary: '',
        };
        index.narratives[id] = newNarrative;
        targetNarrative = newNarrative;
        created = true;
      }
    }

    // If we still don't have a target and confidence is high, create one
    if (!targetNarrative && confidence === 'high' && narrativeLabel && narrativeLabel.trim() !== '') {
      const { id, slug } = generateNarrativeId(narrativeLabel);
      const normalizedInput = normalizeLabel(narrativeLabel);
      const newNarrative: NarrativeRecord = {
        id,
        slug,
        label: narrativeLabel.trim(),
        normalizedLabel: normalizedInput,
        aliases: [],
        status: 'active',
        createdAt: now,
        lastUpdatedAt: now,
        bookmarkCount: 0,
        recentBookmarkIds: [],
        currentSummary: '',
      };
      index.narratives[id] = newNarrative;
      targetNarrative = newNarrative;
      created = true;
    }

    if (!targetNarrative) {
      return null;
    }

    // Update the narrative
    targetNarrative.bookmarkCount += 1;
    targetNarrative.lastUpdatedAt = now;
    targetNarrative.recentBookmarkIds = addToRingBuffer(targetNarrative.recentBookmarkIds, bookmarkId);

    // Save index within lock
    await saveNarrativeIndexUnlocked(index);

    return {
      narrativeId: targetNarrative.id,
      narrativeLabel: targetNarrative.label,
      created,
    };
  });
}

// ============================================
// Prompt Context Generation (M2.7)
// ============================================

export interface GetNarrativesOptions {
  topK?: number;
  topRecent?: number;
  bookmarkTags?: string[];
}

/**
 * Get narratives for prompt injection.
 * Returns recent + relevant candidates.
 */
export async function getNarrativesForPrompt(options: GetNarrativesOptions = {}): Promise<NarrativeRecord[]> {
  const { topK = 10, topRecent = 5, bookmarkTags = [] } = options;

  const index = await loadNarrativeIndex();
  const activeNarratives = Object.values(index.narratives).filter((n) => n.status === 'active');

  if (activeNarratives.length === 0) {
    return [];
  }

  // Sort by lastUpdatedAt (recent first), with label as tie-breaker for determinism (R2.3)
  const sortedByRecent = [...activeNarratives].sort((a, b) => {
    const timeCompare = new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime();
    if (timeCompare !== 0) return timeCompare;
    return a.label.localeCompare(b.label);
  });

  const recent = sortedByRecent.slice(0, topRecent);

  // Find relevant narratives by keyword overlap
  const normalizedTags = bookmarkTags.map((t) => normalizeLabel(t));
  const scored = activeNarratives.map((n) => {
    let score = 0;
    // Check label overlap
    const labelWords = n.normalizedLabel.split(' ');
    for (const tag of normalizedTags) {
      if (n.normalizedLabel.includes(tag)) score += 2;
      for (const word of labelWords) {
        if (word === tag) score += 1;
      }
    }
    // Check summary overlap
    const summaryNorm = normalizeLabel(n.currentSummary);
    for (const tag of normalizedTags) {
      if (summaryNorm.includes(tag)) score += 1;
    }
    return { narrative: n, score };
  });

  // Sort by score descending, with label as tie-breaker for determinism (R2.3)
  scored.sort((a, b) => {
    const scoreCompare = b.score - a.score;
    if (scoreCompare !== 0) return scoreCompare;
    return a.narrative.label.localeCompare(b.narrative.label);
  });

  // Get top K relevant (excluding those already in recent)
  const recentIds = new Set(recent.map((n) => n.id));
  const relevant = scored
    .filter((s) => s.score > 0 && !recentIds.has(s.narrative.id))
    .slice(0, topK)
    .map((s) => s.narrative);

  // Combine: recent first, then relevant
  const combined = [...recent, ...relevant];
  return dedupePreserveOrder(combined.map((n) => n.id)).map((id) => index.narratives[id]);
}

// ============================================
// Audit Log (M2.8)
// ============================================

export interface AuditEntry {
  timestamp: string;
  bookmarkId: string;
  candidatesPresented: { id: string; label: string }[];
  decision: {
    narrativeId: string | null;
    narrativeLabel?: string;
    narrativeConfidence: NarrativeConfidence;
  };
  lowConfidenceCandidate?: {
    id?: string;
    label?: string;
  };
}

/**
 * Append an entry to the audit log (NDJSON format).
 * Uses file lock to ensure ordering of concurrent appends (R2.2).
 */
export async function appendNarrativeAudit(entry: AuditEntry): Promise<void> {
  await mkdir(getNarrativeDir(), { recursive: true });
  const auditPath = getAuditPath();
  const lockPath = getLockPath(auditPath);

  await withFileLock(lockPath, async () => {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(auditPath, line, 'utf-8');
  });
}

// ============================================
// Rebuild Index (M2.9)
// ============================================

/**
 * Rebuild the narrative index from processed bookmarks.
 */
export async function rebuildNarrativeIndex(): Promise<NarrativeIndex> {
  const newIndex: NarrativeIndex = { narratives: {}, version: 1 };

  // Preserve existing summaries if possible
  let existingIndex: NarrativeIndex | null = null;
  try {
    existingIndex = await loadNarrativeIndex();
  } catch {
    // Ignore - will rebuild from scratch
  }

  // Scan all processed bookmarks
  const processedDir = getProcessedDir();
  if (!existsSync(processedDir)) {
    return newIndex;
  }

  const accounts = await readdir(processedDir);
  const allBookmarks: { bookmark: ProcessedBookmark; filePath: string }[] = [];

  for (const account of accounts) {
    const accountDir = path.join(processedDir, account);
    const categories = await readdir(accountDir).catch(() => []);

    for (const category of categories) {
      const categoryDir = path.join(accountDir, category);
      const files = await readdir(categoryDir).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(categoryDir, file);
        try {
          const bookmark = await readJsonSafe<ProcessedBookmark>(filePath, null as unknown as ProcessedBookmark);
          if (bookmark && bookmark.narrativeId) {
            allBookmarks.push({ bookmark, filePath });
          }
        } catch {
          // Skip corrupted files
        }
      }
    }
  }

  // Sort by processedAt (or createdAt), then filepath for deterministic ordering (R2.3)
  allBookmarks.sort((a, b) => {
    const aTime = new Date(a.bookmark.processedAt || a.bookmark.createdAt || 0).getTime();
    const bTime = new Date(b.bookmark.processedAt || b.bookmark.createdAt || 0).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.filePath.localeCompare(b.filePath);
  });

  // Build index from bookmarks
  for (const { bookmark } of allBookmarks) {
    const { narrativeId, narrativeLabel } = bookmark;
    if (!narrativeId) continue;

    if (!newIndex.narratives[narrativeId]) {
      // Try to get label from existing index or bookmark
      const existingRecord = existingIndex?.narratives[narrativeId];
      const label = existingRecord?.label ?? narrativeLabel ?? 'Unknown';
      const normalizedLabel = normalizeLabel(label);
      const slug = existingRecord?.slug ?? slugify(label);

      newIndex.narratives[narrativeId] = {
        id: narrativeId,
        slug,
        label,
        normalizedLabel,
        aliases: existingRecord?.aliases ?? [],
        status: existingRecord?.status ?? 'active',
        mergedInto: existingRecord?.mergedInto,
        createdAt: existingRecord?.createdAt ?? bookmark.processedAt,
        lastUpdatedAt: bookmark.processedAt,
        lastSummaryUpdatedAt: existingRecord?.lastSummaryUpdatedAt,
        bookmarkCount: 0,
        recentBookmarkIds: [],
        currentSummary: existingRecord?.currentSummary ?? '',
      };
    }

    const narrative = newIndex.narratives[narrativeId];
    narrative.bookmarkCount += 1;
    if (new Date(bookmark.processedAt) > new Date(narrative.lastUpdatedAt)) {
      narrative.lastUpdatedAt = bookmark.processedAt;
    }
    narrative.recentBookmarkIds = addToRingBuffer(narrative.recentBookmarkIds, bookmark.id);
  }

  // Save rebuilt index
  await saveNarrativeIndex(newIndex);

  return newIndex;
}

// ============================================
// Update Summary (M2.10)
// ============================================

/**
 * Update a narrative's summary.
 * Uses single lock for the entire read-modify-write operation (R2.1).
 */
export async function updateNarrativeSummary(narrativeId: string, summary: string): Promise<void> {
  return withNarrativeIndexLock(async () => {
    const index = await loadNarrativeIndexUnlocked();
    let target = index.narratives[narrativeId];

    if (!target) {
      throw new Error(`Narrative not found: ${narrativeId}`);
    }

    // Follow merge redirect
    if (target.status === 'merged' && target.mergedInto) {
      const mergedIntoId = target.mergedInto;
      const mergedTarget = index.narratives[mergedIntoId];
      if (!mergedTarget) {
        throw new Error(`Merged target not found: ${mergedIntoId}`);
      }
      target = mergedTarget;
    }

    target.currentSummary = summary;
    target.lastSummaryUpdatedAt = new Date().toISOString();

    await saveNarrativeIndexUnlocked(index);
  });
}

// ============================================
// Review Queue Helpers
// ============================================

export interface ReviewQueueEntry {
  bookmarkId: string;
  candidateId?: string;
  candidateLabel?: string;
  addedAt: string;
}

export interface ReviewQueue {
  entries: ReviewQueueEntry[];
}

/**
 * Add an entry to the review queue.
 * Uses file lock for read-modify-write safety (R2.2).
 */
export async function addToReviewQueue(entry: Omit<ReviewQueueEntry, 'addedAt'>): Promise<void> {
  await mkdir(getNarrativeDir(), { recursive: true });

  const reviewQueuePath = getReviewQueuePath();
  const lockPath = getLockPath(reviewQueuePath);

  await withFileLock(lockPath, async () => {
    const defaultQueue: ReviewQueue = { entries: [] };
    let queue: ReviewQueue;
    try {
      queue = await readJsonSafe<ReviewQueue>(reviewQueuePath, defaultQueue);
    } catch {
      queue = defaultQueue;
    }

    queue.entries.push({
      ...entry,
      addedAt: new Date().toISOString(),
    });

    await writeJsonAtomic(reviewQueuePath, queue);
  });
}

/**
 * Load the review queue.
 */
export async function loadReviewQueue(): Promise<ReviewQueue> {
  const reviewQueuePath = getReviewQueuePath();
  const defaultQueue: ReviewQueue = { entries: [] };
  try {
    return await readJsonSafe<ReviewQueue>(reviewQueuePath, defaultQueue);
  } catch {
    return defaultQueue;
  }
}

// ============================================
// Merge Narratives
// ============================================

/**
 * Merge one narrative into another.
 * Uses single lock for the entire read-modify-write operation (R2.1).
 */
export async function mergeNarratives(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) {
    throw new Error('Cannot merge a narrative into itself');
  }

  return withNarrativeIndexLock(async () => {
    const index = await loadNarrativeIndexUnlocked();

    const from = index.narratives[fromId];
    const to = index.narratives[toId];

    if (!from) {
      throw new Error(`Source narrative not found: ${fromId}`);
    }
    if (!to) {
      throw new Error(`Target narrative not found: ${toId}`);
    }

    // Mark source as merged
    from.status = 'merged';
    from.mergedInto = toId;
    from.lastUpdatedAt = new Date().toISOString();

    // Add source label as alias to target
    if (!to.aliases.includes(from.label)) {
      to.aliases.push(from.label);
    }

    // Merge counts and recent IDs
    to.bookmarkCount += from.bookmarkCount;
    for (const id of from.recentBookmarkIds) {
      to.recentBookmarkIds = addToRingBuffer(to.recentBookmarkIds, id);
    }
    to.lastUpdatedAt = new Date().toISOString();

    await saveNarrativeIndexUnlocked(index);
  });
}

/**
 * Rename a narrative.
 * Uses single lock for the entire read-modify-write operation (R2.1).
 */
export async function renameNarrative(narrativeId: string, newLabel: string): Promise<void> {
  return withNarrativeIndexLock(async () => {
    const index = await loadNarrativeIndexUnlocked();
    const narrative = index.narratives[narrativeId];

    if (!narrative) {
      throw new Error(`Narrative not found: ${narrativeId}`);
    }

    // Store old label as alias
    if (!narrative.aliases.includes(narrative.label)) {
      narrative.aliases.push(narrative.label);
    }

    narrative.label = newLabel.trim();
    narrative.normalizedLabel = normalizeLabel(newLabel);
    narrative.slug = slugify(newLabel);
    narrative.lastUpdatedAt = new Date().toISOString();

    await saveNarrativeIndexUnlocked(index);
  });
}
