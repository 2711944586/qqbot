import * as fs from 'fs';
import * as path from 'path';
import { PluginContext } from '../types';

type ProfileChatType = 'group' | 'private';
type ProfileField = 'teams' | 'players' | 'maps' | 'tone' | 'note';

interface UserProfile {
  chatType: ProfileChatType;
  chatId: number;
  userId: number;
  displayName: string;
  favoriteTeams: string[];
  favoritePlayers: string[];
  favoriteMaps: string[];
  tone: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}

interface UserProfileStore {
  version: 1;
  profiles: UserProfile[];
}

interface StoreStamp {
  exists: boolean;
  mtimeMs: number;
  size: number;
}

const DEFAULT_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'user-profiles.json');
const MAX_VALUES = 8;
let storePathOverride = '';
let cachedStore: UserProfileStore | null = null;
let cachedPath = '';
let cachedStamp: StoreStamp = { exists: false, mtimeMs: 0, size: 0 };
let cacheHits = 0;
let diskReads = 0;
let diskWrites = 0;
let parseErrors = 0;
let lastLoadedAt = 0;
let lastSavedAt = 0;
let lastError = '';

function storePath(): string {
  return storePathOverride || DEFAULT_STORE_PATH;
}

function emptyStore(): UserProfileStore {
  return { version: 1, profiles: [] };
}

