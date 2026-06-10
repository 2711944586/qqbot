import { Plugin } from '../types';
import { detectFuzzyCommand } from './fuzzy-command';

function normalizeHelpTopic(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\s+/g, '')
    .replace(/[：:，。！？!?、,.]/g, '');
}

export function buildHelpTopic(topicRaw: string): string {
  const topic = normalizeHelpTopic(topicRaw);
  if (!topic) return '';
  if (['cs', 'hltv', 'data', '实时', '数据', '比赛', '赛程', '赛果', '排名'].includes(topic)) {
    return [
      'CS实时/HLTV证据帮助',
      '/cs brief - 今日短报',
      '/cs today check - 只读预检核心缓存 fresh/stale/miss',
      '/cs match <matchid> - 单场详情、地图池线索、HLTV候选页入口',
      '/cs evidence all|match <id>|<id> - 证据卡和缓存新鲜度',
      '/cs hltvcheck <id> - 只读核验HLTV候选页，不写事实缓存',
      '/cs verify all|ranking|match <id>|player <选手> - 预检能不能说成“现在/最新”',
      '/cs warm plan all|match <id>|results - 管理员预热前只读计划',
      '边界: fresh 才能当当前快照；stale 只能当旧线索；miss 不能反推没有比赛/赛果/变动。',
    ].join('\n');
  }
  if (['daily', 'day', '每日', '今日', 'fun', '娱乐', '好玩', '小考', '训练'].includes(topic)) {
    return [
      '每日CS/好玩功能帮助',
      '/csplayer - 每日CS选手，带真实图源优先兜底',
      '/csteam /csmap /csweapon /csskin /csrole - 队伍/地图/完整枪械池/Steam饰品图/定位',
      '/csutility /cstactic /csclutch /csloadout - 道具/战术/残局/套餐',
      '/csknife 或 今日发刀/发刀/.d - 每日刀具，覆盖全部刀型和常见刀皮，优先发真实刀皮图',
      '/mokoko 或 每日木柜子 - MyGO!!!!! / Ave Mujica 每日角色，带真实图',
      '/csquiz - 今日小考题面；/csquiz answer A 或 /csquiz 答 B 提交判分',
      '/cstrain - 今日训练计划；/cstrain log 30 Mirage AK 急停 记录训练',
      '/cstrain analyze <文字日志> - 只读分析死亡、补枪、道具、急停等短板',
      '/daily on 09:00 - 当前群/私聊每天推送低频今日状态；/daily now 立即看；/daily me 我的进度；/daily personal 每日偏好卡；/daily proof 今日证据账本；/daily score 今日闭环分；/daily center/desk 今日指挥台；/daily squad/group 群每日队形；/daily vibe 每日聊天节奏；/daily relay 识图语音群接力；/daily ice/topic 今日破冰话题；/daily script/kit 识图语音脚本包；/daily gap 识图语音今日补缺；/daily line 每日语音台词；/daily plan 今日安排；/daily guard/streak 保连续；/daily media|voice 识图语音陪跑；/daily nudge/missing 催一下/看今天还差啥；/daily week 最近7天周报；/daily recap 晚间复盘+个人收尾和识图语音收尾；/daily challenge 今日挑战；/daily done 记录完成并提示识图语音下一步；/daily wrap 今日收工；/daily challenge board 挑战榜；/daily checkin 每日打卡；/daily board 打卡榜',
      '边界: 每日CS和小考是本地稳定签位/训练建议，不是实时赛事事实。',
    ].join('\n');
  }
  if (['media', 'multi', 'multimodal', 'vision', 'voice', '语音', '识图', '图片', '多模态'].includes(topic)) {
    return [
      '多模态/语音/识图帮助',
      '/media status / daily / recent - 聚合识图、听写、TTS、礼物感谢真实链路；daily 是每日只读链路牌，会显示今日三件套、完成度、实跑/缺口',
      '/media check <图片URL/语音URL或附图附语音> - 只读预检，不下载不听写',
      '/vision check|warm|test <图片URL> - 图片缓存预检/预热/端到端识图',
      '/vision recent - 最近真实图片回复 trace',
      '/voice check|cache <文本> - TTS分段、缓存和真人语音边界预检',
      '/voice sttcache|stt <语音URL> - STT缓存预检或端到端听写',
      '/voice warm <文本> - 管理员预热常用TTS缓存，不发送record',
      '自然问法: 今天识图语音跑了吗 / 今天看图听写跑了吗 / 多模态今天跑了吗 → /media daily',
      '边界: 缓存hit只代表可复用；是否真的看图/听音频要看 test/recent/trace。',
    ].join('\n');
  }
  if (['memory', 'mem', 'cache', 'trace', '内存', '缓存', '记忆', '诊断'].includes(topic)) {
    return [
      '内存/缓存/trace帮助',
      '/mem health - 缓存、上下文、RAG、画像、知识库命中率体检',
      '/mem plan - 只读生成 P0/P1/P2 维护建议',
      '/mem cache status - AI回复缓存池容量、TTL、命中率、策略Top',
      '/mem cache <消息> - 预检回复缓存key、旁路原因和自然变体合流',
      '/mem check <消息> - 预检RAG召回和旧CS事实过滤',
      '/trace last / recent [条数] - 最近回复链路、证据账本、缓存判定、真人停顿、识图/语音状态',
      '边界: trace 是线上排障证据；实时事实仍以 fresh 证据为准。',
    ].join('\n');
  }
  if (['knowledge', 'kb', '知识', '知识库', '素材', '语录', 'quote', 'scene', '风格'].includes(topic)) {
    return [
      '知识库/风格素材帮助',
      '/quote [关键词] - 查短句/口癖锚点；索要逐字原话会加边界',
      '/scene [场景词] - 直播场景卡，含触发/反应/判断/短句/禁用边界',
      '/kb search <关键词> - 检索主库',
      '/kb route <消息> - 预检风格包/话题包/时效风险和召回分区',
      '/kb inbox [条数|all] - 管理员只读体检本地素材',
      '/kb stale [条数|all] - 扫描旧排名、阵容、赛果、版本等时效事实风险',
      '边界: 不把未核验切片长句说成现实本人逐字原话；实时事实要 fresh 证据。',
    ].join('\n');
  }
  if (['admin', 'ops', 'maint', '管理', '运维', '维护'].includes(topic)) {
    return [
      '管理员/运维帮助',
      '/diag / diag live - 本地严格自检/真实链路探针',
      '/maint plan|status|login|config|storage|warm plan|warm apply|warm cs|warm media|warm voice|warm gift|clean - 总维护计划、维护面板、登录态、配置漂移、运行存储体检、预热候选、CS/媒体/语音预热和清理',
      '/reload - 重载配置和并发/缓存/知识库参数',
      '/cs warm plan all -> /cs warm all - 预热CS实时证据',
      '/kb preview|import-url|ingest|show|commit|drop - 知识候选审核流',
      '/gift warm <礼物> [数量] / voice warm <文本> - 预热语音缓存',
      '边界: plan/check/status 类命令只读；warm/commit/clean 才会写缓存或知识库。',
    ].join('\n');
  }
  return [
    `没找到「${topicRaw}」这个帮助主题。`,
    '可用主题: /help cs、/help daily、/help media、/help memory、/help knowledge、/help admin',
  ].join('\n');
}

