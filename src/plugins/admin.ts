import { CONFIG_VERSION, loadConfig, updateConfigFile } from '../config';
import { Plugin } from '../types';
import { getAiChatStats, startAiChatBackgroundTasks } from './ai-chat';
import { cleanupCache as cleanImageCache, getCacheStats as getImageCacheStats } from './image-cache';
import { auditKnowledge, getKnowledgeStats, pruneKnowledgeAutoLog } from './knowledge-base';
import { cleanSttCache, getSttStats } from './stt';
import { cleanVoiceCache, getVoiceStats } from './tts';
import { cleanSearchCache, getSearchStats } from './web-search';

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

export const adminPlugin: Plugin = {
  name: 'admin',
  description: '管理员命令 - 群管理、配置重载等',

  handler: async (ctx) => {
    const config = ctx.bot.getConfig();
    const isAdmin = config.admin_qq.includes(ctx.event.user_id);

    // ===== /mem 内存状态（任何人可查）=====
    if (ctx.command === 'mem' || ctx.command === 'memory') {
      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      const externalMB = Math.round(usage.external / 1024 / 1024);
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      ctx.reply([
        '内存状态',
        `堆使用: ${heapMB}/${heapTotalMB} MB`,
        `RSS: ${rssMB} MB`,
        `外部: ${externalMB} MB`,
        `运行: ${hours}h ${mins}m`,
        `Node: ${process.version}`,
      ].join('\n'));
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
        cleanSearchCache();
        cleanImageCache();
        cleanVoiceCache(currentConfig.ai);
        cleanSttCache(currentConfig.ai);
        pruneKnowledgeAutoLog(currentConfig.ai.knowledge_auto_log_retention_days || 14);
        const audit = auditKnowledge();
        const afterImage = getImageCacheStats();
        const afterSearch = getSearchStats();
        const afterVoice = getVoiceStats(currentConfig.ai);
        const afterStt = getSttStats(currentConfig.ai);
        ctx.reply([
          '维护清理跑完了',
          `搜索缓存: ${beforeSearch.cacheEntries} -> ${afterSearch.cacheEntries} 条`,
          `图片缓存: ${beforeImage.count}/${beforeImage.sizeMB}MB -> ${afterImage.count}/${afterImage.sizeMB}MB，最近删${afterImage.lastCleanupDeleted}`,
          `语音缓存: ${beforeVoice.cacheFiles}/${beforeVoice.sizeMB}MB -> ${afterVoice.cacheFiles}/${afterVoice.sizeMB}MB，最近删${afterVoice.lastCleanupDeleted}`,
          `听写缓存: ${beforeStt.cacheFiles}/${beforeStt.sizeMB}MB -> ${afterStt.cacheFiles}/${afterStt.sizeMB}MB，最近删${afterStt.lastCleanupDeleted}`,
          `知识库审计: ${audit.issues.length} 个问题`,
        ].join('\n'));
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
          `多模态: 识图=${currentConfig.ai.enable_vision ? 'on' : 'off'}，听写=${currentConfig.ai.enable_stt ? 'on' : 'off'}，语音=${currentConfig.ai.enable_tts ? 'on' : 'off'}`,
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
      const knowledgeStats = getKnowledgeStats();
      const runtime = ctx.bot.getRuntimeStats();
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
        `知识自动刷新: ${knowledgeStats.autoEnabled && currentConfig.ai.knowledge_auto_update !== false ? 'on' : 'off'} ${aiStats.knowledgeAutoRunning ? '刷新中' : '空闲'} 间隔${aiStats.knowledgeAutoIntervalMinutes || currentConfig.ai.knowledge_auto_interval_minutes || '-'}m`,
        ...(aiStats.lastKnowledgeTitles.length > 0 ? [`最近知识分区: ${aiStats.lastKnowledgeTitles.join(' / ')}`] : []),
        `搜索缓存: ${searchStats.cacheEntries}/${searchStats.maxEntries} 空${searchStats.negativeEntries} 命中${searchStats.hits}/${searchStats.misses} 飞行${searchStats.inFlight}`,
        `图片缓存: ${imageStats.count}/${imageStats.maxFiles} ${imageStats.sizeMB}/${imageStats.maxSizeMB}MB，最近清理${formatDate(imageStats.lastCleanupAt)} 删${imageStats.lastCleanupDeleted}`,
        `语音缓存: ${voiceStats.cacheFiles}/${voiceStats.maxCacheFiles} ${voiceStats.sizeMB}/${voiceStats.maxCacheMB}MB，最近清理${formatDate(voiceStats.lastCleanupAt)} 删${voiceStats.lastCleanupDeleted}`,
        `听写缓存: ${sttStats.cacheFiles}/${sttStats.maxCacheFiles} ${sttStats.sizeMB}/${sttStats.maxCacheMB}MB，最近清理${formatDate(sttStats.lastCleanupAt)} 删${sttStats.lastCleanupDeleted}`,
        '可用: /maint login 查登录态，/maint clean 清缓存审计，/maint gc 手动GC，/maint config 看关键配置',
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
