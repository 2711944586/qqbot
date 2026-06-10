import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { getKnowledgeDbStats, searchKnowledgeDb, syncKnowledgeDb } from './knowledge-db';

interface KnowledgeSection {
  title: string;
  content: string;
  keywords: string[];
}

export interface KnowledgeSearchResult {
  title: string;
  excerpt: string;
  score: number;
}

export interface KnowledgeCandidate {
  id: string;
  title: string;
  query: string;
  source: string;
  markdown: string;
  createdAt: number;
  sourceType: 'public_fact' | 'public_summary' | 'local_transcript' | 'style_template' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  evidenceUrls: string[];
  sourceTrust: 'trusted' | 'known' | 'unknown' | 'risky';
  sourceHosts: string[];
  autoCommitEligible: boolean;
  risk: 'safe' | 'review' | 'needs_source';
  status: 'pending' | 'committed' | 'dropped';
  qualityIssues?: string[];
}

export interface KnowledgeSource {
  id: string;
  query: string;
  sourceType: KnowledgeCandidate['sourceType'];
  trusted: boolean;
  autoCommitEligible: boolean;
  intervalMinutes: number;
}

export interface KnowledgeAuditIssue {
  level: 'hard' | 'risk' | 'info';
  title: string;
  detail: string;
}

export interface KnowledgeAuditReport {
  generatedAt: number;
  issues: KnowledgeAuditIssue[];
  sections: number;
  chars: number;
  candidates: number;
  quarantineFiles: number;
}

export interface KnowledgeBatchSummary {
  batchId: string;
  createdAt: number;
  entries: number;
  committed: number;
  quarantined: number;
  rolledBack: number;
}

interface KnowledgeAutoLogEntry {
  batchId: string;
  candidateId: string;
  title: string;
  query: string;
  source: string;
  hash: string;
  evidenceUrls: string[];
  createdAt: number;
  status: 'committed' | 'rolled_back';
  chars: number;
}

export interface KnowledgeCandidateQuality {
  ok: boolean;
  issues: string[];
}

export interface KnowledgeSourceTrustPreview {
  input: string;
  urls: string[];
  sourceTrust: KnowledgeCandidate['sourceTrust'];
  sourceHosts: string[];
  reasons: string[];
  policy: string[];
}

export interface KnowledgeSourceInspectRow {
  id: string;
  query: string;
  sourceType: KnowledgeSource['sourceType'];
  trusted: boolean;
  autoCommitEligible: boolean;
  intervalMinutes: number;
  lastRefreshAt: number;
  minutesSinceRefresh: number;
  nextRefreshInMinutes: number;
  status: 'fresh' | 'due' | 'never';
  sourceTrust: KnowledgeCandidate['sourceTrust'];
  sourceHosts: string[];
  evidenceHint: string;
  autoWriteState: 'allowed' | 'manual-only' | 'blocked';
  autoWriteReason: string;
}

export interface KnowledgeSourceInspectReport {
  generatedAt: number;
  total: number;
  fresh: number;
  due: number;
  never: number;
  autoCommitEligible: number;
  trustedConfigured: number;
  trustedDomains: number;
  riskyDomains: number;
  rows: KnowledgeSourceInspectRow[];
}

export interface KnowledgeFreshnessIssue {
  level: 'hard' | 'risk' | 'info';
  title: string;
  triggers: string[];
  missing: string[];
  excerpt: string;
  advice: string;
  remediation: string[];
}

export interface KnowledgeFreshnessReport {
  generatedAt: number;
  sections: number;
  scanned: number;
  issues: KnowledgeFreshnessIssue[];
  riskSections: number;
  hardSections: number;
}

export interface KnowledgeInboxInspectRow {
  file: string;
  bytes: number;
  chars: number;
  lines: number;
  materialType: 'empty' | 'long_transcript' | 'style_template' | 'gift_template' | 'cs_fact' | 'mixed' | 'summary';
  sourceTrust: KnowledgeCandidate['sourceTrust'];
  sourceHosts: string[];
  evidenceUrls: string[];
  risk: 'safe' | 'review' | 'needs_source';
  issues: string[];
  advice: string[];
  ingestMode: 'summary' | 'full' | 'split-first' | 'drop';
}

export interface KnowledgeInboxInspectReport {
  generatedAt: number;
  totalFiles: number;
  scannedFiles: number;
  totalBytes: number;
  withEvidence: number;
  needsSource: number;
  longTranscript: number;
  rows: KnowledgeInboxInspectRow[];
}

interface UrlFetchResult {
  ok: boolean;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  body: string;
  error: string;
}

const KNOWLEDGE_DIR = path.resolve(__dirname, '..', '..', 'knowledge');
const INBOX_DIR = path.join(KNOWLEDGE_DIR, 'inbox');
const DEFAULT_KNOWLEDGE_FILE = path.join(KNOWLEDGE_DIR, 'wanjier.md');
const SOURCES_FILE = path.join(KNOWLEDGE_DIR, 'sources.json');
const AUDIT_FILE = path.join(KNOWLEDGE_DIR, 'audit.json');
const AUTO_LOG_FILE = path.join(KNOWLEDGE_DIR, 'auto-log.jsonl');
const SOURCE_STATE_FILE = path.join(KNOWLEDGE_DIR, 'source-state.json');
const MAX_CANDIDATES = 20;
const MAX_IMPORT_BYTES = 768 * 1024;
const MAX_IMPORT_REDIRECTS = 4;
const IMPORT_USER_AGENT = 'wanjier-bot/1.0 knowledge-url-import';

const TRUSTED_SOURCE_DOMAINS = [
  'hltv.org',
  'liquipedia.net',
  'counter-strike.net',
  'valvesoftware.com',
  'steampowered.com',
  'api.csapi.de',
  'wikipedia.org',
  'wikimedia.org',
  'moegirl.org.cn',
  'douyu.com',
];

const KNOWN_SOURCE_DOMAINS = [
  'bilibili.com',
  'b23.tv',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  'weibo.com',
  'reddit.com',
  'github.com',
];

const BASE_KEYWORDS = [
  '玩机器', '机器', '6657', 'machine', 'machinewjq', 'cs2', 'csgo', 'major',
  'blast', 'iem', 'esl', 'cac', 'navi', 'g2', 'vitality', 'spirit', 'faze',
  'mouz', 'falcons', 'astralis', 'liquid', 'mongolz', 'niko', 'monesy', 'zywoo',
  's1mple', 'donk', 'ropz', 'device', 'karrigan', 'aleksib', '切片', '语录',
  '直播', '斗鱼', 'b站', 'bilibili', '礼物', '感谢', '白给', '残局', '道具',
  '阵容', '转会', '比分', '赛程', '版本', '枪法', '经济', '强起', 'eco',
  '默认', '控图', 'timing', '假赛', '黄河凌汛', '太行山积雪', '猪头肉',
  '玩神', '玩处', '玩父', '弹幕', '烂梗', '监管', '毒奶', '回防', '提速',
  '补枪', '保枪', '手枪局', '长枪局', '半起', '烟', '闪', '火', 'mirage',
  'inferno', 'nuke', 'ancient', 'anubis', 'dust2', 'overpass', 'train',
  'furia', 'heroic', 'cloud9', 'hunter', 'sh1ro', 'jimpphat', 'frozen', 'b1t',
  '直播语态', '真人化', '回复铁律', '口癖', '反应强度', '经典比赛', '选手评价',
  'whoami', 'refresh', 'bot_qq', 'hltv', 'liquipedia', 'ranking', '核验',
  '置信度', '原话', '拟态', '转写', 'inbox', '公式解说', '老板大气',
  '语音', '克隆语音', 'voice', 'tts', 'voice_sample', 'voiceclone', '授权样本',
  '样本', '语音缓存', 'voice status', 'voice test', '声音克隆',
  '小众宝藏', '结晶', '百事通', '弹幕版', '烂梗大赏', '年度烂梗',
  '管控', 'mygo', 'sora', '喵', '关注', '留学', '第一个观众',
  '雷达图', 'top20', '上海major', 'magixx', 'hltv颁奖', '玩评',
];

let cachedMtime = 0;
let cachedSections: KnowledgeSection[] = [];
let cachedFullText = '';
let selectHits = 0;
let selectMisses = 0;
let searchHits = 0;
let searchMisses = 0;
let autoCommitted = 0;
let autoEnabled = true;
let lastAutoRefreshAt = 0;
let lastAuditReport: KnowledgeAuditReport | null = null;
const pendingCandidates: Map<string, KnowledgeCandidate> = new Map();

function ensureKnowledgeDirs(): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  ensureSourcesFile();
}

function defaultSources(): KnowledgeSource[] {
  return [
    { id: 'moegirl-wanjier', query: '玩机器Machine 萌娘百科 公式解说 6657', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 720 },
    { id: 'douyu-6657', query: '斗鱼 6657 玩机器 CS2 直播间', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 360 },
    { id: 'sb6657', query: 'sb6657 斗鱼玩机器烂梗收集 2600 弹幕', sourceType: 'public_summary', trusted: true, autoCommitEligible: true, intervalMinutes: 720 },
    { id: 'bilibili-cut-index', query: 'Bilibili 玩机器 6657 CS2 切片 录播 弹幕版', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 720 },
    { id: 'hltv-top20', query: 'HLTV Top 20 players 2025 ZywOo donk ropz m0NESY sh1ro', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 1440 },
    { id: 'cs2-team-rankings', query: 'HLTV Valve ranking 2026 CS2 Vitality Spirit Falcons MOUZ NAVI G2', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 1440 },
    { id: 'gift-lines-risky', query: '玩机器 6657 斗鱼 礼物 感谢 老板大气', sourceType: 'unknown', trusted: false, autoCommitEligible: false, intervalMinutes: 1440 },
    { id: 'bilibili-6657-danmaku-top10', query: '6657直播间烂梗top10 玩机器直播间 被发送次数最多 弹幕', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 1440 },
    { id: 'bilibili-machine-hltv-awards-donk', query: '玩机器 HLTV颁奖复盘 donk magixx NiKo ZywOo Top20', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 1440 },
    { id: 'bilibili-machine-shanghai-major-data', query: '玩机器 上海Major 数据雷达图 donk MVP 6657', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 1440 },
    { id: 'bilibili-machine-replay-index', query: '玩机器 Machine 直播回放 小众宝藏结晶直播间 4K弹幕版 6657', sourceType: 'public_summary', trusted: false, autoCommitEligible: false, intervalMinutes: 1440 },
    { id: 'cs2-active-map-pool-2026', query: 'Counter-Strike 2 active duty map pool 2026 Anubis Train Overpass Dust2 Ancient', sourceType: 'public_fact', trusted: true, autoCommitEligible: true, intervalMinutes: 1440 },
  ];
}

function sourceIdEvidenceHint(sourceId: string): string {
  if (/hltv/i.test(sourceId)) return 'https://www.hltv.org/';
  if (/liquipedia/i.test(sourceId)) return 'https://liquipedia.net/counterstrike/';
  if (/douyu/i.test(sourceId)) return 'https://www.douyu.com/';
  if (/bilibili/i.test(sourceId)) return 'https://www.bilibili.com/';
  if (/moegirl/i.test(sourceId)) return 'https://zh.moegirl.org.cn/';
  if (/cs2|valve|map-pool/i.test(sourceId)) return 'https://www.counter-strike.net/';
  return '';
}

export function knowledgeSourceEvidenceHint(sourceId: string): string {
  return sourceIdEvidenceHint(sourceId);
}

