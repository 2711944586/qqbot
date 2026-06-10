import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { webSearch } from './web-search';

/**
 * CS2 实时数据接口 - 多层兜底
 *
 * 数据源优先级：
 * 1. CS API 结构化 JSON (api.csapi.de, HLTV/VRS 数据镜像，无 key)
 * 2. Liquipedia MediaWiki API (赛程兜底, bot 友好)
 * 3. webSearch 兜底 (DuckDuckGo/Bing)
 * 4. 缓存命中
 *
 * Liquipedia ToS: 普通API ≥2s；action=parse 更重，按 ≥30s 间隔处理，UA 带项目标识
 */

interface CacheEntry {
  data: string;
  expiresAt: number;
  createdAt: number;
  lastHitAt: number;
  hits: number;
  fetchMs: number;
  source: string;
  disk?: boolean;
}

interface DiskCachePayload {
  version?: number;
  savedAt?: number;
  entries?: Record<string, CacheEntry>;
}

interface SourceLink {
  label: string;
  url: string;
}

interface HttpFetchMeta {
  url: string;
  finalUrl: string;
  statusCode: number;
  body: string;
}

interface HltvMatchLinkCheck {
  matchId: string;
  candidateUrl: string;
  searchUrl: string;
  status: 'verified' | 'reachable_unverified' | 'not_found' | 'blocked' | 'unknown';
  httpStatus: number;
  finalUrl: string;
  reason: string;
  checkedAt: number;
  cached: boolean;
}

export interface HltvCacheEntrySnapshot {
  key: string;
  source: string;
  status: 'fresh' | 'stale';
  ttlSeconds: number;
  expiredSeconds: number;
  ageSeconds: number;
  hits: number;
  fetchMs: number;
  disk: boolean;
}

export interface HltvLinkCheckSnapshot {
  matchId: string;
  status: HltvMatchLinkCheck['status'];
  httpStatus: number;
  ttlSeconds: number;
  ageSeconds: number;
  checkedAt: number;
  finalUrl: string;
  reason: string;
}

export interface HltvStalePruneResult {
  beforeFresh: number;
  beforeStale: number;
  afterFresh: number;
  afterStale: number;
  removed: number;
  removedKeys: string[];
  inFlight: number;
  linkChecks: number;
  diskError: string;
}

const cache: Map<string, CacheEntry> = new Map();
const inFlightFetches: Map<string, Promise<string>> = new Map();
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'cs-realtime-cache.json');
const MAX_CACHE_ENTRIES = 80;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'wanjier-bot/1.0 (https://github.com/2711944586/qqbot; CS2 group chat bot)';
const CS_API_BASE = 'https://api.csapi.de';
const CS_API_LINK = `${CS_API_BASE}/`;
const HLTV_MATCHES_URL = 'https://www.hltv.org/matches';
const HLTV_RESULTS_URL = 'https://www.hltv.org/results';
const HLTV_RANKING_URL = 'https://www.hltv.org/ranking/teams';
const LIQUIPEDIA_MATCHES_URL = 'https://liquipedia.net/counterstrike/Liquipedia:Matches';
const LIQUIPEDIA_VRS_URL = 'https://liquipedia.net/counterstrike/Valve_Regional_Standings';

let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 30000; // Liquipedia ToS: action=parse 请求不超过 1/30s
let rateLimitedUntil = 0;
let cacheHits = 0;
let cacheMisses = 0;
let cacheExpired = 0;
let cacheWrites = 0;
let inFlightHits = 0;
let fetchFailures = 0;
let staleServed = 0;
let lastRefreshAt = 0;
let lastError = '';
let diskLoaded = false;
let diskHits = 0;
let diskEntriesLoaded = 0;
let lastDiskLoadAt = 0;
let lastDiskFlushAt = 0;
let lastDiskError = '';
let cachePrunes = 0;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

// 共享的 HTML 缓存（fetchOngoingMatches 和 fetchRecentResults 都用同一页面）
let matchesHtmlCache: { html: string; expiresAt: number } | null = null;
const MATCHES_HTML_TTL = 4 * 60 * 1000; // 4 分钟
const STALE_MATCHES_MAX_MS = 45 * 60 * 1000;
const STALE_RESULTS_MAX_MS = 12 * 60 * 60 * 1000;
const STALE_RANKING_MAX_MS = 24 * 60 * 60 * 1000;
const STALE_PROFILE_MAX_MS = 24 * 60 * 60 * 1000;
const HLTV_LINK_CHECK_TTL_MS = 10 * 60 * 1000;
const hltvLinkCheckCache: Map<string, { result: HltvMatchLinkCheck; expiresAt: number }> = new Map();

type HttpMetaFetcher = (url: string, timeoutMs: number) => Promise<HttpFetchMeta>;
let httpMetaFetcherForTests: HttpMetaFetcher | null = null;

function maxStaleMsForCacheKey(key: string): number {
  if (key === 'matches') return STALE_MATCHES_MAX_MS;
  if (key === 'results') return STALE_RESULTS_MAX_MS;
  if (key === 'ranking') return STALE_RANKING_MAX_MS;
  if (key.startsWith('match:')) return STALE_RESULTS_MAX_MS;
  if (key.startsWith('team:') || key.startsWith('player:')) return STALE_PROFILE_MAX_MS;
  return 12 * 60 * 60 * 1000;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function normalizeDiskEntry(value: Partial<CacheEntry> | undefined): CacheEntry | null {
  if (!value || typeof value.data !== 'string' || typeof value.expiresAt !== 'number') return null;
  const now = Date.now();
  return {
    data: value.data,
    expiresAt: value.expiresAt,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    lastHitAt: typeof value.lastHitAt === 'number' ? value.lastHitAt : 0,
    hits: typeof value.hits === 'number' ? value.hits : 0,
    fetchMs: typeof value.fetchMs === 'number' ? value.fetchMs : 0,
    source: typeof value.source === 'string' ? value.source : 'disk',
    disk: true,
  };
}

function shouldKeepCacheEntry(key: string, entry: CacheEntry, now: number = Date.now()): boolean {
  if (!entry.data || !entry.createdAt || entry.createdAt > now + 60_000) return false;
  if (entry.expiresAt > now) return true;
  return now - entry.createdAt <= maxStaleMsForCacheKey(key);
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDiskCache();
  }, 4000);
  flushTimer.unref();
}

function pruneCache(markDirty: boolean = true): void {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of cache) {
    if (!shouldKeepCacheEntry(key, entry, now)) {
      cache.delete(key);
      changed = true;
    }
  }

  if (cache.size > MAX_CACHE_ENTRIES) {
    const overflow = cache.size - MAX_CACHE_ENTRIES;
    const sorted = [...cache.entries()].sort((a, b) => {
      const aFresh = a[1].expiresAt > now;
      const bFresh = b[1].expiresAt > now;
      if (aFresh !== bFresh) return aFresh ? 1 : -1;
      return (a[1].lastHitAt || a[1].createdAt) - (b[1].lastHitAt || b[1].createdAt);
    });
    for (const [key] of sorted.slice(0, overflow)) {
      cache.delete(key);
      changed = true;
    }
  }

  if (changed) {
    cachePrunes++;
    if (markDirty) scheduleFlush();
  }
}

