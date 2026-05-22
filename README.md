# 玩机器风格 QQ 群聊 Bot

一个基于 OneBot v11 / NapCatQQ 的 QQ 群聊机器人。它参考 CS2 解说主播“玩机器 / 6657”的直播间语感，支持 @ 必回、引用定位、上下文记忆、联网搜索、识图、语音、Markdown 知识库、知识库自动刷新、队列背压，并按 2G 内存 / 1 核 / 70GB 存储长期运行重新调参。

重要边界：本项目是“风格参考 bot”，不是现实主播本人，不代表本人发言。知识库里的“拟态模板”不是核验原话；公开来源只写事实索引、短摘要和链接，长转写/礼物原话请走本地素材导入。

## 当前能力

- @/回复/命令强触发必回，优先引用原消息，引用失败回退 @ 用户。
- 每条 AI 回复绑定消息级快照：群号、用户、消息 ID、原文、图片、上下文、触发原因。
- 同群 FIFO 排队，跨群并发；2G1C 推荐全局 AI/搜索/识图/听写/TTS 闸门 `3/3/1/1/1`。
- 队列积压时自动降级：强触发超过 60 秒跳过 TTS，超过 120 秒跳过搜索/识图/听写，只保底文本回复。
- 普通消息分层触发：关键词/知识话题直接接话，其他消息按概率接话，纯数字、单个“6”、纯表情和低信息短句不会主动刷屏。
- 戳一戳会按配置概率回应；复读机保留群聊感，但不会抢 @/回复/关键词 AI 触发。
- Markdown 知识库：`knowledge/wanjier.md` 提供直播语态、口癖、CS2 解说、选手/队伍倾向、礼物拟态、拒绝边界。
- 知识库自动刷新：`/kb refresh`、`/kb refresh --aggressive`、`/kb batches`、`/kb rollback`。
- 联网搜索：DuckDuckGo Instant、DuckDuckGo HTML、Bing RSS 兜底，带 single-flight、正/负缓存和磁盘缓存。
- 上下文记忆：每群持久化到 `context_store/`，旧消息异步压缩，不阻塞回复。
- 图片识别缓存：图片下载后缓存到 `image_cache/`，减少重复识图成本。
- STT 语音听写缓存：语音输入缓存到 `stt_cache/`，供应商支持音频输入时可把 QQ 语音转成当前消息文本。
- TTS 语音缓存：语音输出缓存到 `voice_cache/`，有授权样本时尝试声音克隆，支持 `/voice status` 自检。
- `/status` 和 `/diag` 提供队列、缓存、知识库、并发、内存和配置状态。

## 项目结构

```text
src/
  index.ts                 启动入口，注册插件和事件监听
  bot.ts                   WebSocket 连接、API 调用、心跳和重连
  handler.ts               群消息路由、命令解析、引用回复、@检测
  config.ts                config.json 解析、默认值和字段归一化
  types.ts                 OneBot 和配置类型
  plugins/
    ai-chat.ts             核心 AI、队列、上下文、知识注入、搜索、识图、STT、TTS
    knowledge-base.ts      Markdown 知识库、候选、隔离、自动写入、回滚、审计
    web-search.ts          联网搜索、single-flight、正/负缓存
    concurrency.ts         全局并发闸门
    context-store.ts       上下文持久化
    image-cache.ts         图片缓存
    stt.ts                 语音输入听写和缓存
    tts.ts                 语音生成和缓存
    diag.ts                严格自检
    status.ts              运行状态
    fun.ts                 roll/luck/jrrp/choose/rand
    admin.ts               reload/ban/unban/kick/title
    help.ts ping.ts stats.ts time.ts poke.ts recall.ts repeater.ts welcome.ts
knowledge/
  wanjier.md               主知识库
  sources.json             联网刷新来源配置
  inbox/                   本地转写/笔记导入目录
  quarantine/              自动隔离风险内容，运行产物，默认忽略
scripts/
  smoke.js                 构建后 smoke test
```

## 环境要求

- Node.js 20 或更高版本
- npm
- Docker
- PM2
- NapCatQQ，开启 OneBot v11 WebSocket 服务
- 一个可用的 OpenAI 兼容 Chat Completions API

推荐服务器：

- 推荐档：1 核 CPU / 2G 内存 / 70GB 存储。
- 70GB 存储足够保留上下文、搜索缓存、图片缓存、语音缓存、知识库自动日志和 NapCat 运行数据。
- 2G 内存仍然建议只跑 1 个 bot 进程，不开 PM2 cluster；AI/搜索/识图/TTS 通过内置闸门限流。
- 1G 内存也能降级运行，但需要降低知识注入、图片、语音和主动接话频率。

## 快速开始

```bash
git clone <你的仓库地址> qqbot
cd qqbot
npm install
cp config.example.json config.json
nano config.json
npm run build
npm run smoke
npm start
```

第一次启动前至少修改：

```json
{
  "ws_url": "ws://127.0.0.1:3001",
  "bot_qq": 0,
  "admin_qq": [123456789],
  "ai": {
    "api_url": "https://你的OpenAI兼容接口/v1/chat/completions",
    "api_key": "你的API密钥",
    "model": "你的文本模型",
    "vision_model": "你的识图模型"
  }
}
```

`bot_qq` 只用于展示和错号提醒，真正决定机器人 QQ 的是 NapCat 当前登录账号。配置完成后，群里先发：

```text
/whoami
/status
/diag
```

## 从零部署总流程

这是最稳的完整路线，适合一台新 VPS 从 0 到群里可用：

1. 准备服务器：Ubuntu 22.04/24.04，开放 TCP `3001` 给 bot 和 NapCat 本机通信，`6099` 用于 NapCat Web UI。
2. 安装 Node.js、npm、Docker、PM2。
3. 2G 内存机器建议开 2G swap；如果是 1G 降级机器，建议开 2G 到 4G swap。
4. 启动 NapCat 容器并扫码登录机器人 QQ。
5. 在 NapCat 里配置 OneBot v11 WebSocket，必须使用数组消息格式。
6. 克隆本项目，复制 `config.example.json` 为 `config.json`。
7. 填 API、管理员 QQ、机器人 QQ、模型名。
8. 可选：放入授权语音样本 `voice_sample.mp3`，开启克隆语音。
9. 运行 `npm run build` 和 `npm run smoke`。
10. 用 PM2 启动 bot。
11. 群里运行 `/whoami`、`/diag`、`/status`、`/voice status`。
12. 如果要强化玩机器风格，把合法素材放入 `knowledge/inbox/`，用 `/kb ingest` 走候选流程。

