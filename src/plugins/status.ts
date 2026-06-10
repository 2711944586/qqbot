import { Plugin } from '../types';
import { CONFIG_VERSION } from '../config';
import { getAiChatStats, getMediaObservabilitySnapshot } from './ai-chat';
import { getCacheStats } from './image-cache';
import { getKnowledgeStats } from './knowledge-base';
import { getSearchStats } from './web-search';
import { getSttStats } from './stt';
import { getVoiceStats } from './tts';
import { getHltvStats } from './hltv-api';
import { getCsReportStats } from './cs-report';
import { getDailyPulseStats } from './daily-pulse';
import { getCsWatchStats } from './cs-watch';
import { getCsPredictStats } from './cs-predict';
import { getGiftThanksStats } from './gift-thanks';
import { getStickerStats } from './stickers';
import { getUserProfileStats } from './user-profile';

const startTime = Date.now();

function formatTime(timestamp: number): string {
  if (!timestamp) return '无';
  return new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

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
      const hltvStats = getHltvStats();
      const reportStats = getCsReportStats();
      const dailyPulseStats = getDailyPulseStats();
      const watchStats = getCsWatchStats();
      const predictStats = getCsPredictStats();
      const giftStats = getGiftThanksStats();
      const stickerStats = getStickerStats();
      const profileStats = getUserProfileStats();
      const knowledgeStats = getKnowledgeStats();
      const aiStats = getAiChatStats();
      const mediaStats = getMediaObservabilitySnapshot();
      const runtime = ctx.bot.getRuntimeStats();
      const lastRefresh = knowledgeStats.lastAutoRefreshAt
        ? new Date(knowledgeStats.lastAutoRefreshAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '无';

      const statusText = [
        '🤖 运行状态',
        '',
        `⏱ 运行: ${hours}h ${minutes}m ${seconds}s`,
        `💾 内存: heap ${memMB} MB / rss ${rssMB} MB`,
        `🆔 Bot: self_id ${ctx.event.self_id} / 配置 ${config.bot_qq || '未填写'}`,
        `🔌 OneBot: ${runtime.readyState} connected=${runtime.connected ? 'yes' : 'no'} pendingApi=${runtime.pendingApi} 断开${runtime.totalDisconnects} 早断${runtime.consecutiveEarlyDisconnects} 心跳重连${runtime.staleHeartbeatReconnects} 重连=${runtime.reconnectScheduled ? Math.round(runtime.reconnectIntervalMs / 1000) + 's' : '无'}`,
        `🔐 QQ登录: ${runtime.lastLoginOk ? 'ok' : '异常/未确认'} self=${runtime.lastLoginUserId || '-'} ${runtime.lastLoginNickname || ''} 检查${formatTime(runtime.lastLoginCheckAt)} OK${formatTime(runtime.lastLoginOkAt)} 失败${runtime.loginCheckFailures} 成功${runtime.loginCheckSuccesses}${runtime.lastLoginError ? ` 错误=${runtime.lastLoginError}` : ''}`,
        `📨 事件: frames=${runtime.framesReceived} events=${runtime.eventsReceived} 最后帧${formatTime(runtime.lastFrameAt)} 最后事件${formatTime(runtime.lastEventAt)}`,
        `📤 发送/API: 群${runtime.groupSendAttempts - runtime.groupSendFailures}/${runtime.groupSendAttempts} 私聊${runtime.privateSendAttempts - runtime.privateSendFailures}/${runtime.privateSendAttempts} API ${runtime.apiResponses}/${runtime.apiCalls} timeout=${runtime.apiTimeouts} fail=${runtime.apiFailures}`,
        ...(runtime.lastDisconnectedAt ? [`🔌 最近断开: ${formatTime(runtime.lastDisconnectedAt)} code=${runtime.lastDisconnectCode}${runtime.lastDisconnectReason ? ` reason=${runtime.lastDisconnectReason}` : ''}`] : []),
        ...(runtime.lastError ? [`🔌 最近WS错误: ${runtime.lastError}`] : []),
        ...(runtime.lastConnectionHint ? [`🔌 连接提示: ${runtime.lastConnectionHint}`] : []),
        `🧾 配置版本: ${config.config_version || '未填写'} / ${CONFIG_VERSION}${(config.config_version || 0) < CONFIG_VERSION ? ' 偏旧' : ''}`,
        `🎭 当前预设: ${config.ai?.active_preset || '无'}`,
        `📚 知识库: ${knowledgeStats.sections}块 ${knowledgeStats.chars}字 词${knowledgeStats.keywords} 候选${knowledgeStats.candidates}`,
        `📖 知识命中: 检索${knowledgeStats.searchHits}/${knowledgeStats.searchMisses} 注入${knowledgeStats.selectHits}/${knowledgeStats.selectMisses}`,
        `📚 知识DB: ${knowledgeStats.dbMode} ${knowledgeStats.dbSections}块 命中${knowledgeStats.dbHits}/${knowledgeStats.dbMisses} 查询${knowledgeStats.dbQueries}${knowledgeStats.dbLastError ? ` 错误=${knowledgeStats.dbLastError}` : ''}`,
        ...(aiStats.lastKnowledgeTitles.length > 0 ? [`📖 最近知识分区: ${aiStats.lastKnowledgeTitles.join(' / ')}`] : []),
        `🧠 记忆/RAG: ${aiStats.memoryEnabled ? 'on' : 'off'} 会话${aiStats.memory.sessionsInMemory}/${aiStats.memory.maxSessionsInMemory} 磁盘${aiStats.memory.diskSessions} 索引${aiStats.memory.totalIndexed}条 检索${aiStats.memory.hits}/${aiStats.memory.misses} 查询${aiStats.memory.queries}`,
        `🧑 用户画像: ${profileStats.cached ? 'warm' : 'cold'} ${profileStats.profiles}条 命中${profileStats.cacheHits}/${profileStats.diskReads} 写入${profileStats.diskWrites} 解析错${profileStats.parseErrors}${profileStats.lastError ? ` 错误=${profileStats.lastError.slice(0, 48)}` : ''}`,
        `🔄 知识自动: ${knowledgeStats.autoEnabled && config.ai?.knowledge_auto_update !== false ? 'on' : 'off'} ${aiStats.knowledgeAutoRunning ? '刷新中' : '空闲'} 间隔${aiStats.knowledgeAutoIntervalMinutes || config.ai?.knowledge_auto_interval_minutes || '-'}m 最近${lastRefresh} 写入${knowledgeStats.autoCommitted} 主库分层 审计${knowledgeStats.auditIssues} 源状态${knowledgeStats.sourceStates}`,
        `🧠 上下文: ${aiStats.sessions}会话 队列${aiStats.queuedGroups}群 待处理${aiStats.pendingJobs} 强触发${aiStats.forcedJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
        `🚧 并发闸门: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图 ${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 听写 ${aiStats.gates.stt.active}/${aiStats.gates.stt.limit}+${aiStats.gates.stt.queued} 语音 ${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
        `🚧 Gate背压: 普通拒绝 AI${aiStats.gates.ai.rejectedPassive} 搜索${aiStats.gates.search.rejectedPassive} 图${aiStats.gates.vision.rejectedPassive} 听写${aiStats.gates.stt.rejectedPassive} 语音${aiStats.gates.tts.rejectedPassive} 高水位AI${aiStats.gates.ai.highWaterQueued}`,
        `⚡ AI回复缓存: ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries}条 飞行${aiStats.replyInFlight} 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses} 旁路${aiStats.replyCacheBypasses}`,
        `⚡ AI缓存策略Top: ${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`,
        `🛡 回复真实性: 证据${aiStats.evidenceTraceCount} 无实时${aiStats.realtimeIntentWithoutDataCount} 旧证据${aiStats.realtimeStaleEvidenceCount} 事实修正${aiStats.factGuardRepairCount} 质量修复${aiStats.qualityRepairCount} 输出修复${aiStats.outputRepairCount} 新鲜度${aiStats.freshnessRepairCount}${aiStats.lastFactGuard ? ` 最近=${aiStats.lastFactGuard.slice(0, 48)}` : ''}`,
        ...(aiStats.lastEvidenceLedger.length > 0 ? [`🛡 最近证据账本: ${aiStats.lastEvidenceLedger.join(' / ').slice(0, 180)}`] : []),
        ...(aiStats.lastRealtimeFreshness.length > 0 ? [`🛡 最近实时证据: ${aiStats.lastRealtimeFreshness.join(' / ').slice(0, 160)}`] : []),
        `🎛 风格场景: ${aiStats.styleSceneTraceCount}条 最近${aiStats.lastStyleScene || '无'}${aiStats.lastStyleSceneAction ? ` / ${aiStats.lastStyleSceneAction.slice(0, 42)}` : ''} Top ${aiStats.styleSceneTop.join(' / ') || '无'} 质量风险${aiStats.qualityIssueTraceCount}${aiStats.lastQualityIssues.length ? ` 最近=${aiStats.lastQualityIssues.join('/')}` : ''}`,
        `🧩 上下文压缩: 完成${aiStats.completedCompressions} 延后${aiStats.deferredCompressions} 失败${aiStats.failedCompressions}`,
        `🚦 主动接话跳过: ${aiStats.skippedPassiveReplies}`,
        `🗣 开头去重: 最近${aiStats.lastOpenerDeduped ? '触发过' : '未触发'}`,
        `🗣 真人停顿: ${aiStats.humanReplyDelayCount}次 avg=${aiStats.humanReplyDelayAvgMs}ms 最近=${aiStats.lastHumanReplyDelayMs}ms`,
        `🔍 搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries}条 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 磁盘${searchStats.diskHits} 飞行${searchStats.inFlight}`,
        `🎮 CS实时缓存: ${hltvStats.entries}条 stale${hltvStats.staleEntries} 命中${hltvStats.hits}/${hltvStats.misses} 磁盘${hltvStats.diskHits}/${hltvStats.diskEntriesLoaded} 写入${hltvStats.writes} 过期${hltvStats.expired} 兜底${hltvStats.staleServed} 飞行${hltvStats.inFlight} 合并${hltvStats.inFlightHits} 失败${hltvStats.failures}`,
        ...(hltvStats.lastDiskError ? [`🎮 CS磁盘缓存错误: ${hltvStats.lastDiskError}`] : []),
        `🗞 CS日报: ${reportStats.subscriptions}个 群${reportStats.groupChats} 私聊${reportStats.privateChats} timer=${reportStats.timerEnabled ? 'on' : 'off'} running=${reportStats.running} 最近${formatTime(reportStats.lastRunAt)} 检查${reportStats.lastRunChecked} 预热${reportStats.lastPrewarmChecked}/${reportStats.lastPrewarmTargets} OK${reportStats.lastPrewarmOk} 推送${reportStats.lastRunSent} 底稿${reportStats.baseReportCacheWarm ? `warm ttl=${reportStats.baseReportCacheTtlSeconds}s` : 'cold'} 命中${reportStats.baseReportCacheHits}/${reportStats.baseReportCacheMisses} 合并${reportStats.baseReportInFlightHits}${reportStats.lastRunError || reportStats.lastPrewarmError ? ` 错误=${reportStats.lastRunError || reportStats.lastPrewarmError}` : ''}`,
        `🌅 每日提醒: ${dailyPulseStats.subscriptions}个 群${dailyPulseStats.groupChats} 私聊${dailyPulseStats.privateChats} 打卡${dailyPulseStats.checkins} 今日${dailyPulseStats.todayCheckins} 最佳${dailyPulseStats.bestStreak}天 挑战完成${dailyPulseStats.challengeCompletions} 今日${dailyPulseStats.todayChallengeCompletions} 最佳${dailyPulseStats.bestChallengeStreak}天 timer=${dailyPulseStats.timerEnabled ? 'on' : 'off'} running=${dailyPulseStats.running} 最近${formatTime(dailyPulseStats.lastRunAt)} 检查${dailyPulseStats.lastRunChecked} 推送${dailyPulseStats.lastRunSent}${dailyPulseStats.lastRunError ? ` 错误=${dailyPulseStats.lastRunError}` : ''}`,
        `🎯 CS订阅: ${watchStats.subscriptions}个 群${watchStats.groupChats} 私聊${watchStats.privateChats} timer=${watchStats.timerEnabled ? 'on' : 'off'} running=${watchStats.running} 最近${formatTime(watchStats.lastRunAt)} 检查${watchStats.lastRunChecked} 提醒${watchStats.lastRunNotifications} 开赛${watchStats.lastRunStartReminders || 0} 阵容${watchStats.lastRunRosterChanges || 0} 地图${watchStats.lastRunMapChanges || 0} 选手${watchStats.lastRunPlayerChanges || 0}${watchStats.lastRunError ? ` 错误=${watchStats.lastRunError}` : ''}`,
        `🎲 CS竞猜: 盘口${predictStats.markets} 开${predictStats.openMarkets} 封${predictStats.closedMarkets} 结${predictStats.settledMarkets} 取消${predictStats.cancelledMarkets} 预测${predictStats.predictions} 积分${predictStats.scoreEntries} 地图${predictStats.mapStats} 赛事${predictStats.eventStats} 赛季${predictStats.activeSeasons}/${predictStats.seasons} timer=${predictStats.timerEnabled ? 'on' : 'off'} running=${predictStats.running} 最近${formatTime(predictStats.lastRunAt || predictStats.lastSettledAt)} 检查${predictStats.lastRunChecked} 结算${predictStats.lastRunSettled} 推送${predictStats.lastRunSent} 候选提醒${predictStats.candidateNotifySubscriptions} 最近${formatTime(predictStats.lastCandidateRunAt)} 检查${predictStats.lastCandidateRunChecked}/${predictStats.lastCandidateRunDue} 推送${predictStats.lastCandidateRunSent}${predictStats.lastRunError || predictStats.lastCandidateRunError ? ` 错误=${predictStats.lastRunError || predictStats.lastCandidateRunError}` : ''}`,
        `🎁 礼物感谢: 收到${giftStats.totalGiftNotices} 已谢${giftStats.sentThanks} 节流${giftStats.throttledThanks} 忽略${giftStats.ignoredThanks} 语音${giftStats.giftVoiceSent}/${giftStats.giftVoiceAttempts} 失败${giftStats.giftVoiceFailures} 记录${giftStats.recentTraces} 最近${giftStats.lastGiftTrace ? `${formatTime(giftStats.lastGiftTrace.timestamp)} ${giftStats.lastGiftTrace.action}/${giftStats.lastGiftTrace.reason} voice=${giftStats.lastGiftTrace.voiceAction}` : '无'}`,
        `🎥 多模态真实链路: 今日实跑${mediaStats.todayRuns} 图${mediaStats.visionTraces}/${mediaStats.maxVisionTraces} 语音${mediaStats.voiceTraces}/${mediaStats.maxVoiceTraces} 回复${mediaStats.replyTraces}/${mediaStats.maxReplyTraces} 礼物${mediaStats.giftTraces} | 图=${mediaStats.lastVisionSummary.slice(0, 90)} | 听写=${mediaStats.lastRecordSummary.slice(0, 90)} | 语音=${mediaStats.lastVoiceSummary.slice(0, 90)}`,
        `🎥 多模态边界: ${mediaStats.boundary} ${mediaStats.hint}`,
        `🎭 贴纸: 自动${stickerStats.autoReplies} 标签${stickerStats.markerReplies} 节流${stickerStats.throttledAutoReplies} 跳过${stickerStats.skippedAutoReplies} 规则${stickerStats.rules} 本地${stickerStats.localStickers} 冷却群${stickerStats.groupCooldowns}/词${stickerStats.keywordCooldowns}`,
        ...(hltvStats.lastError ? [`🎮 CS最近错误: ${hltvStats.lastError}`] : []),
        `🧾 自动批次: ${knowledgeStats.batches}个 可回滚${knowledgeStats.rollbackableBatches}`,
        `🖼 图片缓存: ${imageStats.count}/${imageStats.maxFiles}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB 单图${imageStats.maxFileMB}MB ${imageStats.maxAgeHours}h 跳转${imageStats.maxRedirects} 清理${imageStats.cleanupIntervalMinutes}m 命中${imageStats.hits}/${imageStats.misses} 失败${imageStats.downloadFailures} 飞行${imageStats.inFlight}`,
        `🧹 图片清理: 最近${imageStats.lastCleanupAt ? new Date(imageStats.lastCleanupAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 删除${imageStats.lastCleanupDeleted} 累计${imageStats.cleanupDeletedTotal}`,
        ...(imageStats.lastError ? [`图片最近错误: ${imageStats.lastError}`] : []),
        `🎧 语音听写: ${sttStats.enabled ? 'on' : 'off'} ${sttStats.provider}${sttStats.localReady ? '/local' : ''} payload=${sttStats.payloadMode}/${sttStats.lastPayloadMode || '-'} record=${sttStats.recordFormat} 缓存${sttStats.cacheFiles}/${sttStats.maxCacheFiles}条 ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 命中${sttStats.hits}/${sttStats.misses} 飞行${sttStats.inFlight} 合并${sttStats.inFlightHits} 本地${sttStats.localRuns} API${sttStats.apiRuns} 下载失败${sttStats.downloadMisses} 空转写${sttStats.transcriptMisses}`,
        `🧹 听写清理: 最近${sttStats.lastCleanupAt ? new Date(sttStats.lastCleanupAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 删除${sttStats.lastCleanupDeleted} 累计${sttStats.cleanupDeletedTotal}`,
        `🔊 语音: ${voiceStats.provider}${voiceStats.localReady ? '/local' : ''} send=${voiceStats.sendMode} 缓存${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles}条 ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB 命中${voiceStats.hits}/${voiceStats.misses} 飞行${voiceStats.inFlight} 合并${voiceStats.inFlightHits} 本地${voiceStats.localRuns} API${voiceStats.apiRuns} 克隆${voiceStats.cloneEnabled ? (voiceStats.cloneReady ? 'ready' : 'missing') : 'off'}`,
        `🧹 语音清理: 最近${voiceStats.lastCleanupAt ? new Date(voiceStats.lastCleanupAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'} 删除${voiceStats.lastCleanupDeleted} 累计${voiceStats.cleanupDeletedTotal}`,
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
