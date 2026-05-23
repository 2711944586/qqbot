import { sanitizeOutgoingText } from '../message-sanitize';

export const directTtsCommands = new Set(['voice', 'tts', 'say']);

export function normalizePassiveText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

export function isExplicitVoiceReplyRequest(text: string, command: string | null): boolean {
  if (command && directTtsCommands.has(command)) return true;
  const normalized = normalizePassiveText(text).toLowerCase();
  if (!normalized) return false;
  return /(?:用|发|来|整|给|回|回复|说|念|读|语音|voice|tts|say).{0,8}(?:语音|voice|tts|say|音频|声音|念出来|读出来)|(?:语音|voice|tts|say).{0,8}(?:回|回复|说|念|读|来|发|整|一下)/i.test(normalized);
}

export function extractVerbatimVoiceText(text: string, command: string | null): string {
  const raw = text.trim();
  if (!raw) return '';
  if (command && directTtsCommands.has(command)) return raw;
  if (/(?:语音|voice|tts|say)\s*(?:回答|分析|评价|解释|总结|查|搜|说说|聊聊|怎么看|怎么说)|(?:回答|分析|评价|解释|总结|说说|聊聊|怎么看|怎么说)\s*(?:.*?)(?:语音|voice|tts|say)/i.test(raw)) {
    return '';
  }

  const lead = String.raw`(?:(?:请|麻烦|帮我|给我|你(?:给我)?|可以|能不能|能否|直接|现在|马上|立刻|就|老哥|哥们儿?|哥们)\s*)*`;
  const patterns = [
    new RegExp(`^${lead}(?:用|发|来|整|给我)?\\s*(?:语音|voice|tts|say)\\s*(?:回复|回|说|念|读|念出来|读出来)?\\s*(?:一下|下)?[：:,，、\\s]+([\\s\\S]+)$`, 'i'),
    new RegExp(`^${lead}(?:用|发|来|整|给我)?\\s*(?:语音|voice|tts|say)\\s*(?:回复|回|说|念|读|念出来|读出来)?\\s*(?:一下|下)?([\\s\\S]+)$`, 'i'),
    new RegExp(`^${lead}(?:回复|回|说|念|读)\\s*(?:语音|voice|tts|say)\\s*(?:一下|下)?[：:,，、\\s]+([\\s\\S]+)$`, 'i'),
    new RegExp(`^${lead}(?:回复|回|说|念|读)\\s*(?:语音|voice|tts|say)\\s*(?:一下|下)?([\\s\\S]+)$`, 'i'),
    new RegExp(`^${lead}(?:念出来|读出来|念|读)\\s*(?:一下|下)?[：:,，、\\s]+([\\s\\S]+)$`, 'i'),
    new RegExp(`^${lead}(?:念出来|读出来)\\s*(?:一下|下)?([\\s\\S]+)$`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const candidate = (match[1] || '')
      .replace(/^(?:回复|回答)\s*(?:一下|下)?[：:,，、\s]*/i, '')
      .trim();
    if (!candidate) continue;
    if (/^(?:回答|分析|评价|怎么看|怎么说|帮我|告诉我|解释|查一下|搜一下|总结|评价一下)\b/i.test(candidate)) {
      return '';
    }
    return candidate;
  }
  return '';
}

export function splitVoiceTextForTts(text: string, maxChars: number, maxParts: number = 4): string[] {
  const cleaned = sanitizeOutgoingText(text)
    .replace(/\s+/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim();
  if (!cleaned) return [];
  const limit = Math.max(10, maxChars);
  const result: string[] = [];
  let rest = cleaned;
  while (rest.length > 0 && result.length < maxParts) {
    if (rest.length <= limit) {
      result.push(rest);
      break;
    }
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const match of window.matchAll(/[。！？!?；;，,、\s]/g)) {
      if (typeof match.index === 'number' && match.index >= Math.floor(limit * 0.45) && match.index <= limit) {
        cut = match.index + match[0].length;
      }
    }
    if (cut <= 1) cut = limit;
    const chunk = rest.slice(0, cut).trim();
    if (chunk.length >= 2) result.push(chunk);
    rest = rest.slice(cut).replace(/^[\s,，。！？!?.、；;]+/, '').trim();
  }
  return result.filter((item) => item.length >= 2);
}

export function stripVoiceReplyInstruction(text: string): string {
  return text
    .replace(/请?(?:用|发|来|整|给我)?\s*(?:语音|voice|tts|say)\s*(?:回(?:复)?|说|念|读|回答)?\s*(?:一下|下)?[：:,，、]?\s*/ig, '')
    .replace(/(?:用|发|来|整|给我)?\s*(?:语音|voice|tts|say)\s*(?:回复|回答|说|念|读|回我)?\s*/ig, '')
    .replace(/(?:回(?:复)?|回答)\s*(?:用)?\s*(?:语音|voice|tts|say)\s*/ig, '')
    .trim();
}
