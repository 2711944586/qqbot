import { Bot } from '../bot';
import { AIConfig, NoticeEvent } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';
import { generateVoice, getVoiceStats, inspectVoiceCache } from './tts';
import { voiceRecordSegment } from './media-utils';

interface GiftNotice extends NoticeEvent {
  sender_id?: number;
  target_id?: number;
  receiver_id?: number;
  recipient_id?: number;
  gift_id?: number | string;
  gift_name?: string;
  gift_count?: number | string;
  count?: number | string;
}

const giftKeywords = [
  'gift',
  'present',
  'flower',
  'like',
  'redbag',
  'red_packet',
  'hongbao',
  '礼物',
];

const fallbackGiftLines = [
  '感谢老板的{gift}，这波真有点东西。',
  '老板大气，{gift}收到。',
  '这礼物可以，老板今天状态拉满。',
  '感谢感谢，{gift}到位了。',
  '老板这波支援很关键。',
];

const comboGiftLines = [
  '感谢老板{gift}连送，这波经济直接拉满。',
  '老板大气，{gift}连上了，直播间有声音了。',
  '{gift}这一下到位了，士气直接起。',
  '感谢老板，{gift}这一串真有说法。',
];

const bigGiftLines = [
  '感谢老板{gift}，这力度不是小礼物了。',
  '老板大气，{gift}到位，这把得认真打。',
  '{gift}收到，经济直接起飞，老板真顶。',
  '感谢老板，这{gift}可以开香槟但先别急。',
];

interface GiftComboSummary {
  eventCount: number;
  totalCount: number;
  giftKinds: string[];
}

interface GiftComboState extends GiftComboSummary {
  firstAt: number;
  lastAt: number;
}

interface GiftThanksScenario {
  safeGift: string;
  safeCount: number;
  safeCombo: GiftComboSummary;
  intensity: 'normal' | 'combo' | 'big';
  text: string;
}

interface GiftTrace {
  id: number;
  timestamp: number;
  groupId: number;
  senderId: number;
  targetId: number;
  gift: string;
  count: number;
  comboEvents: number;
  comboTotal: number;
  action: 'sent' | 'throttled' | 'ignored';
  reason: string;
  text: string;
  voiceAction: 'none' | 'queued' | 'sent' | 'skipped' | 'failed';
  voiceReason: string;
  voiceCacheBefore?: string;
  voiceCacheAfter?: string;
}

const recentThanks: Map<string, number> = new Map();
const recentGiftCombos: Map<string, GiftComboState> = new Map();
const recentGiftVoiceAt: Map<number, number> = new Map();
const GIFT_COMBO_WINDOW_MS = 45 * 1000;
const MAX_GIFT_TRACES = 20;
let totalGiftNotices = 0;
let sentThanks = 0;
let throttledThanks = 0;
let ignoredThanks = 0;
let giftVoiceAttempts = 0;
let giftVoiceSent = 0;
let giftVoiceSkipped = 0;
let giftVoiceFailures = 0;
let giftTraceSeq = 0;
let lastGiftTrace: GiftTrace | null = null;
const recentGiftTraces: GiftTrace[] = [];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickWithSeed<T>(items: T[], seed?: string): T {
  if (!seed) return pick(items);
  return items[stableHash(seed) % items.length];
}

function isGiftNotice(notice: GiftNotice): boolean {
  const subType = String(notice.sub_type || '').toLowerCase();
  const noticeType = String(notice.notice_type || '').toLowerCase();
  if (giftKeywords.some((keyword) => subType.includes(keyword) || noticeType.includes(keyword))) return true;
  return notice.gift_id !== undefined || notice.gift_name !== undefined || notice.gift_count !== undefined;
}

