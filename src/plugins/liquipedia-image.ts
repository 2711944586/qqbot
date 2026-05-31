import * as https from 'https';
import * as zlib from 'zlib';

/**
 * Liquipedia 图片智能解析
 *
 * 用途：CS 选手/队伍头像 URL 经常因为 Liquipedia 文件改名/换图变成 404。
 * 这里通过 MediaWiki API 按选手页面查询当前实际的图片 URL，并缓存。
 *
 * 实现：
 * 1. action=parse&page=PlayerName&prop=images → 拿到该页面引用的所有图片名
 * 2. 选第一个匹配 PlayerName 的图片
 * 3. action=query&titles=File:xxx&prop=imageinfo&iiprop=url → 拿到 https URL
 *
 * 注意：所有请求严格遵守 Liquipedia API ToS（≥2.5s 间隔、UA 带项目标识）
 */

const USER_AGENT = 'wanjier-bot/1.0 (https://github.com/2711944586/qqbot; CS2 group chat bot)';
const MIN_REQUEST_GAP_MS = 2500;
let lastRequestAt = 0;
let rateLimitedUntil = 0;

interface CacheEntry {
  url: string;       // 解析出来的实际图片 URL，'' = 已知失败
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();
const POSITIVE_TTL = 24 * 60 * 60 * 1000; // 24h
const NEGATIVE_TTL = 60 * 60 * 1000;       // 1h

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, timeoutMs: number = 8000): Promise<any> {
  if (Date.now() < rateLimitedUntil) return null;
  const since = Date.now() - lastRequestAt;
  if (since < MIN_REQUEST_GAP_MS) await delay(MIN_REQUEST_GAP_MS - since);
  lastRequestAt = Date.now();

  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return resolve(null); }
    let settled = false;
    const finish = (v: any) => { if (settled) return; settled = true; resolve(v); };

    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    }, (res) => {
      if (res.statusCode === 429 || res.statusCode === 403) {
        rateLimitedUntil = Date.now() + 10 * 60 * 1000;
        finish(null);
        res.resume();
        return;
      }
      if (res.statusCode && res.statusCode >= 400) { finish(null); res.resume(); return; }
      const chunks: Buffer[] = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (body.startsWith('<!DOCTYPE') || body.startsWith('<html')) {
          if (/Rate Limited/i.test(body)) rateLimitedUntil = Date.now() + 10 * 60 * 1000;
          finish(null);
          return;
        }
        try { finish(JSON.parse(body)); } catch { finish(null); }
      });
      stream.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => { finish(null); req.destroy(); });
  });
}

/** 获取选手页面引用的最相关图片名 */
async function findPlayerImageName(nickname: string): Promise<string | null> {
  const j = await fetchJson(`https://liquipedia.net/counterstrike/api.php?action=parse&page=${encodeURIComponent(nickname)}&prop=images&format=json`);
  const images: string[] = j?.parse?.images || [];
  if (images.length === 0) return null;

  // 名字匹配优先级：包含 nickname > 包含 player > 包含 portrait > 第一张
  const lower = nickname.toLowerCase();
  // 跳过明显不是头像的（队标、地图、icon 等）
  const skipPatterns = /(_lightmode|_darkmode|_allmode|_logo|_icon|_squad|_roster|major|ranking|map_|_map|trophy|medal|gold|silver|bronze|filler\.png)/i;
  const candidates = images.filter((name) => {
    const n = name.toLowerCase();
    if (skipPatterns.test(n)) return false;
    return n.includes(lower) || /player|portrait|profile/i.test(n);
  });

  // 含 nickname 的优先
  candidates.sort((a, b) => {
    const aHas = a.toLowerCase().includes(lower) ? 1 : 0;
    const bHas = b.toLowerCase().includes(lower) ? 1 : 0;
    return bHas - aHas;
  });

  return candidates[0] || null;
}

/** 把图片名查实际 URL */
async function resolveImageUrl(filename: string): Promise<string | null> {
  const titles = `File:${filename.replace(/^File:/i, '')}`;
  const j = await fetchJson(`https://liquipedia.net/counterstrike/api.php?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`);
  const pages = j?.query?.pages;
  if (!pages) return null;
  for (const id in pages) {
    const info = pages[id]?.imageinfo?.[0];
    if (info?.url) return info.url;
  }
  return null;
}

/** 主函数：按选手昵称返回当前可用的图片 URL */
export async function resolvePlayerImage(nickname: string): Promise<string | null> {
  const key = `player:${nickname.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url || null;
  }

  let url = '';
  try {
    const filename = await findPlayerImageName(nickname);
    if (filename) {
      url = (await resolveImageUrl(filename)) || '';
    }
  } catch { /* */ }

  cache.set(key, {
    url,
    expiresAt: Date.now() + (url ? POSITIVE_TTL : NEGATIVE_TTL),
  });

  // 限制缓存大小
  if (cache.size > 200) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of sorted.slice(0, 30)) cache.delete(k);
  }

  return url || null;
}

/** 批量预热缓存 */
export async function warmupPlayerImages(nicknames: string[], maxConcurrent: number = 1): Promise<void> {
  // 串行执行（受 rate limit 限制）
  for (const n of nicknames) {
    if (Date.now() < rateLimitedUntil) break;
    await resolvePlayerImage(n);
  }
  void maxConcurrent;
}

export function getLiquipediaImageStats(): { entries: number; rateLimited: boolean } {
  const now = Date.now();
  const valid = [...cache.values()].filter((v) => v.expiresAt > now);
  return {
    entries: valid.length,
    rateLimited: now < rateLimitedUntil,
  };
}

export function clearLiquipediaImageCache(): void {
  cache.clear();
}
