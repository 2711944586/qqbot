import * as fs from 'fs';
import * as path from 'path';
import { MessageSegment } from '../types';

/**
 * 表情包/QQ表情系统
 *
 * 支持三层：
 * 1. emoji（直接 unicode，AI 输出后我们保留前 2-3 个）
 * 2. QQ 经典 face（[face:N] 标记 → face 段，N=0-358 等）
 * 3. 本地表情包图片（stickers/*.gif|jpg|png → image 段）
 *
 * 命名映射：[呲牙] / [lol] / [喷血] 等中文/英文别名 → face id 或本地图片
 */

const STICKERS_DIR = path.resolve(__dirname, '..', '..', 'stickers');

/** QQ 经典 face id 名称映射（中英文别名都映射到 face id） */
const FACE_NAME_TO_ID: Record<string, number> = {
  // 笑系列
  '笑': 0, 'smile': 0,
  '撇嘴': 1, 'pout': 1,
  '色': 2, 'drool': 2,
  '发呆': 3, 'daze': 3,
  '得意': 4, 'smug': 4,
  '流泪': 5, 'tears': 5, '泪': 5,
  '害羞': 6, 'shy': 6, '害羞脸': 6,
  '闭嘴': 7, 'shutup': 7,
  '睡': 8, 'sleep': 8, '睡觉': 8,
  '大哭': 9, 'cry': 9, 'sob': 9,
  '尴尬': 10, 'awkward': 10,
  '发怒': 11, 'angry': 11, '生气': 11,
  '调皮': 12, 'naughty': 12,
  '呲牙': 13, '齜牙': 13, '龇牙': 13, // 13 旧版/新版的呲牙
  '微笑': 14, 'grin': 14,
  '难过': 15, 'sad': 15, '伤心': 15,
  '酷': 16, 'cool': 16,
  '抓狂': 18, 'crazy': 18, '崩溃': 18,
  '吐': 19, 'puke': 19, '呕吐': 19, '吐了': 19,
  '偷笑': 20, 'snicker': 20,
  '可爱': 21, 'cute': 21,
  '白眼': 22, 'eyeroll': 22, '翻白眼': 22,
  '傲慢': 23, 'arrogant': 23,
  '饥饿': 24, 'hungry': 24, '饿': 24,
  '困': 25, 'tired': 25,
  '惊恐': 26, 'horror': 26, '恐惧': 26,
  '流汗': 27, 'sweat': 27, '汗': 27,
  '憨笑': 28, 'silly': 28,
  '悠闲': 29, 'leisure': 29,
  '奋斗': 30, 'fight': 30,
  '咒骂': 31, 'curse': 31,
  '疑问': 32, 'question': 32, '问号': 32, '???': 32,
  '嘘': 33, 'shh': 33,
  '晕': 34, 'dizzy': 34, '晕了': 34,
  '折磨': 35, 'torture': 35,
  '衰': 36, 'shuai': 36,
  '骷髅': 37, 'skull': 37,
  '敲打': 38, 'hammer': 38,
  '再见': 39, 'bye': 39, '拜拜': 39,
  '擦汗': 96, 'whew': 96,
  '抠鼻': 97, 'pick': 97,
  '鼓掌': 98, 'clap': 98, '拍手': 98,
  '糗大了': 99, 'embarrassed': 99,
  '坏笑': 100, 'evil': 100,
  '左哼哼': 101, '右哼哼': 102,
  '哈欠': 103, 'yawn': 103,
  '鄙视': 104, 'despise': 104, '看不起': 104,
  '委屈': 105, 'wronged': 105,
  '快哭了': 106, 'aboutcry': 106,
  '阴险': 107, 'sinister': 107,
  '亲亲': 108, 'kiss': 108,
  '吓': 109, 'scared': 109,
  '可怜': 110, 'pity': 110,
  '菜刀': 111, 'knife': 111,
  '西瓜': 112, 'watermelon': 112,
  '啤酒': 113, 'beer': 113,
  '咖啡': 60, 'coffee': 60,
  '飞吻': 63, 'flykiss': 63,
  '握手': 65, 'shake': 65,
  '胜利': 66, 'victory': 66,
  '抱拳': 67, 'fist': 67,
  '强': 76, 'thumbsup': 76, '赞': 76, 'good': 76, '👍': 76,
  '弱': 77, 'thumbsdown': 77,
  '玫瑰': 79, 'rose': 79,
  '凋谢': 80, 'wilt': 80,
  '太阳': 81, 'sun': 81,
  '月亮': 82, 'moon': 82,
  '心': 66, 'heart': 66,
  '心碎': 67, 'brokenheart': 67,
  '蛋糕': 53, 'cake': 53,
  '闪电': 54, 'lightning': 54,
  '炸弹': 55, 'bomb': 55,
  '便便': 59, 'poop': 59, '粑粑': 59,
  '蜡烛': 71, 'candle': 71,
  '钞票': 87, 'money': 87,
  '冷汗': 96, 'coldsweat': 96,
  // 新增 / 高频
  '666': 76,
  'ok': 124, 'OK': 124, '👌': 124,
  '加油': 169, 'cheer': 169,
  '微微一笑': 178, 'lol': 178, 'LOL': 178, '哈哈': 178, '笑哭': 178,
  '左亲右亲': 181,
  '右亲': 182,
  '幽灵': 187, 'ghost': 187,
  '蛋': 188, 'egg': 188,
  '红包': 192, 'redenvelope': 192,
  '发': 193, 'fa': 193,
  '福': 194, 'fu': 194,
  '红包多多': 195,
  '皱眉': 213, 'frown': 213,
  '思考': 277, 'think': 277, '想': 277,
  '泡泡': 278, 'bubble': 278,
  '摸鱼': 285, 'slacking': 285, '摸': 285,
  '打脸': 286, 'facepalm': 286,
  '喷血': 287, 'bloodspurt': 287, '吐血': 287, '🤯': 287,
  '哈哈哈哈': 178,
  '骂街': 289, 'scold': 289,
  '加班': 290, 'overtime': 290,
  '柠檬': 291, 'lemon': 291,
  '汪汪': 277, 'woof': 277,
  '让我看看': 296, 'look': 296,
  '嗑瓜子': 305, 'seeds': 305, '吃瓜': 305,
  '我酸了': 306, 'sour': 306, '柠檬精': 306,
  '辣眼睛': 307, 'spicyeye': 307,
  '我看不见': 309, 'cantsee': 309,
  '点赞': 76, '👍🏻': 76,
  '666!': 76,
};

