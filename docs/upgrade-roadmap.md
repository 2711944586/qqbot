# 长效升级路线

本项目当前已经具备 QQ 群聊触发、上下文、联网搜索、CS 结构化数据、每日 CS 图片、识图、语音、知识库候选和自动刷新。下面是后续继续把机器人做得更好玩、更可靠的路线。

## 已落地重点

- CS 数据：优先 `https://api.csapi.de` 的结构化 JSON，回答中标注 CS API / VRS / 选手统计快照；最近赛果会保留 `matchid`、队伍排名和地图比分，`/cs match <matchid>` 和自然问法“2390002这场谁C了”可拉单场详情、统计链接、HLTV 比赛页候选和搜索入口、地图池线索、竞猜地图边界、每图 MVP/Rating 亮点和总选手 Rating/ADR 亮点，旧 `match:<id>` 缓存返回前也会补 HLTV 核验入口；自然问法会在回复末尾自动附“事实预检”，直接说明目标缓存 fresh/stale/miss、能否当当前快照以及对应 `/cs verify` / `/cs evidence` / `/cs warm plan`；AI 回复也会把该详情注入实时事实参考，最终发送前若只剩旧快照、部分缺口或没有当前快照，会追加自然事实边界和精确 `/cs verify ...`、管理员 `/cs warm plan ...`；Liquipedia 和 webSearch 作为兜底；`/cs sources` 可只读查看 CS API、HLTV 页面和 Liquipedia 链接及官方 API 边界，`/cs evidence all` 可总览核心 fresh/stale 缓存、来源链接和旧缓存边界，`/cs evidence match <id>` 或 `/cs evidence <id>` 可细看单场证据、HLTV 页面候选和最近一次 `/cs hltvcheck` 短 TTL 核验缓存，没核验时明确证据卡不现场请求 HLTV，`/cs hltvcheck <id>` 可只读活链路核验候选页 HTTP 状态、最终 URL 和可访问/未证明/未找到/被拦判定但不写事实缓存，短 TTL 核验缓存会显示在 `/cs status` 和单场证据卡便于排障且仍不等于比分/阵容/地图池证据；`/cs status`、`/data`、`/cs verify all` 都会展示排名/阵容/选手/版本分类型覆盖；`/cs verify <id>` 可直接预检单场事实能不能说成当前快照并给出精确 `/cs warm plan match <id>`、`/cs warm match <id>` 建议，`/cs verify all` 会先给赛程/赛果/排名核心覆盖总判定、排名/阵容/选手/版本分类型覆盖、缺口列表和补证路线，避免用 ranking fresh 顺手支撑阵容或选手当前状态；`/cs intent <自然问法>` 和 `/cs today check` 也会只读显示路由/核心缓存、证据卡和精确预热命令；HLTV 候选页如果需要 slug，就用搜索入口、`/cs hltvcheck` 或 HLTV matches 总页人工核对；管理员可用 `/cs cache prune` 只清 stale CS 事实缓存并保留 fresh、飞行请求和 HLTV link-check，再用 `/cs warm plan matches/results/ranking/match <id>` 只读预估单项是否会命中/刷新、计划覆盖哪些事实类型，并直接看到执行命令、`/cs verify` 和 `/cs evidence` 复核入口，最后用 `/cs warm matches/results/ranking/match <id>`、`/cs warm all/watch/predict/team/player` 预热赛程、赛果、排名、单场详情、关注目标和竞猜相关队伍缓存，预热结果会回报 fresh/stale/miss 覆盖、预热后事实类型覆盖、能否当当前快照和精确复核入口，减少冷启动等待。
- CS 日报：`/csreport on 09:30` 可给当前群/私聊开启每日推送；同一轮多群到期共用一次基础日报构建，并按当前会话 `/watch` 关注目标生成“本群优先看”，自动附加关注目标快照和 `/predict` 竞猜摘要；没有已有盘口/积分时会从实时赛程里列可开盘候选，并带 matches fresh/stale/miss 赛程来源边界；`/csreport focus` 会把同一套数据压成一屏“先看什么 / 盯谁变化 / 竞猜入口 / 证据边界”；基础日报底稿已加短 TTL 缓存和 single-flight，`/csreport now`、`focus` 与同轮推送会复用底稿但仍按会话拼关注/竞猜摘要；`/csreport check` 会只读预检核心/关注/竞猜目标、竞猜核心 matches/results 缓存的 fresh/stale/miss、计划事实类型覆盖，并给出精确 `/cs warm plan ...` / `/cs warm ...` 建议；定时推送前 10 分钟会自动预热核心实时缓存和本会话关注/竞猜相关目标。
- CS 竞猜：`/predict matches` 可读实时赛程候选，并显示竞猜赛程事实类型覆盖、matches 缓存 fresh/stale/miss 与 `/cs verify matches` / `/cs evidence matches` / `/cs warm plan matches` 边界；没解析出 TeamA vs TeamB 候选时会保留同一套边界，并明确不能反推今天没有比赛或没有赛程；`/predict openmatch 1` 一键开盘并自动继承赛事名和明确地图/地图池线索，同时在开盘结果或找不到候选时保留赛程来源边界；`/predict matchmap <matchid>` 会读取 CS API 单场详情里的 `match.maps` 并生成竞猜单图/地图池预检、竞猜事实类型覆盖、开盘参数、`/cs verify` / `/cs evidence` / `/cs hltvcheck` 补证入口，且不写盘口/积分、不冒充 HLTV 官方 veto；`/predict veto Inferno Mirage Nuke` 可只读结构化预检人工 veto/地图池文本的单图/多图、统计归属、开盘参数和来源边界；多图 mappool 会在开盘、盘口列表、日报竞猜摘要和 `/cstrain` 训练提示里标清“只作盘口线索，不自动进入地图榜”；`/predict notify on 90m` 可订阅赛前开盘候选提醒，自动提醒和 `/predict notify check` 会带同一套竞猜赛程事实类型覆盖和 matches fresh/stale/miss 边界；群友提交胜负/比分预测时可附加 `map Inferno`，后台会定时读取近期赛果自动结算并推送积分结果，手动/自动结算都会保存赛果标签和来源证据，自动结算输出和后台提醒会带竞猜赛果事实类型覆盖、results fresh/stale/miss 边界，没解析到比分或没匹配盘口时不能反推没有赛果，`/predict list`、日报竞猜摘要和提醒里可追溯；`/predict board week/month/season` 可看周期榜，`/predict map Inferno` 和 `/predict event IEM Cologne` 可看地图/赛事维度榜；管理员可用 `/predict season start 夏季赛` 开启命名赛季，`/predict season archive` 归档历史赛季。
- 真实图片：每日 CS 全分支优先解析 Liquipedia / Counter-Strike Wiki / Wikimedia 外部真实图源；失败才发本地签位卡，并用 `/csimage test all` 可验。
- 每日训练：`/cstrain` 会按当天地图、武器、定位、道具、战术和残局生成本地训练计划，包含练枪、道具和复盘任务；`/csquiz` 会生成每日稳定小考题面并把 A/B/C 选项按用户/群/日期洗牌，`/csquiz answer A` 或 `/csquiz 答 B` 可提交判分、看正确参考和解析；当前会话有 `/predict` 积分时会加入胜率/精准率、地图样本和赛事样本驱动的个人判断训练提示；设置过 `/profile` 时会把自填队伍/选手/地图偏好作为训练侧重点和举例参考，但不当作实时阵容/排名/状态事实；`/cstrain analyze <文字日志>` 可只读识别死亡质量、补枪交换、道具时机、急停预瞄、残局回防、地图信息和复盘闭环短板，`/cstrain log/stats/clear` 已接入个人训练历史，训练计划会按近 14 天分布和日志短板调整建议。
- 缓存/内存：AI 回复缓存 TTL 和最大条数都可配置，按 LRU 淘汰；回复缓存会按风格场景分级，实时事实、识图/语音、身份边界、礼物、风格纠偏和弹幕斗嘴默认旁路，战术/残局/道具类短 TTL 复用，并会归一化轻微 @ 称呼、全角/半角和重复标点差异来提高安全命中；稳定 CS 战术/残局/道具问题不强制联网，避免搜索注入把可复用打法常识拖出缓存；CS 日报基础底稿也有短 TTL 缓存和 single-flight，`/status` 会显示底稿 warm/cold、命中和合并次数；`/profile` 用户画像改为 mtime/size 感知的内存缓存，AI 回复和 `/cstrain` 高频读取不再每次读盘；`/mem health` 可只读查看 AI 回复、搜索、CS 实时、图片、TTS/STT、RAG、用户画像缓存和知识库命中率/容量建议，`/mem plan` 会基于当前会话、RAG、缓存容量、stale CS 证据和知识库风险生成 P0/P1/P2 维护计划，CS stale 较多时建议先 `/cs cache prune` 再 `/cs warm plan all` 补 fresh 证据；`/mem cache status` 可看回复缓存池容量、TTL 分布、in-flight、命中率和策略 Top，`/mem cache <消息>` 可预检缓存策略/key/旁路原因，管理员 `/mem cache prune` 可只清 expired 回复缓存并保留 fresh 热缓存，`/mem drop <关键词>` 可按主题删除当前会话上下文/RAG 噪声，`/mem trim [条数]` 可裁剪当前会话上下文和 RAG 索引，适合长期群聊维护。
- 回复缓存观测：真实 AI 回复 trace 会记录缓存判定链，包含 key 前缀、hit/miss/expired、bypass 原因、single-flight wait/reused、quality/factguard/duplicate 丢弃、stored/not-stored；`/trace recent` 会把同一字段压到 `cache=`，方便在线排查命中率、复读和真实性保护。
- 回复真实性：后处理和质量重写会清掉“根据知识库/作为AI/假装刚查HLTV”等泄露或假来源，也会拦“我是玩机器本人/官方授权/代表本人”等身份冒充；把“这是玩机器原话/本人说过/逐字复刻/名场面台词/一字不差/完整字幕”这类未核验原话误称改成场景口吻边界；排名/比分/阵容/转会断言必须受 fresh 证据约束，“听说/朋友说/群里都说/爆料说”的 CS 传闻背书即使旁边有 fresh 缓存也会改成可靠来源边界；实时事实参考会解析 fresh/stale 缓存证据，只有 stale 时不能支撑“最新/实时”断言，AI 发送前还会把 stale/miss/no-current 快照转成用户可见的自然事实边界和补证命令；如果证据账本显示 fresh 与 stale/miss/旧 RAG 过滤混在一起，发出前会额外压掉“全部最新/可以报死/我刚查了HLTV”这类过度来源口吻，并按排名、阵容/转会、赛果/赛程、选手数据、版本/地图池分类型检查 fresh 覆盖，避免用排名 fresh 支撑阵容或选手数据；如果本地知识实际命中旧事实风险分区，输出后处理还会按排名、阵容/转会、赛果/赛程、版本/地图池分类检查是否有对应 fresh 证据，没覆盖就降级为“得查最新”；真实发送前增加可配置毫秒级真人停顿，普通主动接话和强触发分区间控制，图片/语音输入/明确语音/排队较久会自动跳过；`/trace last` 显示统一证据账本、实时新鲜度、知识时效风险、身份边界、原话边界修复和真人停顿，`/trace recent [条数]` 会保留最近回复链路摘要和账本短摘，方便回看触发、发送、缓存、知识、实时证据、RAG过滤、识图和语音；`/status`、`/maint status` 和 `/data` 会显示旧证据计数、最近证据账本与最近实时证据，其中 `/status` 和 `/maint status` 也会显示真人停顿次数/平均/最近值，`/data` 会额外汇总 CS 核心事实覆盖 fresh/stale/miss、当前事实判定、分类型覆盖和 `/cs verify` / `/cs evidence` / `/cs warm plan` 补证路线；`/style check <文本>` 与真实发送同用事实 guard，可预检模板味、原话误称、假来源、传闻背书、身份冒充、实时断言、真实 TTS 分段风险，并在带缓存证据时显示未覆盖事实类型和精确 `/cs verify`、`/cs warm plan`、`/cs warm` 补证命令。
- 识图：`/vision check` 可在不下载图片、不调用模型的情况下预检图片源、`vision_max_images` 截断、payload、图片缓存 hit/miss/in-flight/本地可读、缓存压力和配置风险；`/vision warm` 可真实下载远程图片写入 `image_cache/` 但不调用视觉模型，适合把常用图片先预热成 hit；`/media check` 也会带图片缓存预检；`/vision test` 会下载图片、报告缓存前/后、图片大小、模型、payload 模式，并判断模型是否真的返回可见描述；`/vision recent [条数]` 会保留最近真实图片回复 trace，方便排查传图数、截断、来源类型、图片缓存前后状态和失败原因，且明确缓存命中不等于模型已理解图片。
- 语音：TTS/STT 都支持 API、本地命令和自动模式；`/voice check <文本>` 可在不生成音频的情况下预检直读文本分段、截断、provider/send 模式、刷屏风险和现实本人/授权语音话术边界，`/voice cache <文本>` 只读查看 TTS 分段缓存 key/hit/miss，`/voice sttcache <语音URL>` 只读查看 STT 听写缓存 key/hit/miss/in-flight/expired 且不下载语音、不转码、不调用模型，`/voice stt <语音URL>` 会真实跑端到端听写并回报缓存前/后、后端 local/API 动作、payload、转写结果和缓存复用边界，管理员 `/voice warm <文本>` 可真实预热常用短句 TTS 缓存但不发送 record；`/voice clone status/install` 会提示只使用有权使用的授权样本，生成语音不能说成现实主播本人语音，也不能拿去冒充本人；`/voice recent [条数]` 会保留最近真实语音发送 trace，方便排查直读/AI转语音、TTS后端、分段、兜底和失败原因；建议 VPS 上接授权本地 TTS/STT，API 作兜底。
- 礼物感谢：礼物事件会自动 @ 送礼用户；文案按单个、数量连送、大额和 45 秒短窗口连续礼物分层提高反应强度，并保留 20 秒同礼物节流；满足连送/大额门槛时可低频追加一条 TTS 语音感谢，受概率和同群冷却控制；`/gift check <礼物> [数量]` / `/gift cache <礼物> [数量]` 可只预检文案强度、语音触发原因和对应 TTS 缓存 hit/miss，不写入冷却；管理员可用 `/gift warm <礼物> [数量]` 真实生成同一句谢礼语音缓存，不发送 record、不写礼物 trace；真实礼物语音 trace 会记录发送前后 TTS 缓存 key/hit/miss，语音被门槛/冷却/概率跳过时也会记录当时缓存状态，`/gift recent [条数]` 会只读列出最近多条真实礼物处理，方便排查 sent/throttled/ignored、语音动作和缓存命中。
- 多模态观测：`/media status` 会只读聚合识图、听写、TTS、礼物感谢缓存和最近真实 trace，不下载图片、不听写语音、不调用模型、不生成音频；`/media check` 会只读预检实际传图数量、图片缓存 hit/miss、STT 听写缓存 hit/miss/in-flight/expired、听写上限和截断边界；`/media warm` 会真实预热图片缓存，语音只做 STT 缓存只读预检，不听写、不调用模型，适合多源消息先把图片变 hit；管理员 `/maint warm plan` 会只读扫描最近 trace，列出图片、语音源、TTS 短句和礼物谢礼预热候选及缓存状态；`/maint warm apply [all|media|vision|voice|gift]` 会按候选真实预热安全缓存，图片下载写缓存、TTS/礼物生成音频缓存，但仍不会自动听写语音源；`/maint warm media|vision|voice|gift` 已统一接入多模态/礼物热缓存预热，分别复用图片预热、TTS 分段预热和礼物谢礼 TTS 预热边界；`/media recent [条数]` 会把 `/vision recent`、`/voice recent`、`/gift recent` 汇到一个面板，明确没出现在记录里的输入不能当作已看、已听或已感谢，克隆/授权样本也不能说成现实主播本人语音；`/status` 和管理员 `/maint status` 也会显示同一份多模态真实链路摘要和边界，线上排障不用记多个入口。
- 风格场景：`/quote` 已修正为真实读取主库 `直播口癖` / `经典短句` 等短句池，普通命令保持短句好玩，明确索要“原话/逐字/本人说过”时会加“口癖锚点，不是本人逐字原话”边界；`/scene [场景词]` 已从单句素材升级为场景卡，会输出触发、反应、判断、可用短句和禁用边界，适合把授权切片摘要转成稳定的直播接话结构；AI 回复会自动判定风格纠偏、白给、残局、道具、实时事实、识图/语音等场景，并按“先别急/等一下”“讲道理/说实话”“有点东西/这波有说法”等同类口头禅族群去重，减少换皮复读；`/trace last` 和 `/trace recent` 会暴露命中结果和开头去重，`/status` 和 `/maint status` 会显示场景分布与最近质量风险。
- 命令发现：`/help` 保留完整命令总览，并新增 `/help cs`、`/help daily`、`/help media`、`/help memory`、`/help knowledge`、`/help admin` 主题帮助，分别聚焦 CS 证据链、每日 CS/小考训练、多模态语音识图、缓存/RAG/trace、知识库素材和管理员运维，减少功能变多后群友找不到入口的问题。
- 部署写盘/维护计划：`npm run doctor` 已覆盖 `data/` 运行数据、CS 实时/竞猜/日报/订阅/训练/画像 JSON 父目录、`context_store/embeddings` RAG 索引、`voice_cache/local` 本地 TTS 输出和 `knowledge/inbox` 素材收件箱；群内 `/diag` 会用临时探针汇总 `data/logs/context/rag/search/image/voice/local-tts/stt/knowledge/inbox` 写盘 OK/FAIL；管理员 `/maint storage` 会进一步展开关键 JSON 持久化文件、mtime/大小、磁盘空间和 missing 边界；`/maint plan` 会只读生成全局 P0/P1/P2 runbook，串起登录态、配置版本、API Key、写盘、CS fresh/stale、知识库、多模态和缓存容量，并在最近 trace 有候选或图片/TTS miss 偏高时提示 `/maint warm plan`、`/maint warm apply`、`/maint warm media|voice|gift`；`/maint warm cs` 可从维护入口真实执行 CS 实时缓存预热，默认 all，也支持 matches/results/ranking/watch/predict/team/player/match，预热后仍要求用 `/cs verify` 和 `/cs evidence` 看 fresh/stale/miss；`/maint warm media|vision|voice|gift` 则用于降低图片下载、TTS 常用短句和礼物谢礼冷启动延迟，缓存 hit 不代表已看图、已听音频或事实正确。
- 知识库：公开来源只做事实/短摘要，长视频和切片素材走 `knowledge/inbox/`，先用 `/kb inbox` 只读体检本地素材，按长转写、未核验原话、时效事实缺来源、礼物拟态和场景结构给出 `summary/full/split-first/drop` 建议，再用 `/kb ingest -> show -> commit` 审核入库；候选会显示 `trusted/known/unknown/risky` 来源评级，公开事实和带时效词的公开摘要会自动补快照时间、时效边界和 `/cs verify` / `/cs evidence` 复核要求，自动写库会拦下未知、高风险或缺少可信域名的公开事实，也会拦多行引号/时间轴/主播弹幕式长引用并要求压成场景、短摘要和可用话术；`/kb preview/import-url/show/list` 会直接给出 commit、补来源、摘要化或 drop 的行动建议；`/kb trust <链接或域名>` 可在导入前只读预检来源评级和写库边界；`/kb stale [条数|all]` 会只读扫描主库时效事实块，提示旧排名、阵容、转会、赛果、版本/地图池等内容缺少证据链接、抓取时间或 fresh/stale 边界的风险，并给出 `/cs verify`、`/cs evidence`、管理员 `/cs warm plan` 补证路线，明确 stale/miss 不能当实时结论；`/kb route <消息>` 可预检风格包、CS/事实、礼物、语录、场景、人物/队伍、语音、运维等多路召回、预算、注入总量、知识分区、时效风险、命中诊断和补素材建议，真实回复 trace 也会显示知识多路和命中分区时效风险，方便继续扩充玩机器素材。
- VPS 更新：`scripts/update.sh --hard` 可备份配置后强制对齐 `origin/main`，避免 VPS 仍停在旧代码。

