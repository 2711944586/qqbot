import {
  loadContext,
  writeSession,
  deleteSession,
  markDirty,
  setFlushHandler,
  getDirtySessions,
  listAllSessions,
  clearDirtySession,
  flushNow,
} from './context-store';
import { ChatMessage } from './llm-api';
import {
  indexMessage,
  searchSimilar,
  clearSessionIndex,
  flushAllEmbeddings,
  configureEmbeddingStore,
  getSessionIndexSnapshot,
  MemorySearchResult,
  trimSessionIndex,
  dropSessionIndexByQuery,
  inspectSessionIndexByUser,
  dropSessionIndexByUser,
} from './embedding-store';

/**
 * 上下文管理器 - 内存+磁盘双层
 * 从 ai-chat.ts 拆出
 *
 * 设计原则:
 * - 只追加(append-only)，不修改前面消息（KV cache友好）
 * - 接近上限时压缩前N条为摘要
 * - 摘要+剩余消息组成稳定前缀
 * - 内存中是source of truth，磁盘是backup
 */

export interface SessionContext {
  summary: string;
  /** 纯文字消息（不含图片DataURL，节省内存） */
  messages: ChatMessage[];
  lastActiveTime: number;
}

function normalizeMemoryDropText(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryDropTerms(query: string): string[] {
  const normalized = normalizeMemoryDropText(query);
  if (!normalized) return [];
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (terms.length > 0) return terms.slice(0, 8);
  return normalized.length >= 2 ? [normalized] : [];
}

function matchesMemoryDropQuery(text: string, query: string): boolean {
  const cleanText = normalizeMemoryDropText(text);
  const cleanQuery = normalizeMemoryDropText(query);
  if (!cleanText || !cleanQuery || cleanQuery.length < 2) return false;
  if (cleanText.includes(cleanQuery)) return true;
  const terms = memoryDropTerms(cleanQuery);
  return terms.length > 0 && terms.every((term) => cleanText.includes(term));
}

function memoryMessageUserId(message: ChatMessage): number | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  const match = message.content.match(/^\[mid=\d+\s+uid=(\d+)\]/);
  return match ? Number(match[1]) : null;
}

