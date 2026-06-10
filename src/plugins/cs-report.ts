import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Plugin } from '../types';
import {
  describeHltvCacheEntry,
  fetchOngoingMatches,
  fetchRecentResults,
  fetchTeamRanking,
} from './hltv-api';
import { buildCsWatchDigestForChat, getCsWatchPreferencesForChat } from './cs-watch';
import { buildCsPredictDigestForChat, getCsPredictPrewarmTargets } from './cs-predict';
import { buildCsPrewarmPlan, prewarmCsDataForReport } from './cs-prewarm';
import type { CsPrewarmPlanResult, CsPrewarmPlanRow, CsPrewarmResult } from './cs-prewarm';
import { buildCsPlanFactTypeCoverageLines } from './cs-fact-coverage';
import { webSearch } from './web-search';

type ReportChatType = 'group' | 'private';

interface CsReportSubscription {
  id: string;
  chatType: ReportChatType;
  chatId: number;
  groupId?: number;
  userId: number;
  time: string;
  timezone: 'Asia/Shanghai';
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastSentDate: string;
  lastSentAt: number;
  lastError: string;
}

interface CsReportStore {
  version: 1;
  subscriptions: CsReportSubscription[];
}

interface ReportBot {
  sendGroupMessage?: (groupId: number, message: string) => Promise<boolean>;
  sendPrivateMessage?: (userId: number, message: string) => Promise<boolean>;
  getConfig?: () => { admin_qq?: number[] };
}

type ReportBuilder = () => Promise<string>;
type ReportPrewarmRunner = (options: {
  chats?: Array<{ chatType: ReportChatType; chatId: number }>;
  maxDynamicTargets?: number;
}) => Promise<CsPrewarmResult>;

const DEFAULT_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'cs-report.json');
const DEFAULT_REPORT_TIME = '09:30';
const DEFAULT_CHECK_INTERVAL_SECONDS = 60;
const REPORT_TIMEZONE: CsReportSubscription['timezone'] = 'Asia/Shanghai';
const REPORT_PREWARM_LEAD_MINUTES = 10;
const REPORT_PREWARM_DYNAMIC_TARGETS = 6;
const REPORT_BASE_CACHE_MS = 45_000;

let storePathOverride = '';
let reportBuilder: ReportBuilder = buildCsDailyReport;
let reportPrewarmRunner: ReportPrewarmRunner = prewarmCsDataForReport;
let reportTimer: NodeJS.Timeout | null = null;
let reportRunning = false;
let lastRunAt = 0;
let lastRunChecked = 0;
let lastRunSent = 0;
let lastRunError = '';
let lastPrewarmAt = 0;
let lastPrewarmChecked = 0;
let lastPrewarmTargets = 0;
let lastPrewarmOk = 0;
let lastPrewarmError = '';
let lastPrewarmKey = '';
let baseReportCacheValue = '';
let baseReportCacheAt = 0;
let baseReportCacheHits = 0;
let baseReportCacheMisses = 0;
let baseReportCacheWrites = 0;
let baseReportInFlight: Promise<string> | null = null;
let baseReportInFlightHits = 0;

function storePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

function emptyStore(): CsReportStore {
  return { version: 1, subscriptions: [] };
}

