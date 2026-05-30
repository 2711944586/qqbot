import { Plugin, PluginContext, AIConfig, MessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { hasUsableApiKey } from '../config';
import { cleanSearchCache, configureSearchCache, webSearch } from './web-search';
import { cleanVoiceCache, generateVoice, getVoiceStats } from './tts';
import { cleanSttCache, getSttStats, transcribeRecords } from './stt';
import { cleanupCache as cleanImageCache, configureImageCache, getCacheStats as getImageCacheStats, getImageDataUrl } from './image-cache';
import { configureGates, getGateStats, withGate } from './concurrency';
import { sanitizeOutgoingText } from '../message-sanitize';
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
  extractKnowledgeTitles,
  KnowledgeCandidate,
  KnowledgeSource,
  auditKnowledge,
  autoCommitKnowledgeCandidate,
  getLastKnowledgeAudit,
  filterDueKnowledgeSources,
  getRandomKnowledgeLine,
  isKnowledgeAutoEnabled,
  isKnowledgeTopic,
  listKnowledgeBatches,
  listKnowledgeCandidates,
  loadKnowledgeSources,
  markKnowledgeSourceRefreshed,
  markKnowledgeAutoRefresh,
  pruneKnowledgeAutoLog,
  previewInboxCandidates,
  previewKnowledgeCandidate,
  rollbackKnowledgeBatch,
  searchKnowledge,
  selectKnowledge,
  selectStyleKnowledge,
  setKnowledgeAutoEnabled,
} from './knowledge-base';
import { loadContext, writeSession, deleteSession, markDirty, setFlushHandler, getDirtySessions, listAllSessions, clearDirtySession, flushNow } from './context-store';
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
} from './reply-postprocess';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';

// ============ 类型 ============
// ChatMessage / MessageContent / LLMCaller 已从 ./llm-api 导入
// SessionContext / ContextManager 已从 ./ai-context 导入

interface ReplyJob {
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
  hasRecords: boolean;
  recordTranscripts: number;
  queueAgeMs: number;
  searchUsed: boolean;
  searchChars: number;
  knowledgeInjected: boolean;
  knowledgeChars: number;
  knowledgeTopic: boolean;
  knowledgeTitles: string[];
  openerBefore?: string;
  openerAfter?: string;
  openerDeduped?: boolean;
  sttError?: string;
  visionError?: string;
  searchError?: string;
  visionPayload: boolean;
  voiceRequested: boolean;
  voiceMode: 'none' | 'direct-verbatim' | 'ai-voice' | 'passive-voice';
  voiceParts: number;
  sent: 'queued' | 'text' | 'voice' | 'voice+text-fallback' | 'fallback' | 'skipped';
  cacheHit: boolean;
  replyLength: number;
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
  parts: number;
  sentParts: number;
  provider: string;
  sendMode: string;
  lastTtsMode?: string;
  error?: string;
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

async function callLLMWithRetry(config: AIConfig, messages: ChatMessage[], useVision: boolean = false, maxAttempts: number = 3): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await llmCaller(config, messages, useVision);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts - 1) await delay(1000 * (attempt + 1));
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

export function __setLLMCallerForTests(caller?: LLMCaller): void {
  llmCaller = caller || callLLM;
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
): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (knowledgeInfo) {
    result.push({ role: 'system', content: `[临场笔记]\n${knowledgeInfo}` });
  }

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
    '能说“等一下/这个不太对”就别硬喷',
    '这条不要用固定口头禅开头',
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
): string {
  const keepIdentity = needsRealityIdentityBoundary(job.effectiveText || job.rawText);
  const style = scrubKnowledgeForRuntime(styleKnowledge, keepIdentity);
  const topic = scrubKnowledgeForRuntime(topicKnowledge, keepIdentity);
  const cue = buildLiveStyleCue(job);
  const recentOpeners = buildRecentAssistantOpeningHints(job.contextMessages.slice(0, -1));
  return [
    '下面是必须执行的临场笔记，只用来垫语感和事实，不要在回复里说出来。',
    `本条节奏: ${cue}`,
    hasKnowledgeTopic ? '当前消息命中话题知识，必须优先用下面的选手/队伍/CS2判断素材。' : '当前消息至少注入直播语态素材，必须吸收语气和节奏，别退回AI助手腔。',
    '核心手感: 像直播间顺手接弹幕，先抓当前这句话，短反应 + 具体判断 + 收住攻击性。',
    '输出时禁止说“根据知识库/根据素材/根据临场笔记/作为AI/作为bot/这是模板”。',
    '不要标题式输出“结论/原因/建议/分析/总结”，像群里正常接一句。',
    recentOpeners ? `[最近回复开头，别复读]\n${recentOpeners}` : '',
    style ? `[语态素材]\n${style}` : '',
    topic ? `[话题素材]\n${topic}` : '',
  ].filter(Boolean).join('\n\n').slice(0, maxChars);
}