最重要的一句话：如果群里完全不回复，先不要改知识库，也不要怀疑人格提示词。先确认 NapCat 已经真正开启 OneBot WebSocket，且 bot 进程连的是同一个端口。

## Ubuntu 部署教程

### 1. 安装基础环境

```bash
apt update && apt upgrade -y
apt install -y curl wget git unzip nano
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2
curl -fsSL https://get.docker.com | bash
```

2G1C 机器建议开启 2G swap，避免 NapCat、Node 和系统更新同时占内存时被 OOM：

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

### 2. 启动 NapCatQQ

```bash
mkdir -p /opt/napcat/config
export BOT_QQ=你的机器人QQ号

docker run -d \
  --name napcat \
  --restart=always \
  --memory=600m \
  --memory-swap=900m \
  -e ACCOUNT=$BOT_QQ \
  -e NAPCAT_GID=0 \
  -e NAPCAT_UID=0 \
  -p 3001:3001 \
  -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  mlikiowa/napcat-docker:latest
```

注意：

- `export BOT_QQ=你的机器人QQ号` 里的中文必须换成真实 QQ，例如 `export BOT_QQ=3098064534`。
- `/opt/napcat/config/onebot11_${BOT_QQ}.json` 是配置文件路径，不是命令。不能直接执行这个 JSON 文件。
- 如果你看到 `Permission denied`，通常是因为你把 JSON 文件当命令敲了。正确做法是 `cat 文件` 查看，`nano 文件` 编辑。
- `-p 3001:3001` 必须存在，否则 bot 的 `ws://127.0.0.1:3001` 连不到 NapCat。
- 如果宿主机和 NapCat 不在同一个机器，`ws_url` 不能写 `127.0.0.1`，要写 NapCat 所在机器的 IP。

扫码登录：

```bash
docker logs napcat
```

或浏览器打开：

```text
http://你的服务器IP:6099
```

配置 OneBot v11 WebSocket：

```bash
cat > /opt/napcat/config/onebot11_${BOT_QQ}.json << 'EOF'
{
  "network": {
    "websocketServers": [{
      "name": "ws-server",
      "enable": true,
      "host": "0.0.0.0",
      "port": 3001,
      "enableForcePushEvent": true,
      "messagePostFormat": "array",
      "reportSelfMessage": false,
      "token": ""
    }]
  }
}
EOF

docker restart napcat
```

如果你已经有配置文件，不想覆盖其它 NapCat 字段，可以只修 `websocketServers`：

```bash
python3 - << 'PY'
import json
from pathlib import Path
import os

bot_qq = os.environ.get("BOT_QQ", "").strip()
if not bot_qq:
    raise SystemExit("先执行 export BOT_QQ=你的机器人QQ")

p = Path(f"/opt/napcat/config/onebot11_{bot_qq}.json")
data = json.loads(p.read_text())

network = data.setdefault("network", {})
network["websocketServers"] = [{
    "name": "ws-server",
    "enable": True,
    "host": "0.0.0.0",
    "port": 3001,
    "enableForcePushEvent": True,
    "messagePostFormat": "array",
    "reportSelfMessage": False,
    "token": ""
}]

p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
PY
```

Heredoc 的坑：

- 第一行必须是 `python3 - << 'PY'`，后面不要接 Python 代码。
- 最后一行必须只有 `PY`，前后不要有空格。
- 如果终端变成 `>`，说明还在等结束标记。按 `Ctrl+C` 取消，再重新复制整段。

检查 OneBot 配置：

```bash
cat /opt/napcat/config/onebot11_${BOT_QQ}.json
grep -A14 websocketServers /opt/napcat/config/onebot11_${BOT_QQ}.json
```

必须能看到：

```json
"websocketServers": [
  {
    "enable": true,
    "host": "0.0.0.0",
    "port": 3001,
    "messagePostFormat": "array"
  }
]
```

如果你看到：

```json
"websocketServers": []
```

那就是没开启 WebSocket，bot 一定不会回复。

确认容器和端口：

```bash
docker ps
docker logs --tail 120 napcat
ss -lntp | grep 3001 || true
```

`docker ps` 里应该有 `0.0.0.0:3001->3001/tcp`。如果没有，说明容器创建时没有映射端口，需要 `docker rm -f napcat` 后按上面的 `docker run` 重建。

### 3. 部署 bot

```bash
cd /opt
git clone https://github.com/2711944586/qqbot.git wanjier-bot
cd wanjier-bot
npm ci
cp config.example.json config.json
nano config.json
npm run build
npm run smoke
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

常用维护命令：

```bash
pm2 logs wanjier --lines 100
pm2 restart wanjier
docker restart napcat
```

如果 PM2 提示找不到 `wanjier`：

```bash
pm2 list
pm2 restart all
```

如果你第一次启动，推荐：

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
```

如果 `npm run build` 报错，先不要启动 PM2；修完构建再启动。PM2 只会运行 `dist/index.js`，没有 build 就没有新代码。

### 3.1 bot 配置最小可用版

编辑：

```bash
cd /opt/wanjier-bot
nano config.json
```

最少确认这些字段：

```json
{
  "ws_url": "ws://127.0.0.1:3001",
  "bot_qq": 3098064534,
  "admin_qq": [你的QQ],
  "enabled_groups": [],
  "ai": {
    "api_url": "https://你的接口/v1/chat/completions",
    "api_key": "真实API密钥",
    "model": "你的文本模型",
    "vision_model": "你的识图模型",
    "trigger_mode": "smart",
    "forced_reply_quote": true,
    "must_reply_quote": true
  }
}
```