function ensureSourcesFile(): void {
  if (fs.existsSync(SOURCES_FILE)) return;
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(defaultSources(), null, 2), 'utf-8');
}

export function getKnowledgeRuntimePaths(): { knowledgeDir: string; mainFile: string; sourcesFile: string; quarantineDir: string; auditFile: string; inboxDir: string } {
  ensureKnowledgeDirs();
  return {
    knowledgeDir: KNOWLEDGE_DIR,
    mainFile: DEFAULT_KNOWLEDGE_FILE,
    sourcesFile: SOURCES_FILE,
    quarantineDir: path.join(KNOWLEDGE_DIR, 'quarantine'),
    auditFile: AUDIT_FILE,
    inboxDir: INBOX_DIR,
  };
}

export function getKnowledgeAutoLogPath(): string {
  ensureKnowledgeDirs();
  return AUTO_LOG_FILE;
}

function readSourceState(): Record<string, number> {
  ensureKnowledgeDirs();
  if (!fs.existsSync(SOURCE_STATE_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCE_STATE_FILE, 'utf-8')) as Record<string, unknown>;
    const state: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const timestamp = Number(value);
      if (id && Number.isFinite(timestamp) && timestamp > 0) state[id] = timestamp;
    }
    return state;
  } catch {
    return {};
  }
}

function writeSourceState(state: Record<string, number>): void {
  ensureKnowledgeDirs();
  const tmp = `${SOURCE_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, SOURCE_STATE_FILE);
}

export function getKnowledgeSourceState(): Record<string, number> {
  return readSourceState();
}

export function markKnowledgeSourceRefreshed(sourceId: string, timestamp: number = Date.now()): void {
  if (!sourceId) return;
  const state = readSourceState();
  state[sourceId] = timestamp;
  writeSourceState(state);
}

export function filterDueKnowledgeSources(sources: KnowledgeSource[], limit: number, now: number = Date.now()): KnowledgeSource[] {
  const state = readSourceState();
  const due = sources.filter((source) => {
    const last = state[source.id] || 0;
    const intervalMs = Math.max(30, Number(source.intervalMinutes) || 720) * 60 * 1000;
    return !last || now - last >= intervalMs;
  });
  return due.slice(0, Math.max(1, limit));
}

function readAutoLog(): KnowledgeAutoLogEntry[] {
  ensureKnowledgeDirs();
  if (!fs.existsSync(AUTO_LOG_FILE)) return [];
  return fs.readFileSync(AUTO_LOG_FILE, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as KnowledgeAutoLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is KnowledgeAutoLogEntry => !!entry && typeof entry.batchId === 'string');
}

function appendAutoLog(entry: KnowledgeAutoLogEntry): void {
  ensureKnowledgeDirs();
  fs.appendFileSync(AUTO_LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
}

export function pruneKnowledgeAutoLog(retentionDays: number = 14): void {
  ensureKnowledgeDirs();
  if (!fs.existsSync(AUTO_LOG_FILE)) return;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const kept = readAutoLog().filter((entry) => entry.createdAt >= cutoff || entry.status === 'committed');
  fs.writeFileSync(AUTO_LOG_FILE, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
}

export function listKnowledgeBatches(limit: number = 8): KnowledgeBatchSummary[] {
  const groups = new Map<string, KnowledgeBatchSummary>();
  for (const entry of readAutoLog()) {
    const current = groups.get(entry.batchId) || {
      batchId: entry.batchId,
      createdAt: entry.createdAt,
      entries: 0,
      committed: 0,
      quarantined: 0,
      rolledBack: 0,
    };
    current.createdAt = Math.min(current.createdAt, entry.createdAt);
    current.entries++;
    if (entry.status === 'committed') current.committed++;
    if (entry.status === 'rolled_back') current.rolledBack++;
    groups.set(entry.batchId, current);
  }
  return [...groups.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function loadKnowledgeSources(): KnowledgeSource[] {
  ensureKnowledgeDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return defaultSources();
    return parsed
      .filter((item): item is KnowledgeSource => !!item && typeof item.id === 'string' && typeof item.query === 'string')
      .map((item) => ({
        id: item.id,
        query: item.query,
        sourceType: item.sourceType || 'unknown',
        trusted: item.trusted !== false,
        autoCommitEligible: item.autoCommitEligible === true,
        intervalMinutes: Number.isFinite(Number(item.intervalMinutes)) ? Number(item.intervalMinutes) : 720,
      }));
  } catch {
    return defaultSources();
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase();
}

function safeTitle(text: string): string {
  return text.replace(/[#[\]\n\r]/g, '').trim().slice(0, 40) || '知识片段';
}

function safeFilename(text: string): string {
  return safeTitle(text)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 60) || 'candidate';
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/g) || [];
  return [...new Set(matches.map((url) => url.slice(0, 300)))].slice(0, 5);
}

function extractLooseSourceUrls(text: string): string[] {
  const explicit = extractUrls(text);
  const loose = text
    .split(/\s+/)
    .map((item) => item.trim().replace(/^[<（(\["'“‘]+|[>）)\]"'”’，,。；;]+$/g, ''))
    .filter(Boolean)
    .filter((item) => !item.includes('@'))
    .filter((item) => /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{1,5})?(?:\/\S*)?$/i.test(item))
    .map((item) => `https://${item}`);
  return [...new Set([...explicit, ...loose])].slice(0, 8);
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isPrivateOrLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^(?:127|10)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '0.0.0.0' || host === '::1') return true;
  return false;
}

function sourceTrustForHosts(hosts: string[]): KnowledgeCandidate['sourceTrust'] {
  const cleanHosts = hosts.filter(Boolean);
  if (cleanHosts.length === 0) return 'unknown';
  if (cleanHosts.some(isPrivateOrLocalHost)) return 'risky';
  if (cleanHosts.some((host) => TRUSTED_SOURCE_DOMAINS.some((domain) => hostMatches(host, domain)))) return 'trusted';
  if (cleanHosts.some((host) => KNOWN_SOURCE_DOMAINS.some((domain) => hostMatches(host, domain)))) return 'known';
  return 'unknown';
}

function classifySourceTrust(source: string, evidenceUrls: string[]): { sourceTrust: KnowledgeCandidate['sourceTrust']; sourceHosts: string[] } {
  const hosts = [...new Set([...evidenceUrls, ...extractUrls(source)].map(hostnameFromUrl).filter(Boolean))].slice(0, 8);
  return {
    sourceTrust: sourceTrustForHosts(hosts),
    sourceHosts: hosts,
  };
}

export function previewKnowledgeSourceTrust(input: string): KnowledgeSourceTrustPreview {
  const clean = (input || '').trim();
  const urls = extractLooseSourceUrls(clean);
  const sourceHosts = [...new Set(urls.map(hostnameFromUrl).filter(Boolean))].slice(0, 8);
  const sourceTrust = sourceTrustForHosts(sourceHosts);
  const reasons: string[] = [];
  const policy: string[] = [];

  if (sourceHosts.length === 0) {
    reasons.push('未解析到 URL 或域名');
    policy.push('补公开链接后再生成候选；无来源内容不能自动写入知识库。');
  } else if (sourceTrust === 'risky') {
    const riskyHosts = sourceHosts.filter(isPrivateOrLocalHost);
    reasons.push(`包含本地/内网来源${riskyHosts.length ? `: ${riskyHosts.join(', ')}` : ''}`);
    policy.push('禁止自动写库；不能把本地、内网或临时页面当公开证据。');
    policy.push('如确实是素材，请放 knowledge/inbox 后人工摘要，不要声称公开事实。');
  } else if (sourceTrust === 'trusted') {
    const trustedHosts = sourceHosts.filter((host) => TRUSTED_SOURCE_DOMAINS.some((domain) => hostMatches(host, domain)));
    reasons.push(`命中可信公开来源${trustedHosts.length ? `: ${trustedHosts.join(', ')}` : ''}`);
    policy.push('public_fact 可以进入自动质量闸；仍会检查风险词、置信度和证据链接。');
    policy.push('实时排名、阵容、赛果、转会回答时仍优先 CS 实时链路和 fresh/stale 证据。');
  } else if (sourceTrust === 'known') {
    const knownHosts = sourceHosts.filter((host) => KNOWN_SOURCE_DOMAINS.some((domain) => hostMatches(host, domain)));
    reasons.push(`命中已知平台${knownHosts.length ? `: ${knownHosts.join(', ')}` : ''}`);
    policy.push('适合 public_summary、切片索引或二手摘要；不能自动写 public_fact。');
    policy.push('长语录、礼物原话、转写内容必须人工核验，只能摘要化使用。');
  } else {
    reasons.push(`未知公开域名: ${sourceHosts.join(', ')}`);
    policy.push('默认只生成待审核候选；补 HLTV/Liquipedia/Valve/CS API 等可信来源后再写事实。');
    policy.push('模型回复不能把 unknown 来源包装成“已核验原话/实时结论”。');
  }

  return {
    input: clean,
    urls,
    sourceTrust,
    sourceHosts,
    reasons,
    policy,
  };
}

function inspectSourceAutoWrite(source: KnowledgeSource, sourceTrust: KnowledgeCandidate['sourceTrust']): { state: KnowledgeSourceInspectRow['autoWriteState']; reason: string } {
  if (!source.autoCommitEligible) {
    return { state: 'manual-only', reason: 'sources.json 未开启自动写入' };
  }
  if (sourceTrust === 'risky') {
    return { state: 'blocked', reason: '命中本地/内网/风险域名，禁止自动写库' };
  }
  if (!source.trusted) {
    return { state: 'manual-only', reason: 'sources.json 未标 trusted，需人工复核' };
  }
  if (source.sourceType === 'public_fact' && sourceTrust !== 'trusted') {
    return { state: 'blocked', reason: 'public_fact 必须有 trusted 公开来源域名' };
  }
  if (source.sourceType === 'public_summary' && sourceTrust !== 'trusted' && sourceTrust !== 'known') {
    return { state: 'manual-only', reason: '摘要源缺少 trusted/known 域名，只能生成待审候选' };
  }
  if (source.sourceType === 'local_transcript' || source.sourceType === 'style_template') {
    return { state: 'manual-only', reason: '本地转写/风格模板只走人工素材流' };
  }
  if (source.sourceType === 'unknown') {
    return { state: 'manual-only', reason: 'unknown 类型不能自动写入事实库' };
  }
  return { state: 'allowed', reason: '配置允许且来源评级满足自动质量闸前置条件' };
}

