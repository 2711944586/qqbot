import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIConfig } from '../types';

/**
 * 图片缓存管理器
 * - 按URL hash缓存到磁盘，重复图片直接复用
 * - LRU清理：最旧的先删
 * - 文件级缓存避免内存爆炸
 * - 限制文件大小和缓存总量
 */

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'image_cache');
let maxCacheSizeMB = 100;
let maxFileSizeBytes = 1 * 1024 * 1024;
let maxCacheAgeHours = 24;
let maxRedirects = 3;
let cleanupIntervalMinutes = 30;
let maxCacheFiles = 5000;
let cacheConfigKey = '';
let downloadFailures = 0;
let lastImageError = '';
let lastCleanupAt = 0;
let lastCleanupDeleted = 0;
let cleanupDeletedTotal = 0;
let cleanupTimer: NodeJS.Timeout | null = null;

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 内存中的元数据索引（小，可忽略） */
interface CacheEntry {
  hash: string;
  filepath: string;
  mime: string;
  size: number;
  createdAt: number;
  lastUsed: number;
}

const memIndex: Map<string, CacheEntry> = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function setImageError(message: string): void {
  lastImageError = message.slice(0, 160);
}

/** 启动时扫描磁盘恢复索引 */
function loadCacheIndex(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      const match = file.match(/^([a-f0-9]+)\.([a-z]+)$/);
      if (!match) continue;
      const [, hash, ext] = match;
      const filepath = path.join(CACHE_DIR, file);
      const stat = fs.statSync(filepath);
      const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      memIndex.set(hash, {
        hash,
        filepath,
        mime,
        size: stat.size,
        createdAt: stat.mtimeMs,
        lastUsed: stat.mtimeMs,
      });
    }
    console.log(`[ImageCache] 加载${memIndex.size}个缓存图片`);
  } catch { /* */ }
}
loadCacheIndex();

