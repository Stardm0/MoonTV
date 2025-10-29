import { getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApiStream } from './downstream';

interface FetchVideoDetailOptions {
  source: string;
  id: string;
  fallbackTitle?: string;
  timeout?: number; // 超时时间（毫秒）
}

/**
 * 根据 source 与 id 获取视频详情（支持流式搜索）。
 */
export async function fetchVideoDetail({
  source,
  id,
  fallbackTitle = '',
  timeout,
}: FetchVideoDetailOptions): Promise<SearchResult> {
  const apiSites = await getAvailableApiSites();
  const apiSite = apiSites.find((site) => site.key === source);
  if (!apiSite) {
    throw new Error('无效的API来源');
  }

  // 使用流式搜索尝试精确匹配
  if (fallbackTitle) {
    try {
      for await (const results of searchFromApiStream(
        apiSite,
        fallbackTitle.trim(),
        true,
        timeout
      )) {
        const exactMatch = results.find(
          (item: SearchResult) =>
            item.source.toString() === source.toString() &&
            item.id.toString() === id.toString()
        );
        if (exactMatch) {
          return exactMatch; // 找到就立即返回
        }
      }
    } catch (error) {
      // 流式搜索失败时忽略
    }
  }

  // 流式搜索未命中或未提供 fallbackTitle，则调用 /api/detail
  const detail = await getDetailFromApi(apiSite, id);
  if (!detail) {
    throw new Error('获取视频详情失败');
  }

  return detail;
}