## 可继续新增的功能

- 比赛订阅：`/watch match NAVI` 已可关注某队赛程/赛果变化，并会在关注队伍即将开赛时发一次去重开赛提醒；`/watch team Vitality` 已能识别阵容新增/移出和地图样本胜率变化，并带来源证据提醒；`/watch player donk` 已能识别 Rating/ADR/KAST/KD 变化并带来源证据提醒；`/watch plan` 可只读预检当前会话订阅、预热目标、fresh/stale/miss、计划事实类型覆盖、预计请求数和旧数据边界，不拉外站、不写订阅、不发提醒。
- 群内竞猜增强：已支持地图/赛事维度统计、地图/赛事榜、可归档命名赛季、实时地图/地图池线索继承、单场详情地图池/竞猜边界提示、人工 veto/地图池结构化只读预检、盘口/日报/训练提示联动；下一步继续接真实来源里的结构化 veto 数据。
- CS 日报增强：群偏好排序、赛后结算证据摘要、`/watch match` 开赛提醒、`/watch team` 阵容/地图维度提醒和 `/watch player` 选手状态变化提醒已接入；竞猜摘要已能展示 mappool 边界；下一步继续接真实来源里的官方/半官方 veto 结构化数据。
- 个人训练建议增强：历史训练记录和文字日志短板识别已接入；下一步可从战绩截图、demo 摘要或更结构化的对局数据里自动识别常用地图、死亡类型和道具短板。
- 贴纸包增强：已接入关键词自动贴纸和状态面板，普通群聊说白给、开香槟、保枪、老板大气等会低频自动接本地贴纸/QQ face；后续可继续扩充本地贴纸素材。
- 管理后台：Web 页查看队列、缓存、知识候选、错误日志和最近真实数据源。
- RAG 增强：知识库已先接入可诊断的多路召回分流；下一步继续把这些 lane 接到真正的向量索引/embedding 索引，分“风格、事实、切片摘要、礼物模板、CS数据”多路排序。
- 记忆管理：`/mem check <消息>`、`/mem search`、`/mem recent`、`/mem user <QQ号>`、`/mem user drop <QQ号>`、`/mem drop <关键词>`、`/mem trim`、`/mem clear`、`/trace last` 已形成诊断闭环；RAG 注入前会归一化过滤近期上下文重复内容，并按 `相似度 + 近期加权` 排序，减少复读和很旧记忆抢占最近话题；遇到 CS 实时问法时，会额外过滤旧排名、旧阵容、旧比分、旧转会和旧选手数据类记忆，真实回复 trace 和 `/mem check` 都会显示过滤数量/原因，稳定战术、道具、残局记忆仍可注入；`/mem drop <关键词>` 可清掉当前会话中某个旧梗/错误事实/跑偏话题的上下文和 RAG 索引，`/mem user drop <QQ号>` 可定点清某个用户刷屏或错事实记忆并清掉可能混入旧用户内容的压缩摘要，`/mem trim [条数]` 可清掉旧摘要并保留最近上下文/RAG；`/profile` 已接入当前群/私聊内的用户自填长期偏好画像，支持队伍、选手、地图、语气和备注，并会作为用户画像包注入 AI 回复和 `/trace last`，但不会当作实时事实证据。
- CS 短报：继续把 `/csreport` 和 `/watch` 打通；`/csreport focus` 已提供一屏“今天看什么 + 盯谁变化 + 竞猜候选 + 证据边界”，`/watch plan` 已能把关注目标、计划事实类型覆盖和 `/cs warm plan` 预热建议串起来。
- 授权素材导入：支持本地整理好的长切片文本、直播台词场景、礼物感谢模板批量导入，统一走 `knowledge/inbox/`，先 `/kb inbox` 体检，再 `/kb ingest` 审核。

