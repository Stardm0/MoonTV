/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { ApiSite, getAvailableApiSites, getCacheTime } from '@/lib/config';

export const runtime = 'edge';

/** 分类名命中这些关键词即视为「微短剧」分类 */
const SHORT_DRAMA_KEYWORDS = ['短剧', '微短剧', '竖屏短剧', '迷你剧'];

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

/** 拉取某源分类列表，返回含短剧关键词的分类 */
async function fetchShortDramaClasses(apiSite: ApiSite): Promise<SiteClass[]> {
  const url = `${apiSite.api}?ac=list`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { class?: SiteClass[] };
    const classes = Array.isArray(data.class) ? data.class : [];
    return classes.filter((c) =>
      SHORT_DRAMA_KEYWORDS.some((kw) => String(c.type_name || '').includes(kw))
    );
  } catch {
    return [];
  }
}

/** 按分类取视频列表（单页） */
async function fetchVodListByClass(
  apiSite: ApiSite,
  typeId: string | number,
  page: number,
  pageSize: number
): Promise<VodItem[]> {
  const url = `${apiSite.api}?ac=videolist&t=${encodeURIComponent(String(typeId))}&pg=${page}&pagesize=${pageSize}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { list?: VodItem[] };
    return Array.isArray(data.list) ? data.list : [];
  } catch {
    return [];
  }
}

/** 归一化标题作为聚合键 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
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
  const pageSize = Math.max(1, Math.min(50, parseInt(searchParams.get('size') || '30')));

  const apiSites = await getAvailableApiSites(username);
  if (apiSites.length === 0) {
    return NextResponse.json({ list: [], page, hasMore: false });
  }

  // 1) 并发拉所有源的分类，找短剧分类
  const classResults = await Promise.all(
    apiSites.map(async (site) => {
      const classes = await fetchShortDramaClasses(site);
      return { site, classes };
    })
  );

  // 2) 对每个短剧分类并发拉取当前页视频，附带源信息
  interface EnrichedVod {
    item: VodItem;
    site: ApiSite;
  }
  const vodTasks: Promise<EnrichedVod[]>[] = [];
  for (const { site, classes } of classResults) {
    for (const cls of classes) {
      vodTasks.push(
        fetchVodListByClass(site, cls.type_id, page, pageSize).then((items) =>
          items.map((item) => ({ item, site }))
        )
      );
    }
  }
  const enrichedVods = (await Promise.all(vodTasks)).flat();

  // 3) 按标题聚合，跨源合并
  const grouped = new Map<string, EnrichedVod[]>();
  for (const vod of enrichedVods) {
    const key = normalizeTitle(vod.item.vod_name);
    const arr = grouped.get(key) || [];
    arr.push(vod);
    grouped.set(key, arr);
  }

  // 4) 转成前端卡片数据（items 供 VideoCard 聚合模式直接按源播放）
  const list = Array.from(grouped.values()).map((vods) => {
    const first = vods[0].item;
    const rate = vods
      .map((v) => v.item.vod_remarks)
      .find((r) => r && /^\d+(\.\d+)?$/.test(r.trim()));
    const doubanId = vods.map((v) => v.item.vod_douban_id).find((id) => id && id !== 0);

    return {
      title: first.vod_name,
      poster: first.vod_pic || '',
      rate: rate || '',
      year: first.vod_year?.match(/\d{4}/)?.[0] || '',
      douban_id: doubanId || 0,
      items: vods.map((v) => ({
        id: String(v.item.vod_id),
        title: v.item.vod_name,
        poster: v.item.vod_pic || '',
        source: v.site.key,
        source_name: v.site.name,
        year: v.item.vod_year?.match(/\d{4}/)?.[0] || 'unknown',
        douban_id: v.item.vod_douban_id,
        type_name: v.item.type_name || v.item.vod_class,
        // 列表接口不带播放地址，播放页会按 source+id 拉详情补全；这里给空占位
        episodes: [],
        episodes_titles: [],
      })),
    };
  });

  const cacheTime = await getCacheTime();
  return NextResponse.json(
    { list, page, hasMore: false },
    {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
      },
    }
  );
}