function buildTargetText(job: ReplyJob, recordTranscripts: string[] = []): string {
  const transcriptText = recordTranscripts.join('\n');
  const body = job.effectiveText || transcriptText || (job.hasImages ? '[图片]' : job.hasRecords ? '[语音]' : '[空]');
  const mediaHints: string[] = [];
  if (job.hasImages) mediaHints.push(`(消息含${job.imageUrls.length}张图片)`);
  if (job.hasRecords && !transcriptText) mediaHints.push('(消息含语音 但无听写文本)');
  if (transcriptText) mediaHints.push(`(语音听写: ${transcriptText})`);
  if (job.forceVoice) mediaHints.push('(对方要求语音回复 短一点 适合念)');
  if (job.repliedMessageId) mediaHints.push('(对方在引用之前的消息追问)');

  const recentOpeners = buildRecentAssistantOpeningHints(job.contextMessages.slice(0, -1));
  const openerHint = recentOpeners ? `\n(我最近刚用过这些开头别复读: ${recentOpeners.replace(/\n/g, ' / ')})` : '';

  // 简化的格式 - 直接呈现消息 + 最少元信息，让模型自然回应
  const mediaText = mediaHints.length > 0 ? ' ' + mediaHints.join(' ') : '';
  return `${job.senderName}: ${body}${mediaText}${openerHint}`;
}

function buildSystemPrompt(config: AIConfig): string {
  const preset = config.presets[config.active_preset] || Object.values(config.presets)[0];
  const base = preset?.system_prompt || '你是QQ群里的网友「玩机器」。';
  const aggressionRule = config.aggression_level === 'analysis'
    ? '以分析为主，少玩梗；先给判断，再讲依据。'
    : config.aggression_level === 'medium'
      ? '可以嘴硬吐槽，敢怼敢损，像直播时吐槽菜鸡操作那种程度；但不追着人骂，不人身攻击，点到为止。'
      : config.aggression_level === 'high'
        ? '可以重嘴硬，毒舌上限高，像直播间跟弹幕对喷的程度。但底线是不搞真人身攻击和歧视。'
        : '轻嘴硬但不咬人，调侃点到为止，优先把话说准；不要动不动喷人。';

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
  ];
  const hint = antiFormulaicHints[Math.floor(Math.random() * antiFormulaicHints.length)];

  return [
    base,
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
    `- 人格: ${config.persona_mode || 'first_person_bot'} 强度: ${config.aggression_level || 'low'}`,
  ].join('\n');
}

// ============ 后处理 已迁移到 ./reply-postprocess ============

