import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { AIConfig } from '../types';

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'stt_cache');
let cacheHits = 0;
let cacheMisses = 0;
let downloadMisses = 0;
let transcriptMisses = 0;
let lastSttError = '';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(input: string, config: AIConfig): string {
  return crypto
    .createHash('sha1')
    .update([
      input,
      config.stt_model || '',
      config.model || '',
      config.api_url || '',
    ].join('\n'))
    .digest('hex')
    .slice(0, 24);
}

function maxCacheAgeMs(config?: AIConfig): number {
  return Math.max(1, config?.stt_cache_hours || 24) * 60 * 60 * 1000;
}

function getCachedTranscript(key: string, config: AIConfig): string | null {
  const filepath = path.join(CACHE_DIR, `${key}.txt`);
  try {
    if (!fs.existsSync(filepath)) return null;
    const stat = fs.statSync(filepath);
    if (Date.now() - stat.mtimeMs > maxCacheAgeMs(config)) {
      fs.unlinkSync(filepath);
      return null;
    }
    const text = fs.readFileSync(filepath, 'utf-8').trim();
    if (!text) return null;
    cacheHits++;
    return text;
  } catch {
    return null;
  }
}

function setCachedTranscript(key: string, text: string): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.txt`), cleaned, 'utf-8');
  } catch { /* */ }
}

function detectAudioMime(buffer: Buffer, source: string): string {
  const lower = source.toLowerCase();
  if (buffer.subarray(0, 4).toString() === 'RIFF') return 'audio/wav';
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.amr')) return 'audio/amr';
  if (lower.endsWith('.silk')) return 'audio/silk';
  return 'audio/mpeg';
}

function sourceExt(source: string): string {
  const clean = source.split('?')[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]{2,5})$/);
  return match ? match[1] : 'audio';
}

function isLikelyProviderFriendly(mime: string, source: string): boolean {
  const lower = source.toLowerCase();
  return (
    mime === 'audio/wav' ||
    mime === 'audio/mpeg' ||
    mime === 'audio/ogg' ||
    mime === 'audio/mp4' ||
    /\.(wav|mp3|ogg|opus|m4a|mp4)(?:\?|$)/i.test(lower)
  );
}

function convertAudioToMp3(buffer: Buffer, source: string, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let dir = '';
    try {
      dir = fs.mkdtempSync(path.join(CACHE_DIR, 'tmp-'));
      const inputPath = path.join(dir, `input.${sourceExt(source)}`);
      const outputPath = path.join(dir, 'output.mp3');
      fs.writeFileSync(inputPath, buffer);

      const child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '64k',
        outputPath,
      ], { windowsHide: true });

      let settled = false;
      const finish = (value: Buffer | null): void => {
        if (settled) return;
        settled = true;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        resolve(value);
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* */ }
        finish(null);
      }, Math.max(3000, Math.min(timeoutMs, 10000)));
      timer.unref();

      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(outputPath)) {
          finish(null);
          return;
        }
        try {
          const out = fs.readFileSync(outputPath);
          finish(out.length > 128 ? out : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
      }
      resolve(null);
    }
  });
}

function setSttError(message: string): void {
  lastSttError = message.slice(0, 180);
}

function readLocalRecord(input: string, maxBytes: number): Buffer | null {
  const filepath = input.startsWith('file://') ? input.slice('file://'.length) : input;
  if (!filepath || /^https?:\/\//i.test(filepath) || !fs.existsSync(filepath)) return null;
  const stat = fs.statSync(filepath);
  if (stat.size <= 0 || stat.size > maxBytes) {
    setSttError(`local size out of range: ${stat.size}/${maxBytes}`);
    return null;
  }
  return fs.readFileSync(filepath);
}

function downloadRecord(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qqbot/1.0)' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        setSttError(`download HTTP ${res.statusCode}`);
        finish(null);
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          setSttError(`download too large: ${total}/${maxBytes}`);
          finish(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(Buffer.concat(chunks)));
    });

    req.on('error', (err) => {
      setSttError(`download: ${err.message}`);
      finish(null);
    });
    req.setTimeout(timeoutMs, () => {
      setSttError('download timeout');
      finish(null);
      req.destroy();
    });
  });
}

async function getRecordBuffer(input: string, config: AIConfig): Promise<Buffer | null> {
  const maxBytes = Math.max(1, config.stt_max_file_mb || 4) * 1024 * 1024;
  try {
    const local = readLocalRecord(input, maxBytes);
    if (local) return local;
    if (!/^https?:\/\//i.test(input)) return null;
    return await downloadRecord(input, Math.max(3000, config.stt_timeout_ms || 20000), maxBytes);
  } catch (err) {
    setSttError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function normalizeTranscript(text: string): string {
  return text
    .replace(/^["「『](.+)["」』]$/s, '$1')
    .replace(/^(?:转写|听写|语音内容|音频内容)\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function extractTranscript(json: any): string {
  const candidates = [
    json.text,
    json.transcript,
    json.choices?.[0]?.message?.content,
    json.choices?.[0]?.text,
    json.data?.text,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return normalizeTranscript(item);
  }
  return '';
}

function audioFormat(mime: string, source: string): 'wav' | 'mp3' | 'ogg' | 'm4a' {
  const lower = source.toLowerCase();
  if (mime.includes('wav') || lower.endsWith('.wav')) return 'wav';
  if (mime.includes('ogg') || lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'ogg';
  if (mime.includes('mp4') || lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'm4a';
  return 'mp3';
}

function postAudioPayload(config: AIConfig, requestBody: unknown): Promise<string> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(config.api_url);
    } catch {
      setSttError('invalid api_url');
      resolve('');
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const body = JSON.stringify(requestBody);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const transport = isHttps ? https : http;
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = transport.request(options, (res) => {
      let data = '';
      let total = 0;
      const maxResponseBytes = 2 * 1024 * 1024;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxResponseBytes) {
          setSttError('response too large');
          finish('');
          req.destroy();
          return;
        }
        data += chunk.toString();
      });
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode && res.statusCode >= 400) {
          setSttError(`HTTP ${res.statusCode}: ${data.slice(0, 120)}`);
          finish('');
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.error) {
            setSttError(json.error.message || 'api error');
            finish('');
            return;
          }
          const text = extractTranscript(json);
          if (!text) setSttError('empty transcript');
          else lastSttError = '';
          finish(text);
        } catch (err) {
          setSttError(`parse failed: ${err instanceof Error ? err.message : String(err)}`);
          finish('');
        }
      });
    });

    req.on('error', (err) => {
      setSttError(`network: ${err.message}`);
      finish('');
    });
    req.setTimeout(Math.max(3000, config.stt_timeout_ms || 20000), () => {
      setSttError('timeout');
      finish('');
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

async function callAudioModel(config: AIConfig, buffer: Buffer, mime: string, source: string): Promise<string> {
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mime};base64,${base64}`;
  const model = config.stt_model || config.vision_model || config.model;
  const base = {
    model,
    max_tokens: 300,
    temperature: 0,
    stream: false,
  };
  const system = { role: 'system', content: '你是语音听写器。把QQ语音转写成中文文本，只输出听写文本；听不清就输出空字符串，不要解释。' };
  const text = { type: 'text', text: '请听写这段QQ语音。' };
  const attempts = [
    {
      ...base,
      messages: [
        system,
        {
          role: 'user',
          content: [
            text,
            { type: 'input_audio', input_audio: { data: base64, format: audioFormat(mime, source) } },
          ],
        },
      ],
    },
    {
      ...base,
      messages: [
        system,
        {
          role: 'user',
          content: [
            text,
            { type: 'audio_url', audio_url: { url: dataUrl } },
          ],
        },
      ],
    },
  ];

  for (const payload of attempts) {
    const text = await postAudioPayload(config, payload);
    if (text) return text;
  }
  return '';
}

