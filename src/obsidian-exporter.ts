/**
 * Obsidian Exporter
 *
 * Exports processed bookmarks to Obsidian vault as markdown files.
 * Features rich frontmatter, callouts, and auto-linking.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import type { Root } from 'mdast';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { OBSIDIAN_CONFIG_FILE, OBSIDIAN_EXPORT_STATE_FILE } from './paths.js';
import type { ExportBatchResult, ExportResult, ExportState, ObsidianConfig, ProcessedBookmark, ThreadContext, TwitterMediaItem } from './types.js';
import { deepMerge } from './utils/deep-merge.js';
import { toErrorMessage } from './utils/errors.js';
import { getLockPath, withFileLock } from './utils/file-lock.js';
import { readJsonSafe } from './utils/read-json-safe.js';
import { safeFetchBinary } from './utils/safe-fetch.js';
import { writeJsonAtomic } from './utils/write-json-atomic.js';

// Default configuration
const DEFAULT_CONFIG: ObsidianConfig = {
  vaultPath: null,
  bookmarksFolder: 'Bookmarks',
  useCategoryFolders: true,
  categoryFolders: {
    try: 'Tools',
    review: 'Read',
    knowledge: 'Insights',
    life: 'Life',
    skip: null,
  },
  fileNaming: 'date-summary',
  includeTranscripts: true,
  maxContentLength: 5000,
  autoLink: {
    enabled: true,
    linkMappings: {
      claude: 'Claude',
      'claude code': 'Claude Code',
      anthropic: 'Anthropic',
      'ai agent': 'AI Agents',
      agents: 'AI Agents',
      prompt: 'Prompting',
      workflow: 'Workflows',
      automation: 'Automation',
      python: 'Python',
      javascript: 'JavaScript',
      typescript: 'TypeScript',
    },
  },
  assets: {
    strategy: 'vault-relative',
    assetsDir: 'Bookmarks/Assets',
    perCategoryDirs: {
      try: 'Bookmarks/Assets/Twitter',
      review: 'Bookmarks/Assets/Twitter',
      knowledge: 'Bookmarks/Assets/Twitter',
      life: 'Bookmarks/Assets/Twitter',
      skip: null,
    },
    embedWidth: 600,
  },
  article: {
    mode: 'excerpt-inline',
    separateDir: 'Bookmarks/Articles',
    maxExcerptLength: 800,
  },
  tagPolicy: 'sanitize',
};

const FRONTMATTER_SCHEMA_VERSION = 1;
const FRONTMATTER_LIST_KEYS = ['tags', 'aliases', 'cssclasses'] as const;
const FRONTMATTER_KEY_ORDER = [
  'schema_version',
  'id',
  'source_url',
  'source_id',
  'author',
  'author_name',
  'account',
  'created',
  'processed',
  'captured_at',
  'category',
  'priority',
  'status',
  'tags',
  'aliases',
  'cssclasses',
  'content_type',
  'content_format',
  'thread_count',
  'engagement',
];
const OWNED_FRONTMATTER_KEYS = new Set(FRONTMATTER_KEY_ORDER);
export const OWNED_SECTION_KEYS = [
  'title',
  'summary',
  'tweet',
  'engagement',
  'media',
  'article',
  'key-value',
  'quotes',
  'action-items',
  'links',
  'transcripts',
  'thread',
  'related',
  'footer',
];
const TABLE_HEADER_SEPARATOR = '|------:|:--------:|--------:|---------:|------:|------:|';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObsidianConfig(value: unknown): asserts value is ObsidianConfig {
  const errors: string[] = [];

  if (!isRecord(value)) {
    throw new Error(`Invalid Obsidian config in ${OBSIDIAN_CONFIG_FILE}: expected an object`);
  }

  const config = value as Record<string, unknown>;

  if (!(typeof config.vaultPath === 'string' || config.vaultPath === null)) {
    errors.push('vaultPath must be a string or null');
  }
  if (typeof config.bookmarksFolder !== 'string') {
    errors.push('bookmarksFolder must be a string');
  }
  if (typeof config.useCategoryFolders !== 'boolean') {
    errors.push('useCategoryFolders must be a boolean');
  }
  const categoryFolders = config.categoryFolders;
  if (!isRecord(categoryFolders)) {
    errors.push('categoryFolders must be an object');
  } else {
    for (const key of ['try', 'review', 'knowledge', 'life', 'skip']) {
      const value = categoryFolders[key];
      if (!(typeof value === 'string' || value === null)) {
        errors.push(`categoryFolders.${key} must be a string or null`);
      }
    }
  }
  if (!['date-summary', 'id', 'summary'].includes(String(config.fileNaming))) {
    errors.push('fileNaming must be one of: date-summary, id, summary');
  }
  if (typeof config.includeTranscripts !== 'boolean') {
    errors.push('includeTranscripts must be a boolean');
  }
  if (typeof config.maxContentLength !== 'number' || !Number.isFinite(config.maxContentLength)) {
    errors.push('maxContentLength must be a finite number');
  }
  const autoLink = config.autoLink;
  if (!isRecord(autoLink)) {
    errors.push('autoLink must be an object');
  } else {
    if (typeof autoLink.enabled !== 'boolean') {
      errors.push('autoLink.enabled must be a boolean');
    }
    const linkMappings = autoLink.linkMappings;
    if (!isRecord(linkMappings)) {
      errors.push('autoLink.linkMappings must be an object');
    } else {
      for (const [key, value] of Object.entries(linkMappings)) {
        if (typeof value !== 'string') {
          errors.push(`autoLink.linkMappings.${key} must be a string`);
        }
      }
    }
  }

  const assets = config.assets;
  if (!isRecord(assets)) {
    errors.push('assets must be an object');
  } else {
    if (!['vault-relative', 'adjacent', 'custom'].includes(String(assets.strategy))) {
      errors.push('assets.strategy must be one of: vault-relative, adjacent, custom');
    }
    if (typeof assets.assetsDir !== 'string') {
      errors.push('assets.assetsDir must be a string');
    }
    if (typeof assets.embedWidth !== 'number' || !Number.isFinite(assets.embedWidth)) {
      errors.push('assets.embedWidth must be a finite number');
    }
    const perCategoryDirs = assets.perCategoryDirs;
    if (!isRecord(perCategoryDirs)) {
      errors.push('assets.perCategoryDirs must be an object');
    } else {
      for (const key of ['try', 'review', 'knowledge', 'life', 'skip']) {
        const value = perCategoryDirs[key];
        if (!(typeof value === 'string' || value === null)) {
          errors.push(`assets.perCategoryDirs.${key} must be a string or null`);
        }
      }
    }
  }

  const article = config.article;
  if (!isRecord(article)) {
    errors.push('article must be an object');
  } else {
    if (!['excerpt-inline', 'full-in-separate-note', 'external-only'].includes(String(article.mode))) {
      errors.push('article.mode must be one of: excerpt-inline, full-in-separate-note, external-only');
    }
    if (typeof article.separateDir !== 'string') {
      errors.push('article.separateDir must be a string');
    }
    if (typeof article.maxExcerptLength !== 'number' || !Number.isFinite(article.maxExcerptLength)) {
      errors.push('article.maxExcerptLength must be a finite number');
    }
  }

  if (!['preserve', 'sanitize', 'drop_invalid'].includes(String(config.tagPolicy))) {
    errors.push('tagPolicy must be one of: preserve, sanitize, drop_invalid');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Obsidian config in ${OBSIDIAN_CONFIG_FILE}:\n- ${errors.join('\n- ')}`);
  }
}

export function formatDateLocal(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0]!;
}

function formatDateUtc(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeList(values: string[]): string[] {
  const unique = new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

function isValidTag(tag: string): boolean {
  if (!tag) return false;
  if (!/[a-zA-Z]/.test(tag)) return false;
  return /^[A-Za-z0-9_/-]+$/.test(tag);
}

function sanitizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_/-]/g, '');
}

export function normalizeTags(
  tags: string[] | undefined,
  policy: ObsidianConfig['tagPolicy']
): { tags: string[]; adjusted: boolean; original: string[] } {
  const original = (tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (policy === 'preserve') {
    return { tags: normalizeList(original.map((tag) => tag.replace(/^#+/, ''))), adjusted: false, original };
  }

  const normalized = original.map((tag) => sanitizeTag(tag)).filter((tag) => tag.length > 0);
  const filtered = normalized.filter((tag) => isValidTag(tag));
  const normalizedOriginal = normalizeList(original);
  const normalizedFiltered = normalizeList(filtered);
  return {
    tags: normalizedFiltered,
    adjusted: normalizedOriginal.join('|') !== normalizedFiltered.join('|'),
    original,
  };
}

export function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    for (const key of Array.from(params.keys())) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'source') {
        params.delete(key);
      }
    }
    parsed.search = params.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

function toVaultPath(value: string): string {
  return value.split(path.sep).join('/');
}

function wrapOwnedSection(key: string, lines: string[]): string {
  return [`<!-- exporter:begin ${key} -->`, ...lines, `<!-- exporter:end ${key} -->`].join('\n');
}

export function extractFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
  raw: string | null;
  block: string | null;
} {
  if (!markdown.startsWith('---')) {
    return { frontmatter: null, body: markdown, raw: null, block: null };
  }

  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { frontmatter: null, body: markdown, raw: null, block: null };
  }

  const raw = match[1] ?? '';
  const block = match[0].trimEnd();
  try {
    const data = parseYaml(raw) as Record<string, unknown>;
    return { frontmatter: data ?? null, body: markdown.slice(match[0].length), raw, block };
  } catch (error) {
    console.warn(`Failed to parse frontmatter: ${toErrorMessage(error)}`);
    return { frontmatter: null, body: markdown.slice(match[0].length), raw, block };
  }
}

function normalizeFrontmatterLists(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const result = { ...frontmatter };
  for (const key of FRONTMATTER_LIST_KEYS) {
    const value = result[key];
    if (Array.isArray(value)) {
      result[key] = normalizeList(value.map((item) => String(item)));
    } else if (typeof value === 'string') {
      result[key] = normalizeList([value]);
    } else if (value === undefined) {
      continue;
    } else {
      result[key] = normalizeList([String(value)]);
    }
  }
  return result;
}

function serializeFrontmatter(data: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    cleaned[key] = value;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    if (key in cleaned) {
      ordered[key] = cleaned[key];
    }
  }

  const extraKeys = Object.keys(cleaned).filter((key) => !FRONTMATTER_KEY_ORDER.includes(key)).sort();
  for (const key of extraKeys) {
    ordered[key] = cleaned[key];
  }

  const yaml = stringifyYaml(ordered, { indent: 2, lineWidth: 0 });
  return `---\n${yaml.trim()}\n---`;
}

/**
 * Load configuration
 */
