import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Plugin, PluginContext } from '../types';
import { fetchMatchDetail, fetchOngoingMatches, fetchRecentResults, inspectHltvCacheEntry } from './hltv-api';
import { buildCsPlanFactTypeCoverageLines } from './cs-fact-coverage';
import type { CsFactTypePlanItem } from './cs-fact-coverage';

type PredictChatType = 'group' | 'private';
type PredictChoice = 'A' | 'B';
type MarketStatus = 'open' | 'closed' | 'settled' | 'cancelled';
type LeaderboardPeriod = 'all' | 'week' | 'month' | 'season';
type PredictSeasonStatus = 'active' | 'archived';

interface CsPrediction {
  userId: number;
  displayName: string;
  choice: PredictChoice;
  score: string;
  map?: string;
  createdAt: number;
  updatedAt: number;
}

interface CsPredictionMarket {
  id: string;
  chatType: PredictChatType;
  chatId: number;
  groupId?: number;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  status: MarketStatus;
  teamA: string;
  teamB: string;
  title: string;
  bestOf: number;
  map?: string;
  mapHint?: string;
  event?: string;
  closesAt: number;
  lockedAt: number;
  settledAt: number;
  cancelledAt: number;
  winner?: PredictChoice;
  finalScore?: string;
  settledResultLabel?: string;
  settledSourceLine?: string;
  settledEvidenceType?: 'manual' | 'auto';
  predictions: CsPrediction[];
}

interface CsPredictMapStatEntry {
  map: string;
  points: number;
  wins: number;
  exacts: number;
  total: number;
  updatedAt: number;
}

interface CsPredictMapBoardRow extends CsPredictMapStatEntry {
  chatType: PredictChatType;
  chatId: number;
  userId: number;
  displayName: string;
}

interface CsPredictEventStatEntry {
  event: string;
  points: number;
  wins: number;
  exacts: number;
  total: number;
  updatedAt: number;
}

interface CsPredictEventBoardRow extends CsPredictEventStatEntry {
  chatType: PredictChatType;
  chatId: number;
  userId: number;
  displayName: string;
}

interface CsPredictScoreEntry {
  chatType: PredictChatType;
  chatId: number;
  userId: number;
  displayName: string;
  points: number;
  wins: number;
  exacts: number;
  total: number;
  streak: number;
  mapStats: CsPredictMapStatEntry[];
  eventStats: CsPredictEventStatEntry[];
  updatedAt: number;
}

interface CsPredictCandidateSubscription {
  id: string;
  chatType: PredictChatType;
  chatId: number;
  groupId?: number;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
  intervalMinutes: number;
  lastCheckedAt: number;
  lastSentAt: number;
  lastFingerprint: string;
  lastError: string;
}

interface CsPredictSeason {
  id: string;
  chatType: PredictChatType;
  chatId: number;
  groupId?: number;
  name: string;
  status: PredictSeasonStatus;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  startAt: number;
  endAt: number;
  archivedAt: number;
}

interface CsPredictStore {
  version: 1;
  markets: CsPredictionMarket[];
  scores: CsPredictScoreEntry[];
  candidateSubscriptions: CsPredictCandidateSubscription[];
  seasons: CsPredictSeason[];
}

interface PredictBot {
  sendGroupMessage?: (groupId: number, message: string) => Promise<boolean>;
  sendPrivateMessage?: (userId: number, message: string) => Promise<boolean>;
}

interface ParsedOpenArgs {
  teamA: string;
  teamB: string;
  bestOf: number;
  map?: string;
  mapHint?: string;
  event?: string;
  closesAt: number;
  title: string;
}

interface ParsedMatchCandidate {
  teamA: string;
  teamB: string;
  bestOf: number;
  startsAtText: string;
  event: string;
  liveScore: string;
  map?: string;
  mapHint: string;
  sourceLine: string;
}

interface ParsedResultCandidate {
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  event: string;
  map?: string;
  mapHint: string;
  sourceLine: string;
}

interface MapVetoPreview {
  raw: string;
  maps: string[];
  singleMap: string;
  mapHint: string;
  residual: string;
  unknownMaps: string[];
}

interface MapVetoAnalysis extends MapVetoPreview {
  mode: 'single' | 'pool' | 'unknown';
  statScope: string;
  openOption: string;
  pickOption: string;
  boundary: string;
}

interface AutoSettleSummary {
  market: CsPredictionMarket;
  label: string;
  sourceLine: string;
  message: string;
}

const DEFAULT_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'cs-predict.json');
const DEFAULT_CLOSE_MINUTES = 30;
const DEFAULT_AUTO_SETTLE_INTERVAL_MINUTES = 12;
const DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES = 90;
const MIN_CANDIDATE_NOTIFY_INTERVAL_MINUTES = 15;
const MAX_CANDIDATE_NOTIFY_INTERVAL_MINUTES = 720;
const CANDIDATE_NOTIFY_MAX_ITEMS = 3;
const CANDIDATE_NOTIFY_DUP_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_MARKETS_PER_CHAT = 120;
const MAX_SEASONS_PER_CHAT = 24;

let storePathOverride = '';
let matchesFetcher: () => Promise<string> = fetchOngoingMatches;
let resultsFetcher: () => Promise<string> = fetchRecentResults;
let predictTimer: NodeJS.Timeout | null = null;
let predictAutoRunning = false;
let lastAutoRunAt = 0;
let lastAutoRunChecked = 0;
let lastAutoRunSettled = 0;
let lastAutoRunSent = 0;
let lastAutoRunError = '';
let candidateNotifyRunning = false;
let lastCandidateRunAt = 0;
let lastCandidateRunChecked = 0;
let lastCandidateRunDue = 0;
let lastCandidateRunSent = 0;
let lastCandidateRunError = '';

function storePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

function emptyStore(): CsPredictStore {
  return { version: 1, markets: [], scores: [], candidateSubscriptions: [], seasons: [] };
}

