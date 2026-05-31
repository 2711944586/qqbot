import { Plugin } from '../types';
import { detectFuzzyCommand } from './fuzzy-command';

export const timePlugin: Plugin = {
  name: 'time',
  description: '查看当前时间',
  handler: (ctx) => {
    // 中文模糊：现在几点 / 几号 / 今天星期几
    const fuzzy = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());
    if (ctx.command === 'time' || ctx.command === '时间' || fuzzy === 'time') {
      const now = new Date();
      const timeStr = now.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
      ctx.reply(`🕐 ${timeStr} 星期${weekDays[now.getDay()]}`);
      return true;
    }
    return false;
  },
};
