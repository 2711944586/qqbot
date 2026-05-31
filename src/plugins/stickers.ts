import { Plugin } from '../types';
import { listLocalStickers, parseStickerMarkers, getAvailableFaceHints } from './sticker-pack';

/**
 * 表情 / 贴纸命令
 *
 * /stickers 或 /表情 - 查可用表情列表
 * /sticker <名字> 或 /表情包 <名字> - 直接发本地贴纸
 * /face <名字或id> - 直接发 QQ 经典表情
 */
export const stickersPlugin: Plugin = {
  name: 'stickers',
  description: '表情 / 贴纸命令',
  handler: (ctx) => {
    if (ctx.command === 'stickers' || ctx.command === '表情' || ctx.command === '表情列表') {
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
      lines.push('  对话中直接写 [呲牙] [笑哭] [666]，bot 自动转表情');
      ctx.reply(lines.join('\n'));
      return true;
    }

    if (ctx.command === 'face') {
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
