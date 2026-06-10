import { CONFIG_VERSION, hasUsableApiKey, loadConfig, updateConfigFile } from '../config';
import { BotConfig, Plugin, PluginContext } from '../types';
import {
  clearAiSessionMemory,
  dropAiSessionMemoryByUser,
  dropAiSessionMemoryByQuery,
  formatReplyCachePoolStatus,
  formatReplyCachePreflight,
  filterMemoryTruthRisk,
  extractMediaCheckSources,
  extractVisionCheckSources,
  formatMediaCacheWarm,
  formatVisionCacheWarm,
  formatVoiceCacheWarm,
  getAiChatStats,
  getMediaWarmupCandidates,
  getMediaObservabilitySnapshot,
  getMemoryDiagnostics,
  getRecentSessionMemory,
  inspectAiSessionMemoryByUser,
  pruneExpiredReplyCacheForMaintenance,
  searchSessionMemory,
  startAiChatBackgroundTasks,
  trimAiSessionMemory,
} from './ai-chat';
import { cleanupCache as cleanImageCache, getCacheStats as getImageCacheStats, getImageDataUrl, inspectImageCacheSources } from './image-cache';
import { auditKnowledge, getKnowledgeStats, pruneKnowledgeAutoLog } from './knowledge-base';
import { cleanSttCache, getSttStats } from './stt';
import { cleanVoiceCache, generateVoice, getVoiceStats, inspectVoiceCache } from './tts';
import { cleanSearchCache, getSearchStats } from './web-search';
import { clearHltvCache, getHltvStats } from './hltv-api';
import { detectFuzzyCommand } from './fuzzy-command';
import { getUserProfileStats } from './user-profile';
import { formatStorageBytes, inspectRuntimeStorage, inspectRuntimeStoreFiles } from './runtime-storage';
import { buildCsPrewarmReport } from './cs-prewarm';
import { withGate } from './concurrency';
import { resolveOneBotImageSources, resolveOneBotRecordSources, uniqueNonEmpty } from './media-utils';
import { getGiftWarmupCandidates, warmGiftThanksVoice } from './gift-thanks';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

