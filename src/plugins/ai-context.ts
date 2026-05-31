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

export class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private softLimit: number;
  private hardLimit: number;
  private keepRecent: number;
  private expireMs: number;
  private cleanupTimer: NodeJS.Timeout;

  constructor(maxMessages: number, expireMinutes: number) {
    this.softLimit = Math.max(5, Math.floor(maxMessages * 0.8));
    this.hardLimit = Math.max(5, maxMessages);
    this.keepRecent = Math.max(3, Math.floor(maxMessages * 0.4));
    this.expireMs = expireMinutes * 60 * 1000;

    this.loadOnStartup();
    setFlushHandler(() => this.flushDirtyToDisk());

    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  private loadOnStartup(): void {
    const ids = listAllSessions();
    console.log(`[Context] 磁盘有${ids.length}个历史会话(按需加载)`);
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
    const stored: ChatMessage = {
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text || '')
              .join(' '),
    };
    session.messages.push(stored);
    if (session.messages.length > this.hardLimit) {
      session.messages = session.messages.slice(-this.hardLimit);
    }
    session.lastActiveTime = Date.now();
    markDirty(sessionId);
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
    return { summary: session.summary, messages: session.messages };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    deleteSession(sessionId);
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
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
