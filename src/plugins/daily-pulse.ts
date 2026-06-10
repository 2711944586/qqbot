import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Plugin } from '../types';
import { getMediaObservabilitySnapshot } from './ai-chat';
import { getUserProfile } from './user-profile';

type DailyPulseChatType = 'group' | 'private';

interface DailyPulseSubscription {
  id: string;
  chatType: DailyPulseChatType;
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

interface DailyPulseCheckin {
  id: string;
  chatType: DailyPulseChatType;
  chatId: number;
  userId: number;
  createdAt: number;
  updatedAt: number;
  lastCheckinDate: string;
  lastCheckinAt: number;
  streak: number;
  bestStreak: number;
  total: number;
  dates: string[];
}

interface DailyPulseChallengeCompletion {
  id: string;
  chatType: DailyPulseChatType;
  chatId: number;
  userId: number;
  createdAt: number;
  updatedAt: number;
  lastDoneDate: string;
  lastDoneAt: number;
  streak: number;
  bestStreak: number;
  total: number;
  dates: string[];
}

interface DailyPulseStore {
  version: 1;
  subscriptions: DailyPulseSubscription[];
  checkins: DailyPulseCheckin[];
  challengeCompletions: DailyPulseChallengeCompletion[];
}

interface DailyPulseBot {
  sendGroupMessage?: (groupId: number, message: string) => Promise<boolean>;
  sendPrivateMessage?: (userId: number, message: string) => Promise<boolean>;
  getConfig?: () => { admin_qq?: number[] };
}

const DEFAULT_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'daily-pulse.json');
const DEFAULT_PULSE_TIME = '09:00';
const DEFAULT_CHECK_INTERVAL_SECONDS = 60;
const PULSE_TIMEZONE: DailyPulseSubscription['timezone'] = 'Asia/Shanghai';

let storePathOverride = '';
let pulseTimer: NodeJS.Timeout | null = null;
let pulseRunning = false;
let lastRunAt = 0;
let lastRunChecked = 0;
let lastRunSent = 0;
let lastRunError = '';

function storePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

function emptyStore(): DailyPulseStore {
  return { version: 1, subscriptions: [], checkins: [], challengeCompletions: [] };
}

function subscriptionId(chatType: DailyPulseChatType, chatId: number): string {
  return `${chatType}_${chatId}`;
}

function checkinId(chatType: DailyPulseChatType, chatId: number, userId: number): string {
  return `${chatType}_${chatId}_${userId}`;
}

function challengeCompletionId(chatType: DailyPulseChatType, chatId: number, userId: number): string {
  return `${chatType}_${chatId}_${userId}`;
}

function normalizePulseTime(input?: string): string | null {
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

function loadStore(): DailyPulseStore {
  const filepath = storePath();
  if (!fs.existsSync(filepath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const subscriptions = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    const checkins = Array.isArray(parsed?.checkins) ? parsed.checkins : [];
    const challengeCompletions = Array.isArray(parsed?.challengeCompletions) ? parsed.challengeCompletions : [];
    return {
      version: 1,
      subscriptions: subscriptions
        .filter((item: Partial<DailyPulseSubscription>) => item && item.id && item.chatId && item.time)
        .map((item: DailyPulseSubscription) => ({
          ...item,
          chatType: item.chatType === 'private' ? 'private' : 'group',
          time: normalizePulseTime(item.time) || DEFAULT_PULSE_TIME,
          timezone: PULSE_TIMEZONE,
          enabled: item.enabled !== false,
          lastSentDate: String(item.lastSentDate || ''),
          lastSentAt: Number(item.lastSentAt || 0),
          lastError: String(item.lastError || ''),
        })),
      checkins: checkins
        .filter((item: Partial<DailyPulseCheckin>) => item && item.id && item.chatId && item.userId)
        .map((item: DailyPulseCheckin) => ({
          id: String(item.id),
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          userId: Number(item.userId),
          createdAt: Number(item.createdAt || Date.now()),
          updatedAt: Number(item.updatedAt || 0),
          lastCheckinDate: String(item.lastCheckinDate || ''),
          lastCheckinAt: Number(item.lastCheckinAt || 0),
          streak: Math.max(0, Number(item.streak || 0)),
          bestStreak: Math.max(0, Number(item.bestStreak || item.streak || 0)),
          total: Math.max(0, Number(item.total || 0)),
          dates: normalizeDateHistory(item.dates, String(item.lastCheckinDate || ''), Number(item.streak || 0)),
        })),
      challengeCompletions: challengeCompletions
        .filter((item: Partial<DailyPulseChallengeCompletion>) => item && item.id && item.chatId && item.userId)
        .map((item: DailyPulseChallengeCompletion) => ({
          id: String(item.id),
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          userId: Number(item.userId),
          createdAt: Number(item.createdAt || Date.now()),
          updatedAt: Number(item.updatedAt || 0),
          lastDoneDate: String(item.lastDoneDate || ''),
          lastDoneAt: Number(item.lastDoneAt || 0),
          streak: Math.max(0, Number(item.streak || 0)),
          bestStreak: Math.max(0, Number(item.bestStreak || item.streak || 0)),
          total: Math.max(0, Number(item.total || 0)),
          dates: normalizeDateHistory(item.dates, String(item.lastDoneDate || ''), Number(item.streak || 0)),
        })),
    };
  } catch (err) {
    lastRunError = err instanceof Error ? err.message : String(err);
    return emptyStore();
  }
}

function saveStore(store: DailyPulseStore): void {
  const filepath = storePath();
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

function formatShanghaiParts(date: Date): { dateKey: string; timeKey: string; label: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PULSE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value || '';
  const weekdayMap: Record<string, string> = {
    Sun: '周日',
    Mon: '周一',
    Tue: '周二',
    Wed: '周三',
    Thu: '周四',
    Fri: '周五',
    Sat: '周六',
  };
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    dateKey,
    timeKey: `${get('hour')}:${get('minute')}`,
    label: `${get('year')}年${Number(get('month'))}月${Number(get('day'))}日 ${weekdayMap[get('weekday')] || get('weekday')}`,
  };
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map((item) => Number(item));
  return hour * 60 + minute;
}

function isDue(sub: DailyPulseSubscription, date: Date): boolean {
  if (!sub.enabled) return false;
  const now = formatShanghaiParts(date);
  if (sub.lastSentDate === now.dateKey) return false;
  return timeToMinutes(now.timeKey) >= timeToMinutes(sub.time);
}

function hashNumber(seed: string): number {
  return crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
}

function pick(items: string[], seed: string): string {
  return items[hashNumber(seed) % items.length];
}

function score(seed: string): number {
  return 40 + (hashNumber(seed) % 61);
}

function previousShanghaiDateKey(date: Date): string {
  return formatShanghaiParts(new Date(date.getTime() - 24 * 60 * 60 * 1000)).dateKey;
}

function shanghaiDateFromKey(dateKey: string): Date | null {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

function shanghaiDateKeyOffset(date: Date, offsetDays: number): string {
  return formatShanghaiParts(new Date(date.getTime() + offsetDays * 24 * 60 * 60 * 1000)).dateKey;
}

function deriveStreakDates(lastDateKey: string, streak: number, maxDays = 30): string[] {
  const end = shanghaiDateFromKey(lastDateKey);
  if (!end || streak <= 0) return [];
  const count = Math.max(0, Math.min(Math.floor(streak), maxDays));
  return Array.from({ length: count }, (_item, index) => shanghaiDateKeyOffset(end, index - count + 1));
}

function normalizeDateHistory(dates: unknown, lastDateKey: string, streak: number): string[] {
  const items = Array.isArray(dates)
    ? dates.map((item) => String(item)).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item))
    : [];
  const fallback = items.length > 0 ? items : deriveStreakDates(lastDateKey, streak);
  return [...new Set(fallback)].sort().slice(-90);
}

function formatCheckinLine(item: DailyPulseCheckin, index: number, today: string): string {
  const todayMark = item.lastCheckinDate === today ? ' 今日已到' : ` 最近${item.lastCheckinDate || '无'}`;
  return `${index}. QQ${item.userId} 连续${item.streak}天 / 最佳${item.bestStreak}天 / 累计${item.total}次 /${todayMark}`;
}

function formatChallengeCompletionLine(item: DailyPulseChallengeCompletion, index: number, today: string): string {
  const todayMark = item.lastDoneDate === today ? ' 今日已完成' : ` 最近${item.lastDoneDate || '无'}`;
  return `${index}. QQ${item.userId} 连续${item.streak}天 / 最佳${item.bestStreak}天 / 累计${item.total}次 /${todayMark}`;
}

function formatMediaRecapClosingStatus(): string {
  try {
    const media = getMediaObservabilitySnapshot();
    return `识图语音收尾: 今日实跑 ${media.todayRuns}；${media.hint}；边界: 只有真实 /vision test、/voice stt、/voice test trace 才算看过/听过/发过。`;
  } catch {
    return '识图语音收尾: /media daily 看今日三件套；只有 /vision test、/voice stt、/voice test 成功才算。';
  }
}

function formatMediaDailyShortStatus(): string {
  try {
    const media = getMediaObservabilitySnapshot();
    return `今日实跑 ${media.todayRuns}；陪跑 /daily media；完整状态 /media daily`;
  } catch {
    return '陪跑 /daily media；完整状态 /media daily；真实跑通看 /vision test、/voice stt、/voice test';
  }
}

function formatPostCompletionMediaStep(seed: string): string {
  const prompt = pick([
    '发图问“帮我看图”，先看可见信息再下判断',
    '用 /voice stt 真测一条语音，别把缓存 hit 当听过',
    '用 /voice check 先预检短句，再 /voice test 真发一条',
    '跑 /media daily 看今天三件套，缺哪条补哪条',
  ], `${seed}:media-step`);
  return `识图语音下一步: /daily media 取今天陪跑卡；${prompt}。`;
}

interface DailyMediaRunCount {
  label: string;
  passed: number;
  attempts: number;
  action: string;
}

function parseDailyMediaRunCounts(todayRuns: string): DailyMediaRunCount[] {
  const actions: Record<string, string> = {
    识图: '/vision test <图片URL>',
    听写: '/voice stt <语音URL>',
    发语音: '/voice test 今天语音链路短测一下',
  };
  const rows: DailyMediaRunCount[] = [];
  const pattern = /(识图|听写|发语音)(\d+)\/(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(todayRuns || '')) !== null) {
    const label = match[1];
    rows.push({
      label,
      passed: Math.max(0, Number(match[2] || 0)),
      attempts: Math.max(0, Number(match[3] || 0)),
      action: actions[label] || '/media daily',
    });
  }
  return rows.length > 0
    ? rows
    : [
      { label: '识图', passed: 0, attempts: 0, action: actions.识图 },
      { label: '听写', passed: 0, attempts: 0, action: actions.听写 },
      { label: '发语音', passed: 0, attempts: 0, action: actions.发语音 },
    ];
}

export function buildDailyPulseMessage(
  chatType: DailyPulseChatType,
  chatId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const seed = `${parts.dateKey}:${chatType}:${chatId}`;
  const handScore = score(`${seed}:hand`);
  const mood = pick([
    '准星在线，但别第一身位白给',
    '适合慢一点控图，别上来就全甲全弹送出去',
    '今天脑子要比枪硬，先补枪再嘴硬',
    '能打，但别开局就把暂停用在嘴上',
    '状态不差，主要看道具和纪律',
    '今天适合稳住经济，别两把把自己打进纯E',
  ], `${seed}:mood`);
  const focus = pick([
    '先看 /csreport focus，有比赛就挑重点看',
    '来个 /csquiz 热手，答错也别急，至少知道自己哪块云',
    '/cstrain 给自己排一组，练完记 /cstrain log',
    '发图直接问“帮我看图”，我会先说看见什么再短评',
    '语音能听写，听不清我会说听不清，不硬装听懂',
    '有新阵容/排名问题先 /cs verify，别拿旧印象当圣旨',
  ], `${seed}:focus`);
  const task = pick([
    '今天小任务：打一局之前先想清楚默认怎么拿信息',
    '今天小任务：每次死前问一句，我是不是没等补枪',
    '今天小任务：至少复盘一个道具 timing，别只看击杀数',
    '今天小任务：优势局别急着找镜头，先把人数优势兑现',
    '今天小任务：输手枪局别乱起，经济别自己把自己玩崩',
    '今天小任务：看比赛时盯一个回合的道具交换，比只看枪法有用',
  ], `${seed}:task`);
  const opener = pick([
    '醒了就动一动，别在被窝里研究战术了。',
    '今天先把脑子开机，枪可以慢点热。',
    '到点了，群里先别装死。',
    '每日状态牌来了，别嫌我啰嗦。',
    '今天也别硬编，能查就查，能练就练。',
  ], `${seed}:opener`);
  const mediaStatus = formatMediaDailyShortStatus();

  return [
    `玩机器每日提醒 | ${parts.label}`,
    opener,
    `今日手感: ${handScore}/100，${mood}`,
    `今日先手: ${focus}`,
    `今日小任务: ${task}`,
    `识图语音: ${mediaStatus}`,
    '好玩入口: 今日CS / 今日偏好 / 今日证据 / 今日人话 / 今日闭环分 / 今日指挥台 / 今日队形 / 今日聊天节奏 / 今日接力 / 今日话题 / 今日语音台词 / 今日安排 / 保连续 / 识图语音陪跑 / 催我一下 / /daily personal / /daily proof / /daily reply / /daily score / /daily center / /daily vibe / /daily relay / /daily line / /daily gap / /daily squad / /daily ice / /daily script / /daily plan / /daily guard / /daily media / /daily nudge / /daily challenge / /csquiz / /cstrain / /media daily / 发图说帮我看图 / /voice status',
    '边界: 这是固定日签和群聊提醒，不是实时赛事事实；比赛、排名、阵容看 /cs brief、/csreport focus 或 /cs verify。',
  ].join('\n');
}