排障时可以先关闭非必要功能，让链路先跑通：

```json
{
  "ai": {
    "enable_search": false,
    "enable_vision": false,
    "enable_stt": false,
    "enable_tts": false
  }
}
```

等 `/ping`、`/whoami`、`@bot` 都正常后，再开启搜索、识图、语音听写和语音输出。

### 4. 首次上线检查

在群里按顺序发送：

```text
/whoami
/diag
/status
/voice status
/kb stats
/quote
```

正常状态大致应该是：

- `/whoami` 的 `当前bot号` 等于 NapCat 登录号。
- `/diag` 没有 AI 接口、知识库、配置硬伤。
- `/status` 里队列没有长期堆积。
- `/voice status` 显示 `STT: on`、`TTS: on`；如果放了样本，克隆应为 `ready`。
- `/kb stats` 能看到知识库块数和字数。

如果 `/ping` 不回，不要继续测 AI。`/ping` 是本地命令，不需要 API，不需要知识库，不需要联网。`/ping` 不回只可能是消息没有进 bot、bot 没连上 NapCat、群白名单拦截、进程没启动或 QQ 没登录。

### 5. 部署后必跑的服务器自检

在 VPS 上执行：

```bash
cd /opt/wanjier-bot
git log -1 --oneline
npm run build
npm run smoke
pm2 list
pm2 logs wanjier --lines 120
docker ps
docker logs --tail 120 napcat
ss -lntp | grep 3001 || true
cat config.json | grep -E '"ws_url"|"bot_qq"|"api_url"|"model"'
BOT_QQ=$(node -e "console.log(require('./config.json').bot_qq || '')")
echo "BOT_QQ=$BOT_QQ"
ls -lah /opt/napcat/config
test -n "$BOT_QQ" && grep -A14 websocketServers /opt/napcat/config/onebot11_${BOT_QQ}.json
```

期望结果：

- `git log -1` 是远程最新提交。
- `npm run smoke` 输出 `smoke ok`。
- `pm2 list` 中 `wanjier` 是 `online`。
- NapCat 容器是 `Up`。
- `ss` 能看到 3001 正在监听。
- OneBot 配置里 `websocketServers` 不是空数组。
- `messagePostFormat` 是 `array`。

## 更换 Bot QQ 号

更换 QQ 号不是只改 `config.json`。实际登录账号由 NapCat 决定。

1. 停掉旧容器：

```bash
docker rm -f napcat
```

2. 设置新号并重建容器：

```bash
export BOT_QQ=新机器人QQ号
# 重新执行上面的 docker run
```

3. 扫码登录新号。
4. 重新写 `/opt/napcat/config/onebot11_${BOT_QQ}.json`。
5. 重启 NapCat：

```bash
docker restart napcat
```

6. 修改 bot 的 `config.json`：

```json
{
  "bot_qq": 新机器人QQ号,
  "admin_qq": [你的QQ]
}
```

7. 重启 bot：

```bash
pm2 restart wanjier
```

8. 群里验证：

```text
/whoami
```

如果 `/whoami` 的 `当前bot号` 不是新号，优先检查 NapCat 登录状态和 OneBot 配置，不要只改 bot 配置。

## 配置说明

顶层字段：

| 字段 | 说明 |
|---|---|
| `ws_url` | OneBot WebSocket 地址，通常是 `ws://127.0.0.1:3001` |
| `bot_qq` | 期望登录的机器人 QQ，仅用于展示和错号提醒 |
| `bot_name` | 机器人显示名 |
| `command_prefix` | 命令前缀，默认 `/` |
| `admin_qq` | 管理员 QQ 列表 |
| `enabled_groups` | 群白名单，空数组表示全部群可用 |
| `ai` | AI、搜索、知识库、识图、语音和队列配置 |

AI 核心字段：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `api_url` | OpenAI 兼容接口 | Chat Completions 地址 |
| `api_key` | 必填 | API 密钥 |
| `model` | 按供应商填写 | 文本模型 |
| `vision_model` | 按供应商填写 | 识图模型 |
| `max_tokens` | `400` | 群聊回复长度上限 |
| `temperature` | `0.8-0.9` | 越高越活，但越不稳定 |
| `api_timeout_ms` | `15000` | 单次模型请求超时 |

`config.example.json` 里的 `api_key` 是占位值。运行时会把包含“在这里填入”“your api”“example”“placeholder”等占位特征的 key 视为未配置，避免无效请求排进队列后白等超时。

触发与上下文：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `trigger_mode` | `smart` | @/回复/命令必回，普通消息智能触发 |
| `trigger_keywords` | 见示例 | smart 模式关键词 |
| `trigger_probability` | `0.05-0.10` | 非关键词、非低信息普通消息随机接话概率 |
| `passive_random_min_chars` | `4` | 普通随机接话最短文本长度，过滤“6”等短消息 |
| `passive_random_allow_numeric` | `false` | 普通随机接话是否允许纯数字消息 |
| `related_reply_probability` | `0.75` | 兼容字段；当前关键词/知识话题默认直接触发 |
| `poke_reply_probability` | `1` | 戳一戳回应概率 |
| `cooldown_seconds` | `0-5` | 普通主动接话冷却，@/回复/命令不受限 |
| `max_context_messages` | `50` | 2G1C 推荐每群上下文保存条数 |
| `context_send_messages` | `30` | 每次发给模型的最近消息条数 |
| `context_expire_minutes` | `120` | 会话过期时间 |

搜索与缓存：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `enable_search` | `true` | 是否启用联网搜索 |
| `search_timeout_ms` | `1200` | 2G1C 推荐搜索最多等待时间 |
| `search_cache_seconds` | `300` | 正结果缓存时间 |
| `search_negative_cache_seconds` | `60` | 空结果缓存时间 |
| `search_cache_max_entries` | `1000` | 搜索缓存最大条数，70GB 存储可适当提高 |
| `search_on_style_query` | `true` | 玩机器/CS2 相关问题也可触发搜索 |
| `ai_reply_cache_seconds` | `120-300` | 普通主动接话 AI 回复缓存 |

