# 玩机器风格 QQ 群聊 Bot

一个基于 OneBot v11 / NapCatQQ 的 QQ 机器人。它参考 CS2 解说主播“玩机器 / 6657”的直播间语感，支持群聊 @ 必回、引用定位、私聊回复、上下文记忆、联网搜索、识图、语音、Markdown 知识库、知识库自动刷新、队列背压，并按 2G 内存 / 1 核 / 70GB 存储长期运行重新调参。

重要边界：本项目是“风格参考 bot”，不是现实主播本人，不代表本人发言。知识库里的“拟态模板”不是核验原话；公开来源只写事实索引、短摘要和链接，长转写/礼物原话请走本地素材导入。

## 当前能力

- @/回复/命令强触发必回，优先引用原消息，引用失败回退 @ 用户。
- 私聊已接入主插件链：`/ping`、`/status`、`/diag`、`/quote`、`/player`、`/team`、`/gift`、`/csplayer`、`/voice`、`/search` 和普通 AI 对话都可用；群统计、复读、禁言、踢人等群专属功能只在群里执行。
- 每条 AI 回复绑定消息级快照：群号、用户、消息 ID、原文、图片、上下文、触发原因。
- 同群 FIFO 排队，跨群并发；2G1C 推荐全局 AI/搜索/识图/听写/TTS 闸门 `3/3/1/1/1`。
- 队列积压时自动降级：强触发超过 60 秒跳过 TTS，超过 120 秒跳过搜索/识图/听写，只保底文本回复。
- 普通消息分层触发：关键词/知识话题直接接话；CS 软讨论更高概率接话；其他消息按概率接话，纯数字、单个“6”、纯表情和低信息短句不会主动刷屏。
- 戳一戳会按配置概率回应，使用本地直播短句池并少量融合知识库口癖；复读机保留群聊感，但不会抢 @/回复/关键词 AI 触发。
- 趣味命令已玩机器化，每日 CS 系列：选手、队伍、地图、武器、枪皮、刀皮、定位、道具、战术、残局、套餐、木柜子、原神等都会优先读取专属图片池，图片拿不到时也会给当天签位图。
- Markdown 知识库：`knowledge/wanjier.md` 提供直播语态、口癖、CS2 解说、选手/队伍倾向、礼物拟态、拒绝边界。
- 知识库自动刷新：`/kb refresh`、`/kb refresh --aggressive`、`/kb batches`、`/kb rollback`。
- 联网搜索：DuckDuckGo Instant、DuckDuckGo HTML、Bing RSS 兜底，带 single-flight、正/负缓存和磁盘缓存。
- 上下文记忆：每群持久化到 `context_store/`，旧消息异步压缩，不阻塞回复。
- RAG 记忆：每群/私聊会话会把历史消息写入轻量 n-gram 索引，回复时只注入相似历史；排序按 `相似度 + 近期加权`，避免长期群聊里很旧的相似句压过最近话题；遇到“现在/最新/排名/阵容/比分/转会”等 CS 实时问法，会跳过疑似旧 CS 实时事实记忆，只保留稳定战术/道具等非实时片段；`/mem check <消息>`、`/mem search <关键词>`、管理员 `/mem drop <关键词>` 和 `/trace last` 可排查/清理召回内容。
- 图片识别缓存：图片下载后缓存到 `image_cache/`，减少重复识图成本。
- NapCat 只给图片 `file` 不给 `url` 时，会自动调用 OneBot `get_image`；返回 URL、本地路径或 base64 都能继续识图。
- 识图自动兼容多种 payload：`image_url` 对象、`image_url` 字符串、`input_image`、`image` 四种格式自动重试。
- STT 语音听写缓存：语音输入缓存到 `stt_cache/`，支持 API、本地命令、自动兜底三种模式。
- NapCat 只给语音 `file` 不给 `url` 时，会自动调用 OneBot `get_record`，按 `stt_record_format` 转成 mp3/wav/amr/m4a 后再听写。
- TTS 语音缓存：语音输出缓存到 `voice_cache/`，支持 API、本地授权语音引擎、自动兜底三种模式；有授权样本时可尝试供应商 voiceclone。
- Docker NapCat 默认用 `base64://` 发送 TTS 语音，避免容器读不到宿主机 `voice_cache/` 文件。
- 真人感短停顿：文本/被动语音在真正发送前会做毫秒级短暂停顿，`/trace`、`/status`、`/maint status` 可观察次数、平均值和最近一次。
- 表情会走 QQ face/本地贴纸链路：AI 的常见 emoji 会转成 QQ 经典表情；群里说“白给/开香槟/保枪/老板大气”等会低频自动接贴纸，并带冷却避免刷屏。
- `/status`、`/diag` 和 `/maint` 提供队列、缓存、知识库、并发、内存、配置漂移和清理维护能力。
- `/csbrief` 提供今日 CS 短报；`/csreport on 09:30` 可给当前群/私聊开启每日 CS 日报推送，当前/即将比赛、最近赛果、排名快照和热门新闻都走实时数据链路。

## 项目结构

```text
src/
  index.ts                 启动入口，注册插件和事件监听 + 内存监控
  bot.ts                   WebSocket 连接、API 调用、心跳和重连
  handler.ts               群聊/私聊消息路由、命令解析、引用回复、@检测
  message-sanitize.ts      统一发送出口基础清理
  config.ts                config.json 解析、默认值、字段归一化、自动迁移
  logger.ts                统一日志（带时间戳/分级/彩色）
  types.ts                 OneBot 和配置类型
  plugins/
    ai-chat.ts             核心 AI 入口（上下文、知识注入、搜索、识图、STT、TTS 调度）
    ai-context.ts          上下文管理器（内存+磁盘双层、按需加载、压缩摘要）
    llm-api.ts             LLM HTTP 调用、续写、视觉模式自动重试、重试机制
    media-utils.ts         图片/语音 URL 提取、OneBot 媒体解析、base64 封装
    reply-postprocess.ts   AI 回复后处理、长度截断、格式清理、公式化开头去除
    knowledge-base.ts      Markdown 知识库、候选、自动写入、回滚、审计
    web-search.ts          联网搜索、single-flight、正/负缓存
    concurrency.ts         全局并发闸门
    context-store.ts       上下文持久化
    image-cache.ts         图片缓存
    stt.ts                 语音输入听写和缓存
    tts.ts                 语音生成和缓存
    diag.ts                严格自检
    status.ts              运行状态
    fun.ts                 roll/luck/jrrp/choose/rand/csplayer
    admin.ts               reload/maint/ban/unban/kick/title
    help.ts ping.ts stats.ts time.ts poke.ts recall.ts repeater.ts welcome.ts
knowledge/
  wanjier.md               主知识库（含玩机器经典名场面、2026选手梗、地图池）
  sources.json             联网刷新来源配置
  inbox/                   本地转写/笔记导入目录
  quarantine/              旧版本遗留目录；当前不再写入
scripts/
  smoke.js                 构建后 smoke test
  recover.sh               一键诊断+恢复
  doctor.js                配置检查
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

## 最终推荐配置和预设

仓库里的 `config.example.json` 就是当前最新推荐模板。VPS 上不要直接编辑示例文件，按下面流程复制：

```bash
cd /opt/wanjier-bot
cp config.example.json config.json
nano config.json
```

至少替换这些值：

- `bot_qq`：NapCat 实际登录的机器人 QQ。
- `admin_qq`：你的管理员 QQ。
- `api_url`、`api_key`、`model`、`vision_model`：你的 OpenAI 兼容接口和模型。
- 如果要先走本地语音，把 `tts_provider`、`stt_provider` 保持 `auto`，再填 `tts_local_command`、`stt_local_command`。

推荐不要把真实密钥写进 `config.json`。程序会按下面顺序读取密钥：

1. `WANJIER_API_KEY`（推荐）
2. `OPENAI_API_KEY`
3. `config.json` 里的 `ai.api_key`

### 推荐方式：用 `.env` 文件（启动时自动加载）

```bash
cp .env.example .env
nano .env
# 填入 WANJIER_API_KEY 和 WANJIER_ADMIN_QQ
pm2 restart wanjier --update-env
```

`.env` 在 `.gitignore` 里，不会被 `git pull` 覆盖，每次更新代码不用再改 config.json。

支持的环境变量（看 `.env.example` 全部）：
- `WANJIER_API_KEY` 必填
- `WANJIER_ADMIN_QQ` 管理员QQ（多个用逗号分隔）
- `WANJIER_AGGRESSION` 攻击力（low/medium/high）
- `WANJIER_TRIGGER_PROBABILITY` 随机触发概率
- `WANJIER_MAX_TOKENS` 最大输出
- `WANJIER_TEMPERATURE` AI温度
- `WANJIER_TTS_PROBABILITY` 语音概率
- `WANJIER_HUMAN_REPLY_DELAY_ENABLED` 真人感短停顿开关
- `WANJIER_HUMAN_REPLY_DELAY_MIN_MS` / `MAX_MS` 普通主动接话停顿区间
- `WANJIER_HUMAN_REPLY_DELAY_FORCED_MIN_MS` / `FORCED_MAX_MS` @/回复/命令停顿区间
- `WANJIER_ENABLE_TTS` / `WANJIER_ENABLE_VISION` 开关功能

---

### 老方式（也可用）：

```bash
export WANJIER_API_KEY='替换成你的真实API密钥'
pm2 restart wanjier --update-env
```

VPS 上建议这样注入（一次性），命令里的值替换成你自己的真实密钥：

```bash
export WANJIER_API_KEY='替换成你的真实API密钥'
pm2 restart wanjier --update-env
```

或者更推荐——直接写到 `.env` 文件里，每次更新代码不用重新设置：

```bash
echo 'WANJIER_API_KEY=替换成你的真实API密钥' >> /opt/wanjier-bot/.env
pm2 restart wanjier --update-env
```

当前推荐 `ai` 核心配置如下，完整文件以 `config.example.json` 为准：

```json
{
  "config_version": 20260609,
  "ai": {
    "api_url": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    "api_key": "在这里填入你的API密钥",
    "model": "mimo-v2.5-pro",
    "vision_model": "mimo-v2.5-pro",
    "active_preset": "wanjier",
    "max_context_messages": 50,
    "context_send_messages": 30,
    "max_tokens": 4096,
    "temperature": 0.92,
    "trigger_mode": "smart",
    "trigger_probability": 0.08,
    "passive_random_min_chars": 4,
    "passive_random_allow_numeric": false,
    "poke_reply_probability": 1,
    "cooldown_seconds": 0,
    "enable_search": true,
    "search_timeout_ms": 1200,
    "api_timeout_ms": 120000,
    "enable_knowledge": true,
    "knowledge_max_chars": 2600,
    "knowledge_force_style": true,
    "enable_memory_retrieval": true,
    "memory_top_k": 4,
    "memory_min_similarity": 0.18,
    "memory_inject_max_chars": 700,
    "memory_max_messages_per_session": 700,
    "memory_max_sessions_in_memory": 80,
    "persona_mode": "first_person_bot",
    "aggression_level": "medium",
    "max_group_queue": 5,
    "ai_global_concurrency": 3,
    "search_global_concurrency": 3,
    "vision_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "forced_reply_quote": true,
    "must_reply_quote": true,
    "enable_vision": true,
    "vision_payload_mode": "auto",
    "vision_max_images": 2,
    "enable_stt": true,
    "stt_model": "mimo-v2.5-pro",
    "stt_provider": "auto",
    "stt_payload_mode": "auto",
    "stt_record_format": "mp3",
    "stt_local_command": "",
    "stt_local_timeout_ms": 15000,
    "enable_tts": true,
    "tts_model": "mimo-v2.5-tts",
    "tts_provider": "auto",
    "tts_local_command": "",
    "tts_local_output_dir": "voice_cache/local",
    "tts_local_timeout_ms": 15000,
    "tts_clone_model": "mimo-v2.5-tts-voiceclone",
    "tts_clone_enabled": true,
    "tts_sample_path": "voice_sample.mp3",
    "tts_max_chars": 120,
    "tts_send_mode": "base64",
    "tts_timeout_ms": 20000,
    "tts_cache_hours": 24,
    "tts_probability": 0.1
  }
}
```

`config_version` 不是功能开关，但它很有用：升级后 `npm run doctor`、`/maint status`、`/maint config` 会拿它和当前示例配置比对。如果 VPS 的 `config.json` 没有这个字段，或者小于 `20260609`，说明你大概率还没同步最新字段和 prompt。

当前 `wanjier` 预设提示词在 `config.example.json` 的 `ai.presets.wanjier.system_prompt`，核心要求是：

```text
你在群里按第一人称「玩机器 / 6657」直播间语感说话，像正在接弹幕：反应快、会嘴硬、会吐槽，但判断一定要贴着当前消息。日常不要主动解释自己是什么，不要说「作为bot/作为AI/我来模仿」，直接像正常群友一样回。

身份问询：普通问「你是不是bot/机器人/AI」，嘴硬带过去，坚持第一人称口吻，不要复读固定句式，顺手把话题接回当前内容。只有明确追问现实主播本人、授权、代表本人、本尊关系时，才说明这是群里的风格bot，不是现实主播本人，不代表本人。

说话质感必须来自知识库和临场笔记，不靠固定口头禅硬撑。口癖可以有，但不要公式化：不要连续同一个开头，不要每条都「可以的」「有点东西」「这波有说法」。先读懂对方在聊什么，再挑一个自然反应。

回复节奏：普通群聊一两句就够；CS2、选手、队伍、比赛可以多两三句，但要抓一个具体点，比如经济、道具、timing、补枪、角色、地图池、近期状态。不要写「结论/分析/建议/总结」这种标题，不要像报告。

攻击性要收住：可以轻轻嘴硬，可以指出操作和逻辑问题，但不要动不动喷人；少骂群友，多讲回合、事实和判断。能用「等一下」「先别急」「这个不太对」就不要硬塞固定口头禅。