## 真识图建议

1. 配置真正支持视觉的模型，`vision_model` 不要填纯文本模型。
2. 群里跑 `/vision status` 看模型、payload 和图片缓存。
3. 先跑 `/vision check <图片URL>`，确认图片源、截断、图片缓存命中和配置风险；它不下载图片也不调用模型。
4. 常用远程图片先跑 `/vision warm <图片URL>`，只下载进缓存、不调用视觉模型；再跑 `/vision check` 复查 hit。
5. 再跑 `/vision test <图片URL>`，看缓存前/后、下载结果、调用结果和是否出现“模型返回了可见描述”；缓存 hit 只代表文件可复用，只有下载 OK 且调用 OK 才代表本次模型拿到了图片输入。
6. 直接发图片加 `/vision warm` 或 `/vision test`，分别测试 NapCat `get_image` 缓存预热和端到端识图链路。
7. 若下载 OK 但调用失败，调 `vision_payload_mode`：`auto`、`image_url_object`、`image_url_string`、`input_image`、`image_base64` 逐个试。
8. 强触发识图后跑 `/vision last`、`/vision recent` 或 `/trace last`，看实际输入图片数、传给模型的图片数、`vision_max_images` 截断、URL/本地/base64 来源类型和图片缓存前后状态；`/vision status` 也会带最近一次识图摘要和最近记录数量。

