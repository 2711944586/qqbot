import { Plugin } from '../types';
import {
  checkCsDataHealth,
  clearHltvCache,
  fetchOngoingMatches,
  fetchMatchDetail,
  fetchPlayerProfile,
  fetchRecentResults,
  fetchTeamProfile,
  fetchTeamRanking,
  buildCsDataEvidenceReport,
  buildCsDataEvidenceOverview,
  buildCsDataSourcesReport,
  buildHltvMatchLinkCheckReport,
  describeHltvCacheEntry,
  getCsProfileCacheKey,
  getCsDataSourceInfo,
  getHltvStats,
  inspectHltvCacheEntry,
  pruneStaleHltvCacheForMaintenance,
  withHltvCacheEvidence,
} from './hltv-api';
import { webSearch } from './web-search';
import { detectCsTopicQuery, detectFuzzyCommand, FuzzyCommandKey } from './fuzzy-command';
import { buildCsPrewarmPlanReport, buildCsPrewarmReport } from './cs-prewarm';
import { buildCsFactTypeCoverageLines, formatCsFactTypeCoverageBlock } from './cs-fact-coverage';

type CsNaturalRoute =
  | { sub: 'brief' | 'match' | 'results' | 'ranking'; subject: string; natural: boolean }
  | { sub: 'team' | 'player' | 'search'; subject: string; natural: boolean };

type EvidenceTarget = 'all' | 'matches' | 'results' | 'ranking' | 'match' | 'team' | 'player';

type CsIntentCacheTarget = { label: string; key: string; evidenceTarget: EvidenceTarget; subject: string };

interface CsDataFetchers {
  brief: () => Promise<string>;
  matches: () => Promise<string>;
  results: () => Promise<string>;
  matchDetail: (matchId: string) => Promise<string>;
  ranking: () => Promise<string>;
  team: (subject: string) => Promise<string>;
  player: (subject: string) => Promise<string>;
  search: (query: string) => Promise<string>;
}

