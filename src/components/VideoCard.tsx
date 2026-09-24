/* eslint-disable @typescript-eslint/no-explicit-any */

import { ExternalLink, Heart, Link, PlayCircleIcon, Trash2 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import React, { useCallback, useMemo, useState } from 'react';

import {
  deleteFavorite,
  deleteFollowing,
  deletePlayRecord,
  generateStorageKey,
  isFavorited,
  isFollowing,
  saveFavorite,
  saveFollowing,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';

import FollowingIcon from '@/components/FollowingIcon';
import { ImagePlaceholder } from '@/components/ImagePlaceholder';
import MobileActionSheet from '@/components/MobileActionSheet';
import { useNavigationLoading } from '@/components/NavigationLoadingProvider';

interface VideoCardProps {
  id?: string;
  source?: string;
  title?: string;
  query?: string;
  poster?: string;
  episodes?: number;
  source_name?: string;
  progress?: number;
  /** 是否隐藏下方的播放进度条（追更页卡片无需显示进度条） */
  hideProgress?: boolean;
  year?: string;
  from: 'playrecord' | 'favorite' | 'search' | 'douban';
  currentEpisode?: number;
  douban_id?: number;
  onDelete?: () => void;
  rate?: string;
  items?: SearchResult[];
  type?: string;
  isBangumi?: boolean;
}

export default function VideoCard({
  id,
  title = '',
  query = '',
  poster = '',
  episodes,
  source,
  source_name,
  progress = 0,
  hideProgress = false,
  year,
  from,
  currentEpisode,
  douban_id,
  onDelete,
  rate,
  items,
  type = '',
  isBangumi = false,
}: VideoCardProps) {
  const router = useRouter();
  const { startLoading } = useNavigationLoading();
  const [favorited, setFavorited] = useState(false);
  const [following, setFollowing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [favoriteChecked, setFavoriteChecked] = useState(false); // 是否已经检查过收藏状态
  const [followingChecked, setFollowingChecked] = useState(false); // 是否已经检查过追更状态
  const [isActionOpen, setIsActionOpen] = useState(false);
  const [longPressTimer, setLongPressTimer] = useState<number | null>(null);

  const isAggregate = from === 'search' && !!items?.length;

  const aggregateData = useMemo(() => {
    if (!isAggregate || !items) return null;
    const countMap = new Map<number, number>();
    const episodeCountMap = new Map<number, number>();
    items.forEach((item) => {
      if (item.douban_id && item.douban_id !== 0) {
        countMap.set(item.douban_id, (countMap.get(item.douban_id) || 0) + 1);
      }
      const len = item.episodes?.length || 0;
      if (len > 0) {
        episodeCountMap.set(len, (episodeCountMap.get(len) || 0) + 1);
      }
    });

    const getMostFrequent = (map: Map<number, number>) => {
      let maxCount = 0;
      let result: number | undefined;
      map.forEach((cnt, key) => {
        if (cnt > maxCount) {
          maxCount = cnt;
          result = key;
        }
      });
      return result;
    };

    return {
      first: items[0],
      mostFrequentDoubanId: getMostFrequent(countMap),
      mostFrequentEpisodes: getMostFrequent(episodeCountMap) || 0,
    };
  }, [isAggregate, items]);

  const actualTitle = aggregateData?.first.title ?? title;
  const actualPoster = aggregateData?.first.poster ?? poster;
  const actualSource = aggregateData?.first.source ?? source;
  const actualId = aggregateData?.first.id ?? id;
  const actualDoubanId = aggregateData?.mostFrequentDoubanId ?? douban_id;
  const actualEpisodes = aggregateData?.mostFrequentEpisodes ?? episodes;
  const actualYear = aggregateData?.first.year ?? year;
  const actualQuery = query || '';
  const sanitizedYear = actualYear && actualYear !== 'unknown' ? actualYear : '';
  const sanitizedQuery =
    actualQuery && actualQuery.trim() && actualQuery.trim() !== actualTitle.trim()
      ? actualQuery.trim()
      : '';
  const actualSearchType = isAggregate
    ? aggregateData?.first.episodes?.length === 1
      ? 'movie'
      : 'tv'
    : type;

  // 检查收藏状态函数
  const checkFavoriteStatus = useCallback(async () => {
    if (from === 'douban' || !actualSource || !actualId) return;
    try {
      const fav = await isFavorited(actualSource, actualId);
      setFavorited(fav);
      setFavoriteChecked(true);

      // 延迟订阅收藏更新
      const storageKey = generateStorageKey(actualSource, actualId);
      subscribeToDataUpdates('favoritesUpdated', (newFavorites: Record<string, any>) => {
        const isNowFavorited = !!newFavorites[storageKey];
        setFavorited(isNowFavorited);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('检查收藏状态失败', err);
    }
  }, [from, actualSource, actualId]);

  const handleToggleFavorite = useCallback(
    async (e?: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (from === 'douban' || !actualSource || !actualId) return;
      try {
        if (favorited) {
          await deleteFavorite(actualSource, actualId);
          setFavorited(false);
        } else {
          await saveFavorite(actualSource, actualId, {
            title: actualTitle,
            source_name: source_name || '',
            year: sanitizedYear,
            cover: actualPoster,
            total_episodes: actualEpisodes ?? 1,
            save_time: Date.now(),
            search_title: sanitizedQuery,
          });
          setFavorited(true);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('切换收藏状态失败', err);
      }
    },
    [
      from,
      actualSource,
      actualId,
      actualTitle,
      source_name,
      sanitizedYear,
      actualPoster,
      actualEpisodes,
      sanitizedQuery,
      favorited,
    ]
  );

  const checkFollowingStatus = useCallback(async () => {
    if (from === 'douban' || !actualSource || !actualId) return;
    try {
      const isFollowed = await isFollowing(actualSource, actualId);
      setFollowing(isFollowed);
      setFollowingChecked(true);

      const storageKey = generateStorageKey(actualSource, actualId);
      subscribeToDataUpdates('followingsUpdated', (newFollowings: Record<string, any>) => {
        setFollowing(!!newFollowings[storageKey]);
      });
    } catch (err) {
      console.error('检查追更状态失败', err);
    }
  }, [from, actualSource, actualId]);

  const handleToggleFollowing = useCallback(
    async (e?: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (from === 'douban' || !actualSource || !actualId) return;
      try {
        if (following) {
          await deleteFollowing(actualSource, actualId);
          setFollowing(false);
        } else {
          await saveFollowing(actualSource, actualId, {
            title: actualTitle,
            source_name: source_name || '',
            year: sanitizedYear,
            cover: actualPoster,
            total_episodes: actualEpisodes ?? 1,
            watched_episodes: 0,
            save_time: Date.now(),
            search_title: sanitizedQuery,
            source: actualSource,
            id: actualId,
          });
          setFollowing(true);
        }
      } catch (err) {
        console.error('切换追更状态失败', err);
      }
    },
    [
      from,
      actualSource,
      actualId,
      actualTitle,
      source_name,
      sanitizedYear,
      actualPoster,
      actualEpisodes,
      sanitizedQuery,
      following,
    ]
  );

  const handleDeleteRecord = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (from !== 'playrecord' || !actualSource || !actualId) return;
      try {
        await deletePlayRecord(actualSource, actualId);
        onDelete?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('删除播放记录失败', err);
      }
    },
    [from, actualSource, actualId, onDelete]
  );

  const handleClick = useCallback(() => {
    // 点击时不再检查收藏状态
    // 触发加载动画
    startLoading();

    if (from === 'douban') {
      router.push(
        `/play?title=${encodeURIComponent(actualTitle.trim())}${
          sanitizedYear ? `&year=${sanitizedYear}` : ''
        }${actualSearchType ? `&stype=${actualSearchType}` : ''}`
      );
    } else if (actualSource && actualId) {
      // 携带当前播放集数（1 基）：追更页传的是按标题匹配得到的当前集数，
      // 播放页挂载时优先采用该集数开始播放，避免因换片源导致 source+id 记录缺失而回到第 1 集
      const startEp =
        typeof currentEpisode === 'number' &&
        Number.isInteger(currentEpisode) &&
        currentEpisode >= 1
          ? `&ep=${currentEpisode}`
          : '';
      router.push(
        `/play?source=${actualSource}&id=${actualId}&title=${encodeURIComponent(
          actualTitle
        )}${sanitizedYear ? `&year=${sanitizedYear}` : ''}${
          isAggregate ? '&prefer=true' : ''
        }${
          sanitizedQuery ? `&stitle=${encodeURIComponent(sanitizedQuery)}` : ''
        }${actualSearchType ? `&stype=${actualSearchType}` : ''}${startEp}`
      );
    }
  }, [
    from,
    actualSource,
    actualId,
    router,
    actualTitle,
    sanitizedYear,
    isAggregate,
    sanitizedQuery,
    actualSearchType,
    startLoading,
    currentEpisode,
  ]);

  const config = useMemo(() => {
    const configs = {
      playrecord: {
        showSourceName: true,
        showProgress: true,
        showPlayButton: true,
        showHeart: true,
        showFollowButton: true,
        showCheckCircle: true,
        showDoubanLink: !!actualDoubanId,
        showRating: false,
      },
      favorite: {
        showSourceName: true,
        showProgress: false,
        showPlayButton: true,
        showHeart: true,
        showFollowButton: true,
        showCheckCircle: false,
        showDoubanLink: !!actualDoubanId,
        showRating: false,
      },
      search: {
        showSourceName: true,
        showProgress: false,
        showPlayButton: true,
        showHeart: !isAggregate,
        showFollowButton: !isAggregate,
        showCheckCircle: false,
        showDoubanLink: !!actualDoubanId,
        showRating: false,
      },
      douban: {
        showSourceName: false,
        showProgress: false,
        showPlayButton: true,
        showHeart: false,
        showFollowButton: false,
        showCheckCircle: false,
        showDoubanLink: true,
        showRating: !!rate,
      },
    };
    return configs[from] || configs.search;
  }, [from, isAggregate, actualDoubanId, rate]);

  // 渲染
  return (
    <div
      className="group relative w-full rounded-lg bg-transparent cursor-pointer transition-all duration-300 ease-in-out hover:scale-[1.05] hover:z-[500] [container-type:inline-size]"
      style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsActionOpen(true);
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
        }
        const timerId = window.setTimeout(() => {
          setIsActionOpen(true);
        }, 500);
        setLongPressTimer(timerId);
      }}
      onTouchEnd={() => {
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          setLongPressTimer(null);
        }
      }}
      onTouchCancel={() => {
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          setLongPressTimer(null);
        }
      }}
      onMouseEnter={() => {
          // 收藏夹里的卡片在该分支下默认已收藏，但仍需保持与首页/历史一致的追更状态检查
        if (from === 'favorite' && !favorited) {
          setFavorited(true);
          setFavoriteChecked(true);
        } else if (config.showHeart && !favoriteChecked) {
          checkFavoriteStatus();
        }

        if (config.showFollowButton && !followingChecked) {
          checkFollowingStatus();
        }
      }}
    >
      {/* 图片和播放按钮 */}
      <div className='relative aspect-[2/3] overflow-hidden rounded-lg'>
        {!isLoading && <ImagePlaceholder aspectRatio='aspect-[2/3]' />}
        <Image
          src={processImageUrl(actualPoster)}
          alt={actualTitle}
          fill
          className='object-cover'
          referrerPolicy='no-referrer'
          loading='lazy'
          onLoad={() => setIsLoading(true)}
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (!img.dataset.retried) {
              img.dataset.retried = 'true';
              setTimeout(() => {
                img.src = processImageUrl(actualPoster);
              }, 2000);
            }
          }}
        />

        <div className='absolute inset-0 bg-gradient-to-t from-black/80 via-black-20 to-transparent opacity-0 transition-opacity duration-300 ease-in-out group-hover:opacity-100' />

      {/* 播放按钮 */}
      {config.showPlayButton && (
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
              <PlayCircleIcon
                size={50}
                strokeWidth={0.8}
                className="text-white fill-transparent hover:fill-green-500 hover:scale-[1.1] transition"
                onClick={(e) => {
                  e.stopPropagation(); // 阻止冒泡
                  handleClick();       // 只在点击按钮时触发播放
                }}
              />
            </div>
          )}

        {(config.showHeart || config.showFollowButton || config.showCheckCircle) && (
          <div className='absolute bottom-3 inset-x-3 flex items-center justify-end opacity-0 translate-y-2 transition-all duration-300 ease-in-out group-hover:opacity-100 group-hover:translate-y-0 [gap:clamp(0px,4cqi,0.75rem)]'>
            {config.showCheckCircle && onDelete && (
              <Trash2
                onClick={handleDeleteRecord}
                size={20}
                className='flex-shrink-0 text-white transition-all duration-300 ease-out hover:stroke-red-500 hover:scale-[1.1]'
              />
            )}
            {config.showHeart && (
              <Heart
                onClick={handleToggleFavorite}
                size={20}
                className={`flex-shrink-0 transition-all duration-300 ease-out ${
                  favorited
                    ? 'fill-red-600 stroke-red-600'
                    : 'fill-transparent stroke-white hover:stroke-red-400'
                } hover:scale-[1.1]`}
              />
            )}
            {config.showFollowButton && (
              <button
                type='button'
                onClick={handleToggleFollowing}
                className='flex-shrink-0 transition-all duration-300 ease-out hover:scale-[1.1]'
                title={following ? '取消追更' : '加入追更'}
                aria-label={following ? '取消追更' : '加入追更'}
              >
                <FollowingIcon
                  filled={following}
                  size={20}
                  className={
                    following
                      ? 'text-amber-400'
                      : 'text-white'
                  }
                />
              </button>
            )}
          </div>
        )}

        {/* ⭐ 评分显示（左上角小圆圈，可跳转豆瓣或 Bangumi） */}
        {config.showRating && rate && actualDoubanId && (
          <div
            className="absolute top-2 left-2 bg-pink-500 text-white text-[10px] sm:text-xs font-bold px-2 py-0.5 rounded-full shadow-md cursor-pointer hover:bg-pink-600 transition"
          >
            {rate}
          </div>
        )}


        {/* 📅 年份显示（左上角） */}
        {from === 'search' && actualYear && actualYear.toLowerCase() !== 'unknown' && (
        <div
          className="absolute top-2 left-2 bg-black/60 text-white text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full shadow-md"
        >
          {actualYear}
        </div>
        )}

        {/* 🔗 豆瓣/Bangumi跳转链接（左下角） */}
        {config.showDoubanLink && actualDoubanId && (
          <div
            onClick={(e) => {
              e.stopPropagation(); // 阻止触发卡片点击
              
              if (isBangumi) {
                // 动漫 → Bangumi
                window.open(`https://bangumi.tv/subject/${actualDoubanId}`, "_blank");
              } else {
                // 默认 → 豆瓣
                window.open(`https://movie.douban.com/subject/${actualDoubanId}`, "_blank");
              }
            }}
            className="absolute bottom-2 left-2 bg-green-500 text-white text-xs font-bold w-8 h-8 rounded-full flex items-center justify-center shadow-md hover:bg-green-600 hover:scale-[1.1] transition-all duration-300 ease-out opacity-0 group-hover:opacity-100 cursor-pointer"
            title={isBangumi ? "跳转到 Bangumi" : "跳转到豆瓣"}
          >
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
              <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
            </svg>
          </div>
        )}

        {/* 集数 */}
        {actualEpisodes && actualEpisodes > 1 && (
          <div className='absolute top-2 right-2 bg-green-500 text-white text-xs font-semibold px-2 py-1 rounded-md shadow-md transition-all duration-300 ease-out group-hover:scale-110'>
            {currentEpisode ? `${currentEpisode}/${actualEpisodes}` : actualEpisodes}
          </div>
        )}

