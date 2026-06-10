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
  | 'csplayer'
  | 'csteam'
  | 'csmap'
  | 'csweapon'
  | 'csrole'
  | 'csloadout'
  | 'cstrain'
  | 'csquiz'
  | 'csutility'
  | 'cstactic'
  | 'csclutch'
  | 'csbrief'
  | 'match'
  | 'ranking'
  | 'cs2news'
  | 'cs2live'
  | 'csmood'
  | 'forecast'
  | 'scene'
  | 'jrrp'
  | 'voice_clone'
  | 'voice_clone_status'
  | 'voice_clone_reset'
  | 'voice_status'
  | 'vision_status'
  | 'vision'
  | 'media_status'
  | 'media_daily'
  | 'mem'
  | 'time'
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
    key: 'csbrief',
    exact: [
      'cs短报', 'cs2短报', 'cs日报', 'cs2日报', '今日cs短报', '今日cs日报',
      '今天cs短报', '今天cs日报', '今天cs有什么看点', '今天cs看点',
      '给我来份cs日报', '来份cs日报', '最近cs总结', '今日cs总结',
    ],
    pairs: [
      { left: ['cs', 'cs2'], right: ['短报', '日报', '总结', '看点'] },
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
  // ===== 直播场景模板 =====
  {
    key: 'scene',
    exact: [
      '直播场景', '场景模板', '来个场景', '来个直播场景',
      '玩机器场景', '切片模板', '语录场景', '学个切片',
      '礼物场景', '白给场景', '残局场景',
    ],
    pairs: [
      { left: ['直播', '切片', '语录', '礼物', '白给', '残局'], right: ['场景', '模板', '怎么说', '话术'] },
    ],
  },
  // ===== /jrrp 今日人品 =====
  {
    key: 'jrrp',
    exact: ['今日人品', 'jrrp', '人品值', '查人品'],
  },
  // ===== 每日 CS 系列 =====
  {
    key: 'csloadout',
    exact: [
      '今日cs', '每日cs', '今天cs', '今日cs2', '每日cs2', '今天cs2',
      '今日套餐', '每日套餐', '今日套装', '每日套装', '今天怎么打', '今天打啥',
      '给我来套cs', '来套cs', '抽一套cs', '今日cs套餐',
    ],
    pairs: [
      { left: ['来套', '套餐', '套装', '一套'], right: ['cs', 'cs2', '套装', '套餐'] },
    ],
  },
  {
    key: 'csplayer',
    exact: [
      '今日选手', '每日选手', '今日cs选手', '每日cs选手', '抽选手',
      '抽个选手', '抽个cs选手', '今天抽谁', '给我抽个职业哥',
      '今日职业哥', '每日职业哥',
    ],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['选手', '职业哥', '职业选手'] },
    ],
  },
  {
    key: 'csteam',
    exact: ['今日队伍', '每日队伍', '抽队伍', '今日战队', '每日战队', '抽战队', '今天主队'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['队伍', '战队', '主队'] },
    ],
  },
  {
    key: 'csmap',
    exact: ['今日地图', '每日地图', '抽地图', '今天哪张图', '今天打什么图'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['地图', '哪张图', '什么图'] },
    ],
  },
  {
    key: 'csweapon',
    exact: ['今日武器', '每日武器', '抽武器', '今日枪械', '今天用什么枪', '今天起什么枪'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['武器', '枪械', '什么枪', '起什么枪'] },
    ],
  },
  {
    key: 'csrole',
    exact: ['今日定位', '每日定位', '抽定位', '今日位置', '今天打什么位', '今天什么位置'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['定位', '位置', '什么位'] },
    ],
  },
  {
    key: 'cstrain',
    exact: [
      '今日cs训练', '每日cs训练', '今天cs训练', '今日cs2训练', '每日cs2训练',
      '今天怎么练枪', '今天练什么枪', '今天练什么道具',
      '来个cs训练', '来个练枪任务', '给我安排cs训练',
      'cs训练计划', 'cs练枪计划', '练枪任务',
    ],
    pairs: [
      { left: ['cs', 'cs2'], right: ['训练', '练枪', '练道具', '练习计划'] },
      { left: ['今天', '今日', '每日', '来个', '安排', '给我'], right: ['练枪任务', '训练计划', '怎么练枪', '练什么枪', '练什么道具'] },
    ],
  },
  {
    key: 'csquiz',
    exact: [
      'cs小考', 'cs2小考', 'cs考题', 'cs2考题', 'cs问答', 'cs2问答',
      'cs挑战', 'cs2挑战', '今日cs题', '每日cs题', '今日cs小考',
      '每日cs小考', '今天cs小考', '今天cs考题', '今天cs问答',
      '今天考我cs', '今天cs考我', '来个cs问答', '来个cs小考',
      '来个cs挑战', '给我来个cs题',
    ],
    pairs: [
      { left: ['cs', 'cs2'], right: ['小考', '考题', '问答', '挑战', '考我', '答题'] },
      { left: ['今日', '每日', '今天', '来个', '给我'], right: ['cs题', 'cs小考', 'cs问答', 'cs挑战', 'cs考题'] },
    ],
  },
  {
    key: 'csutility',
    exact: ['今日道具', '每日道具', '抽道具', '今日投掷物', '今天丢什么', '今天丢什么道具'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['道具', '投掷物', '丢什么'] },
    ],
  },
  {
    key: 'cstactic',
    exact: ['今日战术', '每日战术', '抽战术', '今天打什么战术', '今天怎么进攻'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['战术', '怎么进攻', '怎么打'] },
    ],
  },
  {
    key: 'csclutch',
    exact: ['今日残局', '每日残局', '抽残局', '今天残局', '残局怎么打', '今天残局怎么打'],
    pairs: [
      { left: ['今日', '每日', '今天', '抽', '来个'], right: ['残局', '残局怎么打'] },
    ],
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
  // ===== 多模态状态 =====
  {
    key: 'media_status',
    exact: [
      '多模态状态', '多模态诊断', '多模态体检', '多模态概览',
      '媒体状态', '媒体诊断', '媒体体检',
      '识图语音状态', '语音识图状态', '图片语音状态',
      '识图语音诊断', '语音识图诊断', '图片语音诊断',
      'media status',
    ],
    pairs: [
      { left: ['多模态', '媒体', '识图语音', '语音识图', '图片语音'], right: ['状态', '诊断', '体检', '概览'] },
    ],
  },
  // ===== 语音状态 =====
  {
    key: 'voice_status',
    exact: [
      '语音状态', '声音状态', '语音诊断', '声音诊断', '语音体检',
      '听写状态', '听写诊断', 'stt状态', 'stt诊断',
      'tts状态', 'tts诊断', '发语音状态', '语音缓存状态',
    ],
    pairs: [
      { left: ['语音', '声音', '听写', 'tts', 'stt'], right: ['状态', '诊断', '体检', '缓存'] },
    ],
  },
  // ===== 识图状态 =====
  {
    key: 'vision_status',
    exact: [
      '识图状态', '看图状态', '图片识别状态', '图片状态', '识图诊断',
      '看图诊断', '图片诊断', '视觉状态', '视觉诊断', '图片缓存状态',
      '识图体检', '看图体检',
    ],
    pairs: [
      { left: ['识图', '看图', '图片识别', '视觉', '图片缓存'], right: ['状态', '诊断', '体检'] },
    ],
  },
  // ===== 识图 =====
  {
    key: 'vision',
    exact: [
      '识图', '看图', '看看图', '帮我看图', '看一下图', '看看这张图',
      '看下这图', '这图是什么', '图里是什么', '帮我看看图片',
      '识别图片', '分析图片', '看图说话',
    ],
    pairs: [
      { left: ['看', '识别', '分析', '看看', '帮我看'], right: ['图', '图片', '这张图', '这图'] },
    ],
  },
  // ===== 多模态每日牌 =====
  {
    key: 'media_daily',
    exact: [
      '多模态每日牌', '多模态日报', '多模态日签',
      '今日多模态', '今天多模态', '今日多模态状态', '今天多模态状态',
      '识图语音每日牌', '识图语音日报', '识图语音日签',
      '今日识图语音状态', '今天识图语音状态', '语音识图每日牌',
      '图片语音每日牌', '媒体每日牌', '媒体日报',
      '今日三件套', '今天三件套', '多模态三件套', '媒体三件套',
      '识图语音三件套', '语音识图三件套', '图片语音三件套',
      '今日识图语音三件套', '今天识图语音三件套',
      '今日多模态三件套', '今天多模态三件套',
      '今天识图语音跑了吗', '今日识图语音跑了吗', '识图语音今天跑了吗',
      '今天看图听写跑了吗', '今日看图听写跑了吗', '看图听写今天跑了吗',
      '多模态今天跑了吗', '今天多模态跑了吗', '今日多模态跑了吗',
      'media daily',
    ],
    pairs: [
      { left: ['多模态', '媒体', '识图语音', '语音识图', '图片语音'], right: ['每日', '今日', '今天', '日报', '日签', '链路', '三件套'] },
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
  // ===== /time 时间 =====
  {
    key: 'time',
    exact: [
      '现在几点', '现在时间', '现在多少点', '几点了', '现在什么时间',
      '今天几号', '今天日期', '今天周几', '今天星期几', '今天是星期几',
      '今天几月几号', '现在几月', '今年几月', '今年是哪一年', '今年多少年',
      '现在年份', '什么时候', '今天周末吗', '现在周几',
      '看下时间', '查个时间', '报时',
    ],
    pairs: [
      { left: ['今天', '今日', '现在', '当前', '今年', '本月'], right: ['几点', '几号', '日期', '星期', '周几', '时间', '年份', '月份'] },
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

  // CS 上下文 - 包含选手名、队伍名、CS 关键词、选手昵称的小写都算
  const csContext = /cs|csgo|cs2|玩机器|6657|major|战队|blast|iem|esl|epl|pgl|cct|vrs|valve|hltv|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|complexity|virtuspro|ence|fnatic|3dmax|paIN|natusvincere|teamspirit|teamfalcons|teamvitality|teamliquid|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|magixx|jl|b1t|huNter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian|aurora|dust2|mirage|inferno|nuke|ancient|anubis|train|overpass|忍者|玩处|玩神|玩÷/.test(normalized);

  // 关键词组：比赛/赛程
  const matchKeywords = [
    '比赛', '赛事', '战况', 'major', 'blast', 'iem', 'esl', 'pgl', 'cct',
    '打谁', '哪两个队', '哪场比赛', '什么比赛', '今晚有比赛',
    '现在打', '正在打', '今天打', '明天打', '今晚打', '马上打', '即将开打',
    '赛程', '今晚比赛', '今天比赛', '明天比赛', '什么时候打',
    '打不打', '上场', '出战', '今天上谁', '今晚上谁',
    '决赛', '半决赛', '小组赛', '淘汰赛', '直播间在播什么',
  ];
  const rankingKeywords = [
    '排名', '排行', 'top10', 'top战队', '世界第一', '当前最强',
    '战队榜', 'hltv榜', '强队', '哪些队厉害', '最强战队',
    'vrs', 'valve榜', '现在第一', '现在排第一', '第几名',
    '第一是谁', '第一是哪', '现在前三', 'top3', 'top5', 'top20',
    '现在最强', '现在最厉害', '现在最猛', '哪个战队最强',
    '哪个选手最强', 'top选手', '最佳选手',
    '排名第一', '排名第几', '排第几', '第一是', '前几名',
    '谁第一', '谁是第一', '谁最强', '谁最猛',
  ];
  const resultsKeywords = [
    '战报', '赛果', '比赛结果', '昨天结果', '最近结果',
    '昨天谁赢', '哪个队赢了', '谁拿冠军', '昨天打的怎么样',
    '昨天比赛', '昨晚比赛', '前天比赛', '上周比赛',
    '谁赢了', '比分多少', '几比几', '打多少', '最终比分', '最近怎么样', '近期表现',
  ];

  // 任何强烈 CS 上下文（含选手名、队伍名）都触发 matches 注入，让 AI 能看到当前赛程
  const strongCsContext = /玩机器|6657|navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro/.test(normalized);

  // 强烈 ranking 短语（即使没明确 CS 上下文，也认为是问 CS 排名）
  const strongRankingPhrase = /(?:排名第[一二三四五六七八九十\d]+|hltv|top\d+|世界第一|现在第一|谁第一|谁是第一|谁最强|战队榜|战队排行|最强战队|最强队伍|最强选手)/.test(normalized);

  // 任何 CS 上下文 + 实时性语气 → 全部都拉一遍（matches+results+ranking）
  const realtimeIntent = /(?:现在|今天|当前|目前|最近|今晚|刚才|昨天|前天|这两天|这几天|本周|这周|本月)/.test(normalized);
  const aggressiveCs = csContext && realtimeIntent;

  return {
    needsMatches: aggressiveCs
      || matchKeywords.some((k) => normalized.includes(normalize(k))) && (csContext || /比赛|赛事|赛程/.test(normalized))
      || strongCsContext && /(最近|今天|昨天|现在|今晚|明天|怎么样|状态|表现)/.test(normalized),
    needsRanking: aggressiveCs && /(top|排名|排行|第一|最强|最猛|最厉害|强队|实力)/.test(normalized)
      || rankingKeywords.some((k) => normalized.includes(normalize(k))) && csContext
      || /(top|前几|第一|最强|排名|排行)/.test(normalized) && strongCsContext
      || strongRankingPhrase,
    needsResults: aggressiveCs && /(赢|输|结果|战报|比分|怎么打|表现)/.test(normalized)
      || resultsKeywords.some((k) => normalized.includes(normalize(k))) && (csContext || /战报|赛果/.test(normalized)),
  };
}
