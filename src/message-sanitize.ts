import { MessageSegment } from './types';

/** 统一出口清理：允许emoji，但不发送笑哭类表情/文本。 */
export function sanitizeOutgoingText(text: string): string {
  const cleaned = text
    .replace(/[😂🤣]/g, '')
    .replace(/笑哭/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+$/gm, '');
  return cleaned.trim().length === 0 && text.trim().length > 0
    ? '可以的'
    : cleaned;
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
