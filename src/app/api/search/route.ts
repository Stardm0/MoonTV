/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { EMBY_SOURCE, EMBY_SOURCE_NAME } from '@/lib/emby';
import { searchEmbyItems } from '@/lib/emby.server';
import { toEmbyConfig, toOpenListConfig } from '@/lib/media-library';
import { resolveMediaLibraryPolicy } from '@/lib/media-library.server';
import {
  type OpenListConfig,
  mapOpenListSearchItems,
  OPENLIST_SOURCE,
  OPENLIST_SOURCE_NAME,
  parseOpenListConfigFromCookieHeader,
  requestOpenList,
} from '@/lib/openlist';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

interface SearchFailure {
  name: string;
  key: string;
  error: string;
}

/**
 * 搜私人影库并转成与 Apple CMS 一致的 `SearchResult`。
 *
 * 未配置影库时静默返回空（不是错误，用户只是没接影库）；
 * 配置了但搜不出来才进 `failedSources`，提示里点出「索引」这个最常见原因——
 * OpenList 默认不做索引，没在「设置 → 索引」里建过就搜不到东西。
 *
 * 连接配置取「个人 cookie 优先、管理员站点级配置兜底」，与 `/api/detail` 一致；
 * 站点级配置的类型（OpenList / Emby）决定走哪个适配器。
 */
async function searchPrivateLibrary(
  cookieHeader: string | null,
  query: string
): Promise<{ results: any[]; failed: SearchFailure | null }> {
  // 站点级影库可能禁止个人覆盖，所以先问策略再决定要不要读 cookie
  const { server: serverConfig, allowPersonalOverride } =
    await resolveMediaLibraryPolicy();

  // 个人 cookie 只可能是 OpenList
  const personal = allowPersonalOverride
    ? parseOpenListConfigFromCookieHeader(cookieHeader)
    : null;
  if (personal?.baseUrl) return searchOpenListLibrary(personal, query);

  if (!serverConfig) return { results: [], failed: null };

  if (serverConfig.Type === 'emby') {
    return searchEmbyLibrary(serverConfig, query);
  }
  return searchOpenListLibrary(toOpenListConfig(serverConfig), query);
}

/** OpenList 影库搜索（需要影库已建立索引） */
async function searchOpenListLibrary(
  config: OpenListConfig | null,
  query: string
): Promise<{ results: any[]; failed: SearchFailure | null }> {
  if (!config || !config.baseUrl) return { results: [], failed: null };

  const rootPath = config.rootPath || '/';
  const response = await requestOpenList(config, 'search', rootPath, query);

  if (!response.ok) {
    return {
      results: [],
      failed: {
        name: OPENLIST_SOURCE_NAME,
        key: OPENLIST_SOURCE,
        error: `${response.error ?? '影库搜索失败'}（需先在影库「设置 → 索引」建立索引）`,
      },
    };
  }

  // HTTP 200 但业务码非 200：未开启索引时 OpenList 就是这种返回
  const payload = response.data as { code?: number; message?: string; data?: { content?: unknown } } | null;
  if (payload && typeof payload.code === 'number' && payload.code !== 200) {
    return {
      results: [],
      failed: {
        name: OPENLIST_SOURCE_NAME,
        key: OPENLIST_SOURCE,
        error: `${payload.message || '影库搜索失败'}（需先在影库「设置 → 索引」建立索引）`,
      },
    };
  }

  return {
    results: mapOpenListSearchItems(payload?.data?.content, rootPath),
    failed: null,
  };
}

/** Emby / Jellyfin 影库搜索（有元数据，直接按标题搜） */
async function searchEmbyLibrary(
  config: unknown,
  query: string
): Promise<{ results: any[]; failed: SearchFailure | null }> {
  const embyConfig = toEmbyConfig(config as Parameters<typeof toEmbyConfig>[0]);
  if (!embyConfig?.baseUrl) return { results: [], failed: null };

  const { results, error } = await searchEmbyItems(embyConfig, query);
  if (error) {
    return {
      results: [],
      failed: {
        name: EMBY_SOURCE_NAME,
        key: EMBY_SOURCE,
        error: `${error}（请检查管理台里的地址与 API Key）`,
      },
    };
  }
  return { results, failed: null };
}

