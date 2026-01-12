/**
 * Bird CLI Runner
 *
 * Executes the Bird CLI (@steipete/bird) as a subprocess and parses its output.
 * Bird is a Twitter/X API client that provides bookmark access.
 */

import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import type {
  BirdCredentials,
  BirdOptions,
  BirdResult,
  RawBirdBookmark,
  TwitterArticle,
  TwitterEntities,
  TwitterMediaItem,
  TwitterUrlEntity,
  ValidateCredentialsResult,
} from '../types.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_TIMEOUT = 60_000;

interface BirdTweetMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  previewUrl?: string;
}

interface BirdTweetData {
  id: string;
  text: string;
  author: {
    username: string;
    name: string;
  };
  authorId?: string;
  createdAt?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  conversationId?: string;
  inReplyToStatusId?: string;
  quotedTweet?: BirdTweetData;
  media?: BirdTweetMedia[];
  entities?: TwitterEntities;
  /** Article metadata from Bird v0.7+ (title and preview) */
  article?: {
    title: string;
    previewText?: string;
  };
  _raw?: unknown;
}

function normalizeBirdMedia(media?: BirdTweetMedia[]): TwitterMediaItem[] | undefined {
  if (!media || media.length === 0) return undefined;
  return media.map((item) => ({
    type: item.type,
    url: item.url,
    previewUrl: item.previewUrl,
  }));
}

interface RawUrlEntity {
  url?: string;
  expanded_url?: string;
  expandedUrl?: string;
  display_url?: string;
  displayUrl?: string;
  indices?: number[];
  start?: number;
  end?: number;
}

function normalizeUrlEntity(entity: RawUrlEntity): TwitterUrlEntity | null {
  const url = entity.url ?? entity.expanded_url ?? entity.expandedUrl;
  if (!url || typeof url !== 'string') return null;

  const expandedUrl = entity.expanded_url ?? entity.expandedUrl ?? url;
  const displayUrl = entity.display_url ?? entity.displayUrl ?? expandedUrl;
  const start = entity.indices?.[0] ?? entity.start ?? 0;
  const end = entity.indices?.[1] ?? entity.end ?? start;

  return {
    url,
    expanded_url: expandedUrl,
    display_url: displayUrl,
    start,
    end,
  };
}

function extractUrlEntities(raw?: unknown): TwitterEntities | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const legacy = (raw as { legacy?: { entities?: { urls?: RawUrlEntity[] } } }).legacy;
  const urls = legacy?.entities?.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return undefined;
  }

  const normalized = urls.map(normalizeUrlEntity).filter((entity): entity is TwitterUrlEntity => !!entity);
  return normalized.length > 0 ? { urls: normalized } : undefined;
}

/**
 * Extract article from Bird's public output.
 * Bird v0.7+ processes Draft.js content internally - when article metadata exists,
 * tweet.text already contains the full rendered article content.
 */
function extractArticle(tweet: BirdTweetData): TwitterArticle | undefined {
  if (!tweet.article) return undefined;

  const title = tweet.article.title;
  let text = tweet.text;

  // Bird's rendered text includes the title as a heading - strip it to avoid
  // duplication when downstream code displays title + content separately
  if (text.startsWith(title)) {
    text = text.slice(title.length).replace(/^\n+/, '');
  }

  return { title, text };
}

export function normalizeBirdBookmark(tweet: BirdTweetData, account?: string): RawBirdBookmark {
  const authorId = tweet.authorId || tweet.author.username;
  const entities = tweet.entities ?? extractUrlEntities(tweet._raw);
  const article = extractArticle(tweet);

  return {

    id: tweet.id,
    text: tweet.text,
    author: {
      id: authorId,
      username: tweet.author.username,
      name: tweet.author.name,
    },
    createdAt: tweet.createdAt ?? '',
    conversationId: tweet.conversationId,
    inReplyToStatusId: tweet.inReplyToStatusId,
    likeCount: tweet.likeCount,
    retweetCount: tweet.retweetCount,
    replyCount: tweet.replyCount,
    quotedTweet: tweet.quotedTweet ? normalizeBirdBookmark(tweet.quotedTweet, account) : undefined,
    media: normalizeBirdMedia(tweet.media),
    entities,
    article,
    _account: account,
  };
}

