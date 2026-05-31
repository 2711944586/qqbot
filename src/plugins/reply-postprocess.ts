import * as crypto from 'crypto';
import { sanitizeOutgoingText } from '../message-sanitize';

/**
 * 回复后处理模块
 * 从 ai-chat.ts 拆出
 * 清理 AI 输出的格式标签、舞台说明、Markdown，做长度截断和公式化开头去重
 */

function hashIndex(input: string, mod: number): number {
  const digest = crypto.createHash('sha1').update(input).digest();
  return digest[0] % Math.max(1, mod);
}

/** 去公式化开头 — 去掉"哥们,/兄弟们,/可以的,"等套话 */
export function deFormulaicOpening(text: string): string {
  const trimmed = text.trimStart();
  const match = trimmed.match(
    /^(?:不是哥们|不是，哥们|不是 哥们|哥们|兄弟们?|家人们|可以(?:的)?|有点东西|这波(?:有说法)?|有一说一|讲道理|说实话|看了一眼|简单说两句|先说结论|我的判断是|我只能说)[，,。!！?\s]+(.+)/s,
  );
  if (!match) return text;
  const rest = match[1].trimStart();
  if (!rest) return text;
  if (/^(?:你是不是|你是|我是|到底|bot|机器人|ai|AI)/.test(rest)) return text;
  if (/^(?:来了|收到|在|到|感谢|谢谢)/.test(rest)) return text;

  const replacements = ['等一下，', '这个不太对，', '先别急，', '', ''];
  const idx = hashIndex(rest, replacements.length);
  return `${replacements[idx]}${rest}`.trimStart();
}

/** 自然长度截断 — 超过maxLen时在最后一个句末标点截断 */
export function naturalLengthTrim(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cutoff = text.slice(0, maxLen);
  const lastPunct = Math.max(
    cutoff.lastIndexOf('。'),
    cutoff.lastIndexOf('！'),
    cutoff.lastIndexOf('!'),
    cutoff.lastIndexOf('？'),
    cutoff.lastIndexOf('?'),
    cutoff.lastIndexOf('\n'),
  );
  if (lastPunct > maxLen * 0.5) {
    return cutoff.slice(0, lastPunct + 1).trim();
  }
  const lastComma = Math.max(cutoff.lastIndexOf('，'), cutoff.lastIndexOf(','));
  if (lastComma > maxLen * 0.5) {
    return cutoff.slice(0, lastComma).trim();
  }
  return cutoff.trim();
}

/** 完整后处理 — AI 输出 → 清理后的最终文本 */
export function postProcessReply(text: string): string {
  text = text.trim();
  text = text.replace(
    /^[(（【\[]\s*(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|6657(?:风格|口吻)?|Machine(?:风格|口吻)?|拟态|风格参考|接弹幕|真人感|群聊回复|QQ?群回复|bot回复|机器人回复|第一人称(?:拟态)?|口吻)\s*[)）】\]]\s*[：:，,、-]?\s*/i,
    '',
  );
  text = text.replace(
    /(^|\n)\s*[(（【\[]\s*(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|6657(?:风格|口吻)?|Machine(?:风格|口吻)?|拟态|风格参考|接弹幕|真人感|群聊回复|QQ?群回复|bot回复|机器人回复|第一人称(?:拟态)?|口吻)\s*[)）】\]]\s*[：:，,、-]?\s*/gi,
    '$1',
  );
  text = text.replace(
    /^(?:直播口吻(?:接弹幕)?|玩机器(?:风格|口吻)?|拟态|风格参考|接弹幕|群聊回复|QQ?群回复)\s*[：:，,、-]\s*/i,
    '',
  );
  for (let i = 0; i < 3; i++) {
    text = text.replace(/^(?:结论|原因|建议|分析|总结|答案|短评|评价|判断|我的判断|先说结论)\s*[：:]\s*/i, '');
    text = text.replace(
      /^(?:根据|结合|参考)(?:上面|前面|知识库|素材|提示|资料|临场素材包|临场笔记|语态素材|话题素材)[^，。！？!?:：]{0,48}[，。:：]\s*/i,
      '',
    );
    text = text.replace(/^(?:我会|我将|下面|接下来)[^，。！？!?:：]{0,48}(?:回复|回答|接话|模仿)[：:，,。]\s*/i, '');
    text = text.replace(/^(?:我将用|以下以|下面用|作为(?:群)?bot)[^\n，。！？!?:：]{0,28}(?:回复|回答|接话)[：:，,。]?\s*/i, '');
    text = text.replace(/^(?:作为(?:一个)?(?:AI|机器人|bot|群bot|QQ群bot|助手))[^\n，。！？!?:：]{0,42}[：:，,。]?\s*/i, '');
    // 书面语开场词
    text = text.replace(/^(?:对此|总的来说|总而言之|首先|其次|再者|此外|另外|不过|然而|因此|所以)[，,]?\s*/i, '');
    text = text.replace(/^我个人(?:觉得|认为|以为)[，,]?\s*/i, '');
  }
  text = text.replace(/(?:根据|结合|参考)(?:知识库|素材|临场素材包|临场笔记|语态素材|话题素材)[，, ]*/g, '');
  text = text.replace(/(?:知识库|临场素材包|临场笔记|语态素材|话题素材)(?:里)?(?:显示|提到|说|给到)[，, ]*/g, '');
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, '').trim());
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/#{1,6}\s/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^(玩机器|机器|MachineWJQ)[：:]\s*/i, '');
  text = text.replace(/^["「『](.+)["」』]$/s, '$1');
  text = text.replace(/^[（(]\s*(.+?)\s*[）)]$/s, '$1');
  text = deFormulaicOpening(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^ +/gm, '');

  if (/^[\d\s.,，。!！?？]+$/.test(text)) {
    text = '我看到了 这句信息太少';
  } else if (/^[哈啊嗯哦额呃草艹wW6]+$/.test(text) && text.length <= 6) {
    text = '有点抽象 先看你想说啥';
  }

  if (text.length > 350) {
    text = naturalLengthTrim(text, 350);
  }

  // 去除重复 — 模型有时会把一句话说两遍
  text = removeDuplicates(text);

  // 修复标点 — 中英文标点混乱
  text = fixPunctuation(text);

  // 限制emoji数量 — 真人不会一句话堆10个emoji
  text = limitEmoji(text);

  return sanitizeOutgoingText(text).trim();
}

