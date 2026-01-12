/**
 * Application Configuration
 *
 * Centralized configuration with typed defaults.
 */

import type { AppConfig } from './types.js';

export const config: AppConfig = {
  // Polling interval (5 minutes)
  pollInterval: 5 * 60 * 1000,

  // Number of bookmarks to fetch per poll
  bookmarkCount: 20,

  // Path to Bird CLI (relative to project root)
  birdPath: 'node_modules/@steipete/bird',

  // Storage paths (relative to data/)
  paths: {
    bookmarks: 'bookmarks',
    processed: 'processed',
    transcripts: 'transcripts',
    knowledgeBase: 'knowledge-base',
    stateFile: 'state',
    failed: 'failed',
  },

  // Categories for bookmark classification
  categories: {
    REVIEW: 'review',
    TRY: 'try',
    KNOWLEDGE: 'knowledge',
    LIFE: 'life',
    SKIP: 'skip',
  },

  // Content types for classification
  contentTypes: {
    TOOL: 'tool',
    PROMPT: 'prompt',
    TECHNIQUE: 'technique',
    WORKFLOW: 'workflow',
    TUTORIAL: 'tutorial',
    REFERENCE: 'reference',
    ANNOUNCEMENT: 'announcement',
    NEWS: 'news',
    RESEARCH: 'research',
    DATASET: 'dataset',
    BENCHMARK: 'benchmark',
    OPINION: 'opinion',
    OTHER: 'other',
  },

  // LLM configuration
  llm: {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    maxTokens: 10024,
    timeout: 90_000,
    retries: 3,
    disabled: false,
  },

  // Context budget limits
  budget: {
    maxThreadTweets: 40,
    maxParentChain: 15,
    maxTopReplies: 15,
    maxPromptChars: 190_000,
    maxArticleChars: 250_000,
    maxTranscriptChars: 250_000,
  },

  // Failure handling configuration
  failure: {
    maxRetries: 3,
    retryDelayMs: 30_000,
    saveFailedAsReview: true,
    trackFailures: true,
  },

  // Pre-LLM filtering
  filters: {
    minTextLength: 20,
    blockedDomains: ['t.co', 'twitter.com', 'x.com'],
    spamPatterns: ['giveaway', 'airdrop', 'free nft', 'whitelist', 'discord.gg', 't.me'],
  },

  // Retry behavior for external enrichment calls
  retries: {
    maxAttempts: 3,
    baseDelayMs: 1_500,
    jitterMs: 400,
  },

  // Rate limit configuration
  rateLimit: {
    baseBackoffMs: 60_000, // 1 minute base
    maxBackoffMs: 3_600_000, // 1 hour max
    backoffMultiplier: 2,
  },

  // Security configuration
  security: {
    checkFilePermissions: true,
    sensitiveFileMode: 0o600,
  },
};

// Freeze config to prevent accidental mutation
Object.freeze(config);
Object.freeze(config.paths);
Object.freeze(config.categories);
Object.freeze(config.contentTypes);
Object.freeze(config.llm);
Object.freeze(config.budget);
Object.freeze(config.failure);
Object.freeze(config.filters);
Object.freeze(config.retries);
Object.freeze(config.rateLimit);
Object.freeze(config.security);