export async function loadConfig(): Promise<ObsidianConfig> {
  const saved = await readJsonSafe<Partial<ObsidianConfig>>(OBSIDIAN_CONFIG_FILE, {});
  const merged = deepMerge(DEFAULT_CONFIG, saved);
  assertObsidianConfig(merged);
  return merged;
}

/**
 * Save configuration
 */
export async function saveConfig(config: ObsidianConfig): Promise<void> {
  await writeJsonAtomic(OBSIDIAN_CONFIG_FILE, config);
}

/**
 * Load export state
 */
async function loadExportState(): Promise<ExportState> {
  return await readJsonSafe<ExportState>(OBSIDIAN_EXPORT_STATE_FILE, { exportedIds: [], lastExport: null });
}

/**
 * Save export state
 */
async function saveExportState(state: ExportState): Promise<void> {
  const dir = path.dirname(OBSIDIAN_EXPORT_STATE_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeJsonAtomic(OBSIDIAN_EXPORT_STATE_FILE, state);
}

// Cache for export state
let exportStateCache: Set<string> | null = null;
let exportStateCacheTime = 0;
const CACHE_TTL_MS = 5000;

/**
 * Load exported IDs as Set
 */
export async function loadExportedIdSet(): Promise<Set<string>> {
  const now = Date.now();

  if (exportStateCache && now - exportStateCacheTime < CACHE_TTL_MS) {
    return exportStateCache;
  }

  const state = await loadExportState();
  exportStateCache = new Set(state.exportedIds);
  exportStateCacheTime = now;

  return exportStateCache;
}

/**
 * Invalidate export state cache
 */
export function invalidateExportStateCache(): void {
  exportStateCache = null;
  exportStateCacheTime = 0;
}

/**
 * Execute with file lock
 */
async function withExportStateLock<T>(task: () => Promise<T>): Promise<T> {
  return withFileLock(getLockPath(OBSIDIAN_EXPORT_STATE_FILE), task);
}

/**
 * Generate slug from text
 */
function slugify(text: string, maxLength: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '');
}

