import {
  describeHltvCacheEntry,
  fetchMatchDetail,
  fetchOngoingMatches,
  fetchPlayerProfile,
  fetchRecentResults,
  fetchTeamProfile,
  fetchTeamRanking,
  flushHltvCache,
  getCsProfileCacheKey,
  inspectHltvCacheEntry,
} from './hltv-api';
import { getCsPredictPrewarmTargets } from './cs-predict';
import { getCsWatchPrewarmTargets } from './cs-watch';
import { buildCsPlanFactTypeCoverageLines } from './cs-fact-coverage';

export interface CsPrewarmChatTarget {
  chatType: 'group' | 'private';
  chatId: number;
}

export interface CsPrewarmTarget {
  label: string;
  cacheKey: string;
  run: () => Promise<string>;
}

export interface CsPrewarmRow {
  label: string;
  cacheKey: string;
  ok: boolean;
  lineCount: number;
  sample: string;
  evidence: string;
}

export interface CsPrewarmResult {
  targetCount: number;
  ok: number;
  failed: number;
  durationMs: number;
  rows: CsPrewarmRow[];
}

export interface CsPrewarmPlanRow {
  label: string;
  cacheKey: string;
  status: 'fresh' | 'stale' | 'miss';
  action: 'hit' | 'refresh';
  detail: string;
}

export interface CsPrewarmPlanResult {
  targetCount: number;
  fresh: number;
  stale: number;
  miss: number;
  rows: CsPrewarmPlanRow[];
}

interface CsPrewarmBuildOptions {
  chats?: CsPrewarmChatTarget[];
  maxDynamicTargets?: number;
}