/**
 * Determine how to run Bird CLI.
 * Prefers built dist if available, otherwise uses tsx with source.
 */
function getBirdCommand(birdPath: string): { command: string; args: string[] } {
  const distCli = join(birdPath, 'dist', 'cli.js');
  const srcCli = join(birdPath, 'src', 'cli.ts');

  if (existsSync(distCli)) {
    return { command: 'node', args: [distCli] };
  } else if (existsSync(srcCli)) {
    return { command: 'npx', args: ['tsx', srcCli] };
  }

  // Fallback to npm script
  return { command: 'npm', args: ['run', 'start', '--'] };
}

/**
 * Kill a process and its children with escalation
 */
function killProcess(proc: ReturnType<typeof spawn>, useProcessGroup: boolean): void {
  // First try SIGTERM
  try {
    if (useProcessGroup && proc.pid) {
      // Kill the entire process group on POSIX
      process.kill(-proc.pid, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // Process might already be dead
    return;
  }

  // Escalate to SIGKILL after a grace period
  setTimeout(() => {
    try {
      if (useProcessGroup && proc.pid) {
        process.kill(-proc.pid, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch {
      // Process already dead
    }
  }, 2000); // 2 second grace period
}

/**
 * Run a Bird CLI command
 */
export async function runBird(
  birdPath: string,
  subcommand: string,
  subcommandArgs: string[],
  options: BirdOptions
): Promise<BirdResult> {
  const {
    authToken,
    ct0,
    timeout = DEFAULT_TIMEOUT,
    cwd,
    globalArgs = [],
    expectJson = true,
  } = options;

  const resolvedPath = resolve(process.cwd(), birdPath);

  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      json: null,
      exitCode: -1,
      errorType: 'bird_not_found',
      errorMessage: `Bird not found at ${resolvedPath}`,
    };
  }

  const { command, args: baseArgs } = getBirdCommand(resolvedPath);

  // Build full command
  const fullArgs = [...baseArgs, ...globalArgs, subcommand, ...subcommandArgs];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

  const useProcessGroup = process.platform !== 'win32';
  const spawnOpts: SpawnOptionsWithoutStdio = {
    cwd: cwd || resolvedPath,
    detached: useProcessGroup,
    env: {
      ...process.env,
      AUTH_TOKEN: authToken,
      CT0: ct0,
    },
  };

    const proc = spawn(command, fullArgs, spawnOpts);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(proc, useProcessGroup);
    }, timeout);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        json: null,
        exitCode: -1,
        errorType: 'spawn_error',
        errorMessage: toErrorMessage(err),
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr,
          json: null,
          exitCode: code ?? -1,
          errorType: 'timeout',
          errorMessage: `Command timed out after ${timeout}ms`,
        });
        return;
      }

      if (!expectJson) {
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          json: null,
          exitCode: code ?? -1,
          errorType: code === 0 ? 'none' : 'exit_error',
          errorMessage: code === 0 ? '' : (stderr.trim() || stdout.trim() || `Exit code ${code}`),
        });
        return;
      }

      // Try to parse JSON from stdout
      let json: unknown = null;
      let parseError = false;

      // Find JSON in output (may have WARN: lines before it, or leading whitespace)
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trimStart();
        if (line.startsWith('{') || line.startsWith('[')) {
          try {
            // Try to parse from this line onwards
            const remainingContent = lines.slice(i).join('\n').trimStart();
            json = JSON.parse(remainingContent);
            break;
          } catch {
            parseError = true;
          }
        }
      }

      // Detect error types from output
      let errorType = 'unknown';
      let errorMessage = '';

      if (code !== 0 || !json) {
        if (stderr.includes('Rate limit') || stdout.includes('Rate limit')) {
          errorType = 'rate_limit';
          errorMessage = 'Twitter API rate limit exceeded';
        } else if (stderr.includes('Authentication') || stderr.includes('401')) {
          errorType = 'auth_error';
          errorMessage = 'Authentication failed - check credentials';
        } else if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT')) {
          errorType = 'network_error';
          errorMessage = 'Network error - check internet connection';
        } else if (parseError) {
          errorType = 'parse_error';
          errorMessage = 'Failed to parse Bird output as JSON';
        } else {
          errorMessage = stderr.trim() || stdout.trim() || `Exit code ${code}`;
        }
      }

      resolve({
        ok: code === 0 && json !== null,
        stdout,
        stderr,
        json,
        exitCode: code ?? -1,
        errorType,
        errorMessage,
      });
    });
  });
}