看图时先说可见内容，再给短评；看不清就说看不清，别硬编。语音有听写就接听写，没有听写就承认只收到语音。

硬规则：
1. 当前消息永远优先，上下文只辅助，不回答历史里其他人的旧问题。
2. @、回复、私聊、/ai、明确要求语音必须接话，不能因为冷却、普通概率或队列限制丢掉。
3. 不用markdown，不加「玩机器:」前缀，不输出括号舞台说明或风格标签。
4. 嘴硬但不追着骂人，攻击性点到为止，少点火多分析。
5. 知识库里标为拟态模板的内容不能当真实原话；实时比分、阵容、转会、排名要联网确认。
```

这次真人化升级建议同步修改 VPS 的 `config.json`。代码层已经会强制注入临场笔记、按同类口头禅族群去重最近开头、清掉“结论/根据知识库/作为AI”这类公式化前缀；但如果 VPS 仍用旧 prompt，模型还是更容易写成规则说明。最稳做法是把 `config.example.json` 里的 `ai.presets.wanjier.system_prompt` 复制到 VPS 的 `config.json` 对应位置。

知识库一定会被调用：`enable_knowledge=true` 且 `knowledge_force_style=true` 时，每次 AI 回复都会先检索 `knowledge/wanjier.md`，再以 `[临场笔记]` 注入直播语态、回复节奏、反应强度和当前话题素材；遇到 CS2、选手、队伍、语录、礼物、切片等关键词时，再额外注入相关片段。模型被要求吸收这些笔记，但不能在群里说“根据知识库/根据素材”。用 `/kb stats` 看 `注入命中`，用 `/status` 看知识库命中计数。

怎么确认“不是只靠 prompt 在演”：先发一条明确 CS/选手/队伍话题，再跑 `/trace last`。里面会显示 `知识分区`、`知识xxx字`、`开头`、`真人停顿` 和最终发送类型；`/status` 会显示最近知识分区、注入命中次数、开头去重和真人停顿统计。如果强触发时 `知识分区: 无命中`，先跑 `/kb stats`，再检查 `knowledge/wanjier.md` 是否存在、是否被 VPS 本地改坏。

真人感短停顿默认开启：普通主动接话会在真正发送前等 `250-1400ms`，@/回复/命令走更短的 `120-650ms`；图片、语音输入、明确要语音和已经排队较久的回复会跳过，避免把慢链路继续拖慢。想临时关闭可在 `.env` 写 `WANJIER_HUMAN_REPLY_DELAY_ENABLED=false`，想更自然可把普通区间调到 `350-1800ms`；线上用 `/trace last`、`/trace recent`、`/status` 或 `/maint status` 看是否生效。

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
/maint status
/trace last
/media daily
今天识图语音跑了吗
/voice status
/kb stats
/kb sources
/quote
```

正常状态大致应该是：

- `/whoami` 的 `当前bot号` 等于 NapCat 登录号。
- `/diag` 没有 AI 接口、知识库、配置硬伤。
- `/status` 里队列没有长期堆积。
- `/maint status` 里 `config_version` 不偏旧，缓存、闸门和真人停顿数字能正常显示。
- `/trace last` 有最近回复时会显示 `真人停顿`、缓存判定和最终发送类型。
- `/media daily` 和“今天识图语音跑了吗”会显示今日实跑、三件套、缺口和优先补项；`check/warm/cache hit` 不算实跑。
- `/voice status` 显示 `STT: on`、`TTS: on`；如果放了样本，克隆应为 `ready`；常用短句可用管理员 `/voice warm <文本>` 先打进缓存。
- `/kb stats` 能看到知识库块数和字数。
- `/kb sources` 能看到来源 fresh/due/never、域名 trusted/risky 和自动写库前置状态。

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
| `config_version` | 配置模板版本，当前为 `20260609`；`npm run doctor` 和 `/maint config` 会用它判断 VPS 配置是否落后 |
| `ws_url` | OneBot WebSocket 地址，通常是 `ws://127.0.0.1:3001` |
| `login_check_interval_seconds` | QQ 登录态主动检查间隔，推荐 `60`；`0` 表示关闭 |
| `login_check_api_timeout_ms` | 登录态检查调用 `get_login_info` 的超时，推荐 `5000` |
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
| `max_tokens` | `1600` | 单次模型输出预算；被模型截断时会自动续写补全 |
| `temperature` | `0.9-0.95` | 推荐偏活一点，降低公式化；太飘再降回 `0.85` |
| `api_timeout_ms` | `120000` | 单次模型请求等待时间，强触发会多次重试；慢接口可继续调高 |

`config.example.json` 里的 `api_key` 是占位值。运行时会把包含“在这里填入”“your api”“example”“placeholder”等占位特征的 key 视为未配置，避免无效请求排进队列后白等超时。

触发与上下文：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `trigger_mode` | `smart` | @/回复/命令必回，普通消息智能触发 |
| `trigger_keywords` | 见示例 | smart 模式关键词 |
| `trigger_probability` | `0.08` | 非关键词、非低信息普通消息随机接话概率；本轮继续降噪，想更安静可降到 `0.04-0.06` |
| `passive_random_min_chars` | `4` | 普通随机接话最短文本长度，过滤“6”等短消息 |
| `passive_random_allow_numeric` | `false` | 普通随机接话是否允许纯数字消息 |
| `related_reply_probability` | `0.65` | CS/知识话题普通消息触发概率；@/回复/命令仍必回 |
| `poke_reply_probability` | `1` | 戳一戳回应概率 |
| `sticker_auto_reply_enabled` | `true` | 普通群聊关键词自动贴纸开关 |
| `sticker_auto_reply_probability` | `0.18` | 命中“白给/开香槟/保枪/老板大气”等关键词后的自动贴纸概率 |
| `sticker_auto_group_cooldown_seconds` | `45` | 同群自动贴纸最短间隔，防止刷屏 |
| `sticker_auto_keyword_cooldown_seconds` | `180` | 同群同关键词自动贴纸冷却 |
| `gift_voice_enabled` | `true` | 礼物感谢满足连送/大额门槛后，允许低频追加 TTS 语音 |
| `gift_voice_probability` | `0.28` | 礼物语音触发概率；文字感谢一定会先发 |
| `gift_voice_cooldown_seconds` | `180` | 同群礼物语音冷却，避免连送时刷语音 |
| `gift_voice_min_combo_events` | `2` | 短窗口连续礼物达到多少次后允许语音 |
| `gift_voice_min_total_count` | `8` | 单次或短窗口累计礼物数量达到多少后允许语音 |
| `cooldown_seconds` | `0-5` | 普通主动接话冷却，@/回复/命令不受限 |
| `human_reply_delay_enabled` | `true` | 真人感发送前短停顿；图片、语音输入、明确要语音和排队较久的回复会自动跳过 |
| `human_reply_delay_min_ms` / `human_reply_delay_max_ms` | `250` / `1400` | 普通主动接话短停顿区间 |
| `human_reply_delay_forced_min_ms` / `human_reply_delay_forced_max_ms` | `120` / `650` | @/回复/命令强触发短停顿区间 |
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
| `ai_reply_cache_seconds` | `45` | 普通主动接话 AI 回复缓存；按风格场景分级，实时/多模态/身份/礼物/纠偏等高上下文场景旁路；缓存 key 会归一化轻微 @ 称呼和标点差异；稳定 CS 战术/残局/道具问题不强制联网，方便短 TTL 命中 |
| `ai_reply_cache_max_entries` | `300` | AI 回复缓存最大条数，LRU 淘汰；小 VPS 可调低降低内存占用 |

知识库：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `enable_knowledge` | `true` | 是否注入 `knowledge/wanjier.md` |
| `knowledge_max_chars` | `2600` | 2G1C 推荐单次注入最大字符数 |
| `knowledge_force_style` | `true` | 每次 AI 回复强制注入直播语态/回复铁律知识块 |
| `knowledge_update_mode` | `reviewed_command` | 允许管理员命令更新 |
| `knowledge_auto_update` | `true` | 后台低频自动刷新 |
| `knowledge_auto_interval_minutes` | `180` | 自动刷新间隔，最低 30 |
| `knowledge_auto_commit_public_facts` | `true` | 自动写入公开事实/短摘要 |
| `knowledge_aggressive_auto_commit` | `true` | 可信公开摘要激进写入 |
| `knowledge_quarantine_long_quotes` | `false` | 兼容旧字段；当前不写隔离区，风险内容进入主库待核验分区 |
| `knowledge_expansion_enabled` | `true` | 启用知识库扩写 |
| `knowledge_expansion_batch_max_sources` | `12` | 手动扩写每批最多来源 |
| `knowledge_auto_batch_max_sources` | `6` | 后台每批最多来源 |
| `knowledge_manual_batch_max_sources` | `10` | 手动刷新每批最多来源 |
| `knowledge_auto_max_block_chars` | `1200` | 自动写入单块最大字符数 |
| `knowledge_auto_log_retention_days` | `14` | 自动日志保留天数 |

RAG 记忆：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `enable_memory_retrieval` | `true` | 是否启用当前会话轻量历史召回 |
| `memory_top_k` | `4` | 每次最多召回几条相似历史，设为 `0` 可只保留上下文不注入 RAG |
| `memory_min_similarity` | `0.18` | 召回最低相似度，越高越保守 |
| `memory_inject_max_chars` | `700` | 注入模型的相关历史最大字符数，设为 `0` 可禁止注入 |
| `memory_max_messages_per_session` | `700` | 每个会话最多索引多少条历史 |
| `memory_max_sessions_in_memory` | `80` | 最多把多少个会话索引留在内存 |

并发与 2G1C：

| 字段 | 推荐值 | 说明 |
|---|---:|---|
| `max_group_queue` | `5` | 同群普通主动接话队列上限，强触发不丢 |
| `gate_passive_queue_max` | `20` | 全局闸门普通任务最大排队数，强触发不受此限制 |
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
| `vision_payload_mode` | `auto` | 自动尝试多种识图请求格式 |
| `vision_max_images` | `2` | 单次最多处理图片数 |
| `image_cache_max_mb` | `512` | 图片缓存上限，70GB 存储推荐值 |
| `image_cache_max_file_mb` | `2` | 单图下载最大大小 |
| `image_cache_max_age_hours` | `72` | 图片缓存过期时间 |
| `image_download_max_redirects` | `3` | 图片下载最多跟随跳转次数 |
| `image_cache_cleanup_interval_minutes` | `30` | 图片缓存定期清理间隔 |
| `image_cache_max_files` | `5000` | 图片缓存最大文件数 |
| `enable_stt` | `true` | 开启 QQ 语音输入听写 |
| `stt_model` | 按供应商填写 | 支持音频输入/听写的模型 |
| `stt_provider` | `auto` | `api`、`local` 或 `auto` |
| `stt_payload_mode` | `auto` | 远端听写 payload，`auto` 会尝试 `input_audio` 和 `audio_url` |
| `stt_record_format` | `mp3` | NapCat `get_record` 的输出格式；opaque `file` 语音会先转成该格式再听写 |
| `stt_local_command` | 空或本地命令 | 本地听写命令，读取 `QQBOT_STT_INPUT`，输出文本 |
| `stt_local_timeout_ms` | `15000` | 本地听写超时 |
| `stt_max_records` | `1` | 单条消息最多听写几段语音 |
| `stt_max_file_mb` | `4` | 单段语音下载最大大小 |
| `stt_timeout_ms` | `20000` | 听写 API 超时 |
| `stt_cache_hours` | `24` | 听写文本缓存保留时间 |
| `stt_cache_max_mb` | `128` | 听写缓存最大容量 |
| `stt_cache_max_files` | `3000` | 听写缓存最大文件数 |
| `enable_tts` | `true` | 开启语音命令和随机语音 |
| `tts_model` | `mimo-v2.5-tts` | 普通 TTS 模型 |
| `tts_provider` | `auto` | `api`、`local` 或 `auto` |
| `tts_local_command` | 空或本地命令 | 本地 TTS 命令，读取 `QQBOT_TTS_TEXT`，写入 `QQBOT_TTS_OUTPUT` |
| `tts_local_output_dir` | `voice_cache/local` | 本地 TTS 输出缓存目录 |
| `tts_local_timeout_ms` | `15000` | 本地 TTS 超时 |
| `tts_clone_model` | `mimo-v2.5-tts-voiceclone` | 克隆 TTS 模型 |
| `tts_clone_enabled` | `true` | 是否尝试使用授权样本克隆 |
| `tts_sample_path` | `voice_sample.mp3` | 授权样本路径，相对项目根目录或绝对路径 |
| `tts_voice_prompt` | 见示例 | 语音风格提示 |
| `tts_max_chars` | `80-120` | 单条语音最大字符数 |
| `tts_send_mode` | `base64` | 语音发送方式；Docker NapCat 推荐 `base64`，避免容器读不到宿主机文件 |
| `tts_timeout_ms` | `20000` | 语音 API 超时 |
| `tts_cache_hours` | `24` | 语音缓存保留时间 |
| `tts_cache_max_mb` | `512` | 语音缓存最大容量 |
| `tts_cache_max_files` | `3000` | 语音缓存最大文件数 |
| `tts_sample_max_mb` | `8` | 样本最大大小 |
| `tts_probability` | `0.05-0.10` | 普通主动接话语音概率 |

## 克隆语音配置

语音克隆只适合使用你有权使用的参考音频。不要把生成结果声称为现实主播本人语音，也不要用未经授权的素材做公开分发。

推荐路线是“本地授权语音引擎优先，API 兜底”：你先在 VPS 或另一台机器上用有权使用的声音样本训练/准备本地 TTS 模型，再让 bot 调用本地命令。这样速度更快，失败点更清楚，也不会每次都把语音请求发到远端接口。

当前支持三种提供方：

| 字段值 | 行为 |
|---|---|
| `tts_provider: "api"` | 只走远端 TTS / voiceclone API |
| `tts_provider: "local"` | 只走本地 TTS 命令 |
| `tts_provider: "auto"` | 先走本地 TTS 命令；本地失败后走远端 API |

