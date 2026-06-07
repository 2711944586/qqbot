import { MessageSegment, Plugin } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';
import { getCacheStats, getImageDataUrl } from './image-cache';
import { webSearch } from './web-search';
import { fetchOngoingMatches, fetchTeamRanking, fetchRecentResults } from './hltv-api';
import { detectFuzzyCommand } from './fuzzy-command';
import { resolvePlayerImage, resolveTeamImage } from './liquipedia-image';
import { resolveFandomFileImage } from './fandom-image';
import { buildDailyCardImageDataUrl } from './daily-card-image';

/** 随机选择 */
function randomPick(items: string[]): string {
  return items[Math.floor(Math.random() * items.length)];
}

function styleLine(): string {
  return getRandomKnowledgeLine('style') || randomPick([
    '这波有说法',
    '可以 有点东西',
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
  style?: string;
  avoid?: string;
  image: string;
  imageSource: 'liquipedia' | 'wikimedia';
  aliases?: string[];
  tags?: string[];
}

interface DailyCard {
  key: string;
  title: string;
  name: string;
  subtitle: string;
  scoreLabel: string;
  advice: string;
  avoid: string;
  line: string;
  image?: string;
  imageLabel?: string;
  liquipediaPage?: string;
  playerImageFallback?: string;
  fandomFile?: string;
}

type DailyCardKind = 'team' | 'map' | 'weapon' | 'role' | 'loadout' | 'utility' | 'tactic' | 'clutch';
let imageDataUrlResolver: (url: string) => Promise<string | null> = getImageDataUrl;

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
  { nick: 'Jimpphat', name: 'Jimi Salo', team: 'MOUZ', role: 'Anchor / Rifler', note: '今天当包点门神，少乱动就是大贡献。', image: 'https://liquipedia.net/commons/images/0/0d/Jimpphat_at_PGL_Cluj-Napoca_2025.jpg', imageSource: 'liquipedia' },
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

const csTeams: DailyCard[] = [
  {
    key: 'vitality',
    title: '今日CS队伍',
    name: 'Vitality',
    subtitle: 'ZywOo核心体系 / 纪律和个人能力都在线',
    scoreLabel: '签位强度',
    advice: '今天思路就是稳住默认，等核心位把第一枪打开。',
    avoid: '别一赢手枪局就开香槟，强队最怕自己先松。',
    line: '这队伍签抽出来，今天至少不能怂。',
    image: 'https://liquipedia.net/commons/images/f/f3/Team_Vitality_2023_allmode.png',
    liquipediaPage: 'Team Vitality',
    fandomFile: 'BLAST_23_vita.png',
    playerImageFallback: 'ZywOo',
  },
  {
    key: 'navi',
    title: '今日CS队伍',
    name: 'NAVI',
    subtitle: '结构化默认 / 信息和纪律优先',
    scoreLabel: '签位强度',
    advice: '先把信息拿满，别急着单点爆破，靠中期调整赢。',
    avoid: '别五个人各玩各的，NAVI味一散就真难看。',
    line: '这签不一定最爆，但认真打很能折磨对面。',
    image: 'https://liquipedia.net/commons/images/3/30/Natus_Vincere_2021_allmode.png',
    liquipediaPage: 'Natus Vincere',
    fandomFile: 'BLAST_23_navi.png',
    playerImageFallback: 'Aleksib',
  },
  {
    key: 'spirit',
    title: '今日CS队伍',
    name: 'Team Spirit',
    subtitle: '年轻火力 / donk破口能力',
    scoreLabel: '签位强度',
    advice: '第一身位敢给压力，但第二时间补枪必须跟上。',
    avoid: '别把每个回合都打成个人集锦，集锦失败就是白给。',
    line: '这签火力是有的，问题是别上头。',
    image: 'https://liquipedia.net/commons/images/a/a3/Team_Spirit_2022_allmode.png',
    liquipediaPage: 'Team Spirit',
    fandomFile: 'Pgl_22_sticker_spir.png',
    playerImageFallback: 'donk',
  },
  {
    key: 'falcons',
    title: '今日CS队伍',
    name: 'Falcons',
    subtitle: '明星阵容 / 上限很高，磨合也要看',
    scoreLabel: '签位强度',
    advice: '今天别只看ID，重点看补枪距离和回合纪律。',
    avoid: '别一把没打好就审判银河战舰，CS不是PPT。',
    line: '尼尼孩孩这个语境一出来，弹幕已经有画面了。',
    image: 'https://liquipedia.net/commons/images/6/61/Team_Falcons_2022_allmode.png',
    liquipediaPage: 'Team Falcons',
    fandomFile: 'CS2_AWP_Inventory.png',
    playerImageFallback: 'm0NESY',
  },
  {
    key: 'mouz',
    title: '今日CS队伍',
    name: 'MOUZ',
    subtitle: '年轻纪律 / 包点和补枪细节',
    scoreLabel: '签位强度',
    advice: '少乱来，多补枪，打出团队交换就很舒服。',
    avoid: '别关键局突然没人敢要信息。',
    line: 'MOUZ签就是别花，稳着稳着对面就急了。',
    image: 'https://liquipedia.net/commons/images/1/11/MOUZ_2021_allmode.png',
    liquipediaPage: 'MOUZ',
    fandomFile: 'BLAST_23_mouz.png',
    playerImageFallback: 'Jimpphat',
  },
  {
    key: 'g2',
    title: '今日CS队伍',
    name: 'G2',
    subtitle: '枪男传统 / 节目效果也不少',
    scoreLabel: '签位强度',
    advice: '枪法可以解决一部分问题，但别让枪法救坏决策。',
    avoid: '别默认还没走完就开始硬拉。',
    line: '这签有节目，但节目别演到自己身上。',
    image: 'https://liquipedia.net/commons/images/9/93/G2_Esports_2020_allmode.png',
    liquipediaPage: 'G2 Esports',
    fandomFile: 'BLAST_23_g2.png',
    playerImageFallback: 'malbsMd',
  },
  {
    key: 'faze',
    title: '今日CS队伍',
    name: 'FaZe',
    subtitle: '经验和残局 / 大场面属性',
    scoreLabel: '签位强度',
    advice: '残局慢一点，别急着把优势送回去。',
    avoid: '别用经验给自己的白给找借口。',
    line: 'FaZe签就是心脏体检，别第一回合就血压拉满。',
    image: 'https://liquipedia.net/commons/images/b/bb/FaZe_Clan_2021_allmode.png',
    liquipediaPage: 'FaZe Clan',
    fandomFile: 'BLAST_23_faze.png',
    playerImageFallback: 'karrigan',
  },
  {
    key: 'liquid',
    title: '今日CS队伍',
    name: 'Liquid',
    subtitle: '北美语境 / 个人能力和节奏转换',
    scoreLabel: '签位强度',
    advice: '正面别软，中期别散，残局别急。',
    avoid: '别把优势局打成观众心理测试。',
    line: '北美味来了，今天主打一个让人不禁想问。',
    image: 'https://liquipedia.net/commons/images/5/5d/Team_Liquid_2023_allmode.png',
    liquipediaPage: 'Team Liquid',
    fandomFile: 'BLAST_23_liq.png',
    playerImageFallback: 'NAF',
  },
];

const csMaps: DailyCard[] = [
  { key: 'mirage', title: '今日CS地图', name: 'Mirage', subtitle: '默认控中 / A夹B小都是节目点', scoreLabel: '手感指数', advice: '中路先拿信息，别五个人排队送拱门。', avoid: '别烟一散就干拉，timing 不在你这。', line: '荒漠迷城一出来，天梯味已经顶满了。', fandomFile: 'De_mirage_cs2.png' },
  { key: 'inferno', title: '今日CS地图', name: 'Inferno', subtitle: '香蕉道博弈 / 道具纪律地图', scoreLabel: '手感指数', advice: '香蕉道别省道具，CT回防先等队友。', avoid: '别一个人拿着半甲硬清车位。', line: '炼狱小镇这图，急的人先白给。', fandomFile: 'Cs2_inferno_remake.png' },
  { key: 'nuke', title: '今日CS地图', name: 'Nuke', subtitle: '上下层信息 / 转点和沟通', scoreLabel: '手感指数', advice: '先把外场和铁板信息讲清楚，别让队友猜谜。', avoid: '别一听脚步就全队转点，像被遥控。', line: '核子危机要的是脑子，不是嗓门。', fandomFile: 'CS2_Nuke_A_site.png' },
  { key: 'ancient', title: '今日CS地图', name: 'Ancient', subtitle: '中路和包点压缩 / 细节吃人', scoreLabel: '手感指数', advice: '中路别白给，包点别孤岛，补枪距离拉近。', avoid: '别让对面每回合免费拿中。', line: '远古遗迹这图，信息一断人就开始原始。', fandomFile: 'De_ancient.png' },
  { key: 'anubis', title: '今日CS地图', name: 'Anubis', subtitle: '水路控制 / 回防压力', scoreLabel: '手感指数', advice: '水路信息很关键，进点后别忘了后路。', avoid: '别下包后全员看一个方向。', line: '阿努比斯打着打着就像心理学考试。', fandomFile: 'De_anubis_cs2.png' },
  { key: 'dust2', title: '今日CS地图', name: 'Dust2', subtitle: '经典枪法图 / 中门信息', scoreLabel: '手感指数', advice: '枪可以硬，但别把每回合都当单挑服。', avoid: '别中门被看穿还硬装没事。', line: 'D2这签，简单粗暴，但白给也很快。', fandomFile: 'Cs2_dust2.png' },
  { key: 'overpass', title: '今日CS地图', name: 'Overpass', subtitle: '厕所长管工地 / 信息链和回防路线', scoreLabel: '手感指数', advice: '先把厕所和工地信息讲清楚，回防别三个人挤一个口。', avoid: '别听到一点动静全队乱转，像被对面牵着走。', line: '死亡游乐园这签，信息断了就真开始坐过山车。', fandomFile: 'Overpass_CS2.png' },
];

const csWeapons: DailyCard[] = [
  { key: 'ak47', title: '今日CS武器', name: 'AK-47', subtitle: '一枪头信仰 / 但别乱泼', scoreLabel: '爆头指数', advice: '今天准星放稳，第一发别急，打完记得换位。', avoid: '别二十发全泼天上还说压枪问题。', line: 'AK签可以的，枪给你了，别自己把自己打没。', fandomFile: 'CS2_AK-47_Inventory.png' },
  { key: 'm4a1s', title: '今日CS武器', name: 'M4A1-S', subtitle: '控枪稳定 / 偷人舒服', scoreLabel: '爆头指数', advice: '多换位置，少硬扫，靠消音和节奏偷回合。', avoid: '别子弹打完才想起来退。', line: 'A1签就是细，细完别怂。', fandomFile: 'CS2_M4A1-S_Inventory.png' },
  { key: 'awp', title: '今日CS武器', name: 'AWP', subtitle: '架点纪律 / 一枪改变回合', scoreLabel: '爆头指数', advice: '第一枪要稳，空了就换位置，别站原地等审判。', avoid: '别每回合都想打集锦狙。', line: '大狙在手，责任也在手，别只要镜头不要回合。', fandomFile: 'CS2_AWP_Inventory.png' },
  { key: 'deagle', title: '今日CS武器', name: 'Desert Eagle', subtitle: '经济局希望 / 也可能是错觉', scoreLabel: '爆头指数', advice: '别急开枪，等对面进准星，一发讲道理。', avoid: '别七发全空还喊差一点。', line: '沙鹰签最会骗人，但骗成了就是名场面。', fandomFile: 'CS2_Desert_Eagle_Inventory.png' },
  { key: 'mp9', title: '今日CS武器', name: 'MP9', subtitle: '近点爆发 / 经济管理', scoreLabel: '爆头指数', advice: '打近点，吃信息，杀一个就跑，别恋战。', avoid: '别拿MP9去和AK中远距离讲道理。', line: 'MP9签就是灵活，别灵活到白给。', fandomFile: 'CS2_MP9_Inventory.png' },
  { key: 'mac10', title: '今日CS武器', name: 'MAC-10', subtitle: '冲锋和拉扯 / 第一身位工具', scoreLabel: '爆头指数', advice: '给队友拉空间，死也要换到信息和站位。', avoid: '别冲进去没人补，死得很孤独。', line: '这签主打一个不怕死，但怕没人跟。', fandomFile: 'CS2_MAC-10_Inventory.png' },
  { key: 'galil', title: '今日CS武器', name: 'Galil AR', subtitle: '穷哥们步枪 / 性价比', scoreLabel: '爆头指数', advice: '别嫌枪便宜，控好弹道一样能打出价值。', avoid: '别拿着Galil还想当ZywOo。', line: '经济一般但人不能一般，Galil也能有节目。', fandomFile: 'CS2_Galil_AR_Inventory.png' },
];

const csRoles: DailyCard[] = [
  { key: 'entry', title: '今日CS定位', name: '突破手', subtitle: '第一身位 / 拉空间', scoreLabel: '适配指数', advice: '你今天负责把口子撕开，死也要给信息。', avoid: '别第一个出去死了还不报点。', line: '突破签很硬，问题是你得真敢第一个进。', fandomFile: 'CS2_AK-47_Inventory.png' },
  { key: 'support', title: '今日CS定位', name: '辅助位', subtitle: '闪光烟火 / 脏活累活', scoreLabel: '适配指数', advice: '道具给明白，补枪站近一点，别嫌镜头少。', avoid: '别闪队友比闪敌人准。', line: '辅助签不丢人，赢回合的人都懂。', fandomFile: 'Flashbanghud_csgo.png' },
  { key: 'anchor', title: '今日CS定位', name: '包点锚点', subtitle: '守点纪律 / 抗压', scoreLabel: '适配指数', advice: '别急着前压送，拖时间就是价值。', avoid: '别听到脚步就自己交完全部道具。', line: '锚点签很残酷，镜头少但锅大。', fandomFile: 'CS2_Nuke_A_site.png' },
  { key: 'lurker', title: '今日CS定位', name: '自由人', subtitle: '侧翼时机 / 信息差', scoreLabel: '适配指数', advice: '慢一点，等timing，别为了绕后把正面卖完。', avoid: '别绕到最后队友全没了。', line: '自由人签不是逛街签，别误会。', fandomFile: 'De_mirage_cs2.png' },
  { key: 'igl', title: '今日CS定位', name: '指挥', subtitle: '节奏和决策 / 背锅位', scoreLabel: '适配指数', advice: '今天少喊口号，多给明确计划，暂停后第一回合要有东西。', avoid: '别五个人各打各的还说是默认。', line: '指挥签，嘴可以硬，战术得真有。', fandomFile: 'Cs2_inferno_remake.png' },
  { key: 'awper-role', title: '今日CS定位', name: '狙击手', subtitle: '首杀和架点 / 高责任位', scoreLabel: '适配指数', advice: '拿首杀就收，空枪就退，别恋战。', avoid: '别一把狙打成队伍财政黑洞。', line: '狙击手签很帅，但空枪也很响。', fandomFile: 'CS2_AWP_Inventory.png' },
];

const csUtilities: DailyCard[] = [
  { key: 'flash', title: '今日CS道具', name: '闪光弹', subtitle: '破点和补枪节奏 / 队友最怕你乱丢', scoreLabel: '道具准度', advice: '先报闪再出手，帮队友拿第一枪，不要自己闪自己。', avoid: '别闪出去发现白的只有队友。', line: '闪光签挺关键，闪得好是体系，闪不好是事故。', fandomFile: 'Flashbanghud_csgo.png' },
  { key: 'smoke', title: '今日CS道具', name: '烟雾弹', subtitle: '切空间 / 拖时间 / 断信息', scoreLabel: '道具准度', advice: '烟要封关键视线，别为了丢烟把自己站成免费首杀。', avoid: '别烟封歪了还硬说是新战术。', line: '烟这个东西，封住的是枪线，封不住脑子。', fandomFile: 'Smokegrenadehud_csgo.png' },
  { key: 'molotov', title: '今日CS道具', name: '燃烧弹', subtitle: '清点和拖延 / 逼位移', scoreLabel: '道具准度', advice: '火要么逼人走，要么拖回防，别烧空气。', avoid: '别下包后火全交完，回防来了只能干看。', line: '火丢得好，对面难受；火丢得烂，队友难受。', fandomFile: 'Molotovhud.png' },
  { key: 'he', title: '今日CS道具', name: 'HE手雷', subtitle: '压血线 / 反清 / 经济局偷伤害', scoreLabel: '道具准度', advice: '听到脚步再给，配合枪线把对面血量打残。', avoid: '别开局随手一颗雷，炸了个心理安慰。', line: '雷签就是朴实，炸不死人也要炸出价值。', fandomFile: 'Hegrenadehud_csgo.png' },
  { key: 'decoy', title: '今日CS道具', name: '诱饵弹', subtitle: '整活和骗信息 / 低成本节目效果', scoreLabel: '道具准度', advice: '能骗一秒是一秒，但别真把战术押在这玩意上。', avoid: '别全队最有设计的是诱饵弹。', line: '诱饵签有点抽象，但抽象里偶尔也有东西。', fandomFile: 'Decoyhud_csgo.png' },
  { key: 'kit', title: '今日CS道具', name: '拆弹钳', subtitle: '回防保险 / 别省小钱丢大局', scoreLabel: '道具准度', advice: 'CT经济允许就买，残局少一秒就是两种人生。', avoid: '别到包前才发现自己没钳，开始看天命。', line: '钳子签很现实，CS最后经常输在这点小钱。', fandomFile: 'Defuserhud_csgo.png' },
];

const csTactics: DailyCard[] = [
  { key: 'default', title: '今日CS战术', name: '默认控图', subtitle: '信息优先 / 慢慢压缩', scoreLabel: '执行指数', advice: '先拿信息和地图控制，再决定提速点，别五个人同时迷路。', avoid: '别默认默认着就没人敢动了。', line: '默认不是发呆，默认是让对面先露破绽。', fandomFile: 'De_mirage_cs2.png' },
  { key: 'explode', title: '今日CS战术', name: '爆弹一波', subtitle: '道具同步 / 快速进点', scoreLabel: '执行指数', advice: '烟闪火一起到，人也要一起到，别道具打完人在原地。', avoid: '别一波爆弹变成一波排队。', line: '爆弹签要的就是整齐，散了就只剩节目。', fandomFile: 'Smokegrenadehud_csgo.png' },
  { key: 'split', title: '今日CS战术', name: '夹击同步', subtitle: '两线压力 / timing 最重要', scoreLabel: '执行指数', advice: '两边别脱节，正面先给压力，侧翼再收口。', avoid: '别夹击夹到最后只剩一个人在逛街。', line: '夹击签很吃沟通，一慢就从战术变成旅游。', fandomFile: 'Overpass_CS2.png' },
  { key: 'fake', title: '今日CS战术', name: '假打转点', subtitle: '骗轮转 / 读防守', scoreLabel: '执行指数', advice: '假打要让对面真信，给声音、给道具、给压力，再转。', avoid: '别对面没动，你自己先被自己骗了。', line: '假打签有脑子，但脑子得比嗓门先到。', fandomFile: 'Flashbanghud_csgo.png' },
  { key: 'contact', title: '今日CS战术', name: '静音接触', subtitle: '靠近点位 / 突然提速', scoreLabel: '执行指数', advice: '走到位再爆发，第一枪要有人补，别一个人开故事。', avoid: '别静音摸到脸上，然后没人敢出。', line: '接触签就是憋一口气，憋完得真打出来。', fandomFile: 'CS2_AK-47_Inventory.png' },
  { key: 'forcebuy', title: '今日CS战术', name: '强起翻盘', subtitle: '经济赌博 / 信息和交叉火力', scoreLabel: '执行指数', advice: '枪差就打近点和交叉，别中远距离硬找自信。', avoid: '别把强起打成捐款。', line: '强起签可以燃，但燃完别把经济烧没了。', fandomFile: 'CS2_Desert_Eagle_Inventory.png' },
];

const csClutches: DailyCard[] = [
  { key: 'one-v-one', title: '今日CS残局', name: '1v1残局', subtitle: '信息差 / 假动作 / 心态', scoreLabel: '残局指数', advice: '别急着给脚步，先判断包点和时间，再做选择。', avoid: '别明明有时间，硬急成无信息单挑。', line: '1v1签就是心理战，谁先急谁先交学费。', fandomFile: 'CS2_Desert_Eagle_Inventory.png' },
  { key: 'save', title: '今日CS残局', name: '理性保枪', subtitle: '经济纪律 / 下一回合还能做人', scoreLabel: '残局指数', advice: '没钳没道具没位置，该保就保，别为了面子送枪。', avoid: '别保枪保到被抓，经济和面子一起没。', line: '保枪签不丢人，丢人的是保都保不住。', fandomFile: 'CS2_AWP_Inventory.png' },
  { key: 'retake', title: '今日CS残局', name: '多人回防', subtitle: '切空间 / 道具反清 / 不要一窝蜂', scoreLabel: '残局指数', advice: '先等队友，再用烟闪切点，别三个人从同一个门挤进去。', avoid: '别人数优势打成排队单挑。', line: '回防签看纪律，不是看谁嗓门最大。', fandomFile: 'Defuserhud_csgo.png' },
  { key: 'postplant', title: '今日CS残局', name: '下包后防守', subtitle: '交叉枪线 / 时间压力', scoreLabel: '残局指数', advice: '站位拉开，别全看一个方向，听拆包再给压力。', avoid: '别包都下了还主动送出去帮对面提速。', line: '下包后签就是别急，时间是你队友。', fandomFile: 'De_anubis_cs2.png' },
  { key: 'eco-clutch', title: '今日CS残局', name: 'ECO偷回合', subtitle: '短枪和道具 / 抓对面大意', scoreLabel: '残局指数', advice: '靠近点、叠人、骗道具，别和长枪正常对枪。', avoid: '别拿小枪打远点还说差一点。', line: 'ECO签最会骗人，但真骗到就是血赚。', fandomFile: 'CS2_MAC-10_Inventory.png' },
  { key: 'awp-save', title: '今日CS残局', name: '大狙残局', subtitle: '高价值武器 / 站位选择', scoreLabel: '残局指数', advice: '有机会就打一枪换位，没机会就把狙带走。', avoid: '别为了镜头把全队最贵的枪送了。', line: '狙残局签挺帅，但帅之前先别空。', fandomFile: 'CS2_AWP_Inventory.png' },
];

function todayKey(): string {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function dailySeedForKind(kind: string, userId: number, scopeId: number = 0): number {
  return Math.abs(hashCode(`${todayKey()}_${kind}_${scopeId}_${userId}`));
}

function dailyPlayerFor(userId: number, groupId: number = 0): CSPlayer {
  const seed = dailySeedForKind('csplayer', userId, groupId);
  return csPlayers[seed % csPlayers.length];
}

function dailyPlayerScore(userId: number, groupId: number = 0): number {
  return (dailySeedForKind('csplayer_score', userId, groupId) % 100) + 1;
}

function dailyCardFor(kind: string, userId: number, scopeId: number, cards: DailyCard[]): DailyCard {
  return cards[dailySeedForKind(kind, userId, scopeId) % cards.length];
}

function dailyScoreForKind(kind: string, userId: number, scopeId: number): number {
  return (dailySeedForKind(`${kind}_score`, userId, scopeId) % 100) + 1;
}

function scoreLine(score: number): string {
  if (score >= 95) return '签位：神中神';
  if (score >= 80) return '签位：很能打';
  if (score >= 60) return '签位：有说法';
  if (score >= 35) return '签位：先稳一手';
  return '签位：今天收着点';
}

function scoreAdvice(score: number): string {
  if (score >= 90) return '今天可以主动要空间，但别赢一回合就开香槟。';
  if (score >= 75) return '节奏可以稍微提一点，关键是补枪别掉。';
  if (score >= 55) return '正常打就行，别急着证明自己。';
  if (score >= 35) return '先把默认和信息打明白，别上来就赌。';
  return '今天少硬拉，多等队友，先把回合打完整。';
}

function sourceName(source: CSPlayer['imageSource']): string {
  return source === 'liquipedia' ? 'Liquipedia' : 'Wikimedia';
}

function playerRoleAdvice(player: CSPlayer, score?: number): { style: string; avoid: string } {
  const role = player.role.toLowerCase();
  let style = '先把默认和信息打清楚，别急着演集锦。';
  let avoid = '别为了节目效果把回合送出去。';

  if (/awper|狙/.test(role)) {
    style = '先架关键枪，拿到首杀就换位置，别恋战。';
    avoid = '别空一枪还站原地等审判。';
  } else if (/igl|指挥|coach/.test(role)) {
    style = '先把队友节奏摆明白，暂停后第一波要有东西。';
    avoid = '别五个人各玩各的还说是默认。';
  } else if (/entry|突破/.test(role)) {
    style = '第一身位可以主动要空间，但补枪距离一定要拉近。';
    avoid = '别死了没信息，也没人能补。';
  } else if (/lurker|自由/.test(role)) {
    style = '慢一点等 timing，侧翼到位再出手。';
    avoid = '别绕到最后队友全没了。';
  } else if (/support|辅助/.test(role)) {
    style = '道具给明白，补位及时，脏活干干净净。';
    avoid = '别闪队友比闪对面还准。';
  } else if (/anchor|锚/.test(role)) {
    style = '包点先站住，拖时间就是价值，别急着前压。';
    avoid = '别听到脚步就把道具全交完。';
  } else if (/rifler|步枪|rifle/.test(role)) {
    style = '准星放稳，第一波交换别掉，关键枪别急。';
    avoid = '别让好枪法去救坏决策。';
  }

  if (typeof score === 'number') {
    if (score >= 85) style = `${style} 今天签位高，可以稍微主动一点。`;
    else if (score <= 35) style = `${style} 今天先收着打，别急着证明自己。`;
  }

  return {
    style: player.style || style,
    avoid: player.avoid || avoid,
  };
}

function normalizeDrawText(text: string): string {
  return text.toLowerCase().replace(/^\//, '').replace(/\s+/g, '').replace(/[：:，。！？!?、,.]/g, '');
}

function isCsPlayerStatusRequest(command: string | null, args: string[], rawText: string): boolean {
  const first = (args[0] || '').toLowerCase();
  if (command === 'csplayer' && ['status', '状态'].includes(first)) return true;
  return /^(?:\/)?(?:csplayer|每日选手|今日选手|抽选手)(?:状态|status)$/.test(normalizeDrawText(rawText));
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

function isDailyCardRequest(command: string | null, rawText: string, kind: DailyCardKind): boolean {
  const commandMap: Record<DailyCardKind, string[]> = {
    team: ['csteam', 'csteamday', 'todayteam', '今日队伍', '每日队伍', '抽队伍', '今日战队', '每日战队'],
    map: ['csmap', 'mapday', 'todaymap', '今日地图', '每日地图', '抽地图'],
    weapon: ['csweapon', 'weaponday', 'todayweapon', '今日武器', '每日武器', '抽武器', '今日枪械'],
    role: ['csrole', 'roleday', 'todayrole', '今日定位', '每日定位', '抽定位', '今日位置'],
    loadout: ['csloadout', 'cspack', 'csdaily', '今日cs', '每日cs', '今日cs2', '每日cs2', '今日套餐', '每日套餐', '今日套装', '每日套装'],
    utility: ['csutility', 'csnade', 'todaynade', '今日道具', '每日道具', '抽道具', '今日投掷物'],
    tactic: ['cstactic', 'csstrat', 'todaystrat', '今日战术', '每日战术', '抽战术'],
    clutch: ['csclutch', 'todayclutch', '今日残局', '每日残局', '抽残局'],
  };
  if (command && commandMap[kind].includes(command)) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  if (kind === 'loadout' && ['今日cs', '每日cs', '今天cs', '今日cs2', '每日cs2', '今天cs2'].includes(text)) return true;
  const hasDaily = /(抽|今日|每日|今天|本日|来个|给我来个)/.test(text);
  if (!hasDaily) return false;
  if (kind === 'team') return /(cs队伍|cs2队伍|队伍签|战队|主队|今日队伍|每日队伍)/.test(text);
  if (kind === 'map') return /(cs地图|cs2地图|地图签|今日地图|每日地图|哪张图)/.test(text);
  if (kind === 'weapon') return /(cs武器|cs2武器|枪械|武器签|今日武器|每日武器|今天用什么枪)/.test(text);
  if (kind === 'role') return /(cs定位|cs2定位|位置|定位签|今日定位|每日定位|今天打什么位)/.test(text);
  if (kind === 'utility') return /(cs道具|cs2道具|投掷物|道具签|今日道具|每日道具|今天丢什么)/.test(text);
  if (kind === 'tactic') return /(cs战术|cs2战术|战术签|今日战术|每日战术|今天怎么打|今天打什么战术)/.test(text);
  if (kind === 'clutch') return /(cs残局|cs2残局|残局签|今日残局|每日残局|今天残局|残局怎么打)/.test(text);
  return /(cs套餐|cs2套餐|今日套餐|每日套餐|今日套装|每日套装|今天怎么打|今天打啥)/.test(text);
}

function buildImageFailureLine(): string {
  const stats = getCacheStats();
  return stats.lastError ? `\n图片没发出来：${stats.lastError}` : '\n图片没发出来，先看文字签。';
}

function imageDataUrlToSegment(dataUrl: string): MessageSegment {
  return { type: 'image', data: { file: dataUrl.replace(/^data:image\/[^;]+;base64,/, 'base64://') } };
}

async function tryImageDataUrl(url: string, label: string): Promise<string | null> {
  try {
    return await imageDataUrlResolver(url);
  } catch (err) {
    console.warn(`[fun] 图片解析失败 ${label}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function localDailyCardImage(card: DailyCard, score?: number): MessageSegment {
  const label = card.imageLabel || card.name || card.key;
  const dataUrl = buildDailyCardImageDataUrl({
    title: card.title,
    label,
    subtitle: card.subtitle,
    score: typeof score === 'number' ? `${card.scoreLabel} ${score}/100` : card.scoreLabel,
    seed: `${todayKey()}_${card.key}_${card.title}`,
    footer: 'WANJIER DAILY CS',
  });
  return imageDataUrlToSegment(dataUrl);
}

async function imageSegmentOrNote(url?: string, fallbackPlayerNick?: string, fallbackCard?: DailyCard, score?: number): Promise<MessageSegment[]> {
  if (!url && !fallbackPlayerNick && !fallbackCard) return [];

  const candidateUrls: Array<{ url: string; label: string }> = [];

  if (fallbackCard?.liquipediaPage) {
    try {
      const dynamicUrl = await Promise.race([
        resolveTeamImage(fallbackCard.liquipediaPage, fallbackCard.name),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (dynamicUrl) candidateUrls.push({ url: dynamicUrl, label: `${fallbackCard.name}/team-dynamic` });
    } catch (err) {
      console.warn(`[fun] ${fallbackCard.name} Liquipedia队伍图解析失败:`, err instanceof Error ? err.message : err);
    }
  }

  if (fallbackCard?.fandomFile) {
    try {
      const fandomUrl = await Promise.race([
        resolveFandomFileImage(fallbackCard.fandomFile),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (fandomUrl) candidateUrls.push({ url: fandomUrl, label: `${fallbackCard.name}/fandom-file` });
    } catch (err) {
      console.warn(`[fun] ${fallbackCard.name} Fandom图片解析失败:`, err instanceof Error ? err.message : err);
    }
  }

  if (fallbackCard?.playerImageFallback) {
    const representative = csPlayers.find((player) =>
      player.nick.toLowerCase() === fallbackCard.playerImageFallback!.toLowerCase()
      || player.aliases?.some((alias) => alias.toLowerCase() === fallbackCard.playerImageFallback!.toLowerCase()),
    );
    if (representative) {
      try {
        const dynamicUrl = await Promise.race([
          resolvePlayerImage(representative.nick),
          new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]);
        if (dynamicUrl) candidateUrls.push({ url: dynamicUrl, label: `${fallbackCard.name}/${representative.nick}-fallback-dynamic` });
      } catch (err) {
        console.warn(`[fun] ${fallbackCard.name} 代表选手图动态解析失败:`, err instanceof Error ? err.message : err);
      }
      candidateUrls.push({ url: representative.image, label: `${fallbackCard.name}/${representative.nick}-fallback-static` });
    }
  }

  if (fallbackPlayerNick) {
    try {
      const dynamicUrl = await Promise.race([
        resolvePlayerImage(fallbackPlayerNick),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (dynamicUrl) candidateUrls.push({ url: dynamicUrl, label: `${fallbackPlayerNick}/player-dynamic` });
    } catch (err) {
      console.warn(`[fun] ${fallbackPlayerNick} Liquipedia动态查图失败:`, err instanceof Error ? err.message : err);
    }
  }

  if (url) candidateUrls.push({ url, label: fallbackPlayerNick || fallbackCard?.name || url });

  for (const candidate of candidateUrls) {
    const dataUrl = await tryImageDataUrl(candidate.url, candidate.label);
    if (dataUrl) {
      if (candidate.label.includes('/team-dynamic')) console.log(`[fun] ${fallbackCard?.name} 用Liquipedia队伍图成功`);
      else if (candidate.label.includes('/fandom-file')) console.log(`[fun] ${fallbackCard?.name} 用Fandom图片成功`);
      else if (candidate.label.includes('-fallback-')) console.log(`[fun] ${fallbackCard?.name} 用代表选手真实图兜底成功`);
      else if (candidate.label.includes('/player-dynamic')) console.log(`[fun] ${fallbackPlayerNick} 用Liquipedia动态查图成功`);
      return [imageDataUrlToSegment(dataUrl)];
    }
  }

  if (fallbackPlayerNick) {
    try {
      const query = `${fallbackPlayerNick} CS2 player photo site:wikipedia.org OR site:wikimedia.org`;
      const result = await webSearch(query, 3000, 600, 60);
      if (result) {
        const imgMatch = result.match(/https?:\/\/upload\.wikimedia\.org\/[^\s)"<>]+\.(?:jpg|jpeg|png|webp)/i);
        if (imgMatch) {
          const dataUrl = await tryImageDataUrl(imgMatch[0], `${fallbackPlayerNick}/search`);
          if (dataUrl) {
            console.log(`[fun] ${fallbackPlayerNick} 用webSearch找图成功`);
            return [imageDataUrlToSegment(dataUrl)];
          }
        }
      }
    } catch (err) { /* */ }
  }

  // 最终兜底：本地生成 PNG，不依赖外网，确保每个今日CS分支都有图
  if (fallbackCard) {
    console.log(`[fun] ${fallbackCard.title}/${fallbackCard.name} 使用本地签位卡兜底`);
    return [localDailyCardImage(fallbackCard, score)];
  }

  return [{ type: 'text', data: { text: buildImageFailureLine() } }];
}

async function buildCsPlayerMessage(userId: number, player: CSPlayer, score?: number): Promise<MessageSegment[]> {
  const scoreText = typeof score === 'number' ? `${scoreLine(score)} ${score}/100` : '';
  const roleAdvice = playerRoleAdvice(player, score);
  const text = [
    `今日CS选手 | ${player.nick}`,
    scoreText,
    `${player.team} / ${player.role}`,
    `真名：${player.name}`,
    `今天打法：${roleAdvice.style}`,
    `别急点：${roleAdvice.avoid}`,
    `机器短评：${player.note}`,
    `图源：${sourceName(player.imageSource)}`,
  ].filter(Boolean).join('\n');
  const message: MessageSegment[] = [
    { type: 'at', data: { qq: String(userId) } },
    { type: 'text', data: { text: ` ${text}` } },
  ];
  message.push(...await imageSegmentOrNote(player.image, player.nick));
  return message;
}

async function buildPrivateCsPlayerMessage(player: CSPlayer, score?: number): Promise<MessageSegment[]> {
  const message = (await buildCsPlayerMessage(0, player, score)).filter((seg) => seg.type !== 'at');
  return message;
}

async function buildDailyCardMessage(userId: number, card: DailyCard, score: number, isPrivate: boolean): Promise<MessageSegment[]> {
  const text = [
    `${card.title} | ${card.name}`,
    card.subtitle,
    `${card.scoreLabel}：${score}/100`,
    `今天打法：${card.advice}`,
    `别急点：${card.avoid}`,
    `机器短评：${card.line}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageSegmentOrNote(card.image, undefined, card, score));
  return message;
}

async function buildLoadoutMessage(userId: number, scopeId: number, isPrivate: boolean): Promise<MessageSegment[]> {
  const team = dailyCardFor('csteam_pack', userId, scopeId, csTeams);
  const map = dailyCardFor('csmap_pack', userId, scopeId, csMaps);
  const weapon = dailyCardFor('csweapon_pack', userId, scopeId, csWeapons);
  const role = dailyCardFor('csrole_pack', userId, scopeId, csRoles);
  const score = dailyScoreForKind('csloadout', userId, scopeId);
  const text = [
    '今日CS套餐',
    `队伍：${team.name}`,
    `地图：${map.name}`,
    `武器：${weapon.name}`,
    `定位：${role.name}`,
    `综合节目效果：${score}/100`,
    `今天打法：${role.advice} ${weapon.advice}`,
    `别急点：${map.avoid}`,
    `机器短评：${score >= 80 ? '这套签有点东西，今天可以稍微主动一点。' : score >= 45 ? '能打，但别把自己当主角。' : '这套先稳住，别上来就送大的。'}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageSegmentOrNote(team.image, undefined, team, score));
  return message;
}

export const funPlugin: Plugin = {
  name: 'fun',
  description: '趣味功能 - 掷骰子、抽签、决策辅助等',

  handler: async (ctx) => {
    const raw = ctx.rawText.trim();

    // ===== 中文模糊命令分发：在群聊普通消息中识别 =====
    // 仅当 ctx.command 为空（不是 /xxx 显式命令）时才走模糊匹配，避免冲突
    const fuzzy = ctx.command ? null : detectFuzzyCommand(raw);

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
        '大凶 - 今天真得收着点，别硬拉',
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

    // ===== /forecast 综合每日运势 =====
    if (ctx.command === 'forecast' || ctx.command === '运势' || ctx.command === '今日运势' || fuzzy === 'forecast') {
      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const seed = hashCode(`forecast_${today}_${ctx.event.user_id}`);
      const rp = Math.abs(seed) % 101;
      const scopeId = ctx.groupId || 0;

      const player = dailyPlayerFor(ctx.event.user_id, scopeId);
      const team = dailyCardFor('csteam', ctx.event.user_id, scopeId, csTeams);
      const map = dailyCardFor('csmap', ctx.event.user_id, scopeId, csMaps);

      let mood: string;
      if (rp >= 80) mood = '今日大吉 - 状态拉满，主动找机会';
      else if (rp >= 60) mood = '今日吉 - 稳一点打，别上头';
      else if (rp >= 40) mood = '今日平 - 默认控图，看机会';
      else if (rp >= 20) mood = '今日小凶 - 收着点，别第一身位';
      else mood = '今日大凶 - 保枪 ECO 别硬起';

      ctx.replyAt([
        `🔮 ${today} 玩机器今日运势`,
        '',
        `人品: ${rp}/100`,
        mood,
        '',
        `今日选手: ${player.nick} (${player.team})`,
        `今日队伍: ${team.name}`,
        `今日地图: ${map.name}`,
        '',
        `${player.note || '稳一点打。'}`,
      ].join('\n'));
      return true;
    }

    // ===== 今日人品 =====
    if (ctx.command === 'jrrp' || ctx.command === 'rp' || fuzzy === 'jrrp') {
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
      else comment = '今天先别硬起，保枪吧。';

      ctx.replyAt(`今日人品值: ${rp}/100\n${comment}`);
      return true;
    }

    // ===== /cs2news 实时CS新闻 =====
    if (ctx.command === 'cs2news' || ctx.command === 'csnews' || fuzzy === 'cs2news') {
      try {
        // 优先用HLTV最近结果
        const results = await fetchRecentResults();
        if (results) {
          ctx.reply(`📰 CS最近战报:\n${results}`);
          return true;
        }
        const result = await webSearch('CS2 latest news 2026', 3000);
        if (result) {
          ctx.reply(`📰 CS2近况:\n${result.slice(0, 800)}`);
        } else {
          ctx.reply('搜不到啥新东西，可能是网络问题。');
        }
      } catch {
        ctx.reply('搜不到 网络可能挂了');
      }
      return true;
    }

    // ===== /match 实时比赛 =====
    if (ctx.command === 'match' || ctx.command === 'matches' || ctx.command === '比赛' || fuzzy === 'match') {
      try {
        // 优先用 HLTV 抓取
        const matches = await fetchOngoingMatches();
        if (matches) {
          ctx.reply(`🎮 当前比赛:\n${matches}`);
          return true;
        }
        const result = await webSearch('CS2 ongoing matches today HLTV', 3000);
        if (result) {
          ctx.reply(`🎮 当前比赛:\n${result.slice(0, 800)}`);
        } else {
          ctx.reply('搜不到正在打的比赛 可能赛程间隙');
        }
      } catch {
        ctx.reply('搜不到 网络可能挂了');
      }
      return true;
    }

    // ===== /ranking 当前排名 =====
    if (ctx.command === 'ranking' || ctx.command === 'rank' || ctx.command === '排名' || fuzzy === 'ranking') {
      try {
        // 优先用 HLTV 抓取
        const ranking = await fetchTeamRanking();
        if (ranking) {
          ctx.reply(`🏆 HLTV 战队排名:\n${ranking}`);
          return true;
        }
        const result = await webSearch('HLTV CS2 team ranking 2026 top10', 3000);
        if (result) {
          ctx.reply(`🏆 CS2 排名:\n${result.slice(0, 800)}`);
        } else {
          ctx.reply('搜不到排名信息');
        }
      } catch {
        ctx.reply('搜不到 网络可能挂了');
      }
      return true;
    }

    // ===== /cs2live CS2直播查询 =====
    if (ctx.command === 'cs2live' || ctx.command === 'live' || fuzzy === 'cs2live') {
      try {
        const result = await webSearch('CS2 douyu twitch streaming live now 玩机器', 3000);
        if (result) {
          ctx.reply(`🎬 CS2直播:\n${result.slice(0, 700)}`);
        } else {
          ctx.reply('没搜到正在直播的 玩机器可能没开');
        }
      } catch {
        ctx.reply('搜不到 网络可能挂了');
      }
      return true;
    }

    // ===== /quote 经典语录 =====
    if (ctx.command === 'quote') {
      const tag = ctx.args.join(' ').trim();
      const line = getRandomKnowledgeLine('quote', tag);
      if (line) {
        ctx.reply(line);
      } else {
        ctx.reply(tag ? `没找到「${tag}」相关的语录，换个词` : '语录库暂时没货');
      }
      return true;
    }

    // ===== /csmood 玩机器今日心情 =====
    if (ctx.command === 'csmood' || ctx.command === 'mood' || fuzzy === 'csmood') {
      const moods = [
        '今天状态嘎嘎好 弹幕来吧',
        '今天有点累 不想接梗',
        '今天解说情绪饱满 准备整活',
        '今天有点上头 看比赛容易喷',
        '今天网卡 别问我为什么不联机',
        '今天嘴硬指数+10 别惹我',
        '今天比较佛 你说啥都行',
        '今天爱看Major精彩集锦',
      ];
      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const seed = hashCode(`mood_${today}_${ctx.event.user_id}`);
      const mood = moods[Math.abs(seed) % moods.length];
      ctx.reply(`${today}\n${mood}`);
      return true;
    }


    if (isCsPlayerStatusRequest(ctx.command, ctx.args, raw)) {
      const stats = getCacheStats();
      ctx.reply([
        '每日CS选手状态',
        `选手池: ${csPlayers.length}人`,
        `队伍池: ${csTeams.length}队`,
        `图片缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB`,
        `图片命中: ${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
        ...(stats.lastError ? [`最近图片错误: ${stats.lastError}`] : []),
        '',
        'admin: /csprewarm 预下载所有选手图(慢，受限流影响)',
      ].join('\n'));
      return true;
    }

    // ===== /csprewarm 预下载所有选手图（admin） =====
    if (ctx.command === 'csprewarm') {
      const config = ctx.bot.getConfig();
      if (!config.admin_qq.includes(ctx.event.user_id)) {
        ctx.replyAt('⛔ 仅管理员可用');
        return true;
      }
      ctx.reply(`开始预下载 ${csPlayers.length} 张选手图，每张间隔 5 秒，预计 ${Math.round(csPlayers.length * 5 / 60)} 分钟。完成后会通知。`);
      // 后台异步执行
      void (async () => {
        let success = 0;
        let failed = 0;
        for (let i = 0; i < csPlayers.length; i++) {
          const player = csPlayers[i];
          const segments = await imageSegmentOrNote(player.image, player.nick);
          if (segments.some((seg) => seg.type === 'image')) success++;
          else failed++;
          // 5 秒间隔，避免被限流
          await new Promise((r) => setTimeout(r, 5000));
        }
        const target = ctx.groupId
          ? () => ctx.bot.sendGroupMessage(ctx.groupId!, `预下载完成：成功 ${success} 失败 ${failed}`)
          : () => ctx.bot.sendPrivateMessage(ctx.event.user_id, `预下载完成：成功 ${success} 失败 ${failed}`);
        try { await target(); } catch { /* */ }
      })();
      return true;
    }
    if (isCsPlayerDrawRequest(ctx.command, raw) || fuzzy === 'csplayer') {
      const scopeId = ctx.groupId || 0;
      const player = dailyPlayerFor(ctx.event.user_id, scopeId);
      const score = dailyPlayerScore(ctx.event.user_id, scopeId);
      ctx.reply(ctx.isPrivate
        ? await buildPrivateCsPlayerMessage(player, score)
        : await buildCsPlayerMessage(ctx.event.user_id, player, score));
      return true;
    }

    // ===== 每日CS队伍/地图/武器/定位/套餐 =====
    const scopeId = ctx.groupId || 0;
    if (isDailyCardRequest(ctx.command, raw, 'loadout') || fuzzy === 'csloadout') {
      ctx.reply(await buildLoadoutMessage(ctx.event.user_id, scopeId, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'team') || fuzzy === 'csteam') {
      const card = dailyCardFor('csteam', ctx.event.user_id, scopeId, csTeams);
      const score = dailyScoreForKind('csteam', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'map') || fuzzy === 'csmap') {
      const card = dailyCardFor('csmap', ctx.event.user_id, scopeId, csMaps);
      const score = dailyScoreForKind('csmap', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'weapon') || fuzzy === 'csweapon') {
      const card = dailyCardFor('csweapon', ctx.event.user_id, scopeId, csWeapons);
      const score = dailyScoreForKind('csweapon', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'role') || fuzzy === 'csrole') {
      const card = dailyCardFor('csrole', ctx.event.user_id, scopeId, csRoles);
      const score = dailyScoreForKind('csrole', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'utility') || fuzzy === 'csutility') {
      const card = dailyCardFor('csutility', ctx.event.user_id, scopeId, csUtilities);
      const score = dailyScoreForKind('csutility', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'tactic') || fuzzy === 'cstactic') {
      const card = dailyCardFor('cstactic', ctx.event.user_id, scopeId, csTactics);
      const score = dailyScoreForKind('cstactic', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'clutch') || fuzzy === 'csclutch') {
      const card = dailyCardFor('csclutch', ctx.event.user_id, scopeId, csClutches);
      const score = dailyScoreForKind('csclutch', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate));
      return true;
    }

    return false;
  },
};

export const __test = {
  csPlayers,
  csTeams,
  csMaps,
  csWeapons,
  csRoles,
  csUtilities,
  csTactics,
  csClutches,
  dailyPlayerFor,
  dailyPlayerScore,
  dailyCardFor,
  dailyScoreForKind,
  isCsPlayerDrawRequest,
  isCsPlayerStatusRequest,
  isDailyCardRequest,
  buildCsPlayerMessage,
  buildDailyCardMessage,
  buildLoadoutMessage,
  __setImageResolverForTests: (resolver?: (url: string) => Promise<string | null>) => {
    imageDataUrlResolver = resolver || getImageDataUrl;
  },
};

/**
 * 后台预热选手图缓存。每张间隔 8 秒，避免触发 Liquipedia 限流。
 * 跑完后所有选手图都在本地，30 天不会再要外网。
 */
export async function prewarmPlayerImages(): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  for (const player of csPlayers) {
    try {
      const segments = await imageSegmentOrNote(player.image, player.nick);
      if (segments.some((seg) => seg.type === 'image')) success++;
      else failed++;
    } catch { failed++; }
    // 8 秒间隔严格避免限流
    await new Promise((r) => setTimeout(r, 8000));
  }
  console.log(`[Prewarm] 选手图预热完成: 成功${success} 失败${failed}`);
  return { success, failed };
}

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
