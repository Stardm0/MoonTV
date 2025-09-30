/* eslint-disable @typescript-eslint/no-explicit-any,no-console */
/**
 * 功能：
 * 1) 搜索前先用「繁化姬」把繁體關鍵字轉簡體（超時/失敗自動回退原字串）
 * 2) 對簡體做「變體規範化」（例如：飚 → 飙）
 * 3) 在每個源站做「主查 + 變體備查」並合併去重（解決“狂飆/狂飙/狂飚”差異）
 * 4) 兼容流式與非流式；為避免快取干擾，搜尋回應一律 no-store
 *
 * 若你有 Fanhuaji 金鑰，在 Vercel 專案變數設 FANHUAJI_API_KEY 即可；空值也能用。
 */
import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

/** ---------------------------
 *  Fanhuaji（繁化姬）繁→簡（4s 超時）
 *  ---------------------------
 */
async function toSimplified(input: string): Promise<string> {
  const text = (input ?? '').trim();
  if (!text) return input;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);

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
    clearTimeout(tid);
    if (!res.ok) return input;
    const json: any = await res.json();
    const converted = json && json.data && json.data.text;
    return typeof converted === 'string' && converted.length ? converted : input;
  } catch {
    clearTimeout(tid);
    return input;
  }
}

/** 簡單的「全字串替換」（避免使用 replaceAll 造成 TS/lib 兼容問題） */
function replaceAllChar(s: string, from: string, to: string): string {
  if (!s || from === to) return s;
  // 用 split/join 兼容舊環境
  return s.split(from).join(to);
}

/** ----------------------------------------
 *  簡體變體規範化（高影響低風險字）
 *  目前重點：飚 → 飙（站點索引常用“飙”）
 *  ----------------------------------------
 */
function normalizeCNVariants(s: string): string {
  if (!s) return s;
  let out = s;
  out = replaceAllChar(out, '飚', '飙');
  return out;
}

/** 擴展變體候選：主查用規範化字串，備查用對稱變體 */
function expandVariantQueries(q: string): string[] {
  const set: Record<string, true> = {};
  if (q.indexOf('飙') >= 0) set[replaceAllChar(q, '飙', '飚')] = true;
  if (q.indexOf('飚') >= 0) set[replaceAllChar(q, '飚', '飙')] = true;
  return Object.keys(set);
}