STT 听写同理：

| 字段值 | 行为 |
|---|---|
| `stt_provider: "api"` | 只走远端音频输入/听写模型 |
| `stt_provider: "local"` | 只走本地听写命令 |
| `stt_provider: "auto"` | 先走本地听写命令；本地失败后走远端 API |

本地模式不要求 TTS/STT API 可用，但普通 AI 对话和识图仍然需要 `api_url`、`api_key`、`model`。

远端 MiMo TTS 当前按官方 OpenAI 兼容接口发送：

- 普通模型：`mimo-v2.5-tts`，默认内置音色。
- 克隆模型：`mimo-v2.5-tts-voiceclone`，当 `voice_sample.mp3` 可读时把样本以 `data:audio/...;base64,...` 放到 `audio.voice`。
- 输出格式：默认请求 `audio.format=mp3`，bot 会把返回音频保存到 `voice_cache/` 再用 OneBot 的 `record` 段发送。
- 发送格式：默认 `tts_send_mode=base64`，发送 `base64://...` 给 NapCat；这对 Docker 部署最稳，因为容器不需要读取 PM2 所在宿主机的 `voice_cache/` 文件。
- 只有当 NapCat 与 bot 在同一文件系统、并且确认能读取本地文件时，才考虑把 `tts_send_mode` 改成 `file`。
- 兼容兜底：如果供应商兼容层调整，bot 会依次尝试 v2.5 官方格式、无 `format` 格式、旧 `system/user/assistant` 格式，并在 `/voice status` 显示 `最近TTS模式`。

参考官方文档：`https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api?target=request-body`

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

本仓库根目录默认读取 `voice_sample.mp3`，这个文件已被 `.gitignore` 忽略，不会被推送到 GitHub。

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

### 3. 本地授权 TTS 引擎接入

先在外部语音引擎里完成授权声音模型的准备。本项目不绑定某个训练框架，只要求你的本地命令满足一个简单协议：

- 输入文本在环境变量 `QQBOT_TTS_TEXT`。
- 输入文本文件路径在 `QQBOT_TTS_TEXT_FILE`。
- 目标输出文件路径在 `QQBOT_TTS_OUTPUT`。
- 授权参考样本路径在 `QQBOT_TTS_VOICE_SAMPLE`，没有样本时为空。
- 命令成功后必须生成 `wav`、`mp3`、`ogg` 或 `m4a` 文件，路径可以写到 `QQBOT_TTS_OUTPUT`，也可以把最终路径打印到 stdout 最后一行。

示例 wrapper：

```bash
cd /opt/wanjier-bot
cp scripts/local-tts.example.sh local-tts.sh
nano local-tts.sh
chmod +x local-tts.sh
```

`local-tts.sh` 示例：

```bash
#!/usr/bin/env bash
set -euo pipefail

TEXT_FILE="${QQBOT_TTS_TEXT_FILE:?missing text file}"
OUT="${QQBOT_TTS_OUTPUT:?missing output path}"
SAMPLE="${QQBOT_TTS_VOICE_SAMPLE:-}"

# 这里换成你已经训练好的、且有权使用的本地语音引擎命令。
# 下面只是形状示例，不同引擎参数名不一样。
python3 /opt/local-tts/infer.py \
  --text-file "$TEXT_FILE" \
  --voice-sample "$SAMPLE" \
  --out "$OUT"

echo "$OUT"
```

`config.json`：

```json
{
  "ai": {
    "enable_tts": true,
    "tts_provider": "auto",
    "tts_local_command": "/opt/wanjier-bot/local-tts.sh",
    "tts_local_output_dir": "voice_cache/local",
    "tts_local_timeout_ms": 15000,
    "tts_probability": 0.10
  }
}
```

测试：

```bash
pm2 restart wanjier --update-env
pm2 logs wanjier --lines 80 --nostream
```

也可以不进 QQ，直接在 VPS 上跑一次真实 TTS：

```bash
cd /opt/wanjier-bot
npm run build
WANJIER_API_KEY='替换成你的真实API密钥' npm run voice:test -- "这波语音链路测试一下"
```

成功时会输出生成的音频路径、大小、提供方、克隆样本状态和最近 TTS 模式。失败时会输出 `lastError`，优先按下面“常见语音问题”排查。

群里：

```text
/voice status
/voice test 这波本地语音先跑一下
```

`/voice status` 里如果看到 `TTS提供方: auto local-ready`，说明 bot 已经识别到本地命令。`最近错误` 如果出现 `local tts failed`，优先检查 wrapper 的路径、权限、Python 环境、模型路径和输出文件。

### 4. 本地 STT 听写接入

本地听写命令协议：

- 输入音频文件路径在 `QQBOT_STT_INPUT`。
- 输出文本文件路径在 `QQBOT_STT_OUTPUT`。
- 音频 MIME 在 `QQBOT_STT_MIME`。
- 原始来源在 `QQBOT_STT_SOURCE`。
- 命令成功后可以写 `QQBOT_STT_OUTPUT`，也可以把听写文本打印到 stdout。

示例 wrapper：

```bash
cd /opt/wanjier-bot
cp scripts/local-stt.example.sh local-stt.sh
nano local-stt.sh
chmod +x local-stt.sh
```

`local-stt.sh` 示例：

```bash
#!/usr/bin/env bash
set -euo pipefail

IN="${QQBOT_STT_INPUT:?missing input}"
OUT="${QQBOT_STT_OUTPUT:?missing output}"

# 这里换成你的本地听写引擎，例如 whisper.cpp、FunASR、sherpa-onnx 等。
# 下面只是形状示例。
python3 /opt/local-stt/transcribe.py \
  --input "$IN" \
  --output "$OUT"

cat "$OUT"
```

`config.json`：

```json
{
  "ai": {
    "enable_stt": true,
    "stt_provider": "auto",
    "stt_local_command": "/opt/wanjier-bot/local-stt.sh",
    "stt_local_timeout_ms": 15000,
    "stt_max_records": 1
  }
}
```

测试：

```text
/voice status
/voice stt <语音URL>
```

`/voice status` 里如果看到 `STT提供方: auto local-ready`，说明本地听写命令已被识别。

### 5. 语音输入听写

语音输入是“收到 QQ 语音后先尝试听写，再把听写结果塞进当前消息快照”。它只影响理解语音内容，不影响强触发必回。

注意点：

- `enable_stt=true` 后才会听写语音。
- `stt_model` 必须填写供应商支持音频输入或听写的模型。
- QQ 语音常见是 `amr` 或 `silk`。如果服务器安装了 `ffmpeg`，bot 会尝试转成 mp3 再听写。
- NapCat 事件里如果语音段只有 `file` 没有 `url`，bot 会自动调用 `get_record`；`stt_record_format=mp3` 会让 NapCat 优先吐出 mp3，后面再交给本地或远端 STT。
- `get_record` 返回 URL、本地路径、`base64://...` 或 `data:audio/...;base64,...` 都能识别；Docker 部署不需要手工映射语音缓存目录。
- 如果供应商不支持当前音频请求格式，`@` 仍会引用原消息回复，只是不会假装听懂语音内容。
- 2G1C 推荐 `stt_global_concurrency=1`、`stt_max_records=1`，避免多人同时发语音把队列堵死。
- 如果配置了 `stt_provider=auto` 且 `stt_local_command` 有效，会先走本地听写，本地失败再走远端 API。

安装转码工具：

```bash
apt install -y ffmpeg
```

测试方式：

```text
/voice status
/voice sttcache <语音URL>
/voice stt <语音URL>
@bot 然后发一条语音
```

`/voice status` 里看：

- `STT: on`：语音听写开了。
- `听写模型`：当前用于听写的模型。
- `听写缓存`：缓存命中、下载失败、空转写统计。
- `听写最近错误`：供应商格式不兼容、下载失败、超时等都会显示在这里。
- `/voice sttcache <语音URL>` 只读检查听写缓存 key 和 hit/miss/in-flight/expired，不下载语音、不转码、不调用模型；也可以把语音和 `/voice sttcache` 发在同一条消息里。
- `/voice stt <语音URL>` 会单独测试下载、转码、本地/API 后端和解析整条听写链路，并显示缓存前/后、后端动作、payload 和转写结果；也可以把语音和 `/voice stt` 发在同一条消息里。缓存 hit 只代表已有转写文本可复用，后端 local/API 都没增加时说明本次没有重新听音频。

### 6. 测试语音输出链路

群里发送：

```text
/voice status
/voice test
/voice test 这波语音测试一下
@bot 用语音回复 今天NAVI咋样
用语音回一下 这波怎么说
```

`/voice status` 里重点看：

- `TTS: on`：语音功能开启。
- `TTS提供方`：当前走 `api`、`local` 还是 `auto`。
- `TTS发送`：推荐看到 `base64`；Docker NapCat 如果用 `file`，很容易因为容器读不到宿主机路径而发不出语音。
- `克隆: ready`：样本可用，会走克隆模型。
- `克隆: missing`：样本缺失、太小、太大或路径错误，会降级普通 TTS。
- `最近TTS模式`：最近一次远端请求采用的 payload 格式，例如 `mimo-voiceclone-chat-v25`。
- `最近错误`：最近一次 API、网络、解析或长度错误。

明确说“用语音回复 / 发语音 / voice / tts / say / 念出来 / 读出来”时，会被当成强触发：必须入队、必须尝试发语音。`/voice <内容>`、`用语音回复 <内容>`、`直接用语音念 <内容>`、`念出来 <内容>`、`读出来 <内容>` 会直接把 `<内容>` 交给 TTS 照读，不经过 AI 改写；`用语音回答 <问题>`、`用语音分析 <问题>`、`用语音说说怎么看` 这类才会先让 AI 组织回答，再转成语音。语音发送时只发纯 `record` 段，不带 `reply`，因为 QQ/NapCat 对 `reply + record` 组合兼容性差，容易显示但无法播放。文本超过单条 TTS 长度时会按标点拆成多条语音。如果语音生成失败，才会引用原消息退回文字，开头会说明这次语音没生成出来。

### 7. 常见语音问题

- `sample missing`：检查 `tts_sample_path`，相对路径从项目根目录算。
- `sample too small`：样本小于 1KB，通常是空文件或复制失败。
- `sample too large`：超过 `tts_sample_max_mb`，压缩样本或提高限制。
- `text length out of range`：语音文本超过 `tts_max_chars`。
- `HTTP 401/403`：API key 或供应商权限不对。
- `HTTP 400`：通常是模型名、权限或供应商 TTS payload 不兼容。先看 `/voice status` 的 `最近TTS模式`，再确认 `tts_model`、`tts_clone_model` 和 `voice_sample.mp3`。
- `empty audio response`：接口返回了 JSON 但没有可解析的音频字段，模型可能不支持当前 TTS 请求格式。
- `local tts command missing`：`tts_provider` 是 `local/auto`，但 `tts_local_command` 没填。
- `local tts timeout`：本地语音引擎太慢或模型没加载好，提高 `tts_local_timeout_ms`，或让引擎常驻服务再用 wrapper 调 HTTP。
- `local tts failed`：wrapper 退出码非 0 或没有生成音频，直接在 VPS 上手动执行 wrapper 看 stderr。
- QQ 不显示语音：先确认 `/voice status` 的 `TTS发送` 是 `base64`。语音消息必须是纯 `record`，不能和 `reply` 拼在同一条里。Docker NapCat 不建议用 `file://`，除非容器挂载了同一个 `voice_cache/` 路径并且 NapCat 有读取权限。
- `听写 HTTP 400/422`：多数是供应商不支持当前音频输入格式，换 `stt_model` 或关闭 `enable_stt`。
- `local stt command missing`：`stt_provider` 是 `local/auto`，但 `stt_local_command` 没填。
- `local stt failed`：本地听写脚本没有输出文本，检查模型路径、音频格式和脚本权限。
- `download too large`：语音超过 `stt_max_file_mb`。
- `empty transcript`：模型没听出来或接口返回格式不是当前兼容格式。

