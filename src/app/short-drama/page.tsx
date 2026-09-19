/* eslint-disable no-console, react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import { BackButton } from '@/components/BackButton';
import DoubanCardSkeleton from '@/components/DoubanCardSkeleton';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

interface ShortDramaCard {
  title: string;
  poster: string;
  rate: string;
  year: string;
  douban_id: number;
  items: SearchResult[];
}

interface ShortDramaDebug {
  sites: number;
  searchHits: number;
  classHits: number;
}

interface ShortDramaResponse {
  list: ShortDramaCard[];
  page: number;
  hasMore: boolean;
  total: number;
  debug?: ShortDramaDebug;
}

function ShortDramaClient() {
  const [cards, setCards] = useState<ShortDramaCard[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [debug, setDebug] = useState<ShortDramaDebug | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async (pageNum: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/short-drama?page=${pageNum}&size=48`);
      if (!resp.ok) {
        throw new Error(`请求失败: ${resp.status}`);
      }
      const data = (await resp.json()) as ShortDramaResponse;
      setCards((prev) => (append ? [...prev, ...(data.list || [])] : data.list || []));
      setPage(data.page || 1);
      setHasMore(!!data.hasMore);
      setTotal(data.total || 0);
      setDebug(data.debug || null);
    } catch (err) {
      console.error('获取微短剧失败', err);
      setError('获取微短剧失败，请确认已配置视频源');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!hasLoaded.current) {
      hasLoaded.current = true;
      void load(1, false);
    }
  }, [load]);

  const loadMore = useCallback(() => {
    if (!loading && !loadingMore && hasMore) {
      void load(page + 1, true);
    }
  }, [loading, loadingMore, hasMore, page, load]);

  return (
    <PageLayout activePath='/short-drama'>
      <div className='px-4 sm:px-10 py-4 sm:py-8'>
        <div className='mb-6 flex items-center gap-3'>
          <BackButton showLabel />
          <div>
            <h1 className='text-2xl sm:text-3xl font-bold text-gray-800 dark:text-gray-200'>
              微短剧
            </h1>
            <p className='text-sm text-gray-600 dark:text-gray-400'>
              自动收集视频源中的短剧内容，海报与评分由豆瓣补充
            </p>
          </div>
        </div>

        <div className='max-w-[95%] mx-auto'>
          {error && (
            <div className='mb-6 rounded-xl border border-amber-200/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-300'>
              {error}
            </div>
          )}

          {!loading && cards.length === 0 && !error && (
            <div className='py-10 text-center'>
              <div className='text-gray-500'>暂无微短剧内容</div>
              {debug && (
                <div className='mt-3 inline-block rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2 text-xs text-gray-500 dark:text-gray-400'>
                  已扫描 {debug.sites} 个源 · 关键词命中 {debug.searchHits} 条 · 分类命中{' '}
                  {debug.classHits} 条。若你的源里有短剧但仍为空，请确认源支持
                  `ac=videolist&wd=` 搜索接口。
                </div>
              )}
            </div>
          )}

          <div className='grid grid-cols-3 gap-x-2 gap-y-12 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 sm:gap-y-20'>
            {loading
              ? Array.from({ length: 25 }, (_, i) => <DoubanCardSkeleton key={i} />)
              : cards.map((card, index) => (
                  <div key={`${card.title}-${index}`} className='w-full'>
                    <VideoCard
                      from='search'
                      title={card.title}
                      poster={card.poster}
                      rate={card.rate}
                      year={card.year}
                      douban_id={card.douban_id || undefined}
                      items={card.items}
                    />
                  </div>
                ))}
          </div>

          {hasMore && (
            <div className='mt-8 flex justify-center'>
              <button
                type='button'
                onClick={loadMore}
                disabled={loadingMore}
                className='rounded-full border border-gray-300 dark:border-gray-700 px-6 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'
              >
                {loadingMore ? '加载中…' : `加载更多（已显示 ${cards.length}/${total}）`}
              </button>
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function ShortDramaPage() {
  return <ShortDramaClient />;
}
