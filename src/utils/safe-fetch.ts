/**
 * Safe URL Fetching
 *
 * Provides SSRF-safe URL validation and fetching.
 * Blocks requests to localhost, private IPs, and cloud metadata endpoints.
 *
 * Defenses:
 * - DNS resolution validation (checks all A/AAAA records)
 * - Manual redirect handling with revalidation
 * - IPv6 address validation
 * - Integer/hex/octal IP format detection
 * - Response size limits
 */

import dns from 'dns/promises';
import { toErrorMessage } from './errors.js';

interface ValidationResult {
  valid: boolean;
  url?: string;
  error?: string;
}

// Blocked hostnames
const BLOCKED_HOSTS = new Set(['localhost', '0.0.0.0']);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB default limit

/**
 * Check if an IPv4 address is in a private/blocked range
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // Invalid format, block it
  }

  const [a, b, c, d] = parts;

  // Loopback: 127.0.0.0/8
  if (a === 127) return true;

  // Private: 10.0.0.0/8
  if (a === 10) return true;

  // Private: 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;

  // Private: 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // Link-local / APIPA: 169.254.0.0/16
  if (a === 169 && b === 254) return true;

  // Current network: 0.0.0.0/8
  if (a === 0) return true;

  // Broadcast: 255.255.255.255
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  // Shared Address Space: 100.64.0.0/10 (often used for carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Check if an IPv6 address is in a private/blocked range
 */
function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback: ::1
  if (normalized === '::1' || normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return true;
  }

  // Unspecified: ::
  if (normalized === '::' || normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return true;
  }

  // Link-local: fe80::/10
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // Unique local: fc00::/7 (fd00::/8 is commonly used)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) - check the embedded IPv4
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice(7);
    if (ipv4Part.includes('.')) {
      return isBlockedIPv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Detect integer, hex, or octal IP representations and convert to dotted decimal
 * Examples:
 * - 2130706433 -> 127.0.0.1 (integer)
 * - 0x7f000001 -> 127.0.0.1 (hex)
 * - 0177.0.0.1 -> 127.0.0.1 (octal)
 */
function normalizeIPv4(hostname: string): string | null {
  // Pure integer IP (e.g., 2130706433)
  if (/^\d+$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join('.');
    }
  }

  // Hex IP (e.g., 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const num = parseInt(hostname, 16);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join('.');
    }
  }

  // Dotted format with potential octal/hex components
  if (hostname.includes('.')) {
    const parts = hostname.split('.');
    if (parts.length <= 4 && parts.every(p => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))) {
      const nums = parts.map(p => {
        if (p.toLowerCase().startsWith('0x')) return parseInt(p, 16);
        if (p.startsWith('0') && p.length > 1) return parseInt(p, 8);
        return parseInt(p, 10);
      });

      if (nums.every(n => !Number.isNaN(n) && n >= 0 && n <= 255)) {
        // Pad to 4 parts if needed (short forms like 127.1 -> 127.0.0.1)
        while (nums.length < 4) {
          nums.splice(nums.length - 1, 0, 0);
        }
        return nums.join('.');
      }
    }
  }

  return null;
}

/**
 * Resolve DNS and check if any resolved IP is blocked
 */
async function validateResolvedIPs(hostname: string): Promise<{ valid: boolean; error?: string }> {
  // First check if hostname itself is a blocked IP (including integer/hex forms)
  const normalizedIP = normalizeIPv4(hostname);
  if (normalizedIP) {
    if (isBlockedIPv4(normalizedIP)) {
      return { valid: false, error: `Blocked IP address: ${hostname} (${normalizedIP})` };
    }
  }

  // Check if it's a direct IPv6
  if (hostname.includes(':')) {
    if (isBlockedIPv6(hostname)) {
      return { valid: false, error: `Blocked IPv6 address: ${hostname}` };
    }
  }

  // If it looks like a plain IP already and passed checks, allow it
  if (normalizedIP || /^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    return { valid: true };
  }

  // Resolve DNS and check all A/AAAA records
  try {
    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const ips: string[] = [];
    if (ipv4Results.status === 'fulfilled') {
      ips.push(...ipv4Results.value);
    }
    if (ipv6Results.status === 'fulfilled') {
      ips.push(...ipv6Results.value);
    }

    if (ips.length === 0) {
      return { valid: false, error: `DNS resolution failed for ${hostname}` };
    }

    for (const ip of ips) {
      if (ip.includes(':')) {
        if (isBlockedIPv6(ip)) {
          return { valid: false, error: `DNS resolved to blocked IPv6: ${ip}` };
        }
      } else {
        if (isBlockedIPv4(ip)) {
          return { valid: false, error: `DNS resolved to blocked IP: ${ip}` };
        }
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: `DNS resolution failed for ${hostname}` };
  }
}

/**
 * Validate a URL for SSRF safety (sync validation only - no DNS lookup)
 */
export function validateUrl(urlString: string): ValidationResult {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'Invalid URL: empty or not a string' };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { valid: false, error: `Blocked protocol: ${url.protocol}` };
  }

  // Check for credentials in URL
  if (url.username || url.password) {
    return { valid: false, error: 'URLs with credentials are not allowed' };
  }

  // Check blocked hosts (note: URL.hostname strips brackets from IPv6)
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    return { valid: false, error: `Blocked host: ${hostname}` };
  }

  // Check if hostname is a blocked IP (handles ::1, integer IPs, etc.)
  const normalizedIP = normalizeIPv4(hostname);
  if (normalizedIP && isBlockedIPv4(normalizedIP)) {
    return { valid: false, error: `Blocked IP address: ${hostname}` };
  }

  // Check IPv6 (URL.hostname returns IPv6 without brackets)
  if (hostname.includes(':') && isBlockedIPv6(hostname)) {
    return { valid: false, error: `Blocked IPv6 address: ${hostname}` };
  }

  return { valid: true, url: url.toString() };
}

