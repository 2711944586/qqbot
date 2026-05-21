import { Plugin } from '../types';

/**
 * 复读机插件 - 检测群友连续发相同消息时跟着复读
 * 这是一个非常"真人"的行为——当群里有人开始复读，真人也会跟着复读
 */

interface RepeatState {
  lastMessage: string;
  count: number;
  hasRepeated: boolean;
}

const groupRepeatState: Map<number, RepeatState> = new Map();

export const repeaterPlugin: Plugin = {
  name: 'repeater',
  description: '复读机 - 群友复读时跟着复读',

  handler: (ctx) => {
    // 只处理纯文本非命令消息
    if (ctx.command) return false;
    if (!ctx.rawText || ctx.rawText.length > 50) return false;
    // 忽略太短的（单字/表情之类的不复读）
    if (ctx.rawText.length < 2) return false;

    const groupId = ctx.event.group_id;
    const state = groupRepeatState.get(groupId);

    if (!state || state.lastMessage !== ctx.rawText) {
      // 新消息或不同消息，重置状态
      groupRepeatState.set(groupId, {
        lastMessage: ctx.rawText,
        count: 1,
        hasRepeated: false,
      });
      return false;
    }

    // 相同消息，计数+1
    state.count++;

    // 3人复读后，bot跟着复读一次（只复读一次）
    if (state.count >= 3 && !state.hasRepeated) {
      state.hasRepeated = true;
      ctx.reply(ctx.rawText);
      return true;
    }

    return false;
  },
};
