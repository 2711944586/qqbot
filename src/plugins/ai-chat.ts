import { Plugin, AIConfig, GroupMessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { webSearch, shouldSearch } from './web-search';
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
  messages: ChatMessage[];
  lastActiveTime: number;
  recentCount: number;
  lastCountReset: number;
  silentCount: number;
  /** 记住群友的特征 */
  userTraits: Map<string, string[]>;
  /** 最近bot被提及的次数（用于判断是否被针对） */
  mentionCount: number;
  lastMentionReset: number;
}

// ============ 上下文管理器 ============
class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private maxMessages: number;
  private expireMs: number;

  constructor(maxMessages: number, expireMinutes: number) {
    this.maxMessages = maxMessages;
    this.expireMs = expireMinutes * 60 * 1000;
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  getSession(sessionId: string): SessionContext | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.lastActiveTime > this.expireMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  getMessages(sessionId: string): ChatMessage[] {
    const session = this.getSession(sessionId);
    return session?.messages || [];
  }

  addMessage(sessionId: string, message: ChatMessage): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        messages: [],
        lastActiveTime: Date.now(),
        recentCount: 0,
        lastCountReset: Date.now(),
        silentCount: 0,
        userTraits: new Map(),
        mentionCount: 0,
        lastMentionReset: Date.now(),
      });
    }
    const session = this.sessions.get(sessionId)!;
    session.messages.push(message);
    session.lastActiveTime = Date.now();
    session.recentCount++;

    if (message.role === 'user') {
      session.silentCount++;
    } else if (message.role === 'assistant') {
      session.silentCount = 0;
    }

    // 5分钟重置活跃计数
    if (Date.now() - session.lastCountReset > 5 * 60 * 1000) {
      session.recentCount = 0;
      session.lastCountReset = Date.now();
    }

    // 2分钟重置被提及计数
    if (Date.now() - session.lastMentionReset > 2 * 60 * 1000) {
      session.mentionCount = 0;
      session.lastMentionReset = Date.now();
    }

    // 保留最大消息数
    if (session.messages.length > this.maxMessages) {
      session.messages.splice(0, session.messages.length - this.maxMessages);
    }
  }

  /** 增加被提及计数 */
  addMention(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) session.mentionCount++;
  }

  getMentionCount(sessionId: string): number {
    return this.getSession(sessionId)?.mentionCount || 0;
  }

  getRecentActivity(sessionId: string): number {
    return this.getSession(sessionId)?.recentCount || 0;
  }

  getSilentCount(sessionId: string): number {
    return this.getSession(sessionId)?.silentCount || 0;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
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

// ============ 冷却管理 ============
class CooldownManager {
  private lastReply: Map<string, number> = new Map();
  private consecutiveReplies: Map<string, number> = new Map();

  canReply(groupId: number, cooldownSeconds: number): boolean {
    const key = String(groupId);
    const last = this.lastReply.get(key) || 0;
    const elapsed = Date.now() - last;

    if (elapsed < cooldownSeconds * 1000) return false;

    // 连续回复10次后才限制（给足空间）
    const consecutive = this.consecutiveReplies.get(key) || 0;
    if (consecutive >= 10) {
      if (elapsed < cooldownSeconds * 3000) return false;
      this.consecutiveReplies.set(key, 0);
    }

    return true;
  }

  markReply(groupId: number): void {
    const key = String(groupId);
    const last = this.lastReply.get(key) || 0;
    if (Date.now() - last < 30000) {
      this.consecutiveReplies.set(key, (this.consecutiveReplies.get(key) || 0) + 1);
    } else {
      this.consecutiveReplies.set(key, 1);
    }
    this.lastReply.set(key, Date.now());
  }
}

// ============ 话题/情绪分析 ============
interface MessageAnalysis {
  isQuestion: boolean;
  hasEmotion: boolean;
  isControversial: boolean;
  isGaming: boolean;
  isMeme: boolean;
  isGreeting: boolean;
  isComplaint: boolean;
  isSharingContent: boolean;
  textLength: number;
}

function analyzeMessage(text: string): MessageAnalysis {
  const lower = text.toLowerCase();
  return {
    isQuestion: /[?？]|吗$|呢$|什么|怎么|为什么|如何|谁[^都]|哪[个里个]|多少|几[点个时]|有没有|是不是|能不能|会不会/.test(text),
    hasEmotion: /[!！]{2,}|草|卧槽|我[去靠擦]|牛[逼b]|nb|6{2,}|哈{3,}|笑死|绷|离谱|逆天|震惊|麻了|蚌埠|无语|裂开|崩溃|要死|救命|吐了|服了|疯了|炸了/.test(lower),
    isControversial: /最强|最好|最垃|不如|吊打|碾压|秒杀|vs|比较|谁强|哪个好|争议|输麻|赢麻|黑子|粉丝|饭圈/.test(lower),
    isGaming: /cs[2go]|csgo|英雄联盟|lol|王者|原神|steam|游戏|rank|排位|上分|段位|大乱斗|fps|开黑|mvp|ace|clutch|valorant|瓦|apex|吃鸡|pubg|翻盘|carry|gank|团战|五杀|超神|连跪/.test(lower),
    isMeme: /典|绷|乐了|属于是|这波|什么档次|格局|有没有一种可能|我不理解|但是尊重|啊这|好好好|真的会谢|你说得对|我直接|确实|蚌|急了|破防|DNA动了|泪目|暖心|老婆|wc|xdm|家人们/.test(lower),
    isGreeting: /^(早|晚安|睡了|在吗|有人吗|冒泡|签到|打卡|起床|下班|摸鱼)/.test(lower),
    isComplaint: /烦死|累死|不想|受不了|想辞职|上班|加班|考试|论文|ddl|deadline|心累|emo|难受|郁闷|焦虑/.test(lower),
    isSharingContent: /分享|推荐|安利|看这个|你们看|兄弟们看|发现一个|刚看到/.test(lower),
    textLength: text.length,
  };
}

// ============ 消息合并（解决连续同角色问题）============
/** 
 * 合并连续的同角色消息 
 * 很多API不允许连续多个user消息，需要合并成一条
 */
function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const merged: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const current = messages[i];

    // system消息直接保留
    if (current.role === 'system') {
      merged.push(current);
      i++;
      continue;
    }

    // 找到连续相同角色的消息
    let j = i + 1;
    while (j < messages.length && messages[j].role === current.role) {
      j++;
    }

    if (j === i + 1) {
      // 只有一条，直接保留原始格式
      merged.push(current);
    } else {
      // 多条相同角色：检查是否有多模态内容
      const hasMultimodal = messages.slice(i, j).some(m => Array.isArray(m.content));
      
      if (hasMultimodal) {
        // 如果包含多模态内容，合并为一个数组
        const parts: MessageContent[] = [];
        for (let k = i; k < j; k++) {
          const content = messages[k].content;
          if (Array.isArray(content)) {
            parts.push(...content);
          } else {
            parts.push({ type: 'text', text: content });
          }
        }
        merged.push({ role: current.role, content: parts });
      } else {
        // 纯文本合并
        const texts: string[] = [];
        for (let k = i; k < j; k++) {
          texts.push(messages[k].content as string);
        }
        merged.push({ role: current.role, content: texts.join('\n') });
      }
    }

    i = j;
  }

  return merged;
}