export function buildDailyRecapMessage(
  chatType: DailyPulseChatType,
  chatId: number,
  date: Date = new Date(),
  userId?: number,
): string {
  const parts = formatShanghaiParts(date);
  const seed = `${parts.dateKey}:${chatType}:${chatId}:recap`;
  const disciplineScore = score(`${seed}:discipline`);
  const store = userId ? loadStore() : null;
  const checkin = store && userId
    ? store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId)
    : null;
  const challenge = store && userId
    ? store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId)
    : null;
  const checkedToday = !!checkin && checkin.lastCheckinDate === parts.dateKey;
  const challengedToday = !!challenge && challenge.lastDoneDate === parts.dateKey;
  const closingStatus = userId
    ? `今日收尾状态: QQ${userId} 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}${challengedToday && checkedToday ? '，今天不欠账。' : '，缺项可用 /daily nudge 看现在补什么。'}`
    : '';
  const mediaClosingStatus = formatMediaRecapClosingStatus();
  const opener = pick([
    '收工前别急着装没打过，今天这把账还是要算一下。',
    '晚上别只喊累，复盘两眼比硬排三把有用。',
    '今天打完先别嘴硬，哪怕只记一个死亡回合也行。',
    '睡前收个尾，别让今天的白给明天原样复刻。',
    '到点了，少刷一会儿，脑子留两分钟给复盘。',
  ], `${seed}:opener`);
  const reviewPoint = pick([
    '复盘点：今天有没有死在没等补枪、没清点、没看小地图这三件事上。',
    '复盘点：挑一个最亏回合，只看经济、道具、站位，别只甩锅枪法。',
    '复盘点：如果今天输了优势局，先找第一个乱起节奏的人，不一定是最后死的那个。',
    '复盘点：看一张截图或一段语音都行，信息先讲清楚，再谈谁背锅。',
    '复盘点：今天问过的阵容、排名、赛果，没 fresh 证据的别当真结论留脑子里。',
  ], `${seed}:review`);
  const tomorrowHook = pick([
    '明天先手：起床看 /daily，开打前来一组 /cstrain。',
    '明天先手：有图就发图问我，别靠一句“这波怎么说”让我猜全场。',
    '明天先手：看比赛先 /csreport focus，别拿旧印象聊新阵容。',
    '明天先手：先做 /csquiz 热身，错了也比云着强。',
    '明天先手：语音说不清就直接发 /voice stt 测一下链路。',
  ], `${seed}:tomorrow`);
  const smallTask = pick([
    '睡前小任务：把今天最离谱的一回合用一句话记下来，格式就写“地图 + 死因 + 下次动作”。',
    '睡前小任务：如果练了枪，补一条 /cstrain log，别让训练记录断档。',
    '睡前小任务：把一个没查证的 CS 结论删掉，明天用 /cs verify 补证。',
    '睡前小任务：找一张截图让我看图，确认是不是自己想多了。',
    '睡前小任务：挑一句想让我语音念的短句，先 /voice check 看能不能稳发。',
  ], `${seed}:task`);

  return [
    `玩机器晚间复盘 | ${parts.label}`,
    opener,
    `今日纪律: ${disciplineScore}/100，${disciplineScore >= 75 ? '能睡，但别膨胀' : disciplineScore >= 55 ? '还行，明天少犯同一种错' : '有点危险，明天先别嘴硬'}`,
    closingStatus,
    mediaClosingStatus,
    reviewPoint,
    tomorrowHook,
    smallTask,
    '入口: /cstrain log <分钟> <地图> <武器> <备注> / /cstrain stats / /trace last / /vision last / /voice last',
    '边界: 这是复盘提醒和训练建议，不读取你的 demo/截图/语音；要我真看图或听语音，直接发附件并明确问。',
  ].filter(Boolean).join('\n');
}

export function buildDailyChallengeMessage(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const seed = `${parts.dateKey}:${chatType}:${chatId}:${userId}:challenge`;
  const difficulty = score(`${seed}:difficulty`);
  const lane = pick([
    '补枪纪律',
    '道具复盘',
    '截图识图',
    '语音链路',
    'CS小考',
    '经济管理',
    '冷静指挥',
  ], `${seed}:lane`);
  const challenge = pick([
    '打一局前先说清楚默认站位，死了别只喊“我的”。',
    '找一张对局截图问“帮我看图”，先确认可见信息再下结论。',
    '用 /voice check 预检一句短语音，确认别超长、别装现实本人声音。',
    '来一题 /csquiz，答错也得看解析，别云着嘴硬。',
    '练 15 分钟急停或预瞄，结束补一条 /cstrain log。',
    '问一个实时阵容/排名前先 /cs verify，旧印象今天不算证据。',
    '复盘一个死亡回合，只写“地图 + 死因 + 下次动作”。',
  ], `${seed}:challenge`);
  const steps = pick([
    '先做一小步；中途别加戏；做完回来打卡。',
    '先确认事实；再说判断；最后留一句下次动作。',
    '先短测链路；再正式发；失败就看 status/recent。',
    '先别求难度，今天只求别犯同一种错两次。',
  ], `${seed}:steps`);
  const reward = pick([
    '奖励: 做完可以来一句“挑战完成”，别让连续断了。',
    '奖励: 做完先 /daily done，再看 /daily board，榜上有名比嘴硬管用。',
    '奖励: 做完记 /daily done，晚上用 /daily recap 收尾。',
    '奖励: 做完记完成，再看 /media daily，确认识图语音链路别掉线。',
  ], `${seed}:reward`);

  return [
    `玩机器今日挑战 | ${parts.label}`,
    `签位: ${lane} / 难度 ${difficulty}/100，${difficulty >= 75 ? '有点硬，但能练出来' : difficulty >= 55 ? '刚好，别偷懒' : '轻量热身，先把手动起来'}`,
    `挑战: ${challenge}`,
    `三步: ${steps}`,
    reward,
    '入口: /daily done / /daily checkin / /daily board / /daily recap / /cstrain log <分钟> <地图> <武器> <备注>',
    '边界: 这是本地每日挑战和训练提醒，不读取 demo、截图或语音；要真看图/听语音，直接发附件并明确问。',
  ].join('\n');
}

export function recordDailyChallengeDone(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const yesterday = previousShanghaiDateKey(date);
  const store = loadStore();
  const id = challengeCompletionId(chatType, chatId, userId);
  const now = Date.now();
  let item = store.challengeCompletions.find((entry) => entry.id === id);
  const seed = `${today}:${chatType}:${chatId}:${userId}:done`;

  if (!item) {
    item = {
      id,
      chatType,
      chatId,
      userId,
      createdAt: now,
      updatedAt: now,
      lastDoneDate: '',
      lastDoneAt: 0,
      streak: 0,
      bestStreak: 0,
      total: 0,
      dates: [],
    };
    store.challengeCompletions.push(item);
  }

  const repeated = item.lastDoneDate === today;
  if (!repeated) {
    item.streak = item.lastDoneDate === yesterday ? item.streak + 1 : 1;
    item.bestStreak = Math.max(item.bestStreak || 0, item.streak);
    item.total += 1;
    item.lastDoneDate = today;
    item.lastDoneAt = now;
    item.dates = [...new Set([...(item.dates || []), today])].sort().slice(-90);
  }
  item.chatType = chatType;
  item.chatId = chatId;
  item.userId = userId;
  item.updatedAt = now;
  saveStore(store);

  const opener = repeated
    ? pick([
      '今天挑战完成已经记过了，别刷第二遍，我眼睛还在。',
      '今天这项已经算完成，重复报备不加经验。',
      '记录没丢，今天挑战已经打勾了。',
      '同一天只能算一次，省点力气留给明天。',
    ], `${seed}:repeat`)
    : pick([
      '行，今天这项算你真做了。',
      '挑战完成，给你记上了，别光嘴上完成。',
      '收到，今天这个小任务算落地。',
      '可以，这比只喊“我明天练”强一点。',
    ], `${seed}:opener`);
  const next = pick([
    '顺手来一句“今日打卡”，把出勤也续上。',
    '晚上用 /daily recap 收个尾，别让经验散了。',
    '看一眼 /daily challenge board，连续这东西断了挺亏。',
    '明天再来 /daily challenge，别只热闹一天。',
  ], `${seed}:next`);

  return [
    repeated ? '今日挑战完成 | 今天已经记过' : '今日挑战完成 | 成功',
    opener,
    `挑战连续: ${item.streak}天 / 最佳: ${item.bestStreak}天 / 累计: ${item.total}次`,
    next,
    formatPostCompletionMediaStep(seed),
    '入口: /daily challenge 看今日挑战；/daily challenge board 看挑战榜；/daily checkin 记每日打卡；/daily media 识图语音陪跑；/daily recap 晚间复盘。',
  ].join('\n');
}

export function recordDailyCheckin(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const yesterday = previousShanghaiDateKey(date);
  const store = loadStore();
  const id = checkinId(chatType, chatId, userId);
  const now = Date.now();
  let item = store.checkins.find((entry) => entry.id === id);
  const seed = `${today}:${chatType}:${chatId}:${userId}:checkin`;

  if (!item) {
    item = {
      id,
      chatType,
      chatId,
      userId,
      createdAt: now,
      updatedAt: now,
      lastCheckinDate: '',
      lastCheckinAt: 0,
      streak: 0,
      bestStreak: 0,
      total: 0,
      dates: [],
    };
    store.checkins.push(item);
  }

  const repeated = item.lastCheckinDate === today;
  if (!repeated) {
    item.streak = item.lastCheckinDate === yesterday ? item.streak + 1 : 1;
    item.bestStreak = Math.max(item.bestStreak || 0, item.streak);
    item.total += 1;
    item.lastCheckinDate = today;
    item.lastCheckinAt = now;
    item.dates = [...new Set([...(item.dates || []), today])].sort().slice(-90);
  }
  item.chatType = chatType;
  item.chatId = chatId;
  item.userId = userId;
  item.updatedAt = now;
  saveStore(store);

  const opener = repeated
    ? pick([
      '今天已经签过到了，别搁这儿刷存在感。',
      '打过卡了，记录没丢，别急。',
      '今天这一下算复读，我给你记着呢。',
      '你今天已经露过脸了，可以去练枪了。',
    ], `${seed}:repeat`)
    : pick([
      '打卡收到了，今天算你来过。',
      '行，今天这口气先续上。',
      '签到成功，别签完就装死。',
      '今天先给你记一笔，后面看表现。',
    ], `${seed}:opener`);
  const task = pick([
    '今日顺手任务: 来一把前先说清楚默认站位，别开局就梦游。',
    '今日顺手任务: 发一张截图问“帮我看图”，让我先看可见信息。',
    '今日顺手任务: 用 /voice check 预检一句短语音，别让 TTS 念成长篇。',
    '今日顺手任务: 打完补一条 /cstrain log，训练别断档。',
    '今日顺手任务: 问实时阵容/排名前先 /cs verify，别把旧印象当今天事实。',
  ], `${seed}:task`);

  return [
    repeated ? '每日打卡 | 今天已经打过' : '每日打卡 | 成功',
    opener,
    `连续: ${item.streak}天 / 最佳: ${item.bestStreak}天 / 累计: ${item.total}次`,
    task,
    formatPostCompletionMediaStep(seed),
    '入口: /daily challenge 看今日挑战；/daily board 看打卡榜；/daily now 看今日状态；/daily media 识图语音陪跑；/daily recap 晚间复盘；/media daily 看识图语音链路。',
  ].join('\n');
}

export function recordDailyWrapUp(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  recordDailyChallengeDone(chatType, chatId, userId, date);
  recordDailyCheckin(chatType, chatId, userId, date);
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const seed = `${today}:${chatType}:${chatId}:${userId}:wrap`;
  const opener = pick([
    '行，今天这套收了，别再装没练过。',
    '收工记上了，今天至少不是空过。',
    '可以，挑战和出勤都给你勾上。',
    '今日收工收到，明天别从零开始热身。',
  ], `${seed}:opener`);

  return [
    `今日收工 | ${parts.label}`,
    opener,
    `挑战: 今日已完成 / 连续${challenge?.streak || 0}天 / 最佳${challenge?.bestStreak || 0}天 / 累计${challenge?.total || 0}次`,
    `打卡: 今日已到 / 连续${checkin?.streak || 0}天 / 最佳${checkin?.bestStreak || 0}天 / 累计${checkin?.total || 0}次`,
    formatPostCompletionMediaStep(seed),
    '下一步: 跑完 /daily media 的看图/听写/发语音小闭环，晚上看 /daily recap 收尾；明天再来 /daily challenge。',
    '边界: 这里只记录你主动说的收工，不读取对局、截图或语音内容。',
  ].join('\n');
}

export function formatDailyCheckinBoard(
  chatType: DailyPulseChatType,
  chatId: number,
  viewerUserId?: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const rows = loadStore().checkins
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastCheckinAt || 0) - (a.lastCheckinAt || 0)
      || a.userId - b.userId
    ));

  if (rows.length === 0) {
    return [
      `每日打卡榜 | ${parts.label}`,
      '当前会话还没人打卡。',
      '先来一句“今日打卡”，别让榜单空着。',
    ].join('\n');
  }

  const top = rows.slice(0, 8);
  const todayCount = rows.filter((item) => item.lastCheckinDate === today).length;
  const viewerIndex = viewerUserId
    ? rows.findIndex((item) => item.userId === viewerUserId)
    : -1;
  const viewerLine = viewerIndex >= 0 && viewerIndex >= top.length
    ? `你在第${viewerIndex + 1}名: ${formatCheckinLine(rows[viewerIndex], viewerIndex + 1, today).replace(/^\d+\.\s*/, '')}`
    : '';

  return [
    `每日打卡榜 | ${parts.label}`,
    `当前会话: ${rows.length}人上榜，今天${todayCount}人打卡`,
    ...top.map((item, index) => formatCheckinLine(item, index + 1, today)),
    viewerLine,
    '入口: 今日打卡 / /daily checkin；晚间看 /daily recap。',
  ].filter(Boolean).join('\n');
}

export function formatDailyChallengeBoard(
  chatType: DailyPulseChatType,
  chatId: number,
  viewerUserId?: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const rows = loadStore().challengeCompletions
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastDoneAt || 0) - (a.lastDoneAt || 0)
      || a.userId - b.userId
    ));

  if (rows.length === 0) {
    return [
      `今日挑战榜 | ${parts.label}`,
      '当前会话还没人完成挑战。',
      '先来一句“今日挑战”，做完再说“挑战完成”。',
    ].join('\n');
  }

  const top = rows.slice(0, 8);
  const todayCount = rows.filter((item) => item.lastDoneDate === today).length;
  const viewerIndex = viewerUserId
    ? rows.findIndex((item) => item.userId === viewerUserId)
    : -1;
  const viewerLine = viewerIndex >= 0 && viewerIndex >= top.length
    ? `你在第${viewerIndex + 1}名: ${formatChallengeCompletionLine(rows[viewerIndex], viewerIndex + 1, today).replace(/^\d+\.\s*/, '')}`
    : '';

  return [
    `今日挑战榜 | ${parts.label}`,
    `当前会话: ${rows.length}人上榜，今天${todayCount}人完成`,
    ...top.map((item, index) => formatChallengeCompletionLine(item, index + 1, today)),
    viewerLine,
    '入口: 今日挑战 / 挑战完成 / /daily challenge / /daily done；出勤榜看 /daily board。',
  ].filter(Boolean).join('\n');
}