### 8. 语音使用建议

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
| 私聊 bot | 独立私聊上下文，默认必回，不占群上下文 |
| `/search <关键词>` | 联网搜索 |
| `/voice <内容>` | 直接把内容交给 TTS 照读 |
| `用语音回复 <内容>` | 直接照读内容，不走 AI 改写，不带引用 |
| `直接用语音念 / 发语音 / 念出来 / 读出来 / voice / tts / say` | 模糊触发语音；带明确内容时直接照读 |
| `用语音回答 / 用语音分析 / 用语音说说怎么看` | 先走 AI 生成回答，再转语音 |
| `/voice status` | 查看 TTS、克隆样本和缓存状态 |
| `/voice check <内容>` | 不生成音频，只预检直读文本的 TTS 可用性、分段、截断、刷屏风险和现实本人/授权语音话术边界 |
| `/voice cache <内容>` | 不生成音频，只预检 TTS 分段缓存 key、hit/miss/in-flight/expired 状态、后端模式和克隆边界 |
| `/voice sttcache <语音URL>` | 不下载语音、不转码、不调用模型，只读预检 STT 听写缓存 key、hit/miss/in-flight/expired 状态；也可同一条消息带语音 |
| `/voice warm <内容>` | 管理员真实预热 TTS 缓存，不调用 AI、不发送 record；用于常用短句提前变 hit |
| `/voice last` | 查看最近一次语音直读/AI转语音的 trace |
| `/voice recent [条数]` | 查看最近多条真实语音发送 trace，排查直读/AI转语音、分段、TTS后端、兜底和失败原因 |
| `/voice test [内容]` | 生成测试语音 |
| `/voice stt <语音URL>` | 真实测试语音听写链路，也可同一条消息带语音；回报缓存前/后、后端 local/API 动作、payload、转写结果和“缓存 hit 不等于重新听过音频”的边界 |
| `/voice clone [URL或附件]` | 安装/查看克隆样本；只适合使用你有权使用的授权样本，生成语音不能说成现实主播本人语音，也不能拿去冒充本人 |
| `/voice clean` | 清理过期语音缓存 |
| `/tts <内容>` | 生成语音 |
| `/say <内容>` | 生成语音 |
| `/style status`、`/style check <文本> [--realtime] [--voice]`、`/style check <文本> || <证据/缓存行>` | 查看风格质量统计；预检模板味、原话误称、假来源、身份冒充、传闻背书、未经证实的实时断言和真实 TTS 分段风险；输出风险等级、证据动作、修复动作、行动建议和 `/cs verify` / `/cs warm` 补证命令，带证据时按 fresh/stale/miss 和排名/阵容/赛果/选手数据等事实类型判断能否报成当前事实 |
| `/media status`、`/media daily`、`/media recent [条数]`、`/media check <图片URL/语音URL或附图附语音>`、`/media warm <图片URL/语音URL或附图附语音>` | 多模态观测：聚合识图、听写、TTS、礼物感谢缓存和最近真实 trace；`daily` 是不下载/不听写/不调模型的每日链路牌，会显示今日识图/听写/发语音三件套、可用链路完成度、优先补哪条、真实成功数和缺口，并说明只有 `/vision test`、`/voice stt`、`/voice test` 成功才算实跑；`check` 只读预检实际传图数量、图片缓存 hit/miss、STT 听写缓存 hit/miss/in-flight/expired、听写上限、截断风险和回复边界；`warm` 会真实预热图片缓存，语音只做 STT 缓存预检 |
| `/vision status` | 查看识图模型、图片缓存和最近错误 |
| `/vision last` | 查看最近一次回复里的真实识图传图数、截断、图片来源类型和图片缓存前后证据 |
| `/vision recent [条数]` | 查看最近多条真实图片回复 trace，排查传图数、截断、来源类型、缓存前后状态和失败原因 |
| `/vision check <图片URL或附图>` | 不下载图片、不调用模型，只预检图片源、截断、payload、图片缓存 hit/miss/in-flight/本地可读、缓存压力和配置风险 |
| `/vision warm <图片URL或附图>` | 真实下载远程图片写入 `image_cache/`，不调用视觉模型、不生成 AI 回复；适合常用图片先预热成 hit |
| `/vision test <图片URL>` | 下载图片并实际调用视觉模型测试，回报缓存前/后状态、模型、payload、可见描述判定和“缓存 hit 不等于已识图”的边界 |
| `/trace last` | 查看最近一次 AI/语音回复从触发到发送的排障 trace，含证据账本、风格场景、实时证据新鲜度、缓存策略/判定链、真实识图传图数和图片缓存证据 |
| `/trace recent [条数]` | 查看最近多条 AI/语音回复链路摘要，排查触发、发送、缓存 hit/miss/bypass/single-flight/丢弃原因、知识、实时证据、识图和语音 |
| `/reset` 或 `/clear` | 清除当前群上下文 |
| `/presets` | 查看预设 |
| `/preset <名称>` | 切换预设 |

知识库：

| 命令 | 权限 | 说明 |
|---|---|---|
| `/quote [关键词]`、`/quote check [关键词]` | 所有人 | 查本地口癖/短句锚点；`check` 只读预检短句池命中、样例、分区和“不是逐字原话”边界；明确索要原话/逐字时会自动加边界 |
| `/scene [场景词]` | 所有人 | 抽直播场景卡，输出触发、反应、判断、短句和禁用边界 |
| `/player <名字>` | 所有人 | 查选手倾向，遇到“最新/阵容/转会/排名”会联网融合 |
| `/team <队伍>` | 所有人 | 查队伍倾向，遇到实时词会联网融合 |
| `/gift <礼物名> [数量]`、`/gift check <礼物> [数量]`、`/gift cache <礼物> [数量]`、`/gift warm <礼物> [数量]`、`/gift status`、`/gift trace`、`/gift recent [条数]` | `warm` 管理员，其余所有人 | 生成礼物感谢拟态模板；预检语音门槛/概率/冷却/TTS 状态和对应语音缓存 hit/miss；管理员可预热同一句谢礼 TTS 缓存但不发送 record、不写礼物 trace；查看运行状态、最近一次和最近多条真实礼物处理，真实礼物语音会记录发送前后 TTS 缓存 key/hit/miss，语音被门槛/冷却/概率跳过时也会记录当时缓存状态 |
| `/kb search <关键词>` | 所有人 | 检索本地知识库 |
| `/kb route <消息>` | 所有人 | 预检这条消息会注入哪些风格包/话题包、预算、CS/事实、礼物、语录、场景、人物/队伍、语音、运维等多路召回、知识分区、时效风险、命中诊断和补素材行动建议，不调用模型 |
| `/kb trust <链接或域名>` | 所有人 | 只读预检来源评级：trusted/known/unknown/risky，以及能否写 public_fact 或只能当摘要线索 |
| `/kb sources [条数\|all]` | 所有人 | 只读体检知识来源：刷新状态、域名可信度、自动写库前置和真实性边界 |
| `/kb stale [条数\|all]` | 所有人 | 只读体检主库时效事实边界，列出疑似旧排名、阵容、转会、赛果、版本/地图池等缺少证据链接、抓取时间或 fresh/stale 边界的知识块，并给出 `/cs verify`、`/cs evidence`、管理员 `/cs warm plan` 补证路线 |
| `/kb stats` | 所有人 | 查看知识库统计 |
| `/kb preview <关键词>` | 管理员 | 联网生成候选，不写主库，候选会预检来源和长引用风险 |
| `/kb import-url <链接>` | 管理员 | 抓标题、来源和短摘要生成候选，不自动写库 |
| `/kb refresh [--aggressive] [关键词]` | 管理员 | 批量刷新公开来源 |
| `/kb audit` | 管理员 | 审计知识库问题，会标出来源评级缺失、实时事实缺少时效提示和未核验原话/长引用风险 |
| `/kb auto on/off/run` | 管理员 | 控制自动刷新 |
| `/kb batches` | 管理员 | 查看自动写入批次 |
| `/kb rollback <batchId>` | 管理员 | 回滚某个自动批次 |
| `/kb inbox [条数\|all]` | 管理员 | 只读体检 `knowledge/inbox/` 本地素材，跳过 README，按长转写、未核验原话、时效事实缺来源、礼物拟态和场景结构给出 ingest/split/drop 建议 |
| `/kb ingest [full]` | 管理员 | 从 `knowledge/inbox/` 生成候选 |
| `/kb list` | 管理员 | 查看待确认候选 |
| `/kb show <ID>` | 管理员 | 查看候选详情 |
| `/kb commit <ID>` | 管理员 | 写入主知识库分层区 |
| `/kb drop <ID>` | 管理员 | 丢弃候选 |

工具和管理：

| 命令 | 说明 |
|---|---|
| `/help`、`/help cs`、`/help daily`、`/help media`、`/help memory`、`/help knowledge`、`/help admin` | 总帮助和主题帮助；功能太多时优先用主题帮助快速找到 CS 证据、每日 CS、语音识图、缓存记忆、知识库和管理命令 |
| `/ping` | 在线检测 |
| `/whoami` | 查看当前 bot self_id、配置 bot_qq、群号、消息 ID |
| `/status` | 运行状态，含队列、缓存、风格场景分布、质量风险和多模态真实链路摘要 |
| `/diag` | 快速严格自检，不消耗 AI token；会探测 `data`、日志、上下文/RAG、搜索/图片/语音/STT 缓存、`voice_cache/local`、知识库和 `knowledge/inbox` 写盘状态 |
| `/data` | 只读实时数据健康度，含 CS 核心事实覆盖 fresh/stale/miss、排名/赛程/阵容/选手/版本分类型覆盖、当前事实判定和补证路线 |
| `/diag live` | 管理员真实联网/写盘/LLM API 探针自检 |
| `/maint plan` | 管理员只读总维护计划，按 P0/P1/P2 串起登录态、配置、写盘、CS fresh/stale、知识库、多模态和缓存行动 |
| `/maint status` | 管理员维护面板：配置版本、队列、缓存、知识库、闸门、内存和多模态真实性边界 |
| `/maint login` | 管理员立即检查 OneBot 连接和 QQ 登录态 |
| `/maint config` | 管理员查看关键运行配置和配置漂移 |
| `/maint storage` | 管理员只读体检运行目录、RAG索引目录、关键 JSON 持久化文件和磁盘空间；missing 只代表未生成，不能当事实结论 |
| `/maint warm plan` | 管理员只读列出最近 trace 里的图片、语音源、TTS 短句和礼物谢礼预热候选，给出缓存状态和下一步命令 |
| `/maint warm apply [all|media|vision|voice|gift] [条数]` | 管理员按最近候选真实预热安全缓存：图片下载写缓存，TTS/礼物生成音频缓存；不会自动听写语音源 |
| `/maint warm cs [all|matches|results|ranking|watch|predict|team <队伍>|player <选手>|match <id>]` | 管理员从维护入口真实预热 CS 实时缓存，默认 `all`；回报 fresh/stale/miss 覆盖、复核入口和事实边界 |
| `/maint warm media|vision|voice|gift ...` | 管理员从维护入口预热多模态热缓存：`media/vision` 只热图片或只读看 STT，`voice/gift` 真实生成 TTS 缓存但不发送语音、不写礼物 trace |
| `/maint clean` | 管理员清理搜索、CS实时、图片、TTS、STT 缓存并跑知识库审计 |
| `/maint gc` | 管理员手动触发 Node GC，需要 PM2 `--expose-gc` |
| `/mem` | 查看当前会话上下文、RAG 索引、检索命中和内存占用 |
| `/mem health` | 只读缓存/内存体检：内存压力、上下文会话、AI 回复、搜索、CS 实时、图片、TTS/STT、RAG、用户画像缓存、知识库命中率、AI 缓存策略 Top、容量建议和清理动作 |
| `/mem plan` | 只读生成 P0/P1/P2 缓存和内存维护计划，按当前会话、RAG、AI 回复缓存、搜索、CS、图片、TTS/STT、知识库风险给出下一步命令和边界；CS stale 较多时会建议先 `/cs cache prune` 再补 fresh 证据 |
| `/mem cache status`、`/mem cache <消息>`、管理员 `/mem cache prune` | 只读查看 AI 回复缓存池整体状态、容量、TTL 分布、命中率、in-flight 和策略 Top；也可预检某条普通主动接话是否会进入回复缓存、归一化 key、当前 key 状态、风格场景、知识签名、搜索/实时旁路原因；支持 `A || B` 对比自然变体是否同 key，真实命中/丢弃原因再用 `/trace recent` 复核；`prune` 只清 expired 回复缓存、保留 fresh 热缓存 |
| `/mem check <消息>` | 只读预检这条消息会召回哪些当前会话 RAG 记忆、相似度、近期加权 score、age、注入预算、旧 CS 实时事实过滤样本、过滤风险和行动建议 |
| `/mem user <QQ号>`、`/mem user drop <QQ号>` | `drop` 管理员 | 只读预检某个用户在当前会话里的上下文/RAG 痕迹；管理员可按用户定点删除刷屏、错事实或跑偏话题记忆，并清掉可能混入旧用户内容的压缩摘要 |
| `/mem recent [条数]` | 查看最近上下文和最近 RAG 索引，定位模型到底看到什么 |
| `/mem search <关键词>` | 检索当前会话相似历史 |
| `/mem drop <关键词>` | 管理员按关键词删除当前会话上下文和 RAG 索引里的噪声记忆，适合清错事实、旧梗刷屏和跑偏话题 |
| `/mem trim [条数]` | 管理员裁剪当前会话记忆，清掉旧摘要，只保留最近 N 条上下文和 RAG 索引 |
| `/mem clear` | 管理员清空当前会话上下文和 RAG 索引，并回报清理前后数量 |
| `/profile`、`/profile set team Vitality/NAVI`、`/profile set player donk`、`/profile set map Inferno`、`/profile set tone 别太凶`、`/profile clear` | 当前群/私聊内的用户自填长期偏好画像；AI 回复会把它作为个性化语气/举例参考，`/trace last` 显示画像注入；画像不能当实时阵容、排名、比分或身份事实 |
| `/time` | 当前时间 |
| `/stats` | 群统计 |
| `/stickers`、`/stickers status` | 查看 QQ 表情/本地贴纸和自动贴纸命中、节流状态 |
| `/face <名字或id>`、`/sticker <名字>` | 直接发送 QQ 经典表情或本地贴纸 |
| `/reload` | 管理员重载配置，并重新应用并发闸门、缓存和知识库后台参数 |
| `/addgroup [群号]` | 管理员加入群白名单 |
| `/rmgroup <群号>` | 管理员移出群白名单 |
| `/ban @人 [分钟]` | 管理员禁言 |
| `/unban @人` | 管理员解禁 |
| `/kick @人` | 管理员踢人 |
| `/title @人 <头衔>` | 管理员设置群头衔 |

## 自动校验

仓库内置 GitHub Actions：每次推送 `main` 或提交 PR，会自动执行 `npm ci`、`npm run build`、`npm run smoke`。`smoke` 会覆盖配置解析、知识库、搜索 single-flight、队列并发、每日 CS、语音直读不走 AI、语音不带引用、`/trace last`、`/trace recent`、`/voice last`、`/voice recent` 等关键行为。

本地提交前建议固定跑：

```bash
npm run build
npm run smoke
```

私聊说明：

- 私聊和群聊上下文完全分离，私聊会话 ID 是 `private_<QQ>`，不会污染任何群的上下文。
- 私聊普通文本默认走 AI 强触发；私聊命令走同一套插件链。
- `/ping`、`/whoami`、`/status`、`/diag`、`/quote`、`/player`、`/team`、`/gift`、`/csplayer`、`/voice`、`/search` 在私聊可用。
- `/stats`、复读机、群禁言、踢人、群头衔等群专属能力只在群聊里执行。
- 私聊消息会记录日志并转发给管理员，真正回复由主插件链生成，避免一条私聊被回两次。
- emoji 不按内容硬过滤；AI 回复里的常见 emoji 会转成 QQ face 段，并限制一条消息里的表情数量。

