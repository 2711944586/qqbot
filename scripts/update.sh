#!/bin/bash
# VPS 安全更新脚本
# 用法:
#   bash scripts/update.sh
#   bash scripts/update.sh --hard
#   npm run update

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="safe"
RUN_SMOKE="${WANJIER_UPDATE_SMOKE:-0}"
for arg in "$@"; do
  case "$arg" in
    --hard|--force)
      MODE="hard"
      ;;
    --smoke)
      RUN_SMOKE="1"
      ;;
    --no-smoke)
      RUN_SMOKE="0"
      ;;
    -h|--help)
      echo "用法: bash scripts/update.sh [--hard] [--smoke|--no-smoke]"
      echo "  默认: 安全 ff-only 拉取，不覆盖本地改动"
      echo "  --hard: 备份配置后强制 reset 到 origin/main，用于 VPS 明确对齐远程"
      exit 0
      ;;
  esac
done

TS="$(date +%F-%H%M%S)"
BACKUP_DIR="$ROOT_DIR/backups/update-$TS"
mkdir -p "$BACKUP_DIR" logs

echo "========================================="
echo "  玩机器 Bot VPS 更新"
echo "========================================="
echo "模式: $MODE"
echo "目标分支: origin/main"
echo "当前目录: $ROOT_DIR"
echo "更新前提交: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

load_env_file() {
  if [ ! -f ".env" ]; then
    return 0
  fi
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  echo "  已加载 .env 环境变量"
}

assert_chat_api_ready() {
  node - <<'NODE'
const fs = require('fs');
const { hasUsableApiKey } = require('./dist/config');

let config = {};
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
} catch {}

const ai = config.ai || {};
const apiKey = process.env.WANJIER_API_KEY || process.env.OPENAI_API_KEY || ai.api_key || '';
const apiUrl = process.env.WANJIER_API_URL || ai.api_url || '';
const model = process.env.WANJIER_MODEL || ai.model || '';

const missing = [];
if (!apiUrl) missing.push('api_url / WANJIER_API_URL');
if (!model) missing.push('model / WANJIER_MODEL');
if (!hasUsableApiKey(apiKey)) missing.push('真实 API key / WANJIER_API_KEY');

if (missing.length > 0) {
  console.error('[update] 聊天链路未就绪，缺少: ' + missing.join(', '));
  console.error('[update] 修改 /opt/wanjier-bot/.env 或 config.json 后重新运行。');
  console.error('[update] 示例: echo "WANJIER_API_KEY=你的真实key" >> .env');
  process.exit(3);
}

console.log('[update] 聊天 API 配置看起来已就绪');
NODE
}

backup_file() {
  local file="$1"
  if [ -f "$file" ]; then
    cp "$file" "$BACKUP_DIR/$(basename "$file").bak"
  fi
}

echo "[1/8] 备份配置..."
backup_file "config.json"
backup_file ".env"
backup_file "voice_sample.mp3"
cp -f scripts/update.sh "$BACKUP_DIR/update.sh.bak" 2>/dev/null || true

echo "[2/8] 拉取代码前检查工作区..."
if ! git diff --quiet -- . ':(exclude)config.json' ':(exclude).env' ':(exclude)voice_sample.mp3'; then
  if [ "$MODE" = "hard" ]; then
    echo "  检测到本地改动，hard模式会强制对齐远程；配置文件已备份。"
    git status --short > "$BACKUP_DIR/git-status-before.txt" || true
  else
    echo "  检测到本地改动，已保留，不会 reset/clean。"
  fi
fi

echo "[3/8] 拉取远端更新..."
git fetch origin
REMOTE_HEAD="$(git rev-parse --short origin/main)"
LOCAL_HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "  本地HEAD: $LOCAL_HEAD"
echo "  远端HEAD: $REMOTE_HEAD"
if [ "$MODE" = "hard" ]; then
  BEFORE_HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  TARGET_HEAD="$REMOTE_HEAD"
  echo "  HEAD: $BEFORE_HEAD -> $TARGET_HEAD"
  git reset --hard origin/main
else
  git pull --ff-only origin main
fi
AFTER_HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "  更新后提交: $(git log --oneline -1)"

echo "[4/8] 校验运行配置..."
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    echo "  已从 config.example.json 生成 config.json"
  else
    echo "  缺少 config.json 且没有 config.example.json"
    exit 1
  fi
fi

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "  提示: 你可以用 .env 管理敏感配置"
fi
if [ -f scripts/sync-config.js ]; then
  node scripts/sync-config.js --apply
fi
load_env_file

echo "[5/8] 安装依赖..."
npm ci

echo "[6/8] 构建与自检..."
npm run build
assert_chat_api_ready
npm run doctor
if npm run | grep -q "data:test"; then
  npm run data:test
fi
if [ "$RUN_SMOKE" = "1" ]; then
  npm run smoke
else
  echo "  跳过 npm run smoke（如需完整本地模拟，运行 WANJIER_UPDATE_SMOKE=1 bash scripts/update.sh 或加 --smoke）"
fi

echo "[7/8] 准备运行目录..."
mkdir -p logs voice_cache image_cache context_store stt_cache search_cache knowledge/db

echo "[8/8] 重启服务..."
if pm2 list 2>/dev/null | grep -q "wanjier"; then
  pm2 restart wanjier --update-env
else
  if [ -f ecosystem.config.js ]; then
    pm2 start ecosystem.config.js
  else
    pm2 start dist/index.js --name wanjier --node-args="--max-old-space-size=900 --expose-gc" --max-memory-restart 1200M
  fi
fi
pm2 save 2>/dev/null || true

echo "========================================="
echo "  ✅ 更新完成"
echo "========================================="
echo "提交变化: $LOCAL_HEAD -> $AFTER_HEAD (远端 $REMOTE_HEAD)"
if [ "$AFTER_HEAD" != "$REMOTE_HEAD" ]; then
  echo "警告: 本地提交仍未等于 origin/main；检查分支、stash 或本地改动。"
fi
echo "备份目录: $BACKUP_DIR"
echo "查看日志:  pm2 logs wanjier --lines 80 --nostream"
echo "看状态:    pm2 status"
echo "看资源:    free -h && df -h"
