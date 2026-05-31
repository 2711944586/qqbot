import * as fs from 'fs';
import { AIConfig, MessageEvent, MessageSegment, PluginContext } from '../types';

/**
 * 媒体处理工具模块
 * 从 ai-chat.ts 拆出
 * 处理图片/语音URL提取、OneBot媒体解析、base64转换
 */

export function extractImageUrls(message: MessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'image')
    .map((seg) => (seg.type === 'image' ? seg.data.url || seg.data.file || '' : ''))
    .filter(Boolean);
}

export function extractRecordUrls(message: MessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'record')
    .map((seg) => (seg.type === 'record' ? seg.data.url || seg.data.file || '' : ''))
    .filter(Boolean);
}

export function uniqueNonEmpty(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function isDirectMediaSource(input: string): boolean {
  if (!input) return false;
  // base64/data URI 总是直接源
  if (/^(data:|base64:\/\/)/i.test(input)) return true;
  // http/https 是远程源
  if (/^https?:\/\//i.test(input)) return true;
  // file:// 必须文件确实存在才算（容器路径在 bot 端看不到）
  if (input.startsWith('file://')) {
    const localPath = input.slice('file://'.length).replace(/^\/+([a-zA-Z]:)/, '$1');
    return fs.existsSync(localPath);
  }
  // 本地绝对路径
  return fs.existsSync(input);
}

function firstStringCandidate(items: unknown[]): string {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function normalizeApiBase64Source(value: string, mime: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  if (raw.startsWith('base64://')) {
    return `data:${mime};base64,${raw.slice('base64://'.length).replace(/\s+/g, '')}`;
  }
  const compact = raw.replace(/\s+/g, '');
  if (compact.length < 80) return '';
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) return '';
  return `data:${mime};base64,${compact}`;
}

export function firstMediaString(data: any, inlineMime: string): string {
  const url = firstStringCandidate([
    data?.url,
    data?.file_url,
    data?.data?.url,
    data?.data?.file_url,
  ]);
  if (url) return url;

  const inline = firstStringCandidate([
    data?.base64,
    data?.b64,
    data?.base64_file,
    data?.file_base64,
    data?.data?.base64,
    data?.data?.b64,
    data?.data?.base64_file,
    data?.data?.file_base64,
  ]);
  const inlineSource = inline ? normalizeApiBase64Source(inline, inlineMime) : '';
  if (inlineSource) return inlineSource;

  const candidates = [
    data?.file,
    data?.path,
    data?.file_path,
    data?.data?.file,
    data?.data?.path,
    data?.data?.file_path,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

export async function resolveOneBotImageSources(
  ctx: PluginContext,
  message: MessageSegment[],
): Promise<string[]> {
  const raw = uniqueNonEmpty(extractImageUrls(message));
  const resolved: string[] = [];
  for (const source of raw) {
    // 1. 已经是 base64 / data URL / file:// / 本地路径 - 直接用
    if (isDirectMediaSource(source)) {
      resolved.push(source);
      continue;
    }

    // 2. 用 get_image 拿 NapCat 缓存的真实文件
    //    NapCat 通常会返回 { file: "/data/.napcat/cache/xxx.jpg", url: "https://...", base64?: "..." }
    //    优先级: base64 > 本地 file path > 重定向后的 url
    let bestSource = '';
    let napcatErr = '';
    try {
      const res = await ctx.bot.callApiAsync('get_image', { file: source }, 6000);
      const data = (res as any)?.data || res;

      // 先看有没有 base64（NapCat 部分版本会直接给）
      const b64 = data?.base64 || data?.b64 || data?.base64_file || data?.file_base64;
      if (typeof b64 === 'string' && b64.length > 80 && /^[A-Za-z0-9+/_=-]+$/.test(b64.replace(/\s+/g, ''))) {
        bestSource = `base64://${b64.replace(/\s+/g, '')}`;
      }

      // 再看本地路径（最稳定）
      if (!bestSource) {
        const filePath = data?.file || data?.path || data?.file_path
          || data?.data?.file || data?.data?.path || data?.data?.file_path;
        if (typeof filePath === 'string' && filePath.trim() && !filePath.startsWith('http') && !filePath.startsWith('data:')) {
          // NapCat 返回的通常是绝对路径，存在就用
          const cleaned = filePath.replace(/^file:\/\//, '');
          // 仅在路径看起来像本地文件才用（避免 cache key 被当成路径）
          if (/^[/\\]|^[a-zA-Z]:/.test(cleaned)) {
            bestSource = `file://${cleaned}`;
          }
        }
      }

      // 最后才是 URL
      if (!bestSource) {
        const url = firstMediaString(data, 'image/jpeg');
        if (url) bestSource = url;
      }
    } catch (err) {
      napcatErr = err instanceof Error ? err.message : String(err);
      console.warn(`[Vision] get_image失败 source=${source.slice(0, 80)} err=${napcatErr}`);
    }

    if (bestSource) {
      resolved.push(bestSource);
    } else {
      console.warn(`[Vision] get_image无可用source 退回原始 source=${source.slice(0, 80)} err=${napcatErr}`);
      // 即使 get_image 失败，原始 source 可能仍然是可下载的 URL
      resolved.push(source);
    }
  }
  return uniqueNonEmpty(resolved);
}

export async function resolveOneBotRecordSources(
  ctx: PluginContext,
  config: AIConfig,
  message: MessageSegment[],
): Promise<string[]> {
  const raw = uniqueNonEmpty(extractRecordUrls(message));
  const resolved: string[] = [];
  for (const source of raw) {
    if (isDirectMediaSource(source)) {
      resolved.push(source);
      continue;
    }
    try {
      const res = await ctx.bot.callApiAsync('get_record', {
        file: source,
        out_format: config.stt_record_format || 'mp3',
      }, 5000);
      const next = firstMediaString((res as any)?.data || res, 'audio/mpeg');
      resolved.push(next || source);
    } catch {
      resolved.push(source);
    }
  }
  return uniqueNonEmpty(resolved);
}

export function voiceRecordSegment(config: AIConfig, filepath: string): MessageSegment {
  const mode = config.tts_send_mode || 'base64';
  if (mode !== 'file') {
    try {
      const buffer = fs.readFileSync(filepath);
      if (buffer.length > 0 && buffer.length <= 16 * 1024 * 1024) {
        return { type: 'record', data: { file: `base64://${buffer.toString('base64')}` } };
      }
    } catch {
      /* fall back to file */
    }
  }
  return { type: 'record', data: { file: `file://${filepath}` } };
}

export function isAtBot(event: MessageEvent): boolean {
  if (event.message_type !== 'group') return false;
  const selfId = String(event.self_id);
  return (
    event.message.some((seg) => seg.type === 'at' && String(seg.data.qq) === selfId) ||
    event.raw_message.includes(`[CQ:at,qq=${selfId}]`)
  );
}