/**
 * Generate filename for a bookmark
 */
export function generateFilename(bookmark: ProcessedBookmark, config: ObsidianConfig): string {
  const date = formatDateLocal(bookmark.createdAt) || formatDateLocal(new Date()) || 'unknown-date';
  const summary = bookmark.summary || bookmark.text?.slice(0, 50) || bookmark.id;
  const fallbackId = bookmark.id || `bookmark-${Date.now()}`;
  const slug = slugify(summary) || fallbackId;
  const idSuffix = fallbackId.slice(-6);

  switch (config.fileNaming) {
    case 'id':
      return `${fallbackId}.md`;
    case 'summary':
      return `${slug}-${idSuffix}.md`;
    case 'date-summary':
    default:
      return `${date}-${slug}-${idSuffix}.md`;
  }
}

/**
 * Format date for display
 */
function formatDateDisplay(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Auto-link text based on mappings
 */
function autoLinkMarkdown(markdown: string, config: ObsidianConfig): string {
  if (!config.autoLink.enabled) return markdown;

  const mappings = Object.entries(config.autoLink.linkMappings).sort((a, b) => b[0].length - a[0].length);
  if (mappings.length === 0) return markdown;

  const processor = unified()
    .use(remarkParse)
    .use(() => {
      return (tree: unknown) => {
        visit(tree as { type: string }, 'text', (node: unknown, _index: number | null, parent: unknown) => {
          const parentType = (parent as { type?: string } | undefined)?.type;
          if (!parentType || ['link', 'linkReference', 'definition', 'inlineCode', 'code'].includes(parentType)) {
            return;
          }

          const textNode = node as { value: string };
          let value = textNode.value;
          for (const [phrase, noteName] of mappings) {
            const escapedPhrase = escapeRegExp(phrase);
            const regex = new RegExp(`(?<!\\[\\[)\\b(${escapedPhrase})\\b(?![^\\[]*\\]\\])`, 'gi');
            value = value.replace(regex, (_match, captured: string) => `[[${noteName}|${captured}]]`);
          }

          textNode.value = value;
        });
      };
    })
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      listItemIndent: 'one',
    });

  const tree = processor.parse(markdown) as Root;
  const transformed = processor.runSync(tree) as Root;
  const output = processor.stringify(transformed);
  return output.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
}

/**
 * Generate frontmatter
 */
function deriveContentFormat(bookmark: ProcessedBookmark): string {
  if (bookmark.threadContext?.authorThread && bookmark.threadContext.authorThread.length > 1) {
    return 'thread';
  }
  if (bookmark.isReply || bookmark.inReplyToStatusId) {
    return 'reply';
  }
  return bookmark.contentFormat || 'tweet';
}

interface MediaAssetResult {
  sourceUrl: string;
  embedPath: string;
  localPath: string;
  filename: string;
  status: 'downloaded' | 'skipped' | 'failed';
  error?: string;
}

interface ArticlePayload {
  title: string;
  url: string;
  excerpt: string;
  embed?: string;
}

interface GenerateMarkdownOptions {
  existingFrontmatter?: Record<string, unknown> | null;
  mediaAssets?: MediaAssetResult[];
  articlePayloads?: ArticlePayload[];
}

interface ExportOptions {
  regenerate?: boolean;
  validate?: boolean;
}

function buildFrontmatter(
  bookmark: ProcessedBookmark,
  config: ObsidianConfig,
  existing: Record<string, unknown> | null
): { frontmatter: string; tagsAdjustedNote: string | null; tags: string[] } {
  const title = bookmark.summary || bookmark.text?.slice(0, 80) || 'Untitled';
  const sourceUrl = `https://x.com/${bookmark.author?.username || 'i'}/status/${bookmark.id}`;
  const tagsResult = normalizeTags(bookmark.tags, config.tagPolicy);

  const existingStatus = typeof existing?.status === 'string' ? existing.status : null;
  const aliases = normalizeList([title, `@${bookmark.author?.username || 'unknown'}`, bookmark.id]);
  const cssclasses = normalizeList([
    'bookmark',
    `priority-${bookmark.priority || 'medium'}`,
    `category-${bookmark.category}`,
  ]);

  const frontmatterData: Record<string, unknown> = {
    schema_version: FRONTMATTER_SCHEMA_VERSION,
    id: bookmark.id,
    source_url: sourceUrl,
    source_id: bookmark.id,
    author: bookmark.author?.username || 'unknown',
    author_name: bookmark.author?.name || '',
    account: bookmark.account || 'unknown',
    created: formatDateLocal(bookmark.createdAt),
    processed: formatDateUtc(bookmark.processedAt),
    captured_at: formatDateUtc(bookmark.processedAt),
    category: bookmark.category,
    priority: bookmark.priority || 'medium',
    status: existingStatus || 'unread',
    tags: tagsResult.tags,
    aliases,
    cssclasses,
    content_type: bookmark.contentType || 'other',
    content_format: deriveContentFormat(bookmark),
    thread_count: bookmark.threadContext?.authorThread?.length ?? null,
    engagement: {
      likes: bookmark.likeCount ?? 0,
      retweets: bookmark.retweetCount ?? 0,
      replies: bookmark.replyCount ?? 0,
    },
  };

  const preserved: Record<string, unknown> = {};
  if (existing) {
    const normalizedExisting = normalizeFrontmatterLists(existing);
    for (const [key, value] of Object.entries(normalizedExisting)) {
      if (!OWNED_FRONTMATTER_KEYS.has(key)) {
        preserved[key] = value;
      }
    }
  }

  const merged = normalizeFrontmatterLists({ ...frontmatterData, ...preserved });
  const tagsAdjustedNote = tagsResult.adjusted
    ? `<!-- exporter:tags-adjusted original=${JSON.stringify(tagsResult.original)} -->`
    : null;

  return {
    frontmatter: serializeFrontmatter(merged),
    tagsAdjustedNote,
    tags: tagsResult.tags,
  };
}

