import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 轻量历史检索存储
 *
 * 实现说明：
 * - 不依赖外部embedding API，使用 字符级 + 词级 n-gram TF 向量 + 余弦相似度
 * - 中文友好（按字+2-gram），英文按词
 * - 每个 session 单独一个 jsonl 文件，append-only
 * - 内存LRU + 磁盘持久化
 *
 * 这是一个 retrieval helper，不是真正的向量数据库
 */

const STORE_DIR = path.resolve(__dirname, '..', '..', 'context_store', 'embeddings');

interface IndexedMessage {
  id: string;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
  /** TF 向量 - sparse map */
  vec?: Map<string, number>;
  /** 向量长度 */
  norm?: number;
}

interface SessionIndex {
  sessionId: string;
  messages: IndexedMessage[];
  lastWrite: number;
  dirty: boolean;
}

export interface MemorySearchResult {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  similarity: number;
  score: number;
  recencyBoost: number;
  ageSeconds: number;
}

const sessions: Map<string, SessionIndex> = new Map();
let maxMessagesPerSession = 500; // 每个session最多保留500条历史
let maxSessionsInMemory = 50;
let searchQueries = 0;
let searchHits = 0;
let searchMisses = 0;
let lastError = '';

export function configureEmbeddingStore(config: {
  memory_max_messages_per_session?: number;
  memory_max_sessions_in_memory?: number;
}): void {
  const nextMaxMessages = Number(config.memory_max_messages_per_session ?? 500);
  const nextMaxSessions = Number(config.memory_max_sessions_in_memory ?? 50);
  maxMessagesPerSession = Math.max(50, Math.min(5000, Math.floor(Number.isFinite(nextMaxMessages) ? nextMaxMessages : 500)));
  maxSessionsInMemory = Math.max(5, Math.min(500, Math.floor(Number.isFinite(nextMaxSessions) ? nextMaxSessions : 50)));
  for (const session of sessions.values()) {
    if (session.messages.length > maxMessagesPerSession) {
      session.messages = session.messages.slice(-maxMessagesPerSession);
      session.dirty = true;
    }
  }
  evictSessionsIfNeeded();
}

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function sessionPath(sessionId: string): string {
  // sanitize: only allow [a-zA-Z0-9_-]
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(STORE_DIR, `${safe}.jsonl`);
}

function listDiskIndexFiles(): string[] {
  try {
    ensureDir();
    return fs.readdirSync(STORE_DIR).filter((file) => file.endsWith('.jsonl'));
  } catch (err) {
    lastError = err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180);
    return [];
  }
}

/** 提取特征：字+2-gram (中文) + 单词 (英文) */
function extractFeatures(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  const cleaned = text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return vec;

  // 中文字符 unigram + bigram
  const chinese = cleaned.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of chinese) {
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      vec.set(`c:${c}`, (vec.get(`c:${c}`) || 0) + 1);
      if (i + 1 < seg.length) {
        const bg = seg.slice(i, i + 2);
        vec.set(`bg:${bg}`, (vec.get(`bg:${bg}`) || 0) + 1.5);
      }
    }
  }
  // 英文/数字 word
  const words = (cleaned.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2);
  for (const w of words) {
    vec.set(`w:${w}`, (vec.get(`w:${w}`) || 0) + 2);
  }
  return vec;
}

function vectorNorm(vec: Map<string, number>): number {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  return Math.sqrt(sum);
}

function cosineSimilarity(a: IndexedMessage, b: IndexedMessage): number {
  if (!a.vec || !b.vec || !a.norm || !b.norm) return 0;
  // 让 a 是较小的
  const small = a.vec.size <= b.vec.size ? a.vec : b.vec;
  const large = a.vec.size <= b.vec.size ? b.vec : a.vec;
  let dot = 0;
  for (const [key, val] of small) {
    const other = large.get(key);
    if (other !== undefined) dot += val * other;
  }
  return dot / (a.norm * b.norm);
}

function recencyBoostForTimestamp(ts: number, now: number): { boost: number; ageSeconds: number } {
  if (!ts || ts <= 0) return { boost: 0, ageSeconds: 0 };
  const ageSeconds = Math.max(0, Math.round((now - ts) / 1000));
  const ageHours = ageSeconds / 3600;
  const boost = 0.08 * Math.exp(-ageHours / 12);
  return {
    boost: Math.round(boost * 1000) / 1000,
    ageSeconds,
  };
}

