import * as fs from 'fs';
import * as path from 'path';

/**
 * 持久化上下文存储
 * - 写入磁盘，重启不丢
 * - 异步批量写入，不阻塞主流程
 * - 内存中是source of truth，磁盘是backup
 */

const STORE_DIR = path.resolve(__dirname, '..', '..', 'context_store');

if (!fs.existsSync(STORE_DIR)) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

export interface StoredContext {
  summary: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  lastActiveTime: number;
}

/** 待写入的脏数据 */
const dirtySessions: Set<string> = new Set();
let writeTimer: NodeJS.Timeout | null = null;

function getFilePath(sessionId: string): string {
  // sessionId: group_xxx 或 private_xxx
  const safe = sessionId.replace(/[^a-zA-Z0-9_]/g, '_');
  return path.join(STORE_DIR, `${safe}.json`);
}

/** 从磁盘加载会话 */
export function loadContext(sessionId: string): StoredContext | null {
  try {
    const filepath = getFilePath(sessionId);
    if (!fs.existsSync(filepath)) return null;
    const data = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(data) as StoredContext;
  } catch {
    return null;
  }
}

/** 标记会话为脏，稍后批量写入 */
export function markDirty(sessionId: string): void {
  dirtySessions.add(sessionId);
  scheduleFlush();
}

/** 调度异步刷盘（防抖） */
function scheduleFlush(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 5000); // 5秒后批量写
  writeTimer.unref();
}

/** 实际写盘函数（由 flushSessionMap 调用） */
let flushHandler: (() => void) | null = null;
export function setFlushHandler(handler: () => void): void {
  flushHandler = handler;
}

function flush(): void {
  if (flushHandler) {
    try {
      flushHandler();
    } catch (err) {
      console.error('[ContextStore] flush异常:', err);
    }
  }
}

export function flushNow(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush();
}

/** 实际写入单个会话到磁盘 */
export function writeSession(sessionId: string, ctx: StoredContext): boolean {
  try {
    const filepath = getFilePath(sessionId);
    const tempPath = `${filepath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(ctx), 'utf-8');
    fs.renameSync(tempPath, filepath);
    return true;
  } catch (err) {
    console.error(`[ContextStore] 写入失败 ${sessionId}:`, err);
    return false;
  }
}

/** 删除会话文件 */
export function deleteSession(sessionId: string): void {
  try {
    dirtySessions.delete(sessionId);
    const filepath = getFilePath(sessionId);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch { /* */ }
}

export function getDirtySessions(): string[] {
  return [...dirtySessions];
}

export function clearDirtySession(sessionId: string): void {
  dirtySessions.delete(sessionId);
}

/** 启动时加载所有现存会话的ID列表 */
export function listAllSessions(): string[] {
  try {
    if (!fs.existsSync(STORE_DIR)) return [];
    const files = fs.readdirSync(STORE_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}
