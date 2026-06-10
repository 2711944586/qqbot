import { Plugin } from '../types';
import { hasUsableApiKey } from '../config';
import { getAiChatStats } from './ai-chat';
import { getCacheStats } from './image-cache';
import { auditKnowledge, getKnowledgeRuntimePaths, getKnowledgeStats, loadKnowledgeSources } from './knowledge-base';
import { getSearchStats, webSearch } from './web-search';
import { getSttStats } from './stt';
import { getVoiceStats } from './tts';
import { checkCsDataHealth, getHltvStats, inspectHltvCacheEntry } from './hltv-api';
import { callLLMWithRetry } from './llm-api';
import { __test as funTest } from './fun';
import { getLiquipediaImageStats } from './liquipedia-image';
import { getUserProfileStats } from './user-profile';
import { buildCsFactTypeCoverageLines } from './cs-fact-coverage';
import { inspectRuntimeStorage } from './runtime-storage';
import * as fs from 'fs';

type CsDataHealth = Awaited<ReturnType<typeof checkCsDataHealth>>;
let csDataHealthChecker: () => Promise<CsDataHealth> = checkCsDataHealth;

interface CoreCsDataTarget {
  key: 'matches' | 'results' | 'ranking';
  label: string;
  verify: string;
  evidence: string;
  warmPlan: string;
}

const CORE_CS_DATA_TARGETS: CoreCsDataTarget[] = [
  { key: 'matches', label: '当前/即将比赛', verify: '/cs verify matches', evidence: '/cs evidence matches', warmPlan: '/cs warm plan matches' },
  { key: 'results', label: '近期赛果', verify: '/cs verify results', evidence: '/cs evidence results', warmPlan: '/cs warm plan results' },
  { key: 'ranking', label: '战队排名', verify: '/cs verify ranking', evidence: '/cs evidence ranking', warmPlan: '/cs warm plan ranking' },
];

function formatCoreCsDataTruthPanel(): string[] {
  const hltvStats = getHltvStats();
  const rows = CORE_CS_DATA_TARGETS.map((target) => ({
    ...target,
    snapshot: inspectHltvCacheEntry(target.key),
  }));
  const fresh = rows.filter((row) => row.snapshot?.status === 'fresh').length;
  const stale = rows.filter((row) => row.snapshot?.status === 'stale').length;
  const miss = rows.filter((row) => !row.snapshot).length;
  const notFresh = rows.filter((row) => row.snapshot?.status !== 'fresh');
  const verdict = fresh === rows.length
    ? '可支撑当前核心快照'
    : fresh > 0
      ? '只能支撑部分当前快照'
      : '不能支撑当前核心结论';
  const action = fresh === rows.length
    ? 'fresh 项可以按当前快照说；仍只说证据文本里明确出现的事实。'
    : 'fresh 项可说当前；stale 只能说旧快照线索；miss 只代表本地无快照，不能反推没有比赛/赛果/排名变化。';
  const gap = notFresh.length > 0
    ? notFresh.map((row) => `${row.label}[${row.key}]`).join(' / ')
    : '无';
  const recentStale = hltvStats.items
    .filter((item) => item.status === 'stale')
    .slice(0, 4)
    .map((item) => `${item.key} expired=${item.expiredSeconds}s`);

  const lines = [
    '--- CS事实覆盖 ---',
    `覆盖: fresh ${fresh} / stale ${stale} / miss ${miss}`,
    `当前事实判定: ${verdict}`,
    `回复动作: ${action}`,
    `补证路线: ${notFresh.length > 0 ? '管理员 /cs warm plan all -> /cs warm all' : '/cs evidence all 复核证据卡'}${notFresh.length > 0 ? `；缺口 ${gap}` : ''}`,
    '复核入口: /cs verify all；证据入口: /cs evidence all；来源边界: /cs sources',
  ];

  for (const row of rows) {
    const snapshot = row.snapshot;
    const state = snapshot
      ? snapshot.status === 'fresh'
        ? `fresh ttl=${snapshot.ttlSeconds}s age=${snapshot.ageSeconds}s`
        : `stale expired=${snapshot.expiredSeconds}s age=${snapshot.ageSeconds}s`
      : 'miss 无成功快照';
    lines.push(`- ${row.label}: ${state} | ${row.verify} | ${row.evidence} | ${row.warmPlan}`);
  }
  if (recentStale.length > 0) {
    lines.push(`最近旧缓存: ${recentStale.join(' / ')}`);
  }
  lines.push(...buildCsFactTypeCoverageLines());
  lines.push('边界: /data 是只读面板；fresh 才能当“现在/最新”依据，stale/miss 需要按边界降级。');
  return lines;
}

