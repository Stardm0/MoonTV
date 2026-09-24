/**
 * Emby / Jellyfin 影库的**服务端请求**（只可被服务端路由引用）。
 *
 * 所有请求都带 `api_key`（服务端持有），浏览器侧只看到 `/api/emby`、
 * `/api/library-image`、播放直链三类地址。依赖只有 `fetch`，部署无关。
 */

import {
  type EmbyConfig,
  type EmbyItem,
  buildEmbySearchParams,
  mapEmbyDetailToResult,
  mapEmbyItemsToSearchResults,
} from './emby';
import type { SearchResult } from './types';
import { validateMediaUrl } from './url-guard';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 单次请求超时：家庭 NAS 冷启动慢，但太长会拖住页面 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 搜索最多取多少条（与 OpenList 的 SEARCH_PAGE_SIZE 对齐） */
const SEARCH_LIMIT = 24;

function checkBaseUrl(
  config: EmbyConfig
): { ok: true; base: string } | { ok: false; status: number; error?: string } {
  const base = normalizeBase(config?.baseUrl ?? '');
  if (!base) return { ok: false, status: 400, error: '缺少影库地址' };
  const guard = validateMediaUrl(base, undefined, {
    allowPrivateNetwork: config?.allowPrivateNetwork === true,
  });
  if (!guard.ok) return { ok: false, status: 403, error: guard.reason };
  return { ok: true, base };
}

/** Emby 地址归一（同 OpenList：补协议、去尾斜杠） */
function normalizeBase(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

/** 服务端 GET 一个 Emby JSON 接口 */
async function requestEmbyJson<T = any>(
  config: EmbyConfig,
  path: string,
  params: Record<string, string> = {}
): Promise<{ ok: boolean; status?: number; error?: string; data?: T }> {
  const checked = checkBaseUrl(config);
  if (!checked.ok) return checked;

  const url = new URL(`${checked.base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // api_key 统一在最后补，调用方不用重复传
  if (config.token) url.searchParams.set('api_key', config.token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: 502, error: `影库返回 ${response.status}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted ? '连接影库超时' : '无法连接影库',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 Emby 用户 ID。
 *
 * 部分接口（搜索、剧集展开）需要 userId；管理员没填时取第一个用户
 * （家庭影库几乎都是单用户部署）。
 */
export async function getEmbyUserId(config: EmbyConfig): Promise<string> {
  if (config.userId) return config.userId;
  const res = await requestEmbyJson<any[]>(config, '/Users');
  const first = Array.isArray(res.data) ? res.data.find((u) => u?.Id) : null;
  return first?.Id ? String(first.Id) : '';
}

/**
 * 用这份配置做一次连通性测试。
 *
 * 返回可读的文本（管理台测试按钮直接展示），顺便把解析到的 userId 带回去。
 */
export async function pingEmby(
  config: EmbyConfig
): Promise<{ ok: boolean; message: string; userId?: string }> {
  const checked = checkBaseUrl(config);
  if (!checked.ok) return { ok: false, message: checked.error ?? '配置无效' };

  const res = await requestEmbyJson<any[]>(config, '/Users');
  if (!res.ok) return { ok: false, message: res.error ?? '连接失败' };
  if (!Array.isArray(res.data)) return { ok: false, message: '影库响应异常' };

  const first = res.data.find((u) => u?.Id);
  return {
    ok: true,
    message: `连接成功：影库可访问${first?.Name ? `（用户 ${first.Name}）` : ''}`,
    userId: first?.Id ? String(first.Id) : undefined,
  };
}

/** 影库搜索：只收电影与剧集，映射成与在线源一致的 `SearchResult` */
export async function searchEmbyItems(
  config: EmbyConfig,
  query: string
): Promise<{ results: SearchResult[]; error?: string }> {
  const userId = await getEmbyUserId(config);
  if (!userId) return { results: [], error: '取不到影库用户' };

  const res = await requestEmbyJson<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(
    config,
    `/Users/${encodeURIComponent(userId)}/Items`,
    buildEmbySearchParams(query, SEARCH_LIMIT)
  );
  if (!res.ok) return { results: [], error: res.error };
  return { results: mapEmbyItemsToSearchResults(res.data?.Items) };
}

/** 影库详情：电影 → 单集；剧集 → 展开全部 Episode（自然序由 Emby 保证） */
export async function getEmbyDetail(
  config: EmbyConfig,
  itemId: string
): Promise<{ result: SearchResult | null; error?: string; status?: number }> {
  const userId = await getEmbyUserId(config);
  if (!userId) return { result: null, error: '取不到影库用户', status: 502 };

  const res = await requestEmbyJson<EmbyItem>(
    config,
    `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`,
    { Fields: 'MediaSources,Path' }
  );
  if (!res.ok) return { result: null, error: res.error, status: res.status };
  const item = res.data;
  if (!item?.Id) return { result: null, error: '影库里没有这个条目', status: 404 };

  // 剧集再展开 Episode 列表
  let episodeItems: EmbyItem[] | null = null;
  if (item.Type === 'Series') {
    const eps = await requestEmbyJson<{ Items?: EmbyItem[] }>(
      config,
      `/Shows/${encodeURIComponent(item.Id)}/Episodes`,
      { userId, Fields: 'MediaSources' }
    );
    if (!eps.ok) {
      return { result: null, error: eps.error ?? '展开剧集失败', status: eps.status };
    }
    episodeItems = eps.data?.Items ?? [];
  }

  const result = mapEmbyDetailToResult(item, episodeItems, {
    baseUrl: config.baseUrl,
    token: config.token,
  });
  if (!result) {
    return { result: null, error: '该条目没有可播放的媒体', status: 404 };
  }
  return { result };
}
