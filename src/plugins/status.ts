import { Plugin } from '../types';
import { getAiChatStats } from './ai-chat';
import { getCacheStats } from './image-cache';
import { getKnowledgeStats } from './knowledge-base';
import { getSearchStats } from './web-search';
import { getSttStats } from './stt';
import { getVoiceStats } from './tts';

const startTime = Date.now();

export const statusPlugin: Plugin = {
  name: 'status',
  description: '查看机器人运行状态',
  handler: (ctx) => {
    if (ctx.command === 'status') {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;

      const memUsage = process.memoryUsage();
      const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
      const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);
      const config = ctx.bot.getConfig();
      const imageStats = getCacheStats();
      const searchStats = getSearchStats();
      const voiceStats = getVoiceStats(config.ai);
      const sttStats = getSttStats(config.ai);
      const knowledgeStats = getKnowledgeStats();
      const aiStats = getAiChatStats();
      const lastRefresh = knowledgeStats.lastAutoRefreshAt
        ? new Date(knowledgeStats.lastAutoRefreshAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '无';

      const statusText = [
        '🤖 运行状态',
        '',
        `⏱ 运行: ${hours}h ${minutes}m ${seconds}s`,
        `💾 内存: heap ${memMB} MB / rss ${rssMB} MB`,
        `🆔 Bot: self_id ${ctx.event.self_id} / 配置 ${config.bot_qq || '未填写'}`,
        `🎭 当前预设: ${config.ai?.active_preset || '无'}`,
        `📚 知识库: ${knowledgeStats.sections}块 ${knowledgeStats.chars}字 词${knowledgeStats.keywords} 候选${knowledgeStats.candidates}`,
        `📖 知识命中: 检索${knowledgeStats.searchHits}/${knowledgeStats.searchMisses} 注入${knowledgeStats.selectHits}/${knowledgeStats.selectMisses}`,
        `🔄 知识自动: ${knowledgeStats.autoEnabled && config.ai?.knowledge_auto_update !== false ? 'on' : 'off'} 最近${lastRefresh} 写入${knowledgeStats.autoCommitted} 主库分层 审计${knowledgeStats.auditIssues} 源状态${knowledgeStats.sourceStates}`,
        `🧠 上下文: ${aiStats.sessions}会话 队列${aiStats.queuedGroups}群 待处理${aiStats.pendingJobs} 强触发${aiStats.forcedJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
        `🚧 并发闸门: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图 ${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 听写 ${aiStats.gates.stt.active}/${aiStats.gates.stt.limit}+${aiStats.gates.stt.queued} 语音 ${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
        `🚧 Gate背压: 普通拒绝 AI${aiStats.gates.ai.rejectedPassive} 搜索${aiStats.gates.search.rejectedPassive} 图${aiStats.gates.vision.rejectedPassive} 听写${aiStats.gates.stt.rejectedPassive} 语音${aiStats.gates.tts.rejectedPassive} 高水位AI${aiStats.gates.ai.highWaterQueued}`,
        `⚡ AI缓存: ${aiStats.replyCacheEntries}条 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses}`,
        `🧩 上下文压缩: 完成${aiStats.completedCompressions} 延后${aiStats.deferredCompressions} 失败${aiStats.failedCompressions}`,
        `🚦 主动接话跳过: ${aiStats.skippedPassiveReplies}`,
        `🔍 搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries}条 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 磁盘${searchStats.diskHits} 飞行${searchStats.inFlight}`,
        `🧾 自动批次: ${knowledgeStats.batches}个 可回滚${knowledgeStats.rollbackableBatches}`,
        `🖼 图片缓存: ${imageStats.count}/${imageStats.maxFiles}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB 单图${imageStats.maxFileMB}MB ${imageStats.maxAgeHours}h 跳转${imageStats.maxRedirects} 清理${imageStats.cleanupIntervalMinutes}m 命中${imageStats.hits}/${imageStats.misses} 失败${imageStats.downloadFailures}`,
        `🧹 图片清理: 最近${imageStats.lastCleanupAt ? new Date(imageStats.lastCleanupAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 删除${imageStats.lastCleanupDeleted} 累计${imageStats.cleanupDeletedTotal}`,
        ...(imageStats.lastError ? [`图片最近错误: ${imageStats.lastError}`] : []),
        `🎧 语音听写: ${sttStats.enabled ? 'on' : 'off'} ${sttStats.provider}${sttStats.localReady ? '/local' : ''} payload=${sttStats.payloadMode}/${sttStats.lastPayloadMode || '-'} record=${sttStats.recordFormat} 缓存${sttStats.cacheFiles}条 ${sttStats.sizeMB}MB 命中${sttStats.hits}/${sttStats.misses} 本地${sttStats.localRuns} API${sttStats.apiRuns} 下载失败${sttStats.downloadMisses} 空转写${sttStats.transcriptMisses}`,
        `🔊 语音: ${voiceStats.provider}${voiceStats.localReady ? '/local' : ''} send=${voiceStats.sendMode} 缓存${voiceStats.cacheFiles}条 ${voiceStats.sizeMB}MB 命中${voiceStats.hits}/${voiceStats.misses} 本地${voiceStats.localRuns} API${voiceStats.apiRuns} 克隆${voiceStats.cloneEnabled ? (voiceStats.cloneReady ? 'ready' : 'missing') : 'off'}`,
        ...(voiceStats.lastMode ? [`🔊 最近TTS模式: ${voiceStats.lastMode}`] : []),
        ...(voiceStats.lastError ? [`🔊 语音最近错误: ${voiceStats.lastError}`] : []),
        `📦 Node ${process.version}`,
      ].join('\n');

      ctx.reply(statusText);
      return true;
    }
    return false;
  },
};
