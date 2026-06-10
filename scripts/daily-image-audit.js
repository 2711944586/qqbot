#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = {
    limit: 40,
    strict: process.env.WANJIER_DAILY_IMAGE_AUDIT_STRICT === '1',
    json: false,
    templateJson: false,
    templateCsv: false,
    includeAll: false,
    writeTemplate: '',
    limitProvided: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--template-json') {
      options.templateJson = true;
    } else if (arg === '--template-csv') {
      options.templateCsv = true;
    } else if (arg === '--all') {
      options.includeAll = true;
    } else if (arg === '--write-template') {
      options.writeTemplate = String(argv[index + 1] || '').trim();
      index++;
    } else if (arg.startsWith('--write-template=')) {
      options.writeTemplate = arg.slice('--write-template='.length).trim();
    } else if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value)) {
        options.limit = Math.max(1, Math.min(Math.floor(value), 200));
        options.limitProvided = true;
        index++;
      }
    } else if (/^--limit=\d+$/.test(arg)) {
      options.limit = Math.max(1, Math.min(Number(arg.split('=')[1]), 200));
      options.limitProvided = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log([
        '用法: node scripts/daily-image-audit.js [--limit N] [--strict] [--json]',
        '      node scripts/daily-image-audit.js --template-json [--all] [--write-template PATH]',
        '      node scripts/daily-image-audit.js --template-csv [--all]',
        '环境变量:',
        '  DAILY_BEAUTY_IMAGE_MANIFEST_PATH    指定 data/daily-beauty-images.json 的替代路径',
        '  WANJIER_DAILY_IMAGE_AUDIT_STRICT=1  有未达标项时返回非零退出码',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('|') : value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function templateCards(targets) {
  return targets.map((target) => ({
    kind: target.kind,
    ...target.fields,
    title: target.label,
    tags: target.tags,
    urls: [],
  }));
}

function templateCsv(targets) {
  const fieldNames = ['key', 'nick', 'name', 'weapon', 'skin', 'characterKey', 'characterName', 'itemKey', 'itemName', 'title'];
  const header = ['kind', 'label', 'current', 'missing', 'minImages', ...fieldNames, 'tags', 'urls'];
  const lines = [header.map(csvCell).join(',')];
  for (const target of targets) {
    const missing = Math.max(0, target.minImages - target.count);
    const row = [
      target.kind,
      target.label,
      target.count,
      missing,
      target.minImages,
      ...fieldNames.map((field) => target.fields[field] || ''),
      target.tags.join('|'),
      '',
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}

function loadFunTest() {
  try {
    return require(path.resolve(__dirname, '..', 'dist', 'plugins', 'fun')).__test;
  } catch (err) {
    console.error('[daily-image-audit] 需要先构建 dist：npm run build');
    console.error(`[daily-image-audit] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

const options = parseArgs(process.argv.slice(2));
const funTest = loadFunTest();
const rows = funTest.dailyBeautyAuditRows();
const missing = rows.filter((row) => !row.ok);
const targets = typeof funTest.dailyImageManifestTargets === 'function' ? funTest.dailyImageManifestTargets() : [];
const sortedTargets = (options.includeAll ? targets : targets.filter((target) => !target.ok))
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
const selectedTargets = options.limitProvided ? sortedTargets.slice(0, options.limit) : sortedTargets;

if (options.templateJson || options.writeTemplate) {
  const payload = JSON.stringify({
    minImagesPerItem: 200,
    cards: templateCards(selectedTargets),
  }, null, 2);
  if (options.writeTemplate) {
    const filepath = path.resolve(options.writeTemplate);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, `${payload}\n`, 'utf-8');
    console.log(`[daily-image-audit] 已写入模板: ${filepath}`);
  } else {
    console.log(payload);
  }
  if (options.strict && selectedTargets.length > 0) process.exit(4);
  process.exit(0);
}

if (options.templateCsv) {
  console.log(templateCsv(selectedTargets));
  if (options.strict && selectedTargets.length > 0) process.exit(4);
  process.exit(0);
}

if (options.json) {
  console.log(JSON.stringify({
    total: rows.length,
    ok: rows.length - missing.length,
    missing: missing.length,
    rows,
    targets: targets.map((target) => ({
      kind: target.kind,
      label: target.label,
      count: target.count,
      ok: target.ok,
      minImages: target.minImages,
      fields: target.fields,
      tags: target.tags,
    })),
  }, null, 2));
} else {
  console.log(funTest.buildDailyImageAuditReport(options.limit));
}

if (options.strict && missing.length > 0) {
  process.exit(4);
}