/** 反向：face id → 中文名称（用于 AI 提示） */
function buildIdToName(): Record<number, string> {
  const r: Record<number, string> = {};
  // 偏好中文名作为反向映射
  const preferredZh = ['笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭', '尴尬', '发怒', '调皮', '呲牙', '微笑', '难过', '酷', '抓狂', '吐', '偷笑', '可爱', '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '悠闲', '奋斗', '咒骂', '疑问', '嘘', '晕', '折磨', '衰', '骷髅', '敲打', '再见', '擦汗', '抠鼻', '鼓掌', '糗大了', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈', '快哭了', '阴险', '亲亲', '吓', '可怜', '强', '弱', '玫瑰', '凋谢', '蛋糕', '炸弹', '咖啡', '抱拳', 'OK', '加油', '笑哭', '幽灵', '思考', '摸鱼', '打脸', '喷血', '让我看看', '吃瓜', '柠檬精'];
  for (const name of preferredZh) {
    const id = FACE_NAME_TO_ID[name];
    if (typeof id === 'number' && !r[id]) r[id] = name;
  }
  return r;
}
const ID_TO_NAME = buildIdToName();

/**
 * 解析 AI 输出的标签，转成 message segments
 * 支持的格式（按优先级）：
 *   [face:N] [表情:N] [emoji:N] - 数字 face id
 *   [呲牙] [lol] [喷血] [思考] - 命名表情（自动映射）
 *   [sticker:文件名] - 本地表情包图片（stickers/ 目录下的 gif/jpg/png）
 */
