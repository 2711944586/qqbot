/** OneBot v11 事件类型定义 */

// ============ 配置 ============
export interface BotConfig {
  ws_url: string;
  bot_name: string;
  command_prefix: string;
  admin_qq: number[];
  enabled_groups: number[];
  ai: AIConfig;
}

export interface AIConfig {
  api_url: string;
  api_key: string;
  model: string;
  /** 识图模型 */
  vision_model: string;
  /** 当前激活的预设名称 */
  active_preset: string;
  /** 预设集合 */
  presets: Record<string, PresetConfig>;
  /** 每个群保留的上下文轮数 */
  max_context_rounds: number;
  /** 上下文最大消息条数 */
  max_context_messages: number;
  /** 每次发给模型的最近消息条数 */
  context_send_messages?: number;
  /** 单次回复最大 token 数 */
  max_tokens: number;
  /** 温度 */
  temperature: number;
  /** 触发模式: command=仅命令触发, at=@触发, all=所有消息都触发, smart=智能触发 */
  trigger_mode: 'command' | 'at' | 'all' | 'smart';
  /** 触发关键词列表 (smart 模式) */
  trigger_keywords: string[];
  /** 随机触发概率 (0-1) */
  trigger_probability: number;
  /** 冷却时间(秒)，防止刷屏 */
  cooldown_seconds: number;
  /** 上下文过期时间(分钟) */
  context_expire_minutes: number;
  /** 是否启用联网搜索增强 */
  enable_search?: boolean;
  /** 搜索最多等待毫秒数 */
  search_timeout_ms?: number;
  /** 搜索触发关键词 */
  search_keywords?: string[];
  /** 是否对风格/切片/名场面查询也触发搜索 */
  search_on_style_query?: boolean;
  /** @或回复bot时是否优先引用回复 */
  must_reply_quote?: boolean;
  /** 是否启用识图 */
  enable_vision: boolean;
  /** 是否启用TTS语音回复 */
  enable_tts: boolean;
  /** TTS触发概率 (0-1) */
  tts_probability: number;
}

export interface PresetConfig {
  name: string;
  description: string;
  system_prompt: string;
}

// ============ 消息段 ============
export interface TextSegment {
  type: 'text';
  data: { text: string };
}

export interface FaceSegment {
  type: 'face';
  data: { id: string };
}

export interface ImageSegment {
  type: 'image';
  data: { file: string; url?: string };
}

export interface AtSegment {
  type: 'at';
  data: { qq: string };
}

export interface ReplySegment {
  type: 'reply';
  data: { id: string };
}

export interface RecordSegment {
  type: 'record';
  data: { file: string; url?: string };
}

export type MessageSegment = TextSegment | FaceSegment | ImageSegment | AtSegment | ReplySegment | RecordSegment;

// ============ 发送者信息 ============
export interface Sender {
  user_id: number;
  nickname: string;
  card?: string;
  sex?: 'male' | 'female' | 'unknown';
  age?: number;
  role?: 'owner' | 'admin' | 'member';
}

// ============ 事件 ============
export interface GroupMessageEvent {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'group';
  sub_type: 'normal' | 'anonymous' | 'notice';
  message_id: number;
  group_id: number;
  user_id: number;
  anonymous?: { id: number; name: string; flag: string } | null;
  message: MessageSegment[];
  raw_message: string;
  font: number;
  sender: Sender;
}

export interface PrivateMessageEvent {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'private';
  sub_type: 'friend' | 'group' | 'other';
  message_id: number;
  user_id: number;
  message: MessageSegment[];
  raw_message: string;
  font: number;
  sender: Sender;
}

export interface MetaEvent {
  time: number;
  self_id: number;
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  sub_type?: string;
}

export interface NoticeEvent {
  time: number;
  self_id: number;
  post_type: 'notice';
  notice_type: string;
  group_id?: number;
  user_id?: number;
  [key: string]: unknown;
}

export type OneBotEvent = GroupMessageEvent | PrivateMessageEvent | MetaEvent | NoticeEvent;

// ============ 插件系统 ============
export interface PluginContext {
  event: GroupMessageEvent;
  rawText: string;
  command: string | null;
  args: string[];
  /** 是否是回复Bot消息 */
  isReplyToBot: boolean;
  reply: (message: string | MessageSegment[]) => void;
  replyAt: (message: string) => void;
  /** 引用回复某条消息 */
  replyQuote: (message: string) => void;
  bot: import('./bot').Bot;
}

export interface Plugin {
  name: string;
  description: string;
  handler: (ctx: PluginContext) => Promise<boolean> | boolean;
}
