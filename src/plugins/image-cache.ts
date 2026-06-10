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
let maxFileSizeBytes = 8 * 1024 * 1024;
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
const downloadInFlight: Map<string, Promise<CacheEntry | null>> = new Map();
/** 主机级限流冷却（429/503 后） */
const rateLimitedHosts: Map<string, number> = new Map();

export interface ImageCacheInspectResult {
  source: string;
  kind: 'inline' | 'local' | 'remote' | 'unknown';
  status: 'inline' | 'local-readable' | 'local-missing' | 'hit' | 'miss' | 'expired' | 'in-flight' | 'invalid' | 'too-large';
  cacheKey: string;
  filepath: string;
  sizeKB: number;
  ageSeconds: number;
  ttlSeconds: number;
  reason: string;
}

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

function inspectLocalImage(input: string): ImageCacheInspectResult {
  let filepath = input;
  if (filepath.startsWith('file://')) filepath = filepath.slice('file://'.length);
  filepath = filepath.replace(/^\/+([a-zA-Z]:)/, '$1');
  const resultBase = {
    source: input,
    kind: 'local' as const,
    cacheKey: '',
    filepath,
    sizeKB: 0,
    ageSeconds: 0,
    ttlSeconds: 0,
  };
  if (!filepath || /^https?:\/\//i.test(filepath)) {
    return { ...resultBase, status: 'invalid', reason: '不是可读本地图片路径' };
  }
  try {
    if (!fs.existsSync(filepath)) {
      return { ...resultBase, status: 'local-missing', reason: '本地路径不存在；Docker/NapCat 容器路径常见这个情况' };
    }
    const stat = fs.statSync(filepath);
    if (!stat.isFile() || stat.size <= 0) {
      return { ...resultBase, status: 'invalid', sizeKB: Math.round((stat.size || 0) / 1024), reason: '路径不是有效图片文件' };
    }
    if (stat.size > maxFileSizeBytes) {
      return {
        ...resultBase,
        status: 'too-large',
        sizeKB: Math.round(stat.size / 1024),
        reason: `超过单图上限 ${Math.round(maxFileSizeBytes / 1024)}KB`,
      };
    }
    return {
      ...resultBase,
      status: 'local-readable',
      cacheKey: crypto.createHash('sha1').update(`${filepath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16),
      sizeKB: Math.round(stat.size / 1024),
      ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
      reason: '本地文件可读；生成识图 payload 时会直接读取，不走远程下载缓存',
    };
  } catch (err) {
    return { ...resultBase, status: 'invalid', reason: `本地路径检查失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function inspectImageCacheSource(source: string): ImageCacheInspectResult {
  const raw = (source || '').trim();
  if (!raw) {
    return {
      source,
      kind: 'unknown',
      status: 'invalid',
      cacheKey: '',
      filepath: '',
      sizeKB: 0,
      ageSeconds: 0,
      ttlSeconds: 0,
      reason: '空图片源',
    };
  }
  if (raw.startsWith('base64://') || /^data:image\/[^;]+;base64,/i.test(raw)) {
    return {
      source: raw,
      kind: 'inline',
      status: 'inline',
      cacheKey: '',
      filepath: '',
      sizeKB: 0,
      ageSeconds: 0,
      ttlSeconds: 0,
      reason: '内联图片会直接进入 payload，不写图片下载缓存',
    };
  }
  if (!/^https?:\/\//i.test(raw)) return inspectLocalImage(raw);

  const hash = urlHash(raw);
  const inFlight = downloadInFlight.has(hash);
  const cached = memIndex.get(hash);
  const base = {
    source: raw,
    kind: 'remote' as const,
    cacheKey: hash,
    filepath: cached?.filepath || path.join(CACHE_DIR, `${hash}.*`),
    sizeKB: cached ? Math.round(cached.size / 1024) : 0,
    ageSeconds: cached ? Math.max(0, Math.round((Date.now() - cached.createdAt) / 1000)) : 0,
    ttlSeconds: 0,
  };
  if (inFlight) {
    return { ...base, status: 'in-flight', reason: '同 URL 正在下载，后续识图会等待并复用同一次下载' };
  }
  if (!cached || !fs.existsSync(cached.filepath)) {
    return { ...base, status: 'miss', reason: '未命中图片缓存，首次真实识图会下载并写入缓存' };
  }
  const ttlSeconds = Math.max(0, Math.round((cached.lastUsed + maxCacheAgeHours * 3600 * 1000 - Date.now()) / 1000));
  if (ttlSeconds <= 0) {
    return { ...base, status: 'expired', ttlSeconds, reason: '缓存已过期，清理后会按 miss 重新下载' };
  }
  return { ...base, status: 'hit', ttlSeconds, reason: '命中图片缓存，真实识图会直接读缓存文件' };
}

export function inspectImageCacheSources(sources: string[], limit = 6): ImageCacheInspectResult[] {
  return sources.slice(0, Math.max(1, limit)).map(inspectImageCacheSource);
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
    let filepath = input;
    if (filepath.startsWith('file://')) filepath = filepath.slice('file://'.length);
    // Windows 路径处理：file:///C:/foo -> C:/foo
    filepath = filepath.replace(/^\/+([a-zA-Z]:)/, '$1');
    if (!filepath || /^https?:\/\//i.test(filepath)) return null;
    if (!fs.existsSync(filepath)) {
      // NapCat 跑在 Docker 时返回的可能是容器内路径，bot 跑在宿主机就找不到
      // 这种情况就静默 fallback 到 url 下载，不打印误导性 error
      return null;
    }
    const stat = fs.statSync(filepath);
    if (!stat.isFile() || stat.size <= 0) {
      setImageError(`local image empty: ${stat.size}`);
      return null;
    }
    if (stat.size > maxFileSizeBytes) {
      setImageError(`local image too large: ${Math.round(stat.size / 1024 / 1024)}MB > ${Math.round(maxFileSizeBytes / 1024 / 1024)}MB`);
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
function downloadAndCache(url: string, redirectCount: number = 0, cacheKeyUrl: string = url, uaIndex: number = 0): Promise<CacheEntry | null> {
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

    // 主机级限流冷却中？跳过
    const cooldown = rateLimitedHosts.get(parsedUrl.hostname);
    if (cooldown && cooldown > Date.now()) {
      setImageError(`host ${parsedUrl.hostname} 在 429 冷却期 (剩余${Math.round((cooldown - Date.now()) / 60000)}分钟)`);
      downloadFailures++;
      safeResolve(null);
      return;
    } else if (cooldown) {
      rateLimitedHosts.delete(parsedUrl.hostname);
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const hostname = parsedUrl.hostname.toLowerCase();
    const isQqCdn = /qq\.com|qpic\.cn|gtimg\.cn/.test(hostname);
    const isLiquipedia = /liquipedia\.net|wikimedia\.org/.test(hostname);

    // 多 UA 重试 - 不同站点对 UA 偏好不同
    const qqUserAgents = [
      'Mozilla/5.0 (Linux; Android 12; PCRT00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 V1_AND_SQ_9.0.10_5395_YYB_D A_9001000 QQ/9.0.10.18435 NetType/WIFI WebP/0.4.1 AppId/537230910',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QQ/9.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];
    const genericUserAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'wanjier-bot/1.0 (https://github.com/2711944586/qqbot)',
    ];
    const userAgents = isQqCdn ? qqUserAgents : genericUserAgents;
    const ua = userAgents[uaIndex % userAgents.length];

    // Referer 仅 QQ CDN 用 im.qq.com；其他站点用对应主页或不用
    const headers: Record<string, string> = {
      'User-Agent': ua,
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (isQqCdn) {
      headers['Referer'] = 'https://im.qq.com/';
    } else if (isLiquipedia) {
      // Liquipedia 接受空 Referer 或自家 Referer，绝对不能用 QQ 的
      headers['Referer'] = 'https://liquipedia.net/';
    }

    const req = transport.get({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
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
        void downloadAndCache(nextUrl, redirectCount + 1, cacheKeyUrl, uaIndex).then(safeResolve);
        return;
      }

      // 非 200 状态：如果是 403/404 且还有 UA 可换，自动换 UA 重试
      if (statusCode !== 200) {
        // 429/503 = 限流，记录冷却期，避免短期重试
        if (statusCode === 429 || statusCode === 503) {
          const hostKey = `__rate__${parsedUrl.hostname}`;
          // 把同 hostname 的所有图片暂存为已知失败10分钟，省 API 调用
          rateLimitedHosts.set(parsedUrl.hostname, Date.now() + 10 * 60 * 1000);
          setImageError(`HTTP ${statusCode} 限流 host=${parsedUrl.hostname}，10分钟内不再尝试同host`);
          downloadFailures++;
          safeResolve(null);
          res.resume();
          return;
        }
        if ((statusCode === 403 || statusCode === 401) && uaIndex < userAgents.length - 1) {
          res.resume();
          console.warn(`[ImageCache] HTTP ${statusCode} ua=${uaIndex}，换UA重试 url=${url.slice(0, 80)}`);
          void downloadAndCache(url, redirectCount, cacheKeyUrl, uaIndex + 1).then(safeResolve);
          return;
        }
        setImageError(`HTTP ${res.statusCode} ${url.slice(0, 80)}`);
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

          // 防御：检查内容是不是真的图片
          if (buffer.length < 32) {
            setImageError(`image too small ${buffer.length}B`);
            downloadFailures++;
            safeResolve(null);
            return;
          }
          // 检查是不是 HTML 错误页（QQ CDN 偶尔返回错误时可能是 200 但 HTML）
          const head = buffer.slice(0, 64).toString('latin1');
          if (/<!doctype html|<html/i.test(head)) {
            setImageError(`got HTML instead of image (probably auth fail)`);
            downloadFailures++;
            safeResolve(null);
            return;
          }

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
    req.setTimeout(15000, () => {
      setImageError(`download timeout url=${url.slice(0, 80)}`);
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
        lastImageError = '';
        return `data:${cached.mime};base64,${buffer.toString('base64')}`;
      } catch {
        memIndex.delete(hash);
      }
    } else {
      memIndex.delete(hash);
    }
  }

  // 下载新图
  let download = downloadInFlight.get(hash);
  if (!download) {
    cacheMisses++;
    download = downloadAndCache(url).finally(() => downloadInFlight.delete(hash));
    downloadInFlight.set(hash, download);
  } else {
    cacheHits++;
  }
  const entry = await download;
  if (!entry) return null;

  try {
    const buffer = fs.readFileSync(entry.filepath);
    lastImageError = '';
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
  inFlight: number;
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
    inFlight: downloadInFlight.size,
    hits: cacheHits,
    misses: cacheMisses,
    downloadFailures,
    lastError: lastImageError,
  };
}

export function configureImageCache(config?: Pick<AIConfig, 'image_cache_max_mb' | 'image_cache_max_file_mb' | 'image_cache_max_age_hours' | 'image_download_max_redirects' | 'image_cache_cleanup_interval_minutes' | 'image_cache_max_files'>): void {
  const nextCacheSizeMB = Math.max(20, Math.min(Math.floor(Number(config?.image_cache_max_mb) || 100), 4096));
  const maxFileMB = Math.max(0.5, Math.min(Number(config?.image_cache_max_file_mb) || 8, 32));
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
