const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');

const { hasUsableApiKey, normalizeConfig } = require('../dist/config');
const kb = require('../dist/plugins/knowledge-base');
const { configureGates, getGateStats, withGate } = require('../dist/plugins/concurrency');
const search = require('../dist/plugins/web-search');
const tts = require('../dist/plugins/tts');
const stt = require('../dist/plugins/stt');
const aiChat = require('../dist/plugins/ai-chat');
const imageCache = require('../dist/plugins/image-cache');
const { registerPokeListener, __test: pokeTest } = require('../dist/plugins/poke');
const { repeaterPlugin } = require('../dist/plugins/repeater');
const { funPlugin, __test: funTest } = require('../dist/plugins/fun');
const { adminPlugin } = require('../dist/plugins/admin');
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
  const softened = sanitize.sanitizeOutgoingText('不是哥们 这个开头太公式了');
  assert.ok(!softened.startsWith('不是哥们'), 'formulaic opener should be softened at send boundary');
  assert.ok(softened.includes('这个开头太公式了'), 'send-boundary softening should keep useful content');
  const softenedGeneric = sanitize.sanitizeOutgoingText('讲道理 这个开头也太像模板了');
  assert.ok(!softenedGeneric.startsWith('讲道理'), 'generic formulaic opener should be softened at send boundary');
  assert.ok(softenedGeneric.includes('这个开头也太像模板了'), 'generic opener softening should keep useful content');
  const softenedCatchphrase = sanitize.sanitizeOutgoingText('有点东西 这句又像模板了');
  assert.ok(!softenedCatchphrase.startsWith('有点东西'), 'catchphrase opener should be softened at send boundary');
  assert.ok(softenedCatchphrase.includes('这句又像模板了'), 'catchphrase opener softening should keep useful content');
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
  assert.strictEqual(config.config_version, 20260524);
  assert.strictEqual(config.ai.trigger_probability, 0.08);
  assert.strictEqual(config.ai.passive_random_min_chars, 4);
  assert.strictEqual(config.ai.passive_random_allow_numeric, false);
  assert.strictEqual(config.ai.knowledge_max_chars, 2600);
  assert.strictEqual(config.ai.knowledge_force_style, true);
  assert.strictEqual(config.ai.related_reply_probability, 0.65);
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
  assert.strictEqual(config.ai.image_download_max_redirects, 3);
  assert.strictEqual(config.ai.image_cache_cleanup_interval_minutes, 30);
  assert.strictEqual(config.ai.image_cache_max_files, 5000);
  assert.strictEqual(config.ai.vision_payload_mode, 'auto');
  assert.strictEqual(config.ai.tts_model, 'mimo-v2.5-tts');
  assert.strictEqual(config.ai.tts_provider, 'auto');
  assert.strictEqual(config.ai.tts_local_command, '');
  assert.strictEqual(config.ai.tts_local_output_dir, 'voice_cache/local');
  assert.strictEqual(config.ai.tts_local_timeout_ms, 15000);
  assert.strictEqual(config.ai.tts_clone_model, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(config.ai.tts_clone_enabled, true);
  assert.strictEqual(config.ai.tts_sample_path, 'voice_sample.mp3');
  assert.strictEqual(config.ai.tts_max_chars, 120);
  assert.strictEqual(config.ai.tts_send_mode, 'base64');
  assert.strictEqual(config.ai.tts_timeout_ms, 20000);
  assert.strictEqual(config.ai.tts_cache_hours, 24);
  assert.strictEqual(config.ai.tts_cache_max_mb, 512);
  assert.strictEqual(config.ai.tts_cache_max_files, 3000);
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
  assert.strictEqual(config.ai.stt_cache_max_mb, 128);
  assert.strictEqual(config.ai.stt_cache_max_files, 3000);
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

  const reviewBatch = `smoke_review_${Date.now().toString(36)}`;
  const reviewCandidate = kb.previewKnowledgeCandidate(
    'smoke 礼物 长句 待核验',
    '这是公开搜索摘要，不是原话。礼物感谢只写拟态模板 https://example.com/review-smoke',
    'smoke-review',
    { sourceType: 'public_summary', confidence: 'medium', autoCommitEligible: true, risk: 'needs_source' },
  );
  const reviewAction = kb.autoCommitKnowledgeCandidate(reviewCandidate, { batchId: reviewBatch, maxBlockChars: 800 });
  assert.strictEqual(reviewAction, 'committed', 'review/risky candidates should still commit to main knowledge sections');
  const reviewRollback = kb.rollbackKnowledgeBatch(reviewBatch);
  assert.ok(reviewRollback.removedBlocks >= 1, 'review candidate rollback should remove main knowledge block');

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
  assert.strictEqual(stats.provider, 'auto');
  assert.strictEqual(stats.localReady, false);
  assert.strictEqual(stats.cloneModel, 'mimo-v2.5-tts-voiceclone');
  assert.strictEqual(stats.cloneEnabled, true);
  assert.strictEqual(stats.maxChars, 120);
  assert.strictEqual(stats.maxCacheMB, 512);
  assert.strictEqual(stats.maxCacheFiles, 3000);
  const sttStats = stt.getSttStats(config.ai);
  assert.strictEqual(sttStats.maxCacheMB, 128);
  assert.strictEqual(sttStats.maxCacheFiles, 3000);
  assert.ok(stats.samplePath.endsWith('voice_sample.mp3'), 'sample path should default to voice_sample.mp3');
}

