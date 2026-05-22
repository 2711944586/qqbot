import { Bot } from '../bot';
import { PrivateMessageEvent, OneBotEvent } from '../types';

/**
 * 私聊转发插件
 * 有人私聊bot时，只做日志和管理员通知。
 * 真正回复由 MessageHandler 的私聊消息链路处理，避免一条私聊触发两次回复。
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
          void bot.sendPrivateMessage(admin, forwardMsg);
        }
      }
    }
  });

  console.log('[Private] 私聊日志/管理员转发已启用，私聊回复走主插件链');
}
