import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { withGate } from './concurrency';
import type { AIConfig } from '../types';

interface CacheEntry {
  value: string;
  expiresAt: number;
  negative?: boolean;
  disk?: boolean;
}

const searchCache: Map<string, CacheEntry> = new Map();
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'search_cache');
const CACHE_FILE = path.join(CACHE_DIR, 'search-cache.json');
const MAX_RESPONSE_BYTES = 768 * 1024;
let maxCacheEntries = 200;
let cacheHits = 0;
let cacheMisses = 0;
let diskHits = 0;
let diskLoaded = false;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
const inFlightSearches: Map<string, Promise<string>> = new Map();
let searchRunner: (query: string, timeoutMs: number) => Promise<string> = runSearchWithBudget;

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pruneCache(markDirty: boolean = true): void {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) {
      searchCache.delete(key);
      changed = true;
    }
  }
  if (searchCache.size > maxCacheEntries) {
    const overflow = searchCache.size - maxCacheEntries;
    for (const key of [...searchCache.keys()].slice(0, overflow)) {
      searchCache.delete(key);
      changed = true;
    }
  }
  if (changed && markDirty) scheduleFlush();
}

function loadDiskCache(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    ensureCacheDir();
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || typeof entry.value !== 'string' || typeof entry.expiresAt !== 'number') continue;
      if (entry.expiresAt <= now) continue;
      entry.negative = entry.negative === true;
      entry.disk = true;
      searchCache.set(key, entry);
    }
    if (searchCache.size > 0) console.log(`[Search] 加载${searchCache.size}条磁盘缓存`);
  } catch (err) {
    console.error('[Search] 磁盘缓存加载失败:', err instanceof Error ? err.message : err);
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDiskCache();
  }, 5000);
  flushTimer.unref();
}

function flushDiskCache(): void {
  if (!dirty) return;
  dirty = false;
  try {
    ensureCacheDir();
    pruneCache(false);
    const payload = JSON.stringify(Object.fromEntries(searchCache), null, 0);
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error('[Search] 磁盘缓存写入失败:', err instanceof Error ? err.message : err);
  }
}

function decodeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(text: string): string {
  return decodeHtml(text.replace(/<[^>]*>/g, ' '));
}

function decodeXml(text: string): string {
  return decodeHtml(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function extractResultUrl(href: string): string {
  const decoded = decodeHtml(href);
  const uddg = decoded.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return uddg[1];
    }
  }
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  return '';
}

function httpsGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; qqbot/1.0)',
        'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      let data = '';
      let totalBytes = 0;

      if (res.statusCode && res.statusCode >= 400) {
        finish('');
        res.resume();
        return;
      }

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          finish('');
          req.destroy();
          return;
        }
        data += chunk.toString();
      });
      res.on('end', () => finish(data));
    });

    req.on('error', () => finish(''));
    req.setTimeout(timeoutMs, () => {
      finish('');
      req.destroy();
    });
  });
}

async function instantAnswerSearch(query: string, timeoutMs: number): Promise<string> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
  const data = await httpsGet(url, timeoutMs);
  if (!data) return '';

  try {
    const json = JSON.parse(data);
    const results: string[] = [];

    if (json.Abstract) results.push(json.Abstract);
    if (json.Answer) results.push(json.Answer);
    if (Array.isArray(json.RelatedTopics)) {
      for (const topic of json.RelatedTopics.slice(0, 3)) {
        if (topic.Text) results.push(topic.Text);
      }
    }

    return results.join('\n').slice(0, 900);
  } catch {
    return '';
  }
}

async function htmlSearch(query: string, timeoutMs: number): Promise<string> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://duckduckgo.com/html/?q=${encodedQuery}`;
  const html = await httpsGet(url, timeoutMs);
  if (!html) return '';

  const results: string[] = [];
  const itemPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(html)) && results.length < 3) {
    const url = extractResultUrl(match[1]);
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);
    if (title || snippet) {
      results.push(`${title}: ${snippet}${url ? `\n${url}` : ''}`.slice(0, 360));
    }
  }

  if (results.length > 0) return results.join('\n');

  const titlePattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((match = titlePattern.exec(html)) && results.length < 3) {
    const url = extractResultUrl(match[1]);
    const title = stripHtml(match[2]);
    if (title) results.push(`${title}${url ? `\n${url}` : ''}`.slice(0, 220));
  }
  return results.join('\n');
}

