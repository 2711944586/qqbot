#!/bin/bash
# 玩机器 Bot 恢复脚本
# 用法: bash scripts/recover.sh

set -e

cd "$(dirname "$0")/.."

echo "========================================="
echo "  玩机器 Bot 恢复诊断脚本"
echo "========================================="
echo ""

# 1. 检查关键文件
echo "[1/8] 检查项目文件..."
for f in package.json tsconfig.json config.json src/index.ts; do
  if [ ! -f "$f" ]; then
    echo "  ❌ 缺失: $f"
    exit 1
  fi
done
echo "  ✅ 项目文件完整"

# 2. 检查 config.json 关键配置
echo ""
echo "[2/8] 检查config.json..."
if ! grep -q '"api_key": "tp-' config.json && ! grep -q '"api_key": "sk-' config.json; then
  echo "  ❌ config.json 里 api_key 没填或格式不对"
  echo "  请编辑 nano config.json"
  exit 1
fi
if grep -q '"model": "MiMo' config.json; then
  echo "  ⚠️  发现大写模型名，应改为小写"
  sed -i 's/"model": "MiMo-V2.5-Pro"/"model": "mimo-v2.5-pro"/g' config.json
  sed -i 's/"vision_model": "MiMo-V2.5-Pro"/"vision_model": "mimo-v2.5-pro"/g' config.json
  echo "  ✅ 已修正"
fi
echo "  ✅ config.json OK"

# 3. 拉最新代码
echo ""
echo "[3/8] 拉取最新代码..."
git fetch
git pull --no-rebase || true

# 4. 安装依赖
echo ""
echo "[4/8] 安装依赖..."
npm install --no-audit --no-fund --silent

# 5. 编译
echo ""
echo "[5/8] 编译TypeScript..."
npm run build

# 6. 检查 NapCat
echo ""
echo "[6/8] 检查NapCat..."
if ! command -v docker &> /dev/null; then
  echo "  ❌ Docker 未安装"
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^napcat$'; then
  echo "  ⚠️  NapCat 容器未运行，尝试启动..."
  docker start napcat 2>/dev/null || echo "  ❌ 启动失败，可能需要重新创建"
fi

# 检查 NapCat WebSocket
sleep 2
if docker logs --tail 30 napcat 2>&1 | grep -qi 'websocket\|3001'; then
  echo "  ✅ NapCat WebSocket 已配置"
else
  echo "  ⚠️  NapCat 日志里没看到 WebSocket，可能配置丢失"
fi

# 7. 检查端口
echo ""
echo "[7/8] 检查端口3001..."
if ss -tlnp 2>/dev/null | grep -q ':3001'; then
  echo "  ✅ 端口3001正在监听"
else
  echo "  ❌ 端口3001未监听，NapCat WebSocket 没开"
  echo ""
  echo "  请编辑 NapCat 配置:"
  echo "  ls /opt/napcat/config/ # 看你的QQ号文件"
  echo "  然后参考 README.md 的 WebSocket 配置"
fi

# 8. 重启 PM2
echo ""
echo "[8/8] 重启 Bot..."
pm2 delete wanjier 2>/dev/null || true
if [ -f ecosystem.config.js ]; then
  pm2 start ecosystem.config.js
else
  pm2 start dist/index.js --name wanjier --node-args="--max-old-space-size=400 --expose-gc" --max-memory-restart 500M
fi
pm2 save

echo ""
echo "========================================="
echo "  诊断完成"
echo "========================================="
echo ""
echo "查看实时日志:"
echo "  pm2 logs wanjier --lines 50"
echo ""
echo "查看运行状态:"
echo "  pm2 status"
echo "  free -h"
echo "  docker stats --no-stream"
echo ""