export function inspectKnowledgeSources(
  sources: KnowledgeSource[] = loadKnowledgeSources(),
  options: { now?: number; limit?: number } = {},
): KnowledgeSourceInspectReport {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const limit = Math.max(1, Math.floor(Number(options.limit) || sources.length || 1));
  const state = readSourceState();
  const allRows = sources.map((source) => {
    const intervalMinutes = Math.max(30, Number(source.intervalMinutes) || 720);
    const intervalMs = intervalMinutes * 60 * 1000;
    const lastRefreshAt = state[source.id] || 0;
    const minutesSinceRefresh = lastRefreshAt > 0 ? Math.max(0, Math.floor((now - lastRefreshAt) / 60000)) : 0;
    const nextRefreshInMinutes = lastRefreshAt > 0 ? Math.max(0, Math.ceil((lastRefreshAt + intervalMs - now) / 60000)) : 0;
    const status: KnowledgeSourceInspectRow['status'] = !lastRefreshAt
      ? 'never'
      : now - lastRefreshAt >= intervalMs
        ? 'due'
        : 'fresh';
    const evidenceHint = sourceIdEvidenceHint(source.id);
    const preview = previewKnowledgeSourceTrust([source.query, evidenceHint].filter(Boolean).join(' '));
    const autoWrite = inspectSourceAutoWrite(source, preview.sourceTrust);
    return {
      id: source.id,
      query: source.query,
      sourceType: source.sourceType,
      trusted: source.trusted,
      autoCommitEligible: source.autoCommitEligible,
      intervalMinutes,
      lastRefreshAt,
      minutesSinceRefresh,
      nextRefreshInMinutes,
      status,
      sourceTrust: preview.sourceTrust,
      sourceHosts: preview.sourceHosts,
      evidenceHint,
      autoWriteState: autoWrite.state,
      autoWriteReason: autoWrite.reason,
    };
  });
  const statusRank: Record<KnowledgeSourceInspectRow['status'], number> = { due: 0, never: 1, fresh: 2 };
  const rows = [...allRows]
    .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.id.localeCompare(b.id))
    .slice(0, limit);
  return {
    generatedAt: now,
    total: allRows.length,
    fresh: allRows.filter((row) => row.status === 'fresh').length,
    due: allRows.filter((row) => row.status === 'due').length,
    never: allRows.filter((row) => row.status === 'never').length,
    autoCommitEligible: allRows.filter((row) => row.autoCommitEligible).length,
    trustedConfigured: allRows.filter((row) => row.trusted).length,
    trustedDomains: allRows.filter((row) => row.sourceTrust === 'trusted').length,
    riskyDomains: allRows.filter((row) => row.sourceTrust === 'risky').length,
    rows,
  };
}

function normalizeImportUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('缺少 URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('URL 不合法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https URL');
  }
  parsed.hash = '';
  return parsed.toString();
}

function decodeHtmlEntity(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(html: string): string {
  return decodeHtmlEntity(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function attrMap(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntity(match[3] || match[4] || match[5] || '');
  }
  return attrs;
}

function extractMetaContent(html: string, names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const pattern = /<meta\b([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = attrMap(match[1]);
    const key = String(attrs.name || attrs.property || '').toLowerCase();
    const content = String(attrs.content || '').trim();
    if (content && wanted.has(key)) return content;
  }
  return '';
}

function extractFirstTagText(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  return match ? stripHtmlTags(match[1]) : '';
}

function extractParagraphSnippets(html: string, maxItems: number = 2): string[] {
  const snippets: string[] = [];
  const pattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && snippets.length < maxItems) {
    const text = stripHtmlTags(match[1])
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 24) continue;
    if (/^(cookie|privacy|subscribe|advertisement|copyright)/i.test(text)) continue;
    snippets.push(text.slice(0, 240));
  }
  return snippets;
}

function summarizeImportedHtml(html: string): { title: string; description: string; site: string; snippets: string[] } {
  const title = extractMetaContent(html, ['og:title', 'twitter:title'])
    || extractFirstTagText(html, 'title')
    || extractFirstTagText(html, 'h1')
    || '未命名网页';
  const description = extractMetaContent(html, ['description', 'og:description', 'twitter:description']);
  const site = extractMetaContent(html, ['og:site_name']) || '';
  const snippets = extractParagraphSnippets(html, description ? 1 : 2);
  return {
    title: safeTitle(title),
    description: description.slice(0, 260),
    site: site.slice(0, 80),
    snippets,
  };
}

function requestImportUrl(url: string, timeoutMs: number, redirectCount: number = 0): Promise<UrlFetchResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, finalUrl: url, statusCode: 0, contentType: '', body: '', error: 'URL 不合法' });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result: UrlFetchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': IMPORT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Encoding': 'gzip,deflate,br',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');

      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        if (redirectCount >= MAX_IMPORT_REDIRECTS) {
          res.resume();
          finish({ ok: false, finalUrl: url, statusCode, contentType, body: '', error: '跳转次数过多' });
          return;
        }
        let next = '';
        try {
          next = new URL(res.headers.location, parsed).toString();
        } catch {
          next = '';
        }
        res.resume();
        if (!next) {
          finish({ ok: false, finalUrl: url, statusCode, contentType, body: '', error: '跳转地址不合法' });
          return;
        }
        void requestImportUrl(next, timeoutMs, redirectCount + 1).then(finish);
        return;
      }

      if (statusCode >= 400) {
        res.resume();
        finish({ ok: false, finalUrl: url, statusCode, contentType, body: '', error: `HTTP ${statusCode}` });
        return;
      }

      let stream: NodeJS.ReadableStream = res;
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_IMPORT_BYTES) {
          finish({ ok: false, finalUrl: url, statusCode, contentType, body: '', error: `页面过大，超过 ${Math.round(MAX_IMPORT_BYTES / 1024)}KB` });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        finish({
          ok: true,
          finalUrl: url,
          statusCode,
          contentType,
          body: Buffer.concat(chunks).toString('utf-8'),
          error: '',
        });
      });
      stream.on('error', (err) => {
        finish({ ok: false, finalUrl: url, statusCode, contentType, body: '', error: err.message });
      });
    });

    req.on('error', (err) => {
      finish({ ok: false, finalUrl: url, statusCode: 0, contentType: '', body: '', error: err.message });
    });
    req.setTimeout(Math.max(1000, timeoutMs), () => {
      finish({ ok: false, finalUrl: url, statusCode: 0, contentType: '', body: '', error: '请求超时' });
      req.destroy();
    });
  });
}

function normalizeForHash(text: string): string {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
}

function hashCandidate(candidate: KnowledgeCandidate): string {
  return crypto
    .createHash('sha1')
    .update([
      normalizeForHash(candidate.query),
      normalizeForHash(candidate.source),
      normalizeForHash(candidate.markdown),
      candidate.evidenceUrls.join('|'),
    ].join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectRisk(text: string, sourceType: KnowledgeCandidate['sourceType']): KnowledgeCandidate['risk'] {
  if (sourceType === 'local_transcript') return 'review';
  if (/礼物|感谢|原话|转写|逐字|完整|台词|切片/.test(text)) return 'review';
  const longLine = text.split(/\r?\n/).some((line) => line.trim().length > 220);
  if (longLine) return 'needs_source';
  return 'safe';
}

function removeKnowledgeRuleLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^- (写库规则|使用规则|核验状态|自动质量闸|知识来源类型|来源类型|内容类型)[：:]/.test(line.trim()))
    .join('\n');
}

const KNOWLEDGE_ORIGINAL_QUOTE_MARKER = '(?:原话|逐字(?:原话|台词|转写|复述|字幕)?|真实(?:语录|台词|原文)|直播(?:原文|原话|台词|字幕)|切片(?:原文|原话|台词|字幕)|经典(?:语录|台词)?|名场面(?:台词|语录|原文)?|完整(?:台词|字幕|转写|原文|原话)|本人(?:语录|说过|讲过)|名言|一字不差|一比一(?:还原|复刻)?|原样(?:复刻|还原|复述|搬运)?|照着(?:说|念|读))';
const KNOWLEDGE_ORIGINAL_QUOTE_SPEAKER = '(?:玩机器|MachineWJQ|Machine|6657|机器|主播|本人|本尊)';