function forcedFallbackReply(job: ReplyJob, recordTranscripts: string[] = []): string {
  if (recordTranscripts.length > 0) return `我听到了 大概是「${recordTranscripts.join(' ').slice(0, 80)}」 你再问一句`;
  if (job.hasRecords && !job.effectiveText) return '语音收到了 你补句文字';
  if (job.hasImages && !job.effectiveText) return '图收到了 你要我看啥';
  // API失败时不回复 靠下次消息触发时自然带上上下文
  return '';
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

async function handleKnowledgeCommand(ctx: PluginContext, config: AIConfig): Promise<boolean> {
  if (ctx.command !== 'kb') return false;

  const action = (ctx.args[0] || '').toLowerCase();
  const rest = ctx.args.slice(1).join(' ').trim();

  if (!action || action === 'help') {
    ctx.reply([
      '/kb search <关键词>',
      '/kb stats',
      '/kb preview <关键词>  管理员',
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

  if (action === 'stats') {
    const stats = getKnowledgeStats();
    ctx.reply([
      `知识库: ${stats.sections}块 ${stats.chars}字`,
      `索引词: ${stats.keywords}`,
      `检索命中: ${stats.searchHits}/${stats.searchMisses}`,
      `注入命中: ${stats.selectHits}/${stats.selectMisses}`,
      `候选: ${stats.candidates}`,
      `自动: ${stats.autoEnabled ? 'on' : 'off'} 最近${formatTime(stats.lastAutoRefreshAt)}`,
      `自动写入: ${stats.autoCommitted} 待核验主库化 审计问题: ${stats.auditIssues}`,
      `来源状态: ${stats.sourceStates} 个`,
    ].join('\n'));
    return true;
  }

  if (!['preview', 'refresh', 'audit', 'auto', 'batches', 'rollback', 'show', 'drop', 'commit', 'ingest', 'list'].includes(action)) {
    ctx.reply('先看 /kb help，别硬猜命令。');
    return true;
  }

  if (!isAdmin(ctx)) {
    ctx.replyAt('这个得管理员来，知识库不能谁来都往里灌。');
    return true;
  }

  if (config.knowledge_update_mode === 'static' && action !== 'list') {
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
      .map((item) => `${item.id} | ${item.title} | ${item.sourceType}/${item.confidence}/${item.risk} | ${item.source}`)
      .join('\n'));
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
      ...report.issues.slice(0, 8).map((item) => `${item.level}: ${item.title}`),
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
        '写入策略: 全部写主库分层，风险内容标为待核验',
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
      candidate.markdown.slice(0, 700),
      '确认没问题再 /kb commit ' + candidate.id,
    ].join('\n'));
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
      ...candidates.slice(0, 8).map((item) => `${item.id} | ${item.title}`),
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
  const searchQuery = `${query} HLTV Liquipedia CS2`;
  const live = await webSearch(
    searchQuery,
    Math.max(config.search_timeout_ms || 1500, 1200),
    config.search_cache_seconds ?? 300,
    config.search_negative_cache_seconds ?? 60,
  );
  const localText = local.length > 0 ? formatKnowledgeResults(local, 520) : '本地倾向还没写厚。';
  const liveText = live ? live.slice(0, 520) : '没搜到准信，别硬编。';
  return [
    kind === 'player' ? '选手这块我按本地倾向加实时资料说。' : '队伍这块我按本地倾向加实时资料说。',
    localText,
    `实时参考:\n${liveText}`,
  ].join('\n');
}

async function handleLocalKnowledgeCommand(ctx: PluginContext, config: AIConfig): Promise<boolean> {
  if (ctx.command === 'quote') {
    const query = ctx.args.join(' ').trim();
    const line = getRandomKnowledgeLine('quote', query);
    ctx.reply(line || '这关键词没逮到语录，换个词。');
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
    const gift = ctx.args.join(' ').trim() || '礼物';
    const template = getRandomKnowledgeLine('gift') || '感谢老板的{gift}，这波真有点东西。';
    ctx.reply(template.replace(/\{gift\}/g, gift));
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
const sessionRecentOpeners: Map<string, string[]> = new Map();
const replyCache: Map<string, { value: string; expiresAt: number }> = new Map();
let skippedPassiveReplies = 0;
let deferredCompressions = 0;
let completedCompressions = 0;
let failedCompressions = 0;
let replyCacheHits = 0;
let replyCacheMisses = 0;
let lastReplyTrace: ReplyTrace | null = null;
let lastVoiceTrace: VoiceTrace | null = null;
const directAiCommands = new Set(['ai', 'ask', 'chat']);
const directSearchCommands = new Set(['search', '搜', '搜索']);
const directVisionCommands = new Set(['vision', 'image', 'img', '识图']);
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
  if (!contextManager) {
    contextManager = new ContextManager(
      config.max_context_messages || 50,
      config.context_expire_minutes || 120
    );
  }
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

function formatReplyTrace(trace: ReplyTrace | null): string {
  if (!trace) return '还没有回复 trace。先 @ 一句或跑 /voice test。';
  return [
    '最近回复 trace',
    `时间: ${formatTraceTime(trace.timestamp)}`,
    `会话: ${trace.chatType} ${trace.chatId}${trace.groupId ? ` / group ${trace.groupId}` : ''}`,
    `消息: mid=${trace.messageId} uid=${trace.userId} ${trace.senderName}`,
    `触发: ${trace.triggerReason} forced=${trace.forced}`,
    trace.command ? `命令: /${trace.command}` : '',
    `原文: ${trace.rawTextPreview || '[空/媒体消息]'}`,
    trace.effectiveTextPreview && trace.effectiveTextPreview !== trace.rawTextPreview ? `有效文本: ${trace.effectiveTextPreview}` : '',
    `媒体: 图片${trace.hasImages ? '有' : '无'} 语音${trace.hasRecords ? '有' : '无'} 听写${trace.recordTranscripts}`,
    `队列: 等待${Math.round(trace.queueAgeMs / 1000)}s`,
    `增强: 知识${trace.knowledgeInjected ? `${trace.knowledgeChars}字` : '未注入'}${trace.knowledgeTopic ? '/话题命中' : ''} 搜索${trace.searchUsed ? `${trace.searchChars}字` : '未用'} 识图${trace.visionPayload ? '已传图' : '未传图'}`,
    trace.knowledgeTitles.length > 0 ? `知识分区: ${trace.knowledgeTitles.join(' / ')}` : (trace.forced ? '知识分区: 无命中，建议 /kb stats' : ''),
    trace.openerBefore ? `开头: ${trace.openerBefore} -> ${trace.openerAfter || '[空]'}${trace.openerDeduped ? ' 已去重' : ''}` : '',
    trace.sttError ? `听写错误: ${trace.sttError}` : '',
    trace.visionError ? `识图错误: ${trace.visionError}` : '',
    trace.searchError ? `搜索错误: ${trace.searchError}` : '',
    `语音: ${trace.voiceMode} requested=${trace.voiceRequested} parts=${trace.voiceParts}`,
    `发送: ${trace.sent} cacheHit=${trace.cacheHit} replyLen=${trace.replyLength}`,
    trace.error ? `错误: ${trace.error}` : '',
  ].filter(Boolean).join('\n');
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

function setReplyTrace(trace: ReplyTrace): void {
  lastReplyTrace = trace;
}

function patchReplyTrace(messageId: number, patch: Partial<ReplyTrace>): void {
  if (!lastReplyTrace || lastReplyTrace.messageId !== messageId) return;
  lastReplyTrace = { ...lastReplyTrace, ...patch, timestamp: Date.now() };
}

function extractReplyOpener(text: string): string {
  const normalized = sanitizeOutgoingText(text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const first = normalized.split(/[，,。！？!?；;\s]/).find(Boolean) || normalized;
  return first.slice(0, 12);
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
  if (before && recent.includes(before) && /^(?:可以(?:的)?|这波(?:有说法)?|有点东西|有一说一|先别急|等一下|讲道理|说实话|确实|啊|我看|看了一眼|简单说两句|有点抽象|不是哥们|哥们)$/.test(before)) {
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
    hasRecords: ctx.event.message.some((seg) => seg.type === 'record'),
    recordTranscripts: 0,
    queueAgeMs: 0,
    searchUsed: false,
    searchChars: 0,
    knowledgeInjected: false,
    knowledgeChars: 0,
    knowledgeTopic: false,
    knowledgeTitles: [],
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
    ...pending.slice(0, 5).map((item) => `候选 ${item.id}: ${item.title} (${item.risk}/${item.confidence})`),
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
      const candidate = previewKnowledgeCandidate(source.query, result, `refresh:${source.id}`, {
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

function shouldSearch(config: AIConfig, text: string): boolean {
  if (!config.enable_search || text.length <= 3) return false;
  if (config.search_keywords && config.search_keywords.length > 0) {
    if (includesAnyKeyword(text, config.search_keywords)) return true;
  }
  if (config.search_on_style_query && isKnowledgeTopic(text)) return true;
  return defaultSearchPattern.test(text);
}

async function sendVerbatimVoice(ctx: PluginContext, config: AIConfig, text: string, fallbackMessageId?: number, fallbackUserId?: number): Promise<boolean> {
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
    parts: voiceTexts.length,
    sentParts: 0,
    provider: voiceStatsBefore.provider,
    sendMode: voiceStatsBefore.sendMode,
    lastTtsMode: voiceStatsBefore.lastMode,
  };
  if (!config.enable_tts) {
    const message = '语音没开，这句没法念';
    if (fallbackMessageId && fallbackUserId) ctx.replyQuoteTo(fallbackMessageId, fallbackUserId, message);
    else ctx.reply(message);
    const error = 'enable_tts=false';
    patchReplyTrace(ctx.event.message_id, { sent: 'fallback', error });
    lastVoiceTrace = { ...lastVoiceTrace, timestamp: Date.now(), error };
    return true;
  }
  const ttsNeedsApi = (config.tts_provider || 'api') === 'api' || ((config.tts_provider || 'api') === 'auto' && !(config.tts_local_command || '').trim());
  if (ttsNeedsApi && !hasUsableApiKey(config.api_key)) {
    const message = 'AI接口没配，语音也就别想了';
    if (fallbackMessageId && fallbackUserId) ctx.replyQuoteTo(fallbackMessageId, fallbackUserId, message);
    else ctx.reply(message);
    const error = 'api key missing';
    patchReplyTrace(ctx.event.message_id, { sent: 'fallback', error });
    lastVoiceTrace = { ...lastVoiceTrace, timestamp: Date.now(), error };
    return true;
  }
  let sentAny = false;
  let sentParts = 0;
  let caughtError = '';
  try {
    for (const voiceText of voiceTexts) {
      const voicePath = await withGate('tts', () => generateVoice(config, voiceText), true);
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
  if (sentAny) {
    patchReplyTrace(ctx.event.message_id, { sent: 'voice', voiceParts: sentParts, error: caughtError || undefined });
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
): { reply: boolean; forced: boolean } {
  const directCommand = !!command && directAiCommands.has(command);
  if (directCommand || atBot || replyToBot || isPrivate || isExplicitVoiceReplyRequest(text, command)) {
    return { reply: true, forced: true };
  }
  if (command) {
    return { reply: false, forced: false };
  }

  const styleKeywordHit = includesAnyKeyword(text, [
    config.active_preset,
    '玩机器',
    '机器',
    'MachineWJQ',
    'Machine',
    '6657',
  ]);
  if (styleKeywordHit) {
    return { reply: Math.random() < 0.9, forced: false };
  }

  const keywordHit = includesAnyKeyword(text, config.trigger_keywords);
  if (keywordHit || isKnowledgeTopic(text)) {
    return { reply: Math.random() < (config.related_reply_probability ?? 0.65), forced: false };
  }
  if (isCsDiscussionHint(text) && !isLowInformationPassiveText(text, config)) {
    return { reply: Math.random() < (config.related_reply_probability ?? 0.65), forced: false };
  }

  switch (config.trigger_mode) {
    case 'all':
      return { reply: !isLowInformationPassiveText(text, config), forced: false };
    case 'smart': {
      if (isLowInformationPassiveText(text, config)) {
        return { reply: false, forced: false };
      }
      return { reply: Math.random() < (config.trigger_probability || 0), forced: false };
    }
    case 'at':
    case 'command':
    default:
      return { reply: false, forced: false };
  }
}

function getQueueStats(sessionId: string): { pending: number; forced: number; oldestCreatedAt: number } {
  return groupQueueStats.get(sessionId) || { pending: 0, forced: 0, oldestCreatedAt: 0 };
}

function normalizeCacheText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 500);
}

function makeReplyCacheKey(config: AIConfig, text: string, knowledgeInfo: string): string {
  return crypto
    .createHash('sha1')
    .update([
      config.model,
      config.active_preset,
      config.persona_mode || '',
      config.aggression_level || '',
      normalizeCacheText(text),
      knowledgeInfo.slice(0, 500),
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

function setCachedReply(key: string, value: string, ttlSeconds: number): void {
  if (ttlSeconds <= 0 || !value) return;
  if (replyCache.size > 300) {
    for (const key of [...replyCache.keys()].slice(0, 80)) replyCache.delete(key);
  }
  replyCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function cleanReplyCache(): void {
  const now = Date.now();
  for (const [key, cached] of replyCache) {
    if (cached.expiresAt <= now) replyCache.delete(key);
  }
  if (replyCache.size > 300) {
    for (const key of [...replyCache.keys()].slice(0, replyCache.size - 300)) {
      replyCache.delete(key);
    }
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
  const current = previous.catch(() => {}).then(task);
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
  compressionInFlight.clear();
}

export function getAiChatStats(): {
  sessions: number;
  queuedGroups: number;
  pendingJobs: number;
  forcedJobs: number;
  oldestQueueAgeMs: number;
  skippedPassiveReplies: number;
  replyCacheEntries: number;
  replyCacheHits: number;
  replyCacheMisses: number;
  gates: ReturnType<typeof getGateStats>;
  deferredCompressions: number;
  completedCompressions: number;
  failedCompressions: number;
  lastKnowledgeTitles: string[];
  lastOpenerDeduped: boolean;
  knowledgeAutoIntervalMinutes: number;
  knowledgeAutoRunning: boolean;
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
    replyCacheHits,
    replyCacheMisses,
    gates: getGateStats(),
    deferredCompressions,
    completedCompressions,
    failedCompressions,
    lastKnowledgeTitles: lastReplyTrace?.knowledgeTitles || [],
    lastOpenerDeduped: lastReplyTrace?.openerDeduped === true,
    knowledgeAutoIntervalMinutes,
    knowledgeAutoRunning,
  };
}

export const aiChatPlugin: Plugin = {
  name: 'ai-chat',
  description: 'AI 智能对话 - 玩机器核心',

  handler: async (ctx) => {
    const config = ctx.bot.getConfig().ai;
    if (!config) return false;
    const apiReady = hasUsableApiKey(config.api_key);

    ensureKnowledgeAutoTimer(config);
    ensureMaintenanceTimer();
    const cm = getContextManager(config);
    const sessionId = ctx.isPrivate
      ? `private_${ctx.event.user_id}`
      : `group_${ctx.groupId}`;

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
    if (await handleKnowledgeCommand(ctx, config)) {
      return true;
    }
    if (await handleLocalKnowledgeCommand(ctx, config)) {
      return true;
    }
    if (ctx.command === 'trace') {
      const action = (ctx.args[0] || 'last').toLowerCase();
      if (action === 'last' || action === 'status') {
        ctx.reply(formatReplyTrace(lastReplyTrace));
        return true;
      }
      ctx.reply('/trace last');
      return true;
    }

    // ===== 识图/图片缓存诊断 =====
    if (ctx.command && directVisionCommands.has(ctx.command)) {
      const subCommand = (ctx.args[0] || '').toLowerCase();
      const stats = getImageCacheStats();
      if (!subCommand || subCommand === 'status') {
        ctx.reply([
          '识图状态',
          `开关: ${config.enable_vision ? 'on' : 'off'}`,
          `模型: ${config.vision_model || config.model || '未配置'}`,
          `格式: ${config.vision_payload_mode || 'auto'}`,
          `单次图片: ${config.vision_max_images || 2}`,
          `缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
          `单图上限: ${stats.maxFileMB}MB 跳转${stats.maxRedirects} 清理${stats.cleanupIntervalMinutes}m`,
          ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
          '/vision test <图片URL>',
        ].join('\n'));
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
        const dataUrl = await withGate('vision', () => getImageDataUrl(url));
        const nextStats = getImageCacheStats();
        if (!dataUrl) {
          ctx.reply(`图片下载失败。最近错误: ${nextStats.lastError || 'unknown'}`);
          return true;
        }
        try {
          const result = await withGate('vision', () => callLLMWithRetry(config, [
            { role: 'system', content: '你是识图链路测试器。只用一句中文描述图片里最明显的可见内容；看不清就说看不清，不要编造。' },
            {
              role: 'user',
              content: [
                { type: 'text', text: '请测试识图链路，描述这张图。' },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
              ],
            },
          ], true, 1));
          ctx.reply(`识图OK\n${postProcessReply(result).slice(0, 180)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.reply(`图片下载OK，但视觉模型调用失败: ${message.slice(0, 160)}`);
        }
        return true;
      }
      ctx.reply('/vision status\n/vision test <图片URL>');
      return true;
    }

    // ===== 直接语音命令 =====
    if (ctx.command && directTtsCommands.has(ctx.command)) {
      const subCommand = (ctx.args[0] || '').toLowerCase();
      if (subCommand === 'last') {
        ctx.reply(formatVoiceTrace(lastVoiceTrace, config));
        return true;
      }
      if (subCommand === 'status') {
        const stats = getVoiceStats(config);
        const sttStats = getSttStats(config);
        ctx.reply([
          '语音状态',
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
          `缓存: ${stats.cacheFiles}/${stats.maxCacheFiles}条 ${stats.sizeMB}/${stats.maxCacheMB}MB 命中${stats.hits}/${stats.misses}`,
          `听写缓存: ${sttStats.cacheFiles}/${sttStats.maxCacheFiles}条 ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 命中${sttStats.hits}/${sttStats.misses} 下载失败${sttStats.downloadMisses} 空转写${sttStats.transcriptMisses}`,
          `清理: TTS删${stats.lastCleanupDeleted}/累计${stats.cleanupDeletedTotal} STT删${sttStats.lastCleanupDeleted}/累计${sttStats.cleanupDeletedTotal}`,
          `最长文本: ${stats.maxChars}字`,
          ...(stats.lastMode ? [`最近TTS模式: ${stats.lastMode}`] : []),
          ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
          ...(sttStats.lastError ? [`听写最近错误: ${sttStats.lastError}`] : []),
        ].join('\n'));
        return true;
      }

      if (subCommand === 'clean') {
        cleanVoiceCache(config);
        cleanSttCache(config);
        ctx.reply('语音和听写缓存都清了一遍过期文件。');
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
        const transcripts = await withGate('stt', () => transcribeRecords(config, [input]));
        const sttStats = getSttStats(config);
        ctx.reply(transcripts.length > 0
          ? `听写OK\n${transcripts.join('\n').slice(0, 500)}`
          : `听写失败。最近错误: ${sttStats.lastError || 'unknown'}`);
        return true;
      }

      const text = subCommand === 'test'
        ? (ctx.args.slice(1).join(' ').trim() || '这波语音测试一下。')
        : ctx.args.join(' ').trim();
      if (!text) {
        ctx.reply('/voice <内容>\n/voice status\n/voice last\n/voice test [内容]\n/voice stt <语音URL>\n/voice clean');
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
        ctx.reply('AI接口没配，/ai 现在打不出去。');
        return true;
      }
      if (ctx.isPrivate || isAtBot(ctx.event) || ctx.isReplyToBot) {
        ctx.replyQuote('AI接口没配，我现在只能查本地命令。');
        return true;
      }
      return false;
    }

    // ===== 提取信息 =====
    const senderName = ctx.event.sender.card || ctx.event.sender.nickname;
    const imageUrls = await resolveOneBotImageSources(ctx, ctx.event.message);
    const recordUrls = await resolveOneBotRecordSources(ctx, config, ctx.event.message);
    const hasImages = imageUrls.length > 0;
    const hasRecords = recordUrls.length > 0;
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

    const trigger = forceVoice
      ? { reply: true, forced: true }
      : shouldReply(config, effectiveText, ctx.command, atBot, ctx.isReplyToBot, ctx.isPrivate);

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
      hasRecords: job.hasRecords,
      recordTranscripts: 0,
      queueAgeMs: 0,
      searchUsed: false,
      searchChars: 0,
      knowledgeInjected: false,
      knowledgeChars: 0,
      knowledgeTopic: false,
      knowledgeTitles: [],
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
      let recordTranscripts: string[] = [];
      let apiCurrentMessage: ChatMessage;
      let usesVisionPayload = false;

      try {
        if (job.hasRecords && config.enable_stt && !skipHeavyEnhancements) {
          try {
            recordTranscripts = await withGate('stt', () => transcribeRecords(config, job.recordUrls), job.forced);
          } catch (err) {
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
        });

        const recordTranscriptText = recordTranscripts.join('\n');
        let targetText = buildTargetText(job, recordTranscripts);

        if (job.hasImages && !config.enable_vision) {
          targetText += '\n注意：当前消息含图片，但识图功能未开启。不要假装看到了图片细节，只能按文字上下文回应或请对方补充说明。';
        } else if (job.hasImages && skipHeavyEnhancements) {
          targetText += '\n注意：当前消息含图片，但队列积压已跳过识图。不要假装看到了图片细节，只能按文字上下文回应。';
        }

        if (job.hasImages && config.enable_vision && !skipHeavyEnhancements) {
          const limit = Math.max(1, Math.min(config.vision_max_images || 2, 4));
          const limitedUrls = job.imageUrls.slice(0, limit);
          const dataUrls: string[] = [];
          for (const url of limitedUrls) {
            try {
              const d = await withGate('vision', () => getImageDataUrl(url), job.forced);
              if (d) dataUrls.push(d);
            } catch (err) {
              patchReplyTrace(job.messageId, {
                visionError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
              });
            }
          }

          if (dataUrls.length > 0) {
            const parts: MessageContent[] = [{ type: 'text', text: targetText }];
            for (const dataUrl of dataUrls) {
              parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
            }
            apiCurrentMessage = { role: 'user', content: parts };
            usesVisionPayload = true;
            patchReplyTrace(job.messageId, { visionPayload: true });
            console.log(`[Vision] 群${job.chatId} 成功加载${dataUrls.length}张图(high detail)`);
          } else {
            const imageStats = getImageCacheStats();
            if (imageStats.lastError) patchReplyTrace(job.messageId, { visionError: imageStats.lastError });
            console.error(`[Vision] 群${job.chatId} 图片下载失败 url数=${job.imageUrls.length} 最后错误=${imageStats.lastError}`);
            targetText += '\n注意：当前消息含图片，但图片下载或缓存失败，模型实际上看不到图。不要编造图片细节，可以让对方重发或补充文字。';
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

        // ===== 联网搜索（按需 不阻塞）=====
        let searchInfo = '';
        const searchableText = job.effectiveText || recordTranscriptText;
        if (!skipHeavyEnhancements && shouldSearch(config, searchableText)) {
          try {
            const timeoutMs = config.search_timeout_ms || 1500;
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
            if (result) searchInfo = result.slice(0, 350);
          } catch (err) {
            patchReplyTrace(job.messageId, {
              searchError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
            });
          }
        }
        patchReplyTrace(job.messageId, {
          searchUsed: !!searchInfo,
          searchChars: searchInfo.length,
        });

        const knowledgeQuery = [
          job.effectiveText,
          recordTranscriptText,
          searchInfo,
          ...getKnowledgeKeywords().filter((keyword) => searchableText.toLowerCase().includes(keyword.toLowerCase())),
        ].join('\n');
        const styleQuery = [
          '直播语态 回复铁律 真人化 非公式化 口癖调度 反应强度 上下文定位',
          job.triggerReason,
          job.hasImages ? '识图 图片 场景' : '',
          job.hasRecords ? '语音 听写 场景' : '',
          job.effectiveText,
        ].filter(Boolean).join('\n');
        const hasKnowledgeTopic = isKnowledgeTopic(knowledgeQuery);
        let knowledgeInfo = '';
        if (config.enable_knowledge !== false) {
          const budget = config.knowledge_max_chars || 1800;
          const styleBudget = Math.max(600, Math.floor(budget * (hasKnowledgeTopic ? 0.35 : 0.75)));
          const topicBudget = Math.max(600, budget - styleBudget);
          const styleKnowledge = config.knowledge_force_style === false
            ? selectKnowledge(styleQuery, styleBudget)
            : (selectKnowledge(styleQuery, styleBudget) || selectStyleKnowledge(styleBudget));
          const topicKnowledge = hasKnowledgeTopic ? selectKnowledge(knowledgeQuery, topicBudget) : '';
          knowledgeInfo = buildRuntimeKnowledgeInfo(styleKnowledge, topicKnowledge, job, hasKnowledgeTopic, budget);
          const knowledgeTitles = [
            ...extractKnowledgeTitles(styleKnowledge, 4),
            ...extractKnowledgeTitles(topicKnowledge, 4),
          ].filter((title, index, all) => all.indexOf(title) === index).slice(0, 6);
          patchReplyTrace(job.messageId, { knowledgeTitles });
        }
        patchReplyTrace(job.messageId, {
          knowledgeInjected: !!knowledgeInfo,
          knowledgeChars: knowledgeInfo.length,
          knowledgeTopic: hasKnowledgeTopic,
        });

        // ===== 构建发给API的消息 =====
        // 注意：history是除当前消息外的历史（当前已经append了，需要排除最后一条）
        const sendLimit = config.context_send_messages || 25;
        const history = job.contextMessages.slice(0, -1).slice(-sendLimit); // 排除刚刚追加的当前消息纯文字版
        const systemPrompt = buildSystemPrompt(config);

        const apiMessages = buildApiMessages(systemPrompt, job.contextSummary, history, apiCurrentMessage, searchInfo, knowledgeInfo);

        // ===== 调用 AI =====
        const canUseReplyCache = !job.forced && !job.hasImages && !job.hasRecords && !searchInfo && !!job.effectiveText && (config.ai_reply_cache_seconds ?? 180) > 0;
        const replyCacheKey = canUseReplyCache ? makeReplyCacheKey(config, job.effectiveText, knowledgeInfo) : '';
        let cleaned = replyCacheKey ? getCachedReply(replyCacheKey) : null;
        const cacheHit = !!cleaned;
        if (!cleaned) {
          if (replyCacheKey) replyCacheMisses++;
          const maxAttempts = job.forced ? 4 : 2;
          const reply = await withGate('ai', () => callLLMWithRetry(config, apiMessages, usesVisionPayload, maxAttempts), job.forced);
          cleaned = postProcessReply(reply);
          if (replyCacheKey && cleaned) {
            setCachedReply(replyCacheKey, cleaned, config.ai_reply_cache_seconds ?? 180);
          }
        }

        if (!cleaned) {
          // 无论forced与否 空回复就不发 消息已存上下文 下次自然带上
          return;
        }
        const openerResult = dedupeSessionOpener(job.sessionId, cleaned);
        cleaned = openerResult.text;
        patchReplyTrace(job.messageId, {
          cacheHit,
          replyLength: cleaned.length,
          openerBefore: openerResult.before,
          openerAfter: openerResult.after,
          openerDeduped: openerResult.deduped,
        });

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
        const shouldSendVoice = voiceAllowed && (job.forceVoice || (!job.forced && Math.random() < (config.tts_probability || 0.15)));
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
            parts: 1,
            sentParts: 0,
            provider: voiceStatsBefore.provider,
            sendMode: voiceStatsBefore.sendMode,
            lastTtsMode: voiceStatsBefore.lastMode,
          };
          try {
            const voicePath = await withGate('tts', () => generateVoice(config, finalText), job.forced || job.forceVoice);
            if (voicePath) {
              // QQ/NapCat 对 reply + record 组合兼容性差，部分客户端会显示但无法播放。
              // 语音消息保持纯 record；只有文本兜底才引用原消息。
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
          }
        }

        if (!sentVoice) {
          if (job.forceVoice) {
            cleaned = `语音这下没生成出来 ${cleaned}`;
          }
          if (useQuote) {
            ctx.replyQuoteTo(job.messageId, job.userId, cleaned);
          } else {
            ctx.reply(cleaned);
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
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[AI][${job.chatType}${job.chatId}] 失败:`, errMsg);
        patchReplyTrace(job.messageId, {
          sent: job.forced ? 'fallback' : 'skipped',
          error: errMsg.slice(0, 160),
        });
        if (job.forced) {
          const fb = forcedFallbackReply(job, recordTranscripts);
          if (fb) ctx.replyQuoteTo(job.messageId, job.userId, fb);
        }
      }
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AI][${job.chatType}${job.chatId}] 队列异常:`, errMsg);
      if (job.forced) {
        // 不回复 消息已在上下文里 下次触发时AI自然能看到
      }
    });

    return true;
  },
};
