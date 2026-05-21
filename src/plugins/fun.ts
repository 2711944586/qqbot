import { Plugin, MessageSegment } from '../types';

/** 随机选择 */
function randomPick(items: string[]): string {
  return items[Math.floor(Math.random() * items.length)];
}

export const funPlugin: Plugin = {
  name: 'fun',
  description: '趣味功能 - 掷骰子、抽签、决策辅助等',

  handler: (ctx) => {
    // ===== 掷骰子 =====
    if (ctx.command === 'roll' || ctx.command === 'dice') {
      const input = ctx.args[0] || '100';
      let result: string;

      // 支持 NdM 格式 (如 2d6)
      const diceMatch = input.match(/^(\d+)d(\d+)$/i);
      if (diceMatch) {
        const count = Math.min(parseInt(diceMatch[1]), 20);
        const sides = parseInt(diceMatch[2]);
        const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
        const sum = rolls.reduce((a, b) => a + b, 0);
        result = `🎲 ${count}d${sides} = [${rolls.join(', ')}] = ${sum}`;
      } else {
        const max = parseInt(input) || 100;
        const value = Math.floor(Math.random() * max) + 1;
        result = `🎲 (1-${max}): ${value}`;
      }
      ctx.reply(result);
      return true;
    }

    // ===== 抽签 =====
    if (ctx.command === 'luck' || ctx.command === 'fortune') {
      const fortunes = [
        '🌟 大吉 —— 万事顺遂，诸事皆宜',
        '✨ 吉 —— 运势不错，可以行动',
        '🍀 中吉 —— 平稳顺遂',
        '☁️ 小吉 —— 小有收获',
        '🌤 末吉 —— 还行，别太冒险',
        '🌥 凶 —— 今日宜静不宜动',
        '🌧 大凶 —— 小心为上，低调处事',
      ];
      const weights = [5, 15, 25, 25, 15, 10, 5];
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      let fortune = fortunes[0];
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) { fortune = fortunes[i]; break; }
      }

      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      ctx.replyAt(`${today} 的运势：\n${fortune}`);
      return true;
    }

    // ===== 选择困难症救星 =====
    if (ctx.command === 'choose' || ctx.command === 'pick') {
      const options = ctx.args.join(' ').split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) {
        ctx.reply('用法: /choose 选项1, 选项2, 选项3\n用逗号或顿号分隔');
        return true;
      }
      const chosen = randomPick(options);
      ctx.replyAt(`🤔 我建议你选: 「${chosen}」`);
      return true;
    }

    // ===== 随机数 (更简洁) =====
    if (ctx.command === 'rand') {
      const min = parseInt(ctx.args[0]) || 1;
      const max = parseInt(ctx.args[1]) || 100;
      const value = Math.floor(Math.random() * (max - min + 1)) + min;
      ctx.reply(`🔢 随机数 (${min}-${max}): ${value}`);
      return true;
    }

    // ===== 今日人品 =====
    if (ctx.command === 'jrrp' || ctx.command === 'rp') {
      // 基于日期+QQ号的伪随机，同一天结果固定
      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const seed = hashCode(`${today}_${ctx.event.user_id}`);
      const rp = Math.abs(seed) % 101;

      let comment: string;
      if (rp >= 90) comment = '🎊 欧皇附体！今天是幸运日~';
      else if (rp >= 70) comment = '😊 今天运气不错哦';
      else if (rp >= 50) comment = '🙂 平平淡淡也是真';
      else if (rp >= 30) comment = '😐 今天一般般吧...';
      else if (rp >= 10) comment = '😢 今天要小心一点哦';
      else comment = '💀 今天...还是躺平吧';

      ctx.replyAt(`今日人品值: ${rp}/100\n${comment}`);
      return true;
    }

    return false;
  },
};

/** 字符串哈希 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // to 32bit int
  }
  return hash;
}
