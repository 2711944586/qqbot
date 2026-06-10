import { Bot } from './bot';
import { BotConfig, GroupMessageEvent, MessageEvent, OneBotEvent, Plugin, PluginContext, MessageSegment } from './types';

export class MessageHandler {
  private bot: Bot;
  private plugins: Plugin[] = [];
  /** 记录bot发出的消息ID，用于检测回复 */
  private botMessageIds: Set<number> = new Set();
  private activeMessages = 0;
  private warnedSelfIdMismatch = false;
  private warnedNonArrayMessage = false;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /** 注册插件 */
  use(plugin: Plugin): void {
    this.plugins.push(plugin);
    console.log(`[Handler] 已加载插件: ${plugin.name} - ${plugin.description}`);
  }

  /** 记录bot发送的消息ID */
  trackBotMessage(messageId: number): void {
    this.botMessageIds.add(messageId);
    // 只保留最近500条，防止内存泄漏
    if (this.botMessageIds.size > 500) {
      const arr = [...this.botMessageIds];
      this.botMessageIds = new Set(arr.slice(-300));
    }
  }

  /** 处理事件（非阻塞，每个聊天独立处理） */
  async handleEvent(event: OneBotEvent): Promise<void> {
    if (event.post_type !== 'message') return;
    if (event.message_type !== 'group' && event.message_type !== 'private') return;

    const messageEvent = this.normalizeMessage(event as MessageEvent);
    const config = this.bot.getConfig();
    if (
      config.bot_qq &&
      config.bot_qq !== messageEvent.self_id &&
      !this.warnedSelfIdMismatch
    ) {
      this.warnedSelfIdMismatch = true;
      console.warn(`[Handler] config.bot_qq=${config.bot_qq} 但 OneBot self_id=${messageEvent.self_id}，请确认是否已切换到目标QQ号。`);
    }
    if (messageEvent.user_id === messageEvent.self_id) return;

    const isGroup = messageEvent.message_type === 'group';
    const isReplyToBot = isGroup
      ? await this.checkReplyToBot(messageEvent as GroupMessageEvent)
      : true;
    const isAtBot = isGroup
      ? this.checkAtBot(messageEvent as GroupMessageEvent)
      : false;

    // 如果配置了群白名单，普通消息只处理白名单内的群；直接@或回复bot仍然放行，避免“@了没反应”。
    if (
      isGroup &&
      config.enabled_groups.length > 0 &&
      !config.enabled_groups.includes((messageEvent as GroupMessageEvent).group_id) &&
      !isAtBot &&
      !isReplyToBot
    ) {
      return;
    }

    // 非阻塞处理：不await，让每条消息独立处理
    this.activeMessages++;
    this.processMessage(messageEvent, config, isReplyToBot, isAtBot).catch((err) => {
      console.error('[Handler] 消息处理异常:', err);
      if (isAtBot || isReplyToBot) {
        this.sendFallback(messageEvent, '我在 刚才没接住，你再说');
      }
    }).finally(() => {
      this.activeMessages = Math.max(0, this.activeMessages - 1);
    });
  }

  private sendFallback(event: MessageEvent, text: string): void {
    if (event.message_type === 'group') {
      const fallbackMsg: MessageSegment[] = [
        { type: 'reply', data: { id: String(event.message_id) } },
        { type: 'text', data: { text } },
      ];
      void this.bot.sendGroupMessage(event.group_id, fallbackMsg);
      return;
    }
    void this.bot.sendPrivateMessage(event.user_id, text);
  }

  private normalizeMessage(event: MessageEvent): MessageEvent {
    const runtimeEvent = event as MessageEvent & { message: MessageSegment[] | string };
    if (Array.isArray(runtimeEvent.message)) return event;

    if (!this.warnedNonArrayMessage) {
      this.warnedNonArrayMessage = true;
      console.warn('[Handler] OneBot message 不是array格式，已尝试兼容CQ码；建议在NapCat里设置 messagePostFormat=array。');
    }

    const raw = typeof runtimeEvent.message === 'string'
      ? runtimeEvent.message
      : (event.raw_message || '');
    runtimeEvent.message = this.parseCqMessage(raw);
    if (!event.raw_message) event.raw_message = raw;
    return event;
  }

