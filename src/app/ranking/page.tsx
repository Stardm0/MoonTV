/* eslint-disable no-console, react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DoubanCollectionId,
  getDoubanCollection,
} from '@/lib/douban.client';
import type { DoubanItem } from '@/lib/types';

import { BackButton } from '@/components/BackButton';
import DoubanCardSkeleton from '@/components/DoubanCardSkeleton';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

interface CollectionOption {
  id: DoubanCollectionId;
  label: string;
}

const COLLECTIONS: CollectionOption[] = [
  { id: 'movie_top250', label: 'Top250' },
  { id: 'movie_weekly_best', label: '每周口碑榜' },
];

function RankingClient() {
  const [activeId, setActiveId] = useState<DoubanCollectionId>('movie_top250');
  const [data, setData] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingRef = useRef<HTMLDivElement>(null);

  const loadInitial = useCallback(async (id: DoubanCollectionId) => {
    setLoading(true);
    setData([]);
    setCurrentPage(0);
    setHasMore(true);
    try {
      const result = await getDoubanCollection(id, 0, 25);
      if (result.code === 200) {
        setData(result.list);
        setHasMore(result.list.length !== 0);
      }
    } catch (err) {
      console.error('获取榜单失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitial(activeId);
  }, [activeId, loadInitial]);

  // 加载更多
  useEffect(() => {
    if (currentPage === 0) return;
    void (async () => {
      setIsLoadingMore(true);
      try {
        const result = await getDoubanCollection(activeId, currentPage * 25, 25);
        if (result.code === 200) {
          setData((prev) => [...prev, ...result.list]);
          setHasMore(result.list.length !== 0);
        }
      } catch (err) {
        console.error('加载更多失败', err);
      } finally {
        setIsLoadingMore(false);
      }
    })();
  }, [currentPage, activeId]);

  // 无限滚动
  useEffect(() => {
    if (!hasMore || isLoadingMore || loading) return;
    if (!loadingRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(loadingRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loading]);

  return (
    <PageLayout activePath='/ranking'>
      <div className='px-4 sm:px-10 py-4 sm:py-8'>
        <div className='mb-6 flex items-center gap-3'>
          <BackButton showLabel />
          <div>
            <h1 className='text-2xl sm:text-3xl font-bold text-gray-800 dark:text-gray-200'>
              豆瓣榜单
            </h1>
            <p className='text-sm text-gray-600 dark:text-gray-400'>
              来自豆瓣的精选榜单
            </p>
          </div>
        </div>

        {/* 榜单切换 */}
        <div className='mb-6 inline-flex rounded-full bg-gray-200/60 p-1 dark:bg-gray-700/60'>
          {COLLECTIONS.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                activeId === c.id
                  ? 'bg-white text-gray-900 dark:bg-gray-500 dark:text-gray-100'
                  : 'text-gray-700 dark:text-gray-400'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* 内容网格 */}
        <div className='max-w-[95%] mx-auto'>
          <div className='grid grid-cols-3 gap-x-2 gap-y-12 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 sm:gap-y-20'>
            {loading
              ? Array.from({ length: 25 }, (_, i) => <DoubanCardSkeleton key={i} />)
              : data.map((item, index) => (
                  <div key={`${item.title}-${index}`} className='w-full'>
                    <VideoCard
                      from='douban'
                      title={item.title}
                      poster={item.poster}
                      douban_id={Number(item.id)}
                      rate={item.rate}
                      year={item.year}
                      type=''
                    />
                  </div>
                ))}
          </div>

          {hasMore && !loading && (
            <div
              ref={(el) => {
                if (el && el.offsetParent !== null) {
                  (loadingRef as any).current = el;
                }
              }}
              className='flex justify-center py-8'
            >
              {isLoadingMore && (
                <div className='flex items-center gap-2'>
                  <div className='h-6 w-6 animate-spin rounded-full border-b-2 border-green-500' />
                  <span className='text-gray-600'>加载中...</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function RankingPage() {
  return <RankingClient />;
}
