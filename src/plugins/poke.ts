import { Bot } from '../bot';
import { NoticeEvent } from '../types';

/**
 * 戳一戳回应插件
 * 有人戳bot时回应一句话
 */

const pokeReplies = [
  '不是哥们 戳我干嘛',
  '有事说事 别在这道具试探',
  '再戳就有点抽象了',
  '我在 你先别急',
  '别闹 正在看弹幕',
  '手痒是吧',
  '这波戳一戳没有收益',
  '你这个timing戳得很怪',
  '我去登山了 别催',
];

export function registerPokeListener(bot: Bot): void {
  bot.onEvent((event) => {
    if (event.post_type !== 'notice') return;

    const notice = event as NoticeEvent;
    // 戳一戳事件
    if (notice.notice_type !== 'notify' || (notice as any).sub_type !== 'poke') return;

    const targetId = (notice as any).target_id;
    // 只有被戳的是bot自己才回应
    if (targetId !== notice.self_id) return;

    const groupId = notice.group_id;
    if (!groupId) return;

    const config = bot.getConfig();
    if (config.enabled_groups.length > 0 && !config.enabled_groups.includes(groupId)) return;
    const probability = Math.max(0, Math.min(config.ai?.poke_reply_probability ?? 1, 1));
    if (Math.random() > probability) return;

    const reply = pokeReplies[Math.floor(Math.random() * pokeReplies.length)];
    const userId = (notice as any).user_id;
    const message = userId
      ? [
        { type: 'at' as const, data: { qq: String(userId) } },
        { type: 'text' as const, data: { text: ' ' + reply } },
      ]
      : reply;
    bot.sendGroupMessage(groupId, message);
  });

  console.log('[Poke] 戳一戳回应已启用');
}