function numberField(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function giftSender(notice: GiftNotice): number {
  return numberField(notice.sender_id) || numberField(notice.user_id);
}

function giftTarget(notice: GiftNotice): number {
  return numberField(notice.target_id) || numberField(notice.receiver_id) || numberField(notice.recipient_id);
}

function giftName(notice: GiftNotice): string {
  const name = String(notice.gift_name || '').trim();
  if (name) return normalizeGiftName(name);
  const id = String(notice.gift_id || '').trim();
  return id ? `礼物${id.slice(0, 16)}` : '礼物';
}

function giftCount(notice: GiftNotice): number {
  return numberField(notice.gift_count) || numberField(notice.count) || 1;
}

function normalizeGiftName(value: string): string {
  return (value || '礼物')
    .replace(/\s+/g, ' ')
    .replace(/[<>`]/g, '')
    .trim()
    .slice(0, 24) || '礼物';
}

function normalizeGiftCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.floor(value), 9999));
}

function giftIntensity(count: number): 'normal' | 'combo' | 'big' {
  if (count >= 20) return 'big';
  if (count >= 5) return 'combo';
  return 'normal';
}

function comboIntensity(count: number, combo?: GiftComboSummary): 'normal' | 'combo' | 'big' {
  const base = giftIntensity(count);
  if (!combo) return base;
  if (base === 'big' || combo.totalCount >= 20 || combo.eventCount >= 4) return 'big';
  if (base === 'combo' || combo.totalCount >= 5 || combo.eventCount >= 2) return 'combo';
  return 'normal';
}

function rememberGiftCombo(groupId: number, senderId: number, gift: string, count: number): GiftComboSummary {
  const key = `${groupId}:${senderId}`;
  const now = Date.now();
  const safeGift = normalizeGiftName(gift);
  const safeCount = normalizeGiftCount(count);
  const previous = recentGiftCombos.get(key);
  const expired = !previous || now - previous.lastAt > GIFT_COMBO_WINDOW_MS;
  const giftKinds = expired
    ? [safeGift]
    : [safeGift, ...previous.giftKinds.filter((item) => item !== safeGift)].slice(0, 5);
  const next: GiftComboState = {
    firstAt: expired ? now : previous.firstAt,
    lastAt: now,
    eventCount: expired ? 1 : previous.eventCount + 1,
    totalCount: expired ? safeCount : previous.totalCount + safeCount,
    giftKinds,
  };
  recentGiftCombos.set(key, next);

  if (recentGiftCombos.size > 300) {
    const cutoff = now - 30 * 60 * 1000;
    for (const [k, state] of recentGiftCombos) {
      if (state.lastAt < cutoff) recentGiftCombos.delete(k);
    }
  }

  return {
    eventCount: next.eventCount,
    totalCount: next.totalCount,
    giftKinds: [...next.giftKinds],
  };
}

function shouldThrottle(groupId: number, senderId: number, gift: string): boolean {
  const key = `${groupId}:${senderId}:${gift}`;
  const now = Date.now();
  const lastAt = recentThanks.get(key) || 0;
  recentThanks.set(key, now);

  if (recentThanks.size > 300) {
    const cutoff = now - 30 * 60 * 1000;
    for (const [k, timestamp] of recentThanks) {
      if (timestamp < cutoff) recentThanks.delete(k);
    }
  }

  return now - lastAt < 20 * 1000;
}

function shouldQueueGiftVoice(
  config: AIConfig,
  groupId: number,
  count: number,
  combo?: GiftComboSummary,
): { ok: boolean; reason: string } {
  const decision = inspectGiftVoiceDecision(config, groupId, count, combo);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const probability = Math.max(0, Math.min(config.gift_voice_probability ?? 0.28, 1));
  if (probability < 1 && Math.random() > probability) return { ok: false, reason: 'probability skip' };

  const now = Date.now();
  recentGiftVoiceAt.set(groupId, now);
  return { ok: true, reason: decision.reason };
}

function inspectGiftVoiceDecision(
  config: AIConfig,
  groupId: number,
  count: number,
  combo?: GiftComboSummary,
): { ok: boolean; reason: string; detail: string } {
  if (config.gift_voice_enabled === false) return { ok: false, reason: 'gift voice off', detail: '礼物语音关闭' };
  if (!config.enable_tts) return { ok: false, reason: 'tts off', detail: 'TTS 没开' };

  const minEvents = Math.max(1, config.gift_voice_min_combo_events || 2);
  const minTotal = Math.max(1, config.gift_voice_min_total_count || 8);
  const comboEvents = combo?.eventCount || 1;
  const totalCount = Math.max(normalizeGiftCount(count), combo?.totalCount || 0);
  if (comboEvents < minEvents && totalCount < minTotal) {
    return {
      ok: false,
      reason: `below threshold ${comboEvents}/${totalCount}`,
      detail: `未到门槛 连送${comboEvents}/${minEvents} 总量${totalCount}/${minTotal}`,
    };
  }

  const now = Date.now();
  const cooldownMs = Math.max(0, config.gift_voice_cooldown_seconds ?? 180) * 1000;
  const lastAt = groupId ? recentGiftVoiceAt.get(groupId) || 0 : 0;
  if (cooldownMs > 0 && lastAt > 0 && now - lastAt < cooldownMs) {
    const remain = Math.ceil((cooldownMs - (now - lastAt)) / 1000);
    return { ok: false, reason: `cooldown ${remain}s`, detail: `同群礼物语音冷却中，还剩${remain}s` };
  }

  const probability = Math.max(0, Math.min(config.gift_voice_probability ?? 0.28, 1));
  if (probability <= 0) return { ok: false, reason: 'probability 0', detail: '语音概率为0' };
  const reason = comboEvents >= minEvents ? 'combo' : 'big gift';
  const probabilityText = probability >= 1 ? '必发' : `会按${Math.round(probability * 100)}%概率抽签`;
  return { ok: true, reason, detail: `${reason === 'combo' ? '连送达标' : '大额达标'}，${probabilityText}` };
}

function giftVoiceGateSnapshot(
  config: AIConfig,
  groupId: number,
  count: number,
  combo?: GiftComboSummary,
): {
  comboEvents: number;
  totalCount: number;
  minEvents: number;
  minTotal: number;
  cooldownSeconds: number;
  cooldownRemain: number;
  probability: number;
} {
  const minEvents = Math.max(1, config.gift_voice_min_combo_events || 2);
  const minTotal = Math.max(1, config.gift_voice_min_total_count || 8);
  const comboEvents = combo?.eventCount || 1;
  const totalCount = Math.max(normalizeGiftCount(count), combo?.totalCount || 0);
  const cooldownSeconds = Math.max(0, config.gift_voice_cooldown_seconds ?? 180);
  const lastAt = groupId ? recentGiftVoiceAt.get(groupId) || 0 : 0;
  const cooldownRemain = cooldownSeconds > 0 && lastAt > 0
    ? Math.max(0, Math.ceil((cooldownSeconds * 1000 - (Date.now() - lastAt)) / 1000))
    : 0;
  return {
    comboEvents,
    totalCount,
    minEvents,
    minTotal,
    cooldownSeconds,
    cooldownRemain,
    probability: Math.max(0, Math.min(config.gift_voice_probability ?? 0.28, 1)),
  };
}

function formatGiftVoicePreviewLines(
  config: AIConfig,
  groupId: number,
  count: number,
  combo: GiftComboSummary,
  voiceText: string,
): string[] {
  const gate = giftVoiceGateSnapshot(config, groupId, count, combo);
  const voice = inspectGiftVoiceDecision(config, groupId, count, combo);
  const tts = getVoiceStats(config);
  const probabilityText = gate.probability >= 1 ? '100%(必发)' : `${Math.round(gate.probability * 100)}%`;
  const localState = tts.provider === 'api' ? 'api-only' : (tts.localReady ? 'local-ready' : 'local-missing');
  const cloneState = tts.cloneEnabled ? (tts.cloneReady ? 'clone-ready' : `clone-${tts.sampleReason || 'not-ready'}`) : 'clone-off';
  const clippedVoiceText = voiceText.length > tts.maxChars
    ? `${voiceText.slice(0, Math.max(0, tts.maxChars - 1))}…`
    : voiceText;
  return [
    `语音预判: ${voice.ok ? '可触发' : '不触发'} (${voice.detail})`,
    `门槛: 连送${gate.comboEvents}/${gate.minEvents} 总量${gate.totalCount}/${gate.minTotal}`,
    `冷却: group=${groupId || '-'} ${gate.cooldownRemain > 0 ? `剩余${gate.cooldownRemain}s` : `无阻塞/${gate.cooldownSeconds}s`}`,
    `概率: ${probabilityText}`,
    `TTS: ${config.enable_tts ? 'on' : 'off'} provider=${tts.provider} ${localState} send=${tts.sendMode} ${cloneState} max=${tts.maxChars}`,
    `语音文本: ${clippedVoiceText}`,
    '边界: 礼物感谢是拟态模板，不是核验原话；语音只在门槛/概率/冷却通过后追加纯 record。',
  ];
}

function formatGiftVoiceCachePreviewLines(config: AIConfig, voiceText: string, warmHint: string = '/gift warm <礼物> [数量]'): string[] {
  const inspect = inspectVoiceCache(config, [voiceText]);
  const part = inspect.parts[0];
  if (!part) {
    return ['语音缓存: 无有效分段'];
  }
  const next = part.status === 'hit'
    ? '下一步: 真实礼物语音如果通过门槛，会直接复用这条缓存。'
    : part.status === 'miss' || part.status === 'expired'
      ? `下一步: 管理员跑 ${warmHint} 可预热这条礼物谢礼；也可 /voice test ${voiceText} 只按文本预热。`
      : '下一步: 先处理 TTS 状态，再考虑礼物语音预热。';
  return [
    formatGiftVoiceCachePartLine('语音缓存', part),
    `缓存说明: ${part.reason}`,
    next,
  ];
}

function formatGiftVoiceCachePartLine(
  label: string,
  part: ReturnType<typeof inspectVoiceCache>['parts'][number],
): string {
  const ttl = part.ttlSeconds > 0 ? ` ttl=${part.ttlSeconds}s` : '';
  const size = part.sizeKB > 0 ? ` size=${part.sizeKB}KB` : '';
  const clone = part.clone ? ' clone=on' : ' clone=off';
  return `${label}: 状态=${part.status} provider=${part.provider} mode=${part.mode}${clone} key=${part.cacheKey}${ttl}${size}`;
}

function compactGiftVoiceCachePart(part: ReturnType<typeof inspectVoiceCache>['parts'][number] | undefined): string {
  if (!part) return 'no-part';
  const ttl = part.ttlSeconds > 0 ? ` ttl=${part.ttlSeconds}s` : '';
  const size = part.sizeKB > 0 ? ` size=${part.sizeKB}KB` : '';
  return `状态=${part.status} provider=${part.provider} mode=${part.mode} key=${part.cacheKey}${ttl}${size}`;
}

function recordGiftTrace(
  action: 'sent' | 'throttled' | 'ignored',
  reason: string,
  notice: GiftNotice,
  gift: string = '',
  count: number = 0,
  text: string = '',
  combo?: GiftComboSummary,
  voiceAction: 'none' | 'queued' | 'sent' | 'skipped' | 'failed' = 'none',
  voiceReason: string = '',
  voiceCacheBefore: string = '',
  voiceCacheAfter: string = '',
): void {
  lastGiftTrace = {
    id: ++giftTraceSeq,
    timestamp: Date.now(),
    groupId: numberField(notice.group_id),
    senderId: giftSender(notice),
    targetId: giftTarget(notice),
    gift,
    count,
    comboEvents: combo?.eventCount || 0,
    comboTotal: combo?.totalCount || 0,
    action,
    reason,
    text: text.slice(0, 120),
    voiceAction,
    voiceReason,
    voiceCacheBefore: voiceCacheBefore.slice(0, 180),
    voiceCacheAfter: voiceCacheAfter.slice(0, 180),
  };
  recentGiftTraces.unshift(lastGiftTrace);
  if (recentGiftTraces.length > MAX_GIFT_TRACES) recentGiftTraces.length = MAX_GIFT_TRACES;
  if (action === 'sent') sentThanks++;
  else if (action === 'throttled') throttledThanks++;
  else ignoredThanks++;
}

function patchGiftVoiceTrace(
  traceId: number,
  voiceAction: 'sent' | 'failed',
  voiceReason: string,
  voiceCacheBefore: string = '',
  voiceCacheAfter: string = '',
): void {
  if (!lastGiftTrace || lastGiftTrace.id !== traceId) return;
  lastGiftTrace = {
    ...lastGiftTrace,
    timestamp: Date.now(),
    voiceAction,
    voiceReason: voiceReason.slice(0, 120),
    voiceCacheBefore: voiceCacheBefore.slice(0, 180),
    voiceCacheAfter: voiceCacheAfter.slice(0, 180),
  };
  const index = recentGiftTraces.findIndex((trace) => trace.id === traceId);
  if (index >= 0) recentGiftTraces[index] = lastGiftTrace;
}

async function sendGiftVoice(bot: Bot, groupId: number, text: string, traceId: number): Promise<void> {
  giftVoiceAttempts++;
  const config = bot.getConfig();
  const before = inspectVoiceCache(config.ai, [text]).parts[0];
  const beforeLine = compactGiftVoiceCachePart(before);
  const voicePath = await generateVoice(config.ai, text);
  const after = inspectVoiceCache(config.ai, [text]).parts[0];
  const afterLine = compactGiftVoiceCachePart(after);
  if (!voicePath) {
    giftVoiceFailures++;
    patchGiftVoiceTrace(traceId, 'failed', 'tts failed', beforeLine, afterLine);
    return;
  }
  const ok = await bot.sendGroupMessage(groupId, [voiceRecordSegment(config.ai, voicePath)]);
  if (ok) {
    giftVoiceSent++;
    patchGiftVoiceTrace(traceId, 'sent', 'ok', beforeLine, afterLine);
  } else {
    giftVoiceFailures++;
    patchGiftVoiceTrace(traceId, 'failed', 'send failed', beforeLine, afterLine);
  }
}

export function buildThanks(gift: string, count: number, combo?: GiftComboSummary, seed?: string): string {
  const safeGift = normalizeGiftName(gift);
  const safeCount = normalizeGiftCount(count);
  const displayGift = safeCount > 1 ? `${safeGift}x${safeCount}` : safeGift;
  const intensity = comboIntensity(safeCount, combo);
  const knowledgeTemplate = intensity === 'normal' && !seed ? getRandomKnowledgeLine('gift') : '';
  const template = knowledgeTemplate || pickWithSeed(intensity === 'big' ? bigGiftLines : intensity === 'combo' ? comboGiftLines : fallbackGiftLines, seed);
  let text = template
    .replace(/\{gift\}/g, displayGift)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  if (!text.includes(displayGift)) {
    text = `感谢老板的${displayGift}，${text}`.slice(0, 90);
  }
  if (intensity !== 'normal' && !/(老板大气|连送|经济|起飞|士气|力度|真顶|有说法)/.test(text)) {
    text = `${text.replace(/[。.!！]$/, '')}，老板大气。`.slice(0, 90);
  }
  if (combo && combo.eventCount >= 2 && !/(连送|连上|一串|总量|第\d+手)/.test(text)) {
    const suffix = `，连送第${combo.eventCount}手。`;
    text = `${text.replace(/[。.!！]$/, '')}${suffix}`.slice(0, 100);
  }
  if (combo && combo.totalCount >= 20 && !/(总量|力度|起飞|真顶)/.test(text)) {
    text = `${text.replace(/[。.!！]$/, '')}，这波总量${combo.totalCount}。`.slice(0, 100);
  }
  return text;
}

function buildGiftThanksScenario(gift: string, count: number, combo?: GiftComboSummary): GiftThanksScenario {
  const safeGift = normalizeGiftName(gift);
  const safeCount = normalizeGiftCount(count);
  const safeCombo = combo || { eventCount: 1, totalCount: safeCount, giftKinds: [safeGift] };
  const intensity = comboIntensity(safeCount, safeCombo);
  const seed = [safeGift, safeCount, safeCombo.eventCount, safeCombo.totalCount, ...safeCombo.giftKinds].join('|');
  const text = buildThanks(safeGift, safeCount, safeCombo, seed);
  return { safeGift, safeCount, safeCombo, intensity, text };
}

export function formatGiftThanksPreview(
  config: AIConfig,
  gift: string,
  count: number,
  groupId: number = 0,
  combo?: GiftComboSummary,
): string {
  const { safeGift, safeCount, safeCombo, intensity, text } = buildGiftThanksScenario(gift, count, combo);
  return [
    '礼物感谢预检',
    `礼物: ${safeGift}x${safeCount}`,
    `强度: ${intensity}${safeCombo.eventCount >= 2 ? ` 连送${safeCombo.eventCount}手/总量${safeCombo.totalCount}` : ''}`,
    `文案: ${text}`,
    ...formatGiftVoicePreviewLines(config, groupId, safeCount, safeCombo, text),
    ...formatGiftVoiceCachePreviewLines(config, text, `/gift warm ${safeGift} ${safeCount}`),
    '说明: 这里只预览，不写入节流/冷却，也不会真的发语音。',
  ].join('\n');
}

export async function warmGiftThanksVoice(
  config: AIConfig,
  gift: string,
  count: number,
  groupId: number = 0,
  options: {
    combo?: GiftComboSummary;
    generate?: (text: string) => Promise<string | null>;
  } = {},
): Promise<string> {
  const { safeGift, safeCount, safeCombo, intensity, text } = buildGiftThanksScenario(gift, count, options.combo);
  const before = inspectVoiceCache(config, [text]).parts[0];
  let action = 'skipped';
  let voicePath = '';
  let error = '';

  if (!before) {
    action = 'skipped/no-part';
  } else if (before.status === 'hit') {
    action = 'hit/no-op';
  } else if (before.status === 'miss' || before.status === 'expired' || before.status === 'in-flight') {
    try {
      const generator = options.generate || ((voiceText: string) => generateVoice(config, voiceText));
      voicePath = await generator(text) || '';
      action = voicePath ? 'generated' : 'failed';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      action = 'failed';
    }
  } else {
    action = `skipped/${before.status}`;
  }

  const after = inspectVoiceCache(config, [text]).parts[0];
  const stats = getVoiceStats(config);
  return [
    '礼物语音预热',
    `礼物: ${safeGift}x${safeCount}`,
    `强度: ${intensity}${safeCombo.eventCount >= 2 ? ` 连送${safeCombo.eventCount}手/总量${safeCombo.totalCount}` : ''}`,
    `文案: ${text}`,
    ...formatGiftVoicePreviewLines(config, groupId, safeCount, safeCombo, text),
    before ? formatGiftVoiceCachePartLine('预热前', before) : '预热前: 无有效分段',
    `预热动作: ${action}${voicePath ? ` path=${voicePath}` : ''}`,
    after ? formatGiftVoiceCachePartLine('预热后', after) : '预热后: 无有效分段',
    after ? `缓存说明: ${after.reason}` : '',
    error || stats.lastError ? `最近错误: ${error || stats.lastError}` : '',
    '说明: 预热只生成或复用 TTS 缓存，不发送 record，不写入礼物节流、冷却或 trace。',
    '边界: 礼物感谢是拟态模板，不是核验原话；克隆语音也不要说成现实主播本人。',
  ].filter(Boolean).join('\n');
}

export function getGiftThanksStats(): {
  recentKeys: number;
  recentTraces: number;
  totalGiftNotices: number;
  sentThanks: number;
  throttledThanks: number;
  ignoredThanks: number;
  giftVoiceAttempts: number;
  giftVoiceSent: number;
  giftVoiceSkipped: number;
  giftVoiceFailures: number;
  lastGiftTrace: GiftTrace | null;
} {
  return {
    recentKeys: recentThanks.size,
    recentTraces: recentGiftTraces.length,
    totalGiftNotices,
    sentThanks,
    throttledThanks,
    ignoredThanks,
    giftVoiceAttempts,
    giftVoiceSent,
    giftVoiceSkipped,
    giftVoiceFailures,
    lastGiftTrace,
  };
}

function formatGiftTime(timestamp: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无';
}

export function formatGiftThanksStatus(): string {
  const stats = getGiftThanksStats();
  const trace = stats.lastGiftTrace;
  return [
    '礼物感谢状态',
    `事件: 收到${stats.totalGiftNotices} 已谢${stats.sentThanks} 节流${stats.throttledThanks} 忽略${stats.ignoredThanks}`,
    `语音: 尝试${stats.giftVoiceAttempts} 已发${stats.giftVoiceSent} 跳过${stats.giftVoiceSkipped} 失败${stats.giftVoiceFailures}`,
    `节流键: ${stats.recentKeys} 连送窗口${recentGiftCombos.size} 最近记录${stats.recentTraces}/${MAX_GIFT_TRACES}`,
    trace ? `最近: ${formatGiftTime(trace.timestamp)} group=${trace.groupId || '-'} uid=${trace.senderId || '-'} target=${trace.targetId || '-'} ${trace.gift || '礼物'}x${trace.count || 1} combo=${trace.comboEvents || 0}/${trace.comboTotal || 0} ${trace.action} ${trace.reason} voice=${trace.voiceAction}/${trace.voiceReason || '-'}` : '最近: 无',
    trace?.voiceCacheBefore || trace?.voiceCacheAfter ? `最近语音缓存: before ${trace.voiceCacheBefore || '-'} -> after ${trace.voiceCacheAfter || '-'}` : '',
    trace?.text ? `最近文案: ${trace.text}` : '',
    '查看: /gift recent [条数] 看最近多条真实礼物处理',
    '节流: 同群同人同礼物20秒内只谢一次；45秒内连续礼物会累计连送强度',
  ].filter(Boolean).join('\n');
}

export function formatGiftThanksTrace(): string {
  const trace = lastGiftTrace;
  if (!trace) {
    return [
      '礼物感谢 trace',
      '最近: 无真实礼物事件',
      '下一步: /gift check <礼物> [数量] 可以只读预检文案、语音门槛、冷却和 TTS 状态。',
    ].join('\n');
  }
  return [
    '礼物感谢 trace',
    `事件: #${trace.id} ${formatGiftTime(trace.timestamp)}`,
    `对象: group=${trace.groupId || '-'} uid=${trace.senderId || '-'} target=${trace.targetId || '-'} ${trace.gift || '礼物'}x${trace.count || 1}`,
    `判定: ${trace.action} (${trace.reason})`,
    `连送: ${trace.comboEvents || 0}手 / 总量${trace.comboTotal || 0}`,
    trace.text ? `文案: ${trace.text}` : '文案: -',
    `语音: ${trace.voiceAction}${trace.voiceReason ? ` (${trace.voiceReason})` : ''}`,
    trace.voiceCacheBefore || trace.voiceCacheAfter ? `语音缓存: before ${trace.voiceCacheBefore || '-'} -> after ${trace.voiceCacheAfter || '-'}` : '语音缓存: -',
    '边界: trace 只记录真实礼物事件处理结果；/gift check 是只读预检，不会触发感谢或语音。',
  ].join('\n');
}

export function formatGiftThanksRecent(limit = 8): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, MAX_GIFT_TRACES));
  const traces = recentGiftTraces.slice(0, safeLimit);
  if (traces.length === 0) {
    return [
      '礼物感谢最近记录',
      '最近: 无真实礼物事件',
      '说明: 只记录真实礼物事件；/gift check 和 /gift warm 不会写入这里。',
    ].join('\n');
  }
  return [
    `礼物感谢最近记录 ${traces.length}/${recentGiftTraces.length}`,
    ...traces.map((trace, index) => {
      const time = new Date(trace.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const text = trace.text ? ` | ${trace.text}` : '';
      const voiceCache = trace.voiceCacheBefore || trace.voiceCacheAfter
        ? ` cache=${trace.voiceCacheBefore || '-'}->${trace.voiceCacheAfter || '-'}`
        : '';
      return `${index + 1}. #${trace.id} ${time} group=${trace.groupId || '-'} uid=${trace.senderId || '-'} ${trace.gift || '礼物'}x${trace.count || 1} ${trace.action}/${trace.reason} combo=${trace.comboEvents || 0}/${trace.comboTotal || 0} voice=${trace.voiceAction}/${trace.voiceReason || '-'}${voiceCache}${text}`;
    }),
    '边界: 这里只读最近处理结果，方便排查节流、目标不是bot、语音门槛/冷却/TTS失败等问题。',
  ].join('\n');
}