function loadDiskCache(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  lastDiskLoadAt = Date.now();
  try {
    ensureCacheDir();
    if (!fs.existsSync(CACHE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as DiskCachePayload | Record<string, CacheEntry>;
    const entries = 'entries' in parsed && parsed.entries ? parsed.entries : parsed as Record<string, CacheEntry>;
    const now = Date.now();
    let loaded = 0;
    for (const [key, rawEntry] of Object.entries(entries)) {
      const entry = normalizeDiskEntry(rawEntry);
      if (!entry || !shouldKeepCacheEntry(key, entry, now)) continue;
      const existing = cache.get(key);
      if (existing && existing.createdAt >= entry.createdAt) continue;
      cache.set(key, entry);
      loaded++;
    }
    diskEntriesLoaded = loaded;
    pruneCache(false);
    if (loaded > 0) console.log(`[CSData] 加载${loaded}条实时数据磁盘缓存`);
  } catch (err) {
    lastDiskError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    console.error('[CSData] 磁盘缓存加载失败:', lastDiskError);
  }
}

function flushDiskCache(): void {
  if (!dirty) return;
  dirty = false;
  try {
    ensureCacheDir();
    pruneCache(false);
    const now = Date.now();
    const entries = Object.fromEntries(
      [...cache.entries()]
        .filter(([key, entry]) => shouldKeepCacheEntry(key, entry, now))
        .map(([key, entry]) => [key, {
          data: entry.data,
          expiresAt: entry.expiresAt,
          createdAt: entry.createdAt,
          lastHitAt: entry.lastHitAt,
          hits: entry.hits,
          fetchMs: entry.fetchMs,
          source: entry.source,
        }]),
    );
    const payload: DiskCachePayload = { version: 1, savedAt: now, entries };
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf-8');
    fs.renameSync(tmp, CACHE_FILE);
    lastDiskFlushAt = now;
    lastDiskError = '';
  } catch (err) {
    lastDiskError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    console.error('[CSData] 磁盘缓存写入失败:', lastDiskError);
  }
}

interface CsApiTeamLite {
  id?: number;
  name?: string;
  score?: number;
  rank?: number | null;
}

interface CsApiMap {
  id?: number;
  name?: string;
  team1_score?: number;
  team2_score?: number;
}

interface CsApiMatch {
  id?: number;
  team1?: CsApiTeamLite;
  team2?: CsApiTeamLite;
  maps?: CsApiMap[];
  best_of?: number;
  date?: string;
  event?: string;
  winner?: CsApiTeamLite | null;
}

interface CsApiMatchPlayerStats {
  id?: number;
  name?: string;
  k?: number;
  d?: number;
  swing?: number;
  adr?: number;
  kast?: number;
  rating?: number;
}

interface CsApiMatchStatsTeam {
  id?: number;
  name?: string;
  players?: CsApiMatchPlayerStats[];
}

interface CsApiMatchStatsBlock {
  id?: number;
  name?: string;
  team1?: CsApiMatchStatsTeam;
  team2?: CsApiMatchStatsTeam;
}

interface CsApiRankingItem {
  id?: number;
  name?: string;
  rank?: number;
  rank_diff?: number;
  points?: number;
  points_diff?: number;
}

interface CsApiRankingResponse {
  date?: string;
  rankings?: CsApiRankingItem[];
}

interface CsApiTeamDetail {
  id?: number;
  name?: string;
  streak?: number;
  roster?: Array<{ id?: number; name?: string }>;
}

interface CsApiTeamStats {
  id?: number;
  name?: string;
  n?: number;
  n_wins?: number;
}

interface CsApiPlayerStats {
  id?: number;
  name?: string;
  rank?: number;
  k?: number;
  d?: number;
  adr?: number;
  kast?: number;
  rating?: number;
  N?: number;
}

type CsApiJsonFetcher = <T>(path: string, timeoutMs?: number) => Promise<T | null>;

let csApiJsonFetcherForTests: CsApiJsonFetcher | null = null;

async function getMatchesHtml(): Promise<string> {
  if (matchesHtmlCache && matchesHtmlCache.expiresAt > Date.now()) {
    return matchesHtmlCache.html;
  }
  const html = await fetchLiquipedia('Liquipedia:Matches');
  if (html) {
    matchesHtmlCache = { html, expiresAt: Date.now() + MATCHES_HTML_TTL };
  }
  return html;
}

/** Liquipedia 失败时用 webSearch 兜底，返回简短摘要 */
async function fallbackWebSearch(query: string): Promise<string> {
  try {
    const result = await webSearch(query, 4000, 600, 60);
    if (!result) return '';
    return `${formatSourceStamp('webSearch fallback')}\n${result.slice(0, 600)}`;
  } catch {
    return '';
  }
}

function getCached(key: string): string | null {
  loadDiskCache();
  const entry = cache.get(key);
  if (!entry) {
    cacheMisses++;
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    cacheMisses++;
    if (entry) {
      cacheExpired++;
    }
    return null;
  }
  cacheHits++;
  if (entry.disk) diskHits++;
  entry.hits++;
  entry.lastHitAt = Date.now();
  scheduleFlush();
  return entry.data;
}

function setCached(key: string, data: string, ttlMs: number, source: string = ''): void {
  loadDiskCache();
  cacheWrites++;
  const now = Date.now();
  const previous = cache.get(key);
  cache.set(key, {
    data,
    expiresAt: now + ttlMs,
    createdAt: now,
    lastHitAt: previous?.lastHitAt || 0,
    hits: previous?.hits || 0,
    fetchMs: previous?.fetchMs || 0,
    source,
    disk: false,
  });
  pruneCache();
  scheduleFlush();
}

async function singleFlight(key: string, loader: () => Promise<string>): Promise<string> {
  const existing = inFlightFetches.get(key);
  if (existing) {
    inFlightHits++;
    return existing;
  }

  const startedAt = Date.now();
  const pending = loader()
    .then((value) => {
      lastRefreshAt = Date.now();
      const entry = cache.get(key);
      if (entry) {
        entry.fetchMs = Date.now() - startedAt;
        scheduleFlush();
      }
      if (value) lastError = '';
      return value;
    })
    .catch((err) => {
      fetchFailures++;
      lastError = err instanceof Error ? err.message : String(err);
      return '';
    })
    .finally(() => {
      inFlightFetches.delete(key);
    });
  inFlightFetches.set(key, pending);
  return pending;
}

function requestText(url: string, timeoutMs: number = 8000, redirectCount: number = 0): Promise<string> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(''); return; }
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Encoding': 'gzip',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectCount < 4) {
        let next = '';
        try { next = new URL(res.headers.location, parsed).toString(); } catch { next = ''; }
        res.resume();
        if (!next) {
          finish('');
          return;
        }
        void requestText(next, timeoutMs, redirectCount + 1).then(finish);
        return;
      }
      if (statusCode >= 400) {
        res.resume();
        finish('');
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish('');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => finish(Buffer.concat(chunks).toString()));
      stream.on('error', () => finish(''));
    });
    req.on('error', () => finish(''));
    req.setTimeout(timeoutMs, () => {
      finish('');
      req.destroy();
    });
  });
}

function requestUrlMeta(url: string, timeoutMs: number = 6000, redirectCount: number = 0): Promise<HttpFetchMeta> {
  if (httpMetaFetcherForTests) return httpMetaFetcherForTests(url, timeoutMs);
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ url, finalUrl: url, statusCode: 0, body: '' }); return; }
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;
    const finish = (value: HttpFetchMeta) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,text/plain,*/*',
        'Accept-Encoding': 'gzip',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectCount < 4) {
        let next = '';
        try { next = new URL(res.headers.location, parsed).toString(); } catch { next = ''; }
        res.resume();
        if (!next) {
          finish({ url, finalUrl: url, statusCode, body: '' });
          return;
        }
        void requestUrlMeta(next, timeoutMs, redirectCount + 1).then(finish);
        return;
      }
      if (statusCode >= 400) {
        res.resume();
        finish({ url, finalUrl: url, statusCode, body: '' });
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish({ url, finalUrl: url, statusCode, body: '' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => finish({ url, finalUrl: url, statusCode, body: Buffer.concat(chunks).toString() }));
      stream.on('error', () => finish({ url, finalUrl: url, statusCode, body: '' }));
    });
    req.on('error', () => finish({ url, finalUrl: url, statusCode: 0, body: '' }));
    req.setTimeout(timeoutMs, () => {
      finish({ url, finalUrl: url, statusCode: 0, body: '' });
      req.destroy();
    });
  });
}

function getStaleCached(key: string, maxStaleMs: number): string | null {
  loadDiskCache();
  const entry = cache.get(key);
  const now = Date.now();
  if (!entry || entry.expiresAt > now) return null;
  if (now - entry.createdAt > maxStaleMs) return null;
  staleServed++;
  entry.hits++;
  entry.lastHitAt = now;
  if (entry.disk) diskHits++;
  scheduleFlush();
  return entry.data;
}

async function fetchCsApiJson<T>(path: string, timeoutMs: number = 8000): Promise<T | null> {
  if (csApiJsonFetcherForTests) {
    return csApiJsonFetcherForTests<T>(path, timeoutMs);
  }
  const body = await requestText(`${CS_API_BASE}${path}`, timeoutMs);
  if (!body || /^\s*</.test(body)) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

async function fetchLiquipedia(page: string, timeoutMs: number = 8000): Promise<string> {
  // 触发过限流的话，10 分钟内不再请求
  if (Date.now() < rateLimitedUntil) return '';

  // Rate limit
  const since = Date.now() - lastRequestAt;
  if (since < MIN_REQUEST_GAP_MS) {
    await delay(MIN_REQUEST_GAP_MS - since);
  }
  lastRequestAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const url = `https://liquipedia.net/counterstrike/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
    let parsed: URL;
    try { parsed = new URL(url); } catch { finish(''); return; }

    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    }, (res) => {
      // 429 / 403 = 触发限流，记录冷却期
      if (res.statusCode === 429 || res.statusCode === 403) {
        rateLimitedUntil = Date.now() + 10 * 60 * 1000;
        console.warn(`[hltv] Liquipedia 限流(${res.statusCode})，冷却10分钟`);
        finish('');
        res.resume();
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        finish('');
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish('');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        // 检测是否被 Liquipedia 反爬页面拦截（HTML 而非 JSON）
        if (body.startsWith('<!DOCTYPE') || body.startsWith('<html')) {
          if (/Rate Limited/i.test(body)) {
            rateLimitedUntil = Date.now() + 10 * 60 * 1000;
            console.warn('[hltv] Liquipedia 反爬页面检测到限流，冷却10分钟');
          }
          finish('');
          return;
        }
        try {
          const j = JSON.parse(body);
          finish(j.parse?.text?.['*'] || '');
        } catch {
          finish('');
        }
      });
      stream.on('error', () => finish(''));
    });
    req.on('error', () => finish(''));
    req.setTimeout(timeoutMs, () => {
      finish('');
      req.destroy();
    });
  });
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

interface ParsedMatch {
  team1: string;
  team2: string;
  score1?: string;
  score2?: string;
  unixTimestamp?: number;
  finished: boolean;
  event?: string;
  bo?: string;
}

/** 从 Liquipedia HTML 中解析单个 match-info 块 */
function parseMatchBlocks(html: string): ParsedMatch[] {
  const matches: ParsedMatch[] = [];
  // match-info 块可能在 toggle-area-content-active (upcoming) 或 toggle-area-content (completed)
  // upcoming 用: <span class="timer-object" data-timestamp="N">  (无 data-finished)
  // finished 用: <span class="timer-object timer-object-datetime-only" data-timestamp="N" data-finished="finished">
  // 用 timer-object 锚定，向后查找 match-info-tournament 边界
  const blockRegex = /<span class="timer-object[^"]*"[^>]*data-timestamp="(\d+)"([^>]*)>[\s\S]*?<div class="match-info-tournament"[\s\S]*?<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(html))) {
    const block = m[0];
    const timestamp = parseInt(m[1], 10);
    const finishedAttr = m[2] || '';
    const finished = /data-finished="finished"/.test(finishedAttr);

    // 队名: <span class="name" ...><a ...>TEAM</a></span> 或 <span class="name">TEAM</span>
    const names = [...block.matchAll(/<span class="name"[^>]*>(?:<a[^>]*>([^<]+)<\/a>|([^<]+))<\/span>/g)].map((mm) => decodeHtml((mm[1] || mm[2] || '').trim()));
    if (names.length < 2) continue;
    if (!names[0] || !names[1]) continue;

    // 比分: <span class="match-info-header-scoreholder-score(...)">N</span> 取前两个
    const scoreMatches = [...block.matchAll(/<span class="match-info-header-scoreholder-score(?:[^"]*)"[^>]*>([^<]*)<\/span>/g)].map((mm) => decodeHtml(mm[1].trim()));

    // 如果是 upcoming，scoreholder-upper 是 "vs"，没有数字分数
    const upperMatch = block.match(/<span class="match-info-header-scoreholder-upper"[^>]*>([\s\S]*?)<\/span>/);
    const isVsOnly = upperMatch && /vs/i.test(stripTags(upperMatch[1]));

    // BO: <span class="match-info-header-scoreholder-lower">(Bo3)</span>
    const boMatch = block.match(/<span class="match-info-header-scoreholder-lower"[^>]*>\(([^)]+)\)<\/span>/);

    // 赛事名：<span class="match-info-tournament-name">...<span>NAME</span></span>
    const eventMatch = block.match(/<span class="match-info-tournament-name"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/span>/);

    const result: ParsedMatch = {
      team1: names[0],
      team2: names[1],
      unixTimestamp: isNaN(timestamp) ? undefined : timestamp,
      finished,
      event: eventMatch ? decodeHtml(eventMatch[1].trim()) : undefined,
      bo: boMatch ? boMatch[1] : undefined,
    };
    if (!isVsOnly && scoreMatches.length >= 2) {
      result.score1 = scoreMatches[0];
      result.score2 = scoreMatches[1];
    }
    matches.push(result);
  }
  return matches;
}