知识库：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `enable_knowledge` | `true` | 是否注入 `knowledge/wanjier.md` |
| `knowledge_max_chars` | `2200` | 2G1C 推荐单次注入最大字符数 |
| `knowledge_update_mode` | `reviewed_command` | 允许管理员命令更新 |
| `knowledge_auto_update` | `true` | 后台低频自动刷新 |
| `knowledge_auto_interval_minutes` | `180` | 自动刷新间隔，最低 30 |
| `knowledge_auto_commit_public_facts` | `true` | 自动写入公开事实/短摘要 |
| `knowledge_aggressive_auto_commit` | `true` | 可信公开摘要激进写入 |
| `knowledge_quarantine_long_quotes` | `true` | 长语录/礼物/转写隔离 |
| `knowledge_auto_batch_max_sources` | `6` | 后台每批最多来源 |
| `knowledge_manual_batch_max_sources` | `10` | 手动刷新每批最多来源 |
| `knowledge_auto_max_block_chars` | `1200` | 自动写入单块最大字符数 |
| `knowledge_auto_log_retention_days` | `14` | 自动日志保留天数 |

并发与 2G1C：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `max_group_queue` | `5` | 同群普通主动接话队列上限，强触发不丢 |
| `ai_global_concurrency` | `3` | 全局 AI 并发，2G1C 多群同时 @ 推荐值 |
| `search_global_concurrency` | `3` | 全局搜索并发 |
| `vision_global_concurrency` | `1` | 全局识图并发 |
| `stt_global_concurrency` | `1` | 全局语音输入听写并发 |
| `tts_global_concurrency` | `1` | 全局语音输出并发 |
| `forced_reply_quote` | `true` | 强触发引用原消息 |
| `must_reply_quote` | `true` | @/回复 bot 优先引用 |

识图和语音：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `enable_vision` | `true` | 开启图片识别 |
| `vision_max_images` | `2` | 单次最多处理图片数 |
| `image_cache_max_mb` | `512` | 图片缓存上限，70GB 存储推荐值 |
| `image_cache_max_file_mb` | `2` | 单图下载最大大小 |
| `image_cache_max_age_hours` | `72` | 图片缓存过期时间 |
| `enable_stt` | `true` | 开启 QQ 语音输入听写 |
| `stt_model` | 按供应商填写 | 支持音频输入/听写的模型 |
| `stt_max_records` | `1` | 单条消息最多听写几段语音 |
| `stt_max_file_mb` | `4` | 单段语音下载最大大小 |
| `stt_timeout_ms` | `20000` | 听写 API 超时 |
| `stt_cache_hours` | `24` | 听写文本缓存保留时间 |
| `enable_tts` | `true` | 开启语音命令和随机语音 |
| `tts_model` | `mimo-v2.5-tts` | 普通 TTS 模型 |
| `tts_clone_model` | `mimo-v2.5-tts-voiceclone` | 克隆 TTS 模型 |
| `tts_clone_enabled` | `true` | 是否尝试使用授权样本克隆 |
| `tts_sample_path` | `voice_sample.mp3` | 授权样本路径，相对项目根目录或绝对路径 |
| `tts_voice_prompt` | 见示例 | 语音风格提示 |
| `tts_max_chars` | `80-120` | 单条语音最大字符数 |
| `tts_timeout_ms` | `20000` | 语音 API 超时 |
| `tts_cache_hours` | `24` | 语音缓存保留时间 |
| `tts_sample_max_mb` | `8` | 样本最大大小 |
| `tts_probability` | `0.05-0.10` | 普通主动接话语音概率 |

## 克隆语音配置

语音克隆只适合使用你有权使用的参考音频。不要把生成结果声称为现实主播本人语音，也不要用未经授权的素材做公开分发。

### 1. 准备样本

推荐样本：

- 格式：`mp3` 或 `wav`。
- 时长：10 到 60 秒。
- 内容：干净人声，少背景音乐，少多人说话。
- 音量：不要爆音，不要太小。
- 权限：你有权使用该音频做 bot 语音参考。

放到项目根目录：

```bash
cd /opt/wanjier-bot
cp /path/to/your-authorized-sample.mp3 voice_sample.mp3
ls -lh voice_sample.mp3
```

如果样本很大，先用 `ffmpeg` 压到 64k 到 128k：

```bash
apt install -y ffmpeg
ffmpeg -i input.wav -vn -ac 1 -ar 24000 -b:a 96k voice_sample.mp3
```

### 2. 配置 TTS

`config.json`：

```json
{
  "ai": {
    "enable_stt": true,
    "stt_model": "你的音频输入模型",
    "stt_max_records": 1,
    "stt_max_file_mb": 4,
    "stt_timeout_ms": 20000,
    "stt_cache_hours": 24,
    "enable_tts": true,
    "tts_model": "mimo-v2.5-tts",
    "tts_clone_model": "mimo-v2.5-tts-voiceclone",
    "tts_clone_enabled": true,
    "tts_sample_path": "voice_sample.mp3",
    "tts_voice_prompt": "用年轻男性声音，语气随意放松，像直播间接弹幕，语速偏快但吐字清楚。不要端播音腔，短句有停顿感。",
    "tts_max_chars": 120,
    "tts_timeout_ms": 20000,
    "tts_cache_hours": 24,
    "tts_sample_max_mb": 8,
    "tts_probability": 0.08
  }
}
```

重载配置：

```text
/reload
```

或者重启：

```bash
pm2 restart wanjier
```

### 3. 语音输入听写

语音输入是“收到 QQ 语音后先尝试听写，再把听写结果塞进当前消息快照”。它只影响理解语音内容，不影响强触发必回。

注意点：

- `enable_stt=true` 后才会听写语音。
- `stt_model` 必须填写供应商支持音频输入或听写的模型。
- QQ 语音常见是 `amr` 或 `silk`。如果服务器安装了 `ffmpeg`，bot 会尝试转成 mp3 再听写。
- 如果供应商不支持当前音频请求格式，`@` 仍会引用原消息回复，只是不会假装听懂语音内容。
- 2G1C 推荐 `stt_global_concurrency=1`、`stt_max_records=1`，避免多人同时发语音把队列堵死。

