import * as fs from 'fs';
import * as path from 'path';

export interface RuntimeStorageTarget {
  key: string;
  label: string;
  rel: string;
  purpose: string;
}

export interface RuntimeStorageProbe extends RuntimeStorageTarget {
  ok: boolean;
  error: string;
}

export interface RuntimeStoreFileTarget {
  key: string;
  label: string;
  rel: string;
  note: string;
}

export interface RuntimeStoreFileSnapshot extends RuntimeStoreFileTarget {
  exists: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
  error: string;
}

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const RUNTIME_STORAGE_TARGETS: RuntimeStorageTarget[] = [
  { key: 'data', label: '运行数据', rel: 'data', purpose: 'CS实时、竞猜、日报、订阅、训练、画像 JSON' },
  { key: 'logs', label: '日志', rel: 'logs', purpose: '运行日志和排障输出' },
  { key: 'context', label: '上下文', rel: 'context_store', purpose: '群/私聊上下文持久化' },
  { key: 'rag', label: 'RAG索引', rel: 'context_store/embeddings', purpose: '轻量记忆索引写盘' },
  { key: 'search', label: '搜索缓存', rel: 'search_cache', purpose: '联网搜索正/负缓存' },
  { key: 'image', label: '图片缓存', rel: 'image_cache', purpose: '识图和每日CS真实图缓存' },
  { key: 'voice', label: '语音缓存', rel: 'voice_cache', purpose: 'TTS API/克隆语音缓存' },
  { key: 'local-tts', label: '本地TTS输出', rel: 'voice_cache/local', purpose: '本地授权TTS命令输出' },
  { key: 'stt', label: '听写缓存', rel: 'stt_cache', purpose: 'STT下载/转写结果缓存' },
  { key: 'knowledge', label: '知识库', rel: 'knowledge', purpose: '主库、来源、审计和候选' },
  { key: 'inbox', label: '素材收件箱', rel: 'knowledge/inbox', purpose: '授权切片/礼物/场景素材导入前暂存' },
];

export const RUNTIME_STORE_FILES: RuntimeStoreFileTarget[] = [
  { key: 'cs-realtime', label: 'CS实时缓存', rel: 'data/cs-realtime-cache.json', note: 'HLTV/CS API/Liquipedia fresh/stale 快照；缺失只代表尚未预热或被清理' },
  { key: 'cs-predict', label: 'CS竞猜', rel: 'data/cs-predict.json', note: '盘口、预测、积分、赛季和候选提醒' },
  { key: 'cs-report', label: 'CS日报订阅', rel: 'data/cs-report.json', note: '群/私聊每日 CS 日报订阅' },
  { key: 'cs-watch', label: 'CS关注订阅', rel: 'data/cs-watch.json', note: '队伍/选手/赛程变化提醒订阅' },
  { key: 'cs-training', label: '每日训练日志', rel: 'data/cs-training.json', note: 'cstrain 训练日志和短板分布' },
  { key: 'user-profiles', label: '用户画像', rel: 'data/user-profiles.json', note: '当前会话内用户自填偏好画像' },
  { key: 'knowledge-main', label: '风格知识主库', rel: 'knowledge/wanjier.md', note: '风格、短句、场景和事实摘要主库' },
  { key: 'knowledge-sources', label: '知识来源', rel: 'knowledge/sources.json', note: '公开来源刷新配置' },
  { key: 'knowledge-state', label: '来源刷新状态', rel: 'knowledge/source-state.json', note: '来源 fresh/due/never 状态；缺失时会按未刷新处理' },
];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveProjectPath(rel: string): string {
  return path.join(PROJECT_ROOT, rel);
}

export function probeWritableDir(target: RuntimeStorageTarget): RuntimeStorageProbe {
  const dir = resolveProjectPath(target.rel);
  const probe = path.join(dir, `.storage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf-8');
    fs.unlinkSync(probe);
    return { ...target, ok: true, error: '' };
  } catch (err) {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {
      // Best-effort cleanup only; the original write/access failure is the useful signal.
    }
    return { ...target, ok: false, error: errorText(err) };
  }
}

export function inspectRuntimeStorage(): { probes: RuntimeStorageProbe[]; failed: RuntimeStorageProbe[]; summary: string } {
  const probes = RUNTIME_STORAGE_TARGETS.map(probeWritableDir);
  const failed = probes.filter((item) => !item.ok);
  const okCount = probes.length - failed.length;
  const keySummary = probes.map((item) => `${item.key}=${item.ok ? 'ok' : 'fail'}`).join(' ');
  const summary = failed.length > 0
    ? `写盘: FAIL ${okCount}/${probes.length} ${keySummary}`
    : `写盘: OK ${okCount}/${probes.length} ${keySummary}`;
  return { probes, failed, summary };
}

export function inspectRuntimeStoreFiles(): RuntimeStoreFileSnapshot[] {
  return RUNTIME_STORE_FILES.map((target) => {
    try {
      const stat = fs.statSync(resolveProjectPath(target.rel));
      return {
        ...target,
        exists: true,
        isDirectory: stat.isDirectory(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        error: '',
      };
    } catch (err) {
      const anyErr = err as NodeJS.ErrnoException;
      if (anyErr && anyErr.code === 'ENOENT') {
        return { ...target, exists: false, isDirectory: false, sizeBytes: 0, mtimeMs: 0, error: '' };
      }
      return { ...target, exists: false, isDirectory: false, sizeBytes: 0, mtimeMs: 0, error: errorText(err) };
    }
  });
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