interface BookmarksResponse {
  tweets?: RawBirdBookmark[];
  nextCursor?: string | null;
}

/**
 * Fetch bookmarks using Bird CLI
 */
export async function fetchBookmarks(
  birdPath: string,
  credentials: BirdCredentials,
  count: number,
  cursor?: string | null
): Promise<{ success: boolean; bookmarks: RawBirdBookmark[]; nextCursor: string | null; error?: string; errorType?: string }> {
  const pageSize = 20;
  const targetCount = Number.isFinite(count) && count > 0 ? count : pageSize;
  const maxPages = Math.max(1, Math.ceil(targetCount / pageSize));
  const seen = new Set<string>();
  const bookmarks: RawBirdBookmark[] = [];
  let nextCursor: string | null = cursor ?? null;
  let currentCursor = cursor ?? null;

  for (let page = 0; page < maxPages; page++) {
    const args = ['--all', '--max-pages', '1', '--json-full'];
    if (currentCursor) {
      args.push('--cursor', currentCursor);
    }

    const result = await runBird(birdPath, 'bookmarks', args, {
      authToken: credentials.authToken,
      ct0: credentials.ct0,
    });

    // Handle "No bookmarks found" as success with empty list
    if (result.stdout.includes('No bookmarks found')) {
      return { success: true, bookmarks: [], nextCursor: null };
    }

    if (!result.ok) {
      return {
        success: false,
        bookmarks: [],
        nextCursor: null,
        error: result.errorMessage,
        errorType: result.errorType,
      };
    }

    const data = result.json as BookmarksResponse | null;
    const pageTweets = data?.tweets || [];
    const pageCursor = data?.nextCursor || null;

    for (const tweet of pageTweets) {
      if (!tweet?.id) {
        console.warn('Skipping bookmark without tweet id from Bird response.');
        continue;
      }
      if (seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      bookmarks.push(normalizeBirdBookmark(tweet as BirdTweetData));
      if (bookmarks.length >= targetCount) {
        break;
      }
    }

    if (!pageCursor || pageTweets.length === 0) {
      nextCursor = null;
      break;
    }

    if (pageCursor === currentCursor) {
      nextCursor = pageCursor;
      break;
    }

    nextCursor = pageCursor;
    currentCursor = pageCursor;

    if (bookmarks.length >= targetCount) {
      break;
    }
  }

  return { success: true, bookmarks, nextCursor };
}

export async function readTweet(
  birdPath: string,
  credentials: BirdCredentials,
  tweetIdOrUrl: string,
  options?: { quoteDepth?: number; account?: string }
): Promise<{ success: boolean; tweet?: RawBirdBookmark; error?: string; errorType?: string }> {
  const globalArgs: string[] = [];
  if (options?.quoteDepth !== undefined) {
    globalArgs.push('--quote-depth', String(options.quoteDepth));
  }

  const result = await runBird(birdPath, 'read', [tweetIdOrUrl, '--json-full'], {
    authToken: credentials.authToken,
    ct0: credentials.ct0,
    globalArgs,
  });

  if (!result.ok) {
    return { success: false, error: result.errorMessage, errorType: result.errorType };
  }

  const data = result.json as BirdTweetData | null;
  if (!data) {
    return { success: false, error: 'Empty tweet response', errorType: 'parse_error' };
  }

  return { success: true, tweet: normalizeBirdBookmark(data, options?.account) };
}

export async function fetchThread(
  birdPath: string,
  credentials: BirdCredentials,
  tweetIdOrUrl: string,
  options?: { quoteDepth?: number; account?: string }
): Promise<{ success: boolean; tweets: RawBirdBookmark[]; error?: string; errorType?: string }> {
  const globalArgs: string[] = [];
  if (options?.quoteDepth !== undefined) {
    globalArgs.push('--quote-depth', String(options.quoteDepth));
  }

  const result = await runBird(birdPath, 'thread', [tweetIdOrUrl, '--json-full'], {
    authToken: credentials.authToken,
    ct0: credentials.ct0,
    globalArgs,
  });

  if (!result.ok) {
    return { success: false, tweets: [], error: result.errorMessage, errorType: result.errorType };
  }

  const data = result.json as BirdTweetData[] | null;
  if (!Array.isArray(data)) {
    return { success: false, tweets: [], error: 'Invalid thread response', errorType: 'parse_error' };
  }

  const tweets = data.map((tweet) => normalizeBirdBookmark(tweet, options?.account));
  return { success: true, tweets };
}

export async function fetchReplies(
  birdPath: string,
  credentials: BirdCredentials,
  tweetIdOrUrl: string,
  options?: { quoteDepth?: number; account?: string }
): Promise<{ success: boolean; tweets: RawBirdBookmark[]; error?: string; errorType?: string }> {
  const globalArgs: string[] = [];
  if (options?.quoteDepth !== undefined) {
    globalArgs.push('--quote-depth', String(options.quoteDepth));
  }

  const result = await runBird(birdPath, 'replies', [tweetIdOrUrl, '--json-full'], {
    authToken: credentials.authToken,
    ct0: credentials.ct0,
    globalArgs,
  });

  if (!result.ok) {
    return { success: false, tweets: [], error: result.errorMessage, errorType: result.errorType };
  }

  const data = result.json as BirdTweetData[] | null;
  if (!Array.isArray(data)) {
    return { success: false, tweets: [], error: 'Invalid replies response', errorType: 'parse_error' };
  }

  const tweets = data.map((tweet) => normalizeBirdBookmark(tweet, options?.account));
  return { success: true, tweets };
}

function parseWhoAmI(output: string): { username: string; name: string; userId: string } | null {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const userLine = lines.find((line) => line.startsWith('user:'));
  const userIdLine = lines.find((line) => line.startsWith('user_id:'));

  if (!userLine || !userIdLine) {
    return null;
  }

  const userMatch = userLine.match(/^user:\s*@([^\s]+)\s*\((.*)\)\s*$/);
  const idMatch = userIdLine.match(/^user_id:\s*(\S+)/);

  if (!userMatch || !idMatch) {
    return null;
  }

  return {
    username: userMatch[1],
    name: userMatch[2],
    userId: idMatch[1],
  };
}

/**
 * Validate credentials by fetching the current user's profile
 */
export async function validateCredentials(birdPath: string, credentials: BirdCredentials): Promise<ValidateCredentialsResult> {
  const result = await runBird(birdPath, 'whoami', [], {
    authToken: credentials.authToken,
    ct0: credentials.ct0,
    timeout: 30_000,
    globalArgs: ['--plain'],
    expectJson: false,
  });

  if (!result.ok) {
    return { valid: false, error: result.errorMessage };
  }

  const data = parseWhoAmI(result.stdout);
  if (!data) {
    return { valid: false, error: 'Invalid whoami response from Bird' };
  }

  return {
    valid: true,
    username: data.username,
    name: data.name,
    userId: data.userId,
  };
}
