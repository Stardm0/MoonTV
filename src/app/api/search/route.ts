/* eslint-disable @typescript-eslint/no-explicit-any,no-console */
/**
 * 搜尋前繁→簡（繁化姬）＋簡體變體規範化（如：飚→飙），並做雙檢索合併去重。
 * 若繁化姬超時/失敗，會回退用原查詢繼續，確保不阻塞。
 *
 * 如需 API Key：在 Vercel 專案變數設 FANHUAJI_API_KEY。
 */

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

/** ---------------------------
 *  Fanhuaji（繁化姬）繁→簡
 *  ---------------------------
 */
async function toSimplified(input: string): Promise<string> {
  const text = (input ?? '').trim();
  if (!text) return input;

  // 短超時，避免拖慢整體
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s 超時

  try {
    const res = await fetch('https://api.zhconvert.org/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        converter: 'Simplified',
        apiKey: process.env.FANHUAJI_API_KEY ?? ''
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

/** ----------------------------------------
 *  簡體規範化（處理常見異寫字 → 通用寫法）
 *  目前主要解決：飚 → 飙（"狂飆" 有時會被轉成 "狂飚"）
 *  可按需擴充（保持最小侵入）
 *  ----------------------------------------
 */
function normalizeCNVariants(s: string): string {
  // 單字級規範化表（盡量保守，只處理高影響、低風險的字）
  const MAP: Record<string, string> = {
    '飚': '飙', // 常見網站索引用「飙」，不是「飚」
    // 如有需要可擴充：'裏': '里', '纟'...（此處先不動，以免過度影響）
  };
  if (!s) return s;
  let out = '';
  for (const ch of s) out += MAP[ch] ?? ch;
  return out;
}

/** 產生變體候選（用於雙檢索）。例如主查「飙」，備查「飚」。 */
function expandVariantQueries(q: string): string[] {
  const alts = new Set<string>();
  if (q.includes('飙')) alts.add(q.replaceAll('飙', '飚'));
  if (q.includes('飚')) alts.add(q.replaceAll('飚', '飙'));
  return [...alts];
}

/** 用於結果去重：以「簡體規範化後的標題 + 年份」合併 */
function dedupeKey(item: any): string {
  const title = typeof item?.title === 'string' ? item.title : '';
  const year = item?.year ?? '';
  return `${normalizeCNVariants(title)}#${year}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryRaw = searchParams.get('q') ?? '';
  const streamParam = searchParams.get('stream');

  // 判斷是否開啟流式
  const isBrowserLikeRequest = !!(
    request.headers.get('sec-fetch-mode') ||
    request.headers.get('sec-fetch-dest') ||
    request.headers.get('sec-fetch-site')
  );
  const enableStream = streamParam ? streamParam !== '0' : isBrowserLikeRequest;

  // 可選超時（秒）
  const timeoutParam = searchParams.get('timeout');
  const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined;

  const config = await getConfig();

  // 取得被啟用的搜索源（或按參數篩選）
  const selectedSourcesParam = searchParams.get('sources');
  let apiSites = config.SourceConfig.filter((site: any) => !site.disabled);
  if (selectedSourcesParam) {
    const selectedSources = selectedSourcesParam.split(',');
    apiSites = apiSites.filter((site: any) => selectedSources.includes(site.key));
  }

  // 空查詢直接返回
  if (!queryRaw.trim()) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        // 為避免誤判，搜尋一律不快取
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  }

  // --- 核心：繁→簡 + 規範化 + 變體擴展（雙檢索）
  const qCN = await toSimplified(queryRaw);
  const qMain = normalizeCNVariants(qCN);
  const qAlts = expandVariantQueries(qMain); // 針對飙/飚這類變體再搜一輪

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  let shouldStop = false;
  const abortSignal = (request as any).signal as AbortSignal | undefined;
  abortSignal?.addEventListener('abort', () => {
    shouldStop = true;
    try { writer.close(); } catch {}
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

  // -------- 非流式（一次回傳）---------
  if (!enableStream) {
    const tasks = apiSites.map(async (site: any) => {
      const siteResults: any[] = [];
      const seen = new Set<string>();
      let hasAny = false;

      // 在同一個站點做「主查 + 變體備查」，依序執行並去重
      const runOneQuery = async (q: string) => {
        const gen = searchFromApiStream(site, q, true, timeout);
        for await (const pageResults of gen) {
          let filtered = pageResults;

          if (filtered.length) hasAny = true;

          if (!config.SiteConfig.DisableYellowFilter) {
            filtered = filtered.filter((r: any) => {
              const t = r.type_name || '';
              return !yellowWords.some((w: string) => t.includes(w));
            });
          }

          for (const r of filtered) {
            const key = dedupeKey(r);
            if (!seen.has(key)) {
              seen.add(key);
              siteResults.push(r);
            }
          }
        }
      };

      try {
        await runOneQuery(qMain);
        for (const alt of qAlts) await runOneQuery(alt);

        if (!hasAny) throw new Error('无搜索结果');

        return { siteResults, failed: null };
      } catch (err: any) {
        let msg = err?.message || '未知的错误';
        if (msg === '请求超时') msg = '请求超时';
        else if (msg.includes('网络')) msg = '网络错误';
        return { siteResults: [], failed: { name: site.name, key: site.key, error: msg } };
      }
    });

    const results = await Promise.all(tasks);
    const aggregatedResults = results.flatMap(r => r.siteResults);
    const failedSources = results.filter(r => r.failed).map(r => r.failed);

    const body = isBrowserLikeRequest
      ? { aggregatedResults, failedSources }
      : { results: aggregatedResults, failedSources };

    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // 搜尋一律 no-store，避免舊快取造成誤判
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  }

  // -------- 流式回傳（邊搜邊推）---------
  (async () => {
    const aggregatedResults: any[] = [];
    const failedSources: { name: string; key: string; error: string }[] = [];

    const tasks = apiSites.map(async (site: any) => {
      const seen = new Set<string>();
      let hasAny = false;

      const runOneQuery = async (q: string) => {
        const gen = searchFromApiStream(site, q, true, timeout);
        for await (const pageResults of gen) {
          let filtered = pageResults;

          if (filtered.length) hasAny = true;

          if (!config.SiteConfig.DisableYellowFilter) {
            filtered = filtered.filter((r: any) => {
              const t = r.type_name || '';
              return !yellowWords.some((w: string) => t.includes(w));
            });
          }

          // 先站內去重，再輸出
          const unique = [];
          for (const r of filtered) {
            const key = dedupeKey(r);
            if (!seen.has(key)) {
              seen.add(key);
              aggregatedResults.push(r);
              unique.push(r);
            }
          }

          if (unique.length) {
            if (!(await safeWrite({ site: site.key, pageResults: unique }))) return;
          }
        }
      };

      try {
        await runOneQuery(qMain);
        for (const alt of qAlts) await runOneQuery(alt);

        if (!hasAny) {
          failedSources.push({ name: site.name, key: site.key, error: '无搜索结果' });
          await safeWrite({ failedSources });
        }
      } catch (err: any) {
        let msg = err?.message || '未知的错误';
        if (msg === '请求超时') msg = '请求超时';
        else if (msg.includes('网络')) msg = '网络错误';
        failedSources.push({ name: site.name, key: site.key, error: msg });
        await safeWrite({ failedSources });
      }
    });

    await Promise.allSettled(tasks);

    if (failedSources.length) {
      await safeWrite({ failedSources });
    }
    await safeWrite({ aggregatedResults });

    try { await writer.close(); } catch {}
  })();

  // 流式回應頭：亦改為 no-store，避免快取干擾測試
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    }
  });
}