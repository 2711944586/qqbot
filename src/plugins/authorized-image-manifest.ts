import * as fs from 'fs';
import * as path from 'path';

export interface AuthorizedImageManifestCard {
  kind?: string;
  category?: string;
  itemKey?: string;
  itemName?: string;
  characterKey?: string;
  characterName?: string;
  key?: string;
  name?: string;
  nick?: string;
  weapon?: string;
  skin?: string;
  style?: string;
  quality?: string;
  tags?: string[] | string;
  priority?: number;
  url?: string;
  urls?: string[];
  images?: string[];
  title?: string;
}

export interface ImageManifestCacheStats {
  key: string;
  path: string;
  exists: boolean;
  cards: number;
  kinds: number;
  uniqueUrls: number;
  approxMemoryKB: number;
  mtimeMs: number;
  sizeBytes: number;
  hits: number;
  reloads: number;
  lastUsedAt: number;
  lastLoadedAt: number;
  lastError: string;
}

interface ImageManifestCacheEntry {
  key: string;
  path: string;
  exists: boolean;
  cards: AuthorizedImageManifestCard[];
  cardsByKind: Map<string, AuthorizedImageManifestCard[]>;
  uniqueUrls: number;
  approxMemoryBytes: number;
  mtimeMs: number;
  sizeBytes: number;
  hits: number;
  reloads: number;
  lastUsedAt: number;
  lastLoadedAt: number;
  lastError: string;
}

const manifestCache: Map<string, ImageManifestCacheEntry> = new Map();
const DEFAULT_MAX_MANIFEST_CACHE_ENTRIES = 12;

function maxManifestCacheEntries(): number {
  const value = Number(process.env.WANJIER_IMAGE_MANIFEST_CACHE_MAX || process.env.DAILY_IMAGE_MANIFEST_CACHE_MAX || DEFAULT_MAX_MANIFEST_CACHE_ENTRIES);
  if (!Number.isFinite(value)) return DEFAULT_MAX_MANIFEST_CACHE_ENTRIES;
  return Math.max(4, Math.min(Math.floor(value), 64));
}

