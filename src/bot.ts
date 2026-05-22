import WebSocket from 'ws';
import { BotConfig, OneBotEvent, MessageSegment } from './types';
import { sanitizeOutgoingMessage } from './message-sanitize';

type ApiCallback = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class Bot {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  private readonly minReconnectInterval = 1000;
  private readonly maxReconnectInterval = 60000;
  private reconnectInterval = this.minReconnectInterval;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private eventHandlers: ((event: OneBotEvent) => void)[] = [];
  private apiCallbacks: Map<string, ApiCallback> = new Map();
  private echoCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private manuallyClosed = false;
  private connecting = false;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /** 心跳保活 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[Bot] 心跳发送失败:', message);
        }
      }
    }, 30000);
    this.heartbeatTimer.unref();
  }

  /** 注册事件处理器 */
  onEvent(handler: (event: OneBotEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** 启动连接 */
  connect(): void {
    if (this.manuallyClosed) return;
    if (this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.connecting = true;
    console.log(`[Bot] 正在连接 ${this.config.ws_url} ...`);
    const ws = new WebSocket(this.config.ws_url);
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      this.reconnectInterval = this.minReconnectInterval;
      console.log('[Bot] ✅ WebSocket 连接成功！');
      // 定时发送心跳保持连接活跃
      this.startHeartbeat();
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        // 处理 API 响应
        if (parsed.echo && this.apiCallbacks.has(parsed.echo)) {
          const cb = this.apiCallbacks.get(parsed.echo)!;
          this.apiCallbacks.delete(parsed.echo);
          clearTimeout(cb.timer);
          cb.resolve(parsed);
          return;
        }

        // 处理事件
        this.dispatchEvent(parsed as OneBotEvent);
      } catch (err) {
        console.error('[Bot] 解析消息失败:', err);
      }
    });

    ws.on('close', (code, reason) => {
      this.connecting = false;
      if (this.ws === ws) this.ws = null;
      this.stopHeartbeat();
      this.rejectPendingApi(new Error(`WebSocket 已断开 code=${code}`));
      if (this.manuallyClosed) return;

      const reasonText = reason.length > 0 ? ` reason=${reason.toString()}` : '';
      console.log(`[Bot] 连接断开 code=${code}${reasonText}，${Math.round(this.reconnectInterval / 1000)}秒后重连...`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.connecting = false;
      console.error('[Bot] WebSocket 错误:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
    this.reconnectInterval = Math.min(this.reconnectInterval * 2, this.maxReconnectInterval);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectPendingApi(error: Error): void {
    for (const [echo, callback] of this.apiCallbacks) {
      clearTimeout(callback.timer);
      callback.reject(error);
      this.apiCallbacks.delete(echo);
    }
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.rejectPendingApi(new Error('Bot 正在关闭'));
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  /** 分发事件 */
  private dispatchEvent(event: OneBotEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[Bot] 事件处理器异常:', err);
      }
    }
  }

  /** 发送群消息（追踪消息ID用于回复检测） */
  sendGroupMessage(groupId: number, message: string | MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    const sanitized = sanitizeOutgoingMessage(message);
    const msg = typeof sanitized === 'string'
      ? [{ type: 'text', data: { text: sanitized } }]
      : sanitized;

    return this.callApiAsync('send_group_msg', {
      group_id: groupId,
      message: msg,
    }).then((res: any) => {
      if (typeof res?.retcode === 'number' && res.retcode !== 0) {
        console.error(`[Bot] 发送群消息失败: 群${groupId} retcode=${res.retcode} ${res.message || res.wording || ''}`);
        return false;
      }

      const msgId = res?.data?.message_id;
      if (msgId && onMessageId) {
        onMessageId(Number(msgId));
      }
      return true;
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] 发送群消息异常: 群${groupId} ${errMsg}`);
      return false;
    });
  }

  /** 发送私聊消息 */
  sendPrivateMessage(userId: number, message: string | MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    const sanitized = sanitizeOutgoingMessage(message);
    const msg = typeof sanitized === 'string'
      ? [{ type: 'text', data: { text: sanitized } }]
      : sanitized;

    return this.callApiAsync('send_private_msg', {
      user_id: userId,
      message: msg,
    }).then((res: any) => {
      if (typeof res?.retcode === 'number' && res.retcode !== 0) {
        console.error(`[Bot] 发送私聊消息失败: QQ${userId} retcode=${res.retcode} ${res.message || res.wording || ''}`);
        return false;
      }

      const msgId = res?.data?.message_id;
      if (msgId && onMessageId) {
        onMessageId(Number(msgId));
      }
      return true;
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] 发送私聊消息异常: QQ${userId} ${errMsg}`);
      return false;
    });
  }

  /** 调用 OneBot API（带回调） */
  callApiAsync(action: string, params: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'));
        return;
      }

      const echo = `${action}_${++this.echoCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        const callback = this.apiCallbacks.get(echo);
        if (!callback) return;
        this.apiCallbacks.delete(echo);
        callback.reject(new Error('API 调用超时'));
      }, Math.max(500, timeoutMs));
      timer.unref();

      this.apiCallbacks.set(echo, { resolve, reject, timer });

      const payload = JSON.stringify({ action, params, echo });
      this.ws.send(payload, (err) => {
        if (!err) return;
        const callback = this.apiCallbacks.get(echo);
        if (!callback) return;
        this.apiCallbacks.delete(echo);
        clearTimeout(callback.timer);
        callback.reject(err);
      });
    });
  }

  /** 调用 OneBot API（不等待响应） */
  callApi(action: string, params: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[Bot] WebSocket 未连接，无法调用 API:', action);
      return;
    }

    const payload = JSON.stringify({ action, params });
    this.ws.send(payload, (err) => {
      if (err) {
        console.error(`[Bot] API 发送失败 ${action}:`, err.message);
      }
    });
  }

  /** 获取配置 */
  getConfig(): BotConfig {
    return this.config;
  }

  /** 更新配置 */
  updateConfig(config: Partial<BotConfig>): void {
    Object.assign(this.config, config);
  }
}
