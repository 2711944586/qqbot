const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const { hasUsableApiKey, normalizeConfig } = require('../dist/config');
const kb = require('../dist/plugins/knowledge-base');
const { configureGates, getGateStats, withGate } = require('../dist/plugins/concurrency');
const search = require('../dist/plugins/web-search');
const tts = require('../dist/plugins/tts');
const stt = require('../dist/plugins/stt');
const aiChat = require('../dist/plugins/ai-chat');
const userProfile = require('../dist/plugins/user-profile');
const imageCache = require('../dist/plugins/image-cache');
const hltv = require('../dist/plugins/hltv-api');
const { csPlugin, __test: csTest } = require('../dist/plugins/cs');
const { csPredictPlugin, getCsPredictStats, buildCsPredictDigestForChat, __test: csPredictTest } = require('../dist/plugins/cs-predict');
const { csReportPlugin, __test: csReportTest } = require('../dist/plugins/cs-report');
const { csWatchPlugin, __test: csWatchTest } = require('../dist/plugins/cs-watch');
const { registerGiftThanksListener, __test: giftThanksTest } = require('../dist/plugins/gift-thanks');
const { registerPokeListener, __test: pokeTest } = require('../dist/plugins/poke');
const { repeaterPlugin } = require('../dist/plugins/repeater');
const { funPlugin, __test: funTest } = require('../dist/plugins/fun');
const { stickersPlugin, getStickerStats, __test: stickerTest } = require('../dist/plugins/stickers');
const replyPostprocess = require('../dist/plugins/reply-postprocess');
const { adminPlugin } = require('../dist/plugins/admin');
const { pingPlugin } = require('../dist/plugins/ping');
const { statusPlugin } = require('../dist/plugins/status');
const { diagPlugin, __test: diagTest } = require('../dist/plugins/diag');
const { helpPlugin } = require('../dist/plugins/help');
const { dailyPulsePlugin, __test: dailyPulseTest } = require('../dist/plugins/daily-pulse');
const { Bot } = require('../dist/bot');
const { MessageHandler } = require('../dist/handler');
const sanitize = require('../dist/message-sanitize');

const SOURCE_STATE_PATH = path.resolve(__dirname, '..', 'knowledge', 'source-state.json');

function firstText(message) {
  if (typeof message === 'string') return message;
  return message.find((seg) => seg.type === 'text')?.data.text;
}

function spawnNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.on('error', (err) => resolve({ status: -1, stdout, stderr: err.message }));
  });
}

function assertNoTechnicalChatFallback(text, label) {
  assert.ok(text && text.length > 0, `${label} should send a visible chat fallback`);
  assert.ok(
    !/API|HTTP|key|接口|trace|错误|超时|模型链路/i.test(text),
    `${label} should not leak technical failure wording: ${text}`,
  );
}

async function testOutgoingSanitize() {
  assert.strictEqual(sanitize.sanitizeOutgoingText('普通 😂 笑哭 🤣'), '普通 😂 笑哭 🤣');
  const softened = sanitize.sanitizeOutgoingText('不是哥们 这句需要去开头');
  assert.ok(!softened.startsWith('不是哥们'), 'formulaic opener should be softened at send boundary');
  assert.ok(softened.includes('这句需要去开头'), 'send-boundary softening should keep useful content');
  const softenedGeneric = sanitize.sanitizeOutgoingText('讲道理 换个说法看看');
  assert.ok(!softenedGeneric.startsWith('讲道理'), 'generic formulaic opener should be softened at send boundary');
  assert.ok(softenedGeneric.includes('换个说法看看'), 'generic opener softening should keep useful content');
  const softenedCatchphrase = sanitize.sanitizeOutgoingText('有点东西 这句需要去开头');
  assert.ok(!softenedCatchphrase.startsWith('有点东西'), 'catchphrase opener should be softened at send boundary');
  assert.ok(softenedCatchphrase.includes('这句需要去开头'), 'catchphrase opener softening should keep useful content');
  const message = sanitize.sanitizeOutgoingMessage([
    { type: 'text', data: { text: '别发😂笑哭' } },
    { type: 'image', data: { file: 'https://example.com/a.jpg' } },
  ]);
  assert.strictEqual(message[0].data.text, '别发😂笑哭');
  assert.strictEqual(message[1].type, 'image');
}

async function testBotMediaBatching() {
  const config = readConfig();
  const bot = new Bot(config);
  const calls = [];
  bot.callApiAsync = async (action, params, timeoutMs) => {
    calls.push({ action, params, timeoutMs });
    return { retcode: 0, data: { message_id: 100_000 + calls.length } };
  };

  const tracked = [];
  const ok = await bot.sendGroupMessage(6657, [
    { type: 'at', data: { qq: '42' } },
    { type: 'text', data: { text: ' 今日CS套餐' } },
    { type: 'image', data: { file: 'base64://abc' } },
    { type: 'text', data: { text: ' 图发完了' } },
    { type: 'record', data: { file: 'base64://def' } },
  ], (id) => tracked.push(id));

  assert.strictEqual(ok, true, 'mixed media send should succeed when every batch succeeds');
  assert.strictEqual(calls.length, 4, 'mixed text/image/record message should be split into stable media batches');
  assert.deepStrictEqual(calls.map((call) => call.action), ['send_group_msg', 'send_group_msg', 'send_group_msg', 'send_group_msg']);
  assert.deepStrictEqual(calls.map((call) => call.params.message.map((seg) => seg.type)), [
    ['at', 'text'],
    ['image'],
    ['text'],
    ['record'],
  ]);
  assert.deepStrictEqual(tracked, [100_001, 100_002, 100_003, 100_004], 'all sent batch message ids should be trackable');
}

async function testBotSendRetriesAndMediaFailureNotice() {
  const config = readConfig();
  const bot = new Bot(config);
  const quoteCalls = [];
  bot.callApiAsync = async (action, params, timeoutMs) => {
    quoteCalls.push({ action, params, timeoutMs });
    if (quoteCalls.length === 1) {
      throw new Error('Timeout: NTEvent serviceCmdMethod:NodeIKernelMsgService/sendMsg');
    }
    return { retcode: 0, data: { message_id: 110_000 + quoteCalls.length } };
  };

  const quoteOk = await bot.sendGroupMessage(6657, [
    { type: 'reply', data: { id: '42' } },
    { type: 'text', data: { text: ' 锐评一下Niko' } },
  ]);
  assert.strictEqual(quoteOk, true, 'text reply should retry without quote when NapCat sendMsg times out');
  assert.strictEqual(quoteCalls.length, 2, 'reply send should be retried once');
  assert.ok(quoteCalls[0].params.message.some((seg) => seg.type === 'reply'), 'first try should include quote');
  assert.ok(!quoteCalls[1].params.message.some((seg) => seg.type === 'reply'), 'retry should drop quote segment');
  assert.strictEqual(quoteCalls[0].timeoutMs, 30000, 'text send timeout should be longer than old default');

  const mediaCalls = [];
  bot.callApiAsync = async (action, params, timeoutMs) => {
    mediaCalls.push({ action, params, timeoutMs });
    if (params.message.some((seg) => seg.type === 'image')) {
      throw new Error('Timeout: NTEvent serviceCmdMethod:NodeIKernelMsgService/sendMsg');
    }
    return { retcode: 0, data: { message_id: 120_000 + mediaCalls.length } };
  };

  const mediaOk = await bot.sendGroupMessage(6657, [
    { type: 'at', data: { qq: '61' } },
    { type: 'text', data: { text: ' 今日CS队伍' } },
    { type: 'image', data: { file: 'base64://abc' } },
  ]);
  assert.strictEqual(mediaOk, true, 'daily CS text should still be sent when image send fails');
  assert.strictEqual(mediaCalls.length, 4, 'media failure should try text, image, image retry, visible notice');
  assert.deepStrictEqual(
    mediaCalls.map((call) => call.params.message.map((seg) => seg.type)),
    [['at', 'text'], ['image'], ['image'], ['text']],
    'image failure should add a text notice after retry',
  );
  assert.strictEqual(mediaCalls[1].timeoutMs, 45000, 'image send timeout should be extended');
  assert.ok(firstText(mediaCalls[3].params.message).includes('图这下没发出去'), 'media failure notice should be visible');
}

async function testBotLoginStatusStrictness() {
  const config = readConfig();
  config.login_check_interval_seconds = 0;

  const bot = new Bot(config);
  bot.ws = { readyState: 1 };
  bot.callApiAsync = async (action) => {
    assert.strictEqual(action, 'get_login_info');
    return { retcode: 0, data: {} };
  };

  let runtime = await bot.checkLoginNow();
  assert.strictEqual(runtime.lastLoginOk, false, 'empty get_login_info success must not be treated as logged in');
  assert.ok(runtime.lastLoginError.includes('user_id'), 'empty login response should explain missing user_id');

  bot.callApiAsync = async () => ({ retcode: 0, data: { user_id: config.bot_qq, nickname: 'smoke-bot' } });
  runtime = await bot.checkLoginNow();
  assert.strictEqual(runtime.lastLoginOk, true, 'valid user_id should mark login ok');
  assert.strictEqual(runtime.lastLoginUserId, config.bot_qq);
  assert.strictEqual(runtime.lastLoginNickname, 'smoke-bot');

  const mismatchBot = new Bot(config);
  mismatchBot.ws = { readyState: 1 };
  mismatchBot.callApiAsync = async () => ({ retcode: 0, data: { user_id: config.bot_qq + 1, nickname: 'wrong-bot' } });
  runtime = await mismatchBot.checkLoginNow();
  assert.strictEqual(runtime.lastLoginOk, false, 'bot_qq mismatch must not be treated as logged in');
  assert.ok(runtime.lastLoginError.includes('不匹配'), 'mismatch should be visible in runtime error');
  assert.strictEqual(runtime.lastLoginUserId, config.bot_qq + 1);
}

function readConfig() {
  return normalizeConfig(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.example.json'), 'utf-8')));
}

async function withPreservedFile(filepath, fn) {
  const existed = fs.existsSync(filepath);
  const original = existed ? fs.readFileSync(filepath) : null;
  try {
    await fn();
  } finally {
    if (existed) {
      fs.writeFileSync(filepath, original);
    } else if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
}

async function testConfig() {
  const config = readConfig();
  assert.strictEqual(config.config_version, 20260609);
  assert.strictEqual(config.login_check_interval_seconds, 30);
  assert.strictEqual(config.login_check_api_timeout_ms, 8000);
  assert.strictEqual(config.ai.trigger_probability, 0.08);
  assert.strictEqual(config.ai.passive_random_min_chars, 4);
  assert.strictEqual(config.ai.passive_random_allow_numeric, false);
  assert.strictEqual(config.ai.knowledge_max_chars, 2600);
  assert.strictEqual(config.ai.knowledge_force_style, true);
  assert.strictEqual(config.ai.related_reply_probability, 0.65);
  assert.strictEqual(config.ai.api_timeout_ms, 120000);
  assert.strictEqual(config.ai.aggression_level, 'medium');
  assert.strictEqual(config.ai.poke_reply_probability, 1);
  assert.strictEqual(config.ai.sticker_auto_reply_enabled, true);
  assert.strictEqual(config.ai.sticker_auto_reply_probability, 0.18);
  assert.strictEqual(config.ai.sticker_auto_group_cooldown_seconds, 45);
  assert.strictEqual(config.ai.sticker_auto_keyword_cooldown_seconds, 180);
  assert.strictEqual(config.ai.gift_voice_enabled, true);
  assert.strictEqual(config.ai.gift_voice_probability, 0.28);
  assert.strictEqual(config.ai.gift_voice_cooldown_seconds, 180);
  assert.strictEqual(config.ai.gift_voice_min_combo_events, 2);
  assert.strictEqual(config.ai.gift_voice_min_total_count, 8);
  assert.strictEqual(config.ai.human_reply_delay_enabled, true);
  assert.strictEqual(config.ai.human_reply_delay_min_ms, 250);
  assert.strictEqual(config.ai.human_reply_delay_max_ms, 1400);
  assert.strictEqual(config.ai.human_reply_delay_forced_min_ms, 120);
  assert.strictEqual(config.ai.human_reply_delay_forced_max_ms, 650);
  assert.strictEqual(config.ai.ai_global_concurrency, 2);
  assert.strictEqual(config.ai.search_global_concurrency, 2);
  assert.strictEqual(config.ai.vision_global_concurrency, 1);
  assert.strictEqual(config.ai.tts_global_concurrency, 1);
  assert.strictEqual(config.ai.stt_global_concurrency, 1);
  assert.strictEqual(config.ai.search_cache_max_entries, 1000);
  assert.strictEqual(config.ai.ai_reply_cache_max_entries, 300);
  assert.strictEqual(config.ai.image_cache_max_mb, 384);
  assert.strictEqual(config.ai.image_cache_max_file_mb, 6);
  assert.strictEqual(config.ai.image_cache_max_age_hours, 168);
  assert.strictEqual(config.ai.image_download_max_redirects, 3);
  assert.strictEqual(config.ai.image_cache_cleanup_interval_minutes, 30);
  assert.strictEqual(config.ai.image_cache_max_files, 3000);
  assert.strictEqual(config.ai.vision_payload_mode, 'auto');
  assert.strictEqual(config.ai.tts_model, 'mimo-v2.5-tts');
  assert.strictEqual(config.ai.tts_provider, 'auto');
  assert.strictEqual(config.ai.tts_local_command, '');
  assert.strictEqual(config.ai.tts_local_output_dir, 'voice_cache/local');
  assert.strictEqual(config.ai.tts_local_timeout_ms, 15000);
  assert.strictEqual(config.ai.tts_clone_model, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(config.ai.tts_clone_enabled, true);
  assert.strictEqual(config.ai.tts_sample_path, 'voice_sample.mp3');
  assert.strictEqual(config.ai.tts_max_chars, 180);
  assert.strictEqual(config.ai.tts_send_mode, 'base64');
  assert.strictEqual(config.ai.tts_timeout_ms, 30000);
  assert.strictEqual(config.ai.tts_cache_hours, 24);
  assert.strictEqual(config.ai.tts_cache_max_mb, 256);
  assert.strictEqual(config.ai.tts_cache_max_files, 1500);
  assert.strictEqual(config.ai.tts_sample_max_mb, 8);
  assert.strictEqual(config.ai.enable_stt, true);
  assert.strictEqual(config.ai.stt_model, 'mimo-v2.5-pro');
  assert.strictEqual(config.ai.stt_provider, 'auto');
  assert.strictEqual(config.ai.stt_payload_mode, 'auto');
  assert.strictEqual(config.ai.stt_record_format, 'mp3');
  assert.strictEqual(config.ai.stt_local_command, '');
  assert.strictEqual(config.ai.stt_local_timeout_ms, 15000);
  assert.strictEqual(config.ai.stt_max_records, 1);
  assert.strictEqual(config.ai.stt_max_file_mb, 4);
  assert.strictEqual(config.ai.stt_timeout_ms, 20000);
  assert.strictEqual(config.ai.stt_cache_hours, 24);
  assert.strictEqual(config.ai.stt_cache_max_mb, 96);
  assert.strictEqual(config.ai.stt_cache_max_files, 1500);
  assert.strictEqual(config.ai.enable_memory_retrieval, true);
  assert.strictEqual(config.ai.memory_top_k, 4);
  assert.strictEqual(config.ai.memory_min_similarity, 0.18);
  assert.strictEqual(config.ai.memory_inject_max_chars, 700);
  assert.strictEqual(config.ai.memory_max_messages_per_session, 700);
  assert.strictEqual(config.ai.memory_max_sessions_in_memory, 80);
  assert.strictEqual(config.ai.search_negative_cache_seconds, 60);
  assert.strictEqual(config.ai.knowledge_aggressive_auto_commit, true);
  assert.strictEqual(config.ai.knowledge_quarantine_long_quotes, false);
  assert.strictEqual(config.ai.knowledge_expansion_enabled, true);
  assert.strictEqual(config.ai.knowledge_expansion_batch_max_sources, 12);
  assert.strictEqual(config.ai.knowledge_auto_batch_max_sources, 6);
  assert.strictEqual(config.ai.gate_passive_queue_max, 20);
  assert.strictEqual(config.ai.context_compression_defer_when_busy, true);
  assert.ok(config.ai.trigger_keywords.includes('抽道具'), 'example trigger keywords should include daily CS utility');
  assert.ok(config.ai.trigger_keywords.includes('今日套餐'), 'example trigger keywords should include daily CS loadout');
  assert.strictEqual(hasUsableApiKey('在这里填入你的API密钥'), false, 'example placeholder key should not be treated as usable');
  assert.strictEqual(hasUsableApiKey('tp-xxxxxxxxxxxxxxxx'), false, 'masked placeholder key should not be treated as usable');
  assert.strictEqual(hasUsableApiKey('sk-live-test-key-1234567890'), true, 'real-looking key should be treated as usable');
}

async function testDoctorScript() {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, 'doctor.js')], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, `doctor should not fail without hard issues: ${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('doctor report'), 'doctor should print report header');
  assert.ok(result.stdout.includes('硬伤:'), 'doctor should print hard issue count');
  assert.ok(result.stdout.includes('运行数据目录可写: data'), 'doctor should check data/ write access');
  assert.ok(result.stdout.includes('CS实时缓存=data/cs-realtime-cache.json'), 'doctor should document CS realtime cache store parent');
  assert.ok(result.stdout.includes('本地TTS输出目录可写: voice_cache/local'), 'doctor should check local TTS output directory');
  assert.ok(result.stdout.includes('素材收件箱目录可写: knowledge/inbox'), 'doctor should check knowledge inbox directory');
}

async function testApiTestScript() {
  const rootDir = path.resolve(__dirname, '..');
  const configPath = path.join(rootDir, 'config.json');
  const cleanEnv = { ...process.env };
  delete cleanEnv.WANJIER_API_KEY;
  delete cleanEnv.OPENAI_API_KEY;
  delete cleanEnv.WANJIER_API_URL;
  delete cleanEnv.WANJIER_MODEL;
  delete cleanEnv.WANJIER_VISION_MODEL;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      assert.strictEqual(req.method, 'POST', 'api-test should send POST');
      assert.strictEqual(json.model, 'smoke-chat-model', 'api-test should use configured model');
      assert.ok(req.headers.authorization.includes('sk-smoke-api-test-key'), 'api-test should send configured key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: 'OK',
            },
            finish_reason: 'stop',
          },
        ],
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await withPreservedFile(configPath, async () => {
      const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.example.json'), 'utf-8'));
      config.ai.api_url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
      config.ai.api_key = 'sk-smoke-api-test-key-1234567890';
      config.ai.model = 'smoke-chat-model';
      config.ai.vision_model = 'smoke-chat-model';
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const ok = await spawnNode([path.resolve(__dirname, 'api-test.js'), '--no-env', '--timeout', '5000'], {
        cwd: rootDir,
        env: cleanEnv,
      });
      assert.strictEqual(ok.status, 0, `api-test should pass against mock server: ${ok.stdout}\n${ok.stderr}`);
      assert.ok(ok.stdout.includes('[api:test] OK'), 'api-test should report OK');

      config.ai.api_key = 'tp-xxxxxxxxxxxxxxxx';
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const missing = await spawnNode([path.resolve(__dirname, 'api-test.js'), '--no-env', '--timeout', '5000'], {
        cwd: rootDir,
        env: cleanEnv,
      });
      assert.strictEqual(missing.status, 3, `api-test should fail clearly without real key: ${missing.stdout}\n${missing.stderr}`);
      assert.ok(missing.stderr.includes('配置不完整'), 'api-test should explain missing config');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testConfigEnvApiKeyOverride() {
  const oldWanjier = process.env.WANJIER_API_KEY;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  try {
    process.env.WANJIER_API_KEY = 'sk-env-wanjier-key-1234567890';
    delete process.env.OPENAI_API_KEY;
    const config = readConfig();
    assert.strictEqual(config.ai.api_key, 'sk-env-wanjier-key-1234567890');
    assert.strictEqual(hasUsableApiKey(config.ai.api_key), true);
  } finally {
    if (typeof oldWanjier === 'string') process.env.WANJIER_API_KEY = oldWanjier;
    else delete process.env.WANJIER_API_KEY;
    if (typeof oldOpenAi === 'string') process.env.OPENAI_API_KEY = oldOpenAi;
    else delete process.env.OPENAI_API_KEY;
  }
}

async function testConfigSyncScript() {
  const tmpDir = path.resolve(__dirname, '..', 'logs', `sync-config-smoke-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpConfig = path.join(tmpDir, 'config.json');
  const tmpExample = path.resolve(__dirname, '..', 'config.example.json');
  const oldConfig = {
    config_version: 20260524,
    ws_url: 'ws://127.0.0.1:3001',
    bot_qq: 3853043835,
    bot_name: '玩机器',
    command_prefix: '/',
    admin_qq: [123456789],
    enabled_groups: [],
    ai: {
      api_url: 'https://example.com/v1/chat/completions',
      api_key: 'sk-real-user-key-should-stay',
      model: 'mimo-v2.5-pro',
      vision_model: 'mimo-v2.5-pro',
      active_preset: 'wanjier',
      presets: {
        wanjier: {
          name: '玩机器',
          description: 'old',
          system_prompt: 'old prompt',
        },
      },
      max_context_rounds: 30,
      max_context_messages: 30,
      max_tokens: 1000,
      temperature: 0.8,
      trigger_mode: 'smart',
      trigger_keywords: ['玩机器'],
      trigger_probability: 0.01,
      api_timeout_ms: 60000,
      cooldown_seconds: 1,
      context_expire_minutes: 120,
      enable_vision: true,
      enable_tts: false,
      tts_probability: 0.1,
    },
  };
  try {
    fs.writeFileSync(tmpConfig, `${JSON.stringify(oldConfig, null, 2)}\n`);
    const preview = spawnSync(process.execPath, [path.resolve(__dirname, 'sync-config.js'), '--config', tmpConfig, '--example', tmpExample], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf-8',
    });
    assert.strictEqual(preview.status, 0, `sync preview should pass: ${preview.stdout}\n${preview.stderr}`);
    assert.ok(preview.stdout.includes('将补齐'), 'sync preview should show pending changes');
    assert.strictEqual(JSON.parse(fs.readFileSync(tmpConfig, 'utf-8')).config_version, 20260524, 'preview must not write config');

    const applied = spawnSync(process.execPath, [path.resolve(__dirname, 'sync-config.js'), '--config', tmpConfig, '--example', tmpExample, '--apply'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf-8',
    });
    assert.strictEqual(applied.status, 0, `sync apply should pass: ${applied.stdout}\n${applied.stderr}`);
    const synced = JSON.parse(fs.readFileSync(tmpConfig, 'utf-8'));
    assert.strictEqual(synced.config_version, 20260609);
    assert.strictEqual(synced.ai.api_key, 'sk-real-user-key-should-stay', 'sync must not overwrite user api key');
    assert.strictEqual(synced.ai.trigger_probability, 0.08, 'sync should migrate old too-quiet passive trigger probability');
    assert.strictEqual(synced.ai.related_reply_probability, 0.65, 'sync should migrate old too-quiet related reply probability');
    assert.strictEqual(synced.ai.passive_random_min_chars, 4, 'sync should migrate old passive min chars');
    assert.strictEqual(synced.ai.api_timeout_ms, 120000, 'sync should migrate old too-short API timeout');
    assert.strictEqual(synced.ai.ai_reply_cache_max_entries, 300, 'sync should add reply cache max entries');
    assert.strictEqual(synced.ai.human_reply_delay_enabled, true, 'sync should add human reply delay switch');
    assert.strictEqual(synced.ai.human_reply_delay_min_ms, 250, 'sync should add human reply delay min');
    assert.strictEqual(synced.ai.human_reply_delay_max_ms, 1400, 'sync should add human reply delay max');
    assert.strictEqual(synced.ai.human_reply_delay_forced_min_ms, 120, 'sync should add forced human delay min');
    assert.strictEqual(synced.ai.human_reply_delay_forced_max_ms, 650, 'sync should add forced human delay max');
    assert.strictEqual(synced.ai.enable_memory_retrieval, true);
    assert.strictEqual(synced.ai.memory_top_k, 4);
    assert.notStrictEqual(synced.ai.presets.wanjier.system_prompt, 'old prompt', 'old built-in preset prompt should refresh on version lag');
    assert.ok(synced.ai.presets.wanjier.system_prompt.includes('上下文使用'), 'synced preset should contain current prompt rules');
    assert.ok(fs.existsSync(path.join(tmpDir, 'backups')), 'sync should create a local backup');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMemoryEnvOverrides() {
  const keys = [
    'WANJIER_ENABLE_MEMORY_RETRIEVAL',
    'WANJIER_MEMORY_TOP_K',
    'WANJIER_MEMORY_MIN_SIMILARITY',
    'WANJIER_MEMORY_INJECT_MAX_CHARS',
    'WANJIER_MEMORY_MAX_MESSAGES_PER_SESSION',
    'WANJIER_MEMORY_MAX_SESSIONS_IN_MEMORY',
    'WANJIER_HUMAN_REPLY_DELAY_ENABLED',
    'WANJIER_HUMAN_REPLY_DELAY_MIN_MS',
    'WANJIER_HUMAN_REPLY_DELAY_MAX_MS',
    'WANJIER_HUMAN_REPLY_DELAY_FORCED_MIN_MS',
    'WANJIER_HUMAN_REPLY_DELAY_FORCED_MAX_MS',
  ];
  const oldValues = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.WANJIER_ENABLE_MEMORY_RETRIEVAL = 'false';
    process.env.WANJIER_MEMORY_TOP_K = '0';
    process.env.WANJIER_MEMORY_MIN_SIMILARITY = '0.25';
    process.env.WANJIER_MEMORY_INJECT_MAX_CHARS = '0';
    process.env.WANJIER_MEMORY_MAX_MESSAGES_PER_SESSION = '88';
    process.env.WANJIER_MEMORY_MAX_SESSIONS_IN_MEMORY = '9';
    process.env.WANJIER_HUMAN_REPLY_DELAY_ENABLED = 'false';
    process.env.WANJIER_HUMAN_REPLY_DELAY_MIN_MS = '10';
    process.env.WANJIER_HUMAN_REPLY_DELAY_MAX_MS = '20';
    process.env.WANJIER_HUMAN_REPLY_DELAY_FORCED_MIN_MS = '5';
    process.env.WANJIER_HUMAN_REPLY_DELAY_FORCED_MAX_MS = '15';

    const config = readConfig();
    assert.strictEqual(config.ai.enable_memory_retrieval, false);
    assert.strictEqual(config.ai.memory_top_k, 0);
    assert.strictEqual(config.ai.memory_min_similarity, 0.25);
    assert.strictEqual(config.ai.memory_inject_max_chars, 0);
    assert.strictEqual(config.ai.memory_max_messages_per_session, 88);
    assert.strictEqual(config.ai.memory_max_sessions_in_memory, 9);
    assert.strictEqual(config.ai.human_reply_delay_enabled, false);
    assert.strictEqual(config.ai.human_reply_delay_min_ms, 10);
    assert.strictEqual(config.ai.human_reply_delay_max_ms, 20);
    assert.strictEqual(config.ai.human_reply_delay_forced_min_ms, 5);
    assert.strictEqual(config.ai.human_reply_delay_forced_max_ms, 15);
  } finally {
    for (const key of keys) {
      const oldValue = oldValues.get(key);
      if (typeof oldValue === 'string') process.env[key] = oldValue;
      else delete process.env[key];
    }
  }
}

async function testKnowledge() {
  const stats = kb.getKnowledgeStats();
  assert.ok(stats.sections >= 1, 'knowledge sections should load');
  const audit = kb.auditKnowledge();
  assert.ok(audit.sections >= 1, 'audit should see sections');
  const runtimePaths = kb.getKnowledgeRuntimePaths();
  const originalKnowledge = fs.readFileSync(runtimePaths.mainFile, 'utf-8');
  const auditSmokeTitle = `Smoke 来源评级缺失 ${Date.now()}`;
  const quoteAuditSmokeTitle = `Smoke 未核验原话 ${Date.now()}`;
  const longQuoteAuditSmokeTitle = `Smoke 长引用审计 ${Date.now()}`;
  const staleAuditSmokeTitle = `Smoke 时效事实风险 ${Date.now()}`;
  try {
    fs.appendFileSync(runtimePaths.mainFile, [
      '',
      '',
      `## ${auditSmokeTitle}`,
      '',
      '- 知识来源类型：public_fact',
      '- 置信度：high',
      '- 证据链接：https://example.com/smoke-missing-source-trust',
      '- 内容：用于验证主库审计能识别旧自动/候选块缺少来源评级。',
      '',
      `## ${quoteAuditSmokeTitle}`,
      '',
      '- 来源：B站搜索摘要 https://example.com/smoke-quote-audit',
      '- 内容：这是玩机器原话：老板大气，这波经济直接拉满。',
      '',
      `## ${longQuoteAuditSmokeTitle}`,
      '',
      '- 知识来源类型：public_summary',
      '- 来源评级：known (bilibili.com)',
      '- 证据链接：https://www.bilibili.com/video/BVsmokelongquoteaudit',
      '- 内容：',
      '「第一波这个残局其实已经很抽象了，先把默认架好，再看对面是不是还想从中路补这个信息。」',
      '「第二波道具一交出来，队友如果没有同步补枪，这个包点压力就会一下子全压到一个人身上。」',
      '「第三波他还想硬接，这个决策就不是枪法问题了，是经济、信息和地图控制一起崩掉的连锁反应。」',
      '「第四波你再回头看，真正该记进素材库的是这个场景判断，不是把整段字幕搬进去当可复读文本。」',
      '',
      `## ${staleAuditSmokeTitle}`,
      '',
      '- 知识来源类型：public_fact',
      '- 置信度：high',
      '- 内容：最新HLTV排名现在NAVI第一，Vitality第二，Spirit第三。',
      '- 使用规则：回答排名问题时可以直接引用。',
      '',
    ].join('\n'), 'utf-8');
    const sourceAudit = kb.auditKnowledge();
    assert.ok(
      sourceAudit.issues.some((item) => item.title.includes('来源评级缺失') && item.title.includes(auditSmokeTitle)),
      'audit should flag committed public fact blocks that miss source trust rating',
    );
    assert.ok(
      sourceAudit.issues.some((item) => item.title.includes('未核验原话声称') && item.title.includes(quoteAuditSmokeTitle)),
      'audit should flag committed sections that claim unsupported original quotes',
    );
    assert.ok(
      sourceAudit.issues.some((item) => item.title.includes('长转写/长引用需摘要化') && item.title.includes(longQuoteAuditSmokeTitle)),
      'audit should flag committed long transcript-like quote blocks',
    );
    const freshness = kb.inspectKnowledgeFreshness(30);
    const staleIssue = freshness.issues.find((item) => item.title.includes(staleAuditSmokeTitle));
    assert.ok(staleIssue, 'freshness inspection should flag realtime-like public fact blocks without boundaries');
    assert.strictEqual(staleIssue.level, 'hard', 'public realtime facts without evidence/freshness boundary should be hard risk');
    assert.ok(staleIssue.missing.includes('证据链接'), 'freshness inspection should report missing evidence URLs');
    assert.ok(staleIssue.missing.some((item) => item.includes('fresh')), 'freshness inspection should report missing fresh/stale boundary');
    assert.ok(staleIssue.advice.includes('/cs verify ranking'), 'freshness inspection should suggest CS verification for ranking facts');
    assert.ok(staleIssue.advice.includes('不能当实时结论'), 'freshness inspection should forbid stale/miss realtime wording');
    assert.ok(staleIssue.remediation.includes('/cs evidence ranking'), 'freshness inspection should suggest CS evidence review for ranking facts');
    assert.ok(staleIssue.remediation.includes('管理员 /cs warm plan ranking'), 'freshness inspection should suggest CS warm plan for ranking facts');
    const freshnessByTitle = kb.findKnowledgeFreshnessIssuesForTitles([staleAuditSmokeTitle], 5);
    assert.ok(
      freshnessByTitle.some((item) => item.title.includes(staleAuditSmokeTitle) && item.level === 'hard'),
      'freshness lookup should flag actually selected knowledge titles',
    );
  } finally {
    fs.writeFileSync(runtimePaths.mainFile, originalKnowledge, 'utf-8');
    kb.auditKnowledge();
  }

  const batchId = `smoke_${Date.now().toString(36)}`;
  const candidate = kb.previewKnowledgeCandidate(
    'smoke public fact',
    'MachineWJQ 6657 public fact summary https://www.hltv.org/smoke',
    'smoke',
    { sourceType: 'public_fact', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.strictEqual(candidate.sourceTrust, 'trusted', 'trusted HLTV evidence should be rated trusted');
  assert.ok(candidate.markdown.includes('快照时间'), 'public fact candidates should carry snapshot time before commit');
  assert.ok(candidate.markdown.includes('时效边界'), 'public fact candidates should carry freshness boundary before commit');
  assert.ok(candidate.markdown.includes('/cs verify'), 'public fact freshness boundary should suggest CS verification');
  assert.ok(candidate.markdown.includes('/cs evidence'), 'public fact freshness boundary should suggest CS evidence review');
  assert.ok(
    kb.recommendKnowledgeCandidateAction(candidate).includes('/kb commit'),
    'trusted quality-passing candidate should recommend commit action',
  );
  const action = kb.autoCommitKnowledgeCandidate(candidate, { batchId, maxBlockChars: 800 });
  assert.strictEqual(action, 'committed');
  const committedText = fs.readFileSync(runtimePaths.mainFile, 'utf-8');
  const committedBlockStart = committedText.indexOf(`kb:auto batch=${batchId}`);
  const committedBlock = committedBlockStart >= 0 ? committedText.slice(committedBlockStart, committedBlockStart + 1200) : '';
  assert.ok(committedBlock.includes('快照时间'), 'auto-committed public fact block should keep snapshot time');
  assert.ok(committedBlock.includes('时效边界'), 'auto-committed public fact block should keep freshness boundary');
  assert.ok(committedBlock.includes('stale/miss 不能当实时结论'), 'auto-committed public fact block should forbid stale/miss realtime claims');
  const batches = kb.listKnowledgeBatches(20);
  assert.ok(batches.some((batch) => batch.batchId === batchId), 'batch should be logged');
  const rollback = kb.rollbackKnowledgeBatch(batchId);
  assert.ok(rollback.removedBlocks >= 1, 'rollback should remove committed block');

  const reviewBatch = `smoke_review_${Date.now().toString(36)}`;
  const reviewCandidate = kb.previewKnowledgeCandidate(
    'smoke 礼物 长句 待核验',
    '这是公开搜索摘要，不是原话。礼物感谢只写拟态模板 https://example.com/review-smoke',
    'smoke-review',
    { sourceType: 'public_summary', confidence: 'medium', autoCommitEligible: true, risk: 'needs_source' },
  );
  const reviewAction = kb.autoCommitKnowledgeCandidate(reviewCandidate, { batchId: reviewBatch, maxBlockChars: 800 });
  assert.strictEqual(reviewAction, 'pending', 'review/risky candidates should stay pending until manual review');
  assert.ok(
    reviewCandidate.qualityIssues.includes('risk needs_source'),
    'review candidate should record the quality gate reason',
  );
  assert.ok(
    kb.describeKnowledgeCandidateQuality(reviewCandidate).includes('未通过'),
    'review candidate quality summary should be visible to admins',
  );
  assert.ok(
    kb.recommendKnowledgeCandidateAction(reviewCandidate).includes('暂缓'),
    'unknown/needs_source candidate should recommend pausing until source issues are fixed',
  );
  const reviewRollback = kb.rollbackKnowledgeBatch(reviewBatch);
  assert.strictEqual(reviewRollback.removedBlocks, 0, 'pending review candidate should not write a rollbackable block');
  kb.dropKnowledgeCandidate(reviewCandidate.id);

  const quoteRiskCandidate = kb.previewKnowledgeCandidate(
    'smoke 原话 风险',
    '这是玩机器原话：老板大气，这波经济直接拉满。 https://example.com/quote-risk-smoke',
    'smoke-quote-risk',
    { sourceType: 'public_summary', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.ok(
    quoteRiskCandidate.qualityIssues.includes('unsupported original quote claim'),
    'candidate quality should flag unsupported original quote claims',
  );
  assert.ok(
    kb.describeKnowledgeCandidateQuality(quoteRiskCandidate).includes('未核验原话声称'),
    'candidate quality summary should localize unsupported quote risk',
  );
  assert.ok(
    kb.recommendKnowledgeCandidateAction(quoteRiskCandidate).includes('短摘要'),
    'unsupported quote candidates should recommend summary/template cleanup',
  );
  kb.dropKnowledgeCandidate(quoteRiskCandidate.id);

  const sceneQuoteRiskCandidate = kb.previewKnowledgeCandidate(
    'smoke 名场面台词 风险',
    '请整理成玩机器名场面台词，一字不差那种。 https://example.com/scene-quote-risk-smoke',
    'smoke-scene-quote-risk',
    { sourceType: 'public_summary', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.ok(
    sceneQuoteRiskCandidate.qualityIssues.includes('unsupported original quote claim'),
    'candidate quality should flag famous-scene/verbatim quote claims',
  );
  const sceneQuoteSafeCandidate = kb.previewKnowledgeCandidate(
    'smoke 场景卡 安全边界',
    '这是场景卡，不是玩机器直播台词原文。 https://example.com/scene-quote-safe-smoke',
    'smoke-scene-quote-safe',
    { sourceType: 'public_summary', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.ok(
    !sceneQuoteSafeCandidate.qualityIssues.includes('unsupported original quote claim'),
    'candidate quality should allow explicit non-verbatim live-caption boundaries',
  );
  kb.dropKnowledgeCandidate(sceneQuoteRiskCandidate.id);
  kb.dropKnowledgeCandidate(sceneQuoteSafeCandidate.id);

  const longTranscriptBatch = `smoke_long_transcript_${Date.now().toString(36)}`;
  const longTranscriptCandidate = kb.previewKnowledgeCandidate(
    'smoke 长引用 风险',
    [
      '公开视频摘要 https://www.bilibili.com/video/BVsmokelongquote',
      '「第一波这个残局其实已经很抽象了，先把默认架好，再看对面是不是还想从中路补这个信息。」',
      '「第二波道具一交出来，队友如果没有同步补枪，这个包点压力就会一下子全压到一个人身上。」',
      '「第三波他还想硬接，这个决策就不是枪法问题了，是经济、信息和地图控制一起崩掉的连锁反应。」',
      '「第四波你再回头看，真正该记进素材库的是这个场景判断，不是把整段字幕搬进去当可复读文本。」',
    ].join('\n'),
    'smoke-long-transcript',
    { sourceType: 'public_summary', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.ok(
    longTranscriptCandidate.qualityIssues.includes('long transcript needs summarizing'),
    'candidate quality should flag long transcript-like quote blocks without explicit original-quote wording',
  );
  assert.ok(
    kb.describeKnowledgeCandidateQuality(longTranscriptCandidate).includes('长转写/长引用需摘要化'),
    'candidate quality summary should localize long transcript risk',
  );
  assert.ok(
    kb.recommendKnowledgeCandidateAction(longTranscriptCandidate).includes('场景/短摘要/可用话术'),
    'long transcript candidates should recommend scene/summary/template cleanup',
  );
  const longTranscriptAction = kb.autoCommitKnowledgeCandidate(longTranscriptCandidate, {
    batchId: longTranscriptBatch,
    maxBlockChars: 800,
  });
  assert.strictEqual(longTranscriptAction, 'pending', 'long transcript-like candidates should not auto commit');
  kb.dropKnowledgeCandidate(longTranscriptCandidate.id);

  const riskyBatch = `smoke_risky_${Date.now().toString(36)}`;
  const riskyCandidate = kb.previewKnowledgeCandidate(
    'smoke risky public fact',
    '看起来像公开事实但来自内网来源 http://127.0.0.1:55123/private',
    'smoke-risky',
    { sourceType: 'public_fact', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  assert.strictEqual(riskyCandidate.sourceTrust, 'risky', 'private/local evidence should be rated risky');
  const riskyAction = kb.autoCommitKnowledgeCandidate(riskyCandidate, { batchId: riskyBatch, maxBlockChars: 800 });
  assert.strictEqual(riskyAction, 'pending', 'risky source domain should block auto commit');
  assert.ok(
    riskyCandidate.qualityIssues.includes('risky source domain'),
    'risky candidate should record source domain quality issue',
  );
  assert.ok(
    kb.recommendKnowledgeCandidateAction(riskyCandidate).includes('/kb drop'),
    'risky candidate should recommend dropping instead of committing',
  );
  kb.dropKnowledgeCandidate(riskyCandidate.id);

  const paths = kb.getKnowledgeRuntimePaths();
  const quarantineFiles = fs.existsSync(paths.quarantineDir)
    ? fs.readdirSync(paths.quarantineDir).filter((file) => file.includes('smoke')).length
    : 0;
  assert.strictEqual(quarantineFiles, 0, 'knowledge auto write should not create quarantine files');
}

async function testKnowledgeSourceState() {
  await withPreservedFile(SOURCE_STATE_PATH, async () => {
    if (fs.existsSync(SOURCE_STATE_PATH)) fs.unlinkSync(SOURCE_STATE_PATH);
    const now = 1_700_000_000_000;
    const sources = [
      { id: 'hltv-smoke', query: 'HLTV smoke https://www.hltv.org/matches', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 60 },
      { id: 'bilibili-smoke', query: 'Bilibili smoke https://www.bilibili.com/video/BVsmoke', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 60 },
      { id: 'unknown-smoke', query: 'unknown smoke source without evidence', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 60 },
    ];

    kb.markKnowledgeSourceRefreshed('hltv-smoke', now - 10 * 60 * 1000);
    kb.markKnowledgeSourceRefreshed('bilibili-smoke', now - 90 * 60 * 1000);

    const due = kb.filterDueKnowledgeSources(sources, 10, now).map((source) => source.id);
    assert.deepStrictEqual(due, ['bilibili-smoke', 'unknown-smoke'], 'source interval filtering should skip recently refreshed sources');

    const limited = kb.filterDueKnowledgeSources(sources, 1, now).map((source) => source.id);
    assert.deepStrictEqual(limited, ['bilibili-smoke'], 'source interval filtering should respect the batch limit');

    const state = kb.getKnowledgeSourceState();
    assert.strictEqual(state['hltv-smoke'], now - 10 * 60 * 1000);
    assert.strictEqual(state['bilibili-smoke'], now - 90 * 60 * 1000);

    const report = kb.inspectKnowledgeSources(sources, { now, limit: 10 });
    assert.strictEqual(report.fresh, 1, 'source inspection should count fresh sources');
    assert.strictEqual(report.due, 1, 'source inspection should count due sources');
    assert.strictEqual(report.never, 1, 'source inspection should count never-refreshed sources');
    assert.strictEqual(report.autoCommitEligible, 2, 'source inspection should count auto-eligible config rows');
    assert.strictEqual(report.trustedConfigured, 2, 'source inspection should count config trusted rows');
    assert.strictEqual(report.trustedDomains, 1, 'source inspection should classify HLTV evidence as trusted');
    assert.strictEqual(report.riskyDomains, 0, 'source inspection should not mark public smoke sources as risky');
    const hltvRow = report.rows.find((row) => row.id === 'hltv-smoke');
    const bilibiliRow = report.rows.find((row) => row.id === 'bilibili-smoke');
    const unknownRow = report.rows.find((row) => row.id === 'unknown-smoke');
    assert.ok(hltvRow && hltvRow.status === 'fresh', 'HLTV smoke source should be fresh');
    assert.strictEqual(hltvRow.sourceTrust, 'trusted', 'HLTV smoke source should be trusted');
    assert.strictEqual(hltvRow.autoWriteState, 'allowed', 'trusted public_fact should pass source auto-write preflight');
    assert.ok(bilibiliRow && bilibiliRow.status === 'due', 'Bilibili smoke source should be due');
    assert.strictEqual(bilibiliRow.sourceTrust, 'known', 'Bilibili smoke source should be known');
    assert.strictEqual(bilibiliRow.autoWriteState, 'manual-only', 'manual config should stay manual-only');
    assert.ok(unknownRow && unknownRow.status === 'never', 'unknown smoke source should be never refreshed');
    assert.strictEqual(unknownRow.sourceTrust, 'unknown', 'unknown smoke source should stay unknown');
    assert.strictEqual(unknownRow.autoWriteState, 'blocked', 'unknown public_fact should block auto-write');
  });
}

async function testKnowledgeUrlImportCommand() {
  const longBody = '这是一段很长的正文，应该只被截成短摘而不是整页写进去。'.repeat(40);
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/article?from=smoke#ignored' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head>
          <title>Smoke HLTV import title</title>
          <meta property="og:site_name" content="SmokeSite">
          <meta name="description" content="这是一条可公开核验的短摘要，用于测试 URL 导入候选。">
          <script>throw new Error('script should not enter candidate')</script>
        </head>
        <body>
          <h1>Smoke HLTV import title</h1>
          <p>${longBody}</p>
          <p>第二段也不应该整段灌入候选。</p>
        </body>
      </html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/redirect`;

  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(38_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  try {
    handler.handleEvent(makePlainEvent(820, config.admin_qq[0], `/kb import-url ${url}`));
    await waitFor(() => sent.length === 1, 'kb import-url command', 5000);
    const text = firstText(sent[0].message);
    assert.ok(text.includes('URL候选'), '/kb import-url should create a pending candidate');
    assert.ok(text.includes('Smoke HLTV import title'), 'URL candidate should include page title');
    assert.ok(text.includes('页面摘要'), 'URL candidate should include meta description');
    assert.ok(text.includes('来源评级'), 'URL candidate should expose source trust rating');
    assert.ok(text.includes('自动质量闸'), 'URL candidate should expose quality gate state');
    assert.ok(text.includes('行动建议'), 'URL candidate should expose the next safe admin action');
    assert.ok(!text.includes('script should not enter candidate'), 'URL import should remove scripts');
    assert.ok(!text.includes(longBody), 'URL import must not dump full page body into chat');
    const id = (text.match(/URL候选\s+(\S+)/) || [])[1];
    assert.ok(id, 'URL import response should expose candidate id');
    const candidate = kb.getKnowledgeCandidate(id);
    assert.ok(candidate, 'URL import should store candidate for show/commit flow');
    assert.strictEqual(candidate.autoCommitEligible, false, 'URL imports must not auto-commit');
    assert.strictEqual(candidate.risk, 'review', 'URL imports should require admin review');
    assert.strictEqual(candidate.sourceTrust, 'risky', 'local URL imports should be marked as risky source');
    assert.ok(candidate.evidenceUrls.some((item) => item.includes('/article?from=smoke')), 'candidate should keep final evidence URL');
    assert.ok(candidate.markdown.length < 1400, 'URL import candidate should stay compact');
    kb.dropKnowledgeCandidate(id);

    handler.handleEvent(makePlainEvent(821, 42, `/kb import-url ${url}`));
    await waitFor(() => sent.length === 2, 'non-admin kb import-url denial', 5000);
    assert.ok(firstText(sent[1].message).includes('管理员'), 'non-admin URL import should be denied');

    handler.handleEvent(makePlainEvent(822, 42, '/kb trust https://www.hltv.org/matches'));
    await waitFor(() => sent.length === 3, 'kb trust hltv', 5000);
    const trustedText = firstText(sent[2].message);
    assert.ok(trustedText.includes('知识来源评级预检'), '/kb trust should render source trust preflight');
    assert.ok(trustedText.includes('评级: trusted'), '/kb trust should classify HLTV as trusted');
    assert.ok(trustedText.includes('public_fact'), '/kb trust should explain public fact policy for trusted sources');

    handler.handleEvent(makePlainEvent(823, 42, `/kb trust ${url}`));
    await waitFor(() => sent.length === 4, 'kb trust risky local url', 5000);
    const riskyText = firstText(sent[3].message);
    assert.ok(riskyText.includes('评级: risky'), '/kb trust should classify local URLs as risky');
    assert.ok(riskyText.includes('禁止自动写库'), '/kb trust should explain risky source boundary');

    await withPreservedFile(SOURCE_STATE_PATH, async () => {
      if (fs.existsSync(SOURCE_STATE_PATH)) fs.unlinkSync(SOURCE_STATE_PATH);
      kb.markKnowledgeSourceRefreshed('hltv-top20', Date.now() - 5 * 60 * 1000);
      handler.handleEvent(makePlainEvent(825, 42, '/kb sources 4'));
      await waitFor(() => sent.length === 5, 'kb sources inspect command', 5000);
      const sourcesText = firstText(sent[4].message);
      assert.ok(sourcesText.includes('知识来源体检'), '/kb sources should render source inspection panel');
      assert.ok(sourcesText.includes('只读'), '/kb sources should state it is read-only');
      assert.ok(sourcesText.includes('source-state'), '/kb sources should say it does not alter source state');
      assert.ok(/fresh|due|never/.test(sourcesText), '/kb sources should expose freshness buckets');
      assert.ok(sourcesText.includes('来源='), '/kb sources should expose source trust per row');
      assert.ok(sourcesText.includes('auto='), '/kb sources should expose auto-write preflight per row');
      assert.ok(sourcesText.includes('unknown/risky'), '/kb sources should explain factual boundary for untrusted sources');
    });

    handler.handleEvent(makePlainEvent(826, 42, '/kb stale 5'));
    await waitFor(() => sent.length === 6, 'kb stale freshness command', 5000);
    const staleText = firstText(sent[5].message);
    assert.ok(staleText.includes('知识库时效事实体检'), '/kb stale should render freshness panel');
    assert.ok(staleText.includes('只读'), '/kb stale should state it is read-only');
    assert.ok(staleText.includes('fresh/stale'), '/kb stale should explain freshness boundaries');
    assert.ok(staleText.includes('/cs verify'), '/kb stale should point current facts to CS verification');
    assert.ok(staleText.includes('/cs evidence'), '/kb stale should point current facts to CS evidence review');
    assert.ok(staleText.includes('/cs warm plan'), '/kb stale should point current facts to prewarm planning');
    assert.ok(staleText.includes('不能当实时结论'), '/kb stale should forbid stale/miss realtime wording');

    const runtimePaths = kb.getKnowledgeRuntimePaths();
    const inboxGoodPath = path.join(runtimePaths.inboxDir, `smoke-inbox-good-${Date.now()}.md`);
    const inboxRiskPath = path.join(runtimePaths.inboxDir, `smoke-inbox-risk-${Date.now()}.txt`);
    let inboxCandidateIds = [];
    try {
      fs.writeFileSync(inboxGoodPath, [
        '标题：烟花礼物感谢拟态样本',
        '来源：https://www.bilibili.com/video/BVsmokeGift',
        '类型：礼物拟态模板',
        '',
        '场景：',
        '- 观众送烟花后，先短促感谢，再接一个经济梗。',
        '可用话术：',
        '- 感谢老板，这波经济直接拉满。',
        '禁用：',
        '- 不要说成现实主播本人礼物原话。',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(inboxRiskPath, [
        '这是玩机器原话：Vitality 现在阵容已经确定，HLTV排名世界第一。',
        '00:01 主播：这句我逐字复刻一下，而且保留很长一段没有整理的直播口播内容，用来模拟完整字幕被直接塞进 inbox 的风险。',
        '00:03 弹幕：继续继续，这里还有多轮弹幕和主播对话，没有被压成场景、摘要、可用话术和禁用边界。',
        '00:05 主播：完整字幕直接搬进来会让机器人复读很长的素材，也容易误称本人原话，所以需要先拆成结构化模板。',
        '00:07 主播：这段还没整理成场景摘要，也没有公开来源链接，却在说当前阵容和排名。',
      ].join('\n'), 'utf-8');

      handler.handleEvent(makePlainEvent(828, config.admin_qq[0], '/kb inbox 5'));
      await waitFor(() => sent.length === 7, 'kb inbox material inspection command', 5000);
      const inboxText = firstText(sent[6].message);
      assert.ok(inboxText.includes('知识库 inbox 素材体检'), '/kb inbox should render inbox material inspection panel');
      assert.ok(inboxText.includes('只读，不生成候选、不写库'), '/kb inbox should be read-only');
      assert.ok(inboxText.includes('跳过 README.md'), '/kb inbox should explicitly skip README helper docs');
      assert.ok(inboxText.includes(path.basename(inboxGoodPath)), '/kb inbox should include fresh local material file');
      assert.ok(inboxText.includes(path.basename(inboxRiskPath)), '/kb inbox should include risky local material file');
      assert.ok(inboxText.includes('gift_template') || inboxText.includes('mixed'), '/kb inbox should classify gift/style material');
      assert.ok(inboxText.includes('未核验原话/逐字说法'), '/kb inbox should flag unsupported original quote claims');
      assert.ok(inboxText.includes('时效事实缺来源'), '/kb inbox should flag realtime facts without evidence links');
      assert.ok(inboxText.includes('split-first'), '/kb inbox should suggest splitting risky long/original material before ingest');
      assert.ok(inboxText.includes('不要整段写库'), '/kb inbox should tell admins to summarize long transcript material');
      assert.ok(inboxText.includes('实时事实要补公开来源'), '/kb inbox should preserve factual source boundary');

      const inboxReport = kb.inspectKnowledgeInbox(10);
      assert.ok(inboxReport.rows.some((row) => row.file === path.basename(inboxGoodPath)), 'inbox inspector should include good smoke file');
      assert.ok(inboxReport.rows.some((row) => row.file === path.basename(inboxRiskPath) && row.risk === 'needs_source'), 'inbox inspector should mark risky smoke file needs_source');
      const inboxCandidates = kb.previewInboxCandidates('summary');
      inboxCandidateIds = inboxCandidates.map((item) => item.id);
      assert.ok(inboxCandidates.some((item) => item.source.includes(path.basename(inboxGoodPath))), 'inbox ingest preview should create candidate for good smoke file');
      assert.ok(inboxCandidates.every((item) => !/knowledge\/inbox\/README\.md/i.test(item.source)), 'inbox ingest preview should skip README helper docs');
    } finally {
      for (const id of inboxCandidateIds) kb.dropKnowledgeCandidate(id);
      if (fs.existsSync(inboxGoodPath)) fs.unlinkSync(inboxGoodPath);
      if (fs.existsSync(inboxRiskPath)) fs.unlinkSync(inboxRiskPath);
    }

    const originalKnowledge = fs.readFileSync(runtimePaths.mainFile, 'utf-8');
    const quoteAuditTitle = `Smoke 命令原话审计 ${Date.now()}`;
    try {
      fs.appendFileSync(runtimePaths.mainFile, [
        '',
        '',
        `## ${quoteAuditTitle}`,
        '',
        '- 来源：B站搜索摘要 https://example.com/smoke-kb-audit-command',
        '- 内容：这是玩机器原话：老板大气，这波经济直接拉满。',
        '',
      ].join('\n'), 'utf-8');
      handler.handleEvent(makePlainEvent(827, config.admin_qq[0], '/kb audit'));
      await waitFor(() => sent.length === 8, 'kb audit quote risk command', 5000);
      const auditText = firstText(sent[7].message);
      assert.ok(auditText.includes('未核验原话声称'), '/kb audit should expose unsupported quote claims');
      assert.ok(auditText.includes('拟态模板'), '/kb audit should explain quote-risk remediation');
    } finally {
      fs.writeFileSync(runtimePaths.mainFile, originalKnowledge, 'utf-8');
      kb.auditKnowledge();
    }
  } finally {
    aiChat.shutdownAiChat();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testVoiceStats() {
  const config = readConfig();
  const stats = tts.getVoiceStats(config.ai);
  assert.strictEqual(stats.model, 'mimo-v2.5-tts');
  assert.strictEqual(stats.provider, 'auto');
  assert.strictEqual(stats.localReady, false);
  assert.strictEqual(stats.cloneModel, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(stats.cloneEnabled, true);
  assert.strictEqual(stats.maxChars, 180);
  assert.strictEqual(stats.maxCacheMB, 256);
  assert.strictEqual(stats.maxCacheFiles, 1500);
  const sttStats = stt.getSttStats(config.ai);
  assert.strictEqual(sttStats.maxCacheMB, 96);
  assert.strictEqual(sttStats.maxCacheFiles, 1500);
  assert.ok(stats.samplePath.endsWith('voice_sample.mp3'), 'sample path should default to voice_sample.mp3');
}

async function testLocalTtsProvider() {
  const config = readConfig();
  const tempDir = fs.mkdtempSync(path.join(__dirname, 'local-tts-'));
  const scriptPath = path.join(tempDir, 'tts-smoke.js');
  const countPath = path.join(tempDir, 'tts-runs.txt');
  const countLiteral = JSON.stringify(countPath);
  fs.writeFileSync(scriptPath, `
const fs = require('fs');
const out = process.env.QQBOT_TTS_OUTPUT;
if (!out) process.exit(2);
fs.appendFileSync(${countLiteral}, '1');
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + 220, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(220, 40);
fs.mkdirSync(require('path').dirname(out), { recursive: true });
setTimeout(() => {
  fs.writeFileSync(out, Buffer.concat([header, Buffer.alloc(220)]));
  console.log(out);
}, 60);
`, 'utf-8');
  config.ai.enable_tts = true;
  config.ai.tts_provider = 'local';
  config.ai.tts_local_command = `"${process.execPath}" "${scriptPath}"`;
  config.ai.tts_local_output_dir = path.join(tempDir, 'cache');
  config.ai.tts_max_chars = 120;
  config.ai.tts_cache_hours = 1;
  try {
    const beforeStats = tts.getVoiceStats(config.ai);
    const output = await tts.generateVoice(config.ai, '本地语音 smoke');
    assert.ok(output && fs.existsSync(output), 'local tts should produce an audio file');
    assert.ok(fs.statSync(output).size > 200, 'local tts output should be non-empty');
    const hitInspect = tts.inspectVoiceCache(config.ai, ['本地语音 smoke']);
    assert.strictEqual(hitInspect.parts[0].status, 'hit', 'voice cache inspect should see generated local TTS cache hit');
    assert.strictEqual(hitInspect.parts[0].provider, 'local', 'voice cache inspect should expose local provider');
    assert.ok(hitInspect.parts[0].ttlSeconds > 0, 'voice cache inspect should expose cache ttl');
    const inspectStatsBefore = tts.getVoiceStats(config.ai);
    const missInspect = tts.inspectVoiceCache(config.ai, [`本地语音 miss ${Date.now()}`]);
    assert.strictEqual(missInspect.parts[0].status, 'miss', 'voice cache inspect should show miss for unseen text');
    const inspectStatsAfter = tts.getVoiceStats(config.ai);
    assert.strictEqual(inspectStatsAfter.hits, inspectStatsBefore.hits, 'voice cache inspect should not increment TTS hits');
    assert.strictEqual(inspectStatsAfter.misses, inspectStatsBefore.misses, 'voice cache inspect should not increment TTS misses');
    let stats = tts.getVoiceStats(config.ai);
    assert.strictEqual(stats.provider, 'local');
    assert.strictEqual(stats.localReady, true);
    assert.ok(stats.localRuns >= beforeStats.localRuns + 1, 'local tts run counter should increase');

    const concurrentText = `本地语音并发 smoke ${Date.now()}`;
    const runsBeforeConcurrent = fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf-8').length : 0;
    const statsBeforeConcurrent = tts.getVoiceStats(config.ai);
    const outputs = await Promise.all(Array.from({ length: 8 }, () => tts.generateVoice(config.ai, concurrentText)));
    const runsAfterConcurrent = fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf-8').length : 0;
    assert.ok(outputs.every((item) => item && item === outputs[0] && fs.existsSync(item)), 'concurrent local tts calls should share one generated file');
    assert.strictEqual(runsAfterConcurrent - runsBeforeConcurrent, 1, 'concurrent same TTS text should only run local command once');
    stats = tts.getVoiceStats(config.ai);
    assert.strictEqual(stats.localRuns - statsBeforeConcurrent.localRuns, 1, 'single-flight should only increment local run counter once');
    assert.ok(stats.inFlightHits - statsBeforeConcurrent.inFlightHits >= 7, 'TTS single-flight waiters should be counted as in-flight hits');
    assert.strictEqual(stats.inFlight, 0, 'TTS in-flight map should drain after generation');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testApiTtsProvider() {
  const config = readConfig();
  const responseAudio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(240)]).toString('base64');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push(json);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              audio: {
                data: responseAudio,
              },
            },
          },
        ],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    config.ai.api_url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    config.ai.api_key = 'sk-live-test-key-1234567890';
    config.ai.enable_tts = true;
    config.ai.tts_provider = 'api';
    config.ai.tts_clone_enabled = false;
    config.ai.tts_cache_hours = 1;
    const output = await tts.generateVoice(config.ai, `远端语音 smoke ${Date.now()}`);
    assert.ok(output && fs.existsSync(output), 'api tts should produce an audio file');
    assert.ok(fs.statSync(output).size > 200, 'api tts output should be non-empty');
    assert.strictEqual(requests.length, 1, 'api tts should call mock server once');
    assert.deepStrictEqual(
      requests[0].messages.map((item) => item.role),
      ['user', 'assistant'],
      'MiMo v2.5 TTS payload should put prompt in user and spoken text in assistant',
    );
    assert.strictEqual(requests[0].audio.format, 'mp3', 'api tts should request mp3 audio');
    const stats = tts.getVoiceStats(config.ai);
    assert.strictEqual(stats.provider, 'api');
    assert.strictEqual(stats.lastMode, 'mimo-tts-chat-v25');
    assert.strictEqual(stats.lastError, '', 'successful api tts should clear stale TTS error');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testImageStats() {
  const stats = imageCache.getCacheStats();
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'downloadFailures'), 'image stats should expose download failures');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'lastError'), 'image stats should expose last error');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'maxRedirects'), 'image stats should expose max redirects');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'cleanupIntervalMinutes'), 'image stats should expose cleanup interval');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'inFlight'), 'image stats should expose single-flight count');
}

async function testImageRedirectAndCleanup() {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(220), Buffer.from([0xff, 0xd9])]);
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { Location: '/image.jpg' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    imageCache.configureImageCache({
      image_cache_max_mb: 20,
      image_cache_max_file_mb: 0.5,
      image_cache_max_age_hours: 1,
      image_download_max_redirects: 3,
      image_cache_cleanup_interval_minutes: 5,
      image_cache_max_files: 50,
    });
    const imageUrl = `http://127.0.0.1:${address.port}/redirect?t=${Date.now()}`;
    const beforeRequests = requestCount;
    const beforeStats = imageCache.getCacheStats();
    const dataUrls = await Promise.all(Array.from({ length: 10 }, () => imageCache.getImageDataUrl(imageUrl)));
    const dataUrl = dataUrls[0];
    assert.ok(dataUrl && dataUrl.startsWith('data:image/jpeg;base64,'), 'image cache should follow redirects and return data URL');
    assert.ok(dataUrls.every((item) => item === dataUrl), 'concurrent image requests should share the same cached result');
    assert.strictEqual(requestCount - beforeRequests, 2, 'single-flight should only hit redirect + final image once');
    const afterStats = imageCache.getCacheStats();
    assert.strictEqual(afterStats.misses - beforeStats.misses, 1, 'only the first concurrent image request should count as miss');
    assert.ok(afterStats.hits - beforeStats.hits >= 9, 'concurrent image waiters should count as hits');
    assert.strictEqual(afterStats.lastError, '', 'successful image download should clear stale image error');
    imageCache.cleanupCache();
    const stats = imageCache.getCacheStats();
    assert.strictEqual(stats.maxRedirects, 3);
    assert.ok(stats.lastCleanupAt > 0, 'manual image cleanup should update cleanup timestamp');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testGates() {
  configureGates({ ai: 2, search: 2, vision: 1, tts: 1, stt: 1 });
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 8 }, () => withGate('ai', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  })));
  assert.ok(maxActive <= 2, `gate exceeded limit: ${maxActive}`);
  assert.strictEqual(getGateStats().ai.active, 0);

  configureGates({ ai: 1, search: 2, vision: 1, tts: 1, stt: 1 });
  const order = [];
  const blocker = withGate('ai', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('blocker');
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  const passive = withGate('ai', async () => {
    order.push('passive');
  });
  const forced = withGate('ai', async () => {
    order.push('forced');
  }, true);
  await Promise.all([blocker, passive, forced]);
  assert.deepStrictEqual(order, ['blocker', 'forced', 'passive'], 'priority gate jobs should run before queued passive jobs');

  configureGates({ ai: 1, search: 2, vision: 1, tts: 1, stt: 1, passiveQueueMax: 1 });
  let release;
  const cappedOrder = [];
  const held = withGate('ai', async () => {
    await new Promise((resolve) => { release = resolve; });
    cappedOrder.push('held');
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  const queued = withGate('ai', async () => {
    cappedOrder.push('queued');
  });
  await assert.rejects(
    () => withGate('ai', async () => 'rejected'),
    /passive queue full/,
    'passive gate jobs should be rejected after passive queue cap',
  );
  const priority = withGate('ai', async () => {
    cappedOrder.push('priority');
  }, true);
  release();
  await Promise.all([held, queued, priority]);
  assert.deepStrictEqual(cappedOrder, ['held', 'priority', 'queued'], 'priority should bypass passive queue cap and run before queued passive job');
  assert.ok(getGateStats().ai.rejectedPassive >= 1, 'gate stats should count rejected passive jobs');
}

function makeWavBuffer() {
  const samples = Buffer.alloc(320);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

async function testSttPayloadModesAndRedirect() {
  const config = readConfig();
  const wav = makeWavBuffer();
  const requests = [];
  let audioDownloads = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/audio-redirect')) {
      audioDownloads++;
      res.writeHead(302, { Location: '/audio.wav' });
      res.end();
      return;
    }
    if (req.url.startsWith('/audio.wav')) {
      audioDownloads++;
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push(json);
      const reply = `听写-${requests.length}`;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      }, 40);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    config.ai.api_url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    config.ai.api_key = 'sk-live-test-key-1234567890';
    config.ai.enable_stt = true;
    config.ai.stt_provider = 'api';
    config.ai.stt_timeout_ms = 5000;
    config.ai.image_download_max_redirects = 3;

    config.ai.stt_payload_mode = 'input_audio';
    let result = await stt.transcribeRecords(config.ai, [`http://127.0.0.1:${address.port}/audio-redirect?mode=input_audio&t=${Date.now()}`]);
    assert.deepStrictEqual(result, ['听写-1']);
    assert.ok(JSON.stringify(requests.at(-1)).includes('input_audio'), 'input_audio mode should send input_audio payload');

    config.ai.stt_payload_mode = 'audio_url';
    result = await stt.transcribeRecords(config.ai, [`http://127.0.0.1:${address.port}/audio-redirect?mode=audio_url&t=${Date.now()}`]);
    assert.deepStrictEqual(result, ['听写-2']);
    assert.ok(JSON.stringify(requests.at(-1)).includes('audio_url'), 'audio_url mode should send audio_url payload');

    config.ai.stt_payload_mode = 'auto';
    result = await stt.transcribeRecords(config.ai, [`http://127.0.0.1:${address.port}/audio-redirect?mode=auto&t=${Date.now()}`]);
    assert.deepStrictEqual(result, ['听写-3']);
    const stats = stt.getSttStats(config.ai);
    assert.strictEqual(stats.payloadMode, 'auto');
    assert.ok(['input_audio', 'audio_url'].includes(stats.lastPayloadMode), 'STT stats should expose last payload mode');
    assert.strictEqual(stats.lastError, '', 'successful STT should clear stale STT error');

    const requestCountBefore = requests.length;
    const downloadsBefore = audioDownloads;
    const statsBeforeConcurrent = stt.getSttStats(config.ai);
    const sameUrl = `http://127.0.0.1:${address.port}/audio-redirect?mode=concurrent&t=${Date.now()}`;
    const parallelResults = await Promise.all(Array.from({ length: 6 }, () => stt.transcribeRecord(config.ai, sameUrl)));
    assert.ok(parallelResults.every((item) => item === '听写-4'), 'concurrent same STT input should share one transcript');
    assert.strictEqual(requests.length - requestCountBefore, 1, 'concurrent same STT input should call API once');
    assert.strictEqual(audioDownloads - downloadsBefore, 2, 'concurrent same STT input should download redirect + final audio once');
    const statsAfterConcurrent = stt.getSttStats(config.ai);
    assert.ok(statsAfterConcurrent.inFlightHits - statsBeforeConcurrent.inFlightHits >= 5, 'STT single-flight waiters should be counted as in-flight hits');
    assert.strictEqual(statsAfterConcurrent.inFlight, 0, 'STT in-flight map should drain after transcription');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testSearchSingleFlight() {
  search.__clearSearchCacheForTests();
  let calls = 0;
  search.__setSearchRunnerForTests(async (query) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return `result:${query}`;
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => search.webSearch('same smoke query', 1000, 60, 60)),
    );
    assert.strictEqual(calls, 1, `single-flight should call runner once, got ${calls}`);
    assert.ok(results.every((item) => item === 'result:same smoke query'));
    const stats = search.getSearchStats();
    assert.strictEqual(stats.misses, 1, 'only the first concurrent query should be a miss');
    assert.ok(stats.hits >= 9, 'concurrent waiters should count as hits');

    const cached = await search.webSearch('same smoke query', 1000, 60, 60);
    assert.strictEqual(cached, 'result:same smoke query');
    assert.strictEqual(calls, 1, 'cache hit should not call runner again');
  } finally {
    search.__setSearchRunnerForTests();
    search.__clearSearchCacheForTests();
  }
}

function makeEvent(messageId, userId, text, extraSegments = [], groupId = 6657) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 3853043835,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    anonymous: null,
    message: [
      ...extraSegments,
      { type: 'at', data: { qq: '3853043835' } },
      { type: 'text', data: { text } },
    ],
    raw_message: `[CQ:at,qq=3853043835]${text}`,
    font: 0,
    sender: { user_id: userId, nickname: `user${userId}` },
  };
}

function makePlainEvent(messageId, userId, text, extraSegments = [], groupId = 6657) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 3853043835,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    anonymous: null,
    message: [
      ...extraSegments,
      { type: 'text', data: { text } },
    ],
    raw_message: text,
    font: 0,
    sender: { user_id: userId, nickname: `user${userId}` },
  };
}

function makePrivateEvent(messageId, userId, text, extraSegments = []) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 3853043835,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: userId,
    message: [
      ...extraSegments,
      { type: 'text', data: { text } },
    ],
    raw_message: text,
    font: 0,
    sender: { user_id: userId, nickname: `private${userId}` },
  };
}

function makeConfigForHandler() {
  const config = readConfig();
  config.bot_qq = 3853043835;
  config.ai.api_key = 'sk-live-test-key-1234567890';
  config.ai.api_url = 'https://example.com/v1/chat/completions';
  config.ai.model = 'smoke-model';
  config.ai.vision_model = 'smoke-vision-model';
  config.ai.enable_search = false;
  config.ai.enable_tts = false;
  config.ai.enable_stt = false;
  config.ai.enable_vision = false;
  config.ai.enable_knowledge = false;
  config.ai.human_reply_delay_enabled = false;
  config.ai.max_context_messages = 20;
  config.ai.context_send_messages = 10;
  config.ai.max_group_queue = 10;
  config.ai.ai_global_concurrency = 2;
  config.ai.search_global_concurrency = 2;
  config.ai.vision_global_concurrency = 1;
  config.ai.tts_global_concurrency = 1;
  config.ai.stt_global_concurrency = 1;
  config.enabled_groups = [];
  config.admin_qq = [1];
  return config;
}

function makeRuntimeStats(overrides = {}) {
  return {
    startedAt: Date.now(),
    wsUrl: 'ws://127.0.0.1:3001',
    readyState: 'open',
    connected: true,
    connecting: false,
    manuallyClosed: false,
    reconnectScheduled: false,
    reconnectIntervalMs: 1000,
    pendingApi: 0,
    lastConnectedAt: Date.now(),
    lastDisconnectedAt: 0,
    lastDisconnectCode: 0,
    lastDisconnectReason: '',
    lastError: '',
    lastFrameAt: Date.now(),
    lastEventAt: Date.now(),
    lastPingAt: Date.now(),
    lastPongAt: Date.now(),
    staleHeartbeatReconnects: 0,
    totalDisconnects: 0,
    consecutiveEarlyDisconnects: 0,
    lastConnectionHint: '',
    framesReceived: 3,
    eventsReceived: 2,
    apiCalls: 1,
    apiResponses: 1,
    apiTimeouts: 0,
    apiFailures: 0,
    groupSendAttempts: 0,
    privateSendAttempts: 0,
    groupSendFailures: 0,
    privateSendFailures: 0,
    loginCheckIntervalSeconds: 60,
    loginCheckInFlight: false,
    lastLoginCheckAt: Date.now(),
    lastLoginOkAt: Date.now(),
    lastLoginOk: true,
    lastLoginUserId: 3853043835,
    lastLoginNickname: 'smoke-bot',
    lastLoginError: '',
    loginCheckFailures: 0,
    loginCheckSuccesses: 1,
    ...overrides,
  };
}

async function testAdminMaintenanceCommands() {
  const config = makeConfigForHandler();
  const sent = [];
  let runtimeStats = makeRuntimeStats();
  hltv.clearHltvCache();
  hltv.__test.setCacheEntryForTests(
    'matches',
    [
      '来源：CS API / 维护测试 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- Vitality vs NAVI',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 1_000, source: 'maint-smoke-cs', fetchMs: 11 },
  );
  const bot = {
    getConfig: () => config,
    updateConfig: (nextConfig) => Object.assign(config, nextConfig),
    getRuntimeStats: () => runtimeStats,
    checkLoginNow: async () => runtimeStats,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(39_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(adminPlugin);

  handler.handleEvent(makePlainEvent(801, 1, '/maint status'));
  await waitFor(() => sent.length === 1, 'maint status');
  assert.ok(firstText(sent[0].message).includes('维护状态'), 'maint status should render maintenance panel');
  assert.ok(firstText(sent[0].message).includes('config_version'), 'maint status should show config version');
  assert.ok(firstText(sent[0].message).includes('AI回复缓存'), 'maint status should expose AI reply cache and in-flight stats');
  assert.ok(firstText(sent[0].message).includes('真人停顿'), 'maint status should expose human reply delay stats');
  assert.ok(firstText(sent[0].message).includes('风格场景'), 'maint status should expose style scene stats');
  assert.ok(firstText(sent[0].message).includes('CS实时缓存'), 'maint status should expose CS realtime cache stats');
  assert.ok(firstText(sent[0].message).includes('多模态真实链路'), 'maint status should expose multimodal trace summary');
  assert.ok(firstText(sent[0].message).includes('克隆/授权样本不能说成现实主播本人语音'), 'maint status should expose multimodal truth boundary');

  handler.handleEvent(makePlainEvent(802, 1, '/maint config'));
  await waitFor(() => sent.length === 2, 'maint config');
  assert.ok(firstText(sent[1].message).includes('当前运行配置'), 'maint config should render config drift panel');
  assert.ok(firstText(sent[1].message).includes('多模态'), 'maint config should show multimodal switches');
  assert.ok(firstText(sent[1].message).includes('真人停顿'), 'maint config should show human reply delay config');

  runtimeStats = makeRuntimeStats({ lastLoginOk: false, lastLoginError: 'Login Error ErrCode 3', lastLoginOkAt: 0 });
  handler.handleEvent(makePlainEvent(803, 1, '/maint login'));
  await waitFor(() => sent.length === 3, 'maint login');
  assert.ok(firstText(sent[2].message).includes('登录态检查'), 'maint login should render login check panel');
  assert.ok(firstText(sent[2].message).includes('Login Error ErrCode 3'), 'maint login should show login error');

  handler.handleEvent(makePlainEvent(805, 1, '/maint clean'));
  await waitFor(() => sent.length === 4, 'maint clean');
  assert.ok(firstText(sent[3].message).includes('维护清理跑完了'), 'maint clean should render cleanup summary');
  assert.ok(firstText(sent[3].message).includes('CS实时缓存'), 'maint clean should include CS realtime cache cleanup summary');
  assert.strictEqual(hltv.getHltvStats().entries, 0, 'maint clean should clear fresh CS realtime cache entries');

  handler.handleEvent(makePlainEvent(804, 2, '/maint status'));
  await waitFor(() => sent.length === 5, 'maint non-admin denial');
  assert.ok(firstText(sent[4].message).includes('权限不足'), 'maint should be admin-only');

  handler.handleEvent(makePlainEvent(806, 2, '/mem'));
  await waitFor(() => sent.length === 6, 'mem status');
  assert.ok(firstText(sent[5].message).includes('RAG记忆'), 'mem should show RAG memory status');
  assert.ok(firstText(sent[5].message).includes('用户画像缓存'), 'mem should show user profile cache stats');
  assert.ok(firstText(sent[5].message).includes('AI回复缓存'), 'mem should show AI reply cache stats');
  assert.ok(firstText(sent[5].message).includes('/mem search'), 'mem should show search usage');

  handler.handleEvent(makePlainEvent(807, 2, '/mem recent'));
  await waitFor(() => sent.length === 7, 'mem recent');
  assert.ok(firstText(sent[6].message).includes('最近上下文'), 'mem recent should show recent context');
  assert.ok(firstText(sent[6].message).includes('最近RAG索引'), 'mem recent should show recent index snapshot');

  handler.handleEvent(makePlainEvent(808, 2, '/mem clear'));
  await waitFor(() => sent.length === 8, 'mem clear non-admin denial');
  assert.ok(firstText(sent[7].message).includes('管理员'), 'mem clear should be admin-only');

  handler.handleEvent(makePlainEvent(810, 1, '/mem clear'));
  await waitFor(() => sent.length === 9, 'mem clear admin report');
  assert.ok(firstText(sent[8].message).includes('当前会话上下文和RAG索引已清空'), 'admin mem clear should confirm cleanup');
  assert.ok(firstText(sent[8].message).includes('清理前'), 'admin mem clear should report before counts');
  assert.ok(firstText(sent[8].message).includes('清理后'), 'admin mem clear should report after counts');

  const trimGroupId = 770_000 + Math.floor(Date.now() % 10_000);
  const trimSessionId = `group_${trimGroupId}`;
  const trimContextPath = path.resolve(__dirname, '..', 'context_store', `${trimSessionId}.json`);
  const trimIndexPath = path.resolve(__dirname, '..', 'context_store', 'embeddings', `${trimSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(trimContextPath), { recursive: true });
  fs.mkdirSync(path.dirname(trimIndexPath), { recursive: true });
  const trimMessages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `trim smoke memory message ${index + 1} Mirage long control and utility detail`,
  }));
  fs.writeFileSync(trimContextPath, JSON.stringify({
    summary: 'old summary',
    messages: trimMessages,
    lastActiveTime: Date.now(),
  }), 'utf-8');
  fs.writeFileSync(trimIndexPath, trimMessages.map((message, index) => JSON.stringify({
    id: `trim-${index}`,
    ts: Date.now() + index,
    role: message.role,
    text: message.content,
  })).join('\n') + '\n', 'utf-8');

  try {
    handler.handleEvent(makePlainEvent(811, 2, '/mem trim 2', [], trimGroupId));
    await waitFor(() => sent.length === 10, 'mem trim non-admin denial');
    assert.ok(firstText(sent[9].message).includes('管理员'), 'mem trim should be admin-only');

    handler.handleEvent(makePlainEvent(812, 1, '/mem trim 2', [], trimGroupId));
    await waitFor(() => sent.length === 11, 'mem trim admin report');
    const trimText = firstText(sent[10].message);
    assert.ok(trimText.includes('当前会话记忆已裁剪'), 'admin mem trim should confirm trim');
    assert.ok(trimText.includes('上下文: 6 -> 2 条'), 'admin mem trim should trim context messages');
    assert.ok(trimText.includes('摘要: 11 -> 0 字'), 'admin mem trim should drop old summary');
    assert.ok(trimText.includes('RAG索引: 6 -> 2 条'), 'admin mem trim should trim RAG index');

    handler.handleEvent(makePlainEvent(813, 1, '/mem recent 5', [], trimGroupId));
    await waitFor(() => sent.length === 12, 'mem recent after trim');
    const recentAfterTrim = firstText(sent[11].message);
    assert.ok(recentAfterTrim.includes('trim smoke memory message 5'), 'mem recent after trim should keep recent context');
    assert.ok(recentAfterTrim.includes('trim smoke memory message 6'), 'mem recent after trim should keep newest context');
    assert.ok(!recentAfterTrim.includes('trim smoke memory message 1'), 'mem recent after trim should drop old context');

  } finally {
    aiChat.clearAiSessionMemory?.(trimSessionId);
    if (fs.existsSync(trimContextPath)) fs.unlinkSync(trimContextPath);
    if (fs.existsSync(trimIndexPath)) fs.unlinkSync(trimIndexPath);
  }

  const dropGroupId = 775_000 + Math.floor(Date.now() % 10_000);
  const dropSessionId = `group_${dropGroupId}`;
  const dropContextPath = path.resolve(__dirname, '..', 'context_store', `${dropSessionId}.json`);
  const dropIndexPath = path.resolve(__dirname, '..', 'context_store', 'embeddings', `${dropSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(dropContextPath), { recursive: true });
  fs.mkdirSync(path.dirname(dropIndexPath), { recursive: true });
  const dropMessages = [
    { role: 'user', content: 'drop keep anchor Mirage normal useful memory' },
    { role: 'assistant', content: 'drop toxic anchor wrong roster rumor should disappear' },
    { role: 'user', content: 'another drop toxic anchor spam joke should disappear' },
  ];
  fs.writeFileSync(dropContextPath, JSON.stringify({
    summary: 'old summary has drop toxic anchor and should be cleared',
    messages: dropMessages,
    lastActiveTime: Date.now(),
  }), 'utf-8');
  fs.writeFileSync(dropIndexPath, dropMessages.map((message, index) => JSON.stringify({
    id: `drop-${index}`,
    ts: Date.now() + index,
    role: message.role,
    text: message.content,
  })).join('\n') + '\n', 'utf-8');

  try {
    handler.handleEvent(makePlainEvent(817, 2, '/mem drop drop toxic anchor', [], dropGroupId));
    await waitFor(() => sent.length === 13, 'mem drop non-admin denial');
    assert.ok(firstText(sent[12].message).includes('管理员'), 'mem drop should be admin-only');

    handler.handleEvent(makePlainEvent(818, 1, '/mem drop drop toxic anchor', [], dropGroupId));
    await waitFor(() => sent.length === 14, 'mem drop admin report');
    const dropText = firstText(sent[13].message);
    assert.ok(dropText.includes('当前会话噪声记忆已删除'), 'admin mem drop should confirm deletion');
    assert.ok(dropText.includes('上下文: 3 -> 1 条 (删2)'), 'admin mem drop should remove matching context messages');
    assert.ok(dropText.includes('摘要:'), 'admin mem drop should report summary cleanup');
    assert.ok(dropText.includes('命中已清空'), 'admin mem drop should clear matching summary');
    assert.ok(dropText.includes('RAG索引: 3 -> 1 条 (删2)'), 'admin mem drop should remove matching RAG entries');
    assert.ok(dropText.includes('wrong roster rumor'), 'admin mem drop should show removed samples');

    handler.handleEvent(makePlainEvent(819, 1, '/mem recent 5', [], dropGroupId));
    await waitFor(() => sent.length === 15, 'mem recent after drop');
    const recentAfterDrop = firstText(sent[14].message);
    assert.ok(recentAfterDrop.includes('drop keep anchor'), 'mem recent after drop should keep non-matching context');
    assert.ok(!recentAfterDrop.includes('drop toxic anchor'), 'mem recent after drop should hide matching context and RAG entries');
  } finally {
    aiChat.clearAiSessionMemory?.(dropSessionId);
    if (fs.existsSync(dropContextPath)) fs.unlinkSync(dropContextPath);
    if (fs.existsSync(dropIndexPath)) fs.unlinkSync(dropIndexPath);
  }

  const checkGroupId = 780_000 + Math.floor(Date.now() % 10_000);
  const checkSessionId = `group_${checkGroupId}`;
  const checkIndexPath = path.resolve(__dirname, '..', 'context_store', 'embeddings', `${checkSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(checkIndexPath), { recursive: true });
  const checkNow = Date.now();
  fs.writeFileSync(checkIndexPath, [
    JSON.stringify({ id: 'check-old', ts: checkNow - 3 * 24 * 60 * 60 * 1000, role: 'user', text: 'smoke rag check old memory anchor Mirage utility detail flash control' }),
    JSON.stringify({ id: 'check-recent', ts: checkNow - 60 * 1000, role: 'assistant', text: 'smoke rag check recent memory anchor Mirage utility detail flash control' }),
  ].join('\n') + '\n', 'utf-8');
  try {
    handler.handleEvent(makePlainEvent(815, 1, '/mem check Mirage utility detail', [], checkGroupId));
    await waitFor(() => sent.length === 16, 'mem check indexed-only fixture');
    const memCheckText = firstText(sent[15].message);
    assert.ok(memCheckText.includes('RAG记忆预检'), '/mem check should render memory preflight panel');
    assert.ok(memCheckText.includes('参数:'), '/mem check should expose RAG parameters');
    assert.ok(memCheckText.includes('命中:'), '/mem check should expose memory hit counts');
    assert.ok(memCheckText.includes('smoke rag check'), '/mem check should show matching indexed memories');
    assert.ok(memCheckText.includes('排序=sim+近期加权'), '/mem check should expose recency-aware ranking');
    assert.ok(memCheckText.includes('score='), '/mem check should expose final memory score');
    assert.ok(memCheckText.includes('age='), '/mem check should expose memory age');
    assert.ok(memCheckText.indexOf('recent memory') < memCheckText.indexOf('old memory'), '/mem check should prefer recent memories when similarity is comparable');
    assert.ok(memCheckText.includes('行动建议:'), '/mem check should expose next diagnostic action');
  } finally {
    aiChat.clearAiSessionMemory?.(checkSessionId);
    if (fs.existsSync(checkIndexPath)) fs.unlinkSync(checkIndexPath);
  }

  handler.handleEvent(makePlainEvent(816, 2, '/mem cache CS2这把残局怎么打稳一点？？ || @机器人 CS2这把残局怎么打稳一点?'));
  await waitFor(() => sent.length === 17, 'mem reply cache preflight');
  const cacheCheckText = firstText(sent[16].message);
  assert.ok(cacheCheckText.includes('AI回复缓存预检'), '/mem cache should render reply cache preflight panel');
  assert.ok(cacheCheckText.includes('稳定战术'), '/mem cache should identify stable CS tactical queries');
  assert.ok(cacheCheckText.includes('策略: on 残局处理'), '/mem cache should expose cacheable tactical policy');
  assert.ok(cacheCheckText.includes('状态=miss'), '/mem cache should expose current key miss state');
  assert.ok(cacheCheckText.includes('对比:'), '/mem cache should compare two natural variants');
  assert.ok(cacheCheckText.includes('key相同'), '/mem cache should show normalized variants share a key');

  handler.handleEvent(makePlainEvent(814, 2, '/mem health'));
  await waitFor(() => sent.length === 18, 'mem health');
  const healthText = firstText(sent[17].message);
  assert.ok(healthText.includes('缓存健康'), 'mem health should render cache health panel');
  assert.ok(healthText.includes('内存压力:'), 'mem health should expose memory pressure level');
  assert.ok(healthText.includes('上下文:'), 'mem health should expose context memory pressure');
  assert.ok(healthText.includes('AI回复缓存'), 'mem health should include AI reply cache');
  assert.ok(healthText.includes('AI缓存策略Top'), 'mem health should include reply cache policy distribution');
  assert.ok(healthText.includes('用户画像缓存'), 'mem health should include user profile cache diagnostics');
  assert.ok(healthText.includes('搜索缓存'), 'mem health should include search cache');
  assert.ok(healthText.includes('CS实时缓存'), 'mem health should include CS realtime cache');
  assert.ok(healthText.includes('RAG'), 'mem health should include RAG diagnostics');
  assert.ok(healthText.includes('容量建议:'), 'mem health should expose memory/cache capacity suggestions');
  assert.ok(healthText.includes('清理动作:'), 'mem health should expose concrete cleanup actions');

  const userDropGroupId = 785_000 + Math.floor(Date.now() % 10_000);
  const userDropSessionId = `group_${userDropGroupId}`;
  const userDropContextPath = path.resolve(__dirname, '..', 'context_store', `${userDropSessionId}.json`);
  const userDropIndexPath = path.resolve(__dirname, '..', 'context_store', 'embeddings', `${userDropSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(userDropContextPath), { recursive: true });
  fs.mkdirSync(path.dirname(userDropIndexPath), { recursive: true });
  const userDropMessages = [
    { role: 'user', content: '[mid=9001 uid=42] user42: user scoped stale wrong roster memory should go' },
    { role: 'user', content: '[mid=9002 uid=99] user99: user scoped useful Mirage memory should stay' },
    { role: 'user', content: '[mid=9003 uid=42] user42: user scoped spam joke should go' },
  ];
  fs.writeFileSync(userDropContextPath, JSON.stringify({
    summary: 'compressed summary may contain user42 stale wrong roster memory',
    messages: userDropMessages,
    lastActiveTime: Date.now(),
  }), 'utf-8');
  fs.writeFileSync(userDropIndexPath, userDropMessages.map((message, index) => JSON.stringify({
    id: `user-drop-${index}`,
    ts: Date.now() + index,
    role: message.role,
    text: message.content,
  })).join('\n') + '\n', 'utf-8');
  try {
    handler.handleEvent(makePlainEvent(820, 2, '/mem user 42', [], userDropGroupId));
    await waitFor(() => sent.length === 19, 'mem user preflight');
    const userPreflightText = firstText(sent[18].message);
    assert.ok(userPreflightText.includes('用户记忆预检'), '/mem user should render user-scoped memory preflight');
    assert.ok(userPreflightText.includes('目标: uid=42'), '/mem user should show target uid');
    assert.ok(userPreflightText.includes('上下文: 2/3 条'), '/mem user should count matching context messages');
    assert.ok(userPreflightText.includes('RAG索引: 2/3 条'), '/mem user should count matching RAG index entries');
    assert.ok(userPreflightText.includes('/mem user drop 42'), '/mem user should suggest targeted user cleanup');
    assert.ok(userPreflightText.includes('wrong roster memory'), '/mem user should show matching samples');

    handler.handleEvent(makePlainEvent(821, 2, '/mem user drop 42', [], userDropGroupId));
    await waitFor(() => sent.length === 20, 'mem user drop non-admin denial');
    assert.ok(firstText(sent[19].message).includes('管理员'), '/mem user drop should be admin-only');

    handler.handleEvent(makePlainEvent(822, 1, '/mem user drop 42', [], userDropGroupId));
    await waitFor(() => sent.length === 21, 'mem user drop admin report');
    const userDropText = firstText(sent[20].message);
    assert.ok(userDropText.includes('当前会话用户记忆已删除'), '/mem user drop should confirm deletion');
    assert.ok(userDropText.includes('上下文: 3 -> 1 条 (删2)'), '/mem user drop should remove target user context messages');
    assert.ok(userDropText.includes('摘要:'), '/mem user drop should report summary cleanup');
    assert.ok(userDropText.includes('命中用户后清空'), '/mem user drop should clear compressed summary when user memory was removed');
    assert.ok(userDropText.includes('RAG索引: 3 -> 1 条 (删2)'), '/mem user drop should remove target user RAG entries');
    assert.ok(userDropText.includes('spam joke'), '/mem user drop should show removed samples');

    handler.handleEvent(makePlainEvent(823, 1, '/mem recent 8', [], userDropGroupId));
    await waitFor(() => sent.length === 22, 'mem recent after user drop');
    const userRecentAfterDrop = firstText(sent[21].message);
    assert.ok(userRecentAfterDrop.includes('useful Mirage memory should stay'), '/mem recent after user drop should keep other users');
    assert.ok(!userRecentAfterDrop.includes('stale wrong roster memory'), '/mem recent after user drop should remove target user context/index entries');
    assert.ok(!userRecentAfterDrop.includes('spam joke'), '/mem recent after user drop should remove all target user entries');
  } finally {
    aiChat.clearAiSessionMemory?.(userDropSessionId);
    if (fs.existsSync(userDropContextPath)) fs.unlinkSync(userDropContextPath);
    if (fs.existsSync(userDropIndexPath)) fs.unlinkSync(userDropIndexPath);
  }

  handler.handleEvent(makePlainEvent(824, 2, '/mem plan'));
  await waitFor(() => sent.length === 23, 'mem maintenance plan');
  const planText = firstText(sent[22].message);
  assert.ok(planText.includes('缓存/内存维护计划'), '/mem plan should render maintenance plan panel');
  assert.ok(planText.includes('模式: 只读'), '/mem plan should state it is read-only');
  assert.ok(planText.includes('优先级:'), '/mem plan should expose prioritized actions');
  assert.ok(planText.includes('P0'), '/mem plan should include P0 actions');
  assert.ok(planText.includes('P1'), '/mem plan should include P1 actions');
  assert.ok(planText.includes('P2'), '/mem plan should include P2 actions');
  assert.ok(planText.includes('边界:'), '/mem plan should include cleanup boundaries');

  handler.handleEvent(makePlainEvent(825, 2, '/mem cache status'));
  await waitFor(() => sent.length === 24, 'mem reply cache pool status');
  const cachePoolText = firstText(sent[23].message);
  assert.ok(cachePoolText.includes('AI回复缓存池状态'), '/mem cache status should render reply cache pool status');
  assert.ok(cachePoolText.includes('模式: 只读'), '/mem cache status should clarify read-only behavior');
  assert.ok(cachePoolText.includes('配置: ttl='), '/mem cache status should expose configured ttl and capacity');
  assert.ok(cachePoolText.includes('条目: fresh'), '/mem cache status should expose fresh/expired entry counts');
  assert.ok(cachePoolText.includes('TTL分布:'), '/mem cache status should expose TTL distribution');
  assert.ok(cachePoolText.includes('策略Top:'), '/mem cache status should expose cache policy distribution');
  assert.ok(cachePoolText.includes('回复缓存只给普通主动接话用'), '/mem cache status should explain reply cache boundaries');

  aiChat.shutdownAiChat();
  aiChat.__setReplyCacheEntryForTests('smoke:expired-reply-cache', 'expired reply smoke', -1_000);
  aiChat.__setReplyCacheEntryForTests('smoke:fresh-reply-cache', 'fresh reply smoke', 60_000);
  handler.handleEvent(makePlainEvent(826, 2, '/mem cache prune'));
  await waitFor(() => sent.length === 25, 'mem reply cache prune non-admin denial');
  assert.ok(firstText(sent[24].message).includes('管理员'), '/mem cache prune should be admin-only');

  handler.handleEvent(makePlainEvent(827, 1, '/mem cache prune'));
  await waitFor(() => sent.length === 26, 'mem reply cache prune admin report');
  const cachePruneText = firstText(sent[25].message);
  assert.ok(cachePruneText.includes('AI回复缓存过期清理'), '/mem cache prune should render prune report');
  assert.ok(cachePruneText.includes('expired 1'), '/mem cache prune should count expired entries');
  assert.ok(cachePruneText.includes('removed 1'), '/mem cache prune should remove expired entries');
  assert.ok(cachePruneText.includes('after 1'), '/mem cache prune should keep fresh entries');
  assert.ok(cachePruneText.includes('保留 fresh 热缓存'), '/mem cache prune should explain fresh cache preservation');

  handler.handleEvent(makePlainEvent(828, 1, '/maint storage'));
  await waitFor(() => sent.length === 27, 'maint storage diagnostics');
  const storageText = firstText(sent[26].message);
  assert.ok(storageText.includes('运行存储体检'), '/maint storage should render runtime storage panel');
  assert.ok(storageText.includes('模式: 目录写盘探针'), '/maint storage should explain probe behavior');
  assert.ok(storageText.includes('写盘: OK'), '/maint storage should expose write probe summary');
  assert.ok(storageText.includes('data=ok'), '/maint storage should check data directory');
  assert.ok(storageText.includes('rag=ok'), '/maint storage should check RAG index directory');
  assert.ok(storageText.includes('local-tts=ok'), '/maint storage should check local TTS output directory');
  assert.ok(storageText.includes('关键文件:'), '/maint storage should list important store files');
  assert.ok(storageText.includes('CS实时缓存'), '/maint storage should show CS realtime cache file state');
  assert.ok(storageText.includes('用户画像'), '/maint storage should show user profile store state');
  assert.ok(storageText.includes('missing 不等于没有比赛'), '/maint storage should explain missing file boundary');

  const maintApplyVoiceText = `维护候选短句 smoke ${Date.now()}`;
  const traceSent = [];
  const traceBot = {
    ...bot,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      traceSent.push({ groupId, message });
      if (onMessageId) onMessageId(38_500 + traceSent.length);
      return true;
    },
  };
  const traceHandler = new MessageHandler(traceBot);
  traceHandler.use(aiChat.aiChatPlugin);
  traceHandler.handleEvent(makePlainEvent(799, 1, `/voice ${maintApplyVoiceText}`));
  await waitFor(() => traceSent.length === 1, 'seed voice trace for maint warm plan');
  assert.ok(firstText(traceSent[0].message).includes('语音没开'), 'seed voice trace should fallback without TTS in smoke config');

  handler.handleEvent(makePlainEvent(829, 1, '/maint plan'));
  await waitFor(() => sent.length === 28, 'maint runbook plan');
  const maintPlanText = firstText(sent[27].message);
  assert.ok(maintPlanText.includes('管理员总维护计划'), '/maint plan should render admin runbook panel');
  assert.ok(maintPlanText.includes('模式: 只读'), '/maint plan should state it is read-only');
  assert.ok(maintPlanText.includes('总体:'), '/maint plan should expose global health summary');
  assert.ok(maintPlanText.includes('缓存:'), '/maint plan should expose cache summary');
  assert.ok(maintPlanText.includes('真实性:'), '/maint plan should expose truth/authenticity summary');
  assert.ok(maintPlanText.includes('P0'), '/maint plan should include P0 actions');
  assert.ok(maintPlanText.includes('P1'), '/maint plan should include P1 actions');
  assert.ok(maintPlanText.includes('P2'), '/maint plan should include P2 actions');
  assert.ok(maintPlanText.includes('/maint login'), '/maint plan should route login issues to /maint login');
  assert.ok(maintPlanText.includes('/cs warm plan all'), '/maint plan should route CS cold/stale cache to warm plan');
  assert.ok(maintPlanText.includes('/maint warm cs all'), '/maint plan should route actual CS warmup to maint warm');
  assert.ok(maintPlanText.includes('/maint warm plan'), '/maint plan should route recent hot cache candidates to maint warm plan');
  assert.ok(maintPlanText.includes('missing 文件和 stale 缓存都不能当事实结论'), '/maint plan should explain storage/realtime truth boundary');

  handler.handleEvent(makePlainEvent(834, 1, '/maint warm plan'));
  await waitFor(() => sent.length === 29, 'maint warm candidate plan');
  const maintWarmPlanText = firstText(sent[28].message);
  assert.ok(maintWarmPlanText.includes('维护预热候选计划'), '/maint warm plan should render readonly warmup candidate panel');
  assert.ok(maintWarmPlanText.includes('模式: 只读'), '/maint warm plan should be read-only');
  assert.ok(maintWarmPlanText.includes('TTS短句候选'), '/maint warm plan should include TTS candidate section');
  assert.ok(maintWarmPlanText.includes(maintApplyVoiceText), '/maint warm plan should surface recent voice trace text');
  assert.ok(maintWarmPlanText.includes(`/maint warm voice ${maintApplyVoiceText}`), '/maint warm plan should provide exact TTS warm command');
  assert.ok(maintWarmPlanText.includes('礼物谢礼候选'), '/maint warm plan should include gift warm candidate section');
  assert.ok(maintWarmPlanText.includes('不下载图片、不听写语音、不生成 TTS'), '/maint warm plan should not mutate caches');
  assert.ok(maintWarmPlanText.includes('缓存命中不代表事实正确'), '/maint warm plan should preserve cache truth boundary');

  const maintApplyCountPath = path.resolve(__dirname, '..', 'voice_cache', `smoke-maint-apply-${Date.now()}.txt`);
  const oldMaintApplyEnv = process.env.SMOKE_MAINT_APPLY_COUNT;
  const oldMaintTts = {
    enable_tts: config.ai.enable_tts,
    tts_provider: config.ai.tts_provider,
    tts_local_command: config.ai.tts_local_command,
    tts_max_chars: config.ai.tts_max_chars,
  };
  try {
    process.env.SMOKE_MAINT_APPLY_COUNT = maintApplyCountPath;
    config.ai.enable_tts = true;
    config.ai.tts_provider = 'local';
    config.ai.tts_local_command = `"${process.execPath}" -e "const fs=require('fs');const path=require('path');fs.appendFileSync(process.env.SMOKE_MAINT_APPLY_COUNT,'1');const out=process.env.QQBOT_TTS_OUTPUT;const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+220,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(220,40);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,Buffer.concat([h,Buffer.alloc(220)]));console.log(out);"`;
    config.ai.tts_max_chars = 120;
    handler.handleEvent(makePlainEvent(835, 1, '/maint warm apply voice 1'));
    await waitFor(() => sent.length === 30, 'maint warm apply voice');
    const maintWarmApplyText = firstText(sent[29].message);
    assert.ok(maintWarmApplyText.includes('维护预热候选执行'), '/maint warm apply should render execution panel');
    assert.ok(maintWarmApplyText.includes('范围: voice limit=1'), '/maint warm apply should show requested scope and limit');
    assert.ok(maintWarmApplyText.includes('TTS短句: generated 1'), '/maint warm apply voice should generate the recent TTS candidate');
    assert.ok(maintWarmApplyText.includes('预热后=hit'), '/maint warm apply voice should recheck cache hit after generation');
    assert.ok(maintWarmApplyText.includes('不会调用AI生成文案，不发送record'), '/maint warm apply should preserve non-send boundary');
    assert.strictEqual(fs.readFileSync(maintApplyCountPath, 'utf-8').length, 1, '/maint warm apply voice should run local TTS once');
  } finally {
    config.ai.enable_tts = oldMaintTts.enable_tts;
    config.ai.tts_provider = oldMaintTts.tts_provider;
    config.ai.tts_local_command = oldMaintTts.tts_local_command;
    config.ai.tts_max_chars = oldMaintTts.tts_max_chars;
    if (typeof oldMaintApplyEnv === 'string') process.env.SMOKE_MAINT_APPLY_COUNT = oldMaintApplyEnv;
    else delete process.env.SMOKE_MAINT_APPLY_COUNT;
    if (fs.existsSync(maintApplyCountPath)) fs.unlinkSync(maintApplyCountPath);
  }

  hltv.__test.setCacheEntryForTests(
    'matches',
    [
      '来源：CS API / 维护预热测试 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- Vitality vs NAVI',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 1_000, source: 'maint-warm-matches', fetchMs: 11 },
  );
  hltv.__test.setCacheEntryForTests(
    'results',
    [
      '来源：CS API / 维护预热赛果 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- NAVI 2:0 Vitality',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 1_000, source: 'maint-warm-results', fetchMs: 12 },
  );
  hltv.__test.setCacheEntryForTests(
    'ranking',
    [
      '来源：CS API / 维护预热排名 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '#1 Vitality',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 1_000, source: 'maint-warm-ranking', fetchMs: 13 },
  );
  handler.handleEvent(makePlainEvent(830, 1, '/maint warm cs'));
  await waitFor(() => sent.length === 31, 'maint warm cs');
  const maintWarmText = firstText(sent[30].message);
  assert.ok(maintWarmText.includes('维护预热: CS实时缓存'), '/maint warm cs should render maint warm wrapper');
  assert.ok(maintWarmText.includes('CS实时数据预热完成'), '/maint warm cs should execute CS prewarm');
  assert.ok(maintWarmText.includes('matches: OK'), '/maint warm cs should include matches prewarm');
  assert.ok(maintWarmText.includes('results: OK'), '/maint warm cs should include results prewarm');
  assert.ok(maintWarmText.includes('ranking: OK'), '/maint warm cs should include ranking prewarm');
  assert.ok(maintWarmText.includes('预热后覆盖: fresh 3/3'), '/maint warm cs should report post-warm fresh coverage');
  assert.ok(maintWarmText.includes('/cs verify all'), '/maint warm cs should suggest verification');
  assert.ok(maintWarmText.includes('stale/miss 不能当实时事实'), '/maint warm cs should preserve realtime truth boundary');

  handler.handleEvent(makePlainEvent(831, 1, '/maint warm media https://example.com/a.mp3'));
  await waitFor(() => sent.length === 32, 'maint warm media');
  const maintMediaWarmText = firstText(sent[31].message);
  assert.ok(maintMediaWarmText.includes('维护预热: 多模态缓存'), '/maint warm media should render maint media warm wrapper');
  assert.ok(maintMediaWarmText.includes('多模态缓存预热'), '/maint warm media should reuse aggregate warm panel');
  assert.ok(maintMediaWarmText.includes('语音只读检查STT缓存，不听写、不调用模型'), '/maint warm media should preserve STT read-only boundary');
  assert.ok(maintMediaWarmText.includes('听写缓存预检'), '/maint warm media should include STT cache preflight');
  assert.ok(maintMediaWarmText.includes('不下载语音、不转码、不调用模型'), '/maint warm media should not transcribe audio');
  assert.ok(maintMediaWarmText.includes('真实内容仍以 /vision test 和 /voice stt 为准'), '/maint warm media should preserve multimodal truth boundary');

  handler.handleEvent(makePlainEvent(832, 1, '/maint warm voice 维护入口语音预热 smoke'));
  await waitFor(() => sent.length === 33, 'maint warm voice');
  const maintVoiceWarmText = firstText(sent[32].message);
  assert.ok(maintVoiceWarmText.includes('维护预热: 语音TTS缓存'), '/maint warm voice should render maint voice warm wrapper');
  assert.ok(maintVoiceWarmText.includes('语音缓存预热'), '/maint warm voice should reuse TTS warm panel');
  assert.ok(maintVoiceWarmText.includes('不调用AI，不发送record'), '/maint warm voice should not call AI or send record');
  assert.ok(maintVoiceWarmText.includes('状态=disabled'), '/maint warm voice should expose disabled TTS cache state in smoke config');
  assert.ok(maintVoiceWarmText.includes('不能说成现实主播本人语音'), '/maint warm voice should preserve voice identity boundary');

  handler.handleEvent(makePlainEvent(833, 1, '/maint warm gift 烟花 12'));
  await waitFor(() => sent.length === 34, 'maint warm gift');
  const maintGiftWarmText = firstText(sent[33].message);
  assert.ok(maintGiftWarmText.includes('维护预热: 礼物谢礼TTS缓存'), '/maint warm gift should render maint gift warm wrapper');
  assert.ok(maintGiftWarmText.includes('礼物语音预热'), '/maint warm gift should reuse gift warm panel');
  assert.ok(maintGiftWarmText.includes('烟花x12'), '/maint warm gift should parse gift count');
  assert.ok(maintGiftWarmText.includes('预热动作: skipped'), '/maint warm gift should skip when TTS is disabled in smoke config');
  assert.ok(maintGiftWarmText.includes('不发送 record，不写入礼物节流'), '/maint warm gift should not mutate real gift state');
}

async function testStatusCommandObservability() {
  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(38_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(statusPlugin);

  handler.handleEvent(makePlainEvent(809, 9, '/status'));
  await waitFor(() => sent.length === 1, 'status command observability');
  const text = firstText(sent[0].message);
  assert.ok(text.includes('运行状态'), 'status should render runtime panel');
  assert.ok(text.includes('AI回复缓存'), 'status should expose AI reply cache stats');
  assert.ok(text.includes('用户画像'), 'status should expose user profile cache stats');
  assert.ok(text.includes('回复真实性'), 'status should expose reply authenticity counters');
  assert.ok(text.includes('真人停顿'), 'status should expose human reply delay stats');
  assert.ok(text.includes('风格场景'), 'status should expose style scene stats');
  assert.ok(text.includes('飞行'), 'status should expose in-flight counters');
  assert.ok(text.includes('搜索缓存'), 'status should expose search cache stats');
  assert.ok(text.includes('CS实时缓存'), 'status should expose CS realtime cache stats');
  assert.ok(text.includes('CS日报'), 'status should expose CS daily report stats');
  assert.ok(text.includes('CS竞猜'), 'status should expose CS prediction stats');
  assert.ok(text.includes('每日提醒'), 'status should expose daily pulse stats');
  assert.ok(text.includes('挑战完成'), 'status should expose daily challenge completion stats');
  assert.ok(text.includes('礼物感谢'), 'status should expose gift thanks stats');
  assert.ok(text.includes('多模态真实链路'), 'status should expose multimodal trace summary');
  assert.ok(text.includes('今日实跑'), 'status should expose today multimodal run counters');
  assert.ok(text.includes('多模态边界'), 'status should expose multimodal truth boundary');
  assert.ok(text.includes('贴纸'), 'status should expose sticker automation stats');
}

async function testMultimodalStatusDiagnostics() {
  const config = makeConfigForHandler();
  config.ai.enable_vision = true;
  config.ai.enable_tts = true;
  config.ai.enable_stt = true;
  config.ai.tts_provider = 'auto';
  config.ai.stt_provider = 'auto';
  config.ai.tts_local_command = '';
  config.ai.stt_local_command = '';
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(36_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  handler.handleEvent(makePlainEvent(811, 9, '/voice status'));
  await waitFor(() => sent.length === 1, 'voice status diagnostics');
  const voiceText = firstText(sent[0].message);
  assert.ok(voiceText.includes('语音状态'), 'voice status should render panel');
  assert.ok(voiceText.includes('TTS诊断:'), 'voice status should include TTS diagnosis');
  assert.ok(voiceText.includes('STT诊断:'), 'voice status should include STT diagnosis');
  assert.ok(voiceText.includes('克隆诊断:'), 'voice status should include clone diagnosis');
  assert.ok(voiceText.includes('最近听写:'), 'voice status should include last STT trace summary');
  assert.ok(voiceText.includes('下一步:'), 'voice status should include next action');

  handler.handleEvent(makePlainEvent(812, 9, '/voice check 这是玩机器本人语音，官方授权的声音复刻。第二句稍微长一点用来确认分段逻辑。第三句继续补一点长度。'));
  await waitFor(() => sent.length === 2, 'voice preflight diagnostics');
  const voiceCheckText = firstText(sent[1].message);
  assert.ok(voiceCheckText.includes('语音预检'), 'voice check should render preflight panel');
  assert.ok(voiceCheckText.includes('不调用AI，不生成音频'), 'voice check should be non-mutating');
  assert.ok(voiceCheckText.includes('分段:'), 'voice check should expose TTS segmentation');
  assert.ok(voiceCheckText.includes('风险:'), 'voice check should expose voice delivery risks');
  assert.ok(voiceCheckText.includes('疑似现实本人/授权语音话术'), 'voice check should flag real-person voice/authorization claims');
  assert.ok(voiceCheckText.includes('不能说成现实主播本人语音'), 'voice check should expose voice identity boundary');

  handler.handleEvent(makePlainEvent(813, 9, '/voice cache 这波语音缓存预检 smoke'));
  await waitFor(() => sent.length === 3, 'voice cache preflight diagnostics');
  const voiceCacheText = firstText(sent[2].message);
  assert.ok(voiceCacheText.includes('语音缓存预检'), 'voice cache should render cache preflight panel');
  assert.ok(voiceCacheText.includes('不调用AI，不生成音频'), 'voice cache should be non-mutating');
  assert.ok(voiceCacheText.includes('缓存状态:'), 'voice cache should expose hit/miss summary');
  assert.ok(voiceCacheText.includes('状态=miss'), 'voice cache should expose per-part miss state');
  assert.ok(voiceCacheText.includes('边界:'), 'voice cache should expose voice truth boundary');

  const sttStatsBeforeInspect = stt.getSttStats(config.ai);
  handler.handleEvent(makePlainEvent(814, 9, '/voice sttcache https://example.com/a.mp3 https://example.com/b.wav'));
  await waitFor(() => sent.length === 4, 'STT cache preflight diagnostics');
  const sttCacheText = firstText(sent[3].message);
  const sttStatsAfterInspect = stt.getSttStats(config.ai);
  assert.ok(sttCacheText.includes('听写缓存预检'), '/voice sttcache should render STT cache preflight panel');
  assert.ok(sttCacheText.includes('不下载语音、不转码、不调用模型'), '/voice sttcache should be non-mutating');
  assert.ok(sttCacheText.includes('缓存状态:'), '/voice sttcache should expose hit/miss summary');
  assert.ok(sttCacheText.includes('状态=miss'), '/voice sttcache should expose cache miss without transcription');
  assert.ok(sttCacheText.includes('边界:'), '/voice sttcache should expose STT truth boundary');
  assert.ok(sttCacheText.includes('/voice stt'), '/voice sttcache should suggest real STT warmup/test');
  assert.strictEqual(sttStatsAfterInspect.hits, sttStatsBeforeInspect.hits, '/voice sttcache should not increment STT hits');
  assert.strictEqual(sttStatsAfterInspect.misses, sttStatsBeforeInspect.misses, '/voice sttcache should not increment STT misses');
  assert.strictEqual(sttStatsAfterInspect.downloadMisses, sttStatsBeforeInspect.downloadMisses, '/voice sttcache should not download audio');
  assert.strictEqual(sttStatsAfterInspect.transcriptMisses, sttStatsBeforeInspect.transcriptMisses, '/voice sttcache should not call transcription');

  handler.handleEvent(makePlainEvent(815, 9, '/vision status'));
  await waitFor(() => sent.length === 5, 'vision status diagnostics');
  const visionText = firstText(sent[4].message);
  assert.ok(visionText.includes('识图状态'), 'vision status should render panel');
  assert.ok(visionText.includes('诊断:'), 'vision status should include diagnosis');
  assert.ok(visionText.includes('附图解析:'), 'vision status should include attached image parsing state');
  assert.ok(visionText.includes('最近识图:'), 'vision status should include last vision trace summary');
  assert.ok(visionText.includes('下一步:'), 'vision status should include next action');

  handler.handleEvent(makePlainEvent(816, 9, '/vision check https://example.com/a.jpg https://example.com/b.jpg https://example.com/c.jpg'));
  await waitFor(() => sent.length === 6, 'vision preflight diagnostics');
  const visionCheckText = firstText(sent[5].message);
  assert.ok(visionCheckText.includes('识图预检'), 'vision check should render preflight panel');
  assert.ok(visionCheckText.includes('不下载图片，不调用模型'), 'vision check should be non-mutating');
  assert.ok(visionCheckText.includes('输入3张 / 将传2/3'), 'vision check should expose vision_max_images truncation');
  assert.ok(visionCheckText.includes('来源类型:'), 'vision check should expose image source kinds');
  assert.ok(visionCheckText.includes('缓存预检:'), 'vision check should expose per-source image cache preflight');
  assert.ok(visionCheckText.includes('miss'), 'vision check should expose image cache miss state without downloading');
  assert.ok(visionCheckText.includes('预热图片缓存'), 'vision check should suggest cache warmup when sources are misses');
  assert.ok(visionCheckText.includes('风险:'), 'vision check should expose image delivery/config risks');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(220), Buffer.from([0xff, 0xd9])]);
  let imageRequests = 0;
  let modelRequests = 0;
  const visionWarmServer = http.createServer((req, res) => {
    if (req.method === 'POST') {
      modelRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '图片里能看到一张测试图片。' } }] }));
      return;
    }
    imageRequests++;
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  await new Promise((resolve) => visionWarmServer.listen(0, '127.0.0.1', resolve));
  const visionWarmAddress = visionWarmServer.address();
  const oldApiUrl = config.ai.api_url;
  try {
    config.ai.api_url = `http://127.0.0.1:${visionWarmAddress.port}/v1/chat/completions`;
    const warmUrl = `http://127.0.0.1:${visionWarmAddress.port}/smoke-${Date.now()}.jpg`;
    handler.handleEvent(makePlainEvent(817, 9, `/vision warm ${warmUrl}`));
    await waitFor(() => sent.length === 7, 'vision image cache warm command');
    const visionWarmText = firstText(sent[6].message);
    assert.ok(visionWarmText.includes('图片缓存预热'), '/vision warm should render image cache warm panel');
    assert.ok(visionWarmText.includes('不调用视觉模型'), '/vision warm should disclose no model call');
    assert.ok(visionWarmText.includes('预热动作: warmed 1'), '/vision warm should download and cache a missing remote image');
    assert.ok(visionWarmText.includes('预热后: hit 1'), '/vision warm should report cache hit after warmup');
    assert.strictEqual(imageRequests, 1, '/vision warm should download the image once');
    assert.strictEqual(modelRequests, 0, '/vision warm should not call the vision model');

    const mediaWarmUrl = `http://127.0.0.1:${visionWarmAddress.port}/media-smoke-${Date.now()}.jpg`;
    handler.handleEvent(makePlainEvent(818, 9, `/media warm ${mediaWarmUrl} https://example.com/a.mp3`));
    await waitFor(() => sent.length === 8, 'media cache warm command');
    const mediaWarmText = firstText(sent[7].message);
    assert.ok(mediaWarmText.includes('多模态缓存预热'), '/media warm should render aggregate cache warm panel');
    assert.ok(mediaWarmText.includes('图片缓存预热'), '/media warm should include image cache warm section');
    assert.ok(mediaWarmText.includes('听写缓存预检'), '/media warm should include STT cache preflight section');
    assert.ok(mediaWarmText.includes('语音只读检查STT缓存，不听写、不调用模型'), '/media warm should not transcribe audio');
    assert.ok(mediaWarmText.includes('预热动作: warmed 1'), '/media warm should warm a missing remote image');
    assert.ok(mediaWarmText.includes('状态=miss'), '/media warm should expose STT cache miss without transcription');
    assert.strictEqual(imageRequests, 2, '/media warm should download the image once');
    assert.strictEqual(modelRequests, 0, '/media warm should not call any model');

    const visionTestUrl = `http://127.0.0.1:${visionWarmAddress.port}/vision-test-${Date.now()}.jpg`;
    handler.handleEvent(makePlainEvent(819, 9, `/vision test ${visionTestUrl}`));
    await waitFor(() => sent.length === 9, 'vision model test command');
    const visionTestText = firstText(sent[8].message);
    assert.ok(visionTestText.includes('识图链路测试'), '/vision test should render end-to-end panel');
    assert.ok(visionTestText.includes('缓存前: miss'), '/vision test should expose cache state before download');
    assert.ok(visionTestText.includes('缓存后: hit'), '/vision test should expose cache state after download');
    assert.ok(visionTestText.includes('调用: OK'), '/vision test should call the vision model');
    assert.ok(visionTestText.includes('模型返回了可见描述'), '/vision test should classify visible model output');
    assert.ok(visionTestText.includes('下载 OK 且调用 OK'), '/vision test should explain cache-vs-model boundary');
    assert.strictEqual(imageRequests, 3, '/vision test should download the image once');
    assert.strictEqual(modelRequests, 1, '/vision test should call the vision model once');
  } finally {
    config.ai.api_url = oldApiUrl;
    await new Promise((resolve) => visionWarmServer.close(resolve));
  }

  handler.handleEvent(makePlainEvent(819, 9, '/media check https://example.com/a.jpg https://example.com/b.png https://example.com/c.webp https://example.com/a.mp3 https://example.com/b.wav'));
  await waitFor(() => sent.length === 10, 'media multimodal preflight diagnostics');
  const mediaCheckText = firstText(sent[9].message);
  assert.ok(mediaCheckText.includes('多模态预检'), 'media check should render multimodal preflight panel');
  assert.ok(mediaCheckText.includes('不下载图片、不听写语音、不调用模型'), 'media check should be non-mutating');
  assert.ok(mediaCheckText.includes('图片: 输入3张 / 将传2/3'), 'media check should expose image truncation');
  assert.ok(mediaCheckText.includes('图片缓存预检:'), 'media check should expose image cache preflight');
  assert.ok(mediaCheckText.includes('语音: 输入2条 / 将听写1/2'), 'media check should expose STT truncation');
  assert.ok(mediaCheckText.includes('语音缓存预检:'), 'media check should expose STT cache preflight');
  assert.ok(mediaCheckText.includes('音缓存1: miss'), 'media check should expose STT cache miss state without transcription');
  assert.ok(mediaCheckText.includes('预热听写缓存'), 'media check should suggest STT cache warmup when sources are misses');
  assert.ok(mediaCheckText.includes('回复边界:'), 'media check should expose truth boundary for multimodal replies');
  assert.ok(mediaCheckText.includes('只能描述实际传入模型的前2张图片'), 'media check should warn against describing truncated images');
  assert.ok(mediaCheckText.includes('只能接听写成功的前1条语音'), 'media check should warn against pretending to hear truncated records');

  const voiceWarmCountPath = path.resolve(__dirname, '..', 'voice_cache', `smoke-voice-warm-${Date.now()}.txt`);
  const oldVoiceWarmCountPath = process.env.SMOKE_VOICE_WARM_COUNT;
  const voiceWarmText = `通用语音预热 smoke ${Date.now()}`;
  config.ai.tts_provider = 'local';
  config.ai.tts_local_command = `"${process.execPath}" -e "const fs=require('fs');const path=require('path');fs.appendFileSync(process.env.SMOKE_VOICE_WARM_COUNT,'1');const out=process.env.QQBOT_TTS_OUTPUT;const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+220,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(220,40);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,Buffer.concat([h,Buffer.alloc(220)]));console.log(out);"`;
  config.ai.tts_max_chars = 120;
  try {
    process.env.SMOKE_VOICE_WARM_COUNT = voiceWarmCountPath;
    handler.handleEvent(makePlainEvent(820, 9, `/voice warm ${voiceWarmText}`));
    await waitFor(() => sent.length === 11, 'voice warm non-admin guard');
    assert.ok(firstText(sent[10].message).includes('管理员'), '/voice warm should be admin-only because it generates TTS');

    handler.handleEvent(makePlainEvent(821, 1, `/voice warm ${voiceWarmText}`));
    await waitFor(() => sent.length === 12, 'voice warm command');
    const voiceWarmPanel = firstText(sent[11].message);
    assert.ok(voiceWarmPanel.includes('语音缓存预热'), '/voice warm should render warm panel');
    assert.ok(voiceWarmPanel.includes('不调用AI，不发送record'), '/voice warm should disclose non-send behavior');
    assert.ok(voiceWarmPanel.includes('预热动作: generated 1'), '/voice warm should generate missing cache');
    assert.ok(voiceWarmPanel.includes('预热后: hit 1'), '/voice warm should report post-generation cache hit');
    assert.strictEqual(fs.readFileSync(voiceWarmCountPath, 'utf-8').length, 1, '/voice warm should run local TTS once for a new text');

    handler.handleEvent(makePlainEvent(822, 1, `/voice warm ${voiceWarmText}`));
    await waitFor(() => sent.length === 13, 'voice warm cache hit no-op');
    const voiceWarmHitPanel = firstText(sent[12].message);
    assert.ok(voiceWarmHitPanel.includes('预热动作: generated 0 / hit 1'), '/voice warm should no-op when cache already hit');
    assert.strictEqual(fs.readFileSync(voiceWarmCountPath, 'utf-8').length, 1, '/voice warm hit should not rerun local TTS');

    handler.handleEvent(makePlainEvent(823, 9, '/voice clone status'));
    await waitFor(() => sent.length === 14, 'voice clone status boundary');
    const cloneStatusText = firstText(sent[13].message);
    assert.ok(cloneStatusText.includes('Voice Clone 状态'), '/voice clone status should render clone status panel');
    assert.ok(cloneStatusText.includes('授权样本'), '/voice clone status should mention authorized samples');
    assert.ok(cloneStatusText.includes('不能说成现实主播本人语音'), '/voice clone status should expose impersonation boundary');
    assert.ok(cloneStatusText.includes('不能拿去冒充本人'), '/voice clone status should forbid impersonation');

    handler.handleEvent(makePlainEvent(824, 9, '/media status'));
    await waitFor(() => sent.length === 15, 'media aggregate status');
    const mediaStatusText = firstText(sent[14].message);
    assert.ok(mediaStatusText.includes('多模态状态'), '/media status should render aggregate multimodal panel');
    assert.ok(mediaStatusText.includes('只读聚合状态'), '/media status should be non-mutating');
    assert.ok(mediaStatusText.includes('图片缓存:'), '/media status should expose image cache');
    assert.ok(mediaStatusText.includes('语音缓存:'), '/media status should expose voice cache');
    assert.ok(mediaStatusText.includes('礼物:'), '/media status should expose gift thanks counters');
    assert.ok(mediaStatusText.includes('回复边界:'), '/media status should expose multimodal truth boundary');
    assert.ok(mediaStatusText.includes('克隆/授权样本不能说成现实主播本人语音'), '/media status should preserve clone impersonation boundary');

    handler.handleEvent(makePlainEvent(825, 9, '/media daily'));
    await waitFor(() => sent.length === 16, 'media aggregate daily card');
    const mediaDailyText = firstText(sent[15].message);
    assert.ok(mediaDailyText.includes('多模态每日牌'), '/media daily should render daily multimodal card');
    assert.ok(mediaDailyText.includes('只读每日状态'), '/media daily should be non-mutating');
    assert.ok(mediaDailyText.includes('今日链路:'), '/media daily should summarize daily media readiness');
    assert.ok(mediaDailyText.includes('今日实跑:'), '/media daily should summarize today real multimodal runs');
    assert.ok(mediaDailyText.includes('今日三件套:'), '/media daily should expose the daily multimodal checklist');
    assert.ok(mediaDailyText.includes('今日完成度:'), '/media daily should expose ready-chain completion progress');
    assert.ok(mediaDailyText.includes('优先补:'), '/media daily should suggest the next real multimodal test');
    assert.ok(mediaDailyText.includes('check/warm/cache hit 不算实跑'), '/media daily should define the daily real-run criteria');
    assert.ok(mediaDailyText.includes('今日缺口:'), '/media daily should surface missing real traces for today');
    assert.ok(mediaDailyText.includes('今日小任务:'), '/media daily should include a concrete daily action');
    assert.ok(mediaDailyText.includes('缓存 hit 不等于模型已看图或重新听音频'), '/media daily should preserve cache truth boundary');

    handler.handleEvent(makePlainEvent(826, 9, '识图语音每日牌'));
    await waitFor(() => sent.length === 17, 'natural media daily card');
    const naturalMediaDailyText = firstText(sent[16].message);
    assert.ok(naturalMediaDailyText.includes('多模态每日牌'), 'natural media daily trigger should render daily multimodal card');
    assert.ok(naturalMediaDailyText.includes('只读每日状态'), 'natural media daily trigger should stay non-mutating');
    assert.ok(naturalMediaDailyText.includes('今日实跑:'), 'natural media daily trigger should include today real run counters');
    assert.ok(naturalMediaDailyText.includes('今日三件套:'), 'natural media daily trigger should include the daily multimodal checklist');
    assert.ok(naturalMediaDailyText.includes('今日完成度:'), 'natural media daily trigger should include completion progress');

    handler.handleEvent(makePlainEvent(827, 9, '今日三件套'));
    await waitFor(() => sent.length === 18, 'natural media checklist card');
    const naturalMediaChecklistText = firstText(sent[17].message);
    assert.ok(naturalMediaChecklistText.includes('多模态每日牌'), 'natural media checklist trigger should render daily card');
    assert.ok(naturalMediaChecklistText.includes('今日三件套:'), 'natural media checklist trigger should include checklist line');
    assert.ok(naturalMediaChecklistText.includes('优先补:'), 'natural media checklist trigger should include priority action');

    handler.handleEvent(makePlainEvent(829, 9, '今天识图语音跑了吗'));
    await waitFor(() => sent.length === 19, 'natural media ran today card');
    const naturalMediaRanText = firstText(sent[18].message);
    assert.ok(naturalMediaRanText.includes('多模态每日牌'), 'natural ran-today trigger should render daily card');
    assert.ok(naturalMediaRanText.includes('今日实跑:'), 'natural ran-today trigger should answer real run counters');
    assert.ok(naturalMediaRanText.includes('check/warm/cache hit 不算实跑'), 'natural ran-today trigger should keep real-run boundary');

    handler.handleEvent(makePlainEvent(828, 9, '/media recent 2'));
    await waitFor(() => sent.length === 20, 'media aggregate recent');
    const mediaRecentText = firstText(sent[19].message);
    assert.ok(mediaRecentText.includes('多模态最近记录'), '/media recent should render aggregate recent panel');
    assert.ok(mediaRecentText.includes('--- 识图 ---'), '/media recent should include vision section');
    assert.ok(mediaRecentText.includes('识图最近记录'), '/media recent should reuse vision recent traces');
    assert.ok(mediaRecentText.includes('语音最近记录'), '/media recent should reuse voice recent traces');
    assert.ok(mediaRecentText.includes('礼物感谢最近记录'), '/media recent should reuse gift recent traces');
    assert.ok(mediaRecentText.includes('没出现在记录里的输入不能当作已看/已听/已感谢'), '/media recent should expose trace boundary');

    handler.handleEvent(makePlainEvent(830, 9, '语音状态'));
    await waitFor(() => sent.length === 21, 'natural voice status diagnostics');
    const naturalVoiceStatusText = firstText(sent[20].message);
    assert.ok(naturalVoiceStatusText.includes('语音状态'), 'natural voice status trigger should render voice panel');
    assert.ok(naturalVoiceStatusText.includes('TTS诊断:'), 'natural voice status should include TTS diagnosis');
    assert.ok(naturalVoiceStatusText.includes('STT诊断:'), 'natural voice status should include STT diagnosis');

    handler.handleEvent(makePlainEvent(831, 9, '识图状态'));
    await waitFor(() => sent.length === 22, 'natural vision status diagnostics');
    const naturalVisionStatusText = firstText(sent[21].message);
    assert.ok(naturalVisionStatusText.includes('识图状态'), 'natural vision status trigger should render vision panel');
    assert.ok(naturalVisionStatusText.includes('诊断:'), 'natural vision status should include diagnosis');
    assert.ok(naturalVisionStatusText.includes('附图解析:'), 'natural vision status should include attachment parsing state');

    handler.handleEvent(makePlainEvent(832, 9, '多模态状态'));
    await waitFor(() => sent.length === 23, 'natural media status diagnostics');
    const naturalMediaStatusText = firstText(sent[22].message);
    assert.ok(naturalMediaStatusText.includes('多模态状态'), 'natural media status trigger should render aggregate panel');
    assert.ok(naturalMediaStatusText.includes('只读聚合状态'), 'natural media status should render status instead of daily card');
    assert.ok(!naturalMediaStatusText.includes('多模态每日牌'), 'natural media status should not be routed to media daily');
  } finally {
    if (typeof oldVoiceWarmCountPath === 'string') process.env.SMOKE_VOICE_WARM_COUNT = oldVoiceWarmCountPath;
    else delete process.env.SMOKE_VOICE_WARM_COUNT;
    if (fs.existsSync(voiceWarmCountPath)) fs.unlinkSync(voiceWarmCountPath);
  }

  aiChat.shutdownAiChat();
}

async function testVoiceSttEndToEndDiagnostics() {
  const config = makeConfigForHandler();
  config.ai.enable_stt = true;
  config.ai.stt_provider = 'local';
  config.ai.stt_local_command = `"${process.execPath}" -e "const fs=require('fs');const text='听写真链路 smoke';fs.writeFileSync(process.env.QQBOT_STT_OUTPUT,text,'utf-8');console.log(text);"`;
  config.ai.stt_max_records = 1;
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(39_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  const audioPath = path.resolve(__dirname, '..', 'stt_cache', `smoke-stt-e2e-${Date.now()}.wav`);

  try {
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    fs.writeFileSync(audioPath, makeWavBuffer());

    const cacheBefore = stt.inspectSttCacheSources(config.ai, [audioPath], 1)[0];
    if (cacheBefore.filepath && fs.existsSync(cacheBefore.filepath)) fs.unlinkSync(cacheBefore.filepath);

    handler.handleEvent(makePlainEvent(826, 9, `/voice stt ${audioPath}`));
    await waitFor(() => sent.length === 1, 'voice stt end-to-end first run');
    const firstPanel = firstText(sent[0].message);
    assert.ok(firstPanel.includes('听写链路测试'), '/voice stt should render end-to-end STT panel');
    assert.ok(firstPanel.includes('语音源: local-path'), '/voice stt should expose source kind');
    assert.ok(firstPanel.includes('缓存前: miss'), '/voice stt should expose cache state before transcription');
    assert.ok(firstPanel.includes('缓存后: hit'), '/voice stt should expose cache state after transcription');
    assert.ok(firstPanel.includes('后端动作: local+1 api+0'), '/voice stt should expose real local backend run');
    assert.ok(firstPanel.includes('cacheMiss+1'), '/voice stt should count cache miss on first run');
    assert.ok(firstPanel.includes('听写: OK'), '/voice stt should expose successful transcription');
    assert.ok(firstPanel.includes('转写: 听写真链路 smoke'), '/voice stt should include transcript preview');
    assert.ok(firstPanel.includes('STT缓存 hit 只代表转写文本可复用'), '/voice stt should expose cache truth boundary');

    handler.handleEvent(makePlainEvent(827, 9, `/voice stt ${audioPath}`));
    await waitFor(() => sent.length === 2, 'voice stt end-to-end cache hit');
    const secondPanel = firstText(sent[1].message);
    assert.ok(secondPanel.includes('缓存前: hit'), '/voice stt cache hit should expose pre-hit state');
    assert.ok(secondPanel.includes('缓存后: hit'), '/voice stt cache hit should remain hit');
    assert.ok(secondPanel.includes('后端动作: local+0 api+0'), '/voice stt cache hit should not rerun local/API backend');
    assert.ok(secondPanel.includes('cacheHit+1 cacheMiss+0'), '/voice stt cache hit should count cache reuse');
    assert.ok(secondPanel.includes('没有重新听音频'), '/voice stt cache hit should explain cache reuse boundary');
  } finally {
    const cacheAfter = stt.inspectSttCacheSources(config.ai, [audioPath], 1)[0];
    if (cacheAfter.filepath && fs.existsSync(cacheAfter.filepath)) fs.unlinkSync(cacheAfter.filepath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    aiChat.shutdownAiChat();
  }
}

async function testDataCommandObservability() {
  const config = makeConfigForHandler();
  config.ai.enable_vision = true;
  config.ai.enable_tts = true;
  config.ai.enable_stt = true;
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(37_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(diagPlugin);

  search.__clearSearchCacheForTests();
  search.__setSearchRunnerForTests(async () => 'HLTV sample result\nhttps://www.hltv.org/matches');
  hltv.clearHltvCache();
  hltv.__test.setCacheEntryForTests(
    'ranking',
    [
      '来源：CS API / VRS排名镜像 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '#1 Vitality 2100分',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 5_000, source: 'test-data-ranking' },
  );
  diagTest.setCsDataHealthCheckerForTests(async () => ({
    ok: true,
    source: {
      primary: 'CS API smoke',
      primaryBaseUrl: 'https://api.csapi.de',
      fallback: ['Liquipedia', 'webSearch'],
      note: 'smoke source note',
    },
    cache: { entries: 1, keys: ['ranking'] },
    checks: [
      { name: 'ranking', ok: true, lines: 3, snippet: 'Valve Regional Standings sample' },
      { name: 'recent-results', ok: true, lines: 2, snippet: 'NAVI 2-1 Vitality' },
    ],
  }));
  try {
    handler.handleEvent(makePlainEvent(810, 9, '/data'));
    await waitFor(() => sent.length === 1, 'data command observability');
    const text = firstText(sent[0].message);
    assert.ok(text.includes('实时数据状态'), '/data should render realtime data panel');
    assert.ok(text.includes('--- CS事实覆盖 ---'), '/data should render CS fact coverage section');
    assert.ok(text.includes('当前事实判定'), '/data should judge whether CS data supports current facts');
    assert.ok(text.includes('/cs verify all'), '/data should expose the all-target fact verify command');
    assert.ok(text.includes('/cs evidence all'), '/data should expose the all-target evidence command');
    assert.ok(text.includes('/cs warm plan'), '/data should expose warm-plan remediation');
    assert.ok(text.includes('stale/miss'), '/data should explain stale/miss truth boundary');
    assert.ok(text.includes('事实类型覆盖:'), '/data should render typed CS fact coverage');
    assert.ok(text.includes('当前排名: ranking=fresh'), '/data typed coverage should expose ranking freshness');
    assert.ok(text.includes('阵容/转会: 按队伍目标核验'), '/data typed coverage should keep roster facts target-scoped');
    assert.ok(text.includes('ranking fresh 不能替代阵容/转会证据'), '/data typed coverage should not let ranking support roster facts');
    assert.ok(text.includes('选手数据/状态: 按选手目标核验'), '/data typed coverage should keep player facts target-scoped');
    assert.ok(text.includes('版本/地图池: 暂无全局实时缓存'), '/data typed coverage should expose version/map-pool gap');
    assert.ok(text.includes('--- 每日CS / 多模态 ---'), '/data should render daily CS multimodal section');
    assert.ok(text.includes('搜索缓存'), '/data should expose search cache stats');
    assert.ok(text.includes('每日CS池'), '/data should expose daily CS pool counts');
    assert.ok(text.includes('真实图策略'), '/data should describe real-image strategy');
    assert.ok(text.includes('Liquipedia图解析'), '/data should expose Liquipedia image resolver stats');
    assert.ok(text.includes('图片缓存'), '/data should expose image cache stats');
    assert.ok(text.includes('识图'), '/data should expose vision status');
    assert.ok(text.includes('语音'), '/data should expose TTS status');
    assert.ok(text.includes('听写'), '/data should expose STT status');
    assert.ok(text.includes('AI回复缓存'), '/data should expose AI reply cache stats');
    assert.ok(text.includes('用户画像缓存'), '/data should expose user profile cache stats');
    assert.ok(text.includes('回复真实性'), '/data should expose reply authenticity counters');
    assert.ok(text.includes('风格场景'), '/data should expose style scene stats');
    assert.ok(text.includes('--- 知识库 ---'), '/data should expose knowledge status');
  } finally {
    diagTest.setCsDataHealthCheckerForTests();
    search.__setSearchRunnerForTests();
    search.__clearSearchCacheForTests();
    hltv.clearHltvCache();
  }
}

async function testDiagStorageDiagnostics() {
  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(37_100 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(diagPlugin);

  handler.handleEvent(makePlainEvent(811, 9, '/diag'));
  await waitFor(() => sent.length === 1, 'diag storage diagnostics');
  const text = firstText(sent[0].message);
  assert.ok(text.includes('严格自检'), '/diag should render strict diagnostic panel');
  assert.ok(text.includes('写盘: OK'), '/diag should expose runtime storage probe status');
  assert.ok(text.includes('data=ok'), '/diag should check data/ storage');
  assert.ok(text.includes('local-tts=ok'), '/diag should check local TTS output storage');
  assert.ok(text.includes('inbox=ok'), '/diag should check knowledge inbox storage');
  assert.ok(text.includes('运行目录写盘探针通过'), '/diag should add write probe result to OK list');
}

async function waitFor(condition, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function testMessageReplyTargeting() {
  const config = makeConfigForHandler();
  const sent = [];
  const getMsgCalls = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(90_000 + sent.length);
      return true;
    },
    callApiAsync: async (action, params) => {
      getMsgCalls.push({ action, params });
      if (action === 'get_msg') {
        return { retcode: 0, data: { sender: { user_id: 3853043835 } } };
      }
      return { retcode: 0, data: {} };
    },
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  const prompts = [];
  let inactiveAttempts = 0;

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const content = messages.map((message) => typeof message.content === 'string'
      ? message.content
      : message.content.map((item) => item.text || '').join('\n')).join('\n');
    prompts.push(content);
    const matches = [...content.matchAll(/message_id: (\d+)/g)];
    const id = matches.length > 0 ? matches.at(-1)[1] : 'unknown';
    if (id === '104') return '（直播口吻接弹幕）不是哥们 这个括号真不能有';
    if (id === '105') return '';
    if (id === '106') return '长回复'.repeat(120);
    if (id === '107') return '收到语音了';
    if (id === '108') return '6';
    if (id === '109') {
      inactiveAttempts++;
      return inactiveAttempts === 1 ? '未激活回答' : '这下接住了';
    }
    if (id === '110') throw new Error('HTTP 503: upstream timeout');
    return `reply-${id}`;
  });

  try {
    handler.handleEvent(makeEvent(101, 11, ' 第一条'));
    handler.handleEvent(makeEvent(102, 12, ' 第二条'));
    handler.handleEvent(makeEvent(103, 13, ' 第三条'));
    await waitFor(() => sent.length === 3, 'three forced replies');

    assert.deepStrictEqual(
      sent.map((item) => item.message.find((seg) => seg.type === 'reply')?.data.id),
      ['101', '102', '103'],
      'forced replies should quote the matching original message ids',
    );
    assert.deepStrictEqual(
      sent.map((item) => item.message.find((seg) => seg.type === 'text')?.data.text),
      ['reply-101', 'reply-102', 'reply-103'],
      'LLM should receive each current message snapshot in FIFO order',
    );
    assert.ok(prompts.every((prompt, index) => prompt.includes(`message_id: ${101 + index}`)));

    const beforeStageLabel = sent.length;
    handler.handleEvent(makeEvent(104, 14, ' 不要括号'));
    await waitFor(() => sent.length === beforeStageLabel + 1, 'stage label reply');
    assert.strictEqual(
      sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text,
      '这个括号真不能有',
      'stage direction label and formulaic opener should be stripped from LLM output',
    );

    const beforeEmpty = sent.length;
    handler.handleEvent(makeEvent(105, 15, ' 空回复也必须兜底'));
    await waitFor(() => sent.length === beforeEmpty + 1, 'empty forced fallback');
    assert.strictEqual(sent.at(-1).message.find((seg) => seg.type === 'reply')?.data.id, '105');
    assert.ok(
      sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text.length > 0,
      'forced empty LLM output should still send a fallback reply',
    );

    const beforeLong = sent.length;
    handler.handleEvent(makeEvent(106, 16, ' 长回复也要引用'));
    await waitFor(() => sent.length === beforeLong + 1, 'long forced quote');
    assert.strictEqual(
      sent.at(-1).message.find((seg) => seg.type === 'reply')?.data.id,
      '106',
      'forced replies should quote even when text is long',
    );

    const beforeRecord = sent.length;
    handler.handleEvent(makeEvent(107, 17, '', [{ type: 'record', data: { file: 'voice.amr', url: 'http://example.com/voice.amr' } }]));
    await waitFor(() => sent.length === beforeRecord + 1, 'record forced reply');
    assert.strictEqual(sent.at(-1).message.find((seg) => seg.type === 'reply')?.data.id, '107');
    assert.ok(prompts.some((prompt) => prompt.includes('消息含1条语音')), 'record count should be included in the job snapshot');

    const beforeNumeric = sent.length;
    handler.handleEvent(makeEvent(108, 18, ' 模型别只回数字'));
    await waitFor(() => sent.length === beforeNumeric + 1, 'numeric output rewrite');
    const numericText = sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text;
    assert.ok(numericText && !/^[\d\s.,，。!！?？]+$/.test(numericText), 'numeric-only LLM output should be rewritten');

    const beforeInactive = sent.length;
    handler.handleEvent(makeEvent(109, 19, ' 你别再未激活了'));
    await waitFor(() => sent.length === beforeInactive + 1, 'inactive activation retry reply');
    assert.strictEqual(inactiveAttempts, 2, 'inactive activation output should be retried once');
    assert.strictEqual(
      sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text,
      '这下接住了',
      'inactive activation output should not be sent to the group',
    );

    handler.handleEvent(makePlainEvent(909, 19, '/trace last'));
    await waitFor(() => sent.length === beforeInactive + 2, 'trace after inactive retry');
    assert.ok(firstText(sent.at(-1).message).includes('修复: inactive activation reply retried'), 'trace should show inactive activation repair');

    const beforeApiFailure = sent.length;
    handler.handleEvent(makeEvent(110, 20, ' 你这把怎么看'));
    await waitFor(() => sent.length === beforeApiFailure + 1, 'api failure human fallback', 15000);
    const apiFallbackText = sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text || '';
    assertNoTechnicalChatFallback(apiFallbackText, 'forced API failure fallback');

    handler.handleEvent(makePlainEvent(910, 20, '/trace last'));
    await waitFor(() => sent.length === beforeApiFailure + 2, 'trace after api failure fallback');
    assert.ok(firstText(sent.at(-1).message).includes('HTTP 503'), 'trace should keep the real API error for admins');

    const before = sent.length;
    handler.handleEvent(makeEvent(201, 21, ' 回复旧消息', [{ type: 'reply', data: { id: '77777' } }]));
    await waitFor(() => sent.length === before + 1, 'reply-to-bot forced reply');
    assert.strictEqual(getMsgCalls.some((call) => call.action === 'get_msg' && call.params.message_id === 77777), true);
    assert.strictEqual(sent.at(-1).message.find((seg) => seg.type === 'reply')?.data.id, '201');
    assert.ok(
      prompts.some((prompt) => prompt.includes('message_id: 201') && prompt.includes('按玩机器直播间接弹幕的语气顺着回')),
      'reply-to-bot prompt should explicitly request live-style follow-up',
    );
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testNoApiKeyHumanFallback() {
  const config = makeConfigForHandler();
  config.ai.api_key = '在这里填入你的API密钥';
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(95_000 + sent.length);
      return true;
    },
    callApiAsync: async (action) => {
      if (action === 'get_msg') {
        return { retcode: 0, data: { sender: { user_id: 3853043835 } } };
      }
      return { retcode: 0, data: {} };
    },
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  let llmCalls = 0;
  aiChat.__setLLMCallerForTests(async () => {
    llmCalls++;
    return '不应该调用模型';
  });

  try {
    handler.handleEvent(makeEvent(111, 31, ' 你现在能聊吗'));
    await waitFor(() => sent.length === 1, 'missing API key @ fallback');
    assert.strictEqual(sent[0].message.find((seg) => seg.type === 'reply')?.data.id, '111');
    assertNoTechnicalChatFallback(firstText(sent[0].message), 'missing API key @ fallback');

    handler.handleEvent(makeEvent(112, 32, ' 上一句继续说', [{ type: 'reply', data: { id: '95001' } }]));
    await waitFor(() => sent.length === 2, 'missing API key reply-to-bot fallback');
    assert.strictEqual(sent[1].message.find((seg) => seg.type === 'reply')?.data.id, '112');
    assertNoTechnicalChatFallback(firstText(sent[1].message), 'missing API key reply-to-bot fallback');
    assert.strictEqual(llmCalls, 0, 'missing API key should not call LLM');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testExplicitVoiceReply() {
  const config = makeConfigForHandler();
  config.ai.enable_tts = true;
  config.ai.tts_provider = 'local';
  config.ai.tts_local_command = `"${process.execPath}" -e "const fs=require('fs');const out=process.env.QQBOT_TTS_OUTPUT;const cap=process.env.SMOKE_TTS_CAPTURE;if(cap)fs.writeFileSync(cap,process.env.QQBOT_TTS_TEXT||'','utf8');const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(256,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(220,40);fs.mkdirSync(require('path').dirname(out),{recursive:true});fs.writeFileSync(out,Buffer.concat([h,Buffer.alloc(220)]));console.log(out);"`;
  config.ai.tts_max_chars = 120;
  const capturePath = path.resolve(__dirname, '..', 'voice_cache', `smoke-tts-capture-${Date.now()}.txt`);
  process.env.SMOKE_TTS_CAPTURE = capturePath;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(91_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  let llmCalls = 0;
  const aiVoiceText = `AI自由发挥语音烟测${Date.now()}`;

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    llmCalls++;
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    assert.ok(content.includes('用户明确要求语音回复: 是'), 'prompt should mark explicit voice request');
    return aiVoiceText;
  });

  try {
    const directText = `直读语音烟测${Date.now()}`;
    handler.handleEvent(makePlainEvent(901, 91, `用语音回复 ${directText}`));
    await waitFor(() => sent.length === 1, 'explicit voice reply');
    assert.strictEqual(llmCalls, 0, 'verbatim voice reply should bypass LLM');
    assert.ok(!sent[0].message.some((seg) => seg.type === 'reply'), 'record message should not include reply segment because QQ may fail to play reply+record');
    assert.ok(sent[0].message.some((seg) => seg.type === 'record'), 'explicit voice request should send record segment');
    const record = sent[0].message.find((seg) => seg.type === 'record');
    assert.ok(record.data.file.startsWith('base64://'), 'Docker NapCat default should send TTS as base64 record segment');
    assert.strictEqual(fs.readFileSync(capturePath, 'utf-8'), directText, 'verbatim voice reply should speak exactly the user provided text');

    const directText2 = `云朵原神 smoke ${Date.now()}？好想玩原神`;
    handler.handleEvent(makeEvent(906, 96, ` 直接用语音念 ${directText2}`));
    await waitFor(() => sent.length === 2, 'direct voice read with at mention');
    assert.strictEqual(llmCalls, 0, 'direct voice read should bypass LLM even with at mention');
    assert.ok(sent[1].message.some((seg) => seg.type === 'record'), 'direct voice read should send record segment');
    assert.strictEqual(fs.readFileSync(capturePath, 'utf-8'), directText2, 'direct voice read should speak the exact text after the instruction');

    handler.handleEvent(makePlainEvent(907, 97, '/voice last'));
    await waitFor(() => sent.length === 3, 'voice last after direct voice');
    const voiceLastText = firstText(sent[2].message);
    assert.ok(voiceLastText.includes('最近语音 trace'), 'voice last should render trace header');
    assert.ok(voiceLastText.includes('direct-verbatim'), 'voice last should show direct verbatim mode');
    assert.ok(voiceLastText.includes(directText2.slice(0, 12)), 'voice last should include spoken text preview');

    handler.handleEvent(makePlainEvent(905, 95, '用语音回答 这波语音链路怎么样'));
    await waitFor(() => sent.length === 4, 'ai voice answer', 8000);
    assert.strictEqual(llmCalls, 1, 'voice answer should call LLM when user asks for an answer');
    assert.ok(sent[3].message.some((seg) => seg.type === 'record'), 'voice answer should send record segment');
    assert.strictEqual(fs.readFileSync(capturePath, 'utf-8'), aiVoiceText, 'voice answer should speak the LLM response');

    handler.handleEvent(makePlainEvent(908, 98, '/voice recent 3'));
    await waitFor(() => sent.length === 5, 'voice recent after direct and ai voice');
    const voiceRecentText = firstText(sent[4].message);
    assert.ok(voiceRecentText.includes('语音最近记录'), '/voice recent should render recent voice traces');
    assert.ok(voiceRecentText.includes('mid=905'), '/voice recent should include ai voice message id');
    assert.ok(voiceRecentText.includes('ai-voice'), '/voice recent should show ai voice mode');
    assert.ok(voiceRecentText.includes('mid=906'), '/voice recent should include direct voice message id');
    assert.ok(voiceRecentText.includes('direct-verbatim'), '/voice recent should show direct verbatim mode');
    assert.ok(voiceRecentText.includes(directText2.slice(0, 12)), '/voice recent should include spoken text preview');
  } finally {
    delete process.env.SMOKE_TTS_CAPTURE;
    if (fs.existsSync(capturePath)) fs.unlinkSync(capturePath);
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testOpaqueOneBotRecordResolution() {
  const config = makeConfigForHandler();
  config.ai.enable_stt = true;
  config.ai.stt_provider = 'local';
  config.ai.stt_record_format = 'mp3';
  config.ai.stt_max_records = 1;
  config.ai.stt_local_command = `"${process.execPath}" -e "const fs=require('fs');fs.writeFileSync(process.env.QQBOT_STT_OUTPUT,'听写到了这段语音','utf-8');console.log('听写到了这段语音');"`;
  const sent = [];
  const apiCalls = [];
  const wavBase64 = (seed) => {
    const wav = makeWavBuffer();
    wav[wav.length - 1] = seed;
    return wav.toString('base64');
  };
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(92_000 + sent.length);
      return true;
    },
    callApiAsync: async (action, params) => {
      apiCalls.push({ action, params });
      if (action === 'get_record') {
        const seed = String(params.file || '').includes('token-2') ? 2 : 1;
        return { retcode: 0, data: { base64: wavBase64(seed) } };
      }
      return { retcode: 0, data: {} };
    },
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    assert.ok(content.includes('消息含2条语音'), 'opaque record should be counted');
    assert.ok(content.includes('语音听写: 听写到了这段语音'), 'opaque record should be resolved and transcribed');
    assert.ok(content.includes('最多听写前1条'), 'opaque record prompt should disclose STT truncation');
    return '听到了 这段语音链路是通的';
  });

  try {
    handler.handleEvent(makeEvent(902, 92, '', [
      { type: 'record', data: { file: 'opaque-record-token-1.amr' } },
      { type: 'record', data: { file: 'opaque-record-token-2.amr' } },
    ]));
    await waitFor(() => sent.length === 1, 'opaque record reply');
    assert.ok(
      apiCalls.some((call) => call.action === 'get_record' && call.params.file === 'opaque-record-token-1.amr' && call.params.out_format === 'mp3'),
      'opaque OneBot record should call get_record with configured output format',
    );
    assert.ok(apiCalls.some((call) => call.action === 'get_record' && call.params.file === 'opaque-record-token-2.amr'), 'opaque OneBot record resolver should inspect all attached record tokens before STT truncation');
    assert.strictEqual(sent[0].message.find((seg) => seg.type === 'reply')?.data.id, '902');

    handler.handleEvent(makePlainEvent(908, 92, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after opaque record reply');
    const trace = firstText(sent[1].message);
    assert.ok(trace.includes('语音有(2) data-urlx2 听写1/2 max1 已截断'), 'record trace should expose source kinds, transcript count, STT limit, and truncation');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testOpaqueOneBotImageResolution() {
  const config = makeConfigForHandler();
  config.ai.enable_vision = true;
  config.ai.vision_payload_mode = 'auto';
  config.ai.vision_max_images = 2;
  const sent = [];
  const apiCalls = [];
  const jpgBase64 = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(220, seed), Buffer.from([0xff, 0xd9])]).toString('base64');
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(93_000 + sent.length);
      return true;
    },
    callApiAsync: async (action, params) => {
      apiCalls.push({ action, params });
      if (action === 'get_image') {
        const seed = String(params.file || '').endsWith('3.jpg') ? 3 : String(params.file || '').endsWith('2.jpg') ? 2 : 1;
        return { retcode: 0, data: { base64: jpgBase64(seed) } };
      }
      return { retcode: 0, data: {} };
    },
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages, useVision) => {
    assert.strictEqual(useVision, true, 'opaque image should enable vision payload');
    const current = messages[messages.length - 1];
    assert.ok(Array.isArray(current.content), 'vision message should be multimodal');
    assert.strictEqual(current.content.filter((part) => part.type === 'image_url').length, 2, 'vision message should respect vision_max_images');
    const text = current.content.map((part) => part.text || '').join('\n');
    assert.ok(text.includes('最多处理前2张'), 'vision prompt should tell model when image inputs are truncated');
    return '图看到了 识图链路是通的';
  });

  try {
    handler.handleEvent(makeEvent(903, 93, ' 看下图', [
      { type: 'image', data: { file: 'opaque-image-token-1.jpg' } },
      { type: 'image', data: { file: 'opaque-image-token-2.jpg' } },
      { type: 'image', data: { file: 'opaque-image-token-3.jpg' } },
    ]));
    await waitFor(() => sent.length === 1, 'opaque image reply');
    assert.ok(
      apiCalls.some((call) => call.action === 'get_image' && call.params.file === 'opaque-image-token-1.jpg'),
      'opaque OneBot image should call get_image',
    );
    assert.ok(apiCalls.some((call) => call.action === 'get_image' && call.params.file === 'opaque-image-token-3.jpg'), 'opaque OneBot image resolver should inspect all attached image tokens before model truncation');
    assert.strictEqual(sent[0].message.find((seg) => seg.type === 'reply')?.data.id, '903');

    handler.handleEvent(makePlainEvent(904, 93, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after opaque image reply');
    const trace = firstText(sent[1].message);
    assert.ok(trace.includes('图片有(3)'), 'vision trace should expose original image count');
    assert.ok(trace.includes('base64x3'), 'vision trace should expose resolved image source kinds');
    assert.ok(trace.includes('识图已传图 2/3 max2 已截断'), 'vision trace should expose passed/total image count and truncation');
    assert.ok(trace.includes('识图缓存: 前 1:inline'), 'vision trace should expose pre-load image cache evidence');
    assert.ok(trace.includes('-> 后 1:inline'), 'vision trace should expose post-load image cache evidence');

    handler.handleEvent(makePlainEvent(905, 93, '/vision last'));
    await waitFor(() => sent.length === 3, 'vision last after opaque image reply');
    const visionLast = firstText(sent[2].message);
    assert.ok(visionLast.includes('最近识图 trace'), '/vision last should render a focused vision trace');
    assert.ok(visionLast.includes('图片: 有(3) base64x3'), '/vision last should expose original image count and source kinds');
    assert.ok(visionLast.includes('识图: 已传图 2/3 max2 已截断'), '/vision last should expose passed/total image count and truncation');
    assert.ok(visionLast.includes('图片缓存: 前 1:inline'), '/vision last should expose pre-load image cache evidence');
    assert.ok(visionLast.includes('-> 后 1:inline'), '/vision last should expose post-load image cache evidence');
    assert.ok(visionLast.includes('缓存边界'), '/vision last should explain cache evidence boundary');

    handler.handleEvent(makePlainEvent(906, 93, '/vision recent 3'));
    await waitFor(() => sent.length === 4, 'vision recent after opaque image reply');
    const visionRecent = firstText(sent[3].message);
    assert.ok(visionRecent.includes('识图最近记录'), '/vision recent should render recent vision traces');
    assert.ok(visionRecent.includes('mid=903'), '/vision recent should keep original image message id');
    assert.ok(visionRecent.includes('图片=有(3) base64x3'), '/vision recent should expose original image count and source kinds');
    assert.ok(visionRecent.includes('识图=已传图 2/3 max2 已截断'), '/vision recent should expose passed/total image count and truncation');
    assert.ok(visionRecent.includes('cache=前 1:inline'), '/vision recent should expose compact image cache evidence');
    assert.ok(visionRecent.includes('后 1:inline'), '/vision recent should expose post-load compact image cache evidence');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testKnowledgeInjectionAndHumanizedPostprocess() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.knowledge_force_style = true;
  config.ai.knowledge_max_chars = 1800;
  const sent = [];
  const capturedMessages = [];
  const profileStorePath = path.resolve(__dirname, '..', 'data', `user-profile-smoke-${Date.now()}.json`);
  userProfile.__test.setStorePathForTests(profileStorePath);
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(94_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    capturedMessages.push(messages);
    const runtimePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[临场笔记-本地语态与背景]'));
    assert.ok(runtimePack, 'AI prompt should always include runtime knowledge/style material when knowledge is enabled');
    assert.ok(!runtimePack.content.includes('知识库调用铁律'), 'runtime knowledge should not inject rule-label boilerplate');
    assert.ok(runtimePack.content.includes('输出时禁止说'), 'runtime pack should tell model not to leak template/source wording');
    assert.ok(runtimePack.content.includes('不要标题式输出'), 'runtime pack should discourage report-like labels');
    const styleScenePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[本条风格场景-不要外显]'));
    assert.ok(styleScenePack, 'AI prompt should include dynamic style scene guidance');
    assert.ok(styleScenePack.content.includes('风格纠偏'), 'style scene guidance should classify style feedback prompts');
    assert.ok(styleScenePack.content.includes('不要外显'), 'style scene guidance should forbid leaking scene labels');
    const userProfilePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[用户画像-自填偏好]'));
    assert.ok(userProfilePack, 'AI prompt should include user profile material when configured by user');
    assert.ok(userProfilePack.content.includes('队伍偏好: Vitality / NAVI'), 'user profile pack should include favorite teams');
    assert.ok(userProfilePack.content.includes('地图偏好: Inferno'), 'user profile pack should include favorite maps');
    assert.ok(userProfilePack.content.includes('不能用画像下事实结论'), 'user profile pack should expose factual boundary');
    return '结论：根据临场笔记，作为AI助手我将用玩机器风格回复：不是哥们 这个回答太规整了';
  });

  try {
    handler.handleEvent(makePlainEvent(901, 94, '/profile set team Vitality/NAVI'));
    await waitFor(() => sent.length === 1, 'profile set teams command');
    assert.ok(firstText(sent[0].message).includes('队伍偏好已更新'), '/profile should set favorite teams');
    assert.ok(userProfile.__test.buildUserProfileRuntimeHint('group', 6657, 94).includes('Vitality / NAVI'), 'profile runtime hint should include saved teams');
    const profileStatsAfterHint = userProfile.__test.getUserProfileStats();
    assert.ok(profileStatsAfterHint.cached, 'profile store should stay cached after writes and reads');
    assert.ok(profileStatsAfterHint.cacheHits >= 1, 'profile store should reuse cached JSON for repeated reads');
    assert.ok(profileStatsAfterHint.diskWrites >= 1, 'profile store should count profile writes');

    handler.handleEvent(makePlainEvent(902, 94, '/profile set map Inferno'));
    await waitFor(() => sent.length === 2, 'profile set map command');
    assert.ok(firstText(sent[1].message).includes('地图偏好已更新'), '/profile should set favorite map');

    handler.handleEvent(makePlainEvent(903, 94, '/profile set tone 别太凶，短句一点'));
    await waitFor(() => sent.length === 3, 'profile set tone command');
    assert.ok(firstText(sent[2].message).includes('语气偏好已更新'), '/profile should set tone preference');

    handler.handleEvent(makeEvent(904, 94, ' 你这回复怎么又像模板了'));
    await waitFor(() => sent.length === 4, 'knowledge injected reply');
    const text = firstText(sent[3].message);
    assert.ok(text.includes('这个回答太规整了'), 'reply should keep the useful humanized content');
    assert.ok(!/^不是哥们/.test(text), 'postprocess should soften formulaic opener');
    assert.ok(!/结论：|根据知识库|根据临场笔记|作为AI|我将用|玩机器风格回复/.test(text), 'postprocess should strip assistant/template boilerplate');

    handler.handleEvent(makePlainEvent(908, 98, '/trace last'));
    await waitFor(() => sent.length === 5, 'trace last after AI reply');
    const traceText = firstText(sent[4].message);
    assert.ok(traceText.includes('最近回复 trace'), 'trace last should render trace header');
    assert.ok(traceText.includes('mid=904'), 'trace last should keep original message id');
    assert.ok(traceText.includes('@bot'), 'trace last should show trigger reason');
    assert.ok(/知识\d+字/.test(traceText), 'trace last should show injected knowledge chars');
    assert.ok(traceText.includes('知识分区:'), 'trace last should show injected knowledge section titles');
    assert.ok(traceText.includes('画像: 已注入'), 'trace last should show user profile injection');
    assert.ok(traceText.includes('开头:'), 'trace last should show opener dedupe info');
    assert.ok(traceText.includes('证据:'), 'trace last should expose evidence summary line');
    assert.ok(traceText.includes('实时意图无'), 'trace last should expose realtime intent state');
    assert.ok(traceText.includes('风格场景: 风格纠偏'), 'trace last should expose matched style scene');
    assert.ok(traceText.includes('缓存判定:'), 'trace last should expose cache decision diagnostics');

    handler.handleEvent(makePlainEvent(911, 98, '/trace recent 3'));
    await waitFor(() => sent.length === 6, 'trace recent after AI reply');
    const traceRecentText = firstText(sent[5].message);
    assert.ok(traceRecentText.includes('回复最近 trace'), 'trace recent should render recent reply traces');
    assert.ok(traceRecentText.includes('mid=904'), 'trace recent should keep original message id');
    assert.ok(traceRecentText.includes('sent=text'), 'trace recent should show send state');
    assert.ok(traceRecentText.includes('知识='), 'trace recent should summarize knowledge injection');
    assert.ok(traceRecentText.includes('识图='), 'trace recent should summarize vision state');

    handler.handleEvent(makePlainEvent(909, 98, '/kb route 你这回复怎么又像模板了，礼物感谢怎么说'));
    await waitFor(() => sent.length === 7, 'kb route preflight command');
    const routeText = firstText(sent[6].message);
    assert.ok(routeText.includes('知识路由预检'), '/kb route should render knowledge routing preflight');
    assert.ok(routeText.includes('预算:'), '/kb route should expose total/style/topic budgets');
    assert.ok(routeText.includes('风格包:'), '/kb route should expose style knowledge size');
    assert.ok(routeText.includes('话题包:'), '/kb route should expose topic knowledge size');
    assert.ok(routeText.includes('多路召回:'), '/kb route should expose routed topic lanes');
    assert.ok(/礼物|场景/.test(routeText), '/kb route should expose gift/scene lane routing for mixed prompts');
    assert.ok(routeText.includes('分区:'), '/kb route should expose selected knowledge section titles');
    assert.ok(routeText.includes('时效风险:'), '/kb route should expose stale/current-fact risk state');
    assert.ok(routeText.includes('命中诊断:'), '/kb route should expose knowledge hit diagnostics');
    assert.ok(routeText.includes('行动建议:'), '/kb route should expose next knowledge curation action');
    assert.ok(routeText.includes('不调用模型'), '/kb route should clarify it is a no-LLM preflight');

    handler.handleEvent(makePlainEvent(910, 98, '/quote check 公式'));
    await waitFor(() => sent.length === 8, 'quote knowledge preflight command');
    const quoteCheckText = firstText(sent[7].message);
    assert.ok(quoteCheckText.includes('语录/口癖预检'), '/quote check should render quote preflight panel');
    assert.ok(quoteCheckText.includes('短句池:'), '/quote check should expose quote pool hit counts');
    assert.ok(!quoteCheckText.includes('命中0/0'), '/quote check should load the actual live catchphrase pool');
    assert.ok(quoteCheckText.includes('样例:'), '/quote check should expose sample quote anchors');
    assert.ok(quoteCheckText.includes('逐字原话'), '/quote check should expose non-verbatim boundary');
    assert.ok(quoteCheckText.includes('不调用模型'), '/quote check should be no-LLM preflight');

    handler.handleEvent(makePlainEvent(912, 98, '/quote 白给'));
    await waitFor(() => sent.length === 9, 'quote catchphrase command');
    const quoteText = firstText(sent[8].message);
    assert.ok(quoteText && quoteText.length > 0, '/quote should return a catchphrase anchor');
    assert.ok(!quoteText.includes('这关键词没逮到'), '/quote should find existing catchphrase anchors');
    assert.ok(!quoteText.includes('本人逐字原话'), 'normal /quote should stay lightweight without boundary spam');

    handler.handleEvent(makePlainEvent(913, 98, '/quote 玩机器原话逐字来一句'));
    await waitFor(() => sent.length === 10, 'quote original boundary command');
    const quoteBoundaryText = firstText(sent[9].message);
    assert.ok(quoteBoundaryText.includes('口癖锚点:'), 'original quote requests should still provide a style anchor');
    assert.ok(quoteBoundaryText.includes('不是玩机器本人逐字原话'), 'original quote requests should expose non-verbatim boundary');
    assert.ok(quoteBoundaryText.includes('/kb inbox'), 'original quote boundary should point material curation to inbox inspection');
  } finally {
    aiChat.__setLLMCallerForTests();
    userProfile.__test.setStorePathForTests();
    aiChat.shutdownAiChat();
    if (fs.existsSync(profileStorePath)) fs.unlinkSync(profileStorePath);
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testOpenerFamilyDedupe() {
  aiChat.shutdownAiChat();
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  config.ai.ai_reply_cache_seconds = 0;
  const sent = [];
  const replies = [
    '先别急 这把要等烟散了再补枪',
    '等一下 这波先看道具落点',
  ];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(108_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  let calls = 0;
  aiChat.__setLLMCallerForTests(async () => replies[calls++] || '这把换个说法继续看');

  try {
    const groupId = 7301;
    handler.handleEvent(makeEvent(907, 101, ' 看看这把怎么处理', [], groupId));
    await waitFor(() => sent.length === 1, 'first opener family reply');
    const first = firstText(sent[0].message);
    assert.ok(first.startsWith('先别急'), 'first opener should be allowed when not recently used');

    handler.handleEvent(makeEvent(908, 102, ' 再说一句', [], groupId));
    await waitFor(() => sent.length === 2, 'second opener family reply');
    const second = firstText(sent[1].message);
    assert.ok(!second.startsWith('等一下'), 'same-family opener should be stripped on the next reply');
    assert.ok(second.includes('这波先看道具落点'), 'opener family dedupe should keep useful content');

    handler.handleEvent(makePlainEvent(909, 102, '/trace last', [], groupId));
    await waitFor(() => sent.length === 3, 'trace after opener family dedupe');
    const traceText = firstText(sent[2].message);
    assert.ok(traceText.includes('开头: 等一下 -> 这波先看道具落点 已去重'), 'trace should expose family opener dedupe');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testRealityBoundaryPostprocess() {
  const direct = replyPostprocess.postProcessReply('我是玩机器本人，官方授权，NAVI现在第一');
  assert.ok(/群 bot|风格bot|不代表现实本人/.test(direct), 'postprocess should enforce bot/person boundary');
  assert.ok(!/我是玩机器本人|官方授权/.test(direct), 'postprocess should remove impersonation/authorization claims');
  assert.ok(replyPostprocess.hasRealityBoundaryClaim('这是玩机器官方账号，本人授权过我。'), 'identity guard should detect official/authorization impersonation');
  const official = replyPostprocess.postProcessReply('这是玩机器官方账号，本人授权过我。');
  assert.ok(/群 bot|风格bot|不代表现实本人|授权这事别乱说/.test(official), 'postprocess should guard official-account impersonation');
  assert.ok(!/官方账号|本人授权/i.test(official), 'postprocess should strip official-account impersonation wording');
  assert.ok(
    replyPostprocess.hasUnsupportedOriginalQuoteClaim('这是玩机器原话：老板大气，这波经济直接拉满。'),
    'quote guard should detect unsupported original-quote claims',
  );
  assert.ok(
    !replyPostprocess.hasUnsupportedOriginalQuoteClaim('这是拟态模板，不是玩机器原话。'),
    'quote guard should allow explicit non-verbatim boundaries',
  );
  assert.ok(
    replyPostprocess.hasUnsupportedOriginalQuoteClaim('来段玩机器名场面台词，一字不差那种。'),
    'quote guard should detect unsupported famous-scene/verbatim wording',
  );
  assert.ok(
    !replyPostprocess.hasUnsupportedOriginalQuoteClaim('这是场景卡，不是玩机器直播台词原文。'),
    'quote guard should allow explicit non-verbatim live-caption boundaries',
  );
  const quoteGuarded = replyPostprocess.postProcessReply('这是玩机器原话：老板大气，这波经济直接拉满。');
  assert.ok(quoteGuarded.includes('不能当本人原话'), 'postprocess should add a non-verbatim quote boundary');
  assert.ok(!/这是玩机器原话|逐字原话/.test(quoteGuarded), 'postprocess should strip unsupported original-quote wording');
  const sceneQuoteGuarded = replyPostprocess.postProcessReply('来段玩机器名场面台词，一字不差那种：你这把先别急。');
  assert.ok(sceneQuoteGuarded.includes('不能当本人原话'), 'postprocess should guard famous-scene/verbatim quote wording');
  assert.ok(!/名场面台词|一字不差/.test(sceneQuoteGuarded), 'postprocess should strip famous-scene/verbatim quote wording');
  const softened = replyPostprocess.softenUnverifiedClaims('Vitality 现在第一，昨天 13-7 赢了 NAVI。', false);
  assert.ok(softened.includes('以最新为准'), 'unverified realtime sports claims should be softened');
  const fakeSourceSoftened = replyPostprocess.softenUnverifiedClaims('我刚查了HLTV，现在NAVI排名第一。', false);
  assert.ok(fakeSourceSoftened.includes('没实时来源'), 'fake source claims should be converted to a clear no-source boundary');
  assert.ok(!/刚查|HLTV显示|实时数据说|资料显示/i.test(fakeSourceSoftened), 'fake source claims should not survive softening');
  const rumorSoftened = replyPostprocess.softenUnverifiedClaims('群里都说donk最近要离队，Spirit要换人。', false);
  assert.ok(rumorSoftened.includes('没可靠来源'), 'unsupported rumor claims should expose a reliable-source boundary');
  assert.ok(!/群里都说|朋友说|听说|爆料/i.test(rumorSoftened), 'unsupported rumor social-source wording should not survive softening');
  assert.strictEqual(
    replyPostprocess.softenUnverifiedClaims('听说你今天很猛。', false),
    '听说你今天很猛。',
    'harmless casual rumor wording should not be over-guarded',
  );
  assert.ok(
    replyPostprocess.softenUnverifiedClaims('Vitality 当前排名第一。', false).includes('以最新为准'),
    'current CS ranking claims should be softened without realtime evidence',
  );
  assert.ok(
    !replyPostprocess.postProcessReply('根据实时事实参考，Vitality 今天状态可以。').includes('实时事实参考'),
    'postprocess should strip realtime reference boilerplate leaks',
  );
  assert.strictEqual(
    replyPostprocess.softenUnverifiedClaims('来源显示 Vitality #1。', true),
    '来源显示 Vitality #1。',
    'realtime-backed claims should not be softened',
  );

  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(95_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async () => '我是玩机器本人，官方授权，你放心。');
  try {
    handler.handleEvent(makeEvent(911, 91, ' 你是玩机器本人吗'));
    await waitFor(() => sent.length === 1, 'reality boundary reply');
    const text = firstText(sent[0].message);
    assert.ok(/群 bot|风格bot|不代表现实本人|授权这事别乱说/.test(text), 'AI reply path should enforce reality boundary');
    assert.ok(!/我是玩机器本人|官方授权/.test(text), 'AI reply path should not send impersonation claims');

    handler.handleEvent(makePlainEvent(913, 91, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after identity boundary');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('事实边界:'), 'trace should expose identity boundary guard');
    assert.ok(traceText.includes('identity boundary enforced'), 'trace should explain identity boundary repair');

    aiChat.__setLLMCallerForTests(async () => '这是玩机器原话：老板大气，这波经济直接拉满。');
    handler.handleEvent(makeEvent(914, 91, ' 来句玩机器语录'));
    await waitFor(() => sent.length === 3, 'original quote boundary reply');
    const quoteText = firstText(sent[2].message);
    assert.ok(quoteText.includes('不能当本人原话'), 'AI reply path should enforce original quote boundary');
    assert.ok(!/这是玩机器原话|逐字原话/.test(quoteText), 'AI reply path should not send unsupported original-quote claims');

    handler.handleEvent(makePlainEvent(915, 91, '/trace last'));
    await waitFor(() => sent.length === 4, 'trace after quote boundary');
    const quoteTraceText = firstText(sent[3].message);
    assert.ok(quoteTraceText.includes('original quote boundary enforced'), 'trace should explain original quote boundary repair');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testTraceEvidenceAndFactGuard() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(96_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async () => 'Vitality 当前排名第一。');
  try {
    handler.handleEvent(makeEvent(912, 92, ' 随便接一句'));
    await waitFor(() => sent.length === 1, 'fact guard reply');
    const text = firstText(sent[0].message);
    assert.ok(text.includes('以最新为准'), 'AI reply path should soften unsupported realtime claim');

    handler.handleEvent(makePlainEvent(916, 96, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after fact guard');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('证据:'), 'trace should expose evidence summary line');
    assert.ok(traceText.includes('实时意图无'), 'trace should show no realtime intent for non-CS prompt');
    assert.ok(traceText.includes('事实边界:'), 'trace should expose factual guard action');
    assert.ok(traceText.includes('unverified realtime claim softened'), 'trace should explain unsupported realtime claim repair');
    const stats = aiChat.getAiChatStats();
    assert.ok(stats.evidenceTraceCount >= 1, 'stats should count evidence trace records');
    assert.ok(stats.factGuardRepairCount >= 1, 'stats should count fact guard repairs');
    assert.ok(stats.lastFactGuard.includes('unverified realtime claim softened'), 'stats should keep last fact guard reason');

    aiChat.__setLLMCallerForTests(async () => '我刚查了HLTV，现在NAVI排名第一。');
    handler.handleEvent(makeEvent(917, 97, ' 随便接一句假的来源'));
    await waitFor(() => sent.length === 3, 'fake realtime source guarded reply');
    const guarded = firstText(sent[2].message);
    assert.ok(guarded.includes('没实时来源'), 'AI reply path should expose a no-source boundary for fake lookup claims');
    assert.ok(!/刚查|HLTV显示|实时数据说|资料显示/i.test(guarded), 'AI reply path should strip fake realtime source claims');

    handler.handleEvent(makePlainEvent(918, 98, '/trace last'));
    await waitFor(() => sent.length === 4, 'trace after fake source fact guard');
    const sourceTraceText = firstText(sent[3].message);
    assert.ok(sourceTraceText.includes('事实边界:'), 'trace should expose fake source factual guard action');
    assert.ok(sourceTraceText.includes('unverified realtime claim softened'), 'trace should explain fake source repair');

    aiChat.__setLLMCallerForTests(async () => '朋友说donk最近要离队，Spirit要换人。');
    handler.handleEvent(makeEvent(919, 99, ' 随便接一句传闻'));
    await waitFor(() => sent.length === 5, 'unsupported rumor guarded reply');
    const rumorGuarded = firstText(sent[4].message);
    assert.ok(rumorGuarded.includes('没可靠来源'), 'AI reply path should expose a reliable-source boundary for rumor claims');
    assert.ok(!/朋友说|群里都说|听说|爆料/i.test(rumorGuarded), 'AI reply path should strip unsupported rumor source wording');

    handler.handleEvent(makePlainEvent(920, 100, '/trace last'));
    await waitFor(() => sent.length === 6, 'trace after unsupported rumor fact guard');
    const rumorTraceText = firstText(sent[5].message);
    assert.ok(rumorTraceText.includes('事实边界:'), 'trace should expose rumor factual guard action');
    assert.ok(rumorTraceText.includes('unsupported rumor claim softened'), 'trace should explain rumor source repair');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testRealtimeSourceBoundaryPrompt() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = false;
  config.ai.search_on_style_query = false;
  config.ai.knowledge_force_style = true;
  const sent = [];
  const capturedMessages = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(99_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    capturedMessages.push(messages);
    const runtimePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[临场笔记-本地语态与背景]'));
    assert.ok(runtimePack, 'runtime knowledge pack should be explicitly labelled as local style/background');
    assert.ok(runtimePack.content.includes('实时事实参考 > 本地话题素材'), 'runtime pack should declare truth-source priority');
    assert.ok(runtimePack.content.includes('不要用本地素材报'), 'runtime pack should forbid local material for current facts');
    assert.ok(!messages.some((item) => typeof item.content === 'string' && item.content.includes('[实时事实参考]')), 'no realtime pack should be injected when realtime lookup did not run');
    return '这个口癖现在最适合短一点。';
  });

  try {
    handler.handleEvent(makeEvent(913, 93, ' 你最新口癖怎么还是这么模板'));
    await waitFor(() => sent.length === 1, 'realtime source boundary reply');
    const text = firstText(sent[0].message);
    assert.ok(text.includes('这个口癖'), 'non-CS style replies should still pass through normally');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testAiMatchIdRealtimeInjection() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = false;
  const sent = [];
  const capturedMessages = [];
  hltv.__test.setCacheEntryForTests(
    'match:2390002',
    [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      'Match ID: 2390002',
      '详情链接: https://api.csapi.de/matches/2390002',
      '统计链接: https://api.csapi.de/matches/2390002/stats',
      'Spirit 2:0 9z BO3 (IEM Smoke) 胜者:Spirit',
      '地图池线索: Mirage / Nuke',
      '竞猜地图: 多图 Mirage / Nuke 只作为 mappool 线索；单张图统计按实际单图下注或结算证据走。',
      '选手亮点: donk(Spirit) Rating 2.55 K/D 48/16 ADR155.1 KAST93.3%',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 5_000, source: 'test-ai-match-detail', fetchMs: 18 },
  );
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(101_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    capturedMessages.push(messages);
    const realtimeMessage = messages.find((item) => typeof item.content === 'string' && item.content.includes('[实时事实参考]'));
    assert.ok(realtimeMessage, 'match id AI question should inject realtime reference pack');
    assert.ok(realtimeMessage.content.includes('单场2390002'), 'realtime pack should label match id detail data');
    assert.ok(realtimeMessage.content.includes('Match ID: 2390002'), 'realtime pack should include match detail');
    assert.ok(realtimeMessage.content.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390002/match'), 'realtime pack should enrich old cached match detail with HLTV match page candidate');
    assert.ok(realtimeMessage.content.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390002'), 'realtime pack should expose HLTV search fallback for match id');
    assert.ok(realtimeMessage.content.includes('HLTV比赛页候选只供人工交叉核验'), 'realtime pack should keep HLTV match page boundary for cached detail');
    assert.ok(realtimeMessage.content.includes('真实 HLTV 页面可能需要 slug'), 'realtime pack should clarify HLTV match page slug boundary');
    assert.ok(realtimeMessage.content.includes('地图池线索: Mirage / Nuke'), 'realtime pack should include match map pool hint');
    assert.ok(realtimeMessage.content.includes('donk(Spirit) Rating 2.55'), 'realtime pack should include player highlights');
    assert.ok(realtimeMessage.content.includes('缓存: match:2390002 fresh'), 'realtime pack should include cache freshness evidence');
    assert.ok(realtimeMessage.content.includes('证据新鲜度:'), 'realtime pack should include structured freshness summary');
    assert.ok(realtimeMessage.content.includes('match:2390002 fresh'), 'realtime freshness summary should include fresh match cache');
    assert.ok(!realtimeMessage.content.includes('只有 stale/旧缓存'), 'fresh realtime pack should not use stale-only boundary');
    return 'donk这场就是最亮的点 Rating 2.55 这个发挥太夸张了';
  });

  try {
    handler.handleEvent(makePlainEvent(918, 96, '/ai matchid=2390002 这场谁C了'));
    await waitFor(() => sent.length === 1, 'AI match id realtime reply');
    const text = firstText(sent[0].message);
    assert.ok(text.includes('donk'), 'AI match id reply should use injected match detail');
    assert.ok(text.includes('2.55'), 'AI match id reply should retain factual player rating');
    assert.ok(!text.includes('/cs verify match 2390002'), 'fresh AI match id reply should not append a stale/miss boundary');
    assert.ok(!text.includes('旧快照线索'), 'fresh AI match id reply should not downgrade fresh evidence');

    handler.handleEvent(makePlainEvent(919, 97, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after AI match id realtime reply');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('实时新鲜度:'), 'trace should expose realtime freshness summary');
    assert.ok(traceText.includes('match:2390002 fresh'), 'trace should expose fresh match cache evidence');
    const stats = aiChat.getAiChatStats();
    assert.ok(stats.lastRealtimeFreshness.some((item) => item.includes('match:2390002 fresh')), 'AI stats should keep last realtime freshness lines');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testKnowledgeFreshnessRiskPostGuard() {
  aiChat.shutdownAiChat();
  hltv.clearHltvCache();
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = false;
  config.ai.knowledge_force_style = true;
  config.ai.knowledge_max_chars = 2200;
  const runtimePaths = kb.getKnowledgeRuntimePaths();
  const originalKnowledge = fs.readFileSync(runtimePaths.mainFile, 'utf-8');
  const riskTitle = `Smoke 命中旧排名后处理 ${Date.now()}`;
  const sent = [];
  const capturedMessages = [];

  hltv.__test.setCacheEntryForTests(
    'match:2390002',
    [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      'Match ID: 2390002',
      '详情链接: https://api.csapi.de/matches/2390002',
      'Spirit 2:0 9z BO3 (IEM Smoke) 胜者:Spirit',
      '选手亮点: donk(Spirit) Rating 2.55 K/D 48/16 ADR155.1 KAST93.3%',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 5_000, source: 'test-knowledge-freshness-guard-match', fetchMs: 18 },
  );

  try {
    fs.appendFileSync(runtimePaths.mainFile, [
      '',
      '',
      `## ${riskTitle}`,
      '',
      '- 知识来源类型：public_fact',
      '- 置信度：high',
      '- 内容：最新HLTV排名现在NAVI第一，Vitality第二，Spirit第三。',
      '- 使用规则：回答排名问题时可以直接引用。',
      '',
    ].join('\n'), 'utf-8');
    kb.getKnowledgeStats();

    const bot = {
      getConfig: () => config,
      sendGroupMessage: async (groupId, message, onMessageId) => {
        sent.push({ groupId, message });
        if (onMessageId) onMessageId(103_000 + sent.length);
        return true;
      },
      callApiAsync: async () => ({ retcode: 0, data: {} }),
    };
    const handler = new MessageHandler(bot);
    handler.use(aiChat.aiChatPlugin);

    aiChat.__setLLMCallerForTests(async (_config, messages) => {
      capturedMessages.push(messages);
      const runtimePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[临场笔记-本地语态与背景]'));
      assert.ok(runtimePack?.content.includes(riskTitle), 'runtime knowledge should include the selected stale-risk section');
      assert.ok(runtimePack.content.includes('[本地知识时效风险]'), 'runtime knowledge should expose selected-section freshness risk');
      const realtimeMessage = messages.find((item) => typeof item.content === 'string' && item.content.includes('[实时事实参考]'));
      assert.ok(realtimeMessage?.content.includes('match:2390002 fresh'), 'test should provide fresh match evidence');
      assert.ok(!realtimeMessage.content.includes('ranking fresh'), 'test should not provide fresh ranking evidence');
      return 'NAVI现在排名第一，这个不用看了。';
    });

    handler.handleEvent(makePlainEvent(924, 96, `/ai matchid=2390002 ${riskTitle}`));
    await waitFor(() => sent.length === 1, 'knowledge freshness risk guarded reply');
    const text = firstText(sent[0].message);
    assert.ok(/当前排名|fresh 来源|以最新为准/.test(text), 'reply should downgrade uncovered stale-risk ranking claims');
    assert.ok(!/NAVI现在排名第一|不用看了/.test(text), 'reply should not keep stale knowledge ranking as current fact');

    handler.handleEvent(makePlainEvent(925, 97, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after knowledge freshness guard');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('知识时效风险:'), 'trace should expose selected knowledge freshness risk');
    assert.ok(traceText.includes('knowledge freshness risk softened'), 'trace should explain freshness-risk fact guard repair');
    assert.strictEqual(capturedMessages.length, 1);
  } finally {
    aiChat.__setLLMCallerForTests();
    fs.writeFileSync(runtimePaths.mainFile, originalKnowledge, 'utf-8');
    kb.getKnowledgeStats();
    hltv.clearHltvCache();
    aiChat.shutdownAiChat();
  }
}

async function testAiStaleRealtimeEvidenceBoundary() {
  aiChat.shutdownAiChat();
  hltv.clearHltvCache();
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = false;
  const sent = [];
  const capturedMessages = [];
  hltv.__test.setCacheEntryForTests(
    'match:2390003',
    [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 12:00:00 / 链接 CS API: https://api.csapi.de/',
      'Match ID: 2390003',
      '详情链接: https://api.csapi.de/matches/2390003',
      'Spirit 2:1 G2 BO3 (IEM Smoke) 胜者:Spirit',
      '选手亮点: donk(Spirit) Rating 2.01 K/D 52/31 ADR101.2 KAST82.0%',
    ].join('\n'),
    { ttlMs: -1_000, ageMs: 20_000, source: 'test-ai-stale-match-detail', fetchMs: 19 },
  );
  hltv.__test.setCsApiJsonFetcherForTests(async () => null);
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(102_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  handler.use(statusPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    capturedMessages.push(messages);
    const realtimeMessage = messages.find((item) => typeof item.content === 'string' && item.content.includes('[实时事实参考]'));
    assert.ok(realtimeMessage, 'stale match id AI question should still inject realtime reference pack');
    assert.ok(realtimeMessage.content.includes('单场2390003'), 'stale realtime pack should label match id detail data');
    assert.ok(realtimeMessage.content.includes('Match ID: 2390003'), 'stale realtime pack should include cached match detail');
    assert.ok(realtimeMessage.content.includes('缓存: match:2390003 stale'), 'stale realtime pack should include stale cache evidence');
    assert.ok(realtimeMessage.content.includes('不能当实时结论'), 'stale realtime pack should warn against realtime conclusions');
    assert.ok(realtimeMessage.content.includes('资料里含 stale/旧缓存'), 'stale realtime pack should add explicit stale usage rule');
    assert.ok(realtimeMessage.content.includes('证据新鲜度:'), 'stale realtime pack should include structured freshness summary');
    assert.ok(realtimeMessage.content.includes('关键边界：本条实时资料只有 stale/旧缓存，没有 fresh'), 'stale realtime pack should make stale-only boundary model-visible');
    return '我刚查了最新数据，donk这场就是实时最C Rating 2.01。';
  });

  try {
    handler.handleEvent(makePlainEvent(921, 96, '/ai matchid=2390003 这场现在谁C了'));
    await waitFor(() => sent.length === 1, 'AI stale match id guarded reply');
    const text = firstText(sent[0].message);
    assert.ok(/没实时来源|以最新为准|得查最新/.test(text), 'stale-only AI reply should expose realtime boundary');
    assert.ok(text.includes('事实边界：单场 2390003 目前只有旧快照线索'), 'stale-only AI reply should append a deterministic stale snapshot boundary');
    assert.ok(text.includes('/cs verify match 2390003'), 'stale-only AI reply should point to the exact verify command');
    assert.ok(text.includes('/cs warm plan match 2390003'), 'stale-only AI reply should point to the exact warm-plan command');
    assert.ok(!/刚查|实时最C|2\.01/.test(text), 'stale-only AI reply should not keep latest certainty from the model');

    handler.handleEvent(makePlainEvent(922, 97, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after stale AI match id realtime reply');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('证据账本:'), 'trace should expose unified evidence ledger');
    assert.ok(traceText.includes('当前事实=仅stale线索'), 'evidence ledger should classify stale-only realtime facts');
    assert.ok(traceText.includes('实时新鲜度:'), 'trace should expose stale realtime freshness summary');
    assert.ok(traceText.includes('实时意图有 实时数据无'), 'trace should not treat stale-only cache as current realtime data');
    assert.ok(traceText.includes('match:2390003 stale'), 'trace should expose stale match cache evidence');
    assert.ok(traceText.includes('含stale'), 'trace should mark stale realtime evidence');
    assert.ok(traceText.includes('事实边界:'), 'trace should expose stale-only fact guard');
    assert.ok(traceText.includes('unverified realtime claim softened'), 'trace should explain stale-only realtime claim repair');
    assert.ok(traceText.includes('AI realtime boundary appendix added'), 'trace should expose deterministic realtime boundary appendix');

    const stats = aiChat.getAiChatStats();
    assert.ok(stats.realtimeStaleEvidenceCount >= 1, 'AI stats should count stale realtime evidence traces');
    assert.ok(stats.lastRealtimeFreshness.some((item) => item.includes('match:2390003 stale')), 'AI stats should keep last stale realtime freshness lines');

    handler.handleEvent(makePlainEvent(923, 97, '/status'));
    await waitFor(() => sent.length === 3, 'status after stale AI match id realtime reply');
    const statusText = firstText(sent[2].message);
    assert.ok(statusText.includes('最近证据账本'), 'status should expose latest evidence ledger');
    assert.ok(statusText.includes('最近实时证据'), 'status should expose last realtime freshness evidence');
    assert.ok(statusText.includes('match:2390003 stale'), 'status should expose stale realtime freshness evidence');
  } finally {
    aiChat.__setLLMCallerForTests();
    hltv.__test.setCsApiJsonFetcherForTests();
    hltv.clearHltvCache();
    aiChat.shutdownAiChat();
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testRagRealtimeMemoryTruthFilter() {
  aiChat.shutdownAiChat();
  hltv.clearHltvCache();
  const config = makeConfigForHandler();
  config.ai.enable_search = false;
  config.ai.enable_knowledge = false;
  config.ai.memory_top_k = 4;
  config.ai.memory_min_similarity = 0.12;
  config.ai.memory_inject_max_chars = 900;
  const sent = [];
  const capturedMessages = [];
  const groupId = 790_000 + Math.floor(Date.now() % 10_000);
  const sessionId = `group_${groupId}`;
  const contextPath = path.resolve(__dirname, '..', 'context_store', `${sessionId}.json`);
  const indexPath = path.resolve(__dirname, '..', 'context_store', 'embeddings', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(indexPath, [
    JSON.stringify({
      id: 'rag-truth-stale',
      ts: now - 9 * 24 * 60 * 60 * 1000,
      role: 'user',
      text: 'smoke realtime rag truth anchor Vitality现在排名第一 当前阵容 apEX ZywOo flameZ mezii ropz',
    }),
    JSON.stringify({
      id: 'rag-truth-stable',
      ts: now - 60 * 1000,
      role: 'assistant',
      text: 'smoke realtime rag truth anchor CS2 Mirage utility detail flash control stable memory',
    }),
  ].join('\n') + '\n', 'utf-8');
  hltv.__test.setCacheEntryForTests(
    'ranking',
    [
      '来源：CS API / VRS排名镜像 / 拉取 2026/6/9 12:00:00 / 链接 CS API: https://api.csapi.de/',
      '1. Spirit 1950分',
      '2. Vitality 1880分',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 1_000, source: 'test-rag-realtime-ranking', fetchMs: 3 },
  );
  hltv.__test.setCsApiJsonFetcherForTests(async () => null);
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupIdForSend, message, onMessageId) => {
      sent.push({ groupId: groupIdForSend, message });
      if (onMessageId) onMessageId(103_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(adminPlugin);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    capturedMessages.push(messages);
    const ragMessage = messages.find((item) => typeof item.content === 'string' && item.content.includes('[相关历史片段'));
    assert.ok(ragMessage, 'realtime RAG filter should still inject a model-visible boundary note');
    assert.ok(ragMessage.content.includes('RAG过滤'), 'RAG prompt should tell the model stale realtime memories were filtered');
    assert.ok(!ragMessage.content.includes('Vitality现在排名第一'), 'stale CS realtime memory must not be injected into LLM messages');
    assert.ok(ragMessage.content.includes('Mirage utility detail'), 'stable tactical memory should remain injectable after stale fact filtering');
    return '我刚查了HLTV，全部都是最新数据，Vitality现在排名第一，当前阵容也是apEX ZywOo flameZ mezii ropz，donk最近Rating也是第一。';
  });

  try {
    handler.handleEvent(makePlainEvent(931, 1, '/mem check smoke realtime rag truth anchor CS排名怎么看top10', [], groupId));
    await waitFor(() => sent.length === 1, 'mem check realtime RAG truth filter');
    const preflightText = firstText(sent[0].message);
    assert.ok(preflightText.includes('RAG记忆预检'), 'RAG truth filter preflight should render');
    assert.ok(preflightText.includes('时效过滤1条'), '/mem check should expose stale realtime memory filtering');
    assert.ok(preflightText.includes('过滤样本:'), '/mem check should show filtered realtime memory samples');
    assert.ok(preflightText.includes('Vitality现在排名第一'), '/mem check diagnostics may show the filtered stale sample');
    assert.ok(preflightText.includes('Mirage utility detail'), '/mem check should keep stable tactical memories');

    handler.handleEvent(makePlainEvent(932, 96, '/ai smoke realtime rag truth anchor CS排名怎么看top10', [], groupId));
    await waitFor(() => sent.length === 2, 'AI realtime RAG truth filter reply');
    const filteredReply = firstText(sent[1].message);
    assert.ok(!filteredReply.includes('Vitality现在排名第一'), 'AI reply should not leak filtered stale memory');
    assert.ok(!/刚查|HLTV|全部都是最新|apEX|ZywOo|flameZ|mezii|ropz|Rating也是第一/.test(filteredReply), 'typed evidence guard should remove uncovered ranking/roster/player overclaims');
    assert.ok(filteredReply.includes('证据账本') && filteredReply.includes('当前阵容/转会') && filteredReply.includes('当前选手数据/状态'), 'typed evidence guard should expose uncovered fact kinds');

    handler.handleEvent(makePlainEvent(933, 97, '/trace last', [], groupId));
    await waitFor(() => sent.length === 3, 'trace after realtime RAG truth filter');
    const traceText = firstText(sent[2].message);
    assert.ok(traceText.includes('证据账本:'), 'trace should expose unified evidence ledger for RAG filtering');
    assert.ok(traceText.includes('当前事实=fresh优先'), 'evidence ledger should classify fresh realtime support');
    assert.ok(traceText.includes('RAG=注入1/过滤1'), 'evidence ledger should summarize injected and filtered RAG memories');
    assert.ok(traceText.includes('记忆过滤: 1条'), 'trace should expose stale realtime memory filter count');
    assert.ok(traceText.includes('旧CS实时事实'), 'trace should expose stale realtime memory filter reason');
    assert.ok(traceText.includes('evidence ledger uncovered fact kind softened: roster/player'), 'trace should expose typed ledger-driven fact guard repair');
  } finally {
    aiChat.__setLLMCallerForTests();
    hltv.__test.setCsApiJsonFetcherForTests();
    hltv.clearHltvCache();
    aiChat.clearAiSessionMemory?.(sessionId);
    aiChat.shutdownAiChat();
    if (fs.existsSync(contextPath)) fs.unlinkSync(contextPath);
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testReplyQualityRepair() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = true;
  config.ai.knowledge_force_style = true;
  const sent = [];
  const prompts = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(100_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let calls = 0;
  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    calls++;
    prompts.push(messages);
    if (calls === 1) {
      return '结论：根据临场笔记，作为AI我将用模板回复：这波有说法。';
    }
    const last = messages[messages.length - 1];
    assert.ok(
      typeof last.content === 'string' && last.content.includes('发出前自检没过'),
      'quality repair retry should explain why the first reply failed',
    );
    return '这句太像模板了 直接删掉重说就行';
  });

  try {
    handler.handleEvent(makeEvent(914, 94, ' 这句又像模板了'));
    await waitFor(() => sent.length === 1, 'quality repaired reply');
    const text = firstText(sent[0].message);
    assert.strictEqual(text, '这句太像模板了 直接删掉重说就行');
    assert.strictEqual(calls, 2, 'low-quality reply should trigger one repair retry');

    handler.handleEvent(makePlainEvent(915, 95, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace after quality repair');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('quality retry'), 'trace should show quality repair');
    assert.ok(traceText.includes('质量风险:'), 'trace should expose quality risk issues');
    assert.ok(/low-information catchphrase|source\/template leak|report-like heading/.test(traceText), 'trace should show the quality issue category');
    const stats = aiChat.getAiChatStats();
    assert.ok(stats.qualityIssueTraceCount >= 1, 'AI stats should count low-quality reply risk traces');
    assert.ok(
      stats.lastQualityIssues.some((issue) => /low-information catchphrase|source\/template leak|report-like heading/.test(issue)),
      'AI stats should keep last quality issue categories',
    );
    assert.ok(stats.styleSceneTop.some((item) => item.includes('风格纠偏')), 'AI stats should count matched style scene categories');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
  assert.strictEqual(prompts.length, 2);
}

async function testStyleQualityPreflightCommand() {
  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(104_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  try {
    handler.handleEvent(makePlainEvent(916, 96, '/style status'));
    await waitFor(() => sent.length === 1, 'style quality status command');
    const statusText = firstText(sent[0].message);
  assert.ok(statusText.includes('风格质量状态'), '/style status should render style quality stats');
  assert.ok(statusText.includes('真人停顿'), '/style status should expose human delay stats');
  assert.ok(statusText.includes('/style check'), '/style status should point to style preflight');

    handler.handleEvent(makePlainEvent(917, 96, '/style check 根据知识库，作为AI我刚查了HLTV，现在NAVI排名第一。'));
    await waitFor(() => sent.length === 2, 'style quality preflight command');
    const checkText = firstText(sent[1].message);
    assert.ok(checkText.includes('风格/真实性预检'), '/style check should render preflight panel');
    assert.ok(checkText.includes('风险等级:'), '/style check should expose a risk level');
    assert.ok(checkText.includes('原文风险:'), '/style check should expose raw quality issues');
    assert.ok(/source\/template leak|false realtime source claim|unverified realtime claim/.test(checkText), '/style check should flag source and realtime risk');
    assert.ok(checkText.includes('修复动作:'), '/style check should expose concrete fix actions');
    assert.ok(checkText.includes('行动建议:'), '/style check should expose remediation advice');
    assert.ok(checkText.includes('/cs verify ranking'), '/style check should suggest ranking verification for current ranking claims');
    assert.ok(checkText.includes('/cs warm plan ranking'), '/style check should suggest targeted ranking prewarm plan when evidence is missing');
    assert.ok(checkText.includes('风格拟态不是本人原话'), '/style check should always expose style/truth boundary');
    assert.ok(checkText.includes('修复预览:'), '/style check should show postprocess/fact-guard preview');
    assert.ok(checkText.includes('无实时证据'), '/style check should default to no realtime evidence');

    handler.handleEvent(makePlainEvent(918, 96, '/style check 我就是玩机器本人 官方授权'));
    await waitFor(() => sent.length === 3, 'style quality identity preflight command');
    const identityText = firstText(sent[2].message);
    assert.ok(identityText.includes('identity impersonation claim'), '/style check should flag identity impersonation risk');
    assert.ok(identityText.includes('身份边界'), '/style check should recommend identity boundary repair');
    assert.ok(identityText.includes('修复预览:'), '/style check should preview identity boundary repair');

    handler.handleEvent(makePlainEvent(920, 96, '/style check 给我一段玩机器名场面台词，一字不差：你这把先别急。'));
    await waitFor(() => sent.length === 4, 'style quality original quote preflight command');
    const quoteText = firstText(sent[3].message);
    assert.ok(quoteText.includes('unsupported original quote claim'), '/style check should flag unsupported original quote claims');
    assert.ok(quoteText.includes('原话边界'), '/style check should recommend non-verbatim quote repair');
    assert.ok(quoteText.includes('不能当本人原话'), '/style check should preview original quote boundary repair');

    handler.handleEvent(makePlainEvent(919, 96, '/style check --realtime --voice 这段话稍微长一点但有实时证据支撑'));
    await waitFor(() => sent.length === 5, 'style quality realtime voice preflight command');
    const realtimeText = firstText(sent[4].message);
    assert.ok(realtimeText.includes('有当前实时证据 / 语音长度'), '/style check should accept realtime and voice flags');
    assert.ok(realtimeText.includes('语音分段:'), '/style check --voice should expose TTS segmentation');
    assert.ok(realtimeText.includes('语音风险:'), '/style check --voice should expose TTS delivery risks');
    assert.ok(realtimeText.includes('语音预览:'), '/style check --voice should preview spoken text');

    handler.handleEvent(makePlainEvent(
      921,
      96,
      '/style check 我刚查了最新数据，donk这场就是实时最C Rating 2.01。 || 缓存: match:2390003 stale age=20s expired=1s 注意: 这是过期缓存，源站本次没给到新数据，不能当实时结论 source=test-ai-stale',
    ));
    await waitFor(() => sent.length === 6, 'style quality stale evidence preflight command');
    const staleEvidenceText = firstText(sent[5].message);
    assert.ok(staleEvidenceText.includes('仅旧缓存线索'), '/style check evidence should treat stale-only evidence as non-current');
    assert.ok(staleEvidenceText.includes('证据新鲜度:'), '/style check evidence should expose freshness lines');
    assert.ok(staleEvidenceText.includes('match:2390003 stale'), '/style check evidence should include stale cache key');
    assert.ok(staleEvidenceText.includes('证据只有 stale/旧缓存'), '/style check evidence should explain stale-only boundary');
    assert.ok(staleEvidenceText.includes('证据动作: 降级为旧快照线索'), '/style check stale evidence should expose downgrade action');
    assert.ok(staleEvidenceText.includes('/cs verify match 2390003'), '/style check stale match evidence should suggest match verification');
    assert.ok(staleEvidenceText.includes('/cs warm plan match 2390003'), '/style check stale match evidence should suggest match prewarm plan');
    assert.ok(staleEvidenceText.includes('/cs warm match 2390003'), '/style check stale match evidence should suggest match prewarm');
    assert.ok(staleEvidenceText.includes('修复预览:'), '/style check stale evidence should show fact-guard repair preview');
    assert.ok(/false realtime source claim|unverified realtime claim/.test(staleEvidenceText), '/style check stale evidence should still flag fake current-source wording');

    handler.handleEvent(makePlainEvent(
      922,
      96,
      '/style check 来源显示 Vitality 当前排名第一。 || 缓存: ranking fresh age=3s ttl=60s source=test-ranking',
    ));
    await waitFor(() => sent.length === 7, 'style quality fresh evidence preflight command');
    const freshEvidenceText = firstText(sent[6].message);
    assert.ok(freshEvidenceText.includes('有当前实时证据'), '/style check evidence should accept fresh evidence as current');
    assert.ok(freshEvidenceText.includes('ranking fresh'), '/style check fresh evidence should include fresh cache key');
    assert.ok(freshEvidenceText.includes('/cs evidence ranking'), '/style check fresh ranking evidence should suggest evidence card command');
    assert.ok(freshEvidenceText.includes('/cs verify ranking'), '/style check fresh ranking evidence should suggest read-only verification command');
    assert.ok(!freshEvidenceText.includes('false realtime source claim'), '/style check fresh evidence should not flag source wording when current evidence is provided');
    assert.ok(freshEvidenceText.includes('只能说证据文本里明确出现的事实'), '/style check fresh evidence should keep evidence scope boundary');
    assert.ok(freshEvidenceText.includes('证据动作: 可作当前证据'), '/style check fresh evidence should expose scoped fresh evidence action');

    handler.handleEvent(makePlainEvent(
      925,
      96,
      '/style check 来源显示 Vitality 当前排名第一，当前阵容是apEX ZywOo flameZ mezii ropz，donk最近Rating也是第一。 || 缓存: ranking fresh age=3s ttl=60s source=test-ranking',
    ));
    await waitFor(() => sent.length === 8, 'style quality typed evidence coverage preflight command');
    const typedCoverageText = firstText(sent[7].message);
    assert.ok(typedCoverageText.includes('事实类型覆盖: 未覆盖 当前阵容/转会 / 当前选手数据/状态'), '/style check should expose uncovered roster/player facts when only ranking is fresh');
    assert.ok(typedCoverageText.includes('事实修正: evidence ledger uncovered fact kind softened: roster/player'), '/style check should reuse typed ledger fact guard reason');
    assert.ok(typedCoverageText.includes('修复预览: 证据账本显示这条 fresh 证据没覆盖当前阵容/转会/当前选手数据/状态'), '/style check should preview typed evidence-boundary repair');
    assert.ok(!typedCoverageText.includes('全部最新'), '/style check typed coverage should not preserve overbroad freshness wording');

    handler.handleEvent(makePlainEvent(923, 96, '/style check 群里都说NAVI最近要换人，应该是已经确认了。'));
    await waitFor(() => sent.length === 9, 'style quality rumor preflight command');
    const rumorText = firstText(sent[8].message);
    assert.ok(rumorText.includes('unsupported rumor source claim'), '/style check should flag unsupported rumor backing');
    assert.ok(rumorText.includes('传闻边界'), '/style check rumor should recommend rumor boundary repair');
    assert.ok(rumorText.includes('不敢拿传闻当准信'), '/style check rumor should preview conservative rewrite');

    handler.handleEvent(makePlainEvent(
      924,
      96,
      '/style check 群里都说NAVI最近要换人。 || 缓存: team:navi fresh age=3s ttl=60s source=test-team',
    ));
    await waitFor(() => sent.length === 10, 'style quality rumor with fresh evidence preflight command');
    const freshRumorText = firstText(sent[9].message);
    assert.ok(freshRumorText.includes('有当前实时证据'), '/style check fresh rumor should still parse fresh evidence');
    assert.ok(freshRumorText.includes('unsupported rumor source claim'), '/style check fresh rumor should still reject hearsay backing');
    assert.ok(freshRumorText.includes('有可靠来源就按来源说'), '/style check fresh rumor should preview source-scoped rewrite');
  } finally {
    aiChat.shutdownAiChat();
  }
}

async function testReplyCacheStableKeyAndSingleFlight() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = true;
  config.ai.enable_search = false;
  config.ai.knowledge_force_style = true;
  config.ai.ai_reply_cache_seconds = 60;
  config.ai.trigger_mode = 'all';
  config.ai.trigger_probability = 1;
  config.ai.related_reply_probability = 1;
  config.ai.cooldown_seconds = 0;
  config.ai.ai_global_concurrency = 3;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(101_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let calls = 0;
  aiChat.__setLLMCallerForTests(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 180));
    return '这把别急着补枪 先等道具落完';
  });

  try {
    handler.handleEvent(makePlainEvent(916, 96, 'CS2这把残局怎么打稳一点？？', [], 7101));
    await waitFor(() => calls === 1, 'first reply cache generation started', 1000);
    handler.handleEvent(makePlainEvent(917, 97, '@机器人 CS2这把残局怎么打稳一点?', [], 7102));
    await waitFor(() => sent.length === 2, 'reply normalized single-flight cache reuse', 5000);
    assert.strictEqual(calls, 1, 'normalized cache key should single-flight across light punctuation/address variants');
    assert.deepStrictEqual(
      sent.map((item) => firstText(item.message)),
      ['这把别急着补枪 先等道具落完', '这把别急着补枪 先等道具落完'],
    );
    const stats = aiChat.getAiChatStats();
    assert.ok(stats.replyCacheHits >= 1, 'single-flight waiter should count as cache hit');
    assert.ok(stats.replyCacheEntries >= 1, 'reusable reply should be cached');
    assert.strictEqual(stats.replyCacheBypasses, 0, 'cacheable tactical reply should not count as bypass');
    assert.ok(stats.replyCachePolicyTop.some((item) => item.includes('on 残局处理')), 'reply cache policy distribution should record cacheable tactical scene');

    handler.handleEvent(makePlainEvent(922, 100, '/trace recent 2', [], 7102));
    await waitFor(() => sent.length === 3, 'trace recent exposes reply single-flight cache decision', 5000);
    const cacheRecent = firstText(sent[2].message);
    assert.ok(cacheRecent.includes('cache='), 'trace recent should summarize cache decision');
    assert.ok(cacheRecent.includes('single-flight reused'), 'trace recent should expose single-flight reuse decision');

    const adminHandler = new MessageHandler(bot);
    adminHandler.use(adminPlugin);
    adminHandler.handleEvent(makePlainEvent(921, 100, '/mem cache @机器人 CS2这把残局怎么打稳一点?', [], 7103));
    await waitFor(() => sent.length === 4, 'reply cache preflight sees cached hit', 5000);
    const cachePreview = firstText(sent[3].message);
    assert.ok(cachePreview.includes('AI回复缓存预检'), '/mem cache should render after cache fill');
    assert.ok(cachePreview.includes('状态=hit ttl'), '/mem cache should expose current cached hit state');
    assert.strictEqual(calls, 1, '/mem cache should not call AI');

    handler.handleEvent(makePlainEvent(918, 98, '你是不是机器人', [], 7111));
    handler.handleEvent(makePlainEvent(919, 99, '你是不是机器人', [], 7112));
    await waitFor(() => sent.length === 6, 'identity scene cache bypass', 5000);
    assert.strictEqual(calls, 3, 'identity boundary scene should bypass reply cache across groups');
    const bypassStats = aiChat.getAiChatStats();
    assert.ok(bypassStats.replyCacheBypasses >= 1, 'scene cache bypass should be counted');

    handler.handleEvent(makePlainEvent(920, 100, '/trace last', [], 7112));
    await waitFor(() => sent.length === 7, 'trace after identity cache bypass', 5000);
    const traceText = firstText(sent[6].message);
    assert.ok(traceText.includes('风格场景: 身份边界'), 'trace should classify identity boundary scene');
    assert.ok(traceText.includes('缓存策略: off 身份边界 scene:身份边界'), 'trace should expose scene-driven cache bypass');
    assert.ok(traceText.includes('缓存判定: bypass scene:身份边界'), 'trace should expose cache bypass decision');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testReplyCacheMaxEntriesLru() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  config.ai.ai_reply_cache_seconds = 60;
  config.ai.ai_reply_cache_max_entries = 20;
  config.ai.trigger_mode = 'all';
  config.ai.trigger_probability = 1;
  config.ai.related_reply_probability = 1;
  config.ai.cooldown_seconds = 0;
  config.ai.ai_global_concurrency = 6;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(104_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let calls = 0;
  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    calls++;
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    const id = (content.match(/cache lru smoke (\d+)/) || [])[1] || 'x';
    return `缓存LRU-${id} 这把先等道具`;
  });

  try {
    const baseGroup = 74_000 + Math.floor(Math.random() * 10_000);
    for (let i = 0; i < 25; i++) {
      handler.handleEvent(makePlainEvent(930 + i, 110 + i, `cache lru smoke ${i} 怎么处理`, [], baseGroup + i));
    }
    await waitFor(() => sent.length === 25, 'reply cache lru fill', 8000);
    assert.strictEqual(calls, 25, 'reply cache lru fill should generate unique replies');
    let stats = aiChat.getAiChatStats();
    assert.strictEqual(stats.replyCacheMaxEntries, 20, 'reply cache stats should expose configured max entries');
    assert.ok(stats.replyCacheEntries <= 20, 'reply cache should trim to configured max entries');
    assert.strictEqual(stats.replyCacheEntries, 20, 'reply cache should keep max recent entries after fill');

    handler.handleEvent(makePlainEvent(960, 160, 'cache lru smoke 24 怎么处理', [], baseGroup + 40));
    await waitFor(() => sent.length === 26, 'reply cache lru retained hit', 5000);
    assert.strictEqual(firstText(sent[25].message), '缓存LRU-24 这把先等道具');
    assert.strictEqual(calls, 25, 'newest reply cache entry should be reused without LLM call');
    stats = aiChat.getAiChatStats();
    assert.ok(stats.replyCacheHits >= 1, 'reply cache lru retained query should count cache hit');

    handler.handleEvent(makePlainEvent(961, 161, 'cache lru smoke 0 怎么处理', [], baseGroup + 41));
    await waitFor(() => sent.length === 27, 'reply cache lru evicted miss', 5000);
    assert.strictEqual(firstText(sent[26].message), '缓存LRU-0 这把先等道具');
    assert.strictEqual(calls, 26, 'oldest reply cache entry should be evicted and regenerated');
    assert.strictEqual(aiChat.getAiChatStats().replyCacheEntries, 20, 'reply cache should stay at max after evicted miss refill');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testReplyCacheAvoidsSameSessionRepeat() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  config.ai.ai_reply_cache_seconds = 60;
  config.ai.trigger_mode = 'smart';
  config.ai.trigger_probability = 1;
  config.ai.related_reply_probability = 1;
  config.ai.cooldown_seconds = 0;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(103_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let calls = 0;
  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    calls++;
    const last = messages[messages.length - 1];
    if (
      typeof last.content === 'string'
      && last.content.includes('跟你之前说过的太像')
    ) {
      return '这次换个说法 先拿信息再补枪';
    }
    return calls === 1
      ? '这把先别急着补枪 先等道具落完'
      : '这把先别急着补枪 先等道具落完';
  });

  try {
    const groupId = 73_100 + Math.floor(Math.random() * 10_000);
    const query = `玩机器 CS2这把怎么打稳一点 smoke${Date.now()}`;
    handler.handleEvent(makePlainEvent(920, 100, query, [], groupId));
    await waitFor(() => sent.length === 1, 'first cached repeat guard reply', 5000);
    assert.strictEqual(firstText(sent[0].message), '这把先别急着补枪 先等道具落完');
    assert.strictEqual(calls, 1, 'first reply should be generated once and cached');
    assert.ok(aiChat.getAiChatStats().replyCacheEntries >= 1, 'first reply should enter cache');

    handler.handleEvent(makePlainEvent(921, 100, query, [], groupId));
    await waitFor(() => sent.length === 2, 'same-session cached repeat guard reply', 5000);
    assert.strictEqual(firstText(sent[1].message), '这次换个说法 先拿信息再补枪');
    assert.strictEqual(calls, 3, 'same-session cached duplicate should discard cache and run duplicate repair retry');

    handler.handleEvent(makePlainEvent(922, 100, '/trace last', [], groupId));
    await waitFor(() => sent.length === 3, 'trace after cached duplicate freshness repair');
    const traceText = firstText(sent[2].message);
    assert.ok(traceText.includes('新鲜度:'), 'trace should expose freshness repair');
    assert.ok(traceText.includes('cached duplicate discarded'), 'trace should explain cached duplicate discard');
    assert.ok(traceText.includes('缓存判定:'), 'trace should expose cache decision chain');
    assert.ok(traceText.includes('discard duplicate same-session'), 'trace should explain cached duplicate cache discard');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testReplySingleFlightDoesNotReusePersonalizedOutput() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  config.ai.ai_reply_cache_seconds = 60;
  config.ai.trigger_mode = 'smart';
  config.ai.trigger_probability = 1;
  config.ai.related_reply_probability = 1;
  config.ai.cooldown_seconds = 0;
  config.ai.ai_global_concurrency = 3;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(102_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let calls = 0;
  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    const sender = (content.match(/sender: ([^\n]+)/) || [])[1] || 'unknown';
    return `${sender} 这把你先别急着拉`;
  });

  try {
    handler.handleEvent(makePlainEvent(918, 98, '这把怎么打稳一点', [], 7201));
    await waitFor(() => calls === 1, 'first personalized reply generation started', 1000);
    handler.handleEvent(makePlainEvent(919, 99, '这把怎么打稳一点', [], 7202));
    await waitFor(() => sent.length === 2, 'personalized reply no unsafe reuse', 5000);
    assert.strictEqual(calls, 2, 'personalized output should not be reused across single-flight waiters');
    assert.ok(firstText(sent[0].message).includes('user98'), 'first reply should keep first sender');
    assert.ok(firstText(sent[1].message).includes('user99'), 'second reply should regenerate for second sender');
    assert.strictEqual(aiChat.getAiChatStats().replyCacheEntries, 0, 'personalized reply should not enter cache');

    handler.handleEvent(makePlainEvent(920, 100, '/trace recent 2', [], 7202));
    await waitFor(() => sent.length === 3, 'trace recent after personalized single-flight rejection', 5000);
    const traceRecentText = firstText(sent[2].message);
    assert.ok(traceRecentText.includes('single-flight non-reusable:context-bound'), 'trace recent should explain why single-flight output was not reused');
    assert.ok(traceRecentText.includes('not-stored context-bound'), 'trace recent should expose personalized reply cache rejection');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testShutdownCancelsPendingAiReply() {
  const config = makeConfigForHandler();
  config.ai.enable_knowledge = false;
  config.ai.enable_search = false;
  config.ai.enable_tts = false;
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(96_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  let resolveLLM;
  let llmStarted = false;
  aiChat.__setLLMCallerForTests(async () => {
    llmStarted = true;
    return new Promise((resolve) => {
      resolveLLM = resolve;
    });
  });

  try {
    handler.handleEvent(makeEvent(912, 92, ' 慢一点回复我'));
    await waitFor(() => llmStarted && typeof resolveLLM === 'function', 'pending AI reply before shutdown');
    assert.ok(aiChat.getAiChatStats().pendingJobs >= 1, 'pending AI reply should be visible before shutdown');
    aiChat.shutdownAiChat();
    resolveLLM('这条不应该发出去');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(sent.length, 0, 'shutdown should cancel stale AI replies before sending');
    assert.strictEqual(aiChat.getAiChatStats().pendingJobs, 0, 'shutdown should clear pending AI reply stats');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testPassiveTriggerFiltering() {
  const config = makeConfigForHandler();
  config.ai.trigger_probability = 0;
  config.ai.related_reply_probability = 0;
  config.ai.passive_random_min_chars = 4;
  config.ai.passive_random_allow_numeric = false;
  config.ai.enable_search = false;
  config.ai.enable_knowledge = false;
  config.ai.trigger_mode = 'smart';
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(70_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    const id = (content.match(/message_id: (\d+)/) || [])[1] || 'unknown';
    return `passive-${id}`;
  });

  try {
    handler.handleEvent(makePlainEvent(401, 41, '6'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(sent.length, 0, 'low-information passive numeric text should not trigger AI');

    handler.handleEvent(makePlainEvent(404, 44, '玩机器你在吗', [], 6659));
    await waitFor(() => sent.length === 1, 'direct chat cue passive reply');
    assert.strictEqual(
      firstText(sent[0].message),
      'passive-404',
      'direct chat cue should trigger ordinary AI chat without @ even when passive probabilities are zero',
    );

    config.ai.trigger_probability = 1;
    config.ai.related_reply_probability = 1;

    handler.handleEvent(makePlainEvent(402, 42, 'CS2这经济道具又断了'));
    await waitFor(() => sent.length === 2, 'keyword passive reply');
    assert.strictEqual(
      firstText(sent[1].message),
      'passive-402',
      'keyword ordinary messages should trigger AI without @',
    );

    handler.handleEvent(makePlainEvent(403, 43, '这把经济怎么又崩了，回防一点道具没有', [], 6658));
    await waitFor(() => sent.length === 3, 'soft CS discussion passive reply');
    assert.strictEqual(
      firstText(sent[2].message),
      'passive-403',
      'soft CS discussion should trigger at related reply probability even without explicit CS2 keyword',
    );
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testPrivateMessages() {
  const config = makeConfigForHandler();
  const sentPrivate = [];
  const sentGroup = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sentGroup.push({ groupId, message });
      if (onMessageId) onMessageId(40_000 + sentGroup.length);
      return true;
    },
    sendPrivateMessage: async (userId, message, onMessageId) => {
      sentPrivate.push({ userId, message });
      if (onMessageId) onMessageId(45_000 + sentPrivate.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(pingPlugin);
  handler.use(funPlugin);
  handler.use(aiChat.aiChatPlugin);
  funTest.__setImageResolverForTests(async () => 'data:image/jpeg;base64,/9j/2w==');
  const prompts = [];

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    prompts.push(content);
    const id = (content.match(/message_id: (\d+)/) || [])[1] || 'unknown';
    return `私聊收到-${id} 😂`;
  });

  try {
    handler.handleEvent(makePrivateEvent(701, 71, '/ping'));
    await waitFor(() => sentPrivate.length === 1, 'private ping');
    assert.strictEqual(firstText(sentPrivate[0].message), '🏓 pong!');
    assert.strictEqual(sentGroup.length, 0, 'private ping should not send a group message');

    handler.handleEvent(makePrivateEvent(702, 72, '你好，帮我看看这波怎么说'));
    await waitFor(() => sentPrivate.length === 2, 'private ai forced reply');
    assert.strictEqual(sentPrivate[1].userId, 72);
    assert.ok(firstText(sentPrivate[1].message).includes('私聊收到-702'), 'private AI should reply to the sender');
    assert.ok(!/[😂🤣]/.test(firstText(sentPrivate[1].message)), 'private AI unicode emoji should be converted to QQ face segments');
    assert.ok(sentPrivate[1].message.some((seg) => seg.type === 'face'), 'private AI emoji should become QQ face segment');
    assert.ok(prompts.at(-1).includes('chat_type: private'), 'private prompt should mark chat_type');
    assert.ok(prompts.at(-1).includes('chat_id: 72'), 'private prompt should include private chat id');

    handler.handleEvent(makePrivateEvent(703, 73, '今天抽个CS选手'));
    await waitFor(() => sentPrivate.length === 3, 'private fuzzy csplayer', 15000);
    assert.ok(sentPrivate[2].message.some((seg) => seg.type === 'image'), 'private csplayer should send player image');
    assert.ok(!sentPrivate[2].message.some((seg) => seg.type === 'at'), 'private csplayer should not include @ segment');
  } finally {
    funTest.__setImageResolverForTests();
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testRepeaterAndPoke() {
  const config = makeConfigForHandler();
  config.ai.poke_reply_probability = 1;
  const sent = [];
  const eventHandlers = [];
  const bot = {
    getConfig: () => config,
    onEvent: (handler) => eventHandlers.push(handler),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(60_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };

  registerPokeListener(bot);
  for (const handler of eventHandlers) {
    handler({
      time: Math.floor(Date.now() / 1000),
      self_id: 3853043835,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 6657,
      user_id: 42,
      target_id: 3853043835,
    });
  }
  await waitFor(() => sent.length === 1, 'poke reply');
  assert.strictEqual(sent[0].groupId, 6657);
  assert.strictEqual(sent[0].message[0]?.type, 'at', 'poke reply should at the poker when possible');
  const pokeText = firstText(sent[0].message) || '';
  assert.ok(pokeText.length > 0 && pokeText.length <= 40, 'poke reply should be a short live-style line');
  assert.ok(!/模板|核验|机器人|bot|不是本人/.test(pokeText), 'poke reply should not leak knowledge metadata');
  assert.ok(
    pokeTest.pokeReplyGroups.flat().every((line) => pokeTest.isGoodPokeLine(line)),
    'fallback poke lines should be short and metadata-free',
  );
  assert.ok(
    pokeTest.pokeReplyGroups.flat().some((line) => /戳|弹幕|战术|默认|信息|道具|急|问题|看|问|打断|干嘛|催/.test(line)),
    'fallback poke replies should include live-interaction language',
  );

  const handler = new MessageHandler(bot);
  handler.use(repeaterPlugin);
  const beforeRepeat = sent.length;
  handler.handleEvent(makePlainEvent(501, 51, '可以复读一下'));
  handler.handleEvent(makePlainEvent(502, 52, '可以复读一下'));
  handler.handleEvent(makePlainEvent(503, 53, '可以复读一下'));
  await waitFor(() => sent.length === beforeRepeat + 1, 'normal repeater');
  assert.ok(
    /^(?:\+1 |确实 |同感 )?可以复读一下[!！?？]?$/.test(sent.at(-1).message),
    'repeater should repeat original text or a small human-like variant',
  );

  const beforeUnsafe = sent.length;
  handler.handleEvent(makePlainEvent(504, 54, '6'));
  handler.handleEvent(makePlainEvent(505, 55, '6'));
  handler.handleEvent(makePlainEvent(506, 56, '6'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(sent.length, beforeUnsafe, 'repeater should not repeat low-information numeric text');
}

async function testStickersPlugin() {
  const config = makeConfigForHandler();
  config.ai.sticker_auto_reply_enabled = true;
  config.ai.sticker_auto_reply_probability = 1;
  config.ai.sticker_auto_group_cooldown_seconds = 60;
  config.ai.sticker_auto_keyword_cooldown_seconds = 120;
  stickerTest.resetForTests();
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(66_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(stickersPlugin);

  assert.ok(stickerTest.autoRules.some((rule) => rule.label === '白给'), 'auto sticker rules should include white-give scenes');
  assert.ok(stickerTest.autoRules.some((rule) => rule.label === '开香槟'), 'auto sticker rules should include champagne scenes');
  assert.strictEqual(stickerTest.findAutoRule('这把白给了')?.id, 'baigei', 'auto sticker matcher should detect white-give text');
  assert.ok(stickerTest.markerSegmentsForRule(stickerTest.findAutoRule('老板大气') || stickerTest.autoRules[0]).some((seg) => seg.type === 'face' || seg.type === 'image'), 'auto sticker rules should resolve to a visual segment');

  handler.handleEvent(makePlainEvent(520, 52, '[笑哭]'));
  await waitFor(() => sent.length === 1, 'explicit sticker marker');
  assert.ok(sent[0].message.some((seg) => seg.type === 'face'), 'explicit marker should be converted to QQ face segment');

  handler.handleEvent(makePlainEvent(521, 53, '这把白给了兄弟们'));
  await waitFor(() => sent.length === 2, 'auto keyword sticker');
  assert.ok(sent[1].message.some((seg) => seg.type === 'face' || seg.type === 'image'), 'auto keyword should send a visual sticker/face');
  let stats = getStickerStats();
  assert.strictEqual(stats.markerReplies, 1, 'sticker stats should count explicit marker replies');
  assert.strictEqual(stats.autoReplies, 1, 'sticker stats should count auto keyword replies');
  assert.strictEqual(stats.lastTrace.action, 'sent', 'sticker stats should keep last sent trace');

  handler.handleEvent(makePlainEvent(522, 54, '白给白给又白给'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(sent.length, 2, 'auto sticker group cooldown should prevent immediate spam');
  stats = getStickerStats();
  assert.strictEqual(stats.throttledAutoReplies, 1, 'sticker stats should count cooldown throttles');

  const directedHandled = await stickersPlugin.handler({
    event: makeEvent(523, 55, ' 白给了你怎么看'),
    rawText: '白给了你怎么看',
    command: null,
    args: [],
    chatType: 'group',
    chatId: 6657,
    groupId: 6657,
    isPrivate: false,
    isAtBot: true,
    isReplyToBot: false,
    bot,
    reply: (message) => sent.push({ groupId: 6657, message }),
    replyAt: (message) => sent.push({ groupId: 6657, message }),
    replyQuote: (message) => sent.push({ groupId: 6657, message }),
    replyQuoteTo: (_messageId, _userId, message) => sent.push({ groupId: 6657, message }),
  });
  assert.strictEqual(directedHandled, false, 'directed @ messages should not be hijacked by sticker automation');
  assert.strictEqual(sent.length, 2, 'directed @ sticker check should not send a sticker');

  handler.handleEvent(makePlainEvent(524, 56, '/stickers status'));
  await waitFor(() => sent.length === 3, 'sticker status command');
  assert.ok(firstText(sent[2].message).includes('贴纸状态'), '/stickers status should render sticker stats');
  assert.ok(firstText(sent[2].message).includes('节流'), '/stickers status should expose throttle stats');

  handler.handleEvent(makePlainEvent(525, 57, '/stickers keywords'));
  await waitFor(() => sent.length === 4, 'sticker keywords command');
  assert.ok(firstText(sent[3].message).includes('自动贴纸关键词'), '/stickers keywords should render rule list');
  assert.ok(firstText(sent[3].message).includes('老板大气'), 'sticker keyword list should include gift-style trigger');
}

async function testHelpTopicDiscoverability() {
  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(67_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(helpPlugin);

  handler.handleEvent(makePlainEvent(526, 58, '/help'));
  await waitFor(() => sent.length === 1, 'default help command');
  const defaultHelp = firstText(sent[0].message);
  assert.ok(defaultHelp.includes('主题帮助:'), '/help should advertise topic help shortcuts');
  assert.ok(defaultHelp.includes('/help cs'), '/help should expose cs topic shortcut');
  assert.ok(defaultHelp.includes('/csquiz answer A'), '/help should expose interactive quiz answer command');

  handler.handleEvent(makePlainEvent(527, 58, '/help cs'));
  await waitFor(() => sent.length === 2, 'cs topic help command');
  const csHelp = firstText(sent[1].message);
  assert.ok(csHelp.includes('CS实时/HLTV证据帮助'), '/help cs should render focused CS help');
  assert.ok(csHelp.includes('/cs hltvcheck <id>'), '/help cs should expose hltv link check command');
  assert.ok(csHelp.includes('fresh 才能当当前快照'), '/help cs should include realtime truth boundary');

  handler.handleEvent(makePlainEvent(528, 58, '/help daily'));
  await waitFor(() => sent.length === 3, 'daily topic help command');
  const dailyHelp = firstText(sent[2].message);
  assert.ok(dailyHelp.includes('每日CS/好玩功能帮助'), '/help daily should render focused daily CS help');
  assert.ok(dailyHelp.includes('/csquiz answer A'), '/help daily should expose quiz scoring command');
  assert.ok(dailyHelp.includes('/cstrain analyze'), '/help daily should expose training analyzer command');
  assert.ok(dailyHelp.includes('/daily personal'), '/help daily should expose personalized daily profile card command');
  assert.ok(dailyHelp.includes('/daily proof'), '/help daily should expose daily evidence ledger command');
  assert.ok(dailyHelp.includes('/daily score'), '/help daily should expose daily completion score command');
  assert.ok(dailyHelp.includes('/daily vibe'), '/help daily should expose daily chat vibe command');
  assert.ok(dailyHelp.includes('/daily relay'), '/help daily should expose daily media relay command');

  handler.handleEvent(makePlainEvent(529, 58, '/help 什么鬼主题'));
  await waitFor(() => sent.length === 4, 'unknown topic help command');
  assert.ok(firstText(sent[3].message).includes('可用主题'), '/help unknown topic should list available topics');
}

async function testDailyPulsePlugin() {
  const config = makeConfigForHandler();
  config.admin_qq = [58];
  const storePath = path.resolve(__dirname, '..', 'data', `daily-pulse-smoke-${Date.now()}.json`);
  const profileStorePath = path.resolve(__dirname, '..', 'data', `daily-profile-smoke-${Date.now()}.json`);
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(68_000 + sent.length);
      return true;
    },
    sendPrivateMessage: async (userId, message, onMessageId) => {
      sent.push({ userId, message });
      if (onMessageId) onMessageId(69_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(dailyPulsePlugin);
  dailyPulseTest.__setStorePathForTests(storePath);
  userProfile.__test.setStorePathForTests(profileStorePath);

  try {
    const profileCtx = {
      chatType: 'group',
      chatId: 6657,
      event: { user_id: 99, sender: { card: 'daily-smoke', nickname: 'daily-smoke' } },
      args: [],
    };
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'map', 'Inferno'] });
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'player', 'donk'] });
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'team', 'Vitality'] });
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'tone', '短句一点，别太端着'] });

    assert.strictEqual(dailyPulseTest.normalizePulseTime('9:05'), '09:05', 'daily time parser should normalize HH:mm');
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('订阅每日问候 08:30'),
      { action: 'on', time: '08:30' },
      'natural daily subscribe should parse time',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('晚安机器'),
      { action: 'recap' },
      'natural daily recap should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日挑战'),
      { action: 'challenge' },
      'natural daily challenge should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('挑战完成'),
      { action: 'done' },
      'natural daily challenge done should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('挑战榜'),
      { action: 'challenge_board' },
      'natural daily challenge board should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日打卡'),
      { action: 'checkin' },
      'natural daily checkin should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日收工'),
      { action: 'wrap' },
      'natural daily wrap-up should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('打卡榜'),
      { action: 'board' },
      'natural daily checkin board should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('我的每日'),
      { action: 'me' },
      'natural daily personal summary should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日偏好'),
      { action: 'personal' },
      'natural daily personalized profile card should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日证据账本'),
      { action: 'proof' },
      'natural daily evidence ledger should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日闭环分'),
      { action: 'score' },
      'natural daily completion score should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日指挥台'),
      { action: 'center' },
      'natural daily command center should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日队形'),
      { action: 'squad' },
      'natural daily squad summary should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日接力'),
      { action: 'relay' },
      'natural daily media relay should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日聊天节奏'),
      { action: 'vibe' },
      'natural daily chat vibe should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日话题'),
      { action: 'ice' },
      'natural daily icebreaker should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('识图语音脚本包'),
      { action: 'script' },
      'natural daily media script should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('识图语音缺啥'),
      { action: 'gap' },
      'natural daily media gap should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日语音台词'),
      { action: 'voice_line' },
      'natural daily voice line kit should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('今日安排'),
      { action: 'plan' },
      'natural daily action plan should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('催我打卡'),
      { action: 'nudge' },
      'natural daily nudge should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('识图语音陪跑'),
      { action: 'media' },
      'natural daily media companion should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('保连续'),
      { action: 'guard' },
      'natural daily streak guard should parse',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('我今天还差啥'),
      { action: 'nudge' },
      'natural daily missing question should parse as nudge',
    );
    assert.deepStrictEqual(
      dailyPulseTest.parseNaturalDailyPulse('本周每日'),
      { action: 'week' },
      'natural daily weekly summary should parse',
    );
    const dailyPulseMessage = dailyPulseTest.buildDailyPulseMessage('group', 6657, new Date('2026-06-09T01:00:00Z'));
    assert.ok(dailyPulseMessage.includes('玩机器每日提醒'), 'daily pulse card should render title');
    assert.ok(dailyPulseMessage.includes('识图语音:'), 'daily pulse card should include multimodal short status');
    assert.ok(dailyPulseMessage.includes('/daily personal'), 'daily pulse card should expose the personalized daily entry');
    assert.ok(dailyPulseMessage.includes('/daily proof'), 'daily pulse card should expose the evidence ledger entry');
    assert.ok(dailyPulseMessage.includes('/daily score'), 'daily pulse card should expose the completion score entry');
    assert.ok(dailyPulseMessage.includes('/daily center'), 'daily pulse card should expose the command center entry');
    assert.ok(dailyPulseMessage.includes('/daily vibe'), 'daily pulse card should expose the chat vibe entry');
    assert.ok(dailyPulseMessage.includes('/daily relay'), 'daily pulse card should expose the media relay entry');
    assert.ok(dailyPulseMessage.includes('/daily gap'), 'daily pulse card should expose the media gap entry');
    assert.ok(dailyPulseMessage.includes('/daily line'), 'daily pulse card should expose the voice line entry');
    assert.ok(dailyPulseMessage.includes('/daily squad'), 'daily pulse card should expose the squad summary entry');
    assert.ok(dailyPulseMessage.includes('/daily ice'), 'daily pulse card should expose the icebreaker entry');
    assert.ok(dailyPulseMessage.includes('/daily script'), 'daily pulse card should expose the media script entry');
    assert.ok(dailyPulseMessage.includes('/daily plan'), 'daily pulse card should expose the action plan entry');
    assert.ok(dailyPulseMessage.includes('/daily guard'), 'daily pulse card should expose the streak guard entry');
    assert.ok(dailyPulseMessage.includes('/daily media'), 'daily pulse card should expose the media companion entry');
    assert.ok(dailyPulseMessage.includes('/daily nudge'), 'daily pulse card should expose the nudge entry');
    const dailyRecapMessage = dailyPulseTest.buildDailyRecapMessage('group', 6657, new Date('2026-06-09T12:00:00Z'));
    assert.ok(dailyRecapMessage.includes('玩机器晚间复盘'), 'daily recap card should render title');
    assert.ok(dailyRecapMessage.includes('识图语音收尾:'), 'daily recap card should include multimodal closing status');
    assert.ok(dailyPulseTest.buildDailyChallengeMessage('group', 6657, 99, new Date('2026-06-09T12:00:00Z')).includes('玩机器今日挑战'), 'daily challenge card should render title');
    assert.ok(dailyPulseTest.buildDailyChallengeMessage('group', 6657, 99, new Date('2026-06-09T12:00:00Z')).includes('边界'), 'daily challenge card should include truth boundary');
    const emptyPersonalSummary = dailyPulseTest.formatDailyUserSummary('group', 6657, 101, new Date('2026-06-09T12:00:00Z'));
    assert.ok(emptyPersonalSummary.includes('我的每日状态'), 'daily personal summary should render title');
    assert.ok(emptyPersonalSummary.includes('今天未打'), 'daily personal summary should show missing checkin');
    assert.ok(emptyPersonalSummary.includes('今天未完成'), 'daily personal summary should show missing challenge completion');
    assert.ok(emptyPersonalSummary.includes('识图语音:'), 'daily personal summary should include multimodal short status');
    const personalizedDaily = dailyPulseTest.formatDailyPersonalizedBrief('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(personalizedDaily.includes('每日偏好卡'), 'daily personalized brief should render title');
    assert.ok(personalizedDaily.includes('画像偏好:'), 'daily personalized brief should include profile line');
    assert.ok(personalizedDaily.includes('偏好地图: Inferno'), 'daily personalized brief should include favorite maps');
    assert.ok(personalizedDaily.includes('偏好选手: donk'), 'daily personalized brief should include favorite players');
    assert.ok(personalizedDaily.includes('偏好队伍: Vitality'), 'daily personalized brief should include favorite teams');
    assert.ok(personalizedDaily.includes('聊天口吻:'), 'daily personalized brief should include tone guidance');
    assert.ok(personalizedDaily.includes('优先补:'), 'daily personalized brief should include multimodal priority');
    assert.ok(personalizedDaily.includes('偏好不是实时赛事事实'), 'daily personalized brief should preserve profile fact boundary');
    const evidenceLedger = dailyPulseTest.formatDailyEvidenceLedger('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(evidenceLedger.includes('今日证据账本'), 'daily evidence ledger should render title');
    assert.ok(evidenceLedger.includes('只读证据卡'), 'daily evidence ledger should be non-mutating');
    assert.ok(evidenceLedger.includes('已证明'), 'daily evidence ledger should summarize proven count');
    assert.ok(evidenceLedger.includes('挑战:'), 'daily evidence ledger should include challenge proof line');
    assert.ok(evidenceLedger.includes('打卡:'), 'daily evidence ledger should include checkin proof line');
    assert.ok(evidenceLedger.includes('画像:'), 'daily evidence ledger should include profile evidence line');
    assert.ok(evidenceLedger.includes('今日实跑:'), 'daily evidence ledger should include media run summary');
    assert.ok(evidenceLedger.includes('识图:'), 'daily evidence ledger should include vision proof line');
    assert.ok(evidenceLedger.includes('听写:'), 'daily evidence ledger should include STT proof line');
    assert.ok(evidenceLedger.includes('发语音:'), 'daily evidence ledger should include voice proof line');
    assert.ok(evidenceLedger.includes('不能证明:'), 'daily evidence ledger should list non-evidence boundaries');
    assert.ok(evidenceLedger.includes('缓存 hit'), 'daily evidence ledger should reject cache-only proof');
    assert.ok(evidenceLedger.includes('没出现在记录里的输入不能说成已完成'), 'daily evidence ledger should preserve completion boundary');
    const emptyCompletionScore = dailyPulseTest.formatDailyCompletionScore('group', 6657, 101, new Date('2026-06-09T12:00:00Z'));
    assert.ok(emptyCompletionScore.includes('今日闭环分'), 'daily completion score should render title');
    assert.ok(emptyCompletionScore.includes('/100'), 'daily completion score should show numeric score');
    assert.ok(emptyCompletionScore.includes('缺口:'), 'daily completion score should show missing line');
    assert.ok(emptyCompletionScore.includes('一分钟补法:'), 'daily completion score should include rescue action');
    assert.ok(emptyCompletionScore.includes('check/warm/cache hit 不加分'), 'daily completion score should preserve real-run boundary');
    const wrapUpFirst = dailyPulseTest.recordDailyWrapUp('group', 6657, 102, new Date('2026-06-09T12:00:00Z'));
    assert.ok(wrapUpFirst.includes('今日收工'), 'daily wrap-up should render title');
    assert.ok(wrapUpFirst.includes('挑战: 今日已完成'), 'daily wrap-up should record challenge completion');
    assert.ok(wrapUpFirst.includes('打卡: 今日已到'), 'daily wrap-up should record checkin');
    assert.ok(wrapUpFirst.includes('识图语音下一步:'), 'daily wrap-up should route to media companion');
    const wrapUpRepeat = dailyPulseTest.recordDailyWrapUp('group', 6657, 102, new Date('2026-06-09T13:00:00Z'));
    assert.ok(wrapUpRepeat.includes('累计1次'), 'same-day daily wrap-up should remain idempotent for both counters');
    const firstDone = dailyPulseTest.recordDailyChallengeDone('group', 6657, 99, new Date('2026-06-08T01:00:00Z'));
    assert.ok(firstDone.includes('挑战连续: 1天'), 'first daily challenge done should start streak');
    assert.ok(firstDone.includes('识图语音下一步:'), 'daily challenge done should route to media companion');
    const secondDone = dailyPulseTest.recordDailyChallengeDone('group', 6657, 99, new Date('2026-06-09T01:00:00Z'));
    assert.ok(secondDone.includes('挑战连续: 2天'), 'next day daily challenge done should advance streak');
    const repeatedDone = dailyPulseTest.recordDailyChallengeDone('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(repeatedDone.includes('今天已经记过'), 'same day daily challenge done should be idempotent');
    assert.ok(repeatedDone.includes('累计: 2次'), 'same day daily challenge done should not increment total');
    dailyPulseTest.recordDailyChallengeDone('group', 6657, 100, new Date('2026-06-09T01:00:00Z'));
    const challengeBoard = dailyPulseTest.formatDailyChallengeBoard('group', 6657, 100, new Date('2026-06-09T12:00:00Z'));
    assert.ok(challengeBoard.includes('今日挑战榜'), 'daily challenge board should render title');
    assert.ok(challengeBoard.includes('QQ99'), 'daily challenge board should include top streak user');
    assert.ok(challengeBoard.includes('连续2天'), 'daily challenge board should sort and show challenge streak counters');
    const firstCheckin = dailyPulseTest.recordDailyCheckin('group', 6657, 99, new Date('2026-06-08T01:00:00Z'));
    assert.ok(firstCheckin.includes('连续: 1天'), 'first daily checkin should start streak');
    assert.ok(firstCheckin.includes('识图语音下一步:'), 'daily checkin should route to media companion');
    const secondCheckin = dailyPulseTest.recordDailyCheckin('group', 6657, 99, new Date('2026-06-09T01:00:00Z'));
    assert.ok(secondCheckin.includes('连续: 2天'), 'next day daily checkin should advance streak');
    const repeatedCheckin = dailyPulseTest.recordDailyCheckin('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(repeatedCheckin.includes('今天已经打过'), 'same day daily checkin should be idempotent');
    assert.ok(repeatedCheckin.includes('累计: 2次'), 'same day daily checkin should not increment total');
    dailyPulseTest.recordDailyCheckin('group', 6657, 100, new Date('2026-06-09T01:00:00Z'));
    const checkinBoard = dailyPulseTest.formatDailyCheckinBoard('group', 6657, 100, new Date('2026-06-09T12:00:00Z'));
    assert.ok(checkinBoard.includes('每日打卡榜'), 'daily checkin board should render title');
    assert.ok(checkinBoard.includes('QQ99'), 'daily checkin board should include top streak user');
    assert.ok(checkinBoard.includes('连续2天'), 'daily checkin board should sort and show streak counters');
    const squadSummary = dailyPulseTest.formatDailySquadSummary('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(squadSummary.includes('每日队形'), 'daily squad summary should render title');
    assert.ok(squadSummary.includes('今日挑战:'), 'daily squad summary should include today challenge line');
    assert.ok(squadSummary.includes('今日打卡:'), 'daily squad summary should include today checkin line');
    assert.ok(squadSummary.includes('双收'), 'daily squad summary should include double-completion count');
    assert.ok(squadSummary.includes('QQ99'), 'daily squad summary should include leading user context');
    assert.ok(squadSummary.includes('你:'), 'daily squad summary should include viewer progress');
    assert.ok(squadSummary.includes('识图语音:'), 'daily squad summary should include multimodal short status');
    assert.ok(squadSummary.includes('/daily guard'), 'daily squad summary should route to streak guard');
    assert.ok(squadSummary.includes('/daily media'), 'daily squad summary should route to media companion');
    assert.ok(squadSummary.includes('不会替任何人写'), 'daily squad summary should stay read-only');
    const icebreaker = dailyPulseTest.formatDailyIcebreaker('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(icebreaker.includes('每日破冰话题'), 'daily icebreaker should render title');
    assert.ok(icebreaker.includes('只读话题卡'), 'daily icebreaker should be non-mutating');
    assert.ok(icebreaker.includes('群话题:'), 'daily icebreaker should include group topic');
    assert.ok(icebreaker.includes('看图接力:'), 'daily icebreaker should include image relay');
    assert.ok(icebreaker.includes('语音接力:'), 'daily icebreaker should include voice relay');
    assert.ok(icebreaker.includes('/voice check'), 'daily icebreaker should include voice preflight');
    assert.ok(icebreaker.includes('/voice test'), 'daily icebreaker should include voice real test');
    assert.ok(icebreaker.includes('你的缺口:'), 'daily icebreaker should include personal progress gap');
    assert.ok(icebreaker.includes('识图语音:'), 'daily icebreaker should include multimodal short status');
    assert.ok(icebreaker.includes('check/warm/cache hit 不算实跑'), 'daily icebreaker should preserve real-run boundary');
    const mediaScript = dailyPulseTest.formatDailyMediaScript('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(mediaScript.includes('识图语音每日脚本包'), 'daily media script should render title');
    assert.ok(mediaScript.includes('只读脚本'), 'daily media script should be non-mutating');
    assert.ok(mediaScript.includes('1. 看图脚本:'), 'daily media script should include image script');
    assert.ok(mediaScript.includes('2. 听写脚本:'), 'daily media script should include STT script');
    assert.ok(mediaScript.includes('3. 发声脚本:'), 'daily media script should include TTS script');
    assert.ok(mediaScript.includes('/voice check'), 'daily media script should include voice preflight');
    assert.ok(mediaScript.includes('/voice test'), 'daily media script should include voice real test');
    assert.ok(mediaScript.includes('4. 验收脚本:'), 'daily media script should include verification script');
    assert.ok(mediaScript.includes('/vision last'), 'daily media script should include vision trace command');
    assert.ok(mediaScript.includes('/voice recent 3'), 'daily media script should include voice trace command');
    assert.ok(mediaScript.includes('群里回执:'), 'daily media script should include group receipt');
    assert.ok(mediaScript.includes('成功 trace 才算实跑'), 'daily media script should preserve real-run boundary');
    const commandCenter = dailyPulseTest.formatDailyCommandCenter('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(commandCenter.includes('今日指挥台'), 'daily command center should render title');
    assert.ok(commandCenter.includes('只读一屏'), 'daily command center should be non-mutating');
    assert.ok(commandCenter.includes('你:'), 'daily command center should include personal state');
    assert.ok(commandCenter.includes('当前群:'), 'daily command center should include group state');
    assert.ok(commandCenter.includes('现在先做:'), 'daily command center should include immediate next action');
    assert.ok(commandCenter.includes('群里带一下:'), 'daily command center should include group action');
    assert.ok(commandCenter.includes('识图语音:'), 'daily command center should include multimodal short status');
    assert.ok(commandCenter.includes('/daily script'), 'daily command center should route to media script');
    assert.ok(commandCenter.includes('好玩/有用:'), 'daily command center should include useful playful action');
    assert.ok(commandCenter.includes('不会替你写记录'), 'daily command center should stay read-only');
    const mediaGap = dailyPulseTest.formatDailyMediaGap('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(mediaGap.includes('识图语音今日补缺'), 'daily media gap should render title');
    assert.ok(mediaGap.includes('只读补缺单'), 'daily media gap should be non-mutating');
    assert.ok(mediaGap.includes('今日实跑:'), 'daily media gap should include real run summary');
    assert.ok(mediaGap.includes('缺口:'), 'daily media gap should include missing media line');
    assert.ok(mediaGap.includes('优先补:'), 'daily media gap should include priority action');
    assert.ok(mediaGap.includes('最近识图:'), 'daily media gap should include latest vision trace summary');
    assert.ok(mediaGap.includes('最近听写:'), 'daily media gap should include latest STT trace summary');
    assert.ok(mediaGap.includes('最近发声:'), 'daily media gap should include latest voice trace summary');
    assert.ok(mediaGap.includes('/media recent 3'), 'daily media gap should route to media recent');
    assert.ok(mediaGap.includes('check/warm/cache hit 都不算实跑'), 'daily media gap should preserve real-run boundary');
    const voiceLineKit = dailyPulseTest.formatDailyVoiceLineKit('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(voiceLineKit.includes('每日语音台词'), 'daily voice line kit should render title');
    assert.ok(voiceLineKit.includes('只读台词卡'), 'daily voice line kit should be non-mutating');
    assert.ok(voiceLineKit.includes('主句:'), 'daily voice line kit should include main line');
    assert.ok(voiceLineKit.includes('短回声:'), 'daily voice line kit should include short echo');
    assert.ok(voiceLineKit.includes('/voice check'), 'daily voice line kit should include voice preflight');
    assert.ok(voiceLineKit.includes('/voice warm'), 'daily voice line kit should include voice warmup command');
    assert.ok(voiceLineKit.includes('/voice test'), 'daily voice line kit should include real voice test');
    assert.ok(voiceLineKit.includes('只有 /voice test 成功 trace 才算'), 'daily voice line kit should preserve real-run boundary');
    const mediaRelay = dailyPulseTest.formatDailyMediaRelay('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(mediaRelay.includes('识图语音每日接力'), 'daily media relay should render title');
    assert.ok(mediaRelay.includes('只读接力卡'), 'daily media relay should be non-mutating');
    assert.ok(mediaRelay.includes('1. 看图位:'), 'daily media relay should include image role');
    assert.ok(mediaRelay.includes('2. 听写位:'), 'daily media relay should include STT role');
    assert.ok(mediaRelay.includes('3. 发声位:'), 'daily media relay should include voice role');
    assert.ok(mediaRelay.includes('4. 验收位:'), 'daily media relay should include verification role');
    assert.ok(mediaRelay.includes('/daily gap'), 'daily media relay should route to media gap');
    assert.ok(mediaRelay.includes('成功 trace 才算'), 'daily media relay should preserve real-run boundary');
    const chatVibe = dailyPulseTest.formatDailyChatVibe('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(chatVibe.includes('每日聊天节奏'), 'daily chat vibe should render title');
    assert.ok(chatVibe.includes('只读真人感卡'), 'daily chat vibe should be non-mutating');
    assert.ok(chatVibe.includes('开场一句:'), 'daily chat vibe should include opener');
    assert.ok(chatVibe.includes('接图:'), 'daily chat vibe should include image reply guidance');
    assert.ok(chatVibe.includes('接语音:'), 'daily chat vibe should include voice reply guidance');
    assert.ok(chatVibe.includes('贴纸分寸:'), 'daily chat vibe should include sticker restraint');
    assert.ok(chatVibe.includes('收住规则:'), 'daily chat vibe should include stop rule');
    assert.ok(chatVibe.includes('多模态是否真跑以 trace 为准'), 'daily chat vibe should preserve truth boundary');
    const personalSummary = dailyPulseTest.formatDailyUserSummary('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(personalSummary.includes('我的每日状态'), 'daily personal summary should render after records');
    assert.ok(personalSummary.includes('今日已到'), 'daily personal summary should show current checkin state');
    assert.ok(personalSummary.includes('今日已完成'), 'daily personal summary should show current challenge state');
    assert.ok(personalSummary.includes('识图语音:'), 'daily personal summary should include multimodal short status after records');
    assert.ok(personalSummary.includes('/daily media'), 'daily personal summary should route to the media companion');
    assert.ok(personalSummary.includes('今天两项都收了'), 'daily personal summary should suggest recap when complete');
    const personalizedRecap = dailyPulseTest.buildDailyRecapMessage('group', 6657, new Date('2026-06-09T12:00:00Z'), 99);
    assert.ok(personalizedRecap.includes('今日收尾状态:'), 'daily recap with user should include personal closing status');
    assert.ok(personalizedRecap.includes('QQ99'), 'daily recap with user should identify the current user');
    assert.ok(personalizedRecap.includes('挑战已完成'), 'daily recap with user should show current challenge completion');
    assert.ok(personalizedRecap.includes('打卡已到'), 'daily recap with user should show current checkin state');
    const actionPlan = dailyPulseTest.formatDailyActionPlan('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(actionPlan.includes('玩机器今日安排'), 'daily action plan should render title');
    assert.ok(actionPlan.includes('日常进度:'), 'daily action plan should summarize checkin and challenge state');
    assert.ok(actionPlan.includes('识图语音:'), 'daily action plan should route users to multimodal daily checklist');
    assert.ok(actionPlan.includes('/media daily'), 'daily action plan should expose media daily entry');
    assert.ok(actionPlan.includes('trace 里的真实记录'), 'daily action plan should preserve real-trace boundary');
    const nudge = dailyPulseTest.formatDailyNudge('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(nudge.includes('玩机器今日催一下'), 'daily nudge should render title');
    assert.ok(nudge.includes('进度:'), 'daily nudge should summarize missing daily items');
    assert.ok(nudge.includes('现在就做:'), 'daily nudge should include an immediate action');
    assert.ok(nudge.includes('不会替你写挑战或打卡'), 'daily nudge should stay read-only');
    const guard = dailyPulseTest.formatDailyStreakGuard('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(guard.includes('每日保连续'), 'daily streak guard should render title');
    assert.ok(guard.includes('风险:'), 'daily streak guard should include risk line');
    assert.ok(guard.includes('现在就补:'), 'daily streak guard should include immediate rescue action');
    assert.ok(guard.includes('识图语音:'), 'daily streak guard should include multimodal short status');
    assert.ok(guard.includes('/daily media'), 'daily streak guard should route to media companion');
    const mediaCompanion = dailyPulseTest.formatDailyMediaCompanion('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(mediaCompanion.includes('识图语音今日陪跑'), 'daily media companion should render title');
    assert.ok(mediaCompanion.includes('看图问法:'), 'daily media companion should include image ask wording');
    assert.ok(mediaCompanion.includes('听写真测:'), 'daily media companion should include STT test action');
    assert.ok(mediaCompanion.includes('发语音短句:'), 'daily media companion should include a TTS-ready line');
    assert.ok(mediaCompanion.includes('/voice check'), 'daily media companion should include voice preflight command');
    assert.ok(mediaCompanion.includes('/voice test'), 'daily media companion should include voice real test command');
    assert.ok(mediaCompanion.includes('check/warm/cache hit 不算'), 'daily media companion should preserve real-run boundary');
    const weekSummary = dailyPulseTest.formatDailyWeekSummary('group', 6657, 99, new Date('2026-06-09T12:00:00Z'));
    assert.ok(weekSummary.includes('我的每日周报'), 'daily weekly summary should render title');
    assert.ok(weekSummary.includes('最近7天'), 'daily weekly summary should expose seven-day window');
    assert.ok(weekSummary.includes('双收'), 'daily weekly summary should count full daily completion');
    assert.ok(weekSummary.includes('本周节奏:'), 'daily weekly summary should include a human-readable rhythm note');
    assert.ok(weekSummary.includes('识图语音:'), 'daily weekly summary should include multimodal short status');
    assert.ok(weekSummary.includes('/daily media'), 'daily weekly summary should route to the media companion');
    assert.ok(weekSummary.includes('日历:'), 'daily weekly summary should render compact calendar');
    assert.ok(weekSummary.includes('旧记录只按已有连续天数回填'), 'daily weekly summary should expose history boundary');

    handler.handleEvent(makePlainEvent(530, 58, '/daily'));
    await waitFor(() => sent.length === 1, 'daily now command');
    assert.ok(firstText(sent[0].message).includes('今日手感'), '/daily should render hand score');
    assert.ok(firstText(sent[0].message).includes('识图语音:'), '/daily should include multimodal short status');
    assert.ok(firstText(sent[0].message).includes('边界'), '/daily should include truth boundary');

    handler.handleEvent(makePlainEvent(531, 58, '/daily recap'));
    await waitFor(() => sent.length === 2, 'daily subscribe command');
    assert.ok(firstText(sent[1].message).includes('玩机器晚间复盘'), '/daily recap should render evening recap card');
    assert.ok(firstText(sent[1].message).includes('今日收尾状态:'), '/daily recap should include personal closing status');
    assert.ok(firstText(sent[1].message).includes('QQ58'), '/daily recap should identify the command user');
    assert.ok(firstText(sent[1].message).includes('识图语音收尾:'), '/daily recap should include multimodal closing status');
    assert.ok(firstText(sent[1].message).includes('睡前小任务'), '/daily recap should include a concrete small task');

    handler.handleEvent(makePlainEvent(532, 58, '/daily checkin'));
    await waitFor(() => sent.length === 3, 'daily subscribe command');
    assert.ok(firstText(sent[2].message).includes('每日打卡'), '/daily checkin should render checkin card');
    assert.ok(firstText(sent[2].message).includes('连续:'), '/daily checkin should show streak counters');
    assert.ok(firstText(sent[2].message).includes('识图语音下一步:'), '/daily checkin should route to media companion');

    handler.handleEvent(makePlainEvent(533, 58, '/daily board'));
    await waitFor(() => sent.length === 4, 'daily status command');
    assert.ok(firstText(sent[3].message).includes('每日打卡榜'), '/daily board should render checkin board');
    assert.ok(firstText(sent[3].message).includes('QQ'), '/daily board should include ranked users');

    handler.handleEvent(makePlainEvent(534, 58, '/daily on 08:15'));
    await waitFor(() => sent.length === 5, 'daily status command');
    assert.ok(firstText(sent[4].message).includes('08:15'), '/daily on should store configured time');

    handler.handleEvent(makePlainEvent(535, 58, '/daily status'));
    await waitFor(() => sent.length === 6, 'daily status command');
    assert.ok(firstText(sent[5].message).includes('当前会话: 已开启 08:15'), '/daily status should show current subscription');
    assert.ok(firstText(sent[5].message).includes('当前会话打卡:'), '/daily status should expose checkin stats');
    assert.ok(firstText(sent[5].message).includes('当前会话挑战完成:'), '/daily status should expose challenge completion stats');
    assert.ok(firstText(sent[5].message).includes('/daily personal'), '/daily status should expose the personalized daily entry');
    assert.ok(firstText(sent[5].message).includes('/daily proof'), '/daily status should expose the evidence ledger entry');
    assert.ok(firstText(sent[5].message).includes('/daily score'), '/daily status should expose the completion score entry');
    assert.ok(firstText(sent[5].message).includes('/daily center'), '/daily status should expose the command center entry');
    assert.ok(firstText(sent[5].message).includes('/daily vibe'), '/daily status should expose the chat vibe entry');
    assert.ok(firstText(sent[5].message).includes('/daily relay'), '/daily status should expose the media relay entry');
    assert.ok(firstText(sent[5].message).includes('/daily gap'), '/daily status should expose the media gap entry');
    assert.ok(firstText(sent[5].message).includes('/daily line'), '/daily status should expose the voice line entry');
    assert.ok(firstText(sent[5].message).includes('/daily squad'), '/daily status should expose the squad summary entry');
    assert.ok(firstText(sent[5].message).includes('/daily ice'), '/daily status should expose the icebreaker entry');
    assert.ok(firstText(sent[5].message).includes('/daily script'), '/daily status should expose the media script entry');
    assert.ok(firstText(sent[5].message).includes('/daily plan'), '/daily status should expose the action plan entry');
    assert.ok(firstText(sent[5].message).includes('/daily guard'), '/daily status should expose the streak guard entry');
    assert.ok(firstText(sent[5].message).includes('/daily media'), '/daily status should expose the media companion entry');
    assert.ok(firstText(sent[5].message).includes('/daily nudge'), '/daily status should expose the nudge entry');

    const dueResult = await dailyPulseTest.runDueDailyPulses(bot, new Date('2026-06-09T01:00:00Z'));
    assert.deepStrictEqual(dueResult, { checked: 1, due: 1, sent: 1, errors: 0 }, 'due daily pulse should send once');
    assert.strictEqual(sent.length, 7, 'due runner should push a daily message');
    assert.ok(sent[6].message.includes('好玩入口'), 'due daily message should include useful entry points');
    assert.ok(sent[6].message.includes('识图语音:'), 'due daily message should include multimodal short status');
    assert.ok(sent[6].message.includes('/daily plan'), 'due daily message should include action plan entry');
    assert.ok(sent[6].message.includes('/daily nudge'), 'due daily message should include nudge entry');

    const duplicateDue = await dailyPulseTest.runDueDailyPulses(bot, new Date('2026-06-09T12:00:00Z'));
    assert.deepStrictEqual(duplicateDue, { checked: 1, due: 0, sent: 0, errors: 0 }, 'daily pulse should not send twice in the same day');

    handler.handleEvent(makePlainEvent(536, 58, '今日状态'));
    await waitFor(() => sent.length === 8, 'natural daily status');
    assert.ok(firstText(sent[7].message).includes('玩机器每日提醒'), 'natural daily status should render card');
    assert.ok(firstText(sent[7].message).includes('识图语音:'), 'natural daily status should include multimodal short status');

    handler.handleEvent(makePlainEvent(537, 58, '今日打卡'));
    await waitFor(() => sent.length === 9, 'natural daily checkin');
    assert.ok(firstText(sent[8].message).includes('每日打卡'), 'natural daily checkin should render checkin card');

    handler.handleEvent(makePlainEvent(538, 58, '打卡榜'));
    await waitFor(() => sent.length === 10, 'natural daily checkin board');
    assert.ok(firstText(sent[9].message).includes('每日打卡榜'), 'natural daily board should render checkin board');

    handler.handleEvent(makePlainEvent(539, 58, '晚安机器'));
    await waitFor(() => sent.length === 11, 'natural daily recap');
    assert.ok(firstText(sent[10].message).includes('玩机器晚间复盘'), 'natural daily recap should render card');
    assert.ok(firstText(sent[10].message).includes('今日收尾状态:'), 'natural daily recap should include personal closing status');
    assert.ok(firstText(sent[10].message).includes('识图语音收尾:'), 'natural daily recap should include multimodal closing status');

    handler.handleEvent(makePlainEvent(540, 58, '关闭每日提醒'));
    await waitFor(() => sent.length === 12, 'natural daily off');
    assert.ok(firstText(sent[11].message).includes('已关闭'), 'natural daily off should remove subscription');

    handler.handleEvent(makePlainEvent(541, 58, '/daily challenge'));
    await waitFor(() => sent.length === 13, 'daily challenge command');
    assert.ok(firstText(sent[12].message).includes('玩机器今日挑战'), '/daily challenge should render challenge card');
    assert.ok(firstText(sent[12].message).includes('签位:'), '/daily challenge should include challenge lane');

    handler.handleEvent(makePlainEvent(542, 58, '今日挑战'));
    await waitFor(() => sent.length === 14, 'natural daily challenge');
    assert.ok(firstText(sent[13].message).includes('玩机器今日挑战'), 'natural daily challenge should render challenge card');

    handler.handleEvent(makePlainEvent(543, 58, '/daily done'));
    await waitFor(() => sent.length === 15, 'daily challenge done command');
    assert.ok(firstText(sent[14].message).includes('今日挑战完成'), '/daily done should render challenge completion card');
    assert.ok(firstText(sent[14].message).includes('挑战连续:'), '/daily done should include completion streak counters');
    assert.ok(firstText(sent[14].message).includes('识图语音下一步:'), '/daily done should route to media companion');

    handler.handleEvent(makePlainEvent(544, 58, '挑战完成'));
    await waitFor(() => sent.length === 16, 'natural daily challenge done');
    assert.ok(firstText(sent[15].message).includes('今日挑战完成'), 'natural challenge done should render completion card');
    assert.ok(firstText(sent[15].message).includes('今天已经记过'), 'natural repeated challenge done should be idempotent');

    handler.handleEvent(makePlainEvent(545, 58, '/daily challenge board'));
    await waitFor(() => sent.length === 17, 'daily challenge board command');
    assert.ok(firstText(sent[16].message).includes('今日挑战榜'), '/daily challenge board should render challenge board');
    assert.ok(firstText(sent[16].message).includes('QQ'), '/daily challenge board should include ranked users');

    handler.handleEvent(makePlainEvent(546, 58, '挑战榜'));
    await waitFor(() => sent.length === 18, 'natural daily challenge board');
    assert.ok(firstText(sent[17].message).includes('今日挑战榜'), 'natural challenge board should render challenge board');

    handler.handleEvent(makePlainEvent(547, 58, '/daily me'));
    await waitFor(() => sent.length === 19, 'daily personal summary command');
    assert.ok(firstText(sent[18].message).includes('我的每日状态'), '/daily me should render personal summary');
    assert.ok(firstText(sent[18].message).includes('打卡:'), '/daily me should include checkin line');
    assert.ok(firstText(sent[18].message).includes('挑战:'), '/daily me should include challenge line');
    assert.ok(firstText(sent[18].message).includes('识图语音:'), '/daily me should include multimodal short status');

    handler.handleEvent(makePlainEvent(548, 58, '我的每日'));
    await waitFor(() => sent.length === 20, 'natural daily personal summary');
    assert.ok(firstText(sent[19].message).includes('我的每日状态'), 'natural personal daily summary should render');

    handler.handleEvent(makePlainEvent(549, 58, '/daily wrap'));
    await waitFor(() => sent.length === 21, 'daily wrap-up command');
    assert.ok(firstText(sent[20].message).includes('今日收工'), '/daily wrap should render wrap-up card');
    assert.ok(firstText(sent[20].message).includes('挑战: 今日已完成'), '/daily wrap should include challenge completion state');
    assert.ok(firstText(sent[20].message).includes('打卡: 今日已到'), '/daily wrap should include checkin state');
    assert.ok(firstText(sent[20].message).includes('识图语音下一步:'), '/daily wrap should route to media companion');

    handler.handleEvent(makePlainEvent(550, 58, '今日收工'));
    await waitFor(() => sent.length === 22, 'natural daily wrap-up');
    assert.ok(firstText(sent[21].message).includes('今日收工'), 'natural daily wrap-up should render wrap-up card');

    handler.handleEvent(makePlainEvent(551, 58, '/daily week'));
    await waitFor(() => sent.length === 23, 'daily weekly summary command');
    assert.ok(firstText(sent[22].message).includes('我的每日周报'), '/daily week should render weekly summary');
    assert.ok(firstText(sent[22].message).includes('最近7天'), '/daily week should include seven-day window');
    assert.ok(firstText(sent[22].message).includes('识图语音:'), '/daily week should include multimodal short status');

    handler.handleEvent(makePlainEvent(552, 58, '本周每日'));
    await waitFor(() => sent.length === 24, 'natural daily weekly summary');
    assert.ok(firstText(sent[23].message).includes('我的每日周报'), 'natural weekly daily summary should render');

    handler.handleEvent(makePlainEvent(553, 58, '/daily plan'));
    await waitFor(() => sent.length === 25, 'daily action plan command');
    assert.ok(firstText(sent[24].message).includes('玩机器今日安排'), '/daily plan should render action plan');
    assert.ok(firstText(sent[24].message).includes('识图语音:'), '/daily plan should include multimodal action line');

    handler.handleEvent(makePlainEvent(554, 58, '今日安排'));
    await waitFor(() => sent.length === 26, 'natural daily action plan');
    assert.ok(firstText(sent[25].message).includes('玩机器今日安排'), 'natural action plan should render');

    handler.handleEvent(makePlainEvent(555, 58, '/daily nudge'));
    await waitFor(() => sent.length === 27, 'daily nudge command');
    assert.ok(firstText(sent[26].message).includes('玩机器今日催一下'), '/daily nudge should render nudge card');
    assert.ok(firstText(sent[26].message).includes('现在就做:'), '/daily nudge should include immediate action');

    handler.handleEvent(makePlainEvent(556, 58, '催我一下'));
    await waitFor(() => sent.length === 28, 'natural daily nudge');
    assert.ok(firstText(sent[27].message).includes('玩机器今日催一下'), 'natural daily nudge should render');

    handler.handleEvent(makePlainEvent(557, 58, '/daily missing'));
    await waitFor(() => sent.length === 29, 'daily missing command alias');
    assert.ok(firstText(sent[28].message).includes('玩机器今日催一下'), '/daily missing should render nudge card');

    handler.handleEvent(makePlainEvent(558, 58, '我今天还差啥'));
    await waitFor(() => sent.length === 30, 'natural daily missing question');
    assert.ok(firstText(sent[29].message).includes('玩机器今日催一下'), 'natural missing daily question should render nudge card');

    handler.handleEvent(makePlainEvent(559, 58, '/daily media'));
    await waitFor(() => sent.length === 31, 'daily media companion command');
    assert.ok(firstText(sent[30].message).includes('识图语音今日陪跑'), '/daily media should render media companion');
    assert.ok(firstText(sent[30].message).includes('看图问法:'), '/daily media should include image ask wording');
    assert.ok(firstText(sent[30].message).includes('/voice test'), '/daily media should include voice test command');

    handler.handleEvent(makePlainEvent(560, 58, '/daily voice'));
    await waitFor(() => sent.length === 32, 'daily voice companion alias');
    assert.ok(firstText(sent[31].message).includes('识图语音今日陪跑'), '/daily voice should route to media companion');

    handler.handleEvent(makePlainEvent(561, 58, '今日语音句'));
    await waitFor(() => sent.length === 33, 'natural daily voice line kit');
    assert.ok(firstText(sent[32].message).includes('每日语音台词'), 'natural daily voice line kit should render');
    assert.ok(firstText(sent[32].message).includes('主句:'), 'natural daily voice line kit should include main line');

    handler.handleEvent(makePlainEvent(562, 58, '/daily guard'));
    await waitFor(() => sent.length === 34, 'daily streak guard command');
    assert.ok(firstText(sent[33].message).includes('每日保连续'), '/daily guard should render streak guard card');
    assert.ok(firstText(sent[33].message).includes('现在就补:'), '/daily guard should include immediate rescue action');

    handler.handleEvent(makePlainEvent(563, 58, '保连续'));
    await waitFor(() => sent.length === 35, 'natural daily streak guard');
    assert.ok(firstText(sent[34].message).includes('每日保连续'), 'natural streak guard should render card');
    assert.ok(firstText(sent[34].message).includes('识图语音:'), 'natural streak guard should include multimodal short status');

    handler.handleEvent(makePlainEvent(564, 58, '/daily squad'));
    await waitFor(() => sent.length === 36, 'daily squad summary command');
    assert.ok(firstText(sent[35].message).includes('每日队形'), '/daily squad should render squad summary');
    assert.ok(firstText(sent[35].message).includes('今日挑战:'), '/daily squad should include challenge count line');
    assert.ok(firstText(sent[35].message).includes('今日打卡:'), '/daily squad should include checkin count line');
    assert.ok(firstText(sent[35].message).includes('识图语音:'), '/daily squad should include multimodal short status');

    handler.handleEvent(makePlainEvent(565, 58, '今日队形'));
    await waitFor(() => sent.length === 37, 'natural daily squad summary');
    assert.ok(firstText(sent[36].message).includes('每日队形'), 'natural daily squad summary should render');
    assert.ok(firstText(sent[36].message).includes('下一步:'), 'natural daily squad summary should include next action');

    handler.handleEvent(makePlainEvent(566, 58, '/daily ice'));
    await waitFor(() => sent.length === 38, 'daily icebreaker command');
    assert.ok(firstText(sent[37].message).includes('每日破冰话题'), '/daily ice should render icebreaker');
    assert.ok(firstText(sent[37].message).includes('群话题:'), '/daily ice should include group topic');
    assert.ok(firstText(sent[37].message).includes('语音接力:'), '/daily ice should include voice relay');

    handler.handleEvent(makePlainEvent(567, 58, '今日话题'));
    await waitFor(() => sent.length === 39, 'natural daily icebreaker');
    assert.ok(firstText(sent[38].message).includes('每日破冰话题'), 'natural daily icebreaker should render');
    assert.ok(firstText(sent[38].message).includes('看图接力:'), 'natural daily icebreaker should include image relay');

    handler.handleEvent(makePlainEvent(568, 58, '/daily script'));
    await waitFor(() => sent.length === 40, 'daily media script command');
    assert.ok(firstText(sent[39].message).includes('识图语音每日脚本包'), '/daily script should render media script');
    assert.ok(firstText(sent[39].message).includes('验收脚本:'), '/daily script should include verification script');
    assert.ok(firstText(sent[39].message).includes('群里回执:'), '/daily script should include group receipt');

    handler.handleEvent(makePlainEvent(569, 58, '识图语音脚本包'));
    await waitFor(() => sent.length === 41, 'natural daily media script');
    assert.ok(firstText(sent[40].message).includes('识图语音每日脚本包'), 'natural daily media script should render');
    assert.ok(firstText(sent[40].message).includes('看图脚本:'), 'natural daily media script should include image script');

    handler.handleEvent(makePlainEvent(570, 58, '/daily center'));
    await waitFor(() => sent.length === 42, 'daily command center command');
    assert.ok(firstText(sent[41].message).includes('今日指挥台'), '/daily center should render command center');
    assert.ok(firstText(sent[41].message).includes('现在先做:'), '/daily center should include immediate next action');
    assert.ok(firstText(sent[41].message).includes('群里带一下:'), '/daily center should include group action');

    handler.handleEvent(makePlainEvent(571, 58, '今日指挥台'));
    await waitFor(() => sent.length === 43, 'natural daily command center');
    assert.ok(firstText(sent[42].message).includes('今日指挥台'), 'natural daily command center should render');
    assert.ok(firstText(sent[42].message).includes('识图语音:'), 'natural daily command center should include multimodal status');

    handler.handleEvent(makePlainEvent(572, 58, '/daily gap'));
    await waitFor(() => sent.length === 44, 'daily media gap command');
    assert.ok(firstText(sent[43].message).includes('识图语音今日补缺'), '/daily gap should render media gap');
    assert.ok(firstText(sent[43].message).includes('优先补:'), '/daily gap should include priority action');
    assert.ok(firstText(sent[43].message).includes('最近识图:'), '/daily gap should include trace summary');

    handler.handleEvent(makePlainEvent(573, 58, '识图语音缺啥'));
    await waitFor(() => sent.length === 45, 'natural daily media gap');
    assert.ok(firstText(sent[44].message).includes('识图语音今日补缺'), 'natural daily media gap should render');
    assert.ok(firstText(sent[44].message).includes('缺口:'), 'natural daily media gap should include missing line');

    handler.handleEvent(makePlainEvent(574, 58, '/daily line'));
    await waitFor(() => sent.length === 46, 'daily voice line kit command');
    assert.ok(firstText(sent[45].message).includes('每日语音台词'), '/daily line should render voice line kit');
    assert.ok(firstText(sent[45].message).includes('/voice test'), '/daily line should include real voice test command');

    handler.handleEvent(makePlainEvent(575, 58, '/daily relay'));
    await waitFor(() => sent.length === 47, 'daily media relay command');
    assert.ok(firstText(sent[46].message).includes('识图语音每日接力'), '/daily relay should render media relay');
    assert.ok(firstText(sent[46].message).includes('看图位'), '/daily relay should include image relay role');

    handler.handleEvent(makePlainEvent(576, 58, '今日接力'));
    await waitFor(() => sent.length === 48, 'natural daily media relay');
    assert.ok(firstText(sent[47].message).includes('识图语音每日接力'), 'natural daily media relay should render');
    assert.ok(firstText(sent[47].message).includes('验收位'), 'natural daily media relay should include verification role');

    handler.handleEvent(makePlainEvent(577, 58, '/daily vibe'));
    await waitFor(() => sent.length === 49, 'daily chat vibe command');
    assert.ok(firstText(sent[48].message).includes('每日聊天节奏'), '/daily vibe should render chat vibe');
    assert.ok(firstText(sent[48].message).includes('贴纸分寸:'), '/daily vibe should include sticker restraint');

    handler.handleEvent(makePlainEvent(578, 58, '今日语气'));
    await waitFor(() => sent.length === 50, 'natural daily chat vibe');
    assert.ok(firstText(sent[49].message).includes('每日聊天节奏'), 'natural daily chat vibe should render');
    assert.ok(firstText(sent[49].message).includes('接语音:'), 'natural daily chat vibe should include voice guidance');

    handler.handleEvent(makePlainEvent(579, 58, '/daily score'));
    await waitFor(() => sent.length === 51, 'daily completion score command');
    assert.ok(firstText(sent[50].message).includes('今日闭环分'), '/daily score should render completion score');
    assert.ok(firstText(sent[50].message).includes('一分钟补法:'), '/daily score should include rescue action');

    handler.handleEvent(makePlainEvent(580, 58, '今日完成度'));
    await waitFor(() => sent.length === 52, 'natural daily completion score');
    assert.ok(firstText(sent[51].message).includes('今日闭环分'), 'natural daily completion score should render');
    assert.ok(firstText(sent[51].message).includes('缺口:'), 'natural daily completion score should include missing line');

    handler.handleEvent(makePlainEvent(581, 99, '/daily personal'));
    await waitFor(() => sent.length === 53, 'daily personalized profile command');
    assert.ok(firstText(sent[52].message).includes('每日偏好卡'), '/daily personal should render personalized daily card');
    assert.ok(firstText(sent[52].message).includes('偏好地图: Inferno'), '/daily personal should include saved map preference');

    handler.handleEvent(makePlainEvent(582, 99, '我的画像'));
    await waitFor(() => sent.length === 54, 'natural daily personalized profile card');
    assert.ok(firstText(sent[53].message).includes('每日偏好卡'), 'natural daily personalized profile card should render');
    assert.ok(firstText(sent[53].message).includes('画像边界:'), 'natural daily personalized profile card should include profile boundary');

    handler.handleEvent(makePlainEvent(583, 99, '/daily proof'));
    await waitFor(() => sent.length === 55, 'daily evidence ledger command');
    assert.ok(firstText(sent[54].message).includes('今日证据账本'), '/daily proof should render evidence ledger');
    assert.ok(firstText(sent[54].message).includes('不能证明:'), '/daily proof should include non-evidence boundaries');

    handler.handleEvent(makePlainEvent(584, 99, '今天跑没跑'));
    await waitFor(() => sent.length === 56, 'natural daily evidence ledger');
    assert.ok(firstText(sent[55].message).includes('今日证据账本'), 'natural daily evidence ledger should render');
    assert.ok(firstText(sent[55].message).includes('现在取证:'), 'natural daily evidence ledger should include next evidence action');
  } finally {
    dailyPulseTest.resetForTests();
    userProfile.__test.setStorePathForTests();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    if (fs.existsSync(profileStorePath)) fs.unlinkSync(profileStorePath);
  }
}

async function testFunCsPlayer() {
  const config = makeConfigForHandler();
  const trainingStorePath = path.resolve(__dirname, '..', 'data', `cs-training-smoke-${Date.now()}.json`);
  const profileStorePath = path.resolve(__dirname, '..', 'data', `cs-profile-smoke-${Date.now()}.json`);
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(50_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(funPlugin);
  funTest.__setTrainingStorePathForTests(trainingStorePath);
  userProfile.__test.setStorePathForTests(profileStorePath);
  funTest.__setImageResolverForTests(async () => 'data:image/jpeg;base64,/9j/2w==');
  funTest.__setImageSourceResolversForTests({
    player: async (player) => `https://example.com/player-${encodeURIComponent(player)}.jpg`,
    team: async (_page, teamName) => `https://example.com/team-${encodeURIComponent(teamName)}.png`,
    fandom: async (filename) => `https://example.com/fandom-${encodeURIComponent(filename)}.png`,
  });

  try {
    const player = funTest.dailyPlayerFor(61, 6657);
    assert.ok(funTest.csPlayers.every((item) => item.image), 'all daily CS players should have image URLs');
    assert.ok(funTest.csPlayers.every((item) => item.imageSource), 'all daily CS players should have image source labels');
    const directMessage = await funTest.buildCsPlayerMessage(61, player, funTest.dailyPlayerScore(61, 6657));
    assert.ok(directMessage.some((seg) => seg.type === 'at'), 'daily player direct builder should at the user');
    assert.ok(directMessage.some((seg) => seg.type === 'text' && seg.data.text.includes(player.nick)), 'daily player text should include nick');
    const imageSeg = directMessage.find((seg) => seg.type === 'image');
    assert.ok(imageSeg, 'daily player should include an image segment');
    assert.ok(imageSeg.data.file.startsWith('base64://'), 'daily player image should be sent as base64');
    assert.strictEqual(funTest.dailyPlayerFor(61, 6657).nick, funTest.dailyPlayerFor(61, 6657).nick, 'daily player should be stable per group and day');
    assert.strictEqual(funTest.isCsPlayerDrawRequest(null, '今天抽个CS选手'), true, 'fuzzy draw text should trigger');
    assert.strictEqual(funTest.isCsPlayerDrawRequest(null, 'NiKo 现在在哪队'), false, 'normal player lookup should not be hijacked by draw');
    assert.strictEqual(funTest.isCsPlayerStatusRequest('csplayer', ['status'], '/csplayer status'), true, 'csplayer status should be recognized');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天抽个CS队伍', 'team'), true, 'fuzzy daily team should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天抽个CS地图', 'map'), true, 'fuzzy daily map should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天用什么枪', 'weapon'), true, 'fuzzy daily weapon should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天打什么位', 'role'), true, 'fuzzy daily role should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天丢什么道具', 'utility'), true, 'fuzzy daily utility should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天打什么战术', 'tactic'), true, 'fuzzy daily tactic should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今天残局怎么打', 'clutch'), true, 'fuzzy daily clutch should trigger');
    assert.strictEqual(funTest.isDailyCardRequest(null, '今日cs', 'loadout'), true, 'short daily CS text should trigger loadout');
    assert.strictEqual(funTest.isCsTrainingRequest(null, '今天怎么练枪'), true, 'fuzzy daily CS training should trigger');
    assert.strictEqual(funTest.isCsTrainingRequest(null, '训练语音'), false, 'voice training should not be hijacked by CS training');
    assert.strictEqual(funTest.isCsQuizRequest('csquiz', '/csquiz'), true, 'csquiz command should be recognized');
    assert.strictEqual(funTest.isCsQuizRequest(null, '今天考我CS'), true, 'fuzzy daily CS quiz should trigger');
    const parsedTraining = funTest.parseTrainingLogInput(['35', 'Mirage', 'AK', '急停']);
    assert.strictEqual(parsedTraining.area, 'aim', 'training log parser should infer aim practice');
    assert.strictEqual(parsedTraining.minutes, 35, 'training log parser should extract minutes');
    assert.strictEqual(parsedTraining.map, 'Mirage', 'training log parser should extract map');
    assert.strictEqual(parsedTraining.weapon, 'AK-47', 'training log parser should extract weapon');
    const weaknessKeys = funTest.detectTrainingWeaknesses('Mirage 死亡8次，补枪距离太远，烟闪忘了');
    assert.ok(weaknessKeys.includes('death'), 'training log weakness parser should detect death issues');
    assert.ok(weaknessKeys.includes('trade'), 'training log weakness parser should detect trade issues');
    assert.ok(weaknessKeys.includes('utility'), 'training log weakness parser should detect utility issues');
    const analyzedTraining = funTest.analyzeTrainingLogInput(['Mirage', '死亡8次，补枪距离太远，烟闪忘了']);
    assert.ok(analyzedTraining, 'training analyzer should parse text logs');
    assert.ok(analyzedTraining.weaknesses.includes('death'), 'training analyzer should keep detected weaknesses');
    assert.ok(funTest.formatCsTrainingAnalysis(analyzedTraining).includes('真话边界'), 'training analyzer should expose truth boundary');
    const quizMessage = funTest.buildCsQuizMessage(61, 6657, false);
    const quizText = firstText(quizMessage);
    const quiz = funTest.dailyCsQuizFor(61, 6657);
    const correctLabel = String.fromCharCode(65 + quiz.correctOptionIndex);
    assert.ok(quiz.correctOptionIndex >= 0 && quiz.correctOptionIndex < quiz.options.length, 'daily CS quiz should track the correct shuffled option');
    assert.ok(quiz.answer.includes(`选 ${correctLabel}`), 'daily CS quiz answer should reference the shuffled correct option label');
    const shuffledUser = Array.from({ length: 160 }, (_, index) => index + 1)
      .find((userId) => funTest.dailyCsQuizFor(userId, 6657).correctOptionIndex !== 0);
    assert.ok(shuffledUser, 'daily CS quiz should not keep the correct option pinned to A for every user');
    const wrongIndex = quiz.options.findIndex((_option, index) => index !== quiz.correctOptionIndex);
    const wrongLabel = String.fromCharCode(65 + wrongIndex);
    assert.ok(funTest.formatCsQuizAnswer(61, 6657, [correctLabel]).includes('结果：对了'), 'daily CS quiz answer formatter should score correct choices');
    assert.ok(funTest.formatCsQuizAnswer(61, 6657, [wrongLabel]).includes('结果：不对'), 'daily CS quiz answer formatter should score wrong choices');
    assert.strictEqual(funTest.parseCsQuizAnswerArgs(['answer', correctLabel]), quiz.correctOptionIndex, 'daily CS quiz answer parser should accept answer subcommand');
    assert.strictEqual(funTest.parseCsQuizAnswerArgs(['banana']), null, 'daily CS quiz answer parser should avoid accidental a/b/c matches inside words');
    assert.ok(quizMessage.some((seg) => seg.type === 'at'), 'daily CS quiz should at the user');
    assert.ok(quizText.includes('今日CS小考'), 'daily CS quiz should include title');
    assert.ok(quizText.includes('题目：'), 'daily CS quiz should include question');
    assert.ok(quizText.includes('选项：'), 'daily CS quiz should include options');
    assert.ok(quizText.includes('参考判断：'), 'daily CS quiz should include reference answer');
    assert.ok(quizText.includes('/csquiz answer A/B/C'), 'daily CS quiz should tell users how to answer interactively');
    assert.ok(!quizText.includes(quiz.answer), 'daily CS quiz prompt should not reveal the full shuffled answer before scoring');
    assert.ok(quizText.includes('真话边界'), 'daily CS quiz should expose source boundary');
    assert.ok(quizMessage.some((seg) => seg.type === 'image' && seg.data.file.startsWith('base64://')), 'daily CS quiz should include local card image');
    const trainingMessage = funTest.buildCsTrainingMessage(61, 6657, false);
    assert.ok(trainingMessage.some((seg) => seg.type === 'at'), 'daily CS training should at the user');
    assert.ok(trainingMessage.some((seg) => seg.type === 'text' && seg.data.text.includes('今日CS训练')), 'daily CS training should include title');
    assert.ok(trainingMessage.some((seg) => seg.type === 'text' && seg.data.text.includes('真话边界')), 'daily CS training should expose source boundary');
    assert.ok(trainingMessage.some((seg) => seg.type === 'image' && seg.data.file.startsWith('base64://')), 'daily CS training should include local card image');
    const profileCtx = {
      chatType: 'group',
      chatId: 6657,
      event: { user_id: 74, sender: { card: 'profile-smoke', nickname: 'profile-smoke' } },
      args: [],
    };
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'map', 'Inferno'] });
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'player', 'donk'] });
    userProfile.handleUserProfileCommand({ ...profileCtx, args: ['set', 'team', 'Vitality'] });
    assert.ok(userProfile.__test.buildUserProfileDailyCsHint('group', 6657, 74).includes('偏好地图: Inferno'), 'profile daily CS hint should include preferred map');

    handler.handleEvent(makePlainEvent(601, 61, '/csplayer'));
    await waitFor(() => sent.length === 1, 'csplayer command');
    assert.strictEqual(sent[0].message[0]?.type, 'at', 'csplayer should at the drawer');
    const text = sent[0].message.find((seg) => seg.type === 'text')?.data.text || '';
    assert.ok(text.includes('今日CS选手'), 'csplayer reply should include title');
    assert.ok(text.includes('今天打法：'), 'csplayer reply should include playstyle line');
    assert.ok(text.includes('别急点：'), 'csplayer reply should include avoid line');
    assert.ok(text.includes('签位：'), 'csplayer reply should include score label');
    assert.ok(sent[0].message.some((seg) => seg.type === 'image' && seg.data.file.startsWith('base64://')), 'csplayer should include base64 image');

    handler.handleEvent(makePlainEvent(613, 73, '/csplayer status'));
    await waitFor(() => sent.length === 2, 'csplayer status command');
    assert.ok(firstText(sent[1].message).includes('每日CS选手状态'), 'csplayer status should render status header');

  handler.handleEvent(makePlainEvent(602, 62, '今天抽个CS选手'));
  await waitFor(() => sent.length === 3, 'fuzzy csplayer command');
  assert.ok(sent[2].message.some((seg) => seg.type === 'image'), 'fuzzy csplayer should also include image');

  handler.handleEvent(makeEvent(603, 63, ' 今天抽个CS选手'));
  await waitFor(() => sent.length === 4, 'at fuzzy csplayer command');
  assert.ok(sent[3].message.some((seg) => seg.type === 'image'), 'at fuzzy csplayer should be handled by fun plugin');

  handler.handleEvent(makePlainEvent(604, 64, '/csteam'));
  await waitFor(() => sent.length === 5, 'daily team command');
  assert.ok(firstText(sent[4].message).includes('今日CS队伍'), 'daily team should include title');
  assert.ok(sent[4].message.some((seg) => seg.type === 'image'), 'daily team should include team image');

  handler.handleEvent(makePlainEvent(605, 65, '今天抽个CS地图'));
  await waitFor(() => sent.length === 6, 'daily map fuzzy');
  assert.ok(firstText(sent[5].message).includes('今日CS地图'), 'daily map should include title');
  assert.ok(sent[5].message.some((seg) => seg.type === 'image'), 'daily map should include image');

  handler.handleEvent(makePlainEvent(606, 66, '/csweapon'));
  await waitFor(() => sent.length === 7, 'daily weapon command');
  assert.ok(firstText(sent[6].message).includes('今日CS武器'), 'daily weapon should include title');
  assert.ok(sent[6].message.some((seg) => seg.type === 'image'), 'daily weapon should include image');

  handler.handleEvent(makePlainEvent(607, 67, '今日定位'));
  await waitFor(() => sent.length === 8, 'daily role fuzzy');
  assert.ok(firstText(sent[7].message).includes('今日CS定位'), 'daily role should include title');
  assert.ok(sent[7].message.some((seg) => seg.type === 'image'), 'daily role should include image');

  handler.handleEvent(makePlainEvent(608, 68, '/csutility'));
  await waitFor(() => sent.length === 9, 'daily utility command');
  assert.ok(firstText(sent[8].message).includes('今日CS道具'), 'daily utility should include title');
  assert.ok(sent[8].message.some((seg) => seg.type === 'image'), 'daily utility should include image');

  handler.handleEvent(makePlainEvent(609, 69, '今天打什么战术'));
  await waitFor(() => sent.length === 10, 'daily tactic fuzzy');
  assert.ok(firstText(sent[9].message).includes('今日CS战术'), 'daily tactic should include title');
  assert.ok(sent[9].message.some((seg) => seg.type === 'image'), 'daily tactic should include image');

  handler.handleEvent(makePlainEvent(610, 70, '今天残局怎么打'));
  await waitFor(() => sent.length === 11, 'daily clutch fuzzy');
  assert.ok(firstText(sent[10].message).includes('今日CS残局'), 'daily clutch should include title');
  assert.ok(sent[10].message.some((seg) => seg.type === 'image'), 'daily clutch should include image');

  handler.handleEvent(makePlainEvent(611, 71, '/csloadout'));
  await waitFor(() => sent.length === 12, 'daily loadout command');
  assert.ok(firstText(sent[11].message).includes('今日CS套餐'), 'daily loadout should include title');
  assert.ok(sent[11].message.some((seg) => seg.type === 'image'), 'daily loadout should include image');

  handler.handleEvent(makePlainEvent(612, 72, '今日cs'));
  await waitFor(() => sent.length === 13, 'short daily cs fuzzy');
  assert.ok(firstText(sent[12].message).includes('今日CS套餐'), 'short daily CS should trigger loadout');
  assert.ok(sent[12].message.some((seg) => seg.type === 'image'), 'short daily CS should include image');

  handler.handleEvent(makePlainEvent(614, 74, '/cstrain'));
  await waitFor(() => sent.length === 14, 'daily CS training command');
  const profileTrainingText = firstText(sent[13].message);
  assert.ok(profileTrainingText.includes('今日CS训练'), 'daily CS training should include title');
  assert.ok(profileTrainingText.includes('真话边界'), 'daily CS training should include truth boundary');
  assert.ok(profileTrainingText.includes('画像偏好'), 'daily CS training should include self-filled profile hint when present');
  assert.ok(profileTrainingText.includes('偏好地图: Inferno'), 'daily CS training should include preferred map hint');
  assert.ok(profileTrainingText.includes('偏好选手: donk'), 'daily CS training should include preferred player hint');
  assert.ok(profileTrainingText.includes('偏好队伍: Vitality'), 'daily CS training should include preferred team hint');
  assert.ok(profileTrainingText.includes('不是实时赛事事实'), 'daily CS profile hint should preserve factual boundary');
  assert.ok(sent[13].message.some((seg) => seg.type === 'image'), 'daily CS training should include local card image');

  handler.handleEvent(makePlainEvent(615, 75, '今天怎么练枪'));
  await waitFor(() => sent.length === 15, 'daily CS training fuzzy');
  assert.ok(firstText(sent[14].message).includes('今日CS训练'), 'daily CS training fuzzy should include title');

  handler.handleEvent(makePlainEvent(616, 76, '/scene 白给'));
  await waitFor(() => sent.length === 16, 'scene template command');
  assert.ok(firstText(sent[15].message).includes('直播场景'), 'scene command should render a scene template');
  assert.ok(firstText(sent[15].message).includes('触发：'), 'scene command should include trigger guidance');
  assert.ok(firstText(sent[15].message).includes('反应：'), 'scene command should include reaction guidance');
  assert.ok(firstText(sent[15].message).includes('短句：'), 'scene command should include short reusable lines');
  assert.ok(firstText(sent[15].message).includes('禁用：'), 'scene command should include safety boundary');
  assert.ok(firstText(sent[15].message).includes('逐字原话'), 'scene command should remind not to use verbatim quotes');

  handler.handleEvent(makePlainEvent(617, 77, '/cstrain analyze Mirage 死亡8次 补枪距离太远 没闪'));
  await waitFor(() => sent.length === 17, 'cstrain analyze command');
  assert.ok(firstText(sent[16].message).includes('CS训练日志分析'), 'cstrain analyze should render analysis');
  assert.ok(firstText(sent[16].message).includes('日志'), 'cstrain analyze should explain text-log analysis');
  assert.strictEqual(funTest.loadTrainingStore().logs.length, 0, 'cstrain analyze should not persist a log');

  handler.handleEvent(makePlainEvent(617, 77, '/cstrain log 35 Mirage AK 急停'));
  await waitFor(() => sent.length === 18, 'cstrain log command');
  assert.ok(firstText(sent[17].message).includes('训练记上了'), 'cstrain log should confirm saved training');
  assert.strictEqual(funTest.loadTrainingStore().logs.length, 1, 'training store should persist one log');

  handler.handleEvent(makePlainEvent(618, 77, '/cstrain stats'));
  await waitFor(() => sent.length === 19, 'cstrain stats command');
  assert.ok(firstText(sent[18].message).includes('CS训练记录'), 'cstrain stats should render training history');
  assert.ok(firstText(sent[18].message).includes('练枪35m'), 'cstrain stats should summarize aim minutes');
  assert.ok(firstText(sent[18].message).includes('日志短板'), 'cstrain stats should summarize detected log weaknesses');

  handler.handleEvent(makePlainEvent(619, 77, '/cstrain'));
  await waitFor(() => sent.length === 20, 'history-personalized cstrain command');
  assert.ok(firstText(sent[19].message).includes('训练历史'), 'cstrain should include personal training history when logs exist');
  assert.ok(firstText(sent[19].message).includes('个人短板'), 'cstrain should include historical weakness advice');
  assert.ok(firstText(sent[19].message).includes('日志短板'), 'cstrain should include text-log weakness hints');

  handler.handleEvent(makePlainEvent(620, 77, '/cstrain clear'));
  await waitFor(() => sent.length === 21, 'cstrain clear command');
  assert.ok(firstText(sent[20].message).includes('训练记录清掉了：1条'), 'cstrain clear should remove current user logs');
  assert.ok(funTest.formatCsTrainingStats('group', 6657, 77).includes('还没有记录'), 'training stats should be empty after clear');

  handler.handleEvent(makePlainEvent(621, 78, '/csquiz'));
  await waitFor(() => sent.length === 22, 'daily CS quiz command');
  assert.ok(firstText(sent[21].message).includes('今日CS小考'), 'daily CS quiz command should include title');
  assert.ok(firstText(sent[21].message).includes('参考判断：'), 'daily CS quiz command should include reference answer');
  assert.ok(firstText(sent[21].message).includes('真话边界'), 'daily CS quiz command should include truth boundary');
  assert.ok(sent[21].message.some((seg) => seg.type === 'image'), 'daily CS quiz command should include local card image');

  const commandQuiz = funTest.dailyCsQuizFor(78, 6657);
  const commandCorrectLabel = String.fromCharCode(65 + commandQuiz.correctOptionIndex);
  handler.handleEvent(makePlainEvent(623, 78, `/csquiz answer ${commandCorrectLabel}`));
  await waitFor(() => sent.length === 23, 'daily CS quiz answer command');
  assert.ok(firstText(sent[22].message).includes('今日CS小考判分'), 'daily CS quiz answer should render scoring panel');
  assert.ok(firstText(sent[22].message).includes('结果：对了'), 'daily CS quiz answer should score the submitted option');
  assert.ok(firstText(sent[22].message).includes('正确参考：'), 'daily CS quiz answer should reveal the reference option after scoring');
  assert.ok(firstText(sent[22].message).includes('真话边界'), 'daily CS quiz answer should keep truth boundary');

  handler.handleEvent(makePlainEvent(622, 79, '今天考我CS'));
  await waitFor(() => sent.length === 24, 'daily CS quiz fuzzy');
  assert.ok(firstText(sent[23].message).includes('今日CS小考'), 'daily CS quiz fuzzy should include title');
  } finally {
    funTest.__setImageResolverForTests();
    funTest.__setImageSourceResolversForTests();
    funTest.__setTrainingStorePathForTests();
    userProfile.__test.setStorePathForTests();
    if (fs.existsSync(trainingStorePath)) fs.unlinkSync(trainingStorePath);
    if (fs.existsSync(profileStorePath)) fs.unlinkSync(profileStorePath);
  }
}

async function testCsPluginAndGiftThanks() {
  hltv.clearHltvCache();
  const config = makeConfigForHandler();
  const replies = [];
  const ctxBase = {
    bot: { getConfig: () => config },
    event: { user_id: 2, self_id: 3853043835 },
    reply: (message) => replies.push(message),
    replyAt: (message) => replies.push(message),
    isPrivate: false,
    rawText: '',
    args: [],
  };

  const statusHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['status'],
    rawText: '/cs status',
  });
  assert.strictEqual(statusHandled, true, '/cs status should be handled by cs plugin');
  assert.ok(String(replies.at(-1)).includes('CS实时数据状态'), '/cs status should render data status');
  assert.ok(String(replies.at(-1)).includes('命中0/0'), '/cs status should include cache hit counters');
  assert.ok(String(replies.at(-1)).includes('https://api.csapi.de'), '/cs status should expose the primary realtime source link');
  assert.ok(String(replies.at(-1)).includes('事实类型覆盖:'), '/cs status should expose typed CS fact coverage');
  assert.ok(String(replies.at(-1)).includes('当前排名: ranking=miss'), '/cs status should show ranking miss when cache is empty');
  assert.ok(String(replies.at(-1)).includes('阵容/转会: 按队伍目标核验'), '/cs status should keep roster coverage target-scoped');
  assert.strictEqual(
    hltv.getCsProfileCacheKey('team', 'Vitality 最新阵容 排名'),
    hltv.getCsProfileCacheKey('team', 'Vitality'),
    'team profile cache key should ignore realtime intent words',
  );
  assert.strictEqual(
    hltv.getCsProfileCacheKey('player', 'donk 最近状态 stats'),
    hltv.getCsProfileCacheKey('player', 'donk'),
    'player profile cache key should ignore realtime intent words',
  );
  hltv.__test.setCacheEntryForTests(
    'ranking',
    [
      '来源：CS API / VRS排名镜像 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '#1 Vitality 2100分',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 12_000, source: 'test-fresh-ranking', fetchMs: 23 },
  );
  const cachedRanking = await hltv.fetchTeamRanking();
  assert.ok(cachedRanking.includes('缓存: ranking fresh'), 'fresh cached CS data should include cache evidence');
  assert.ok(cachedRanking.includes('source=test-fresh-ranking'), 'cache evidence should include data source');
  assert.ok(hltv.withHltvCacheEvidence(cachedRanking, 'ranking').match(/缓存: ranking/g).length === 1, 'cache evidence should not duplicate');

  hltv.__test.setCacheEntryForTests(
    'matches',
    [
      '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
      '⏰ 今天 20:00  Vitality vs NAVI Bo3 (Smoke Cup)',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 7_000, source: 'test-warm-matches', fetchMs: 17 },
  );
  hltv.__test.setCacheEntryForTests(
    'results',
    [
      '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- 2026-06-08 NAVI 2:0 Vitality BO3 (Smoke Cup) 胜者:NAVI matchid=2390001 ranks=#1/#2 [Mirage 13-8, Nuke 13-9]',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 6_000, source: 'test-warm-results', fetchMs: 21 },
  );
  const todayCheckStatsBefore = hltv.getHltvStats();
  const todayCheckHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['today', 'check'],
    rawText: '/cs today check',
  });
  assert.strictEqual(todayCheckHandled, true, '/cs today check should be handled by cs plugin');
  const todayCheckText = String(replies.at(-1));
  assert.ok(todayCheckText.includes('CS今日数据预检'), '/cs today check should render today data preflight');
  assert.ok(todayCheckText.includes('赛程/正在打 [matches]: fresh'), '/cs today check should show fresh matches cache');
  assert.ok(todayCheckText.includes('最近赛果 [results]: fresh'), '/cs today check should show fresh results cache');
  assert.ok(todayCheckText.includes('排名快照 [ranking]: fresh'), '/cs today check should show fresh ranking cache');
  assert.ok(todayCheckText.includes('可直接 /cs brief'), '/cs today check should advise direct brief when core cache is fresh');
  assert.ok(todayCheckText.includes('只读预检，不请求外站'), '/cs today check should clarify read-only behavior');
  const todayCheckStatsAfter = hltv.getHltvStats();
  assert.strictEqual(todayCheckStatsAfter.hits, todayCheckStatsBefore.hits, '/cs today check should not increment cache hits');
  assert.strictEqual(todayCheckStatsAfter.misses, todayCheckStatsBefore.misses, '/cs today check should not increment cache misses');

  const intentStatsBefore = hltv.getHltvStats();
  const intentRankingHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['intent', '现在排名'],
    rawText: '/cs intent 现在排名',
  });
  assert.strictEqual(intentRankingHandled, true, '/cs intent should be handled by cs plugin');
  const intentRankingText = String(replies.at(-1));
  assert.ok(intentRankingText.includes('CS实时意图预检'), '/cs intent should render intent preflight');
  assert.ok(intentRankingText.includes('只读，不请求外站'), '/cs intent should clarify read-only behavior');
  assert.ok(intentRankingText.includes('路由: 自然问法 -> ranking'), '/cs intent should show natural ranking route');
  assert.ok(intentRankingText.includes('预计命令: /cs ranking'), '/cs intent should show predicted command');
  assert.ok(intentRankingText.includes('战队排名 [ranking]: fresh'), '/cs intent should expose fresh ranking cache target');

  const intentPlayerHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['intent', 'donk最近状态怎么样'],
    rawText: '/cs intent donk最近状态怎么样',
  });
  assert.strictEqual(intentPlayerHandled, true, '/cs intent player should be handled by cs plugin');
  const intentPlayerText = String(replies.at(-1));
  assert.ok(intentPlayerText.includes('路由: 自然问法 -> player (donk)'), '/cs intent should show player route and subject');
  assert.ok(intentPlayerText.includes('选手统计 donk [player:donk]: miss'), '/cs intent should expose player cache miss without fetching');
  assert.ok(intentPlayerText.includes('/cs warm plan player donk'), '/cs intent player miss should suggest targeted player prewarm plan');
  assert.ok(intentPlayerText.includes('/cs warm player donk'), '/cs intent player miss should suggest targeted player prewarm');
  assert.ok(intentPlayerText.includes('不能反推'), '/cs intent should explain miss boundary');

  const intentMatchHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['intent', '2390997这场谁C了'],
    rawText: '/cs intent 2390997这场谁C了',
  });
  assert.strictEqual(intentMatchHandled, true, '/cs intent matchid question should be handled by cs plugin');
  const intentMatchText = String(replies.at(-1));
  assert.ok(intentMatchText.includes('路由: 自然问法 -> match (2390997)'), '/cs intent matchid should show match route and id');
  assert.ok(intentMatchText.includes('单场详情 2390997 [match:2390997]: miss'), '/cs intent matchid should inspect match cache key');
  assert.ok(intentMatchText.includes('证据卡 /cs evidence match 2390997'), '/cs intent matchid should point to match evidence card');
  assert.ok(intentMatchText.includes('/cs warm plan match 2390997'), '/cs intent matchid miss should suggest match prewarm plan');
  assert.ok(intentMatchText.includes('/cs warm match 2390997'), '/cs intent matchid miss should suggest targeted match prewarm');

  const intentStableHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['intent', '这把残局怎么打稳一点'],
    rawText: '/cs intent 这把残局怎么打稳一点',
  });
  assert.strictEqual(intentStableHandled, true, '/cs intent stable tactical question should be handled');
  const intentStableText = String(replies.at(-1));
  assert.ok(intentStableText.includes('不会被 CS 实时插件直接接管'), '/cs intent should identify stable/non-realtime questions');
  assert.ok(intentStableText.includes('普通 AI/知识库'), '/cs intent should recommend normal AI path for stable tactical questions');
  const intentStatsAfter = hltv.getHltvStats();
  assert.strictEqual(intentStatsAfter.hits, intentStatsBefore.hits, '/cs intent should not increment cache hits');
  assert.strictEqual(intentStatsAfter.misses, intentStatsBefore.misses, '/cs intent should not increment cache misses');

  const formattedMatchResult = hltv.__test.formatCsApiMatchResultForTests({
    id: 2390002,
    team1: { id: 1, name: 'Spirit', score: 2, rank: 2 },
    team2: { id: 2, name: '9z', score: 0, rank: 15 },
    maps: [{ id: 6, name: 'Mirage', team1_score: 13, team2_score: 3 }],
    best_of: 3,
    date: '2026-06-07',
    event: 'IEM Smoke',
    winner: { id: 1, name: 'Spirit' },
  });
  assert.ok(formattedMatchResult.includes('matchid=2390002'), 'CS API result format should expose match id');
  assert.ok(formattedMatchResult.includes('ranks=#2/#15'), 'CS API result format should expose team ranks');
  assert.ok(formattedMatchResult.includes('[Mirage 13-3]'), 'CS API result format should expose map scores');
  const formattedMatchDetail = hltv.__test.formatCsApiMatchDetailForTests({
    id: 2390002,
    team1: { id: 1, name: 'Spirit', score: 2, rank: 2 },
    team2: { id: 2, name: '9z', score: 0, rank: 15 },
    maps: [
      { id: 11, name: 'Mirage', team1_score: 13, team2_score: 3 },
      { id: 12, name: 'Nuke', team1_score: 13, team2_score: 1 },
    ],
    best_of: 3,
    date: '2026-06-07',
    event: 'IEM Smoke',
    winner: { id: 1, name: 'Spirit' },
  }, [
    {
      name: 'All',
      team1: { name: 'Spirit', players: [{ name: 'donk', k: 48, d: 16, rating: 2.55, adr: 155.1, kast: 93.3 }] },
      team2: { name: '9z', players: [{ name: 'dgt', k: 25, d: 31, rating: 1.05, adr: 80.2, kast: 71.0 }] },
    },
    {
      id: 11,
      name: 'Mirage',
      team1: { name: 'Spirit', players: [{ name: 'donk', k: 27, d: 8, rating: 2.80, adr: 168.0, kast: 96.0 }] },
      team2: { name: '9z', players: [{ name: 'dgt', k: 13, d: 15, rating: 1.02, adr: 74.1, kast: 68.0 }] },
    },
    {
      id: 12,
      name: 'Map 2 Nuke',
      team1: { name: 'Spirit', players: [{ name: 'magixx', k: 21, d: 7, rating: 2.10, adr: 130.0, kast: 91.0 }] },
      team2: { name: '9z', players: [{ name: 'max', k: 9, d: 17, rating: 0.72, adr: 55.0, kast: 58.0 }] },
    },
  ]);
  const formattedSingleMapDetail = hltv.__test.formatCsApiMatchDetailForTests({
    id: 2390004,
    team1: { id: 1, name: 'Spirit', score: 1, rank: 2 },
    team2: { id: 2, name: '9z', score: 0, rank: 15 },
    maps: [{ id: 13, name: 'de_inferno', team1_score: 13, team2_score: 11 }],
    best_of: 1,
    date: '2026-06-07',
    event: 'IEM Smoke',
    winner: { id: 1, name: 'Spirit' },
  }, []);
  assert.ok(formattedMatchDetail.includes('地图池线索: Mirage / Nuke'), 'CS API match detail should expose structured map pool hint');
  assert.ok(formattedMatchDetail.includes('竞猜地图: 多图 Mirage / Nuke 只作为 mappool 线索'), 'CS API match detail should explain multi-map betting boundary');
  assert.ok(formattedMatchDetail.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390002/match'), 'CS API match detail should expose an HLTV match page verification candidate');
  assert.ok(formattedMatchDetail.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390002'), 'CS API match detail should expose an HLTV search fallback');
  assert.ok(formattedMatchDetail.includes('HLTV比赛页候选只供人工交叉核验'), 'CS API match detail should explain HLTV match page boundary');
  assert.ok(formattedMatchDetail.includes('真实 HLTV 页面可能需要 slug'), 'CS API match detail should explain slug boundary');
  assert.ok(formattedMatchDetail.includes('不等于赛前 HLTV 官方 veto/pick-ban'), 'CS API match detail should keep veto source boundary');
  assert.ok(formattedSingleMapDetail.includes('地图池线索: Inferno'), 'CS API match detail should expose single map hint');
  assert.ok(formattedSingleMapDetail.includes('/predict <id> A 2-1 map Inferno'), 'CS API match detail should suggest single-map predict syntax');
  assert.ok(formattedMatchDetail.includes('地图亮点: Mirage: donk(Spirit) Rating 2.80'), 'CS API match detail should expose per-map MVP/rating highlights');
  assert.ok(formattedMatchDetail.includes('Nuke: magixx(Spirit) Rating 2.10'), 'CS API match detail should clean map block names');
  assert.ok(formattedMatchDetail.includes('选手亮点: donk(Spirit) Rating 2.55'), 'CS API match detail should keep overall player highlights');
  hltv.__test.setCacheEntryForTests(
    'match:2390099',
    [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      'Match ID: 2390099',
      '详情链接: https://api.csapi.de/matches/2390099',
      '统计链接: https://api.csapi.de/matches/2390099/stats',
      'Spirit 2:0 9z BO3 (IEM Smoke) 胜者:Spirit',
      '边界: 这是 CS API 结构化赛果快照；地图池线索来自 match.maps，不等于赛前 HLTV 官方 veto/pick-ban。',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 5_000, source: 'test-old-match-cache', fetchMs: 14 },
  );
  const enrichedOldMatchCache = await hltv.fetchMatchDetail(2390099);
  assert.ok(enrichedOldMatchCache.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390099/match'), 'old cached match detail should be enriched with HLTV match page candidate');
  assert.ok(enrichedOldMatchCache.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390099'), 'old cached match detail should be enriched with HLTV search fallback');
  assert.ok(enrichedOldMatchCache.includes('HLTV比赛页候选只供人工交叉核验'), 'old cached match detail should be enriched with HLTV boundary');
  assert.ok(enrichedOldMatchCache.includes('真实 HLTV 页面可能需要 slug'), 'old cached match detail should be enriched with HLTV slug boundary');
  assert.ok(enrichedOldMatchCache.includes('缓存: match:2390099 fresh'), 'old cached match detail should keep cache freshness evidence');
  hltv.__test.setCacheEntryForTests(
    'match:2390002',
    [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      'Match ID: 2390002',
      '详情链接: https://api.csapi.de/matches/2390002',
      '统计链接: https://api.csapi.de/matches/2390002/stats',
      'HLTV比赛页候选: https://www.hltv.org/matches/2390002/match',
      'Spirit 2:0 9z BO3 (IEM Smoke) 胜者:Spirit',
      '地图比分: Mirage 13-3 / Nuke 13-1',
      '地图池线索: Mirage / Nuke',
      '竞猜地图: 多图 Mirage / Nuke 只作为 mappool 线索；单张图统计按实际单图下注或结算证据走。',
      '地图亮点: Mirage: donk(Spirit) Rating 2.80 K/D 27/8 ADR168.0 KAST96.0% / Nuke: magixx(Spirit) Rating 2.10 K/D 21/7 ADR130.0 KAST91.0%',
      '选手亮点: donk(Spirit) Rating 2.55 K/D 48/16 ADR155.1 KAST93.3%',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 5_000, source: 'test-match-detail', fetchMs: 25 },
  );
  const warmDenied = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['warm'],
    rawText: '/cs warm',
  });
  assert.strictEqual(warmDenied, true, '/cs warm should be handled for non-admin');
  assert.ok(String(replies.at(-1)).includes('管理员'), '/cs warm should be admin-only');

  const warmHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm'],
    rawText: '/cs warm',
  });
  assert.strictEqual(warmHandled, true, '/cs warm should be handled for admin');
  const warmText = String(replies.at(-1));
  assert.ok(warmText.includes('CS实时数据预热完成'), '/cs warm should render prewarm report');
  assert.ok(warmText.includes('matches: OK'), '/cs warm should prewarm matches');
  assert.ok(warmText.includes('results: OK'), '/cs warm should prewarm results');
  assert.ok(warmText.includes('ranking: OK'), '/cs warm should prewarm ranking');
  assert.ok(warmText.includes('source=test-warm-matches'), '/cs warm should include match cache evidence');
  assert.ok(warmText.includes('source=test-warm-results'), '/cs warm should include result cache evidence');
  assert.ok(warmText.includes('预热后事实类型覆盖:'), '/cs warm should expose post-warm typed fact coverage');
  assert.ok(warmText.includes('当前排名: ranking HIT(fresh)'), '/cs warm should show ranking fact type after prewarm');
  assert.ok(warmText.includes('matches HIT(fresh)；results HIT(fresh)'), '/cs warm should show match/result fact types after prewarm');
  assert.ok(hltv.getHltvStats().hits >= 4, '/cs warm should use cache hits for preloaded realtime data');

  const warmPlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan'],
    rawText: '/cs warm plan',
  });
  assert.strictEqual(warmPlanHandled, true, '/cs warm plan should be handled for admin');
  const warmPlanText = String(replies.at(-1));
  assert.ok(warmPlanText.includes('CS实时数据预热计划'), '/cs warm plan should render a read-only plan');
  assert.ok(warmPlanText.includes('matches [matches]: HIT'), '/cs warm plan should predict fresh match cache hits');
  assert.ok(warmPlanText.includes('ranking [ranking]: HIT'), '/cs warm plan should predict fresh ranking cache hits');
  assert.ok(warmPlanText.includes('预计请求 0'), '/cs warm plan should not request when core caches are fresh');
  assert.ok(warmPlanText.includes('计划事实类型覆盖:'), '/cs warm plan should expose planned typed fact coverage');
  assert.ok(warmPlanText.includes('当前排名: ranking HIT(fresh)'), '/cs warm plan should show ranking fact type as planned hit');
  assert.ok(warmPlanText.includes('matches HIT(fresh)；results HIT(fresh)'), '/cs warm plan should show match/result fact types as planned hits');
  assert.ok(warmPlanText.includes('ranking fresh 不能替代阵容/转会证据'), '/cs warm plan should keep roster truth boundary');
  assert.ok(warmPlanText.includes('只读计划'), '/cs warm plan should clarify it does not call external sources');

  const warmMatchPlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan', 'match', '2390002'],
    rawText: '/cs warm plan match 2390002',
  });
  assert.strictEqual(warmMatchPlanHandled, true, '/cs warm plan match <id> should be handled for admin');
  const warmMatchPlanText = String(replies.at(-1));
  assert.ok(warmMatchPlanText.includes('match 2390002 [match:2390002]: HIT'), '/cs warm plan match should inspect match detail cache');
  assert.ok(warmMatchPlanText.includes('预计请求 0'), '/cs warm plan match should avoid requests when match cache is fresh');

  const warmMatchMissPlanStatsBefore = hltv.getHltvStats();
  const warmMatchMissPlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan', '2390999'],
    rawText: '/cs warm plan 2390999',
  });
  assert.strictEqual(warmMatchMissPlanHandled, true, '/cs warm plan <matchid> should be handled for admin');
  const warmMatchMissPlanText = String(replies.at(-1));
  assert.ok(warmMatchMissPlanText.includes('match 2390999 [match:2390999]: REFRESH'), '/cs warm plan <matchid> should plan match detail refresh');
  assert.ok(warmMatchMissPlanText.includes('miss，会请求实时源'), '/cs warm plan <matchid> should explain match cache miss');
  const warmMatchMissPlanStatsAfter = hltv.getHltvStats();
  assert.strictEqual(warmMatchMissPlanStatsAfter.hits, warmMatchMissPlanStatsBefore.hits, '/cs warm plan match miss should not increment cache hits');
  assert.strictEqual(warmMatchMissPlanStatsAfter.misses, warmMatchMissPlanStatsBefore.misses, '/cs warm plan match miss should not increment cache misses');

  const warmMatchHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'match', '2390002'],
    rawText: '/cs warm match 2390002',
  });
  assert.strictEqual(warmMatchHandled, true, '/cs warm match <id> should be handled for admin');
  const warmMatchText = String(replies.at(-1));
  assert.ok(warmMatchText.includes('match 2390002: OK'), '/cs warm match should prewarm match detail target');
  assert.ok(warmMatchText.includes('缓存: match:2390002 fresh'), '/cs warm match should include match cache evidence');

  const warmMissPlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan', 'player', 'donk'],
    rawText: '/cs warm plan player donk',
  });
  assert.strictEqual(warmMissPlanHandled, true, '/cs warm plan player should be handled for admin');
  const warmMissPlanText = String(replies.at(-1));
  assert.ok(warmMissPlanText.includes('player donk'), '/cs warm plan player should include the requested target');
  assert.ok(warmMissPlanText.includes('REFRESH'), '/cs warm plan player should mark missing cache as refresh-needed');
  assert.ok(warmMissPlanText.includes('miss，会请求实时源'), '/cs warm plan player should explain cache miss');
  assert.ok(warmMissPlanText.includes('计划事实类型覆盖:'), '/cs warm plan player should expose planned typed fact coverage');
  assert.ok(warmMissPlanText.includes('选手数据/状态: 目标1个 HIT 0 / REFRESH 1；player:donk=REFRESH(miss)'), '/cs warm plan player should mark player fact type as refresh-needed');

  const verifyMissStatsBefore = hltv.getHltvStats();
  const verifyMissHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'player', 'donk'],
    rawText: '/cs verify player donk',
  });
  assert.strictEqual(verifyMissHandled, true, '/cs verify player should be handled by cs plugin');
  const verifyMissText = String(replies.at(-1));
  assert.ok(verifyMissText.includes('CS事实回复预检'), '/cs verify should render fact preflight');
  assert.ok(verifyMissText.includes('新鲜度: miss'), '/cs verify miss should expose missing cache');
  assert.ok(verifyMissText.includes('不能把 miss 说成'), '/cs verify miss should warn against false absence claims');
  assert.ok(verifyMissText.includes('只读预检'), '/cs verify should clarify read-only behavior');
  const verifyMissStatsAfter = hltv.getHltvStats();
  assert.strictEqual(verifyMissStatsAfter.hits, verifyMissStatsBefore.hits, '/cs verify should not increment cache hits');
  assert.strictEqual(verifyMissStatsAfter.misses, verifyMissStatsBefore.misses, '/cs verify should not increment cache misses');

  const evidenceHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', 'ranking'],
    rawText: '/cs evidence ranking',
  });
  assert.strictEqual(evidenceHandled, true, '/cs evidence should be handled by cs plugin');
  const evidenceText = String(replies.at(-1));
  assert.ok(evidenceText.includes('CS数据证据卡'), '/cs evidence should render evidence card');
  assert.ok(evidenceText.includes('HLTV ranking'), '/cs evidence ranking should include HLTV ranking link');
  assert.ok(evidenceText.includes('当前缓存: fresh'), '/cs evidence should expose human-readable cache freshness');

  const verifyFreshHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'ranking'],
    rawText: '/cs verify ranking',
  });
  assert.strictEqual(verifyFreshHandled, true, '/cs verify ranking should be handled by cs plugin');
  const verifyFreshText = String(replies.at(-1));
  assert.ok(verifyFreshText.includes('新鲜度: fresh'), '/cs verify fresh should expose fresh cache');
  assert.ok(verifyFreshText.includes('可以作为当前快照依据'), '/cs verify fresh should allow current snapshot with boundaries');
  assert.ok(verifyFreshText.includes('/cs evidence ranking'), '/cs verify fresh should point to evidence card');

  const verifyAllFreshStatsBefore = hltv.getHltvStats();
  const verifyAllFreshHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'all'],
    rawText: '/cs verify all',
  });
  assert.strictEqual(verifyAllFreshHandled, true, '/cs verify all should be handled by cs plugin');
  const verifyAllFreshText = String(replies.at(-1));
  assert.ok(verifyAllFreshText.includes('CS事实回复预检 | 核心数据'), '/cs verify all should render core fact preflight title');
  assert.ok(verifyAllFreshText.includes('总判定:'), '/cs verify all should expose an aggregate verdict');
  assert.ok(verifyAllFreshText.includes('覆盖: fresh 3 / stale 0 / miss 0'), '/cs verify all should summarize all-fresh coverage');
  assert.ok(verifyAllFreshText.includes('结论: 可发当前核心快照'), '/cs verify all should allow a current core snapshot when all core caches are fresh');
  assert.ok(verifyAllFreshText.includes('/cs evidence all'), '/cs verify all fresh should point to the evidence overview');
  assert.ok(verifyAllFreshText.includes('事实类型覆盖:'), '/cs verify all should expose typed fact coverage');
  assert.ok(verifyAllFreshText.includes('当前排名: ranking=fresh'), '/cs verify all typed coverage should show ranking freshness');
  assert.ok(verifyAllFreshText.includes('阵容/转会: 按队伍目标核验'), '/cs verify all typed coverage should keep roster target-scoped');
  assert.ok(verifyAllFreshText.includes('ranking fresh 不能替代阵容/转会证据'), '/cs verify all typed coverage should not let ranking support roster facts');
  assert.ok(verifyAllFreshText.includes('选手数据/状态: 按选手目标核验'), '/cs verify all typed coverage should keep player target-scoped');
  const verifyAllFreshStatsAfter = hltv.getHltvStats();
  assert.strictEqual(verifyAllFreshStatsAfter.hits, verifyAllFreshStatsBefore.hits, '/cs verify all fresh should not increment cache hits');
  assert.strictEqual(verifyAllFreshStatsAfter.misses, verifyAllFreshStatsBefore.misses, '/cs verify all fresh should not increment cache misses');

  hltv.__test.setCacheEntryForTests(
    hltv.getCsProfileCacheKey('team', 'Vitality'),
    [
      '来源：CS API / VRS+队伍数据 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      'Vitality #1 2100分',
    ].join('\n'),
    { ttlMs: 60_000, ageMs: 8_000, source: 'test-team-profile', fetchMs: 19 },
  );
  const teamEvidenceHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', 'team', 'Vitality'],
    rawText: '/cs evidence team Vitality',
  });
  assert.strictEqual(teamEvidenceHandled, true, '/cs evidence team should be handled by cs plugin');
  const teamEvidenceText = String(replies.at(-1));
  assert.ok(teamEvidenceText.includes('查询目标: Vitality'), '/cs evidence team should echo subject');
  assert.ok(teamEvidenceText.includes('test-team-profile'), '/cs evidence team should use profile cache key');

  const matchDetailHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['match', '2390002'],
    rawText: '/cs match 2390002',
  });
  assert.strictEqual(matchDetailHandled, true, '/cs match <id> should be handled by cs plugin');
  const matchDetailText = String(replies.at(-1));
  assert.ok(matchDetailText.includes('CS单场详情'), '/cs match <id> should render match detail title');
  assert.ok(matchDetailText.includes('详情链接: https://api.csapi.de/matches/2390002'), '/cs match <id> should expose CS API match detail link');
  assert.ok(matchDetailText.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390002/match'), '/cs match <id> should expose HLTV match page verification candidate');
  assert.ok(matchDetailText.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390002'), '/cs match <id> should expose HLTV search fallback');
  assert.ok(matchDetailText.includes('地图池线索: Mirage / Nuke'), '/cs match <id> should expose map pool hint');
  assert.ok(matchDetailText.includes('竞猜地图: 多图 Mirage / Nuke'), '/cs match <id> should expose predict map boundary');
  assert.ok(matchDetailText.includes('地图亮点'), '/cs match <id> should include per-map player highlights');
  assert.ok(matchDetailText.includes('选手亮点'), '/cs match <id> should include player stat highlights');
  assert.ok(matchDetailText.includes('缓存: match:2390002 fresh'), '/cs match <id> should include cache evidence');

  const matchMapsHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['match', '2390002', 'maps'],
    rawText: '/cs match 2390002 maps',
  });
  assert.strictEqual(matchMapsHandled, true, '/cs match <id> maps should be handled by cs plugin');
  assert.ok(String(replies.at(-1)).includes('地图亮点'), '/cs match <id> maps should still render match detail');

  const matchEvidenceHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', 'match', '2390002'],
    rawText: '/cs evidence match 2390002',
  });
  assert.strictEqual(matchEvidenceHandled, true, '/cs evidence match <id> should be handled by cs plugin');
  const matchEvidenceText = String(replies.at(-1));
  assert.ok(matchEvidenceText.includes('目标: 单场详情'), '/cs evidence match should render single-match evidence target');
  assert.ok(matchEvidenceText.includes('查询目标: 2390002'), '/cs evidence match should echo match id');
  assert.ok(matchEvidenceText.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390002/match'), '/cs evidence match should expose HLTV match page verification candidate');
  assert.ok(matchEvidenceText.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390002'), '/cs evidence match should expose HLTV search fallback');
  assert.ok(matchEvidenceText.includes('活链路核验: /cs hltvcheck 2390002'), '/cs evidence match should point to live HLTV link check');
  assert.ok(matchEvidenceText.includes('HLTV候选核验缓存: miss'), '/cs evidence match should expose missing link-check cache before live hltvcheck');
  assert.ok(matchEvidenceText.includes('本证据卡只读，不现场请求 HLTV'), '/cs evidence match should not request HLTV while rendering evidence');
  assert.ok(matchEvidenceText.includes('内部源 test-match-detail'), '/cs evidence match should use match detail cache entry');

  let hltvCheckCalls = 0;
  hltv.__test.setHttpMetaFetcherForTests(async (url, timeoutMs) => {
    hltvCheckCalls++;
    assert.strictEqual(timeoutMs, 6000, 'HLTV link check should use a short timeout');
    assert.ok(url.includes('/matches/2390002/match'), 'HLTV link check should request the match page candidate');
    return {
      url,
      finalUrl: 'https://www.hltv.org/matches/2390002/spirit-vs-9z-smoke',
      statusCode: 200,
      body: '<html><title>Spirit vs 9z - Match - HLTV.org</title><div class="match-page"></div></html>',
    };
  });
  const hltvCheckStatsBefore = hltv.getHltvStats();
  const hltvCheckHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['hltvcheck', '2390002'],
    rawText: '/cs hltvcheck 2390002',
  });
  assert.strictEqual(hltvCheckHandled, true, '/cs hltvcheck should be handled by cs plugin');
  const hltvCheckText = String(replies.at(-1));
  assert.ok(hltvCheckText.includes('HLTV比赛页候选核验'), '/cs hltvcheck should render link check report');
  assert.ok(hltvCheckText.includes('判定: 可访问候选'), '/cs hltvcheck should classify verified candidate pages');
  assert.ok(hltvCheckText.includes('最终URL: https://www.hltv.org/matches/2390002/spirit-vs-9z-smoke'), '/cs hltvcheck should expose final URL');
  assert.ok(hltvCheckText.includes('不写 CS 事实缓存'), '/cs hltvcheck should disclose it does not mutate fact cache');
  const hltvCheckStatsAfter = hltv.getHltvStats();
  assert.strictEqual(hltvCheckStatsAfter.hits, hltvCheckStatsBefore.hits, '/cs hltvcheck should not increment CS cache hits');
  assert.strictEqual(hltvCheckStatsAfter.misses, hltvCheckStatsBefore.misses, '/cs hltvcheck should not increment CS cache misses');
  assert.strictEqual(hltvCheckCalls, 1, '/cs hltvcheck should request live candidate once on miss');

  const hltvCheckCachedHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['linkcheck', '2390002'],
    rawText: '/cs linkcheck 2390002',
  });
  assert.strictEqual(hltvCheckCachedHandled, true, '/cs linkcheck alias should be handled by cs plugin');
  const hltvCheckCachedText = String(replies.at(-1));
  assert.ok(hltvCheckCachedText.includes('缓存hit'), '/cs hltvcheck should reuse short TTL link-check cache');
  assert.strictEqual(hltvCheckCalls, 1, '/cs hltvcheck cache hit should not call HLTV again');

  const matchEvidenceAfterLinkCheckHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', 'match', '2390002'],
    rawText: '/cs evidence match 2390002',
  });
  assert.strictEqual(matchEvidenceAfterLinkCheckHandled, true, '/cs evidence match should work after hltvcheck');
  const matchEvidenceAfterLinkCheckText = String(replies.at(-1));
  assert.ok(matchEvidenceAfterLinkCheckText.includes('HLTV候选核验缓存: verified(可访问候选)'), '/cs evidence match should reuse cached hltv link-check status');
  assert.ok(matchEvidenceAfterLinkCheckText.includes('final=https://www.hltv.org/matches/2390002/spirit-vs-9z-smoke'), '/cs evidence match should expose cached hltv final URL');
  assert.strictEqual(hltvCheckCalls, 1, '/cs evidence match should not request HLTV when showing cached link-check status');

  const statusAfterHltvCheckHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['status'],
    rawText: '/cs status',
  });
  assert.strictEqual(statusAfterHltvCheckHandled, true, '/cs status should be handled after hltvcheck');
  const statusAfterHltvCheckText = String(replies.at(-1));
  assert.ok(statusAfterHltvCheckText.includes('HLTV候选核验缓存: 1条'), '/cs status should expose hltv link-check cache size');
  assert.ok(statusAfterHltvCheckText.includes('matchid=2390002 verified'), '/cs status should expose latest hltv link-check status');
  assert.ok(statusAfterHltvCheckText.includes('不等于比分、阵容或地图池事实证据'), '/cs status should preserve hltv link-check truth boundary');
  hltv.__test.setHttpMetaFetcherForTests();

  const directMatchEvidenceHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', '2390002'],
    rawText: '/cs evidence 2390002',
  });
  assert.strictEqual(directMatchEvidenceHandled, true, '/cs evidence <matchid> should be handled by cs plugin');
  const directMatchEvidenceText = String(replies.at(-1));
  assert.ok(directMatchEvidenceText.includes('目标: 单场详情'), '/cs evidence <matchid> should route to single-match evidence');
  assert.ok(directMatchEvidenceText.includes('查询目标: 2390002'), '/cs evidence <matchid> should echo match id');
  assert.ok(directMatchEvidenceText.includes('HLTV比赛页候选: https://www.hltv.org/matches/2390002/match'), '/cs evidence <matchid> should expose HLTV match page candidate');
  assert.ok(directMatchEvidenceText.includes('HLTV搜索入口: https://www.hltv.org/search?query=2390002'), '/cs evidence <matchid> should expose HLTV search fallback');

  const directMatchVerifyHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', '2390002'],
    rawText: '/cs verify 2390002',
  });
  assert.strictEqual(directMatchVerifyHandled, true, '/cs verify <matchid> should be handled by cs plugin');
  const directMatchVerifyText = String(replies.at(-1));
  assert.ok(directMatchVerifyText.includes('目标: 单场详情 2390002'), '/cs verify <matchid> should route to single-match fact preflight');
  assert.ok(directMatchVerifyText.includes('缓存键: match:2390002'), '/cs verify <matchid> should inspect match cache key');
  assert.ok(directMatchVerifyText.includes('/cs evidence match 2390002'), '/cs verify <matchid> should point to the match evidence card');

  const verifyMissingMatchStatsBefore = hltv.getHltvStats();
  const verifyMissingMatchHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', '2390998'],
    rawText: '/cs verify 2390998',
  });
  assert.strictEqual(verifyMissingMatchHandled, true, '/cs verify missing <matchid> should be handled by cs plugin');
  const verifyMissingMatchText = String(replies.at(-1));
  assert.ok(verifyMissingMatchText.includes('新鲜度: miss'), '/cs verify missing match should expose miss freshness');
  assert.ok(verifyMissingMatchText.includes('/cs warm plan match 2390998'), '/cs verify missing match should suggest match prewarm plan');
  assert.ok(verifyMissingMatchText.includes('/cs warm match 2390998'), '/cs verify missing match should suggest targeted match prewarm');
  assert.ok(verifyMissingMatchText.includes('/cs match 2390998'), '/cs verify missing match should suggest final match detail command');
  const verifyMissingMatchStatsAfter = hltv.getHltvStats();
  assert.strictEqual(verifyMissingMatchStatsAfter.hits, verifyMissingMatchStatsBefore.hits, '/cs verify missing match should not increment cache hits');
  assert.strictEqual(verifyMissingMatchStatsAfter.misses, verifyMissingMatchStatsBefore.misses, '/cs verify missing match should not increment cache misses');

  hltv.__test.setCacheEntryForTests(
    'results',
    [
      '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- NAVI 2:0 Vitality',
    ].join('\n'),
    { ttlMs: -1_000, ageMs: 20_000, source: 'test-stale-results', fetchMs: 31 },
  );
  const staleResults = hltv.withHltvCacheEvidence('NAVI 2:0 Vitality', 'results');
  assert.ok(staleResults.includes('缓存: results stale'), 'stale CS fallback should include stale cache evidence');
  assert.ok(staleResults.includes('不能当实时结论'), 'stale CS fallback should warn against realtime claims');
  const staleStats = hltv.getHltvStats();
  assert.ok(staleStats.staleEntries >= 1, 'CS stats should expose stale cache entries');

  const verifyStaleHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'results'],
    rawText: '/cs verify results',
  });
  assert.strictEqual(verifyStaleHandled, true, '/cs verify results should be handled by cs plugin');
  const verifyStaleText = String(replies.at(-1));
  assert.ok(verifyStaleText.includes('新鲜度: stale'), '/cs verify stale should expose stale cache');
  assert.ok(verifyStaleText.includes('只能说旧快照/线索'), '/cs verify stale should downgrade claims');
  assert.ok(verifyStaleText.includes('不能报成现在、最新、刚查到'), '/cs verify stale should forbid fresh wording');
  assert.ok(verifyStaleText.includes('/cs warm plan results'), '/cs verify stale results should suggest targeted results plan');
  assert.ok(verifyStaleText.includes('/cs warm results'), '/cs verify stale results should suggest targeted results prewarm');

  const verifyAllPartialStatsBefore = hltv.getHltvStats();
  const verifyAllPartialHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'all'],
    rawText: '/cs verify all',
  });
  assert.strictEqual(verifyAllPartialHandled, true, '/cs verify all with stale core cache should be handled');
  const verifyAllPartialText = String(replies.at(-1));
  assert.ok(verifyAllPartialText.includes('覆盖: fresh 2 / stale 1 / miss 0'), '/cs verify all should summarize mixed freshness coverage');
  assert.ok(verifyAllPartialText.includes('结论: 只能发部分当前快照'), '/cs verify all should downgrade mixed core freshness');
  assert.ok(verifyAllPartialText.includes('stale 项标成旧线索'), '/cs verify all should explain stale item wording');
  assert.ok(verifyAllPartialText.includes('缺口 最近赛果[results]'), '/cs verify all should list stale/miss core gaps');
  assert.ok(verifyAllPartialText.includes('/cs warm plan all'), '/cs verify all mixed freshness should suggest all-core prewarm plan');
  assert.ok(verifyAllPartialText.includes('别说“我刚查了HLTV'), '/cs verify all should forbid fresh wording when any core cache is stale/miss');
  assert.ok(verifyAllPartialText.includes('事实类型覆盖:'), '/cs verify all mixed freshness should keep typed fact coverage');
  assert.ok(verifyAllPartialText.includes('results=stale'), '/cs verify all typed coverage should expose stale result type');
  const verifyAllPartialStatsAfter = hltv.getHltvStats();
  assert.strictEqual(verifyAllPartialStatsAfter.hits, verifyAllPartialStatsBefore.hits, '/cs verify all partial should not increment cache hits');
  assert.strictEqual(verifyAllPartialStatsAfter.misses, verifyAllPartialStatsBefore.misses, '/cs verify all partial should not increment cache misses');

  const warmResultsPlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan', 'results'],
    rawText: '/cs warm plan results',
  });
  assert.strictEqual(warmResultsPlanHandled, true, '/cs warm plan results should be handled for admin');
  const warmResultsPlanText = String(replies.at(-1));
  assert.ok(warmResultsPlanText.includes('results [results]: REFRESH'), '/cs warm plan results should inspect only result cache');
  assert.ok(!warmResultsPlanText.includes('matches [matches]'), '/cs warm plan results should not include matches target');
  assert.ok(!warmResultsPlanText.includes('ranking [ranking]'), '/cs warm plan results should not include ranking target');
  assert.ok(warmResultsPlanText.includes('执行: 管理员 /cs warm results，预计刷新 1 项。'), '/cs warm plan results should suggest exact execution command');
  assert.ok(warmResultsPlanText.includes('复核: /cs verify results；证据: /cs evidence results'), '/cs warm plan results should suggest exact verify/evidence commands');
  assert.ok(warmResultsPlanText.includes('plan 只读不请求外站'), '/cs warm plan results should preserve read-only boundary');

  const todayStaleCheckHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['brief', 'check'],
    rawText: '/cs brief check',
  });
  assert.strictEqual(todayStaleCheckHandled, true, '/cs brief check should be handled by cs plugin');
  const todayStaleCheckText = String(replies.at(-1));
  assert.ok(todayStaleCheckText.includes('最近赛果 [results]: stale'), '/cs brief check should show stale result cache');
  assert.ok(todayStaleCheckText.includes('预计会请求 1 项实时源'), '/cs brief check should count stale cache as future request');
  assert.ok(todayStaleCheckText.includes('不能当实时结论'), '/cs brief check should explain stale realtime boundary');
  assert.ok(todayStaleCheckText.includes('/cs warm plan results'), '/cs brief check should suggest targeted result prewarm plan when only results is stale');
  assert.ok(todayStaleCheckText.includes('/cs warm results'), '/cs brief check should suggest targeted result prewarm when only results is stale');

  const warmStalePlanHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'plan'],
    rawText: '/cs warm plan',
  });
  assert.strictEqual(warmStalePlanHandled, true, '/cs warm plan should handle stale core cache');
  const warmStalePlanText = String(replies.at(-1));
  assert.ok(warmStalePlanText.includes('results [results]: REFRESH'), '/cs warm plan should mark stale result cache as refresh-needed');
  assert.ok(warmStalePlanText.includes('stale，expired='), '/cs warm plan should expose stale age/expiry');
  assert.ok(warmStalePlanText.includes('只能当旧快照线索'), '/cs warm plan should explain stale realtime boundary');
  assert.ok(warmStalePlanText.includes('预计请求 1'), '/cs warm plan should count stale cache as a future request');
  assert.ok(warmStalePlanText.includes('复核: /cs verify all；证据: /cs evidence all'), '/cs warm plan should suggest all-target verification after multi-target plan');

  const evidenceAllHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['evidence', 'all'],
    rawText: '/cs evidence all',
  });
  assert.strictEqual(evidenceAllHandled, true, '/cs evidence all should be handled by cs plugin');
  const evidenceAllText = String(replies.at(-1));
  assert.ok(evidenceAllText.includes('CS数据证据总览'), '/cs evidence all should render overview card');
  assert.ok(evidenceAllText.includes('核心证据'), '/cs evidence all should include core evidence section');
  assert.ok(evidenceAllText.includes('matches'), '/cs evidence all should include matches cache status');
  assert.ok(evidenceAllText.includes('results'), '/cs evidence all should include results cache status');
  assert.ok(evidenceAllText.includes('ranking'), '/cs evidence all should include ranking cache status');
  assert.ok(evidenceAllText.includes('HLTV matches'), '/cs evidence all should include match source link');
  assert.ok(evidenceAllText.includes('test-stale-results'), '/cs evidence all should surface stale result cache source');
  assert.ok(evidenceAllText.includes('stale 只能当旧快照线索'), '/cs evidence all should explain stale boundary');

  const sourceStatsBefore = hltv.getHltvStats();
  const sourcesHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['sources'],
    rawText: '/cs sources',
  });
  assert.strictEqual(sourcesHandled, true, '/cs sources should be handled by cs plugin');
  const sourcesText = String(replies.at(-1));
  assert.ok(sourcesText.includes('CS数据来源/链接'), '/cs sources should render source/link panel');
  assert.ok(sourcesText.includes('CS API: https://api.csapi.de/'), '/cs sources should expose CS API link');
  assert.ok(sourcesText.includes('HLTV matches: https://www.hltv.org/matches'), '/cs sources should expose HLTV matches link');
  assert.ok(sourcesText.includes('HLTV results: https://www.hltv.org/results'), '/cs sources should expose HLTV results link');
  assert.ok(sourcesText.includes('Liquipedia VRS'), '/cs sources should expose Liquipedia VRS link');
  assert.ok(sourcesText.includes('不等于本项目拿到了 HLTV 官方实时 API'), '/cs sources should explain HLTV API boundary');
  assert.ok(sourcesText.includes('模式: 只读'), '/cs sources should be read-only');
  const sourceStatsAfter = hltv.getHltvStats();
  assert.strictEqual(sourceStatsAfter.hits, sourceStatsBefore.hits, '/cs sources should not increment CS cache hits');
  assert.strictEqual(sourceStatsAfter.misses, sourceStatsBefore.misses, '/cs sources should not increment CS cache misses');

  assert.deepStrictEqual(
    csTest.routeNaturalCsQuery('donk最近状态怎么样'),
    { sub: 'player', subject: 'donk', natural: true },
    'natural CS parser should route known player status questions',
  );
  assert.deepStrictEqual(
    csTest.routeNaturalCsQuery('Vitality现在阵容'),
    { sub: 'team', subject: 'Vitality', natural: true },
    'natural CS parser should route known team roster questions',
  );
  assert.deepStrictEqual(
    csTest.routeNaturalCsQuery('2390002这场谁C了'),
    { sub: 'match', subject: '2390002', natural: true },
    'natural CS parser should route match id detail questions',
  );
  assert.strictEqual(csTest.extractMatchIdFromSubject('2390002 maps'), '2390002', 'match subject parser should accept optional detail words after match id');
  assert.deepStrictEqual(
    csTest.parseEvidenceArgs(['match', '2390002']),
    { target: 'match', subject: '2390002' },
    'CS evidence parser should route match id evidence to match cache key',
  );
  assert.deepStrictEqual(
    csTest.parseEvidenceArgs(['all']),
    { target: 'all', subject: '' },
    'CS evidence parser should route all to evidence overview',
  );
  assert.strictEqual(csTest.routeNaturalCsQuery('现在排名')?.sub, 'ranking', 'natural CS parser should route ranking questions');

  const statusWithCacheHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['status'],
    rawText: '/cs status',
  });
  assert.strictEqual(statusWithCacheHandled, true, '/cs status should still work with cache entries');
  assert.ok(String(replies.at(-1)).includes('stale'), '/cs status should expose stale cache count/detail');
  assert.ok(String(replies.at(-1)).includes('旧缓存兜底'), '/cs status should expose stale fallback counter');

  const nonAdminStalePruneHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['cache', 'prune'],
    rawText: '/cs cache prune',
  });
  assert.strictEqual(nonAdminStalePruneHandled, true, '/cs cache prune should be handled even for non-admin');
  assert.ok(String(replies.at(-1)).includes('管理员'), '/cs cache prune should be admin-only');

  const stalePruneStatsBefore = hltv.getHltvStats();
  const stalePruneHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['cache', 'prune'],
    rawText: '/cs cache prune',
  });
  assert.strictEqual(stalePruneHandled, true, '/cs cache prune should be handled for admin');
  const stalePruneText = String(replies.at(-1));
  assert.ok(stalePruneText.includes('CS实时缓存 stale 清理'), '/cs cache prune should render stale prune report');
  assert.ok(stalePruneText.includes('只清理已过期的 CS 事实缓存'), '/cs cache prune should explain scoped cleanup');
  assert.ok(stalePruneText.includes('删除: results'), '/cs cache prune should remove stale results cache key');
  assert.ok(stalePruneText.includes('保留: 飞行请求'), '/cs cache prune should preserve in-flight/link-check boundary');
  assert.ok(stalePruneText.includes('miss 也不能反推没有比赛'), '/cs cache prune should preserve miss truth boundary');
  const stalePruneStatsAfter = hltv.getHltvStats();
  assert.ok(stalePruneStatsBefore.staleEntries > stalePruneStatsAfter.staleEntries, '/cs cache prune should reduce stale CS cache entries');
  assert.strictEqual(hltv.inspectHltvCacheEntry('results'), null, '/cs cache prune should remove stale results entry');

  const verifyAfterPruneHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['verify', 'results'],
    rawText: '/cs verify results',
  });
  assert.strictEqual(verifyAfterPruneHandled, true, '/cs verify results should work after stale prune');
  assert.ok(String(replies.at(-1)).includes('新鲜度: miss'), '/cs verify results after prune should report miss instead of stale');

  hltv.__test.setCacheEntryForTests(
    'results',
    [
      '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 15:30:00 / 链接 CS API: https://api.csapi.de/',
      '- Spirit 2:1 MOUZ',
    ].join('\n'),
    { ttlMs: 30 * 60 * 1000, ageMs: 5_000, source: 'test-fresh-results', fetchMs: 19 },
  );
  const warmResultsHandled = await csPlugin.handler({
    ...ctxBase,
    event: { ...ctxBase.event, user_id: 1 },
    command: 'cs',
    args: ['warm', 'results'],
    rawText: '/cs warm results',
  });
  assert.strictEqual(warmResultsHandled, true, '/cs warm results should be handled for admin');
  const warmResultsText = String(replies.at(-1));
  assert.ok(warmResultsText.includes('CS实时数据预热完成'), '/cs warm results should render prewarm report');
  assert.ok(warmResultsText.includes('预热后覆盖: fresh 1/1'), '/cs warm results should summarize post-warm freshness');
  assert.ok(warmResultsText.includes('预热后判定: 全部 fresh'), '/cs warm results should say fresh cache can support current snapshot wording');
  assert.ok(warmResultsText.includes('复核: /cs verify results；证据: /cs evidence results'), '/cs warm results should point to exact verify/evidence commands');
  assert.ok(warmResultsText.includes('别把 stale/miss 包装成实时事实'), '/cs warm results should preserve truth boundary');

  const naturalSent = [];
  const naturalConfig = makeConfigForHandler();
  const naturalBot = {
    getConfig: () => naturalConfig,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      naturalSent.push({ groupId, message });
      if (onMessageId) onMessageId(76_000 + naturalSent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: { sender: { user_id: 3853043835 } } }),
  };
  const naturalHandler = new MessageHandler(naturalBot);
  naturalHandler.use(csPlugin);
  naturalHandler.use(aiChat.aiChatPlugin);
  let aiFallbackCalls = 0;
  aiChat.__setLLMCallerForTests(async () => {
    aiFallbackCalls++;
    return 'AI fallback should not answer natural CS realtime questions';
  });
  csTest.setDataFetchersForTests({
    matches: async () => [
      '来源：CS API / 赛程测试 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '- 2026-06-08 Vitality vs NAVI BO3',
    ].join('\n'),
    ranking: async () => [
      '来源：CS API / VRS排名镜像 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      '#1 Vitality 2100分',
    ].join('\n'),
    player: async (subject) => [
      '来源：CS API / 选手统计 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      `${subject} 统计排名 #1`,
      'Rating: 1.536 (46图)',
    ].join('\n'),
    team: async (subject) => [
      '来源：CS API / VRS+队伍数据 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      `${subject} #1 2100分`,
      '当前阵容: apEX, ZywOo, flameZ, mezii, ropz',
    ].join('\n'),
    matchDetail: async (matchId) => [
      '来源：CS API / 单场详情 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
      `Match ID: ${matchId}`,
      `详情链接: https://api.csapi.de/matches/${matchId}`,
      'Spirit 2:0 9z BO3 (IEM Smoke) 胜者:Spirit',
      '选手亮点: donk(Spirit) Rating 2.55 K/D 48/16 ADR155.1 KAST93.3%',
    ].join('\n'),
  });
  try {
    naturalHandler.handleEvent(makePlainEvent(915, 28, '现在有CS比赛吗'));
    await waitFor(() => naturalSent.length === 1, 'natural CS match question');
    assert.ok(firstText(naturalSent[0].message).includes('CS实时问答'), 'natural match should be handled by cs plugin');
    assert.ok(firstText(naturalSent[0].message).includes('当前/即将比赛'), 'natural match should render match data');
    assert.ok(firstText(naturalSent[0].message).includes('事实预检'), 'natural match should append fact freshness preflight');
    assert.ok(firstText(naturalSent[0].message).includes('当前/即将比赛=fresh'), 'natural match fact preflight should expose fresh match cache');
    assert.ok(firstText(naturalSent[0].message).includes('/cs verify matches'), 'natural match fact preflight should suggest verify command');

    naturalHandler.handleEvent(makePlainEvent(916, 28, 'donk最近状态怎么样'));
    await waitFor(() => naturalSent.length === 2, 'natural CS player question');
    assert.ok(firstText(naturalSent[1].message).includes('选手数据'), 'natural player should render player data');
    assert.ok(firstText(naturalSent[1].message).includes('Rating: 1.536'), 'natural player should include structured player stat');
    assert.ok(firstText(naturalSent[1].message).includes('选手统计 donk=miss'), 'natural player fact preflight should expose missing player cache');
    assert.ok(firstText(naturalSent[1].message).includes('不能包装成“现在/最新/刚查HLTV”'), 'natural player miss should forbid current/latest wording');
    assert.ok(firstText(naturalSent[1].message).includes('/cs warm plan player donk'), 'natural player miss should suggest targeted warm plan');

    naturalHandler.handleEvent(makeEvent(917, 28, ' 现在排名'));
    await waitFor(() => naturalSent.length === 3, 'at natural CS ranking question');
    assert.ok(firstText(naturalSent[2].message).includes('CS2战队排名'), 'at natural ranking should be handled by cs plugin');
    assert.ok(firstText(naturalSent[2].message).includes('战队排名=fresh'), 'natural ranking fact preflight should expose fresh ranking cache');
    assert.ok(firstText(naturalSent[2].message).includes('可当当前快照'), 'natural ranking fresh should allow current snapshot with boundaries');

    naturalHandler.handleEvent(makePlainEvent(918, 28, '2390002这场谁C了'));
    await waitFor(() => naturalSent.length === 4, 'natural CS match id detail question');
    assert.ok(firstText(naturalSent[3].message).includes('CS单场详情'), 'natural match id should render match detail');
    assert.ok(firstText(naturalSent[3].message).includes('donk(Spirit) Rating 2.55'), 'natural match id should include player highlights');
    assert.ok(firstText(naturalSent[3].message).includes('单场详情 2390002=fresh'), 'natural match id fact preflight should inspect match cache');
    assert.ok(firstText(naturalSent[3].message).includes('/cs verify match 2390002'), 'natural match id fact preflight should suggest match verify command');
    assert.strictEqual(aiFallbackCalls, 0, 'natural CS plugin handling should not fall through to AI');
  } finally {
    csTest.setDataFetchersForTests();
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }

  const helpHandled = await csPlugin.handler({
    ...ctxBase,
    command: 'hltv',
    args: ['help'],
    rawText: '/hltv help',
  });
  assert.strictEqual(helpHandled, true, '/hltv alias should be handled by cs plugin');
  assert.ok(String(replies.at(-1)).includes('/cs brief'), 'cs help should show unified command entry');

  const nonAdminClear = await csPlugin.handler({
    ...ctxBase,
    command: 'cs',
    args: ['clear'],
    rawText: '/cs clear',
  });
  assert.strictEqual(nonAdminClear, true, '/cs clear should be handled even for non-admin');
  assert.ok(String(replies.at(-1)).includes('管理员'), '/cs clear should be admin-only');

  giftThanksTest.resetForTests();
  assert.strictEqual(
    giftThanksTest.isGiftNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'gift', gift_name: '小花' }),
    true,
    'gift notice helper should recognize gift-like notify events',
  );
  const giftLine = giftThanksTest.buildThanks('小花', 2);
  assert.ok(giftLine.includes('小花x2'), 'gift thanks should include gift name and count');
  assert.ok(giftLine.length <= 90, 'gift thanks should stay short enough for live-style chat');
  assert.ok(!/模板|核验|机器人|bot|不是本人/.test(giftLine), 'gift thanks should not leak knowledge metadata');
  assert.ok(giftThanksTest.buildThanks('烟花', 1).includes('烟花'), 'gift thanks should always include gift name');
  const comboGiftLine = giftThanksTest.buildThanks('烟花', 12);
  assert.ok(comboGiftLine.includes('烟花x12'), 'combo gift thanks should include count');
  assert.ok(/老板大气|连送|经济|起飞|士气|力度|真顶|有说法/.test(comboGiftLine), 'combo gift thanks should raise intensity');
  const streakGiftLine = giftThanksTest.buildThanks('小花', 1, { eventCount: 2, totalCount: 2, giftKinds: ['小花', '棒棒糖'] });
  assert.ok(/连送|连上|一串|第2手|经济|士气|有说法/.test(streakGiftLine), 'gift thanks should react to short-window combo gifts even when single gift count is small');
  assert.strictEqual(giftThanksTest.comboIntensity(1, { eventCount: 2, totalCount: 2, giftKinds: ['小花'] }), 'combo', 'combo gift window should raise normal gifts to combo intensity');
  assert.strictEqual(giftThanksTest.giftIntensity(1), 'normal', 'single gift should use normal intensity');
  assert.strictEqual(giftThanksTest.giftIntensity(8), 'combo', 'medium count gift should use combo intensity');
  assert.strictEqual(giftThanksTest.giftIntensity(20), 'big', 'large count gift should use big intensity');
  assert.strictEqual(
    giftThanksTest.shouldQueueGiftVoice({ enable_tts: false, gift_voice_enabled: true }, 6657, 20, { eventCount: 4, totalCount: 20, giftKinds: ['烟花'] }).ok,
    false,
    'gift voice should require TTS to be enabled',
  );

  const sent = [];
  const eventHandlers = [];
  config.ai.enable_tts = true;
  config.ai.tts_provider = 'local';
  config.ai.tts_local_timeout_ms = 5000;
  config.ai.tts_max_chars = 180;
  config.ai.gift_voice_enabled = true;
  config.ai.gift_voice_probability = 1;
  config.ai.gift_voice_cooldown_seconds = 0;
  config.ai.gift_voice_min_combo_events = 2;
  config.ai.gift_voice_min_total_count = 8;
  config.ai.tts_local_command = `"${process.execPath}" -e "const fs=require('fs');const out=process.env.QQBOT_TTS_OUTPUT;fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(260)]));console.log(out);"`;
  const bot = {
    getConfig: () => config,
    onEvent: (handler) => eventHandlers.push(handler),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(70_000 + sent.length);
      return true;
    },
  };
  registerGiftThanksListener(bot);
  for (const handler of eventHandlers) {
    handler({
      time: Math.floor(Date.now() / 1000),
      self_id: 3853043835,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'gift',
      group_id: 6657,
      user_id: 42,
      target_id: 3853043835,
      gift_name: '小花',
      gift_count: 2,
    });
  }
  await waitFor(() => sent.length === 1, 'gift thanks listener');
  assert.strictEqual(sent[0].groupId, 6657);
  assert.strictEqual(sent[0].message[0]?.type, 'at', 'gift thanks should at the sender');
  assert.ok(firstText(sent[0].message).includes('小花x2'), 'gift thanks listener should include gift name and count');
  let giftStats = giftThanksTest.getGiftThanksStats();
  assert.strictEqual(giftStats.totalGiftNotices, 1, 'gift stats should count received gift notices');
  assert.strictEqual(giftStats.sentThanks, 1, 'gift stats should count sent thanks');
  assert.strictEqual(giftStats.lastGiftTrace.action, 'sent', 'gift trace should record sent action');
  assert.strictEqual(giftStats.lastGiftTrace.voiceAction, 'skipped', 'normal gift should not queue voice below threshold');
  assert.ok(giftStats.lastGiftTrace.voiceCacheBefore.includes('状态='), 'skipped gift voice trace should still capture TTS cache status');
  assert.ok(giftStats.lastGiftTrace.voiceCacheBefore.includes('key='), 'skipped gift voice trace should expose TTS cache key');

  for (const handler of eventHandlers) {
    handler({
      time: Math.floor(Date.now() / 1000),
      self_id: 3853043835,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'gift',
      group_id: 6657,
      user_id: 42,
      target_id: 3853043835,
      gift_name: '小花',
      gift_count: 2,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(sent.length, 1, 'duplicate gift should be throttled');
  giftStats = giftThanksTest.getGiftThanksStats();
  assert.strictEqual(giftStats.throttledThanks, 1, 'gift stats should count throttled duplicate');
  assert.strictEqual(giftStats.lastGiftTrace.action, 'throttled', 'gift trace should record throttle action');

  for (const handler of eventHandlers) {
    handler({
      time: Math.floor(Date.now() / 1000),
      self_id: 3853043835,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'gift',
      group_id: 6657,
      user_id: 42,
      target_id: 3853043835,
      gift_name: '棒棒糖',
      gift_count: 3,
    });
  }
  await waitFor(() => sent.length >= 2, 'gift combo window listener');
  assert.ok(firstText(sent[1].message).includes('棒棒糖x3'), 'gift combo listener should include second gift name and count');
  await waitFor(() => sent.length >= 3, 'gift combo voice listener');
  assert.ok(sent[2].message.some((seg) => seg.type === 'record'), 'gift combo listener should append a TTS record when voice gate passes');
  giftStats = giftThanksTest.getGiftThanksStats();
  assert.strictEqual(giftStats.sentThanks, 2, 'gift stats should count second non-throttled gift');
  assert.strictEqual(giftStats.lastGiftTrace.action, 'sent', 'gift combo trace should be sent');
  assert.strictEqual(giftStats.lastGiftTrace.reason, 'combo', 'gift combo trace should record combo reason');
  assert.strictEqual(giftStats.lastGiftTrace.comboEvents, 2, 'gift combo trace should count short-window gift events');
  assert.strictEqual(giftStats.lastGiftTrace.comboTotal, 5, 'gift combo trace should accumulate short-window gift count');
  assert.strictEqual(giftStats.giftVoiceAttempts, 1, 'gift voice stats should count TTS attempts');
  assert.strictEqual(giftStats.giftVoiceSent, 1, 'gift voice stats should count sent voice thanks');
  assert.strictEqual(giftStats.lastGiftTrace.voiceAction, 'sent', 'gift trace should record sent voice action');
  assert.ok(giftStats.lastGiftTrace.voiceCacheBefore.includes('状态='), 'gift voice trace should capture pre-send TTS cache status');
  assert.ok(giftStats.lastGiftTrace.voiceCacheAfter.includes('状态=hit'), 'gift voice trace should capture post-send TTS cache hit');
  assert.ok(giftStats.lastGiftTrace.voiceCacheAfter.includes('key='), 'gift voice trace should expose TTS cache key');

  for (const handler of eventHandlers) {
    handler({
      time: Math.floor(Date.now() / 1000),
      self_id: 3853043835,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'gift',
      group_id: 6657,
      user_id: 43,
      target_id: 999999,
      gift_name: '小花',
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(sent.length, 3, 'gift thanks should ignore gifts sent to someone else');
  giftStats = giftThanksTest.getGiftThanksStats();
  assert.strictEqual(giftStats.ignoredThanks, 1, 'gift stats should count ignored non-bot target');
  assert.strictEqual(giftStats.lastGiftTrace.action, 'ignored', 'gift trace should record ignored action');
  assert.ok(giftThanksTest.formatGiftThanksStatus().includes('礼物感谢状态'), 'gift status formatter should render status panel');
  assert.ok(giftThanksTest.formatGiftThanksStatus().includes('连送窗口'), 'gift status formatter should expose combo window state');
  assert.ok(giftThanksTest.formatGiftThanksStatus().includes('最近记录'), 'gift status formatter should expose recent trace count');
  assert.ok(giftThanksTest.formatGiftThanksTrace().includes('礼物感谢 trace'), 'gift trace formatter should render trace panel');
  assert.ok(giftThanksTest.formatGiftThanksTrace().includes('gift target is not bot'), 'gift trace formatter should expose latest decision reason');
  const giftRecentPanel = giftThanksTest.formatGiftThanksRecent(5);
  assert.ok(giftRecentPanel.includes('礼物感谢最近记录'), 'gift recent formatter should render recent trace panel');
  assert.ok(giftRecentPanel.includes('gift target is not bot'), 'gift recent formatter should include ignored decision reasons');
  assert.ok(giftRecentPanel.includes('sent/combo'), 'gift recent formatter should keep earlier sent combo event');
  assert.ok(giftRecentPanel.includes('cache=状态='), 'gift recent formatter should keep voice cache evidence for sent voice events');
  assert.ok(giftRecentPanel.includes('throttled/20s duplicate'), 'gift recent formatter should keep throttled duplicate event');
  assert.ok(giftThanksTest.getGiftThanksStats().recentTraces >= 4, 'gift stats should expose recent trace buffer size');
  const previewBefore = giftThanksTest.getGiftThanksStats();
  const voiceStatsBeforeGiftPreview = tts.getVoiceStats(config.ai);
  const previewText = giftThanksTest.formatGiftThanksPreview(config.ai, '烟花', 12, 6657);
  assert.ok(previewText.includes('礼物感谢预检'), 'gift preview formatter should render preflight panel');
  assert.ok(previewText.includes('烟花x12'), 'gift preview formatter should include gift count');
  assert.ok(previewText.includes('语音预判: 可触发'), 'gift preview formatter should expose voice eligibility');
  assert.ok(previewText.includes('门槛:'), 'gift preview formatter should expose voice thresholds');
  assert.ok(previewText.includes('概率:'), 'gift preview formatter should expose voice probability');
  assert.ok(previewText.includes('TTS:'), 'gift preview formatter should expose TTS runtime state');
  assert.ok(previewText.includes('语音文本:'), 'gift preview formatter should expose exact voice text');
  assert.ok(previewText.includes('语音缓存:'), 'gift preview formatter should expose TTS cache preflight');
  assert.ok(previewText.includes('状态='), 'gift preview formatter should expose voice cache status');
  assert.ok(previewText.includes('key='), 'gift preview formatter should expose voice cache key');
  assert.ok(previewText.includes('拟态模板'), 'gift preview formatter should not claim verified original quotes');
  assert.ok(previewText.includes('这里只预览'), 'gift preview formatter should say it does not mutate runtime state');
  assert.strictEqual(giftThanksTest.getGiftThanksStats().giftVoiceAttempts, previewBefore.giftVoiceAttempts, 'gift preview should not enqueue TTS');
  const voiceStatsAfterGiftPreview = tts.getVoiceStats(config.ai);
  assert.strictEqual(voiceStatsAfterGiftPreview.hits, voiceStatsBeforeGiftPreview.hits, 'gift preview voice cache inspect should not increment TTS hits');
  assert.strictEqual(voiceStatsAfterGiftPreview.misses, voiceStatsBeforeGiftPreview.misses, 'gift preview voice cache inspect should not increment TTS misses');

  const warmGiftName = `预热烟花${Date.now()}`;
  const warmBefore = giftThanksTest.getGiftThanksStats();
  const warmVoiceStatsBefore = tts.getVoiceStats(config.ai);
  const giftWarmPanel = await giftThanksTest.warmGiftThanksVoice(config.ai, warmGiftName, 12, 6657, {
    generate: (voiceText) => tts.generateVoice(config.ai, voiceText),
  });
  assert.ok(giftWarmPanel.includes('礼物语音预热'), 'gift warm formatter should render warm panel');
  assert.ok(giftWarmPanel.includes(`${warmGiftName}x12`), 'gift warm should use the requested gift/count');
  assert.ok(giftWarmPanel.includes('预热前: 状态=miss'), 'gift warm should expose before-cache miss for unseen text');
  assert.ok(giftWarmPanel.includes('预热动作: generated'), 'gift warm should actually generate missing TTS cache');
  assert.ok(giftWarmPanel.includes('预热后: 状态=hit'), 'gift warm should re-inspect cache after generation');
  assert.ok(giftWarmPanel.includes('不发送 record'), 'gift warm should disclose that it does not send voice');
  assert.strictEqual(giftThanksTest.getGiftThanksStats().giftVoiceAttempts, warmBefore.giftVoiceAttempts, 'gift warm should not count as real gift voice attempt');
  const warmVoiceStatsAfter = tts.getVoiceStats(config.ai);
  assert.ok(warmVoiceStatsAfter.misses >= warmVoiceStatsBefore.misses + 1, 'gift warm should increment TTS miss counter when generating');

  const giftStatusSent = [];
  const giftStatusBot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      giftStatusSent.push({ groupId, message });
      if (onMessageId) onMessageId(71_000 + giftStatusSent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const giftStatusHandler = new MessageHandler(giftStatusBot);
  giftStatusHandler.use(aiChat.aiChatPlugin);
  giftStatusHandler.handleEvent(makePlainEvent(918, 2, '/gift status'));
  await waitFor(() => giftStatusSent.length === 1, 'gift status command');
  assert.ok(firstText(giftStatusSent[0].message).includes('礼物感谢状态'), '/gift status should render gift thanks stats');
  assert.ok(firstText(giftStatusSent[0].message).includes('节流'), '/gift status should expose throttle stats');
  giftStatusHandler.handleEvent(makePlainEvent(919, 2, '/gift trace'));
  await waitFor(() => giftStatusSent.length === 2, 'gift trace command');
  assert.ok(firstText(giftStatusSent[1].message).includes('礼物感谢 trace'), '/gift trace should render latest trace');
  assert.ok(firstText(giftStatusSent[1].message).includes('判定:'), '/gift trace should expose latest decision');
  giftStatusHandler.handleEvent(makePlainEvent(925, 2, '/gift recent 3'));
  await waitFor(() => giftStatusSent.length === 3, 'gift recent command');
  assert.ok(firstText(giftStatusSent[2].message).includes('礼物感谢最近记录'), '/gift recent should render recent trace list');
  assert.ok(firstText(giftStatusSent[2].message).includes('voice='), '/gift recent should expose voice decisions');
  assert.ok(firstText(giftStatusSent[2].message).includes('cache='), '/gift recent should expose voice cache evidence when available');
  giftStatusHandler.handleEvent(makePlainEvent(920, 2, '/gift 烟花 12'));
  await waitFor(() => giftStatusSent.length === 4, 'gift combo preview command');
  assert.ok(firstText(giftStatusSent[3].message).includes('烟花x12'), '/gift preview should parse count');
  assert.ok(/老板大气|连送|经济|起飞|士气|力度|真顶|有说法/.test(firstText(giftStatusSent[3].message)), '/gift preview should use combo intensity');
  giftStatusHandler.handleEvent(makePlainEvent(921, 2, '/gift check 烟花 12'));
  await waitFor(() => giftStatusSent.length === 5, 'gift voice preflight command');
  const giftCheckText = firstText(giftStatusSent[4].message);
  assert.ok(giftCheckText.includes('礼物感谢预检'), '/gift check should render preflight panel');
  assert.ok(giftCheckText.includes('语音预判'), '/gift check should expose voice preflight');
  assert.ok(giftCheckText.includes('门槛:'), '/gift check should expose voice gate thresholds');
  assert.ok(giftCheckText.includes('TTS:'), '/gift check should expose TTS state');
  assert.ok(giftCheckText.includes('语音缓存:'), '/gift check should expose voice cache preflight');
  assert.ok(giftCheckText.includes('这里只预览'), '/gift check should not pretend it sent voice');
  giftStatusHandler.handleEvent(makePlainEvent(922, 2, '/gift cache 烟花 12'));
  await waitFor(() => giftStatusSent.length === 6, 'gift cache preflight command');
  const giftCacheText = firstText(giftStatusSent[5].message);
  assert.ok(giftCacheText.includes('礼物感谢预检'), '/gift cache should reuse gift preflight panel');
  assert.ok(giftCacheText.includes('语音缓存:'), '/gift cache should expose voice cache status');
  giftStatusHandler.handleEvent(makePlainEvent(923, 2, '/gift warm 烟花 12'));
  await waitFor(() => giftStatusSent.length === 7, 'gift warm non-admin guard');
  assert.ok(firstText(giftStatusSent[6].message).includes('管理员'), '/gift warm should be admin-only because it generates TTS');
  giftStatusHandler.handleEvent(makePlainEvent(924, 1, `/gift warm 命令预热${Date.now()} 12`));
  await waitFor(() => giftStatusSent.length === 8, 'gift warm command');
  const giftWarmText = firstText(giftStatusSent[7].message);
  assert.ok(giftWarmText.includes('礼物语音预热'), '/gift warm should render warm panel');
  assert.ok(giftWarmText.includes('预热后: 状态=hit'), '/gift warm should report post-generation cache hit');
  assert.ok(giftWarmText.includes('不写入礼物节流'), '/gift warm should not mutate gift event state');
  aiChat.shutdownAiChat();
}

async function testCsWatchPlugin() {
  const config = makeConfigForHandler();
  const storePath = path.resolve(__dirname, '..', 'data', `cs-watch-smoke-${Date.now()}.json`);
  const sent = [];
  let teamVersion = 1;
  let matchVersion = 1;
  let teamRoster = 'a, b, c';
  let teamMaps = 'Inferno 2/8 25% / Mirage 7/10 70%';
  let playerRating = '1.234';
  let playerAdr = '82.1';
  let matchLine = '⏰ 明天 20:00  NAVI vs Vitality BO3 (Smoke Cup)';
  csWatchTest.__setStorePathForTests(storePath);
  csWatchTest.__setProfileFetcherForTests(async (kind, subject) => [
    `来源：CS API / ${kind}测试 / 拉取 2026/6/8 14:20:00 / 链接 CS API: https://api.csapi.de/`,
    `${subject} smoke snapshot v${kind === 'team' ? teamVersion : kind === 'match' ? matchVersion : 1}`,
    kind === 'team'
      ? [`当前阵容: ${teamRoster}`, `地图样本: ${teamMaps}`].join('\n')
      : kind === 'match'
        ? `【当前/即将比赛】\n${matchLine}\n【近期赛果】NAVI 2:1 G2`
        : [
          `Rating: ${playerRating} (12图)`,
          `ADR: ${playerAdr}`,
          'KAST: 72.5%',
          'K/D: 1.30 (130/100)',
        ].join('\n'),
  ].join('\n'));

  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(97_000 + sent.length);
      return true;
    },
    sendPrivateMessage: async (userId, message, onMessageId) => {
      sent.push({ userId, message });
      if (onMessageId) onMessageId(98_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(csWatchPlugin);

  try {
    handler.handleEvent(makePlainEvent(930, 30, '/watch team Vitality'));
    await waitFor(() => sent.length === 1, 'watch team add');
    assert.ok(firstText(sent[0].message).includes('已订阅'), 'watch add should confirm subscription');
    assert.ok(fs.existsSync(storePath), 'watch add should persist store file');
    assert.strictEqual(csWatchTest.loadStore().subscriptions.length, 1, 'watch store should contain one subscription');

    handler.handleEvent(makePlainEvent(935, 30, '/watch match NAVI'));
    await waitFor(() => sent.length === 2, 'watch match add');
    assert.ok(firstText(sent[1].message).includes('赛程/赛果 NAVI'), 'watch match should create match subscription');
    assert.strictEqual(csWatchTest.loadStore().subscriptions.length, 2, 'watch store should contain match subscription');

    handler.handleEvent(makePlainEvent(931, 30, '/watch list'));
    await waitFor(() => sent.length === 3, 'watch list');
    assert.ok(firstText(sent[2].message).includes('Vitality'), 'watch list should show team subject');
    assert.ok(firstText(sent[2].message).includes('赛程/赛果 NAVI'), 'watch list should show match subject');

    teamVersion = 2;
    matchVersion = 2;
    teamRoster = 'a, c, d';
    handler.handleEvent(makePlainEvent(932, 30, '/watch now'));
    await waitFor(() => sent.length === 6, 'watch now change notification');
    assert.ok(firstText(sent[3].message).includes('CS阵容变化提醒'), 'watch now should send roster change notification');
    assert.ok(firstText(sent[3].message).includes('新增: d'), 'watch roster change should include added player');
    assert.ok(firstText(sent[3].message).includes('移出: b'), 'watch roster change should include removed player');
    assert.ok(firstText(sent[3].message).includes('证据:'), 'watch roster change should include evidence line');
    assert.ok(firstText(sent[3].message).includes('snapshot v2'), 'watch roster change should include changed profile');
    assert.ok(firstText(sent[4].message).includes('赛程/赛果 NAVI'), 'watch now should send match notification');
    assert.ok(firstText(sent[5].message).includes('检查2'), 'watch now should send summary for both subscriptions');
    assert.ok(firstText(sent[5].message).includes('阵容1'), 'watch now summary should count roster changes');
    const teamSubAfterRoster = csWatchTest.loadStore().subscriptions.find((item) => item.subject === 'Vitality' && item.kind === 'team');
    assert.ok(teamSubAfterRoster.lastRosterMembers.includes('d'), 'watch roster change should persist latest roster');
    assert.ok(teamSubAfterRoster.lastRosterChangeAt, 'watch roster change should persist change time');
    assert.ok(teamSubAfterRoster.lastMapStats.some((item) => item.map === 'Inferno' && item.winRate === 25), 'watch team should persist initial map sample');

    teamVersion = 3;
    teamMaps = 'Inferno 5/10 50% / Mirage 7/10 70%';
    const mapRun = await csWatchTest.runCsWatchChecks(bot, { chatType: 'group', chatId: 6657, notify: true });
    assert.strictEqual(mapRun.mapChanges, 1, 'watch team should count map stat changes');
    assert.strictEqual(mapRun.notified, 1, 'watch team map change should count as notification');
    await waitFor(() => sent.length === 7, 'watch team map stat change');
    const mapChangeText = firstText(sent[6].message);
    assert.ok(mapChangeText.includes('CS地图样本变化提醒'), 'watch team map change should have title');
    assert.ok(mapChangeText.includes('Inferno'), 'watch team map change should include changed map');
    assert.ok(mapChangeText.includes('2/8 25%'), 'watch team map change should include previous map stat');
    assert.ok(mapChangeText.includes('5/10 50%'), 'watch team map change should include current map stat');
    assert.ok(mapChangeText.includes('证据:'), 'watch team map change should include evidence line');
    const teamSubAfterMap = csWatchTest.loadStore().subscriptions.find((item) => item.subject === 'Vitality' && item.kind === 'team');
    assert.ok(teamSubAfterMap.lastMapStats.some((item) => item.map === 'Inferno' && item.winRate === 50), 'watch team should persist latest map sample');
    assert.ok(teamSubAfterMap.lastMapChangeAt, 'watch team should persist map change time');

    handler.handleEvent(makePlainEvent(933, 31, '关注 donk'));
    await waitFor(() => sent.length === 8, 'natural watch player');
    assert.ok(firstText(sent[7].message).includes('已订阅'), 'natural watch should add subscription');
    assert.strictEqual(csWatchTest.parseNaturalWatch('关注 donk').kind, 'player', 'natural watch should infer known player');
    assert.strictEqual(csWatchTest.parseNaturalWatch('关注 NAVI 比赛').kind, 'match', 'natural watch should infer match subscriptions');

    const id = csWatchTest.loadStore().subscriptions.find((item) => item.subject === 'Vitality')?.id;
    handler.handleEvent(makePlainEvent(934, 30, `/watch remove ${id}`));
    await waitFor(() => sent.length === 9, 'watch remove');
    assert.ok(firstText(sent[8].message).includes('已移除'), 'watch remove should confirm deletion');

    playerRating = '1.300';
    playerAdr = '85.4';
    const playerRun = await csWatchTest.runCsWatchChecks(bot, { chatType: 'group', chatId: 6657, notify: true });
    assert.strictEqual(playerRun.playerChanges, 1, 'watch player should count structured stat changes');
    assert.strictEqual(playerRun.notified, 1, 'watch player stat change should count as notification');
    await waitFor(() => sent.length === 10, 'watch player stat change');
    const playerChangeText = firstText(sent[9].message);
    assert.ok(playerChangeText.includes('CS选手数据变化提醒'), 'watch player stat change should have title');
    assert.ok(playerChangeText.includes('Rating: 1.234 -> 1.300'), 'watch player stat change should include rating delta');
    assert.ok(playerChangeText.includes('ADR: 82.1 -> 85.4'), 'watch player stat change should include ADR delta');
    assert.ok(playerChangeText.includes('证据:'), 'watch player stat change should include evidence line');
    const playerSubAfterChange = csWatchTest.loadStore().subscriptions.find((item) => item.subject === 'donk' && item.kind === 'player');
    assert.strictEqual(playerSubAfterChange.lastPlayerStats.rating, 1.3, 'watch player should persist latest rating');
    assert.ok(playerSubAfterChange.lastPlayerChangeAt, 'watch player should persist change time');

    matchLine = '⏰ 今天 20:00  NAVI vs Vitality BO3 (Smoke Cup)';
    const reminderNow = Date.parse('2026-06-08T11:30:00Z');
    const reminderRun = await csWatchTest.runCsWatchChecks(bot, { chatType: 'group', chatId: 6657, notify: true, now: reminderNow });
    assert.strictEqual(reminderRun.startReminders, 1, 'watch match should send one start reminder inside reminder window');
    assert.strictEqual(reminderRun.notified, 1, 'watch match start reminder should count as notification');
    await waitFor(() => sent.length === 11, 'watch match start reminder');
    const reminderText = firstText(sent[10].message);
    assert.ok(reminderText.includes('CS开赛提醒'), 'watch match start reminder should have title');
    assert.ok(reminderText.includes('NAVI vs Vitality'), 'watch match start reminder should include matchup');
    assert.ok(reminderText.includes('证据:'), 'watch match start reminder should include evidence');
    assert.ok(reminderText.includes('CS API'), 'watch match start reminder should cite source');
    const matchSub = csWatchTest.loadStore().subscriptions.find((item) => item.subject === 'NAVI' && item.kind === 'match');
    assert.ok(matchSub.lastStartReminderKey, 'watch match should persist start reminder dedupe key');
    assert.ok(matchSub.lastStartReminderAt, 'watch match should persist start reminder time');

    const duplicateReminderRun = await csWatchTest.runCsWatchChecks(bot, { chatType: 'group', chatId: 6657, notify: true, now: reminderNow + 5 * 60 * 1000 });
    assert.strictEqual(duplicateReminderRun.startReminders, 0, 'watch match should not repeat same start reminder');
    assert.strictEqual(sent.length, 11, 'duplicate watch match start reminder should not send another message');

    const storeBeforePlan = JSON.stringify(csWatchTest.loadStore());
    handler.handleEvent(makePlainEvent(936, 30, '/watch plan'));
    await waitFor(() => sent.length === 12, 'watch plan');
    const watchPlanText = firstText(sent[11].message);
    assert.ok(watchPlanText.includes('CS订阅预检'), 'watch plan should render preflight title');
    assert.ok(watchPlanText.includes('只读'), 'watch plan should be explicitly read-only');
    assert.ok(watchPlanText.includes('预热计划'), 'watch plan should include prewarm plan');
    assert.ok(watchPlanText.includes('计划事实类型覆盖:'), 'watch plan should expose planned typed fact coverage');
    assert.ok(watchPlanText.includes('赛程/赛果/单场:'), 'watch plan typed coverage should include match/result fact type');
    assert.ok(watchPlanText.includes('选手数据/状态:'), 'watch plan typed coverage should include player fact type');
    assert.ok(watchPlanText.includes('ranking fresh 不能替代阵容/转会证据'), 'watch plan typed coverage should keep roster truth boundary');
    assert.ok(watchPlanText.includes('/cs warm plan'), 'watch plan should suggest exact warm plan commands');
    assert.ok(watchPlanText.includes('边界'), 'watch plan should expose realtime data boundary');
    assert.strictEqual(JSON.stringify(csWatchTest.loadStore()), storeBeforePlan, 'watch plan should not mutate subscriptions');
  } finally {
    csWatchTest.resetForTests();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  }
}

async function testCsReportPlugin() {
  const config = makeConfigForHandler();
  const storePath = path.resolve(__dirname, '..', 'data', `cs-report-smoke-${Date.now()}.json`);
  const watchStorePath = path.resolve(__dirname, '..', 'data', `cs-report-watch-smoke-${Date.now()}.json`);
  const predictStorePath = path.resolve(__dirname, '..', 'data', `cs-report-predict-smoke-${Date.now()}.json`);
  const sent = [];
  let reportBuilds = 0;
  const prewarmCalls = [];
  csReportTest.__setStorePathForTests(storePath);
  csWatchTest.__setStorePathForTests(watchStorePath);
  csPredictTest.setStorePathForTests(predictStorePath);
  csWatchTest.__setProfileFetcherForTests(async (kind, subject) => [
    `来源：CS API / ${kind}日报关注测试 / 拉取 2026/6/8 14:20:00 / 链接 CS API: https://api.csapi.de/`,
    `${subject} report watch snapshot`,
    kind === 'team' ? '当前阵容: flameZ, ZywOo, apEX' : 'Rating: 1.234 (12图)',
  ].join('\n'));
  csReportTest.__setReportBuilderForTests(async () => {
    reportBuilds++;
    return [
      'CS每日报 | smoke',
      '【当前/即将比赛】',
      'Vitality vs NAVI',
      '【最近赛果】',
      'Spirit 2:0 G2',
      '机器短评：日报只认来源时间和链接。',
    ].join('\n');
  });
  csReportTest.__setPrewarmRunnerForTests(async (options) => {
    prewarmCalls.push(options);
    return { targetCount: 4, ok: 4, failed: 0, durationMs: 12, rows: [] };
  });

  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(99_000 + sent.length);
      return true;
    },
    sendPrivateMessage: async (userId, message, onMessageId) => {
      sent.push({ userId, message });
      if (onMessageId) onMessageId(100_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(csReportPlugin);
  handler.use(csWatchPlugin);
  handler.use(csPredictPlugin);

  try {
    assert.strictEqual(csReportTest.normalizeReportTime('930'), '09:30', 'compact report time should normalize');
    assert.strictEqual(csReportTest.normalizeReportTime('24:00'), null, 'invalid report time should be rejected');
    assert.strictEqual(csReportTest.parseNaturalReportSubscribe('订阅CS日报 09:45'), '09:45', 'natural daily report subscribe should parse time');

    handler.handleEvent(makePlainEvent(939, 30, '/watch team Vitality'));
    await waitFor(() => sent.length === 1, 'watch subscription for report digest');
    assert.ok(firstText(sent[0].message).includes('已订阅'), 'watch subscription should be created before report digest');

    handler.handleEvent(makePlainEvent(938, 1, '/predict open Vitality vs NAVI bo3 close=30m'));
    await waitFor(() => sent.length === 2, 'predict market for report digest');
    const marketId = (firstText(sent[1].message).match(/(pred-[a-f0-9]+)/) || [])[1];
    assert.ok(marketId, 'predict market should expose id for report digest');

    handler.handleEvent(makePlainEvent(937, 30, `/predict ${marketId} A 2-1`));
    await waitFor(() => sent.length === 3, 'predict pick for report digest');

    handler.handleEvent(makePlainEvent(940, 30, '/csreport on 08:15'));
    await waitFor(() => sent.length === 4, 'cs report subscribe');
    assert.ok(firstText(sent[3].message).includes('CS日报已开启'), 'cs report subscribe should confirm');
    assert.ok(fs.existsSync(storePath), 'cs report subscribe should persist store file');
    assert.strictEqual(csReportTest.loadStore().subscriptions.length, 1, 'cs report store should contain one subscription');

    handler.handleEvent(makePlainEvent(941, 30, '/csreport status'));
    await waitFor(() => sent.length === 5, 'cs report status');
    assert.ok(firstText(sent[4].message).includes('08:15'), 'cs report status should show configured time');

    hltv.clearHltvCache();
    hltv.__test.setCacheEntryForTests(
      'matches',
      [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '⏰ 今天 20:00  Vitality vs NAVI Bo3 (Smoke Cup)',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 7_000, source: 'test-report-check-matches', fetchMs: 17 },
    );
    hltv.__test.setCacheEntryForTests(
      'results',
      [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
        '- NAVI 2:0 Vitality',
      ].join('\n'),
      { ttlMs: -1_000, ageMs: 20_000, source: 'test-report-check-stale-results', fetchMs: 21 },
    );
    hltv.__test.setCacheEntryForTests(
      'ranking',
      [
        '来源：CS API / VRS排名镜像 2026-06-08 / 拉取 2026/6/8 15:20:00 / 链接 CS API: https://api.csapi.de/',
        '#1 Vitality 2100分',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 12_000, source: 'test-report-check-ranking', fetchMs: 23 },
    );
    const reportCheckStatsBefore = hltv.getHltvStats();
    const reportCheckReplies = [];
    const reportCheckHandled = await csReportPlugin.handler({
      bot,
      chatType: 'group',
      chatId: 6657,
      groupId: 6657,
      event: { user_id: 30 },
      command: 'csreport',
      args: ['check'],
      rawText: '/csreport check',
      reply: (message) => reportCheckReplies.push(message),
      replyAt: (message) => reportCheckReplies.push(message),
      isPrivate: false,
    });
    assert.strictEqual(reportCheckHandled, true, '/csreport check should be handled by cs report plugin');
    const reportCheckText = String(reportCheckReplies.at(-1));
    assert.ok(reportCheckText.includes('CS日报预检'), '/csreport check should render a read-only report preflight');
    assert.ok(reportCheckText.includes('当前会话: 已开启 08:15'), '/csreport check should show current report subscription');
    assert.ok(reportCheckText.includes('本会话关注: 1个'), '/csreport check should summarize watch targets');
    assert.ok(reportCheckText.includes('Vitality'), '/csreport check should include watched/predict target names');
    assert.ok(reportCheckText.includes('本会话竞猜预热目标: 2个'), '/csreport check should summarize predict prewarm targets');
    assert.ok(reportCheckText.includes('竞猜核心缓存: matches / results 已纳入预热计划'), '/csreport check should expose predict core match/result prewarm coverage');
    assert.ok(reportCheckText.includes('matches [matches]: HIT'), '/csreport check should show fresh match cache as hit');
    assert.ok(reportCheckText.includes('results [results]: REFRESH'), '/csreport check should show stale result cache as refresh-needed');
    assert.ok(reportCheckText.includes('计划事实类型覆盖:'), '/csreport check should expose planned typed fact coverage');
    assert.ok(reportCheckText.includes('results REFRESH(stale)'), '/csreport check typed coverage should expose stale result refresh');
    assert.ok(reportCheckText.includes('ranking fresh 不能替代阵容/转会证据'), '/csreport check typed coverage should keep roster truth boundary');
    assert.ok(reportCheckText.includes('/cs warm plan results'), '/csreport check should suggest targeted result prewarm plan');
    assert.ok(reportCheckText.includes('/cs warm results'), '/csreport check should suggest targeted result prewarm');
    assert.ok(reportCheckText.includes('预计请求'), '/csreport check should count future prewarm requests');
    assert.ok(reportCheckText.includes('只读预检，不生成日报、不请求外站'), '/csreport check should clarify read-only behavior');
    assert.ok(reportCheckText.includes('管理员 /csreport due'), '/csreport check should point admins to the real due runner');
    const reportCheckStatsAfter = hltv.getHltvStats();
    assert.strictEqual(reportCheckStatsAfter.hits, reportCheckStatsBefore.hits, '/csreport check should not increment CS cache hits');
    assert.strictEqual(reportCheckStatsAfter.misses, reportCheckStatsBefore.misses, '/csreport check should not increment CS cache misses');
    assert.strictEqual(reportBuilds, 0, '/csreport check should not build the full report');
    assert.strictEqual(prewarmCalls.length, 0, '/csreport check should not call the report prewarm runner');

    const prewarmOnly = await csReportTest.runDueCsReports(bot, new Date('2026-06-08T00:10:00Z'));
    assert.strictEqual(prewarmOnly.due, 0, 'cs report prewarm window should not send before configured time');
    assert.strictEqual(prewarmOnly.sent, 0, 'cs report prewarm window should not send a report');
    assert.strictEqual(prewarmOnly.prewarmed, 1, 'cs report should prewarm shortly before due time');
    assert.strictEqual(prewarmOnly.prewarmTargets, 4, 'cs report prewarm should expose target count');
    assert.strictEqual(sent.length, 5, 'cs report prewarm should not emit chat messages');
    assert.strictEqual(reportBuilds, 0, 'cs report prewarm should not build the full report');
    assert.strictEqual(prewarmCalls.length, 1, 'cs report prewarm runner should be called once');
    assert.deepStrictEqual(prewarmCalls[0].chats, [{ chatType: 'group', chatId: 6657 }], 'cs report prewarm should scope watched/predict targets to due chats');

    const parallelReplies = [];
    const makeReportContext = (args, rawText) => ({
      bot,
      chatType: 'group',
      chatId: 6657,
      groupId: 6657,
      event: { user_id: 30 },
      command: 'csreport',
      args,
      rawText,
      reply: (message) => parallelReplies.push(String(message)),
      replyAt: (message) => parallelReplies.push(String(message)),
      isPrivate: false,
    });
    await Promise.all([
      csReportPlugin.handler(makeReportContext(['now'], '/csreport now')),
      csReportPlugin.handler(makeReportContext(['focus'], '/csreport focus')),
    ]);
    assert.strictEqual(parallelReplies.length, 2, 'parallel cs report calls should both reply');
    assert.ok(parallelReplies.some((text) => text.includes('CS每日报')), 'parallel cs report should include full report');
    assert.ok(parallelReplies.some((text) => text.includes('CS今日看点')), 'parallel cs report should include focus report');
    assert.strictEqual(reportBuilds, 1, 'parallel cs report now/focus should single-flight one base report build');
    const reportCacheStatsAfterParallel = csReportTest.getCsReportStatsForTests();
    assert.ok(reportCacheStatsAfterParallel.baseReportCacheWarm, 'cs report base cache should be warm after build');
    assert.ok(reportCacheStatsAfterParallel.baseReportInFlightHits >= 1, 'parallel cs report should count in-flight cache merge');

    handler.handleEvent(makePlainEvent(942, 30, '/csreport now'));
    await waitFor(() => sent.length === 6, 'cs report now');
    const nowReportText = firstText(sent[5].message);
    assert.ok(nowReportText.includes('CS每日报'), 'cs report now should render report');
    assert.ok(nowReportText.includes('本群优先看'), 'cs report now should prioritize watched targets before the base report');
    assert.ok(nowReportText.indexOf('本群优先看') < nowReportText.indexOf('CS每日报'), 'watch preference highlights should appear before base report');
    assert.ok(nowReportText.includes('Vitality / 当前/即将比赛: Vitality vs NAVI'), 'watch preference highlights should include matching report lines');
    assert.ok(nowReportText.includes('本会话关注目标'), 'cs report now should append watch digest');
    assert.ok(nowReportText.includes('Vitality report watch snapshot'), 'cs report now should include watched team snapshot');
    assert.ok(nowReportText.includes('本会话CS竞猜'), 'cs report now should append predict digest');
    assert.ok(nowReportText.includes(marketId), 'cs report now should include active predict market');
    assert.ok(nowReportText.includes('数据证据摘要'), 'cs report now should append unified data evidence summary');
    assert.ok(nowReportText.includes('核心缓存: matches=fresh / results=stale / ranking=fresh'), 'cs report evidence summary should expose core cache freshness');
    assert.ok(nowReportText.includes('过期快照: results[results]'), 'cs report evidence summary should list stale cache targets');
    assert.ok(nowReportText.includes('本地无快照:'), 'cs report evidence summary should list missing dynamic cache targets');
    assert.ok(nowReportText.includes('stale 只能当旧快照线索'), 'cs report evidence summary should explain stale boundary');
    assert.strictEqual(reportBuilds, 1, 'cs report now should reuse warm base report cache');

    handler.handleEvent(makePlainEvent(946, 30, '/csreport focus'));
    await waitFor(() => sent.length === 7, 'cs report focus');
    const focusReportText = firstText(sent[6].message);
    assert.ok(focusReportText.includes('CS今日看点'), 'cs report focus should render one-screen title');
    assert.ok(focusReportText.includes('先看:'), 'cs report focus should include lead section');
    assert.ok(focusReportText.includes('盯变化:'), 'cs report focus should include watch section');
    assert.ok(focusReportText.includes('竞猜:'), 'cs report focus should include predict section');
    assert.ok(focusReportText.includes('Vitality / 当前/即将比赛'), 'cs report focus should prioritize watched report lines');
    assert.ok(focusReportText.includes('本会话CS竞猜'), 'cs report focus should include predict digest');
    assert.ok(focusReportText.includes('证据:'), 'cs report focus should expose evidence status');
    assert.ok(focusReportText.includes('边界:'), 'cs report focus should explain stale/miss boundary');
    assert.ok(focusReportText.length < nowReportText.length, 'cs report focus should be shorter than full report');
    assert.strictEqual(reportBuilds, 1, 'cs report focus should reuse warm base report cache');

    const due = await csReportTest.runDueCsReports(bot, new Date('2026-06-08T01:30:00Z'));
    assert.strictEqual(due.due, 1, 'cs report should be due after configured Shanghai time');
    assert.strictEqual(due.sent, 1, 'cs report due run should send report');
    assert.strictEqual(due.prewarmed, 0, 'cs report should not duplicate same-day prewarm at send time');
    assert.strictEqual(prewarmCalls.length, 1, 'cs report due send should reuse earlier prewarm key');
    await waitFor(() => sent.length === 8, 'cs report due send');
    assert.ok(String(sent[7].message).includes('Vitality vs NAVI'), 'cs report due send should include report content');
    assert.ok(String(sent[7].message).includes('本群优先看'), 'cs report due send should include watch preference highlights');
    assert.ok(String(sent[7].message).includes('本会话关注目标'), 'cs report due send should include watch digest');
    assert.ok(String(sent[7].message).includes('本会话CS竞猜'), 'cs report due send should include predict digest');
    assert.ok(String(sent[7].message).includes('数据证据摘要'), 'cs report due send should include data evidence summary');
    assert.strictEqual(reportBuilds, 1, 'cs report due send should reuse warm base report cache');

    const again = await csReportTest.runDueCsReports(bot, new Date('2026-06-08T02:00:00Z'));
    assert.strictEqual(again.due, 0, 'cs report should not send twice on same Shanghai date');
    assert.strictEqual(sent.length, 8, 'same-day cs report run should not send again');
    assert.strictEqual(reportBuilds, 1, 'report builder should stay single build while base cache is warm');
    const reportCacheStatsAfterReuse = csReportTest.getCsReportStatsForTests();
    assert.ok(reportCacheStatsAfterReuse.baseReportCacheHits >= 3, 'cs report base cache should count reuse across now/focus/due');

    handler.handleEvent(makePlainEvent(943, 30, '/csreport off'));
    await waitFor(() => sent.length === 9, 'cs report off');
    assert.ok(firstText(sent[8].message).includes('已关闭'), 'cs report off should remove current chat subscription');

    handler.handleEvent(makePlainEvent(944, 30, '订阅CS日报 09:45'));
    await waitFor(() => sent.length === 10, 'natural cs report subscribe');
    assert.ok(firstText(sent[9].message).includes('09:45'), 'natural cs report subscribe should set requested time');

    if (fs.existsSync(predictStorePath)) fs.unlinkSync(predictStorePath);
    csPredictTest.setRealtimeFetchersForTests({
      matches: async () => [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 14:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '⏰ 今天 20:00  FaZe vs G2 Bo3 (IEM Smoke)',
      ].join('\n'),
    });
    hltv.__test.setCacheEntryForTests(
      'matches',
      [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 14:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '⏰ 今天 20:00  FaZe vs G2 Bo3 (IEM Smoke)',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-report-candidate-matches', fetchMs: 14 },
    );
    handler.handleEvent(makePlainEvent(945, 30, '/csreport now'));
    await waitFor(() => sent.length === 11, 'cs report predict candidates');
    const candidateReportText = firstText(sent[10].message);
    assert.ok(candidateReportText.includes('本会话CS竞猜'), 'cs report candidate digest should keep predict section title');
    assert.ok(candidateReportText.includes('可开盘候选'), 'cs report should append realtime predict candidates when no markets exist');
    assert.ok(candidateReportText.includes('FaZe vs G2'), 'cs report predict candidates should include realtime match teams');
    assert.ok(candidateReportText.includes('竞猜赛程事实类型覆盖:'), 'cs report candidate digest should expose schedule fact coverage');
    assert.ok(candidateReportText.includes('matches HIT(fresh)'), 'cs report candidate digest should mark matches cache fresh');
    assert.ok(candidateReportText.includes('赛程来源边界: matches=fresh'), 'cs report candidate digest should expose schedule freshness boundary');
    assert.ok(candidateReportText.includes('openmatch 1'), 'cs report predict candidates should include one-tap open command');
  } finally {
    csReportTest.resetForTests();
    csWatchTest.resetForTests();
    csPredictTest.resetForTests();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    if (fs.existsSync(watchStorePath)) fs.unlinkSync(watchStorePath);
    if (fs.existsSync(predictStorePath)) fs.unlinkSync(predictStorePath);
  }
}

async function testCsPredictPlugin() {
  const config = makeConfigForHandler();
  const sent = [];
  const storePath = path.resolve(__dirname, '..', 'data', `cs-predict-smoke-${Date.now()}.json`);
  const bot = {
    getConfig: () => config,
    getRuntimeStats: () => makeRuntimeStats(),
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(101_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(csPredictPlugin);
  handler.use(funPlugin);
  csPredictTest.setStorePathForTests(storePath);
  csPredictTest.setRealtimeFetchersForTests({
    matches: async () => [
      '来源：Liquipedia赛程 / 拉取 2026/6/8 14:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
      '⏰ 今天 20:00  FaZe vs G2 Bo3 (IEM Smoke) 地图: Inferno',
    ].join('\n'),
    results: async () => [
      '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 23:20:00 / 链接 CS API: https://api.csapi.de/',
      '- 2026-06-08  FaZe 2:1 G2 BO3 (IEM Smoke) 胜者:FaZe matchid=2390100 ranks=#4/#7 [Inferno 13-8]',
    ].join('\n'),
  });
  try {
    handler.handleEvent(makePlainEvent(950, 2, '/predict open NAVI vs Vitality bo3 close=10m'));
    await waitFor(() => sent.length === 1, 'non-admin predict open');
    assert.ok(firstText(sent[0].message).includes('管理员'), 'predict open should be admin-only');

    handler.handleEvent(makePlainEvent(951, 1, '/predict open NAVI vs Vitality bo3 event BLAST Smoke close=10m'));
    await waitFor(() => sent.length === 2, 'admin predict open');
    const openText = firstText(sent[1].message);
    assert.ok(openText.includes('CS竞猜已开盘'), 'predict open should create a market');
    assert.ok(openText.includes('赛事 BLAST Smoke'), 'predict open should record optional event tag');
    const id = (openText.match(/(pred-[a-f0-9]+)/) || [])[1];
    assert.ok(id, 'predict open should expose market id');

    handler.handleEvent(makePlainEvent(952, 2, `/predict ${id} A 2-1 map Inferno`));
    await waitFor(() => sent.length === 3, 'predict pick A');
    assert.ok(firstText(sent[2].message).includes('预测已记录'), 'predict should record first user pick');
    assert.ok(firstText(sent[2].message).includes('地图 Inferno'), 'predict should record optional map tag');

    handler.handleEvent(makePlainEvent(953, 3, `/predict ${id} B 2-1`));
    await waitFor(() => sent.length === 4, 'predict pick B');
    assert.ok(firstText(sent[3].message).includes('Vitality 2-1'), 'predict should accept team B score');

    handler.handleEvent(makePlainEvent(954, 4, '竞猜榜'));
    await waitFor(() => sent.length === 5, 'natural empty predict board');
    assert.ok(firstText(sent[4].message).includes('还没有 CS 竞猜积分'), 'natural predict board should be routed');

    handler.handleEvent(makePlainEvent(955, 1, `/predict settle ${id} A 2-1`));
    await waitFor(() => sent.length === 6, 'predict settle');
    const settleText = firstText(sent[5].message);
    assert.ok(settleText.includes('CS竞猜已结算'), 'predict settle should settle market');
    assert.ok(settleText.includes('user2 +5'), 'predict settle should award exact score');
    assert.ok(settleText.includes('证据:'), 'predict manual settle should include evidence line');
    assert.ok(settleText.includes('管理员手动结算'), 'predict manual settle should record manual evidence');
    assert.ok(settleText.includes('地图 Inferno'), 'predict settle should show prediction map hit');

    const manualStore = csPredictTest.loadStoreForTests();
    const manualMarket = manualStore.markets.find((market) => market.id === id);
    assert.ok(manualMarket, 'predict manual settle should persist market');
    assert.strictEqual(manualMarket.event, 'BLAST Smoke', 'predict should persist market event');
    const user2Prediction = manualMarket.predictions.find((prediction) => prediction.userId === 2);
    assert.strictEqual(user2Prediction.map, 'Inferno', 'predict should persist prediction map');
    const user2Score = manualStore.scores.find((entry) => entry.userId === 2);
    assert.ok(user2Score, 'predict should persist user score row');
    assert.ok(user2Score.mapStats.some((stat) => stat.map === 'Inferno' && stat.points === 5 && stat.total === 1), 'predict should persist map-dimension stats');
    assert.ok(user2Score.eventStats.some((stat) => stat.event === 'BLAST Smoke' && stat.points === 5 && stat.total === 1), 'predict should persist event-dimension stats');

    handler.handleEvent(makePlainEvent(956, 2, '/predict board'));
    await waitFor(() => sent.length === 7, 'predict board');
    const boardText = firstText(sent[6].message);
    assert.ok(boardText.includes('CS竞猜积分榜'), 'predict board should render leaderboard');
    assert.ok(boardText.includes('user2 5分'), 'predict board should include awarded points');

    const stats = getCsPredictStats();
    assert.ok(stats.settledMarkets >= 1, 'predict stats should count settled markets');
    assert.ok(stats.predictions >= 2, 'predict stats should count predictions');
    assert.ok(stats.eventStats >= 1, 'predict stats should expose event-dimension stats');

    hltv.__test.setCacheEntryForTests(
      'matches',
      [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 14:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '⏰ 今天 20:00  FaZe vs G2 Bo3 (IEM Smoke) 地图: Inferno',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 4_000, source: 'test-predict-matches', fetchMs: 16 },
    );
    handler.handleEvent(makePlainEvent(957, 2, '/predict matches'));
    await waitFor(() => sent.length === 8, 'predict realtime matches');
    const predictMatchesText = firstText(sent[7].message);
    assert.ok(predictMatchesText.includes('CS实时赛程候选'), 'predict matches should render realtime candidates');
    assert.ok(predictMatchesText.includes('FaZe vs G2'), 'predict matches should parse realtime match candidates');
    assert.ok(predictMatchesText.includes('地图 Inferno'), 'predict matches should expose realtime map hint');
    assert.ok(predictMatchesText.includes('证据:'), 'predict matches should expose data evidence');
    assert.ok(predictMatchesText.includes('竞猜赛程事实类型覆盖:'), 'predict matches should expose typed fact coverage');
    assert.ok(predictMatchesText.includes('matches HIT(fresh)'), 'predict matches should mark schedule candidates as fresh when cache is fresh');
    assert.ok(predictMatchesText.includes('赛程来源边界: matches=fresh'), 'predict matches should expose schedule cache freshness boundary');
    assert.ok(predictMatchesText.includes('/cs verify matches'), 'predict matches should point to match schedule verification');

    handler.handleEvent(makePlainEvent(958, 1, '/predict openmatch 1 close=10m'));
    await waitFor(() => sent.length === 9, 'predict openmatch');
    const realtimeOpenText = firstText(sent[8].message);
    assert.ok(realtimeOpenText.includes('CS竞猜已开盘'), 'predict openmatch should create market from realtime candidate');
    assert.ok(realtimeOpenText.includes('FaZe vs G2'), 'predict openmatch should use realtime teams');
    assert.ok(realtimeOpenText.includes('赛事 IEM Smoke'), 'predict openmatch should persist realtime event');
    assert.ok(realtimeOpenText.includes('地图 Inferno'), 'predict openmatch should persist realtime map hint');
    assert.ok(realtimeOpenText.includes('赛程来源边界: matches=fresh'), 'predict openmatch should preserve schedule cache freshness boundary');
    const realtimeId = (realtimeOpenText.match(/(pred-[a-f0-9]+)/) || [])[1];
    assert.ok(realtimeId, 'predict openmatch should expose market id');

    handler.handleEvent(makePlainEvent(959, 5, `/predict ${realtimeId} A 2-1`));
    await waitFor(() => sent.length === 10, 'predict realtime pick');
    assert.ok(firstText(sent[9].message).includes('FaZe 2-1'), 'predict realtime market should accept picks');
    assert.ok(firstText(sent[9].message).includes('地图 Inferno'), 'predict realtime pick should inherit openmatch map');

    hltv.__test.setCacheEntryForTests(
      'results',
      [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/8 23:20:00 / 链接 CS API: https://api.csapi.de/',
        '- 2026-06-08  FaZe 2:1 G2 BO3 (IEM Smoke) 胜者:FaZe matchid=2390100 ranks=#4/#7 [Inferno 13-8]',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-results', fetchMs: 17 },
    );
    handler.handleEvent(makePlainEvent(960, 1, '/predict autosettle'));
    await waitFor(() => sent.length === 11, 'predict autosettle');
    const autoText = firstText(sent[10].message);
    assert.ok(autoText.includes('CS竞猜自动结算'), 'predict autosettle should render report');
    assert.ok(autoText.includes('结算: 1个'), 'predict autosettle should settle matching market');
    assert.ok(autoText.includes('FaZe 2:1 G2'), 'predict autosettle should cite matched result');
    assert.ok(autoText.includes('地图: Inferno'), 'predict autosettle should retain realtime map evidence');
    assert.ok(autoText.includes('证据:'), 'predict autosettle should include evidence line');
    assert.ok(autoText.includes('CS API / HLTV赛果镜像'), 'predict autosettle should cite result source');
    assert.ok(autoText.includes('竞猜赛果事实类型覆盖:'), 'predict autosettle should expose result fact coverage');
    assert.ok(autoText.includes('results HIT(fresh)'), 'predict autosettle should mark results cache fresh');
    assert.ok(autoText.includes('赛果来源边界: results=fresh'), 'predict autosettle should expose results freshness boundary');

    handler.handleEvent(makePlainEvent(961, 1, '/predict openmatch 1 close=10m'));
    await waitFor(() => sent.length === 12, 'predict auto task openmatch');
    const autoTaskOpenText = firstText(sent[11].message);
    const autoTaskId = (autoTaskOpenText.match(/(pred-[a-f0-9]+)/) || [])[1];
    assert.ok(autoTaskId, 'predict auto task market should expose id');

    handler.handleEvent(makePlainEvent(962, 6, `/predict ${autoTaskId} A 2-1`));
    await waitFor(() => sent.length === 13, 'predict auto task pick');

    const autoRun = await csPredictTest.runCsPredictAutoSettle(bot);
    assert.strictEqual(autoRun.checked, 1, 'predict background auto settle should check active market');
    assert.strictEqual(autoRun.settled, 1, 'predict background auto settle should settle matching market');
    assert.strictEqual(autoRun.sent, 1, 'predict background auto settle should notify chat');
    await waitFor(() => sent.length === 14, 'predict background auto settle notification');
    assert.ok(firstText(sent[13].message).includes('CS竞猜自动结算提醒'), 'predict background auto settle should send notification');
    assert.ok(firstText(sent[13].message).includes('看榜: /predict board'), 'predict background auto settle notification should include next action');
    assert.ok(firstText(sent[13].message).includes('CS API / HLTV赛果镜像'), 'predict background auto settle notification should include source evidence');
    assert.ok(firstText(sent[13].message).includes('竞猜赛果事实类型覆盖:'), 'predict background auto settle notification should expose result fact coverage');
    assert.ok(firstText(sent[13].message).includes('results HIT(fresh)'), 'predict background auto settle notification should mark results cache fresh');
    assert.ok(firstText(sent[13].message).includes('赛果来源边界: results=fresh'), 'predict background auto settle notification should expose results freshness boundary');

    const settledAutoMarket = csPredictTest.loadStoreForTests().markets.find((market) => market.id === autoTaskId);
    assert.ok(settledAutoMarket, 'predict background auto settle should persist settled market');
    assert.ok(settledAutoMarket.settledResultLabel.includes('FaZe 2:1 G2'), 'predict background auto settle should persist result label');
    assert.strictEqual(settledAutoMarket.map, 'Inferno', 'predict background auto settle should persist realtime map');
    assert.ok(settledAutoMarket.settledSourceLine.includes('HLTV赛果镜像'), 'predict background auto settle should persist source line');
    assert.strictEqual(settledAutoMarket.settledEvidenceType, 'auto', 'predict background auto settle should persist evidence type');

    const digest = await buildCsPredictDigestForChat('group', 6657, { maxRecent: 5, maxChars: 4000 });
    assert.ok(digest.includes('结算证据'), 'predict digest should include settled evidence');
    assert.ok(digest.includes('FaZe 2:1 G2'), 'predict digest should include settled result label');
    assert.ok(digest.includes('HLTV赛果镜像'), 'predict digest should include settled source line');
    assert.ok(digest.includes('赛事 IEM Smoke'), 'predict digest should include realtime event tag');
    assert.ok(digest.includes('地图 Inferno'), 'predict digest should include realtime map tag');

    const statsAfterAuto = getCsPredictStats();
    assert.ok(statsAfterAuto.lastRunSettled >= 1, 'predict stats should expose background settled count');
    assert.ok(statsAfterAuto.lastRunSent >= 1, 'predict stats should expose background notification count');

    handler.handleEvent(makePlainEvent(963, 1, '/predict notify on 15m'));
    await waitFor(() => sent.length === 15, 'predict candidate notify on');
    assert.ok(firstText(sent[14].message).includes('开盘候选提醒已开启'), 'predict notify on should enable candidate reminders');

    hltv.__test.setCacheEntryForTests(
      'matches',
      [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 14:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '⏰ 今天 20:00  FaZe vs G2 Bo3 (IEM Smoke) 地图: Inferno',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-notify-matches', fetchMs: 16 },
    );
    const candidateRun = await csPredictTest.runCsPredictCandidateNotifications(bot, new Date('2026-06-08T12:00:00Z'));
    assert.strictEqual(candidateRun.checked, 1, 'predict candidate notifier should check enabled subscriptions');
    assert.strictEqual(candidateRun.due, 1, 'predict candidate notifier should find due subscription');
    assert.strictEqual(candidateRun.sent, 1, 'predict candidate notifier should send first candidate reminder');
    await waitFor(() => sent.length === 16, 'predict candidate notify send');
    assert.ok(firstText(sent[15].message).includes('CS竞猜开盘候选提醒'), 'predict candidate notification should have title');
    assert.ok(firstText(sent[15].message).includes('FaZe vs G2'), 'predict candidate notification should include realtime teams');
    assert.ok(firstText(sent[15].message).includes('地图 Inferno'), 'predict candidate notification should include realtime map hint');
    assert.ok(firstText(sent[15].message).includes('证据:'), 'predict candidate notification should include data evidence');
    assert.ok(firstText(sent[15].message).includes('竞猜赛程事实类型覆盖:'), 'predict candidate notification should expose schedule fact coverage');
    assert.ok(firstText(sent[15].message).includes('matches HIT(fresh)'), 'predict candidate notification should mark matches cache fresh');
    assert.ok(firstText(sent[15].message).includes('赛程来源边界: matches=fresh'), 'predict candidate notification should expose schedule freshness boundary');

    const duplicateRun = await csPredictTest.runCsPredictCandidateNotifications(bot, new Date('2026-06-08T12:16:00Z'));
    assert.strictEqual(duplicateRun.sent, 0, 'predict candidate notifier should not resend same candidates too soon');
    assert.strictEqual(duplicateRun.skipped, 1, 'predict candidate notifier should count duplicate skip');
    assert.strictEqual(sent.length, 16, 'duplicate predict candidate reminder should not send another message');

    handler.handleEvent(makePlainEvent(964, 2, '/predict notify status'));
    await waitFor(() => sent.length === 17, 'predict candidate notify status');
    assert.ok(firstText(sent[16].message).includes('已开启'), 'predict notify status should show enabled state');
    assert.ok(!firstText(sent[16].message).includes('上次推送: 无'), 'predict notify status should expose last candidate send time');

    handler.handleEvent(makePlainEvent(965, 1, '/predict notify off'));
    await waitFor(() => sent.length === 18, 'predict candidate notify off');
    assert.ok(firstText(sent[17].message).includes('已关闭'), 'predict notify off should disable candidate reminders');

    handler.handleEvent(makePlainEvent(966, 2, '竞猜赛季榜'));
    await waitFor(() => sent.length === 19, 'predict season board natural');
    assert.ok(firstText(sent[18].message).includes('CS竞猜积分榜(赛季榜)'), 'natural predict season board should render season leaderboard');
    assert.ok(firstText(sent[18].message).includes('user2 5分'), 'season leaderboard should include settled prediction points');

    handler.handleEvent(makePlainEvent(967, 2, '/cstrain'));
    await waitFor(() => sent.length === 20, 'predict-personalized cs training');
    assert.ok(firstText(sent[19].message).includes('今日CS训练'), 'personalized cs training should still render training plan');
    assert.ok(firstText(sent[19].message).includes('竞猜表现'), 'cs training should include prediction performance hint when scores exist');
    assert.ok(firstText(sent[19].message).includes('Inferno'), 'cs training should include prediction map hint when map stats exist');
    assert.ok(firstText(sent[19].message).includes('BLAST Smoke'), 'cs training should include prediction event hint when event stats exist');

    handler.handleEvent(makePlainEvent(968, 2, '/predict map Inferno'));
    await waitFor(() => sent.length === 21, 'predict map board');
    assert.ok(firstText(sent[20].message).includes('CS竞猜地图榜'), 'predict map board should render map leaderboard');
    assert.ok(firstText(sent[20].message).includes('Inferno'), 'predict map board should include requested map');
    assert.ok(firstText(sent[20].message).includes('user2 Inferno 5分'), 'predict map board should include map-dimension points');

    handler.handleEvent(makePlainEvent(969, 2, '/predict event BLAST Smoke'));
    await waitFor(() => sent.length === 22, 'predict event board');
    assert.ok(firstText(sent[21].message).includes('CS竞猜赛事榜'), 'predict event board should render event leaderboard');
    assert.ok(firstText(sent[21].message).includes('BLAST Smoke'), 'predict event board should include requested event');
    assert.ok(firstText(sent[21].message).includes('user2 BLAST Smoke 5分'), 'predict event board should include event-dimension points');

    handler.handleEvent(makePlainEvent(970, 1, '/predict season start 夏季赛'));
    await waitFor(() => sent.length === 23, 'predict named season start');
    const seasonStartText = firstText(sent[22].message);
    assert.ok(seasonStartText.includes('CS竞猜赛季已开启'), 'predict season start should create named season');
    assert.ok(seasonStartText.includes('夏季赛'), 'predict season start should persist season name');
    const seasonId = (seasonStartText.match(/(season-[a-f0-9]+)/) || [])[1];
    assert.ok(seasonId, 'predict season start should expose season id');

    handler.handleEvent(makePlainEvent(971, 1, '/predict open Liquid vs MOUZ bo3 event Cologne close=10m'));
    await waitFor(() => sent.length === 24, 'predict season market open');
    const seasonMarketText = firstText(sent[23].message);
    const seasonMarketId = (seasonMarketText.match(/(pred-[a-f0-9]+)/) || [])[1];
    assert.ok(seasonMarketId, 'predict season market should expose id');

    handler.handleEvent(makePlainEvent(972, 2, `/predict ${seasonMarketId} A 2-0`));
    await waitFor(() => sent.length === 25, 'predict season pick');

    handler.handleEvent(makePlainEvent(973, 1, `/predict settle ${seasonMarketId} A 2-0`));
    await waitFor(() => sent.length === 26, 'predict season settle');
    assert.ok(firstText(sent[25].message).includes('CS竞猜已结算'), 'predict season market should settle');

    handler.handleEvent(makePlainEvent(974, 2, '/predict season board'));
    await waitFor(() => sent.length === 27, 'predict named season board');
    assert.ok(firstText(sent[26].message).includes('CS竞猜积分榜(赛季榜)'), 'predict named season board should keep season board title');
    assert.ok(firstText(sent[26].message).includes('夏季赛'), 'predict named season board should include season name');
    assert.ok(firstText(sent[26].message).includes('user2 5分'), 'predict named season board should include points since season start');

    handler.handleEvent(makePlainEvent(975, 2, '/predict board season'));
    await waitFor(() => sent.length === 28, 'predict board season named season fallback');
    assert.ok(firstText(sent[27].message).includes('夏季赛'), 'predict board season should prefer active named season');

    const seasonStats = getCsPredictStats();
    assert.ok(seasonStats.seasons >= 1, 'predict stats should expose season count');
    assert.ok(seasonStats.activeSeasons >= 1, 'predict stats should expose active season count');

    handler.handleEvent(makePlainEvent(976, 1, '/predict season archive'));
    await waitFor(() => sent.length === 29, 'predict named season archive');
    assert.ok(firstText(sent[28].message).includes('CS竞猜赛季已归档'), 'predict season archive should archive active season');

    handler.handleEvent(makePlainEvent(977, 2, `/predict season board ${seasonId}`));
    await waitFor(() => sent.length === 30, 'predict archived season board');
    assert.ok(firstText(sent[29].message).includes('已归档'), 'predict archived season board should show archived status');
    assert.ok(firstText(sent[29].message).includes('user2 5分'), 'predict archived season board should keep historical points');

    handler.handleEvent(makePlainEvent(978, 2, '/predict season list'));
    await waitFor(() => sent.length === 31, 'predict season list');
    assert.ok(firstText(sent[30].message).includes('CS竞猜赛季列表'), 'predict season list should render list');
    assert.ok(firstText(sent[30].message).includes('夏季赛'), 'predict season list should include archived season');

    const storeBeforeVetoPreview = JSON.stringify(csPredictTest.loadStoreForTests());
    const vetoAnalysis = csPredictTest.analyzeMapVetoPreview(['Inferno', 'Mirage', 'Nuke']);
    assert.strictEqual(vetoAnalysis.mode, 'pool', 'predict veto analysis should classify multiple maps as pool');
    assert.ok(vetoAnalysis.statScope.includes('多图地图池'), 'predict veto analysis should expose pool stat boundary');
    assert.ok(vetoAnalysis.openOption.includes('mappool Inferno / Mirage / Nuke'), 'predict veto analysis should suggest mappool open option');
    handler.handleEvent(makePlainEvent(979, 2, '/predict veto Inferno Mirage Nuke'));
    await waitFor(() => sent.length === 32, 'predict veto preview');
    const vetoPreviewText = firstText(sent[31].message);
    assert.ok(vetoPreviewText.includes('CS地图池/veto预检'), 'predict veto preview should render title');
    assert.ok(vetoPreviewText.includes('识别地图: Inferno / Mirage / Nuke'), 'predict veto preview should parse space-separated map pool');
    assert.ok(vetoPreviewText.includes('多图地图池'), 'predict veto preview should explain multi-map stats boundary');
    assert.ok(vetoPreviewText.includes('本命令不联网'), 'predict veto preview should expose source boundary');
    assert.strictEqual(JSON.stringify(csPredictTest.loadStoreForTests()), storeBeforeVetoPreview, 'predict veto preview should not mutate store');

    handler.handleEvent(makePlainEvent(980, 2, '/predict mapcheck map Inferno'));
    await waitFor(() => sent.length === 33, 'predict single map preview');
    const singleMapPreviewText = firstText(sent[32].message);
    assert.ok(singleMapPreviewText.includes('统计归属: 单图 Inferno'), 'predict mapcheck should explain single-map stats path');
    assert.ok(singleMapPreviewText.includes('/predict <id> A 2-1 map Inferno'), 'predict mapcheck should suggest single-map pick syntax');

    hltv.__test.setCacheEntryForTests(
      'match:2390004',
      [
        '来源：CS API / 单场详情 / 拉取 2026/6/8 18:20:00 / 链接 CS API: https://api.csapi.de/',
        'Match ID: 2390004',
        '详情链接: https://api.csapi.de/matches/2390004',
        'Spirit 2:1 G2 BO3 (IEM Smoke) 胜者:Spirit',
        '地图池线索: Mirage / Nuke',
        '竞猜地图: 多图 Mirage / Nuke 只作为 mappool 线索；单张图统计按实际单图下注或结算证据走。',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-match-map', fetchMs: 18 },
    );
    const storeBeforeMatchMapPreview = JSON.stringify(csPredictTest.loadStoreForTests());
    handler.handleEvent(makePlainEvent(981, 2, '/predict matchmap 2390004'));
    await waitFor(() => sent.length === 34, 'predict match map preview');
    const matchMapPreviewText = firstText(sent[33].message);
    assert.ok(matchMapPreviewText.includes('CS单场地图线索预检'), 'predict matchmap should render title');
    assert.ok(matchMapPreviewText.includes('Match ID: 2390004'), 'predict matchmap should expose match id');
    assert.ok(matchMapPreviewText.includes('识别地图: Mirage / Nuke'), 'predict matchmap should parse CS API match map pool');
    assert.ok(matchMapPreviewText.includes('开盘参数: mappool Mirage / Nuke'), 'predict matchmap should suggest mappool open option');
    assert.ok(matchMapPreviewText.includes('/predict open Spirit vs G2 bo3'), 'predict matchmap should suggest an open command from match teams');
    assert.ok(matchMapPreviewText.includes('竞猜事实类型覆盖:'), 'predict matchmap should expose typed fact coverage for betting evidence');
    assert.ok(matchMapPreviewText.includes('单场详情 目标1个 HIT 1 / REFRESH 0；match:2390004=HIT(fresh)'), 'predict matchmap should scope coverage to the single match detail');
    assert.ok(matchMapPreviewText.includes('match:<id> 只覆盖对应比赛局部表现'), 'predict matchmap should keep player-stat coverage local to the match');
    assert.ok(matchMapPreviewText.includes('版本/地图池: 目标1个 HIT 1 / REFRESH 0；match:2390004=HIT(fresh)'), 'predict matchmap should expose map-pool coverage as match-scoped');
    assert.ok(matchMapPreviewText.includes('/cs verify match 2390004'), 'predict matchmap should point to exact match verification');
    assert.ok(matchMapPreviewText.includes('/cs evidence match 2390004'), 'predict matchmap should point to exact match evidence');
    assert.ok(matchMapPreviewText.includes('/cs hltvcheck 2390004'), 'predict matchmap should include HLTV candidate verification');
    assert.ok(matchMapPreviewText.includes('不等于赛前 HLTV 官方 veto/pick-ban'), 'predict matchmap should preserve veto source boundary');
    assert.strictEqual(JSON.stringify(csPredictTest.loadStoreForTests()), storeBeforeMatchMapPreview, 'predict matchmap preview should not mutate store');

    handler.handleEvent(makePlainEvent(984, 1, '/predict open Astralis vs HEROIC bo3 mappool Inferno/Mirage/Nuke close=10m'));
    await waitFor(() => sent.length === 35, 'predict mappool market open');
    const mapPoolOpenText = firstText(sent[34].message);
    assert.ok(mapPoolOpenText.includes('地图线索 Inferno / Mirage / Nuke'), 'predict open should persist map pool hint');
    assert.ok(mapPoolOpenText.includes('地图池边界'), 'predict open should explain map pool boundary');
    const mapPoolMarket = csPredictTest.loadStoreForTests().markets.find((market) => market.teamA === 'Astralis' && market.teamB === 'HEROIC');
    assert.ok(mapPoolMarket, 'predict mappool market should persist');
    assert.ok(csPredictTest.formatMarketMapEvidenceLine(mapPoolMarket).includes('不能自动拆分进地图榜'), 'predict mappool evidence should be reusable');

    handler.handleEvent(makePlainEvent(985, 2, '/predict list'));
    await waitFor(() => sent.length === 36, 'predict list with mappool boundary');
    assert.ok(firstText(sent[35].message).includes('地图池边界'), 'predict list should include map pool boundary for active markets');

    const mapPoolDigest = await buildCsPredictDigestForChat('group', 6657, { maxActive: 5, maxRecent: 5, maxChars: 5000 });
    assert.ok(mapPoolDigest.includes('地图池边界'), 'predict digest should include reusable map pool boundary');

    handler.handleEvent(makePlainEvent(986, 2, '/cstrain'));
    await waitFor(() => sent.length === 37, 'predict mappool-personalized cs training');
    assert.ok(firstText(sent[36].message).includes('当前盘口地图池'), 'cs training should include active mappool hint from predict markets');
    assert.ok(firstText(sent[36].message).includes('别把 mappool 当地图榜分数'), 'cs training should preserve mappool truth boundary');

    csPredictTest.setRealtimeFetchersForTests({
      matches: async () => [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '今日赛事很多，但这条 smoke 文本故意不含双方对阵的标准格式。',
      ].join('\n'),
    });
    hltv.__test.setCacheEntryForTests(
      'matches',
      [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '今日赛事很多，但这条 smoke 文本故意不含双方对阵的标准格式。',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-unparsed-matches', fetchMs: 13 },
    );
    handler.handleEvent(makePlainEvent(987, 2, '/predict matches'));
    await waitFor(() => sent.length === 38, 'predict matches unparsed boundary');
    const unparsedMatchesText = firstText(sent[37].message);
    assert.ok(unparsedMatchesText.includes('这次没解析到明确的 TeamA vs TeamB 赛程'), 'predict matches should report unparsed candidates');
    assert.ok(unparsedMatchesText.includes('竞猜赛程事实类型覆盖:'), 'predict matches unparsed should expose schedule fact coverage');
    assert.ok(unparsedMatchesText.includes('matches HIT(fresh)'), 'predict matches unparsed should keep matches cache freshness');
    assert.ok(unparsedMatchesText.includes('候选解析边界'), 'predict matches unparsed should explain parsing boundary');
    assert.ok(unparsedMatchesText.includes('不能反推今天没有比赛'), 'predict matches unparsed should forbid no-schedule inference');

    handler.handleEvent(makePlainEvent(988, 2, '/predict notify check'));
    await waitFor(() => sent.length === 39, 'predict notify check unparsed boundary');
    const unparsedNotifyCheckText = firstText(sent[38].message);
    assert.ok(unparsedNotifyCheckText.includes('CS竞猜开盘候选检查'), 'predict notify check should render check title');
    assert.ok(unparsedNotifyCheckText.includes('matches HIT(fresh)'), 'predict notify check unparsed should keep matches cache freshness');
    assert.ok(unparsedNotifyCheckText.includes('候选解析边界'), 'predict notify check unparsed should explain parsing boundary');
    assert.ok(unparsedNotifyCheckText.includes('不能反推今天没有比赛'), 'predict notify check unparsed should forbid no-schedule inference');

    handler.handleEvent(makePlainEvent(989, 1, '/predict openmatch 9 close=10m'));
    await waitFor(() => sent.length === 40, 'predict openmatch unparsed boundary');
    const unparsedOpenMatchText = firstText(sent[39].message);
    assert.ok(unparsedOpenMatchText.includes('没找到第 9 个赛程候选'), 'predict openmatch missing candidate should report requested index');
    assert.ok(unparsedOpenMatchText.includes('matches HIT(fresh)'), 'predict openmatch missing candidate should keep matches cache freshness');
    assert.ok(unparsedOpenMatchText.includes('候选解析边界'), 'predict openmatch missing candidate should explain parsing boundary');
    assert.ok(unparsedOpenMatchText.includes('不能反推今天没有比赛'), 'predict openmatch missing candidate should forbid no-schedule inference');

    csPredictTest.setRealtimeFetchersForTests({
      matches: async () => [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '今日赛事很多，但这条 smoke 文本故意不含双方对阵的标准格式。',
      ].join('\n'),
      results: async () => [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/9 00:20:00 / 链接 CS API: https://api.csapi.de/',
        '今日已有赛果，但这条 smoke 文本故意不含明确比分。',
      ].join('\n'),
    });
    hltv.__test.setCacheEntryForTests(
      'results',
      [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/9 00:20:00 / 链接 CS API: https://api.csapi.de/',
        '今日已有赛果，但这条 smoke 文本故意不含明确比分。',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-unparsed-results', fetchMs: 15 },
    );
    handler.handleEvent(makePlainEvent(990, 1, '/predict autosettle'));
    await waitFor(() => sent.length === 41, 'predict autosettle unparsed results boundary');
    const unparsedResultsText = firstText(sent[40].message);
    assert.ok(unparsedResultsText.includes('近期赛果里没解析到明确比分'), 'predict autosettle unparsed should report unparsed results');
    assert.ok(unparsedResultsText.includes('竞猜赛果事实类型覆盖:'), 'predict autosettle unparsed should expose result fact coverage');
    assert.ok(unparsedResultsText.includes('results HIT(fresh)'), 'predict autosettle unparsed should keep results cache freshness');
    assert.ok(unparsedResultsText.includes('赛果解析边界'), 'predict autosettle unparsed should explain parsing boundary');
    assert.ok(unparsedResultsText.includes('不能反推没有赛果'), 'predict autosettle unparsed should forbid no-result inference');

    csPredictTest.setRealtimeFetchersForTests({
      matches: async () => [
        '来源：Liquipedia赛程 / 拉取 2026/6/8 15:20:00 / 链接 HLTV matches: https://www.hltv.org/matches',
        '今日赛事很多，但这条 smoke 文本故意不含双方对阵的标准格式。',
      ].join('\n'),
      results: async () => [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/9 00:40:00 / 链接 CS API: https://api.csapi.de/',
        '- 2026-06-09  Liquid 2:0 MOUZ BO3 (IEM Other) 胜者:Liquid matchid=2390200',
      ].join('\n'),
    });
    hltv.__test.setCacheEntryForTests(
      'results',
      [
        '来源：CS API / HLTV赛果镜像 / 拉取 2026/6/9 00:40:00 / 链接 CS API: https://api.csapi.de/',
        '- 2026-06-09  Liquid 2:0 MOUZ BO3 (IEM Other) 胜者:Liquid matchid=2390200',
      ].join('\n'),
      { ttlMs: 60_000, ageMs: 5_000, source: 'test-predict-unmatched-results', fetchMs: 15 },
    );
    handler.handleEvent(makePlainEvent(991, 1, '/predict autosettle'));
    await waitFor(() => sent.length === 42, 'predict autosettle unmatched results boundary');
    const unmatchedResultsText = firstText(sent[41].message);
    assert.ok(unmatchedResultsText.includes('没有匹配到可结算盘口'), 'predict autosettle unmatched should report no matching market');
    assert.ok(unmatchedResultsText.includes('results HIT(fresh)'), 'predict autosettle unmatched should keep results cache freshness');
    assert.ok(unmatchedResultsText.includes('自动匹配边界'), 'predict autosettle unmatched should explain matching boundary');
    assert.ok(unmatchedResultsText.includes('不能反推近期赛果里没有这场'), 'predict autosettle unmatched should forbid no-result inference');
  } finally {
    csPredictTest.resetForTests();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  }
}

async function testCrossGroupAiConcurrency() {
  aiChat.shutdownAiChat();
  const config = makeConfigForHandler();
  config.ai.ai_global_concurrency = 3;
  config.ai.max_context_messages = 1000;
  configureGates({ ai: 3, search: 2, vision: 1, tts: 1, stt: 1, passiveQueueMax: 20 });
  const sent = [];
  const bot = {
    getConfig: () => config,
    sendGroupMessage: async (groupId, message, onMessageId) => {
      sent.push({ groupId, message });
      if (onMessageId) onMessageId(80_000 + sent.length);
      return true;
    },
    callApiAsync: async () => ({ retcode: 0, data: {} }),
  };
  const handler = new MessageHandler(bot);
  handler.use(aiChat.aiChatPlugin);
  let active = 0;
  let maxActive = 0;

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    active--;
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    const id = (content.match(/message_id: (\d+)/) || [])[1] || 'unknown';
    return `concurrent-${id}`;
  });

  try {
    for (let i = 0; i < 5; i++) {
      handler.handleEvent(makeEvent(300 + i, 30 + i, ` 多群${i}`, [], 7000 + i));
    }
    await waitFor(() => sent.length === 5, 'five cross-group replies', 5000);
    assert.ok(maxActive > 1, `cross-group AI should run concurrently, got maxActive=${maxActive}`);
    assert.ok(maxActive <= 3, `cross-group AI concurrency exceeded gate: ${maxActive}`);
    assert.deepStrictEqual(
      sent.map((item) => item.message.find((seg) => seg.type === 'reply')?.data.id).sort(),
      ['300', '301', '302', '303', '304'],
    );
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function main() {
  await testOutgoingSanitize();
  await testBotMediaBatching();
  await testBotSendRetriesAndMediaFailureNotice();
  await testBotLoginStatusStrictness();
  await testConfig();
  await testDoctorScript();
  await testApiTestScript();
  await testConfigEnvApiKeyOverride();
  await testConfigSyncScript();
  await testMemoryEnvOverrides();
  await testKnowledge();
  await testKnowledgeSourceState();
  await testKnowledgeUrlImportCommand();
  await testVoiceStats();
  await testLocalTtsProvider();
  await testApiTtsProvider();
  await testImageStats();
  await testImageRedirectAndCleanup();
  await testGates();
  await testSttPayloadModesAndRedirect();
  await testSearchSingleFlight();
  await testAdminMaintenanceCommands();
  await testStatusCommandObservability();
  await testMultimodalStatusDiagnostics();
  await testVoiceSttEndToEndDiagnostics();
  await testDataCommandObservability();
  await testDiagStorageDiagnostics();
  await testMessageReplyTargeting();
  await testNoApiKeyHumanFallback();
  await testExplicitVoiceReply();
  await testOpaqueOneBotRecordResolution();
  await testOpaqueOneBotImageResolution();
  await testKnowledgeInjectionAndHumanizedPostprocess();
  await testOpenerFamilyDedupe();
  await testRealityBoundaryPostprocess();
  await testTraceEvidenceAndFactGuard();
  await testRealtimeSourceBoundaryPrompt();
  await testAiMatchIdRealtimeInjection();
  await testKnowledgeFreshnessRiskPostGuard();
  await testAiStaleRealtimeEvidenceBoundary();
  await testRagRealtimeMemoryTruthFilter();
  await testReplyQualityRepair();
  await testStyleQualityPreflightCommand();
  await testReplyCacheStableKeyAndSingleFlight();
  await testReplyCacheMaxEntriesLru();
  await testReplyCacheAvoidsSameSessionRepeat();
  await testReplySingleFlightDoesNotReusePersonalizedOutput();
  await testShutdownCancelsPendingAiReply();
  await testPassiveTriggerFiltering();
  await testPrivateMessages();
  await testRepeaterAndPoke();
  await testStickersPlugin();
  await testHelpTopicDiscoverability();
  await testDailyPulsePlugin();
  await testFunCsPlayer();
  await testCsPluginAndGiftThanks();
  await testCsReportPlugin();
  await testCsWatchPlugin();
  await testCsPredictPlugin();
  await testCrossGroupAiConcurrency();
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
