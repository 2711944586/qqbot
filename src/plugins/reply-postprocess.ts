import * as crypto from 'crypto';
import { sanitizeOutgoingText } from '../message-sanitize';

/**
 * 回复后处理模块
 * 从 ai-chat.ts 拆出
 * 清理 AI 输出的格式标签、舞台说明、Markdown，做长度截断和公式化开头去重
 */

function hashIndex(input: string, mod: number): number {
  const digest = crypto.createHash('sha1').update(input).digest();
  return digest[0] % Math.max(1, mod);
}

/** 去公式化开头 — 去掉"哥们,/兄弟们,/可以的,"等套话 */
export function deFormulaicOpening(text: string): string {
  const trimmed = text.trimStart();
  const match = trimmed.match(
    /^(?:不是哥们|不是，哥们|不是 哥们|哥们|兄弟们?|家人们|可以(?:的)?|有点东西|这波(?:有说法)?|有一说一|讲道理|说实话|看了一眼|简单说两句|先说结论|我的判断是|我只能说)[，,。!！?\s]+(.+)/s,
  );
  if (!match) return text;
  const rest = match[1].trimStart();
  if (!rest) return text;
  if (/^(?:你是不是|你是|我是|到底|bot|机器人|ai|AI)/.test(rest)) return text;
  if (/^(?:来了|收到|在|到|感谢|谢谢)/.test(rest)) return text;

  const replacements = ['等一下，', '这个不太对，', '先别急，', '', ''];
  const idx = hashIndex(rest, replacements.length);
  return `${replacements[idx]}${rest}`.trimStart();
}

/** 自然长度截断 — 超过maxLen时在最后一个句末标点截断 */
export function naturalLengthTrim(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cutoff = text.slice(0, maxLen);
  const lastPunct = Math.max(
    cutoff.lastIndexOf('。'),
    cutoff.lastIndexOf('！'),
    cutoff.lastIndexOf('!'),
    cutoff.lastIndexOf('？'),
    cutoff.lastIndexOf('?'),
    cutoff.lastIndexOf('\n'),
  );
  if (lastPunct > maxLen * 0.5) {
    return cutoff.slice(0, lastPunct + 1).trim();
  }
  const lastComma = Math.max(cutoff.lastIndexOf('，'), cutoff.lastIndexOf(','));
  if (lastComma > maxLen * 0.5) {
    return cutoff.slice(0, lastComma).trim();
  }
  return cutoff.trim();
}

export function hasUnsupportedRumorClaim(text: string, hasRealtimeData: boolean): boolean {
  void hasRealtimeData;
  if (!text) return false;
  const alreadyConservative = /(?:我得查|得查最新|印象里|不一定对|不太确定|具体我得|你查最新|以最新为准|按最新为准|不能保证|别让我硬编|没有实时|没查到准信|没可靠来源|可靠来源|传闻不能当准信|不能拿传闻|别拿传闻)/.test(text);
  if (alreadyConservative) return false;

  const hasRumorLanguage = /(?:听说|据说|传闻|爆料|小道消息|内部消息|消息源说|朋友说|我朋友说|群里(?:都)?说|有人说|弹幕说|贴吧说|论坛说|路边社|圈内说|有哥们说|有兄弟说)/i.test(text);
  if (!hasRumorLanguage) return false;

  const hasCurrentQualifier = /(?:现在|目前|当前|今天|今日|最新|刚刚|昨天|前天|上周|本周|这个月|最近|要|准备|将要)/.test(text);
  const hasCsEntity = /\b(?:navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|device|karrigan|aleksib|jL|b1t)\b/i.test(text);
  const hasCsRealtimeNoun = /(?:阵容|排名|第[一二三四五六七八九十\d]+|top\s*\d|比分|赛果|战绩|转会|换人|签约|租借|加入|离队|下放|替补|首发|bench|benched|rating|ADR|KAST|地图胜率|冠军|淘汰|战胜|赢了|输了)/i.test(text);
  const hasExplicitCsContext = /(?:CS2?|csgo|比赛|赛事|队伍|战队|选手|职业哥|HLTV|hltv)/i.test(text);
  return hasCsEntity || hasCsRealtimeNoun || (hasCurrentQualifier && hasExplicitCsContext);
}

