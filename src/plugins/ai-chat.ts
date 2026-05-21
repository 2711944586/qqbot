import { Plugin, AIConfig, GroupMessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { webSearch } from './web-search';
import { generateVoice } from './tts';
import * as https from 'https';
import * as http from 'http';

// ============ 类型 ============
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContent[];
}

interface MessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

/** 会话上下文 - 稳定前缀 + 增量后缀架构 */
interface SessionContext {
  /** 已压缩的历史摘要（稳定，不变） */
  summary: string;
  /** 增量消息（只追加，不修改顺序） */
  messages: ChatMessage[];
  lastActiveTime: number;
}

// ============ 上下文管理器 ============
/**
 * 设计原则：
 * 1. 只追加(append-only) - 新消息push到末尾，不删除不修改前面的
 * 2. 接近上限时压缩前N条为摘要，摘要替代原消息保留信息
 * 3. 摘要+剩余消息组成稳定前缀，KV cache可复用
 */
class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  /** 软上限：到这个数开始考虑压缩 */
  private softLimit: number;
  /** 硬上限：必须压缩 */
  private hardLimit: number;
  /** 压缩时保留最近多少条 */
  private keepRecent: number;
  private expireMs: number;

  constructor(maxMessages: number, expireMinutes: number) {
    this.softLimit = Math.floor(maxMessages * 0.8);  // 80%开始压缩
    this.hardLimit = maxMessages;
    this.keepRecent = Math.floor(maxMessages * 0.4); // 压缩后保留40%
    this.expireMs = expireMinutes * 60 * 1000;
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  getSession(sessionId: string): SessionContext {
    let session = this.sessions.get(sessionId);
    if (!session || Date.now() - session.lastActiveTime > this.expireMs) {
      session = {
        summary: '',
        messages: [],
        lastActiveTime: Date.now(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** 只追加新消息到末尾 */
  appendMessage(sessionId: string, message: ChatMessage): void {
    const session = this.getSession(sessionId);
    session.messages.push(message);
    session.lastActiveTime = Date.now();
  }

  /** 检查是否需要压缩 */
  needsCompression(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.messages.length >= this.softLimit;
  }

  /** 必须压缩（达到硬上限） */
  mustCompress(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.messages.length >= this.hardLimit;
  }

  /** 应用压缩：把前面的旧消息合并为摘要 */
  applyCompression(sessionId: string, newSummary: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 把旧摘要+新摘要合并
    if (session.summary) {
      session.summary = session.summary + '\n' + newSummary;
    } else {
      session.summary = newSummary;
    }

    // 只保留最近的keepRecent条
    if (session.messages.length > this.keepRecent) {
      session.messages = session.messages.slice(-this.keepRecent);
    }
  }

  /** 获取摘要+所有消息（用于发给API） */
  getFullContext(sessionId: string): { summary: string; messages: ChatMessage[] } {
    const session = this.getSession(sessionId);
    return { summary: session.summary, messages: session.messages };
  }

  /** 获取需要被压缩的旧消息（前 N 条） */
  getOldMessagesToCompress(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const cutoff = session.messages.length - this.keepRecent;
    return cutoff > 0 ? session.messages.slice(0, cutoff) : [];
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveTime > this.expireMs) {
        this.sessions.delete(id);
      }
    }
  }
}

// ============ 图片下载与编码 ============
/** 下载图片URL转换为base64 DataURL，让API真正能看到图 */
function fetchImageAsDataUrl(imageUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }
    // 已经是dataurl就直接返回
    if (imageUrl.startsWith('data:')) {
      resolve(imageUrl);
      return;
    }
    if (!imageUrl.startsWith('http')) {
      resolve(null);
      return;
    }

    try {
      const url = new URL(imageUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.get({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        const MAX_SIZE = 5 * 1024 * 1024; // 最大5MB

        res.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_SIZE) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            // 检测mime类型
            let mime = 'image/jpeg';
            const contentType = res.headers['content-type'];
            if (contentType && contentType.startsWith('image/')) {
              mime = contentType.split(';')[0];
            } else {
              // 通过文件头判断
              if (buffer[0] === 0x89 && buffer[1] === 0x50) mime = 'image/png';
              else if (buffer[0] === 0x47 && buffer[1] === 0x49) mime = 'image/gif';
              else if (buffer[0] === 0xFF && buffer[1] === 0xD8) mime = 'image/jpeg';
              else if (buffer[0] === 0x52 && buffer[1] === 0x49) mime = 'image/webp';
            }
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
            resolve(dataUrl);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

/** 提取消息中的图片URL */
function extractImageUrls(message: MessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'image')
    .map((seg) => {
      if (seg.type === 'image') return seg.data.url || seg.data.file || '';
      return '';
    })
    .filter(Boolean);
}

function isAtBot(event: GroupMessageEvent): boolean {
  return event.message.some(
    (seg) => seg.type === 'at' && seg.data.qq === String(event.self_id)
  );
}

// ============ LLM API 调用 ============
function callLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.api_url);
    const isHttps = url.protocol === 'https:';
    const model = useVision ? (config.vision_model || config.model) : config.model;

    const requestBody: any = {
      model,
      messages,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      stream: false,
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

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.error('[AI] API错误:', JSON.stringify(json.error));
            reject(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }
          const content = json.choices?.[0]?.message?.content;
          if (content) {
            resolve(content.trim());
          } else {
            console.error('[AI] 无内容:', data.slice(0, 500));
            reject(new Error('无内容返回'));
          }
        } catch {
          console.error('[AI] 解析失败:', data.slice(0, 500));
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', (err) => reject(new Error('网络错误: ' + err.message)));
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('超时')); });
    req.write(body);
    req.end();
  });
}

