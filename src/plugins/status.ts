import { Plugin } from '../types';
import { getAiChatStats } from './ai-chat';
import { getCacheStats } from './image-cache';
import { getKnowledgeStats } from './knowledge-base';
import { getSearchStats } from './web-search';
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
        `🔄 知识自动: ${knowledgeStats.autoEnabled && config.ai?.knowledge_auto_update !== false ? 'on' : 'off'} 最近${lastRefresh} 写入${knowledgeStats.autoCommitted} 隔离${knowledgeStats.quarantineFiles} 审计${knowledgeStats.auditIssues} 源状态${knowledgeStats.sourceStates}`,
        `🧠 上下文: ${aiStats.sessions}会话 队列${aiStats.queuedGroups}群 待处理${aiStats.pendingJobs} 强触发${aiStats.forcedJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
        `🚧 并发闸门: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图 ${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 语音 ${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
        `⚡ AI缓存: ${aiStats.replyCacheEntries}条 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses}`,
        `🚦 主动接话跳过: ${aiStats.skippedPassiveReplies}`,
        `🔍 搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries}条 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 磁盘${searchStats.diskHits} 飞行${searchStats.inFlight}`,
        `🧾 自动批次: ${knowledgeStats.batches}个 可回滚${knowledgeStats.rollbackableBatches}`,
        `🖼 图片缓存: ${imageStats.count}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB 单图${imageStats.maxFileMB}MB ${imageStats.maxAgeHours}h 命中${imageStats.hits}/${imageStats.misses}`,
        `🔊 语音: 缓存${voiceStats.cacheFiles}条 ${voiceStats.sizeMB}MB 命中${voiceStats.hits}/${voiceStats.misses} 克隆${voiceStats.cloneEnabled ? (voiceStats.cloneReady ? 'ready' : 'missing') : 'off'}`,
        `📦 Node ${process.version}`,
      ].join('\n');

      ctx.reply(statusText);
      return true;
    }
    return false;
  },
};