  private parseCqMessage(raw: string): MessageSegment[] {
    const segments: MessageSegment[] = [];
    const pattern = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    const pushText = (text: string) => {
      if (!text) return;
      segments.push({ type: 'text', data: { text: this.decodeCqText(text) } });
    };

    while ((match = pattern.exec(raw))) {
      pushText(raw.slice(lastIndex, match.index));
      const type = match[1];
      const data = this.parseCqData(match[2] || '');
      if (type === 'at' && data.qq) {
        segments.push({ type: 'at', data: { qq: String(data.qq) } });
      } else if (type === 'reply' && data.id) {
        segments.push({ type: 'reply', data: { id: String(data.id) } });
      } else if (type === 'image') {
        segments.push({ type: 'image', data: { file: String(data.file || data.url || ''), url: data.url ? String(data.url) : undefined } });
      } else if (type === 'record') {
        segments.push({ type: 'record', data: { file: String(data.file || data.url || ''), url: data.url ? String(data.url) : undefined } });
      } else if (type === 'face' && data.id) {
        segments.push({ type: 'face', data: { id: String(data.id) } });
      }
      lastIndex = pattern.lastIndex;
    }
    pushText(raw.slice(lastIndex));
    return segments.length > 0 ? segments : [{ type: 'text', data: { text: raw } }];
  }

  private parseCqData(raw: string): Record<string, string> {
    const data: Record<string, string> = {};
    for (const part of raw.replace(/^,/, '').split(',')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      data[key] = this.decodeCqText(value);
    }
    return data;
  }

  private decodeCqText(text: string): string {
    return text
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
  }

