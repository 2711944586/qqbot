# 玩机器 - QQ 群聊 AI Bot

一个像真人一样在群里水群、玩梗、接话的 QQ 机器人。核心能力是**自然聊天**——不是冷冰冰的指令机器人，而是一个有活人味的群友。

## 核心能力

- 🧠 **自然聊天** — 像真人一样参与群聊，短句、有梗、会怼人
- 👁 **看图说话** — 能看懂群友发的图片并评价（同一个API接口支持）
- 📝 **长记忆** — 记住最近 200 条群消息，能跟上话题和语境
- 🎯 **智能触发** — @必回 / 关键词触发 / 游戏话题高概率接 / 随机水群
- 🛡 **防刷屏** — 连续回复限制 + 冷却机制 + 短消息过滤
- 💬 **引用回复** — 像真人一样回复某人的消息
- 🎭 **人格切换** — 可切换不同预设人格
- 🎲 **趣味功能** — 掷骰子、抽签、今日人品等辅助玩法
- 👑 **管理功能** — 禁言、踢人、白名单、热重载配置

---

## 触发机制详解

Bot 不是每条消息都回。它会像真人一样判断"该不该说话"：

| 触发条件 | 概率 | 说明 |
|----------|------|------|
| @玩机器 | 100% | 被叫必回 |
| 回复bot消息 | 100% | 人家在跟你说话 |
| 关键词命中 | 100% | 可自定义触发词 |
| 游戏话题 | ~70% | 核心领域，最积极 |
| 争议性讨论 | ~55% | 喜欢掺和"谁强谁弱" |
| 梗/抽象内容 | ~50% | 会接梗 |
| 问句 | ~38% | 有人问就可能答 |
| 情绪表达 | ~35% | "草""笑死"之类会接话 |
| 普通消息 | ~25% | 基础随机 |
| 1-2字废话 | ~3% | 基本不回 |
| 沉默太久 | ~35% | 群里聊了20条它都没说话，会主动冒泡 |

---

## 架构图

```
你的 QQ 群
    ↕ (NTQQ协议)
NapCatQQ (Docker容器，QQ协议端)
    ↕ (WebSocket, OneBot v11)
玩机器 Bot (本项目, Node.js)
    ↕ (HTTPS API)
LLM 大模型 (GPT-4o / DeepSeek 等)
```

---

## 🚀 完整部署教程（从零开始，小白友好）

### 你需要准备的东西

1. **一个 QQ 小号** — 用来当机器人的号（⚠️ 不要用主号，有封号风险）
2. **一台海外 VPS** — 运行 Bot 的服务器
3. **LLM API 密钥** — 提供 AI 能力的接口

---

### 第一步：购买 VPS

推荐（便宜够用）：

