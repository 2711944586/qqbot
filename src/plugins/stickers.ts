import { AIConfig, MessageSegment, Plugin, PluginContext } from '../types';
import { listLocalStickers, parseStickerMarkers, getAvailableFaceHints } from './sticker-pack';

/**
 * 表情 / 贴纸命令
 *
 * /stickers 或 /表情 - 查可用表情列表
 * /sticker <名字> 或 /表情包 <名字> - 直接发本地贴纸
 * /face <名字或id> - 直接发 QQ 经典表情
 */

interface AutoStickerRule {
  id: string;
  label: string;
  pattern: RegExp;
  markers: string[];
}

interface StickerTrace {
  timestamp: number;
  chatId: number | string;
  userId: number;
  action: 'sent' | 'throttled' | 'skipped' | 'command' | 'marker';
  reason: string;
  rule?: string;
}

const autoRules: AutoStickerRule[] = [
  { id: 'baigei', label: '白给', pattern: /(?:白给|纯送|送了|送掉|空枪|马枪|下饭|没绷住)/i, markers: ['[sticker:白给]', '[白给]', '[打脸]'] },
  { id: 'champagne', label: '开香槟', pattern: /(?:开香槟|香槟|提前庆祝|已经开了|开了开了)/i, markers: ['[sticker:开香槟]', '[开香槟]', '[啤酒]'] },
  { id: 'save', label: '保枪', pattern: /(?:保枪|保了|save|saving|别打了保|经济保一下)/i, markers: ['[sticker:保枪]', '[保枪]', '[酷]'] },
  { id: 'boss', label: '老板大气', pattern: /(?:老板大气|谢谢老板|感谢老板|老板糊涂|上舰|送礼|礼物走一走)/i, markers: ['[sticker:老板大气]', '[老板大气]', '[钞票]', '[强]'] },
  { id: 'laugh', label: '绷不住', pattern: /(?:绷不住|笑死|哈哈哈|乐了|节目效果|太有节目)/i, markers: ['[sticker:绷不住]', '[绷不住]', '[笑哭]'] },
  { id: 'absurd', label: '离谱', pattern: /(?:离谱|这也行|啊这|抽象|看不懂|什么东西)/i, markers: ['[sticker:离谱]', '[离谱]', '[疑问]'] },
  { id: 'look', label: '先看', pattern: /(?:先看|别急|等一下|再看看|看一眼|让我看看)/i, markers: ['[sticker:先看]', '[先看]', '[思考]'] },
  { id: 'tilt', label: '急了', pattern: /(?:急了|上头|红温|压力来了|汗流浃背)/i, markers: ['[sticker:急了]', '[急了]', '[流汗]'] },
];

const groupCooldownUntil = new Map<string, number>();
const ruleCooldownUntil = new Map<string, number>();
let totalCommands = 0;
let markerReplies = 0;
let autoReplies = 0;
let throttledAutoReplies = 0;
let skippedAutoReplies = 0;
let lastTrace: StickerTrace | null = null;

function now(): number {
  return Date.now();
}

function rememberTrace(trace: StickerTrace): void {
  lastTrace = trace;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function isMarkerOnlyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;
  const marker = String.raw`\[(?:face|表情|emoji|qq)[:：]\d{1,4}\]|\[sticker[:：]\s*[\w.-]+\]|\[(?:[\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]`;
  return new RegExp(`^(?:\\s*(?:${marker})){1,3}\\s*$`, 'i').test(trimmed);
}

function hasVisualSegment(segments: MessageSegment[] | null): segments is MessageSegment[] {
  return !!segments && segments.some((seg) => seg.type === 'face' || seg.type === 'image');
}

