import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AIConfig } from '../types';

/**
 * TTS语音合成 - 使用MiMo-V2.5-TTS
 * 通过 /v1/chat/completions 端点，model=mimo-v2.5-tts
 * 需要 assistant role 包含要合成的文本
 * 返回 base64 编码的 PCM 音频数据在 content 字段中
 */

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'voice_cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 调用TTS生成语音，返回本地文件路径(silk/pcm格式) */
export function generateVoice(config: AIConfig, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (text.length < 2 || text.length > 200) {
      resolve(null);
      return;
    }

    const url = new URL(config.api_url);
    const isHttps = url.protocol === 'https:';

    const body = JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: '请说' },
        { role: 'assistant', content: text },
      ],
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const transport = isHttps ? https : http;

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.error('[TTS] API错误:', json.error.message);
            resolve(null);
            return;
          }

          // 提取base64音频数据
          const audioBase64 = json.choices?.[0]?.message?.content;
          if (!audioBase64 || audioBase64.length < 100) {
            console.error('[TTS] 无音频数据');
            resolve(null);
            return;
          }

          // 解码base64为PCM buffer
          const pcmBuffer = Buffer.from(audioBase64, 'base64');

          // 保存为WAV文件（PCM 16bit 24000Hz mono）
          const filename = crypto.randomBytes(8).toString('hex') + '.wav';
          const filepath = path.join(CACHE_DIR, filename);
          const wavBuffer = pcmToWav(pcmBuffer, 24000, 16, 1);
          fs.writeFileSync(filepath, wavBuffer);

          if (wavBuffer.length < 200) {
            fs.unlinkSync(filepath);
            resolve(null);
          } else {
            resolve(filepath);
          }
        } catch (err) {
          console.error('[TTS] 解析失败:', err);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('[TTS] 网络错误:', err.message);
      resolve(null);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/** PCM数据转WAV文件格式 */
function pcmToWav(pcmData: Buffer, sampleRate: number, bitsPerSample: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const header = Buffer.alloc(headerSize);
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

/** 清理过期缓存 */
export function cleanVoiceCache(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    for (const file of files) {
      const filepath = path.join(CACHE_DIR, file);
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filepath);
      }
    }
  } catch { /* 静默 */ }
}

setInterval(cleanVoiceCache, 30 * 60 * 1000);