function formatTimeShort(unix: number): string {
  const date = new Date(unix * 1000);
  // 转 GMT+8 北京时间显示
  const offset = 8 * 60 * 60 * 1000;
  const cst = new Date(date.getTime() + offset);
  const now = new Date(Date.now() + offset);
  const sameDay = cst.getUTCFullYear() === now.getUTCFullYear() && cst.getUTCMonth() === now.getUTCMonth() && cst.getUTCDate() === now.getUTCDate();
  const tomorrow = (cst.getTime() - now.getTime()) < 36 * 3600 * 1000 && (cst.getTime() - now.getTime()) > 0;
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  if (tomorrow) return `明天 ${hh}:${mm}`;
  return `${cst.getUTCMonth() + 1}/${cst.getUTCDate()} ${hh}:${mm}`;
}

function sourceLinksFor(source: string): SourceLink[] {
  const links: SourceLink[] = [];
  if (/CS API|VRS|排名|队伍/.test(source)) {
    links.push({ label: 'CS API', url: CS_API_LINK });
  }
  if (/HLTV赛果|赛果|results/i.test(source)) {
    links.push({ label: 'HLTV results', url: HLTV_RESULTS_URL });
  }
  if (/排名|VRS|ranking/i.test(source)) {
    links.push({ label: 'HLTV ranking', url: HLTV_RANKING_URL });
    links.push({ label: 'Liquipedia VRS', url: LIQUIPEDIA_VRS_URL });
  }
  if (/Liquipedia赛程|赛程|matches/i.test(source)) {
    links.push({ label: 'HLTV matches', url: HLTV_MATCHES_URL });
    links.push({ label: 'Liquipedia matches', url: LIQUIPEDIA_MATCHES_URL });
  }
  if (/选手|player/i.test(source)) {
    links.push({ label: 'CS API', url: CS_API_LINK });
  }
  const seen = new Set<string>();
  return links.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function hltvMatchPageCandidateUrl(matchId: string | number): string {
  return `${HLTV_MATCHES_URL}/${encodeURIComponent(String(matchId))}/match`;
}

function hltvSearchUrl(query: string | number): string {
  return `https://www.hltv.org/search?query=${encodeURIComponent(String(query))}`;
}

function normalizeMatchIdForLinkCheck(value: string | number): string {
  const match = String(value || '').match(/\d{4,}/);
  return match ? match[0] : '';
}

function classifyHltvMatchLink(meta: HttpFetchMeta, matchId: string): Pick<HltvMatchLinkCheck, 'status' | 'reason'> {
  const finalUrl = meta.finalUrl || meta.url || '';
  const body = meta.body || '';
  if (!meta.statusCode) return { status: 'unknown', reason: '无响应或请求超时' };
  if (meta.statusCode === 403 || meta.statusCode === 429) return { status: 'blocked', reason: `HLTV 返回 ${meta.statusCode}，可能被反爬/限流` };
  if (meta.statusCode === 404 || /(?:page not found|match not found|404)/i.test(body)) return { status: 'not_found', reason: '候选页返回 404/未找到' };
  if (meta.statusCode >= 500) return { status: 'unknown', reason: `HLTV 返回 ${meta.statusCode}，源站或网络不稳定` };
  const sameMatchPath = new RegExp(`/matches/${matchId}(?:/|$)`).test(finalUrl);
  const looksLikeMatchPage = /(?:match-page|match-info|teamsBox|veto-box|stats-content|match-page-link|HLTV\.org)/i.test(body);
  if (meta.statusCode >= 200 && meta.statusCode < 400 && sameMatchPath && looksLikeMatchPage) {
    return { status: 'verified', reason: '候选链接可访问，最终 URL 仍指向该 matchid 的比赛页路径' };
  }
  if (meta.statusCode >= 200 && meta.statusCode < 400) {
    return { status: 'reachable_unverified', reason: 'HTTP 可访问，但页面内容/最终路径不足以证明是对应比赛页' };
  }
  return { status: 'unknown', reason: `HTTP ${meta.statusCode}，无法判断候选页是否有效` };
}

export async function checkHltvMatchPageCandidate(matchIdInput: string | number): Promise<HltvMatchLinkCheck | null> {
  const matchId = normalizeMatchIdForLinkCheck(matchIdInput);
  if (!matchId) return null;
  const now = Date.now();
  const cached = hltvLinkCheckCache.get(matchId);
  if (cached && cached.expiresAt > now) {
    return { ...cached.result, cached: true };
  }
  const candidateUrl = hltvMatchPageCandidateUrl(matchId);
  const searchUrl = hltvSearchUrl(matchId);
  const meta = await requestUrlMeta(candidateUrl, 6000);
  const classified = classifyHltvMatchLink(meta, matchId);
  const result: HltvMatchLinkCheck = {
    matchId,
    candidateUrl,
    searchUrl,
    status: classified.status,
    httpStatus: meta.statusCode,
    finalUrl: meta.finalUrl || meta.url || candidateUrl,
    reason: classified.reason,
    checkedAt: now,
    cached: false,
  };
  hltvLinkCheckCache.set(matchId, { result, expiresAt: now + HLTV_LINK_CHECK_TTL_MS });
  while (hltvLinkCheckCache.size > 50) {
    const first = hltvLinkCheckCache.keys().next().value;
    if (!first) break;
    hltvLinkCheckCache.delete(first);
  }
  return result;
}

function formatHltvLinkCheckStatus(status: HltvMatchLinkCheck['status']): string {
  if (status === 'verified') return '可访问候选';
  if (status === 'reachable_unverified') return '可访问但未证明';
  if (status === 'not_found') return '未找到';
  if (status === 'blocked') return '被拦/限流';
  return '未知';
}

function inspectHltvLinkCheck(matchIdInput: string | number, now: number = Date.now()): HltvLinkCheckSnapshot | null {
  const matchId = normalizeMatchIdForLinkCheck(matchIdInput);
  if (!matchId) return null;
  const entry = hltvLinkCheckCache.get(matchId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    hltvLinkCheckCache.delete(matchId);
    return null;
  }
  return {
    matchId,
    status: entry.result.status,
    httpStatus: entry.result.httpStatus,
    ttlSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
    ageSeconds: Math.max(0, Math.round((now - entry.result.checkedAt) / 1000)),
    checkedAt: entry.result.checkedAt,
    finalUrl: entry.result.finalUrl,
    reason: entry.result.reason,
  };
}

function formatHltvLinkCheckEvidenceForHumans(matchIdInput: string | number): string {
  const matchId = normalizeMatchIdForLinkCheck(matchIdInput);
  if (!matchId) return '';
  const snapshot = inspectHltvLinkCheck(matchId);
  if (!snapshot) {
    return `HLTV候选核验缓存: miss；未运行 /cs hltvcheck ${matchId} 或短 TTL 已过期。本证据卡只读，不现场请求 HLTV。`;
  }
  const finalUrl = snapshot.finalUrl ? ` final=${snapshot.finalUrl}` : '';
  return [
    `HLTV候选核验缓存: ${snapshot.status}(${formatHltvLinkCheckStatus(snapshot.status)})`,
    `http=${snapshot.httpStatus || '无响应'}`,
    `age=${snapshot.ageSeconds}s`,
    `ttl=${snapshot.ttlSeconds}s`,
    finalUrl,
    `reason=${snapshot.reason.slice(0, 80)}`,
  ].filter(Boolean).join(' ');
}

export async function buildHltvMatchLinkCheckReport(matchIdInput: string | number): Promise<string> {
  const matchId = normalizeMatchIdForLinkCheck(matchIdInput);
  if (!matchId) {
    return [
      'HLTV比赛页候选核验',
      '用法: /cs hltvcheck <matchid>',
      '说明: 这是只读活链接核验，不写 CS 事实缓存。',
    ].join('\n');
  }
  const check = await checkHltvMatchPageCandidate(matchId);
  if (!check) return 'HLTV比赛页候选核验\nmatchid 无效。';
  const cacheText = check.cached ? 'hit' : 'miss/live';
  return [
    'HLTV比赛页候选核验',
    `matchid: ${check.matchId}`,
    `候选: ${check.candidateUrl}`,
    `搜索: ${check.searchUrl}`,
    `HTTP: ${check.httpStatus || '无响应'}${check.finalUrl ? ` / 最终URL: ${check.finalUrl}` : ''}`,
    `判定: ${formatHltvLinkCheckStatus(check.status)} - ${check.reason}`,
    `检查: ${new Date(check.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} / 缓存${cacheText} / TTL ${Math.round(HLTV_LINK_CHECK_TTL_MS / 60 / 1000)}m`,
    '模式: 只读；不写 CS 事实缓存，不把“网页能打开”当比分、阵容、地图池或实时赛况证据。',
    '边界: HLTV 页面可能需要 slug，也可能被反爬；当前事实仍看 /cs evidence 和 /cs verify 的 fresh/stale/miss。',
  ].join('\n');
}

function evidenceSourceForKey(key: string): { title: string; source: string } {
  if (key === 'matches') return { title: '当前/即将比赛', source: 'Liquipedia赛程' };
  if (key === 'results') return { title: '最近赛果', source: 'CS API / HLTV赛果镜像' };
  if (key === 'ranking') return { title: '战队排名', source: 'CS API / VRS排名镜像' };
  if (key.startsWith('match:')) return { title: '单场详情', source: 'CS API / 单场详情' };
  if (key.startsWith('team:')) return { title: '队伍资料', source: 'CS API / VRS+队伍数据' };
  if (key.startsWith('player:')) return { title: '选手统计', source: 'CS API / 选手统计' };
  return { title: key, source: 'CS实时数据链路' };
}

function formatEvidenceLinks(source: string): string {
  const links = sourceLinksFor(source);
  return links.length > 0
    ? links.map((item) => `${item.label}: ${item.url}`).join('\n')
    : '暂无可点击来源；先跑 /cs health 看链路。';
}

function formatCacheEvidenceForHumans(key: string): string {
  loadDiskCache();
  const entry = cache.get(key);
  if (!entry) return '当前缓存: miss，还没有成功快照。';
  const now = Date.now();
  const ageSeconds = Math.max(0, Math.round((now - entry.createdAt) / 1000));
  const ttlSeconds = Math.max(0, Math.round((entry.expiresAt - now) / 1000));
  const expiredSeconds = Math.max(0, Math.round((now - entry.expiresAt) / 1000));
  const status = entry.expiresAt > now ? `fresh，TTL ${ttlSeconds}s` : `stale，已过期 ${expiredSeconds}s`;
  const fetched = entry.fetchMs > 0 ? `，抓取 ${entry.fetchMs}ms` : '';
  const disk = entry.disk ? '，来自磁盘缓存' : '';
  const source = entry.source ? `，内部源 ${entry.source}` : '';
  return `当前缓存: ${status}，年龄 ${ageSeconds}s，命中 ${entry.hits}${fetched}${disk}${source}`;
}

export function buildCsDataEvidenceReport(
  target: 'matches' | 'results' | 'ranking' | 'match' | 'team' | 'player' = 'matches',
  subject: string = '',
): string {
  const key = target === 'team' || target === 'player'
    ? getCsProfileCacheKey(target, subject || target)
    : target === 'match'
      ? `match:${subject || 'unknown'}`
    : target;
  const evidence = evidenceSourceForKey(key);
  const source = getCsDataSourceInfo();
  const subjectLine = subject ? `查询目标: ${subject}` : '';
  const matchHltvLinks = target === 'match' && /^\d+$/.test(subject.trim())
    ? [
      `HLTV比赛页候选: ${hltvMatchPageCandidateUrl(subject.trim())}`,
      `HLTV搜索入口: ${hltvSearchUrl(subject.trim())}`,
      `活链路核验: /cs hltvcheck ${subject.trim()}`,
      formatHltvLinkCheckEvidenceForHumans(subject.trim()),
    ]
    : [];
  const staleWindow = Math.round(maxStaleMsForCacheKey(key) / 60 / 1000);
  return [
    'CS数据证据卡',
    `目标: ${evidence.title}`,
    subjectLine,
    `主源: ${source.primaryBaseUrl}`,
    `数据链: ${evidence.source}`,
    '可点击来源:',
    formatEvidenceLinks(evidence.source),
    ...matchHltvLinks,
    formatCacheEvidenceForHumans(key),
    `兜底窗口: 最长 ${staleWindow} 分钟内的旧缓存可兜底，但 stale 只能当线索，不能当实时结论。`,
    '边界: HLTV.org 没有官方免 key 公共 API；比赛页候选是按 matchid 拼的人工核验入口，真实 HLTV 页面可能需要 slug；本项目优先用 CS API 结构化镜像和 Liquipedia 官方 MediaWiki API，群聊回答必须标清来源时间/链接。',
  ].filter(Boolean).join('\n');
}

function compactHumanCacheEvidence(key: string): string {
  return formatCacheEvidenceForHumans(key)
    .replace(/^当前缓存[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

export function buildCsDataEvidenceOverview(): string {
  const stats = getHltvStats();
  const source = getCsDataSourceInfo();
  const coreKeys = ['matches', 'results', 'ranking'];
  const recentItems = stats.items
    .filter((item) => !coreKeys.includes(item.key))
    .slice(0, 8);
  const hitTotal = stats.hits + stats.misses;
  const hitRate = hitTotal > 0 ? `${Math.round((stats.hits / hitTotal) * 100)}%` : '-';
  const lines = [
    'CS数据证据总览',
    `主源: ${source.primaryBaseUrl}`,
    `说明: ${source.note}`,
    `缓存概览: fresh ${stats.entries} / stale ${stats.staleEntries} 命中${stats.hits}/${stats.misses}(${hitRate}) 旧缓存兜底${stats.staleServed} 失败${stats.failures}`,
    '',
    '核心证据:',
    ...coreKeys.map((key) => {
      const evidence = evidenceSourceForKey(key);
      return `- ${evidence.title}(${key}): ${compactHumanCacheEvidence(key)}`;
    }),
    '',
    '核心来源:',
    formatEvidenceLinks('Liquipedia赛程 CS API / HLTV赛果镜像 CS API / VRS排名镜像'),
    '',
    '边界: fresh 可以作为当前快照依据；stale 只能当旧快照线索，不能包装成“刚查最新/实时结论”。',
    '细查: /cs evidence matches、/cs evidence results、/cs evidence ranking、/cs evidence match <id>、/cs evidence team <队伍>。',
  ];

  if (recentItems.length > 0) {
    lines.push('');
    lines.push('最近缓存明细:');
    for (const item of recentItems) {
      const freshness = item.status === 'stale' ? `expired=${item.expiredSeconds}s` : `ttl=${item.ttlSeconds}s`;
      lines.push(`- ${item.key} ${item.status} ${freshness} age=${item.ageSeconds}s hit=${item.hits} source=${item.source}`);
    }
  }

  return lines.join('\n');
}

export function buildCsDataSourcesReport(): string {
  const source = getCsDataSourceInfo();
  const stats = getHltvStats();
  const coreKeys = ['matches', 'results', 'ranking'];
  const coreLines = coreKeys.map((key) => {
    const evidence = evidenceSourceForKey(key);
    return `- ${evidence.title} [${key}]: ${compactHumanCacheEvidence(key)}`;
  });
  const dynamicItems = stats.items
    .filter((item) => !coreKeys.includes(item.key))
    .slice(0, 5)
    .map((item) => `- ${item.key}: ${item.status} age=${item.ageSeconds}s source=${item.source}`);

  return [
    'CS数据来源/链接',
    '模式: 只读，不请求外站、不写缓存、不增加 CS 缓存 hit/miss。',
    `主结构化源: ${source.primaryBaseUrl}`,
    `说明: ${source.note}`,
    '',
    '可点击链接:',
    `CS API: ${CS_API_LINK}`,
    `HLTV matches: ${HLTV_MATCHES_URL}`,
    `HLTV results: ${HLTV_RESULTS_URL}`,
    `HLTV ranking: ${HLTV_RANKING_URL}`,
    `Liquipedia matches: ${LIQUIPEDIA_MATCHES_URL}`,
    `Liquipedia VRS: ${LIQUIPEDIA_VRS_URL}`,
    '',
    '用途边界:',
    '- CS API: 结构化 JSON，主要用于赛果、单场详情、VRS/队伍/选手统计镜像。',
    '- HLTV 页面链接: 给人点开交叉核对，不等于本项目拿到了 HLTV 官方实时 API。',
    '- Liquipedia: 赛程/VRS 兜底，按 MediaWiki/页面限制做低频请求。',
    '',
    '核心缓存:',
    ...coreLines,
    dynamicItems.length > 0 ? '动态缓存:' : '',
    ...dynamicItems,
    '',
    '行动:',
    '- /cs evidence all 看 fresh/stale/miss 证据卡。',
    '- /cs verify all 预检能不能把回复说成“现在/最新”。',
    '- 管理员 /cs warm plan 看哪些实时缓存需要预热。',
    '边界: fresh 才能当当前快照；stale 只能说旧线索；miss 不能反推没有比赛/没有赛果/没有变动。',
  ].filter(Boolean).join('\n');
}

function formatSourceLinks(source: string): string {
  const links = sourceLinksFor(source);
  if (links.length === 0) return '';
  return ` / 链接 ${links.map((item) => `${item.label}: ${item.url}`).join(' | ')}`;
}

function formatSourceStamp(source: string, date?: string): string {
  const at = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const linkText = formatSourceLinks(source);
  return date ? `来源：${source} ${date} 快照 / 拉取 ${at}${linkText}` : `来源：${source} / 拉取 ${at}${linkText}`;
}

function rankDeltaText(value: number | undefined): string {
  if (!value) return '';
  return value > 0 ? ` ↑${value}` : ` ↓${Math.abs(value)}`;
}

function pointsDeltaText(value: number | undefined): string {
  if (!value) return '';
  return value > 0 ? ` +${value}` : ` ${value}`;
}

const DETAIL_MAP_ALIASES: Record<string, string> = {
  mirage: 'Mirage',
  inferno: 'Inferno',
  nuke: 'Nuke',
  ancient: 'Ancient',
  anubis: 'Anubis',
  dust2: 'Dust2',
  dustii: 'Dust2',
  d2: 'Dust2',
  overpass: 'Overpass',
  train: 'Train',
  vertigo: 'Vertigo',
  cache: 'Cache',
  cobblestone: 'Cobblestone',
};

function detailMapKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function cleanDetailMapName(name?: string): string {
  const cleaned = (name || '')
    .replace(/^(?:map|地图)\s*\d+\s*[:：-]?\s*/i, '')
    .replace(/^de[_\-\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return DETAIL_MAP_ALIASES[detailMapKey(cleaned)] || cleaned;
}

function mapSummary(maps?: CsApiMap[]): string {
  if (!maps || maps.length === 0) return '';
  const pieces = maps
    .filter((m) => m?.name)
    .slice(0, 3)
    .map((m) => {
      const score = typeof m.team1_score === 'number' && typeof m.team2_score === 'number'
        ? ` ${m.team1_score}-${m.team2_score}`
        : '';
      return `${cleanDetailMapName(m.name) || m.name}${score}`;
    });
  return pieces.length > 0 ? ` [${pieces.join(', ')}]` : '';
}

function matchMapNames(maps?: CsApiMap[], limit: number = 5): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of maps || []) {
    const name = cleanDetailMapName(item?.name);
    const key = detailMapKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= limit) break;
  }
  return result;
}

function formatMatchMapPoolHint(maps?: CsApiMap[]): string {
  const names = matchMapNames(maps);
  return names.length > 0 ? names.join(' / ') : '';
}

function formatMatchMapStatsBoundary(maps?: CsApiMap[]): string {
  const names = matchMapNames(maps);
  if (names.length === 1) {
    return `竞猜地图: 单图 ${names[0]}，可用于 /predict <id> A 2-1 map ${names[0]}。`;
  }
  if (names.length > 1) {
    return `竞猜地图: 多图 ${names.join(' / ')} 只作为 mappool 线索；单张图统计按实际单图下注或结算证据走。`;
  }
  return '';
}

function matchRanksSummary(match: CsApiMatch): string {
  const rank1 = typeof match.team1?.rank === 'number' ? `#${match.team1.rank}` : '';
  const rank2 = typeof match.team2?.rank === 'number' ? `#${match.team2.rank}` : '';
  return rank1 || rank2 ? ` ranks=${rank1 || '?'}\/${rank2 || '?'}` : '';
}

function matchIdSummary(match: CsApiMatch): string {
  return typeof match.id === 'number' ? ` matchid=${match.id}` : '';
}

function formatCsApiMatchResult(match: CsApiMatch): string {
  const team1 = match.team1?.name || 'TBD';
  const team2 = match.team2?.name || 'TBD';
  const score = typeof match.team1?.score === 'number' && typeof match.team2?.score === 'number'
    ? `${match.team1.score}:${match.team2.score}`
    : '?:?';
  const bo = match.best_of ? ` BO${match.best_of}` : '';
  const ev = match.event ? ` (${match.event})` : '';
  const winner = match.winner?.name ? ` 胜者:${match.winner.name}` : '';
  return `${match.date || '日期未知'}  ${team1} ${score} ${team2}${bo}${ev}${winner}${matchIdSummary(match)}${matchRanksSummary(match)}${mapSummary(match.maps)}`;
}

function normalizeMatchStatsBlocks(raw: CsApiMatchStatsBlock | CsApiMatchStatsBlock[] | null): CsApiMatchStatsBlock[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((item) => item && (item.team1 || item.team2));
}

function formatMatchPlayer(item: CsApiMatchPlayerStats, teamName: string): string {
  const rating = typeof item.rating === 'number' ? item.rating.toFixed(2) : '?';
  const kd = typeof item.k === 'number' && typeof item.d === 'number' ? `${item.k}/${item.d}` : '?/?';
  const adr = typeof item.adr === 'number' ? ` ADR${item.adr.toFixed(1)}` : '';
  const kast = typeof item.kast === 'number' ? ` KAST${item.kast.toFixed(1)}%` : '';
  return `${item.name || 'unknown'}(${teamName}) Rating ${rating} K/D ${kd}${adr}${kast}`;
}

function playersInStatsBlock(block: CsApiMatchStatsBlock): Array<{ player: CsApiMatchPlayerStats; team: string }> {
  const players = [
    ...(block.team1?.players || []).map((player) => ({ player, team: block.team1?.name || 'T1' })),
    ...(block.team2?.players || []).map((player) => ({ player, team: block.team2?.name || 'T2' })),
  ];
  return players
    .filter((item) => item.player?.name)
    .sort((a, b) => Number(b.player.rating || 0) - Number(a.player.rating || 0));
}

function topPlayersForBlock(block: CsApiMatchStatsBlock, limit: number = 4): string[] {
  return playersInStatsBlock(block)
    .slice(0, limit)
    .map((item) => formatMatchPlayer(item.player, item.team));
}

function topMatchPlayers(stats: CsApiMatchStatsBlock[], limit: number = 4): string[] {
  const block = stats.find((item) => /all|overall|全部|总计/i.test(item.name || '')) || stats[0];
  return block ? topPlayersForBlock(block, limit) : [];
}

function cleanMapStatsBlockName(name?: string): string {
  const cleaned = (name || '')
    .replace(/^(?:map|地图)\s*\d+\s*[:：-]?\s*/i, '')
    .trim();
  if (!cleaned || /^(?:all|overall|all maps|全部|总计|总览)$/i.test(cleaned)) return '';
  if (/^\d+$/.test(cleaned)) return '';
  return cleaned;
}

function mapStatsBlockName(block: CsApiMatchStatsBlock, maps: CsApiMap[] | undefined, mapIndex: number): string {
  const cleaned = cleanMapStatsBlockName(block.name);
  if (cleaned) return cleaned;
  const byId = typeof block.id === 'number' ? maps?.find((map) => map.id === block.id)?.name : '';
  return byId || maps?.[mapIndex]?.name || `地图${mapIndex + 1}`;
}

function mapMatchPlayers(stats: CsApiMatchStatsBlock[], maps?: CsApiMap[], limit: number = 5): string[] {
  const namedOrMappedBlocks = stats.filter((block) => (
    !!cleanMapStatsBlockName(block.name)
    || (typeof block.id === 'number' && !!maps?.some((map) => map.id === block.id))
  ));
  const fallbackBlocks = namedOrMappedBlocks.length === 0 && stats.length > 1
    ? stats.filter((block) => !/all|overall|全部|总计/i.test(block.name || ''))
    : [];
  const mapBlocks = namedOrMappedBlocks.length > 0 ? namedOrMappedBlocks : fallbackBlocks;
  return mapBlocks
    .map((block, index) => {
      const top = topPlayersForBlock(block, 1)[0];
      if (!top) return '';
      return `${mapStatsBlockName(block, maps, index)}: ${top}`;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function formatCsApiMatchDetail(match: CsApiMatch, stats: CsApiMatchStatsBlock[]): string {
  const team1 = match.team1?.name || 'TBD';
  const team2 = match.team2?.name || 'TBD';
  const score = typeof match.team1?.score === 'number' && typeof match.team2?.score === 'number'
    ? `${match.team1.score}:${match.team2.score}`
    : '?:?';
  const id = typeof match.id === 'number' ? match.id : 0;
  const rankLine = matchRanksSummary(match).replace(/^ ranks=/, '队伍排名: ');
  const maps = mapSummary(match.maps).replace(/^\s*\[|\]$/g, '');
  const mapPoolHint = formatMatchMapPoolHint(match.maps);
  const mapStatsBoundary = formatMatchMapStatsBoundary(match.maps);
  const highlights = topMatchPlayers(stats, 4);
  const mapHighlights = mapMatchPlayers(stats, match.maps, 5);
  return [
    formatSourceStamp('CS API / 单场详情'),
    id ? `Match ID: ${id}` : '',
    id ? `详情链接: ${CS_API_BASE}/matches/${id}` : '',
    id ? `统计链接: ${CS_API_BASE}/matches/${id}/stats` : '',
    id ? `HLTV比赛页候选: ${hltvMatchPageCandidateUrl(id)}` : '',
    id ? `HLTV搜索入口: ${hltvSearchUrl(id)}` : '',
    `${match.date || '日期未知'}  ${team1} ${score} ${team2}${match.best_of ? ` BO${match.best_of}` : ''}${match.event ? ` (${match.event})` : ''}${match.winner?.name ? ` 胜者:${match.winner.name}` : ''}`,
    rankLine,
    maps ? `地图比分: ${maps}` : '',
    mapPoolHint ? `地图池线索: ${mapPoolHint}` : '',
    mapStatsBoundary,
    mapHighlights.length > 0 ? `地图亮点: ${mapHighlights.join(' / ')}` : '',
    highlights.length > 0 ? `选手亮点: ${highlights.join(' / ')}` : '',
    '边界: 这是 CS API 结构化赛果快照；HLTV比赛页候选只供人工交叉核验，真实 HLTV 页面可能需要 slug，不等于本项目拿到了 HLTV 官方实时 API；地图池线索来自 match.maps，不等于赛前 HLTV 官方 veto/pick-ban。未开赛赛程仍以 /cs match 的 Liquipedia/HLTV 赛程入口为准。',
  ].filter(Boolean).join('\n');
}

function enrichMatchDetailLinksForReturn(text: string, matchId: string | number): string {
  const clean = (text || '').trim();
  if (!clean) return clean;
  const hltvLine = `HLTV比赛页候选: ${hltvMatchPageCandidateUrl(matchId)}`;
  const hltvSearchLine = `HLTV搜索入口: ${hltvSearchUrl(matchId)}`;
  const lines = clean.split(/\r?\n/);
  const nextLines = [...lines];

  let lastInsertedIndex = -1;
  if (!nextLines.some((line) => line.includes('HLTV比赛页候选:'))) {
    const statsIndex = nextLines.findIndex((line) => /^统计链接[:：]/.test(line.trim()));
    const detailIndex = nextLines.findIndex((line) => /^详情链接[:：]/.test(line.trim()));
    const insertAfter = statsIndex >= 0 ? statsIndex : detailIndex;
    if (insertAfter >= 0) {
      nextLines.splice(insertAfter + 1, 0, hltvLine);
      lastInsertedIndex = insertAfter + 1;
    } else {
      const boundaryIndex = nextLines.findIndex((line) => /^边界[:：]/.test(line.trim()) || /^缓存[:：]/.test(line.trim()));
      lastInsertedIndex = boundaryIndex >= 0 ? boundaryIndex : nextLines.length;
      nextLines.splice(lastInsertedIndex, 0, hltvLine);
    }
  } else {
    lastInsertedIndex = nextLines.findIndex((line) => line.includes('HLTV比赛页候选:'));
  }

  if (!nextLines.some((line) => line.includes('HLTV搜索入口:'))) {
    const insertAfter = lastInsertedIndex >= 0
      ? lastInsertedIndex
      : nextLines.findIndex((line) => /^HLTV比赛页候选[:：]/.test(line.trim()));
    if (insertAfter >= 0) {
      nextLines.splice(insertAfter + 1, 0, hltvSearchLine);
    } else {
      const boundaryIndex = nextLines.findIndex((line) => /^边界[:：]/.test(line.trim()) || /^缓存[:：]/.test(line.trim()));
      nextLines.splice(boundaryIndex >= 0 ? boundaryIndex : nextLines.length, 0, hltvSearchLine);
    }
  }

  const boundaryIndex = nextLines.findIndex((line) => /^边界[:：]/.test(line.trim()));
  if (boundaryIndex >= 0 && !nextLines[boundaryIndex].includes('HLTV比赛页候选只供人工交叉核验')) {
    nextLines[boundaryIndex] = nextLines[boundaryIndex]
      .replace(/^边界[:：]\s*/, '边界: HLTV比赛页候选只供人工交叉核验，真实 HLTV 页面可能需要 slug，不等于本项目拿到了 HLTV 官方实时 API；');
  } else if (boundaryIndex >= 0 && !nextLines[boundaryIndex].includes('真实 HLTV 页面可能需要 slug')) {
    nextLines[boundaryIndex] = nextLines[boundaryIndex].replace(
      'HLTV比赛页候选只供人工交叉核验，',
      'HLTV比赛页候选只供人工交叉核验，真实 HLTV 页面可能需要 slug，',
    );
  } else if (boundaryIndex < 0) {
    const cacheIndex = nextLines.findIndex((line) => /^缓存[:：]/.test(line.trim()));
    nextLines.splice(
      cacheIndex >= 0 ? cacheIndex : nextLines.length,
      0,
      '边界: HLTV比赛页候选只供人工交叉核验，真实 HLTV 页面可能需要 slug，不等于本项目拿到了 HLTV 官方实时 API。',
    );
  }

  return nextLines.join('\n');
}

async function fetchCsApiRecentResults(limit: number = 8): Promise<string> {
  const matches = await fetchCsApiJson<CsApiMatch[]>(`/matches/latest?limit=${Math.max(1, Math.min(limit, 20))}`, 8000);
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const lines = matches
    .filter((m) => m?.team1?.name && m?.team2?.name)
    .slice(0, limit)
    .map((m) => `- ${formatCsApiMatchResult(m)}`);
  if (lines.length === 0) return '';
  return `${formatSourceStamp('CS API / HLTV赛果镜像')}\n${lines.join('\n')}`;
}

export async function fetchMatchDetail(matchId: string | number): Promise<string> {
  const id = Number(matchId);
  if (!Number.isInteger(id) || id <= 0) return '';
  const cacheKey = `match:${id}`;
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(enrichMatchDetailLinksForReturn(cached, id), cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const [match, rawStats] = await Promise.all([
      fetchCsApiJson<CsApiMatch>(`/matches/${id}`, 8000),
      fetchCsApiJson<CsApiMatchStatsBlock | CsApiMatchStatsBlock[]>(`/matches/${id}/stats`, 10000),
    ]);
    if (!match?.team1?.name || !match?.team2?.name) return '';
    const lines = formatCsApiMatchDetail(match, normalizeMatchStatsBlocks(rawStats));
    if (lines) setCached(cacheKey, lines, 12 * 60 * 60 * 1000, 'cs-api-match-detail');
    return lines;
  });
  if (value) return withHltvCacheEvidence(enrichMatchDetailLinksForReturn(value, id), cacheKey);
  const stale = getStaleCached(cacheKey, STALE_RESULTS_MAX_MS);
  return stale ? withHltvCacheEvidence(enrichMatchDetailLinksForReturn(stale, id), cacheKey) : '';
}

async function fetchCsApiRanking(limit: number = 10): Promise<string> {
  const data = await fetchCsApiJson<CsApiRankingResponse>('/rankings/', 8000);
  const rankings = Array.isArray(data?.rankings) ? data!.rankings : [];
  if (rankings.length === 0) return '';
  const lines = rankings
    .filter((item) => item?.name && typeof item.rank === 'number')
    .slice(0, limit)
    .map((item) => {
      const points = typeof item.points === 'number' ? ` ${item.points}分${pointsDeltaText(item.points_diff)}` : '';
      return `#${item.rank} ${item.name}${points}${rankDeltaText(item.rank_diff)}`;
    });
  if (lines.length === 0) return '';
  return `${formatSourceStamp('CS API / VRS排名镜像', data?.date)}\n${lines.join('\n')}`;
}

async function fetchCsApiRankingData(): Promise<CsApiRankingResponse | null> {
  return fetchCsApiJson<CsApiRankingResponse>('/rankings/', 8000);
}

function normalizeLookupName(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function cleanLookupQuery(query: string): string {
  return (query || '')
    .replace(/最新|现在|当前|目前|今天|今日|近期|最近|排名|排行|阵容|转会|加入|离队|状态|表现|怎么样|怎样|如何|数据|stats?|hltv|vrs|cs2?|队伍|战队|选手/gi, ' ')
    .replace(/[，。！？!?、,.;:：/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRankingItem(data: CsApiRankingResponse | null, query: string): CsApiRankingItem | null {
  const rankings = Array.isArray(data?.rankings) ? data!.rankings : [];
  const key = normalizeLookupName(cleanLookupQuery(query) || query);
  if (!key) return null;
  return rankings.find((item) => normalizeLookupName(item.name || '') === key)
    || rankings.find((item) => normalizeLookupName(item.name || '').includes(key) || key.includes(normalizeLookupName(item.name || '')))
    || null;
}

export function getCsProfileCacheKey(kind: 'team' | 'player', query: string): string {
  const cleanQuery = cleanLookupQuery(query) || query;
  return `${kind}:${normalizeLookupName(cleanQuery)}`;
}

function formatWinRate(item: CsApiTeamStats): string {
  const n = Number(item.n || 0);
  const wins = Number(item.n_wins || 0);
  if (n <= 0) return `${item.name || 'Unknown'} 0场`;
  const rate = Math.round((wins / n) * 100);
  return `${item.name || 'Unknown'} ${wins}/${n} ${rate}%`;
}

function formatTeamStreak(streak: number | undefined): string {
  if (!streak) return '连胜/连败: 0';
  return streak > 0 ? `连胜: ${streak}` : `连败: ${Math.abs(streak)}`;
}

export async function fetchTeamProfile(query: string): Promise<string> {
  const cleanQuery = cleanLookupQuery(query) || query;
  const cacheKey = getCsProfileCacheKey('team', query);
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(cached, cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const rankingData = await fetchCsApiRankingData();
    const ranking = findRankingItem(rankingData, cleanQuery);
    if (!ranking?.id) return '';

    const [team, stats] = await Promise.all([
      fetchCsApiJson<CsApiTeamDetail>(`/teams/${ranking.id}`, 8000),
      fetchCsApiJson<CsApiTeamStats[]>(`/teams/${ranking.id}/stats`, 8000),
    ]);
    const roster = Array.isArray(team?.roster) ? team!.roster.map((p) => p.name).filter(Boolean) : [];
    const mapStats = Array.isArray(stats) ? stats.filter((item) => item.name && item.name !== 'All').sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 5) : [];
    const all = Array.isArray(stats) ? stats.find((item) => item.name === 'All') : undefined;
    const lines = [
      formatSourceStamp('CS API / VRS+队伍数据', rankingData?.date),
      `${ranking.name || team?.name || cleanQuery} #${ranking.rank || '?'} ${typeof ranking.points === 'number' ? `${ranking.points}分${pointsDeltaText(ranking.points_diff)}` : ''}${rankDeltaText(ranking.rank_diff)}`,
      formatTeamStreak(team?.streak),
      roster.length > 0 ? `当前阵容: ${roster.join(', ')}` : '',
      all ? `近期总战绩: ${formatWinRate(all)}` : '',
      mapStats.length > 0 ? `地图样本: ${mapStats.map(formatWinRate).join(' / ')}` : '',
    ].filter(Boolean).join('\n');
    if (lines) setCached(cacheKey, lines, 30 * 60 * 1000, 'cs-api-team-profile');
    return lines;
  });
  if (value) return withHltvCacheEvidence(value, cacheKey);
  const stale = getStaleCached(cacheKey, STALE_PROFILE_MAX_MS);
  return stale ? withHltvCacheEvidence(stale, cacheKey) : '';
}

export async function fetchPlayerProfile(query: string): Promise<string> {
  const cleanQuery = cleanLookupQuery(query) || query;
  const cacheKey = getCsProfileCacheKey('player', query);
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(cached, cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const key = normalizeLookupName(cleanQuery);
    if (!key) return '';
    const players = await fetchCsApiJson<CsApiPlayerStats[]>('/players/stats?limit=80&min_played=10', 10000);
    if (!Array.isArray(players) || players.length === 0) return '';
    const player = players.find((item) => normalizeLookupName(item.name || '') === key)
      || players.find((item) => normalizeLookupName(item.name || '').includes(key) || key.includes(normalizeLookupName(item.name || '')));
    if (!player) return '';
    const kd = typeof player.k === 'number' && typeof player.d === 'number' && player.d > 0
      ? (player.k / player.d).toFixed(2)
      : '';
    const lines = [
      formatSourceStamp('CS API / 选手统计'),
      `${player.name || query} 统计排名 #${player.rank || '?'}`,
      typeof player.rating === 'number' ? `Rating: ${player.rating.toFixed(3)} (${player.N || '?'}图)` : '',
      typeof player.adr === 'number' ? `ADR: ${player.adr.toFixed(1)}` : '',
      typeof player.kast === 'number' ? `KAST: ${player.kast.toFixed(1)}%` : '',
      kd ? `K/D: ${kd} (${player.k || 0}/${player.d || 0})` : '',
    ].filter(Boolean).join('\n');
    if (lines) setCached(cacheKey, lines, 30 * 60 * 1000, 'cs-api-player-stats');
    return lines;
  });
  if (value) return withHltvCacheEvidence(value, cacheKey);
  const stale = getStaleCached(cacheKey, STALE_PROFILE_MAX_MS);
  return stale ? withHltvCacheEvidence(stale, cacheKey) : '';
}

/** 当前正在进行 + 即将开始的比赛 */
export async function fetchOngoingMatches(): Promise<string> {
  const cacheKey = 'matches';
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(cached, cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const html = await getMatchesHtml();
    if (!html) {
      // Liquipedia 失败 → fallback 到 webSearch
      const webResult = await fallbackWebSearch('CS2 ongoing matches today HLTV schedule');
      if (webResult) {
        setCached(cacheKey, webResult, 5 * 60 * 1000, 'web-search-fallback');
        return webResult;
      }
      return '';
    }

    const all = parseMatchBlocks(html);
    const now = Math.floor(Date.now() / 1000);

    // 去重（同 team+ts 可能因为 toggle area 重复出现）
    const dedupMap = new Map<string, ParsedMatch>();
    for (const m of all) {
      const k = `${m.team1}|${m.team2}|${m.unixTimestamp}`;
      if (!dedupMap.has(k)) dedupMap.set(k, m);
    }
    const unique = [...dedupMap.values()];

    // LIVE: 未结束 且 开始时间在过去 3 小时到未来 5 分钟之间
    const live = unique.filter((m) => {
      if (m.finished || !m.unixTimestamp) return false;
      const diff = m.unixTimestamp - now;
      return diff < 5 * 60 && diff > -3 * 3600;
    });
    const liveSet = new Set(live);

    // UPCOMING: 未结束 且 时间在未来 5 分钟到 7 天内
    const upcoming = unique
      .filter((m) => {
        if (m.finished || !m.unixTimestamp || liveSet.has(m)) return false;
        const diff = m.unixTimestamp - now;
        return diff >= 5 * 60 && diff < 7 * 24 * 3600;
      })
      .sort((a, b) => (a.unixTimestamp || 0) - (b.unixTimestamp || 0));

    const lines: string[] = [];
    for (const m of live.slice(0, 5)) {
      const sc = m.score1 !== undefined && m.score2 !== undefined ? ` ${m.score1}:${m.score2}` : '';
      const ev = m.event ? ` (${m.event})` : '';
      lines.push(`🔴 LIVE  ${m.team1} vs ${m.team2}${sc}${m.bo ? ` ${m.bo}` : ''}${ev}`);
    }
    for (const m of upcoming.slice(0, 10)) {
      const ts = m.unixTimestamp ? formatTimeShort(m.unixTimestamp) : '待定';
      const ev = m.event ? ` (${m.event})` : '';
      lines.push(`⏰ ${ts}  ${m.team1} vs ${m.team2}${m.bo ? ` ${m.bo}` : ''}${ev}`);
    }

    if (lines.length > 0) {
      lines.unshift(formatSourceStamp('Liquipedia赛程'));
    }
    const result = lines.join('\n');
    if (result) setCached(cacheKey, result, 5 * 60 * 1000, 'liquipedia-matches');
    return result;
  });
  if (value) return withHltvCacheEvidence(value, cacheKey);
  const stale = getStaleCached(cacheKey, STALE_MATCHES_MAX_MS);
  return stale ? withHltvCacheEvidence(stale, cacheKey) : '';
}

/** 最近完赛结果 */
export async function fetchRecentResults(): Promise<string> {
  const cacheKey = 'results';
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(cached, cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const csApiResult = await fetchCsApiRecentResults(8);
    if (csApiResult) {
      setCached(cacheKey, csApiResult, 10 * 60 * 1000, 'cs-api-latest-results');
      return csApiResult;
    }

    const html = await getMatchesHtml();
    if (!html) {
      const webResult = await fallbackWebSearch('CS2 recent match results yesterday HLTV scores');
      if (webResult) {
        setCached(cacheKey, webResult, 10 * 60 * 1000, 'web-search-fallback');
        return webResult;
      }
      return '';
    }

    const all = parseMatchBlocks(html);
    const now = Math.floor(Date.now() / 1000);

    // 去重
    const dedupMap = new Map<string, ParsedMatch>();
    for (const m of all) {
      const k = `${m.team1}|${m.team2}|${m.unixTimestamp}`;
      if (!dedupMap.has(k)) dedupMap.set(k, m);
    }
    const unique = [...dedupMap.values()];

    // 已结束 + 在过去 72 小时内
    const recent = unique
      .filter((m) => m.finished && m.unixTimestamp && now - m.unixTimestamp < 72 * 3600 && m.unixTimestamp <= now)
      .sort((a, b) => (b.unixTimestamp || 0) - (a.unixTimestamp || 0));

    const lines = recent.slice(0, 8).map((m) => {
      const sc = m.score1 !== undefined && m.score2 !== undefined ? `${m.score1}:${m.score2}` : '?:?';
      const ts = m.unixTimestamp ? formatTimeShort(m.unixTimestamp) : '';
      const ev = m.event ? ` (${m.event})` : '';
      return `✅ ${ts}  ${m.team1} ${sc} ${m.team2}${ev}`;
    });

    if (lines.length > 0) {
      lines.unshift(formatSourceStamp('Liquipedia赛果'));
    }
    const result = lines.join('\n');
    if (result) setCached(cacheKey, result, 10 * 60 * 1000, 'liquipedia-results');
    return result;
  });
  if (value) return withHltvCacheEvidence(value, cacheKey);
  const stale = getStaleCached(cacheKey, STALE_RESULTS_MAX_MS);
  return stale ? withHltvCacheEvidence(stale, cacheKey) : '';
}

/** 获取战队排名（优先 CS API VRS，兜底 Liquipedia VRS） */
export async function fetchTeamRanking(): Promise<string> {
  const cacheKey = 'ranking';
  const cached = getCached(cacheKey);
  if (cached) return withHltvCacheEvidence(cached, cacheKey);

  const value = await singleFlight(cacheKey, async () => {
    const csApiRanking = await fetchCsApiRanking(10);
    if (csApiRanking) {
      setCached(cacheKey, csApiRanking, 60 * 60 * 1000, 'cs-api-vrs-ranking');
      return csApiRanking;
    }

    // Valve VRS 是 Liquipedia 上目前最权威的全球积分榜
    const html = await fetchLiquipedia('Valve_Regional_Standings', 12000);
    if (!html) {
      const webResult = await fallbackWebSearch('HLTV CS2 world ranking top 10 teams 2026');
      if (webResult) {
        setCached(cacheKey, webResult, 60 * 60 * 1000, 'web-search-fallback');
        return webResult;
      }
      return '';
    }

    const lines: string[] = [];
    // 取第一组 team-template-text 链接（即 Top 团队列表）
    const teamLinks = [...html.matchAll(/<span class="team-template-text"[^>]*><a[^>]*>([^<]+)<\/a><\/span>/g)].map((m) => decodeHtml(m[1].trim()));

    // 去重，保持顺序
    const seen = new Set<string>();
    for (const t of teamLinks) {
      if (seen.has(t) || !t) continue;
      seen.add(t);
      lines.push(`#${seen.size}  ${t}`);
      if (seen.size >= 10) break;
    }

    const result = lines.length > 0 ? `${formatSourceStamp('Liquipedia / VRS排名')}\n${lines.join('\n')}` : '';
    if (result) setCached(cacheKey, result, 6 * 60 * 60 * 1000, 'liquipedia-vrs-ranking'); // 6 小时
    return result;
  });
  if (value) return withHltvCacheEvidence(value, cacheKey);
  const stale = getStaleCached(cacheKey, STALE_RANKING_MAX_MS);
  return stale ? withHltvCacheEvidence(stale, cacheKey) : '';
}

export function getHltvStats(): {
  entries: number;
  staleEntries: number;
  keys: string[];
  hits: number;
  misses: number;
  diskHits: number;
  diskEntriesLoaded: number;
  expired: number;
  writes: number;
  inFlight: number;
  inFlightHits: number;
  staleServed: number;
  failures: number;
  prunes: number;
  lastRefreshAt: number;
  lastError: string;
  lastDiskLoadAt: number;
  lastDiskFlushAt: number;
  lastDiskError: string;
  items: HltvCacheEntrySnapshot[];
  linkChecks: HltvLinkCheckSnapshot[];
} {
  loadDiskCache();
  pruneCache(false);
  const now = Date.now();
  const valid = [...cache.entries()].filter(([, v]) => v.expiresAt > now);
  const stale = [...cache.entries()].filter(([, v]) => v.expiresAt <= now);
  return {
    entries: valid.length,
    staleEntries: stale.length,
    keys: valid.map(([k]) => k),
    hits: cacheHits,
    misses: cacheMisses,
    diskHits,
    diskEntriesLoaded,
    expired: cacheExpired,
    writes: cacheWrites,
    inFlight: inFlightFetches.size,
    inFlightHits,
    staleServed,
    failures: fetchFailures,
    prunes: cachePrunes,
    lastRefreshAt,
    lastError,
    lastDiskLoadAt,
    lastDiskFlushAt,
    lastDiskError,
    items: [...cache.keys()]
      .map((key) => inspectHltvCacheEntry(key))
      .filter((item): item is HltvCacheEntrySnapshot => item !== null)
      .sort((a, b) => (a.status === b.status ? a.ttlSeconds - b.ttlSeconds : a.status === 'stale' ? -1 : 1)),
    linkChecks: inspectHltvLinkCheckCache(now),
  };
}

function inspectHltvLinkCheckCache(now: number = Date.now()): HltvLinkCheckSnapshot[] {
  const rows: HltvLinkCheckSnapshot[] = [];
  for (const [matchId, entry] of [...hltvLinkCheckCache.entries()]) {
    if (entry.expiresAt <= now) {
      hltvLinkCheckCache.delete(matchId);
      continue;
    }
    rows.push({
      matchId,
      status: entry.result.status,
      httpStatus: entry.result.httpStatus,
      ttlSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
      ageSeconds: Math.max(0, Math.round((now - entry.result.checkedAt) / 1000)),
      checkedAt: entry.result.checkedAt,
      finalUrl: entry.result.finalUrl,
      reason: entry.result.reason,
    });
  }
  return rows.sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 8);
}

export function inspectHltvCacheEntry(key: string): HltvCacheEntrySnapshot | null {
  loadDiskCache();
  const entry = cache.get(key);
  if (!entry) return null;
  const now = Date.now();
  return {
    key,
    source: entry.source || '-',
    status: entry.expiresAt > now ? 'fresh' : 'stale',
    ttlSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
    expiredSeconds: Math.max(0, Math.round((now - entry.expiresAt) / 1000)),
    ageSeconds: Math.max(0, Math.round((now - entry.createdAt) / 1000)),
    hits: entry.hits,
    fetchMs: entry.fetchMs,
    disk: entry.disk === true,
  };
}

export function describeHltvCacheEntry(key: string): string {
  loadDiskCache();
  const entry = cache.get(key);
  if (!entry) return `缓存: ${key} miss`;
  const now = Date.now();
  const ageSeconds = Math.max(0, Math.round((now - entry.createdAt) / 1000));
  const ttlSeconds = Math.max(0, Math.round((entry.expiresAt - now) / 1000));
  const expiredSeconds = Math.max(0, Math.round((now - entry.expiresAt) / 1000));
  const status = entry.expiresAt > now ? 'fresh' : 'stale';
  const hitText = entry.hits > 0 ? ` hit=${entry.hits}` : '';
  const fetchText = entry.fetchMs > 0 ? ` fetch=${entry.fetchMs}ms` : '';
  const staleText = status === 'stale' ? ` expired=${expiredSeconds}s 注意: 这是过期缓存，源站本次没给到新数据，不能当实时结论` : ` ttl=${ttlSeconds}s`;
  const diskText = entry.disk ? ' disk=1' : '';
  return `缓存: ${key} ${status} age=${ageSeconds}s${staleText}${hitText}${fetchText}${diskText}${entry.source ? ` source=${entry.source}` : ''}`;
}

export function withHltvCacheEvidence(value: string, key: string): string {
  const text = (value || '').trim();
  if (!text) return text;
  const evidence = describeHltvCacheEntry(key);
  if (!evidence || evidence.endsWith(' miss')) return text;
  if (text.split('\n').some((line) => line.startsWith(`缓存: ${key} `))) return text;
  return `${text}\n${evidence}`;
}

export function getCsDataSourceInfo(): {
  primary: string;
  primaryBaseUrl: string;
  fallback: string[];
  note: string;
} {
  return {
    primary: 'CS API (api.csapi.de) structured JSON, fed from public CS2/Valve/HLTV-like data',
    primaryBaseUrl: CS_API_BASE,
    fallback: [
      'Liquipedia Counter-Strike MediaWiki API for schedule/ranking fallback',
      'webSearch fallback for news and source snippets',
      'short-lived in-process cache to reduce rate-limit pressure',
    ],
    note: 'HLTV.org 没有官方免 key 公共 API；本项目优先用 CS API 的 JSON 镜像和 Liquipedia 官方 MediaWiki API，回答里会标注来源快照。',
  };
}

export async function checkCsDataHealth(): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; lines: number; snippet: string }>;
  cache: { entries: number; keys: string[] };
  source: ReturnType<typeof getCsDataSourceInfo>;
}> {
  const tasks: Array<[string, () => Promise<string>]> = [
    ['ranking', fetchTeamRanking],
    ['recent-results', fetchRecentResults],
    ['ongoing-matches', fetchOngoingMatches],
    ['team-profile-vitality', () => fetchTeamProfile('Vitality 当前阵容 排名')],
    ['player-profile-donk', () => fetchPlayerProfile('donk 最近状态 stats')],
  ];
  const checks = [];
  for (const [name, fn] of tasks) {
    try {
      const value = await fn();
      checks.push({
        name,
        ok: Boolean(value),
        lines: value ? value.split('\n').filter(Boolean).length : 0,
        snippet: value ? value.replace(/\s+/g, ' ').slice(0, 180) : '',
      });
    } catch (err) {
      checks.push({
        name,
        ok: false,
        lines: 0,
        snippet: err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180),
      });
    }
  }
  return {
    ok: checks.some((item) => item.ok),
    checks,
    cache: getHltvStats(),
    source: getCsDataSourceInfo(),
  };
}