/** 将消息内容统一转为字符串 */
function stringifyContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  // 多模态内容：提取文本部分，图片转为描述
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      parts.push(item.text);
    } else if (item.type === 'image_url' && item.image_url) {
      parts.push('[图片]');
    }
  }
  return parts.join(' ');
}

/** 构建适合发送给API的消息（保留vision格式） */
function buildApiMessages(messages: ChatMessage[], hasVision: boolean): ChatMessage[] {
  if (!hasVision) {
    return mergeConsecutiveMessages(messages);
  }

  // 有图片时：找到最后一条包含image_url的消息保留原始格式
  const result: ChatMessage[] = [];
  let lastVisionIdx = -1;

  // 找最后一条含有图片的消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (Array.isArray(content) && content.some(c => c.type === 'image_url')) {
      lastVisionIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (i === lastVisionIdx) {
      // 保留多模态格式
      result.push(messages[i]);
    } else {
      result.push({
        role: messages[i].role,
        content: stringifyContent(messages[i].content),
      });
    }
  }

  return mergeConsecutiveMessages(result);
}

// ============ LLM API 调用（带重试）============
async function callLLMWithRetry(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, maxRetries: number = 2): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(config, messages, useVision);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        // 等一下再重试
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// ============ LLM API 调用 ============
function callLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.api_url);
    const isHttps = url.protocol === 'https:';
    const model = useVision ? (config.vision_model || config.model) : config.model;

    // 合并连续的同角色消息（有些API不允许连续相同role）
    const mergedMessages = buildApiMessages(messages, useVision);

    const requestBody: any = {
      model,
      messages: mergedMessages,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
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
            console.error('[AI] 无内容返回:', data.slice(0, 800));
            reject(new Error('API 返回无内容'));
          }
        } catch {
          console.error('[AI] 解析失败:', data.slice(0, 800));
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', (err) => reject(new Error('网络错误: ' + err.message)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('请求超时(60s)')); });
    req.write(body);
    req.end();
  });
}

