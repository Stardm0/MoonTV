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

interface ShortDramaResponse {
  list: ShortDramaCard[];
  page: number;
  hasMore: boolean;
}

function ShortDramaClient() {
  const [cards, setCards] = useState<ShortDramaCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const resp = await fetch('/api/short-drama?page=1&size=30');
      if (!resp.ok) {
        throw new Error(`请求失败: ${resp.status}`);
      }
      const data = (await resp.json()) as ShortDramaResponse;
      setCards(data.list || []);
    } catch (err) {
      console.error('获取微短剧失败', err);
      setError('获取微短剧失败，请确认视频源分类中包含「短剧」类目');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasLoaded.current) {
      hasLoaded.current = true;
      void load();
    }
  }, [load]);

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
              来自视频源的短剧分类，海报与评分由豆瓣补充
            </p>
          </div>
        </div>

        <div className='max-w-[95%] mx-auto'>
          {error && (
            <div className='mb-6 rounded-xl border border-amber-200/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-300'>
              {error}
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

          {!loading && cards.length === 0 && !error && (
            <div className='py-10 text-center text-gray-500'>暂无微短剧内容</div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function ShortDramaPage() {
  return <ShortDramaClient />;
}