export function formatDailySquadSummary(
  chatType: DailyPulseChatType,
  chatId: number,
  viewerUserId?: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkinRows = store.checkins
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastCheckinAt || 0) - (a.lastCheckinAt || 0)
      || a.userId - b.userId
    ));
  const challengeRows = store.challengeCompletions
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastDoneAt || 0) - (a.lastDoneAt || 0)
      || a.userId - b.userId
    ));
  const todayCheckins = checkinRows.filter((item) => item.lastCheckinDate === today);
  const todayChallenges = challengeRows.filter((item) => item.lastDoneDate === today);
  const userIds = new Set<number>([
    ...checkinRows.map((item) => item.userId),
    ...challengeRows.map((item) => item.userId),
  ]);
  const todayDoubleCount = Array.from(userIds).filter((userId) => (
    todayCheckins.some((item) => item.userId === userId)
    && todayChallenges.some((item) => item.userId === userId)
  )).length;
  const topCheckin = checkinRows[0] || null;
  const topChallenge = challengeRows[0] || null;
  const viewerCheckin = viewerUserId
    ? checkinRows.find((item) => item.userId === viewerUserId) || null
    : null;
  const viewerChallenge = viewerUserId
    ? challengeRows.find((item) => item.userId === viewerUserId) || null
    : null;
  const viewerCheckedToday = viewerCheckin?.lastCheckinDate === today;
  const viewerChallengedToday = viewerChallenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${viewerUserId || 0}:squad`;
  const rhythm = todayDoubleCount > 0
    ? pick([
      `今天已经${todayDoubleCount}人双收，队形站住了，别让后排掉线。`,
      `${todayDoubleCount}人把挑战和打卡都收了，今天群里不是空转。`,
      `双收${todayDoubleCount}人，节奏有了，剩下的人补一手就齐。`,
    ], `${seed}:rhythm-solid`)
    : todayCheckins.length > 0 || todayChallenges.length > 0
      ? pick([
        '有人开张了，但挑战和打卡还没合成整队形。',
        '今天不是零进度，可惜还差几个顺手补位。',
        '队形刚起头，别只签到不做题，也别做完忘打卡。',
      ], `${seed}:rhythm-half`)
      : pick([
        '当前会话今天还没开张，先让一个人把队形带起来。',
        '队形暂时是空的，别等睡前才集体补票。',
        '今天还没人动手，先丢一个 /daily challenge 破冰。',
      ], `${seed}:rhythm-empty`);
  const challengeTopLine = topChallenge
    ? `扛旗 QQ${topChallenge.userId} 连续${topChallenge.streak}天 / 最佳${topChallenge.bestStreak}天 / 累计${topChallenge.total}次 / ${topChallenge.lastDoneDate === today ? '今日已完成' : `最近${topChallenge.lastDoneDate || '无'}`}`
    : '还没人上榜；先 /daily challenge，做完说“挑战完成”。';
  const checkinTopLine = topCheckin
    ? `扛旗 QQ${topCheckin.userId} 连续${topCheckin.streak}天 / 最佳${topCheckin.bestStreak}天 / 累计${topCheckin.total}次 / ${topCheckin.lastCheckinDate === today ? '今日已到' : `最近${topCheckin.lastCheckinDate || '无'}`}`
    : '还没人上榜；先说“今日打卡”。';
  const viewerLine = viewerUserId
    ? `你: 挑战${viewerChallengedToday ? '已完成' : '未完成'} / 打卡${viewerCheckedToday ? '已到' : '未打'}`
    : '';
  const viewerNext = !viewerUserId
    ? '看 /daily guard 找当前用户缺项，或 /daily media 跑识图语音三件套'
    : viewerChallengedToday && viewerCheckedToday
      ? '你已双收，去 /daily media 跑看图/听写/发语音小闭环，再喊群友补队形'
      : !viewerChallengedToday && !viewerCheckedToday
        ? '你还差挑战和打卡，直接说“今日收工”最省事'
        : !viewerChallengedToday
          ? '你还差挑战，先 /daily challenge，做完说“挑战完成”'
          : '你还差打卡，顺手说“今日打卡”';
  const groupAction = todayChallenges.length === 0 && todayCheckins.length === 0
    ? '先让一个人发“今日挑战”开局'
    : todayDoubleCount === 0
      ? '今天有半截进度，喊“今日收工”把双收补齐'
      : '看 /daily guard 保连续，再用 /daily media 跑识图语音小闭环';

  return [
    `每日队形 | ${parts.label}`,
    `当前${chatType === 'group' ? '群' : '会话'}: ${userIds.size}人有记录，今日挑战${todayChallenges.length}人，今日打卡${todayCheckins.length}人，双收${todayDoubleCount}人`,
    `队形: ${rhythm}`,
    `今日挑战: ${challengeTopLine}`,
    `今日打卡: ${checkinTopLine}`,
    viewerLine,
    `识图语音: ${formatMediaDailyShortStatus()}`,
    `下一步: ${viewerNext}；群动作: ${groupAction}。`,
    '入口: /daily guard / /daily media / /daily me / /daily challenge board / /daily board',
    '边界: 这里只读当前会话本地每日记录和多模态 trace 摘要；不会替任何人写挑战、打卡，也不会假装看过图或听过语音。',
  ].filter(Boolean).join('\n');
}

export function formatDailyIcebreaker(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:ice`;
  const opener = pick([
    '别硬聊大话题，今天就丢一个能接住的。',
    '群里冷了就用短问题开，不要上来写小作文。',
    '今天破冰别尬，抛个选择题让人能顺手回。',
    '先给群里一个台阶，谁想接都能接。',
  ], `${seed}:opener`);
  const csPoll = pick([
    '今天只看一张图，你会选 Mirage、Inferno 还是 Nuke？说理由，别只报图名。',
    '如果今天只能练 20 分钟，你选急停、预瞄、道具还是残局？',
    '今天当队友指挥，你第一句会喊“慢控”“提速”还是“保枪”？',
    '同样 1v2，你更怕没信息、没血量、没道具，还是队友在旁边开香槟？',
    '今天看比赛只盯一个点：首杀、补枪、道具交换、经济处理，选一个。',
  ], `${seed}:poll`);
  const imagePrompt = pick([
    '帮我看图，先说画面里确定看见什么，再给一句判断',
    '这张图如果当回合截图，最该先注意哪一块',
    '别猜没出现的东西，只按图里信息说重点',
    '这图里有没有容易误判的细节，先列可见信息',
  ], `${seed}:image`);
  const voiceLine = pick([
    '今天先别急，信息补齐再开喷。',
    '这把先稳住，别第一身位白给。',
    '看清再说，别拿脑补当证据。',
    '少讲玄学，先把链路跑通。',
    '先听准，再判断。',
  ], `${seed}:voice`);
  const miniGame = pick([
    '三词接力: 一人丢地图，一人丢武器，一人丢打法，最后谁来一句战术总结。',
    '一分钟复盘: 每人只说一个今天最想改的坏习惯，别展开。',
    '截图接力: 谁发图，下一位只说可见信息，不许脑补剧情。',
    '语音接力: 每人一句不超过 12 个字，先 /voice check 再真测。',
  ], `${seed}:game`);
  const personalNext = challengedToday && checkedToday
    ? '你今天双收了，可以当破冰的人；顺手跑 /daily media。'
    : challengedToday
      ? '你挑战有了，还差打卡；聊完顺手说“今日打卡”。'
      : checkedToday
        ? '你打卡有了，还差挑战；先 /daily challenge，做完说“挑战完成”。'
        : '你今天两项都空；破冰后说“今日收工”最省事。';

  return [
    `每日破冰话题 | ${parts.label}`,
    '模式: 只读话题卡，不写挑战/打卡，不下载图片，不听写语音，不调用模型',
    `QQ${userId}: ${opener}`,
    `群话题: ${csPoll}`,
    `看图接力: 发图 + “${imagePrompt}”`,
    `语音接力: /voice check ${voiceLine}；真测再用 /voice test ${voiceLine}`,
    `小玩法: ${miniGame}`,
    `你的缺口: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}；${personalNext}`,
    `识图语音: ${formatMediaDailyShortStatus()}`,
    '入口: /daily squad / /daily media / /daily challenge / /csquiz / /cstrain / /media daily',
    '边界: 这是群聊破冰脚本，不代表已经看过图或听过语音；check/warm/cache hit 不算实跑，真实内容以 /vision test、/voice stt、/voice test 的 trace 为准。',
  ].join('\n');
}

export function formatDailyUserSummary(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkinRows = store.checkins
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastCheckinAt || 0) - (a.lastCheckinAt || 0)
      || a.userId - b.userId
    ));
  const challengeRows = store.challengeCompletions
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => (
      (b.streak || 0) - (a.streak || 0)
      || (b.bestStreak || 0) - (a.bestStreak || 0)
      || (b.total || 0) - (a.total || 0)
      || (b.lastDoneAt || 0) - (a.lastDoneAt || 0)
      || a.userId - b.userId
    ));
  const checkinRank = checkinRows.findIndex((item) => item.userId === userId);
  const challengeRank = challengeRows.findIndex((item) => item.userId === userId);
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const mediaStatus = formatMediaDailyShortStatus();
  const next: string[] = [];

  if (!challengedToday) {
    next.push('先 /daily challenge，看完做完说“挑战完成”');
  }
  if (!checkedToday) {
    next.push('顺手说“今日打卡”，别让出勤断了');
  }
  if (next.length === 0) {
    next.push('今天两项都收了，跑 /daily media 把看图/听写/发语音小闭环过一遍，晚上 /daily recap 收尾');
  }

  return [
    `我的每日状态 | ${parts.label}`,
    `QQ${userId}`,
    `打卡: ${checkedToday ? '今日已到' : '今天未打'} / 连续${checkin?.streak || 0}天 / 最佳${checkin?.bestStreak || 0}天 / 累计${checkin?.total || 0}次${checkinRank >= 0 ? ` / 当前第${checkinRank + 1}名` : ''}`,
    `挑战: ${challengedToday ? '今日已完成' : '今天未完成'} / 连续${challenge?.streak || 0}天 / 最佳${challenge?.bestStreak || 0}天 / 累计${challenge?.total || 0}次${challengeRank >= 0 ? ` / 当前第${challengeRank + 1}名` : ''}`,
    `识图语音: ${mediaStatus}`,
    `下一步: ${next.join('；')}`,
    '入口: /daily challenge / /daily done / /daily checkin / /daily media / /daily challenge board / /daily board',
    '边界: 这里只读本地每日记录，不读取聊天内容、demo、截图或语音；要真看图/听语音，直接发附件并明确问。',
  ].join('\n');
}

export function formatDailyActionPlan(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:plan`;
  const opener = pick([
    '今天别开局就散着玩，先把小闭环跑完。',
    '安排很简单，别把状态牌看成完成牌。',
    '先做能落地的，别上来就给自己画大饼。',
    '今天按三步走，做完再嘴硬比较有底气。',
  ], `${seed}:opener`);
  const first = !challengedToday
    ? '先看 /daily challenge，挑一个能在十几分钟内做完的小动作。'
    : !checkedToday
      ? '挑战已经有了，先说“今日打卡”，别让出勤断了。'
      : '挑战和打卡都收了，别加班式硬刷，转去查链路和做复盘。';
  const useful = pick([
    '来一题 /csquiz，答错就看解析，别把云判断留到明天。',
    '跑一组 /cstrain，练完补 /cstrain log，训练记录比嘴硬靠谱。',
    '看 /csreport focus，有比赛先抓重点，没 fresh 证据就别报死。',
    '发一张截图问“帮我看图”，让回复先讲可见信息再短评。',
  ], `${seed}:useful`);
  const close = checkedToday && challengedToday
    ? '晚上用 /daily recap 收尾；明天继续保连续。'
    : '做完缺项后说“今日收工”，一次把挑战完成和打卡收住。';

  return [
    `玩机器今日安排 | ${parts.label}`,
    opener,
    `日常进度: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}`,
    `先手: ${first}`,
    '识图语音: /media daily 看今日三件套；缺哪条就真测 /vision test、/voice stt、/voice test，别拿 check/warm/cache hit 充数。',
    `好玩/有用: ${useful}`,
    `收尾: ${close}`,
    '入口: /daily me / /daily week / /daily wrap / /daily media / /media daily / /csquiz / /cstrain',
    '边界: 这里只读本地每日记录，不读取聊天内容、demo、截图或语音；识图/听写/发语音是否真跑，以 /media daily 和 trace 里的真实记录为准。',
  ].join('\n');
}

export function formatDailyNudge(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:nudge`;
  const line = checkedToday && challengedToday
    ? pick([
      '今天两项都收了，别硬刷数量，去把链路和复盘补一下。',
      '今天不欠账了，剩下就是别膨胀，晚上收个尾。',
      '连续已经护住了，现在别加戏，查一下三件套更有用。',
    ], `${seed}:done`)
    : !challengedToday && !checkedToday
      ? pick([
        '你今天还没动，别把“等会儿”说成战术暂停。',
        '现在就差你抬手，先做一个小动作，别把连续交给玄学。',
        '别装没看见，挑战和打卡都空着，先捡一个最小闭环。',
      ], `${seed}:empty`)
      : !challengedToday
        ? pick([
          '人到了，活还没干，别只签到不做事。',
          '打卡有了，挑战还空着，今天别当观众。',
          '出勤保住了，去把今日挑战也顺手收了。',
        ], `${seed}:challenge`)
        : pick([
          '挑战做了，打卡没记，别让记录输给手懒。',
          '任务都落地了，顺手打个卡，别明天才想起来。',
          '挑战完成是完成，出勤也得留痕，去打卡。',
        ], `${seed}:checkin`);
  const action = checkedToday && challengedToday
    ? '/media daily 看今日三件套；晚上 /daily recap 收尾'
    : !challengedToday && !checkedToday
      ? '/daily plan 看安排；做完说“今日收工”一次收两项'
      : !challengedToday
        ? '/daily challenge 看任务，做完说“挑战完成”'
        : '说“今日打卡”，把出勤补上';

  return [
    `玩机器今日催一下 | ${parts.label}`,
    `QQ${userId} 进度: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}`,
    `一句: ${line}`,
    `现在就做: ${action}`,
    '备用入口: /daily plan / /daily guard / /daily me / /daily media / /daily wrap / /media daily',
    '边界: 这里只读本地每日记录，不会替你写挑战或打卡；要记账请明确说“挑战完成”“今日打卡”或“今日收工”。',
  ].join('\n');
}

