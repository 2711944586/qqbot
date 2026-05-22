import * as fs from 'fs';
import * as path from 'path';
import { AIConfig, BotConfig, PresetConfig } from './types';

export const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

type PlainObject = Record<string, unknown>;

const DEFAULT_AI_CONFIG: AIConfig = {
  api_url: '',
  api_key: '',
  model: '',
  vision_model: '',
  active_preset: '',
  presets: {},
  max_context_rounds: 30,
  max_context_messages: 50,
  context_send_messages: 30,
  max_tokens: 400,
  temperature: 0.8,
  trigger_mode: 'command',
  trigger_keywords: [],
  trigger_probability: 0,
  cooldown_seconds: 0,
  context_expire_minutes: 120,
  enable_search: false,
  search_timeout_ms: 1200,
  api_timeout_ms: 15000,
  search_keywords: [],
  search_on_style_query: false,
  search_cache_seconds: 300,
  search_negative_cache_seconds: 60,
  search_cache_max_entries: 1000,
  ai_reply_cache_seconds: 180,
  enable_knowledge: true,
  knowledge_max_chars: 2200,
  related_reply_probability: 0.65,
  persona_mode: 'first_person_bot',
  aggression_level: 'medium',
  knowledge_update_mode: 'reviewed_command',
  knowledge_auto_update: true,
  knowledge_auto_interval_minutes: 180,
  knowledge_auto_commit_public_facts: true,
  knowledge_quarantine_long_quotes: true,
  knowledge_source_timeout_ms: 2200,
  knowledge_aggressive_auto_commit: true,
  knowledge_auto_batch_max_sources: 6,
  knowledge_manual_batch_max_sources: 10,
  knowledge_auto_max_block_chars: 1200,
  knowledge_auto_log_retention_days: 14,
  max_group_queue: 5,
  ai_global_concurrency: 2,
  search_global_concurrency: 3,
  vision_global_concurrency: 1,
  tts_global_concurrency: 1,
  forced_reply_quote: true,
  must_reply_quote: true,
  enable_vision: false,
  vision_max_images: 2,
  image_cache_max_mb: 512,
  image_cache_max_file_mb: 2,
  image_cache_max_age_hours: 72,
  enable_tts: false,
  tts_model: 'mimo-v2.5-tts',
  tts_clone_model: 'mimo-v2.5-tts-voiceclone',
  tts_clone_enabled: true,
  tts_sample_path: 'voice_sample.mp3',
  tts_voice_prompt: '用年轻男性声音，语气随意放松，像直播间接弹幕，语速偏快但吐字清楚。不要端播音腔，短句有停顿感。',
  tts_max_chars: 120,
  tts_timeout_ms: 20000,
  tts_cache_hours: 24,
  tts_sample_max_mb: 8,
  tts_probability: 0,
};

function isObject(value: unknown): value is PlainObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function hasUsableApiKey(apiKey: string | undefined | null): boolean {
  const key = (apiKey || '').trim();
  if (key.length < 8) return false;
  const lower = key.toLowerCase();
  const placeholderFragments = [
    '在这里填入',
    '你的api',
    '你的 api',
    'api密钥',
    'api 密钥',
    'your_api',
    'your-api',
    'your api',
    'replace_me',
    'changeme',
    'example',
    'placeholder',
  ];
  return !placeholderFragments.some((fragment) => lower.includes(fragment));
}

function asNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof min === 'number' && parsed < min) return min;
  if (typeof max === 'number' && parsed > max) return max;
  return parsed;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
  return [...new Set(numbers)];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePresets(value: unknown): Record<string, PresetConfig> {
  if (!isObject(value)) return {};

  const presets: Record<string, PresetConfig> = {};
  for (const [key, rawPreset] of Object.entries(value)) {
    if (!isObject(rawPreset)) continue;
    const name = asString(rawPreset.name, key);
    const description = asString(rawPreset.description, '');
    const systemPrompt = asString(rawPreset.system_prompt, '');
    if (!systemPrompt) continue;
    presets[key] = {
      name,
      description,
      system_prompt: systemPrompt,
    };
  }
  return presets;
}

