import { Plugin } from '../types';
import { isKnowledgeTopic } from './knowledge-base';

/**
 * 复读机插件 - 检测群友连续发相同消息时跟着复读
 * 这是一个非常"真人"的行为——当群里有人开始复读，真人也会跟着复读
 */

interface RepeatState {
  lastMessage: string;
  count: number;
  hasRepeated: boolean;
  updatedAt: number;
}

const groupRepeatState: Map<number, RepeatState> = new Map();
const MAX_GROUP_STATES = 500;

function pruneStatesIfNeeded(): void {
  if (groupRepeatState.size < MAX_GROUP_STATES) return;
  const sorted = [...groupRepeatState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const removeCount = Math.max(1, groupRepeatState.size - MAX_GROUP_STATES + 1);
  for (const [groupId] of sorted.slice(0, removeCount)) {
    groupRepeatState.delete(groupId);
  }
}

function isUnsafeRepeatText(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (/^[\d.。,\s，、]+$/.test(normalized)) return true;
  if (/^[哈啊嗯哦额呃草艹wW6]+$/.test(normalized) && normalized.length <= 8) return true;
  if (/^[^\u4e00-\u9fa5A-Za-z0-9]+$/.test(normalized)) return true;
  return false;
}

function includesAnyKeyword(text: string, keywords: string[] = []): boolean {
  if (!text || keywords.length === 0) return false;
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => keyword && lowerText.includes(keyword.toLowerCase()));
}

export const repeaterPlugin: Plugin = {
  name: 'repeater',
  description: '复读机 - 群友复读时跟着复读',

  handler: (ctx) => {
    // 强触发必须让 AI 插件接，不让复读机截胡。
    if (ctx.isAtBot || ctx.isReplyToBot) return false;
    // 只处理纯文本非命令消息
    if (ctx.command) return false;
    if (!ctx.rawText || ctx.rawText.length > 50) return false;
    const ai = ctx.bot.getConfig().ai;
    if (includesAnyKeyword(ctx.rawText, [ai.active_preset, ...ai.trigger_keywords]) || isKnowledgeTopic(ctx.rawText)) return false;
    // 忽略太短的（单字/表情之类的不复读）
    if (ctx.rawText.length < 2) return false;
    if (isUnsafeRepeatText(ctx.rawText)) return false;

    const groupId = ctx.event.group_id;
    const state = groupRepeatState.get(groupId);

    if (!state || state.lastMessage !== ctx.rawText) {
      // 新消息或不同消息，重置状态
      pruneStatesIfNeeded();
      groupRepeatState.set(groupId, {
        lastMessage: ctx.rawText,
        count: 1,
        hasRepeated: false,
        updatedAt: Date.now(),
      });
      return false;
    }

    // 相同消息，计数+1
    state.count++;
    state.updatedAt = Date.now();

    // 3人复读后，bot跟着复读一次（只复读一次）
    if (state.count >= 3 && !state.hasRepeated) {
      state.hasRepeated = true;
      ctx.reply(ctx.rawText);
      return true;
    }

    return false;
  },
};
