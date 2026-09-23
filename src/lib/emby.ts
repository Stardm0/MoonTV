/**
 * Emby / Jellyfin 私人影库适配层（纯函数，客户端与服务端共用）。
 *
 * ## 与 OpenList 适配的差异
 *
 * Emby 有真正的元数据（标题/年份/简介/海报），映射可以一一对应，
 * 不需要像 OpenList 那样从文件名里猜。
 *
 * ## 鉴权的现实约束
 *
 * Emby 的视频流与图片都靠 `api_key` 查询参数鉴权——`<video>` 标签带不了
 * 自定义请求头，所有第三方客户端（Infuse / Fileball /Emby 官方 Web）都是
 * 把 key 放在流地址里，本适配也遵循这一业界通行做法：
 *   - **API 调用与图片**：一律走服务端（`/api/emby`、`/api/library-image`），
 *     key 不出服务端；
 *   - **视频流地址**：直链带 `api_key`（否则浏览器无法播放）。
 * 若在意 key 暴露，可在 Emby 后台为站点单独发放低权限 API Key。
 *
 * 本文件只有纯函数；真实网络请求在 `emby.server.ts`。
 */

import { normalizeBaseUrl } from './openlist';
import type { SearchResult } from './types';

/** Emby 结果在搜索/播放链路里的来源代号，必须与 `/api/detail` 一致 */
export const EMBY_SOURCE = 'emby';

/** Emby 结果对外展示的来源名 */
export const EMBY_SOURCE_NAME = 'Emby 影库';

/** Emby / Jellyfin 连接配置（来自管理台站点级配置） */
export interface EmbyConfig {
  baseUrl: string;
  /** Emby API Key / Jellyfin API Token */
  token: string;
  /** 用户 ID；留空则服务端取第一个用户 */
  userId?: string;
  /** 自建部署访问局域网影库时显式开启 */
  allowPrivateNetwork?: boolean;
}

/** Emby 的媒体条目（`/Users/{uid}/Items` 的元素，只取用到的字段） */
export interface EmbyItem {
  Id?: string;
  Name?: string;
  Type?: string;
  /** Movie / Series / Episode … */
  MediaType?: string;
  ProductionYear?: number;
  Overview?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesName?: string;
  /** 媒体源：直链播放要用 MediaSources[].Id */
  MediaSources?: Array<{ Id?: string; Container?: string }>;
}

/** 图片走同源代理（服务端补 api_key，同时规避 http 影库在 https 页面的混合内容拦截） */
export const EMBY_IMAGE_ENDPOINT = '/api/library-image';

/**
 * 拼 Emby 图片代理地址。
 *
 * 图片不直连：站点级配置下浏览器不知道影库地址，直连还会遇到混合内容。
 */
export function buildEmbyImageUrl(itemId: string): string {
  if (!itemId) return '';
  return `${EMBY_IMAGE_ENDPOINT}?e=${encodeURIComponent(itemId)}`;
}

/** 是否为电影（可单集播放的条目） */
export function isEmbyMovie(item: EmbyItem): boolean {
  return item?.Type === 'Movie';
}

/** 是否为剧集（需再展开 Episode 列表） */
export function isEmbySeries(item: EmbyItem): boolean {
  return item?.Type === 'Series';
}

/**
 * 搜索/列表条目 → `SearchResult`。
 *
 * 电影 → 单集占位 `['']`（按「影」聚合）；剧集 → 空集数（按「剧」聚合），
 * 进播放页后再现取集数列表。
 */
export function mapEmbyItemsToSearchResults(items: unknown): SearchResult[] {
  if (!Array.isArray(items)) return [];
  const results: SearchResult[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as EmbyItem;
    if (!item.Id || !item.Name) continue;
    if (!isEmbyMovie(item) && !isEmbySeries(item)) continue;

    const isSeries = isEmbySeries(item);
    results.push({
      id: item.Id,
      title: item.Name,
      poster: buildEmbyImageUrl(item.Id),
      episodes: isSeries ? [] : [''],
      episodes_titles: [],
      source: EMBY_SOURCE,
      source_name: EMBY_SOURCE_NAME,
      class: isSeries ? '剧集' : '影片',
      year: item.ProductionYear ? String(item.ProductionYear) : '',
      desc: (item.Overview ?? '').slice(0, 200),
      type_name: isSeries ? '剧集' : '影片',
    });
  }
  return results;
}

/**
 * 拼视频直链。
 *
 * `static=true` 走原文件直连（转码流对边缘部署带宽要求太高，先不做）。
 * `api_key` 出现在 URL 是 Emby 生态的通行做法，见文件头说明。
 */
export function buildEmbyStreamUrl(
  baseUrl: string,
  itemId: string,
  apiKey: string,
  mediaSourceId?: string
): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !itemId || !apiKey) return '';
  const params = new URLSearchParams({
    static: 'true',
    api_key: apiKey,
  });
  if (mediaSourceId && mediaSourceId !== itemId) {
    params.set('mediaSourceId', mediaSourceId);
  }
  return `${base}/Videos/${encodeURIComponent(itemId)}/stream?${params.toString()}`;
}

/**
 * 详情条目 → `SearchResult`。
 *
 * @param item `/Users/{uid}/Items/{id}` 的返回
 * @param episodeItems 剧集的 Episode 列表（电影传 null）
 */
export function mapEmbyDetailToResult(
  item: EmbyItem,
  episodeItems: EmbyItem[] | null,
  config: { baseUrl: string; token: string }
): SearchResult | null {
  if (!item?.Id || !item?.Name) return null;

  const base = normalizeBaseUrl(config.baseUrl);
  const isSeries = isEmbySeries(item);

  let episodes: string[] = [];
  let episodeTitles: string[] = [];

  if (isSeries) {
    for (const ep of episodeItems ?? []) {
      if (!ep?.Id) continue;
      const url = buildEmbyStreamUrl(
        base,
        ep.Id,
        config.token,
        ep.MediaSources?.[0]?.Id
      );
      if (!url) continue;
      episodes.push(url);
      // 展示名带上季/集号：`S1E2` 的形式比裸文件名直观
      const season = ep.ParentIndexNumber ?? 1;
      const index = ep.IndexNumber ?? 0;
      const label = ep.Name ? ` ${ep.Name}` : '';
      episodeTitles.push(`S${season}E${index}${label}`);
    }
  } else {
    const url = buildEmbyStreamUrl(
      base,
      item.Id,
      config.token,
      item.MediaSources?.[0]?.Id
    );
    if (url) episodes = [url];
    episodeTitles = [item.Name];
  }

  if (episodes.length === 0) return null;

  return {
    id: item.Id,
    title: isSeries && item.SeriesName ? item.SeriesName : item.Name,
    poster: buildEmbyImageUrl(item.Id),
    episodes,
    episodes_titles: episodeTitles,
    source: EMBY_SOURCE,
    source_name: EMBY_SOURCE_NAME,
    class: isSeries ? '剧集' : '影片',
    year: item.ProductionYear ? String(item.ProductionYear) : '',
    desc: (item.Overview ?? '').slice(0, 200),
    type_name: isSeries ? '剧集' : '影片',
  };
}

/** 搜索请求的查询参数（服务端补 `api_key` 与 `userId`） */
export function buildEmbySearchParams(query: string, limit = 24): Record<string, string> {
  return {
    searchTerm: query,
    IncludeItemTypes: 'Movie,Series',
    Recursive: 'true',
    Limit: String(limit),
    Fields: 'ProductionYear,Overview',
  };
}