function hasNonVerbatimBoundary(text: string): boolean {
  return [
    new RegExp(`(?:不是|不算|不能当|不得当作|不要当|别当|不应当|不能说成|不要说成|未经核验|没核验|未核验|待核验|不保证|不能保证|只能当|仅当|只做|只作为).{0,24}${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`(?:拟态|模板|摘要|短摘|场景卡|口吻参考|风格参考|语气参考|锚点).{0,24}${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}.{0,24}(?:不是|不算|不能当|不得当作|不要当|别当|未经核验|待核验|不保证|不能保证|拟态|模板|摘要|短摘|锚点)`, 'i'),
  ].some((pattern) => pattern.test(text));
}

function hasVerifiedOriginalQuoteEvidence(text: string): boolean {
  return /(?:已核验|核验状态[：:].{0,24}(?:已核验|公开证据|证据充分)|核验(?:过的)?(?:短句|语录|原话))/.test(text)
    && /(?:证据链接|来源|链接)[：:]\s*https?:\/\//i.test(text);
}

function hasOriginalQuoteClaim(text: string): boolean {
  const body = removeKnowledgeRuleLines(text);
  if (!body.trim()) return false;
  if (hasNonVerbatimBoundary(body)) return false;
  const claimPatterns = [
    new RegExp(`${KNOWLEDGE_ORIGINAL_QUOTE_SPEAKER}.{0,18}${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}`, 'i'),
    new RegExp(`${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}.{0,18}${KNOWLEDGE_ORIGINAL_QUOTE_SPEAKER}`, 'i'),
    new RegExp(`(?:这是|这句|这段|下面|以下|给你来句|来句|给我|来段|来一段|整段|整一下|念一段|复述一下|还原一下|收录|整理).{0,16}${KNOWLEDGE_ORIGINAL_QUOTE_MARKER}`, 'i'),
    /(?:逐字|原样|完整|一字不差|一比一)(?:复刻|还原|复述|搬运|转写).{0,16}(?:台词|字幕|原文|原话|名场面)/i,
    /(?:原话|逐字原话|直播原文|切片原文|经典语录)[：:]/i,
  ];
  return claimPatterns.some((pattern) => pattern.test(body));
}

function hasUnsupportedOriginalQuoteClaimInKnowledge(text: string): boolean {
  return hasOriginalQuoteClaim(text) && !hasVerifiedOriginalQuoteEvidence(text);
}

function knowledgeContentLines(text: string): string[] {
  return removeKnowledgeRuleLines(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^- (?:来源|证据链接|链接|URL|标题|查询|置信度|来源评级|自动写入资格|内容类型)[：:]/i.test(line));
}

function speechLineLength(line: string): number {
  return line
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^(?:[-*]\s*)?(?:>|[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:[-–—/:：]\s*)?)/, '')
    .trim()
    .length;
}

function isTranscriptLikeLine(line: string): boolean {
  const normalized = line.replace(/^[-*]\s*/, '').trim();
  const payloadLength = speechLineLength(normalized);
  if (payloadLength < 28) return false;
  if (/^(?:>|["“「『'‘])/.test(normalized)) return true;
  if (/^[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*(?:[-–—/:：]|\s)/.test(normalized)) return true;
  return /^(?:主播|玩机器|MachineWJQ|Machine|6657|弹幕|观众|水友|老板|解说|旁白|队友|嘉宾|主持人|我|他说|她说)\s*[：:]/i.test(normalized);
}

function hasLongVerbatimTranscriptRisk(text: string): boolean {
  const lines = knowledgeContentLines(text);
  if (lines.length === 0) return false;

  const transcriptLines = lines.filter(isTranscriptLikeLine);
  const transcriptChars = transcriptLines.reduce((sum, line) => sum + speechLineLength(line), 0);
  let longestRun = 0;
  let currentRun = 0;
  for (const line of lines) {
    if (isTranscriptLikeLine(line)) {
      currentRun++;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const compact = lines.join('\n').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, '');
  const quoteSegments = compact.match(/[“「『"][^“”「」『』"]{24,}[”」』"]/g) || [];
  const speakerTurns = compact.match(/(?:主播|玩机器|MachineWJQ|Machine|6657|弹幕|观众|水友|老板|解说|旁白|队友|嘉宾|主持人|我|他说|她说)[：:]/gi) || [];

  if (transcriptLines.length >= 3 && transcriptChars >= 240) return true;
  if (transcriptLines.length >= 4 && transcriptChars >= 160) return true;
  if (transcriptLines.length >= 5 && transcriptChars >= 180) return true;
  if (longestRun >= 3 && transcriptChars >= 200) return true;
  if (quoteSegments.length >= 3 && compact.length >= 300) return true;
  if (speakerTurns.length >= 4 && compact.length >= 360) return true;
  return false;
}

export function evaluateKnowledgeCandidateQuality(candidate: KnowledgeCandidate): KnowledgeCandidateQuality {
  const issues: string[] = [];
  if (!candidate.autoCommitEligible) issues.push('source not auto-eligible');
  if (candidate.risk === 'needs_source') issues.push('risk needs_source');
  if (candidate.confidence === 'low') issues.push('low confidence');
  if (candidate.evidenceUrls.length === 0 && candidate.sourceType !== 'style_template') issues.push('missing evidence url');
  if (candidate.sourceTrust === 'risky') issues.push('risky source domain');
  if (candidate.autoCommitEligible && candidate.sourceTrust === 'unknown' && candidate.sourceType !== 'style_template') issues.push('unknown source domain');
  if (candidate.autoCommitEligible && candidate.sourceType === 'public_fact' && candidate.sourceTrust !== 'trusted') {
    issues.push('public fact auto-commit requires trusted source');
  }
  if (
    candidate.autoCommitEligible
    && candidate.sourceType === 'public_summary'
    && candidate.sourceTrust !== 'trusted'
    && candidate.sourceTrust !== 'known'
  ) {
    issues.push('public summary auto-commit requires known source');
  }
  if (candidate.sourceType === 'local_transcript') issues.push('local transcript requires manual review');
  if (candidate.sourceType === 'unknown') issues.push('unknown source type');
  if (
    candidate.sourceType === 'public_summary'
    && candidate.confidence !== 'high'
    && candidate.risk !== 'safe'
  ) {
    issues.push('public summary needs high confidence or safe risk');
  }
  const candidateBody = candidate.markdown
    .split(/\r?\n/)
    .filter((line) => !/^- (写库规则|使用规则|核验状态)[：:]/.test(line.trim()))
    .join('\n');
  if (/原话[：:]|逐字原话|逐字|完整台词|完整字幕|完整转写/.test(candidateBody)) {
    issues.push('possible verbatim/long transcript');
  }
  if (hasLongVerbatimTranscriptRisk(candidateBody)) {
    issues.push('long transcript needs summarizing');
  }
  if (hasUnsupportedOriginalQuoteClaimInKnowledge(candidateBody)) {
    issues.push('unsupported original quote claim');
  }
  return { ok: issues.length === 0, issues };
}

function refreshKnowledgeCandidateQuality(candidate: KnowledgeCandidate): KnowledgeCandidateQuality {
  const quality = evaluateKnowledgeCandidateQuality(candidate);
  candidate.qualityIssues = quality.issues;
  return quality;
}

function localizeKnowledgeQualityIssue(issue: string): string {
  const labels: Record<string, string> = {
    'source not auto-eligible': '来源未允许自动写入',
    'risk needs_source': '风险需要补来源',
    'low confidence': '低置信度',
    'missing evidence url': '缺少证据链接',
    'risky source domain': '风险来源域名',
    'unknown source domain': '未知来源域名',
    'public fact auto-commit requires trusted source': '公开事实自动写入需可信域名',
    'public summary auto-commit requires known source': '公开摘要自动写入需已知来源',
    'local transcript requires manual review': '本地转写需人工审核',
    'unknown source type': '未知来源类型',
    'public summary needs high confidence or safe risk': '公开摘要需高置信或低风险',
    'possible verbatim/long transcript': '疑似逐字/长转写',
    'long transcript needs summarizing': '长转写/长引用需摘要化',
    'unsupported original quote claim': '未核验原话声称',
  };
  return labels[issue] || issue;
}

function sourceTypeFromSection(content: string): KnowledgeCandidate['sourceType'] | '' {
  const match = content.match(/^\s*-\s*(?:知识来源类型|来源类型)[：:]\s*(public_fact|public_summary|local_transcript|style_template|unknown)\b/im);
  return (match?.[1] as KnowledgeCandidate['sourceType']) || '';
}

function sourceTrustFromSection(content: string): KnowledgeCandidate['sourceTrust'] | '' {
  const match = content.match(/^\s*-\s*来源评级[：:]\s*(trusted|known|unknown|risky)\b/im);
  return (match?.[1]?.toLowerCase() as KnowledgeCandidate['sourceTrust']) || '';
}

function isKnowledgeBoundaryRuleSection(title: string): boolean {
  return /回复铁律|禁用边界|导入规范|写库规则|语录纠错|规则|边界/.test(title);
}

function sourceAuditIssuesForSection(section: KnowledgeSection): KnowledgeAuditIssue[] {
  const sourceType = sourceTypeFromSection(section.content);
  const isAutoBlock = section.content.includes('<!-- kb:auto');
  if (!sourceType && !isAutoBlock) return [];

  const sourceTrust = sourceTrustFromSection(section.content);
  if (!sourceTrust) {
    const inferred = classifySourceTrust(section.content, extractUrls(section.content)).sourceTrust;
    return [{
      level: sourceType === 'style_template' ? 'info' : 'risk',
      title: `来源评级缺失: ${section.title}`,
      detail: `自动/候选入库分块应保留来源评级，当前按证据域名推断为 ${inferred}。`,
    }];
  }

  if (sourceTrust === 'risky') {
    return [{
      level: 'hard',
      title: `风险来源已入库: ${section.title}`,
      detail: '主库分块标记为 risky 来源，应回滚、改为候选，或补充可靠公开证据后再提交。',
    }];
  }

  if (sourceType === 'public_fact' && sourceTrust !== 'trusted') {
    return [{
      level: 'hard',
      title: `公开事实来源不够可信: ${section.title}`,
      detail: `public_fact 应来自 trusted 来源，当前为 ${sourceTrust}。`,
    }];
  }

  if (sourceType === 'public_summary' && sourceTrust !== 'trusted' && sourceTrust !== 'known') {
    return [{
      level: 'risk',
      title: `公开摘要来源不明确: ${section.title}`,
      detail: `public_summary 至少需要 known 来源，当前为 ${sourceTrust}。`,
    }];
  }

  if (sourceTrust === 'unknown') {
    return [{
      level: 'risk',
      title: `未知来源已入库: ${section.title}`,
      detail: '来源评级为 unknown，建议补公开链接或降级为待核验素材。',
    }];
  }

  return [];
}

function originalQuoteAuditIssueForSection(section: KnowledgeSection): KnowledgeAuditIssue | null {
  if (isKnowledgeBoundaryRuleSection(section.title)) return null;
  if (!hasUnsupportedOriginalQuoteClaimInKnowledge(section.content)) return null;
  const sourceType = sourceTypeFromSection(section.content);
  const level: KnowledgeAuditIssue['level'] = sourceType === 'style_template' ? 'risk' : 'hard';
  return {
    level,
    title: `未核验原话声称: ${section.title}`,
    detail: '主库内容把素材包装成原话/逐字/经典语录/本人说过，但没有明确已核验证据；应改成拟态模板、短摘要或补证据。',
  };
}

function longTranscriptAuditIssueForSection(section: KnowledgeSection): KnowledgeAuditIssue | null {
  if (isKnowledgeBoundaryRuleSection(section.title)) return null;
  if (!hasLongVerbatimTranscriptRisk(section.content)) return null;
  const sourceType = sourceTypeFromSection(section.content);
  const level: KnowledgeAuditIssue['level'] = sourceType === 'style_template' ? 'risk' : 'hard';
  return {
    level,
    title: `长转写/长引用需摘要化: ${section.title}`,
    detail: '主库内容像多行字幕、时间轴或主播/弹幕对话块；应压成场景、短摘要、可用话术和禁用边界，不要整段作为可复读语料。',
  };
}

const FRESHNESS_FACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '最新/当前措辞', pattern: /最新|当前|现在|目前|今日|今天|近期|最近|实时|刚刚|刚查到|正在/i },
  { label: '排名/榜单', pattern: /排名|排行|榜单|top\s*\d+|世界第一|VRS|HLTV/i },
  { label: '阵容/转会', pattern: /阵容|转会|加入|离队|替补|租借|官宣|签约|bench|roster|transfer/i },
  { label: '比赛/赛果', pattern: /比分|赛果|赛程|赛况|正在打|刚结束|胜者|地图比分|BO[135]|matchid/i },
  { label: '版本/地图池', pattern: /版本|更新|改动|active duty|地图池|服役地图|移除|加入地图/i },
];

function sectionHasFreshnessBoundary(content: string): boolean {
  return /fresh|stale|miss|旧快照|旧线索|抓取时间|拉取|快照|证据链接|来源[:：]|来源：|核验状态|实时源|\/cs verify|\/cs evidence|不得当作当前|不能当实时|仍需实时/i.test(content);
}

function sectionHasEvidenceUrl(content: string): boolean {
  return extractUrls(content).length > 0;
}

function freshnessTriggersForSection(section: KnowledgeSection): string[] {
  const haystack = `${section.title}\n${section.content}`;
  return FRESHNESS_FACT_PATTERNS
    .filter((item) => item.pattern.test(haystack))
    .map((item) => item.label);
}

function extractFreshnessMatchId(text: string): string {
  const match = text.match(/(?:matchid|match\s*id|match[:：#\s=]*)\s*(\d{6,9})\b/i)
    || text.match(/\b(\d{7})\b/);
  return match?.[1] || '';
}

function dedupeKnowledgeFreshnessRoutes(routes: string[]): string[] {
  return [...new Set(routes.map((item) => item.trim()).filter(Boolean))].slice(0, 8);
}

function buildKnowledgeFreshnessRemediation(section: KnowledgeSection): string[] {
  const text = `${section.title}\n${section.content}`;
  const routes: string[] = [];
  const matchId = extractFreshnessMatchId(text);

  if (matchId) {
    routes.push(`/cs verify match ${matchId}`, `/cs evidence match ${matchId}`, `管理员 /cs warm plan match ${matchId}`);
  }
  if (/排名|排行|榜单|top\s*\d+|世界第一|VRS|HLTV/i.test(text)) {
    routes.push('/cs verify ranking', '/cs evidence ranking', '管理员 /cs warm plan ranking');
  }
  if (/比分|赛果|赛程|赛况|正在打|刚结束|胜者|地图比分|BO[135]|比赛/i.test(text)) {
    routes.push('/cs verify results', '/cs evidence results', '管理员 /cs warm plan results');
  }
  if (/阵容|转会|加入|离队|替补|租借|官宣|签约|bench|roster|transfer|队伍|选手/i.test(text)) {
    routes.push('/cs verify all', '/cs evidence all', '管理员 /cs warm plan all');
  }
  if (/版本|更新|改动|active duty|地图池|服役地图|移除|加入地图/i.test(text)) {
    routes.push('/cs sources', '/cs verify all', '管理员 /cs warm plan all');
  }
  if (routes.length === 0) {
    routes.push('/kb trust <来源链接>', '/kb stale');
  }
  return dedupeKnowledgeFreshnessRoutes(routes);
}

function freshnessIssueForSection(section: KnowledgeSection): KnowledgeFreshnessIssue | null {
  if (isKnowledgeBoundaryRuleSection(section.title)) return null;
  const triggers = freshnessTriggersForSection(section);
  if (triggers.length === 0) return null;

  const sourceType = sourceTypeFromSection(section.content);
  const contentType = (section.content.match(/^\s*-\s*内容类型[：:]\s*([^\n]+)/im) || [])[1] || '';
  const likelyRealtimeFact = /public_fact|public_summary/.test(sourceType)
    || /公开|事实|队伍|选手|排名|赛程|赛果|版本|地图池|阵容|转会/.test(section.title + contentType);
  if (!likelyRealtimeFact) return null;

  const hasBoundary = sectionHasFreshnessBoundary(section.content);
  const hasUrl = sectionHasEvidenceUrl(section.content);
  const missing: string[] = [];
  if (!hasUrl) missing.push('证据链接');
  if (!hasBoundary) missing.push('fresh/stale/抓取时间/旧快照边界');
  if (!sourceType) missing.push('知识来源类型');
  if (missing.length === 0) return null;

  const level: KnowledgeFreshnessIssue['level'] = sourceType === 'public_fact' && (!hasUrl || !hasBoundary)
    ? 'hard'
    : 'risk';
  const remediation = buildKnowledgeFreshnessRemediation(section);
  const verifyHints = remediation.filter((item) => /\/cs verify/.test(item)).slice(0, 2);
  const commandHint = verifyHints.length > 0 ? verifyHints.join(' / ') : remediation[0];
  return {
    level,
    title: section.title,
    triggers,
    missing,
    excerpt: excerpt(section.content, 150),
    advice: `补可信来源和快照时间；实时事实回复前先 ${commandHint}；stale/miss 不能当实时结论，不确定就把块降级为旧线索/摘要。`,
    remediation,
  };
}

export function inspectKnowledgeFreshness(limit = 8): KnowledgeFreshnessReport {
  loadKnowledge();
  const issues = cachedSections
    .map(freshnessIssueForSection)
    .filter((issue): issue is KnowledgeFreshnessIssue => !!issue);
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, 30));
  return {
    generatedAt: Date.now(),
    sections: cachedSections.length,
    scanned: cachedSections.length,
    issues: issues.slice(0, safeLimit),
    riskSections: issues.filter((issue) => issue.level === 'risk').length,
    hardSections: issues.filter((issue) => issue.level === 'hard').length,
  };
}

function normalizeKnowledgeFreshnessTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchesKnowledgeFreshnessTitle(sectionTitle: string, targetTitle: string): boolean {
  if (!sectionTitle || !targetTitle) return false;
  if (sectionTitle === targetTitle) return true;
  return sectionTitle.length >= 6 && targetTitle.includes(sectionTitle)
    || targetTitle.length >= 6 && sectionTitle.includes(targetTitle);
}

export function findKnowledgeFreshnessIssuesForTitles(titles: string[], limit = 8): KnowledgeFreshnessIssue[] {
  loadKnowledge();
  const targets = titles
    .map(normalizeKnowledgeFreshnessTitle)
    .filter(Boolean);
  if (targets.length === 0) return [];

  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 8, 20));
  const issues: KnowledgeFreshnessIssue[] = [];
  const seen = new Set<string>();
  for (const section of cachedSections) {
    const sectionTitle = normalizeKnowledgeFreshnessTitle(section.title);
    if (!targets.some((target) => matchesKnowledgeFreshnessTitle(sectionTitle, target))) continue;
    const issue = freshnessIssueForSection(section);
    if (!issue || seen.has(issue.title)) continue;
    issues.push(issue);
    seen.add(issue.title);
    if (issues.length >= safeLimit) break;
  }
  return issues;
}

export function describeKnowledgeCandidateQuality(candidate: KnowledgeCandidate): string {
  const quality = refreshKnowledgeCandidateQuality(candidate);
  if (quality.ok) return '通过';
  return `未通过：${quality.issues.map(localizeKnowledgeQualityIssue).join('；')}`;
}

export function recommendKnowledgeCandidateAction(candidate: KnowledgeCandidate): string {
  const quality = refreshKnowledgeCandidateQuality(candidate);
  const id = candidate.id;

  if (candidate.sourceTrust === 'risky') {
    return `建议: 先 /kb drop ${id}；risky 来源不能当公开证据，确有授权素材请走 inbox 摘要审核。`;
  }
  if (quality.issues.includes('unsupported original quote claim')) {
    return `建议: 先删掉“原话/逐字/本人说过”声称，改成短摘要/场景模板；补已核验证据后再 /kb commit ${id}。`;
  }
  if (quality.issues.includes('long transcript needs summarizing')) {
    return `建议: 先压成“场景/短摘要/可用话术/禁用边界”，不要整段搬字幕或长引用；整理后再 /kb preview 或 /kb commit ${id}。`;
  }
  if (candidate.sourceTrust === 'unknown' && candidate.sourceType !== 'style_template') {
    return `建议: 暂缓 /kb commit ${id}；先补 HLTV/Liquipedia/Valve/CS API 等可信链接，或降级为待核验摘要。`;
  }
  if (candidate.sourceType === 'public_fact' && candidate.sourceTrust !== 'trusted') {
    return `建议: 不写 public_fact；补 trusted 来源后重跑，当前最多当摘要线索。`;
  }
  if (
    candidate.sourceType === 'public_summary'
    && candidate.sourceTrust !== 'trusted'
    && candidate.sourceTrust !== 'known'
  ) {
    return `建议: 暂不写摘要；补 known/trusted 来源后再 /kb preview。`;
  }
  if (quality.issues.includes('possible verbatim/long transcript') || candidate.risk !== 'safe') {
    return `建议: 人工确认只保留短摘要/场景模板，删掉逐字和长转写后再 /kb commit ${id}。`;
  }
  if (quality.ok && candidate.autoCommitEligible) {
    return `建议: 可写入；确认内容准确后 /kb commit ${id}，自动刷新也可通过质量闸。`;
  }
  if (quality.ok) {
    return `建议: 可人工写入；确认来源合法、摘要准确后 /kb commit ${id}。`;
  }
  return `建议: 暂缓自动写入；先处理质量闸问题，确认只是短摘要且来源可靠后再 /kb commit ${id}。`;
}

function excerpt(text: string, maxChars: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function extractKeywords(title: string, content: string): string[] {
  const keywords = new Set<string>();
  const haystack = normalizeText(`${title}\n${content}`);
  for (const keyword of BASE_KEYWORDS) {
    if (haystack.includes(keyword.toLowerCase())) {
      keywords.add(keyword.toLowerCase());
    }
  }

  const tokens = `${title}\n${content}`.match(/[\u4e00-\u9fa5A-Za-z0-9_]{2,24}/g) || [];
  for (const token of tokens.slice(0, 120)) {
    const lower = token.toLowerCase();
    if (BASE_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      keywords.add(lower);
    }
  }
  return [...keywords];
}

function parseMarkdown(markdown: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  const lines = markdown.split(/\r?\n/);
  let title = '知识库';
  let buffer: string[] = [];

  const push = (): void => {
    const content = buffer.join('\n').trim();
    if (!content) return;
    sections.push({
      title,
      content,
      keywords: extractKeywords(title, content),
    });
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      push();
      title = match[1].trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  push();
  return sections;
}

function loadKnowledge(): void {
  try {
    ensureKnowledgeDirs();
    const stat = fs.statSync(DEFAULT_KNOWLEDGE_FILE);
    if (stat.mtimeMs === cachedMtime && cachedSections.length > 0) return;

    cachedFullText = fs.readFileSync(DEFAULT_KNOWLEDGE_FILE, 'utf-8');
    cachedSections = parseMarkdown(cachedFullText);
    cachedMtime = stat.mtimeMs;
    syncKnowledgeDb(cachedSections, stat.mtimeMs);
    console.log(`[Knowledge] 加载 ${cachedSections.length} 个知识库分块`);
  } catch (err) {
    cachedFullText = '';
    cachedSections = [];
    cachedMtime = 0;
    console.error('[Knowledge] 加载失败:', err instanceof Error ? err.message : err);
  }
}

function scoreSection(section: KnowledgeSection, text: string): number {
  const normalized = normalizeText(text);
  let score = 0;
  for (const keyword of section.keywords) {
    if (normalized.includes(keyword)) score += keyword.length > 4 ? 3 : 1;
  }
  const title = normalizeText(section.title);
  if (normalized.includes(title)) score += 8;
  if (/语录|短句|经典|quote/i.test(text) && /语录|短句|短语|锚点|口癖|长句|戳一戳/.test(section.title)) score += 10;
  if (/切片|名场面|直播|礼物/.test(text) && /切片|名场面|直播|礼物/.test(section.title)) score += 8;
  if (/身份|是谁|玩机器/.test(text) && /身份/.test(section.title)) score += 6;
  if (/player|选手|niko|monesy|zywoo|s1mple|donk|ropz/i.test(text) && /选手|人物/.test(section.title)) score += 8;
  if (/team|队伍|navi|g2|vitality|spirit|faze|mouz/i.test(text) && /队伍/.test(section.title)) score += 8;
  if (/cs2|csgo|major|比赛|赛事/i.test(text) && /CS2|赛事|解说/.test(section.title)) score += 6;
  if (/知识库强制注入|回复铁律|真人化|非公式化|直播语态|口癖调度|反应强度|活人感|低攻击|去口癖/.test(text) && /回复铁律|直播语态|真人化|非公式化|去口癖|口癖|反应强度|拟态执行|知识命中优先级|低攻击|活人感/.test(section.title)) score += 16;
  if (/每日|今日|抽|签位|csplayer|csteam|csmap|csweapon|csrole|csloadout/i.test(text) && /每日 CS|抽签功能|每日CS/.test(section.title)) score += 12;
  if (/戳一戳|poke|让人不禁|黄河凌汛|太行山积雪/.test(text) && /戳一戳|短语锚点|公开索引/.test(section.title)) score += 12;
  if (/来源|索引/.test(section.title)) score -= 8;
  if (section.title === '知识库') score -= 6;
  return score;
}

function pruneCandidates(): void {
  if (pendingCandidates.size <= MAX_CANDIDATES) return;
  const sorted = [...pendingCandidates.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const candidate of sorted.slice(0, pendingCandidates.size - MAX_CANDIDATES)) {
    pendingCandidates.delete(candidate.id);
  }
}

function createCandidate(
  title: string,
  query: string,
  source: string,
  markdown: string,
  meta: Partial<Omit<KnowledgeCandidate, 'id' | 'title' | 'query' | 'source' | 'markdown' | 'createdAt'>> = {},
): KnowledgeCandidate {
  const sourceType = meta.sourceType || 'unknown';
  const risk = meta.risk || detectRisk(markdown, sourceType);
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const evidenceUrls = meta.evidenceUrls || extractUrls(markdown + '\n' + source);
  const sourceQuality = classifySourceTrust(source, evidenceUrls);
  const createdAt = Date.now();
  const candidate: KnowledgeCandidate = {
    id,
    title: safeTitle(title),
    query,
    source,
    markdown: markdown.trim(),
    createdAt,
    sourceType,
    confidence: meta.confidence || (sourceType === 'public_fact' ? 'high' : 'medium'),
    evidenceUrls,
    sourceTrust: sourceQuality.sourceTrust,
    sourceHosts: sourceQuality.sourceHosts,
    autoCommitEligible: meta.autoCommitEligible === true,
    risk,
    status: meta.status || 'pending',
  };
  candidate.markdown = withCandidateFreshnessBoundary(candidate);
  refreshKnowledgeCandidateQuality(candidate);
  pendingCandidates.set(id, candidate);
  pruneCandidates();
  return candidate;
}

function formatKnowledgeSnapshotTime(timestamp: number): string {
  return new Date(timestamp || Date.now()).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function candidateFreshnessTriggers(candidate: KnowledgeCandidate): string[] {
  const haystack = `${candidate.title}\n${candidate.query}\n${candidate.source}\n${candidate.markdown}`;
  return FRESHNESS_FACT_PATTERNS
    .filter((item) => item.pattern.test(haystack))
    .map((item) => item.label);
}

function candidateHasSnapshotTime(markdown: string): boolean {
  return /^\s*-\s*(?:抓取时间|快照时间|候选时间|拉取时间)[：:]/im.test(markdown);
}

function candidateHasExplicitFreshnessBoundary(markdown: string): boolean {
  return /^\s*-\s*(?:时效边界|新鲜度边界|实时边界)[：:]/im.test(markdown)
    || /fresh\/stale|stale\/miss|旧快照|旧线索|不能当实时|\/cs verify|\/cs evidence/i.test(markdown);
}

function withCandidateFreshnessBoundary(candidate: KnowledgeCandidate): string {
  const triggers = candidateFreshnessTriggers(candidate);
  const needsBoundary = candidate.sourceType === 'public_fact'
    || (candidate.sourceType === 'public_summary' && triggers.length > 0);
  if (!needsBoundary) return candidate.markdown.trim();

  const lines: string[] = [];
  if (!candidateHasSnapshotTime(candidate.markdown)) {
    lines.push(`- 快照时间：${formatKnowledgeSnapshotTime(candidate.createdAt)}`);
  }
  if (!candidateHasExplicitFreshnessBoundary(candidate.markdown)) {
    const triggerText = triggers.length > 0 ? triggers.join(' / ') : '公开事实';
    lines.push(`- 时效边界：命中 ${triggerText}；本块只代表入库快照/短摘要，回答最新排名、阵容、转会、赛果、版本或地图池前必须用 /cs verify、/cs evidence 和 fresh 实时证据复核，stale/miss 不能当实时结论。`);
  }

  if (lines.length === 0) return candidate.markdown.trim();
  return [candidate.markdown.trim(), ...lines].join('\n');
}

function candidateToMarkdown(candidate: KnowledgeCandidate): string {
  const quality = describeKnowledgeCandidateQuality(candidate);
  const evidence = candidate.evidenceUrls.length > 0
    ? candidate.evidenceUrls.map((url) => `- 证据链接：${url}`).join('\n')
    : '- 证据链接：暂无';
  return [
    retitleCandidateMarkdown(candidate).trim(),
    '',
    `- 知识来源类型：${candidate.sourceType}`,
    `- 置信度：${candidate.confidence}`,
    `- 来源评级：${candidate.sourceTrust}${candidate.sourceHosts.length > 0 ? ` (${candidate.sourceHosts.join(', ')})` : ''}`,
    `- 核验状态：${candidate.risk === 'safe' ? '已按公开事实/短摘要写入' : '待核验，回复时不得当作逐字原话'}`,
    `- 内容类型：${knowledgeContentType(candidate)}`,
    `- 自动写入资格：${candidate.autoCommitEligible ? '是' : '否'}`,
    `- 自动质量闸：${quality}`,
    evidence,
  ].join('\n');
}

function knowledgeContentType(candidate: KnowledgeCandidate): string {
  if (candidate.sourceType === 'public_fact') return '公开核验事实';
  if (candidate.sourceType === 'local_transcript') return '本地素材摘录';
  if (candidate.sourceType === 'style_template') return '直播语态模板';
  if (/礼物|感谢/.test(candidate.query + candidate.markdown)) return '礼物拟态模板';
  if (/bot|机器人|身份|本人|授权/.test(candidate.query + candidate.markdown)) return '身份问询话术';
  if (/切片|录播|弹幕|语录|名场面/.test(candidate.query + candidate.markdown)) return '公开切片摘要';
  return '待核验语料';
}

function sectionForCandidate(candidate: KnowledgeCandidate): string {
  const type = knowledgeContentType(candidate);
  return type === '公开核验事实'
    ? '公开核验事实 - 自动扩写'
    : type === '本地素材摘录'
      ? '本地素材摘录 - 主库'
      : type === '直播语态模板'
        ? '直播语态模板 - 自动扩写'
        : type === '礼物拟态模板'
          ? '礼物拟态模板 - 自动扩写'
          : type === '身份问询话术'
            ? '身份问询话术 - 自动扩写'
            : type === '公开切片摘要'
              ? '公开切片摘要 - 自动扩写'
              : '待核验语料 - 主库';
}

function retitleCandidateMarkdown(candidate: KnowledgeCandidate): string {
  const lines = candidate.markdown.trim().split(/\r?\n/);
  const sectionTitle = sectionForCandidate(candidate);
  if (lines[0]?.startsWith('## ')) {
    lines[0] = `## ${sectionTitle}`;
    return lines.join('\n');
  }
  return [`## ${sectionTitle}`, '', candidate.markdown.trim()].join('\n');
}

function candidateBlock(candidate: KnowledgeCandidate, batchId: string, hash: string, maxChars: number): string {
  const body = candidateToMarkdown(candidate).slice(0, maxChars);
  return [
    `<!-- kb:auto batch=${batchId} hash=${hash} begin -->`,
    body,
    `<!-- kb:auto batch=${batchId} hash=${hash} end -->`,
  ].join('\n');
}

function hasCommittedHash(hash: string): boolean {
  loadKnowledge();
  if (cachedFullText.includes(`hash=${hash}`)) return true;
  return readAutoLog().some((entry) => entry.hash === hash && entry.status === 'committed');
}

export function getKnowledgeStats(): {
  sections: number;
  chars: number;
  keywords: number;
  selectHits: number;
  selectMisses: number;
  searchHits: number;
  searchMisses: number;
  candidates: number;
  quarantineFiles: number;
  autoCommitted: number;
  quarantined: number;
  autoEnabled: boolean;
  lastAutoRefreshAt: number;
  auditIssues: number;
  batches: number;
  rollbackableBatches: number;
  sourceStates: number;
  trustedSourceCandidates: number;
  riskySourceCandidates: number;
  unknownSourceCandidates: number;
  dbMode: string;
  dbSections: number;
  dbQueries: number;
  dbHits: number;
  dbMisses: number;
  dbLastError: string;
} {
  loadKnowledge();
  const batches = listKnowledgeBatches(100);
  const sourceStates = Object.keys(readSourceState()).length;
  const dbStats = getKnowledgeDbStats();
  const candidates = [...pendingCandidates.values()];
  return {
    sections: cachedSections.length,
    chars: cachedFullText.length,
    keywords: BASE_KEYWORDS.length,
    selectHits,
    selectMisses,
    searchHits,
    searchMisses,
    candidates: pendingCandidates.size,
    quarantineFiles: 0,
    autoCommitted,
    quarantined: 0,
    autoEnabled,
    lastAutoRefreshAt,
    auditIssues: lastAuditReport?.issues.length || 0,
    batches: batches.length,
    rollbackableBatches: batches.filter((batch) => batch.committed > batch.rolledBack).length,
    sourceStates,
    trustedSourceCandidates: candidates.filter((candidate) => candidate.sourceTrust === 'trusted').length,
    riskySourceCandidates: candidates.filter((candidate) => candidate.sourceTrust === 'risky').length,
    unknownSourceCandidates: candidates.filter((candidate) => candidate.sourceTrust === 'unknown').length,
    dbMode: dbStats.mode,
    dbSections: dbStats.sections,
    dbQueries: dbStats.queries,
    dbHits: dbStats.hits,
    dbMisses: dbStats.misses,
    dbLastError: dbStats.lastError,
  };
}

export function getKnowledgeKeywords(): string[] {
  return BASE_KEYWORDS;
}

export function isKnowledgeTopic(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeText(text);
  return BASE_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function searchKnowledge(query: string, maxResults: number = 4, maxExcerptChars: number = 220): KnowledgeSearchResult[] {
  loadKnowledge();
  if (!query || cachedSections.length === 0) {
    searchMisses++;
    return [];
  }

  const dbResults = searchKnowledgeDb(query, Math.max(maxResults, 8));
  const scored = dbResults.length > 0
    ? dbResults.slice(0, maxResults).map((section) => ({
      title: section.title,
      excerpt: excerpt(section.content, maxExcerptChars),
      score: section.dbScore,
    }))
    : cachedSections
      .map((section) => ({ section, score: scoreSection(section, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ section, score }) => ({
        title: section.title,
        excerpt: excerpt(section.content, maxExcerptChars),
        score,
      }));

  if (scored.length > 0) searchHits++;
  else searchMisses++;
  return scored;
}

export function selectKnowledge(text: string, maxChars: number = 1800): string {
  loadKnowledge();
  if (!text || cachedSections.length === 0) {
    selectMisses++;
    return '';
  }

  const scored = searchKnowledgeDb(text, 8)
    .map((section) => ({
      section: {
        title: section.title,
        content: section.content,
        keywords: section.keywords,
      },
      score: section.dbScore,
    }));

  if (scored.length === 0) {
    scored.push(...cachedSections
      .map((section) => ({ section, score: scoreSection(section, text) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score));
  }

  if (scored.length === 0 && isKnowledgeTopic(text)) {
    scored.push(...cachedSections.slice(0, 3).map((section) => ({ section, score: 1 })));
  }

  if (scored.length === 0) {
    selectMisses++;
    return '';
  }

  const selected: string[] = [];
  let used = 0;
  for (const { section } of scored.slice(0, 5)) {
    const block = `【${section.title}】\n${section.content}`;
    if (used + block.length > maxChars && selected.length > 0) continue;
    selected.push(block);
    used += block.length;
    if (used >= maxChars) break;
  }

  selectHits++;
  return selected.join('\n\n').slice(0, maxChars);
}

export function selectStyleKnowledge(maxChars: number = 1200): string {
  const query = '知识库强制注入 回复铁律 直播语态 真人化 非公式化 去口癖 低攻击 活人感 语录纠错 口癖调度 反应强度 知识命中优先级';
  const selected = selectKnowledge(query, maxChars);
  if (selected) return selected;

  loadKnowledge();
  const fallback = cachedSections
    .filter((section) => /回复铁律|直播语态|真人化|非公式化|去口癖|低攻击|活人感|语录纠错|口癖|反应强度|拟态执行|知识命中优先级/.test(section.title))
    .slice(0, 4)
    .map((section) => `【${section.title}】\n${section.content}`)
    .join('\n\n')
    .slice(0, maxChars);
  if (fallback) selectHits++;
  else selectMisses++;
  return fallback;
}

export function extractKnowledgeTitles(markdown: string, limit: number = 6): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/^【(.+?)】/gm)) {
    const title = match[1].trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
    if (titles.length >= limit) break;
  }
  return titles;
}

interface QuoteKnowledgeLine {
  title: string;
  line: string;
}

function isQuoteKnowledgeLine(line: string): boolean {
  if (line.length < 2 || line.length > 64) return false;
  if (line.startsWith('#') && !line.startsWith('#查询')) return false;
  if (/^(知识来源类型|置信度|核验状态|内容类型|自动写入资格|证据链接|来源|来源类型|使用规则)[：:]/.test(line)) return false;
  return !/模板|核验|候选|规则|命令|配置|README|bot|机器人|不是本人|不代表|不能声称|以下|优先级|适合|来源|边界|摘要|未提供|不主动|不等于|当作|使用/.test(line);
}

function collectQuoteKnowledgeLines(query: string = ''): {
  all: QuoteKnowledgeLine[];
  matched: QuoteKnowledgeLine[];
  sectionTitles: string[];
} {
  loadKnowledge();
  const sections = cachedSections.filter((section) => /直播口癖|经典短句|已核验短语锚点|短语锚点|戳一戳短句池/.test(section.title));
  const all = sections.flatMap((section) => section.content
    .split(/\r?\n/)
    .filter((line) => /^[-*]\s+/.test(line.trim()))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(isQuoteKnowledgeLine)
    .map((line) => ({ title: section.title, line })));
  const normalizedQuery = normalizeText(query);
  const matched = normalizedQuery
    ? all.filter((item) => normalizeText(item.line).includes(normalizedQuery) || normalizeText(item.title).includes(normalizedQuery))
    : all;
  return {
    all,
    matched,
    sectionTitles: sections.map((section) => section.title),
  };
}

export function inspectQuoteKnowledge(query: string = ''): {
  query: string;
  totalLines: number;
  matchedLines: number;
  sectionCount: number;
  sections: string[];
  sampleLines: string[];
  fallbackUsed: boolean;
  boundary: string;
  advice: string[];
} {
  const clean = query.trim();
  const collected = collectQuoteKnowledgeLines(clean);
  const pool = collected.matched.length > 0 ? collected.matched : collected.all;
  const advice: string[] = [];
  if (clean && collected.matched.length === 0) {
    advice.push('关键词没命中，会退回全量短句池；换更短的场景词更容易命中。');
  }
  if (collected.all.length === 0) {
    advice.push('短句池为空，先把短句锚点补进 knowledge/wanjier.md，再跑 /kb audit。');
  } else if (collected.matched.length > 0) {
    advice.push('可直接 /quote 取一句；如果想扩充同场景，优先写短句锚点而不是长转写。');
  }
  advice.push('/kb route <消息> 可以看真实回复会注入哪些语态分区。');
  return {
    query: clean,
    totalLines: collected.all.length,
    matchedLines: collected.matched.length,
    sectionCount: collected.sectionTitles.length,
    sections: collected.sectionTitles.slice(0, 6),
    sampleLines: pool.slice(0, 5).map((item) => `${item.line} [${item.title}]`),
    fallbackUsed: clean.length > 0 && collected.matched.length === 0 && collected.all.length > 0,
    boundary: '这些是短句/口癖锚点和场景语气参考；除非素材明确标成已核验短句，否则不能说成玩机器本人逐字原话。',
    advice: [...new Set(advice)].slice(0, 4),
  };
}

export function getRandomKnowledgeLine(kind: 'quote' | 'gift' | 'player' | 'team' | 'style' | 'scene', query: string = ''): string {
  if (kind === 'quote') {
    const collected = collectQuoteKnowledgeLines(query);
    const pool = collected.matched.length > 0 ? collected.matched : collected.all;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)].line : '';
  }

  const sectionMap: Record<typeof kind, RegExp> = {
    gift: /礼物感谢拟态模板|礼物感谢话术/,
    player: /选手|人物/,
    team: /队伍/,
    style: /低攻击|活人感|非公式化|去口癖|反应|直播/,
    scene: /直播场景模板|切片长句摘要|CS2 解说模板|礼物感谢话术|反应强度/,
  };
  loadKnowledge();
  const sections = cachedSections.filter((section) => sectionMap[kind].test(section.title));
  const lines = sections
    .flatMap((section) => section.content.split(/\r?\n/))
    .filter((line) => /^[-*]\s+/.test(line.trim()))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => {
      if (line.length < 2) return false;
      if (line.startsWith('#') && !line.startsWith('#查询')) return false;
      if (/^(知识来源类型|置信度|核验状态|内容类型|自动写入资格|证据链接|来源|来源类型|使用规则)[：:]/.test(line)) return false;
      if (kind === 'style') {
        if (line.length > 90) return false;
        if (/不是哥们/.test(line)) return false;
      }
      if (kind === 'scene') {
        if (line.length > 180) return false;
        if (/^(知识来源类型|置信度|核验状态|内容类型|自动写入资格|证据链接|来源|使用规则)[：:]/.test(line)) return false;
      }
      if (kind === 'gift' && /不是哥们/.test(line)) return false;
      return true;
    });
  const filtered = query
    ? lines.filter((line) => normalizeText(line).includes(normalizeText(query)))
    : lines;
  const pool = filtered.length > 0 ? filtered : lines;
  if (pool.length === 0) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