function buildArticleFilename(bookmark: ProcessedBookmark, index: number): string {
  const base = bookmark.id || 'article';
  if (!bookmark.articles || bookmark.articles.length <= 1) {
    return `${base}.md`;
  }
  return `${base}-${index + 1}.md`;
}

function buildArticlePayloads(
  bookmark: ProcessedBookmark,
  config: ObsidianConfig,
  embedOverrides?: string[]
): ArticlePayload[] {
  if (!bookmark.articles || bookmark.articles.length === 0) {
    return [];
  }

  return bookmark.articles.map((article, index) => {
    const url = stripTrackingParams(article.url);
    const title = article.title || 'Untitled';
    const excerpt = (article.content ?? '').slice(0, config.article.maxExcerptLength).trim();
    const embedPath =
      config.article.mode === 'full-in-separate-note'
        ? embedOverrides?.[index] ?? `${config.article.separateDir}/${buildArticleFilename(bookmark, index)}#^content`
        : undefined;

    return {
      title,
      url,
      excerpt,
      embed: embedPath,
    };
  });
}

function resolveAssetsDir(
  config: ObsidianConfig,
  category: string,
  noteFolder: string
): { fileDir: string; embedDir: string } {
  const perCategory = config.assets.perCategoryDirs[category];
  const baseDir = perCategory ?? config.assets.assetsDir;

  if (config.assets.strategy === 'adjacent') {
    return {
      fileDir: path.join(noteFolder, baseDir),
      embedDir: toVaultPath(baseDir),
    };
  }

  const vaultPath = config.vaultPath ?? '';
  const fileDir = path.isAbsolute(baseDir) ? baseDir : path.join(vaultPath, baseDir);
  const embedDir = toVaultPath(path.isAbsolute(baseDir) ? path.relative(vaultPath, baseDir) : baseDir);

  return { fileDir, embedDir };
}

function inferMediaExtension(media: TwitterMediaItem, url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname);
    if (ext) return ext;
  } catch {
    // ignore
  }

  switch (media.type) {
    case 'video':
      return '.mp4';
    case 'animated_gif':
      return '.gif';
    default:
      return '.jpg';
  }
}

async function downloadMediaAssets(
  bookmark: ProcessedBookmark,
  config: ObsidianConfig,
  noteFolder: string
): Promise<MediaAssetResult[]> {
  const mediaItems = bookmark.media ?? [];
  if (mediaItems.length === 0) return [];

  const { fileDir, embedDir } = resolveAssetsDir(config, bookmark.category, noteFolder);
  if (!existsSync(fileDir)) {
    await mkdir(fileDir, { recursive: true });
  }

  const results: MediaAssetResult[] = [];

  for (let i = 0; i < mediaItems.length; i++) {
    const media = mediaItems[i]!;
    const sourceUrl = media.type === 'photo' ? media.url : media.previewUrl || media.preview_image_url || media.url;
    const extension = inferMediaExtension(media, sourceUrl);
    const filename = `${bookmark.id}-${i + 1}${extension}`;
    const localPath = path.join(fileDir, filename);
    const embedPath = toVaultPath(path.join(embedDir, filename));

    if (existsSync(localPath)) {
      results.push({ sourceUrl, embedPath, localPath, filename, status: 'skipped' });
      continue;
    }

    const fetched = await safeFetchBinary(sourceUrl, { timeout: 30_000, maxBytes: 12_000_000 });
    if (!fetched.success || !fetched.data) {
      results.push({
        sourceUrl,
        embedPath,
        localPath,
        filename,
        status: 'failed',
        error: fetched.error || 'Download failed',
      });
      continue;
    }

    try {
      await writeFile(localPath, fetched.data);
      results.push({ sourceUrl, embedPath, localPath, filename, status: 'downloaded' });
    } catch (error) {
      results.push({
        sourceUrl,
        embedPath,
        localPath,
        filename,
        status: 'failed',
        error: toErrorMessage(error),
      });
    }
  }

  return results;
}

interface SectionBlock {
  key: string;
  lines: string[];
}

function buildTitleSection(bookmark: ProcessedBookmark): SectionBlock {
  const title = bookmark.summary || bookmark.text?.slice(0, 80) || 'Untitled';
  return { key: 'title', lines: [`# ${title}`] };
}

function buildSummarySection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.summary) return null;
  const summaryLines = ['## Summary', '> [!summary]', `> ${bookmark.summary} ^summary`];
  return { key: 'summary', lines: summaryLines };
}

