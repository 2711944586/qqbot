import * as fs from 'fs';
import * as path from 'path';
import { MessageSegment, Plugin, PluginContext } from '../types';
import { getRandomKnowledgeLine } from './knowledge-base';
import { getCacheStats, getImageDataUrl } from './image-cache';
import { webSearch } from './web-search';
import { fetchOngoingMatches, fetchTeamRanking, fetchRecentResults } from './hltv-api';
import { detectFuzzyCommand } from './fuzzy-command';
import { getLiquipediaImageStats, resolvePlayerImage, resolveTeamImage } from './liquipedia-image';
import { resolveFandomFileImage, resolveFandomPageImage } from './fandom-image';
import { getCsgoSkinsApiStats, resolveCsgoSkinImage } from './csgo-skins-api';
import { buildDailyCardImageDataUrl } from './daily-card-image';
import { getCsPredictTrainingHint } from './cs-predict';
import { buildUserProfileDailyCsHint } from './user-profile';
import {
  type AuthorizedImageManifestCard,
  clearImageManifestCache,
  compactManifestValue,
  getImageManifestSignature,
  getImageManifestCacheStats,
  loadImageManifest,
  loadImageManifestByKinds,
} from './authorized-image-manifest';

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
  fandomPage?: string;
}

type DailyCardKind = 'team' | 'map' | 'weapon' | 'skin' | 'role' | 'loadout' | 'utility' | 'tactic' | 'clutch';
type CsQuizKind = 'map' | 'weapon' | 'utility' | 'tactic' | 'clutch';
type CsImageProbeKind = DailyCardKind | 'player' | 'knife' | 'mokoko' | 'genshin' | 'all';
type TrainingArea = 'aim' | 'utility' | 'map' | 'role' | 'clutch' | 'review' | 'match';
type TrainingWeaknessKey = 'death' | 'trade' | 'utility' | 'aim' | 'clutch' | 'map' | 'review';

type FandomWiki = 'counterstrike' | 'bandori' | 'genshin';

const DAILY_BEAUTY_MIN_IMAGES_PER_ITEM = 200;
const DAILY_IMAGE_CANDIDATE_LIMIT = 200;
const DAILY_BEAUTY_MATCH_CACHE_MAX = 6000;

interface SkinCard extends DailyCard {
  weapon: string;
  rarity: string;
}

interface KnifeCard extends DailyCard {
  aliases: string[];
  skinFilePrefixes: string[];
}

interface DailyCharacter {
  key: string;
  title: string;
  name: string;
  band: 'MyGO!!!!!' | 'Ave Mujica';
  role: string;
  voice: string;
  note: string;
  page: string;
  file?: string;
}

interface DailyGenshinCharacter {
  key: string;
  title: string;
  name: string;
  page: string;
  note: string;
  tag: string;
}

interface DailyTextCard {
  key: string;
  title: string;
  name: string;
  subtitle: string;
  body: string;
  advice: string;
  line: string;
  scoreLabel: string;
}

interface DailyDuelWeapon {
  key: string;
  name: string;
  style: string;
  power: number;
  tempo: number;
  line: string;
  image?: string;
  fandomFile?: string;
}

type BestdoriCardImage = AuthorizedImageManifestCard;

interface DailyImageManifestTarget {
  kind: string;
  label: string;
  count: number;
  ok: boolean;
  minImages: number;
  fields: Record<string, string>;
  tags: string[];
}