export function formatDailyStreakGuard(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:guard`;
  const risks = [
    challengedToday ? '' : `挑战连续${challenge?.streak || 0}天还没护住`,
    checkedToday ? '' : `打卡连续${checkin?.streak || 0}天还没护住`,
  ].filter(Boolean);
  const now = checkedToday && challengedToday
    ? '连续已经保住，别刷记录；去 /daily media 跑看图/听写/发语音小闭环。'
    : !checkedToday && !challengedToday
      ? '直接说“今日收工”，一次把挑战完成和打卡都收住。'
      : !challengedToday
        ? '先 /daily challenge，做完说“挑战完成”。'
        : '顺手说“今日打卡”，别让出勤输给手懒。';
  const coach = pick([
    '别等睡前才想起来，那时候人最会给自己找理由。',
    '今天只求不断，强度先放一边，连续别丢。',
    '先把最小动作做了，后面想加练再加。',
    '记录是给明天的你看的，今天别把坑留给他。',
  ], `${seed}:coach`);
  const mediaAction = pick([
    '/daily media 取一张陪跑卡，照着跑完三件套',
    '/voice check 先预检一句短句，再 /voice test 真发',
    '发图问“帮我看图”，让回复先说可见信息',
    '/media daily 看缺口，缺哪条就真测哪条',
  ], `${seed}:media`);

  return [
    `每日保连续 | ${parts.label}`,
    `QQ${userId}`,
    `挑战: ${challengedToday ? '今日已完成' : '今天未完成'} / 连续${challenge?.streak || 0}天 / 最佳${challenge?.bestStreak || 0}天`,
    `打卡: ${checkedToday ? '今日已到' : '今天未打'} / 连续${checkin?.streak || 0}天 / 最佳${checkin?.bestStreak || 0}天`,
    `风险: ${risks.length ? risks.join('；') : '今天挑战和打卡都保住了，别再重复刷记录。'}`,
    `现在就补: ${now}`,
    `识图语音: ${formatMediaDailyShortStatus()}`,
    `顺手加一件: ${mediaAction}`,
    `一句: ${coach}`,
    '入口: /daily wrap / /daily done / /daily checkin / /daily media / /daily recap',
    '边界: 这里只读本地每日记录和多模态 trace 摘要；不会替你写记录，也不会假装看过图或听过语音。',
  ].join('\n');
}

export function formatDailyMediaCompanion(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:media-companion`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const opener = pick([
    '今天别把多模态当玄学，按一张图、一条听写、一句语音跑完。',
    '给你排个短的，真测一遍，比盯着状态页发呆有用。',
    '今天三件事别整复杂：看清、听准、少念废话。',
    '先跑小闭环，别等群友真丢图丢语音了再现场翻工具箱。',
  ], `${seed}:opener`);
  const imageAsk = pick([
    '帮我看图，先说可见信息，再给一句判断',
    '看看这张图，别猜没出现的东西',
    '这图里重点是什么，先按画面说',
    '帮我确认这张图有没有关键细节',
  ], `${seed}:image`);
  const sttLine = pick([
    '这波听写链路短测一下',
    '别急着下结论，先把语音听准',
    '今天先测听写，再让机器嘴硬',
    '语音里有信息，先转出来再聊',
  ], `${seed}:stt`);
  const voiceLine = pick([
    '今天先稳一手，别上来白给。',
    '看清再说，别靠脑补打完一整局。',
    '这把先别急，信息补齐再开喷。',
    '别装没看见，先把链路跑通。',
    '少说废话，先看证据。',
  ], `${seed}:voice`);
  const finish = checkedToday && challengedToday
    ? '个人每日已经双收，跑完三件套就可以晚上 /daily recap 收尾。'
    : challengedToday
      ? '挑战有了，还差打卡；跑完语音短句后顺手说“今日打卡”。'
      : checkedToday
        ? '打卡有了，还差挑战；先 /daily challenge，做完说“挑战完成”。'
        : '每日两项还空着；跑完陪测后说“今日收工”，一次把挑战和打卡收住。';

  return [
    `识图语音今日陪跑 | ${parts.label}`,
    '模式: 只读行动卡，不下载图片、不听写语音、不调用模型、不生成音频',
    `QQ${userId}: ${opener}`,
    `日常进度: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}`,
    `今日实跑: ${media?.todayRuns || '看 /media daily 获取今日实跑'}`,
    `看图问法: 发图 + “${imageAsk}”`,
    `听写真测: 发语音或语音URL后用 /voice stt；建议语音里说“${sttLine}”。`,
    `发语音短句: ${voiceLine}`,
    `先预检: /voice check ${voiceLine}`,
    `真测: /voice test ${voiceLine}`,
    `收尾: ${finish}`,
    '入口: /media daily / /vision test <图片URL> / /voice stt <语音URL> / /voice test <短句> / /daily recap',
    '边界: check/warm/cache hit 不算今天真的看过或听过；只有 /vision test、/voice stt、/voice test 成功 trace 才算实跑。',
  ].join('\n');
}

export function formatDailyMediaScript(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:media-script`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const imageScript = pick([
    '帮我看图，先只说可见信息，再给一句判断，别猜图外内容',
    '这张图里最关键的可见信息是什么，按画面说，最后给一句建议',
    '先列图里确定能看见的东西，再说有没有容易误判的细节',
    '帮我确认这张图重点在哪，未知的地方直接说未知',
  ], `${seed}:image`);
  const sttScript = pick([
    '这波先听写，不确定的字别硬猜',
    '语音里有信息，先转出来再判断',
    '今天测一下听写链路，短句就行',
    '别靠脑补听语音，先把原话转出来',
  ], `${seed}:stt`);
  const voiceScript = pick([
    '看清再说，别拿脑补当证据。',
    '先听准，再判断。',
    '这把先稳住，信息补齐再开。',
    '少讲玄学，先看 trace。',
    '别急，先把链路跑通。',
  ], `${seed}:voice`);
  const receipt = pick([
    '已跑: 看图 / 听写 / 发语音；缺口看 /media daily。',
    '三件套收工，真实记录看 trace，别拿缓存当战绩。',
    '图、听写、语音各跑一次，今晚 /daily recap 收尾。',
    '链路过一遍，有问题直接 /vision last 或 /voice recent 3。',
  ], `${seed}:receipt`);
  const dailyNext = challengedToday && checkedToday
    ? '你今天挑战和打卡都收了，脚本跑完就可以晚点 /daily recap。'
    : challengedToday
      ? '你挑战已完成，脚本跑完顺手说“今日打卡”。'
      : checkedToday
        ? '你打卡已到，脚本跑完再 /daily challenge，做完说“挑战完成”。'
        : '你今天两项还空，脚本跑完说“今日收工”一次收住。';

  return [
    `识图语音每日脚本包 | ${parts.label}`,
    '模式: 只读脚本，不下载图片、不听写语音、不调用模型、不生成音频',
    `QQ${userId} 进度: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}`,
    `今日实跑: ${media?.todayRuns || '看 /media daily 获取今日实跑'}`,
    `1. 看图脚本: 发图 + “${imageScript}”`,
    `2. 听写脚本: 发语音或语音URL后用 /voice stt；语音里说“${sttScript}”。`,
    `3. 发声脚本: /voice check ${voiceScript} -> /voice test ${voiceScript}`,
    '4. 验收脚本: /media daily；必要时看 /vision last、/voice recent 3、/trace last。',
    `群里回执: ${receipt}`,
    `日常收尾: ${dailyNext}`,
    '入口: /daily media / /media daily / /vision test <图片URL> / /voice stt <语音URL> / /voice test <短句>',
    '边界: 这张卡只给脚本和命令；check/warm/cache hit 不算今天真看图、真听写或真发声，只有 /vision test、/voice stt、/voice test 成功 trace 才算实跑。',
  ].join('\n');
}

export function formatDailyMediaGap(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:media-gap`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const missing = runs.filter((item) => item.passed === 0);
  const failed = runs.filter((item) => item.attempts > 0 && item.passed === 0);
  const done = runs.filter((item) => item.passed > 0);
  const priority = missing[0] || null;
  const opener = pick([
    '今天别靠感觉补链路，看 trace，缺哪条补哪条。',
    '别把 check 当真跑，今天按成功 trace 算账。',
    '这张就是补缺单，不讲玄学，只看有没有真跑过。',
    '先把缺口补上，别等要用的时候才发现链路没过。',
  ], `${seed}:opener`);
  const next = priority
    ? `${priority.label}: ${priority.action}`
    : '三件套都有成功 trace；可以 /media recent 3 看最近失败、截断或发送问题';
  const rescue = priority?.label === '识图'
    ? '找一张安全图片 URL 跑 /vision test；只 /vision check 或 /vision warm 不算。'
    : priority?.label === '听写'
      ? '找一条短语音 URL 跑 /voice stt；只看 sttcache 不算。'
      : priority?.label === '发语音'
        ? '先 /voice check 短句，再 /voice test 真发 record。'
        : '保持今晚 /daily recap，别重复刷同一条链路。';
  const dailyNext = challengedToday && checkedToday
    ? '挑战和打卡已收，补完链路就看 /daily recap。'
    : challengedToday
      ? '挑战已完成；补完链路顺手说“今日打卡”。'
      : checkedToday
        ? '打卡已到；补完链路再 /daily challenge。'
        : '每日两项也空着；补完链路后说“今日收工”。';

  return [
    `识图语音今日补缺 | ${parts.label}`,
    '模式: 只读补缺单，不下载图片、不听写语音、不调用模型、不生成音频',
    `QQ${userId}: ${opener}`,
    `今日实跑: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}`,
    `完成: ${done.length ? done.map((item) => `${item.label}${item.passed}/${item.attempts}`).join('；') : '暂无成功 trace'}`,
    `缺口: ${missing.length ? missing.map((item) => `${item.label}${item.attempts > 0 ? ` 已试${item.attempts}次未过` : '未真测'}`).join('；') : '今天三件套都有成功 trace'}`,
    failed.length ? `失败优先看: ${failed.map((item) => `${item.label}${item.attempts}次`).join('；')}；再看 /media recent 3` : '',
    `优先补: ${next}`,
    `怎么补: ${rescue}`,
    `最近识图: ${media?.lastVisionSummary || '无真实图片回复 trace'}`,
    `最近听写: ${media?.lastRecordSummary || '无真实听写 trace'}`,
    `最近发声: ${media?.lastVoiceSummary || '无真实语音发送 trace'}`,
    `日常收尾: ${dailyNext}`,
    '入口: /daily script / /media daily / /media recent 3 / /vision last / /voice recent 3 / /trace last',
    '边界: 只有 /vision test、/voice stt、/voice test 成功 trace 才算今天真看图、真听写或真发声；check/warm/cache hit 都不算实跑。',
  ].filter(Boolean).join('\n');
}

export function formatDailyVoiceLineKit(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:voice-line`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const voiceRun = runs.find((item) => item.label === '发语音') || null;
  const sttRun = runs.find((item) => item.label === '听写') || null;
  const tone = pick([
    '短、松一点，像群里接一句，不要端播音腔',
    '带一点轻吐槽，但别阴阳怪气过头',
    '像刚看完一回合顺口说的，句子别拉长',
    '稳住一点，少解释，多给动作',
  ], `${seed}:tone`);
  const mainLine = pick([
    '先别急，信息补齐再开。',
    '看清再说，别拿脑补当证据。',
    '这把先稳住，别第一身位白给。',
    '少讲玄学，先把链路跑通。',
    '别装没看见，先把图和语音过一遍。',
    '今天别硬嘴，trace 能说明白就行。',
  ], `${seed}:main`);
  const echoLine = pick([
    '行，先过链路。',
    '别急，先看证据。',
    '能听清再判断。',
    '今天少白给一点。',
    '先稳，再说。',
  ], `${seed}:echo`);
  const groupCue = pick([
    '群里谁发张图，我只按可见信息说，不脑补剧情。',
    '谁来一条短语音，听写过了再聊细节。',
    '今天就一人一句短语音，别上来念小作文。',
    '发完语音记得看 /voice recent 3，失败原因别靠猜。',
  ], `${seed}:cue`);
  const priority = voiceRun?.passed
    ? `发语音已有成功 trace ${voiceRun.passed}/${voiceRun.attempts}；可以换一句短回声再测，不要重复刷同一句。`
    : `先 /voice check ${mainLine}，没问题再 /voice test ${mainLine}`;
  const sttBackcheck = sttRun?.passed
    ? `听写今天已有成功 trace ${sttRun.passed}/${sttRun.attempts}；真发后可看 /voice recent 3 对照。`
    : '发完后再找一条短语音跑 /voice stt，确认听写链路也是真的过。';
  const dailyNext = challengedToday && checkedToday
    ? '挑战和打卡已收，语音真测后晚上 /daily recap。'
    : challengedToday
      ? '挑战已完成；真测语音后顺手说“今日打卡”。'
      : checkedToday
        ? '打卡已到；真测语音后再 /daily challenge。'
        : '每日两项也空着；真测语音后说“今日收工”。';

  return [
    `每日语音台词 | ${parts.label}`,
    '模式: 只读台词卡，不调用 AI，不生成音频，不发送 record',
    `QQ${userId}: ${tone}`,
    `今日实跑: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}；发语音${voiceRun ? `${voiceRun.passed}/${voiceRun.attempts}` : '0/0'}`,
    `主句: ${mainLine}`,
    `短回声: ${echoLine}`,
    `群里接话: ${groupCue}`,
    `预检: /voice check ${mainLine}`,
    `管理员预热: /voice warm ${mainLine}`,
    `真测: /voice test ${mainLine}`,
    `听写反查: ${sttBackcheck}`,
    `今天优先: ${priority}`,
    `日常收尾: ${dailyNext}`,
    '入口: /daily media / /daily gap / /media daily / /voice recent 3 / /trace last',
    '边界: /voice check 和 /voice warm 只做预检或缓存；只有 /voice test 成功 trace 才算今天真发过语音，授权样本也不能说成现实本人语音。',
  ].join('\n');
}

export function formatDailyMediaRelay(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkinRows = store.checkins.filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0);
  const challengeRows = store.challengeCompletions.filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0);
  const todayCheckins = checkinRows.filter((item) => item.lastCheckinDate === today);
  const todayChallenges = challengeRows.filter((item) => item.lastDoneDate === today);
  const userIds = new Set<number>([
    ...checkinRows.map((item) => item.userId),
    ...challengeRows.map((item) => item.userId),
  ]);
  const todayDoubleCount = Array.from(userIds).filter((id) => (
    todayCheckins.some((item) => item.userId === id)
    && todayChallenges.some((item) => item.userId === id)
  )).length;
  const checkin = checkinRows.find((item) => item.userId === userId) || null;
  const challenge = challengeRows.find((item) => item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:relay`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const missing = runs.filter((item) => item.passed === 0);
  const priority = missing[0]?.label || '验收';
  const opener = pick([
    '别一个人闷头点命令，今天把三件套拆给群里接力。',
    '群里要热起来，别只丢一句“怎么说”，给每个人一个能接的活。',
    '今天多模态别散着跑，一人一棒最省事。',
    '接力比刷菜单有用，图、听写、发声各来一下。',
  ], `${seed}:opener`);
  const imagePrompt = pick([
    '帮我看图，先说确定看见什么，再给一句判断',
    '这张图只按可见信息说，别猜图外剧情',
    '帮我找这图里最容易误判的细节',
    '这张图当回合截图看，重点先看哪里',
  ], `${seed}:image`);
  const sttPrompt = pick([
    '这波语音先转出来，不确定的字别硬猜',
    '听写一下，先把信息说清楚再评价',
    '短语音测链路，别拿脑补当原话',
    '先听准，再判断这波该不该嘴硬',
  ], `${seed}:stt`);
  const voiceLine = pick([
    '先看清，再开口。',
    '别急，信息补齐再说。',
    '少讲玄学，先看 trace。',
    '这把先稳住，别白给。',
    '能查就查，别硬编。',
  ], `${seed}:voice`);
  const handoff = pick([
    '上一棒发完就丢一句“下一棒听写”，别让链路断在半路。',
    '每棒只干一件事，少解释，跑完再复盘。',
    '谁卡住就直接 /daily gap，看缺哪条别靠猜。',
    '跑完别刷屏，发一条回执就行。',
  ], `${seed}:handoff`);
  const groupRhythm = todayDoubleCount > 0
    ? `当前${chatType === 'group' ? '群' : '会话'}已有${todayDoubleCount}人双收，适合直接开接力。`
    : todayCheckins.length + todayChallenges.length > 0
      ? '当前会话有人动了，但队形还没齐；接力顺手把每日也带起来。'
      : '当前会话今天还没开张，先用接力破冰，再补挑战和打卡。';
  const firstSeat = priority === '识图'
    ? '看图位先上，找一张安全图片真测 /vision test。'
    : priority === '听写'
      ? '听写位先上，拿一条短语音真跑 /voice stt。'
      : priority === '发语音'
        ? '发声位先上，/voice check 后用 /voice test 真发。'
        : '验收位先上，/media daily 和 /daily gap 看今天有没有失败或截断。';
  const personalNext = challengedToday && checkedToday
    ? '你已双收，适合当验收位。'
    : challengedToday
      ? '你挑战已完成，还差打卡；接力后说“今日打卡”。'
      : checkedToday
        ? '你打卡已到，还差挑战；接力后 /daily challenge。'
        : '你两项都空，接力后说“今日收工”最省事。';

  return [
    `识图语音每日接力 | ${parts.label}`,
    '模式: 只读接力卡，不写挑战/打卡，不下载图片，不听写语音，不调用模型，不生成音频',
    `QQ${userId}: ${opener}`,
    `${groupRhythm} 你: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}。`,
    `今日实跑: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}；优先棒位: ${priority}`,
    `1. 看图位: 发图 + “${imagePrompt}”；真测远程图用 /vision test <图片URL>。`,
    `2. 听写位: 发语音或语音URL + /voice stt；语音里说“${sttPrompt}”。`,
    `3. 发声位: /voice check ${voiceLine} -> /voice test ${voiceLine}`,
    '4. 验收位: /media daily；缺口看 /daily gap；失败看 /media recent 3。',
    `先让谁上: ${firstSeat}`,
    `交棒话术: ${handoff}`,
    `你的收尾: ${personalNext}`,
    '入口: /daily line / /daily gap / /daily squad / /daily ice / /vision last / /voice recent 3',
    '边界: 这张卡只是分工脚本；check/warm/cache hit 不算实跑，只有 /vision test、/voice stt、/voice test 成功 trace 才算今天真看图、真听写或真发声。',
  ].join('\n');
}