export class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private softLimit!: number;
  private hardLimit!: number;
  private keepRecent!: number;
  private expireMs!: number;
  private cleanupTimer: NodeJS.Timeout;
  private memoryEnabled: boolean = true;
  private memoryTopK: number = 3;
  private memoryMinSimilarity: number = 0.15;
  private memoryInjectMaxChars: number = 700;
  private configSignature = '';

  constructor(maxMessages: number, expireMinutes: number) {
    this.configure({
      maxMessages,
      expireMinutes,
      enableMemoryRetrieval: true,
      memoryTopK: 3,
      memoryMinSimilarity: 0.15,
      memoryInjectMaxChars: 700,
    });
    this.loadOnStartup();
    setFlushHandler(() => this.flushDirtyToDisk());

    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  private loadOnStartup(): void {
    const ids = listAllSessions();
    console.log(`[Context] 磁盘有${ids.length}个历史会话(按需加载)`);
  }

  configure(options: {
    maxMessages: number;
    expireMinutes: number;
    enableMemoryRetrieval?: boolean;
    memoryTopK?: number;
    memoryMinSimilarity?: number;
    memoryInjectMaxChars?: number;
    memoryMaxMessagesPerSession?: number;
    memoryMaxSessionsInMemory?: number;
  }): void {
    const signature = [
      options.maxMessages,
      options.expireMinutes,
      options.enableMemoryRetrieval === false ? 0 : 1,
      options.memoryTopK ?? '',
      options.memoryMinSimilarity ?? '',
      options.memoryInjectMaxChars ?? '',
      options.memoryMaxMessagesPerSession ?? '',
      options.memoryMaxSessionsInMemory ?? '',
    ].join('|');
    if (signature === this.configSignature) return;
    this.configSignature = signature;

    const maxMessages = Math.max(5, Math.floor(options.maxMessages ?? 50));
    this.softLimit = Math.max(5, Math.floor(maxMessages * 0.8));
    this.hardLimit = Math.max(5, maxMessages);
    this.keepRecent = Math.max(3, Math.floor(maxMessages * 0.4));
    this.expireMs = Math.max(1, options.expireMinutes ?? 120) * 60 * 1000;
    this.memoryEnabled = options.enableMemoryRetrieval !== false;
    this.memoryTopK = Math.max(0, Math.min(12, Math.floor(options.memoryTopK ?? 3)));
    this.memoryMinSimilarity = Math.max(0.05, Math.min(0.95, Number(options.memoryMinSimilarity ?? 0.15)));
    this.memoryInjectMaxChars = Math.max(0, Math.min(3000, Math.floor(options.memoryInjectMaxChars ?? 700)));
    configureEmbeddingStore({
      memory_max_messages_per_session: options.memoryMaxMessagesPerSession,
      memory_max_sessions_in_memory: options.memoryMaxSessionsInMemory,
    });
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.messages.length > this.hardLimit) {
        session.messages = session.messages.slice(-this.hardLimit);
        markDirty(sessionId);
      }
    }
  }

  getSession(sessionId: string): SessionContext {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const stored = loadContext(sessionId);
      if (stored && Date.now() - stored.lastActiveTime <= this.expireMs) {
        session = {
          summary: stored.summary,
          messages: stored.messages.map((m) => ({ role: m.role, content: m.content })),
          lastActiveTime: stored.lastActiveTime,
        };
      } else {
        session = { summary: '', messages: [], lastActiveTime: Date.now() };
      }
      this.sessions.set(sessionId, session);
    } else if (Date.now() - session.lastActiveTime > this.expireMs) {
      session = { summary: '', messages: [], lastActiveTime: Date.now() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** 只追加 不修改顺序 */
  appendMessage(sessionId: string, message: ChatMessage): void {
    const session = this.getSession(sessionId);
    // 存储统一为纯文字（不存图片DataURL，节省内存和token）
    const textContent = typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ');
    const stored: ChatMessage = {
      role: message.role,
      content: textContent,
    };
    session.messages.push(stored);
    if (session.messages.length > this.hardLimit) {
      session.messages = session.messages.slice(-this.hardLimit);
    }
    session.lastActiveTime = Date.now();
    markDirty(sessionId);

    // 同时索引到向量存储（仅user和assistant消息，且长度>=8）
    if (this.memoryEnabled && (message.role === 'user' || message.role === 'assistant') && textContent && textContent.length >= 8) {
      try {
        indexMessage(sessionId, message.role, textContent);
      } catch (err) {
        // 索引失败不阻塞主流程
      }
    }
  }

  /** 检索语义相似的历史消息（基于向量相似度） */
  retrieveSimilar(
    sessionId: string,
    query: string,
    topK: number = this.memoryTopK,
    minSimilarity: number = this.memoryMinSimilarity,
  ): MemorySearchResult[] {
    if (!this.memoryEnabled) return [];
    try {
      return searchSimilar(sessionId, query, topK, minSimilarity).map((r) => ({
        role: r.role,
        text: r.text,
        ts: r.ts,
        similarity: r.similarity,
        score: r.score,
        recencyBoost: r.recencyBoost,
        ageSeconds: r.ageSeconds,
      }));
    } catch {
      return [];
    }
  }

  needsCompression(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.messages.length >= this.softLimit;
  }

  applyCompression(sessionId: string, newSummary: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.summary = session.summary ? session.summary + '\n' + newSummary : newSummary;
    if (session.messages.length > this.keepRecent) {
      session.messages = session.messages.slice(-this.keepRecent);
    }
    markDirty(sessionId);
  }

  getOldMessagesToCompress(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const cutoff = session.messages.length - this.keepRecent;
    return cutoff > 0 ? session.messages.slice(0, cutoff) : [];
  }

  getFullContext(sessionId: string): { summary: string; messages: ChatMessage[] } {
    const session = this.getSession(sessionId);
    return { summary: session.summary, messages: [...session.messages] };
  }

  getSessionMeta(sessionId: string): {
    summaryChars: number;
    messages: number;
    lastActiveTime: number;
    loaded: boolean;
  } {
    const loaded = this.sessions.has(sessionId);
    const session = this.getSession(sessionId);
    return {
      summaryChars: session.summary.length,
      messages: session.messages.length,
      lastActiveTime: session.lastActiveTime,
      loaded,
    };
  }

  getRecentMessages(sessionId: string, limit: number = 8): ChatMessage[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const session = this.getSession(sessionId);
    return session.messages.slice(-safeLimit).map((message) => ({ ...message }));
  }

  getRecentIndexedMessages(sessionId: string, limit: number = 8): Array<{
    role: 'user' | 'assistant';
    text: string;
    ts: number;
  }> {
    return getSessionIndexSnapshot(sessionId, limit);
  }

  getMemoryInjectMaxChars(): number {
    return this.memoryInjectMaxChars;
  }

  isMemoryEnabled(): boolean {
    return this.memoryEnabled;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    deleteSession(sessionId);
    clearSessionIndex(sessionId);
  }

  dropSessionMemoryByQuery(sessionId: string, query: string): {
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
    const cleanQuery = normalizeMemoryDropText(query);
    const session = this.getSession(sessionId);
    const contextBefore = session.messages.length;
    const summaryBeforeChars = session.summary.length;
    const contextSamples: Array<{ role: string; text: string; ts?: number }> = [];
    if (cleanQuery.length < 2) {
      const index = dropSessionIndexByQuery(sessionId, cleanQuery);
      return {
        contextBefore,
        contextAfter: contextBefore,
        contextRemoved: 0,
        summaryBeforeChars,
        summaryAfterChars: summaryBeforeChars,
        summaryDropped: false,
        indexBefore: index.before,
        indexAfter: index.after,
        indexRemoved: index.removed,
        samples: [],
      };
    }

    const kept = session.messages.filter((message) => {
      const text = typeof message.content === 'string' ? message.content : '';
      const matched = matchesMemoryDropQuery(text, cleanQuery);
      if (matched && contextSamples.length < 5) {
        contextSamples.push({ role: message.role, text });
      }
      return !matched;
    });
    if (kept.length !== session.messages.length) {
      session.messages = kept;
    }
    const summaryDropped = !!session.summary && matchesMemoryDropQuery(session.summary, cleanQuery);
    if (summaryDropped) session.summary = '';
    if (kept.length !== contextBefore || summaryDropped) {
      session.lastActiveTime = Date.now();
      markDirty(sessionId);
      flushNow();
    }

    const index = dropSessionIndexByQuery(sessionId, cleanQuery, Math.max(0, 5 - contextSamples.length));
    return {
      contextBefore,
      contextAfter: session.messages.length,
      contextRemoved: contextBefore - session.messages.length,
      summaryBeforeChars,
      summaryAfterChars: session.summary.length,
      summaryDropped,
      indexBefore: index.before,
      indexAfter: index.after,
      indexRemoved: index.removed,
      samples: [
        ...contextSamples,
        ...index.samples.map((sample) => ({ role: sample.role, text: sample.text, ts: sample.ts })),
      ].slice(0, 5),
    };
  }

  inspectSessionMemoryByUser(sessionId: string, userId: number): {
    contextTotal: number;
    contextMatched: number;
    summaryChars: number;
    indexTotal: number;
    indexMatched: number;
    samples: Array<{ role: string; text: string; ts?: number }>;
  } {
    const session = this.getSession(sessionId);
    const contextSamples: Array<{ role: string; text: string; ts?: number }> = [];
    let contextMatched = 0;
    for (const message of session.messages) {
      if (memoryMessageUserId(message) !== userId) continue;
      contextMatched++;
      if (contextSamples.length < 5) {
        contextSamples.push({
          role: message.role,
          text: typeof message.content === 'string' ? message.content : '',
        });
      }
    }
    const index = inspectSessionIndexByUser(sessionId, userId, Math.max(0, 5 - contextSamples.length));
    return {
      contextTotal: session.messages.length,
      contextMatched,
      summaryChars: session.summary.length,
      indexTotal: index.total,
      indexMatched: index.matched,
      samples: [
        ...contextSamples,
        ...index.samples.map((sample) => ({ role: sample.role, text: sample.text, ts: sample.ts })),
      ].slice(0, 5),
    };
  }

  dropSessionMemoryByUser(sessionId: string, userId: number): {
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
    const session = this.getSession(sessionId);
    const contextBefore = session.messages.length;
    const summaryBeforeChars = session.summary.length;
    const contextSamples: Array<{ role: string; text: string; ts?: number }> = [];
    const kept = session.messages.filter((message) => {
      const matched = memoryMessageUserId(message) === userId;
      if (matched && contextSamples.length < 5) {
        contextSamples.push({
          role: message.role,
          text: typeof message.content === 'string' ? message.content : '',
        });
      }
      return !matched;
    });
    if (kept.length !== session.messages.length) {
      session.messages = kept;
    }

    const index = dropSessionIndexByUser(sessionId, userId, Math.max(0, 5 - contextSamples.length));
    const hasHit = contextBefore !== session.messages.length || index.removed > 0;
    const summaryDropped = hasHit && !!session.summary;
    if (summaryDropped) session.summary = '';
    if (hasHit || summaryDropped) {
      session.lastActiveTime = Date.now();
      markDirty(sessionId);
      flushNow();
    }

    return {
      contextBefore,
      contextAfter: session.messages.length,
      contextRemoved: contextBefore - session.messages.length,
      summaryBeforeChars,
      summaryAfterChars: session.summary.length,
      summaryDropped,
      indexBefore: index.before,
      indexAfter: index.after,
      indexRemoved: index.removed,
      samples: [
        ...contextSamples,
        ...index.samples.map((sample) => ({ role: sample.role, text: sample.text, ts: sample.ts })),
      ].slice(0, 5),
    };
  }

  trimSession(sessionId: string, keepMessages: number): {
    contextBefore: number;
    contextAfter: number;
    summaryBeforeChars: number;
    summaryAfterChars: number;
    indexBefore: number;
    indexAfter: number;
  } {
    const keep = Math.max(0, Math.min(5000, Math.floor(keepMessages)));
    const session = this.getSession(sessionId);
    const contextBefore = session.messages.length;
    const summaryBeforeChars = session.summary.length;
    if (session.messages.length > keep) {
      session.messages = keep > 0 ? session.messages.slice(-keep) : [];
    }
    session.summary = '';
    session.lastActiveTime = Date.now();
    markDirty(sessionId);
    const index = trimSessionIndex(sessionId, keep);
    return {
      contextBefore,
      contextAfter: session.messages.length,
      summaryBeforeChars,
      summaryAfterChars: session.summary.length,
      indexBefore: index.before,
      indexAfter: index.after,
    };
  }

  /** 批量将脏会话写盘 */
  private flushDirtyToDisk(): void {
    const dirty = getDirtySessions();
    for (const id of dirty) {
      const session = this.sessions.get(id);
      if (session) {
        const written = writeSession(id, {
          summary: session.summary,
          messages: session.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
          })),
          lastActiveTime: session.lastActiveTime,
        });
        if (written) clearDirtySession(id);
      } else {
        clearDirtySession(id);
      }
    }
  }

  /** 定时清理：内存中过期的踢出（仍保留磁盘） */
  private cleanup(): void {
    this.flushDirtyToDisk();
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // 30分钟没活跃就从内存里清出去（2G服务器不用太激进）
      if (now - session.lastActiveTime > 30 * 60 * 1000) {
        this.sessions.delete(id);
      }
    }
    if (global.gc) global.gc();
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
    flushNow();
    flushAllEmbeddings();
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