export const diagPlugin: Plugin = {
  name: 'diag',
  description: '严格自检诊断',
  handler: async (ctx) => {
    // ===== /data 实时数据健康度（含 CS API/Liquipedia/搜索测试） =====
    if (ctx.command === 'data' || ctx.command === 'realtime') {
      const ai = ctx.bot.getConfig().ai;
      const lines: string[] = ['📡 实时数据状态'];
      const start = Date.now();
      const imageStats = getCacheStats();
      const searchStats = getSearchStats();
      const voiceStats = getVoiceStats(ai);
      const sttStats = getSttStats(ai);
      const aiStats = getAiChatStats();
      const liqStats = getLiquipediaImageStats();
      const profileStats = getUserProfileStats();

      // 1. 实测 CS 结构化数据链路
      const csHealth = await csDataHealthChecker();
      lines.push(`主源: ${csHealth.source.primaryBaseUrl}`);
      lines.push(`说明: ${csHealth.source.note}`);
      lines.push(`缓存: ${csHealth.cache.entries} 条 [${csHealth.cache.keys.join(', ') || '无'}]`);
      lines.push('');
      lines.push('--- 实测 CS API / Liquipedia ---');
      for (const check of csHealth.checks) {
        lines.push(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.lines}行${check.snippet ? ` | ${check.snippet}` : ''}`);
      }
      lines.push('');
      lines.push(...formatCoreCsDataTruthPanel());

      // 2. 实测 webSearch
      lines.push('');
      lines.push('--- 实测 webSearch ---');
      const wsResult = await webSearch('CS2 最新比赛 2026', 5000, 0, 0);
      lines.push(`webSearch: ${wsResult ? wsResult.length + ' 字符' : '空'}`);
      if (wsResult) {
        const firstLine = wsResult.split('\n')[0].slice(0, 100);
        lines.push(`首条: ${firstLine}`);
      }
      lines.push(`搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries} 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 飞行${searchStats.inFlight}`);

      // 3. 每日CS真实图源与多模态开关（轻量状态，不做完整外网图片批测）
      lines.push('');
      lines.push('--- 每日CS / 多模态 ---');
      lines.push(`每日CS池: 选手${funTest.csPlayers.length} 队伍${funTest.csTeams.length} 地图${funTest.csMaps.length} 武器${funTest.csWeapons.length} 定位${funTest.csRoles.length} 道具${funTest.csUtilities.length} 战术${funTest.csTactics.length} 残局${funTest.csClutches.length}`);
      lines.push(`真实图策略: Liquipedia/Fandom/Wikimedia优先，本地签位卡兜底；完整实测用 /csimage test all`);
      lines.push(`Liquipedia图解析: 缓存${liqStats.entries} 限流${liqStats.rateLimited ? 'yes' : 'no'}`);
      lines.push(`图片缓存: ${imageStats.count}/${imageStats.maxFiles}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB 命中${imageStats.hits}/${imageStats.misses} 失败${imageStats.downloadFailures} 飞行${imageStats.inFlight}`);
      if (imageStats.lastError) lines.push(`最近图片错误: ${imageStats.lastError}`);
      lines.push(`识图: ${ai.enable_vision ? 'on' : 'off'} model=${ai.vision_model || '-'} 并发${ai.vision_global_concurrency}`);
      lines.push(`语音: ${ai.enable_tts ? 'on' : 'off'} ${voiceStats.provider}${voiceStats.localReady ? '/local' : ''} send=${voiceStats.sendMode} 缓存${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles} ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB 命中${voiceStats.hits}/${voiceStats.misses} 飞行${voiceStats.inFlight} 合并${voiceStats.inFlightHits}`);
      lines.push(`听写: ${ai.enable_stt ? 'on' : 'off'} ${sttStats.provider}${sttStats.localReady ? '/local' : ''} payload=${sttStats.payloadMode}/${sttStats.lastPayloadMode || '-'} 缓存${sttStats.cacheFiles}/${sttStats.maxCacheFiles} ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 命中${sttStats.hits}/${sttStats.misses} 飞行${sttStats.inFlight} 合并${sttStats.inFlightHits}`);
      lines.push(`AI回复缓存: ${aiStats.replyCacheEntries}条 飞行${aiStats.replyInFlight} 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses} 旁路${aiStats.replyCacheBypasses}`);
      lines.push(`AI缓存策略Top: ${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`);
      lines.push(`用户画像缓存: ${profileStats.cached ? 'warm' : 'cold'} 条目${profileStats.profiles} 命中${profileStats.cacheHits}/${profileStats.diskReads} 写入${profileStats.diskWrites} 解析错${profileStats.parseErrors}`);
      lines.push(`回复真实性: 证据${aiStats.evidenceTraceCount} 无实时${aiStats.realtimeIntentWithoutDataCount} 旧证据${aiStats.realtimeStaleEvidenceCount} 事实修正${aiStats.factGuardRepairCount} 质量修复${aiStats.qualityRepairCount} 输出修复${aiStats.outputRepairCount} 新鲜度${aiStats.freshnessRepairCount}`);
      if (aiStats.lastRealtimeFreshness.length > 0) lines.push(`最近实时证据: ${aiStats.lastRealtimeFreshness.join(' / ').slice(0, 160)}`);
      lines.push(`风格场景: ${aiStats.styleSceneTraceCount}条 最近${aiStats.lastStyleScene || '无'} Top ${aiStats.styleSceneTop.join(' / ') || '无'} 质量风险${aiStats.qualityIssueTraceCount}`);
      if (aiStats.lastEvidenceSummary.length > 0) lines.push(`最近证据: ${aiStats.lastEvidenceSummary.join(' / ').slice(0, 160)}`);
      if (aiStats.lastFactGuard) lines.push(`最近事实边界: ${aiStats.lastFactGuard}`);

      // 4. 知识库
      lines.push('');
      lines.push('--- 知识库 ---');
      const kbStats = getKnowledgeStats();
      lines.push(`知识库: ${kbStats.sections}块/${kbStats.chars}字`);
      lines.push(`自动刷新: ${kbStats.autoEnabled ? 'on' : 'off'} 最近${new Date(kbStats.lastAutoRefreshAt || 0).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

      // 5. 当前时间
      lines.push('');
      lines.push(`⏱ 测试耗时 ${Date.now() - start}ms`);
      lines.push(`系统时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      void ai;
      ctx.reply(lines.join('\n'));
      return true;
    }

    if (ctx.command !== 'diag') return false;

    const config = ctx.bot.getConfig();
    const ai = config.ai;
    const liveMode = (ctx.args[0] || '').toLowerCase() === 'live';
    const isAdmin = config.admin_qq.includes(ctx.event.user_id);
    const hard: string[] = [];
    const risk: string[] = [];
    const suggestions: string[] = [];
    const ok: string[] = [];
    const storage = inspectRuntimeStorage();
    if (storage.failed.length > 0) {
      hard.push(`运行目录不可写: ${storage.failed.map((item) => `${item.label}(${item.rel})`).join(' / ')}`);
      suggestions.push('先修目录权限/磁盘空间，再跑 npm run doctor 和 /diag 复核。');
    } else {
      ok.push('运行目录写盘探针通过');
    }

    const ttsCanRunLocal = ai.enable_tts && (ai.tts_provider === 'local' || ai.tts_provider === 'auto') && !!(ai.tts_local_command || '').trim();
    const sttCanRunLocal = ai.enable_stt && (ai.stt_provider === 'local' || ai.stt_provider === 'auto') && !!(ai.stt_local_command || '').trim();
    if (hasUsableApiKey(ai.api_key)) ok.push('AI接口已配置');
    else hard.push(`AI接口未配置或仍是占位值，/ai和识图不可用${ttsCanRunLocal || sttCanRunLocal ? '；本地语音链路可单独工作' : '，远端TTS/STT不可用'}`);

    if (ai.enable_search) ok.push('联网搜索已开启');
    else risk.push('联网搜索未开启，实时赛果/阵容/价格会不准');

    if (ai.enable_knowledge) ok.push('知识库已开启');
    else hard.push('知识库未开启，风格和选手倾向会变薄');

    if (ai.enable_vision) ok.push('识图已开启');
    else risk.push('识图未开启，图片只会作为上下文占位');

    const voice = getVoiceStats(ai);
    const stt = getSttStats(ai);
    if (ai.enable_tts) ok.push(`语音已开启(${voice.provider}${voice.localReady ? '/local' : voice.cloneReady ? '/clone' : ''})`);
    else suggestions.push('语音未开启，/tts 会不可用');
    if (ai.enable_stt) ok.push(`语音听写已开启(${stt.provider}${stt.localReady ? '/local' : ''} ${stt.model || '未配置模型'})`);
    else suggestions.push('语音听写未开启，收到语音只能按占位和文字上下文回复');
    if ((ai.tts_provider === 'local' || ai.tts_provider === 'auto') && !voice.localReady) {
      risk.push('TTS配置了本地/自动模式，但本地命令为空');
    }
    if ((ai.stt_provider === 'local' || ai.stt_provider === 'auto') && !stt.localReady) {
      risk.push('STT配置了本地/自动模式，但本地命令为空');
    }
    if (ai.enable_tts && ai.tts_clone_enabled !== false && !voice.cloneReady) {
      suggestions.push(`克隆样本不可用: ${voice.sampleReason || 'unknown'} (${voice.samplePath})`);
    }

    if ((ai.context_send_messages || 0) <= (ai.max_context_messages || 0)) ok.push('上下文发送量合理');
    else hard.push('context_send_messages 大于 max_context_messages，配置不合理');

    if ((ai.max_group_queue || 0) >= 1) ok.push('同群队列已配置');
    else hard.push('max_group_queue 过低，普通主动接话可能异常');

    const knowledge = getKnowledgeStats();
    if (knowledge.sections >= 20) ok.push(`知识库分块 ${knowledge.sections}`);
    else risk.push(`知识库分块偏少: ${knowledge.sections}`);
    if (knowledge.autoEnabled && ai.knowledge_auto_update !== false) ok.push('知识库自动刷新已开启');
    else suggestions.push('知识库自动刷新未开启，公开事实不会低频自更新');

    const paths = getKnowledgeRuntimePaths();
    if (fs.existsSync(paths.sourcesFile)) ok.push('sources.json 存在');
    else hard.push('knowledge/sources.json 缺失');
    const sources = loadKnowledgeSources();
    if (sources.length >= 4) ok.push(`公开来源 ${sources.length} 个`);
    else risk.push(`公开来源偏少: ${sources.length}`);
    if (ai.knowledge_quarantine_long_quotes === false) ok.push('知识写入策略为主库分层，风险内容标记待核验');
    else risk.push('knowledge_quarantine_long_quotes 仍是旧策略，建议改 false 并使用主库待核验分区');

    const audit = auditKnowledge();
    const auditHard = audit.issues.filter((item) => item.level === 'hard').length;
    const auditRisk = audit.issues.filter((item) => item.level === 'risk').length;
    if (auditHard > 0) hard.push(`知识库 hard 问题 ${auditHard} 个`);
    if (auditRisk > 0) risk.push(`知识库 risk 问题 ${auditRisk} 个`);
    const aiStats = getAiChatStats();
    const search = getSearchStats();
    const image = getCacheStats();
    let runtime = ctx.bot.getRuntimeStats();
    if (runtime.connected) ok.push(`OneBot WebSocket 已连接(${runtime.readyState})`);
    else hard.push(`OneBot WebSocket 未连接(${runtime.readyState})，bot 收不到消息也发不出去`);
    if (runtime.pendingApi > 20) risk.push(`OneBot API pending 偏高: ${runtime.pendingApi}`);
    if (runtime.apiTimeouts > 0 || runtime.apiFailures > 0) risk.push(`OneBot API 有失败: timeout=${runtime.apiTimeouts} fail=${runtime.apiFailures}`);
    if (runtime.consecutiveEarlyDisconnects >= 3) hard.push(runtime.lastConnectionHint || `WebSocket连续早断开${runtime.consecutiveEarlyDisconnects}次，优先查NapCat登录态和OneBot配置`);
    else if (runtime.totalDisconnects > 0) risk.push(`WebSocket累计断开${runtime.totalDisconnects}次，早断${runtime.consecutiveEarlyDisconnects}次，心跳重连${runtime.staleHeartbeatReconnects}次`);
    if (runtime.lastDisconnectedAt) risk.push(`最近WS断开: code=${runtime.lastDisconnectCode}${runtime.lastDisconnectReason ? ` ${runtime.lastDisconnectReason}` : ''}`);
    if (runtime.lastLoginCheckAt && !runtime.lastLoginOk) {
      hard.push(`QQ登录态异常: ${runtime.lastLoginError || 'get_login_info 未通过'}。NapCat可能还在，但QQ号已下线，需要去WebUI扫码/重登`);
    }
    if (runtime.lastLoginOk && config.bot_qq && runtime.lastLoginUserId && config.bot_qq !== runtime.lastLoginUserId) {
      hard.push(`QQ登录号不匹配: config.bot_qq=${config.bot_qq}，NapCat实际登录=${runtime.lastLoginUserId}。换号必须去NapCat重登，不是只改config`);
    }
    const liveLines: string[] = [];

    if (liveMode) {
      if (!isAdmin) {
        ctx.replyAt('/diag live 得管理员来跑，别把外网检查当玩具。');
        return true;
      }
      runtime = await ctx.bot.checkLoginNow();
      if (!runtime.lastLoginOk && !hard.some((item) => item.includes('QQ登录态异常'))) {
        hard.push(`QQ登录态异常: ${runtime.lastLoginError || 'get_login_info 未通过'}。需要去NapCat WebUI扫码/重登`);
      }
      if (runtime.lastLoginOk && config.bot_qq && runtime.lastLoginUserId && config.bot_qq !== runtime.lastLoginUserId) {
        hard.push(`QQ登录号不匹配: config.bot_qq=${config.bot_qq}，NapCat实际登录=${runtime.lastLoginUserId}`);
      }
      liveLines.push(`live登录态: ${runtime.lastLoginOk ? `OK QQ${runtime.lastLoginUserId || '-'} ${runtime.lastLoginNickname || ''}` : `异常 ${runtime.lastLoginError || 'unknown'}`}`);
      if (hasUsableApiKey(ai.api_key) && ai.api_url && ai.model) {
        try {
          const probeConfig = {
            ...ai,
            api_timeout_ms: Math.min(Math.max(ai.api_timeout_ms || 6000, 3000), 8000),
            max_tokens: Math.min(Math.max(ai.max_tokens || 32, 16), 64),
            temperature: 0.1,
          };
          const started = Date.now();
          const probeReply = await callLLMWithRetry(probeConfig, [
            { role: 'system', content: '你是接口健康检查。只回复 OK。' },
            { role: 'user', content: 'ping' },
          ], false, 1);
          liveLines.push(`liveLLM: OK ${Date.now() - started}ms ${probeReply.slice(0, 40)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          hard.push(`LLM接口实测失败: ${message.slice(0, 180)}`);
          liveLines.push(`liveLLM: FAIL ${message.slice(0, 120)}`);
        }
      } else {
        hard.push('LLM接口实测跳过: api_url/model/api_key 不完整');
        liveLines.push('liveLLM: SKIP api_url/model/api_key 不完整');
      }
      const liveSearch = await webSearch(
        '玩机器Machine 萌娘百科 6657',
        Math.max(ai.knowledge_source_timeout_ms || ai.search_timeout_ms || 1800, 1200),
        ai.search_cache_seconds ?? 300,
        ai.search_negative_cache_seconds ?? 60,
      );
      liveLines.push(`live搜索: ${liveSearch ? 'OK ' + liveSearch.slice(0, 80) : '失败/空结果'}`);
      try {
        fs.accessSync(paths.knowledgeDir, fs.constants.W_OK);
        liveLines.push('live写盘: knowledge目录可写');
      } catch {
        hard.push('knowledge目录不可写，自动审计/主库写入/日志会失败');
      }
      liveLines.push(`live${storage.summary}`);
      liveLines.push(`live图片缓存: ${image.count}/${image.maxFiles}张 ${image.sizeMB}/${image.maxSizeMB}MB inFlight=${image.inFlight}${image.lastError ? ` 最近错误=${image.lastError}` : ''}`);
      liveLines.push(`liveTTS: ${voice.provider}${voice.localReady ? '/local-ready' : ''} clone=${voice.cloneEnabled ? (voice.cloneReady ? 'ready' : 'missing') : 'off'} cache=${voice.cacheFiles}/${voice.maxCacheFiles} ${voice.sizeMB}/${voice.maxCacheMB}MB inFlight=${voice.inFlight} 合并${voice.inFlightHits}`);
      liveLines.push(`liveSTT: ${stt.provider}${stt.localReady ? '/local-ready' : ''} payload=${stt.payloadMode}/${stt.lastPayloadMode || '-'} cache=${stt.cacheFiles}/${stt.maxCacheFiles} ${stt.sizeMB}/${stt.maxCacheMB}MB inFlight=${stt.inFlight} 合并${stt.inFlightHits}`);
    }

    ctx.reply([
      '严格自检',
      liveMode ? '模式: live' : '模式: quick',
      `OK: ${ok.length}`,
      ...ok.slice(0, 8).map((item) => `+ ${item}`),
      `硬伤: ${hard.length}`,
      ...(hard.length > 0 ? hard.map((item) => `! ${item}`) : ['! 暂无硬伤']),
      `风险: ${risk.length}`,
      ...(risk.length > 0 ? risk.slice(0, 8).map((item) => `- ${item}`) : ['- 暂无明显风险']),
      `建议: ${suggestions.length}`,
      ...suggestions.slice(0, 5).map((item) => `? ${item}`),
      storage.summary,
      ...storage.failed.slice(0, 5).map((item) => `写盘失败: ${item.label} ${item.rel} ${item.error}`),
      `知识审计: ${audit.sections}块 ${audit.chars}字 问题${audit.issues.length} 主库分层`,
      `OneBot: ${runtime.readyState} connected=${runtime.connected ? 'yes' : 'no'} pendingApi=${runtime.pendingApi} frames=${runtime.framesReceived} events=${runtime.eventsReceived} 断开${runtime.totalDisconnects} 早断${runtime.consecutiveEarlyDisconnects} 心跳重连${runtime.staleHeartbeatReconnects}`,
      ...(runtime.lastConnectionHint ? [`连接提示: ${runtime.lastConnectionHint}`] : []),
      `QQ登录: ${runtime.lastLoginOk ? 'ok' : '异常/未确认'} self=${runtime.lastLoginUserId || '-'} 失败${runtime.loginCheckFailures} 成功${runtime.loginCheckSuccesses}${runtime.lastLoginError ? ` 错误=${runtime.lastLoginError}` : ''}`,
      `队列: ${aiStats.pendingJobs}待处理 / ${aiStats.forcedJobs}强触发`,
      `并发: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 听写${aiStats.gates.stt.active}/${aiStats.gates.stt.limit}+${aiStats.gates.stt.queued} TTS${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
      `Gate背压: 普通拒绝AI${aiStats.gates.ai.rejectedPassive} 搜索${aiStats.gates.search.rejectedPassive} 图${aiStats.gates.vision.rejectedPassive} 听写${aiStats.gates.stt.rejectedPassive} TTS${aiStats.gates.tts.rejectedPassive}`,
      `AI缓存: ${aiStats.replyCacheEntries}条 ${aiStats.replyCacheHits}/${aiStats.replyCacheMisses} 策略${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`,
      `回复真实性: 证据${aiStats.evidenceTraceCount} 无实时${aiStats.realtimeIntentWithoutDataCount} 旧证据${aiStats.realtimeStaleEvidenceCount} 事实修正${aiStats.factGuardRepairCount} 质量修复${aiStats.qualityRepairCount} 输出修复${aiStats.outputRepairCount} 新鲜度${aiStats.freshnessRepairCount}`,
      ...(aiStats.lastRealtimeFreshness.length > 0 ? [`最近实时证据: ${aiStats.lastRealtimeFreshness.join(' / ').slice(0, 160)}`] : []),
      `搜索缓存: ${search.cacheEntries}/${search.maxEntries}条 空${search.negativeEntries} ${search.hits}/${search.misses} 飞行${search.inFlight}`,
      `图片缓存: ${image.count}/${image.maxFiles}张 ${image.sizeMB}/${image.maxSizeMB}MB 单图${image.maxFileMB}MB 跳转${image.maxRedirects} 清理${image.cleanupIntervalMinutes}m ${image.hits}/${image.misses} 失败${image.downloadFailures} 飞行${image.inFlight}`,
      ...(image.lastError ? [`图片最近错误: ${image.lastError}`] : []),
      `听写: ${stt.enabled ? 'on' : 'off'} ${stt.provider}${stt.localReady ? '/local' : ''} payload=${stt.payloadMode}/${stt.lastPayloadMode || '-'} record=${stt.recordFormat} 缓存${stt.cacheFiles}/${stt.maxCacheFiles}条 ${stt.sizeMB}/${stt.maxCacheMB}MB ${stt.hits}/${stt.misses} 飞行${stt.inFlight} 合并${stt.inFlightHits} 本地${stt.localRuns} API${stt.apiRuns} 下载失败${stt.downloadMisses} 空转写${stt.transcriptMisses}`,
      ...(stt.lastError ? [`听写最近错误: ${stt.lastError}`] : []),
      `语音: ${voice.provider}${voice.localReady ? '/local' : ''} send=${voice.sendMode} 缓存${voice.cacheFiles}/${voice.maxCacheFiles}条 ${voice.sizeMB}/${voice.maxCacheMB}MB ${voice.hits}/${voice.misses} 飞行${voice.inFlight} 合并${voice.inFlightHits} 本地${voice.localRuns} API${voice.apiRuns} 克隆${voice.cloneEnabled ? (voice.cloneReady ? 'ready' : 'missing') : 'off'} 样本${voice.sampleSizeMB}MB`,
      ...(voice.lastMode ? [`语音最近模式: ${voice.lastMode}`] : []),
      ...(voice.lastError ? [`语音最近错误: ${voice.lastError}`] : []),
      ...liveLines,
    ].join('\n'));
    return true;
  },
};

export const __test = {
  setCsDataHealthCheckerForTests(checker?: () => Promise<CsDataHealth>): void {
    csDataHealthChecker = checker || checkCsDataHealth;
  },
};
