import * as https from 'https';

/**
 * 轻量级联网搜索能力
 * 当检测到群友在问时事/热点/最新信息时，可以先搜索再回复
 */

interface SearchResult {
  title: string;
  snippet: string;
}

/** 使用DuckDuckGo Instant Answer API（无需key） */
export function webSearch(query: string): Promise<string> {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results: string[] = [];

          // Abstract（主要摘要）
          if (json.Abstract) {
            results.push(json.Abstract);
          }

          // Answer（直接答案）
          if (json.Answer) {
            results.push(json.Answer);
          }

          // RelatedTopics（相关话题）
          if (json.RelatedTopics && json.RelatedTopics.length > 0) {
            const topics = json.RelatedTopics.slice(0, 3);
            for (const topic of topics) {
              if (topic.Text) {
                results.push(topic.Text);
              }
            }
          }

          if (results.length > 0) {
            resolve(results.join('\n'));
          } else {
            resolve('');
          }
        } catch {
          resolve('');
        }
      });
    });

    req.on('error', () => resolve(''));
    req.setTimeout(3000, () => { req.destroy(); resolve(''); });
  });
}

/** 检测是否需要搜索（时事/热点/最新信息类问题） */
export function shouldSearch(text: string): boolean {
  // 现在始终返回true，因为搜索在ai-chat里已经始终执行了
  return true;
}
