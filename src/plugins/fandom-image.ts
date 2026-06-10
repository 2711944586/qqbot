import * as https from 'https';
import * as zlib from 'zlib';

/**
 * Counter-Strike Wiki (Fandom) 图片解析。
 *
 * 用于地图、武器、道具这类官方/百科素材。普通页面可能 403，
 * 但 MediaWiki API 能稳定返回 File:imageinfo 的真实图片 URL。
 */

type FandomWiki = 'counterstrike' | 'bandori';

const API_BASES: Record<FandomWiki, string> = {
  counterstrike: 'https://counterstrike.fandom.com/api.php',
  bandori: 'https://bandori.fandom.com/api.php',
};
const USER_AGENT = 'wanjier-bot/1.0 (https://github.com/2711944586/qqbot; CS2 group chat bot)';
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 60 * 60 * 1000;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

function fetchJson(url: string, timeoutMs: number = 8000): Promise<any> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    let settled = false;
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        finish(null);
        return;
      }
      const chunks: Buffer[] = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          finish(null);
        }
      });
      stream.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      finish(null);
      req.destroy();
    });
  });
}

function extractImageInfoUrl(json: any): string {
  const pages = json?.query?.pages;
  if (!pages) return '';
  for (const id in pages) {
    const url = pages[id]?.imageinfo?.[0]?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return `${url}${url.includes('?') ? '&' : '?'}format=original`;
    }
  }
  return '';
}

function apiBaseForWiki(wiki: FandomWiki): string {
  return API_BASES[wiki] || API_BASES.counterstrike;
}

function normalizeWikiaImageUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}format=original`;
}

export async function resolveFandomFileImage(filename: string, wiki: FandomWiki = 'counterstrike'): Promise<string | null> {
  const clean = filename.replace(/^File:/i, '').trim();
  if (!clean) return null;
  const key = `${wiki}:file:${clean.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url || null;
  }

  const url = `${apiBaseForWiki(wiki)}?action=query&titles=${encodeURIComponent(`File:${clean}`)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
  const resolved = extractImageInfoUrl(await fetchJson(url));
  cache.set(key, {
    url: resolved,
    expiresAt: Date.now() + (resolved ? POSITIVE_TTL : NEGATIVE_TTL),
  });
  if (cache.size > 200) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of sorted.slice(0, 30)) cache.delete(k);
  }
  return resolved || null;
}

function extractPageImageUrl(json: any): string {
  const pages = json?.query?.pages;
  if (!pages) return '';
  for (const id in pages) {
    const original = pages[id]?.original?.source;
    const thumbnail = pages[id]?.thumbnail?.source;
    const url = typeof original === 'string' && /^https?:\/\//i.test(original)
      ? original
      : typeof thumbnail === 'string' && /^https?:\/\//i.test(thumbnail)
        ? thumbnail
        : '';
    if (url) return normalizeWikiaImageUrl(url);
  }
  return '';
}

export async function resolveFandomPageImage(title: string, wiki: FandomWiki = 'counterstrike'): Promise<string | null> {
  const clean = title.trim();
  if (!clean) return null;
  const key = `${wiki}:page:${clean.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url || null;
  }

  const url = `${apiBaseForWiki(wiki)}?action=query&titles=${encodeURIComponent(clean)}&prop=pageimages&piprop=original|thumbnail&pithumbsize=900&format=json&origin=*`;
  const resolved = extractPageImageUrl(await fetchJson(url));
  cache.set(key, {
    url: resolved,
    expiresAt: Date.now() + (resolved ? POSITIVE_TTL : NEGATIVE_TTL),
  });
  if (cache.size > 200) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of sorted.slice(0, 30)) cache.delete(k);
  }
  return resolved || null;
}