/** 結果去重鍵：以「規範化後的簡體標題 + 年份」合併 */
function dedupeKey(item: any): string {
  const title = typeof item?.title === 'string' ? item.title : '';
  const year = item?.year ?? '';
  return `${normalizeCNVariants(title)}#${year}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryRaw = searchParams.get('q') ?? '';

  // 是否流式
  const streamParam = searchParams.get('stream');
  const isBrowserLike = !!(
    request.headers.get('sec-fetch-mode') ||
    request.headers.get('sec-fetch-dest') ||
    request.headers.get('sec-fetch-site')
  );
  const enableStream = streamParam ? streamParam !== '0' : isBrowserLike;

  // 下游超時（秒）
  const timeoutParam = searchParams.get('timeout');
  const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined;

  const config = await getConfig();

  // 啟用的源（可被 ?sources=a,b 覆蓋）
  const selected = searchParams.get('sources');
  let apiSites = config.SourceConfig.filter((s: any) => !s.disabled);
  if (selected) {
    const arr = selected.split(',');
    apiSites = apiSites.filter((s: any) => arr.includes(s.key));
  }

  // 空查詢
  if (!queryRaw.trim()) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  }

  // --- 核心：繁→簡 + 規範化 + 變體備查
  const qCN = await toSimplified(queryRaw);
  const qMain = normalizeCNVariants(qCN);
  const qAlts = expandVariantQueries(qMain);

  // ========== 非流式 ==========
  if (!enableStream) {
    const perSite = apiSites.map(async (site: any) => {
      const siteResults: any[] = [];
      const seen = new Set<string>();
      let hasAny = false;

      // 同一站點：先跑主查，再跑變體
      const runOne = async (q: string) => {
        const gen = searchFromApiStream(site, q, true, timeout);
        for await (const page of gen) {
          let arr = page;
          if (arr.length) hasAny = true;

          if (!config.SiteConfig.DisableYellowFilter) {
            arr = arr.filter((r: any) => {
              const t = r?.type_name ?? '';
              for (let i = 0; i < yellowWords.length; i++) {
                if (t.includes(yellowWords[i])) return false;
              }
              return true;
            });
          }

          for (let i = 0; i < arr.length; i++) {
            const r = arr[i];
            const key = dedupeKey(r);
            if (!seen.has(key)) {
              seen.add(key);
              siteResults.push(r);
            }
          }
        }
      };

      try {
        await runOne(qMain);
        for (let i = 0; i < qAlts.length; i++) await runOne(qAlts[i]);

        if (!hasAny) throw new Error('无搜索结果');
        return { siteResults, failed: null };
      } catch (e: any) {
        let msg = e?.message || '未知的错误';
        if (msg === '请求超时') msg = '请求超时';
        else if (typeof msg === 'string' && msg.indexOf('网络') >= 0) msg = '网络错误';
        return { siteResults: [], failed: { name: site.name, key: site.key, error: msg } };
      }
    });

    const results = await Promise.all(perSite);
    const aggregatedResults = results.flatMap((r) => r.siteResults);
    const failedSources = results.filter((r) => r.failed).map((r) => r.failed);

    const body = isBrowserLike
      ? { aggregatedResults, failedSources }
      : { results: aggregatedResults, failedSources };

    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  }

  // ========== 流式（NDJSON）==========
  const encoder = new TextEncoder();
  const stream = new TransformStream(); // TS 只做型別，Edge/Node18 皆支持
  const writer = stream.writable.getWriter();

  let stopped = false;
  const abortSignal: any = (request as any).signal;
  if (abortSignal && typeof abortSignal.addEventListener === 'function') {
    abortSignal.addEventListener('abort', () => {
      stopped = true;
      try { writer.close(); } catch {}
    });
  }

  const safeWrite = async (obj: unknown) => {
    if (stopped || (abortSignal && abortSignal.aborted)) return false;
    try {
      await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
      return true;
    } catch {
      stopped = true;
      return false;
    }
  };

  (async () => {
    const aggregatedResults: any[] = [];
    const failedSources: { name: string; key: string; error: string }[] = [];

    const jobs = apiSites.map(async (site: any) => {
      const seen = new Set<string>();
      let hasAny = false;

      const runOne = async (q: string) => {
        const gen = searchFromApiStream(site, q, true, timeout);
        for await (const page of gen) {
          let arr = page;
          if (arr.length) hasAny = true;

          if (!config.SiteConfig.DisableYellowFilter) {
            arr = arr.filter((r: any) => {
              const t = r?.type_name ?? '';
              for (let i = 0; i < yellowWords.length; i++) {
                if (t.includes(yellowWords[i])) return false;
              }
              return true;
            });
          }

          const unique: any[] = [];
          for (let i = 0; i < arr.length; i++) {
            const r = arr[i];
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
        await runOne(qMain);
        for (let i = 0; i < qAlts.length; i++) await runOne(qAlts[i]);
        if (!hasAny) {
          failedSources.push({ name: site.name, key: site.key, error: '无搜索结果' });
          await safeWrite({ failedSources });
        }
      } catch (e: any) {
        let msg = e?.message || '未知的错误';
        if (msg === '请求超时') msg = '请求超时';
        else if (typeof msg === 'string' && msg.indexOf('网络') >= 0) msg = '网络错误';
        failedSources.push({ name: site.name, key: site.key, error: msg });
        await safeWrite({ failedSources });
      }
    });

    await Promise.allSettled(jobs);

    if (failedSources.length) await safeWrite({ failedSources });
    await safeWrite({ aggregatedResults });

    try { await writer.close(); } catch {}
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    }
  });
}