/**
 * Content Extractor
 *
 * Extracts and enriches content from bookmarks.
 * Handles YouTube transcripts, articles, and URL extraction.
 */

import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { getAccountByUsername } from './accounts.js';
import { config } from './config.js';
import { fetchConversationContext } from './context-fetcher.js';
import { readTweet } from './integrations/bird-runner.js';
import type {
  BirdCredentials,
  ContentInfo,
  EnrichedBookmark,
  EnrichmentError,
  ExtractedArticle,
  ExtractedTranscript,
  RawBirdBookmark,
} from './types.js';
import { toErrorMessage } from './utils/errors.js';
import { withRetries } from './utils/retry.js';
import { safeFetch, validateUrl } from './utils/safe-fetch.js';
import { extractTweetIdFromUrl, extractUrlsFromText } from './utils/url.js';

/**
 * URL patterns for content classification
 */
const URL_PATTERNS = {
  youtube: /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  podcast: /(?:podcasts\.apple\.com|open\.spotify\.com\/episode|overcast\.fm|pocketcasts\.com)/,
  github: /github\.com\/[^/]+\/[^/]+/,
  twitter: /(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/,
};

const MIN_FALLBACK_CHARS = 120;

const accountCache = new Map<string, BirdCredentials>();

const RETRY_OPTIONS = {
  maxAttempts: config.retries.maxAttempts,
  baseDelayMs: config.retries.baseDelayMs,
  jitterMs: config.retries.jitterMs,
};

function logRetry(label: string, attempt: number, error: unknown, delayMs: number): void {
  const delaySeconds = Math.round(delayMs / 1000);
  console.warn(`    [Retry] ${label} attempt ${attempt + 1} in ${delaySeconds}s: ${toErrorMessage(error)}`);
}

async function getCredentialsForAccount(accountName?: string): Promise<BirdCredentials | null> {
  if (!accountName) return null;

  if (accountCache.has(accountName)) {
    return accountCache.get(accountName) ?? null;
  }

  const account = await getAccountByUsername(accountName);
  if (!account) return null;

  const credentials = { authToken: account.authToken, ct0: account.ct0 };
  accountCache.set(accountName, credentials);
  return credentials;
}

async function fetchTwitterStatusContent(
  tweetUrl: string,
  accountName?: string
): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
  const credentials = await getCredentialsForAccount(accountName);
  if (!credentials) {
    return { success: false, error: 'Missing Twitter credentials for tweet fetch' };
  }

  const result = await withRetries(
    () => readTweet(config.birdPath, credentials, tweetUrl, { quoteDepth: 1, account: accountName }),
    {
      ...RETRY_OPTIONS,
      shouldRetry: (value) => !value.success,
      getRetryError: (value) => new Error(value.error || 'Failed to fetch tweet'),
      onRetry: (attempt, error, delayMs) => logRetry('tweet fetch', attempt, error, delayMs),
    }
  );
  if (!result.success || !result.tweet) {
    return { success: false, error: result.error || 'Failed to fetch tweet' };
  }

  const content = result.tweet.text?.trim();
  if (!content) {
    return { success: false, error: 'Tweet text missing' };
  }

  const author = result.tweet.author?.username;
  const title = author ? `Tweet by @${author}` : 'Tweet';

  return { success: true, title, content };
}


/**
 * Extract URLs from bookmark, preferring entities.urls.expanded_url
 * Falls back to regex extraction from text
 */
export function extractUrls(bookmark: RawBirdBookmark): string[] {
  const urls = new Set<string>();

  // Prefer expanded URLs from entities (these are the real URLs, not t.co shortened)
  if (bookmark.entities?.urls) {
    for (const urlEntity of bookmark.entities.urls) {
      if (urlEntity.expanded_url) {
        urls.add(urlEntity.expanded_url);
      } else if (urlEntity.url) {
        urls.add(urlEntity.url);
      }
    }
  }

  // Also extract from text for any URLs not in entities
  const textUrls = extractUrlsFromText(bookmark.text);
  for (const url of textUrls) {
    // Skip t.co URLs if we already have expanded versions
    if (url.startsWith('https://t.co/') && urls.size > 0) {
      continue;
    }
    urls.add(url);
  }

  return Array.from(urls);
}

