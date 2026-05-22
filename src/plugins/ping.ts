import { Plugin } from '../types';

export const pingPlugin: Plugin = {
  name: 'ping',
  description: '在线检测',
  handler: (ctx) => {
    if (ctx.command === 'ping') {
      ctx.reply('🏓 pong!');
      return true;
    }
    if (ctx.command === 'whoami') {
      const configured = ctx.bot.getConfig().bot_qq;
      ctx.reply([
        `当前bot号: ${ctx.event.self_id}`,
        `配置bot_qq: ${configured || '未填写'}`,
        `群号: ${ctx.event.group_id}`,
        `你的QQ: ${ctx.event.user_id}`,
        `当前消息ID: ${ctx.event.message_id}`,
      ].join('\n'));
      return true;
    }
    return false;
  },
};