function cleanText(value: string, max = 40): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/[|`<>]/g, '')
    .trim()
    .slice(0, max);
}

const MAP_ALIASES: Record<string, string> = {
  mirage: 'Mirage',
  inferno: 'Inferno',
  nuke: 'Nuke',
  ancient: 'Ancient',
  anubis: 'Anubis',
  dust2: 'Dust2',
  dustii: 'Dust2',
  d2: 'Dust2',
  de_dust2: 'Dust2',
  dedust2: 'Dust2',
  overpass: 'Overpass',
  train: 'Train',
  vertigo: 'Vertigo',
  cache: 'Cache',
  cobblestone: 'Cobblestone',
  cbble: 'Cobblestone',
  炼狱小镇: 'Inferno',
  荒漠迷城: 'Mirage',
  核子危机: 'Nuke',
  远古遗迹: 'Ancient',
  阿努比斯: 'Anubis',
  炙热沙城: 'Dust2',
  炙热沙城2: 'Dust2',
  死亡游乐园: 'Overpass',
  列车停放站: 'Train',
  殒命大厦: 'Vertigo',
};

function normalizeMapName(input?: string): string {
  const raw = cleanText((input || '').replace(/^de[_\-\s]*/i, ''), 24);
  if (!raw) return '';
  const key = normalizeComparable(raw);
  return MAP_ALIASES[key] || raw;
}

function normalizeMapHint(input?: string): string {
  return cleanText(input || '', 120);
}

function uniqueMapNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const map = normalizeMapName(value);
    const key = normalizeComparable(map);
    if (!map || seen.has(key)) continue;
    seen.add(key);
    result.push(map);
  }
  return result;
}

function isKnownMapName(value: string): boolean {
  const key = normalizeComparable(normalizeMapName(value));
  if (!key) return false;
  return Object.values(MAP_ALIASES).some((name) => normalizeComparable(name) === key);
}

function knownMapsFromText(input: string): string[] {
  const text = input || '';
  const normalized = normalizeComparable(text);
  if (!normalized) return [];
  const found: Array<{ name: string; index: number }> = [];
  for (const [alias, name] of Object.entries(MAP_ALIASES)) {
    const aliasKey = normalizeComparable(alias);
    const index = aliasKey ? normalized.indexOf(aliasKey) : -1;
    if (index >= 0) found.push({ name, index });
  }
  found.sort((a, b) => a.index - b.index);
  return uniqueMapNames(found.map((item) => item.name));
}

function mapsFromHintValue(input: string): string[] {
  const pieces = (input || '')
    .replace(/\b\d{1,2}\s*[-:：]\s*\d{1,2}\b/g, ' ')
    .split(/[\/,，、;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const direct = uniqueMapNames(pieces.map((item) => item.replace(/^(?:map|地图|图)\s*[=：:]?\s*/i, '')));
  return direct.length > 0 ? direct : knownMapsFromText(input);
}

function mapHintFromMaps(maps: string[]): string {
  return normalizeMapHint(uniqueMapNames(maps).join(' / '));
}

function mapsFromLooseHint(input: string): string[] {
  const direct = mapsFromHintValue(input);
  const known = knownMapsFromText(input);
  if (known.length > 0 && (direct.length !== known.length || direct.some((map) => !isKnownMapName(map)))) {
    return known;
  }
  return direct;
}

function normalizeEventName(input?: string): string {
  return cleanText(input || '', 60);
}

function cleanSeasonName(input?: string): string {
  return cleanText(input || '', 48);
}

function normalizeSeasonStatus(status?: string): PredictSeasonStatus {
  return status === 'archived' ? 'archived' : 'active';
}

function clampCandidateIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES;
  return Math.min(
    Math.max(Math.round(value), MIN_CANDIDATE_NOTIFY_INTERVAL_MINUTES),
    MAX_CANDIDATE_NOTIFY_INTERVAL_MINUTES,
  );
}

function loadStore(): CsPredictStore {
  const filepath = storePath();
  if (!fs.existsSync(filepath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const markets = Array.isArray(parsed?.markets) ? parsed.markets : [];
    const scores = Array.isArray(parsed?.scores) ? parsed.scores : [];
    const candidateSubscriptions = Array.isArray(parsed?.candidateSubscriptions) ? parsed.candidateSubscriptions : [];
    const seasons = Array.isArray(parsed?.seasons) ? parsed.seasons : [];
    return {
      version: 1,
      markets: markets
        .filter((item: Partial<CsPredictionMarket>) => item && item.id && item.chatId && item.teamA && item.teamB)
        .map((item: CsPredictionMarket) => ({
          ...item,
          chatType: item.chatType === 'private' ? 'private' : 'group',
          status: normalizeStatus(item.status),
          teamA: cleanText(item.teamA),
          teamB: cleanText(item.teamB),
          title: cleanText(item.title || `${item.teamA} vs ${item.teamB}`, 80),
          bestOf: Number(item.bestOf || 3),
          map: normalizeMapName(item.map || '') || undefined,
          mapHint: cleanText(item.mapHint || '', 120) || undefined,
          event: normalizeEventName(item.event || '') || undefined,
          closesAt: Number(item.closesAt || 0),
          lockedAt: Number(item.lockedAt || 0),
          settledAt: Number(item.settledAt || 0),
          cancelledAt: Number(item.cancelledAt || 0),
          settledResultLabel: cleanText(item.settledResultLabel || '', 96),
          settledSourceLine: cleanText(item.settledSourceLine || '', 180),
          settledEvidenceType: item.settledEvidenceType === 'auto' ? 'auto' : item.settledEvidenceType === 'manual' ? 'manual' : undefined,
          predictions: Array.isArray(item.predictions)
            ? item.predictions
              .filter((prediction: Partial<CsPrediction>) => prediction && prediction.userId && prediction.choice && prediction.score)
              .map((prediction: CsPrediction) => ({
                userId: Number(prediction.userId),
                displayName: cleanText(prediction.displayName || `user${prediction.userId}`, 24),
                choice: prediction.choice === 'B' ? 'B' : 'A',
                score: normalizeScore(prediction.score) || '2-1',
                map: normalizeMapName(prediction.map || '') || undefined,
                createdAt: Number(prediction.createdAt || Date.now()),
                updatedAt: Number(prediction.updatedAt || prediction.createdAt || Date.now()),
              }))
            : [],
        })),
      scores: scores
        .filter((item: Partial<CsPredictScoreEntry>) => item && item.chatId && item.userId)
        .map((item: CsPredictScoreEntry) => ({
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          userId: Number(item.userId),
          displayName: cleanText(item.displayName || `user${item.userId}`, 24),
          points: Number(item.points || 0),
          wins: Number(item.wins || 0),
          exacts: Number(item.exacts || 0),
          total: Number(item.total || 0),
          streak: Number(item.streak || 0),
          mapStats: normalizeMapStats(item.mapStats, Number(item.updatedAt || 0)),
          eventStats: normalizeEventStats(item.eventStats, Number(item.updatedAt || 0)),
          updatedAt: Number(item.updatedAt || 0),
        })),
      candidateSubscriptions: candidateSubscriptions
        .filter((item: Partial<CsPredictCandidateSubscription>) => item && item.id && item.chatId)
        .map((item: CsPredictCandidateSubscription) => ({
          id: cleanText(item.id, 48),
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          groupId: item.groupId ? Number(item.groupId) : undefined,
          createdBy: Number(item.createdBy || 0),
          createdAt: Number(item.createdAt || Date.now()),
          updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
          enabled: item.enabled !== false,
          intervalMinutes: clampCandidateIntervalMinutes(Number(item.intervalMinutes || DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES)),
          lastCheckedAt: Number(item.lastCheckedAt || 0),
          lastSentAt: Number(item.lastSentAt || 0),
          lastFingerprint: cleanText(item.lastFingerprint || '', 80),
          lastError: cleanText(item.lastError || '', 140),
        })),
      seasons: seasons
        .filter((item: Partial<CsPredictSeason>) => item && item.id && item.chatId && item.name)
        .map((item: CsPredictSeason) => ({
          id: cleanText(item.id, 48),
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          groupId: item.groupId ? Number(item.groupId) : undefined,
          name: cleanSeasonName(item.name) || '未命名赛季',
          status: normalizeSeasonStatus(item.status),
          createdBy: Number(item.createdBy || 0),
          createdAt: Number(item.createdAt || Date.now()),
          updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
          startAt: Number(item.startAt || item.createdAt || Date.now()),
          endAt: Number(item.endAt || 0),
          archivedAt: Number(item.archivedAt || 0),
        })),
    };
  } catch {
    return emptyStore();
  }
}

function normalizeStatus(status: string): MarketStatus {
  if (status === 'closed' || status === 'settled' || status === 'cancelled') return status;
  return 'open';
}

function pruneStore(store: CsPredictStore): void {
  const byChat = new Map<string, CsPredictionMarket[]>();
  for (const market of store.markets) {
    const key = `${market.chatType}:${market.chatId}`;
    const items = byChat.get(key) || [];
    items.push(market);
    byChat.set(key, items);
  }
  const keep = new Set<string>();
  for (const items of byChat.values()) {
    items
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_MARKETS_PER_CHAT)
      .forEach((market) => keep.add(market.id));
  }
  store.markets = store.markets.filter((market) => keep.has(market.id));
  const seenSubs = new Set<string>();
  store.candidateSubscriptions = store.candidateSubscriptions
    .filter((sub) => sub.enabled)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((sub) => {
      const key = `${sub.chatType}:${sub.chatId}`;
      if (seenSubs.has(key)) return false;
      seenSubs.add(key);
      return true;
    });
  const activeSeasonSeen = new Set<string>();
  const seasonCounts = new Map<string, number>();
  store.seasons = (store.seasons || [])
    .sort((a, b) => {
      const aActive = a.status === 'active' ? 0 : 1;
      const bActive = b.status === 'active' ? 0 : 1;
      return aActive - bActive || b.startAt - a.startAt || b.updatedAt - a.updatedAt;
    })
    .filter((season) => {
      const chatKey = `${season.chatType}:${season.chatId}`;
      if (season.status === 'active') {
        if (activeSeasonSeen.has(chatKey)) return false;
        activeSeasonSeen.add(chatKey);
      }
      const count = seasonCounts.get(chatKey) || 0;
      if (count >= MAX_SEASONS_PER_CHAT) return false;
      seasonCounts.set(chatKey, count + 1);
      return true;
    });
}

function saveStore(store: CsPredictStore): void {
  pruneStore(store);
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

function makeMarketId(chatType: PredictChatType, chatId: number, teamA: string, teamB: string, now: number): string {
  const hash = crypto.createHash('sha1').update(`${chatType}:${chatId}:${teamA}:${teamB}:${now}`).digest('hex').slice(0, 8);
  return `pred-${hash}`;
}

function makeCandidateNotifyId(chatType: PredictChatType, chatId: number): string {
  const hash = crypto.createHash('sha1').update(`candidate:${chatType}:${chatId}`).digest('hex').slice(0, 8);
  return `pred-notify-${hash}`;
}

function makeSeasonId(chatType: PredictChatType, chatId: number, name: string, now: number): string {
  const hash = crypto.createHash('sha1').update(`season:${chatType}:${chatId}:${name}:${now}`).digest('hex').slice(0, 8);
  return `season-${hash}`;
}

function isAdmin(ctx: PluginContext): boolean {
  return (ctx.bot.getConfig().admin_qq || []).includes(ctx.event.user_id);
}

function normalizeComparable(value: string): string {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function normalizeScore(input?: string): string | null {
  const text = (input || '').trim().replace(/[：:]/g, '-');
  const match = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right < 0 || left > 99 || right > 99 || left === right) {
    return null;
  }
  return `${left}-${right}`;
}

function normalizeMapStats(value: unknown, fallbackUpdatedAt = 0): CsPredictMapStatEntry[] {
  if (!Array.isArray(value)) return [];
  const rows = new Map<string, CsPredictMapStatEntry>();
  for (const item of value as Partial<CsPredictMapStatEntry>[]) {
    const map = normalizeMapName(item?.map || '');
    if (!map) continue;
    const key = normalizeComparable(map);
    const existing = rows.get(key) || {
      map,
      points: 0,
      wins: 0,
      exacts: 0,
      total: 0,
      updatedAt: 0,
    };
    existing.map = map;
    existing.points += Number(item?.points || 0);
    existing.wins += Number(item?.wins || 0);
    existing.exacts += Number(item?.exacts || 0);
    existing.total += Number(item?.total || 0);
    existing.updatedAt = Math.max(existing.updatedAt, Number(item?.updatedAt || fallbackUpdatedAt || 0));
    rows.set(key, existing);
  }
  return Array.from(rows.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt);
}

function normalizeEventStats(value: unknown, fallbackUpdatedAt = 0): CsPredictEventStatEntry[] {
  if (!Array.isArray(value)) return [];
  const rows = new Map<string, CsPredictEventStatEntry>();
  for (const item of value as Partial<CsPredictEventStatEntry>[]) {
    const event = normalizeEventName(item?.event || '');
    if (!event) continue;
    const key = normalizeComparable(event);
    const existing = rows.get(key) || {
      event,
      points: 0,
      wins: 0,
      exacts: 0,
      total: 0,
      updatedAt: 0,
    };
    existing.event = event;
    existing.points += Number(item?.points || 0);
    existing.wins += Number(item?.wins || 0);
    existing.exacts += Number(item?.exacts || 0);
    existing.total += Number(item?.total || 0);
    existing.updatedAt = Math.max(existing.updatedAt, Number(item?.updatedAt || fallbackUpdatedAt || 0));
    rows.set(key, existing);
  }
  return Array.from(rows.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt);
}

function parseChoice(market: CsPredictionMarket, input?: string): PredictChoice | null {
  const token = normalizeComparable(input || '');
  if (!token) return null;
  if (['a', '1', '队伍a', '主队', '左边'].includes(token)) return 'A';
  if (['b', '2', '队伍b', '客队', '右边'].includes(token)) return 'B';
  const a = normalizeComparable(market.teamA);
  const b = normalizeComparable(market.teamB);
  if (a && (token === a || a.includes(token) || token.includes(a))) return 'A';
  if (b && (token === b || b.includes(token) || token.includes(b))) return 'B';
  return null;
}

function choiceName(market: CsPredictionMarket, choice?: PredictChoice): string {
  if (choice === 'A') return market.teamA;
  if (choice === 'B') return market.teamB;
  return '-';
}

function statusText(status: MarketStatus): string {
  if (status === 'open') return '开盘';
  if (status === 'closed') return '封盘';
  if (status === 'settled') return '已结算';
  return '已取消';
}

function extractMapFromArgs(args: string[]): { args: string[]; map: string } {
  const output: string[] = [];
  let map = '';
  for (let index = 0; index < args.length; index++) {
    const token = args[index] || '';
    const inline = token.match(/^(?:map|地图|图)[=：:](.+)$/i);
    if (inline) {
      map = normalizeMapName(inline[1]);
      continue;
    }
    if (/^(?:map|地图|图)$/i.test(token)) {
      const next = args[index + 1] || '';
      if (next) {
        let value = next;
        if (/^dust$/i.test(next) && /^(?:ii|2)$/i.test(args[index + 2] || '')) {
          value = `${next} ${args[index + 2]}`;
          index++;
        }
        map = normalizeMapName(value);
        index++;
      }
      continue;
    }
    output.push(token);
  }
  return { args: output, map };
}

function isPredictOptionToken(token: string): boolean {
  return /^(?:map|地图|图)(?:[=：:].*)?$/i.test(token)
    || /^(?:mappool|maphint|veto|地图池|选图|地图线索)(?:[=：:].*)?$/i.test(token)
    || /^(?:event|赛事|赛会|比赛)(?:[=：:].*)?$/i.test(token)
    || /^(?:close|封盘|截止)\s*[=：:]?\s*\d{1,3}\s*(?:m|min|分钟|h|小时)?$/i.test(token)
    || /^\bbo\s*[135]\b/i.test(token)
    || /^赛制\s*[135]/.test(token);
}

function extractMapHintFromArgs(args: string[]): { args: string[]; mapHint: string; map: string } {
  const output: string[] = [];
  let mapHint = '';
  let map = '';
  for (let index = 0; index < args.length; index++) {
    const token = args[index] || '';
    const inline = token.match(/^(?:mappool|maphint|veto|地图池|选图|地图线索)[=：:](.+)$/i);
    if (inline) {
      const maps = mapsFromHintValue(inline[1]);
      mapHint = mapHintFromMaps(maps) || normalizeMapHint(inline[1]);
      map = maps.length === 1 ? maps[0] : '';
      continue;
    }
    if (/^(?:mappool|maphint|veto|地图池|选图|地图线索)$/i.test(token)) {
      const values: string[] = [];
      for (let cursor = index + 1; cursor < args.length; cursor++) {
        const next = args[cursor] || '';
        if (isPredictOptionToken(next)) break;
        values.push(next);
        index = cursor;
      }
      const raw = values.join(' ');
      const maps = mapsFromHintValue(raw);
      mapHint = mapHintFromMaps(maps) || normalizeMapHint(raw);
      map = maps.length === 1 ? maps[0] : '';
      continue;
    }
    output.push(token);
  }
  return { args: output, mapHint, map };
}

function extractEventFromArgs(args: string[]): { args: string[]; event: string } {
  const output: string[] = [];
  let event = '';
  for (let index = 0; index < args.length; index++) {
    const token = args[index] || '';
    const inline = token.match(/^(?:event|赛事|赛会|比赛)[=：:](.+)$/i);
    if (inline) {
      event = normalizeEventName(inline[1]);
      continue;
    }
    if (/^(?:event|赛事|赛会|比赛)$/i.test(token)) {
      const values: string[] = [];
      for (let cursor = index + 1; cursor < args.length; cursor++) {
        const next = args[cursor] || '';
        if (isPredictOptionToken(next)) break;
        values.push(next);
        index = cursor;
      }
      event = normalizeEventName(values.join(' '));
      continue;
    }
    output.push(token);
  }
  return { args: output, event };
}

function parseDurationMs(text: string): number {
  const match = text.match(/(?:close|封盘|截止)\s*[=：:]?\s*(\d{1,3})\s*(m|min|分钟|h|小时)?/i);
  if (!match) return DEFAULT_CLOSE_MINUTES * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const minutes = /h|小时/.test(unit) ? amount * 60 : amount;
  return Math.min(Math.max(minutes, 1), 24 * 60) * 60 * 1000;
}

function parseCandidateNotifyInterval(args: string[]): number {
  const raw = args.join(' ').trim();
  const match = raw.match(/(\d{1,4})\s*(m|min|分钟|h|小时)?/i);
  if (!match) return DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES;
  const amount = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  return clampCandidateIntervalMinutes(/h|小时/.test(unit) ? amount * 60 : amount);
}

function parseOpenArgs(args: string[]): ParsedOpenArgs | null {
  const eventParsed = extractEventFromArgs(args);
  const mapHintParsed = extractMapHintFromArgs(eventParsed.args);
  const mapParsed = extractMapFromArgs(mapHintParsed.args);
  const raw = mapParsed.args.join(' ').trim();
  if (!raw) return null;
  const closeMs = parseDurationMs(raw);
  let text = raw
    .replace(/(?:close|封盘|截止)\s*[=：:]?\s*\d{1,3}\s*(?:m|min|分钟|h|小时)?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let bestOf = 3;
  const boMatch = text.match(/\bbo\s*([135])\b/i) || text.match(/赛制\s*([135])/);
  if (boMatch) {
    bestOf = Number(boMatch[1]);
    text = text.replace(boMatch[0], ' ').replace(/\s+/g, ' ').trim();
  }
  const suffixParsed = extractEventSuffix(text);
  text = suffixParsed.text;
  const event = eventParsed.event || suffixParsed.event;
  const match = text.match(/^(.{1,40}?)\s*(?:vs|v\.?|versus|打|对)\s*(.{1,40})$/i);
  if (!match) return null;
  const teamA = cleanText(match[1], 32);
  const teamB = cleanText(match[2], 32);
  if (!teamA || !teamB || normalizeComparable(teamA) === normalizeComparable(teamB)) return null;
  const title = `${teamA} vs ${teamB} BO${bestOf}`;
  return {
    teamA,
    teamB,
    bestOf,
    map: mapParsed.map || mapHintParsed.map || undefined,
    mapHint: mapHintParsed.mapHint || undefined,
    event: event || undefined,
    closesAt: Date.now() + closeMs,
    title,
  };
}

function extractEventSuffix(text: string): { text: string; event: string } {
  const match = text.match(/\s+\(([^()]{2,80})\)\s*$/);
  if (!match) return { text, event: '' };
  return {
    text: text.slice(0, match.index).trim(),
    event: cleanText(match[1], 60),
  };
}

function extractRealtimeMapHint(text: string): { text: string; map: string; mapHint: string } {
  let output = text;
  let maps: string[] = [];
  const explicit = output.match(/\s+(?:maps?|mappool|maphint|veto|地图池|地图线索|地图|图|选图)\s*[=：:]\s*([^()[\]]{2,100})\s*$/i);
  if (explicit) {
    maps = mapsFromHintValue(explicit[1]);
    output = output.slice(0, explicit.index).trim();
  }
  if (maps.length === 0) {
    const bracket = output.match(/\s+\[([^\]]{2,100})\]\s*$/);
    if (bracket) {
      const parsed = mapsFromHintValue(bracket[1]);
      if (parsed.length > 0) {
        maps = parsed;
        output = output.slice(0, bracket.index).trim();
      }
    }
  }
  if (maps.length === 0) {
    const parenthetical = output.match(/\s+\((?:maps?|mappool|veto|地图池|地图|选图)[:：\s]+([^()]{2,100})\)\s*$/i);
    if (parenthetical) {
      maps = mapsFromHintValue(parenthetical[1]);
      output = output.slice(0, parenthetical.index).trim();
    }
  }
  const unique = uniqueMapNames(maps);
  return {
    text: output,
    map: unique.length === 1 ? unique[0] : '',
    mapHint: mapHintFromMaps(unique),
  };
}

function stripDataEvidenceLine(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed
    || /^来源[:：]/.test(trimmed)
    || /^缓存[:：]/.test(trimmed)
    || /^主源[:：]/.test(trimmed)
    || /^说明[:：]/.test(trimmed);
}

function normalizeMatchLine(line: string): string {
  return line
    .replace(/^[\s\-*•✅🔴⏰]+/u, '')
    .replace(/^LIVE\s+/i, '')
    .replace(/^(?:今天|明天|\d{1,2}\/\d{1,2})\s+\d{1,2}:\d{2}\s+/, '')
    .replace(/^\d{4}-\d{1,2}-\d{1,2}(?:[T ][^\s]+)?\s+/, '')
    .replace(/^日期未知\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMatchCandidates(text: string, maxItems: number = 8): ParsedMatchCandidate[] {
  const result: ParsedMatchCandidate[] = [];
  let sourceLine = '';
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^来源[:：]/.test(trimmed)) sourceLine = trimmed.slice(0, 120);
    if (stripDataEvidenceLine(trimmed)) continue;

    const startsAtMatch = trimmed.match(/^(?:[^\w\u4e00-\u9fa5]*)(LIVE|今天\s+\d{1,2}:\d{2}|明天\s+\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})\s+/i);
    const startsAtText = startsAtMatch?.[1] || '';
    let line = normalizeMatchLine(trimmed);
    if (!/\s+vs\s+/i.test(line)) continue;

    const mapParsed = extractRealtimeMapHint(line);
    line = mapParsed.text;
    const eventParsed = extractEventSuffix(line);
    line = eventParsed.text;
    let bestOf = 3;
    const boMatch = line.match(/\s+B[oO]?([135])\s*$/);
    if (boMatch) {
      bestOf = Number(boMatch[1]);
      line = line.slice(0, boMatch.index).trim();
    }
    let liveScore = '';
    const liveScoreMatch = line.match(/\s+(\d{1,2})[:：](\d{1,2})\s*$/);
    if (liveScoreMatch) {
      liveScore = `${liveScoreMatch[1]}:${liveScoreMatch[2]}`;
      line = line.slice(0, liveScoreMatch.index).trim();
    }
    const parts = line.split(/\s+vs\s+/i);
    if (parts.length !== 2) continue;
    const teamA = cleanText(parts[0], 32);
    const teamB = cleanText(parts[1], 32);
    if (!teamA || !teamB || normalizeComparable(teamA) === normalizeComparable(teamB)) continue;
    result.push({
      teamA,
      teamB,
      bestOf,
      startsAtText,
      event: eventParsed.event,
      liveScore,
      map: mapParsed.map || undefined,
      mapHint: mapParsed.mapHint,
      sourceLine,
    });
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanResultTeamB(value: string): string {
  return cleanText(
    value
      .replace(/\s+胜者[:：].+$/i, '')
      .replace(/\s+\[[^\]]+\].*$/i, '')
      .replace(/\s+B[oO]?[135]\b.*$/i, '')
      .replace(/\s+\([^)]{2,80}\).*$/i, ''),
    32,
  );
}

function parseResultCandidates(text: string, maxItems: number = 12): ParsedResultCandidate[] {
  const result: ParsedResultCandidate[] = [];
  let sourceLine = '';
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^来源[:：]/.test(trimmed)) sourceLine = trimmed.slice(0, 120);
    if (stripDataEvidenceLine(trimmed)) continue;
    const mapParsed = extractRealtimeMapHint(trimmed);
    const eventParsed = extractEventSuffix(mapParsed.text);
    const line = normalizeMatchLine(eventParsed.text);
    const match = line.match(/^(.{1,60}?)\s+(\d{1,2})[:：-](\d{1,2})\s+(.{1,80})$/);
    if (!match) continue;
    const teamA = cleanText(match[1], 32);
    const scoreA = Number(match[2]);
    const scoreB = Number(match[3]);
    const teamB = cleanResultTeamB(match[4]);
    if (!teamA || !teamB || scoreA === scoreB || !Number.isInteger(scoreA) || !Number.isInteger(scoreB)) continue;
    result.push({
      teamA,
      teamB,
      scoreA,
      scoreB,
      event: eventParsed.event,
      map: mapParsed.map || undefined,
      mapHint: mapParsed.mapHint,
      sourceLine,
    });
    if (result.length >= maxItems) break;
  }
  return result;
}

function lockExpiredMarkets(store: CsPredictStore, chatType?: PredictChatType, chatId?: number): boolean {
  const now = Date.now();
  let changed = false;
  for (const market of store.markets) {
    if (market.status !== 'open') continue;
    if (chatType && (market.chatType !== chatType || market.chatId !== chatId)) continue;
    if (market.closesAt && market.closesAt <= now) {
      market.status = 'closed';
      market.lockedAt = market.lockedAt || now;
      market.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

function chatMatches(market: CsPredictionMarket, chatType: PredictChatType, chatId: number): boolean {
  return market.chatType === chatType && market.chatId === chatId;
}

function resolveMarket(
  store: CsPredictStore,
  chatType: PredictChatType,
  chatId: number,
  marketId: string,
  statuses: MarketStatus[],
): { market?: CsPredictionMarket; error?: string } {
  const candidates = store.markets.filter((market) => chatMatches(market, chatType, chatId) && statuses.includes(market.status));
  if (marketId) {
    const market = candidates.find((item) => item.id === marketId);
    return market ? { market } : { error: `没找到盘口 ${marketId}，先 /predict list 看一下。` };
  }
  if (candidates.length === 1) return { market: candidates[0] };
  if (candidates.length === 0) return { error: '当前没有可用盘口。管理员先 /predict open NAVI vs Vitality bo3。' };
  return { error: `当前有 ${candidates.length} 个盘口，得带 id：\n${candidates.map((item) => `${item.id} ${item.title}`).join('\n')}` };
}

function formatMarketLine(market: CsPredictionMarket): string {
  const a = market.predictions.filter((prediction) => prediction.choice === 'A').length;
  const b = market.predictions.filter((prediction) => prediction.choice === 'B').length;
  const base = `${market.id} [${statusText(market.status)}] ${market.title}`;
  const map = market.map ? `地图 ${market.map}` : '';
  const mapHint = !market.map && market.mapHint ? `地图线索 ${market.mapHint}` : '';
  const event = market.event ? `赛事 ${market.event}` : '';
  const close = market.status === 'open' ? `封盘 ${nowText(market.closesAt)}` : `封盘 ${nowText(market.lockedAt || market.closesAt)}`;
  const settled = market.status === 'settled' ? `结果 ${choiceName(market, market.winner)} ${market.finalScore}` : '';
  const evidence = market.status === 'settled' && (market.settledResultLabel || market.settledSourceLine)
    ? `结算证据 ${[market.settledResultLabel, market.settledSourceLine].filter(Boolean).join(' / ').slice(0, 180)}`
    : '';
  return [base, event, map, mapHint, close, `预测${market.predictions.length}人 A${a}/B${b}`, settled, evidence].filter(Boolean).join(' | ');
}

function formatCandidateMapHint(match: ParsedMatchCandidate): string {
  if (match.map) return `地图 ${match.map}`;
  return match.mapHint ? `地图线索 ${match.mapHint}` : '';
}

function analyzeMarketMapHint(market: CsPredictionMarket): MapVetoAnalysis | null {
  if (market.map) return analyzeMapVetoPreview(['map', market.map]);
  if (market.mapHint) return analyzeMapVetoPreview(['mappool', market.mapHint]);
  return null;
}

function formatMarketMapEvidenceLine(market: CsPredictionMarket): string {
  const analysis = analyzeMarketMapHint(market);
  if (!analysis) return '';
  if (analysis.mode === 'single') {
    return `地图归属: ${analysis.singleMap} 是明确单图，预测/结算会进入地图榜。`;
  }
  if (analysis.mode === 'pool') {
    return `地图池边界: ${analysis.maps.join(' / ')} 只是盘口线索；个人预测确认单图后再加 map，不能自动拆分进地图榜。`;
  }
  return `地图边界: ${analysis.mapHint || market.mapHint || '未识别到明确地图'} 只能当文字线索，别当实时 veto 事实。`;
}

function parseMapVetoPreview(args: string[]): MapVetoPreview {
  const raw = cleanText(args.join(' '), 160);
  const hintParsed = extractMapHintFromArgs(args);
  const mapParsed = extractMapFromArgs(hintParsed.args);
  const maps = uniqueMapNames([
    ...mapsFromLooseHint(raw),
    ...mapsFromLooseHint(hintParsed.mapHint),
    hintParsed.map,
    mapParsed.map,
  ].filter(Boolean));
  const singleMap = mapParsed.map || hintParsed.map || (maps.length === 1 ? maps[0] : '');
  const mapHint = mapHintFromMaps(maps) || normalizeMapHint(hintParsed.mapHint || raw);
  const residualText = cleanText(mapParsed.args.join(' '), 120);
  const residual = maps.length > 0 && normalizeComparable(residualText) === normalizeComparable(raw) ? '' : residualText;
  return {
    raw,
    maps,
    singleMap,
    mapHint,
    residual,
    unknownMaps: maps.filter((map) => !isKnownMapName(map)),
  };
}

function analyzeMapVetoPreview(args: string[]): MapVetoAnalysis {
  const preview = parseMapVetoPreview(args);
  const mode: MapVetoAnalysis['mode'] = preview.singleMap
    ? 'single'
    : preview.maps.length > 1
      ? 'pool'
      : 'unknown';
  const statScope = mode === 'single'
    ? `单图 ${preview.singleMap}${isKnownMapName(preview.singleMap) ? '，用 map 参数会进入地图榜' : '，非内置地图名，会按原样统计，先核对'}`
    : mode === 'pool'
      ? '多图地图池，只作为盘口线索展示；不会自动拆成每张图的地图榜分数'
      : '暂无明确单图，不会写入地图榜';
  const openOption = preview.singleMap
    ? `map ${preview.singleMap}`
    : preview.mapHint
      ? `mappool ${preview.mapHint}`
      : 'mappool Inferno/Mirage/Nuke';
  const pickOption = preview.singleMap
    ? `下注可带: /predict <id> A 2-1 map ${preview.singleMap}`
    : '个人下注建议只在确认单图后再带 map；多图 veto 先留在盘口线索里。';
  const boundary = '本命令不联网，不把人工输入当已确认 HLTV/veto 数据；多图线索不是赛前官方 pick-ban，单图统计只认明确 map 参数或结算证据。';
  return {
    ...preview,
    mode,
    statScope,
    openOption,
    pickOption,
    boundary,
  };
}

function formatMapVetoPreview(args: string[]): string {
  const analysis = analyzeMapVetoPreview(args);
  if (!analysis.raw) {
    return [
      'CS地图池/veto预检',
      '用法: /predict veto Inferno/Mirage/Nuke',
      '也可以: /predict mapcheck mappool Inferno Mirage Nuke',
      '这个命令只读，不开盘、不结算、不写积分。',
    ].join('\n');
  }

  return [
    'CS地图池/veto预检',
    `输入: ${analysis.raw}`,
    `识别地图: ${analysis.maps.length > 0 ? analysis.maps.join(' / ') : '未识别到内置地图名'}`,
    analysis.unknownMaps.length > 0 ? `非内置地图名: ${analysis.unknownMaps.join(' / ')}，如果是新图可以保留，错别字就先改。` : '',
    analysis.mapHint ? `盘口线索: ${analysis.mapHint}` : '',
    `统计归属: ${analysis.statScope}`,
    `开盘参数: ${analysis.openOption}`,
    analysis.pickOption,
    analysis.residual ? `剩余文本: ${analysis.residual}` : '',
    `来源边界: ${analysis.boundary} 要看实时候选先 /predict matches 或 /cs sources。`,
  ].filter(Boolean).join('\n');
}

function parseMatchSummaryLine(detail: string): { teamA: string; teamB: string; bestOf: number; event: string; line: string } {
  for (const rawLine of (detail || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(.{1,40}?)\s+\d{1,2}\s*[:：-]\s*\d{1,2}\s+(.{1,40}?)\s+B[oO]?([135])(?:\s+\(([^)]{2,80})\))?/);
    if (!match) continue;
    return {
      teamA: cleanText(match[1], 32),
      teamB: cleanText(match[2], 32),
      bestOf: Number(match[3] || 3),
      event: normalizeEventName(match[4] || ''),
      line: line.slice(0, 160),
    };
  }
  return { teamA: '', teamB: '', bestOf: 3, event: '', line: '' };
}

function matchDetailMapLines(detail: string): { sourceLine: string; cacheLine: string; mapLine: string } {
  let sourceLine = '';
  let cacheLine = '';
  let mapLine = '';
  for (const rawLine of (detail || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!sourceLine && /^来源[:：]/.test(line)) sourceLine = line.slice(0, 180);
    if (!cacheLine && /^缓存[:：]\s*match:/i.test(line)) cacheLine = line.slice(0, 180);
    if (!mapLine && /^地图池线索[:：]/.test(line)) mapLine = line.replace(/^地图池线索[:：]\s*/, '').slice(0, 140);
  }
  return { sourceLine, cacheLine, mapLine };
}

function matchCacheStateLine(matchId: string): string {
  const snapshot = inspectHltvCacheEntry(`match:${matchId}`);
  if (!snapshot) return '缓存: miss，还没有成功单场快照。';
  if (snapshot.status === 'fresh') {
    return `缓存: fresh ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`;
  }
  return `缓存: stale expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`;
}

function matchMapFactCoverageRows(matchId: string): CsFactTypePlanItem[] {
  const cacheKey = `match:${matchId}`;
  const snapshot = inspectHltvCacheEntry(cacheKey);
  return [{
    label: `match ${matchId}`,
    cacheKey,
    status: snapshot?.status || 'miss',
    action: snapshot?.status === 'fresh' ? 'hit' : 'refresh',
  }];
}

function cacheFactCoverageRow(label: string, cacheKey: string): CsFactTypePlanItem {
  const snapshot = inspectHltvCacheEntry(cacheKey);
  return {
    label,
    cacheKey,
    status: snapshot?.status || 'miss',
    action: snapshot?.status === 'fresh' ? 'hit' : 'refresh',
  };
}

function realtimeMatchesFactCoverageLines(): string[] {
  return buildCsPlanFactTypeCoverageLines(
    [cacheFactCoverageRow('predict matches', 'matches')],
    '竞猜赛程事实类型覆盖:',
  );
}

function realtimeResultsFactCoverageLines(): string[] {
  return buildCsPlanFactTypeCoverageLines(
    [cacheFactCoverageRow('predict results', 'results')],
    '竞猜赛果事实类型覆盖:',
  );
}

function realtimeMatchesBoundaryLine(): string {
  const snapshot = inspectHltvCacheEntry('matches');
  const state = !snapshot
    ? 'matches=miss，本地没有成功赛程快照'
    : snapshot.status === 'fresh'
      ? `matches=fresh ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`
      : `matches=stale expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`;
  return `赛程来源边界: ${state}；复核 /cs verify matches；证据 /cs evidence matches；补证 管理员 /cs warm plan matches -> /cs warm matches。`;
}

function noRealtimeMatchCandidateBoundaryLine(): string {
  return '候选解析边界: 这只代表本次没有解析出可一键开盘的 TeamA vs TeamB 候选，不能反推今天没有比赛、没有赛程或没有可开的盘口。';
}

function realtimeResultsBoundaryLine(): string {
  const snapshot = inspectHltvCacheEntry('results');
  const state = !snapshot
    ? 'results=miss，本地没有成功赛果快照'
    : snapshot.status === 'fresh'
      ? `results=fresh ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`
      : `results=stale expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`;
  return `赛果来源边界: ${state}；复核 /cs verify results；证据 /cs evidence results；补证 管理员 /cs warm plan results -> /cs warm results。`;
}

function noRealtimeResultCandidateBoundaryLine(): string {
  return '赛果解析边界: 这只代表本次没有解析出可自动结算的明确比分，不能反推没有赛果、比赛未结束或盘口一定不能结算。';
}

function noAutoSettleMatchBoundaryLine(): string {
  return '自动匹配边界: 没匹配到只代表队名/赛事/比分文本没和当前盘口对上，不能反推近期赛果里没有这场或这盘已经没有结果。';
}

async function formatMatchMapPreview(args: string[]): Promise<string> {
  const matchId = (args.join(' ').match(/\d{4,}/) || [])[0] || '';
  if (!matchId) {
    return [
      'CS单场地图线索预检',
      '用法: /predict matchmap 2390002',
      '作用: 读取 CS API 单场详情里的 match.maps，转成竞猜地图池/单图预检；不写盘口、不写积分。',
    ].join('\n');
  }

  const detail = await fetchMatchDetail(matchId).catch(() => '');
  const cacheState = matchCacheStateLine(matchId);
  if (!detail) {
    return [
      'CS单场地图线索预检',
      `Match ID: ${matchId}`,
      cacheState,
      '识别地图: miss，没有单场详情可用。',
      ...buildCsPlanFactTypeCoverageLines(matchMapFactCoverageRows(matchId), '竞猜事实类型覆盖:'),
      `复核: /cs verify match ${matchId}；证据: /cs evidence match ${matchId}`,
      `补证: 管理员 /cs warm plan match ${matchId}，确认会 REFRESH 后再 /cs warm match ${matchId}。`,
      '边界: miss 只代表本地没有成功快照，不能反推这场没有地图池或没有 veto。',
    ].join('\n');
  }

  const lines = matchDetailMapLines(detail);
  const maps = uniqueMapNames([
    ...mapsFromLooseHint(lines.mapLine),
    ...mapsFromLooseHint(detail.match(/^地图池线索[:：].*$/m)?.[0] || ''),
  ]);
  const mapArgs = maps.length > 0 ? ['mappool', maps.join(' / ')] : [lines.mapLine || detail];
  const analysis = analyzeMapVetoPreview(mapArgs);
  const summary = parseMatchSummaryLine(detail);
  const openExample = summary.teamA && summary.teamB
    ? `管理员 /predict open ${summary.teamA} vs ${summary.teamB} bo${summary.bestOf}${summary.event ? ` event ${summary.event}` : ''} ${analysis.openOption} close=30m`
    : `管理员 /predict open <队伍A> vs <队伍B> bo3 ${analysis.openOption} close=30m`;

  return [
    'CS单场地图线索预检',
    `Match ID: ${matchId}`,
    lines.sourceLine ? `证据: ${lines.sourceLine}` : '证据: CS API 单场详情快照',
    cacheState,
    summary.line ? `单场摘要: ${summary.line}` : '',
    `识别地图: ${analysis.maps.length > 0 ? analysis.maps.join(' / ') : '未识别到结构化地图名'}`,
    analysis.mapHint ? `盘口线索: ${analysis.mapHint}` : '',
    `统计归属: ${analysis.statScope}`,
    `开盘参数: ${analysis.openOption}`,
    `开盘示例: ${openExample}`,
    analysis.pickOption,
    ...buildCsPlanFactTypeCoverageLines(matchMapFactCoverageRows(matchId), '竞猜事实类型覆盖:'),
    `复核: /cs verify match ${matchId}；证据: /cs evidence match ${matchId}；HLTV候选页: /cs hltvcheck ${matchId}`,
    `补证: 管理员 /cs warm plan match ${matchId}，需要当前快照再 /cs warm match ${matchId}。`,
    '来源边界: 这里用的是 CS API 单场详情 match.maps/赛果快照；它可以做竞猜地图线索，但不等于赛前 HLTV 官方 veto/pick-ban。多图 mappool 不会自动进入地图榜，单图统计只认明确 map 参数或结算证据。',
  ].filter(Boolean).join('\n');
}

function usage(): string {
  return [
    'CS竞猜用法',
    '管理员: /predict open NAVI vs Vitality bo3 event IEM Cologne close=30m',
    '实时开盘: /predict matches 看赛程，管理员 /predict openmatch 1 close=30m',
    '地图池预检: /predict veto Inferno/Mirage/Nuke 或 /predict mapcheck mappool Inferno Mirage Nuke',
    '单场地图线索: /predict matchmap <matchid> 从 CS API 单场详情生成竞猜地图预检',
    '群友: /predict A 2-1 或 /predict <id> Vitality 2-1 map Inferno',
    '查看: /predict list / /predict board week|month|season / /predict map Inferno / /predict event IEM Cologne / /predict mine',
    '结算: /predict settle <id> A 2-1；管理员 /predict autosettle 读近期赛果自动结算',
    '提醒: 管理员 /predict notify on 90m，没开盘时自动推送实时开盘候选',
    '比分按“你选择的队伍在前”填，比如压 B 2-1 就是 B 赢 2-1。',
  ].join('\n');
}

async function listRealtimeMatches(): Promise<string> {
  const raw = await matchesFetcher().catch(() => '');
  const matches = parseMatchCandidates(raw, 10);
  if (matches.length === 0) {
    return [
      'CS实时赛程候选',
      '这次没解析到明确的 TeamA vs TeamB 赛程。',
      ...realtimeMatchesFactCoverageLines(),
      realtimeMatchesBoundaryLine(),
      noRealtimeMatchCandidateBoundaryLine(),
      '可以先 /cs match 看原始数据，或者手动 /predict open NAVI vs Vitality。',
    ].join('\n');
  }
  return [
    'CS实时赛程候选',
    ...matches.map((match, index) => [
      `${index + 1}. ${match.teamA} vs ${match.teamB} BO${match.bestOf}`,
      match.startsAtText ? `时间 ${match.startsAtText}` : '',
      match.liveScore ? `比分 ${match.liveScore}` : '',
      match.event ? `赛事 ${match.event}` : '',
      formatCandidateMapHint(match),
    ].filter(Boolean).join(' | ')),
    matches[0].sourceLine ? `证据: ${matches[0].sourceLine}` : '证据: CS实时数据链路',
    ...realtimeMatchesFactCoverageLines(),
    realtimeMatchesBoundaryLine(),
    '开盘: /predict openmatch 1 close=30m',
  ].join('\n');
}

async function openMarketFromRealtime(ctx: PluginContext, args: string[]): Promise<string> {
  if (!isAdmin(ctx)) return '实时开盘得管理员来。';
  const index = Math.max(1, Number(args[0] || 1)) - 1;
  if (!Number.isInteger(index) || index < 0) return '用法: /predict openmatch 1 close=30m';
  const raw = await matchesFetcher().catch(() => '');
  const matches = parseMatchCandidates(raw, 10);
  const candidate = matches[index];
  if (!candidate) {
    return [
      `没找到第 ${index + 1} 个赛程候选。`,
      ...realtimeMatchesFactCoverageLines(),
      realtimeMatchesBoundaryLine(),
      noRealtimeMatchCandidateBoundaryLine(),
      '先 /predict matches 看列表，或者手动 /predict open NAVI vs Vitality。',
    ].join('\n');
  }
  const closeText = args.slice(1).join(' ');
  const openArgs = [
    `${candidate.teamA} vs ${candidate.teamB}`,
    `bo${candidate.bestOf}`,
    candidate.event ? `event=${candidate.event}` : '',
    candidate.map ? `map=${candidate.map}` : '',
    !candidate.map && candidate.mapHint ? `mappool=${candidate.mapHint}` : '',
    closeText || `close=${DEFAULT_CLOSE_MINUTES}m`,
  ].filter(Boolean);
  const result = openMarket(ctx, openArgs);
  if (!result.startsWith('CS竞猜已开盘')) return result;
  return `${result}\n${realtimeMatchesBoundaryLine()}`;
}

function listMarkets(chatType: PredictChatType, chatId: number): string {
  const store = loadStore();
  const changed = lockExpiredMarkets(store, chatType, chatId);
  if (changed) saveStore(store);
  const items = store.markets
    .filter((market) => chatMatches(market, chatType, chatId))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (items.length === 0) return `${usage()}\n\n当前会话还没有盘口。`;
  const active = items.filter((market) => market.status === 'open' || market.status === 'closed').slice(0, 8);
  const recent = items.filter((market) => market.status === 'settled' || market.status === 'cancelled').slice(0, 5);
  const activeLines = active.flatMap((market) => {
    const mapEvidence = formatMarketMapEvidenceLine(market);
    return [formatMarketLine(market), mapEvidence ? `  ${mapEvidence}` : ''].filter(Boolean);
  });
  return [
    'CS竞猜盘口',
    ...(active.length > 0 ? activeLines : ['暂无未结算盘口']),
    ...(recent.length > 0 ? ['', '最近结算:', ...recent.map(formatMarketLine)] : []),
    '',
    '下注: /predict <id> A 2-1',
  ].join('\n');
}

function openMarket(ctx: PluginContext, args: string[]): string {
  if (!isAdmin(ctx)) return '开盘得管理员来，别上来就开香槟局。';
  const parsed = parseOpenArgs(args);
  if (!parsed) return '用法: /predict open NAVI vs Vitality bo3 close=30m';
  const store = loadStore();
  lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const now = Date.now();
  const market: CsPredictionMarket = {
    id: makeMarketId(ctx.chatType, ctx.chatId, parsed.teamA, parsed.teamB, now),
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    groupId: ctx.groupId,
    createdBy: ctx.event.user_id,
    createdAt: now,
    updatedAt: now,
    status: 'open',
    teamA: parsed.teamA,
    teamB: parsed.teamB,
    title: parsed.title,
    bestOf: parsed.bestOf,
    map: parsed.map,
    mapHint: parsed.mapHint,
    event: parsed.event,
    closesAt: parsed.closesAt,
    lockedAt: 0,
    settledAt: 0,
    cancelledAt: 0,
    predictions: [],
  };
  store.markets.push(market);
  saveStore(store);
  const mapEvidence = formatMarketMapEvidenceLine(market);
  return [
    `CS竞猜已开盘 ${market.id}`,
    `${market.teamA} vs ${market.teamB} BO${market.bestOf}${market.event ? ` | 赛事 ${market.event}` : ''}${market.map ? ` | 地图 ${market.map}` : market.mapHint ? ` | 地图线索 ${market.mapHint}` : ''}`,
    mapEvidence,
    `封盘: ${nowText(market.closesAt)}`,
    `下注: /predict ${market.id} A 2-1${market.map ? '' : ' map Inferno'} 或 /predict ${market.id} B 2-1`,
    '比分按你选择的队伍在前，别结算完了再说自己是反着填的。',
  ].filter(Boolean).join('\n');
}

function parsePickArgs(args: string[]): { marketId: string; choiceToken: string; scoreToken: string; map: string } {
  const items = [...args];
  let marketId = '';
  if (/^pred-[a-f0-9]{6,}$/i.test(items[0] || '')) {
    marketId = items.shift() || '';
  }
  const mapParsed = extractMapFromArgs(items);
  const pickItems = mapParsed.args;
  return {
    marketId,
    choiceToken: pickItems.shift() || '',
    scoreToken: pickItems.shift() || '',
    map: mapParsed.map,
  };
}

function displayName(ctx: PluginContext): string {
  return cleanText(ctx.event.sender.card || ctx.event.sender.nickname || `user${ctx.event.user_id}`, 24);
}

function placePrediction(ctx: PluginContext, args: string[]): string {
  const parsed = parsePickArgs(args);
  const score = normalizeScore(parsed.scoreToken);
  if (!parsed.choiceToken || !score) return '用法: /predict A 2-1 或 /predict <id> Vitality 2-1';
  const store = loadStore();
  const changed = lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const resolved = resolveMarket(store, ctx.chatType, ctx.chatId, parsed.marketId, ['open']);
  if (!resolved.market) {
    if (changed) saveStore(store);
    return resolved.error || '当前没有可下注盘口。';
  }
  const market = resolved.market;
  const choice = parseChoice(market, parsed.choiceToken);
  if (!choice) return `没看懂你压哪边：A=${market.teamA}，B=${market.teamB}`;
  if (market.closesAt <= Date.now()) {
    market.status = 'closed';
    market.lockedAt = market.lockedAt || Date.now();
    saveStore(store);
    return `已经封盘了: ${market.id} ${market.title}`;
  }

  const now = Date.now();
  const existing = market.predictions.find((prediction) => prediction.userId === ctx.event.user_id);
  const predictionMap = parsed.map || existing?.map || market.map || '';
  if (existing) {
    existing.choice = choice;
    existing.score = score;
    existing.map = predictionMap || undefined;
    existing.displayName = displayName(ctx);
    existing.updatedAt = now;
  } else {
    market.predictions.push({
      userId: ctx.event.user_id,
      displayName: displayName(ctx),
      choice,
      score,
      map: predictionMap || undefined,
      createdAt: now,
      updatedAt: now,
    });
  }
  market.updatedAt = now;
  saveStore(store);
  return [
    `${existing ? '已更新预测' : '预测已记录'}: ${market.id}`,
    `${displayName(ctx)} 压 ${choiceName(market, choice)} ${score}${predictionMap ? ` | 地图 ${predictionMap}` : ''}`,
    !predictionMap && market.mapHint ? `地图线索: ${market.mapHint}；要按单图统计可以补 /predict ${market.id} ${choice} ${score} map Inferno` : '',
    `当前 ${market.predictions.length} 人，封盘 ${nowText(market.closesAt)}`,
  ].filter(Boolean).join('\n');
}

function closeMarket(ctx: PluginContext, marketId: string): string {
  if (!isAdmin(ctx)) return '封盘得管理员来。';
  if (!marketId) return '用法: /predict close <id>';
  const store = loadStore();
  lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const resolved = resolveMarket(store, ctx.chatType, ctx.chatId, marketId, ['open']);
  if (!resolved.market) return resolved.error || '没找到可封盘口。';
  resolved.market.status = 'closed';
  resolved.market.lockedAt = Date.now();
  resolved.market.updatedAt = Date.now();
  saveStore(store);
  return `已封盘: ${formatMarketLine(resolved.market)}`;
}

function scoreEntry(store: CsPredictStore, market: CsPredictionMarket, prediction: CsPrediction): CsPredictScoreEntry {
  let entry = store.scores.find((item) => item.chatType === market.chatType && item.chatId === market.chatId && item.userId === prediction.userId);
  if (!entry) {
    entry = {
      chatType: market.chatType,
      chatId: market.chatId,
      userId: prediction.userId,
      displayName: prediction.displayName,
      points: 0,
      wins: 0,
      exacts: 0,
      total: 0,
      streak: 0,
      mapStats: [],
      eventStats: [],
      updatedAt: 0,
    };
    store.scores.push(entry);
  }
  return entry;
}

function predictionMapForStats(market: CsPredictionMarket, prediction: CsPrediction): string {
  return normalizeMapName(prediction.map || market.map || '');
}

function predictionEventForStats(market: CsPredictionMarket): string {
  return normalizeEventName(market.event || '');
}

function updateMapStat(
  entry: CsPredictScoreEntry,
  map: string,
  points: number,
  win: boolean,
  exact: boolean,
  now: number,
): void {
  const normalized = normalizeMapName(map);
  if (!normalized) return;
  if (!Array.isArray(entry.mapStats)) entry.mapStats = [];
  const key = normalizeComparable(normalized);
  let stat = entry.mapStats.find((item) => normalizeComparable(item.map) === key);
  if (!stat) {
    stat = {
      map: normalized,
      points: 0,
      wins: 0,
      exacts: 0,
      total: 0,
      updatedAt: 0,
    };
    entry.mapStats.push(stat);
  }
  stat.map = normalized;
  stat.points += points;
  stat.total++;
  if (win) stat.wins++;
  if (exact) stat.exacts++;
  stat.updatedAt = now;
  entry.mapStats = normalizeMapStats(entry.mapStats, now);
}

function updateEventStat(
  entry: CsPredictScoreEntry,
  event: string,
  points: number,
  win: boolean,
  exact: boolean,
  now: number,
): void {
  const normalized = normalizeEventName(event);
  if (!normalized) return;
  if (!Array.isArray(entry.eventStats)) entry.eventStats = [];
  const key = normalizeComparable(normalized);
  let stat = entry.eventStats.find((item) => normalizeComparable(item.event) === key);
  if (!stat) {
    stat = {
      event: normalized,
      points: 0,
      wins: 0,
      exacts: 0,
      total: 0,
      updatedAt: 0,
    };
    entry.eventStats.push(stat);
  }
  stat.event = normalized;
  stat.points += points;
  stat.total++;
  if (win) stat.wins++;
  if (exact) stat.exacts++;
  stat.updatedAt = now;
  entry.eventStats = normalizeEventStats(entry.eventStats, now);
}

function settleResolvedMarket(
  store: CsPredictStore,
  market: CsPredictionMarket,
  winner: PredictChoice,
  finalScore: string,
  evidence: { resultLabel?: string; sourceLine?: string; type?: 'manual' | 'auto' } = {},
): string {
  const now = Date.now();
  const awarded: Array<{ name: string; points: number; exact: boolean; choice: string; score: string; map: string }> = [];
  for (const prediction of market.predictions) {
    const entry = scoreEntry(store, market, prediction);
    entry.displayName = prediction.displayName;
    entry.total++;
    let points = 0;
    let exact = false;
    if (prediction.choice === winner) {
      points += 3;
      entry.wins++;
      entry.streak++;
      exact = prediction.score === finalScore;
      if (exact) {
        points += 2;
        entry.exacts++;
      }
    } else {
      entry.streak = 0;
    }
    const map = predictionMapForStats(market, prediction);
    updateMapStat(entry, map, points, prediction.choice === winner, exact, now);
    const event = predictionEventForStats(market);
    updateEventStat(entry, event, points, prediction.choice === winner, exact, now);
    entry.points += points;
    entry.updatedAt = now;
    awarded.push({
      name: prediction.displayName,
      points,
      exact,
      choice: choiceName(market, prediction.choice),
      score: prediction.score,
      map,
    });
  }

  market.status = 'settled';
  market.winner = winner;
  market.finalScore = finalScore;
  market.settledResultLabel = cleanText(evidence.resultLabel || `${choiceName(market, winner)} ${finalScore}`, 96);
  market.settledSourceLine = cleanText(evidence.sourceLine || (evidence.type === 'manual' ? '管理员手动结算' : ''), 180);
  market.settledEvidenceType = evidence.type;
  market.settledAt = now;
  market.updatedAt = now;

  const winners = awarded
    .filter((item) => item.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 6);
  return [
    `CS竞猜已结算: ${market.id}`,
    `结果: ${choiceName(market, winner)} ${finalScore}`,
    market.event ? `赛事: ${market.event}` : '',
    market.map ? `地图: ${market.map}` : '',
    !market.map && market.mapHint ? `地图线索: ${market.mapHint}` : '',
    market.settledSourceLine ? `证据: ${market.settledResultLabel}${market.settledSourceLine ? ` / ${market.settledSourceLine}` : ''}` : '',
    `参与: ${market.predictions.length}人；命中: ${winners.length}人`,
    ...(winners.length > 0
      ? winners.map((item, index) => `${index + 1}. ${item.name} +${item.points} ${item.choice} ${item.score}${item.map ? ` 地图 ${item.map}` : ''}${item.exact ? ' 精准比分' : ''}`)
      : ['这盘没人吃分，懂了，全员反买。']),
    '积分: 命中胜负+3，精准比分+2。',
  ].filter(Boolean).join('\n');
}

function settleMarket(ctx: PluginContext, args: string[]): string {
  if (!isAdmin(ctx)) return '结算得管理员来。';
  const marketId = args[0] || '';
  if (!marketId) return '用法: /predict settle <id> A 2-1';
  const store = loadStore();
  lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const resolved = resolveMarket(store, ctx.chatType, ctx.chatId, marketId, ['open', 'closed']);
  if (!resolved.market) return resolved.error || '没找到可结算盘口。';
  const market = resolved.market;
  const winner = parseChoice(market, args[1] || '');
  const finalScore = normalizeScore(args[2] || '');
  if (!winner || !finalScore) return `用法: /predict settle ${market.id} A 2-1`;
  const message = settleResolvedMarket(store, market, winner, finalScore, {
    resultLabel: `${choiceName(market, winner)} ${finalScore}`,
    sourceLine: '管理员手动结算',
    type: 'manual',
  });
  saveStore(store);
  return message;
}

function teamsEqual(left: string, right: string): boolean {
  const a = normalizeComparable(left);
  const b = normalizeComparable(right);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

function resultForMarket(
  market: CsPredictionMarket,
  result: ParsedResultCandidate,
): { winner: PredictChoice; finalScore: string; label: string } | null {
  const sameOrder = teamsEqual(market.teamA, result.teamA) && teamsEqual(market.teamB, result.teamB);
  const reverseOrder = teamsEqual(market.teamA, result.teamB) && teamsEqual(market.teamB, result.teamA);
  if (!sameOrder && !reverseOrder) return null;

  if (sameOrder) {
    if (result.scoreA > result.scoreB) {
      return { winner: 'A', finalScore: `${result.scoreA}-${result.scoreB}`, label: `${result.teamA} ${result.scoreA}:${result.scoreB} ${result.teamB}` };
    }
    return { winner: 'B', finalScore: `${result.scoreB}-${result.scoreA}`, label: `${result.teamA} ${result.scoreA}:${result.scoreB} ${result.teamB}` };
  }

  if (result.scoreA > result.scoreB) {
    return { winner: 'B', finalScore: `${result.scoreA}-${result.scoreB}`, label: `${result.teamA} ${result.scoreA}:${result.scoreB} ${result.teamB}` };
  }
  return { winner: 'A', finalScore: `${result.scoreB}-${result.scoreA}`, label: `${result.teamA} ${result.scoreA}:${result.scoreB} ${result.teamB}` };
}

function settleMarketsFromResults(
  store: CsPredictStore,
  results: ParsedResultCandidate[],
  filter?: { chatType: PredictChatType; chatId: number },
): { checked: number; settled: AutoSettleSummary[]; skipped: string[] } {
  const markets = store.markets.filter((market) => {
    const active = market.status === 'open' || market.status === 'closed';
    if (!active) return false;
    if (filter) return chatMatches(market, filter.chatType, filter.chatId);
    return true;
  });
  const settled: AutoSettleSummary[] = [];
  const skipped: string[] = [];
  for (const market of markets) {
    const match = results
      .map((result) => ({ result, resolved: resultForMarket(market, result) }))
      .find((item) => item.resolved);
    if (!match?.resolved) {
      skipped.push(`${market.id} ${market.teamA} vs ${market.teamB}`);
      continue;
    }
    if (!market.event && match.result.event) {
      market.event = normalizeEventName(match.result.event) || undefined;
    }
    if (!market.map && match.result.map) {
      market.map = normalizeMapName(match.result.map) || undefined;
    }
    if (!market.mapHint && match.result.mapHint) {
      market.mapHint = normalizeMapHint(match.result.mapHint) || undefined;
    }
    const message = settleResolvedMarket(store, market, match.resolved.winner, match.resolved.finalScore, {
      resultLabel: match.resolved.label,
      sourceLine: match.result.sourceLine,
      type: 'auto',
    });
    settled.push({
      market,
      label: match.resolved.label,
      sourceLine: match.result.sourceLine,
      message,
    });
  }
  return { checked: markets.length, settled, skipped };
}

async function autoSettleMarkets(ctx: PluginContext): Promise<string> {
  if (!isAdmin(ctx)) return '自动结算得管理员来。';
  const raw = await resultsFetcher().catch(() => '');
  const results = parseResultCandidates(raw, 16);
  if (results.length === 0) {
    return [
      'CS竞猜自动结算',
      '近期赛果里没解析到明确比分。',
      ...realtimeResultsFactCoverageLines(),
      realtimeResultsBoundaryLine(),
      noRealtimeResultCandidateBoundaryLine(),
      '可以先 /cs results 看原始数据，再 /predict settle <id> A 2-1 手动结算。',
    ].join('\n');
  }

  const store = loadStore();
  const lockedChanged = lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const result = settleMarketsFromResults(store, results, { chatType: ctx.chatType, chatId: ctx.chatId });

  if (lockedChanged || result.settled.length > 0) saveStore(store);
  return [
    'CS竞猜自动结算',
    `赛果解析: ${results.length}条；盘口: ${result.checked}个；结算: ${result.settled.length}个`,
    results[0]?.sourceLine ? `证据: ${results[0].sourceLine}` : '证据: CS实时赛果链路',
    ...realtimeResultsFactCoverageLines(),
    realtimeResultsBoundaryLine(),
    ...(result.settled.length > 0
      ? ['', ...result.settled.slice(0, 4).map((item) => `${item.market.id} <- ${item.label}\n${item.message.split('\n').slice(1, 4).join('\n')}`)]
      : ['没有匹配到可结算盘口。', noAutoSettleMatchBoundaryLine()]),
    ...(result.skipped.length > 0 ? ['', `未匹配: ${result.skipped.slice(0, 5).join(' / ')}`] : []),
  ].join('\n');
}

async function sendPredictMessage(bot: PredictBot, market: CsPredictionMarket, message: string): Promise<boolean> {
  if (market.chatType === 'group' && market.groupId && bot.sendGroupMessage) {
    return bot.sendGroupMessage(market.groupId, message);
  }
  if (market.chatType === 'private' && bot.sendPrivateMessage) {
    return bot.sendPrivateMessage(market.chatId, message);
  }
  return false;
}

function buildAutoSettleNotification(item: AutoSettleSummary): string {
  return [
    'CS竞猜自动结算提醒',
    item.message,
    `赛果: ${item.label}`,
    item.sourceLine ? `证据: ${item.sourceLine}` : '证据: CS实时赛果链路',
    ...realtimeResultsFactCoverageLines(),
    realtimeResultsBoundaryLine(),
    '看榜: /predict board',
  ].join('\n');
}

function cancelMarket(ctx: PluginContext, marketId: string): string {
  if (!isAdmin(ctx)) return '取消盘口得管理员来。';
  if (!marketId) return '用法: /predict cancel <id>';
  const store = loadStore();
  const market = store.markets.find((item) => chatMatches(item, ctx.chatType, ctx.chatId) && item.id === marketId);
  if (!market) return `没找到盘口 ${marketId}。`;
  if (market.status === 'settled') return '这盘已经结算了，别撤回历史。';
  market.status = 'cancelled';
  market.cancelledAt = Date.now();
  market.updatedAt = Date.now();
  saveStore(store);
  return `已取消盘口: ${market.id} ${market.title}`;
}

function parseLeaderboardPeriodMaybe(input?: string): LeaderboardPeriod | null {
  const token = normalizeComparable(input || '');
  if (['week', 'weekly', '7d', 'zhou', '周榜', '本周', '近7天', '周'].includes(token)) return 'week';
  if (['month', 'monthly', '30d', 'yue', '月榜', '本月', '近30天', '月'].includes(token)) return 'month';
  if (['season', '90d', '赛季', '赛季榜', '季度', '近90天'].includes(token)) return 'season';
  if (['all', 'total', 'zongbang', '总榜', '全部'].includes(token)) return 'all';
  return null;
}

function parseLeaderboardPeriod(input?: string): LeaderboardPeriod {
  return parseLeaderboardPeriodMaybe(input) || 'all';
}

function leaderboardPeriodLabel(period: LeaderboardPeriod): string {
  if (period === 'week') return '近7天';
  if (period === 'month') return '近30天';
  if (period === 'season') return '赛季榜';
  return '总榜';
}

function leaderboardCutoff(period: LeaderboardPeriod): number {
  if (period === 'week') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (period === 'month') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (period === 'season') return Date.now() - 90 * 24 * 60 * 60 * 1000;
  return 0;
}

function predictionAward(market: CsPredictionMarket, prediction: CsPrediction): { points: number; win: boolean; exact: boolean } {
  const win = !!market.winner && prediction.choice === market.winner;
  const exact = win && !!market.finalScore && prediction.score === market.finalScore;
  return { points: (win ? 3 : 0) + (exact ? 2 : 0), win, exact };
}

function rangeLeaderboardRows(
  store: CsPredictStore,
  chatType: PredictChatType,
  chatId: number,
  startAt: number,
  endAt = 0,
): CsPredictScoreEntry[] {
  const rows = new Map<number, CsPredictScoreEntry>();
  const markets = store.markets
    .filter((market) => {
      if (!chatMatches(market, chatType, chatId) || market.status !== 'settled') return false;
      if (market.settledAt < startAt) return false;
      return !endAt || market.settledAt <= endAt;
    })
    .sort((a, b) => a.settledAt - b.settledAt);
  for (const market of markets) {
    for (const prediction of market.predictions) {
      let row = rows.get(prediction.userId);
      if (!row) {
        row = {
          chatType,
          chatId,
          userId: prediction.userId,
          displayName: prediction.displayName,
          points: 0,
          wins: 0,
          exacts: 0,
          total: 0,
          streak: 0,
          mapStats: [],
          eventStats: [],
          updatedAt: 0,
        };
        rows.set(prediction.userId, row);
      }
      const award = predictionAward(market, prediction);
      row.displayName = prediction.displayName;
      row.points += award.points;
      row.total++;
      if (award.win) {
        row.wins++;
        row.streak++;
      } else {
        row.streak = 0;
      }
      if (award.exact) row.exacts++;
      row.updatedAt = market.settledAt;
    }
  }
  return Array.from(rows.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt)
    .slice(0, 10);
}

function periodLeaderboard(store: CsPredictStore, chatType: PredictChatType, chatId: number, period: LeaderboardPeriod): CsPredictScoreEntry[] {
  return rangeLeaderboardRows(store, chatType, chatId, leaderboardCutoff(period));
}

function mergeMapBoardRow(rows: Map<string, CsPredictMapBoardRow>, row: CsPredictMapBoardRow): void {
  const key = `${row.userId}:${normalizeComparable(row.map)}`;
  const existing = rows.get(key);
  if (!existing) {
    rows.set(key, { ...row });
    return;
  }
  existing.displayName = row.displayName;
  existing.map = row.map;
  existing.points += row.points;
  existing.wins += row.wins;
  existing.exacts += row.exacts;
  existing.total += row.total;
  existing.updatedAt = Math.max(existing.updatedAt, row.updatedAt);
}

function parseMapLeaderboardArgs(args: string[]): { period: LeaderboardPeriod; map: string } {
  let period: LeaderboardPeriod = 'all';
  const mapTokens: string[] = [];
  for (const token of args) {
    const parsedPeriod = parseLeaderboardPeriodMaybe(token);
    if (parsedPeriod) {
      period = parsedPeriod;
      continue;
    }
    mapTokens.push(token);
  }
  const extracted = extractMapFromArgs(mapTokens);
  const map = extracted.map || normalizeMapName(extracted.args.join(' '));
  return { period, map };
}

function mapLeaderboardRows(
  store: CsPredictStore,
  chatType: PredictChatType,
  chatId: number,
  period: LeaderboardPeriod,
  mapFilter: string,
): CsPredictMapBoardRow[] {
  const rows = new Map<string, CsPredictMapBoardRow>();
  const filterKey = normalizeComparable(mapFilter);
  if (period === 'all') {
    for (const entry of store.scores) {
      if (entry.chatType !== chatType || entry.chatId !== chatId) continue;
      for (const stat of entry.mapStats || []) {
        const map = normalizeMapName(stat.map);
        if (!map || (filterKey && normalizeComparable(map) !== filterKey)) continue;
        mergeMapBoardRow(rows, {
          chatType,
          chatId,
          userId: entry.userId,
          displayName: entry.displayName,
          map,
          points: stat.points,
          wins: stat.wins,
          exacts: stat.exacts,
          total: stat.total,
          updatedAt: stat.updatedAt,
        });
      }
    }
  } else {
    const cutoff = leaderboardCutoff(period);
    const markets = store.markets
      .filter((market) => chatMatches(market, chatType, chatId) && market.status === 'settled' && market.settledAt >= cutoff)
      .sort((a, b) => a.settledAt - b.settledAt);
    for (const market of markets) {
      for (const prediction of market.predictions) {
        const map = predictionMapForStats(market, prediction);
        if (!map || (filterKey && normalizeComparable(map) !== filterKey)) continue;
        const award = predictionAward(market, prediction);
        mergeMapBoardRow(rows, {
          chatType,
          chatId,
          userId: prediction.userId,
          displayName: prediction.displayName,
          map,
          points: award.points,
          wins: award.win ? 1 : 0,
          exacts: award.exact ? 1 : 0,
          total: 1,
          updatedAt: market.settledAt,
        });
      }
    }
  }
  return Array.from(rows.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt)
    .slice(0, 10);
}

function mapLeaderboard(chatType: PredictChatType, chatId: number, args: string[] = []): string {
  const store = loadStore();
  const { period, map } = parseMapLeaderboardArgs(args);
  const rows = mapLeaderboardRows(store, chatType, chatId, period, map);
  const scope = map ? `${leaderboardPeriodLabel(period)}/${map}` : leaderboardPeriodLabel(period);
  if (rows.length === 0) {
    return [
      `当前会话${scope}还没有带地图的 CS 竞猜统计。`,
      '下注时加地图：/predict A 2-1 map Inferno，或者管理员开盘加 map Inferno。',
    ].join('\n');
  }
  return [
    `CS竞猜地图榜(${scope})`,
    ...rows.map((item, index) => `${index + 1}. ${item.displayName} ${item.map} ${item.points}分 胜${item.wins}/${item.total} 精准${item.exacts}`),
    '切换: /predict map Inferno / /predict map week Inferno / /predict board',
  ].join('\n');
}

function mergeEventBoardRow(rows: Map<string, CsPredictEventBoardRow>, row: CsPredictEventBoardRow): void {
  const key = `${row.userId}:${normalizeComparable(row.event)}`;
  const existing = rows.get(key);
  if (!existing) {
    rows.set(key, { ...row });
    return;
  }
  existing.displayName = row.displayName;
  existing.event = row.event;
  existing.points += row.points;
  existing.wins += row.wins;
  existing.exacts += row.exacts;
  existing.total += row.total;
  existing.updatedAt = Math.max(existing.updatedAt, row.updatedAt);
}

function parseEventLeaderboardArgs(args: string[]): { period: LeaderboardPeriod; event: string } {
  let period: LeaderboardPeriod = 'all';
  const eventTokens: string[] = [];
  for (const token of args) {
    const parsedPeriod = parseLeaderboardPeriodMaybe(token);
    if (parsedPeriod) {
      period = parsedPeriod;
      continue;
    }
    eventTokens.push(token);
  }
  const extracted = extractEventFromArgs(eventTokens);
  const event = extracted.event || normalizeEventName(extracted.args.join(' '));
  return { period, event };
}

function eventLeaderboardRows(
  store: CsPredictStore,
  chatType: PredictChatType,
  chatId: number,
  period: LeaderboardPeriod,
  eventFilter: string,
): CsPredictEventBoardRow[] {
  const rows = new Map<string, CsPredictEventBoardRow>();
  const filterKey = normalizeComparable(eventFilter);
  if (period === 'all') {
    for (const entry of store.scores) {
      if (entry.chatType !== chatType || entry.chatId !== chatId) continue;
      for (const stat of entry.eventStats || []) {
        const event = normalizeEventName(stat.event);
        if (!event || (filterKey && normalizeComparable(event) !== filterKey)) continue;
        mergeEventBoardRow(rows, {
          chatType,
          chatId,
          userId: entry.userId,
          displayName: entry.displayName,
          event,
          points: stat.points,
          wins: stat.wins,
          exacts: stat.exacts,
          total: stat.total,
          updatedAt: stat.updatedAt,
        });
      }
    }
  } else {
    const cutoff = leaderboardCutoff(period);
    const markets = store.markets
      .filter((market) => chatMatches(market, chatType, chatId) && market.status === 'settled' && market.settledAt >= cutoff)
      .sort((a, b) => a.settledAt - b.settledAt);
    for (const market of markets) {
      const event = predictionEventForStats(market);
      if (!event || (filterKey && normalizeComparable(event) !== filterKey)) continue;
      for (const prediction of market.predictions) {
        const award = predictionAward(market, prediction);
        mergeEventBoardRow(rows, {
          chatType,
          chatId,
          userId: prediction.userId,
          displayName: prediction.displayName,
          event,
          points: award.points,
          wins: award.win ? 1 : 0,
          exacts: award.exact ? 1 : 0,
          total: 1,
          updatedAt: market.settledAt,
        });
      }
    }
  }
  return Array.from(rows.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt)
    .slice(0, 10);
}

function eventLeaderboard(chatType: PredictChatType, chatId: number, args: string[] = []): string {
  const store = loadStore();
  const { period, event } = parseEventLeaderboardArgs(args);
  const rows = eventLeaderboardRows(store, chatType, chatId, period, event);
  const scope = event ? `${leaderboardPeriodLabel(period)}/${event}` : leaderboardPeriodLabel(period);
  if (rows.length === 0) {
    return [
      `当前会话${scope}还没有带赛事的 CS 竞猜统计。`,
      '开盘时加赛事：/predict open NAVI vs Vitality bo3 event IEM Cologne，实时 openmatch 会自动带赛事名。',
    ].join('\n');
  }
  return [
    `CS竞猜赛事榜(${scope})`,
    ...rows.map((item, index) => `${index + 1}. ${item.displayName} ${item.event} ${item.points}分 胜${item.wins}/${item.total} 精准${item.exacts}`),
    '切换: /predict event IEM Cologne / /predict event week IEM Cologne / /predict board',
  ].join('\n');
}

function seasonMatches(season: CsPredictSeason, chatType: PredictChatType, chatId: number): boolean {
  return season.chatType === chatType && season.chatId === chatId;
}

function activeSeasonForChat(store: CsPredictStore, chatType: PredictChatType, chatId: number): CsPredictSeason | undefined {
  return (store.seasons || [])
    .filter((season) => seasonMatches(season, chatType, chatId) && season.status === 'active')
    .sort((a, b) => b.startAt - a.startAt || b.updatedAt - a.updatedAt)[0];
}

function findSeasonByToken(
  store: CsPredictStore,
  chatType: PredictChatType,
  chatId: number,
  token: string,
): CsPredictSeason | undefined {
  const text = cleanSeasonName(token);
  const key = normalizeComparable(text);
  const seasons = (store.seasons || [])
    .filter((season) => seasonMatches(season, chatType, chatId))
    .sort((a, b) => b.startAt - a.startAt || b.updatedAt - a.updatedAt);
  if (!key || ['active', 'current', 'now', '当前', '进行中', '当前赛季'].includes(key)) {
    return seasons.find((season) => season.status === 'active');
  }
  if (['latest', 'last', '最近', '上一季', '上赛季'].includes(key)) return seasons[0];
  return seasons.find((season) => season.id.toLowerCase() === text.toLowerCase())
    || seasons.find((season) => normalizeComparable(season.name) === key)
    || seasons.find((season) => normalizeComparable(season.name).includes(key));
}

function seasonTimeRangeText(season: CsPredictSeason): string {
  const end = season.endAt || Date.now();
  return `${nowText(season.startAt)} ~ ${season.status === 'active' ? '进行中' : nowText(end)}`;
}

function formatScoreRows(title: string, rows: CsPredictScoreEntry[], emptyText: string, footer: string): string {
  if (rows.length === 0) return emptyText;
  return [
    title,
    ...rows.map((item, index) => `${index + 1}. ${item.displayName} ${item.points}分 胜${item.wins}/${item.total} 精准${item.exacts} 连中${item.streak}`),
    footer,
  ].join('\n');
}

function seasonLeaderboardForSeason(store: CsPredictStore, season: CsPredictSeason): string {
  const rows = rangeLeaderboardRows(store, season.chatType, season.chatId, season.startAt, season.endAt);
  const status = season.status === 'active' ? '进行中' : '已归档';
  return formatScoreRows(
    `CS竞猜积分榜(赛季榜) ${season.name} [${status}]`,
    rows,
    [
      `当前赛季 ${season.name} 还没有结算积分。`,
      `范围: ${seasonTimeRangeText(season)}`,
      '先开一盘 /predict open NAVI vs Vitality bo3，再结算就进榜。',
    ].join('\n'),
    `范围: ${seasonTimeRangeText(season)} | 赛季ID: ${season.id}`,
  );
}

function namedSeasonLeaderboardOrFallback(store: CsPredictStore, chatType: PredictChatType, chatId: number): string | null {
  const active = activeSeasonForChat(store, chatType, chatId);
  return active ? seasonLeaderboardForSeason(store, active) : null;
}

function listSeasons(chatType: PredictChatType, chatId: number): string {
  const store = loadStore();
  const seasons = (store.seasons || [])
    .filter((season) => seasonMatches(season, chatType, chatId))
    .sort((a, b) => {
      const aActive = a.status === 'active' ? 0 : 1;
      const bActive = b.status === 'active' ? 0 : 1;
      return aActive - bActive || b.startAt - a.startAt || b.updatedAt - a.updatedAt;
    })
    .slice(0, 12);
  if (seasons.length === 0) {
    return [
      'CS竞猜赛季',
      '当前会话还没有命名赛季，/predict board season 仍按近90天滚动榜显示。',
      '管理员: /predict season start 夏季赛',
    ].join('\n');
  }
  return [
    'CS竞猜赛季列表',
    ...seasons.map((season, index) => `${index + 1}. ${season.name} [${season.status === 'active' ? '进行中' : '已归档'}] ${season.id} | ${seasonTimeRangeText(season)}`),
    '看榜: /predict season board <赛季名或ID>',
  ].join('\n');
}

function seasonStatus(chatType: PredictChatType, chatId: number): string {
  const store = loadStore();
  const active = activeSeasonForChat(store, chatType, chatId);
  if (!active) {
    return [
      'CS竞猜赛季',
      '当前会话没有进行中的命名赛季。',
      '/predict board season 仍按近90天滚动榜显示。',
      '管理员开启: /predict season start 夏季赛',
    ].join('\n');
  }
  const archivedCount = (store.seasons || []).filter((season) => seasonMatches(season, chatType, chatId) && season.status === 'archived').length;
  return [
    'CS竞猜赛季',
    `当前: ${active.name} [进行中] ${active.id}`,
    `范围: ${seasonTimeRangeText(active)}`,
    `已归档: ${archivedCount}个`,
    '看榜: /predict season board；归档: /predict season archive',
  ].join('\n');
}

function startSeason(ctx: PluginContext, args: string[]): string {
  if (!isAdmin(ctx)) return '开赛季得管理员来。';
  const name = cleanSeasonName(args.join(' ')) || `赛季 ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  const store = loadStore();
  const active = activeSeasonForChat(store, ctx.chatType, ctx.chatId);
  if (active) {
    return [
      `当前已有进行中赛季: ${active.name} (${active.id})`,
      '先 /predict season archive 归档，再开新赛季。这样历史不会糊成一锅粥。',
    ].join('\n');
  }
  const now = Date.now();
  const season: CsPredictSeason = {
    id: makeSeasonId(ctx.chatType, ctx.chatId, name, now),
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    groupId: ctx.groupId,
    name,
    status: 'active',
    createdBy: ctx.event.user_id,
    createdAt: now,
    updatedAt: now,
    startAt: now,
    endAt: 0,
    archivedAt: 0,
  };
  store.seasons.push(season);
  saveStore(store);
  return [
    `CS竞猜赛季已开启: ${season.name}`,
    `赛季ID: ${season.id}`,
    `范围起点: ${nowText(season.startAt)}`,
    '后续结算盘口会进入当前赛季榜：/predict season board',
  ].join('\n');
}

