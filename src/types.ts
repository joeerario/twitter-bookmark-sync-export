/**
 * Type Definitions for Bookmark Automation
 *
 * This file contains TypeScript types for the main data shapes
 * used throughout the application.
 */

// ============================================
// Narrative Types
// ============================================

export type NarrativeConfidence = 'high' | 'medium' | 'low';
export type NarrativeStatus = 'active' | 'merged';

export interface NarrativeAssignment {
  narrativeId: string | null; // null = create new
  narrativeLabel?: string;
  narrativeConfidence: NarrativeConfidence;
}

export interface NarrativeRecord {
  id: string;
  slug: string;
  label: string;
  normalizedLabel: string;
  aliases: string[];
  status: NarrativeStatus;
  mergedInto?: string;
  createdAt: string;
  lastUpdatedAt: string;
  lastSummaryUpdatedAt?: string;
  bookmarkCount: number;
  recentBookmarkIds: string[]; // ring buffer (cap at 30)
  currentSummary: string;
}

export interface NarrativeIndex {
  narratives: Record<string, NarrativeRecord>;
  version: number;
}

// ============================================
// Generic Result Type
// ============================================

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export interface AppError {
  type: string;
  message: string;
  cause?: unknown;
}

// ============================================
// Raw Bird Bookmark (from Twitter API)
// ============================================

export interface TwitterAuthor {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  verified?: boolean;
  followers_count?: number;
}

export interface TwitterMediaItem {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  previewUrl?: string;
  preview_image_url?: string;
}

export interface TwitterUrlEntity {
  url: string;
  expanded_url: string;
  display_url: string;
  start: number;
  end: number;
}

export interface TwitterEntities {
  urls?: TwitterUrlEntity[];
}

export interface TwitterArticle {
  title?: string;
  text?: string;
}

/**
 * Bookmark from Bird CLI (already normalized to camelCase by Bird's mapTweetResult)
 * Note: Bird normalizes Twitter's snake_case fields to camelCase internally.
 */
export interface RawBirdBookmark {
  id: string;
  text: string;
  author: TwitterAuthor;
  createdAt: string;
  conversationId?: string;
  inReplyToUserId?: string;
  inReplyToStatusId?: string;
  quotedTweet?: RawBirdBookmark;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  media?: TwitterMediaItem[];
  entities?: TwitterEntities;
  article?: TwitterArticle;
  /** Added: Account username that bookmarked this */
  _account?: string;
}

// ============================================
// Enriched Bookmark (after content extraction)
// ============================================

export interface ExtractedTranscript {
  videoId: string;
  url: string;
  transcript: string;
}

export interface ExtractedArticle {
  url: string;
  title: string;
  content?: string;
}

export interface EnrichmentError {
  url: string;
  errorType: 'tweet' | 'article' | 'transcript';
  message?: string;
}

export interface ThreadContext {
  parentChain: RawBirdBookmark[];
  authorThread: RawBirdBookmark[];
  totalInThread: number;
  hasMoreReplies: boolean;
  topReplies: RawBirdBookmark[];
  quotedTweet?: RawBirdBookmark;
  referencedTweet?: RawBirdBookmark;
}

export type ContentInfoType = 'youtube' | 'podcast' | 'github' | 'twitter' | 'article';

export interface ContentInfo {
  url: string;
  type: ContentInfoType;
  videoId?: string;
}

/**
 * Enriched bookmark with extracted content
 */
export interface EnrichedBookmark {
  tweetId: string;
  id?: string;
  text: string;
  author: TwitterAuthor;
  createdAt: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  urls: string[];
  isReply: boolean;
  isPartOfThread: boolean;
  conversationId?: string;
  inReplyToStatusId?: string;
  threadContext?: ThreadContext | null;
  transcripts: ExtractedTranscript[];
  articles: ExtractedArticle[];
  enrichmentErrors?: EnrichmentError[];
  _account: string;
  media?: TwitterMediaItem[];
  contents?: ContentInfo[];
  hasVideo?: boolean;
  hasPodcast?: boolean;
  hasGithub?: boolean;
  hasArticle?: boolean;
  hasTweetLinks?: boolean;
  hasImages?: boolean;
}

// ============================================
// Categorization Types
// ============================================

export type Category = 'review' | 'try' | 'knowledge' | 'life' | 'skip';
export type ContentType =
  | 'tool'
  | 'prompt'
  | 'technique'
  | 'workflow'
  | 'tutorial'
  | 'reference'
  | 'announcement'
  | 'news'
  | 'research'
  | 'dataset'
  | 'benchmark'
  | 'opinion'
  | 'other';
export type ContentFormat =
  | 'tweet'
  | 'thread'
  | 'reply'
  | 'article'
  | 'video'
  | 'podcast'
  | 'repo'
  | 'docs'
  | 'image'
  | 'link';
