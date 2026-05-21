import WebSocket from 'ws';
import { BotConfig, OneBotEvent, MessageSegment } from './types';

export class Bot {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  private reconnectInterval = 5000;
  private eventHandlers: ((event: OneBotEvent) => void)[] = [];
  private apiCallbacks: Map<string, (data: unknown) => void> = new Map();
  private echoCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /** 心跳保活 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  /** 注册事件处理器 */
  onEvent(handler: (event: OneBotEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** 启动连接 */
  connect(): void {
    console.log(`[Bot] 正在连接 ${this.config.ws_url} ...`);
    this.ws = new WebSocket(this.config.ws_url);

    this.ws.on('open', () => {
      console.log('[Bot] ✅ WebSocket 连接成功！');
      // 定时发送心跳保持连接活跃
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        // 处理 API 响应
        if (parsed.echo && this.apiCallbacks.has(parsed.echo)) {
          const cb = this.apiCallbacks.get(parsed.echo)!;
          this.apiCallbacks.delete(parsed.echo);
          cb(parsed);
          return;
        }

        // 处理事件
        this.dispatchEvent(parsed as OneBotEvent);
      } catch (err) {
        console.error('[Bot] 解析消息失败:', err);
      }
    });

    this.ws.on('close', () => {
      console.log(`[Bot] 连接断开，${this.reconnectInterval / 1000}秒后重连...`);
      setTimeout(() => this.connect(), this.reconnectInterval);
    });

    this.ws.on('error', (err) => {
      console.error('[Bot] WebSocket 错误:', err.message);
    });
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
  sendGroupMessage(groupId: number, message: string | MessageSegment[], onMessageId?: (id: number) => void): void {
    const msg = typeof message === 'string'
      ? [{ type: 'text', data: { text: message } }]
      : message;

    this.callApiAsync('send_group_msg', {
      group_id: groupId,
      message: msg,
    }).then((res: any) => {
      const msgId = res?.data?.message_id;
      if (msgId && onMessageId) {
        onMessageId(msgId);
      }
    }).catch(() => { /* 静默忽略发送失败 */ });
  }

  /** 发送私聊消息 */
  sendPrivateMessage(userId: number, message: string | MessageSegment[]): void {
    const msg = typeof message === 'string'
      ? [{ type: 'text', data: { text: message } }]
      : message;

    this.callApi('send_private_msg', {
      user_id: userId,
      message: msg,
    });
  }

  /** 调用 OneBot API（带回调） */
  callApiAsync(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'));
        return;
      }

      const echo = `${action}_${++this.echoCounter}_${Date.now()}`;
      this.apiCallbacks.set(echo, resolve);

      const payload = JSON.stringify({ action, params, echo });
      this.ws.send(payload);

      // 超时清理
      setTimeout(() => {
        if (this.apiCallbacks.has(echo)) {
          this.apiCallbacks.delete(echo);
          reject(new Error('API 调用超时'));
        }
      }, 10000);
    });
  }

  /** 调用 OneBot API（不等待响应） */
  callApi(action: string, params: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[Bot] WebSocket 未连接，无法调用 API:', action);
      return;
    }

    const payload = JSON.stringify({ action, params });
    this.ws.send(payload);
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