function archiveSeason(ctx: PluginContext, args: string[]): string {
  if (!isAdmin(ctx)) return '归档赛季得管理员来。';
  const store = loadStore();
  const season = findSeasonByToken(store, ctx.chatType, ctx.chatId, args.join(' '));
  if (!season) return '没找到要归档的赛季。当前赛季看 /predict season status。';
  if (season.status === 'archived') return `赛季已经归档了: ${season.name}`;
  const now = Date.now();
  season.status = 'archived';
  season.endAt = now;
  season.archivedAt = now;
  season.updatedAt = now;
  saveStore(store);
  return [
    `CS竞猜赛季已归档: ${season.name}`,
    `范围: ${seasonTimeRangeText(season)}`,
    '看历史榜: /predict season board ' + season.id,
  ].join('\n');
}

function seasonBoard(chatType: PredictChatType, chatId: number, args: string[]): string {
  const store = loadStore();
  const season = findSeasonByToken(store, chatType, chatId, args.join(' '));
  if (!season) {
    return [
      '没找到这个命名赛季。',
      '看列表: /predict season list',
      '没有命名赛季时可以用 /predict board season 看近90天滚动榜。',
    ].join('\n');
  }
  return seasonLeaderboardForSeason(store, season);
}

function handleSeasonCommand(ctx: PluginContext, args: string[]): string {
  const sub = (args[0] || 'status').toLowerCase();
  const rest = args.slice(1);
  if (sub === 'start' || sub === 'open' || sub === 'new' || sub === '开启' || sub === '新赛季') return startSeason(ctx, rest);
  if (sub === 'archive' || sub === 'close' || sub === 'end' || sub === '归档' || sub === '结束') return archiveSeason(ctx, rest);
  if (sub === 'list' || sub === 'ls' || sub === '列表') return listSeasons(ctx.chatType, ctx.chatId);
  if (sub === 'board' || sub === 'rank' || sub === '榜' || sub === '积分榜') return seasonBoard(ctx.chatType, ctx.chatId, rest);
  if (sub === 'status' || sub === '状态' || sub === 'current' || sub === '当前') return seasonStatus(ctx.chatType, ctx.chatId);
  return [
    'CS竞猜赛季用法',
    '/predict season status - 当前赛季',
    '/predict season start 夏季赛 - 管理员开启命名赛季',
    '/predict season board [赛季名或ID] - 看当前/历史赛季榜',
    '/predict season archive [赛季名或ID] - 管理员归档',
    '/predict season list - 看赛季列表',
  ].join('\n');
}

