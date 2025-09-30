/* eslint-disable @typescript-eslint/no-explicit-any,no-console */
/**
 * 本程式在搜尋前會呼叫繁化姬 API 將繁體關鍵字轉為簡體，以提升召回率。
 * Fanhuaji /convert 說明：GET/POST，必填參數 { text, converter: "Simplified" }，
 * 允許空 API 金鑰；詳見官方文件。
 * 若你有金鑰，可在 Vercel 專案變數中設定 FANHUAJI_API_KEY。
 */
import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

// --- Fanhuaji（繁化姬）繁→簡：若失敗則回傳原字串 ---
async function toSimplified(input: string): Promise<string> {
  const text = (input ?? '').trim();
  if (!text) return input;

  // 對繁化姬轉換做一個短超時，避免拖慢整體搜索
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 秒超時

  try {
    const res = await fetch('https://api.zhconvert.org/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        converter: 'Simplified', // 簡體化
        apiKey: process.env.FANHUAJI_API_KEY ?? '' // 允許空 Key；有就帶上
      }),
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timeoutId);

    if (!res.ok) return input;
    const json: any = await res.json();
    const converted = json?.data?.text;
    return typeof converted === 'string' && converted.length ? converted : input;
  } catch {
    clearTimeout(timeoutId);
    return input;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryRaw = searchParams.get('q');

  const streamParam = searchParams.get('stream');

  // 如果未显式指定 stream，且请求并非来自浏览器（无 sec-fetch-* 头），
  // 默认关闭流式以兼容原生客户端。浏览器默认流式，原生默认非流式。
  const isBrowserLikeRequest = !!(
    request.headers.get('sec-fetch-mode') ||
    request.headers.get('sec-fetch-dest') ||
    request.headers.get('sec-fetch-site')
  );
  const enableStream = streamParam ? streamParam !== '0' : isBrowserLikeRequest;

  // 可選超時（ms），會傳給下游各站搜索
  const timeoutParam = searchParams.get('timeout');
  const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined;

  const config = await getConfig();

  // 取得選中的搜索源
  const selectedSourcesParam = searchParams.get('sources');
  let apiSites = config.SourceConfig.filter((site: any) => !site.disabled);
  if (selectedSourcesParam) {
    const selectedSources = selectedSourcesParam.split(',');
    apiSites = apiSites.filter((site: any) => selectedSources.includes(site.key));
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  if (!queryRaw) {
    // 空查詢，明確不快取
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  }

  // ★★★ 關鍵改動：繁→簡 ★★★
  // 將使用者輸入的繁體關鍵字，先透過繁化姬轉為簡體以提高召回率
  // 若繁化姬失敗或超時，將回退使用原字串
  const query = await toSimplified(queryRaw);

  // 安全寫入與斷連處理
  let shouldStop = false;
  const abortSignal = (request as any).signal as AbortSignal | undefined;
  abortSignal?.addEventListener('abort', () => {
    shouldStop = true;
    try {
      writer.close();
    } catch {
      // ignore
    }
  });

  const safeWrite = async (obj: unknown) => {
    if (shouldStop || abortSignal?.aborted) return false;
    try {
      await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
      return true;
    } catch {
      shouldStop = true;
      return false;
    }
  };

  // -------------------------
  // 非流式：並發
  // -------------------------
  if (!enableStream) {
    const tasks = apiSites.map(async (site: any) => {
      const siteResults: any[] = [];
      let hasResults = false;
      try {
        const generator = searchFromApiStream(site, query, true, timeout);
        for await (const pageResults of generator) {
          let filteredResults = pageResults;

          if (filteredResults.length !== 0) {
            hasResults = true;
          }

          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = pageResults.filter((result: any) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }

          if (hasResults && filteredResults.length === 0) {
            throw new Error('结果被过滤');
          }

          siteResults.push(...filteredResults);
        }

        if (!hasResults) {
          throw new Error('无搜索结果');
        }

        return { siteResults, failed: null };
      } catch (err: any) {
        let errorMessage = err.message || '未知的错误';
        if (err.message === '请求超时') errorMessage = '请求超时';
        else if (err.message === '网络连接失败') errorMessage = '网络连接失败';
        else if (typeof err.message === 'string' && err.message.includes('网络错误')) errorMessage = '网络错误';

        return {
          siteResults: [],
          failed: { name: site.name, key: site.key, error: errorMessage }
        };
      }
    });

    const results = await Promise.all(tasks);
    const aggregatedResults = results.flatMap((r: any) => r.siteResults);
    const failedSources = results.filter((r: any) => r.failed).map((r: any) => r.failed);

    if (aggregatedResults.length === 0) {
      const body = isBrowserLikeRequest
        ? { aggregatedResults, failedSources }
        : { results: [], failedSources };

      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0'
        }
      });
    } else {
      const cacheTime = await getCacheTime();
      const body = isBrowserLikeRequest
        ? { aggregatedResults, failedSources }
        : { results: aggregatedResults, failedSources };

      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `private, max-age=${cacheTime}`
        }
      });
    }
  }

  // -------------------------
  // 流式：並發
  // -------------------------
  (async () => {
    const aggregatedResults: any[] = [];
    const failedSources: { name: string; key: string; error: string }[] = [];

    const tasks = apiSites.map(async (site: any) => {
      try {
        const generator = searchFromApiStream(site, query, true, timeout);
        let hasResults = false;

        for await (const pageResults of generator) {
          let filteredResults = pageResults;

          if (filteredResults.length !== 0) {
            hasResults = true;
          }

          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = pageResults.filter((result: any) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }

          if (hasResults && filteredResults.length === 0) {
            failedSources.push({ name: site.name, key: site.key, error: '结果被过滤' });
            await safeWrite({ failedSources });
            return;
          }

          aggregatedResults.push(...filteredResults);
          if (!(await safeWrite({ site: site.key, pageResults: filteredResults }))) {
            return;
          }
        }

        if (!hasResults) {
          failedSources.push({ name: site.name, key: site.key, error: '无搜索结果' });
          await safeWrite({ failedSources });
        }
      } catch (err: any) {
        console.warn(`搜索失败 ${site.name}:`, err?.message);
        let errorMessage = err?.message || '未知的错误';
        if (err?.message === '请求超时') errorMessage = '请求超时';
        else if (err?.message === '请求失败') errorMessage = '请求失败';
        else if (typeof err?.message === 'string' && err.message.includes('网络错误')) {
          errorMessage = '网络错误';
        }
        failedSources.push({ name: site.name, key: site.key, error: errorMessage });
        await safeWrite({ failedSources });
      }
    });

    // 等所有 site 跑完
    await Promise.allSettled(tasks);

    if (failedSources.length > 0) {
      await safeWrite({ failedSources });
    }

    await safeWrite({ aggregatedResults });

    try {
      await writer.close();
    } catch {
      // ignore
    }
  })();

  const cacheTime = await getCacheTime();
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `private, max-age=${cacheTime}`
    }
  });
}