export function formatDailyChatVibe(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const seed = `${today}:${chatType}:${chatId}:${userId}:vibe`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const missing = runs.filter((item) => item.passed === 0).map((item) => item.label);
  const pace = pick([
    '今天少写长段，像群里人接话，先一句判断再给入口。',
    '今天走短句节奏，别急着上价值，能查就查，能听就听。',
    '今天语气放松一点，可以吐槽，但别把每句都说成报告。',
    '今天先接住人，再给命令；别一上来就堆菜单。',
  ], `${seed}:pace`);
  const opener = pick([
    '先别急，发图我看图，发语音我听写，别让我靠脑补打完一整局。',
    '今天谁先白给我不管，谁硬编事实我先抓谁。',
    '群里别装死，丢图、丢语音、丢一句问题都行，我按能看到的说。',
    '今天节奏简单，短问短答，证据不够就别嘴硬。',
  ], `${seed}:opener`);
  const imageReply = pick([
    '先说“我看见的是...”，再补一句判断，未知的地方直接说未知。',
    '先列可见信息，再提醒可能误判的点，别扩写图外剧情。',
    '能看清就短评，看不清就让对方补图，别硬猜。',
    '截图类先讲画面，赛事实时类再引导 /cs verify。',
  ], `${seed}:image`);
  const voiceReply = pick([
    '先确认听写结果，再评价内容；听不清就说听不清。',
    '语音太长就让对方拆短一点，别假装全听懂。',
    '转出来先复述关键句，再给一句建议。',
    '需要发声时先 /voice check，真发再 /voice test。',
  ], `${seed}:voice`);
  const stickerCue = pick([
    '贴纸只在白给、开香槟、老板大气这种情绪点补一手，别连发。',
    '今天贴纸当标点用，不当正文用。',
    '群里冷的时候先问一句，不要靠贴纸硬暖场。',
    '有人认真问问题时少贴纸，先把答案讲清楚。',
  ], `${seed}:sticker`);
  const stopRule = pick([
    '连续两次没人接就收住，别自己刷屏。',
    '证据不够就停在“不确定”，别硬凑结论。',
    '对方只想要命令时直接给入口，别扩写一屏。',
    '群里开始重复同一句时换话题或丢 /daily ice。',
  ], `${seed}:stop`);
  const mediaNudge = missing.length
    ? `今日多模态缺 ${missing.join('、')}，聊天里优先找机会补这几条。`
    : '今日三件套都有成功 trace，聊天里别重复刷同一条链路。';
  const personalNext = challengedToday && checkedToday
    ? '你今天双收了，适合当接话的人；晚上 /daily recap 收尾。'
    : challengedToday
      ? '你挑战有了，还差打卡；聊完顺手说“今日打卡”。'
      : checkedToday
        ? '你打卡有了，还差挑战；聊完跑 /daily challenge。'
        : '你两项都空着；先聊两句热场，再说“今日收工”。';

  return [
    `每日聊天节奏 | ${parts.label}`,
    '模式: 只读真人感卡，不改 prompt，不写记录，不调用模型，不生成音频',
    `QQ${userId}: ${pace}`,
    `开场一句: ${opener}`,
    `接图: ${imageReply}`,
    `接语音: ${voiceReply}`,
    `贴纸分寸: ${stickerCue}`,
    `收住规则: ${stopRule}`,
    `识图语音: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}；${mediaNudge}`,
    `你的收尾: ${personalNext}`,
    '入口: /daily relay / /daily line / /daily gap / /daily ice / /media daily / /style status',
    '边界: 这是聊天节奏建议，不代表已经看过图、听过语音或发过语音；实时事实仍要 fresh 证据，多模态是否真跑以 trace 为准。',
  ].join('\n');
}

export function formatDailyHumanReplyPack(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const profile = getUserProfile(chatType, chatId, userId);
  const seed = `${today}:${chatType}:${chatId}:${userId}:human-reply`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const missing = runs.filter((item) => item.passed === 0);
  const priority = missing[0] || null;
  const focusMap = profile?.favoriteMaps[0] || pick(['Mirage', 'Inferno', 'Nuke', 'Ancient'], `${seed}:map`);
  const focusPlayer = profile?.favoritePlayers[0] || '纪律好的那种选手';
  const tone = profile?.tone || pick([
    '短句，先接住人，再给动作',
    '松一点，可以轻吐槽，但别写成报告',
    '少解释，先说能做什么',
    '别端着，像群友顺手回一句',
  ], `${seed}:tone`);
  const opener = pick([
    '先别急，今天就短问短答，图和语音都按证据说。',
    '今天别开报告会，谁丢图谁先说清问题。',
    '群里先动一下，发图我看可见信息，发语音我先听写。',
    '别装死，先来一张图或一句语音，跑完再嘴硬。',
  ], `${seed}:opener`);
  const imageReply = profile?.favoriteMaps.length
    ? `这张按 ${focusMap} 的信息看，先说画面里确定有什么，别猜图外剧情。`
    : pick([
      '我先按看见的说，看不清的地方就别硬猜。',
      '先给画面信息，再给一句判断，不扩写图外剧情。',
      '这图先看确定信息，争议点留到补图再说。',
      '能看清就短评，看不清就让他补图。',
    ], `${seed}:image`);
  const voiceReply = pick([
    '先转出来，不确定的字别硬补，听清再评价。',
    '语音太长就拆短点，别让我假装全听懂。',
    '先听写，原话出来再判断这波该不该嘴硬。',
    `先按 ${focusPlayer} 那种纪律来，听准再说。`,
  ], `${seed}:voice`);
  const nudgeReply = !challengedToday && !checkedToday
    ? '你今天两项都空，先别立大旗，直接“今日收工”收个最小闭环。'
    : !challengedToday
      ? '人到了但任务没做，先 /daily challenge，做完再说话硬一点。'
      : !checkedToday
        ? '挑战做了就顺手打卡，别让记录输给手懒。'
        : priority
          ? `日常双收了，今天就补 ${priority.label}，别拿 check/cache 当实跑。`
          : '今天证据够了，别重复刷，晚上复盘一句就收。';
  const closeReply = pick([
    '证据不够就停在“不确定”，别硬凑结论。',
    '对方要入口就给入口，别扩成一屏说明书。',
    '没人接两轮就收住，别自己把群刷热闹。',
    '问最新阵容排名就先核证，不拿旧印象当今天事实。',
  ], `${seed}:close`);
  const avoid = pick([
    '别说“根据资料综合来看”，直接说你看见了什么。',
    '别说“作为AI我无法”，改成“我这边没证据，先别报死”。',
    '别把缓存 hit 说成刚看过、刚听过。',
    '别把画像偏好说成实时阵容、排名或状态。',
  ], `${seed}:avoid`);
  const mediaLine = priority
    ? `今日多模态缺 ${missing.map((item) => item.label).join('、')}；优先补 ${priority.label}: ${priority.action}`
    : '今日三件套都有成功 trace；聊天里别重复刷同一条链路。';

  return [
    `每日人话接话包 | ${parts.label}`,
    '模式: 只读短句卡，不写挑战/打卡，不改 prompt，不调用模型，不下载图片，不听写语音，不生成音频',
    `QQ${userId}: 口吻 ${tone}`,
    `开场: ${opener}`,
    `接图: ${imageReply}`,
    `接语音: ${voiceReply}`,
    `催补: ${nudgeReply}`,
    `收住: ${closeReply}`,
    `别说: ${avoid}`,
    `今日实跑: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}；${mediaLine}`,
    '入口: /daily vibe / /daily proof / /daily relay / /daily line / /daily gap / /media daily',
    '边界: 这些是可复制的短句建议，不代表已经看图、听写或发声；真实完成看 /daily proof 和 trace，实时事实看 fresh 证据。',
  ].join('\n');
}

export function formatDailyCompletionScore(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const mediaRuns = parseDailyMediaRunCounts(media?.todayRuns || '');
  const mediaByLabel = new Map(mediaRuns.map((item) => [item.label, item]));
  const items = [
    { label: '挑战', ok: challengedToday, weight: 20, action: '/daily challenge，看完做完说“挑战完成”' },
    { label: '打卡', ok: checkedToday, weight: 20, action: '说“今日打卡”，或用 /daily checkin' },
    { label: '识图', ok: (mediaByLabel.get('识图')?.passed || 0) > 0, weight: 20, action: '/vision test <图片URL>，或发图明确问“帮我看图”' },
    { label: '听写', ok: (mediaByLabel.get('听写')?.passed || 0) > 0, weight: 20, action: '/voice stt <语音URL> 真听一条短语音' },
    { label: '发语音', ok: (mediaByLabel.get('发语音')?.passed || 0) > 0, weight: 20, action: '/voice check <短句> 后 /voice test <短句>' },
  ];
  const total = items.reduce((sum, item) => sum + (item.ok ? item.weight : 0), 0);
  const done = items.filter((item) => item.ok);
  const missing = items.filter((item) => !item.ok);
  const next = missing[0] || null;
  const mood = total >= 100
    ? '满分闭环，今天别重复刷，晚上复盘就行。'
    : total >= 80
      ? '差最后一两步，别让今天卡在门口。'
      : total >= 60
        ? '骨架有了，先补最短缺口。'
        : total >= 40
          ? '今天还没跑顺，别只看卡片，先动手补一项。'
          : '现在还是空转状态，别把“等会儿”当战术。';
  const oneMinute = next
    ? next.action
    : '看 /daily recap 收尾；明天继续保连续。';
  const mediaLine = media
    ? `多模态真实: ${media.todayRuns}`
    : '多模态真实: 读取不到摘要；看 /media daily';
  const failLine = mediaRuns
    .filter((item) => item.attempts > 0 && item.passed === 0)
    .map((item) => `${item.label}${item.attempts}次未过`)
    .join('；');

  return [
    `今日闭环分 | ${parts.label}`,
    '模式: 只读评分卡，不写挑战/打卡，不下载图片，不听写语音，不调用模型，不生成音频',
    `QQ${userId}: ${total}/100，${mood}`,
    `完成: ${done.length ? done.map((item) => `${item.label}+${item.weight}`).join('；') : '暂无完成项'}`,
    `缺口: ${missing.length ? missing.map((item) => `${item.label}-${item.weight}`).join('；') : '今天五项都收住了'}`,
    mediaLine,
    failLine ? `失败提示: ${failLine}；看 /daily gap 或 /media recent 3` : '',
    `一分钟补法: ${oneMinute}`,
    `收尾: ${total >= 100 ? '/daily recap' : '/daily score 补完再看；缺多模态就 /daily relay，缺日常就 /daily guard'}`,
    '入口: /daily me / /daily guard / /daily relay / /daily gap / /media daily / /daily recap',
    '边界: 闭环分只按本地每日记录和真实多模态 trace 估算；check/warm/cache hit 不加分，只有 /vision test、/voice stt、/voice test 成功 trace 才算多模态完成。',
  ].filter(Boolean).join('\n');
}

export function formatDailyPersonalizedBrief(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const profile = getUserProfile(chatType, chatId, userId);
  const hasProfile = !!profile && (
    profile.favoriteTeams.length > 0
    || profile.favoritePlayers.length > 0
    || profile.favoriteMaps.length > 0
    || !!profile.tone
    || !!profile.note
  );
  const seed = `${today}:${chatType}:${chatId}:${userId}:personal`;
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const priority = runs.find((item) => item.passed === 0) || null;
  const focusMap = profile?.favoriteMaps[0] || pick(['Mirage', 'Inferno', 'Nuke', 'Ancient'], `${seed}:fallback-map`);
  const focusPlayer = profile?.favoritePlayers[0] || '你想学的选手';
  const focusTeam = profile?.favoriteTeams[0] || '你顺眼的队伍';
  const name = profile?.displayName || `QQ${userId}`;
  const opener = hasProfile
    ? pick([
      '今天按你的偏好来，不装陌生人，但事实还是看证据。',
      '画像我记着，今天给你压成能直接用的短路线。',
      '先照你的口味排一版，别把偏好当实时情报就行。',
      '今天不撒网，按你常看的东西给入口。',
    ], `${seed}:opener-profiled`)
    : pick([
      '你还没填画像，我先给通用版；想让我更像认识你，就补几条偏好。',
      '当前会话没你的偏好，我先不瞎猜，给你一张可配置版。',
      '还没有画像，今天先按通用路线走；填完以后这张卡会更贴你。',
      '我不硬装熟，画像没填就先给默认打法。',
    ], `${seed}:opener-empty`);
  const profileLine = hasProfile
    ? [
      profile.favoriteTeams.length ? `偏好队伍: ${profile.favoriteTeams.join(' / ')}` : '',
      profile.favoritePlayers.length ? `偏好选手: ${profile.favoritePlayers.join(' / ')}` : '',
      profile.favoriteMaps.length ? `偏好地图: ${profile.favoriteMaps.join(' / ')}` : '',
      profile.tone ? `语气: ${profile.tone}` : '',
      profile.note ? `备注: ${profile.note}` : '',
    ].filter(Boolean).join('；')
    : '未设置；可用 /profile set map Inferno、/profile set team Vitality/NAVI、/profile set tone 短句一点。';
  const practice = profile?.favoriteMaps.length
    ? `${focusMap}: 只盯一个道具 timing 或一个死亡回合，别一口气复盘整张图。`
    : '先选一张你常打的图填进 /profile set map，之后每日建议会贴着那张图走。';
  const playerHook = profile?.favoritePlayers.length
    ? `参考 ${focusPlayer} 的一个处理习惯，但只当打法参照，不代表他今天状态。`
    : '想让建议更贴手感，可以 /profile set player donk/ZywOo/NiKo。';
  const teamHook = profile?.favoriteTeams.length
    ? `${focusTeam} 只当情绪锚点；问阵容、排名、赛程仍要 /cs verify。`
    : '队伍偏好没填，我不会替你猜主队；想要情绪锚点就 /profile set team 队名。';
  const toneHook = profile?.tone
    ? `按“${profile.tone}”收着说：先接住人，再给一个命令入口。`
    : '语气先走短句松一点；想固定口吻可用 /profile set tone。';
  const imageHook = profile?.favoriteMaps.length
    ? `发一张 ${focusMap} 相关截图，问“这张按可见信息先看哪里”。`
    : '发图问“帮我看图，先说可见信息”，我不会猜图外剧情。';
  const voiceLine = pick([
    `今天先稳住，按 ${focusMap} 的节奏来。`,
    `别急，先把 ${focusMap} 的信息补齐。`,
    `少讲玄学，先看 ${focusMap} 这波证据。`,
    `先别嘴硬，照 ${focusPlayer} 的纪律打一回合。`,
  ], `${seed}:voice`);
  const mediaPriority = priority
    ? `${priority.label}: ${priority.action}`
    : '三件套已有成功 trace；别重复刷同一条，晚上 /daily recap 收尾。';
  const dailyNext = challengedToday && checkedToday
    ? '挑战和打卡已双收，今天把偏好卡用于识图语音或复盘就行。'
    : challengedToday
      ? '挑战已完成，还差打卡；跑完偏好小任务后说“今日打卡”。'
      : checkedToday
        ? '打卡已到，还差挑战；先 /daily challenge，再按偏好做一小步。'
        : '两项都空；先 /daily challenge，做完说“今日收工”一次收住。';

  return [
    `每日偏好卡 | ${parts.label}`,
    '模式: 只读画像卡，不写挑战/打卡，不改画像，不调用模型，不下载图片，不生成音频',
    `${name}(${userId}): ${opener}`,
    `画像偏好: ${profileLine}`,
    `今日打法: ${practice}`,
    `选手参照: ${playerHook}`,
    `队伍边界: ${teamHook}`,
    `聊天口吻: ${toneHook}`,
    `看图引子: ${imageHook}`,
    `语音短句: ${voiceLine}`,
    `多模态: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}；优先补: ${mediaPriority}`,
    `日常收尾: ${dailyNext}`,
    '入口: /profile / /daily vibe / /daily relay / /daily score / /daily media / /media daily',
    '画像边界: 这里只使用你在当前会话自填的偏好来个性化建议；偏好不是实时赛事事实，阵容/排名/赛果/赛程仍要 fresh 证据和 /cs verify。多模态是否真跑以 trace 为准。',
  ].join('\n');
}

