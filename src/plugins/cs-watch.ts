import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Plugin } from '../types';
import {
  fetchOngoingMatches,
  fetchPlayerProfile,
  fetchRecentResults,
  fetchTeamProfile,
  getCsProfileCacheKey,
  inspectHltvCacheEntry,
} from './hltv-api';
import { buildCsPlanFactTypeCoverageLines } from './cs-fact-coverage';
import type { CsFactTypePlanItem } from './cs-fact-coverage';

export type WatchKind = 'team' | 'player' | 'match';

interface PlayerStatSnapshot {
  rating?: number;
  adr?: number;
  kast?: number;
  kd?: number;
  maps?: number;
}

interface TeamMapStatSnapshot {
  map: string;
  wins?: number;
  played?: number;
  winRate?: number;
}

interface CsWatchSubscription {
  id: string;
  kind: WatchKind;
  subject: string;
  cacheKey: string;
  chatType: 'group' | 'private';
  chatId: number;
  groupId?: number;
  userId: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number;
  lastNotifiedAt: number;
  lastStartReminderAt: number;
  lastStartReminderKey: string;
  lastRosterMembers: string[];
  lastRosterChangeAt: number;
  lastMapStats: TeamMapStatSnapshot[];
  lastMapChangeAt: number;
  lastPlayerStats: PlayerStatSnapshot;
  lastPlayerChangeAt: number;
  lastDigest: string;
  lastError: string;
}

interface CsWatchStore {
  version: 1;
  subscriptions: CsWatchSubscription[];
}

interface WatchBot {
  sendGroupMessage?: (groupId: number, message: string) => Promise<boolean>;
  sendPrivateMessage?: (userId: number, message: string) => Promise<boolean>;
}

type ProfileFetcher = (kind: WatchKind, subject: string) => Promise<string>;

const DEFAULT_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'cs-watch.json');
const MAX_SUBS_PER_CHAT = 12;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_START_REMINDER_MINUTES = 60;
const START_REMINDER_GRACE_MINUTES = 5;

let storePathOverride = '';
let profileFetcher: ProfileFetcher = async (kind, subject) => {
  return fetchWatchSnapshot(kind, subject);
};
let watchTimer: NodeJS.Timeout | null = null;
let watchRunning = false;
let lastRunAt = 0;
let lastRunError = '';
let lastRunChecked = 0;
let lastRunNotifications = 0;
let lastRunStartReminders = 0;
let lastRunRosterChanges = 0;
let lastRunMapChanges = 0;
let lastRunPlayerChanges = 0;

function storePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

function emptyStore(): CsWatchStore {
  return { version: 1, subscriptions: [] };
}

function normalizePlayerStats(value: unknown): PlayerStatSnapshot {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const snapshot: PlayerStatSnapshot = {};
  for (const key of ['rating', 'adr', 'kast', 'kd', 'maps'] as const) {
    const num = Number(source[key]);
    if (Number.isFinite(num)) snapshot[key] = num;
  }
  return snapshot;
}

function normalizeMapStats(value: unknown): TeamMapStatSnapshot[] {
  if (!Array.isArray(value)) return [];
  const result: TeamMapStatSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const map = normalizeSubjectForDisplay(String(source.map || '')).slice(0, 32);
    if (!map) continue;
    const snapshot: TeamMapStatSnapshot = { map };
    for (const key of ['wins', 'played', 'winRate'] as const) {
      const num = Number(source[key]);
      if (Number.isFinite(num)) snapshot[key] = num;
    }
    result.push(snapshot);
    if (result.length >= 8) break;
  }
  return result;
}

