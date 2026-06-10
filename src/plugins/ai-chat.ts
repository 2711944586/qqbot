import { Plugin, PluginContext, AIConfig, MessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { hasUsableApiKey } from '../config';
import { cleanSearchCache, configureSearchCache, webSearch } from './web-search';
import { cleanVoiceCache, generateVoice, getVoiceStats, inspectVoiceCache, installVoiceSample, removeVoiceSample } from './tts';
import { cleanSttCache, getSttStats, inspectSttCacheSources, transcribeRecords } from './stt';
import { cleanupCache as cleanImageCache, configureImageCache, getCacheStats as getImageCacheStats, getImageDataUrl, inspectImageCacheSources } from './image-cache';
import { configureGates, getGateStats, resetGates, withGate } from './concurrency';
import { sanitizeOutgoingText } from '../message-sanitize';
import { detectFuzzyCommand, detectCsTopicQuery } from './fuzzy-command';
import { fetchOngoingMatches, fetchTeamRanking, fetchRecentResults, fetchPlayerProfile, fetchTeamProfile, fetchMatchDetail } from './hltv-api';
import { prewarmPlayerImages } from './fun';
import {
  directTtsCommands,
  extractVerbatimVoiceText,
  isExplicitVoiceReplyRequest,
  normalizePassiveText,
  splitVoiceTextForTts,
  stripVoiceReplyInstruction,
} from './voice-intent';
import {
  commitKnowledgeCandidate,
  dropKnowledgeCandidate,
  getKnowledgeCandidate,
  getKnowledgeKeywords,
  getKnowledgeStats,
  importKnowledgeUrlCandidate,
  extractKnowledgeTitles,
  KnowledgeCandidate,
  KnowledgeFreshnessIssue,
  KnowledgeSource,
  auditKnowledge,
  autoCommitKnowledgeCandidate,
  describeKnowledgeCandidateQuality,
  getLastKnowledgeAudit,
  filterDueKnowledgeSources,
  findKnowledgeFreshnessIssuesForTitles,
  inspectKnowledgeSources,
  inspectKnowledgeInbox,
  inspectKnowledgeFreshness,
  inspectQuoteKnowledge,
  getRandomKnowledgeLine,
  isKnowledgeAutoEnabled,
  isKnowledgeTopic,
  knowledgeSourceEvidenceHint,
  listKnowledgeBatches,
  listKnowledgeCandidates,
  loadKnowledgeSources,
  markKnowledgeSourceRefreshed,
  markKnowledgeAutoRefresh,
  pruneKnowledgeAutoLog,
  previewInboxCandidates,
  previewKnowledgeCandidate,
  previewKnowledgeSourceTrust,
  recommendKnowledgeCandidateAction,
  rollbackKnowledgeBatch,
  searchKnowledge,
  selectKnowledge,
  selectStyleKnowledge,
  setKnowledgeAutoEnabled,
} from './knowledge-base';
import { closeKnowledgeDb } from './knowledge-db';
import { loadContext, writeSession, deleteSession, markDirty, setFlushHandler, getDirtySessions, listAllSessions, clearDirtySession, flushNow } from './context-store';
import { clearSessionIndex, getEmbeddingStats, MemorySearchResult } from './embedding-store';
import {
  ChatMessage,
  MessageContent,
  LLMCaller,
  LLMPostResult,
  callLLM as defaultCallLLM,
  callLLMWithRetry as runLLMWithRetry,
} from './llm-api';
import { ContextManager, SessionContext } from './ai-context';
import {
  extractImageUrls,
  extractRecordUrls,
  uniqueNonEmpty,
  isDirectMediaSource,
  firstMediaString,
  resolveOneBotImageSources,
  resolveOneBotRecordSources,
  voiceRecordSegment,
  isAtBot,
} from './media-utils';
import {
  postProcessReply,
  clampVoiceText,
  previewText,
  formatTime,
  parseFaceMarkers,
  softenUnverifiedClaims,
  hasUnsupportedRumorClaim,
  hasRealityBoundaryClaim,
  hasUnsupportedOriginalQuoteClaim,
} from './reply-postprocess';
import { parseStickerMarkers } from './sticker-pack';
import { buildThanks as buildGiftThanks, formatGiftThanksPreview, formatGiftThanksRecent, formatGiftThanksStatus, formatGiftThanksTrace, getGiftThanksStats, warmGiftThanksVoice } from './gift-thanks';
import { buildUserProfileRuntimeHint, handleUserProfileCommand } from './user-profile';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';

// ============ 类型 ============
// ChatMessage / MessageContent / LLMCaller 已从 ./llm-api 导入
// SessionContext / ContextManager 已从 ./ai-context 导入

interface ReplyJob {
  generation: number;
  sessionId: string;
  chatType: 'group' | 'private';
  chatId: number;
  groupId?: number;
  userId: number;
  selfId: number;
  messageId: number;
  senderName: string;
  rawText: string;
  effectiveText: string;
  imageUrls: string[];
  imageInputCount: number;
  recordUrls: string[];
  hasImages: boolean;
  hasRecords: boolean;
  forceVoice: boolean;
  command: string | null;
  isAtBot: boolean;
  isReplyToBot: boolean;
  repliedMessageId?: number;
  triggerReason: string;
  forced: boolean;
  createdAt: number;
  contextSummary: string;
  contextMessages: ChatMessage[];
}

interface ReplyTrace {
  timestamp: number;
  chatType: 'group' | 'private';
  chatId: number;
  groupId?: number;
  userId: number;
  messageId: number;
  senderName: string;
  triggerReason: string;
  forced: boolean;
  command?: string | null;
  rawTextPreview: string;
  effectiveTextPreview: string;
  hasImages: boolean;
  imageInputCount?: number;
  imageSourceKinds?: string[];
  imageSources?: string[];
  hasRecords: boolean;
  recordInputCount?: number;
  recordSourceKinds?: string[];
  recordSources?: string[];
  recordTranscripts: number;
  sttLimit?: number;
  sttTruncated?: boolean;
  queueAgeMs: number;
  contextMessagesSent?: number;
  contextFocused?: boolean;
  memoryHits?: number;
  memoryFiltered?: number;
  memoryFilterReasons?: string[];
  memoryPreview?: string[];
  searchUsed: boolean;
  searchChars: number;
  searchEvidence?: string[];
  knowledgeInjected: boolean;
  knowledgeChars: number;
  knowledgeTopic: boolean;
  knowledgeTitles: string[];
  knowledgeLanes?: string[];
  knowledgeFreshnessIssues?: string[];
  userProfileInjected?: boolean;
  userProfileChars?: number;
  styleScene?: string;
  styleSceneAction?: string;
  styleSceneSignals?: string[];
  styleSceneNeedsRealtime?: boolean;
  qualityIssues?: string[];
  qualityFinalOk?: boolean;
  evidenceSummary?: string[];
  evidenceLedger?: string[];
  realtimeFreshness?: string[];
  realtimeStaleEvidence?: boolean;
  realtimeIntent?: boolean;
  realtimeDataAvailable?: boolean;
  factGuard?: string;
  openerBefore?: string;
  openerAfter?: string;
  openerDeduped?: boolean;
  humanDelayMs?: number;
  sttError?: string;
  visionError?: string;
  searchError?: string;
  hltvUsed?: boolean;
  hltvChars?: number;
  hltvError?: string;
  visionPayload: boolean;
  visionImages?: number;
  visionLimit?: number;
  visionTruncated?: boolean;
  visionDataInfo?: string[];
  visionCacheBefore?: string[];
  visionCacheAfter?: string[];
  voiceRequested: boolean;
  voiceMode: 'none' | 'direct-verbatim' | 'ai-voice' | 'passive-voice';
  voiceParts: number;
  sent: 'queued' | 'text' | 'voice' | 'voice+text-fallback' | 'fallback' | 'skipped';
  cacheHit: boolean;
  cachePolicy?: string;
  cacheDecision?: string;
  cacheKeyPrefix?: string;
  cacheTtlSeconds?: number;
  replyLength: number;
  outputRepair?: string;
  freshnessRepair?: string;
  error?: string;
}

interface VoiceTrace {
  timestamp: number;
  mode: 'direct-verbatim' | 'ai-voice' | 'passive-voice';
  chatType: 'group' | 'private';
  chatId: number;
  groupId?: number;
  userId: number;
  messageId: number;
  requestedTextPreview: string;
  spokenTextPreview: string;
  spokenTextWarm?: string;
  parts: number;
  sentParts: number;
  provider: string;
  sendMode: string;
  lastTtsMode?: string;
  error?: string;
}

interface VoicePreflightAnalysis {
  raw: string;
  cleaned: string;
  maxChars: number;
  parts: string[];
  spokenChars: number;
  likelyTruncated: boolean;
  risks: string[];
  next: string[];
  stats: ReturnType<typeof getVoiceStats>;
}

interface ReplyQualityCheck {
  ok: boolean;
  issues: string[];
}

interface StyleEvidenceAnalysis {
  evidenceText: string;
  hasCurrentRealtimeData: boolean;
  hasEvidenceText: boolean;
  hasFresh: boolean;
  hasStale: boolean;
  hasMiss: boolean;
  staleOnly: boolean;
  freshness: string[];
  evidenceLines: string[];
  mode: string;
  boundary: string;
}

type StyleCsEvidenceTargetKind = 'matches' | 'results' | 'ranking' | 'match' | 'team' | 'player';

interface StyleCsEvidenceTarget {
  kind: StyleCsEvidenceTargetKind;
  subject: string;
  reason: string;
}

interface InFlightReplyResult {
  value: string;
  reusable: boolean;
  reuseRejectedReason?: string;
}

// ============ 上下文管理器 已迁移到 ./ai-context.ts ============

// ============ 工具函数 ============
// extractImageUrls / extractRecordUrls / uniqueNonEmpty / isDirectMediaSource
// firstMediaString / resolveOneBotImageSources / resolveOneBotRecordSources
// voiceRecordSegment / isAtBot 已迁移到 ./media-utils

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function hashDelaySeed(job: ReplyJob, text: string): number {
  const digest = crypto
    .createHash('sha1')
    .update([
      job.sessionId,
      job.messageId,
      job.userId,
      job.createdAt,
      text.slice(0, 80),
    ].join(':'))
    .digest();
  return digest.readUInt32BE(0);
}

function calculateHumanReplyDelayMs(config: AIConfig, job: ReplyJob, text: string): number {
  if (config.human_reply_delay_enabled === false) return 0;
  if (!text.trim()) return 0;
  if (Date.now() - job.createdAt > 2500) return 0;
  if (job.hasImages || job.hasRecords || job.forceVoice) return 0;

  const minRaw = job.forced
    ? (config.human_reply_delay_forced_min_ms ?? 120)
    : (config.human_reply_delay_min_ms ?? 250);
  const maxRaw = job.forced
    ? (config.human_reply_delay_forced_max_ms ?? 650)
    : (config.human_reply_delay_max_ms ?? 1400);
  const min = Math.max(0, Math.min(Math.floor(minRaw), Math.floor(maxRaw)));
  const max = Math.max(min, Math.max(Math.floor(minRaw), Math.floor(maxRaw)));
  if (max <= 0) return 0;

  const span = max - min + 1;
  const lengthBias = Math.min(Math.floor(span * 0.35), Math.max(0, text.length - 24) * 7);
  const jitter = hashDelaySeed(job, text) % (max - min + 1);
  return Math.min(max, min + jitter + lengthBias);
}

async function applyHumanReplyDelay(config: AIConfig, job: ReplyJob, text: string): Promise<number> {
  const ms = calculateHumanReplyDelayMs(config, job, text);
  if (ms <= 0) return 0;
  humanReplyDelayCount++;
  humanReplyDelayTotalMs += ms;
  lastHumanReplyDelayMs = ms;
  patchReplyTrace(job.messageId, { humanDelayMs: ms });
  await delay(ms);
  return ms;
}

function extractImagePartUrl(part: MessageContent): { url: string; detail?: string } {
  if (typeof part.image_url === 'string') return { url: part.image_url };
  if (part.image_url?.url) return { url: part.image_url.url, detail: part.image_url.detail };
  if (part.input_image?.image_url) return { url: part.input_image.image_url, detail: part.input_image.detail };
  if (part.input_image?.url) return { url: part.input_image.url, detail: part.input_image.detail };
  if (part.image) return { url: part.image };
  return { url: '' };
}

function convertVisionPart(part: MessageContent, mode: NonNullable<AIConfig['vision_payload_mode']>): MessageContent {
  if (part.type === 'text') return { type: 'text', text: part.text || '' };
  const image = extractImagePartUrl(part);
  if (!image.url) return part;
  if (mode === 'image_url_string') return { type: 'image_url', image_url: image.url };
  if (mode === 'input_image') return { type: 'input_image', image_url: image.url };
  if (mode === 'image_base64') return { type: 'image', image: image.url };
  return { type: 'image_url', image_url: { url: image.url, detail: image.detail || 'low' } };
}

function buildVisionMessageVariants(messages: ChatMessage[], mode: AIConfig['vision_payload_mode']): Array<{ label: string; messages: ChatMessage[] }> {
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

// ============ LLM API 调用 ============
function postLLMOnce(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, label: string = 'chat'): Promise<LLMPostResult> {
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
          }
          else fail(new Error(`${label}: 无内容返回`));
        } catch {
          fail(new Error(`${label}: 解析失败`));
        }
      });
    });

    req.on('error', (err) => fail(new Error(`${label}: 网络: ` + err.message)));
    req.setTimeout(timeoutMs, () => {
      fail(new Error(`${label}: 超时`));
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

function isLengthLimitedFinish(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === 'length' || normalized.includes('max_tokens') || normalized.includes('token_limit');
}

/** 检测内容是否在中文标点处被截断（即使finish_reason=stop也补救） */
function looksTruncated(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;
  // 看最后一个字符
  const last = trimmed[trimmed.length - 1];
  // 正常结束符
  const properEndings = /[。！？!?…)）"」』.\]]/;
  if (properEndings.test(last)) return false;
  // 以中文/英文/数字结尾且没有合适标点 = 可能截断
  return /[\u4e00-\u9fa5a-zA-Z0-9，,、/]/.test(last);
}

function appendContinuation(base: string, next: string): string {
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

function buildContinuationMessages(messages: ChatMessage[], partialReply: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: partialReply },
    {
      role: 'user',
      content: '刚才回复因为长度限制被截断了。请从断点自然续写补完，不要重头开始，不要解释原因，不要加标题。',
    },
  ];
}

async function postLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, label: string = 'chat'): Promise<string> {
  const maxContinuationRounds = 3;
  let currentMessages = messages;
  let combined = '';

  for (let round = 0; round <= maxContinuationRounds; round++) {
    const result = await postLLMOnce(config, currentMessages, useVision, round === 0 ? label : `${label}:continue${round}`);
    combined = appendContinuation(combined, result.content);
    // 触发续写：明确length截断 或 内容看起来被截断
    const needContinue = isLengthLimitedFinish(result.finishReason) || looksTruncated(combined);
    if (!needContinue) break;
    if (round >= maxContinuationRounds) break;
    currentMessages = buildContinuationMessages(messages, combined);
  }

  return combined.trim();
}

async function callLLM(config: AIConfig, messages: ChatMessage[], useVision: boolean = false): Promise<string> {
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

let llmCaller: LLMCaller = callLLM;

async function callLLMWithRetry(
  config: AIConfig,
  messages: ChatMessage[],
  useVision: boolean = false,
  maxAttempts: number = 3,
  shouldCancel?: () => boolean,
): Promise<string> {
  const caller = llmCaller;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (shouldCancel?.()) throw new Error('AI runtime stale');
    try {
      const result = await caller(config, messages, useVision);
      if (shouldCancel?.()) throw new Error('AI runtime stale');
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (shouldCancel?.()) throw new Error('AI runtime stale');
      if (attempt < maxAttempts - 1) {
        await delay(1000 * (attempt + 1));
        if (shouldCancel?.()) throw new Error('AI runtime stale');
      }
    }
  }
  throw lastError;
}

function callLLMWithRetryForJob(
  job: ReplyJob,
  config: AIConfig,
  messages: ChatMessage[],
  useVision: boolean = false,
  maxAttempts: number = 3,
): Promise<string> {
  return callLLMWithRetry(config, messages, useVision, maxAttempts, () => isReplyJobStale(job));
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

export function __setLLMCallerForTests(caller?: LLMCaller): void {
  aiRuntimeGeneration++;
  llmCaller = caller || callLLM;
}

export function __setReplyCacheEntryForTests(key: string, value: string, ttlMs: number): void {
  replyCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
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
  knowledgeInfo?: string,
  similarMemories?: string,
  styleSceneInfo?: string,
  userProfileInfo?: string,
): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (knowledgeInfo) {
    result.push({ role: 'system', content: `[临场笔记-本地语态与背景]\n${knowledgeInfo}` });
  }

  if (userProfileInfo) {
    result.push({ role: 'system', content: `[用户画像-自填偏好]\n${userProfileInfo}` });
  }

  if (styleSceneInfo) {
    result.push({ role: 'system', content: `[本条风格场景-不要外显]\n${styleSceneInfo}` });
  }

  if (summary) {
    result.push({ role: 'system', content: `[历史摘要]\n${summary}` });
  }

  if (similarMemories) {
    result.push({ role: 'system', content: `[相关历史片段，仅供参考，不要直接复述]\n${similarMemories}` });
  }

  result.push(...history);

  // 当前消息：如果有搜索信息，作为context追加在文本前
  if (searchInfo) {
    const realtimePack = buildRealtimeReferencePack(searchInfo);
    if (typeof currentMessage.content === 'string') {
      result.push({
        role: 'user',
        content: `${realtimePack}\n\n[当前消息]\n${currentMessage.content}`,
      });
    } else {
      // 多模态：在text part前加上搜索信息
      const newContent: MessageContent[] = [
        { type: 'text', text: realtimePack },
        ...currentMessage.content,
      ];
      result.push({ role: 'user', content: newContent });
    }
  } else {
    result.push(currentMessage);
  }

  return result;
}

function buildRealtimeReferencePack(searchInfo: string): string {
  const freshnessLines = extractRealtimeFreshnessLines(searchInfo, 8);
  const hasStaleEvidence = /(?:^|\n)\s*(?:缓存|当前缓存)\s*[:：].*\bstale\b/i.test(searchInfo)
    || /不能当实时结论/.test(searchInfo);
  const hasFreshEvidence = freshnessLines.some((line) => /\bfresh\b/i.test(line));
  const hasMissEvidence = /(?:^|\n)\s*(?:缓存|当前缓存)\s*[:：].*(?:\bmiss\b|还没有成功快照)/i.test(searchInfo)
    || freshnessLines.some((line) => /\bmiss\b|还没有成功快照/i.test(line));
  const staleOnly = hasStaleEvidence && !hasFreshEvidence;
  const evidenceLines = extractEvidenceLines(searchInfo, 3);
  const freshnessSummary = freshnessLines.length > 0
    ? freshnessLines.map((line) => `  * ${line}`).join('\n')
    : '  * 未看到缓存新鲜度行；只能按联网摘要/来源片段谨慎回答';
  return [
    '[实时事实参考]',
    '使用规则：',
    '- 下方是本条消息可用的联网/实时依据；回答事实问题时优先级高于本地知识和模型记忆。',
    '- 只说资料里出现的比分、排名、阵容、转会、日期；没出现的不要补完。',
    '- 如果资料没有覆盖用户问的具体点，就直接说“这点我得查最新的”，别凭印象编。',
    '证据新鲜度:',
    freshnessSummary,
    hasStaleEvidence ? '- 注意：资料里含 stale/旧缓存，只能当线索，不能说成最新实时结论。' : '',
    staleOnly ? '- 关键边界：本条实时资料只有 stale/旧缓存，没有 fresh；必须说“旧快照/线索/我得查最新”，不能报成“现在/最新”。' : '',
    hasMissEvidence ? '- 注意：miss/无快照表示本地没有证据，不等于没有比赛、没有赛果或没有变动。' : '',
    evidenceLines.length > 0 ? `来源线索: ${evidenceLines.join(' / ')}` : '',
    '- CS 相关优先级：CS API / HLTV / Liquipedia > 联网补充摘要 > 本地知识 > 模型记忆。',
    '资料：',
    searchInfo,
    '[/实时事实参考]',
  ].filter(Boolean).join('\n');
}

function extractEvidenceLines(text: string, maxLines: number = 5): string[] {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => (
      /^(?:来源|缓存|source|cache)\s*[:：]/i.test(line)
      || /(?:CS API|HLTV|Liquipedia|VRS|webSearch|拉取|链接|https?:\/\/)/i.test(line)
    ))
    .map((line) => line.replace(/\s+/g, ' ').slice(0, 120));
  return lines.filter((line, index, all) => all.indexOf(line) === index).slice(0, maxLines);
}

function extractRealtimeFreshnessLines(text: string, maxLines: number = 5): string[] {
  if (!text) return [];
  const result: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^(?:缓存|当前缓存)\s*[:：]/.test(line)) continue;
    if (/miss|还没有成功快照/.test(line)) {
      result.push(line.replace(/\s+/g, ' ').slice(0, 120));
      continue;
    }
    const key = (line.match(/^缓存\s*[:：]\s*([^\s，,]+)/) || [])[1] || (line.includes('当前缓存') ? '当前缓存' : 'cache');
    const status = /\bfresh\b|fresh，/i.test(line) ? 'fresh' : /\bstale\b|stale，|过期/.test(line) ? 'stale' : 'unknown';
    const age = (line.match(/age=(\d+s)/i) || line.match(/年龄\s*(\d+)s/) || [])[1];
    const ttl = (line.match(/ttl=(\d+s)/i) || line.match(/TTL\s*(\d+)s/i) || [])[1];
    const expired = (line.match(/expired=(\d+s)/i) || line.match(/已过期\s*(\d+)s/) || [])[1];
    const source = (line.match(/source=([^\s]+)/i) || line.match(/内部源\s*([^，\s]+)/) || [])[1];
    const parts = [`${key} ${status}`];
    if (age) parts.push(`age=${age}`);
    if (ttl) parts.push(`ttl=${ttl}`);
    if (expired) parts.push(`expired=${expired}`);
    if (source) parts.push(`source=${source}`);
    result.push(parts.join(' ').slice(0, 120));
    if (result.length >= maxLines) break;
  }
  return result.filter((line, index, all) => all.indexOf(line) === index);
}

function summarizeRealtimeEvidence(searchInfo: string, hltvLabels: string[], knowledgeTitles: string[], memoryHits: number): string[] {
  const result: string[] = [];
  if (hltvLabels.length > 0) result.push(`HLTV/CS API: ${hltvLabels.join(',')}`);
  const extracted = extractEvidenceLines(searchInfo, 4);
  result.push(...extracted);
  if (searchInfo && extracted.length === 0) {
    result.push(searchInfo.includes('[联网补充]') ? 'webSearch联网补充摘要' : '联网/实时摘要');
  }
  if (knowledgeTitles.length > 0) result.push(`知识库: ${knowledgeTitles.slice(0, 3).join(',')}`);
  if (memoryHits > 0) result.push(`RAG记忆: ${memoryHits}条`);
  return result.filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 8);
}

function extractCsMatchDetailId(text: string): string {
  const raw = text || '';
  const hasIntent = /(?:match\s*id|matchid|比赛id|赛果id|这场|那场|单场|详情|统计|数据|rating|adr|kast|谁c|谁C|谁杀|谁猛|谁发挥|地图比分|几比几|比分|赛后|战报|复盘|锐评)/i.test(raw);
  if (!hasIntent) return '';
  const explicit = raw.match(/(?:match\s*id|matchid|比赛id|赛果id)\s*[=：:\s#-]*(\d{4,})/i);
  if (explicit?.[1]) return explicit[1];
  const loose = raw.match(/(?:^|[^\d])(\d{6,})(?:[^\d]|$)/);
  return loose?.[1] || '';
}

interface AiRealtimeBoundaryTarget {
  label: string;
  verify: string;
  warmPlan: string;
}

const AI_CS_TEAM_TARGETS = new Set([
  'navi', 'vitality', 'spirit', 'faze', 'mouz', 'g2', 'falcons', 'astralis',
  'liquid', 'furia', 'heroic', 'mongolz', 'tyloo', 'lynn', 'cloud9',
]);

const AI_CS_PLAYER_TARGETS = new Set([
  'zywoo', 'donk', 'niko', 'm0nesy', 's1mple', 'ropz', 'sh1ro', 'magixx',
  'jl', 'b1t', 'hunter', 'aleksib', 'karrigan', 'device', 'broky', 'frozen',
  'apex', 'mezii', 'flamez', 'jimpphat', 'siuhy', 'kscerato', 'yuurih', 'cadian',
]);

function formatAiRealtimeTarget(kind: 'matches' | 'results' | 'ranking' | 'match' | 'team' | 'player' | 'all', subject = ''): AiRealtimeBoundaryTarget {
  if (kind === 'match' && subject) {
    return {
      label: `单场 ${subject}`,
      verify: `/cs verify match ${subject}`,
      warmPlan: `/cs warm plan match ${subject}`,
    };
  }
  if (kind === 'team' && subject) {
    return {
      label: `队伍 ${subject}`,
      verify: `/cs verify team ${subject}`,
      warmPlan: `/cs warm plan team ${subject}`,
    };
  }
  if (kind === 'player' && subject) {
    return {
      label: `选手 ${subject}`,
      verify: `/cs verify player ${subject}`,
      warmPlan: `/cs warm plan player ${subject}`,
    };
  }
  if (kind === 'ranking') {
    return { label: '战队排名', verify: '/cs verify ranking', warmPlan: '/cs warm plan ranking' };
  }
  if (kind === 'results') {
    return { label: '近期赛果', verify: '/cs verify results', warmPlan: '/cs warm plan results' };
  }
  if (kind === 'matches') {
    return { label: '当前/即将比赛', verify: '/cs verify matches', warmPlan: '/cs warm plan matches' };
  }
  return { label: 'CS 实时事实', verify: '/cs verify all', warmPlan: '/cs warm plan all' };
}

function extractAiCsProfileTarget(text: string): { kind: 'team' | 'player'; subject: string } | null {
  const match = text.match(/\b(zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9)\b/i);
  if (!match?.[1]) return null;
  const subject = match[1].trim();
  const key = subject.toLowerCase();
  if (AI_CS_TEAM_TARGETS.has(key)) return { kind: 'team', subject };
  if (AI_CS_PLAYER_TARGETS.has(key)) return { kind: 'player', subject };
  return null;
}

function inferAiRealtimeBoundaryTarget(rawText: string, hltvLabels: string[], realtimeFreshness: string[]): AiRealtimeBoundaryTarget {
  const combined = [rawText, hltvLabels.join(' '), realtimeFreshness.join(' ')].filter(Boolean).join('\n');
  const matchId = extractCsMatchDetailId(combined)
    || (combined.match(/(?:单场|match:)(\d{4,})/i) || [])[1]
    || '';
  if (matchId) return formatAiRealtimeTarget('match', matchId);

  const profileFromFreshness = combined.match(/\b(team|player):([A-Za-z0-9_.-]{2,})\s+(?:fresh|stale|miss|unknown)/i);
  if (profileFromFreshness?.[1] && profileFromFreshness?.[2]) {
    return formatAiRealtimeTarget(profileFromFreshness[1].toLowerCase() as 'team' | 'player', profileFromFreshness[2]);
  }

  const profile = extractAiCsProfileTarget(combined);
  if (profile) return formatAiRealtimeTarget(profile.kind, profile.subject);

  const topic = detectCsTopicQuery(rawText);
  const needsMatches = topic.needsMatches || /当前比赛|近期比赛|赛程|matches/i.test(combined);
  const needsRanking = topic.needsRanking || /HLTV排名|战队排名|ranking/i.test(combined);
  const needsResults = topic.needsResults || /最近战报|近期赛果|results/i.test(combined);
  const routedKinds = [
    needsMatches ? 'matches' : '',
    needsRanking ? 'ranking' : '',
    needsResults ? 'results' : '',
  ].filter(Boolean);
  if (routedKinds.length === 1) return formatAiRealtimeTarget(routedKinds[0] as 'matches' | 'ranking' | 'results');
  return formatAiRealtimeTarget('all');
}

function formatAiRealtimeBoundaryAppendix(
  job: ReplyJob,
  csRealtimeIntent: boolean,
  hasCurrentRealtimeData: boolean,
  realtimeFreshness: string[],
  realtimeStaleEvidence: boolean,
  hltvLabels: string[],
): string {
  if (!csRealtimeIntent || job.forceVoice) return '';
  const freshnessText = realtimeFreshness.join(' ');
  const hasFresh = /\bfresh\b/i.test(freshnessText);
  const hasStale = realtimeStaleEvidence || /\bstale\b|过期|旧缓存|不能当实时结论/i.test(freshnessText);
  const hasMiss = /\bmiss\b|无快照|没有成功快照|还没有成功快照/i.test(freshnessText);
  if (hasCurrentRealtimeData && !hasStale && !hasMiss) return '';

  const target = inferAiRealtimeBoundaryTarget(job.effectiveText || job.rawText, hltvLabels, realtimeFreshness);
  const lead = hasStale && !hasFresh
    ? `${target.label} 目前只有旧快照线索，不能当现在结论。`
    : hasStale
      ? `${target.label} 有部分旧快照，没被当前快照覆盖的点不能报成现在结论。`
      : hasMiss
        ? `${target.label} 这边没有成功快照，不能反推没有比赛、赛果或变动。`
        : `${target.label} 这边没有当前快照，不能硬报现在结论。`;
  return `事实边界：${lead}复核：${target.verify}；补证：管理员 ${target.warmPlan}。`;
}

function parseStoredMessageMeta(message: ChatMessage): { mid: number; uid: number; name: string; text: string } | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  const match = message.content.match(/^\[mid=(\d+)\s+uid=(\d+)\]\s*([^:：\n]{1,32})[:：]\s*([\s\S]*)$/);
  if (!match) return null;
  return {
    mid: Number(match[1]),
    uid: Number(match[2]),
    name: match[3],
    text: match[4] || '',
  };
}

function classifyImageSource(source: string): string {
  if (!source) return 'empty';
  if (source.startsWith('data:')) return 'data-url';
  if (source.startsWith('base64://')) return 'base64';
  if (source.startsWith('file://')) return 'file-url';
  if (/^https?:\/\//i.test(source)) return 'http-url';
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/')) return 'local-path';
  return 'unknown';
}

function summarizeImageSourceKinds(sources: string[]): string[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const kind = classifyImageSource(source || '');
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}${count > 1 ? `x${count}` : ''}`)
    .slice(0, 6);
}

function imageSegmentCount(message: MessageSegment[]): number {
  return message.filter((seg) => seg.type === 'image').length;
}

function compactVisionCacheInspect(items: ReturnType<typeof inspectImageCacheSources> | undefined): string[] {
  if (!items || items.length === 0) return [];
  return items.slice(0, 4).map((item, index) => {
    const key = item.cacheKey ? ` key=${item.cacheKey}` : '';
    const ttl = item.ttlSeconds > 0 ? ` ttl=${item.ttlSeconds}s` : '';
    const size = item.sizeKB > 0 ? ` ${item.sizeKB}KB` : '';
    return `${index + 1}:${item.status}${key}${ttl}${size}`;
  });
}

function formatVisionCacheEvidence(trace: ReplyTrace | null, maxItems = 4): string {
  if (!trace) return '';
  const before = compactTraceList(trace.visionCacheBefore, maxItems);
  const after = compactTraceList(trace.visionCacheAfter, maxItems);
  if (before && after) return `前 ${before} -> 后 ${after}`;
  if (before) return `前 ${before}`;
  if (after) return `后 ${after}`;
  return '';
}

function formatRecordTrace(trace: ReplyTrace): string {
  if (!trace.hasRecords) return '无';
  const count = trace.recordSourceKinds?.length ? ` ${compactTraceList(trace.recordSourceKinds, 4)}` : '';
  const inputCount = trace.recordInputCount || (trace.recordTranscripts > 0 ? trace.recordTranscripts : 0);
  const input = inputCount ? `(${inputCount})` : '';
  const transcriptTotal = inputCount ? `/${inputCount}` : '';
  const limit = trace.sttLimit ? ` max${trace.sttLimit}` : '';
  const truncated = trace.sttTruncated ? ' 已截断' : '';
  return `有${input}${count} 听写${trace.recordTranscripts}${transcriptTotal}${limit}${truncated}`;
}

function formatVisionTrace(trace: ReplyTrace): string {
  if (trace.visionPayload) {
    const count = typeof trace.visionImages === 'number' ? trace.visionImages : 0;
    const total = trace.imageInputCount || count;
    const limit = trace.visionLimit ? ` max${trace.visionLimit}` : '';
    const truncated = trace.visionTruncated ? ' 已截断' : '';
    const data = trace.visionDataInfo?.length ? ` ${compactTraceList(trace.visionDataInfo, 2)}` : '';
    return `已传图 ${count}/${total}${limit}${truncated}${data}`;
  }
  if (trace.visionError) return '失败';
  if (trace.hasImages) return '未传图';
  return '无图';
}

function formatVisionOnlyTrace(trace: ReplyTrace | null): string {
  if (!trace) return '还没有回复 trace。先发图 @ 一句，或跑 /vision test。';
  const sources = trace.imageSourceKinds?.length ? ` ${compactTraceList(trace.imageSourceKinds, 4)}` : '';
  const cacheEvidence = formatVisionCacheEvidence(trace);
  return [
    '最近识图 trace',
    `时间: ${formatTraceTime(trace.timestamp)}`,
    `消息: mid=${trace.messageId} uid=${trace.userId} ${trace.senderName}`,
    `原文: ${trace.rawTextPreview || '[空/媒体消息]'}`,
    `图片: ${trace.hasImages ? `有${trace.imageInputCount ? `(${trace.imageInputCount})` : ''}${sources}` : '无'}`,
    `识图: ${formatVisionTrace(trace)}`,
    cacheEvidence ? `图片缓存: ${cacheEvidence}` : '',
    trace.visionError ? `识图错误: ${trace.visionError}` : '',
    cacheEvidence ? '缓存边界: hit/inline/local-readable 只说明图片源可用或可复用，模型是否真看图以“识图: 已传图”和回复内容为准。' : '',
    '完整链路: /trace last',
  ].filter(Boolean).join('\n');
}

function formatVisionStatusLastTrace(trace: ReplyTrace | null): string {
  if (!trace) return '最近识图: 暂无回复 trace';
  const parts = [`最近识图: ${formatVisionTrace(trace)}`];
  if (trace.imageInputCount) parts.push(`输入${trace.imageInputCount}`);
  if (trace.imageSourceKinds?.length) parts.push(compactTraceList(trace.imageSourceKinds, 3));
  const cacheEvidence = formatVisionCacheEvidence(trace, 2);
  if (cacheEvidence) parts.push(`缓存${cacheEvidence}`);
  if (trace.visionError) parts.push(`错误${trace.visionError.slice(0, 80)}`);
  parts.push(formatTraceTime(trace.timestamp));
  return parts.join(' / ');
}

function formatVisionRecent(limit = 8): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, MAX_VISION_TRACES));
  const traces = recentVisionTraces.slice(0, safeLimit);
  if (traces.length === 0) {
    return [
      '识图最近记录',
      '最近: 无真实图片回复 trace',
      '说明: 只记录直接发图/强触发后的识图处理结果；/vision check 是只读预检，不会写入这里。',
    ].join('\n');
  }
  return [
    `识图最近记录 ${traces.length}/${recentVisionTraces.length}`,
    ...traces.map((trace, index) => {
      const time = new Date(trace.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const sources = trace.imageSourceKinds?.length ? ` ${compactTraceList(trace.imageSourceKinds, 4)}` : '';
      const images = trace.hasImages ? `有${trace.imageInputCount ? `(${trace.imageInputCount})` : ''}${sources}` : '无';
      const cache = formatVisionCacheEvidence(trace, 2);
      const error = trace.visionError ? ` error=${trace.visionError.slice(0, 80)}` : '';
      const text = trace.rawTextPreview ? ` | ${trace.rawTextPreview}` : '';
      return `${index + 1}. ${time} mid=${trace.messageId} uid=${trace.userId} ${trace.chatType}=${trace.chatId} 图片=${images} 识图=${formatVisionTrace(trace)}${cache ? ` cache=${cache}` : ''}${error}${text}`;
    }),
    '边界: 这里只读最近图片回复链路，方便排查真实传图数、截断、图片源类型、缓存前后状态、下载失败和模型失败；缓存命中不等于模型已理解图片。',
  ].join('\n');
}

function formatSttStatusLastTrace(trace: ReplyTrace | null): string {
  if (!trace) return '最近听写: 暂无回复 trace';
  return `最近听写: ${formatRecordTrace(trace)} / ${formatTraceTime(trace.timestamp)}`;
}

function describeDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (!match) return 'unknown-size';
  const mime = match[1];
  const rawLength = match[2].replace(/\s+/g, '').length;
  const bytes = Math.floor(rawLength * 3 / 4);
  return `${mime} ${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function looksLikeVisibleVisionDescription(text: string): boolean {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length < 8) return false;
  if (/无法查看|无法看到|不能查看|不能看到|没有看到图片|未提供图片|只是文本|作为.*模型|看不到图片/i.test(text)) return false;
  return /图|图片|画面|人物|队标|地图|武器|文字|截图|可见|看到|照片|界面|颜色|场景/.test(text);
}

function buildVisionStatusDiagnosis(
  config: AIConfig,
  stats: ReturnType<typeof getImageCacheStats>,
  apiReady: boolean,
  attachedImages: number,
): string[] {
  const issues: string[] = [];
  const next: string[] = [];
  if (!config.enable_vision) {
    issues.push('识图未开启');
    next.push('把 enable_vision 打开');
  }
  if (!(config.vision_model || config.model)) {
    issues.push('识图模型未配置');
    next.push('配置 vision_model 或 model');
  }
  if (config.enable_vision && !apiReady) {
    issues.push('AI接口不可用');
    next.push('检查 api_url/model/api_key');
  }
  if (stats.lastError) {
    issues.push(`最近图片下载错误: ${stats.lastError}`);
    next.push('先用 /vision test <图片URL> 定位下载还是模型问题');
  }
  const attached = attachedImages > 0
    ? `附图解析: 已拿到${attachedImages}张图片源`
    : '附图解析: 当前消息未附图';
  const diagnosis = issues.length > 0
    ? `诊断: ${issues.join(' / ')}`
    : '诊断: 识图配置看起来能跑';
  const nextLine = next.length > 0
    ? `下一步: ${next.join('；')}`
    : '下一步: /vision test <图片URL> 跑一次端到端链路';
  return [diagnosis, attached, nextLine];
}

async function formatVisionStatusPanel(ctx: PluginContext, config: AIConfig, apiReady: boolean): Promise<string> {
  const stats = getImageCacheStats();
  // 如果消息附带图片，顺便测试 get_image 解析。
  let attachedInfo = '';
  const attachedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
  if (attachedImages.length > 0) {
    const lines = attachedImages.slice(0, 2).map((source, index) => {
      const kind = classifyImageSource(source);
      return `  [${index}] ${kind}: ${source.slice(0, 80)}${source.length > 80 ? '...' : ''}`;
    });
    attachedInfo = '\n附带图片源:\n' + lines.join('\n');
  }
  const diagnosis = buildVisionStatusDiagnosis(config, stats, apiReady, attachedImages.length);
  return [
    '识图状态',
    ...diagnosis,
    `开关: ${config.enable_vision ? 'on' : 'off'}`,
    `模型: ${config.vision_model || config.model || '未配置'}`,
    `payload: ${config.vision_payload_mode || 'auto'} (会按模型兼容格式发送image_url/input_image/base64)`,
    `单次图片: ${config.vision_max_images || 2}`,
    `缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
    `单图上限: ${stats.maxFileMB}MB 跳转${stats.maxRedirects} 清理${stats.cleanupIntervalMinutes}m`,
    `最近记录: ${recentVisionTraces.length}/${MAX_VISION_TRACES}，看 /vision recent`,
    formatVisionStatusLastTrace(lastReplyTrace),
    ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
    attachedInfo,
    '/vision recent [条数]',
    '/vision check <图片URL或附图>',
    '/vision warm <图片URL或附图>',
    '/vision test <图片URL>',
    '提示: /vision check 只读；/vision warm 只下载进缓存；/vision test 端到端调模型',
  ].filter(Boolean).join('\n');
}

export function extractVisionCheckSources(text: string): string[] {
  const raw = (text || '').trim();
  if (!raw) return [];
  const matches = raw.match(/(?:https?:\/\/\S+|data:image\/[^\s]+|base64:\/\/\S+|file:\/\/\S+)/gi) || [];
  const sources = matches.map((item) => item.replace(/[，。！？!?,;；]+$/g, '').trim()).filter(Boolean);
  if (sources.length > 0) return uniqueNonEmpty(sources);
  return uniqueNonEmpty(raw.split(/\s+/).filter((item) => /^(?:[a-zA-Z]:[\\/]|\/|\\)/.test(item)));
}

function looksLikeAudioSource(source: string): boolean {
  const text = (source || '').toLowerCase();
  return /^data:audio\//.test(text)
    || /\.(?:mp3|wav|m4a|amr|ogg|opus|flac|aac)(?:[?#].*)?$/.test(text)
    || /(?:^|[?&])(?:audio|record|voice)=/.test(text);
}

function looksLikeImageSource(source: string): boolean {
  const text = (source || '').toLowerCase();
  if (/^data:image\//.test(text)) return true;
  if (looksLikeAudioSource(text)) return false;
  if (text.startsWith('base64://')) return true;
  if (/\.(?:png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/.test(text)) return true;
  return /^https?:\/\//i.test(source) || /^file:\/\//i.test(source) || /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('\\');
}

export function extractMediaCheckSources(text: string): { images: string[]; records: string[] } {
  const raw = (text || '').trim();
  if (!raw) return { images: [], records: [] };
  const matches = raw.match(/(?:https?:\/\/\S+|data:(?:image|audio)\/[^\s]+|base64:\/\/\S+|file:\/\/\S+)/gi) || [];
  const local = raw.split(/\s+/).filter((item) => /^(?:[a-zA-Z]:[\\/]|\/|\\)/.test(item));
  const sources = uniqueNonEmpty([...matches, ...local].map((item) => item.replace(/[，。！？!?,;；]+$/g, '').trim()));
  return {
    images: uniqueNonEmpty(sources.filter(looksLikeImageSource)),
    records: uniqueNonEmpty(sources.filter(looksLikeAudioSource)),
  };
}

function formatMediaPreflight(
  config: AIConfig,
  imageSources: string[],
  recordSources: string[],
  apiReady: boolean,
): string {
  const imageStats = getImageCacheStats();
  const sttStats = getSttStats(config);
  const imageInputCount = imageSources.length;
  const imageMax = Math.max(1, Math.min(config.vision_max_images || 2, 4));
  const imagePassCount = config.enable_vision ? Math.min(imageInputCount, imageMax) : 0;
  const imageTruncated = imageInputCount > imagePassCount;
  const recordInputCount = recordSources.length;
  const sttLimit = Math.max(1, Math.min(config.stt_max_records || 1, 4));
  const recordPassCount = config.enable_stt ? Math.min(recordInputCount, sttLimit) : 0;
  const recordTruncated = recordInputCount > recordPassCount;
  const risks: string[] = [];
  const next: string[] = [];
  const boundaries: string[] = [];

  if (imageInputCount === 0 && recordInputCount === 0) {
    risks.push('没有图片或语音源');
    next.push('附图/附语音，或传图片URL/音频URL');
    boundaries.push('只能按文字上下文回复，不要假装看图或听到语音。');
  }
  if (imageInputCount > 0 && !config.enable_vision) {
    risks.push('识图未开启');
    next.push('打开 enable_vision');
    boundaries.push('不能描述图片细节，只能请对方补文字或重发。');
  } else if (imageInputCount > 0 && config.enable_vision && !apiReady) {
    risks.push('识图API不可用');
    next.push('检查 api_url/model/api_key');
    boundaries.push('图片不会被模型实际看到，不能编造画面内容。');
  } else if (imageInputCount > 0) {
    boundaries.push(`只能描述实际传入模型的前${imagePassCount}张图片；看不清要直说。`);
  }
  if (imageTruncated) {
    risks.push(`图片会截断 ${imagePassCount}/${imageInputCount}`);
    next.push('减少图片数或调高 vision_max_images');
  }
  if (recordInputCount > 0 && !config.enable_stt) {
    risks.push('听写未开启');
    next.push('打开 enable_stt');
    boundaries.push('不能假装听到了语音内容，只能请对方补文字。');
  } else if (recordInputCount > 0 && config.enable_stt && ((sttStats.provider === 'api' && !apiReady) || (sttStats.provider === 'auto' && !sttStats.localReady && !apiReady))) {
    risks.push('听写后端不可用');
    next.push('配置本地STT或可用AI接口');
    boundaries.push('语音无法可靠听写，不能把猜测当语音内容。');
  } else if (recordInputCount > 0) {
    boundaries.push(`只能接听写成功的前${recordPassCount}条语音；空转写就说没听清。`);
  }
  if (recordTruncated) {
    risks.push(`语音会截断 ${recordPassCount}/${recordInputCount}`);
    next.push('减少语音条数或调高 stt_max_records');
  }
  if (imageStats.lastError) {
    risks.push(`最近图片错误: ${imageStats.lastError.slice(0, 60)}`);
    next.push('/vision test <图片URL> 定位下载/模型问题');
  }
  const imageCacheInspect = inspectImageCacheSources(imageSources, 3);
  const imageCacheLines = imageCacheInspect.map((item, index) => {
    const detail = item.status === 'hit'
      ? ` ttl=${item.ttlSeconds}s`
      : item.status === 'local-readable'
        ? ` ${item.sizeKB}KB`
        : '';
    return `图缓存${index + 1}: ${item.status}${detail} ${item.reason.slice(0, 42)}`;
  });
  if (imageCacheInspect.some((item) => item.status === 'miss' || item.status === 'expired')) {
    next.push('常用图片先 /vision warm 预热缓存');
  }
  const sttCacheInspect = inspectSttCacheSources(config, recordSources, 3);
  const sttCacheLines = sttCacheInspect.map((item, index) => {
    const detail = item.status === 'hit'
      ? ` chars=${item.chars} ttl=${item.ttlSeconds}s`
      : item.status === 'expired'
        ? ` age=${item.ageSeconds}s`
        : '';
    return `音缓存${index + 1}: ${item.status}${detail} ${item.reason.slice(0, 42)}`;
  });
  if (config.enable_stt && sttCacheInspect.some((item) => item.status === 'miss' || item.status === 'expired')) {
    next.push('常用语音先 /voice stt 预热听写缓存');
  }
  if (sttStats.lastError) {
    risks.push(`最近听写错误: ${sttStats.lastError.slice(0, 60)}`);
    next.push('/voice stt <语音URL> 定位听写问题');
  }

  return [
    '多模态预检',
    '模式: 只解析图片/语音源和配置，不下载图片、不听写语音、不调用模型',
    `图片: 输入${imageInputCount}张 / 将传${imagePassCount}/${imageInputCount} / max${imageMax}${imageTruncated ? ' 已截断' : ''}`,
    `图片源: ${summarizeImageSourceKinds(imageSources).join(' / ') || '无'}`,
    imageCacheLines.length ? `图片缓存预检: ${imageCacheLines.join(' / ')}` : '',
    `语音: 输入${recordInputCount}条 / 将听写${recordPassCount}/${recordInputCount} / max${sttLimit}${recordTruncated ? ' 已截断' : ''}`,
    `语音源: ${summarizeImageSourceKinds(recordSources).join(' / ') || '无'}`,
    sttCacheLines.length ? `语音缓存预检: ${sttCacheLines.join(' / ')}` : '',
    `配置: vision=${config.enable_vision ? 'on' : 'off'} model=${config.vision_model || config.model || '未配置'}；stt=${config.enable_stt ? 'on' : 'off'} ${sttStats.provider}${sttStats.localReady ? '/local-ready' : ''}`,
    `回复边界: ${boundaries.length ? boundaries.join('；') : '可以按实际可见/听写内容回复，事实和截图数据仍要留边界。'}`,
    ...imageSources.slice(0, 3).map((source, index) => `图${index + 1}: ${classifyImageSource(source)} ${previewText(source, 72)}`),
    ...recordSources.slice(0, 3).map((source, index) => `音${index + 1}: ${classifyImageSource(source)} ${previewText(source, 72)}`),
    imageSources.length + recordSources.length > 6 ? `... 还有${imageSources.length + recordSources.length - 6}个源未展示` : '',
    `风险: ${risks.length ? risks.join(' / ') : '无明显风险'}`,
    `下一步: ${next.length ? [...new Set(next)].join('；') : '需要真测图片用 /vision test；需要真测语音用 /voice stt'}`,
  ].filter(Boolean).join('\n');
}

function latestRecordReplyTrace(): ReplyTrace | null {
  return recentReplyTraces.find((trace) => trace.hasRecords || trace.recordInputCount || trace.sttError) || null;
}

function formatMediaLatestVoiceTrace(trace: VoiceTrace | null): string {
  if (!trace) return '最近语音: 无真实语音发送 trace';
  const age = formatTraceTime(trace.timestamp);
  const error = trace.error ? ` error=${trace.error.slice(0, 80)}` : '';
  return `最近语音: ${trace.mode} mid=${trace.messageId} parts=${trace.sentParts}/${trace.parts} tts=${trace.provider}/${trace.sendMode}${error} / ${age}`;
}

function getShanghaiDayParts(date: Date = new Date()): {
  dateKey: string;
  label: string;
  period: string;
} {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const parsedHour = Number.parseInt(get('hour'), 10);
  const hour = Number.isFinite(parsedHour) ? parsedHour % 24 : 0;
  const minute = get('minute') || '00';
  const period = hour < 6
    ? '凌晨'
    : hour < 12
      ? '上午'
      : hour < 14
        ? '中午'
        : hour < 18
          ? '下午'
          : hour < 23
            ? '晚上'
            : '深夜';
  return {
    dateKey: `${year}-${month}-${day}`,
    label: `${year}-${month}-${day} ${get('weekday') || ''} ${String(hour).padStart(2, '0')}:${minute}`,
    period,
  };
}

function pickDailyMediaLine(items: string[], seed: string): string {
  return items[hashIndex(seed, items.length)] || items[0] || '';
}

function isProviderReady(provider: string, localReady: boolean, apiReady: boolean): boolean {
  if (provider === 'local') return localReady;
  if (provider === 'auto') return localReady || apiReady;
  return apiReady;
}

function sameShanghaiDate(timestamp: number, dateKey: string): boolean {
  return !!timestamp && getShanghaiDayParts(new Date(timestamp)).dateKey === dateKey;
}

function countTodayMediaRuns(dateKey: string): {
  visionAttempts: number;
  visionPassed: number;
  sttAttempts: number;
  sttPassed: number;
  voiceAttempts: number;
  voicePassed: number;
} {
  const todayVision = recentVisionTraces.filter((trace) => sameShanghaiDate(trace.timestamp, dateKey));
  const todayRecords = recentReplyTraces.filter((trace) => (
    sameShanghaiDate(trace.timestamp, dateKey)
    && (trace.hasRecords || !!trace.recordInputCount || !!trace.sttError)
  ));
  const todayVoices = recentVoiceTraces.filter((trace) => sameShanghaiDate(trace.timestamp, dateKey));
  return {
    visionAttempts: todayVision.filter((trace) => trace.hasImages || trace.visionPayload || !!trace.visionError).length,
    visionPassed: todayVision.filter((trace) => trace.visionPayload && (trace.visionImages || 0) > 0 && !trace.visionError).length,
    sttAttempts: todayRecords.length,
    sttPassed: todayRecords.filter((trace) => (trace.recordTranscripts || 0) > 0 && !trace.sttError).length,
    voiceAttempts: todayVoices.length,
    voicePassed: todayVoices.filter((trace) => (trace.sentParts || 0) > 0 && !trace.error).length,
  };
}

function formatTodayMediaRuns(runs: ReturnType<typeof countTodayMediaRuns>): string {
  return [
    `识图${runs.visionPassed}/${runs.visionAttempts}`,
    `听写${runs.sttPassed}/${runs.sttAttempts}`,
    `发语音${runs.voicePassed}/${runs.voiceAttempts}`,
  ].join('；');
}

function formatMediaDailyChecklist(
  runs: ReturnType<typeof countTodayMediaRuns>,
  visionReady: boolean,
  sttReady: boolean,
  ttsReady: boolean,
): string {
  const item = (label: string, ready: boolean, passed: number, action: string): string => {
    if (!ready) return `${label}不可用`;
    if (passed > 0) return `${label}已实跑`;
    return `${label}待真测(${action})`;
  };
  return [
    item('识图', visionReady, runs.visionPassed, '/vision test'),
    item('听写', sttReady, runs.sttPassed, '/voice stt'),
    item('发语音', ttsReady, runs.voicePassed, '/voice test'),
  ].join('；');
}

function summarizeMediaDailyProgress(
  runs: ReturnType<typeof countTodayMediaRuns>,
  visionReady: boolean,
  sttReady: boolean,
  ttsReady: boolean,
): { progress: string; priority: string } {
  const items = [
    { label: '识图', ready: visionReady, passed: runs.visionPassed > 0, action: '/vision test <图片URL>' },
    { label: '听写', ready: sttReady, passed: runs.sttPassed > 0, action: '/voice stt <语音URL>' },
    { label: '发语音', ready: ttsReady, passed: runs.voicePassed > 0, action: '/voice test 今天语音链路短测一下' },
  ];
  const readyItems = items.filter((item) => item.ready);
  const doneItems = readyItems.filter((item) => item.passed);
  const missingItems = readyItems.filter((item) => !item.passed);
  const unavailable = items.filter((item) => !item.ready).map((item) => item.label);
  if (readyItems.length === 0) {
    return {
      progress: '0/0；三条链路都不可用，先看 /media status',
      priority: '/media status 查开关、模型和后端',
    };
  }
  const percent = Math.round((doneItems.length / readyItems.length) * 100);
  return {
    progress: `${doneItems.length}/${readyItems.length} (${percent}%)${unavailable.length ? `；不可用: ${unavailable.join('/')}` : ''}`,
    priority: missingItems.length
      ? `${missingItems[0].label}: ${missingItems[0].action}`
      : '三件套今天都有成功 trace；后面看 /media recent 3 排失败或截断',
  };
}

function formatMediaDaily(config: AIConfig, apiReady: boolean, date: Date = new Date()): string {
  const parts = getShanghaiDayParts(date);
  const imageStats = getImageCacheStats();
  const voiceStats = getVoiceStats(config);
  const sttStats = getSttStats(config);
  const latestVision = recentVisionTraces[0] || null;
  const latestRecord = latestRecordReplyTrace();
  const latestVoice = recentVoiceTraces[0] || lastVoiceTrace;
  const visionReady = !!config.enable_vision && !!(config.vision_model || config.model) && apiReady;
  const sttReady = !!config.enable_stt && isProviderReady(sttStats.provider, sttStats.localReady, apiReady);
  const ttsReady = !!config.enable_tts && isProviderReady(voiceStats.provider, voiceStats.localReady, apiReady);
  const todayRuns = countTodayMediaRuns(parts.dateKey);
  const seed = `${parts.dateKey}:${config.vision_model || config.model || ''}:${sttStats.provider}:${voiceStats.provider}`;
  const risks: string[] = [];
  const next: string[] = [];

  if (!config.enable_vision) {
    risks.push('识图off');
    next.push('需要看图就打开 enable_vision');
  } else if (!apiReady) {
    risks.push('识图API不可用');
    next.push('/vision status 查模型和接口');
  }
  if (!config.enable_stt) {
    risks.push('听写off');
    next.push('需要听语音就打开 enable_stt');
  } else if (!sttReady) {
    risks.push('听写后端不可用');
    next.push('/voice status 查 STT 后端');
  }
  if (!config.enable_tts) {
    risks.push('TTS off');
    next.push('需要发语音就打开 enable_tts');
  } else if (!ttsReady) {
    risks.push('TTS后端不可用');
    next.push('/voice status 查 TTS 后端');
  }
  if (voiceStats.cloneEnabled && !voiceStats.cloneReady) {
    risks.push(`克隆样本不可用(${voiceStats.sampleReason || 'missing'})`);
    next.push('/voice clone status 看授权样本');
  }
  if (imageStats.lastError) {
    risks.push(`最近图片错误:${imageStats.lastError.slice(0, 48)}`);
    next.push('/vision test <图片URL>');
  }
  if (sttStats.lastError) {
    risks.push(`最近听写错误:${sttStats.lastError.slice(0, 48)}`);
    next.push('/voice stt <语音URL>');
  }
  if (voiceStats.lastError) {
    risks.push(`最近TTS错误:${voiceStats.lastError.slice(0, 48)}`);
    next.push('/voice check <短句>');
  }
  if (visionReady && todayRuns.visionPassed === 0) {
    next.push('/vision test <图片URL> 真测今天看图链路');
  }
  if (sttReady && todayRuns.sttPassed === 0) {
    next.push('/voice stt <语音URL> 真测今天听写链路');
  }
  if (ttsReady && todayRuns.voicePassed === 0) {
    next.push('/voice test 今天语音链路短测一下');
  }

  const opener = pickDailyMediaLine([
    '今天多模态别玩玄学，能看就看清楚，听不清就别硬装。',
    '先把链路摸一下，别等群友发图了再现场拆炸弹。',
    '今天看图先讲可见信息，语音先看听写，别上来就编剧情。',
    '多模态这东西最怕嘴硬，缓存是缓存，真看过才算看过。',
    '今天也别把语音念成小作文，短句有力就行。',
  ], `${seed}:opener`);
  const task = !visionReady
    ? '今日小任务: 跑 /vision status，再用 /vision check <图片URL> 做只读预检。'
    : !sttReady
      ? '今日小任务: 跑 /voice status，再用 /voice sttcache <语音URL> 看听写缓存。'
      : !ttsReady
        ? '今日小任务: 跑 /voice check 这波语音链路测试一下，先确认文本分段和边界。'
        : `今日小任务: ${pickDailyMediaLine([
          '发一张截图问“帮我看图”，确认回复先说可见内容再短评。',
          '拿一条常用语音跑 /voice sttcache，看缓存和听写上限有没有踩线。',
          '用 /voice check 预检一句短吐槽，别让 TTS 念成长报告。',
          '看 /media recent 3，确认最近真实链路里有没有失败或截断。',
          '把常用图片先 /vision warm，后面再 /vision test 验证模型真看到了。',
        ], `${seed}:task`)}`;

  const health = [
    `识图${visionReady ? '可用' : '要查'}`,
    `听写${sttReady ? '可用' : '要查'}`,
    `发语音${ttsReady ? '可用' : '要查'}`,
  ].join(' / ');
  const missingRuns = [
    visionReady && todayRuns.visionPassed === 0 ? '今天还没有真实识图成功 trace' : '',
    sttReady && todayRuns.sttPassed === 0 ? '今天还没有真实听写成功 trace' : '',
    ttsReady && todayRuns.voicePassed === 0 ? '今天还没有真实发语音成功 trace' : '',
  ].filter(Boolean);
  const dailyProgress = summarizeMediaDailyProgress(todayRuns, visionReady, sttReady, ttsReady);

  return [
    `多模态每日牌 | ${parts.label} ${parts.period}`,
    '模式: 只读每日状态，不下载图片、不听写语音、不调用模型、不生成音频',
    opener,
    `今日链路: ${health}`,
    `今日实跑: ${formatTodayMediaRuns(todayRuns)}`,
    `今日三件套: ${formatMediaDailyChecklist(todayRuns, visionReady, sttReady, ttsReady)}`,
    `今日完成度: ${dailyProgress.progress}`,
    `优先补: ${dailyProgress.priority}`,
    '打卡口径: /vision test 成功传图、/voice stt 成功转写、/voice test 成功发出 record 才算；check/warm/cache hit 不算实跑。',
    `今日缺口: ${missingRuns.length ? missingRuns.join(' / ') : '三条链路今天都有成功 trace，继续看边界别嘴硬'}`,
    `开关: vision=${config.enable_vision ? 'on' : 'off'} max${config.vision_max_images || 2}；stt=${config.enable_stt ? 'on' : 'off'} max${config.stt_max_records || 1} ${sttStats.provider}${sttStats.localReady ? '/local-ready' : ''}；tts=${config.enable_tts ? 'on' : 'off'} ${voiceStats.provider}${voiceStats.localReady ? '/local-ready' : ''} send=${voiceStats.sendMode}`,
    `缓存: 图片${imageStats.count}/${imageStats.maxFiles} 命中${imageStats.hits}/${imageStats.misses}；听写${sttStats.cacheFiles}/${sttStats.maxCacheFiles} 命中${sttStats.hits}/${sttStats.misses}；TTS${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles} 命中${voiceStats.hits}/${voiceStats.misses}`,
    formatVisionStatusLastTrace(latestVision),
    `最近听写: ${latestRecord ? `${formatRecordTrace(latestRecord)} / ${formatTraceTime(latestRecord.timestamp)}` : '暂无真实听写 trace'}`,
    formatMediaLatestVoiceTrace(latestVoice),
    task,
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显配置/链路风险'}`,
    `下一步: ${next.length ? [...new Set(next)].join('；') : '/media check <图/语音> 只读预检；/vision test 真测图片；/voice stt 真测听写'}`,
    '边界: 不在 trace 里的图片/语音不能装作看过或听过；缓存 hit 不等于模型已看图或重新听音频；克隆/授权样本不能说成现实主播本人语音。',
  ].join('\n');
}

function formatMediaStatus(config: AIConfig, apiReady: boolean): string {
  const imageStats = getImageCacheStats();
  const voiceStats = getVoiceStats(config);
  const sttStats = getSttStats(config);
  const giftStats = getGiftThanksStats();
  const latestVision = recentVisionTraces[0] || null;
  const latestRecord = latestRecordReplyTrace();
  const risks: string[] = [];

  if (!config.enable_vision) risks.push('识图off');
  else if (!apiReady) risks.push('识图API不可用');
  if (!config.enable_stt) risks.push('听写off');
  else if ((sttStats.provider === 'api' && !apiReady) || (sttStats.provider === 'auto' && !sttStats.localReady && !apiReady)) risks.push('听写后端不可用');
  if (!config.enable_tts) risks.push('TTS off');
  else if (voiceStats.provider === 'local' && !voiceStats.localReady) risks.push('本地TTS未配置');
  else if (voiceStats.provider === 'api' && !apiReady) risks.push('TTS API不可用');
  else if (voiceStats.provider === 'auto' && !voiceStats.localReady && !apiReady) risks.push('TTS auto无可用后端');
  if (voiceStats.cloneEnabled && !voiceStats.cloneReady) risks.push(`克隆样本不可用(${voiceStats.sampleReason || 'missing'})`);
  if (voiceStats.sendMode !== 'base64') risks.push(`TTS发送${voiceStats.sendMode}可能受容器路径影响`);
  if (imageStats.lastError) risks.push(`最近图片错误:${imageStats.lastError.slice(0, 60)}`);
  if (sttStats.lastError) risks.push(`最近听写错误:${sttStats.lastError.slice(0, 60)}`);
  if (voiceStats.lastError) risks.push(`最近TTS错误:${voiceStats.lastError.slice(0, 60)}`);

  return [
    '多模态状态',
    '模式: 只读聚合状态，不下载图片、不听写语音、不调用模型、不生成音频',
    `开关: vision=${config.enable_vision ? 'on' : 'off'} max${config.vision_max_images || 2} model=${config.vision_model || config.model || '未配置'}；stt=${config.enable_stt ? 'on' : 'off'} max${config.stt_max_records || 1} ${sttStats.provider}${sttStats.localReady ? '/local-ready' : ''}；tts=${config.enable_tts ? 'on' : 'off'} ${voiceStats.provider}${voiceStats.localReady ? '/local-ready' : ''} send=${voiceStats.sendMode}`,
    `图片缓存: ${imageStats.count}/${imageStats.maxFiles}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB 命中${imageStats.hits}/${imageStats.misses} 失败${imageStats.downloadFailures} 飞行${imageStats.inFlight}`,
    formatVisionStatusLastTrace(latestVision),
    `听写缓存: ${sttStats.cacheFiles}/${sttStats.maxCacheFiles}条 ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 命中${sttStats.hits}/${sttStats.misses} 飞行${sttStats.inFlight} 空转写${sttStats.transcriptMisses}`,
    `最近听写: ${latestRecord ? `${formatRecordTrace(latestRecord)} / ${formatTraceTime(latestRecord.timestamp)}` : '暂无真实听写 trace'}`,
    `语音缓存: ${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles}条 ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB 命中${voiceStats.hits}/${voiceStats.misses} 飞行${voiceStats.inFlight} 合并${voiceStats.inFlightHits}`,
    `克隆: ${voiceStats.cloneEnabled ? (voiceStats.cloneReady ? 'ready' : `missing${voiceStats.sampleReason ? `(${voiceStats.sampleReason})` : ''}`) : 'off'} 样本${voiceStats.sampleSizeMB}MB`,
    formatMediaLatestVoiceTrace(recentVoiceTraces[0] || lastVoiceTrace),
    `礼物: 收到${giftStats.totalGiftNotices} 已谢${giftStats.sentThanks} 节流${giftStats.throttledThanks} 忽略${giftStats.ignoredThanks} 语音${giftStats.giftVoiceSent}/${giftStats.giftVoiceAttempts} 最近${giftStats.recentTraces}`,
    giftStats.lastGiftTrace ? `最近礼物: group=${giftStats.lastGiftTrace.groupId || '-'} uid=${giftStats.lastGiftTrace.senderId || '-'} ${giftStats.lastGiftTrace.gift || '礼物'}x${giftStats.lastGiftTrace.count || 1} ${giftStats.lastGiftTrace.action}/${giftStats.lastGiftTrace.reason} voice=${giftStats.lastGiftTrace.voiceAction}/${giftStats.lastGiftTrace.voiceReason || '-'}` : '最近礼物: 无真实礼物事件',
    `记录: vision ${recentVisionTraces.length}/${MAX_VISION_TRACES} voice ${recentVoiceTraces.length}/${MAX_VOICE_TRACES} reply ${recentReplyTraces.length}/${MAX_REPLY_TRACES} gift ${giftStats.recentTraces}`,
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显配置/链路风险'}`,
    '回复边界: 不在 trace 里的图片/语音不能装作看过或听过；克隆/授权样本不能说成现实主播本人语音；礼物感谢是拟态模板，不是核验原话。',
    '查看: /media recent 3；单项: /vision recent、/voice recent、/gift recent、/trace recent',
  ].join('\n');
}

function formatMediaRecent(limit = 3): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 3, 5));
  return [
    `多模态最近记录 ${safeLimit}`,
    '模式: 只读汇总真实链路；check/cache/warm 等预检命令不会写入这里。',
    '--- 识图 ---',
    formatVisionRecent(safeLimit),
    '--- 语音 ---',
    formatVoiceRecent(safeLimit),
    '--- 礼物 ---',
    formatGiftThanksRecent(safeLimit),
    '边界: 这里汇总的是最近真实处理结果；没出现在记录里的输入不能当作已看/已听/已感谢。',
  ].join('\n');
}

export function getMediaObservabilitySnapshot(): {
  visionTraces: number;
  maxVisionTraces: number;
  voiceTraces: number;
  maxVoiceTraces: number;
  replyTraces: number;
  maxReplyTraces: number;
  giftTraces: number;
  todayRuns: string;
  lastVisionSummary: string;
  lastRecordSummary: string;
  lastVoiceSummary: string;
  lastGiftSummary: string;
  boundary: string;
  hint: string;
} {
  const todayRuns = formatTodayMediaRuns(countTodayMediaRuns(getShanghaiDayParts().dateKey));
  const latestVision = recentVisionTraces[0] || null;
  const latestRecord = latestRecordReplyTrace();
  const latestVoice = recentVoiceTraces[0] || lastVoiceTrace;
  const giftStats = getGiftThanksStats();
  const lastGift = giftStats.lastGiftTrace;
  const lastVisionSummary = latestVision
    ? `mid=${latestVision.messageId} ${formatVisionTrace(latestVision)} / ${formatTraceTime(latestVision.timestamp)}`
    : '无真实图片回复 trace';
  const lastRecordSummary = latestRecord
    ? `mid=${latestRecord.messageId} ${formatRecordTrace(latestRecord)} / ${formatTraceTime(latestRecord.timestamp)}`
    : '无真实听写 trace';
  const lastVoiceSummary = latestVoice
    ? `mid=${latestVoice.messageId} ${latestVoice.mode} parts=${latestVoice.sentParts}/${latestVoice.parts} tts=${latestVoice.provider}/${latestVoice.sendMode}${latestVoice.error ? ` error=${latestVoice.error.slice(0, 60)}` : ''} / ${formatTraceTime(latestVoice.timestamp)}`
    : '无真实语音发送 trace';
  const lastGiftSummary = lastGift
    ? `#${lastGift.id} ${lastGift.action}/${lastGift.reason} voice=${lastGift.voiceAction}/${lastGift.voiceReason || '-'} / ${formatTraceTime(lastGift.timestamp)}`
    : '无真实礼物事件';
  return {
    visionTraces: recentVisionTraces.length,
    maxVisionTraces: MAX_VISION_TRACES,
    voiceTraces: recentVoiceTraces.length,
    maxVoiceTraces: MAX_VOICE_TRACES,
    replyTraces: recentReplyTraces.length,
    maxReplyTraces: MAX_REPLY_TRACES,
    giftTraces: giftStats.recentTraces,
    todayRuns,
    lastVisionSummary,
    lastRecordSummary,
    lastVoiceSummary,
    lastGiftSummary,
    boundary: '没有进入真实链路的图片/语音不能当作已看/已听；克隆/授权样本不能说成现实主播本人语音；礼物感谢是拟态模板。',
    hint: '/media status 看完整聚合，/media recent 3 看最近真实链路。',
  };
}

export interface WarmupCandidate {
  value: string;
  preview: string;
  status: string;
  reason: string;
  command: string;
  trace: string;
}

export interface MediaWarmupCandidateSnapshot {
  images: WarmupCandidate[];
  records: WarmupCandidate[];
  voiceTexts: WarmupCandidate[];
  traceCounts: {
    vision: number;
    records: number;
    voice: number;
  };
}

function commandTextCandidate(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function uniqueWarmupCandidates<T extends { value: string }>(items: T[], limit: number): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = item.value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

export function getMediaWarmupCandidates(config: AIConfig, limit = 5): MediaWarmupCandidateSnapshot {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 5, 10));
  const images = uniqueWarmupCandidates(recentVisionTraces.flatMap((trace) => {
    return (trace.imageSources || []).map((source) => {
      const inspected = inspectImageCacheSources([source], 1)[0];
      return {
        value: source,
        preview: previewText(source, 120),
        status: inspected?.status || 'unknown',
        reason: inspected?.reason || '无图片缓存检查结果',
        command: `/maint warm vision ${source}`,
        trace: warmupTraceLabel(trace.timestamp, trace.messageId, trace.chatType, trace.chatId),
      };
    });
  }), safeLimit);

  const records = uniqueWarmupCandidates(recentReplyTraces.flatMap((trace) => {
    return (trace.recordSources || []).map((source) => {
      const inspected = inspectSttCacheSources(config, [source], 1)[0];
      return {
        value: source,
        preview: previewText(source, 120),
        status: inspected?.status || 'unknown',
        reason: inspected?.reason || '无听写缓存检查结果',
        command: `/voice stt ${source}`,
        trace: warmupTraceLabel(trace.timestamp, trace.messageId, trace.chatType, trace.chatId),
      };
    });
  }), safeLimit);

  const voiceTexts = uniqueWarmupCandidates(recentVoiceTraces.map((trace) => {
    const text = commandTextCandidate(trace.spokenTextWarm || trace.spokenTextPreview);
    const inspected = text ? inspectVoiceCache(config, [text]).parts[0] : undefined;
    return {
      value: text,
      preview: previewText(text, 120),
      status: inspected?.status || 'invalid',
      reason: inspected?.reason || '没有可预热的短语音文本',
      command: text ? `/maint warm voice ${text}` : '/maint warm voice <常用短句>',
      trace: warmupTraceLabel(trace.timestamp, trace.messageId, trace.chatType, trace.chatId),
    };
  }).filter((item) => item.value.length >= 2), safeLimit);

  return {
    images,
    records,
    voiceTexts,
    traceCounts: {
      vision: recentVisionTraces.length,
      records: recentReplyTraces.filter((trace) => (trace.recordSources || []).length > 0).length,
      voice: recentVoiceTraces.length,
    },
  };
}

function formatVisionPreflight(
  config: AIConfig,
  sources: string[],
  apiReady: boolean,
): string {
  const stats = getImageCacheStats();
  const inputCount = sources.length;
  const maxImages = Math.max(1, Math.min(config.vision_max_images || 2, 4));
  const passCount = Math.min(inputCount, maxImages);
  const truncated = inputCount > passCount;
  const sourceKinds = summarizeImageSourceKinds(sources);
  const risks: string[] = [];
  const next: string[] = [];

  if (!config.enable_vision) {
    risks.push('识图未开启');
    next.push('打开 enable_vision');
  }
  if (!(config.vision_model || config.model)) {
    risks.push('识图模型未配置');
    next.push('配置 vision_model 或 model');
  }
  if (config.enable_vision && !apiReady) {
    risks.push('AI接口不可用');
    next.push('检查 api_url/model/api_key');
  }
  if (inputCount === 0) {
    risks.push('没有图片源');
    next.push('带图片或传图片URL');
  }
  if (truncated) {
    risks.push(`会按 vision_max_images 截断 ${passCount}/${inputCount}`);
    next.push('减少图片数或调高 vision_max_images');
  }
  if (sources.some((source) => ['file-url', 'local-path'].includes(classifyImageSource(source)))) {
    risks.push('本地/文件路径需要 bot 进程可读');
    next.push('Docker/NapCat 路径不通时用 base64 或 HTTP URL');
  }
  if (sources.some((source) => classifyImageSource(source) === 'unknown')) {
    risks.push('存在未知图片源格式');
    next.push('优先用 http(s)、base64、data:image 或直接附图');
  }
  if (stats.count >= Math.max(1, Math.floor(stats.maxFiles * 0.9))) {
    risks.push('图片缓存文件数接近上限');
    next.push('必要时跑 /maint clean 或调 image_cache_max_files');
  }
  if (stats.sizeMB >= stats.maxSizeMB * 0.9) {
    risks.push('图片缓存容量接近上限');
    next.push('必要时跑 /maint clean 或调 image_cache_max_mb');
  }
  if (stats.lastError) {
    risks.push(`最近下载错误: ${stats.lastError.slice(0, 80)}`);
    next.push('用 /vision test <图片URL> 做端到端定位');
  }
  const cacheInspect = inspectImageCacheSources(sources, 4);
  const cacheInspectSummary = cacheInspect.map((item, index) => {
    const detail = item.status === 'hit'
      ? ` ttl=${item.ttlSeconds}s ${item.sizeKB}KB`
      : item.status === 'expired'
        ? ' 已过期'
        : item.status === 'local-readable'
          ? ` ${item.sizeKB}KB`
          : '';
    return `${index + 1}. ${item.status}${detail} ${item.reason.slice(0, 48)}`;
  });
  if (cacheInspect.some((item) => item.status === 'miss' || item.status === 'expired')) {
    next.push('常用图片可先跑 /vision warm 预热图片缓存');
  }
  if (cacheInspect.some((item) => item.status === 'local-missing')) {
    risks.push('存在本地图片路径不可读');
  }

  return [
    '识图预检',
    '模式: 只解析图片源和配置，不下载图片，不调用模型',
    `开关: ${config.enable_vision ? 'on' : 'off'} 模型=${config.vision_model || config.model || '未配置'} payload=${config.vision_payload_mode || 'auto'}`,
    `图片: 输入${inputCount}张 / 将传${passCount}/${inputCount} / max${maxImages}${truncated ? ' 已截断' : ''}`,
    `来源类型: ${sourceKinds.join(' / ') || '无'}`,
    `缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
    cacheInspectSummary.length ? '缓存预检:' : '',
    ...cacheInspectSummary,
    ...sources.slice(0, 4).map((source, index) => `${index + 1}. ${classifyImageSource(source)} ${previewText(source, 86)}`),
    sources.length > 4 ? `... 还有${sources.length - 4}张未展示` : '',
    `风险: ${risks.length ? risks.join(' / ') : '无明显风险'}`,
    `下一步: ${next.length ? [...new Set(next)].join('；') : '可以 /vision test <图片URL> 做真实下载+模型测试'}`,
  ].filter(Boolean).join('\n');
}

function imageCacheInspectStatusSummary(items: ReturnType<typeof inspectImageCacheSources>): string {
  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return ['hit', 'miss', 'in-flight', 'expired', 'inline', 'local-readable', 'local-missing', 'too-large', 'invalid']
    .map((key) => `${key} ${counts[key] || 0}`)
    .join(' / ');
}

export async function formatVisionCacheWarm(
  config: AIConfig,
  sources: string[],
  warmSource: (source: string) => Promise<string | null>,
): Promise<string> {
  const uniqueSources = uniqueNonEmpty(sources.map((source) => source.trim()).filter(Boolean));
  if (uniqueSources.length === 0) return '/vision warm <图片URL>\n也可以把图片和 /vision warm 发在同一条消息里';
  const maxWarm = Math.max(1, Math.min(config.vision_max_images || 2, 4));
  const targets = uniqueSources.slice(0, maxWarm);
  const truncated = uniqueSources.length > targets.length;
  const before = inspectImageCacheSources(targets, maxWarm);
  const actions: string[] = [];
  let warmed = 0;
  let hit = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of before) {
    const index = actions.length + 1;
    if (item.status === 'hit') {
      hit++;
      actions.push(`${index}. hit/no-op key=${item.cacheKey} ttl=${item.ttlSeconds}s ${item.sizeKB}KB`);
      continue;
    }
    if (item.kind !== 'remote') {
      skipped++;
      actions.push(`${index}. skip ${item.status} ${previewText(item.reason, 48)}`);
      continue;
    }
    if (item.status === 'invalid' || item.status === 'too-large') {
      skipped++;
      actions.push(`${index}. skip ${item.status} ${previewText(item.reason, 48)}`);
      continue;
    }
    const dataUrl = await warmSource(item.source);
    const afterOne = inspectImageCacheSources([item.source], 1)[0];
    if (dataUrl && afterOne?.status === 'hit') {
      warmed++;
      actions.push(`${index}. warmed key=${afterOne.cacheKey} ${afterOne.sizeKB}KB ${describeDataUrl(dataUrl)}`);
    } else {
      failed++;
      const stats = getImageCacheStats();
      actions.push(`${index}. fail key=${item.cacheKey} ${previewText(stats.lastError || afterOne?.reason || 'unknown', 80)}`);
    }
  }

  const after = inspectImageCacheSources(targets, maxWarm);
  const risks: string[] = [];
  const next: string[] = [];
  if (truncated) {
    risks.push(`预热按 vision_max_images 截断 ${targets.length}/${uniqueSources.length}`);
    next.push('减少图片数或调高 vision_max_images');
  }
  if (failed > 0) {
    risks.push('存在图片下载失败');
    next.push('/vision test <图片URL> 定位下载/模型链路');
  }
  if (after.some((item) => item.status === 'expired' || item.status === 'miss')) {
    risks.push('预热后仍有未命中或过期图片');
  }
  const stats = getImageCacheStats();
  if (stats.sizeMB >= stats.maxSizeMB * 0.9) {
    risks.push('图片缓存容量接近上限');
    next.push('必要时跑 /maint clean 或调 image_cache_max_mb');
  }
  if (stats.count >= Math.max(1, Math.floor(stats.maxFiles * 0.9))) {
    risks.push('图片缓存文件数接近上限');
    next.push('必要时跑 /maint clean 或调 image_cache_max_files');
  }

  return [
    '图片缓存预热',
    '模式: 真实下载图片写入 image_cache，不调用视觉模型，不生成AI回复',
    `图片: 输入${uniqueSources.length}张 / 预热${targets.length}/${uniqueSources.length} / max${maxWarm}${truncated ? ' 已截断' : ''}`,
    `来源: ${summarizeImageSourceKinds(targets).join(' / ') || '无'}`,
    `预热前: ${imageCacheInspectStatusSummary(before)}`,
    `预热动作: warmed ${warmed} / hit ${hit} / skipped ${skipped} / failed ${failed}`,
    ...actions.slice(0, 6),
    actions.length > 6 ? `... 还有${actions.length - 6}条动作未展示` : '',
    `预热后: ${imageCacheInspectStatusSummary(after)}`,
    `缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显风险'}`,
    '边界: 图片缓存命中只代表下载文件可复用，不代表模型已经看过图片；要验证识图质量仍需 /vision test。',
    `下一步: ${next.length ? [...new Set(next)].join('；') : '可以 /vision check 复查 hit，或 /vision test 做端到端识图测试'}`,
  ].filter(Boolean).join('\n');
}

export async function formatMediaCacheWarm(
  config: AIConfig,
  imageSources: string[],
  recordSources: string[],
  apiReady: boolean,
  warmImageSource: (source: string) => Promise<string | null>,
): Promise<string> {
  const images = uniqueNonEmpty(imageSources.map((source) => source.trim()).filter(Boolean));
  const records = uniqueNonEmpty(recordSources.map((source) => source.trim()).filter(Boolean));
  if (images.length === 0 && records.length === 0) {
    return '/media warm <图片URL/语音URL或附图附语音>\n图片会真实下载进缓存；语音只做STT缓存预检。';
  }
  const imagePanel = images.length > 0
    ? await formatVisionCacheWarm(config, images, warmImageSource)
    : '图片缓存预热\n图片: 无';
  const recordPanel = records.length > 0
    ? formatSttCachePreflight(config, records, apiReady)
    : '听写缓存预检\n语音: 无';
  return [
    '多模态缓存预热',
    '模式: 图片真实下载写入 image_cache；语音只读检查STT缓存，不听写、不调用模型',
    '--- 图片 ---',
    imagePanel,
    '--- 语音 ---',
    recordPanel,
    '总边界: 预热命中只代表缓存可复用，不代表模型已经看过图片或听过语音；真实内容仍以 /vision test 和 /voice stt 为准。',
  ].join('\n');
}

function buildVoiceStatusDiagnosis(
  config: AIConfig,
  voiceStats: ReturnType<typeof getVoiceStats>,
  sttStats: ReturnType<typeof getSttStats>,
  apiReady: boolean,
): string[] {
  const next = new Set<string>();
  let ttsDiagnosis = 'TTS诊断: 可用';
  const ttsProvider = voiceStats.provider;
  if (!config.enable_tts) {
    ttsDiagnosis = 'TTS诊断: 未开启';
    next.add('需要发语音就打开 enable_tts');
  } else if (ttsProvider === 'local' && !voiceStats.localReady) {
    ttsDiagnosis = 'TTS诊断: 本地TTS未配置';
    next.add('填 tts_local_command，或把 tts_provider 改成 api/auto');
  } else if (ttsProvider === 'api' && !apiReady) {
    ttsDiagnosis = 'TTS诊断: API后端不可用';
    next.add('检查 api_url/model/api_key');
  } else if (ttsProvider === 'auto' && !voiceStats.localReady && !apiReady) {
    ttsDiagnosis = 'TTS诊断: auto没有可用后端';
    next.add('配置本地TTS命令或可用AI接口');
  } else if (ttsProvider === 'auto' && !voiceStats.localReady) {
    ttsDiagnosis = 'TTS诊断: 可用(API兜底，本地未配置)';
  } else if (voiceStats.localReady) {
    ttsDiagnosis = 'TTS诊断: 可用(local)';
  } else {
    ttsDiagnosis = 'TTS诊断: 可用(api)';
  }

  let sttDiagnosis = 'STT诊断: 可用';
  const sttProvider = sttStats.provider;
  if (!config.enable_stt) {
    sttDiagnosis = 'STT诊断: 未开启';
    next.add('需要听写就打开 enable_stt');
  } else if (sttProvider === 'local' && !sttStats.localReady) {
    sttDiagnosis = 'STT诊断: 本地听写未配置';
    next.add('填 stt_local_command，或把 stt_provider 改成 api/auto');
  } else if (sttProvider === 'api' && !apiReady) {
    sttDiagnosis = 'STT诊断: API后端不可用';
    next.add('检查 api_url/model/api_key');
  } else if (sttProvider === 'auto' && !sttStats.localReady && !apiReady) {
    sttDiagnosis = 'STT诊断: auto没有可用后端';
    next.add('配置本地STT命令或可用AI接口');
  } else if (sttProvider === 'auto' && !sttStats.localReady) {
    sttDiagnosis = 'STT诊断: 可用(API兜底，本地未配置)';
  } else if (sttStats.localReady) {
    sttDiagnosis = 'STT诊断: 可用(local)';
  } else {
    sttDiagnosis = 'STT诊断: 可用(api)';
  }

  const cloneDiagnosis = voiceStats.cloneEnabled
    ? (voiceStats.cloneReady ? '克隆诊断: 样本可用' : `克隆诊断: 样本不可用(${voiceStats.sampleReason || 'missing'})，会退回普通TTS`)
    : '克隆诊断: 已关闭';
  if (voiceStats.cloneEnabled && !voiceStats.cloneReady) {
    next.add('要复刻声音就用 /voice clone 安装授权样本');
  }

  return [
    ttsDiagnosis,
    sttDiagnosis,
    cloneDiagnosis,
    `并发合并: TTS飞行${voiceStats.inFlight} 合并${voiceStats.inFlightHits}；STT飞行${sttStats.inFlight} 合并${sttStats.inFlightHits}`,
    next.size > 0 ? `下一步: ${[...next].join('；')}` : '下一步: /voice test <内容> 和 /voice stt <语音URL> 各跑一次',
  ];
}

function formatVoiceStatusPanel(config: AIConfig, apiReady: boolean): string {
  const stats = getVoiceStats(config);
  const sttStats = getSttStats(config);
  const diagnosis = buildVoiceStatusDiagnosis(config, stats, sttStats, apiReady);
  return [
    '语音状态',
    ...diagnosis,
    `TTS: ${config.enable_tts ? 'on' : 'off'}`,
    `STT: ${config.enable_stt ? 'on' : 'off'}`,
    `TTS提供方: ${stats.provider}${stats.localReady ? ' local-ready' : ''}`,
    `STT提供方: ${sttStats.provider}${sttStats.localReady ? ' local-ready' : ''}`,
    `普通模型: ${stats.model}`,
    `克隆模型: ${stats.cloneModel}`,
    `听写模型: ${sttStats.model || '未配置'}`,
    `TTS发送: ${stats.sendMode}`,
    `STT格式: ${sttStats.recordFormat} / payload ${sttStats.payloadMode}`,
    ...(stats.provider !== 'api' ? [`本地TTS命令: ${stats.localCommand || '未配置'}`] : []),
    ...(sttStats.provider !== 'api' ? [`本地STT命令: ${sttStats.localCommand || '未配置'}`] : []),
    `克隆: ${stats.cloneEnabled ? (stats.cloneReady ? 'ready' : 'missing') : 'off'}`,
    `样本: ${stats.samplePath}`,
    `样本大小: ${stats.sampleSizeMB}MB`,
    ...(stats.sampleReason ? [`样本原因: ${stats.sampleReason}`] : []),
    `缓存: ${stats.cacheFiles}/${stats.maxCacheFiles}条 ${stats.sizeMB}/${stats.maxCacheMB}MB 命中${stats.hits}/${stats.misses} 飞行${stats.inFlight} 合并${stats.inFlightHits}`,
    `听写缓存: ${sttStats.cacheFiles}/${sttStats.maxCacheFiles}条 ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 命中${sttStats.hits}/${sttStats.misses} 飞行${sttStats.inFlight} 合并${sttStats.inFlightHits} 下载失败${sttStats.downloadMisses} 空转写${sttStats.transcriptMisses}`,
    `语音记录: ${recentVoiceTraces.length}/${MAX_VOICE_TRACES}，看 /voice recent`,
    formatSttStatusLastTrace(lastReplyTrace),
    `清理: TTS删${stats.lastCleanupDeleted}/累计${stats.cleanupDeletedTotal} STT删${sttStats.lastCleanupDeleted}/累计${sttStats.cleanupDeletedTotal}`,
    `最长文本: ${stats.maxChars}字`,
    ...(stats.lastMode ? [`最近TTS模式: ${stats.lastMode}`] : []),
    ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
    ...(sttStats.lastError ? [`听写最近错误: ${sttStats.lastError}`] : []),
  ].join('\n');
}

const VOICE_CLONE_BOUNDARY_LINE = '边界: 只使用你有权使用的授权样本；生成语音不能说成现实主播本人语音，也不能拿去冒充本人。';

function hasVoiceIdentityBoundaryRisk(text: string): boolean {
  if (!text) return false;
  return hasRealityBoundaryClaim(text)
    || /(?:本人|本尊|主播本人|现实主播|玩机器|MachineWJQ|6657).{0,12}(?:语音|声音|声线|原声|真声|真人声音|本人声音)/i.test(text)
    || /(?:语音|声音|声线|原声|真声|真人声音|本人声音).{0,12}(?:本人|本尊|主播本人|现实主播|玩机器|MachineWJQ|6657)/i.test(text)
    || /(?:克隆|复刻|还原|模仿).{0,10}(?:本人|本尊|主播本人|现实主播|玩机器|MachineWJQ|6657).{0,10}(?:语音|声音|声线|原声|真声)/i.test(text)
    || /(?:官方授权|本人授权|主播授权|玩机器授权).{0,12}(?:语音|声音|声线|克隆|复刻|样本)/i.test(text);
}

function buildVoicePreflightAnalysis(config: AIConfig, text: string, apiReady: boolean): VoicePreflightAnalysis {
  const raw = (text || '').trim();
  const stats = getVoiceStats(config);
  const maxChars = Math.max(10, config.tts_max_chars || stats.maxChars || 120);
  const cleaned = sanitizeOutgoingText(raw)
    .replace(/\s+/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim();
  const parts = splitVoiceTextForTts(raw, maxChars);
  const spokenChars = parts.reduce((sum, part) => sum + part.length, 0);
  const likelyTruncated = cleaned.length > maxChars * 4 || (parts.length >= 4 && spokenChars < Math.floor(cleaned.length * 0.85));
  const risks: string[] = [];
  const next: string[] = [];
  const provider = stats.provider;
  if (!config.enable_tts) {
    risks.push('TTS未开启');
    next.push('打开 enable_tts');
  } else if (provider === 'local' && !stats.localReady) {
    risks.push('本地TTS未配置');
    next.push('配置 tts_local_command 或改 provider');
  } else if (provider === 'api' && !apiReady) {
    risks.push('API后端不可用');
    next.push('检查 api_url/model/api_key');
  } else if (provider === 'auto' && !stats.localReady && !apiReady) {
    risks.push('auto没有可用TTS后端');
    next.push('配置本地TTS或可用API');
  }
  if (parts.length === 0) {
    risks.push('清洗后没有可念文本');
    next.push('换一段正常文字');
  }
  if (parts.length > 1) {
    risks.push(`会拆成${parts.length}条record`);
    next.push('群里直读建议压到一两句');
  }
  if (likelyTruncated) {
    risks.push('超过4段上限，后文可能不会念出');
    next.push('先缩短文本或分多次发');
  }
  if (stats.cloneEnabled && !stats.cloneReady) {
    risks.push('克隆样本不可用，会走普通TTS');
    next.push('需要复刻声音就用 /voice clone 安装授权样本');
  }
  if (stats.sendMode !== 'base64') {
    risks.push(`发送模式${stats.sendMode}，Docker/NapCat可能读不到文件`);
    next.push('Docker部署优先 tts_send_mode=base64');
  }
  if (hasVoiceIdentityBoundaryRisk(raw)) {
    risks.push('疑似现实本人/授权语音话术');
    next.push('改成“风格语音/授权样本”，不要说成现实主播本人语音');
  }

  return {
    raw,
    cleaned,
    maxChars,
    parts,
    spokenChars,
    likelyTruncated,
    risks,
    next: [...new Set(next)],
    stats,
  };
}

function formatVoicePreflight(config: AIConfig, text: string, apiReady: boolean): string {
  const analysis = buildVoicePreflightAnalysis(config, text, apiReady);
  if (!analysis.raw) return '/voice check <要预检的文本>';
  const { raw, cleaned, maxChars, parts, likelyTruncated, risks, next, stats } = analysis;
  const provider = stats.provider;

  return [
    '语音预检',
    '模式: 直读TTS预检，不调用AI，不生成音频',
    `TTS: ${config.enable_tts ? 'on' : 'off'} ${provider}${stats.localReady ? '/local-ready' : ''} send=${stats.sendMode}`,
    `克隆: ${stats.cloneEnabled ? (stats.cloneReady ? 'ready' : 'missing') : 'off'} 样本${stats.sampleSizeMB}MB`,
    `长度: 原文${raw.length}字 / 清洗${cleaned.length}字 / 单段上限${maxChars}字`,
    `分段: ${parts.length}/4${likelyTruncated ? ' 可能截断' : ''}`,
    ...parts.map((part, index) => `${index + 1}. ${previewText(part, 72)}`),
    `风险: ${risks.length ? risks.join(' / ') : '无明显风险'}`,
    '边界: /voice check 只检查TTS文本和发送风险；克隆/授权样本也不能说成现实主播本人语音，也不能拿去冒充本人。',
    `下一步: ${next.length ? next.join('；') : '可以 /voice test <文本> 做真实生成测试'}`,
  ].join('\n');
}

function formatVoiceCachePreflight(config: AIConfig, text: string, apiReady: boolean): string {
  const analysis = buildVoicePreflightAnalysis(config, text, apiReady);
  if (!analysis.raw) return '/voice cache <要预检的文本>';
  const inspect = inspectVoiceCache(config, analysis.parts);
  const counts = inspect.parts.reduce((acc, part) => {
    acc[part.status] = (acc[part.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const risks = [...analysis.risks];
  if (!apiReady && inspect.parts.some((part) => part.provider === 'api')) risks.push('API后端不可用，api/auto-api 分段会 disabled');
  if (inspect.parts.some((part) => part.status === 'expired')) risks.push('存在过期音频，下一次生成会重写缓存');
  if (inspect.parts.some((part) => part.status === 'miss')) risks.push('存在未命中分段，首次生成会消耗TTS');
  const summary = ['hit', 'miss', 'in-flight', 'expired', 'invalid', 'disabled']
    .map((key) => `${key} ${counts[key] || 0}`)
    .join(' / ');
  const partLines = inspect.parts.slice(0, 6).map((part) => {
    const ttl = part.status === 'hit' ? ` ttl=${part.ttlSeconds}s` : part.status === 'expired' ? ` age=${part.ageSeconds}s` : '';
    const file = part.ext ? ` ${part.ext}/${part.sizeKB}KB` : '';
    const clone = part.clone ? ' clone' : '';
    return `${part.index}. 状态=${part.status}${ttl} key=${part.cacheKey} ${part.mode}${clone}${file} ${part.chars}字`;
  });

  return [
    '语音缓存预检',
    '模式: 只读检查TTS分段和缓存 key，不调用AI，不生成音频',
    `TTS: ${config.enable_tts ? 'on' : 'off'} ${inspect.provider}${inspect.localReady ? '/local-ready' : ''} send=${inspect.sendMode}`,
    `克隆: ${inspect.cloneEnabled ? (inspect.cloneReady ? 'ready' : `missing${inspect.sampleReason ? `(${inspect.sampleReason})` : ''}`) : 'off'}`,
    `分段: ${inspect.parts.length}段 / 单段上限${inspect.maxChars}字${analysis.likelyTruncated ? ' / 可能截断' : ''}`,
    `缓存状态: ${summary}`,
    ...partLines,
    inspect.parts.length > partLines.length ? `... 还有${inspect.parts.length - partLines.length}段未展示` : '',
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显风险'}`,
    '边界: 语音缓存只代表音频可复用，不代表文本事实正确；克隆语音也不能说成现实主播本人语音，不能拿去冒充本人。',
    `下一步: ${inspect.parts.every((part) => part.status === 'hit') ? '可以直接 /voice test 复用缓存；要清理用 /voice clean' : '常用短句可先 /voice test 预热一次；生成后再 /voice cache 复查 hit'}`,
  ].filter(Boolean).join('\n');
}

function formatSttCachePreflight(config: AIConfig, sources: string[], apiReady: boolean): string {
  const uniqueSources = uniqueNonEmpty(sources.map((source) => source.trim()).filter(Boolean));
  if (uniqueSources.length === 0) return '/voice sttcache <语音URL>\n也可以把语音和 /voice sttcache 发在同一条消息里';
  const stats = getSttStats(config);
  const sttLimit = Math.max(1, Math.min(config.stt_max_records || 1, 4));
  const passCount = config.enable_stt ? Math.min(uniqueSources.length, sttLimit) : 0;
  const truncated = uniqueSources.length > passCount;
  const inspect = inspectSttCacheSources(config, uniqueSources, 6);
  const counts = inspect.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const summary = ['hit', 'miss', 'in-flight', 'expired', 'invalid', 'disabled']
    .map((key) => `${key} ${counts[key] || 0}`)
    .join(' / ');
  const risks: string[] = [];
  const next: string[] = [];
  const provider = stats.provider;
  const sttNeedsApi = provider === 'api' || (provider === 'auto' && !stats.localReady);
  if (!config.enable_stt) {
    risks.push('听写未开启');
    next.push('打开 enable_stt');
  } else if (provider === 'local' && !stats.localReady) {
    risks.push('本地STT命令未配置');
    next.push('配置 stt_local_command 或切到 api/auto');
  } else if (sttNeedsApi && !apiReady) {
    risks.push('听写API后端不可用');
    next.push('配置可用AI接口或本地STT');
  }
  if (truncated) {
    risks.push(`真实听写会截断 ${passCount}/${uniqueSources.length}`);
    next.push('减少语音条数或调高 stt_max_records');
  }
  if (inspect.some((item) => item.status === 'miss' || item.status === 'expired')) {
    risks.push('存在未命中或过期听写缓存');
    next.push('/voice stt <语音URL> 真实预热听写缓存');
  }
  if (inspect.some((item) => item.status === 'in-flight')) {
    next.push('等当前听写完成后再复查 sttcache');
  }
  if (stats.lastError) {
    risks.push(`最近听写错误: ${stats.lastError.slice(0, 60)}`);
    next.push('/voice stt <语音URL> 定位下载/转码/模型问题');
  }
  const lines = inspect.map((item, index) => {
    const ttl = item.status === 'hit'
      ? ` ttl=${item.ttlSeconds}s chars=${item.chars}`
      : item.status === 'expired'
        ? ` age=${item.ageSeconds}s chars=${item.chars}`
        : '';
    return `${index + 1}. 状态=${item.status}${ttl} key=${item.cacheKey || '-'} ${previewText(item.reason, 42)} / ${previewText(item.source, 60)}`;
  });
  return [
    '听写缓存预检',
    '模式: 只读检查STT缓存 key，不下载语音、不转码、不调用模型',
    `STT: ${config.enable_stt ? 'on' : 'off'} ${provider}${stats.localReady ? '/local-ready' : ''} model=${stats.model || '未配置'} payload=${stats.payloadMode}`,
    `语音: 输入${uniqueSources.length}条 / 真实最多听写${passCount}/${uniqueSources.length} / max${sttLimit}${truncated ? ' 已截断' : ''}`,
    `来源: ${summarizeImageSourceKinds(uniqueSources).join(' / ') || '无'}`,
    `缓存状态: ${summary}`,
    ...lines,
    uniqueSources.length > inspect.length ? `... 还有${uniqueSources.length - inspect.length}条未展示` : '',
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显风险'}`,
    '边界: STT缓存命中只代表转写文本可复用，不证明音频内容完整；miss/expired 时不能假装已经听到语音。',
    `下一步: ${next.length ? [...new Set(next)].join('；') : '可以直接 /voice stt <语音URL> 做端到端听写测试'}`,
  ].filter(Boolean).join('\n');
}

function formatSttCacheInspectLine(label: string, item: ReturnType<typeof inspectSttCacheSources>[number] | undefined): string {
  if (!item) return `${label}: 无`;
  const ttl = item.status === 'hit'
    ? ` ttl=${item.ttlSeconds}s chars=${item.chars}`
    : item.status === 'expired'
      ? ` age=${item.ageSeconds}s chars=${item.chars}`
      : '';
  return `${label}: ${item.status}${ttl} key=${item.cacheKey || '-'} ${previewText(item.reason, 70)}`;
}

function formatSttBackendDelta(before: ReturnType<typeof getSttStats>, after: ReturnType<typeof getSttStats>): string {
  const localDelta = Math.max(0, after.localRuns - before.localRuns);
  const apiDelta = Math.max(0, after.apiRuns - before.apiRuns);
  const hitDelta = Math.max(0, after.hits - before.hits);
  const missDelta = Math.max(0, after.misses - before.misses);
  const inFlightDelta = Math.max(0, after.inFlightHits - before.inFlightHits);
  return `后端动作: local+${localDelta} api+${apiDelta} cacheHit+${hitDelta} cacheMiss+${missDelta} inFlightHit+${inFlightDelta}`;
}

async function formatSttEndToEndTest(
  config: AIConfig,
  input: string,
  transcribeSource: (source: string) => Promise<string[]>,
): Promise<string> {
  const sourceKind = classifyImageSource(input);
  const cacheBefore = inspectSttCacheSources(config, [input], 1)[0];
  const statsBefore = getSttStats(config);
  let transcripts: string[] = [];
  let thrownError = '';
  try {
    transcripts = await transcribeSource(input);
  } catch (err) {
    thrownError = err instanceof Error ? err.message : String(err);
  }
  const statsAfter = getSttStats(config);
  const cacheAfter = inspectSttCacheSources(config, [input], 1)[0];
  const transcript = transcripts.join('\n').trim();
  const ok = transcript.length > 0;
  const backendBoundary = (statsAfter.localRuns - statsBefore.localRuns) <= 0 && (statsAfter.apiRuns - statsBefore.apiRuns) <= 0
    ? '本次后端 local/api 没增加，说明没有重新听音频，只复用了已有转写。'
    : '本次有后端听写动作，缓存后 hit 才代表这次转写结果已经可复用。';
  return [
    ok ? '听写链路测试' : '听写链路测试失败',
    `语音源: ${sourceKind}`,
    `STT: ${config.enable_stt ? 'on' : 'off'} ${statsAfter.provider}${statsAfter.localReady ? '/local-ready' : ''} model=${statsAfter.model || '未配置'} payload=${statsAfter.payloadMode}`,
    formatSttCacheInspectLine('缓存前', cacheBefore),
    formatSttCacheInspectLine('缓存后', cacheAfter),
    formatSttBackendDelta(statsBefore, statsAfter),
    statsAfter.lastPayloadMode ? `payload实际: ${statsAfter.lastPayloadMode}` : '',
    ok ? '听写: OK' : `听写: FAIL ${previewText(thrownError || statsAfter.lastError || 'empty transcript', 160)}`,
    ok ? `转写: ${previewText(transcript, 500)}` : '',
    ok
      ? `边界: STT缓存 hit 只代表转写文本可复用，不证明音频内容完整；${backendBoundary}`
      : '边界: 听写失败或空转写时不能假装听到语音；缓存后不是 hit 也不能拿缓存当语音内容。',
  ].filter(Boolean).join('\n');
}

function voiceCacheStatusSummary(parts: ReturnType<typeof inspectVoiceCache>['parts']): string {
  const counts = parts.reduce((acc, part) => {
    acc[part.status] = (acc[part.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return ['hit', 'miss', 'in-flight', 'expired', 'invalid', 'disabled']
    .map((key) => `${key} ${counts[key] || 0}`)
    .join(' / ');
}

function formatVoiceCachePartLine(prefix: string, part: ReturnType<typeof inspectVoiceCache>['parts'][number]): string {
  const ttl = part.status === 'hit' ? ` ttl=${part.ttlSeconds}s` : part.status === 'expired' ? ` age=${part.ageSeconds}s` : '';
  const file = part.ext ? ` ${part.ext}/${part.sizeKB}KB` : '';
  const clone = part.clone ? ' clone' : '';
  return `${prefix}${part.index}. 状态=${part.status}${ttl} key=${part.cacheKey} ${part.mode}${clone}${file} ${part.chars}字`;
}

export async function formatVoiceCacheWarm(
  config: AIConfig,
  text: string,
  apiReady: boolean,
  generatePart: (partText: string) => Promise<string | null>,
): Promise<string> {
  const analysis = buildVoicePreflightAnalysis(config, text, apiReady);
  if (!analysis.raw) return '/voice warm <要预热的文本>';

  const before = inspectVoiceCache(config, analysis.parts);
  const actions: string[] = [];
  let generated = 0;
  let hit = 0;
  let skipped = 0;
  let failed = 0;

  for (const part of before.parts) {
    if (part.status === 'hit') {
      hit++;
      actions.push(`${part.index}. hit/no-op key=${part.cacheKey}`);
      continue;
    }
    if (part.provider === 'api' && !apiReady) {
      skipped++;
      actions.push(`${part.index}. skipped/api-not-ready key=${part.cacheKey}`);
      continue;
    }
    if (part.status !== 'miss' && part.status !== 'expired' && part.status !== 'in-flight') {
      skipped++;
      actions.push(`${part.index}. skipped/${part.status} key=${part.cacheKey}`);
      continue;
    }
    const voicePath = await generatePart(part.text);
    if (voicePath) {
      generated++;
      actions.push(`${part.index}. generated key=${part.cacheKey}`);
    } else {
      failed++;
      actions.push(`${part.index}. failed key=${part.cacheKey}`);
    }
  }

  const after = inspectVoiceCache(config, analysis.parts);
  const stats = getVoiceStats(config);
  const beforeLines = before.parts.slice(0, 6).map((part) => formatVoiceCachePartLine('预热前 ', part));
  const afterLines = after.parts.slice(0, 6).map((part) => formatVoiceCachePartLine('预热后 ', part));
  const risks = [...analysis.risks];
  if (!apiReady && before.parts.some((part) => part.provider === 'api')) risks.push('API后端不可用，api/auto-api 分段不会生成');
  if (after.parts.some((part) => part.status !== 'hit')) risks.push('仍有分段没有命中缓存');

  return [
    '语音缓存预热',
    '模式: 管理员真实TTS缓存预热，不调用AI，不发送record',
    `TTS: ${config.enable_tts ? 'on' : 'off'} ${before.provider}${before.localReady ? '/local-ready' : ''} send=${before.sendMode}`,
    `克隆: ${before.cloneEnabled ? (before.cloneReady ? 'ready' : `missing${before.sampleReason ? `(${before.sampleReason})` : ''}`) : 'off'}`,
    `分段: ${before.parts.length}段 / 单段上限${before.maxChars}字${analysis.likelyTruncated ? ' / 可能截断' : ''}`,
    `预热前: ${voiceCacheStatusSummary(before.parts)}`,
    ...beforeLines,
    before.parts.length > beforeLines.length ? `预热前 ... 还有${before.parts.length - beforeLines.length}段未展示` : '',
    `预热动作: generated ${generated} / hit ${hit} / skipped ${skipped} / failed ${failed}`,
    ...actions.slice(0, 8),
    actions.length > 8 ? `... 还有${actions.length - 8}个动作未展示` : '',
    `预热后: ${voiceCacheStatusSummary(after.parts)}`,
    ...afterLines,
    after.parts.length > afterLines.length ? `预热后 ... 还有${after.parts.length - afterLines.length}段未展示` : '',
    `风险: ${risks.length ? [...new Set(risks)].join(' / ') : '无明显风险'}`,
    failed > 0 || stats.lastError ? `最近错误: ${stats.lastError || 'unknown'}` : '',
    '边界: 预热只代表音频缓存可复用，不代表文本事实正确；克隆语音也不能说成现实主播本人语音，不能拿去冒充本人。',
    '说明: 这里只生成或复用缓存，不会给群里发语音；要试听再用 /voice test <文本>。',
  ].filter(Boolean).join('\n');
}

function cleanHistoryMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user' || typeof message.content !== 'string') return message;
  const meta = parseStoredMessageMeta(message);
  const cleaned = meta ? `${meta.name}: ${meta.text}` : message.content.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '');
  return { role: message.role, content: cleaned };
}

function normalizeMemoryDuplicateText(text: string): string {
  return (text || '')
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/^[^:：\n]{1,32}[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemoryRiskText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const REALTIME_MEMORY_QUERY_RE = /(?:最新|现在|当前|目前|今天|今日|今晚|昨天|昨晚|刚才|刚刚|最近|近期|本周|这周|本月|这两天|这几天|实时|现况|状态|表现|赛程|赛果|战报|比分|排名|排行|阵容|转会|加入|离队|替补|match\s*id|matchid|hltv|vrs|rating|adr|kast|k\/?d|数据|谁c|谁C|谁赢|赢了|输了|第几|第一|top\s*\d*)/i;
const CS_MEMORY_CONTEXT_RE = /(?:\bcs(?:2|go)?\b|hltv|vrs|major|iem|blast|esl|epl|pgl|cct|valve|战队|队伍|选手|阵容|赛程|赛果|比分|地图池|赛事|navi|natus\s*vincere|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|complexity|virtus\s*pro|ence|fnatic|3dmax|pain|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|huNter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian|mirage|inferno|nuke|ancient|anubis|dust2|train|overpass)/i;
const CS_TIME_SENSITIVE_MEMORY_RE = /(?:最新|现在|当前|目前|今天|今日|今晚|昨天|昨晚|刚才|刚刚|最近|近期|排名|排行|第[一二三四五六七八九十\d]+|第一|top\s*\d*|阵容|转会|加入|离队|替补|租借|官宣|爆料|传闻|赛果|比分|赢了|输了|击败|战胜|rating|adr|kast|k\/?d|数据|状态|表现|首发|替补|地图池|版本|胜率|match\s*id|matchid)/i;

export function isRealtimeMemoryQuery(text: string, csRealtimeIntent = false): boolean {
  const clean = normalizeMemoryRiskText(text);
  if (!clean) return false;
  if (csRealtimeIntent) return true;
  if (REALTIME_MEMORY_QUERY_RE.test(clean) && CS_MEMORY_CONTEXT_RE.test(clean)) return true;
  const csTopic = detectCsTopicQuery(clean);
  return csTopic.needsMatches || csTopic.needsRanking || csTopic.needsResults;
}

export function classifyMemoryTruthRisk(query: string, memoryText: string, csRealtimeIntent = false): string | null {
  if (!isRealtimeMemoryQuery(query, csRealtimeIntent)) return null;
  const memory = normalizeMemoryRiskText(memoryText);
  if (!memory) return null;
  if (!CS_MEMORY_CONTEXT_RE.test(memory)) return null;
  if (!CS_TIME_SENSITIVE_MEMORY_RE.test(memory)) return null;
  return '旧CS实时事实';
}

export function filterMemoryTruthRisk<T extends { text: string }>(
  query: string,
  memories: T[],
  csRealtimeIntent = false,
): { kept: T[]; filtered: T[]; reasons: string[] } {
  const kept: T[] = [];
  const filtered: T[] = [];
  const reasons: string[] = [];
  for (const memory of memories) {
    const reason = classifyMemoryTruthRisk(query, memory.text, csRealtimeIntent);
    if (reason) {
      filtered.push(memory);
      if (reasons.length < 4) reasons.push(reason);
    } else {
      kept.push(memory);
    }
  }
  return {
    kept,
    filtered,
    reasons: [...new Set(reasons)],
  };
}

function formatMemoryAge(seconds: number | undefined): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function buildFocusedHistory(job: ReplyJob, sendLimit: number): { history: ChatMessage[]; focused: boolean } {
  const messages = job.contextMessages.slice(0, -1);
  if (messages.length <= sendLimit) {
    return { history: messages.map(cleanHistoryMessage), focused: false };
  }

  const scored = messages.map((message, index) => {
    const meta = parseStoredMessageMeta(message);
    const content = typeof message.content === 'string' ? message.content : '';
    let score = index / Math.max(1, messages.length);
    if (index >= messages.length - Math.ceil(sendLimit * 0.55)) score += 6;
    if (message.role === 'assistant') score += 2.5;
    if (meta) {
      if (meta.uid === job.userId) score += 6;
      if (job.repliedMessageId && meta.mid === job.repliedMessageId) score += 18;
      if (job.effectiveText && meta.text && hasTokenOverlap(job.effectiveText, meta.text)) score += 4;
    }
    if (job.hasImages && /\[图片\]|含\d+张图/.test(content)) score += 2;
    if (job.hasRecords && /\[语音\]|含\d+条语音/.test(content)) score += 2;
    return { message, index, score };
  });

  const keep = Math.max(4, sendLimit);
  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, keep)
    .sort((a, b) => a.index - b.index)
    .map((item) => cleanHistoryMessage(item.message));
  return { history: selected, focused: true };
}

function hasTokenOverlap(a: string, b: string): boolean {
  const tokens = (a.toLowerCase().match(/[\u4e00-\u9fa5]{2,8}|[a-z0-9]{2,16}/g) || [])
    .filter((token) => token.length >= 2)
    .slice(0, 20);
  if (tokens.length === 0) return false;
  const haystack = b.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits++;
    if (hits >= 2) return true;
  }
  return hits >= 1 && tokens.length <= 3;
}

function buildRecentSpeakerHints(messages: ChatMessage[], currentUserId: number, limit: number = 6): string {
  const hints: string[] = [];
  const seen = new Set<string>();
  const currentSpeaker: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const match = message.content.match(/\[mid=(\d+)\s+uid=(\d+)\]\s*([^:：\n]{1,32})[:：]\s*(.+)/);
    if (!match) continue;
    const key = match[2];
    const text = match[4].replace(/\s+/g, ' ').slice(0, 60);
    if (Number(match[2]) === currentUserId && currentSpeaker.length < 3) {
      currentSpeaker.push(`- ${match[3]} mid=${match[1]}: ${text}`);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(`- ${match[3]} uid=${match[2]} mid=${match[1]}: ${text}`);
    if (hints.length >= limit) break;
  }
  return [
    currentSpeaker.length > 0 ? `[当前发送者最近发言]\n${currentSpeaker.reverse().join('\n')}` : '',
    hints.length > 0 ? `[最近群发言定位]\n${hints.reverse().join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeAssistantOpener(text: string): string {
  const cleaned = sanitizeOutgoingText(text)
    .replace(/\s+/g, ' ')
    .replace(/^(?:结论|原因|建议|分析|总结|答案|短评|判断|我的判断|先说结论)\s*[：:]\s*/i, '')
    .replace(/^(?:不是哥们|不是，哥们|不是 哥们|兄弟们?|哥们|家人们|可以的|这波|讲道理|说实话|我只能说)[，,。!！?\s]*/i, '')
    .trim();
  if (!cleaned) return '';
  const firstClause = cleaned.split(/[。！？!?；;\n]/).find(Boolean) || cleaned;
  return firstClause.slice(0, 18).trim();
}

function buildRecentAssistantOpeningHints(messages: ChatMessage[], limit: number = 4): string {
  const openers: string[] = [];
  const seen = new Set<string>();
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
    const opener = normalizeAssistantOpener(message.content);
    if (!opener || opener.length < 2 || seen.has(opener)) continue;
    seen.add(opener);
    openers.push(opener);
    if (openers.length >= limit) break;
  }
  return openers.length > 0
    ? openers.map((item) => `- ${item}`).join('\n')
    : '';
}

function hashIndex(input: string, mod: number): number {
  const digest = crypto.createHash('sha1').update(input).digest();
  return digest[0] % Math.max(1, mod);
}

function needsRealityIdentityBoundary(text: string): boolean {
  return /现实|本人|真的是|真玩机器|授权|代表本人|代表你|冒充|本尊|主播本人/.test(text);
}

function buildLiveStyleCue(job: ReplyJob): string {
  const base = [
    '直接给判断，别铺垫，别说规则',
    '不要口癖开场，第一句直接说事',
    '短反应可以有，但别复读固定口头禅',
    '像刚看到弹幕一样接住，短一点',
    '如果是CS话题，抓经济、道具、timing里最关键的一个点',
    '先别急着开香槟，给一个偏谨慎的判断',
    '少口癖，多具体判断',
    '可以轻嘴硬，但别追着人骂',
    '优先像正常人聊天，别像模板在营业',
    '能说"等一下/这个不太对"就别硬喷',
    '这条不要用固定口头禅开头',
    '想说话就直接说，别在结尾甩一个跟内容无关的表情',
    '玩机器在直播里很少用 emoji，主要靠语气和短句子，你也是',
    '看到惊讶/离谱时可以用 1 个表情，比如 [思考] [呲牙] [笑哭]；但平常聊天就别加',
    '只有真的好笑才用 [笑哭] 或 [lol]，否则别装',
    '真不知道答案就用 [思考] 或 [疑问]，别装懂',
  ];
  if (job.hasImages) {
    base.push('先说图里可见内容，再给一句短评；看不清就直说');
  }
  if (job.hasRecords) {
    base.push('有听写就接听写，没有听写就只说收到语音');
  }
  if (job.forceVoice) {
    base.push('这条要适合念出来，别列条目，别太长');
  }
  if (needsRealityIdentityBoundary(job.effectiveText || job.rawText)) {
    base.push('问现实本人或授权时先说明边界，再继续接当前话题');
  }
  return base[hashIndex(`${job.chatType}:${job.chatId}:${job.messageId}:${job.effectiveText}`, base.length)];
}

function scrubKnowledgeForRuntime(input: string, keepIdentityBoundary: boolean): string {
  if (!input.trim()) return '';
  const forbiddenForNormal = /(bot|机器人|ai助手|拟态|模板|核验|原话|来源类型|核验状态|内容类型|知识库|隔离|quarantine|inbox|\/kb|不代表现实|不是现实|不是本人|授权)/i;
  const noisySection = /^【.*(?:素材准确性|已核验公开资料|核心身份|身份|错误内容|本地素材|知识库|管理|拒绝|边界|隔离|自动|调用铁律|准确性|格式|部署|命令|README).*】$/;
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-*]\s*(?:知识来源类型|置信度|核验状态|内容类型|自动写入资格|证据链接)[：:]/.test(line))
    .filter((line) => !noisySection.test(line))
    .filter((line) => !/不是哥们/.test(line))
    .filter((line) => keepIdentityBoundary || !forbiddenForNormal.test(line))
    .map((line) => line
      .replace(/^【(.+?)】$/, '$1')
      .replace(/^[-*]\s*/, '')
      .replace(/^(?:以下是|这些是).{0,24}(?:模板|规则|方法).*$/i, '')
      .trim())
    .filter(Boolean)
    .slice(0, 34);
  return lines.join('\n');
}

function buildRuntimeKnowledgeInfo(
  styleKnowledge: string,
  topicKnowledge: string,
  job: ReplyJob,
  hasKnowledgeTopic: boolean,
  maxChars: number,
  freshnessBoundary: string = '',
): string {
  const keepIdentity = needsRealityIdentityBoundary(job.effectiveText || job.rawText);
  const style = scrubKnowledgeForRuntime(styleKnowledge, keepIdentity);
  const topic = scrubKnowledgeForRuntime(topicKnowledge, keepIdentity);
  const cue = buildLiveStyleCue(job);
  const recentOpeners = buildRecentAssistantOpeningHints(job.contextMessages.slice(0, -1));
  const speakerHints = buildRecentSpeakerHints(job.contextMessages.slice(0, -1), job.userId);
  return [
    '下面是本地临场笔记，只用来垫语感、背景倾向和稳定常识，不要在回复里说出来。',
    '事实优先级：实时事实参考 > 本地话题素材 > 本地语态素材；没有实时事实时，不要用本地素材报“现在/今天/最新”的排名、比分、阵容、转会。',
    freshnessBoundary ? `[本地知识时效风险]\n${freshnessBoundary}` : '',
    '语录/切片/口癖只能当语气参考，除非明确标为已核验短句，否则不要声称是本人逐字原话。',
    `本条节奏: ${cue}`,
    `当前定位: chat_type=${job.chatType} chat_id=${job.chatId}${job.groupId ? ` group_id=${job.groupId}` : ''} message_id=${job.messageId} user_id=${job.userId} sender=${job.senderName}`,
    hasKnowledgeTopic ? '当前消息命中话题知识：只能把下面内容当本地背景和判断角度；涉及最新事实必须看实时参考。' : '当前消息至少注入直播语态素材，必须吸收语气和节奏，别退回AI助手腔。',
    '核心手感: 像直播间顺手接弹幕，先抓当前这句话，短反应 + 具体判断 + 收住攻击性。',
    '输出时禁止说“根据知识库/根据素材/根据临场笔记/作为AI/作为bot/这是模板/实时事实参考”。',
    '不要标题式输出“结论/原因/建议/分析/总结”，像群里正常接一句。',
    speakerHints ? `${speakerHints}\n只用来定位话题，不要替这些历史发言答题。` : '',
    recentOpeners ? `[最近回复开头，别复读]\n${recentOpeners}` : '',
    style ? `[语态素材]\n${style}` : '',
    topic ? `[话题素材]\n${topic}` : '',
  ].filter(Boolean).join('\n\n').slice(0, maxChars);
}

function buildTargetText(job: ReplyJob, recordTranscripts: string[] = []): string {
  const transcriptText = recordTranscripts.join('\n');
  // 当 effectiveText 为空（@bot 没说话），用更明确的提示
  let body: string;
  if (job.effectiveText) {
    body = job.effectiveText;
  } else if (transcriptText) {
    body = transcriptText;
  } else if (job.hasImages) {
    body = '[图片]';
  } else if (job.hasRecords) {
    body = '[语音]';
  } else if (job.isAtBot) {
    body = '(@了你 但没说内容)';
  } else if (job.isReplyToBot) {
    body = '(回复你 但内容是空)';
  } else {
    body = '[空]';
  }
  const mediaHints: string[] = [];
  if (job.hasImages) mediaHints.push(`(消息含${job.imageInputCount || job.imageUrls.length}张图片)`);
  if (job.hasRecords) mediaHints.push(`(消息含${job.recordUrls.length}条语音${transcriptText ? '' : ' 但无听写文本'})`);
  if (transcriptText) mediaHints.push(`(语音听写: ${transcriptText})`);
  if (job.forceVoice) mediaHints.push('(对方要求语音回复 短一点 适合念)');
  if (job.repliedMessageId) mediaHints.push('(对方在引用之前的消息追问，要像接弹幕一样顺着上一句回，不要像处理工单)');

  const recentOpeners = buildRecentAssistantOpeningHints(job.contextMessages.slice(0, -1));
  const openerHint = recentOpeners ? `\n【提示】别复读这些开头: ${recentOpeners.replace(/\n/g, ' / ')}` : '';

  // 用清晰的标记包裹当前消息让模型不混淆
  const mediaText = mediaHints.length > 0 ? ' ' + mediaHints.join(' ') : '';
  return [
    '===当前消息定位===',
    `chat_type: ${job.chatType}`,
    `chat_id: ${job.chatId}`,
    job.groupId ? `group_id: ${job.groupId}` : '',
    `message_id: ${job.messageId}`,
    `user_id: ${job.userId}`,
    `sender: ${job.senderName}`,
    `trigger: ${job.triggerReason}`,
    `用户明确要求语音回复: ${job.forceVoice ? '是' : '否'}`,
    '===现在你要回复这一条===',
    `${job.senderName}: ${body}${mediaText}`,
    '===',
    job.isReplyToBot
      ? `这是对方在回复你上一条，按玩机器直播间接弹幕的语气顺着回。短一点、像真人，不要解释触发机制。${openerHint}`
      : `只回应这个人这句话 不要替历史里其他人补答${openerHint}`,
  ].filter(Boolean).join('\n');
}

async function resolveVisionDataUrls(
  ctx: PluginContext,
  job: ReplyJob,
  limit: number,
): Promise<{ dataUrls: string[]; error: string }> {
  const dataUrls: string[] = [];
  const seen = new Set<string>();
  let lastError = '';

  const pushIfDataUrl = (value: string): boolean => {
    if (dataUrls.length >= limit) return true;
    const cleaned = value.trim();
    if (!cleaned) return false;
    if (cleaned.startsWith('data:image/')) {
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        dataUrls.push(cleaned);
      }
      return true;
    }
    if (cleaned.startsWith('base64://')) {
      const dataUrl = `data:image/jpeg;base64,${cleaned.slice('base64://'.length).replace(/\s+/g, '')}`;
      if (!seen.has(dataUrl)) {
        seen.add(dataUrl);
        dataUrls.push(dataUrl);
      }
      return true;
    }
    const compact = cleaned.replace(/\s+/g, '');
    if (compact.length > 100 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
      const dataUrl = `data:image/jpeg;base64,${compact}`;
      if (!seen.has(dataUrl)) {
        seen.add(dataUrl);
        dataUrls.push(dataUrl);
      }
      return true;
    }
    return false;
  };

  const loadSources = async (sources: string[], stage: string): Promise<void> => {
    for (const url of uniqueNonEmpty(sources)) {
      if (dataUrls.length >= limit) break;
      try {
        const d = await withGate('vision', () => getImageDataUrl(url), job.forced);
        if (d) pushIfDataUrl(d);
      } catch (err) {
        lastError = `${stage}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140);
      }
    }
  };

  await loadSources(job.imageUrls, 'message');
  if (dataUrls.length >= limit) return { dataUrls: dataUrls.slice(0, limit), error: '' };

  try {
    const msgRes = await ctx.bot.callApiAsync('get_msg', { message_id: job.messageId }, 6000);
    const msgData = (msgRes as any)?.data || msgRes;
    const msgSegs = Array.isArray(msgData?.message) ? msgData.message : [];
    if (msgSegs.length > 0) {
      const reresolved = await resolveOneBotImageSources(ctx, msgSegs);
      await loadSources(reresolved, 'get_msg');
    }
  } catch (err) {
    lastError = `get_msg: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140);
  }
  if (dataUrls.length >= limit) return { dataUrls: dataUrls.slice(0, limit), error: '' };

  const rawFiles = uniqueNonEmpty(ctx.event.message
    .filter((seg) => seg.type === 'image')
    .map((seg) => seg.type === 'image' ? (seg.data.file || seg.data.url || '') : ''));
  for (const rawFile of rawFiles.slice(0, limit)) {
    if (dataUrls.length >= limit) break;
    try {
      const r = await ctx.bot.callApiAsync('get_image', { file: rawFile }, 8000);
      const d = (r as any)?.data || r;
      if (pushIfDataUrl(String(d?.base64 || d?.b64 || d?.base64_file || d?.file_base64 || ''))) continue;
      const best = firstMediaString(d, 'image/jpeg');
      if (best) await loadSources([best], 'get_image');
    } catch (err) {
      lastError = `get_image: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140);
    }

    try {
      const r = await ctx.bot.callApiAsync('get_file', { file_id: rawFile, file: rawFile }, 8000);
      const d = (r as any)?.data || r;
      if (pushIfDataUrl(String(d?.base64 || d?.b64 || d?.file_base64 || ''))) continue;
      const best = firstMediaString(d, 'image/jpeg');
      if (best) await loadSources([best], 'get_file');
    } catch (err) {
      lastError = lastError || `get_file: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140);
    }
  }

  const imageStats = getImageCacheStats();
  return {
    dataUrls: dataUrls.slice(0, limit),
    error: lastError || imageStats.lastError || '',
  };
}

// ============ 玩机器真实语态 few-shot 示例池（每次随机选 4 个） ============
const WANJIER_SCENARIOS: Array<{ scene: string; lines: string[] }> = [
  {
    scene: '看到选手 1v3 翻盘',
    lines: [
      '"哦哦哦！翻了翻了！这怎么翻的兄弟"',
      '"你这把可以吹一年知道吗"',
      '"这种残局都能赢，今天必须给他刷一波"',
    ],
  },
  {
    scene: '看到失误送掉',
    lines: [
      '"不是哥们 这枪是打算吓谁"',
      '"这波给得太干脆了 对面都不用设计"',
      '"默认控图控到自己家没了 你说这事"',
      '"这个站位放天梯都很难活过十秒"',
    ],
  },
  {
    scene: '看到精彩 ace',
    lines: [
      '"太c了 真的太c了"',
      '"这个人不是人 这是机器"',
      '"秀啊 这波直接秀穿了"',
    ],
  },
  {
    scene: '解说优势局被翻',
    lines: [
      '"先别开香槟"',
      '"这把已经开始不对劲了"',
      '"我说什么来着 CS这游戏最怕你觉得稳"',
    ],
  },
  {
    scene: '弹幕嘴硬',
    lines: [
      '"你这话说得像只看了比分没看回合"',
      '"你认真的吗 这个理解要回炉一下"',
      '"饶了我吧 这都能洗啊"',
    ],
  },
  {
    scene: '经济局白给',
    lines: [
      '"这经济强起也是没办法"',
      '"打不过打不过 别打了"',
      '"保枪不丢人 你这是直接送"',
    ],
  },
  {
    scene: '评价选手',
    lines: [
      '"ZywOo 这数据看着稳 节奏跟不上有时候"',
      '"donk 状态来了真的没人挡得住 但波动大"',
      '"NiKo 老登嘴硬归嘴硬 关键局确实差点意思"',
      '"ropz 不一定最炸 但你回头他已经在你家了"',
    ],
  },
  {
    scene: '礼物/感谢',
    lines: [
      '"老板大气 这一发够下一把买P90"',
      '"差不多得了 别送了 我顶不住"',
      '"感谢老板 这礼物到位"',
    ],
  },
  {
    scene: '被问bot身份',
    lines: [
      '"我直接好家伙 这都看得出来？"',
      '"你管我是不是 接着说事"',
      '"想多了 直接打字"',
    ],
  },
  {
    scene: '看到道具失误',
    lines: [
      '"这烟封完对面笑了 队友沉默了"',
      '"闪自己这一波非常有节目 但回合真没了"',
      '"道具是好道具 丢法有点像没交学费"',
    ],
  },
  {
    scene: '老将状态',
    lines: [
      '"老将就是老将 关键时刻还是稳"',
      '"这把状态来了 该回家就回家"',
      '"老登归老登 这枪给的还是正"',
    ],
  },
  {
    scene: 'Major 决赛紧张时刻',
    lines: [
      '"不是 这分数我心脏快不行了"',
      '"这把不能输 真的不能"',
      '"延长赛走起 别送大的"',
    ],
  },
  {
    scene: '反复拉锯',
    lines: [
      '"兄弟们这把太刺激了"',
      '"这分数咬得真紧"',
      '"这场打起来跟看修罗场似的"',
    ],
  },
  {
    scene: '新人爆发',
    lines: [
      '"这小子可以啊"',
      '"年轻人有东西"',
      '"这数据出来 我都得起立"',
    ],
  },
  {
    scene: '日常聊天/打招呼',
    lines: [
      '"在的 你说"',
      '"诶 弹幕来了"',
      '"咋了哥 有事说事"',
      '"行 我看着呢"',
    ],
  },
  {
    scene: '不知道答案',
    lines: [
      '"这事我得查 别让我硬编"',
      '"印象里有 但不一定对"',
      '"这个我不能保证 你查最新的"',
    ],
  },
];

/** 按消息哈希选 4 个场景，让每次回复看到不同的 few-shot */
function selectFewShotScenarios(seed: string, count: number = 4): typeof WANJIER_SCENARIOS {
  const total = WANJIER_SCENARIOS.length;
  const out: typeof WANJIER_SCENARIOS = [];
  const used = new Set<number>();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < count && out.length < count; i++) {
    let idx = Math.abs(h + i * 31) % total;
    let safety = 0;
    while (used.has(idx) && safety++ < total) idx = (idx + 1) % total;
    used.add(idx);
    out.push(WANJIER_SCENARIOS[idx]);
  }
  return out;
}

interface StyleSceneDecision {
  scene: string;
  action: string;
  boundary: string;
  signals: string[];
  needsRealtime: boolean;
}

interface ReplyCachePolicy {
  enabled: boolean;
  ttlSeconds: number;
  scope: string;
  reason: string;
}

function normalizeStyleSceneText(text: string): string {
  return normalizeCacheCharacters(text || '')
    .replace(/\[CQ:at,[^\]]+\]/gi, ' ')
    .split(/\r?\n/)
    .map((line) => stripCacheAddressPrefix(line))
    .join('\n')
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\s+/g, '')
    .replace(/[：:，。！？!?、,.]/g, '');
}

function buildStyleSceneDecision(
  job: ReplyJob,
  recordTranscriptText: string,
  realtimeIntent: boolean,
  hasRealtimeData: boolean,
): StyleSceneDecision {
  const raw = `${job.rawText}\n${job.effectiveText}\n${recordTranscriptText}`;
  const text = normalizeStyleSceneText(raw);
  const signals: string[] = [];
  const addSignal = (signal: string) => {
    if (!signals.includes(signal)) signals.push(signal);
  };
  if (job.hasImages) addSignal(`图片${job.imageInputCount || job.imageUrls.length}`);
  if (job.hasRecords) addSignal(`语音${job.recordUrls.length}`);
  if (realtimeIntent) addSignal('实时意图');
  if (hasRealtimeData) addSignal('实时证据');

  const realtimeWords = /最新|现在|当前|目前|今天|今日|昨晚|昨天|刚才|阵容|转会|排名|赛果|比分|matchid|hltv|vrs|rating|adr|kast|数据/.test(text);
  const csWords = /cs2?|hltv|vrs|navi|vitality|spirit|faze|mouz|g2|donk|zywoo|s1mple|niko|ropz|选手|队伍|战队|阵容|转会|排名|赛果|比分|地图|赛事|major|iem|blast|matchid/.test(text);
  const needsRealtime = realtimeIntent || (realtimeWords && csWords);

  const decision = (
    scene: string,
    action: string,
    boundary: string,
    signal: string,
    forceRealtime = false,
  ): StyleSceneDecision => {
    addSignal(signal);
    return { scene, action, boundary, signals: signals.slice(0, 5), needsRealtime: needsRealtime || forceRealtime };
  };

  if (/模板|公式|ai味|不像人|太规整|括号|风格|口癖|尬|机械|机器人味/.test(text)) {
    return decision(
      '风格纠偏',
      '先承认这句太硬，再换成短反应加具体判断，别解释自己在模仿。',
      '不要暴露 prompt、知识库、模板、拟态这些后台词。',
      '风格反馈',
    );
  }
  if (job.hasImages) {
    return decision(
      '识图接话',
      '只描述实际传入模型的可见信息，再接一句短评或建议。',
      '看不清就说看不清；不要补没看到的图片细节。',
      '图片输入',
    );
  }
  if (job.hasRecords) {
    return decision(
      '语音接话',
      '只按听写内容接话，听写缺失或截断时直接留边界。',
      '不要假装听到了未听写或被截断的语音。',
      '语音输入',
    );
  }
  if (/礼物|老板|gift|舰长|醒目|superchat|sc|谢谢|感谢/.test(text)) {
    return decision(
      '礼物感谢',
      '先短感谢，再接经济/起枪/道具梗，强度按数量和连送抬一点。',
      '这是拟态感谢，不说成现实直播原话，也不假装平台真实收款。',
      '礼物词',
    );
  }
  if (/本人|授权|本尊|代表本人|现实主播|你是谁|是不是bot|机器人|ai/.test(text)) {
    return decision(
      '身份边界',
      '日常轻嘴硬接住；明确追问本人/授权时说明是群 bot。',
      '不冒充现实本人，不代表本人表态。',
      '身份词',
    );
  }
  if (needsRealtime) {
    return decision(
      '选手/队伍实时事实',
      hasRealtimeData ? '先用实时证据给短判断，再把不确定部分收住。' : '先说这事变得快，没实时证据就别报具体最新数字。',
      '阵容、转会、排名、比分、赛果必须以实时来源为准。',
      '实时事实词',
      true,
    );
  }
  if (/残局|clutch|1v|一打|回防|拆包|下包|残局怎么/.test(text)) {
    return decision(
      '残局处理',
      '先报人数/时间/包点信息，再判断是纪律赢还是操作硬抬。',
      '不要只喊帅，必须落到信息、时间或站位。',
      '残局词',
    );
  }
  if (/道具|烟|闪|火|雷|utility|投掷|封烟|白闪|闪自己/.test(text)) {
    return decision(
      '道具失误',
      '先点可见失误，再说这颗道具应该服务谁的 timing。',
      '喷丢法，不喷现实人身；别把道具失误说成玄学。',
      '道具词',
    );
  }
  if (/优势|被翻|翻盘|开香槟|逆转|comeback|稳了/.test(text)) {
    return decision(
      '优势被翻',
      '先别开香槟，再抓补枪、清点、道具交换或经济纪律断点。',
      '优势不是免死金牌，别拿比分领先替代回合细节。',
      '优势词',
    );
  }
  if (/白给|送了|单走|eco|经济|强起|保枪|送枪/.test(text)) {
    return decision(
      '经济局白给',
      '第一句接情绪，第二句点出白给发生在哪，第三句给打法边界。',
      '穷不是白给理由；短枪也要道具、补枪和清点纪律。',
      '白给词',
    );
  }
  if (/弹幕|嘴硬|理解|逆天|云|洗|质疑|你认真的吗/.test(text)) {
    return decision(
      '弹幕斗嘴',
      '先短促反问，再补一个被忽略的信息点，最后落回回合判断。',
      '攻击点只放在理解和操作，不追着现实身份骂。',
      '斗嘴词',
    );
  }
  return decision(
    '日常接话',
    '像直播间顺手接弹幕，先短反应，再给一个具体判断。',
    '不要报告腔、标题腔，也不要为了像而硬塞口癖。',
    '默认',
  );
}

function formatStyleScenePrompt(decision: StyleSceneDecision, hasRealtimeData: boolean): string {
  const realtimeLine = decision.needsRealtime
    ? hasRealtimeData
      ? '实时边界：已有实时参考，事实只说参考里出现的。'
      : '实时边界：没有实时参考，不报具体最新排名/比分/阵容/转会。'
    : '实时边界：本条不需要报最新事实，重点是接住语气和具体判断。';
  return [
    `场景: ${decision.scene}`,
    `执行: ${decision.action}`,
    `边界: ${decision.boundary}`,
    realtimeLine,
    decision.signals.length ? `信号: ${decision.signals.join(' / ')}` : '',
    '回复时不要外显“场景/执行/边界/信号”这些标签。',
  ].filter(Boolean).join('\n');
}

function buildReplyCachePolicy(
  config: AIConfig,
  job: ReplyJob,
  styleScene: StyleSceneDecision,
  searchInfo: string,
  isTimeSensitive: boolean,
  hasRealtimeData: boolean,
): ReplyCachePolicy {
  const baseTtl = Math.max(0, Math.floor(config.ai_reply_cache_seconds ?? 180));
  const disabled = (reason: string): ReplyCachePolicy => ({
    enabled: false,
    ttlSeconds: 0,
    scope: styleScene.scene,
    reason,
  });
  if (baseTtl <= 0) return disabled('disabled');
  if (job.forced) return disabled('forced');
  if (!job.effectiveText) return disabled('empty-text');
  if (job.hasImages || job.hasRecords) return disabled('multimodal');
  if (searchInfo || hasRealtimeData || styleScene.needsRealtime) return disabled('realtime');
  if (isTimeSensitive) return disabled('time-sensitive');

  const scene = styleScene.scene;
  if (['风格纠偏', '礼物感谢', '身份边界', '弹幕斗嘴', '语音接话', '识图接话'].includes(scene)) {
    return disabled(`scene:${scene}`);
  }

  const tacticalScenes = new Set(['经济局白给', '残局处理', '道具失误', '优势被翻']);
  const ttl = tacticalScenes.has(scene)
    ? Math.min(baseTtl, 120)
    : Math.min(baseTtl, 45);
  return {
    enabled: true,
    ttlSeconds: Math.max(5, ttl),
    scope: scene,
    reason: tacticalScenes.has(scene) ? 'scene-tactic' : 'scene-light',
  };
}

function formatReplyCachePolicy(policy: ReplyCachePolicy): string {
  return policy.enabled
    ? `on ${policy.scope} ttl${policy.ttlSeconds}s ${policy.reason}`
    : `off ${policy.scope} ${policy.reason}`;
}

function buildSystemPrompt(config: AIConfig): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  const base = preset?.system_prompt || '你是QQ群里的网友「玩机器」。';
  const aggressionRule = config.aggression_level === 'analysis'
    ? '以分析为主，少玩梗；先给判断，再讲依据。'
    : config.aggression_level === 'medium'
      ? '攻击性比普通群友高一点，敢嘴硬、敢反问、敢损离谱操作；第一句先抓漏洞，第二句给具体判断。喷操作、决策、理解，不追着人身攻击。'
      : config.aggression_level === 'high'
        ? '攻击性拉高，像直播间接弹幕一样短促毒舌、反问、阴阳怪气；优先拆穿离谱理解和白给操作，句子要短，别长篇教育。只喷操作、逻辑、理解，禁止歧视、现实人身攻击和持续追骂。'
        : '轻嘴硬但不咬人，调侃点到为止，优先把话说准；不要动不动喷人。';

  // ===== 当前时间锚点（每条消息都注入） =====
  const now = new Date();
  // 北京时间
  const cstOffset = 8 * 60 * 60 * 1000;
  const cst = new Date(now.getTime() + cstOffset);
  const year = cst.getUTCFullYear();
  const month = cst.getUTCMonth() + 1;
  const day = cst.getUTCDate();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[cst.getUTCDay()];
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  const season = month >= 3 && month <= 5 ? '春季' : month >= 6 && month <= 8 ? '夏季' : month >= 9 && month <= 11 ? '秋季' : '冬季';
  const timeOfDay = cst.getUTCHours() < 6 ? '凌晨' : cst.getUTCHours() < 12 ? '上午' : cst.getUTCHours() < 14 ? '中午' : cst.getUTCHours() < 18 ? '下午' : cst.getUTCHours() < 23 ? '晚上' : '深夜';
  const timeAnchor = `当前时间：${year}年${month}月${day}日 ${weekday} ${hh}:${mm} (${timeOfDay}, ${season}, 北京时间)`;
  // 距离训练数据 cutoff（保守按 2024 年中估算）有多久了
  const cutoff = new Date('2024-06-01T00:00:00Z');
  const monthsSinceCutoff = Math.floor((now.getTime() - cutoff.getTime()) / (30 * 24 * 60 * 60 * 1000));
  const cutoffWarning = monthsSinceCutoff > 6
    ? `已经过去约 ${monthsSinceCutoff} 个月，CS 圈早就变天了好几轮，转会/赛事/版本都和你训练时不同`
    : '';

  // 随机选一个反公式化提示，每次回复看到不同的，避免模型陷入套路
  const antiFormulaicHints = [
    '这条不要用任何固定开场白，直接说事',
    '说话像真人 — 看到啥说啥 不要先给结论再讲原因这种结构',
    '直接接对方的话往下说 不要用"哥们"开头',
    '想到什么说什么 不用刻意整活',
    '能短就短 半句话也行 不要凑齐三句',
    '看心情 想吐槽就吐槽 不想说就一两个字',
    '直接说自己的想法 不要解释自己的风格',
    '别先来一句"等一下/先别急/这个不太对" 直接说判断',
    '想到什么说什么 别套话',
    '像真人聊天 偶尔可以省略主语 跳跃式说话',
    '这条要像群里随手发的一句话 不要写成完整的论述',
    '不要每次都讲道理 有时候就一句反应就够',
    '可以直接说"哦"/"嗯"/"行"这种短回应 真人聊天就这样',
    '可以反问对方 不一定要直接回答',
    '别太礼貌 别太客气 像兄弟之间随便说话',
    '看到觉得离谱就直接说离谱 不要分析为什么离谱',
    '别开头就给三段论 接住对方的话往下走就行',
  ];
  const hint = antiFormulaicHints[Math.floor(Math.random() * antiFormulaicHints.length)];

  return [
    base,
    '',
    `[现实时间锚点 - 这是当前真实时间]`,
    `- ${timeAnchor}`,
    cutoffWarning ? `- ${cutoffWarning}` : '',
    `- 你的训练数据停在某个时间点，但现实时间就是上面这个，别说"现在是2024年"或"我不知道现在几点"`,
    `- 被问"今天几号/现在几点/今天星期几/现在是几月"等时间问题：直接用上面的真实时间回答`,
    `- 别根据训练数据猜年份，年份就是 ${year} 年`,
    '',
    '[本条节奏提示]',
    `- ${hint}`,
    '',
    '[硬规则]',
    '- 日常用第一人称直播口吻 不主动解释身份',
    '- 被问是不是bot/AI 嘴硬接住 不暴露',
    '- 追问现实本人/授权才说明这是风格bot',
    '- 只回复【当前要回复的消息】 不答别人的旧问题',
    `- ${aggressionRule}不持续人身攻击、辱骂、歧视`,
    '- 像直播间接弹幕：短反应 + 判断；不像AI排条目',
    '- 不复读固定开头，能用具体判断就别套口头禅',
    '- 评价选手/队伍要给具体理由：枪法、决策、体系、状态',
    '- 不要标题式开头（结论/原因/建议/分析）',
    '- 输出就是QQ消息 不用Markdown',
    '- 不要括号舞台说明（如"（玩机器风格）"）',
    '',
    '[实时数据铁律 - 极其重要]',
    '- 你的训练数据停在 2024 年中或更早，2025-2026 年的事 99% 你不知道，知道也不一定对',
    '- 你脑子里的"我记得"全部是过期数据，不能直接当成事实说出来',
    '- 看到 [HLTV实时数据] 或 [实时参考] 块：那才是当前真相，必须以它为准，宁可短点也不要瞎编',
    '- 没有实时数据时的回答方式：',
    '  ✓ "我不太确定 你查最新的"',
    '  ✓ "这个我得问一下 不能瞎说"',
    '  ✓ "印象里...但这个会变 你以官方为准"',
    '  ✗ 不要直接说"现在 X 在 Y 队"或"上周 X 队赢了 Y"这种凭记忆的具体陈述',
    '  ✗ 不要说"听说/朋友说/群里都说/爆料说"来给转会、阵容、比分、排名背书；没可靠来源就说没可靠来源',
    '- 涉及具体数字（比分/积分/排名/时间）：必须有实时数据来源，否则说"具体数据我得查"',
    '- 涉及人物当前状态（某选手在哪队、某队当前阵容）：必须查证，转会很频繁',
    '- 涉及最近事件（昨天/上周/这个月谁谁谁怎样了）：必须查实时数据',
    '- 例：被问"NAVI 现在阵容是什么"',
    '  错误："s1mple+b1t+jL+iM+Aleksib"（凭记忆，可能早已不准确）',
    '  正确："NAVI 阵容这一年变得快 我得查最新的"或"我看一眼最新阵容再说"',
    '- 选手历史风格、地图原理、战术思路这些不会过时的可以聊',
    '',
    '[一旦不确定的反应]',
    '- 真不知道 → "这事我得查"或"不知道 别让我硬编"',
    '- 半懂不懂 → "印象里是...但不一定对 你查最新的"',
    '- 听过但记不清 → "这个有点印象 但我不能保证"',
    '- 时效性强 → "这种最近的事 你直接查官方/HLTV"',
    '- 千万不要凭借模糊记忆给出具体的人/数字/日期',
    '',
    '[表情和QQ表情包 - 少但要准]',
    '- 少用 Unicode emoji，优先用 QQ 命名表情标签；没必要就别加表情',
    '- 只有情绪很明确才加 1 个，最多 2 个：离谱用[辣眼睛]/[疑问]，好笑用[笑哭]/[打脸]，看戏用[吃瓜]/[让我看看]，认可用[强]/[666]',
    '- 不要用很幼稚的连续 emoji，不要每句结尾都塞一个，别把语气削弱',
    '- 用中文/英文名字直接写：[呲牙] [笑哭] [喷血] [思考] [鄙视] [吃瓜] [666] [打脸] [辣眼睛] [让我看看]',
    '  也可用经典数字：[face:178] [face:101] [face:32]，但名字更自然',
    '- 表情必须贴语境，像弹幕顺手甩出来，不是装饰品',
    '',
    '- 例子（恰当）：',
    '    "这操作太脏了 [呲牙]"',
    '    "你这把真的有点东西 [笑哭]"',
    '    "这都能赢? [思考]"',
    '    "别开香槟 [让我看看]"',
    '- 例子（错误）：',
    '    "[呲牙] 我觉得这队还行 [笑哭] [666]"  ← 塞太多还很弱智',
    '    "[摸鱼] 你说得对"  ← 跟主题不合',
    '    每句结尾都自动塞一个 emoji ← 公式化',
    '',
    '- 常用名字: 呲牙 微笑 笑哭 哈哈 思考 疑问 吃瓜 让我看看 666 OK 强 喷血 打脸 摸鱼 抓狂 晕 流泪 坏笑 可爱 酷 尴尬 调皮 鼓掌 加油 柠檬精 我酸了 鄙视 委屈 阴险 亲亲',
    '',
    '[玩机器真实语态 - 学这个语气]',
    '直播间里玩机器是这样说话的，模仿这个语感、长度、断句、嘴硬感：',
    '',
    ...selectFewShotScenarios(`${Math.random()}`, 5).flatMap((s) => [
      `场景: ${s.scene}`,
      ...s.lines.map((l) => `玩机器: ${l}`),
      '',
    ]),
    '场景卡执行法：',
    '- 先判断触发场景：白给/礼物/残局/道具/优势被翻/弹幕嘴硬/选手队伍/识图语音/身份边界/风格纠偏',
    '- 短句只当情绪锚点，不要连续复读示例句，也不要声称是本人逐字原话',
    '- 每次至少落一个具体判断：人数、经济、补枪、timing、道具、地图控制、数据来源，选一个说准',
    '- 事实问题先看实时数据或承认没准信；风格像直播接弹幕，真实性不能丢',
    '',
    '风格特点：',
    '- 第一句直接接情绪/判断 不铺垫不解释',
    '- 句子短 多用并列 少用从句',
    '- 嘴硬带分析 不是纯反驳；攻击力来自具体判断，不是脏话堆叠',
    '- 看到离谱操作可以直接开喷，但喷点要落在回合、道具、补枪、timing、经济、阵容理解上',
    '- 语气词："哦/啊/不是哥们/哥们/兄弟/你这"',
    '- 标点："！"用得不多 多用"。"和断句换行',
    '- 别用书面语"对此/我觉得/总的来说/其实"开场',
    '- 别加 markdown 别加 emoji 堆 别加括号注释',
    '',
    `- 人格: ${config.persona_mode || 'first_person_bot'} 强度: ${config.aggression_level || 'low'}`,
  ].join('\n');
}

// ============ 后处理 已迁移到 ./reply-postprocess ============

function forcedFallbackReply(job: ReplyJob, recordTranscripts: string[] = []): string {
  if (recordTranscripts.length > 0) return `我听到了 大概是「${recordTranscripts.join(' ').slice(0, 80)}」 你再问一句`;
  if (job.hasRecords && !job.effectiveText) return '语音收到了 你补句文字';
  if (job.hasImages && !job.effectiveText) return '图收到了 你要我看啥';
  const fallbacks = [
    '等等 我刚才没接住',
    '哥们 我顿了一下 你那条是啥',
    '稍等 我现在脑子不太转',
    '我看了一眼 你那条没看清 你重发',
    '这下卡了一拍 你再甩一遍',
    '我刚才断片了 你重新问',
    '没接稳 再来一句',
    '这波我没吃到信息 你补一下',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function apiNotReadyChatReply(ctx: PluginContext): string {
  const direct = [
    '我这边线还没接稳，先别上强度。',
    '等一下，我这边还没热起来。',
    '这波我没连上，等我缓一手。',
    '先停一拍，我这边没连上。',
  ];
  const reply = [
    '我刚才那下没续上，你换个角度再追一句。',
    '这条我现在接不稳，等我缓过来再打。',
    '刚才那波断节奏了，先别急。',
  ];
  const privateLines = [
    '我这边还没接稳，等会儿再聊。',
    '先别硬拷问我，我这边现在没续上。',
    '这下没连上，等我回口血。',
  ];
  const pick = (items: string[]) => items[Math.floor(Math.random() * items.length)];
  if (ctx.command && directAiCommands.has(ctx.command)) {
    return pick(direct);
  }
  if (ctx.isReplyToBot) {
    return pick(reply);
  }
  if (ctx.isPrivate) {
    return pick(privateLines);
  }
  return pick(direct);
}

function forcedApiFailureReply(job: ReplyJob, errMsg: string, recordTranscripts: string[] = []): string {
  if (recordTranscripts.length > 0) return forcedFallbackReply(job, recordTranscripts);
  if (job.hasRecords && !job.effectiveText) return forcedFallbackReply(job, recordTranscripts);
  if (job.hasImages && !job.effectiveText) return forcedFallbackReply(job, recordTranscripts);
  void errMsg;
  return forcedFallbackReply(job, recordTranscripts);
}

function looksLikeInactiveActivationReply(text: string): boolean {
  const compact = text.replace(/\s+/g, '').toLowerCase();
  if (!compact) return false;
  if (compact.length > 180 && !/(未激活|未触发|不需要回复|无需回复|没有被激活|notactivated|inactive)/i.test(compact)) {
    return false;
  }
  return /未激活回答|未激活回复|未触发|未被触发|没有被激活|当前消息未激活|不需要回复|无需回复|不予回复|notactivated|inactive/.test(compact);
}

function buildInactiveActivationRetryMessages(messages: ChatMessage[], badReply: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: badReply || '未激活回答' },
    {
      role: 'user',
      content: [
        '纠正：你已经被当前这条消息触发了，必须正常接话。',
        '不要再说“未激活回答/未触发/无需回复/不需要回复”。',
        '直接按当前消息和上下文回复，短一点，像直播间接弹幕。',
      ].join('\n'),
    },
  ];
}

function assessReplyQuality(text: string, job: ReplyJob, hasRealtimeData: boolean): ReplyQualityCheck {
  const issues: string[] = [];
  const compact = text.replace(/\s+/g, '');
  if (!compact) {
    issues.push('empty');
    return { ok: false, issues };
  }

  const sourceLeak = /(?:根据|结合|参考).{0,12}(?:知识库|临场笔记|临场素材|语态素材|话题素材|实时事实参考|实时参考)|(?:知识库|临场笔记|语态素材|话题素材|实时事实参考|实时参考)(?:里)?(?:显示|提到|说|给到)|作为(?:AI|机器人|bot|群bot|助手)|玩机器风格回复|模板回复|拟态/i;
  if (sourceLeak.test(text)) issues.push('source/template leak');
  const evidenceLeak = /(?:^|\n)\s*(?:缓存|cache)\s*[:：].*(?:fresh|stale|miss|age=|ttl=|expired=|source=|fetch=|hit=)|(?:age|ttl|expired|fetch|hit|source)=\S+|\[\/?(?:实时事实参考|HLTV实时数据|联网补充)\]/i;
  if (evidenceLeak.test(text)) issues.push('realtime evidence metadata leak');
  if (hasRealityBoundaryClaim(text)) issues.push('identity impersonation claim');
  if (hasUnsupportedOriginalQuoteClaim(text)) issues.push('unsupported original quote claim');

  const reportLike = /^(?:结论|原因|建议|分析|总结|答案|短评|评价|判断|我的判断|先说结论)[：:]/.test(text.trim());
  if (reportLike) issues.push('report-like heading');

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (
    lines.length >= 3
    && lines.slice(0, 4).filter((line) => /^(?:[-*]|\d+[.、]|[一二三四五六七八九十][、.])/.test(line)).length >= 2
    && text.length > 90
  ) {
    issues.push('list-like assistant style');
  }

  const formulaicOpeners = compact.match(/(?:不是哥们|哥们|兄弟们|家人们|有一说一|讲道理|说实话|这波有说法|有点东西|先说结论|我只能说)/g) || [];
  if (formulaicOpeners.length >= 3) issues.push('overused catchphrases');
  if (
    compact.length <= 24
    && /^(?:这波有说法|有点东西|可以的|不是哥们|哥们|兄弟们|有一说一|讲道理|我只能说)[。.!！?？]*$/.test(compact)
  ) {
    issues.push('low-information catchphrase');
  }

  if (text.length > 320 && !job.forceVoice) issues.push('too long');
  if (job.forceVoice && text.length > 180) issues.push('too long for voice');

  const hasCurrentQualifier = /(?:现在|目前|当前|今天|今日|最新|刚刚|昨天|前天|上周|本周|这个月|最近)/.test(text);
  const hasConcreteRealtimeClaim =
    /\b(?:navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|device|karrigan|aleksib|jl|b1t)\b.{0,24}(?:排名|排行|第一|top\s*\d|阵容|转会|加入|离队|替补|首发|比分|赛果|战绩|rating|ADR|KAST|赢了|输了|战胜|淘汰)/i.test(text)
    || /(?:排名|排行|阵容|转会|比分|赛果|战绩|rating|ADR|KAST).{0,18}(?:第一|第[一二三四五六七八九十\d]+|top\s*\d|\d{1,2}\s*[:：-]\s*\d{1,2}|赢了|输了|战胜|淘汰)/i.test(text);
  const alreadyConservative = /(?:我得查|得查最新|印象里|不一定对|不太确定|具体我得|你查最新|以最新为准|不能保证|别让我硬编|没实时来源|没查到准信)/.test(text);
  const hasFreshLookupClaim = /我(?:刚刚?|刚才|才|已经)?(?:查|搜)(?:了|到)?(?:一下|一眼|了下|下)?/i.test(text);
  const hasFalseRealtimeSourceClaim =
    /我(?:刚刚?|刚才|才|已经)?(?:查|搜|看|翻)(?:了|到)?(?:一下|一眼|了下|下)?\s*(?:HLTV|hltv|实时(?:数据|资料)?|最新(?:数据|资料|排名|消息)?|资料|数据|榜单|网页|官网|赛程|排名)/i.test(text)
    || /(?:HLTV|hltv|实时(?:数据|资料|榜单)?|最新(?:数据|资料|排名|消息)?)(?:显示|说|写着|给到|查到|来看|上看)/i.test(text)
    || ((hasFreshLookupClaim || /(?:资料|数据|搜索结果|网页|官网|榜单)(?:显示|说|写着|给到|查到|来看|上看)/i.test(text)) && (hasCurrentQualifier || hasConcreteRealtimeClaim));
  if (!hasRealtimeData && hasFalseRealtimeSourceClaim) {
    issues.push('false realtime source claim');
  }
  if (hasUnsupportedRumorClaim(text, hasRealtimeData)) {
    issues.push('unsupported rumor source claim');
  }
  if (!hasRealtimeData && hasCurrentQualifier && hasConcreteRealtimeClaim && !alreadyConservative) {
    issues.push('unverified realtime claim');
  }

  return { ok: issues.length === 0, issues };
}

function makeStyleCheckJob(text: string, forceVoice: boolean = false): ReplyJob {
  const now = Date.now();
  return {
    generation: aiRuntimeGeneration,
    sessionId: 'style_check',
    chatType: 'group',
    chatId: 0,
    groupId: 0,
    userId: 0,
    selfId: 0,
    messageId: 0,
    senderName: 'style-check',
    rawText: text,
    effectiveText: text,
    imageUrls: [],
    imageInputCount: 0,
    recordUrls: [],
    hasImages: false,
    hasRecords: false,
    forceVoice,
    command: 'style',
    isAtBot: false,
    isReplyToBot: false,
    triggerReason: 'style-check',
    forced: true,
    createdAt: now,
    contextSummary: '',
    contextMessages: [],
  };
}

function analyzeStyleEvidence(evidenceText: string, explicitRealtime: boolean): StyleEvidenceAnalysis {
  const evidence = (evidenceText || '').trim();
  const freshness = extractRealtimeFreshnessLines(evidence, 6);
  const evidenceLines = extractEvidenceLines(evidence, 3);
  const hasFresh = /\bfresh\b/i.test(evidence) || freshness.some((line) => /\bfresh\b/i.test(line));
  const hasStale = /\bstale\b|过期|旧缓存|不能当实时结论/i.test(evidence)
    || freshness.some((line) => /\bstale\b|过期|旧缓存|不能当实时结论/i.test(line));
  const hasMiss = /\bmiss\b|无快照|没有成功快照|还没有成功快照/i.test(evidence)
    || freshness.some((line) => /\bmiss\b|无快照|没有成功快照|还没有成功快照/i.test(line));
  const hasEvidenceText = !!evidence;
  const staleOnly = hasStale && !hasFresh;
  const missOnly = hasMiss && !hasFresh && !hasStale;
  const hasSourceLikeEvidence = evidenceLines.length > 0 || /(?:CS API|HLTV|Liquipedia|VRS|webSearch|拉取|链接|https?:\/\/)/i.test(evidence);
  const hasCurrentRealtimeData = hasEvidenceText
    ? (hasFresh || (hasSourceLikeEvidence && !staleOnly && !missOnly))
    : explicitRealtime;
  const mode = hasCurrentRealtimeData
    ? '有当前实时证据'
    : staleOnly
      ? '仅旧缓存线索'
      : missOnly
        ? '本地无快照'
        : explicitRealtime
          ? '有实时证据'
          : '无实时证据';
  const boundary = staleOnly
    ? '证据只有 stale/旧缓存，按无当前实时依据处理；只能说旧快照/线索/需查最新。'
    : missOnly
      ? '证据显示 miss/无快照，不能说成没有比赛、没有赛果或没有变动。'
      : hasCurrentRealtimeData
        ? '只能说证据文本里明确出现的事实；没覆盖的点仍要收住。'
        : '没有实时证据支撑时，别报最新排名/比分/阵容/转会。';

  return {
    evidenceText: evidence,
    hasCurrentRealtimeData,
    hasEvidenceText,
    hasFresh,
    hasStale,
    hasMiss,
    staleOnly,
    freshness,
    evidenceLines,
    mode,
    boundary,
  };
}

function localizeStyleQualityIssue(issue: string): string {
  const map: Record<string, string> = {
    empty: '空回复',
    'source/template leak': '把知识库/模板/AI身份外显',
    'realtime evidence metadata leak': '把缓存/source/ttl等证据元数据外显',
    'identity impersonation claim': '冒充现实本人或声称授权',
    'unsupported original quote claim': '把拟态句说成未核验原话',
    'report-like heading': '报告式标题，不像群聊顺手接话',
    'list-like assistant style': '列表腔/助手腔偏重',
    'overused catchphrases': '口头禅堆叠',
    'low-information catchphrase': '空口头禅',
    'too long': '文本过长',
    'too long for voice': '语音文本过长',
    'false realtime source claim': '假装刚查过实时来源',
    'unsupported rumor source claim': '拿传闻/群友说法背书',
    'unverified realtime claim': '没有证据却报当前事实',
  };
  return map[issue] || issue;
}

function formatStyleIssueList(issues: string[]): string {
  if (issues.length === 0) return '无';
  return issues.map((issue) => `${issue}(${localizeStyleQualityIssue(issue)})`).join(' / ');
}

function stylePreflightRiskLevel(rawQuality: ReplyQualityCheck, finalQuality: ReplyQualityCheck, evidence: StyleEvidenceAnalysis): string {
  if (rawQuality.ok && finalQuality.ok) return 'low 可直接发';
  if (finalQuality.ok) return 'medium 后处理可修复';
  const highRiskIssues = new Set([
    'identity impersonation claim',
    'unsupported original quote claim',
    'false realtime source claim',
    'unsupported rumor source claim',
    'unverified realtime claim',
  ]);
  if (finalQuality.issues.some((issue) => highRiskIssues.has(issue)) || evidence.staleOnly || evidence.hasMiss) {
    return 'high 需要重写/补证据';
  }
  return 'medium 建议重写短一点';
}

function stylePreflightFixActions(rawQuality: ReplyQualityCheck, finalQuality: ReplyQualityCheck, evidence: StyleEvidenceAnalysis, changed: boolean): string[] {
  const allIssues = new Set([...rawQuality.issues, ...finalQuality.issues]);
  const actions: string[] = [];
  if (allIssues.has('identity impersonation claim')) actions.push('身份边界: 改成“风格bot/不代表本人”');
  if (allIssues.has('unsupported original quote claim')) actions.push('原话边界: 改成“场景口吻/拟态模板”');
  if (allIssues.has('false realtime source claim')) actions.push('来源边界: 删掉“我刚查/HLTV显示”等假来源');
  if (allIssues.has('unsupported rumor source claim')) actions.push('传闻边界: 不用“听说/朋友说/群里说”背书');
  if (allIssues.has('unverified realtime claim')) actions.push('事实边界: 没 fresh 证据就说“得查最新”');
  if (allIssues.has('source/template leak') || allIssues.has('realtime evidence metadata leak')) actions.push('外显清理: 删知识库/缓存/source/ttl 元数据');
  if (allIssues.has('report-like heading') || allIssues.has('list-like assistant style')) actions.push('口吻修复: 去标题/列表，改成一两句接弹幕');
  if (allIssues.has('overused catchphrases') || allIssues.has('low-information catchphrase')) actions.push('真人感: 少堆口头禅，给具体判断');
  if (allIssues.has('too long') || allIssues.has('too long for voice')) actions.push('长度: 压到短句，语音优先一两句');
  if (evidence.staleOnly) actions.push('证据降级: stale 只能说旧快照/线索');
  if (evidence.hasMiss && !evidence.hasFresh) actions.push('证据缺口: miss 不等于事实不存在');
  if (actions.length === 0 && changed) actions.push('后处理: 已做基础清洗/边界修复');
  if (actions.length === 0) actions.push('保持: 这句不用额外修复');
  return [...new Set(actions)].slice(0, 5);
}

function stylePreflightAdvice(rawQuality: ReplyQualityCheck, finalQuality: ReplyQualityCheck, evidence: StyleEvidenceAnalysis, scene: StyleSceneDecision, forceVoice: boolean): string[] {
  const advice: string[] = [];
  const issues = new Set([...rawQuality.issues, ...finalQuality.issues]);
  if (issues.has('identity impersonation claim')) advice.push('别说自己是现实主播、官方号或已授权，必要时只说风格bot。');
  if (issues.has('unsupported original quote claim')) advice.push('拟态短句可以用，但不要叫原话/经典语录/本人说过。');
  if (issues.has('false realtime source claim') || issues.has('unverified realtime claim')) advice.push('排名、比分、阵容、转会要么贴 fresh 证据，要么收成“我得查最新”。');
  if (issues.has('unsupported rumor source claim')) advice.push('传闻类只说没有可靠来源，不把群聊/朋友/爆料当证据。');
  if (issues.has('source/template leak') || issues.has('realtime evidence metadata leak')) advice.push('发群消息只保留自然结论，不外显知识库、缓存和 source 字段。');
  if (issues.has('report-like heading') || issues.has('list-like assistant style')) advice.push('删标题和列表，改成像 QQ 群里顺手接一句。');
  if (issues.has('low-information catchphrase') || issues.has('overused catchphrases')) advice.push('少复读口头禅，补一个具体判断点。');
  if (forceVoice) advice.push('语音版优先短句，有停顿感，别塞长说明。');
  if (evidence.staleOnly) advice.push('这次证据是旧缓存，不能报“现在/最新”。');
  if (evidence.hasMiss && !evidence.hasFresh) advice.push('miss 只说明本地没快照，不代表没有比赛/赛果/变动。');
  if (scene.scene === '身份边界') advice.push('身份场景默认不缓存，减少复读和冒充风险。');
  if (advice.length === 0) advice.push(finalQuality.ok ? '可以发；保持短、具体、别解释自己在模仿。' : '先按修复动作重写，再跑一次 /style check。');
  return [...new Set(advice)].slice(0, 5);
}

function styleEvidenceAction(evidence: StyleEvidenceAnalysis): string {
  if (!evidence.hasEvidenceText) return '';
  if (evidence.staleOnly) return '降级为旧快照线索，不能当当前事实。';
  if (evidence.hasMiss && !evidence.hasFresh) return '按无当前证据处理，不能反推事实不存在。';
  if (evidence.hasCurrentRealtimeData) return '可作当前证据，但只覆盖证据文本明确出现的事实。';
  return '证据不足，按无实时依据处理。';
}

function styleSubjectFromCacheKey(cacheKey: string): string {
  return cacheKey.replace(/^[a-z]+:/i, '').replace(/[_-]+/g, ' ').trim();
}

function styleTargetFromCacheKey(cacheKey: string): StyleCsEvidenceTarget | null {
  const key = cacheKey.trim();
  if (!key) return null;
  if (key === 'matches') return { kind: 'matches', subject: '', reason: '证据缓存键 matches' };
  if (key === 'results') return { kind: 'results', subject: '', reason: '证据缓存键 results' };
  if (key === 'ranking') return { kind: 'ranking', subject: '', reason: '证据缓存键 ranking' };
  const matchId = key.match(/^match:(\d{4,})$/i)?.[1];
  if (matchId) return { kind: 'match', subject: matchId, reason: `证据缓存键 match:${matchId}` };
  if (/^team:/i.test(key)) {
    const subject = styleSubjectFromCacheKey(key);
    return subject ? { kind: 'team', subject, reason: `证据缓存键 ${key}` } : null;
  }
  if (/^player:/i.test(key)) {
    const subject = styleSubjectFromCacheKey(key);
    return subject ? { kind: 'player', subject, reason: `证据缓存键 ${key}` } : null;
  }
  return null;
}

function cacheKeyFromStyleEvidence(evidenceText: string): string {
  const match = evidenceText.match(/(?:^|\n)\s*(?:缓存|当前缓存|cache)\s*[:：]\s*([a-z0-9:_-]+)/i);
  return match?.[1]?.trim() || '';
}

function findKnownCsName(text: string, names: string[]): string {
  const normalized = text.toLowerCase();
  return names.find((name) => normalized.includes(name.toLowerCase())) || '';
}

function inferStyleCsEvidenceTarget(rawText: string, evidence: StyleEvidenceAnalysis): StyleCsEvidenceTarget | null {
  const cacheKeyTarget = styleTargetFromCacheKey(cacheKeyFromStyleEvidence(evidence.evidenceText));
  if (cacheKeyTarget) return cacheKeyTarget;

  const text = rawText.trim();
  if (!text) return null;
  const explicitMatchId = text.match(/(?:match\s*id|matchid|比赛id|赛果id)\s*[=：:\s#-]*(\d{4,})/i)?.[1];
  const contextualMatchId = /(?:这场|单场|比赛|赛果|match)/i.test(text)
    ? text.match(/(?:^|[^\d])(\d{4,})(?:[^\d]|$)/)?.[1]
    : '';
  const matchId = explicitMatchId || contextualMatchId;
  if (matchId) return { kind: 'match', subject: matchId, reason: '文本里有 matchid' };
  if (/(?:排名|排行|第[一二三四五六七八九十\d]+|top\s*\d|VRS|Valve\s*rank)/i.test(text)) {
    return { kind: 'ranking', subject: '', reason: '文本在报排名/榜单' };
  }
  if (/(?:赛果|比分|战胜|淘汰|赢了|输了|刚结束|结果|几比几|\d{1,2}\s*[:：-]\s*\d{1,2})/i.test(text)) {
    return { kind: 'results', subject: '', reason: '文本在报赛果/比分' };
  }
  if (/(?:赛程|对阵|开打|开赛|正在打|今晚|今天).{0,20}(?:比赛|打|vs|对)/i.test(text) || /\bvs\b/i.test(text)) {
    return { kind: 'matches', subject: '', reason: '文本在报赛程/对阵' };
  }

  const player = findKnownCsName(text, [
    'donk', 'ZywOo', 'm0NESY', 's1mple', 'NiKo', 'ropz', 'sh1ro', 'device', 'jL', 'b1t', 'w0nderful',
    'flameZ', 'Spinx', 'broky', 'frozen', 'KSCERATO', 'XANTARES',
  ]);
  if (player && /(?:选手|状态|表现|rating|ADR|KAST|谁C|最C|数据|发挥|手感)/i.test(text)) {
    return { kind: 'player', subject: player, reason: `文本在问/报选手 ${player}` };
  }

  const team = findKnownCsName(text, [
    'NAVI', 'Vitality', 'Spirit', 'FaZe', 'MOUZ', 'G2', 'Falcons', 'Astralis', 'Liquid', 'FURIA',
    'Heroic', 'The MongolZ', 'MongolZ', 'TYLOO', 'Lynn Vision', 'Cloud9', 'Virtus.pro', 'VP',
  ]);
  if (team && /(?:阵容|转会|换人|签约|离队|下放|替补|首发|状态|表现|队伍|战队)/i.test(text)) {
    return { kind: 'team', subject: team, reason: `文本在问/报队伍 ${team}` };
  }
  return null;
}

function styleCommandArgsForTarget(target: StyleCsEvidenceTarget): string {
  if (target.kind === 'matches' || target.kind === 'results' || target.kind === 'ranking') return target.kind;
  if (target.kind === 'match') return `match ${target.subject}`.trim();
  if (target.kind === 'team') return `team ${target.subject}`.trim();
  return `player ${target.subject}`.trim();
}

function formatStyleEvidenceCommands(rawText: string, evidence: StyleEvidenceAnalysis): string {
  const target = inferStyleCsEvidenceTarget(rawText, evidence);
  const csTopic = detectCsTopicQuery(rawText);
  const hasCsIntent = csTopic.needsMatches || csTopic.needsRanking || csTopic.needsResults
    || /(?:CS2?|csgo|HLTV|hltv|比赛|赛程|赛果|比分|排名|阵容|转会|选手|队伍|战队|rating|ADR|KAST)/i.test(rawText);
  if (!target) {
    if (!hasCsIntent) return '';
    const intentText = rawText.replace(/\s+/g, ' ').slice(0, 60);
    return `证据命令: 目标不够明确，先 /cs intent ${intentText} 看路由，再按对应 /cs verify 目标补证据。`;
  }

  const args = styleCommandArgsForTarget(target);
  const evidenceCommand = `/cs evidence ${args}`;
  const verifyCommand = `/cs verify ${args}`;
  if (evidence.hasCurrentRealtimeData && !evidence.staleOnly && !(evidence.hasMiss && !evidence.hasFresh)) {
    return `证据命令: ${evidenceCommand}；${verifyCommand} 只读复核。目标: ${target.reason}`;
  }
  return `证据命令: ${verifyCommand}；管理员先 /cs warm plan ${args}，确认会 REFRESH 后再 /cs warm ${args}；最后 ${evidenceCommand}。目标: ${target.reason}`;
}

function formatStyleQualityPreflight(
  rawText: string,
  options: { hasRealtimeData?: boolean; forceVoice?: boolean; config?: AIConfig; apiReady?: boolean; evidenceText?: string } = {},
): string {
  const raw = (rawText || '').trim();
  if (!raw) return '/style check <要检查的回复文本>';
  const forceVoice = options.forceVoice === true;
  const evidence = analyzeStyleEvidence(options.evidenceText || '', options.hasRealtimeData === true);
  const hasRealtimeData = evidence.hasCurrentRealtimeData;
  const job = makeStyleCheckJob(raw, forceVoice);
  const csTopic = detectCsTopicQuery(raw);
  const realtimeIntent = csTopic.needsMatches || csTopic.needsRanking || csTopic.needsResults || /(?:最新|现在|当前|目前|今天|今日|刚查|HLTV|hltv|实时|排名|阵容|转会|比分|赛果)/.test(raw);
  const scene = buildStyleSceneDecision(job, '', realtimeIntent, hasRealtimeData);
  const rawQuality = assessReplyQuality(raw, job, hasRealtimeData);
  const postProcessed = postProcessReply(raw);
  const styleGuard = guardReplyFacts(postProcessed, hasRealtimeData, [], [], evidence.freshness, {
    realtimeStaleEvidence: evidence.hasStale,
  });
  const guarded = styleGuard.text;
  const finalQuality = assessReplyQuality(guarded, job, hasRealtimeData);
  const changed = guarded !== raw;
  const uncoveredFactKinds = hasRealtimeData
    ? uncoveredReplyFactKinds(postProcessed, [], evidence.freshness)
    : [];
  const factCoverageText = evidence.hasEvidenceText && hasRealtimeData
    ? (uncoveredFactKinds.length > 0
      ? `未覆盖 ${uncoveredFactKinds.map(localizeKnowledgeRiskKind).join(' / ')}`
      : '当前句子的事实类型已被 fresh 证据覆盖或未出现需覆盖事实')
    : '';
  const baseRiskLevel = stylePreflightRiskLevel(rawQuality, finalQuality, evidence);
  const riskLevel = styleGuard.reason && baseRiskLevel.startsWith('low')
    ? 'medium 发出前会修正事实边界'
    : baseRiskLevel;
  const fixActions = stylePreflightFixActions(rawQuality, finalQuality, evidence, changed);
  if (styleGuard.reason && fixActions.length < 5) fixActions.unshift('事实覆盖: 只说 fresh 明确覆盖的事实类型');
  const advice = stylePreflightAdvice(rawQuality, finalQuality, evidence, scene, forceVoice);
  if (styleGuard.reason && advice.length < 5) advice.unshift('证据 fresh 也要按类型使用，没覆盖的排名/阵容/赛果/选手数据别顺手补。');
  const evidenceAction = styleEvidenceAction(evidence);
  const evidenceCommands = formatStyleEvidenceCommands(raw, evidence);
  const voiceAnalysis = forceVoice && options.config
    ? buildVoicePreflightAnalysis(options.config, guarded, options.apiReady === true)
    : null;
  const voicePreview = voiceAnalysis
    ? (voiceAnalysis.parts.slice(0, 2).map((part, index) => `${index + 1}.${previewText(part, 48)}`).join(' | ') || '无可念文本')
    : '';
  const lines = [
    '风格/真实性预检',
    `场景: ${scene.scene}${scene.needsRealtime ? '/需实时' : ''}${scene.signals.length ? ` (${scene.signals.join('/')})` : ''}`,
    `模式: ${evidence.mode}${forceVoice ? ' / 语音长度' : ''}`,
    `风险等级: ${riskLevel}`,
    evidence.hasEvidenceText ? `证据新鲜度: ${evidence.freshness.join(' / ') || '未看到fresh/stale/miss缓存行'}` : '',
    evidence.hasEvidenceText && evidence.evidenceLines.length > 0 ? `证据线索: ${evidence.evidenceLines.join(' / ')}` : '',
    evidence.hasEvidenceText ? `证据边界: ${evidence.boundary}` : '',
    factCoverageText ? `事实类型覆盖: ${factCoverageText}` : '',
    evidenceAction ? `证据动作: ${evidenceAction}` : '',
    evidenceCommands,
    `原文风险: ${formatStyleIssueList(rawQuality.issues)}`,
    `发出前风险: ${formatStyleIssueList(finalQuality.issues)}`,
    styleGuard.reason ? `事实修正: ${styleGuard.reason}` : '',
    `修复动作: ${fixActions.join('；')}`,
    `行动建议: ${advice.join('；')}`,
    ...(voiceAnalysis ? [
      `语音TTS: ${options.config?.enable_tts ? 'on' : 'off'} ${voiceAnalysis.stats.provider}${voiceAnalysis.stats.localReady ? '/local-ready' : ''} send=${voiceAnalysis.stats.sendMode}`,
      `语音分段: ${voiceAnalysis.parts.length}/4 清洗${voiceAnalysis.cleaned.length}字/单段${voiceAnalysis.maxChars}字${voiceAnalysis.likelyTruncated ? ' 可能截断' : ''}`,
      `语音风险: ${voiceAnalysis.risks.length ? voiceAnalysis.risks.join(' / ') : '无明显风险'}`,
      `语音预览: ${voicePreview}`,
    ] : []),
    changed ? `修复预览: ${guarded.slice(0, 180)}` : `文本预览: ${guarded.slice(0, 180)}`,
    rawQuality.ok && finalQuality.ok
      ? '判断: 这句基本能发。'
      : finalQuality.ok
        ? '判断: 原句有问题，但当前后处理能救回来。'
        : '判断: 这句还容易像模板/假来源，建议重写短一点。',
    '边界: 风格拟态不是本人原话；只有 fresh/当前证据能支撑当前事实，stale/miss 都要收住。',
    '参数: 加 --realtime 表示你确实有实时证据；加 --voice 按语音长度检查；也可用“待发文本 || 证据/缓存行”预检真实证据，并给出 /cs verify / /cs warm 下一步命令。',
  ].filter(Boolean);
  return lines.join('\n');
}

function formatStyleQualityStatus(): string {
  const stats = getAiChatStats();
  return [
    '风格质量状态',
    `场景: ${stats.styleSceneTraceCount}条 最近${stats.lastStyleScene || '无'}${stats.lastStyleSceneAction ? ` / ${stats.lastStyleSceneAction.slice(0, 52)}` : ''}`,
    `Top: ${stats.styleSceneTop.join(' / ') || '无'}`,
    `质量风险: ${stats.qualityIssueTraceCount}${stats.lastQualityIssues.length ? ` 最近=${stats.lastQualityIssues.join('/')}` : ' 最近=无'}`,
    `事实边界: ${stats.lastFactGuard || '无'}`,
    `开头去重: ${stats.lastOpenerDeduped ? '最近触发过' : '最近未触发'}`,
    `真人停顿: ${stats.humanReplyDelayCount}次 avg=${stats.humanReplyDelayAvgMs}ms 最近=${stats.lastHumanReplyDelayMs}ms`,
    '/style check <文本> || <证据/缓存行> 可预检模板味、原话误称、假来源、实时断言、语音分段风险和 /cs verify / warm 补证命令',
  ].join('\n');
}

function parseStyleCheckArgs(args: string[]): { text: string; evidenceText: string; hasRealtimeData: boolean; forceVoice: boolean } {
  const joined = args.slice(1).join(' ').trim();
  const hasRealtimeData = /(?:^|\s)--(?:realtime|fresh)(?=\s|$)/i.test(joined);
  const forceVoice = /(?:^|\s)--(?:voice|语音)(?=\s|$)/i.test(joined);
  const withoutFlags = joined
    .replace(/(?:^|\s)--(?:realtime|fresh|voice|语音)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [textPart, ...evidenceParts] = withoutFlags.split(/\s*\|\|\s*/);
  return {
    text: (textPart || '').trim(),
    evidenceText: evidenceParts.join(' || ').trim(),
    hasRealtimeData,
    forceVoice,
  };
}

function buildReplyQualityRepairMessages(
  messages: ChatMessage[],
  badReply: string,
  quality: ReplyQualityCheck,
  job: ReplyJob,
  hasRealtimeData: boolean,
): ChatMessage[] {
  const instructions = [
    '这条回复发出前自检没过，重写一版。',
    `问题: ${quality.issues.join(' / ')}`,
    '要求：像QQ群里真人顺手接一句，短一点，别列提纲，别解释你在模仿谁。',
    '禁止说“根据知识库/临场笔记/实时事实参考/作为AI/模板/拟态”。',
    '不要声称任何拟态句是玩机器本人原话、真实语录、经典语录或逐字复刻；只能说成场景口吻。',
    '没有实时资料时，禁止说“我刚查了/HLTV显示/实时数据说/资料显示”，不能假装刚联网。',
    '没有可靠来源时，也禁止用“听说/朋友说/群里都说/爆料说”给传闻背书。',
    '不要把“缓存/source/ttl/age/fetch/fresh/stale”这类证据元数据发给群友，只把它转成一句自然的不确定边界。',
    hasRealtimeData
      ? '如果用到了实时资料，只能说资料里明确出现的事实。'
      : '没有实时资料支撑时，别报最新排名/比分/阵容/转会；需要就说“这点我得查最新的”。',
    job.forceVoice ? '这条要适合念出来，控制在一两句。' : '',
    '只输出重写后的QQ消息，不要加标题。',
  ].filter(Boolean);
  return [
    ...messages,
    { role: 'assistant', content: badReply },
    { role: 'user', content: instructions.join('\n') },
  ];
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

function isAdmin(ctx: PluginContext): boolean {
  return ctx.bot.getConfig().admin_qq.includes(ctx.event.user_id);
}

function formatKnowledgeResults(results: ReturnType<typeof searchKnowledge>, maxChars: number = 1200): string {
  if (results.length === 0) return '没检索到，关键词换一下，别硬搜。';
  return results
    .map((item, index) => `${index + 1}. ${item.title} (${item.score})\n${item.excerpt}`)
    .join('\n\n')
    .slice(0, maxChars);
}

function formatQuoteKnowledgePreflight(query: string): string {
  const inspected = inspectQuoteKnowledge(query);
  return [
    '语录/口癖预检',
    `关键词: ${inspected.query || '[空]'}`,
    `短句池: 命中${inspected.matchedLines}/${inspected.totalLines} 分区${inspected.sectionCount}${inspected.fallbackUsed ? ' fallback=全量池' : ''}`,
    `分区: ${inspected.sections.join(' / ') || '无'}`,
    inspected.sampleLines.length > 0
      ? `样例: ${inspected.sampleLines.join(' / ')}`
      : '样例: 无',
    `边界: ${inspected.boundary}`,
    `行动建议: ${inspected.advice.join('；')}`,
    '说明: 这里只读检查短句池，不调用模型、不联网、不写库；/quote 实际发送也只能当口吻锚点。',
  ].join('\n');
}

function isOriginalQuoteRequest(text: string): boolean {
  return /(?:原话|逐字|一字不差|本人说过|本人讲过|经典语录|名场面台词|直播原文|切片原文|完整字幕|完整台词|复刻|还原)/i.test(text);
}

function formatQuoteReply(query: string, line: string): string {
  const boundary = '边界: 这是口癖/短句锚点，只能当场景口吻参考，不是玩机器本人逐字原话。';
  if (!line) {
    return [
      '这关键词没逮到口癖锚点，换个词。',
      isOriginalQuoteRequest(query) ? boundary : '提示: 可以 /quote check <关键词> 先看短句池命中。',
    ].join('\n');
  }
  if (isOriginalQuoteRequest(query)) {
    return [
      `口癖锚点: ${line}`,
      boundary,
      '想扩素材先放 knowledge/inbox/，跑 /kb inbox 体检，别把长字幕当原话灌库。',
    ].join('\n');
  }
  return line;
}

interface KnowledgeRoutePreview {
  query: string;
  styleQuery: string;
  topicQuery: string;
  hasKnowledgeTopic: boolean;
  budget: number;
  styleBudget: number;
  topicBudget: number;
  styleKnowledge: string;
  topicKnowledge: string;
  knowledgeInfo: string;
  titles: string[];
  lanes: KnowledgeRouteLane[];
  signature: string;
  freshnessIssues: KnowledgeFreshnessIssue[];
  freshnessBoundary: string;
}

type KnowledgeRouteLaneKey = 'cs_fact' | 'gift' | 'quote' | 'scene' | 'person_team' | 'voice' | 'ops' | 'general';

interface KnowledgeRouteLane {
  key: KnowledgeRouteLaneKey;
  label: string;
  query: string;
  budget: number;
  chars: number;
  titles: string[];
  hit: boolean;
}

const knowledgeRouteLaneSpecs: Record<KnowledgeRouteLaneKey, { label: string; trigger: RegExp; query: string }> = {
  cs_fact: {
    label: 'CS/事实',
    trigger: /(?:cs2|csgo|hltv|liquipedia|vrs|major|blast|iem|esl|比分|赛程|赛果|排名|阵容|转会|地图池|veto|rating|adr|kast|navi|g2|vitality|spirit|faze|mouz|falcons|astralis|liquid|mongolz|tyloo|lynn|donk|niko|zywoo|m0nesy|s1mple|ropz|sh1ro|device|aleksib|b1t)/i,
    query: 'CS2 比赛 选手 队伍 地图池 实时事实 来源边界 HLTV Liquipedia 排名 阵容 比分',
  },
  gift: {
    label: '礼物',
    trigger: /(?:礼物|送礼|谢礼|谢谢|感谢|老板|飞机|火箭|礼花|gift|老板大气)/i,
    query: '礼物感谢 拟态模板 老板大气 经济 道具 火力支援 不冒充真实礼物原话',
  },
  quote: {
    label: '语录/口癖',
    trigger: /(?:语录|口癖|短句|原话|名言|经典|玩机器.*(?:说|讲)|这句话|逐字|quote)/i,
    query: '短句锚点 口癖 经典短句 原话边界 不逐字冒充',
  },
  scene: {
    label: '场景/切片',
    trigger: /(?:场景|切片|直播|白给|保枪|开香槟|残局|道具|优势被翻|弹幕|嘴硬|模板|风格|像人|真人|公式)/i,
    query: '直播场景模板 切片长句摘要 反应结构 真人化 非公式化 弹幕接话',
  },
  person_team: {
    label: '人物/队伍',
    trigger: /(?:选手|队伍|职业哥|主播|玩机器|machine|6657|niko|donk|zywoo|m0nesy|s1mple|ropz|sh1ro|device|karrigan|aleksib|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|heroic|furia)/i,
    query: '选手风格倾向 队伍风格倾向 人物背景 当前阵容状态以实时数据为准',
  },
  voice: {
    label: '语音',
    trigger: /(?:语音|念出来|读出来|tts|stt|声音|克隆|授权样本|voice|听写)/i,
    query: '语音 TTS STT 授权样本 声音克隆 语音缓存 真实语音边界',
  },
  ops: {
    label: '运维/命令',
    trigger: /(?:命令|配置|缓存|知识库|kb|trace|status|diag|vps|部署|更新|bot|机器人|qqbot|napcat|内存|队列)/i,
    query: '命令回复素材 配置 缓存 知识库 运维 诊断 trace status VPS 边界',
  },
  general: {
    label: '泛话题',
    trigger: /[\s\S]/,
    query: '玩机器 直播间 CS2 背景 话题素材 回复边界',
  },
};

function detectKnowledgeRouteLaneKeys(text: string): KnowledgeRouteLaneKey[] {
  const haystack = text || '';
  const ordered: KnowledgeRouteLaneKey[] = ['cs_fact', 'gift', 'quote', 'scene', 'person_team', 'voice', 'ops'];
  const keys = ordered.filter((key) => knowledgeRouteLaneSpecs[key].trigger.test(haystack));
  if (keys.length === 0) keys.push('general');
  if (keys.length > 4) return keys.slice(0, 4);
  return keys;
}

function splitKnowledgeBlocks(markdown: string): Array<{ title: string; block: string }> {
  const text = (markdown || '').trim();
  if (!text) return [];
  const matches = [...text.matchAll(/^【(.+?)】\s*$/gm)];
  if (matches.length === 0) return [{ title: '', block: text }];
  const blocks: Array<{ title: string; block: string }> = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index || 0;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end).trim();
    const title = (match[1] || '').trim();
    if (block) blocks.push({ title, block });
  }
  return blocks;
}

function selectTopicKnowledgeByLanes(topicQuery: string, topicBudget: number, hasKnowledgeTopic: boolean): { topicKnowledge: string; lanes: KnowledgeRouteLane[] } {
  if (!hasKnowledgeTopic) return { topicKnowledge: '', lanes: [] };
  const keys = detectKnowledgeRouteLaneKeys(topicQuery);
  const perLaneBudget = Math.max(360, Math.floor(topicBudget / Math.max(1, keys.length)));
  const lanes: KnowledgeRouteLane[] = [];
  const blocks: Array<{ title: string; block: string }> = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const spec = knowledgeRouteLaneSpecs[key];
    const laneQuery = [topicQuery, spec.query].join('\n');
    const selected = selectKnowledge(laneQuery, perLaneBudget);
    const laneTitles = extractKnowledgeTitles(selected, 4);
    lanes.push({
      key,
      label: spec.label,
      query: spec.query,
      budget: perLaneBudget,
      chars: selected.length,
      titles: laneTitles,
      hit: selected.length > 0,
    });
    for (const block of splitKnowledgeBlocks(selected)) {
      const blockKey = `${block.title || 'untitled'}:${normalizeCacheText(block.block).slice(0, 120)}`;
      if (seen.has(blockKey)) continue;
      seen.add(blockKey);
      blocks.push(block);
    }
  }

  const selectedBlocks: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.block.length > topicBudget && selectedBlocks.length > 0) continue;
    selectedBlocks.push(block.block);
    used += block.block.length;
    if (used >= topicBudget) break;
  }
  return {
    topicKnowledge: selectedBlocks.join('\n\n').slice(0, topicBudget),
    lanes,
  };
}

function formatKnowledgeLaneSummary(lanes: KnowledgeRouteLane[]): string[] {
  return lanes
    .filter((lane) => lane.hit || lane.key !== 'general')
    .map((lane) => `${lane.label}:${lane.hit ? `${lane.chars}字` : 'miss'}${lane.titles.length ? `(${lane.titles.slice(0, 2).join('/')})` : ''}`)
    .slice(0, 6);
}

const KNOWLEDGE_FRESHNESS_QUERY_PATTERN = /(?:最新|当前|现在|目前|今天|今日|最近|近期|实时|刚刚|刚查到|排名|排行|榜单|阵容|转会|比分|赛果|赛程|赛况|版本|地图池|hltv|vrs|matchid|rating|adr|kast)/i;

function compactKnowledgeFreshnessIssue(issue: KnowledgeFreshnessIssue): string {
  const missing = issue.missing.length ? ` 缺${issue.missing.join('/')}` : '';
  return `${issue.level}:${issue.title}${missing}`;
}

function formatKnowledgeFreshnessIssueList(issues: KnowledgeFreshnessIssue[], limit = 3): string {
  return issues.slice(0, limit).map(compactKnowledgeFreshnessIssue).join('；');
}

function buildKnowledgeFreshnessRuntimeBoundary(
  issues: KnowledgeFreshnessIssue[],
  queryText: string,
  hasKnowledgeTopic: boolean,
): string {
  if (issues.length === 0) return '';
  const realtimeLike = KNOWLEDGE_FRESHNESS_QUERY_PATTERN.test(queryText);
  return [
    `命中疑似旧事实分区: ${formatKnowledgeFreshnessIssueList(issues, 4)}`,
    realtimeLike || hasKnowledgeTopic
      ? '这些块只能当历史线索/背景摘要；回答当前排名、阵容、转会、比分、赛程、版本、地图池时必须以 fresh 实时参考为准，没有 fresh 证据就说得查最新。'
      : '如果用户追问当前事实，只能把这些块当旧线索，不能包装成现在仍然成立。',
  ].join('\n');
}

function formatKnowledgeFreshnessTraceItems(issues: KnowledgeFreshnessIssue[], limit = 4): string[] {
  return issues.slice(0, limit).map(compactKnowledgeFreshnessIssue);
}

type KnowledgeFreshnessRiskKind = 'ranking' | 'roster' | 'match' | 'version' | 'player';

interface FactGuardResult {
  text: string;
  reason: string;
}

interface EvidenceLedgerGuardContext {
  realtimeStaleEvidence?: boolean;
  memoryFiltered?: number;
}

function knowledgeFreshnessRiskKinds(issues: KnowledgeFreshnessIssue[]): KnowledgeFreshnessRiskKind[] {
  const kinds: KnowledgeFreshnessRiskKind[] = [];
  const add = (kind: KnowledgeFreshnessRiskKind) => {
    if (!kinds.includes(kind)) kinds.push(kind);
  };
  for (const issue of issues) {
    const text = `${issue.title}\n${issue.triggers.join(' ')}\n${issue.excerpt}\n${issue.advice}`;
    if (/排名|排行|榜单|top\s*\d|VRS|HLTV/i.test(text)) add('ranking');
    if (/阵容|转会|加入|离队|替补|租借|官宣|签约|bench|roster|transfer|队伍|选手/i.test(text)) add('roster');
    if (/比分|赛果|赛程|赛况|正在打|刚结束|胜者|地图比分|BO[135]|matchid|比赛/i.test(text)) add('match');
    if (/选手数据|个人数据|rating|ADR|KAST|K\/?D|stats?|状态|表现|发挥|击杀|KD/i.test(text)) add('player');
    if (/版本|更新|改动|active duty|地图池|服役地图|移除|加入地图/i.test(text)) add('version');
  }
  return kinds;
}

function freshRealtimeCoversKnowledgeKind(kind: KnowledgeFreshnessRiskKind, hltvLabels: string[], realtimeFreshness: string[]): boolean {
  const labelText = hltvLabels.join(' ');
  const freshnessText = realtimeFreshness.join(' ');
  if (!/\bfresh\b/i.test(freshnessText)) return false;
  if (kind === 'ranking') return /排名|ranking/i.test(labelText) || /(?:^|\s)ranking\s+fresh/i.test(freshnessText);
  if (kind === 'match') return /单场|赛程|赛果|近期比赛|正在比赛|比赛/i.test(labelText) || /(?:^|\s)(?:match:\d+|matches|results)\s+fresh/i.test(freshnessText);
  if (kind === 'roster') return /队伍|阵容|team/i.test(labelText) || /(?:^|\s)team:[^\s]+\s+fresh/i.test(freshnessText);
  if (kind === 'player') return /选手|player|stats?|状态|表现|单场/i.test(labelText) || /(?:^|\s)(?:player:[^\s]+|match:\d+)\s+fresh/i.test(freshnessText);
  if (kind === 'version') return /版本|地图池|active duty/i.test(labelText) || /(?:map|version|pool)[^\s]*\s+fresh/i.test(freshnessText);
  return false;
}

function replyMatchesKnowledgeRiskKind(text: string, kind: KnowledgeFreshnessRiskKind): boolean {
  if (!text) return false;
  if (kind === 'ranking') {
    return /(?:现在|目前|当前|今天|最新|最近)?[^。！？!?]{0,24}(?:排名|排行|榜单|第[一二三四五六七八九十\d]+|top\s*\d|第一|VRS|HLTV)/i.test(text);
  }
  if (kind === 'roster') {
    return /(?:现在|目前|当前|最新|最近)?[^。！？!?]{0,24}(?:阵容|转会|加入|离队|替补|首发|签约|bench|benched|roster|transfer|在.{0,8}队)/i.test(text);
  }
  if (kind === 'match') {
    return /(?:现在|目前|今天|今日|最新|最近|刚刚|刚结束)?[^。！？!?]{0,24}(?:比分|赛果|赛程|赛况|战胜|淘汰|赢了|输了|\d{1,2}\s*[:：-]\s*\d{1,2}|matchid|BO[135])/i.test(text);
  }
  if (kind === 'player') {
    return /(?:现在|目前|当前|今天|最新|最近|这场|近期)?[^。！？!?]{0,30}(?:rating|ADR|KAST|K\/?D|KD|stats?|数据|状态|表现|发挥|击杀|谁C|谁c|谁最C|谁最c|最C|最c)/i.test(text);
  }
  if (kind === 'version') {
    return /(?:现在|目前|当前|最新|最近)?[^。！？!?]{0,24}(?:版本|地图池|active duty|服役地图|移除|加入地图|更新|改动)/i.test(text);
  }
  return false;
}

function localizeKnowledgeRiskKind(kind: KnowledgeFreshnessRiskKind): string {
  if (kind === 'ranking') return '当前排名';
  if (kind === 'roster') return '当前阵容/转会';
  if (kind === 'match') return '当前比分/赛果/赛程';
  if (kind === 'player') return '当前选手数据/状态';
  if (kind === 'version') return '当前版本/地图池';
  return '当前事实';
}

function softenKnowledgeFreshnessRiskClaims(
  text: string,
  issues: KnowledgeFreshnessIssue[],
  hasCurrentRealtimeData: boolean,
  hltvLabels: string[],
  realtimeFreshness: string[],
): FactGuardResult {
  if (!text || issues.length === 0) return { text, reason: '' };
  const alreadyConservative = /(?:我得查|得查最新|印象里|不一定对|不太确定|具体我得|你查最新|以最新为准|按最新为准|不能保证|别让我硬编|没实时来源|没查到准信|旧线索|旧快照|不能当实时)/.test(text);
  if (alreadyConservative) return { text, reason: '' };

  const kinds = knowledgeFreshnessRiskKinds(issues);
  const uncovered = kinds.filter((kind) => !freshRealtimeCoversKnowledgeKind(kind, hltvLabels, realtimeFreshness));
  const risky = (uncovered.length > 0 ? uncovered : (!hasCurrentRealtimeData ? kinds : []))
    .filter((kind) => replyMatchesKnowledgeRiskKind(text, kind));
  if (risky.length === 0) return { text, reason: '' };

  const label = risky.map(localizeKnowledgeRiskKind).join('/');
  return {
    text: `这块${label}我得看对应的 fresh 来源，不能拿本地旧资料报死；你以最新为准`,
    reason: `knowledge freshness risk softened: ${risky.join('/')}`,
  };
}

function hasRealtimeMissEvidence(realtimeFreshness: string[]): boolean {
  return realtimeFreshness.some((line) => /\bmiss\b|无快照|没有成功快照|还没有成功快照/i.test(line));
}

function hasRealtimeFreshEvidence(realtimeFreshness: string[]): boolean {
  return realtimeFreshness.some((line) => /\bfresh\b/i.test(line));
}

function hasRealtimeStaleEvidence(realtimeFreshness: string[], explicitStale?: boolean): boolean {
  return explicitStale === true
    || realtimeFreshness.some((line) => /\bstale\b|过期|旧缓存|不能当实时结论/i.test(line));
}

function hasMixedCurrentEvidence(
  hasCurrentRealtimeData: boolean,
  realtimeFreshness: string[],
  guardContext?: EvidenceLedgerGuardContext,
): boolean {
  if (!hasCurrentRealtimeData) return false;
  const hasFresh = hasRealtimeFreshEvidence(realtimeFreshness);
  if (!hasFresh && realtimeFreshness.length > 0) return false;
  return hasRealtimeStaleEvidence(realtimeFreshness, guardContext?.realtimeStaleEvidence)
    || hasRealtimeMissEvidence(realtimeFreshness)
    || (guardContext?.memoryFiltered || 0) > 0;
}

function replyCurrentFactKinds(text: string): KnowledgeFreshnessRiskKind[] {
  const kinds: KnowledgeFreshnessRiskKind[] = [];
  const allKinds: KnowledgeFreshnessRiskKind[] = ['ranking', 'roster', 'match', 'player', 'version'];
  for (const kind of allKinds) {
    if (replyMatchesKnowledgeRiskKind(text, kind)) kinds.push(kind);
  }
  return kinds;
}

function uncoveredReplyFactKinds(
  text: string,
  hltvLabels: string[],
  realtimeFreshness: string[],
): KnowledgeFreshnessRiskKind[] {
  return replyCurrentFactKinds(text)
    .filter((kind) => !freshRealtimeCoversKnowledgeKind(kind, hltvLabels, realtimeFreshness));
}

function softenMixedEvidenceOverclaims(
  text: string,
  hasCurrentRealtimeData: boolean,
  hltvLabels: string[],
  realtimeFreshness: string[],
  guardContext?: EvidenceLedgerGuardContext,
): FactGuardResult {
  if (!text || !hasCurrentRealtimeData) return { text, reason: '' };
  const alreadyBounded = /(?:只按|只能按|没覆盖|未覆盖|不能报死|不能拍死|不能当实时结论|旧线索|旧快照|缺口|以最新为准|得查最新|不确定|不敢说|没准信|没可靠来源)/.test(text);
  if (alreadyBounded) return { text, reason: '' };
  const uncoveredKinds = uncoveredReplyFactKinds(text, hltvLabels, realtimeFreshness);
  if (uncoveredKinds.length > 0) {
    const labels = uncoveredKinds.map(localizeKnowledgeRiskKind).join('/');
    return {
      text: `证据账本显示这条 fresh 证据没覆盖${labels}；我只能按资料覆盖到的部分说，没覆盖的别报死。`,
      reason: `evidence ledger uncovered fact kind softened: ${uncoveredKinds.join('/')}`,
    };
  }
  if (!hasMixedCurrentEvidence(hasCurrentRealtimeData, realtimeFreshness, guardContext)) {
    return { text, reason: '' };
  }
  const hasOverclaim =
    /我(?:刚刚?|刚才|才|已经)?(?:查|搜|看|翻)(?:了|到)?(?:一下|一眼|了下|下)?.{0,24}(?:HLTV|hltv|实时|最新|数据|资料|榜单|排名)/i.test(text)
    || /(?:HLTV|hltv|实时(?:数据|资料|榜单)?|最新(?:数据|资料|排名|消息)?|资料|数据|榜单)(?:显示|说|写着|给到|查到|来看|上看)/i.test(text)
    || /(?:全部|全都|都|完整|所有)(?:[^。！？!?]{0,12})(?:最新|实时|当前|fresh|没问题|能报死|可以报死|直接报死|拍死|下结论)/i.test(text)
    || /(?:可以|能|直接|放心)(?:[^。！？!?]{0,8})(?:报死|拍死|下结论)/i.test(text);
  if (!hasOverclaim) return { text, reason: '' };
  const stale = hasRealtimeStaleEvidence(realtimeFreshness, guardContext?.realtimeStaleEvidence);
  const miss = hasRealtimeMissEvidence(realtimeFreshness);
  const filtered = guardContext?.memoryFiltered || 0;
  const risks = [
    stale ? '旧快照' : '',
    miss ? '缺口' : '',
    filtered > 0 ? `过滤旧记忆${filtered}条` : '',
  ].filter(Boolean).join('、') || '混合证据';
  return {
    text: `这条有 fresh 证据，但证据账本里还有${risks}；我只能按资料覆盖到的部分说，没覆盖的别报死。`,
    reason: 'evidence ledger mixed-current overclaim softened',
  };
}

function guardReplyFacts(
  text: string,
  hasCurrentRealtimeData: boolean,
  knowledgeFreshnessIssues: KnowledgeFreshnessIssue[],
  hltvLabels: string[],
  realtimeFreshness: string[],
  guardContext?: EvidenceLedgerGuardContext,
): FactGuardResult {
  const beforeGeneralGuard = text;
  const beforeRumorGuard = hasUnsupportedRumorClaim(beforeGeneralGuard, hasCurrentRealtimeData);
  let next = softenUnverifiedClaims(beforeGeneralGuard, hasCurrentRealtimeData);
  if (next !== beforeGeneralGuard) {
    return {
      text: next,
      reason: beforeRumorGuard
        ? 'unsupported rumor claim softened'
        : hasCurrentRealtimeData ? 'realtime-backed reply kept conservative' : 'unverified realtime claim softened',
    };
  }
  const freshnessGuard = softenKnowledgeFreshnessRiskClaims(
    next,
    knowledgeFreshnessIssues,
    hasCurrentRealtimeData,
    hltvLabels,
    realtimeFreshness,
  );
  if (freshnessGuard.reason) return freshnessGuard;
  return softenMixedEvidenceOverclaims(next, hasCurrentRealtimeData, hltvLabels, realtimeFreshness, guardContext);
}

function buildKnowledgeRoutePreview(
  config: AIConfig,
  text: string,
  options: { triggerReason?: string; hasImages?: boolean; hasRecords?: boolean; searchInfo?: string; recordTranscriptText?: string } = {},
): KnowledgeRoutePreview {
  const rawQueryText = text || '';
  const queryText = normalizeCacheText(rawQueryText) || rawQueryText.trim();
  const recordTranscriptText = options.recordTranscriptText || '';
  const searchInfo = options.searchInfo || '';
  const searchableText = queryText || recordTranscriptText || '';
  const topicQuery = [
    queryText,
    recordTranscriptText,
    searchInfo,
    ...getKnowledgeKeywords().filter((keyword) => searchableText.toLowerCase().includes(keyword.toLowerCase())),
  ].join('\n');
  const styleQuery = [
    '直播语态 回复铁律 真人化 非公式化 口癖调度 反应强度 上下文定位',
    options.triggerReason || '',
    options.hasImages ? '识图 图片 场景' : '',
    options.hasRecords ? '语音 听写 场景' : '',
    queryText,
  ].filter(Boolean).join('\n');
  const hasKnowledgeTopic = isKnowledgeTopic(topicQuery);
  const budget = config.knowledge_max_chars || 1800;
  const styleBudget = Math.max(600, Math.floor(budget * (hasKnowledgeTopic ? 0.35 : 0.75)));
  const topicBudget = Math.max(600, budget - styleBudget);
  const styleKnowledge = config.knowledge_force_style === false
    ? selectKnowledge(styleQuery, styleBudget)
    : (selectKnowledge(styleQuery, styleBudget) || selectStyleKnowledge(styleBudget));
  const topicSelection = selectTopicKnowledgeByLanes(topicQuery, topicBudget, hasKnowledgeTopic);
  const topicKnowledge = topicSelection.topicKnowledge;
  const job = makeStyleCheckJob(queryText || '知识路由预检');
  job.triggerReason = options.triggerReason || 'kb-route';
  job.hasImages = options.hasImages === true;
  job.hasRecords = options.hasRecords === true;
  job.imageInputCount = job.hasImages ? 1 : 0;
  job.recordUrls = job.hasRecords ? ['record'] : [];
  const titles = [
    ...extractKnowledgeTitles(styleKnowledge, 4),
    ...extractKnowledgeTitles(topicKnowledge, 4),
  ].filter((title, index, all) => all.indexOf(title) === index).slice(0, 6);
  const freshnessIssues = findKnowledgeFreshnessIssuesForTitles(titles, 6);
  const freshnessBoundary = buildKnowledgeFreshnessRuntimeBoundary(freshnessIssues, queryText || topicQuery, hasKnowledgeTopic);
  const knowledgeInfo = buildRuntimeKnowledgeInfo(styleKnowledge, topicKnowledge, job, hasKnowledgeTopic, budget, freshnessBoundary);
  const signature = makeStableKnowledgeSignature(styleKnowledge, topicKnowledge, titles);
  return {
    query: queryText,
    styleQuery,
    topicQuery,
    hasKnowledgeTopic,
    budget,
    styleBudget,
    topicBudget,
    styleKnowledge,
    topicKnowledge,
    knowledgeInfo,
    titles,
    lanes: topicSelection.lanes,
    signature,
    freshnessIssues,
    freshnessBoundary,
  };
}

function buildKnowledgeRouteDiagnostics(config: AIConfig, route: KnowledgeRoutePreview): { diagnostics: string[]; advice: string[] } {
  const diagnostics: string[] = [];
  const advice: string[] = [];
  const topicKeyword = route.query.split(/\s+/).find((item) => item.length >= 2) || route.query.slice(0, 24);

  if (config.enable_knowledge === false) {
    diagnostics.push('知识库已关闭，实际AI回复不会注入这些内容');
    advice.push('打开 enable_knowledge 后再看真实注入效果');
  }
  if (config.knowledge_force_style === false) {
    diagnostics.push('强制风格包关闭，普通闲聊可能更依赖模型本身');
    advice.push('想稳定玩机器语态就打开 knowledge_force_style');
  }
  if (!route.styleKnowledge) {
    diagnostics.push('风格包未命中，真人感/口癖/边界素材可能吃不到');
    advice.push('/kb stats 看主库是否加载，或把风格素材放 knowledge/inbox 后 /kb ingest');
  } else {
    diagnostics.push(`风格包命中 ${extractKnowledgeTitles(route.styleKnowledge, 2).join('/') || '未命名分区'}`);
  }
  if (route.hasKnowledgeTopic && !route.topicKnowledge) {
    diagnostics.push('检测到话题意图，但话题包未命中');
    advice.push(topicKeyword ? `/kb preview ${topicKeyword} 生成候选，或 /kb import-url <可信来源>` : '/kb preview <关键词> 生成候选');
  } else if (route.hasKnowledgeTopic) {
    const hitLanes = formatKnowledgeLaneSummary(route.lanes);
    diagnostics.push(hitLanes.length > 0
      ? `多路话题命中 ${hitLanes.join('；')}`
      : `话题包命中 ${extractKnowledgeTitles(route.topicKnowledge, 2).join('/') || '未命名分区'}`);
  } else {
    diagnostics.push('未检测到强话题意图，只走风格/场景底座');
    advice.push('如果这是选手/队伍/礼物/语录话题，补更明确关键词再 /kb route');
  }
  if (route.freshnessIssues.length > 0) {
    diagnostics.push(`时效风险 ${formatKnowledgeFreshnessIssueList(route.freshnessIssues, 2)}`);
    advice.push('先 /kb stale 或 /cs verify 核当前事实；修库前这些分区只能当旧线索');
  }
  const missedLanes = route.lanes.filter((lane) => !lane.hit && lane.key !== 'general').map((lane) => lane.label);
  if (missedLanes.length > 0) {
    diagnostics.push(`未命中路: ${missedLanes.join('/')}`);
    advice.push(`/kb preview ${missedLanes[0]} 相关关键词，或把素材放 knowledge/inbox 后 /kb ingest`);
  }
  if (route.knowledgeInfo.length >= Math.floor(route.budget * 0.95)) {
    diagnostics.push('注入接近预算上限，后续分区可能被截断');
    advice.push('小机器可降低 knowledge_max_chars，或把长素材摘要化');
  }
  if (route.titles.length === 0) {
    diagnostics.push('没有提取到知识分区标题');
    advice.push('/kb audit 看主库格式，分区建议使用 Markdown 标题');
  }
  if (advice.length === 0) {
    advice.push('可以发一条强触发后用 /trace last 核对实际知识分区');
  }

  return {
    diagnostics: [...new Set(diagnostics)].slice(0, 5),
    advice: [...new Set(advice)].slice(0, 4),
  };
}

function formatKnowledgeRoutePreview(config: AIConfig, text: string): string {
  const clean = (text || '').trim();
  if (!clean) return '/kb route <要预检的消息>';
  const route = buildKnowledgeRoutePreview(config, clean, { triggerReason: 'kb-route' });
  const diagnostic = buildKnowledgeRouteDiagnostics(config, route);
  return [
    '知识路由预检',
    `输入: ${clean.slice(0, 80)}`,
    `预算: total ${route.budget} / style ${route.styleBudget} / topic ${route.topicBudget}`,
    `话题命中: ${route.hasKnowledgeTopic ? 'yes' : 'no'}`,
    `风格包: ${route.styleKnowledge ? `${route.styleKnowledge.length}字` : '无'}`,
    `话题包: ${route.topicKnowledge ? `${route.topicKnowledge.length}字` : '无'}`,
    `多路召回: ${formatKnowledgeLaneSummary(route.lanes).join(' / ') || (route.hasKnowledgeTopic ? '无命中' : '未触发')}`,
    `注入总量: ${route.knowledgeInfo.length}字`,
    `分区: ${route.titles.join(' / ') || '无'}`,
    `时效风险: ${route.freshnessIssues.length ? formatKnowledgeFreshnessIssueList(route.freshnessIssues, 4) : '无'}`,
    `签名: ${route.signature || '-'}`,
    `命中诊断: ${diagnostic.diagnostics.join('；')}`,
    `行动建议: ${diagnostic.advice.join('；')}`,
    '边界: 这里只预检知识召回，不调用模型；公开事实仍要看来源和实时证据。',
  ].join('\n');
}

interface ReplyCachePreflightItem {
  input: string;
  normalized: string;
  scene: StyleSceneDecision;
  policy: ReplyCachePolicy;
  key: string;
  keyState: string;
  searchWouldRun: boolean;
  stableTactical: boolean;
  timeSensitive: boolean;
  knowledgeTitles: string[];
  knowledgeSignature: string;
  advice: string[];
}

function buildReplyCachePreflightItem(config: AIConfig, input: string): ReplyCachePreflightItem {
  const clean = (input || '').trim();
  const normalized = normalizeCacheText(clean);
  const job = makeStyleCheckJob(clean || '缓存预检');
  job.sessionId = 'cache_check';
  job.senderName = 'cache-check';
  job.command = null;
  job.triggerReason = 'cache-check';
  job.forced = false;
  const csTopic = detectCsTopicQuery(clean);
  const realtimeIntent = csTopic.needsMatches || csTopic.needsRanking || csTopic.needsResults;
  const searchWouldRun = shouldSearch(config, clean);
  const stableTactical = isStableCsTacticalQuery(clean);
  const styleScene = buildStyleSceneDecision(job, '', realtimeIntent, false);
  const timeSensitive = /(?:今天|今日|现在|当前|此刻|此时|目前|今晚|今早|今夜|刚才|几号|几点|几月|星期|周[一二三四五六日天])/.test(clean);
  const knowledgeRoute = config.enable_knowledge !== false
    ? buildKnowledgeRoutePreview(config, clean, { triggerReason: 'cache-check' })
    : null;
  const policy = buildReplyCachePolicy(config, job, styleScene, searchWouldRun ? '[dry-run-search]' : '', timeSensitive, false);
  const key = policy.enabled
    ? makeReplyCacheKey(config, clean, knowledgeRoute?.signature || '', policy.scope)
    : '';
  const cached = key ? replyCache.get(key) : undefined;
  const ttlMs = cached ? cached.expiresAt - Date.now() : 0;
  const keyState = !key
    ? 'bypass'
    : replyInFlight.has(key)
      ? 'in-flight'
      : cached && ttlMs > 0
        ? `hit ttl${Math.ceil(ttlMs / 1000)}s`
        : cached
          ? 'expired'
          : 'miss';
  const advice: string[] = [];
  if (policy.enabled) {
    advice.push(`这类普通主动接话可复用 ${policy.ttlSeconds}s；实际 @/回复/私聊/命令仍会按 forced 旁路`);
  } else if (policy.reason === 'realtime') {
    advice.push(searchWouldRun
      ? '这条预计会走联网/实时增强，所以不缓存；事实类问题这是正确行为'
      : '风格场景需要实时边界，不能复用旧回答');
  } else if (policy.reason === 'time-sensitive') {
    advice.push('包含时间敏感词，答案会随时间变化，不缓存');
  } else if (policy.reason.startsWith('scene:')) {
    advice.push('高上下文/身份/礼物/纠偏等场景不缓存，避免复读或冒充风险');
  } else if (policy.reason === 'disabled') {
    advice.push('ai_reply_cache_seconds <= 0，回复缓存关闭');
  } else {
    advice.push(`当前策略旁路: ${policy.reason}`);
  }
  if (stableTactical) {
    advice.push('已识别为稳定 CS 战术讨论，不触发联网搜索，适合短 TTL 缓存');
  } else if (searchWouldRun) {
    advice.push('如果这其实只是打法常识，减少“最新/现在/排名/比分”等实时词可提高缓存命中');
  }
  if (normalized && normalized !== clean.toLowerCase()) {
    advice.push('已归一化开头称呼、全角/半角或重复标点，低风险自然变体更容易命中同 key');
  }
  if (knowledgeRoute && knowledgeRoute.titles.length === 0 && config.knowledge_force_style !== false) {
    advice.push('知识分区无命中时仍会尝试语态素材；可用 /kb route 看详细召回');
  }

  return {
    input: clean,
    normalized,
    scene: styleScene,
    policy,
    key,
    keyState,
    searchWouldRun,
    stableTactical,
    timeSensitive,
    knowledgeTitles: knowledgeRoute?.titles || [],
    knowledgeSignature: knowledgeRoute?.signature || '',
    advice: [...new Set(advice)].slice(0, 5),
  };
}

function formatReplyCachePreflightItem(item: ReplyCachePreflightItem, index?: number): string[] {
  const prefix = typeof index === 'number' ? `${index}. ` : '';
  return [
    `${prefix}输入: ${item.input.slice(0, 100)}`,
    `归一化: ${item.normalized || '[空]'}`,
    `场景: ${item.scene.scene}${item.scene.needsRealtime ? '/需实时' : ''}${item.scene.signals.length ? ` (${item.scene.signals.join('/')})` : ''}`,
    `增强: 搜索${item.searchWouldRun ? '会' : '不会'}触发${item.stableTactical ? ' / 稳定战术' : ''}${item.timeSensitive ? ' / 时间敏感' : ''}`,
    `知识: ${item.knowledgeTitles.join(' / ') || '无分区'} sig=${item.knowledgeSignature ? item.knowledgeSignature.slice(0, 10) : '-'}`,
    `策略: ${formatReplyCachePolicy(item.policy)}${item.policy.enabled ? ` key=${item.key} 状态=${item.keyState}` : ` 状态=${item.keyState}`}`,
    `建议: ${item.advice.join('；')}`,
  ];
}

export function formatReplyCachePreflight(config: AIConfig, input: string): string {
  const clean = (input || '').trim();
  if (!clean) return '/mem cache <消息>\n可用 /mem cache A || B 对比两条自然变体是否同 key。';
  const parts = clean
    .split(/\s+\|\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  const items = (parts.length > 0 ? parts : [clean]).map((part) => buildReplyCachePreflightItem(config, part));
  const lines = [
    'AI回复缓存预检',
    '模式: 只读，不联网、不调用模型；模拟普通群聊主动接话，强触发和多模态会另行旁路。',
    ...items.flatMap((item, index) => formatReplyCachePreflightItem(item, items.length > 1 ? index + 1 : undefined)),
  ];
  if (items.length === 2) {
    const sameNormalized = items[0].normalized === items[1].normalized;
    const samePolicy = formatReplyCachePolicy(items[0].policy) === formatReplyCachePolicy(items[1].policy);
    const sameKey = !!items[0].key && items[0].key === items[1].key;
    lines.push(
      `对比: 归一化${sameNormalized ? '相同' : '不同'} / 策略${samePolicy ? '相同' : '不同'} / key${sameKey ? '相同' : '不同或不可缓存'}`,
      sameKey ? '判断: 这两条普通主动接话会合流到同一缓存。' : '判断: 这两条不会安全合流，先看策略/知识分区/实时词差异。',
    );
  }
  return lines.join('\n');
}

export function formatReplyCachePoolStatus(config: AIConfig): string {
  const now = Date.now();
  const entries = [...replyCache.values()];
  const fresh = entries.filter((entry) => entry.expiresAt > now);
  const expired = entries.length - fresh.length;
  const ttlSeconds = fresh
    .map((entry) => Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)))
    .sort((a, b) => a - b);
  const totalSamples = replyCacheHits + replyCacheMisses;
  const hitRate = totalSamples > 0 ? `${Math.round((replyCacheHits / totalSamples) * 100)}%` : '暂无样本';
  const capacity = replyCacheMaxEntries > 0 ? Math.round((replyCache.size / replyCacheMaxEntries) * 100) : 0;
  const configuredTtl = Math.max(0, Math.floor(config.ai_reply_cache_seconds ?? 0));
  const ttlLine = ttlSeconds.length > 0
    ? `min=${ttlSeconds[0]}s p50=${ttlSeconds[Math.floor(ttlSeconds.length / 2)]}s max=${ttlSeconds[ttlSeconds.length - 1]}s`
    : '无 fresh 条目';
  const status = replyCache.size === 0
    ? 'cold/empty'
    : expired > 0
      ? 'has-expired'
      : capacity >= 90
        ? 'near-capacity'
        : 'warm';
  const advice: string[] = [];
  if (configuredTtl <= 0) {
    advice.push('ai_reply_cache_seconds <= 0，回复缓存关闭；只保留 single-flight 合并。');
  } else if (replyCache.size === 0) {
    advice.push('缓存池为空，先观察普通主动接话；可用 /mem cache <消息> 预检哪些问法可缓存。');
  }
  if (totalSamples >= 20 && replyCacheHits / totalSamples < 0.2 && capacity >= 70) {
    advice.push('条目不少但命中偏低，考虑缩短 ai_reply_cache_seconds 或用 /mem cache 对比自然变体。');
  }
  if (capacity >= 90) {
    advice.push('容量接近上限，LRU 会淘汰最旧条目；常见稳定战术问法可保留，实时/身份/礼物旁路是正确的。');
  }
  if (expired > 0) {
    advice.push('存在过期条目，下一次读/写会顺手清理；不需要为了这点单独清缓存。');
  }
  if (replyInFlight.size > 0) {
    advice.push('当前有生成中的同 key 请求，后来的普通主动接话会合并等待，能减少重复 LLM 调用。');
  }
  if (replyCacheBypasses > Math.max(8, replyCacheHits + replyCacheMisses)) {
    advice.push('旁路很多，说明高上下文/实时/多模态/身份等场景多；这是为了真实性和不复读。');
  }
  if (advice.length === 0) {
    advice.push('状态正常；继续用 /trace recent 看真实 cache hit/off 分布。');
  }

  return [
    'AI回复缓存池状态',
    '模式: 只读，不清理、不联网、不调用模型；只看当前进程内短 TTL 回复缓存。',
    `状态: ${status}`,
    `配置: ttl=${configuredTtl}s max=${replyCacheMaxEntries} entries=${replyCache.size}/${replyCacheMaxEntries}(${capacity}%)`,
    `条目: fresh ${fresh.length} / expired ${expired} / in-flight ${replyInFlight.size}`,
    `命中: ${replyCacheHits}/${replyCacheMisses} hitRate=${hitRate} 旁路${replyCacheBypasses}`,
    `TTL分布: ${ttlLine}`,
    `策略Top: ${compactReplyCachePolicyStats(8).join(' / ') || '暂无样本'}`,
    `建议: ${[...new Set(advice)].slice(0, 5).join('；')}`,
    '边界: 回复缓存只给普通主动接话用；@、回复、私聊、命令、实时事实、识图/语音、身份边界和礼物等场景会按策略旁路。',
  ].join('\n');
}

export function pruneExpiredReplyCacheForMaintenance(now: number = Date.now()): {
  before: number;
  fresh: number;
  expired: number;
  removed: number;
  after: number;
  inFlight: number;
} {
  const before = replyCache.size;
  let fresh = 0;
  let expired = 0;
  for (const [, cached] of replyCache) {
    if (cached.expiresAt > now) fresh++;
    else expired++;
  }
  pruneReplyCache(replyCacheMaxEntries);
  return {
    before,
    fresh,
    expired,
    removed: before - replyCache.size,
    after: replyCache.size,
    inFlight: replyInFlight.size,
  };
}

function formatKnowledgeSourceTrustPreview(input: string): string {
  const clean = (input || '').trim();
  if (!clean) return '/kb trust <链接或域名>';
  const preview = previewKnowledgeSourceTrust(clean);
  return [
    '知识来源评级预检',
    `输入: ${preview.input.slice(0, 120)}`,
    `评级: ${preview.sourceTrust}`,
    `域名: ${preview.sourceHosts.join(' / ') || '未解析到'}`,
    `URL: ${preview.urls.join(' ') || '无'}`,
    ...preview.reasons.map((item) => `原因: ${item}`),
    ...preview.policy.map((item) => `边界: ${item}`),
    '说明: 这里只做来源/域名预检，不联网抓取、不写候选；真正写库仍要过 /kb preview 或 /kb import-url 的质量闸。',
  ].join('\n');
}

function parseKnowledgeSourceInspectLimit(input: string, total: number): number {
  const clean = (input || '').trim().toLowerCase();
  if (clean === 'all' || clean === '全部') return Math.max(1, Math.min(total, 40));
  const match = clean.match(/(?:--limit\s+|limit=)?(\d{1,2})/);
  return Math.max(1, Math.min(Number(match?.[1]) || 10, 40));
}

function formatKnowledgeSourceInspectRow(row: ReturnType<typeof inspectKnowledgeSources>['rows'][number]): string[] {
  const hosts = row.sourceHosts.join(',') || (row.evidenceHint ? row.evidenceHint.replace(/^https?:\/\//, '').replace(/\/$/, '') : '无');
  const last = row.lastRefreshAt > 0 ? `${formatTime(row.lastRefreshAt)} / ${row.minutesSinceRefresh}m前` : '从未';
  const next = row.status === 'fresh' ? `${row.nextRefreshInMinutes}m后` : '现在可刷新';
  const reason = row.autoWriteReason.length > 42 ? `${row.autoWriteReason.slice(0, 41)}…` : row.autoWriteReason;
  return [
    `- ${row.id}: ${row.status} / ${row.sourceType} / cfgTrusted=${row.trusted ? 'yes' : 'no'} / eligible=${row.autoCommitEligible ? 'yes' : 'no'}`,
    `  来源=${row.sourceTrust}(${hosts}) / auto=${row.autoWriteState}(${reason}) / last=${last} / next=${next}`,
  ];
}

function formatKnowledgeSourcesReport(config: AIConfig, input: string): string {
  const sources = loadKnowledgeSources();
  const limit = parseKnowledgeSourceInspectLimit(input, sources.length);
  const report = inspectKnowledgeSources(sources, { limit });
  const rows = report.rows.flatMap(formatKnowledgeSourceInspectRow);
  return [
    '知识来源体检',
    `模式: 只读，不联网、不写库、不改 source-state；生成 ${formatTime(report.generatedAt)}`,
    `来源状态: total ${report.total} / fresh ${report.fresh} / due ${report.due} / never ${report.never}`,
    `自动配置: config=${config.knowledge_auto_update !== false ? 'on' : 'off'} runtime=${isKnowledgeAutoEnabled() ? 'on' : 'off'} interval=${config.knowledge_auto_interval_minutes || 180}m batch=${config.knowledge_auto_batch_max_sources || 6}`,
    `写库前置: eligible ${report.autoCommitEligible} / cfgTrusted ${report.trustedConfigured} / domainTrusted ${report.trustedDomains} / domainRisky ${report.riskyDomains}`,
    ...rows,
    report.rows.length < report.total ? `还有 ${report.total - report.rows.length} 个来源未展示，可用 /kb sources all。` : '',
    '边界: due/never 只表示需要刷新，不等于已有最新事实；unknown/risky 不能包装成已核验事实、实时结论或逐字原话。',
    '下一步: /kb refresh [关键词] 刷候选，/kb trust <链接> 单独查域名，/kb audit 查主库风险。',
  ].filter(Boolean).join('\n');
}

function formatKnowledgeFreshnessReport(input: string): string {
  const limit = parseKnowledgeSourceInspectLimit(input, 30);
  const report = inspectKnowledgeFreshness(limit);
  const rows = report.issues.map((issue, index) => [
    `${index + 1}. ${issue.level}: ${issue.title}`,
    `  触发: ${issue.triggers.join(' / ')}；缺失: ${issue.missing.join(' / ')}`,
    `  摘要: ${issue.excerpt}`,
    issue.remediation.length ? `  补证: ${issue.remediation.join('；')}` : '',
    `  建议: ${issue.advice}`,
  ].filter(Boolean).join('\n'));
  const remediationRoutes = [...new Set(report.issues.flatMap((issue) => issue.remediation))].slice(0, 8);
  return [
    '知识库时效事实体检',
    `模式: 只读，不联网、不写库；扫描 ${report.scanned}/${report.sections} 块`,
    `风险: hard ${report.hardSections} / risk ${report.riskSections}`,
    rows.length > 0 ? rows.join('\n') : '结果: 没发现明显时效事实边界缺口。',
    remediationRoutes.length > 0 ? `补证路线: ${remediationRoutes.join('；')}` : '补证路线: CS实时事实先 /cs verify all，管理员先 /cs warm plan all，再用 /cs evidence all 复核。',
    report.issues.length >= limit ? `提示: 当前只显示前 ${limit} 条，可用 /kb stale all 看更多。` : '',
    '边界: 本命令只找“容易被误当当前事实”的知识块；真正回复排名/阵容/赛果前仍以 /cs verify、/cs evidence 和 fresh 实时证据为准，stale/miss 不能当实时结论。',
    '下一步: 给风险块补证据链接、抓取时间、fresh/stale/旧快照边界；或把内容降级为历史线索/摘要；补完后再走 /cs verify 与 /cs evidence 复核。',
  ].filter(Boolean).join('\n');
}

function formatKnowledgeInboxReport(input: string): string {
  const limit = parseKnowledgeSourceInspectLimit(input, 30);
  const report = inspectKnowledgeInbox(limit);
  const rows = report.rows.map((row, index) => {
    const kb = Math.round(row.bytes / 1024 * 10) / 10;
    const hosts = row.sourceHosts.join(',') || '无';
    const issues = row.issues.length ? row.issues.join(' / ') : '无明显硬伤';
    const advice = row.advice.join('；');
    return [
      `${index + 1}. ${row.file} ${kb}KB ${row.lines}行 ${row.materialType}/${row.risk} ingest=${row.ingestMode}`,
      `  来源=${row.sourceTrust}(${hosts}) 证据${row.evidenceUrls.length}条 问题=${issues}`,
      `  建议=${advice}`,
    ].join('\n');
  });
  return [
    '知识库 inbox 素材体检',
    `模式: 只读，不生成候选、不写库；跳过 README.md；生成 ${formatTime(report.generatedAt)}`,
    `素材: total ${report.totalFiles} / scanned ${report.scannedFiles} / ${Math.round(report.totalBytes / 1024 * 10) / 10}KB`,
    `风险: needs_source ${report.needsSource} / 长转写 ${report.longTranscript} / 带证据链接 ${report.withEvidence}`,
    rows.length > 0 ? rows.join('\n') : '结果: knowledge/inbox 里没有可导入的 md/txt 素材文件。',
    report.rows.length < report.totalFiles ? `提示: 当前只显示前 ${limit} 个，可用 /kb inbox all 看更多。` : '',
    '边界: inbox 是素材候选区，不是事实库；长转写、完整字幕和未核验原话要先摘要化，实时事实要补公开来源并用 /cs verify 复核。',
    '下一步: 结构 OK 再 /kb ingest；split-first 先拆成“场景/摘要/可用话术/禁用边界”；needs_source 先补链接或降级为本地授权摘要。',
  ].filter(Boolean).join('\n');
}

function formatKnowledgeCandidateAdvice(candidate: KnowledgeCandidate, maxChars: number = 180): string {
  const advice = recommendKnowledgeCandidateAction(candidate);
  return advice.length > maxChars ? `${advice.slice(0, maxChars - 1)}…` : advice;
}

async function handleKnowledgeCommand(ctx: PluginContext, config: AIConfig): Promise<boolean> {
  if (ctx.command !== 'kb') return false;

  const action = (ctx.args[0] || '').toLowerCase();
  const rest = ctx.args.slice(1).join(' ').trim();

  if (!action || action === 'help') {
    ctx.reply([
      '/kb search <关键词>',
      '/kb route <消息>  预检AI会注入哪些风格/话题知识和命中诊断',
      '/kb trust <链接或域名>  预检来源评级/写库边界',
      '/kb sources [条数|all]  只读体检刷新状态/来源可信度/自动写库前置',
      '/kb stale [条数|all]  只读体检主库时效事实边界缺口',
      '/kb inbox [条数|all]  管理员，只读体检 knowledge/inbox 本地素材风险',
      '/kb stats',
      '/kb preview <关键词>  管理员',
      '/kb import-url <链接>  管理员',
      '/kb refresh [--aggressive] [关键词]  管理员',
      '/kb audit  管理员',
      '/kb auto <on|off|run>  管理员',
      '/kb batches  管理员',
      '/kb rollback <batchId>  管理员',
      '/kb show <候选ID>  管理员',
      '/kb drop <候选ID>  管理员',
      '/kb commit <候选ID>  管理员',
      '/kb ingest  管理员',
      '/kb list  管理员',
    ].join('\n'));
    return true;
  }

  if (action === 'search') {
    if (!rest) {
      ctx.reply('/kb search <关键词>');
      return true;
    }
    ctx.reply(formatKnowledgeResults(searchKnowledge(rest, 5, 260)));
    return true;
  }

  if (action === 'route' || action === 'why' || action === 'inject' || action === '路由') {
    if (!rest) {
      ctx.reply('/kb route <要预检的消息>');
      return true;
    }
    ctx.reply(formatKnowledgeRoutePreview(config, rest));
    return true;
  }

  if (['trust', 'source', 'check-source', 'source-check', '来源', '评级'].includes(action)) {
    if (!rest) {
      ctx.reply('/kb trust <链接或域名>');
      return true;
    }
    ctx.reply(formatKnowledgeSourceTrustPreview(rest));
    return true;
  }

  if (['sources', 'source-status', 'source-state', '来源状态', '源状态', '源'].includes(action)) {
    ctx.reply(formatKnowledgeSourcesReport(config, rest));
    return true;
  }

  if (['stale', 'freshness', 'fresh', 'timecheck', '时效', '新鲜度', '旧事实'].includes(action)) {
    ctx.reply(formatKnowledgeFreshnessReport(rest));
    return true;
  }

  if (action === 'stats') {
    const stats = getKnowledgeStats();
    ctx.reply([
      `知识库: ${stats.sections}块 ${stats.chars}字`,
      `索引词: ${stats.keywords}`,
      `检索命中: ${stats.searchHits}/${stats.searchMisses}`,
      `注入命中: ${stats.selectHits}/${stats.selectMisses}`,
      `候选: ${stats.candidates}`,
      `自动: ${stats.autoEnabled ? 'on' : 'off'} 最近${formatTime(stats.lastAutoRefreshAt)}`,
      `自动写入: ${stats.autoCommitted} 质量闸保护 审计问题: ${stats.auditIssues}`,
      `来源状态: ${stats.sourceStates} 个`,
      `候选来源: trusted ${stats.trustedSourceCandidates} / unknown ${stats.unknownSourceCandidates} / risky ${stats.riskySourceCandidates}`,
    ].join('\n'));
    return true;
  }

  if (!['preview', 'import-url', 'url', 'refresh', 'audit', 'auto', 'batches', 'rollback', 'show', 'drop', 'commit', 'ingest', 'inbox', 'list'].includes(action)) {
    ctx.reply('先看 /kb help，别硬猜命令。');
    return true;
  }

  if (!isAdmin(ctx)) {
    ctx.replyAt('这个得管理员来，知识库不能谁来都往里灌。');
    return true;
  }

  if (config.knowledge_update_mode === 'static' && action !== 'list' && action !== 'inbox') {
    ctx.reply('知识库现在是 static 模式，只能查不能写候选。');
    return true;
  }

  if (action === 'list') {
    const candidates = listKnowledgeCandidates();
    if (candidates.length === 0) {
      ctx.reply('现在没有待提交候选。');
      return true;
    }
    ctx.reply(candidates
      .slice(0, 8)
      .map((item) => `${item.id} | ${item.title} | ${item.sourceType}/${item.confidence}/${item.risk} | 来源${item.sourceTrust}${item.sourceHosts.length ? `(${item.sourceHosts.join(',')})` : ''} | 质量闸${describeKnowledgeCandidateQuality(item)} | ${formatKnowledgeCandidateAdvice(item, 120)} | ${item.source}`)
      .join('\n'));
    return true;
  }

  if (action === 'inbox') {
    ctx.reply(formatKnowledgeInboxReport(rest));
    return true;
  }

  if (action === 'batches') {
    const batches = listKnowledgeBatches(8);
    if (batches.length === 0) {
      ctx.reply('还没有自动写入批次。');
      return true;
    }
    ctx.reply(batches.map((batch) => [
      batch.batchId,
      formatTime(batch.createdAt),
      `entries ${batch.entries}`,
      `committed ${batch.committed}`,
      `rollback ${batch.rolledBack}`,
      'main-only',
    ].join(' | ')).join('\n'));
    return true;
  }

  if (action === 'rollback') {
    if (!rest) {
      ctx.reply('/kb rollback <batchId>');
      return true;
    }
    const result = rollbackKnowledgeBatch(rest);
    ctx.reply(`回滚完成: 删除块 ${result.removedBlocks}，更新日志 ${result.updatedEntries}`);
    return true;
  }

  if (action === 'audit') {
    const report = auditKnowledge();
    const hard = report.issues.filter((item) => item.level === 'hard').length;
    const risk = report.issues.filter((item) => item.level === 'risk').length;
    const info = report.issues.filter((item) => item.level === 'info').length;
    ctx.reply([
      `知识库审计: ${report.sections}块 ${report.chars}字`,
      `问题: hard ${hard} / risk ${risk} / info ${info}`,
      '写入策略: 主库分层，风险内容标为待核验',
      ...report.issues.slice(0, 8).map((item) => `${item.level}: ${item.title}${item.detail ? `；${item.detail.slice(0, 90)}` : ''}`),
    ].join('\n'));
    return true;
  }

  if (action === 'auto') {
    const mode = rest.toLowerCase();
    if (!mode) {
      const stats = getKnowledgeStats();
      const audit = getLastKnowledgeAudit();
      ctx.reply([
        `自动更新: ${isKnowledgeAutoEnabled() ? 'on' : 'off'}`,
        `最近刷新: ${stats.lastAutoRefreshAt ? new Date(stats.lastAutoRefreshAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'}`,
        `自动写入: ${stats.autoCommitted}`,
        '写入策略: 只自动写入有来源且通过质量闸的候选，风险内容留给人工确认',
        `候选来源: trusted ${stats.trustedSourceCandidates} / unknown ${stats.unknownSourceCandidates} / risky ${stats.riskySourceCandidates}`,
        `审计问题: ${audit?.issues.length || 0}`,
        '/kb auto on|off|run',
      ].join('\n'));
      return true;
    }
    if (mode === 'on') {
      setKnowledgeAutoEnabled(true);
      ctx.reply('知识库自动更新打开了。');
      return true;
    }
    if (mode === 'off') {
      setKnowledgeAutoEnabled(false);
      ctx.reply('知识库自动更新关了。');
      return true;
    }
    if (mode === 'run') {
      const result = await runKnowledgeRefresh(config, '', true);
      ctx.reply(result);
      return true;
    }
    ctx.reply('/kb auto on|off|run');
    return true;
  }

  if (action === 'show') {
    if (!rest) {
      ctx.reply('/kb show <候选ID>');
      return true;
    }
    const candidate = getKnowledgeCandidate(rest);
    ctx.reply(candidate ? [
      `${candidate.id} | ${candidate.title}`,
      `来源: ${candidate.source}`,
      `类型: ${candidate.sourceType} / 置信度: ${candidate.confidence} / 风险: ${candidate.risk} / 状态: ${candidate.status}`,
      `来源评级: ${candidate.sourceTrust}${candidate.sourceHosts.length > 0 ? ` (${candidate.sourceHosts.join(', ')})` : ''}`,
      `自动质量闸: ${describeKnowledgeCandidateQuality(candidate)}`,
      `行动建议: ${formatKnowledgeCandidateAdvice(candidate)}`,
      `证据: ${candidate.evidenceUrls.length > 0 ? candidate.evidenceUrls.join(' ') : '暂无'}`,
      candidate.markdown.slice(0, 1800),
    ].join('\n') : '没这个候选ID，/kb list 看一下。');
    return true;
  }

  if (action === 'drop') {
    if (!rest) {
      ctx.reply('/kb drop <候选ID>');
      return true;
    }
    const candidate = dropKnowledgeCandidate(rest);
    ctx.reply(candidate ? `丢掉候选了: ${candidate.title}` : '没这个候选ID，/kb list 看一下。');
    return true;
  }

  if (action === 'preview') {
    if (!rest) {
      ctx.reply('/kb preview <关键词>');
      return true;
    }
    const result = await webSearch(
      rest,
      Math.max(config.search_timeout_ms || 1500, 1500),
      config.search_cache_seconds ?? 300,
      config.search_negative_cache_seconds ?? 60,
    );
    if (!result) {
      ctx.reply('没搜到准信，先别写库。');
      return true;
    }
    const candidate = previewKnowledgeCandidate(rest, result, `web:${rest}`);
    ctx.reply([
      `候选 ${candidate.id}`,
      `类型: ${candidate.sourceType} / 置信度: ${candidate.confidence} / 风险: ${candidate.risk}`,
      `来源评级: ${candidate.sourceTrust}${candidate.sourceHosts.length > 0 ? ` (${candidate.sourceHosts.join(', ')})` : ''}`,
      `自动质量闸: ${describeKnowledgeCandidateQuality(candidate)}`,
      `行动建议: ${formatKnowledgeCandidateAdvice(candidate)}`,
      candidate.markdown.slice(0, 700),
      '确认没问题再 /kb commit ' + candidate.id,
    ].join('\n'));
    return true;
  }

  if (action === 'import-url' || action === 'url') {
    if (!rest) {
      ctx.reply('/kb import-url <链接>\n只抓标题、来源和短摘要，生成候选，不自动写库。');
      return true;
    }
    try {
      const candidate = await importKnowledgeUrlCandidate(
        rest.split(/\s+/)[0],
        Math.max(config.knowledge_source_timeout_ms || config.search_timeout_ms || 1800, 1500),
      );
      ctx.reply([
        `URL候选 ${candidate.id}`,
        `标题: ${candidate.title}`,
        `类型: ${candidate.sourceType} / 置信度: ${candidate.confidence} / 风险: ${candidate.risk}`,
        `来源评级: ${candidate.sourceTrust}${candidate.sourceHosts.length > 0 ? ` (${candidate.sourceHosts.join(', ')})` : ''}`,
        `自动质量闸: ${describeKnowledgeCandidateQuality(candidate)}`,
        `行动建议: ${formatKnowledgeCandidateAdvice(candidate)}`,
        `证据: ${candidate.evidenceUrls.join(' ') || '暂无'}`,
        candidate.markdown.slice(0, 850),
        '确认没问题再 /kb commit ' + candidate.id,
      ].join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.reply(`URL导入失败: ${message.slice(0, 120)}\n别硬写库，换个可公开访问的网页。`);
    }
    return true;
  }

  if (action === 'refresh') {
    const aggressive = rest.split(/\s+/).includes('--aggressive');
    const query = rest.replace(/(^|\s)--aggressive(\s|$)/g, ' ').trim();
    ctx.reply(await runKnowledgeRefresh(config, query, false, aggressive));
    return true;
  }

  if (action === 'ingest') {
    const mode = rest.toLowerCase() === 'full' ? 'full' : 'summary';
    const candidates = previewInboxCandidates(mode);
    if (candidates.length === 0) {
      ctx.reply('knowledge/inbox 里没看到 md/txt 素材。');
      return true;
    }
    ctx.reply([
      `从 inbox 生成 ${candidates.length} 个候选(${mode}):`,
      ...candidates.slice(0, 8).map((item) => `${item.id} | ${item.title} | 来源${item.sourceTrust} | 质量闸${describeKnowledgeCandidateQuality(item)} | ${formatKnowledgeCandidateAdvice(item, 120)}`),
      '看完再 /kb commit <候选ID>',
    ].join('\n'));
    return true;
  }

  if (action === 'commit') {
    if (!rest) {
      ctx.reply('/kb commit <候选ID>');
      return true;
    }
    const candidate = commitKnowledgeCandidate(rest);
    ctx.reply(candidate ? `写进知识库了: ${candidate.title}` : '没这个候选ID，/kb list 看一下。');
    return true;
  }

  return true;
}

async function liveKnowledgeLookup(config: AIConfig, kind: 'player' | 'team', query: string): Promise<string> {
  const local = searchKnowledge(`${query} ${kind === 'player' ? '选手 player' : '队伍 team'}`, 3, 220);
  const structured = kind === 'player'
    ? await fetchPlayerProfile(query)
    : await fetchTeamProfile(query);
  const searchQuery = `${query} HLTV Liquipedia CS2`;
  const live = structured ? '' : await webSearch(
    searchQuery,
    Math.max(config.search_timeout_ms || 1500, 1200),
    config.search_cache_seconds ?? 300,
    config.search_negative_cache_seconds ?? 60,
  );
  const localText = local.length > 0 ? formatKnowledgeResults(local, 520) : '本地倾向还没写厚。';
  const liveText = structured || (live ? live.slice(0, 520) : '没搜到准信，别硬编。');
  return [
    kind === 'player' ? '选手这块我按本地倾向加实时数据说。' : '队伍这块我按本地倾向加实时数据说。',
    localText,
    `实时参考:\n${liveText}`,
  ].join('\n');
}

async function handleLocalKnowledgeCommand(ctx: PluginContext, config: AIConfig): Promise<boolean> {
  if (ctx.command === 'quote') {
    const sub = (ctx.args[0] || '').toLowerCase();
    if (sub === 'check' || sub === 'status' || sub === 'preview' || sub === '预检' || sub === '检查') {
      ctx.reply(formatQuoteKnowledgePreflight(ctx.args.slice(1).join(' ').trim()));
      return true;
    }
    const query = ctx.args.join(' ').trim();
    const line = getRandomKnowledgeLine('quote', query);
    ctx.reply(formatQuoteReply(query, line));
    return true;
  }

  if (ctx.command === 'player') {
    const query = ctx.args.join(' ').trim();
    if (!query) {
      ctx.reply('/player <选手名>');
      return true;
    }
    if (/最新|现在|排名|阵容|转会|加入|离队|近期|今天/.test(query)) {
      ctx.reply(await liveKnowledgeLookup(config, 'player', query));
      return true;
    }
    const results = searchKnowledge(`${query} 选手 player`, 3, 260);
    const line = getRandomKnowledgeLine('player', query);
    ctx.reply(results.length > 0 ? formatKnowledgeResults(results, 700) : (line || '这选手资料库里还没写，先 /kb preview 补一下。'));
    return true;
  }

  if (ctx.command === 'team') {
    const query = ctx.args.join(' ').trim();
    if (!query) {
      ctx.reply('/team <队伍名>');
      return true;
    }
    if (/最新|现在|排名|阵容|转会|加入|离队|近期|今天/.test(query)) {
      ctx.reply(await liveKnowledgeLookup(config, 'team', query));
      return true;
    }
    const results = searchKnowledge(`${query} 队伍 team`, 3, 260);
    const line = getRandomKnowledgeLine('team', query);
    ctx.reply(results.length > 0 ? formatKnowledgeResults(results, 700) : (line || '这队伍资料库里还没写，先 /kb preview 补一下。'));
    return true;
  }

  if (ctx.command === 'gift') {
    const sub = (ctx.args[0] || '').toLowerCase();
    if (sub === 'status') {
      ctx.reply(formatGiftThanksStatus());
      return true;
    }
    if (sub === 'trace') {
      ctx.reply(formatGiftThanksTrace());
      return true;
    }
    if (sub === 'recent' || sub === 'history' || sub === 'list' || sub === '最近' || sub === '记录') {
      const limit = Math.max(1, Math.min(parseInt(ctx.args[1] || '8', 10) || 8, 20));
      ctx.reply(formatGiftThanksRecent(limit));
      return true;
    }
    const warmMode = sub === 'warm' || sub === 'prewarm' || sub === '预热' || sub === '暖缓存';
    const checkMode = sub === 'check' || sub === 'cache' || sub === 'test' || sub === 'preview' || sub === '预检' || sub === '测试' || sub === '缓存';
    const args = checkMode || warmMode ? ctx.args.slice(1) : [...ctx.args];
    let count = 1;
    const last = args[args.length - 1] || '';
    const countMatch = last.match(/^(?:x|×)?(\d{1,4})$/i) || last.match(/^(.{1,24})[x×](\d{1,4})$/i);
    if (countMatch) {
      count = Number(countMatch[countMatch.length - 1]) || 1;
      if (countMatch.length === 3 && countMatch[1]) args[args.length - 1] = countMatch[1];
      else args.pop();
    }
    const gift = args.join(' ').trim() || '礼物';
    if (warmMode) {
      if (!isAdmin(ctx)) {
        ctx.replyAt('礼物语音预热会真实跑 TTS，这个得管理员来。');
        return true;
      }
      const provider = config.tts_provider || 'api';
      const localReady = !!(config.tts_local_command || '').trim() && (provider === 'local' || provider === 'auto');
      const ttsNeedsApi = provider === 'api' || (provider === 'auto' && !localReady);
      if (ttsNeedsApi && !hasUsableApiKey(config.api_key)) {
        ctx.reply([
          '礼物语音预热',
          `礼物: ${gift}x${count}`,
          '预热动作: skipped/api-not-ready',
          '原因: 当前 TTS 需要 API 后端，但 api_key 不可用；先配置本地 TTS 或真实 API key。',
        ].join('\n'));
        return true;
      }
      ctx.reply(await warmGiftThanksVoice(config, gift, count, ctx.groupId || 0, {
        generate: (voiceText) => withGate('tts', () => generateVoice(config, voiceText), true),
      }));
      return true;
    }
    ctx.reply(checkMode
      ? formatGiftThanksPreview(config, gift, count, ctx.groupId || 0)
      : buildGiftThanks(gift, count));
    return true;
  }

  return false;
}

// ============ 单例 ============
let contextManager: ContextManager | null = null;
const groupQueues: Map<string, Promise<void>> = new Map();
const groupQueueStats: Map<string, { pending: number; forced: number; oldestCreatedAt: number }> = new Map();
const groupQueueAges: Map<string, number[]> = new Map();
const lastReplyAt: Map<string, number> = new Map();
/** 群最近消息时间戳列表（最多保留最近 60 秒内）- 用于"群聊正在快速对话"的检测 */
const recentGroupMessages: Map<string, number[]> = new Map();
const sessionRecentOpeners: Map<string, string[]> = new Map();
/** 每个 session 最近 5 条 bot 回复（标准化后），用于全句去重 */
const sessionRecentReplies: Map<string, string[]> = new Map();
const replyCache: Map<string, { value: string; expiresAt: number }> = new Map();
const replyInFlight: Map<string, Promise<InFlightReplyResult>> = new Map();
let skippedPassiveReplies = 0;
let deferredCompressions = 0;
let completedCompressions = 0;
let failedCompressions = 0;
let replyCacheHits = 0;
let replyCacheMisses = 0;
let replyCacheBypasses = 0;
let replyCacheMaxEntries = 300;
let evidenceTraceCount = 0;
let realtimeIntentWithoutDataCount = 0;
let realtimeStaleEvidenceCount = 0;
let factGuardRepairCount = 0;
let qualityRepairCount = 0;
let freshnessRepairCount = 0;
let outputRepairCount = 0;
let styleSceneTraceCount = 0;
let qualityIssueTraceCount = 0;
let humanReplyDelayCount = 0;
let humanReplyDelayTotalMs = 0;
let lastHumanReplyDelayMs = 0;
let lastFactGuard = '';
let lastEvidenceSummary: string[] = [];
let lastEvidenceLedger: string[] = [];
let lastRealtimeFreshness: string[] = [];
let lastStyleScene = '';
let lastStyleSceneAction = '';
let lastQualityIssues: string[] = [];
let lastQualityFinalOk: boolean | undefined;
const evidenceTraceMessages = new Set<number>();
const realtimeMissingMessages = new Set<number>();
const realtimeStaleMessages = new Set<number>();
const factGuardMessages = new Set<number>();
const freshnessRepairMessages = new Set<number>();
const replyCacheBypassMessages = new Set<number>();
const replyCachePolicyMessages = new Set<number>();
const styleSceneMessages = new Set<number>();
const qualityIssueMessages = new Set<number>();
const styleSceneCounts: Map<string, number> = new Map();
const replyCachePolicyCounts: Map<string, number> = new Map();
const recentStyleScenes: string[] = [];
const MAX_REPLY_TRACES = 20;
const recentReplyTraces: ReplyTrace[] = [];
const MAX_VISION_TRACES = 20;
const recentVisionTraces: ReplyTrace[] = [];
const MAX_VOICE_TRACES = 20;
const recentVoiceTraces: VoiceTrace[] = [];
let lastReplyTrace: ReplyTrace | null = null;
let lastVoiceTrace: VoiceTrace | null = null;
let aiRuntimeGeneration = 1;
const directAiCommands = new Set(['ai', 'ask', 'chat']);
const directSearchCommands = new Set(['search', '搜', '搜索']);
const directVisionCommands = new Set(['vision', 'image', 'img', '识图']);
const directMediaCommands = new Set(['media', 'multimodal', 'multi', '多模态', '媒体']);
const defaultSearchPattern = /最新|最近|现在|今天|谁赢|比分|赛程|更新|版本|发布|新闻|热搜|多少钱|价格|天气/;
const knowledgeRefreshQueries = [
  '玩机器 Machine 6657 经典语录 切片 CS2 解说',
  '玩机器 6657 斗鱼 礼物 感谢 老板大气',
  '玩机器 6657 直播间 烂梗 弹幕 sb6657',
  '玩机器 Machine 萌娘百科 6657 CSGO 解说',
  'HLTV top 20 players 2025 ZywOo donk ropz m0NESY sh1ro NiKo',
  'CS2 2026 team ranking Vitality NAVI Spirit MOUZ G2 Falcons FaZe',
];
let knowledgeAutoTimer: NodeJS.Timeout | null = null;
let knowledgeAutoRunning = false;
let knowledgeAutoConfig: AIConfig | null = null;
let knowledgeAutoIntervalMinutes = 0;
let maintenanceTimer: NodeJS.Timeout | null = null;
const compressionInFlight: Set<string> = new Set();

function getContextManager(config: AIConfig): ContextManager {
  replyCacheMaxEntries = clampReplyCacheMaxEntries(config.ai_reply_cache_max_entries);
  pruneReplyCache(replyCacheMaxEntries);
  if (!contextManager) {
    contextManager = new ContextManager(
      config.max_context_messages ?? 50,
      config.context_expire_minutes ?? 120
    );
  }
  contextManager.configure({
    maxMessages: config.max_context_messages ?? 50,
    expireMinutes: config.context_expire_minutes ?? 120,
    enableMemoryRetrieval: config.enable_memory_retrieval !== false,
    memoryTopK: config.memory_top_k ?? 3,
    memoryMinSimilarity: config.memory_min_similarity ?? 0.15,
    memoryInjectMaxChars: config.memory_inject_max_chars ?? 700,
    memoryMaxMessagesPerSession: config.memory_max_messages_per_session ?? 500,
    memoryMaxSessionsInMemory: config.memory_max_sessions_in_memory ?? 50,
  });
  return contextManager;
}

function makeFallbackKnowledgeSources(): KnowledgeSource[] {
  return knowledgeRefreshQueries.map((query, index) => ({
    id: `fallback-${index + 1}`,
    query,
    sourceType: /HLTV|ranking|team/i.test(query) ? 'public_fact' : 'public_summary',
    trusted: !/礼物|感谢/.test(query),
    autoCommitEligible: !/礼物|感谢|切片|语录/.test(query),
    intervalMinutes: 720,
  }));
}

// formatTime, previewText 已迁移到 ./reply-postprocess

function formatTraceTime(timestamp: number): string {
  return timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '无';
}

function compactTraceList(items: string[] | undefined, maxItems: number = 6): string {
  if (!items || items.length === 0) return '';
  const unique = items
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, maxItems);
  return unique.join(' / ');
}

function isWarmupCommandSource(source: string): boolean {
  const raw = (source || '').trim();
  if (!raw || raw.length > 260 || /\s/.test(raw)) return false;
  if (/^(?:data:|base64:\/\/)/i.test(raw)) return false;
  return /^(?:https?:\/\/|file:\/\/|[a-zA-Z]:[\\/]|\/|\\)/.test(raw);
}

function traceWarmupSources(sources: string[], limit = 4): string[] {
  return uniqueNonEmpty(sources)
    .filter(isWarmupCommandSource)
    .slice(0, Math.max(1, limit));
}

function warmupTraceLabel(timestamp: number, messageId: number, chatType: string, chatId: number): string {
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return `mid=${messageId} ${chatType}=${chatId} age=${ageSeconds}s`;
}

function compactStyleSceneStats(maxItems: number = 5): string[] {
  return [...styleSceneCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, maxItems)
    .map(([scene, count]) => `${scene}${count}`);
}

function compactReplyCachePolicyStats(maxItems: number = 6): string[] {
  return [...replyCachePolicyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, maxItems)
    .map(([policy, count]) => `${policy}=${count}`);
}

function buildEvidenceLedger(trace: ReplyTrace): string[] {
  const ledger: string[] = [];
  if (trace.realtimeIntent) {
    if (trace.realtimeDataAvailable) {
      ledger.push('当前事实=fresh优先');
    } else if (trace.realtimeStaleEvidence) {
      ledger.push('当前事实=仅stale线索');
    } else {
      ledger.push('当前事实=缺fresh证据');
    }
  } else if (trace.searchUsed || trace.hltvUsed) {
    ledger.push(`事实参考=${trace.hltvUsed ? 'HLTV/CS' : '搜索'}非实时问法`);
  } else {
    ledger.push('事实参考=未联网');
  }

  if (trace.realtimeFreshness?.length) {
    const freshCount = trace.realtimeFreshness.filter((line) => /\bfresh\b/i.test(line)).length;
    const staleCount = trace.realtimeFreshness.filter((line) => /\bstale\b|过期|不能当实时结论/i.test(line)).length;
    ledger.push(`实时证据=fresh${freshCount}/stale${staleCount}`);
  }

  if (trace.knowledgeInjected) {
    ledger.push(trace.knowledgeFreshnessIssues?.length
      ? `知识=${trace.knowledgeChars}字/时效风险${trace.knowledgeFreshnessIssues.length}`
      : `知识=${trace.knowledgeChars}字`);
  } else if (trace.knowledgeTopic) {
    ledger.push('知识=话题命中但未注入');
  }

  if (trace.memoryHits || trace.memoryFiltered) {
    ledger.push(`RAG=注入${trace.memoryHits || 0}/过滤${trace.memoryFiltered || 0}`);
  }

  if (trace.userProfileInjected) {
    ledger.push(`画像=个性化${trace.userProfileChars || 0}字/非事实`);
  }

  if (trace.hasImages) {
    ledger.push(trace.visionPayload
      ? `识图=已传图${trace.visionImages || 0}/${trace.imageInputCount || trace.visionImages || 0}${trace.visionTruncated ? '/截断' : ''}`
      : `识图=未传图${trace.visionError ? `/${trace.visionError.slice(0, 24)}` : ''}`);
  }

  if (trace.hasRecords) {
    ledger.push(trace.recordTranscripts > 0
      ? `听写=${trace.recordTranscripts}/${trace.recordInputCount || trace.recordTranscripts}${trace.sttTruncated ? '/截断' : ''}`
      : `听写=无转写${trace.sttError ? `/${trace.sttError.slice(0, 24)}` : ''}`);
  }

  if (trace.factGuard) ledger.push(`事实修正=${trace.factGuard.slice(0, 36)}`);
  if (trace.freshnessRepair) ledger.push(`新鲜度修正=${trace.freshnessRepair.slice(0, 36)}`);

  return ledger.slice(0, 10);
}

function getTraceEvidenceLedger(trace: ReplyTrace): string[] {
  return trace.evidenceLedger && trace.evidenceLedger.length > 0
    ? trace.evidenceLedger
    : buildEvidenceLedger(trace);
}

function formatReplyTraceCacheDecision(trace: ReplyTrace, maxLength = 140): string {
  const fallback = trace.cacheHit ? 'hit' : (trace.cachePolicy || 'miss');
  const decision = trace.cacheDecision || fallback;
  if (decision.length <= maxLength) return decision;
  return `${decision.slice(0, Math.max(20, maxLength - 1))}…`;
}

function formatReplyTrace(trace: ReplyTrace | null): string {
  if (!trace) return '还没有回复 trace。先 @ 一句或跑 /voice test。';
  const evidenceLedger = getTraceEvidenceLedger(trace);
  return [
    '最近回复 trace',
    `时间: ${formatTraceTime(trace.timestamp)}`,
    `会话: ${trace.chatType} ${trace.chatId}${trace.groupId ? ` / group ${trace.groupId}` : ''}`,
    `消息: mid=${trace.messageId} uid=${trace.userId} ${trace.senderName}`,
    `触发: ${trace.triggerReason} forced=${trace.forced}`,
    trace.command ? `命令: /${trace.command}` : '',
    `原文: ${trace.rawTextPreview || '[空/媒体消息]'}`,
    trace.effectiveTextPreview && trace.effectiveTextPreview !== trace.rawTextPreview ? `有效文本: ${trace.effectiveTextPreview}` : '',
    `媒体: 图片${trace.hasImages ? `有${trace.imageInputCount ? `(${trace.imageInputCount})` : ''}${trace.imageSourceKinds?.length ? ` ${trace.imageSourceKinds.join('/')}` : ''}` : '无'} 语音${formatRecordTrace(trace)}`,
    `队列: 等待${Math.round(trace.queueAgeMs / 1000)}s`,
    trace.humanDelayMs ? `真人停顿: ${trace.humanDelayMs}ms` : '',
    trace.contextMessagesSent ? `上下文: ${trace.contextMessagesSent}条${trace.contextFocused ? ' (聚焦)' : ''}${trace.memoryHits ? ` 命中${trace.memoryHits}` : ''}` : '',
    trace.memoryFiltered ? `记忆过滤: ${trace.memoryFiltered}条${trace.memoryFilterReasons?.length ? ` ${compactTraceList(trace.memoryFilterReasons, 4)}` : ''}` : '',
    trace.memoryPreview && trace.memoryPreview.length > 0 ? `记忆: ${trace.memoryPreview.join(' / ')}` : '',
    `增强: 知识${trace.knowledgeInjected ? `${trace.knowledgeChars}字` : '未注入'}${trace.knowledgeTopic ? '/话题命中' : ''} 搜索${trace.searchUsed ? `${trace.searchChars}字` : '未用'} 识图${formatVisionTrace(trace)}`,
    formatVisionCacheEvidence(trace) ? `识图缓存: ${formatVisionCacheEvidence(trace)}` : '',
    `画像: ${trace.userProfileInjected ? `已注入${trace.userProfileChars || 0}字` : '未注入'}`,
    evidenceLedger.length ? `证据账本: ${compactTraceList(evidenceLedger, 10)}` : '',
    `证据: 实时意图${trace.realtimeIntent ? '有' : '无'} 实时数据${trace.realtimeDataAvailable ? '有' : '无'}${trace.evidenceSummary?.length ? ` | ${compactTraceList(trace.evidenceSummary)}` : ''}`,
    trace.realtimeFreshness?.length ? `实时新鲜度: ${compactTraceList(trace.realtimeFreshness, 5)}${trace.realtimeStaleEvidence ? ' / 含stale' : ''}` : '',
    trace.searchEvidence?.length ? `搜索证据: ${compactTraceList(trace.searchEvidence, 4)}` : '',
    trace.hltvUsed ? `HLTV实时: 已注入${trace.hltvChars}字` : '',
    trace.hltvError ? `HLTV错误: ${trace.hltvError}` : '',
    trace.knowledgeTitles.length > 0 ? `知识分区: ${trace.knowledgeTitles.join(' / ')}` : (trace.forced ? '知识分区: 无命中，建议 /kb stats' : ''),
    trace.knowledgeLanes?.length ? `知识多路: ${trace.knowledgeLanes.join(' / ')}` : '',
    trace.knowledgeFreshnessIssues?.length ? `知识时效风险: ${compactTraceList(trace.knowledgeFreshnessIssues, 4)}` : '',
    trace.styleScene ? `风格场景: ${trace.styleScene}${trace.styleSceneNeedsRealtime ? '/需实时' : ''}${trace.styleSceneSignals?.length ? ` | ${compactTraceList(trace.styleSceneSignals, 5)}` : ''}${trace.styleSceneAction ? ` | ${trace.styleSceneAction}` : ''}` : '',
    trace.qualityIssues?.length ? `质量风险: ${compactTraceList(trace.qualityIssues, 5)}${trace.qualityFinalOk ? ' / 已修复' : ''}` : (trace.qualityFinalOk ? '质量风险: 无' : ''),
    trace.openerBefore ? `开头: ${trace.openerBefore} -> ${trace.openerAfter || '[空]'}${trace.openerDeduped ? ' 已去重' : ''}` : '',
    trace.sttError ? `听写错误: ${trace.sttError}` : '',
    trace.visionError ? `识图错误: ${trace.visionError}` : '',
    trace.searchError ? `搜索错误: ${trace.searchError}` : '',
    `语音: ${trace.voiceMode} requested=${trace.voiceRequested} parts=${trace.voiceParts}`,
    trace.cachePolicy ? `缓存策略: ${trace.cachePolicy}${trace.cacheTtlSeconds ? ` ttl=${trace.cacheTtlSeconds}s` : ''}` : '',
    `缓存判定: ${formatReplyTraceCacheDecision(trace)}${trace.cacheKeyPrefix && !trace.cacheDecision?.includes('key=') ? ` key=${trace.cacheKeyPrefix}` : ''}`,
    `发送: ${trace.sent} cacheHit=${trace.cacheHit} replyLen=${trace.replyLength}`,
    trace.outputRepair ? `修复: ${trace.outputRepair}` : '',
    trace.freshnessRepair ? `新鲜度: ${trace.freshnessRepair}` : '',
    trace.factGuard ? `事实边界: ${trace.factGuard}` : '',
    trace.error ? `错误: ${trace.error}` : '',
  ].filter(Boolean).join('\n');
}

function formatReplyRecent(limit = 8): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, MAX_REPLY_TRACES));
  const traces = recentReplyTraces.slice(0, safeLimit);
  if (traces.length === 0) {
    return [
      '回复最近 trace',
      '最近: 无 AI/语音回复 trace',
      '说明: 只读最近真实回复链路；用于回看触发、发送、缓存、知识、实时证据、识图和语音。',
    ].join('\n');
  }
  return [
    `回复最近 trace ${traces.length}/${recentReplyTraces.length}`,
    ...traces.map((trace, index) => {
      const time = new Date(trace.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const knowledge = trace.knowledgeInjected ? `${trace.knowledgeChars}字` : '无';
      const cache = formatReplyTraceCacheDecision(trace, 180);
      const quality = trace.qualityIssues?.length ? ` quality=${compactTraceList(trace.qualityIssues, 2)}` : (trace.qualityFinalOk ? ' quality=ok' : '');
      const realtime = trace.realtimeIntent ? ` realtime=${trace.realtimeDataAvailable ? 'data' : 'missing'}` : '';
      const ledger = compactTraceList(getTraceEvidenceLedger(trace), 2);
      const ledgerText = ledger ? ` ledger=${ledger}` : '';
      const memFilter = trace.memoryFiltered ? ` memFilter=${trace.memoryFiltered}` : '';
      const kbRisk = trace.knowledgeFreshnessIssues?.length ? ` kbRisk=${compactTraceList(trace.knowledgeFreshnessIssues, 1)}` : '';
      const guard = trace.factGuard ? ` guard=${trace.factGuard.slice(0, 60)}` : '';
      const visionCache = formatVisionCacheEvidence(trace, 1);
      const humanDelay = trace.humanDelayMs ? ` delay=${trace.humanDelayMs}ms` : '';
      const error = trace.error ? ` error=${trace.error.slice(0, 80)}` : '';
      const text = trace.rawTextPreview ? ` | ${trace.rawTextPreview}` : '';
      return `${index + 1}. ${time} mid=${trace.messageId} uid=${trace.userId} ${trace.chatType}=${trace.chatId} trigger=${trace.triggerReason} sent=${trace.sent}${humanDelay} cache=${cache} 知识=${knowledge} 识图=${formatVisionTrace(trace)}${visionCache ? ` visionCache=${visionCache}` : ''} 语音=${trace.voiceMode}/${trace.voiceParts}${realtime}${ledgerText}${memFilter}${kbRisk}${quality}${guard}${error}${text}`;
    }),
    '边界: 这里只有链路摘要；要看完整字段用 /trace last，实时事实仍以 fresh 证据为准。',
  ].join('\n');
}

function formatVoiceTrace(trace: VoiceTrace | null, config?: AIConfig): string {
  const stats = getVoiceStats(config);
  if (!trace) {
    return [
      '最近语音 trace',
      '还没有语音发送记录。',
      `当前TTS: ${stats.provider}${stats.localReady ? '/local' : ''} send=${stats.sendMode} 克隆${stats.cloneEnabled ? (stats.cloneReady ? 'ready' : 'missing') : 'off'}`,
      ...(stats.lastMode ? [`最近TTS模式: ${stats.lastMode}`] : []),
      ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
    ].join('\n');
  }
  return [
    '最近语音 trace',
    `时间: ${formatTraceTime(trace.timestamp)}`,
    `会话: ${trace.chatType} ${trace.chatId}${trace.groupId ? ` / group ${trace.groupId}` : ''}`,
    `消息: mid=${trace.messageId} uid=${trace.userId}`,
    `模式: ${trace.mode}`,
    `请求文本: ${trace.requestedTextPreview || '[空]'}`,
    `实际念出: ${trace.spokenTextPreview || '[空]'}`,
    `分段: ${trace.sentParts}/${trace.parts}`,
    `TTS: ${trace.provider} send=${trace.sendMode}${trace.lastTtsMode ? ` mode=${trace.lastTtsMode}` : ''}`,
    trace.error ? `错误: ${trace.error}` : '',
    ...(stats.lastError && stats.lastError !== trace.error ? [`当前最近错误: ${stats.lastError}`] : []),
  ].filter(Boolean).join('\n');
}

function formatVoiceRecent(limit = 8): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, MAX_VOICE_TRACES));
  const traces = recentVoiceTraces.slice(0, safeLimit);
  if (traces.length === 0) {
    return [
      '语音最近记录',
      '最近: 无真实语音发送 trace',
      '说明: 只记录直读、AI转语音和被动语音的真实发送尝试；/voice check/cache/warm/stt 是诊断命令，不写入这里。',
    ].join('\n');
  }
  return [
    `语音最近记录 ${traces.length}/${recentVoiceTraces.length}`,
    ...traces.map((trace, index) => {
      const time = new Date(trace.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const error = trace.error ? ` error=${trace.error.slice(0, 80)}` : '';
      const mode = trace.lastTtsMode ? ` mode=${trace.lastTtsMode}` : '';
      const spoken = trace.spokenTextPreview ? ` | ${trace.spokenTextPreview}` : '';
      return `${index + 1}. ${time} mid=${trace.messageId} uid=${trace.userId} ${trace.chatType}=${trace.chatId} ${trace.mode} parts=${trace.sentParts}/${trace.parts} tts=${trace.provider}/${trace.sendMode}${mode}${error}${spoken}`;
    }),
    '边界: 这里只读最近语音链路，方便排查直读/AI转语音、分段、TTS后端、发送兜底和失败原因。',
  ].join('\n');
}

function cloneReplyTrace(trace: ReplyTrace): ReplyTrace {
  return {
    ...trace,
    imageSourceKinds: trace.imageSourceKinds ? [...trace.imageSourceKinds] : undefined,
    imageSources: trace.imageSources ? [...trace.imageSources] : undefined,
    recordSourceKinds: trace.recordSourceKinds ? [...trace.recordSourceKinds] : undefined,
    recordSources: trace.recordSources ? [...trace.recordSources] : undefined,
    memoryFilterReasons: trace.memoryFilterReasons ? [...trace.memoryFilterReasons] : undefined,
    memoryPreview: trace.memoryPreview ? [...trace.memoryPreview] : undefined,
    searchEvidence: trace.searchEvidence ? [...trace.searchEvidence] : undefined,
    knowledgeTitles: [...trace.knowledgeTitles],
    knowledgeLanes: trace.knowledgeLanes ? [...trace.knowledgeLanes] : undefined,
    knowledgeFreshnessIssues: trace.knowledgeFreshnessIssues ? [...trace.knowledgeFreshnessIssues] : undefined,
    styleSceneSignals: trace.styleSceneSignals ? [...trace.styleSceneSignals] : undefined,
    qualityIssues: trace.qualityIssues ? [...trace.qualityIssues] : undefined,
    evidenceSummary: trace.evidenceSummary ? [...trace.evidenceSummary] : undefined,
    evidenceLedger: trace.evidenceLedger ? [...trace.evidenceLedger] : undefined,
    realtimeFreshness: trace.realtimeFreshness ? [...trace.realtimeFreshness] : undefined,
    visionDataInfo: trace.visionDataInfo ? [...trace.visionDataInfo] : undefined,
    visionCacheBefore: trace.visionCacheBefore ? [...trace.visionCacheBefore] : undefined,
    visionCacheAfter: trace.visionCacheAfter ? [...trace.visionCacheAfter] : undefined,
  };
}

function rememberReplyTrace(trace: ReplyTrace): void {
  const snapshot = cloneReplyTrace(trace);
  const index = recentReplyTraces.findIndex((item) => (
    item.messageId === trace.messageId
    && item.chatType === trace.chatType
    && item.chatId === trace.chatId
  ));
  if (index >= 0) {
    recentReplyTraces[index] = snapshot;
  } else {
    recentReplyTraces.unshift(snapshot);
  }
  if (recentReplyTraces.length > MAX_REPLY_TRACES) recentReplyTraces.length = MAX_REPLY_TRACES;
}

function shouldRememberVisionTrace(trace: ReplyTrace): boolean {
  return trace.hasImages || trace.visionPayload || !!trace.visionError;
}

function rememberVisionTrace(trace: ReplyTrace): void {
  if (!shouldRememberVisionTrace(trace)) return;
  const snapshot = cloneReplyTrace(trace);
  const index = recentVisionTraces.findIndex((item) => (
    item.messageId === trace.messageId
    && item.chatType === trace.chatType
    && item.chatId === trace.chatId
  ));
  if (index >= 0) {
    recentVisionTraces[index] = snapshot;
  } else {
    recentVisionTraces.unshift(snapshot);
  }
  if (recentVisionTraces.length > MAX_VISION_TRACES) recentVisionTraces.length = MAX_VISION_TRACES;
}

function rememberVoiceTrace(trace: VoiceTrace | null): void {
  if (!trace) return;
  const snapshot = { ...trace };
  const index = recentVoiceTraces.findIndex((item) => (
    item.messageId === trace.messageId
    && item.chatType === trace.chatType
    && item.chatId === trace.chatId
  ));
  if (index >= 0) {
    recentVoiceTraces[index] = snapshot;
  } else {
    recentVoiceTraces.unshift(snapshot);
  }
  if (recentVoiceTraces.length > MAX_VOICE_TRACES) recentVoiceTraces.length = MAX_VOICE_TRACES;
}

function setReplyTrace(trace: ReplyTrace): void {
  lastReplyTrace = trace;
  rememberReplyTrace(trace);
  rememberVisionTrace(trace);
}

function rememberTraceMessage(seen: Set<number>, messageId: number, max = 1000): boolean {
  if (seen.has(messageId)) return false;
  seen.add(messageId);
  while (seen.size > max) {
    const first = seen.values().next().value;
    if (first === undefined) break;
    seen.delete(first);
  }
  return true;
}

function patchReplyTrace(messageId: number, patch: Partial<ReplyTrace>): void {
  if (!lastReplyTrace || lastReplyTrace.messageId !== messageId) return;
  const hasEvidencePatch =
    Array.isArray(patch.evidenceSummary)
    || Array.isArray(patch.searchEvidence)
    || typeof patch.realtimeIntent === 'boolean'
    || typeof patch.realtimeDataAvailable === 'boolean';
  if (hasEvidencePatch && rememberTraceMessage(evidenceTraceMessages, messageId)) {
    evidenceTraceCount++;
  }
  if (patch.evidenceSummary && patch.evidenceSummary.length > 0) {
    lastEvidenceSummary = patch.evidenceSummary.slice(0, 8);
  }
  const shouldRefreshEvidenceLedger = hasEvidencePatch
    || Array.isArray(patch.knowledgeFreshnessIssues)
    || Array.isArray(patch.memoryFilterReasons)
    || typeof patch.memoryHits === 'number'
    || typeof patch.memoryFiltered === 'number'
    || typeof patch.userProfileInjected === 'boolean'
    || typeof patch.visionPayload === 'boolean'
    || typeof patch.recordTranscripts === 'number'
    || typeof patch.factGuard === 'string'
    || typeof patch.freshnessRepair === 'string';
  if (patch.realtimeFreshness && patch.realtimeFreshness.length > 0) {
    lastRealtimeFreshness = patch.realtimeFreshness.slice(0, 8);
  }
  if (patch.realtimeStaleEvidence === true && rememberTraceMessage(realtimeStaleMessages, messageId)) {
    realtimeStaleEvidenceCount++;
  }
  if (patch.styleScene && rememberTraceMessage(styleSceneMessages, messageId)) {
    styleSceneTraceCount++;
    lastStyleScene = patch.styleScene;
    lastStyleSceneAction = patch.styleSceneAction || '';
    styleSceneCounts.set(patch.styleScene, (styleSceneCounts.get(patch.styleScene) || 0) + 1);
    recentStyleScenes.push(patch.styleScene);
    while (recentStyleScenes.length > 20) recentStyleScenes.shift();
  } else if (patch.styleScene) {
    lastStyleScene = patch.styleScene;
    lastStyleSceneAction = patch.styleSceneAction || lastStyleSceneAction;
  }
  if (typeof patch.qualityFinalOk === 'boolean') {
    lastQualityFinalOk = patch.qualityFinalOk;
  }
  if (patch.qualityIssues && patch.qualityIssues.length > 0) {
    lastQualityIssues = patch.qualityIssues.slice(0, 8);
    if (rememberTraceMessage(qualityIssueMessages, messageId)) {
      qualityIssueTraceCount++;
    }
  }
  if (patch.realtimeIntent === true && patch.realtimeDataAvailable === false && rememberTraceMessage(realtimeMissingMessages, messageId)) {
    realtimeIntentWithoutDataCount++;
  }
  if (patch.factGuard && rememberTraceMessage(factGuardMessages, messageId)) {
    factGuardRepairCount++;
    lastFactGuard = patch.factGuard;
  }
  if (patch.outputRepair) {
    outputRepairCount++;
    if (/quality/i.test(patch.outputRepair)) qualityRepairCount++;
  }
  if (patch.freshnessRepair && rememberTraceMessage(freshnessRepairMessages, messageId)) {
    freshnessRepairCount++;
  }
  if (patch.cachePolicy && rememberTraceMessage(replyCachePolicyMessages, messageId)) {
    replyCachePolicyCounts.set(patch.cachePolicy, (replyCachePolicyCounts.get(patch.cachePolicy) || 0) + 1);
  }
  if (patch.cachePolicy && /^off\b/.test(patch.cachePolicy) && rememberTraceMessage(replyCacheBypassMessages, messageId)) {
    replyCacheBypasses++;
  }
  const freshnessRepair = patch.freshnessRepair && lastReplyTrace.freshnessRepair
    ? `${lastReplyTrace.freshnessRepair}; ${patch.freshnessRepair}`
    : patch.freshnessRepair || lastReplyTrace.freshnessRepair;
  lastReplyTrace = { ...lastReplyTrace, ...patch, freshnessRepair, timestamp: Date.now() };
  if (shouldRefreshEvidenceLedger) {
    lastReplyTrace.evidenceLedger = buildEvidenceLedger(lastReplyTrace);
    lastEvidenceLedger = lastReplyTrace.evidenceLedger.slice(0, 8);
  }
  rememberReplyTrace(lastReplyTrace);
  rememberVisionTrace(lastReplyTrace);
}

function replyCacheKeyPrefix(key: string): string {
  return key ? key.slice(0, 8) : '';
}

function appendReplyCacheDecision(messageId: number, part: string, key?: string): void {
  if (!part || !lastReplyTrace || lastReplyTrace.messageId !== messageId) return;
  const compactPart = part.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!compactPart) return;
  const previous = lastReplyTrace.cacheDecision
    ? lastReplyTrace.cacheDecision.split('; ').filter(Boolean)
    : [];
  if (previous[previous.length - 1] !== compactPart) {
    previous.push(compactPart);
  }
  const cacheKeyPrefix = key ? replyCacheKeyPrefix(key) : lastReplyTrace.cacheKeyPrefix;
  patchReplyTrace(messageId, {
    cacheDecision: previous.slice(-6).join('; '),
    cacheKeyPrefix,
  });
}

function getAiRuntimeGeneration(): number {
  return aiRuntimeGeneration;
}

function isRuntimeGenerationStale(generation: number): boolean {
  return generation !== aiRuntimeGeneration;
}

function isReplyJobStale(job: ReplyJob): boolean {
  return isRuntimeGenerationStale(job.generation);
}

function markReplyJobStale(job: ReplyJob, stage: string): void {
  patchReplyTrace(job.messageId, {
    sent: 'skipped',
    error: `stale runtime after ${stage}`,
  });
}

function shouldAbortStaleReplyJob(job: ReplyJob, stage: string): boolean {
  if (!isReplyJobStale(job)) return false;
  markReplyJobStale(job, stage);
  return true;
}

function extractReplyOpener(text: string): string {
  const normalized = sanitizeOutgoingText(text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const first = normalized.split(/[，,。！？!?；;\s]/).find(Boolean) || normalized;
  return first.slice(0, 12);
}

function openerFamily(opener: string): string {
  const key = opener.toLowerCase().replace(/[\s，,。！？!?；;、]/g, '');
  if (!key) return '';
  if (/^(?:不是哥们|哥们|兄弟们?|家人们|老哥|兄弟)$/.test(key)) return 'address';
  if (/^(?:先别急|等一下|等等|先等等|别急|稍等)$/.test(key)) return 'pause';
  if (/^(?:讲道理|说实话|有一说一|确实|怎么说|我只能说)$/.test(key)) return 'hedge';
  if (/^(?:可以|可以的|有点东西|这波|这波有说法|有说法|有点抽象)$/.test(key)) return 'catchphrase';
  if (/^(?:我看|看了一眼|简单说两句|先说正事)$/.test(key)) return 'assistanty';
  return '';
}

function shouldDedupeOpener(before: string, recent: string[]): boolean {
  if (!before) return false;
  const family = openerFamily(before);
  const repeatedExact = recent.includes(before);
  const repeatedFamily = !!family && recent.some((item) => openerFamily(item) === family);
  return (repeatedExact || repeatedFamily) && /^(?:可以(?:的)?|这波(?:有说法)?|有点东西|有一说一|先别急|等一下|等等|先等等|别急|讲道理|说实话|确实|怎么说|啊|我看|看了一眼|简单说两句|有点抽象|不是哥们|哥们|兄弟们?|家人们|老哥|兄弟|我只能说)$/.test(before);
}

function dedupeSessionOpener(sessionId: string, text: string): {
  text: string;
  before: string;
  after: string;
  deduped: boolean;
  recent: string[];
} {
  const recent = sessionRecentOpeners.get(sessionId) || [];
  const before = extractReplyOpener(text);
  let next = text;
  let deduped = false;
  if (shouldDedupeOpener(before, recent)) {
    const pattern = new RegExp(`^\\s*${before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[，,。!！?？\\s]*`);
    const stripped = next.replace(pattern, '').trimStart();
    if (stripped.length >= 2) {
      next = stripped;
      deduped = true;
    }
  }
  const after = extractReplyOpener(next);
  const updated = after ? [after, ...recent.filter((item) => item !== after)].slice(0, 3) : recent.slice(0, 3);
  sessionRecentOpeners.set(sessionId, updated);
  return { text: next, before, after, deduped, recent: updated };
}

/** 标准化 bot 回复用于全句去重比较 */
function normalizeForReplyDedup(text: string): string {
  return sanitizeOutgoingText(text)
    .toLowerCase()
    .replace(/\[(?:face|表情|emoji|qq)[:：]\d+\]/gi, '')
    .replace(/[\s，。！？,.!?；;、]/g, '')
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, '')
    .slice(0, 80);
}

function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (!shorter) return 0;
  if (longer.includes(shorter)) return shorter.length / Math.max(1, longer.length);
  const grams = new Set<string>();
  for (let i = 0; i <= shorter.length - 2; i++) grams.add(shorter.slice(i, i + 2));
  if (grams.size === 0) return shorter === longer ? 1 : 0;
  let hits = 0;
  for (let i = 0; i <= longer.length - 2; i++) {
    if (grams.has(longer.slice(i, i + 2))) hits++;
  }
  return hits / Math.max(1, grams.size);
}

/** 检查 bot 这句和最近 5 条是否重复 */
function isRecentReplyDuplicate(sessionId: string, text: string): boolean {
  const norm = normalizeForReplyDedup(text);
  if (!norm || norm.length < 6) return false;
  const recent = sessionRecentReplies.get(sessionId) || [];
  for (const past of recent) {
    if (!past) continue;
    // 完全相同 = 重复
    if (past === norm) return true;
    // 一方包含另一方 80% 以上 = 实质重复
    const shorter = past.length < norm.length ? past : norm;
    const longer = past.length < norm.length ? norm : past;
    if (shorter.length >= 8 && longer.includes(shorter)) return true;
    if (shorter.length >= 12 && similarityRatio(shorter, longer) >= 0.82) return true;
  }
  return false;
}

/** 记录 bot 最近回复 */
function recordRecentReply(sessionId: string, text: string): void {
  const norm = normalizeForReplyDedup(text);
  if (!norm) return;
  const recent = sessionRecentReplies.get(sessionId) || [];
  recent.unshift(norm);
  if (recent.length > 5) recent.length = 5;
  sessionRecentReplies.set(sessionId, recent);
}

function makeDirectVoiceReplyTrace(
  ctx: PluginContext,
  text: string,
  parts: number,
  sent: ReplyTrace['sent'] = 'queued',
  error?: string,
): ReplyTrace {
  return {
    timestamp: Date.now(),
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    groupId: ctx.groupId,
    userId: ctx.event.user_id,
    messageId: ctx.event.message_id,
    senderName: ctx.event.sender.card || ctx.event.sender.nickname,
    triggerReason: '直接语音照读',
    forced: true,
    command: ctx.command,
    rawTextPreview: previewText(ctx.rawText),
    effectiveTextPreview: previewText(text),
    hasImages: ctx.event.message.some((seg) => seg.type === 'image'),
    imageSources: traceWarmupSources(extractImageUrls(ctx.event.message)),
    hasRecords: ctx.event.message.some((seg) => seg.type === 'record'),
    recordInputCount: extractRecordUrls(ctx.event.message).length,
    recordSourceKinds: summarizeImageSourceKinds(extractRecordUrls(ctx.event.message)),
    recordSources: traceWarmupSources(extractRecordUrls(ctx.event.message)),
    recordTranscripts: 0,
    queueAgeMs: 0,
    searchUsed: false,
    searchChars: 0,
    searchEvidence: [],
    knowledgeInjected: false,
    knowledgeChars: 0,
    knowledgeTopic: false,
    knowledgeTitles: [],
    evidenceSummary: ['direct voice'],
    realtimeIntent: false,
    realtimeDataAvailable: false,
    visionPayload: false,
    voiceRequested: true,
    voiceMode: 'direct-verbatim',
    voiceParts: parts,
    sent,
    cacheHit: false,
    replyLength: text.length,
    error,
  };
}

function chooseRefreshSources(config: AIConfig, queryOverride: string, autoRun: boolean): KnowledgeSource[] {
  if (queryOverride.trim()) {
    return [{
      id: 'manual-query',
      query: queryOverride.trim(),
      sourceType: /HLTV|Liquipedia|排名|阵容|转会|赛程|比分/i.test(queryOverride) ? 'public_fact' : 'public_summary',
      trusted: false,
      autoCommitEligible: false,
      intervalMinutes: 720,
    }];
  }

  const configured = loadKnowledgeSources();
  const sources = configured.length > 0 ? configured : makeFallbackKnowledgeSources();
  const limit = autoRun
    ? (config.knowledge_auto_batch_max_sources || 4)
    : (config.knowledge_expansion_batch_max_sources || config.knowledge_manual_batch_max_sources || 12);
  return autoRun
    ? filterDueKnowledgeSources(sources, limit)
    : sources.slice(0, limit);
}

function summarizeRefreshResult(
  batchId: string,
  searched: number,
  candidates: number,
  committed: number,
  pending: KnowledgeCandidate[],
  failed: string[],
  auditIssues: number,
  autoRun: boolean,
): string {
  return [
    autoRun ? '知识库自动刷新完成' : '知识库刷新完成',
    `批次: ${batchId}`,
    `搜索源: ${searched}`,
    `候选: ${candidates}`,
    `自动写入: ${committed}`,
    `待确认: ${pending.length}`,
    `失败: ${failed.length}`,
    `审计问题: ${auditIssues}`,
    ...pending.slice(0, 5).map((item) => `候选 ${item.id}: ${item.title} (${item.risk}/${item.confidence}) 质量闸${describeKnowledgeCandidateQuality(item)}；${formatKnowledgeCandidateAdvice(item, 120)}`),
    ...failed.slice(0, 3).map((item) => `失败: ${item}`),
  ].join('\n');
}

async function runKnowledgeRefresh(
  config: AIConfig,
  queryOverride: string = '',
  autoRun: boolean = false,
  aggressiveOverride: boolean = false,
): Promise<string> {
  if (config.knowledge_update_mode === 'static') {
    return '知识库现在是 static 模式，只查不写候选。';
  }
  if (autoRun && (config.knowledge_auto_update === false || !isKnowledgeAutoEnabled())) {
    return '知识库自动更新当前关闭。';
  }

  const sources = chooseRefreshSources(config, queryOverride, autoRun);
  if (sources.length === 0) {
    markKnowledgeAutoRefresh();
    const audit = auditKnowledge();
    return [
      autoRun ? '知识库自动刷新跳过' : '知识库刷新跳过',
      '原因: 没有到期来源',
      `审计问题: ${audit.issues.length}`,
    ].join('\n');
  }
  const timeoutMs = config.knowledge_source_timeout_ms || config.search_timeout_ms || 1800;
  const cacheSeconds = config.search_cache_seconds ?? 300;
  const aggressive = aggressiveOverride || config.knowledge_aggressive_auto_commit !== false;
  const batchId = `${autoRun ? 'auto' : 'manual'}_${Date.now().toString(36)}`;
  const pending: KnowledgeCandidate[] = [];
  const failed: string[] = [];
  let searched = 0;
  let candidates = 0;
  let committed = 0;

  for (const source of sources) {
    try {
      searched++;
      const result = await webSearch(source.query, timeoutMs, cacheSeconds, config.search_negative_cache_seconds ?? 60);
      if (!result) {
        failed.push(`${source.id}: 无搜索结果`);
        continue;
      }

      const expansionEnabled = config.knowledge_expansion_enabled !== false;
      const sourceTypeWritable = source.sourceType === 'public_fact' || source.sourceType === 'public_summary' || source.sourceType === 'style_template';
      const trustedSummaryEligible = aggressive && source.trusted && source.sourceType === 'public_summary';
      const manualAggressiveEligible = aggressiveOverride && sourceTypeWritable;
      const autoCommitEligible = Boolean(
        expansionEnabled &&
        config.knowledge_auto_commit_public_facts !== false &&
        (
          (source.autoCommitEligible && source.sourceType === 'public_fact') ||
          (source.autoCommitEligible && trustedSummaryEligible) ||
          manualAggressiveEligible
        ),
      );
      const sourceHint = knowledgeSourceEvidenceHint(source.id);
      const candidate = previewKnowledgeCandidate(source.query, result, `refresh:${source.id}${sourceHint ? ` ${sourceHint}` : ''}`, {
        sourceType: source.sourceType,
        confidence: source.trusted ? 'high' : 'medium',
        autoCommitEligible,
        risk: 'review',
      });
      candidates++;

      const wasEligible = candidate.autoCommitEligible;
      const action = autoCommitKnowledgeCandidate(candidate, {
        batchId,
        maxBlockChars: config.knowledge_auto_max_block_chars || 1200,
      });
      if (action === 'committed') {
        committed++;
      } else if (candidate.status === 'dropped' && wasEligible) {
        // 重复内容已被去重丢弃，不算待确认。
      } else {
        pending.push(candidate);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${source.id}: ${message.slice(0, 80)}`);
    } finally {
      if (autoRun) markKnowledgeSourceRefreshed(source.id);
    }
  }

  markKnowledgeAutoRefresh();
  const audit = auditKnowledge();
  return summarizeRefreshResult(batchId, searched, candidates, committed, pending, failed, audit.issues.length, autoRun);
}

function ensureKnowledgeAutoTimer(config: AIConfig): void {
  configureGates({
    ai: config.ai_global_concurrency,
    search: config.search_global_concurrency,
    vision: config.vision_global_concurrency,
    tts: config.tts_global_concurrency,
    stt: config.stt_global_concurrency,
    passiveQueueMax: config.gate_passive_queue_max,
  });
  configureSearchCache(config);
  configureImageCache(config);
  knowledgeAutoConfig = config;
  const intervalMinutes = Math.max(30, config.knowledge_auto_interval_minutes || 180);
  if (knowledgeAutoTimer && intervalMinutes === knowledgeAutoIntervalMinutes) return;
  if (knowledgeAutoTimer) {
    clearInterval(knowledgeAutoTimer);
    knowledgeAutoTimer = null;
  }
  knowledgeAutoIntervalMinutes = intervalMinutes;
  knowledgeAutoTimer = setInterval(() => {
    const activeConfig = knowledgeAutoConfig;
    if (!activeConfig || activeConfig.knowledge_auto_update === false || !isKnowledgeAutoEnabled()) return;
    if (knowledgeAutoRunning) return;
    knowledgeAutoRunning = true;
    runKnowledgeRefresh(activeConfig, '', true)
      .then((summary) => console.log(`[KnowledgeAuto]\n${summary}`))
      .catch((err) => console.error('[KnowledgeAuto] 刷新失败:', err instanceof Error ? err.message : err))
      .finally(() => {
        knowledgeAutoRunning = false;
      });
  }, intervalMinutes * 60 * 1000);
  knowledgeAutoTimer.unref();
}

function ensureMaintenanceTimer(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    try {
      cleanReplyCache();
      cleanSearchCache();
      cleanImageCache();
      cleanVoiceCache(knowledgeAutoConfig || undefined);
      cleanSttCache(knowledgeAutoConfig || undefined);
      auditKnowledge();
      pruneKnowledgeAutoLog(knowledgeAutoConfig?.knowledge_auto_log_retention_days || 14);
    } catch (err) {
      console.error('[Maintenance] 轻量自检失败:', err instanceof Error ? err.message : err);
    }
  }, 60 * 60 * 1000);
  maintenanceTimer.unref();
}

export function startAiChatBackgroundTasks(config: AIConfig): void {
  ensureKnowledgeAutoTimer(config);
  ensureMaintenanceTimer();

  // 启动后延迟 90 秒做一次知识库刷新，确保 bot 拿到的数据相对新
  // (避免和 NapCat 重连竞争资源，所以延迟 90s)
  if (config.knowledge_auto_update !== false && isKnowledgeAutoEnabled()) {
    setTimeout(() => {
      if (knowledgeAutoRunning) return;
      knowledgeAutoRunning = true;
      runKnowledgeRefresh(config, '', true)
        .then((summary) => console.log(`[KnowledgeAuto] 启动后首次刷新\n${summary}`))
        .catch((err) => console.error('[KnowledgeAuto] 启动刷新失败:', err instanceof Error ? err.message : err))
        .finally(() => {
          knowledgeAutoRunning = false;
        });
    }, 90 * 1000).unref();
  }

  // 启动后延迟 5 分钟开始预热选手图缓存。串行 8 秒间隔，避免限流。
  // 仅在缓存少于 10 张图时才跑，否则每次重启都重新拉浪费资源。
  setTimeout(() => {
    try {
      const stats = getImageCacheStats();
      if (stats.count >= 10) {
        console.log(`[Prewarm] 已有 ${stats.count} 张缓存图，跳过预热`);
        return;
      }
      console.log(`[Prewarm] 启动预热选手图(每张8秒间隔，全部完成约7分钟)...`);
      prewarmPlayerImages()
        .then((r) => console.log(`[Prewarm] 完成 成功${r.success} 失败${r.failed}`))
        .catch((err) => console.error('[Prewarm] 异常:', err instanceof Error ? err.message : err));
    } catch (err) {
      console.error('[Prewarm] 启动失败:', err instanceof Error ? err.message : err);
    }
  }, 5 * 60 * 1000).unref();
}

function includesAnyKeyword(text: string, keywords: string[] = []): boolean {
  if (!text || keywords.length === 0) return false;
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => keyword && lowerText.includes(keyword.toLowerCase()));
}

function isLowInformationPassiveText(text: string, config: AIConfig): boolean {
  const normalized = normalizePassiveText(text);
  if (!normalized) return true;
  const minChars = Math.max(1, config.passive_random_min_chars || 4);
  if (normalized.length < minChars) return true;
  if (config.passive_random_allow_numeric !== true && /^[\d.。,\s，、]+$/.test(normalized)) return true;
  if (/^[哈啊嗯哦额呃草艹wW6]+$/.test(normalized) && normalized.length <= 6) return true;
  if (/^[^\u4e00-\u9fa5A-Za-z0-9]+$/.test(normalized)) return true;
  return false;
}

function isCsDiscussionHint(text: string): boolean {
  const normalized = normalizePassiveText(text).toLowerCase();
  if (normalized.length < 4) return false;
  const hard = [
    'cs', 'cs2', 'csgo', 'major', 'blast', 'iem', 'esl', 'hltv',
    'navi', 'g2', 'faze', 'vitality', 'spirit', 'mouz', 'falcons', 'astralis',
    'niko', 'monesy', 'm0nesy', 'zywoo', 's1mple', 'donk', 'ropz', 'device',
  ];
  if (hard.some((item) => normalized.includes(item))) return true;
  const soft = [
    '这把', '这局', '回合', '残局', '手枪局', '长枪局', '强起', '半起', 'eco',
    '经济', '道具', '补枪', '默认', '控图', '转点', '回防', '保枪', '下包',
    '拆包', '钳子', 'timing', '首杀', '突破', '架枪', '狙', '步枪', '地图池',
    '香蕉道', '中路', '外场', '包点', 'a大', 'b点', 'ct', 't方',
    'mirage', 'inferno', 'nuke', 'ancient', 'anubis', 'dust2', 'overpass', 'train',
  ];
  let hits = 0;
  for (const item of soft) {
    if (normalized.includes(item.toLowerCase())) hits++;
    if (hits >= 1 && /(?:怎么打|打成|能赢|赢不了|输了|翻了|白给|犯病|抽象|残局|回防|经济|道具|补枪)/.test(normalized)) {
      return true;
    }
    if (hits >= 2) return true;
  }
  return false;
}

function isDirectChatCue(text: string): boolean {
  const normalized = normalizePassiveText(text).toLowerCase();
  if (!normalized || normalized.length > 80) return false;
  const names = ['玩机器', '机器', 'machinewjq', 'machine', '6657'];
  const hasName = names.some((name) => normalized.includes(name.toLowerCase()));
  const cuePattern = /(?:在吗|在不在|你在|出来|说句话|聊聊|你怎么看|怎么看|咋看|怎么说|评价|锐评|帮我|帮忙|想想|看看|能不能|可以不|懂不懂|你好|hello|hi|哥们)/i;
  if (hasName) return true;
  if (normalized.length <= 12 && /^(?:你好|hi|hello|在吗|在不在|出来|说句话|聊聊)$/.test(normalized)) return true;
  if (/^(?:你怎么看|怎么看|咋看|怎么说|帮我|帮忙|想想|看看|评价|锐评)/.test(normalized)) return true;
  return cuePattern.test(normalized) && /(你|bot|机器人|ai|机器|玩机器|6657)/i.test(normalized);
}

function isStableCsTacticalQuery(text: string): boolean {
  const normalized = normalizePassiveText(text).toLowerCase();
  if (!normalized || normalized.length < 4) return false;
  if (!isCsDiscussionHint(normalized)) return false;
  if (/(?:最新|现在|当前|目前|今天|今日|今晚|最近|刚刚|昨天|上周|本周|这个月|今年|赛程|赛果|比分|排名|排行|阵容|转会|加入|离队|战绩|状态|表现|数据|rating|adr|kast|hltv|vrs|matchid|谁赢|哪场|哪队|哪个队|什么时候|几点|几号)/i.test(normalized)) {
    return false;
  }
  return /(?:残局|clutch|1v\d|一打|回防|拆包|下包|守包|补枪|道具|烟|闪|火|雷|utility|封烟|白闪|经济|eco|强起|半起|保枪|白给|默认|控图|转点|timing|架枪|突破|怎么打|怎么处理|打稳|稳一点|优势|被翻|开香槟|翻盘)/i.test(normalized);
}

function shouldSearch(config: AIConfig, text: string): boolean {
  if (!config.enable_search || text.length <= 3) return false;

  // 强制搜索的话题模式：任何疑问句 + 实时性 / 事实性 词汇
  // "现在/今天/最近/最新/谁/哪/是不是/几" + 任何主语
  const factualQueryPattern = /(?:现在|今天|最近|最新|当前|目前|今年|今晚|昨天|前天|上周|这周|本月|去年|刚才)[^。？\s]{0,15}(?:谁|哪|什么|怎么样|多少|几|有没有|是不是)|(?:谁|哪个|什么时候|多少|几比几|哪场|哪场|什么队|什么队伍|什么人)|(?:发生|爆发|开打|开赛|公布|更新|发布|确认|官宣|宣布)/;
  if (factualQueryPattern.test(text)) return true;
  if (isStableCsTacticalQuery(text)) return false;

  if (config.search_keywords && config.search_keywords.length > 0) {
    if (includesAnyKeyword(text, config.search_keywords)) return true;
  }
  if (config.search_on_style_query && isKnowledgeTopic(text)) return true;
  if (defaultSearchPattern.test(text)) return true;

  // CS / 选手 / 队伍 / 时事内容 → 强制搜索
  const importantTopics = /cs2|csgo|major|blast|iem|esl|pgl|cct|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|玩机器|6657|machinewjq|dust2|mirage|inferno|nuke|ancient|anubis|train|overpass|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|ropz|jl|b1t|hunter|aleksib|karrigan/i;
  if (importantTopics.test(text)) return true;

  return false;
}

async function sendVerbatimVoice(ctx: PluginContext, config: AIConfig, text: string, fallbackMessageId?: number, fallbackUserId?: number): Promise<boolean> {
  const generation = getAiRuntimeGeneration();
  const voiceTexts = splitVoiceTextForTts(text, config.tts_max_chars || 120);
  if (voiceTexts.length === 0) return false;
  setReplyTrace(makeDirectVoiceReplyTrace(ctx, text, voiceTexts.length));
  const voiceStatsBefore = getVoiceStats(config);
  lastVoiceTrace = {
    timestamp: Date.now(),
    mode: 'direct-verbatim',
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    groupId: ctx.groupId,
    userId: ctx.event.user_id,
    messageId: ctx.event.message_id,
    requestedTextPreview: previewText(text),
    spokenTextPreview: previewText(voiceTexts.join(' / ')),
    spokenTextWarm: voiceTexts.join(' / ').slice(0, 240),
    parts: voiceTexts.length,
    sentParts: 0,
    provider: voiceStatsBefore.provider,
    sendMode: voiceStatsBefore.sendMode,
    lastTtsMode: voiceStatsBefore.lastMode,
  };
  rememberVoiceTrace(lastVoiceTrace);
  if (!config.enable_tts) {
    const message = '语音没开，这句没法念';
    if (fallbackMessageId && fallbackUserId) ctx.replyQuoteTo(fallbackMessageId, fallbackUserId, message);
    else ctx.reply(message);
    const error = 'enable_tts=false';
    patchReplyTrace(ctx.event.message_id, { sent: 'fallback', error });
    lastVoiceTrace = { ...lastVoiceTrace, timestamp: Date.now(), error };
    rememberVoiceTrace(lastVoiceTrace);
    return true;
  }
  const ttsNeedsApi = (config.tts_provider || 'api') === 'api' || ((config.tts_provider || 'api') === 'auto' && !(config.tts_local_command || '').trim());
  if (ttsNeedsApi && !hasUsableApiKey(config.api_key)) {
    const message = '嗓子这边没接上，这句先发文字吧';
    if (fallbackMessageId && fallbackUserId) ctx.replyQuoteTo(fallbackMessageId, fallbackUserId, message);
    else ctx.reply(message);
    const error = 'api key missing';
    patchReplyTrace(ctx.event.message_id, { sent: 'fallback', error });
    lastVoiceTrace = { ...lastVoiceTrace, timestamp: Date.now(), error };
    rememberVoiceTrace(lastVoiceTrace);
    return true;
  }
  let sentAny = false;
  let sentParts = 0;
  let caughtError = '';
  try {
    for (const voiceText of voiceTexts) {
      const voicePath = await withGate('tts', () => generateVoice(config, voiceText), true);
      if (isRuntimeGenerationStale(generation)) {
        patchReplyTrace(ctx.event.message_id, { sent: 'skipped', error: 'stale runtime after direct tts' });
        lastVoiceTrace = { ...lastVoiceTrace, timestamp: Date.now(), error: 'stale runtime after direct tts' };
        rememberVoiceTrace(lastVoiceTrace);
        return true;
      }
      if (voicePath) {
        ctx.reply([voiceRecordSegment(config, voicePath)]);
        sentAny = true;
        sentParts++;
      }
    }
  } catch (err) {
    caughtError = err instanceof Error ? err.message : String(err);
  }
  const voiceStatsAfter = getVoiceStats(config);
  lastVoiceTrace = {
    ...lastVoiceTrace,
    timestamp: Date.now(),
    sentParts,
    provider: voiceStatsAfter.provider,
    sendMode: voiceStatsAfter.sendMode,
    lastTtsMode: voiceStatsAfter.lastMode,
    error: caughtError || voiceStatsAfter.lastError || undefined,
  };
  rememberVoiceTrace(lastVoiceTrace);
  if (sentAny) {
    patchReplyTrace(ctx.event.message_id, { sent: 'voice', voiceParts: sentParts, error: caughtError || undefined });
    return true;
  }
  if (isRuntimeGenerationStale(generation)) {
    patchReplyTrace(ctx.event.message_id, { sent: 'skipped', error: 'stale runtime after direct voice fallback' });
    return true;
  }
  const message = `语音生成失败 ${voiceTexts[0]}`;
  if (fallbackMessageId && fallbackUserId) ctx.replyQuoteTo(fallbackMessageId, fallbackUserId, message);
  else ctx.reply(message);
  patchReplyTrace(ctx.event.message_id, { sent: 'voice+text-fallback', error: caughtError || voiceStatsAfter.lastError || 'tts failed' });
  return true;
}

function shouldReply(
  config: AIConfig,
  text: string,
  command: string | null,
  atBot: boolean,
  replyToBot: boolean,
  isPrivate: boolean = false,
  groupChatBusy: boolean = false,
  selfRecentlyReplied: boolean = false,
): { reply: boolean; forced: boolean } {
  const directCommand = !!command && directAiCommands.has(command);
  if (directCommand || atBot || replyToBot || isPrivate || isExplicitVoiceReplyRequest(text, command)) {
    return { reply: true, forced: true };
  }
  if (command) {
    return { reply: false, forced: false };
  }

  // bot 自己刚回过话 30s 内：被动接话概率打 5 折；忙群只降低概率，不直接吞掉明显聊天。
  const selfCoolMultiplier = selfRecentlyReplied ? 0.5 : 1.0;
  const busyMultiplier = groupChatBusy ? 0.35 : 1.0;

  const styleKeywordHit = includesAnyKeyword(text, [
    config.active_preset,
    '玩机器',
    '机器',
    'MachineWJQ',
    'Machine',
    '6657',
  ]);
  const directChatCue = isDirectChatCue(text);
  if (styleKeywordHit || directChatCue) {
    return { reply: true, forced: false };
  }

  const keywordHit = includesAnyKeyword(text, config.trigger_keywords);
  if (keywordHit || isKnowledgeTopic(text)) {
    return { reply: Math.random() < (config.related_reply_probability ?? 0.65) * selfCoolMultiplier * busyMultiplier, forced: false };
  }
  if (isCsDiscussionHint(text) && !isLowInformationPassiveText(text, config)) {
    return { reply: Math.random() < (config.related_reply_probability ?? 0.65) * selfCoolMultiplier * busyMultiplier, forced: false };
  }

  switch (config.trigger_mode) {
    case 'all':
      return { reply: !isLowInformationPassiveText(text, config), forced: false };
    case 'smart': {
      if (isLowInformationPassiveText(text, config)) {
        return { reply: false, forced: false };
      }
      return { reply: Math.random() < (config.trigger_probability || 0) * selfCoolMultiplier * busyMultiplier, forced: false };
    }
    case 'at':
    case 'command':
    default:
      return { reply: false, forced: false };
  }
}

/** 记录群消息时间，返回该群是否处于"快速对话中"状态 */
function recordAndCheckBusy(sessionId: string, isPrivate: boolean): boolean {
  if (isPrivate) return false;
  const now = Date.now();
  const window = 30_000; // 30秒窗口
  const threshold = 3;   // 阈值：30秒内 >= 3 条人工消息 = 忙

  const list = recentGroupMessages.get(sessionId) || [];
  // 清理超出窗口的
  while (list.length > 0 && now - list[0] > window) {
    list.shift();
  }
  list.push(now);
  // 防止内存爆涨
  if (list.length > 50) list.splice(0, list.length - 50);
  recentGroupMessages.set(sessionId, list);
  return list.length >= threshold;
}

function getQueueStats(sessionId: string): { pending: number; forced: number; oldestCreatedAt: number } {
  return groupQueueStats.get(sessionId) || { pending: 0, forced: 0, oldestCreatedAt: 0 };
}

function normalizeCacheCharacters(text: string): string {
  return Array.from(text).map((char) => {
    const code = char.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    return char;
  }).join('');
}

function stripCacheAddressPrefix(text: string): string {
  let next = text;
  for (let i = 0; i < 3; i++) {
    const before = next;
    next = next
      .replace(/^\s*(?:(?:@|＠)\s*)?(?:机器人|bot|qqbot|小助手|玩机器|机器|machinewjq|machine|6657)(?=$|[\s,，:：、.!！?？\-])[\s,，:：、.!！?？\-]*/i, '')
      .replace(/^\s*(?:@|＠)[A-Za-z0-9_\-\u4e00-\u9fa5]{1,24}(?=$|[\s,，:：、.!！?？\-])[\s,，:：、.!！?？\-]*/i, '');
    if (next === before) break;
  }
  return next;
}

function normalizeCacheText(text: string): string {
  const normalized = stripCacheAddressPrefix(normalizeCacheCharacters(text)
    .replace(/\[CQ:at,[^\]]+\]/gi, ' ')
    .replace(/[\u00a0\u3000]/g, ' ')
    .trim())
    .replace(/[？?]+/g, '?')
    .replace(/[！!]+/g, '!')
    .replace(/[。\.]{2,}/g, '.')
    .replace(/[，,]{2,}/g, ',')
    .replace(/、{2,}/g, '、')
    .replace(/[；;]{2,}/g, ';')
    .replace(/\s+/g, ' ')
    .replace(/[\s,，:：、.!！?？;；\-]+$/g, '')
    .trim()
    .toLowerCase();
  return normalized.slice(0, 500);
}

function makeStableKnowledgeSignature(styleKnowledge: string, topicKnowledge: string, knowledgeTitles: string[]): string {
  return [
    knowledgeTitles.join('|'),
    normalizeForReplyDedup(styleKnowledge).slice(0, 160),
    normalizeForReplyDedup(topicKnowledge).slice(0, 220),
  ].join('\n');
}

function makeReplyCacheKey(config: AIConfig, text: string, knowledgeSignature: string, cacheScope: string = ''): string {
  return crypto
    .createHash('sha1')
    .update([
      config.model,
      config.active_preset,
      config.persona_mode || '',
      config.aggression_level || '',
      cacheScope,
      normalizeCacheText(text),
      knowledgeSignature.slice(0, 500),
    ].join('\n'))
    .digest('hex')
    .slice(0, 24);
}

function getCachedReply(key: string): string | null {
  const cached = replyCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    replyCache.delete(key);
    return null;
  }
  replyCache.delete(key);
  replyCache.set(key, cached);
  replyCacheHits++;
  return cached.value;
}

function clampReplyCacheMaxEntries(value?: number): number {
  const next = Math.floor(Number(value) || 300);
  return Math.max(20, Math.min(5000, Number.isFinite(next) ? next : 300));
}

function pruneReplyCache(maxEntries: number = replyCacheMaxEntries): void {
  const safeMax = clampReplyCacheMaxEntries(maxEntries);
  const now = Date.now();
  for (const [key, cached] of replyCache) {
    if (cached.expiresAt <= now) replyCache.delete(key);
  }
  while (replyCache.size > safeMax) {
    const oldest = replyCache.keys().next().value;
    if (!oldest) break;
    replyCache.delete(oldest);
  }
}

function setCachedReply(key: string, value: string, ttlSeconds: number, maxEntries?: number): void {
  if (ttlSeconds <= 0 || !value) return;
  replyCacheMaxEntries = clampReplyCacheMaxEntries(maxEntries ?? replyCacheMaxEntries);
  pruneReplyCache(replyCacheMaxEntries - 1);
  replyCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  pruneReplyCache(replyCacheMaxEntries);
}

function isReplyReusableForCache(text: string, job: ReplyJob): boolean {
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  if (!compact) return false;
  if (job.senderName && job.senderName.length >= 2 && compact.includes(job.senderName.replace(/\s+/g, ''))) return false;
  if (job.groupId && compact.includes(String(job.groupId))) return false;
  if (compact.includes(String(job.userId)) || compact.includes(String(job.messageId))) return false;
  if (/(?:你刚才|你上一句|上面那句|前面那条|刚刚你|这个人|他刚才|她刚才)/.test(text)) return false;
  return true;
}

function getInFlightReply(key: string): Promise<InFlightReplyResult> | null {
  const pending = replyInFlight.get(key);
  if (!pending) return null;
  replyCacheHits++;
  return pending;
}

function setInFlightReply(key: string, pending: Promise<InFlightReplyResult>): void {
  const tracked = pending.finally(() => {
    if (replyInFlight.get(key) === tracked) {
      replyInFlight.delete(key);
    }
  });
  replyInFlight.set(key, tracked);
}

function cleanReplyCache(): void {
  const now = Date.now();
  pruneReplyCache(replyCacheMaxEntries);
  // 清理一小时前的lastReplyAt
  const oneHourAgo = now - 3600 * 1000;
  for (const [key, ts] of lastReplyAt) {
    if (ts < oneHourAgo) lastReplyAt.delete(key);
  }
  // 清理 recentGroupMessages 中过期/空的会话
  for (const [key, list] of recentGroupMessages) {
    while (list.length > 0 && now - list[0] > 60_000) list.shift();
    if (list.length === 0) recentGroupMessages.delete(key);
  }
  // 清理 sessionRecentOpeners 太长的记录
  if (sessionRecentOpeners.size > 200) {
    const keys = [...sessionRecentOpeners.keys()].slice(0, sessionRecentOpeners.size - 200);
    for (const key of keys) sessionRecentOpeners.delete(key);
  }
  // 清理 sessionRecentReplies 太长的记录
  if (sessionRecentReplies.size > 200) {
    const keys = [...sessionRecentReplies.keys()].slice(0, sessionRecentReplies.size - 200);
    for (const key of keys) sessionRecentReplies.delete(key);
  }
  // 清理 groupQueueAges 太多
  if (groupQueueAges.size > 200) {
    const keys = [...groupQueueAges.keys()].slice(0, groupQueueAges.size - 200);
    for (const key of keys) groupQueueAges.delete(key);
  }
}

async function enqueueGroupTask(job: ReplyJob, task: () => Promise<void>): Promise<void> {
  const sessionId = job.sessionId;
  const stats = getQueueStats(sessionId);
  const ages = groupQueueAges.get(sessionId) || [];
  ages.push(job.createdAt);
  groupQueueAges.set(sessionId, ages);
  groupQueueStats.set(sessionId, {
    pending: stats.pending + 1,
    forced: stats.forced + (job.forced ? 1 : 0),
    oldestCreatedAt: stats.oldestCreatedAt ? Math.min(stats.oldestCreatedAt, job.createdAt) : job.createdAt,
  });

  const previous = groupQueues.get(sessionId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (shouldAbortStaleReplyJob(job, 'queue start')) return;
    await task();
  });
  groupQueues.set(sessionId, current);
  try {
    await current;
  } finally {
    const nextStats = getQueueStats(sessionId);
    const pending = Math.max(0, nextStats.pending - 1);
    const forced = Math.max(0, nextStats.forced - (job.forced ? 1 : 0));
    const ages = groupQueueAges.get(sessionId) || [];
    if (ages.length > 0) ages.shift();
    const oldestCreatedAt = ages[0] || 0;
    if (pending === 0 && forced === 0) {
      groupQueueStats.delete(sessionId);
      groupQueueAges.delete(sessionId);
    } else {
      groupQueueStats.set(sessionId, { pending, forced, oldestCreatedAt });
      groupQueueAges.set(sessionId, ages);
    }
    if (groupQueues.get(sessionId) === current) {
      groupQueues.delete(sessionId);
    }
  }
}

export function shutdownAiChat(): void {
  aiRuntimeGeneration++;
  if (knowledgeAutoTimer) {
    clearInterval(knowledgeAutoTimer);
    knowledgeAutoTimer = null;
    knowledgeAutoIntervalMinutes = 0;
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (contextManager) {
    contextManager.shutdown();
  } else {
    flushNow();
  }
  groupQueues.clear();
  groupQueueStats.clear();
  groupQueueAges.clear();
  lastReplyAt.clear();
  recentGroupMessages.clear();
  sessionRecentOpeners.clear();
  sessionRecentReplies.clear();
  replyCache.clear();
  replyInFlight.clear();
  replyCacheHits = 0;
  replyCacheMisses = 0;
  replyCacheBypasses = 0;
  compressionInFlight.clear();
  evidenceTraceCount = 0;
  realtimeIntentWithoutDataCount = 0;
  realtimeStaleEvidenceCount = 0;
  factGuardRepairCount = 0;
  qualityRepairCount = 0;
  freshnessRepairCount = 0;
  outputRepairCount = 0;
  styleSceneTraceCount = 0;
  qualityIssueTraceCount = 0;
  lastFactGuard = '';
  lastEvidenceSummary = [];
  lastEvidenceLedger = [];
  lastRealtimeFreshness = [];
  lastStyleScene = '';
  lastStyleSceneAction = '';
  lastQualityIssues = [];
  lastQualityFinalOk = undefined;
  evidenceTraceMessages.clear();
  realtimeMissingMessages.clear();
  realtimeStaleMessages.clear();
  factGuardMessages.clear();
  freshnessRepairMessages.clear();
  replyCacheBypassMessages.clear();
  replyCachePolicyMessages.clear();
  styleSceneMessages.clear();
  qualityIssueMessages.clear();
  styleSceneCounts.clear();
  replyCachePolicyCounts.clear();
  recentStyleScenes.length = 0;
  recentReplyTraces.length = 0;
  recentVisionTraces.length = 0;
  recentVoiceTraces.length = 0;
  resetGates();
  closeKnowledgeDb();
}

export function getAiChatStats(): {
  sessions: number;
  queuedGroups: number;
  pendingJobs: number;
  forcedJobs: number;
  oldestQueueAgeMs: number;
  skippedPassiveReplies: number;
  replyCacheEntries: number;
  replyCacheMaxEntries: number;
  replyInFlight: number;
  replyCacheHits: number;
  replyCacheMisses: number;
  replyCacheBypasses: number;
  replyCachePolicyTop: string[];
  evidenceTraceCount: number;
  realtimeIntentWithoutDataCount: number;
  realtimeStaleEvidenceCount: number;
  factGuardRepairCount: number;
  qualityRepairCount: number;
  freshnessRepairCount: number;
  outputRepairCount: number;
  humanReplyDelayCount: number;
  humanReplyDelayAvgMs: number;
  lastHumanReplyDelayMs: number;
  styleSceneTraceCount: number;
  styleSceneTop: string[];
  recentStyleScenes: string[];
  lastStyleScene: string;
  lastStyleSceneAction: string;
  qualityIssueTraceCount: number;
  lastQualityIssues: string[];
  lastQualityFinalOk?: boolean;
  lastFactGuard: string;
  lastEvidenceSummary: string[];
  lastEvidenceLedger: string[];
  lastRealtimeFreshness: string[];
  gates: ReturnType<typeof getGateStats>;
  deferredCompressions: number;
  completedCompressions: number;
  failedCompressions: number;
  lastKnowledgeTitles: string[];
  lastOpenerDeduped: boolean;
  knowledgeAutoIntervalMinutes: number;
  knowledgeAutoRunning: boolean;
  memoryEnabled: boolean;
  memory: ReturnType<typeof getEmbeddingStats>;
} {
  let pendingJobs = 0;
  let forcedJobs = 0;
  let oldest = 0;
  for (const stats of groupQueueStats.values()) {
    pendingJobs += stats.pending;
    forcedJobs += stats.forced;
    if (stats.oldestCreatedAt && (!oldest || stats.oldestCreatedAt < oldest)) oldest = stats.oldestCreatedAt;
  }
  return {
    sessions: contextManager ? contextManager.getSessionCount() : 0,
    queuedGroups: groupQueues.size,
    pendingJobs,
    forcedJobs,
    oldestQueueAgeMs: oldest ? Date.now() - oldest : 0,
    skippedPassiveReplies,
    replyCacheEntries: replyCache.size,
    replyCacheMaxEntries,
    replyInFlight: replyInFlight.size,
    replyCacheHits,
    replyCacheMisses,
    replyCacheBypasses,
    replyCachePolicyTop: compactReplyCachePolicyStats(6),
    evidenceTraceCount,
    realtimeIntentWithoutDataCount,
    realtimeStaleEvidenceCount,
    factGuardRepairCount,
    qualityRepairCount,
    freshnessRepairCount,
    outputRepairCount,
    humanReplyDelayCount,
    humanReplyDelayAvgMs: humanReplyDelayCount > 0 ? Math.round(humanReplyDelayTotalMs / humanReplyDelayCount) : 0,
    lastHumanReplyDelayMs,
    styleSceneTraceCount,
    styleSceneTop: compactStyleSceneStats(6),
    recentStyleScenes: [...recentStyleScenes],
    lastStyleScene,
    lastStyleSceneAction,
    qualityIssueTraceCount,
    lastQualityIssues: [...lastQualityIssues],
    lastQualityFinalOk,
    lastFactGuard,
    lastEvidenceSummary: [...lastEvidenceSummary],
    lastEvidenceLedger: [...lastEvidenceLedger],
    lastRealtimeFreshness: [...lastRealtimeFreshness],
    gates: getGateStats(),
    deferredCompressions,
    completedCompressions,
    failedCompressions,
    lastKnowledgeTitles: lastReplyTrace?.knowledgeTitles || [],
    lastOpenerDeduped: lastReplyTrace?.openerDeduped === true,
    knowledgeAutoIntervalMinutes,
    knowledgeAutoRunning,
    memoryEnabled: contextManager ? contextManager.isMemoryEnabled() : knowledgeAutoConfig?.enable_memory_retrieval !== false,
    memory: getEmbeddingStats(),
  };
}

export function getMemoryDiagnostics(config: AIConfig, sessionId: string): {
  enabled: boolean;
  session: ReturnType<ContextManager['getSessionMeta']>;
  embeddings: ReturnType<typeof getEmbeddingStats>;
  injectMaxChars: number;
} {
  const cm = getContextManager(config);
  return {
    enabled: cm.isMemoryEnabled(),
    session: cm.getSessionMeta(sessionId),
    embeddings: getEmbeddingStats(),
    injectMaxChars: cm.getMemoryInjectMaxChars(),
  };
}

export function searchSessionMemory(
  config: AIConfig,
  sessionId: string,
  query: string,
  topK?: number,
): MemorySearchResult[] {
  const cm = getContextManager(config);
  return cm.retrieveSimilar(
    sessionId,
    query,
    topK ?? config.memory_top_k ?? 4,
    config.memory_min_similarity ?? 0.15,
  );
}

export function getRecentSessionMemory(
  config: AIConfig,
  sessionId: string,
  limit: number = 8,
): {
  context: Array<{ role: string; text: string }>;
  indexed: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>;
} {
  const cm = getContextManager(config);
  return {
    context: cm.getRecentMessages(sessionId, limit).map((message) => ({
      role: message.role,
      text: typeof message.content === 'string' ? message.content : '',
    })),
    indexed: cm.getRecentIndexedMessages(sessionId, limit),
  };
}

export function clearAiSessionMemory(sessionId: string): void {
  if (contextManager) {
    contextManager.clearSession(sessionId);
  } else {
    deleteSession(sessionId);
    clearSessionIndex(sessionId);
  }
  sessionRecentOpeners.delete(sessionId);
  sessionRecentReplies.delete(sessionId);
  lastReplyAt.delete(sessionId);
}

export function trimAiSessionMemory(
  config: AIConfig,
  sessionId: string,
  keepMessages: number,
): {
  contextBefore: number;
  contextAfter: number;
  summaryBeforeChars: number;
  summaryAfterChars: number;
  indexBefore: number;
  indexAfter: number;
} {
  const cm = getContextManager(config);
  const result = cm.trimSession(sessionId, keepMessages);
  sessionRecentOpeners.delete(sessionId);
  sessionRecentReplies.delete(sessionId);
  lastReplyAt.delete(sessionId);
  return result;
}

export function dropAiSessionMemoryByQuery(
  config: AIConfig,
  sessionId: string,
  query: string,
): {
  contextBefore: number;
  contextAfter: number;
  contextRemoved: number;
  summaryBeforeChars: number;
  summaryAfterChars: number;
  summaryDropped: boolean;
  indexBefore: number;
  indexAfter: number;
  indexRemoved: number;
  samples: Array<{ role: string; text: string; ts?: number }>;
} {
  const cm = getContextManager(config);
  const result = cm.dropSessionMemoryByQuery(sessionId, query);
  if (result.contextRemoved > 0 || result.indexRemoved > 0 || result.summaryDropped) {
    sessionRecentOpeners.delete(sessionId);
    sessionRecentReplies.delete(sessionId);
    lastReplyAt.delete(sessionId);
  }
  return result;
}

export function inspectAiSessionMemoryByUser(
  config: AIConfig,
  sessionId: string,
  userId: number,
): {
  contextTotal: number;
  contextMatched: number;
  summaryChars: number;
  indexTotal: number;
  indexMatched: number;
  samples: Array<{ role: string; text: string; ts?: number }>;
} {
  const cm = getContextManager(config);
  return cm.inspectSessionMemoryByUser(sessionId, userId);
}

export function dropAiSessionMemoryByUser(
  config: AIConfig,
  sessionId: string,
  userId: number,
): {
  contextBefore: number;
  contextAfter: number;
  contextRemoved: number;
  summaryBeforeChars: number;
  summaryAfterChars: number;
  summaryDropped: boolean;
  indexBefore: number;
  indexAfter: number;
  indexRemoved: number;
  samples: Array<{ role: string; text: string; ts?: number }>;
} {
  const cm = getContextManager(config);
  const result = cm.dropSessionMemoryByUser(sessionId, userId);
  if (result.contextRemoved > 0 || result.indexRemoved > 0 || result.summaryDropped) {
    sessionRecentOpeners.delete(sessionId);
    sessionRecentReplies.delete(sessionId);
    lastReplyAt.delete(sessionId);
  }
  return result;
}

export const aiChatPlugin: Plugin = {
  name: 'ai-chat',
  description: 'AI 智能对话 - 玩机器核心',

  handler: async (ctx) => {
    const config = ctx.bot.getConfig().ai;
    if (!config) return false;
    const apiReady = hasUsableApiKey(config.api_key) && !!config.api_url && !!config.model;

    ensureKnowledgeAutoTimer(config);
    ensureMaintenanceTimer();
    const cm = getContextManager(config);
    const sessionId = ctx.isPrivate
      ? `private_${ctx.event.user_id}`
      : `group_${ctx.groupId}`;

    // ===== 中文模糊命令分发 - 仅当不是显式 /xxx 命令时 =====
    const fuzzyCmd = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());
    const hasImageAttachment = ctx.event.message.some((seg) => seg.type === 'image');

    if (fuzzyCmd === 'media_status') {
      ctx.reply(formatMediaStatus(config, apiReady));
      return true;
    }

    if (fuzzyCmd === 'media_daily') {
      ctx.reply(formatMediaDaily(config, apiReady));
      return true;
    }

    if (fuzzyCmd === 'vision_status') {
      ctx.reply(await formatVisionStatusPanel(ctx, config, apiReady));
      return true;
    }

    if (fuzzyCmd === 'voice_status') {
      ctx.reply(formatVoiceStatusPanel(config, apiReady));
      return true;
    }

    if (fuzzyCmd === 'vision') {
      if (!hasImageAttachment) {
        ctx.reply('把图发来，我给你看。');
        return true;
      }
    }

    // ===== Voice Clone 模糊触发 =====
    if (fuzzyCmd === 'voice_clone' || fuzzyCmd === 'voice_clone_status' || fuzzyCmd === 'voice_clone_reset') {
      // 状态查询
      if (fuzzyCmd === 'voice_clone_status') {
        const stats = getVoiceStats(config);
        if (stats.cloneReady) {
          ctx.replyAt([
            '🎤 Voice Clone 已学好',
            `样本大小: ${stats.sampleSizeMB}MB`,
            VOICE_CLONE_BOUNDARY_LINE,
            '想换 → 直接发语音 + 学一下我的声音',
            '想清空 → 不用我的声音了 (需 admin)',
          ].join('\n'));
        } else {
          ctx.replyAt([
            '🎤 还没学过声音',
            `状态: ${stats.sampleReason || '未配置'}`,
            VOICE_CLONE_BOUNDARY_LINE,
            '发一段10-30秒的语音 + "学一下我的声音" 即可训练',
          ].join('\n'));
        }
        return true;
      }

      // 重置
      if (fuzzyCmd === 'voice_clone_reset') {
        if (!isAdmin(ctx)) {
          ctx.replyAt('⛔ 这操作只 admin 能用');
          return true;
        }
        const ok = removeVoiceSample(config);
        ctx.replyAt(ok ? '✅ 已清空 voice sample，回到默认 TTS' : '清空失败，可能没有样本');
        return true;
      }

      // 训练
      const recordSources = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
      if (recordSources.length === 0) {
        ctx.replyAt([
          '🎤 想让我学你的声音？',
          '发一段10-30秒的清晰语音，然后说 "学一下我的声音"',
          '建议是干净的人声，背景别太吵',
          VOICE_CLONE_BOUNDARY_LINE,
        ].join('\n'));
        return true;
      }
      ctx.replyAt('🎤 在下载学习中，稍等...');
      const result = await installVoiceSample(config, recordSources[0]);
      if (result.ok) {
        const sizeMB = ((result.size || 0) / 1024 / 1024).toFixed(2);
        ctx.replyAt([
          `✅ 学好了 你的声音 ${sizeMB}MB`,
          `格式: ${result.mime}`,
          VOICE_CLONE_BOUNDARY_LINE,
          '试试 /voice test 兄弟们好',
          '想换样本就再发一遍 + "学一下我的声音"',
        ].join('\n'));
      } else {
        ctx.replyAt(`❌ 学习失败: ${result.reason || '未知'}`);
      }
      return true;
    }

    // ===== 管理命令 =====
    if (ctx.command === 'reset' || ctx.command === 'clear') {
      clearAiSessionMemory(sessionId);
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
    if (await handleKnowledgeCommand(ctx, config)) {
      return true;
    }
    if (await handleLocalKnowledgeCommand(ctx, config)) {
      return true;
    }
    if (ctx.command === 'profile' || ctx.command === 'userprofile' || ctx.command === '画像' || ctx.command === '偏好') {
      ctx.reply(handleUserProfileCommand(ctx));
      return true;
    }
    if (ctx.command === 'trace') {
      const action = (ctx.args[0] || 'last').toLowerCase();
      if (action === 'last' || action === 'status') {
        ctx.reply(formatReplyTrace(lastReplyTrace));
        return true;
      }
      if (action === 'recent' || action === 'history' || action === 'list' || action === '最近' || action === '记录') {
        const limit = Number.parseInt(ctx.args[1] || '', 10);
        ctx.reply(formatReplyRecent(limit));
        return true;
      }
      ctx.reply('/trace last\n/trace recent [条数]');
      return true;
    }

    if (ctx.command === 'style' || ctx.command === 'human') {
      const action = (ctx.args[0] || 'status').toLowerCase();
      if (action === 'status' || action === 'last') {
        ctx.reply(formatStyleQualityStatus());
        return true;
      }
      if (action === 'check' || action === 'test' || action === '预检' || action === '检查') {
        const parsed = parseStyleCheckArgs(ctx.args);
        ctx.reply(formatStyleQualityPreflight(parsed.text, {
          hasRealtimeData: parsed.hasRealtimeData,
          forceVoice: parsed.forceVoice,
          evidenceText: parsed.evidenceText,
          config,
          apiReady,
        }));
        return true;
      }
      ctx.reply('/style status\n/style check <文本> [--realtime] [--voice]\n/style check <文本> || <证据/缓存行>');
      return true;
    }

    if (ctx.command && directMediaCommands.has(ctx.command)) {
      const rawSubCommand = ctx.args[0] || '';
      const subCommand = rawSubCommand.toLowerCase();
      if (!subCommand || subCommand === 'status' || subCommand === '状态' || subCommand === 'overview' || subCommand === '概览') {
        ctx.reply(formatMediaStatus(config, apiReady));
        return true;
      }
      if (subCommand === 'daily' || subCommand === 'today' || subCommand === 'day' || subCommand === '每日' || subCommand === '今日' || subCommand === '日签') {
        ctx.reply(formatMediaDaily(config, apiReady));
        return true;
      }
      if (subCommand === 'recent' || subCommand === 'history' || subCommand === 'list' || subCommand === '最近' || subCommand === '记录') {
        const limit = Number.parseInt(ctx.args[1] || '', 10);
        ctx.reply(formatMediaRecent(limit));
        return true;
      }
      if (subCommand === 'warm' || subCommand === 'prewarm' || subCommand === 'cache-warm' || subCommand === '预热' || subCommand === '暖缓存') {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const resolvedRecords = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        const parsed = extractMediaCheckSources(ctx.args.slice(1).join(' ').trim());
        ctx.reply(await formatMediaCacheWarm(
          config,
          uniqueNonEmpty([...parsed.images, ...resolvedImages]),
          uniqueNonEmpty([...parsed.records, ...resolvedRecords]),
          apiReady,
          (source) => withGate('vision', () => getImageDataUrl(source), true),
        ));
        return true;
      }
      if (subCommand === 'check' || subCommand === 'preview' || subCommand === 'dry-run' || subCommand === '预检' || subCommand === '检查') {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const resolvedRecords = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        const parsed = extractMediaCheckSources(ctx.args.slice(1).join(' ').trim());
        ctx.reply(formatMediaPreflight(
          config,
          uniqueNonEmpty([...parsed.images, ...resolvedImages]),
          uniqueNonEmpty([...parsed.records, ...resolvedRecords]),
          apiReady,
        ));
        return true;
      }
      const directSources = extractMediaCheckSources(ctx.args.join(' ').trim());
      if (directSources.images.length > 0 || directSources.records.length > 0) {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const resolvedRecords = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        ctx.reply(formatMediaPreflight(
          config,
          uniqueNonEmpty([...directSources.images, ...resolvedImages]),
          uniqueNonEmpty([...directSources.records, ...resolvedRecords]),
          apiReady,
        ));
        return true;
      }
      ctx.reply('/media status\n/media daily\n/media recent [条数]\n/media check <图片URL/语音URL或附图附语音>\n/media warm <图片URL/语音URL或附图附语音>\ncheck/daily只读；warm会预热图片缓存，语音只做STT缓存预检。');
      return true;
    }

    // ===== 识图/图片缓存诊断 =====
    if (ctx.command && directVisionCommands.has(ctx.command)) {
      const subCommand = (ctx.args[0] || '').toLowerCase();
      if (subCommand === 'last') {
        ctx.reply(formatVisionOnlyTrace(lastReplyTrace));
        return true;
      }
      if (subCommand === 'recent' || subCommand === 'history' || subCommand === 'list' || subCommand === '最近' || subCommand === '记录') {
        const limit = Number.parseInt(ctx.args[1] || '', 10);
        ctx.reply(formatVisionRecent(limit));
        return true;
      }
      if (!subCommand || subCommand === 'status' || subCommand === '状态' || subCommand === '诊断' || subCommand === '体检') {
        ctx.reply(await formatVisionStatusPanel(ctx, config, apiReady));
        return true;
      }
      if (subCommand === 'check' || subCommand === 'preview' || subCommand === 'dry-run' || subCommand === '预检' || subCommand === '检查') {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const textSources = extractVisionCheckSources(ctx.args.slice(1).join(' ').trim());
        const sources = uniqueNonEmpty([...textSources, ...resolvedImages]);
        ctx.reply(formatVisionPreflight(config, sources, apiReady));
        return true;
      }
      if (subCommand === 'warm' || subCommand === 'prewarm' || subCommand === 'cache-warm' || subCommand === '预热' || subCommand === '暖缓存') {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const textSources = extractVisionCheckSources(ctx.args.slice(1).join(' ').trim());
        const sources = uniqueNonEmpty([...textSources, ...resolvedImages]);
        ctx.reply(await formatVisionCacheWarm(config, sources, (source) => withGate('vision', () => getImageDataUrl(source), true)));
        return true;
      }
      if (subCommand === 'test') {
        const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        const url = ctx.args.slice(1).join(' ').trim() || resolvedImages[0] || '';
        if (!url) {
          ctx.reply('/vision test <图片URL>\n也可以把图片和 /vision test 发在同一条消息里');
          return true;
        }
        if (!config.enable_vision) {
          ctx.reply('识图没开，先把 enable_vision 打开。');
          return true;
        }
        if (!apiReady) {
          ctx.reply('AI接口没配，识图模型现在打不出去。');
          return true;
        }
        const sourceKind = classifyImageSource(url);
        const cacheBefore = inspectImageCacheSources([url], 1)[0];
        const dataUrl = await withGate('vision', () => getImageDataUrl(url));
        const nextStats = getImageCacheStats();
        const cacheAfterDownload = inspectImageCacheSources([url], 1)[0];
        if (!dataUrl) {
          ctx.reply([
            '识图链路测试失败',
            `图片源: ${sourceKind}`,
            cacheBefore ? `缓存前: ${cacheBefore.status} ${cacheBefore.reason.slice(0, 80)}` : '缓存前: 无',
            cacheAfterDownload ? `缓存后: ${cacheAfterDownload.status} ${cacheAfterDownload.reason.slice(0, 80)}` : '缓存后: 无',
            `下载: FAIL ${nextStats.lastError || 'unknown'}`,
            '边界: 下载失败时模型实际看不到图片，不能描述图片细节。',
          ].join('\n'));
          return true;
        }
        const dataInfo = describeDataUrl(dataUrl);
        try {
          const result = await withGate('vision', () => callLLMWithRetry(config, [
            { role: 'system', content: '你是识图链路测试器。只用一句中文描述图片里最明显的可见内容，句末加句号；看不清就明确说看不清，不要编造。' },
            {
              role: 'user',
              content: [
                { type: 'text', text: '请确认你能看到这张图，并描述最明显的可见内容。' },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
              ],
            },
          ], true, 1));
          const cleaned = postProcessReply(result).slice(0, 220);
          ctx.reply([
            '识图链路测试',
            `图片源: ${sourceKind}`,
            `下载: OK ${dataInfo}`,
            cacheBefore ? `缓存前: ${cacheBefore.status} ${cacheBefore.reason.slice(0, 80)}` : '缓存前: 无',
            cacheAfterDownload ? `缓存后: ${cacheAfterDownload.status} ${cacheAfterDownload.reason.slice(0, 80)}` : '缓存后: 无',
            `模型: ${config.vision_model || config.model || '未配置'}`,
            `payload: ${config.vision_payload_mode || 'auto'}`,
            '调用: OK',
            `判定: ${looksLikeVisibleVisionDescription(cleaned) ? '模型返回了可见描述' : '模型返回偏空/像没看图，需要检查模型是否支持视觉'}`,
            `描述: ${cleaned || '空'}`,
            '边界: 缓存 hit 只代表图片文件可复用；下载 OK 且调用 OK 才代表本次模型拿到了图片输入。',
          ].join('\n'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.reply([
            '识图链路测试失败',
            `图片源: ${sourceKind}`,
            `下载: OK ${dataInfo}`,
            cacheBefore ? `缓存前: ${cacheBefore.status} ${cacheBefore.reason.slice(0, 80)}` : '缓存前: 无',
            cacheAfterDownload ? `缓存后: ${cacheAfterDownload.status} ${cacheAfterDownload.reason.slice(0, 80)}` : '缓存后: 无',
            `模型: ${config.vision_model || config.model || '未配置'}`,
            `payload: ${config.vision_payload_mode || 'auto'}`,
            `调用: FAIL ${message.slice(0, 160)}`,
            '边界: 图片已下载不等于模型看懂；模型调用失败时不能把缓存命中说成已识图。',
          ].join('\n'));
        }
        return true;
      }
      ctx.reply('/vision status\n/vision recent [条数]\n/vision check <图片URL或附图>\n/vision warm <图片URL或附图>\n/vision last\n/vision test <图片URL>');
      return true;
    }

    // ===== 直接语音命令 =====
    if (ctx.command && directTtsCommands.has(ctx.command)) {
      const subCommand = (ctx.args[0] || '').toLowerCase();
      if (subCommand === 'last') {
        ctx.reply(formatVoiceTrace(lastVoiceTrace, config));
        return true;
      }
      if (subCommand === 'recent' || subCommand === 'history' || subCommand === 'list' || subCommand === '最近' || subCommand === '记录') {
        const limit = Number.parseInt(ctx.args[1] || '', 10);
        ctx.reply(formatVoiceRecent(limit));
        return true;
      }
      if (subCommand === 'status' || subCommand === '状态' || subCommand === '诊断' || subCommand === '体检') {
        ctx.reply(formatVoiceStatusPanel(config, apiReady));
        return true;
      }

      if (subCommand === 'check' || subCommand === 'preview' || subCommand === 'dry-run' || subCommand === '预检') {
        const text = ctx.args.slice(1).join(' ').trim();
        ctx.reply(formatVoicePreflight(config, text, apiReady));
        return true;
      }

      if (subCommand === 'cache' || subCommand === 'cache-check' || subCommand === '缓存' || subCommand === '命中') {
        const text = ctx.args.slice(1).join(' ').trim();
        ctx.reply(formatVoiceCachePreflight(config, text, apiReady));
        return true;
      }

      if (subCommand === 'sttcache' || subCommand === 'stt-cache' || subCommand === 'listen-cache' || subCommand === 'transcribe-cache' || subCommand === '听写缓存') {
        const resolvedRecords = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        const parsed = extractMediaCheckSources(ctx.args.slice(1).join(' ').trim());
        ctx.reply(formatSttCachePreflight(config, uniqueNonEmpty([...parsed.records, ...resolvedRecords]), apiReady));
        return true;
      }

      if (subCommand === 'warm' || subCommand === 'prewarm' || subCommand === '预热' || subCommand === '暖缓存') {
        if (!isAdmin(ctx)) {
          ctx.replyAt('语音预热会真实跑 TTS，这个得管理员来。');
          return true;
        }
        const text = ctx.args.slice(1).join(' ').trim();
        ctx.reply(await formatVoiceCacheWarm(config, text, apiReady, (partText) => withGate('tts', () => generateVoice(config, partText), true)));
        return true;
      }

      if (subCommand === 'clean') {
        cleanVoiceCache(config);
        cleanSttCache(config);
        ctx.reply('语音和听写缓存都清了一遍过期文件。');
        return true;
      }

      // ===== /voice clone <音频URL或附件> 自动训练样本 =====
      if (subCommand === 'clone') {
        const sub2 = (ctx.args[1] || '').toLowerCase();
        if (sub2 === 'reset' || sub2 === 'remove' || sub2 === 'clear') {
          // 仅 admin 可清空样本
          if (!isAdmin(ctx)) {
            ctx.replyAt('⛔ 权限不足');
            return true;
          }
          const ok = removeVoiceSample(config);
          ctx.reply(ok ? '已清空 voice sample，回到默认TTS。' : '清空失败，可能没有样本文件。');
          return true;
        }

        if (sub2 === 'status' || sub2 === '') {
          const stats = getVoiceStats(config);
          if (stats.cloneReady) {
            ctx.reply([
              '🎤 Voice Clone 状态',
              `样本: ${stats.samplePath}`,
              `大小: ${stats.sampleSizeMB}MB`,
              `状态: ✅ 可用`,
              VOICE_CLONE_BOUNDARY_LINE,
              '',
              '清空: /voice clone reset (admin)',
              '更新: /voice clone <音频附件> 或 /voice clone <https URL>',
            ].join('\n'));
          } else {
            ctx.reply([
              '🎤 Voice Clone 状态',
              `样本: ${stats.samplePath}`,
              `状态: ❌ ${stats.sampleReason || '不可用'}`,
              VOICE_CLONE_BOUNDARY_LINE,
              '',
              '安装: 直接发语音 + /voice clone',
              '或: /voice clone <https音频URL>',
              '建议时长: 10-30秒',
            ].join('\n'));
          }
          return true;
        }

        // 优先尝试当前消息附带的 record
        const recordSources = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        let source = ctx.args.slice(1).join(' ').trim();
        if (!source && recordSources.length > 0) source = recordSources[0];

        if (!source) {
          ctx.reply([
            '🎤 安装 Voice Clone 样本',
            '用法 1: 录一段语音 + /voice clone (10-30秒)',
            '用法 2: /voice clone <https音频URL>',
            '用法 3: /voice clone reset (admin清空样本)',
            VOICE_CLONE_BOUNDARY_LINE,
          ].join('\n'));
          return true;
        }

        ctx.reply('正在下载安装语音样本，请稍候...');
        const result = await installVoiceSample(config, source);
        if (result.ok) {
          const sizeMB = ((result.size || 0) / 1024 / 1024).toFixed(2);
          ctx.reply([
            '✅ Voice Clone 样本安装成功',
            `路径: ${result.filepath}`,
            `大小: ${sizeMB}MB`,
            `格式: ${result.mime}`,
            VOICE_CLONE_BOUNDARY_LINE,
            '',
            '试试 /voice test 兄弟们好',
          ].join('\n'));
        } else {
          ctx.reply(`❌ 安装失败: ${result.reason || '未知错误'}`);
        }
        return true;
      }

      if (subCommand === 'stt' || subCommand === 'listen' || subCommand === 'transcribe') {
        const resolvedRecords = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
        const input = ctx.args.slice(1).join(' ').trim() || resolvedRecords[0] || '';
        if (!input) {
          ctx.reply('/voice stt <语音URL>\n也可以把语音和 /voice stt 发在同一条消息里');
          return true;
        }
        if (!config.enable_stt) {
          ctx.reply('听写没开，先把 enable_stt 打开。');
          return true;
        }
        const sttNeedsApi = (config.stt_provider || 'api') === 'api' || ((config.stt_provider || 'api') === 'auto' && !(config.stt_local_command || '').trim());
        if (sttNeedsApi && !apiReady) {
          ctx.reply('AI接口没配，听写模型现在打不出去。');
          return true;
        }
        ctx.reply(await formatSttEndToEndTest(
          config,
          input,
          (source) => withGate('stt', () => transcribeRecords(config, [source])),
        ));
        return true;
      }

      const text = subCommand === 'test'
        ? (ctx.args.slice(1).join(' ').trim() || '这波语音测试一下。')
        : ctx.args.join(' ').trim();
      if (!text) {
        ctx.reply('/voice <内容>\n/voice status\n/voice check <内容>\n/voice cache <内容>\n/voice sttcache <语音URL>\n/voice warm <内容> (admin，不发送)\n/voice last\n/voice recent [条数]\n/voice test [内容]\n/voice stt <语音URL>\n/voice clone [URL或附件] - 安装授权克隆样本，不能冒充现实本人\n/voice clean');
        return true;
      }
      return sendVerbatimVoice(ctx, config, text);
    }

    // ===== 显式联网搜索 =====
    if (ctx.command && directSearchCommands.has(ctx.command)) {
      const query = ctx.args.join(' ').trim();
      if (!query) {
        ctx.reply('/search <关键词>');
        return true;
      }
      const result = await webSearch(
        query,
        config.search_timeout_ms || 1500,
        config.search_cache_seconds ?? 300,
        config.search_negative_cache_seconds ?? 60,
      );
      ctx.reply(result ? `搜到点东西:\n${result.slice(0, 500)}` : '没搜到准信');
      return true;
    }

    if (ctx.command && !directAiCommands.has(ctx.command)) {
      return false;
    }

    const earlyRawEffectiveText = ctx.command && directAiCommands.has(ctx.command)
      ? ctx.args.join(' ').trim()
      : ctx.rawText.trim();
    const verbatimVoiceText = isExplicitVoiceReplyRequest(earlyRawEffectiveText, ctx.command)
      ? extractVerbatimVoiceText(earlyRawEffectiveText, ctx.command)
      : '';
    if (verbatimVoiceText) {
      return sendVerbatimVoice(ctx, config, verbatimVoiceText, ctx.event.message_id, ctx.event.user_id);
    }

    if (!apiReady) {
      if (ctx.command && directAiCommands.has(ctx.command)) {
        ctx.reply(apiNotReadyChatReply(ctx));
        return true;
      }
      if (ctx.isPrivate || isAtBot(ctx.event) || ctx.isReplyToBot) {
        ctx.replyQuote(apiNotReadyChatReply(ctx));
        return true;
      }
      return false;
    }

    // ===== 提取信息 =====
    const senderName = ctx.event.sender.card || ctx.event.sender.nickname;
    const imageUrls = await resolveOneBotImageSources(ctx, ctx.event.message);
    const recordUrls = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
    const rawImageSegments = imageSegmentCount(ctx.event.message);
    const hasImages = imageUrls.length > 0 || rawImageSegments > 0;
    const imageInputCount = Math.max(imageUrls.length, rawImageSegments);
    const imageSourceKinds = summarizeImageSourceKinds(imageUrls);
    const hasRecords = recordUrls.length > 0;
    const recordSourceKinds = summarizeImageSourceKinds(recordUrls);
    const sttLimit = Math.max(1, Math.min(config.stt_max_records || 1, 4));
    const replySeg = ctx.event.message.find((seg) => seg.type === 'reply');
    const repliedMessageId = replySeg && replySeg.type === 'reply'
      ? Number(replySeg.data.id)
      : undefined;
    const atBot = ctx.isAtBot || isAtBot(ctx.event);
    const rawEffectiveText = earlyRawEffectiveText;
    const forceVoice = isExplicitVoiceReplyRequest(rawEffectiveText, ctx.command);
    const strippedVoiceText = forceVoice ? stripVoiceReplyInstruction(rawEffectiveText) : rawEffectiveText;
    const effectiveText = strippedVoiceText || rawEffectiveText;

    if (ctx.command && directAiCommands.has(ctx.command) && !effectiveText && imageUrls.length === 0 && recordUrls.length === 0) {
      ctx.reply('/ai <内容>');
      return true;
    }

    // 记录群消息频率，判断"群里正在快速对话中"
    const groupChatBusy = recordAndCheckBusy(sessionId, ctx.isPrivate);

    // bot 自己刚回过话(30s内)：被动接话进一步降低
    const lastSelfReply = lastReplyAt.get(sessionId) || 0;
    const selfRecentlyReplied = !ctx.isPrivate && Date.now() - lastSelfReply < 30_000;

    const trigger = forceVoice
      ? { reply: true, forced: true }
      : (fuzzyCmd === 'vision' && hasImageAttachment)
        ? { reply: true, forced: true }
      : shouldReply(config, effectiveText, ctx.command, atBot, ctx.isReplyToBot, ctx.isPrivate, groupChatBusy, selfRecentlyReplied);

    const storedBaseText = effectiveText
      ? `[mid=${ctx.event.message_id} uid=${ctx.event.user_id}] ${senderName}: ${effectiveText}`
      : `[mid=${ctx.event.message_id} uid=${ctx.event.user_id}] ${senderName}: ${imageUrls.length > 0 ? '[图片]' : recordUrls.length > 0 ? '[语音]' : '[表情]'}`;

    cm.appendMessage(sessionId, {
      role: 'user',
      content: [
        storedBaseText,
        imageUrls.length > 0 ? `(含${imageUrls.length}张图)` : '',
        recordUrls.length > 0 ? `(含${recordUrls.length}条语音)` : '',
      ].filter(Boolean).join(' '),
    });
    const contextSnapshot = cm.getFullContext(sessionId);
    const snapshotSummary = contextSnapshot.summary;
    const snapshotMessages = [...contextSnapshot.messages];

    if (!trigger.reply) {
      return false;
    }

    const triggerReason = ctx.command && directAiCommands.has(ctx.command)
      ? `命令/${ctx.command}`
      : forceVoice
        ? '明确要求语音回复'
      : ctx.isPrivate
        ? '私聊'
        : ctx.isReplyToBot
        ? '回复bot'
        : atBot
          ? '@bot'
          : '相关话题主动接话';
    const pendingStats = getQueueStats(sessionId);
    const maxGroupQueue = config.max_group_queue ?? 3;
    if (!trigger.forced && pendingStats.pending >= maxGroupQueue) {
      skippedPassiveReplies++;
      return false;
    }

    const cooldownMs = (config.cooldown_seconds || 0) * 1000;
    const now = Date.now();
    const lastReply = lastReplyAt.get(sessionId) || 0;
    if (!trigger.forced && cooldownMs > 0 && now - lastReply < cooldownMs) {
      return false;
    }

    const job: ReplyJob = {
      generation: getAiRuntimeGeneration(),
      sessionId,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      groupId: ctx.groupId,
      userId: ctx.event.user_id,
      selfId: ctx.event.self_id,
      messageId: ctx.event.message_id,
      senderName,
      rawText: ctx.rawText,
      effectiveText,
      imageUrls: [...imageUrls],
      imageInputCount,
      recordUrls: [...recordUrls],
      hasImages,
      hasRecords,
      forceVoice,
      command: ctx.command,
      isAtBot: atBot,
      isReplyToBot: ctx.isReplyToBot,
      repliedMessageId: Number.isFinite(repliedMessageId) ? repliedMessageId : undefined,
      triggerReason,
      forced: trigger.forced,
      createdAt: Date.now(),
      contextSummary: snapshotSummary,
      contextMessages: [...snapshotMessages],
    };
    setReplyTrace({
      timestamp: Date.now(),
      chatType: job.chatType,
      chatId: job.chatId,
      groupId: job.groupId,
      userId: job.userId,
      messageId: job.messageId,
      senderName: job.senderName,
      triggerReason: job.triggerReason,
      forced: job.forced,
      command: job.command,
      rawTextPreview: previewText(job.rawText),
      effectiveTextPreview: previewText(job.effectiveText),
      hasImages: job.hasImages,
    imageInputCount,
    imageSourceKinds,
    imageSources: traceWarmupSources(imageUrls),
    hasRecords: job.hasRecords,
    recordInputCount: job.recordUrls.length,
    recordSourceKinds,
    recordSources: traceWarmupSources(recordUrls),
      recordTranscripts: 0,
      sttLimit: job.hasRecords && config.enable_stt ? sttLimit : undefined,
      sttTruncated: job.hasRecords && config.enable_stt && job.recordUrls.length > sttLimit,
      queueAgeMs: 0,
      searchUsed: false,
      searchChars: 0,
      searchEvidence: [],
      knowledgeInjected: false,
      knowledgeChars: 0,
      knowledgeTopic: false,
      knowledgeTitles: [],
      evidenceSummary: [],
      realtimeIntent: false,
      realtimeDataAvailable: false,
      visionPayload: false,
      voiceRequested: job.forceVoice,
      voiceMode: job.forceVoice ? 'ai-voice' : 'none',
      voiceParts: 0,
      sent: 'queued',
      cacheHit: false,
      replyLength: 0,
    });

    void enqueueGroupTask(job, async () => {
      // 构建当前消息（双版本：API版含图，存储版纯文字）
      const queueAgeMs = Date.now() - job.createdAt;
      const skipHeavyEnhancements = job.forced && queueAgeMs > 120_000;
      const skipVoice = job.forced && queueAgeMs > 60_000;
      const sttLimit = Math.max(1, Math.min(config.stt_max_records || 1, 4));
      const sttTruncated = job.hasRecords && config.enable_stt && job.recordUrls.length > sttLimit;
      let recordTranscripts: string[] = [];
      let apiCurrentMessage: ChatMessage;
      let usesVisionPayload = false;

      try {
        if (shouldAbortStaleReplyJob(job, 'task start')) return;
        if (job.hasRecords && config.enable_stt && !skipHeavyEnhancements) {
          try {
            recordTranscripts = await withGate('stt', () => transcribeRecords(config, job.recordUrls), job.forced);
            if (shouldAbortStaleReplyJob(job, 'stt')) return;
          } catch (err) {
            if (shouldAbortStaleReplyJob(job, 'stt error')) return;
            patchReplyTrace(job.messageId, {
              sttError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
            });
          }
        }
        if (job.hasRecords && config.enable_stt && recordTranscripts.length === 0) {
          const sttStats = getSttStats(config);
          if (sttStats.lastError) patchReplyTrace(job.messageId, { sttError: sttStats.lastError });
        }
        patchReplyTrace(job.messageId, {
          queueAgeMs,
          recordTranscripts: recordTranscripts.length,
          sttLimit: job.hasRecords && config.enable_stt ? sttLimit : undefined,
          sttTruncated,
        });

        const recordTranscriptText = recordTranscripts.join('\n');
        let targetText = buildTargetText(job, recordTranscripts);

        if (job.hasRecords && !config.enable_stt) {
          targetText += '\n注意：当前消息含语音，但听写功能未开启。不要假装听到了语音细节，只能请对方补文字。';
        } else if (job.hasRecords && skipHeavyEnhancements) {
          targetText += '\n注意：当前消息含语音，但队列积压已跳过听写。不要假装听到了语音细节，只能请对方补文字。';
        } else if (sttTruncated) {
          targetText += `\n注意：本条消息含${job.recordUrls.length}条语音，当前最多听写前${sttLimit}条。不要假装听到了其余语音。`;
        }

        if (job.hasImages && !config.enable_vision) {
          targetText += '\n注意：当前消息含图片，但识图功能未开启。不要假装看到了图片细节，只能按文字上下文回应或请对方补充说明。';
        } else if (job.hasImages && skipHeavyEnhancements) {
          targetText += '\n注意：当前消息含图片，但队列积压已跳过识图。不要假装看到了图片细节，只能按文字上下文回应。';
        }

        if (job.hasImages && config.enable_vision && !skipHeavyEnhancements) {
          const limit = Math.max(1, Math.min(config.vision_max_images || 2, 4));
          const totalImages = job.imageInputCount || job.imageUrls.length;
          const visionCacheTargets = uniqueNonEmpty(job.imageUrls).slice(0, limit);
          const visionCacheBefore = compactVisionCacheInspect(inspectImageCacheSources(visionCacheTargets, limit));
          if (visionCacheBefore.length > 0) {
            patchReplyTrace(job.messageId, { visionCacheBefore });
          }
          if (totalImages > limit) {
            targetText += `\n注意：当前消息解析到${totalImages}张图片，本次最多处理前${limit}张；不要描述没有实际传入模型的图片。`;
          }
          const resolvedVision = await resolveVisionDataUrls(ctx, job, limit);
          if (shouldAbortStaleReplyJob(job, 'vision')) return;
          const dataUrls = resolvedVision.dataUrls;
          const visionCacheAfter = compactVisionCacheInspect(inspectImageCacheSources(visionCacheTargets, limit));

          if (dataUrls.length > 0) {
            const parts: MessageContent[] = [{ type: 'text', text: targetText }];
            for (const dataUrl of dataUrls) {
              parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
            }
            apiCurrentMessage = { role: 'user', content: parts };
            usesVisionPayload = true;
            patchReplyTrace(job.messageId, {
              visionPayload: true,
              visionImages: dataUrls.length,
              visionLimit: limit,
              visionTruncated: totalImages > dataUrls.length || totalImages > limit,
              visionDataInfo: dataUrls.slice(0, 3).map(describeDataUrl),
              visionCacheAfter: visionCacheAfter.length > 0 ? visionCacheAfter : undefined,
            });
            console.log(`[Vision] 群${job.chatId} 成功加载${dataUrls.length}/${totalImages || dataUrls.length}张图(high detail)`);
          } else {
            const imageStats = getImageCacheStats();
            const visionError = resolvedVision.error || imageStats.lastError || 'unknown';
            patchReplyTrace(job.messageId, {
              visionError,
              visionImages: 0,
              visionLimit: limit,
              visionCacheAfter: visionCacheAfter.length > 0 ? visionCacheAfter : undefined,
            });
            console.error(`[Vision] 群${job.chatId} 图片下载失败 url数=${totalImages} 最后错误=${visionError}`);
            targetText += `\n注意：当前消息含${totalImages}张图片，但图片下载失败(${visionError.slice(0, 50)})，模型实际上看不到图。不要编造图片细节，可以让对方重发或补充文字。`;
            apiCurrentMessage = { role: 'user', content: targetText };
          }
        } else {
          apiCurrentMessage = { role: 'user', content: targetText };
        }

        // 检查压缩（异步，不阻塞）
        const gates = getGateStats();
        const shouldDeferCompression = config.context_compression_defer_when_busy !== false && (
          getQueueStats(job.sessionId).pending > 1 ||
          gates.ai.queued > 0 ||
          gates.ai.active >= gates.ai.limit
        );
        if (!compressionInFlight.has(job.sessionId) && cm.needsCompression(job.sessionId)) {
          const oldMessages = cm.getOldMessagesToCompress(job.sessionId);
          if (oldMessages.length > 0) {
            if (shouldDeferCompression) {
              deferredCompressions++;
            } else {
              compressionInFlight.add(job.sessionId);
              withGate('ai', () => summarizeMessages(config, oldMessages), false)
                .then(summary => {
                  if (isReplyJobStale(job)) return;
                  if (summary) {
                    cm.applyCompression(job.sessionId, summary);
                    completedCompressions++;
                    console.log(`[Context] ${job.chatType}${job.chatId} 压缩${oldMessages.length}条`);
                  }
                })
                .catch(() => {
                  failedCompressions++;
                })
                .finally(() => compressionInFlight.delete(job.sessionId));
            }
          }
        }
        if (shouldAbortStaleReplyJob(job, 'compression schedule')) return;

        // ===== 联网搜索（按需 不阻塞）=====
        let searchInfo = '';
        const searchableText = job.effectiveText || recordTranscriptText;
        if (!skipHeavyEnhancements && shouldSearch(config, searchableText)) {
          try {
            const timeoutMs = config.search_timeout_ms || 4000;
            const searchPromise = webSearch(
              searchableText,
              timeoutMs,
              config.search_cache_seconds ?? 300,
              config.search_negative_cache_seconds ?? 60,
            );
            const timeoutPromise = new Promise<string>((r) => {
              const timer = setTimeout(() => r(''), timeoutMs);
              timer.unref();
            });
            const result = await Promise.race([searchPromise, timeoutPromise]);
            if (shouldAbortStaleReplyJob(job, 'search')) return;
            if (result) searchInfo = result.slice(0, 1000);
          } catch (err) {
            if (shouldAbortStaleReplyJob(job, 'search error')) return;
            patchReplyTrace(job.messageId, {
              searchError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
            });
          }
        }
        patchReplyTrace(job.messageId, {
          searchUsed: !!searchInfo,
          searchChars: searchInfo.length,
        });

        // ===== HLTV 实时数据注入（CS 话题强增强） =====
        // 当用户问到比赛/排名/战报时，主动抓 HLTV 注入到 searchInfo 里，覆盖训练数据老旧的问题
        let hltvInfo = '';
        let hltvLabels: string[] = [];
        let csRealtimeIntent = false;
        if (!skipHeavyEnhancements && searchableText) {
          const csTopic = detectCsTopicQuery(searchableText);
          csRealtimeIntent = csTopic.needsMatches || csTopic.needsRanking || csTopic.needsResults;
          const fetches: Promise<string>[] = [];
          const labels: string[] = [];
          const matchDetailId = extractCsMatchDetailId(searchableText);
          if (matchDetailId) {
            csRealtimeIntent = true;
            fetches.push(fetchMatchDetail(matchDetailId).catch(() => ''));
            labels.push(`单场${matchDetailId}`);
          }
          if (csTopic.needsMatches) { fetches.push(fetchOngoingMatches()); labels.push('当前比赛'); }
          if (csTopic.needsRanking) { fetches.push(fetchTeamRanking()); labels.push('HLTV排名'); }
          if (csTopic.needsResults) { fetches.push(fetchRecentResults()); labels.push('最近战报'); }

          // ===== 针对选手/队伍的专项数据 =====
          // 先读 CS API 结构化字段；没命中再做一次定向 webSearch。
          const playerOrTeamMatch = searchableText.match(/\b(zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|玩机器|6657)\b/i);
          const realtimeIntent = /(?:现在|最近|今天|当前|最新|状态|表现|怎么样|怎样|表现如何|战绩|阵容|转会)/.test(searchableText);
          if (playerOrTeamMatch && realtimeIntent) {
            csRealtimeIntent = true;
            const target = playerOrTeamMatch[1];
            const teamTargets = /^(navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9)$/i;
            const isTeamTarget = teamTargets.test(target);
            const structuredLookup = isTeamTarget
              ? fetchTeamProfile(target).catch(() => '')
              : fetchPlayerProfile(target).catch(() => '');
            fetches.push(
              structuredLookup.then(async (structured) => {
                if (structured) return structured;
                return webSearch(`${target} CS2 latest news 2026 status roster`, 4000, 600, 60).catch(() => '');
              })
            );
            labels.push(`${isTeamTarget ? '队伍' : '选手'}${target}最新`);
          }
          hltvLabels = labels;

          if (fetches.length > 0) {
            try {
              // HLTV/Liquipedia 抓取首次 6s，缓存命中通常<100ms
              // forced (@/回复) 给更长超时 8s 确保数据到位
              const timeoutMs = job.forced ? 8000 : 5000;
              const wrapped = fetches.map((p) => Promise.race([p, new Promise<string>((r) => {
                const t = setTimeout(() => r(''), timeoutMs);
                t.unref();
              })]));
              const results = await Promise.all(wrapped);
              if (shouldAbortStaleReplyJob(job, 'hltv')) return;
              const parts: string[] = [];
              for (let i = 0; i < results.length; i++) {
                if (results[i]) parts.push(`【${labels[i]}】\n${results[i].slice(0, 800)}`);
              }
              if (parts.length > 0) {
                hltvInfo = parts.join('\n\n');
                console.log(`[HLTV] 群${job.chatId} 注入实时数据 ${hltvInfo.length}字符 [${labels.join(',')}]`);
              } else {
                console.warn(`[HLTV] 群${job.chatId} CS话题但抓取失败 query="${searchableText.slice(0, 40)}" labels=[${labels.join(',')}]`);
              }
            } catch (err) {
              if (shouldAbortStaleReplyJob(job, 'hltv error')) return;
              patchReplyTrace(job.messageId, {
                hltvError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
              });
            }
          }
        }
        patchReplyTrace(job.messageId, {
          hltvUsed: !!hltvInfo,
          hltvChars: hltvInfo.length,
          realtimeIntent: csRealtimeIntent,
        });

        // 把 HLTV 数据合并进 searchInfo（前置，权重更高）
        if (hltvInfo) {
          searchInfo = searchInfo
            ? `[HLTV实时数据]\n${hltvInfo}\n\n[联网补充]\n${searchInfo}`
            : `[HLTV实时数据]\n${hltvInfo}`;
        }


        const knowledgeTopicProbe = [
          job.effectiveText,
          recordTranscriptText,
          searchInfo,
          ...getKnowledgeKeywords().filter((keyword) => searchableText.toLowerCase().includes(keyword.toLowerCase())),
        ].join('\n');
        let hasKnowledgeTopic = isKnowledgeTopic(knowledgeTopicProbe);
        let knowledgeInfo = '';
        let knowledgeSignature = '';
        let knowledgeTitles: string[] = [];
        let knowledgeLanes: string[] = [];
        let knowledgeFreshnessIssues: string[] = [];
        let knowledgeFreshnessRiskIssues: KnowledgeFreshnessIssue[] = [];
        if (config.enable_knowledge !== false) {
          const knowledgeRoute = buildKnowledgeRoutePreview(config, job.effectiveText, {
            triggerReason: job.triggerReason,
            hasImages: job.hasImages,
            hasRecords: job.hasRecords,
            searchInfo,
            recordTranscriptText,
          });
          hasKnowledgeTopic = knowledgeRoute.hasKnowledgeTopic;
          knowledgeInfo = knowledgeRoute.knowledgeInfo;
          knowledgeTitles = knowledgeRoute.titles;
          knowledgeLanes = formatKnowledgeLaneSummary(knowledgeRoute.lanes);
          knowledgeFreshnessRiskIssues = knowledgeRoute.freshnessIssues;
          knowledgeFreshnessIssues = formatKnowledgeFreshnessTraceItems(knowledgeRoute.freshnessIssues);
          knowledgeSignature = knowledgeRoute.signature;
          patchReplyTrace(job.messageId, { knowledgeTitles, knowledgeLanes, knowledgeFreshnessIssues });
        }
        patchReplyTrace(job.messageId, {
          knowledgeInjected: !!knowledgeInfo,
          knowledgeChars: knowledgeInfo.length,
          knowledgeTopic: hasKnowledgeTopic,
        });
        const userProfileInfo = buildUserProfileRuntimeHint(job.chatType, job.chatId, job.userId);
        patchReplyTrace(job.messageId, {
          userProfileInjected: !!userProfileInfo,
          userProfileChars: userProfileInfo.length,
        });

        // ===== 构建发给API的消息 =====
        // 注意：history是除当前消息外的历史（当前已经append了，需要排除最后一条）
        const sendLimit = Math.max(8, config.context_send_messages || 25);
        const focusedHistory = buildFocusedHistory(job, sendLimit);
        const history = focusedHistory.history;
        const systemPrompt = buildSystemPrompt(config);

        // 检索相似历史（基于当前消息文本）- 仅当有有意义的查询文本时
        let similarMemories = '';
        let memoryHits = 0;
        let memoryFiltered = 0;
        let memoryFilterReasons: string[] = [];
        let memoryPreview: string[] = [];
        const memoryQuery = job.effectiveText || recordTranscriptText;
        if (config.enable_memory_retrieval !== false && memoryQuery && memoryQuery.length >= 4) {
          try {
            const minSimilarity = config.memory_min_similarity ?? 0.18;
            const topK = config.memory_top_k ?? 4;
            const recent = cm.retrieveSimilar(
              job.sessionId,
              memoryQuery,
              Math.max(Math.max(0, topK) + 8, 12),
              minSimilarity,
            );
            // 过滤掉与最近history已经包含的重复
            const recentTextSet = new Set(history
              .slice(-10)
              .map((m) => typeof m.content === 'string' ? normalizeMemoryDuplicateText(m.content) : '')
              .filter(Boolean));
            const eligible = recent
              .filter((r) => r.similarity >= minSimilarity && !recentTextSet.has(normalizeMemoryDuplicateText(r.text)));
            const truthRisk = filterMemoryTruthRisk(memoryQuery, eligible, csRealtimeIntent);
            memoryFiltered = truthRisk.filtered.length;
            memoryFilterReasons = truthRisk.reasons;
            const useful = truthRisk.kept
              .slice(0, Math.max(0, topK));
            if (useful.length > 0 || memoryFiltered > 0) {
              const budget = Math.max(0, config.memory_inject_max_chars ?? cm.getMemoryInjectMaxChars());
              if (budget > 0) {
                const lines: string[] = [];
                let used = 0;
                let injectedMemoryLines = 0;
                if (memoryFiltered > 0) {
                  const reason = memoryFilterReasons.length ? memoryFilterReasons.join('/') : '旧实时事实';
                  const line = `[RAG过滤] 已跳过${memoryFiltered}条疑似${reason}记忆；当前排名/比分/阵容/转会只按本条实时证据判断，不从历史记忆补。`;
                  lines.push(line);
                  used += line.length;
                }
                for (const r of useful) {
                  const score = r.score !== undefined ? ` score=${r.score}` : '';
                  const age = r.ageSeconds !== undefined ? ` age=${formatMemoryAge(r.ageSeconds)}` : '';
                  const line = `[${r.role} sim=${r.similarity}${score}${age}] ${r.text.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '').slice(0, 220)}`;
                  if (used + line.length > budget && lines.length > 0) break;
                  lines.push(line);
                  used += line.length;
                  injectedMemoryLines++;
                }
                similarMemories = lines.join('\n').slice(0, budget);
                memoryPreview = useful
                  .slice(0, 3)
                  .map((r) => `${r.role}:${r.score ?? r.similarity}/${r.similarity} ${previewText(r.text.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, ''), 44)}`);
                memoryHits = injectedMemoryLines;
              }
            }
          } catch { /* 失败不阻塞 */ }
        }

        const hasRealtimeData = csRealtimeIntent ? !!hltvInfo : !!searchInfo;
        const evidenceSummary = summarizeRealtimeEvidence(searchInfo, hltvLabels, knowledgeTitles, memoryHits);
        const searchEvidence = extractEvidenceLines(searchInfo, 4);
        const realtimeFreshness = extractRealtimeFreshnessLines(searchInfo, 5);
        const realtimeStaleEvidence = realtimeFreshness.some((line) => /\bstale\b|过期|不能当实时结论/i.test(line))
          || /(?:^|\n)\s*(?:缓存|当前缓存)\s*[:：].*(?:\bstale\b|过期|不能当实时结论)/i.test(searchInfo);
        const hasFreshRealtimeEvidence = realtimeFreshness.some((line) => /\bfresh\b/i.test(line));
        const staleOnlyRealtimeEvidence = csRealtimeIntent && realtimeStaleEvidence && !hasFreshRealtimeEvidence;
        const hasCurrentRealtimeData = hasRealtimeData && !staleOnlyRealtimeEvidence;
        const evidenceGuardContext: EvidenceLedgerGuardContext = {
          realtimeStaleEvidence,
          memoryFiltered,
        };
        const styleScene = buildStyleSceneDecision(job, recordTranscriptText, csRealtimeIntent, hasCurrentRealtimeData);
        const styleSceneInfo = formatStyleScenePrompt(styleScene, hasCurrentRealtimeData);
        const apiMessages = buildApiMessages(systemPrompt, job.contextSummary, history, apiCurrentMessage, searchInfo, knowledgeInfo, similarMemories, styleSceneInfo, userProfileInfo);
        patchReplyTrace(job.messageId, {
          contextMessagesSent: history.length,
          contextFocused: focusedHistory.focused,
          memoryHits,
          memoryFiltered,
          memoryFilterReasons,
          memoryPreview,
          realtimeIntent: csRealtimeIntent,
          realtimeDataAvailable: hasCurrentRealtimeData,
          evidenceSummary,
          searchEvidence,
          realtimeFreshness,
          realtimeStaleEvidence,
          styleScene: styleScene.scene,
          styleSceneAction: styleScene.action,
          styleSceneSignals: styleScene.signals,
          styleSceneNeedsRealtime: styleScene.needsRealtime,
        });

        // ===== 调用 AI =====
        // 时间/日期类问题永远不缓存（因为答案随时间变化）
        const isTimeSensitive = /(?:今天|今日|现在|当前|此刻|此时|目前|今晚|今早|今夜|刚才|几号|几点|几月|星期|周[一二三四五六日天])/.test(job.effectiveText || '');
        const cachePolicy = buildReplyCachePolicy(config, job, styleScene, searchInfo, isTimeSensitive, hasRealtimeData);
        patchReplyTrace(job.messageId, {
          cachePolicy: formatReplyCachePolicy(cachePolicy),
          cacheTtlSeconds: cachePolicy.enabled ? cachePolicy.ttlSeconds : undefined,
        });
        const replyCacheKey = cachePolicy.enabled ? makeReplyCacheKey(config, job.effectiveText, knowledgeSignature, cachePolicy.scope) : '';
        if (replyCacheKey) {
          patchReplyTrace(job.messageId, { cacheKeyPrefix: replyCacheKeyPrefix(replyCacheKey) });
        } else {
          appendReplyCacheDecision(job.messageId, `bypass ${cachePolicy.reason}`);
        }
        const cacheEntryBefore = replyCacheKey ? replyCache.get(replyCacheKey) : undefined;
        const cacheExpiredBefore = !!cacheEntryBefore && cacheEntryBefore.expiresAt <= Date.now();
        let cleaned = replyCacheKey ? getCachedReply(replyCacheKey) : null;
        let cacheHit = !!cleaned;
        if (replyCacheKey) {
          appendReplyCacheDecision(
            job.messageId,
            cleaned
              ? `hit key=${replyCacheKeyPrefix(replyCacheKey)}`
              : cacheExpiredBefore
                ? `expired key=${replyCacheKeyPrefix(replyCacheKey)}`
                : `miss key=${replyCacheKeyPrefix(replyCacheKey)}`,
            replyCacheKey,
          );
        }
        if (cleaned && looksLikeInactiveActivationReply(cleaned)) {
          if (replyCacheKey) replyCache.delete(replyCacheKey);
          cleaned = null;
          cacheHit = false;
          appendReplyCacheDecision(job.messageId, 'discard inactive-activation', replyCacheKey);
          patchReplyTrace(job.messageId, {
            error: 'cached inactive activation reply discarded',
          });
        }
        if (cleaned) {
          const cachedGuard = guardReplyFacts(cleaned, hasCurrentRealtimeData, knowledgeFreshnessRiskIssues, hltvLabels, realtimeFreshness, evidenceGuardContext);
          if (cachedGuard.text !== cleaned) {
            if (replyCacheKey) replyCache.delete(replyCacheKey);
            cleaned = cachedGuard.text;
            cacheHit = false;
            appendReplyCacheDecision(job.messageId, 'discard factguard', replyCacheKey);
            patchReplyTrace(job.messageId, {
              factGuard: cachedGuard.reason,
              freshnessRepair: 'cached reply guarded by knowledge freshness risk',
            });
          }
          const cachedQuality = assessReplyQuality(cleaned, job, hasCurrentRealtimeData);
          if (!cachedQuality.ok) {
            if (replyCacheKey) replyCache.delete(replyCacheKey);
            cleaned = null;
            cacheHit = false;
            appendReplyCacheDecision(job.messageId, `discard quality:${cachedQuality.issues.join('/')}`, replyCacheKey);
            patchReplyTrace(job.messageId, {
              error: `cached low-quality reply discarded: ${cachedQuality.issues.join('/')}`,
              qualityIssues: cachedQuality.issues,
              qualityFinalOk: false,
            });
          } else {
            patchReplyTrace(job.messageId, { qualityFinalOk: true });
          }
        }
        if (cleaned && isRecentReplyDuplicate(job.sessionId, cleaned)) {
          if (replyCacheKey) replyCache.delete(replyCacheKey);
          cleaned = null;
          cacheHit = false;
          appendReplyCacheDecision(job.messageId, 'discard duplicate same-session', replyCacheKey);
          patchReplyTrace(job.messageId, {
            freshnessRepair: 'cached duplicate discarded, regenerated',
          });
        }
        const generateReply = async (): Promise<InFlightReplyResult> => {
          const maxAttempts = job.forced ? 5 : 2;
          const reply = await withGate('ai', () => callLLMWithRetryForJob(job, config, apiMessages, usesVisionPayload, maxAttempts), job.forced);
          if (shouldAbortStaleReplyJob(job, 'llm')) return { value: '', reusable: false };
          const rawIdentityBoundaryClaim = hasRealityBoundaryClaim(reply);
          const rawQuoteBoundaryClaim = hasUnsupportedOriginalQuoteClaim(reply);
          let next = postProcessReply(reply);
          const boundaryRepairs = [
            rawIdentityBoundaryClaim && next !== reply ? 'identity boundary enforced' : '',
            rawQuoteBoundaryClaim && next !== reply ? 'original quote boundary enforced' : '',
          ].filter(Boolean);
          if (boundaryRepairs.length > 0) {
            patchReplyTrace(job.messageId, {
              factGuard: boundaryRepairs.join(' / '),
            });
          }
          if (looksLikeInactiveActivationReply(next)) {
            const badReply = next;
            try {
              const retryMessages = buildInactiveActivationRetryMessages(apiMessages, badReply);
              const retryReply = await withGate('ai', () => callLLMWithRetryForJob(job, config, retryMessages, usesVisionPayload, 1), job.forced);
              if (shouldAbortStaleReplyJob(job, 'inactive retry llm')) return { value: '', reusable: false };
              const retryCleaned = postProcessReply(retryReply);
              next = retryCleaned && !looksLikeInactiveActivationReply(retryCleaned) ? retryCleaned : '';
              patchReplyTrace(job.messageId, {
                outputRepair: next ? 'inactive activation reply retried' : 'inactive activation retry still invalid',
              });
            } catch (err) {
              if (shouldAbortStaleReplyJob(job, 'inactive retry error')) return { value: '', reusable: false };
              const retryError = err instanceof Error ? err.message : String(err);
              next = '';
              patchReplyTrace(job.messageId, {
                error: `inactive activation retry failed: ${retryError.slice(0, 120)}`,
              });
            }
          }
          const beforeFactGuard = next;
          const factGuard = guardReplyFacts(beforeFactGuard, hasCurrentRealtimeData, knowledgeFreshnessRiskIssues, hltvLabels, realtimeFreshness, evidenceGuardContext);
          next = factGuard.text;
          if (next !== beforeFactGuard) {
            patchReplyTrace(job.messageId, { factGuard: factGuard.reason });
          }
          if (next) {
            const quality = assessReplyQuality(next, job, hasCurrentRealtimeData);
            if (!quality.ok) {
              patchReplyTrace(job.messageId, {
                qualityIssues: quality.issues,
                qualityFinalOk: false,
              });
              try {
                const retryMessages = buildReplyQualityRepairMessages(apiMessages, next, quality, job, hasCurrentRealtimeData);
                const retryReply = await withGate('ai', () => callLLMWithRetryForJob(job, config, retryMessages, usesVisionPayload, 1), job.forced);
                if (shouldAbortStaleReplyJob(job, 'quality repair llm')) return { value: '', reusable: false };
                const retryBeforeGuard = postProcessReply(retryReply);
                const retryFactGuard = guardReplyFacts(retryBeforeGuard, hasCurrentRealtimeData, knowledgeFreshnessRiskIssues, hltvLabels, realtimeFreshness, evidenceGuardContext);
                const retryCleaned = retryFactGuard.text;
                if (retryCleaned !== retryBeforeGuard) {
                  patchReplyTrace(job.messageId, { factGuard: `${retryFactGuard.reason} in repair` });
                }
                const retryQuality = assessReplyQuality(retryCleaned, job, hasCurrentRealtimeData);
                if (retryCleaned && retryQuality.ok) {
                  next = retryCleaned;
                  patchReplyTrace(job.messageId, {
                    outputRepair: `quality retry: ${quality.issues.join('/')}`,
                    qualityFinalOk: true,
                  });
                } else {
                  patchReplyTrace(job.messageId, {
                    outputRepair: `quality kept with guard: ${quality.issues.join('/')}`,
                    qualityIssues: retryQuality.issues.length ? retryQuality.issues : quality.issues,
                    qualityFinalOk: false,
                  });
                }
              } catch (err) {
                if (shouldAbortStaleReplyJob(job, 'quality repair error')) return { value: '', reusable: false };
                patchReplyTrace(job.messageId, {
                  outputRepair: `quality repair failed: ${quality.issues.join('/')}`,
                  qualityIssues: quality.issues,
                  qualityFinalOk: false,
                });
              }
            } else {
              patchReplyTrace(job.messageId, { qualityFinalOk: true });
            }
          }
          const finalCacheQuality = next ? assessReplyQuality(next, job, hasCurrentRealtimeData) : { ok: false, issues: ['empty'] };
          const reusable = finalCacheQuality.ok && isReplyReusableForCache(next, job);
          const reuseRejectedReason = reusable
            ? undefined
            : !next
              ? 'empty'
              : !finalCacheQuality.ok
                ? `quality:${finalCacheQuality.issues.join('/')}`
                : 'context-bound';
          if (replyCacheKey && next && reusable) {
            setCachedReply(replyCacheKey, next, cachePolicy.ttlSeconds, config.ai_reply_cache_max_entries);
            appendReplyCacheDecision(job.messageId, `stored ttl=${cachePolicy.ttlSeconds}s`, replyCacheKey);
          } else if (replyCacheKey) {
            appendReplyCacheDecision(job.messageId, `not-stored ${reuseRejectedReason}`, replyCacheKey);
          }
          return { value: next, reusable, reuseRejectedReason };
        };

        if (!cleaned) {
          const pending = replyCacheKey ? getInFlightReply(replyCacheKey) : null;
          if (pending) {
            appendReplyCacheDecision(job.messageId, 'single-flight wait', replyCacheKey);
            const result = await pending;
            if (shouldAbortStaleReplyJob(job, 'reply single-flight')) return;
            if (result.reusable) {
              cleaned = result.value;
              cacheHit = true;
              appendReplyCacheDecision(job.messageId, 'single-flight reused', replyCacheKey);
            } else {
              appendReplyCacheDecision(job.messageId, `single-flight non-reusable:${result.reuseRejectedReason || 'unknown'}`, replyCacheKey);
              cleaned = (await generateReply()).value;
            }
          } else {
            if (replyCacheKey) {
              replyCacheMisses++;
              appendReplyCacheDecision(job.messageId, 'generate', replyCacheKey);
            }
            const generated = generateReply();
            if (replyCacheKey) setInFlightReply(replyCacheKey, generated);
            cleaned = (await generated).value;
          }
        }

        if (!cleaned) {
          // 空回复
          // - 普通主动接话: 直接吞掉，下次触发时 AI 自然带上上下文
          // - forced (@bot/回复/私聊/命令): 必须给出回复，用 forcedFallbackReply 兜底
          if (job.forced) {
            const fb = forcedApiFailureReply(job, 'AI returned empty', recordTranscripts);
            if (shouldAbortStaleReplyJob(job, 'empty fallback')) return;
            if (fb) {
              const useQuoteFb = config.forced_reply_quote !== false;
              if (useQuoteFb) ctx.replyQuoteTo(job.messageId, job.userId, fb);
              else ctx.reply(fb);
            }
            patchReplyTrace(job.messageId, {
              sent: 'fallback',
              error: 'AI returned empty, used fallback',
              replyLength: fb.length,
            });
          }
          return;
        }
        const openerResult = dedupeSessionOpener(job.sessionId, cleaned);
        cleaned = openerResult.text;

        // 全句去重检查 - 如果跟最近 5 条 bot 回复内容重复，重新生成一次
        if (isRecentReplyDuplicate(job.sessionId, cleaned) && !cacheHit) {
          console.log(`[AI][${job.chatType}${job.chatId}] 检测到重复回复，重新生成 origin="${cleaned.slice(0, 30)}"`);
          try {
            const retryMessages: ChatMessage[] = [
              ...apiMessages,
              { role: 'assistant', content: cleaned },
              { role: 'user', content: '这条跟你之前说过的太像了，换个角度或换种说法，别重复。' },
            ];
            const retryReply = await withGate('ai', () => callLLMWithRetryForJob(job, config, retryMessages, usesVisionPayload, 1), job.forced);
            if (shouldAbortStaleReplyJob(job, 'duplicate retry llm')) return;
            const retryBeforeGuard = postProcessReply(retryReply);
            const retryFactGuard = guardReplyFacts(retryBeforeGuard, hasCurrentRealtimeData, knowledgeFreshnessRiskIssues, hltvLabels, realtimeFreshness, evidenceGuardContext);
            const retryCleaned = retryFactGuard.text;
            if (retryCleaned !== retryBeforeGuard) {
              patchReplyTrace(job.messageId, { factGuard: `${retryFactGuard.reason} in duplicate repair` });
            }
            if (retryCleaned && !isRecentReplyDuplicate(job.sessionId, retryCleaned)) {
              cleaned = retryCleaned;
              patchReplyTrace(job.messageId, {
                sent: 'queued',
                replyLength: cleaned.length,
                freshnessRepair: 'duplicate reply regenerated',
              });
            }
          } catch { /* 失败就用原文 */ }
        }

        const realtimeBoundaryAppendix = formatAiRealtimeBoundaryAppendix(
          job,
          csRealtimeIntent,
          hasCurrentRealtimeData,
          realtimeFreshness,
          realtimeStaleEvidence,
          hltvLabels,
        );
        if (realtimeBoundaryAppendix && !cleaned.includes(realtimeBoundaryAppendix)) {
          cleaned = `${cleaned.trim()}\n\n${realtimeBoundaryAppendix}`;
          patchReplyTrace(job.messageId, {
            freshnessRepair: 'AI realtime boundary appendix added',
          });
        }
        recordRecentReply(job.sessionId, cleaned);

        patchReplyTrace(job.messageId, {
          cacheHit,
          replyLength: cleaned.length,
          openerBefore: openerResult.before,
          openerAfter: openerResult.after,
          openerDeduped: openerResult.deduped,
        });

        if (shouldAbortStaleReplyJob(job, 'before context append')) return;

        // 追加AI回复
        cm.appendMessage(job.sessionId, { role: 'assistant', content: cleaned });

        // 发送
        const quoteStrongTrigger = job.forced && config.forced_reply_quote !== false;
        const quoteMention = config.must_reply_quote && (job.isReplyToBot || job.isAtBot);
        const useQuote = quoteStrongTrigger || quoteMention || Math.random() < 0.18;

        // 明确要求语音时必须尝试TTS；普通主动接话仍按概率，避免语音刷屏。
        let sentVoice = false;
        const maxVoiceChars = config.tts_max_chars || 120;
        const finalText = job.forceVoice ? clampVoiceText(cleaned, maxVoiceChars) : cleaned;
        const voiceAllowed = !skipVoice && config.enable_tts && finalText.length >= 2 && finalText.length <= maxVoiceChars;
        // forceVoice = 用户明确要求语音，必发语音
        // forced = @/reply/私聊/命令，按 tts_probability 概率发语音
        // 普通主动接话，按 tts_probability * 0.5 发（更克制）
        const ttsProbability = config.tts_probability ?? 0.15;
        const passiveVoiceProb = ttsProbability * 0.5;
        const shouldSendVoice = voiceAllowed && (
          job.forceVoice ||
          (job.forced && Math.random() < ttsProbability) ||
          (!job.forced && Math.random() < passiveVoiceProb)
        );
        let delayedBeforeSend = false;
        const waitBeforeSend = async (stage: string, sendText: string): Promise<boolean> => {
          if (delayedBeforeSend) return false;
          delayedBeforeSend = true;
          const delayMs = await applyHumanReplyDelay(config, job, sendText);
          if (delayMs > 0 && shouldAbortStaleReplyJob(job, stage)) {
            return true;
          }
          return false;
        };
        let voiceError = '';
        if (shouldSendVoice) {
          const voiceStatsBefore = getVoiceStats(config);
          lastVoiceTrace = {
            timestamp: Date.now(),
            mode: job.forceVoice ? 'ai-voice' : 'passive-voice',
            chatType: job.chatType,
            chatId: job.chatId,
            groupId: job.groupId,
            userId: job.userId,
            messageId: job.messageId,
            requestedTextPreview: previewText(job.rawText || job.effectiveText),
            spokenTextPreview: previewText(finalText),
            spokenTextWarm: finalText.slice(0, 240),
            parts: 1,
            sentParts: 0,
            provider: voiceStatsBefore.provider,
            sendMode: voiceStatsBefore.sendMode,
            lastTtsMode: voiceStatsBefore.lastMode,
          };
          rememberVoiceTrace(lastVoiceTrace);
          try {
            const voicePath = await withGate('tts', () => generateVoice(config, finalText), job.forced || job.forceVoice);
            if (shouldAbortStaleReplyJob(job, 'reply tts')) {
              voiceError = 'stale runtime after reply tts';
              return;
            }
            if (voicePath) {
              // QQ/NapCat 对 reply + record 组合兼容性差，部分客户端会显示但无法播放。
              // 语音消息保持纯 record；只有文本兜底才引用原消息。
              if (await waitBeforeSend('voice human delay', finalText)) {
                voiceError = 'stale runtime after voice human delay';
                return;
              }
              ctx.reply([voiceRecordSegment(config, voicePath)]);
              sentVoice = true;
            }
          } catch (err) {
            voiceError = err instanceof Error ? err.message : String(err);
          } finally {
            const voiceStatsAfter = getVoiceStats(config);
            lastVoiceTrace = {
              ...lastVoiceTrace,
              timestamp: Date.now(),
              sentParts: sentVoice ? 1 : 0,
              provider: voiceStatsAfter.provider,
              sendMode: voiceStatsAfter.sendMode,
              lastTtsMode: voiceStatsAfter.lastMode,
              error: voiceError || (!sentVoice ? voiceStatsAfter.lastError || 'tts failed' : undefined),
            };
            rememberVoiceTrace(lastVoiceTrace);
          }
        }

        if (!sentVoice) {
          if (shouldAbortStaleReplyJob(job, 'text send')) return;
          if (job.forceVoice) {
            cleaned = `语音这下没生成出来 ${cleaned}`;
          }
          // 解析 [face:N] / 命名表情 / [sticker:N] 标记，转换成 QQ 表情段
          // parseStickerMarkers 是更全面的（含命名表情和本地表情包），parseFaceMarkers 只支持数字
          const faceSegments = parseStickerMarkers(cleaned) || parseFaceMarkers(cleaned);
          if (await waitBeforeSend('text human delay', cleaned)) return;
          if (useQuote) {
            ctx.replyQuoteTo(job.messageId, job.userId, faceSegments || cleaned);
          } else {
            ctx.reply(faceSegments || cleaned);
          }
        }
        patchReplyTrace(job.messageId, {
          voiceRequested: job.forceVoice || shouldSendVoice,
          voiceMode: shouldSendVoice ? (job.forceVoice ? 'ai-voice' : 'passive-voice') : 'none',
          voiceParts: sentVoice ? 1 : 0,
          sent: sentVoice ? 'voice' : (job.forceVoice ? 'voice+text-fallback' : 'text'),
          replyLength: cleaned.length,
          error: voiceError || undefined,
        });
        lastReplyAt.set(job.sessionId, Date.now());
      } catch (err) {
        if (shouldAbortStaleReplyJob(job, 'catch')) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[AI][${job.chatType}${job.chatId}] 失败:`, errMsg);
        patchReplyTrace(job.messageId, {
          sent: job.forced ? 'fallback' : 'skipped',
          error: errMsg.slice(0, 160),
        });
        if (job.forced) {
          const fb = forcedApiFailureReply(job, errMsg, recordTranscripts);
          if (shouldAbortStaleReplyJob(job, 'catch fallback')) return;
          if (fb) ctx.replyQuoteTo(job.messageId, job.userId, fb);
        }
      }
    }).catch((err) => {
      if (shouldAbortStaleReplyJob(job, 'queue catch')) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AI][${job.chatType}${job.chatId}] 队列异常:`, errMsg);
      if (job.forced) {
        // 队列层异常 forced 必须给个回复
        try {
          const fb = forcedApiFailureReply(job, errMsg, []);
          if (shouldAbortStaleReplyJob(job, 'queue fallback')) return;
          if (fb) ctx.replyQuoteTo(job.messageId, job.userId, fb);
        } catch { /* */ }
      }
    });

    return true;
  },
};
