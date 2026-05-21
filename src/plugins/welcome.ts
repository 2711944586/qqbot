import { Plugin, NoticeEvent } from '../types';
import { Bot } from '../bot';

/**
 * 入群欢迎插件
 * 注意：这个插件通过 Bot 事件系统触发，不走常规命令路由
 */

/** 欢迎消息模板 */
const welcomeTemplates = [
  '🎉 欢迎 {name} 加入本群！有什么问题可以 @我 哦~',
  '👋 {name} 来啦！欢迎欢迎~',
  '✨ 欢迎新朋友 {name}！祝你在群里玩得开心~',
  '🌟 {name} 加入了我们，大家热烈欢迎！',
];

function getRandomWelcome(name: string): string {
  const template = welcomeTemplates[Math.floor(Math.random() * welcomeTemplates.length)];
  return template.replace('{name}', name);
}

/** 注册入群欢迎监听器 */
export function registerWelcomeListener(bot: Bot): void {
  bot.onEvent((event) => {
    if (event.post_type !== 'notice') return;

    const notice = event as NoticeEvent;
    if (notice.notice_type !== 'group_increase') return;

    const groupId = notice.group_id;
    const userId = notice.user_id;
    if (!groupId || !userId) return;

    // 不欢迎自己
    if (userId === notice.self_id) return;

    const config = bot.getConfig();
    // 检查群白名单
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupId)) {
      return;
    }

    // 获取新人信息并发送欢迎
    bot.callApiAsync('get_group_member_info', {
      group_id: groupId,
      user_id: userId,
    }).then((res: any) => {
      const name = res?.data?.card || res?.data?.nickname || `QQ${userId}`;
      const message = getRandomWelcome(name);
      bot.sendGroupMessage(groupId, [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: ' ' + message } },
      ]);
    }).catch(() => {
      // 获取信息失败也发个通用欢迎
      const message = getRandomWelcome(`新朋友`);
      bot.sendGroupMessage(groupId, message);
    });
  });

  console.log('[Welcome] 入群欢迎已启用');
}

// 兼容插件系统的空插件（实际逻辑在 listener 中）
export const welcomePlugin: Plugin = {
  name: 'welcome',
  description: '新成员入群欢迎',
  handler: () => false,
};