function normalizeAiConfig(value: unknown): AIConfig {
  const raw = isObject(value) ? value : {};
  const presets = normalizePresets(raw.presets);
  const activePreset = asString(raw.active_preset, Object.keys(presets)[0] || '');
  const triggerMode = asString(raw.trigger_mode, DEFAULT_AI_CONFIG.trigger_mode);
  const validTriggerModes = new Set(['command', 'at', 'all', 'smart']);
  const personaMode = asString(raw.persona_mode, DEFAULT_AI_CONFIG.persona_mode || 'first_person_bot');
  const validPersonaModes = new Set(['first_person_bot', 'style_bot', 'assistant']);
  const aggressionLevel = asString(raw.aggression_level, DEFAULT_AI_CONFIG.aggression_level || 'medium');
  const validAggressionLevels = new Set(['low', 'medium', 'analysis']);
  const knowledgeUpdateMode = asString(raw.knowledge_update_mode, DEFAULT_AI_CONFIG.knowledge_update_mode || 'reviewed_command');
  const validKnowledgeUpdateModes = new Set(['reviewed_command', 'static']);

  return {
    api_url: asString(raw.api_url, DEFAULT_AI_CONFIG.api_url),
    api_key: asString(raw.api_key, DEFAULT_AI_CONFIG.api_key),
    model: asString(raw.model, DEFAULT_AI_CONFIG.model),
    vision_model: asString(raw.vision_model, asString(raw.model, DEFAULT_AI_CONFIG.vision_model)),
    active_preset: presets[activePreset] ? activePreset : (Object.keys(presets)[0] || ''),
    presets,
    max_context_rounds: Math.floor(asNumber(raw.max_context_rounds, DEFAULT_AI_CONFIG.max_context_rounds, 1, 500)),
    max_context_messages: Math.floor(asNumber(raw.max_context_messages, DEFAULT_AI_CONFIG.max_context_messages, 5, 1000)),
    context_send_messages: Math.floor(asNumber(raw.context_send_messages, DEFAULT_AI_CONFIG.context_send_messages || 25, 1, 200)),
    max_tokens: Math.floor(asNumber(raw.max_tokens, DEFAULT_AI_CONFIG.max_tokens, 16, 4096)),
    temperature: asNumber(raw.temperature, DEFAULT_AI_CONFIG.temperature, 0, 2),
    trigger_mode: validTriggerModes.has(triggerMode) ? triggerMode as AIConfig['trigger_mode'] : DEFAULT_AI_CONFIG.trigger_mode,
    trigger_keywords: asStringArray(raw.trigger_keywords),
    trigger_probability: asNumber(raw.trigger_probability, DEFAULT_AI_CONFIG.trigger_probability, 0, 1),
    cooldown_seconds: Math.floor(asNumber(raw.cooldown_seconds, DEFAULT_AI_CONFIG.cooldown_seconds, 0, 3600)),
    context_expire_minutes: Math.floor(asNumber(raw.context_expire_minutes, DEFAULT_AI_CONFIG.context_expire_minutes, 1, 10080)),
    enable_search: asBoolean(raw.enable_search, DEFAULT_AI_CONFIG.enable_search || false),
    search_timeout_ms: Math.floor(asNumber(raw.search_timeout_ms, DEFAULT_AI_CONFIG.search_timeout_ms || 1500, 200, 10000)),
    api_timeout_ms: Math.floor(asNumber(raw.api_timeout_ms, DEFAULT_AI_CONFIG.api_timeout_ms || 15000, 3000, 120000)),
    search_keywords: asStringArray(raw.search_keywords),
    search_on_style_query: asBoolean(raw.search_on_style_query, DEFAULT_AI_CONFIG.search_on_style_query || false),
    search_cache_seconds: Math.floor(asNumber(raw.search_cache_seconds, DEFAULT_AI_CONFIG.search_cache_seconds || 300, 0, 86400)),
    search_negative_cache_seconds: Math.floor(asNumber(raw.search_negative_cache_seconds, DEFAULT_AI_CONFIG.search_negative_cache_seconds || 60, 0, 3600)),
    search_cache_max_entries: Math.floor(asNumber(raw.search_cache_max_entries, DEFAULT_AI_CONFIG.search_cache_max_entries || 1000, 20, 5000)),
    ai_reply_cache_seconds: Math.floor(asNumber(raw.ai_reply_cache_seconds, DEFAULT_AI_CONFIG.ai_reply_cache_seconds || 180, 0, 3600)),
    enable_knowledge: asBoolean(raw.enable_knowledge, DEFAULT_AI_CONFIG.enable_knowledge || true),
    knowledge_max_chars: Math.floor(asNumber(raw.knowledge_max_chars, DEFAULT_AI_CONFIG.knowledge_max_chars || 2200, 0, 6000)),
    related_reply_probability: asNumber(raw.related_reply_probability, DEFAULT_AI_CONFIG.related_reply_probability || 0.65, 0, 1),
    persona_mode: validPersonaModes.has(personaMode) ? personaMode as AIConfig['persona_mode'] : 'first_person_bot',
    aggression_level: validAggressionLevels.has(aggressionLevel) ? aggressionLevel as AIConfig['aggression_level'] : 'medium',
    knowledge_update_mode: validKnowledgeUpdateModes.has(knowledgeUpdateMode) ? knowledgeUpdateMode as AIConfig['knowledge_update_mode'] : 'reviewed_command',
    knowledge_auto_update: asBoolean(raw.knowledge_auto_update, DEFAULT_AI_CONFIG.knowledge_auto_update || true),
    knowledge_auto_interval_minutes: Math.floor(asNumber(raw.knowledge_auto_interval_minutes, DEFAULT_AI_CONFIG.knowledge_auto_interval_minutes || 180, 30, 1440)),
    knowledge_auto_commit_public_facts: asBoolean(raw.knowledge_auto_commit_public_facts, DEFAULT_AI_CONFIG.knowledge_auto_commit_public_facts || true),
    knowledge_quarantine_long_quotes: asBoolean(raw.knowledge_quarantine_long_quotes, DEFAULT_AI_CONFIG.knowledge_quarantine_long_quotes || true),
    knowledge_source_timeout_ms: Math.floor(asNumber(raw.knowledge_source_timeout_ms, DEFAULT_AI_CONFIG.knowledge_source_timeout_ms || 2200, 500, 10000)),
    knowledge_aggressive_auto_commit: asBoolean(raw.knowledge_aggressive_auto_commit, DEFAULT_AI_CONFIG.knowledge_aggressive_auto_commit || true),
    knowledge_auto_batch_max_sources: Math.floor(asNumber(raw.knowledge_auto_batch_max_sources, DEFAULT_AI_CONFIG.knowledge_auto_batch_max_sources || 6, 1, 20)),
    knowledge_manual_batch_max_sources: Math.floor(asNumber(raw.knowledge_manual_batch_max_sources, DEFAULT_AI_CONFIG.knowledge_manual_batch_max_sources || 10, 1, 30)),
    knowledge_auto_max_block_chars: Math.floor(asNumber(raw.knowledge_auto_max_block_chars, DEFAULT_AI_CONFIG.knowledge_auto_max_block_chars || 1200, 300, 4000)),
    knowledge_auto_log_retention_days: Math.floor(asNumber(raw.knowledge_auto_log_retention_days, DEFAULT_AI_CONFIG.knowledge_auto_log_retention_days || 14, 1, 365)),
    max_group_queue: Math.floor(asNumber(raw.max_group_queue, DEFAULT_AI_CONFIG.max_group_queue || 5, 1, 50)),
    ai_global_concurrency: Math.floor(asNumber(raw.ai_global_concurrency, DEFAULT_AI_CONFIG.ai_global_concurrency || 2, 1, 10)),
    search_global_concurrency: Math.floor(asNumber(raw.search_global_concurrency, DEFAULT_AI_CONFIG.search_global_concurrency || 3, 1, 10)),
    vision_global_concurrency: Math.floor(asNumber(raw.vision_global_concurrency, DEFAULT_AI_CONFIG.vision_global_concurrency || 1, 1, 5)),
    tts_global_concurrency: Math.floor(asNumber(raw.tts_global_concurrency, DEFAULT_AI_CONFIG.tts_global_concurrency || 1, 1, 5)),
    forced_reply_quote: asBoolean(raw.forced_reply_quote, DEFAULT_AI_CONFIG.forced_reply_quote || true),
    must_reply_quote: asBoolean(raw.must_reply_quote, DEFAULT_AI_CONFIG.must_reply_quote || false),
    enable_vision: asBoolean(raw.enable_vision, DEFAULT_AI_CONFIG.enable_vision),
    vision_max_images: Math.floor(asNumber(raw.vision_max_images, DEFAULT_AI_CONFIG.vision_max_images || 2, 0, 4)),
    image_cache_max_mb: Math.floor(asNumber(raw.image_cache_max_mb, DEFAULT_AI_CONFIG.image_cache_max_mb || 512, 20, 4096)),
    image_cache_max_file_mb: asNumber(raw.image_cache_max_file_mb, DEFAULT_AI_CONFIG.image_cache_max_file_mb || 2, 0.5, 8),
    image_cache_max_age_hours: Math.floor(asNumber(raw.image_cache_max_age_hours, DEFAULT_AI_CONFIG.image_cache_max_age_hours || 72, 1, 720)),
    enable_tts: asBoolean(raw.enable_tts, DEFAULT_AI_CONFIG.enable_tts),
    tts_model: asString(raw.tts_model, DEFAULT_AI_CONFIG.tts_model || 'mimo-v2.5-tts'),
    tts_clone_model: asString(raw.tts_clone_model, DEFAULT_AI_CONFIG.tts_clone_model || 'mimo-v2.5-tts-voiceclone'),
    tts_clone_enabled: asBoolean(raw.tts_clone_enabled, DEFAULT_AI_CONFIG.tts_clone_enabled !== false),
    tts_sample_path: asString(raw.tts_sample_path, DEFAULT_AI_CONFIG.tts_sample_path || 'voice_sample.mp3'),
    tts_voice_prompt: asString(raw.tts_voice_prompt, DEFAULT_AI_CONFIG.tts_voice_prompt || ''),
    tts_max_chars: Math.floor(asNumber(raw.tts_max_chars, DEFAULT_AI_CONFIG.tts_max_chars || 120, 10, 500)),
    tts_timeout_ms: Math.floor(asNumber(raw.tts_timeout_ms, DEFAULT_AI_CONFIG.tts_timeout_ms || 20000, 3000, 120000)),
    tts_cache_hours: Math.floor(asNumber(raw.tts_cache_hours, DEFAULT_AI_CONFIG.tts_cache_hours || 24, 1, 720)),
    tts_sample_max_mb: Math.floor(asNumber(raw.tts_sample_max_mb, DEFAULT_AI_CONFIG.tts_sample_max_mb || 8, 1, 100)),
    tts_probability: asNumber(raw.tts_probability, DEFAULT_AI_CONFIG.tts_probability, 0, 1),
  };
}

