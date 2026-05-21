import { Bot } from './bot';
import { GroupMessageEvent, OneBotEvent, Plugin, PluginContext, MessageSegment } from './types';

export class MessageHandler {
  private bot: Bot;
  private plugins: Plugin[] = [];
  /** 记录bot发出的消息ID，用于检测回复 */
  private botMessageIds: Set<number> = new Set();

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

  /** 处理事件 */
  async handleEvent(event: OneBotEvent): Promise<void> {
    // 只处理群消息
    if (event.post_type !== 'message') return;
    if (event.message_type !== 'group') return;

    const groupEvent = event as GroupMessageEvent;
    const config = this.bot.getConfig();

    // 如果配置了群白名单，只处理白名单内的群
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupEvent.group_id)) {
      return;
    }

    // 忽略自己发的消息
    if (groupEvent.user_id === groupEvent.self_id) return;

    // 提取纯文本
    const rawText = this.extractText(groupEvent.message).trim();

    // 解析命令
    const { command, args } = this.parseCommand(rawText, config.command_prefix);

    // 检测是否是回复bot的消息
    const isReplyToBot = this.checkReplyToBot(groupEvent);

    // 构建插件上下文
    const ctx: PluginContext = {
      event: groupEvent,
      rawText,
      command,
      args,
      isReplyToBot,
      bot: this.bot,
      reply: (message: string | MessageSegment[]) => {
        this.bot.sendGroupMessage(groupEvent.group_id, message, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyAt: (message: string) => {
        const atMsg: MessageSegment[] = [
          { type: 'at', data: { qq: String(groupEvent.user_id) } },
          { type: 'text', data: { text: ' ' + message } },
        ];
        this.bot.sendGroupMessage(groupEvent.group_id, atMsg, (id) => {
          this.trackBotMessage(id);
        });
      },
      replyQuote: (message: string) => {
        const quoteMsg: MessageSegment[] = [
          { type: 'reply', data: { id: String(groupEvent.message_id) } },
          { type: 'text', data: { text: message } },
        ];
        this.bot.sendGroupMessage(groupEvent.group_id, quoteMsg, (id) => {
          this.trackBotMessage(id);
        });
      },
    };

    // 依次执行插件
    for (const plugin of this.plugins) {
      try {
        const handled = await plugin.handler(ctx);
        if (handled) break;
      } catch (err) {
        console.error(`[Handler] 插件 ${plugin.name} 执行异常:`, err);
      }
    }
  }

  /** 检测消息是否是回复bot的消息 */
  private checkReplyToBot(event: GroupMessageEvent): boolean {
    const replySeg = event.message.find((seg) => seg.type === 'reply');
    if (!replySeg || replySeg.type !== 'reply') return false;
    const replyId = parseInt(replySeg.data.id);
    return this.botMessageIds.has(replyId);
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
