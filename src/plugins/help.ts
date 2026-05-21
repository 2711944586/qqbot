import { Plugin } from '../types';

export const helpPlugin: Plugin = {
  name: 'help',
  description: '显示帮助信息',
  handler: (ctx) => {
    if (ctx.command === 'help') {
      const helpText = [
        '玩机器 命令列表',
        '',
        '对话:',
        '  /ai <内容> - 直接对话',
        '  /voice <内容> - 语音回复',
        '  /tts <内容> - 语音回复',
        '  @我 <内容> - @触发',
        '  /reset - 清除记忆',
        '  /presets - 预设列表',
        '  /preset <名> - 切换人格',
        '',
        '趣味:',
        '  /roll [N|NdM] - 骰子',
        '  /luck - 运势',
        '  /jrrp - 今日人品',
        '  /choose A,B,C - 帮选',
        '',
        '工具:',
        '  /ping - 在线',
        '  /status - 状态',
        '  /time - 时间',
        '  /stats - 群统计',
        '',
        '管理(仅管理员):',
        '  /reload /ban /unban /kick /title',
        '',
        '其他: 戳一戳我试试 | 复读3次我会跟',
      ].join('\n');

      ctx.reply(helpText);
      return true;
    }
    return false;
  },
};
