import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { AIConfig } from '../types';

/**
 * TTS语音合成 - 使用MiMo-V2.5-TTS / VoiceClone
 * voiceclone: 需要用户有权使用的授权参考音频
 */

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'voice_cache');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
let cacheHits = 0;
let cacheMisses = 0;
let inFlightHits = 0;
let lastVoiceError = '';
let lastVoiceMode = '';
let localTtsRuns = 0;
let apiTtsRuns = 0;
let lastCleanupAt = 0;
let lastCleanupDeleted = 0;
let cleanupDeletedTotal = 0;
const voiceInFlight: Map<string, Promise<string | null>> = new Map();

class TtsRequestError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'TtsRequestError';
    this.statusCode = statusCode;
  }
}

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

function getLocalVoiceCacheBase(text: string, config: AIConfig, sampleKey: string): string {
  const dir = localOutputDir(config);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const hash = crypto
    .createHash('sha1')
    .update([
      'local',
      config.tts_local_command || '',
      config.tts_voice_prompt || '',
      sampleKey,
      text,
    ].join('\n'))
    .digest('hex')
    .slice(0, 20);
  return path.join(dir, hash);
}

function validGeneratedAudioPath(filepath: string): boolean {
  try {
    if (!filepath) return false;
    const resolved = filepath.startsWith('file://') ? filepath.slice('file://'.length) : filepath;
    if (!fs.existsSync(resolved)) return false;
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 200 && /\.(wav|mp3|ogg|m4a)$/i.test(resolved);
  } catch {
    return false;
  }
}

function localOutputDir(config: AIConfig): string {
  return resolveProjectPath(config.tts_local_output_dir, 'voice_cache/local');
}

function normalizeLocalOutputPath(stdout: string, fallbackPath: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const line = lines.length > 0 ? lines[lines.length - 1] : '';
  const candidate = line.startsWith('file://') ? line.slice('file://'.length) : line;
  if (candidate && /\.(wav|mp3|ogg|m4a)$/i.test(candidate)) {
    return path.isAbsolute(candidate) ? candidate : path.resolve(PROJECT_ROOT, candidate);
  }
  return fallbackPath;
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

function setVoiceMode(mode: string): void {
  lastVoiceMode = mode.slice(0, 80);
}

function safeApiError(data: string): string {
  try {
    const json = JSON.parse(data);
    const message = json.error?.message || json.message || json.msg || json.error || data;
    return String(message)
      .replace(/data:audio\/[^;]+;base64,[A-Za-z0-9+/_=-]+/g, '[audio-data]')
      .replace(/[A-Za-z0-9+/_=-]{160,}/g, '[long-data]')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
  } catch {
    return data
      .replace(/data:audio\/[^;]+;base64,[A-Za-z0-9+/_=-]+/g, '[audio-data]')
      .replace(/[A-Za-z0-9+/_=-]{160,}/g, '[long-data]')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
  }
}

function normalizeAudioCandidate(item: string): string {
  const value = item.trim();
  if (!value) return '';
  const raw = value.replace(/^data:audio\/[^;]+;base64,/, '').replace(/\s+/g, '');
  if (raw.length < 100) return '';
  if (!/^[A-Za-z0-9+/_=-]+$/.test(raw)) return '';
  return value;
}

function firstAudioString(...items: any[]): string {
  for (const item of items) {
    if (typeof item === 'string') {
      const candidate = normalizeAudioCandidate(item);
      if (candidate) return candidate;
    }
    if (Array.isArray(item)) {
      const nested = firstAudioString(...item);
      if (nested) return nested;
    } else if (item && typeof item === 'object') {
      const nested = firstAudioString(
        item.audio?.data,
        item.audio,
        item.data,
        item.b64_json,
        item.base64,
        item.content,
        item.text,
      );
      if (nested) return nested;
    }
  }
  return '';
}

function extractAudioBase64(json: any): string {
  return firstAudioString(
    json.choices?.[0]?.message?.audio?.data,
    json.choices?.[0]?.message?.audio?.transcript,
    json.choices?.[0]?.message?.content,
    json.audio?.data,
    json.audio,
    json.data?.audio,
    json.data?.[0]?.audio,
    json.output?.audio?.data,
    json.output?.audio,
    json.output?.[0]?.content,
    json.response?.audio,
  );
}

function ttsPrompt(config: AIConfig): string {
  return config.tts_voice_prompt || '用年轻男性声音，语气随意放松，像直播间接弹幕，语速偏快但吐字清楚。不要端播音腔，短句有停顿感。';
}

function buildTtsPayloadVariants(
  config: AIConfig,
  text: string,
  model: string,
  sample: { dataUrl: string; ready: boolean },
  useClone: boolean,
): Array<{ label: string; body: any }> {
  const prompt = ttsPrompt(config);
  const audio = useClone
    ? { voice: sample.dataUrl, format: 'mp3' }
    : { format: 'mp3' };

  const variants: Array<{ label: string; body: any }> = [
    {
      label: useClone ? 'mimo-voiceclone-chat-v25' : 'mimo-tts-chat-v25',
      body: {
        model,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
        ],
        audio,
        temperature: 0.8,
        top_p: 0.95,
      },
    },
    {
      label: useClone ? 'mimo-voiceclone-chat-v25-no-format' : 'mimo-tts-chat-v25-no-format',
      body: {
        model,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
        ],
        audio: useClone ? { voice: sample.dataUrl } : {},
        temperature: 0.8,
      },
    },
    {
      label: useClone ? 'mimo-voiceclone-legacy-system' : 'mimo-tts-legacy-system',
      body: {
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '请说' },
          { role: 'assistant', content: text },
        ],
        audio,
        temperature: 0.8,
      },
    },
  ];

  if (useClone) {
    variants.push(
      {
        label: 'openai-style-input-reference-audio',
        body: {
          model,
          input: text,
          instructions: prompt,
          response_format: 'mp3',
          reference_audio: sample.dataUrl,
        },
      },
      {
        label: 'openai-style-input-voice-sample',
        body: {
          model,
          input: text,
          instructions: prompt,
          response_format: 'mp3',
          voice_sample: sample.dataUrl,
        },
      },
    );
  }

  return variants;
}