// ============ 工具函数 ============

function buildSystemPrompt(config: AIConfig, groupId: number, extraContext: string = ''): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  if (!preset) return '你是QQ群里的网友「玩机器」。正常聊天就行。';

  let prompt = preset.system_prompt;

  if (extraContext) {
    prompt += '\n' + extraContext;
  }

  return prompt;
}

/** 从消息中提取图片URL */
function extractImageUrls(message: MessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'image')
    .map((seg) => {
      if (seg.type === 'image') return seg.data.url || seg.data.file || '';
      return '';
    })
    .filter(Boolean);
}

/** 检测是否@了bot */
function isAtBot(event: GroupMessageEvent): boolean {
  return event.message.some(
    (seg) => seg.type === 'at' && seg.data.qq === String(event.self_id)
  );
}

/** 智能触发判断 — 核心逻辑 */
function shouldSmartTrigger(
  rawText: string,
  config: AIConfig,
  recentActivity: number,
  silentCount: number,
  mentionCount: number,
): boolean {
  const text = rawText.toLowerCase();
  const analysis = analyzeMessage(rawText);

  // === 极短消息：单字不回，2字低概率 ===
  if (analysis.textLength <= 1 && !analysis.isMeme) return false;
  if (analysis.textLength <= 2 && !analysis.isMeme && !analysis.hasEmotion) {
    return Math.random() < 0.08;
  }

  // === 直接关键词/名字 → 必触发 ===
  if (config.trigger_keywords?.some((kw) => text.includes(kw.toLowerCase()))) {
    return true;
  }
  if (/玩机器|机器哥|机器兄|wjq/.test(text)) return true;

  // === 群讨论激烈时（活跃度高）大幅提升回复率 ===
  const activityMultiplier = recentActivity > 10 ? 1.8 : recentActivity > 5 ? 1.4 : 1.0;
  const mentionBonus = mentionCount > 2 ? 0.25 : 0;
  const baseProbability = config.trigger_probability * activityMultiplier;

  // === 分类触发 ===
  if (analysis.isGaming) {
    return Math.random() < Math.min(baseProbability * 2.5 + mentionBonus, 0.95);
  }
  if (analysis.isControversial) {
    return Math.random() < Math.min(baseProbability * 2.0 + mentionBonus, 0.9);
  }
  if (analysis.isMeme) {
    return Math.random() < Math.min(baseProbability * 1.8 + mentionBonus, 0.85);
  }
  if (analysis.isSharingContent) {
    return Math.random() < Math.min(baseProbability * 1.6, 0.8);
  }
  if (analysis.isQuestion) {
    return Math.random() < Math.min(baseProbability * 1.5, 0.8);
  }
  if (analysis.hasEmotion) {
    return Math.random() < Math.min(baseProbability * 1.4, 0.75);
  }
  if (analysis.isComplaint) {
    return Math.random() < Math.min(baseProbability * 1.3, 0.7);
  }
  if (analysis.isGreeting) {
    return Math.random() < Math.min(baseProbability * 1.2, 0.7);
  }

  // === 沉默主动说话（更积极）===
  if (silentCount >= 10) return Math.random() < 0.5;
  if (silentCount >= 6) return Math.random() < 0.3;
  if (silentCount >= 4) return Math.random() < 0.15;

  // === 长消息加成 ===
  const lengthBonus = analysis.textLength > 30 ? 0.1 : analysis.textLength > 15 ? 0.05 : 0;

  return Math.random() < (baseProbability + lengthBonus + mentionBonus);
}

// ============ 插件实例 ============
let contextManager: ContextManager | null = null;
const cooldownManager = new CooldownManager();

/** 每群并发锁：防止同一个群同时发多个API请求（不同群可以并行） */
const groupLocks: Map<number, number> = new Map(); // 存时间戳而不是boolean

/** 检查群锁（带超时自动释放，防止卡死） */
function isGroupLocked(groupId: number): boolean {
  const lockTime = groupLocks.get(groupId);
  if (!lockTime) return false;
  // 超过30秒自动释放（防止异常卡死）
  if (Date.now() - lockTime > 30000) {
    groupLocks.delete(groupId);
    return false;
  }
  return true;
}

function lockGroup(groupId: number): void {
  groupLocks.set(groupId, Date.now());
}

