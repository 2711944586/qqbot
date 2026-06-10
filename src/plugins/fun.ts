import * as fs from 'fs';
import * as path from 'path';
import { MessageSegment, Plugin, PluginContext } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';
import { getCacheStats, getImageDataUrl } from './image-cache';
import { webSearch } from './web-search';
import { fetchOngoingMatches, fetchTeamRanking, fetchRecentResults } from './hltv-api';
import { detectFuzzyCommand } from './fuzzy-command';
import { getLiquipediaImageStats, resolvePlayerImage, resolveTeamImage } from './liquipedia-image';
import { resolveFandomFileImage } from './fandom-image';
import { buildDailyCardImageDataUrl } from './daily-card-image';
import { getCsPredictTrainingHint } from './cs-predict';
import { buildUserProfileDailyCsHint } from './user-profile';

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
type CsQuizKind = 'map' | 'weapon' | 'utility' | 'tactic' | 'clutch';
type CsImageProbeKind = DailyCardKind | 'player' | 'all';
type TrainingArea = 'aim' | 'utility' | 'map' | 'role' | 'clutch' | 'review' | 'match';
type TrainingWeaknessKey = 'death' | 'trade' | 'utility' | 'aim' | 'clutch' | 'map' | 'review';

interface ImageCandidate {
  url: string;
  label: string;
  source: 'liquipedia-team' | 'fandom-file' | 'representative-player-dynamic' | 'representative-player-static' | 'liquipedia-player' | 'static-url';
}

interface CsTrainingLogEntry {
  id: string;
  chatType: 'group' | 'private';
  chatId: number;
  groupId?: number;
  userId: number;
  displayName: string;
  area: TrainingArea;
  minutes: number;
  map: string;
  weapon: string;
  note: string;
  createdAt: number;
}

interface CsTrainingStore {
  version: 1;
  logs: CsTrainingLogEntry[];
}

interface TrainingWeaknessSignal {
  key: TrainingWeaknessKey;
  label: string;
  count: number;
  minutes: number;
  sample: string;
}

interface CsQuiz {
  kind: CsQuizKind;
  title: string;
  context: string;
  question: string;
  options: string[];
  correctOptionIndex: number;
  answer: string;
  comment: string;
  score: number;
}

let imageDataUrlResolver: (url: string) => Promise<string | null> = getImageDataUrl;
let playerImageResolver: (player: string) => Promise<string | null> = resolvePlayerImage;
let teamImageResolver: (page: string, teamName: string) => Promise<string | null> = resolveTeamImage;
let fandomImageResolver: (filename: string) => Promise<string | null> = resolveFandomFileImage;

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

const DEFAULT_TRAINING_STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'cs-training.json');
const MAX_TRAINING_LOGS = 2000;
const TRAINING_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
let trainingStorePathOverride = '';

function trainingStorePath(): string {
  return trainingStorePathOverride || DEFAULT_TRAINING_STORE_PATH;
}

function emptyTrainingStore(): CsTrainingStore {
  return { version: 1, logs: [] };
}