export function clearHltvCache(): void {
  cache.clear();
  inFlightFetches.clear();
  matchesHtmlCache = null;
  hltvLinkCheckCache.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cacheHits = 0;
  cacheMisses = 0;
  diskHits = 0;
  diskEntriesLoaded = 0;
  cacheExpired = 0;
  cacheWrites = 0;
  inFlightHits = 0;
  fetchFailures = 0;
  staleServed = 0;
  cachePrunes = 0;
  lastRefreshAt = 0;
  lastError = '';
  diskLoaded = true;
  lastDiskLoadAt = 0;
  lastDiskFlushAt = 0;
  lastDiskError = '';
  dirty = false;
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch (err) {
    lastDiskError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
  }
}

export function pruneStaleHltvCacheForMaintenance(): HltvStalePruneResult {
  loadDiskCache();
  const now = Date.now();
  const beforeFresh = [...cache.values()].filter((entry) => entry.expiresAt > now).length;
  const staleKeys = [...cache.entries()]
    .filter(([, entry]) => entry.expiresAt <= now)
    .map(([key]) => key);

  for (const key of staleKeys) {
    cache.delete(key);
  }

  if (staleKeys.length > 0) {
    cachePrunes++;
    dirty = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushDiskCache();
  }

  const afterFresh = [...cache.values()].filter((entry) => entry.expiresAt > now).length;
  const afterStale = [...cache.values()].filter((entry) => entry.expiresAt <= now).length;
  return {
    beforeFresh,
    beforeStale: staleKeys.length,
    afterFresh,
    afterStale,
    removed: staleKeys.length,
    removedKeys: staleKeys.slice(0, 12),
    inFlight: inFlightFetches.size,
    linkChecks: inspectHltvLinkCheckCache(now).length,
    diskError: lastDiskError,
  };
}