function leaderboard(chatType: PredictChatType, chatId: number, period: LeaderboardPeriod = 'all'): string {
  const store = loadStore();
  if (period === 'season') {
    const namedSeason = namedSeasonLeaderboardOrFallback(store, chatType, chatId);
    if (namedSeason) return namedSeason;
  }
  const rows = period === 'all'
    ? store.scores
      .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
      .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt)
      .slice(0, 10)
    : periodLeaderboard(store, chatType, chatId, period);
  if (rows.length === 0) return `当前会话${leaderboardPeriodLabel(period)}还没有 CS 竞猜积分。先来一盘 /predict open NAVI vs Vitality。`;
  return [
    `CS竞猜积分榜(${leaderboardPeriodLabel(period)})`,
    ...rows.map((item, index) => `${index + 1}. ${item.displayName} ${item.points}分 胜${item.wins}/${item.total} 精准${item.exacts} 连中${item.streak}`),
    '切换: /predict board week / month / season / all',
  ].join('\n');
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

async function fetchPredictCandidates(maxCandidates: number, timeoutMs: number): Promise<ParsedMatchCandidate[]> {
  const raw = await withTimeout(matchesFetcher().catch(() => ''), timeoutMs, '');
  const candidates = parseMatchCandidates(raw, maxCandidates);
  return candidates;
}