async function testLocalTtsProvider() {
  const config = readConfig();
  const tempDir = fs.mkdtempSync(path.join(__dirname, 'local-tts-'));
  const scriptPath = path.join(tempDir, 'tts-smoke.js');
  fs.writeFileSync(scriptPath, `
const fs = require('fs');
const out = process.env.QQBOT_TTS_OUTPUT;
if (!out) process.exit(2);
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
fs.writeFileSync(out, Buffer.concat([header, Buffer.alloc(220)]));
console.log(out);
`, 'utf-8');
  config.ai.enable_tts = true;
  config.ai.tts_provider = 'local';
  config.ai.tts_local_command = `"${process.execPath}" "${scriptPath}"`;
  config.ai.tts_max_chars = 120;
  config.ai.tts_cache_hours = 1;
  try {
    const output = await tts.generateVoice(config.ai, '本地语音 smoke');
    assert.ok(output && fs.existsSync(output), 'local tts should produce an audio file');
    assert.ok(fs.statSync(output).size > 200, 'local tts output should be non-empty');
    const stats = tts.getVoiceStats(config.ai);
    assert.strictEqual(stats.provider, 'local');
    assert.strictEqual(stats.localReady, true);
    assert.ok(stats.localRuns >= 1, 'local tts run counter should increase');
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
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/audio-redirect')) {
      res.writeHead(302, { Location: '/audio.wav' });
      res.end();
      return;
    }
    if (req.url.startsWith('/audio.wav')) {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push(json);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `听写-${requests.length}` } }] }));
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