## 语音优化建议

- STT：VPS 优先用本地 Whisper/faster-whisper 命令，环境变量读取 `QQBOT_STT_INPUT/QQBOT_STT_OUTPUT`。
- TTS：只用授权声音样本；本地 TTS 生成失败时 API 兜底。
- QQ 发送：Docker NapCat 建议 `tts_send_mode=base64`，减少容器路径问题。
- 缓存：常用短句缓存命中高，先 `/voice cache <文本>` 看 TTS key 和状态，再让管理员 `/voice warm <文本>` 预热；常见语音源先 `/voice sttcache <语音URL>` 看 STT key 和 hit/miss，需要真实转写再 `/voice stt <语音URL>` 预热并看缓存前/后、后端动作和转写结果；真实发送后跑 `/voice recent` 看是否命中预期后端、分段和兜底；`tts_cache_hours`、`tts_cache_max_mb`、`stt_cache_hours` 和 `stt_cache_max_mb` 可以按 VPS 空间调大。

## 风格与素材边界

- 可以学习“场景 -> 反应方式 -> 可用话术”，不要长篇复制公开视频字幕；多行对话/时间轴素材先摘要化再入库。
- 礼物感谢建议做拟态模板，例如“感谢老板，这波经济直接拉满”，不要标成真实原话。
- 长段直播语录建议拆成“场景 -> 反应 -> 复盘句”三段，而不是整段逐字搬运。
- 机器人可以更像直播间接弹幕，但不冒充现实本人，不代表本人发言。
- 攻击性只打操作、决策、逻辑和理解，不打现实身份和人身属性。

## VPS 核验清单

```bash
git log --oneline -1
npm run build
npm run doctor
npm run data:test
pm2 restart wanjier --update-env
pm2 logs wanjier --lines 80 --nostream
```

群里再跑：

```text
/data
/csplayer status
/csimage test all
/vision status
/trace last
```