function buildPredictCandidateDigestFromCandidates(candidates: ParsedMatchCandidate[], title = '【本会话CS竞猜】'): string {
  if (candidates.length === 0) return '';
  return [
    title,
    '可开盘候选:',
    ...candidates.map((match, index) => [
      `${index + 1}. ${match.teamA} vs ${match.teamB} BO${match.bestOf}`,
      match.startsAtText ? `时间 ${match.startsAtText}` : '',
      match.event ? `赛事 ${match.event}` : '',
      formatCandidateMapHint(match),
    ].filter(Boolean).join(' | ')),
    candidates[0].sourceLine ? `证据: ${candidates[0].sourceLine}` : '证据: CS实时赛程链路',
    ...realtimeMatchesFactCoverageLines(),
    realtimeMatchesBoundaryLine(),
    '操作: 管理员 /predict openmatch 1 close=30m，群友 /predict board 看榜。',
  ].join('\n');
}

async function buildPredictCandidateDigest(maxCandidates: number, timeoutMs: number): Promise<string> {
  const candidates = await fetchPredictCandidates(maxCandidates, timeoutMs);
  return buildPredictCandidateDigestFromCandidates(candidates);
}

function predictCandidateFingerprint(candidates: ParsedMatchCandidate[]): string {
  const normalized = candidates
    .slice(0, CANDIDATE_NOTIFY_MAX_ITEMS)
    .map((match) => [
      normalizeComparable(match.teamA),
      normalizeComparable(match.teamB),
      cleanText(match.startsAtText || '', 32).toLowerCase(),
      cleanText(match.event || '', 48).toLowerCase(),
      cleanText(match.mapHint || match.map || '', 80).toLowerCase(),
    ].join('|'))
    .join('\n');
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export async function buildCsPredictDigestForChat(
  chatType: PredictChatType,
  chatId: number,
  options: { maxActive?: number; maxRecent?: number; maxBoard?: number; maxCandidates?: number; maxChars?: number; timeoutMs?: number } = {},
): Promise<string> {
  const store = loadStore();
  const changed = lockExpiredMarkets(store, chatType, chatId);
  if (changed) saveStore(store);

  const maxActive = Math.max(1, options.maxActive || 3);
  const maxRecent = Math.max(1, options.maxRecent || 2);
  const maxBoard = Math.max(1, options.maxBoard || 5);
  const maxCandidates = Math.max(1, options.maxCandidates || 3);
  const maxChars = Math.max(400, options.maxChars || 1100);
  const timeoutMs = Math.max(1000, options.timeoutMs || 3500);
  const markets = store.markets.filter((market) => chatMatches(market, chatType, chatId));
  const active = markets
    .filter((market) => market.status === 'open' || market.status === 'closed')
    .sort((a, b) => {
      const aOpen = a.status === 'open' ? 0 : 1;
      const bOpen = b.status === 'open' ? 0 : 1;
      return aOpen - bOpen || (a.closesAt || a.createdAt) - (b.closesAt || b.createdAt);
    })
    .slice(0, maxActive);
  const recent = markets
    .filter((market) => market.status === 'settled' || market.status === 'cancelled')
    .sort((a, b) => (b.settledAt || b.cancelledAt || b.updatedAt) - (a.settledAt || a.cancelledAt || a.updatedAt))
    .slice(0, maxRecent);
  const rows = store.scores
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt)
    .slice(0, maxBoard);
  if (active.length === 0 && recent.length === 0 && rows.length === 0) {
    const candidateDigest = await buildPredictCandidateDigest(maxCandidates, timeoutMs);
    return candidateDigest.length > maxChars ? `${candidateDigest.slice(0, maxChars)}...` : candidateDigest;
  }

  const lines: string[] = ['【本会话CS竞猜】'];
  if (active.length > 0) {
    lines.push('当前盘口:');
    for (const market of active) {
      lines.push(`- ${formatMarketLine(market)}`);
      const mapEvidence = formatMarketMapEvidenceLine(market);
      if (mapEvidence) lines.push(`  ${mapEvidence}`);
    }
  }
  if (recent.length > 0) {
    lines.push('最近结算:');
    for (const market of recent) {
      lines.push(`- ${formatMarketLine(market)}`);
    }
  }
  if (rows.length > 0) {
    lines.push('积分榜:');
    for (const [index, item] of rows.entries()) {
      lines.push(`${index + 1}. ${item.displayName} ${item.points}分 胜${item.wins}/${item.total} 精准${item.exacts}`);
    }
  }
  lines.push('操作: /predict matches 看赛程候选，/predict board 看完整榜。');
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function chatHasOpenMarket(store: CsPredictStore, chatType: PredictChatType, chatId: number): boolean {
  return store.markets.some((market) => chatMatches(market, chatType, chatId) && market.status === 'open');
}

function buildCandidateNotifyMessage(candidates: ParsedMatchCandidate[]): string {
  return [
    'CS竞猜开盘候选提醒',
    '当前会话还没有开盘盘口，给你们抓了几场能开的：',
    ...candidates.slice(0, CANDIDATE_NOTIFY_MAX_ITEMS).map((match, index) => [
      `${index + 1}. ${match.teamA} vs ${match.teamB} BO${match.bestOf}`,
      match.startsAtText ? `时间 ${match.startsAtText}` : '',
      match.event ? `赛事 ${match.event}` : '',
      formatCandidateMapHint(match),
    ].filter(Boolean).join(' | ')),
    candidates[0]?.sourceLine ? `证据: ${candidates[0].sourceLine}` : '证据: CS实时赛程链路',
    ...realtimeMatchesFactCoverageLines(),
    realtimeMatchesBoundaryLine(),
    '管理员开盘: /predict openmatch 1 close=30m',
    '关闭提醒: /predict notify off',
  ].join('\n');
}

async function sendCandidateNotifyMessage(bot: PredictBot, sub: CsPredictCandidateSubscription, message: string): Promise<boolean> {
  if (sub.chatType === 'group' && sub.groupId && bot.sendGroupMessage) {
    return bot.sendGroupMessage(sub.groupId, message);
  }
  if (sub.chatType === 'private' && bot.sendPrivateMessage) {
    return bot.sendPrivateMessage(sub.chatId, message);
  }
  return false;
}

function upsertCandidateNotify(ctx: PluginContext, args: string[]): string {
  if (!isAdmin(ctx)) return '开盘候选自动提醒得管理员来。';
  const intervalMinutes = parseCandidateNotifyInterval(args);
  const now = Date.now();
  const store = loadStore();
  let sub = store.candidateSubscriptions.find((item) => item.chatType === ctx.chatType && item.chatId === ctx.chatId);
  if (!sub) {
    sub = {
      id: makeCandidateNotifyId(ctx.chatType, ctx.chatId),
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      groupId: ctx.groupId,
      createdBy: ctx.event.user_id,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      intervalMinutes,
      lastCheckedAt: 0,
      lastSentAt: 0,
      lastFingerprint: '',
      lastError: '',
    };
    store.candidateSubscriptions.push(sub);
  } else {
    sub.enabled = true;
    sub.groupId = ctx.groupId || sub.groupId;
    sub.intervalMinutes = intervalMinutes;
    sub.updatedAt = now;
    sub.lastError = '';
  }
  saveStore(store);
  return [
    'CS竞猜开盘候选提醒已开启',
    `间隔: ${intervalMinutes}分钟`,
    '触发条件: 当前会话没有开盘盘口，且实时赛程解析到可开盘候选。',
    '手动查看: /predict notify check；关闭: /predict notify off',
  ].join('\n');
}

function removeCandidateNotify(ctx: PluginContext): string {
  if (!isAdmin(ctx)) return '关闭开盘候选提醒得管理员来。';
  const store = loadStore();
  const before = store.candidateSubscriptions.length;
  store.candidateSubscriptions = store.candidateSubscriptions.filter((item) => !(item.chatType === ctx.chatType && item.chatId === ctx.chatId));
  if (store.candidateSubscriptions.length === before) return '本会话没有开启 CS竞猜开盘候选提醒。';
  saveStore(store);
  return '已关闭本会话 CS竞猜开盘候选提醒。';
}

function formatCandidateNotifyStatus(chatType: PredictChatType, chatId: number): string {
  const store = loadStore();
  const sub = store.candidateSubscriptions.find((item) => item.enabled && item.chatType === chatType && item.chatId === chatId);
  const stats = getCsPredictStats();
  if (!sub) {
    return [
      'CS竞猜开盘候选提醒',
      '当前会话: 未开启',
      `/predict notify on ${DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES}m - 开启自动提醒`,
      `全局: ${stats.candidateNotifySubscriptions}个 最近${nowText(stats.lastCandidateRunAt)} 检查${stats.lastCandidateRunChecked}/${stats.lastCandidateRunDue} 推送${stats.lastCandidateRunSent}${stats.lastCandidateRunError ? ` 错误=${stats.lastCandidateRunError}` : ''}`,
    ].join('\n');
  }
  return [
    'CS竞猜开盘候选提醒',
    `当前会话: 已开启 间隔${sub.intervalMinutes}分钟`,
    `订阅ID: ${sub.id}`,
    `上次检查: ${nowText(sub.lastCheckedAt)}`,
    `上次推送: ${nowText(sub.lastSentAt)}`,
    sub.lastError ? `最近状态: ${sub.lastError}` : '',
    `全局: ${stats.candidateNotifySubscriptions}个 最近${nowText(stats.lastCandidateRunAt)} 检查${stats.lastCandidateRunChecked}/${stats.lastCandidateRunDue} 推送${stats.lastCandidateRunSent}${stats.lastCandidateRunError ? ` 错误=${stats.lastCandidateRunError}` : ''}`,
  ].filter(Boolean).join('\n');
}

async function checkCandidateNotifyNow(): Promise<string> {
  const candidates = await fetchPredictCandidates(5, 6500);
  if (candidates.length === 0) {
    return [
      'CS竞猜开盘候选检查',
      '这次没解析到明确的 TeamA vs TeamB 赛程。',
      ...realtimeMatchesFactCoverageLines(),
      realtimeMatchesBoundaryLine(),
      noRealtimeMatchCandidateBoundaryLine(),
      '可以先 /cs match 看原始数据，或者手动 /predict open NAVI vs Vitality。',
    ].join('\n');
  }
  return buildPredictCandidateDigestFromCandidates(candidates, 'CS竞猜开盘候选检查');
}

async function handleCandidateNotifyCommand(ctx: PluginContext, args: string[]): Promise<string> {
  const mode = (args[0] || 'status').toLowerCase();
  const rest = args.slice(1);
  if (mode === 'on' || mode === 'enable' || mode === '开启' || mode === '打开') return upsertCandidateNotify(ctx, rest);
  if (mode === 'off' || mode === 'disable' || mode === '关闭' || mode === '取消') return removeCandidateNotify(ctx);
  if (mode === 'check' || mode === 'now' || mode === 'run' || mode === '检查' || mode === '立即') return checkCandidateNotifyNow();
  if (mode === 'status' || mode === 'list' || mode === '状态') return formatCandidateNotifyStatus(ctx.chatType, ctx.chatId);
  return [
    'CS竞猜开盘候选提醒用法',
    `/predict notify on ${DEFAULT_CANDIDATE_NOTIFY_INTERVAL_MINUTES}m - 管理员开启`,
    '/predict notify status - 查看状态',
    '/predict notify check - 立即看候选',
    '/predict notify off - 关闭',
  ].join('\n');
}

function buildPredictMapTrainingHint(row: CsPredictScoreEntry): string {
  const stats = normalizeMapStats(row.mapStats || [], row.updatedAt);
  if (stats.length === 0) return '';
  const byStrength = [...stats].sort((a, b) => {
    const aWinRate = a.wins / Math.max(1, a.total);
    const bWinRate = b.wins / Math.max(1, b.total);
    return bWinRate - aWinRate || b.points - a.points || b.exacts - a.exacts || b.total - a.total;
  });
  const best = byStrength[0];
  const weak = [...stats]
    .filter((item) => item.total >= 2)
    .sort((a, b) => {
      const aWinRate = a.wins / Math.max(1, a.total);
      const bWinRate = b.wins / Math.max(1, b.total);
      return aWinRate - bWinRate || a.points - b.points || a.exacts - b.exacts;
    })[0];
  if (!best) return '';
  if (weak && normalizeComparable(weak.map) !== normalizeComparable(best.map)) {
    return `地图样本：${best.map}最稳 胜${best.wins}/${best.total} 精准${best.exacts}；${weak.map}要补课 胜${weak.wins}/${weak.total}。`;
  }
  return `地图样本：${best.map}手感最好 胜${best.wins}/${best.total} 精准${best.exacts}，今天训练可以顺着这张图复盘两回合。`;
}

function buildPredictEventTrainingHint(row: CsPredictScoreEntry): string {
  const stats = normalizeEventStats(row.eventStats || [], row.updatedAt);
  if (stats.length === 0) return '';
  const best = [...stats].sort((a, b) => {
    const aWinRate = a.wins / Math.max(1, a.total);
    const bWinRate = b.wins / Math.max(1, b.total);
    return bWinRate - aWinRate || b.points - a.points || b.exacts - a.exacts || b.total - a.total;
  })[0];
  const weak = [...stats]
    .filter((item) => item.total >= 2)
    .sort((a, b) => {
      const aWinRate = a.wins / Math.max(1, a.total);
      const bWinRate = b.wins / Math.max(1, b.total);
      return aWinRate - bWinRate || a.points - b.points || a.exacts - b.exacts;
    })[0];
  if (!best) return '';
  if (weak && normalizeComparable(weak.event) !== normalizeComparable(best.event)) {
    return `赛事样本：${best.event}判断最稳 胜${best.wins}/${best.total}；${weak.event}别闭眼押，赛前多看一眼赛制和队伍近况。`;
  }
  return `赛事样本：${best.event}目前最顺 胜${best.wins}/${best.total}，保持先看赛制、地图池和状态证据。`;
}

function buildOpenMarketMapPoolTrainingHint(openMarkets: CsPredictionMarket[]): string {
  const withMapEvidence = openMarkets
    .map((market) => ({ market, analysis: analyzeMarketMapHint(market) }))
    .filter((item): item is { market: CsPredictionMarket; analysis: MapVetoAnalysis } => !!item.analysis);
  if (withMapEvidence.length === 0) return '';
  const pools = withMapEvidence
    .filter((item) => item.analysis.mode === 'pool')
    .slice(0, 2)
    .map((item) => `${item.market.id} ${item.analysis.maps.join('/')}`);
  if (pools.length > 0) {
    return `当前盘口地图池：${pools.join('；')} 只是赛前线索，训练加练“确认单图再下 map”，别把 mappool 当地图榜分数。`;
  }
  const singles = withMapEvidence
    .filter((item) => item.analysis.mode === 'single')
    .slice(0, 2)
    .map((item) => `${item.market.id} ${item.analysis.singleMap}`);
  if (singles.length > 0) {
    return `当前盘口单图：${singles.join('；')}，下注和复盘都可以围绕这张图看经济、道具和节奏。`;
  }
  return '';
}

export function getCsPredictTrainingHint(chatType: PredictChatType, chatId: number, userId: number): string {
  const store = loadStore();
  const rows = store.scores
    .filter((item) => item.chatType === chatType && item.chatId === chatId && item.total > 0)
    .sort((a, b) => b.points - a.points || b.exacts - a.exacts || b.wins - a.wins || b.updatedAt - a.updatedAt);
  const row = rows.find((item) => item.userId === userId);
  const openMarkets = store.markets
    .filter((market) => chatMatches(market, chatType, chatId) && market.status === 'open');
  const openMarketMapHint = buildOpenMarketMapPoolTrainingHint(openMarkets);

  if (!row) {
    if (openMarkets.length > 0) {
      return [
        `竞猜表现：本会话有 ${openMarkets.length} 个未结算盘口。训练加练 6 分钟赛前信息判断，先想地图池、近况和经济节奏，再下注别闭眼开。`,
        openMarketMapHint,
      ].filter(Boolean).join('\n');
    }
    return '';
  }

  const rank = rows.findIndex((item) => item.userId === userId) + 1;
  const winRate = Math.round((row.wins / Math.max(1, row.total)) * 100);
  const exactRate = Math.round((row.exacts / Math.max(1, row.total)) * 100);
  const base = `竞猜表现：${row.points}分 第${rank}/${rows.length}，胜率${winRate}% 精准${exactRate}% 连中${row.streak}。`;
  let advice = '今天训练重点放在“判断之后的执行”：练完枪再复盘两回合，看看自己有没有按判断去打。';
  if (row.total < 3) {
    advice = '样本还少，今天先练基础信息判断：看阵容、地图和经济，写一句赛前理由再下结论。';
  } else if (winRate < 40) {
    advice = '判断偏危险，今天加 8 分钟 demo 复盘，重点看地图池、手枪局和经济局，别只凭队名下判断。';
  } else if (exactRate < 20) {
    advice = '胜负方向还行，比分细节不稳；今天多看地图节奏和一图/三图倾向，别上来就 2-0。';
  } else if (row.streak >= 2 || winRate >= 70) {
    advice = '判断挺准，今天别飘：练默认控图和补枪距离，把“看懂了”变成“打出来”。';
  }
  return [base, buildPredictMapTrainingHint(row), buildPredictEventTrainingHint(row), openMarketMapHint, `个性化加练：${advice}`].filter(Boolean).join('\n');
}

function myPredictions(ctx: PluginContext): string {
  const store = loadStore();
  lockExpiredMarkets(store, ctx.chatType, ctx.chatId);
  const markets = store.markets
    .filter((market) => chatMatches(market, ctx.chatType, ctx.chatId))
    .filter((market) => market.status === 'open' || market.status === 'closed')
    .map((market) => {
      const prediction = market.predictions.find((item) => item.userId === ctx.event.user_id);
      if (!prediction) return '';
      const map = predictionMapForStats(market, prediction);
      const event = predictionEventForStats(market);
      return `${market.id} ${market.title} | ${choiceName(market, prediction.choice)} ${prediction.score}${event ? ` | 赛事 ${event}` : ''}${map ? ` | 地图 ${map}` : ''} | ${statusText(market.status)}`;
    })
    .filter(Boolean);
  if (markets.length === 0) return '你当前没有未结算预测。';
  return ['我的CS竞猜', ...markets].join('\n');
}

function parseNaturalPredict(rawText: string): string[] | null {
  const text = (rawText || '').trim();
  if (/^(?:竞猜榜|预测榜|cs竞猜榜|cs预测榜)$/i.test(text)) return ['board'];
  if (/^(?:竞猜|预测|cs竞猜|cs预测)(?:周榜|本周榜)$/i.test(text)) return ['board', 'week'];
  if (/^(?:竞猜|预测|cs竞猜|cs预测)(?:月榜|本月榜)$/i.test(text)) return ['board', 'month'];
  if (/^(?:竞猜|预测|cs竞猜|cs预测)(?:赛季榜|季度榜)$/i.test(text)) return ['board', 'season'];
  if (/^(?:竞猜|预测|cs竞猜|cs预测)(?:地图榜|图榜|地图)$/i.test(text)) return ['map'];
  const mapBoard = text.match(/^(?:竞猜|预测|cs竞猜|cs预测)(?:地图榜|图榜|地图)\s+(.{1,30})$/i);
  if (mapBoard?.[1]) return ['map', mapBoard[1]];
  if (/^(?:竞猜|预测|cs竞猜|cs预测)(?:赛事榜|比赛榜|赛事)$/i.test(text)) return ['event'];
  const eventBoard = text.match(/^(?:竞猜|预测|cs竞猜|cs预测)(?:赛事榜|比赛榜|赛事)\s+(.{1,50})$/i);
  if (eventBoard?.[1]) return ['event', eventBoard[1]];
  const pick = text.match(/^(?:竞猜|预测|压|我压|我猜)\s+(.{1,80})$/i);
  if (pick?.[1]) return ['pick', ...pick[1].trim().split(/\s+/)];
  return null;
}

export async function runCsPredictAutoSettle(bot: PredictBot): Promise<{ checked: number; settled: number; sent: number; errors: number; resultCandidates: number }> {
  if (predictAutoRunning) return { checked: 0, settled: 0, sent: 0, errors: 0, resultCandidates: 0 };
  predictAutoRunning = true;
  lastAutoRunAt = Date.now();
  lastAutoRunError = '';
  try {
    const store = loadStore();
    const lockedChanged = lockExpiredMarkets(store);
    const activeMarkets = store.markets.filter((market) => market.status === 'open' || market.status === 'closed');
    if (activeMarkets.length === 0) {
      if (lockedChanged) saveStore(store);
      lastAutoRunChecked = 0;
      lastAutoRunSettled = 0;
      lastAutoRunSent = 0;
      return { checked: 0, settled: 0, sent: 0, errors: 0, resultCandidates: 0 };
    }

    const raw = await resultsFetcher().catch((err) => {
      lastAutoRunError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      return '';
    });
    const results = parseResultCandidates(raw, 20);
    if (results.length === 0) {
      if (lockedChanged) saveStore(store);
      lastAutoRunChecked = activeMarkets.length;
      lastAutoRunSettled = 0;
      lastAutoRunSent = 0;
      if (!lastAutoRunError) lastAutoRunError = 'no parsed recent results';
      return { checked: activeMarkets.length, settled: 0, sent: 0, errors: lastAutoRunError ? 1 : 0, resultCandidates: 0 };
    }

    const result = settleMarketsFromResults(store, results);
    if (lockedChanged || result.settled.length > 0) saveStore(store);

    let sent = 0;
    let errors = 0;
    for (const item of result.settled) {
      const ok = await sendPredictMessage(bot, item.market, buildAutoSettleNotification(item)).catch(() => false);
      if (ok) sent++;
      else errors++;
    }

    lastAutoRunChecked = result.checked;
    lastAutoRunSettled = result.settled.length;
    lastAutoRunSent = sent;
    if (errors > 0) lastAutoRunError = `send failed ${errors}`;
    return { checked: result.checked, settled: result.settled.length, sent, errors, resultCandidates: results.length };
  } catch (err) {
    lastAutoRunError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    return { checked: 0, settled: 0, sent: 0, errors: 1, resultCandidates: 0 };
  } finally {
    predictAutoRunning = false;
  }
}

export async function runCsPredictCandidateNotifications(
  bot: PredictBot,
  date: Date = new Date(),
): Promise<{ checked: number; due: number; candidates: number; sent: number; skipped: number; errors: number }> {
  if (candidateNotifyRunning) return { checked: 0, due: 0, candidates: 0, sent: 0, skipped: 0, errors: 0 };
  candidateNotifyRunning = true;
  const now = date.getTime();
  lastCandidateRunAt = Date.now();
  lastCandidateRunError = '';
  try {
    const store = loadStore();
    const lockedChanged = lockExpiredMarkets(store);
    const enabledSubs = store.candidateSubscriptions.filter((sub) => sub.enabled);
    const dueSubs = enabledSubs.filter((sub) => {
      const intervalMs = clampCandidateIntervalMinutes(sub.intervalMinutes) * 60 * 1000;
      const lastTouched = Math.max(sub.lastCheckedAt || 0, sub.lastSentAt || 0);
      return !lastTouched || now - lastTouched >= intervalMs;
    });
    lastCandidateRunChecked = enabledSubs.length;
    lastCandidateRunDue = dueSubs.length;
    lastCandidateRunSent = 0;
    if (dueSubs.length === 0) {
      if (lockedChanged) saveStore(store);
      return { checked: enabledSubs.length, due: 0, candidates: 0, sent: 0, skipped: 0, errors: 0 };
    }

    const candidates = await fetchPredictCandidates(CANDIDATE_NOTIFY_MAX_ITEMS, 6500);
    if (candidates.length === 0) {
      for (const sub of dueSubs) {
        sub.lastCheckedAt = now;
        sub.updatedAt = now;
        sub.lastError = 'no parsed match candidates';
      }
      saveStore(store);
      lastCandidateRunError = 'no parsed match candidates';
      return { checked: enabledSubs.length, due: dueSubs.length, candidates: 0, sent: 0, skipped: dueSubs.length, errors: 0 };
    }

    const fingerprint = predictCandidateFingerprint(candidates);
    const message = buildCandidateNotifyMessage(candidates);
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const sub of dueSubs) {
      sub.lastCheckedAt = now;
      sub.updatedAt = now;
      if (chatHasOpenMarket(store, sub.chatType, sub.chatId)) {
        skipped++;
        sub.lastError = 'current chat has open market';
        continue;
      }
      if (sub.lastFingerprint === fingerprint && sub.lastSentAt && now - sub.lastSentAt < CANDIDATE_NOTIFY_DUP_WINDOW_MS) {
        skipped++;
        sub.lastError = 'same candidates recently sent';
        continue;
      }
      const ok = await sendCandidateNotifyMessage(bot, sub, message).catch(() => false);
      if (ok) {
        sent++;
        sub.lastSentAt = now;
        sub.lastFingerprint = fingerprint;
        sub.lastError = '';
      } else {
        errors++;
        sub.lastError = 'send failed';
      }
    }

    saveStore(store);
    lastCandidateRunSent = sent;
    if (errors > 0) lastCandidateRunError = `send failed ${errors}`;
    return { checked: enabledSubs.length, due: dueSubs.length, candidates: candidates.length, sent, skipped, errors };
  } catch (err) {
    lastCandidateRunError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    return { checked: 0, due: 0, candidates: 0, sent: 0, skipped: 0, errors: 1 };
  } finally {
    candidateNotifyRunning = false;
  }
}