export const helpPlugin: Plugin = {
  name: 'help',
  description: '显示帮助信息',
  handler: (ctx) => {
    const fuzzy = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());
    if (ctx.command === 'help' || fuzzy === 'help') {
      const topicHelp = buildHelpTopic(ctx.args[0] || '');
      if (topicHelp) {
        ctx.reply(topicHelp);
        return true;
      }
      const helpText = [
        '玩机器 命令列表',
        '主题帮助: /help cs | daily | media | memory | knowledge | admin',
        '',
        '对话:',
        '  /ai <内容> - 直接对话',
        '  私聊我 - 直接进入独立私聊上下文',
        '  /voice <内容> - 语音回复',
        '  /tts <内容> - 同上',
        '  /search <关键词> - 联网搜索',
        '  @我 <内容> - @触发',
        '  /reset - 清除记忆',
        '  /presets - 预设列表',
        '  /preset <名> - 切换人格',
        '',
        '玩机器风格:',
        '  /quote [关键词] / check [关键词] - 查口癖/短句锚点，预检短句池命中和原话边界',
        '  /scene [场景词] - 抽直播场景卡，含触发/反应/判断/短句/禁用边界',
        '  /player <名字> - 查选手倾向；带“最新/现在/状态”会读CS API统计',
        '  /team <队伍> - 查队伍倾向；带“最新/阵容/排名”会读CS API阵容/VRS',
        '  /gift <礼物名> [数量] / check|cache <礼物> [数量] / warm <礼物> [数量](admin) / status / trace / recent - 礼物拟态模板、语音触发、TTS缓存预检/预热、运行状态和最近事件',
        '  /cs brief|match|results|ranking - CS实时聚合入口；/cs match <matchid> 查单场详情/HLTV页面候选/地图池线索/竞猜地图边界/地图亮点；/cs intent <问法> 预检实时路由/缓存键',
        '  /cs team <队伍> / player <选手> - 查结构化队伍/选手数据',
        '  /cs today check / status / sources / evidence all|match <id>|<id> / hltvcheck <id> / verify all|ranking|match <id>|<id> / health / warm plan match <id>|results / warm results - 看CS短报预检、数据链接、HLTV候选页核验与短TTL核验缓存、核心覆盖总判定、来源证据、事实回复边界、预热后fresh覆盖和缓存健康',
        '  /csreport focus / on 09:30 / check / off / status - 一屏今日看点和当前群每日CS日报推送；日报自带数据证据摘要，check只读预检预热目标和旧数据边界',
        '  /watch team <队伍> / player <选手> / match <队伍> - team看阵容/地图样本，player看Rating/ADR，match发开赛提醒',
        '  /watch list / plan / now / remove <id> - 管理当前会话CS订阅；plan只读预检预热目标和旧数据边界',
        '  /predict matches / openmatch 1 / matchmap <matchid> / veto Inferno/Mirage/Nuke / notify on 90m / A 2-1 map Inferno / map Inferno / event IEM / season start 夏季赛 / board season - CS竞猜、实时开盘、单场地图线索、地图池预检、候选提醒、地图/赛事榜/可归档赛季',
        '  /cs2news - 实时CS新闻',
        '  /csbrief /csreport - 今日CS短报/日报(比赛/赛果/排名/新闻)',
        '  /daily now / me / personal / proof / score / center|desk / squad|group / vibe / relay / ice|topic / script|kit / gap / line / plan / guard|streak / media|voice / nudge|missing / week / recap / challenge / done / wrap / challenge board / checkin / board / on 09:00 / status / off - 每日低频今日状态、个人进度、每日偏好卡、今日证据账本、今日闭环分、今日指挥台、群每日队形、每日聊天节奏、识图语音群接力、今日破冰话题、识图语音脚本包、按真实 trace 补识图语音缺口、每日语音台词、今日安排、保连续短催、识图语音陪跑、短催促/今天还差啥、最近7天周报、晚间复盘+个人收尾状态+识图语音收尾、今日挑战、挑战完成记录、今日收工、挑战榜、连续打卡、打卡榜和自然问候；done/checkin/wrap 会顺手提示识图语音下一步，不走AI token；/media daily 看识图语音每日链路牌',
        '  /cs2live - CS2直播查询',
        '  /match - 当前比赛',
        '  /ranking - VRS/HLTV镜像排名',
        '  /csmood - 玩机器今日心情',
        '  /forecast - 综合每日运势',
        '',
        '每日CS:',
        '  /csplayer - 每日CS选手',
        '  /csteam /csmap /csweapon /csskin /csrole - 队伍/地图/完整枪械池/皮肤/定位，真实图优先',
        '  /csutility /cstactic /csclutch - 道具/战术/残局',
        '  /csloadout - 每日CS全套，含战队/地图/武器/皮肤/定位',
        '  /csknife - 每日发刀；也可以说 今日发刀 / 发刀 / .d，覆盖全部刀型和常见刀皮',
        '  /mokoko - 每日木柜子；MyGO!!!!! / Ave Mujica 角色抽签',
        '  /csquiz - 每日CS小考/挑战；/csquiz answer A 或 /csquiz 答 B 提交判分',
        '  /cstrain - 每日CS训练计划(练枪/道具/定位/复盘；有竞猜积分、训练日志或/profile偏好会个性化)',
        '  /cstrain log 30 Mirage AK 急停 / stats / clear - 记录训练并让计划按历史短板调整',
        '  /csimage test all - 测每日CS真实图源',
        '  /csplayer status - 看图片缓存/限流/兜底状态',
        '  也可以直接说: 今日CS / 今天抽个选手 / 今日地图 / 今天用什么枪 / 今日皮肤 / 今日发刀 / 每日木柜子 / 今天怎么练枪 / 来个CS小考',
        '',
        '趣味:',
        '  /roll [N|NdM] - 骰子',
        '  /luck - 运势',
        '  /jrrp - 今日人品',
        '  /choose A,B,C - 帮选',
        '  /rand [min] [max] - 随机数',
        '',
        '工具:',
        '  /ping - 在线',
        '  /whoami - 查bot号/群号',
        '  /status - 运行状态/队列/缓存命中/CS数据链路/风格场景/质量风险',
        '  /diag - 严格自检',
        '  /data - 实时数据健康度、CS事实覆盖、fresh/stale/miss边界和补证路线',
        '  /mem - 内存/上下文/RAG/AI回复缓存/用户画像缓存状态，/mem health 看健康，/mem plan 出只读维护计划，/mem cache status 看缓存池，/mem cache <消息> 预检回复缓存，/mem check <消息> 预检RAG召回',
        '  /mem recent [条数] - 看最近上下文和RAG索引',
        '  /profile / set team|player|map|tone|note / clear - 当前会话用户自填长期偏好画像，AI会个性化但不当实时事实证据',
        '  /time - 时间',
        '  /stats - 群统计',
        '  /me - 我在群的活跃度',
        '  /trace last / recent [条数] - 最近回复trace，含风格场景/实时证据新鲜度/缓存判定/真人停顿/真实传图数/识图截断',
        '  /style status / check <文本> || <证据> - 风格质量、真实性、传闻背书、证据新鲜度、风险等级和修复建议预检',
        '  /media status / daily / recent [条数] / check <图片URL/语音URL或附图附语音> / warm <图片URL/语音URL或附图附语音> - 多模态每日链路牌、今日三件套、完成度、优先补、实跑/缺口、聚合状态、最近真实链路、图片缓存预热和STT缓存/听写只读预检',
        '  /vision status / recent / check / warm / last / test - 识图预检、图片缓存命中诊断/预热和最近传图 trace',
        '  /voice status / recent / check <文本> / cache <文本> / sttcache <语音URL> / warm <文本>(admin) / test / stt / clean - 语音诊断、TTS/STT缓存命中预检/预热、真人语音边界和发出前预检',
        '  /voice clone [URL] - 安装授权克隆样本，生成语音不能冒充现实本人',
        '  发图后说“帮我看图/识图/看看这张图” - 直接识图',
        '',
        '知识库:',
        '  /kb search <关键词> - 检索',
        '  /kb route <消息> - 预检AI会注入哪些风格/话题知识、命中诊断和时效风险',
        '  /kb trust <链接或域名> - 预检来源评级和写库边界',
        '  /kb sources [条数|all] - 只读体检来源刷新状态、可信度和自动写库前置',
        '  /kb stale [条数|all] - 只读体检主库时效事实边界，并给补证/预热/复核路线',
        '  /kb stats - 状态',
        '  /kb refresh - 联网刷新，公开事实候选会带来源评级、快照时间和时效边界',
        '  /kb audit - 审计来源、原话声称和长引用风险',
        '  /kb auto on|off|run - 自动更新',
        '',
        '管理(仅admin):',
        '  /reload - 重载配置',
        '  /tune <项> <值> - 快速调参(trigger/related/tts/poke/temp/maxtokens/minchars/cooldown)',
        '  /maint plan|status|login|config|storage|warm plan|warm apply|warm cs|warm media|warm voice|warm gift|clean - 总维护计划、运行存储体检、预热候选、CS/多模态/TTS预热和清理',
        '  /gc - 强制GC',
        '  /csprewarm - 预下载所有选手图(慢，受限流影响)',
        '  /ban /unban /kick /title',
        '  /kb preview / import-url / ingest / list / show / commit / drop',
        '',
        '其他:',
        '  戳一戳我 - 玩机器风格回应',
        '  复读2次我会跟',
        '  CS2/玩机器相关话题会主动接',
        '  支持emoji，会把常见emoji转QQ经典表情并限制刷屏',
        '',
        '🎭 表情和贴纸:',
        '  /stickers - 查可用 QQ 表情和本地贴纸',
        '  /stickers status / keywords - 看自动贴纸状态和关键词',
        '  /face <名字或id> - 发 QQ 经典表情(如/face 呲牙)',
        '  /sticker <名字> - 发本地贴纸',
        '  群里说“白给/开香槟/保枪/老板大气/绷不住”等，会低频自动接贴纸',
        '  AI 对话会在合适语境用[呲牙][笑哭][思考]等标签自动转表情',
        '',
        '🔥 中文模糊触发 (不需要 / 前缀，自然语言)：',
        '  我多活跃 / 看看我 / 我的活跃度 → /me',
        '  群统计 / 话痨排行 → /stats',
        '  今天有什么比赛 / 现在打谁 → /match',
        '  hltv排名 / vrs排名 / 现在第一是谁 → /ranking',
        '  最近战报 / 昨天比赛结果 → /cs2news',
        '  matchid=2390002 这场谁C了 / 2390002这场详情 → /cs match <matchid>',
        '  cs短报 / cs日报 / 今天cs看点 → /csbrief',
        '  订阅CS日报 09:30 → /csreport on 09:30',
        '  订阅Vitality / 关注donk / 关注NAVI比赛 → /watch team/player/match',
        '  竞猜榜 / 竞猜周榜 / 竞猜赛季榜 / 我压 A 2-1 → /predict board 或 /predict pick',
        '  直播场景 / 白给场景 / 礼物话术 → /scene',
        '  cs直播 / 玩机器开播了吗 → /cs2live',
        '  玩机器今天什么状态 → /csmood',
        '  今日运势 → /forecast',
        '  今日状态 / 我的每日 / 今日偏好 / 我的画像 / 今日证据账本 / 今天跑没跑 / 今日闭环分 / 今日完成度 / 今日指挥台 / 今日看板 / 今日队形 / 群每日 / 今日聊天节奏 / 今日语气 / 今日接力 / 群接力 / 今日话题 / 群破冰 / 识图语音脚本包 / 识图语音缺啥 / 今日三件套缺啥 / 今日语音台词 / 今日语音句 / 今日安排 / 保连续 / 别断签 / 识图语音陪跑 / 催我一下 / 我今天还差啥 / 本周每日 / 今日复盘 / 今日挑战 / 挑战完成 / 今日收工 / 挑战榜 / 今日打卡 / 打卡榜 / 晚安机器 / 每日提醒 / 订阅每日问候 09:00 → /daily',
        '  今日CS / 今日选手 / 今日队伍 / 今日地图 / 今日武器 / 今日皮肤 / 今日残局 / 今日发刀 / 发刀 / .d / 每日木柜子 / 今天怎么练枪 / 来个CS小考 → 每日抽签系列',
        '  识图状态 / 语音状态 / 多模态状态 → /vision status / /voice status / /media status',
        '  识图语音每日牌 / 今天识图语音跑了吗 / 今天看图听写跑了吗 / 今日三件套 / 识图语音三件套 / 多模态日报 / 今日多模态状态 → /media daily',
        '  语音说 XXX / 直接念 XXX / 朗读 XXX → 直接生成语音',
        '  帮我看图 / 看看这张图 → 识图',
        '  学一下我的声音(授权样本) → /voice clone',
        '  内存状态 → /mem',
        '  帮助 / 怎么用 / 功能列表 → /help',
      ].join('\n');

      ctx.reply(helpText);
      return true;
    }
    return false;
  },
};
