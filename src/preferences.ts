/**
 * Preferences
 *
 * Preference learning system for auto-filtering bookmarks.
 * Learns from user export/skip decisions to improve recommendations.
 */

import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { PREFERENCES_FILE } from './paths.js';
import type { AnalysisResult, Categorization, Preferences, PreferenceExample, ProcessedBookmark } from './types.js';
import { deepMerge } from './utils/deep-merge.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

const DEFAULT_PREFERENCES: Preferences = {
  trustedAuthors: [],
  blockedAuthors: [],
  interestedTopics: [
    'claude',
    'claude code',
    'anthropic',
    'ai agent',
    'agentic',
    'codex',
    'prompt',
    'prompt engineering',
    'workflow',
    'automation',
    'developer tools',
    'plugin',
  ],
  avoidTopics: [],
  quality: {
    minLikes: 10,
    autoApproveLikes: 500,
    minTextLength: 30,
  },
  contentTypes: {
    prefer: ['tool', 'workflow', 'technique', 'tutorial', 'reference', 'prompt'],
    avoid: ['meme', 'giveaway', 'promo'],
  },
  examples: {
    exported: [],
    skipped: [],
  },
  stats: {
    totalReviewed: 0,
    exported: 0,
    skipped: 0,
    autoApproved: 0,
    autoSkipped: 0,
  },
  thresholds: {
    authorTrustCount: 3,
    authorBlockCount: 3,
    keywordLearnCount: 5,
    confidenceThreshold: 0.7,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertPreferences(value: unknown): asserts value is Preferences {
  const errors: string[] = [];

  if (!isRecord(value)) {
    throw new Error(`Invalid preferences in ${PREFERENCES_FILE}: expected an object`);
  }

  const prefs = value as Record<string, unknown>;

  if (!isStringArray(prefs.trustedAuthors)) errors.push('trustedAuthors must be an array of strings');
  if (!isStringArray(prefs.blockedAuthors)) errors.push('blockedAuthors must be an array of strings');
  if (!isStringArray(prefs.interestedTopics)) errors.push('interestedTopics must be an array of strings');
  if (!isStringArray(prefs.avoidTopics)) errors.push('avoidTopics must be an array of strings');

  const quality = prefs.quality;
  if (!isRecord(quality)) {
    errors.push('quality must be an object');
  } else {
    if (!isFiniteNumber(quality.minLikes)) errors.push('quality.minLikes must be a finite number');
    if (!isFiniteNumber(quality.autoApproveLikes)) errors.push('quality.autoApproveLikes must be a finite number');
    if (!isFiniteNumber(quality.minTextLength)) errors.push('quality.minTextLength must be a finite number');
  }

  const contentTypes = prefs.contentTypes;
  if (!isRecord(contentTypes)) {
    errors.push('contentTypes must be an object');
  } else {
    if (!isStringArray(contentTypes.prefer)) errors.push('contentTypes.prefer must be an array of strings');
    if (!isStringArray(contentTypes.avoid)) errors.push('contentTypes.avoid must be an array of strings');
  }

  const examples = prefs.examples;
  if (!isRecord(examples)) {
    errors.push('examples must be an object');
  } else {
    for (const key of ['exported', 'skipped']) {
      const exampleList = examples[key];
      if (!Array.isArray(exampleList)) {
        errors.push(`examples.${key} must be an array`);
        continue;
      }
      for (const example of exampleList) {
        if (!isRecord(example)) {
          errors.push(`examples.${key} entries must be objects`);
          continue;
        }
        if (typeof example.id !== 'string') errors.push(`examples.${key}.id must be a string`);
        if (typeof example.author !== 'string') errors.push(`examples.${key}.author must be a string`);
        if (typeof example.text !== 'string') errors.push(`examples.${key}.text must be a string`);
        if (typeof example.category !== 'string') errors.push(`examples.${key}.category must be a string`);
        if (typeof example.priority !== 'string') errors.push(`examples.${key}.priority must be a string`);
        if (typeof example.decision !== 'string') errors.push(`examples.${key}.decision must be a string`);
        if (!(typeof example.reason === 'string' || example.reason === null)) {
          errors.push(`examples.${key}.reason must be a string or null`);
        }
        if (typeof example.timestamp !== 'string') errors.push(`examples.${key}.timestamp must be a string`);
      }
    }
  }

  const stats = prefs.stats;
  if (!isRecord(stats)) {
    errors.push('stats must be an object');
  } else {
    if (!isFiniteNumber(stats.totalReviewed)) errors.push('stats.totalReviewed must be a finite number');
    if (!isFiniteNumber(stats.exported)) errors.push('stats.exported must be a finite number');
    if (!isFiniteNumber(stats.skipped)) errors.push('stats.skipped must be a finite number');
    if (!isFiniteNumber(stats.autoApproved)) errors.push('stats.autoApproved must be a finite number');
    if (!isFiniteNumber(stats.autoSkipped)) errors.push('stats.autoSkipped must be a finite number');
  }

  const thresholds = prefs.thresholds;
  if (!isRecord(thresholds)) {
    errors.push('thresholds must be an object');
  } else {
    if (!isFiniteNumber(thresholds.authorTrustCount)) errors.push('thresholds.authorTrustCount must be a finite number');
    if (!isFiniteNumber(thresholds.authorBlockCount)) errors.push('thresholds.authorBlockCount must be a finite number');
    if (!isFiniteNumber(thresholds.keywordLearnCount)) errors.push('thresholds.keywordLearnCount must be a finite number');
    if (!isFiniteNumber(thresholds.confidenceThreshold)) errors.push('thresholds.confidenceThreshold must be a finite number');
  }

  const authorHistory = prefs._authorHistory;
  if (authorHistory !== undefined) {
    if (!isRecord(authorHistory)) {
      errors.push('_authorHistory must be an object when present');
    } else {
      for (const [key, value] of Object.entries(authorHistory)) {
        if (!isRecord(value)) {
          errors.push(`_authorHistory.${key} must be an object`);
          continue;
        }
        if (!isFiniteNumber(value.exports)) errors.push(`_authorHistory.${key}.exports must be a finite number`);
        if (!isFiniteNumber(value.skips)) errors.push(`_authorHistory.${key}.skips must be a finite number`);
      }
    }
  }

  const keywordHistory = prefs._keywordHistory;
  if (keywordHistory !== undefined) {
    if (!isRecord(keywordHistory)) {
      errors.push('_keywordHistory must be an object when present');
    } else {
      for (const [key, value] of Object.entries(keywordHistory)) {
        if (!isRecord(value)) {
          errors.push(`_keywordHistory.${key} must be an object`);
          continue;
        }
        if (!isFiniteNumber(value.exports)) errors.push(`_keywordHistory.${key}.exports must be a finite number`);
        if (!isFiniteNumber(value.skips)) errors.push(`_keywordHistory.${key}.skips must be a finite number`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid preferences in ${PREFERENCES_FILE}:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Load preferences
 */
export async function loadPreferences(): Promise<Preferences> {
  const saved = await readJsonSafe<Partial<Preferences>>(PREFERENCES_FILE, {});
  const merged = deepMerge(DEFAULT_PREFERENCES, saved);
  assertPreferences(merged);
  return merged;
}

/**
 * Save preferences
 */
export async function savePreferences(prefs: Preferences): Promise<void> {
  const dir = path.dirname(PREFERENCES_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeJsonAtomic(PREFERENCES_FILE, prefs);
}

/**
 * Analyze a bookmark for export recommendation
 */
export async function analyzeForExport(
  bookmark: ProcessedBookmark,
  categorization: Categorization | ProcessedBookmark
): Promise<AnalysisResult> {
  const prefs = await loadPreferences();
  const rawText = bookmark.originalText ?? bookmark.text ?? '';
  const text = rawText.toLowerCase();
  const author = bookmark.author?.username || '';
  const likes = bookmark.likeCount ?? 0;

  const reasons: string[] = [];
  let score = 0.5;

  // Author-based scoring
  if (prefs.trustedAuthors.includes(author)) {
    score += 0.3;
    reasons.push(`Trusted author: @${author}`);
  }
  if (prefs.blockedAuthors.includes(author)) {
    score -= 0.4;
    reasons.push(`Blocked author: @${author}`);
  }

  // Topic-based scoring
  const interestedMatches = prefs.interestedTopics.filter((t) => text.includes(t.toLowerCase()));
  const avoidMatches = prefs.avoidTopics.filter((t) => text.includes(t.toLowerCase()));

  if (interestedMatches.length > 0) {
    score += Math.min(0.3, interestedMatches.length * 0.1);
    reasons.push(`Matches interests: ${interestedMatches.join(', ')}`);
  }
  if (avoidMatches.length > 0) {
    score -= Math.min(0.3, avoidMatches.length * 0.15);
    reasons.push(`Matches avoid topics: ${avoidMatches.join(', ')}`);
  }

  // Quality signals
  if (likes >= prefs.quality.autoApproveLikes) {
    score += 0.2;
    reasons.push(`High engagement: ${likes} likes`);
  } else if (likes < prefs.quality.minLikes) {
    score -= 0.1;
    reasons.push(`Low engagement: ${likes} likes`);
  }

  if (text.length < prefs.quality.minTextLength) {
    score -= 0.2;
    reasons.push('Very short content');
  }

  // Category-based scoring
  const category = 'category' in categorization ? categorization.category : bookmark.category;
  const priority = 'priority' in categorization ? categorization.priority : bookmark.priority;

  if (category === 'skip') {
    score -= 0.3;
    reasons.push('AI categorized as skip');
  } else if (category === 'knowledge') {
    score += 0.15;
    reasons.push('AI categorized as knowledge');
  }

  if (priority === 'high') {
    score += 0.15;
    reasons.push('High priority');
  } else if (priority === 'low') {
    score -= 0.1;
    reasons.push('Low priority');
  }

  // Content type signals
  if (rawText.match(/thread|🧵|\(\d+\/\d+\)/i)) {
    score += 0.1;
    reasons.push('Is a thread');
  }
  if (rawText.match(/tutorial|guide|how to|tip/i)) {
    score += 0.1;
    reasons.push('Tutorial/guide content');
  }
  if (rawText.match(/giveaway|subscribe|follow me/i)) {
    score -= 0.2;
    reasons.push('Promotional content');
  }

  // Clamp score
  score = Math.max(0, Math.min(1, score));

  // Determine action
  let action: 'export' | 'skip' | 'review';
  if (score >= prefs.thresholds.confidenceThreshold) {
    action = 'export';
  } else if (score <= 1 - prefs.thresholds.confidenceThreshold) {
    action = 'skip';
  } else {
    action = 'review';
  }

  return { action, confidence: score, reasons };
}

/**
 * Record a user decision and learn from it
 */
export async function recordDecision(
  bookmark: ProcessedBookmark | { id?: string; originalText?: string; text?: string; author?: { username?: string } },
  categorization: Categorization | ProcessedBookmark,
  decision: 'export' | 'skip',
  reason: string | null = null
): Promise<void> {
  await withFileLock(getLockPath(PREFERENCES_FILE), async () => {
    await recordDecisionInner(bookmark, categorization, decision, reason);
  });
}

async function recordDecisionInner(
  bookmark: ProcessedBookmark | { id?: string; originalText?: string; text?: string; author?: { username?: string } },
  categorization: Categorization | ProcessedBookmark,
  decision: 'export' | 'skip',
  reason: string | null
): Promise<void> {
  const prefs = await loadPreferences();
  const author = bookmark.author?.username || '';
  const rawText = (bookmark as ProcessedBookmark).originalText ?? bookmark.text ?? '';
  const text = rawText.toLowerCase();

  // Update stats
  prefs.stats.totalReviewed++;
  if (decision === 'export') {
    prefs.stats.exported++;
  } else {
    prefs.stats.skipped++;
  }

  // Learn from author patterns
  if (author) {
    if (!prefs._authorHistory) prefs._authorHistory = {};
    if (!prefs._authorHistory[author]) {
      prefs._authorHistory[author] = { exports: 0, skips: 0 };
    }

    if (decision === 'export') {
      prefs._authorHistory[author]!.exports++;
    } else {
      prefs._authorHistory[author]!.skips++;
    }

    const history = prefs._authorHistory[author]!;
    if (history.exports >= prefs.thresholds.authorTrustCount && history.exports > history.skips * 2) {
      if (!prefs.trustedAuthors.includes(author)) {
        prefs.trustedAuthors.push(author);
        console.log(`  [Learning] Added @${author} to trusted authors`);
      }
    }
    if (history.skips >= prefs.thresholds.authorBlockCount && history.skips > history.exports * 2) {
      if (!prefs.blockedAuthors.includes(author)) {
        prefs.blockedAuthors.push(author);
        console.log(`  [Learning] Added @${author} to blocked authors`);
      }
    }
  }

  // Learn from keywords
  const words = text.split(/\s+/).filter((w) => w.length > 4);
  if (!prefs._keywordHistory) prefs._keywordHistory = {};

  for (const word of words) {
    if (word.startsWith('http') || word.startsWith('@')) continue;

    if (!prefs._keywordHistory[word]) {
      prefs._keywordHistory[word] = { exports: 0, skips: 0 };
    }

    if (decision === 'export') {
      prefs._keywordHistory[word]!.exports++;
    } else {
      prefs._keywordHistory[word]!.skips++;
    }
  }

  // Store example
  const category = 'category' in categorization ? categorization.category : (categorization as ProcessedBookmark).category;
  const priority = 'priority' in categorization ? categorization.priority : (categorization as ProcessedBookmark).priority;

  const example: PreferenceExample = {
    id: bookmark.id || '',
    author,
    text: rawText.slice(0, 300),
    category: category || 'unknown',
    priority: priority || 'medium',
    decision,
    reason,
    timestamp: new Date().toISOString(),
  };

  if (decision === 'export') {
    prefs.examples.exported.push(example);
    if (prefs.examples.exported.length > 50) {
      prefs.examples.exported = prefs.examples.exported.slice(-50);
    }
  } else {
    prefs.examples.skipped.push(example);
    if (prefs.examples.skipped.length > 50) {
      prefs.examples.skipped = prefs.examples.skipped.slice(-50);
    }
  }

  await savePreferences(prefs);
}

/**
 * Get learned topics from keyword history
 */
export async function getLearnedTopics(): Promise<{
  interested: Array<{ word: string; rate: number; count: number }>;
  avoid: Array<{ word: string; rate: number; count: number }>;
}> {
  const prefs = await loadPreferences();

  if (!prefs._keywordHistory) return { interested: [], avoid: [] };

  const interested: Array<{ word: string; rate: number; count: number }> = [];
  const avoid: Array<{ word: string; rate: number; count: number }> = [];

  for (const [word, counts] of Object.entries(prefs._keywordHistory)) {
    const total = counts.exports + counts.skips;
    if (total < 5) continue;

    const exportRate = counts.exports / total;

    if (exportRate >= 0.7) {
      interested.push({ word, rate: exportRate, count: total });
    } else if (exportRate <= 0.3) {
      avoid.push({ word, rate: exportRate, count: total });
    }
  }

  return {
    interested: interested.sort((a, b) => b.count - a.count).slice(0, 20),
    avoid: avoid.sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

/**
 * Get examples for few-shot prompting
 */
export async function getExamplesForPrompt(count: number = 3): Promise<{
  exported: PreferenceExample[];
  skipped: PreferenceExample[];
}> {
  const prefs = await loadPreferences();

  return {
    exported: prefs.examples.exported.slice(-count),
    skipped: prefs.examples.skipped.slice(-count),
  };
}

/**
 * Reset learning data
 */
export async function resetLearning(): Promise<void> {
  const prefs = await loadPreferences();

  prefs.trustedAuthors = [];
  prefs.blockedAuthors = [];
  prefs.examples = { exported: [], skipped: [] };
  prefs.stats = { totalReviewed: 0, exported: 0, skipped: 0, autoApproved: 0, autoSkipped: 0 };
  prefs._authorHistory = {};
  prefs._keywordHistory = {};

  await savePreferences(prefs);
}

/**
 * Get preference summary
 */
export async function getPreferenceSummary(): Promise<{
  stats: Preferences['stats'];
  trustedAuthors: string[];
  blockedAuthors: string[];
  interestedTopics: string[];
  learnedInterests: string[];
  learnedAvoid: string[];
  exampleCount: { exported: number; skipped: number };
}> {
  const prefs = await loadPreferences();
  const learned = await getLearnedTopics();

  return {
    stats: prefs.stats,
    trustedAuthors: prefs.trustedAuthors,
    blockedAuthors: prefs.blockedAuthors,
    interestedTopics: prefs.interestedTopics,
    learnedInterests: learned.interested.map((t) => t.word),
    learnedAvoid: learned.avoid.map((t) => t.word),
    exampleCount: {
      exported: prefs.examples.exported.length,
      skipped: prefs.examples.skipped.length,
    },
  };
}

/**
 * Initialize preferences from bookmark analysis
 */
export async function initializeFromAnalysis(
  bookmarks: Array<{ originalText?: string; text?: string; author?: { username?: string } }>
): Promise<{ trustedAuthors: string[]; interestedTopics: string[] }> {
  const prefs = await loadPreferences();

  // Extract top authors
  const authorCounts: Record<string, number> = {};
  for (const b of bookmarks) {
    const author = b.author?.username;
    if (author) {
      authorCounts[author] = (authorCounts[author] || 0) + 1;
    }
  }

  const frequentAuthors = Object.entries(authorCounts)
    .filter(([_, count]) => count >= 3)
    .map(([author]) => author);

  prefs.trustedAuthors = [...new Set([...prefs.trustedAuthors, ...frequentAuthors])];

  // Extract common topics
  const topicCounts: Record<string, number> = {};
  const topicPatterns = [
    'claude',
    'claude code',
    'anthropic',
    'ai agent',
    'agentic',
    'codex',
    'prompt',
    'workflow',
    'automation',
    'plugin',
    'tool',
    'tutorial',
    'guide',
    'tips',
    'engineering',
    'developer',
  ];

  for (const b of bookmarks) {
    const text = (b.originalText ?? b.text ?? '').toLowerCase();
    for (const topic of topicPatterns) {
      if (text.includes(topic)) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }
  }

  const threshold = bookmarks.length * 0.05;
  const commonTopics = Object.entries(topicCounts)
    .filter(([_, count]) => count >= threshold)
    .map(([topic]) => topic);

  prefs.interestedTopics = [...new Set([...prefs.interestedTopics, ...commonTopics])];

  await savePreferences(prefs);

  return {
    trustedAuthors: prefs.trustedAuthors,
    interestedTopics: prefs.interestedTopics,
  };
}