function postTtsRequest(config: AIConfig, url: URL, bodyObject: any, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const body = JSON.stringify(bodyObject);

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
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = 16 * 1024 * 1024;
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const finish = (buffer: Buffer): void => {
        if (settled) return;
        settled = true;
        resolve(buffer);
      };

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          fail(new Error(`${label}: response too large`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks);
        const data = buffer.toString('utf-8');
        if (res.statusCode && res.statusCode >= 400) {
          fail(new TtsRequestError(`${label}: HTTP ${res.statusCode}: ${safeApiError(data)}`, res.statusCode));
          return;
        }

        if ((contentType.includes('audio/') || contentType.includes('octet-stream')) && !contentType.includes('json')) {
          finish(buffer);
          return;
        }

        try {
          const json = JSON.parse(data);
          if (json.error) {
            fail(new Error(`${label}: ${safeApiError(JSON.stringify(json))}`));
            return;
          }

          const audioBase64 = extractAudioBase64(json);
          if (!audioBase64 || audioBase64.length < 100) {
            fail(new Error(`${label}: empty audio response`));
            return;
          }
          finish(Buffer.from(String(audioBase64).replace(/^data:audio\/[^;]+;base64,/, ''), 'base64'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fail(new Error(`${label}: parse failed: ${message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`${label}: network: ${err.message}`)));
    req.setTimeout(config.tts_timeout_ms || 20000, () => {
      req.destroy();
      reject(new Error(`${label}: timeout`));
    });
    req.write(body);
    req.end();
  });
}

function runLocalVoiceGeneration(
  config: AIConfig,
  text: string,
  cacheBase: string,
  sample: ReturnType<typeof getVoiceSample>,
): Promise<string | null> {
  return new Promise((resolve) => {
    const command = (config.tts_local_command || '').trim();

    let tempDir = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
      }
      resolve(value);
    };

    try {
      tempDir = fs.mkdtempSync(path.join(CACHE_DIR, 'local-tts-'));
      const textFile = path.join(tempDir, 'input.txt');
      const fallbackOutput = `${cacheBase}.wav`;
      fs.writeFileSync(textFile, text, 'utf-8');

      localTtsRuns++;
      const child = spawn(command, {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          QQBOT_TTS_TEXT: text,
          QQBOT_TTS_TEXT_FILE: textFile,
          QQBOT_TTS_OUTPUT: fallbackOutput,
          QQBOT_TTS_VOICE_SAMPLE: sample.ready ? sample.filepath : '',
          QQBOT_TTS_PROMPT: config.tts_voice_prompt || '',
          QQBOT_TTS_FORMAT: 'wav',
        },
        shell: true,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      const maxLogChars = 4000;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-maxLogChars);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-maxLogChars);
      });

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* */ }
        setVoiceError('local tts timeout');
        finish(null);
      }, Math.max(3000, config.tts_local_timeout_ms || config.tts_timeout_ms || 15000));
      timer.unref();

      child.on('error', (err) => {
        clearTimeout(timer);
        setVoiceError(`local tts: ${err.message}`);
        finish(null);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        const outputPath = normalizeLocalOutputPath(stdout, fallbackOutput);
        if (code === 0 && validGeneratedAudioPath(outputPath)) {
          const ext = (path.extname(outputPath).replace('.', '').toLowerCase() || 'wav') as 'wav' | 'mp3' | 'ogg' | 'm4a';
          const cachedOutput = `${cacheBase}.${ext}`;
          try {
            if (path.resolve(outputPath) !== path.resolve(cachedOutput)) {
              fs.copyFileSync(outputPath, cachedOutput);
            }
            lastVoiceError = '';
            finish(cachedOutput);
          } catch (err) {
            setVoiceError(`local tts copy: ${err instanceof Error ? err.message : String(err)}`);
            finish(null);
          }
          return;
        }
        const detail = (stderr || stdout || `exit ${code}`).replace(/\s+/g, ' ').slice(0, 140);
        setVoiceError(`local tts failed: ${detail}`);
        finish(null);
      });
    } catch (err) {
      setVoiceError(`local tts setup: ${err instanceof Error ? err.message : String(err)}`);
      finish(null);
    }
  });
}

async function generateLocalVoice(config: AIConfig, text: string): Promise<string | null> {
  const command = (config.tts_local_command || '').trim();
  if (!command) {
    setVoiceError('local tts command missing');
    return null;
  }

  const maxChars = Math.max(10, config.tts_max_chars || 120);
  if (text.length < 2 || text.length > maxChars) {
    setVoiceError(`text length out of range: ${text.length}/${maxChars}`);
    return null;
  }

  const sample = getVoiceSample(config);
  const sampleKey = sample.ready ? `${sample.filepath}:${sample.size}:${sample.mime}` : 'no-sample';
  const cacheBase = getLocalVoiceCacheBase(text, config, sampleKey);
  const cachedPath = findCachedVoice(cacheBase, config);
  if (cachedPath) {
    cacheHits++;
    lastVoiceError = '';
    return cachedPath;
  }

  const inFlight = voiceInFlight.get(cacheBase);
  if (inFlight) {
    cacheHits++;
    inFlightHits++;
    return inFlight;
  }

  cacheMisses++;
  const request = runLocalVoiceGeneration(config, text, cacheBase, sample)
    .finally(() => voiceInFlight.delete(cacheBase));
  voiceInFlight.set(cacheBase, request);
  return request;
}

/** 调用远端TTS生成语音，返回本地WAV/MP3文件路径 */
async function runApiVoiceGeneration(
  config: AIConfig,
  text: string,
  url: URL,
  model: string,
  sample: ReturnType<typeof getVoiceSample>,
  useClone: boolean,
  cacheBase: string,
): Promise<string | null> {
  apiTtsRuns++;

  let lastError: Error | null = null;
  const variants = buildTtsPayloadVariants(config, text, model, sample, useClone);
  for (const variant of variants) {
    try {
      setVoiceMode(variant.label);
      const audioBuffer = await postTtsRequest(config, url, variant.body, variant.label);
      const { buffer: wavBuffer, ext } = normalizeGeneratedAudio(audioBuffer);
      const outputPath = `${cacheBase}.${ext}`;
      fs.writeFileSync(outputPath, wavBuffer);

      if (wavBuffer.length < 200) {
        fs.unlinkSync(outputPath);
        throw new Error(`${variant.label}: generated audio too small`);
      }

      lastVoiceError = '';
      return outputPath;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      setVoiceError(lastError.message);
      if (err instanceof TtsRequestError && (err.statusCode === 401 || err.statusCode === 403)) {
        break;
      }
    }
  }

  if (lastError) {
    console.error('[TTS] API生成失败:', lastError.message);
  }
  return null;
}

async function generateApiVoice(config: AIConfig, text: string): Promise<string | null> {
  const maxChars = Math.max(10, config.tts_max_chars || 120);
  if (text.length < 2 || text.length > maxChars) {
    setVoiceError(`text length out of range: ${text.length}/${maxChars}`);
    return null;
  }

  let url: URL;
  try {
    url = new URL(config.api_url);
  } catch {
    setVoiceError('invalid api_url');
    return null;
  }

  // 如果有授权声音样本，用voiceclone；否则用普通tts
  const sample = getVoiceSample(config);
  const useClone = sample.ready && !!sample.dataUrl;
  const model = useClone
    ? (config.tts_clone_model || 'mimo-v2.5-tts-voiceclone')
    : (config.tts_model || 'mimo-v2.5-tts');
  const sampleKey = useClone ? `${sample.filepath}:${sample.size}:${sample.mime}` : 'no-sample';
  const cacheBase = getVoiceCacheBase(text, config, useClone, sampleKey);

  const cachedPath = findCachedVoice(cacheBase, config);
  if (cachedPath) {
    cacheHits++;
    lastVoiceError = '';
    return cachedPath;
  }

  const inFlight = voiceInFlight.get(cacheBase);
  if (inFlight) {
    cacheHits++;
    inFlightHits++;
    return inFlight;
  }

  cacheMisses++;
  const request = runApiVoiceGeneration(config, text, url, model, sample, useClone, cacheBase)
    .finally(() => voiceInFlight.delete(cacheBase));
  voiceInFlight.set(cacheBase, request);
  return request;
}

/** 调用TTS生成语音，返回本地音频文件路径 */
export async function generateVoice(config: AIConfig, text: string): Promise<string | null> {
  const provider = config.tts_provider || 'api';
  if (provider === 'local') {
    return generateLocalVoice(config, text);
  }
  if (provider === 'auto') {
    const local = await generateLocalVoice(config, text);
    if (local) return local;
    if (!config.api_url || !config.api_key) return null;
    return generateApiVoice(config, text);
  }
  return generateApiVoice(config, text);
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
    const now = Date.now();
    const maxAge = config ? maxCacheAgeMs(config) : 24 * 60 * 60 * 1000;
    let deleted = 0;
    let totalSize = 0;
    const alive: Array<{ filepath: string; size: number; mtimeMs: number }> = [];
    for (const filepath of listVoiceFiles(CACHE_DIR)) {
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(filepath);
        deleted++;
        continue;
      }
      totalSize += stat.size;
      alive.push({ filepath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    const maxSize = Math.max(8, config?.tts_cache_max_mb || 512) * 1024 * 1024;
    const maxFiles = Math.max(50, config?.tts_cache_max_files || 3000);
    const sorted = alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let remainingFiles = alive.length;
    for (const entry of sorted) {
      if (totalSize <= maxSize && remainingFiles <= maxFiles) break;
      try {
        fs.unlinkSync(entry.filepath);
        totalSize -= entry.size;
        remainingFiles--;
        deleted++;
      } catch { /* */ }
    }
    lastCleanupAt = now;
    lastCleanupDeleted = deleted;
    cleanupDeletedTotal += deleted;
  } catch { /* */ }
}

const cleanupTimer = setInterval(cleanVoiceCache, 30 * 60 * 1000);
cleanupTimer.unref();

function listVoiceFiles(dir: string): string[] {
  const result: string[] = [];
  try {
    if (!fs.existsSync(dir)) return result;
    for (const item of fs.readdirSync(dir)) {
      const filepath = path.join(dir, item);
      const stat = fs.statSync(filepath);
      if (stat.isDirectory()) {
        result.push(...listVoiceFiles(filepath));
      } else if (/\.(wav|mp3|ogg|m4a)$/i.test(filepath)) {
        result.push(filepath);
      }
    }
  } catch { /* */ }
  return result;
}

function inspectCachedVoicePath(cacheBase: string, config: AIConfig): {
  filepath: string;
  ext: string;
  sizeKB: number;
  ageSeconds: number;
  ttlSeconds: number;
  expired: boolean;
} | null {
  for (const ext of ['wav', 'mp3', 'ogg', 'm4a']) {
    const filepath = `${cacheBase}.${ext}`;
    try {
      if (!fs.existsSync(filepath)) continue;
      const stat = fs.statSync(filepath);
      const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
      const ttlMs = maxCacheAgeMs(config) - ageMs;
      return {
        filepath,
        ext,
        sizeKB: Math.round(stat.size / 1024),
        ageSeconds: Math.round(ageMs / 1000),
        ttlSeconds: Math.max(0, Math.round(ttlMs / 1000)),
        expired: ttlMs <= 0 || stat.size <= 200,
      };
    } catch { /* */ }
  }
  return null;
}

export interface VoiceCacheInspectPart {
  index: number;
  text: string;
  chars: number;
  provider: 'local' | 'api' | 'none';
  mode: string;
  cacheKey: string;
  status: 'hit' | 'miss' | 'in-flight' | 'expired' | 'invalid' | 'disabled';
  reason: string;
  clone: boolean;
  model: string;
  filepath: string;
  ext: string;
  sizeKB: number;
  ageSeconds: number;
  ttlSeconds: number;
}

export interface VoiceCacheInspectResult {
  provider: string;
  localReady: boolean;
  cloneEnabled: boolean;
  cloneReady: boolean;
  sampleReason: string;
  sendMode: string;
  maxChars: number;
  parts: VoiceCacheInspectPart[];
}

function voiceCachePlanForText(config: AIConfig, text: string): Omit<VoiceCacheInspectPart, 'index' | 'text' | 'chars' | 'status' | 'reason' | 'filepath' | 'ext' | 'sizeKB' | 'ageSeconds' | 'ttlSeconds'> & { cacheBase: string } {
  const provider = config.tts_provider || 'api';
  const localCommand = (config.tts_local_command || '').trim();
  const localReady = !!localCommand && (provider === 'local' || provider === 'auto');
  const sample = getVoiceSample(config);
  const sampleKey = sample.ready ? `${sample.filepath}:${sample.size}:${sample.mime}` : 'no-sample';

  if (provider === 'local' || (provider === 'auto' && localReady)) {
    const cacheBase = getLocalVoiceCacheBase(text, config, sampleKey);
    return {
      provider: 'local',
      mode: provider === 'auto' ? 'auto-local' : 'local',
      cacheBase,
      cacheKey: path.basename(cacheBase),
      clone: sample.ready,
      model: 'local',
    };
  }

  const useClone = sample.ready && !!sample.dataUrl;
  const apiSampleKey = useClone ? `${sample.filepath}:${sample.size}:${sample.mime}` : 'no-sample';
  const cacheBase = getVoiceCacheBase(text, config, useClone, apiSampleKey);
  return {
    provider: 'api',
    mode: useClone ? (provider === 'auto' ? 'auto-api-clone' : 'api-clone') : (provider === 'auto' ? 'auto-api' : 'api'),
    cacheBase,
    cacheKey: path.basename(cacheBase),
    clone: useClone,
    model: useClone ? (config.tts_clone_model || 'mimo-v2.5-tts-voiceclone') : (config.tts_model || 'mimo-v2.5-tts'),
  };
}

export function inspectVoiceCache(config: AIConfig, texts: string[]): VoiceCacheInspectResult {
  const sample = getVoiceSample(config);
  const provider = config.tts_provider || 'api';
  const localCommand = (config.tts_local_command || '').trim();
  const localReady = !!localCommand && (provider === 'local' || provider === 'auto');
  const maxChars = Math.max(10, config.tts_max_chars || 120);
  const apiReady = !!(config.api_url && config.api_key);
  const parts: VoiceCacheInspectPart[] = texts.map((text, index) => {
    const raw = (text || '').trim();
    const plan = voiceCachePlanForText(config, raw);
    const cached = inspectCachedVoicePath(plan.cacheBase, config);
    let status: VoiceCacheInspectPart['status'] = 'miss';
    let reason = '未命中，首次生成会写入缓存';
    if (!raw || raw.length < 2 || raw.length > maxChars) {
      status = 'invalid';
      reason = `文本长度不在 2-${maxChars} 字范围内`;
    } else if (!config.enable_tts) {
      status = 'disabled';
      reason = 'TTS未开启';
    } else if (plan.provider === 'local' && !localReady) {
      status = 'disabled';
      reason = '本地TTS未配置';
    } else if (plan.provider === 'api' && !apiReady) {
      status = 'disabled';
      reason = provider === 'auto' ? 'auto没有可用API后端' : 'API后端配置不完整';
    } else if (voiceInFlight.has(plan.cacheBase)) {
      status = 'in-flight';
      reason = '同 key 正在生成，后续请求会等待复用';
    } else if (cached?.expired) {
      status = 'expired';
      reason = '缓存已过期或音频太小，生成时会按 miss 处理';
    } else if (cached) {
      status = 'hit';
      reason = '命中缓存，生成语音时会直接复用音频文件';
    }

    return {
      index: index + 1,
      text: raw,
      chars: raw.length,
      provider: plan.provider,
      mode: plan.mode,
      cacheKey: plan.cacheKey,
      status,
      reason,
      clone: plan.clone,
      model: plan.model,
      filepath: cached?.filepath || '',
      ext: cached?.ext || '',
      sizeKB: cached?.sizeKB || 0,
      ageSeconds: cached?.ageSeconds || 0,
      ttlSeconds: cached?.ttlSeconds || 0,
    };
  });

  return {
    provider,
    localReady,
    cloneEnabled: config.tts_clone_enabled !== false,
    cloneReady: sample.ready,
    sampleReason: sample.reason || '',
    sendMode: config.tts_send_mode || 'base64',
    maxChars,
    parts,
  };
}

export function getVoiceStats(config?: AIConfig): {
  cacheFiles: number;
  sizeMB: number;
  hits: number;
  misses: number;
  inFlight: number;
  inFlightHits: number;
  provider: string;
  localReady: boolean;
  localCommand: string;
  localOutputDir: string;
  localRuns: number;
  apiRuns: number;
  cloneEnabled: boolean;
  cloneReady: boolean;
  samplePath: string;
  sampleSizeMB: number;
  sampleReason: string;
  model: string;
  cloneModel: string;
  maxChars: number;
  sendMode: string;
  lastMode: string;
  lastError: string;
  maxCacheMB: number;
  maxCacheFiles: number;
  lastCleanupAt: number;
  lastCleanupDeleted: number;
  cleanupDeletedTotal: number;
} {
  const sample = getVoiceSample(config);
  const provider = config?.tts_provider || 'api';
  const localCommand = (config?.tts_local_command || '').trim();
  const localReady = !!localCommand && (provider === 'local' || provider === 'auto');
  const localDir = config ? localOutputDir(config) : path.join(CACHE_DIR, 'local');
  const baseStats = {
    hits: cacheHits,
    misses: cacheMisses,
    inFlight: voiceInFlight.size,
    inFlightHits,
    provider,
    localReady,
    localCommand,
    localOutputDir: localDir,
    localRuns: localTtsRuns,
    apiRuns: apiTtsRuns,
    cloneEnabled: config?.tts_clone_enabled !== false,
    cloneReady: sample.ready,
    samplePath: sample.filepath,
    sampleSizeMB: Math.round(sample.size / 1024 / 1024 * 10) / 10,
    sampleReason: sample.reason || '',
    model: config?.tts_model || 'mimo-v2.5-tts',
    cloneModel: config?.tts_clone_model || 'mimo-v2.5-tts-voiceclone',
    maxChars: config?.tts_max_chars || 120,
    sendMode: config?.tts_send_mode || 'base64',
    lastMode: lastVoiceMode,
    lastError: lastVoiceError,
    maxCacheMB: config?.tts_cache_max_mb || 512,
    maxCacheFiles: config?.tts_cache_max_files || 3000,
    lastCleanupAt,
    lastCleanupDeleted,
    cleanupDeletedTotal,
  };
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return {
        cacheFiles: 0,
        sizeMB: 0,
        ...baseStats,
      };
    }

    const files = listVoiceFiles(CACHE_DIR);
    let size = 0;
    for (const filepath of files) {
      try {
        size += fs.statSync(filepath).size;
      } catch { /* */ }
    }

    return {
      cacheFiles: files.length,
      sizeMB: Math.round(size / 1024 / 1024 * 10) / 10,
      ...baseStats,
    };
  } catch {
    return {
      cacheFiles: 0,
      sizeMB: 0,
      ...baseStats,
    };
  }
}


// ============ Voice Clone Sample 自动安装 ============

function downloadAudioToBuffer(url: string, timeoutMs: number = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('音频URL无效'));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 QQ/9.0' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadAudioToBuffer(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const max = 16 * 1024 * 1024; // 16MB 上限保护
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > max) {
          reject(new Error('音频过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      reject(new Error('音频下载超时'));
      req.destroy();
    });
  });
}

/** 从远程URL或本地路径下载并安装为voice_sample */
export async function installVoiceSample(
  config: AIConfig,
  source: string,
): Promise<{ ok: boolean; reason?: string; size?: number; mime?: string; filepath?: string }> {
  const targetPath = resolveProjectPath(config.tts_sample_path, 'voice_sample.mp3');
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  let buffer: Buffer;
  try {
    if (/^https?:\/\//i.test(source)) {
      buffer = await downloadAudioToBuffer(source);
    } else if (source.startsWith('file://')) {
      const localPath = source.slice('file://'.length);
      if (!fs.existsSync(localPath)) return { ok: false, reason: '本地音频文件不存在' };
      buffer = fs.readFileSync(localPath);
    } else if (source.startsWith('base64://')) {
      buffer = Buffer.from(source.slice('base64://'.length), 'base64');
    } else if (fs.existsSync(source)) {
      buffer = fs.readFileSync(source);
    } else {
      return { ok: false, reason: '无效的音频来源' };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '下载失败' };
  }

  if (buffer.length < 8 * 1024) {
    return { ok: false, reason: `音频太小(${buffer.length}字节)，至少需要8KB` };
  }
  const maxBytes = Math.max(1, config.tts_sample_max_mb || 8) * 1024 * 1024;
  if (buffer.length > maxBytes) {
    return { ok: false, reason: `音频太大(${Math.round(buffer.length / 1024 / 1024)}MB)，最多${config.tts_sample_max_mb || 8}MB` };
  }

  const { mime, ext } = detectAudioMime(buffer, targetPath);

  // 统一保存为 mp3 后缀（实际格式由内容决定）
  const finalPath = targetPath.replace(/\.[^.]+$/, '') + '.' + ext;
  try {
    fs.writeFileSync(finalPath, buffer);
    // 如果配置目标和实际后缀不一致，也复制一份到目标路径
    if (finalPath !== targetPath) {
      fs.copyFileSync(finalPath, targetPath);
    }
    voiceSampleCache = null; // 让下次读重新缓存
    return { ok: true, size: buffer.length, mime, filepath: targetPath };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '保存失败' };
  }
}

/** 删除当前voice sample */
export function removeVoiceSample(config: AIConfig): boolean {
  const targetPath = resolveProjectPath(config.tts_sample_path, 'voice_sample.mp3');
  try {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    voiceSampleCache = null;
    return true;
  } catch {
    return false;
  }
}
