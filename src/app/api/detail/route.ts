/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  buildPlayableUrl,
  joinOpenListPath,
  parseOpenListConfigFromCookieHeader,
  requestOpenList,
  sortOpenListItems,
} from '@/lib/openlist';
import type { SearchResult } from '@/lib/types';

export const runtime = 'edge';

/** 影库在播放页里的来源代号；播放页 `?source=openlist&id=<路径>` */
const OPENLIST_SOURCE = 'openlist';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  // 影库的 id 是虚拟路径（含中文与斜杠），走不了 Apple CMS 的 `\w-` 校验，
  // 必须在通用校验之前单独分支处理。
  if (sourceCode === OPENLIST_SOURCE) {
    return handleOpenListDetail(request, id);
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const result = await getDetailFromApi(apiSite, id);
    const cacheTime = await getCacheTime();

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Netlify-Vary': 'query',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * 影库详情：把 OpenList 的一个文件 / 一个目录映射成 `SearchResult`。
 *
 * - **单文件** → 一集，`episodes[0]` 是直链
 * - **目录** → 当成一部剧，目录里的视频文件按自然序展开成选集
 *
 * 这样播放页、选集、进度记录、弹幕全都能直接复用，无需改播放链路。
 * 直链有过期时间，所以不进 CDN 缓存（`no-store`），每次进播放页现取。
 */
async function handleOpenListDetail(request: Request, path: string) {
  const config = parseOpenListConfigFromCookieHeader(request.headers.get('cookie'));
  if (!config || !config.baseUrl) {
    return NextResponse.json(
      { error: '尚未配置私人影库，请先到「影库」页面填写地址与令牌' },
      { status: 400 }
    );
  }

  const info = await requestOpenList(config, 'get', path);
  if (!info.ok) {
    return NextResponse.json(
      { error: info.error ?? '读取影库失败' },
      { status: info.status ?? 502 }
    );
  }

  const entry = (info.data?.data ?? {}) as any;
  const title = String(entry?.name ?? path.split('/').filter(Boolean).pop() ?? '影库资源');
  const poster = typeof entry?.thumb === 'string' ? entry.thumb : '';
  const isDir = entry?.is_dir === true;

  let episodes: string[] = [];
  let episodeTitles: string[] = [];

  if (isDir) {
    const listing = await requestOpenList(config, 'list', path);
    if (!listing.ok) {
      return NextResponse.json(
        { error: listing.error ?? '读取影库目录失败' },
        { status: listing.status ?? 502 }
      );
    }
    const content = ((listing.data?.data?.content ?? []) as any[]).filter(
      (item) => !item?.is_dir
    );
    // 目录当剧集：只收视频文件，按自然序排（S1E2 在 S1E10 之前）
    const videos = sortOpenListItems(
      content
        .filter((item) => typeof item?.name === 'string')
        .map((item) => ({
          name: item.name as string,
          size: Number(item.size ?? 0),
          is_dir: false,
          sign: typeof item.sign === 'string' ? item.sign : undefined,
          raw_url: typeof item.raw_url === 'string' ? item.raw_url : undefined,
        }))
    ).filter((item) => /\.(mp4|mkv|webm|avi|mov|m2ts|ts|flv|rmvb|rm|wmv|mpg|mpeg|m4v|iso)$/i.test(item.name));

    episodes = videos.map((item) =>
      buildPlayableUrl(
        config.baseUrl,
        joinOpenListPath(path, item.name),
        item.sign,
        item.raw_url
      )
    );
    episodeTitles = videos.map((item) => item.name);
  } else {
    episodes = [buildPlayableUrl(config.baseUrl, path, entry?.sign, entry?.raw_url)];
    episodeTitles = [title];
  }

  if (episodes.length === 0 || !episodes[0]) {
    return NextResponse.json(
      { error: '该路径下没有可播放的视频' },
      { status: 404 }
    );
  }

  const result: SearchResult = {
    id: path,
    title,
    poster,
    episodes,
    episodes_titles: episodeTitles,
    source: OPENLIST_SOURCE,
    source_name: '私人影库',
    class: isDir ? '剧集' : '影片',
    year: '',
    desc: isDir ? `影库目录：${path}` : `影库文件：${path}`,
    type_name: isDir ? '剧集' : '影片',
  };

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