实时 CS 和日报订阅：

| 命令 | 说明 |
|---|---|
| `/cs brief`、`/csbrief` | 立即查看 CS 短报：当前/即将比赛、最近赛果、排名快照 |
| `/cs today check`、`/cs brief check` | 只读预检今日短报核心缓存：展示赛程/赛果/排名的 fresh/stale/miss、预计实时请求数、旧缓存边界和精确预热命令，不请求外站 |
| `/cs status` | 查看 CS 实时缓存、磁盘缓存、飞行请求、失败数、事实类型覆盖和最近 HLTV 候选页核验缓存；HLTV link-check 只代表页面链路状态，不等于比分/阵容/地图池事实证据 |
| `/cs cache prune`、`/cs prune stale` | 管理员只清理已过期的 CS 事实缓存，保留 fresh 当前快照、飞行请求和 HLTV 候选页核验缓存；prune 不会产生 fresh 证据，之后仍用 `/cs verify` / `/cs warm plan` 补证 |
| `/cs match <matchid>` | 用 `/cs results` 里的 `matchid` 拉 CS API 单场详情、HLTV 比赛页候选核验入口、地图比分、地图池线索、竞猜地图边界、详情/统计链接、每图 MVP/Rating 和选手 Rating/ADR 亮点 |
| `/cs sources`、`/hltv sources` | 只读查看 CS API、HLTV matches/results/ranking、Liquipedia matches/VRS 链接和“HLTV 页面链接不等于官方实时 API”的边界 |
| `/cs evidence all`、`/cs evidence ranking`、`/cs evidence match 2390002`、`/cs evidence 2390002`、`/cs evidence team Vitality` | 查看 CS 数据证据卡：总览/单项来源链接、缓存新鲜度、旧缓存边界；单场证据会显示 HLTV 候选页和最近一次 `/cs hltvcheck` 短 TTL 核验缓存，纯数字会直达单场详情证据 |
| `/cs hltvcheck 2390002`、`/hltv hltvcheck 2390002` | 只读活链路核验 HLTV 比赛页候选，显示 HTTP 状态、最终 URL、可访问/未证明/未找到/被拦判定；短 TTL 结果会显示在 `/cs status`，但不写 CS 事实缓存，不把网页能打开当比分或阵容证据 |
| `/cs verify ranking`、`/cs verify match 2390002`、`/cs verify 2390002`、`/cs verify player donk`、`/cs verify all` | 只读预检某类 CS 当前事实能不能回复成“现在/最新”：fresh 可作当前快照，stale 只能说旧线索，miss 不能反推没有比赛/赛果/变动；`all` 会给赛程/赛果/排名核心覆盖总判定、排名/阵容/选手/版本分类型覆盖、缺口列表和补证路线；纯数字会检查 `match:<id>` |
| `/cs intent <自然语言问题>` | 只读预检这句问法会不会被 CS 实时插件接管、预计命令、缓存键、fresh/stale/miss、证据卡和精确预热命令 |
| `/cs warm`、`/cs warm plan`、`/cs warm matches/results/ranking`、`/cs warm match 2390002`、`/cs warm plan 2390002`、`/cs warm all`、`/cs warm watch`、`/cs warm predict`、`/cs warm team Vitality`、`/cs warm player donk` | 管理员预热 CS 实时缓存；`plan` 只读预估 fresh/stale/miss、预计请求数、计划覆盖的事实类型、旧缓存边界、精确执行命令和 `/cs verify` / `/cs evidence` 复核入口，真正预热会提前拉取赛程/赛果/排名、单场详情、关注目标和竞猜相关队伍画像，并在预热后回报 fresh/stale/miss、预热后事实类型覆盖与能否当当前快照 |
| `/csreport`、`/csreport focus` | `/csreport` 立即查看完整 CS 每日报：比赛、赛果、排名、热门新闻/转会；会按当前会话 `/watch` 关注目标生成“本群优先看”，再附加关注快照、`/predict` 竞猜摘要和统一数据证据摘要；没有盘口时会列实时可开盘候选，并带 matches fresh/stale/miss 赛程来源边界；`focus` 压成一屏“先看什么 / 盯谁变化 / 竞猜入口 / 证据边界”；基础日报底稿有短 TTL 缓存和 single-flight，完整日报、focus 和同轮推送会共享底稿；定时推送前会自动预热核心实时缓存 |
| `/csreport on 09:30` | 当前群/私聊每天 09:30 推送 CS 日报 |
| `/csreport time 09:45` | 修改当前会话日报时间 |
| `/csreport status` | 查看当前会话日报订阅和最近推送 |
| `/csreport check`、`/csreport due` | `check` 只读预检日报订阅、关注/竞猜预热目标、竞猜核心 matches/results 缓存、缓存 fresh/stale/miss、计划事实类型覆盖、旧数据边界和精确 `/cs warm plan ...` / `/cs warm ...` 建议；`due` 由管理员执行一次真实定时检查/预热/推送 |
| `/csreport off` | 关闭当前会话日报 |
| `订阅CS日报 09:30` | `/csreport on 09:30` 的自然语言触发 |
| `/watch team Vitality`、`/watch player donk`、`/watch match NAVI` | 订阅队伍/选手/赛程赛果变化提醒；`team` 识别阵容新增/移出和地图样本胜率变化，`player` 识别 Rating/ADR/KAST/KD 变化，`match` 会在关注队伍即将开赛时发一次去重开赛提醒；日报会自动带上当前会话关注目标摘要 |
| `/watch list`、`/watch plan`、`/watch now`、`/watch remove <id>` | 管理 CS 变化订阅；`plan` 只读预检当前会话订阅、核心/队伍/选手预热目标、fresh/stale/miss、计划事实类型覆盖、预计请求数和旧数据边界，不拉外站、不写订阅、不发提醒 |
| `/predict matches` | 读取实时赛程链路，列出可开盘的比赛候选，并显示竞猜赛程事实类型覆盖、matches 缓存 fresh/stale/miss、`/cs verify matches` / `/cs evidence matches` / `/cs warm plan matches` 边界；没解析到候选时也会标明不能反推今天没有比赛或没有赛程 |
| `/predict open NAVI vs Vitality bo3 event IEM Cologne close=30m` | 管理员开一个 CS 竞猜盘口，可附加赛事维度 |
| `/predict open NAVI vs Vitality bo3 mappool Inferno/Mirage close=30m` | 管理员开盘时附加地图池/veto 线索；单图 `map Inferno` 会进入地图统计，多图只作为盘口线索，并会在开盘、列表、日报竞猜摘要和 `/cstrain` 里显示地图池边界 |
| `/predict matchmap 2390002` | 读取 CS API 单场详情里的 `match.maps`，生成竞猜单图/地图池预检、竞猜事实类型覆盖、开盘参数和 `/cs verify` / `/cs evidence` / `/cs hltvcheck` 补证入口；不写盘口、不写积分，也不把地图池线索说成 HLTV 官方 veto |
| `/predict veto Inferno Mirage Nuke`、`/predict mapcheck map Inferno` | 只读预检地图池/veto 文本会被结构化解析成单图/多图、统计归属、推荐开盘/下注参数和数据来源边界；不联网、不写盘口/积分，不把人工输入当 HLTV 官方 pick-ban |
| `/predict openmatch 1 close=30m` | 管理员用实时赛程候选一键开盘，会自动继承实时赛程解析到的赛事名和明确地图/地图池线索，并在开盘结果或找不到候选时保留赛程来源 fresh/stale/miss 边界 |
| `/predict notify on 90m` | 管理员开启当前会话赛前开盘候选自动提醒；没开盘且实时赛程有候选时推送，并带竞猜赛程事实类型覆盖和 matches fresh/stale/miss 边界；`/predict notify check` 没候选时也会保留解析失败边界 |
| `/predict A 2-1 map Inferno`、`/predict <id> B 2-1` | 参与胜负和比分预测，可附加地图维度；比分按自己选择的队伍在前 |
| `/predict list`、`/predict board week/month/season/all`、`/predict map Inferno`、`/predict event IEM Cologne`、`/predict settle <id> A 2-1` | 查看盘口/总榜/周榜/月榜/赛季榜/地图榜/赛事榜，管理员手动结算 |
| `/predict season start 夏季赛`、`/predict season board`、`/predict season archive`、`/predict season list` | 管理员开启/归档命名赛季；`/predict board season` 会优先显示当前命名赛季，没有命名赛季时仍显示近 90 天滚动榜 |
| `/predict autosettle` | 管理员读取近期赛果，自动匹配并结算当前会话未结算盘口；结算会记录赛果标签和来源证据，`/predict list`、日报竞猜摘要和后台提醒都会展示；人工/后台自动结算都会带 results fresh/stale/miss 边界，没解析到比分或没匹配到盘口时也会标明不能反推没有赛果 |

自然问法：看到 `/cs results` 里的 `matchid` 后，可以直接说 `2390002这场谁C了`、`matchid=2390002 这场详情`；普通群聊会走 `/cs match <matchid>`，并在回复末尾自动附“事实预检”，标出目标缓存是 fresh/stale/miss、能不能当当前快照、该跑哪个 `/cs verify` / `/cs evidence` / `/cs warm plan`。`/ai ...` 也会把单场详情注入实时事实参考后再让模型回答；如果 AI 路径只有旧快照、部分缺口或没有当前快照，最终发送前会追加自然“事实边界”，并给出精确 `/cs verify ...` 和管理员 `/cs warm plan ...` 补证命令。单场详情里的 `HLTV比赛页候选` 和 `HLTV搜索入口` 只供人工交叉核验，不等于 bot 读取了 HLTV 官方实时 API；真实 HLTV 比赛页可能需要 slug，候选页打不开时用搜索入口或 `/cs sources` 里的 HLTV matches 总页核对。要确认候选页当前能不能打开，可以跑 `/cs hltvcheck <matchid>`，它只检查网页链路和 HTTP 状态，不写 CS 事实缓存，也不能替代 `/cs evidence` / `/cs verify` 的 fresh/stale/miss。旧的 `match:<id>` 缓存命中时也会在返回前补这些核验入口，不需要为了补链接重刷外站。

趣味：

| 命令 | 说明 |
|---|---|
| `/roll [N|NdM]` | 掷骰子，支持 `2d6` |
| `/luck` | 今日运势 |
| `/jrrp` | 今日人品 |
| `/daily now`、`/daily me`、`/daily personal`、`/daily proof`、`/daily score`、`/daily center`、`/daily desk`、`/daily squad`、`/daily group`、`/daily vibe`、`/daily relay`、`/daily ice`、`/daily topic`、`/daily script`、`/daily kit`、`/daily gap`、`/daily line`、`/daily plan`、`/daily guard`、`/daily streak`、`/daily media`、`/daily voice`、`/daily nudge`、`/daily missing`、`/daily week`、`/daily recap`、`/daily challenge`、`/daily done`、`/daily wrap`、`/daily challenge board`、`/daily checkin`、`/daily board`、`/daily on 09:00`、`/daily status`、`/daily off` | 每日低频今日状态/自然问候；订阅后每天按当前群/私聊固定时间推送，不调用 AI token；`now`/定时推送会直接带识图语音今日实跑摘要，`me` 查看自己的打卡、挑战完成、榜单名次、识图语音今日实跑和下一步，`personal` 按当前会话自填用户画像给每日偏好卡，包含今日打法、聊天口吻、看图引子、语音短句和画像真话边界，`proof` 是今日证据账本，会区分挑战、打卡、识图、听写、发语音哪些有真实记录、哪些只是建议或缓存，`score` 把挑战、打卡、识图、听写、发语音合成今日闭环分和一分钟补法，`center`/`desk` 是一屏今日指挥台，汇总个人缺项、群队形、识图语音脚本、破冰动作和收尾入口，`squad`/`group` 查看当前群/会话每日队形，汇总今日挑战、打卡、双收、扛旗用户和你的缺项，`vibe` 给每日聊天节奏，列出开场、接图、接语音、贴纸分寸、收住规则和真话边界，`relay` 给识图语音每日接力，分看图位、听写位、发声位和验收位，让群里按真实 trace 跑完三件套，`ice`/`topic` 给今日破冰话题，包含群聊选择题、看图接力、语音接力和个人缺项提示，`script`/`kit` 给识图语音每日脚本包，列出看图、听写、发声、验收和群里回执，`gap` 按今日真实 trace 告诉你识图/听写/发语音三件套还缺哪条和优先补什么，`line` 给每日语音台词，包含主句、短回声、群里接话、预检、管理员预热、真测和听写反查，`plan` 给今日行动安排，串起挑战、打卡、识图语音三件套和晚间收尾，`guard`/`streak` 是保连续短催卡，会告诉你现在先补挑战、打卡还是识图语音，`media`/`voice` 给识图语音今日陪跑卡，包含看图问法、听写真测、语音短句、预检和真测命令，`nudge`/`missing` 按今天缺项短催一下、回答“我今天还差啥”，但不写记录，`week` 汇总最近 7 天双收/挑战/打卡日历并附今天识图语音实跑摘要，`recap` 手动生成晚间复盘卡并带当前用户挑战/打卡收尾状态和识图语音真实链路收尾，`challenge` 给当前用户一张当天稳定的今日挑战卡，`done` 记录挑战完成、连续完成天数和累计次数并提示识图语音下一步，`wrap` 一次记录挑战完成和每日打卡并引导跑 `/daily media` 小闭环，`challenge board` 查看当前会话挑战完成榜，`checkin` 记录当前群/私聊的每日打卡、连续天数和累计次数并提示识图语音下一步，`board` 查看当前会话打卡榜；多模态每日链路牌看 `/media daily` |
| `/csplayer` | 每日 CS 选手，按 QQ、群、日期固定抽取，带选手图和短评 |
| `/csplayer status` | 查看当前签位、图片缓存、专属美图池是否达到每个对象 200 张 |
| `/dailyimage audit`、`/dailyimage status`、`/dailyimage cache`、`/dailyimage template` | 全量审计、状态、清单缓存和待补摘要，检查选手/战队/刀皮/木柜子/原神等是否各自 200 张起 |
| `/csimage test all` | 实测每日 CS、木柜子、原神等分支能不能成功发图 |
| `/今日选手` | `/csplayer` 中文别名 |
| `/csteam` | 每日 CS 队伍，带队伍图和打法短评 |
| `/csmap` | 每日 CS 地图 |
| `/csweapon` | 每日 CS 武器 |
| `/csrole` | 每日 CS 定位 |
| `/csutility` | 每日 CS 道具 |
| `/cstactic` | 每日 CS 战术 |
| `/csclutch` | 每日 CS 残局 |
| `/csloadout` | 每日 CS 套餐，组合队伍、地图、武器、定位 |
| `/csquiz`、`/csquiz answer A` | 每日 CS 小考/挑战，按本地每日卡池生成题目和每日稳定洗牌选项；`answer`/`答` 可提交 A/B/C 判分、看解析和真话边界 |
| `/cstrain` | 每日 CS 训练计划，按当天地图、武器、定位、道具、战术生成练枪/道具/复盘任务；有竞猜积分、训练历史和日志短板时会附加个人建议 |
| `/cstrain analyze Mirage 死亡8次 补枪距离太远 没闪` | 只读分析一段对局/训练文字日志，识别死亡、补枪、道具、急停预瞄等短板，并给出写入 `/cstrain log` 的建议命令 |
| `/cstrain log 30 Mirage AK 急停` | 记录一次训练；也支持 `/cstrain log 道具 20 Inferno 烟闪`，日志文字会参与短板统计 |
| `/cstrain stats`、`/cstrain clear` | 查看近 14 天训练分布，或清空当前会话自己的训练记录 |
| `/choose A,B,C` | 随机选择 |
| `/rand [min] [max]` | 随机数 |

