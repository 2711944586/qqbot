import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
  autoCommitEligible: boolean;
  risk: 'safe' | 'review' | 'quarantine';
  status: 'pending' | 'committed' | 'quarantined' | 'dropped';
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
  status: 'committed' | 'quarantined' | 'rolled_back';
  chars: number;
}

const KNOWLEDGE_DIR = path.resolve(__dirname, '..', '..', 'knowledge');
const INBOX_DIR = path.join(KNOWLEDGE_DIR, 'inbox');
const QUARANTINE_DIR = path.join(KNOWLEDGE_DIR, 'quarantine');
const DEFAULT_KNOWLEDGE_FILE = path.join(KNOWLEDGE_DIR, 'wanjier.md');
const SOURCES_FILE = path.join(KNOWLEDGE_DIR, 'sources.json');
const AUDIT_FILE = path.join(KNOWLEDGE_DIR, 'audit.json');
const AUTO_LOG_FILE = path.join(KNOWLEDGE_DIR, 'auto-log.jsonl');
const SOURCE_STATE_FILE = path.join(KNOWLEDGE_DIR, 'source-state.json');
const MAX_CANDIDATES = 20;

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
let quarantined = 0;
let autoEnabled = true;
let lastAutoRefreshAt = 0;
let lastAuditReport: KnowledgeAuditReport | null = null;
const pendingCandidates: Map<string, KnowledgeCandidate> = new Map();

function ensureKnowledgeDirs(): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  if (!fs.existsSync(QUARANTINE_DIR)) fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
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
    quarantineDir: QUARANTINE_DIR,
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
    if (entry.status === 'quarantined') current.quarantined++;
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
  if (/礼物|感谢|原话|转写|逐字|完整|台词|切片/.test(text)) return 'quarantine';
  const longLine = text.split(/\r?\n/).some((line) => line.trim().length > 220);
  if (longLine) return 'quarantine';
  return 'safe';
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
  if (/语录|短句|经典|quote/i.test(text) && /语录|短句|口癖|长句/.test(section.title)) score += 10;
  if (/切片|名场面|直播|礼物/.test(text) && /切片|名场面|直播|礼物/.test(section.title)) score += 8;
  if (/身份|是谁|玩机器/.test(text) && /身份/.test(section.title)) score += 6;
  if (/player|选手|niko|monesy|zywoo|s1mple|donk|ropz/i.test(text) && /选手|人物/.test(section.title)) score += 8;
  if (/team|队伍|navi|g2|vitality|spirit|faze|mouz/i.test(text) && /队伍/.test(section.title)) score += 8;
  if (/cs2|csgo|major|比赛|赛事/i.test(text) && /CS2|赛事|解说/.test(section.title)) score += 6;
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
  const candidate: KnowledgeCandidate = {
    id,
    title: safeTitle(title),
    query,
    source,
    markdown: markdown.trim(),
    createdAt: Date.now(),
    sourceType,
    confidence: meta.confidence || (sourceType === 'public_fact' ? 'high' : 'medium'),
    evidenceUrls: meta.evidenceUrls || extractUrls(markdown + '\n' + source),
    autoCommitEligible: meta.autoCommitEligible === true && risk === 'safe',
    risk,
    status: meta.status || 'pending',
  };
  pendingCandidates.set(id, candidate);
  pruneCandidates();
  return candidate;
}

