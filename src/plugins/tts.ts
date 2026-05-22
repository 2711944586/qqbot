import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AIConfig } from '../types';

/**
 * TTS语音合成 - 使用MiMo-V2.5-TTS / VoiceClone
 * voiceclone: 需要用户有权使用的授权参考音频
 */

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'voice_cache');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
let cacheHits = 0;
let cacheMisses = 0;
let lastVoiceError = '';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 缓存voice sample的DataURL（避免每次都读文件+base64） */
let voiceSampleCache: {
  key: string;
  dataUrl: string;
  size: number;
  mime: string;
} | null = null;

function resolveProjectPath(input: string | undefined, fallback: string): string {
  const raw = (input || fallback).trim() || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function detectAudioMime(buffer: Buffer, filepath: string): { mime: string; ext: 'mp3' | 'wav' | 'ogg' | 'm4a' } {
  const lower = filepath.toLowerCase();
  if (buffer.subarray(0, 4).toString() === 'RIFF') return { mime: 'audio/wav', ext: 'wav' };
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (buffer.subarray(0, 4).toString() === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (lower.endsWith('.wav')) return { mime: 'audio/wav', ext: 'wav' };
  if (lower.endsWith('.ogg')) return { mime: 'audio/ogg', ext: 'ogg' };
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return { mime: 'audio/mp4', ext: 'm4a' };
  return { mime: 'audio/mpeg', ext: 'mp3' };
}

function getVoiceSample(config?: AIConfig): { dataUrl: string; filepath: string; size: number; mime: string; ready: boolean; reason?: string } {
  if (config?.tts_clone_enabled === false) {
    return { dataUrl: '', filepath: resolveProjectPath(config.tts_sample_path, 'voice_sample.mp3'), size: 0, mime: '', ready: false, reason: 'clone disabled' };
  }

  const filepath = resolveProjectPath(config?.tts_sample_path, 'voice_sample.mp3');
  if (!fs.existsSync(filepath)) {
    return { dataUrl: '', filepath, size: 0, mime: '', ready: false, reason: 'sample missing' };
  }

  const stat = fs.statSync(filepath);
  const maxBytes = Math.max(1, config?.tts_sample_max_mb || 8) * 1024 * 1024;
  if (stat.size < 1024) {
    return { dataUrl: '', filepath, size: stat.size, mime: '', ready: false, reason: 'sample too small' };
  }
  if (stat.size > maxBytes) {
    return { dataUrl: '', filepath, size: stat.size, mime: '', ready: false, reason: 'sample too large' };
  }

  const cacheKey = `${filepath}:${stat.size}:${stat.mtimeMs}`;
  if (voiceSampleCache?.key === cacheKey) {
    return { dataUrl: voiceSampleCache.dataUrl, filepath, size: voiceSampleCache.size, mime: voiceSampleCache.mime, ready: true };
  }

  const buf = fs.readFileSync(filepath);
  const { mime } = detectAudioMime(buf, filepath);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  voiceSampleCache = { key: cacheKey, dataUrl, size: stat.size, mime };
  return { dataUrl, filepath, size: stat.size, mime, ready: true };
}

function getVoiceCacheBase(text: string, config: AIConfig, useClone: boolean, sampleKey: string): string {
  const hash = crypto
    .createHash('sha1')
    .update([
      useClone ? 'clone' : 'tts',
      config.tts_model || '',
      config.tts_clone_model || '',
      config.tts_voice_prompt || '',
      sampleKey,
      text,
    ].join('\n'))
    .digest('hex')
    .slice(0, 20);
  return path.join(CACHE_DIR, hash);
}

function maxCacheAgeMs(config: AIConfig): number {
  return Math.max(1, config.tts_cache_hours || 24) * 60 * 60 * 1000;
}

function findCachedVoice(cacheBase: string, config: AIConfig): string | null {
  for (const ext of ['wav', 'mp3', 'ogg', 'm4a']) {
    const filepath = `${cacheBase}.${ext}`;
    try {
      if (!fs.existsSync(filepath)) continue;
      const stat = fs.statSync(filepath);
      if (Date.now() - stat.mtimeMs <= maxCacheAgeMs(config) && stat.size > 200) {
        return filepath;
      }
      fs.unlinkSync(filepath);
    } catch { /* */ }
  }
  return null;
}

function normalizeGeneratedAudio(buffer: Buffer): { buffer: Buffer; ext: 'wav' | 'mp3' } {
  if (buffer.subarray(0, 4).toString() === 'RIFF') return { buffer, ext: 'wav' };
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return { buffer, ext: 'mp3' };
  }
  return { buffer: pcmToWav(buffer, 24000, 16, 1), ext: 'wav' };
}

function setVoiceError(message: string): void {
  lastVoiceError = message.slice(0, 160);
}

/** 调用TTS生成语音，返回本地WAV文件路径 */
export function generateVoice(config: AIConfig, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const maxChars = Math.max(10, config.tts_max_chars || 120);
    if (text.length < 2 || text.length > maxChars) {
      setVoiceError(`text length out of range: ${text.length}/${maxChars}`);
      safeResolve(null);
      return;
    }

    let url: URL;
    try {
      url = new URL(config.api_url);
    } catch {
      setVoiceError('invalid api_url');
      safeResolve(null);
      return;
    }
    const isHttps = url.protocol === 'https:';

    // 如果有授权声音样本，用voiceclone；否则用普通tts
    let sample = getVoiceSample(config);
    const useClone = sample.ready && !!sample.dataUrl;
    const model = useClone
      ? (config.tts_clone_model || 'mimo-v2.5-tts-voiceclone')
      : (config.tts_model || 'mimo-v2.5-tts');
    const sampleKey = useClone ? `${sample.filepath}:${sample.size}:${sample.mime}` : 'no-sample';
    const cacheBase = getVoiceCacheBase(text, config, useClone, sampleKey);

    const cachedPath = findCachedVoice(cacheBase, config);
    if (cachedPath) {
      cacheHits++;
      safeResolve(cachedPath);
      return;
    }
    cacheMisses++;

    const requestBody: any = {
      model,
      messages: [
        { role: 'system', content: config.tts_voice_prompt || '用年轻男性声音，语气随意放松，像直播间接弹幕，语速偏快但吐字清楚' },
        { role: 'user', content: '请说' },
        { role: 'assistant', content: text },
      ],
    };

    if (useClone) {
      requestBody.audio = { voice: sample.dataUrl };
    }

    const body = JSON.stringify(requestBody);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const transport = isHttps ? https : http;

    const req = transport.request(options, (res) => {
      let data = '';
      let totalBytes = 0;
      const maxBytes = 16 * 1024 * 1024;

      if (res.statusCode && res.statusCode >= 400) {
        setVoiceError(`HTTP ${res.statusCode}`);
        safeResolve(null);
        res.resume();
        return;
      }

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          safeResolve(null);
          req.destroy();
          return;
        }
        data += chunk.toString();
      });
      res.on('end', () => {
        if (settled) return;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            setVoiceError(json.error.message || 'api error');
            console.error('[TTS] API错误:', json.error.message);
            safeResolve(null);
            return;
          }

          const audioBase64 = json.choices?.[0]?.message?.content;
          if (!audioBase64 || audioBase64.length < 100) {
            setVoiceError('empty audio response');
            safeResolve(null);
            return;
          }

          const audioBuffer = Buffer.from(String(audioBase64).replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
          const { buffer: wavBuffer, ext } = normalizeGeneratedAudio(audioBuffer);
          const outputPath = `${cacheBase}.${ext}`;
          fs.writeFileSync(outputPath, wavBuffer);

          if (wavBuffer.length < 200) {
            fs.unlinkSync(outputPath);
            setVoiceError('generated audio too small');
            safeResolve(null);
          } else {
            lastVoiceError = '';
            safeResolve(outputPath);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setVoiceError(`parse failed: ${message}`);
          console.error('[TTS] 解析失败:', err);
          safeResolve(null);
        }
      });
    });

    req.on('error', (err) => {
      setVoiceError(`network: ${err.message}`);
      safeResolve(null);
    });
    req.setTimeout(config.tts_timeout_ms || 20000, () => {
      setVoiceError('timeout');
      safeResolve(null);
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

function pcmToWav(pcmData: Buffer, sampleRate: number, bitsPerSample: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmData]);
}