export function formatDailyEvidenceLedger(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const profile = getUserProfile(chatType, chatId, userId);
  const hasProfile = !!profile && (
    profile.favoriteTeams.length > 0
    || profile.favoritePlayers.length > 0
    || profile.favoriteMaps.length > 0
    || !!profile.tone
    || !!profile.note
  );
  const media = (() => {
    try {
      return getMediaObservabilitySnapshot();
    } catch {
      return null;
    }
  })();
  const runs = parseDailyMediaRunCounts(media?.todayRuns || '');
  const runLine = (label: string, command: string): string => {
    const run = runs.find((item) => item.label === label);
    if (!run) return `${label}: 未证明；缺少今日统计，先看 /media daily`;
    if (run.passed > 0) return `${label}: 可证明；今日成功 ${run.passed}/${run.attempts}，最近记录看 ${command}`;
    return `${label}: 未证明；${run.attempts > 0 ? `已试 ${run.attempts} 次但无成功 trace` : '今天没有成功 trace'}，取证 ${run.action}`;
  };
  const provenCount = [
    challengedToday,
    checkedToday,
    runs.some((item) => item.label === '识图' && item.passed > 0),
    runs.some((item) => item.label === '听写' && item.passed > 0),
    runs.some((item) => item.label === '发语音' && item.passed > 0),
  ].filter(Boolean).length;
  const missing = [
    challengedToday ? '' : '挑战完成记录',
    checkedToday ? '' : '每日打卡记录',
    ...runs.filter((item) => item.passed === 0).map((item) => `${item.label}成功 trace`),
  ].filter(Boolean);
  const next = !challengedToday
    ? '/daily challenge，看完做完说“挑战完成”'
    : !checkedToday
      ? '说“今日打卡”，或用 /daily checkin'
      : (runs.find((item) => item.passed === 0)?.action || '/daily recap 收尾；要排障看 /media recent 3');
  const profileLine = hasProfile
    ? `可引用；当前会话自填画像 ${[
      profile.favoriteMaps.length ? `地图=${profile.favoriteMaps.join('/')}` : '',
      profile.favoriteTeams.length ? `队伍=${profile.favoriteTeams.join('/')}` : '',
      profile.favoritePlayers.length ? `选手=${profile.favoritePlayers.join('/')}` : '',
      profile.tone ? '语气=已设' : '',
      profile.note ? '备注=已设' : '',
    ].filter(Boolean).join('，')}`
    : '未设置；不能假装熟悉偏好，可用 /profile set map Inferno 或 /profile set tone 短句一点';

  return [
    `今日证据账本 | ${parts.label}`,
    '模式: 只读证据卡，不写挑战/打卡，不改画像，不下载图片，不听写语音，不调用模型，不生成音频',
    `QQ${userId}: 已证明 ${provenCount}/5；缺口 ${missing.length ? missing.join('、') : '无'}`,
    `挑战: ${challengedToday ? `可证明；date=${challenge?.lastDoneDate} 连续${challenge?.streak || 0}天 累计${challenge?.total || 0}次` : '未证明；今天没有挑战完成记录'}`,
    `打卡: ${checkedToday ? `可证明；date=${checkin?.lastCheckinDate} 连续${checkin?.streak || 0}天 累计${checkin?.total || 0}次` : '未证明；今天没有每日打卡记录'}`,
    `画像: ${profileLine}`,
    `今日实跑: ${media?.todayRuns || '读取不到多模态摘要；看 /media daily'}`,
    runLine('识图', '/vision last 或 /vision recent 3'),
    runLine('听写', '/voice recent 3'),
    runLine('发语音', '/voice recent 3'),
    `最近识图: ${media?.lastVisionSummary || '无真实图片回复 trace'}`,
    `最近听写: ${media?.lastRecordSummary || '无真实听写 trace'}`,
    `最近发声: ${media?.lastVoiceSummary || '无真实语音发送 trace'}`,
    `现在取证: ${next}`,
    '不能证明: /voice check、/voice warm、/vision check、缓存 hit、画像偏好、聊天建议、脚本卡和口头说过都不等于今天真的看图/听写/发语音。',
    '入口: /daily score / /daily gap / /media daily / /media recent 3 / /vision last / /voice recent 3 / /trace last',
    '边界: 这张账本只读本地每日记录、自填画像和真实多模态 trace；没出现在记录里的输入不能说成已完成，画像也不能当实时赛事事实。',
  ].join('\n');
}

export function formatDailyCommandCenter(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const today = parts.dateKey;
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkedToday = checkin?.lastCheckinDate === today;
  const challengedToday = challenge?.lastDoneDate === today;
  const checkinRows = store.checkins.filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0);
  const challengeRows = store.challengeCompletions.filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0);
  const todayCheckins = checkinRows.filter((item) => item.lastCheckinDate === today);
  const todayChallenges = challengeRows.filter((item) => item.lastDoneDate === today);
  const userIds = new Set<number>([
    ...checkinRows.map((item) => item.userId),
    ...challengeRows.map((item) => item.userId),
  ]);
  const todayDoubleCount = Array.from(userIds).filter((id) => (
    todayCheckins.some((item) => item.userId === id)
    && todayChallenges.some((item) => item.userId === id)
  )).length;
  const seed = `${today}:${chatType}:${chatId}:${userId}:center`;
  const opener = pick([
    '别翻一堆菜单，今天就按这一屏走。',
    '给你压成一张短卡，先动手，再嘴硬。',
    '今天别散着点命令，先把主线跑完。',
    '一屏够了，剩下都是执行问题。',
  ], `${seed}:opener`);
  const nowAction = challengedToday && checkedToday
    ? '/daily script 跑识图语音三件套，晚上 /daily recap 收尾'
    : challengedToday
      ? '顺手说“今日打卡”，再 /daily script 跑识图语音'
      : checkedToday
        ? '/daily challenge 看任务，做完说“挑战完成”'
        : '先 /daily challenge，看完做完可以说“今日收工”一次收两项';
  const groupAction = todayChallenges.length === 0 && todayCheckins.length === 0
    ? '/daily ice 丢一个今日话题，把群先叫醒'
    : todayDoubleCount === 0
      ? '有人动了但没双收，喊“今日收工”把队形补齐'
      : '/daily squad 看队形，缺谁就轻轻催一下';
  const mediaAction = pick([
    '/daily script 直接照着跑看图、听写、发语音、验收',
    '/daily media 取陪跑卡，先短测再真测',
    '/media daily 看今日缺口，缺哪条就真测哪条',
    '发图问“帮我看图”，再用 /voice stt 真听一条语音',
  ], `${seed}:media`);
  const useful = pick([
    '/csquiz 来一题，答错也算热手',
    '/cstrain 排一组短训练，练完补 /cstrain log',
    '/csreport focus 看一屏今日看点，有 fresh 证据再报死',
    '/daily ice 丢个能让群友顺手接的话题',
  ], `${seed}:useful`);
  const close = challengedToday && checkedToday
    ? '晚上 /daily recap；如果链路跑过了，再看 /media daily 确认 trace。'
    : '做完缺项后说“今日收工”；睡前 /daily recap。';

  return [
    `今日指挥台 | ${parts.label}`,
    '模式: 只读一屏，不写挑战/打卡，不下载图片，不听写语音，不调用模型',
    `QQ${userId}: ${opener}`,
    `你: 挑战${challengedToday ? '已完成' : '未完成'} / 打卡${checkedToday ? '已到' : '未打'}`,
    `当前${chatType === 'group' ? '群' : '会话'}: 今日挑战${todayChallenges.length}人 / 今日打卡${todayCheckins.length}人 / 双收${todayDoubleCount}人`,
    `现在先做: ${nowAction}`,
    `群里带一下: ${groupAction}`,
    `识图语音: ${formatMediaDailyShortStatus()}；脚本: ${mediaAction}`,
    `好玩/有用: ${useful}`,
    `收尾: ${close}`,
    '入口: /daily me / /daily squad / /daily script / /daily media / /daily guard / /daily recap',
    '边界: 这是本地每日记录和多模态 trace 摘要的一屏导航；不会替你写记录，也不会假装看过图、听过语音或发过语音。',
  ].join('\n');
}

export function formatDailyWeekSummary(
  chatType: DailyPulseChatType,
  chatId: number,
  userId: number,
  date: Date = new Date(),
): string {
  const parts = formatShanghaiParts(date);
  const store = loadStore();
  const checkin = store.checkins.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const challenge = store.challengeCompletions.find((item) => item.chatType === chatType && item.chatId === chatId && item.userId === userId) || null;
  const checkinDates = new Set(checkin?.dates || []);
  const challengeDates = new Set(challenge?.dates || []);
  const days = Array.from({ length: 7 }, (_item, index) => shanghaiDateKeyOffset(date, index - 6));
  const rows = days.map((dateKey) => {
    const didCheckin = checkinDates.has(dateKey);
    const didChallenge = challengeDates.has(dateKey);
    const state = didCheckin && didChallenge
      ? '双收'
      : didChallenge
        ? '挑战'
        : didCheckin
          ? '打卡'
          : '空';
    return `${dateKey.slice(5)} ${state}`;
  });
  const checkinDays = days.filter((dateKey) => checkinDates.has(dateKey)).length;
  const challengeDays = days.filter((dateKey) => challengeDates.has(dateKey)).length;
  const fullDays = days.filter((dateKey) => checkinDates.has(dateKey) && challengeDates.has(dateKey)).length;
  const rhythm = fullDays >= 5
    ? '这周很稳，别因为顺了就把复盘省了。'
    : fullDays >= 3
      ? '节奏不错，差的是把零散完成变成固定习惯。'
      : challengeDays > checkinDays
        ? '挑战做得比打卡多，说明有动作，但出勤别漏记。'
        : checkinDays > challengeDays
          ? '人是来了，挑战少了点，今天别只签到就下线。'
          : fullDays > 0
            ? '有开头了，接下来先保连续，再谈强度。'
            : '这周还没真正跑起来，先用“今日收工”捡一个双收。';
  const today = days[days.length - 1];
  const todayDone = checkinDates.has(today) && challengeDates.has(today);
  const mediaStatus = formatMediaDailyShortStatus();
  const next = todayDone
    ? '今天已经双收，晚上 /daily recap 收尾就行。'
    : checkinDates.has(today)
      ? '今天打卡有了，还差挑战完成；做完说“挑战完成”。'
      : challengeDates.has(today)
        ? '今天挑战有了，还差打卡；顺手说“今日打卡”。'
        : '今天还没收，直接说“今日收工”可以一次记两项。';

  return [
    `我的每日周报 | ${parts.label}`,
    `QQ${userId} 最近7天: 双收${fullDays}/7 挑战${challengeDays}/7 打卡${checkinDays}/7`,
    `本周节奏: ${rhythm}`,
    `连续: 挑战${challenge?.streak || 0}天 / 打卡${checkin?.streak || 0}天`,
    `识图语音: ${mediaStatus}`,
    `日历: ${rows.join('；')}`,
    `下一步: ${next}`,
    '入口: /daily me / /daily wrap / /daily media / /media daily / /daily challenge board / /daily board',
    '边界: 这里只读本地每日记录；旧记录只按已有连续天数回填，不能当完整历史流水。',
  ].join('\n');
}

function upsertSubscription(
  chatType: DailyPulseChatType,
  chatId: number,
  groupId: number | undefined,
  userId: number,
  time: string,
): string {
  const normalized = normalizePulseTime(time) || DEFAULT_PULSE_TIME;
  const store = loadStore();
  const id = subscriptionId(chatType, chatId);
  const now = Date.now();
  let sub = store.subscriptions.find((item) => item.id === id);
  if (!sub) {
    sub = {
      id,
      chatType,
      chatId,
      groupId,
      userId,
      time: normalized,
      timezone: PULSE_TIMEZONE,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastSentDate: '',
      lastSentAt: 0,
      lastError: '',
    };
    store.subscriptions.push(sub);
  }
  sub.chatType = chatType;
  sub.chatId = chatId;
  sub.groupId = groupId;
  sub.userId = userId;
  sub.time = normalized;
  sub.timezone = PULSE_TIMEZONE;
  sub.enabled = true;
  sub.updatedAt = now;
  saveStore(store);
  return `每日提醒已开启：每天 ${normalized} 推送到当前${chatType === 'group' ? '群' : '私聊'}。\n查看: /daily status；关闭: /daily off。`;
}

function removeSubscription(chatType: DailyPulseChatType, chatId: number): string {
  const store = loadStore();
  const id = subscriptionId(chatType, chatId);
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((item) => item.id !== id);
  saveStore(store);
  return before === store.subscriptions.length
    ? '当前会话没有开启每日提醒。'
    : '每日提醒已关闭。';
}

