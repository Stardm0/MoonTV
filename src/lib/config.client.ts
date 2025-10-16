/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

export async function getCustomCategories(): Promise<{
  name: string;
  type: 'movie' | 'tv';
  query: string;
}[]> {
  const res = await fetch('/api/config/custom_category');
  const data = await res.json();
  return data.filter((item: any) => !item.disabled).map((category: any) => ({
    name: category.name || '',
    type: category.type,
    query: category.query,
  }));
}

export interface ApiSite {
  key: string;
  name: string;
  api: string;
  detail?: string;
}

export async function getAvailableApiSitesClient(): Promise<ApiSite[]> {
  try {
    const res = await fetch('/api/config/sources');
    if (!res.ok) {
      throw new Error('Failed to fetch sources');
    }
    const data = await res.json();
    // 服务器已做按用户与禁用过滤
    return data.map((site: any) => ({
      key: site.key,
      name: site.name,
      api: site.api,
      detail: site.detail,
    }));
  } catch (error) {
    console.error('Failed to fetch available API sites:', error);
    return [];
  }
}