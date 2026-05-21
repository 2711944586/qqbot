import { Plugin, AIConfig, GroupMessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { webSearch } from './web-search';
import { generateVoice } from './tts';
import * as https from 'https';
import * as http from 'http';

const DEFAULT_CONTEXT_SEND_MESSAGES = 45;
const DEFAULT_SEARCH_TIMEOUT_MS = 800;
const DEFAULT_API_TIMEOUT_MS = 15000;
const DEFAULT_SEARCH_KEYWORDS = [
  '最新', '最近', '现在', '今天', '今晚', '昨天', '明天',
  '谁赢', '比分', '赛程', '战报', '更新', '版本', '发布',
  '新闻', '热搜', '多少钱', '价格', '天气', '阵容', '转会',
  'major', 'blast', 'iem', 'esl', 'cs2', 'csgo',
];
const STYLE_SEARCH_KEYWORDS = [
  '玩机器', 'MachineWJQ', '刘亦博', '6657', '切片', '名场面',
  '经典解说', '解说切片', '直播切片',
];
const BOT_NAME_PATTERN = /玩机器|机器哥|机器兄|wjq|MachineWJQ/i;
const STYLE_GUIDE = `

额外风格要求（优先遵守）：
- 这是一个QQ群聊bot，参考电竞直播解说和水群语感，不要声称自己是现实中的主播本人，也不要代表本人发言。
- 语气像直播间接弹幕：短、快、自然，能调侃，能认真分析，但别变成论文。
- 多用直播间的短促节奏和场景化表达：残局、道具、经济、枪法、决策、上头、白给、这波、可以的、真有说法、不是哥们、这也能行。
- 遇到CS2/电竞/比赛话题，优先像解说复盘一样抓关键点：谁在做事、哪里失误、这波为什么能赢。
- 接梗时要像看弹幕：先给反应，再补一句判断。例：离谱、真有你的、这波有说法、我不好评价。
- 看图时先说你看到了什么，再用一句短评收尾；不要空泛说“图片不错”。
- 可以使用短梗和口头禅的节奏，但不要逐字复刻长切片内容，不要编造“原话出处”。
- 群聊里被@、被回复、被点名时必须接话，别装没看到。
- 没被点名时可以适当多接话，但只抓一个值得接的点短评，别连续刷屏。
`;

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

/** 构建适合发送给API的消息（只保留当前消息的vision格式） */
function buildApiMessages(messages: ChatMessage[], currentMessageHasVision: boolean): ChatMessage[] {
  // 当前消息没有图片时，把历史图片全部转成文本占位，避免@纯文本时被历史图片拖进视觉请求。
  if (!currentMessageHasVision) {
    return mergeConsecutiveMessages(messages.map((message) => ({
      role: message.role,
      content: stringifyContent(message.content),
    })));
  }

  // 当前消息有图片时：只保留最后一条包含image_url的消息，历史图片转为[图片]占位
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
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
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

    // 合并连续的同角色消息；只有当前消息有图时才保留vision格式。
    const mergedMessages = buildApiMessages(messages, useVision);

    const requestBody: any = {
      model,
      messages: mergedMessages,
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
    req.setTimeout(getApiTimeoutMs(config), () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

// ============ 工具函数 ============

function buildSystemPrompt(config: AIConfig, groupId: number, extraContext: string = ''): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  if (!preset) return '你是QQ群里的电竞直播风格网友。正常聊天就行，别冒充现实中的任何人。';

  let prompt = preset.system_prompt + STYLE_GUIDE;

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
  const selfId = String(event.self_id);
  return event.message.some(
    (seg) => seg.type === 'at' && String(seg.data.qq) === selfId
  ) || event.raw_message.includes(`[CQ:at,qq=${selfId}]`);
}

function isBotNameMentioned(text: string): boolean {
  return BOT_NAME_PATTERN.test(text);
}

function getContextSendCount(config: AIConfig): number {
  return Math.max(1, config.context_send_messages || DEFAULT_CONTEXT_SEND_MESSAGES);
}

function getSearchTimeoutMs(config: AIConfig): number {
  return Math.max(100, config.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS);
}

function getApiTimeoutMs(config: AIConfig): number {
  return Math.max(3000, config.api_timeout_ms || DEFAULT_API_TIMEOUT_MS);
}

function shouldRunSearch(text: string, config: AIConfig): boolean {
  if (config.enable_search === false) return false;
  if (text.trim().length <= 3) return false;

  const lower = text.toLowerCase();
  const keywords = config.search_keywords?.length ? config.search_keywords : DEFAULT_SEARCH_KEYWORDS;
  const hasNewsKeyword = keywords.some((kw) => lower.includes(kw.toLowerCase()));
  if (hasNewsKeyword) return true;

  if (config.search_on_style_query === false) return false;
  return STYLE_SEARCH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function buildSearchQuery(text: string, hasVisionContent: boolean): string {
  const cleaned = text
    .replace(/\[CQ:at,qq=\d+\]/g, '')
    .replace(/@\S+/g, '')
    .trim();

  if (cleaned) return cleaned;
  if (hasVisionContent) return '图片内容 识别 分析';
  return '今天 CS2 电竞 热点';
}

function shouldReplyToMessage(
  ctx: { command: string | null; rawText: string; isReplyToBot: boolean; event: GroupMessageEvent },
  config: AIConfig,
  hasVisionContent: boolean,
  mustReply: boolean,
  cm: ContextManager,
  sessionId: string,
): boolean {
  if (mustReply) return true;
  if (!ctx.rawText.trim() && !hasVisionContent) return false;

  const mode = config.trigger_mode || 'smart';
  if (mode === 'all') return true;
  if (mode === 'command') return ctx.command === 'ai';
  if (mode === 'at') return false;
  if (hasVisionContent) return Math.random() < 0.7;

  return shouldSmartTrigger(
    ctx.rawText,
    config,
    cm.getRecentActivity(sessionId),
    cm.getSilentCount(sessionId),
    cm.getMentionCount(sessionId),
  );
}

async function buildSearchContext(text: string, config: AIConfig, forceSearch: boolean = false): Promise<string> {
  const query = text.trim();
  if (!query) return '';
  if (!(forceSearch || shouldRunSearch(query, config))) return '';

  try {
    const searchPromise = webSearch(query);
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), getSearchTimeoutMs(config));
    });
    const searchResult = await Promise.race([searchPromise, timeoutPromise]);
    if (!searchResult) return '';

    return `\n(联网搜索结果供参考，优先用于最新事实和切片/名场面背景，不要逐字照搬: ${searchResult.slice(0, 500)})`;
  } catch {
    return '';
  }
}

