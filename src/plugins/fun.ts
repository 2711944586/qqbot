import { MessageSegment, Plugin } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';

/** 随机选择 */
function randomPick(items: string[]): string {
  return items[Math.floor(Math.random() * items.length)];
}

function styleLine(): string {
  return getRandomKnowledgeLine('style') || randomPick([
    '不是哥们 这波有说法',
    '可以的 有点东西',
    '我晕了 这也能开出来',
    '先别急 看结果',
  ]);
}

interface CSPlayer {
  nick: string;
  name: string;
  team: string;
  role: string;
  note: string;
  image: string;
  imageSource: 'liquipedia' | 'wikimedia';
  aliases?: string[];
  tags?: string[];
}

const csPlayers: CSPlayer[] = [
  { nick: 'ZywOo', name: 'Mathieu Herbaut', team: 'Vitality', role: 'AWPer / 核心大哥', note: '今天就按这个纪律打，枪硬但别急着开香槟。', image: 'https://liquipedia.net/commons/images/2/2b/ZywOo_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia', aliases: ['载物'] },
  { nick: 's1mple', name: 'Oleksandr Kostyliev', team: 'NAVI / Falcons 语境', role: 'AWPer / 巨星位', note: '手感上来就是不讲道理，但别学他每一波都想当主角。', image: 'https://liquipedia.net/commons/images/d/d8/S1mple_at_IEM_Krak%C3%B3w_2026.jpg', imageSource: 'liquipedia', aliases: ['森破'] },
  { nick: 'donk', name: 'Danil Kryshkovets', team: 'Team Spirit', role: 'Rifler / Entry', note: '这签攻击性拉满，见人就想撕口子，但补枪也得跟上。', image: 'https://liquipedia.net/commons/images/a/a5/Donk_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'sh1ro', name: 'Dmitriy Sokolov', team: 'Team Spirit', role: 'AWPer', note: '别急，架住关键枪，今天靠纪律赢回合。', image: 'https://liquipedia.net/commons/images/4/4c/Sh1ro_at_BLAST_Open_Spring_2025.jpg', imageSource: 'liquipedia' },
  { nick: 'ropz', name: 'Robin Kool', team: 'FaZe / Vitality 语境', role: 'Lurker / Rifler', note: '今天你得学会晚点出手，timing 到了再收。', image: 'https://liquipedia.net/commons/images/f/f4/Ropz_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'dev1ce', name: 'Nicolai Reedtz', team: 'Astralis 语境', role: 'AWPer', note: '老派纪律签，别花，架好枪就有人送上门。', image: 'https://liquipedia.net/commons/images/0/05/Dev1ce_at_Roman_Imperium_Cup_V.jpg', imageSource: 'liquipedia', aliases: ['device'] },
  { nick: 'Aleksib', name: 'Aleksi Virolainen', team: 'NAVI', role: 'IGL', note: '今天别光想杀人，先把队友摆明白，默认别散。', image: 'https://liquipedia.net/commons/images/2/26/Aleksib_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'b1t', name: 'Valerii Vakhovskyi', team: 'NAVI', role: 'Rifler', note: '定位要干净，少说话多补枪，这签挺稳。', image: 'https://liquipedia.net/commons/images/2/2e/B1t_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'w0nderful', name: 'Ihor Zhdanov', team: 'NAVI', role: 'AWPer', note: '狙别乱换位置，今天拼的是稳定，不是剪辑。', image: 'https://liquipedia.net/commons/images/9/9e/W0nderful_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'EliGE', name: 'Jonathan Jablonowski', team: 'Complexity / Liquid 语境', role: 'Rifler', note: '今天正面要硬一点，但别把队友补枪距离拉没。', image: 'https://liquipedia.net/commons/images/e/e3/EliGE_at_SL_Budapest_Major_2025.jpg', imageSource: 'liquipedia' },
  { nick: 'flameZ', name: 'Shahar Shushan', team: 'Vitality', role: 'Entry / Rifler', note: '第一身位有说法，但别每回合都把自己当闪光弹。', image: 'https://liquipedia.net/commons/images/2/29/FlameZ_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'magixx', name: 'Boris Vorobyev', team: 'Team Spirit', role: 'Support / Rifler', note: '今天干脏活，别嫌镜头少，赢回合才是真的。', image: 'https://liquipedia.net/commons/images/e/e3/Magixx_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'huNter-', name: 'Nemanja Kovac', team: 'G2 语境', role: 'Rifler', note: '老哥位，今天别急着证明自己，关键枪稳住就行。', image: 'https://liquipedia.net/commons/images/5/52/HuNter-_at_Stake_Ranked_Episode_1.jpg', imageSource: 'liquipedia', aliases: ['hunter'] },
  { nick: 'malbsMd', name: 'Mario Samayoa', team: 'G2', role: 'Rifler', note: '这签就是敢打，问题是敢打完得有人补。', image: 'https://liquipedia.net/commons/images/d/d4/MalbsMd_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'Jimpphat', name: 'Jimi Salo', team: 'MOUZ', role: 'Anchor / Rifler', note: '今天当包点门神，少犯病就是大贡献。', image: 'https://liquipedia.net/commons/images/0/0d/Jimpphat_at_PGL_Cluj-Napoca_2025.jpg', imageSource: 'liquipedia' },
  { nick: 'siuhy', name: 'Kamil Szkaradek', team: 'MOUZ', role: 'IGL', note: '指挥签，别急着拼枪，先把节奏拿回来。', image: 'https://liquipedia.net/commons/images/d/df/Siuhy_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'm0NESY', name: 'Ilya Osipov', team: 'G2 / Falcons 语境', role: 'AWPer', note: '少年狙签，能操作，但今天别把每回合都打成残局教学。', image: 'https://liquipedia.net/commons/images/e/e3/M0NESY_at_BLAST_Rivals_Spring_2025.jpg', imageSource: 'liquipedia', aliases: ['小孩'] },
  { nick: 'NiKo', name: 'Nikola Kovac', team: 'G2 / Falcons 语境', role: 'Rifler', note: '爆头线拉满，但别第一时间上头，别让好枪法救坏决策。', image: 'https://liquipedia.net/commons/images/a/a1/NiKo_at_Copenhagen_Major_2024_EU_RMR.jpg', imageSource: 'liquipedia' },
  { nick: 'karrigan', name: 'Finn Andersen', team: 'FaZe', role: 'IGL', note: '今天靠脑子赢，枪软一点没事，节奏别软。', image: 'https://upload.wikimedia.org/wikipedia/commons/4/41/Interview_karrigan_-_FaZe_(DH_Masters_Malm%C3%B6_2017)_(cropped).jpg', imageSource: 'wikimedia' },
  { nick: 'rain', name: 'Havard Nygaard', team: 'FaZe', role: 'Entry / Rifler', note: '老将签，关键回合别犹豫，拉出去把空间打出来。', image: 'https://upload.wikimedia.org/wikipedia/commons/5/54/Rain_BLAST_Backstage_2020_FaZe_Clan_(cropped).jpg', imageSource: 'wikimedia' },
  { nick: 'Twistzz', name: 'Russel Van Dulken', team: 'Liquid / FaZe 语境', role: 'Rifler', note: '准星好看签，今天别花活，干净利落就完事。', image: 'https://upload.wikimedia.org/wikipedia/commons/b/bb/Twistzz_IMG_1465_(47926460051)_(cropped).jpg', imageSource: 'wikimedia' },
  { nick: 'jL', name: 'Justinas Lekavicius', team: 'NAVI', role: 'Rifler', note: '情绪和火力都给满，但别赢一回合就开香槟。', image: 'https://liquipedia.net/commons/images/1/18/JL_at_IEM_Sydney_2023.jpg', imageSource: 'liquipedia' },
  { nick: 'Spinx', name: 'Lotan Giladi', team: 'Vitality 语境', role: 'Lurker / Rifler', note: '晚点出手，别急着露，今天靠侧翼偷回合。', image: 'https://liquipedia.net/commons/images/a/ad/Spinx_at_Copenhagen_Major_2024_EU_RMR.jpg', imageSource: 'liquipedia' },
  { nick: 'broky', name: 'Helvijs Saukants', team: 'FaZe', role: 'AWPer', note: '这签有点玄学，手感来了像会魔法，没来就先保枪。', image: 'https://liquipedia.net/commons/images/1/16/Broky_at_IEM_Katowice_2024.jpg', imageSource: 'liquipedia' },
  { nick: 'frozen', name: 'David Cernansky', team: 'FaZe', role: 'Rifler', note: '稳定输出签，今天别硬装主角，位置打舒服就有了。', image: 'https://liquipedia.net/commons/images/4/43/Frozen_at_Copenhagen_Major_2024_EU_RMR.jpg', imageSource: 'liquipedia' },
  { nick: 'apEX', name: 'Dan Madesclaire', team: 'Vitality', role: 'IGL', note: '情绪和指挥一起拉满，今天别光吼，暂停后得有东西。', image: 'https://liquipedia.net/commons/images/b/b7/ApEX_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'mezii', name: 'William Merriman', team: 'Vitality 语境', role: 'Rifler / Support', note: '团队签，数据不一定好看，但补位和信息要打明白。', image: 'https://liquipedia.net/commons/images/c/ca/Mezii_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'KSCERATO', name: 'Kaike Cerato', team: 'FURIA', role: 'Rifler', note: '巴西步枪签，今天正面得硬，但别把节奏打散。', image: 'https://liquipedia.net/commons/images/e/ef/KSCERATO_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'yuurih', name: 'Yuri Santos', team: 'FURIA', role: 'Rifler', note: '稳定补枪签，别急着当主角，把回合收干净就赢。', image: 'https://liquipedia.net/commons/images/1/17/Yuurih_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'MAJ3R', name: 'Engin Kupeli', team: 'Eternal Fire', role: 'IGL', note: '老指挥签，今天靠纪律和暂停后第一回合说话。', image: 'https://liquipedia.net/commons/images/b/b5/MAJ3R_at_IEM_Krakow_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'tabseN', name: 'Johannes Wodarz', team: 'BIG', role: 'Rifler / IGL', note: '德国老大哥签，枪和脑子都得顶一下，别只当工具人。', image: 'https://liquipedia.net/commons/images/5/5e/TabseN_at_CCT_Season_3_Global_Finals.jpg', imageSource: 'liquipedia' },
  { nick: 'electroNic', name: 'Denis Sharipov', team: 'Virtus.pro / NAVI 语境', role: 'Rifler', note: '老步枪签，今天别急，关键中期枪位要拿住。', image: 'https://liquipedia.net/commons/images/b/b3/ElectroNic_at_IEM_Krakow_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'Perfecto', name: 'Ilya Zalutskiy', team: 'Virtus.pro / NAVI 语境', role: 'Support / Anchor', note: '脏活累活签，别嫌镜头少，包点站住就是价值。', image: 'https://liquipedia.net/commons/images/f/f5/Perfecto_oct-2025_playerphoto.png', imageSource: 'liquipedia' },
  { nick: 'NAF', name: 'Keith Markovic', team: 'Liquid', role: 'Rifler / Lurker', note: '冷面侧翼签，今天别急着露，残局慢慢切。', image: 'https://liquipedia.net/commons/images/6/62/NAF_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'cadiaN', name: 'Casper Moller', team: 'Heroic / Liquid 语境', role: 'AWPer / IGL', note: '情绪指挥签，今天可以吼，但回合计划得先到位。', image: 'https://liquipedia.net/commons/images/5/55/CadiaN_at_Roman_Imperium_Cup_VII.jpg', imageSource: 'liquipedia' },
  { nick: 'kennyS', name: 'Kenny Schrub', team: '传奇选手', role: 'AWPer', note: '经典狙签，今天允许你想操作，但别每枪都当集锦。', image: 'https://liquipedia.net/commons/images/0/0e/KennyS_at_BLAST_Paris_Major_2023_EU_RMR.jpeg', imageSource: 'liquipedia' },
  { nick: 'GeT_RiGhT', name: 'Christopher Alesund', team: '传奇选手', role: 'Lurker / Rifler', note: '老派侧翼签，别急，等对面一回头故事就开始了。', image: 'https://liquipedia.net/commons/images/4/4b/GeT_RiGhT_%40_PGL_Major_Stockholm_2021.jpg', imageSource: 'liquipedia' },
  { nick: 'f0rest', name: 'Patrik Lindberg', team: '传奇选手', role: 'Rifler', note: '老枪男签，今天少花活，纯度拉满就行。', image: 'https://liquipedia.net/commons/images/5/5c/F0rest_at_IEM_Dallas_2023.jpg', imageSource: 'liquipedia' },
  { nick: 'coldzera', name: 'Marcelo David', team: '传奇选手 / RED Canids 语境', role: 'Rifler', note: '名场面签，别只想着飞起来，先把补枪站好。', image: 'https://liquipedia.net/commons/images/0/08/Coldzera_at_Copenhagen_Major_2024_AME_RMR.jpg', imageSource: 'liquipedia' },
  { nick: 'olofmeister', name: 'Olof Kajbjer', team: '传奇选手', role: 'Rifler', note: '老传奇签，今天别急着证明，关键回合稳住就有味。', image: 'https://liquipedia.net/commons/images/f/fe/Olofmeister_%40_PGL_Major_Stockholm_2021.jpg', imageSource: 'liquipedia' },
  { nick: 'GuardiaN', name: 'Ladislav Kovacs', team: '传奇选手', role: 'AWPer', note: '老狙签，架点纪律拿出来，别第一枪空了人也没了。', image: 'https://liquipedia.net/commons/images/9/9b/GuardiaN_%40_EPICENTER_2019.jpg', imageSource: 'liquipedia' },
  { nick: 'Snax', name: 'Janusz Pogorzelski', team: 'G2 / 传奇语境', role: 'IGL / Rifler', note: '老油条签，今天靠经验偷回合，别跟年轻人拼嗓门。', image: 'https://liquipedia.net/commons/images/3/37/Snax_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'TaZ', name: 'Wiktor Wojtas', team: '教练 / 传奇选手', role: 'Coach / Rifler', note: '教练签，今天别急着冲，先暂停一下把队友脑子叫回来。', image: 'https://liquipedia.net/commons/images/9/9c/TaZ_at_BLAST_Open_Spring_2025.jpg', imageSource: 'liquipedia' },
  { nick: 'NEO', name: 'Filip Kubski', team: 'FaZe 教练 / 传奇选手', role: 'Coach / Rifler', note: '老传奇签，今天不拼花，拼的是把复杂局面打简单。', image: 'https://liquipedia.net/commons/images/e/e4/NEO_at_PGL_Cluj-Napoca_2025.jpg', imageSource: 'liquipedia' },
  { nick: 'dupreeh', name: 'Peter Rasmussen', team: '传奇选手', role: 'Rifler', note: '冠军经验签，今天别浪，知道什么时候不打也是本事。', image: 'https://liquipedia.net/commons/images/4/4f/Dupreeh_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'Magisk', name: 'Emil Reif', team: 'Astralis / Falcons 语境', role: 'Rifler', note: '体系步枪签，枪要硬，位置也得干净。', image: 'https://liquipedia.net/commons/images/8/8f/Magisk_at_ESL_Pro_League_S22.jpg', imageSource: 'liquipedia' },
  { nick: 'gla1ve', name: 'Lukas Rossander', team: 'ENCE / Astralis 语境', role: 'IGL', note: '战术签，今天别只拼枪，暂停后第一波要有设计。', image: 'https://liquipedia.net/commons/images/a/a5/Gla1ve_at_Roman_Imperium_Cup_V.jpg', imageSource: 'liquipedia' },
  { nick: 'XANTARES', name: 'Can Dortkardes', team: 'Eternal Fire', role: 'Rifler', note: '爆头线签，正面拉出来要有东西，但别把队友补枪甩没。', image: 'https://liquipedia.net/commons/images/d/d5/XANTARES_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'woxic', name: 'Ozgur Eker', team: 'Eternal Fire', role: 'AWPer', note: '土耳其狙签，今天先架住关键枪，别急着换位置。', image: 'https://liquipedia.net/commons/images/4/49/Woxic_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
];

function todayKey(): string {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function dailySeedFor(userId: number, groupId: number = 0): number {
  return Math.abs(hashCode(`${todayKey()}_csplayer_${groupId}_${userId}`));
}

function dailyPlayerFor(userId: number, groupId: number = 0): CSPlayer {
  const seed = dailySeedFor(userId, groupId);
  return csPlayers[seed % csPlayers.length];
}

function dailyPlayerScore(userId: number, groupId: number = 0): number {
  return (dailySeedFor(userId, groupId) % 100) + 1;
}

function scoreLine(score: number): string {
  if (score >= 95) return '签位：神中神';
  if (score >= 80) return '签位：很能打';
  if (score >= 60) return '签位：有说法';
  if (score >= 35) return '签位：先稳一手';
  return '签位：今天别硬拉';
}

function normalizeDrawText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[，。！？!?、,.]/g, '');
}

function isCsPlayerDrawRequest(command: string | null, rawText: string): boolean {
  if (['csplayer', 'playerday', 'todayplayer', '今日选手', '每日选手', '抽选手'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  if (['今日选手', '每日选手', '今日cs选手', '每日cs选手', '抽选手', '抽个选手', '抽个cs选手', '今天抽谁'].includes(text)) return true;
  const hasDrawWord = /(抽|今日|每日|今天|本日|来个|给我来个)/.test(text);
  const hasPlayerWord = /(cs选手|cs2选手|职业哥|职业选手|选手签|今日哥们|每日哥们)/.test(text);
  return hasDrawWord && hasPlayerWord;
}

function buildCsPlayerMessage(userId: number, player: CSPlayer, score?: number): MessageSegment[] {
  const text = [
    ` 今日CS选手：${player.nick}`,
    `昵称：${player.nick}`,
    `队伍语境：${player.team}`,
    `定位：${player.role}`,
    typeof score === 'number' ? `${scoreLine(score)} ${score}/100` : '',
    player.note,
  ].filter(Boolean).join('\n');
  const message: MessageSegment[] = [
    { type: 'at', data: { qq: String(userId) } },
    { type: 'text', data: { text } },
  ];
  message.push({ type: 'image', data: { file: player.image } });
  return message;
}

export const funPlugin: Plugin = {
  name: 'fun',
  description: '趣味功能 - 掷骰子、抽签、决策辅助等',

  handler: (ctx) => {
    const raw = ctx.rawText.trim();
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
        result = `${styleLine()}\n${count}d${sides} = [${rolls.join(', ')}] = ${sum}`;
      } else {
        const max = parseInt(input) || 100;
        const value = Math.floor(Math.random() * max) + 1;
        result = `${styleLine()}\n1-${max} 开出来是 ${value}`;
      }
      ctx.reply(result);
      return true;
    }

    // ===== 抽签 =====
    if (ctx.command === 'luck' || ctx.command === 'fortune') {
      const fortunes = [
        '大吉 - 今天枪法在线，timing也站你这边',
        '吉 - 运势不错，可以主动找机会',
        '中吉 - 稳一点打，别自己上头就行',
        '小吉 - 小有收获，别贪别送',
        '末吉 - 还行，但别硬起',
        '凶 - 今天宜默认控图，别第一身位白给',
        '大凶 - 不是哥们，今天真别硬拉',
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
      ctx.replyAt(`${today} 的运势:\n${fortune}`);
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
      ctx.replyAt(`别纠结了，就选「${chosen}」。${styleLine()}`);
      return true;
    }

    // ===== 随机数 (更简洁) =====
    if (ctx.command === 'rand') {
      const min = parseInt(ctx.args[0]) || 1;
      const max = parseInt(ctx.args[1]) || 100;
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      const value = Math.floor(Math.random() * (high - low + 1)) + low;
      ctx.reply(`${styleLine()}\n${low}-${high} 随到 ${value}`);
      return true;
    }

    // ===== 今日人品 =====
    if (ctx.command === 'jrrp' || ctx.command === 'rp') {
      // 基于日期+QQ号的伪随机，同一天结果固定
      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const seed = hashCode(`${today}_${ctx.event.user_id}`);
      const rp = Math.abs(seed) % 101;

      let comment: string;
      if (rp >= 90) comment = '今天真有点东西，打什么都像在架timing。';
      else if (rp >= 70) comment = '运气不错，可以主动一点。';
      else if (rp >= 50) comment = '中规中矩，默认控图等机会。';
      else if (rp >= 30) comment = '一般，少嘴硬多补枪。';
      else if (rp >= 10) comment = '有点危险，别第一时间白给。';
      else comment = '不是哥们，今天先别硬起，保枪吧。';

      ctx.replyAt(`今日人品值: ${rp}/100\n${comment}`);
      return true;
    }

    // ===== 每日CS选手 =====
    if (isCsPlayerDrawRequest(ctx.command, raw)) {
      const player = dailyPlayerFor(ctx.event.user_id, ctx.event.group_id);
      const score = dailyPlayerScore(ctx.event.user_id, ctx.event.group_id);
      ctx.reply(buildCsPlayerMessage(ctx.event.user_id, player, score));
      return true;
    }

    return false;
  },
};

export const __test = {
  csPlayers,
  dailyPlayerFor,
  dailyPlayerScore,
  isCsPlayerDrawRequest,
  buildCsPlayerMessage,
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