function buildTweetSection(bookmark: ProcessedBookmark): SectionBlock {
  const bookmarkId = bookmark.id;
  const authorLink = `[@${bookmark.author?.username}](https://x.com/${bookmark.author?.username})`;
  const tweetLink = `https://x.com/${bookmark.author?.username}/status/${bookmarkId}`;

  const tweetLines: string[] = [
    '## Tweet',
    `**${authorLink}** · [${formatDateDisplay(bookmark.createdAt)}](${tweetLink})`,
    '',
    `${bookmark.originalText || bookmark.text || ''} ^tweet`,
  ];

  if (bookmark.threadContext) {
    const ctx = bookmark.threadContext as ThreadContext;

    if (ctx.parentChain && ctx.parentChain.length > 0) {
      tweetLines.push('', '> [!tip] Replying to');
      for (const parent of ctx.parentChain) {
        const parentAuthor = parent.author?.username || 'unknown';
        const parentLink = `https://x.com/${parentAuthor}/status/${parent.id}`;
        tweetLines.push(
          `> **[@${parentAuthor}](https://x.com/${parentAuthor})**: ${(parent.text || '').slice(0, 200)}${
            parent.text?.length > 200 ? '...' : ''
          }`
        );
        tweetLines.push(`> [View original](${parentLink})`, '>');
      }
    }

    if (ctx.quotedTweet) {
      const quotedAuthor = ctx.quotedTweet.author?.username || 'unknown';
      const quotedLink = `https://x.com/${quotedAuthor}/status/${ctx.quotedTweet.id}`;
      tweetLines.push('', '> [!quote] Quoted tweet');
      tweetLines.push(
        `> **[@${quotedAuthor}](https://x.com/${quotedAuthor})**: ${(ctx.quotedTweet.text || '').slice(0, 200)}${
          ctx.quotedTweet.text?.length > 200 ? '...' : ''
        }`
      );
      tweetLines.push(`> [View original](${quotedLink})`, '>');
    }

    if (ctx.referencedTweet) {
      const refAuthor = ctx.referencedTweet.author?.username || 'unknown';
      const refLink = `https://x.com/${refAuthor}/status/${ctx.referencedTweet.id}`;
      tweetLines.push('', '> [!note] Referenced tweet');
      tweetLines.push(
        `> **[@${refAuthor}](https://x.com/${refAuthor})**: ${(ctx.referencedTweet.text || '').slice(0, 200)}${
          ctx.referencedTweet.text?.length > 200 ? '...' : ''
        }`
      );
      tweetLines.push(`> [View original](${refLink})`, '>');
    }
  }

  return { key: 'tweet', lines: tweetLines };
}

function buildEngagementSection(bookmark: ProcessedBookmark): SectionBlock {
  const engagementLines = [
    '## Engagement',
    '| Likes | Retweets | Replies | Bookmarks | Views | Quotes |',
    TABLE_HEADER_SEPARATOR,
    `| ${bookmark.likeCount ?? 0} | ${bookmark.retweetCount ?? 0} | ${bookmark.replyCount ?? 0} | - | - | - |`,
    `Captured: ${formatDateUtc(bookmark.processedAt) ?? 'Unknown'}`,
  ];
  return { key: 'engagement', lines: engagementLines };
}

function buildMediaSection(
  mediaAssets: MediaAssetResult[],
  fallbackMedia: TwitterMediaItem[],
  config: ObsidianConfig
): SectionBlock | null {
  if (mediaAssets.length === 0 && fallbackMedia.length === 0) return null;

  const mediaLines = ['## Media'];
  for (const asset of mediaAssets) {
    if (asset.status !== 'failed') {
      mediaLines.push(`![[${asset.embedPath}|${config.assets.embedWidth}]]`);
    }
  }
  for (const item of fallbackMedia) {
    const sourceUrl = item.type === 'photo' ? item.url : item.previewUrl || item.preview_image_url || item.url;
    mediaLines.push(`![Tweet media|${config.assets.embedWidth}](${sourceUrl})`);
  }

  const failures = mediaAssets.filter((asset) => asset.status === 'failed');
  if (failures.length > 0) {
    mediaLines.push('> [!warning] Media download failed');
    for (const failure of failures) {
      mediaLines.push(`> ${failure.sourceUrl} — ${failure.error || 'Unknown error'}`);
    }
  }

  return { key: 'media', lines: mediaLines };
}

function buildArticleSection(articlePayloads: ArticlePayload[], config: ObsidianConfig): SectionBlock | null {
  if (articlePayloads.length === 0) return null;

  const articleLines: string[] = ['## Article'];
  if (config.article.mode === 'external-only') {
    for (const article of articlePayloads) {
      articleLines.push(`- [${article.title}](${article.url})`);
    }
  } else {
    for (const article of articlePayloads) {
      const domain = (() => {
        try {
          return new URL(article.url).hostname;
        } catch {
          return article.url;
        }
      })();
      articleLines.push(`> [!abstract]- Article: ${article.title}`);
      articleLines.push(`> **Source:** [${domain}](${article.url})`);
      if (article.embed) {
        articleLines.push(`> ![[${article.embed}]]`);
      } else {
        articleLines.push(`> ${article.excerpt}`);
      }
      articleLines.push('>');
    }
  }

  return { key: 'article', lines: articleLines };
}

function buildKeyValueSection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.keyValue) return null;
  const keyLines = ['## Why This Matters', bookmark.keyValue];
  return { key: 'key-value', lines: keyLines };
}

function buildQuotesSection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.quotes || bookmark.quotes.length === 0) return null;
  const quoteLines = ['## Notable Quotes'];
  for (const quote of bookmark.quotes) {
    quoteLines.push('> [!quote]', `> ${quote}`, '>');
  }
  return { key: 'quotes', lines: quoteLines };
}

function buildActionItemsSection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.actionItems || bookmark.actionItems.length === 0) return null;
  const actionLines = ['## Action Items', ...bookmark.actionItems.map((item) => `- [ ] ${item}`)];
  return { key: 'action-items', lines: actionLines };
}

