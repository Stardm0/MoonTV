/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream'; // 改用流式方法

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim();
    const timeoutParam = searchParams.get('timeout');
    const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined; // 转换为毫秒

    if (!query) {
      return NextResponse.json({ suggestions: [] });
    }

    const cacheTime = await getCacheTime();

    // 用 ReadableStream 流式返回搜索建议
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const suggestionsStream = generateSuggestionsStream(query, timeout);

        for await (const suggestions of suggestionsStream) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ suggestions }) + '\n')
          );
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `private, max-age=${cacheTime}`,
      },
    });
  } catch (error) {
    console.error('获取搜索建议失败', error);
    return NextResponse.json({ error: '获取搜索建议失败' }, { status: 500 });
  }
}

async function* generateSuggestionsStream(query: string, timeout?: number) {
  const queryLower = query.toLowerCase();
  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site: any) => !site.disabled);

  if (apiSites.length > 0) {
    // 使用第一个可用的数据源进行流式搜索
    const site = apiSites[0];
    
    for await (const results of searchFromApiStream(site, query, true, timeout)) {
      // 统计关键词出现频率
      const keywordFrequency = new Map<string, number>();
      const allKeywords = results
        .map((r: any) => r.title)
        .filter(Boolean)
        .flatMap((title: string) => title.split(/[ -:：·、-]/))
        .filter((w: string) => w.length > 1 && w.toLowerCase().includes(queryLower));
      
      allKeywords.forEach((word) => {
        const lower = word.toLowerCase();
        keywordFrequency.set(lower, (keywordFrequency.get(lower) || 0) + 1);
      });
      
      const realKeywords: string[] = Array.from(
        new Set(allKeywords)
      ).slice(0, 8);

      const realSuggestions = realKeywords.map((word) => {
        const wordLower = word.toLowerCase();
        const queryWords = queryLower.split(/[ -:：·、-]/);
        const frequency = keywordFrequency.get(wordLower) || 1;
        
        // 计算基础匹配分数
        let score = 1.0;
        if (wordLower === queryLower) {
          score = 3.0; // 完全匹配 - 最高优先级
        } else if (wordLower.startsWith(queryLower)) {
          score = 2.5; // 开头匹配 - 高优先级
        } else if (wordLower.endsWith(queryLower)) {
          score = 2.0; // 结尾匹配 - 中高优先级
        } else if (queryWords.some((qw) => wordLower.startsWith(qw))) {
          score = 1.8; // 包含查询词开头
        } else if (queryWords.some((qw) => wordLower.includes(qw))) {
          score = 1.5; // 包含查询词
        }
        
        // 长度相似度加分（长度接近查询的更相关）
        const lengthDiff = Math.abs(wordLower.length - queryLower.length);
        const lengthSimilarity = 1 / (1 + lengthDiff * 0.1);
        score += lengthSimilarity * 0.3;
        
        // 频率加分（出现次数多的更相关，但使用对数避免过度影响）
        const frequencyBonus = Math.log(frequency + 1) * 0.2;
        score += frequencyBonus;
        
        // 长度惩罚（过长的关键词稍微降权）
        if (wordLower.length > queryLower.length * 2) {
          score -= 0.2;
        }

        return { text: word, score, frequency };
      });

      const sortedSuggestions = realSuggestions
        .sort((a, b) => {
          // 首先按分数排序
          if (Math.abs(a.score - b.score) > 0.01) {
            return b.score - a.score;
          }
          // 分数相近时，按频率排序
          if (a.frequency !== b.frequency) {
            return b.frequency - a.frequency;
          }
          // 频率相同时，按长度排序（较短的优先）
          return a.text.length - b.text.length;
        })
        .map(({ text }) => ({ text })); // 只保留 text 字段

      // 每次 yield 一批建议
      yield sortedSuggestions;
    }
  }
}