async function testAdminMaintenanceCommands() {
  const config = makeConfigForHandler();
  const sent = [];
  const bot = {
    getConfig: () => config,
    updateConfig: (nextConfig) => Object.assign(config, nextConfig),
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

  handler.handleEvent(makePlainEvent(802, 1, '/maint config'));
  await waitFor(() => sent.length === 2, 'maint config');
  assert.ok(firstText(sent[1].message).includes('当前运行配置'), 'maint config should render config drift panel');
  assert.ok(firstText(sent[1].message).includes('多模态'), 'maint config should show multimodal switches');

  handler.handleEvent(makePlainEvent(803, 1, '/maint clean'));
  await waitFor(() => sent.length === 3, 'maint clean');
  assert.ok(firstText(sent[2].message).includes('维护清理跑完了'), 'maint clean should render cleanup summary');

  handler.handleEvent(makePlainEvent(804, 2, '/maint status'));
  await waitFor(() => sent.length === 4, 'maint non-admin denial');
  assert.ok(firstText(sent[3].message).includes('权限不足'), 'maint should be admin-only');
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

    handler.handleEvent(makePlainEvent(905, 95, '用语音回答 今天NAVI咋样'));
    await waitFor(() => sent.length === 4, 'ai voice answer');
    assert.strictEqual(llmCalls, 1, 'voice answer should call LLM when user asks for an answer');
    assert.ok(sent[3].message.some((seg) => seg.type === 'record'), 'voice answer should send record segment');
    assert.strictEqual(fs.readFileSync(capturePath, 'utf-8'), aiVoiceText, 'voice answer should speak the LLM response');
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
  config.ai.stt_local_command = `"${process.execPath}" -e "const fs=require('fs');fs.writeFileSync(process.env.QQBOT_STT_OUTPUT,'听写到了这段语音','utf-8');console.log('听写到了这段语音');"`;
  const sent = [];
  const apiCalls = [];
  const wavBase64 = makeWavBuffer().toString('base64');
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
        return { retcode: 0, data: { base64: wavBase64 } };
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
    assert.ok(content.includes('语音数量: 1'), 'opaque record should be counted');
    assert.ok(content.includes('语音听写: 听写到了这段语音'), 'opaque record should be resolved and transcribed');
    return '听到了 这段语音链路是通的';
  });

  try {
    handler.handleEvent(makeEvent(902, 92, '', [{ type: 'record', data: { file: 'opaque-record-token.amr' } }]));
    await waitFor(() => sent.length === 1, 'opaque record reply');
    assert.ok(
      apiCalls.some((call) => call.action === 'get_record' && call.params.file === 'opaque-record-token.amr' && call.params.out_format === 'mp3'),
      'opaque OneBot record should call get_record with configured output format',
    );
    assert.strictEqual(sent[0].message.find((seg) => seg.type === 'reply')?.data.id, '902');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
}

async function testOpaqueOneBotImageResolution() {
  const config = makeConfigForHandler();
  config.ai.enable_vision = true;
  config.ai.vision_payload_mode = 'auto';
  const sent = [];
  const apiCalls = [];
  const jpgBase64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(220), Buffer.from([0xff, 0xd9])]).toString('base64');
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
        return { retcode: 0, data: { base64: jpgBase64 } };
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
    assert.ok(current.content.some((part) => part.type === 'image_url'), 'vision message should include an image part');
    return '图看到了 识图链路是通的';
  });

  try {
    handler.handleEvent(makeEvent(903, 93, ' 看下图', [{ type: 'image', data: { file: 'opaque-image-token.jpg' } }]));
    await waitFor(() => sent.length === 1, 'opaque image reply');
    assert.ok(
      apiCalls.some((call) => call.action === 'get_image' && call.params.file === 'opaque-image-token.jpg'),
      'opaque OneBot image should call get_image',
    );
    assert.strictEqual(sent[0].message.find((seg) => seg.type === 'reply')?.data.id, '903');
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
    const runtimePack = messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[临场笔记]'));
    assert.ok(runtimePack, 'AI prompt should always include runtime knowledge/style material when knowledge is enabled');
    assert.ok(!runtimePack.content.includes('知识库调用铁律'), 'runtime knowledge should not inject rule-label boilerplate');
    assert.ok(runtimePack.content.includes('输出时禁止说'), 'runtime pack should tell model not to leak template/source wording');
    assert.ok(runtimePack.content.includes('不要标题式输出'), 'runtime pack should discourage report-like labels');
    return '结论：根据临场笔记，作为AI助手我将用玩机器风格回复：不是哥们 这个回答太规整了';
  });

  try {
    handler.handleEvent(makeEvent(904, 94, ' 今天CS2这队伍怎么打'));
    await waitFor(() => sent.length === 1, 'knowledge injected reply');
    const text = firstText(sent[0].message);
    assert.ok(text.includes('这个回答太规整了'), 'reply should keep the useful humanized content');
    assert.ok(!/^不是哥们/.test(text), 'postprocess should soften formulaic opener');
    assert.ok(!/结论：|根据知识库|根据临场笔记|作为AI|我将用|玩机器风格回复/.test(text), 'postprocess should strip assistant/template boilerplate');

    handler.handleEvent(makePlainEvent(908, 98, '/trace last'));
    await waitFor(() => sent.length === 2, 'trace last after AI reply');
    const traceText = firstText(sent[1].message);
    assert.ok(traceText.includes('最近回复 trace'), 'trace last should render trace header');
    assert.ok(traceText.includes('mid=904'), 'trace last should keep original message id');
    assert.ok(traceText.includes('@bot'), 'trace last should show trigger reason');
    assert.ok(/知识\d+字/.test(traceText), 'trace last should show injected knowledge chars');
    assert.ok(traceText.includes('知识分区:'), 'trace last should show injected knowledge section titles');
    assert.ok(traceText.includes('开头:'), 'trace last should show opener dedupe info');
  } finally {
    aiChat.__setLLMCallerForTests();
    aiChat.shutdownAiChat();
  }
  assert.strictEqual(capturedMessages.length, 1);
}