安装转码工具：

```bash
apt install -y ffmpeg
```

测试方式：

```text
/voice status
@bot 然后发一条语音
```

`/voice status` 里看：

- `STT: on`：语音听写开了。
- `听写模型`：当前用于听写的模型。
- `听写缓存`：缓存命中、下载失败、空转写统计。
- `听写最近错误`：供应商格式不兼容、下载失败、超时等都会显示在这里。

### 4. 测试语音输出链路

群里发送：

```text
/voice status
/voice test
/voice test 不是哥们，这波语音测试有点东西
```

`/voice status` 里重点看：

- `TTS: on`：语音功能开启。
- `克隆: ready`：样本可用，会走克隆模型。
- `克隆: missing`：样本缺失、太小、太大或路径错误，会降级普通 TTS。
- `最近错误`：最近一次 API、网络、解析或长度错误。

### 5. 常见语音问题

- `sample missing`：检查 `tts_sample_path`，相对路径从项目根目录算。
- `sample too small`：样本小于 1KB，通常是空文件或复制失败。
- `sample too large`：超过 `tts_sample_max_mb`，压缩样本或提高限制。
- `text length out of range`：语音文本超过 `tts_max_chars`。
- `HTTP 401/403`：API key 或供应商权限不对。
- `empty audio response`：模型不支持当前 TTS 请求格式。
- QQ 不显示语音：确认 OneBot/NapCat 支持本地 `file://` 语音发送，查看 PM2 日志。
- `听写 HTTP 400/422`：多数是供应商不支持当前音频输入格式，换 `stt_model` 或关闭 `enable_stt`。
- `download too large`：语音超过 `stt_max_file_mb`。
- `empty transcript`：模型没听出来或接口返回格式不是当前兼容格式。

### 6. 语音使用建议

- 强触发默认优先文字引用，保证回复定位准确。
- 随机语音只用于普通主动接话，避免多人 @ 时语音串台。
- 语音适合短句：一句吐槽、一句礼物感谢、一句测试。
- 长复盘、搜索结果、配置教程不要发语音。
- 2G1C 推荐 `stt_global_concurrency=1`、`tts_global_concurrency=1`，`tts_probability=0.05-0.10`；群很多时宁愿降到 `0.03`。

## 命令列表

对话：

| 命令 | 说明 |
|---|---|
| `/ai <内容>` | 直接调用 AI 回复 |
| `@bot <内容>` | 强触发，必回，优先引用原消息 |
| 回复 bot 消息 | 强触发，必回，优先引用原消息 |
| `/search <关键词>` | 联网搜索 |
| `/voice <内容>` | 生成语音 |
| `/voice status` | 查看 TTS、克隆样本和缓存状态 |
| `/voice test [内容]` | 生成测试语音 |
| `/voice clean` | 清理过期语音缓存 |
| `/tts <内容>` | 生成语音 |
| `/say <内容>` | 生成语音 |
| `/reset` 或 `/clear` | 清除当前群上下文 |
| `/presets` | 查看预设 |
| `/preset <名称>` | 切换预设 |

知识库：

| 命令 | 权限 | 说明 |
|---|---|---|
| `/quote [关键词]` | 所有人 | 查本地语录/口癖/拟态短句 |
| `/player <名字>` | 所有人 | 查选手倾向，遇到“最新/阵容/转会/排名”会联网融合 |
| `/team <队伍>` | 所有人 | 查队伍倾向，遇到实时词会联网融合 |
| `/gift <礼物名>` | 所有人 | 生成礼物感谢拟态模板 |
| `/kb search <关键词>` | 所有人 | 检索本地知识库 |
| `/kb stats` | 所有人 | 查看知识库统计 |
| `/kb preview <关键词>` | 管理员 | 联网生成候选，不写主库 |
| `/kb refresh [--aggressive] [关键词]` | 管理员 | 批量刷新公开来源 |
| `/kb audit` | 管理员 | 审计知识库问题 |
| `/kb auto on/off/run` | 管理员 | 控制自动刷新 |
| `/kb batches` | 管理员 | 查看自动写入批次 |
| `/kb rollback <batchId>` | 管理员 | 回滚某个自动批次 |
| `/kb ingest [full]` | 管理员 | 从 `knowledge/inbox/` 生成候选 |
| `/kb list` | 管理员 | 查看待确认候选 |
| `/kb show <ID>` | 管理员 | 查看候选详情 |
| `/kb commit <ID>` | 管理员 | 写入主知识库或隔离 |
| `/kb drop <ID>` | 管理员 | 丢弃候选 |

工具和管理：

| 命令 | 说明 |
|---|---|
| `/help` | 帮助 |
| `/ping` | 在线检测 |
| `/whoami` | 查看当前 bot self_id、配置 bot_qq、群号、消息 ID |
| `/status` | 运行状态 |
| `/diag` | 快速严格自检，不消耗 AI token |
| `/diag live` | 管理员真实联网/写盘自检 |
| `/time` | 当前时间 |
| `/stats` | 群统计 |
| `/reload` | 管理员重载配置 |
| `/addgroup [群号]` | 管理员加入群白名单 |
| `/rmgroup <群号>` | 管理员移出群白名单 |
| `/ban @人 [分钟]` | 管理员禁言 |
| `/unban @人` | 管理员解禁 |
| `/kick @人` | 管理员踢人 |
| `/title @人 <头衔>` | 管理员设置群头衔 |

趣味：

| 命令 | 说明 |
|---|---|
| `/roll [N|NdM]` | 掷骰子，支持 `2d6` |
| `/luck` | 今日运势 |
| `/jrrp` | 今日人品 |
| `/choose A,B,C` | 随机选择 |
| `/rand [min] [max]` | 随机数 |

## 知识库工作流

主知识库：

```text
knowledge/wanjier.md
```

联网来源：

```text
knowledge/sources.json
```

本地素材导入：

```text
knowledge/inbox/
```

风险隔离：

```text
knowledge/quarantine/
```

### 本地检索