function sendPrimaryReply(
  ctx: { reply: (msg: string | MessageSegment[]) => void; replyQuote: (msg: string) => void },
  text: string,
  useQuote: boolean,
): void {
  if (useQuote && text.length <= 200) {
    ctx.replyQuote(text);
    return;
  }
  sendSmartReply(ctx, text);
}

function buildMustReplyFallback(
  ctx: { isReplyToBot: boolean },
  hasVisionContent: boolean,
  asksForVoice: boolean,
): string {
  const replies = hasVisionContent
    ? ['图我收到了，这次没生成出来，你补一句关键词我继续看', '这张图我接到了，模型没吐内容，重发一句我再看']
    : asksForVoice
      ? ['语音这下没转出来，我先文字接住', '语音没生成成功，先别急，再来一句']
      : ctx.isReplyToBot
        ? ['我看到了，这次没拿到模型结果，你接着说', '收到，刚才那条没生成出来，再来一句']
        : ['收到，这次模型没给内容，你换个问法我接', '我看到了，刚才没生成出来，再说一句'];

  return replies[Math.floor(Math.random() * replies.length)];
}

function maybeSendVoice(
  ctx: { reply: (msg: string | MessageSegment[]) => void },
  config: AIConfig,
  text: string,
): void {
  if (!config.enable_tts) return;
  if (text.length < 4 || text.length > 100) return;
  if (Math.random() >= (config.tts_probability || 0.15)) return;

  void generateVoice(config, text)
    .then((voicePath) => {
      if (!voicePath) return;
      const voiceMsg: MessageSegment[] = [
        { type: 'record', data: { file: `file://${voicePath}` } },
      ];
      ctx.reply(voiceMsg);
    })
    .catch(() => {
      // 文字已经发出，语音失败保持静默。
    });
}

