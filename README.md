# 玩机器 - QQ 群聊 AI Bot

参考CS2电竞解说主播「玩机器」直播间语感的QQ群聊机器人。像群友一样水群、接话、看图、聊游戏；不冒充现实人物。

**GitHub:** https://github.com/2711944586/qqbot

## 核心特性

- 🧠 **自然聊天** — 参考玩机器直播间和弹幕互动的说话风格
- 👁 **识图能力** — 能看懂群友发的图片并评价（MiMo-V2.5-Pro 原生多模态）
- 📝 **长上下文** — 记住群里最近500条消息，调API时发最近60条
- 🔍 **联网搜索** — 按需快速搜索最新信息（赛事、新闻、价格、切片背景等）
- 🚀 **多群并发** — 所有群并行处理，无锁无限制
- 💬 **引用回复** — 被@或被回复时引用原消息
- 📡 **全量回复** — 所有非空群消息都调API，@/回复/点名必回，应用层无冷却无次数上限
- 🔁 **自动重试** — API调用失败自动重试2次
- 🔊 **语音回复** — 有授权 `voice_sample.mp3` 时使用声音克隆，否则退回普通TTS
- 🛡 **稳定运行** — 异常不崩溃，自动重连，PM2守护

## 技术栈

- **运行环境:** Node.js 20 + TypeScript
- **协议端:** NapCatQQ (Docker) — OneBot v11 WebSocket
- **AI模型:** MiMo-V2.5-Pro (小米，通过 token-plan-cn API)
- **进程管理:** PM2
- **QQ号:** 3853043835

## 架构

```
QQ群 ←→ NapCatQQ(Docker:3001) ←→ 玩机器Bot(Node.js) ←→ MiMo-V2.5-Pro API
                                                      ←→ DuckDuckGo搜索(按需)
```

---

## 部署教程

### 环境要求

- 海外VPS (Ubuntu 22.04, 1核/512MB起)
- Node.js 20+
- Docker
- PM2

### 一、安装基础环境

```bash
apt update && apt upgrade -y
apt install -y curl wget git unzip nano
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2
curl -fsSL https://get.docker.com | bash
```

### 二、部署 NapCatQQ

```bash
mkdir -p /opt/napcat/config

docker run -d \
  --name napcat \
  --restart=always \
  -e ACCOUNT=3853043835 \
  -e NAPCAT_GID=0 \
  -e NAPCAT_UID=0 \
  -p 3001:3001 \
  -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  mlikiowa/napcat-docker:latest

# 扫码登录
docker logs napcat
# 或浏览器打开 http://你的IP:6099
```

登录成功后配置WebSocket：

```bash
cat > /opt/napcat/config/onebot11_3853043835.json << 'EOF'
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

### 三、部署 Bot

```bash
cd /opt
git clone https://github.com/2711944586/qqbot.git wanjier-bot
cd wanjier-bot
npm install
cp config.example.json config.json
nano config.json
```

**config.json 必改项：**

```json
{
  "admin_qq": [2711944586],
  "ai": {
    "api_key": "在这里填入你的API密钥",
    "model": "mimo-v2.5-pro",
    "vision_model": "mimo-v2.5-pro"
  }
}
```

如需语音克隆，把你有权使用的参考音频放到项目根目录并命名为 `voice_sample.mp3`。没有该文件时会自动使用普通男声TTS。

### 四、构建运行

```bash
npm run build
pm2 start dist/index.js --name wanjier
pm2 save && pm2 startup
```

### 五、日常维护

```bash
# 查看日志
pm2 logs wanjier --lines 50

# 更新代码
cd /opt/wanjier-bot && git pull && npm run build && pm2 restart wanjier

# 重启NapCat（QQ掉线时）
docker restart napcat
```

---

## 配置说明

| 字段 | 当前值 | 说明 |
|------|--------|------|
| `api_url` | `https://token-plan-cn.xiaomimimo.com/v1/chat/completions` | API地址 |
| `model` | `mimo-v2.5-pro` | 小米MiMo V2.5 Pro |
| `vision_model` | `mimo-v2.5-pro` | 同上，原生支持图片 |
| `max_tokens` | `512` | 回复最大token(群聊够用) |
| `temperature` | `0.85` | 创造性 |
| `max_context_messages` | `500` | 上下文存储条数 |
| `context_send_messages` | `60` | 每次调API发送的最近消息条数 |
| `trigger_mode` | `all` | 所有非空群消息都调AI |
| `enable_search` | `true` | 是否启用联网搜索增强 |
| `search_timeout_ms` | `1000` | 搜索最多等待毫秒数，超时直接回复 |
| `must_reply_quote` | `true` | @/回复/点名时优先引用回复 |
| `trigger_probability` | `0.45` | smart模式基础触发概率，all模式不使用 |
| `context_expire_minutes` | `120` | 上下文过期时间 |

`enabled_groups: []` 表示全部群启用。全量回复会让每条非空群消息都调用AI，API调用量和费用会明显增加；QQ、NapCat、模型服务商自身仍可能有限流。

**可用模型列表：** mimo-v2.5-pro, mimo-v2.5, mimo-v2-pro, mimo-v2-omni

---

## 可用命令

| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/ai <内容>` | 直接对话 |
| `/ping` | 在线检测 |
| `/status` | 运行状态 |
| `/time` | 当前时间 |
| `/stats` | 群聊统计 |
| `/roll` | 掷骰子 |
| `/luck` | 运势 |
| `/jrrp` | 今日人品 |
| `/choose A,B,C` | 帮选 |
| `/reset` | 清除记忆 |
| `/presets` | 预设列表 |
| `/preset <名>` | 切换人格 |
| `/reload` | 重载配置(管理员) |
| `/ban @人` | 禁言(管理员) |
| `/kick @人` | 踢人(管理员) |

---

## 项目结构

```
src/
├── index.ts              # 入口 + 事件注册
├── bot.ts                # WebSocket连接 + 心跳保活
├── handler.ts            # 非阻塞消息路由
├── types.ts              # TypeScript类型
└── plugins/
    ├── ai-chat.ts        # ★核心：AI对话(上下文/识图/搜索/重试)
    ├── web-search.ts     # DuckDuckGo联网搜索
    ├── admin.ts          # 管理员命令
    ├── fun.ts            # 趣味功能
    ├── help.ts           # 帮助
    ├── ping.ts           # Ping
    ├── poke.ts           # 戳一戳回应
    ├── private-forward.ts # 私聊转发
    ├── recall.ts         # 撤回监控
    ├── repeater.ts       # 复读机
    ├── stats.ts          # 群统计
    ├── status.ts         # 运行状态
    ├── time.ts           # 时间
    └── welcome.ts        # 入群欢迎
```

---

## License

MIT
