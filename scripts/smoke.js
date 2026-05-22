const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { hasUsableApiKey, normalizeConfig } = require('../dist/config');
const kb = require('../dist/plugins/knowledge-base');
const { configureGates, getGateStats, withGate } = require('../dist/plugins/concurrency');
const search = require('../dist/plugins/web-search');
const tts = require('../dist/plugins/tts');

const SOURCE_STATE_PATH = path.resolve(__dirname, '..', 'knowledge', 'source-state.json');

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
  assert.strictEqual(config.ai.ai_global_concurrency, 2);
  assert.strictEqual(config.ai.search_global_concurrency, 3);
  assert.strictEqual(config.ai.vision_global_concurrency, 1);
  assert.strictEqual(config.ai.tts_global_concurrency, 1);
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
  assert.strictEqual(config.ai.search_negative_cache_seconds, 60);
  assert.strictEqual(config.ai.knowledge_aggressive_auto_commit, true);
  assert.strictEqual(config.ai.knowledge_auto_batch_max_sources, 6);
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

async function testGates() {
  configureGates({ ai: 2, search: 2, vision: 1, tts: 1 });
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

async function main() {
  await testConfig();
  await testKnowledge();
  await testKnowledgeSourceState();
  await testVoiceStats();
  await testGates();
  await testSearchSingleFlight();
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