| 服务商 | 价格 | 推荐理由 |
|--------|------|----------|
| [RackNerd](https://racknerd.com) | $10-20/年 | 极致便宜 |
| [Vultr](https://vultr.com) | $6/月 | 按小时计费，灵活 |
| [BandwagonHost](https://bandwagonhost.com) | $50/年 | 稳定老牌 |

**最低配置：** 1核 / 512MB内存 / 10GB硬盘
**系统选：** Ubuntu 22.04 LTS（别选其他的，教程全按这个写）

购买完成后你会得到：
- 服务器 IP（例如 `154.12.34.56`）
- root 密码

---

### 第二步：连接服务器

**Windows 用户：**

打开 PowerShell（开始菜单搜 powershell）：
```
ssh root@你的IP地址
```
输入密码（输入时不显示字符，正常的，打完回车就行）。

如果提示 `Are you sure you want to continue connecting`，输入 `yes` 回车。

**Mac 用户：** 打开终端(Terminal)，同上。

**可选工具：** 下载 [FinalShell](https://www.hostbuf.com/t/988.html)（可视化管理，支持拖拽上传文件）

---

### 第三步：安装基础环境

连接上服务器后，**逐行**复制粘贴执行（每行一个回车）：

```bash
# 1. 更新系统包（约1分钟）
apt update && apt upgrade -y

# 2. 安装工具
apt install -y curl wget git unzip nano

# 3. 安装 Node.js 20（约30秒）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 4. 验证安装成功
node -v
npm -v
```

应该看到 `v20.x.x` 和 `10.x.x`。如果报错，重新执行一遍第3步。

```bash
# 5. 安装 PM2（进程守护，让bot在后台运行）
npm install -g pm2

# 6. 安装 Docker（运行 NapCatQQ 需要）
curl -fsSL https://get.docker.com | bash

# 7. 验证 Docker
docker --version
```

---

### 第四步：部署 NapCatQQ（QQ 登录端）

NapCatQQ 是让你的小号能在服务器上"登录QQ"的工具。

```bash
# 创建数据目录
mkdir -p /opt/napcat/config

# 启动 NapCatQQ（⚠️ 把下面的 123456789 改成你的小号QQ号）
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
```

**等待约 30 秒**，然后查看登录二维码：

```bash
docker logs napcat
```

你会看到一个二维码（终端里的字符画）。用**手机 QQ** 扫码登录这个小号。

> 💡 如果看不清二维码：访问 `http://你的IP:6099` 在浏览器里扫码（NapCat WebUI）

扫码成功后会显示登录成功。

---

### 第五步：配置 NapCatQQ 的 WebSocket

登录成功后，需要告诉 NapCat 开放 WebSocket 给我们的 Bot 连接：

```bash
# 查看配置目录里有什么文件
ls /opt/napcat/config/
```

你应该能看到一个 `onebot11_你的QQ号.json` 文件。编辑它：

```bash
# 把 123456789 换成你的QQ号
nano /opt/napcat/config/onebot11_3853043835.json
```

**清空里面的内容**（Ctrl+A 全选，然后 Backspace 删除），粘贴下面的内容：

```json
{
  "network": {
    "websocketServers": [
      {
        "name": "ws-server",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "enableForcePushEvent": true,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": ""
      }
    ]
  }
}
```

保存：`Ctrl+X` → 按 `Y` → 按 `Enter`

然后重启 NapCat：
```bash
docker restart napcat
sleep 5
docker logs --tail 10 napcat
```

看到类似 `[WebSocket] 服务器已启动` 就成功了。

---

### 第六步：部署玩机器 Bot

#### 方式A：从 GitHub 克隆（推荐）

```bash
cd /opt
git clone https://github.com/你的用户名/qqbot.git wanjier-bot
cd wanjier-bot
npm install
```

#### 方式B：从本地上传

在你的**本地电脑**上，把项目打包上传：

```bash
# 在项目目录执行（Windows PowerShell）
tar -czf qqbot.tar.gz --exclude=node_modules --exclude=dist --exclude=config.json .

# 上传到服务器
scp qqbot.tar.gz root@你的IP:/opt/

# 然后 SSH 到服务器
ssh root@你的IP
cd /opt
mkdir wanjier-bot && tar -xzf qqbot.tar.gz -C wanjier-bot
cd wanjier-bot
npm install
```

---

### 第七步：配置 Bot

```bash
# 复制示例配置
cp config.example.json config.json

# 编辑配置
nano config.json
```

**必须修改的地方：**

```json
{
  "ws_url": "ws://127.0.0.1:3001",
  "bot_name": "玩机器",
  "admin_qq": [你的主号QQ],
  "enabled_groups": [],

  "ai": {
    "api_url": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    "api_key": "这里填你的API密钥",
    "model": "MiMo-V2.5-Pro",
    "vision_model": "MiMo-V2.5-Pro"
  }
}
```

逐项说明：

| 配置项 | 填什么 | 说明 |
|--------|--------|------|
| `admin_qq` | `[你的主号]` | 管理员QQ，数字格式 |
| `enabled_groups` | `[]` 或 `[群号]` | 空=所有群生效，填群号=只在指定群 |
| `api_key` | 你的密钥 | 从 token-plan 获取 |
| `model` | `gpt-4o` | 主力模型（聊天+识图都走这个接口） |
| `vision_model` | `gpt-4o` | 识图模型，和model相同即可 |
| `trigger_probability` | `0.25` | 随机触发概率，0.1安静~0.5话多 |
| `cooldown_seconds` | `2` | 冷却时间（秒） |
| `max_context_messages` | `200` | 上下文消息数，越大越耗token |

保存退出：`Ctrl+X` → `Y` → `Enter`

---

### 第八步：构建并测试

```bash
# 编译 TypeScript
npm run build

# 先测试运行（看有没有报错）
node dist/index.js
```

你应该看到：
```
  ╔══════════════════════════════════╗
  ║   玩机器 QQ Bot v2.2            ║
  ║   OneBot v11 · NapCatQQ          ║
  ╚══════════════════════════════════╝

  🤖 名称: 玩机器
  🔗 连接: ws://127.0.0.1:3001
  ...
  [Bot] ✅ WebSocket 连接成功！
```

如果看到"连接成功"，说明一切正常！按 `Ctrl+C` 停止。

**常见错误排查：**
- `WebSocket 错误: connect ECONNREFUSED` → NapCat 没运行好，执行 `docker restart napcat`
- `未找到 config.json` → 你没有复制配置文件
- `API 返回异常` → API Key 填错了

---

### 第九步：正式运行（后台守护）

```bash
# 使用 PM2 后台运行
pm2 start dist/index.js --name wanjier

# 查看运行状态
pm2 status

# 查看实时日志
pm2 logs wanjier

# 设置开机自启（重启服务器也会自动恢复）
pm2 save
pm2 startup
```

**到这里部署就完成了！** 去 QQ 群里试试：

1. `@你的小号` + 任何话 → 应该回复
2. 说带"玩机器"的话 → 应该回复
3. 正常聊天 → 有概率自动接话
4. 发图片 + @它 → 会描述/评价图片
5. `/help` → 显示命令列表

---

### 第十步：日常维护

```bash
# 查看 Bot 日志（最近50行）
pm2 logs wanjier --lines 50

# 重启 Bot（改了配置后）
pm2 restart wanjier

# 重启 NapCat（QQ掉线时）
docker restart napcat

# 更新代码
cd /opt/wanjier-bot
git pull
npm run build
pm2 restart wanjier

# 查看 NapCat 状态
docker ps
docker logs --tail 30 napcat
```

---

## 配置调参指南

### 让 Bot 更话多
```json
{
  "trigger_probability": 0.4,
  "cooldown_seconds": 1,
  "trigger_keywords": ["玩机器", "机器", "bot", "兄弟们", "有没有人", "笑死", "草"]
}
```

### 让 Bot 更安静
```json
{
  "trigger_probability": 0.1,
  "cooldown_seconds": 5,
  "trigger_keywords": ["玩机器"]
}
```

### 省 Token（穷人方案）
```json
{
  "model": "gpt-4o-mini",
  "vision_model": "gpt-4o-mini",
  "max_context_messages": 50,
  "max_tokens": 500,
  "trigger_probability": 0.15
}
```

### 只在特定群生效
```json
{
  "enabled_groups": [123456789, 987654321]
}
```

---

## 可用命令

### 💬 对话
| 命令 | 说明 |
|------|------|
| `/ai <内容>` | 直接对话 |
| `/chat <内容>` | 同上 |
| `@玩机器 <内容>` | @触发 |
| 直接聊天 | 智能触发，有概率回复 |
| `/reset` | 清除记忆 |
| `/presets` | 预设列表 |
| `/preset <名>` | 切换人格 |

### 🎲 趣味
| 命令 | 说明 |
|------|------|
| `/roll [N或NdM]` | 掷骰子 |
| `/luck` | 今日运势 |
| `/jrrp` | 今日人品 |
| `/choose A,B,C` | 帮选 |

### 📊 工具
| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/ping` | 在线检测 |
| `/status` | 运行状态 |
| `/time` | 当前时间 |
| `/stats` | 群聊统计 |

### 👑 管理（仅管理员）
| 命令 | 说明 |
|------|------|
| `/reload` | 热重载配置 |
| `/ban @人 [分钟]` | 禁言 |
| `/unban @人` | 解禁 |
| `/kick @人` | 踢出 |
| `/title @人 <头衔>` | 头衔 |
| `/addgroup [群号]` | 加白名单 |
| `/rmgroup <群号>` | 移出白名单 |

---

## 项目结构

```
qqbot/
├── config.example.json   # 配置示例
├── config.json           # 实际配置（不上传git）
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # 入口
    ├── bot.ts            # WebSocket连接管理
    ├── handler.ts        # 消息路由+插件调度
    ├── types.ts          # 类型定义
    └── plugins/
        ├── ai-chat.ts    # ★ 核心：AI对话（触发/上下文/识图）
        ├── admin.ts      # 管理员命令
        ├── fun.ts        # 趣味功能
        ├── help.ts       # 帮助
        ├── ping.ts       # Ping
        ├── stats.ts      # 群统计
        ├── status.ts     # 状态
        ├── time.ts       # 时间
        └── welcome.ts    # 入群欢迎
```

---

## 常见问题 FAQ

### NapCat 相关

**Q: 扫码后显示登录失败/风控？**
- 海外 IP 对新号风控严格。解决方案：
  1. 先在手机上登录该小号，确认正常使用
  2. 小号先在国内环境登录一次 NapCat，成功后再迁移到海外
  3. 换一个注册时间更长的号
  4. 等 24-48 小时后再试

**Q: 运行一段时间后 NapCat 掉线？**
```bash
docker restart napcat
# 如果需要重新扫码
docker logs napcat
```

**Q: 如何升级 NapCat 版本？**
```bash
docker stop napcat && docker rm napcat
docker pull mlikiowa/napcat-docker:latest
# 重新执行第四步的 docker run 命令
```

### Bot 相关

**Q: Bot 连接不上？**
```bash
# 检查 NapCat 是否运行
docker ps
# 检查 3001 端口
ss -tlnp | grep 3001
# 重启所有
docker restart napcat && pm2 restart wanjier
```

**Q: AI 不回复？**
1. 检查日志：`pm2 logs wanjier --lines 30`
2. 看有没有 `[AI] 调用失败` 的错误
3. 确认 API Key 正确且有余额
4. 确认 `trigger_mode` 是 `smart` 不是 `command`

**Q: 回复太频繁？** 调大 `cooldown_seconds` 和 调小 `trigger_probability`

**Q: 想换模型？** 改 `config.json` 里的 `model` 字段，然后 `/reload` 或 `pm2 restart wanjier`

**Q: 如何彻底关闭识图？** 设置 `"enable_vision": false`

---

## 安全建议

1. **务必使用小号** — 机器人账号有被封风险
2. **config.json 不要上传到 GitHub** — 里面有 API Key（已在 .gitignore 中排除）
3. **设置群白名单** — 避免被拉到奇怪的群
4. **设置 admin_qq** — 只有你能执行管理命令
5. **监控 Token 消耗** — max_context_messages 设太高会烧钱

---

## License

MIT