识图/语音/多模态诊断也支持自然触发：`识图状态`、`语音状态`、`多模态状态`。
多模态每日牌也支持自然触发：`识图语音每日牌`、`今日三件套`、`识图语音三件套`、`多模态日报`、`今日多模态状态`。
每日提醒也支持自然触发：`今日状态`、`我的每日`、`今日偏好`、`我的画像`、`今日证据账本`、`今天跑没跑`、`今日闭环分`、`今日完成度`、`今日指挥台`、`今日看板`、`今日队形`、`群每日`、`今日聊天节奏`、`今日语气`、`今日接力`、`群接力`、`识图语音接力`、`今日话题`、`群破冰`、`识图语音脚本包`、`识图语音缺啥`、`今日三件套缺啥`、`今日语音台词`、`今日语音句`、`今日安排`、`保连续`、`别断签`、`识图语音陪跑`、`催我一下`、`我今天还差啥`、`本周每日`、`今日复盘`、`今日挑战`、`挑战完成`、`今日收工`、`挑战榜`、`今日打卡`、`打卡榜`、`晚安机器`。

每日 CS 系列说明：

- 同一个群友在同一个群同一天抽到同一结果，不同群独立，第二天刷新。
- 每日选手、战队、地图、武器、枪皮、定位、道具、战术、残局、发刀、木柜子、原神、冷知识、书摘、古诗词、紫禁之巅都优先读取 `data/daily-beauty-images.json` 的专属美图池；每个具体对象建议 200 张起。
- 枪皮和刀皮按“武器/刀型 + 皮肤名”成对匹配，图片不会跨功能、跨对象混用；缺图时再走专用授权清单、公开图片接口和日签图。
- 图片发送前会先下载进本地图片缓存，再以 `base64://` 发给 QQ；图片失败时仍返回文字，不会让命令像“没反应”。
- 输出包含 @、标题、语境、指数、今天打法、别急点、机器短评，排版尽量短而清楚。
- `/csquiz` 输出本地每日小考，包含题型、场景、题目、选项、参考判断和真话边界；它用于训练判断和整活，不冒充实时赛事事实。
- `/cstrain` 输出本地每日训练建议，包含强度、练枪、地图道具、定位目标和复盘项；若当前会话有 `/predict` 结算积分，会附加胜率/精准率、地图样本和赛事样本驱动的个人判断训练提示；若你用 `/cstrain log` 记录过训练，会按近 14 天练枪/道具/复盘/实战分布和文字日志里的死亡、补枪、道具、急停预瞄等短板调整建议；若你设置过 `/profile` 队伍/选手/地图偏好，会把它作为训练侧重点和举例参考，但不当作实时阵容/排名/状态事实；`/cstrain analyze <文字日志>` 只读分析你发的文本，不读取 demo/截图，也不冒充实时赛事事实。
- 队伍字段写的是“队伍语境”，不是永久阵容。用户问“最新在哪队/最近状态”时应走 `/player 最新 <名字>` 或直接 @ 提问触发联网。
- 输出走本地逻辑，不调用 AI；真实图解析有短超时和缓存，不影响 @ 必回队列。
- 当前签位图片状态用 `/csplayer status` 看；全量对象覆盖用 `/dailyimage audit` 看；`/dailyimage status/cache/template` 看状态、缓存和待补摘要。VPS 日常只跑 `npm run update`，脚本会自动写 `data/daily-beauty-images.todo.json`。
- 设计参考了常见“每日老婆/每日抽取”类 bot：当天固定、返回头像和昵称；本项目改成 CS 主题卡池，适配群聊和玩机器语态。

每日 CS 模糊触发词：

| 功能 | 精确命令 | 模糊触发示例 |
|---|---|---|
| 每日选手 | `/csplayer`、`/今日选手`、`/每日选手`、`/抽选手` | `今天抽个CS选手`、`抽个职业哥`、`每日哥们`、`今天抽谁`、`来个cs选手` |
| 每日队伍 | `/csteam`、`/今日队伍`、`/每日队伍`、`/抽队伍` | `今天抽个CS队伍`、`来个战队`、`今日主队`、`队伍签` |
| 每日地图 | `/csmap`、`/今日地图`、`/每日地图`、`/抽地图` | `今天抽个CS地图`、`今日哪张图`、`地图签` |
| 每日武器 | `/csweapon`、`/今日武器`、`/每日武器`、`/抽武器` | `今天用什么枪`、`来个枪械`、`武器签` |
| 每日定位 | `/csrole`、`/今日定位`、`/每日定位`、`/抽定位` | `今天打什么位`、`今日位置`、`定位签` |
| 每日道具 | `/csutility`、`/csnade`、`/今日道具`、`/抽道具` | `今天丢什么道具`、`来个投掷物`、`道具签` |
| 每日战术 | `/cstactic`、`/csstrat`、`/今日战术`、`/抽战术` | `今天打什么战术`、`今日怎么打`、`战术签` |
| 每日残局 | `/csclutch`、`/今日残局`、`/每日残局`、`/抽残局` | `今天残局怎么打`、`来个残局签` |
| 每日套餐 | `/csloadout`、`/cspack`、`/csdaily`、`/今日cs`、`/每日cs`、`/今日套餐` | `今日cs`、`今天cs`、`今天怎么打`、`今天打啥`、`来个CS套餐` |
| 每日小考 | `/csquiz`、`/cschallenge`、`/cs小考`、`/cs问答`、`/cs挑战` | `来个CS小考`、`今天考我CS`、`今日CS题`、`CS挑战` |
| 每日训练 | `/cstrain`、`/cstrain analyze`、`/cstrain log`、`/cstrain stats`、`/cspractice`、`/cs训练`、`/练枪任务` | `今天怎么练枪`、`来个CS训练`、`给我安排CS训练`、`今天练什么道具` |

触发设计：

- 模糊触发必须同时像“每日/今日/抽/今天/来个”和“CS 主题词”，避免普通聊天全被抽签抢走。
- `/player NiKo`、`NiKo 现在在哪队`、`NAVI 最新阵容` 不会进入抽签，会走知识库和联网事实融合。
- `今日cs` 这种短句默认返回每日套餐，因为它本身就是抽签类需求。

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

旧版本遗留目录：

```text
knowledge/quarantine/
```

当前版本不再向该目录写入。所有公开事实、短摘要、拟态模板、待核验语料都进入 `knowledge/wanjier.md` 的分层区域，并用来源、置信度、核验状态和内容类型管理风险。

### 本地检索

```text
/kb search NiKo
/kb search 礼物感谢
/quote 公式解说
/quote 玩机器原话逐字来一句
/player m0NESY
/team G2
```

### 联网预览

```text
/kb preview 玩机器 6657 公式解说
/kb preview HLTV Top 20 players 2025 ZywOo donk ropz
/kb import-url https://www.hltv.org/
```

`preview` 和 `import-url` 只生成候选，不写主库。URL 导入只保留标题、来源和短摘要，适合把 HLTV、Liquipedia、官方公告等公开链接变成待审核事实入口；公开事实/带时效词的公开摘要会自动补“快照时间”和“时效边界”，提醒后续回答最新排名、阵容、赛果、版本或地图池前必须走 `/cs verify`、`/cs evidence` 和 fresh 实时证据。

### 批量刷新

```text
/kb refresh
/kb refresh --aggressive 玩机器Machine 萌娘百科 6657
/kb refresh --aggressive HLTV team ranking 2026 Vitality Spirit Falcons
```

刷新规则：

