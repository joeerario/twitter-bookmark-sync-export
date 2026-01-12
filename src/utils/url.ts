import type { TwitterUrlEntity } from '../types.js';

export function extractTweetIdFromUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    const match = parsed.pathname.match(/status\/(\d+)/);
    return match?.[1] ?? null;
  } catch {
    const match = input.match(/status\/(\d+)/);
    return match?.[1] ?? null;
  }
}

export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>[\]()]+[^\s<>[\]().,;:!?'\")\]]/g;
  const matches = text.match(urlRegex) || [];

  return matches.map((url) => url.replace(/[).,;:!?'\"]+$/, ''));
}

export function collectUrlCandidates(entities?: TwitterUrlEntity[], text?: string): string[] {
  const urls = new Set<string>();
  if (entities) {
    for (const entity of entities) {
      if (entity.expanded_url) urls.add(entity.expanded_url);
      if (entity.url) urls.add(entity.url);
      if (entity.display_url) urls.add(entity.display_url);
    }
  }
  if (text) {
    for (const match of extractUrlsFromText(text)) {
      urls.add(match);
    }
  }
  return Array.from(urls);
}
