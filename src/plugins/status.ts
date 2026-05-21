import { Plugin } from '../types';

const startTime = Date.now();

export const statusPlugin: Plugin = {
  name: 'status',
  description: '查看机器人运行状态',
  handler: (ctx) => {
    if (ctx.command === 'status') {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;

      const memUsage = process.memoryUsage();
      const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
      const config = ctx.bot.getConfig();

      const statusText = [
        '🤖 运行状态',
        '',
        `⏱ 运行: ${hours}h ${minutes}m ${seconds}s`,
        `💾 内存: ${memMB} MB`,
        `🎭 当前预设: ${config.ai?.active_preset || '无'}`,
        `📦 Node ${process.version}`,
      ].join('\n');

      ctx.reply(statusText);
      return true;
    }
    return false;
  },
};
