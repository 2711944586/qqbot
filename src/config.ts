import * as fs from 'fs';
import * as path from 'path';
import { AIConfig, BotConfig, PresetConfig } from './types';

export const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');
export const CONFIG_VERSION = 20260608;

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
  context_send_messages: 22,
  max_tokens: 1400,
  temperature: 0.92,
  trigger_mode: 'command',
  trigger_keywords: [],
  trigger_probability: 0.08,
  passive_random_min_chars: 4,
  passive_random_allow_numeric: false,
  poke_reply_probability: 1,
  cooldown_seconds: 0,
  context_expire_minutes: 120,
  enable_search: false,
  search_timeout_ms: 1200,
  api_timeout_ms: 60000,
  search_keywords: [],
  search_on_style_query: false,
  search_cache_seconds: 300,
  search_negative_cache_seconds: 60,
  search_cache_max_entries: 1000,
  ai_reply_cache_seconds: 45,
  enable_knowledge: true,
  knowledge_max_chars: 2600,
  knowledge_force_style: true,
  related_reply_probability: 0.65,
  persona_mode: 'first_person_bot',
  aggression_level: 'medium',
  knowledge_update_mode: 'reviewed_command',
  knowledge_auto_update: true,
  knowledge_auto_interval_minutes: 180,
  knowledge_auto_commit_public_facts: true,
  knowledge_quarantine_long_quotes: false,
  knowledge_expansion_enabled: true,
  knowledge_expansion_batch_max_sources: 12,
  knowledge_source_timeout_ms: 2200,
  knowledge_aggressive_auto_commit: true,
  knowledge_auto_batch_max_sources: 6,
  knowledge_manual_batch_max_sources: 10,
  knowledge_auto_max_block_chars: 1200,
  knowledge_auto_log_retention_days: 14,
  max_group_queue: 5,
  gate_passive_queue_max: 20,
  ai_global_concurrency: 2,
  search_global_concurrency: 2,
  vision_global_concurrency: 1,
  tts_global_concurrency: 1,
  stt_global_concurrency: 1,
  forced_reply_quote: true,
  must_reply_quote: true,
  enable_vision: false,
  vision_payload_mode: 'auto',
  vision_max_images: 2,
  image_cache_max_mb: 384,
  image_cache_max_file_mb: 6,
  image_cache_max_age_hours: 168,
  image_download_max_redirects: 3,
  image_cache_cleanup_interval_minutes: 30,
  image_cache_max_files: 5000,
  enable_tts: false,
  enable_stt: false,
  stt_model: '',
  stt_provider: 'api',
  stt_payload_mode: 'auto',
  stt_record_format: 'mp3',
  stt_local_command: '',
  stt_local_timeout_ms: 15000,
  stt_max_records: 1,
  stt_max_file_mb: 4,
  stt_timeout_ms: 20000,
  stt_cache_hours: 24,
  stt_cache_max_mb: 128,
  stt_cache_max_files: 3000,
  context_compression_defer_when_busy: true,
  enable_memory_retrieval: true,
  memory_top_k: 4,
  memory_min_similarity: 0.18,
  memory_inject_max_chars: 700,
  memory_max_messages_per_session: 700,
  memory_max_sessions_in_memory: 80,
  tts_model: 'mimo-v2.5-tts',
  tts_provider: 'api',
  tts_local_command: '',
  tts_local_output_dir: 'voice_cache/local',
  tts_local_timeout_ms: 15000,
  tts_clone_model: 'mimo-v2.5-tts-voiceclone',
  tts_clone_enabled: true,
  tts_sample_path: 'voice_sample.mp3',
  tts_voice_prompt: '用年轻男性声音，语气随意放松，像直播间接弹幕，语速偏快但吐字清楚。不要端播音腔，短句有停顿感。',
  tts_max_chars: 120,
  tts_send_mode: 'base64',
  tts_timeout_ms: 20000,
  tts_cache_hours: 24,
  tts_cache_max_mb: 256,
  tts_cache_max_files: 1500,
  tts_sample_max_mb: 8,
  tts_probability: 0.18,
};