```text
/kb search NiKo
/kb search 礼物感谢
/quote 公式解说
/player m0NESY
/team G2
```

### 联网预览

```text
/kb preview 玩机器 6657 公式解说
/kb preview HLTV Top 20 players 2025 ZywOo donk ropz
```

`preview` 只生成候选，不写主库。

### 批量刷新

```text
/kb refresh
/kb refresh --aggressive 玩机器Machine 萌娘百科 6657
/kb refresh --aggressive HLTV team ranking 2026 Vitality Spirit Falcons
```

刷新规则：

- `public_fact`：可信公开事实，满足条件时自动写入。
- 可信 `public_summary`：`--aggressive` 或 `knowledge_aggressive_auto_commit=true` 时可自动写入短摘要。
- `unknown`：礼物原话、疑似长转写、切片台词，默认不写主库。
- 长句、疑似原话、礼物感谢完整话术进入 `knowledge/quarantine/`。
- 后台自动刷新会读取 `sources.json` 的 `intervalMinutes`，只跑到期来源；手动 `/kb refresh` 不受间隔限制。
- 来源上次自动刷新时间记录在 `knowledge/source-state.json`，这是运行产物，默认不提交。

### 查看和回滚自动写入

```text
/kb batches
/kb rollback <batchId>
```

自动写入会在主库中生成类似：

```text
<!-- kb:auto batch=... hash=... begin -->
...
<!-- kb:auto batch=... hash=... end -->
```

因此可以按批次回滚。

### 导入本地转写

把你自己整理或有权使用的素材放入：

```text
knowledge/inbox/
```

建议格式：

```text
时间点 / 场景 / 原句或摘要 / 来源链接
12:34 / 礼物感谢 / ... / https://...
18:20 / G2残局评价 / ... / https://...
```

生成候选：

```text
/kb ingest
/kb ingest full
/kb list
/kb show <候选ID>
/kb commit <候选ID>
```

`/kb ingest full` 适合较长素材，但仍建议整理成“场景、摘要、可用话术”，不要把整段直播转写无脑塞入主库。

## 知识库准确性边界

- 公开网页没有可靠原文时，不写成“经典原话”。
- 礼物感谢默认是拟态模板，不是核验原话。
- B站标题和搜索摘要只能当切片索引，不当完整证据。
- HLTV、Liquipedia、Valve、官方公告优先级高于二手摘要。
- 队伍阵容、转会、排名、赛果、版本更新必须联网确认。
- 不复制长视频转写、完整切片台词或平台内容大段文本。
- 被问身份时必须说明自己是群 bot，不冒充现实主播本人。

## 运行机制

### 回复定位

`ai-chat` 会为每条需要 AI 回复的消息创建 `ReplyJob`，保存：

- group_id
- user_id
- message_id
- senderName
- rawText
- effectiveText
- imageUrls
- contextSnapshot
- triggerReason

模型提示中会显式写入“当前要回复的是谁、哪条消息、触发类型”。强触发默认引用原消息回复，避免回错人。

回复 bot 的旧消息时，系统先用内存追踪 bot 发出的消息 ID；如果进程重启导致追踪丢失，会用 OneBot `get_msg` 短超时兜底检查原消息发送者，尽量避免“明明回复了 bot 但没有触发”。

### 队列和背压

- 同群按消息顺序 FIFO。
- 跨群可以并发，多群同时 @ 会同时进入全局 AI 闸门。
- 全局 AI/搜索/识图/TTS 受闸门限制。
- @/回复/命令强触发永远入队，不受每分钟次数上限、普通冷却和普通队列上限影响。
- 强触发在全局 AI 闸门中优先于普通主动接话；多个强触发之间保持到达顺序。
- 普通主动接话在同群队列满时跳过，避免长期运行刷屏和堆积。
- 关键词/知识话题普通消息会确定性触发；剩余普通消息才按 `trigger_probability` 抽样。
- 低信息普通消息不会主动接话：纯数字、单个“6”、短“666/哈哈/草”、纯标点/表情会被过滤。
- 强触发排队超过 60 秒跳过 TTS。
- 强触发排队超过 120 秒跳过搜索/识图。

### 缓存

- 搜索缓存：`search_cache/search-cache.json`
- 图片缓存：`image_cache/`
- 语音听写缓存：`stt_cache/`
- 语音输出缓存：`voice_cache/`
- 上下文：`context_store/`
- 知识库自动日志：`knowledge/auto-log.jsonl`
- 知识库来源刷新状态：`knowledge/source-state.json`
- 知识库审计：`knowledge/audit.json`

运行产物默认写入 `.gitignore`，不要提交。

## 2G1C / 70GB 推荐配置

```json
{
  "ai": {
    "max_context_messages": 50,
    "context_send_messages": 30,
    "knowledge_max_chars": 2200,
    "search_timeout_ms": 1200,
    "api_timeout_ms": 15000,
    "search_cache_max_entries": 1000,
    "ai_reply_cache_seconds": 180,
    "vision_max_images": 2,
    "image_cache_max_mb": 512,
    "image_cache_max_file_mb": 2,
    "image_cache_max_age_hours": 72,
    "enable_stt": true,
    "stt_model": "你的音频输入模型",
    "stt_max_records": 1,
    "stt_max_file_mb": 4,
    "stt_timeout_ms": 20000,
    "stt_cache_hours": 24,
    "enable_tts": true,
    "tts_probability": 0.10,
    "tts_max_chars": 120,
    "tts_cache_hours": 24,
    "trigger_probability": 0.08,
    "passive_random_min_chars": 4,
    "passive_random_allow_numeric": false,
    "poke_reply_probability": 1,
    "max_group_queue": 5,
    "ai_global_concurrency": 3,
    "search_global_concurrency": 3,
    "vision_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "knowledge_auto_batch_max_sources": 6,
    "knowledge_manual_batch_max_sources": 10
  }
}
```

如果机器开始卡：

