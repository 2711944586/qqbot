const fs = require('fs');
const path = require('path');

const { normalizeConfig, hasUsableApiKey } = require('../dist/config');
const stt = require('../dist/plugins/stt');

function loadConfig() {
  const root = path.resolve(__dirname, '..');
  const configPath = fs.existsSync(path.join(root, 'config.json'))
    ? path.join(root, 'config.json')
    : path.join(root, 'config.example.json');
  return { configPath, config: normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8'))) };
}

async function main() {
  const { configPath, config } = loadConfig();
  const input = process.argv.slice(2).join(' ').trim();
  const stats = stt.getSttStats(config.ai);

  console.log(`config: ${configPath}`);
  console.log(`STT: ${config.ai.enable_stt ? 'on' : 'off'} provider=${stats.provider} payload=${stats.payloadMode} model=${stats.model || '-'}`);
  console.log(`local: ${stats.localReady ? 'ready' : 'missing'} command=${stats.localCommand || '-'}`);
  console.log(`cache: ${stats.cacheFiles} files ${stats.sizeMB}MB hits=${stats.hits}/${stats.misses}`);

  if (!input) {
    console.log('usage: npm run stt:test -- <voice-url-or-local-file>');
    return;
  }
  if (!config.ai.enable_stt) {
    console.error('enable_stt is false');
    process.exitCode = 2;
    return;
  }
  const needsApi = (config.ai.stt_provider || 'api') === 'api' || ((config.ai.stt_provider || 'api') === 'auto' && !(config.ai.stt_local_command || '').trim());
  if (needsApi && !hasUsableApiKey(config.ai.api_key)) {
    console.error('API key is missing or still placeholder; remote STT cannot run.');
    process.exitCode = 2;
    return;
  }

  const result = await stt.transcribeRecords(config.ai, [input]);
  const nextStats = stt.getSttStats(config.ai);
  if (result.length === 0) {
    console.error(`STT failed: ${nextStats.lastError || 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  console.log('transcript:');
  console.log(result.join('\n'));
  console.log(`lastPayload=${nextStats.lastPayloadMode || '-'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