async function callLLMWithRetry(config: AIConfig, messages: ChatMessage[], useVision: boolean = false): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callLLM(config, messages, useVision);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ============ 上下文压缩 ============
/** 调用LLM将一批旧消息压缩成一段简短摘要 */
async function summarizeMessages(config: AIConfig, oldMessages: ChatMessage[]): Promise<string> {
  // 先把旧消息转成纯文本（去掉图片，简化）
  const plain: string[] = [];
  for (const msg of oldMessages) {
    let text: string;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else {
      // 多模态消息只取文本部分
      text = msg.content.filter(c => c.type === 'text').map(c => c.text || '').join(' ');
      if (msg.content.some(c => c.type === 'image_url')) {
        text += ' [发了图]';
      }
    }
    if (msg.role === 'user') {
      plain.push(text);
    } else {
      plain.push(`[我回复] ${text}`);
    }
  }
  const conversation = plain.join('\n');

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: '你的任务是把下面这段QQ群对话压缩成一段不超过300字的摘要。要保留：聊过的主要话题、关键人物、重要观点和事件。用第三人称叙述。直接输出摘要内容，不要加标题或前缀。'
    },
    { role: 'user', content: conversation }
  ];

  try {
    const summary = await callLLM(config, summaryPrompt, false);
    return summary;
  } catch {
    // 压缩失败则简单截取
    return `[较早的群聊片段，共${oldMessages.length}条消息]`;
  }
}

// ============ 构建发送给API的消息 ============
/**
 * 构建稳定前缀架构的messages：
 * [system_prompt] (永远在最前)
 * [history_summary] (作为额外system消息，仅在有摘要时存在)
 * [m1, m2, m3, ...] (顺序稳定，只追加不修改)
 */
function buildApiMessages(
  systemPrompt: string,
  summary: string,
  history: ChatMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [
    { role: 'system', content: systemPrompt }
  ];

  if (summary) {
    result.push({
      role: 'system',
      content: `[早前对话摘要 仅供参考记忆]\n${summary}`,
    });
  }

  // history直接拼接，保持事件顺序，不修改
  result.push(...history);

  return result;
}

function buildSystemPrompt(config: AIConfig): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  return preset?.system_prompt || '你是QQ群里的网友「玩机器」。正常聊天就行。';
}

// ============ 后处理 ============
function postProcessReply(text: string): string {
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim());
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/#{1,6}\s/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^(玩机器|机器|MachineWJQ)[：:]\s*/i, '');
  text = text.replace(/^["「『](.+)["」』]$/s, '$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^ +/gm, '');
  return text.trim();
}

function handlePresetCommand(
  ctx: { args: string[]; reply: (msg: string) => void; bot: Bot },
  config: AIConfig
): boolean {
  const presetName = ctx.args[0];
  if (!presetName) {
    ctx.reply('/preset <名称>\n/presets 看列表');
    return true;
  }
  if (!config.presets[presetName]) {
    ctx.reply(`没这个 用 /presets 看看`);
    return true;
  }
  config.active_preset = presetName;
  const preset = config.presets[presetName];
  ctx.reply(`切到${preset.name}了`);
  return true;
}

// ============ 插件实例 ============
let contextManager: ContextManager | null = null;

function getContextManager(config: AIConfig): ContextManager {
  if (!contextManager) {
    contextManager = new ContextManager(
      config.max_context_messages || 100,
      config.context_expire_minutes || 120
    );
  }
  return contextManager;
}