export function startCsPredictTasks(bot: PredictBot, intervalMinutes: number = DEFAULT_AUTO_SETTLE_INTERVAL_MINUTES): void {
  shutdownCsPredictTasks();
  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
  predictTimer = setInterval(() => {
    void (async () => {
      await runCsPredictAutoSettle(bot);
      await runCsPredictCandidateNotifications(bot);
    })();
  }, intervalMs);
  predictTimer.unref();
}

export function shutdownCsPredictTasks(): void {
  if (predictTimer) {
    clearInterval(predictTimer);
    predictTimer = null;
  }
}

export function getCsPredictStats(): {
  markets: number;
  openMarkets: number;
  closedMarkets: number;
  settledMarkets: number;
  cancelledMarkets: number;
  predictions: number;
  scoreEntries: number;
  mapStats: number;
  eventStats: number;
  seasons: number;
  activeSeasons: number;
  lastSettledAt: number;
  running: boolean;
  timerEnabled: boolean;
  lastRunAt: number;
  lastRunChecked: number;
  lastRunSettled: number;
  lastRunSent: number;
  lastRunError: string;
  candidateNotifySubscriptions: number;
  candidateNotifyRunning: boolean;
  lastCandidateRunAt: number;
  lastCandidateRunChecked: number;
  lastCandidateRunDue: number;
  lastCandidateRunSent: number;
  lastCandidateRunError: string;
} {
  const store = loadStore();
  lockExpiredMarkets(store);
  let lastSettledAt = 0;
  for (const market of store.markets) {
    if (market.settledAt > lastSettledAt) lastSettledAt = market.settledAt;
  }
  return {
    markets: store.markets.length,
    openMarkets: store.markets.filter((market) => market.status === 'open').length,
    closedMarkets: store.markets.filter((market) => market.status === 'closed').length,
    settledMarkets: store.markets.filter((market) => market.status === 'settled').length,
    cancelledMarkets: store.markets.filter((market) => market.status === 'cancelled').length,
    predictions: store.markets.reduce((sum, market) => sum + market.predictions.length, 0),
    scoreEntries: store.scores.length,
    mapStats: store.scores.reduce((sum, entry) => sum + (entry.mapStats || []).length, 0),
    eventStats: store.scores.reduce((sum, entry) => sum + (entry.eventStats || []).length, 0),
    seasons: (store.seasons || []).length,
    activeSeasons: (store.seasons || []).filter((season) => season.status === 'active').length,
    lastSettledAt,
    running: predictAutoRunning || candidateNotifyRunning,
    timerEnabled: !!predictTimer,
    lastRunAt: lastAutoRunAt,
    lastRunChecked: lastAutoRunChecked,
    lastRunSettled: lastAutoRunSettled,
    lastRunSent: lastAutoRunSent,
    lastRunError: lastAutoRunError,
    candidateNotifySubscriptions: store.candidateSubscriptions.filter((sub) => sub.enabled).length,
    candidateNotifyRunning,
    lastCandidateRunAt,
    lastCandidateRunChecked,
    lastCandidateRunDue,
    lastCandidateRunSent,
    lastCandidateRunError,
  };
}