function formatCurrentSubscription(chatType: DailyPulseChatType, chatId: number): string {
  const store = loadStore();
  const sub = store.subscriptions.find((item) => item.id === subscriptionId(chatType, chatId));
  const stats = getDailyPulseStats();
  const myCheckinCount = store.checkins.filter((item) => item.chatType === chatType && item.chatId === chatId).length;
  const myChallengeCount = store.challengeCompletions.filter((item) => item.chatType === chatType && item.chatId === chatId).length;
  const current = sub
    ? `当前会话: ${sub.enabled ? '已开启' : '已关闭'} ${sub.time}，最近推送 ${sub.lastSentAt ? new Date(sub.lastSentAt).toLocaleString('zh-CN', { timeZone: PULSE_TIMEZONE, hour12: false }) : '无'}${sub.lastError ? `，错误 ${sub.lastError}` : ''}`
    : '当前会话: 未开启';
  return [
    '每日提醒状态',
    current,
    `当前会话打卡: ${myCheckinCount}人；全局打卡${stats.checkins}人 今日${stats.todayCheckins}人 最佳连续${stats.bestStreak}天`,
    `当前会话挑战完成: ${myChallengeCount}人；全局完成${stats.challengeCompletions}人 今日${stats.todayChallengeCompletions}人 最佳连续${stats.bestChallengeStreak}天`,
    `全局: ${stats.subscriptions}个 群${stats.groupChats} 私聊${stats.privateChats} timer=${stats.timerEnabled ? 'on' : 'off'} running=${stats.running}`,
    `最近检查: ${stats.lastRunAt ? new Date(stats.lastRunAt).toLocaleString('zh-CN', { timeZone: PULSE_TIMEZONE, hour12: false }) : '无'} 检查${stats.lastRunChecked} 推送${stats.lastRunSent}`,
    stats.lastRunError ? `最近错误: ${stats.lastRunError}` : '',
    '立即看: /daily now；偏好: /daily personal；证据: /daily proof；人话: /daily reply；闭环分: /daily score；指挥台: /daily center；聊天节奏: /daily vibe；接力: /daily relay；语音台词: /daily line；补缺: /daily gap；队形: /daily squad；破冰: /daily ice；脚本: /daily script；安排: /daily plan；保连续: /daily guard；陪跑: /daily media；催一下: /daily nudge；挑战: /daily challenge；完成: /daily done；打卡: /daily checkin；三件套: /media daily；开启: /daily on 09:00；改时间: /daily time 08:30；关闭: /daily off。',
  ].filter(Boolean).join('\n');
}

function parseNaturalDailyPulse(text: string): { action: 'now' | 'recap' | 'challenge' | 'done' | 'checkin' | 'wrap' | 'board' | 'challenge_board' | 'me' | 'personal' | 'proof' | 'reply' | 'score' | 'center' | 'squad' | 'ice' | 'script' | 'gap' | 'voice_line' | 'relay' | 'vibe' | 'plan' | 'nudge' | 'guard' | 'media' | 'week' | 'on' | 'off'; time?: string } | null {
  const raw = (text || '').trim();
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return null;
  const topic = /(?:每日提醒|每日问候|日签|早安机器|今日状态|今日提醒|每日状态)/;
  const recapTopic = /(?:晚间复盘|今日复盘|今天复盘|睡前复盘|复盘提醒|机器晚安|晚安机器)/;
  const challengeTopic = /^(?:今日挑战|今天挑战|每日挑战|今日任务|今天任务|每日任务|今日小任务|今天小任务|来个挑战|来个今日挑战|来个每日挑战|来个今日任务|给我今日挑战|给我来个今日任务)$/;
  const doneTopic = /^(?:挑战完成|今日挑战完成|今天挑战完成|每日挑战完成|任务完成|今日任务完成|今天任务完成|完成今日挑战|完成今天挑战|完成每日挑战|我做完了|我完成了|做完了)$/;
  const challengeBoardTopic = /^(?:挑战榜|挑战排行|挑战排行榜|今日挑战榜|今天挑战榜|每日挑战榜|任务榜|任务排行|任务排行榜|完成榜|挑战完成榜|今日任务榜)$/;
  const boardTopic = /^(?:打卡榜|打卡排行|打卡排行榜|每日打卡榜|今日打卡榜|今天打卡榜|签到榜|签到排行|连续打卡榜)$/;
  const checkinTopic = /^(?:今日打卡|今天打卡|每日打卡|打卡机器|机器打卡|我来打卡|来打卡|今日签到|今天签到|每日签到|签到)$/;
  const wrapTopic = /^(?:今日收工|今天收工|每日收工|收工打卡|收工签到|今日收工打卡|今天收工打卡|挑战完成打卡|任务完成打卡|完成并打卡|做完并打卡)$/;
  const meTopic = /^(?:我的每日|我的日签|我的每日状态|我的打卡|我的挑战|我今天做了吗|我今天打卡了吗|我今天挑战了吗|今日进度|今天进度|每日进度)$/;
  const personalTopic = /^(?:今日偏好|今天偏好|每日偏好|我的偏好|我的今日偏好|今日个性卡|今天个性卡|每日个性卡|个人偏好|我的画像|今日画像|今天画像|每日画像|机器记得我啥|机器记得我什么|按我偏好安排|按我的偏好安排)$/;
  const proofTopic = /^(?:今日证据|今天证据|每日证据|今日证据账本|今天证据账本|每日证据账本|今日证明|今天证明|每日证明|今日记录账本|今天记录账本|今日真实记录|今天真实记录|今天哪些是真的|今日哪些是真的|今天跑没跑|今日跑没跑|证据账本)$/;
  const replyTopic = /^(?:今日人话|今天人话|每日人话|今日接话包|今天接话包|每日接话包|今日短回复|今天短回复|每日短回复|人话包|接话包|来点人话|来句人话|给我人话|机器怎么回|群里怎么回)$/;
  const scoreTopic = /^(?:今日闭环分|今天闭环分|每日闭环分|今日闭环|今天闭环|每日闭环|今日完成度|今天完成度|每日完成度|今日分数|今天分数|每日分数|闭环分|完成度|闭环评分|今日评分|今天评分)$/;
  const centerTopic = /^(?:今日指挥台|今天指挥台|每日指挥台|今日看板|今天看板|每日看板|今日总览|今天总览|每日总览|今日一屏|今天一屏|一屏今日|一屏每日|今天怎么搞|今日怎么搞|今天怎么安排|今天先看啥|今天先看什么)$/;
  const squadTopic = /^(?:今日队形|今天队形|每日队形|群每日|群每日状态|群每日队形|今日小队|今天小队|每日小队|今日群状态|今天群状态|群状态|群里每日)$/;
  const iceTopic = /^(?:今日话题|今天话题|每日话题|群话题|今日破冰|今天破冰|每日破冰|群破冰|来点话题|来个话题|来点整活|来个整活|群里聊啥|今天聊啥|今日聊啥|破冰一下)$/;
  const scriptTopic = /^(?:识图语音脚本|识图语音脚本包|今日识图语音脚本|今天识图语音脚本|每日识图语音脚本|多模态脚本|今日多模态脚本|三件套脚本|今日三件套脚本|语音识图脚本|给我脚本包|来个脚本包)$/;
  const gapTopic = /^(?:识图语音缺啥|识图语音缺什么|今日识图语音缺啥|今日三件套缺啥|今天三件套缺啥|三件套缺啥|多模态缺啥|多模态补缺|今日补缺|今天补缺|识图语音补缺|语音识图补缺)$/;
  const voiceLineTopic = /^(?:今日语音台词|今天语音台词|每日语音台词|今日语音句|今天语音句|每日语音句|今日发声台词|今天发声台词|语音台词|语音短句|今日短句|今天短句|今天念啥|今日念啥|来句语音台词|给我语音台词)$/;
  const relayTopic = /^(?:今日接力|今天接力|每日接力|群接力|群里接力|识图语音接力|今日识图语音接力|今天识图语音接力|多模态接力|今日多模态接力|三件套接力|今日三件套接力|看图语音接力|语音识图接力|来个接力|开个接力)$/;
  const vibeTopic = /^(?:今日聊天节奏|今天聊天节奏|每日聊天节奏|今日聊天状态|今天聊天状态|今日语气|今天语气|每日语气|今日语感|今天语感|今日人味|今天人味|真人感|今天怎么聊|今日怎么聊|今天怎么接话|今日怎么接话|聊天节奏|聊天状态|群里怎么聊|机器今天怎么聊)$/;
  const planTopic = /^(?:今日安排|今天安排|每日安排|今日计划|今天计划|每日计划|今日路线|今天路线|今天先干啥|今天先干什么|今日先干啥|今日先干什么|机器安排一下|给我今日安排|给我今天安排)$/;
  const guardTopic = /^(?:保连续|保一下连续|每日保连续|今日保连续|今天保连续|别断签|别让我断签|别断打卡|别让我断打卡|别断挑战|保打卡|保挑战|护连续|护一下连续|续一下|续命一下|连续别断)$/;
  const nudgeTopic = /^(?:催我一下|催一下我|机器催一下|机器催我|今日催我|今天催我|每日催我|催我打卡|催我挑战|提醒我打卡|提醒我挑战|提醒我每日|别让我断签|别让我断打卡|推我一下|我今天还差啥|我今天还差什么|今天还差啥|今天还差什么|今日还差啥|今日还差什么|我今天缺啥|我今天缺什么|今天缺啥|今天缺什么|今日缺啥|今日缺什么|每日还差啥|每日缺啥)$/;
  const mediaTopic = /^(?:识图语音陪跑|今日识图语音陪跑|今天识图语音陪跑|每日识图语音|今日语音句|今天语音句|每日语音句|今日语音任务|今天语音任务|语音陪跑|多模态陪跑|机器陪我跑一下|陪我跑一下)$/;
  const weekTopic = /^(?:本周每日|这周每日|每日周报|我的周报|本周打卡|本周挑战|这周打卡|这周挑战|本周收工|这周收工|周报机器)$/;
  if (/(?:订阅|开启|打开|安排).*(?:每日提醒|每日问候|日签|早安|问候|提醒)/.test(compact)) {
    const time = normalizePulseTime((raw.match(/(\d{1,2}[:：]?\d{2})/) || [])[1]) || DEFAULT_PULSE_TIME;
    return { action: 'on', time };
  }
  if (/(?:取消|关闭|停掉).*(?:每日提醒|每日问候|日签|早安|问候|提醒)/.test(compact)) {
    return { action: 'off' };
  }
  if (recapTopic.test(compact)) {
    return { action: 'recap' };
  }
  if (challengeTopic.test(compact)) {
    return { action: 'challenge' };
  }
  if (doneTopic.test(compact)) {
    return { action: 'done' };
  }
  if (challengeBoardTopic.test(compact)) {
    return { action: 'challenge_board' };
  }
  if (boardTopic.test(compact)) {
    return { action: 'board' };
  }
  if (checkinTopic.test(compact)) {
    return { action: 'checkin' };
  }
  if (wrapTopic.test(compact)) {
    return { action: 'wrap' };
  }
  if (meTopic.test(compact)) {
    return { action: 'me' };
  }
  if (personalTopic.test(compact)) {
    return { action: 'personal' };
  }
  if (proofTopic.test(compact)) {
    return { action: 'proof' };
  }
  if (replyTopic.test(compact)) {
    return { action: 'reply' };
  }
  if (scoreTopic.test(compact)) {
    return { action: 'score' };
  }
  if (centerTopic.test(compact)) {
    return { action: 'center' };
  }
  if (squadTopic.test(compact)) {
    return { action: 'squad' };
  }
  if (iceTopic.test(compact)) {
    return { action: 'ice' };
  }
  if (scriptTopic.test(compact)) {
    return { action: 'script' };
  }
  if (gapTopic.test(compact)) {
    return { action: 'gap' };
  }
  if (voiceLineTopic.test(compact)) {
    return { action: 'voice_line' };
  }
  if (relayTopic.test(compact)) {
    return { action: 'relay' };
  }
  if (vibeTopic.test(compact)) {
    return { action: 'vibe' };
  }
  if (planTopic.test(compact)) {
    return { action: 'plan' };
  }
  if (guardTopic.test(compact)) {
    return { action: 'guard' };
  }
  if (nudgeTopic.test(compact)) {
    return { action: 'nudge' };
  }
  if (mediaTopic.test(compact)) {
    return { action: 'media' };
  }
  if (weekTopic.test(compact)) {
    return { action: 'week' };
  }
  if (topic.test(compact) || /^(?:机器早安|早安机器|早上好机器|今日状态|今天状态)$/.test(compact)) {
    return { action: 'now' };
  }
  return null;
}

async function sendPulse(bot: DailyPulseBot, sub: DailyPulseSubscription, message: string): Promise<boolean> {
  if (sub.chatType === 'group' && bot.sendGroupMessage) {
    return bot.sendGroupMessage(sub.groupId || sub.chatId, message);
  }
  if (sub.chatType === 'private' && bot.sendPrivateMessage) {
    return bot.sendPrivateMessage(sub.chatId, message);
  }
  return false;
}