1. 降低 `context_send_messages` 到 20。
2. 降低 `knowledge_max_chars` 到 1400。
3. 设置 `vision_max_images` 为 1。
4. 把 `enable_stt` 临时关掉，或把 `stt_max_records` 固定为 1。
5. 降低 `tts_probability` 到 `0.03` 或直接 `0`。
6. 设置 `trigger_probability` 到 `0.05`，确认 `passive_random_allow_numeric=false`。
7. 把 `search_global_concurrency` 降到 2。
8. 查看 `/status` 里的队列和闸门是否长期堆积。

### 1G 降级档

如果机器只有 1G 内存，保留同群队列和强触发定位，牺牲图片、语音和知识注入：

```json
{
  "ai": {
    "max_context_messages": 30,
    "context_send_messages": 15,
    "knowledge_max_chars": 1000,
    "search_timeout_ms": 800,
    "enable_stt": false,
    "vision_max_images": 1,
    "tts_probability": 0,
    "max_group_queue": 3,
    "ai_global_concurrency": 1,
    "search_global_concurrency": 2,
    "vision_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "knowledge_auto_batch_max_sources": 3,
    "knowledge_manual_batch_max_sources": 6
  }
}
```

## 验证和测试

每次改代码后：

```bash
npm run build
npm run smoke
```

`smoke` 覆盖：

- `config.example.json` 新字段解析。
- 知识库加载和审计。
- 自动写入、批次日志、rollback。
- 来源刷新状态：刚刷过的来源跳过，过期/未刷来源进入下一批，并验证 batch limit。
- 全局并发闸门，包括 AI、搜索、识图、语音听写和语音输出。
- 搜索 single-flight。
- 消息级回复定位：连续三条不同用户 @ 必须分别引用对应 `message_id`。
- 回复 bot 旧消息：通过 OneBot `get_msg` 兜底识别，并引用当前触发消息回复。
- 示例配置的占位 API Key 不会被误判为可用。

当前仍需要人工或线上压测覆盖的点：

- 真实 NapCat/QQ 网络下的 `reply` 段兼容性。
- 5 个以上活跃群同时 @ 时的供应商 API 限速表现。
- STT 供应商是否兼容 `input_audio` 或 `audio_url` 请求格式；不兼容时强触发仍会文本兜底。
- TTS 供应商返回格式变化后的语音可播放性。
- 公开搜索结果质量；实时比赛/转会仍以 `/diag live` 和来源链接为准。

上线后手动检查：

```text
/whoami
/status
/diag
/diag live
/voice status
/voice test
/kb stats
/kb audit
/kb refresh --aggressive 玩机器Machine 萌娘百科 6657
/kb batches
```

## 故障排查

### 完全不回复：按层排查

先分清楚是哪一层坏了。不要一上来改人格、知识库或模型。

```text
QQ群消息 -> NapCat收到 -> OneBot WebSocket发给bot -> bot插件处理 -> bot调用send_group_msg -> QQ群看到回复
```

按下面顺序查，每一步都只看一个问题。

#### 1. bot 进程是否活着

```bash
cd /opt/wanjier-bot
pm2 list
pm2 logs wanjier --lines 120
```

正常现象：

- `wanjier` 是 `online`。
- 日志里有 `WebSocket 连接成功`。
- 日志里能看到群消息，例如 `[群xxxx] 昵称(QQ): /ping`。

异常处理：

- 没有 `wanjier`：执行 `pm2 start ecosystem.config.js && pm2 save`。
- 状态是 `errored`：看 `pm2 logs wanjier --lines 200`。
- 没有 `WebSocket 连接成功`：继续查 NapCat 和 3001 端口。

#### 2. NapCat 容器是否活着

```bash
docker ps
docker logs --tail 150 napcat
```

正常现象：

- `napcat` 容器是 `Up`。
- 日志里没有反复重启、登录失败、账号掉线。
- 机器人 QQ 已经登录。

异常处理：

- 没有容器：按部署教程重新 `docker run`。
- 容器退出：`docker logs napcat` 看原因。
- QQ 没登录：打开 `http://服务器IP:6099` 或看日志扫码。

#### 3. OneBot WebSocket 是否真的开启

先设置真实 QQ：

```bash
export BOT_QQ=3098064534
```

查看配置：

```bash
grep -A20 websocketServers /opt/napcat/config/onebot11_${BOT_QQ}.json
```

必须不是空数组：

```json
"websocketServers": [
  {
    "enable": true,
    "host": "0.0.0.0",
    "port": 3001,
    "messagePostFormat": "array"
  }
]
```

如果是：

```json
"websocketServers": []
```

执行：

```bash
python3 - << 'PY'
import json
from pathlib import Path
import os

bot_qq = os.environ.get("BOT_QQ", "").strip()
if not bot_qq:
    raise SystemExit("先执行 export BOT_QQ=你的机器人QQ")

p = Path(f"/opt/napcat/config/onebot11_{bot_qq}.json")
data = json.loads(p.read_text())
network = data.setdefault("network", {})
network["websocketServers"] = [{
    "name": "ws-server",
    "enable": True,
    "host": "0.0.0.0",
    "port": 3001,
    "enableForcePushEvent": True,
    "messagePostFormat": "array",
    "reportSelfMessage": False,
    "token": ""
}]
p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
PY
docker restart napcat
```

#### 4. 端口是否通

```bash
ss -lntp | grep 3001 || true
docker ps | grep napcat
```

正常现象：

- `ss` 能看到 `:3001` 监听。
- `docker ps` 里能看到 `0.0.0.0:3001->3001/tcp`。

如果 `docker ps` 没有端口映射，重建容器：

```bash
docker rm -f napcat
export BOT_QQ=3098064534
docker run -d \
  --name napcat \
  --restart=always \
  --memory=600m \
  --memory-swap=900m \
  -e ACCOUNT=$BOT_QQ \
  -e NAPCAT_GID=0 \
  -e NAPCAT_UID=0 \
  -p 3001:3001 \
  -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  mlikiowa/napcat-docker:latest
docker logs -f napcat
```

#### 5. bot 配置是否连对端口

