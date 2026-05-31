import * as https from 'https';
import * as http from 'http';
import { AIConfig } from '../types';

/**
 * LLM API 调用模块
 * 从 ai-chat.ts 拆出的 API 调用层
 * 包含：单次调用、长度截断检测、续写、重试、视觉变体支持
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContent[];
}

export interface MessageContent {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string } | string;
  image?: string;
  input_image?: { image_url?: string; url?: string; detail?: string };
}

export interface LLMPostResult {
  content: string;
  finishReason: string;
}

export type LLMCaller = (config: AIConfig, messages: ChatMessage[], useVision?: boolean) => Promise<string>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** 单次POST调用 */
export function postLLMOnce(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, label: string = 'chat'): Promise<LLMPostResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(config.api_url);
    } catch {
      reject(new Error('API 地址无效'));
      return;
    }

    const isHttps = url.protocol === 'https:';
    const model = useVision ? (config.vision_model || config.model) : config.model;
    const timeoutMs = config.api_timeout_ms || 120000;
    const maxResponseBytes = 8 * 1024 * 1024;
    let settled = false;

    const requestBody: any = {
      model,
      messages,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      stream: false,
      // 减少重复 + 增加多样性
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
    };

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

    const finish = (value: LLMPostResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = transport.request(options, (res) => {
      let data = '';
      let totalBytes = 0;
      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          fail(new Error('响应过大'));
          req.destroy();
          return;
        }
        data += chunk.toString();
      });
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode && res.statusCode >= 400) {
          fail(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.error) {
            fail(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }
          const choice = json.choices?.[0];
          const content = choice?.message?.content ?? choice?.text;
          if (content) {
            finish({
              content: String(content).trim(),
              finishReason: String(choice?.finish_reason || choice?.finishReason || ''),
            });
          } else {
            fail(new Error(`${label}: 无内容返回`));
          }
        } catch {
          fail(new Error(`${label}: 解析失败`));
        }
      });
    });

    req.on('error', (err) => fail(new Error(`${label}: 网络: ${err.message}`)));
    req.setTimeout(timeoutMs, () => {
      fail(new Error(`${label}: 超时`));
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

/** 检测是否因长度截断 */
export function isLengthLimitedFinish(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === 'length' || normalized.includes('max_tokens') || normalized.includes('token_limit');
}

/** 检测内容是否中途被截断（即使finish=stop） */
export function looksTruncated(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;
  const last = trimmed[trimmed.length - 1];
  const properEndings = /[。！？!?…)）"」』.\]]/;
  if (properEndings.test(last)) return false;
  return /[\u4e00-\u9fa5a-zA-Z0-9，,、/]/.test(last);
}

/** 拼接续写结果，去除重复部分 */
export function appendContinuation(base: string, next: string): string {
  const left = base.trimEnd();
  const right = next.trimStart();
  if (!left) return right;
  if (!right) return left;
  const maxOverlap = Math.min(240, left.length, right.length);
  for (let len = maxOverlap; len >= 16; len--) {
    if (left.endsWith(right.slice(0, len))) {
      return `${left}${right.slice(len)}`;
    }
  }
  const separator = /[。！？!?；;\n]$/.test(left) && !/^[，。！？!?；;、,.]/.test(right) ? '\n' : '';
  return `${left}${separator}${right}`;
}

/** 构造续写请求消息 */
export function buildContinuationMessages(messages: ChatMessage[], partialReply: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: partialReply },
    {
      role: 'user',
      content: '刚才回复因为长度限制被截断了。请从断点自然续写补完，不要重头开始，不要解释原因，不要加标题。',
    },
  ];
}

/** 视觉消息的多种payload模式 */
export function buildVisionMessageVariants(messages: ChatMessage[], mode: AIConfig['vision_payload_mode']): Array<{ label: string; messages: ChatMessage[] }> {
  const modes: NonNullable<AIConfig['vision_payload_mode']>[] = mode && mode !== 'auto'
    ? [mode]
    : ['image_url_object', 'image_url_string', 'input_image', 'image_base64'];
  return modes.map((visionMode) => ({
    label: visionMode,
    messages: messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => convertVisionPart(part, visionMode)),
    })),
  }));
}

function convertVisionPart(part: MessageContent, mode: NonNullable<AIConfig['vision_payload_mode']>): MessageContent {
  if (part.type === 'text') return { type: 'text', text: part.text || '' };
  const image = extractImagePartUrl(part);
  if (!image.url) return part;
  if (mode === 'image_url_string') return { type: 'image_url', image_url: image.url };
  if (mode === 'input_image') return { type: 'input_image', image_url: image.url };
  if (mode === 'image_base64') return { type: 'image', image: image.url };
  return { type: 'image_url', image_url: { url: image.url, detail: image.detail || 'high' } };
}

function extractImagePartUrl(part: MessageContent): { url: string; detail?: string } {
  if (typeof part.image_url === 'string') return { url: part.image_url };
  if (part.image_url?.url) return { url: part.image_url.url, detail: part.image_url.detail };
  if (part.input_image?.image_url) return { url: part.input_image.image_url, detail: part.input_image.detail };
  if (part.input_image?.url) return { url: part.input_image.url, detail: part.input_image.detail };
  if (part.image) return { url: part.image };
  return { url: '' };
}

/** 完整的POST调用，含视觉模式自动重试和续写 */
export async function postLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, label: string = 'chat'): Promise<string> {
  const maxContinuationRounds = 3;
  let currentMessages = messages;
  let combined = '';

  for (let round = 0; round <= maxContinuationRounds; round++) {
    const result = await postLLMOnce(config, currentMessages, useVision, round === 0 ? label : `${label}:continue${round}`);
    combined = appendContinuation(combined, result.content);
    const needContinue = isLengthLimitedFinish(result.finishReason) || looksTruncated(combined);
    if (!needContinue) break;
    if (round >= maxContinuationRounds) break;
    currentMessages = buildContinuationMessages(messages, combined);
  }

  return combined.trim();
}

/** 视觉模式自动尝试多种payload */
export async function callLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false): Promise<string> {
  if (!useVision) return postLLM(config, messages, false);
  const variants = buildVisionMessageVariants(messages, config.vision_payload_mode || 'auto');
  let lastError: Error | null = null;
  for (const variant of variants) {
    try {
      return await postLLM(config, variant.messages, true, `vision:${variant.label}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (config.vision_payload_mode && config.vision_payload_mode !== 'auto') break;
    }
  }
  throw lastError || new Error('视觉模型调用失败');
}

/** 带重试的调用 */
export async function callLLMWithRetry(
  config: AIConfig,
  messages: ChatMessage[],
  useVision: boolean = false,
  maxAttempts: number = 3,
  caller: LLMCaller = callLLM,
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await caller(config, messages, useVision);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts - 1) await delay(1000 * (attempt + 1));
    }
  }
  throw lastError;
}