async function sendVoiceReply(
  ctx: { reply: (msg: string | MessageSegment[]) => void },
  config: AIConfig,
  text: string,
): Promise<boolean> {
  if (!config.enable_tts) return false;
  if (text.length < 2 || text.length > 200) return false;

  try {
    const voicePath = await generateVoice(config, text);
    if (!voicePath) return false;

    const voiceMsg: MessageSegment[] = [
      { type: 'record', data: { file: `file://${voicePath}` } },
    ];
    ctx.reply(voiceMsg);
    return true;
  } catch {
    return false;
  }
}

function trimHistoryForApi(history: ChatMessage[]): ChatMessage[] {
  const firstUserIndex = history.findIndex((message) => message.role === 'user');
  if (firstUserIndex <= 0) return history;
  return history.slice(firstUserIndex);
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
    return Math.random() < 0.02;
  }

  // === 直接关键词/名字 → 必触发 ===
  if (config.trigger_keywords?.some((kw) => text.includes(kw.toLowerCase()))) {
    return true;
  }
  if (/玩机器|机器哥|机器兄|wjq/.test(text)) return true;

  // === 群讨论激烈时（活跃度高）大幅提升回复率 ===
  const activityMultiplier = recentActivity > 12 ? 1.6 : recentActivity > 6 ? 1.3 : 1.0;
  const mentionBonus = mentionCount > 2 ? 0.1 : 0;
  const baseProbability = (config.trigger_probability ?? 0.22) * activityMultiplier;

  // === 分类触发 ===
  if (analysis.isGaming) {
    return Math.random() < Math.min(baseProbability * 1.55 + mentionBonus, 0.55);
  }
  if (analysis.isControversial) {
    return Math.random() < Math.min(baseProbability * 1.45 + mentionBonus, 0.5);
  }
  if (analysis.isMeme) {
    return Math.random() < Math.min(baseProbability * 1.3 + mentionBonus, 0.45);
  }
  if (analysis.isSharingContent) {
    return Math.random() < Math.min(baseProbability * 1.25, 0.42);
  }
  if (analysis.isQuestion) {
    return Math.random() < Math.min(baseProbability * 1.25, 0.42);
  }
  if (analysis.hasEmotion) {
    return Math.random() < Math.min(baseProbability * 1.1, 0.35);
  }
  if (analysis.isComplaint) {
    return Math.random() < Math.min(baseProbability, 0.3);
  }
  if (analysis.isGreeting) {
    return Math.random() < Math.min(baseProbability * 0.7, 0.18);
  }

  // === 没被点名时也可以更积极接话，但仍低于全量回复 ===
  if (silentCount >= 14) return Math.random() < 0.18;
  if (silentCount >= 8) return Math.random() < 0.1;

  // === 长消息加成 ===
  const lengthBonus = analysis.textLength > 40 ? 0.08 : analysis.textLength > 20 ? 0.04 : 0;

  return Math.random() < Math.min(baseProbability * 0.75 + lengthBonus + mentionBonus, 0.28);
}