function isObject(value: unknown): value is PlainObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envString(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** 环境变量数值，无效时返回 undefined */
function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 环境变量布尔值 */
function envBoolean(name: string): boolean | undefined {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return undefined;
}

/** 环境变量逗号分隔的整数数组（如 WANJIER_ADMIN_QQ=12345,67890） */
function parseEnvIntArray(name: string, fallback: number[]): number[] {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const numbers = parts
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
  return [...new Set(numbers)];
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
  const aggressionLevel = envString('WANJIER_AGGRESSION') || asString(raw.aggression_level, DEFAULT_AI_CONFIG.aggression_level || 'low');
  const validAggressionLevels = new Set(['low', 'medium', 'high', 'analysis']);
  const knowledgeUpdateMode = asString(raw.knowledge_update_mode, DEFAULT_AI_CONFIG.knowledge_update_mode || 'reviewed_command');
  const validKnowledgeUpdateModes = new Set(['reviewed_command', 'static']);
  const visionPayloadMode = asString(raw.vision_payload_mode, DEFAULT_AI_CONFIG.vision_payload_mode || 'auto');
  const validVisionPayloadModes = new Set(['auto', 'image_url_object', 'image_url_string', 'input_image', 'image_base64']);
  const ttsProvider = asString(raw.tts_provider, DEFAULT_AI_CONFIG.tts_provider || 'api');
  const sttProvider = asString(raw.stt_provider, DEFAULT_AI_CONFIG.stt_provider || 'api');
  const validAudioProviders = new Set(['api', 'local', 'auto']);
  const sttPayloadMode = asString(raw.stt_payload_mode, DEFAULT_AI_CONFIG.stt_payload_mode || 'auto');
  const validSttPayloadModes = new Set(['auto', 'input_audio', 'audio_url']);
  const sttRecordFormat = asString(raw.stt_record_format, DEFAULT_AI_CONFIG.stt_record_format || 'mp3');
  const validSttRecordFormats = new Set(['mp3', 'wav', 'amr', 'm4a']);
  const ttsSendMode = asString(raw.tts_send_mode, DEFAULT_AI_CONFIG.tts_send_mode || 'base64');
  const validTtsSendModes = new Set(['auto', 'base64', 'file']);

  return {
    api_url: envString('WANJIER_API_URL') || asString(raw.api_url, DEFAULT_AI_CONFIG.api_url),
    api_key: envString('WANJIER_API_KEY') || envString('OPENAI_API_KEY') || asString(raw.api_key, DEFAULT_AI_CONFIG.api_key),
    model: envString('WANJIER_MODEL') || asString(raw.model, DEFAULT_AI_CONFIG.model),
    vision_model: envString('WANJIER_VISION_MODEL') || asString(raw.vision_model, asString(raw.model, DEFAULT_AI_CONFIG.vision_model)),
    active_preset: presets[activePreset] ? activePreset : (Object.keys(presets)[0] || ''),
    presets,
    max_context_rounds: Math.floor(asNumber(raw.max_context_rounds, DEFAULT_AI_CONFIG.max_context_rounds, 1, 500)),
    max_context_messages: Math.floor(asNumber(raw.max_context_messages, DEFAULT_AI_CONFIG.max_context_messages, 5, 1000)),
    context_send_messages: Math.floor(asNumber(raw.context_send_messages, DEFAULT_AI_CONFIG.context_send_messages || 25, 1, 200)),
    max_tokens: Math.floor(asNumber(envNumber('WANJIER_MAX_TOKENS') ?? raw.max_tokens, DEFAULT_AI_CONFIG.max_tokens, 16, 32768)),
    temperature: asNumber(envNumber('WANJIER_TEMPERATURE') ?? raw.temperature, DEFAULT_AI_CONFIG.temperature, 0, 2),
    trigger_mode: validTriggerModes.has(triggerMode) ? triggerMode as AIConfig['trigger_mode'] : DEFAULT_AI_CONFIG.trigger_mode,
    trigger_keywords: asStringArray(raw.trigger_keywords),
    trigger_probability: asNumber(envNumber('WANJIER_TRIGGER_PROBABILITY') ?? raw.trigger_probability, DEFAULT_AI_CONFIG.trigger_probability, 0, 1),
    passive_random_min_chars: Math.floor(asNumber(raw.passive_random_min_chars, DEFAULT_AI_CONFIG.passive_random_min_chars || 4, 1, 50)),
    passive_random_allow_numeric: asBoolean(raw.passive_random_allow_numeric, DEFAULT_AI_CONFIG.passive_random_allow_numeric || false),
    poke_reply_probability: asNumber(raw.poke_reply_probability, DEFAULT_AI_CONFIG.poke_reply_probability ?? 1, 0, 1),
    cooldown_seconds: Math.floor(asNumber(raw.cooldown_seconds, DEFAULT_AI_CONFIG.cooldown_seconds, 0, 3600)),
    context_expire_minutes: Math.floor(asNumber(raw.context_expire_minutes, DEFAULT_AI_CONFIG.context_expire_minutes, 1, 10080)),
    enable_search: asBoolean(raw.enable_search, DEFAULT_AI_CONFIG.enable_search || false),
    search_timeout_ms: Math.floor(asNumber(raw.search_timeout_ms, DEFAULT_AI_CONFIG.search_timeout_ms || 1500, 200, 10000)),
    api_timeout_ms: Math.floor(asNumber(raw.api_timeout_ms, DEFAULT_AI_CONFIG.api_timeout_ms || 60000, 3000, 600000)),
    search_keywords: asStringArray(raw.search_keywords),
    search_on_style_query: asBoolean(raw.search_on_style_query, DEFAULT_AI_CONFIG.search_on_style_query || false),
    search_cache_seconds: Math.floor(asNumber(raw.search_cache_seconds, DEFAULT_AI_CONFIG.search_cache_seconds || 300, 0, 86400)),
    search_negative_cache_seconds: Math.floor(asNumber(raw.search_negative_cache_seconds, DEFAULT_AI_CONFIG.search_negative_cache_seconds || 60, 0, 3600)),
    search_cache_max_entries: Math.floor(asNumber(raw.search_cache_max_entries, DEFAULT_AI_CONFIG.search_cache_max_entries || 1000, 20, 5000)),
    ai_reply_cache_seconds: Math.floor(asNumber(raw.ai_reply_cache_seconds, DEFAULT_AI_CONFIG.ai_reply_cache_seconds || 180, 0, 3600)),
    enable_knowledge: asBoolean(raw.enable_knowledge, DEFAULT_AI_CONFIG.enable_knowledge || true),
    knowledge_max_chars: Math.floor(asNumber(raw.knowledge_max_chars, DEFAULT_AI_CONFIG.knowledge_max_chars || 2200, 0, 6000)),
    knowledge_force_style: asBoolean(raw.knowledge_force_style, DEFAULT_AI_CONFIG.knowledge_force_style !== false),
    related_reply_probability: asNumber(raw.related_reply_probability, DEFAULT_AI_CONFIG.related_reply_probability || 0.65, 0, 1),
    persona_mode: validPersonaModes.has(personaMode) ? personaMode as AIConfig['persona_mode'] : 'first_person_bot',
    aggression_level: validAggressionLevels.has(aggressionLevel) ? aggressionLevel as AIConfig['aggression_level'] : 'low',
    knowledge_update_mode: validKnowledgeUpdateModes.has(knowledgeUpdateMode) ? knowledgeUpdateMode as AIConfig['knowledge_update_mode'] : 'reviewed_command',
    knowledge_auto_update: asBoolean(raw.knowledge_auto_update, DEFAULT_AI_CONFIG.knowledge_auto_update || true),
    knowledge_auto_interval_minutes: Math.floor(asNumber(raw.knowledge_auto_interval_minutes, DEFAULT_AI_CONFIG.knowledge_auto_interval_minutes || 180, 30, 1440)),
    knowledge_auto_commit_public_facts: asBoolean(raw.knowledge_auto_commit_public_facts, DEFAULT_AI_CONFIG.knowledge_auto_commit_public_facts || true),
    knowledge_quarantine_long_quotes: asBoolean(raw.knowledge_quarantine_long_quotes, DEFAULT_AI_CONFIG.knowledge_quarantine_long_quotes === true),
    knowledge_source_timeout_ms: Math.floor(asNumber(raw.knowledge_source_timeout_ms, DEFAULT_AI_CONFIG.knowledge_source_timeout_ms || 2200, 500, 10000)),
    knowledge_aggressive_auto_commit: asBoolean(raw.knowledge_aggressive_auto_commit, DEFAULT_AI_CONFIG.knowledge_aggressive_auto_commit || true),
    knowledge_auto_batch_max_sources: Math.floor(asNumber(raw.knowledge_auto_batch_max_sources, DEFAULT_AI_CONFIG.knowledge_auto_batch_max_sources || 6, 1, 20)),
    knowledge_manual_batch_max_sources: Math.floor(asNumber(raw.knowledge_manual_batch_max_sources, DEFAULT_AI_CONFIG.knowledge_manual_batch_max_sources || 10, 1, 30)),
    knowledge_auto_max_block_chars: Math.floor(asNumber(raw.knowledge_auto_max_block_chars, DEFAULT_AI_CONFIG.knowledge_auto_max_block_chars || 1200, 300, 4000)),
    knowledge_auto_log_retention_days: Math.floor(asNumber(raw.knowledge_auto_log_retention_days, DEFAULT_AI_CONFIG.knowledge_auto_log_retention_days || 14, 1, 365)),
    knowledge_expansion_enabled: asBoolean(raw.knowledge_expansion_enabled, DEFAULT_AI_CONFIG.knowledge_expansion_enabled !== false),
    knowledge_expansion_batch_max_sources: Math.floor(asNumber(raw.knowledge_expansion_batch_max_sources, DEFAULT_AI_CONFIG.knowledge_expansion_batch_max_sources || 12, 1, 40)),
    max_group_queue: Math.floor(asNumber(raw.max_group_queue, DEFAULT_AI_CONFIG.max_group_queue || 5, 1, 50)),
    gate_passive_queue_max: Math.floor(asNumber(raw.gate_passive_queue_max, DEFAULT_AI_CONFIG.gate_passive_queue_max || 20, 0, 1000)),
    ai_global_concurrency: Math.floor(asNumber(raw.ai_global_concurrency, DEFAULT_AI_CONFIG.ai_global_concurrency || 2, 1, 10)),
    search_global_concurrency: Math.floor(asNumber(raw.search_global_concurrency, DEFAULT_AI_CONFIG.search_global_concurrency || 3, 1, 10)),
    vision_global_concurrency: Math.floor(asNumber(raw.vision_global_concurrency, DEFAULT_AI_CONFIG.vision_global_concurrency || 1, 1, 5)),
    tts_global_concurrency: Math.floor(asNumber(raw.tts_global_concurrency, DEFAULT_AI_CONFIG.tts_global_concurrency || 1, 1, 5)),
    stt_global_concurrency: Math.floor(asNumber(raw.stt_global_concurrency, DEFAULT_AI_CONFIG.stt_global_concurrency || 1, 1, 5)),
    forced_reply_quote: asBoolean(raw.forced_reply_quote, DEFAULT_AI_CONFIG.forced_reply_quote || true),
    must_reply_quote: asBoolean(raw.must_reply_quote, DEFAULT_AI_CONFIG.must_reply_quote || false),
    enable_vision: envBoolean('WANJIER_ENABLE_VISION') ?? asBoolean(raw.enable_vision, DEFAULT_AI_CONFIG.enable_vision),
    vision_payload_mode: validVisionPayloadModes.has(visionPayloadMode) ? visionPayloadMode as AIConfig['vision_payload_mode'] : 'auto',
    vision_max_images: Math.floor(asNumber(raw.vision_max_images, DEFAULT_AI_CONFIG.vision_max_images || 2, 0, 4)),
    image_cache_max_mb: Math.floor(asNumber(raw.image_cache_max_mb, DEFAULT_AI_CONFIG.image_cache_max_mb || 512, 20, 4096)),
    image_cache_max_file_mb: asNumber(raw.image_cache_max_file_mb, DEFAULT_AI_CONFIG.image_cache_max_file_mb || 8, 0.5, 32),
    image_cache_max_age_hours: Math.floor(asNumber(raw.image_cache_max_age_hours, DEFAULT_AI_CONFIG.image_cache_max_age_hours || 72, 1, 720)),
    image_download_max_redirects: Math.floor(asNumber(raw.image_download_max_redirects, DEFAULT_AI_CONFIG.image_download_max_redirects || 3, 0, 10)),
    image_cache_cleanup_interval_minutes: Math.floor(asNumber(raw.image_cache_cleanup_interval_minutes, DEFAULT_AI_CONFIG.image_cache_cleanup_interval_minutes || 30, 5, 1440)),
    image_cache_max_files: Math.floor(asNumber(raw.image_cache_max_files, DEFAULT_AI_CONFIG.image_cache_max_files || 5000, 50, 100000)),
    enable_tts: envBoolean('WANJIER_ENABLE_TTS') ?? asBoolean(raw.enable_tts, DEFAULT_AI_CONFIG.enable_tts),
    enable_stt: envBoolean('WANJIER_ENABLE_STT') ?? asBoolean(raw.enable_stt, DEFAULT_AI_CONFIG.enable_stt || false),
    stt_model: asString(raw.stt_model, DEFAULT_AI_CONFIG.stt_model || asString(raw.vision_model, asString(raw.model, ''))),
    stt_provider: validAudioProviders.has(sttProvider) ? sttProvider as AIConfig['stt_provider'] : 'api',
    stt_payload_mode: validSttPayloadModes.has(sttPayloadMode) ? sttPayloadMode as AIConfig['stt_payload_mode'] : 'auto',
    stt_record_format: validSttRecordFormats.has(sttRecordFormat) ? sttRecordFormat as AIConfig['stt_record_format'] : 'mp3',
    stt_local_command: asString(raw.stt_local_command, DEFAULT_AI_CONFIG.stt_local_command || ''),
    stt_local_timeout_ms: Math.floor(asNumber(raw.stt_local_timeout_ms, DEFAULT_AI_CONFIG.stt_local_timeout_ms || 15000, 3000, 120000)),
    stt_max_records: Math.floor(asNumber(raw.stt_max_records, DEFAULT_AI_CONFIG.stt_max_records || 1, 1, 4)),
    stt_max_file_mb: asNumber(raw.stt_max_file_mb, DEFAULT_AI_CONFIG.stt_max_file_mb || 4, 0.5, 16),
    stt_timeout_ms: Math.floor(asNumber(raw.stt_timeout_ms, DEFAULT_AI_CONFIG.stt_timeout_ms || 20000, 3000, 120000)),
    stt_cache_hours: Math.floor(asNumber(raw.stt_cache_hours, DEFAULT_AI_CONFIG.stt_cache_hours || 24, 1, 720)),
    stt_cache_max_mb: Math.floor(asNumber(raw.stt_cache_max_mb, DEFAULT_AI_CONFIG.stt_cache_max_mb || 128, 8, 4096)),
    stt_cache_max_files: Math.floor(asNumber(raw.stt_cache_max_files, DEFAULT_AI_CONFIG.stt_cache_max_files || 3000, 50, 100000)),
    context_compression_defer_when_busy: asBoolean(raw.context_compression_defer_when_busy, DEFAULT_AI_CONFIG.context_compression_defer_when_busy !== false),
    enable_memory_retrieval: envBoolean('WANJIER_ENABLE_MEMORY_RETRIEVAL') ?? asBoolean(raw.enable_memory_retrieval, DEFAULT_AI_CONFIG.enable_memory_retrieval !== false),
    memory_top_k: Math.floor(asNumber(envNumber('WANJIER_MEMORY_TOP_K') ?? raw.memory_top_k, DEFAULT_AI_CONFIG.memory_top_k ?? 4, 0, 12)),
    memory_min_similarity: asNumber(envNumber('WANJIER_MEMORY_MIN_SIMILARITY') ?? raw.memory_min_similarity, DEFAULT_AI_CONFIG.memory_min_similarity ?? 0.18, 0.05, 0.95),
    memory_inject_max_chars: Math.floor(asNumber(envNumber('WANJIER_MEMORY_INJECT_MAX_CHARS') ?? raw.memory_inject_max_chars, DEFAULT_AI_CONFIG.memory_inject_max_chars ?? 700, 0, 3000)),
    memory_max_messages_per_session: Math.floor(asNumber(envNumber('WANJIER_MEMORY_MAX_MESSAGES_PER_SESSION') ?? raw.memory_max_messages_per_session, DEFAULT_AI_CONFIG.memory_max_messages_per_session ?? 700, 50, 5000)),
    memory_max_sessions_in_memory: Math.floor(asNumber(envNumber('WANJIER_MEMORY_MAX_SESSIONS_IN_MEMORY') ?? raw.memory_max_sessions_in_memory, DEFAULT_AI_CONFIG.memory_max_sessions_in_memory ?? 80, 5, 500)),
    tts_model: asString(raw.tts_model, DEFAULT_AI_CONFIG.tts_model || 'mimo-v2.5-tts'),
    tts_provider: validAudioProviders.has(ttsProvider) ? ttsProvider as AIConfig['tts_provider'] : 'api',
    tts_local_command: asString(raw.tts_local_command, DEFAULT_AI_CONFIG.tts_local_command || ''),
    tts_local_output_dir: asString(raw.tts_local_output_dir, DEFAULT_AI_CONFIG.tts_local_output_dir || 'voice_cache/local'),
    tts_local_timeout_ms: Math.floor(asNumber(raw.tts_local_timeout_ms, DEFAULT_AI_CONFIG.tts_local_timeout_ms || 15000, 3000, 120000)),
    tts_clone_model: asString(raw.tts_clone_model, DEFAULT_AI_CONFIG.tts_clone_model || 'mimo-v2.5-tts-voiceclone'),
    tts_clone_enabled: asBoolean(raw.tts_clone_enabled, DEFAULT_AI_CONFIG.tts_clone_enabled !== false),
    tts_sample_path: asString(raw.tts_sample_path, DEFAULT_AI_CONFIG.tts_sample_path || 'voice_sample.mp3'),
    tts_voice_prompt: asString(raw.tts_voice_prompt, DEFAULT_AI_CONFIG.tts_voice_prompt || ''),
    tts_max_chars: Math.floor(asNumber(raw.tts_max_chars, DEFAULT_AI_CONFIG.tts_max_chars || 120, 10, 500)),
    tts_send_mode: validTtsSendModes.has(ttsSendMode) ? ttsSendMode as AIConfig['tts_send_mode'] : 'base64',
    tts_timeout_ms: Math.floor(asNumber(raw.tts_timeout_ms, DEFAULT_AI_CONFIG.tts_timeout_ms || 20000, 3000, 120000)),
    tts_cache_hours: Math.floor(asNumber(raw.tts_cache_hours, DEFAULT_AI_CONFIG.tts_cache_hours || 24, 1, 720)),
    tts_cache_max_mb: Math.floor(asNumber(raw.tts_cache_max_mb, DEFAULT_AI_CONFIG.tts_cache_max_mb || 512, 8, 4096)),
    tts_cache_max_files: Math.floor(asNumber(raw.tts_cache_max_files, DEFAULT_AI_CONFIG.tts_cache_max_files || 3000, 50, 100000)),
    tts_sample_max_mb: Math.floor(asNumber(raw.tts_sample_max_mb, DEFAULT_AI_CONFIG.tts_sample_max_mb || 8, 1, 100)),
    tts_probability: asNumber(envNumber('WANJIER_TTS_PROBABILITY') ?? raw.tts_probability, DEFAULT_AI_CONFIG.tts_probability, 0, 1),
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
    config_version: Math.floor(asNumber(value.config_version, 0, 0, Number.MAX_SAFE_INTEGER)) || undefined,
    ws_url: wsUrl,
    login_check_interval_seconds: Math.floor(asNumber(value.login_check_interval_seconds, 60, 0, 3600)),
    login_check_api_timeout_ms: Math.floor(asNumber(value.login_check_api_timeout_ms, 5000, 1000, 60000)),
    bot_qq: configuredBotQq,
    bot_name: asString(value.bot_name, 'QQ Bot'),
    command_prefix: commandPrefix,
    admin_qq: parseEnvIntArray('WANJIER_ADMIN_QQ', asNumberArray(value.admin_qq)),
    enabled_groups: parseEnvIntArray('WANJIER_ENABLED_GROUPS', asNumberArray(value.enabled_groups)),
    ai: normalizeAiConfig(value.ai),
  };
}

export function loadConfig(configPath: string = CONFIG_PATH): BotConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 config.json: ${configPath}`);
  }

  let parsed: unknown;
  let originalText: string;
  try {
    originalText = fs.readFileSync(configPath, 'utf-8');
    parsed = JSON.parse(originalText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件 JSON 解析失败: ${message}`);
  }

  const normalized = normalizeConfig(parsed);

  // 自动迁移：如果用户config.json比标准化后的少字段，补回去
  // 这样升级后VPS不会因为缺新字段就丢失默认值
  try {
    if (isObject(parsed)) {
      const merged = mergeMissingFields(parsed, normalized);
      const newText = `${JSON.stringify(merged, null, 2)}\n`;
      if (newText !== originalText && newText.trim().length > 50) {
        const tmp = `${configPath}.migrate.${process.pid}.tmp`;
        fs.writeFileSync(tmp, newText, 'utf-8');
        fs.renameSync(tmp, configPath);
        console.log(`[Config] 自动补全了 config.json 中缺失的字段（已备份合并到原文件）`);
      }
    }
  } catch (err) {
    // 迁移失败不影响启动
    console.warn(`[Config] 自动迁移跳过: ${err instanceof Error ? err.message : err}`);
  }

  return normalized;
}