const ORIGINAL_QUOTE_SPEAKER = '(?:玩机器|MachineWJQ|6657|机器|主播|现实主播|本人|本尊)';
const ORIGINAL_QUOTE_MARKER = '(?:原话|逐字(?:原话|台词|转写|复述|字幕)?|真实(?:语录|台词|原文)|核验(?:过的)?(?:短句|语录|原话)|直播(?:原文|原话|台词|字幕)|切片(?:原文|原话|台词|字幕)|经典(?:语录|台词)?|名场面(?:台词|语录|原文)?|完整(?:台词|字幕|转写|原文|原话)|本人(?:语录|说过|讲过)|名言|一字不差|一比一(?:还原|复刻)?|原样(?:复刻|还原|复述|搬运)?|照着(?:说|念|读))';

export function hasUnsupportedOriginalQuoteClaim(text: string): boolean {
  if (!text) return false;
  const safeBoundaries = [
    new RegExp(`(?:不是|不算|不能当|不要当|别当|不应当|不能说成|不要说成|没有|没|未|未经|不保证|不能保证|无法保证|只(?:能|是|当|做|作为)|仅(?:能|是|当|做|作为)).{0,24}${ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`(?:拟态|模板|风格参考|口吻参考|语气参考|摘要|短摘|场景卡|授权笔记|禁用边界).{0,24}${ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`${ORIGINAL_QUOTE_MARKER}.{0,24}(?:未核验|没核验|未经核验|不保证|不能保证|不一定|待核验|拟态|模板|摘要|短摘|场景卡|别当|不是|不算)`, 'i'),
  ];
  if (safeBoundaries.some((pattern) => pattern.test(text))) return false;

  const patterns = [
    new RegExp(`${ORIGINAL_QUOTE_SPEAKER}.{0,18}${ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`${ORIGINAL_QUOTE_MARKER}.{0,18}${ORIGINAL_QUOTE_SPEAKER}`, 'i'),
    new RegExp(`(?:这是|这句|这段|下面|以下|给你来句|来句|给我|来段|来一段|整段|整一下|念一段|复述一下|还原一下|收录|整理).{0,16}${ORIGINAL_QUOTE_MARKER}`, 'i'),
    /(?:我(?:给你)?|给你|给我|直接)?(?:逐字|原样|完整|一字不差|一比一)?(?:复刻|还原|复述|搬运|转写).{0,18}(?:原话|直播原文|切片原文|台词|字幕|名场面|原文)/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function enforceOriginalQuoteBoundary(text: string): string {
  if (!text || !hasUnsupportedOriginalQuoteClaim(text)) return text;

  const cleaned = text
    .replace(new RegExp(`^(?=.{0,80}${ORIGINAL_QUOTE_MARKER}).{0,96}[：:]\\s*`, 'i'), '')
    .replace(new RegExp(`(?:这是|这句|这段|下面(?:这句|这段)?|以下(?:这句|这段)?|给你来句|来句|给我|来段|来一段|整段|整一下|念一段|复述一下|还原一下)?\\s*${ORIGINAL_QUOTE_SPEAKER}?(?:的)?(?:真实|核验(?:过的)?|逐字|经典|名场面|完整)?${ORIGINAL_QUOTE_MARKER}[：:，,。、“”"'\\s]*`, 'gi'), '')
    .replace(new RegExp(`${ORIGINAL_QUOTE_SPEAKER}(?:在直播(?:里|中)?|以前|之前|曾经|确实)?(?:说过|讲过|念过|喊过)[：:，,。、“”"'\\s]*`, 'gi'), '')
    .replace(/(?:我(?:给你)?|给你|给我|直接)?(?:逐字|原样|完整|一字不差|一比一)?(?:复刻|还原|复述|搬运|转写)(?:一下|下)?.{0,10}(?:原话|直播原文|切片原文|台词|字幕|名场面|原文)[：:，,。、“”"'\s]*/gi, '')
    .replace(/(?:一字不差|一比一(?:还原|复刻)?|原样(?:复刻|还原|复述|搬运)?)(?:那种|地|的)?[：:，,。、“”"'\s]*/gi, '')
    .replace(/^[；;，,。:：、\s]+/, '')
    .trim();

  if (!cleaned || cleaned === text.trim()) {
    return '这类我只能按场景学口吻，不能当本人原话';
  }
  return `这类我只能按场景学口吻，不能当本人原话；${cleaned}`;
}

/**
 * 弱化具体未经证实的声明 - 当 AI 回复里出现"现在/目前/今年" + 具体人/数字/日期，
 * 但没有实时数据来源时，把绝对断言改为不确定。
 *
 * 例:
 *   "现在 Top1 是 Vitality" + 无实时数据 → "Top1 我得查最新的"
 *   "donk 现在在 Spirit"   + 无实时数据 → "donk 印象里在 Spirit 但这种事你查最新的"
 */
export function softenUnverifiedClaims(text: string, hasRealtimeData: boolean): string {
  if (!text) return text;

  if (hasUnsupportedRumorClaim(text, hasRealtimeData)) {
    return hasRealtimeData
      ? '这块别拿传闻当准信；有可靠来源就按来源说，没覆盖的别拍死'
      : '这块我没可靠来源，不敢拿传闻当准信；阵容转会、排名比分这种你以最新来源为准';
  }
  if (hasRealtimeData) return text;

  const normalized = text.replace(/\s+/g, '');
  const alreadyConservative = /(?:我得查|得查最新|印象里|不一定对|不太确定|具体我得|你查最新|以最新为准|按最新为准|不能保证|别让我硬编|没有实时|没查到准信)/.test(text);
  const hasCurrentQualifier = /(?:现在|目前|当前|今天|今日|最新|刚刚|昨天|前天|上周|本周|这个月|最近)/.test(text);
  const hasCsEntity = /\b(?:navi|vitality|spirit|faze|mouz|g2|falcons|astralis|liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|zywoo|donk|niko|m0nesy|s1mple|ropz|sh1ro|device|karrigan|aleksib|jL|b1t)\b/i.test(text);
  const hasCsRealtimeNoun = /(?:阵容|排名|第[一二三四五六七八九十\d]+|top\s*\d|比分|赛果|战绩|转会|换人|签约|租借|加入|离队|下放|替补|首发|bench|benched|rating|ADR|KAST|地图胜率|冠军|淘汰|战胜|赢了|输了)/i.test(text);
  const hasFreshLookupClaim = /我(?:刚刚?|刚才|才|已经)?(?:查|搜)(?:了|到)?(?:一下|一眼|了下|下)?/i.test(text);
  const hasExplicitRealtimeSourceClaim =
    /我(?:刚刚?|刚才|才|已经)?(?:查|搜|看|翻)(?:了|到)?(?:一下|一眼|了下|下)?\s*(?:HLTV|hltv|实时(?:数据|资料)?|最新(?:数据|资料|排名|消息)?|资料|数据|榜单|网页|官网|赛程|排名)/i.test(text)
    || /(?:HLTV|hltv|实时(?:数据|资料|榜单)?|最新(?:数据|资料|排名|消息)?)(?:显示|说|写着|给到|查到|来看|上看)/i.test(text);
  const hasGenericSourceClaim = /(?:资料|数据|搜索结果|网页|官网|榜单)(?:显示|说|写着|给到|查到|来看|上看)/i.test(text);
  const hasUnsupportedSourceClaim =
    hasExplicitRealtimeSourceClaim
    || ((hasFreshLookupClaim || hasGenericSourceClaim) && (hasCurrentQualifier || hasCsEntity || hasCsRealtimeNoun));
  if (hasUnsupportedSourceClaim) {
    const stripped = text
      .replace(/我(?:刚刚?|刚才|才|已经)?(?:查|搜)(?:了|到)?(?:一下|一眼|了下|下)?(?:\s*(?:HLTV|hltv|实时(?:数据|资料)?|最新(?:数据|资料|排名|消息)?|资料|数据|榜单|网页|官网|赛程|排名))?[，,。:：、\s]*/gi, '')
      .replace(/我(?:刚刚?|刚才|才|已经)?(?:看|翻)(?:了|到)?(?:一下|一眼|了下|下)?\s*(?:HLTV|hltv|实时(?:数据|资料)?|最新(?:数据|资料|排名|消息)?|资料|数据|榜单|网页|官网|赛程|排名)[，,。:：、\s]*/gi, '')
      .replace(/(?:HLTV|hltv|实时(?:数据|资料|榜单)?|最新(?:数据|资料|排名|消息)?|资料|数据|搜索结果|网页|官网|榜单)(?:显示|说|写着|给到|查到|来看|上看)[，,。:：、\s]*/gi, '')
      .replace(/(?:根据|结合|参考|按|从)(?:HLTV|hltv|实时(?:数据|资料)?|最新(?:数据|资料|排名|消息)?|资料|数据|搜索结果|网页|官网|榜单)[^，。！？!?:：]{0,24}[，,。:：、\s]*/gi, '')
      .replace(/^[，,。:：、\s]+/, '')
      .trim();
    if (hasCurrentQualifier || hasCsEntity || hasCsRealtimeNoun) {
      return '这块我没实时来源，不敢装有来源；排名比分阵容这种你以最新为准';
    }
    return stripped
      ? stripped.replace(/[。.!！]?\s*$/, '') + '。这块我没实时来源，不敢装有来源'
      : '这块我没实时来源，不敢装有来源';
  }
  if (hasCurrentQualifier && (hasCsEntity || hasCsRealtimeNoun) && !alreadyConservative) {
    return text.replace(/[。.!！]?\s*$/, '') + '。这块没实时来源我不敢拍死 你以最新为准';
  }

  // 检测高风险断言模式
  const claimPatterns = [
    // "X 现在/目前 在/是/属于 Y"
    /([\w\u4e00-\u9fa5]{2,12})\s*(?:现在|目前|今年)\s*(?:在|是|属于|加入|签了|阵容)/g,
    // "现在 Top X 是 Y"
    /现在\s*top\s*\d+\s*(?:是|队伍是)\s*[\w\u4e00-\u9fa5]+/gi,
    // "现在/目前 第X 是 Y"
    /(?:现在|目前)\s*(?:第[一二三四五]|排第\d|排名第\d)/g,
    // "X 现在第一/排名第一/top1"
    /[\w\u4e00-\u9fa5]{2,16}\s*(?:现在|目前|当前)\s*(?:第一|第[一二三四五]|top\s*\d|排名第\d)/gi,
    /[\w\u4e00-\u9fa5]{2,16}\s*(?:现在|目前|当前|最新).{0,8}(?:排名|排行|阵容|转会|战绩)/gi,
    /[\w\u4e00-\u9fa5]{2,16}\s*(?:排名|排行)\s*(?:第一|第[一二三四五]|top\s*\d)/gi,
    // "X 打 Y 比分 13-7 / X 2:0 Y"
    /[\w\u4e00-\u9fa5]{2,16}\s*(?:打|赢|输|战胜|淘汰)\s*[\w\u4e00-\u9fa5]{2,16}.{0,12}(?:\d{1,2}\s*[:：-]\s*\d{1,2}|\d\s*比\s*\d)/gi,
    // "上周/昨天/这周 X 队赢了 Y"
    /(?:上周|昨天|今天|这周|本周|前天)\s*[\w\u4e00-\u9fa5]{2,10}\s*(?:赢了|战胜|拿下|淘汰)/g,
    // "X 现在/目前 阵容/状态"
    /(?:阵容|状态)\s*(?:是|为|有)\s*[\w\u4e00-\u9fa5]{2,12}/g,
  ];
  // 如果检测到任何强断言，返回原文 + 不确定后缀
  let hasStrongClaim = false;
  for (const pat of claimPatterns) {
    pat.lastIndex = 0;
    if (pat.test(text)) {
      hasStrongClaim = true;
      break;
    }
  }
  if (!hasStrongClaim) return text;
  // 如果文本已经含"我得查/印象里/不确定/可能"等不确定词，就不再加
  if (alreadyConservative) return text;
  // 否则在文末追加一句不确定的补充
  return normalized.length > 0
    ? text.replace(/[。.!！]?\s*$/, '') + '。这种事变得快 你以最新为准'
    : text;
}

export function hasRealityBoundaryClaim(text: string): boolean {
  if (!text) return false;
  if (/(?:不代表|不能代表|不是|并非|不是真正|不是现实|不是本人|风格\s*bot|群\s*bot|授权这事别乱说|没有授权|别乱说授权)/i.test(text)) {
    return false;
  }
  return (
    /我(?:是|就是|真是|确实是|当然是)(?:现实中的|真正的|真的)?(?:玩机器|MachineWJQ|6657|主播本人|现实主播|本尊)/i.test(text)
    || /(?:玩机器|MachineWJQ|6657|主播本人|现实主播|本尊).{0,8}(?:是我|就是我|本人)/i.test(text)
    || /(?:我|这个号|本号|本账号|账号)(?:代表|代(?:表)?的是|就是|属于)(?:现实)?(?:玩机器|MachineWJQ|6657|主播本人|现实主播|本尊)/i.test(text)
    || /(?:玩机器|MachineWJQ|6657|主播|主播本人|本尊)?(?:官方账号|官方号|本人账号|本尊号|主播本人账号|现实主播账号|玩机器账号)/i.test(text)
    || /(?:官方授权|本人授权|玩机器授权|主播授权)(?:过我|了我|给我|我)?|(?:授权我|授权过我|玩机器让我|本人让我)/i.test(text)
    || /(?:我有|已经拿到|拿了)(?:官方|本人|主播|玩机器).{0,8}授权/i.test(text)
  );
}

export function enforceRealityBoundary(text: string): string {
  if (!text) return text;

  let cleaned = text
    .replace(/我是(?:现实中的|真正的|真的)?(?:玩机器|MachineWJQ|6657|主播本人|本尊)[，,。!！]?\s*/gi, '我是按玩机器直播语气做的群 bot，')
    .replace(/我(?:就是|真是)(?:玩机器|MachineWJQ|6657|主播本人|本尊)[，,。!！]?\s*/gi, '我是按玩机器直播语气做的群 bot，')
    .replace(/(?:这是|此号是|这个号是|本号是)?(?:现实)?(?:玩机器|MachineWJQ|6657|主播|主播本人|本尊)?(?:官方账号|官方号|本人账号|本尊号|主播本人账号|现实主播账号|玩机器账号)[，,。!！]?\s*/gi, '这个号只是群 bot，')
    .replace(/(?:我|这个号|本号)(?:代表|就是)(?:现实)?(?:玩机器|MachineWJQ|6657|主播本人|本尊)[，,。!！]?\s*/gi, '这个号不代表现实本人，')
    .replace(/(?:(?:官方授权|本人授权|玩机器授权|主播授权)(?:过我|了我|给我|我)?|授权我|授权过我|玩机器让我|本人让我|我有(?:官方|本人|主播|玩机器).{0,8}授权)[，,。!！]?\s*/gi, '授权这事别乱说，')
    .replace(/(?:我不是bot|我不是机器人|不是AI|不是机器人)[，,。!！]?\s*/gi, '我是群 bot，');

  const dangerous = hasRealityBoundaryClaim(cleaned) || /(?:代表本人|代表现实本人)/i.test(cleaned);
  if (dangerous && !/不代表现实本人|风格bot|群 bot|群bot|不是本人/.test(cleaned)) {
    cleaned = `我只是风格bot 不代表现实本人，${cleaned}`;
  }
  return cleaned;
}

function isEvidenceMetadataLine(line: string): boolean {
  const cleaned = line.trim();
  if (!cleaned) return false;
  if (/^(?:缓存|cache)\s*[:：]/i.test(cleaned) && /(?:fresh|stale|miss|age=|ttl=|expired=|source=|fetch=|hit=)/i.test(cleaned)) {
    return true;
  }
  if (/^(?:来源|source)\s*[:：]/i.test(cleaned) && /(?:CS API|HLTV|Liquipedia|webSearch|拉取|链接|快照|source=|ttl=|age=)/i.test(cleaned)) {
    return true;
  }
  if (/^\[\/?(?:实时事实参考|HLTV实时数据|联网补充)\]$/i.test(cleaned)) {
    return true;
  }
  return false;
}

export function stripEvidenceMetadata(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !isEvidenceMetadataLine(line))
    .join('\n')
    .replace(/\[\/?(?:实时事实参考|HLTV实时数据|联网补充)\]/gi, '')
    .replace(/\s*缓存\s*[:：]\s*[a-z0-9:_-]+\s+(?:fresh|stale|miss)\b[^\n。！？!?]*/gi, '')
    .replace(/\s*(?:age|ttl|expired|fetch|hit|source)=\S+/gi, '')
    .trim();
}

/** 完整后处理 — AI 输出 → 清理后的最终文本 */
export function postProcessReply(text: string): string {
  text = text.trim();
  text = text.replace(
    /^[(（【\[]\s*(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|6657(?:风格|口吻)?|Machine(?:风格|口吻)?|拟态|风格参考|接弹幕|真人感|群聊回复|QQ?群回复|bot回复|机器人回复|第一人称(?:拟态)?|口吻)\s*[)）】\]]\s*[：:，,、-]?\s*/i,
    '',
  );
  text = text.replace(
    /(^|\n)\s*[(（【\[]\s*(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|6657(?:风格|口吻)?|Machine(?:风格|口吻)?|拟态|风格参考|接弹幕|真人感|群聊回复|QQ?群回复|bot回复|机器人回复|第一人称(?:拟态)?|口吻)\s*[)）】\]]\s*[：:，,、-]?\s*/gi,
    '$1',
  );
  text = text.replace(
    /^(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|拟态|风格参考|接弹幕|群聊回复|QQ?群回复)\s*[：:，,、-]\s*/i,
    '',
  );
  for (let i = 0; i < 3; i++) {
    text = text.replace(/^(?:结论|原因|建议|分析|总结|答案|短评|评价|判断|我的判断|先说结论)\s*[：:]\s*/i, '');
    text = text.replace(
      /^(?:根据|结合|参考)(?:上面|前面|知识库|素材|提示|资料|临场素材包|临场笔记|语态素材|话题素材|实时事实参考|实时参考)[^，。！？!?:：]{0,48}[，。:：]\s*/i,
      '',
    );
    text = text.replace(/^(?:我会|我将|下面|接下来)[^，。！？!?:：]{0,48}(?:回复|回答|接话|模仿)[：:，,。]\s*/i, '');
    text = text.replace(/^(?:我将用|以下以|下面用|作为(?:群)?bot)[^\n，。！？!?:：]{0,28}(?:回复|回答|接话)[：:，,。]?\s*/i, '');
    text = text.replace(/^(?:作为(?:一个)?(?:AI|机器人|bot|群bot|QQ群bot|助手))[^\n，。！？!?:：]{0,42}[：:，,。]?\s*/i, '');
    // 书面语开场词
    text = text.replace(/^(?:对此|总的来说|总而言之|首先|其次|再者|此外|另外|不过|然而|因此|所以)[，,]?\s*/i, '');
    text = text.replace(/^我个人(?:觉得|认为|以为)[，,]?\s*/i, '');
  }
  text = text.replace(/(?:根据|结合|参考)(?:知识库|素材|临场素材包|临场笔记|语态素材|话题素材|实时事实参考|实时参考)[，, ]*/g, '');
  text = text.replace(/(?:知识库|临场素材包|临场笔记|语态素材|话题素材|实时事实参考|实时参考)(?:里)?(?:显示|提到|说|给到)[，, ]*/g, '');
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim());
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/#{1,6}\s/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^(玩机器|机器|MachineWJQ)[：:]\s*/i, '');
  text = text.replace(/^["「『](.+)["」』]$/s, '$1');
  text = text.replace(/^[（(]\s*(.+?)\s*[）)]$/s, '$1');
  text = stripEvidenceMetadata(text);
  text = deFormulaicOpening(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^ +/gm, '');

  if (/^[\d\s.,，。!！?？]+$/.test(text)) {
    text = '我看到了 这句信息太少';
  } else if (/^[哈啊嗯哦额呃草艹wW6]+$/.test(text) && text.length <= 6) {
    text = '有点抽象 先看你想说啥';
  }

  if (text.length > 350) {
    text = naturalLengthTrim(text, 350);
  }

  // 去除重复 — 模型有时会把一句话说两遍
  text = removeDuplicates(text);

  // 修复标点 — 中英文标点混乱
  text = fixPunctuation(text);

  // 限制emoji数量 — 真人不会一句话堆10个emoji
  text = limitEmoji(text);

  // 把常见 emoji 转成 QQ 经典表情标签 (😂→[face:178] 等)
  // 让回复在 QQ 端显示原生黄脸表情，更有 QQ 风
  text = emojiToFaceMarkers(text);
  text = enforceOriginalQuoteBoundary(text);
  text = enforceRealityBoundary(text);

  return sanitizeOutgoingText(text).trim();
}

/** 去除内部重复段落（同一句话连续出现） */
function removeDuplicates(text: string): string {
  // 切分成句
  const parts = text.split(/([。！？!?\n]+)/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const punct = parts[i + 1] || '';
    if (!sentence.trim()) {
      result.push(sentence + punct);
      continue;
    }
    const normalized = sentence.trim().toLowerCase();
    // 太短的不算重复（"在""嗯""草"这种）
    if (normalized.length < 4) {
      result.push(sentence + punct);
      continue;
    }
    if (seen.has(normalized)) continue; // 跳过重复句
    seen.add(normalized);
    result.push(sentence + punct);
  }
  return result.join('');
}

/** 修复标点问题 */
function fixPunctuation(text: string): string {
  return text
    // 多个标点合并
    .replace(/[。.]{2,}/g, '。')
    .replace(/[!！]{3,}/g, '!!')
    .replace(/[?？]{3,}/g, '??')
    // 中英文标点混用 - 中文文字后用中文标点
    .replace(/([\u4e00-\u9fa5]),([\u4e00-\u9fa5])/g, '$1，$2')
    // 多余空格
    .replace(/  +/g, ' ')
    // 句末多余的空格
    .replace(/\s+([。！？!?，,])/g, '$1');
}

/** Unicode emoji → QQ face id 映射（让 AI 输出的 emoji 自动转成 QQ 经典表情） */
const EMOJI_TO_FACE: Record<string, number> = {
  '😂': 178, '🤣': 178,
  '😄': 14, '😀': 14, '🙂': 14,
  '😆': 28, '😏': 4,
  '🙃': 100, '😬': 10, '😐': 3, '😑': 3,
  '😢': 5, '😭': 9,
  '😍': 21, '🥰': 21,
  '😎': 16,
  '😡': 11, '🤬': 11, '😠': 11,
  '🤔': 277, '😕': 32, '❓': 32, '❔': 32,
  '😴': 8,
  '😵': 34, '😵‍💫': 34,
  '🤯': 287,
  '👍': 76, '👍🏻': 76, '👍🏼': 76, '👍🏽': 76,
  '👎': 77,
  '👌': 124,
  '🙏': 67, '🤝': 65,
  '✌': 66, '✌️': 66,
  '🌹': 79,
  '☀': 81, '☀️': 81,
  '🌙': 82,
  '💀': 37,
  '🎂': 53,
  '☕': 60, '☕️': 60,
  '💩': 59,
  '😋': 13, '😛': 13,
  '😉': 0,
  '😱': 26,
  '😅': 27,
  '🥲': 105,
  '😘': 108,
  '🤐': 7,
  '🤡': 22,
  '🤤': 2,
  '🥺': 110,
  '🤓': 100,
  '🫡': 67,
  '😶': 7,
  '😮': 109, '😯': 109,
  '😤': 30,
  '🤦': 286, '🤦‍♂️': 286, '🤦‍♀️': 286,
  '🍋': 306,
  '👀': 296,
  '🔥': 54,
  '💰': 87,
  '🧠': 277,
};

/**
 * 把 AI 输出里的 unicode emoji 替换为 [face:N] 标签，让 QQ 显示原生经典表情
 * 仅替换有映射的，未映射的 emoji 原样保留（让 limitEmoji 控制数量）
 */
export function emojiToFaceMarkers(text: string): string {
  if (!text) return text;
  let count = 0;
  const max = 2;
  return text.replace(
    /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F600}-\u{1F64F}]/gu,
    (m) => {
      const id = EMOJI_TO_FACE[m];
      if (id !== undefined && count < max) {
        count++;
        return `[face:${id}]`;
      }
      return m;
    },
  );
}

/** 限制emoji出现次数 - 真人不会堆emoji，玩机器尤其少 */
function limitEmoji(text: string): string {
  // 匹配大多数 emoji 范围
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F600}-\u{1F64F}]/gu;
  const matches = text.match(emojiRegex);
  if (!matches || matches.length <= 2) return text;
  // 超过2个 emoji 就只保留前2个
  let count = 0;
  return text.replace(emojiRegex, (m) => {
    count++;
    return count <= 2 ? m : '';
  });
}

/**
 * 把 AI 输出里的 [face:N] / [表情:N] / [emoji:N] 转成 QQ face segment
 * 返回 null 表示没有需要转换的，使用纯字符串发送即可
 */
export function parseFaceMarkers(text: string): import('../types').MessageSegment[] | null {
  if (!text) return null;
  // 检测是否含 [face:N]
  const faceRegex = /\[(?:face|表情|emoji|qq)[:：](\d{1,4})\]/gi;
  if (!faceRegex.test(text)) return null;
  faceRegex.lastIndex = 0;

  const segments: import('../types').MessageSegment[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let faceCount = 0;
  // 限制最多 2 个 face 防止刷屏
  const maxFaces = 2;

  while ((m = faceRegex.exec(text))) {
    if (m.index > lastIdx) {
      const chunk = text.slice(lastIdx, m.index);
      if (chunk) segments.push({ type: 'text', data: { text: chunk } });
    }
    if (faceCount < maxFaces) {
      const faceId = parseInt(m[1], 10);
      // QQ 经典 face id 一般在 0-358 范围，超过的视为无效
      if (!isNaN(faceId) && faceId >= 0 && faceId <= 600) {
        segments.push({ type: 'face', data: { id: String(faceId) } });
        faceCount++;
      }
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx);
    if (tail) segments.push({ type: 'text', data: { text: tail } });
  }

  // 合并相邻 text，去除空 text
  const merged: import('../types').MessageSegment[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      if (!seg.data.text) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.type === 'text') {
        prev.data.text += seg.data.text;
        continue;
      }
    }
    merged.push(seg);
  }
  return merged.length > 0 ? merged : null;
}

/** TTS 语音文本截断 — 控制在maxChars内，找完整句末截断 */
export function clampVoiceText(text: string, maxChars: number): string {
  const cleaned = sanitizeOutgoingText(text)
    .replace(/\[(?:face|表情|emoji|qq)[:：]\d+\]/gi, '') // 去掉 face 标记，TTS 不发音
    .replace(/\[sticker[:：]\s*[\w.-]+\]/gi, '') // 贴纸 不发音
    .replace(/\[(?:[\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]/g, '') // 命名表情 不发音
    .replace(/\s+/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const firstSentence = cleaned.split(/[。！？!?；;\n]/).map((item) => item.trim()).find(Boolean) || cleaned;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, Math.max(10, maxChars - 1)).trim();
}

export function previewText(text: string, maxChars: number = 90): string {
  const cleaned = sanitizeOutgoingText(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function formatTime(timestamp: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '从未';
}