export function normalizeConfig(value: unknown): BotConfig {
  if (!isObject(value)) {
    throw new Error('配置文件必须是 JSON 对象');
  }

  const wsUrl = asString(value.ws_url, '');
  if (!wsUrl) {
    throw new Error('缺少 ws_url');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(wsUrl);
  } catch {
    throw new Error(`ws_url 不是合法 URL: ${wsUrl}`);
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    throw new Error('ws_url 只支持 ws:// 或 wss://');
  }

  const commandPrefix = asString(value.command_prefix, '/');
  if (commandPrefix.length > 8) {
    throw new Error('command_prefix 过长');
  }
  const rawBotQq = Number(value.bot_qq) > 0 ? value.bot_qq : process.env.BOT_QQ;
  const configuredBotQq = Math.floor(asNumber(
    rawBotQq,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  )) || undefined;

  return {
    ws_url: wsUrl,
    bot_qq: configuredBotQq,
    bot_name: asString(value.bot_name, 'QQ Bot'),
    command_prefix: commandPrefix,
    admin_qq: asNumberArray(value.admin_qq),
    enabled_groups: asNumberArray(value.enabled_groups),
    ai: normalizeAiConfig(value.ai),
  };
}

export function loadConfig(configPath: string = CONFIG_PATH): BotConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 config.json: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件 JSON 解析失败: ${message}`);
  }

  return normalizeConfig(parsed);
}
