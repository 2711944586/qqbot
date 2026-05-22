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
        '  /voice status - 查看语音/克隆状态',
        '  /voice test [内容] - 发送测试语音',
        '  /voice clean - 清理过期语音缓存',
        '  /tts <内容> - 语音回复',
        '  /search <关键词> - 联网搜索',
        '  @我 <内容> - @触发',
        '  /reset - 清除记忆',
        '  /presets - 预设列表',
        '  /preset <名> - 切换人格',
        '  /quote [关键词] - 查语录/口癖',
        '  /player <名字> - 查选手倾向',
        '  /team <队伍> - 查队伍倾向',
        '  /gift <礼物名> - 礼物感谢拟态模板',
        '  /kb search <关键词> - 检索知识库',
        '  /kb stats - 知识库状态',
        '  /kb refresh - 联网生成知识候选',
        '  /kb audit - 审计知识库',
        '  /kb auto on|off|run - 自动更新控制',
        '',
        '趣味:',
        '  /roll [N|NdM] - 骰子',
        '  /luck - 运势',
        '  /jrrp - 今日人品',
        '  /choose A,B,C - 帮选',
        '  /rand [min] [max] - 随机数',
        '',
        '工具:',
        '  /ping - 在线',
        '  /whoami - 查看当前bot号/群号',
        '  /status - 状态',
        '  /diag - 严格自检',
        '  /time - 时间',
        '  /stats - 群统计',
        '',
        '管理(仅管理员):',
        '  /reload /ban /unban /kick /title',
        '  /kb preview <关键词> / /kb ingest [full]',
        '  /kb list / /kb show <ID> / /kb commit <ID> / /kb drop <ID>',
        '',
        '其他: 戳一戳我试试 | 复读3次我会跟 | CS2/玩机器相关话题会主动接',
      ].join('\n');

      ctx.reply(helpText);
      return true;
    }
    return false;
  },
};
