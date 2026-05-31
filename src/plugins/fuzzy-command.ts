/**
 * 中文模糊命令识别
 *
 * 设计原则：
 * - 不要求 `/` 前缀
 * - 支持常见自然语言变体（"今天有什么比赛" → match）
 * - 支持别名（"看看排名" / "查一下排名" / "现在排名" → ranking）
 * - 严格度可配置：strict 模式必须完整短语，loose 模式只要包含关键词
 */

export type FuzzyCommandKey =
  | 'me'
  | 'stats'
  | 'match'
  | 'ranking'
  | 'cs2news'
  | 'cs2live'
  | 'csmood'
  | 'forecast'
  | 'jrrp'
  | 'voice_clone'
  | 'voice_clone_status'
  | 'voice_clone_reset'
  | 'mem'
  | 'help';

interface FuzzyRule {
  key: FuzzyCommandKey;
  /** 完整短语（命中即返回） */
  exact: string[];
  /** 必须同时包含其中之一 + 第二组之一才算命中（精确匹配，避免误触） */
  pairs?: { left: string[]; right: string[] }[];
  /** 单独包含整个短语就命中（已经足够明确） */
  contains?: string[];
}

// 注意：所有规则在 normalize 后比较；normalize 移除标点、空格、统一小写
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\/\\!！]/, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？!?,.~～、:：;；"'""'']/g, '');
}

const FUZZY_RULES: FuzzyRule[] = [
  // ===== /me 我的活跃度 =====
  {
    key: 'me',
    exact: [
      '我的活跃度', '我的统计', '我多活跃', '我活跃吗', '查我',
      '看看我', '看下我', '我话痨吗', '我说了多少',
      '我在群里活跃吗', '我的发言', '我发了多少',
      '我活跃不', '看看我的', '查我的活跃度', '查我的统计',
    ],
    pairs: [
      { left: ['我'], right: ['活跃度', '统计数据', '说了多少话', '排名'] },
      { left: ['查我', '看我', '看看我', '看下我'], right: ['排名', '活跃', '统计', '话痨'] },
    ],
  },
  // ===== /stats 群统计 =====
  {
    key: 'stats',
    exact: [
      '群统计', '群里统计', '看群统计', '查群统计', '群活跃度',
      '话痨排行', '话痨榜', '群排行', '群活跃榜', '看话痨',
      '本群统计', '群活跃情况', '本群活跃度',
    ],
    pairs: [
      { left: ['群'], right: ['统计', '活跃度', '排行', '话痨'] },
    ],
  },
  // ===== /match 当前比赛 =====
  {
    key: 'match',
    exact: [
      '今天有什么比赛', '今天有比赛吗', '现在有比赛吗', '现在打谁',
      '现在哪场比赛', '哪场比赛在打', '比赛打到哪了', '比赛打的怎么样',
      '今天的比赛', '今天比赛', '比赛情况', '比赛战况',
      '当前比赛', '正在打的比赛', '今天cs比赛', '今天cs2比赛',
      '现在哪两个队在打', '现在直播什么比赛',
    ],
    pairs: [
      { left: ['比赛', '战况', '赛事', 'major', 'blast', 'iem', 'esl'], right: ['现在', '今天', '当前', '正在', '今晚', '昨天', '最近'] },
      { left: ['现在', '今天', '正在', '今晚'], right: ['打谁', '哪两个队', '比赛', '哪场'] },
    ],
  },
  // ===== /ranking 当前排名 =====
  {
    key: 'ranking',
    exact: [
      'hltv排名', 'hltv排行', '战队排名', '战队排行', 'top10', 'top战队',
      'cs排名', 'cs2排名', 'cs战队排名', '当前排名', '现在排名',
      '看一下排名', '查一下排名', '看下排名', '查个排名',
      '战队排行榜', '战队榜', '现在第一是谁',
      '现在第一', '现在排第一是谁', '谁是第一', '世界第一战队',
    ],
    pairs: [
      { left: ['排名', '排行', '排行榜', 'ranking'], right: ['hltv', '战队', 'cs', 'cs2', '现在', '当前', '看', '查'] },
      { left: ['top'], right: ['10', '5', '战队', '队'] },
    ],
  },
  // ===== /cs2news 最近战报 =====
  {
    key: 'cs2news',
    exact: [
      '最近比赛', '最近战报', '最近结果', '昨天比赛',
      '昨天比赛结果', '昨天的比赛', 'cs最近', 'cs2最近',
      '最新战报', '最新比赛', '最近赛果', '比赛结果',
      'cs新闻', 'cs2新闻', '最近cs新闻', '看一下战报',
      '昨天哪个队赢了', '昨天谁赢了',
    ],
    pairs: [
      { left: ['最近', '昨天', '最新'], right: ['比赛', '战报', '结果', '赛果', '新闻'] },
    ],
  },
  // ===== /cs2live CS2直播 =====
  {
    key: 'cs2live',
    exact: [
      'cs直播', 'cs2直播', '现在谁在直播', '玩机器开播了吗', '玩机器播了吗',
      '玩机器开播没', '玩机器在播吗', '玩机器在播没',
      '玩机器在直播吗', '6657开播了吗', '6657播了吗',
      '6657在播吗', '现在哪个主播在播', '直播在打谁',
      '看一下直播', '现在直播在打什么',
    ],
    pairs: [
      { left: ['直播', '开播', '播了', '在播'], right: ['玩机器', '6657', 'cs', 'csgo'] },
    ],
  },
  // ===== /csmood 心情 =====
  {
    key: 'csmood',
    exact: [
      '玩机器今天什么状态', '玩机器今天状态', '玩机器心情',
      '今天玩机器状态', '玩机器今天心情', '今日心情', '玩机器情绪',
      '今天什么状态', '玩机器现在什么状态',
    ],
    pairs: [
      { left: ['玩机器', '6657'], right: ['心情', '状态', '情绪'] },
    ],
  },
  // ===== /forecast 综合运势 =====
  {
    key: 'forecast',
    exact: [
      '今日运势', '今天运势', '运势', '看下运势', '查个运势',
      '今天cs运势', '今日cs运势', '我今天怎么打',
    ],
    contains: [],
  },
  // ===== /jrrp 今日人品 =====
  {
    key: 'jrrp',
    exact: ['今日人品', 'jrrp', '人品值', '查人品'],
  },
  // ===== Voice Clone =====
  {
    key: 'voice_clone',
    exact: [
      '学一下我的声音', '学下我的声音', '学我的声音', '克隆我的声音',
      '把我声音学了', '记一下我的声音', '记下我的声音',
      '训练语音', '语音训练', '语音克隆', '克隆语音',
      '用我的声音', '换成我的声音',
    ],
    pairs: [
      { left: ['我', '我的'], right: ['声音', '语音'] },
    ],
  },
  {
    key: 'voice_clone_status',
    exact: [
      '语音克隆状态', '克隆状态', '声音克隆怎么样', '我的声音学了吗',
      '声音学了没', '语音样本状态',
    ],
  },
  {
    key: 'voice_clone_reset',
    exact: [
      '清空语音样本', '删掉我的声音', '不用我的声音了', '清除语音样本',
      '声音样本清空', '重置语音克隆',
    ],
  },
  // ===== /mem 内存 =====
  {
    key: 'mem',
    exact: [
      '内存状态', '看下内存', '查一下内存', '内存占用', '占用多少内存',
      '机器人内存', '现在多少内存',
    ],
  },
  // ===== /help =====
  {
    key: 'help',
    exact: [
      '帮助', '帮一下', '帮个忙', '怎么用', '使用说明', '怎么用机器人',
      '功能列表', '命令列表', '有什么命令', '有什么功能', '能做什么',
    ],
  },
];

