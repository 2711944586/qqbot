import { Bot } from '../bot';
import { PrivateMessageEvent, OneBotEvent } from '../types';

/**
 * 私聊转发插件
 * 有人私聊bot时，转发给管理员，并且用AI回复私聊者
 */

export function registerPrivateForward(bot: Bot): void {
  bot.onEvent((event: OneBotEvent) => {
    if (event.post_type !== 'message') return;
    if (event.message_type !== 'private') return;

    const e = event as PrivateMessageEvent;
    // 忽略自己
    if (e.user_id === e.self_id) return;

    const config = bot.getConfig();
    const name = e.sender.nickname || String(e.user_id);

    console.log(`[私聊] ${name}(${e.user_id}): ${e.raw_message}`);

    // 转发给管理员
    if (config.admin_qq.length > 0) {
      const forwardMsg = `[私聊转发]\n来自: ${name}(${e.user_id})\n内容: ${e.raw_message}`;
      for (const admin of config.admin_qq) {
        if (admin !== e.user_id) {
          bot.sendPrivateMessage(admin, forwardMsg);
        }
      }
    }

    // 简单自动回复（告知是群聊bot）
    const autoReplies = [
      '我是群 bot，私聊没什么节目效果，有事群里@我。',
      '私聊我没啥用，去群里说，别搁这单走白给。',
      '去群里找我聊，私聊我一般不接弹幕。',
    ];

    // 如果是管理员私聊，不自动回复
    if (config.admin_qq.includes(e.user_id)) return;

    const reply = autoReplies[Math.floor(Math.random() * autoReplies.length)];
    bot.sendPrivateMessage(e.user_id, reply);
  });

  console.log('[Private] 私聊转发已启用');
}