```bash
cd /opt/wanjier-bot
node - << 'NODE'
const c = require('./config.json')
console.log('ws_url=', c.ws_url)
console.log('bot_qq=', c.bot_qq)
console.log('admin_qq=', c.admin_qq)
console.log('enabled_groups=', c.enabled_groups)
console.log('api_url=', c.ai && c.ai.api_url)
console.log('model=', c.ai && c.ai.model)
console.log('trigger_mode=', c.ai && c.ai.trigger_mode)
NODE
```

推荐：

```json
"ws_url": "ws://127.0.0.1:3001",
"bot_qq": 3098064534,
"enabled_groups": []
```

如果 bot 和 NapCat 不在同一台机器，`127.0.0.1` 要换成 NapCat 机器 IP。

#### 6. 本地命令 `/ping` 是否回复

群里发：

```text
/ping
```

判断：

- `/ping` 不回：不是 AI 问题，是 NapCat/WebSocket/PM2/群白名单/账号登录问题。
- `/ping` 回，但 `/whoami` 不回：插件链异常，看 PM2 日志。
- `/ping`、`/whoami` 都回，但 `@bot` 不回：看 @ 检测、`self_id`、AI 配置。

#### 7. `/whoami` 是否是目标 QQ

群里发：

```text
/whoami
```

必须满足：

```text
当前bot号: 3098064534
配置bot_qq: 3098064534
```

如果 `当前bot号` 不是新号，说明 NapCat 实际登录的不是你以为的 QQ。只改 `config.json` 没用，必须重登 NapCat。

#### 8. AI 是否可用

群里发：

```text
/diag
/ai 你在吗
```

如果 `/ping` 回但 `/ai` 不回，重点看：

- `api_key` 是否还是占位值。
- `api_url` 是否是 Chat Completions 地址。
- `model` 是否真实存在。
- VPS 是否能访问 API。

VPS 上可以简单测网络：

```bash
curl -I https://你的接口域名
```

#### 9. 看实时日志定位

开一个窗口：

```bash
pm2 logs wanjier --lines 0
```

然后群里发 `/ping`。如果日志完全没出现群消息，说明消息没进 bot，查 NapCat。
如果日志出现群消息但没有回复，查插件报错或白名单。
如果日志出现 `AI接口没配`，查 `config.json`。
如果日志出现 `发送群消息失败 retcode=...`，查 bot 是否在群里、是否被禁言、NapCat API 权限。

### 常见命令敲错

- 错误：`/opt/napcat/config/onebot11_3098064534.json`
  - 这是把配置文件当命令执行，会出现 `Permission denied`。
  - 正确：`cat /opt/napcat/config/onebot11_3098064534.json` 或 `nano /opt/napcat/config/onebot11_3098064534.json`。
- 错误：`python3 - << 'PY' import json ...`
  - heredoc 第一行后面不能接代码，会卡在 `>`。
  - 正确：第一行只写 `python3 - << 'PY'`，最后一行单独写 `PY`。
- 错误：编辑 `/opt/napcat/config/onebot11_你的机器人QQ.json`
  - 这是占位符文件名，不是真配置。
  - 正确：把 `你的机器人QQ` 换成真实 QQ，例如 `onebot11_3098064534.json`。
- 错误：只改 `/opt/wanjier-bot/config.json` 的 `bot_qq`
  - 这不会切换登录账号。
  - 正确：NapCat 必须扫码登录新 QQ，OneBot 配置文件也要对应新 QQ。

### @ 了不回复

1. 群里发 `/whoami`，确认 `当前bot号` 是 NapCat 登录号。
2. 检查 NapCat `messagePostFormat` 是否为 `array`。
3. 看 `/diag` 是否提示 AI 接口未配置。
4. 确认 `api_key` 不是示例里的占位值；占位 key 会被诊断为未配置。
5. 看 `/status` 队列是否长期堆积。
6. 如果设置了 `enabled_groups`，确认群号在白名单。

### 回复错人

1. 确认收到的是 OneBot 数组消息。
2. 确认 `message_id` 正常显示在 `/whoami`。
3. 强触发会优先 `reply` 段引用；引用失败才回退 @。
4. 回复 bot 的旧消息会尝试 `get_msg` 兜底识别；如果 NapCat 禁用了该 API，重启前发出的旧 bot 消息可能无法识别为“回复 bot”。
5. 多人连续 @ 时看 `/status` 的同群队列是否堆积。

### 搜索没结果

1. 确认 `enable_search=true`。
2. 跑 `/diag live`。
3. 搜索空结果会短缓存，默认 60 秒。
4. DuckDuckGo/Bing 受网络影响，VPS 网络差时会超时返回空。

### 识图不可用

1. 确认 `enable_vision=true`。
2. 确认 `vision_model` 支持多模态。
3. 图片 URL 必须能由服务器访问。
4. 单图超过 `image_cache_max_file_mb` 会被图片缓存层拒绝；2G1C 示例默认 2MB，1G 降级档建议 1MB。

### 语音不可用

1. 确认 `enable_tts=true`。
2. 确认 API 支持当前 TTS 请求格式。
3. 没有 `voice_sample.mp3` 时会走普通 TTS。
4. 强触发默认优先文字引用，普通主动接话才可能随机语音。

### 知识库越学越假

1. 跑 `/kb audit`。
2. 用 `/kb batches` 查看最近自动写入。
3. 用 `/kb rollback <batchId>` 回滚错误批次。
4. 把真实素材放入 `knowledge/inbox/`，走 `/kb ingest`。
5. 不要把无来源长句写成“真实语录”。

## 更新流程

```bash
cd /opt/wanjier-bot
git pull
npm install
npm run build
npm run smoke
pm2 restart wanjier
pm2 logs wanjier --lines 80
```

如果知识库自动刷新写入过多：

```text
/kb batches
/kb rollback <batchId>
```

## 安全和合规边界

- 不冒充现实主播本人。
- 不编造现实人物隐私、病情、家庭、收入、住址、联系方式。
- 不断言假赛、开挂、违法等严重指控，除非用户提供可靠公开来源。
- 不使用歧视性辱骂，不围绕性别、地域、民族、疾病、残障攻击。
- 不大段复制公开平台视频、文章、脚本库内容。
- 礼物感谢和切片长句默认写成拟态模板或隔离候选。

## License

MIT
