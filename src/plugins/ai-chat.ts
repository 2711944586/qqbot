import { Plugin, AIConfig, GroupMessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { webSearch } from './web-search';
import { generateVoice } from './tts';
import { getImageDataUrl } from './image-cache';
import { loadContext, writeSession, deleteSession, markDirty, setFlushHandler, getDirtySessions, listAllSessions } from './context-store';
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

interface SessionContext {
  summary: string;
  /** 纯文字消息（不含图片DataURL，节省内存） */
  messages: ChatMessage[];
  lastActiveTime: number;
}

// ============ 上下文管理器（内存+磁盘双层） ============
class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private softLimit: number;
  private hardLimit: number;
  private keepRecent: number;
  private expireMs: number;

  constructor(maxMessages: number, expireMinutes: number) {
    this.softLimit = Math.floor(maxMessages * 0.8);
    this.hardLimit = maxMessages;
    this.keepRecent = Math.floor(maxMessages * 0.4);
    this.expireMs = expireMinutes * 60 * 1000;

    // 启动时从磁盘恢复会话索引（按需加载，不一次性载入所有）
    this.loadOnStartup();

    // 注册批量写盘
    setFlushHandler(() => this.flushDirtyToDisk());

    // 定时清理过期 + 内存压缩
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** 启动时只加载ID列表，不加载内容（按需加载省内存） */
  private loadOnStartup(): void {
    const ids = listAllSessions();
    console.log(`[Context] 磁盘有${ids.length}个历史会话(按需加载)`);
  }

  getSession(sessionId: string): SessionContext {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // 内存没有，从磁盘加载
      const stored = loadContext(sessionId);
      if (stored && Date.now() - stored.lastActiveTime <= this.expireMs) {
        session = {
          summary: stored.summary,
          messages: stored.messages.map(m => ({ role: m.role, content: m.content })),
          lastActiveTime: stored.lastActiveTime,
        };
      } else {
        session = { summary: '', messages: [], lastActiveTime: Date.now() };
      }
      this.sessions.set(sessionId, session);
    } else if (Date.now() - session.lastActiveTime > this.expireMs) {
      // 过期重置
      session = { summary: '', messages: [], lastActiveTime: Date.now() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** 只追加 不修改顺序 */
  appendMessage(sessionId: string, message: ChatMessage): void {
    const session = this.getSession(sessionId);
    // 确保存储的是纯字符串内容（不存图片DataURL）
    const stored: ChatMessage = {
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.filter(c => c.type === 'text').map(c => c.text || '').join(' '),
    };
    session.messages.push(stored);
    session.lastActiveTime = Date.now();
    markDirty(sessionId);
  }

  needsCompression(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.messages.length >= this.softLimit;
  }

  applyCompression(sessionId: string, newSummary: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.summary = session.summary
      ? session.summary + '\n' + newSummary
      : newSummary;
    if (session.messages.length > this.keepRecent) {
      session.messages = session.messages.slice(-this.keepRecent);
    }
    markDirty(sessionId);
  }

  getOldMessagesToCompress(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const cutoff = session.messages.length - this.keepRecent;
    return cutoff > 0 ? session.messages.slice(0, cutoff) : [];
  }

  getFullContext(sessionId: string): { summary: string; messages: ChatMessage[] } {
    const session = this.getSession(sessionId);
    return { summary: session.summary, messages: session.messages };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    deleteSession(sessionId);
  }

  /** 批量将脏会话写盘 */
  private flushDirtyToDisk(): void {
    const dirty = getDirtySessions();
    for (const id of dirty) {
      const session = this.sessions.get(id);
      if (session) {
        writeSession(id, {
          summary: session.summary,
          messages: session.messages.map(m => ({
            role: m.role as any,
            content: typeof m.content === 'string' ? m.content : '',
          })),
          lastActiveTime: session.lastActiveTime,
        });
      }
    }
  }

  /** 定时清理：内存中过期的踢出（仍保留磁盘） */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // 30分钟没活跃就从内存里清出去（释放内存，磁盘还在）
      if (now - session.lastActiveTime > 30 * 60 * 1000) {
        this.sessions.delete(id);
      }
    }
    // 触发GC
    if (global.gc) global.gc();
  }
}

// ============ 工具函数 ============
function extractImageUrls(message: MessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'image')
    .map((seg) => seg.type === 'image' ? (seg.data.url || seg.data.file || '') : '')
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
            reject(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }
          const content = json.choices?.[0]?.message?.content;
          if (content) resolve(content.trim());
          else reject(new Error('无内容返回'));
        } catch {
          reject(new Error('解析失败'));
        }
      });
    });

    req.on('error', (err) => reject(new Error('网络: ' + err.message)));
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
async function summarizeMessages(config: AIConfig, oldMessages: ChatMessage[]): Promise<string> {
  const lines = oldMessages.map(m => {
    const text = typeof m.content === 'string' ? m.content : '';
    return m.role === 'user' ? text : `[我回复] ${text}`;
  });
  const conversation = lines.join('\n');

  const prompt: ChatMessage[] = [
    { role: 'system', content: '把下面这段QQ群对话压缩成一段不超过300字的摘要。保留主要话题、关键人物、重要观点。直接输出摘要，不加标题。' },
    { role: 'user', content: conversation },
  ];

  try {
    return await callLLM(config, prompt, false);
  } catch {
    return `[较早的对话片段，共${oldMessages.length}条]`;
  }
}