function findAutoRule(text: string): AutoStickerRule | null {
  const compact = compactText(text);
  if (!compact || compact.length < 2) return null;
  if (/^\/|^\[CQ:/i.test(text.trim())) return null;
  if (/^(?:6+|哈+|草+|。+|！+|!+|\?+|？+)$/.test(compact)) return null;
  return autoRules.find((rule) => rule.pattern.test(text)) || null;
}

function markerSegmentsForRule(rule: AutoStickerRule): MessageSegment[] | null {
  for (const marker of rule.markers) {
    const segments = parseStickerMarkers(marker);
    if (hasVisualSegment(segments)) return segments;
  }
  return null;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '无';
  return new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function maybeAutoReply(ctx: PluginContext, ai: AIConfig): boolean {
  if (ctx.isPrivate || ctx.command || ctx.isAtBot || ctx.isReplyToBot) return false;
  if (ai.sticker_auto_reply_enabled === false) {
    skippedAutoReplies++;
    rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'skipped', reason: 'disabled' });
    return false;
  }

  const rule = findAutoRule(ctx.rawText);
  if (!rule) return false;

  const probability = Math.max(0, Math.min(ai.sticker_auto_reply_probability ?? 0.18, 1));
  if (probability <= 0 || Math.random() > probability) {
    skippedAutoReplies++;
    rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'skipped', reason: 'probability', rule: rule.id });
    return false;
  }

  const current = now();
  const chatKey = `${ctx.chatType}:${ctx.chatId}`;
  const groupReadyAt = groupCooldownUntil.get(chatKey) || 0;
  if (groupReadyAt > current) {
    throttledAutoReplies++;
    rememberTrace({ timestamp: current, chatId: ctx.chatId, userId: ctx.event.user_id, action: 'throttled', reason: `group ${Math.ceil((groupReadyAt - current) / 1000)}s`, rule: rule.id });
    return false;
  }

  const ruleKey = `${chatKey}:${rule.id}`;
  const ruleReadyAt = ruleCooldownUntil.get(ruleKey) || 0;
  if (ruleReadyAt > current) {
    throttledAutoReplies++;
    rememberTrace({ timestamp: current, chatId: ctx.chatId, userId: ctx.event.user_id, action: 'throttled', reason: `keyword ${Math.ceil((ruleReadyAt - current) / 1000)}s`, rule: rule.id });
    return false;
  }

  const segments = markerSegmentsForRule(rule);
  if (!segments) {
    skippedAutoReplies++;
    rememberTrace({ timestamp: current, chatId: ctx.chatId, userId: ctx.event.user_id, action: 'skipped', reason: 'no sticker segment', rule: rule.id });
    return false;
  }

  const groupCooldownMs = Math.max(0, ai.sticker_auto_group_cooldown_seconds ?? 45) * 1000;
  const keywordCooldownMs = Math.max(0, ai.sticker_auto_keyword_cooldown_seconds ?? 180) * 1000;
  groupCooldownUntil.set(chatKey, current + groupCooldownMs);
  ruleCooldownUntil.set(ruleKey, current + keywordCooldownMs);
  autoReplies++;
  rememberTrace({ timestamp: current, chatId: ctx.chatId, userId: ctx.event.user_id, action: 'sent', reason: 'auto keyword', rule: rule.id });
  ctx.reply(segments);
  return true;
}

export function getStickerStats(): {
  totalCommands: number;
  markerReplies: number;
  autoReplies: number;
  throttledAutoReplies: number;
  skippedAutoReplies: number;
  rules: number;
  groupCooldowns: number;
  keywordCooldowns: number;
  localStickers: number;
  lastTrace: StickerTrace | null;
} {
  const current = now();
  for (const [key, value] of groupCooldownUntil.entries()) {
    if (value <= current) groupCooldownUntil.delete(key);
  }
  for (const [key, value] of ruleCooldownUntil.entries()) {
    if (value <= current) ruleCooldownUntil.delete(key);
  }
  return {
    totalCommands,
    markerReplies,
    autoReplies,
    throttledAutoReplies,
    skippedAutoReplies,
    rules: autoRules.length,
    groupCooldowns: groupCooldownUntil.size,
    keywordCooldowns: ruleCooldownUntil.size,
    localStickers: listLocalStickers().length,
    lastTrace,
  };
}

export function formatStickerStatus(ai?: AIConfig): string {
  const stats = getStickerStats();
  const lines = [
    '🎭 贴纸状态',
    `自动贴纸: ${ai?.sticker_auto_reply_enabled === false ? 'off' : 'on'} 概率${ai?.sticker_auto_reply_probability ?? 0.18} 群冷却${ai?.sticker_auto_group_cooldown_seconds ?? 45}s 关键词冷却${ai?.sticker_auto_keyword_cooldown_seconds ?? 180}s`,
    `规则: ${stats.rules}条 本地贴纸${stats.localStickers}个 冷却中 群${stats.groupCooldowns}/关键词${stats.keywordCooldowns}`,
    `命令${stats.totalCommands} 标签${stats.markerReplies} 自动${stats.autoReplies} 节流${stats.throttledAutoReplies} 跳过${stats.skippedAutoReplies}`,
    `关键词: ${autoRules.map((rule) => rule.label).join(' / ')}`,
    `最近: ${stats.lastTrace ? `${formatTime(stats.lastTrace.timestamp)} ${stats.lastTrace.action}/${stats.lastTrace.reason}${stats.lastTrace.rule ? `/${stats.lastTrace.rule}` : ''}` : '无'}`,
  ];
  return lines.join('\n');
}