function loadStore(): CsReportStore {
  const filepath = storePath();
  if (!fs.existsSync(filepath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const subscriptions = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    return {
      version: 1,
      subscriptions: subscriptions
        .filter((item: Partial<CsReportSubscription>) => item && item.id && item.chatId && item.time)
        .map((item: CsReportSubscription) => ({
          ...item,
          chatType: item.chatType === 'private' ? 'private' : 'group',
          time: normalizeReportTime(item.time) || DEFAULT_REPORT_TIME,
          timezone: REPORT_TIMEZONE,
          enabled: item.enabled !== false,
          lastSentDate: String(item.lastSentDate || ''),
          lastSentAt: Number(item.lastSentAt || 0),
          lastError: String(item.lastError || ''),
        })),
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store: CsReportStore): void {
  const filepath = storePath();
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

function formatShanghaiParts(date: Date): { dateKey: string; timeKey: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value || '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    timeKey: `${get('hour')}:${get('minute')}`,
  };
}

function nowText(timestamp: number): string {
  return timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: REPORT_TIMEZONE, hour12: false })
    : '无';
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map((item) => Number(item));
  return hour * 60 + minute;
}

function normalizeReportTime(input?: string): string | null {
  const text = (input || '').trim().replace('：', ':');
  if (!text) return null;
  let match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) match = text.match(/^(\d{1,2})(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function compactBlock(title: string, value: string, maxChars: number): string {
  const cleaned = (value || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('缓存: '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned ? `【${title}】\n${cleaned.slice(0, maxChars)}` : `【${title}】\n暂无准信`;
}

function normalizeForPreference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function splitReportBlocks(report: string): { title: string; lines: string[] }[] {
  const blocks: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const rawLine of report.split(/\r?\n/)) {
    const line = rawLine.trim();
    const title = line.match(/^【(.{1,40})】$/)?.[1];
    if (title) {
      current = { title, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current && line) current.lines.push(line);
  }
  return blocks;
}

function buildPreferenceHighlights(
  baseReport: string,
  preferences: { kind: string; subject: string }[],
  options: { maxTargets?: number; maxLines?: number } = {},
): string {
  if (!preferences.length) return '';
  const blocks = splitReportBlocks(baseReport);
  if (blocks.length === 0) return '';
  const maxTargets = Math.max(1, options.maxTargets || 4);
  const maxLines = Math.max(1, options.maxLines || 6);
  const lines = ['【本群优先看】按 /watch 关注目标提到前面'];
  const seen = new Set<string>();
  let hitCount = 0;

  for (const pref of preferences.slice(0, maxTargets)) {
    const token = normalizeForPreference(pref.subject);
    if (!token || token.length < 2) continue;
    for (const block of blocks) {
      const matches = block.lines
        .filter((line) => {
          if (/^(?:来源|缓存|机器短评|说明)[:：]/.test(line)) return false;
          return normalizeForPreference(line).includes(token);
        })
        .slice(0, 2);
      for (const line of matches) {
        const key = `${pref.subject}:${block.title}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${pref.subject} / ${block.title}: ${line.slice(0, 150)}`);
        hitCount++;
        if (hitCount >= maxLines) break;
      }
      if (hitCount >= maxLines) break;
    }
    if (hitCount >= maxLines) break;
  }

  if (hitCount === 0) return '';
  lines.push('说明：这里只重排基础日报里的命中行；实时结论仍看原文来源时间和链接。');
  return lines.join('\n');
}

function isActionableReportLine(line: string): boolean {
  const text = line.trim();
  if (!text || text === '暂无准信') return false;
  return !/^(?:来源|缓存|机器短评|说明|边界|操作)[:：]/.test(text);
}

function reportBlockLines(baseReport: string, titlePattern: RegExp, maxLines: number): string[] {
  const block = splitReportBlocks(baseReport).find((item) => titlePattern.test(item.title));
  if (!block) return [];
  return block.lines
    .filter(isActionableReportLine)
    .slice(0, Math.max(1, maxLines))
    .map((line) => line.slice(0, 140));
}

function preferenceFocusLines(
  baseReport: string,
  preferences: { kind: string; subject: string }[],
  maxLines = 3,
): string[] {
  if (!preferences.length) return [];
  const blocks = splitReportBlocks(baseReport);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const pref of preferences.slice(0, 4)) {
    const token = normalizeForPreference(pref.subject);
    if (!token || token.length < 2) continue;
    for (const block of blocks) {
      const hit = block.lines.find((line) => isActionableReportLine(line) && normalizeForPreference(line).includes(token));
      if (!hit) continue;
      const key = `${pref.subject}:${block.title}:${hit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${pref.subject} / ${block.title}: ${hit.slice(0, 120)}`);
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

function buildFocusLeadLines(baseReport: string, preferences: { kind: string; subject: string }[]): string[] {
  const watched = preferenceFocusLines(baseReport, preferences, 3);
  if (watched.length > 0) return watched;
  const matches = reportBlockLines(baseReport, /当前|即将|比赛/, 2);
  const results = reportBlockLines(baseReport, /赛果|战报/, 1);
  const ranking = reportBlockLines(baseReport, /排名/, 1);
  const lead = [...matches, ...results, ...ranking].slice(0, 4);
  return lead.length > 0 ? lead : ['实时源这轮没给到硬内容，先 /csreport check 看缓存和预热计划。'];
}

function personalizeReportForChat(baseReport: string, chatType: ReportChatType, chatId: number): string {
  const highlights = buildPreferenceHighlights(baseReport, getCsWatchPreferencesForChat(chatType, chatId));
  return highlights ? `${highlights}\n\n${baseReport}` : baseReport;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref();
    }),
  ]);
}

function resetBaseReportCache(): void {
  baseReportCacheValue = '';
  baseReportCacheAt = 0;
  baseReportInFlight = null;
}

async function buildBaseReport(options: { force?: boolean } = {}): Promise<string> {
  const now = Date.now();
  if (!options.force && baseReportCacheValue && now - baseReportCacheAt <= REPORT_BASE_CACHE_MS) {
    baseReportCacheHits++;
    return baseReportCacheValue;
  }
  if (!options.force && baseReportInFlight) {
    baseReportInFlightHits++;
    return baseReportInFlight;
  }
  baseReportCacheMisses++;
  const pending = reportBuilder()
    .then((value) => {
      baseReportCacheValue = value;
      baseReportCacheAt = Date.now();
      baseReportCacheWrites++;
      return value;
    });
  baseReportInFlight = pending;
  try {
    return await pending;
  } finally {
    if (baseReportInFlight === pending) baseReportInFlight = null;
  }
}

export async function buildCsDailyReport(): Promise<string> {
  const [matches, results, ranking, news] = await Promise.all([
    withTimeout(fetchOngoingMatches().catch(() => ''), 6500, ''),
    withTimeout(fetchRecentResults().catch(() => ''), 6500, ''),
    withTimeout(fetchTeamRanking().catch(() => ''), 6500, ''),
    withTimeout(webSearch('CS2 latest news roster results HLTV today', 4500, 300, 60).catch(() => ''), 5500, ''),
  ]);
  const pulledAt = new Date().toLocaleString('zh-CN', { timeZone: REPORT_TIMEZONE, hour12: false });
  return [
    `CS每日报 | ${pulledAt}`,
    compactBlock('当前/即将比赛', matches, 680),
    compactBlock('最近赛果', results, 620),
    compactBlock('排名快照', ranking, 460),
    compactBlock('热门新闻/转会', news, 520),
    [
      describeHltvCacheEntry('matches'),
      describeHltvCacheEntry('results'),
      describeHltvCacheEntry('ranking'),
    ].join('\n'),
    '机器短评：日报只认来源时间和链接，外站抽风就写暂无准信，别拿脑补当事实。',
  ].join('\n\n');
}

function makeId(chatType: ReportChatType, chatId: number): string {
  const hash = crypto.createHash('sha1').update(`${chatType}:${chatId}:cs-report`).digest('hex').slice(0, 8);
  return `report-${hash}`;
}

function chatMatches(sub: CsReportSubscription, chatType: ReportChatType, chatId: number): boolean {
  return sub.chatType === chatType && sub.chatId === chatId;
}

function upsertSubscription(
  chatType: ReportChatType,
  chatId: number,
  groupId: number | undefined,
  userId: number,
  time: string,
): string {
  const normalizedTime = normalizeReportTime(time) || DEFAULT_REPORT_TIME;
  const store = loadStore();
  const now = Date.now();
  const existing = store.subscriptions.find((item) => chatMatches(item, chatType, chatId));
  if (existing) {
    existing.time = normalizedTime;
    existing.enabled = true;
    existing.groupId = groupId;
    existing.userId = userId;
    existing.updatedAt = now;
    existing.lastError = '';
    saveStore(store);
    return `CS日报已更新: 每天 ${normalizedTime} 推送到当前${chatType === 'group' ? '群' : '私聊'}。`;
  }
  const sub: CsReportSubscription = {
    id: makeId(chatType, chatId),
    chatType,
    chatId,
    groupId,
    userId,
    time: normalizedTime,
    timezone: REPORT_TIMEZONE,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSentDate: '',
    lastSentAt: 0,
    lastError: '',
  };
  store.subscriptions.push(sub);
  saveStore(store);
  return `CS日报已开启: 每天 ${normalizedTime} 推送到当前${chatType === 'group' ? '群' : '私聊'}。\n马上看一份用 /csreport now。`;
}

function removeSubscription(chatType: ReportChatType, chatId: number): string {
  const store = loadStore();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((item) => !chatMatches(item, chatType, chatId));
  if (store.subscriptions.length !== before) {
    saveStore(store);
    return 'CS日报已关闭。';
  }
  return '当前会话没有开启 CS日报。';
}

function formatCurrentSubscription(chatType: ReportChatType, chatId: number): string {
  const store = loadStore();
  const sub = store.subscriptions.find((item) => chatMatches(item, chatType, chatId));
  if (!sub) {
    return [
      'CS日报状态',
      '当前会话: 未开启',
      `/csreport on ${DEFAULT_REPORT_TIME} - 开启每日推送`,
      '/csreport now - 立即看一份',
    ].join('\n');
  }
  return [
    'CS日报状态',
    `当前会话: ${sub.enabled ? '已开启' : '已关闭'} ${sub.time} ${sub.timezone}`,
    `订阅ID: ${sub.id}`,
    `上次推送: ${sub.lastSentDate || '无'} ${nowText(sub.lastSentAt)}`,
    sub.lastError ? `最近错误: ${sub.lastError}` : '',
    `全局: ${formatReportStatsLine()}`,
  ].filter(Boolean).join('\n');
}

function formatMinutesDelta(minutes: number): string {
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const body = hour > 0 ? `${hour}小时${minute}分钟` : `${minute}分钟`;
  return minutes >= 0 ? `${body}后` : `已过${body}`;
}

function formatReportScheduleLine(sub: CsReportSubscription | undefined, date: Date): string {
  if (!sub) return `当前会话: 未开启 | /csreport on ${DEFAULT_REPORT_TIME}`;
  const parts = formatShanghaiParts(date);
  const delta = timeToMinutes(sub.time) - timeToMinutes(parts.timeKey);
  if (sub.lastSentDate === parts.dateKey) {
    return `当前会话: ${sub.enabled ? '已开启' : '已关闭'} ${sub.time} ${sub.timezone} | 今日已推送 ${nowText(sub.lastSentAt)}`;
  }
  const state = delta > REPORT_PREWARM_LEAD_MINUTES
    ? `未到预热窗口，距离推送 ${formatMinutesDelta(delta)}`
    : delta >= 0
      ? `预热窗口内，距离推送 ${formatMinutesDelta(delta)}`
      : `已到推送时间 ${formatMinutesDelta(delta)}，等待定时器/管理员执行`;
  return `当前会话: ${sub.enabled ? '已开启' : '已关闭'} ${sub.time} ${sub.timezone} | ${state}`;
}

function compactSubjects<T extends { subject: string }>(items: T[], max = 5): string {
  if (items.length === 0) return '无';
  const shown = items.slice(0, max).map((item) => item.subject).join(', ');
  return items.length > max ? `${shown} 等${items.length}个` : shown;
}

function profileSubjectFromReportPlanRow(row: CsPrewarmPlanRow, kind: 'team' | 'player'): string {
  const labelMatch = row.label.match(new RegExp(`^(?:(?:watch|predict)\\s+)?${kind}\\s+(.+)$`, 'i'));
  if (labelMatch?.[1]?.trim()) return labelMatch[1].trim();
  const prefix = `${kind}:`;
  return row.cacheKey.startsWith(prefix)
    ? row.cacheKey.slice(prefix.length).replace(/[_-]+/g, ' ').trim()
    : '';
}

function warmArgsForReportPlanRow(row: CsPrewarmPlanRow): string {
  if (row.cacheKey === 'matches' || row.cacheKey === 'results' || row.cacheKey === 'ranking') return row.cacheKey;
  const matchId = row.cacheKey.match(/^match:(\d{4,})$/)?.[1];
  if (matchId) return `match ${matchId}`;
  if (row.cacheKey.startsWith('team:')) {
    const subject = profileSubjectFromReportPlanRow(row, 'team');
    return subject ? `team ${subject}` : '';
  }
  if (row.cacheKey.startsWith('player:')) {
    const subject = profileSubjectFromReportPlanRow(row, 'player');
    return subject ? `player ${subject}` : '';
  }
  return '';
}

function formatReportPrewarmAdvice(sub: CsReportSubscription | undefined, plan: CsPrewarmPlanResult): string {
  if (!sub) return `建议: 先 /csreport on ${DEFAULT_REPORT_TIME} 开启订阅；只想现在看就 /csreport now。`;
  const refreshRows = plan.rows.filter((row) => row.action === 'refresh');
  if (refreshRows.length === 0) return '建议: 核心和动态目标都能命中缓存；可直接 /csreport now，定时推送也会比较稳。';

  const seen = new Set<string>();
  const commands = refreshRows
    .map((row) => warmArgsForReportPlanRow(row))
    .filter((args) => {
      if (!args || seen.has(args)) return false;
      seen.add(args);
      return true;
    });

  if (commands.length === 0) {
    return '建议: 定时任务会在推送前自动预热；想提前排雷，让管理员先 /cs warm plan all，再 /cs warm all。';
  }

  const shown = commands.slice(0, 4);
  const planCommands = shown.map((args) => `/cs warm plan ${args}`).join('，');
  const warmCommands = shown.map((args) => `/cs warm ${args}`).join('，');
  const more = commands.length > shown.length ? `；另有 ${commands.length - shown.length} 个目标可用 /cs warm plan all 看全量` : '';
  return `建议: 定时任务会在推送前自动预热；想提前排雷，管理员先 ${planCommands}，确认会 REFRESH 后再 ${warmCommands}${more}；全量兜底 /cs warm plan all，再 /cs warm all。`;
}

function buildCsReportPreflight(chatType: ReportChatType, chatId: number, date: Date = new Date()): string {
  const store = loadStore();
  const sub = store.subscriptions.find((item) => chatMatches(item, chatType, chatId));
  const watchPrefs = getCsWatchPreferencesForChat(chatType, chatId);
  const predictTargets = getCsPredictPrewarmTargets({
    chats: [{ chatType, chatId }],
    maxTargets: REPORT_PREWARM_DYNAMIC_TARGETS,
  });
  const plan = buildCsPrewarmPlan(['all'], {
    chats: [{ chatType, chatId }],
    maxDynamicTargets: REPORT_PREWARM_DYNAMIC_TARGETS,
  });
  const requestCount = plan.stale + plan.miss;
  const planRows = plan.rows.slice(0, 10).map((row) => `- ${row.label} [${row.cacheKey}]: ${row.action === 'hit' ? 'HIT' : 'REFRESH'} | ${row.detail}`);
  if (plan.rows.length > planRows.length) {
    planRows.push(`- 还有 ${plan.rows.length - planRows.length} 个动态目标未展开，管理员可 /cs warm plan all 看全量。`);
  }

  return [
    `CS日报预检 | ${new Date().toLocaleString('zh-CN', { timeZone: REPORT_TIMEZONE, hour12: false })}`,
    formatReportScheduleLine(sub, date),
    `全局: ${formatReportStatsLine()}`,
    '',
    '日报构成:',
    '- 基础日报: 比赛 / 赛果 / 排名 / 热门新闻',
    `- 本会话关注: ${watchPrefs.length}个 | ${compactSubjects(watchPrefs)}`,
    `- 本会话竞猜预热目标: ${predictTargets.length}个 | ${compactSubjects(predictTargets)}`,
    '- 竞猜核心缓存: matches / results 已纳入预热计划，用于开盘候选、赛程边界和自动结算赛果边界',
    '',
    '预热计划:',
    ...planRows,
    `统计: fresh ${plan.fresh}/${plan.targetCount}，stale ${plan.stale}，miss ${plan.miss}，预计请求 ${requestCount}`,
    ...buildCsPlanFactTypeCoverageLines(plan.rows),
    '',
    formatReportPrewarmAdvice(sub, plan),
    '边界: 这是只读预检，不生成日报、不请求外站、不写订阅状态；stale 只能当旧快照线索，miss 不能当没有比赛/没有赛果的实时结论。',
    '执行真实定时检查: 管理员 /csreport due',
  ].join('\n');
}

function parseNaturalReportSubscribe(rawText: string): string | null {
  const text = rawText.trim().replace(/\s+/g, ' ');
  const match = text.match(/^(?:帮我)?(?:订阅|开启|打开|每天推送|每日推送|推送)\s*(?:cs|cs2)?\s*(?:日报|短报|战报|报告)(?:\s*(\d{1,2}[:：]?\d{2}))?$/i);
  if (!match) return null;
  return normalizeReportTime(match[1]) || DEFAULT_REPORT_TIME;
}

function isDue(sub: CsReportSubscription, date: Date): boolean {
  if (!sub.enabled) return false;
  const parts = formatShanghaiParts(date);
  if (sub.lastSentDate === parts.dateKey) return false;
  return timeToMinutes(parts.timeKey) >= timeToMinutes(sub.time);
}

function isPrewarmDue(sub: CsReportSubscription, date: Date): boolean {
  if (!sub.enabled) return false;
  const parts = formatShanghaiParts(date);
  if (sub.lastSentDate === parts.dateKey) return false;
  const minutesUntilReport = timeToMinutes(sub.time) - timeToMinutes(parts.timeKey);
  return minutesUntilReport >= 0 && minutesUntilReport <= REPORT_PREWARM_LEAD_MINUTES;
}

function prewarmKeyForSubs(subs: CsReportSubscription[], date: Date): string {
  const dateKey = formatShanghaiParts(date).dateKey;
  return subs
    .map((sub) => `${sub.id}:${dateKey}`)
    .sort()
    .join('|');
}

function uniqueReportChats(subs: CsReportSubscription[]): Array<{ chatType: ReportChatType; chatId: number }> {
  const seen = new Set<string>();
  const chats: Array<{ chatType: ReportChatType; chatId: number }> = [];
  for (const sub of subs) {
    const key = `${sub.chatType}:${sub.chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chats.push({ chatType: sub.chatType, chatId: sub.chatId });
  }
  return chats;
}

async function maybePrewarmReportData(
  subs: CsReportSubscription[],
  date: Date,
): Promise<{ prewarmed: number; targets: number; ok: number; errors: number }> {
  if (subs.length === 0) return { prewarmed: 0, targets: 0, ok: 0, errors: 0 };
  const key = prewarmKeyForSubs(subs, date);
  if (key && key === lastPrewarmKey) {
    return { prewarmed: 0, targets: lastPrewarmTargets, ok: lastPrewarmOk, errors: 0 };
  }

  lastPrewarmAt = Date.now();
  lastPrewarmChecked = subs.length;
  lastPrewarmTargets = 0;
  lastPrewarmOk = 0;
  lastPrewarmError = '';
  try {
    const result = await reportPrewarmRunner({
      chats: uniqueReportChats(subs),
      maxDynamicTargets: REPORT_PREWARM_DYNAMIC_TARGETS,
    });
    lastPrewarmKey = key;
    lastPrewarmTargets = result.targetCount;
    lastPrewarmOk = result.ok;
    lastPrewarmError = result.failed > 0 ? `failed ${result.failed}/${result.targetCount}` : '';
    return {
      prewarmed: subs.length,
      targets: result.targetCount,
      ok: result.ok,
      errors: result.failed > 0 ? 1 : 0,
    };
  } catch (err) {
    lastPrewarmError = err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140);
    return { prewarmed: subs.length, targets: 0, ok: 0, errors: 1 };
  }
}

async function sendReport(bot: ReportBot, sub: CsReportSubscription, report: string): Promise<boolean> {
  if (sub.chatType === 'group' && sub.groupId && bot.sendGroupMessage) {
    return bot.sendGroupMessage(sub.groupId, report);
  }
  if (sub.chatType === 'private' && bot.sendPrivateMessage) {
    return bot.sendPrivateMessage(sub.chatId, report);
  }
  return false;
}

function formatReportEvidenceSummary(chatType: ReportChatType, chatId: number): string {
  const plan = buildCsPrewarmPlan(['all'], {
    chats: [{ chatType, chatId }],
    maxDynamicTargets: REPORT_PREWARM_DYNAMIC_TARGETS,
  });
  const coreKeys = new Set(['matches', 'results', 'ranking']);
  const coreRows = plan.rows.filter((row) => coreKeys.has(row.cacheKey));
  const dynamicRows = plan.rows.filter((row) => !coreKeys.has(row.cacheKey));
  const staleRows = plan.rows.filter((row) => row.status === 'stale');
  const missRows = plan.rows.filter((row) => row.status === 'miss');
  const formatRow = (row: typeof plan.rows[number]): string => `${row.label}[${row.cacheKey}]`;
  const compactRows = (rows: typeof plan.rows): string => {
    const shown = rows.slice(0, 4).map(formatRow).join(', ');
    return rows.length > 4 ? `${shown} 等${rows.length}项` : shown;
  };

  return [
    '【数据证据摘要】',
    `核心缓存: ${coreRows.map((row) => `${row.cacheKey}=${row.status}`).join(' / ') || '无'}`,
    `动态目标: ${dynamicRows.length}个；总计 fresh ${plan.fresh}/${plan.targetCount}，stale ${plan.stale}，miss ${plan.miss}`,
    staleRows.length > 0 ? `过期快照: ${compactRows(staleRows)}` : '',
    missRows.length > 0 ? `本地无快照: ${compactRows(missRows)}` : '',
    '边界: 日报、关注快照和竞猜摘要都以来源时间/链接为准；stale 只能当旧快照线索，miss 不能当没有比赛/没有赛果的实时结论。',
  ].filter(Boolean).join('\n');
}

function formatFocusEvidenceLine(chatType: ReportChatType, chatId: number): string {
  const plan = buildCsPrewarmPlan(['all'], {
    chats: [{ chatType, chatId }],
    maxDynamicTargets: REPORT_PREWARM_DYNAMIC_TARGETS,
  });
  const core = ['matches', 'results', 'ranking']
    .map((key) => `${key}=${plan.rows.find((row) => row.cacheKey === key)?.status || 'miss'}`)
    .join(' / ');
  const requestCount = plan.stale + plan.miss;
  return `证据: ${core}；动态目标 fresh ${plan.fresh}/${plan.targetCount}，待补证 ${requestCount}。`;
}

function trimOneScreenReport(text: string, maxChars = 1900): string {
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > maxChars
    ? `${cleaned.slice(0, maxChars)}...\n(已压缩，完整日报看 /csreport now，证据预检看 /csreport check)`
    : cleaned;
}

async function buildFocusReportForChat(
  baseReport: string,
  chatType: ReportChatType,
  chatId: number,
): Promise<string> {
  const pulledAt = new Date().toLocaleString('zh-CN', { timeZone: REPORT_TIMEZONE, hour12: false });
  const watchPrefs = getCsWatchPreferencesForChat(chatType, chatId);
  const [watchDigest, predictDigest] = await Promise.all([
    buildCsWatchDigestForChat(chatType, chatId, { maxItems: 2, maxChars: 520, timeoutMs: 3000 }).catch((err) => {
      const message = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100);
      return `【盯变化】\n关注快照拉取失败：${message}`;
    }),
    buildCsPredictDigestForChat(chatType, chatId, {
      maxActive: 2,
      maxRecent: 1,
      maxBoard: 3,
      maxCandidates: 2,
      maxChars: 520,
      timeoutMs: 3000,
    }).catch((err) => {
      const message = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100);
      return `【本会话CS竞猜】\n读取失败：${message}`;
    }),
  ]);
  const leadLines = buildFocusLeadLines(baseReport, watchPrefs);
  const watchFallback = watchPrefs.length > 0
    ? ''
    : '【盯变化】\n当前会话还没关注目标；例子 /watch team Vitality、/watch player donk、/watch match NAVI。';
  const predictFallback = predictDigest || '【本会话CS竞猜】\n暂无盘口/候选，先 /predict matches 看实时赛程。';

  return trimOneScreenReport([
    `CS今日看点 | ${pulledAt}`,
    '先看:',
    ...leadLines.map((line) => `- ${line}`),
    '',
    '盯变化:',
    watchDigest || watchFallback,
    '',
    '竞猜:',
    predictFallback,
    '',
    formatFocusEvidenceLine(chatType, chatId),
    '边界: stale 只能当旧快照线索，miss 不能反推没有比赛/赛果/变动；完整证据和预热建议看 /csreport check 或 /watch plan。',
    '操作: 完整日报 /csreport now；管理员预热 /cs warm plan all。',
  ].filter((line) => line !== '').join('\n'));
}

async function buildReportForChat(
  baseReport: string,
  chatType: ReportChatType,
  chatId: number,
  watchDigestCache?: Map<string, Promise<string>>,
  predictDigestCache?: Map<string, Promise<string>>,
): Promise<string> {
  const key = `${chatType}:${chatId}`;
  let watchDigestPromise = watchDigestCache?.get(key);
  if (!watchDigestPromise) {
    watchDigestPromise = buildCsWatchDigestForChat(chatType, chatId, { maxItems: 3, maxChars: 1100, timeoutMs: 4500 }).catch((err) => {
      const message = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      return `【本会话关注目标】\n拉取失败：${message}`;
    });
    watchDigestCache?.set(key, watchDigestPromise);
  }
  let predictDigestPromise = predictDigestCache?.get(key);
  if (!predictDigestPromise) {
    predictDigestPromise = buildCsPredictDigestForChat(chatType, chatId, {
      maxActive: 3,
      maxRecent: 2,
      maxBoard: 5,
      maxCandidates: 3,
      maxChars: 1100,
      timeoutMs: 3500,
    })
      .catch((err) => {
        const message = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
        return `【本会话CS竞猜】\n读取失败：${message}`;
      });
    predictDigestCache?.set(key, predictDigestPromise);
  }
  const [watchDigest, predictDigest] = await Promise.all([watchDigestPromise, predictDigestPromise]);
  const extras = [watchDigest, predictDigest].filter(Boolean);
  const personalizedBase = personalizeReportForChat(baseReport, chatType, chatId);
  const evidenceSummary = formatReportEvidenceSummary(chatType, chatId);
  return [personalizedBase, ...extras, evidenceSummary].filter(Boolean).join('\n\n');
}

export async function runDueCsReports(
  bot: ReportBot,
  date: Date = new Date(),
): Promise<{ checked: number; due: number; sent: number; errors: number; prewarmed: number; prewarmTargets: number }> {
  if (reportRunning) return { checked: 0, due: 0, sent: 0, errors: 0, prewarmed: 0, prewarmTargets: 0 };
  reportRunning = true;
  lastRunAt = Date.now();
  lastRunError = '';
  try {
    const store = loadStore();
    const dueSubs = store.subscriptions.filter((item) => isDue(item, date));
    const prewarmSubs = dueSubs.length > 0
      ? dueSubs
      : store.subscriptions.filter((item) => isPrewarmDue(item, date));
    const prewarm = await maybePrewarmReportData(prewarmSubs, date);
    let report = '';
    let sent = 0;
    let errors = 0;
    const dateKey = formatShanghaiParts(date).dateKey;
    const watchDigestCache = new Map<string, Promise<string>>();
    const predictDigestCache = new Map<string, Promise<string>>();
    for (const sub of dueSubs) {
      try {
        if (!report) report = await buildBaseReport();
        const reportForChat = await buildReportForChat(report, sub.chatType, sub.chatId, watchDigestCache, predictDigestCache);
        const ok = await sendReport(bot, sub, reportForChat);
        sub.updatedAt = Date.now();
        if (ok) {
          sent++;
          sub.lastSentDate = dateKey;
          sub.lastSentAt = Date.now();
          sub.lastError = '';
        } else {
          errors++;
          sub.lastError = 'send failed';
        }
      } catch (err) {
        errors++;
        sub.updatedAt = Date.now();
        sub.lastError = err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140);
      }
    }
    saveStore(store);
    lastRunChecked = store.subscriptions.length;
    lastRunSent = sent;
    return {
      checked: store.subscriptions.length,
      due: dueSubs.length,
      sent,
      errors,
      prewarmed: prewarm.prewarmed,
      prewarmTargets: prewarm.targets,
    };
  } catch (err) {
    lastRunError = err instanceof Error ? err.message : String(err);
    return { checked: 0, due: 0, sent: 0, errors: 1, prewarmed: 0, prewarmTargets: 0 };
  } finally {
    reportRunning = false;
  }
}

function formatReportStatsLine(): string {
  const stats = getCsReportStats();
  return `${stats.subscriptions}个 群${stats.groupChats} 私聊${stats.privateChats} timer=${stats.timerEnabled ? 'on' : 'off'} running=${stats.running} 最近${nowText(stats.lastRunAt)} 检查${stats.lastRunChecked} 推送${stats.lastRunSent} 预热${stats.lastPrewarmChecked}/${stats.lastPrewarmTargets} OK${stats.lastPrewarmOk} 底稿缓存${stats.baseReportCacheWarm ? 'warm' : 'cold'} 命中${stats.baseReportCacheHits}/${stats.baseReportCacheMisses} 合并${stats.baseReportInFlightHits}${stats.lastRunError || stats.lastPrewarmError ? ` 错误=${stats.lastRunError || stats.lastPrewarmError}` : ''}`;
}

export function getCsReportStats(): {
  subscriptions: number;
  groupChats: number;
  privateChats: number;
  running: boolean;
  timerEnabled: boolean;
  lastRunAt: number;
  lastRunChecked: number;
  lastRunSent: number;
  lastRunError: string;
  lastPrewarmAt: number;
  lastPrewarmChecked: number;
  lastPrewarmTargets: number;
  lastPrewarmOk: number;
  lastPrewarmError: string;
  baseReportCacheWarm: boolean;
  baseReportCacheAgeSeconds: number;
  baseReportCacheTtlSeconds: number;
  baseReportCacheHits: number;
  baseReportCacheMisses: number;
  baseReportCacheWrites: number;
  baseReportInFlight: boolean;
  baseReportInFlightHits: number;
} {
  const store = loadStore();
  const enabled = store.subscriptions.filter((item) => item.enabled);
  const now = Date.now();
  const baseReportCacheAgeSeconds = baseReportCacheAt ? Math.max(0, Math.round((now - baseReportCacheAt) / 1000)) : 0;
  const baseReportCacheTtlSeconds = baseReportCacheAt ? Math.max(0, Math.round((REPORT_BASE_CACHE_MS - (now - baseReportCacheAt)) / 1000)) : 0;
  return {
    subscriptions: enabled.length,
    groupChats: new Set(enabled.filter((item) => item.chatType === 'group').map((item) => item.chatId)).size,
    privateChats: new Set(enabled.filter((item) => item.chatType === 'private').map((item) => item.chatId)).size,
    running: reportRunning,
    timerEnabled: !!reportTimer,
    lastRunAt,
    lastRunChecked,
    lastRunSent,
    lastRunError,
    lastPrewarmAt,
    lastPrewarmChecked,
    lastPrewarmTargets,
    lastPrewarmOk,
    lastPrewarmError,
    baseReportCacheWarm: !!baseReportCacheValue && now - baseReportCacheAt <= REPORT_BASE_CACHE_MS,
    baseReportCacheAgeSeconds,
    baseReportCacheTtlSeconds,
    baseReportCacheHits,
    baseReportCacheMisses,
    baseReportCacheWrites,
    baseReportInFlight: !!baseReportInFlight,
    baseReportInFlightHits,
  };
}

export function startCsReportTasks(bot: ReportBot, intervalSeconds: number = DEFAULT_CHECK_INTERVAL_SECONDS): void {
  shutdownCsReportTasks();
  const intervalMs = Math.max(30, intervalSeconds) * 1000;
  reportTimer = setInterval(() => {
    void runDueCsReports(bot);
  }, intervalMs);
  reportTimer.unref();
}

export function shutdownCsReportTasks(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
}

export const csReportPlugin: Plugin = {
  name: 'cs-report',
  description: 'CS 每日报订阅推送',
  handler: async (ctx) => {
    const naturalTime = ctx.command ? null : parseNaturalReportSubscribe(ctx.rawText);
    const isReportCommand = ['csreport', 'csdigest', 'csdailyreport', '日报订阅', 'cs日报'].includes(ctx.command || '');
    if (!isReportCommand && naturalTime === null) return false;

    if (naturalTime !== null) {
      ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, naturalTime));
      return true;
    }

    const sub = (ctx.args[0] || '').toLowerCase();
    if (!sub || sub === 'now' || sub === 'run' || sub === 'push' || sub === '发送' || sub === '立即') {
      const baseReport = await buildBaseReport();
      ctx.reply(await buildReportForChat(baseReport, ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'focus' || sub === 'brief' || sub === 'short' || sub === 'lite' || sub === '看点' || sub === '短版' || sub === '一屏') {
      const baseReport = await buildBaseReport();
      ctx.reply(await buildFocusReportForChat(baseReport, ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'on' || sub === 'enable' || sub === '订阅' || sub === '开启') {
      const time = normalizeReportTime(ctx.args[1]) || DEFAULT_REPORT_TIME;
      ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, time));
      return true;
    }

    if (sub === 'time' || sub === 'set' || sub === '时间') {
      const time = normalizeReportTime(ctx.args[1]);
      if (!time) {
        ctx.reply('用法: /csreport time 09:30');
        return true;
      }
      ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, time));
      return true;
    }

    if (sub === 'off' || sub === 'disable' || sub === '取消' || sub === '关闭') {
      ctx.reply(removeSubscription(ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'status' || sub === 'list' || sub === '状态') {
      ctx.reply(formatCurrentSubscription(ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'check' || sub === 'plan' || sub === 'dry-run' || sub === '预检' || sub === '检查') {
      ctx.reply(buildCsReportPreflight(ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'due' || sub === 'tick' || sub === 'run-due' || sub === '执行检查') {
      const config = ctx.bot.getConfig();
      if (!config.admin_qq.includes(ctx.event.user_id)) {
        ctx.replyAt('这个得管理员来手动跑。');
        return true;
      }
      const result = await runDueCsReports(ctx.bot);
      ctx.reply(`CS日报检查完成: 检查${result.checked} 到期${result.due} 预热${result.prewarmed}/${result.prewarmTargets} 推送${result.sent} 错误${result.errors}`);
      return true;
    }

    ctx.reply([
      'CS日报用法:',
      '/csreport - 立即看一份',
      '/csreport focus - 一屏今日看点：先看什么、盯谁变化、竞猜入口和证据边界',
      `/csreport on ${DEFAULT_REPORT_TIME} - 当前群/私聊每天推送`,
      '/csreport time 09:45 - 修改推送时间',
      '/csreport status - 查看当前会话订阅',
      '/csreport check - 只读预检日报订阅、预热目标和缓存新鲜度',
      '/csreport due - 管理员执行一次真实定时检查',
      '/csreport off - 关闭当前会话日报',
    ].join('\n'));
    return true;
  },
};

export const __test = {
  __setStorePathForTests(filepath?: string): void {
    storePathOverride = filepath || '';
  },
  __setReportBuilderForTests(builder?: ReportBuilder): void {
    reportBuilder = builder || buildCsDailyReport;
    resetBaseReportCache();
  },
  __setPrewarmRunnerForTests(runner?: ReportPrewarmRunner): void {
    reportPrewarmRunner = runner || prewarmCsDataForReport;
  },
  normalizeReportTime,
  parseNaturalReportSubscribe,
  buildPreferenceHighlights,
  personalizeReportForChat,
  buildCsReportPreflight,
  buildFocusReportForChat,
  buildBaseReport,
  getCsReportStatsForTests: getCsReportStats,
  loadStore,
  runDueCsReports,
  resetForTests(): void {
    shutdownCsReportTasks();
    storePathOverride = '';
    reportBuilder = buildCsDailyReport;
    reportPrewarmRunner = prewarmCsDataForReport;
    reportRunning = false;
    lastRunAt = 0;
    lastRunChecked = 0;
    lastRunSent = 0;
    lastRunError = '';
    lastPrewarmAt = 0;
    lastPrewarmChecked = 0;
    lastPrewarmTargets = 0;
    lastPrewarmOk = 0;
    lastPrewarmError = '';
    lastPrewarmKey = '';
    resetBaseReportCache();
    baseReportCacheHits = 0;
    baseReportCacheMisses = 0;
    baseReportCacheWrites = 0;
    baseReportInFlightHits = 0;
  },
};
