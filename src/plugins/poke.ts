import { Bot } from '../bot';
import { NoticeEvent } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';

/**
 * 戳一戳回应插件
 * 有人戳bot时回应一句话
 */

const pokeReplyGroups = [
  [
    '别光戳 直接上问题',
    '说事说事 我看着呢',
    '来了 你先别急',
    '在呢 但你这戳一下没有信息量',
    '别点默认了 有事发出来',
  ],
  [
    '等下 这波先看你要问啥',
    '你这一下给我打断了',
    '先停一手 弹幕别急',
    '可以可以 收到你的戳了',
    '别催 我正在看',
  ],
  [
    '这波什么战术 戳闪吗',
    '你这戳得像假打B真打A',
    '信息给一下 别只给脚步',
    '道具呢 队友呢 就硬戳',
    '这下默认没控明白',
  ],
  [
    '让人不禁想问 你到底要干嘛',
    '真的可以吗 就戳一下',
    '#查询这波戳一戳含金量',
    '#查询默认控图进度',
    '#查询弹幕急躁程度',
  ],
];

function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function fallbackPokeReply(): string {
  return randomPick(randomPick(pokeReplyGroups));
}

function isGoodPokeLine(line: string): boolean {
  return (
    line.length >= 4 &&
    line.length <= 34 &&
    !line.includes('{gift}') &&
    !/模板|核验|待核验|来源|bot|机器人|不是本人|不代表/.test(line)
  );
}

function shortKnowledgeReply(): string {
  const queries = ['戳一戳', '弹幕', '直播短句', 'CS2', '默认控图', '道具', '信息量'];
  for (let i = 0; i < queries.length; i++) {
    const query = randomPick(queries);
    const line = getRandomKnowledgeLine('quote', query);
    if (line && isGoodPokeLine(line)) {
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

    const reply = Math.random() < 0.35
      ? (shortKnowledgeReply() || fallbackPokeReply())
      : fallbackPokeReply();
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

export const __test = {
  pokeReplyGroups,
  fallbackPokeReply,
  isGoodPokeLine,
};
