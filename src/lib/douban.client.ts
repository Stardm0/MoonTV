/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { DoubanItem, DoubanResult } from './types';
import { getDoubanProxyUrl } from './utils';

interface DoubanCategoriesParams {
  kind: 'tv' | 'movie';
  category: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

interface DoubanListApiResponse {
  total: number;
  subjects: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    cover: string;
    rate: string;
  }>;
}

interface DoubanRecommandApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    year: string;
    type: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  fallbackProxy = false
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

  // 检查是否使用代理
  const proxyUrl = fallbackProxy
    ? 'https://cors-anywhere.com/'
    : getDoubanProxyUrl();
  const finalUrl = fallbackProxy
    ? `${proxyUrl}${url}`
    : proxyUrl
    ? `${proxyUrl}${encodeURIComponent(url)}`
    : url;

  const fetchOptions: RequestInit = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
    },
  };

  try {
    const response = await fetch(finalUrl, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * 检查是否应该使用客户端获取豆瓣数据
 */
export function shouldUseDoubanClient(): boolean {
  return getDoubanProxyUrl() !== null;
}

/**
 * 浏览器端豆瓣分类数据获取函数
 */
export async function fetchDoubanCategories(
  params: DoubanCategoriesParams,
  fallbackProxy = false
): Promise<DoubanResult> {
  const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!['tv', 'movie'].includes(kind)) {
    throw new Error('kind 参数必须是 tv 或 movie');
  }

  if (!category || !type) {
    throw new Error('category 和 type 参数不能为空');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;

  try {
    const response = await fetchWithTimeout(target, fallbackProxy);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const doubanData: DoubanCategoryApiResponse = await response.json();

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    // 触发全局错误提示
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('globalError', {
          detail: { message: '获取豆瓣分类数据失败' },
        })
      );
    }
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}

/**
 * 统一的豆瓣分类数据获取函数，根据代理设置选择使用服务端 API 或客户端代理获取
 */
export async function getDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanCategories(params);
  } else {
    // 使用服务端 API（当没有设置代理 URL 时）
    const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;
    const response = await fetch(
      `/api/douban/categories?kind=${kind}&category=${category}&type=${type}&limit=${pageLimit}&start=${pageStart}`
    );

    if (!response.ok) {
      return fetchDoubanCategories(params, true);
    }

    return response.json();
  }
}

interface DoubanListParams {
  tag: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

export async function getDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanList(params);
  } else {
    const response = await fetch(
      `/api/douban?tag=${tag}&type=${type}&pageSize=${pageLimit}&pageStart=${pageStart}`
    );

    if (!response.ok) {
      return fetchDoubanList(params, true);
    }

    return response.json();
  }
}

export async function fetchDoubanList(
  params: DoubanListParams,
  fallbackProxy = false
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!tag || !type) {
    throw new Error('tag 和 type 参数不能为空');
  }

  if (!['tv', 'movie'].includes(type)) {
    throw new Error('type 参数必须是 tv 或 movie');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;

  try {
    const response = await fetchWithTimeout(target, fallbackProxy);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const doubanData: DoubanListApiResponse = await response.json();

    // 转换数据格式
    const list: DoubanItem[] = doubanData.subjects.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.cover,
      rate: item.rate,
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    // 触发全局错误提示
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('globalError', {
          detail: { message: '获取豆瓣列表数据失败' },
        })
      );
    }
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}

interface DoubanRecommandsParams {
  kind: 'tv' | 'movie';
  pageLimit?: number;
  pageStart?: number;
  category?: string;
  format?: string;
  region?: string;
  year?: string;
  platform?: string;
  sort?: string;
}

export async function getDoubanRecommands(
  params: DoubanRecommandsParams
): Promise<DoubanResult> {
  const {
    kind,
    pageLimit = 20,
    pageStart = 0,
    category,
    format,
    region,
    year,
    platform,
    sort,
  } = params;
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanRecommands(params);
  } else {
    const response = await fetch(
      `/api/douban/recommands?kind=${kind}&limit=${pageLimit}&start=${pageStart}&category=${category}&format=${format}&region=${region}&year=${year}&platform=${platform}&sort=${sort}`
    );

    if (!response.ok) {
      return fetchDoubanRecommands(params, true);
    }

    return response.json();
  }
}

async function fetchDoubanRecommands(
  params: DoubanRecommandsParams,
  fallbackProxy = false
): Promise<DoubanResult> {
  const { kind, pageLimit = 20, pageStart = 0 } = params;
  let { category, format, region, year, platform, sort } = params;
  if (category === 'all') {
    category = '';
  }
  if (format === 'all') {
    format = '';
  }
  if (region === 'all') {
    region = '';
  }
  if (year === 'all') {
    year = '';
  }
  if (platform === 'all') {
    platform = '';
  }
  if (sort === 'T') {
    sort = '';
  }

  const selectedCategories = { 类型: category } as any;
  if (format) {
    selectedCategories['形式'] = format;
  }
  if (region) {
    selectedCategories['地区'] = region;
  }

  const tags = [] as Array<string>;
  if (category) {
    tags.push(category);
  }
  if (!category && format) {
    tags.push(format);
  }
  if (region) {
    tags.push(region);
  }
  if (year) {
    tags.push(year);
  }
  if (platform) {
    tags.push(platform);
  }

  const baseUrl = `https://m.douban.com/rexxar/api/v2/${kind}/recommend`;
  const reqParams = new URLSearchParams();
  reqParams.append('refresh', '0');
  reqParams.append('start', pageStart.toString());
  reqParams.append('count', pageLimit.toString());
  reqParams.append('selected_categories', JSON.stringify(selectedCategories));
  reqParams.append('uncollect', 'false');
  reqParams.append('score_range', '0,10');
  reqParams.append('tags', tags.join(','));
  if (sort) {
    reqParams.append('sort', sort);
  }
  const target = `${baseUrl}?${reqParams.toString()}`;
  console.log(target);
  try {
    const response = await fetchWithTimeout(target, fallbackProxy);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const doubanData: DoubanRecommandApiResponse = await response.json();
    const list: DoubanItem[] = doubanData.items
      .filter((item) => item.type == 'movie' || item.type == 'tv')
      .map((item) => ({
        id: item.id,
        title: item.title,
        poster: item.pic?.normal || item.pic?.large || '',
        rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
        year: item.year,
      }));

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    throw new Error(`获取豆瓣推荐数据失败: ${(error as Error).message}`);
  }
}