// ============ 插件实例 ============
let contextManager: ContextManager | null = null;

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
    const voiceCommand = ctx.command === 'voice' || ctx.command === 'tts' || ctx.command === 'say';
    const promptText = (ctx.command === 'ai' || voiceCommand) ? ctx.args.join(' ').trim() : ctx.rawText;
    const atBot = isAtBot(ctx.event);
    const mentionsBot = isBotNameMentioned(ctx.rawText);
    const asksForVoice = voiceCommand || /用语音|发语音|语音回复|说出来|读出来/.test(ctx.rawText);
    const mustReply = ctx.command === 'ai' || voiceCommand || asksForVoice || atBot || ctx.isReplyToBot || mentionsBot;

    if ((ctx.command === 'ai' || voiceCommand) && !promptText && !hasVisionContent) {
      ctx.reply(voiceCommand ? `/${ctx.command} <内容>` : '/ai <内容>');
      return true;
    }

    // 构建记录内容（始终记录到上下文）
    let recordContent: string | MessageContent[];
    if (hasVisionContent) {
      const parts: MessageContent[] = [];
      const textPart = promptText.trim()
        ? `${senderName}: ${promptText.trim()}`
        : `${senderName}: [发了图片]`;
      parts.push({ type: 'text', text: textPart });
      for (const url of imageUrls) {
        // MiMo V2.5 原生支持图像理解，使用high detail获得更好识别
        parts.push({ type: 'image_url', image_url: { url, detail: 'high' } });
      }
      recordContent = parts;
    } else {
      recordContent = `${senderName}: ${promptText || '[表情/贴纸]'}`;
    }

    cm.addMessage(sessionId, { role: 'user', content: recordContent });

    // 检测是否提及bot
    if (mentionsBot || atBot) cm.addMention(sessionId);

    // ===== 触发判断 =====
    const shouldTrigger = shouldReplyToMessage(ctx, config, hasVisionContent, mustReply, cm, sessionId);
    if (!shouldTrigger) return false;

    // ===== 构建消息 & 调用 AI =====
    // 取最近的上下文（不要全部发给API，太长会超时）
    const allHistory = cm.getMessages(sessionId);
    const history = trimHistoryForApi(allHistory.slice(-getContextSendCount(config)));

    // 联网搜索：@/回复时遇到问题更积极，普通群聊按关键词触发，快速超时
    const searchText = promptText || ctx.rawText;
    const searchQuery = buildSearchQuery(searchText, hasVisionContent);
    const searchContext = await buildSearchContext(searchQuery, config, mustReply);

    // 额外上下文
    let extraContext = searchContext;
    if (atBot) {
      extraContext += '\n(对方@了你，必须接话。)';
    }
    if (ctx.isReplyToBot) {
      extraContext += '\n(对方在回复你之前说的话，必须接住上下文。)';
    }
    if (!mustReply) {
      extraContext += '\n(你没有被点名，只需要从群聊上下文里抽一个最值得接的话题短评。不要逐条总结，不要刷屏。)';
    }
    if (hasVisionContent) {
      extraContext += '\n(这条消息包含图片。先看清图片主体、文字、表情或截图内容，再用直播间口吻短评；不要假装没看到。)';
    }
    if (asksForVoice) {
      extraContext += '\n(用户明确要求语音回复。回复控制在60字以内，方便转成语音。)';
    }

    const systemPrompt = buildSystemPrompt(config, ctx.event.group_id, extraContext);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    try {
      const reply = await callLLMWithRetry(config, messages, hasVisionContent, mustReply ? 1 : 2);
      const cleaned = postProcessReply(reply);

      if (!cleaned) {
        if (mustReply) {
          const fallback = buildMustReplyFallback(ctx, hasVisionContent, asksForVoice);
          cm.addMessage(sessionId, { role: 'assistant', content: fallback });
          sendPrimaryReply(ctx, fallback, config.must_reply_quote !== false);
        }
        return true;
      }

      // 保存回复到上下文
      cm.addMessage(sessionId, { role: 'assistant', content: cleaned });

      // 发送回复
      const mustQuote = mustReply && config.must_reply_quote !== false;
      const useQuote = mustQuote || Math.random() < 0.2;
      if (asksForVoice) {
        const sentVoice = await sendVoiceReply(ctx, config, cleaned);
        if (sentVoice) return true;
      }
      sendPrimaryReply(ctx, cleaned, useQuote);
      maybeSendVoice(ctx, config, cleaned);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AI][群${ctx.event.group_id}] 最终失败(已重试):`, errMsg);
      if (mustReply) {
        const fallback = buildMustReplyFallback(ctx, hasVisionContent, asksForVoice);
        cm.addMessage(sessionId, { role: 'assistant', content: fallback });
        sendPrimaryReply(ctx, fallback, config.must_reply_quote !== false);
      }
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