// ============ 构建发送给API的消息（KV cache友好）============
/**
 * 关键设计：
 * 1. system_prompt 永远不变（来自config，KV cache可复用）
 * 2. summary 作为一条固定的system消息（变化频率低，cache较稳定）
 * 3. history按事件顺序追加，不修改前面的内容
 * 4. 当前消息在最后追加（含图片时为多模态）
 * 5. 动态信息（如搜索结果）作为最后一条user附加，不污染前缀
 */
function buildApiMessages(
  systemPrompt: string,
  summary: string,
  history: ChatMessage[],
  currentMessage: ChatMessage,
  searchInfo?: string,
): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (summary) {
    result.push({ role: 'system', content: `[历史摘要]\n${summary}` });
  }

  result.push(...history);

  // 当前消息：如果有搜索信息，作为context追加在文本前
  if (searchInfo) {
    if (typeof currentMessage.content === 'string') {
      result.push({
        role: 'user',
        content: `[实时参考: ${searchInfo}]\n${currentMessage.content}`,
      });
    } else {
      // 多模态：在text part前加上搜索信息
      const newContent: MessageContent[] = [
        { type: 'text', text: `[实时参考: ${searchInfo}]` },
        ...currentMessage.content,
      ];
      result.push({ role: 'user', content: newContent });
    }
  } else {
    result.push(currentMessage);
  }

  return result;
}

function buildSystemPrompt(config: AIConfig): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  return preset?.system_prompt || '你是QQ群里的网友「玩机器」。';
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
    ctx.reply('没这个');
    return true;
  }
  config.active_preset = presetName;
  ctx.reply(`切到${config.presets[presetName].name}了`);
  return true;
}

// ============ 单例 ============
let contextManager: ContextManager | null = null;

