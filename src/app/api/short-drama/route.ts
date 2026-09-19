/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { ApiSite, getAvailableApiSites, getCacheTime } from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

/**
 * 关键词搜索：直接在视频源里搜这些词，主动收集微短剧。
 * `?ac=videolist&wd=` 是所有 Apple CMS 源的标准搜索接口，比依赖分类名匹配可靠。
 */
const SHORT_DRAMA_KEYWORDS = ['短剧', '微短剧', '迷你剧', '竖屏'];

/** 分类名命中这些关键词也视为微短剧分类（辅助通道，覆盖面更全） */
const SHORT_DRAMA_CLASS_KEYWORDS = ['短剧', '微短剧', '迷你', '竖屏'];

interface SiteClass {
  type_id: string | number;
  type_name: string;
}

interface VodItem {
  vod_id: string | number;
  vod_name: string;
  vod_pic?: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_douban_id?: number;
  vod_class?: string;
  type_name?: string;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/** 拉取某源分类列表，返回含短剧关键词的分类 */
async function fetchShortDramaClasses(apiSite: ApiSite): Promise<SiteClass[]> {
  const url = `${apiSite.api}?ac=list`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { headers: UA_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { class?: SiteClass[] };
    const classes = Array.isArray(data.class) ? data.class : [];
    return classes.filter((c) =>
      SHORT_DRAMA_CLASS_KEYWORDS.some((kw) => String(c.type_name || '').includes(kw))
    );
  } catch {
    return [];
  }
}

/** 按分类取视频（单页），映射为 SearchResult（播放地址由播放页按 source+id 补全） */
async function fetchVodListByClass(
  apiSite: ApiSite,
  typeId: string | number
): Promise<SearchResult[]> {
  const url = `${apiSite.api}?ac=videolist&t=${encodeURIComponent(String(typeId))}&pg=1`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { headers: UA_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { list?: VodItem[] };
    const items = Array.isArray(data.list) ? data.list : [];
    return items.map((v) => ({
      id: String(v.vod_id),
      title: v.vod_name.trim().replace(/\s+/g, ' '),
      poster: v.vod_pic || '',
      episodes: [],
      episodes_titles: [],
      source: apiSite.key,
      source_name: apiSite.name,
      class: v.vod_class || '',
      year: v.vod_year?.match(/\d{4}/)?.[0] || 'unknown',
      desc: '',
      type_name: v.type_name || v.vod_class,
      douban_id: v.vod_douban_id,
    }));
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const isLocalStorage = storageType === 'localstorage';

  let username: string | undefined;
  if (!isLocalStorage) {
    const auth = getAuthInfoFromCookie(request);
    if (!auth || !auth.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    username = auth.username;
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const pageSize = Math.max(1, Math.min(50, parseInt(searchParams.get('size') || '48')));

  const apiSites = await getAvailableApiSites(username);
  if (apiSites.length === 0) {
    return NextResponse.json({
      list: [],
      page,
      hasMore: false,
      total: 0,
      debug: { sites: 0, searchHits: 0, classHits: 0 },
    });
  }

  // 通道 1：关键词搜索（主），每个源每个词取第一页
  const searchTasks = apiSites.flatMap((site) =>
    SHORT_DRAMA_KEYWORDS.map(async (kw): Promise<SearchResult[]> => {
      try {
        const gen = searchFromApiStream(site, kw, false, 8000);
        const first = await gen.next();
        if (first.done) return [];
        return first.value as SearchResult[];
      } catch {
        return [];
      }
    })
  );

  // 通道 2：分类扫描（辅）
  const classTasks = apiSites.map(async (site): Promise<SearchResult[]> => {
    const classes = await fetchShortDramaClasses(site);
    if (classes.length === 0) return [];
    const perClass = await Promise.all(classes.map((c) => fetchVodListByClass(site, c.type_id)));
    return perClass.flat();
  });

  const [searchHits, classHits] = await Promise.all([
    Promise.all(searchTasks).then((r) => r.flat()),
    Promise.all(classTasks).then((r) => r.flat()),
  ]);

  // 聚合：按标题去重，跨源合并成一张卡
  const grouped = new Map<string, SearchResult[]>();
  const push = (r: SearchResult) => {
    const key = normalizeTitle(r.title);
    if (!key) return;
    const arr = grouped.get(key) || [];
    if (!arr.some((x) => x.source === r.source && x.id === r.id)) arr.push(r);
    grouped.set(key, arr);
  };
  for (const r of searchHits) push(r);
  for (const r of classHits) push(r);

  const list = Array.from(grouped.values()).map((items) => {
    const first = items[0];
    const poster = items.find((i) => i.poster)?.poster || '';
    const doubanId = items.map((i) => i.douban_id).find((id) => id && id !== 0) || 0;
    return {
      title: first.title,
      poster,
      rate: '',
      year: first.year && first.year !== 'unknown' ? first.year : '',
      douban_id: doubanId,
      items,
    };
  });

  // 内存分页
  const start = (page - 1) * pageSize;
  const pagedList = list.slice(start, start + pageSize);

  const cacheTime = await getCacheTime();
  return NextResponse.json(
    {
      list: pagedList,
      page,
      hasMore: start + pageSize < list.length,
      total: list.length,
      debug: {
        sites: apiSites.length,
        searchHits: searchHits.length,
        classHits: classHits.length,
      },
    },
    {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
      },
    }
  );
}