export interface GiftWarmupCandidate {
  gift: string;
  count: number;
  text: string;
  status: string;
  reason: string;
  command: string;
  trace: string;
}

export function getGiftWarmupCandidates(config: AIConfig, limit = 5): GiftWarmupCandidate[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 5, MAX_GIFT_TRACES));
  const seen = new Set<string>();
  const candidates: GiftWarmupCandidate[] = [];
  for (const trace of recentGiftTraces) {
    if (!trace.text || !trace.gift) continue;
    const key = `${trace.gift.toLowerCase()}|${trace.count}|${trace.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inspected = inspectVoiceCache(config, [trace.text]).parts[0];
    candidates.push({
      gift: trace.gift,
      count: trace.count,
      text: trace.text,
      status: inspected?.status || 'invalid',
      reason: inspected?.reason || '没有可检查的礼物谢礼语音分段',
      command: `/maint warm gift ${trace.gift} ${trace.count}`,
      trace: `gift#${trace.id} group=${trace.groupId || '-'} age=${Math.max(0, Math.round((Date.now() - trace.timestamp) / 1000))}s`,
    });
    if (candidates.length >= safeLimit) break;
  }
  return candidates;
}

export function registerGiftThanksListener(bot: Bot): void {
  bot.onEvent((event) => {
    if (event.post_type !== 'notice') return;

    const notice = event as GiftNotice;
    if (!isGiftNotice(notice)) return;
    totalGiftNotices++;

    const groupId = numberField(notice.group_id);
    const senderId = giftSender(notice);
    if (!groupId || !senderId || senderId === notice.self_id) {
      recordGiftTrace('ignored', 'missing group/sender or self gift', notice);
      return;
    }

    const config = bot.getConfig();
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupId)) {
      recordGiftTrace('ignored', 'group not enabled', notice);
      return;
    }

    const targetId = giftTarget(notice);
    const gift = giftName(notice);
    const count = giftCount(notice);
    if (targetId && targetId !== notice.self_id) {
      recordGiftTrace('ignored', 'gift target is not bot', notice, gift, count);
      return;
    }

    if (shouldThrottle(groupId, senderId, gift)) {
      recordGiftTrace('throttled', '20s duplicate', notice, gift, count);
      return;
    }

    const combo = rememberGiftCombo(groupId, senderId, gift, count);
    const text = buildThanks(gift, count, combo);
    const voiceDecision = shouldQueueGiftVoice(config.ai, groupId, count, combo);
    if (!voiceDecision.ok) giftVoiceSkipped++;
    const skippedVoiceCache = voiceDecision.ok
      ? ''
      : compactGiftVoiceCachePart(inspectVoiceCache(config.ai, [text]).parts[0]);
    recordGiftTrace(
      'sent',
      combo.eventCount >= 2 ? 'combo' : 'ok',
      notice,
      gift,
      count,
      text,
      combo,
      voiceDecision.ok ? 'queued' : 'skipped',
      voiceDecision.reason,
      skippedVoiceCache,
    );
    const traceId = lastGiftTrace?.id || 0;
    bot.sendGroupMessage(groupId, [
      { type: 'at', data: { qq: String(senderId) } },
      { type: 'text', data: { text: ` ${text}` } },
    ]);
    if (voiceDecision.ok && traceId) {
      void sendGiftVoice(bot, groupId, text, traceId).catch((err) => {
        giftVoiceFailures++;
        patchGiftVoiceTrace(traceId, 'failed', err instanceof Error ? err.message : String(err));
      });
    }
  });

  console.log('[Gift] 礼物感谢已启用');
}

export const __test = {
  isGiftNotice,
  giftName,
  giftCount,
  giftIntensity,
  comboIntensity,
  rememberGiftCombo,
  shouldQueueGiftVoice,
  inspectGiftVoiceDecision,
  buildThanks,
  formatGiftThanksPreview,
  warmGiftThanksVoice,
  formatGiftThanksTrace,
  formatGiftThanksRecent,
  shouldThrottle,
  getGiftThanksStats,
  formatGiftThanksStatus,
  resetForTests(): void {
    recentThanks.clear();
    recentGiftCombos.clear();
    totalGiftNotices = 0;
    sentThanks = 0;
    throttledThanks = 0;
    ignoredThanks = 0;
    giftVoiceAttempts = 0;
    giftVoiceSent = 0;
    giftVoiceSkipped = 0;
    giftVoiceFailures = 0;
    giftTraceSeq = 0;
    recentGiftVoiceAt.clear();
    lastGiftTrace = null;
    recentGiftTraces.length = 0;
  },
};
