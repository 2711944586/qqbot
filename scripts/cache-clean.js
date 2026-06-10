const fs = require('fs');
const path = require('path');

const { normalizeConfig } = require('../dist/config');
const { cleanupCache, getCacheStats, configureImageCache } = require('../dist/plugins/image-cache');
const { cleanSearchCache, getSearchStats, configureSearchCache } = require('../dist/plugins/web-search');
const { cleanVoiceCache, getVoiceStats } = require('../dist/plugins/tts');
const { cleanSttCache, getSttStats } = require('../dist/plugins/stt');
const { clearHltvCache, getHltvStats } = require('../dist/plugins/hltv-api');

function loadConfig() {
  const root = path.resolve(__dirname, '..');
  const configPath = fs.existsSync(path.join(root, 'config.json'))
    ? path.join(root, 'config.json')
    : path.join(root, 'config.example.json');
  return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
}

function main() {
  const config = loadConfig();
  configureImageCache(config.ai);
  configureSearchCache(config.ai);

  cleanupCache();
  cleanSearchCache();
  cleanVoiceCache(config.ai);
  cleanSttCache(config.ai);
  clearHltvCache();

  const image = getCacheStats();
  const search = getSearchStats();
  const voice = getVoiceStats(config.ai);
  const stt = getSttStats(config.ai);
  const hltv = getHltvStats();

  console.log('cache clean done');
  console.log(`image: ${image.count}/${image.maxFiles} files ${image.sizeMB}/${image.maxSizeMB}MB inFlight=${image.inFlight} lastDeleted=${image.lastCleanupDeleted} totalDeleted=${image.cleanupDeletedTotal}`);
  console.log(`search: ${search.cacheEntries}/${search.maxEntries} entries negative=${search.negativeEntries}`);
  console.log(`cs realtime: ${hltv.entries} fresh ${hltv.staleEntries} stale diskLoaded=${hltv.diskEntriesLoaded} diskHits=${hltv.diskHits}`);
  console.log(`tts: ${voice.cacheFiles}/${voice.maxCacheFiles} files ${voice.sizeMB}/${voice.maxCacheMB}MB lastDeleted=${voice.lastCleanupDeleted} totalDeleted=${voice.cleanupDeletedTotal}`);
  console.log(`stt: ${stt.cacheFiles}/${stt.maxCacheFiles} files ${stt.sizeMB}/${stt.maxCacheMB}MB lastDeleted=${stt.lastCleanupDeleted} totalDeleted=${stt.cleanupDeletedTotal}`);
}

main();
