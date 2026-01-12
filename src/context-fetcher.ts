/**
 * Context Fetcher
 *
 * Fetches conversation context for tweets that are replies or part of threads.
 */

import { getAccountByUsername } from './accounts.js';
import { config } from './config.js';
import { fetchReplies, fetchThread, readTweet } from './integrations/bird-runner.js';
import type { Account, BirdCredentials, RawBirdBookmark, ThreadContext } from './types.js';
import { collectUrlCandidates, extractTweetIdFromUrl } from './utils/url.js';

const accountCache = new Map<string, Account>();
const QUOTE_DEPTH = 2;

function ensureAuthorId(tweet: RawBirdBookmark): RawBirdBookmark {
  if (tweet.author?.id) return tweet;
  return {
    ...tweet,
    author: {
      ...tweet.author,
      id: tweet.author?.username || 'unknown',
    },
  };
}

async function getCredentialsForAccount(accountName: string): Promise<BirdCredentials | null> {
  if (!accountName) return null;
  if (accountCache.has(accountName)) {
    const cached = accountCache.get(accountName);
    return cached ? { authToken: cached.authToken, ct0: cached.ct0 } : null;
  }

  const account = await getAccountByUsername(accountName);
  if (!account) return null;
  accountCache.set(accountName, account);
  return { authToken: account.authToken, ct0: account.ct0 };
}


function findReferencedTweetId(bookmark: RawBirdBookmark): string | null {
  const candidates = collectUrlCandidates(bookmark.entities?.urls, bookmark.text);
  for (const candidate of candidates) {
    const tweetId = extractTweetIdFromUrl(candidate);
    if (tweetId && tweetId !== bookmark.id) return tweetId;
  }
  return null;
}

function buildParentChainFromIndex(
  target: RawBirdBookmark,
  index: Map<string, RawBirdBookmark>,
  maxDepth: number
): { chain: RawBirdBookmark[]; nextMissingId?: string } {
  const chain: RawBirdBookmark[] = [];
  let currentId = target.inReplyToStatusId;
  while (currentId && chain.length < maxDepth) {
    const parent = index.get(currentId);
    if (!parent) {
      return { chain, nextMissingId: currentId };
    }
    chain.push(parent);
    currentId = parent.inReplyToStatusId;
  }
  return { chain, nextMissingId: currentId ?? undefined };
}

function trimThreadAroundTarget(tweets: RawBirdBookmark[], targetId: string, maxDepth: number): RawBirdBookmark[] {
  if (tweets.length <= maxDepth) return tweets;
  const targetIndex = tweets.findIndex((tweet) => tweet.id === targetId);
  if (targetIndex === -1) return tweets.slice(0, maxDepth);

  const half = Math.floor(maxDepth / 2);
  let start = Math.max(0, targetIndex - half);
  let end = start + maxDepth;
  if (end > tweets.length) {
    end = tweets.length;
    start = Math.max(0, end - maxDepth);
  }
  return tweets.slice(start, end);
}

async function fetchParentChainViaRead(
  birdPath: string,
  credentials: BirdCredentials,
  startId: string,
  maxDepth: number,
  seen: Set<string>,
  account?: string
): Promise<RawBirdBookmark[]> {
  const chain: RawBirdBookmark[] = [];
  let currentId: string | undefined = startId;

  while (currentId && chain.length < maxDepth) {
    if (seen.has(currentId)) break;
    const parentResult = await readTweet(birdPath, credentials, currentId, { quoteDepth: QUOTE_DEPTH, account });
    if (!parentResult.success || !parentResult.tweet) break;
    const parent = ensureAuthorId(parentResult.tweet);
    chain.push(parent);
    seen.add(parent.id);
    currentId = parent.inReplyToStatusId;
  }

  return chain;
}

/**
 * Fetch conversation context for a bookmark
 */