function nowShanghai(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function compactBlock(title: string, value: string, maxChars: number): string {
  const cleaned = stripCacheEvidenceLines(value).replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return `【${title}】\n暂无准信`;
  return `【${title}】\n${cleaned.slice(0, maxChars)}`;
}

function stripCacheEvidenceLines(value: string): string {
  return (value || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('缓存: '))
    .join('\n')
    .trim();
}

function withCacheFootnote(value: string, cacheKey: string): string {
  return withHltvCacheEvidence(value, cacheKey);
}

const TODAY_CACHE_TARGETS = [
  { key: 'matches', label: '赛程/正在打' },
  { key: 'results', label: '最近赛果' },
  { key: 'ranking', label: '排名快照' },
] as const;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function buildBrief(): Promise<string> {
  const [matches, results, ranking] = await Promise.all([
    withTimeout(fetchOngoingMatches().catch(() => ''), 6500, ''),
    withTimeout(fetchRecentResults().catch(() => ''), 6500, ''),
    withTimeout(fetchTeamRanking().catch(() => ''), 6500, ''),
  ]);

  return [
    `CS实时短报 | ${nowShanghai()}`,
    compactBlock('当前/即将比赛', matches, 700),
    compactBlock('最近赛果', results, 650),
    compactBlock('排名快照', ranking, 520),
    [
      describeHltvCacheEntry('matches'),
      describeHltvCacheEntry('results'),
      describeHltvCacheEntry('ranking'),
    ].join('\n'),
    '机器短评：实时东西会变，先看来源时间，别拿旧数据硬打新版本。',
  ].join('\n\n');
}

function formatTodayCacheLine(target: typeof TODAY_CACHE_TARGETS[number]): string {
  const snapshot = inspectHltvCacheEntry(target.key);
  if (!snapshot) {
    return `- ${target.label} [${target.key}]: miss | 本地暂无快照，/cs brief 会请求实时源`;
  }
  const source = snapshot.source && snapshot.source !== '-' ? ` source=${snapshot.source}` : '';
  if (snapshot.status === 'fresh') {
    return `- ${target.label} [${target.key}]: fresh | ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s hit=${snapshot.hits}${source}`;
  }
  return `- ${target.label} [${target.key}]: stale | expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s；只能当旧快照线索，不能当实时结论${source}`;
}

function evidenceTargetForTodayKey(key: typeof TODAY_CACHE_TARGETS[number]['key']): EvidenceTarget {
  if (key === 'results') return 'results';
  if (key === 'ranking') return 'ranking';
  return 'matches';
}

function formatTodayPrewarmAdvice(rows: Array<{ target: typeof TODAY_CACHE_TARGETS[number]; snapshot: ReturnType<typeof inspectHltvCacheEntry> }>): string {
  const needs = rows.filter((row) => !row.snapshot || row.snapshot.status === 'stale');
  if (needs.length === 0) return '建议: 直接 /cs brief；要查来源细节用 /cs evidence all。';
  const labels = needs.map((row) => row.target.label).join(' / ');
  const planCommands = needs
    .map((row) => warmPlanCommandForEvidenceTarget(evidenceTargetForTodayKey(row.target.key), ''))
    .join('；');
  const warmCommands = needs
    .map((row) => warmCommandForEvidenceTarget(evidenceTargetForTodayKey(row.target.key), ''))
    .join('；');
  const batchHint = needs.length > 1 ? '；多个目标也可 /cs warm plan all 后 /cs warm all' : '';
  return `建议: 需刷新 ${labels}；管理员先 ${planCommands}，再 ${warmCommands}${batchHint}；也可以直接 /cs brief 等实时源。`;
}

function buildCsTodayCheckReport(): string {
  const rows = TODAY_CACHE_TARGETS.map((target) => {
    const snapshot = inspectHltvCacheEntry(target.key);
    return { target, snapshot };
  });
  const fresh = rows.filter((row) => row.snapshot?.status === 'fresh').length;
  const stale = rows.filter((row) => row.snapshot?.status === 'stale').length;
  const miss = rows.filter((row) => !row.snapshot).length;
  const requestCount = stale + miss;
  const source = getCsDataSourceInfo();

  return [
    `CS今日数据预检 | ${nowShanghai()}`,
    `主源: ${source.primaryBaseUrl}`,
    '',
    '数据新鲜度:',
    ...TODAY_CACHE_TARGETS.map(formatTodayCacheLine),
    '',
    requestCount === 0
      ? `判断: 核心缓存 fresh ${fresh}/${TODAY_CACHE_TARGETS.length}，可直接 /cs brief，基本走本地缓存。`
      : `判断: 核心缓存 fresh ${fresh}/${TODAY_CACHE_TARGETS.length}，stale ${stale}，miss ${miss}；/cs brief 预计会请求 ${requestCount} 项实时源。`,
    formatTodayPrewarmAdvice(rows),
    '边界: 这是只读预检，不请求外站；stale 是旧快照，miss 是本地无证据，都不能当“没有比赛/没有赛果”的实时结论。',
  ].join('\n');
}

function formatStats(): string {
  const stats = getHltvStats();
  const source = getCsDataSourceInfo();
  const hitTotal = stats.hits + stats.misses;
  const hitRate = hitTotal > 0 ? `${Math.round((stats.hits / hitTotal) * 100)}%` : '-';
  const lines = [
    'CS实时数据状态',
    `主源: ${source.primaryBaseUrl}`,
    `说明: ${source.note}`,
    `缓存: fresh ${stats.entries}条 / stale ${stats.staleEntries}条 命中${stats.hits}/${stats.misses}(${hitRate}) 磁盘命中${stats.diskHits} 加载${stats.diskEntriesLoaded} 写入${stats.writes} 过期${stats.expired} 旧缓存兜底${stats.staleServed}`,
    `飞行请求: ${stats.inFlight} 合并命中${stats.inFlightHits} 失败${stats.failures}`,
    `磁盘缓存: 加载${stats.lastDiskLoadAt ? new Date(stats.lastDiskLoadAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 写入${stats.lastDiskFlushAt ? new Date(stats.lastDiskFlushAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 裁剪${stats.prunes}${stats.lastDiskError ? ` 错误=${stats.lastDiskError}` : ''}`,
    `HLTV候选核验缓存: ${stats.linkChecks.length}条${stats.linkChecks[0] ? ` 最近matchid=${stats.linkChecks[0].matchId} ${stats.linkChecks[0].status} ttl=${stats.linkChecks[0].ttlSeconds}s` : ''}`,
    `最近刷新: ${stats.lastRefreshAt ? new Date(stats.lastRefreshAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'}`,
    ...(stats.lastError ? [`最近错误: ${stats.lastError}`] : []),
  ];

  lines.push('');
  lines.push(...buildCsFactTypeCoverageLines());

  if (stats.items.length > 0) {
    lines.push('');
    lines.push('缓存明细:');
    for (const item of stats.items.slice(0, 8)) {
      const freshness = item.status === 'stale' ? `expired=${item.expiredSeconds}s` : `ttl=${item.ttlSeconds}s`;
      lines.push(`- ${item.key} ${item.status}${item.disk ? ' disk' : ''} ${item.source} ${freshness} age=${item.ageSeconds}s hit=${item.hits} fetch=${item.fetchMs}ms`);
    }
  }

  if (stats.linkChecks.length > 0) {
    lines.push('');
    lines.push('HLTV候选页核验缓存:');
    for (const item of stats.linkChecks.slice(0, 5)) {
      const finalUrl = item.finalUrl ? ` final=${item.finalUrl}` : '';
      lines.push(`- matchid=${item.matchId} ${item.status} http=${item.httpStatus || '无响应'} ttl=${item.ttlSeconds}s age=${item.ageSeconds}s${finalUrl}`);
    }
    lines.push('边界: 这是 /cs hltvcheck 的短 TTL 活链接核验缓存，不等于比分、阵容或地图池事实证据。');
  }
  return lines.join('\n');
}

function formatCsStalePruneReport(): string {
  const result = pruneStaleHltvCacheForMaintenance();
  const removedKeys = result.removedKeys.length > 0
    ? result.removedKeys.join(' / ')
    : '无';
  return [
    'CS实时缓存 stale 清理',
    '模式: 只清理已过期的 CS 事实缓存；保留 fresh 当前快照、飞行请求和 HLTV候选页核验缓存。',
    `条目: before fresh ${result.beforeFresh} / stale ${result.beforeStale} -> after fresh ${result.afterFresh} / stale ${result.afterStale}；removed ${result.removed}`,
    `删除: ${removedKeys}${result.removed > result.removedKeys.length ? ` / ...还有${result.removed - result.removedKeys.length}个` : ''}`,
    `保留: 飞行请求 ${result.inFlight}；HLTV候选核验缓存 ${result.linkChecks}。`,
    result.diskError ? `磁盘写入: WARN ${result.diskError}` : '磁盘写入: OK',
    result.removed > 0
      ? '结果: 旧快照已移除；之后 /cs verify 会显示 miss，不能再把这些旧线索包装成实时结论。'
      : '结果: 没有 stale CS 事实缓存需要清理。',
    '下一步: /cs verify all；需要当前证据时管理员 /cs warm plan all -> /cs warm all；单项可用 /cs warm plan results/matches/ranking。',
    '边界: prune 不请求外站、不生成 fresh 证据；miss 也不能反推没有比赛、赛果或变动。',
  ].join('\n');
}

function normalizeSubject(args: string[]): string {
  return args.join(' ').trim();
}

function parseEvidenceArgs(args: string[]): { target: EvidenceTarget; subject: string } {
  const first = (args[0] || 'matches').toLowerCase();
  const subject = args.slice(1).join(' ').trim();
  if (['all', 'overview', 'status', '总览', '全部', '缓存'].includes(first)) return { target: 'all', subject };
  const firstMatchId = extractMatchIdFromSubject(args[0] || '');
  if (firstMatchId) return { target: 'match', subject: firstMatchId };
  if (['matchid', '单场', '详情'].includes(first)) return { target: 'match', subject: extractMatchIdFromSubject(subject) || subject };
  if (first === 'match' && extractMatchIdFromSubject(subject)) return { target: 'match', subject: extractMatchIdFromSubject(subject) };
  if (['match', 'matches', 'live', '赛程', '比赛'].includes(first)) return { target: 'matches', subject };
  if (['result', 'results', 'news', '赛果', '战报'].includes(first)) return { target: 'results', subject };
  if (['ranking', 'rank', 'top', '排名'].includes(first)) return { target: 'ranking', subject };
  if (['team', '队伍', '战队'].includes(first)) return { target: 'team', subject };
  if (['player', '选手'].includes(first)) return { target: 'player', subject };
  return { target: 'matches', subject: args.join(' ').trim() };
}

function cacheKeyForEvidenceTarget(target: EvidenceTarget, subject: string): string {
  if (target === 'team' || target === 'player') return getCsProfileCacheKey(target, subject || target);
  if (target === 'match') return `match:${subject || 'unknown'}`;
  if (target === 'results') return 'results';
  if (target === 'ranking') return 'ranking';
  return 'matches';
}

function evidenceTargetLabel(target: EvidenceTarget, subject: string): string {
  if (target === 'all') return '今日短报核心数据';
  if (target === 'matches') return '当前/即将比赛';
  if (target === 'results') return '最近赛果';
  if (target === 'ranking') return '战队排名';
  if (target === 'match') return `单场详情${subject ? ` ${subject}` : ''}`;
  if (target === 'team') return `队伍资料${subject ? ` ${subject}` : ''}`;
  return `选手统计${subject ? ` ${subject}` : ''}`;
}

function commandArgsForEvidenceTarget(target: EvidenceTarget, subject: string): string {
  if (target === 'matches') return 'matches';
  if (target === 'match') return `match ${subject}`.trim();
  if (target === 'results') return 'results';
  if (target === 'ranking') return 'ranking';
  if (target === 'team') return `team ${subject}`.trim();
  if (target === 'player') return `player ${subject}`.trim();
  return '';
}

function queryCommandForEvidenceTarget(target: EvidenceTarget, subject: string): string {
  if (target === 'matches') return '/cs match';
  if (target === 'match') return `/cs match ${subject}`.trim();
  if (target === 'results') return '/cs results';
  if (target === 'ranking') return '/cs ranking';
  if (target === 'team') return `/cs team ${subject}`.trim();
  if (target === 'player') return `/cs player ${subject}`.trim();
  return '/cs brief';
}

function warmPlanCommandForEvidenceTarget(target: EvidenceTarget, subject: string): string {
  const args = commandArgsForEvidenceTarget(target, subject);
  return args ? `/cs warm plan ${args}` : '/cs warm plan';
}

function warmCommandForEvidenceTarget(target: EvidenceTarget, subject: string): string {
  const args = commandArgsForEvidenceTarget(target, subject);
  return args ? `/cs warm ${args}` : '/cs warm';
}

function evidenceCommandForTarget(target: EvidenceTarget, subject: string): string {
  if (target === 'matches') return '/cs evidence matches';
  const args = commandArgsForEvidenceTarget(target, subject);
  return args ? `/cs evidence ${args}` : '/cs evidence all';
}

const CORE_FACT_VERIFY_TARGETS: Array<{ target: EvidenceTarget; subject: string }> = [
  { target: 'matches', subject: '' },
  { target: 'results', subject: '' },
  { target: 'ranking', subject: '' },
];

function formatFactVerifyForKey(target: EvidenceTarget, subject: string): string {
  const key = cacheKeyForEvidenceTarget(target, subject);
  const snapshot = inspectHltvCacheEntry(key);
  const label = evidenceTargetLabel(target, subject);
  const source = getCsDataSourceInfo();

  if (!snapshot) {
    return [
      'CS事实回复预检',
      `目标: ${label}`,
      `缓存键: ${key}`,
      `主源: ${source.primaryBaseUrl}`,
      '新鲜度: miss，本地没有成功快照。',
      '回复动作: 不能把 miss 说成“没有比赛/没有赛果/没有变动”；只能说“本地还没证据，得查实时源”。',
      `拿证据: 管理员先 ${warmPlanCommandForEvidenceTarget(target, subject)}，确认会 REFRESH 后再 ${warmCommandForEvidenceTarget(target, subject)}；最后 ${queryCommandForEvidenceTarget(target, subject)}。`,
      '禁句: 别说“我刚查了HLTV/现在就是/实时显示”，除非随后有 fresh 证据。',
      '边界: 这是只读预检，不请求外站、不写缓存。',
    ].join('\n');
  }

  if (snapshot.status === 'fresh') {
    return [
      'CS事实回复预检',
      `目标: ${label}`,
      `缓存键: ${key}`,
      `主源: ${source.primaryBaseUrl}`,
      `新鲜度: fresh，ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`,
      '回复动作: 可以作为当前快照依据，但只说缓存里明确出现的事实；排名/赛果/阵容仍要带来源时间或链接。',
      `证据卡: ${evidenceCommandForTarget(target, subject)}`,
      '禁句: 不要把缓存元数据直接发给群友；把 fresh 转成自然来源边界。',
      '边界: 这是只读预检，不请求外站、不写缓存。',
    ].join('\n');
  }

  return [
    'CS事实回复预检',
    `目标: ${label}`,
    `缓存键: ${key}`,
    `主源: ${source.primaryBaseUrl}`,
    `新鲜度: stale，expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s source=${snapshot.source}`,
    '回复动作: 只能说旧快照/线索，不能报成现在、最新、刚查到；需要当前事实就先刷新。',
    `刷新建议: 管理员 ${warmPlanCommandForEvidenceTarget(target, subject)}，确认会 REFRESH 后再 ${warmCommandForEvidenceTarget(target, subject)}；刷新后 ${queryCommandForEvidenceTarget(target, subject)}。`,
    '禁句: “现在排名/正在打/刚结束/HLTV显示”这类当前断言都要收住。',
    '边界: 这是只读预检，不请求外站、不写缓存。',
  ].join('\n');
}

function formatCoreFactVerifySummary(): string {
  const rows = CORE_FACT_VERIFY_TARGETS.map((item) => {
    const key = cacheKeyForEvidenceTarget(item.target, item.subject);
    return {
      ...item,
      key,
      label: evidenceTargetLabel(item.target, item.subject),
      snapshot: inspectHltvCacheEntry(key),
    };
  });
  const fresh = rows.filter((row) => row.snapshot?.status === 'fresh').length;
  const stale = rows.filter((row) => row.snapshot?.status === 'stale').length;
  const miss = rows.filter((row) => !row.snapshot).length;
  const notFresh = rows.filter((row) => row.snapshot?.status !== 'fresh');
  const verdict = fresh === rows.length
    ? '可发当前核心快照'
    : fresh > 0
      ? '只能发部分当前快照'
      : '不能发当前核心结论';
  const action = fresh === rows.length
    ? '三项核心证据都是 fresh，可以组织今日短报；仍只说证据文本里明确出现的事实，并带来源时间/链接。'
    : fresh > 0
      ? '只把 fresh 项说成当前快照；stale 项标成旧线索，miss 项标成本地无证据，别合成完整“今日最新”。'
      : '先补证据再回复当前事实；现在最多说“本地没有当前快照/需要查实时源”。';
  const refresh = notFresh.length === 0
    ? '补证路线: /cs evidence all 查看证据卡；要更新就管理员 /cs warm plan all。'
    : `补证路线: 管理员 /cs warm plan all -> /cs warm all；缺口 ${notFresh.map((row) => `${row.label}[${row.key}]`).join(' / ')}。`;

  return [
    '总判定:',
    `- 覆盖: fresh ${fresh} / stale ${stale} / miss ${miss}`,
    `- 结论: ${verdict}`,
    `- 回复动作: ${action}`,
    `- ${refresh}`,
    '- 禁句: 只要核心里还有 stale/miss，就别说“我刚查了HLTV/全部实时/今天就是这样”。',
  ].join('\n');
}

function buildCsFactVerifyReport(args: string[]): string {
  const parsed = parseEvidenceArgs(args.length > 0 ? args : ['matches']);
  if (parsed.target === 'all') {
    return [
      'CS事实回复预检 | 核心数据',
      formatCoreFactVerifySummary(),
      '',
      formatCsFactTypeCoverageBlock(),
      '',
      formatFactVerifyForKey('matches', ''),
      '',
      formatFactVerifyForKey('results', ''),
      '',
      formatFactVerifyForKey('ranking', ''),
    ].join('\n');
  }
  return formatFactVerifyForKey(parsed.target, parsed.subject);
}

function cacheTargetsForCsRoute(route: CsNaturalRoute): CsIntentCacheTarget[] {
  if (route.sub === 'brief') {
    return [
      { label: '赛程/正在打', key: 'matches', evidenceTarget: 'matches', subject: '' },
      { label: '最近赛果', key: 'results', evidenceTarget: 'results', subject: '' },
      { label: '排名快照', key: 'ranking', evidenceTarget: 'ranking', subject: '' },
    ];
  }
  if (route.sub === 'match') {
    const matchId = extractMatchIdFromSubject(route.subject);
    return matchId
      ? [{ label: `单场详情 ${matchId}`, key: `match:${matchId}`, evidenceTarget: 'match', subject: matchId }]
      : [{ label: '当前/即将比赛', key: 'matches', evidenceTarget: 'matches', subject: '' }];
  }
  if (route.sub === 'results') return [{ label: '最近赛果', key: 'results', evidenceTarget: 'results', subject: '' }];
  if (route.sub === 'ranking') return [{ label: '战队排名', key: 'ranking', evidenceTarget: 'ranking', subject: '' }];
  if (route.sub === 'team') return [{ label: `队伍资料 ${route.subject}`, key: getCsProfileCacheKey('team', route.subject), evidenceTarget: 'team', subject: route.subject }];
  if (route.sub === 'player') return [{ label: `选手统计 ${route.subject}`, key: getCsProfileCacheKey('player', route.subject), evidenceTarget: 'player', subject: route.subject }];
  return [];
}

function formatIntentCacheTarget(target: CsIntentCacheTarget): string {
  const snapshot = inspectHltvCacheEntry(target.key);
  const evidenceCommand = evidenceCommandForTarget(target.evidenceTarget, target.subject);
  if (!snapshot) {
    return `- ${target.label} [${target.key}]: miss | 需要实时请求；证据卡 ${evidenceCommand}`;
  }
  const source = snapshot.source && snapshot.source !== '-' ? ` source=${snapshot.source}` : '';
  if (snapshot.status === 'fresh') {
    return `- ${target.label} [${target.key}]: fresh | ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s hit=${snapshot.hits}${source}；证据卡 ${evidenceCommand}`;
  }
  return `- ${target.label} [${target.key}]: stale | expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s${source}；只能当旧线索，先刷新；证据卡 ${evidenceCommand}`;
}

function formatIntentPrewarmAdvice(route: CsNaturalRoute, targets: CsIntentCacheTarget[], needsRefresh: boolean): string {
  if (!needsRefresh) return '预热建议: 目标缓存都是 fresh，直接问通常会很快。';
  if (targets.length === 1) {
    const target = targets[0];
    return `预热建议: 管理员先 ${warmPlanCommandForEvidenceTarget(target.evidenceTarget, target.subject)}，再按需 ${warmCommandForEvidenceTarget(target.evidenceTarget, target.subject)}。`;
  }
  if (route.sub === 'brief') {
    return '预热建议: 管理员先 /cs warm plan，再按需 /cs warm。';
  }
  return '预热建议: 多个目标有 stale/miss，管理员先 /cs warm plan all 看总请求数，再按需 /cs warm all。';
}

function commandForCsRoute(route: CsNaturalRoute): string {
  if (route.sub === 'brief') return '/cs brief';
  if (route.sub === 'match') {
    const matchId = extractMatchIdFromSubject(route.subject);
    return matchId ? `/cs match ${matchId}` : '/cs match';
  }
  if (route.sub === 'results') return '/cs results';
  if (route.sub === 'ranking') return '/cs ranking';
  if (route.sub === 'team') return `/cs team ${route.subject}`;
  if (route.sub === 'player') return `/cs player ${route.subject}`;
  return route.subject ? `/cs search ${route.subject}` : '/cs search';
}

function formatCsIntentReport(input: string): string {
  const clean = (input || '').trim();
  if (!clean) return '/cs intent <自然语言问题>\n例: /cs intent donk最近状态怎么样';

  const route = routeNaturalCsQuery(clean);
  const topic = detectCsTopicQuery(clean);
  const topicTargets = [
    topic.needsMatches ? 'matches' : '',
    topic.needsResults ? 'results' : '',
    topic.needsRanking ? 'ranking' : '',
  ].filter(Boolean);
  const lines = [
    'CS实时意图预检',
    `输入: ${clean.slice(0, 120)}`,
    '模式: 只读，不请求外站、不写缓存、不增加 CS 缓存 hit/miss。',
  ];

  if (!route) {
    lines.push(
      '路由: 不会被 CS 实时插件直接接管。',
      `AI实时注入预测: ${topicTargets.join(' / ') || '无'}`,
      topicTargets.length > 0
        ? '建议: 这类问法可能仍会给 AI 注入实时参考；要确定当前事实，先 /cs verify all 或 /cs brief check。'
        : '建议: 更像稳定战术/闲聊/玩机器语态问题，适合走普通 AI/知识库；如果想查实时数据，改成“现在排名/今天比赛/donk最近状态”。',
      '边界: 未路由不代表没有答案，只代表这条不会直接走 /cs match/results/ranking/team/player。',
    );
    return lines.join('\n');
  }

  const targets = cacheTargetsForCsRoute(route);
  const fresh = targets.filter((target) => inspectHltvCacheEntry(target.key)?.status === 'fresh').length;
  const stale = targets.filter((target) => inspectHltvCacheEntry(target.key)?.status === 'stale').length;
  const miss = targets.length - fresh - stale;
  const predictedCommand = commandForCsRoute(route);
  lines.push(
    `路由: ${route.natural ? '自然问法' : '命令'} -> ${route.sub}${route.subject ? ` (${route.subject})` : ''}`,
    `预计命令: ${predictedCommand}`,
    `缓存判断: fresh ${fresh} / stale ${stale} / miss ${miss}`,
    ...targets.map(formatIntentCacheTarget),
    formatIntentPrewarmAdvice(route, targets, stale + miss > 0),
    `AI实时注入预测: ${topicTargets.join(' / ') || '无；此问法会由 CS 插件直接回答'}`,
    '边界: fresh 可作为当前快照；stale 只能说旧线索；miss 不能反推“没有比赛/没有赛果/没有变动”。',
  );
  return lines.join('\n');
}

function formatNaturalFactAppendix(route: CsNaturalRoute | null): string {
  if (!route?.natural) return '';
  const targets = cacheTargetsForCsRoute(route);
  if (targets.length === 0) return '';
  const rows = targets.map((target) => ({
    target,
    snapshot: inspectHltvCacheEntry(target.key),
  }));
  const fresh = rows.filter((row) => row.snapshot?.status === 'fresh').length;
  const stale = rows.filter((row) => row.snapshot?.status === 'stale').length;
  const miss = rows.filter((row) => !row.snapshot).length;
  const first = rows[0]?.target;
  const verify = targets.length === 1 && first
    ? `/cs verify ${commandArgsForEvidenceTarget(first.evidenceTarget, first.subject)}`.trim()
    : '/cs verify all';
  const evidence = targets.length === 1 && first
    ? evidenceCommandForTarget(first.evidenceTarget, first.subject)
    : '/cs evidence all';
  const freshness = rows.map((row) => {
    if (!row.snapshot) return `${row.target.label}=miss`;
    if (row.snapshot.status === 'fresh') return `${row.target.label}=fresh(${row.snapshot.ageSeconds}s)`;
    return `${row.target.label}=stale(expired ${row.snapshot.expiredSeconds}s)`;
  }).join(' / ');
  const action = stale === 0 && miss === 0
    ? '可当当前快照，但只说上面资料明确出现的事实。'
    : fresh > 0
      ? '只把 fresh 项当当前快照；stale 当旧线索，miss 只代表本地无快照。'
      : '不能包装成“现在/最新/刚查HLTV”；需要当前结论先补证。';
  const refresh = rows
    .filter((row) => row.snapshot?.status !== 'fresh')
    .map((row) => `${warmPlanCommandForEvidenceTarget(row.target.evidenceTarget, row.target.subject)} -> ${warmCommandForEvidenceTarget(row.target.evidenceTarget, row.target.subject)}`)
    .filter((item, index, all) => all.indexOf(item) === index)
    .join('；');
  return [
    `事实预检: fresh ${fresh} / stale ${stale} / miss ${miss}；${freshness || '无目标'}`,
    `回复边界: ${action}`,
    `复核: ${verify}；证据: ${evidence}${refresh ? `；补证: 管理员 ${refresh}` : ''}`,
  ].join('\n');
}

function appendNaturalFactPreflight(text: string, route: CsNaturalRoute | null): string {
  const appendix = formatNaturalFactAppendix(route);
  return appendix ? `${text}\n\n${appendix}` : text;
}

function normalizeNaturalText(text: string): string {
  return (text || '')
    .replace(/\[CQ:at,qq=\d+\]/g, ' ')
    .replace(/[@＠]\S+/g, ' ')
    .replace(/[，。！？!?,.~～、:：;；"'""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNaturalIntentWords(text: string): string {
  return normalizeNaturalText(text)
    .replace(/^(?:查|看|看看|看下|看一下|问下|问一下|帮我|给我|来个|说说|聊聊|锐评|评价)\s*/i, '')
    .replace(/(?:最新|现在|当前|目前|今天|今日|最近|近期|状态|表现|怎么样|怎样|如何|数据|stats?|hltv|vrs|cs2?|csgo|排名|排行|阵容|转会|战绩|信息|资料|一下|一下子)/gi, ' ')
    .replace(/(?:队伍|战队|选手|职业哥|哥们|这个队|这个选手)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeKnownPlayer(subject: string): boolean {
  return /\b(?:zywoo|donk|niko|m0nesy|monesy|s1mple|ropz|sh1ro|magixx|jl|b1t|hunter|aleksib|karrigan|device|broky|frozen|apex|mezii|flamez|jimpphat|siuhy|kscerato|yuurih|cadian)\b/i.test(subject);
}

function looksLikeKnownTeam(subject: string): boolean {
  return /\b(?:navi|natus\s+vincere|vitality|team\s+vitality|spirit|team\s+spirit|faze|faze\s+clan|mouz|g2|falcons|astralis|liquid|team\s+liquid|furia|heroic|mongolz|tyloo|lynn|cloud9|complexity|virtus\.?pro|ence|fnatic|3dmax|pain|aurora)\b/i.test(subject);
}

function extractMatchIdFromNatural(rawText: string): string {
  const text = rawText || '';
  const hasMatchDetailIntent = /(?:match\s*id|matchid|比赛id|赛果id|这场|那场|单场|详情|统计|数据|rating|adr|kast|谁c|谁C|谁杀|谁猛|谁发挥|地图比分|几比几|比分|赛后|战报|复盘|锐评)/i.test(text);
  if (!hasMatchDetailIntent) return '';
  const explicit = text.match(/(?:match\s*id|matchid|比赛id|赛果id)\s*[=：:\s#-]*(\d{4,})/i);
  if (explicit?.[1]) return explicit[1];
  const loose = text.match(/(?:^|[^\d])(\d{6,})(?:[^\d]|$)/);
  return loose?.[1] || '';
}

function extractMatchIdFromSubject(subject: string): string {
  const text = (subject || '').trim();
  if (/^\d{4,}$/.test(text)) return text;
  const explicit = text.match(/(?:match\s*id|matchid|比赛id|赛果id)?\s*[=：:\s#-]*(\d{4,})/i);
  return explicit?.[1] || '';
}

function extractSubjectFromNatural(rawText: string): string {
  const text = normalizeNaturalText(rawText);
  const explicit = text.match(/(?:查|看|看看|看下|看一下|问下|问一下|说说|聊聊|锐评|评价)?\s*(?:队伍|战队|team|选手|player|职业哥)?\s*([A-Za-z0-9_.-]{2,}(?:\s+[A-Za-z0-9_.-]{2,}){0,2})\s*(?:最新|现在|当前|目前|今天|今日|最近|近期|状态|表现|怎么样|怎样|如何|数据|stats?|排名|排行|阵容|战绩)?/i);
  if (explicit?.[1]) return explicit[1].trim();
  return stripNaturalIntentWords(text);
}

function routeNaturalCsQuery(rawText: string): CsNaturalRoute | null {
  const text = normalizeNaturalText(rawText);
  if (!text || text.length > 120) return null;
  const matchId = extractMatchIdFromNatural(rawText);
  if (matchId) return { sub: 'match', subject: matchId, natural: true };

  const fuzzy = detectFuzzyCommand(text);
  const subject = extractSubjectFromNatural(text);

  if (fuzzy === 'csbrief') return { sub: 'brief', subject: '', natural: true };
  if (fuzzy === 'match') return { sub: 'match', subject: '', natural: true };
  if (fuzzy === 'ranking') return { sub: 'ranking', subject: '', natural: true };
  if (fuzzy === 'cs2news') return { sub: 'results', subject: '', natural: true };

  if (/^(?:cs|cs2|hltv)?\s*(?:短报|日报|看点|总结)$/i.test(text)) {
    return { sub: 'brief', subject: '', natural: true };
  }

  const realtimeIntent = /(?:最新|现在|当前|目前|今天|今日|最近|近期|状态|表现|怎么样|怎样|如何|数据|stats?|排名|排行|阵容|转会|战绩)/i.test(text);
  const explicitMatchIntent = /(?:比赛|赛事|赛程|战况|打谁|哪场|哪两个队|正在打|现在打|今天打|今晚打|明天打|什么时候打|直播在打)/.test(text);
  const explicitResultsIntent = /(?:战报|赛果|结果|比分|谁赢|赢了|输了|冠军)/.test(text);
  const explicitRankingIntent = /(?:排名|排行|排行榜|top\d*|世界第一|谁第一|谁最强|最强队伍|最强战队|vrs|hltv榜)/i.test(text);
  const profileIntent = /(?:状态|表现|怎么样|怎样|如何|数据|stats?|rating|adr|kast|阵容|roster|转会|战绩)/i.test(text);
  if (realtimeIntent && subject && profileIntent && !explicitMatchIntent && !explicitResultsIntent && !explicitRankingIntent) {
    if (/(?:选手|player|职业哥|哥们|rating|adr|kast)/i.test(text) || looksLikeKnownPlayer(subject)) {
      return { sub: 'player', subject, natural: true };
    }
    if (/(?:队伍|战队|team|阵容|roster|转会|战绩)/i.test(text) || looksLikeKnownTeam(subject)) {
      return { sub: 'team', subject, natural: true };
    }
  }

  const topic = detectCsTopicQuery(text);
  if (topic.needsRanking) return { sub: 'ranking', subject: '', natural: true };
  if (topic.needsResults) return { sub: 'results', subject: '', natural: true };
  if (topic.needsMatches) return { sub: 'match', subject: '', natural: true };
  return null;
}

async function searchCsNews(query: string): Promise<string> {
  const q = query || 'CS2 latest roster ranking match news 2026';
  const result = await webSearch(q, 4500, 300, 60);
  if (!result) return '';
  return result.slice(0, 900);
}

let dataFetchers: CsDataFetchers = {
  brief: buildBrief,
  matches: fetchOngoingMatches,
  results: fetchRecentResults,
  matchDetail: fetchMatchDetail,
  ranking: fetchTeamRanking,
  team: fetchTeamProfile,
  player: fetchPlayerProfile,
  search: searchCsNews,
};

export const csPlugin: Plugin = {
  name: 'cs',
  description: 'CS2/HLTV实时数据聚合入口',
  handler: async (ctx) => {
    const naturalRoute = ctx.command ? null : routeNaturalCsQuery(ctx.rawText);
    if (ctx.command !== 'cs' && ctx.command !== 'cs2' && ctx.command !== 'hltv' && !naturalRoute) return false;

    const config = ctx.bot.getConfig();
    const sub = naturalRoute?.sub || (ctx.args[0] || 'brief').toLowerCase();
    const rest = naturalRoute ? [] : ctx.args.slice(1);
    const subject = naturalRoute?.subject || normalizeSubject(rest);
    const naturalPrefix = naturalRoute ? 'CS实时问答' : '';

    try {
      const wantsTodayCheck = ['check', 'dry-run', 'plan', '预检', '检查'].includes((rest[0] || '').toLowerCase());
      if ((sub === 'brief' || sub === 'today' || sub === '日报' || sub === '短报') && wantsTodayCheck) {
        ctx.reply(buildCsTodayCheckReport());
        return true;
      }

      if (sub === 'intent' || sub === 'route' || sub === 'why' || sub === '问法' || sub === '路由') {
        ctx.reply(formatCsIntentReport(subject));
        return true;
      }

      if (sub === 'brief' || sub === 'today' || sub === '日报' || sub === '短报') {
        ctx.reply(appendNaturalFactPreflight(await dataFetchers.brief(), naturalRoute));
        return true;
      }

      if (sub === 'match' || sub === 'matches' || sub === 'live' || sub === '赛程' || sub === '比赛') {
        const matchId = extractMatchIdFromSubject(subject);
        if (matchId) {
          const value = await dataFetchers.matchDetail(matchId);
          const text = value ? `${naturalPrefix ? `${naturalPrefix} | ` : ''}CS单场详情:\n${withCacheFootnote(value, `match:${matchId}`)}` : `没拉到 match ${matchId} 的单场详情。可以先 /cs results 看最近赛果里的 matchid。`;
          ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
          return true;
        }
        const value = await dataFetchers.matches();
        const text = value ? `${naturalPrefix ? `${naturalPrefix} | ` : ''}当前/即将比赛:\n${withCacheFootnote(value, 'matches')}` : '没拉到比赛数据，先跑 /cs status 看数据源。';
        ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
        return true;
      }

      if (sub === 'results' || sub === 'result' || sub === 'news' || sub === '战报' || sub === '赛果') {
        const value = await dataFetchers.results();
        if (value) ctx.reply(appendNaturalFactPreflight(`${naturalPrefix ? `${naturalPrefix} | ` : ''}最近赛果:\n${withCacheFootnote(value, 'results')}`, naturalRoute));
        else {
          const searched = await dataFetchers.search(subject || 'CS2 recent match results HLTV');
          const text = searched ? `CS近况:\n${searched}` : '没搜到新赛果，可能是网络或外站限流。';
          ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
        }
        return true;
      }

      if (sub === 'ranking' || sub === 'rank' || sub === 'top' || sub === '排名') {
        const value = await dataFetchers.ranking();
        const text = value ? `${naturalPrefix ? `${naturalPrefix} | ` : ''}CS2战队排名:\n${withCacheFootnote(value, 'ranking')}` : '排名没拉到，先跑 /cs status 看数据源。';
        ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
        return true;
      }

      if (sub === 'team' || sub === '队伍' || sub === '战队') {
        if (!subject) {
          ctx.reply('用法: /cs team Vitality\n也可以 /cs team NAVI 最新阵容');
          return true;
        }
        const value = await dataFetchers.team(subject);
        const fallback = value || await dataFetchers.search(`${subject} CS2 roster ranking latest`);
        const cacheKey = getCsProfileCacheKey('team', subject);
        const text = fallback ? `${naturalPrefix ? `${naturalPrefix} | ` : ''}队伍数据:\n${value ? withCacheFootnote(fallback, cacheKey) : fallback}` : `没找到「${subject}」的可靠队伍数据。`;
        ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
        return true;
      }

      if (sub === 'player' || sub === '选手') {
        if (!subject) {
          ctx.reply('用法: /cs player donk\n也可以 /cs player ZywOo 最近状态');
          return true;
        }
        const value = await dataFetchers.player(subject);
        const fallback = value || await dataFetchers.search(`${subject} CS2 stats latest`);
        const cacheKey = getCsProfileCacheKey('player', subject);
        const text = fallback ? `${naturalPrefix ? `${naturalPrefix} | ` : ''}选手数据:\n${value ? withCacheFootnote(fallback, cacheKey) : fallback}` : `没找到「${subject}」的可靠选手数据。`;
        ctx.reply(appendNaturalFactPreflight(text, naturalRoute));
        return true;
      }

      if (sub === 'search' || sub === '搜' || sub === '搜索') {
        if (!subject) {
          ctx.reply('用法: /cs search <关键词>');
          return true;
        }
        const value = await dataFetchers.search(subject);
        ctx.reply(value ? `CS搜索:\n${value}` : '没搜到准信。');
        return true;
      }

      const cacheMaintenanceAction = sub === 'cache' || sub === '缓存'
        ? (rest[0] || '').toLowerCase()
        : sub;
      if (['prune', 'stale', 'expired', 'clean-stale', 'gc-stale', '清过期', '清stale', '清理过期'].includes(cacheMaintenanceAction)) {
        if (!config.admin_qq.includes(ctx.event.user_id)) {
          ctx.replyAt('清理 CS 实时缓存得管理员来，普通用户先用 /cs status 或 /cs verify all 看状态。');
          return true;
        }
        ctx.reply(formatCsStalePruneReport());
        return true;
      }

      if (sub === 'status' || sub === 'cache' || sub === '数据源') {
        ctx.reply(formatStats());
        return true;
      }

      if (sub === 'sources' || sub === 'source' || sub === 'links' || sub === 'link' || sub === '来源链接' || sub === '数据链接') {
        ctx.reply(buildCsDataSourcesReport());
        return true;
      }

      if (sub === 'warm' || sub === 'prewarm' || sub === 'refresh' || sub === '预热' || sub === '刷新') {
        if (!config.admin_qq.includes(ctx.event.user_id)) {
          ctx.replyAt('预热实时数据得管理员来，别把外站当练枪房。');
          return true;
        }
        const warmMode = (rest[0] || '').toLowerCase();
        if (warmMode === 'plan' || warmMode === 'dry-run' || warmMode === 'check' || warmMode === '预检') {
          ctx.reply(buildCsPrewarmPlanReport(rest.slice(1)));
          return true;
        }
        ctx.reply(await buildCsPrewarmReport(rest));
        return true;
      }

      if (sub === 'evidence' || sub === '证据' || sub === '来源') {
        const parsed = parseEvidenceArgs(rest);
        ctx.reply(parsed.target === 'all'
          ? buildCsDataEvidenceOverview()
          : buildCsDataEvidenceReport(parsed.target, parsed.subject));
        return true;
      }

      if (sub === 'hltvcheck' || sub === 'linkcheck' || sub === 'pagecheck' || sub === 'hltvlink' || sub === '链接核验' || sub === '页面核验') {
        ctx.reply(await buildHltvMatchLinkCheckReport(subject || rest.join(' ')));
        return true;
      }

      if (sub === 'verify' || sub === 'truth' || sub === 'factcheck' || sub === 'fact' || sub === '真实' || sub === '核验' || sub === '预检') {
        ctx.reply(buildCsFactVerifyReport(rest));
        return true;
      }

      if (sub === 'health' || sub === 'check' || sub === 'doctor') {
        const health = await checkCsDataHealth();
        const lines = [
          `CS数据健康度: ${health.ok ? 'OK' : 'FAIL'}`,
          `缓存: ${health.cache.entries}条 [${health.cache.keys.join(', ') || '无'}]`,
          `主源: ${health.source.primaryBaseUrl}`,
          '',
          ...health.checks.map((item) => `${item.ok ? 'OK' : 'FAIL'} ${item.name}: ${item.lines}行${item.snippet ? ` | ${item.snippet}` : ''}`),
        ];
        ctx.reply(lines.join('\n'));
        return true;
      }

      if (sub === 'clear' || sub === 'clean') {
        if (!config.admin_qq.includes(ctx.event.user_id)) {
          ctx.replyAt('这个得管理员来清。');
          return true;
        }
        clearHltvCache();
        ctx.reply('CS实时数据缓存已清空。');
        return true;
      }

      ctx.reply([
        '用法:',
        '/cs brief - 今日CS短报',
        '/cs today check - 只读预检今日短报核心缓存 fresh/stale/miss',
        '/cs match - 当前/即将比赛',
        '/cs match <matchid> [maps] - CS API 单场详情/HLTV页面候选/地图比分/地图池线索/竞猜地图边界/地图亮点/选手亮点',
        '/cs results - 最近赛果',
        '/cs ranking - 排名快照',
        '/cs team <队伍> - 队伍阵容/排名/地图样本',
        '/cs player <选手> - 选手统计',
        '/cs search <关键词> - 联网查新消息',
        '/cs status - 数据源和缓存命中',
        '/cs cache prune - 管理员只清 stale CS 事实缓存，保留 fresh、飞行请求和 HLTV link-check',
        '/cs sources - 数据来源和 HLTV/CS API/Liquipedia 链接边界',
        '/cs warm [all|watch|predict|team <队伍>|player <选手>] - 管理员预热实时缓存',
        '/cs warm plan [all|watch|predict|match <id>|team <队伍>|player <选手>] - 只读查看哪些缓存会命中/刷新',
        '/cs evidence [all|matches|results|ranking|match <id>|team <队伍>|player <选手>] - 来源链接/缓存证据卡',
        '/cs hltvcheck <matchid> - 只读活链路核验 HLTV 比赛页候选，不写事实缓存',
        '/cs verify [matches|results|ranking|match <id>|team <队伍>|player <选手>|all] - 只读预检事实回复能否当当前结论',
        '/cs intent <自然语言问题> - 只读预检问法会不会走实时插件、命中哪个缓存键',
        '/cs health - 实测数据链路',
      ].join('\n'));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.reply(`CS数据这下没接住: ${message.slice(0, 120)}\n先跑 /cs status 看缓存和数据源。`);
      return true;
    }
  },
};

export const __test = {
  routeNaturalCsQuery,
  extractMatchIdFromSubject,
  parseEvidenceArgs,
  buildCsFactVerifyReport,
  formatCsIntentReport,
  setDataFetchersForTests(fetchers?: Partial<CsDataFetchers>): void {
    dataFetchers = {
      brief: fetchers?.brief || buildBrief,
      matches: fetchers?.matches || fetchOngoingMatches,
      results: fetchers?.results || fetchRecentResults,
      matchDetail: fetchers?.matchDetail || fetchMatchDetail,
      ranking: fetchers?.ranking || fetchTeamRanking,
      team: fetchers?.team || fetchTeamProfile,
      player: fetchers?.player || fetchPlayerProfile,
      search: fetchers?.search || searchCsNews,
    };
  },
};