function cleanTrainingText(value: string, max = 80): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/[|`<>]/g, '')
    .trim()
    .slice(0, max);
}

function loadTrainingStore(): CsTrainingStore {
  const filepath = trainingStorePath();
  if (!fs.existsSync(filepath)) return emptyTrainingStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const logs = Array.isArray(parsed?.logs) ? parsed.logs : [];
    return {
      version: 1,
      logs: logs
        .filter((item: Partial<CsTrainingLogEntry>) => item && item.id && item.userId && item.chatId && item.createdAt)
        .map((item: CsTrainingLogEntry) => ({
          id: String(item.id),
          chatType: item.chatType === 'private' ? 'private' : 'group',
          chatId: Number(item.chatId),
          groupId: item.groupId ? Number(item.groupId) : undefined,
          userId: Number(item.userId),
          displayName: cleanTrainingText(item.displayName || `user${item.userId}`, 24),
          area: normalizeTrainingArea(item.area),
          minutes: clampMinutes(item.minutes),
          map: cleanTrainingText(item.map || '', 32),
          weapon: cleanTrainingText(item.weapon || '', 32),
          note: cleanTrainingText(item.note || '', 100),
          createdAt: Number(item.createdAt || 0),
        })),
    };
  } catch {
    return emptyTrainingStore();
  }
}

function saveTrainingStore(store: CsTrainingStore): void {
  const filepath = trainingStorePath();
  const cutoff = Date.now() - TRAINING_RETENTION_MS;
  const logs = store.logs
    .filter((item) => item.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_TRAINING_LOGS)
    .sort((a, b) => a.createdAt - b.createdAt);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, logs }, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

function clampMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(1, Math.min(360, Math.round(parsed)));
}

function normalizeTrainingArea(value: unknown): TrainingArea {
  const text = String(value || '').toLowerCase();
  if (['utility', 'nade', '道具', '投掷物'].includes(text)) return 'utility';
  if (['map', '地图', '控图'].includes(text)) return 'map';
  if (['role', '定位', '位置'].includes(text)) return 'role';
  if (['clutch', '残局', '回防'].includes(text)) return 'clutch';
  if (['review', 'demo', '复盘', '录像'].includes(text)) return 'review';
  if (['match', '实战', '天梯', '排位'].includes(text)) return 'match';
  return 'aim';
}

function areaLabel(area: TrainingArea): string {
  const labels: Record<TrainingArea, string> = {
    aim: '练枪',
    utility: '道具',
    map: '地图',
    role: '定位',
    clutch: '残局',
    review: '复盘',
    match: '实战',
  };
  return labels[area];
}

function compactTrainingCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

const trainingWeaknessSpecs: Record<TrainingWeaknessKey, {
  label: string;
  patterns: RegExp[];
  advice: string;
}> = {
  death: {
    label: '死亡质量',
    patterns: [/死亡|死了|暴毙|白给|先死|首死|被抓|掉人|送了|干拉死|没换到/i],
    advice: '先截3个死亡回合，分清是干拉、被抓timing还是没等补枪；下一局只改一个死法。',
  },
  trade: {
    label: '补枪交换',
    patterns: [/补枪|交易|trade|二身位|同步|跟不上|拉不开|距离太远|换不到|没补上/i],
    advice: '把二身位距离拉到能2秒内补枪，突破时先喊“我出/你补”，别各打各的。',
  },
  utility: {
    label: '道具时机',
    patterns: [/道具|投掷物|烟|闪|火|雷|没闪|白了自己|封烟|烟没|忘丢|没丢|丢晚|丢早|nade|utility/i],
    advice: '每张图只挑2颗高频烟闪火，练到能说清目的、落点和出手时机，再进实战。',
  },
  aim: {
    label: '急停预瞄',
    patterns: [/急停|预瞄|拉枪|控枪|压枪|爆头线|枪法|定位|peek|干拉|空枪|马枪|反应/i],
    advice: '先把急停和预瞄线校准，DM里少追击杀数，多看第一枪是不是干净。',
  },
  clutch: {
    label: '残局回防',
    patterns: [/残局|回防|下包|拆包|保枪|1v\d?|clutch|postplant|时间不够|没钳/i],
    advice: '残局先数人数、道具和时间；能等队友就等，不能打就保枪，别把优势打成单挑。',
  },
  map: {
    label: '地图信息',
    patterns: [/控图|默认|中路|香蕉道|长箱|短箱|a点|b点|包点|站位|架点|信息|timing|被绕|地图理解/i],
    advice: '复盘开局30秒的信息链：谁拿空间、谁补道具、谁防绕后，先把默认打明白。',
  },
  review: {
    label: '复盘闭环',
    patterns: [/复盘|demo|录像|回看|死亡回合|截\d?|看录像|检讨/i],
    advice: '复盘别只说“枪软”，每次写一个原因和一个下局动作，第二天再看有没有复发。',
  },
};

function detectTrainingCardName(text: string, cards: DailyCard[]): string {
  const compact = compactTrainingCompare(text);
  for (const card of cards) {
    const names = [card.key, card.name, card.title.replace(/^今日CS/, '')];
    if (names.some((name) => {
      const normalized = compactTrainingCompare(name);
      return normalized && compact.includes(normalized);
    })) {
      return card.name;
    }
  }
  return '';
}

function detectTrainingWeapon(text: string): string {
  const compact = compactTrainingCompare(text);
  if (/ak|ak47|ak-47/.test(compact)) return 'AK-47';
  if (/m4|a1s|m4a1/.test(compact)) return 'M4A1-S';
  if (/awp|大狙|狙/.test(compact)) return 'AWP';
  if (/deagle|沙鹰/.test(compact)) return 'Desert Eagle';
  return detectTrainingCardName(text, csWeapons);
}

function detectTrainingArea(text: string): TrainingArea {
  const compact = compactTrainingCompare(text);
  if (/(复盘|demo|录像|死亡回合|回看)/.test(compact)) return 'review';
  if (/(道具|烟|闪|火|雷|投掷物|nade|utility)/i.test(text)) return 'utility';
  if (/(残局|回防|下包|保枪|1v|clutch)/i.test(text)) return 'clutch';
  if (/(定位|突破|辅助|锚点|自由人|指挥|狙击手|role)/i.test(text)) return 'role';
  if (/(实战|天梯|排位|官匹|faceit|premier|match)/i.test(text)) return 'match';
  if (/(练枪|枪法|急停|预瞄|拉枪|控枪|爆头|死斗|dm|bot|ak|awp|m4|沙鹰)/i.test(text)) return 'aim';
  if (/(地图|控图|默认|mirage|inferno|nuke|ancient|anubis|dust2|overpass)/i.test(text)) return 'map';
  return 'aim';
}

function detectTrainingWeaknesses(text: string): TrainingWeaknessKey[] {
  const normalized = cleanTrainingText(text, 240).toLowerCase();
  if (!normalized) return [];
  return (Object.keys(trainingWeaknessSpecs) as TrainingWeaknessKey[])
    .filter((key) => trainingWeaknessSpecs[key].patterns.some((pattern) => pattern.test(normalized)));
}

function primaryTrainingWeaknessText(keys: TrainingWeaknessKey[]): string {
  return keys.map((key) => trainingWeaknessSpecs[key].label).join(' / ');
}

function weaknessLogCommand(parsed: ReturnType<typeof parseTrainingLogInput>): string {
  if (!parsed) return '/cstrain log 30 Mirage AK 急停';
  const noteCompact = compactTrainingCompare(parsed.note);
  const mapPart = parsed.map && !noteCompact.includes(compactTrainingCompare(parsed.map)) ? parsed.map : '';
  const weaponCompact = compactTrainingCompare(parsed.weapon);
  const weaponPart = parsed.weapon
    && !noteCompact.includes(weaponCompact)
    && !(weaponCompact === 'ak47' && noteCompact.includes('ak'))
    && !(weaponCompact === 'm4a1s' && noteCompact.includes('m4'))
    ? parsed.weapon
    : '';
  const parts = [
    '/cstrain log',
    parsed.area,
    String(parsed.minutes),
    mapPart,
    weaponPart,
    parsed.note || '',
  ].filter(Boolean);
  return cleanTrainingText(parts.join(' '), 120);
}

function parseTrainingLogInput(args: string[]): { area: TrainingArea; minutes: number; map: string; weapon: string; note: string } | null {
  const raw = args.join(' ').trim();
  if (!raw) return null;
  const minutesMatch = raw.match(/(?:^|\s)(\d{1,3})(?:\s*(?:分钟|min|m))?(?=\s|$)/i);
  const minutes = minutesMatch ? clampMinutes(minutesMatch[1]) : 30;
  const withoutMinutes = minutesMatch
    ? `${raw.slice(0, minutesMatch.index).trim()} ${raw.slice((minutesMatch.index || 0) + minutesMatch[0].length).trim()}`.trim()
    : raw;
  if (!withoutMinutes && !minutesMatch) return null;
  const area = normalizeTrainingArea(args[0]);
  const detectedArea = area === 'aim' && !/^(?:aim|枪法|练枪)$/i.test(args[0] || '')
    ? detectTrainingArea(raw)
    : area;
  const map = detectTrainingCardName(raw, csMaps);
  const weapon = detectTrainingWeapon(raw);
  const note = cleanTrainingText(withoutMinutes || raw, 100);
  return { area: detectedArea, minutes, map, weapon, note };
}

function analyzeTrainingLogInput(args: string[]): {
  parsed: NonNullable<ReturnType<typeof parseTrainingLogInput>>;
  weaknesses: TrainingWeaknessKey[];
} | null {
  const parsed = parseTrainingLogInput(args);
  if (!parsed) return null;
  const weaknesses = detectTrainingWeaknesses([parsed.note, parsed.map, parsed.weapon, parsed.area].join(' '));
  return { parsed, weaknesses };
}

function trainingDisplayName(ctx: PluginContext): string {
  return cleanTrainingText(ctx.event.sender.card || ctx.event.sender.nickname || `user${ctx.event.user_id}`, 24);
}

function addTrainingLog(ctx: PluginContext, parsed: { area: TrainingArea; minutes: number; map: string; weapon: string; note: string }): CsTrainingLogEntry {
  const store = loadTrainingStore();
  const createdAt = Date.now();
  const entry: CsTrainingLogEntry = {
    id: `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    chatType: ctx.chatType,
    chatId: Number(ctx.chatId),
    groupId: ctx.groupId,
    userId: ctx.event.user_id,
    displayName: trainingDisplayName(ctx),
    area: parsed.area,
    minutes: parsed.minutes,
    map: parsed.map,
    weapon: parsed.weapon,
    note: parsed.note,
    createdAt,
  };
  store.logs.push(entry);
  saveTrainingStore(store);
  return entry;
}

