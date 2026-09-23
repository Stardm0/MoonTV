'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { addSearchHistory } from '@/lib/db.client';
import { DoubanItem } from '@/lib/types';

import { useNavigationLoading } from '@/components/NavigationLoadingProvider';
import SourceSelector from '@/components/SourceSelector';
import VideoCard from '@/components/VideoCard';

interface HomeSearchHeroProps {
  /** 搜索框下方展示的推荐影片（取热门电影前若干条） */
  recommendations: DoubanItem[];
  /** 推荐数据是否还在加载（控制占位骨架） */
  loading: boolean;
}

/**
 * 首页内容区顶部的搜索 Hero：居中大搜索框 + 下方推荐影片横滑条。
 *
 * ## 为什么放这里
 *
 * 搜索是首页最高频的动作，4.2.7 把它收进侧边栏二级菜单后发现路径太深 ——
 * 用户明确要求挪到内容区中央，搜索框下面直接给一波推荐影片，
 * 让首页首屏「搜索 + 逛」两个动作都不用滚动就能完成。
 *
 * ## 桌面端限定
 *
 * 移动端保持现状（底部导航已有搜索入口，且首屏空间宝贵），
 * 整块 `hidden md:block`，与 SideNav 的桌面端策略一致。
 *
 * ## 推荐数据来源
 *
 * 直接复用首页已拉取的热门电影列表（`page.tsx` 传入切片），
 * 不发新请求；简洁模式下首页不拉豆瓣数据，推荐为空时只渲染搜索框。
 */
const HomeSearchHero = ({ recommendations, loading }: HomeSearchHeroProps) => {
  const router = useRouter();
  const { startLoading } = useNavigationLoading();
  const [query, setQuery] = useState('');
  // 搜索源选择：与原 TopNav 搜索框一致，选中的源会随查询带到 /search
  const [searchSources, setSearchSources] = useState<string[]>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const keyword = query.trim();
    if (keyword) {
      addSearchHistory(keyword);
    }
    startLoading();
    if (!keyword) {
      router.push('/search');
      return;
    }
    const params = new URLSearchParams();
    params.set('q', keyword);
    if (searchSources.length > 0) {
      params.set('sources', searchSources.join(','));
    }
    router.push(`/search?${params.toString()}`);
  };

  const clearQuery = useCallback(() => setQuery(''), []);

  return (
    <section className='moontv-home-search-hero mb-10 hidden md:block'>
      {/* 搜索框：居中、大尺寸，回车或点按钮都提交；左侧是搜索源选择器（原 TopNav 位置） */}
      <form
        onSubmit={submitSearch}
        className='mx-auto flex max-w-3xl items-center gap-3'
        role='search'
      >
        <div className='flex-shrink-0'>
          <SourceSelector
            selectedSources={searchSources}
            onChange={setSearchSources}
            openFilter={openFilter}
            setOpenFilter={setOpenFilter}
            size='compact'
          />
        </div>
        <div className='relative flex-1'>
          <Search className='pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
          <input
            type='text'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='搜索影片、演员、关键词…'
            aria-label='搜索影视'
            className='w-full rounded-full border border-gray-200/80 bg-white/90 py-4 pl-14 pr-28 text-base text-gray-700 shadow-sm backdrop-blur transition-colors placeholder-gray-400 focus:border-green-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-green-400/40 dark:border-gray-700/70 dark:bg-gray-900/70 dark:text-gray-200 dark:placeholder-gray-500 dark:focus:bg-gray-900'
          />
          {query && (
            <button
              type='button'
              onClick={clearQuery}
              aria-label='清空搜索词'
              className='absolute right-28 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300'
            >
              <X className='h-4 w-4' />
            </button>
          )}
          <button
            type='submit'
            className='absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-green-500 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-600 dark:hover:bg-green-600'
          >
            搜索
          </button>
        </div>
      </form>
      {/* 搜索框下方的推荐影片：复用首页已拉取的热门电影，空态/加载态都静默收敛 */}
      {(loading || recommendations.length > 0) && (
        <div className='mt-8'>
          <p className='mb-3 text-center text-xs font-medium uppercase tracking-widest text-gray-400 dark:text-gray-500'>
            热门推荐
          </p>
          <div className='moontv-hero-rec-row flex gap-5 overflow-x-auto px-1 pb-2 scrollbar-hide'>
            {loading
              ? Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className='w-28 min-w-28 flex-shrink-0'
                  >
                    <div className='relative aspect-[2/3] w-full animate-pulse overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-800'>
                      <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                    </div>
                    <div className='mt-2 h-3.5 animate-pulse rounded bg-gray-200 dark:bg-gray-800'></div>
                  </div>
                ))
              : recommendations.map((movie, index) => (
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
        </div>
      )}
    </section>
  );
};

export default HomeSearchHero;