function unlockGroup(groupId: number): void {
  groupLocks.delete(groupId);
}

function getContextManager(config: AIConfig): ContextManager {
  if (!contextManager) {
    contextManager = new ContextManager(
      config.max_context_messages || 500,
      config.context_expire_minutes || 120
    );
  }
  return contextManager;
}

export const aiChatPlugin: Plugin = {
  name: 'ai-chat',
  description: 'AI 智能对话 - 玩机器核心，像真人水群',

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
    const hasVisionContent = imageUrls.length > 0 && config.enable_vision;

    // 构建记录内容（始终记录到上下文）
    let recordContent: string | MessageContent[];
    if (hasVisionContent) {
      const parts: MessageContent[] = [];
      const textPart = ctx.rawText.trim()
        ? `${senderName}: ${ctx.rawText.trim()}`
        : `${senderName}: [发了图片]`;
      parts.push({ type: 'text', text: textPart });
      for (const url of imageUrls) {
        // MiMo V2.5 原生支持图像理解，使用high detail获得更好识别
        parts.push({ type: 'image_url', image_url: { url, detail: 'high' } });
      }
      recordContent = parts;
    } else {
      recordContent = `${senderName}: ${ctx.rawText || '[表情/贴纸]'}`;
    }

    cm.addMessage(sessionId, { role: 'user', content: recordContent });

    // 检测是否提及bot
    const mentionsBot = /玩机器|机器哥|机器兄|wjq/i.test(ctx.rawText);
    if (mentionsBot) cm.addMention(sessionId);

    // ===== 触发判断 =====
    // 所有消息都回复
    let shouldTrigger = true;

    if (!shouldTrigger) return false;
    if (!ctx.rawText.trim() && !hasVisionContent) return false;

    // ===== 构建消息 & 调用 AI =====
    const history = cm.getMessages(sessionId);

    // 联网搜索：只在有明确搜索需求时才搜（不再每条消息都搜，避免拖慢响应）
    let searchContext = '';
    const needSearch = /最新|最近|现在|今天|谁赢|比分|赛程|更新|版本|发布|新闻|热搜/.test(ctx.rawText);
    if (needSearch && ctx.rawText.length > 4) {
      try {
        const searchResult = await webSearch(ctx.rawText);
        if (searchResult) {
          searchContext = `\n(参考: ${searchResult.slice(0, 400)})`;
        }
      } catch { /* 搜索失败静默继续 */ }
    }

    // 额外上下文
    let extraContext = searchContext;
    if (ctx.isReplyToBot) {
      extraContext += '\n(对方在回复你之前说的话)';
    }

    const systemPrompt = buildSystemPrompt(config, ctx.event.group_id, extraContext);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    try {
      const reply = await callLLMWithRetry(config, messages, hasVisionContent);
      const cleaned = postProcessReply(reply);

      if (!cleaned) return true;

      // 保存回复到上下文
      cm.addMessage(sessionId, { role: 'assistant', content: cleaned });

      // 发送回复
      const useQuote = ctx.isReplyToBot || isAtBot(ctx.event) || Math.random() < 0.25;
      if (useQuote && cleaned.length <= 250) {
        ctx.replyQuote(cleaned);
      } else {
        sendSmartReply(ctx, cleaned);
      }
    } catch (err) {
      // 出错时完全静默，不回复任何东西
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AI] 群${ctx.event.group_id} 调用失败:`, errMsg);
    }

    return true;
  },
};

// ============ 后处理 ============
function postProcessReply(text: string): string {
  // 移除markdown
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim());
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/#{1,6}\s/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 移除可能的前缀
  text = text.replace(/^(玩机器|机器|MachineWJQ)[：:]\s*/i, '');
  // 移除AI可能加的引号包裹
  text = text.replace(/^["「『](.+)["」』]$/s, '$1');

  // 移除过多换行
  text = text.replace(/\n{3,}/g, '\n\n');
  // 移除行首空格（不是代码时）
  text = text.replace(/^ +/gm, '');

  return text.trim();
}

// ============ 辅助函数 ============
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

/** 智能发送 */
function sendSmartReply(
  ctx: { reply: (msg: string | MessageSegment[]) => void },
  text: string
): void {
  if (text.length <= 350) {
    ctx.reply(text);
    return;
  }

  // 按换行自然分割
  const parts: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > 350 && current.length > 0) {
      parts.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) parts.push(current.trim());

  parts.forEach((part, i) => {
    const delay = Math.min(Math.max(part.length * 25, 400), 2500);
    setTimeout(() => ctx.reply(part), i * delay);
  });
}