export function cleanVoiceCache(config?: AIConfig): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    const maxAge = config ? maxCacheAgeMs(config) : 24 * 60 * 60 * 1000;
    for (const file of files) {
      const filepath = path.join(CACHE_DIR, file);
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filepath);
    }
  } catch { /* */ }
}

const cleanupTimer = setInterval(cleanVoiceCache, 30 * 60 * 1000);
cleanupTimer.unref();

export function getVoiceStats(config?: AIConfig): {
  cacheFiles: number;
  sizeMB: number;
  hits: number;
  misses: number;
  cloneEnabled: boolean;
  cloneReady: boolean;
  samplePath: string;
  sampleSizeMB: number;
  sampleReason: string;
  model: string;
  cloneModel: string;
  maxChars: number;
  lastError: string;
} {
  const sample = getVoiceSample(config);
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return {
        cacheFiles: 0,
        sizeMB: 0,
        hits: cacheHits,
        misses: cacheMisses,
        cloneEnabled: config?.tts_clone_enabled !== false,
        cloneReady: sample.ready,
        samplePath: sample.filepath,
        sampleSizeMB: Math.round(sample.size / 1024 / 1024 * 10) / 10,
        sampleReason: sample.reason || '',
        model: config?.tts_model || 'mimo-v2.5-tts',
        cloneModel: config?.tts_clone_model || 'mimo-v2.5-tts-voiceclone',
        maxChars: config?.tts_max_chars || 120,
        lastError: lastVoiceError,
      };
    }

    const files = fs.readdirSync(CACHE_DIR).filter((file) => /\.(wav|mp3|ogg|m4a)$/i.test(file));
    let size = 0;
    for (const file of files) {
      try {
        size += fs.statSync(path.join(CACHE_DIR, file)).size;
      } catch { /* */ }
    }

    return {
      cacheFiles: files.length,
      sizeMB: Math.round(size / 1024 / 1024 * 10) / 10,
      hits: cacheHits,
      misses: cacheMisses,
      cloneEnabled: config?.tts_clone_enabled !== false,
      cloneReady: sample.ready,
      samplePath: sample.filepath,
      sampleSizeMB: Math.round(sample.size / 1024 / 1024 * 10) / 10,
      sampleReason: sample.reason || '',
      model: config?.tts_model || 'mimo-v2.5-tts',
      cloneModel: config?.tts_clone_model || 'mimo-v2.5-tts-voiceclone',
      maxChars: config?.tts_max_chars || 120,
      lastError: lastVoiceError,
    };
  } catch {
    return {
      cacheFiles: 0,
      sizeMB: 0,
      hits: cacheHits,
      misses: cacheMisses,
      cloneEnabled: config?.tts_clone_enabled !== false,
      cloneReady: sample.ready,
      samplePath: sample.filepath,
      sampleSizeMB: Math.round(sample.size / 1024 / 1024 * 10) / 10,
      sampleReason: sample.reason || '',
      model: config?.tts_model || 'mimo-v2.5-tts',
      cloneModel: config?.tts_clone_model || 'mimo-v2.5-tts-voiceclone',
      maxChars: config?.tts_max_chars || 120,
      lastError: lastVoiceError,
    };
  }
}