export function previewKnowledgeCandidate(
  query: string,
  searchText: string,
  source: string,
  meta: Partial<Omit<KnowledgeCandidate, 'id' | 'title' | 'query' | 'source' | 'markdown' | 'createdAt'>> = {},
): KnowledgeCandidate {
  const sourceType = meta.sourceType || 'public_summary';
  const risk = meta.risk || detectRisk(searchText, sourceType);
  const cleaned = searchText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 4)
    .slice(0, 8);
  const title = `联网候选: ${query}`;
  const body = [
    `## ${safeTitle(title)}`,
    '',
    `- 关键词：${query}`,
    `- 来源：${source}`,
    `- 来源类型：${sourceType}`,
    `- 置信度：${meta.confidence || (sourceType === 'public_fact' ? 'high' : 'medium')}`,
    '- 写库规则：只保留事实索引、短摘录和摘要；不要把搜索结果当作本人原话。',
    ...cleaned.map((line) => `- ${line.slice(0, 180)}`),
    '- 使用规则：作为事实/切片线索参考，回复时保持短句，不原样大段复述。',
  ].join('\n');
  return createCandidate(title, query, source, body, {
    sourceType,
    confidence: meta.confidence || (sourceType === 'public_fact' ? 'high' : 'medium'),
    evidenceUrls: meta.evidenceUrls || extractUrls(searchText + '\n' + source),
    autoCommitEligible: meta.autoCommitEligible === true,
    risk,
    status: meta.status,
  });
}