function loadStore(): CsWatchStore {
  const filepath = storePath();
  if (!fs.existsSync(filepath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const subscriptions = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    return {
      version: 1,
      subscriptions: subscriptions
        .filter((item: Partial<CsWatchSubscription>) => item && item.id && item.kind && item.subject && item.chatId)
        .map((item: CsWatchSubscription) => ({
          ...item,
          kind: item.kind === 'player' || item.kind === 'match' ? item.kind : 'team',
          chatType: item.chatType === 'private' ? 'private' : 'group',
          lastCheckedAt: Number(item.lastCheckedAt || 0),
          lastNotifiedAt: Number(item.lastNotifiedAt || 0),
          lastStartReminderAt: Number(item.lastStartReminderAt || 0),
          lastStartReminderKey: String(item.lastStartReminderKey || ''),
          lastRosterMembers: Array.isArray(item.lastRosterMembers)
            ? item.lastRosterMembers.map((member) => normalizeSubjectForDisplay(String(member))).filter(Boolean).slice(0, 10)
            : [],
          lastRosterChangeAt: Number(item.lastRosterChangeAt || 0),
          lastMapStats: normalizeMapStats(item.lastMapStats),
          lastMapChangeAt: Number(item.lastMapChangeAt || 0),
          lastPlayerStats: normalizePlayerStats(item.lastPlayerStats),
          lastPlayerChangeAt: Number(item.lastPlayerChangeAt || 0),
          lastDigest: String(item.lastDigest || ''),
          lastError: String(item.lastError || ''),
        })),
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store: CsWatchStore): void {
  const filepath = storePath();
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

function nowText(timestamp: number): string {
  return timestamp
    ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '无';
}

function shanghaiParts(timestamp: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function shanghaiWallTimeToEpochMs(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

function normalizeSubjectForDisplay(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value: string): string {
  return normalizeSubjectForDisplay(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function kindLabel(kind: WatchKind): string {
  if (kind === 'player') return '选手';
  if (kind === 'match') return '赛程/赛果';
  return '队伍';
}

function parseKind(value: string): WatchKind | null {
  const lower = value.toLowerCase();
  if (['team', '队伍', '战队', 'club'].includes(lower)) return 'team';
  if (['player', '选手', '哥们'].includes(lower)) return 'player';
  if (['match', 'matches', 'game', 'games', '赛程', '比赛', '赛果', '战报'].includes(lower)) return 'match';
  return null;
}

function parseNaturalWatch(rawText: string): { kind: WatchKind; subject: string } | null {
  const text = rawText.replace(/^\s*\[CQ:[^\]]+\]\s*/g, '').trim();
  const match = text.match(/^(?:订阅|关注|盯一下|盯着|帮我盯|watch)\s*(?:(team|队伍|战队|player|选手|match|matches|比赛|赛程|赛果|战报)\s*)?(.{1,60})$/i);
  if (!match) return null;
  const explicit = match[1] ? parseKind(match[1]) : null;
  let subject = (match[2] || '').trim();
  subject = subject.replace(/^(?:一下|下|这个|这支|这个队|这个选手)\s*/, '').trim();
  if (!subject) return null;
  const looksMatch = /(?:比赛|赛程|赛果|战报|打谁|哪场|什么时候打|开赛|赛后|比分)/.test(subject);
  const looksPlayer = /\b(?:donk|zywoo|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|karrigan|device|broky|frozen|mezii|flamez|apex|cadia?n)\b/i.test(subject)
    || /选手|职业哥|哥们/.test(subject);
  const kind = explicit || (looksMatch ? 'match' : looksPlayer ? 'player' : 'team');
  subject = subject
    .replace(/^(?:team|队伍|战队|player|选手|match|matches|比赛|赛程|赛果|战报)\s+/i, '')
    .replace(/(?:的)?(?:比赛|赛程|赛果|战报|开赛提醒|赛后提醒)\s*$/i, '')
    .trim();
  return subject ? { kind, subject } : null;
}

function getWatchCacheKey(kind: WatchKind, subject: string): string {
  if (kind === 'match') return `match:${normalizeComparable(subject)}`;
  return getCsProfileCacheKey(kind, subject);
}

function lineMentionsSubject(line: string, subject: string): boolean {
  const token = normalizeComparable(subject);
  const normalizedLine = normalizeComparable(line);
  return !!token && normalizedLine.includes(token);
}

function parseStartTimeFromLine(line: string, now: number): number | null {
  const nowParts = shanghaiParts(now);
  const absolute = line.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})\b/);
  if (absolute) {
    return shanghaiWallTimeToEpochMs(
      Number(absolute[1]),
      Number(absolute[2]),
      Number(absolute[3]),
      Number(absolute[4]),
      Number(absolute[5]),
    );
  }

  const monthDay = line.match(/\b(\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})\b/);
  if (monthDay) {
    let target = shanghaiWallTimeToEpochMs(nowParts.year, Number(monthDay[1]), Number(monthDay[2]), Number(monthDay[3]), Number(monthDay[4]));
    if (target < now - 30 * 24 * 60 * 60 * 1000) {
      target = shanghaiWallTimeToEpochMs(nowParts.year + 1, Number(monthDay[1]), Number(monthDay[2]), Number(monthDay[3]), Number(monthDay[4]));
    }
    return target;
  }

  const relative = line.match(/(?:今天|今日|明天|明日)\s*(\d{1,2}):(\d{2})/);
  if (relative) {
    const dayOffset = /明天|明日/.test(relative[0]) ? 1 : 0;
    const dayStart = shanghaiWallTimeToEpochMs(nowParts.year, nowParts.month, nowParts.day, 0, 0);
    return dayStart + dayOffset * 24 * 60 * 60 * 1000 + (Number(relative[1]) * 60 + Number(relative[2])) * 60 * 1000;
  }

  return null;
}

function findSourceLine(profile: string): string {
  return (profile || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^来源[:：]/.test(line)) || '';
}

function normalizeRosterMember(value: string): string {
  return normalizeSubjectForDisplay(value)
    .replace(/^(?:当前阵容|阵容|roster|lineup|players?)\s*[:：-]?\s*/i, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRosterMembers(profile: string): string[] {
  const members: string[] = [];
  for (const rawLine of (profile || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^(?:当前阵容|阵容|roster|lineup|players?)\s*[:：]/i.test(line)) continue;
    const rawMembers = line
      .replace(/^(?:当前阵容|阵容|roster|lineup|players?)\s*[:：]\s*/i, '')
      .split(/[,，、/|]+|\s{2,}/)
      .map(normalizeRosterMember)
      .filter((item) => item && item.length <= 40 && !/^(?:暂无|未知|none|unknown|n\/a)$/i.test(item));
    for (const member of rawMembers) {
      const key = normalizeComparable(member);
      if (key && !members.some((item) => normalizeComparable(item) === key)) members.push(member);
    }
  }
  return members.slice(0, 10);
}

function compareRosterMembers(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const prevByKey = new Map<string, string>();
  const currByKey = new Map<string, string>();
  for (const member of previous) {
    const key = normalizeComparable(member);
    if (key) prevByKey.set(key, member);
  }
  for (const member of current) {
    const key = normalizeComparable(member);
    if (key) currByKey.set(key, member);
  }
  return {
    added: [...currByKey.entries()].filter(([key]) => !prevByKey.has(key)).map(([, member]) => member),
    removed: [...prevByKey.entries()].filter(([key]) => !currByKey.has(key)).map(([, member]) => member),
  };
}

function normalizeMapName(value: string): string {
  return normalizeSubjectForDisplay(value)
    .replace(/^(?:地图样本|地图|map(?:\s+stats?)?|maps?)\s*[:：-]?\s*/i, '')
    .trim();
}

function parseMapStats(profile: string): TeamMapStatSnapshot[] {
  const stats: TeamMapStatSnapshot[] = [];
  for (const rawLine of (profile || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^(?:地图样本|地图|map(?:\s+stats?)?|maps?)\s*[:：]/i.test(line)) continue;
    const body = line.replace(/^(?:地图样本|地图|map(?:\s+stats?)?|maps?)\s*[:：]\s*/i, '');
    const chunks = body.split(/\s+\/\s+|[,，、|]+/).map((item) => item.trim()).filter(Boolean);
    for (const chunk of chunks) {
      const winRateMatch = chunk.match(/^(.+?)\s+(\d{1,3})\s*\/\s*(\d{1,3})(?:\s+(\d{1,3})\s*%)?$/);
      const playedOnlyMatch = chunk.match(/^(.+?)\s+(\d{1,3})\s*(?:场|maps?)$/i);
      let snapshot: TeamMapStatSnapshot | null = null;
      if (winRateMatch) {
        const map = normalizeMapName(winRateMatch[1]);
        const wins = Number(winRateMatch[2]);
        const played = Number(winRateMatch[3]);
        const winRate = winRateMatch[4] ? Number(winRateMatch[4]) : played > 0 ? Math.round((wins / played) * 100) : undefined;
        if (map && Number.isFinite(wins) && Number.isFinite(played)) snapshot = { map, wins, played, winRate };
      } else if (playedOnlyMatch) {
        const map = normalizeMapName(playedOnlyMatch[1]);
        const played = Number(playedOnlyMatch[2]);
        if (map && Number.isFinite(played)) snapshot = { map, played };
      }
      if (!snapshot) continue;
      const key = normalizeComparable(snapshot.map);
      if (key && !stats.some((item) => normalizeComparable(item.map) === key)) stats.push(snapshot);
      if (stats.length >= 8) break;
    }
  }
  return stats;
}

function formatMapStat(stat: TeamMapStatSnapshot): string {
  const sample = typeof stat.wins === 'number' && typeof stat.played === 'number'
    ? `${stat.wins}/${stat.played}`
    : typeof stat.played === 'number' ? `${stat.played}场` : '';
  const rate = typeof stat.winRate === 'number' ? `${stat.winRate}%` : '';
  return [stat.map, sample, rate].filter(Boolean).join(' ');
}

function compareMapStats(previous: TeamMapStatSnapshot[], current: TeamMapStatSnapshot[]): string[] {
  const prevByKey = new Map<string, TeamMapStatSnapshot>();
  const currByKey = new Map<string, TeamMapStatSnapshot>();
  for (const item of previous) {
    const key = normalizeComparable(item.map);
    if (key) prevByKey.set(key, item);
  }
  for (const item of current) {
    const key = normalizeComparable(item.map);
    if (key) currByKey.set(key, item);
  }
  const lines: string[] = [];
  for (const [key, item] of currByKey) {
    const prev = prevByKey.get(key);
    if (!prev) {
      lines.push(`新增: ${formatMapStat(item)}`);
      continue;
    }
    const changed = ['wins', 'played', 'winRate'].some((field) => {
      const name = field as keyof TeamMapStatSnapshot;
      return typeof item[name] === 'number' && typeof prev[name] === 'number' && item[name] !== prev[name];
    });
    if (changed) lines.push(`${item.map}: ${formatMapStat(prev)} -> ${formatMapStat(item)}`);
  }
  for (const [key, item] of prevByKey) {
    if (!currByKey.has(key)) lines.push(`移出: ${formatMapStat(item)}`);
  }
  return lines.slice(0, 6);
}

function formatRosterChangeMessage(
  sub: CsWatchSubscription,
  diff: { added: string[]; removed: string[] },
  profile: string,
): string {
  const sourceLine = findSourceLine(profile);
  return [
    `CS阵容变化提醒 | ${sub.subject}`,
    diff.added.length > 0 ? `新增: ${diff.added.join(', ')}` : '',
    diff.removed.length > 0 ? `移出: ${diff.removed.join(', ')}` : '',
    sourceLine ? `证据: ${sourceLine}` : '证据: CS队伍资料链路',
    '',
    shortProfile(profile, 650),
    '机器短评：阵容这种事看来源时间，先别拿上周印象硬套今天。',
  ].filter((line) => line !== '').join('\n');
}

function formatMapChangeMessage(
  sub: CsWatchSubscription,
  changes: string[],
  profile: string,
): string {
  const sourceLine = findSourceLine(profile);
  return [
    `CS地图样本变化提醒 | ${sub.subject}`,
    ...changes,
    sourceLine ? `证据: ${sourceLine}` : '证据: CS队伍地图统计链路',
    '',
    shortProfile(profile, 650),
    '机器短评：地图胜率看样本量，别一张图涨了就当版本答案，先看来源时间。',
  ].filter((line) => line !== '').join('\n');
}

function parseNumberFromLine(line: string, pattern: RegExp): number | undefined {
  const match = line.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parsePlayerStats(profile: string): PlayerStatSnapshot {
  const stats: PlayerStatSnapshot = {};
  for (const rawLine of (profile || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Rating\s*[:：]/i.test(line)) {
      stats.rating = parseNumberFromLine(line, /^Rating\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
      stats.maps = parseNumberFromLine(line, /[（(]\s*([0-9]+)\s*(?:图|maps?)/i);
      continue;
    }
    if (/^ADR\s*[:：]/i.test(line)) {
      stats.adr = parseNumberFromLine(line, /^ADR\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
      continue;
    }
    if (/^KAST\s*[:：]/i.test(line)) {
      stats.kast = parseNumberFromLine(line, /^KAST\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
      continue;
    }
    if (/^K\/D\s*[:：]/i.test(line)) {
      stats.kd = parseNumberFromLine(line, /^K\/D\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
    }
  }
  return stats;
}

function hasPlayerStats(stats: PlayerStatSnapshot): boolean {
  return ['rating', 'adr', 'kast', 'kd'].some((key) => typeof stats[key as keyof PlayerStatSnapshot] === 'number');
}

function statDeltaLine(label: string, previous?: number, current?: number, digits = 3, threshold = 0.001): string {
  if (typeof previous !== 'number' || typeof current !== 'number') return '';
  const delta = current - previous;
  if (Math.abs(delta) < threshold) return '';
  const sign = delta > 0 ? '+' : '';
  return `${label}: ${previous.toFixed(digits)} -> ${current.toFixed(digits)} (${sign}${delta.toFixed(digits)})`;
}

function comparePlayerStats(previous: PlayerStatSnapshot, current: PlayerStatSnapshot): string[] {
  return [
    statDeltaLine('Rating', previous.rating, current.rating, 3, 0.005),
    statDeltaLine('ADR', previous.adr, current.adr, 1, 0.1),
    statDeltaLine('KAST', previous.kast, current.kast, 1, 0.1),
    statDeltaLine('K/D', previous.kd, current.kd, 2, 0.005),
  ].filter(Boolean);
}

function formatPlayerStatChangeMessage(
  sub: CsWatchSubscription,
  changes: string[],
  profile: string,
): string {
  const sourceLine = findSourceLine(profile);
  return [
    `CS选手数据变化提醒 | ${sub.subject}`,
    ...changes,
    sourceLine ? `证据: ${sourceLine}` : '证据: CS选手统计链路',
    '',
    shortProfile(profile, 650),
    '机器短评：选手数据会滚动更新，先看样本图数和来源时间，别用印象流硬判状态。',
  ].filter((line) => line !== '').join('\n');
}

function findUpcomingStartReminder(
  sub: CsWatchSubscription,
  profile: string,
  now: number,
): { key: string; startsAt: number; line: string; sourceLine: string } | null {
  if (sub.kind !== 'match') return null;
  const leadMs = DEFAULT_START_REMINDER_MINUTES * 60 * 1000;
  const graceMs = START_REMINDER_GRACE_MINUTES * 60 * 1000;
  const sourceLine = findSourceLine(profile);
  for (const rawLine of (profile || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^来源[:：]/.test(line) || /^缓存[:：]/.test(line)) continue;
    if (/🔴|LIVE|近期赛果|胜者|已结束/i.test(line)) continue;
    if (!/vs/i.test(line) || !lineMentionsSubject(line, sub.subject)) continue;
    const startsAt = parseStartTimeFromLine(line, now);
    if (!startsAt) continue;
    const diff = startsAt - now;
    if (diff > leadMs || diff < -graceMs) continue;
    const keyHash = crypto.createHash('sha1').update(`${sub.cacheKey}:${startsAt}:${line}`).digest('hex').slice(0, 12);
    return { key: `start-${keyHash}`, startsAt, line: line.slice(0, 220), sourceLine };
  }
  return null;
}

function formatStartReminderMessage(
  sub: CsWatchSubscription,
  reminder: { startsAt: number; line: string; sourceLine: string },
  profile: string,
): string {
  const startsAt = new Date(reminder.startsAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return [
    `CS开赛提醒 | ${sub.subject}`,
    `开赛: ${startsAt}`,
    `赛程: ${reminder.line}`,
    reminder.sourceLine ? `证据: ${reminder.sourceLine}` : '证据: CS实时赛程链路',
    '',
    shortProfile(profile, 520),
    '机器短评：快开了就别云，阵容/时间以这条来源快照为准。',
  ].filter((line) => line !== '').join('\n');
}

function keepEvidenceAndSubjectLines(text: string, subject: string, maxSubjectLines: number): string[] {
  const result: string[] = [];
  let sourceLine = '';
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^来源[:：]/.test(line)) {
      sourceLine = line.slice(0, 140);
      continue;
    }
    if (/^(?:缓存|主源|说明)[:：]/.test(line)) continue;
    if (lineMentionsSubject(line, subject)) {
      if (sourceLine && result.length === 0) result.push(sourceLine);
      result.push(line.slice(0, 180));
      if (result.filter((item) => item !== sourceLine).length >= maxSubjectLines) break;
    }
  }
  return result;
}

async function fetchMatchSnapshot(subject: string): Promise<string> {
  const [matches, results] = await Promise.all([
    withTimeout(fetchOngoingMatches().catch(() => ''), 6500, ''),
    withTimeout(fetchRecentResults().catch(() => ''), 6500, ''),
  ]);
  const matchLines = keepEvidenceAndSubjectLines(matches, subject, 5);
  const resultLines = keepEvidenceAndSubjectLines(results, subject, 5);
  if (matchLines.length === 0 && resultLines.length === 0) {
    const evidence = (matches || results).split(/\r?\n/).find((line) => /^来源[:：]/.test(line.trim()))?.trim() || '';
    return [
      evidence || `来源：CS实时赛程/赛果链路 / 拉取 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
      `${subject}: 当前赛程/赛果里没筛到明确相关条目。`,
    ].join('\n');
  }
  return [
    `来源：CS实时赛程/赛果关注 / 拉取 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `关注目标: ${subject}`,
    matchLines.length > 0 ? '【当前/即将比赛】' : '',
    ...matchLines,
    resultLines.length > 0 ? '【近期赛果】' : '',
    ...resultLines,
  ].filter(Boolean).join('\n');
}

async function fetchWatchSnapshot(kind: WatchKind, subject: string): Promise<string> {
  if (kind === 'team') return fetchTeamProfile(subject);
  if (kind === 'player') return fetchPlayerProfile(subject);
  return fetchMatchSnapshot(subject);
}

function digestProfile(profile: string): string {
  const stable = profile
    .split(/\r?\n/)
    .filter((line) => !/^来源[:：]/.test(line.trim()))
    .filter((line) => !/^缓存[:：]/.test(line.trim()))
    .join('\n')
    .replace(/拉取\s*\d{4}\/\d{1,2}\/\d{1,2}[^ \n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha1').update(stable || profile).digest('hex').slice(0, 16);
}

function makeId(kind: WatchKind, cacheKey: string, chatType: string, chatId: number): string {
  const hash = crypto.createHash('sha1').update(`${chatType}:${chatId}:${kind}:${cacheKey}`).digest('hex').slice(0, 8);
  return `${kind}-${hash}`;
}

function chatMatches(sub: CsWatchSubscription, chatType: 'group' | 'private', chatId: number): boolean {
  return sub.chatType === chatType && sub.chatId === chatId;
}

function shortProfile(profile: string, maxChars: number = 850): string {
  const text = profile.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function sendWatchMessage(bot: WatchBot, sub: CsWatchSubscription, message: string): Promise<boolean> {
  if (sub.chatType === 'group' && sub.groupId && bot.sendGroupMessage) {
    return bot.sendGroupMessage(sub.groupId, message);
  }
  if (sub.chatType === 'private' && bot.sendPrivateMessage) {
    return bot.sendPrivateMessage(sub.chatId, message);
  }
  return false;
}

async function addSubscription(
  kind: WatchKind,
  subject: string,
  chatType: 'group' | 'private',
  chatId: number,
  groupId: number | undefined,
  userId: number,
): Promise<{ ok: boolean; message: string }> {
  const normalizedSubject = normalizeSubjectForDisplay(subject);
  if (!normalizedSubject) return { ok: false, message: '用法: /watch team Vitality、/watch player donk 或 /watch match NAVI' };
  const cacheKey = getWatchCacheKey(kind, normalizedSubject);
  const store = loadStore();
  const existing = store.subscriptions.find((item) => chatMatches(item, chatType, chatId) && item.kind === kind && item.cacheKey === cacheKey);
  if (existing) {
    return { ok: true, message: `已经订阅过了: ${existing.id} ${kindLabel(existing.kind)} ${existing.subject}` };
  }
  const chatSubs = store.subscriptions.filter((item) => chatMatches(item, chatType, chatId));
  if (chatSubs.length >= MAX_SUBS_PER_CHAT) {
    return { ok: false, message: `这个会话最多订阅 ${MAX_SUBS_PER_CHAT} 个 CS 目标，先 /watch remove <id> 清一下。` };
  }

  const profile = await profileFetcher(kind, normalizedSubject).catch(() => '');
  const now = Date.now();
  const sub: CsWatchSubscription = {
    id: makeId(kind, cacheKey, chatType, chatId),
    kind,
    subject: normalizedSubject,
    cacheKey,
    chatType,
    chatId,
    groupId,
    userId,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: profile ? now : 0,
    lastNotifiedAt: 0,
    lastStartReminderAt: 0,
    lastStartReminderKey: '',
    lastRosterMembers: kind === 'team' && profile ? parseRosterMembers(profile) : [],
    lastRosterChangeAt: 0,
    lastMapStats: kind === 'team' && profile ? parseMapStats(profile) : [],
    lastMapChangeAt: 0,
    lastPlayerStats: kind === 'player' && profile ? parsePlayerStats(profile) : {},
    lastPlayerChangeAt: 0,
    lastDigest: profile ? digestProfile(profile) : '',
    lastError: profile ? '' : '首次快照为空',
  };
  store.subscriptions.push(sub);
  saveStore(store);

  const preview = profile
    ? `\n\n当前快照:\n${shortProfile(profile, 520)}`
    : '\n\n当前没拉到快照，后面定时检查会继续试。';
  return {
    ok: true,
    message: `已订阅 ${sub.id}\n目标: ${kindLabel(kind)} ${normalizedSubject}\n提醒: 数据变化时会发到当前${chatType === 'group' ? '群' : '私聊'}${preview}`,
  };
}

function listSubscriptions(chatType: 'group' | 'private', chatId: number): string {
  const store = loadStore();
  const items = store.subscriptions.filter((item) => chatMatches(item, chatType, chatId));
  if (items.length === 0) return '当前会话还没订阅 CS 目标。\n/watch team Vitality\n/watch player donk';
  return [
    `当前会话 CS 订阅 ${items.length}/${MAX_SUBS_PER_CHAT}`,
    ...items.map((item) => [
      `${item.id} ${kindLabel(item.kind)} ${item.subject}`,
      `上次检查 ${nowText(item.lastCheckedAt)}`,
      item.lastNotifiedAt ? `上次提醒 ${nowText(item.lastNotifiedAt)}` : '未提醒过',
      item.kind === 'match' && item.lastStartReminderAt ? `开赛提醒 ${nowText(item.lastStartReminderAt)}` : '',
      item.kind === 'team' && item.lastRosterChangeAt ? `阵容变化 ${nowText(item.lastRosterChangeAt)}` : '',
      item.kind === 'team' && item.lastMapChangeAt ? `地图变化 ${nowText(item.lastMapChangeAt)}` : '',
      item.kind === 'player' && item.lastPlayerChangeAt ? `选手数据 ${nowText(item.lastPlayerChangeAt)}` : '',
      item.lastError ? `错误 ${item.lastError}` : '',
    ].filter(Boolean).join(' | ')),
  ].join('\n');
}

function prewarmCommandForWatchTarget(kind: WatchKind, subject: string): string {
  if (kind === 'team') return `/cs warm plan team ${subject}`;
  if (kind === 'player') return `/cs warm plan player ${subject}`;
  return '/cs warm plan matches';
}

function buildWatchPlanItem(label: string, cacheKey: string): CsFactTypePlanItem {
  const snapshot = inspectHltvCacheEntry(cacheKey);
  if (!snapshot) {
    return { label, cacheKey, status: 'miss', action: 'refresh' };
  }
  return {
    label,
    cacheKey,
    status: snapshot.status,
    action: snapshot.status === 'fresh' ? 'hit' : 'refresh',
  };
}

function formatPrewarmCachePlanLine(label: string, cacheKey: string, command: string): string {
  const snapshot = inspectHltvCacheEntry(cacheKey);
  if (!snapshot) {
    return `- ${label} [${cacheKey}]: REFRESH | miss，会请求实时源 | ${command}`;
  }
  if (snapshot.status === 'fresh') {
    return [
      `- ${label} [${cacheKey}]: HIT`,
      `fresh ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s hit=${snapshot.hits}`,
      snapshot.source ? `source=${snapshot.source}` : '',
      command,
    ].filter(Boolean).join(' | ');
  }
  return [
    `- ${label} [${cacheKey}]: REFRESH`,
    `stale expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s；只能当旧快照线索`,
    snapshot.source ? `source=${snapshot.source}` : '',
    command,
  ].filter(Boolean).join(' | ');
}

function formatWatchPreflight(chatType: 'group' | 'private', chatId: number): string {
  const store = loadStore();
  const items = store.subscriptions
    .filter((item) => chatMatches(item, chatType, chatId))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  const targetRows: string[] = [];
  const factPlanRows: CsFactTypePlanItem[] = [];
  const seen = new Set<string>();
  const pushTarget = (label: string, cacheKey: string, command: string): void => {
    if (seen.has(cacheKey)) return;
    seen.add(cacheKey);
    targetRows.push(formatPrewarmCachePlanLine(label, cacheKey, command));
    factPlanRows.push(buildWatchPlanItem(label, cacheKey));
  };

  const watchTargets = getCsWatchPrewarmTargets({
    chats: [{ chatType, chatId }],
    maxTargets: MAX_SUBS_PER_CHAT,
  });
  if (watchTargets.some((item) => item.kind === 'match')) {
    pushTarget('watch matches', 'matches', '/cs warm plan matches');
    pushTarget('watch results', 'results', '/cs warm plan results');
  }
  for (const target of watchTargets) {
    if (target.kind !== 'team' && target.kind !== 'player') continue;
    pushTarget(`watch ${kindLabel(target.kind)} ${target.subject}`, target.cacheKey, prewarmCommandForWatchTarget(target.kind, target.subject));
  }

  if (items.length === 0) {
    return [
      `CS订阅预检 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
      '模式: 只读，不拉外站、不写订阅、不发提醒',
      '当前会话: 0/12',
      '订阅: 暂无',
      '',
      '建议:',
      '- 关注队伍变化: /watch team Vitality',
      '- 关注选手状态: /watch player donk',
      '- 关注开赛提醒: /watch match NAVI',
      '边界: /watch now 会真实拉取、写快照并可能发提醒；/watch plan 只做预检。',
    ].join('\n');
  }

  const requestCount = targetRows.filter((line) => line.includes('REFRESH')).length;
  return [
    `CS订阅预检 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    '模式: 只读，不拉外站、不写订阅、不发提醒',
    `当前会话: ${items.length}/${MAX_SUBS_PER_CHAT}`,
    '',
    '订阅状态:',
    ...items.map((item) => [
      `- ${item.id} ${kindLabel(item.kind)} ${item.subject}`,
      `上次检查 ${nowText(item.lastCheckedAt)}`,
      item.lastNotifiedAt ? `上次提醒 ${nowText(item.lastNotifiedAt)}` : '未提醒过',
      item.kind === 'match' && item.lastStartReminderAt ? `开赛提醒 ${nowText(item.lastStartReminderAt)}` : '',
      item.lastError ? `错误 ${item.lastError}` : '',
    ].filter(Boolean).join(' | ')),
    '',
    '预热计划:',
    ...(targetRows.length > 0 ? targetRows : ['- 暂无可预热目标']),
    `统计: 目标${targetRows.length}，预计请求 ${requestCount}`,
    ...buildCsPlanFactTypeCoverageLines(factPlanRows),
    '',
    requestCount > 0
      ? '建议: 管理员先跑上面每行末尾的 /cs warm plan 确认请求数，再用对应 /cs warm 预热；多目标可 /cs warm plan watch 后 /cs warm watch。'
      : '建议: 当前关注目标已有 fresh 缓存，真实提醒仍以 /watch now 或定时任务拉到的新快照为准。',
    '边界: match 订阅依赖 matches/results 缓存，不等于单场 matchid 详情；stale 只能当旧快照线索，miss 不能当没有比赛/没有赛果的实时结论。',
    '执行真实检查: /watch now',
  ].join('\n');
}

function removeSubscription(target: string, chatType: 'group' | 'private', chatId: number): string {
  const store = loadStore();
  const before = store.subscriptions.length;
  if (target === 'all' || target === '全部' || target === '清空') {
    store.subscriptions = store.subscriptions.filter((item) => !chatMatches(item, chatType, chatId));
  } else {
    store.subscriptions = store.subscriptions.filter((item) => !(chatMatches(item, chatType, chatId) && item.id === target));
  }
  const removed = before - store.subscriptions.length;
  if (removed > 0) saveStore(store);
  return removed > 0 ? `已移除 ${removed} 个订阅。` : `没找到订阅 ${target}，先 /watch list 看一下。`;
}

async function checkOne(
  sub: CsWatchSubscription,
  bot: WatchBot,
  notify: boolean,
  now: number,
): Promise<{ checked: boolean; notified: boolean; changed: boolean; startReminder: boolean; rosterChange: boolean; mapChange: boolean; playerChange: boolean; error: string }> {
  try {
    const profile = await profileFetcher(sub.kind, sub.subject);
    sub.lastCheckedAt = now;
    sub.updatedAt = now;
    if (!profile) {
      sub.lastError = 'profile empty';
      return { checked: true, notified: false, changed: false, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    const digest = digestProfile(profile);
    const changed = Boolean(sub.lastDigest && digest !== sub.lastDigest);
    sub.lastDigest = digest;
    sub.lastError = '';
    const currentRoster = sub.kind === 'team' ? parseRosterMembers(profile) : [];
    const rosterDiff = sub.kind === 'team' && sub.lastRosterMembers.length > 0 && currentRoster.length > 0
      ? compareRosterMembers(sub.lastRosterMembers, currentRoster)
      : { added: [], removed: [] };
    const rosterChanged = rosterDiff.added.length > 0 || rosterDiff.removed.length > 0;
    if (sub.kind === 'team' && currentRoster.length > 0) {
      sub.lastRosterMembers = currentRoster;
    }
    const currentMapStats = sub.kind === 'team' ? parseMapStats(profile) : [];
    const mapChanges = sub.kind === 'team' && sub.lastMapStats.length > 0 && currentMapStats.length > 0
      ? compareMapStats(sub.lastMapStats, currentMapStats)
      : [];
    if (sub.kind === 'team' && currentMapStats.length > 0) {
      sub.lastMapStats = currentMapStats;
    }
    if (rosterChanged && notify) {
      const sent = await sendWatchMessage(bot, sub, formatRosterChangeMessage(sub, rosterDiff, profile));
      if (sent) {
        sub.lastRosterChangeAt = now;
        sub.lastNotifiedAt = now;
        return { checked: true, notified: true, changed, startReminder: false, rosterChange: true, mapChange: false, playerChange: false, error: '' };
      }
      sub.lastError = 'send failed';
      return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    if (mapChanges.length > 0 && notify) {
      const sent = await sendWatchMessage(bot, sub, formatMapChangeMessage(sub, mapChanges, profile));
      if (sent) {
        sub.lastMapChangeAt = now;
        sub.lastNotifiedAt = now;
        return { checked: true, notified: true, changed, startReminder: false, rosterChange: false, mapChange: true, playerChange: false, error: '' };
      }
      sub.lastError = 'send failed';
      return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    const currentPlayerStats = sub.kind === 'player' ? parsePlayerStats(profile) : {};
    const playerChanges = sub.kind === 'player' && hasPlayerStats(sub.lastPlayerStats) && hasPlayerStats(currentPlayerStats)
      ? comparePlayerStats(sub.lastPlayerStats, currentPlayerStats)
      : [];
    if (sub.kind === 'player' && hasPlayerStats(currentPlayerStats)) {
      sub.lastPlayerStats = currentPlayerStats;
    }
    if (playerChanges.length > 0 && notify) {
      const sent = await sendWatchMessage(bot, sub, formatPlayerStatChangeMessage(sub, playerChanges, profile));
      if (sent) {
        sub.lastPlayerChangeAt = now;
        sub.lastNotifiedAt = now;
        return { checked: true, notified: true, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: true, error: '' };
      }
      sub.lastError = 'send failed';
      return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    const startReminder = findUpcomingStartReminder(sub, profile, now);
    if (startReminder && startReminder.key !== sub.lastStartReminderKey && notify) {
      const sent = await sendWatchMessage(bot, sub, formatStartReminderMessage(sub, startReminder, profile));
      if (sent) {
        sub.lastStartReminderAt = now;
        sub.lastStartReminderKey = startReminder.key;
        sub.lastNotifiedAt = now;
        return { checked: true, notified: true, changed, startReminder: true, rosterChange: false, mapChange: false, playerChange: false, error: '' };
      }
      sub.lastError = 'send failed';
      return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    if (changed && notify) {
      const message = [
        `CS订阅提醒 | ${kindLabel(sub.kind)} ${sub.subject}`,
        shortProfile(profile, 900),
        '机器短评：数据有变，先看来源时间和链接，别拿旧印象硬说。',
      ].join('\n\n');
      const sent = await sendWatchMessage(bot, sub, message);
      if (sent) {
        sub.lastNotifiedAt = now;
        return { checked: true, notified: true, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: '' };
      }
      sub.lastError = 'send failed';
      return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
    }
    return { checked: true, notified: false, changed, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: '' };
  } catch (err) {
    sub.lastCheckedAt = now;
    sub.updatedAt = now;
    sub.lastError = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    return { checked: true, notified: false, changed: false, startReminder: false, rosterChange: false, mapChange: false, playerChange: false, error: sub.lastError };
  }
}

export async function runCsWatchChecks(
  bot: WatchBot,
  options: { chatType?: 'group' | 'private'; chatId?: number; notify?: boolean; now?: number } = {},
): Promise<{ checked: number; changed: number; notified: number; startReminders: number; rosterChanges: number; mapChanges: number; playerChanges: number; errors: number }> {
  if (watchRunning) return { checked: 0, changed: 0, notified: 0, startReminders: 0, rosterChanges: 0, mapChanges: 0, playerChanges: 0, errors: 0 };
  watchRunning = true;
  lastRunAt = Date.now();
  lastRunError = '';
  const now = options.now || Date.now();
  try {
    const store = loadStore();
    const targets = store.subscriptions.filter((item) => {
      if (options.chatType && options.chatId) return chatMatches(item, options.chatType, options.chatId);
      return true;
    });
    let checked = 0;
    let changed = 0;
    let notified = 0;
    let startReminders = 0;
    let rosterChanges = 0;
    let mapChanges = 0;
    let playerChanges = 0;
    let errors = 0;
    for (const sub of targets) {
      const result = await checkOne(sub, bot, options.notify !== false, now);
      if (result.checked) checked++;
      if (result.changed) changed++;
      if (result.notified) notified++;
      if (result.startReminder) startReminders++;
      if (result.rosterChange) rosterChanges++;
      if (result.mapChange) mapChanges++;
      if (result.playerChange) playerChanges++;
      if (result.error) errors++;
    }
    saveStore(store);
    lastRunChecked = checked;
    lastRunNotifications = notified;
    lastRunStartReminders = startReminders;
    lastRunRosterChanges = rosterChanges;
    lastRunMapChanges = mapChanges;
    lastRunPlayerChanges = playerChanges;
    return { checked, changed, notified, startReminders, rosterChanges, mapChanges, playerChanges, errors };
  } catch (err) {
    lastRunError = err instanceof Error ? err.message : String(err);
  return { checked: 0, changed: 0, notified: 0, startReminders: 0, rosterChanges: 0, mapChanges: 0, playerChanges: 0, errors: 1 };
  } finally {
    watchRunning = false;
  }
}

export async function buildCsWatchDigestForChat(
  chatType: 'group' | 'private',
  chatId: number,
  options: { maxItems?: number; maxChars?: number; timeoutMs?: number } = {},
): Promise<string> {
  const store = loadStore();
  const allItems = store.subscriptions.filter((item) => chatMatches(item, chatType, chatId));
  if (allItems.length === 0) return '';

  const maxItems = Math.max(1, options.maxItems || 3);
  const maxChars = Math.max(300, options.maxChars || 1200);
  const timeoutMs = Math.max(1000, options.timeoutMs || 4500);
  const items = allItems.slice(0, maxItems);
  const lines = [`【本会话关注目标】${items.length}/${allItems.length}`];

  for (const sub of items) {
    const label = `${kindLabel(sub.kind)} ${sub.subject}`;
    try {
      const profile = await withTimeout(profileFetcher(sub.kind, sub.subject).catch(() => ''), timeoutMs, '');
      if (!profile) {
        lines.push(`- ${label}: 暂无准信${sub.lastError ? `；最近错误 ${sub.lastError}` : ''}`);
        continue;
      }
      const digest = digestProfile(profile);
      const state = !sub.lastDigest
        ? '首次快照'
        : digest !== sub.lastDigest
          ? '较上次快照有变化'
          : '较上次快照暂无变化';
      lines.push([
        `- ${label}: ${state}`,
        shortProfile(profile, Math.max(220, Math.floor(maxChars / Math.max(1, items.length)))),
      ].join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      lines.push(`- ${label}: 拉取失败 ${message}`);
    }
  }

  if (allItems.length > items.length) {
    lines.push(`还有 ${allItems.length - items.length} 个关注目标未展开，/watch list 查看。`);
  }
  lines.push('说明：这是日报附带快照，不更新订阅状态；变化提醒仍走 /watch。');
  const text = lines.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function getCsWatchPreferencesForChat(
  chatType: 'group' | 'private',
  chatId: number,
): { kind: WatchKind; subject: string; id: string; createdAt: number; updatedAt: number }[] {
  return loadStore()
    .subscriptions
    .filter((item) => chatMatches(item, chatType, chatId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt)
    .map((item) => ({
      kind: item.kind,
      subject: item.subject,
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
}

export function getCsWatchPrewarmTargets(options: {
  chats?: Array<{ chatType: 'group' | 'private'; chatId: number }>;
  maxTargets?: number;
} = {}): { kind: WatchKind; subject: string; cacheKey: string; updatedAt: number }[] {
  const chatKeys = new Set((options.chats || []).map((chat) => `${chat.chatType}:${chat.chatId}`));
  const maxTargets = Math.max(1, options.maxTargets || 8);
  const seen = new Set<string>();
  return loadStore()
    .subscriptions
    .filter((item) => chatKeys.size === 0 || chatKeys.has(`${item.chatType}:${item.chatId}`))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .map((item) => ({
      kind: item.kind,
      subject: item.subject,
      cacheKey: item.cacheKey,
      updatedAt: item.updatedAt,
    }))
    .filter((item) => {
      const key = `${item.kind}:${item.cacheKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxTargets);
}

function formatWatchStats(): string {
  const store = loadStore();
  const groupChats = new Set(store.subscriptions.filter((item) => item.chatType === 'group').map((item) => item.chatId)).size;
  const privateChats = new Set(store.subscriptions.filter((item) => item.chatType === 'private').map((item) => item.chatId)).size;
  return [
    'CS订阅状态',
    `订阅: ${store.subscriptions.length} 个 群${groupChats} 私聊${privateChats}`,
    `定时器: ${watchTimer ? 'on' : 'off'} running=${watchRunning}`,
    `最近运行: ${nowText(lastRunAt)} 检查${lastRunChecked} 提醒${lastRunNotifications} 开赛${lastRunStartReminders} 阵容${lastRunRosterChanges} 地图${lastRunMapChanges} 选手${lastRunPlayerChanges}`,
    lastRunError ? `最近错误: ${lastRunError}` : '',
  ].filter(Boolean).join('\n');
}

export function getCsWatchStats(): {
  subscriptions: number;
  groupChats: number;
  privateChats: number;
  running: boolean;
  timerEnabled: boolean;
  lastRunAt: number;
  lastRunChecked: number;
  lastRunNotifications: number;
  lastRunStartReminders: number;
  lastRunRosterChanges: number;
  lastRunMapChanges: number;
  lastRunPlayerChanges: number;
  lastRunError: string;
} {
  const store = loadStore();
  return {
    subscriptions: store.subscriptions.length,
    groupChats: new Set(store.subscriptions.filter((item) => item.chatType === 'group').map((item) => item.chatId)).size,
    privateChats: new Set(store.subscriptions.filter((item) => item.chatType === 'private').map((item) => item.chatId)).size,
    running: watchRunning,
    timerEnabled: !!watchTimer,
    lastRunAt,
    lastRunChecked,
    lastRunNotifications,
    lastRunStartReminders,
    lastRunRosterChanges,
    lastRunMapChanges,
    lastRunPlayerChanges,
    lastRunError,
  };
}

export function startCsWatchTasks(bot: WatchBot, intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  shutdownCsWatchTasks();
  const intervalMs = Math.max(10, intervalMinutes) * 60 * 1000;
  watchTimer = setInterval(() => {
    void runCsWatchChecks(bot, { notify: true });
  }, intervalMs);
  watchTimer.unref();
}

export function shutdownCsWatchTasks(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

export const csWatchPlugin: Plugin = {
  name: 'cs-watch',
  description: 'CS 队伍/选手/赛程订阅提醒',
  handler: async (ctx) => {
    if (ctx.command !== 'watch' && ctx.command !== 'cswatch' && ctx.command !== '订阅') {
      const natural = !ctx.command ? parseNaturalWatch(ctx.rawText) : null;
      if (!natural) return false;
      const result = await addSubscription(natural.kind, natural.subject, ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id);
      ctx.reply(result.message);
      return true;
    }
    const sub = (ctx.args[0] || 'list').toLowerCase();

    if (sub === 'list' || sub === 'ls' || sub === '列表') {
      ctx.reply(listSubscriptions(ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'status' || sub === '状态') {
      ctx.reply(formatWatchStats());
      return true;
    }

    if (sub === 'plan' || sub === 'preview' || sub === 'dry-run' || sub === '预检' || sub === '计划') {
      ctx.reply(formatWatchPreflight(ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'del' || sub === '取消') {
      const target = ctx.args[1] || '';
      if (!target) {
        ctx.reply('用法: /watch remove <id|all>');
        return true;
      }
      ctx.reply(removeSubscription(target, ctx.chatType, ctx.chatId));
      return true;
    }

    if (sub === 'run' || sub === 'check' || sub === 'now' || sub === '检查') {
      const result = await runCsWatchChecks(ctx.bot, { chatType: ctx.chatType, chatId: ctx.chatId, notify: true });
      ctx.reply(`CS订阅检查完成: 检查${result.checked} 变化${result.changed} 提醒${result.notified} 开赛${result.startReminders} 阵容${result.rosterChanges} 地图${result.mapChanges} 选手${result.playerChanges} 错误${result.errors}`);
      return true;
    }

    const kind = parseKind(sub);
    if (kind) {
      const subject = ctx.args.slice(1).join(' ').trim();
      const result = await addSubscription(kind, subject, ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id);
      ctx.reply(result.message);
      return true;
    }

    ctx.reply([
      'CS订阅用法:',
      '/watch team Vitality - 订阅队伍排名/阵容/地图样本变化',
      '/watch player donk - 订阅选手统计变化',
      '/watch match NAVI - 订阅队伍赛程/赛果变化',
      '/watch list - 当前会话订阅',
      '/watch plan - 只读预检订阅、预热目标、计划事实类型覆盖和旧数据边界',
      '/watch now - 立即检查当前会话',
      '/watch remove <id|all> - 移除订阅',
    ].join('\n'));
    return true;
  },
};

export const __test = {
  __setStorePathForTests(filepath?: string): void {
    storePathOverride = filepath || '';
  },
  __setProfileFetcherForTests(fetcher?: ProfileFetcher): void {
    profileFetcher = fetcher || fetchWatchSnapshot;
  },
  digestProfile,
  parseNaturalWatch,
  loadStore,
  runCsWatchChecks,
  buildCsWatchDigestForChat,
  resetForTests(): void {
    shutdownCsWatchTasks();
    storePathOverride = '';
    profileFetcher = fetchWatchSnapshot;
    watchRunning = false;
    lastRunAt = 0;
    lastRunError = '';
    lastRunChecked = 0;
    lastRunNotifications = 0;
    lastRunStartReminders = 0;
    lastRunRosterChanges = 0;
    lastRunMapChanges = 0;
    lastRunPlayerChanges = 0;
  },
};