export async function transcribeRecord(config: AIConfig, input: string): Promise<string> {
  if (!config.enable_stt || !input) return '';
  const key = cacheKey(input, config);
  const cached = getCachedTranscript(key, config);
  if (cached) return cached;
  cacheMisses++;

  let buffer = await getRecordBuffer(input, config);
  if (!buffer || buffer.length < 128) {
    downloadMisses++;
    if (!lastSttError) setSttError('empty audio');
    return '';
  }

  let mime = detectAudioMime(buffer, input);
  if (!isLikelyProviderFriendly(mime, input)) {
    const converted = await convertAudioToMp3(buffer, input, Math.max(3000, config.stt_timeout_ms || 20000));
    if (converted) {
      buffer = converted;
      mime = 'audio/mpeg';
    }
  }
  const transcript = await callAudioModel(config, buffer, mime, input);
  if (!transcript) {
    transcriptMisses++;
    return '';
  }
  setCachedTranscript(key, transcript);
  return transcript;
}

export async function transcribeRecords(config: AIConfig, inputs: string[]): Promise<string[]> {
  if (!config.enable_stt || inputs.length === 0) return [];
  const limit = Math.max(1, Math.min(config.stt_max_records || 1, 4));
  const results: string[] = [];
  for (const input of inputs.slice(0, limit)) {
    const text = await transcribeRecord(config, input);
    if (text) results.push(text);
  }
  return results;
}

export function cleanSttCache(config?: AIConfig): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const now = Date.now();
    const maxAge = maxCacheAgeMs(config);
    for (const file of fs.readdirSync(CACHE_DIR)) {
      const filepath = path.join(CACHE_DIR, file);
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filepath);
    }
  } catch { /* */ }
}

const cleanupTimer = setInterval(cleanSttCache, 30 * 60 * 1000);
cleanupTimer.unref();

export function getSttStats(config?: AIConfig): {
  enabled: boolean;
  model: string;
  cacheFiles: number;
  sizeMB: number;
  hits: number;
  misses: number;
  downloadMisses: number;
  transcriptMisses: number;
  maxRecords: number;
  maxFileMB: number;
  lastError: string;
} {
  let files = 0;
  let size = 0;
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const file of fs.readdirSync(CACHE_DIR)) {
        if (!file.endsWith('.txt')) continue;
        files++;
        size += fs.statSync(path.join(CACHE_DIR, file)).size;
      }
    }
  } catch { /* */ }

  return {
    enabled: config?.enable_stt === true,
    model: config?.stt_model || config?.vision_model || config?.model || '',
    cacheFiles: files,
    sizeMB: Math.round(size / 1024 / 1024 * 10) / 10,
    hits: cacheHits,
    misses: cacheMisses,
    downloadMisses,
    transcriptMisses,
    maxRecords: config?.stt_max_records || 1,
    maxFileMB: config?.stt_max_file_mb || 4,
    lastError: lastSttError,
  };
}