export async function importKnowledgeUrlCandidate(
  url: string,
  timeoutMs: number = 5000,
): Promise<KnowledgeCandidate> {
  const normalizedUrl = normalizeImportUrl(url);
  const fetched = await requestImportUrl(normalizedUrl, timeoutMs);
  if (!fetched.ok) {
    throw new Error(fetched.error || `URL 抓取失败${fetched.statusCode ? ` HTTP ${fetched.statusCode}` : ''}`);
  }

  const contentType = fetched.contentType.toLowerCase();
  if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml/.test(contentType)) {
    throw new Error(`不支持的内容类型: ${contentType.slice(0, 80)}`);
  }

  const summary = summarizeImportedHtml(fetched.body);
  const finalUrl = normalizeImportUrl(fetched.finalUrl || normalizedUrl);
  const sourceType: KnowledgeCandidate['sourceType'] = /hltv|liquipedia|counter-strike|valve|csapi|wikipedia|moegirl|douyu/i.test(finalUrl + ' ' + summary.title)
    ? 'public_fact'
    : 'public_summary';
  const confidence: KnowledgeCandidate['confidence'] = sourceType === 'public_fact' ? 'high' : 'medium';
  const description = summary.description || '';
  const snippets = summary.snippets.slice(0, description ? 1 : 2);
  const lines = [
    `## URL导入候选: ${summary.title}`,
    '',
    `- 关键词：${summary.title}`,
    `- 来源：${finalUrl}`,
    `- 来源类型：${sourceType}`,
    `- 置信度：${confidence}`,
    summary.site ? `- 站点：${summary.site}` : '',
    `- 页面标题：${summary.title}`,
    description ? `- 页面摘要：${description}` : '',
    ...snippets.map((snippet) => `- 正文短摘：${snippet}`),
    `- 抓取时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    '- 写库规则：只保留标题、来源、短摘要；不得把网页内容当作主播逐字原话。',
    '- 使用规则：作为公开线索/事实入口参考，回复时需要说短句，涉及实时排名/阵容仍优先查实时源。',
  ].filter(Boolean);

  return createCandidate(`URL导入: ${summary.title}`, summary.title, finalUrl, lines.join('\n'), {
    sourceType,
    confidence,
    evidenceUrls: [finalUrl],
    autoCommitEligible: false,
    risk: 'review',
  });
}

function listInboxMaterialFiles(limit: number = 20): string[] {
  ensureKnowledgeDirs();
  return fs.readdirSync(INBOX_DIR)
    .filter((file) => /\.(md|txt)$/i.test(file))
    .filter((file) => !/^readme\.md$/i.test(file))
    .sort((a, b) => {
      try {
        return fs.statSync(path.join(INBOX_DIR, b)).mtimeMs - fs.statSync(path.join(INBOX_DIR, a)).mtimeMs;
      } catch {
        return a.localeCompare(b);
      }
    })
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

function countTextLines(text: string): number {
  return text.trim() ? text.trim().split(/\r?\n/).length : 0;
}

function inferInboxMaterialType(text: string): KnowledgeInboxInspectRow['materialType'] {
  const clean = text.trim();
  if (!clean) return 'empty';
  if (hasLongVerbatimTranscriptRisk(clean)) return 'long_transcript';
  const signals = [
    /礼物|送礼|感谢|老板大气|飞机|火箭|礼花|gift/i.test(clean) ? 'gift_template' : '',
    /排名|阵容|转会|赛果|赛程|比分|版本|地图池|HLTV|VRS|Rating|ADR|KAST/i.test(clean) ? 'cs_fact' : '',
    /场景|可用话术|口癖|风格|白给|保枪|开香槟|残局|道具|直播|弹幕|短句/i.test(clean) ? 'style_template' : '',
  ].filter(Boolean);
  const uniqueSignals = [...new Set(signals)];
  if (uniqueSignals.length >= 2) return 'mixed';
  return (uniqueSignals[0] as KnowledgeInboxInspectRow['materialType']) || 'summary';
}

function inspectInboxFile(file: string): KnowledgeInboxInspectRow {
  const filepath = path.join(INBOX_DIR, file);
  const stat = fs.statSync(filepath);
  const raw = fs.readFileSync(filepath, 'utf-8');
  const text = raw.trim();
  const evidenceUrls = extractUrls(text);
  const sourceQuality = classifySourceTrust(`knowledge/inbox/${file}`, evidenceUrls);
  const materialType = inferInboxMaterialType(text);
  const issues: string[] = [];
  const advice: string[] = [];
  const unsupportedOriginalQuoteLine = text
    .split(/\r?\n/)
    .some((line) => hasUnsupportedOriginalQuoteClaimInKnowledge(line));
  const freshnessTriggers = FRESHNESS_FACT_PATTERNS
    .filter((item) => item.pattern.test(text))
    .map((item) => item.label);

  if (!text) {
    issues.push('空文件');
    advice.push('删除空文件，或补成“来源/场景/摘要/可用话术/禁用边界”。');
  }
  if (stat.size > 64 * 1024 || text.length > 20_000) {
    issues.push('素材过长');
    advice.push('先拆成多个文件，每个文件只放一个场景或一个主题。');
  }
  if (materialType === 'long_transcript') {
    issues.push('疑似长转写/多轮对话');
    advice.push('先摘要成“场景 -> 反应 -> 判断 -> 可用短句”，不要整段写库。');
  }
  if (unsupportedOriginalQuoteLine) {
    issues.push('未核验原话/逐字说法');
    advice.push('把“本人原话/逐字复刻”改成“场景口吻/短句锚点”，除非只保留极短可核验引用。');
  }
  if (freshnessTriggers.length > 0 && evidenceUrls.length === 0) {
    issues.push(`时效事实缺来源: ${freshnessTriggers.slice(0, 3).join('/')}`);
    advice.push('补 HLTV/Liquipedia/Valve/CS API 等公开链接；回复最新事实仍走 /cs verify 和 fresh 证据。');
  }
  if (sourceQuality.sourceTrust === 'risky') {
    issues.push('本地/内网风险来源');
    advice.push('本地或内网页面不能当公开证据；只可作为人工授权素材摘要。');
  } else if (sourceQuality.sourceTrust === 'unknown' && evidenceUrls.length > 0) {
    issues.push('未知公开来源');
    advice.push('先用 /kb trust <链接> 看来源评级，未知域名默认人工复核。');
  }
  if (
    materialType !== 'empty'
    && materialType !== 'cs_fact'
    && text.length > 500
    && !/场景|摘要|可用话术|禁用|来源|边界|使用规则/.test(text)
  ) {
    issues.push('缺少场景化结构');
    advice.push('补“场景/摘要/可用话术/禁用边界”，让回复学反应结构而不是复读素材。');
  }
  if (materialType === 'gift_template') {
    advice.push('礼物素材写成拟态模板，不要标成真实礼物原话。');
  }
  if (materialType === 'style_template' || materialType === 'mixed') {
    advice.push('适合 /kb ingest 生成候选；commit 前用 /kb show 看质量闸。');
  }
  if (advice.length === 0) {
    advice.push('结构基本可读；可先 /kb ingest 生成候选，再 /kb show 复核。');
  }

  const needsSource = issues.some((issue) => /缺来源|风险来源|未核验|长转写|素材过长/.test(issue));
  const review = issues.length > 0 || materialType === 'summary' || materialType === 'mixed';
  const risk: KnowledgeInboxInspectRow['risk'] = materialType === 'empty' || needsSource
    ? 'needs_source'
    : review
      ? 'review'
      : 'safe';
  const ingestMode: KnowledgeInboxInspectRow['ingestMode'] = materialType === 'empty'
    ? 'drop'
    : issues.some((issue) => /长转写|素材过长|未核验原话|缺少场景化结构/.test(issue))
      ? 'split-first'
      : text.length > 2500
        ? 'full'
        : 'summary';

  return {
    file,
    bytes: stat.size,
    chars: text.length,
    lines: countTextLines(text),
    materialType,
    sourceTrust: sourceQuality.sourceTrust,
    sourceHosts: sourceQuality.sourceHosts,
    evidenceUrls,
    risk,
    issues: [...new Set(issues)],
    advice: [...new Set(advice)].slice(0, 4),
    ingestMode,
  };
}

export function inspectKnowledgeInbox(limit: number = 10): KnowledgeInboxInspectReport {
  const files = listInboxMaterialFiles(Math.max(1, Math.min(limit, 50)));
  const rows = files.map(inspectInboxFile);
  return {
    generatedAt: Date.now(),
    totalFiles: listInboxMaterialFiles(50).length,
    scannedFiles: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    withEvidence: rows.filter((row) => row.evidenceUrls.length > 0).length,
    needsSource: rows.filter((row) => row.risk === 'needs_source').length,
    longTranscript: rows.filter((row) => row.materialType === 'long_transcript').length,
    rows,
  };
}

export function previewInboxCandidates(mode: 'summary' | 'full' = 'summary'): KnowledgeCandidate[] {
  const files = listInboxMaterialFiles(10);
  const candidates: KnowledgeCandidate[] = [];
  for (const file of files) {
    const filepath = path.join(INBOX_DIR, file);
    const raw = fs.readFileSync(filepath, 'utf-8').trim();
    if (!raw) continue;
    const title = `本地素材: ${path.basename(file, path.extname(file))}`;
    const maxLines = mode === 'full' ? 180 : 40;
    const maxChars = mode === 'full' ? 420 : 180;
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
    const markdown = [
      `## ${safeTitle(title)}`,
      '',
      `- 来源：knowledge/inbox/${file}`,
      `- 来源类型：用户本地提供${mode === 'full' ? '长素材' : '摘要素材'}`,
      `- 置信度：待管理员核验；可作为直播转写/切片笔记使用`,
      '- 写库规则：确认来源合法且内容准确后再 commit；长转写建议整理成场景、口癖、选手评价三类。',
      ...lines.map((line) => `- ${line.slice(0, maxChars)}`),
    ].join('\n');
    candidates.push(createCandidate(title, file, `knowledge/inbox/${file}`, markdown, {
      sourceType: 'local_transcript',
      confidence: 'medium',
      autoCommitEligible: false,
      risk: mode === 'full' ? 'needs_source' : 'review',
      evidenceUrls: extractUrls(raw),
    }));
  }
  return candidates;
}

