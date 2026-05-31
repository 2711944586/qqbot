import * as https from 'https';
import * as zlib from 'zlib';
import { webSearch } from './web-search';

/**
 * CS2 实时数据接口 - 多层兜底
 *
 * 数据源优先级：
 * 1. Liquipedia MediaWiki API (主数据源, bot友好)
 * 2. webSearch 兜底 (DuckDuckGo/Bing) - 当 Liquipedia 限流时
 * 3. 缓存命中（最长 12 小时）
 *
 * Liquipedia ToS: ≥2.5s 间隔，UA 带项目标识
 */

interface CacheEntry {
  data: string;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'wanjier-bot/1.0 (https://github.com/2711944586/qqbot; CS2 group chat bot)';

let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 2500; // Liquipedia ToS: 至少 2s 间隔，加 0.5s margin
let rateLimitedUntil = 0;

// 共享的 HTML 缓存（fetchOngoingMatches 和 fetchRecentResults 都用同一页面）
let matchesHtmlCache: { html: string; expiresAt: number } | null = null;
const MATCHES_HTML_TTL = 4 * 60 * 1000; // 4 分钟

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
    return result.slice(0, 600);
  } catch {
    return '';
  }
}

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: string, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  if (cache.size > 50) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of sorted.slice(0, 10)) cache.delete(k);
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

/** 当前正在进行 + 即将开始的比赛 */
export async function fetchOngoingMatches(): Promise<string> {
  const cacheKey = 'matches';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const html = await getMatchesHtml();
  if (!html) {
    // Liquipedia 失败 → fallback 到 webSearch
    const webResult = await fallbackWebSearch('CS2 ongoing matches today HLTV schedule');
    if (webResult) {
      setCached(cacheKey, webResult, 5 * 60 * 1000);
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

  const result = lines.join('\n');
  if (result) setCached(cacheKey, result, 5 * 60 * 1000);
  return result;
}

/** 最近完赛结果 */
export async function fetchRecentResults(): Promise<string> {
  const cacheKey = 'results';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const html = await getMatchesHtml();
  if (!html) {
    const webResult = await fallbackWebSearch('CS2 recent match results yesterday HLTV scores');
    if (webResult) {
      setCached(cacheKey, webResult, 10 * 60 * 1000);
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

  const result = lines.join('\n');
  if (result) setCached(cacheKey, result, 10 * 60 * 1000);
  return result;
}

/** 获取战队排名（来源：Liquipedia 的 Valve Regional Standings 页） */
export async function fetchTeamRanking(): Promise<string> {
  const cacheKey = 'ranking';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Valve VRS 是 Liquipedia 上目前最权威的全球积分榜
  const html = await fetchLiquipedia('Valve_Regional_Standings', 12000);
  if (!html) {
    const webResult = await fallbackWebSearch('HLTV CS2 world ranking top 10 teams 2026');
    if (webResult) {
      setCached(cacheKey, webResult, 60 * 60 * 1000);
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

  const result = lines.length > 0 ? `(VRS 全球积分榜 Top10)\n${lines.join('\n')}` : '';
  if (result) setCached(cacheKey, result, 6 * 60 * 60 * 1000); // 6 小时
  return result;
}

export function getHltvStats(): { entries: number; keys: string[] } {
  const now = Date.now();
  const valid = [...cache.entries()].filter(([, v]) => v.expiresAt > now);
  return {
    entries: valid.length,
    keys: valid.map(([k]) => k),
  };
}

export function clearHltvCache(): void {
  cache.clear();
  matchesHtmlCache = null;
}

/** 测试用 */
export async function _debugFetchRaw(): Promise<{ matches: number; first?: ParsedMatch; all: ParsedMatch[] }> {
  const html = await getMatchesHtml();
  const all = parseMatchBlocks(html);
  return { matches: all.length, first: all[0], all };
}

void stripTags;
