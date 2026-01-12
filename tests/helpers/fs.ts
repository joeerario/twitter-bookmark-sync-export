import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProcessedBookmark } from '../../src/types.js';

export async function readJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

export interface MinimalProcessedBookmark {
  id: string;
  account?: string;
  author?: { id: string; username: string; name: string };
  originalText?: string;
  text?: string;
  createdAt?: string;
  processedAt?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  urls?: string[];
  category?: 'review' | 'try' | 'knowledge' | 'life' | 'skip';
  contentType?: string;
  contentFormat?: string;
  summary?: string;
  keyValue?: string;
  quotes?: string[];
  tags?: string[];
  actionItems?: string[];
  priority?: 'high' | 'medium' | 'low';
  isReply?: boolean;
  isPartOfThread?: boolean;
  transcripts?: { videoId: string; url: string; transcript: string }[];
  articles?: { url: string; title: string; content: string }[];
  narrativeId?: string;
  narrativeLabel?: string;
  narrativeConfidence?: 'high' | 'medium' | 'low';
  narrativeCandidateId?: string;
  narrativeCandidateLabel?: string;
}

export function createProcessedBookmarkFixture(overrides: MinimalProcessedBookmark): ProcessedBookmark {
  const defaults: ProcessedBookmark = {
    id: 'test-id',
    account: 'testaccount',
    author: { id: '123', username: 'testuser', name: 'Test User' },
    originalText: 'Original test tweet',
    text: 'Test tweet',
    createdAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    likeCount: 10,
    retweetCount: 5,
    replyCount: 2,
    urls: [],
    category: 'review',
    contentType: 'opinion',
    contentFormat: 'tweet',
    summary: 'Test summary',
    keyValue: 'Test key value',
    quotes: [],
    tags: ['test'],
    actionItems: [],
    priority: 'medium',
    isReply: false,
    isPartOfThread: false,
    transcripts: [],
    articles: [],
  };

  return { ...defaults, ...overrides } as ProcessedBookmark;
}

export async function writeProcessedBookmarkFixture(
  dir: string,
  data: MinimalProcessedBookmark,
  options?: { account?: string; subdir?: string }
): Promise<string> {
  const account = options?.account ?? data.account ?? 'testaccount';
  const subdir = options?.subdir ?? account;
  const bookmark = createProcessedBookmarkFixture(data);

  const filePath = path.join(dir, 'data', 'processed', subdir, `${bookmark.id}.json`);
  await writeJson(filePath, bookmark);

  return filePath;
}

export async function writeProcessedBookmarksFixtures(
  dir: string,
  bookmarks: MinimalProcessedBookmark[],
  options?: { account?: string }
): Promise<string[]> {
  const paths: string[] = [];
  for (const bookmark of bookmarks) {
    const filePath = await writeProcessedBookmarkFixture(dir, bookmark, options);
    paths.push(filePath);
  }
  return paths;
}