{/* 播放源徽章 */}
{isAggregate && items && items.length > 0 && (
  <div className="absolute bottom-2 right-2 flex flex-col items-end">
    <div className="relative group/sources">
      {/* 小圆圈按钮：默认显示 */}
      <div
        className="bg-gray-700 text-white text-xs sm:text-xs w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center shadow-md hover:bg-gray-600 hover:scale-[1.1] transition-all duration-300 ease-out cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          setShowSources((prev) => !prev); // 点击切换列表显示
        }}
      >
        {items.length}
      </div>

{/* 播放源列表弹窗 */}
{showSources && (
  <div className="absolute bottom-full mb-2 right-0 sm:right-0 z-50">
    <div className="bg-gray-800/90 backdrop-blur-sm text-white text-xs sm:text-xs rounded-lg shadow-xl border border-white/10 p-1 sm:p-1.5 min-w-[70px] sm:min-w-[90px] max-w-[120px] sm:max-w-[160px] max-h-20 sm:max-h-40 overflow-auto">
      <div className="space-y-0.5 sm:space-y-1">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-1 sm:gap-1.5">
            <div className="w-0.5 h-0.5 sm:w-1 sm:h-1 bg-blue-400 rounded-full flex-shrink-0"></div>
            <span className="truncate text-[10px] sm:text-xs leading-tight" title={item.source_name}>
              {item.source_name}
            </span>
          </div>
        ))}
      </div>

      {/* 小箭头 */}
      <div className="absolute top-full right-2 sm:right-3 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[4px] sm:border-l-[6px] sm:border-r-[6px] sm:border-t-[6px] border-transparent border-t-gray-800/90"></div>
    </div>
  </div>
)}
{/* 播放源列表弹窗 */}

    </div>
  </div>
)}


      </div>

      {config.showProgress && !hideProgress && progress !== undefined && (
        <div className='mt-1 h-1 w-full bg-gray-200 rounded-full overflow-hidden'>
          <div
            className='h-full bg-green-500 transition-all duration-500 ease-out'
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className='mt-2 text-center'>
        <div className='relative'>
          <span className='block text-sm font-semibold truncate text-gray-900 dark:text-gray-100 transition-colors duration-300 ease-in-out group-hover:text-green-600 dark:group-hover:text-green-400 peer'>
            {actualTitle}
          </span>
          <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1 bg-gray-800 text-white text-xs rounded-md shadow-lg opacity-0 invisible peer-hover:opacity-100 peer-hover:visible transition-all duration-200 ease-out delay-100 whitespace-nowrap pointer-events-none'>
            {actualTitle}
            <div className='absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-800'></div>
          </div>
        </div>
        {config.showSourceName && source_name && (
          <span className='block text-xs text-gray-500 dark:text-gray-400 mt-1'>
            <span className='inline-block border rounded px-2 py-0.5 border-gray-500/60 dark:border-gray-400/60 transition-all duration-300 ease-in-out group-hover:border-green-500/60 group-hover:text-green-600 dark:group-hover:text-green-400'>
              {source_name}
            </span>
          </span>
        )}
      </div>

      {/* 右键 / 长按 操作面板 */}
      <MobileActionSheet
        isOpen={isActionOpen}
        onClose={() => setIsActionOpen(false)}
        title={actualTitle}
        poster={processImageUrl(actualPoster)}
        sourceName={source_name}
        isAggregate={isAggregate}
        sources={isAggregate && items ? items.map(i => i.source_name || '').filter(Boolean) : []}
        currentEpisode={currentEpisode}
        totalEpisodes={actualEpisodes || undefined}
        origin="vod"
        actions={[
          {
            id: 'play',
            label: '播放',
            icon: <PlayCircleIcon size={20} />,
            color: 'primary',
            onClick: () => handleClick(),
          },
          {
            id: 'play-new-tab',
            label: '在新标签页播放',
            icon: <ExternalLink size={20} />,
            color: 'default',
            onClick: () => {
              if (from === 'douban') {
                window.open(
                  `/play?title=${encodeURIComponent(actualTitle.trim())}${
                    actualYear ? `&year=${actualYear}` : ''
                  }${actualSearchType ? `&stype=${actualSearchType}` : ''}`,
                  '_blank'
                );
              } else if (actualSource && actualId) {
                // 与主点击一致：携带当前播放集数（1 基）
                const newTabStartEp =
                  typeof currentEpisode === 'number' &&
                  Number.isInteger(currentEpisode) &&
                  currentEpisode >= 1
                    ? `&ep=${currentEpisode}`
                    : '';
                window.open(
                  `/play?source=${actualSource}&id=${actualId}&title=${encodeURIComponent(
                    actualTitle
                  )}${actualYear ? `&year=${actualYear}` : ''}${
                    isAggregate ? '&prefer=true' : ''
                  }${
                    actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''
                  }${actualSearchType ? `&stype=${actualSearchType}` : ''}${newTabStartEp}`,
                  '_blank'
                );
              }
            },
          },
          ...(from !== 'douban' && !(from === 'search' && isAggregate) && actualSource && actualId
            ? [
                favorited
                  ? {
                      id: 'unfavorite',
                      label: '取消收藏',
                      icon: <Heart size={18} className="fill-red-600 stroke-red-600" />,
                      color: 'danger' as const,
                      onClick: (e?: React.MouseEvent) => handleToggleFavorite(e as React.MouseEvent),
                    }
                  : {
                      id: 'favorite',
                      label: '加入收藏',
                      icon: <Heart size={18} className="fill-transparent stroke-gray-600" />,
                      color: 'primary' as const,
                      onClick: (e?: React.MouseEvent) => handleToggleFavorite(e as React.MouseEvent),
                    },
                following
                  ? {
                      id: 'unfollow',
                      label: '取消追更',
                      icon: <FollowingIcon variant='remove' size={18} className='text-amber-500' />,
                      color: 'warning' as const,
                      onClick: (e?: React.MouseEvent) => handleToggleFollowing(e as React.MouseEvent),
                    }
                  : {
                      id: 'follow',
                      label: '加入追更',
                      icon: <FollowingIcon variant='add' size={18} className='text-amber-500' />,
                      color: 'primary' as const,
                      onClick: (e?: React.MouseEvent) => handleToggleFollowing(e as React.MouseEvent),
                    },
              ]
            : []),
          ...(from === 'playrecord' && actualSource && actualId && onDelete
            ? [
                {
                  id: 'delete-record',
                  label: '删除播放记录',
                  icon: <Trash2 size={18} />,
                  color: 'danger' as const,
                  onClick: (e?: React.MouseEvent) => handleDeleteRecord(e as React.MouseEvent),
                },
              ]
            : []),
          ...(actualDoubanId
            ? [
                {
                  id: 'open-link',
                  label: isBangumi ? '打开 Bangumi 页面' : '打开豆瓣页面',
                  icon: <Link size={18} />,
                  onClick: () => {
                    if (isBangumi) {
                      window.open(`https://bangumi.tv/subject/${actualDoubanId}`, '_blank');
                    } else {
                      window.open(`https://movie.douban.com/subject/${actualDoubanId}`, '_blank');
                    }
                  },
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