interface ImageCandidate {
  url: string;
  label: string;
  source:
    | 'liquipedia-team'
    | 'csgo-api-skin'
    | 'fandom-page'
    | 'fandom-file'
    | 'representative-player-dynamic'
    | 'representative-player-static'
    | 'liquipedia-player'
    | 'bestdori-card'
    | 'authorized-image'
    | 'static-url';
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
let fandomImageResolver: (filename: string, wiki?: FandomWiki) => Promise<string | null> = resolveFandomFileImage;
let fandomPageImageResolver: (title: string, wiki?: FandomWiki) => Promise<string | null> = resolveFandomPageImage;
let csgoSkinImageResolver: (weapon: string, skin: string) => Promise<string | null> = resolveCsgoSkinImage;

const csPlayers: CSPlayer[] = [
  { nick: 'ZywOo', name: 'Mathieu Herbaut', team: 'Vitality', role: 'AWPer / 核心大哥', note: '今天就按这个纪律打，枪硬但别急着开香槟。', image: 'https://liquipedia.net/commons/images/2/2b/ZywOo_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia', aliases: ['载物'] },
  { nick: 's1mple', name: 'Oleksandr Kostyliev', team: 'NAVI / Falcons 语境', role: 'AWPer / 巨星位', note: '手感上来就是不讲道理，但别学他每一波都想当主角。', image: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Oleksandr_s1mple_Kostyliev_%28cropped%29.jpg', imageSource: 'wikimedia', aliases: ['森破'] },
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

csPlayers.push(
  { nick: 'bLitz', name: 'Garidmagnai Byambasuren', team: 'The MongolZ', role: 'IGL / Rifler', note: '蒙古指挥签，今天别乱，第一波交换要清楚。', image: 'https://liquipedia.net/commons/images/3/30/The_MongolZ_2023_allmode.png', imageSource: 'liquipedia' },
  { nick: '910', name: 'Usukhbayar Banzragch', team: 'The MongolZ', role: 'AWPer', note: '亚洲狙签，先架住关键枪，别急着换位置找节目。', image: 'https://liquipedia.net/commons/images/3/30/The_MongolZ_2023_allmode.png', imageSource: 'liquipedia' },
  { nick: 'Techno4K', name: 'Sodbayar Munkhbold', team: 'The MongolZ', role: 'Rifler', note: '正面枪男签，今天可以硬，但补枪距离别断。', image: 'https://liquipedia.net/commons/images/3/30/The_MongolZ_2023_allmode.png', imageSource: 'liquipedia' },
  { nick: 'somebody', name: 'Haowen Xu', team: 'TYLOO', role: 'Rifler', note: '中国CS老熟人签，枪可以敢开，残局别急。', image: 'https://liquipedia.net/commons/images/2/2f/TYLOO_2019_allmode.png', imageSource: 'liquipedia' },
  { nick: 'JamYoung', name: 'Yi Yang', team: 'TYLOO / 中国CS语境', role: 'Rifler', note: '年轻火力签，别只打自信枪，回合目标要跟上。', image: 'https://liquipedia.net/commons/images/2/2f/TYLOO_2019_allmode.png', imageSource: 'liquipedia' },
  { nick: 'Westmelon', name: 'Qinghui Liu', team: 'Lynn Vision', role: 'Rifler', note: 'LVG火力签，今天正面别怂，但别让队形散。', image: 'https://liquipedia.net/commons/images/0/0a/Lynn_Vision_Gaming_2023_allmode.png', imageSource: 'liquipedia' },
  { nick: 'Jame', name: 'Dzhami Ali', team: 'Virtus.pro', role: 'AWPer / IGL', note: 'Jame Time签，保枪可以，前提是你真算明白了。', image: 'https://liquipedia.net/commons/images/1/12/Jame_at_IEM_Katowice_2024.jpg', imageSource: 'liquipedia' },
  { nick: 'torzsi', name: 'Adam Torzsas', team: 'MOUZ', role: 'AWPer', note: 'MOUZ狙签，今天稳住第一枪，空了就换点。', image: 'https://liquipedia.net/commons/images/b/b7/Torzsi_at_IEM_Dallas_2024.jpg', imageSource: 'liquipedia' },
  { nick: 'xertioN', name: 'Dorian Berman', team: 'MOUZ', role: 'Rifler / Entry', note: '第一身位签，敢打没问题，死前信息要给满。', image: 'https://liquipedia.net/commons/images/e/e1/XertioN_at_PGL_Copenhagen_2024_EU_RMR_A.jpg', imageSource: 'liquipedia' },
  { nick: 'iM', name: 'Ivan Mihai', team: 'NAVI', role: 'Rifler', note: 'NAVI步枪签，少乱拉，多补枪，关键局别掉线。', image: 'https://liquipedia.net/commons/images/6/69/IM_at_BLAST_Open_Spring_2026.jpg', imageSource: 'liquipedia' },
  { nick: 'zont1x', name: 'Myroslav Plakhotia', team: 'Team Spirit', role: 'Rifler / Anchor', note: '年轻锚点签，今天别急着前压，包点站住就是价值。', image: 'https://liquipedia.net/commons/images/5/58/Zont1x_at_BLAST_Bounty_Winter_2026.jpg', imageSource: 'liquipedia', aliases: ['zontix'] },
);

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

csTeams.push(
  { key: 'astralis', title: '今日CS队伍', name: 'Astralis', subtitle: '丹麦体系 / 纪律和地图理解', scoreLabel: '签位强度', advice: '今天少拼嗓门，多把交叉火力和道具顺序打明白。', avoid: '别把体系打成排队单挑。', line: 'Astralis签就是老派味，细节不够就露馅。', liquipediaPage: 'Astralis', playerImageFallback: 'dev1ce' },
  { key: 'furia', title: '今日CS队伍', name: 'FURIA', subtitle: '巴西进攻性 / 节奏压迫', scoreLabel: '签位强度', advice: '主动没问题，但第二时间补枪一定要跟上。', avoid: '别把快节奏打成快送。', line: 'FURIA签有火，但火别烧到自己。', liquipediaPage: 'FURIA Esports', playerImageFallback: 'KSCERATO' },
  { key: 'mongolz', title: '今日CS队伍', name: 'The MongolZ', subtitle: '亚洲强队 / 枪法和韧性', scoreLabel: '签位强度', advice: '正面别虚，残局别急，交换距离打近一点。', avoid: '别优势局一松就把节奏还回去。', line: '蒙古签抽到，今天别先认怂。', liquipediaPage: 'The MongolZ', playerImageFallback: 'bLitz' },
  { key: 'virtuspro', title: '今日CS队伍', name: 'Virtus.pro', subtitle: '慢控和纪律 / Jame Time语境', scoreLabel: '签位强度', advice: '慢可以，但慢要拿信息，不是原地发呆。', avoid: '别保枪保到队友心态先没。', line: 'VP签就是耐心测试，急的人先出局。', liquipediaPage: 'Virtus.pro', playerImageFallback: 'electroNic' },
  { key: 'eternal-fire', title: '今日CS队伍', name: 'Eternal Fire', subtitle: '土耳其火力 / 正面爆发', scoreLabel: '签位强度', advice: '第一枪要硬，回合纪律也得跟上。', avoid: '别只剩爆头线，没有回合计划。', line: '土耳其签一出来，正面压力直接拉满。', liquipediaPage: 'Eternal Fire', playerImageFallback: 'XANTARES', image: 'https://eternalfire.gg/wp-content/uploads/2022/10/eflogowhite.png' },
  { key: 'aurora', title: '今日CS队伍', name: 'Aurora', subtitle: '东欧枪男 / 节奏切换', scoreLabel: '签位强度', advice: '用枪法撬开局面，但中期别断信息链。', avoid: '别打着打着全队变单排。', line: 'Aurora签有锐度，别锐到没队友。', liquipediaPage: 'Aurora Gaming', playerImageFallback: 'woxic' },
  { key: 'heroic', title: '今日CS队伍', name: 'HEROIC', subtitle: '体系重建 / 信息和补枪', scoreLabel: '签位强度', advice: '今天别散，第一波交换和道具目的先讲清楚。', avoid: '别每个回合都像临时拼车。', line: 'HEROIC签要的是队形，不是各自精彩。', liquipediaPage: 'HEROIC', playerImageFallback: 'cadiaN' },
  { key: '3dmax', title: '今日CS队伍', name: '3DMAX', subtitle: '法国体系 / 冲击强队位', scoreLabel: '签位强度', advice: '把默认控图打扎实，别让对面免费拿首杀。', avoid: '别一到强队局就先自乱阵脚。', line: '3DMAX签不花，但要打得硬。', liquipediaPage: '3DMAX', playerImageFallback: 'apEX' },
  { key: 'pain', title: '今日CS队伍', name: 'paiN Gaming', subtitle: '巴西韧性 / 中期决策', scoreLabel: '签位强度', advice: '正面要敢换，残局要慢算时间。', avoid: '别优势人数还一个个送。', line: 'paiN签像名字一样，急了就疼。', liquipediaPage: 'paiN Gaming', playerImageFallback: 'coldzera' },
  { key: 'tyloo', title: '今日CS队伍', name: 'TYLOO', subtitle: '中国CS老牌 / 节奏和枪感', scoreLabel: '签位强度', advice: '枪要敢开，补枪距离别拉散。', avoid: '别开局想太多，中期又没人说话。', line: 'TYLOO签抽到，今天给点中国CS信仰分。', liquipediaPage: 'TYLOO', playerImageFallback: 'somebody' },
  { key: 'lynnvision', title: '今日CS队伍', name: 'Lynn Vision', subtitle: '中国新锐 / 正面和执行力', scoreLabel: '签位强度', advice: '按计划提速，别道具到了人没到。', avoid: '别小优势局打得像在试探人生。', line: 'LVG签有冲劲，关键是别断档。', liquipediaPage: 'Lynn Vision Gaming', playerImageFallback: 'Westmelon' },
  { key: 'big', title: '今日CS队伍', name: 'BIG', subtitle: '德国纪律 / 道具和默认', scoreLabel: '签位强度', advice: '先把默认打清楚，道具别省也别乱交。', avoid: '别默认控到时间没了才想起来进点。', line: 'BIG签很讲规矩，规矩乱了就很难看。', liquipediaPage: 'BIG', playerImageFallback: 'tabseN' },
  { key: 'complexity', title: '今日CS队伍', name: 'Complexity', subtitle: '北美冲击 / 正面交换', scoreLabel: '签位强度', advice: '今天别等奇迹，第一时间补枪要到位。', avoid: '别经济局刚有机会就把枪送回去。', line: 'COL签主打一个别复杂化。', liquipediaPage: 'Complexity Gaming', playerImageFallback: 'EliGE' },
);

csMaps.push(
  { key: 'train', title: '今日CS地图', name: 'Train', subtitle: '内外场控图 / 绿通和回防', scoreLabel: '手感指数', advice: '外场信息别断，进点前先把关键狙位处理掉。', avoid: '别一出门就被架死还说没办法。', line: '列车停放站这签，慢一秒和快一秒都要命。', fandomPage: 'Train', fandomFile: 'De_train_cs2.png' },
  { key: 'cache', title: '今日CS地图', name: 'Cache', subtitle: '中路控制 / A叉和B点爆弹', scoreLabel: '手感指数', advice: '中路别白给，A叉压力和B区假动作要讲清楚。', avoid: '别烟还没封，人已经过马路了。', line: '死城之谜这图，信息一断就开始猜谜。', fandomPage: 'Cache', fandomFile: 'De_cache.png' },
  { key: 'cobblestone', title: '今日CS地图', name: 'Cobblestone', subtitle: '长距离枪线 / B区执行', scoreLabel: '手感指数', advice: '长枪线要耐心，进B之前道具和补枪距离先摆好。', avoid: '别龙区散步散到被逐个点名。', line: '古堡签有年代感，但白给一直很现代。', fandomPage: 'Cobblestone', fandomFile: 'De_cbble.png' },
  { key: 'tuscan', title: '今日CS地图', name: 'Tuscan', subtitle: '经典回归 / 中路和两翼夹击', scoreLabel: '手感指数', advice: '先拿中路空间，再看两翼同步，别让队伍断成两截。', avoid: '别复古图打出复古沟通。', line: 'Tuscan签有老味，细节不到位就很苦。', fandomPage: 'Tuscan', fandomFile: 'De_tuscan_cs2.png' },
  { key: 'vertigo', title: '今日CS地图', name: 'Vertigo', subtitle: '楼梯和A坡 / 垂直空间', scoreLabel: '手感指数', advice: 'A坡争夺要有烟闪火顺序，别干拉看天。', avoid: '别掉下去，物理白给最难洗。', line: '殒命大厦签，楼上楼下都能出节目。', fandomPage: 'Vertigo', fandomFile: 'De_vertigo_cs2.png' },
  { key: 'office', title: '今日CS地图', name: 'Office', subtitle: '人质图 / 近点混战', scoreLabel: '手感指数', advice: '别急冲窄口，先用道具清近点和交叉。', avoid: '别一进门就把自己交给霰弹枪。', line: '办公室签很欢乐，但欢乐不等于乱送。', fandomPage: 'Office', fandomFile: 'Cs_office_cs2.png' },
  { key: 'italy', title: '今日CS地图', name: 'Italy', subtitle: '巷战和人质 / 近点信息', scoreLabel: '手感指数', advice: '巷道信息要慢慢拿，别无道具硬进。', avoid: '别把人质图打成单挑赛。', line: '意大利小镇签，优雅不了一点。', fandomPage: 'Italy', fandomFile: 'Cs_italy_cs2.png' },
);

csWeapons.push(
  { key: 'm4a4', title: '今日CS武器', name: 'M4A4', subtitle: '高弹量步枪 / 正面压制', scoreLabel: '爆头指数', advice: '多用弹量优势打多目标转移，别站桩扫到没子弹。', avoid: '别和A1一样玩偷人，枪不一样思路也不一样。', line: 'M4A4签就是稳压，压不住就是你急。', fandomFile: 'CS2_M4A4_Inventory.png' },
  { key: 'usp', title: '今日CS武器', name: 'USP-S', subtitle: '手枪局纪律 / 消音点射', scoreLabel: '爆头指数', advice: '第一枪慢一点，打头线和换位，不要连续硬peek。', avoid: '别一梭子打完还站原地。', line: 'USP签很冷静，冷静完别怂。', fandomFile: 'CS2_USP-S_Inventory.png' },
  { key: 'glock', title: '今日CS武器', name: 'Glock-18', subtitle: 'T方手枪 / 跑动和集火', scoreLabel: '爆头指数', advice: '抱团提速，近点集火，别一个人远距离点半天。', avoid: '别手枪局单摸当大哥。', line: '格洛克签要人多，孤狼没节目。', fandomFile: 'CS2_Glock-18_Inventory.png' },
  { key: 'famas', title: '今日CS武器', name: 'FAMAS', subtitle: 'CT半甲步枪 / 经济管理', scoreLabel: '爆头指数', advice: '利用位置和交叉火力，别拿它去和AK硬碰硬。', avoid: '别嫌便宜枪，便宜枪也要打干净。', line: 'FAMAS签就是会过日子，别过成捐款。', fandomFile: 'CS2_FAMAS_Inventory.png' },
  { key: 'aug', title: '今日CS武器', name: 'AUG', subtitle: '开镜稳定 / 长枪线', scoreLabel: '爆头指数', advice: '长点架住就收，不要开镜开到队友都没了。', avoid: '别因为能开镜就忘了换位。', line: 'AUG签有点稳健，也有点容易上头。', fandomFile: 'CS2_AUG_Inventory.png' },
  { key: 'sg553', title: '今日CS武器', name: 'SG 553', subtitle: 'T方开镜步枪 / 远点压制', scoreLabel: '爆头指数', advice: '远点拿信息和首杀，拿完就别贪第二枪。', avoid: '别开镜走路慢到被近点吃掉。', line: 'SG签是望远镜，但别望到回合没了。', fandomFile: 'CS2_SG_553_Inventory.png' },
  { key: 'p250', title: '今日CS武器', name: 'P250', subtitle: '低成本破甲 / 经济局偷人', scoreLabel: '爆头指数', advice: '贴近打第一枪，杀一个就赚，别远点硬讲道理。', avoid: '别把经济局打成单人送温暖。', line: 'P250签小钱办大事，办不了也别嘴硬。', fandomFile: 'CS2_P250_Inventory.png' },
  { key: 'five-seven', title: '今日CS武器', name: 'Five-SeveN', subtitle: 'CT近点手枪 / 爆发输出', scoreLabel: '爆头指数', advice: '近点蹲住交叉，等对面进你的距离再开火。', avoid: '别远距离和步枪互相尊重。', line: '57签最会阴人，阴不到就是白给。', fandomFile: 'CS2_Five-SeveN_Inventory.png' },
  { key: 'tec9', title: '今日CS武器', name: 'Tec-9', subtitle: '提速手枪 / 第一身位', scoreLabel: '爆头指数', advice: '吃闪冲近点，帮队友拉枪线，别停在半路犹豫。', avoid: '别冲了没人跟，回头一看全在出生点。', line: 'Tec-9签就是冲，但冲要有队友。', fandomFile: 'CS2_Tec-9_Inventory.png' },
  { key: 'p90', title: '今日CS武器', name: 'P90', subtitle: '跑打和火力压制 / 整活也能赢', scoreLabel: '爆头指数', advice: '近距离压迫可以，打完就转位置，别贪。', avoid: '别拿P90中远距离当AK。', line: 'P90签节目效果很足，别足到被踢。', fandomFile: 'CS2_P90_Inventory.png' },
  { key: 'xm1014', title: '今日CS武器', name: 'XM1014', subtitle: '近点霰弹 / 经济偷局', scoreLabel: '爆头指数', advice: '守窄口和近点，杀到一个就换位，别追出去送枪。', avoid: '别拿喷子出门追远点。', line: '连喷签很脏，但脏活也要讲位置。', fandomFile: 'CS2_XM1014_Inventory.png' },
  { key: 'ssg08', title: '今日CS武器', name: 'SSG 08', subtitle: '鸟狙 / 经济局远点威胁', scoreLabel: '爆头指数', advice: '打一枪就走，靠机动性和信息赚价值。', avoid: '别空一枪还站原地摆姿势。', line: '鸟狙签很轻，但压力不轻。', fandomFile: 'CS2_SSG_08_Inventory.png' },
);

csClutches.push(
  { key: 'one-v-two', title: '今日CS残局', name: '1v2拆分残局', subtitle: '隔离单挑 / 信息反推', scoreLabel: '残局指数', advice: '先把两个人拆开打，不要同时接两条枪线。', avoid: '别急着冲进交叉火力。', line: '1v2签不是硬刚签，是拆题签。', fandomFile: 'CS2_USP-S_Inventory.png' },
  { key: 'one-v-three', title: '今日CS残局', name: '1v3偷时间', subtitle: '假动作 / 转点 / 对面心态', scoreLabel: '残局指数', advice: '先造动静逼对面乱，再找落单点，不要正面硬撞三个人。', avoid: '别一开局就暴露所有信息。', line: '1v3签先别说赢，先让对面开始慌。', fandomFile: 'Flashbanghud_csgo.png' },
  { key: 'two-v-four', title: '今日CS残局', name: '2v4反打', subtitle: '交叉火力 / 道具重置', scoreLabel: '残局指数', advice: '两个人别分太远，先靠道具和双拉拿第一个击杀。', avoid: '别一个人想当英雄，另一个人只能观战。', line: '2v4签看配合，个人主义先收一收。', fandomFile: 'Smokegrenadehud_csgo.png' },
  { key: 'pistol-retake', title: '今日CS残局', name: '手枪局回防', subtitle: '人多节奏 / 近点清理', scoreLabel: '残局指数', advice: '一起进，一起补，先清近点再碰包。', avoid: '别三个人三秒进三次门。', line: '手枪回防签，散了就只剩点头。', fandomFile: 'CS2_Glock-18_Inventory.png' },
  { key: 'ninja-defuse', title: '今日CS残局', name: '偷拆残局', subtitle: '烟雾和声音 / 胆子与判断', scoreLabel: '残局指数', advice: '烟里偷拆前先确认对面距离和子弹压力，能骗再骗。', avoid: '别没烟没钳还硬演忍者。', line: '偷拆签很帅，但失败也很安静。', fandomFile: 'Defuserhud_csgo.png' },
  { key: 'fake-defuse', title: '今日CS残局', name: '假拆真拉', subtitle: '声音博弈 / 逼对面出枪', scoreLabel: '残局指数', advice: '点包骗枪位，拉出来只接一个角，别同时看三处。', avoid: '别假拆假到自己都信了。', line: '假拆签就是演技，演完得真会打。', fandomFile: 'Defuserhud_csgo.png' },
  { key: 'lowhp', title: '今日CS残局', name: '残血残局', subtitle: '一枪死 / 信息和角度选择', scoreLabel: '残局指数', advice: '残血就别硬换血，靠角度、道具和时间打。', avoid: '别还剩7滴血硬当突破手。', line: '残血签最考验嘴硬含金量。', fandomFile: 'CS2_P250_Inventory.png' },
);

const csSkins: SkinCard[] = [
  { key: 'ak-redline', title: '今日CS皮肤', name: 'AK-47 | Redline', weapon: 'AK-47', rarity: 'Classified', subtitle: '经典红线 / 朴素但有压迫感', scoreLabel: '出货指数', advice: '今天皮肤不花，但枪要干净，第一发别急。', avoid: '别拿经典皮肤打出抽象弹道。', line: '红线签很稳，稳不住就是人的问题。', fandomFile: 'AK-47_Redline.png', fandomPage: 'Redline' },
  { key: 'ak-fire-serpent', title: '今日CS皮肤', name: 'AK-47 | Fire Serpent', weapon: 'AK-47', rarity: 'Covert', subtitle: '火蛇 / 老贵族味', scoreLabel: '出货指数', advice: '今天别急，火蛇是气场，不是免死金牌。', avoid: '别皮肤比回合价值高。', line: '火蛇签抽到，先别开香槟，枪线站好。', fandomFile: 'AK-47_Fire_Serpent.png' },
  { key: 'ak-asiimov', title: '今日CS皮肤', name: 'AK-47 | Asiimov', weapon: 'AK-47', rarity: 'Covert', subtitle: '白橙科幻 / 高辨识度', scoreLabel: '出货指数', advice: '枪要打得像皮肤一样干净，别泼成涂鸦。', avoid: '别只会看检视，不会看小地图。', line: '二西莫夫签很亮，别亮完就白给。', fandomFile: 'AK-47_Asiimov.png', fandomPage: 'Asiimov' },
  { key: 'ak-bloodsport', title: '今日CS皮肤', name: 'AK-47 | Bloodsport', weapon: 'AK-47', rarity: 'Covert', subtitle: '红白赛车感 / 正面火力', scoreLabel: '出货指数', advice: '今天正面可以硬，但补枪距离要跟上。', avoid: '别打得像没保险的赛车。', line: '血腥运动签很躁，躁也要有章法。', fandomFile: 'AK-47_Bloodsport.png' },
  { key: 'awp-dragon-lore', title: '今日CS皮肤', name: 'AWP | Dragon Lore', weapon: 'AWP', rarity: 'Covert', subtitle: '龙狙 / 传说级节目效果', scoreLabel: '出货指数', advice: '第一枪要稳，拿到优势就收，不要把龙狙送出去。', avoid: '别空枪后还在原地检视。', line: '龙狙签抽到，今天责任也跟着涨价。', fandomFile: 'AWP_Dragon_Lore.png', fandomPage: 'Dragon Lore' },
  { key: 'awp-asiimov', title: '今日CS皮肤', name: 'AWP | Asiimov', weapon: 'AWP', rarity: 'Covert', subtitle: '科幻大狙 / 经典白橙', scoreLabel: '出货指数', advice: '架点拿完就换位，别因为皮肤帅就多站半秒。', avoid: '别集锦没剪出来，经济先没了。', line: 'AWP二西莫夫签，帅可以，别空。', fandomFile: 'AWP_Asiimov.png', fandomPage: 'Asiimov' },
  { key: 'awp-containment', title: '今日CS皮肤', name: 'AWP | Containment Breach', weapon: 'AWP', rarity: 'Covert', subtitle: '怪物破笼 / 压迫感', scoreLabel: '出货指数', advice: '今天架点要狠，但空枪后撤更重要。', avoid: '别把自己关在同一个点位里。', line: '突破签配突破皮，听着就有事。', fandomFile: 'AWP_Containment_Breach.png' },
  { key: 'm4a1s-printstream', title: '今日CS皮肤', name: 'M4A1-S | Printstream', weapon: 'M4A1-S', rarity: 'Covert', subtitle: '白黑珍珠 / 干净偷人', scoreLabel: '出货指数', advice: '用消音和换位偷价值，别正面硬扫。', avoid: '别皮肤极简，打法极乱。', line: '印花集签很干净，别打脏。', fandomFile: 'M4A1-S_Printstream.png', fandomPage: 'Printstream' },
  { key: 'm4a1s-hyper-beast', title: '今日CS皮肤', name: 'M4A1-S | Hyper Beast', weapon: 'M4A1-S', rarity: 'Covert', subtitle: '怪兽涂装 / 老经典', scoreLabel: '出货指数', advice: '站位可以大胆一点，但换位别忘。', avoid: '别画面很凶，回合很软。', line: '暴怒野兽签，凶得有理才行。', fandomFile: 'M4A1-S_Hyper_Beast.png', fandomPage: 'Hyper Beast' },
  { key: 'm4a4-howl', title: '今日CS皮肤', name: 'M4A4 | Howl', weapon: 'M4A4', rarity: 'Contraband', subtitle: '咆哮 / 争议传奇', scoreLabel: '出货指数', advice: '弹量优势用来压制和转移，不是用来乱扫。', avoid: '别咆哮完人没了。', line: '咆哮签抽到，声音可以大，枪别飘。', fandomFile: 'M4A4_Howl.png', fandomPage: 'Howl' },
  { key: 'usp-kill-confirmed', title: '今日CS皮肤', name: 'USP-S | Kill Confirmed', weapon: 'USP-S', rarity: 'Covert', subtitle: '爆头确认 / 手枪局压迫', scoreLabel: '出货指数', advice: '第一发慢一点，手枪局别急着连续peek。', avoid: '别确认的是自己的死亡。', line: '枪响确认签，确认前先瞄头。', fandomFile: 'USP-S_Kill_Confirmed.png' },
  { key: 'deagle-blaze', title: '今日CS皮肤', name: 'Desert Eagle | Blaze', weapon: 'Desert Eagle', rarity: 'Restricted', subtitle: '火沙鹰 / 一发梦', scoreLabel: '出货指数', advice: '别急开枪，等准星和脚步都稳了再讲道理。', avoid: '别七发火光，全是空气。', line: '火沙鹰签最骗自信，但骗成了真帅。', fandomFile: 'Desert_Eagle_Blaze.png', fandomPage: 'Blaze' },
  { key: 'glock-fade', title: '今日CS皮肤', name: 'Glock-18 | Fade', weapon: 'Glock-18', rarity: 'Restricted', subtitle: '渐变 / 手枪局小豪华', scoreLabel: '出货指数', advice: '抱团提速，靠近打，别远点单点到天荒地老。', avoid: '别渐变很贵，打法很散。', line: '格洛克渐变签，手枪局别演。', fandomFile: 'Glock-18_Fade.png', fandomPage: 'Fade' },
  { key: 'mp9-starlight', title: '今日CS皮肤', name: 'MP9 | Starlight Protector', weapon: 'MP9', rarity: 'Covert', subtitle: '星光守护者 / 近点爆发', scoreLabel: '出货指数', advice: '近点杀一个就走，别恋战。', avoid: '别守护的是对面经济。', line: 'MP9星光签，闪亮但要跑得快。', fandomFile: 'MP9_Starlight_Protector.png' },
  { key: 'mac10-disco', title: '今日CS皮肤', name: 'MAC-10 | Disco Tech', weapon: 'MAC-10', rarity: 'Classified', subtitle: '迪斯科科技 / 第一身位节目', scoreLabel: '出货指数', advice: '冲锋要有闪和补枪，不要自己开舞池。', avoid: '别进点跳舞，队友进不来。', line: '迪斯科签很嗨，嗨完得换到空间。', fandomFile: 'MAC-10_Disco_Tech.png' },
];

interface KnifeSkin {
  key: string;
  name: string;
  rarity: string;
  advice: string;
  avoid: string;
  line: string;
  fileSuffixes: string[];
}

const csKnives: KnifeCard[] = [
  { key: 'bayonet', title: '今日发刀', name: 'Bayonet', subtitle: '刺刀 / 老派经典', scoreLabel: '刀运指数', advice: '今天抽到老经典，稳一点，别检视到被偷。', avoid: '别刀还没掏明白，人先没了。', line: '刺刀签很直，别玩弯的。', fandomPage: 'Bayonet', fandomFile: 'Cs2-knife-bayonet-stock-market.png', aliases: ['bayonet'], skinFilePrefixes: ['Bayonet'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'm9-bayonet', title: '今日发刀', name: 'M9 Bayonet', subtitle: 'M9刺刀 / 厚重大哥', scoreLabel: '刀运指数', advice: '这刀气场够，回合也得够硬。', avoid: '别只会切刀不看身后。', line: 'M9签抽到，今天多少有点排面。', fandomPage: 'M9 Bayonet', fandomFile: 'Cs2-knife-m9-bayonet-stock.png', aliases: ['m9'], skinFilePrefixes: ['M9_Bayonet', 'M9Bayonet'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'karambit', title: '今日发刀', name: 'Karambit', subtitle: '爪子刀 / 顶级人气', scoreLabel: '刀运指数', advice: '抽到爪子先别飘，回合先赢再检视。', avoid: '别转刀转到忘补枪。', line: '爪子签有节目，节目别变事故。', fandomPage: 'Karambit', fandomFile: 'Cs2-knife-karambit-stock.png', aliases: ['爪子刀', '爪子'], skinFilePrefixes: ['Karambit'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'butterfly', title: '今日发刀', name: 'Butterfly Knife', subtitle: '蝴蝶刀 / 检视之王', scoreLabel: '刀运指数', advice: '可以检视，但别检视到被timing抓。', avoid: '别刀花活比枪法多。', line: '蝴蝶签来了，先把手稳住。', fandomPage: 'Butterfly Knife', fandomFile: 'Cs2-knife-butterfly-stock-market.png', aliases: ['蝴蝶刀', '蝴蝶'], skinFilePrefixes: ['Butterfly_Knife', 'Butterfly'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'flip', title: '今日发刀', name: 'Flip Knife', subtitle: '折叠刀 / 实用经典', scoreLabel: '刀运指数', advice: '朴素但耐看，今天少花活多赢回合。', avoid: '别觉得不够贵就乱玩。', line: '折刀签不装，但能打。', fandomPage: 'Flip Knife', fandomFile: 'Weapon_knife_flip_cs2.png', aliases: ['折刀'], skinFilePrefixes: ['Flip_Knife', 'Flip'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'gut', title: '今日发刀', name: 'Gut Knife', subtitle: '穿肠刀 / 老资历', scoreLabel: '刀运指数', advice: '冷门刀也有味，别自己先嫌弃。', avoid: '别刀冷门，打法也冷场。', line: '穿肠签抽到，今天主打朴实。', fandomPage: 'Gut Knife', fandomFile: 'Weapon_knife_gut_cs2.png', aliases: ['穿肠刀'], skinFilePrefixes: ['Gut_Knife', 'Gut'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'huntsman', title: '今日发刀', name: 'Huntsman Knife', subtitle: '猎杀者匕首 / 厚实硬朗', scoreLabel: '刀运指数', advice: '今天别怕正面，但枪线别乱冲。', avoid: '别猎杀到最后猎的是自己。', line: '猎杀者签，有点硬汉味。', fandomPage: 'Huntsman Knife', fandomFile: 'Weapon_knife_tactical_cs2.png', aliases: ['猎杀者'], skinFilePrefixes: ['Huntsman_Knife', 'Huntsman'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'falchion', title: '今日发刀', name: 'Falchion Knife', subtitle: '弯刀 / 动作有记忆点', scoreLabel: '刀运指数', advice: '今天节奏别弯，回合路线要直。', avoid: '别甩刀甩到忘了换弹。', line: '弯刀签，花但不能乱。', fandomPage: 'Falchion Knife', fandomFile: 'Weapon_knife_falchion_cs2.png', aliases: ['弯刀'], skinFilePrefixes: ['Falchion_Knife', 'Falchion'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'bowie', title: '今日发刀', name: 'Bowie Knife', subtitle: '鲍伊猎刀 / 大开大合', scoreLabel: '刀运指数', advice: '气势够了，今天枪也得够干净。', avoid: '别刀大，胆子小。', line: '鲍伊签很有重量，别把回合打轻了。', fandomPage: 'Bowie Knife', fandomFile: 'Weapon_knife_survival_bowie_cs2.png', aliases: ['鲍伊'], skinFilePrefixes: ['Bowie_Knife', 'Bowie'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'shadow-daggers', title: '今日发刀', name: 'Shadow Daggers', subtitle: '暗影双匕 / 整活气质', scoreLabel: '刀运指数', advice: '双刀签很有节目，但别双倍白给。', avoid: '别以为两把刀等于两条命。', line: '暗影双匕签，节目效果先到位。', fandomPage: 'Shadow Daggers', fandomFile: 'Weapon_knife_push_cs2.png', aliases: ['双匕', '拳套刀'], skinFilePrefixes: ['Shadow_Daggers', 'Shadow'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'navaja', title: '今日发刀', name: 'Navaja Knife', subtitle: '折刀小刀 / 低调冷门', scoreLabel: '刀运指数', advice: '刀可以低调，回合别低迷。', avoid: '别冷门刀配冷门枪法。', line: '纳瓦哈签，主打一个别嫌。', fandomPage: 'Navaja Knife', fandomFile: 'Weapon_knife_gypsy_jackknife_cs2.png', aliases: ['纳瓦哈'], skinFilePrefixes: ['Navaja_Knife', 'Navaja'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'stiletto', title: '今日发刀', name: 'Stiletto Knife', subtitle: '短剑 / 细长利落', scoreLabel: '刀运指数', advice: '今天打法要利落，别拖泥带水。', avoid: '别刀很优雅，枪很狼狈。', line: '短剑签有味，关键是别手抖。', fandomPage: 'Stiletto Knife', fandomFile: 'Weapon_knife_stiletto_cs2.png', aliases: ['短剑'], skinFilePrefixes: ['Stiletto_Knife', 'Stiletto'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'talon', title: '今日发刀', name: 'Talon Knife', subtitle: '锯齿爪刀 / 爪子兄弟', scoreLabel: '刀运指数', advice: '这签很锋利，但回合判断别割裂。', avoid: '别检视检到被背刺。', line: '锯齿爪签，今天排面够。', fandomPage: 'Talon Knife', fandomFile: 'Weapon_knife_widowmaker_cs2.png', aliases: ['锯齿爪'], skinFilePrefixes: ['Talon_Knife', 'Talon'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'ursus', title: '今日发刀', name: 'Ursus Knife', subtitle: '熊刀 / 简洁硬派', scoreLabel: '刀运指数', advice: '少花活，多赢回合，熊刀就吃这个味。', avoid: '别硬派刀配软脚步。', line: '熊刀签，朴实但不丢人。', fandomPage: 'Ursus Knife', fandomFile: 'Weapon_knife_ursus_cs2.png', aliases: ['熊刀'], skinFilePrefixes: ['Ursus_Knife', 'Ursus'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'classic', title: '今日发刀', name: 'Classic Knife', subtitle: '经典刀 / CS血统', scoreLabel: '刀运指数', advice: '经典刀签，今天把基本功打回来。', avoid: '别经典的是刀，抽象的是人。', line: '经典刀签一出，老味来了。', fandomPage: 'Classic Knife', fandomFile: 'Weapon_knife_css_cs2.png', aliases: ['经典刀'], skinFilePrefixes: ['Classic_Knife', 'Classic'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'paracord', title: '今日发刀', name: 'Paracord Knife', subtitle: '系绳匕首 / 实战风', scoreLabel: '刀运指数', advice: '今天别花，打得实用一点。', avoid: '别战术风皮肤配无战术打法。', line: '系绳刀签，低调但能看。', fandomPage: 'Paracord Knife', fandomFile: 'Weapon_knife_cord_cs2.png', aliases: ['系绳刀'], skinFilePrefixes: ['Paracord_Knife', 'Paracord'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'survival', title: '今日发刀', name: 'Survival Knife', subtitle: '求生匕首 / 硬朗工具感', scoreLabel: '刀运指数', advice: '今天先活下来再谈操作，别第一身位白给。', avoid: '别求生刀抽到了，人却不求生。', line: '求生刀签，字面意义先别死。', fandomPage: 'Survival Knife', fandomFile: 'Weapon_knife_canis_cs2.png', aliases: ['求生刀'], skinFilePrefixes: ['Survival_Knife', 'Survival'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'nomad', title: '今日发刀', name: 'Nomad Knife', subtitle: '流浪者匕首 / 干净利落', scoreLabel: '刀运指数', advice: '走位可以灵活，但别真流浪到队友找不到你。', avoid: '别绕后绕成失踪人口。', line: '流浪者签，别流浪过头。', fandomPage: 'Nomad Knife', fandomFile: 'Weapon_knife_outdoor_cs2.png', aliases: ['流浪者'], skinFilePrefixes: ['Nomad_Knife', 'Nomad'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'skeleton', title: '今日发刀', name: 'Skeleton Knife', subtitle: '骷髅刀 / 高人气硬货', scoreLabel: '刀运指数', advice: '抽到骷髅刀，今天回合得打出骨架。', avoid: '别只有刀有骨架，战术没骨架。', line: '骷髅刀签，有点硬通货味。', fandomPage: 'Skeleton Knife', fandomFile: 'Weapon_knife_skeleton_cs2.png', aliases: ['骷髅刀'], skinFilePrefixes: ['Skeleton_Knife', 'Skeleton'] } as KnifeCard & { skinFilePrefixes: string[] },
  { key: 'kukri', title: '今日发刀', name: 'Kukri Knife', subtitle: '廓尔喀刀 / CS2新刀型', scoreLabel: '刀运指数', advice: '新刀签，今天可以有点新思路，但别乱。', avoid: '别新刀新鲜，回合发霉。', line: '廓尔喀签抽到，新鲜感有了。', fandomPage: 'Kukri Knife', fandomFile: 'CS2_weapon_knife_kukri.png', aliases: ['廓尔喀', '库克里'], skinFilePrefixes: ['Kukri_Knife', 'Kukri'] } as KnifeCard & { skinFilePrefixes: string[] },
];

const knifeSkins: KnifeSkin[] = [
  { key: 'vanilla', name: 'Vanilla', rarity: 'Covert', advice: '原版签吃的是刀型本身，今天别花，赢回合最有排面。', avoid: '别原版刀很干净，操作很凌乱。', line: 'Vanilla签，朴素但硬。', fileSuffixes: ['Vanilla', 'Stock', 'stock'] },
  { key: 'doppler', name: 'Doppler', rarity: 'Covert', advice: '多普勒签很亮，亮归亮，别把自己亮给对面。', avoid: '别检视比补枪还积极。', line: 'Doppler一出，群里先沉默三秒。', fileSuffixes: ['Doppler', 'doppler_phase2', 'doppler_phase3', 'doppler_phase4'] },
  { key: 'doppler-phase1', name: 'Doppler Phase 1', rarity: 'Covert', advice: 'P1签是暗紫冷调，今天稳着打也有高级感。', avoid: '别颜色低调，脚步高调。', line: 'Doppler P1签，低调里有光。', fileSuffixes: ['Doppler_Phase_1', 'Doppler_Phase1', 'doppler_phase1'] },
  { key: 'doppler-phase2', name: 'Doppler Phase 2', rarity: 'Covert', advice: 'P2签粉紫很出片，但别光顾着截图。', avoid: '别截图比补枪还快。', line: 'Doppler P2签，颜值先顶住。', fileSuffixes: ['Doppler_Phase_2', 'Doppler_Phase2', 'doppler_phase2'] },
  { key: 'doppler-phase3', name: 'Doppler Phase 3', rarity: 'Covert', advice: 'P3签有点冷门质感，今天靠细节赢。', avoid: '别冷门到队友都跟不上节奏。', line: 'Doppler P3签，懂的人会懂。', fileSuffixes: ['Doppler_Phase_3', 'Doppler_Phase3', 'doppler_phase3'] },
  { key: 'doppler-phase4', name: 'Doppler Phase 4', rarity: 'Covert', advice: 'P4签蓝调很稳，今天架枪也稳一点。', avoid: '别蓝得好看，人却急得发红。', line: 'Doppler P4签，冷静就完事。', fileSuffixes: ['Doppler_Phase_4', 'Doppler_Phase4', 'doppler_phase4'] },
  { key: 'doppler-ruby', name: 'Doppler Ruby', rarity: 'Covert', advice: '红宝石签是大货，回合也得打出大货样。', avoid: '别刀像红宝石，经济像碎玻璃。', line: 'Ruby签，群里可以短暂安静一下。', fileSuffixes: ['Doppler_Ruby', 'Ruby', 'doppler_ruby'] },
  { key: 'doppler-sapphire', name: 'Doppler Sapphire', rarity: 'Covert', advice: '蓝宝石签压迫感够，今天别乱送节奏。', avoid: '别蓝宝石拿着，蓝屏操作打着。', line: 'Sapphire签，冷贵冷贵的。', fileSuffixes: ['Doppler_Sapphire', 'Sapphire', 'doppler_sapphire'] },
  { key: 'doppler-black-pearl', name: 'Doppler Black Pearl', rarity: 'Covert', advice: '黑珍珠签很稀，今天别把机会打稀碎。', avoid: '别黑珍珠配黑色幽默。', line: 'Black Pearl签，有点传家宝味。', fileSuffixes: ['Doppler_Black_Pearl', 'Black_Pearl', 'doppler_black_pearl'] },
  { key: 'gamma-doppler', name: 'Gamma Doppler', rarity: 'Covert', advice: '绿宝石气质拉满，但回合别绿。', avoid: '别为了看颜色忘了看包点。', line: 'Gamma Doppler签，今天有点贵气。', fileSuffixes: ['Gamma_Doppler', 'gamma_doppler'] },
  { key: 'gamma-doppler-phase1', name: 'Gamma Doppler Phase 1', rarity: 'Covert', advice: 'Gamma P1签偏沉稳，今天信息别断。', avoid: '别绿光一闪，人就没了。', line: 'Gamma P1签，稳里带亮。', fileSuffixes: ['Gamma_Doppler_Phase_1', 'Gamma_Doppler_Phase1', 'gamma_doppler_phase1'] },
  { key: 'gamma-doppler-phase2', name: 'Gamma Doppler Phase 2', rarity: 'Covert', advice: 'Gamma P2签更亮，今天正面可以硬一点。', avoid: '别亮刀亮到暴露timing。', line: 'Gamma P2签，亮得有攻击性。', fileSuffixes: ['Gamma_Doppler_Phase_2', 'Gamma_Doppler_Phase2', 'gamma_doppler_phase2'] },
  { key: 'gamma-doppler-phase3', name: 'Gamma Doppler Phase 3', rarity: 'Covert', advice: 'Gamma P3签有层次，今天别一条路走黑。', avoid: '别颜色有层次，打法没层次。', line: 'Gamma P3签，细节派。', fileSuffixes: ['Gamma_Doppler_Phase_3', 'Gamma_Doppler_Phase3', 'gamma_doppler_phase3'] },
  { key: 'gamma-doppler-phase4', name: 'Gamma Doppler Phase 4', rarity: 'Covert', advice: 'Gamma P4签清爽，今天交流也清楚点。', avoid: '别报点比刀纹还模糊。', line: 'Gamma P4签，干净利落。', fileSuffixes: ['Gamma_Doppler_Phase_4', 'Gamma_Doppler_Phase4', 'gamma_doppler_phase4'] },
  { key: 'gamma-doppler-emerald', name: 'Gamma Doppler Emerald', rarity: 'Covert', advice: '绿宝石签到手，今天少犯低级错。', avoid: '别满眼绿宝石，满脑子空枪。', line: 'Emerald签，这把真有点贵。', fileSuffixes: ['Gamma_Doppler_Emerald', 'Emerald', 'gamma_doppler_emerald'] },
  { key: 'fade', name: 'Fade', rarity: 'Covert', advice: '渐变签很顺眼，打法也要顺。', avoid: '别渐变很丝滑，急停很抽象。', line: 'Fade签，老审美不会错。', fileSuffixes: ['Fade'] },
  { key: 'marble-fade', name: 'Marble Fade', rarity: 'Covert', advice: '大理石渐变可以花，回合别花。', avoid: '别花刀配花活，最后花式白给。', line: 'Marble Fade签，颜色先赢了。', fileSuffixes: ['Marble_Fade'] },
  { key: 'marble-fade-fire-ice', name: 'Marble Fade Fire & Ice', rarity: 'Covert', advice: '冰火签看着就狠，今天决策也得干脆。', avoid: '别冰火两重天，上一秒自信下一秒白给。', line: 'Fire & Ice签，节目效果很足。', fileSuffixes: ['Marble_Fade_Fire_And_Ice', 'Marble_Fade_Fire_Ice', 'Fire_And_Ice'] },
  { key: 'tiger-tooth', name: 'Tiger Tooth', rarity: 'Covert', advice: '虎牙签就是锋利，今天正面可以硬一点。', avoid: '别虎牙变乳牙。', line: 'Tiger Tooth签，咬住别松。', fileSuffixes: ['Tiger_Tooth'] },
  { key: 'case-hardened', name: 'Case Hardened', rarity: 'Covert', advice: '淬火签看脸，回合可不能全看脸。', avoid: '别蓝顶没出，红温先出。', line: 'Case Hardened签，赌狗气质来了。', fileSuffixes: ['Case_Hardened', 'case_hardened'] },
  { key: 'case-hardened-blue-gem', name: 'Case Hardened Blue Gem', rarity: 'Covert', advice: '蓝宝石淬火签拉满，今天别把好签打成坏账。', avoid: '别蓝顶在手，脑子离线。', line: 'Blue Gem签，懂价的已经开始算了。', fileSuffixes: ['Case_Hardened_Blue_Gem', 'Blue_Gem', 'case_hardened_blue_gem'] },
  { key: 'blue-steel', name: 'Blue Steel', rarity: 'Covert', advice: '蓝钢签低调耐看，今天靠纪律和补枪吃饭。', avoid: '别冷色刀配热头打法。', line: 'Blue Steel签，稳里带一点冷。', fileSuffixes: ['Blue_Steel', 'blue_steel'] },
  { key: 'crimson-web', name: 'Crimson Web', rarity: 'Covert', advice: '红网签压迫感强，但别自己陷进去。', avoid: '别卡在自己编的网里。', line: 'Crimson Web签，红得有道理。', fileSuffixes: ['Crimson_Web', 'Crimson_web'] },
  { key: 'crimson-web-centered', name: 'Crimson Web Centered', rarity: 'Covert', advice: '正网签讲究一个位置，今天站位也讲究点。', avoid: '别网居中，人站歪。', line: 'Centered Web签，强迫症舒服了。', fileSuffixes: ['Crimson_Web_Centered', 'Centered_Web', 'crimson_web_centered'] },
  { key: 'slaughter', name: 'Slaughter', rarity: 'Covert', advice: '屠夫签要狠，但狠之前先确认队友位置。', avoid: '别屠的是队伍经济。', line: 'Slaughter签，今天别手软也别上头。', fileSuffixes: ['Slaughter'] },
  { key: 'lore', name: 'Lore', rarity: 'Covert', advice: '传说签有味，今天拿信息要有耐心。', avoid: '别传说没打出来，笑话先出来。', line: 'Lore签，老金色排面。', fileSuffixes: ['Lore'] },
  { key: 'lore-gold', name: 'Lore Gold', rarity: 'Covert', advice: '金色传说签，今天少说多赢。', avoid: '别金得晃眼，枪线晃没。', line: 'Lore Gold签，排面是够的。', fileSuffixes: ['Lore_Gold', 'Golden_Lore', 'lore_gold'] },
  { key: 'autotronic', name: 'Autotronic', rarity: 'Covert', advice: '自动化签很硬，打法别像没上电。', avoid: '别机械感有了，判断没了。', line: 'Autotronic签，红银硬货。', fileSuffixes: ['Autotronic', 'autotronic'] },
  { key: 'black-laminate', name: 'Black Laminate', rarity: 'Covert', advice: '黑层压低调，今天就靠纪律说话。', avoid: '别低调到队友找不到你。', line: 'Black Laminate签，冷静派。', fileSuffixes: ['Black_Laminate', 'black_laminate'] },
  { key: 'black-laminate-clean', name: 'Black Laminate Clean', rarity: 'Covert', advice: '干净黑层压签，今天操作也干净点。', avoid: '别刀面干净，残局脏乱。', line: 'Clean Black Laminate签，耐看。', fileSuffixes: ['Black_Laminate_Clean', 'Clean_Black_Laminate', 'black_laminate_clean'] },
  { key: 'boreal-forest', name: 'Boreal Forest', rarity: 'Covert', advice: '北方森林签主打隐蔽，别先把脚步送出去。', avoid: '别迷彩没藏住，意图先暴露。', line: 'Boreal Forest签，朴素但能活。', fileSuffixes: ['Boreal_Forest', 'boreal_forest'] },
  { key: 'damascus', name: 'Damascus Steel', rarity: 'Covert', advice: '大马士革签要稳，细节纹路别打散。', avoid: '别刀纹很细，枪法很粗。', line: 'Damascus Steel签，老工艺感。', fileSuffixes: ['Damascus_Steel'] },
  { key: 'damascus-bright', name: 'Damascus Steel Bright', rarity: 'Covert', advice: '亮面大马士革签，今天少犯暗亏。', avoid: '别刀面有光，思路没光。', line: 'Bright Damascus签，质感在线。', fileSuffixes: ['Damascus_Steel_Bright', 'Bright_Damascus', 'damascus_bright'] },
  { key: 'forest-ddpat', name: 'Forest DDPAT', rarity: 'Covert', advice: '森林数码签很实用，今天多拿信息少赌命。', avoid: '别伪装得很好，回合目标也跟着消失。', line: 'Forest DDPAT签，低调务实派。', fileSuffixes: ['Forest_DDPAT', 'forest_ddpat'] },
  { key: 'night', name: 'Night', rarity: 'Covert', advice: '夜色签很沉，今天别急着亮自己位置。', avoid: '别黑刀配黑屏操作。', line: 'Night签，暗得有气质。', fileSuffixes: ['Night'] },
  { key: 'night-stripe', name: 'Night Stripe', rarity: 'Covert', advice: '夜色条纹签冷静一点，先打信息再打人。', avoid: '别条纹很稳，人先乱了。', line: 'Night Stripe签，干净低调。', fileSuffixes: ['Night_Stripe', 'night_stripe'] },
  { key: 'scorched', name: 'Scorched', rarity: 'Covert', advice: '焦炭签很硬核，今天别怕脏活，但别白给。', avoid: '别刀像打过仗，人像刚睡醒。', line: 'Scorched签，糙但有味。', fileSuffixes: ['Scorched'] },
  { key: 'stained', name: 'Stained', rarity: 'Covert', advice: '表面淬色签耐看，今天每个peek都要有理由。', avoid: '别刀面有痕，思路也有坑。', line: 'Stained签，老派稳定。', fileSuffixes: ['Stained'] },
  { key: 'ultraviolet', name: 'Ultraviolet', rarity: 'Covert', advice: '紫外线签低调酷，今天少嘴硬多补枪。', avoid: '别紫得发黑，回合也发黑。', line: 'Ultraviolet签，冷色但别冷场。', fileSuffixes: ['Ultraviolet'] },
  { key: 'freehand', name: 'Freehand', rarity: 'Covert', advice: '自由手签可以飘，但打法别飘。', avoid: '别自由到没有队形。', line: 'Freehand签，花纹随意，人别随意。', fileSuffixes: ['Freehand'] },
  { key: 'freehand-purple', name: 'Freehand Purple', rarity: 'Covert', advice: '紫手绘签很有辨识度，今天别打成随手。', avoid: '别自由手变随便手。', line: 'Purple Freehand签，花得有分寸。', fileSuffixes: ['Freehand_Purple', 'Purple_Freehand', 'freehand_purple'] },
  { key: 'rust-coat', name: 'Rust Coat', rarity: 'Covert', advice: '锈蚀签很接地气，今天别嫌，赢回合才香。', avoid: '别刀生锈，脑子也生锈。', line: 'Rust Coat签，穷也穷得有态度。', fileSuffixes: ['Rust_Coat'] },
  { key: 'bright-water', name: 'Bright Water', rarity: 'Covert', advice: '澄澈之水签，今天信息也要清楚。', avoid: '别水很亮，人很迷。', line: 'Bright Water签，清爽但要能打。', fileSuffixes: ['Bright_Water'] },
  { key: 'safari-mesh', name: 'Safari Mesh', rarity: 'Covert', advice: '狩猎网格签朴素，朴素不是白给。', avoid: '别被对面当猎物。', line: 'Safari Mesh签，主打实用主义。', fileSuffixes: ['Safari_Mesh'] },
  { key: 'urban-masked', name: 'Urban Masked', rarity: 'Covert', advice: '都市伪装签适合稳扎稳打，先清近点再动。', avoid: '别伪装了半天，自己先迷路。', line: 'Urban Masked签，城市老兵味。', fileSuffixes: ['Urban_Masked', 'urban_masked'] },
  { key: 'urban-masked-clean', name: 'Urban Masked Clean', rarity: 'Covert', advice: '干净都市伪装签，今天清点别拖。', avoid: '别清清爽爽进点，稀里糊涂掉包。', line: 'Clean Urban Masked签，朴素但顺眼。', fileSuffixes: ['Urban_Masked_Clean', 'Clean_Urban_Masked', 'urban_masked_clean'] },
];

const legacyKnifeKeys = new Set(['bayonet', 'm9-bayonet', 'karambit', 'butterfly', 'flip', 'gut', 'huntsman', 'falchion', 'bowie', 'shadow-daggers']);
const limitedKnifeKeys = new Set(['classic', 'kukri']);
const legacyOnlyKnifeSkinKeys = new Set([
  'autotronic',
  'black-laminate',
  'black-laminate-clean',
  'bright-water',
  'freehand',
  'freehand-purple',
  'gamma-doppler',
  'gamma-doppler-phase1',
  'gamma-doppler-phase2',
  'gamma-doppler-phase3',
  'gamma-doppler-phase4',
  'gamma-doppler-emerald',
  'lore',
  'lore-gold',
  'night',
]);
const limitedKnifeSkinKeys = new Set(['vanilla', 'blue-steel', 'boreal-forest', 'case-hardened', 'crimson-web', 'fade', 'forest-ddpat', 'night-stripe', 'safari-mesh', 'scorched', 'slaughter', 'stained', 'urban-masked']);

function knifeSkinAvailableFor(knife: KnifeCard, skin: KnifeSkin): boolean {
  if (limitedKnifeKeys.has(knife.key)) return limitedKnifeSkinKeys.has(skin.key);
  if (legacyKnifeKeys.has(knife.key)) return skin.key !== 'night-stripe';
  return !legacyOnlyKnifeSkinKeys.has(skin.key);
}

function knifeSkinPoolFor(knife: KnifeCard): KnifeSkin[] {
  const pool = knifeSkins.filter((skin) => knifeSkinAvailableFor(knife, skin));
  return pool.length > 0 ? pool : knifeSkins;
}

const dailyCharacters: DailyCharacter[] = [
  { key: 'tomori', title: '每日木柜子', name: '高松灯 / Takamatsu Tomori', band: 'MyGO!!!!!', role: 'Vocal', voice: '羊宫妃那', note: '今天是灯签，慢热但真诚，别把话说太满。', page: 'Takamatsu Tomori' },
  { key: 'anon', title: '每日木柜子', name: '千早爱音 / Chihaya Anon', band: 'MyGO!!!!!', role: 'Guitar', voice: '立石凛', note: '今天是爱音签，社交能量有了，但别把自己安排太满。', page: 'Chihaya Anon' },
  { key: 'rana', title: '每日木柜子', name: '要乐奈 / Kaname Rana', band: 'MyGO!!!!!', role: 'Guitar', voice: '青木阳菜', note: '今天是乐奈签，自由发挥可以，但别突然消失。', page: 'Kaname Raana' },
  { key: 'soyo', title: '每日木柜子', name: '长崎爽世 / Nagasaki Soyo', band: 'MyGO!!!!!', role: 'Bass', voice: '小日向美香', note: '今天是爽世签，温柔可以，别把心事全憋成战术。', page: 'Nagasaki Soyo' },
  { key: 'taki', title: '每日木柜子', name: '椎名立希 / Shiina Taki', band: 'MyGO!!!!!', role: 'Drums', voice: '林鼓子', note: '今天是立希签，嘴硬归嘴硬，节奏要稳。', page: 'Shiina Taki' },
  { key: 'uika', title: '每日木柜子', name: '三角初华 / Misumi Uika', band: 'Ave Mujica', role: 'Doloris / Guitar & Vocal', voice: '佐佐木李子', note: '今天是初华签，舞台感拉满，但别把真实心情全藏起来。', page: 'Misumi Uika' },
  { key: 'mutsumi', title: '每日木柜子', name: '若叶睦 / Wakaba Mutsumi', band: 'Ave Mujica', role: 'Mortis / Guitar', voice: '渡濑结月', note: '今天是睦签，安静不是没想法，别急着替她下结论。', page: 'Wakaba Mutsumi' },
  { key: 'umiri', title: '每日木柜子', name: '八幡海铃 / Yahata Umiri', band: 'Ave Mujica', role: 'Timoris / Bass', voice: '冈田梦以', note: '今天是海铃签，可靠但有距离感，做事别拖。', page: 'Yahata Umiri' },
  { key: 'nyamu', title: '每日木柜子', name: '祐天寺若麦 / Yutenji Nyamu', band: 'Ave Mujica', role: 'Amoris / Drums', voice: '米泽茜', note: '今天是若麦签，镜头感很强，但别只顾节目效果。', page: 'Yuutenji Nyamu' },
  { key: 'sakiko', title: '每日木柜子', name: '丰川祥子 / Togawa Sakiko', band: 'Ave Mujica', role: 'Oblivionis / Keyboard', voice: '高尾奏音', note: '今天是祥子签，计划感很强，但别把自己逼太紧。', page: 'Togawa Sakiko' },
];

function keyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const genshinCharacterNames = [
  'Traveler', 'Albedo', 'Alhaitham', 'Aloy', 'Amber', 'Arataki Itto', 'Arlecchino', 'Baizhu', 'Barbara', 'Beidou',
  'Bennett', 'Candace', 'Charlotte', 'Chasca', 'Chevreuse', 'Chiori', 'Chongyun', 'Citlali', 'Clorinde', 'Collei',
  'Cyno', 'Dehya', 'Diluc', 'Diona', 'Dori', 'Emilie', 'Escoffier', 'Eula', 'Faruzan', 'Fischl',
  'Freminet', 'Furina', 'Gaming', 'Ganyu', 'Gorou', 'Hu Tao', 'Iansan', 'Ifa', 'Jean', 'Kachina',
  'Kaedehara Kazuha', 'Kaeya', 'Kamisato Ayaka', 'Kamisato Ayato', 'Kaveh', 'Keqing', 'Kinich', 'Kirara', 'Klee', 'Kujou Sara',
  'Kuki Shinobu', 'Lan Yan', 'Layla', 'Lisa', 'Lynette', 'Lyney', 'Mavuika', 'Mika', 'Mona', 'Mualani',
  'Nahida', 'Navia', 'Neuvillette', 'Nilou', 'Ningguang', 'Noelle', 'Ororon', 'Qiqi', 'Raiden Shogun', 'Razor',
  'Rosaria', 'Sangonomiya Kokomi', 'Sayu', 'Sethos', 'Shenhe', 'Shikanoin Heizou', 'Sigewinne', 'Skirk', 'Sucrose', 'Tartaglia',
  'Thoma', 'Tighnari', 'Varesa', 'Venti', 'Wanderer', 'Wriothesley', 'Xiangling', 'Xianyun', 'Xiao', 'Xilonen',
  'Xingqiu', 'Xinyan', 'Yae Miko', 'Yanfei', 'Yaoyao', 'Yelan', 'Yoimiya', 'Yumemizuki Mizuki', 'Yun Jin', 'Zhongli',
];

const genshinNotes = [
  '今天适合慢慢攒资源，别一口气把树脂和摩拉都花空。',
  '今天适合补一个长期队伍短板，圣遗物别上头。',
  '今天适合做探索和收集，路线比蛮跑更重要。',
  '今天适合把天赋、武器、等级这种硬提升补一补。',
  '今天适合换个配队思路，别只盯着同一套循环。',
  '今天适合清任务和图鉴，细碎进度也算进度。',
  '今天适合打深渊前先热手，别第一间就交学费。',
  '今天适合留一点材料余量，未来的你会感谢今天的你。',
];

const genshinTags = ['探索签', '养成签', '配队签', '剧情签', '深渊签', '收集签', '材料签', '手感签'];

const dailyGenshinCharacters: DailyGenshinCharacter[] = genshinCharacterNames.map((name, index) => ({
  key: keyFromName(name),
  title: '每日原神角色',
  name,
  page: name,
  note: genshinNotes[index % genshinNotes.length],
  tag: genshinTags[index % genshinTags.length],
}));

const dailyFacts: DailyTextCard[] = [
  { key: 'octopus-heart', title: '每日冷知识', name: '章鱼有三颗心', subtitle: '生物 / 海洋', body: '两颗心负责把血送到鳃，一颗负责把血送到全身；游泳时全身那颗会短暂停工。', advice: '今天遇到复杂系统，先分清每个部件在干什么。', line: '冷知识的重点不是怪，是结构真的很会分工。', scoreLabel: '新鲜度' },
  { key: 'honey-stable', title: '每日冷知识', name: '蜂蜜很难变质', subtitle: '食物 / 化学', body: '低含水量、高糖和酸性环境让多数微生物难以生长，所以考古样本里的蜂蜜常能保存很久。', advice: '今天做东西也一样，环境条件对了，稳定性会自己长出来。', line: '甜不是重点，重点是微生物住不舒服。', scoreLabel: '新鲜度' },
  { key: 'banana-berry', title: '每日冷知识', name: '香蕉在植物学里算浆果', subtitle: '植物 / 分类', body: '植物学分类看果实结构，不看日常叫法；香蕉符合浆果的一些结构标准。', advice: '今天别被名字骗了，先看定义。', line: '生活常识和学科定义，偶尔会互相拆台。', scoreLabel: '新鲜度' },
  { key: 'strawberry-not-berry', title: '每日冷知识', name: '草莓反而不算真正浆果', subtitle: '植物 / 分类', body: '草莓表面的“小籽”才是一个个小果，红色部分更像膨大的花托。', advice: '今天看热闹前先看结构，别只看表面红不红。', line: '草莓：我只是长得很像答案。', scoreLabel: '新鲜度' },
  { key: 'venus-day', title: '每日冷知识', name: '金星的一天比一年还长', subtitle: '天文 / 行星', body: '金星自转很慢，绕太阳一圈反而更快，所以它的恒星日长过公转周期。', advice: '今天别只看速度，方向和尺度更要命。', line: '慢到极致，日历都开始拧巴。', scoreLabel: '新鲜度' },
  { key: 'shark-old', title: '每日冷知识', name: '鲨鱼比树更古老', subtitle: '演化 / 时间尺度', body: '鲨鱼类群出现得非常早，比现代意义上大规模森林扩张还早。', advice: '今天遇到老东西，先尊重它的版本历史。', line: '它不是复古，它是一直没下线。', scoreLabel: '新鲜度' },
  { key: 'water-hot-freeze', title: '每日冷知识', name: '热水有时会比冷水先结冰', subtitle: '物理 / 姆潘巴效应', body: '在特定条件下，蒸发、对流和容器影响会让热水先结冰，但这不是随便都成立的魔法。', advice: '今天别把例外当万能规律，条件要写清。', line: '物理最会说：看情况。', scoreLabel: '新鲜度' },
  { key: 'cloud-weight', title: '每日冷知识', name: '云可以很重', subtitle: '气象 / 水滴', body: '一朵积云里有大量微小水滴，总质量可能达到数十万公斤，只是分布得足够稀。', advice: '今天别低估“分散的小东西”，堆起来也很可怕。', line: '看着轻，是因为摊得开。', scoreLabel: '新鲜度' },
  { key: 'wombat-cube', title: '每日冷知识', name: '袋熊会排出近似方形的便便', subtitle: '动物 / 结构', body: '肠道弹性和收缩差异会把内容物塑成近似立方形，方便它们标记领地时不乱滚。', advice: '今天奇怪的问题可能有很现实的用途。', line: '自然界的设计感，有时非常朴素。', scoreLabel: '新鲜度' },
  { key: 'library-smell', title: '每日冷知识', name: '旧书味来自纸张老化', subtitle: '材料 / 气味', body: '纸张里的木质素和纤维素分解会释放多种挥发物，混在一起就是熟悉的旧书气味。', advice: '今天怀旧可以，但也要知道它背后的化学。', line: '书香有时是真的分子在说话。', scoreLabel: '新鲜度' },
  { key: 'alphabet-order', title: '每日冷知识', name: '字母顺序非常古老', subtitle: '文字 / 传承', body: '许多字母系统的排序能追溯到更早的闪米特文字传统，顺序比很多语言本身还耐活。', advice: '今天别小看约定俗成，它可能比你想的更有历史。', line: 'A 在前面，不只是因为它爱卷。', scoreLabel: '新鲜度' },
  { key: 'cleopatra-pyramid', title: '每日冷知识', name: '埃及艳后离登月更近', subtitle: '历史 / 时间感', body: '克娄巴特拉生活的年代距离现代登月，比距离胡夫金字塔建成更近。', advice: '今天看历史别只凭“古埃及”三个字打包。', line: '时间轴一拉开，直觉经常输。', scoreLabel: '新鲜度' },
  { key: 'roman-concrete', title: '每日冷知识', name: '古罗马混凝土很耐久', subtitle: '材料 / 建筑', body: '火山灰和石灰等成分让部分古罗马混凝土在海水环境里形成稳定矿物，越泡越结实。', advice: '今天做底层结构，材料选对比后期补救强。', line: '真正的老工程，靠配方说话。', scoreLabel: '新鲜度' },
  { key: 'map-projection', title: '每日冷知识', name: '世界地图会变形', subtitle: '地理 / 投影', body: '把球面铺到平面必然变形，常见地图会放大高纬地区。', advice: '今天看图先问投影，别把显示方式当现实。', line: '地图不是撒谎，它只是压不平地球。', scoreLabel: '新鲜度' },
  { key: 'coffee-bean', title: '每日冷知识', name: '咖啡豆其实是种子', subtitle: '植物 / 饮料', body: '日常说的咖啡豆来自咖啡果实内部的种子，烘焙后才变成熟悉的“豆”。', advice: '今天别被行业叫法骗了，名字常常很随意。', line: '豆不豆的，好喝就行，但它确实是种子。', scoreLabel: '新鲜度' },
  { key: 'glass-liquid', title: '每日冷知识', name: '玻璃不是普通液体', subtitle: '材料 / 非晶态', body: '老窗玻璃下厚上薄更多来自制造工艺，不是玻璃在室温下慢慢流下去。', advice: '今天听到经典说法，先查机制再转述。', line: '流言最喜欢穿科学外套。', scoreLabel: '新鲜度' },
  { key: 'sleep-clean', title: '每日冷知识', name: '睡眠会帮大脑清理代谢废物', subtitle: '神经科学 / 睡眠', body: '睡眠中脑脊液流动和胶质淋巴系统活动会增强，帮助清走一些代谢产物。', advice: '今天别硬熬，清缓存也是战斗力。', line: '困不是废，可能是在催你维护系统。', scoreLabel: '新鲜度' },
  { key: 'mushroom-network', title: '每日冷知识', name: '菌根网络会连接植物', subtitle: '生态 / 真菌', body: '真菌和植物根系共生，能在土壤里形成物质和信号交换网络。', advice: '今天别只看地面，真正的关系可能在底下。', line: '森林的群聊，不一定在树冠上。', scoreLabel: '新鲜度' },
  { key: 'paper-fold', title: '每日冷知识', name: '对折纸很快会变厚', subtitle: '数学 / 指数增长', body: '纸每对折一次厚度翻倍，指数增长会很快超过直觉。', advice: '今天别小看复利和累积，倍增最会吓人。', line: '薄纸的野心，比看起来大。', scoreLabel: '新鲜度' },
  { key: 'north-pole-move', title: '每日冷知识', name: '磁北极会移动', subtitle: '地球物理 / 磁场', body: '指南针指向的是磁北附近，而磁北极会随地球内部活动缓慢移动。', advice: '今天别把参照物当永恒，基准也会跑。', line: '连北都会动，人别太死板。', scoreLabel: '新鲜度' },
];

const dailyBookExcerpts: DailyTextCard[] = [
  { key: 'analects-learning', title: '每日书摘', name: '《论语》', subtitle: '学而时习之', body: '学而时习之，不亦说乎。', advice: '今天挑一件小事反复练，别只收藏方法。', line: '复习不是重复，是给理解续命。', scoreLabel: '共鸣度' },
  { key: 'laozi-water', title: '每日书摘', name: '《道德经》', subtitle: '上善若水', body: '上善若水，水善利万物而不争。', advice: '今天能顺势就顺势，别每一步都硬顶。', line: '柔不是弱，是知道往哪流。', scoreLabel: '共鸣度' },
  { key: 'zhuangzi-free', title: '每日书摘', name: '《庄子》', subtitle: '逍遥游', body: '至人无己，神人无功，圣人无名。', advice: '今天少一点表演欲，多一点真松弛。', line: '不被评价牵着走，也是一种本事。', scoreLabel: '共鸣度' },
  { key: 'mencius-heart', title: '每日书摘', name: '《孟子》', subtitle: '尽心', body: '尽信书，则不如无书。', advice: '今天读东西要带脑子，别把文字当遥控器。', line: '好书也怕照单全收。', scoreLabel: '共鸣度' },
  { key: 'xunzi-step', title: '每日书摘', name: '《荀子》', subtitle: '劝学', body: '不积跬步，无以至千里。', advice: '今天做一点能累积的事，别嫌它小。', line: '千里路最怕第一步也想豪华。', scoreLabel: '共鸣度' },
  { key: 'sunzi-know', title: '每日书摘', name: '《孙子兵法》', subtitle: '谋攻', body: '知彼知己，百战不殆。', advice: '今天先收集信息，再下判断。', line: '莽之前先侦察。', scoreLabel: '共鸣度' },
  { key: 'caigentan-quiet', title: '每日书摘', name: '《菜根谭》', subtitle: '静中见真境', body: '静中静非真静，动处静得来，才是性天之真境。', advice: '今天练在杂事里稳住，不要只在安静时才安静。', line: '真正的稳，是吵的时候也不乱。', scoreLabel: '共鸣度' },
  { key: 'shishuo-snow', title: '每日书摘', name: '《世说新语》', subtitle: '咏雪', body: '未若柳絮因风起。', advice: '今天表达可以轻一点，画面感比解释更有力。', line: '好比喻一出来，空气都亮了。', scoreLabel: '共鸣度' },
  { key: 'dream-red', title: '每日书摘', name: '《红楼梦》', subtitle: '好了歌注', body: '乱哄哄你方唱罢我登场。', advice: '今天看热闹别太入戏，台上台下都会换人。', line: '人生舞台最稳定的部分，是换场。', scoreLabel: '共鸣度' },
  { key: 'journey-mountain', title: '每日书摘', name: '《西游记》', subtitle: '山高自有客行路', body: '山高自有客行路，水深自有渡船人。', advice: '今天遇到难题先找路径，别只盯着山高。', line: '路不是没有，是还没走到拐弯处。', scoreLabel: '共鸣度' },
  { key: 'water-margin', title: '每日书摘', name: '《水浒传》', subtitle: '世情', body: '人无千日好，花无百日红。', advice: '今天顺风也别飘，逆风也别把话说死。', line: '涨落是常态，心态别跟着过山车。', scoreLabel: '共鸣度' },
  { key: 'three-kingdoms', title: '每日书摘', name: '《三国演义》', subtitle: '开篇', body: '分久必合，合久必分。', advice: '今天看局势别只看当下，结构会自己找平衡。', line: '天下大势，最会提醒人别站太死。', scoreLabel: '共鸣度' },
  { key: 'fusheng', title: '每日书摘', name: '《浮生六记》', subtitle: '闲情', body: '情之所钟，虽丑不嫌。', advice: '今天珍惜自己的偏爱，它未必需要别人审核。', line: '审美有时就是偏心的证据。', scoreLabel: '共鸣度' },
  { key: 'xiaochuang', title: '每日书摘', name: '《小窗幽记》', subtitle: '醒句', body: '宠辱不惊，看庭前花开花落。', advice: '今天别让一条消息决定全天心情。', line: '花开花落都很忙，你也不用一直紧绷。', scoreLabel: '共鸣度' },
  { key: 'renjian-cihua', title: '每日书摘', name: '《人间词话》', subtitle: '境界', body: '词以境界为最上。', advice: '今天做表达先有画面，再讲道理。', line: '境界一出来，句子就站住了。', scoreLabel: '共鸣度' },
  { key: 'letter-family', title: '每日书摘', name: '《曾国藩家书》', subtitle: '勤与恒', body: '天下古今之庸人，皆以一惰字致败。', advice: '今天少拖一个小任务，别让惰性滚雪球。', line: '勤不一定轰烈，但很克制。', scoreLabel: '共鸣度' },
  { key: 'tang-caizi', title: '每日书摘', name: '《唐才子传》', subtitle: '诗心', body: '诗者，志之所之也。', advice: '今天写一句真实的话，胜过憋十句漂亮话。', line: '表达先有心，修辞后面再说。', scoreLabel: '共鸣度' },
  { key: 'wenxin', title: '每日书摘', name: '《文心雕龙》', subtitle: '神思', body: '寂然凝虑，思接千载。', advice: '今天给自己十分钟安静，别让灵感一直被通知切断。', line: '好想法需要一点无人打扰的深水区。', scoreLabel: '共鸣度' },
  { key: 'guwen', title: '每日书摘', name: '《古文观止》', subtitle: '读文', body: '文章千古事，得失寸心知。', advice: '今天做输出别急着讨好所有人，先对得起自己的判断。', line: '写得好不好，心里常有第一裁判。', scoreLabel: '共鸣度' },
  { key: 'mingxian', title: '每日书摘', name: '《名贤集》', subtitle: '惜时', body: '一寸光阴一寸金。', advice: '今天把最清醒的一小时留给最重要的事。', line: '时间不吵，但它很会结账。', scoreLabel: '共鸣度' },
];

const dailyPoems: DailyTextCard[] = [
  { key: 'li-bai-night', title: '每日古诗词', name: '李白《静夜思》', subtitle: '唐诗 / 思乡', body: '床前明月光，疑是地上霜。举头望明月，低头思故乡。', advice: '今天给远处的人发句话，别只在心里想。', line: '月光最会把距离照出来。', scoreLabel: '诗意值' },
  { key: 'du-fu-spring', title: '每日古诗词', name: '杜甫《春望》', subtitle: '唐诗 / 家国', body: '国破山河在，城春草木深。感时花溅泪，恨别鸟惊心。', advice: '今天看见细小变化，也别忘了它背后的重量。', line: '草木很轻，时代很重。', scoreLabel: '诗意值' },
  { key: 'wang-wei-bird', title: '每日古诗词', name: '王维《鸟鸣涧》', subtitle: '唐诗 / 山水', body: '人闲桂花落，夜静春山空。月出惊山鸟，时鸣春涧中。', advice: '今天留一点安静给自己，别把空白全填满。', line: '静下来，声音反而更清楚。', scoreLabel: '诗意值' },
  { key: 'meng-spring', title: '每日古诗词', name: '孟浩然《春晓》', subtitle: '唐诗 / 春日', body: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。', advice: '今天别急着赶路，先看看昨夜留下了什么。', line: '春天最会轻轻提醒人。', scoreLabel: '诗意值' },
  { key: 'liu-willow', title: '每日古诗词', name: '贺知章《咏柳》', subtitle: '唐诗 / 春景', body: '碧玉妆成一树高，万条垂下绿丝绦。', advice: '今天适合修整外在，也适合整理心情。', line: '新绿一出来，世界就有了发型。', scoreLabel: '诗意值' },
  { key: 'wang-lushan', title: '每日古诗词', name: '李白《望庐山瀑布》', subtitle: '唐诗 / 壮景', body: '飞流直下三千尺，疑是银河落九天。', advice: '今天给目标留一点想象力，别把自己算太小。', line: '夸张用得好，世界会变高。', scoreLabel: '诗意值' },
  { key: 'wang-bo', title: '每日古诗词', name: '王勃《送杜少府之任蜀州》', subtitle: '唐诗 / 送别', body: '海内存知己，天涯若比邻。', advice: '今天别怕距离，真正的关系不只靠定位。', line: '远不远，有时看心有没有在线。', scoreLabel: '诗意值' },
  { key: 'gao-shi', title: '每日古诗词', name: '高适《别董大》', subtitle: '唐诗 / 赠别', body: '莫愁前路无知己，天下谁人不识君。', advice: '今天给自己一点底气，别把未知都想成坏消息。', line: '离别也可以很有劲。', scoreLabel: '诗意值' },
  { key: 'bai-juyi-grass', title: '每日古诗词', name: '白居易《赋得古原草送别》', subtitle: '唐诗 / 离别', body: '野火烧不尽，春风吹又生。', advice: '今天允许自己重来，生命力不靠一次胜负定义。', line: '草最懂复盘。', scoreLabel: '诗意值' },
  { key: 'li-shangyin-rain', title: '每日古诗词', name: '李商隐《夜雨寄北》', subtitle: '唐诗 / 相思', body: '何当共剪西窗烛，却话巴山夜雨时。', advice: '今天把想见的人放进计划里，别只放进情绪里。', line: '夜雨很会替人攒话。', scoreLabel: '诗意值' },
  { key: 'du-mu-autumn', title: '每日古诗词', name: '杜牧《山行》', subtitle: '唐诗 / 秋色', body: '停车坐爱枫林晚，霜叶红于二月花。', advice: '今天慢一点，可能会看到赶路看不到的颜色。', line: '秋天不是结束，也可能是高光。', scoreLabel: '诗意值' },
  { key: 'wang-changling', title: '每日古诗词', name: '王昌龄《出塞》', subtitle: '唐诗 / 边塞', body: '秦时明月汉时关，万里长征人未还。', advice: '今天做难事要看长期，不要只看眼前一段路。', line: '边关的月亮，照的是很长的时间。', scoreLabel: '诗意值' },
  { key: 'cen-shen-snow', title: '每日古诗词', name: '岑参《白雪歌送武判官归京》', subtitle: '唐诗 / 边塞雪', body: '忽如一夜春风来，千树万树梨花开。', advice: '今天别急着给坏天气下结论，它可能换个样子很好看。', line: '雪一认真，也能开花。', scoreLabel: '诗意值' },
  { key: 'su-shi-moon', title: '每日古诗词', name: '苏轼《水调歌头》', subtitle: '宋词 / 中秋', body: '但愿人长久，千里共婵娟。', advice: '今天把祝愿说出口，别只藏在节日里。', line: '月亮最擅长做共享屏幕。', scoreLabel: '诗意值' },
  { key: 'su-shi-river', title: '每日古诗词', name: '苏轼《念奴娇》', subtitle: '宋词 / 怀古', body: '大江东去，浪淘尽，千古风流人物。', advice: '今天别被一时得失困住，时间会冲刷很多东西。', line: '江水一开口，人就小了。', scoreLabel: '诗意值' },
  { key: 'li-qingzhao', title: '每日古诗词', name: '李清照《如梦令》', subtitle: '宋词 / 春游', body: '争渡，争渡，惊起一滩鸥鹭。', advice: '今天可以有点冒失的快乐，但别忘了看路。', line: '热闹到惊起一滩，说明真的活过。', scoreLabel: '诗意值' },
  { key: 'xin-qiji', title: '每日古诗词', name: '辛弃疾《青玉案》', subtitle: '宋词 / 元夕', body: '众里寻他千百度，蓦然回首，那人却在灯火阑珊处。', advice: '今天别只往最亮的地方找答案。', line: '答案有时很低调，站在灯火边上。', scoreLabel: '诗意值' },
  { key: 'yue-fei', title: '每日古诗词', name: '岳飞《满江红》', subtitle: '宋词 / 壮怀', body: '莫等闲，白了少年头，空悲切。', advice: '今天别空耗，做一件能让明天少后悔的事。', line: '热血不是喊出来的，是别等闲。', scoreLabel: '诗意值' },
  { key: 'lu-you', title: '每日古诗词', name: '陆游《游山西村》', subtitle: '宋诗 / 柳暗花明', body: '山重水复疑无路，柳暗花明又一村。', advice: '今天卡住也别急，先多走两步看看。', line: '转机常常躲在弯后面。', scoreLabel: '诗意值' },
  { key: 'yang-wanli', title: '每日古诗词', name: '杨万里《小池》', subtitle: '宋诗 / 夏日', body: '小荷才露尖尖角，早有蜻蜓立上头。', advice: '今天保护刚冒头的小想法，别急着批评它。', line: '新东西刚露头，也值得被看见。', scoreLabel: '诗意值' },
];

const duelWeapons: DailyDuelWeapon[] = [
  { key: 'deagle', name: '沙鹰', style: '一发入魂', power: 92, tempo: 45, line: '准了封神，空了当场沉默。', fandomFile: 'CS2_Desert_Eagle_Inventory.png' },
  { key: 'awp', name: '大狙', style: '架点审判', power: 98, tempo: 32, line: '一枪一个道理，前提是别空。', fandomFile: 'CS2_AWP_Inventory.png' },
  { key: 'ak47', name: 'AK-47', style: '正面压制', power: 88, tempo: 72, line: '第一发稳住，后面才有故事。', fandomFile: 'CS2_AK-47_Inventory.png' },
  { key: 'm4a1s', name: 'M4A1-S', style: '消音偷人', power: 82, tempo: 68, line: '低调开枪，高调拿分。', fandomFile: 'CS2_M4A1-S_Inventory.png' },
  { key: 'glock', name: '格洛克', style: '近点抱团', power: 48, tempo: 85, line: '不贵，但很会把人冲乱。', fandomFile: 'CS2_Glock-18_Inventory.png' },
  { key: 'usp', name: 'USP-S', style: '手枪点头', power: 60, tempo: 58, line: '慢一点，第一发会说话。', fandomFile: 'CS2_USP-S_Inventory.png' },
  { key: 'flash', name: '闪光弹', style: '白屏武学', power: 70, tempo: 90, line: '不杀人，但能让对面忘了自己是谁。', fandomFile: 'Flashbanghud_csgo.png' },
  { key: 'smoke', name: '烟雾弹', style: '切割战场', power: 58, tempo: 64, line: '看不见，也是一种压迫。', fandomFile: 'Smokegrenadehud_csgo.png' },
  { key: 'zeus', name: '电击枪', style: '贴脸天雷', power: 95, tempo: 25, line: '距离到了就很不讲理。', fandomFile: 'CS2_Zeus_x27_Inventory.png' },
  { key: 'knife', name: '小刀', style: '精神羞辱', power: 100, tempo: 18, line: '赢了上嘴脸，输了上素材。', fandomFile: 'Cs2-knife-bayonet-stock-market.png' },
  { key: 'p90', name: 'P90', style: '横冲直撞', power: 62, tempo: 96, line: '不解释，先跑起来。', fandomFile: 'CS2_P90_Inventory.png' },
  { key: 'nova', name: 'Nova', style: '近点伏击', power: 76, tempo: 38, line: '距离对了就是答案。', fandomFile: 'CS2_Nova_Inventory.png' },
  { key: 'negev', name: '内格夫', style: '弹幕压制', power: 84, tempo: 30, line: '扫得很热闹，命中就更热闹。', fandomFile: 'CS2_Negev_Inventory.png' },
  { key: 'r8', name: '左轮', style: '慢热怪力', power: 90, tempo: 22, line: '枪声很大，责任也很大。', fandomFile: 'CS2_R8_Revolver_Inventory.png' },
  { key: 'folding-chair', name: '折凳', style: '江湖暗器', power: 73, tempo: 70, line: '朴素，但是很有画面。' },
  { key: 'keyboard', name: '机械键盘', style: '键气外放', power: 66, tempo: 88, line: '手速起来了，谁都别想说完整话。' },
  { key: 'thermos', name: '保温杯', style: '养生重击', power: 59, tempo: 40, line: '看着温和，砸下来很现实。' },
  { key: 'mouse', name: '鼠标', style: '微操决胜', power: 55, tempo: 94, line: 'DPI 一拉，气势先到。' },
  { key: 'baguette', name: '法棍', style: '长枪替身', power: 52, tempo: 62, line: '硬度和节目效果都在线。' },
  { key: 'slipper', name: '拖鞋', style: '家庭秘传', power: 80, tempo: 76, line: '出手很轻，威慑很重。' },
];

dailyFacts.push(
  { key: 'pencil-space', title: '每日冷知识', name: '铅笔不能在太空随便替代钢笔', subtitle: '航天 / 材料', body: '铅笔碎屑和石墨粉在失重环境里可能带来导电、吸入和漂浮污染风险，所以航天书写工具要考虑很多安全细节。', advice: '今天别把“简单替代”想得太简单，环境一变，风险也会变。', line: '不是铅笔不行，是太空不吃这一套。', scoreLabel: '新鲜度' },
  { key: 'blue-blood', title: '每日冷知识', name: '鲎的血液呈蓝色', subtitle: '生物 / 医学', body: '鲎血里含有以铜为核心的血蓝蛋白，遇氧后呈蓝色；相关试剂还曾被广泛用于检测细菌内毒素。', advice: '今天看见奇怪颜色，先问它背后的元素。', line: '蓝不是滤镜，是化学在营业。', scoreLabel: '新鲜度' },
  { key: 'rain-smell', title: '每日冷知识', name: '雨后土味有名字', subtitle: '气味 / 微生物', body: '雨后泥土气味常和土壤细菌产生的土臭素有关，雨滴把它带进空气里，人就闻到了“下雨味”。', advice: '今天别小看气味，它常常是环境的消息推送。', line: '雨味不是玄学，是土壤在发通知。', scoreLabel: '新鲜度' },
  { key: 'penguin-knees', title: '每日冷知识', name: '企鹅其实有膝盖', subtitle: '动物 / 骨骼', body: '企鹅短腿外观下藏着完整腿骨结构，膝关节被羽毛和身体轮廓遮住了。', advice: '今天别只看外形，结构可能藏得很深。', line: '看着没腿，不代表没有关节。', scoreLabel: '新鲜度' },
  { key: 'moon-leaving', title: '每日冷知识', name: '月球正在慢慢远离地球', subtitle: '天文 / 潮汐', body: '潮汐相互作用让月球平均每年远离地球约几厘米，尺度很小，但长期很有戏。', advice: '今天别忽略慢变量，它们最会改写长期结局。', line: '有些告别慢到像没发生，但一直在发生。', scoreLabel: '新鲜度' },
  { key: 'tongue-map', title: '每日冷知识', name: '舌头味觉地图并不准确', subtitle: '人体 / 味觉', body: '甜酸苦咸鲜不是严格分区感知，舌头很多区域都能感受多种味道。', advice: '今天遇到老图老说法，别急着当真。', line: '教材图有时也会被时代修正。', scoreLabel: '新鲜度' },
  { key: 'paper-cuts', title: '每日冷知识', name: '纸割伤格外疼', subtitle: '人体 / 材料', body: '纸边缘会造成浅而不整齐的切口，手指神经末梢密集，又常接触空气和水，所以疼得很有存在感。', advice: '今天别低估小伤害，细碎但持续的东西最烦。', line: '纸很薄，但它很会找痛点。', scoreLabel: '新鲜度' },
  { key: 'ants-sleep', title: '每日冷知识', name: '蚂蚁会短时多次休息', subtitle: '动物 / 行为', body: '一些蚂蚁会用大量短暂休息片段拼出睡眠，不像人类这样整块睡。', advice: '今天精力不够就拆小段恢复，不一定非要等大块空闲。', line: '碎片化休息，也是休息。', scoreLabel: '新鲜度' },
  { key: 'eiffel-summer', title: '每日冷知识', name: '埃菲尔铁塔会热胀冷缩', subtitle: '工程 / 材料', body: '金属受温度影响会膨胀收缩，埃菲尔铁塔高度会随季节和温度发生小幅变化。', advice: '今天别把测量结果看成绝对静止，环境会动手脚。', line: '钢铁也有热胀冷缩的小情绪。', scoreLabel: '新鲜度' },
  { key: 'sound-mars', title: '每日冷知识', name: '火星上的声音传播不一样', subtitle: '行星 / 声学', body: '火星大气稀薄且成分不同，声音传播速度、衰减和高低频表现都和地球不同。', advice: '今天换了环境，就别沿用旧耳朵。', line: '同一句话，到火星也会变味。', scoreLabel: '新鲜度' },
  { key: 'salt-salary', title: '每日冷知识', name: 'salary 与盐有历史关系', subtitle: '词源 / 文化', body: '英语 salary 常被认为和拉丁语 salarium 有关，背后连着盐在古代经济里的重要性。', advice: '今天看一个词，可以顺手翻出一段生活史。', line: '工资和盐，曾经离得很近。', scoreLabel: '新鲜度' },
  { key: 'mammoth-pyramid', title: '每日冷知识', name: '金字塔时代仍有猛犸象', subtitle: '历史 / 演化', body: '部分孤岛猛犸象存活到约四千年前，和埃及金字塔时期在时间上有重叠。', advice: '今天别把远古生物都塞进同一个“很久以前”。', line: '时间线一对齐，世界会突然很魔幻。', scoreLabel: '新鲜度' },
  { key: 'barcode-country', title: '每日冷知识', name: '条形码前三位不等于产地', subtitle: '商业 / 编码', body: '条形码前缀通常对应编码组织，不一定代表商品真实生产地。', advice: '今天看标签要看完整信息，别用一个数字下结论。', line: '编码不是户口本。', scoreLabel: '新鲜度' },
  { key: 'ice-clear', title: '每日冷知识', name: '透明冰和冻结方向有关', subtitle: '物理 / 生活', body: '家用冰块常因气泡和杂质被困住而发白，定向冻结能把气泡挤到一侧，冰就更透明。', advice: '今天想要结果干净，过程方向也要设计。', line: '清澈不是运气，是气泡被安排明白了。', scoreLabel: '新鲜度' },
  { key: 'spider-silk', title: '每日冷知识', name: '蜘蛛丝强韧但难量产', subtitle: '材料 / 生物', body: '蜘蛛丝性能优秀，但蜘蛛领地性强、产量和加工难度高，工业化复制一直不简单。', advice: '今天别只看材料参数，也要看生产系统。', line: '好东西不一定好量产。', scoreLabel: '新鲜度' },
  { key: 'earwax-types', title: '每日冷知识', name: '耳屎有干湿类型', subtitle: '遗传 / 人体', body: '耳垢干湿和 ABCC11 基因变体有关，不同人群分布差异明显。', advice: '今天别把身体小差异都当习惯问题，有些写在基因里。', line: '连耳垢都有遗传路线。', scoreLabel: '新鲜度' },
  { key: 'blue-sky', title: '每日冷知识', name: '天空蓝来自散射', subtitle: '物理 / 光', body: '大气分子更容易散射短波长蓝光，所以晴天天空常呈蓝色。', advice: '今天看见日常现象，别忘了它背后也有公式。', line: '蓝天不是背景板，是光在拐弯。', scoreLabel: '新鲜度' },
  { key: 'seed-vault', title: '每日冷知识', name: '世界上有种子库', subtitle: '农业 / 保存', body: '斯瓦尔巴全球种子库储存大量作物种子样本，用于保护农业遗传多样性。', advice: '今天做备份别嫌麻烦，未来最怕没有备用方案。', line: '真正的安全感，有时是一粒种子。', scoreLabel: '新鲜度' },
  { key: 'train-track', title: '每日冷知识', name: '铁轨之间要留伸缩缝', subtitle: '工程 / 热胀冷缩', body: '钢轨受温度变化会伸缩，工程上要通过缝隙、扣件和无缝线路设计处理热应力。', advice: '今天给系统留余量，别把所有东西卡死。', line: '不给伸缩空间，就等着变形。', scoreLabel: '新鲜度' },
  { key: 'soap-clean', title: '每日冷知识', name: '肥皂靠两亲结构清洁', subtitle: '化学 / 生活', body: '肥皂分子一头亲水一头亲油，能把油污包进胶束里带走。', advice: '今天解决矛盾，找一个能同时牵住两边的结构。', line: '会清洁，是因为它左右逢源。', scoreLabel: '新鲜度' },
);

dailyBookExcerpts.push(
  { key: 'shijing-deer', title: '每日书摘', name: '《诗经》', subtitle: '鹿鸣', body: '呦呦鹿鸣，食野之苹。', advice: '今天可以主动招呼朋友，别总等别人开口。', line: '好关系也需要一点邀请。', scoreLabel: '共鸣度' },
  { key: 'chuci-road', title: '每日书摘', name: '《楚辞》', subtitle: '离骚', body: '路漫漫其修远兮，吾将上下而求索。', advice: '今天别怕路长，先把下一步走实。', line: '求索不是鸡血，是长期动作。', scoreLabel: '共鸣度' },
  { key: 'shiji-life', title: '每日书摘', name: '《史记》', subtitle: '报任安书', body: '人固有一死，或重于泰山，或轻于鸿毛。', advice: '今天做判断时，想想什么值得认真。', line: '分量感，是选择给出来的。', scoreLabel: '共鸣度' },
  { key: 'han-shu', title: '每日书摘', name: '《汉书》', subtitle: '艺文志', body: '河出图，洛出书。', advice: '今天看知识体系，先找源头和脉络。', line: '传统里常藏着一张地图。', scoreLabel: '共鸣度' },
  { key: 'tao-peach', title: '每日书摘', name: '陶渊明《桃花源记》', subtitle: '忽逢桃花林', body: '芳草鲜美，落英缤纷。', advice: '今天给自己留一小段不被打扰的地方。', line: '桃花源不一定远，可能只是十分钟安静。', scoreLabel: '共鸣度' },
  { key: 'wang-xizhi', title: '每日书摘', name: '王羲之《兰亭集序》', subtitle: '俯仰之间', body: '仰观宇宙之大，俯察品类之盛。', advice: '今天把视角拉远一点，小烦恼会变小。', line: '一仰一俯，格局就换了。', scoreLabel: '共鸣度' },
  { key: 'han-yu', title: '每日书摘', name: '韩愈《师说》', subtitle: '闻道有先后', body: '闻道有先后，术业有专攻。', advice: '今天别拿自己短板硬比别人的长项。', line: '专业分工，不是认输。', scoreLabel: '共鸣度' },
  { key: 'liu-zongyuan', title: '每日书摘', name: '柳宗元《小石潭记》', subtitle: '清冽', body: '潭中鱼可百许头，皆若空游无所依。', advice: '今天看事物可以慢一点，细节会自己浮出来。', line: '透明感来自观察，不来自滤镜。', scoreLabel: '共鸣度' },
  { key: 'ouyang', title: '每日书摘', name: '欧阳修《醉翁亭记》', subtitle: '山水之乐', body: '醉翁之意不在酒，在乎山水之间也。', advice: '今天做事别只看表面目标，真正想要的也许在旁边。', line: '借酒说山水，高手。', scoreLabel: '共鸣度' },
  { key: 'fan-zhongyan', title: '每日书摘', name: '范仲淹《岳阳楼记》', subtitle: '忧乐', body: '先天下之忧而忧，后天下之乐而乐。', advice: '今天多承担一点，但别把自己耗空。', line: '大格局也需要好体力。', scoreLabel: '共鸣度' },
  { key: 'zhou-dunyi', title: '每日书摘', name: '周敦颐《爱莲说》', subtitle: '莲', body: '出淤泥而不染，濯清涟而不妖。', advice: '今天守住一点清爽，不必跟着环境变浑。', line: '干净不是脆弱，是有边界。', scoreLabel: '共鸣度' },
  { key: 'sima-guang', title: '每日书摘', name: '《资治通鉴》', subtitle: '鉴前世', body: '鉴前世之兴衰，考当今之得失。', advice: '今天做决定前，翻翻旧账不是坏事。', line: '历史不是答案库，是避坑图。', scoreLabel: '共鸣度' },
  { key: 'zhuzi', title: '每日书摘', name: '《朱子家训》', subtitle: '黎明即起', body: '黎明即起，洒扫庭除。', advice: '今天先整理环境，再整理心情。', line: '房间一清，脑子也少堵一点。', scoreLabel: '共鸣度' },
  { key: 'liaozhai', title: '每日书摘', name: '《聊斋志异》', subtitle: '异事', body: '有花有酒春常在，无烛无灯夜自明。', advice: '今天给生活留点奇气，别太平铺直叙。', line: '怪谈也懂浪漫。', scoreLabel: '共鸣度' },
  { key: 'rulin', title: '每日书摘', name: '《儒林外史》', subtitle: '世相', body: '功名富贵无凭据，费尽心情，总把流光误。', advice: '今天别为了虚名错过真实进度。', line: '最贵的是被误掉的流光。', scoreLabel: '共鸣度' },
  { key: 'jinghua', title: '每日书摘', name: '《镜花缘》', subtitle: '见闻', body: '学问无大小，能者为尊。', advice: '今天多向会的人学，少纠结资历排序。', line: '会就是会，很朴素。', scoreLabel: '共鸣度' },
  { key: 'sun-bin', title: '每日书摘', name: '《孙膑兵法》', subtitle: '势备', body: '胜不可一。', advice: '今天别指望一种方法打所有局。', line: '策略最怕一招鲜硬吃天下。', scoreLabel: '共鸣度' },
  { key: 'mozi', title: '每日书摘', name: '《墨子》', subtitle: '兼爱', body: '兼相爱，交相利。', advice: '今天合作先看互利结构，别只靠情绪推动。', line: '关系稳定，常常因为彼此都有得。', scoreLabel: '共鸣度' },
  { key: 'guanzi', title: '每日书摘', name: '《管子》', subtitle: '仓廪', body: '仓廪实而知礼节。', advice: '今天先补基础资源，很多状态问题会跟着好转。', line: '底盘稳了，体面才站得住。', scoreLabel: '共鸣度' },
  { key: 'yanzi', title: '每日书摘', name: '《晏子春秋》', subtitle: '橘枳', body: '橘生淮南则为橘，生于淮北则为枳。', advice: '今天别只怪个人，环境也会塑形。', line: '换个土壤，结果可能完全不同。', scoreLabel: '共鸣度' },
);

dailyPoems.push(
  { key: 'wang-zhihuan-tower', title: '每日古诗词', name: '王之涣《登鹳雀楼》', subtitle: '唐诗 / 登临', body: '欲穷千里目，更上一层楼。', advice: '今天想看远一点，就先把自己抬高一点。', line: '视野问题，有时是楼层问题。', scoreLabel: '诗意值' },
  { key: 'li-bai-baidi', title: '每日古诗词', name: '李白《早发白帝城》', subtitle: '唐诗 / 轻快', body: '两岸猿声啼不住，轻舟已过万重山。', advice: '今天顺起来就别回头怀疑，先过山。', line: '轻舟的爽感，是困难突然被甩在后面。', scoreLabel: '诗意值' },
  { key: 'du-fu-mountain', title: '每日古诗词', name: '杜甫《望岳》', subtitle: '唐诗 / 登高', body: '会当凌绝顶，一览众山小。', advice: '今天给自己一个高一点的目标，但脚下要实。', line: '豪气也要爬台阶。', scoreLabel: '诗意值' },
  { key: 'wang-wei-deer', title: '每日古诗词', name: '王维《鹿柴》', subtitle: '唐诗 / 空山', body: '空山不见人，但闻人语响。', advice: '今天别只看有没有人，听听回声里有什么。', line: '空，不等于没有内容。', scoreLabel: '诗意值' },
  { key: 'liu-yuxi-autumn', title: '每日古诗词', name: '刘禹锡《秋词》', subtitle: '唐诗 / 秋气', body: '晴空一鹤排云上，便引诗情到碧霄。', advice: '今天别把秋天当低落，抬头看看。', line: '一只鹤就能把情绪拉高。', scoreLabel: '诗意值' },
  { key: 'jia-dao', title: '每日古诗词', name: '贾岛《寻隐者不遇》', subtitle: '唐诗 / 寻访', body: '只在此山中，云深不知处。', advice: '今天找不到答案也别急，至少方向已经接近。', line: '云深不知处，也是一种线索。', scoreLabel: '诗意值' },
  { key: 'meng-haoran-old-friend', title: '每日古诗词', name: '孟浩然《过故人庄》', subtitle: '唐诗 / 田园', body: '待到重阳日，还来就菊花。', advice: '今天把“下次再聚”落实成真的日期。', line: '好友情需要下一次。', scoreLabel: '诗意值' },
  { key: 'zhang-ji', title: '每日古诗词', name: '张继《枫桥夜泊》', subtitle: '唐诗 / 夜泊', body: '姑苏城外寒山寺，夜半钟声到客船。', advice: '今天夜里别硬撑，听到钟声就收一收。', line: '夜半的声音最容易进心里。', scoreLabel: '诗意值' },
  { key: 'li-he', title: '每日古诗词', name: '李贺《雁门太守行》', subtitle: '唐诗 / 边塞', body: '黑云压城城欲摧，甲光向日金鳞开。', advice: '今天压力很重，也要把自己的亮面撑出来。', line: '黑云越厚，甲光越显眼。', scoreLabel: '诗意值' },
  { key: 'wen-tingyun', title: '每日古诗词', name: '温庭筠《商山早行》', subtitle: '唐诗 / 早行', body: '鸡声茅店月，人迹板桥霜。', advice: '今天早一点动身，路上的细节会多。', line: '清晨自带电影感。', scoreLabel: '诗意值' },
  { key: 'yan-shu', title: '每日古诗词', name: '晏殊《浣溪沙》', subtitle: '宋词 / 惜春', body: '无可奈何花落去，似曾相识燕归来。', advice: '今天接受一点失去，也等一点回来。', line: '生活很会一边落花一边归燕。', scoreLabel: '诗意值' },
  { key: 'qin-guan', title: '每日古诗词', name: '秦观《鹊桥仙》', subtitle: '宋词 / 相会', body: '两情若是久长时，又岂在朝朝暮暮。', advice: '今天别用频率替代质量。', line: '久长不是天天刷存在感。', scoreLabel: '诗意值' },
  { key: 'zhou-bangyan', title: '每日古诗词', name: '周邦彦《苏幕遮》', subtitle: '宋词 / 夏夜', body: '叶上初阳干宿雨，水面清圆，一一风荷举。', advice: '今天把昨夜的湿气晾一晾，再重新站起来。', line: '荷叶最懂清爽开局。', scoreLabel: '诗意值' },
  { key: 'jiang-kui', title: '每日古诗词', name: '姜夔《扬州慢》', subtitle: '宋词 / 怀古', body: '二十四桥仍在，波心荡，冷月无声。', advice: '今天路过旧地方，允许自己沉默一下。', line: '有些月亮冷，是因为它照过太多事。', scoreLabel: '诗意值' },
  { key: 'li-yu', title: '每日古诗词', name: '李煜《虞美人》', subtitle: '词 / 春花秋月', body: '问君能有几多愁，恰似一江春水向东流。', advice: '今天情绪很满就找出口，别堵在心里。', line: '愁一多，就会自己成河。', scoreLabel: '诗意值' },
  { key: 'yan-jidao', title: '每日古诗词', name: '晏几道《临江仙》', subtitle: '宋词 / 记梦', body: '落花人独立，微雨燕双飞。', advice: '今天适合安静一点，不必把孤独说得太大声。', line: '微雨很轻，但画面很重。', scoreLabel: '诗意值' },
  { key: 'lu-you-mei', title: '每日古诗词', name: '陆游《卜算子》', subtitle: '宋词 / 咏梅', body: '零落成泥碾作尘，只有香如故。', advice: '今天守住一点底色，别被环境磨没。', line: '真正的香气，落地也还在。', scoreLabel: '诗意值' },
  { key: 'xin-qiji-village', title: '每日古诗词', name: '辛弃疾《西江月》', subtitle: '宋词 / 夜行', body: '稻花香里说丰年，听取蛙声一片。', advice: '今天别只看结果，过程里的声音也很踏实。', line: '丰年有时先从蛙声里冒头。', scoreLabel: '诗意值' },
  { key: 'ma-zhiyuan', title: '每日古诗词', name: '马致远《天净沙》', subtitle: '元曲 / 秋思', body: '夕阳西下，断肠人在天涯。', advice: '今天想家就承认，不必假装很潇洒。', line: '天涯两个字，最会让人安静。', scoreLabel: '诗意值' },
  { key: 'yu-qian', title: '每日古诗词', name: '于谦《石灰吟》', subtitle: '明诗 / 气节', body: '粉骨碎身浑不怕，要留清白在人间。', advice: '今天守住原则，别为了省事把底线卖了。', line: '清白两个字，很硬。', scoreLabel: '诗意值' },
);

csSkins.push(
  { key: 'm4a4-asiimov', title: '今日CS皮肤', name: 'M4A4 | Asiimov', weapon: 'M4A4', rarity: 'Covert', subtitle: '白橙科幻 / 老牌大枪皮', scoreLabel: '出货指数', advice: '弹量优势用来转移和压制，别扫到自己都慌。', avoid: '别皮肤很科幻，打法很原始。', line: 'M4A4二西莫夫签，干净点。', fandomFile: 'M4A4_Asiimov.png', fandomPage: 'Asiimov' },
  { key: 'm4a4-desolate-space', title: '今日CS皮肤', name: 'M4A4 | Desolate Space', weapon: 'M4A4', rarity: 'Classified', subtitle: '荒凉太空 / 冷色压迫', scoreLabel: '出货指数', advice: '今天别站桩，打完一波马上换位。', avoid: '别荒凉的是队伍经济。', line: '荒凉太空签，画面可以冷，人别冷场。', fandomFile: 'M4A4_Desolate_Space.png' },
  { key: 'usp-orion', title: '今日CS皮肤', name: 'USP-S | Orion', weapon: 'USP-S', rarity: 'Classified', subtitle: '猎户 / 经典手枪皮', scoreLabel: '出货指数', advice: '手枪局第一枪别急，头线放稳。', avoid: '别猎户没猎到，自己先被点。', line: 'Orion签，老手枪味。', fandomFile: 'USP-S_Orion.png' },
  { key: 'usp-printstream', title: '今日CS皮肤', name: 'USP-S | Printstream', weapon: 'USP-S', rarity: 'Classified', subtitle: '印花集 / 黑白珍珠', scoreLabel: '出货指数', advice: '点射要干净，别连续peek送第二枪。', avoid: '别皮肤极简，操作极乱。', line: 'USP印花集签，干净就完事。', fandomFile: 'USP-S_Printstream.png', fandomPage: 'Printstream' },
  { key: 'glock-water-elemental', title: '今日CS皮肤', name: 'Glock-18 | Water Elemental', weapon: 'Glock-18', rarity: 'Classified', subtitle: '水灵 / 手枪局老朋友', scoreLabel: '出货指数', advice: '抱团近点集火，别远点单点硬耗。', avoid: '别水灵变水枪。', line: '水灵签，手枪局别散。', fandomFile: 'Glock-18_Water_Elemental.png' },
  { key: 'glock-vogue', title: '今日CS皮肤', name: 'Glock-18 | Vogue', weapon: 'Glock-18', rarity: 'Classified', subtitle: '时尚 / 高饱和配色', scoreLabel: '出货指数', advice: '提速可以，但要有补枪，不要一个人开秀。', avoid: '别时尚走秀走到包点门口倒了。', line: 'Vogue签，节目效果先到。', fandomFile: 'Glock-18_Vogue.png' },
  { key: 'deagle-printstream', title: '今日CS皮肤', name: 'Desert Eagle | Printstream', weapon: 'Desert Eagle', rarity: 'Covert', subtitle: '印花集沙鹰 / 一发头信仰', scoreLabel: '出货指数', advice: '等停稳再开枪，别让皮肤替你瞄准。', avoid: '别七发全空还在看珍珠光。', line: '沙鹰印花集签，一发有说法。', fandomFile: 'Desert_Eagle_Printstream.png', fandomPage: 'Printstream' },
  { key: 'deagle-code-red', title: '今日CS皮肤', name: 'Desert Eagle | Code Red', weapon: 'Desert Eagle', rarity: 'Covert', subtitle: '红色代号 / 高压单点', scoreLabel: '出货指数', advice: '别急，沙鹰越急越没戏。', avoid: '别红色代号变红温代号。', line: 'Code Red签，先稳第一发。', fandomFile: 'Desert_Eagle_Code_Red.png' },
  { key: 'galil-chatterbox', title: '今日CS皮肤', name: 'Galil AR | Chatterbox', weapon: 'Galil AR', rarity: 'Covert', subtitle: '喧闹骷髅 / 穷哥们也有排面', scoreLabel: '出货指数', advice: '便宜枪也要控好前十发，别嫌弃。', avoid: '别嘴比枪还碎。', line: '喋喋不休签，枪别碎。', fandomFile: 'Galil_AR_Chatterbox.png' },
  { key: 'galil-eco', title: '今日CS皮肤', name: 'Galil AR | Eco', weapon: 'Galil AR', rarity: 'Classified', subtitle: '经济环保 / 性价比精神', scoreLabel: '出货指数', advice: '今天主打性价比，能换一个就不亏。', avoid: '别经济枪打成捐款枪。', line: 'Eco签，很符合钱包。', fandomFile: 'Galil_AR_Eco.png' },
  { key: 'famas-mecha', title: '今日CS皮肤', name: 'FAMAS | Mecha Industries', weapon: 'FAMAS', rarity: 'Classified', subtitle: '机械工业 / 半甲局硬撑', scoreLabel: '出货指数', advice: '靠位置和交叉火力打，别正面硬碰AK。', avoid: '别枪机械，人没脑。', line: 'FAMAS机械签，会过日子。', fandomFile: 'FAMAS_Mecha_Industries.png' },
  { key: 'famas-commemoration', title: '今日CS皮肤', name: 'FAMAS | Commemoration', weapon: 'FAMAS', rarity: 'Covert', subtitle: '纪念碑 / 金色压迫', scoreLabel: '出货指数', advice: '经济枪也要打出仪式感，第一波别掉。', avoid: '别纪念的是自己白给。', line: '纪念碑签，别让队友给你立碑。', fandomFile: 'FAMAS_Commemoration.png' },
  { key: 'aug-chameleon', title: '今日CS皮肤', name: 'AUG | Chameleon', weapon: 'AUG', rarity: 'Covert', subtitle: '变色龙 / 开镜稳定', scoreLabel: '出货指数', advice: '长枪线拿完优势就换位，别一直开镜发呆。', avoid: '别变色龙变成固定靶。', line: 'AUG变色龙签，别站死。', fandomFile: 'AUG_Chameleon.png' },
  { key: 'aug-bengal', title: '今日CS皮肤', name: 'AUG | Bengal Tiger', weapon: 'AUG', rarity: 'Classified', subtitle: '孟加拉虎 / 老皮肤气质', scoreLabel: '出货指数', advice: '开镜架点可以，但换位要快。', avoid: '别虎皮披上，打法像猫步。', line: '孟加拉虎签，有点老派。', fandomFile: 'AUG_Bengal_Tiger.png' },
  { key: 'sg-integrale', title: '今日CS皮肤', name: 'SG 553 | Integrale', weapon: 'SG 553', rarity: 'Classified', subtitle: '整合 / 稀有感强', scoreLabel: '出货指数', advice: '远点拿信息和首杀，别开镜走太慢。', avoid: '别走位慢到像没加载完。', line: 'Integrale签，懂的都懂。', fandomFile: 'SG_553_Integrale.png' },
  { key: 'sg-cyrex', title: '今日CS皮肤', name: 'SG 553 | Cyrex', weapon: 'SG 553', rarity: 'Classified', subtitle: '红黑科技 / 远点压制', scoreLabel: '出货指数', advice: '开镜打一枪就走，别在同一条线等复仇。', avoid: '别科技感有了，撤退键没了。', line: 'Cyrex签，红黑经典。', fandomFile: 'SG_553_Cyrex.png' },
  { key: 'p250-see-ya', title: '今日CS皮肤', name: 'P250 | See Ya Later', weapon: 'P250', rarity: 'Covert', subtitle: '鳄鱼 / 低成本狠活', scoreLabel: '出货指数', advice: '贴近点第一枪，杀一个就是赚。', avoid: '别还没later，自己先see ya。', line: 'P250鳄鱼签，小枪也能咬人。', fandomFile: 'P250_See_Ya_Later.png' },
  { key: 'p250-asiimov', title: '今日CS皮肤', name: 'P250 | Asiimov', weapon: 'P250', rarity: 'Classified', subtitle: '小二西莫夫 / 经济局科幻', scoreLabel: '出货指数', advice: '别贪远点，贴近打破甲价值。', avoid: '别皮肤比eco计划更完整。', line: 'P250二西莫夫签，穷但帅。', fandomFile: 'P250_Asiimov.png', fandomPage: 'Asiimov' },
  { key: 'five-seven-hyper-beast', title: '今日CS皮肤', name: 'Five-SeveN | Hyper Beast', weapon: 'Five-SeveN', rarity: 'Covert', subtitle: '暴怒野兽 / CT近点爆发', scoreLabel: '出货指数', advice: '等对面进距离再开火，别远点对步枪。', avoid: '别野兽没咬到，人先倒。', line: '57暴怒野兽签，近点有说法。', fandomFile: 'Five-SeveN_Hyper_Beast.png', fandomPage: 'Hyper Beast' },
  { key: 'five-seven-monkey-business', title: '今日CS皮肤', name: 'Five-SeveN | Monkey Business', weapon: 'Five-SeveN', rarity: 'Classified', subtitle: '猴戏 / 近点整活', scoreLabel: '出货指数', advice: '近点打交叉，别真的开始猴。', avoid: '别整活整到队友沉默。', line: '猴戏签，节目效果很足。', fandomFile: 'Five-SeveN_Monkey_Business.png' },
  { key: 'tec9-fuel-injector', title: '今日CS皮肤', name: 'Tec-9 | Fuel Injector', weapon: 'Tec-9', rarity: 'Classified', subtitle: '燃料喷射 / 提速硬冲', scoreLabel: '出货指数', advice: '吃闪提速，第一身位要换到空间。', avoid: '别喷射到半路没人补。', line: 'Tec-9燃料签，冲但别孤独。', fandomFile: 'Tec-9_Fuel_Injector.png' },
  { key: 'tec9-decimator', title: '今日CS皮肤', name: 'Tec-9 | Decimator', weapon: 'Tec-9', rarity: 'Classified', subtitle: '屠杀者 / 紫粉科技', scoreLabel: '出货指数', advice: '近点硬一点，死也要给信息。', avoid: '别紫粉很亮，信息很暗。', line: 'Decimator签，提速有画面。', fandomFile: 'Tec-9_Decimator.png' },
  { key: 'p90-death-by-kitty', title: '今日CS皮肤', name: 'P90 | Death by Kitty', weapon: 'P90', rarity: 'Covert', subtitle: '喵喵杀机 / 老牌整活', scoreLabel: '出货指数', advice: '近点压迫可以，别中远距离硬扫。', avoid: '别猫还没出手，自己先倒。', line: 'P90猫猫签，欢乐但别乱。', fandomFile: 'P90_Death_by_Kitty.png' },
  { key: 'p90-asiimov', title: '今日CS皮肤', name: 'P90 | Asiimov', weapon: 'P90', rarity: 'Covert', subtitle: 'P90二西莫夫 / 跑打科幻', scoreLabel: '出货指数', advice: '打近点压迫，杀一个就换位。', avoid: '别科幻冲锋变科幻白给。', line: 'P90二西莫夫签，节目和火力都有。', fandomFile: 'P90_Asiimov.png', fandomPage: 'Asiimov' },
  { key: 'xm-tranquility', title: '今日CS皮肤', name: 'XM1014 | Tranquility', weapon: 'XM1014', rarity: 'Classified', subtitle: '宁静 / 近点不宁静', scoreLabel: '出货指数', advice: '守窄口和近点，打完马上换位。', avoid: '别追出去和步枪讲道理。', line: '连喷宁静签，名字越静越脏。', fandomFile: 'XM1014_Tranquility.png' },
  { key: 'xm-seasons', title: '今日CS皮肤', name: 'XM1014 | Seasons', weapon: 'XM1014', rarity: 'Restricted', subtitle: '四季 / 霰弹小清新', scoreLabel: '出货指数', advice: '今天用近点和道具偷价值，别贪远。', avoid: '别四季轮换，经济也轮没。', line: 'XM四季签，近点等人来。', fandomFile: 'XM1014_Seasons.png' },
  { key: 'ssg-dragonfire', title: '今日CS皮肤', name: 'SSG 08 | Dragonfire', weapon: 'SSG 08', rarity: 'Covert', subtitle: '龙火 / 轻狙威胁', scoreLabel: '出货指数', advice: '打一枪就走，靠机动性赚信息。', avoid: '别轻狙重站桩。', line: '鸟狙龙火签，轻但有火。', fandomFile: 'SSG_08_Dragonfire.png' },
  { key: 'ssg-bloodshot', title: '今日CS皮肤', name: 'SSG 08 | Bloodshot', weapon: 'SSG 08', rarity: 'Classified', subtitle: '血腥快照 / 经济局威慑', scoreLabel: '出货指数', advice: '第一枪压住，空了就撤，别留第二枪给对面。', avoid: '别截图没截到，自己先上镜。', line: 'Bloodshot签，打一枪就跑。', fandomFile: 'SSG_08_Bloodshot.png' },
);

csTeams.push(
  { key: 'nip', title: '今日CS队伍', name: 'Ninjas in Pyjamas', subtitle: '老牌豪门 / 体系重塑', scoreLabel: '签位强度', advice: '先把默认和补枪做完整，别只靠队名加成。', avoid: '别老牌味只剩回忆。', line: 'NiP签有历史包袱，今天得靠回合说话。', liquipediaPage: 'Ninjas in Pyjamas', playerImageFallback: 'f0rest' },
  { key: 'fnatic', title: '今日CS队伍', name: 'fnatic', subtitle: '经典豪门 / 中期调整', scoreLabel: '签位强度', advice: '少乱转，多确认信息，别把老经验打成老问题。', avoid: '别优势局先怀旧。', line: 'fnatic签老味很足，细节也得跟上。', liquipediaPage: 'Fnatic', playerImageFallback: 'olofmeister' },
  { key: 'cloud9', title: '今日CS队伍', name: 'Cloud9', subtitle: '北美名门 / 国际阵容语境', scoreLabel: '签位强度', advice: '靠个人能力开局面，但别让回合结构散掉。', avoid: '别打着打着像临时组队。', line: 'C9签有流量，流量不能替你补枪。', liquipediaPage: 'Cloud9', playerImageFallback: 'sh1ro' },
  { key: 'ence', title: '今日CS队伍', name: 'ENCE', subtitle: '欧洲体系 / 默认和纪律', scoreLabel: '签位强度', advice: '今天慢控要有目的，拿到信息再提速。', avoid: '别默认默认到时间没了。', line: 'ENCE签就是把小细节磨出来。', liquipediaPage: 'ENCE', playerImageFallback: 'gla1ve' },
  { key: 'gamerlegion', title: '今日CS队伍', name: 'GamerLegion', subtitle: '黑马气质 / 执行和韧性', scoreLabel: '签位强度', advice: '别怕强队，先把自己回合打完整。', avoid: '别领先后突然不会收。', line: 'GL签经常有惊喜，但惊喜要靠纪律。', liquipediaPage: 'GamerLegion', playerImageFallback: 'siuhy' },
  { key: 'saw', title: '今日CS队伍', name: 'SAW', subtitle: '葡萄牙体系 / 团队执行', scoreLabel: '签位强度', advice: '道具和同步要打满，靠团队交换磨回合。', avoid: '别单点硬拉把体系拆了。', line: 'SAW签不花，但很讲耐心。', liquipediaPage: 'SAW' },
  { key: 'flyquest', title: '今日CS队伍', name: 'FlyQuest', subtitle: '大洋洲代表 / 冲击节奏', scoreLabel: '签位强度', advice: '正面可以敢打，但补枪距离别断。', avoid: '别打快变成送快。', line: 'FlyQuest签有冲劲，先别自己断电。', liquipediaPage: 'FlyQuest' },
  { key: 'mibr', title: '今日CS队伍', name: 'MIBR', subtitle: '巴西传统 / 情绪和枪法', scoreLabel: '签位强度', advice: '气势要有，细节也要有，别只靠吼。', avoid: '别第一波没换到就红温。', line: 'MIBR签一出，巴西味到位了。', liquipediaPage: 'MIBR', playerImageFallback: 'coldzera' },
  { key: 'm80', title: '今日CS队伍', name: 'M80', subtitle: '北美新锐 / 正面交换', scoreLabel: '签位强度', advice: '打出年轻队的速度，但别把站位拉散。', avoid: '别年轻气盛变成年轻白给。', line: 'M80签有劲，劲要往回合目标上使。', liquipediaPage: 'M80' },
  { key: 'betboom', title: '今日CS队伍', name: 'BetBoom Team', subtitle: '独联体枪男 / 节奏爆发', scoreLabel: '签位强度', advice: '用枪法拿首杀后马上收口，别贪第二波。', avoid: '别优势枪位打成赌博。', line: 'BetBoom签很敢打，敢打也要敢收。', liquipediaPage: 'BetBoom Team', playerImageFallback: 'Jame' },
  { key: 'b8', title: '今日CS队伍', name: 'B8', subtitle: '东欧韧性 / 回合阅读', scoreLabel: '签位强度', advice: '中期别断信息，人数劣势也要找交换窗口。', avoid: '别小劣势直接散架。', line: 'B8签主打韧性，急了就没味。', liquipediaPage: 'B8' },
  { key: 'rare-atom', title: '今日CS队伍', name: 'Rare Atom', subtitle: '中国CS语境 / 枪感和执行', scoreLabel: '签位强度', advice: '先把默认控图做细，机会来了再提速。', avoid: '别对枪敢了，补枪忘了。', line: 'RA签抽到，今天给点CNCS期待。', liquipediaPage: 'Rare Atom', playerImageFallback: 'JamYoung' },
);

csMaps.push(
  { key: 'agency', title: '今日CS地图', name: 'Agency', subtitle: '人质图 / 多层结构和近点清理', scoreLabel: '手感指数', advice: '先用道具切空间，楼梯和近点别硬闯。', avoid: '别把人质图打成无道具冲锋。', line: 'Agency签很考沟通，沉默就容易迷路。', fandomPage: 'Agency', fandomFile: 'Cs_agency.png' },
  { key: 'assault', title: '今日CS地图', name: 'Assault', subtitle: '仓库人质 / 长枪线和突破口', scoreLabel: '手感指数', advice: '进仓库前先清关键架点，别一个门排队进。', avoid: '别冲进去才想起来没人补闪。', line: 'Assault签很老派，白给也很复古。', fandomPage: 'Assault', fandomFile: 'Cs_assault.png' },
  { key: 'militia', title: '今日CS地图', name: 'Militia', subtitle: '野外和房区 / 信息搜集', scoreLabel: '手感指数', advice: '慢慢拿外场信息，进房区前先处理近点。', avoid: '别逛图逛到时间没了。', line: 'Militia签像郊游，问题是对面有枪。', fandomPage: 'Militia', fandomFile: 'Cs_militia.png' },
  { key: 'aztec', title: '今日CS地图', name: 'Aztec', subtitle: '经典雨林 / 长廊和桥位', scoreLabel: '手感指数', advice: '长枪线别硬赌，先用烟闪切角度。', avoid: '别把经典图打成经典白给。', line: 'Aztec签老古董，但枪线一点不客气。', fandomPage: 'Aztec', fandomFile: 'De_aztec.png' },
);

csWeapons.push(
  { key: 'p2000', title: '今日CS武器', name: 'P2000', subtitle: 'CT手枪 / 稳定点射', scoreLabel: '爆头指数', advice: '头线放稳，别连续peek，打完马上换位。', avoid: '别把备用手枪打成备用人生。', line: 'P2000签低调，低调也能点头。', fandomPage: 'P2000', fandomFile: 'CS2_P2000_Inventory.png' },
  { key: 'dual-berettas', title: '今日CS武器', name: 'Dual Berettas', subtitle: '双持手枪 / 近点火力', scoreLabel: '爆头指数', advice: '贴近打人数和弹量优势，别远点乱泼。', avoid: '别两把枪打出半把效果。', line: '双枪签节目感很强，但准星也得有。', fandomPage: 'Dual Berettas', fandomFile: 'CS2_Dual_Berettas_Inventory.png' },
  { key: 'cz75', title: '今日CS武器', name: 'CZ75-Auto', subtitle: '自动手枪 / 近点爆发', scoreLabel: '爆头指数', advice: '等对面进距离再泼，杀一个就撤，子弹很贵。', avoid: '别第一梭空了还想续命。', line: 'CZ签就是一波流，犹豫就没了。', fandomPage: 'CZ75-Auto', fandomFile: 'CS2_CZ75-Auto_Inventory.png' },
  { key: 'r8', title: '今日CS武器', name: 'R8 Revolver', subtitle: '左轮 / 慢热高伤害', scoreLabel: '爆头指数', advice: '预瞄提前，别临脸才想起来蓄力。', avoid: '别枪声很大，作用很小。', line: '左轮签很有性格，性格别大过回合。', fandomPage: 'R8 Revolver', fandomFile: 'CS2_R8_Revolver_Inventory.png' },
  { key: 'ump45', title: '今日CS武器', name: 'UMP-45', subtitle: '稳健SMG / 近中距离', scoreLabel: '爆头指数', advice: '打近中距离和补枪，杀一个就赚经济。', avoid: '别拿UMP远点对AK讲道理。', line: 'UMP签朴实，朴实也能赚钱。', fandomPage: 'UMP-45', fandomFile: 'CS2_UMP-45_Inventory.png' },
  { key: 'pp-bizon', title: '今日CS武器', name: 'PP-Bizon', subtitle: '大弹鼓 / 低甲压制', scoreLabel: '爆头指数', advice: '靠弹量压近点，别把扫射当战术全部。', avoid: '别一梭子热闹完没有击杀。', line: '野牛签很欢乐，但欢乐要换人头。', fandomPage: 'PP-Bizon', fandomFile: 'CS2_PP-Bizon_Inventory.png' },
  { key: 'mp7', title: '今日CS武器', name: 'MP7', subtitle: '均衡SMG / 经济滚雪球', scoreLabel: '爆头指数', advice: '贴近打干净交换，别贪远点。', avoid: '别花钱买了枪，打法还像无甲。', line: 'MP7签稳，稳里也得有杀意。', fandomPage: 'MP7', fandomFile: 'CS2_MP7_Inventory.png' },
  { key: 'mp5sd', title: '今日CS武器', name: 'MP5-SD', subtitle: '消音SMG / 偷人和转点', scoreLabel: '爆头指数', advice: '用消音和近点位偷节奏，打完换位置。', avoid: '别偷人偷成自己失踪。', line: 'MP5签很轻，轻到队友可能忘了你在。', fandomPage: 'MP5-SD', fandomFile: 'CS2_MP5-SD_Inventory.png' },
  { key: 'nova', title: '今日CS武器', name: 'Nova', subtitle: '经济喷子 / 近点一枪', scoreLabel: '爆头指数', advice: '卡窄口，等近点，打完就跑。', avoid: '别拿喷子追远点长枪。', line: 'Nova签很现实，距离对了才有道理。', fandomPage: 'Nova', fandomFile: 'CS2_Nova_Inventory.png' },
  { key: 'mag7', title: '今日CS武器', name: 'MAG-7', subtitle: 'CT近点喷子 / 跳打和压迫', scoreLabel: '爆头指数', advice: '守近点和拐角，利用移动优势偷第一枪。', avoid: '别跳出去发现距离不对。', line: 'MAG-7签很脏，脏得有位置才行。', fandomPage: 'MAG-7', fandomFile: 'CS2_MAG-7_Inventory.png' },
  { key: 'sawedoff', title: '今日CS武器', name: 'Sawed-Off', subtitle: 'T方短喷 / 近点伏击', scoreLabel: '爆头指数', advice: '贴脸才有威胁，别提前露声音和位置。', avoid: '别手短还站远点。', line: '截短喷签，距离就是生命线。', fandomPage: 'Sawed-Off', fandomFile: 'CS2_Sawed-Off_Inventory.png' },
  { key: 'm249', title: '今日CS武器', name: 'M249', subtitle: '重机枪 / 价格和节目效果', scoreLabel: '爆头指数', advice: '真起了就架住关键口，别移动扫射当烟花。', avoid: '别钱花最多，作用最少。', line: 'M249签一出，队伍经济开始冒汗。', fandomPage: 'M249', fandomFile: 'CS2_M249_Inventory.png' },
  { key: 'negev', title: '今日CS武器', name: 'Negev', subtitle: '压制机枪 / 火力封锁', scoreLabel: '爆头指数', advice: '提前架住窄口压制，别临场才开始预热弹道。', avoid: '别扫得很热闹，包点没人看。', line: 'Negev签主打弹幕，别真把自己当弹幕。', fandomPage: 'Negev', fandomFile: 'CS2_Negev_Inventory.png' },
  { key: 'g3sg1', title: '今日CS武器', name: 'G3SG1', subtitle: 'T方连狙 / 高压长枪线', scoreLabel: '爆头指数', advice: '架住关键长线，拿到优势就别贪。', avoid: '别连狙起出来还被沙鹰一发收。', line: 'G3SG1签很招恨，招恨前先打中。', fandomPage: 'G3SG1', fandomFile: 'CS2_G3SG1_Inventory.png' },
  { key: 'scar20', title: '今日CS武器', name: 'SCAR-20', subtitle: 'CT连狙 / 封锁和压迫', scoreLabel: '爆头指数', advice: '控长线和回防入口，别站死等对面道具清你。', avoid: '别连狙没打出压迫，只打出骂声。', line: 'SCAR签，火力压迫可以，别压迫队友钱包。', fandomPage: 'SCAR-20', fandomFile: 'CS2_SCAR-20_Inventory.png' },
  { key: 'zeus-x27', title: '今日CS武器', name: 'Zeus x27', subtitle: '电击枪 / 贴脸胆量测试', scoreLabel: '爆头指数', advice: '藏近点，听脚步，距离到了再出手。', avoid: '别没电到人，自己先成素材。', line: '电击枪签很短，也很刺激。', fandomPage: 'Zeus x27', fandomFile: 'CS2_Zeus_x27_Inventory.png' },
);

csSkins.push(
  { key: 'p2000-fire-elemental', title: '今日CS皮肤', name: 'P2000 | Fire Elemental', weapon: 'P2000', rarity: 'Covert', subtitle: '火灵 / CT手枪压迫感', scoreLabel: '出货指数', advice: '手枪局先稳第一枪，别被皮肤烧上头。', avoid: '别火灵变火葬。', line: 'P2000火灵签，老手枪也有排面。' },
  { key: 'dual-berettas-melondrama', title: '今日CS皮肤', name: 'Dual Berettas | Melondrama', weapon: 'Dual Berettas', rarity: 'Classified', subtitle: '瓜戏 / 双持整活', scoreLabel: '出货指数', advice: '近点用弹量压人，别远点乱点。', avoid: '别戏很多，击杀很少。', line: 'Melondrama签，节目效果先满。' },
  { key: 'cz75-victoria', title: '今日CS皮肤', name: 'CZ75-Auto | Victoria', weapon: 'CZ75-Auto', rarity: 'Covert', subtitle: '维多利亚 / 自动手枪老贵气', scoreLabel: '出货指数', advice: '第一梭要打出价值，打完赶紧撤。', avoid: '别贵气没了，子弹也没了。', line: 'CZ维多利亚签，开局就得讲效率。' },
  { key: 'r8-fade', title: '今日CS皮肤', name: 'R8 Revolver | Fade', weapon: 'R8 Revolver', rarity: 'Covert', subtitle: '渐变左轮 / 慢枪也有排面', scoreLabel: '出货指数', advice: '预瞄提前，别临脸才慢悠悠蓄力。', avoid: '别渐变很丝滑，开枪很拖沓。', line: 'R8渐变签，帅但要命中。' },
  { key: 'ump-primal-saber', title: '今日CS皮肤', name: 'UMP-45 | Primal Saber', weapon: 'UMP-45', rarity: 'Classified', subtitle: '原始剑齿虎 / SMG硬派皮', scoreLabel: '出货指数', advice: '近中距离打干净交换，别贪远点。', avoid: '别剑齿虎变家猫。', line: 'UMP剑齿虎签，有点凶。' },
  { key: 'bizon-judgement', title: '今日CS皮肤', name: 'PP-Bizon | Judgement of Anubis', weapon: 'PP-Bizon', rarity: 'Covert', subtitle: '阿努比斯审判 / 大弹鼓仪式感', scoreLabel: '出货指数', advice: '靠弹量压近点，但别忘了停枪换位。', avoid: '别审判的是自己经济。', line: '野牛审判签，名字比枪还狠。' },
  { key: 'mp7-bloodsport', title: '今日CS皮肤', name: 'MP7 | Bloodsport', weapon: 'MP7', rarity: 'Covert', subtitle: '血腥运动 / SMG红白科技', scoreLabel: '出货指数', advice: '打经济局要收干净，别送钱。', avoid: '别运动起来只剩跑。', line: 'MP7血腥运动签，干净利落。' },
  { key: 'mp5-phosphor', title: '今日CS皮肤', name: 'MP5-SD | Phosphor', weapon: 'MP5-SD', rarity: 'Classified', subtitle: '磷光 / 消音流光', scoreLabel: '出货指数', advice: '用消音偷节奏，别一直站同一个点。', avoid: '别光很亮，信息很暗。', line: 'MP5磷光签，低调里带点骚。' },
  { key: 'nova-hyper-beast', title: '今日CS皮肤', name: 'Nova | Hyper Beast', weapon: 'Nova', rarity: 'Classified', subtitle: '暴怒野兽 / 喷子也有名皮', scoreLabel: '出货指数', advice: '卡近点一枪说话，别追远点。', avoid: '别野兽还没咬，人先送了。', line: 'Nova暴怒野兽签，近点别手软。' },
  { key: 'mag7-justice', title: '今日CS皮肤', name: 'MAG-7 | Justice', weapon: 'MAG-7', rarity: 'Classified', subtitle: '正义 / CT近点判官', scoreLabel: '出货指数', advice: '等距离到了再开火，杀完就撤。', avoid: '别正义没来，经济先没。', line: 'MAG-7正义签，判得准才算数。' },
  { key: 'sawedoff-kraken', title: '今日CS皮肤', name: 'Sawed-Off | The Kraken', weapon: 'Sawed-Off', rarity: 'Covert', subtitle: '海怪 / 短喷经典', scoreLabel: '出货指数', advice: '贴脸伏击，打一枪就换位置。', avoid: '别海怪上岸就搁浅。', line: '截短喷海怪签，近点有故事。' },
  { key: 'm249-nebula-crusader', title: '今日CS皮肤', name: 'M249 | Nebula Crusader', weapon: 'M249', rarity: 'Restricted', subtitle: '星云十字军 / 重机枪科幻感', scoreLabel: '出货指数', advice: '架住窄口打压制，别移动泼水。', avoid: '别花最多的钱打最少的作用。', line: 'M249星云签，钱包先敬礼。' },
  { key: 'negev-mjolnir', title: '今日CS皮肤', name: 'Negev | Mjolnir', weapon: 'Negev', rarity: 'Covert', subtitle: '雷神之锤 / 稀有重火力', scoreLabel: '出货指数', advice: '提前压枪线，别临时抱枪乱扫。', avoid: '别锤的是队伍经济。', line: 'Negev雷锤签，贵得很有存在感。' },
  { key: 'g3sg1-executioner', title: '今日CS皮肤', name: 'G3SG1 | The Executioner', weapon: 'G3SG1', rarity: 'Classified', subtitle: '行刑者 / T方连狙压迫', scoreLabel: '出货指数', advice: '架住长线，拿到击杀别贪同角度。', avoid: '别行刑者先被处刑。', line: 'G3SG1行刑者签，很招恨也很有用。' },
  { key: 'scar20-bloodsport', title: '今日CS皮肤', name: 'SCAR-20 | Bloodsport', weapon: 'SCAR-20', rarity: 'Classified', subtitle: '血腥运动 / CT连狙红白科技', scoreLabel: '出货指数', advice: '封锁入口，别站死吃道具。', avoid: '别连狙起出来只贡献音效。', line: 'SCAR血腥运动签，压迫感拉满。' },
  { key: 'zeus-olympus', title: '今日CS皮肤', name: 'Zeus x27 | Olympus', weapon: 'Zeus x27', rarity: 'Classified', subtitle: '奥林匹斯 / 贴脸闪电', scoreLabel: '出货指数', advice: '等距离，听脚步，一下就要电中。', avoid: '别闪电没劈到，自己先倒。', line: 'Zeus奥林匹斯签，短但刺激。' },
);

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

function dailySkinFor(userId: number, scopeId: number): SkinCard {
  return csSkins[dailySeedForKind('csskin', userId, scopeId) % csSkins.length];
}

function dailyKnifeFor(userId: number, scopeId: number): KnifeCard {
  return csKnives[dailySeedForKind('csknife', userId, scopeId) % csKnives.length];
}

function dailyKnifeSkinFor(userId: number, scopeId: number, knife?: KnifeCard): KnifeSkin {
  const selectedKnife = knife || dailyKnifeFor(userId, scopeId);
  const pool = knifeSkinPoolFor(selectedKnife);
  return pool[dailySeedForKind(`csknife_skin_${selectedKnife.key}`, userId, scopeId) % pool.length];
}

function dailyCharacterFor(userId: number, scopeId: number): DailyCharacter {
  return dailyCharacters[dailySeedForKind('mokoko', userId, scopeId) % dailyCharacters.length];
}

function dailyGenshinFor(userId: number, scopeId: number): DailyGenshinCharacter {
  return dailyGenshinCharacters[dailySeedForKind('genshin', userId, scopeId) % dailyGenshinCharacters.length];
}

function dailyFactFor(userId: number, scopeId: number): DailyTextCard {
  return dailyFacts[dailySeedForKind('daily_fact', userId, scopeId) % dailyFacts.length];
}

function dailyBookExcerptFor(userId: number, scopeId: number): DailyTextCard {
  return dailyBookExcerpts[dailySeedForKind('daily_book', userId, scopeId) % dailyBookExcerpts.length];
}

function dailyPoemFor(userId: number, scopeId: number): DailyTextCard {
  return dailyPoems[dailySeedForKind('daily_poem', userId, scopeId) % dailyPoems.length];
}

function dailyDuelPlayerWeaponFor(userId: number, scopeId: number): DailyDuelWeapon {
  return duelWeapons[dailySeedForKind('daily_duel_user_weapon', userId, scopeId) % duelWeapons.length];
}

function dailyDuelBotWeaponFor(userId: number, scopeId: number): DailyDuelWeapon {
  return duelWeapons[dailySeedForKind('daily_duel_bot_weapon', userId, scopeId) % duelWeapons.length];
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
  if (card.fandomPage) parts.push('Counter-Strike Wiki页面主图');
  if (card.fandomFile) parts.push('Counter-Strike Wiki/Fandom');
  if (card.playerImageFallback) parts.push(`代表选手${card.playerImageFallback}`);
  if (card.image) parts.push('静态真实图URL');
  return parts.length > 0
    ? `图片路径：${parts.join(' -> ')}；都拿不到时给日签图`
    : '图片路径：Counter-Strike Wiki/Fandom；都拿不到时给日签图';
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

function isDailyImageAuditRequest(command: string | null, args: string[], rawText: string): boolean {
  const first = (args[0] || '').toLowerCase();
  if (['dailyimage', 'dailyimages', 'dailyimg', '每日图片', '图片池'].includes(command || '')) {
    return !first || ['audit', 'status', 'check', 'cache', 'template', 'todo', 'help', 'usage', '审计', '状态', '检查', '缓存', '模板', '待补', '帮助', '用法'].includes(first);
  }
  return /^(?:\/)?(?:dailyimage|dailyimages|dailyimg|每日图片|图片池)(?:audit|status|check|cache|template|todo|help|usage|审计|状态|检查|缓存|模板|待补|帮助|用法)?$/.test(normalizeDrawText(rawText));
}

type DailyImageCommandAction = 'audit' | 'status' | 'cache' | 'template' | 'help';

function dailyImageCommandAction(args: string[], rawText: string): DailyImageCommandAction {
  const first = normalizeDrawText(args[0] || '');
  const raw = normalizeDrawText(rawText);
  if (['help', 'usage', '帮助', '用法'].includes(first) || /(帮助|用法)$/.test(raw)) return 'help';
  if (['cache', '缓存'].includes(first) || /(cache|缓存)$/.test(raw)) return 'cache';
  if (['template', 'todo', '模板', '待补'].includes(first) || /(template|todo|模板|待补)$/.test(raw)) return 'template';
  if (['status', 'check', '状态', '检查'].includes(first) || /(status|check|状态|检查)$/.test(raw)) return 'status';
  return 'audit';
}

function isCsImageCommand(command: string | null, rawText: string): boolean {
  if (['csimage', 'csimg', 'cs图', '图片测试'].includes(command || '')) return true;
  return /^(?:\/)?(?:csimage|csimg|cs图|图片测试)/.test(normalizeDrawText(rawText));
}

function normalizeCsImageKind(input: string): CsImageProbeKind {
  const text = normalizeDrawText(input || '');
  if (/^(all|全部|全量|所有)$/.test(text)) return 'all';
  if (/^(player|选手|csplayer|今日选手)$/.test(text)) return 'player';
  if (/^(knife|刀|发刀|csknife|今日发刀)$/.test(text)) return 'knife';
  if (/^(mokoko|木柜子|mygo|avemujica|角色|每日木柜子)$/.test(text)) return 'mokoko';
  if (/^(genshin|ys|原神|原神角色|每日原神)$/.test(text)) return 'genshin';
  if (/^(team|队伍|战队|csteam|今日队伍|今日战队)$/.test(text)) return 'team';
  if (/^(map|地图|csmap|今日地图)$/.test(text)) return 'map';
  if (/^(weapon|gun|枪|武器|枪械|csweapon|今日武器)$/.test(text)) return 'weapon';
  if (/^(skin|skins|皮肤|csskin|今日皮肤)$/.test(text)) return 'skin';
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
  if (kind === 'skin') return csSkins;
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

function isDailyKnifeRequest(command: string | null, rawText: string): boolean {
  if (['csknife', 'knife', 'csdao', '今日发刀', '每日发刀', '发刀', '抽刀', 'd'].includes(command || '')) return true;
  const raw = rawText.trim().toLowerCase();
  if (/^\.d(?:\s|$)/i.test(raw)) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  if (['今日发刀', '每日发刀', '发刀', '抽刀', '来把刀', '给我发刀', '今天发刀', '今天抽刀'].includes(text)) return true;
  const hasDraw = /(今日|每日|今天|抽|来个|来把|给我|发)/.test(text);
  return hasDraw && /(刀|刀签|爪子|蝴蝶|蝴蝶刀|廓尔喀|发刀)/.test(text);
}

function isDailyMokokoRequest(command: string | null, rawText: string): boolean {
  if (['mokoko', 'mygo', 'avemujica', 'ave', '木柜子', '每日木柜子', '今日木柜子', '抽木柜子'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  if (['每日木柜子', '今日木柜子', '木柜子', '抽木柜子', '今天木柜子', '今日mygo', '今日avemujica'].includes(text)) return true;
  const hasDaily = /(今日|每日|今天|抽|来个|给我)/.test(text);
  return hasDaily && /(木柜子|mygo|avemujica|ave|mujica|迷子|母鸡卡)/.test(text);
}

function isDailyGenshinRequest(command: string | null, rawText: string): boolean {
  if (['genshin', 'ys', '原神', '原神角色', '每日原神', '今日原神', '每日原神角色', '今日原神角色'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  if (['每日原神', '今日原神', '每日原神角色', '今日原神角色', '抽原神角色', '今天原神角色'].includes(text)) return true;
  const hasDaily = /(今日|每日|今天|抽|来个|给我)/.test(text);
  return hasDaily && /(原神|genshin|提瓦特)/.test(text) && /(角色|人物|谁|抽)/.test(text);
}

function isDailyFactRequest(command: string | null, rawText: string): boolean {
  if (['fact', 'cold', 'coldfact', '冷知识', '每日冷知识', '今日冷知识'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  return ['每日冷知识', '今日冷知识', '冷知识', '来个冷知识', '今天冷知识'].includes(text)
    || (/(今日|每日|今天|来个|给我)/.test(text) && /(冷知识|小知识|奇怪知识|小众知识)/.test(text));
}

function isDailyBookRequest(command: string | null, rawText: string): boolean {
  if (['book', 'excerpt', 'quote', '书摘', '每日书摘', '今日书摘'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  return ['每日书摘', '今日书摘', '书摘', '来个书摘', '今天书摘'].includes(text)
    || (/(今日|每日|今天|来个|给我)/.test(text) && /(书摘|摘抄|读书|书句)/.test(text));
}

function isDailyPoemRequest(command: string | null, rawText: string): boolean {
  if (['poem', 'poetry', '古诗', '古诗词', '诗词', '每日古诗词', '今日古诗词'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  return ['每日古诗词', '今日古诗词', '每日古诗', '今日古诗', '古诗词', '来首诗'].includes(text)
    || (/(今日|每日|今天|来个|给我|来首)/.test(text) && /(古诗词|古诗|诗词|唐诗|宋词)/.test(text));
}

function isDailyDuelRequest(command: string | null, rawText: string): boolean {
  if (['duel', '决斗', '紫禁之巅', '决战紫禁之巅', '每日决战紫禁之巅', '今日决战紫禁之巅'].includes(command || '')) return true;
  const text = normalizeDrawText(rawText);
  if (!text) return false;
  return ['决战紫禁之巅', '每日决战紫禁之巅', '今日决战紫禁之巅', '紫禁之巅'].includes(text)
    || (/(今日|每日|今天|来个|给我)/.test(text) && /(决战|决斗|紫禁之巅|单挑)/.test(text));
}

function isDailyCardRequest(command: string | null, rawText: string, kind: DailyCardKind): boolean {
  const commandMap: Record<DailyCardKind, string[]> = {
    team: ['csteam', 'csteamday', 'todayteam', '今日队伍', '每日队伍', '抽队伍', '今日战队', '每日战队'],
    map: ['csmap', 'mapday', 'todaymap', '今日地图', '每日地图', '抽地图'],
    weapon: ['csweapon', 'weaponday', 'todayweapon', '今日武器', '每日武器', '抽武器', '今日枪械'],
    skin: ['csskin', 'cskin', 'skinsday', 'todayskin', '今日皮肤', '每日皮肤', '抽皮肤'],
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
  if (kind === 'skin') return /(cs皮肤|cs2皮肤|枪皮肤|武器皮肤|皮肤签|今日皮肤|每日皮肤|今天什么皮肤)/.test(text);
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

function isSkinCard(card?: DailyCard): card is SkinCard {
  return Boolean(card && typeof (card as SkinCard).weapon === 'string' && typeof (card as SkinCard).rarity === 'string');
}

async function buildImageCandidates(url?: string, fallbackPlayerNick?: string, fallbackCard?: DailyCard): Promise<ImageCandidate[]> {
  const candidateUrls: ImageCandidate[] = [];

  if (isSkinCard(fallbackCard)) {
    try {
      const skinUrl = await Promise.race([
        csgoSkinImageResolver(fallbackCard.weapon, fallbackCard.name),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (skinUrl) {
        candidateUrls.push({
          url: skinUrl,
          label: `${fallbackCard.name}/csgo-api-skin`,
          source: 'csgo-api-skin',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${fallbackCard.name} CSGO-API皮肤图解析失败:`, err instanceof Error ? err.message : err);
    }
  }

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
        fandomImageResolver(fallbackCard.fandomFile, 'counterstrike'),
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

  if (fallbackCard?.fandomPage) {
    try {
      const fandomUrl = await Promise.race([
        fandomPageImageResolver(fallbackCard.fandomPage, 'counterstrike'),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (fandomUrl) {
        candidateUrls.push({
          url: fandomUrl,
          label: `${fallbackCard.name}/fandom-page`,
          source: 'fandom-page',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${fallbackCard.name} Fandom页面图解析失败:`, err instanceof Error ? err.message : err);
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
    lines.push('已生成日签图。');
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
    const candidates = await buildCsPlayerImageCandidates(player, userId, scopeId);
    return probeImageCandidates(`今日选手 ${player.nick}`, candidates);
  }
  if (kind === 'knife') {
    const knife = dailyKnifeFor(userId, scopeId);
    const skin = dailyKnifeSkinFor(userId, scopeId, knife);
    const score = dailyScoreForKind('csknife', userId, scopeId);
    const card: DailyCard = {
      key: `probe-${knife.key}-${skin.key}`,
      title: '今日发刀',
      name: `${knife.name} | ${skin.name}`,
      subtitle: knife.subtitle,
      scoreLabel: '刀运指数',
      advice: `${knife.advice} ${skin.advice}`,
      avoid: `${knife.avoid} ${skin.avoid}`,
      line: `${knife.line} ${skin.line}`,
    };
    return probeImageCandidates(`今日发刀 ${knife.name} | ${skin.name}`, await buildKnifeImageCandidates(knife, skin, userId, scopeId), card, score);
  }
  if (kind === 'mokoko') {
    const character = dailyCharacterFor(userId, scopeId);
    const score = dailyScoreForKind('mokoko', userId, scopeId);
    const card: DailyCard = {
      key: `probe-${character.key}`,
      title: character.title,
      name: character.name,
      subtitle: `${character.band} / ${character.role}`,
      scoreLabel: '木柜子指数',
      advice: character.note,
      avoid: '这是角色抽签，不是CS事实。',
      line: character.voice,
    };
    return probeImageCandidates(`每日木柜子 ${character.name}`, await buildCharacterImageCandidates(character, userId, scopeId), card, score);
  }
  if (kind === 'genshin') {
    const character = dailyGenshinFor(userId, scopeId);
    const score = dailyScoreForKind('genshin', userId, scopeId);
    const card: DailyCard = {
      key: `probe-genshin-${character.key}`,
      title: character.title,
      name: character.name,
      subtitle: character.tag,
      scoreLabel: '共鸣指数',
      advice: character.note,
      avoid: '这是每日角色签，不是抽卡建议。',
      line: character.tag,
    };
    return probeImageCandidates(`每日原神角色 ${character.name}`, await buildGenshinImageCandidates(character, userId, scopeId), card, score);
  }
  if (kind === 'all') {
    const kinds: CsImageProbeKind[] = ['player', 'team', 'map', 'weapon', 'skin', 'role', 'utility', 'tactic', 'clutch', 'knife', 'mokoko', 'genshin'];
    const lines = ['CS真实图片批量测试'];
    for (const item of kinds) {
      if (item === 'player') {
        const player = dailyPlayerFor(userId, scopeId);
        const candidates = await buildCsPlayerImageCandidates(player, userId, scopeId);
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
      if (item === 'knife') {
        const knife = dailyKnifeFor(userId, scopeId);
        const skin = dailyKnifeSkinFor(userId, scopeId, knife);
        const candidates = await buildKnifeImageCandidates(knife, skin, userId, scopeId);
        let ok = false;
        for (const candidate of candidates.slice(0, 4)) {
          if (await tryImageDataUrl(candidate.url, candidate.label)) {
            ok = true;
            lines.push(`OK knife ${knife.name} | ${skin.name} -> ${candidate.source}`);
            break;
          }
        }
        if (!ok) lines.push(`FAIL knife ${knife.name} | ${skin.name}`);
        continue;
      }
      if (item === 'mokoko') {
        const character = dailyCharacterFor(userId, scopeId);
        const candidates = await buildCharacterImageCandidates(character, userId, scopeId);
        let ok = false;
        for (const candidate of candidates.slice(0, 4)) {
          if (await tryImageDataUrl(candidate.url, candidate.label)) {
            ok = true;
            lines.push(`OK mokoko ${character.name} -> ${candidate.source}`);
            break;
          }
        }
        if (!ok) lines.push(`FAIL mokoko ${character.name}`);
        continue;
      }
      if (item === 'genshin') {
        const character = dailyGenshinFor(userId, scopeId);
        const candidates = await buildGenshinImageCandidates(character, userId, scopeId);
        let ok = false;
        for (const candidate of candidates.slice(0, 4)) {
          if (await tryImageDataUrl(candidate.url, candidate.label)) {
            ok = true;
            lines.push(`OK genshin ${character.name} -> ${candidate.source}`);
            break;
          }
        }
        if (!ok) lines.push(`FAIL genshin ${character.name}`);
        continue;
      }
      const cards = cardsForImageKind(item);
      const card = dailyCardFor(`cs${item}`, userId, scopeId, cards);
      const candidates = await buildDailyCardImageCandidates(item, card, userId, scopeId);
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
  const candidates = await buildDailyCardImageCandidates(kind, card, userId, scopeId);
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
      else if (candidate.label.includes('-fallback-')) console.log(`[fun] ${fallbackCard?.name} 用代表选手图成功`);
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

  if (fallbackCard) {
    console.log(`[fun] ${fallbackCard.title}/${fallbackCard.name} 使用日签图`);
    return [localDailyCardImage(fallbackCard, score)];
  }

  if (fallbackPlayerNick) {
    console.log(`[fun] ${fallbackPlayerNick} 使用选手日签图`);
    return [localDailyCardImage({
      key: `player-${fallbackPlayerNick}`,
      title: '今日CS选手',
      name: fallbackPlayerNick,
      subtitle: '图片源暂时没连上，先给今日签位图',
      scoreLabel: '签位',
      advice: '图片池补好后会自动优先发对应图片。',
      avoid: '别把签位图当选手照片。',
      line: '图没拉下来，但签不能断。',
      imageLabel: fallbackPlayerNick,
    }, score)];
  }

  return [{ type: 'text', data: { text: buildImageFailureLine() } }];
}

function sameWeaponName(a: string, b: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalize(a) === normalize(b);
}

function dailySkinForWeapon(weapon: DailyCard, userId: number, scopeId: number): SkinCard {
  const matching = csSkins.filter((skin) => sameWeaponName(skin.weapon, weapon.name));
  const pool = matching.length > 0 ? matching : csSkins;
  return pool[dailySeedForKind(`csskin_${weapon.key}`, userId, scopeId) % pool.length];
}

function localSkinCard(skin: SkinCard): DailyCard {
  return {
    ...skin,
    imageLabel: skin.name,
  };
}

function knifeSkinFileCandidates(knife: KnifeCard, skin: KnifeSkin): string[] {
  const files: string[] = [];
  for (const prefix of knife.skinFilePrefixes) {
    for (const suffix of skin.fileSuffixes) {
      files.push(`${prefix}_${suffix}.png`);
      files.push(`${prefix}_${suffix.replace(/_/g, '-')}.png`);
    }
  }
  return [...new Set(files)];
}

async function buildKnifeImageCandidates(knife: KnifeCard, skin: KnifeSkin, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const candidateUrls: ImageCandidate[] = dailyBeautyKnifeCandidates(knife, skin, userId, scopeId);
  try {
    const skinUrl = await Promise.race([
      csgoSkinImageResolver(knife.name, skin.name),
      new Promise<null>((r) => setTimeout(() => r(null), 6000)),
    ]);
    if (skinUrl) {
      candidateUrls.push({
        url: skinUrl,
        label: `${knife.name}/${skin.name}/csgo-api-skin`,
        source: 'csgo-api-skin',
      });
    }
  } catch (err) {
    console.warn(`[fun] ${knife.name} ${skin.name} CSGO-API刀皮图片解析失败:`, err instanceof Error ? err.message : err);
  }
  for (const filename of knifeSkinFileCandidates(knife, skin).slice(0, 10)) {
    try {
      const fandomUrl = await Promise.race([
        fandomImageResolver(filename, 'counterstrike'),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (fandomUrl) {
        candidateUrls.push({
          url: fandomUrl,
          label: `${knife.name}/${skin.name}/${filename}`,
          source: 'fandom-file',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${knife.name} ${skin.name} 刀皮图片解析失败:`, err instanceof Error ? err.message : err);
    }
  }
  candidateUrls.push(...await buildImageCandidates(knife.image, undefined, knife));
  const seen = new Set<string>();
  return candidateUrls.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function imageFromCandidatesOrCard(candidates: ImageCandidate[], fallbackCard: DailyCard, score: number): Promise<MessageSegment[]> {
  for (const candidate of candidates) {
    const dataUrl = await tryImageDataUrl(candidate.url, candidate.label);
    if (dataUrl) return [imageDataUrlToSegment(dataUrl)];
  }
  return [localDailyCardImage(fallbackCard, score)];
}

const BESTDORI_CARD_MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'data', 'bestdori-cards.json');
const PLAYER_IMAGE_MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'data', 'daily-player-images.json');
const GENSHIN_IMAGE_MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'data', 'genshin-character-images.json');
const DAILY_BEAUTY_IMAGE_MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'data', 'daily-beauty-images.json');
let bestdoriCardManifestPathOverride = '';
let playerImageManifestPathOverride = '';
let genshinImageManifestPathOverride = '';
let dailyBeautyImageManifestPathOverride = '';
let dailyBeautyMatchCacheHits = 0;
let dailyBeautyMatchCacheMisses = 0;
let dailyBeautyMatchCacheEvictions = 0;
const dailyBeautyMatchCache = new Map<string, BestdoriCardImage[]>();

function bestdoriCardManifestPath(): string {
  return bestdoriCardManifestPathOverride || process.env.BESTDORI_CARD_MANIFEST_PATH || BESTDORI_CARD_MANIFEST_PATH;
}

function loadBestdoriCardImages(): BestdoriCardImage[] {
  return loadImageManifest(bestdoriCardManifestPath(), 'bestdori');
}

function playerImageManifestPath(): string {
  return playerImageManifestPathOverride || process.env.DAILY_PLAYER_IMAGE_MANIFEST_PATH || PLAYER_IMAGE_MANIFEST_PATH;
}

function genshinImageManifestPath(): string {
  return genshinImageManifestPathOverride || process.env.GENSHIN_IMAGE_MANIFEST_PATH || GENSHIN_IMAGE_MANIFEST_PATH;
}

function dailyBeautyImageManifestPath(): string {
  return dailyBeautyImageManifestPathOverride || process.env.DAILY_BEAUTY_IMAGE_MANIFEST_PATH || DAILY_BEAUTY_IMAGE_MANIFEST_PATH;
}

function loadPlayerManifestImages(): BestdoriCardImage[] {
  return loadImageManifest(playerImageManifestPath(), 'players');
}

function loadGenshinManifestImages(): BestdoriCardImage[] {
  return loadImageManifest(genshinImageManifestPath(), 'genshin');
}

function loadDailyBeautyImages(): BestdoriCardImage[] {
  return loadImageManifest(dailyBeautyImageManifestPath(), 'daily-beauty');
}

function clearDailyBeautyMatchCache(): void {
  dailyBeautyMatchCache.clear();
  dailyBeautyMatchCacheHits = 0;
  dailyBeautyMatchCacheMisses = 0;
  dailyBeautyMatchCacheEvictions = 0;
}

function setDailyBeautyMatchCache(key: string, cards: BestdoriCardImage[]): BestdoriCardImage[] {
  dailyBeautyMatchCache.set(key, cards);
  if (dailyBeautyMatchCache.size > DAILY_BEAUTY_MATCH_CACHE_MAX) {
    const firstKey = dailyBeautyMatchCache.keys().next().value;
    if (firstKey) {
      dailyBeautyMatchCache.delete(firstKey);
      dailyBeautyMatchCacheEvictions++;
    }
  }
  return cards;
}

function dailyBeautyMatchCacheStats(): { size: number; max: number; hits: number; misses: number; evictions: number } {
  return {
    size: dailyBeautyMatchCache.size,
    max: DAILY_BEAUTY_MATCH_CACHE_MAX,
    hits: dailyBeautyMatchCacheHits,
    misses: dailyBeautyMatchCacheMisses,
    evictions: dailyBeautyMatchCacheEvictions,
  };
}

const dailyImageKindAliases: Record<string, string[]> = {
  player: ['player', 'csplayer', 'dailyplayer', '选手', '每日选手', '今日选手'],
  team: ['team', 'csteam', 'squad', '战队', '队伍', '每日战队', '今日队伍'],
  map: ['map', 'csmap', '地图', '每日地图', '今日地图'],
  weapon: ['weapon', 'gun', 'csweapon', '武器', '枪', '枪械'],
  skin: ['skin', 'skins', 'csskin', '皮肤', '饰品'],
  role: ['role', 'position', 'csrole', '定位', '位置'],
  loadout: ['loadout', 'pack', 'package', '套餐', '套装', '今日cs'],
  utility: ['utility', 'nade', 'grenade', 'csutility', '道具', '投掷物'],
  tactic: ['tactic', 'strat', 'strategy', 'cstactic', '战术'],
  clutch: ['clutch', 'csclutch', '残局'],
  knife: ['knife', 'csknife', '刀', '发刀', '刀皮'],
  mokoko: ['mokoko', 'mygo', 'avemujica', 'bandori', '木柜子', '迷子', '母鸡卡'],
  genshin: ['genshin', 'ys', '原神', '提瓦特'],
  duel: ['duel', 'dailyduel', '紫禁之巅', '决战'],
  fact: ['fact', 'cold', 'coldfact', '冷知识'],
  book: ['book', 'excerpt', '书摘'],
  poem: ['poem', '古诗词', '诗词'],
};

function imageKindAliases(kind: string): string[] {
  const normalized = compactManifestValue(kind);
  const aliases = dailyImageKindAliases[normalized] || [normalized];
  return [...new Set([normalized, ...aliases.map(compactManifestValue)])].filter(Boolean);
}

function manifestSearchValues(card: BestdoriCardImage): string[] {
  return [
    card.key,
    card.itemKey,
    card.nick,
    card.name,
    card.itemName,
    card.characterKey,
    card.characterName,
    card.weapon,
    card.skin,
    card.title,
    ...(Array.isArray(card.tags) ? card.tags : []),
  ].map(compactManifestValue).filter(Boolean);
}

function manifestBeautyScore(card: BestdoriCardImage): number {
  const text = [
    card.title,
    card.style,
    card.quality,
    ...(Array.isArray(card.tags) ? card.tags : []),
  ].join(' ').toLowerCase();
  let score = Number.isFinite(Number(card.priority)) ? Number(card.priority) : 0;
  if (/(splash|card|art|artwork|illustration|poster|wallpaper|keyvisual|scene|stage|ingame|inspect|render|showcase|cinematic|卡面|立绘|海报|壁纸|场景|舞台|检视|展示|官图|美图)/i.test(text)) score += 80;
  if (/(headshot|portrait|avatar|profile|idphoto|大头|头像|证件|半身像)/i.test(text)) score -= 120;
  return score;
}

function preferBeautyManifestImages(cards: BestdoriCardImage[]): BestdoriCardImage[] {
  const sorted = [...cards].sort((a, b) => manifestBeautyScore(b) - manifestBeautyScore(a));
  const beautiful = sorted.filter((card) => manifestBeautyScore(card) > -80);
  return beautiful.length > 0 ? beautiful : sorted;
}

function dailyBeautyManifestImagesFor(kind: string, values: unknown[]): BestdoriCardImage[] {
  const keys = values.map(compactManifestValue).filter(Boolean);
  if (keys.length === 0) return [];
  const manifestPath = dailyBeautyImageManifestPath();
  const signature = getImageManifestSignature(manifestPath, 'daily-beauty');
  const cacheKey = `single:${signature}:${imageKindAliases(kind).join('|')}:${keys.join('|')}`;
  const cached = dailyBeautyMatchCache.get(cacheKey);
  if (cached) {
    dailyBeautyMatchCacheHits++;
    dailyBeautyMatchCache.delete(cacheKey);
    dailyBeautyMatchCache.set(cacheKey, cached);
    return cached;
  }
  dailyBeautyMatchCacheMisses++;
  const kindCards = loadImageManifestByKinds(dailyBeautyImageManifestPath(), 'daily-beauty', imageKindAliases(kind));
  const matches = kindCards.filter((card) => {
    const cardValues = manifestSearchValues(card);
    return cardValues.some((value) => keys.some((key) => value === key || value.includes(key) || key.includes(value)));
  });
  return setDailyBeautyMatchCache(cacheKey, preferBeautyManifestImages(matches));
}

function manifestValueMatches(cardValues: string[], keys: unknown[]): boolean {
  const normalizedKeys = keys.map(compactManifestValue).filter(Boolean);
  if (normalizedKeys.length === 0) return false;
  return cardValues.some((value) => normalizedKeys.some((key) => value === key || value.includes(key) || key.includes(value)));
}

function dailyBeautyManifestImagesForPair(kind: string, firstValues: unknown[], secondValues: unknown[]): BestdoriCardImage[] {
  const firstKeys = firstValues.map(compactManifestValue).filter(Boolean);
  const secondKeys = secondValues.map(compactManifestValue).filter(Boolean);
  if (firstKeys.length === 0 || secondKeys.length === 0) return [];
  const manifestPath = dailyBeautyImageManifestPath();
  const signature = getImageManifestSignature(manifestPath, 'daily-beauty');
  const cacheKey = `pair:${signature}:${imageKindAliases(kind).join('|')}:${firstKeys.join('|')}:${secondKeys.join('|')}`;
  const cached = dailyBeautyMatchCache.get(cacheKey);
  if (cached) {
    dailyBeautyMatchCacheHits++;
    dailyBeautyMatchCache.delete(cacheKey);
    dailyBeautyMatchCache.set(cacheKey, cached);
    return cached;
  }
  dailyBeautyMatchCacheMisses++;
  const kindCards = loadImageManifestByKinds(manifestPath, 'daily-beauty', imageKindAliases(kind));
  const matches = kindCards.filter((card) => {
    const cardValues = manifestSearchValues(card);
    return manifestValueMatches(cardValues, firstKeys) && manifestValueMatches(cardValues, secondKeys);
  });
  return setDailyBeautyMatchCache(cacheKey, preferBeautyManifestImages(matches));
}

function dailyBeautyCandidatesFromCards(kind: string, label: string, cards: BestdoriCardImage[], userId: number, scopeId: number, limit = DAILY_IMAGE_CANDIDATE_LIMIT): ImageCandidate[] {
  return rotateManifestCards(cards, `daily_beauty_${kind}_${compactManifestValue(label)}`, userId, scopeId, limit)
    .filter((card) => card.url)
    .map((card, index): ImageCandidate => ({
      url: String(card.url),
      label: `${label}/beauty/${card.title || index + 1}`,
      source: 'authorized-image',
    }));
}

function dailyBeautyCandidatesFor(kind: string, label: string, values: unknown[], userId: number, scopeId: number, limit = DAILY_IMAGE_CANDIDATE_LIMIT): ImageCandidate[] {
  return dailyBeautyCandidatesFromCards(kind, label, dailyBeautyManifestImagesFor(kind, values), userId, scopeId, limit);
}

function dailyBeautyImageCountFor(kind: string, values: unknown[]): number {
  return dailyBeautyManifestImagesFor(kind, values).length;
}

function dailyBeautySkinImagesFor(skin: SkinCard): BestdoriCardImage[] {
  return dailyBeautyManifestImagesForPair('skin', [skin.weapon], [skin.key, skin.name, `${skin.weapon} ${skin.name}`, `${skin.weapon} | ${skin.name}`]);
}

function dailyBeautyKnifeImagesFor(knife: KnifeCard, skin: KnifeSkin): BestdoriCardImage[] {
  return dailyBeautyManifestImagesForPair(
    'knife',
    [knife.key, knife.name, ...knife.aliases],
    [skin.key, skin.name, `${knife.name} ${skin.name}`, `${knife.name} | ${skin.name}`],
  );
}

function dailyBeautySkinCandidates(skin: SkinCard, userId: number, scopeId: number): ImageCandidate[] {
  return dailyBeautyCandidatesFromCards('skin', `${skin.weapon} ${skin.name}`, dailyBeautySkinImagesFor(skin), userId, scopeId);
}

function dailyBeautyKnifeCandidates(knife: KnifeCard, skin: KnifeSkin, userId: number, scopeId: number): ImageCandidate[] {
  return dailyBeautyCandidatesFromCards('knife', `${knife.name} ${skin.name}`, dailyBeautyKnifeImagesFor(knife, skin), userId, scopeId);
}

function formatBeautyCoverage(name: string, count: number): string {
  const status = count >= DAILY_BEAUTY_MIN_IMAGES_PER_ITEM ? 'OK' : '不足';
  return `${name}${count}/${DAILY_BEAUTY_MIN_IMAGES_PER_ITEM}${status}`;
}

function currentDailyBeautyCoverageLines(userId: number, scopeId: number): string[] {
  const player = dailyPlayerFor(userId, scopeId);
  const team = dailyCardFor('csteam', userId, scopeId, csTeams);
  const map = dailyCardFor('csmap', userId, scopeId, csMaps);
  const weapon = dailyCardFor('csweapon', userId, scopeId, csWeapons);
  const skin = dailySkinForWeapon(weapon, userId, scopeId);
  const role = dailyCardFor('csrole', userId, scopeId, csRoles);
  const utility = dailyCardFor('csutility', userId, scopeId, csUtilities);
  const tactic = dailyCardFor('cstactic', userId, scopeId, csTactics);
  const clutch = dailyCardFor('csclutch', userId, scopeId, csClutches);
  const knife = dailyKnifeFor(userId, scopeId);
  const knifeSkin = dailyKnifeSkinFor(userId, scopeId, knife);
  const mokoko = dailyCharacterFor(userId, scopeId);
  const genshin = dailyGenshinFor(userId, scopeId);
  const fact = dailyFactFor(userId, scopeId);
  const book = dailyBookExcerptFor(userId, scopeId);
  const poem = dailyPoemFor(userId, scopeId);
  const duelWeapon = dailyDuelPlayerWeaponFor(userId, scopeId);
  const rows = [
    formatBeautyCoverage('选手', dailyBeautyImageCountFor('player', [player.nick, player.name, ...(player.aliases || [])])),
    formatBeautyCoverage('战队', dailyBeautyImageCountFor('team', dailyCardManifestSearchValues(team))),
    formatBeautyCoverage('地图', dailyBeautyImageCountFor('map', dailyCardManifestSearchValues(map))),
    formatBeautyCoverage('武器', dailyBeautyImageCountFor('weapon', dailyCardManifestSearchValues(weapon))),
    formatBeautyCoverage('皮肤', dailyBeautySkinImagesFor(skin).length),
    formatBeautyCoverage('定位', dailyBeautyImageCountFor('role', dailyCardManifestSearchValues(role))),
    formatBeautyCoverage('道具', dailyBeautyImageCountFor('utility', dailyCardManifestSearchValues(utility))),
    formatBeautyCoverage('战术', dailyBeautyImageCountFor('tactic', dailyCardManifestSearchValues(tactic))),
    formatBeautyCoverage('残局', dailyBeautyImageCountFor('clutch', dailyCardManifestSearchValues(clutch))),
    formatBeautyCoverage('刀皮', dailyBeautyKnifeImagesFor(knife, knifeSkin).length),
    formatBeautyCoverage('木柜子', dailyBeautyImageCountFor('mokoko', [mokoko.key, mokoko.name, mokoko.band, mokoko.role, mokoko.page])),
    formatBeautyCoverage('原神', dailyBeautyImageCountFor('genshin', [genshin.key, genshin.name, genshin.page, genshin.tag])),
    formatBeautyCoverage('冷知识', dailyBeautyImageCountFor('fact', [fact.key, fact.title, fact.name, fact.subtitle, fact.body, fact.line])),
    formatBeautyCoverage('书摘', dailyBeautyImageCountFor('book', [book.key, book.title, book.name, book.subtitle, book.body, book.line])),
    formatBeautyCoverage('古诗词', dailyBeautyImageCountFor('poem', [poem.key, poem.title, poem.name, poem.subtitle, poem.body, poem.line])),
    formatBeautyCoverage('紫禁之巅', dailyBeautyImageCountFor('duel', [duelWeapon.key, duelWeapon.name, duelWeapon.style])),
  ];
  return [
    `美图最低标准: 每个对象${DAILY_BEAUTY_MIN_IMAGES_PER_ITEM}张起`,
    `当前签位美图覆盖: ${rows.join(' / ')}`,
    '图片隔离: daily-beauty清单必须写kind和对象标识，不能跨功能混用',
  ];
}

function compactDailyImageFields(fields: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const text = String(value || '').trim();
    if (text) result[key] = text;
  }
  return result;
}

function dailyCardManifestFields(card: DailyCard): Record<string, string> {
  const skinCard = isSkinCard(card) ? card : null;
  return compactDailyImageFields({
    key: card.key,
    name: card.name,
    itemName: card.imageLabel || card.name,
    weapon: skinCard?.weapon,
    skin: skinCard?.name,
  });
}

function dailyTextManifestFields(card: DailyTextCard): Record<string, string> {
  return compactDailyImageFields({
    key: card.key,
    name: card.name,
    itemName: card.name,
    title: card.title,
  });
}

function dailyImageTarget(kind: string, label: string, fields: Record<string, string>, count: number, tags: string[] = ['poster', 'wallpaper', 'artwork']): DailyImageManifestTarget {
  return {
    kind,
    label,
    count,
    ok: count >= DAILY_BEAUTY_MIN_IMAGES_PER_ITEM,
    minImages: DAILY_BEAUTY_MIN_IMAGES_PER_ITEM,
    fields,
    tags,
  };
}

function dailyImageManifestTargets(): DailyImageManifestTarget[] {
  const targets: DailyImageManifestTarget[] = [];
  for (const player of csPlayers) {
    targets.push(dailyImageTarget(
      'player',
      player.nick,
      compactDailyImageFields({ key: player.nick, nick: player.nick, name: player.name }),
      dailyBeautyImageCountFor('player', [player.nick, player.name, ...(player.aliases || [])]),
      ['poster', 'action', 'stage', 'wallpaper'],
    ));
  }
  for (const team of csTeams) {
    targets.push(dailyImageTarget('team', team.name, dailyCardManifestFields(team), dailyBeautyImageCountFor('team', dailyCardManifestSearchValues(team)), ['poster', 'stage', 'keyvisual', 'wallpaper']));
  }
  for (const map of csMaps) {
    targets.push(dailyImageTarget('map', map.name, dailyCardManifestFields(map), dailyBeautyImageCountFor('map', dailyCardManifestSearchValues(map)), ['map', 'scene', 'wallpaper', 'screenshot']));
  }
  for (const weapon of csWeapons) {
    targets.push(dailyImageTarget('weapon', weapon.name, dailyCardManifestFields(weapon), dailyBeautyImageCountFor('weapon', dailyCardManifestSearchValues(weapon)), ['inspect', 'showcase', 'render', 'wallpaper']));
  }
  for (const skin of csSkins) {
    targets.push(dailyImageTarget('skin', skin.name, compactDailyImageFields({
      key: skin.key,
      weapon: skin.weapon,
      skin: skin.name,
      name: skin.name,
      itemName: skin.name,
    }), dailyBeautySkinImagesFor(skin).length, ['inspect', 'showcase', 'skin', 'render']));
  }
  for (const role of csRoles) {
    targets.push(dailyImageTarget('role', role.name, dailyCardManifestFields(role), dailyBeautyImageCountFor('role', dailyCardManifestSearchValues(role)), ['poster', 'action', 'scene', 'wallpaper']));
  }
  for (const utility of csUtilities) {
    targets.push(dailyImageTarget('utility', utility.name, dailyCardManifestFields(utility), dailyBeautyImageCountFor('utility', dailyCardManifestSearchValues(utility)), ['utility', 'lineup', 'scene', 'showcase']));
  }
  for (const tactic of csTactics) {
    targets.push(dailyImageTarget('tactic', tactic.name, dailyCardManifestFields(tactic), dailyBeautyImageCountFor('tactic', dailyCardManifestSearchValues(tactic)), ['tactic', 'scene', 'poster', 'action']));
  }
  for (const clutch of csClutches) {
    targets.push(dailyImageTarget('clutch', clutch.name, dailyCardManifestFields(clutch), dailyBeautyImageCountFor('clutch', dailyCardManifestSearchValues(clutch)), ['clutch', 'action', 'scene', 'poster']));
  }
  for (const knife of csKnives) {
    for (const skin of knifeSkinPoolFor(knife)) {
      targets.push(dailyImageTarget('knife', `${knife.name} | ${skin.name}`, compactDailyImageFields({
        key: knife.key,
        name: knife.name,
        skin: skin.name,
        itemKey: skin.key,
        itemName: `${knife.name} | ${skin.name}`,
      }), dailyBeautyKnifeImagesFor(knife, skin).length, ['inspect', 'showcase', 'knife', 'skin']));
    }
  }
  for (const character of dailyCharacters) {
    targets.push(dailyImageTarget('mokoko', character.name, compactDailyImageFields({
      key: character.key,
      name: character.name,
      characterKey: character.key,
      characterName: character.name,
      itemName: character.name,
    }), dailyBeautyImageCountFor('mokoko', [character.key, character.name, character.band, character.role, character.page]), ['card', 'artwork', 'stage', 'keyvisual']));
  }
  for (const character of dailyGenshinCharacters) {
    targets.push(dailyImageTarget('genshin', character.name, compactDailyImageFields({
      key: character.key,
      name: character.name,
      characterKey: character.key,
      characterName: character.name,
      itemName: character.name,
    }), dailyBeautyImageCountFor('genshin', [character.key, character.name, character.page, character.tag]), ['splash', 'artwork', 'card', 'wallpaper']));
  }
  for (const fact of dailyFacts) {
    targets.push(dailyImageTarget('fact', fact.name, dailyTextManifestFields(fact), dailyBeautyImageCountFor('fact', [fact.key, fact.title, fact.name, fact.subtitle, fact.body, fact.line]), ['poster', 'scene', 'illustration', 'wallpaper']));
  }
  for (const book of dailyBookExcerpts) {
    targets.push(dailyImageTarget('book', book.name, dailyTextManifestFields(book), dailyBeautyImageCountFor('book', [book.key, book.title, book.name, book.subtitle, book.body, book.line]), ['cover', 'artwork', 'scene', 'poster']));
  }
  for (const poem of dailyPoems) {
    targets.push(dailyImageTarget('poem', poem.name, dailyTextManifestFields(poem), dailyBeautyImageCountFor('poem', [poem.key, poem.title, poem.name, poem.subtitle, poem.body, poem.line]), ['scene', 'landscape', 'wallpaper', 'artwork']));
  }
  for (const weapon of duelWeapons) {
    targets.push(dailyImageTarget('duel', weapon.name, compactDailyImageFields({
      key: weapon.key,
      name: weapon.name,
      itemName: weapon.name,
    }), dailyBeautyImageCountFor('duel', [weapon.key, weapon.name, weapon.style]), ['poster', 'action', 'showcase', 'scene']));
  }
  return targets;
}

function dailyBeautyAuditRows(): Array<{ kind: string; label: string; count: number; ok: boolean }> {
  return dailyImageManifestTargets().map((target) => ({
    kind: target.kind,
    label: target.label,
    count: target.count,
    ok: target.ok,
  }));
}

function buildDailyImageAuditReport(limit: number = 30): string {
  const rows = dailyBeautyAuditRows();
  const missing = rows.filter((row) => !row.ok).sort((a, b) => a.count - b.count || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  const okCount = rows.length - missing.length;
  const shown = missing.slice(0, Math.max(1, Math.min(limit, 80)));
  const lines = [
    '每日图片池全量审计',
    `标准: 每个具体对象${DAILY_BEAUTY_MIN_IMAGES_PER_ITEM}张起，不能混池`,
    `通用每日美图: ${loadDailyBeautyImages().length}张`,
    `达标: ${okCount}/${rows.length}`,
    `未达标: ${missing.length}`,
    '隔离规则: daily-beauty必须写kind和对象标识；刀皮/枪皮按武器+皮肤成对匹配',
    '套餐说明: 今日CS套餐使用战队图+枪皮图，分别按team/skin审计',
  ];
  if (missing.length > 0) {
    lines.push(`未达标前${shown.length}项:`);
    for (const row of shown) lines.push(`${row.kind} ${row.label}: ${row.count}/${DAILY_BEAUTY_MIN_IMAGES_PER_ITEM}`);
    if (missing.length > shown.length) lines.push(`还有${missing.length - shown.length}项未展示，可补齐清单后再查。`);
  } else {
    lines.push('全部对象都达到200张起步。');
  }
  return lines.join('\n');
}

function formatDailyImageTargetFields(target: DailyImageManifestTarget): string {
  return Object.entries(target.fields)
    .filter(([key]) => ['key', 'nick', 'name', 'weapon', 'skin', 'characterKey', 'characterName', 'itemKey', 'itemName'].includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .slice(0, 5)
    .join(' ');
}

function buildDailyImageTemplateReport(limit: number = 12): string {
  const targets = dailyImageManifestTargets();
  const missing = targets
    .filter((target) => !target.ok)
    .sort((a, b) => (a.minImages - a.count) - (b.minImages - b.count) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  const shown = missing.slice(0, Math.max(1, Math.min(limit, 40)));
  const lines = [
    '每日图片待补清单',
    `对象总数: ${targets.length}`,
    `未达标: ${missing.length}`,
    '模板文件: data/daily-beauty-images.todo.json',
    'VPS更新: npm run update 会自动写模板、审计、构建、重启',
  ];
  if (shown.length > 0) {
    lines.push(`待补前${shown.length}项:`);
    for (const target of shown) {
      lines.push(`${target.kind} ${target.label}: 还差${Math.max(0, target.minImages - target.count)}张 ${formatDailyImageTargetFields(target)}`);
    }
    if (missing.length > shown.length) lines.push(`还有${missing.length - shown.length}项未展示，模板文件里会放全量缺口。`);
  } else {
    lines.push('当前没有待补项。');
  }
  return lines.join('\n');
}

function buildDailyImageStatusReport(userId: number, scopeId: number, limit: number = 12): string {
  const rows = dailyBeautyAuditRows();
  const missing = rows.filter((row) => !row.ok).sort((a, b) => a.count - b.count || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return [
    '每日图片池状态',
    `对象总数: ${rows.length}`,
    `达标: ${rows.length - missing.length}/${rows.length}`,
    `未达标: ${missing.length}`,
    `通用每日美图: ${loadDailyBeautyImages().length}张`,
    ...dailyImageManifestCacheLines(),
    ...currentDailyBeautyCoverageLines(userId, scopeId),
    missing.length > 0
      ? `优先补: ${missing.slice(0, Math.max(1, Math.min(limit, 20))).map((row) => `${row.kind} ${row.label} ${row.count}/${DAILY_BEAUTY_MIN_IMAGES_PER_ITEM}`).join(' | ')}`
      : '全部对象都达到200张起步。',
    'VPS只跑: npm run update',
  ].join('\n');
}

function buildDailyImageCacheReport(): string {
  return [
    '每日图片缓存状态',
    ...dailyImageManifestCacheLines(),
    '改完清单后不用重启；文件大小或修改时间变化会自动重载。',
  ].join('\n');
}

function buildDailyImageHelp(): string {
  return [
    '每日图片池命令',
    '/dailyimage audit [数量] - 全量审计所有对象是否各自200张起',
    '/dailyimage status - 当前签位和全局图片池状态',
    '/dailyimage cache - 本地清单缓存和匹配缓存状态',
    '/dailyimage template [数量] - 看待补清单摘要',
    '/csplayer status - 当前抽签结果的图片覆盖',
    'VPS只跑: npm run update',
    '脚本会自动拉代码、构建、自检、审计、写 data/daily-beauty-images.todo.json、重启服务。',
  ].join('\n');
}

function dailyImageManifestCacheLines(): string[] {
  loadBestdoriCardImages();
  loadPlayerManifestImages();
  loadGenshinManifestImages();
  loadDailyBeautyImages();
  const stats = getImageManifestCacheStats();
  const hits = stats.reduce((sum, item) => sum + item.hits, 0);
  const reloads = stats.reduce((sum, item) => sum + item.reloads, 0);
  const memoryKB = stats.reduce((sum, item) => sum + item.approxMemoryKB, 0);
  const urlCount = stats.reduce((sum, item) => sum + item.uniqueUrls, 0);
  const matchStats = dailyBeautyMatchCacheStats();
  const lines = [`清单缓存: ${stats.length}份 URL${urlCount} 内存约${memoryKB}KB 命中${hits} 重载${reloads}`];
  lines.push(`美图匹配缓存: ${matchStats.size}/${matchStats.max} 命中${matchStats.hits}/${matchStats.misses} 淘汰${matchStats.evictions}`);
  for (const item of stats.slice(0, 4)) {
    const rel = path.relative(process.cwd(), item.path).replace(/\\/g, '/');
    lines.push(`${item.key}: ${item.exists ? `${item.cards}张/${item.kinds}类/${item.uniqueUrls}URL` : '未放清单'} hit${item.hits} reload${item.reloads} ${rel}${item.lastError ? ` 错误=${item.lastError.slice(0, 48)}` : ''}`);
  }
  return lines;
}

function bestdoriCardsForCharacter(character: DailyCharacter): BestdoriCardImage[] {
  const key = character.key.toLowerCase();
  const names = character.name.toLowerCase().split('/').map((item) => item.trim()).filter(Boolean);
  return loadBestdoriCardImages().filter((card) => {
    const cardKey = String(card.characterKey || '').toLowerCase();
    const cardName = String(card.characterName || '').toLowerCase();
    return (cardKey && cardKey === key) || (cardName && names.some((name) => cardName.includes(name) || name.includes(cardName)));
  });
}

function rotateManifestCards(cards: BestdoriCardImage[], seedKey: string, userId: number, scopeId: number, limit = DAILY_IMAGE_CANDIDATE_LIMIT): BestdoriCardImage[] {
  if (cards.length === 0) return [];
  const start = dailySeedForKind(seedKey, userId, scopeId) % cards.length;
  return Array.from({ length: Math.min(cards.length, limit) }, (_unused, index) => cards[(start + index) % cards.length]);
}

function playerManifestImagesFor(player: CSPlayer): BestdoriCardImage[] {
  const keys = [player.nick, player.name, ...(player.aliases || [])]
    .map(compactManifestValue)
    .filter(Boolean);
  return preferBeautyManifestImages(loadPlayerManifestImages().filter((card) => {
    const values = [card.key, card.nick, card.name, card.characterKey, card.characterName]
      .map(compactManifestValue)
      .filter(Boolean);
    return values.some((value) => keys.some((key) => value === key || value.includes(key) || key.includes(value)));
  }));
}

function genshinManifestImagesFor(character: DailyGenshinCharacter): BestdoriCardImage[] {
  const keys = [character.key, character.name]
    .map(compactManifestValue)
    .filter(Boolean);
  return preferBeautyManifestImages(loadGenshinManifestImages().filter((card) => {
    const values = [card.key, card.name, card.characterKey, card.characterName]
      .map(compactManifestValue)
      .filter(Boolean);
    return values.some((value) => keys.some((key) => value === key || value.includes(key) || key.includes(value)));
  }));
}

async function buildCsPlayerImageCandidates(player: CSPlayer, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const beautyCandidates = dailyBeautyCandidatesFor(
    'player',
    player.nick,
    [player.nick, player.name, ...(player.aliases || [])],
    userId,
    scopeId,
  );
  const manifestCandidates = rotateManifestCards(playerManifestImagesFor(player), `csplayer_manifest_${player.nick}`, userId, scopeId)
    .filter((card) => card.url)
    .map((card, index): ImageCandidate => ({
      url: String(card.url),
      label: `${player.nick}/authorized-player/${card.title || index + 1}`,
      source: 'authorized-image',
    }));
  return [
    ...beautyCandidates,
    ...manifestCandidates,
    ...await buildImageCandidates(player.image, player.nick),
  ];
}

function dailyCardManifestSearchValues(card: DailyCard): unknown[] {
  const skinCard = isSkinCard(card) ? card : null;
  return [
    card.key,
    card.name,
    card.imageLabel,
    card.subtitle,
    card.liquipediaPage,
    card.fandomPage,
    card.fandomFile,
    card.playerImageFallback,
    skinCard?.weapon,
    skinCard ? `${skinCard.weapon} ${skinCard.name}` : '',
    skinCard ? `${skinCard.weapon} | ${skinCard.name}` : '',
  ];
}

async function buildDailyCardImageCandidates(kind: string, card: DailyCard, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const beautyCandidates = kind === 'skin' && isSkinCard(card)
    ? dailyBeautySkinCandidates(card, userId, scopeId)
    : dailyBeautyCandidatesFor(kind, card.name, dailyCardManifestSearchValues(card), userId, scopeId);
  return [
    ...beautyCandidates,
    ...await buildImageCandidates(card.image, undefined, card),
  ];
}

async function buildCharacterImageCandidates(character: DailyCharacter, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const candidateUrls: ImageCandidate[] = dailyBeautyCandidatesFor(
    'mokoko',
    character.name,
    [character.key, character.name, character.band, character.role, character.page],
    userId,
    scopeId,
  );
  const bestdoriCards = bestdoriCardsForCharacter(character);
  if (bestdoriCards.length > 0) {
    for (const card of rotateManifestCards(bestdoriCards, `mokoko_bestdori_${character.key}`, userId, scopeId)) {
      if (card.url) {
        candidateUrls.push({
          url: card.url,
          label: `${character.name}/bestdori-card/${card.title || candidateUrls.length + 1}`,
          source: 'bestdori-card',
        });
      }
    }
  }
  if (character.file) {
    try {
      const fileUrl = await Promise.race([
        fandomImageResolver(character.file, 'bandori'),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (fileUrl) {
        candidateUrls.push({
          url: fileUrl,
          label: `${character.name}/bandori-file`,
          source: 'fandom-file',
        });
      }
    } catch (err) {
      console.warn(`[fun] ${character.name} Bandori文件图解析失败:`, err instanceof Error ? err.message : err);
    }
  }
  try {
    const pageUrl = await Promise.race([
      fandomPageImageResolver(character.page, 'bandori'),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (pageUrl) {
      candidateUrls.push({
        url: pageUrl,
        label: `${character.name}/bandori-page`,
        source: 'fandom-page',
      });
    }
  } catch (err) {
    console.warn(`[fun] ${character.name} Bandori页面图解析失败:`, err instanceof Error ? err.message : err);
  }
  const seen = new Set<string>();
  return candidateUrls.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function buildGenshinImageCandidates(character: DailyGenshinCharacter, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const candidateUrls: ImageCandidate[] = dailyBeautyCandidatesFor(
    'genshin',
    character.name,
    [character.key, character.name, character.page, character.tag],
    userId,
    scopeId,
  );
  const manifestCards = rotateManifestCards(genshinManifestImagesFor(character), `genshin_manifest_${character.key}`, userId, scopeId);
  for (const card of manifestCards) {
    if (!card.url) continue;
    candidateUrls.push({
      url: card.url,
      label: `${character.name}/authorized-genshin/${card.title || candidateUrls.length + 1}`,
      source: 'authorized-image',
    });
  }
  const fileCandidates = [
    `Character ${character.name} Card.png`,
    `${character.name} Card.png`,
    `Character ${character.name} Portrait.png`,
    `${character.name} Icon.png`,
  ];
  const resolvedFiles = await Promise.all(fileCandidates.map(async (filename) => {
    try {
      return {
        filename,
        url: await Promise.race([
          fandomImageResolver(filename, 'genshin'),
          new Promise<null>((r) => setTimeout(() => r(null), 3500)),
        ]),
      };
    } catch (err) {
      console.warn(`[fun] ${character.name} Genshin文件图解析失败:`, err instanceof Error ? err.message : err);
      return { filename, url: null };
    }
  }));
  for (const item of resolvedFiles) {
    if (!item.url) continue;
    candidateUrls.push({
      url: item.url,
      label: `${character.name}/genshin-file/${item.filename}`,
      source: 'fandom-file',
    });
  }
  try {
    const pageUrl = await Promise.race([
      fandomPageImageResolver(character.page, 'genshin'),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (pageUrl) {
      candidateUrls.push({
        url: pageUrl,
        label: `${character.name}/genshin-page`,
        source: 'fandom-page',
      });
    }
  } catch (err) {
    console.warn(`[fun] ${character.name} Genshin页面图解析失败:`, err instanceof Error ? err.message : err);
  }
  const seen = new Set<string>();
  return candidateUrls.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function buildDuelImageCandidates(weapon: DailyDuelWeapon, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  const candidates: ImageCandidate[] = dailyBeautyCandidatesFor(
    'duel',
    weapon.name,
    [weapon.key, weapon.name, weapon.style],
    userId,
    scopeId,
  );
  if (weapon.image) {
    candidates.push({ url: weapon.image, label: `${weapon.name}/static`, source: 'static-url' });
  }
  if (weapon.fandomFile) {
    try {
      const fandomUrl = await Promise.race([
        fandomImageResolver(weapon.fandomFile, 'counterstrike'),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (fandomUrl) candidates.push({ url: fandomUrl, label: `${weapon.name}/${weapon.fandomFile}`, source: 'fandom-file' });
    } catch (err) {
      console.warn(`[fun] ${weapon.name} 紫禁之巅图片解析失败:`, err instanceof Error ? err.message : err);
    }
  }
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function buildCsPlayerMessage(userId: number, player: CSPlayer, score?: number, scopeId: number = 0): Promise<MessageSegment[]> {
  const scoreText = typeof score === 'number' ? `${scoreLine(score)} ${score}/100` : '';
  const roleAdvice = playerRoleAdvice(player, score);
  const text = [
    `今日CS选手 | ${player.nick}`,
    scoreText,
    `${player.team} / ${player.role}`,
    `真名：${player.name}`,
    `今天打法：${roleAdvice.style}`,
    `别急点：${roleAdvice.avoid}`,
    `今日短评：${player.note}`,
  ].filter(Boolean).join('\n');
  const message: MessageSegment[] = [
    { type: 'at', data: { qq: String(userId) } },
    { type: 'text', data: { text: ` ${text}` } },
  ];
  message.push(...await imageFromCandidatesOrCard(await buildCsPlayerImageCandidates(player, userId, scopeId), {
    key: `player-${player.nick}`,
    title: '今日CS选手',
    name: player.nick,
    subtitle: `${player.team} / ${player.role}`,
    scoreLabel: '签位',
    advice: roleAdvice.style,
    avoid: roleAdvice.avoid,
    line: player.note,
    imageLabel: player.nick,
  }, typeof score === 'number' ? score : dailyPlayerScore(userId, scopeId)));
  return message;
}

async function buildPrivateCsPlayerMessage(player: CSPlayer, score?: number, userId: number = 0, scopeId: number = 0): Promise<MessageSegment[]> {
  const message = (await buildCsPlayerMessage(userId, player, score, scopeId)).filter((seg) => seg.type !== 'at');
  return message;
}

async function buildDailyCardMessage(userId: number, card: DailyCard, score: number, isPrivate: boolean, kind: string = 'daily', scopeId: number = 0): Promise<MessageSegment[]> {
  const text = [
    `${card.title} | ${card.name}`,
    card.subtitle,
    `${card.scoreLabel}：${score}/100`,
    `今天打法：${card.advice}`,
    `别急点：${card.avoid}`,
    `今日短评：${card.line}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates(kind, card, userId, scopeId), card, score));
  return message;
}

async function buildSkinMessage(userId: number, skin: SkinCard, score: number, isPrivate: boolean, scopeId: number = 0): Promise<MessageSegment[]> {
  const text = [
    `${skin.title} | ${skin.name}`,
    `${skin.weapon} / ${skin.rarity}`,
    skin.subtitle,
    `${skin.scoreLabel}：${score}/100`,
    `今天打法：${skin.advice}`,
    `别急点：${skin.avoid}`,
    `今日短评：${skin.line}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates('skin', localSkinCard(skin), userId, scopeId), localSkinCard(skin), score));
  return message;
}

async function buildWeaponMessage(userId: number, weapon: DailyCard, skin: SkinCard, score: number, isPrivate: boolean, scopeId: number = 0): Promise<MessageSegment[]> {
  const text = [
    `${weapon.title} | ${weapon.name}`,
    weapon.subtitle,
    `${weapon.scoreLabel}：${score}/100`,
    `配套皮肤：${skin.name} (${skin.rarity})`,
    `今天打法：${weapon.advice}`,
    `皮肤加成：${skin.advice}`,
    `别急点：${weapon.avoid}`,
    `今日短评：${weapon.line}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates('weapon', weapon, userId, scopeId), weapon, score));
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates('skin', localSkinCard(skin), userId, scopeId), localSkinCard(skin), score));
  return message;
}

async function buildKnifeMessage(userId: number, knife: KnifeCard, skin: KnifeSkin, score: number, isPrivate: boolean, scopeId: number = 0): Promise<MessageSegment[]> {
  const card: DailyCard = {
    key: `knife-${knife.key}-${skin.key}`,
    title: '今日发刀',
    name: `${knife.name} | ${skin.name}`,
    subtitle: `${knife.subtitle} / ${skin.rarity}`,
    scoreLabel: '刀运指数',
    advice: `${knife.advice} ${skin.advice}`,
    avoid: `${knife.avoid} ${skin.avoid}`,
    line: `${knife.line} ${skin.line}`,
    imageLabel: `${knife.name} ${skin.name}`,
  };
  const text = [
    `${card.title} | ${knife.name}`,
    `皮肤：${skin.name} (${skin.rarity})`,
    knife.subtitle,
    `${card.scoreLabel}：${score}/100`,
    `今天打法：${card.advice}`,
    `别急点：${card.avoid}`,
    `今日短评：${card.line}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildKnifeImageCandidates(knife, skin, userId, scopeId), card, score));
  return message;
}

async function buildMokokoMessage(userId: number, character: DailyCharacter, score: number, isPrivate: boolean, scopeId: number = 0): Promise<MessageSegment[]> {
  const card: DailyCard = {
    key: `mokoko-${character.key}`,
    title: character.title,
    name: character.name,
    subtitle: `${character.band} / ${character.role}`,
    scoreLabel: '木柜子指数',
    advice: character.note,
    avoid: '别把每日木柜子当CS事实，这条是纯角色抽签。',
    line: `${character.band} ${character.role}，CV：${character.voice}`,
    imageLabel: character.name,
  };
  const text = [
    `${character.title} | ${character.name}`,
    `${character.band} / ${character.role}`,
    `CV：${character.voice}`,
    `木柜子指数：${score}/100`,
    `今日短评：${character.note}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildCharacterImageCandidates(character, userId, scopeId), card, score));
  return message;
}

async function buildGenshinMessage(userId: number, character: DailyGenshinCharacter, score: number, isPrivate: boolean, scopeId: number = 0): Promise<MessageSegment[]> {
  const card: DailyCard = {
    key: `genshin-${character.key}`,
    title: character.title,
    name: character.name,
    subtitle: character.tag,
    scoreLabel: '共鸣指数',
    advice: character.note,
    avoid: '别把今日角色当抽卡建议，先看钱包和版本安排。',
    line: `${character.tag}，今天把节奏打稳一点。`,
    imageLabel: character.name,
  };
  const text = [
    `${character.title} | ${character.name}`,
    `今日关键词：${character.tag}`,
    `共鸣指数：${score}/100`,
    `今日短评：${character.note}`,
    '提醒：这只是每日角色签，不是抽卡建议。',
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildGenshinImageCandidates(character, userId, scopeId), card, score));
  return message;
}

function dailyTextCardAsImageCard(card: DailyTextCard): DailyCard {
  return {
    key: card.key,
    title: card.title,
    name: card.name,
    subtitle: card.subtitle,
    scoreLabel: card.scoreLabel,
    advice: card.advice,
    avoid: '',
    line: card.line,
    imageLabel: card.name,
  };
}

async function buildDailyTextImageCandidates(kind: string, card: DailyTextCard, userId: number = 0, scopeId: number = 0): Promise<ImageCandidate[]> {
  return dailyBeautyCandidatesFor(
    kind,
    card.name,
    [card.key, card.title, card.name, card.subtitle, card.body, card.line],
    userId,
    scopeId,
  );
}

async function buildDailyTextCardMessage(userId: number, card: DailyTextCard, score: number, isPrivate: boolean, kind: string = 'text', scopeId: number = 0): Promise<MessageSegment[]> {
  const text = [
    `${card.title} | ${card.name}`,
    card.subtitle,
    `${card.scoreLabel}：${score}/100`,
    card.body,
    `今日短评：${card.line}`,
    `可以试试：${card.advice}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  const imageCard = dailyTextCardAsImageCard(card);
  message.push(...await imageFromCandidatesOrCard(await buildDailyTextImageCandidates(kind, card, userId, scopeId), imageCard, score));
  return message;
}

function duelOutcome(userWeapon: DailyDuelWeapon, botWeapon: DailyDuelWeapon, userId: number, scopeId: number): {
  winner: 'user' | 'bot' | 'draw';
  title: string;
  detail: string;
  userRoll: number;
  botRoll: number;
} {
  const chaos = dailySeedForKind(`daily_duel_chaos_${userWeapon.key}_${botWeapon.key}`, userId, scopeId) % 41;
  const userRoll = userWeapon.power + Math.floor(userWeapon.tempo / 3) + (chaos % 21);
  const botRoll = botWeapon.power + Math.floor(botWeapon.tempo / 3) + ((chaos * 7) % 21);
  if (Math.abs(userRoll - botRoll) <= 4) {
    return {
      winner: 'draw',
      title: '平局收场',
      detail: `${userWeapon.name} 和 ${botWeapon.name} 打到最后谁也没服，紫禁之巅只剩一地节目效果。`,
      userRoll,
      botRoll,
    };
  }
  if (userRoll > botRoll) {
    return {
      winner: 'user',
      title: '你赢了',
      detail: `${userWeapon.name} ${userWeapon.style}，硬是压过了机器的 ${botWeapon.name}。`,
      userRoll,
      botRoll,
    };
  }
  return {
    winner: 'bot',
    title: '机器赢了',
    detail: `机器掏出 ${botWeapon.name} 打出 ${botWeapon.style}，你这把 ${userWeapon.name} 差了半口气。`,
    userRoll,
    botRoll,
  };
}

async function buildDailyDuelMessage(userId: number, scopeId: number, isPrivate: boolean): Promise<MessageSegment[]> {
  const userWeapon = dailyDuelPlayerWeaponFor(userId, scopeId);
  const botWeapon = dailyDuelBotWeaponFor(userId, scopeId);
  const outcome = duelOutcome(userWeapon, botWeapon, userId, scopeId);
  const score = dailyScoreForKind('daily_duel', userId, scopeId);
  const card: DailyCard = {
    key: `duel-${userWeapon.key}-${botWeapon.key}`,
    title: '每日决战紫禁之巅',
    name: `${userWeapon.name} VS ${botWeapon.name}`,
    subtitle: outcome.title,
    scoreLabel: '节目效果',
    advice: outcome.detail,
    avoid: '',
    line: `${userWeapon.line} / ${botWeapon.line}`,
    imageLabel: `${userWeapon.name} VS ${botWeapon.name}`,
  };
  const text = [
    '每日决战紫禁之巅',
    `你：${userWeapon.name}（${userWeapon.style}）`,
    `机器：${botWeapon.name}（${botWeapon.style}）`,
    `结果：${outcome.title}`,
    `判定：${outcome.detail}`,
    `战力：你 ${outcome.userRoll} / 机器 ${outcome.botRoll}`,
    `节目效果：${score}/100`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  const candidates = [
    ...await buildDuelImageCandidates(userWeapon, userId, scopeId),
    ...await buildDuelImageCandidates(botWeapon, userId, scopeId),
  ];
  message.push(...await imageFromCandidatesOrCard(candidates, card, score));
  return message;
}

async function buildLoadoutMessage(userId: number, scopeId: number, isPrivate: boolean): Promise<MessageSegment[]> {
  const team = dailyCardFor('csteam_pack', userId, scopeId, csTeams);
  const map = dailyCardFor('csmap_pack', userId, scopeId, csMaps);
  const weapon = dailyCardFor('csweapon_pack', userId, scopeId, csWeapons);
  const skin = dailySkinForWeapon(weapon, userId, scopeId);
  const role = dailyCardFor('csrole_pack', userId, scopeId, csRoles);
  const score = dailyScoreForKind('csloadout', userId, scopeId);
  const text = [
    '今日CS套餐',
    `队伍：${team.name}`,
    `地图：${map.name}`,
    `武器：${weapon.name}`,
    `皮肤：${skin.name}`,
    `定位：${role.name}`,
    `综合节目效果：${score}/100`,
    `今天打法：${role.advice} ${weapon.advice}`,
    `皮肤加成：${skin.advice}`,
    `别急点：${map.avoid}`,
    `今日短评：${score >= 80 ? '这套签有点东西，今天可以稍微主动一点。' : score >= 45 ? '能打，但别把自己当主角。' : '这套先稳住，别上来就送大的。'}`,
  ].join('\n');
  const message: MessageSegment[] = [];
  if (!isPrivate) message.push({ type: 'at', data: { qq: String(userId) } });
  message.push({ type: 'text', data: { text: isPrivate ? text : ` ${text}` } });
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates('team', team, userId, scopeId), team, score));
  message.push(...await imageFromCandidatesOrCard(await buildDailyCardImageCandidates('skin', localSkinCard(skin), userId, scopeId), localSkinCard(skin), score));
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


    if (isDailyImageAuditRequest(ctx.command, ctx.args, raw)) {
      const limit = Math.max(1, Math.min(parseInt(ctx.args.find((arg) => /^\d+$/.test(arg)) || '30', 10) || 30, 80));
      const action = dailyImageCommandAction(ctx.args, raw);
      if (action === 'help') ctx.reply(buildDailyImageHelp());
      else if (action === 'status') ctx.reply(buildDailyImageStatusReport(ctx.event.user_id, ctx.groupId || 0, limit));
      else if (action === 'cache') ctx.reply(buildDailyImageCacheReport());
      else if (action === 'template') ctx.reply(buildDailyImageTemplateReport(limit));
      else ctx.reply(buildDailyImageAuditReport(limit));
      return true;
    }

    if (isCsPlayerStatusRequest(ctx.command, ctx.args, raw)) {
      const stats = getCacheStats();
      ctx.reply([
        '每日CS选手状态 / 图片状态',
        `选手池: ${csPlayers.length}人`,
        `队伍池: ${csTeams.length}队`,
        `地图/武器/皮肤/定位/道具/战术/残局: ${csMaps.length}/${csWeapons.length}/${csSkins.length}/${csRoles.length}/${csUtilities.length}/${csTactics.length}/${csClutches.length}`,
        `发刀池: 刀型${csKnives.length}类 / 刀皮${knifeSkins.length}种`,
        `木柜子池: MyGO!!!!!/Ave Mujica 共${dailyCharacters.length}人`,
        `Bestdori本地卡面: ${loadBestdoriCardImages().length}张`,
        `原神角色池: ${dailyGenshinCharacters.length}人`,
        `通用每日美图: ${loadDailyBeautyImages().length}张`,
        `选手本地图片: ${loadPlayerManifestImages().length}张`,
        `原神本地图片: ${loadGenshinManifestImages().length}张`,
        ...dailyImageManifestCacheLines(),
        ...currentDailyBeautyCoverageLines(ctx.event.user_id, ctx.groupId || 0),
        `冷知识/书摘/古诗词: ${dailyFacts.length}/${dailyBookExcerpts.length}/${dailyPoems.length}`,
        `紫禁之巅武器池: ${duelWeapons.length}种`,
        `发图顺序: 专属美图池 -> 专用清单 -> 公开图片接口 -> 日签图`,
        `队伍示例: ${csTeams.slice(0, 3).map((item) => `${item.name}(${dailyCardImagePlan(item).replace(/^图片路径：/, '')})`).join(' | ')}`,
        (() => {
          const liq = getLiquipediaImageStats();
          return `Liquipedia图解析: 缓存${liq.entries} 限流${liq.rateLimited ? 'yes' : 'no'}`;
        })(),
        (() => {
          const api = getCsgoSkinsApiStats();
          return `饰品图API: 缓存${api.entries} 拉取中${api.inFlight ? 'yes' : 'no'}${api.lastError ? ` 错误=${api.lastError}` : ''}`;
        })(),
        `图片缓存: ${stats.count}/${stats.maxFiles}张 ${stats.sizeMB}/${stats.maxSizeMB}MB`,
        `图片命中: ${stats.hits}/${stats.misses} 失败${stats.downloadFailures} 飞行${stats.inFlight}`,
        ...(stats.lastError ? [`最近图片错误: ${stats.lastError}`] : []),
        '',
        '/csimage test team|map|weapon|skin|role|utility|tactic|clutch|knife|mokoko|genshin|player|all 测真实图源',
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
        ? await buildPrivateCsPlayerMessage(player, score, ctx.event.user_id, scopeId)
        : await buildCsPlayerMessage(ctx.event.user_id, player, score, scopeId));
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
    if (isDailyKnifeRequest(ctx.command, raw)) {
      const knife = dailyKnifeFor(ctx.event.user_id, scopeId);
      const skin = dailyKnifeSkinFor(ctx.event.user_id, scopeId, knife);
      const score = dailyScoreForKind('csknife', ctx.event.user_id, scopeId);
      ctx.reply(await buildKnifeMessage(ctx.event.user_id, knife, skin, score, ctx.isPrivate, scopeId));
      return true;
    }
    if (isDailyMokokoRequest(ctx.command, raw)) {
      const character = dailyCharacterFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('mokoko', ctx.event.user_id, scopeId);
      ctx.reply(await buildMokokoMessage(ctx.event.user_id, character, score, ctx.isPrivate, scopeId));
      return true;
    }
    if (isDailyGenshinRequest(ctx.command, raw)) {
      const character = dailyGenshinFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('genshin', ctx.event.user_id, scopeId);
      ctx.reply(await buildGenshinMessage(ctx.event.user_id, character, score, ctx.isPrivate, scopeId));
      return true;
    }
    if (isDailyFactRequest(ctx.command, raw)) {
      const card = dailyFactFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('daily_fact', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyTextCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'fact', scopeId));
      return true;
    }
    if (isDailyBookRequest(ctx.command, raw)) {
      const card = dailyBookExcerptFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('daily_book', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyTextCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'book', scopeId));
      return true;
    }
    if (isDailyPoemRequest(ctx.command, raw)) {
      const card = dailyPoemFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('daily_poem', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyTextCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'poem', scopeId));
      return true;
    }
    if (isDailyDuelRequest(ctx.command, raw)) {
      ctx.reply(await buildDailyDuelMessage(ctx.event.user_id, scopeId, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'loadout') || fuzzy === 'csloadout') {
      ctx.reply(await buildLoadoutMessage(ctx.event.user_id, scopeId, ctx.isPrivate));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'team') || fuzzy === 'csteam') {
      const card = dailyCardFor('csteam', ctx.event.user_id, scopeId, csTeams);
      const score = dailyScoreForKind('csteam', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'team', scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'map') || fuzzy === 'csmap') {
      const card = dailyCardFor('csmap', ctx.event.user_id, scopeId, csMaps);
      const score = dailyScoreForKind('csmap', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'map', scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'weapon') || fuzzy === 'csweapon') {
      const card = dailyCardFor('csweapon', ctx.event.user_id, scopeId, csWeapons);
      const skin = dailySkinForWeapon(card, ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('csweapon', ctx.event.user_id, scopeId);
      ctx.reply(await buildWeaponMessage(ctx.event.user_id, card, skin, score, ctx.isPrivate, scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'skin')) {
      const skin = dailySkinFor(ctx.event.user_id, scopeId);
      const score = dailyScoreForKind('csskin', ctx.event.user_id, scopeId);
      ctx.reply(await buildSkinMessage(ctx.event.user_id, skin, score, ctx.isPrivate, scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'role') || fuzzy === 'csrole') {
      const card = dailyCardFor('csrole', ctx.event.user_id, scopeId, csRoles);
      const score = dailyScoreForKind('csrole', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'role', scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'utility') || fuzzy === 'csutility') {
      const card = dailyCardFor('csutility', ctx.event.user_id, scopeId, csUtilities);
      const score = dailyScoreForKind('csutility', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'utility', scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'tactic') || fuzzy === 'cstactic') {
      const card = dailyCardFor('cstactic', ctx.event.user_id, scopeId, csTactics);
      const score = dailyScoreForKind('cstactic', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'tactic', scopeId));
      return true;
    }
    if (isDailyCardRequest(ctx.command, raw, 'clutch') || fuzzy === 'csclutch') {
      const card = dailyCardFor('csclutch', ctx.event.user_id, scopeId, csClutches);
      const score = dailyScoreForKind('csclutch', ctx.event.user_id, scopeId);
      ctx.reply(await buildDailyCardMessage(ctx.event.user_id, card, score, ctx.isPrivate, 'clutch', scopeId));
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
  csSkins,
  csRoles,
  csUtilities,
  csTactics,
  csClutches,
  csKnives,
  knifeSkins,
  dailyCharacters,
  dailyGenshinCharacters,
  dailyFacts,
  dailyBookExcerpts,
  dailyPoems,
  duelWeapons,
  dailyPlayerFor,
  dailyPlayerScore,
  dailyCardFor,
  dailySkinFor,
  dailySkinForWeapon,
  dailyKnifeFor,
  dailyKnifeSkinFor,
  knifeSkinAvailableFor,
  knifeSkinPoolFor,
  dailyCharacterFor,
  dailyGenshinFor,
  dailyFactFor,
  dailyBookExcerptFor,
  dailyPoemFor,
  dailyDuelPlayerWeaponFor,
  dailyDuelBotWeaponFor,
  dailyScoreForKind,
  isCsPlayerDrawRequest,
  isCsPlayerStatusRequest,
  isDailyImageAuditRequest,
  isDailyKnifeRequest,
  isDailyMokokoRequest,
  isDailyGenshinRequest,
  isDailyFactRequest,
  isDailyBookRequest,
  isDailyPoemRequest,
  isDailyDuelRequest,
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
  buildWeaponMessage,
  buildSkinMessage,
  buildKnifeMessage,
  buildMokokoMessage,
  buildGenshinMessage,
  buildCsPlayerImageCandidates,
  buildDailyCardImageCandidates,
  buildKnifeImageCandidates,
  buildCharacterImageCandidates,
  buildGenshinImageCandidates,
  buildDuelImageCandidates,
  buildDailyTextImageCandidates,
  loadBestdoriCardImages,
  loadPlayerManifestImages,
  loadGenshinManifestImages,
  loadDailyBeautyImages,
  dailyImageManifestCacheLines,
  getImageManifestCacheStats,
  buildDailyTextCardMessage,
  buildDailyDuelMessage,
  buildLoadoutMessage,
  buildCsTrainingMessage,
  dailyBeautyAuditRows,
  dailyImageManifestTargets,
  buildDailyImageAuditReport,
  buildDailyImageStatusReport,
  buildDailyImageCacheReport,
  buildDailyImageTemplateReport,
  buildDailyImageHelp,
  dailyBeautyMatchCacheStats,
  dailyCsQuizFor,
  buildCsQuizMessage,
  __setTrainingStorePathForTests: (filepath?: string) => {
    trainingStorePathOverride = filepath || '';
  },
  __setBestdoriCardManifestPathForTests: (filepath?: string) => {
    bestdoriCardManifestPathOverride = filepath || '';
    clearImageManifestCache();
    clearDailyBeautyMatchCache();
  },
  __setPlayerImageManifestPathForTests: (filepath?: string) => {
    playerImageManifestPathOverride = filepath || '';
    clearImageManifestCache();
    clearDailyBeautyMatchCache();
  },
  __setGenshinImageManifestPathForTests: (filepath?: string) => {
    genshinImageManifestPathOverride = filepath || '';
    clearImageManifestCache();
    clearDailyBeautyMatchCache();
  },
  __setDailyBeautyImageManifestPathForTests: (filepath?: string) => {
    dailyBeautyImageManifestPathOverride = filepath || '';
    clearImageManifestCache();
    clearDailyBeautyMatchCache();
  },
  __setImageResolverForTests: (resolver?: (url: string) => Promise<string | null>) => {
    imageDataUrlResolver = resolver || getImageDataUrl;
  },
  __setImageSourceResolversForTests: (resolvers?: {
    player?: (player: string) => Promise<string | null>;
    team?: (page: string, teamName: string) => Promise<string | null>;
    fandom?: (filename: string, wiki?: FandomWiki) => Promise<string | null>;
    fandomPage?: (title: string, wiki?: FandomWiki) => Promise<string | null>;
    csgoSkin?: (weapon: string, skin: string) => Promise<string | null>;
  }) => {
    playerImageResolver = resolvers?.player || resolvePlayerImage;
    teamImageResolver = resolvers?.team || resolveTeamImage;
    fandomImageResolver = resolvers?.fandom || resolveFandomFileImage;
    fandomPageImageResolver = resolvers?.fandomPage || resolveFandomPageImage;
    csgoSkinImageResolver = resolvers?.csgoSkin || resolveCsgoSkinImage;
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