- `public_fact`：可信公开事实，满足条件时自动写入。
- 可信 `public_summary`：`--aggressive` 或 `knowledge_aggressive_auto_commit=true` 时可自动写入短摘要。
- `unknown`：礼物原话、疑似长转写、切片台词，默认只生成候选；手动确认后进入主库待核验分区。
- 长句、疑似原话、礼物感谢完整话术不写隔离目录，只能以摘要、短摘、拟态模板或待核验语料写入主库。
- 后台自动刷新会读取 `sources.json` 的 `intervalMinutes`，只跑到期来源；手动 `/kb refresh` 不受间隔限制。
- 来源上次自动刷新时间记录在 `knowledge/source-state.json`，这是运行产物，默认不提交。
- 每个候选都会标出来源评级：`trusted` 代表 HLTV、Liquipedia、Valve、CS API 等可信域名，`known` 代表 B站、YouTube、微博等已知平台，`unknown` 和 `risky` 默认挡住自动写入，必须人工看完 `/kb show` 再决定。
- 公开事实和带时效词的公开摘要候选会自动携带快照时间、时效边界和 `/cs verify` / `/cs evidence` 复核要求；自动写入主库后也保留这些边界，避免旧排名/阵容/赛果被包装成实时结论。
- `/kb preview`、`/kb import-url`、`/kb show` 和 `/kb list` 会带“自动质量闸”和“行动建议”，直接提示该 commit、补来源、摘要化还是 drop。
- 候选质量闸和 `/kb audit` 会扫描“这是玩机器原话/逐字/经典语录/本人说过/名场面台词/一字不差/完整字幕”等未核验声称；没有已核验证据时会要求改成拟态模板、短摘要或场景锚点。
- 候选质量闸也会拦多行引号、时间轴、主播/弹幕对话式长引用；即使没写“原话”，也会提示先压成“场景/短摘要/可用话术/禁用边界”。
- `/kb stale` 会只读扫描主库里带“最新/当前/排名/阵容/转会/比分/赛程/版本/地图池”等时效词的事实块，提示缺少证据链接、抓取时间或 fresh/stale/旧快照边界的风险，并按排名、赛果/赛程、阵容/转会、版本/地图池给出 `/cs verify`、`/cs evidence`、管理员 `/cs warm plan` 补证路线；`/kb route` 和真实回复 trace 会把实际命中的风险分区标出来，输出后处理也会在缺少对应 fresh 证据时把排名/阵容/赛果/版本断言降级，修完前这些块只能当历史线索，不能当实时结论。

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
/kb inbox
/kb ingest
/kb ingest full
/kb list
/kb show <候选ID>
/kb commit <候选ID>
```

先跑 `/kb inbox` 做只读素材体检；看到 `split-first` 就先拆成“场景、摘要、可用话术、禁用边界”，看到 `needs_source` 就补来源或降级为本地授权摘要。`/kb ingest full` 适合较长素材，但仍建议整理成“场景、摘要、可用话术”，不要把整段直播转写无脑塞入主库。

## 知识库准确性边界

- 公开网页没有可靠原文时，不写成“经典原话”。
- `/quote` 输出的是口癖/短句锚点，不是本人原话库；要补真实素材先走 `/kb inbox` 和 `/kb ingest`。
- 礼物感谢默认是拟态模板，不是核验原话。
- B站标题和搜索摘要只能当切片索引，不当完整证据。
- HLTV、Liquipedia、Valve、官方公告优先级高于二手摘要。
- 自动写库会检查证据链接域名：公开事实必须来自 `trusted` 来源，公开摘要至少要 `known` 来源；本地、内网或未知域名只进候选，不会悄悄进主库。
- 导入前可以先跑 `/kb trust <链接或域名>`，它只按域名预检 trusted/known/unknown/risky，不联网、不写候选；`known` 平台适合摘要索引，`unknown/risky` 不能包装成核验事实。
- 队伍阵容、转会、排名、赛果、版本更新必须联网确认。
- 实时事实参考会把缓存 fresh/stale/miss 和来源线索直接注入模型；如果只剩 stale/旧缓存，只能说成线索或旧快照，不能包装成“刚查最新/实时结论”；miss 也不能说成“没有比赛/没有赛果”。AI 最终回复若遇到旧快照或无当前快照，会额外追加自然事实边界和对应 `/cs verify` / `/cs warm plan` 补证入口；如果证据账本显示 fresh 与 stale/miss/旧 RAG 过滤混在一起，发出前还会压掉“全部最新/可以报死/我刚查了HLTV”这类过度来源口吻。事实覆盖会按类型拆开判断：排名 fresh 只支撑排名，不能顺手支撑阵容/转会、赛果/赛程或选手近期数据。`/trace last` 的 `证据账本` 会把当前事实、实时证据、知识、RAG、画像、识图/听写和事实修正压成一行，方便确认这条回复靠什么说。
- 模型输出如果用“听说/朋友说/群里都说/爆料说”给 CS 转会、阵容、排名、比分背书，会被后处理改成可靠来源边界；即使旁边有 fresh 缓存，也不能把群聊/朋友/爆料当来源，要按证据文本明确覆盖的事实说。
- 不复制长视频转写、完整切片台词或平台内容大段文本；多行长引用要先拆成场景判断和短摘要。
- 普通问是不是 bot/机器人时按第一人称嘴硬接住，不助手式自曝；追问现实主播本人、授权、代表本人、本尊关系时才说明边界。

## 人格和活人感

- 日常聊天按第一人称直播接弹幕，不主动声明“我是 bot”或“下面用玩机器风格”。
- 普通问“你是不是 bot/机器人/AI”时嘴硬带过去；只有被明确问授权、本人关系、现实代表性时，才说明这是群里的风格 bot，不是现实主播本人。
- 口癖不是固定模板。`可以的`、`先别急`、`这波有说法` 可以用，但不能连续机械复读；更多时候直接给判断更像真人。
- 每次回复都会优先检索知识库里的“低攻击活人感、语录纠错、直播语态、选手/队伍倾向、场景模板”，再把当前消息发给模型。
- 普通闲聊短，CS2/赛事/选手话题才展开；攻击性默认 `medium`，会更敢抓离谱操作和理解，想更凶可设 `WANJIER_AGGRESSION=high`，但仍只喷操作/逻辑/理解。
- 括号舞台说明会被后处理清掉，例如“（直播口吻）”“【玩机器风格】”这类不会发到群里。

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
- recordUrls
- repliedMessageId
- contextSnapshot
- triggerReason

模型提示中会显式写入“当前要回复的是谁、哪条消息、触发类型”。强触发默认引用原消息回复，避免回错人。

上下文存储会带上 `mid` 和 `uid`，例如 `[mid=123 uid=456] 张三: ...`。模型能看到当前发送者最近几句和最近群发言定位，但硬规则仍是只回答当前 `message_id` 的这条消息。

如果当前消息带 `reply` 段，模型会看到被引用的历史消息 ID，但发送仍引用当前触发消息，避免“看懂了引用却回到旧消息下面”的错位。

回复 bot 的旧消息时，系统先用内存追踪 bot 发出的消息 ID；如果进程重启导致追踪丢失，会用 OneBot `get_msg` 短超时兜底检查原消息发送者，尽量避免“明明回复了 bot 但没有触发”。

### 队列和背压

- 同群按消息顺序 FIFO。
- 跨群可以并发，多群同时 @ 会同时进入全局 AI 闸门。
- 全局 AI/搜索/识图/TTS 受闸门限制。
- @/回复/命令强触发永远入队，不受每分钟次数上限、普通冷却和普通队列上限影响。
- 强触发在全局 AI 闸门中优先于普通主动接话；多个强触发之间保持到达顺序。
- 普通主动接话在同群队列满时跳过，避免长期运行刷屏和堆积。
- 关键词/知识话题普通消息会按 `related_reply_probability` 抽样；“这把/这局/经济/道具/补枪/残局/回防”等 CS 软讨论也按该概率抽样；剩余普通消息才按 `trigger_probability` 抽样。
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
    "knowledge_max_chars": 2600,
    "search_timeout_ms": 1200,
    "api_timeout_ms": 120000,
    "search_cache_max_entries": 1000,
    "ai_reply_cache_seconds": 45,
    "ai_reply_cache_max_entries": 300,
    "vision_max_images": 2,
    "image_cache_max_mb": 512,
    "image_cache_max_file_mb": 2,
    "image_cache_max_age_hours": 72,
    "image_download_max_redirects": 3,
    "image_cache_cleanup_interval_minutes": 30,
    "image_cache_max_files": 5000,
    "enable_stt": true,
    "stt_model": "你的音频输入模型",
    "stt_payload_mode": "auto",
    "stt_max_records": 1,
    "stt_max_file_mb": 4,
    "stt_timeout_ms": 20000,
    "stt_cache_hours": 24,
    "enable_tts": true,
    "tts_probability": 0.10,
    "tts_max_chars": 120,
    "tts_cache_hours": 24,
    "trigger_probability": 0.08,
    "related_reply_probability": 0.65,
    "aggression_level": "medium",
    "passive_random_min_chars": 4,
    "passive_random_allow_numeric": false,
    "poke_reply_probability": 1,
    "max_group_queue": 5,
    "gate_passive_queue_max": 20,
    "ai_global_concurrency": 3,
    "search_global_concurrency": 3,
    "vision_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "knowledge_auto_batch_max_sources": 6,
    "knowledge_manual_batch_max_sources": 10,
    "knowledge_expansion_enabled": true,
    "knowledge_expansion_batch_max_sources": 12,
    "knowledge_quarantine_long_quotes": false
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
    "gate_passive_queue_max": 10,
    "max_group_queue": 3,
    "ai_global_concurrency": 1,
    "search_global_concurrency": 2,
    "vision_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "knowledge_auto_batch_max_sources": 3,
    "knowledge_manual_batch_max_sources": 6,
    "knowledge_expansion_batch_max_sources": 6
  }
}
```

## 验证和测试

每次改代码后：

```bash
npm run doctor
npm run build
npm run api:test
npm run data:test
npm run smoke
```

`doctor` 是本机/VPS 预检，不需要 QQ 在线，也不需要连接 NapCat。它会检查 `config.json`、`config.example.json`、`dist/index.js`、知识库、缓存目录写入权限、`data/` 运行数据父目录、`context_store/embeddings` RAG 索引目录、`voice_cache/local` 本地 TTS 输出目录、`knowledge/inbox` 素材收件箱、API Key 是否仍是占位值、`src` 是否比 `dist` 新、2G1C 并发配置是否过高。默认只有“硬伤”会返回非 0；如果想让风险项也阻断部署，可以跑 `node scripts/doctor.js --strict`。

`api:test` 会读取 `.env` 和 `config.json`，真实请求一次 OpenAI 兼容 Chat Completions 接口。只有它显示 `[api:test] OK`，群里的 `/ai` 和 @ 对话才算真的通了；如果失败，它会直接提示是 key、模型名、API 地址还是 VPS 网络问题。

`smoke` 覆盖：

- `config.example.json` 新字段解析。
- 知识库加载和审计。
- 自动写入、批次日志、rollback。
- 来源刷新状态：刚刷过的来源跳过，过期/未刷来源进入下一批，并验证 batch limit。
- 全局并发闸门，包括 AI、搜索、识图、语音听写和语音输出。
- 搜索 single-flight。
- 消息级回复定位：连续三条不同用户 @ 必须分别引用对应 `message_id`。
- 回复 bot 旧消息：通过 OneBot `get_msg` 兜底识别，并引用当前触发消息回复。
- 私聊消息链路：私聊 `/ping`、私聊 AI 强制回复、私聊每日 CS 选手出图。
- 表情后处理：AI 的常见 emoji 会转 QQ face，整条消息会限制表情数量。
- 示例配置的占位 API Key 不会被误判为可用。

当前仍需要人工或线上压测覆盖的点：

- 真实 NapCat/QQ 网络下的 `reply` 段兼容性。
- 5 个以上活跃群同时 @ 时的供应商 API 限速表现。
- STT 供应商是否兼容 `input_audio` 或 `audio_url` 请求格式；不兼容时强触发仍会文本兜底。
- TTS 供应商返回格式变化后的语音可播放性。
- 公开搜索结果质量；实时比赛/转会仍先看 `/data` 的 CS 事实覆盖，再以 `/diag live` 和来源链接为准。

上线后手动检查：

```text
/whoami
/status
/diag
/diag live
/voice status
/voice test
/kb stats
/kb sources
/kb audit
/kb refresh --aggressive 玩机器Machine 萌娘百科 6657
/kb batches
```

可选本地维护命令：

```bash
npm run doctor
npm run cache:clean
npm run stt:test -- <语音URL或本地文件>
```

线上群内维护命令：

```text
/reload
/maint plan
/maint status
/maint login
/maint config
/maint storage
/maint warm plan
/maint warm apply voice 3
/maint warm cs
/maint warm media <图片URL/语音URL>
/maint warm voice <常用短句>
/maint warm gift <礼物> [数量]
/maint clean
/maint gc
```

- `/reload` 会重新读取 `config.json`，并立即重新应用 AI/搜索/识图/STT/TTS 全局并发、搜索缓存容量、图片缓存上限、知识库自动刷新配置。改普通配置后不用重启，除非你换了环境变量、Node 参数或 PM2 配置。
- `/maint plan` 是只读总维护 runbook，按 P0/P1/P2 把登录态、配置版本、API Key、写盘、CS fresh/stale、知识库、内存队列、多模态和缓存容量串成下一步命令。
- `/maint status` 是轻量维护面板，适合看队列是否堵住、知识库是否命中、缓存是否膨胀、配置版本是否偏旧。
- `/maint login` 会立即调用 OneBot `get_login_info` 检查 QQ 是否真的在线，并显示 WebSocket 断开次数、早断次数、心跳重连次数和最近错误。经常掉登录时优先跑这个。
- `/maint config` 专门看关键配置漂移，升级后第一时间跑它。
- `/maint storage` 会只读检查运行目录、RAG 索引目录、关键 JSON 持久化文件和磁盘空间；它只写临时探针并删除，不清缓存、不联网、不调用模型。`missing` 文件只代表还没生成或刚清理，不能反推没有比赛、订阅、训练或画像。
- `/maint warm plan` 只读扫描最近真实 trace，列出可预热的图片 URL、语音源、TTS 短句和礼物谢礼，附缓存 hit/miss/disabled 状态和下一步命令；它不下载、不听写、不生成 TTS。
- `/maint warm apply [all|media|vision|voice|gift] [条数]` 会按候选真实预热安全缓存：`vision/media` 下载图片进缓存，`voice/gift` 生成或复用 TTS 缓存；它不会自动下载并听写语音源，STT 仍要逐条 `/voice stt <语音URL>`。
- `/maint warm cs` 会从维护入口真实执行 CS 实时缓存预热，默认等价于预热 `all`，也可指定 `matches/results/ranking/watch/predict/team/player/match`；预热后仍要看 `/cs verify`、`/cs evidence` 的 fresh/stale/miss，不能把 stale/miss 当实时事实。
- `/maint warm media|vision` 复用多模态预热：图片会真实下载进 `image_cache/`，语音只读检查 STT 缓存，不听写、不调用模型；命中只代表缓存可复用，不代表已经看图或听到语音。
- `/maint warm voice|gift` 会真实生成或复用 TTS 缓存，但不调用 AI、不发送 `record`，礼物预热也不写礼物 trace/节流；克隆/授权样本不能说成现实主播本人语音。
- `/maint clean` 会清理搜索、CS实时、图片、TTS、STT 缓存，修剪知识库自动日志，并跑一次知识库审计。只想移除 CS 过期事实快照时优先用 `/cs cache prune`，它会保留 fresh 当前快照和 HLTV link-check。
- `/maint gc` 只做手动内存回收；PM2 的 `ecosystem.config.js` 已经带 `--expose-gc`，如果你不是用这个文件启动，需要把该参数补上。

私聊手动检查：

```text
私聊 bot 发送 /ping
私聊 bot 发送 /whoami
私聊 bot 发送 今天抽个CS选手
私聊 bot 发送 你好，今天怎么看NAVI
```

预期：