async function bingRssSearch(query: string, timeoutMs: number): Promise<string> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.bing.com/search?format=rss&q=${encodedQuery}`;
  const xml = await httpsGet(url, timeoutMs);
  if (!xml) return '';

  const results: string[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) && results.length < 4) {
    const item = match[1];
    const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const description = stripHtml(decodeXml((item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || ''));
    if (title || description || link) {
      results.push(`${title}: ${description}${link ? `\n${link}` : ''}`.slice(0, 420));
    }
  }
  return results.join('\n');
}

function remainingTimeout(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function runSearchWithBudget(query: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let value = '';

  const instantBudget = Math.max(250, Math.floor(timeoutMs * 0.4));
  if (remainingTimeout(deadline) > 200) {
    value = await instantAnswerSearch(query, Math.min(instantBudget, remainingTimeout(deadline)));
  }
  if (!value && remainingTimeout(deadline) > 250) {
    const htmlBudget = Math.max(250, Math.floor(timeoutMs * 0.35));
    value = await htmlSearch(query, Math.min(htmlBudget, remainingTimeout(deadline)));
  }
  if (!value && remainingTimeout(deadline) > 250) {
    value = await bingRssSearch(query, remainingTimeout(deadline));
  }
  return value.slice(0, 1000);
}

/** 轻量联网搜索：先 Instant Answer，再 HTML/Bing RSS 兜底，带 single-flight。 */
export async function webSearch(
  query: string,
  timeoutMs: number = 3000,
  cacheSeconds: number = 300,
  negativeCacheSeconds: number = 60,
): Promise<string> {
  loadDiskCache();
  const cacheKey = normalizeQuery(query);
  if (!cacheKey) return '';

  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    cacheHits++;
    if (cached.disk) diskHits++;
    return cached.value;
  }

  const existing = inFlightSearches.get(cacheKey);
  if (existing) {
    cacheHits++;
    return existing;
  }
  cacheMisses++;

  const pending = withGate('search', () => searchRunner(query, Math.max(300, timeoutMs)))
    .then((value) => {
      const ttl = value ? cacheSeconds : negativeCacheSeconds;
      if (ttl > 0) {
        searchCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + ttl * 1000,
          negative: !value,
        });
        pruneCache();
        scheduleFlush();
      }
      return value;
    })
    .finally(() => {
      inFlightSearches.delete(cacheKey);
    });
  inFlightSearches.set(cacheKey, pending);
  return pending;
}

export function getSearchStats(): { cacheEntries: number; maxEntries: number; hits: number; misses: number; diskHits: number; negativeEntries: number; inFlight: number } {
  loadDiskCache();
  pruneCache();
  return {
    cacheEntries: searchCache.size,
    maxEntries: maxCacheEntries,
    hits: cacheHits,
    misses: cacheMisses,
    diskHits,
    negativeEntries: [...searchCache.values()].filter((entry) => entry.negative).length,
    inFlight: inFlightSearches.size,
  };
}

export function cleanSearchCache(): void {
  loadDiskCache();
  pruneCache();
  flushDiskCache();
}

export function configureSearchCache(config?: Pick<AIConfig, 'search_cache_max_entries'>): void {
  const next = Math.floor(Number(config?.search_cache_max_entries) || 200);
  maxCacheEntries = Math.max(20, Math.min(next, 5000));
  pruneCache();
}

export function __setSearchRunnerForTests(
  runner?: (query: string, timeoutMs: number) => Promise<string>,
): void {
  searchRunner = runner || runSearchWithBudget;
}

export function __clearSearchCacheForTests(): void {
  searchCache.clear();
  inFlightSearches.clear();
  cacheHits = 0;
  cacheMisses = 0;
  diskHits = 0;
  diskLoaded = true;
  dirty = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