function buildLinksSection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.urls || bookmark.urls.length === 0) return null;
  const linkLines = ['## Links', ...bookmark.urls.map((url) => `- ${stripTrackingParams(url)}`)];
  return { key: 'links', lines: linkLines };
}

function buildTranscriptsSection(bookmark: ProcessedBookmark, config: ObsidianConfig): SectionBlock | null {
  if (!config.includeTranscripts || !bookmark.transcripts || bookmark.transcripts.length === 0) return null;

  const transcriptLines: string[] = ['## Video Transcripts'];
  for (const t of bookmark.transcripts) {
    transcriptLines.push(`### Video: ${t.videoId}`);
    transcriptLines.push(`[Watch on YouTube](${t.url})`);
    transcriptLines.push('');
    transcriptLines.push('> [!example] Transcript');
    const transcript = t.transcript.slice(0, config.maxContentLength);
    for (const line of transcript.split('\n')) {
      transcriptLines.push(`> ${line}`);
    }
    if (t.transcript.length > config.maxContentLength) {
      transcriptLines.push('> ...');
    }
    transcriptLines.push('');
  }

  return { key: 'transcripts', lines: transcriptLines };
}

function buildThreadSection(bookmark: ProcessedBookmark): SectionBlock | null {
  if (!bookmark.threadContext?.authorThread || bookmark.threadContext.authorThread.length <= 1) return null;

  const threadLines: string[] = ['## Thread', ''];
  for (const tweet of bookmark.threadContext.authorThread) {
    const snippet = (tweet.text || '').slice(0, 80).replace(/\s+/g, ' ').trim();
    threadLines.push(`- [[#^tweet-${tweet.id}]] ${snippet || 'Tweet'}`);
  }
  threadLines.push('');

  for (let i = 0; i < bookmark.threadContext.authorThread.length; i++) {
    const tweet = bookmark.threadContext.authorThread[i]!;
    const tweetUrl = `https://x.com/${tweet.author?.username}/status/${tweet.id}`;
    threadLines.push(`### ${i + 1}/${bookmark.threadContext.authorThread.length} ^tweet-${tweet.id}`);
    threadLines.push(`[@${tweet.author?.username}](${tweetUrl}) — ${tweet.text || ''}`);
    threadLines.push('');
  }

  return { key: 'thread', lines: threadLines };
}

function buildRelatedSection(tags: string[]): SectionBlock | null {
  if (tags.length === 0) return null;
  const relatedLinks = tags.slice(0, 6).map((tag) => {
    const noteName = tag
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `[[${noteName}]]`;
  });
  const relatedLines = ['## Related', relatedLinks.join(' · ')];
  return { key: 'related', lines: relatedLines };
}

function buildFooterSection(bookmark: ProcessedBookmark, tagsAdjustedNote: string | null): SectionBlock {
  const footerLines = tagsAdjustedNote
    ? [tagsAdjustedNote, `*Processed: ${formatDateUtc(bookmark.processedAt) ?? 'Unknown'}*`]
    : [`*Processed: ${formatDateUtc(bookmark.processedAt) ?? 'Unknown'}*`];
  return { key: 'footer', lines: footerLines };
}

/**
 * Generate markdown content
 */
export function generateMarkdown(
  bookmark: ProcessedBookmark,
  config: ObsidianConfig,
  options: GenerateMarkdownOptions = {}
): string {
  const { frontmatter, tagsAdjustedNote, tags } = buildFrontmatter(
    bookmark,
    config,
    options.existingFrontmatter ?? null
  );

  const mediaAssets = options.mediaAssets ?? [];
  const fallbackMedia = mediaAssets.length === 0 ? bookmark.media ?? [] : [];
  const articlePayloads = options.articlePayloads ?? buildArticlePayloads(bookmark, config);

  const sections = [
    buildTitleSection(bookmark),
    buildSummarySection(bookmark),
    buildTweetSection(bookmark),
    buildEngagementSection(bookmark),
    buildMediaSection(mediaAssets, fallbackMedia, config),
    buildArticleSection(articlePayloads, config),
    buildKeyValueSection(bookmark),
    buildQuotesSection(bookmark),
    buildActionItemsSection(bookmark),
    buildLinksSection(bookmark),
    buildTranscriptsSection(bookmark, config),
    buildThreadSection(bookmark),
    buildRelatedSection(tags),
    buildFooterSection(bookmark, tagsAdjustedNote),
  ].filter((section): section is SectionBlock => section !== null);

  const body = sections.map((section) => wrapOwnedSection(section.key, section.lines)).join('\n\n');
  const linkedBody = autoLinkMarkdown(body, config).trimEnd();
  return `${frontmatter}\n\n${linkedBody}\n`;
}

export function extractOwnedSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const key of OWNED_SECTION_KEYS) {
    const regex = new RegExp(`<!-- exporter:begin ${key} -->[\\s\\S]*?<!-- exporter:end ${key} -->`, 'g');
    const match = markdown.match(regex);
    if (match && match[0]) {
      sections.set(key, match[0]);
    }
  }
  return sections;
}

export function mergeMarkdown(existing: string, generated: string): string {
  const existingParts = extractFrontmatter(existing);
  const generatedParts = extractFrontmatter(generated);
  let body = existingParts.body;

  const generatedSections = extractOwnedSections(generatedParts.body);
  for (const [key, section] of generatedSections) {
    const regex = new RegExp(`<!-- exporter:begin ${key} -->[\\s\\S]*?<!-- exporter:end ${key} -->`, 'g');
    if (regex.test(body)) {
      body = body.replace(regex, section);
    } else {
      body = `${body.trim()}\n\n${section}\n`;
    }
  }

  const mergedBody = body.trim();
  const frontmatterBlock = generatedParts.block ?? '';
  return `${frontmatterBlock}\n\n${mergedBody}\n`;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
}

