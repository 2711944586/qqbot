# 项目架构说明

这份文档给后续维护和继续加功能用。目标是让机器人长期跑在 VPS 上，数据可靠、风格可控、问题可诊断。

## 运行链路

1. `src/index.ts` 加载 `.env` 和 `config.json`，启动 OneBot WebSocket、Web 管理后台和后台任务。
2. `src/handler.ts` 把 OneBot 消息标准化成插件上下文，负责命令解析、@ 检测、引用回复和私聊/群聊分流。
3. 插件按顺序执行：管理、统计、复读、工具、趣味、贴纸，最后由 `ai-chat` 做兜底 AI 对话。
4. AI 回复进入 `src/plugins/ai-chat.ts` 后，会依次处理 STT、识图、联网搜索、HLTV/CS API、知识库、历史记忆、LLM 调用、后处理、TTS 和发送。

## 数据与缓存

- `context_store/`：群/私聊上下文摘要和最近消息，重启后可恢复。
- `context_store/embeddings/`：轻量 RAG 历史索引，每个会话一个 jsonl。
- `knowledge/wanjier.md`：主知识库，适合写风格规则、短摘要、事实锚点、场景模板。
- `knowledge/inbox/`：管理员整理的授权素材入口，经 `/kb ingest -> /kb show -> /kb commit` 写入主库。
- `search_cache/`：联网搜索正/负缓存，减少重复搜索。
- `data/cs-realtime-cache.json`：CS/HLTV 实时数据短期持久化缓存，重启后仍可命中；过期但仍在兜底窗口内的数据会标成 stale。
- `image_cache/`：图片下载缓存，服务识图和每日 CS 图片。
- `voice_cache/`、`stt_cache/`：TTS 输出和 STT 输入缓存。
- `scripts/sync-config.js`：部署后把新配置字段补进现有 `config.json`，保留用户密钥和已有值。

## 上下文与 RAG

- 最近消息走 `ContextManager`，只存纯文本，不存图片 base64，避免内存膨胀。
- 旧消息超过阈值后异步压缩成摘要，队列繁忙时会延后压缩。
- 轻量 RAG 不依赖外部 embedding API，使用中文字符/二元组和英文词特征做相似度召回。
- RAG 注入前会先做近期上下文去重；遇到 CS 实时问法时，还会过滤疑似旧排名、阵容、比分、转会、选手数据等旧实时事实记忆，避免历史片段被模型当成当前证据。稳定战术、道具和残局类记忆仍可保留。
- 运行时可调字段：
  - `enable_memory_retrieval`
  - `memory_top_k`
  - `memory_min_similarity`
  - `memory_inject_max_chars`
  - `memory_max_messages_per_session`
  - `memory_max_sessions_in_memory`
- 排查入口：
  - `/mem` 看当前会话和 RAG 索引状态。
  - `/mem health` 看 AI 回复、搜索、CS 实时、图片、TTS/STT、RAG 和知识库的命中率、容量占用和建议。
  - `/mem recent [条数]` 看最近上下文和最近 RAG 索引，用来定位模型到底看到了什么。
  - `/mem search <关键词>` 查当前会话相关历史。
  - `/trace last` 看最近一条回复实际注入的证据账本、记忆预览、旧 CS 实时事实过滤、知识分区、搜索/识图状态。
  - `证据账本` 会把当前事实判定、实时证据 fresh/stale 数、知识时效风险、RAG 注入/过滤、用户画像和识图/听写真实链路压成一行，并参与发出前 guard：fresh 与 stale/miss/旧 RAG 过滤混在一起时，会压掉“全部最新/可以报死/我刚查了HLTV”这类过度来源口吻；事实覆盖按排名、阵容/转会、赛果/赛程、选手数据、版本/地图池分开判断，排名 fresh 不能支撑未覆盖的阵容或选手数据；`实时新鲜度` 行会把 CS/HLTV 证据里的 `fresh/stale` 缓存行抽出来，stale 只能当线索，不能当实时结论；如果本条只有 stale 证据，后处理会继续按“没有当前实时依据”拦截最新/实时口吻。
  - `风格场景` 行会显示本条回复按“风格纠偏、白给、残局、道具、实时事实、识图/语音”等哪类场景执行，方便调真人感。

## 知识库策略

- 公开事实可以自动写入，但必须带来源和时效提示。
- 切片、直播、礼物感谢相关内容默认只做摘要和场景模板。
- `/kb trust <链接或域名>` 只按域名预检 `trusted/known/unknown/risky`，导入前先判断能否作为公开事实来源。
- `/scene [场景词]` 从主库抽取场景卡，适合把长切片学习结果转成“触发 -> 反应 -> 判断 -> 短句 -> 禁用边界”结构。
- 长段逐字稿只允许管理员放进 `knowledge/inbox/`，并确认来源合法后人工提交。
- 运行回复时禁止暴露“知识库/临场笔记/模板”等内部词。

## CS 实时数据

- 首选 `api.csapi.de` 结构化数据，用于排名、赛果、选手/队伍状态。
- Liquipedia MediaWiki API 负责赛程/排名/图片等兜底，但有 30 秒级限流保护。
- webSearch 是最后兜底，适合查官宣、新闻和网页摘要。
- `/cs status` 会显示 fresh/stale、磁盘命中、single-flight 合并、旧缓存兜底、事实类型覆盖和最近错误；`/status`、`/maint status`、`/data` 会显示最近一次 AI 使用的实时证据摘要。
- `/data`、`/cs status`、`/cs verify all` 会把 CS 事实按当前排名、赛程/赛果/单场、阵容/转会、选手数据、版本/地图池拆开显示覆盖，明确 ranking fresh 不能替代阵容或选手当前状态证据；`/cs warm plan`、`/csreport check`、`/watch plan` 会显示本次计划覆盖哪些事实类型，`/cs warm` 执行后会回报预热后的事实类型覆盖，`/predict matches`、`/predict openmatch`、日报候选摘要和 `/predict notify` 候选提醒会显示/保留赛程候选的 matches 缓存边界，没解析出 TeamA vs TeamB 候选时也会说明不能反推没有比赛或没有赛程；`/predict autosettle` 和后台自动结算提醒会显示/保留近期赛果 results 缓存边界，没解析到比分或没匹配盘口时不能反推没有赛果；`/predict matchmap` 会把单场地图池/竞猜线索限定在 match:<id> 的局部事实范围内。
- `/data`、`npm run data:test`、`/csimage test all` 是主要核验入口。

## 加新功能的建议位置

- 新命令但不需要 AI：优先加到独立插件或 `fun.ts`。
- 需要 AI 上下文/搜索/识图/语音：加到 `ai-chat.ts`，并同步 trace 字段。
- 需要持久化用户/群配置：新增 `data/` 或专门目录，避免写进 `config.json`。
- 需要定时任务：在插件内部暴露 start/stop，跟 `startAiChatBackgroundTasks` 一样可重载。
- 需要后台可观测：同时补 `/status`、`/diag` 或 `/maint status`；多模态/礼物链路要把最近真实 trace 和“未进链路不能当作已看/已听/已感谢”的边界同步进这些面板。

## 下一批推荐实现

- `/watch team <队伍>`、`/watch player <选手>`：订阅赛程、赛果、转会提醒。
- `/predict`：赛前投票和比分竞猜，赛后按结果给群积分。
- `/train today`：按今日地图/武器/定位生成练枪和道具任务。
- `/kb import-url <链接>`：只抓标题、来源、短摘要，生成候选，不自动写长文本。
- Web 管理页：查看最近 trace、知识候选、缓存大小、实时数据健康度。
