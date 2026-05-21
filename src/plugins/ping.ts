import { Plugin } from '../types';

export const pingPlugin: Plugin = {
  name: 'ping',
  description: '在线检测',
  handler: (ctx) => {
    if (ctx.command === 'ping') {
      ctx.reply('🏓 pong!');
      return true;
    }
    return false;
  },
};
