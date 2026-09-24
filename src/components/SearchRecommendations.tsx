'use client';

import { useEffect, useState } from 'react';

import { getDoubanCategories } from '@/lib/douban.client';
import { DoubanItem } from '@/lib/types';

import VideoCard from '@/components/VideoCard';

/**
 * 搜索页搜索框下方的「热门推荐」横滑条。
 *
 * 4.2.10 起承接原首页 Hero 的推荐位：首页不再放搜索框与推荐，
 * 推荐统一收进搜索页 —— 用户在搜索页还没输入时也有内容可逛。
 *
 * 数据自拉（热门电影 / 剧集 / 综艺三池轮询混排 10 部，与原首页 Hero 同策略），
 * 失败静默收敛（空态不渲染），不打扰搜索主流程。
 */
const SearchRecommendations = () => {
  const [items, setItems] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchRecs = async () => {
      try {
        const [movies, tv, shows] = await Promise.all([
          getDoubanCategories({ kind: 'movie', category: '热门', type: '全部' }),
          getDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' }),
          getDoubanCategories({ kind: 'tv', category: 'show', type: 'show' }),
        ]);
        if (cancelled) return;
        const pools = [movies.list, tv.list, shows.list];
        const mixed: DoubanItem[] = [];
        for (let i = 0; mixed.length < 20; i++) {
          const added = pools.reduce(
            (n, pool) =>
              pool[i] && mixed.length < 20 ? (mixed.push(pool[i]), n + 1) : n,
            0
          );
          if (added === 0) break;
        }
        setItems(mixed);
      } catch {
        // 推荐是锦上添花，拉取失败静默收敛
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchRecs();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && items.length === 0) return null;

  return (
    <section className='mt-8 mb-10'>
      <p className='mb-3 text-sm font-medium text-gray-500 dark:text-gray-400'>
        热门推荐
      </p>
      <div className='flex gap-4 overflow-x-auto pb-2 scrollbar-hide'>
        {loading
          ? Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className='w-28 min-w-28 flex-shrink-0'>
                <div className='relative aspect-[2/3] w-full animate-pulse overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-800'>
                  <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                </div>
                <div className='mt-2 h-3.5 animate-pulse rounded bg-gray-200 dark:bg-gray-800'></div>
              </div>
            ))
          : items.map((movie, index) => (
              <div
                key={`${movie.id}-${index}`}
                className='w-28 min-w-28 flex-shrink-0'
              >
                <VideoCard
                  from='douban'
                  title={movie.title}
                  poster={movie.poster}
                  douban_id={Number(movie.id)}
                  rate={movie.rate}
                  year={movie.year}
                  type='movie'
                />
              </div>
            ))}
      </div>
    </section>
  );
};

export default SearchRecommendations;