  /** 实际处理消息 */
  private async processMessage(
    messageEvent: MessageEvent,
    config: BotConfig,
    isReplyToBot: boolean,
    isAtBot: boolean,
  ): Promise<void> {
    const isPrivate = messageEvent.message_type === 'private';
    const chatType = isPrivate ? 'private' : 'group';
    const chatId = isPrivate ? messageEvent.user_id : messageEvent.group_id;
    const groupId = isPrivate ? undefined : messageEvent.group_id;

    // 提取纯文本
    const rawText = this.extractText(messageEvent.message).trim();

    // 解析命令
    const { command, args } = this.parseCommand(rawText, config.command_prefix);

    const sendMessage = (message: string | MessageSegment[], onMessageId?: (id: number) => void): Promise<boolean> => {
      if (messageEvent.message_type === 'group') {
        return this.bot.sendGroupMessage(messageEvent.group_id, message, onMessageId);
      }
      return this.bot.sendPrivateMessage(messageEvent.user_id, message, onMessageId);
    };

    // 构建插件上下文
    const ctx: PluginContext = {
      event: messageEvent,
      rawText,
      command,
      args,
      chatType,
      chatId,
      groupId,
      isPrivate,
      isAtBot,
      isReplyToBot,
      bot: this.bot,
      reply: (message: string | MessageSegment[]) => {
        void sendMessage(message, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyAt: (message: string) => {
        if (isPrivate) {
          void sendMessage(message, (id) => {
            this.trackBotMessage(id);
          });
          return;
        }
        const atMsg: MessageSegment[] = [
          { type: 'at', data: { qq: String(messageEvent.user_id) } },
          { type: 'text', data: { text: ' ' + message } },
        ];
        void sendMessage(atMsg, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyQuote: (message: string) => {
        if (isPrivate) {
          void sendMessage(message, (id) => {
            this.trackBotMessage(id);
          });
          return;
        }
        const quoteMsg: MessageSegment[] = [
          { type: 'reply', data: { id: String(messageEvent.message_id) } },
          { type: 'text', data: { text: message } },
        ];
        void sendMessage(quoteMsg, (id) => {
          this.trackBotMessage(id);
        }).then((sent) => {
          if (sent) return;
          const fallbackMsg: MessageSegment[] = [
            { type: 'at', data: { qq: String(messageEvent.user_id) } },
            { type: 'text', data: { text: ' ' + message } },
          ];
          return sendMessage(fallbackMsg, (id) => {
            this.trackBotMessage(id);
          });
        });
      },
      replyQuoteTo: (messageId: number, userId: number, message: string | MessageSegment[]) => {
        if (isPrivate) {
          void sendMessage(message, (id) => {
            this.trackBotMessage(id);
          });
          return;
        }
        const messageSegs: MessageSegment[] = typeof message === 'string'
          ? [{ type: 'text', data: { text: message } }]
          : message;
        const quoteMsg: MessageSegment[] = [
          { type: 'reply', data: { id: String(messageId) } },
          ...messageSegs,
        ];
        void sendMessage(quoteMsg, (id) => {
          this.trackBotMessage(id);
        }).then((sent) => {
          if (sent) return;
          const fallbackMsg: MessageSegment[] = [
            { type: 'at', data: { qq: String(userId) } },
            { type: 'text', data: { text: ' ' } },
            ...messageSegs,
          ];
          return sendMessage(fallbackMsg, (id) => {
            this.trackBotMessage(id);
          });
        });
      },
    };

    // 依次执行插件
    let handled = false;
    for (const plugin of this.plugins) {
      try {
        if (isPrivate && this.isGroupOnlyPlugin(plugin.name)) continue;
        handled = await this.runPlugin(plugin, ctx, config);
        if (handled && (isAtBot || isReplyToBot) && !ctx.command && !this.canHandleNaturalDirectedMessage(plugin.name)) {
          handled = false;
          continue;
        }
        if (handled) break;
      } catch (err) {
        console.error(`[Handler] 插件 ${plugin.name} 执行异常:`, err);
      }
    }

    if (!handled && (isAtBot || isReplyToBot || this.isDirectAiCommand(command))) {
      ctx.replyQuote('我在 刚才没接住，你再说');
    }
  }

  private isGroupOnlyPlugin(pluginName: string): boolean {
    return pluginName === 'stats' || pluginName === 'repeater';
  }

  private canHandleNaturalDirectedMessage(pluginName: string): boolean {
    return ['ai-chat', 'fun', 'cs', 'cs-report', 'cs-watch', 'cs-predict'].includes(pluginName);
  }

  private isDirectAiCommand(command: string | null): boolean {
    return command === 'ai' || command === 'ask' || command === 'chat';
  }

  private runPlugin(plugin: Plugin, ctx: PluginContext, config: BotConfig): Promise<boolean> {
    const baseTimeoutMs = Math.max(90000, (config.ai?.api_timeout_ms || 60000) * 3 + 30000);
    const timeoutMs = plugin.name === 'ai-chat'
      ? Math.max(300000, baseTimeoutMs)
      : baseTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.error(`[Handler] 插件 ${plugin.name} 执行超时`);
        resolve(false);
      }, timeoutMs);
      timer.unref();

      let result: Promise<boolean> | boolean;
      try {
        result = plugin.handler(ctx);
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        return;
      }

      Promise.resolve(result)
        .then((handled) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(handled);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** 检测消息是否是回复bot的消息 */
  private async checkReplyToBot(event: GroupMessageEvent): Promise<boolean> {
    const replySeg = event.message.find((seg) => seg.type === 'reply');
    if (!replySeg || replySeg.type !== 'reply') return false;
    const data = replySeg.data as Record<string, unknown>;
    const repliedUser = data.qq ?? data.user_id ?? data.sender_id;
    if (String(repliedUser || '') === String(event.self_id)) return true;

    const replyId = parseInt(String(replySeg.data.id));
    if (!Number.isFinite(replyId)) return false;
    if (this.botMessageIds.has(replyId)) return true;

    try {
      const res = await this.bot.callApiAsync('get_msg', { message_id: replyId }, 1500) as {
        data?: {
          user_id?: number | string;
          sender?: { user_id?: number | string };
        };
      };
      const senderId = res.data?.sender?.user_id ?? res.data?.user_id;
      return String(senderId || '') === String(event.self_id);
    } catch {
      return false;
    }
  }

  /** 检测消息是否@了bot（兼容qq为数字/字符串以及raw_message格式） */
  private checkAtBot(event: GroupMessageEvent): boolean {
    const selfId = String(event.self_id);
    return event.message.some((seg) => (
      seg.type === 'at' && String(seg.data.qq) === selfId
    )) || event.raw_message.includes(`[CQ:at,qq=${selfId}]`);
  }

  /** 从消息段中提取纯文本 */
  private extractText(message: MessageSegment[]): string {
    return message
      .filter((seg) => seg.type === 'text')
      .map((seg) => (seg as { type: 'text'; data: { text: string } }).data.text)
      .join('');
  }

  /** 解析命令 */
  private parseCommand(text: string, prefix: string): { command: string | null; args: string[] } {
    if (!text.startsWith(prefix)) {
      return { command: null, args: [] };
    }

    const parts = text.slice(prefix.length).split(/\s+/);
    const command = parts[0]?.toLowerCase() || null;
    const args = parts.slice(1);
    return { command, args };
  }
}
