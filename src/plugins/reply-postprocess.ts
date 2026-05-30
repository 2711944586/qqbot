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

  return sanitizeOutgoingText(text).trim();
}

/** TTS 语音文本截断 — 控制在maxChars内，找完整句末截断 */
export function clampVoiceText(text: string, maxChars: number): string {
  const cleaned = sanitizeOutgoingText(text)
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
