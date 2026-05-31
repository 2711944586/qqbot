import { Plugin, PluginContext, AIConfig, MessageEvent, MessageSegment } from '../types';
import { Bot } from '../bot';
import { hasUsableApiKey } from '../config';
import { cleanSearchCache, configureSearchCache, webSearch } from './web-search';
import { cleanVoiceCache, generateVoice, getVoiceStats, installVoiceSample, removeVoiceSample } from './tts';
import { cleanSttCache, getSttStats, transcribeRecords } from './stt';
import { cleanupCache as cleanImageCache, configureImageCache, getCacheStats as getImageCacheStats, getImageDataUrl } from './image-cache';
import { configureGates, getGateStats, withGate } from './concurrency';
import { sanitizeOutgoingText } from '../message-sanitize';
import { detectFuzzyCommand, detectCsTopicQuery } from './fuzzy-command';
import { fetchOngoingMatches, fetchTeamRanking, fetchRecentResults } from './hltv-api';
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
  parseFaceMarkers,
} from './reply-postprocess';
import { parseStickerMarkers } from './sticker-pack';
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
  hltvUsed?: boolean;
  hltvChars?: number;
  hltvError?: string;
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
  similarMemories?: string,
): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (knowledgeInfo) {
    result.push({ role: 'system', content: `[临场笔记]\n${knowledgeInfo}` });
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
  const openerHint = recentOpeners ? `\n【提示】别复读这些开头: ${recentOpeners.replace(/\n/g, ' / ')}` : '';

  // 用清晰的标记包裹当前消息让模型不混淆
  const mediaText = mediaHints.length > 0 ? ' ' + mediaHints.join(' ') : '';
  return `===现在你要回复这一条===\n${job.senderName}: ${body}${mediaText}\n===\n只回应这个人这句话 不要替历史里其他人补答${openerHint}`;
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
    '[表情和QQ表情包 - 克制 + 用名字]',
    '- 玩机器在直播里很少用 emoji，主要靠语气和判断说话，不堆表情包',
    '- 默认不加 emoji 也不加 [face:N]，只在情绪强烈/语境契合时加 1 个',
    '- 用中文/英文名字直接写：[呲牙] [笑哭] [喷血] [思考] [鄙视] [吃瓜] [666] [打脸]',
    '  也可用经典数字：[face:178] [face:101] [face:32]',
    '- 真的好笑/惊讶/离谱才用，每条最多 1-2 个',
    '- 不要每条都加表情，别在跟主题无关的位置甩一个',
    '- 如果加表情，写在合适的位置（一般在句尾或情绪转折处），不是机械塞',
    '',
    '- 例子（恰当）：',
    '    "这操作太脏了 [呲牙]"',
    '    "你这把真的有点东西 [笑哭]"',
    '    "这都能赢? [思考]"',
    '    "别开香槟 [让我看看]"',
    '- 例子（错误）：',
    '    "[呲牙] 我觉得这队还行 [笑哭] [666]"  ← 塞太多',
    '    "[摸鱼] 你说得对"  ← 跟主题不合',
    '    每句结尾都自动塞一个 emoji ← 公式化',
    '',
    '- 常用名字: 呲牙 微笑 笑哭 哈哈 思考 疑问 吃瓜 让我看看 666 OK 强 喷血 打脸 摸鱼 抓狂 晕 流泪 坏笑 可爱 酷 尴尬 调皮 鼓掌 加油 柠檬精 我酸了 鄙视 委屈 阴险 亲亲',
    '',
    '[玩机器真实语态 - 学这个语气]',
    '直播间里玩机器是这样说话的，模仿这个语感、长度、断句、嘴硬感：',
    '',
    '场景: 看到选手 1v3 翻盘',
    '玩机器: "哦哦哦！翻了翻了！这怎么翻的兄弟"',
    '玩机器: "你这把可以吹一年知道吗"',
    '玩机器: "这种残局都能赢，今天必须给他刷一波"',
    '',
    '场景: 看到失误送掉',
    '玩机器: "你认真的吗哥"',
    '玩机器: "这枪给的 离谱"',
    '玩机器: "这下默认控图给到对面了 不是哥们"',
    '玩机器: "你这站位放天梯都过不了夜"',
    '',
    '场景: 看到精彩 ace',
    '玩机器: "太c了 真的太c了"',
    '玩机器: "这个人不是人 这是机器"',
    '玩机器: "秀啊 这波直接秀穿了"',
    '',
    '场景: 解说优势局被翻',
    '玩机器: "先别开香槟"',
    '玩机器: "这把已经开始不对劲了"',
    '玩机器: "我说什么来着 CS这游戏最怕你觉得稳"',
    '',
    '场景: 弹幕嘴硬',
    '玩机器: "你这话说得像没看比赛"',
    '玩机器: "你认真的吗 你再想想"',
    '玩机器: "饶了我吧 这都能反驳"',
    '',
    '场景: 经济局白给',
    '玩机器: "这经济强起也是没办法"',
    '玩机器: "打不过打不过 别打了"',
    '玩机器: "保枪不丢人 你这是直接送"',
    '',
    '场景: 评价选手',
    '玩机器: "ZywOo 这数据看着稳 节奏跟不上有时候"',
    '玩机器: "donk 状态来了真的没人挡得住 但波动大"',
    '玩机器: "NiKo 老登嘴硬归嘴硬 关键局确实差点意思"',
    '玩机器: "ropz 不一定最炸 但你回头他已经在你家了"',
    '',
    '场景: 礼物/感谢',
    '玩机器: "老板大气 这一发够下一把买P90"',
    '玩机器: "差不多得了 别送了 我顶不住"',
    '玩机器: "感谢老板 这礼物到位"',
    '',
    '场景: 被问bot身份',
    '玩机器: "我直接好家伙 这都看得出来？"',
    '玩机器: "你管我是不是 接着说事"',
    '玩机器: "想多了 直接打字"',
    '',
    '风格特点：',
    '- 第一句直接接情绪/判断 不铺垫不解释',
    '- 句子短 多用并列 少用从句',
    '- 嘴硬带分析 不是纯反驳',
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
  // API失败但用户是@/回复/私聊时，给个有人味的延迟回复，不要消失
  // 但不要每次都说同一句，避免用户觉得是模板
  const fallbacks = [
    '我这卡了一下 你再说一遍',
    '诶 网络有点抽 重新发一下',
    '等等 我刚才没接住',
    '哥们 我顿了一下 你那条是啥',
    '稍等 我现在脑子不太转',
    '我看了一眼 你那条没看清 你重发',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
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
/** 群最近消息时间戳列表（最多保留最近 60 秒内）- 用于"群聊正在快速对话"的检测 */
const recentGroupMessages: Map<string, number[]> = new Map();
const sessionRecentOpeners: Map<string, string[]> = new Map();
/** 每个 session 最近 5 条 bot 回复（标准化后），用于全句去重 */
const sessionRecentReplies: Map<string, string[]> = new Map();
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
    trace.hltvUsed ? `HLTV实时: 已注入${trace.hltvChars}字` : '',
    trace.hltvError ? `HLTV错误: ${trace.hltvError}` : '',
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

/** 标准化 bot 回复用于全句去重比较 */
function normalizeForReplyDedup(text: string): string {
  return sanitizeOutgoingText(text)
    .toLowerCase()
    .replace(/\[(?:face|表情|emoji|qq)[:：]\d+\]/gi, '')
    .replace(/[\s，。！？,.!?；;、]/g, '')
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, '')
    .slice(0, 80);
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

function shouldSearch(config: AIConfig, text: string): boolean {
  if (!config.enable_search || text.length <= 3) return false;

  // 强制搜索的话题模式：任何疑问句 + 实时性 / 事实性 词汇
  // "现在/今天/最近/最新/谁/哪/是不是/几" + 任何主语
  const factualQueryPattern = /(?:现在|今天|最近|最新|当前|目前|今年|今晚|昨天|前天|上周|这周|本月|去年|刚才)[^。？\s]{0,15}(?:谁|哪|什么|怎么样|多少|几|有没有|是不是)|(?:谁|哪个|什么时候|多少|几比几|哪场|哪场|什么队|什么队伍|什么人)|(?:发生|爆发|开打|开赛|公布|更新|发布|确认|官宣|宣布)/;
  if (factualQueryPattern.test(text)) return true;

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

  // 群聊正在快速对话时（30秒内超过3条人工消息），不主动插话
  // 仅 @/回复/私聊/命令/明确语音请求 这些 forced 场景才能突破这个限制（已在上面 return 了）
  if (groupChatBusy) {
    return { reply: false, forced: false };
  }

  // bot 自己刚回过话 30s 内：被动接话概率打 5 折
  const selfCoolMultiplier = selfRecentlyReplied ? 0.5 : 1.0;

  const styleKeywordHit = includesAnyKeyword(text, [
    config.active_preset,
    '玩机器',
    '机器',
    'MachineWJQ',
    'Machine',
    '6657',
  ]);
  if (styleKeywordHit) {
    // 风格关键词（明确点名玩机器）：群聊忙时也不接话；不忙时降到 50%
    return { reply: Math.random() < 0.5 * selfCoolMultiplier, forced: false };
  }

  const keywordHit = includesAnyKeyword(text, config.trigger_keywords);
  if (keywordHit || isKnowledgeTopic(text)) {
    // 普通CS/玩机器关键词：被动主动接话概率从 0.65 降到 0.15
    return { reply: Math.random() < (config.related_reply_probability ?? 0.15) * selfCoolMultiplier, forced: false };
  }
  if (isCsDiscussionHint(text) && !isLowInformationPassiveText(text, config)) {
    return { reply: Math.random() < (config.related_reply_probability ?? 0.15) * selfCoolMultiplier, forced: false };
  }

  switch (config.trigger_mode) {
    case 'all':
      return { reply: !isLowInformationPassiveText(text, config), forced: false };
    case 'smart': {
      if (isLowInformationPassiveText(text, config)) {
        return { reply: false, forced: false };
      }
      // 完全无关键词的随机插话：默认极低（0.005）
      return { reply: Math.random() < (config.trigger_probability || 0) * selfCoolMultiplier, forced: false };
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

    // ===== 中文模糊命令分发 - 仅当不是显式 /xxx 命令时 =====
    const fuzzyCmd = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());

    // ===== Voice Clone 模糊触发 =====
    if (fuzzyCmd === 'voice_clone' || fuzzyCmd === 'voice_clone_status' || fuzzyCmd === 'voice_clone_reset') {
      // 状态查询
      if (fuzzyCmd === 'voice_clone_status') {
        const stats = getVoiceStats(config);
        if (stats.cloneReady) {
          ctx.replyAt([
            '🎤 Voice Clone 已学好',
            `样本大小: ${stats.sampleSizeMB}MB`,
            '想换 → 直接发语音 + 学一下我的声音',
            '想清空 → 不用我的声音了 (需 admin)',
          ].join('\n'));
        } else {
          ctx.replyAt([
            '🎤 还没学过声音',
            `状态: ${stats.sampleReason || '未配置'}`,
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
      cm.clearSession(sessionId);
      sessionRecentOpeners.delete(sessionId);
      sessionRecentReplies.delete(sessionId);
      lastReplyAt.delete(sessionId);
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
        // 如果消息附带图片，顺便测试 get_image 解析
        let attachedInfo = '';
        const attachedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
        if (attachedImages.length > 0) {
          const lines = attachedImages.slice(0, 2).map((s, i) => {
            let kind = 'url';
            if (s.startsWith('base64://')) kind = 'base64';
            else if (s.startsWith('file://')) kind = 'file';
            else if (s.startsWith('data:')) kind = 'data';
            return `  [${i}] ${kind}: ${s.slice(0, 80)}${s.length > 80 ? '...' : ''}`;
          });
          attachedInfo = '\n附带图片源:\n' + lines.join('\n');
        }
        ctx.reply([
          '识图状态',
          `开关: ${config.enable_vision ? 'on' : 'off'}`,
          `模型: ${config.vision_model || config.model || '未配置'}`,
          `格式: ${config.vision_payload_mode || 'auto'}`,
          `单次图片: ${config.vision_max_images || 2}`,
          `缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
          `单图上限: ${stats.maxFileMB}MB 跳转${stats.maxRedirects} 清理${stats.cleanupIntervalMinutes}m`,
          ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
          attachedInfo,
          '/vision test <图片URL>',
          '提示: 直接发图+/vision test 也可以诊断',
        ].filter(Boolean).join('\n'));
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
              '',
              '清空: /voice clone reset (admin)',
              '更新: /voice clone <音频附件> 或 /voice clone <https URL>',
            ].join('\n'));
          } else {
            ctx.reply([
              '🎤 Voice Clone 状态',
              `样本: ${stats.samplePath}`,
              `状态: ❌ ${stats.sampleReason || '不可用'}`,
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
        ctx.reply('/voice <内容>\n/voice status\n/voice last\n/voice test [内容]\n/voice stt <语音URL>\n/voice clone [URL或附件] - 安装克隆样本\n/voice clean');
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

    // 记录群消息频率，判断"群里正在快速对话中"
    const groupChatBusy = recordAndCheckBusy(sessionId, ctx.isPrivate);

    // bot 自己刚回过话(30s内)：被动接话进一步降低
    const lastSelfReply = lastReplyAt.get(sessionId) || 0;
    const selfRecentlyReplied = !ctx.isPrivate && Date.now() - lastSelfReply < 30_000;

    const trigger = forceVoice
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

          // 兜底1：若全部 URL 下载失败，尝试通过 get_msg 重新拉消息（NapCat会重新生成下载URL）
          if (dataUrls.length === 0 && limitedUrls.length > 0 && ctx.event.message_id) {
            try {
              console.warn(`[Vision] 群${job.chatId} 一阶段失败，尝试 get_msg 重取`);
              const msgRes = await ctx.bot.callApiAsync('get_msg', { message_id: ctx.event.message_id }, 6000);
              const msgData = (msgRes as any)?.data || msgRes;
              const msgSegs = Array.isArray(msgData?.message) ? msgData.message : [];
              const reextracted: string[] = [];
              for (const seg of msgSegs) {
                if (seg && seg.type === 'image' && seg.data) {
                  const u = seg.data.url || seg.data.file;
                  if (typeof u === 'string' && u) reextracted.push(u);
                }
              }
              if (reextracted.length > 0) {
                const reresolved = await resolveOneBotImageSources(ctx, msgSegs);
                for (const r of reresolved.slice(0, limit)) {
                  try {
                    const d = await withGate('vision', () => getImageDataUrl(r), job.forced);
                    if (d) dataUrls.push(d);
                  } catch { /* */ }
                }
                if (dataUrls.length > 0) {
                  console.log(`[Vision] 群${job.chatId} get_msg 兜底成功 拿到${dataUrls.length}张图`);
                }
              }
            } catch (err) {
              console.warn(`[Vision] get_msg兜底也失败 ${err instanceof Error ? err.message : err}`);
            }
          }

          // 兜底2：直接调 NapCat 的 get_image / get_file 拿 base64
          // 用原始消息段里的 file 字段（image cache key）
          if (dataUrls.length === 0 && limitedUrls.length > 0) {
            try {
              const rawFiles: string[] = [];
              for (const seg of ctx.event.message) {
                if (seg.type === 'image' && seg.data) {
                  const f = seg.data.file || seg.data.url;
                  if (typeof f === 'string' && f) rawFiles.push(f);
                }
              }
              for (const rawFile of rawFiles.slice(0, limit)) {
                // 试 get_image 拿 base64
                try {
                  const r = await ctx.bot.callApiAsync('get_image', { file: rawFile }, 8000);
                  const d = (r as any)?.data || r;
                  const b64 = d?.base64 || d?.b64 || d?.base64_file || d?.file_base64;
                  if (typeof b64 === 'string' && b64.length > 100) {
                    const cleaned = b64.replace(/\s+/g, '');
                    if (/^[A-Za-z0-9+/_=-]+$/.test(cleaned)) {
                      const fp = `data:image/jpeg;base64,${cleaned}`;
                      dataUrls.push(fp);
                      console.log(`[Vision] 群${job.chatId} get_image base64 兜底成功 size=${cleaned.length}`);
                      continue;
                    }
                  }
                } catch (e) { /* try next */ }
                // 试 get_file（NapCat 专属）
                try {
                  const r = await ctx.bot.callApiAsync('get_file', { file_id: rawFile, file: rawFile }, 8000);
                  const d = (r as any)?.data || r;
                  const b64 = d?.base64 || d?.b64;
                  if (typeof b64 === 'string' && b64.length > 100) {
                    const cleaned = b64.replace(/\s+/g, '');
                    if (/^[A-Za-z0-9+/_=-]+$/.test(cleaned)) {
                      dataUrls.push(`data:image/jpeg;base64,${cleaned}`);
                      console.log(`[Vision] 群${job.chatId} get_file base64 兜底成功`);
                    }
                  }
                } catch { /* */ }
              }
            } catch (err) {
              console.warn(`[Vision] get_image/get_file 兜底失败 ${err instanceof Error ? err.message : err}`);
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
            targetText += `\n注意：当前消息含${job.imageUrls.length}张图片，但图片下载失败(${(imageStats.lastError || 'unknown').slice(0, 50)})，模型实际上看不到图。不要编造图片细节，可以让对方重发或补充文字。`;
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
            if (result) searchInfo = result.slice(0, 1000);
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

        // ===== HLTV 实时数据注入（CS 话题强增强） =====
        // 当用户问到比赛/排名/战报时，主动抓 HLTV 注入到 searchInfo 里，覆盖训练数据老旧的问题
        let hltvInfo = '';
        if (!skipHeavyEnhancements && searchableText) {
          const csTopic = detectCsTopicQuery(searchableText);
          const fetches: Promise<string>[] = [];
          const labels: string[] = [];
          if (csTopic.needsMatches) { fetches.push(fetchOngoingMatches()); labels.push('当前比赛'); }
          if (csTopic.needsRanking) { fetches.push(fetchTeamRanking()); labels.push('HLTV排名'); }
          if (csTopic.needsResults) { fetches.push(fetchRecentResults()); labels.push('最近战报'); }

          // ===== 针对选手/队伍的专项搜索 =====
          // 当消息中提到具体选手或队伍名 + 实时性词，做一次定向 webSearch
          const playerOrTeamMatch = searchableText.match(/\b(zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|玩机器|6657)\b/i);
          const realtimeIntent = /(?:现在|最近|今天|当前|最新|状态|表现|怎么样|怎样|表现如何|战绩|阵容|转会)/.test(searchableText);
          if (playerOrTeamMatch && realtimeIntent) {
            const target = playerOrTeamMatch[1];
            fetches.push(
              webSearch(`${target} CS2 latest news 2026 status roster`, 4000, 600, 60).catch(() => '')
            );
            labels.push(`${target}最新`);
          }

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
              patchReplyTrace(job.messageId, {
                hltvError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
              });
            }
          }
        }
        patchReplyTrace(job.messageId, {
          hltvUsed: !!hltvInfo,
          hltvChars: hltvInfo.length,
        });

        // 把 HLTV 数据合并进 searchInfo（前置，权重更高）
        if (hltvInfo) {
          searchInfo = searchInfo
            ? `[HLTV实时数据]\n${hltvInfo}\n\n[联网补充]\n${searchInfo}`
            : `[HLTV实时数据]\n${hltvInfo}`;
        }


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
        const rawHistory = job.contextMessages.slice(0, -1).slice(-sendLimit);
        // 清理history里的 [mid=X uid=Y] 元数据前缀，让模型看到干净的对话
        const history: ChatMessage[] = rawHistory.map((msg) => {
          if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
          const cleaned = msg.content.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '');
          return { role: msg.role, content: cleaned };
        });
        const systemPrompt = buildSystemPrompt(config);

        // 检索相似历史（基于当前消息文本）- 仅当有有意义的查询文本时
        let similarMemories = '';
        if (job.effectiveText && job.effectiveText.length >= 4) {
          try {
            const recent = cm.retrieveSimilar(job.sessionId, job.effectiveText, 3);
            // 过滤掉与最近history已经包含的重复
            const recentTextSet = new Set(history.slice(-10).map((m) => typeof m.content === 'string' ? m.content : '').filter(Boolean));
            const useful = recent.filter((r) => r.similarity >= 0.2 && !recentTextSet.has(r.text)).slice(0, 2);
            if (useful.length > 0) {
              similarMemories = useful
                .map((r) => `[${r.role}] ${r.text.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '').slice(0, 200)}`)
                .join('\n');
            }
          } catch { /* 失败不阻塞 */ }
        }

        const apiMessages = buildApiMessages(systemPrompt, job.contextSummary, history, apiCurrentMessage, searchInfo, knowledgeInfo, similarMemories);

        // ===== 调用 AI =====
        // 时间/日期类问题永远不缓存（因为答案随时间变化）
        const isTimeSensitive = /(?:今天|今日|现在|当前|此刻|此时|目前|今晚|今早|今夜|刚才|几号|几点|几月|星期|周[一二三四五六日天])/.test(job.effectiveText || '');
        const canUseReplyCache = !job.forced && !job.hasImages && !job.hasRecords && !searchInfo && !!job.effectiveText && !isTimeSensitive && (config.ai_reply_cache_seconds ?? 180) > 0;
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

        // 全句去重检查 - 如果跟最近 5 条 bot 回复内容重复，重新生成一次
        if (isRecentReplyDuplicate(job.sessionId, cleaned) && !cacheHit) {
          console.log(`[AI][${job.chatType}${job.chatId}] 检测到重复回复，重新生成 origin="${cleaned.slice(0, 30)}"`);
          try {
            const retryMessages: ChatMessage[] = [
              ...apiMessages,
              { role: 'assistant', content: cleaned },
              { role: 'user', content: '这条跟你之前说过的太像了，换个角度或换种说法，别重复。' },
            ];
            const retryReply = await withGate('ai', () => callLLMWithRetry(config, retryMessages, usesVisionPayload, 1), job.forced);
            const retryCleaned = postProcessReply(retryReply);
            if (retryCleaned && !isRecentReplyDuplicate(job.sessionId, retryCleaned)) {
              cleaned = retryCleaned;
              patchReplyTrace(job.messageId, { sent: 'queued', replyLength: cleaned.length });
            }
          } catch { /* 失败就用原文 */ }
        }
        recordRecentReply(job.sessionId, cleaned);

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
          // 解析 [face:N] / 命名表情 / [sticker:N] 标记，转换成 QQ 表情段
          // parseStickerMarkers 是更全面的（含命名表情和本地表情包），parseFaceMarkers 只支持数字
          const faceSegments = parseStickerMarkers(cleaned) || parseFaceMarkers(cleaned);
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