export const stickersPlugin: Plugin = {
  name: 'stickers',
  description: '表情 / 贴纸命令',
  handler: (ctx) => {
    const ai = ctx.bot.getConfig().ai;

    if (!ctx.command && isMarkerOnlyText(ctx.rawText)) {
      const segments = parseStickerMarkers(ctx.rawText.trim());
      if (hasVisualSegment(segments)) {
        markerReplies++;
        rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'marker', reason: 'explicit marker' });
        ctx.reply(segments);
        return true;
      }
    }

    if (!ctx.command && maybeAutoReply(ctx, ai)) return true;

    if (ctx.command === 'stickers' || ctx.command === '表情' || ctx.command === '表情列表') {
      totalCommands++;
      const sub = (ctx.args[0] || '').toLowerCase();
      if (sub === 'status' || ctx.args[0] === '状态') {
        ctx.reply(formatStickerStatus(ai));
        rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'command', reason: 'status' });
        return true;
      }
      if (sub === 'keywords' || sub === 'rules' || ctx.args[0] === '关键词') {
        ctx.reply([
          '🎯 自动贴纸关键词',
          ...autoRules.map((rule) => `${rule.label}: ${rule.pattern.source}`),
          '',
          '命中后优先找 stickers/ 同名图片，没有就发 QQ face 兜底。',
        ].join('\n'));
        rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'command', reason: 'keywords' });
        return true;
      }

      const { popular, stickers } = getAvailableFaceHints();
      const lines = [
        '🎭 可用表情和贴纸',
        '',
        'QQ 经典表情（直接发名字）:',
        '  ' + popular.slice(0, 16).map((n) => `[${n}]`).join(' '),
        '  ' + popular.slice(16).map((n) => `[${n}]`).join(' '),
      ];
      if (stickers.length > 0) {
        lines.push('', '本地贴纸（[sticker:名字] 或 [名字]）:');
        // 每行 5 个
        for (let i = 0; i < stickers.length; i += 5) {
          lines.push('  ' + stickers.slice(i, i + 5).join('  '));
        }
      } else {
        lines.push('', '本地贴纸: 无（在 stickers/ 目录下放 gif/png 即可启用）');
      }
      lines.push('');
      lines.push('用法:');
      lines.push('  /face <名字或id>    发 QQ 经典表情');
      lines.push('  /sticker <名字>     发本地贴纸（如果有）');
      lines.push('  /stickers status    看自动贴纸命中和节流');
      lines.push('  /stickers keywords  看自动贴纸关键词');
      lines.push('  对话中直接写 [呲牙] [笑哭] [666]，bot 自动转表情');
      lines.push('  普通群聊说“白给/开香槟/保枪/老板大气”等，会低频自动接一个贴纸');
      ctx.reply(lines.join('\n'));
      rememberTrace({ timestamp: now(), chatId: ctx.chatId, userId: ctx.event.user_id, action: 'command', reason: 'list' });
      return true;
    }

    if (ctx.command === 'face') {
      totalCommands++;
      const arg = ctx.args.join(' ').trim();
      if (!arg) {
        ctx.reply('用法: /face <名字或id>\n例: /face 呲牙  或  /face 178');
        return true;
      }
      const segments = parseStickerMarkers(`[${arg}]`);
      if (segments && segments.some((s) => s.type === 'face')) {
        ctx.reply(segments);
      } else {
        ctx.reply(`找不到表情「${arg}」，跑 /stickers 看可用列表`);
      }
      return true;
    }

    if (ctx.command === 'sticker' || ctx.command === '表情包') {
      totalCommands++;
      const arg = ctx.args.join(' ').trim();
      if (!arg) {
        const local = listLocalStickers();
        ctx.reply(local.length > 0
          ? `用法: /sticker <名字>\n本地贴纸: ${local.slice(0, 20).join(', ')}${local.length > 20 ? '...' : ''}`
          : '本地贴纸目录为空，把 gif/png 放在 stickers/ 即可');
        return true;
      }
      const segments = parseStickerMarkers(`[sticker:${arg}]`) || parseStickerMarkers(`[${arg}]`);
      if (segments) {
        ctx.reply(segments);
      } else {
        ctx.reply(`找不到贴纸「${arg}」`);
      }
      return true;
    }

    return false;
  },
};

export const __test = {
  autoRules,
  findAutoRule,
  markerSegmentsForRule,
  formatStickerStatus,
  resetForTests: () => {
    groupCooldownUntil.clear();
    ruleCooldownUntil.clear();
    totalCommands = 0;
    markerReplies = 0;
    autoReplies = 0;
    throttledAutoReplies = 0;
    skippedAutoReplies = 0;
    lastTrace = null;
  },
};
