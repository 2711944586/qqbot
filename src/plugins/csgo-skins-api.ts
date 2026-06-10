import * as https from 'https';
import * as zlib from 'zlib';

const SKINS_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const USER_AGENT = 'wanjier-bot/1.0 (https://github.com/2711944586/qqbot; CS2 group chat bot)';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CsgoApiSkin {
  name?: string;
  image?: string;
  weapon?: { name?: string };
  pattern?: { name?: string };
}

let cachedSkins: CsgoApiSkin[] = [];
let cacheExpiresAt = 0;
let inFlight: Promise<CsgoApiSkin[]> | null = null;
let lastFetchAt = 0;
let lastError = '';

function fetchJson(url: string, timeoutMs: number = 8000): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let parsed: URL;
    try { parsed = new URL(url); } catch { finish(null); return; }

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
          finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          finish(null);
        }
      });
      stream.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
  });
}

async function loadSkins(): Promise<CsgoApiSkin[]> {
  if (cachedSkins.length > 0 && cacheExpiresAt > Date.now()) return cachedSkins;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const json = await fetchJson(SKINS_URL);
    if (Array.isArray(json)) {
      cachedSkins = json.filter((item) => item && typeof item === 'object') as CsgoApiSkin[];
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      lastFetchAt = Date.now();
      lastError = '';
      return cachedSkins;
    }
    lastError = 'CSGO-API skins.json unavailable';
    return cachedSkins;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function normalizeSkinName(value: string): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[★™]/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function compactComparable(value: string): string {
  return normalizeSkinName(value).replace(/[^a-z0-9|]+/g, '');
}

function compactWord(value: string): string {
  return normalizeSkinName(value).replace(/[^a-z0-9]+/g, '');
}

function patternOnly(weaponName: string, skinName: string): string {
  const normalizedSkin = normalizeSkinName(skinName);
  const normalizedWeapon = normalizeSkinName(weaponName);
  const prefix = `${normalizedWeapon} | `;
  if (normalizedSkin.startsWith(prefix)) return normalizedSkin.slice(prefix.length).trim();
  const pipeIndex = normalizedSkin.indexOf(' | ');
  if (pipeIndex >= 0) return normalizedSkin.slice(pipeIndex + 3).trim();
  return normalizedSkin;
}

export async function resolveCsgoSkinImage(weaponName: string, skinName: string): Promise<string | null> {
  const weapon = (weaponName || '').trim();
  const skin = (skinName || '').trim();
  if (!weapon || !skin) return null;

  const skins = await loadSkins();
  if (skins.length === 0) return null;

  const pattern = patternOnly(weapon, skin);
  const fullNames = new Set([
    compactComparable(skin.includes('|') ? skin : `${weapon} | ${pattern}`),
    compactComparable(`${weapon} | ${pattern}`),
  ]);

  const exact = skins.find((item) => item.image && fullNames.has(compactComparable(item.name || '')));
  const matched = exact || skins.find((item) => (
    item.image
    && compactWord(item.weapon?.name || '') === compactWord(weapon)
    && compactWord(item.pattern?.name || '') === compactWord(pattern)
  ));

  return typeof matched?.image === 'string' && /^https?:\/\//i.test(matched.image)
    ? matched.image
    : null;
}

export function getCsgoSkinsApiStats(): {
  entries: number;
  lastFetchAt: number;
  lastError: string;
  inFlight: boolean;
} {
  return {
    entries: cachedSkins.length,
    lastFetchAt,
    lastError,
    inFlight: Boolean(inFlight),
  };
}