export function compactManifestValue(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

function manifestTags(item: AuthorizedImageManifestCard): string[] {
  if (Array.isArray(item.tags)) return item.tags.map((tag) => String(tag || '').trim()).filter(Boolean);
  if (typeof item.tags === 'string') return item.tags.split(/[,\s/|]+/).map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function expandImageManifestItems(rawCards: AuthorizedImageManifestCard[]): AuthorizedImageManifestCard[] {
  return rawCards.flatMap((item: AuthorizedImageManifestCard) => {
    if (!item || typeof item !== 'object') return [];
    const urls = [
      typeof item.url === 'string' ? item.url : '',
      ...(Array.isArray(item.urls) ? item.urls : []),
      ...(Array.isArray(item.images) ? item.images : []),
    ]
      .map((url) => String(url || '').trim())
      .filter((url) => /^https?:\/\//i.test(url));
    const tags = manifestTags(item);
    return [...new Set(urls)].map((url, index) => ({
      kind: String(item.kind || '').trim(),
      category: String(item.category || '').trim(),
      itemKey: String(item.itemKey || '').trim(),
      itemName: String(item.itemName || '').trim(),
      key: String(item.key || '').trim(),
      nick: String(item.nick || '').trim(),
      name: String(item.name || '').trim(),
      characterKey: String(item.characterKey || '').trim(),
      characterName: String(item.characterName || '').trim(),
      weapon: String(item.weapon || '').trim(),
      skin: String(item.skin || '').trim(),
      style: String(item.style || '').trim(),
      quality: String(item.quality || '').trim(),
      tags,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0,
      title: index === 0 ? String(item.title || '').trim() : `${String(item.title || '').trim() || 'card'} #${index + 1}`,
      url,
    }));
  });
}

function buildKindIndex(cards: AuthorizedImageManifestCard[]): Map<string, AuthorizedImageManifestCard[]> {
  const index = new Map<string, AuthorizedImageManifestCard[]>();
  for (const card of cards) {
    const kind = compactManifestValue(card.kind || card.category || '');
    if (!kind) continue;
    const bucket = index.get(kind) || [];
    bucket.push(card);
    index.set(kind, bucket);
  }
  return index;
}

function approximateCardsMemoryBytes(cards: AuthorizedImageManifestCard[]): number {
  return Buffer.byteLength(JSON.stringify(cards), 'utf-8');
}

function uniqueUrlCount(cards: AuthorizedImageManifestCard[]): number {
  return new Set(cards.map((card) => String(card.url || '')).filter(Boolean)).size;
}

function evictOldManifestCacheEntries(): void {
  const maxEntries = maxManifestCacheEntries();
  if (manifestCache.size <= maxEntries) return;
  const stale = [...manifestCache.entries()]
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, manifestCache.size - maxEntries);
  for (const [id] of stale) manifestCache.delete(id);
}

function touchManifestEntry(entry: ImageManifestCacheEntry): ImageManifestCacheEntry {
  entry.lastUsedAt = Date.now();
  return entry;
}

function cacheId(manifestKey: string, manifestPath: string): string {
  return `${manifestKey}:${path.resolve(manifestPath)}`;
}

function parseManifestFile(manifestPath: string): AuthorizedImageManifestCard[] {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const rawCards = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cards) ? parsed.cards : [];
  return expandImageManifestItems(rawCards);
}

function loadManifestEntry(manifestPath: string, manifestKey: string): ImageManifestCacheEntry {
  const id = cacheId(manifestKey, manifestPath);
  const cached = manifestCache.get(id);
  try {
    if (!fs.existsSync(manifestPath)) {
      if (cached && !cached.exists) {
        cached.hits++;
        return touchManifestEntry(cached);
      }
      const entry: ImageManifestCacheEntry = {
        key: manifestKey,
        path: manifestPath,
        exists: false,
        cards: [],
        cardsByKind: new Map(),
        uniqueUrls: 0,
        approxMemoryBytes: 0,
        mtimeMs: 0,
        sizeBytes: 0,
        hits: cached?.hits || 0,
        reloads: cached?.reloads || 0,
        lastUsedAt: Date.now(),
        lastLoadedAt: Date.now(),
        lastError: '',
      };
      manifestCache.set(id, entry);
      evictOldManifestCacheEntries();
      return entry;
    }

    const stat = fs.statSync(manifestPath);
    if (cached && cached.exists && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
      cached.hits++;
      return touchManifestEntry(cached);
    }

    const cards = parseManifestFile(manifestPath);
    const entry: ImageManifestCacheEntry = {
      key: manifestKey,
      path: manifestPath,
      exists: true,
      cards,
      cardsByKind: buildKindIndex(cards),
      uniqueUrls: uniqueUrlCount(cards),
      approxMemoryBytes: approximateCardsMemoryBytes(cards),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      hits: cached?.hits || 0,
      reloads: (cached?.reloads || 0) + 1,
      lastUsedAt: Date.now(),
      lastLoadedAt: Date.now(),
      lastError: '',
    };
    manifestCache.set(id, entry);
    evictOldManifestCacheEntries();
    return entry;
  } catch (err) {
    const entry: ImageManifestCacheEntry = {
      key: manifestKey,
      path: manifestPath,
      exists: fs.existsSync(manifestPath),
      cards: cached?.cards || [],
      cardsByKind: cached?.cardsByKind || new Map(),
      uniqueUrls: cached?.uniqueUrls || 0,
      approxMemoryBytes: cached?.approxMemoryBytes || 0,
      mtimeMs: cached?.mtimeMs || 0,
      sizeBytes: cached?.sizeBytes || 0,
      hits: cached?.hits || 0,
      reloads: cached?.reloads || 0,
      lastUsedAt: Date.now(),
      lastLoadedAt: Date.now(),
      lastError: err instanceof Error ? err.message : String(err),
    };
    manifestCache.set(id, entry);
    evictOldManifestCacheEntries();
    console.warn(`[image-manifest] 本地图片清单读取失败 ${manifestKey}:`, entry.lastError);
    return entry;
  }
}

export function loadImageManifest(manifestPath: string, manifestKey: string): AuthorizedImageManifestCard[] {
  return loadManifestEntry(manifestPath, manifestKey).cards;
}

export function loadImageManifestByKinds(manifestPath: string, manifestKey: string, kinds: string[]): AuthorizedImageManifestCard[] {
  const entry = loadManifestEntry(manifestPath, manifestKey);
  const seen = new Set<AuthorizedImageManifestCard>();
  const cards: AuthorizedImageManifestCard[] = [];
  for (const kind of kinds.map(compactManifestValue).filter(Boolean)) {
    for (const card of entry.cardsByKind.get(kind) || []) {
      if (seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }
  }
  return cards;
}

export function getImageManifestCacheStats(): ImageManifestCacheStats[] {
  return [...manifestCache.values()]
    .sort((a, b) => a.key.localeCompare(b.key) || a.path.localeCompare(b.path))
    .map((entry) => ({
      key: entry.key,
      path: entry.path,
      exists: entry.exists,
      cards: entry.cards.length,
      kinds: entry.cardsByKind.size,
      uniqueUrls: entry.uniqueUrls,
      approxMemoryKB: Math.round(entry.approxMemoryBytes / 1024),
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      hits: entry.hits,
      reloads: entry.reloads,
      lastUsedAt: entry.lastUsedAt,
      lastLoadedAt: entry.lastLoadedAt,
      lastError: entry.lastError,
    }));
}

export function getImageManifestSignature(manifestPath: string, manifestKey: string): string {
  const entry = loadManifestEntry(manifestPath, manifestKey);
  return `${entry.exists ? '1' : '0'}:${entry.mtimeMs}:${entry.sizeBytes}:${entry.cards.length}`;
}

export function clearImageManifestCache(): void {
  manifestCache.clear();
}