/** 把normalized中存在但raw里没有的字段补回去（不覆盖用户已设置的值） */
function mergeMissingFields(raw: PlainObject, normalized: BotConfig): PlainObject {
  const result: PlainObject = { ...raw };

  // 顶级字段
  const topFields = ['config_version', 'login_check_interval_seconds', 'login_check_api_timeout_ms', 'bot_name', 'command_prefix'] as const;
  for (const key of topFields) {
    if (!(key in result) && normalized[key as keyof BotConfig] !== undefined) {
      result[key] = normalized[key as keyof BotConfig] as any;
    }
  }

  // ai 字段
  if (isObject(result.ai) && normalized.ai) {
    const rawAi = result.ai;
    const mergedAi: PlainObject = { ...rawAi };
    for (const [key, value] of Object.entries(normalized.ai)) {
      if (key === 'presets' || key === 'api_key') continue; // 这些不动
      if (!(key in mergedAi) && value !== undefined && value !== null) {
        mergedAi[key] = value as any;
      }
    }
    result.ai = mergedAi;
  }

  return result;
}

export function updateConfigFile(
  mutator: (raw: PlainObject) => void,
  configPath: string = CONFIG_PATH,
): BotConfig {
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
  if (!isObject(parsed)) {
    throw new Error('配置文件必须是 JSON 对象');
  }

  mutator(parsed);
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, configPath);
  return normalizeConfig(parsed);
}