/**
 * Full URL validation including DNS resolution
 */
export async function validateUrlWithDNS(urlString: string): Promise<ValidationResult> {
  // First do sync validation
  const syncResult = validateUrl(urlString);
  if (!syncResult.valid) {
    return syncResult;
  }

  // Then validate resolved IPs
  const url = new URL(urlString);
  const dnsResult = await validateResolvedIPs(url.hostname);
  if (!dnsResult.valid) {
    return { valid: false, error: dnsResult.error };
  }

  return { valid: true, url: syncResult.url };
}

interface FetchOptions {
  timeout?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  maxBytes?: number;
}

interface FetchResult {
  success: boolean;
  data?: string;
  status?: number;
  contentType?: string;
  error?: string;
  finalUrl?: string;
}

interface FetchBinaryResult {
  success: boolean;
  data?: Uint8Array;
  status?: number;
  contentType?: string;
  error?: string;
  finalUrl?: string;
}

/**
 * Read response body with size limit
 */
async function readWithSizeLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > maxBytes) {
        reader.cancel();
        throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks and decode
  const fullArray = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    fullArray.set(chunk, offset);
    offset += chunk.length;
  }

  return decoder.decode(fullArray);
}

/**
 * Read response body as bytes with size limit
 */
async function readBytesWithSizeLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > maxBytes) {
        reader.cancel();
        throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const fullArray = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    fullArray.set(chunk, offset);
    offset += chunk.length;
  }

  return fullArray;
}

/**
 * Safely fetch a URL with SSRF protection.
 *
 * Implements:
 * - DNS resolution validation
 * - Manual redirect handling with revalidation
 * - Response size limits
 */
export async function safeFetch(urlString: string, options: FetchOptions = {}): Promise<FetchResult> {
  const {
    timeout = 30_000,
    headers = {},
    maxRedirects = MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES
  } = options;

  let currentUrl = urlString;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    // Validate URL including DNS resolution
    const validation = await validateUrlWithDNS(currentUrl);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(validation.url!, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BookmarkBot/1.0)',
            ...headers,
          },
          redirect: 'manual', // Handle redirects manually to validate each hop
        });

        clearTimeout(timeoutId);

        // Handle redirects
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return {
              success: false,
              status: response.status,
              error: `Redirect (${response.status}) without Location header`
            };
          }

          // Resolve relative URLs
          const redirectUrl = new URL(location, currentUrl).toString();
          currentUrl = redirectUrl;
          redirectCount++;

          if (redirectCount > maxRedirects) {
            return {
              success: false,
              error: `Too many redirects (max: ${maxRedirects})`
            };
          }

          continue; // Loop to validate and fetch the redirect target
        }

        if (!response.ok) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}: ${response.statusText}`,
          };
        }

        const contentType = response.headers.get('content-type') || '';
        const data = await readWithSizeLimit(response, maxBytes);

        return {
          success: true,
          data,
          status: response.status,
          contentType,
          finalUrl: currentUrl,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      const message = toErrorMessage(e);
      if (message.includes('abort')) {
        return { success: false, error: `Request timeout after ${timeout}ms` };
      }
      if (message.includes('maximum size')) {
        return { success: false, error: message };
      }
      return { success: false, error: message };
    }
  }

  return { success: false, error: `Too many redirects (max: ${maxRedirects})` };
}

/**
 * Safely fetch a URL as binary with SSRF protection.
 */
export async function safeFetchBinary(urlString: string, options: FetchOptions = {}): Promise<FetchBinaryResult> {
  const {
    timeout = 30_000,
    headers = {},
    maxRedirects = MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES
  } = options;

  let currentUrl = urlString;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const validation = await validateUrlWithDNS(currentUrl);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(validation.url!, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BookmarkBot/1.0)',
            ...headers,
          },
          redirect: 'manual',
        });

        clearTimeout(timeoutId);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return {
              success: false,
              status: response.status,
              error: `Redirect (${response.status}) without Location header`
            };
          }

          const redirectUrl = new URL(location, currentUrl).toString();
          currentUrl = redirectUrl;
          redirectCount++;

          if (redirectCount > maxRedirects) {
            return {
              success: false,
              error: `Too many redirects (max: ${maxRedirects})`
            };
          }

          continue;
        }

        if (!response.ok) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}: ${response.statusText}`,
          };
        }

        const contentType = response.headers.get('content-type') || '';
        const data = await readBytesWithSizeLimit(response, maxBytes);

        return {
          success: true,
          data,
          status: response.status,
          contentType,
          finalUrl: currentUrl,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      const message = toErrorMessage(e);
      if (message.includes('abort')) {
        return { success: false, error: `Request timeout after ${timeout}ms` };
      }
      if (message.includes('maximum size')) {
        return { success: false, error: message };
      }
      return { success: false, error: message };
    }
  }

  return { success: false, error: `Too many redirects (max: ${maxRedirects})` };
}