function getContextManager(config: AIConfig): ContextManager {
  if (!contextManager) {
    contextManager = new ContextManager(
      config.max_context_messages || 50,
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
        .map(([k, p]) => `${k === config.active_preset ? '>' : ' '} ${k} - ${p.description}`)
        .join('\n');
      ctx.reply(`预设:\n${list}\n\n/preset <名称> 切换`);
      return true;
    }

    // ===== 提取信息 =====
    const senderName = ctx.event.sender.card || ctx.event.sender.nickname;
    const imageUrls = extractImageUrls(ctx.event.message);
    const hasImages = imageUrls.length > 0 && config.enable_vision;

    // 构建当前消息（双版本：API版含图，存储版纯文字）
    let apiCurrentMessage: ChatMessage;
    let storedText: string;
    const textPart = ctx.rawText.trim()
      ? `${senderName}: ${ctx.rawText.trim()}`
      : `${senderName}: [图片]`;

    if (hasImages) {
      // 限制最多2张图，串行下载（节省内存）
      const limitedUrls = imageUrls.slice(0, 2);
      const dataUrls: string[] = [];
      for (const url of limitedUrls) {
        const d = await getImageDataUrl(url);
        if (d) dataUrls.push(d);
      }

      if (dataUrls.length > 0) {
        const parts: MessageContent[] = [{ type: 'text', text: textPart }];
        for (const dataUrl of dataUrls) {
          parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'low' } });
        }
        apiCurrentMessage = { role: 'user', content: parts };
        storedText = `${textPart} (含${dataUrls.length}张图)`;
      } else {
        apiCurrentMessage = { role: 'user', content: textPart };
        storedText = `${textPart} (图片加载失败)`;
      }
    } else {
      const text = `${senderName}: ${ctx.rawText || '[表情]'}`;
      apiCurrentMessage = { role: 'user', content: text };
      storedText = text;
    }

    // 追加纯文字版到上下文（KV cache友好：不在前缀加图片）
    cm.appendMessage(sessionId, { role: 'user', content: storedText });

    // 检查压缩（异步，不阻塞）
    if (cm.needsCompression(sessionId)) {
      const oldMessages = cm.getOldMessagesToCompress(sessionId);
      if (oldMessages.length > 0) {
        summarizeMessages(config, oldMessages)
          .then(summary => {
            if (summary) {
              cm.applyCompression(sessionId, summary);
              console.log(`[Context] 群${ctx.event.group_id} 压缩${oldMessages.length}条`);
            }
          })
          .catch(() => {});
      }
    }

    // ===== 联网搜索（按需 不阻塞）=====
    let searchInfo = '';
    const needSearch = /最新|最近|现在|今天|谁赢|比分|赛程|更新|版本|发布|新闻|热搜|多少钱|价格|天气/.test(ctx.rawText);
    if (needSearch && ctx.rawText.length > 3) {
      try {
        const searchPromise = webSearch(ctx.rawText);
        const timeoutPromise = new Promise<string>((r) => setTimeout(() => r(''), 1500));
        const result = await Promise.race([searchPromise, timeoutPromise]);
        if (result) searchInfo = result.slice(0, 200);
      } catch { /* */ }
    }

    // ===== 构建发给API的消息 =====
    // 注意：history是除当前消息外的历史（当前已经append了，需要排除最后一条）
    const { summary, messages: allHistory } = cm.getFullContext(sessionId);
    const history = allHistory.slice(0, -1); // 排除刚刚追加的当前消息纯文字版
    const systemPrompt = buildSystemPrompt(config);

    const apiMessages = buildApiMessages(systemPrompt, summary, history, apiCurrentMessage, searchInfo);

    // ===== 调用 AI =====
    try {
      const reply = await callLLMWithRetry(config, apiMessages, hasImages);
      const cleaned = postProcessReply(reply);

      if (!cleaned) return true;

      // 追加AI回复
      cm.appendMessage(sessionId, { role: 'assistant', content: cleaned });

      // 发送
      const useQuote = ctx.isReplyToBot || isAtBot(ctx.event) || Math.random() < 0.2;

      // 一定概率TTS
      let sentVoice = false;
      if (config.enable_tts && cleaned.length >= 4 && cleaned.length <= 100 && Math.random() < (config.tts_probability || 0.15)) {
        try {
          const voicePath = await generateVoice(config, cleaned);
          if (voicePath) {
            ctx.reply([{ type: 'record', data: { file: `file://${voicePath}` } }]);
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