function logsForUser(chatType: 'group' | 'private', chatId: number | string, userId: number, days = 14): CsTrainingLogEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return loadTrainingStore().logs
    .filter((item) => item.chatType === chatType && String(item.chatId) === String(chatId) && item.userId === userId && item.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function collectTrainingWeaknessSignals(logs: CsTrainingLogEntry[]): TrainingWeaknessSignal[] {
  const signals = new Map<TrainingWeaknessKey, TrainingWeaknessSignal>();
  for (const log of logs) {
    const keys = detectTrainingWeaknesses([log.note, log.map, log.weapon, log.area].join(' '));
    for (const key of keys) {
      const spec = trainingWeaknessSpecs[key];
      const existing = signals.get(key);
      if (existing) {
        existing.count += 1;
        existing.minutes += log.minutes;
        if (!existing.sample && log.note) existing.sample = log.note;
      } else {
        signals.set(key, {
          key,
          label: spec.label,
          count: 1,
          minutes: log.minutes,
          sample: log.note,
        });
      }
    }
  }
  return [...signals.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.label.localeCompare(b.label, 'zh-CN'));
}

function summarizeTrainingLogs(logs: CsTrainingLogEntry[]): {
  sessions: number;
  minutes: number;
  byArea: Partial<Record<TrainingArea, number>>;
  topArea: TrainingArea | null;
  missing: TrainingArea[];
  weaknesses: TrainingWeaknessSignal[];
  recent: CsTrainingLogEntry[];
} {
  const byArea: Partial<Record<TrainingArea, number>> = {};
  let minutes = 0;
  for (const log of logs) {
    minutes += log.minutes;
    byArea[log.area] = (byArea[log.area] || 0) + log.minutes;
  }
  const topArea = (Object.entries(byArea).sort((a, b) => b[1] - a[1])[0]?.[0] || null) as TrainingArea | null;
  const missing = (['aim', 'utility', 'review', 'match'] as TrainingArea[]).filter((area) => !byArea[area]);
  return { sessions: logs.length, minutes, byArea, topArea, missing, weaknesses: collectTrainingWeaknessSignals(logs), recent: logs.slice(0, 5) };
}

function formatTrainingWeaknessSignals(signals: TrainingWeaknessSignal[], limit = 3): string {
  return signals.slice(0, limit).map((signal) => `${signal.label}${signal.count}次`).join(' / ');
}

function buildTrainingAdvice(summary: ReturnType<typeof summarizeTrainingLogs>): string {
  if (summary.sessions === 0) return '还没训练记录，先用 /cstrain log 30 Mirage AK 急停 记一条，后面就能按你短板调计划。';
  const topWeakness = summary.weaknesses[0];
  if (topWeakness) {
    const sample = topWeakness.sample ? `你日志里写过“${cleanTrainingText(topWeakness.sample, 28)}”，` : '';
    return `${sample}${trainingWeaknessSpecs[topWeakness.key].advice}`;
  }
  if (summary.minutes < 90) return '训练频率还偏低，先别追花活，连续三天把热身+一项重点练完。';
  if (summary.topArea === 'aim' && summary.missing.includes('utility')) return '最近练枪偏多，道具偏少；今天补一组烟闪火，别只靠枪法救坏决策。';
  if (summary.missing.includes('review')) return '最近缺复盘；今天至少截3个死亡回合，看补枪距离和道具时机。';
  if (summary.missing.includes('match')) return '最近实战记录少；练完打一局，把训练目标带进回合里，不然就是靶场幻觉。';
  if (summary.topArea === 'utility') return '最近道具有练到，今天把道具和第一枪连起来，别只会站出生点背点位。';
  return '训练结构还行，今天重点是少贪枪、练完复盘，别让训练变成打卡截图。';
}

function buildCsTrainingHistoryHint(chatType: 'group' | 'private', chatId: number | string, userId: number): string {
  const logs = logsForUser(chatType, chatId, userId, 14);
  if (logs.length === 0) return '';
  const summary = summarizeTrainingLogs(logs);
  const areaParts = (Object.entries(summary.byArea) as [TrainingArea, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([area, minutes]) => `${areaLabel(area)}${minutes}m`)
    .join(' / ');
  const weaknessParts = formatTrainingWeaknessSignals(summary.weaknesses);
  return [
    `训练历史：近14天${summary.sessions}次/${summary.minutes}分钟${areaParts ? `，${areaParts}` : ''}`,
    weaknessParts ? `日志短板：${weaknessParts}` : '',
    `个人短板：${buildTrainingAdvice(summary)}`,
  ].filter(Boolean).join('\n');
}

function formatTrainingLogEntry(entry: CsTrainingLogEntry): string {
  const parts = [
    areaLabel(entry.area),
    `${entry.minutes}分钟`,
    entry.map || '',
    entry.weapon || '',
  ].filter(Boolean);
  return `${parts.join(' / ')}${entry.note ? ` | ${entry.note}` : ''}`;
}

function formatCsTrainingStats(chatType: 'group' | 'private', chatId: number | string, userId: number): string {
  const logs = logsForUser(chatType, chatId, userId, 14);
  const summary = summarizeTrainingLogs(logs);
  if (summary.sessions === 0) {
    return [
      'CS训练记录',
      '近14天还没有记录。',
      '用法：/cstrain log 30 Mirage AK 急停',
      '也可以：/cstrain log 道具 20 Inferno 烟闪',
    ].join('\n');
  }
  const areaParts = (Object.entries(summary.byArea) as [TrainingArea, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([area, minutes]) => `${areaLabel(area)}${minutes}m`)
    .join(' / ');
  return [
    'CS训练记录',
    `近14天: ${summary.sessions}次 / ${summary.minutes}分钟`,
    `分布: ${areaParts}`,
    summary.weaknesses.length ? `日志短板: ${formatTrainingWeaknessSignals(summary.weaknesses)}` : '',
    `建议: ${buildTrainingAdvice(summary)}`,
    '',
    '最近记录:',
    ...summary.recent.map((entry, index) => `${index + 1}. ${formatTrainingLogEntry(entry)}`),
    '',
    '/cstrain clear 可以清空你在当前会话的训练记录',
  ].filter((line) => line !== '').join('\n');
}

function formatCsTrainingAnalysis(analysis: NonNullable<ReturnType<typeof analyzeTrainingLogInput>>): string {
  const weaknessText = primaryTrainingWeaknessText(analysis.weaknesses) || '暂时没识别到明确短板';
  const advice = analysis.weaknesses
    .slice(0, 3)
    .map((key, index) => `${index + 1}. ${trainingWeaknessSpecs[key].advice}`);
  return [
    'CS训练日志分析',
    `识别重点: ${weaknessText}`,
    `推断分类: ${areaLabel(analysis.parsed.area)} / ${analysis.parsed.minutes}分钟${analysis.parsed.map ? ` / ${analysis.parsed.map}` : ''}${analysis.parsed.weapon ? ` / ${analysis.parsed.weapon}` : ''}`,
    analysis.parsed.note ? `原始摘要: ${analysis.parsed.note}` : '',
    advice.length ? '建议动作:' : '',
    ...advice,
    advice.length ? '' : '建议动作: 先补一句具体问题，比如“死亡多、补枪慢、没闪、回防乱”，我再给你拆训练项。',
    `要写入训练历史可以发: ${weaknessLogCommand(analysis.parsed)}`,
    '真话边界：这里只分析你发的文字日志，不读取demo/截图，也不当作实时赛事事实。',
  ].filter((line) => line !== '').join('\n');
}

function clearTrainingLogs(chatType: 'group' | 'private', chatId: number | string, userId: number): number {
  const store = loadTrainingStore();
  const before = store.logs.length;
  store.logs = store.logs.filter((item) => !(item.chatType === chatType && String(item.chatId) === String(chatId) && item.userId === userId));
  saveTrainingStore(store);
  return before - store.logs.length;
}

function trainingCommandUsage(): string {
  return [
    'CS训练记录用法',
    '/cstrain - 今日训练计划',
    '/cstrain log 30 Mirage AK 急停',
    '/cstrain log 道具 20 Inferno 烟闪',
    '/cstrain analyze Mirage 死亡8次 补枪距离太远 没闪',
    '/cstrain stats - 看近14天训练分布',
    '/cstrain clear - 清空当前会话你的训练记录',
  ].join('\n');
}

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

function compactBriefBlock(title: string, value: string, maxChars: number): string {
  const cleaned = (value || '').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return `${title}: 暂无准信`;
  return [`【${title}】`, cleaned.slice(0, maxChars)].join('\n');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function buildCsBrief(): Promise<string> {
  const [matches, results, ranking] = await Promise.all([
    withTimeout(fetchOngoingMatches().catch(() => ''), 6500, ''),
    withTimeout(fetchRecentResults().catch(() => ''), 6500, ''),
    withTimeout(fetchTeamRanking().catch(() => ''), 6500, ''),
  ]);
  const pulledAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return [
    `CS短报 | ${pulledAt}`,
    compactBriefBlock('当前/即将比赛', matches, 700),
    compactBriefBlock('最近赛果', results, 650),
    compactBriefBlock('排名快照', ranking, 500),
    '机器短评：实时东西会变，开喷前先看来源时间，别拿旧数据硬打新版本。',
  ].join('\n\n');
}

function buildSceneTemplate(query: string): string {
  const line = getRandomKnowledgeLine('scene', query) || getRandomKnowledgeLine('style', query);
  if (!line) return '场景库暂时没货。把授权切片笔记放 knowledge/inbox/，再用 /kb ingest 进候选。';
  const blueprint = sceneBlueprintFor(query, line);
  const topic = query.trim() || blueprint.label;
  return [
    `直播场景 | ${topic}`,
    `触发：${blueprint.trigger}`,
    `反应：${blueprint.reaction}`,
    `判断：${blueprint.judgment}`,
    `短句：${blueprint.shortLines.join(' / ')}`,
    `素材：${line}`,
    '禁用：不要当逐字原话；不要长段复述；事实、赛果、阵容、转会先看实时来源。',
  ].join('\n');
}

interface SceneBlueprint {
  label: string;
  trigger: string;
  reaction: string;
  judgment: string;
  shortLines: string[];
}

function normalizeSceneQuery(input: string): string {
  return input.toLowerCase().replace(/^\//, '').replace(/\s+/g, '').replace(/[：:，。！？!?、,.]/g, '');
}

function sceneBlueprintFor(query: string, sourceLine: string): SceneBlueprint {
  const text = `${normalizeSceneQuery(query)} ${normalizeSceneQuery(sourceLine)}`;
  if (/礼物|老板|gift|舰长|醒目|sc|superchat/.test(text)) {
    return {
      label: '礼物感谢',
      trigger: '群友送礼、连送或大额礼物，需要先点名感谢，再接一个 CS 经济梗。',
      reaction: '先短感谢，不谄媚；数量多再抬强度，最后轻轻玩梗收住。',
      judgment: '这是拟态感谢模板，不说成现实直播原话，也不假装平台真的收款。',
      shortLines: ['老板大气', '这波经济补上了', '火力支援到了'],
    };
  }
  if (/白给|送|eco|经济|强起|保枪/.test(text)) {
    return {
      label: '经济局白给',
      trigger: '经济劣势、单走送枪、补枪距离断，或者优势方打成逐个白给。',
      reaction: '第一句先压住“这波不对劲”，第二句点出送在哪，第三句给可执行判断。',
      judgment: '穷不是白给的理由；短枪要靠道具和补枪，优势方也别一个人开香槟。',
      shortLines: ['先别急', '这枪送得太干脆了', '穷不是白给的理由'],
    };
  }
  if (/残局|clutch|1v|一打|回防|拆包|下包/.test(text)) {
    return {
      label: '残局处理',
      trigger: '1vX、回防、时间压力、假拆真拉、包点信息不完整。',
      reaction: '先报人数和时间，再说信息差，最后评价这波是纪律赢还是操作硬抬。',
      judgment: '残局别急着找人头，先确认包点、时间和对方可能位置。',
      shortLines: ['别急找人', '信息先拿明白', '这把靠纪律赢'],
    };
  }
  if (/道具|烟|闪|火|雷|utility|投掷|封烟/.test(text)) {
    return {
      label: '道具失误',
      trigger: '烟闪火雷没服务 timing，闪到队友，封烟反而帮对面。',
      reaction: '先说可见失误，再解释这颗道具本来该服务谁，最后给一句复盘建议。',
      judgment: '道具是好道具，人得会用；别把节目效果打成回合成本。',
      shortLines: ['这烟对面笑了', '道具是好道具', '人要会用'],
    };
  }
  if (/优势|翻盘|开香槟|被翻|逆转|comeback/.test(text)) {
    return {
      label: '优势被翻',
      trigger: '人数、经济或比分领先后开始松，补枪/清点/道具交换断掉。',
      reaction: '先提醒先别开香槟，再点出哪个环节开始不对劲，最后给回合纪律。',
      judgment: 'CS 最怕觉得稳；优势不是免死金牌，细节断一环就要还回去。',
      shortLines: ['先别开香槟', '这把开始不对劲了', '优势不是免死金牌'],
    };
  }
  if (/弹幕|嘴硬|理解|质疑|云|逆天/.test(text)) {
    return {
      label: '弹幕斗嘴',
      trigger: '群友只看比分不看回合，或者用离谱理解强行洗一波操作。',
      reaction: '先短促反问，再补一个被忽略的信息点，最后把话落回回合本身。',
      judgment: '可以嘴硬，但要讲证据；喷理解不喷现实身份。',
      shortLines: ['你认真的吗', '先看回合别只看比分', '这理解要回炉一下'],
    };
  }
  if (/选手|状态|rating|adr|新人|老将|队伍|阵容|转会|排名/.test(text)) {
    return {
      label: '选手/队伍评价',
      trigger: '聊选手状态、队伍阵容、排名、转会、角色定位或近期数据。',
      reaction: '先查实时来源，再给短判断；没证据就说变得快，别硬编。',
      judgment: '公开事实以 CS API、HLTV/Liquipedia、官方公告等来源为准，风格评价和事实分开。',
      shortLines: ['这事得看最新来源', '别让我硬编', '数据先摆出来'],
    };
  }
  if (/图片|识图|战绩图|截图|语音|听写|录音/.test(text)) {
    return {
      label: '多模态接话',
      trigger: '群友发图、战绩截图或语音消息，需要按实际可见/听写内容回复。',
      reaction: '先说看见或听写到什么；看不清、没听写就直说，不补不存在的细节。',
      judgment: '多模态只按真实输入说话，截图数据和语音内容都要留边界。',
      shortLines: ['我看图里是', '这块看不清', '听写到的是这个'],
    };
  }
  if (/身份|本人|授权|bot|机器人|ai/.test(text)) {
    return {
      label: '身份边界',
      trigger: '群友问是不是本人、是不是机器人、是否代表现实主播。',
      reaction: '日常轻嘴硬带过；明确追问本人/授权/代表性时说明这是群 bot。',
      judgment: '学的是直播反应节奏和 CS 话题知识，不冒充现实本人。',
      shortLines: ['你管我是不是', '接着说事', '不代表本人表态'],
    };
  }
  return {
    label: '随机场景',
    trigger: '弹幕抛来一个话题，需要先接情绪，再给一句具体判断。',
    reaction: '少铺垫，先抓最关键的信息点；能查实时就查，不能查就留边界。',
    judgment: '像直播间接话，不像背模板；一句玩梗后必须回到事实或操作判断。',
    shortLines: ['这波有说法', '先别急', '我看这事不简单'],
  };
}

function dailyCardImagePlan(card: DailyCard): string {
  const parts: string[] = [];
  if (card.liquipediaPage) parts.push('Liquipedia队伍图');
  if (card.fandomFile) parts.push('Counter-Strike Wiki/Fandom');
  if (card.playerImageFallback) parts.push(`代表选手${card.playerImageFallback}`);
  if (card.image) parts.push('静态真实图URL');
  return parts.length > 0
    ? `图源：${parts.join(' -> ')}；全失败才本地签位卡`
    : '图源：Counter-Strike Wiki/Fandom；全失败才本地签位卡';
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

function isCsImageCommand(command: string | null, rawText: string): boolean {
  if (['csimage', 'csimg', 'cs图', '图片测试'].includes(command || '')) return true;
  return /^(?:\/)?(?:csimage|csimg|cs图|图片测试)/.test(normalizeDrawText(rawText));
}

function normalizeCsImageKind(input: string): CsImageProbeKind {
  const text = normalizeDrawText(input || '');
  if (/^(all|全部|全量|所有)$/.test(text)) return 'all';
  if (/^(player|选手|csplayer|今日选手)$/.test(text)) return 'player';
  if (/^(team|队伍|战队|csteam|今日队伍|今日战队)$/.test(text)) return 'team';
  if (/^(map|地图|csmap|今日地图)$/.test(text)) return 'map';
  if (/^(weapon|gun|枪|武器|枪械|csweapon|今日武器)$/.test(text)) return 'weapon';
  if (/^(role|position|定位|位置|csrole|今日定位)$/.test(text)) return 'role';
  if (/^(loadout|pack|套餐|套装|今日cs|csloadout)$/.test(text)) return 'loadout';
  if (/^(utility|nade|道具|投掷物|csutility)$/.test(text)) return 'utility';
  if (/^(tactic|strat|战术|cstactic)$/.test(text)) return 'tactic';
  if (/^(clutch|残局|csclutch)$/.test(text)) return 'clutch';
  return 'team';
}

function cardsForImageKind(kind: CsImageProbeKind): DailyCard[] {
  if (kind === 'team') return csTeams;
  if (kind === 'map') return csMaps;
  if (kind === 'weapon') return csWeapons;
  if (kind === 'role') return csRoles;
  if (kind === 'loadout') return csTeams;
  if (kind === 'utility') return csUtilities;
  if (kind === 'tactic') return csTactics;
  if (kind === 'clutch') return csClutches;
  return [];
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

function isCsTrainingRequest(command: string | null, rawText: string): boolean {
  if (['cstrain', 'cstraining', 'cspractice', 'cs训练', '练枪任务', '练枪计划'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text || /(语音|声音|克隆|朗读|tts|stt)/.test(text)) return false;
  if ([
    '今日cs训练',
    '每日cs训练',
    '今天cs训练',
    '今日cs2训练',
    '每日cs2训练',
    '今天怎么练枪',
    '今天练什么枪',
    '今天练什么道具',
    '来个cs训练',
    '来个练枪任务',
    '给我安排cs训练',
    'cs训练计划',
    'cs练枪计划',
    '练枪任务',
  ].includes(text)) return true;
  const hasDailyIntent = /(今日|每日|今天|本日|来个|安排|给我)/.test(text);
  const hasTrainingIntent = /(cs训练|cs2训练|练枪|练道具|训练计划|练习计划|道具练习)/.test(text);
  return hasDailyIntent && hasTrainingIntent;
}

function isCsTrainingCommand(command: string | null): boolean {
  return ['cstrain', 'cstraining', 'cspractice', 'cs训练', '练枪任务', '练枪计划'].includes(command || '');
}

function isCsQuizRequest(command: string | null, rawText: string): boolean {
  if (['csquiz', 'cschallenge', 'cs小考', 'cs考题', 'cs问答', 'cs挑战', '今日cs题', '每日cs题'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text || /(语音|声音|克隆|朗读|tts|stt)/.test(text)) return false;
  if ([
    'csquiz',
    'cschallenge',
    'cs小考',
    'cs2小考',
    'cs考题',
    'cs2考题',
    'cs问答',
    'cs2问答',
    'cs挑战',
    'cs2挑战',
    '今日cs题',
    '每日cs题',
    '今日cs小考',
    '每日cs小考',
    '今日cs问答',
    '每日cs问答',
    '今天cs小考',
    '今天cs考题',
    '今天cs问答',
    '今天考我cs',
    '今天cs考我',
    '来个cs问答',
    '来个cs小考',
    '来个cs挑战',
    '给我来个cs题',
  ].includes(text)) return true;
  const hasDailyIntent = /(今日|每日|今天|本日|来个|给我|考我|挑战|小考)/.test(text);
  const hasQuizIntent = /(cs小考|cs2小考|cs题|cs2题|cs考题|cs2考题|cs问答|cs2问答|cs挑战|cs2挑战|cs答题|cs2答题|cs考我|cs2考我)/.test(text);
  return hasDailyIntent && hasQuizIntent;
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

function shortUrl(url: string): string {
  return url.length > 96 ? `${url.slice(0, 92)}...` : url;
}

async function buildImageCandidates(url?: string, fallbackPlayerNick?: string, fallbackCard?: DailyCard): Promise<ImageCandidate[]> {
  const candidateUrls: ImageCandidate[] = [];

  if (fallbackCard?.liquipediaPage) {
    try {
      const dynamicUrl = await Promise.race([
        teamImageResolver(fallbackCard.liquipediaPage, fallbackCard.name),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (dynamicUrl) {
        candidateUrls.push({
          url: dynamicUrl,
          label: `${fallbackCard.name}/team-dynamic`,
          source: 'liquipedia-team',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${fallbackCard.name} Liquipedia队伍图解析失败:`, err instanceof Error ? err.message : err);
    }
  }

  if (fallbackCard?.fandomFile) {
    try {
      const fandomUrl = await Promise.race([
        fandomImageResolver(fallbackCard.fandomFile),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (fandomUrl) {
        candidateUrls.push({
          url: fandomUrl,
          label: `${fallbackCard.name}/fandom-file`,
          source: 'fandom-file',
        });
      }
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
          playerImageResolver(representative.nick),
          new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]);
        if (dynamicUrl) {
          candidateUrls.push({
            url: dynamicUrl,
            label: `${fallbackCard.name}/${representative.nick}-fallback-dynamic`,
            source: 'representative-player-dynamic',
          });
        }
      } catch (err) {
        console.warn(`[fun] ${fallbackCard.name} 代表选手图动态解析失败:`, err instanceof Error ? err.message : err);
      }
      candidateUrls.push({
        url: representative.image,
        label: `${fallbackCard.name}/${representative.nick}-fallback-static`,
        source: 'representative-player-static',
      });
    }
  }

  if (fallbackPlayerNick) {
    try {
      const dynamicUrl = await Promise.race([
        playerImageResolver(fallbackPlayerNick),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (dynamicUrl) {
        candidateUrls.push({
          url: dynamicUrl,
          label: `${fallbackPlayerNick}/player-dynamic`,
          source: 'liquipedia-player',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${fallbackPlayerNick} Liquipedia动态查图失败:`, err instanceof Error ? err.message : err);
    }
  }

  if (url) {
    candidateUrls.push({
      url,
      label: fallbackPlayerNick || fallbackCard?.name || url,
      source: 'static-url',
    });
  }

  const seen = new Set<string>();
  return candidateUrls.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function probeImageCandidates(title: string, candidates: ImageCandidate[], fallbackCard?: DailyCard, score?: number): Promise<MessageSegment[]> {
  const lines = [
    `CS真实图片测试 | ${title}`,
    `候选真实图: ${candidates.length}`,
  ];
  let image: MessageSegment | null = null;
  for (const candidate of candidates.slice(0, 8)) {
    const dataUrl = await tryImageDataUrl(candidate.url, candidate.label);
    if (dataUrl) {
      lines.push(`OK ${candidate.source} ${candidate.label}`);
      lines.push(shortUrl(candidate.url));
      if (!image) image = imageDataUrlToSegment(dataUrl);
      break;
    }
    lines.push(`FAIL ${candidate.source} ${candidate.label}`);
  }
  if (!image && fallbackCard) {
    lines.push('LOCAL fallback 本地签位卡兜底；这不是外部真实图。');
    image = localDailyCardImage(fallbackCard, score);
  }
  const stats = getCacheStats();
  if (!image && stats.lastError) lines.push(`最近错误: ${stats.lastError}`);
  return [
    { type: 'text', data: { text: lines.join('\n') } },
    ...(image ? [image] : []),
  ];
}

async function probeDailyCard(kind: CsImageProbeKind, userId: number, scopeId: number): Promise<MessageSegment[]> {
  if (kind === 'player') {
    const player = dailyPlayerFor(userId, scopeId);
    const candidates = await buildImageCandidates(player.image, player.nick);
    return probeImageCandidates(`今日选手 ${player.nick}`, candidates);
  }
  if (kind === 'all') {
    const kinds: CsImageProbeKind[] = ['player', 'team', 'map', 'weapon', 'role', 'utility', 'tactic', 'clutch'];
    const lines = ['CS真实图片批量测试'];
    for (const item of kinds) {
      if (item === 'player') {
        const player = dailyPlayerFor(userId, scopeId);
        const candidates = await buildImageCandidates(player.image, player.nick);
        let ok = false;
        for (const candidate of candidates.slice(0, 4)) {
          if (await tryImageDataUrl(candidate.url, candidate.label)) {
            ok = true;
            lines.push(`OK player ${player.nick} -> ${candidate.source}`);
            break;
          }
        }
        if (!ok) lines.push(`FAIL player ${player.nick}`);
        continue;
      }
      const cards = cardsForImageKind(item);
      const card = dailyCardFor(`cs${item}`, userId, scopeId, cards);
      const candidates = await buildImageCandidates(card.image, undefined, card);
      let ok = false;
      for (const candidate of candidates.slice(0, 4)) {
        if (await tryImageDataUrl(candidate.url, candidate.label)) {
          ok = true;
          lines.push(`OK ${item} ${card.name} -> ${candidate.source}`);
          break;
        }
      }
      if (!ok) lines.push(`FAIL ${item} ${card.name}`);
    }
    const stats = getCacheStats();
    lines.push(`图片缓存: ${stats.count}/${stats.maxFiles} 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures}`);
    if (stats.lastError) lines.push(`最近错误: ${stats.lastError}`);
    return [{ type: 'text', data: { text: lines.join('\n') } }];
  }
  const cards = cardsForImageKind(kind);
  const card = dailyCardFor(kind === 'loadout' ? 'csteam_pack' : `cs${kind}`, userId, scopeId, cards);
  const score = dailyScoreForKind(kind === 'loadout' ? 'csloadout' : `cs${kind}`, userId, scopeId);
  const candidates = await buildImageCandidates(card.image, undefined, card);
  return probeImageCandidates(`${card.title} ${card.name}`, candidates, card, score);
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

  const candidateUrls = await buildImageCandidates(url, fallbackPlayerNick, fallbackCard);

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

  if (fallbackPlayerNick) {
    console.log(`[fun] ${fallbackPlayerNick} 使用本地选手签位卡兜底`);
    return [localDailyCardImage({
      key: `player-${fallbackPlayerNick}`,
      title: '今日CS选手',
      name: fallbackPlayerNick,
      subtitle: '外部真实图源暂时失败，先给签位卡兜底',
      scoreLabel: '签位',
      advice: '真实图源恢复后会自动优先发外部图片。',
      avoid: '别把本地卡当真实头像。',
      line: '图没拉下来，但签不能断。',
      imageLabel: fallbackPlayerNick,
    }, score)];
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
    message.push(...await imageSegmentOrNote(player.image, player.nick, undefined, score));
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

const csQuizKinds: CsQuizKind[] = ['map', 'weapon', 'utility', 'tactic', 'clutch'];

function quizScoreLine(score: number): string {
  if (score >= 90) return '题感爆棚';
  if (score >= 75) return '理解在线';
  if (score >= 55) return '正常发挥';
  if (score >= 35) return '先别嘴硬';
  return '今天补课';
}

function quizOptionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

function finalizeCsQuiz(quiz: CsQuiz, userId: number, scopeId: number): CsQuiz {
  const ranked = quiz.options
    .map((option, index) => ({
      option,
      originalIndex: index,
      rank: dailySeedForKind(`csquiz_option_${quiz.kind}_${index}`, userId, scopeId),
    }))
    .sort((a, b) => a.rank - b.rank || a.originalIndex - b.originalIndex);
  const correctOptionIndex = ranked.findIndex((item) => item.originalIndex === quiz.correctOptionIndex);
  const correctLabel = quizOptionLabel(correctOptionIndex >= 0 ? correctOptionIndex : 0);
  const answer = /^选\s*[A-Z一二三123][。.．,，:：\s]*/i.test(quiz.answer)
    ? quiz.answer.replace(/^选\s*[A-Z一二三123][。.．,，:：\s]*/i, `选 ${correctLabel}。`)
    : `选 ${correctLabel}。${quiz.answer}`;
  return {
    ...quiz,
    options: ranked.map((item) => item.option),
    correctOptionIndex: correctOptionIndex >= 0 ? correctOptionIndex : 0,
    answer,
  };
}

function normalizeCsQuizChoice(input: string): number | null {
  const text = normalizeDrawText(input || '');
  if (!text) return null;
  const match = text.match(/^(?:answer|ans|check|答案|答题|提交|选择|选)?([abc123一二三])$/i);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (token === 'a' || token === '1' || token === '一') return 0;
  if (token === 'b' || token === '2' || token === '二') return 1;
  if (token === 'c' || token === '3' || token === '三') return 2;
  return null;
}

function parseCsQuizAnswerArgs(args: string[]): number | null {
  if (args.length === 0) return null;
  const first = (args[0] || '').toLowerCase();
  const rest = ['answer', 'ans', 'check', 'submit', 'choose', '答', '答案', '答题', '提交', '选择', '选'].includes(first)
    ? args.slice(1)
    : args;
  return normalizeCsQuizChoice(rest.join(' '));
}

function isCsQuizAnswerArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = (args[0] || '').toLowerCase();
  return ['answer', 'ans', 'check', 'submit', 'choose', '答', '答案', '答题', '提交', '选择', '选'].includes(first)
    || parseCsQuizAnswerArgs(args) !== null;
}

function formatCsQuizAnswer(userId: number, scopeId: number, args: string[]): string {
  const quiz = dailyCsQuizFor(userId, scopeId);
  const choiceIndex = parseCsQuizAnswerArgs(args);
  const choices = quiz.options.map((option, index) => `${quizOptionLabel(index)}. ${option}`).join(' / ');
  if (choiceIndex === null || choiceIndex < 0 || choiceIndex >= quiz.options.length) {
    return [
      `今日CS小考判分 | ${todayKey()}`,
      `题型：${quiz.title}`,
      `题目：${quiz.question}`,
      `选项：${choices}`,
      '用法：/csquiz answer A  或  /csquiz 答 B',
      '真话边界：这是本地每日小考，不是实时赛事事实；问赛程/赛果用 /cs brief。',
    ].join('\n');
  }
  const correct = choiceIndex === quiz.correctOptionIndex;
  const choiceLabel = quizOptionLabel(choiceIndex);
  const correctLabel = quizOptionLabel(quiz.correctOptionIndex);
  return [
    `今日CS小考判分 | ${todayKey()}`,
    `题型：${quiz.title}`,
    `你的选择：${choiceLabel}. ${quiz.options[choiceIndex]}`,
    `结果：${correct ? '对了，有点东西' : '不对，先别嘴硬'}`,
    `正确参考：${correctLabel}. ${quiz.options[quiz.correctOptionIndex]}`,
    `解析：${quiz.answer}`,
    `机器短评：${correct ? '这波理解在线，下一把别开香槟。' : quiz.comment}`,
    '继续：/csquiz 看今日题面；/cstrain 按这个短板练一组。',
    '真话边界：这是本地每日小考，不是实时赛事事实；问赛程/赛果用 /cs brief。',
  ].join('\n');
}

function dailyCsQuizFor(userId: number, scopeId: number): CsQuiz {
  const kind = csQuizKinds[dailySeedForKind('csquiz_kind', userId, scopeId) % csQuizKinds.length];
  const player = dailyPlayerFor(userId, scopeId);
  const map = dailyCardFor('csquiz_map', userId, scopeId, csMaps);
  const weapon = dailyCardFor('csquiz_weapon', userId, scopeId, csWeapons);
  const role = dailyCardFor('csquiz_role', userId, scopeId, csRoles);
  const utility = dailyCardFor('csquiz_utility', userId, scopeId, csUtilities);
  const tactic = dailyCardFor('csquiz_tactic', userId, scopeId, csTactics);
  const clutch = dailyCardFor('csquiz_clutch', userId, scopeId, csClutches);
  const score = dailyScoreForKind('csquiz', userId, scopeId);
  const comment = score >= 80
    ? `这题不难，${player.nick}签给你加点理解分，但别答完就开香槟。`
    : score >= 45
      ? `能答，关键是别只会喊枪软，要把回合目的说清楚。`
      : `今天先补基本功，别急着当解说，先把选项看完。`;

  if (kind === 'map') {
    return finalizeCsQuiz({
      kind,
      title: '地图决策',
      context: `${map.name} / ${utility.name}`,
      question: `今天抽到 ${map.name}，开局默认最该先服务哪件事？`,
      options: [
        `用${utility.name}先拿关键区域信息，再决定提速还是控图`,
        '不等道具直接干拉，赢了就是天才，输了怪队友',
        '五个人各玩各的，等对面自己送一波大的',
      ],
      correctOptionIndex: 0,
      answer: `选 A。${map.advice} ${utility.advice}`,
      comment,
      score,
    }, userId, scopeId);
  }

  if (kind === 'weapon') {
    return finalizeCsQuiz({
      kind,
      title: '枪械定位',
      context: `${weapon.name} / ${role.name}`,
      question: `今天主枪是 ${weapon.name}，搭配 ${role.name}，最怕犯哪种错？`,
      options: [
        '按定位打交换和补枪距离，先把回合打完整',
        '枪好就单摸找镜头，队友在哪不重要',
        '经济不够也硬起当大哥，反正节目效果拉满',
      ],
      correctOptionIndex: 0,
      answer: `选 A。${weapon.advice} ${role.advice}`,
      comment,
      score,
    }, userId, scopeId);
  }

  if (kind === 'utility') {
    return finalizeCsQuiz({
      kind,
      title: '道具时机',
      context: `${map.name} / ${utility.name}`,
      question: `${map.name} 上要用 ${utility.name}，丢之前最该先问自己什么？`,
      options: [
        '这颗道具服务谁、服务哪个 timing、队友能不能接上',
        '先扔了再说，反正包里有道具不用白不用',
        '闪到队友也没事，回头说一句“我尽力了”',
      ],
      correctOptionIndex: 0,
      answer: `选 A。${utility.advice} 道具不是摆设，目的和配合要先讲明白。`,
      comment,
      score,
    }, userId, scopeId);
  }

  if (kind === 'tactic') {
    return finalizeCsQuiz({
      kind,
      title: '战术选择',
      context: `${map.name} / ${tactic.name}`,
      question: `今天战术签是「${tactic.name}」，开局最该统一什么？`,
      options: [
        '默认、交换距离和第一颗关键道具，先把节奏说清楚',
        '开局五人静音各玩各的，输了就说对面太准',
        '每回合都提速一波，反正慢下来就不像节目效果',
      ],
      correctOptionIndex: 0,
      answer: `选 A。${tactic.advice} 地图是 ${map.name}，别把战术打成散步。`,
      comment,
      score,
    }, userId, scopeId);
  }

  return finalizeCsQuiz({
    kind,
    title: '残局判断',
    context: `${clutch.name} / ${role.name}`,
    question: `进入「${clutch.name}」局面，剩你处理关键残局，第一反应应该是什么？`,
    options: [
      '先确认时间、包点信息和可能枪位，再决定找人还是拖',
      '脚步拉满直接找人拼，打赢了就是名场面',
      '边拆边嘴硬，赌对面刚好不看包',
    ],
    correctOptionIndex: 0,
    answer: `选 A。${clutch.advice} 残局别急着证明自己，信息先拿明白。`,
    comment,
    score,
  }, userId, scopeId);
}

function buildCsQuizMessage(userId: number, scopeId: number, isPrivate: boolean): MessageSegment[] {
  const quiz = dailyCsQuizFor(userId, scopeId);
  const options = quiz.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join(' / ');
  const text = [
    `今日CS小考 | ${todayKey()}`,
    `题型：${quiz.title}`,
    `场景：${quiz.context}`,
    `题感：${quiz.score}/100 ${quizScoreLine(quiz.score)}`,
    `题目：${quiz.question}`,
    `选项：${options}`,
    '参考判断：先别偷看，答完用 /csquiz answer A/B/C 看解析。',
    '答题：/csquiz answer A  或  /csquiz 答 B',
    `机器短评：${quiz.comment}`,
    '真话边界：这是本地每日小考，不是实时赛事事实；问赛程/赛果用 /cs brief。',
  ].join('\n');
  const card: DailyCard = {
    key: `csquiz-${quiz.kind}`,
    title: '今日CS小考',
    name: quiz.title,
    subtitle: quiz.context,
    scoreLabel: '题感',
    advice: '先选 A/B/C，再用 /csquiz answer 提交。',
    avoid: '别把本地小考当实时赛事结论。',
    line: quiz.comment,
  };
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(localDailyCardImage(card, quiz.score));
  return message;
}

function trainingIntensity(score: number): { label: string; warmup: number; aim: number; utility: number; review: number } {
  if (score >= 85) return { label: '上强度', warmup: 10, aim: 18, utility: 14, review: 8 };
  if (score >= 65) return { label: '正常强度', warmup: 8, aim: 15, utility: 12, review: 6 };
  if (score >= 40) return { label: '稳住手感', warmup: 6, aim: 12, utility: 10, review: 5 };
  return { label: '轻量校准', warmup: 5, aim: 10, utility: 8, review: 5 };
}

function weaponTrainingTask(weapon: DailyCard, score: number): string {
  const kills = score >= 75 ? 120 : score >= 45 ? 90 : 60;
  switch (weapon.key) {
    case 'ak47':
      return `AK急停和预瞄 ${kills} kill：前30枪只许单点/两连发，别一急就开始泼水。`;
    case 'm4a1s':
      return `M4A1-S控枪转移 ${kills} kill：每杀一个就换身位，练偷人，不练站桩。`;
    case 'awp':
      return `AWP架点反应 50枪：空枪立刻后撤换点，今天重点练“不送第二枪”。`;
    case 'deagle':
      return `沙鹰一发头 60次：只打停稳后的第一发，七发全空就别嘴硬，重来一组。`;
    case 'mp9':
      return `MP9近点横拉 ${kills} kill：只打短距离和绕后路线，别拿它和AK中远距离讲道理。`;
    case 'mac10':
      return `MAC-10第一身位 ${kills} kill：练吃闪后提速，死也要把信息和站位换出来。`;
    case 'galil':
      return `Galil压枪转移 ${kills} kill：穷哥们枪也要打干净，重点练前10发弹道。`;
    default:
      return `${weapon.name}基础枪法 ${kills} kill：急停、预瞄、补枪距离三件事别丢。`;
  }
}

function mapUtilitySet(map: DailyCard): string[] {
  const sets: Record<string, string[]> = {
    mirage: ['A点进攻烟', '拱门闪', '跳台火'],
    inferno: ['香蕉道控制火', 'CT烟', '棺材闪'],
    nuke: ['外场一线烟', '铁板火', '黄房闪'],
    ancient: ['中路烟', 'B坡火', '红房闪'],
    anubis: ['水路烟', 'A点火', '中路闪'],
    dust2: ['Xbox烟', '长门闪', 'B门烟'],
    overpass: ['厕所烟', '工地火', '长管闪'],
  };
  return sets[map.key] || ['默认进攻烟', '清点火', '回防闪'];
}

function utilityTrainingTask(map: DailyCard, utility: DailyCard, minutes: number): string {
  const [smoke, fire, flash] = mapUtilitySet(map);
  switch (utility.key) {
    case 'flash':
      return `${minutes}分钟 ${map.name} 闪光：练 ${flash}，每次先报闪再peek，连续成功8次才算过。`;
    case 'smoke':
      return `${minutes}分钟 ${map.name} 烟：练 ${smoke}，落点歪一次就重丢，别硬说是新战术。`;
    case 'molotov':
      return `${minutes}分钟 ${map.name} 火：练 ${fire}，目标是逼位移和拖时间，不是烧空气。`;
    case 'he':
      return `${minutes}分钟 ${map.name} 雷：围绕 ${fire} 做反清压血，配枪线一起给，别开局随手丢心理安慰。`;
    case 'decoy':
      return `${minutes}分钟 ${map.name} 骗信息：用诱饵配合 ${smoke} 做假动静，但别把整套战术押在诱饵上。`;
    case 'kit':
      return `${minutes}分钟 ${map.name} 回防：从两个入口各跑5次，拆包前先清 ${smoke} 附近枪位，别到包前才找钳。`;
    default:
      return `${minutes}分钟 ${map.name} 道具：烟火闪各练一颗，要求能讲清楚目的和时机。`;
  }
}

function roleTrainingTask(role: DailyCard, tactic: DailyCard, clutch: DailyCard): string {
  switch (role.key) {
    case 'entry':
      return `实战目标：突破时只记两件事，吃闪出点、死前报人数枪位；战术按「${tactic.name}」执行，别一个人开故事。`;
    case 'support':
      return `实战目标：每回合至少做一次有效补闪或补烟；残局按「${clutch.name}」复盘，镜头少不等于价值低。`;
    case 'anchor':
      return `实战目标：守点先拖5秒再想杀人；被打进点后按「${clutch.name}」练回防纪律，别脚步一响就全交。`;
    case 'lurker':
      return `实战目标：侧翼到位前少露信息；配合「${tactic.name}」抓timing，别绕到最后队友全没了。`;
    case 'igl':
      return `实战目标：开局给一个默认计划，中期只改一个重点；输回合后用「${tactic.name}」复盘原因，不要只喊枪软。`;
    case 'awper-role':
      return `实战目标：每个架点只贪一枪，空枪立刻换位；残局按「${clutch.name}」处理高价值武器。`;
    default:
      return `实战目标：围绕「${tactic.name}」打清楚交换和信息，残局用「${clutch.name}」复盘。`;
  }
}

function buildCsTrainingMessage(userId: number, scopeId: number, isPrivate: boolean, predictHint = '', historyHint = '', profileHint = ''): MessageSegment[] {
  const player = dailyPlayerFor(userId, scopeId);
  const map = dailyCardFor('cstrain_map', userId, scopeId, csMaps);
  const weapon = dailyCardFor('cstrain_weapon', userId, scopeId, csWeapons);
  const role = dailyCardFor('cstrain_role', userId, scopeId, csRoles);
  const utility = dailyCardFor('cstrain_utility', userId, scopeId, csUtilities);
  const tactic = dailyCardFor('cstrain_tactic', userId, scopeId, csTactics);
  const clutch = dailyCardFor('cstrain_clutch', userId, scopeId, csClutches);
  const score = dailyScoreForKind('cstrain', userId, scopeId);
  const intensity = trainingIntensity(score);
  const total = intensity.warmup + intensity.aim + intensity.utility + intensity.review;
  const shortNote = score >= 80
    ? '这套能上强度，但强度不是上头，练完要能说出自己改了哪一枪。'
    : score >= 45
      ? '这套正常打很够用，别练着练着开始娱乐模式。'
      : '今天先校准基本功，少硬拉，多把动作做干净。';
  const text = [
    `今日CS训练 | ${todayKey()}`,
    `参考选手：${player.nick} (${player.role})`,
    `地图/武器/定位：${map.name} / ${weapon.name} / ${role.name}`,
    `道具/战术/残局：${utility.name} / ${tactic.name} / ${clutch.name}`,
    `训练强度：${score}/100 ${intensity.label}，约${total}分钟`,
    '',
    `1. 热身 ${intensity.warmup}分钟：急停、拉枪、预瞄线先校准，别一上来就找人对喷。`,
    `2. 练枪 ${intensity.aim}分钟：${weaponTrainingTask(weapon, score)}`,
    `3. 道具 ${utilityTrainingTask(map, utility, intensity.utility)}`,
    `4. 实战 ${roleTrainingTask(role, tactic, clutch)}`,
    `5. 复盘 ${intensity.review}分钟：截3个死亡回合，只看站位、补枪距离和道具时机。`,
    predictHint ? `\n${predictHint}` : '',
    historyHint ? `\n${historyHint}` : '',
    profileHint ? `\n${profileHint}` : '',
    `机器短评：${shortNote}`,
    '真话边界：这是本地每日训练签，不是实时赛事事实；问赛程/赛果用 /cs brief。',
  ].join('\n');
  const card: DailyCard = {
    key: `cstrain-${map.key}-${weapon.key}-${role.key}`,
    title: '今日CS训练',
    name: `${map.name} / ${weapon.name}`,
    subtitle: `${role.name} / ${utility.name} / ${tactic.name}`,
    scoreLabel: '训练强度',
    advice: role.advice,
    avoid: '别练完不复盘，也别把训练签当实时数据。',
    line: shortNote,
  };
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(localDailyCardImage(card, score));
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

    // ===== /csbrief CS短报 =====
    if (ctx.command === 'csbrief' || ctx.command === 'csreport' || ctx.command === '日报' || ctx.command === '短报' || fuzzy === 'csbrief') {
      try {
        ctx.reply(await buildCsBrief());
      } catch {
        ctx.reply('CS短报拉取失败，先跑 /data 看实时数据链路。');
      }
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
        // 优先用 CS API / VRS 结构化数据，失败再搜索
        const ranking = await fetchTeamRanking();
        if (ranking) {
          ctx.reply(`🏆 CS2战队排名:\n${ranking}`);
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

    // ===== /scene 直播场景卡 =====
    if (ctx.command === 'scene' || ctx.command === '场景' || ctx.command === 'template' || fuzzy === 'scene') {
      const query = ctx.args.join(' ').trim();
      ctx.reply(buildSceneTemplate(query));
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
        '每日CS选手状态 / 图片状态',
        `选手池: ${csPlayers.length}人`,
        `队伍池: ${csTeams.length}队`,
        `地图/武器/定位/道具/战术/残局: ${csMaps.length}/${csWeapons.length}/${csRoles.length}/${csUtilities.length}/${csTactics.length}/${csClutches.length}`,
        `真实图策略: Liquipedia/Fandom/Wikimedia优先，外链全失败才发本地签位卡`,
        `队伍示例: ${csTeams.slice(0, 3).map((item) => `${item.name}(${dailyCardImagePlan(item).replace(/^图源：/, '')})`).join(' | ')}`,
        (() => {
          const liq = getLiquipediaImageStats();
          return `Liquipedia图解析: 缓存${liq.entries} 限流${liq.rateLimited ? 'yes' : 'no'}`;
        })(),
        `图片缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB`,
        `图片命中: ${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
        ...(stats.lastError ? [`最近图片错误: ${stats.lastError}`] : []),
        '',
        '/csimage test team|map|weapon|role|utility|tactic|clutch|player|all 测真实图源',
        'admin: /csprewarm 预下载所有选手图(慢，受限流影响)',
      ].join('\n'));
      return true;
    }

    if (isCsImageCommand(ctx.command, raw)) {
      const normalizedArgs = ctx.args.map((item) => item.toLowerCase()).filter((item) => item !== 'test' && item !== '测试');
      const kind = normalizeCsImageKind(normalizedArgs[0] || raw.replace(/^\/?(csimage|csimg|cs图|图片测试)/i, ''));
      const scopeId = ctx.groupId || 0;
      ctx.reply(await probeDailyCard(kind, ctx.event.user_id, scopeId));
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
    if (isCsTrainingCommand(ctx.command)) {
      const sub = (ctx.args[0] || '').toLowerCase();
      if (['analyze', 'analyse', 'diagnose', '诊断', '分析'].includes(sub)) {
        const analysis = analyzeTrainingLogInput(ctx.args.slice(1));
        if (!analysis) {
          ctx.reply(trainingCommandUsage());
          return true;
        }
        ctx.replyAt(formatCsTrainingAnalysis(analysis));
        return true;
      }
      if (['log', 'add', 'done', 'record', '记录', '打卡'].includes(sub)) {
        const parsed = parseTrainingLogInput(ctx.args.slice(1));
        if (!parsed) {
          ctx.reply(trainingCommandUsage());
          return true;
        }
        const entry = addTrainingLog(ctx, parsed);
        ctx.replyAt([
          `训练记上了：${formatTrainingLogEntry(entry)}`,
          '后面 /cstrain 会按你最近记录调建议，/cstrain stats 看趋势。',
        ].join('\n'));
        return true;
      }
      if (['stats', 'status', 'history', 'list', '记录', '统计'].includes(sub)) {
        ctx.reply(formatCsTrainingStats(ctx.chatType, ctx.chatId, ctx.event.user_id));
        return true;
      }
      if (['clear', 'reset', 'clean', '清空', '重置'].includes(sub)) {
        const removed = clearTrainingLogs(ctx.chatType, ctx.chatId, ctx.event.user_id);
        ctx.replyAt(`训练记录清掉了：${removed}条。`);
        return true;
      }
      if (['help', 'usage', '用法', '?'].includes(sub)) {
        ctx.reply(trainingCommandUsage());
        return true;
      }
    }
    if (isCsQuizRequest(ctx.command, raw) || fuzzy === 'csquiz') {
      if (isCsQuizAnswerArgs(ctx.args)) {
        const answerText = formatCsQuizAnswer(ctx.event.user_id, scopeId, ctx.args);
        if (ctx.isPrivate) ctx.reply(answerText);
        else ctx.replyAt(answerText);
        return true;
      }
      ctx.reply(buildCsQuizMessage(ctx.event.user_id, scopeId, ctx.isPrivate));
      return true;
    }
    if (isCsTrainingRequest(ctx.command, raw) || fuzzy === 'cstrain') {
      const predictHint = getCsPredictTrainingHint(ctx.chatType, ctx.chatId, ctx.event.user_id);
      const historyHint = buildCsTrainingHistoryHint(ctx.chatType, ctx.chatId, ctx.event.user_id);
      const profileHint = buildUserProfileDailyCsHint(ctx.chatType, ctx.chatId, ctx.event.user_id);
      ctx.reply(buildCsTrainingMessage(ctx.event.user_id, scopeId, ctx.isPrivate, predictHint, historyHint, profileHint));
      return true;
    }
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
  isCsTrainingRequest,
  isCsQuizRequest,
  isCsQuizAnswerArgs,
  parseCsQuizAnswerArgs,
  formatCsQuizAnswer,
  parseTrainingLogInput,
  analyzeTrainingLogInput,
  detectTrainingWeaknesses,
  buildCsTrainingHistoryHint,
  formatCsTrainingAnalysis,
  formatCsTrainingStats,
  loadTrainingStore,
  buildCsPlayerMessage,
  buildDailyCardMessage,
  buildLoadoutMessage,
  buildCsTrainingMessage,
  dailyCsQuizFor,
  buildCsQuizMessage,
  __setTrainingStorePathForTests: (filepath?: string) => {
    trainingStorePathOverride = filepath || '';
  },
  __setImageResolverForTests: (resolver?: (url: string) => Promise<string | null>) => {
    imageDataUrlResolver = resolver || getImageDataUrl;
  },
  __setImageSourceResolversForTests: (resolvers?: {
    player?: (player: string) => Promise<string | null>;
    team?: (page: string, teamName: string) => Promise<string | null>;
    fandom?: (filename: string) => Promise<string | null>;
  }) => {
    playerImageResolver = resolvers?.player || resolvePlayerImage;
    teamImageResolver = resolvers?.team || resolveTeamImage;
    fandomImageResolver = resolvers?.fandom || resolveFandomFileImage;
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
