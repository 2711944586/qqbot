import { Bot } from './bot';
import { BotConfig, GroupMessageEvent, OneBotEvent, Plugin, PluginContext, MessageSegment } from './types';

export class MessageHandler {
  private bot: Bot;
  private plugins: Plugin[] = [];
  /** 记录bot发出的消息ID，用于检测回复 */
  private botMessageIds: Set<number> = new Set();
  private activeMessages = 0;
  private warnedSelfIdMismatch = false;

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

  /** 处理事件（非阻塞，每个群并行处理） */
  async handleEvent(event: OneBotEvent): Promise<void> {
    // 只处理群消息
    if (event.post_type !== 'message') return;
    if (event.message_type !== 'group') return;

    const groupEvent = event as GroupMessageEvent;
    const config = this.bot.getConfig();
    if (
      config.bot_qq &&
      config.bot_qq !== groupEvent.self_id &&
      !this.warnedSelfIdMismatch
    ) {
      this.warnedSelfIdMismatch = true;
      console.warn(`[Handler] config.bot_qq=${config.bot_qq} 但 OneBot self_id=${groupEvent.self_id}，请确认是否已切换到目标QQ号。`);
    }
    if (groupEvent.user_id === groupEvent.self_id) return;

    const isReplyToBot = await this.checkReplyToBot(groupEvent);
    const isAtBot = this.checkAtBot(groupEvent);

    // 如果配置了群白名单，普通消息只处理白名单内的群；直接@或回复bot仍然放行，避免“@了没反应”。
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupEvent.group_id) && !isAtBot && !isReplyToBot) {
      return;
    }

    // 非阻塞处理：不await，让每条消息独立处理
    this.activeMessages++;
    this.processMessage(groupEvent, config, isReplyToBot, isAtBot).catch((err) => {
      console.error('[Handler] 消息处理异常:', err);
      if (isAtBot || isReplyToBot) {
        void this.bot.sendGroupMessage(groupEvent.group_id, '我在 刚才没接住，你再说');
      }
    }).finally(() => {
      this.activeMessages = Math.max(0, this.activeMessages - 1);
    });
  }

  /** 实际处理消息 */
  private async processMessage(
    groupEvent: GroupMessageEvent,
    config: BotConfig,
    isReplyToBot: boolean,
    isAtBot: boolean,
  ): Promise<void> {

    // 提取纯文本
    const rawText = this.extractText(groupEvent.message).trim();

    // 解析命令
    const { command, args } = this.parseCommand(rawText, config.command_prefix);

    // 构建插件上下文
    const ctx: PluginContext = {
      event: groupEvent,
      rawText,
      command,
      args,
      isReplyToBot,
      bot: this.bot,
      reply: (message: string | MessageSegment[]) => {
        void this.bot.sendGroupMessage(groupEvent.group_id, message, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyAt: (message: string) => {
        const atMsg: MessageSegment[] = [
          { type: 'at', data: { qq: String(groupEvent.user_id) } },
          { type: 'text', data: { text: ' ' + message } },
        ];
        void this.bot.sendGroupMessage(groupEvent.group_id, atMsg, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyQuote: (message: string) => {
        const quoteMsg: MessageSegment[] = [
          { type: 'reply', data: { id: String(groupEvent.message_id) } },
          { type: 'text', data: { text: message } },
        ];
        void this.bot.sendGroupMessage(groupEvent.group_id, quoteMsg, (id) => {
          this.trackBotMessage(id);
        }).then((sent) => {
          if (sent) return;
          const fallbackMsg: MessageSegment[] = [
            { type: 'at', data: { qq: String(groupEvent.user_id) } },
            { type: 'text', data: { text: ' ' + message } },
          ];
          return this.bot.sendGroupMessage(groupEvent.group_id, fallbackMsg, (id) => {
            this.trackBotMessage(id);
          });
        });
      },
      replyQuoteTo: (messageId: number, userId: number, message: string) => {
        const quoteMsg: MessageSegment[] = [
          { type: 'reply', data: { id: String(messageId) } },
          { type: 'text', data: { text: message } },
        ];
        void this.bot.sendGroupMessage(groupEvent.group_id, quoteMsg, (id) => {
          this.trackBotMessage(id);
        }).then((sent) => {
          if (sent) return;
          const fallbackMsg: MessageSegment[] = [
            { type: 'at', data: { qq: String(userId) } },
            { type: 'text', data: { text: ' ' + message } },
          ];
          return this.bot.sendGroupMessage(groupEvent.group_id, fallbackMsg, (id) => {
            this.trackBotMessage(id);
          });
        });
      },
    };

    // 依次执行插件
    let handled = false;
    for (const plugin of this.plugins) {
      try {
        handled = await this.runPlugin(plugin, ctx, config);
        if (handled && (isAtBot || isReplyToBot) && !ctx.command && plugin.name !== 'ai-chat') {
          handled = false;
          continue;
        }
        if (handled) break;
      } catch (err) {
        console.error(`[Handler] 插件 ${plugin.name} 执行异常:`, err);
      }
    }

    if (!handled && (isAtBot || isReplyToBot)) {
      ctx.replyQuote('我在 刚才没接住，你再说');
    }
  }

  private runPlugin(plugin: Plugin, ctx: PluginContext, config: BotConfig): Promise<boolean> {
    const baseTimeoutMs = Math.max(90000, (config.ai?.api_timeout_ms || 15000) * 3 + 30000);
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
