/** OneBot v11 事件类型定义 */

// ============ 配置 ============
export interface BotConfig {
  ws_url: string;
  /** 期望登录的Bot QQ号，仅用于启动展示/部署校验；运行时以OneBot self_id为准 */
  bot_qq?: number;
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
  /** 单次模型请求最多等待毫秒数 */
  api_timeout_ms?: number;
  /** 搜索触发关键词 */
  search_keywords?: string[];
  /** 是否对风格/切片/名场面查询也触发搜索 */
  search_on_style_query?: boolean;
  /** 搜索缓存时间(秒) */
  search_cache_seconds?: number;
  /** 搜索空结果缓存时间(秒) */
  search_negative_cache_seconds?: number;
  /** 搜索缓存最大条目数 */
  search_cache_max_entries?: number;
  /** AI文本回复短期缓存秒数，0为关闭 */
  ai_reply_cache_seconds?: number;
  /** 是否启用Markdown知识库 */
  enable_knowledge?: boolean;
  /** 单次注入知识库最大字符数 */
  knowledge_max_chars?: number;
  /** smart模式下相关话题主动回复概率 */
  related_reply_probability?: number;
  /** 人格模式 */
  persona_mode?: 'first_person_bot' | 'style_bot' | 'assistant';
  /** 吐槽强度 */
  aggression_level?: 'low' | 'medium' | 'analysis';
  /** 知识库更新模式 */
  knowledge_update_mode?: 'reviewed_command' | 'static';
  /** 是否启用轻量知识库后台自动更新 */
  knowledge_auto_update?: boolean;
  /** 知识库自动更新间隔分钟 */
  knowledge_auto_interval_minutes?: number;
  /** 是否允许自动写入公开事实/短摘要 */
  knowledge_auto_commit_public_facts?: boolean;
  /** 是否把长语录/疑似转写隔离，不写主库 */
  knowledge_quarantine_long_quotes?: boolean;
  /** 知识来源搜索超时毫秒 */
  knowledge_source_timeout_ms?: number;
  /** 是否激进自动写入可信公开摘要 */
  knowledge_aggressive_auto_commit?: boolean;
  /** 自动刷新每批最多来源数 */
  knowledge_auto_batch_max_sources?: number;
  /** 手动刷新每批最多来源数 */
  knowledge_manual_batch_max_sources?: number;
  /** 自动写入单块最大字符数 */
  knowledge_auto_max_block_chars?: number;
  /** 自动写入日志保留天数 */
  knowledge_auto_log_retention_days?: number;
  /** 每个群AI回复队列最大长度 */
  max_group_queue?: number;
  /** 全局AI并发 */
  ai_global_concurrency?: number;
  /** 全局搜索并发 */
  search_global_concurrency?: number;
  /** 全局识图并发 */
  vision_global_concurrency?: number;
  /** 全局TTS并发 */
  tts_global_concurrency?: number;
  /** 全局语音听写并发 */
  stt_global_concurrency?: number;
  /** 是否强制引用强触发消息 */
  forced_reply_quote?: boolean;
  /** @或回复bot时是否优先引用回复 */
  must_reply_quote?: boolean;
  /** 是否启用识图 */
  enable_vision: boolean;
  /** 单次最多处理图片数量 */
  vision_max_images?: number;
  /** 图片缓存最大MB */
  image_cache_max_mb?: number;
  /** 单图下载最大MB */
  image_cache_max_file_mb?: number;
  /** 图片缓存过期小时数 */
  image_cache_max_age_hours?: number;
  /** 是否启用TTS语音回复 */
  enable_tts: boolean;
  /** 是否启用语音输入听写 */
  enable_stt?: boolean;
  /** 语音听写模型 */
  stt_model?: string;
  /** 单次最多听写语音条数 */
  stt_max_records?: number;
  /** 单条语音下载最大MB */
  stt_max_file_mb?: number;
  /** 语音听写请求超时毫秒 */
  stt_timeout_ms?: number;
  /** 语音听写缓存小时数 */
  stt_cache_hours?: number;
  /** 普通TTS模型 */
  tts_model?: string;
  /** 克隆TTS模型 */
  tts_clone_model?: string;
  /** 是否启用授权样本克隆 */
  tts_clone_enabled?: boolean;
  /** 授权语音样本路径，相对项目根目录或绝对路径 */
  tts_sample_path?: string;
  /** TTS声音风格提示 */
  tts_voice_prompt?: string;
  /** TTS单条最大字符数 */
  tts_max_chars?: number;
  /** TTS请求超时毫秒 */
  tts_timeout_ms?: number;
  /** TTS缓存小时数 */
  tts_cache_hours?: number;
  /** TTS样本最大MB */
  tts_sample_max_mb?: number;
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
  /** 是否@了Bot */
  isAtBot: boolean;
  /** 是否是回复Bot消息 */
  isReplyToBot: boolean;
  reply: (message: string | MessageSegment[]) => void;
  replyAt: (message: string) => void;
  /** 引用回复某条消息 */
  replyQuote: (message: string) => void;
  /** 按指定消息ID引用回复，失败时回退为@指定用户 */
  replyQuoteTo: (messageId: number, userId: number, message: string) => void;
  bot: import('./bot').Bot;
}

export interface Plugin {
  name: string;
  description: string;
  handler: (ctx: PluginContext) => Promise<boolean> | boolean;
}