export function validateMarkdown(markdown: string, config: ObsidianConfig): void {
  const { frontmatter } = extractFrontmatter(markdown);
  const errors: string[] = [];

  if (!frontmatter) {
    errors.push('Missing frontmatter');
  } else {
    const required = [
      'schema_version',
      'id',
      'source_url',
      'created',
      'processed',
      'category',
      'priority',
      'status',
      'captured_at',
      'engagement',
    ];
    for (const key of required) {
      if (!(key in frontmatter)) {
        errors.push(`Missing required frontmatter key: ${key}`);
      }
    }

    for (const key of FRONTMATTER_LIST_KEYS) {
      const value = frontmatter[key];
      if (!Array.isArray(value)) {
        errors.push(`Frontmatter ${key} must be a list`);
      } else {
        const normalized = normalizeList(value.map((item) => String(item)));
        if (normalized.length !== value.length) {
          errors.push(`Frontmatter ${key} has duplicate entries`);
        }
      }
    }

    const created = frontmatter.created;
    if (typeof created === 'string' && !isIsoDate(created)) {
      errors.push('Frontmatter created must be YYYY-MM-DD');
    }

    const processed = frontmatter.processed;
    if (typeof processed === 'string' && !isIsoDateTime(processed)) {
      errors.push('Frontmatter processed must be ISO 8601 (UTC)');
    }

    const threadCount = frontmatter.thread_count;
    if (threadCount !== undefined && threadCount !== null && typeof threadCount !== 'number') {
      errors.push('thread_count must be a number or null');
    }

    const engagement = frontmatter.engagement;
    if (engagement !== undefined && !isRecord(engagement)) {
      errors.push('engagement must be an object');
    }
  }

  const embedMatches = Array.from(markdown.matchAll(/!\[\[([^\]]+)\]\]/g));
  for (const match of embedMatches) {
    const target = match[1] ?? '';
    const pathPart = target.split('|')[0]?.split('#')[0] ?? '';
    if (pathPart.startsWith('http')) {
      errors.push(`Embed path should be vault-relative: ${pathPart}`);
    }
    if (pathPart.startsWith('..')) {
      errors.push(`Embed path must not traverse up: ${pathPart}`);
    }
    if (config.assets.strategy === 'vault-relative' && pathPart.startsWith('./')) {
      errors.push(`Embed path should be vault-relative without ./ : ${pathPart}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Obsidian markdown validation failed:\n- ${errors.join('\n- ')}`);
  }
}

async function exportArticleNotes(bookmark: ProcessedBookmark, config: ObsidianConfig): Promise<string[]> {
  if (config.article.mode !== 'full-in-separate-note') {
    return [];
  }

  const vaultPath = config.vaultPath ?? '';
  const articlesDir = path.isAbsolute(config.article.separateDir)
    ? config.article.separateDir
    : path.join(vaultPath, config.article.separateDir);
  if (!existsSync(articlesDir)) {
    await mkdir(articlesDir, { recursive: true });
  }

  const embedPaths: string[] = [];
  for (let i = 0; i < (bookmark.articles ?? []).length; i++) {
    const article = bookmark.articles[i]!;
    const filename = buildArticleFilename(bookmark, i);
    const filepath = path.join(articlesDir, filename);
    const embedPath = toVaultPath(
      path.join(path.isAbsolute(config.article.separateDir) ? path.relative(vaultPath, articlesDir) : config.article.separateDir, filename)
    );

    const content = buildArticleNoteMarkdown(bookmark, article, config, i);
    await writeFile(filepath, content);
    embedPaths.push(`${embedPath}#^content`);
  }

  return embedPaths;
}

function buildArticleNoteMarkdown(
  bookmark: ProcessedBookmark,
  article: { url: string; title: string; content?: string },
  config: ObsidianConfig,
  index: number
): string {
  const tagsResult = normalizeTags(bookmark.tags, config.tagPolicy);
  const frontmatter = serializeFrontmatter({
    schema_version: FRONTMATTER_SCHEMA_VERSION,
    id: `${bookmark.id}-article-${index + 1}`,
    source_url: stripTrackingParams(article.url),
    source_id: bookmark.id,
    created: formatDateLocal(bookmark.createdAt),
    processed: formatDateUtc(bookmark.processedAt),
    category: bookmark.category,
    tags: tagsResult.tags,
    aliases: normalizeList([article.title]),
    cssclasses: normalizeList(['bookmark-article']),
  });

  const content = article.content?.trim() ?? '';
  const bodyLines = [
    `# ${article.title || 'Article'}`,
    '',
    '## Content',
    content,
    '^content',
  ];

  return `${frontmatter}\n\n${bodyLines.join('\n')}\n`;
}

/**
 * Export a single bookmark
 */
