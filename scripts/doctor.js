#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config.json');
const examplePath = path.join(root, 'config.example.json');

const hard = [];
const risk = [];
const suggest = [];
const ok = [];

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function statMtime(rel) {
  try {
    return fs.statSync(path.join(root, rel)).mtimeMs;
  } catch {
    return 0;
  }
}

function readJson(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (err) {
    throw new Error(`${path.basename(filepath)} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasUsableApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (key.length < 8) return false;
  const lower = key.toLowerCase();
  return ![
    '在这里填入',
    '你的api',
    '你的 api',
    'api密钥',
    'api 密钥',
    'your_api',
    'your-api',
    'your api',
    'replace_me',
    'changeme',
    'example',
    'placeholder',
  ].some((item) => lower.includes(item));
}

function ensureWritableDir(rel, label) {
  const dir = path.join(root, rel);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok.push(`${label}可写: ${rel}`);
  } catch (err) {
    hard.push(`${label}不可写: ${rel} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function listNewestMtime(dirRel, pattern) {
  const dir = path.join(root, dirRel);
  let newest = 0;
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const item of fs.readdirSync(current)) {
      const filepath = path.join(current, item);
      const stat = fs.statSync(filepath);
      if (stat.isDirectory()) walk(filepath);
      else if (!pattern || pattern.test(filepath)) newest = Math.max(newest, stat.mtimeMs);
    }
  }
  walk(dir);
  return newest;
}

function checkConfig(config, example) {
  if (!isPlainObject(config)) {
    hard.push('config.json 不是 JSON 对象');
    return;
  }
  const ai = isPlainObject(config.ai) ? config.ai : {};
  const exampleAi = isPlainObject(example.ai) ? example.ai : {};

  try {
    const ws = new URL(String(config.ws_url || ''));
    if (!['ws:', 'wss:'].includes(ws.protocol)) hard.push(`ws_url 协议不是 ws/wss: ${config.ws_url}`);
    else ok.push(`ws_url: ${config.ws_url}`);
  } catch {
    hard.push(`ws_url 不合法: ${config.ws_url || '[空]'}`);
  }

  if (!Number(config.bot_qq || process.env.BOT_QQ || 0)) risk.push('bot_qq 未配置；运行时会以 OneBot self_id 为准，但换号排障会更难');
  else ok.push(`bot_qq 已配置: ${config.bot_qq || process.env.BOT_QQ}`);
  if (!Array.isArray(config.admin_qq) || config.admin_qq.length === 0) risk.push('admin_qq 为空，/diag live、/kb refresh 等管理命令不可控');

  const apiKey = process.env.WANJIER_API_KEY || process.env.OPENAI_API_KEY || ai.api_key;
  if (hasUsableApiKey(apiKey)) ok.push('API Key 看起来已配置');
  else risk.push('API Key 为空或仍是占位值；AI、远端TTS/STT、识图会不可用');

  if (!ai.model) risk.push('ai.model 为空');
  if (ai.enable_vision && !ai.vision_model && !ai.model) hard.push('enable_vision=true 但 vision_model/model 都为空');
  if (ai.enable_tts && (ai.tts_provider === 'api' || ai.tts_provider === 'auto') && !hasUsableApiKey(apiKey) && !ai.tts_local_command) {
    risk.push('enable_tts=true 但没有可用 API Key 或本地 TTS 命令');
  }
  if (ai.enable_stt && (ai.stt_provider === 'api' || ai.stt_provider === 'auto') && !hasUsableApiKey(apiKey) && !ai.stt_local_command) {
    risk.push('enable_stt=true 但没有可用 API Key 或本地 STT 命令');
  }
  if (ai.enable_tts && ai.tts_clone_enabled !== false) {
    const samplePath = path.isAbsolute(ai.tts_sample_path || '')
      ? ai.tts_sample_path
      : path.join(root, ai.tts_sample_path || 'voice_sample.mp3');
    if (!fs.existsSync(samplePath)) suggest.push(`克隆样本不存在: ${samplePath}`);
  }
  if (ai.enable_knowledge === false) hard.push('enable_knowledge=false，风格和选手倾向会明显变薄');
  if (ai.knowledge_force_style === false) risk.push('knowledge_force_style=false，容易退回普通AI腔');

  const currentKeys = new Set(Object.keys(ai));
  const missingKeys = Object.keys(exampleAi).filter((key) => !currentKeys.has(key));
  if (missingKeys.length > 0) {
    risk.push(`config.json ai 字段落后于示例: 缺 ${missingKeys.slice(0, 12).join(', ')}${missingKeys.length > 12 ? ` 等${missingKeys.length}项` : ''}`);
  } else {
    ok.push('config.json ai 字段与示例字段同步');
  }

  if (Number(ai.ai_global_concurrency || 0) > 4) suggest.push('2G1C 上 ai_global_concurrency 建议不超过 3-4');
  if (Number(ai.vision_global_concurrency || 0) > 1) suggest.push('2G1C 上 vision_global_concurrency 建议保持 1');
  if (Number(ai.tts_global_concurrency || 0) > 1) suggest.push('2G1C 上 tts_global_concurrency 建议保持 1');
  if (Number(ai.stt_global_concurrency || 0) > 1) suggest.push('2G1C 上 stt_global_concurrency 建议保持 1');
}

function main() {
  let config = null;
  let example = null;

  if (!fs.existsSync(examplePath)) hard.push('config.example.json 缺失');
  else {
    try {
      example = readJson(examplePath);
      ok.push('config.example.json 可解析');
    } catch (err) {
      hard.push(err.message);
    }
  }

  if (!fs.existsSync(configPath)) {
    risk.push('config.json 不存在；首次部署需要 cp config.example.json config.json');
    config = example;
  } else {
    try {
      config = readJson(configPath);
      ok.push('config.json 可解析');
    } catch (err) {
      hard.push(err.message);
    }
  }

  if (config && example) checkConfig(config, example);

  if (!exists('package-lock.json')) risk.push('package-lock.json 缺失，VPS 上 npm install 结果可能漂移');
  else ok.push('package-lock.json 存在');
  if (!exists('node_modules')) suggest.push('node_modules 不存在；部署机需要 npm install');
  if (!exists('dist/index.js')) risk.push('dist/index.js 不存在；需要 npm run build 后再 PM2 启动');
  else ok.push('dist/index.js 存在');

  const newestSrc = listNewestMtime('src', /\.ts$/);
  const distMtime = statMtime('dist/index.js');
  if (newestSrc && distMtime && newestSrc > distMtime + 1000) risk.push('src 比 dist 新；需要重新 npm run build');

  if (!exists('knowledge/wanjier.md')) hard.push('knowledge/wanjier.md 缺失');
  else {
    const size = fs.statSync(path.join(root, 'knowledge/wanjier.md')).size;
    if (size < 10_000) risk.push(`knowledge/wanjier.md 偏小: ${size} bytes`);
    else ok.push(`knowledge/wanjier.md 存在: ${Math.round(size / 1024)}KB`);
  }
  if (!exists('knowledge/sources.json')) risk.push('knowledge/sources.json 缺失，/kb refresh 来源会退回内置兜底');
  else ok.push('knowledge/sources.json 存在');

  ensureWritableDir('logs', '日志目录');
  ensureWritableDir('context_store', '上下文目录');
  ensureWritableDir('search_cache', '搜索缓存目录');
  ensureWritableDir('image_cache', '图片缓存目录');
  ensureWritableDir('voice_cache', '语音缓存目录');
  ensureWritableDir('stt_cache', '听写缓存目录');
  ensureWritableDir('knowledge', '知识库目录');

  console.log('doctor report');
  console.log(`OK: ${ok.length}`);
  ok.slice(0, 18).forEach((item) => console.log(`+ ${item}`));
  console.log(`硬伤: ${hard.length}`);
  (hard.length ? hard : ['暂无硬伤']).forEach((item) => console.log(`! ${item}`));
  console.log(`风险: ${risk.length}`);
  (risk.length ? risk : ['暂无明显风险']).slice(0, 18).forEach((item) => console.log(`- ${item}`));
  console.log(`建议: ${suggest.length}`);
  (suggest.length ? suggest : ['暂无建议']).slice(0, 18).forEach((item) => console.log(`? ${item}`));

  if (hard.length > 0) process.exit(2);
  if (risk.length > 0 && process.argv.includes('--strict')) process.exit(1);
}

main();
