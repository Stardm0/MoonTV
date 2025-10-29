'use client';

export async function getCustomCategories(): Promise<
  {
    name: string;
    type: 'movie' | 'tv';
    query: string;
  }[]
> {
  const res = await fetch('/api/config/custom_category');
  const data = (await res.json()) as Array<{
    name?: string;
    type: 'movie' | 'tv';
    query: string;
    disabled?: boolean;
  }>;
  return data
    .filter((item) => !item.disabled)
    .map((category) => ({
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
    const data = (await res.json()) as Array<Partial<ApiSite>>;
    // 保守擷取需要的欄位並填預設值避免 undefined
    return data.map((site) => ({
      key: site.key ?? '',
      name: site.name ?? '',
      api: site.api ?? '',
      detail: site.detail,
    }));
  } catch {
    return [];
  }
}