export async function exportBookmark(
  bookmark: ProcessedBookmark,
  config?: ObsidianConfig | null,
  options: ExportOptions = {}
): Promise<ExportResult> {
  if (!isRecord(bookmark)) {
    throw new Error('exportBookmark: bookmark is required and must be an object');
  }
  if (!bookmark.id || typeof bookmark.id !== 'string') {
    throw new Error('exportBookmark: bookmark.id is required and must be a string');
  }
  if (!bookmark.category || typeof bookmark.category !== 'string') {
    throw new Error('exportBookmark: bookmark.category is required');
  }

  config = config || (await loadConfig());

  if (!config.vaultPath) {
    throw new Error('Obsidian vault path not configured. Run: node src/obsidian.js config --vault /path/to/vault');
  }

  const categoryFolder = config.categoryFolders[bookmark.category];
  if (categoryFolder === null) {
    return { exported: false, reason: 'Category configured to skip' };
  }

  let destFolder = path.join(config.vaultPath, config.bookmarksFolder);
  if (config.useCategoryFolders && categoryFolder) {
    destFolder = path.join(destFolder, categoryFolder);
  }

  if (!existsSync(destFolder)) {
    await mkdir(destFolder, { recursive: true });
  }

  const filename = generateFilename(bookmark, config);
  const filepath = path.join(destFolder, filename);
  const existingContent = existsSync(filepath) ? await readFile(filepath, 'utf-8') : null;
  const existingFrontmatter = existingContent ? extractFrontmatter(existingContent).frontmatter : null;

  const mediaAssets = await downloadMediaAssets(bookmark, config, destFolder);
  const articleEmbeds = await exportArticleNotes(bookmark, config);
  const articlePayloads = buildArticlePayloads(bookmark, config, articleEmbeds);

  const generated = generateMarkdown(bookmark, config, {
    existingFrontmatter,
    mediaAssets,
    articlePayloads,
  });

  const content = existingContent && !options.regenerate ? mergeMarkdown(existingContent, generated) : generated;

  if (options.validate) {
    validateMarkdown(content, config);
  }

  await writeFile(filepath, content);

  await withExportStateLock(async () => {
    const state = await loadExportState();
    const bookmarkId = bookmark.id;
    if (bookmarkId && !state.exportedIds.includes(bookmarkId)) {
      state.exportedIds.push(bookmarkId);
    }
    state.lastExport = new Date().toISOString();
    await saveExportState(state);
    invalidateExportStateCache();
  });

  return {
    exported: true,
    filepath,
    filename,
    folder: categoryFolder || 'root',
  };
}

/**
 * Export multiple bookmarks
 */
export async function exportBookmarks(
  bookmarks: ProcessedBookmark[],
  config?: ObsidianConfig | null,
  options: ExportOptions = {}
): Promise<ExportBatchResult> {
  config = config || (await loadConfig());

  const results: ExportBatchResult = {
    exported: 0,
    skipped: 0,
    errors: 0,
    files: [],
  };

  for (const bookmark of bookmarks) {
    try {
      const result = await exportBookmark(bookmark, config, options);

      if (result.exported) {
        results.exported++;
        if (result.filepath) results.files.push(result.filepath);
      } else {
        results.skipped++;
      }
    } catch (error) {
      results.errors++;
      console.error(`Error exporting ${bookmark.id}: ${error}`);
    }
  }

  return results;
}

/**
 * Check if bookmark exported
 */
export async function isExported(bookmarkId: string): Promise<boolean> {
  const exportedIds = await loadExportedIdSet();
  return exportedIds.has(bookmarkId);
}

/**
 * Get export statistics
 */
export async function getExportStats(): Promise<{ totalExported: number; lastExport: string | null }> {
  const state = await loadExportState();
  return {
    totalExported: state.exportedIds.length,
    lastExport: state.lastExport,
  };
}

function formatCategoryTitle(key: string): string {
  const words = key.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(' ');
}

/**
 * Generate index file
 */
export async function generateIndex(config?: ObsidianConfig | null): Promise<string> {
  config = config || (await loadConfig());

  if (!config.vaultPath) {
    throw new Error('Vault path not configured');
  }

  const indexPath = path.join(config.vaultPath, config.bookmarksFolder, 'Bookmark Index.md');

  const categoryLayouts: Record<string, { title: string; table: string; where: string; limit: number }> = {
    try: {
      title: 'Tools to Try',
      table: 'TABLE author, priority, status',
      where: 'status = "unread"',
      limit: 20,
    },
    review: {
      title: 'To Read',
      table: 'TABLE author, priority, status',
      where: 'status = "unread"',
      limit: 20,
    },
    knowledge: {
      title: 'Insights',
      table: 'TABLE author, priority',
      where: '',
      limit: 20,
    },
    life: {
      title: 'Life',
      table: 'TABLE author, priority, status',
      where: 'status = "unread"',
      limit: 20,
    },
  };

  const categorySections = Object.entries(config.categoryFolders)
    .filter(([_, folder]) => folder !== null)
    .map(([key, folder]) => {
      const layout = categoryLayouts[key] || {
        title: formatCategoryTitle(key),
        table: 'TABLE author, priority, status',
        where: 'status = "unread"',
        limit: 20,
      };
      const useFolders = config!.useCategoryFolders && folder;
      const fromPath = useFolders ? `${config!.bookmarksFolder}/${folder}` : config!.bookmarksFolder;
      const whereParts: string[] = [];
      if (!useFolders) {
        whereParts.push(`category = "${key}"`);
      }
      if (layout.where) {
        whereParts.push(layout.where);
      }
      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      return `### ${layout.title}
\`\`\`dataview
${layout.table}
FROM "${fromPath}"
${whereClause}
SORT processed DESC
LIMIT ${layout.limit}
\`\`\`
`;
    })
    .join('\n');

  const content = `---
tags:
  - index
  - bookmarks
---

# Bookmark Index

This index is auto-generated by the bookmark automation system.

## By Category

${categorySections}

## Recent Bookmarks

\`\`\`dataview
TABLE category, author, priority
FROM "${config.bookmarksFolder}"
SORT processed DESC
LIMIT 30
\`\`\`

## By Priority

### High Priority
\`\`\`dataview
LIST
FROM "${config.bookmarksFolder}"
WHERE priority = "high" AND status = "unread"
SORT processed DESC
\`\`\`

## Statistics

- Total exported: \`= length(filter(pages("${config.bookmarksFolder}"), (p) => p.file))\`
- Unread: \`= length(filter(pages("${config.bookmarksFolder}"), (p) => p.status = "unread"))\`

---
*Last updated: ${new Date().toISOString()}*
`;

  const destFolder = path.join(config.vaultPath, config.bookmarksFolder);
  if (!existsSync(destFolder)) {
    await mkdir(destFolder, { recursive: true });
  }

  await writeFile(indexPath, content);
  return indexPath;
}