export async function fetchConversationContext(bookmark: RawBirdBookmark): Promise<ThreadContext | null> {
  const accountName = bookmark._account;
  if (!accountName) return null;

  const credentials = await getCredentialsForAccount(accountName);
  if (!credentials) return null;

  const birdPath = config.birdPath;
  let mainTweet = ensureAuthorId(bookmark);

  const readResult = await readTweet(birdPath, credentials, bookmark.id, {
    quoteDepth: QUOTE_DEPTH,
    account: accountName,
  });
  if (readResult.success && readResult.tweet) {
    mainTweet = ensureAuthorId(readResult.tweet);
  }

  const threadResult = await fetchThread(birdPath, credentials, bookmark.id, {
    quoteDepth: QUOTE_DEPTH,
    account: accountName,
  });
  const threadTweets = threadResult.success ? threadResult.tweets.map(ensureAuthorId) : [];

  const threadIndex = new Map<string, RawBirdBookmark>();
  for (const tweet of threadTweets) {
    threadIndex.set(tweet.id, tweet);
  }
  threadIndex.set(mainTweet.id, mainTweet);

  const { maxThreadTweets, maxParentChain, maxTopReplies } = config.budget;

  const { chain: parentChainFromThread, nextMissingId } = buildParentChainFromIndex(
    mainTweet,
    threadIndex,
    maxParentChain
  );
  const seenIds = new Set<string>([mainTweet.id, ...parentChainFromThread.map((t) => t.id)]);
  const fallbackChain =
    nextMissingId && parentChainFromThread.length < maxParentChain
      ? await fetchParentChainViaRead(
          birdPath,
          credentials,
          nextMissingId,
          maxParentChain - parentChainFromThread.length,
          seenIds,
          accountName
        )
      : [];
  const parentChain = parentChainFromThread.concat(fallbackChain).reverse();

  let authorThread = buildAuthorThread(Array.from(threadIndex.values()), mainTweet.author.username);
  if (authorThread.length > maxThreadTweets) {
    authorThread = trimThreadAroundTarget(authorThread, mainTweet.id, maxThreadTweets);
  }

  let quotedTweet: RawBirdBookmark | undefined = mainTweet.quotedTweet ? ensureAuthorId(mainTweet.quotedTweet) : undefined;

  let referencedTweet: RawBirdBookmark | undefined;
  const referencedTweetId = findReferencedTweetId(bookmark);
  if (referencedTweetId && referencedTweetId !== mainTweet.id && referencedTweetId !== quotedTweet?.id) {
    const referencedResult = await readTweet(birdPath, credentials, referencedTweetId, {
      quoteDepth: QUOTE_DEPTH,
      account: accountName,
    });
    if (referencedResult.success && referencedResult.tweet) {
      referencedTweet = ensureAuthorId(referencedResult.tweet);
    }
  }

  let topReplies: RawBirdBookmark[] = [];
  let hasMoreReplies = false;
  if ((mainTweet.replyCount ?? 0) > 0 && maxTopReplies > 0) {
    const repliesResult = await fetchReplies(birdPath, credentials, bookmark.id, {
      quoteDepth: QUOTE_DEPTH,
      account: accountName,
    });
    if (repliesResult.success) {
      topReplies = getTopReplies(repliesResult.tweets, maxTopReplies);
      hasMoreReplies = (mainTweet.replyCount ?? 0) > topReplies.length;
    }
  }

  const totalInThread = threadTweets.length > 0 ? threadTweets.length : authorThread.length;
  const hasContext =
    parentChain.length > 0 ||
    authorThread.length > 1 ||
    topReplies.length > 0 ||
    !!quotedTweet ||
    !!referencedTweet;

  if (!hasContext) return null;

  return {
    parentChain,
    authorThread,
    totalInThread,
    hasMoreReplies,
    topReplies,
    quotedTweet,
    referencedTweet,
  };
}

/**
 * Build author thread from a list of tweets
 */
export function buildAuthorThread(tweets: RawBirdBookmark[], authorUsername: string): RawBirdBookmark[] {
  return tweets
    .filter((t) => t.author.username === authorUsername)
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0;
      const bTime = Date.parse(b.createdAt || '') || 0;
      return aTime - bTime;
    });
}

/**
 * Get top replies by engagement
 */
export function getTopReplies(tweets: RawBirdBookmark[], limit: number = 3): RawBirdBookmark[] {
  return tweets
    .filter((t) => (t.likeCount ?? 0) > 0)
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    .slice(0, limit);
}
