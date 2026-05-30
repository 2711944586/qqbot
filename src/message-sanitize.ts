import { MessageSegment } from './types';

/** 统一出口清理：完全允许emoji，不做内容过滤；只做基础格式化。 */
export function sanitizeOutgoingText(text: string): string {
  const cleaned = softenFormulaicOpening(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+$/gm, '');
  return cleaned.trim().length === 0 && text.trim().length > 0
    ? '我在'
    : cleaned;
}

function softenFormulaicOpening(text: string): string {
  const leading = text.match(/^\s*/)?.[0] || '';
  const body = text.slice(leading.length);
  const match = body.match(/^(?:不是哥们|不是，哥们|不是 哥们|哥们|兄弟们?|家人们|可以(?:的)?|有点东西|这波(?:有说法)?|有一说一|讲道理|说实话|先说结论|我的判断是|我只能说|看了一眼|简单说两句)[，,。!！?\s]+(.+)/s);
  if (!match) return text;

  const rest = match[1].trimStart();
  if (!rest) return text;
  const usefulRest = rest.replace(/[，,。!！?？\s]/g, '');
  if (!usefulRest) return text;
  if (/^(?:你是不是|你是|我是|到底|bot|机器人|ai|AI)/.test(rest)) return text;
  if (/^(?:来了|收到|在|到|感谢|谢谢)/.test(rest)) return text;

  // 30%概率删除公式化开头让回复更自然
  const sum = Array.from(rest.slice(0, 16)).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  if (sum % 10 < 3) {
    return `${leading}${rest}`.trimStart();
  }
  return text;
}

export function sanitizeOutgoingMessage(message: string | MessageSegment[]): string | MessageSegment[] {
  if (typeof message === 'string') {
    return sanitizeOutgoingText(message);
  }
  return message.map((seg) => {
    if (seg.type !== 'text') return seg;
    return {
      ...seg,
      data: {
        ...seg.data,
        text: sanitizeOutgoingText(seg.data.text),
      },
    };
  });
}