export type Priority = 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * AI categorization result
 */
export interface Categorization {
  category: Category;
  contentType: ContentType;
  contentFormat: ContentFormat;
  summary: string;
  keyValue: string;
  whenToUse?: string | null;
  quotes: string[];
  tags: string[];
  actionItems: string[];
  followUpBy?: string | null;
  priority: Priority;
  confidence?: Confidence;
  narrativeId?: string | null;
  narrativeLabel?: string;
  narrativeConfidence?: NarrativeConfidence;
  // Low-confidence candidate fields (for review queue)
  narrativeCandidateId?: string;
  narrativeCandidateLabel?: string;
}

// ============================================
// Processed Bookmark (after categorization)
// ============================================

/**
 * Fully processed bookmark (stored in JSON)
 */
export interface ProcessedBookmark {
  id: string;
  account: string;
  author: TwitterAuthor;
  originalText: string;
  text: string;
  createdAt: string;
  processedAt: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  urls: string[];
  category: Category;
  contentType: ContentType;
  contentFormat: ContentFormat;
  summary: string;
  keyValue: string;
  whenToUse?: string | null;
  quotes: string[];
  tags: string[];
  actionItems: string[];
  followUpBy?: string | null;
  priority: Priority;
  confidence?: Confidence;
  isReply: boolean;
  isPartOfThread: boolean;
  conversationId?: string;
  inReplyToStatusId?: string;
  threadContext?: ThreadContext | null;
  transcripts: ExtractedTranscript[];
  articles: ExtractedArticle[];
  media?: TwitterMediaItem[];
  enrichmentErrors?: EnrichmentError[];
  narrativeId?: string;
  narrativeLabel?: string;
  narrativeConfidence?: NarrativeConfidence;
  narrativeCandidateId?: string;
  narrativeCandidateLabel?: string;
}

// ============================================
// Account Types
// ============================================

export interface Account {
  id: string;
  username: string;
  name: string;
  userId?: string;
  authToken: string;
  ct0: string;
  enabled: boolean;
  addedAt: string;
  lastValidated: string;
  validationError: string | null;
}

export interface AccountState {
  username: string;
  processedIds: string[];
  lastPoll: string | null;
  lastError: {
    message: string;
    type: string;
    at: string;
  } | null;
  stats: {
    total: number;
    success: number;
    errors: number;
  };
}

// ============================================
// Failure Handling Types
// ============================================

export interface FailureRecord {
  tweetId: string;
  account: string;
  errorType: string;
  errorMessage: string;
  firstSeen: string;
  lastSeen: string;
  nextRetryAt: string | null;
  attempts: number;
  poisonPill: boolean;
}

export interface RateLimitState {
  account: string;
  nextAllowedPollAt: string | null;
  consecutiveRateLimits: number;
  lastRateLimitAt: string | null;
}

// ============================================
// Bird Runner Types
// ============================================

export interface BirdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  json: unknown;
  exitCode: number;
  errorType: string;
  errorMessage: string;
}

export interface BirdOptions {
  authToken: string;
  ct0: string;
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
  globalArgs?: string[];
  expectJson?: boolean;
}

export interface BirdCredentials {
  authToken: string;
  ct0: string;
}

export interface FetchBookmarksResult {
  success: boolean;
  bookmarks?: RawBirdBookmark[];
  nextCursor?: string | null;
  error?: string;
  errorType?: string;
}

export interface ValidateCredentialsResult {
  valid: boolean;
  username?: string;
  name?: string;
  userId?: string;
  error?: string;
}

// ============================================
// Processing Result Types
// ============================================

export type SkipType = 'poison_pill' | 'backoff' | 'filtered';

export interface ProcessBookmarkResult {
  success: boolean;
  enriched?: EnrichedBookmark;
  categorization?: Categorization;
  error?: string;
  skipped?: boolean;
  skipType?: SkipType;
  attempts?: number;
}

export interface ProcessAccountResult {
  account: string;
  success: boolean;
  processed: number;
  skippedPoisonPills?: number;
  skippedBackoff?: number;
  skippedFiltered?: number;
  errors?: number;
  fetched?: number;
  error?: string;
  errorType?: string;
  rateLimited?: boolean;
  nextAllowedAt?: string;
}

export interface PollResult {
  success: boolean;
  results: ProcessAccountResult[];
}

// ============================================
// Obsidian Export Types
// ============================================

