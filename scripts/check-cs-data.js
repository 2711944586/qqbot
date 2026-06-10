#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadDist(modulePath) {
  try {
    return require(path.join(ROOT, 'dist', modulePath));
  } catch (err) {
    console.error(`[data:test] 无法加载 dist/${modulePath}`);
    console.error('[data:test] 先运行 npm run build');
    throw err;
  }
}

function trimSnippet(text, max = 180) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cardKindName(kind) {
  return {
    team: '队伍',
    map: '地图',
    weapon: '武器',
    role: '定位',
    utility: '道具',
    tactic: '战术',
    clutch: '残局',
  }[kind] || kind;
}

function hasSourceLink(text) {
  return /https:\/\/(?:api\.csapi\.de|www\.hltv\.org|liquipedia\.net)\//.test(String(text || ''));
}

async function timed(label, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { label, ok: Boolean(value), ms: Date.now() - start, value, error: '' };
  } catch (err) {
    return { label, ok: false, ms: Date.now() - start, value: '', error: err instanceof Error ? err.message : String(err) };
  }
}

async function firstWorkingImage(candidates, getImageDataUrl) {
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    const dataUrl = await getImageDataUrl(candidate.url);
    if (dataUrl) return candidate;
  }
  return null;
}

async function buildCardCandidates(card, csPlayers, resolveTeamImage, resolveFandomFileImage, resolvePlayerImage) {
  const out = [];
  if (card.liquipediaPage) {
    const url = await resolveTeamImage(card.liquipediaPage, card.name);
    out.push({ label: 'liquipedia-team', url });
  }
  if (card.fandomFile) {
    const url = await resolveFandomFileImage(card.fandomFile);
    out.push({ label: 'fandom-file', url });
  }
  if (card.playerImageFallback) {
    const player = csPlayers.find((item) =>
      item.nick.toLowerCase() === card.playerImageFallback.toLowerCase()
      || (item.aliases || []).some((alias) => alias.toLowerCase() === card.playerImageFallback.toLowerCase()),
    );
    if (player) {
      const dynamicUrl = await resolvePlayerImage(player.nick);
      out.push({ label: `representative-${player.nick}-dynamic`, url: dynamicUrl });
      out.push({ label: `representative-${player.nick}-static`, url: player.image });
    }
  }
  if (card.image) out.push({ label: 'static-card-url', url: card.image });
  return out.filter((item) => item.url);
}

async function main() {
  const hltv = loadDist('plugins/hltv-api.js');
  const fun = loadDist('plugins/fun.js');
  const image = loadDist('plugins/image-cache.js');
  const liquipedia = loadDist('plugins/liquipedia-image.js');
  const fandom = loadDist('plugins/fandom-image.js');

  console.log('=== CS真实数据测试 ===');
  const source = hltv.getCsDataSourceInfo();
  console.log(`主源: ${source.primaryBaseUrl}`);
  console.log(`说明: ${source.note}`);

  const checks = [
    await timed('ranking', () => hltv.fetchTeamRanking()),
    await timed('recent-results', () => hltv.fetchRecentResults()),
    await timed('team-profile-vitality', () => hltv.fetchTeamProfile('Vitality 当前阵容 排名')),
    await timed('player-profile-donk', () => hltv.fetchPlayerProfile('donk 最近状态 stats')),
  ];

  let failed = 0;
  let warnings = 0;
  for (const check of checks) {
    if (!check.ok) failed++;
    if (check.ok && !hasSourceLink(check.value)) {
      warnings++;
      console.log(`WARN ${check.label} 缺少可点击来源链接`);
    }
    const detail = check.error || trimSnippet(check.value);
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label} ${check.ms}ms ${detail}`);
  }

  console.log('\n=== 今日CS真实图片测试 ===');
  const testApi = fun.__test;
  const userId = 10001;
  const scopeId = 10001;
  const groups = [
    ['team', testApi.csTeams, 'csteam'],
    ['map', testApi.csMaps, 'csmap'],
    ['weapon', testApi.csWeapons, 'csweapon'],
    ['role', testApi.csRoles, 'csrole'],
    ['utility', testApi.csUtilities, 'csutility'],
    ['tactic', testApi.csTactics, 'cstactic'],
    ['clutch', testApi.csClutches, 'csclutch'],
  ];

  const player = testApi.dailyPlayerFor(userId, scopeId);
  const playerCandidates = [
    { label: `${player.nick}-dynamic`, url: await liquipedia.resolvePlayerImage(player.nick) },
    { label: `${player.nick}-static`, url: player.image },
  ].filter((item) => item.url);
  const playerHit = await firstWorkingImage(playerCandidates, image.getImageDataUrl);
  if (playerHit) {
    console.log(`OK 选手 ${player.nick} -> ${playerHit.label}`);
  } else {
    warnings++;
    console.log(`WARN 选手 ${player.nick} 外部真实图暂不可用，线上会发本地签位卡兜底`);
  }

  for (const [kind, cards, seedKind] of groups) {
    const card = testApi.dailyCardFor(seedKind, userId, scopeId, cards);
    const candidates = await buildCardCandidates(
      card,
      testApi.csPlayers,
      liquipedia.resolveTeamImage,
      fandom.resolveFandomFileImage,
      liquipedia.resolvePlayerImage,
    );
    const hit = await firstWorkingImage(candidates, image.getImageDataUrl);
    if (hit) {
      console.log(`OK ${cardKindName(kind)} ${card.name} -> ${hit.label}`);
    } else {
      warnings++;
      console.log(`WARN ${cardKindName(kind)} ${card.name} 外部真实图暂不可用，线上会发本地签位卡兜底`);
    }
  }

  const stats = image.getCacheStats();
  console.log(`\n图片缓存: ${stats.count}/${stats.maxFiles} ${stats.sizeMB}/${stats.maxSizeMB}MB 命中${stats.hits}/${stats.misses} 失败${stats.downloadFailures}`);
  if (stats.lastError) console.log(`最近图片错误: ${stats.lastError}`);

  if (failed > 0) {
    console.error(`\n[data:test] 失败 ${failed} 项。VPS 网络、外站限流或图片文件名可能需要处理。`);
    process.exitCode = 1;
  } else {
    console.log(`\n[data:test] OK${warnings ? `，但有 ${warnings} 项外部图源暂时不可用` : ''}`);
  }
}

main().catch((err) => {
  console.error('[data:test] 异常:', err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
