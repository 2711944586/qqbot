import WebSocket from 'ws';
import { BotConfig, OneBotEvent, MessageSegment } from './types';
import { sanitizeOutgoingMessage } from './message-sanitize';

type ApiCallback = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type LoginInfoResponse = {
  retcode?: number;
  status?: string;
  message?: string;
  wording?: string;
  data?: {
    user_id?: number | string;
    nickname?: string;
  };
};

function readyStateName(state: number | undefined): string {
  switch (state) {
    case WebSocket.CONNECTING: return 'connecting';
    case WebSocket.OPEN: return 'open';
    case WebSocket.CLOSING: return 'closing';
    case WebSocket.CLOSED: return 'closed';
    default: return 'none';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Bot {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  /** 多机器人池 - 按优先级排序的 ws_url 列表 */
  private wsUrlPool: string[] = [];
  /** 当前正在使用的池索引 */
  private currentPoolIdx: number = 0;
  /** 当前激活的 ws_url - 实际连接的 */
  private currentWsUrl: string;
  private readonly startedAt = Date.now();
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
  private lastConnectedAt = 0;
  private lastDisconnectedAt = 0;
  private lastDisconnectCode = 0;
  private lastDisconnectReason = '';
  private lastError = '';
  private lastFrameAt = 0;
  private lastEventAt = 0;
  private lastPingAt = 0;
  private lastPongAt = 0;
  private staleHeartbeatReconnects = 0;
  private totalDisconnects = 0;
  private consecutiveEarlyDisconnects = 0;
  private framesAtConnectionOpen = 0;
  private lastConnectionHint = '';
  private framesReceived = 0;
  private eventsReceived = 0;
  private apiCalls = 0;
  private apiResponses = 0;
  private apiTimeouts = 0;
  private apiFailures = 0;
  private groupSendAttempts = 0;
  private privateSendAttempts = 0;
  private groupSendFailures = 0;
  private privateSendFailures = 0;
  private loginCheckTimer: NodeJS.Timeout | null = null;
  private loginCheckInFlight = false;
  private loginCheckPromise: Promise<void> | null = null;
  private loginCheckIntervalSeconds = 0;
  private lastLoginCheckAt = 0;
  private lastLoginOkAt = 0;
  private lastLoginOk = false;
  private lastLoginUserId = 0;
  private lastLoginNickname = '';
  private lastLoginError = '';
  private loginCheckFailures = 0;
  private loginCheckSuccesses = 0;

  constructor(config: BotConfig) {
    this.config = config;
    // 构建 ws_url 池：优先 bot_pool（按 priority 排序），fallback 到 ws_url
    if (config.bot_pool && config.bot_pool.length > 0) {
      const sorted = [...config.bot_pool].sort((a, b) => (a.priority || 99) - (b.priority || 99));
      this.wsUrlPool = sorted.map((e) => e.ws_url).filter(Boolean);
    }
    if (this.wsUrlPool.length === 0) {
      this.wsUrlPool = [config.ws_url];
    }
    this.currentWsUrl = this.wsUrlPool[0];
  }

  /** 心跳保活 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const now = Date.now();
          if (this.lastPingAt && this.lastPongAt < this.lastPingAt && now - this.lastPingAt > 90000) {
            this.staleHeartbeatReconnects++;
            this.lastError = 'WebSocket heartbeat stale';
            console.error('[Bot] WebSocket 心跳超时，主动断开等待重连');
            this.ws.terminate();
            return;
          }
          if (!this.lastPingAt || this.lastPongAt >= this.lastPingAt) {
            this.lastPingAt = now;
          }
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
    const poolInfo = this.wsUrlPool.length > 1 ? ` [pool ${this.currentPoolIdx + 1}/${this.wsUrlPool.length}]` : '';
    console.log(`[Bot] 正在连接 ${this.currentWsUrl}${poolInfo} ...`);
    const ws = new WebSocket(this.currentWsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      this.reconnectInterval = this.minReconnectInterval;
      this.lastConnectedAt = Date.now();
      this.lastPongAt = Date.now();
      this.lastError = '';
      this.framesAtConnectionOpen = this.framesReceived;
      console.log('[Bot] ✅ WebSocket 连接成功！');
      // 定时发送心跳保持连接活跃
      this.startHeartbeat();
      this.ensureLoginCheckTimer(true);
    });

    ws.on('message', (data) => {
      try {
        this.framesReceived++;
        this.lastFrameAt = Date.now();
        const parsed = JSON.parse(data.toString());

        // 处理 API 响应
        if (parsed.echo && this.apiCallbacks.has(parsed.echo)) {
          const cb = this.apiCallbacks.get(parsed.echo)!;
          this.apiCallbacks.delete(parsed.echo);
          clearTimeout(cb.timer);
          this.apiResponses++;
          cb.resolve(parsed);
          return;
        }

        // 处理事件
        this.dispatchEvent(parsed as OneBotEvent);
      } catch (err) {
        console.error('[Bot] 解析消息失败:', err);
      }
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      this.connecting = false;
      if (this.ws === ws) this.ws = null;
      this.stopHeartbeat();
      this.lastDisconnectedAt = Date.now();
      this.lastDisconnectCode = code;
      this.lastDisconnectReason = reason.toString();
      this.totalDisconnects++;
      this.markLoginDisconnected(`WebSocket 已断开 code=${code}${reason.length > 0 ? ` reason=${reason.toString()}` : ''}`);
      const connectedForMs = this.lastConnectedAt > 0 ? this.lastDisconnectedAt - this.lastConnectedAt : 0;
      const framesDuringConnection = this.framesReceived - this.framesAtConnectionOpen;
      const earlyDisconnect = code === 1006 && connectedForMs < 10000 && framesDuringConnection <= 1;
      if (earlyDisconnect) {
        this.consecutiveEarlyDisconnects++;
        if (this.consecutiveEarlyDisconnects >= 3) {
          this.lastConnectionHint = `连续${this.consecutiveEarlyDisconnects}次WebSocket很快断开，常见原因是NapCat未完成QQ登录、QQ掉线、OneBot配置未生效或端口映射不对`;
          console.error(`[Bot] ${this.lastConnectionHint}。先看 docker logs napcat，再进 WebUI 扫码/重新登录。`);
        }
      } else {
        this.consecutiveEarlyDisconnects = 0;
      }
      this.rejectPendingApi(new Error(`WebSocket 已断开 code=${code}`));
      if (this.manuallyClosed) return;

      const reasonText = reason.length > 0 ? ` reason=${reason.toString()}` : '';
      console.log(`[Bot] 连接断开 code=${code}${reasonText}，${Math.round(this.reconnectInterval / 1000)}秒后重连...`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.connecting = false;
      this.lastError = err.message;
      console.error('[Bot] WebSocket 错误:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    // 如果有多个池成员且当前频繁失败，切换到下一个
    if (this.wsUrlPool.length > 1 && this.consecutiveEarlyDisconnects >= 2) {
      this.currentPoolIdx = (this.currentPoolIdx + 1) % this.wsUrlPool.length;
      this.currentWsUrl = this.wsUrlPool[this.currentPoolIdx];
      this.consecutiveEarlyDisconnects = 0;
      console.log(`[Bot] 切换到备用 ws_url: ${this.currentWsUrl}`);
    }
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

  private ensureLoginCheckTimer(runSoon: boolean = false): void {
    const intervalSeconds = Math.floor(Number(this.config.login_check_interval_seconds ?? 60));
    const nextInterval = Math.max(0, Math.min(intervalSeconds, 3600));
    if (this.loginCheckTimer && nextInterval === this.loginCheckIntervalSeconds) {
      if (runSoon) void this.runLoginCheck();
      return;
    }

    if (this.loginCheckTimer) {
      clearInterval(this.loginCheckTimer);
      this.loginCheckTimer = null;
    }
    this.loginCheckIntervalSeconds = nextInterval;
    if (nextInterval <= 0) return;

    this.loginCheckTimer = setInterval(() => {
      void this.runLoginCheck();
    }, nextInterval * 1000);
    this.loginCheckTimer.unref();
    if (runSoon) void this.runLoginCheck();
  }

  private async runLoginCheck(): Promise<void> {
    if (this.loginCheckPromise) return this.loginCheckPromise;
    this.loginCheckPromise = this.performLoginCheck().finally(() => {
      this.loginCheckPromise = null;
    });
    return this.loginCheckPromise;
  }

  private async performLoginCheck(): Promise<void> {
    const previousOk = this.lastLoginOk;
    this.lastLoginCheckAt = Date.now();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.recordLoginCheckFailure('WebSocket 未连接', previousOk);
      return;
    }

    this.loginCheckInFlight = true;
    try {
      const timeoutMs = Math.max(1000, Math.min(Number(this.config.login_check_api_timeout_ms ?? 5000), 60000));
      const res = await this.callApiAsync('get_login_info', {}, timeoutMs) as LoginInfoResponse;
      if (typeof res?.retcode === 'number' && res.retcode !== 0) {
        this.recordLoginCheckFailure(`retcode=${res.retcode} ${res.message || res.wording || res.status || ''}`.trim(), previousOk);
        return;
      }

      const userId = this.parseLoginUserId(res);
      const nickname = String(res?.data?.nickname || '').trim();
      if (userId <= 0) {
        this.recordLoginCheckFailure('get_login_info 返回成功但没有有效 user_id，QQ可能已下线', previousOk);
        return;
      }

      if (this.config.bot_qq && this.config.bot_qq !== userId) {
        this.lastLoginUserId = userId;
        this.lastLoginNickname = nickname || this.lastLoginNickname;
        this.recordLoginCheckFailure(`QQ登录号不匹配: config.bot_qq=${this.config.bot_qq}，NapCat实际登录=${userId}`, previousOk);
        return;
      }

      this.lastLoginOk = true;
      this.lastLoginOkAt = Date.now();
      this.lastLoginUserId = userId;
      this.lastLoginNickname = nickname;
      this.lastLoginError = '';
      this.recordLoginCheckSuccess(previousOk);
    } catch (err) {
      this.recordLoginCheckFailure(err instanceof Error ? err.message : String(err), previousOk);
    } finally {
      this.loginCheckInFlight = false;
    }
  }

  private parseLoginUserId(res: LoginInfoResponse | undefined): number {
    const raw = res?.data?.user_id;
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
    return 0;
  }

  private recordLoginCheckSuccess(previousOk: boolean): void {
    this.loginCheckFailures = 0;
    this.loginCheckSuccesses++;
    this.consecutiveEarlyDisconnects = 0;
    this.lastConnectionHint = '';
    if (!previousOk) {
      console.log(`[Bot] 登录态检查恢复: QQ${this.lastLoginUserId || '-'} ${this.lastLoginNickname || ''}`.trim());
    }
  }

  private recordLoginCheckFailure(message: string, previousOk: boolean): void {
    this.lastLoginOk = false;
    this.lastLoginError = message || '登录态检查失败';
    this.loginCheckFailures++;
    if (previousOk || this.loginCheckFailures === 1 || this.loginCheckFailures % 5 === 0) {
      console.error(`[Bot] 登录态检查失败(${this.loginCheckFailures}): ${this.lastLoginError}。NapCat可能还在，但QQ可能已下线；优先去WebUI扫码/重新登录。`);
    }
  }

  private markLoginDisconnected(message: string): void {
    const wasOk = this.lastLoginOk;
    this.lastLoginOk = false;
    this.lastLoginError = message || 'WebSocket 已断开';
    if (wasOk) {
      console.error(`[Bot] 登录态已失效: ${this.lastLoginError}`);
    }
  }

  private rejectPendingApi(error: Error): void {
    this.apiFailures += this.apiCallbacks.size;
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
    if (this.loginCheckTimer) {
      clearInterval(this.loginCheckTimer);
      this.loginCheckTimer = null;
    }
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
    this.eventsReceived++;
    this.lastEventAt = Date.now();
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[Bot] 事件处理器异常:', err);
      }
    }
  }

  /** 发送群消息（追踪消息ID用于回复检测） */
  async sendGroupMessage(groupId: number, message: string | MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    this.groupSendAttempts++;
    const msg = this.normalizeOutgoingMessage(message);
    const batches = this.splitMediaBatches(msg);
    let sentAny = false;
    let failed = false;

    for (const batch of batches) {
      const ok = await this.sendGroupMessageBatch(groupId, batch, onMessageId);
      sentAny = sentAny || ok;
      failed = failed || !ok;
      if (!ok && this.isMediaBatch(batch)) {
        const noteOk = await this.sendGroupMessageBatch(groupId, this.mediaFailureNotice(batch));
        sentAny = sentAny || noteOk;
      }
    }
    return sentAny || !failed;
  }

  private sendGroupMessageBatch(groupId: number, msg: MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    return this.sendGroupMessageBatchOnce(groupId, msg, onMessageId).then(async (ok) => {
      if (ok) return true;
      const retryMsg = this.retryableMessage(msg);
      if (!retryMsg) return false;
      console.warn(`[Bot] 群${groupId} 消息发送失败，重试: ${this.describeMessage(msg)} -> ${this.describeMessage(retryMsg)}`);
      await delay(700);
      return this.sendGroupMessageBatchOnce(groupId, retryMsg, onMessageId);
    });
  }

  private sendGroupMessageBatchOnce(groupId: number, msg: MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    return this.callApiAsync('send_group_msg', {
      group_id: groupId,
      message: msg,
    }, this.sendTimeoutMs(msg)).then((res: any) => {
      if (typeof res?.retcode === 'number' && res.retcode !== 0) {
        this.groupSendFailures++;
        console.error(`[Bot] 发送群消息失败: 群${groupId} ${this.describeMessage(msg)} retcode=${res.retcode} ${res.message || res.wording || ''}`);
        return false;
      }

      const msgId = res?.data?.message_id;
      if (msgId && onMessageId) {
        onMessageId(Number(msgId));
      }
      return true;
    }).catch((err) => {
      this.groupSendFailures++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] 发送群消息异常: 群${groupId} ${this.describeMessage(msg)} ${errMsg}`);
      return false;
    });
  }

  /** 发送私聊消息 */
  async sendPrivateMessage(userId: number, message: string | MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    this.privateSendAttempts++;
    const msg = this.normalizeOutgoingMessage(message);
    const batches = this.splitMediaBatches(msg);
    let sentAny = false;
    let failed = false;

    for (const batch of batches) {
      const ok = await this.sendPrivateMessageBatch(userId, batch, onMessageId);
      sentAny = sentAny || ok;
      failed = failed || !ok;
      if (!ok && this.isMediaBatch(batch)) {
        const noteOk = await this.sendPrivateMessageBatch(userId, this.mediaFailureNotice(batch));
        sentAny = sentAny || noteOk;
      }
    }
    return sentAny || !failed;
  }

  private sendPrivateMessageBatch(userId: number, msg: MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    return this.sendPrivateMessageBatchOnce(userId, msg, onMessageId).then(async (ok) => {
      if (ok) return true;
      const retryMsg = this.retryableMessage(msg);
      if (!retryMsg) return false;
      console.warn(`[Bot] 私聊${userId} 消息发送失败，重试: ${this.describeMessage(msg)} -> ${this.describeMessage(retryMsg)}`);
      await delay(700);
      return this.sendPrivateMessageBatchOnce(userId, retryMsg, onMessageId);
    });
  }

  private sendPrivateMessageBatchOnce(userId: number, msg: MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> {
    return this.callApiAsync('send_private_msg', {
      user_id: userId,
      message: msg,
    }, this.sendTimeoutMs(msg)).then((res: any) => {
      if (typeof res?.retcode === 'number' && res.retcode !== 0) {
        this.privateSendFailures++;
        console.error(`[Bot] 发送私聊消息失败: QQ${userId} ${this.describeMessage(msg)} retcode=${res.retcode} ${res.message || res.wording || ''}`);
        return false;
      }

      const msgId = res?.data?.message_id;
      if (msgId && onMessageId) {
        onMessageId(Number(msgId));
      }
      return true;
    }).catch((err) => {
      this.privateSendFailures++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] 发送私聊消息异常: QQ${userId} ${this.describeMessage(msg)} ${errMsg}`);
      return false;
    });
  }

  private normalizeOutgoingMessage(message: string | MessageSegment[]): MessageSegment[] {
    const sanitized = sanitizeOutgoingMessage(message);
    if (typeof sanitized === 'string') {
      return [{ type: 'text', data: { text: sanitized } }];
    }
    const msg = sanitized.filter((seg) => {
      if (seg.type !== 'text') return true;
      return seg.data.text.length > 0;
    });
    return msg.length > 0 ? msg : [{ type: 'text', data: { text: '我在' } }];
  }

  private splitMediaBatches(message: MessageSegment[]): MessageSegment[][] {
    if (message.length <= 1 || !message.some((seg) => seg.type === 'image' || seg.type === 'record')) {
      return [message];
    }

    const batches: MessageSegment[][] = [];
    let current: MessageSegment[] = [];

    const flush = (): void => {
      if (current.length > 0) {
        batches.push(current);
        current = [];
      }
    };

    for (const seg of message) {
      if (seg.type === 'image' || seg.type === 'record') {
        flush();
        batches.push([seg]);
        continue;
      }
      current.push(seg);
    }
    flush();
    return batches.length > 0 ? batches : [message];
  }

  private sendTimeoutMs(message: MessageSegment[]): number {
    if (message.some((seg) => seg.type === 'image')) return 45000;
    if (message.some((seg) => seg.type === 'record')) return 45000;
    return 30000;
  }

  private retryableMessage(message: MessageSegment[]): MessageSegment[] | null {
    const withoutReply = message.filter((seg) => seg.type !== 'reply');
    if (withoutReply.length !== message.length && withoutReply.length > 0) return withoutReply;
    if (this.isMediaBatch(message)) return message;
    return null;
  }

  private isMediaBatch(message: MessageSegment[]): boolean {
    return message.some((seg) => seg.type === 'image' || seg.type === 'record');
  }

  private mediaFailureNotice(message: MessageSegment[]): MessageSegment[] {
    const hasImage = message.some((seg) => seg.type === 'image');
    const hasRecord = message.some((seg) => seg.type === 'record');
    const text = hasImage
      ? '图这下没发出去，文字先看着。管理员看 /status 和 NapCat 日志。'
      : hasRecord
        ? '语音这下没发出去，文字先顶一下。管理员看 /voice last 和 NapCat 日志。'
        : '媒体消息这下没发出去。';
    return [{ type: 'text', data: { text } }];
  }

  private describeMessage(message: MessageSegment[]): string {
    return message.map((seg) => {
      if (seg.type === 'text') return `text:${seg.data.text.length}`;
      if (seg.type === 'image' || seg.type === 'record') {
        const file = seg.data.file || '';
        return `${seg.type}:${file.startsWith('base64://') ? `base64:${Math.round(file.length / 1024)}KB` : file.slice(0, 48)}`;
      }
      if (seg.type === 'reply') return `reply:${seg.data.id}`;
      if (seg.type === 'at') return `at:${seg.data.qq}`;
      return seg.type;
    }).join(',');
  }

  /** 调用 OneBot API（带回调） */
  callApiAsync(action: string, params: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.apiFailures++;
        reject(new Error('WebSocket 未连接'));
        return;
      }

      const echo = `${action}_${++this.echoCounter}_${Date.now()}`;
      this.apiCalls++;
      const timer = setTimeout(() => {
        const callback = this.apiCallbacks.get(echo);
        if (!callback) return;
        this.apiCallbacks.delete(echo);
        this.apiTimeouts++;
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
        this.apiFailures++;
        callback.reject(err);
      });
    });
  }

  /** 调用 OneBot API（不等待响应） */
  callApi(action: string, params: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.apiFailures++;
      console.error('[Bot] WebSocket 未连接，无法调用 API:', action);
      return;
    }

    this.apiCalls++;
    const payload = JSON.stringify({ action, params });
    this.ws.send(payload, (err) => {
      if (err) {
        this.apiFailures++;
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
    this.ensureLoginCheckTimer();
  }

  async checkLoginNow(): Promise<ReturnType<Bot['getRuntimeStats']>> {
    await this.runLoginCheck();
    return this.getRuntimeStats();
  }

  /** 运行时连接和API统计，用于/status、/diag、/maint排障 */
  getRuntimeStats(): {
    startedAt: number;
    wsUrl: string;
    poolUrls: string[];
    poolActiveIdx: number;
    readyState: string;
    connected: boolean;
    connecting: boolean;
    manuallyClosed: boolean;
    reconnectScheduled: boolean;
    reconnectIntervalMs: number;
    pendingApi: number;
    lastConnectedAt: number;
    lastDisconnectedAt: number;
    lastDisconnectCode: number;
    lastDisconnectReason: string;
    lastError: string;
    lastFrameAt: number;
    lastEventAt: number;
    lastPingAt: number;
    lastPongAt: number;
    staleHeartbeatReconnects: number;
    totalDisconnects: number;
    consecutiveEarlyDisconnects: number;
    lastConnectionHint: string;
    framesReceived: number;
    eventsReceived: number;
    apiCalls: number;
    apiResponses: number;
    apiTimeouts: number;
    apiFailures: number;
    groupSendAttempts: number;
    privateSendAttempts: number;
    groupSendFailures: number;
    privateSendFailures: number;
    loginCheckIntervalSeconds: number;
    loginCheckInFlight: boolean;
    lastLoginCheckAt: number;
    lastLoginOkAt: number;
    lastLoginOk: boolean;
    lastLoginUserId: number;
    lastLoginNickname: string;
    lastLoginError: string;
    loginCheckFailures: number;
    loginCheckSuccesses: number;
  } {
    return {
      startedAt: this.startedAt,
      wsUrl: this.currentWsUrl,
      poolUrls: [...this.wsUrlPool],
      poolActiveIdx: this.currentPoolIdx,
      readyState: readyStateName(this.ws?.readyState),
      connected: this.ws?.readyState === WebSocket.OPEN,
      connecting: this.connecting,
      manuallyClosed: this.manuallyClosed,
      reconnectScheduled: !!this.reconnectTimer,
      reconnectIntervalMs: this.reconnectInterval,
      pendingApi: this.apiCallbacks.size,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectCode: this.lastDisconnectCode,
      lastDisconnectReason: this.lastDisconnectReason,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt,
      lastEventAt: this.lastEventAt,
      lastPingAt: this.lastPingAt,
      lastPongAt: this.lastPongAt,
      staleHeartbeatReconnects: this.staleHeartbeatReconnects,
      totalDisconnects: this.totalDisconnects,
      consecutiveEarlyDisconnects: this.consecutiveEarlyDisconnects,
      lastConnectionHint: this.lastConnectionHint,
      framesReceived: this.framesReceived,
      eventsReceived: this.eventsReceived,
      apiCalls: this.apiCalls,
      apiResponses: this.apiResponses,
      apiTimeouts: this.apiTimeouts,
      apiFailures: this.apiFailures,
      groupSendAttempts: this.groupSendAttempts,
      privateSendAttempts: this.privateSendAttempts,
      groupSendFailures: this.groupSendFailures,
      privateSendFailures: this.privateSendFailures,
      loginCheckIntervalSeconds: this.loginCheckIntervalSeconds,
      loginCheckInFlight: this.loginCheckInFlight,
      lastLoginCheckAt: this.lastLoginCheckAt,
      lastLoginOkAt: this.lastLoginOkAt,
      lastLoginOk: this.lastLoginOk,
      lastLoginUserId: this.lastLoginUserId,
      lastLoginNickname: this.lastLoginNickname,
      lastLoginError: this.lastLoginError,
      loginCheckFailures: this.loginCheckFailures,
      loginCheckSuccesses: this.loginCheckSuccesses,
    };
  }
}