export interface ObsidianConfig {
  vaultPath: string | null;
  bookmarksFolder: string;
  useCategoryFolders: boolean;
  categoryFolders: Record<string, string | null>;
  fileNaming: 'date-summary' | 'id' | 'summary';
  includeTranscripts: boolean;
  maxContentLength: number;
  autoLink: {
    enabled: boolean;
    linkMappings: Record<string, string>;
  };
  assets: {
    strategy: 'vault-relative' | 'adjacent' | 'custom';
    assetsDir: string;
    perCategoryDirs: Record<string, string | null>;
    embedWidth: number;
  };
  article: {
    mode: 'excerpt-inline' | 'full-in-separate-note' | 'external-only';
    separateDir: string;
    maxExcerptLength: number;
  };
  tagPolicy: 'preserve' | 'sanitize' | 'drop_invalid';
}

export interface ExportState {
  exportedIds: string[];
  lastExport: string | null;
}

export interface ExportResult {
  exported: boolean;
  filepath?: string;
  filename?: string;
  folder?: string;
  reason?: string;
}

export interface ExportBatchResult {
  exported: number;
  skipped: number;
  errors: number;
  files: string[];
}

// ============================================
// Preferences Types
// ============================================

export interface Preferences {
  trustedAuthors: string[];
  blockedAuthors: string[];
  interestedTopics: string[];
  avoidTopics: string[];
  quality: {
    minLikes: number;
    autoApproveLikes: number;
    minTextLength: number;
  };
  contentTypes: {
    prefer: string[];
    avoid: string[];
  };
  examples: {
    exported: PreferenceExample[];
    skipped: PreferenceExample[];
  };
  stats: {
    totalReviewed: number;
    exported: number;
    skipped: number;
    autoApproved: number;
    autoSkipped: number;
  };
  thresholds: {
    authorTrustCount: number;
    authorBlockCount: number;
    keywordLearnCount: number;
    confidenceThreshold: number;
  };
  _authorHistory?: Record<string, { exports: number; skips: number }>;
  _keywordHistory?: Record<string, { exports: number; skips: number }>;
}

export interface PreferenceExample {
  id: string;
  author: string;
  text: string;
  category: string;
  priority: string;
  decision: string;
  reason: string | null;
  timestamp: string;
}

export interface AnalysisResult {
  action: 'export' | 'skip' | 'review';
  confidence: number;
  reasons: string[];
}

// ============================================
// Storage Summary Types
// ============================================

export interface StorageSummary {
  review: number;
  try: number;
  knowledge: number;
  life: number;
  skip: number;
  total: number;
  byAccount: Record<
    string,
    {
      review: number;
      try: number;
      knowledge: number;
      life: number;
      skip: number;
      total: number;
    }
  >;
}

// ============================================
// Config Types
// ============================================

export interface LLMConfig {
  provider: 'anthropic';
  model: string;
  maxTokens: number;
  timeout: number;
  retries: number;
  disabled: boolean;
}

export interface BudgetConfig {
  maxThreadTweets: number;
  maxParentChain: number;
  maxTopReplies: number;
  maxPromptChars: number;
  maxArticleChars: number;
  maxTranscriptChars: number;
}

export interface FailureConfig {
  maxRetries: number;
  retryDelayMs: number;
  saveFailedAsReview: boolean;
  trackFailures: boolean;
}

export interface FilterConfig {
  minTextLength: number;
  blockedDomains: string[];
  spamPatterns: string[];
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  jitterMs: number;
}

export interface RateLimitConfig {
  baseBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
}

export interface SecurityConfig {
  checkFilePermissions: boolean;
  sensitiveFileMode: number;
}

export interface AppConfig {
  pollInterval: number;
  bookmarkCount: number;
  birdPath: string;
  paths: {
    bookmarks: string;
    processed: string;
    transcripts: string;
    knowledgeBase: string;
    stateFile: string;
    failed: string;
  };
  categories: {
    REVIEW: 'review';
    TRY: 'try';
    KNOWLEDGE: 'knowledge';
    LIFE: 'life';
    SKIP: 'skip';
  };
  contentTypes: {
    TOOL: 'tool';
    PROMPT: 'prompt';
    TECHNIQUE: 'technique';
    WORKFLOW: 'workflow';
    TUTORIAL: 'tutorial';
    REFERENCE: 'reference';
    ANNOUNCEMENT: 'announcement';
    NEWS: 'news';
    RESEARCH: 'research';
    DATASET: 'dataset';
    BENCHMARK: 'benchmark';
    OPINION: 'opinion';
    OTHER: 'other';
  };
  llm: LLMConfig;
  budget: BudgetConfig;
  failure: FailureConfig;
  filters: FilterConfig;
  retries: RetryConfig;
  rateLimit: RateLimitConfig;
  security: SecurityConfig;
}

// ============================================
// Utility function to extract tweet ID
// ============================================

/**
 * Get the tweet ID from a bookmark, handling both raw and enriched formats
 */
export function getTweetId(bookmark: { tweetId?: string; id?: string }): string {
  const id = bookmark.tweetId ?? bookmark.id;
  if (!id) {
    throw new Error('Bookmark has no tweetId or id');
  }
  return id;
}
