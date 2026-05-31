import { Bot } from './bot';
import { MessageHandler } from './handler';
import { GroupMessageEvent } from './types';
import { CONFIG_PATH, loadConfig } from './config';
import * as fs from 'fs';
import * as path from 'path';

// 启动时加载.env文件（如果存在）
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // 不覆盖已有环境变量（让pm2/system的优先）
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    console.log(`[Bot] 已加载 .env 文件`);
  } catch (err) {
    console.warn(`[Bot] 加载.env失败:`, err instanceof Error ? err.message : err);
  }
}

loadDotEnv();

// 插件
import { helpPlugin } from './plugins/help';
import { pingPlugin } from './plugins/ping';
import { statusPlugin } from './plugins/status';
import { timePlugin } from './plugins/time';
import { funPlugin } from './plugins/fun';
import { diagPlugin } from './plugins/diag';
import { statsPlugin } from './plugins/stats';
import { adminPlugin } from './plugins/admin';
import { repeaterPlugin } from './plugins/repeater';
import { aiChatPlugin, shutdownAiChat, startAiChatBackgroundTasks } from './plugins/ai-chat';
import { registerWelcomeListener } from './plugins/welcome';
import { registerPokeListener } from './plugins/poke';
import { registerPrivateForward } from './plugins/private-forward';
import { registerRecallListener, recordMessage } from './plugins/recall';

function main(): void {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║       玩机器 QQ Bot v2.3         ║');
  console.log('  ║     OneBot v11 · NapCatQQ        ║');
  console.log('  ╚══════════════════════════════════╝');
  console.log('');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('');
    console.error('  ❌ 配置加载失败');
    console.error('  请复制 config.example.json 为 config.json 并填入配置');
    console.error(`  路径: ${CONFIG_PATH}`);
    console.error(`  原因: ${err instanceof Error ? err.message : String(err)}`);
    console.error('');
    process.exit(1);
  }

  console.log(`  🤖 名称: ${config.bot_name}`);
  console.log(`  🆔 Bot QQ: ${config.bot_qq || '未填写(以OneBot self_id为准)'}`);
  console.log(`  🔗 连接: ${config.ws_url}`);
  console.log(`  🎭 预设: ${config.ai?.active_preset || '未配置'}`);
  console.log(`  📡 触发: ${config.ai?.trigger_mode || 'command'}`);
  console.log(`  📋 群: ${config.enabled_groups.length > 0 ? config.enabled_groups.join(', ') : '全部群'}`);
  console.log(`  👑 管理: ${config.admin_qq.length > 0 ? config.admin_qq.join(', ') : '未设置'}`);
  console.log('');

  startAiChatBackgroundTasks(config.ai);

  const bot = new Bot(config);
  const handler = new MessageHandler(bot);

  // 注册插件（顺序：管理 > 统计 > 复读 > 工具 > 趣味 > AI兜底）
  handler.use(adminPlugin);
  handler.use(statsPlugin);
  handler.use(repeaterPlugin);  // 复读机（在AI之前，避免复读被AI截胡）
  handler.use(helpPlugin);
  handler.use(pingPlugin);
  handler.use(statusPlugin);
  handler.use(diagPlugin);
  handler.use(timePlugin);
  handler.use(funPlugin);
  handler.use(aiChatPlugin);    // AI 放最后

  // 注册非消息事件监听器
  registerWelcomeListener(bot);
  registerPokeListener(bot);
  registerPrivateForward(bot);
  registerRecallListener(bot, true);  // 撤回监控，不需要可改为false

  // 事件监听
  bot.onEvent((event) => {
    if (event.post_type === 'meta_event') return;

    if (event.post_type === 'message' && event.message_type === 'group') {
      const e = event as GroupMessageEvent;
      const name = e.sender.card || e.sender.nickname;
      console.log(`[群${e.group_id}] ${name}(${e.user_id}): ${e.raw_message}`);

      // 记录消息（用于撤回监控）
      recordMessage(e.message_id, name, e.raw_message);
    }

    void handler.handleEvent(event);
  });

  bot.connect();

  // 优雅退出
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[Bot] 正在关闭...');
    bot.close();
    shutdownAiChat();
    const timer = setTimeout(() => process.exit(exitCode), 500);
    if (exitCode === 0) timer.unref();
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // 内存监控：每5分钟检查一次，超过900MB主动GC，超过1300MB主动重启避免OOM
  const memMonitor = setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    if (heapMB > 900) {
      console.warn(`[Memory] 堆内存${heapMB}MB RSS=${rssMB}MB 触发GC`);
      if (global.gc) {
        try { global.gc(); } catch { /* */ }
      }
    }
    if (rssMB > 1300) {
      console.error(`[Memory] RSS ${rssMB}MB 接近上限 主动重启避免OOM`);
      shutdown(1);
    }
  }, 5 * 60 * 1000);
  memMonitor.unref();

  const fatalShutdown = (label: string, reason: unknown) => {
    const message = reason instanceof Error
      ? (reason.stack || reason.message)
      : String(reason);
    console.error(`[Fatal] ${label}:`, message);
    shutdown(1);
  };

  // 致命异常后退出，让 PM2 拉起干净进程，避免半坏状态假活着。
  process.on('uncaughtException', (err) => fatalShutdown('未捕获异常', err));
  process.on('unhandledRejection', (reason) => fatalShutdown('未处理的Promise拒绝', reason));
}

main();