function cleanProfileText(value: string, max = 80): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/[|`<>]/g, '')
    .trim()
    .slice(0, max);
}

function normalizeComparable(value: string): string {
  return cleanProfileText(value, 80).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanProfileText(value, 32);
    const key = normalizeComparable(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_VALUES) break;
  }
  return result;
}

function splitProfileValues(raw: string): string[] {
  return uniqueValues((raw || '')
    .split(/[\/,，、;；]+|\s{2,}/)
    .map((item) => item.trim())
    .filter(Boolean));
}

function normalizeField(raw: string): ProfileField | null {
  const value = (raw || '').toLowerCase();
  if (['team', 'teams', '队伍', '战队', '主队'].includes(value)) return 'teams';
  if (['player', 'players', '选手', '职业哥'].includes(value)) return 'players';
  if (['map', 'maps', '地图'].includes(value)) return 'maps';
  if (['tone', 'style', '语气', '风格', '口吻'].includes(value)) return 'tone';
  if (['note', 'notes', '备注', '偏好', '补充'].includes(value)) return 'note';
  return null;
}

function statStore(filepath: string): StoreStamp {
  try {
    const stat = fs.statSync(filepath);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      lastError = err instanceof Error ? err.message : String(err);
    }
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function sameStamp(a: StoreStamp, b: StoreStamp): boolean {
  return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function sanitizeStore(raw: any): UserProfileStore {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  return {
    version: 1,
    profiles: profiles
      .filter((item: Partial<UserProfile>) => item && item.chatId && item.userId)
      .map((item: UserProfile) => ({
        chatType: item.chatType === 'private' ? 'private' : 'group',
        chatId: Number(item.chatId),
        userId: Number(item.userId),
        displayName: cleanProfileText(item.displayName || `user${item.userId}`, 24),
        favoriteTeams: uniqueValues(Array.isArray(item.favoriteTeams) ? item.favoriteTeams : []),
        favoritePlayers: uniqueValues(Array.isArray(item.favoritePlayers) ? item.favoritePlayers : []),
        favoriteMaps: uniqueValues(Array.isArray(item.favoriteMaps) ? item.favoriteMaps : []),
        tone: cleanProfileText(item.tone || '', 80),
        note: cleanProfileText(item.note || '', 120),
        createdAt: Number(item.createdAt || Date.now()),
        updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
      })),
  };
}

function updateCache(filepath: string, stamp: StoreStamp, store: UserProfileStore): UserProfileStore {
  cachedPath = filepath;
  cachedStamp = stamp;
  cachedStore = store;
  return store;
}

function loadStore(): UserProfileStore {
  const filepath = storePath();
  const stamp = statStore(filepath);
  if (cachedStore && cachedPath === filepath && sameStamp(cachedStamp, stamp)) {
    cacheHits++;
    return cachedStore;
  }

  diskReads++;
  if (!stamp.exists) {
    lastLoadedAt = Date.now();
    return updateCache(filepath, stamp, emptyStore());
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    lastLoadedAt = Date.now();
    lastError = '';
    return updateCache(filepath, stamp, sanitizeStore(parsed));
  } catch (err) {
    parseErrors++;
    lastError = err instanceof Error ? err.message : String(err);
    lastLoadedAt = Date.now();
    return updateCache(filepath, stamp, emptyStore());
  }
}

function saveStore(store: UserProfileStore): void {
  const filepath = storePath();
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: store.profiles }, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
  diskWrites++;
  lastSavedAt = Date.now();
  lastError = '';
  updateCache(filepath, statStore(filepath), store);
}

function profileMatches(profile: UserProfile, chatType: ProfileChatType, chatId: number, userId: number): boolean {
  return profile.chatType === chatType && profile.chatId === chatId && profile.userId === userId;
}

function displayName(ctx: PluginContext): string {
  return cleanProfileText(ctx.event.sender.card || ctx.event.sender.nickname || `user${ctx.event.user_id}`, 24);
}

function upsertProfile(ctx: PluginContext): { store: UserProfileStore; profile: UserProfile; isNew: boolean } {
  const store = loadStore();
  let profile = store.profiles.find((item) => profileMatches(item, ctx.chatType, ctx.chatId, ctx.event.user_id));
  const now = Date.now();
  let isNew = false;
  if (!profile) {
    isNew = true;
    profile = {
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      userId: ctx.event.user_id,
      displayName: displayName(ctx),
      favoriteTeams: [],
      favoritePlayers: [],
      favoriteMaps: [],
      tone: '',
      note: '',
      createdAt: now,
      updatedAt: now,
    };
    store.profiles.push(profile);
  }
  profile.displayName = displayName(ctx);
  profile.updatedAt = now;
  return { store, profile, isNew };
}

function valuesForField(profile: UserProfile, field: ProfileField): string[] {
  if (field === 'teams') return profile.favoriteTeams;
  if (field === 'players') return profile.favoritePlayers;
  if (field === 'maps') return profile.favoriteMaps;
  return [];
}

function setValuesForField(profile: UserProfile, field: ProfileField, values: string[]): void {
  if (field === 'teams') profile.favoriteTeams = values;
  if (field === 'players') profile.favoritePlayers = values;
  if (field === 'maps') profile.favoriteMaps = values;
}

function fieldLabel(field: ProfileField): string {
  const labels: Record<ProfileField, string> = {
    teams: '队伍偏好',
    players: '选手偏好',
    maps: '地图偏好',
    tone: '语气偏好',
    note: '备注',
  };
  return labels[field];
}

function usage(): string {
  return [
    '用户画像用法',
    '/profile - 查看自己的当前会话画像',
    '/profile set team Vitality/NAVI',
    '/profile set player donk/ZywOo',
    '/profile set map Inferno/Mirage',
    '/profile set tone 别太凶，偏短句',
    '/profile set note 喜欢看道具和补枪复盘',
    '/profile drop team Vitality',
    '/profile clear - 清空自己的画像',
  ].join('\n');
}

function formatProfile(profile: UserProfile | null, ctx?: PluginContext): string {
  const chatType = profile?.chatType || ctx?.chatType || 'group';
  const chatId = profile?.chatId || ctx?.chatId || 0;
  const userId = profile?.userId || ctx?.event.user_id || 0;
  const name = profile?.displayName || (ctx ? displayName(ctx) : `user${userId}`);
  return [
    '用户画像',
    `会话: ${chatType} ${chatId}`,
    `用户: ${name}(${userId})`,
    `队伍偏好: ${profile?.favoriteTeams.length ? profile.favoriteTeams.join(' / ') : '未设置'}`,
    `选手偏好: ${profile?.favoritePlayers.length ? profile.favoritePlayers.join(' / ') : '未设置'}`,
    `地图偏好: ${profile?.favoriteMaps.length ? profile.favoriteMaps.join(' / ') : '未设置'}`,
    `语气偏好: ${profile?.tone || '未设置'}`,
    `备注: ${profile?.note || '未设置'}`,
    '边界: 这些是你在当前群/私聊自填的长期偏好，只影响回复个性化；不能当实时阵容、排名、赛果或现实身份事实。',
  ].join('\n');
}

export function getUserProfile(chatType: ProfileChatType, chatId: number, userId: number): UserProfile | null {
  return loadStore().profiles.find((item) => profileMatches(item, chatType, chatId, userId)) || null;
}

export function getUserProfileStats(): {
  profiles: number;
  cached: boolean;
  cacheHits: number;
  diskReads: number;
  diskWrites: number;
  parseErrors: number;
  lastLoadedAt: number;
  lastSavedAt: number;
  lastError: string;
} {
  const filepath = storePath();
  const cached = !!cachedStore && cachedPath === filepath;
  return {
    profiles: cached && cachedStore ? cachedStore.profiles.length : 0,
    cached,
    cacheHits,
    diskReads,
    diskWrites,
    parseErrors,
    lastLoadedAt,
    lastSavedAt,
    lastError,
  };
}

function resetUserProfileCache(resetStats = false): void {
  cachedStore = null;
  cachedPath = '';
  cachedStamp = { exists: false, mtimeMs: 0, size: 0 };
  if (resetStats) {
    cacheHits = 0;
    diskReads = 0;
    diskWrites = 0;
    parseErrors = 0;
    lastLoadedAt = 0;
    lastSavedAt = 0;
    lastError = '';
  }
}

export function buildUserProfileRuntimeHint(chatType: ProfileChatType, chatId: number, userId: number): string {
  const profile = getUserProfile(chatType, chatId, userId);
  if (!profile) return '';
  const lines = [
    profile.favoriteTeams.length ? `队伍偏好: ${profile.favoriteTeams.join(' / ')}` : '',
    profile.favoritePlayers.length ? `选手偏好: ${profile.favoritePlayers.join(' / ')}` : '',
    profile.favoriteMaps.length ? `地图偏好: ${profile.favoriteMaps.join(' / ')}` : '',
    profile.tone ? `语气偏好: ${profile.tone}` : '',
    profile.note ? `备注: ${profile.note}` : '',
  ].filter(Boolean);
  if (lines.length === 0) return '';
  return [
    '这是当前发言者自填的用户画像，只用来个性化语气和举例，不是事实证据。',
    '使用规则：可以顺手提他的偏好；涉及最新阵容/排名/赛果仍必须看实时证据，不能用画像下事实结论。',
    ...lines,
  ].join('\n').slice(0, 700);
}

export function buildUserProfileDailyCsHint(chatType: ProfileChatType, chatId: number, userId: number): string {
  const profile = getUserProfile(chatType, chatId, userId);
  if (!profile) return '';
  const lines = [
    profile.favoriteMaps.length
      ? `偏好地图: ${profile.favoriteMaps.join(' / ')}；今天道具和复盘可以优先套到这些图。`
      : '',
    profile.favoritePlayers.length
      ? `偏好选手: ${profile.favoritePlayers.join(' / ')}；只当打法参照，不代表当前状态或队伍。`
      : '',
    profile.favoriteTeams.length
      ? `偏好队伍: ${profile.favoriteTeams.join(' / ')}；只当情绪锚点，阵容/排名仍要查实时源。`
      : '',
    profile.note ? `自填备注: ${profile.note}` : '',
  ].filter(Boolean);
  if (lines.length === 0) return '';
  return [
    '画像偏好：',
    ...lines,
    '画像边界: 这是自填偏好，不是实时赛事事实。问最新阵容/排名/赛程仍用 /cs brief 或 /cs verify。',
  ].join('\n').slice(0, 520);
}

export function handleUserProfileCommand(ctx: PluginContext): string {
  const action = (ctx.args[0] || 'show').toLowerCase();
  const profile = getUserProfile(ctx.chatType, ctx.chatId, ctx.event.user_id);
  if (['help', 'usage', '用法', '?'].includes(action)) return usage();
  if (['show', 'me', 'status', 'check', '查看', '我'].includes(action)) return formatProfile(profile, ctx);
  if (['clear', 'reset', 'clean', '清空', '重置'].includes(action)) {
    const store = loadStore();
    const before = store.profiles.length;
    store.profiles = store.profiles.filter((item) => !profileMatches(item, ctx.chatType, ctx.chatId, ctx.event.user_id));
    saveStore(store);
    return `用户画像已清空：${before - store.profiles.length}条。\n边界: 只清当前会话里你自己的画像，不动聊天上下文/RAG；清聊天记忆用 /mem。`;
  }

  const isDrop = ['drop', 'delete', 'remove', 'del', 'forget', '删除', '移除', '遗忘'].includes(action);
  const isSet = ['set', 'add', 'update', '设置', '添加', '记住'].includes(action);
  const fieldToken = isDrop || isSet ? (ctx.args[1] || '') : (ctx.args[0] || '');
  const field = normalizeField(fieldToken);
  if (!field) return usage();
  const valueRaw = (isDrop || isSet ? ctx.args.slice(2) : ctx.args.slice(1)).join(' ').trim();
  const { store, profile: next } = upsertProfile(ctx);

  if (field === 'tone' || field === 'note') {
    if (isDrop) {
      next[field] = '';
      saveStore(store);
      return `${fieldLabel(field)}已清空。\n${formatProfile(next)}`;
    }
    const cleaned = cleanProfileText(valueRaw, field === 'note' ? 120 : 80);
    if (!cleaned) return `${fieldLabel(field)}不能为空。\n${usage()}`;
    next[field] = cleaned;
    saveStore(store);
    return `${fieldLabel(field)}已更新。\n${formatProfile(next)}`;
  }

  const values = splitProfileValues(valueRaw);
  if (values.length === 0) return `${fieldLabel(field)}不能为空。\n${usage()}`;
  const current = valuesForField(next, field);
  if (isDrop) {
    const dropKeys = new Set(values.map(normalizeComparable));
    const kept = current.filter((item) => !dropKeys.has(normalizeComparable(item)));
    setValuesForField(next, field, kept);
    saveStore(store);
    return `${fieldLabel(field)}已移除：${values.join(' / ')}\n${formatProfile(next)}`;
  }

  setValuesForField(next, field, uniqueValues([...current, ...values]));
  saveStore(store);
  return `${fieldLabel(field)}已更新：${values.join(' / ')}\n${formatProfile(next)}`;
}

export const __test = {
  setStorePathForTests(filepath?: string): void {
    storePathOverride = filepath || '';
    resetUserProfileCache(true);
  },
  loadStore,
  getUserProfile,
  getUserProfileStats,
  resetUserProfileCache,
  buildUserProfileRuntimeHint,
  buildUserProfileDailyCsHint,
};
