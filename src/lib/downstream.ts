import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;

/** 封装带超时的 fetch，区分超时和网络错误 */
async function fetchWithTimeout(url: string, options: RequestInit, timeout = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    // 区分超时错误和网络错误
    if (error.name === 'AbortError') {
      throw new Error('请求超时');
    } else if (error.message?.includes('Failed to fetch') || error.message?.includes('fetch failed') || error.message?.includes('NetworkError')) {
      throw new Error('请求失败');
    } else {
      throw new Error(`网络错误: ${error.message || '未知错误'}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 通用的播放源解析
 * 支持：
 *  1. vod_play_url (通过 $$$、#、$ 分割)
 *  2. 内容中的 m3u8 链接（正则提取）
 */
function parseEpisodes(vod_play_url?: string, fallbackContent?: string): { episodes: string[]; titles: string[] } {
  let episodes: string[] = [];
  let titles: string[] = [];

  // 1. 优先解析 vod_play_url
  if (vod_play_url) {
    const sources = vod_play_url.split('$$$');
    sources.forEach((source) => {
      const currentEpisodes: string[] = [];
      const currentTitles: string[] = [];

      source.split('#').forEach((entry) => {
        const [title, url] = entry.split('$');
        if (url?.endsWith('.m3u8')) {
          currentTitles.push(title);
          currentEpisodes.push(url);
        }
      });

      // 选用分集最多的播放源
      if (currentEpisodes.length > episodes.length) {
        episodes = currentEpisodes;
        titles = currentTitles;
      }
    });
  }

  // 2. 如果没有解析到，尝试 fallback 内容
  if (episodes.length === 0 && fallbackContent) {
    episodes = (fallbackContent.match(M3U8_PATTERN) ?? []).map((link: string) =>
      link.replace(/^\$/, '')
    );
    titles = episodes.map((_, i) => (i + 1).toString()); // 默认用序号作为标题
  }

  return { episodes, titles };
}

/** 映射 API 数据到 SearchResult */
function mapItemToResult(item: ApiSearchItem, apiSite: ApiSite, apiName: string): SearchResult {
  const { episodes, titles } = parseEpisodes(item.vod_play_url, item.vod_content);

  return {
    id: item.vod_id.toString(),
    title: item.vod_name.trim().replace(/\s+/g, ' '),
    poster: item.vod_pic,
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiName,
    class: item.vod_class,
    year: item.vod_year?.match(/\d{4}/)?.[0] || 'unknown',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: item.type_name,
    douban_id: item.vod_douban_id,
  };
}

/** API 搜索流 */
export async function* searchFromApiStream(
  apiSite: ApiSite,
  query: string,
  parallel = true,
  timeout?: number
): AsyncGenerator<SearchResult[], void, unknown> {
  const apiUrl = apiSite.api + API_CONFIG.search.path + encodeURIComponent(query);

  const response = await fetchWithTimeout(apiUrl, { headers: API_CONFIG.search.headers }, timeout);
  if (!response.ok) return;

  const data = await response.json();
  if (!Array.isArray(data?.list)) return;

  // 第一页
  yield data.list.map((item: ApiSearchItem) => mapItemToResult(item, apiSite, apiSite.name));

  // 分页
  const { SiteConfig } = await getConfig();
  const maxPages = SiteConfig.SearchDownstreamMaxPage;
  const pageCount = data.pagecount || 1;
  const pagesToFetch = Math.min(pageCount, maxPages);

  if (pagesToFetch > 1) {
    if (parallel) {
      // ------------------ 并行模式 ------------------
      const pagePromises: Promise<{ page: number; results: SearchResult[] } | null>[] = [];

      for (let page = 2; page <= pagesToFetch; page++) {
        const pageUrl =
          apiSite.api +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const promise = (async () => {
          const pageRes = await fetchWithTimeout(pageUrl, { headers: API_CONFIG.search.headers }, timeout);
          if (!pageRes.ok) return null;

          const pageData = await pageRes.json();
          if (!Array.isArray(pageData?.list)) return null;

          const results = pageData.list.map((item: ApiSearchItem) =>
            mapItemToResult(item, apiSite, apiSite.name)
          );
          return { page, results };
        })();

        pagePromises.push(promise);
      }

      const settled = await Promise.all(pagePromises);
      for (const res of settled
        .filter((r): r is { page: number; results: SearchResult[] } => !!r && r.results.length > 0)
        .sort((a, b) => a.page - b.page)) {
        yield res.results;
      }
    } else {
      // ------------------ 顺序模式 ------------------
      for (let page = 2; page <= pagesToFetch; page++) {
        const pageUrl =
          apiSite.api +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const pageRes = await fetchWithTimeout(pageUrl, { headers: API_CONFIG.search.headers }, timeout);
        if (!pageRes.ok) continue;

        const pageData = await pageRes.json();
        if (Array.isArray(pageData?.list)) {
          const results = pageData.list.map((item: ApiSearchItem) =>
            mapItemToResult(item, apiSite, apiSite.name)
          );
          if (results.length > 0) yield results;
        }
      }
    }
  }
}


/** 获取详情 */
export async function getDetailFromApi(apiSite: ApiSite, id: string): Promise<SearchResult> {
  if (apiSite.detail) return handleSpecialSourceDetail(id, apiSite);

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;
  const response = await fetchWithTimeout(detailUrl, { headers: API_CONFIG.detail.headers });

  if (!response.ok) throw new Error(`详情请求失败: ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data?.list) || data.list.length === 0) {
    throw new Error('获取到的详情内容无效');
  }

  const video = data.list[0];
  const { episodes, titles } = parseEpisodes(video.vod_play_url, video.vod_content);

  return {
    id: id.toString(),
    title: video.vod_name,
    poster: video.vod_pic,
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: video.vod_class,
    year: video.vod_year?.match(/\d{4}/)?.[0] || 'unknown',
    desc: cleanHtmlTags(video.vod_content),
    type_name: video.type_name,
    douban_id: video.vod_douban_id,
  };
}

/** 特殊站点详情处理 */
async function handleSpecialSourceDetail(id: string, apiSite: ApiSite): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;
  const response = await fetchWithTimeout(detailUrl, { headers: API_CONFIG.detail.headers });

  if (!response.ok) throw new Error(`详情页请求失败: ${response.status}`);

  const html = await response.text();

  // 特定站点规则（优先）
  let matches: string[] = [];
  if (apiSite.key === 'ffzy') {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
  }

  // 通用正则
  if (matches.length === 0) {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
  }

  // 去重并清理
  matches = Array.from(new Set(matches)).map((link) => {
    const clean = link.substring(1); // 去掉 $
    const parenIndex = clean.indexOf('(');
    return parenIndex > 0 ? clean.substring(0, parenIndex) : clean;
  });

  // 如果依旧没解析到，用 parseEpisodes fallback
  if (matches.length === 0) {
    const { episodes } = parseEpisodes(undefined, html);
    matches = episodes;
  }

  const episodes_titles = matches.map((_, i) => (i + 1).toString());

  const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() || '';
  const desc = cleanHtmlTags(html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
  const cover = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/)?.[0]?.trim() || '';
  const year = html.match(/>(\d{4})</)?.[1] || 'unknown';

  return {
    id,
    title,
    poster: cover,
    episodes: matches,
    episodes_titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year,
    desc,
    type_name: '',
    douban_id: 0,
  };
}