export function getCsPredictPrewarmTargets(options: {
  chats?: Array<{ chatType: PredictChatType; chatId: number }>;
  maxTargets?: number;
} = {}): { subject: string; marketId: string; updatedAt: number }[] {
  const store = loadStore();
  const chatKeys = new Set((options.chats || []).map((chat) => `${chat.chatType}:${chat.chatId}`));
  const maxTargets = Math.max(1, options.maxTargets || 8);
  const seen = new Set<string>();
  const targets: { subject: string; marketId: string; updatedAt: number }[] = [];
  const markets = store.markets
    .filter((market) => market.status === 'open' || market.status === 'closed')
    .filter((market) => chatKeys.size === 0 || chatKeys.has(`${market.chatType}:${market.chatId}`))
    .sort((a, b) => {
      const aTime = a.closesAt || a.updatedAt || a.createdAt;
      const bTime = b.closesAt || b.updatedAt || b.createdAt;
      return aTime - bTime;
    });

  for (const market of markets) {
    for (const subject of [market.teamA, market.teamB]) {
      const cleaned = cleanText(subject, 32);
      const key = normalizeComparable(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      targets.push({ subject: cleaned, marketId: market.id, updatedAt: market.updatedAt });
      if (targets.length >= maxTargets) return targets;
    }
  }
  return targets;
}

export const csPredictPlugin: Plugin = {
  name: 'cs-predict',
  description: 'CS比赛竞猜和积分榜',
  handler: async (ctx) => {
    const naturalArgs = ctx.command ? null : parseNaturalPredict(ctx.rawText);
    if (ctx.command !== 'predict' && ctx.command !== '竞猜' && !naturalArgs) return false;
    const args = naturalArgs || ctx.args;
    const sub = (args[0] || 'list').toLowerCase();
    const rest = args.slice(1);

    if (sub === 'help' || sub === '用法') {
      ctx.reply(usage());
      return true;
    }
    if (sub === 'open' || sub === '开盘') {
      ctx.reply(openMarket(ctx, rest));
      return true;
    }
    if (sub === 'matches' || sub === 'match' || sub === '赛程' || sub === '候选') {
      ctx.reply(await listRealtimeMatches());
      return true;
    }
    if (sub === 'openmatch' || sub === 'open-next' || sub === '实时开盘') {
      ctx.reply(await openMarketFromRealtime(ctx, rest));
      return true;
    }
    if (sub === 'matchmap' || sub === 'matchmaps' || sub === 'matchveto' || sub === '单场地图' || sub === '单场选图') {
      ctx.reply(await formatMatchMapPreview(rest));
      return true;
    }
    if (sub === 'notify' || sub === 'remind' || sub === '提醒' || sub === '候选提醒') {
      ctx.reply(await handleCandidateNotifyCommand(ctx, rest));
      return true;
    }
    if (sub === 'list' || sub === 'status' || sub === '盘口') {
      ctx.reply(listMarkets(ctx.chatType, ctx.chatId));
      return true;
    }
    if (sub === 'veto' || sub === 'mappool' || sub === 'maphint' || sub === 'mapcheck' || sub === '地图池' || sub === '选图' || sub === '选图预检' || sub === '地图预检') {
      ctx.reply(formatMapVetoPreview(rest));
      return true;
    }
    if (sub === 'season' || sub === 'seasons' || sub === '赛季' || sub === '赛季管理') {
      ctx.reply(handleSeasonCommand(ctx, rest));
      return true;
    }
    if (['week', 'weekly', 'month', 'monthly', 'season', '周榜', '月榜', '赛季榜'].includes(sub)) {
      ctx.reply(leaderboard(ctx.chatType, ctx.chatId, parseLeaderboardPeriod(sub)));
      return true;
    }
    if (sub === 'map' || sub === 'maps' || sub === 'mapboard' || sub === '地图' || sub === '地图榜' || sub === '图榜') {
      ctx.reply(mapLeaderboard(ctx.chatType, ctx.chatId, rest));
      return true;
    }
    if (sub === 'event' || sub === 'events' || sub === 'eventboard' || sub === '赛事' || sub === '赛事榜' || sub === '比赛榜') {
      ctx.reply(eventLeaderboard(ctx.chatType, ctx.chatId, rest));
      return true;
    }
    if (sub === 'board' || sub === 'rank' || sub === '榜' || sub === '排行榜' || sub === '积分榜') {
      if (['map', 'maps', 'mapboard', '地图', '地图榜', '图榜'].includes((rest[0] || '').toLowerCase())) {
        ctx.reply(mapLeaderboard(ctx.chatType, ctx.chatId, rest.slice(1)));
        return true;
      }
      if (['event', 'events', 'eventboard', '赛事', '赛事榜', '比赛榜'].includes((rest[0] || '').toLowerCase())) {
        ctx.reply(eventLeaderboard(ctx.chatType, ctx.chatId, rest.slice(1)));
        return true;
      }
      ctx.reply(leaderboard(ctx.chatType, ctx.chatId, parseLeaderboardPeriod(rest[0])));
      return true;
    }
    if (sub === 'mine' || sub === 'me' || sub === '我的') {
      ctx.reply(myPredictions(ctx));
      return true;
    }
    if (sub === 'close' || sub === '封盘') {
      ctx.reply(closeMarket(ctx, rest[0] || ''));
      return true;
    }
    if (sub === 'settle' || sub === '结算') {
      ctx.reply(settleMarket(ctx, rest));
      return true;
    }
    if (sub === 'autosettle' || sub === 'auto-settle' || sub === '自动结算') {
      ctx.reply(await autoSettleMarkets(ctx));
      return true;
    }
    if (sub === 'cancel' || sub === '取消') {
      ctx.reply(cancelMarket(ctx, rest[0] || ''));
      return true;
    }
    if (sub === 'pick' || sub === 'bet' || sub === '压' || sub === '猜') {
      ctx.reply(placePrediction(ctx, rest));
      return true;
    }
    ctx.reply(placePrediction(ctx, args));
    return true;
  },
};

export const __test = {
  setStorePathForTests(filepath?: string): void {
    storePathOverride = filepath || '';
  },
  setRealtimeFetchersForTests(fetchers?: { matches?: () => Promise<string>; results?: () => Promise<string> }): void {
    matchesFetcher = fetchers?.matches || fetchOngoingMatches;
    resultsFetcher = fetchers?.results || fetchRecentResults;
  },
  resetForTests(): void {
    shutdownCsPredictTasks();
    storePathOverride = '';
    matchesFetcher = fetchOngoingMatches;
    resultsFetcher = fetchRecentResults;
    predictAutoRunning = false;
    lastAutoRunAt = 0;
    lastAutoRunChecked = 0;
    lastAutoRunSettled = 0;
    lastAutoRunSent = 0;
    lastAutoRunError = '';
    candidateNotifyRunning = false;
    lastCandidateRunAt = 0;
    lastCandidateRunChecked = 0;
    lastCandidateRunDue = 0;
    lastCandidateRunSent = 0;
    lastCandidateRunError = '';
  },
  loadStoreForTests: loadStore,
  runCsPredictAutoSettle,
  runCsPredictCandidateNotifications,
  normalizeScore,
  parseOpenArgs,
  parseMapVetoPreview,
  analyzeMapVetoPreview,
  formatMatchMapPreview,
  formatMarketMapEvidenceLine,
  parseMatchCandidates,
  parseResultCandidates,
};