/** 构建 fast lookup 表 */
const exactMap = new Map<string, FuzzyCommandKey>();
for (const rule of FUZZY_RULES) {
  for (const ex of rule.exact) {
    exactMap.set(normalize(ex), rule.key);
  }
}

/** 检测是否命中模糊命令 */
export function detectFuzzyCommand(text: string): FuzzyCommandKey | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;

  const normalized = normalize(trimmed);
  if (!normalized) return null;

  // 1. 整句精确匹配（最高优先级，避免误触）
  if (exactMap.has(normalized)) return exactMap.get(normalized)!;

  // 2. 短文本（<= 25 字符）才使用 pairs 模糊匹配
  if (normalized.length > 25) return null;

  for (const rule of FUZZY_RULES) {
    if (rule.pairs) {
      for (const pair of rule.pairs) {
        const hasLeft = pair.left.some((kw) => normalized.includes(normalize(kw)));
        const hasRight = pair.right.some((kw) => normalized.includes(normalize(kw)));
        if (hasLeft && hasRight) return rule.key;
      }
    }
    if (rule.contains) {
      for (const c of rule.contains) {
        if (normalized.includes(normalize(c))) return rule.key;
      }
    }
  }

  return null;
}

/** 检测是否是 CS 相关话题（用于注入实时 HLTV 数据） */
export function detectCsTopicQuery(text: string): {
  needsMatches: boolean;
  needsRanking: boolean;
  needsResults: boolean;
} {
  const normalized = normalize(text);
  if (!normalized) return { needsMatches: false, needsRanking: false, needsResults: false };

  // 关键词组：比赛/赛程
  const matchKeywords = [
    '比赛', '赛事', '战况', 'major', 'blast', 'iem', 'esl', 'pgl', 'cct',
    '打谁', '哪两个队', '哪场比赛', '什么比赛', '今晚有比赛',
    '现在打', '正在打', '今天打', '明天打', '今晚打', '马上打', '即将开打',
    '赛程', '今晚比赛', '今天比赛', '明天比赛', '什么时候打',
    '打不打', '上场', '出战', '今天上谁', '今晚上谁',
  ];
  const rankingKeywords = [
    '排名', '排行', 'top10', 'top战队', '世界第一', '当前最强',
    '战队榜', 'hltv榜', '强队', '哪些队厉害', '最强战队',
    'vrs', 'valve榜', '现在第一', '现在排第一', '第几名',
    '第一是谁', '第一是哪', '现在前三', 'top3',
    '现在最强', '现在最厉害', '现在最猛', '哪个战队最强',
  ];
  const resultsKeywords = [
    '战报', '赛果', '比赛结果', '昨天结果', '最近结果',
    '昨天谁赢', '哪个队赢了', '谁拿冠军', '昨天打的怎么样',
    '昨天比赛', '昨晚比赛', '前天比赛', '上周比赛',
    '谁赢了', '比分多少', '几比几', '打多少', '最终比分',
  ];

  // 必须同时包含 CS 上下文 + 关键词
  const csContext = /cs|csgo|cs2|玩机器|6657|major|战队|major|blast|iem|esl|pgl|cct|vrs|valve|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9/.test(normalized);

  return {
    needsMatches: matchKeywords.some((k) => normalized.includes(normalize(k))) && (csContext || /比赛|赛事|赛程/.test(normalized)),
    needsRanking: rankingKeywords.some((k) => normalized.includes(normalize(k))) && csContext,
    needsResults: resultsKeywords.some((k) => normalized.includes(normalize(k))) && (csContext || /战报|赛果/.test(normalized)),
  };
}
