import { Bot } from '../bot';
import { NoticeEvent } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';

/**
 * 戳一戳回应插件
 * 有人戳bot时回应一句话
 */

const pokeReplies = [
  '不是哥们 有事说事',
  '可以的 这波戳一戳有点东西',
  '你先别急 我看到了',
  '这波 timing 戳得很怪',
  '别急着开香槟 先说事',
  '这下真绷不住了',
  '我晕了 你这戳得像闪光弹',
  '行 我在 直接问',
  '这波有说法 但别一直戳',
];

function shortKnowledgeReply(): string {
  const queries = ['不是哥们', '可以的', '这波', '先别急', '我晕了'];
  for (let i = 0; i < queries.length; i++) {
    const query = queries[Math.floor(Math.random() * queries.length)];
    const line = getRandomKnowledgeLine('quote', query);
    if (line && line.length <= 32 && !line.includes('{gift}') && !line.includes('模板')) {
      return line.replace(/[。.!！]+$/, '');
    }
  }
  return '';
}

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

    const reply = shortKnowledgeReply() || pokeReplies[Math.floor(Math.random() * pokeReplies.length)];
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