export async function GET(request: NextRequest) {
  // 检查是否为本地存储模式
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const isLocalStorage = storageType === 'localstorage';
  
  let authInfo = null;
  if (!isLocalStorage) {
    // 非本地存储模式才需要认证
    authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const streamParam = searchParams.get('stream');
  const enableStream = streamParam ? streamParam !== '0' : false; // 无该参数关闭流式
  const timeoutParam = searchParams.get('timeout');
  const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined; // 转换为毫秒

  const config = await getConfig();
  
  // 获取用户可用的搜索源
  let apiSites = await getAvailableApiSites(authInfo?.username);
  
  // 如果指定了搜索源，只使用选中的搜索源
  const selectedSourcesParam = searchParams.get('sources');
  if (selectedSourcesParam) {
    const selectedSources = selectedSourcesParam.split(',');
    apiSites = apiSites.filter(site => selectedSources.includes(site.key));
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  if (!query) {
    // 空查询，明确不缓存
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  }

  // 安全写入与断连处理
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
  // 非流式：并发
  // -------------------------
  if (!enableStream) {
    const tasks = apiSites.map(async (site) => {
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
            filteredResults = pageResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word) => typeName.includes(word));
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
        
        // 根据错误类型提供更具体的错误信息
        if (err.message === '请求超时') {
          errorMessage = '请求超时';
        } else if (err.message === '请求失败') {
          errorMessage = '请求失败';
        } else if (err.message?.includes('网络错误')) {
          errorMessage = '网络错误';
        }
        
        return {
          siteResults: [],
          failed: { name: site.name, key: site.key, error: errorMessage },
        };
      }
    });

    // 用户显式挑过搜索源时只搜挑中的源（影库不在源列表里），否则并入影库结果
    const libraryTask: Promise<{ siteResults: any[]; failed: SearchFailure | null }> =
      selectedSourcesParam
        ? Promise.resolve({ siteResults: [], failed: null })
        : searchPrivateLibrary(request.headers.get('cookie'), query).then((r) => ({
            siteResults: r.results,
            failed: r.failed,
          }));

    const results = await Promise.all([...tasks, libraryTask]);
    const aggregatedResults = results.flatMap((r) => r.siteResults);
    const failedSources = results
      .filter((r) => r.failed)
      .map((r) => r.failed as SearchFailure);

    if (aggregatedResults.length === 0) {
      const body = { results: [], failedSources };
      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
      });
    } else {
      const cacheTime = await getCacheTime();
      const body = { results: aggregatedResults, failedSources };
      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `private, max-age=${cacheTime}`,
        },
      });
    }
  }

  // -------------------------
  // 流式：并发
  // -------------------------
  (async () => {
    const aggregatedResults: any[] = [];
    const failedSources: { name: string; key: string; error: string }[] = [];

    const siteTasks: Promise<void>[] = apiSites.map(async (site) => {
      try {
        const generator = searchFromApiStream(site, query, true, timeout);
        let hasResults = false;

        for await (const pageResults of generator) {
          let filteredResults = pageResults;
          if (filteredResults.length !== 0) {
            hasResults = true;
          }
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = pageResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word) => typeName.includes(word));
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
        console.warn(`搜索失败 ${site.name}:`, err.message);
        let errorMessage = err.message || '未知的错误';
        
        // 根据错误类型提供更具体的错误信息
        if (err.message === '请求超时') {
          errorMessage = '请求超时';
        } else if (err.message === '请求失败') {
          errorMessage = '请求失败';
        } else if (err.message.includes('网络错误')) {
          errorMessage = '网络错误';
        }
        
        failedSources.push({ name: site.name, key: site.key, error: errorMessage });
        await safeWrite({ failedSources });
      }
    });

    // 影库搜索作为一路并发（用户挑过源时不并入）
    const libraryTask: Promise<void> = selectedSourcesParam
      ? Promise.resolve()
      : (async () => {
          const { results, failed } = await searchPrivateLibrary(
            request.headers.get('cookie'),
            query
          );
          if (results.length > 0) {
            aggregatedResults.push(...results);
            await safeWrite({ site: OPENLIST_SOURCE, pageResults: results });
          }
          if (failed) {
            failedSources.push(failed);
            await safeWrite({ failedSources });
          }
        })();

    // 等所有 site 跑完
    await Promise.allSettled([...siteTasks, libraryTask]);

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
      'Cache-Control': `private, max-age=${cacheTime}`,
    },
  });
}