async function testPassiveTriggerFiltering() {
  const config = makeConfigForHandler();
  config.ai.trigger_probability = 1;
  config.ai.related_reply_probability = 1;
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

    handler.handleEvent(makePlainEvent(403, 43, '这把经济怎么又崩了，回防一点道具没有'));
    await waitFor(() => sent.length === 2, 'soft CS discussion passive reply');
    assert.strictEqual(
      firstText(sent[1].message),
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
    /戳|弹幕|战术|默认|信息|道具|急|问题|看|问|打断|干嘛|催/.test(pokeTest.fallbackPokeReply()),
    'fallback poke reply should sound like a live interaction',
  );

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
  funTest.__setImageResolverForTests(async () => 'data:image/jpeg;base64,/9j/2w==');

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

  handler.handleEvent(makePlainEvent(606, 66, '/csweapon'));
  await waitFor(() => sent.length === 7, 'daily weapon command');
  assert.ok(firstText(sent[6].message).includes('今日CS武器'), 'daily weapon should include title');

  handler.handleEvent(makePlainEvent(607, 67, '今日定位'));
  await waitFor(() => sent.length === 8, 'daily role fuzzy');
  assert.ok(firstText(sent[7].message).includes('今日CS定位'), 'daily role should include title');

  handler.handleEvent(makePlainEvent(608, 68, '/csutility'));
  await waitFor(() => sent.length === 9, 'daily utility command');
  assert.ok(firstText(sent[8].message).includes('今日CS道具'), 'daily utility should include title');

  handler.handleEvent(makePlainEvent(609, 69, '今天打什么战术'));
  await waitFor(() => sent.length === 10, 'daily tactic fuzzy');
  assert.ok(firstText(sent[9].message).includes('今日CS战术'), 'daily tactic should include title');

  handler.handleEvent(makePlainEvent(610, 70, '今天残局怎么打'));
  await waitFor(() => sent.length === 11, 'daily clutch fuzzy');
  assert.ok(firstText(sent[10].message).includes('今日CS残局'), 'daily clutch should include title');

  handler.handleEvent(makePlainEvent(611, 71, '/csloadout'));
  await waitFor(() => sent.length === 12, 'daily loadout command');
  assert.ok(firstText(sent[11].message).includes('今日CS套餐'), 'daily loadout should include title');

  handler.handleEvent(makePlainEvent(612, 72, '今日cs'));
  await waitFor(() => sent.length === 13, 'short daily cs fuzzy');
  assert.ok(firstText(sent[12].message).includes('今日CS套餐'), 'short daily CS should trigger loadout');
  } finally {
    funTest.__setImageResolverForTests();
  }
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
  await testDoctorScript();
  await testConfigEnvApiKeyOverride();
  await testKnowledge();
  await testKnowledgeSourceState();
  await testVoiceStats();
  await testLocalTtsProvider();
  await testApiTtsProvider();
  await testImageStats();
  await testImageRedirectAndCleanup();
  await testGates();
  await testSttPayloadModesAndRedirect();
  await testSearchSingleFlight();
  await testAdminMaintenanceCommands();
  await testMessageReplyTargeting();
  await testExplicitVoiceReply();
  await testOpaqueOneBotRecordResolution();
  await testOpaqueOneBotImageResolution();
  await testKnowledgeInjectionAndHumanizedPostprocess();
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