function nowShanghai(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function countNonEmptyLines(value: string): number {
  return (value || '').split(/\r?\n/).filter((line) => line.trim()).length;
}

function firstContentLine(value: string): string {
  return (value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^(?:缓存|来源)[:：]/.test(line)) || '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function coreTargets(): CsPrewarmTarget[] {
  return [
    { label: 'matches', cacheKey: 'matches', run: fetchOngoingMatches },
    { label: 'results', cacheKey: 'results', run: fetchRecentResults },
    { label: 'ranking', cacheKey: 'ranking', run: fetchTeamRanking },
  ];
}

function profileTarget(kind: 'team' | 'player', subject: string, labelPrefix = ''): CsPrewarmTarget | null {
  const normalized = subject.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const label = `${labelPrefix}${labelPrefix ? ' ' : ''}${kind} ${normalized}`;
  return {
    label,
    cacheKey: getCsProfileCacheKey(kind, normalized),
    run: () => kind === 'team' ? fetchTeamProfile(normalized) : fetchPlayerProfile(normalized),
  };
}

function extractMatchId(value: string): string {
  const text = (value || '').trim();
  const match = text.match(/(?:match\s*id|matchid|比赛id|赛果id)?\s*[=：:\s#-]*(\d{4,})/i);
  return match?.[1] || '';
}

function matchTarget(subject: string): CsPrewarmTarget | null {
  const matchId = extractMatchId(subject);
  if (!matchId) return null;
  return {
    label: `match ${matchId}`,
    cacheKey: `match:${matchId}`,
    run: () => fetchMatchDetail(matchId),
  };
}

function pushUnique(targets: CsPrewarmTarget[], target: CsPrewarmTarget | null): void {
  if (!target) return;
  if (targets.some((item) => item.cacheKey === target.cacheKey)) return;
  targets.push(target);
}

function pushCore(targets: CsPrewarmTarget[], includeRanking: boolean = true): void {
  for (const target of coreTargets()) {
    if (!includeRanking && target.cacheKey === 'ranking') continue;
    pushUnique(targets, target);
  }
}

function pushCoreTarget(targets: CsPrewarmTarget[], key: 'matches' | 'results' | 'ranking'): void {
  pushUnique(targets, coreTargets().find((target) => target.cacheKey === key) || null);
}

function pushWatchTargets(targets: CsPrewarmTarget[], options: CsPrewarmBuildOptions): void {
  const watchTargets = getCsWatchPrewarmTargets({
    chats: options.chats,
    maxTargets: options.maxDynamicTargets || 8,
  });
  const hasMatchWatch = watchTargets.some((item) => item.kind === 'match');
  if (hasMatchWatch) {
    pushUnique(targets, { label: 'watch matches', cacheKey: 'matches', run: fetchOngoingMatches });
    pushUnique(targets, { label: 'watch results', cacheKey: 'results', run: fetchRecentResults });
  }
  for (const item of watchTargets) {
    if (item.kind === 'team' || item.kind === 'player') {
      pushUnique(targets, profileTarget(item.kind, item.subject, 'watch'));
    }
  }
}

function pushPredictTargets(targets: CsPrewarmTarget[], options: CsPrewarmBuildOptions): void {
  pushUnique(targets, { label: 'predict matches', cacheKey: 'matches', run: fetchOngoingMatches });
  pushUnique(targets, { label: 'predict results', cacheKey: 'results', run: fetchRecentResults });
  const predictTargets = getCsPredictPrewarmTargets({
    chats: options.chats,
    maxTargets: options.maxDynamicTargets || 8,
  });
  for (const item of predictTargets) {
    pushUnique(targets, profileTarget('team', item.subject, 'predict'));
  }
}

export function buildCsPrewarmTargets(args: string[] = [], options: CsPrewarmBuildOptions = {}): CsPrewarmTarget[] {
  const first = (args[0] || 'core').toLowerCase();
  const subject = args.slice(1).join(' ').trim();
  const targets: CsPrewarmTarget[] = [];

  const directMatchTarget = matchTarget(args.join(' '));
  if (directMatchTarget && (/^\d{4,}$/.test(first) || ['match', 'matchid', '单场', '详情'].includes(first))) {
    pushUnique(targets, directMatchTarget);
    return targets;
  }
  if (['match', 'matches', 'live', '赛程', '比赛'].includes(first)) {
    pushCoreTarget(targets, 'matches');
    return targets;
  }
  if (['result', 'results', 'news', '赛果', '战报'].includes(first)) {
    pushCoreTarget(targets, 'results');
    return targets;
  }
  if (['ranking', 'rank', 'top', '排名'].includes(first)) {
    pushCoreTarget(targets, 'ranking');
    return targets;
  }
  if (['team', '队伍', '战队'].includes(first)) {
    pushUnique(targets, profileTarget('team', subject));
    return targets;
  }
  if (['player', '选手'].includes(first)) {
    pushUnique(targets, profileTarget('player', subject));
    return targets;
  }
  if (['watch', 'watched', '关注', '订阅'].includes(first)) {
    pushCore(targets, false);
    pushWatchTargets(targets, options);
    return targets;
  }
  if (['predict', 'prediction', '竞猜', '盘口'].includes(first)) {
    pushPredictTargets(targets, options);
    return targets;
  }
  if (['all', 'full', '全部', '全量'].includes(first)) {
    pushCore(targets);
    pushWatchTargets(targets, options);
    pushPredictTargets(targets, options);
    return targets;
  }

  pushCore(targets);
  return targets;
}

export async function runCsPrewarmTargets(
  targets: CsPrewarmTarget[],
  options: { timeoutMs?: number; flush?: boolean } = {},
): Promise<CsPrewarmResult> {
  const started = Date.now();
  const timeoutMs = Math.max(1000, options.timeoutMs || 9000);
  const rows = await Promise.all(targets.map(async (target) => {
    const value = await withTimeout(target.run().catch(() => ''), timeoutMs, '');
    const lineCount = countNonEmptyLines(value);
    return {
      label: target.label,
      cacheKey: target.cacheKey,
      ok: lineCount > 0,
      lineCount,
      sample: firstContentLine(value).slice(0, 90),
      evidence: describeHltvCacheEntry(target.cacheKey),
    };
  }));
  if (options.flush !== false) flushHltvCache();
  const ok = rows.filter((row) => row.ok).length;
  return {
    targetCount: rows.length,
    ok,
    failed: rows.length - ok,
    durationMs: Date.now() - started,
    rows,
  };
}

export function formatCsPrewarmRows(rows: CsPrewarmRow[]): string[] {
  return rows.map((row) => [
    `- ${row.label}: ${row.ok ? 'OK' : 'FAIL'} ${row.lineCount}行`,
    row.evidence && !row.evidence.endsWith(' miss') ? ` | ${row.evidence}` : '',
    row.sample ? ` | ${row.sample}` : '',
  ].join(''));
}

function commandSubjectFromRow(row: { label: string; cacheKey: string }): string {
  if (row.cacheKey.startsWith('match:')) return row.cacheKey.slice('match:'.length);
  const labelMatch = row.label.match(/(?:^|\s)(?:team|player)\s+(.+)$/i);
  if (labelMatch?.[1]) return labelMatch[1].trim();
  if (row.cacheKey.startsWith('team:')) return row.cacheKey.slice('team:'.length);
  if (row.cacheKey.startsWith('player:')) return row.cacheKey.slice('player:'.length);
  return '';
}

function verifyCommandForPrewarmRow(row: { label: string; cacheKey: string }): string {
  const subject = commandSubjectFromRow(row);
  if (row.cacheKey === 'matches') return '/cs verify matches';
  if (row.cacheKey === 'results') return '/cs verify results';
  if (row.cacheKey === 'ranking') return '/cs verify ranking';
  if (row.cacheKey.startsWith('match:')) return `/cs verify match ${subject}`.trim();
  if (row.cacheKey.startsWith('team:')) return `/cs verify team ${subject}`.trim();
  if (row.cacheKey.startsWith('player:')) return `/cs verify player ${subject}`.trim();
  return '/cs verify all';
}

function evidenceCommandForPrewarmRow(row: { label: string; cacheKey: string }): string {
  const subject = commandSubjectFromRow(row);
  if (row.cacheKey === 'matches') return '/cs evidence matches';
  if (row.cacheKey === 'results') return '/cs evidence results';
  if (row.cacheKey === 'ranking') return '/cs evidence ranking';
  if (row.cacheKey.startsWith('match:')) return `/cs evidence match ${subject}`.trim();
  if (row.cacheKey.startsWith('team:')) return `/cs evidence team ${subject}`.trim();
  if (row.cacheKey.startsWith('player:')) return `/cs evidence player ${subject}`.trim();
  return '/cs evidence all';
}

function formatCsPrewarmPostVerify(result: CsPrewarmResult): string[] {
  const rows = result.rows.map((row) => ({
    row,
    snapshot: inspectHltvCacheEntry(row.cacheKey),
  }));
  const fresh = rows.filter((item) => item.snapshot?.status === 'fresh').length;
  const stale = rows.filter((item) => item.snapshot?.status === 'stale').length;
  const miss = rows.filter((item) => !item.snapshot).length;
  const notFresh = rows.filter((item) => item.snapshot?.status !== 'fresh');
  const first = result.rows[0];
  const verify = result.rows.length === 1 && first ? verifyCommandForPrewarmRow(first) : '/cs verify all';
  const evidence = result.rows.length === 1 && first ? evidenceCommandForPrewarmRow(first) : '/cs evidence all';
  const conclusion = fresh === rows.length
    ? '预热后判定: 全部 fresh，可以按当前快照组织回复；仍只说证据文本明确出现的事实。'
    : fresh > 0
      ? '预热后判定: 只有部分 fresh；fresh 可作当前快照，stale/miss 只能降级成旧线索/待查。'
      : '预热后判定: 没有 fresh 证据，不能说成“现在/最新/刚查到”。';
  const gaps = notFresh
    .map((item) => `${item.row.label}[${item.row.cacheKey}]`)
    .slice(0, 4)
    .join(' / ');
  const factRows = rows.map((item) => ({
    label: item.row.label,
    cacheKey: item.row.cacheKey,
    status: item.snapshot?.status || 'miss' as const,
    action: item.snapshot?.status === 'fresh' ? 'hit' as const : 'refresh' as const,
  }));
  return [
    `预热后覆盖: fresh ${fresh}/${rows.length}，stale ${stale}，miss ${miss}`,
    conclusion,
    ...buildCsPlanFactTypeCoverageLines(factRows, '预热后事实类型覆盖:'),
    `复核: ${verify}；证据: ${evidence}${gaps ? `；缺口: ${gaps}` : ''}`,
    '边界: /cs warm 只负责补缓存；真正对外回复仍看 fresh/stale/miss，别把 stale/miss 包装成实时事实。',
  ];
}

export function buildCsPrewarmPlan(args: string[] = [], options: CsPrewarmBuildOptions = {}): CsPrewarmPlanResult {
  const targets = buildCsPrewarmTargets(args, options);
  const rows: CsPrewarmPlanRow[] = targets.map((target) => {
    const snapshot = inspectHltvCacheEntry(target.cacheKey);
    if (!snapshot) {
      return {
        label: target.label,
        cacheKey: target.cacheKey,
        status: 'miss',
        action: 'refresh',
        detail: 'miss，会请求实时源',
      };
    }
    if (snapshot.status === 'fresh') {
      return {
        label: target.label,
        cacheKey: target.cacheKey,
        status: 'fresh',
        action: 'hit',
        detail: `fresh 命中，ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s hit=${snapshot.hits}${snapshot.source ? ` source=${snapshot.source}` : ''}`,
      };
    }
    return {
      label: target.label,
      cacheKey: target.cacheKey,
      status: 'stale',
      action: 'refresh',
      detail: `stale，expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s；只能当旧快照线索${snapshot.source ? ` source=${snapshot.source}` : ''}`,
    };
  });
  return {
    targetCount: rows.length,
    fresh: rows.filter((row) => row.status === 'fresh').length,
    stale: rows.filter((row) => row.status === 'stale').length,
    miss: rows.filter((row) => row.status === 'miss').length,
    rows,
  };
}

export function formatCsPrewarmPlanRows(rows: CsPrewarmPlanRow[]): string[] {
  return rows.map((row) => `- ${row.label} [${row.cacheKey}]: ${row.action === 'hit' ? 'HIT' : 'REFRESH'} | ${row.detail}`);
}

function warmCommandForPlanArgs(args: string[]): string {
  const suffix = args.join(' ').trim();
  return suffix ? `/cs warm ${suffix}` : '/cs warm';
}

function formatCsPrewarmPlanNextSteps(result: CsPrewarmPlanResult, args: string[]): string[] {
  const requestCount = result.stale + result.miss;
  const first = result.rows[0];
  const verify = result.rows.length === 1 && first ? verifyCommandForPrewarmRow(first) : '/cs verify all';
  const evidence = result.rows.length === 1 && first ? evidenceCommandForPrewarmRow(first) : '/cs evidence all';
  const exec = warmCommandForPlanArgs(args);
  const action = requestCount > 0
    ? `执行: 管理员 ${exec}，预计刷新 ${requestCount} 项。`
    : `执行: 当前目标都是 fresh，通常不必预热；要确认仍可管理员 ${exec}。`;
  return [
    action,
    `复核: ${verify}；证据: ${evidence}`,
    '边界: plan 只读不请求外站；执行 warm 后仍要看 fresh/stale/miss，不能把 stale/miss 包装成实时事实。',
  ];
}

export function buildCsPrewarmPlanReport(args: string[] = []): string {
  const targets = buildCsPrewarmTargets(args, { maxDynamicTargets: 10 });
  if (targets.length === 0) {
    return '用法: /cs warm plan\n/cs warm plan all\n/cs warm plan watch\n/cs warm plan predict\n/cs warm plan match 2390002\n/cs warm plan team Vitality\n/cs warm plan player donk';
  }
  const result = buildCsPrewarmPlan(args, { maxDynamicTargets: 10 });
  return [
    `CS实时数据预热计划 | ${nowShanghai()}`,
    ...formatCsPrewarmPlanRows(result.rows),
    `统计: fresh ${result.fresh}/${result.targetCount}，stale ${result.stale}，miss ${result.miss}，预计请求 ${result.stale + result.miss}`,
    ...buildCsPlanFactTypeCoverageLines(result.rows),
    ...formatCsPrewarmPlanNextSteps(result, args),
    '说明: 这是只读计划，不请求外站；stale 只能当旧快照线索，真正预热用 /cs warm 对应目标。',
  ].join('\n');
}

export async function buildCsPrewarmReport(args: string[] = []): Promise<string> {
  const targets = buildCsPrewarmTargets(args, { maxDynamicTargets: 10 });
  if (targets.length === 0) {
    return '用法: /cs warm\n/cs warm all\n/cs warm watch\n/cs warm predict\n/cs warm match 2390002\n/cs warm team Vitality\n/cs warm player donk';
  }
  const result = await runCsPrewarmTargets(targets, { timeoutMs: 9000 });
  return [
    `CS实时数据预热完成 | ${nowShanghai()} | ${result.durationMs}ms`,
    ...formatCsPrewarmRows(result.rows),
    `统计: OK ${result.ok}/${result.targetCount}，失败 ${result.failed}`,
    ...formatCsPrewarmPostVerify(result),
    '说明: 预热只负责拉取并写入短期缓存，回答仍以每条数据的来源时间/缓存状态为准。',
  ].join('\n');
}

export async function prewarmCsDataForReport(options: CsPrewarmBuildOptions = {}): Promise<CsPrewarmResult> {
  const targets = buildCsPrewarmTargets(['all'], {
    chats: options.chats,
    maxDynamicTargets: options.maxDynamicTargets || 6,
  });
  return runCsPrewarmTargets(targets, { timeoutMs: 6500 });
}