/**
 * Classify content type from URLs
 */
function classifyUrls(urls: string[]): ContentInfo[] {
  const contents: ContentInfo[] = [];

  for (const url of urls) {
    // YouTube
    const ytMatch = url.match(URL_PATTERNS.youtube);
    if (ytMatch) {
      contents.push({ url, type: 'youtube', videoId: ytMatch[1] });
      continue;
    }

    // Podcast
    if (URL_PATTERNS.podcast.test(url)) {
      contents.push({ url, type: 'podcast' });
      continue;
    }

    // GitHub
    if (URL_PATTERNS.github.test(url)) {
      contents.push({ url, type: 'github' });
      continue;
    }

    // Twitter/X status
    if (URL_PATTERNS.twitter.test(url)) {
      contents.push({ url, type: 'twitter' });
      continue;
    }

    // Default to article
    contents.push({ url, type: 'article' });
  }

  return contents;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isLowValueText(text: string): boolean {
  const lower = text.toLowerCase();
  return /(enable javascript|turn on javascript|cookies|captcha|cloudflare|privacy policy|terms of service|sign in|sign up)/.test(
    lower
  );
}

function extractMetaSummary($: cheerio.CheerioAPI): { title: string; summary: string } {
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    $('title').text();
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  const summary = [title, description].filter(Boolean).join(' — ');
  return { title: normalizeText(title || ''), summary: normalizeText(summary) };
}

function isTwitterStatusUrl(url: string): boolean {
  return URL_PATTERNS.twitter.test(url);
}

function getArticleFromBookmark(bookmark: RawBirdBookmark, url: string): ExtractedArticle | null {
  if (!bookmark.article?.text) return null;

  if (!url.includes('/i/article/')) {
    return null;
  }

  const content = normalizeText(bookmark.article.text).slice(0, config.budget.maxArticleChars);
  if (!content) return null;

  return {
    url,
    title: bookmark.article.title || 'X Article',
    content,
  };
}

async function fetchTweetOembed(tweetUrl: string): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
  const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}`;
  const result = await withRetries(
    () => safeFetch(endpoint, { timeout: 12_000, maxBytes: 300_000 }),
    {
      ...RETRY_OPTIONS,
      shouldRetry: (value) => !value.success,
      getRetryError: (value) => new Error(value.error || 'oEmbed fetch failed'),
      onRetry: (attempt, error, delayMs) => logRetry('tweet oEmbed', attempt, error, delayMs),
    }
  );
  if (!result.success || !result.data) {
    return { success: false, error: result.error || 'oEmbed fetch failed' };
  }

  try {
    const parsed = JSON.parse(result.data);
    const html = parsed.html || '';
    if (!html) {
      return { success: false, error: 'oEmbed HTML missing' };
    }
    const $ = cheerio.load(html);
    const text = normalizeText($('p').text() || $.text());
    const author = normalizeText(parsed.author_name || '');
    const title = author ? `Tweet by ${author}` : 'Tweet';

    if (!text) {
      return { success: false, error: 'oEmbed text missing' };
    }

    return { success: true, title, content: text };
  } catch (e) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Fetch YouTube transcript
 */
async function fetchYouTubeTranscript(videoId: string): Promise<{ success: boolean; transcript?: string; error?: string }> {
  try {
    const transcript = await withRetries(
      () => YoutubeTranscript.fetchTranscript(videoId),
      {
        ...RETRY_OPTIONS,
        onRetry: (attempt, error, delayMs) => logRetry(`transcript ${videoId}`, attempt, error, delayMs),
      }
    );

    if (!transcript || transcript.length === 0) {
      return { success: false, error: 'No transcript available' };
    }

    // Combine transcript segments
    const text = transcript.map((segment) => segment.text).join(' ');

    // Truncate if needed
    const truncated = text.slice(0, config.budget.maxTranscriptChars);

    return { success: true, transcript: truncated };
  } catch (e) {
    return { success: false, error: toErrorMessage(e) };
  }
}

// Content types that can be parsed as HTML
const PARSEABLE_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain', // Some servers misconfigure this
];

/**
 * Fetch and extract article content
 */
export async function fetchArticleContent(
  url: string
): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
  // Validate URL first (SSRF protection)
  const validation = validateUrl(url);
  if (!validation.valid) {
    console.error(`  Blocked URL: ${validation.error}`);
    return { success: false, error: validation.error };
  }

  try {
    const targetUrl = url;
    const isTwitterUrl = isTwitterStatusUrl(targetUrl);
    let oembedAttempted = false;

    if (isTwitterUrl) {
      oembedAttempted = true;
      const tweet = await fetchTweetOembed(targetUrl);
      if (tweet.success && tweet.content) {
        return {
          success: true,
          title: tweet.title || 'Tweet',
          content: tweet.content.slice(0, config.budget.maxArticleChars),
        };
      }
    }

    // Limit article fetch size to prevent memory issues
    const result = await withRetries(
      () =>
        safeFetch(targetUrl, {
          timeout: 15_000,
          maxBytes: config.budget.maxArticleChars * 10, // Allow extra for HTML overhead
        }),
      {
        ...RETRY_OPTIONS,
        shouldRetry: (value) => !value.success,
        getRetryError: (value) => new Error(value.error || 'Article fetch failed'),
        onRetry: (attempt, error, delayMs) => logRetry('article fetch', attempt, error, delayMs),
      }
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const finalUrl = result.finalUrl || targetUrl;

    // Check content type - reject non-HTML content
    const contentType = (result.contentType || '').toLowerCase().split(';')[0]?.trim() || '';
    const isParseableType = PARSEABLE_CONTENT_TYPES.some(type => contentType.includes(type));

    if (contentType && !isParseableType) {
      return {
        success: false,
        error: `Unsupported content type: ${contentType} (expected HTML)`
      };
    }

    const $ = cheerio.load(result.data!);

    if (!oembedAttempted && isTwitterStatusUrl(finalUrl)) {
      const tweet = await fetchTweetOembed(finalUrl);
      if (tweet.success && tweet.content) {
        return {
          success: true,
          title: tweet.title || 'Tweet',
          content: tweet.content.slice(0, config.budget.maxArticleChars),
        };
      }
    }

    // Remove script, style, nav, footer elements
    $('script, style, nav, footer, aside, .ad, .advertisement').remove();

    // Try to find main content
    const mainContent =
      $('article').text() ||
      $('main').text() ||
      $('[role="main"]').text() ||
      $('.post-content').text() ||
      $('.entry-content').text() ||
      $('body').text();

    const meta = extractMetaSummary($);
    const title = meta.title || $('h1').first().text().trim() || $('title').text().trim() || 'Untitled';

    // Clean and truncate content
    let content = normalizeText(mainContent).slice(0, config.budget.maxArticleChars);
    if (content.length < MIN_FALLBACK_CHARS || isLowValueText(content)) {
      if (meta.summary.length > content.length) {
        content = meta.summary.slice(0, config.budget.maxArticleChars);
      }
    }

    if (!content) {
      return { success: false, error: 'No content extracted' };
    }

    return { success: true, title, content };
  } catch (e) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Analyze a bookmark and extract basic metadata
 */
export function analyzeBookmark(bookmark: RawBirdBookmark): {
  urls: string[];
  contents: ContentInfo[];
  hasVideo: boolean;
  hasPodcast: boolean;
  hasGithub: boolean;
  hasArticle: boolean;
  hasTweetLinks: boolean;
  hasImages: boolean;
  isReply: boolean;
  isPartOfThread: boolean;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
} {
  const urls = extractUrls(bookmark);
  const contents = classifyUrls(urls);

  return {
    urls,
    contents,
    hasVideo: contents.some((c) => c.type === 'youtube'),
    hasPodcast: contents.some((c) => c.type === 'podcast'),
    hasGithub: contents.some((c) => c.type === 'github'),
    hasArticle: contents.some((c) => c.type === 'article') || !!bookmark.article?.text,
    hasTweetLinks: contents.some((c) => c.type === 'twitter'),
    hasImages: !!bookmark.media && bookmark.media.length > 0,
    isReply: !!bookmark.inReplyToStatusId,
    isPartOfThread: !!bookmark.conversationId && bookmark.conversationId !== bookmark.id,
    likeCount: bookmark.likeCount ?? 0,
    retweetCount: bookmark.retweetCount ?? 0,
    replyCount: bookmark.replyCount ?? 0,
  };
}

/**
 * Enrich a bookmark with extracted content
 */
export async function enrichBookmark(bookmark: RawBirdBookmark): Promise<EnrichedBookmark> {
  const analysis = analyzeBookmark(bookmark);
  const transcripts: ExtractedTranscript[] = [];
  const articles: ExtractedArticle[] = [];
  const enrichmentErrors: EnrichmentError[] = [];
  const seenArticleUrls = new Set<string>();
  const shouldSkipTweetUrl = (url: string): boolean => {
    const tweetId = extractTweetIdFromUrl(url);
    return !!tweetId && tweetId === bookmark.id;
  };

  // Fetch YouTube transcripts
  for (const content of analysis.contents) {
    if (content.type === 'youtube' && content.videoId) {
      console.log(`    Fetching transcript for ${content.videoId}...`);
      const result = await fetchYouTubeTranscript(content.videoId);
      if (result.success && result.transcript) {
        transcripts.push({
          videoId: content.videoId,
          url: content.url,
          transcript: result.transcript,
        });
      } else if (result.error) {
        enrichmentErrors.push({
          url: content.url,
          errorType: 'transcript',
          message: result.error,
        });
      }
    }
  }

  // Fetch Twitter/X status content via Bird (limited to first 2)
  const twitterContents = analysis.contents.filter((c) => c.type === 'twitter').slice(0, 2);
  for (const content of twitterContents) {
    if (seenArticleUrls.has(content.url) || shouldSkipTweetUrl(content.url)) {
      continue;
    }

    console.log(`    Fetching tweet: ${content.url.slice(0, 50)}...`);
    const result = await fetchTwitterStatusContent(content.url, bookmark._account);
    if (result.success && result.content) {
      articles.push({
        url: content.url,
        title: result.title || 'Tweet',
        content: result.content.slice(0, config.budget.maxArticleChars),
      });
      seenArticleUrls.add(content.url);
      continue;
    }

    if (result.error) {
      console.warn(`    Tweet fetch failed: ${result.error}`);
    }

    const fallback = await fetchArticleContent(content.url);
    if (fallback.success && fallback.content) {
      articles.push({
        url: content.url,
        title: fallback.title || 'Tweet',
        content: fallback.content,
      });
      seenArticleUrls.add(content.url);
    } else {
      enrichmentErrors.push({
        url: content.url,
        errorType: 'tweet',
        message: result.error ?? fallback.error ?? 'Tweet enrichment failed',
      });
      if (fallback.error) {
        console.warn(`    Tweet fallback fetch failed: ${fallback.error}`);
      }
    }
  }

  // Fetch article content (limited to first 2 articles)
  const articleContents = analysis.contents.filter((c) => c.type === 'article').slice(0, 2);
  for (const content of articleContents) {
    if (seenArticleUrls.has(content.url)) {
      continue;
    }

    const articleFromTweet = getArticleFromBookmark(bookmark, content.url);
    if (articleFromTweet) {
      articles.push(articleFromTweet);
      seenArticleUrls.add(content.url);
      continue;
    }

    console.log(`    Fetching article: ${content.url.slice(0, 50)}...`);
    const result = await fetchArticleContent(content.url);
    if (result.success && result.content) {
      articles.push({
        url: content.url,
        title: result.title || 'Untitled',
        content: result.content,
      });
      seenArticleUrls.add(content.url);
    } else if (result.error) {
      enrichmentErrors.push({
        url: content.url,
        errorType: 'article',
        message: result.error,
      });
    }
  }

  // Extract article directly from bookmark.article when available (fallback for t.co links)
  if (bookmark.article?.text && articles.length === 0) {
    const content = normalizeText(bookmark.article.text).slice(0, config.budget.maxArticleChars);
    if (content) {
      articles.push({
        url: analysis.urls[0] || `https://x.com/i/article/${bookmark.id}`,
        title: bookmark.article.title || 'X Article',
        content,
      });
    }
  }

  // Fetch thread context for additional conversation signal
  console.log('    Fetching thread context...');
  const threadContext = await fetchConversationContext(bookmark);

  const resolvedIsPartOfThread = analysis.isPartOfThread || (threadContext?.authorThread?.length ?? 0) > 1;

  // Extract articles from thread context when main bookmark has no articles
  if (threadContext && articles.length === 0) {
    const extractArticleFromTweet = (tweet: RawBirdBookmark): ExtractedArticle | null => {
      if (!tweet.article?.text) return null;
      const content = normalizeText(tweet.article.text).slice(0, config.budget.maxArticleChars);
      if (!content) return null;
      return {
        url: `https://x.com/${tweet.author.username}/status/${tweet.id}`,
        title: tweet.article.title || 'X Article',
        content,
      };
    };

    // Check authorThread for articles
    for (const tweet of threadContext.authorThread || []) {
      const article = extractArticleFromTweet(tweet);
      if (article) {
        articles.push(article);
        break; // Only extract first article found
      }
    }

    // Check quotedTweet if still no articles
    if (articles.length === 0 && threadContext.quotedTweet) {
      const article = extractArticleFromTweet(threadContext.quotedTweet);
      if (article) articles.push(article);
    }

    // Check referencedTweet if still no articles
    if (articles.length === 0 && threadContext.referencedTweet) {
      const article = extractArticleFromTweet(threadContext.referencedTweet);
      if (article) articles.push(article);
    }

    // Check parentChain if still no articles
    if (articles.length === 0) {
      for (const tweet of threadContext.parentChain || []) {
        const article = extractArticleFromTweet(tweet);
        if (article) {
          articles.push(article);
          break;
        }
      }
    }

    // Check topReplies if still no articles (least priority - replies may have related articles)
    if (articles.length === 0) {
      for (const tweet of threadContext.topReplies || []) {
        const article = extractArticleFromTweet(tweet);
        if (article) {
          articles.push(article);
          break;
        }
      }
    }
  }

  return {
    tweetId: bookmark.id,
    id: bookmark.id,
    text: bookmark.text,
    author: bookmark.author,
    createdAt: bookmark.createdAt,
    likeCount: analysis.likeCount,
    retweetCount: analysis.retweetCount,
    replyCount: analysis.replyCount,
    urls: analysis.urls,
    isReply: analysis.isReply,
    isPartOfThread: resolvedIsPartOfThread,
    conversationId: bookmark.conversationId,
    inReplyToStatusId: bookmark.inReplyToStatusId,
    threadContext,
    transcripts,
    articles,
    enrichmentErrors: enrichmentErrors.length > 0 ? enrichmentErrors : undefined,
    _account: bookmark._account || 'unknown',
    media: bookmark.media,
    contents: analysis.contents,
    hasVideo: analysis.hasVideo,
    hasPodcast: analysis.hasPodcast,
    hasGithub: analysis.hasGithub,
    hasArticle: analysis.hasArticle || articles.length > 0, // Include articles found in thread context
    hasTweetLinks: analysis.hasTweetLinks,
    hasImages: analysis.hasImages,
  };
}
