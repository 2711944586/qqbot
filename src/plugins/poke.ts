import { Bot } from '../bot';
import { NoticeEvent } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';

/**
 * 戳一戳回应插件
 * 玩机器直播间风格的回应——基于真实直播切片语态
 */

const pokeReplyGroups = [
  // 弹幕互动模板
  [
    '弹幕急了？说话',
    '在 你直接打字',
    '别戳 戳出茧子了',
    '你这戳得跟狙击手开镜似的',
    '我又不是没看到 你慢慢说',
    '到底想问啥 别杵着',
  ],
  // 直播解说式
  [
    '哥们这波是在干啥',
    '不是 你戳一下我就要回应？这合理吗',
    '这下默认又来了',
    '哎你别戳了 我看着呢看着呢',
    '收到 这个戳的位置很关键',
    '行行行 我来了 你说',
  ],
  // 嘴硬怼回去
  [
    '差不多得了 戳上瘾了',
    '你要不直接打字',
    '诶你这下戳的属于是没必要',
    '弹幕在哪里 戳一下你也不亏',
    '老板别戳了 你直接刷个礼物多好',
    '这一下含金量够了 你说话',
  ],
  // 装无奈式
  [
    '又来 又来',
    '我直接好家伙',
    '行 这波我接住了',
    '老哥稳 然后呢',
    '你怎么这都能戳出花来',
    '说事 别整虚的',
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
    if (notice.notice_type !== 'notify' || notice.sub_type !== 'poke') return;

    const targetId = notice.target_id;
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
    const userId = notice.user_id;
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