function normalizePruneText(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneTerms(query: string): string[] {
  const normalized = normalizePruneText(query);
  if (!normalized) return [];
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (terms.length > 0) return terms.slice(0, 8);
  return normalized.length >= 2 ? [normalized] : [];
}

function matchesPruneQuery(text: string, query: string): boolean {
  const cleanText = normalizePruneText(text);
  const cleanQuery = normalizePruneText(query);
  if (!cleanText || !cleanQuery || cleanQuery.length < 2) return false;
  if (cleanText.includes(cleanQuery)) return true;
  const terms = pruneTerms(query);
  return terms.length > 0 && terms.every((term) => cleanText.includes(term));
}

function indexedUserId(text: string): number | null {
  const match = (text || '').match(/^\[mid=\d+\s+uid=(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function loadSession(sessionId: string): SessionIndex {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!;

  evictSessionsIfNeeded(1);

  ensureDir();
  const filepath = sessionPath(sessionId);
  const session: SessionIndex = {
    sessionId,
    messages: [],
    lastWrite: Date.now(),
    dirty: false,
  };

  if (fs.existsSync(filepath)) {
    try {
      const lines = fs.readFileSync(filepath, 'utf-8').split('\n').filter(Boolean);
      // 只读最后 maxMessagesPerSession 条
      const recent = lines.slice(-maxMessagesPerSession);
      for (const line of recent) {
        try {
          const obj = JSON.parse(line);
          if (obj && obj.id && obj.text && obj.role) {
            const msg: IndexedMessage = {
              id: obj.id,
              ts: obj.ts || 0,
              role: obj.role,
              text: obj.text,
            };
            // 重建向量
            msg.vec = extractFeatures(msg.text);
            msg.norm = vectorNorm(msg.vec);
            session.messages.push(msg);
          }
        } catch { /* skip malformed line */ }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180);
    }
  }

  sessions.set(sessionId, session);
  return session;
}

export function getSessionIndexSnapshot(sessionId: string, limit: number = 8): Array<{
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}> {
  const session = loadSession(sessionId);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return session.messages.slice(-safeLimit).map((message) => ({
    role: message.role,
    text: message.text,
    ts: message.ts,
  }));
}

function evictSessionsIfNeeded(reserveSlots: number = 0): void {
  const targetSize = Math.max(0, maxSessionsInMemory - reserveSlots);
  if (sessions.size <= targetSize) return;
  const sorted = [...sessions.entries()].sort((a, b) => a[1].lastWrite - b[1].lastWrite);
  for (const [id, s] of sorted.slice(0, sessions.size - targetSize)) {
    if (s.dirty) flushSession(id);
    sessions.delete(id);
  }
}

/** 添加一条消息到索引 */
export function indexMessage(sessionId: string, role: 'user' | 'assistant', text: string): void {
  if (!text || text.length < 8) return; // 太短不索引
  const session = loadSession(sessionId);
  const id = crypto.createHash('sha1').update(`${Date.now()}_${Math.random()}`).digest('hex').slice(0, 12);
  const msg: IndexedMessage = {
    id,
    ts: Date.now(),
    role,
    text: text.length > 800 ? text.slice(0, 800) : text,
    vec: extractFeatures(text),
  };
  msg.norm = vectorNorm(msg.vec || new Map());
  session.messages.push(msg);
  if (session.messages.length > maxMessagesPerSession) {
    session.messages = session.messages.slice(-maxMessagesPerSession);
  }
  session.dirty = true;
  session.lastWrite = Date.now();
  // append immediate to disk (jsonl-friendly)
  scheduleFlush(sessionId);
}

let flushTimers: Map<string, NodeJS.Timeout> = new Map();
function scheduleFlush(sessionId: string): void {
  if (flushTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(sessionId);
    flushSession(sessionId);
  }, 5000);
  timer.unref();
  flushTimers.set(sessionId, timer);
}

function flushSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || !session.dirty) return;
  ensureDir();
  try {
    const filepath = sessionPath(sessionId);
    // overwrite jsonl with current messages
    const content = session.messages
      .map((m) => JSON.stringify({ id: m.id, ts: m.ts, role: m.role, text: m.text }))
      .join('\n') + '\n';
    const tmp = `${filepath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filepath);
    session.dirty = false;
  } catch (err) {
    lastError = err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180);
    console.error('[Embedding] flush 失败', err);
  }
}

/** 检索 topK 最相关的历史消息（按余弦相似度） */
export function searchSimilar(
  sessionId: string,
  query: string,
  topK: number = 3,
  minSimilarity: number = 0.15,
): MemorySearchResult[] {
  searchQueries++;
  if (!query || query.length < 4) {
    searchMisses++;
    return [];
  }
  const session = loadSession(sessionId);
  if (session.messages.length === 0) {
    searchMisses++;
    return [];
  }

  const queryVec = extractFeatures(query);
  const queryNorm = vectorNorm(queryVec);
  if (queryNorm === 0) {
    searchMisses++;
    return [];
  }

  const queryMsg: IndexedMessage = { id: '', ts: 0, role: 'user', text: query, vec: queryVec, norm: queryNorm };

  const queryShort = query.replace(/^\[mid=\d+\s+uid=\d+\]\s*[^:：]+[:：]\s*/, '').slice(0, 50).toLowerCase();
  const now = Date.now();

  const scored = session.messages
    .filter((m) => {
      if (!m.text || m.text === query) return false;
      // 过滤刚刚索引进来的同条消息（用文本前50字符匹配）
      const mShort = m.text.replace(/^\[mid=\d+\s+uid=\d+\]\s*[^:：]+[:：]\s*/, '').slice(0, 50).toLowerCase();
      if (mShort && queryShort && mShort === queryShort) return false;
      return true;
    })
    .map((m) => ({
      msg: m,
      similarity: cosineSimilarity(queryMsg, m),
    }))
    .filter((item) => item.similarity >= minSimilarity && item.similarity < 0.99) // 0.99以上认为是同一条
    .map((item) => {
      const recency = recencyBoostForTimestamp(item.msg.ts, now);
      return {
        ...item,
        recencyBoost: recency.boost,
        ageSeconds: recency.ageSeconds,
        score: item.similarity + recency.boost,
      };
    })
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity || b.msg.ts - a.msg.ts)
    .slice(0, topK);

  if (scored.length > 0) searchHits++;
  else searchMisses++;

  return scored.map((item) => ({
    role: item.msg.role,
    text: item.msg.text,
    ts: item.msg.ts,
    similarity: Math.round(item.similarity * 1000) / 1000,
    score: Math.round(item.score * 1000) / 1000,
    recencyBoost: item.recencyBoost,
    ageSeconds: item.ageSeconds,
  }));
}

export function clearSessionIndex(sessionId: string): void {
  sessions.delete(sessionId);
  try {
    const filepath = sessionPath(sessionId);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch { /* */ }
}

export function trimSessionIndex(sessionId: string, keepMessages: number): { before: number; after: number } {
  const keep = Math.max(0, Math.min(5000, Math.floor(keepMessages)));
  const session = loadSession(sessionId);
  const before = session.messages.length;
  if (session.messages.length > keep) {
    session.messages = keep > 0 ? session.messages.slice(-keep) : [];
    session.dirty = true;
    session.lastWrite = Date.now();
    flushSession(sessionId);
  }
  return { before, after: session.messages.length };
}

export function dropSessionIndexByQuery(sessionId: string, query: string, sampleLimit: number = 5): {
  before: number;
  after: number;
  removed: number;
  samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>;
} {
  const cleanQuery = normalizePruneText(query);
  const session = loadSession(sessionId);
  const before = session.messages.length;
  const samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  if (cleanQuery.length < 2) {
    return { before, after: before, removed: 0, samples };
  }
  const kept: IndexedMessage[] = [];
  for (const message of session.messages) {
    if (matchesPruneQuery(message.text, cleanQuery)) {
      if (samples.length < sampleLimit) {
        samples.push({ role: message.role, text: message.text, ts: message.ts });
      }
      continue;
    }
    kept.push(message);
  }
  if (kept.length !== session.messages.length) {
    session.messages = kept;
    session.dirty = true;
    session.lastWrite = Date.now();
    flushSession(sessionId);
  }
  return { before, after: session.messages.length, removed: before - session.messages.length, samples };
}

export function inspectSessionIndexByUser(sessionId: string, userId: number, sampleLimit: number = 5): {
  total: number;
  matched: number;
  samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>;
} {
  const session = loadSession(sessionId);
  const samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  let matched = 0;
  for (const message of session.messages) {
    if (indexedUserId(message.text) !== userId) continue;
    matched++;
    if (samples.length < sampleLimit) {
      samples.push({ role: message.role, text: message.text, ts: message.ts });
    }
  }
  return { total: session.messages.length, matched, samples };
}

export function dropSessionIndexByUser(sessionId: string, userId: number, sampleLimit: number = 5): {
  before: number;
  after: number;
  removed: number;
  samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>;
} {
  const session = loadSession(sessionId);
  const before = session.messages.length;
  const samples: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  const kept: IndexedMessage[] = [];
  for (const message of session.messages) {
    if (indexedUserId(message.text) === userId) {
      if (samples.length < sampleLimit) {
        samples.push({ role: message.role, text: message.text, ts: message.ts });
      }
      continue;
    }
    kept.push(message);
  }
  if (kept.length !== session.messages.length) {
    session.messages = kept;
    session.dirty = true;
    session.lastWrite = Date.now();
    flushSession(sessionId);
  }
  return { before, after: session.messages.length, removed: before - session.messages.length, samples };
}

export function getEmbeddingStats(): {
  sessionsInMemory: number;
  totalIndexed: number;
  diskSessions: number;
  pendingFlushes: number;
  maxMessagesPerSession: number;
  maxSessionsInMemory: number;
  queries: number;
  hits: number;
  misses: number;
  lastError: string;
} {
  let total = 0;
  for (const s of sessions.values()) total += s.messages.length;
  return {
    sessionsInMemory: sessions.size,
    totalIndexed: total,
    diskSessions: listDiskIndexFiles().length,
    pendingFlushes: flushTimers.size,
    maxMessagesPerSession,
    maxSessionsInMemory,
    queries: searchQueries,
    hits: searchHits,
    misses: searchMisses,
    lastError,
  };
}

/** 优雅退出时 flush 所有 dirty */
export function flushAllEmbeddings(): void {
  for (const sessionId of sessions.keys()) {
    flushSession(sessionId);
  }
}