export async function runDueDailyPulses(
  bot: DailyPulseBot,
  date: Date = new Date(),
): Promise<{ checked: number; due: number; sent: number; errors: number }> {
  if (pulseRunning) return { checked: 0, due: 0, sent: 0, errors: 0 };
  pulseRunning = true;
  lastRunAt = Date.now();
  lastRunError = '';
  try {
    const store = loadStore();
    const dueSubs = store.subscriptions.filter((item) => isDue(item, date));
    const dateKey = formatShanghaiParts(date).dateKey;
    let sent = 0;
    let errors = 0;

    for (const sub of dueSubs) {
      try {
        const message = buildDailyPulseMessage(sub.chatType, sub.chatId, date);
        const ok = await sendPulse(bot, sub, message);
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
    return { checked: store.subscriptions.length, due: dueSubs.length, sent, errors };
  } catch (err) {
    lastRunError = err instanceof Error ? err.message : String(err);
    return { checked: 0, due: 0, sent: 0, errors: 1 };
  } finally {
    pulseRunning = false;
  }
}

export function startDailyPulseTasks(bot: DailyPulseBot, intervalSeconds: number = DEFAULT_CHECK_INTERVAL_SECONDS): void {
  shutdownDailyPulseTasks();
  const intervalMs = Math.max(30, intervalSeconds) * 1000;
  pulseTimer = setInterval(() => {
    void runDueDailyPulses(bot);
  }, intervalMs);
  pulseTimer.unref();
}

export function shutdownDailyPulseTasks(): void {
  if (!pulseTimer) return;
  clearInterval(pulseTimer);
  pulseTimer = null;
}

export function getDailyPulseStats(): {
  subscriptions: number;
  groupChats: number;
  privateChats: number;
  checkins: number;
  todayCheckins: number;
  challengeCompletions: number;
  todayChallengeCompletions: number;
  bestChallengeStreak: number;
  bestStreak: number;
  running: boolean;
  timerEnabled: boolean;
  lastRunAt: number;
  lastRunChecked: number;
  lastRunSent: number;
  lastRunError: string;
} {
  const store = loadStore();
  const enabled = store.subscriptions.filter((item) => item.enabled);
  const today = formatShanghaiParts(new Date()).dateKey;
  return {
    subscriptions: enabled.length,
    groupChats: new Set(enabled.filter((item) => item.chatType === 'group').map((item) => item.chatId)).size,
    privateChats: new Set(enabled.filter((item) => item.chatType === 'private').map((item) => item.chatId)).size,
    checkins: store.checkins.length,
    todayCheckins: store.checkins.filter((item) => item.lastCheckinDate === today).length,
    challengeCompletions: store.challengeCompletions.length,
    todayChallengeCompletions: store.challengeCompletions.filter((item) => item.lastDoneDate === today).length,
    bestChallengeStreak: store.challengeCompletions.reduce((max, item) => Math.max(max, item.bestStreak || item.streak || 0), 0),
    bestStreak: store.checkins.reduce((max, item) => Math.max(max, item.bestStreak || item.streak || 0), 0),
    running: pulseRunning,
    timerEnabled: !!pulseTimer,
    lastRunAt,
    lastRunChecked,
    lastRunSent,
    lastRunError,
  };
}

export const dailyPulsePlugin: Plugin = {
  name: 'daily-pulse',
  description: '每日提醒 - 低频自然问候和今日状态',
  handler: async (ctx) => {
    const natural = ctx.command ? null : parseNaturalDailyPulse(ctx.rawText);
    const isCommand = ['daily', 'day', 'pulse', 'morning', '日签', '每日', '每日提醒', '今日状态', '早安'].includes(ctx.command || '');
    if (!isCommand && !natural) return false;

    if (natural) {
      if (natural.action === 'on') {
        ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, natural.time || DEFAULT_PULSE_TIME));
        return true;
      }
      if (natural.action === 'off') {
        ctx.reply(removeSubscription(ctx.chatType, ctx.chatId));
        return true;
      }
      if (natural.action === 'recap') {
        ctx.reply(buildDailyRecapMessage(ctx.chatType, ctx.chatId, new Date(), ctx.event.user_id));
        return true;
      }
      if (natural.action === 'challenge') {
        ctx.reply(buildDailyChallengeMessage(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'done') {
        ctx.reply(recordDailyChallengeDone(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'checkin') {
        ctx.reply(recordDailyCheckin(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'wrap') {
        ctx.reply(recordDailyWrapUp(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'challenge_board') {
        ctx.reply(formatDailyChallengeBoard(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'board') {
        ctx.reply(formatDailyCheckinBoard(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'me') {
        ctx.reply(formatDailyUserSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'personal') {
        ctx.reply(formatDailyPersonalizedBrief(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'proof') {
        ctx.reply(formatDailyEvidenceLedger(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'reply') {
        ctx.reply(formatDailyHumanReplyPack(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'score') {
        ctx.reply(formatDailyCompletionScore(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'center') {
        ctx.reply(formatDailyCommandCenter(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'squad') {
        ctx.reply(formatDailySquadSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'ice') {
        ctx.reply(formatDailyIcebreaker(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'script') {
        ctx.reply(formatDailyMediaScript(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'gap') {
        ctx.reply(formatDailyMediaGap(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'voice_line') {
        ctx.reply(formatDailyVoiceLineKit(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'relay') {
        ctx.reply(formatDailyMediaRelay(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'vibe') {
        ctx.reply(formatDailyChatVibe(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'plan') {
        ctx.reply(formatDailyActionPlan(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'nudge') {
        ctx.reply(formatDailyNudge(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'guard') {
        ctx.reply(formatDailyStreakGuard(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'media') {
        ctx.reply(formatDailyMediaCompanion(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (natural.action === 'week') {
        ctx.reply(formatDailyWeekSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      ctx.reply(buildDailyPulseMessage(ctx.chatType, ctx.chatId));
      return true;
    }

    const sub = (ctx.args[0] || 'now').toLowerCase();
    if (['now', 'today', 'card', 'run', 'show', '今日', '现在', '状态'].includes(sub)) {
      ctx.reply(buildDailyPulseMessage(ctx.chatType, ctx.chatId));
      return true;
    }

    if (['me', 'mine', 'my', 'self', 'progress', '进度', '我的', '我的每日', '我的打卡', '我的挑战'].includes(sub)) {
      ctx.reply(formatDailyUserSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['personal', 'person', 'profile', 'prefs', 'pref', 'preference', 'preferences', 'persona', 'custom', 'customize', '画像', '偏好', '个人', '个性', '个性化', '今日偏好', '我的偏好', '我的画像', '今日画像'].includes(sub)) {
      ctx.reply(formatDailyPersonalizedBrief(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['proof', 'prove', 'evidence', 'ledger', 'audit', 'truth', 'verify', '证据', '证据账本', '证明', '真实记录', '记录账本', '今日证据', '今日证明', '跑没跑'].includes(sub)) {
      ctx.reply(formatDailyEvidenceLedger(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['reply', 'replies', 'response', 'human-reply', 'talkback', 'short-reply', '人话', '今日人话', '接话', '接话包', '回复', '短回复', '回复包'].includes(sub)) {
      ctx.reply(formatDailyHumanReplyPack(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['score', 'scores', 'closure', 'completion', 'progress-score', 'daily-score', '闭环', '闭环分', '完成度', '今日完成度', '今日闭环', '今日闭环分', '分数', '今日分数', '评分', '今日评分'].includes(sub)) {
      ctx.reply(formatDailyCompletionScore(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['center', 'desk', 'hub', 'dashboard', 'dash', 'brief', 'overview', '指挥台', '看板', '总览', '一屏', '今日指挥台', '今日看板', '今日总览'].includes(sub)) {
      ctx.reply(formatDailyCommandCenter(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['squad', 'group', 'team', 'room', 'crew', '队形', '小队', '群', '群状态', '今日队形', '群每日', '群每日状态', '今日群状态'].includes(sub)) {
      ctx.reply(formatDailySquadSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['ice', 'topic', 'talk', 'break', '破冰', '话题', '群话题', '今日话题', '今日破冰', '整活', '来点整活', '聊啥'].includes(sub)) {
      ctx.reply(formatDailyIcebreaker(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['script', 'kit', 'runbook', 'scripts', '脚本', '脚本包', '三件套脚本', '识图语音脚本', '多模态脚本', '语音识图脚本'].includes(sub)) {
      ctx.reply(formatDailyMediaScript(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['gap', 'gaps', 'missing-media', 'media-gap', 'todo-media', '补缺', '缺口', '三件套缺啥', '识图语音缺啥', '识图语音补缺', '多模态补缺'].includes(sub)) {
      ctx.reply(formatDailyMediaGap(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['line', 'lines', 'voice-line', 'voice-lines', 'voicekit', 'voice-kit', 'sayline', '台词', '语音台词', '今日语音台词', '今日语音句', '语音句', '语音短句', '发声台词', '每日语音台词'].includes(sub)) {
      ctx.reply(formatDailyVoiceLineKit(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['relay', 'chain', 'handoff', 'pass', '接力', '今日接力', '群接力', '识图语音接力', '多模态接力', '三件套接力', '看图语音接力', '语音识图接力'].includes(sub)) {
      ctx.reply(formatDailyMediaRelay(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['vibe', 'chat', 'tone', 'rhythm', 'style', 'human', 'humanize', '聊天', '聊天节奏', '今日聊天', '今日聊天节奏', '今日聊天状态', '语气', '今日语气', '语感', '今日语感', '人味', '今日人味', '真人感'].includes(sub)) {
      ctx.reply(formatDailyChatVibe(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['plan', 'todo', 'route', 'next', '安排', '计划', '路线', '今日安排', '今天安排', '今日计划', '今天计划', '今天先干啥'].includes(sub)) {
      ctx.reply(formatDailyActionPlan(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['nudge', 'push', 'remind', 'missing', 'left', '催', '催我', '提醒', '提醒我', '今日催我', '催我一下', '推我一下', '还差啥', '缺啥', '还差什么', '缺什么'].includes(sub)) {
      ctx.reply(formatDailyNudge(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['guard', 'protect', 'streak', 'safe', 'rescue', '保连续', '护连续', '别断签', '别断打卡', '续一下', '续命'].includes(sub)) {
      ctx.reply(formatDailyStreakGuard(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['media', 'multi', 'multimodal', 'voice', 'vision', 'audio', '三件套', '陪跑', '语音', '识图', '识图语音', '多模态'].includes(sub)) {
      ctx.reply(formatDailyMediaCompanion(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['week', 'weekly', 'report', 'weekreport', 'thisweek', '周报', '本周', '本周每日', '每日周报', '我的周报'].includes(sub)) {
      ctx.reply(formatDailyWeekSummary(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['recap', 'review', 'night', 'evening', '复盘', '晚间', '晚安', '收工'].includes(sub)) {
      ctx.reply(buildDailyRecapMessage(ctx.chatType, ctx.chatId, new Date(), ctx.event.user_id));
      return true;
    }

    if (['challenge', 'task', 'mission', '任务', '挑战', '小任务', '今日挑战', '今日任务'].includes(sub)
      && ['board', 'leaderboard', 'rank', 'ranking', '榜', '排行', '排行榜'].includes((ctx.args[1] || '').toLowerCase())) {
      ctx.reply(formatDailyChallengeBoard(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['challenge', 'task', 'mission', '任务', '挑战', '小任务', '今日挑战', '今日任务'].includes(sub)) {
      ctx.reply(buildDailyChallengeMessage(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['done', 'finish', 'complete', 'completed', '完成', '做完', '挑战完成', '任务完成'].includes(sub)) {
      ctx.reply(recordDailyChallengeDone(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['wrap', 'wrapup', 'doneall', 'finishall', 'all', '收工打卡', '今日收工', '今天收工', '完成打卡'].includes(sub)) {
      ctx.reply(recordDailyWrapUp(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['checkin', 'check-in', 'streak', 'sign', 'signin', '签到', '打卡'].includes(sub)) {
      ctx.reply(recordDailyCheckin(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['board', 'leaderboard', 'rank', 'ranking', 'checkins', '榜', '排行', '打卡榜', '签到榜'].includes(sub)) {
      ctx.reply(formatDailyCheckinBoard(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['challengeboard', 'challenge-board', 'taskboard', 'task-board', '挑战榜', '任务榜', '挑战排行', '任务排行'].includes(sub)) {
      ctx.reply(formatDailyChallengeBoard(ctx.chatType, ctx.chatId, ctx.event.user_id));
      return true;
    }

    if (['on', 'enable', '订阅', '开启'].includes(sub)) {
      const time = normalizePulseTime(ctx.args[1]) || DEFAULT_PULSE_TIME;
      ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, time));
      return true;
    }

    if (['time', 'set', '时间'].includes(sub)) {
      const time = normalizePulseTime(ctx.args[1]);
      if (!time) {
        ctx.reply('用法: /daily time 09:00');
        return true;
      }
      ctx.reply(upsertSubscription(ctx.chatType, ctx.chatId, ctx.groupId, ctx.event.user_id, time));
      return true;
    }

    if (['off', 'disable', '取消', '关闭'].includes(sub)) {
      ctx.reply(removeSubscription(ctx.chatType, ctx.chatId));
      return true;
    }

    if (['status', 'list', '状态'].includes(sub)) {
      ctx.reply(formatCurrentSubscription(ctx.chatType, ctx.chatId));
      return true;
    }

    if (['due', 'tick', 'run-due', '执行检查'].includes(sub)) {
      const config = ctx.bot.getConfig();
      if (!config.admin_qq.includes(ctx.event.user_id)) {
        ctx.replyAt('这个得管理员来手动跑。');
        return true;
      }
      const result = await runDueDailyPulses(ctx.bot);
      ctx.reply(`每日提醒检查完成: 检查${result.checked} 到期${result.due} 推送${result.sent} 错误${result.errors}`);
      return true;
    }

    ctx.reply([
      '每日提醒用法:',
      '/daily - 立即看今日状态',
      '/daily recap - 晚间复盘卡，收尾个人挑战/打卡和识图语音真实链路',
      '/daily challenge - 今日挑战卡，给一个低成本可执行任务',
      '/daily done - 记录今日挑战完成，统计连续完成天数',
      '/daily wrap - 今日收工，一次记录挑战完成和打卡',
      '/daily checkin - 每日打卡，记录连续天数和累计次数',
      '/daily board - 查看当前会话打卡榜',
      '/daily challenge board - 查看当前会话挑战完成榜',
      '/daily me - 查看自己的打卡、挑战完成和下一步',
      '/daily personal - 每日偏好卡，按当前会话自填画像给今日打法、聊天口吻、看图引子和语音短句',
      '/daily proof - 今日证据账本，区分挑战/打卡/识图/听写/发语音哪些有真实记录，哪些只是建议',
      '/daily reply - 每日人话接话包，给开场、接图、接语音、催补和收住短句',
      '/daily score - 今日闭环分，把挑战、打卡、识图、听写、发语音合成 100 分完成度',
      '/daily center|desk - 今日指挥台，一屏看个人缺项、群队形、识图语音脚本和收尾',
      '/daily squad|group - 查看当前群/会话每日队形，汇总今日挑战、打卡、双收和你的缺项',
      '/daily vibe - 每日聊天节奏，给开场、接图、接语音、贴纸分寸和收住规则',
      '/daily ice|topic - 今日破冰话题，给群聊选择题、看图接力和语音接力',
      '/daily script|kit - 识图语音每日脚本包，给看图、听写、发语音和验收命令',
      '/daily gap - 识图语音今日补缺，按真实 trace 告诉你三件套缺哪条',
      '/daily line - 每日语音台词，只读给主句、短回声、预检、预热和真测命令',
      '/daily relay - 识图语音每日接力，给群里分看图位、听写位、发声位和验收位',
      '/daily plan - 今日行动安排，串起挑战、打卡、识图语音三件套和收尾',
      '/daily guard|streak - 保连续短催卡，告诉你现在补挑战、打卡还是识图语音',
      '/daily media|voice - 识图语音今日陪跑，给看图问法、听写真测和语音短句',
      '/daily nudge - 催一下今天缺的挑战或打卡；也可 /daily missing，不写记录',
      '/daily week - 查看最近7天个人每日周报',
      `/daily on ${DEFAULT_PULSE_TIME} - 当前群/私聊每天低频推送`,
      '/daily time 08:30 - 修改推送时间',
      '/daily status - 查看订阅',
      '/daily due - 管理员执行一次真实定时检查',
      '/daily off - 关闭当前会话每日提醒',
      '自然触发: 今日状态 / 我的每日 / 今日偏好 / 我的画像 / 今日证据账本 / 今天跑没跑 / 今日人话 / 来点人话 / 今日闭环分 / 今日完成度 / 今日指挥台 / 今日看板 / 今日队形 / 群每日 / 今日聊天节奏 / 今日语气 / 今日接力 / 群接力 / 今日话题 / 群破冰 / 识图语音脚本包 / 识图语音缺啥 / 今日三件套缺啥 / 今日语音台词 / 今日语音句 / 今日安排 / 保连续 / 别断签 / 识图语音陪跑 / 催我一下 / 我今天还差啥 / 本周每日 / 今日复盘 / 今日挑战 / 挑战完成 / 今日收工 / 挑战榜 / 今日打卡 / 打卡榜 / 晚安机器 / 每日提醒 / 订阅每日问候 09:00 / 关闭每日提醒',
    ].join('\n'));
    return true;
  },
};

export const __test = {
  __setStorePathForTests(filepath?: string): void {
    storePathOverride = filepath || '';
  },
  normalizePulseTime,
  parseNaturalDailyPulse,
  buildDailyPulseMessage,
  buildDailyRecapMessage,
  buildDailyChallengeMessage,
  recordDailyChallengeDone,
  recordDailyCheckin,
  recordDailyWrapUp,
  formatDailyCheckinBoard,
  formatDailyChallengeBoard,
  formatDailyCommandCenter,
  formatDailySquadSummary,
  formatDailyIcebreaker,
  formatDailyUserSummary,
  formatDailyPersonalizedBrief,
  formatDailyEvidenceLedger,
  formatDailyHumanReplyPack,
  formatDailyCompletionScore,
  formatDailyActionPlan,
  formatDailyNudge,
  formatDailyStreakGuard,
  formatDailyMediaCompanion,
  formatDailyMediaScript,
  formatDailyMediaGap,
  formatDailyVoiceLineKit,
  formatDailyMediaRelay,
  formatDailyChatVibe,
  formatDailyWeekSummary,
  loadStore,
  runDueDailyPulses,
  resetForTests(): void {
    shutdownDailyPulseTasks();
    storePathOverride = '';
    pulseRunning = false;
    lastRunAt = 0;
    lastRunChecked = 0;
    lastRunSent = 0;
    lastRunError = '';
  },
};