function candidateToMarkdown(candidate: KnowledgeCandidate): string {
  const evidence = candidate.evidenceUrls.length > 0
    ? candidate.evidenceUrls.map((url) => `- 证据链接：${url}`).join('\n')
    : '- 证据链接：暂无';
  return [
    candidate.markdown.trim(),
    '',
    `- 知识来源类型：${candidate.sourceType}`,
    `- 置信度：${candidate.confidence}`,
    `- 风险：${candidate.risk}`,
    `- 自动写入资格：${candidate.autoCommitEligible ? '是' : '否'}`,
    evidence,
  ].join('\n');
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

function quarantineCandidate(candidate: KnowledgeCandidate, reason: string): KnowledgeCandidate {
  ensureKnowledgeDirs();
  const filename = `${candidate.id}-${safeFilename(candidate.title)}.md`;
  const filepath = path.join(QUARANTINE_DIR, filename);
  const content = [
    `# ${candidate.title}`,
    '',
    `- 隔离原因：${reason}`,
    `- 来源：${candidate.source}`,
    `- 查询：${candidate.query}`,
    `- 创建时间：${new Date(candidate.createdAt).toISOString()}`,
    '',
    candidateToMarkdown(candidate),
  ].join('\n');
  fs.writeFileSync(filepath, content, 'utf-8');
  candidate.status = 'quarantined';
  pendingCandidates.delete(candidate.id);
  quarantined++;
  return candidate;
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
} {
  loadKnowledge();
  const quarantineFiles = fs.existsSync(QUARANTINE_DIR)
    ? fs.readdirSync(QUARANTINE_DIR).filter((file) => file.endsWith('.md')).length
    : 0;
  const batches = listKnowledgeBatches(100);
  const sourceStates = Object.keys(readSourceState()).length;
  return {
    sections: cachedSections.length,
    chars: cachedFullText.length,
    keywords: BASE_KEYWORDS.length,
    selectHits,
    selectMisses,
    searchHits,
    searchMisses,
    candidates: pendingCandidates.size,
    quarantineFiles,
    autoCommitted,
    quarantined,
    autoEnabled,
    lastAutoRefreshAt,
    auditIssues: lastAuditReport?.issues.length || 0,
    batches: batches.length,
    rollbackableBatches: batches.filter((batch) => batch.committed > batch.rolledBack).length,
    sourceStates,
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

  const scored = cachedSections
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

  const scored = cachedSections
    .map((section) => ({ section, score: scoreSection(section, text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

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

export function getRandomKnowledgeLine(kind: 'quote' | 'gift' | 'player' | 'team' | 'style', query: string = ''): string {
  const sectionMap: Record<typeof kind, RegExp> = {
    quote: /语录|短句|短语|锚点|口癖|长句/,
    gift: /礼物感谢拟态模板|礼物感谢话术/,
    player: /选手|人物/,
    team: /队伍/,
    style: /口癖|反应|直播/,
  };
  loadKnowledge();
  const sections = cachedSections.filter((section) => sectionMap[kind].test(section.title));
  const lines = sections
    .flatMap((section) => section.content.split(/\r?\n/))
    .filter((line) => /^[-*]\s+/.test(line.trim()))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line.length >= 2 && !line.startsWith('#'));
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

export function previewInboxCandidates(mode: 'summary' | 'full' = 'summary'): KnowledgeCandidate[] {
  ensureKnowledgeDirs();
  const files = fs.readdirSync(INBOX_DIR)
    .filter((file) => /\.(md|txt)$/i.test(file))
    .slice(0, 10);
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
      risk: mode === 'full' ? 'quarantine' : 'review',
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
  if (candidate.risk === 'quarantine') {
    return quarantineCandidate(candidate, '候选风险为 quarantine，禁止直接写入主库');
  }
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
): 'committed' | 'quarantined' | 'pending' {
  ensureKnowledgeDirs();
  const batchId = options.batchId || `manual_${Date.now().toString(36)}`;
  const hash = hashCandidate(candidate);
  if (candidate.risk === 'quarantine') {
    quarantineCandidate(candidate, '自动刷新识别为长语录/礼物/转写风险');
    appendAutoLog({
      batchId,
      candidateId: candidate.id,
      title: candidate.title,
      query: candidate.query,
      source: candidate.source,
      hash,
      evidenceUrls: candidate.evidenceUrls,
      createdAt: Date.now(),
      status: 'quarantined',
      chars: candidate.markdown.length,
    });
    return 'quarantined';
  }
  if (!candidate.autoCommitEligible) return 'pending';
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

export function quarantineKnowledgeCandidate(id: string, reason: string = '管理员手动隔离'): KnowledgeCandidate | null {
  const candidate = pendingCandidates.get(id);
  if (!candidate) return null;
  return quarantineCandidate(candidate, reason);
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

  const quarantineFiles = fs.existsSync(QUARANTINE_DIR)
    ? fs.readdirSync(QUARANTINE_DIR).filter((file) => file.endsWith('.md')).length
    : 0;
  const report: KnowledgeAuditReport = {
    generatedAt: Date.now(),
    issues,
    sections: cachedSections.length,
    chars: cachedFullText.length,
    candidates: pendingCandidates.size,
    quarantineFiles,
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