export function flushHltvCache(): void {
  loadDiskCache();
  dirty = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDiskCache();
}

/** 测试用 */
export async function _debugFetchRaw(): Promise<{ matches: number; first?: ParsedMatch; all: ParsedMatch[] }> {
  const html = await getMatchesHtml();
  const all = parseMatchBlocks(html);
  return { matches: all.length, first: all[0], all };
}

void stripTags;

export const __test = {
  formatCsApiMatchResultForTests(match: CsApiMatch): string {
    return formatCsApiMatchResult(match);
  },
  formatCsApiMatchDetailForTests(match: CsApiMatch, stats: CsApiMatchStatsBlock[] = []): string {
    return formatCsApiMatchDetail(match, stats);
  },
  setCacheEntryForTests(
    key: string,
    data: string,
    options?: { ageMs?: number; ttlMs?: number; source?: string; fetchMs?: number },
  ): void {
    const now = Date.now();
    const ageMs = Math.max(0, options?.ageMs ?? 0);
    cache.set(key, {
      data,
      createdAt: now - ageMs,
      expiresAt: now + (options?.ttlMs ?? 60_000),
      lastHitAt: 0,
      hits: 0,
      fetchMs: options?.fetchMs || 0,
      source: options?.source || 'test',
    });
  },
  setCsApiJsonFetcherForTests(fetcher?: CsApiJsonFetcher): void {
    csApiJsonFetcherForTests = fetcher || null;
  },
  setHttpMetaFetcherForTests(fetcher?: HttpMetaFetcher): void {
    httpMetaFetcherForTests = fetcher || null;
    hltvLinkCheckCache.clear();
  },
};