export function listKnowledgeCandidates(): KnowledgeCandidate[] {
  return [...pendingCandidates.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getKnowledgeCandidate(id: string): KnowledgeCandidate | null {
  return pendingCandidates.get(id) || null;
}

export function dropKnowledgeCandidate(id: string): KnowledgeCandidate | null {
  const candidate = pendingCandidates.get(id);
  if (!candidate) return null;
  candidate.status = 'dropped';
  pendingCandidates.delete(id);
  return candidate;
}

export function commitKnowledgeCandidate(id: string): KnowledgeCandidate | null {
  ensureKnowledgeDirs();
  const candidate = pendingCandidates.get(id);
  if (!candidate) return null;
  const suffix = `\n\n${candidateToMarkdown(candidate)}\n`;
  fs.appendFileSync(DEFAULT_KNOWLEDGE_FILE, suffix, 'utf-8');
  candidate.status = 'committed';
  pendingCandidates.delete(id);
  cachedMtime = 0;
  loadKnowledge();
  return candidate;
}

export function autoCommitKnowledgeCandidate(
  candidate: KnowledgeCandidate,
  options: { batchId?: string; maxBlockChars?: number } = {},
): 'committed' | 'pending' {
  ensureKnowledgeDirs();
  const batchId = options.batchId || `manual_${Date.now().toString(36)}`;
  const hash = hashCandidate(candidate);
  const quality = refreshKnowledgeCandidateQuality(candidate);
  if (!quality.ok) return 'pending';
  loadKnowledge();
  if (hasCommittedHash(hash)) {
    pendingCandidates.delete(candidate.id);
    candidate.status = 'dropped';
    return 'pending';
  }
  const suffix = `\n\n${candidateBlock(candidate, batchId, hash, options.maxBlockChars || 1200)}\n`;
  fs.appendFileSync(DEFAULT_KNOWLEDGE_FILE, suffix, 'utf-8');
  candidate.status = 'committed';
  pendingCandidates.delete(candidate.id);
  cachedMtime = 0;
  autoCommitted++;
  appendAutoLog({
    batchId,
    candidateId: candidate.id,
    title: candidate.title,
    query: candidate.query,
    source: candidate.source,
    hash,
    evidenceUrls: candidate.evidenceUrls,
    createdAt: Date.now(),
    status: 'committed',
    chars: suffix.length,
  });
  loadKnowledge();
  return 'committed';
}

export function rollbackKnowledgeBatch(batchId: string): { removedBlocks: number; updatedEntries: number } {
  ensureKnowledgeDirs();
  if (!batchId) return { removedBlocks: 0, updatedEntries: 0 };
  loadKnowledge();
  const pattern = new RegExp(
    `\\n?<!-- kb:auto batch=${escapeRegExp(batchId)} hash=[^\\n]+ begin -->[\\s\\S]*?<!-- kb:auto batch=${escapeRegExp(batchId)} hash=[^\\n]+ end -->\\n?`,
    'g',
  );
  let removedBlocks = 0;
  const nextText = cachedFullText.replace(pattern, () => {
    removedBlocks++;
    return '\n';
  }).replace(/\n{4,}/g, '\n\n\n');
  if (removedBlocks > 0) {
    fs.writeFileSync(DEFAULT_KNOWLEDGE_FILE, nextText.trimEnd() + '\n', 'utf-8');
    cachedMtime = 0;
    loadKnowledge();
  }

  const entries = readAutoLog();
  let updatedEntries = 0;
  const updated = entries.map((entry) => {
    if (entry.batchId === batchId && entry.status === 'committed') {
      updatedEntries++;
      return { ...entry, status: 'rolled_back' as const, createdAt: Date.now() };
    }
    return entry;
  });
  if (updatedEntries > 0) {
    fs.writeFileSync(AUTO_LOG_FILE, updated.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
  }
  return { removedBlocks, updatedEntries };
}

export function quarantineKnowledgeCandidate(id: string, reason: string = '管理员手动标为待核验'): KnowledgeCandidate | null {
  const candidate = pendingCandidates.get(id);
  if (!candidate) return null;
  candidate.risk = 'needs_source';
  candidate.autoCommitEligible = false;
  candidate.markdown = [
    candidate.markdown,
    '',
    `- 待核验原因：${reason}`,
  ].join('\n');
  return commitKnowledgeCandidate(id);
}

export function setKnowledgeAutoEnabled(enabled: boolean): void {
  autoEnabled = enabled;
}

export function isKnowledgeAutoEnabled(): boolean {
  return autoEnabled;
}

export function markKnowledgeAutoRefresh(): void {
  lastAutoRefreshAt = Date.now();
}

export function auditKnowledge(): KnowledgeAuditReport {
  loadKnowledge();
  ensureKnowledgeDirs();
  const issues: KnowledgeAuditIssue[] = [];
  const titles = new Map<string, number>();
  for (const section of cachedSections) {
    titles.set(section.title, (titles.get(section.title) || 0) + 1);
    if (/原话|经典语录|礼物/.test(section.title) && !/来源|证据|拟态|候选|规则/.test(section.content)) {
      issues.push({
        level: 'hard',
        title: `需核验分区缺少来源: ${section.title}`,
        detail: '原话、经典语录、礼物相关内容必须标注来源或明确为拟态模板。',
      });
    }
    const isRuntimeRuleSection = /回复|策略|铁律|规则|反应|模板/.test(section.title);
    if (
      !isRuntimeRuleSection &&
      /2025|2026|排名|阵容|转会|最新/.test(section.content) &&
      !/截至|实时|联网|HLTV|Liquipedia|来源/.test(section.content)
    ) {
      issues.push({
        level: 'risk',
        title: `实时内容缺少时效提示: ${section.title}`,
        detail: '涉及排名、阵容、转会、最新信息时需要注明截至日期或要求联网确认。',
      });
    }
    if (section.content.length < 40) {
      issues.push({
        level: 'info',
        title: `分块过短: ${section.title}`,
        detail: '过短分块检索价值有限，可合并到相邻主题。',
      });
    }
    const quoteIssue = originalQuoteAuditIssueForSection(section);
    if (quoteIssue) issues.push(quoteIssue);
    const transcriptIssue = longTranscriptAuditIssueForSection(section);
    if (transcriptIssue) issues.push(transcriptIssue);
    issues.push(...sourceAuditIssuesForSection(section));
  }
  for (const [title, count] of titles) {
    if (count > 1) {
      issues.push({
        level: 'risk',
        title: `重复分区: ${title}`,
        detail: `出现 ${count} 次，可能导致检索噪声。`,
      });
    }
  }

  const report: KnowledgeAuditReport = {
    generatedAt: Date.now(),
    issues,
    sections: cachedSections.length,
    chars: cachedFullText.length,
    candidates: pendingCandidates.size,
    quarantineFiles: 0,
  };
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  lastAuditReport = report;
  return report;
}

export function getLastKnowledgeAudit(): KnowledgeAuditReport | null {
  if (lastAuditReport) return lastAuditReport;
  try {
    if (!fs.existsSync(AUDIT_FILE)) return null;
    lastAuditReport = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8')) as KnowledgeAuditReport;
    return lastAuditReport;
  } catch {
    return null;
  }
}
