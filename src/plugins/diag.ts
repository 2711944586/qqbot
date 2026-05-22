import { Plugin } from '../types';
import { hasUsableApiKey } from '../config';
import { getAiChatStats } from './ai-chat';
import { getCacheStats } from './image-cache';
import { auditKnowledge, getKnowledgeRuntimePaths, getKnowledgeStats, loadKnowledgeSources } from './knowledge-base';
import { getSearchStats, webSearch } from './web-search';
import { getSttStats } from './stt';
import { getVoiceStats } from './tts';
import * as fs from 'fs';

export const diagPlugin: Plugin = {
  name: 'diag',
  description: '严格自检诊断',
  handler: async (ctx) => {
    if (ctx.command !== 'diag') return false;

    const config = ctx.bot.getConfig();
    const ai = config.ai;
    const liveMode = (ctx.args[0] || '').toLowerCase() === 'live';
    const isAdmin = config.admin_qq.includes(ctx.event.user_id);
    const hard: string[] = [];
    const risk: string[] = [];
    const suggestions: string[] = [];
    const ok: string[] = [];

    if (hasUsableApiKey(ai.api_key)) ok.push('AI接口已配置');
    else hard.push('AI接口未配置或仍是占位值，/ai、识图、TTS不可用');

    if (ai.enable_search) ok.push('联网搜索已开启');
    else risk.push('联网搜索未开启，实时赛果/阵容/价格会不准');

    if (ai.enable_knowledge) ok.push('知识库已开启');
    else hard.push('知识库未开启，风格和选手倾向会变薄');

    if (ai.enable_vision) ok.push('识图已开启');
    else risk.push('识图未开启，图片只会作为上下文占位');

    const voice = getVoiceStats(ai);
    const stt = getSttStats(ai);
    if (ai.enable_tts) ok.push(`语音已开启(${voice.cloneReady ? 'clone' : 'tts'})`);
    else suggestions.push('语音未开启，/tts 会不可用');
    if (ai.enable_stt) ok.push(`语音听写已开启(${stt.model || '未配置模型'})`);
    else suggestions.push('语音听写未开启，收到语音只能按占位和文字上下文回复');
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
    if (ai.knowledge_quarantine_long_quotes !== false) ok.push('长语录/转写隔离开启');
    else risk.push('长语录/转写隔离关闭，主库污染风险高');

    const audit = auditKnowledge();
    const auditHard = audit.issues.filter((item) => item.level === 'hard').length;
    const auditRisk = audit.issues.filter((item) => item.level === 'risk').length;
    if (auditHard > 0) hard.push(`知识库 hard 问题 ${auditHard} 个`);
    if (auditRisk > 0) risk.push(`知识库 risk 问题 ${auditRisk} 个`);
    if (audit.quarantineFiles > 0) suggestions.push(`隔离候选 ${audit.quarantineFiles} 个，后续可人工整理为摘要`);

    const aiStats = getAiChatStats();
    const search = getSearchStats();
    const image = getCacheStats();
    const liveLines: string[] = [];

    if (liveMode) {
      if (!isAdmin) {
        ctx.replyAt('/diag live 得管理员来跑，别把外网检查当玩具。');
        return true;
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
        hard.push('knowledge目录不可写，自动审计/隔离/日志会失败');
      }
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
      `知识审计: ${audit.sections}块 ${audit.chars}字 问题${audit.issues.length} 隔离${audit.quarantineFiles}`,
      `队列: ${aiStats.pendingJobs}待处理 / ${aiStats.forcedJobs}强触发`,
      `并发: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 听写${aiStats.gates.stt.active}/${aiStats.gates.stt.limit}+${aiStats.gates.stt.queued} TTS${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
      `AI缓存: ${aiStats.replyCacheEntries}条 ${aiStats.replyCacheHits}/${aiStats.replyCacheMisses}`,
      `搜索缓存: ${search.cacheEntries}/${search.maxEntries}条 空${search.negativeEntries} ${search.hits}/${search.misses} 飞行${search.inFlight}`,
      `图片缓存: ${image.count}张 ${image.sizeMB}/${image.maxSizeMB}MB 单图${image.maxFileMB}MB ${image.hits}/${image.misses}`,
      `听写: ${stt.enabled ? 'on' : 'off'} 缓存${stt.cacheFiles}条 ${stt.hits}/${stt.misses} 下载失败${stt.downloadMisses} 空转写${stt.transcriptMisses}`,
      ...(stt.lastError ? [`听写最近错误: ${stt.lastError}`] : []),
      `语音: 缓存${voice.cacheFiles}条 ${voice.hits}/${voice.misses} 克隆${voice.cloneEnabled ? (voice.cloneReady ? 'ready' : 'missing') : 'off'} 样本${voice.sampleSizeMB}MB`,
      ...(voice.lastError ? [`语音最近错误: ${voice.lastError}`] : []),
      ...liveLines,
    ].join('\n'));
    return true;
  },
};