function formatDate(timestamp: number): string {
  if (!timestamp) return '无';
  return new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function isMaintCommand(command: string | null): boolean {
  return command === 'maint' || command === 'maintenance' || command === '维护';
}

function formatLoginTime(timestamp: number): string {
  if (!timestamp) return '无';
  return new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function sessionIdForContext(ctx: Parameters<Plugin['handler']>[0]): string {
  return ctx.isPrivate
    ? `private_${ctx.event.user_id}`
    : `group_${ctx.groupId}`;
}

function cleanMemoryLine(text: string, maxChars: number): string {
  return text
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function normalizeMemoryCompareText(text: string): string {
  return (text || '')
    .replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '')
    .replace(/^[^:：\n]{1,32}[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMemoryAge(seconds: number | undefined): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function parseTargetUserId(value: string): number {
  const match = (value || '').match(/\d+/);
  const parsed = match ? Number(match[0]) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function formatHitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total <= 0) return '暂无样本';
  return `${Math.round((hits / total) * 100)}%`;
}

function formatUsagePercent(current: number, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return 'n/a';
  return `${Math.round((current / max) * 100)}%`;
}

function formatMemoryPressure(heapUsed: number, heapTotal: number, rss: number): string {
  const heapRatio = heapTotal > 0 ? heapUsed / heapTotal : 0;
  const rssMB = rss / 1024 / 1024;
  if (heapRatio >= 0.88 || rssMB >= 900) return 'high';
  if (heapRatio >= 0.72 || rssMB >= 650) return 'medium';
  return 'low';
}

function formatProjectDiskLine(): string {
  try {
    if (typeof fs.statfsSync !== 'function') return '磁盘: 当前 Node/平台不支持 statfs';
    const stats = fs.statfsSync(process.cwd());
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedPercent = totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 100) : 0;
    return `磁盘: ${formatStorageBytes(freeBytes)} 空闲 / ${formatStorageBytes(totalBytes)} 总量 使用${usedPercent}%`;
  } catch (err) {
    return `磁盘: 检查失败 ${err instanceof Error ? err.message : String(err)}`;
  }
}

function isCsWarmScope(scope: string): boolean {
  return ['cs', 'cs2', 'hltv', 'realtime', '实时'].includes(scope);
}

function isMediaWarmScope(scope: string): boolean {
  return ['media', 'multi', 'multimodal', '媒体', '多模态'].includes(scope);
}

function isVisionWarmScope(scope: string): boolean {
  return ['vision', 'image', 'img', 'picture', '识图', '图片'].includes(scope);
}

function isVoiceWarmScope(scope: string): boolean {
  return ['voice', 'tts', 'speech', '语音', '说话'].includes(scope);
}

function isGiftWarmScope(scope: string): boolean {
  return ['gift', 'thanks', 'thank', '礼物', '谢礼物', '感谢'].includes(scope);
}

function aiApiReady(config: BotConfig['ai']): boolean {
  return hasUsableApiKey(config.api_key) && !!config.api_url && !!config.model;
}

function ttsNeedsApi(config: BotConfig['ai']): boolean {
  const provider = config.tts_provider || 'api';
  const localReady = !!(config.tts_local_command || '').trim() && (provider === 'local' || provider === 'auto');
  return provider === 'api' || (provider === 'auto' && !localReady);
}

function parseGiftWarmArgs(args: string[]): { gift: string; count: number } {
  const copied = [...args];
  let count = 1;
  const last = copied[copied.length - 1] || '';
  const countMatch = last.match(/^(?:x|×)?(\d{1,4})$/i) || last.match(/^(.{1,24})[x×](\d{1,4})$/i);
  if (countMatch) {
    count = Number(countMatch[countMatch.length - 1]) || 1;
    if (countMatch.length === 3 && countMatch[1]) copied[copied.length - 1] = countMatch[1];
    else copied.pop();
  }
  return { gift: copied.join(' ').trim() || '礼物', count };
}

function formatWarmupCandidateLine(index: number, item: { preview: string; status: string; reason: string; command: string; trace: string }): string {
  return `${index}. ${item.status} ${item.preview}\n  来源: ${item.trace}\n  命令: ${item.command}\n  说明: ${item.reason.slice(0, 90)}`;
}

function formatMaintenanceWarmupPlan(config: BotConfig): string {
  const media = getMediaWarmupCandidates(config.ai, 5);
  const gifts = getGiftWarmupCandidates(config.ai, 5);
  const imageLines = media.images.map((item, index) => formatWarmupCandidateLine(index + 1, item));
  const recordLines = media.records.map((item, index) => formatWarmupCandidateLine(index + 1, item));
  const voiceLines = media.voiceTexts.map((item, index) => formatWarmupCandidateLine(index + 1, item));
  const giftLines = gifts.map((item, index) => formatWarmupCandidateLine(index + 1, {
    preview: `${item.gift}x${item.count} | ${item.text}`,
    status: item.status,
    reason: item.reason,
    command: item.command,
    trace: item.trace,
  }));
  const emptyAdvice: string[] = [];
  if (imageLines.length === 0) emptyAdvice.push('最近没有可命令预热的图片URL；发图后跑 /vision recent 或 /trace recent 再看。');
  if (recordLines.length === 0) emptyAdvice.push('最近没有可命令预热的语音URL；发语音后跑 /voice sttcache 或 /media recent 再看。');
  if (voiceLines.length === 0) emptyAdvice.push('最近没有真实 TTS 发送短句；先用 /voice test 或真实语音回复积累 trace。');
  if (giftLines.length === 0) emptyAdvice.push('最近没有真实礼物事件；可先手动 /gift cache <礼物> [数量] 预检模板。');

  return [
    '维护预热候选计划',
    '模式: 只读，只检查最近 trace 和缓存状态；不下载图片、不听写语音、不生成 TTS、不请求 CS 实时源。',
    `trace覆盖: 图片${media.traceCounts.vision} 语音源${media.traceCounts.records} TTS${media.traceCounts.voice} 礼物${gifts.length}`,
    '图片候选:',
    ...(imageLines.length ? imageLines : ['- 暂无']),
    '语音源候选:',
    ...(recordLines.length ? recordLines : ['- 暂无']),
    'TTS短句候选:',
    ...(voiceLines.length ? voiceLines : ['- 暂无']),
    '礼物谢礼候选:',
    ...(giftLines.length ? giftLines : ['- 暂无']),
    ...(emptyAdvice.length ? [`补样建议: ${emptyAdvice.join('；')}`] : []),
    '执行建议: /maint warm apply all 3 会预热图片/TTS/礼物安全候选；只想热短句用 /maint warm apply voice 3；语音源听写仍逐条 /voice stt。',
    '边界: 图片候选用 /maint warm vision 只代表文件缓存可复用；语音源候选的真听写预热是 /voice stt；TTS/礼物预热不调用AI、不发送record；缓存命中不代表事实正确或现实本人语音。',
  ].join('\n');
}

function parseWarmApplyArgs(args: string[]): { scope: string; limit: number } {
  const first = (args[0] || 'all').toLowerCase();
  if (/^\d{1,2}$/.test(first)) return { scope: 'all', limit: Math.max(1, Math.min(Number(first), 8)) };
  const limitRaw = args.find((item) => /^\d{1,2}$/.test(item || '')) || '';
  return {
    scope: first || 'all',
    limit: Math.max(1, Math.min(Number(limitRaw) || 3, 8)),
  };
}

function includesWarmApplyScope(scope: string, kind: 'image' | 'voice' | 'gift' | 'record'): boolean {
  if (['all', '全部', 'safe', '安全'].includes(scope)) return kind !== 'record';
  if (['media', 'multi', 'multimodal', '媒体', '多模态'].includes(scope)) return kind === 'image' || kind === 'record';
  if (['vision', 'image', 'img', 'picture', '图片', '识图'].includes(scope)) return kind === 'image';
  if (['voice', 'tts', 'speech', '语音'].includes(scope)) return kind === 'voice';
  if (['gift', 'thanks', '礼物', '谢礼物', '感谢'].includes(scope)) return kind === 'gift';
  return false;
}

async function applyImageWarmupCandidates(config: BotConfig, limit: number): Promise<string[]> {
  const candidates = getMediaWarmupCandidates(config.ai, limit).images.slice(0, limit);
  let warmed = 0;
  let hit = 0;
  let skipped = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const candidate of candidates) {
    const before = inspectImageCacheSources([candidate.value], 1)[0];
    if (before?.status === 'hit') {
      hit++;
      lines.push(`- hit ${candidate.preview}`);
      continue;
    }
    if (!before || before.kind !== 'remote' || before.status === 'invalid' || before.status === 'too-large') {
      skipped++;
      lines.push(`- skip ${before?.status || 'unknown'} ${candidate.preview}`);
      continue;
    }
    const dataUrl = await withGate('vision', () => getImageDataUrl(candidate.value), true);
    const after = inspectImageCacheSources([candidate.value], 1)[0];
    if (dataUrl && after?.status === 'hit') {
      warmed++;
      lines.push(`- warmed ${candidate.preview} -> hit key=${after.cacheKey}`);
    } else {
      failed++;
      const stats = getImageCacheStats();
      lines.push(`- fail ${candidate.preview} ${stats.lastError || after?.reason || 'unknown'}`.slice(0, 180));
    }
  }
  return [
    `图片: warmed ${warmed} / hit ${hit} / skipped ${skipped} / failed ${failed} / 候选${candidates.length}`,
    ...lines.slice(0, 5),
    lines.length > 5 ? `- ... 还有${lines.length - 5}条图片动作未展示` : '',
  ].filter(Boolean);
}

async function applyTextWarmupCandidates(
  config: BotConfig,
  label: string,
  candidates: Array<{ value: string; preview: string; trace: string }>,
  limit: number,
): Promise<string[]> {
  const selected = candidates.slice(0, limit);
  let generated = 0;
  let hit = 0;
  let skipped = 0;
  let failed = 0;
  const lines: string[] = [];
  const apiReady = aiApiReady(config.ai);
  for (const candidate of selected) {
    const before = inspectVoiceCache(config.ai, [candidate.value]).parts[0];
    if (before?.status === 'hit') {
      hit++;
      lines.push(`- hit ${candidate.preview}`);
      continue;
    }
    if (!before || !['miss', 'expired', 'in-flight'].includes(before.status) || (ttsNeedsApi(config.ai) && !apiReady)) {
      skipped++;
      lines.push(`- skip ${before?.status || 'unknown'} ${candidate.preview}`);
      continue;
    }
    const voicePath = await withGate('tts', () => generateVoice(config.ai, candidate.value), true);
    const after = inspectVoiceCache(config.ai, [candidate.value]).parts[0];
    if (voicePath && after?.status === 'hit') {
      generated++;
      lines.push(`- generated ${candidate.preview} -> 预热后=hit`);
    } else {
      failed++;
      const stats = getVoiceStats(config.ai);
      lines.push(`- fail ${candidate.preview} ${stats.lastError || after?.reason || 'unknown'}`.slice(0, 180));
    }
  }
  return [
    `${label}: generated ${generated} / hit ${hit} / skipped ${skipped} / failed ${failed} / 候选${selected.length}`,
    ...lines.slice(0, 5),
    lines.length > 5 ? `- ... 还有${lines.length - 5}条${label}动作未展示` : '',
  ].filter(Boolean);
}

async function formatMaintenanceWarmupApply(config: BotConfig, args: string[]): Promise<string> {
  const { scope, limit } = parseWarmApplyArgs(args);
  const media = getMediaWarmupCandidates(config.ai, limit);
  const gifts = getGiftWarmupCandidates(config.ai, limit);
  const sections: string[] = [];
  if (!['all', '全部', 'safe', '安全', 'media', 'multi', 'multimodal', '媒体', '多模态', 'vision', 'image', 'img', 'picture', '图片', '识图', 'voice', 'tts', 'speech', '语音', 'gift', 'thanks', '礼物', '谢礼物', '感谢'].includes(scope)) {
    return [
      '维护预热候选执行',
      `未知范围: ${scope}`,
      '可用: /maint warm apply [all|media|vision|voice|gift] [条数]',
      '边界: apply 不会自动听写语音源；STT 请明确跑 /voice stt <语音URL>。',
    ].join('\n');
  }
  if (includesWarmApplyScope(scope, 'image')) {
    sections.push(...await applyImageWarmupCandidates(config, limit));
  }
  if (includesWarmApplyScope(scope, 'voice')) {
    sections.push(...await applyTextWarmupCandidates(config, 'TTS短句', media.voiceTexts, limit));
  }
  if (includesWarmApplyScope(scope, 'gift')) {
    sections.push(...await applyTextWarmupCandidates(config, '礼物谢礼', gifts.map((item) => ({
      value: item.text,
      preview: `${item.gift}x${item.count} | ${item.text}`,
      trace: item.trace,
    })), limit));
  }
  const recordCandidates = media.records.slice(0, limit);
  const recordLine = (includesWarmApplyScope(scope, 'record') || scope === 'all')
    ? `语音源: 候选${recordCandidates.length}，apply 不自动下载/听写；真要预热请逐条 /voice stt <语音URL>`
    : '';
  return [
    '维护预热候选执行',
    '模式: 管理员动作；图片会真实下载写缓存，TTS/礼物会真实生成缓存；不会调用AI生成文案，不发送record。',
    `范围: ${scope} limit=${limit}`,
    ...(sections.length ? sections : ['没有命中可执行候选；先跑 /maint warm plan 看最近 trace。']),
    recordLine,
    '后续: /maint warm plan 复查 hit/miss；/media status 看链路；CS 实时证据仍用 /maint warm cs 和 /cs verify。',
    '边界: 缓存 hit 只代表文件/音频可复用，不代表模型已看图、已听音频、文本事实正确或现实主播本人语音。',
  ].filter(Boolean).join('\n');
}

function formatRuntimeStoragePanel(): string {
  const storage = inspectRuntimeStorage();
  const storeFiles = inspectRuntimeStoreFiles();
  const missingFiles = storeFiles.filter((item) => !item.exists && !item.error);
  const errorFiles = storeFiles.filter((item) => !!item.error);
  const directoryLines = storage.probes.map((item) => {
    const state = item.ok ? 'ok' : `FAIL ${item.error}`;
    return `- ${item.key}: ${state} ${item.rel} | ${item.purpose}`;
  });
  const fileLines = storeFiles.map((item) => {
    const state = item.error
      ? `ERROR ${item.error}`
      : item.exists
        ? `${item.isDirectory ? 'dir' : 'file'} ${formatStorageBytes(item.sizeBytes)} mtime=${formatDate(item.mtimeMs)}`
        : 'missing';
    return `- ${item.label}: ${state} | ${item.rel} | ${item.note}`;
  });
  const advice = storage.failed.length > 0
    ? '先修 FAIL 目录的权限、属主和磁盘空间；再跑 npm run doctor、/diag、/maint storage 复核。'
    : missingFiles.length > 0
      ? '目录写盘正常；missing 文件多数是尚未生成、尚未订阅或刚被清理。需要热数据就用 /cs warm plan all、/cs warm all，订阅/画像/训练按功能自然生成。'
      : '目录写盘和关键持久化文件都可见；继续用 /status、/mem health、/cs evidence all 看命中和事实新鲜度。';

  return [
    '运行存储体检',
    '模式: 目录写盘探针会写一个临时小文件后删除；不清缓存、不联网、不调用模型、不改配置。',
    formatProjectDiskLine(),
    storage.summary,
    '目录:',
    ...directoryLines,
    '关键文件:',
    ...fileLines,
    `缺失文件: ${missingFiles.length ? missingFiles.map((item) => item.key).join(' / ') : '无'}`,
    ...(errorFiles.length > 0 ? [`文件错误: ${errorFiles.map((item) => `${item.key}:${item.error}`).join(' / ')}`] : []),
    `行动建议: ${advice}`,
    '边界: missing 不等于没有比赛、没有订阅、没有训练或没有画像；只有 fresh 证据才能支撑当前 CS 事实，stale/miss 仍要走 /cs verify 和 /cs evidence。'
  ].join('\n');
}

function formatMaintenanceRunbookPlan(config: BotConfig, runtime: ReturnType<PluginContext['bot']['getRuntimeStats']>): string {
  const aiStats = getAiChatStats();
  const searchStats = getSearchStats();
  const csStats = getHltvStats();
  const imageStats = getImageCacheStats();
  const voiceStats = getVoiceStats(config.ai);
  const sttStats = getSttStats(config.ai);
  const knowledgeStats = getKnowledgeStats();
  const profileStats = getUserProfileStats();
  const storage = inspectRuntimeStorage();
  const storeFiles = inspectRuntimeStoreFiles();
  const warmupCandidates = getMediaWarmupCandidates(config.ai, 3);
  const giftWarmupCandidates = getGiftWarmupCandidates(config.ai, 3);
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const heapRatio = usage.heapTotal > 0 ? usage.heapUsed / usage.heapTotal : 0;
  const imageUsage = imageStats.maxSizeMB > 0 ? imageStats.sizeMB / imageStats.maxSizeMB : 0;
  const voiceUsage = voiceStats.maxCacheMB > 0 ? voiceStats.sizeMB / voiceStats.maxCacheMB : 0;
  const sttUsage = sttStats.maxCacheMB > 0 ? sttStats.sizeMB / sttStats.maxCacheMB : 0;
  const aiSamples = aiStats.replyCacheHits + aiStats.replyCacheMisses;
  const aiHitRate = aiSamples > 0 ? aiStats.replyCacheHits / aiSamples : 0;
  const missingStoreKeys = storeFiles
    .filter((item) => !item.exists && !item.error)
    .map((item) => item.key);
  const erroredStoreFiles = storeFiles.filter((item) => !!item.error);
  const p0: string[] = [];
  const p1: string[] = [];
  const p2: string[] = [];

  if (!runtime.connected || runtime.consecutiveEarlyDisconnects >= 3 || (runtime.lastLoginCheckAt && !runtime.lastLoginOk)) {
    addPlanItem(
      p0,
      '修 OneBot/QQ 登录链路',
      '/maint login',
      `connected=${runtime.connected ? 'yes' : 'no'} login=${runtime.lastLoginOk ? 'ok' : 'bad'} 早断${runtime.consecutiveEarlyDisconnects} pendingApi=${runtime.pendingApi}${runtime.lastLoginError ? ` 错误=${runtime.lastLoginError.slice(0, 80)}` : ''}`,
      '登录态不稳时其他 AI/CS/语音排障都容易误判；先去 NapCat WebUI 重登或查 ws_url。',
    );
  }
  if ((config.config_version || 0) < CONFIG_VERSION) {
    addPlanItem(
      p0,
      '同步配置模板',
      'npm run config:sync -- --apply；/reload；/maint config',
      `config_version ${config.config_version || '未填写'} < ${CONFIG_VERSION}`,
      '补齐新字段、缓存上限、prompt 和多模态开关，避免代码升级但运行配置停在旧版。',
    );
  }
  if (!hasUsableApiKey(config.ai.api_key)) {
    addPlanItem(
      p0,
      '补真实 API Key',
      '配置 WANJIER_API_KEY 或 config.json ai.api_key；npm run doctor；npm run api:test',
      'AI接口未配置或仍是占位值，远端 AI/识图/TTS/STT 会不可用。',
      '先让基础 AI 链路真通，再看回复风格、语音和识图质量。',
    );
  }
  if (storage.failed.length > 0 || erroredStoreFiles.length > 0) {
    addPlanItem(
      p0,
      '修运行目录写盘',
      '/maint storage；npm run doctor',
      `写盘失败 ${storage.failed.map((item) => item.key).join('/') || '无'} 文件错误 ${erroredStoreFiles.map((item) => item.key).join('/') || '无'}`,
      '写盘失败会直接拖垮上下文、RAG、CS缓存、语音缓存、知识导入和画像持久化。',
    );
  }
  if (!config.ai.enable_knowledge || knowledgeStats.sections < 20) {
    addPlanItem(
      p0,
      '修知识库基础',
      '/kb stats；/kb audit；检查 knowledge/wanjier.md',
      `enable_knowledge=${config.ai.enable_knowledge ? 'on' : 'off'} 分块${knowledgeStats.sections}`,
      '知识库薄或关闭时，风格会退回普通 AI 腔，玩机器口吻和场景锚点都会变弱。',
    );
  }
  if (csStats.staleServed > 0 || csStats.failures > 0) {
    addPlanItem(
      p0,
      '补 CS 当前事实证据',
      '/cs cache prune；/cs warm plan all；/maint warm cs all；/cs verify all',
      `CS失败${csStats.failures} 旧缓存兜底${csStats.staleServed} stale${csStats.staleEntries}`,
      '实时问法只能用 fresh 证据说当前；stale/miss 必须降级并给复核入口。',
    );
  }
  if (heapRatio >= 0.88 || rssMB >= 900 || aiStats.oldestQueueAgeMs > 60_000) {
    addPlanItem(
      p0,
      '处理内存/队列红灯',
      '/mem health；/mem plan；/maint gc',
      `heap ${heapUsedMB}/${heapTotalMB}MB rss ${rssMB}MB 待处理${aiStats.pendingJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
      '先看当前群记忆和全局 gate 是否堵住；必要时裁剪当前会话或手动 GC。',
    );
  }
  if (p0.length === 0) {
    addPlanItem(
      p0,
      '基础链路继续观察',
      '/status；/diag；/maint storage',
      '登录、配置、写盘、知识和内存没有明显 P0 红灯。',
      '先保留热缓存和记忆，用状态面板继续看真实性、命中率和队列变化。',
    );
  }

  if (csStats.entries === 0 || csStats.staleEntries > 0) {
    addPlanItem(
      p1,
      '预热 CS 核心缓存',
      '/cs warm plan all；/maint warm cs all；/cs evidence all',
      `fresh ${csStats.entries} stale ${csStats.staleEntries} missingFiles=${missingStoreKeys.includes('cs-realtime') ? 'cs-realtime' : 'no'}`,
      '减少冷启动等待；预热后仍要以 evidence/verify 的 fresh/stale 结果为准。',
    );
  }
  if (imageUsage >= 0.75 || voiceUsage >= 0.75 || sttUsage >= 0.75 || searchStats.negativeEntries > Math.floor(searchStats.maxEntries * 0.35)) {
    addPlanItem(
      p1,
      '清理高压缓存',
      '/maint clean',
      `图片${imageStats.sizeMB}/${imageStats.maxSizeMB}MB TTS${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB STT${sttStats.sizeMB}/${sttStats.maxCacheMB}MB 搜索空缓存${searchStats.negativeEntries}/${searchStats.maxEntries}`,
      '释放磁盘和坏缓存；会造成下一次图片/语音/搜索冷启动，别在高峰期频繁清。',
    );
  }
  if (knowledgeStats.auditIssues > 0 || knowledgeStats.dbLastError) {
    addPlanItem(
      p1,
      '处理知识库审计',
      '/kb audit；/kb stale 20；/kb sources 20',
      `审计${knowledgeStats.auditIssues}${knowledgeStats.dbLastError ? ` DB=${knowledgeStats.dbLastError.slice(0, 60)}` : ''}`,
      '优先修未核验原话、旧时效事实和来源评级，避免“像真人”时顺手说错事实。',
    );
  }
  if (voiceStats.lastError || sttStats.lastError || imageStats.lastError) {
    addPlanItem(
      p1,
      '复核多模态链路',
      '/media status；/voice status；/vision status；/maint warm media <图片URL/语音URL>',
      `图片=${imageStats.lastError || 'ok'} TTS=${voiceStats.lastError || 'ok'} STT=${sttStats.lastError || 'ok'}`,
      '语音/识图错误要和真实 trace 对上；克隆/授权样本不能说成现实主播本人语音。',
    );
  }
  if (warmupCandidates.images.length > 0 || warmupCandidates.records.length > 0 || warmupCandidates.voiceTexts.length > 0 || giftWarmupCandidates.length > 0) {
    addPlanItem(
      p1,
      '查看热缓存候选',
      '/maint warm plan',
      `候选 图片${warmupCandidates.images.length} 语音源${warmupCandidates.records.length} TTS${warmupCandidates.voiceTexts.length} 礼物${giftWarmupCandidates.length}`,
      '从最近真实 trace 里挑最值得预热的图片、听写源、常用短句和礼物谢礼，先看状态再决定是否写缓存。',
    );
  }
  if (imageStats.misses >= 3 && imageStats.misses > imageStats.hits) {
    addPlanItem(
      p1,
      '预热常用图片缓存',
      '/maint warm media <图片URL或附图>；/vision check <同一图片>',
      `图片命中${imageStats.hits}/${imageStats.misses} 缓存${imageStats.count}/${imageStats.maxFiles}张`,
      '常用图先变 hit，减少识图前的下载等待；hit 只代表文件可复用，识图质量仍要 /vision test。',
    );
  }
  if (voiceStats.misses >= 3 && voiceStats.misses > voiceStats.hits) {
    addPlanItem(
      p1,
      '预热常用语音文案',
      '/maint warm voice <常用短句>；/maint warm gift <礼物> [数量]',
      `TTS命中${voiceStats.hits}/${voiceStats.misses} 缓存${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles}条`,
      '常用口癖、谢礼和欢迎短句先生成缓存，减少临场 TTS 排队；不要说成现实主播本人语音。',
    );
  }
  if (missingStoreKeys.length > 0 && storage.failed.length === 0) {
    addPlanItem(
      p1,
      '生成必要持久化数据',
      '/maint storage；按功能执行 /cs warm、/csreport on、/watch、/profile、/cstrain log',
      `missing ${missingStoreKeys.join('/')}`,
      'missing 多数只是尚未使用；不要把文件缺失当成没有比赛、没有画像或没有订阅。',
    );
  }
  if (p1.length === 0) {
    addPlanItem(
      p1,
      '保留热缓存',
      '/status；/mem health',
      '缓存容量和审计没有明显 P1 压力。',
      '热缓存能提高回复速度、TTS/STT 命中和 CS 冷启动体验。',
    );
  }

  if (aiSamples >= 20 && aiHitRate < 0.2 && aiStats.replyCacheEntries >= Math.floor(aiStats.replyCacheMaxEntries * 0.8)) {
    addPlanItem(
      p2,
      '收紧低命中回复缓存',
      '调低 ai_reply_cache_seconds 或 ai_reply_cache_max_entries；/mem cache status',
      `AI缓存命中${formatHitRate(aiStats.replyCacheHits, aiStats.replyCacheMisses)} 条目${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries}`,
      '减少低价值缓存占用；实时/身份/礼物/多模态场景仍默认旁路。',
    );
  }
  if ((config.ai.trigger_probability || 0) < 0.03 || (config.ai.related_reply_probability || 0) < 0.35) {
    addPlanItem(
      p2,
      '调高自然接话活跃度',
      '/maint config；/tune trigger 0.08；/tune related 0.65',
      `trigger=${config.ai.trigger_probability} related=${config.ai.related_reply_probability}`,
      '太低会像没上线；太高会刷屏，先按群体感小步调。',
    );
  }
  if (profileStats.parseErrors > 0 || profileStats.lastError) {
    addPlanItem(
      p2,
      '修用户画像缓存',
      '/profile；/maint storage；检查 data/user-profiles.json',
      `画像${profileStats.profiles} 解析错${profileStats.parseErrors}${profileStats.lastError ? ` ${profileStats.lastError.slice(0, 60)}` : ''}`,
      '画像只影响个性化语气/举例，不能当实时阵容、排名或比分事实。',
    );
  }
  if (p2.length === 0) {
    addPlanItem(
      p2,
      '暂不调参',
      '/trace recent 5；/style status',
      '当前没有明显需要改配置的信号。',
      '先积累真实聊天样本，再按 trace 的质量风险和缓存判定调参。',
    );
  }

  return [
    '管理员总维护计划',
    '模式: 只读，不清缓存、不联网、不调用模型、不写配置。',
    `总体: login=${runtime.lastLoginOk ? 'ok' : 'bad'} ws=${runtime.connected ? 'ok' : 'bad'} config=${config.config_version || 'none'}/${CONFIG_VERSION} storage=${storage.failed.length ? 'fail' : 'ok'} cs=fresh${csStats.entries}/stale${csStats.staleEntries} heap=${heapUsedMB}/${heapTotalMB}MB rss=${rssMB}MB`,
    `缓存: AI ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries} 命中${formatHitRate(aiStats.replyCacheHits, aiStats.replyCacheMisses)} 搜索${searchStats.cacheEntries}/${searchStats.maxEntries} 图片${imageStats.sizeMB}/${imageStats.maxSizeMB}MB TTS${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB STT${sttStats.sizeMB}/${sttStats.maxCacheMB}MB`,
    `真实性: 证据${aiStats.evidenceTraceCount} 无实时${aiStats.realtimeIntentWithoutDataCount} 旧证据${aiStats.realtimeStaleEvidenceCount} 事实修正${aiStats.factGuardRepairCount} 知识审计${knowledgeStats.auditIssues}`,
    '优先级:',
    ...p0.map((item) => `P0 ${item}`),
    ...p1.map((item) => `P1 ${item}`),
    ...p2.map((item) => `P2 ${item}`),
    '边界: plan 只是 runbook；/maint clean 会清热缓存，/cs cache prune 只清 stale 不产生 fresh，/cs warm 才拉取实时证据；/maint warm media|voice|gift 只代表缓存可复用；missing 文件和 stale 缓存都不能当事实结论。',
  ].join('\n');
}

function pushAdvice(advice: string[], condition: boolean, text: string): void {
  if (condition && advice.length < 5) advice.push(text);
}

function formatCacheHealthStatus(config: BotConfig, sessionId: string): string {
  const aiStats = getAiChatStats();
  const searchStats = getSearchStats();
  const csStats = getHltvStats();
  const imageStats = getImageCacheStats();
  const voiceStats = getVoiceStats(config.ai);
  const sttStats = getSttStats(config.ai);
  const knowledgeStats = getKnowledgeStats();
  const profileStats = getUserProfileStats();
  const memory = getMemoryDiagnostics(config.ai, sessionId);
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const externalMB = Math.round(usage.external / 1024 / 1024);
  const memoryPressure = formatMemoryPressure(usage.heapUsed, usage.heapTotal, usage.rss);
  const ragSessionUsage = formatUsagePercent(memory.embeddings.sessionsInMemory, memory.embeddings.maxSessionsInMemory);
  const contextExpireMinutes = Math.max(1, config.ai.context_expire_minutes || 120);
  const contextMaxMessages = Math.max(5, config.ai.max_context_messages || 50);
  const ragMaxMessages = memory.embeddings.maxMessagesPerSession;
  const advice: string[] = [];

  const aiSamples = aiStats.replyCacheHits + aiStats.replyCacheMisses;
  const searchSamples = searchStats.hits + searchStats.misses;
  const csSamples = csStats.hits + csStats.misses;
  const imageSamples = imageStats.hits + imageStats.misses;
  const voiceSamples = voiceStats.hits + voiceStats.misses;
  const sttSamples = sttStats.hits + sttStats.misses;
  const ragSamples = memory.embeddings.hits + memory.embeddings.misses;

  pushAdvice(advice, heapTotalMB > 0 && usage.heapUsed / usage.heapTotal > 0.85,
    'heap 压力偏高，先按群跑 /mem trim 20；PM2 已开 --expose-gc 时可让管理员 /maint gc。');
  pushAdvice(advice, rssMB >= 750,
    'rss 偏高，优先查图片/TTS/STT缓存和活跃群上下文；必要时 /maint clean 后滚动重启。');
  pushAdvice(advice, aiStats.sessions >= 80,
    '上下文内存会话较多，低活跃群可让管理员按群 /mem trim 20，或调低 context_expire_minutes。');
  pushAdvice(advice, memory.embeddings.maxSessionsInMemory > 0 && memory.embeddings.sessionsInMemory / memory.embeddings.maxSessionsInMemory > 0.85,
    'RAG索引内存接近上限，调低 memory_max_sessions_in_memory 或保留当前LRU淘汰策略即可。');
  pushAdvice(advice, memory.embeddings.totalIndexed > memory.embeddings.maxMessagesPerSession * Math.max(1, memory.embeddings.sessionsInMemory) * 0.9,
    'RAG索引接近每会话上限，老消息会被裁剪；想省内存可降低 memory_max_messages_per_session。');
  pushAdvice(advice, aiSamples >= 20 && aiStats.replyCacheHits / aiSamples < 0.2 && aiStats.replyCacheEntries >= Math.floor(aiStats.replyCacheMaxEntries * 0.8),
    'AI回复缓存接近满但命中低，适合缩短 ai_reply_cache_seconds 或检查是否太多高上下文场景在旁路。');
  pushAdvice(advice, searchStats.maxEntries > 0 && searchStats.negativeEntries > Math.floor(searchStats.maxEntries * 0.35),
    '搜索空缓存偏多，先观察搜索源可用性；必要时降低 search_negative_cache_seconds。');
  pushAdvice(advice, csStats.staleEntries > csStats.entries || csStats.staleServed > 0 || csStats.failures > 0,
    'CS实时缓存出现 stale/兜底/失败，回答必须标旧快照边界；管理员可先 /cs cache prune，再 /cs warm plan all。');
  pushAdvice(advice, imageStats.maxSizeMB > 0 && imageStats.sizeMB / imageStats.maxSizeMB > 0.85,
    '图片缓存容量偏紧，可 /maint clean 或调高 image_cache_max_mb。');
  pushAdvice(advice, voiceStats.maxCacheMB > 0 && voiceStats.sizeMB / voiceStats.maxCacheMB > 0.85,
    'TTS缓存容量偏紧，可 /voice clean 或调高 tts_cache_max_mb。');
  pushAdvice(advice, sttStats.maxCacheMB > 0 && sttStats.sizeMB / sttStats.maxCacheMB > 0.85,
    'STT缓存容量偏紧，可 /voice clean 或调高 stt_cache_max_mb。');
  pushAdvice(advice, memory.embeddings.pendingFlushes > 20 || !!memory.embeddings.lastError,
    'RAG待写或索引错误偏多，检查 context_store/embeddings 写盘权限和磁盘空间。');
  pushAdvice(advice, !!knowledgeStats.dbLastError || knowledgeStats.auditIssues > 0,
    '知识库有 DB 错误或审计问题，跑 /kb audit 或 /maint clean 看详情。');
  pushAdvice(advice, profileStats.parseErrors > 0 || !!profileStats.lastError,
    '用户画像缓存读写异常，检查 data/user-profiles.json 权限和 JSON 格式。');
  if (advice.length === 0) advice.push('暂无明显红灯；继续用 /status、/trace last 和 /cs evidence all 观察真实数据链路。');

  return [
    '缓存健康',
    `内存压力: ${memoryPressure} heap ${heapUsedMB}/${heapTotalMB}MB rss ${rssMB}MB external ${externalMB}MB；队列${aiStats.pendingJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
    `上下文: 内存${aiStats.sessions}会话 max_context=${contextMaxMessages} 过期${contextExpireMinutes}m 压缩完成${aiStats.completedCompressions}/延后${aiStats.deferredCompressions}/失败${aiStats.failedCompressions}`,
    `AI回复缓存: 命中率${formatHitRate(aiStats.replyCacheHits, aiStats.replyCacheMisses)} 样本${aiSamples} 条目${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries} 飞行${aiStats.replyInFlight} 旁路${aiStats.replyCacheBypasses}`,
    `AI缓存策略Top: ${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`,
    `搜索缓存: 命中率${formatHitRate(searchStats.hits, searchStats.misses)} 样本${searchSamples} 条目${searchStats.cacheEntries}/${searchStats.maxEntries} 空${searchStats.negativeEntries} 磁盘命中${searchStats.diskHits} 飞行${searchStats.inFlight}`,
    `CS实时缓存: 命中率${formatHitRate(csStats.hits, csStats.misses)} 样本${csSamples} fresh ${csStats.entries} / stale ${csStats.staleEntries} 磁盘${csStats.diskHits}/${csStats.diskEntriesLoaded} 写入${csStats.writes} 兜底${csStats.staleServed} 失败${csStats.failures}`,
    `图片缓存: 命中率${formatHitRate(imageStats.hits, imageStats.misses)} 样本${imageSamples} ${imageStats.count}/${imageStats.maxFiles}张 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB(${formatUsagePercent(imageStats.sizeMB, imageStats.maxSizeMB)}) 失败${imageStats.downloadFailures} 飞行${imageStats.inFlight}`,
    `TTS缓存: 命中率${formatHitRate(voiceStats.hits, voiceStats.misses)} 样本${voiceSamples} ${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles}条 ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB(${formatUsagePercent(voiceStats.sizeMB, voiceStats.maxCacheMB)}) 合并${voiceStats.inFlightHits}${voiceStats.lastError ? ` 错误=${voiceStats.lastError.slice(0, 60)}` : ''}`,
    `STT缓存: 命中率${formatHitRate(sttStats.hits, sttStats.misses)} 样本${sttSamples} ${sttStats.cacheFiles}/${sttStats.maxCacheFiles}条 ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB(${formatUsagePercent(sttStats.sizeMB, sttStats.maxCacheMB)}) 下载失败${sttStats.downloadMisses} 空转写${sttStats.transcriptMisses}${sttStats.lastError ? ` 错误=${sttStats.lastError.slice(0, 60)}` : ''}`,
    `RAG: ${memory.enabled ? 'on' : 'off'} 命中率${formatHitRate(memory.embeddings.hits, memory.embeddings.misses)} 样本${ragSamples} 内存${memory.embeddings.sessionsInMemory}/${memory.embeddings.maxSessionsInMemory}会话(${ragSessionUsage}) 磁盘${memory.embeddings.diskSessions} 索引${memory.embeddings.totalIndexed}/${ragMaxMessages}/会话 待写${memory.embeddings.pendingFlushes}`,
    `用户画像缓存: ${profileStats.cached ? 'warm' : 'cold'} 条目${profileStats.profiles} 命中${profileStats.cacheHits}/${profileStats.diskReads} 写入${profileStats.diskWrites} 解析错${profileStats.parseErrors}${profileStats.lastError ? ` 错误=${profileStats.lastError.slice(0, 60)}` : ''}`,
    `知识库: 注入命中${knowledgeStats.selectHits}/${knowledgeStats.selectMisses} 检索${knowledgeStats.searchHits}/${knowledgeStats.searchMisses} DB ${knowledgeStats.dbMode} 命中${knowledgeStats.dbHits}/${knowledgeStats.dbMisses} 审计${knowledgeStats.auditIssues}`,
    `容量建议: max_context_messages=${contextMaxMessages} memory_max_messages_per_session=${ragMaxMessages} memory_max_sessions_in_memory=${memory.embeddings.maxSessionsInMemory} ai_reply_cache_max_entries=${aiStats.replyCacheMaxEntries}`,
    '清理动作: /mem user <QQ号> 定位个人刷屏；管理员 /mem user drop <QQ号> 或 /mem drop <关键词> 删除噪声记忆；/mem trim 20 裁剪当前会话；/maint clean 清缓存并审计；PM2 开 --expose-gc 后 /maint gc。',
    `建议: ${advice.join('；')}`,
  ].join('\n');
}

function formatPlanPercent(current: number, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return 'n/a';
  return `${Math.round((current / max) * 100)}%`;
}

function addPlanItem(items: string[], title: string, command: string, reason: string, impact: string): void {
  items.push(`${title}\n  命令: ${command}\n  原因: ${reason}\n  影响: ${impact}`);
}

function formatMemoryMaintenancePlan(config: BotConfig, sessionId: string): string {
  const aiStats = getAiChatStats();
  const searchStats = getSearchStats();
  const csStats = getHltvStats();
  const imageStats = getImageCacheStats();
  const voiceStats = getVoiceStats(config.ai);
  const sttStats = getSttStats(config.ai);
  const knowledgeStats = getKnowledgeStats();
  const profileStats = getUserProfileStats();
  const memory = getMemoryDiagnostics(config.ai, sessionId);
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const externalMB = Math.round(usage.external / 1024 / 1024);
  const heapRatio = heapTotalMB > 0 ? usage.heapUsed / usage.heapTotal : 0;
  const p0: string[] = [];
  const p1: string[] = [];
  const p2: string[] = [];
  const sessionMessages = memory.session.messages;
  const sessionSummaryChars = memory.session.summaryChars;
  const ragUsage = memory.embeddings.maxSessionsInMemory > 0
    ? memory.embeddings.sessionsInMemory / memory.embeddings.maxSessionsInMemory
    : 0;
  const imageUsage = imageStats.maxSizeMB > 0 ? imageStats.sizeMB / imageStats.maxSizeMB : 0;
  const voiceUsage = voiceStats.maxCacheMB > 0 ? voiceStats.sizeMB / voiceStats.maxCacheMB : 0;
  const sttUsage = sttStats.maxCacheMB > 0 ? sttStats.sizeMB / sttStats.maxCacheMB : 0;
  const aiSamples = aiStats.replyCacheHits + aiStats.replyCacheMisses;
  const aiHitRate = aiSamples > 0 ? aiStats.replyCacheHits / aiSamples : 0;
  const searchCapacity = searchStats.maxEntries > 0 ? searchStats.cacheEntries / searchStats.maxEntries : 0;
  const searchNegativeRatio = searchStats.maxEntries > 0 ? searchStats.negativeEntries / searchStats.maxEntries : 0;
  const keepRecent = sessionMessages >= 80 ? 30 : sessionMessages >= 45 ? 24 : 20;

  if (sessionMessages >= 45 || sessionSummaryChars >= 800) {
    addPlanItem(
      p0,
      '裁剪当前会话旧上下文',
      `/mem trim ${keepRecent}`,
      `当前会话 ${sessionMessages} 条、摘要 ${sessionSummaryChars} 字，长期群聊容易把旧梗和旧事实召回回来。`,
      '只处理当前群/私聊；清旧摘要并保留最近上下文/RAG，能降 token 和旧记忆干扰。',
    );
  }
  if (heapRatio >= 0.85 || rssMB >= 850) {
    addPlanItem(
      p0,
      '手动 GC',
      '/maint gc',
      `内存压力偏高：heap ${heapUsedMB}/${heapTotalMB}MB rss ${rssMB}MB。`,
      '需要 PM2/Node 已开启 --expose-gc；不删除记忆和缓存，只尝试回收 V8 可释放内存。',
    );
  }
  if (csStats.staleServed > 0 || csStats.failures > 0 || csStats.staleEntries > 0) {
    addPlanItem(
      p0,
      '清理并刷新 CS 实时缓存',
      '/cs cache prune；/cs warm plan all；/cs warm all',
      `CS 缓存 stale ${csStats.staleEntries}、旧缓存兜底 ${csStats.staleServed}、失败 ${csStats.failures}。`,
      '先移除过期事实快照，避免旧线索继续被当证据；再按计划补 fresh 赛程/赛果/排名证据；不改知识库。',
    );
  }
  if (p0.length === 0) {
    addPlanItem(
      p0,
      '保持观察',
      '/mem health',
      '当前没有必须立刻处理的内存/缓存红灯。',
      '继续观察命中率、stale 证据和队列；不要为了“清爽”清掉有用长期记忆。',
    );
  }

  if (imageUsage >= 0.75 || voiceUsage >= 0.75 || sttUsage >= 0.75 || searchNegativeRatio >= 0.35) {
    addPlanItem(
      p1,
      '清理磁盘缓存',
      '/maint clean',
      `图片 ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB，TTS ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB，STT ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB，搜索空缓存 ${searchStats.negativeEntries}/${searchStats.maxEntries}。`,
      '会删除过期/超额缓存并跑知识库审计；下次冷启动可能多一次下载或生成，但不删会话记忆。',
    );
  }
  if (aiStats.sessions >= 60 || ragUsage >= 0.8 || memory.embeddings.pendingFlushes > 20) {
    addPlanItem(
      p1,
      '巡检活跃群记忆',
      '/mem recent 12',
      `上下文内存 ${aiStats.sessions} 会话，RAG 内存 ${memory.embeddings.sessionsInMemory}/${memory.embeddings.maxSessionsInMemory}，待写 ${memory.embeddings.pendingFlushes}。`,
      '先定位当前群是否被刷屏或错事实污染；命中后再用 /mem user drop 或 /mem drop 精准删。',
    );
  }
  if (knowledgeStats.auditIssues > 0 || knowledgeStats.dbLastError) {
    addPlanItem(
      p1,
      '处理知识库风险',
      '/kb audit',
      `知识审计 ${knowledgeStats.auditIssues} 项${knowledgeStats.dbLastError ? `，DB错误 ${knowledgeStats.dbLastError.slice(0, 60)}` : ''}。`,
      '先修来源/原话/时效问题，避免 RAG 和知识注入把旧事实说成当前事实。',
    );
  }
  if (p1.length === 0) {
    addPlanItem(
      p1,
      '保留缓存',
      '/status',
      '缓存容量和待写队列没有明显压力。',
      '保留热缓存能提高识图、TTS/STT、搜索和 CS 数据命中率。',
    );
  }

  if (aiSamples >= 20 && aiHitRate < 0.2 && aiStats.replyCacheEntries >= Math.floor(aiStats.replyCacheMaxEntries * 0.8)) {
    addPlanItem(
      p2,
      '收紧 AI 回复缓存',
      '调低 ai_reply_cache_seconds 或 ai_reply_cache_max_entries',
      `AI 回复缓存命中率 ${formatHitRate(aiStats.replyCacheHits, aiStats.replyCacheMisses)}，条目 ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries}。`,
      '减少低命中缓存占用；实时、身份、礼物、识图/语音等高上下文场景仍会旁路。',
    );
  }
  if (memory.embeddings.maxMessagesPerSession > 900 || memory.embeddings.maxSessionsInMemory > 120) {
    addPlanItem(
      p2,
      '收紧 RAG 容量',
      '调低 memory_max_messages_per_session / memory_max_sessions_in_memory',
      `当前每会话上限 ${memory.embeddings.maxMessagesPerSession}，内存会话上限 ${memory.embeddings.maxSessionsInMemory}。`,
      '降低长期内存占用；会减少很旧历史的可召回范围。',
    );
  }
  if (searchCapacity >= 0.9 && searchNegativeRatio < 0.2) {
    addPlanItem(
      p2,
      '保留或提高搜索缓存',
      '维持 search_cache_max_entries，必要时小幅提高',
      `搜索缓存 ${searchStats.cacheEntries}/${searchStats.maxEntries}，空缓存占比 ${formatPlanPercent(searchStats.negativeEntries, searchStats.maxEntries)}。`,
      '搜索命中率高时保留热缓存更省延迟；事实回答仍看 fresh/stale 证据。',
    );
  }
  if (p2.length === 0) {
    addPlanItem(
      p2,
      '暂不调参',
      '/maint config',
      '当前配置没有明显过大或过小信号。',
      '先用现有 TTL/LRU 跑样本，避免为省内存牺牲缓存命中和真人回复连贯性。',
    );
  }

  return [
    '缓存/内存维护计划',
    `模式: 只读，不清理、不GC、不写配置；会话 ${sessionId}`,
    `压力概览: heap ${heapUsedMB}/${heapTotalMB}MB rss ${rssMB}MB external ${externalMB}MB；队列${aiStats.pendingJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
    `当前会话: 上下文${sessionMessages}条 摘要${sessionSummaryChars}字 loaded=${memory.session.loaded ? 'yes' : 'no'}；RAG索引内存${memory.embeddings.sessionsInMemory}/${memory.embeddings.maxSessionsInMemory}会话 全局${memory.embeddings.totalIndexed}条 待写${memory.embeddings.pendingFlushes}`,
    `缓存概览: AI ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries} 命中${formatHitRate(aiStats.replyCacheHits, aiStats.replyCacheMisses)}；搜索${searchStats.cacheEntries}/${searchStats.maxEntries} 空${searchStats.negativeEntries}；CS fresh${csStats.entries}/stale${csStats.staleEntries}；图片${imageStats.sizeMB}/${imageStats.maxSizeMB}MB；TTS${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB；STT${sttStats.sizeMB}/${sttStats.maxCacheMB}MB`,
    `用户画像/知识: profile ${profileStats.cached ? 'warm' : 'cold'} 命中${profileStats.cacheHits}/${profileStats.diskReads}；知识注入${knowledgeStats.selectHits}/${knowledgeStats.selectMisses} DB ${knowledgeStats.dbMode} ${knowledgeStats.dbHits}/${knowledgeStats.dbMisses}`,
    '优先级:',
    ...p0.map((item) => `P0 ${item}`),
    ...p1.map((item) => `P1 ${item}`),
    ...p2.map((item) => `P2 ${item}`),
    '边界: /mem trim/drop/clear 会影响当前会话记忆，执行前先 /mem recent 或 /mem user 定位；/cs cache prune 只清 stale CS 事实缓存但不会产生 fresh 证据；/maint clean 会造成下一次冷启动；stale 缓存和旧知识都不能当实时事实。',
  ].join('\n');
}

function formatReplyCachePruneReport(): string {
  const result = pruneExpiredReplyCacheForMaintenance();
  return [
    'AI回复缓存过期清理',
    '模式: 只清理 expired 回复缓存；保留 fresh 热缓存，不联网、不调用模型、不清图片/TTS/STT/CS缓存。',
    `条目: before ${result.before} / fresh ${result.fresh} / expired ${result.expired} / removed ${result.removed} / after ${result.after}`,
    `飞行请求: ${result.inFlight} 个仍保留等待，不会被 prune 打断。`,
    result.removed > 0
      ? '结果: 已释放过期回复缓存；常用稳定战术问法的 fresh 命中不受影响。'
      : '结果: 没有过期回复缓存需要清理。',
    '边界: 这不是全量清缓存；如果要清上下文/RAG 噪声，用 /mem drop、/mem trim 或 /mem clear。',
  ].join('\n');
}

function formatMemoryPreflight(config: BotConfig, sessionId: string, query: string): string {
  const clean = (query || '').trim();
  if (!clean) return '/mem check <要预检的消息>';
  const memory = getMemoryDiagnostics(config.ai, sessionId);
  const topK = Math.max(0, Math.min(12, Math.floor(config.ai.memory_top_k ?? 4)));
  const minSimilarity = Number(config.ai.memory_min_similarity ?? 0.18);
  const injectBudget = Math.max(0, Math.floor(config.ai.memory_inject_max_chars ?? memory.injectMaxChars));
  const recent = getRecentSessionMemory(config.ai, sessionId, 10);
  const recentTextSet = new Set(recent.context.map((item) => normalizeMemoryCompareText(item.text)).filter(Boolean));
  const rawHits = searchSessionMemory(config.ai, sessionId, clean, Math.max(topK + 8, 12));
  const eligible = rawHits
    .filter((hit) => hit.similarity >= minSimilarity && !recentTextSet.has(normalizeMemoryCompareText(hit.text)));
  const truthRisk = filterMemoryTruthRisk(clean, eligible);
  const useful = truthRisk.kept
    .slice(0, topK);
  const lines: string[] = [];
  let used = 0;
  for (const hit of useful) {
    const score = hit.score !== undefined ? ` score=${hit.score}` : '';
    const boost = hit.recencyBoost ? ` boost=${hit.recencyBoost}` : '';
    const age = hit.ageSeconds !== undefined ? ` age=${formatMemoryAge(hit.ageSeconds)}` : '';
    const line = `[${hit.role} sim=${hit.similarity}${score}${boost}${age}] ${cleanMemoryLine(hit.text, 180)}`;
    if (used + line.length > injectBudget && lines.length > 0) break;
    lines.push(line);
    used += line.length;
    if (injectBudget <= 0) break;
  }
  const filteredSamples = truthRisk.filtered
    .slice(0, 2)
    .map((hit, index) => `${index + 1}. [旧CS实时事实] ${cleanMemoryLine(hit.text, 140)}`);
  const risks: string[] = [];
  const advice: string[] = [];
  if (!memory.enabled || config.ai.enable_memory_retrieval === false) {
    risks.push('RAG记忆关闭');
    advice.push('打开 enable_memory_retrieval');
  }
  if (topK <= 0) {
    risks.push('memory_top_k=0，不会注入相似历史');
    advice.push('把 memory_top_k 调到 3~4');
  }
  if (injectBudget <= 0) {
    risks.push('memory_inject_max_chars=0，不会注入');
    advice.push('把 memory_inject_max_chars 调到 500~900');
  }
  if (clean.length < 4) {
    risks.push('查询太短，相似度不稳定');
    advice.push('用更完整的一句话预检');
  }
  if (rawHits.length === 0) {
    risks.push('没有相似历史命中');
    advice.push('先多聊几轮，或用 /mem recent 看索引是否为空');
  } else if (eligible.length === 0) {
    risks.push('命中都被阈值/近期上下文去重过滤');
    advice.push('降低 memory_min_similarity，或用 /mem recent 看是否已经在上下文里');
  } else if (truthRisk.kept.length === 0 && truthRisk.filtered.length > 0) {
    risks.push('命中都是旧CS实时事实，真实回复不会注入');
    advice.push('用 /cs verify 或管理员 /cs warm plan 补 fresh 证据');
  }
  if (truthRisk.filtered.length > 0) {
    risks.push(`旧CS实时事实记忆已过滤${truthRisk.filtered.length}条`);
    advice.push('排名/比分/阵容/转会只按 fresh 实时证据说，stale/miss 不从记忆补');
  }
  if (lines.length < useful.length) {
    risks.push('注入预算截断部分命中');
    advice.push('调高 memory_inject_max_chars 或减少 memory_top_k');
  }
  if (memory.embeddings.lastError) {
    risks.push(`索引最近错误: ${memory.embeddings.lastError.slice(0, 80)}`);
    advice.push('检查 context_store/embeddings 写盘权限');
  }
  if (advice.length === 0) advice.push('可以强触发一条消息后用 /trace last 核对实际 RAG 命中');

  return [
    'RAG记忆预检',
    `会话: ${sessionId}`,
    `查询: ${clean.slice(0, 100)}`,
    `参数: ${memory.enabled ? 'on' : 'off'} topK=${topK} sim>=${minSimilarity} 注入上限${injectBudget}字 排序=sim+近期加权`,
    `索引: 当前会话最近${recent.indexed.length}条 / 全局${memory.embeddings.totalIndexed}条 / 内存会话${memory.embeddings.sessionsInMemory}/${memory.embeddings.maxSessionsInMemory}`,
    `命中: 原始${rawHits.length}条 / 去重后${eligible.length}条 / 时效过滤${truthRisk.filtered.length}条 / 预计注入${lines.length}条 ${used}/${injectBudget}字`,
    lines.length > 0 ? lines.map((line, index) => `${index + 1}. ${line}`).join('\n') : '命中列表: 无',
    filteredSamples.length > 0 ? `过滤样本:\n${filteredSamples.join('\n')}` : '',
    `风险: ${risks.length ? risks.join(' / ') : '无明显风险'}`,
    `行动建议: ${[...new Set(advice)].join('；')}`,
    '说明: 这里只预检当前会话 RAG，相邻上下文仍会单独进入模型。',
  ].join('\n');
}

export const adminPlugin: Plugin = {
  name: 'admin',
  description: '管理员命令 - 群管理、配置重载等',

  handler: async (ctx) => {
    const config = ctx.bot.getConfig();
    const isAdmin = config.admin_qq.includes(ctx.event.user_id);

    // 中文模糊命令分发
    const fuzzy = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());

    // ===== /mem 内存状态（任何人可查）=====
    if (ctx.command === 'mem' || ctx.command === 'memory' || fuzzy === 'mem') {
      const action = (ctx.args[0] || 'status').toLowerCase();
      const sessionId = sessionIdForContext(ctx);
      if (
        action === 'cache-check' ||
        action === 'reply-cache' ||
        action === 'cache-preview' ||
        action === '缓存预检' ||
        (action === 'cache' && ctx.args.length > 1)
      ) {
        const cacheSub = (ctx.args[1] || '').toLowerCase();
        if (
          (action === 'reply-cache' && ctx.args.length === 1) ||
          (action === 'cache' && ['status', 'stats', 'stat', 'pool', 'overview', '状态', '统计', '概览'].includes(cacheSub))
        ) {
          ctx.reply(formatReplyCachePoolStatus(config.ai));
          return true;
        }
        if (action === 'cache' && ['prune', 'clean-expired', 'expired', 'gc', '清过期', '清理过期'].includes(cacheSub)) {
          if (!isAdmin) {
            ctx.replyAt('清理回复缓存得管理员来，普通用户先用 /mem cache status 看状态。');
            return true;
          }
          ctx.reply(formatReplyCachePruneReport());
          return true;
        }
        const query = ctx.args.slice(1).join(' ').trim();
        ctx.reply(formatReplyCachePreflight(config.ai, query));
        return true;
      }
      if (action === 'health' || action === 'cache' || action === '缓存' || action === '体检') {
        ctx.reply(formatCacheHealthStatus(config, sessionId));
        return true;
      }
      if (action === 'plan' || action === 'cleanup-plan' || action === 'sweep' || action === '维护计划' || action === '清理计划' || action === '优化') {
        ctx.reply(formatMemoryMaintenancePlan(config, sessionId));
        return true;
      }
      if (action === 'search' || action === 'find' || action === '查') {
        const query = ctx.args.slice(1).join(' ').trim();
        if (!query) {
          ctx.reply('/mem search <关键词>');
          return true;
        }
        const hits = searchSessionMemory(config.ai, sessionId, query, 6);
        ctx.reply(hits.length > 0
          ? ['记忆检索', ...hits.map((hit, index) => `${index + 1}. ${hit.role} sim=${hit.similarity} score=${hit.score ?? hit.similarity} age=${formatMemoryAge(hit.ageSeconds)}\n${hit.text.replace(/^\[mid=\d+\s+uid=\d+\]\s*/, '').slice(0, 180)}`)].join('\n\n')
          : '没搜到相关历史，可能还没聊够或者相似度不够。');
        return true;
      }
      if (action === 'check' || action === 'preview' || action === 'dry-run' || action === '预检') {
        const query = ctx.args.slice(1).join(' ').trim();
        ctx.reply(formatMemoryPreflight(config, sessionId, query));
        return true;
      }
      if (action === 'user' || action === 'uid' || action === '用户') {
        const dropMode = ['drop', 'delete', 'remove', 'forget', '删除', '遗忘'].includes((ctx.args[1] || '').toLowerCase());
        const targetText = dropMode ? ctx.args.slice(2).join(' ') : ctx.args.slice(1).join(' ');
        const targetUserId = parseTargetUserId(targetText);
        if (!targetUserId) {
          ctx.reply('/mem user <QQ号>\n管理员删除: /mem user drop <QQ号>\n说明: user 不写缓存，只检查当前会话里这个用户的上下文/RAG痕迹。');
          return true;
        }
        if (dropMode) {
          if (!isAdmin) {
            ctx.replyAt('按用户删除记忆得管理员来。');
            return true;
          }
          const result = dropAiSessionMemoryByUser(config.ai, sessionId, targetUserId);
          const sampleLines = result.samples
            .slice(0, 5)
            .map((sample, index) => {
              const time = sample.ts ? ` ${formatDate(sample.ts)}` : '';
              return `${index + 1}. ${sample.role}${time} ${cleanMemoryLine(sample.text, 120) || '[空]'}`;
            });
          ctx.reply([
            '当前会话用户记忆已删除。',
            `会话: ${sessionId}`,
            `目标: uid=${targetUserId}`,
            `上下文: ${result.contextBefore} -> ${result.contextAfter} 条 (删${result.contextRemoved})`,
            `摘要: ${result.summaryBeforeChars} -> ${result.summaryAfterChars} 字${result.summaryDropped ? ' (命中用户后清空，避免旧摘要残留)' : ''}`,
            `RAG索引: ${result.indexBefore} -> ${result.indexAfter} 条 (删${result.indexRemoved})`,
            sampleLines.length > 0 ? `样本:\n${sampleLines.join('\n')}` : '样本: 无命中',
            '说明: 只处理当前群/私聊会话；用于某个用户刷屏、错事实或跑偏话题污染记忆时定点清理。',
          ].join('\n'));
          return true;
        }
        const result = inspectAiSessionMemoryByUser(config.ai, sessionId, targetUserId);
        const sampleLines = result.samples
          .slice(0, 5)
          .map((sample, index) => {
            const time = sample.ts ? ` ${formatDate(sample.ts)}` : '';
            return `${index + 1}. ${sample.role}${time} ${cleanMemoryLine(sample.text, 120) || '[空]'}`;
          });
        ctx.reply([
          '用户记忆预检',
          `会话: ${sessionId}`,
          `目标: uid=${targetUserId}`,
          `上下文: ${result.contextMatched}/${result.contextTotal} 条`,
          `RAG索引: ${result.indexMatched}/${result.indexTotal} 条`,
          `摘要: ${result.summaryChars} 字${result.summaryChars > 0 ? ' (压缩摘要可能混有旧用户内容，删除命中时会清空摘要)' : ''}`,
          sampleLines.length > 0 ? `样本:\n${sampleLines.join('\n')}` : '样本: 无命中',
          `行动建议: ${result.contextMatched || result.indexMatched ? `管理员 /mem user drop ${targetUserId} 定点删除` : '没有命中；如果是关键词污染，用 /mem drop <关键词>'}`,
          '边界: 这里只读检查当前会话，不影响其他群，不调用 AI。'
        ].join('\n'));
        return true;
      }
      if (action === 'recent' || action === 'last' || action === '最近') {
        const limit = Math.max(1, Math.min(parseInt(ctx.args[1] || '8', 10) || 8, 20));
        const recent = getRecentSessionMemory(config.ai, sessionId, limit);
        const contextLines = recent.context
          .slice(-limit)
          .map((item, index) => `${index + 1}. ${item.role} ${cleanMemoryLine(item.text, 160) || '[空]'}`);
        const indexedLines = recent.indexed
          .slice(-Math.min(limit, 8))
          .map((item, index) => {
            const time = item.ts ? new Date(item.ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
            return `${index + 1}. ${item.role} ${time} ${cleanMemoryLine(item.text, 120) || '[空]'}`;
          });
        ctx.reply([
          `最近上下文 ${sessionId}`,
          contextLines.length > 0 ? contextLines.join('\n') : '上下文为空',
          '',
          '最近RAG索引',
          indexedLines.length > 0 ? indexedLines.join('\n') : '索引为空',
        ].join('\n'));
        return true;
      }
      if (action === 'clear' || action === 'reset' || action === '清空') {
        if (!isAdmin) {
          ctx.replyAt('清记忆得管理员来，别一手把上下文扬了。');
          return true;
        }
        const before = getMemoryDiagnostics(config.ai, sessionId);
        const beforeRecent = getRecentSessionMemory(config.ai, sessionId, 50);
        clearAiSessionMemory(sessionId);
        const after = getMemoryDiagnostics(config.ai, sessionId);
        const afterRecent = getRecentSessionMemory(config.ai, sessionId, 50);
        ctx.reply([
          '当前会话上下文和RAG索引已清空。',
          `会话: ${sessionId}`,
          `清理前: 上下文${before.session.messages}条 摘要${before.session.summaryChars}字 RAG索引${beforeRecent.indexed.length}条`,
          `清理后: 上下文${after.session.messages}条 摘要${after.session.summaryChars}字 RAG索引${afterRecent.indexed.length}条`,
        ].join('\n'));
        return true;
      }
      if (action === 'drop' || action === 'forget' || action === 'delete' || action === '删除' || action === '遗忘') {
        if (!isAdmin) {
          ctx.replyAt('删除记忆得管理员来。');
          return true;
        }
        const query = ctx.args.slice(1).join(' ').trim();
        if (query.length < 2) {
          ctx.reply('/mem drop <关键词或短语>\n例: /mem drop 错误阵容传闻\n说明: 删除当前会话上下文和RAG索引里命中的噪声记忆。');
          return true;
        }
        const result = dropAiSessionMemoryByQuery(config.ai, sessionId, query);
        const sampleLines = result.samples
          .slice(0, 5)
          .map((sample, index) => {
            const time = sample.ts ? ` ${formatDate(sample.ts)}` : '';
            return `${index + 1}. ${sample.role}${time} ${cleanMemoryLine(sample.text, 120) || '[空]'}`;
          });
        ctx.reply([
          '当前会话噪声记忆已删除。',
          `会话: ${sessionId}`,
          `关键词: ${query.slice(0, 80)}`,
          `上下文: ${result.contextBefore} -> ${result.contextAfter} 条 (删${result.contextRemoved})`,
          `摘要: ${result.summaryBeforeChars} -> ${result.summaryAfterChars} 字${result.summaryDropped ? ' (命中已清空)' : ''}`,
          `RAG索引: ${result.indexBefore} -> ${result.indexAfter} 条 (删${result.indexRemoved})`,
          sampleLines.length > 0 ? `样本:\n${sampleLines.join('\n')}` : '样本: 无命中',
          '说明: drop 只处理当前群/私聊会话，适合清掉错误事实、旧梗刷屏或跑偏话题；不会影响其他群。',
        ].join('\n'));
        return true;
      }
      if (action === 'trim' || action === 'prune' || action === '裁剪') {
        if (!isAdmin) {
          ctx.replyAt('裁剪记忆得管理员来。');
          return true;
        }
        const keep = Math.max(1, Math.min(parseInt(ctx.args[1] || '20', 10) || 20, 200));
        const result = trimAiSessionMemory(config.ai, sessionId, keep);
        ctx.reply([
          `当前会话记忆已裁剪，保留最近 ${keep} 条。`,
          `会话: ${sessionId}`,
          `上下文: ${result.contextBefore} -> ${result.contextAfter} 条`,
          `摘要: ${result.summaryBeforeChars} -> ${result.summaryAfterChars} 字`,
          `RAG索引: ${result.indexBefore} -> ${result.indexAfter} 条`,
          '说明: trim 会清掉旧摘要，只保留最近上下文，适合群聊长期运行时减内存和少召回旧事。',
        ].join('\n'));
        return true;
      }

      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      const externalMB = Math.round(usage.external / 1024 / 1024);
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const memory = getMemoryDiagnostics(config.ai, sessionId);
      const aiStats = getAiChatStats();
      const profileStats = getUserProfileStats();
      ctx.reply([
        '内存状态',
        `堆使用: ${heapMB}/${heapTotalMB} MB`,
        `RSS: ${rssMB} MB`,
        `外部: ${externalMB} MB`,
        `运行: ${hours}h ${mins}m`,
        `当前会话: ${sessionId} 消息${memory.session.messages} 摘要${memory.session.summaryChars}字 ${memory.session.loaded ? '已在内存' : '从磁盘按需加载'}`,
        `RAG记忆: ${memory.enabled ? 'on' : 'off'} 注入上限${memory.injectMaxChars}字`,
        `索引: 内存${memory.embeddings.sessionsInMemory}/${memory.embeddings.maxSessionsInMemory}会话 ${memory.embeddings.totalIndexed}条 磁盘${memory.embeddings.diskSessions}会话 待写${memory.embeddings.pendingFlushes}`,
        `检索: ${memory.embeddings.hits}/${memory.embeddings.misses} 查询${memory.embeddings.queries} 每会话上限${memory.embeddings.maxMessagesPerSession}`,
        `用户画像缓存: ${profileStats.cached ? 'warm' : 'cold'} 条目${profileStats.profiles} 命中${profileStats.cacheHits}/${profileStats.diskReads} 写入${profileStats.diskWrites} 解析错${profileStats.parseErrors}`,
        `AI回复缓存: ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries}条 飞行${aiStats.replyInFlight} 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses} 旁路${aiStats.replyCacheBypasses}`,
        `AI缓存策略Top: ${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`,
        ...(memory.embeddings.lastError ? [`索引最近错误: ${memory.embeddings.lastError}`] : []),
        '用法: /mem health；/mem plan；/mem cache status；/mem cache <消息>；/mem check <消息>；/mem user <QQ号>；/mem recent [条数]；/mem search <关键词>；管理员 /mem cache prune、/mem user drop <QQ号>、/mem drop <关键词>、/mem trim [条数] 或 /mem clear',
        `Node: ${process.version}`,
      ].join('\n'));
      return true;
    }

    // ===== /disk 磁盘状态 =====
    if (ctx.command === 'disk') {
      try {
        const fs = require('fs') as typeof import('fs');
        const cwd = process.cwd();
        const stats = fs.statfsSync ? fs.statfsSync(cwd) : null;
        if (stats) {
          const totalGB = ((stats.blocks * stats.bsize) / 1024 / 1024 / 1024).toFixed(1);
          const freeGB = ((stats.bavail * stats.bsize) / 1024 / 1024 / 1024).toFixed(1);
          const usedPercent = ((1 - stats.bavail / stats.blocks) * 100).toFixed(1);
          ctx.reply(`磁盘: ${freeGB}GB 空闲 / ${totalGB}GB 总量 (使用${usedPercent}%)`);
        } else {
          ctx.reply('系统不支持 statfs');
        }
      } catch (err) {
        ctx.reply(`磁盘检查失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    // ===== /gc 强制GC（管理员）=====
    if (ctx.command === 'gc') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 仅管理员可用');
        return true;
      }
      const before = process.memoryUsage().heapUsed;
      if (typeof global.gc === 'function') {
        global.gc();
        const after = process.memoryUsage().heapUsed;
        const freedMB = Math.round((before - after) / 1024 / 1024);
        ctx.reply(`GC完成 释放${freedMB}MB`);
      } else {
        ctx.reply('GC未启用 启动时需 --expose-gc');
      }
      return true;
    }

    // ===== /update 一键 git pull + build + 重启（admin） =====
    if (ctx.command === 'update' || ctx.command === 'upgrade') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足，仅管理员可用');
        return true;
      }
      ctx.reply('开始安全更新：备份配置、拉代码、npm ci、build、doctor、smoke、重启 PM2。');
      const projectRoot = path.resolve(__dirname, '..', '..');
      const child = exec('bash scripts/update.sh --smoke', { cwd: projectRoot, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          ctx.reply(`❌ 更新失败: ${err.message}\n\n最后输出:\n${(stderr || stdout).slice(-400)}`);
          return;
        }
        ctx.reply(`✅ 更新完成\n\n${stdout.slice(-250)}`);
      });
      // 防止 promise unhandled
      void child;
      return true;
    }

    // ===== 重载配置 =====
    if (ctx.command === 'reload') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足，仅管理员可用');
        return true;
      }

      try {
        const newConfig = loadConfig();
        ctx.bot.updateConfig(newConfig);
        startAiChatBackgroundTasks(newConfig.ai);
        ctx.reply([
          '配置已重载，运行期参数也重新应用了',
          `config_version: ${newConfig.config_version || '未填写'} / ${CONFIG_VERSION}`,
          `预设: ${newConfig.ai.active_preset || '无'}，知识库: ${newConfig.ai.enable_knowledge ? 'on' : 'off'}，搜索: ${newConfig.ai.enable_search ? 'on' : 'off'}`,
          `并发: AI ${newConfig.ai.ai_global_concurrency} / 搜索 ${newConfig.ai.search_global_concurrency} / 图 ${newConfig.ai.vision_global_concurrency} / 听写 ${newConfig.ai.stt_global_concurrency} / 语音 ${newConfig.ai.tts_global_concurrency}`,
          '跑 /maint status 可以看当前维护面板',
        ].join('\n'));
      } catch (err) {
        ctx.reply(`❌ 重载失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    // ===== /tune 快速调参 (admin) =====
    if (ctx.command === 'tune') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足，仅管理员可用');
        return true;
      }
      const sub = (ctx.args[0] || '').toLowerCase();
      const valStr = (ctx.args[1] || '').trim();
      const tunables: Record<string, { key: string; min: number; max: number; desc: string }> = {
        trigger: { key: 'trigger_probability', min: 0, max: 1, desc: '随机插话概率' },
        related: { key: 'related_reply_probability', min: 0, max: 1, desc: '相关话题接话概率' },
        tts: { key: 'tts_probability', min: 0, max: 1, desc: '语音回复概率' },
        poke: { key: 'poke_reply_probability', min: 0, max: 1, desc: '戳一戳回应概率' },
        temp: { key: 'temperature', min: 0, max: 2, desc: 'AI温度' },
        maxtokens: { key: 'max_tokens', min: 256, max: 16384, desc: '最大tokens' },
        minchars: { key: 'passive_random_min_chars', min: 1, max: 100, desc: '被动接话最短字数' },
        cooldown: { key: 'cooldown_seconds', min: 0, max: 60, desc: '冷却秒数' },
      };

      if (!sub || sub === 'help' || sub === '?') {
        const lines = ['快速调参 /tune <项> <值>'];
        for (const [name, info] of Object.entries(tunables)) {
          const cur = (config.ai as any)[info.key];
          lines.push(`  /tune ${name} ${info.min}~${info.max}  当前=${cur}  ${info.desc}`);
        }
        lines.push('', '改完会自动写回 config.json，不需要 /reload');
        ctx.reply(lines.join('\n'));
        return true;
      }

      const tunable = tunables[sub];
      if (!tunable) {
        ctx.reply(`未知调参项 ${sub}\n可用: ${Object.keys(tunables).join(', ')}\n用 /tune 看帮助`);
        return true;
      }

      if (!valStr) {
        const cur = (config.ai as any)[tunable.key];
        ctx.reply(`${tunable.desc} (${tunable.key}): 当前=${cur}\n设置: /tune ${sub} <${tunable.min}~${tunable.max}>`);
        return true;
      }

      const numVal = parseFloat(valStr);
      if (isNaN(numVal) || numVal < tunable.min || numVal > tunable.max) {
        ctx.reply(`无效值，应在 ${tunable.min}~${tunable.max} 之间`);
        return true;
      }

      try {
        const finalVal = tunable.key === 'max_tokens' || tunable.key === 'passive_random_min_chars' || tunable.key === 'cooldown_seconds'
          ? Math.floor(numVal)
          : numVal;
        // 写 config.json
        const { updateConfigFile } = require('../config');
        const newConfig = updateConfigFile((raw: any) => {
          if (!raw.ai) raw.ai = {};
          raw.ai[tunable.key] = finalVal;
        });
        ctx.bot.updateConfig(newConfig);
        ctx.reply(`✅ ${tunable.desc} 已改为 ${finalVal}\n已写入 config.json，立即生效`);
      } catch (err) {
        ctx.reply(`❌ 写入失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    // ===== 运行维护 =====
    if (isMaintCommand(ctx.command)) {
      if (!isAdmin) {
        ctx.replyAt('权限不足，仅管理员可用');
        return true;
      }

      const action = (ctx.args[0] || 'status').toLowerCase();
      const currentConfig = ctx.bot.getConfig();

      if (action === 'clean' || action === '清理') {
        const beforeImage = getImageCacheStats();
        const beforeSearch = getSearchStats();
        const beforeVoice = getVoiceStats(currentConfig.ai);
        const beforeStt = getSttStats(currentConfig.ai);
        const beforeCs = getHltvStats();
        cleanSearchCache();
        cleanImageCache();
        cleanVoiceCache(currentConfig.ai);
        cleanSttCache(currentConfig.ai);
        clearHltvCache();
        pruneKnowledgeAutoLog(currentConfig.ai.knowledge_auto_log_retention_days || 14);
        const audit = auditKnowledge();
        const afterImage = getImageCacheStats();
        const afterSearch = getSearchStats();
        const afterVoice = getVoiceStats(currentConfig.ai);
        const afterStt = getSttStats(currentConfig.ai);
        const afterCs = getHltvStats();
        ctx.reply([
          '维护清理跑完了',
          `搜索缓存: ${beforeSearch.cacheEntries} -> ${afterSearch.cacheEntries} 条`,
          `CS实时缓存: fresh ${beforeCs.entries} / stale ${beforeCs.staleEntries} -> fresh ${afterCs.entries} / stale ${afterCs.staleEntries}`,
          `图片缓存: ${beforeImage.count}/${beforeImage.sizeMB}MB -> ${afterImage.count}/${afterImage.sizeMB}MB，最近删${afterImage.lastCleanupDeleted}`,
          `语音缓存: ${beforeVoice.cacheFiles}/${beforeVoice.sizeMB}MB -> ${afterVoice.cacheFiles}/${afterVoice.sizeMB}MB，最近删${afterVoice.lastCleanupDeleted}`,
          `听写缓存: ${beforeStt.cacheFiles}/${beforeStt.sizeMB}MB -> ${afterStt.cacheFiles}/${afterStt.sizeMB}MB，最近删${afterStt.lastCleanupDeleted}`,
          `知识库审计: ${audit.issues.length} 个问题`,
        ].join('\n'));
        return true;
      }

      if (action === 'storage' || action === 'store' || action === 'disk' || action === '存储' || action === '写盘') {
        ctx.reply(formatRuntimeStoragePanel());
        return true;
      }

      if (action === 'warm' || action === 'prewarm' || action === '预热') {
        const scope = (ctx.args[1] || '').toLowerCase();
        if (!scope || scope === 'help' || scope === '?') {
          ctx.reply([
            '维护预热用法',
            '/maint warm plan - 只读列出最近 trace 里最值得预热的图片、语音源、TTS短句和礼物谢礼',
            '/maint warm apply [all|media|vision|voice|gift] [条数] - 按候选真实预热安全缓存，不自动听写语音源',
            '/maint warm cs - 预热 CS 核心/关注/竞猜相关实时缓存',
            '/maint warm cs matches|results|ranking',
            '/maint warm cs watch|predict|team <队伍>|player <选手>|match <id>',
            '/maint warm media <图片URL/语音URL或附图附语音> - 图片真实预热，语音只读STT缓存',
            '/maint warm vision <图片URL或附图> - 只预热图片缓存，不调用视觉模型',
            '/maint warm voice <文本> - 真实预热TTS缓存，不调用AI不发送record',
            '/maint warm gift <礼物> [数量] - 真实预热礼物谢礼TTS缓存，不写礼物trace',
            '边界: CS warm 会请求实时源并写短期缓存；媒体/语音 warm 只代表缓存可复用，不代表事实正确、已看图或现实本人语音。',
          ].join('\n'));
          return true;
        }

        const targetArgs = ctx.args.slice(2);
        if (scope === 'plan' || scope === 'check' || scope === 'status' || scope === '候选' || scope === '计划') {
          ctx.reply(formatMaintenanceWarmupPlan(currentConfig));
          return true;
        }
        if (scope === 'apply' || scope === 'run' || scope === 'exec' || scope === '执行' || scope === '应用') {
          ctx.reply(await formatMaintenanceWarmupApply(currentConfig, targetArgs));
          return true;
        }

        if (isCsWarmScope(scope)) {
          const effectiveArgs = targetArgs.length > 0 ? targetArgs : ['all'];
          const report = await buildCsPrewarmReport(effectiveArgs);
          ctx.reply([
            `维护预热: CS实时缓存 (${effectiveArgs.join(' ')})`,
            report,
            '后续: /cs verify all；/cs evidence all；/maint plan',
            '边界: 这只是补短期缓存，不等于 HLTV 官方结论；stale/miss 不能当实时事实。',
          ].join('\n'));
          return true;
        }

        const apiReady = aiApiReady(currentConfig.ai);
        if (isMediaWarmScope(scope)) {
          const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
          const resolvedRecords = await resolveOneBotRecordSources(ctx, currentConfig.ai, ctx.event.message);
          const parsed = extractMediaCheckSources(targetArgs.join(' ').trim());
          const report = await formatMediaCacheWarm(
            currentConfig.ai,
            uniqueNonEmpty([...parsed.images, ...resolvedImages]),
            uniqueNonEmpty([...parsed.records, ...resolvedRecords]),
            apiReady,
            (source) => withGate('vision', () => getImageDataUrl(source), true),
          );
          ctx.reply([
            '维护预热: 多模态缓存',
            report,
            '后续: /media status；/media recent 3；/maint plan',
          ].join('\n'));
          return true;
        }

        if (isVisionWarmScope(scope)) {
          const resolvedImages = await resolveOneBotImageSources(ctx, ctx.event.message);
          const parsed = extractVisionCheckSources(targetArgs.join(' ').trim());
          const report = await formatVisionCacheWarm(
            currentConfig.ai,
            uniqueNonEmpty([...parsed, ...resolvedImages]),
            (source) => withGate('vision', () => getImageDataUrl(source), true),
          );
          ctx.reply([
            '维护预热: 图片缓存',
            report,
            '后续: /vision check <图片URL>；/vision test <图片URL>；/maint plan',
          ].join('\n'));
          return true;
        }

        if (isVoiceWarmScope(scope)) {
          const text = targetArgs.join(' ').trim();
          const report = await formatVoiceCacheWarm(
            currentConfig.ai,
            text,
            apiReady,
            (partText) => withGate('tts', () => generateVoice(currentConfig.ai, partText), true),
          );
          ctx.reply([
            '维护预热: 语音TTS缓存',
            report,
            '后续: /voice cache <文本>；/voice status；/maint plan',
          ].join('\n'));
          return true;
        }

        if (isGiftWarmScope(scope)) {
          const { gift, count } = parseGiftWarmArgs(targetArgs);
          if (ttsNeedsApi(currentConfig.ai) && !apiReady) {
            ctx.reply([
              '维护预热: 礼物谢礼TTS缓存',
              `礼物: ${gift}x${count}`,
              '预热动作: skipped/api-not-ready',
              '原因: 当前 TTS 需要 API 后端，但 api_url/model/api_key 不完整；先配置本地 TTS 或真实 API key。',
              '边界: 没生成缓存时不能说礼物语音已就绪；礼物感谢是拟态模板，不是核验原话。',
            ].join('\n'));
            return true;
          }
          const report = await warmGiftThanksVoice(currentConfig.ai, gift, count, ctx.groupId || 0, {
            generate: (text) => withGate('tts', () => generateVoice(currentConfig.ai, text), true),
          });
          ctx.reply([
            '维护预热: 礼物谢礼TTS缓存',
            report,
            '后续: /gift cache <礼物> [数量]；/gift status；/maint plan',
          ].join('\n'));
          return true;
        }

        ctx.reply('未知维护预热范围。可用: /maint warm plan|apply|cs|media|vision|voice|gift');
        return true;
      }

      if (action === 'plan' || action === 'runbook' || action === 'checklist' || action === '维护计划' || action === '巡检') {
        ctx.reply(formatMaintenanceRunbookPlan(currentConfig, ctx.bot.getRuntimeStats()));
        return true;
      }

      if (action === 'gc') {
        if (typeof global.gc !== 'function') {
          ctx.reply('gc 没开放。PM2 启动 Node 需要 --expose-gc，仓库里的 ecosystem.config.js 已经配了，重启后再试。');
          return true;
        }
        const before = process.memoryUsage();
        global.gc();
        const after = process.memoryUsage();
        ctx.reply([
          '手动 GC 跑完了',
          `heap: ${formatMb(before.heapUsed)}MB -> ${formatMb(after.heapUsed)}MB`,
          `rss: ${formatMb(before.rss)}MB -> ${formatMb(after.rss)}MB`,
        ].join('\n'));
        return true;
      }

      if (action === 'config' || action === '配置') {
        ctx.reply([
          '当前运行配置',
          `config_version: ${currentConfig.config_version || '未填写'} / ${CONFIG_VERSION}${(currentConfig.config_version || 0) < CONFIG_VERSION ? '，建议同步 config.example.json' : ''}`,
          `bot_qq: ${currentConfig.bot_qq || '未填写'}，self_id: ${ctx.event.self_id}`,
          `登录检查: 间隔${currentConfig.login_check_interval_seconds ?? 60}s，超时${currentConfig.login_check_api_timeout_ms ?? 5000}ms`,
          `预设: ${currentConfig.ai.active_preset || '无'}，trigger=${currentConfig.ai.trigger_mode}，随机=${currentConfig.ai.trigger_probability}，相关=${currentConfig.ai.related_reply_probability}`,
          `知识: ${currentConfig.ai.enable_knowledge ? 'on' : 'off'}，强制风格=${currentConfig.ai.knowledge_force_style ? 'on' : 'off'}，max=${currentConfig.ai.knowledge_max_chars}`,
          `记忆/RAG: ${currentConfig.ai.enable_memory_retrieval === false ? 'off' : 'on'} topK=${currentConfig.ai.memory_top_k} sim>=${currentConfig.ai.memory_min_similarity} 注入${currentConfig.ai.memory_inject_max_chars}字 索引上限${currentConfig.ai.memory_max_messages_per_session}/会话`,
          `多模态: 识图=${currentConfig.ai.enable_vision ? 'on' : 'off'}，听写=${currentConfig.ai.enable_stt ? 'on' : 'off'}，语音=${currentConfig.ai.enable_tts ? 'on' : 'off'}`,
          `真人停顿: ${currentConfig.ai.human_reply_delay_enabled === false ? 'off' : 'on'} 普通${currentConfig.ai.human_reply_delay_min_ms ?? 250}-${currentConfig.ai.human_reply_delay_max_ms ?? 1400}ms 强触发${currentConfig.ai.human_reply_delay_forced_min_ms ?? 120}-${currentConfig.ai.human_reply_delay_forced_max_ms ?? 650}ms`,
          `缓存: 搜索${currentConfig.ai.search_cache_max_entries}条，图片${currentConfig.ai.image_cache_max_mb}MB/${currentConfig.ai.image_cache_max_files}文件，TTS${currentConfig.ai.tts_cache_max_mb}MB，STT${currentConfig.ai.stt_cache_max_mb}MB`,
          `并发: AI ${currentConfig.ai.ai_global_concurrency} / 搜索 ${currentConfig.ai.search_global_concurrency} / 图 ${currentConfig.ai.vision_global_concurrency} / 听写 ${currentConfig.ai.stt_global_concurrency} / 语音 ${currentConfig.ai.tts_global_concurrency}，普通排队上限 ${currentConfig.ai.gate_passive_queue_max}`,
        ].join('\n'));
        return true;
      }

      if (action === 'login' || action === '登录') {
        const runtime = await ctx.bot.checkLoginNow();
        ctx.reply([
          '登录态检查',
          `OneBot: ${runtime.readyState} connected=${runtime.connected ? 'yes' : 'no'} pendingApi=${runtime.pendingApi} 断开${runtime.totalDisconnects} 早断${runtime.consecutiveEarlyDisconnects} 心跳重连${runtime.staleHeartbeatReconnects}`,
          `QQ登录: ${runtime.lastLoginOk ? 'ok' : '异常'} self=${runtime.lastLoginUserId || '-'} ${runtime.lastLoginNickname || ''} 失败${runtime.loginCheckFailures} 成功${runtime.loginCheckSuccesses}`,
          `检查时间: ${formatLoginTime(runtime.lastLoginCheckAt)}，最近OK: ${formatLoginTime(runtime.lastLoginOkAt)}`,
          ...(runtime.lastLoginError ? [`错误: ${runtime.lastLoginError}`] : []),
          ...(runtime.lastConnectionHint ? [`连接提示: ${runtime.lastConnectionHint}`] : []),
          ...(runtime.lastLoginOk ? [] : ['如果这里异常，但 Docker/PM2 都在线，优先去 NapCat WebUI 扫码或重新登录 QQ。']),
        ].join('\n'));
        return true;
      }

      const aiStats = getAiChatStats();
      const imageStats = getImageCacheStats();
      const searchStats = getSearchStats();
      const voiceStats = getVoiceStats(currentConfig.ai);
      const sttStats = getSttStats(currentConfig.ai);
      const csStats = getHltvStats();
      const knowledgeStats = getKnowledgeStats();
      const runtime = ctx.bot.getRuntimeStats();
      const mediaStats = getMediaObservabilitySnapshot();
      const mem = process.memoryUsage();
      ctx.reply([
        '维护状态',
        `config_version: ${currentConfig.config_version || '未填写'} / ${CONFIG_VERSION}${(currentConfig.config_version || 0) < CONFIG_VERSION ? '，偏旧' : ''}`,
        `OneBot: ${runtime.readyState} connected=${runtime.connected ? 'yes' : 'no'} pendingApi=${runtime.pendingApi} 断开${runtime.totalDisconnects} 早断${runtime.consecutiveEarlyDisconnects} 心跳重连${runtime.staleHeartbeatReconnects}`,
        `QQ登录: ${runtime.lastLoginOk ? 'ok' : '异常/未确认'} 检查${formatLoginTime(runtime.lastLoginCheckAt)} 失败${runtime.loginCheckFailures}${runtime.lastLoginError ? ` 错误=${runtime.lastLoginError}` : ''}`,
        ...(runtime.lastConnectionHint ? [`连接提示: ${runtime.lastConnectionHint}`] : []),
        `内存: heap ${formatMb(mem.heapUsed)}MB / rss ${formatMb(mem.rss)}MB`,
        `队列: ${aiStats.queuedGroups}群 待处理${aiStats.pendingJobs} 强触发${aiStats.forcedJobs} 最老${Math.round(aiStats.oldestQueueAgeMs / 1000)}s`,
        `闸门: AI ${aiStats.gates.ai.active}/${aiStats.gates.ai.limit}+${aiStats.gates.ai.queued} 搜索 ${aiStats.gates.search.active}/${aiStats.gates.search.limit}+${aiStats.gates.search.queued} 图 ${aiStats.gates.vision.active}/${aiStats.gates.vision.limit}+${aiStats.gates.vision.queued} 听写 ${aiStats.gates.stt.active}/${aiStats.gates.stt.limit}+${aiStats.gates.stt.queued} 语音 ${aiStats.gates.tts.active}/${aiStats.gates.tts.limit}+${aiStats.gates.tts.queued}`,
        `知识库: ${knowledgeStats.sections}块 ${knowledgeStats.chars}字 注入${knowledgeStats.selectHits}/${knowledgeStats.selectMisses} 审计${knowledgeStats.auditIssues} 自动批次${knowledgeStats.batches}`,
        `记忆/RAG: ${aiStats.memoryEnabled ? 'on' : 'off'} 内存${aiStats.memory.sessionsInMemory}/${aiStats.memory.maxSessionsInMemory}会话 磁盘${aiStats.memory.diskSessions}会话 索引${aiStats.memory.totalIndexed}条 检索${aiStats.memory.hits}/${aiStats.memory.misses}`,
        `AI回复缓存: ${aiStats.replyCacheEntries}/${aiStats.replyCacheMaxEntries}条 飞行${aiStats.replyInFlight} 命中${aiStats.replyCacheHits}/${aiStats.replyCacheMisses} 旁路${aiStats.replyCacheBypasses}`,
        `AI缓存策略Top: ${aiStats.replyCachePolicyTop.join(' / ') || '暂无样本'}`,
        `回复真实性: 证据${aiStats.evidenceTraceCount} 无实时${aiStats.realtimeIntentWithoutDataCount} 旧证据${aiStats.realtimeStaleEvidenceCount} 事实修正${aiStats.factGuardRepairCount} 质量修复${aiStats.qualityRepairCount} 输出修复${aiStats.outputRepairCount}`,
        `真人停顿: ${aiStats.humanReplyDelayCount}次 avg=${aiStats.humanReplyDelayAvgMs}ms 最近=${aiStats.lastHumanReplyDelayMs}ms`,
        ...(aiStats.lastEvidenceLedger.length > 0 ? [`最近证据账本: ${aiStats.lastEvidenceLedger.join(' / ').slice(0, 180)}`] : []),
        ...(aiStats.lastRealtimeFreshness.length > 0 ? [`最近实时证据: ${aiStats.lastRealtimeFreshness.join(' / ').slice(0, 160)}`] : []),
        `风格场景: ${aiStats.styleSceneTraceCount}条 最近${aiStats.lastStyleScene || '无'} Top ${aiStats.styleSceneTop.join(' / ') || '无'} 质量风险${aiStats.qualityIssueTraceCount}${aiStats.lastQualityIssues.length ? ` 最近=${aiStats.lastQualityIssues.join('/')}` : ''}`,
        `知识自动刷新: ${knowledgeStats.autoEnabled && currentConfig.ai.knowledge_auto_update !== false ? 'on' : 'off'} ${aiStats.knowledgeAutoRunning ? '刷新中' : '空闲'} 间隔${aiStats.knowledgeAutoIntervalMinutes || currentConfig.ai.knowledge_auto_interval_minutes || '-'}m`,
        ...(aiStats.lastKnowledgeTitles.length > 0 ? [`最近知识分区: ${aiStats.lastKnowledgeTitles.join(' / ')}`] : []),
        `搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries} 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 飞行${searchStats.inFlight}`,
        `CS实时缓存: fresh ${csStats.entries} / stale ${csStats.staleEntries} 命中${csStats.hits}/${csStats.misses} 写入${csStats.writes} 旧缓存兜底${csStats.staleServed}`,
        `多模态真实链路: 图${mediaStats.visionTraces}/${mediaStats.maxVisionTraces} 语音${mediaStats.voiceTraces}/${mediaStats.maxVoiceTraces} 回复${mediaStats.replyTraces}/${mediaStats.maxReplyTraces} 礼物${mediaStats.giftTraces}`,
        `多模态边界: ${mediaStats.boundary} ${mediaStats.hint}`,
        `图片缓存: ${imageStats.count}/${imageStats.maxFiles} ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB，最近清理${formatDate(imageStats.lastCleanupAt)} 删${imageStats.lastCleanupDeleted}`,
        `语音缓存: ${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles} ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB，最近清理${formatDate(voiceStats.lastCleanupAt)} 删${voiceStats.lastCleanupDeleted}`,
        `听写缓存: ${sttStats.cacheFiles}/${sttStats.maxCacheFiles} ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB，最近清理${formatDate(sttStats.lastCleanupAt)} 删${sttStats.lastCleanupDeleted}`,
        '可用: /maint plan 出总维护计划，/maint warm cs|media|voice|gift 预热热缓存，/maint login 查登录态，/maint storage 查运行目录和持久化文件，/maint clean 清缓存审计，/maint gc 手动GC，/maint config 看关键配置',
      ].join('\n'));
      return true;
    }

    // ===== 群白名单管理 =====
    if (ctx.command === 'addgroup') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const groupId = parseInt(ctx.args[0]) || ctx.groupId;
      if (!groupId) {
        ctx.reply('私聊里用法: /addgroup <群号>');
        return true;
      }
      if (config.enabled_groups.includes(groupId)) {
        ctx.reply(`ℹ️ 群 ${groupId} 已在白名单中`);
        return true;
      }
      try {
        const newConfig = updateConfigFile((raw) => {
          const current = Array.isArray(raw.enabled_groups)
            ? raw.enabled_groups.map((item) => Number(item)).filter((item) => Number.isSafeInteger(item) && item > 0)
            : [];
          raw.enabled_groups = [...new Set([...current, groupId])];
        });
        ctx.bot.updateConfig(newConfig);
        ctx.reply(`✅ 已将群 ${groupId} 加入白名单，并写入 config.json`);
      } catch (err) {
        config.enabled_groups.push(groupId);
        ctx.reply(`已临时加入群 ${groupId}，但写 config.json 失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    if (ctx.command === 'rmgroup') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const groupId = parseInt(ctx.args[0]);
      if (!groupId) {
        ctx.reply('用法: /rmgroup <群号>');
        return true;
      }
      if (!config.enabled_groups.includes(groupId)) {
        ctx.reply(`ℹ️ 群 ${groupId} 不在白名单中`);
        return true;
      }
      try {
        const newConfig = updateConfigFile((raw) => {
          const current = Array.isArray(raw.enabled_groups)
            ? raw.enabled_groups.map((item) => Number(item)).filter((item) => Number.isSafeInteger(item) && item > 0)
            : [];
          raw.enabled_groups = [...new Set(current.filter((item) => item !== groupId))];
        });
        ctx.bot.updateConfig(newConfig);
        ctx.reply(`✅ 已将群 ${groupId} 移出白名单，并写入 config.json`);
      } catch (err) {
        const idx = config.enabled_groups.indexOf(groupId);
        if (idx >= 0) config.enabled_groups.splice(idx, 1);
        ctx.reply(`已临时移出群 ${groupId}，但写 config.json 失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    // ===== 禁言/解禁（需要管理员权限） =====
    if (ctx.command === 'ban') {
      if (ctx.isPrivate || !ctx.groupId) {
        ctx.reply('这个得在群里用');
        return true;
      }
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /ban @某人 [时长(分钟)]');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      const duration = (parseInt(ctx.args.find((a) => /^\d+$/.test(a)) || '') || 10) * 60;

      ctx.bot.callApi('set_group_ban', {
        group_id: ctx.groupId,
        user_id: targetQQ,
        duration,
      });
      ctx.reply(`✅ 已禁言 ${duration / 60} 分钟`);
      return true;
    }

    if (ctx.command === 'unban') {
      if (ctx.isPrivate || !ctx.groupId) {
        ctx.reply('这个得在群里用');
        return true;
      }
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /unban @某人');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      ctx.bot.callApi('set_group_ban', {
        group_id: ctx.groupId,
        user_id: targetQQ,
        duration: 0,
      });
      ctx.reply('✅ 已解除禁言');
      return true;
    }

    // ===== 踢人 =====
    if (ctx.command === 'kick') {
      if (ctx.isPrivate || !ctx.groupId) {
        ctx.reply('这个得在群里用');
        return true;
      }
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /kick @某人');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      ctx.bot.callApi('set_group_kick', {
        group_id: ctx.groupId,
        user_id: targetQQ,
        reject_add_request: false,
      });
      ctx.reply('✅ 已移出群聊');
      return true;
    }

    // ===== 设置群头衔 =====
    if (ctx.command === 'title') {
      if (ctx.isPrivate || !ctx.groupId) {
        ctx.reply('这个得在群里用');
        return true;
      }
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /title @某人 <头衔>');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      const title = ctx.args.filter((a) => !/^@/.test(a)).join(' ');
      ctx.bot.callApi('set_group_special_title', {
        group_id: ctx.groupId,
        user_id: targetQQ,
        special_title: title,
        duration: -1,
      });
      ctx.reply(`✅ 已设置头衔: ${title || '(清除)'}`);
      return true;
    }

    return false;
  },
};