function urlHash(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function detectMime(buffer: Buffer): { mime: string; ext: string } {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return { mime: 'image/png', ext: 'png' };
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return { mime: 'image/gif', ext: 'gif' };
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}

function readLocalImage(input: string): { dataUrl: string; hash: string } | null {
  try {
    const filepath = input.startsWith('file://') ? input.slice('file://'.length) : input;
    if (!filepath || /^https?:\/\//i.test(filepath) || !fs.existsSync(filepath)) return null;
    const stat = fs.statSync(filepath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileSizeBytes) {
      setImageError(`local image size out of range: ${stat.size}/${maxFileSizeBytes}`);
      return null;
    }
    const buffer = fs.readFileSync(filepath);
    const { mime } = detectMime(buffer);
    const hash = crypto.createHash('sha1').update(`${filepath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, hash };
  } catch (err) {
    setImageError(`local image read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function readInlineImage(input: string): string | null {
  try {
    let raw = '';
    if (input.startsWith('base64://')) {
      raw = input.slice('base64://'.length);
    } else {
      const match = input.match(/^data:image\/[^;]+;base64,(.+)$/s);
      if (match) return input;
    }
    if (!raw) return null;
    const compact = raw.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
      setImageError('inline image is not valid base64');
      return null;
    }
    const buffer = Buffer.from(compact, 'base64');
    if (buffer.length <= 0 || buffer.length > maxFileSizeBytes) {
      setImageError(`inline image size out of range: ${buffer.length}/${maxFileSizeBytes}`);
      return null;
    }
    const { mime } = detectMime(buffer);
    return `data:${mime};base64,${compact}`;
  } catch (err) {
    setImageError(`inline image read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 下载图片并缓存到磁盘 */
function downloadAndCache(url: string, redirectCount: number = 0, cacheKeyUrl: string = url): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (value: CacheEntry | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (!url || !url.startsWith('http')) {
      setImageError('image url is empty or not http');
      downloadFailures++;
      safeResolve(null);
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      setImageError('invalid image url');
      downloadFailures++;
      safeResolve(null);
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.get({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        if (redirectCount >= maxRedirects) {
          setImageError(`redirect limit ${maxRedirects}`);
          downloadFailures++;
          safeResolve(null);
          res.resume();
          return;
        }
        let nextUrl = '';
        try {
          nextUrl = new URL(res.headers.location, parsedUrl).toString();
        } catch {
          setImageError('invalid redirect location');
          downloadFailures++;
          safeResolve(null);
          res.resume();
          return;
        }
        res.resume();
        void downloadAndCache(nextUrl, redirectCount + 1, cacheKeyUrl).then(safeResolve);
        return;
      }

      if (statusCode !== 200) {
        setImageError(`HTTP ${res.statusCode}`);
        downloadFailures++;
        safeResolve(null);
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let aborted = false;

      res.on('data', (chunk) => {
        if (aborted) return;
        totalSize += chunk.length;
        if (totalSize > maxFileSizeBytes) {
          aborted = true;
          setImageError(`image too large > ${Math.round(maxFileSizeBytes / 1024 / 1024 * 10) / 10}MB`);
          downloadFailures++;
          req.destroy();
          safeResolve(null);
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (aborted) return;
        try {
          const buffer = Buffer.concat(chunks);
          const { mime, ext } = detectMime(buffer);
          const hash = urlHash(cacheKeyUrl);
          const filename = `${hash}.${ext}`;
          const filepath = path.join(CACHE_DIR, filename);

          fs.writeFileSync(filepath, buffer);

          const entry: CacheEntry = {
            hash,
            filepath,
            mime,
            size: buffer.length,
            createdAt: Date.now(),
            lastUsed: Date.now(),
          };
          memIndex.set(hash, entry);
          safeResolve(entry);

          // 立即清理大对象
          chunks.length = 0;
        } catch (err) {
          setImageError(`write failed: ${err instanceof Error ? err.message : String(err)}`);
          downloadFailures++;
          safeResolve(null);
        }
      });

      res.on('error', (err) => {
        setImageError(`response error: ${err.message}`);
        downloadFailures++;
        safeResolve(null);
      });
    });

    req.on('error', (err) => {
      setImageError(`network: ${err.message}`);
      downloadFailures++;
      safeResolve(null);
    });
    req.setTimeout(8000, () => {
      setImageError('download timeout');
      downloadFailures++;
      safeResolve(null);
      req.destroy();
    });
  });
}

/** 获取图片的DataURL（缓存命中则直接读磁盘） */
export async function getImageDataUrl(url: string): Promise<string | null> {
  if (!url) return null;
  const inline = readInlineImage(url);
  if (inline) return inline;
  const local = readLocalImage(url);
  if (local) {
    cacheHits++;
    return local.dataUrl;
  }

  const hash = urlHash(url);
  const cached = memIndex.get(hash);

  if (cached) {
    if (fs.existsSync(cached.filepath)) {
      try {
        const buffer = fs.readFileSync(cached.filepath);
        cached.lastUsed = Date.now();
        cacheHits++;
        return `data:${cached.mime};base64,${buffer.toString('base64')}`;
      } catch {
        memIndex.delete(hash);
      }
    } else {
      memIndex.delete(hash);
    }
  }

  // 下载新图
  cacheMisses++;
  const entry = await downloadAndCache(url);
  if (!entry) return null;

  try {
    const buffer = fs.readFileSync(entry.filepath);
    return `data:${entry.mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    setImageError(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** LRU清理：超过限制时删最旧的 */
export function cleanupCache(): void {
  try {
    const now = Date.now();
    const maxAge = maxCacheAgeHours * 3600 * 1000;
    let totalSize = 0;
    let deleted = 0;
    const entries = [...memIndex.values()];

    // 先删过期的
    for (const entry of entries) {
      if (now - entry.lastUsed > maxAge) {
        try { fs.unlinkSync(entry.filepath); } catch {}
        memIndex.delete(entry.hash);
        deleted++;
      } else {
        totalSize += entry.size;
      }
    }

    // 如果还超出大小限制，按LRU删
    const maxSize = maxCacheSizeMB * 1024 * 1024;
    if (totalSize > maxSize) {
      const sorted = [...memIndex.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      for (const entry of sorted) {
        if (totalSize <= maxSize * 0.7) break;
        try { fs.unlinkSync(entry.filepath); } catch {}
        memIndex.delete(entry.hash);
        totalSize -= entry.size;
        deleted++;
      }
    }

    if (memIndex.size > maxCacheFiles) {
      const sorted = [...memIndex.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      const removeCount = memIndex.size - maxCacheFiles;
      for (const entry of sorted.slice(0, removeCount)) {
        try { fs.unlinkSync(entry.filepath); } catch {}
        memIndex.delete(entry.hash);
        deleted++;
      }
    }

    lastCleanupAt = now;
    lastCleanupDeleted = deleted;
    cleanupDeletedTotal += deleted;
  } catch { /* */ }
}

function ensureCleanupTimer(): void {
  const intervalMs = Math.max(5, cleanupIntervalMinutes) * 60 * 1000;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(cleanupCache, intervalMs);
  cleanupTimer.unref();
}
ensureCleanupTimer();

export function getCacheStats(): {
  count: number;
  sizeMB: number;
  maxSizeMB: number;
  maxFileMB: number;
  maxAgeHours: number;
  maxFiles: number;
  maxRedirects: number;
  cleanupIntervalMinutes: number;
  lastCleanupAt: number;
  lastCleanupDeleted: number;
  cleanupDeletedTotal: number;
  hits: number;
  misses: number;
  downloadFailures: number;
  lastError: string;
} {
  let total = 0;
  for (const entry of memIndex.values()) total += entry.size;
  return {
    count: memIndex.size,
    sizeMB: Math.round(total / 1024 / 1024 * 10) / 10,
    maxSizeMB: maxCacheSizeMB,
    maxFileMB: Math.round(maxFileSizeBytes / 1024 / 1024 * 10) / 10,
    maxAgeHours: maxCacheAgeHours,
    maxFiles: maxCacheFiles,
    maxRedirects,
    cleanupIntervalMinutes,
    lastCleanupAt,
    lastCleanupDeleted,
    cleanupDeletedTotal,
    hits: cacheHits,
    misses: cacheMisses,
    downloadFailures,
    lastError: lastImageError,
  };
}

export function configureImageCache(config?: Pick<AIConfig, 'image_cache_max_mb' | 'image_cache_max_file_mb' | 'image_cache_max_age_hours' | 'image_download_max_redirects' | 'image_cache_cleanup_interval_minutes' | 'image_cache_max_files'>): void {
  const nextCacheSizeMB = Math.max(20, Math.min(Math.floor(Number(config?.image_cache_max_mb) || 100), 4096));
  const maxFileMB = Math.max(0.5, Math.min(Number(config?.image_cache_max_file_mb) || 1, 8));
  const nextFileSizeBytes = Math.floor(maxFileMB * 1024 * 1024);
  const nextCacheAgeHours = Math.max(1, Math.min(Math.floor(Number(config?.image_cache_max_age_hours) || 24), 720));
  const nextRedirects = Math.max(0, Math.min(Math.floor(Number(config?.image_download_max_redirects) || 3), 10));
  const nextCleanupInterval = Math.max(5, Math.min(Math.floor(Number(config?.image_cache_cleanup_interval_minutes) || 30), 1440));
  const nextMaxFiles = Math.max(50, Math.min(Math.floor(Number(config?.image_cache_max_files) || 5000), 100000));
  const nextKey = `${nextCacheSizeMB}:${nextFileSizeBytes}:${nextCacheAgeHours}:${nextRedirects}:${nextCleanupInterval}:${nextMaxFiles}`;
  if (cacheConfigKey === nextKey) return;
  cacheConfigKey = nextKey;
  maxCacheSizeMB = nextCacheSizeMB;
  maxFileSizeBytes = nextFileSizeBytes;
  maxCacheAgeHours = nextCacheAgeHours;
  maxRedirects = nextRedirects;
  cleanupIntervalMinutes = nextCleanupInterval;
  maxCacheFiles = nextMaxFiles;
  ensureCleanupTimer();
  cleanupCache();
}