export const aiChatPlugin: Plugin = {
  name: 'ai-chat',
  description: 'AI 智能对话 - 玩机器核心',

  handler: async (ctx) => {
    const config = ctx.bot.getConfig().ai;
    if (!config || !config.api_key) return false;

    const cm = getContextManager(config);
    const sessionId = `group_${ctx.event.group_id}`;

    // ===== 管理命令 =====
    if (ctx.command === 'reset' || ctx.command === 'clear') {
      cm.clearSession(sessionId);
      ctx.reply('行 清了');
      return true;
    }
    if (ctx.command === 'preset') {
      return handlePresetCommand(ctx, config);
    }
    if (ctx.command === 'presets') {
      const list = Object.entries(config.presets)
        .map(([key, p]) => `${key === config.active_preset ? '>' : ' '} ${key} - ${p.description}`)
        .join('\n');
      ctx.reply(`预设:\n${list}\n\n/preset <名称> 切换`);
      return true;
    }

    // ===== 提取信息 =====
    const senderName = ctx.event.sender.card || ctx.event.sender.nickname;
    const imageUrls = extractImageUrls(ctx.event.message);
    const hasImages = imageUrls.length > 0 && config.enable_vision;

    // ===== 构建当前消息（含图片下载为DataURL）=====
    let currentContent: string | MessageContent[];
    if (hasImages) {
      // 下载图片转dataurl
      const parts: MessageContent[] = [];
      const textPart = ctx.rawText.trim()
        ? `${senderName}: ${ctx.rawText.trim()}`
        : `${senderName}: [发了图片]`;
      parts.push({ type: 'text', text: textPart });

      // 并发下载所有图片
      const dataUrls = await Promise.all(imageUrls.map(url => fetchImageAsDataUrl(url)));
      for (const dataUrl of dataUrls) {
        if (dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
        }
      }
      currentContent = parts;
    } else {
      currentContent = `${senderName}: ${ctx.rawText || '[表情/贴纸]'}`;
    }

    // ===== 追加到上下文（只追加不修改）=====
    cm.appendMessage(sessionId, { role: 'user', content: currentContent });

    // ===== 检查是否需要压缩历史 =====
    if (cm.needsCompression(sessionId)) {
      const oldMessages = cm.getOldMessagesToCompress(sessionId);
      if (oldMessages.length > 0) {
        // 异步压缩，不阻塞当前回复
        summarizeMessages(config, oldMessages).then(summary => {
          if (summary) {
            cm.applyCompression(sessionId, summary);
            console.log(`[Context] 群${ctx.event.group_id} 压缩了${oldMessages.length}条消息`);
          }
        }).catch(() => {});
      }
    }

    // ===== 联网搜索（按需）=====
    let searchInfo = '';
    const needSearch = /最新|最近|现在|今天|谁赢|比分|赛程|更新|版本|发布|新闻|热搜|多少钱|价格|天气/.test(ctx.rawText);
    if (needSearch && ctx.rawText.length > 3) {
      try {
        const searchPromise = webSearch(ctx.rawText);
        const timeoutPromise = new Promise<string>((r) => setTimeout(() => r(''), 2000));
        const result = await Promise.race([searchPromise, timeoutPromise]);
        if (result) searchInfo = result.slice(0, 300);
      } catch { /* */ }
    }

    // ===== 构建发给API的消息 =====
    const { summary, messages: history } = cm.getFullContext(sessionId);
    let systemPrompt = buildSystemPrompt(config);
    if (searchInfo) {
      systemPrompt += `\n\n[实时参考信息]\n${searchInfo}`;
    }

    const apiMessages = buildApiMessages(systemPrompt, summary, history);

    // ===== 调用 AI =====
    try {
      const reply = await callLLMWithRetry(config, apiMessages, hasImages);
      const cleaned = postProcessReply(reply);

      if (!cleaned) return true;

      // 追加AI回复到上下文（只追加）
      cm.appendMessage(sessionId, { role: 'assistant', content: cleaned });

      // 发送回复
      const useQuote = ctx.isReplyToBot || isAtBot(ctx.event) || Math.random() < 0.2;

      // 一定概率发语音
      let sentVoice = false;
      if (config.enable_tts && cleaned.length >= 4 && cleaned.length <= 100 && Math.random() < (config.tts_probability || 0.15)) {
        try {
          const voicePath = await generateVoice(config, cleaned);
          if (voicePath) {
            const voiceMsg: MessageSegment[] = [
              { type: 'record', data: { file: `file://${voicePath}` } },
            ];
            ctx.reply(voiceMsg);
            sentVoice = true;
          }
        } catch { /* */ }
      }

      if (!sentVoice) {
        if (useQuote && cleaned.length <= 200) {
          ctx.replyQuote(cleaned);
        } else {
          ctx.reply(cleaned);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AI][群${ctx.event.group_id}] 失败:`, errMsg);
    }

    return true;
  },
};