export function parseStickerMarkers(text: string): MessageSegment[] | null {
  if (!text) return null;

  // 检测是否含任何标签
  const hasNumeric = /\[(?:face|表情|emoji|qq)[:：]\d{1,4}\]/i.test(text);
  const hasNamed = /\[(?:[\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]/.test(text);
  const hasSticker = /\[sticker[:：]\s*[\w.-]+\]/i.test(text);
  if (!hasNumeric && !hasNamed && !hasSticker) return null;

  // 综合 regex（顺序匹配）
  const tagRegex = /\[(?:face|表情|emoji|qq)[:：](\d{1,4})\]|\[sticker[:：]\s*([\w.-]+)\]|\[([\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]/gi;

  const segments: MessageSegment[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let stickerCount = 0;
  const maxStickers = 3; // 整条最多 3 个表情/face/贴纸

  while ((m = tagRegex.exec(text))) {
    if (m.index > lastIdx) {
      const chunk = text.slice(lastIdx, m.index);
      if (chunk) segments.push({ type: 'text', data: { text: chunk } });
    }
    if (stickerCount >= maxStickers) {
      lastIdx = m.index + m[0].length;
      continue;
    }

    if (m[1]) {
      // 数字 face
      const faceId = parseInt(m[1], 10);
      if (!isNaN(faceId) && faceId >= 0 && faceId <= 600) {
        segments.push({ type: 'face', data: { id: String(faceId) } });
        stickerCount++;
      }
    } else if (m[2]) {
      // 本地贴纸
      const filename = m[2];
      const filepath = findStickerFile(filename);
      if (filepath) {
        segments.push({ type: 'image', data: { file: `file://${filepath}` } });
        stickerCount++;
      }
    } else if (m[3]) {
      // 命名表情：先查 face name，再查 sticker 文件
      const name = m[3];
      const faceId = FACE_NAME_TO_ID[name] ?? FACE_NAME_TO_ID[name.toLowerCase()];
      if (typeof faceId === 'number') {
        segments.push({ type: 'face', data: { id: String(faceId) } });
        stickerCount++;
      } else {
        // 试查贴纸
        const filepath = findStickerFile(name);
        if (filepath) {
          segments.push({ type: 'image', data: { file: `file://${filepath}` } });
          stickerCount++;
        }
        // 都找不到，把整个 [name] 作为文本保留
        else {
          segments.push({ type: 'text', data: { text: m[0] } });
        }
      }
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx);
    if (tail) segments.push({ type: 'text', data: { text: tail } });
  }

  // 合并相邻 text + 去空
  const merged: MessageSegment[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      if (!seg.data.text) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.type === 'text') {
        prev.data.text += seg.data.text;
        continue;
      }
    }
    merged.push(seg);
  }
  return merged.length > 0 ? merged : null;
}

/** 在 stickers/ 目录下查找匹配的图片文件 */
function findStickerFile(name: string): string | null {
  if (!fs.existsSync(STICKERS_DIR)) return null;
  // 直接匹配（带扩展名）
  if (/\.(gif|jpg|jpeg|png|webp)$/i.test(name)) {
    const direct = path.join(STICKERS_DIR, name);
    if (fs.existsSync(direct)) return direct;
  }
  // 试常见扩展名
  for (const ext of ['gif', 'png', 'jpg', 'jpeg', 'webp']) {
    const candidate = path.join(STICKERS_DIR, `${name}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 列出本地贴纸库 */
export function listLocalStickers(): string[] {
  try {
    if (!fs.existsSync(STICKERS_DIR)) return [];
    return fs.readdirSync(STICKERS_DIR)
      .filter((f) => /\.(gif|jpg|jpeg|png|webp)$/i.test(f))
      .map((f) => f.replace(/\.[^.]+$/, ''));
  } catch {
    return [];
  }
}

/** 给 AI 提示中可用的 face name + sticker 列表 */
export function getAvailableFaceHints(): {
  popular: string[];
  stickers: string[];
} {
  const popular = ['呲牙', '微笑', '哈哈', '笑哭', 'lol', '思考', '疑问', '吃瓜', '让我看看', '666', 'OK', '强', '喷血', '打脸', '摸鱼', '抓狂', '晕', '流泪', '坏笑', '可爱', '酷', '尴尬', '调皮', '鼓掌', '加油', '柠檬精', '我酸了'];
  const stickers = listLocalStickers().slice(0, 30);
  return { popular, stickers };
}

void ID_TO_NAME;

/** TTS 文本：去除所有表情/sticker 标记 */
export function stripStickerMarkers(text: string): string {
  return text
    .replace(/\[(?:face|表情|emoji|qq)[:：]\d+\]/gi, '')
    .replace(/\[sticker[:：]\s*[\w.-]+\]/gi, '')
    .replace(/\[(?:[\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]/g, (m) => {
      const inner = m.slice(1, -1);
      // 是 face 名/sticker 名才剥掉，否则留着（可能是用户自己的标签）
      if (FACE_NAME_TO_ID[inner] !== undefined || FACE_NAME_TO_ID[inner.toLowerCase()] !== undefined) return '';
      if (findStickerFile(inner)) return '';
      return m;
    });
}
