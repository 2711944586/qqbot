import { Bot } from '../bot';
import { NoticeEvent } from '../types';

/**
 * 撤回监控插件（可选）
 * 有人撤回消息时，bot可以提一嘴（可配置开关）
 * 注意：需要bot是管理员才能获取到撤回通知
 */

// 记录最近的消息（用于显示撤回内容）- 简易实现
const recentMessages: Map<number, { user: string; text: string }> = new Map();

/** 记录消息（供外部调用） */
export function recordMessage(messageId: number, userName: string, text: string): void {
  recentMessages.set(messageId, { user: userName, text });
  // 只保留最近200条
  if (recentMessages.size > 200) {
    const keys = [...recentMessages.keys()];
    for (let i = 0; i < keys.length - 200; i++) {
      recentMessages.delete(keys[i]);
    }
  }
}

const recallReplies = [
  '{name} 撤回了什么 让我看看',
  '撤回也没用 弹幕已经看到了',
  '{name} 你这个撤回timing很怪',
  '不是哥们 刚说完就撤回？',
  '来不及了 我已经记住了（没有',
];

export function registerRecallListener(bot: Bot, enabled: boolean = true): void {
  if (!enabled) return;

  bot.onEvent((event) => {
    if (event.post_type !== 'notice') return;

    const notice = event as NoticeEvent;
    if (notice.notice_type !== 'group_recall') return;

    const groupId = notice.group_id;
    const userId = notice.user_id;
    if (!groupId || !userId) return;

    // 不监控自己的撤回
    if (userId === notice.self_id) return;

    const config = bot.getConfig();
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupId)) return;

    // 30%概率提一嘴（不要每次都说，太烦人）
    if (Math.random() > 0.3) return;

    // 获取撤回者信息
    const msgId = (notice as any).message_id;
    const cached = msgId ? recentMessages.get(msgId) : null;

    let reply: string;
    if (cached) {
      const templates = [
        `${cached.user} 刚才这句「${cached.text.slice(0, 30)}」怎么撤了，不是哥们`,
        `来不及了 ${cached.user}，这波已经被弹幕捕获`,
        `${cached.user} 这个撤回有点心虚啊`,
      ];
      reply = templates[Math.floor(Math.random() * templates.length)];
    } else {
      reply = recallReplies[Math.floor(Math.random() * recallReplies.length)]
        .replace('{name}', '有人');
    }

    bot.sendGroupMessage(groupId, reply);
  });

  console.log('[Recall] 撤回监控已启用');
}
