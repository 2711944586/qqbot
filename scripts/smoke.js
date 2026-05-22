const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { hasUsableApiKey, normalizeConfig } = require('../dist/config');
const kb = require('../dist/plugins/knowledge-base');
const { configureGates, getGateStats, withGate } = require('../dist/plugins/concurrency');
const search = require('../dist/plugins/web-search');
const tts = require('../dist/plugins/tts');
const aiChat = require('../dist/plugins/ai-chat');
const imageCache = require('../dist/plugins/image-cache');
const { registerPokeListener } = require('../dist/plugins/poke');
const { repeaterPlugin } = require('../dist/plugins/repeater');
const { funPlugin, __test: funTest } = require('../dist/plugins/fun');
const { pingPlugin } = require('../dist/plugins/ping');
const { MessageHandler } = require('../dist/handler');
const sanitize = require('../dist/message-sanitize');

const SOURCE_STATE_PATH = path.resolve(__dirname, '..', 'knowledge', 'source-state.json');

function firstText(message) {
  if (typeof message === 'string') return message;
  return message.find((seg) => seg.type === 'text')?.data.text;
}

async function testOutgoingSanitize() {
  assert.strictEqual(sanitize.sanitizeOutgoingText('可以 😂 笑哭 🤣'), '可以');
  const message = sanitize.sanitizeOutgoingMessage([
    { type: 'text', data: { text: '别发😂笑哭' } },
    { type: 'image', data: { file: 'https://example.com/a.jpg' } },
  ]);
  assert.strictEqual(message[0].data.text, '别发');
  assert.strictEqual(message[1].type, 'image');
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
  assert.strictEqual(config.ai.trigger_probability, 0.12);
  assert.strictEqual(config.ai.passive_random_min_chars, 4);
  assert.strictEqual(config.ai.passive_random_allow_numeric, false);
  assert.strictEqual(config.ai.knowledge_max_chars, 2600);
  assert.strictEqual(config.ai.aggression_level, 'low');
  assert.strictEqual(config.ai.poke_reply_probability, 1);
  assert.strictEqual(config.ai.ai_global_concurrency, 3);
  assert.strictEqual(config.ai.search_global_concurrency, 3);
  assert.strictEqual(config.ai.vision_global_concurrency, 1);
  assert.strictEqual(config.ai.tts_global_concurrency, 1);
  assert.strictEqual(config.ai.stt_global_concurrency, 1);
  assert.strictEqual(config.ai.search_cache_max_entries, 1000);
  assert.strictEqual(config.ai.image_cache_max_mb, 512);
  assert.strictEqual(config.ai.image_cache_max_file_mb, 2);
  assert.strictEqual(config.ai.image_cache_max_age_hours, 72);
  assert.strictEqual(config.ai.tts_model, 'mimo-v2.5-tts');
  assert.strictEqual(config.ai.tts_clone_model, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(config.ai.tts_clone_enabled, true);
  assert.strictEqual(config.ai.tts_sample_path, 'voice_sample.mp3');
  assert.strictEqual(config.ai.tts_max_chars, 120);
  assert.strictEqual(config.ai.tts_timeout_ms, 20000);
  assert.strictEqual(config.ai.tts_cache_hours, 24);
  assert.strictEqual(config.ai.tts_sample_max_mb, 8);
  assert.strictEqual(config.ai.enable_stt, true);
  assert.strictEqual(config.ai.stt_model, 'mimo-v2.5-pro');
  assert.strictEqual(config.ai.stt_max_records, 1);
  assert.strictEqual(config.ai.stt_max_file_mb, 4);
  assert.strictEqual(config.ai.stt_timeout_ms, 20000);
  assert.strictEqual(config.ai.stt_cache_hours, 24);
  assert.strictEqual(config.ai.search_negative_cache_seconds, 60);
  assert.strictEqual(config.ai.knowledge_aggressive_auto_commit, true);
  assert.strictEqual(config.ai.knowledge_auto_batch_max_sources, 6);
  assert.ok(config.ai.trigger_keywords.includes('抽道具'), 'example trigger keywords should include daily CS utility');
  assert.ok(config.ai.trigger_keywords.includes('今日套餐'), 'example trigger keywords should include daily CS loadout');
  assert.strictEqual(hasUsableApiKey(config.ai.api_key), false, 'example placeholder key should not be treated as usable');
  assert.strictEqual(hasUsableApiKey('sk-live-test-key-1234567890'), true, 'real-looking key should be treated as usable');
}

async function testKnowledge() {
  const stats = kb.getKnowledgeStats();
  assert.ok(stats.sections >= 1, 'knowledge sections should load');
  const audit = kb.auditKnowledge();
  assert.ok(audit.sections >= 1, 'audit should see sections');

  const batchId = `smoke_${Date.now().toString(36)}`;
  const candidate = kb.previewKnowledgeCandidate(
    'smoke public fact',
    'MachineWJQ 6657 public fact summary https://example.com/smoke',
    'smoke',
    { sourceType: 'public_fact', confidence: 'high', autoCommitEligible: true, risk: 'safe' },
  );
  const action = kb.autoCommitKnowledgeCandidate(candidate, { batchId, maxBlockChars: 800 });
  assert.strictEqual(action, 'committed');
  const batches = kb.listKnowledgeBatches(20);
  assert.ok(batches.some((batch) => batch.batchId === batchId), 'batch should be logged');
  const rollback = kb.rollbackKnowledgeBatch(batchId);
  assert.ok(rollback.removedBlocks >= 1, 'rollback should remove committed block');
}

async function testKnowledgeSourceState() {
  await withPreservedFile(SOURCE_STATE_PATH, async () => {
    if (fs.existsSync(SOURCE_STATE_PATH)) fs.unlinkSync(SOURCE_STATE_PATH);
    const now = 1_700_000_000_000;
    const sources = [
      { id: 'fresh', query: 'fresh source', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 60 },
      { id: 'stale', query: 'stale source', sourceType: 'public_summary', trusted: true, autoCommitEligible: true, intervalMinutes: 60 },
      { id: 'never', query: 'never source', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 60 },
    ];

    kb.markKnowledgeSourceRefreshed('fresh', now - 10 * 60 * 1000);
    kb.markKnowledgeSourceRefreshed('stale', now - 90 * 60 * 1000);

    const due = kb.filterDueKnowledgeSources(sources, 10, now).map((source) => source.id);
    assert.deepStrictEqual(due, ['stale', 'never'], 'source interval filtering should skip recently refreshed sources');

    const limited = kb.filterDueKnowledgeSources(sources, 1, now).map((source) => source.id);
    assert.deepStrictEqual(limited, ['stale'], 'source interval filtering should respect the batch limit');

    const state = kb.getKnowledgeSourceState();
    assert.strictEqual(state.fresh, now - 10 * 60 * 1000);
    assert.strictEqual(state.stale, now - 90 * 60 * 1000);
  });
}

async function testVoiceStats() {
  const config = readConfig();
  const stats = tts.getVoiceStats(config.ai);
  assert.strictEqual(stats.model, 'mimo-v2.5-tts');
  assert.strictEqual(stats.cloneModel, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(stats.cloneEnabled, true);
  assert.strictEqual(stats.maxChars, 120);
  assert.ok(stats.samplePath.endsWith('voice_sample.mp3'), 'sample path should default to voice_sample.mp3');
}

async function testImageStats() {
  const stats = imageCache.getCacheStats();
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'downloadFailures'), 'image stats should expose download failures');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'lastError'), 'image stats should expose last error');
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

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    prompts.push(content);
    const id = (content.match(/message_id: (\d+)/) || [])[1] || 'unknown';
    if (id === '104') return '（直播口吻接弹幕）不是哥们 这个括号真不能有';
    if (id === '105') return '';
    if (id === '106') return '长回复'.repeat(120);
    if (id === '107') return '收到语音了';
    if (id === '108') return '6';
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
      '不是哥们 这个括号真不能有',
      'stage direction label should be stripped from LLM output',
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
    assert.ok(prompts.some((prompt) => prompt.includes('语音数量: 1')), 'record count should be included in the job snapshot');

    const beforeNumeric = sent.length;
    handler.handleEvent(makeEvent(108, 18, ' 模型别只回数字'));
    await waitFor(() => sent.length === beforeNumeric + 1, 'numeric output rewrite');
    const numericText = sent.at(-1).message.find((seg) => seg.type === 'text')?.data.text;
    assert.ok(numericText && !/^[\d\s.,，。!！?？]+$/.test(numericText), 'numeric-only LLM output should be rewritten');

    const before = sent.length;
    handler.handleEvent(makeEvent(201, 21, ' 回复旧消息', [{ type: 'reply', data: { id: '77777' } }]));
    await waitFor(() => sent.length === before + 1, 'reply-to-bot forced reply');
    assert.strictEqual(getMsgCalls.some((call) => call.action === 'get_msg' && call.params.message_id === 77777), true);
    assert.strictEqual(sent.at(-1).message.find((seg) => seg.type === 'reply')?.data.id, '201');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testPassiveTriggerFiltering() {
  const config = makeConfigForHandler();
  config.ai.trigger_probability = 1;
  config.ai.passive_random_min_chars = 4;
  config.ai.passive_random_allow_numeric = false;
  config.ai.enable_knowledge = false;
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

    handler.handleEvent(makePlainEvent(402, 42, '今天CS2这队伍怎么打'));
    await waitFor(() => sent.length === 1, 'keyword passive reply');
    assert.strictEqual(
      firstText(sent[0].message),
      'passive-402',
      'keyword ordinary messages should trigger AI without @',
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
  const prompts = [];

  aiChat.__setLLMCallerForTests(async (_config, messages) => {
    const current = messages[messages.length - 1];
    const content = typeof current.content === 'string'
      ? current.content
      : current.content.map((item) => item.text || '').join('\n');
    prompts.push(content);
    const id = (content.match(/message_id: (\d+)/) || [])[1] || 'unknown';
    return `私聊收到-${id} 😂 笑哭`;
  });

  try {
    handler.handleEvent(makePrivateEvent(701, 71, '/ping'));
    await waitFor(() => sentPrivate.length === 1, 'private ping');
    assert.strictEqual(firstText(sentPrivate[0].message), '🏓 pong!');
    assert.strictEqual(sentGroup.length, 0, 'private ping should not send a group message');

    handler.handleEvent(makePrivateEvent(702, 72, '你好，今天怎么看NAVI'));
    await waitFor(() => sentPrivate.length === 2, 'private ai forced reply');
    assert.strictEqual(sentPrivate[1].userId, 72);
    assert.ok(firstText(sentPrivate[1].message).includes('私聊收到-702'), 'private AI should reply to the sender');
    assert.ok(!/[😂🤣]|笑哭/.test(firstText(sentPrivate[1].message)), 'private AI replies should strip forbidden smile-cry output');
    assert.ok(prompts.at(-1).includes('chat_type: private'), 'private prompt should mark chat_type');
    assert.ok(prompts.at(-1).includes('chat_id: 72'), 'private prompt should include private chat id');

    handler.handleEvent(makePrivateEvent(703, 73, '今天抽个CS选手'));
    await waitFor(() => sentPrivate.length === 3, 'private fuzzy csplayer');
    assert.ok(sentPrivate[2].message.some((seg) => seg.type === 'image'), 'private csplayer should send player image');
    assert.ok(!sentPrivate[2].message.some((seg) => seg.type === 'at'), 'private csplayer should not include @ segment');
  } finally {
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

  const handler = new MessageHandler(bot);
  handler.use(repeaterPlugin);
  const beforeRepeat = sent.length;
  handler.handleEvent(makePlainEvent(501, 51, '可以复读一下'));
  handler.handleEvent(makePlainEvent(502, 52, '可以复读一下'));
  handler.handleEvent(makePlainEvent(503, 53, '可以复读一下'));
  await waitFor(() => sent.length === beforeRepeat + 1, 'normal repeater');
  assert.strictEqual(sent.at(-1).message, '可以复读一下');

  const beforeUnsafe = sent.length;
  handler.handleEvent(makePlainEvent(504, 54, '6'));
  handler.handleEvent(makePlainEvent(505, 55, '6'));
  handler.handleEvent(makePlainEvent(506, 56, '6'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(sent.length, beforeUnsafe, 'repeater should not repeat low-information numeric text');
}

async function testFunCsPlayer() {
  const config = makeConfigForHandler();
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

  const player = funTest.dailyPlayerFor(61, 6657);
  assert.ok(funTest.csPlayers.every((item) => item.image), 'all daily CS players should have image URLs');
  assert.ok(funTest.csPlayers.every((item) => item.imageSource), 'all daily CS players should have image source labels');
  const directMessage = funTest.buildCsPlayerMessage(61, player, funTest.dailyPlayerScore(61, 6657));
  assert.ok(directMessage.some((seg) => seg.type === 'at'), 'daily player direct builder should at the user');
  assert.ok(directMessage.some((seg) => seg.type === 'text' && seg.data.text.includes(player.nick)), 'daily player text should include nick');
  assert.ok(directMessage.some((seg) => seg.type === 'image'), 'daily player should include an image segment');
  assert.strictEqual(funTest.dailyPlayerFor(61, 6657).nick, funTest.dailyPlayerFor(61, 6657).nick, 'daily player should be stable per group and day');
  assert.strictEqual(funTest.isCsPlayerDrawRequest(null, '今天抽个CS选手'), true, 'fuzzy draw text should trigger');
  assert.strictEqual(funTest.isCsPlayerDrawRequest(null, 'NiKo 现在在哪队'), false, 'normal player lookup should not be hijacked by draw');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天抽个CS队伍', 'team'), true, 'fuzzy daily team should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天抽个CS地图', 'map'), true, 'fuzzy daily map should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天用什么枪', 'weapon'), true, 'fuzzy daily weapon should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天打什么位', 'role'), true, 'fuzzy daily role should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天丢什么道具', 'utility'), true, 'fuzzy daily utility should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天打什么战术', 'tactic'), true, 'fuzzy daily tactic should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今天残局怎么打', 'clutch'), true, 'fuzzy daily clutch should trigger');
  assert.strictEqual(funTest.isDailyCardRequest(null, '今日cs', 'loadout'), true, 'short daily CS text should trigger loadout');

  handler.handleEvent(makePlainEvent(601, 61, '/csplayer'));
  await waitFor(() => sent.length === 1, 'csplayer command');
  assert.strictEqual(sent[0].message[0]?.type, 'at', 'csplayer should at the drawer');
  const text = sent[0].message.find((seg) => seg.type === 'text')?.data.text || '';
  assert.ok(text.includes('今日CS选手'), 'csplayer reply should include title');
  assert.ok(text.includes('昵称：'), 'csplayer reply should include nick label');
  assert.ok(text.includes('签位：'), 'csplayer reply should include score label');

  handler.handleEvent(makePlainEvent(602, 62, '今天抽个CS选手'));
  await waitFor(() => sent.length === 2, 'fuzzy csplayer command');
  assert.ok(sent[1].message.some((seg) => seg.type === 'image'), 'fuzzy csplayer should also include image');

  handler.handleEvent(makeEvent(603, 63, ' 今天抽个CS选手'));
  await waitFor(() => sent.length === 3, 'at fuzzy csplayer command');
  assert.ok(sent[2].message.some((seg) => seg.type === 'image'), 'at fuzzy csplayer should be handled by fun plugin');

  handler.handleEvent(makePlainEvent(604, 64, '/csteam'));
  await waitFor(() => sent.length === 4, 'daily team command');
  assert.ok(firstText(sent[3].message).includes('今日CS队伍'), 'daily team should include title');
  assert.ok(sent[3].message.some((seg) => seg.type === 'image'), 'daily team should include team image');

  handler.handleEvent(makePlainEvent(605, 65, '今天抽个CS地图'));
  await waitFor(() => sent.length === 5, 'daily map fuzzy');
  assert.ok(firstText(sent[4].message).includes('今日CS地图'), 'daily map should include title');

  handler.handleEvent(makePlainEvent(606, 66, '/csweapon'));
  await waitFor(() => sent.length === 6, 'daily weapon command');
  assert.ok(firstText(sent[5].message).includes('今日CS武器'), 'daily weapon should include title');

  handler.handleEvent(makePlainEvent(607, 67, '今日定位'));
  await waitFor(() => sent.length === 7, 'daily role fuzzy');
  assert.ok(firstText(sent[6].message).includes('今日CS定位'), 'daily role should include title');

  handler.handleEvent(makePlainEvent(608, 68, '/csutility'));
  await waitFor(() => sent.length === 8, 'daily utility command');
  assert.ok(firstText(sent[7].message).includes('今日CS道具'), 'daily utility should include title');

  handler.handleEvent(makePlainEvent(609, 69, '今天打什么战术'));
  await waitFor(() => sent.length === 9, 'daily tactic fuzzy');
  assert.ok(firstText(sent[8].message).includes('今日CS战术'), 'daily tactic should include title');

  handler.handleEvent(makePlainEvent(610, 70, '今天残局怎么打'));
  await waitFor(() => sent.length === 10, 'daily clutch fuzzy');
  assert.ok(firstText(sent[9].message).includes('今日CS残局'), 'daily clutch should include title');

  handler.handleEvent(makePlainEvent(611, 71, '/csloadout'));
  await waitFor(() => sent.length === 11, 'daily loadout command');
  assert.ok(firstText(sent[10].message).includes('今日CS套餐'), 'daily loadout should include title');

  handler.handleEvent(makePlainEvent(612, 72, '今日cs'));
  await waitFor(() => sent.length === 12, 'short daily cs fuzzy');
  assert.ok(firstText(sent[11].message).includes('今日CS套餐'), 'short daily CS should trigger loadout');
}

async function testCrossGroupAiConcurrency() {
  const config = makeConfigForHandler();
  config.ai.ai_global_concurrency = 3;
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
  await testConfig();
  await testKnowledge();
  await testKnowledgeSourceState();
  await testVoiceStats();
  await testImageStats();
  await testGates();
  await testSearchSingleFlight();
  await testMessageReplyTargeting();
  await testPassiveTriggerFiltering();
  await testPrivateMessages();
  await testRepeaterAndPoke();
  await testFunCsPlayer();
  await testCrossGroupAiConcurrency();
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
