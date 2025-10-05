import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';

export const runtime = 'edge';

export async function GET(request: Request) {
  const url = new URL(request.url);
  let inputPassword = url.searchParams.get('pwd') || url.searchParams.get('password') || '';

  const adminConfig = await getConfig();
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  // 本地模式下未提供查询参数则自动使用环境变量 PASSWORD
  if (storageType === 'localstorage' && !inputPassword) {
    inputPassword = process.env.PASSWORD || '';
  }
  const enabled = storageType === 'localstorage'
    ? (process.env.TVBOX_ENABLED == null
        ? true
        : String(process.env.TVBOX_ENABLED).toLowerCase() === 'true')
    : adminConfig.SiteConfig.TVBoxEnabled === true;

  if (!enabled) {
    return NextResponse.json({ error: 'TVBox 接口未开启' }, { status: 403 });
  }

  try {
    const [cfg, cacheTime] = await Promise.all([
      getConfig(),
      getCacheTime(),
    ]);

    // 豆瓣默认分类（来源于 README 可用分类）
    const doubanDefaults = {
      movie: [
        '热门','最新','经典','豆瓣高分',
      ],
      tv: [
        '热门','美剧','英剧','韩剧','日剧','国产剧','日本动画',
      ],
    };

    // 用户自定义分类（从配置获取）
    const custom = (cfg.CustomCategories || []).map((c) => ({
      name: c.name || c.query,
      type: c.type,
      query: c.query,
    }));

    // Apple CMS 类似分类返回（参考 provide/vod 的分类结构）
    const classes: { type_id: number; type_name: string }[] = [];
    let nextId = 1;

    doubanDefaults.movie.forEach((name) => {
      classes.push({ type_id: nextId++, type_name: `电影·${name}` });
    });
    doubanDefaults.tv.forEach((name) => {
      classes.push({ type_id: nextId++, type_name: `剧集·${name}` });
    });
    custom.forEach((c) => {
      classes.push({ type_id: nextId++, type_name: `${c.name}` });
    });

    // 分页参数：t（分类 id），pg（页码，默认1），wd（关键字）
    const tParam = Number(url.searchParams.get('t') || '');
    const wdParam = url.searchParams.get('wd') || '';
    const pgParam = Math.max(1, parseInt(url.searchParams.get('pg') || '1'));
    const pageSize = Math.max(1, Math.min(50, parseInt(url.searchParams.get('pagesize') || '20')));

    if (tParam || wdParam) {
      // 重建与 classes 相同顺序的选择器映射
      const selectors: Array<{ kind: 'movie' | 'tv'; category?: string; label?: string }> = [];
      doubanDefaults.movie.forEach((name) => selectors.push({ kind: 'movie', category: name }));
      doubanDefaults.tv.forEach((name) => selectors.push({ kind: 'tv', category: name }));
      custom.forEach((c) => selectors.push({ kind: c.type, label: c.query }));

      let kind: 'movie' | 'tv' = 'movie';
      let category = '';
      let label = '';
      let sort = '';
      if (tParam && tParam >= 1 && tParam <= selectors.length) {
        const sel = selectors[tParam - 1];
        kind = sel.kind;
        category = sel.category || '';
        label = sel.label || '';
      }
      if (wdParam) {
        label = wdParam;
      }

      const origin = url.origin;
      const qs = new URLSearchParams();
      qs.set('kind', kind);
      // 处理“热门/最新”无数据的问题：
      // - 热门：不传 category/label，由后端按默认推荐返回
      // - 最新：不传 category/label，传 sort=time
      if (category === '最新') {
        sort = 'time';
        category = '';
        label = '';
        // 按首页策略靠近“最新上映”：限定年份为当年
        const year = new Date().getFullYear();
        qs.set('year', String(year));
      } else if (category === '热门') {
        category = '';
        label = '';
      }

      if (category) qs.set('category', category);
      if (label) qs.set('label', label);
      qs.set('start', String((pgParam - 1) * pageSize));
      qs.set('limit', String(pageSize));
      if (sort) qs.set('sort', sort);

      const resp = await fetch(`${origin}/api/douban/recommends?${qs.toString()}`);
      const data = await resp.json();
      const list = Array.isArray((data as any).list) ? (data as any).list : [];

      const payload = {
        code: 1,
        msg: 'success',
        page: pgParam,
        pagecount: 999,
        limit: pageSize,
        total: 0,
        list: list.map((item: any) => ({
          vod_id: item.id,
          vod_name: item.title,
          vod_pic: item.poster,
          vod_year: item.year || '',
          vod_remarks: item.rate || '',
        })),
      };

      return NextResponse.json(payload, {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
        },
      });
    }

    // 返回分类
    return NextResponse.json(
      { code: 1, msg: 'success', class: classes, list: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
        },
      }
    );
  } catch (e) {
    return NextResponse.json({ code: 0, msg: 'error', class: [], list: [] }, { status: 500 });
  }
}