/** 去除内部重复段落（同一句话连续出现） */
function removeDuplicates(text: string): string {
  // 切分成句
  const parts = text.split(/([。！？!?\n]+)/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const punct = parts[i + 1] || '';
    if (!sentence.trim()) {
      result.push(sentence + punct);
      continue;
    }
    const normalized = sentence.trim().toLowerCase();
    // 太短的不算重复（"在""嗯""草"这种）
    if (normalized.length < 4) {
      result.push(sentence + punct);
      continue;
    }
    if (seen.has(normalized)) continue; // 跳过重复句
    seen.add(normalized);
    result.push(sentence + punct);
  }
  return result.join('');
}

/** 修复标点问题 */
function fixPunctuation(text: string): string {
  return text
    // 多个标点合并
    .replace(/[。.]{2,}/g, '。')
    .replace(/[!！]{3,}/g, '!!')
    .replace(/[?？]{3,}/g, '??')
    // 中英文标点混用 - 中文文字后用中文标点
    .replace(/([\u4e00-\u9fa5]),([\u4e00-\u9fa5])/g, '$1，$2')
    // 多余空格
    .replace(/  +/g, ' ')
    // 句末多余的空格
    .replace(/\s+([。！？!?，,])/g, '$1');
}

/** 限制emoji出现次数 - 真人不会堆emoji，玩机器尤其少 */
function limitEmoji(text: string): string {
  // 匹配大多数 emoji 范围
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F600}-\u{1F64F}]/gu;
  const matches = text.match(emojiRegex);
  if (!matches || matches.length <= 2) return text;
  // 超过2个 emoji 就只保留前2个
  let count = 0;
  return text.replace(emojiRegex, (m) => {
    count++;
    return count <= 2 ? m : '';
  });
}

/**
 * 把 AI 输出里的 [face:N] / [表情:N] / [emoji:N] 转成 QQ face segment
 * 返回 null 表示没有需要转换的，使用纯字符串发送即可
 */
export function parseFaceMarkers(text: string): import('../types').MessageSegment[] | null {
  if (!text) return null;
  // 检测是否含 [face:N]
  const faceRegex = /\[(?:face|表情|emoji|qq)[:：](\d{1,4})\]/gi;
  if (!faceRegex.test(text)) return null;
  faceRegex.lastIndex = 0;

  const segments: import('../types').MessageSegment[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let faceCount = 0;
  // 限制最多 2 个 face 防止刷屏
  const maxFaces = 2;

  while ((m = faceRegex.exec(text))) {
    if (m.index > lastIdx) {
      const chunk = text.slice(lastIdx, m.index);
      if (chunk) segments.push({ type: 'text', data: { text: chunk } });
    }
    if (faceCount < maxFaces) {
      const faceId = parseInt(m[1], 10);
      // QQ 经典 face id 一般在 0-358 范围，超过的视为无效
      if (!isNaN(faceId) && faceId >= 0 && faceId <= 600) {
        segments.push({ type: 'face', data: { id: String(faceId) } });
        faceCount++;
      }
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx);
    if (tail) segments.push({ type: 'text', data: { text: tail } });
  }

  // 合并相邻 text，去除空 text
  const merged: import('../types').MessageSegment[] = [];
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

/** TTS 语音文本截断 — 控制在maxChars内，找完整句末截断 */
export function clampVoiceText(text: string, maxChars: number): string {
  const cleaned = sanitizeOutgoingText(text)
    .replace(/\[(?:face|表情|emoji|qq)[:：]\d+\]/gi, '') // 去掉 face 标记，TTS 不发音
    .replace(/\[sticker[:：]\s*[\w.-]+\]/gi, '') // 贴纸 不发音
    .replace(/\[(?:[\u4e00-\u9fa5]{1,8}|[a-zA-Z\d!?]{2,16})\]/g, '') // 命名表情 不发音
    .replace(/\s+/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const firstSentence = cleaned.split(/[。！？!?；;\n]/).map((item) => item.trim()).find(Boolean) || cleaned;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, Math.max(10, maxChars - 1)).trim();
}

export function previewText(text: string, maxChars: number = 90): string {
  const cleaned = sanitizeOutgoingText(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function formatTime(timestamp: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '从未';
}
