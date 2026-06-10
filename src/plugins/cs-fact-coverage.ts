import { getHltvStats, inspectHltvCacheEntry, HltvCacheEntrySnapshot } from './hltv-api';

type CoreFactKey = 'matches' | 'results' | 'ranking';

export interface CsFactTypePlanItem {
  label?: string;
  cacheKey: string;
  status?: 'fresh' | 'stale' | 'miss';
  action?: 'hit' | 'refresh';
}

interface DynamicCoverageSummary {
  fresh: number;
  stale: number;
  samples: string[];
}

function describeCoreFactKey(key: CoreFactKey): string {
  const snapshot = inspectHltvCacheEntry(key);
  if (!snapshot) return `${key}=miss`;
  if (snapshot.status === 'fresh') {
    return `${key}=fresh age=${snapshot.ageSeconds}s ttl=${snapshot.ttlSeconds}s`;
  }
  return `${key}=stale age=${snapshot.ageSeconds}s expired=${snapshot.expiredSeconds}s`;
}

function summarizeDynamicCoverage(items: HltvCacheEntrySnapshot[], prefix: string): DynamicCoverageSummary {
  const matched = items.filter((item) => item.key.startsWith(prefix));
  const freshItems = matched.filter((item) => item.status === 'fresh');
  const staleItems = matched.filter((item) => item.status === 'stale');
  return {
    fresh: freshItems.length,
    stale: staleItems.length,
    samples: [...freshItems, ...staleItems].slice(0, 3).map((item) => item.key),
  };
}

function formatDynamicCoverage(summary: DynamicCoverageSummary, emptyText: string): string {
  if (summary.fresh === 0 && summary.stale === 0) return emptyText;
  const sample = summary.samples.length > 0 ? `；样本 ${summary.samples.join(' / ')}` : '';
  return `已有缓存 fresh ${summary.fresh} / stale ${summary.stale}${sample}`;
}

function formatDynamicCount(summary: DynamicCoverageSummary): string {
  return `fresh ${summary.fresh} / stale ${summary.stale}`;
}

function describePlanAction(row: CsFactTypePlanItem): string {
  const action = row.action === 'hit' ? 'HIT' : 'REFRESH';
  return `${action}(${row.status || 'unknown'})`;
}

function formatPlanSingle(rows: CsFactTypePlanItem[], cacheKey: string, missingText: string): string {
  const row = rows.find((item) => item.cacheKey === cacheKey);
  return row ? `${cacheKey} ${describePlanAction(row)}` : `未包含；${missingText}`;
}

function formatPlanGroup(rows: CsFactTypePlanItem[], emptyText: string): string {
  if (rows.length === 0) return emptyText;
  const hit = rows.filter((row) => row.action === 'hit').length;
  const refresh = rows.length - hit;
  const sample = rows.slice(0, 3)
    .map((row) => `${row.cacheKey}=${describePlanAction(row)}`)
    .join(' / ');
  return `目标${rows.length}个 HIT ${hit} / REFRESH ${refresh}${sample ? `；${sample}` : ''}`;
}

export function buildCsFactTypeCoverageLines(): string[] {
  const stats = getHltvStats();
  const teamCoverage = summarizeDynamicCoverage(stats.items, 'team:');
  const playerCoverage = summarizeDynamicCoverage(stats.items, 'player:');
  const matchDetailCoverage = summarizeDynamicCoverage(stats.items, 'match:');

  return [
    '事实类型覆盖:',
    `- 当前排名: ${describeCoreFactKey('ranking')} | /cs verify ranking`,
    `- 赛程/赛果/单场: ${describeCoreFactKey('matches')}；${describeCoreFactKey('results')}；单场详情 ${formatDynamicCount(matchDetailCoverage)} | /cs verify matches；/cs verify results；/cs verify match <id>`,
    `- 阵容/转会: 按队伍目标核验；${formatDynamicCoverage(teamCoverage, '暂无队伍缓存样本')}；ranking fresh 不能替代阵容/转会证据 | /cs verify team <队伍>`,
    `- 选手数据/状态: 按选手目标核验；${formatDynamicCoverage(playerCoverage, '暂无选手缓存样本')}；match:<id> 只覆盖对应比赛里的局部表现 ${formatDynamicCount(matchDetailCoverage)} | /cs verify player <选手>`,
    `- 版本/地图池: 暂无全局实时缓存；只在具体来源或单场详情明确写到时作局部线索，其他需要人工/来源核验 | /cs sources`,
  ];
}

export function formatCsFactTypeCoverageBlock(): string {
  return buildCsFactTypeCoverageLines().join('\n');
}

export function buildCsPlanFactTypeCoverageLines(rows: CsFactTypePlanItem[], title = '计划事实类型覆盖:'): string[] {
  const matchRows = rows.filter((row) => row.cacheKey.startsWith('match:'));
  const teamRows = rows.filter((row) => row.cacheKey.startsWith('team:'));
  const playerRows = rows.filter((row) => row.cacheKey.startsWith('player:'));
  const hasMatchPlan = matchRows.length > 0;

  return [
    title,
    `- 当前排名: ${formatPlanSingle(rows, 'ranking', '如要排名当前事实用 /cs warm plan ranking')} | /cs verify ranking`,
    [
      '- 赛程/赛果/单场: ',
      `${formatPlanSingle(rows, 'matches', '如要赛程当前事实用 /cs warm plan matches')}；`,
      `${formatPlanSingle(rows, 'results', '如要赛果当前事实用 /cs warm plan results')}；`,
      `单场详情 ${formatPlanGroup(matchRows, '未包含；单场事实需 /cs warm plan match <id>')}`,
      ' | /cs verify matches；/cs verify results；/cs verify match <id>',
    ].join(''),
    `- 阵容/转会: ${formatPlanGroup(teamRows, '未包含 team 目标；阵容需 /cs warm plan team <队伍>')}；ranking fresh 不能替代阵容/转会证据 | /cs verify team <队伍>`,
    `- 选手数据/状态: ${formatPlanGroup(playerRows, '未包含 player 目标；选手状态需 /cs warm plan player <选手>')}；${hasMatchPlan ? 'match:<id> 只覆盖对应比赛局部表现' : '未包含 match:<id> 局部表现'} | /cs verify player <选手>`,
    `- 版本/地图池: ${hasMatchPlan ? formatPlanGroup(matchRows, '未包含 match:<id>') : '未包含全局目标'}；只有具体来源或单场详情明确写到时作局部线索 | /cs sources`,
  ];
}

export function formatCsPlanFactTypeCoverageBlock(rows: CsFactTypePlanItem[], title?: string): string {
  return buildCsPlanFactTypeCoverageLines(rows, title).join('\n');
}