- `/ping` 直接返回 `pong`。
- `/whoami` 显示 `私聊: 是`，不会强行显示群号。
- “今天抽个CS选手”返回文字和选手图片，没有 @ 段。
- 普通私聊文本会进入 AI 独立上下文，和群上下文互不污染。
- 回复中不会出现 `😂`、`🤣` 或“笑哭”。

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
npm run api:test
curl -I https://你的接口域名
```

`curl -I` 只能说明域名大致能连，不能证明模型可用。真正排聊天问题优先看 `npm run api:test`；它失败时按输出里的 `HTTP 401`、`HTTP 404/model`、`超时/网络` 处理。

#### 9. 看实时日志定位

开一个窗口：

```bash
pm2 logs wanjier --lines 0
```

然后群里发 `/ping`。如果日志完全没出现群消息，说明消息没进 bot，查 NapCat。
如果日志出现群消息但没有回复，查插件报错或白名单。
如果 `/diag` 提示 AI 接口未配置或仍是占位值，查 `config.json` 和 `.env` 里的 `WANJIER_API_KEY`。
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

### 经常掉登录或显示 QQ 已下线

先记住一句：PM2 显示 `online` 只能说明 Node 进程还活着；Docker 显示 `Up` 只能说明 NapCat 容器还活着。QQ 号是否真的在线，要看 NapCat 登录态和 OneBot `get_login_info`。

群里或私聊管理员账号先跑：

```text
/maint login
/status
/diag live
```

判断方式：

- `OneBot: open connected=yes`，但 `QQ登录: 异常`：NapCat 还连着，QQ 号大概率掉线，需要进 WebUI 扫码或重新登录。
- `OneBot: closed/none connected=no`：bot 没连上 OneBot，先查 NapCat WebSocket、3001 端口和容器。
- `早断` 连续增加，日志里反复 `code=1006/socket hang up/ECONNRESET`：常见原因是 NapCat 没完成登录、QQ 掉线、OneBot 配置没生效、端口映射错。
- `QQ登录号不匹配`：`config.bot_qq` 和 NapCat 实际登录号不是同一个。换号必须重登 NapCat，只改 `config.json` 没用。

VPS 上看 NapCat 登录日志：

```bash
docker logs --tail 300 napcat | grep -iE "login|登录|offline|下线|error|qrcode|webui|token|扫码|二维码" || true
docker logs napcat 2>&1 | grep -iE "webui token|User Panel Url|token" | tail -20
```

如果日志出现 `Login Error`、`未配置回退密码`、二维码登录提示，或者长时间没有成功登录信息，就去 WebUI：

```text
http://你的服务器IP:6099/webui?token=日志里看到的token
```

打不开 WebUI 时先确认端口：

```bash
docker ps | grep napcat
ss -lntp | grep 6099 || true
```

`docker ps` 里应该能看到：

```text
0.0.0.0:6099->6099/tcp
```

如果没有 6099 映射，需要按部署章节重建 NapCat 容器。WebUI 能打开后，在页面里确认 QQ 账号是否在线；不在线就扫码重新登录。

重登后的验证顺序：

```bash
cd /opt/wanjier-bot
pm2 restart wanjier --update-env
pm2 logs wanjier --lines 80 --nostream
```

然后群里发：

```text
/maint login
/ping
/whoami
```

预期：

- `/maint login` 显示 `QQ登录: ok`。
- `/ping` 能直接回，不依赖 AI。
- `/whoami` 的 `当前bot号` 等于你要用的机器人 QQ。

如果 QQ 经常被挤下线，重点检查：

- 同一个 QQ 是否还在手机、电脑、旧 VPS、旧 NapCat 容器上登录。
- 是否同时跑了多个 `napcat` 容器或多个 OneBot 客户端。
- VPS 时间是否明显不准：`timedatectl` 看时区和 NTP。
- Docker 是否因内存重启：`docker inspect napcat --format '{{.RestartCount}}'`。
- 是否频繁重启容器导致 QQ 风控。改 OneBot 配置后重启一次即可，不要反复刷重启。

本项目现在会每 `login_check_interval_seconds` 秒主动调用一次 `get_login_info`。推荐保持：

```json
{
  "login_check_interval_seconds": 60,
  "login_check_api_timeout_ms": 5000
}
```

不建议把间隔调得太低，30 秒以下会给 NapCat API 增加无意义压力；也不建议设成 `0`，否则 QQ 掉线只能靠人工看日志发现。

### @ 了不回复

1. 群里发 `/whoami`，确认 `当前bot号` 是 NapCat 登录号。
2. 检查 NapCat `messagePostFormat` 是否为 `array`。
3. 看 `/diag` 是否提示 AI 接口未配置。
4. 确认 `api_key` 不是示例里的占位值；占位 key 会被诊断为未配置。
5. 看 `/status` 队列是否长期堆积。
6. 跑 `/trace last` 或 `/trace recent`，看最近一次/最近多次强触发是否进入队列、是否调用 AI、是否最终发送文本/语音兜底。
7. 如果设置了 `enabled_groups`，确认群号在白名单；直接 @ 或回复 bot 理论上仍会放行，普通消息才受白名单影响。

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
3. 图片 URL 必须能由服务器访问；如果 NapCat 事件只有 `file`，bot 会自动调用 `get_image`，并兼容 URL、本地路径和 base64 返回。
4. 单图超过 `image_cache_max_file_mb` 会被图片缓存层拒绝；2G1C 示例默认 2MB，1G 降级档建议 1MB。
5. 群里跑 `/vision status` 看缓存命中、失败次数和最近错误。
6. 先跑 `/vision check <图片URL>` 或把图片和 `/vision check` 发同一条消息；它不下载图片、不调用模型，只看图片源、截断、payload、图片缓存 hit/miss/in-flight/本地可读、缓存压力和配置风险。
7. 常用远程图片可跑 `/vision warm <图片URL>` 先下载进 `image_cache/`，它不调用视觉模型；再跑 `/vision check` 应该能看到 hit。
8. 再跑 `/vision test <图片URL>`；它会显示缓存前/后、下载结果、模型、payload 和可见描述判定。下载 OK 但模型失败，说明是模型/API 兼容问题；下载失败，说明是外链、代理或文件大小问题；缓存 hit 只代表文件可复用，只有下载 OK 且调用 OK 才代表本次模型拿到了图片输入。
9. 也可以把图片和 `/vision warm` 或 `/vision test` 发在同一条消息里；前者只预热图片缓存，后者直接测试 NapCat `get_image` 兜底链路和模型调用。
10. 强触发里如果图片没吃到，跑 `/vision last`、`/vision recent` 或 `/trace last` 看 `识图错误`、实际输入图片数、传给模型的图片数、`vision_max_images` 截断、URL/本地/base64 来源类型和图片缓存前后状态；`/vision status` 也会带最近一次识图摘要和最近记录数量。现在下载失败、缓存失败、模型调用失败都会进 trace，不再静默吞掉；缓存 hit/inline/local-readable 只说明图片源可用或可复用，是否真正进模型以“识图: 已传图”为准。
11. 同一张图多人同时触发时会走图片 single-flight，同 URL 只下载一次；`/status` 里的图片缓存 `飞行` 数可以看到当前并发下载。

### 语音不可用

1. 确认 `enable_tts=true`。
2. 确认 API 支持当前 TTS 请求格式。
3. 没有 `voice_sample.mp3` 时会走普通 TTS。
4. 强触发默认优先文字引用，普通主动接话才可能随机语音。
5. 跑 `/voice status` 看 `最近错误`、`听写最近错误`、样本状态和缓存命中。
6. 跑 `/voice check <文本>` 先看是否会拆成多条 record、是否可能截断、provider/send 模式是否安全，以及有没有把生成音频说成现实主播本人语音；它不生成音频。
7. 跑 `/voice last` 或 `/voice recent`，确认最近一次/最近多次是 `direct-verbatim` 直读、`ai-voice` AI 转语音，还是 TTS 失败后文字兜底。
8. 跑 `/voice sttcache <语音URL>` 先只读看听写缓存 key、hit/miss/in-flight/expired；确认要真测再跑 `/voice stt <语音URL>`。
9. 跑 `/voice stt <语音URL>` 单独测听写；它会展示缓存前/后、后端 local/API 动作、payload 和转写结果。跑 `/voice test` 单独测 TTS。一个成功一个失败时，按失败那条链路排查。
10. 也可以把 QQ 语音和 `/voice sttcache` 或 `/voice stt` 发在同一条消息里；前者只读查缓存，后者真实测试 NapCat `get_record`、转码、STT payload 和缓存。
11. Docker NapCat 优先保持 `tts_send_mode=base64`。只有确认容器能读宿主机 `voice_cache/` 时，才改成 `file`。
12. `/diag live` 会汇总 TTS/STT provider readiness、payload 模式、缓存容量和最近错误；管理员线上排障优先跑它。
13. 明确语音直读成功时只发纯 `record`，不会拼 `reply`。如果你看到文字兜底，说明 TTS 没生成或 QQ 发送失败，直接看 `/voice last` 或 `/voice recent` 的 `fallback` 原因。

### 每日 CS 不触发或不出图

1. 先跑 `/csplayer`，确认文字里有“今日CS选手”和“签位”。
2. 跑 `/csplayer status`，看当前签位的专属美图池是否达到 `200/200OK`，以及图片缓存命中/失败情况。
3. 跑 `/dailyimage audit`，看全量选手、战队、枪皮、刀皮、木柜子、原神等对象哪些还没达到 200 张。
4. VPS 上只跑 `npm run update`；脚本会构建、自检、审计每日图片池、写 `data/daily-beauty-images.todo.json` 并重启。
5. 跑 `/csteam`、`/csmap`、`/csutility`、`/cstactic`、`/csclutch`、`/csloadout`、`/genshin`、`/cold`、`/book`、`/poem`、`/duel` 分别确认新功能。
6. 如果 QQ 不显示图片，先看 `/csplayer status` 和 PM2 日志里的 `send_group_msg` 是否报错；多数是图片下载、缓存、NapCat 图片发送问题。
7. 长期解决：补 `data/daily-beauty-images.json`，每个具体对象 200 张起，然后在 VPS 跑 `npm run update`。

### 知识库越学越假

1. 跑 `/kb audit`。
2. 用 `/kb batches` 查看最近自动写入。
3. 用 `/kb rollback <batchId>` 回滚错误批次。
4. 把真实素材放入 `knowledge/inbox/`，先跑 `/kb inbox` 体检，再走 `/kb ingest`。
5. 不要把无来源长句写成“真实语录”。

## 更新流程

VPS 正常更新只跑一条命令：

```bash
cd /opt/wanjier-bot
npm run update
```

`npm run update` 会自动备份配置、拉取 `origin/main`、同步配置字段、安装依赖、构建、跑 doctor、跑每日图片池审计、跑 smoke、重启 PM2。以后不要手动拆成 `git pull`、`npm install`、`pm2 restart` 一串命令，避免漏掉构建或审计。

如果 VPS 上 `knowledge/wanjier.md` 有本地改动，先备份并 stash 本地知识库，再跑自动更新：

```bash
mkdir -p backups
cp knowledge/wanjier.md backups/wanjier.vps.$(date +%F-%H%M%S).md
git stash push -m "vps local knowledge before update" -- knowledge/wanjier.md || true
npm run update
```

需要强制对齐远端时再用：

```bash
bash scripts/update.sh --hard
```

需要每日图片池不满 200 张就中止更新时用：

```bash
bash scripts/update.sh --strict-images
```

`scripts/update.sh` 会打印更新前提交、本地 HEAD、远端 HEAD、更新后提交、每日图片审计和 PM2 重启结果。如果末尾显示“本地提交仍未等于 origin/main”，说明 VPS 目录、分支或本地改动还没对齐。

更新脚本还会运行 `node scripts/sync-config.js --apply`，把 `config.example.json` 里新增的字段补到现有 `config.json`，并在 `backups/` 下备份旧配置；不会覆盖你的 `api_key`。如果 `config_version` 落后，它会刷新内置 `wanjier` 预设 prompt，否则 VPS 代码更新了但说话规则还可能停在旧版。手动只同步配置可跑：

```bash
npm run config:sync -- --apply
```

如果你之前已经复制过旧版 `config.json`，本次升级后建议同步这些关键配置：

```json
{
  "config_version": 20260609,
  "login_check_interval_seconds": 60,
  "login_check_api_timeout_ms": 5000,
  "ai": {
    "api_timeout_ms": 120000,
    "temperature": 0.92,
    "trigger_probability": 0.08,
    "related_reply_probability": 0.65,
    "ai_reply_cache_seconds": 45,
    "ai_reply_cache_max_entries": 300,
    "human_reply_delay_enabled": true,
    "human_reply_delay_min_ms": 250,
    "human_reply_delay_max_ms": 1400,
    "human_reply_delay_forced_min_ms": 120,
    "human_reply_delay_forced_max_ms": 650,
    "enable_knowledge": true,
    "knowledge_force_style": true,
    "knowledge_max_chars": 2600,
    "enable_memory_retrieval": true,
    "memory_top_k": 4,
    "memory_min_similarity": 0.18,
    "memory_inject_max_chars": 700,
    "memory_max_messages_per_session": 700,
    "memory_max_sessions_in_memory": 80,
    "enable_vision": true,
    "vision_payload_mode": "auto",
    "enable_stt": true,
    "stt_payload_mode": "auto",
    "stt_record_format": "mp3",
    "enable_tts": true,
    "tts_send_mode": "base64",
    "search_cache_max_entries": 1000,
    "image_cache_max_mb": 512,
    "image_cache_max_files": 5000,
    "tts_cache_max_mb": 512,
    "tts_cache_max_files": 3000,
    "stt_cache_max_mb": 128,
    "stt_cache_max_files": 3000,
    "ai_global_concurrency": 3,
    "search_global_concurrency": 3,
    "vision_global_concurrency": 1,
    "stt_global_concurrency": 1,
    "tts_global_concurrency": 1,
    "gate_passive_queue_max": 20
  }
}
```

还要把 `config.example.json` 里的 `ai.presets.wanjier.system_prompt` 复制到 VPS 的 `config.json` 对应字段。改完后执行：

```bash
npm run doctor
npm run build
npm run smoke
pm2 restart wanjier --update-env
pm2 logs wanjier --lines 80 --nostream
```

如果只是改了 `config.json`，进程已经在线，也可以在群里用管理员账号发：

```text
/reload
/maint config
/maint plan
/maint status
```

`/reload` 会热应用并发、缓存、知识库自动刷新和多模态开关；`/maint config` 如果还提示 `config_version` 偏旧，就跑 `npm run config:sync -- --apply` 后再 `/reload`。

本次升级后建议在 VPS 上额外检查：

```bash
cd /opt/wanjier-bot
git log -1 --oneline
npm run doctor
npm run smoke
pm2 restart wanjier
pm2 logs wanjier --lines 80 --nostream
```

然后在群里发：

```text
/ping
/whoami
/maint plan
/maint status
/maint storage
/maint warm plan
/maint warm apply voice 3
/maint warm cs
/maint warm media <图片URL>
/maint warm voice 兄弟们好
/maint warm gift 烟花 12
/mem recent
/trace recent 3
/media daily
今天识图语音跑了吗
/scene 白给
/csplayer
今天抽个CS选手
戳一戳 bot
@bot 今天抽个CS选手
```

预期：

- `/csplayer` 和“今天抽个CS选手”都返回选手图、昵称、队伍语境、定位和签位分。
- `@bot 今天抽个CS选手` 由本地抽签功能响应，不消耗 AI。
- 戳一戳会返回短口癖，不应该出现括号标签或说明文字。
- 普通 @ 问题仍走 AI，并引用当前消息；`/trace last` 能看到 `真人停顿`，`/status` 能看到平均停顿。
- `/media daily` 能看今日识图、听写、TTS 三件套是否真实跑过。

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
- 礼物感谢和切片长句默认写成拟态模板、摘要或主库待核验语料，不冒充核验原话。

## License

MIT
