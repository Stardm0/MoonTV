/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';

import {
  BangumiCalendarData,
  GetBangumiCalendarData,
} from '@/lib/bangumi.client';
// 客户端收藏 API
import {
  clearAllFavorites,
  FollowingRefreshItem,
  getAllFavorites,
  getAllFollowings,
  getAllPlayRecords,
  getTodayUpdated,
  refreshFollowingsStream,
  saveTodayUpdated,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { getDoubanCategories } from '@/lib/douban.client';
import {
  buildPlayRecordTitleIndex,
  computeUnwatchedEpisodes,
} from '@/lib/following';
import { DoubanItem } from '@/lib/types';

import CapsuleSwitch from '@/components/CapsuleSwitch';
import ContinueWatching from '@/components/ContinueWatching';
import { useNavigationLoading } from '@/components/NavigationLoadingProvider';
import PageLayout from '@/components/PageLayout';
import ScrollableRow from '@/components/ScrollableRow';
import { useSite } from '@/components/SiteProvider';
import VideoCard from '@/components/VideoCard';

function HomeClient() {
  const [activeTab, setActiveTab] = useState<'home' | 'history' | 'following' | 'favorites'>('home');
  const [hotMovies, setHotMovies] = useState<DoubanItem[]>([]);
  const [hotTvShows, setHotTvShows] = useState<DoubanItem[]>([]);
  const [hotVarietyShows, setHotVarietyShows] = useState<DoubanItem[]>([]);
  const [bangumiCalendarData, setBangumiCalendarData] = useState<
    BangumiCalendarData[]
  >([]);
  const [loading, setLoading] = useState(true);
  const { announcement } = useSite();
  const { startLoading } = useNavigationLoading();

  const [showAnnouncement, setShowAnnouncement] = useState(false);
  
  // 检查是否启用简洁模式
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    if (typeof window !== 'undefined') {
      const savedSimpleMode = localStorage.getItem('simpleMode');
      if (savedSimpleMode !== null) {
        setSimpleMode(JSON.parse(savedSimpleMode));
      }
    }
  }, []);

  // 检查公告弹窗状态
  useEffect(() => {
    if (typeof window !== 'undefined' && announcement) {
      const hasSeenAnnouncement = localStorage.getItem('hasSeenAnnouncement');
      if (hasSeenAnnouncement !== announcement) {
        setShowAnnouncement(true);
      } else {
        setShowAnnouncement(Boolean(!hasSeenAnnouncement && announcement));
      }
    }
  }, [announcement]);

  // 收藏夹数据
  type FavoriteItem = {
    id: string;
    source: string;
    title: string;
    poster: string;
    episodes: number;
    source_name: string;
    currentEpisode?: number;
    search_title?: string;
  };

  const [favoriteItems, setFavoriteItems] = useState<FavoriteItem[]>([]);
  const [favoriteLoading, setFavoriteLoading] = useState(false);

  type FollowingItem = {
    id: string;
    source: string;
    title: string;
    poster: string;
    episodes: number;
    watchedEpisodes: number;
    unwatchedEpisodes: number;
    source_name: string;
    year: string;
    search_title?: string;
    save_time: number;
  };

  const [followingItems, setFollowingItems] = useState<FollowingItem[]>([]);
  const [followingListLoading, setFollowingListLoading] = useState(false);
  const [followingUpdatesLoading, setFollowingUpdatesLoading] = useState(false);
  const latestPlayRecordsRef = useRef<Record<string, any>>({});

  // 追更集数刷新进度（流式）
  const [refreshProgress, setRefreshProgress] = useState<{
    total: number;
    success: number;
    failed: number;
    updated: number;
    running: boolean;
  }>({ total: 0, success: 0, failed: 0, updated: 0, running: false });
  const refreshProgressRef = useRef({
    total: 0,
    success: 0,
    failed: 0,
    updated: 0,
    running: false,
  });
  const [refreshFailedItems, setRefreshFailedItems] = useState<
    FollowingRefreshItem[]
  >([]);
  const refreshFailedRef = useRef<FollowingRefreshItem[]>([]);
  // 本轮刷新中“集数有更新”的追更条目（今日有新集数，页面展示）
  type TodayUpdatedItem = FollowingItem & {
    oldEpisodes: number;
    newEpisodes: number;
  };
  const [todayUpdatedItems, setTodayUpdatedItems] = useState<TodayUpdatedItem[]>(
    []
  );
  const todayUpdatedRef = useRef<TodayUpdatedItem[]>([]);
  // 记录“今日新更”列表当前所属日期，用于跨天时自动清空
  const todayUpdatedDateRef = useRef<string>('');
  // 将“今日新更”列表持久化到服务端（保留一天、跟随账号跨设备）
  const persistTodayUpdated = async (items: TodayUpdatedItem[]) => {
    try {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
        2,
        '0'
      )}-${String(now.getDate()).padStart(2, '0')}`;
      await saveTodayUpdated({ date, items });
    } catch (err) {
      console.error('持久化“今日新更”记录失败:', err);
    }
  };
  // 当前完整追更工作列表（随流式结果实时更新），供重试失败项时取最新数据
  const latestFollowingsRef = useRef<Record<string, any>>({});
  // 本次网页会话是否已自动刷新过追更（网页加载后仅第一次进入追更页自动刷新一次）
  const hasAutoRefreshedRef = useRef(false);

  useEffect(() => {
    const fetchRecommendData = async () => {
      try {
        setLoading(true);

        // 检查是否启用简洁模式
        const savedSimpleMode = localStorage.getItem('simpleMode');
        const isSimpleMode = savedSimpleMode ? JSON.parse(savedSimpleMode) : false;

        if (isSimpleMode) {
          // 简洁模式下跳过豆瓣数据获取
          setLoading(false);
          return;
        }

        // 并行获取热门电影、热门剧集和热门综艺
        const [moviesData, tvShowsData, varietyShowsData, bangumiCalendarData] =
          await Promise.all([
            getDoubanCategories({
              kind: 'movie',
              category: '热门',
              type: '全部',
            }),
            getDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' }),
            getDoubanCategories({ kind: 'tv', category: 'show', type: 'show' }),
            GetBangumiCalendarData(),
          ]);

        if (moviesData.code === 200) {
          setHotMovies(moviesData.list);
        }

        if (tvShowsData.code === 200) {
          setHotTvShows(tvShowsData.list);
        }

        if (varietyShowsData.code === 200) {
          setHotVarietyShows(varietyShowsData.list);
        }

        setBangumiCalendarData(bangumiCalendarData);
      } catch (error) {
        console.error('获取推荐数据失败:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchRecommendData();
  }, []);

  // 处理收藏数据更新的函数
  const updateFavoriteItems = async (allFavorites: Record<string, any>) => {
    const allPlayRecords = await getAllPlayRecords();

    // 根据保存时间排序（从近到远）
    const sorted = Object.entries(allFavorites)
      .sort(([, a], [, b]) => b.save_time - a.save_time)
      .map(([key, fav]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);

        // 查找对应的播放记录，获取当前集数
        const playRecord = allPlayRecords[key];
        const currentEpisode = playRecord?.index;

        return {
          id,
          source,
          title: fav.title,
          year: fav.year,
          poster: fav.cover,
          episodes: fav.total_episodes,
          source_name: fav.source_name,
          currentEpisode,
          search_title: fav?.search_title,
        } as FavoriteItem;
      });
    setFavoriteItems(sorted);
  };

  const updateFollowingItems = async (
    allFollowings: Record<string, any>,
    providedPlayRecords?: Record<string, any>
  ) => {
    const allPlayRecords =
      providedPlayRecords ?? latestPlayRecordsRef.current ?? (await getAllPlayRecords());
    latestPlayRecordsRef.current = allPlayRecords;

    // 按标题索引播放记录，优先按标题匹配“当前播放集数/总集数”，
    // 解决用户换片源观看后追更 key(source+id) 与播放记录 key 对不上而取不到的问题。
    const playRecordTitleIndex = buildPlayRecordTitleIndex(allPlayRecords);

    const sorted = Object.entries(allFollowings)
      .sort(([, a], [, b]) => (b.save_time || 0) - (a.save_time || 0))
      .map(([key, item]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);
        // 匹配顺序：先按追更标题精确命中最新播放记录，未命中再回退 source+id 直查
        const matchedPlayRecord =
          playRecordTitleIndex.get(item.title) ?? allPlayRecords[key];
        const watchedEpisodes =
          matchedPlayRecord?.index ?? item.watched_episodes ?? 0;
        const totalEpisodes =
          item.total_episodes || matchedPlayRecord?.total_episodes || 1;
        const unwatchedEpisodes = computeUnwatchedEpisodes({
          totalEpisodes,
          watchedEpisodes,
        });

        return {
          id,
          source,
          title: item.title,
          poster: item.cover,
          episodes: totalEpisodes,
          watchedEpisodes,
          unwatchedEpisodes,
          source_name: item.source_name,
          year: item.year && item.year !== 'unknown' ? item.year : '',
          search_title: item.search_title && item.search_title !== item.title ? item.search_title : '',
          save_time: item.save_time,
        } as FollowingItem;
      });
    setFollowingItems(sorted);
  };

  // 更新进度（同步 ref 与 state，避免异步竞态）
  const updateProgress = (patch: Partial<typeof refreshProgressRef.current>) => {
    refreshProgressRef.current = {
      ...refreshProgressRef.current,
      ...patch,
    };
    setRefreshProgress({ ...refreshProgressRef.current });
  };

  // 核心：对指定追更子集执行流式刷新，并实时更新 UI 与进度
  const runFollowingRefresh = async (
    targetFollowings: Record<string, any>,
    playRecords: Record<string, any>,
    isRetry: boolean
  ) => {
    const targetCount = Object.keys(targetFollowings).length;
    if (targetCount === 0) return;

    // 完整工作列表：以当前最新完整列表为基础
    const workingFollowings: Record<string, any> = {
      ...latestFollowingsRef.current,
    };
    // 确保目标项都在工作列表中（首次刷新时 latestFollowingsRef 可能为空）
    Object.entries(targetFollowings).forEach(([k, v]) => {
      if (!workingFollowings[k]) workingFollowings[k] = v;
    });
    latestFollowingsRef.current = workingFollowings;

    // 失败列表每轮清空；“今日新更”仅跨天清空，同一天内再次刷新保留当天记录
    refreshFailedRef.current = [];
    setRefreshFailedItems([]);
    const todayStr = new Date().toDateString();
    if (todayStr !== todayUpdatedDateRef.current) {
      todayUpdatedDateRef.current = todayStr;
      todayUpdatedRef.current = [];
      setTodayUpdatedItems([]);
      // 跨天清空服务端“今日新更”记录
      persistTodayUpdated([]);
    }

    if (isRetry) {
      // 重试失败项：总数保持与总追更数一致，success/updated 累加，failed 归零重计
      updateProgress({ failed: 0, running: true });
    } else {
      // 全新一轮刷新：total = 总追更数，其余归零
      const totalCount =
        Object.keys(latestFollowingsRef.current).length || targetCount;
      updateProgress({
        total: totalCount,
        success: 0,
        failed: 0,
        updated: 0,
        running: true,
      });
    }

    const applyItem = (key: string, totalEpisodes?: number, title?: string) => {
      const existing = workingFollowings[key];
      if (!existing) return;
      if (totalEpisodes && totalEpisodes > 0) {
        workingFollowings[key] = {
          ...existing,
          total_episodes: totalEpisodes,
          title: title || existing.title,
        };
        latestFollowingsRef.current = { ...workingFollowings };
      }
      // 实时刷新列表 UI（含“有新未观看集数”与“全部追更”）
      updateFollowingItems(workingFollowings, playRecords);
    };

    await refreshFollowingsStream(
      targetFollowings,
      {
      // 仅在首次刷新时用服务端返回的总数校准（重试时保持 total 不变）
      onStart: (t) => {
        if (!isRetry && t) {
          updateProgress({ total: t });
        }
      },
      onItemResult: (item) => {
        // 记录更新前的旧集数，用于展示“新更新了多少集”
        const oldEpisodes = workingFollowings[item.key]?.total_episodes;
        applyItem(item.key, item.total_episodes, item.title);
        if (item.updated) {
          const updated = workingFollowings[item.key];
          const plusIndex = item.key.indexOf('+');
          const source = item.key.slice(0, plusIndex);
          const id = item.key.slice(plusIndex + 1);
          const watchedEpisodes =
            playRecords[item.key]?.index ?? updated?.watched_episodes ?? 0;
          const newEpisodes = item.total_episodes || updated?.total_episodes || 0;
          const entry: TodayUpdatedItem = {
            id,
            source,
            title: item.title || updated?.title || item.key,
            poster: updated?.cover || '',
            episodes: newEpisodes,
            watchedEpisodes,
            unwatchedEpisodes: computeUnwatchedEpisodes({
              totalEpisodes: newEpisodes,
              watchedEpisodes,
            }),
            source_name: updated?.source_name || '',
            year:
              updated?.year && updated.year !== 'unknown' ? updated.year : '',
            save_time: updated?.save_time || 0,
            oldEpisodes: oldEpisodes || 0,
            newEpisodes,
          };
          // 合并进“今日新更”：同一影片已存在则更新其记录，否则追加（保留一天）
          const existingIdx = todayUpdatedRef.current.findIndex(
            (e) => e.source === entry.source && e.id === entry.id
          );
          if (existingIdx >= 0) {
            todayUpdatedRef.current[existingIdx] = entry;
          } else {
            todayUpdatedRef.current = [...todayUpdatedRef.current, entry];
          }
          setTodayUpdatedItems([...todayUpdatedRef.current]);
          // 持久化到服务端（保留一天、跟随账号跨设备）
          persistTodayUpdated(todayUpdatedRef.current);
        }
        updateProgress({
          success: refreshProgressRef.current.success + 1,
          updated:
            refreshProgressRef.current.updated + (item.updated ? 1 : 0),
        });
      },
      onItemFailed: (item) => {
        refreshFailedRef.current = [...refreshFailedRef.current, item];
        setRefreshFailedItems(refreshFailedRef.current);
        updateProgress({
          failed: refreshProgressRef.current.failed + 1,
        });
      },
      onComplete: () => {
        // 成功/失败/更新数已通过逐条事件累加，此处仅结束运行态
        updateProgress({ running: false });
        // 最终以服务端写回后的完整列表为准
        updateFollowingItems(workingFollowings, playRecords);
      },
      },
      // 传入完整工作列表作为广播/缓存基础：重试失败项时 targetFollowings 仅为子集，
      // 若不传完整列表，refreshFollowingsStream 会用子集覆盖完整追更缓存与 UI，
      // 导致“全部追更”只剩失败项。
      workingFollowings
    );
  };

  const refreshFollowingRecords = async (
    allFollowings?: Record<string, any>,
    allPlayRecords?: Record<string, any>
  ) => {
    const followings = allFollowings ?? (await getAllFollowings());
    const playRecords =
      allPlayRecords ?? latestPlayRecordsRef.current ?? (await getAllPlayRecords());
    latestPlayRecordsRef.current = playRecords;
    latestFollowingsRef.current = { ...followings };

    // 首次进入追更页的全新一轮完整刷新：设置 total = 总追更数
    await runFollowingRefresh(followings, playRecords, false);
  };

  // 重试刷新失败的追更项
  const retryFailedFollowings = async () => {
    const failed = refreshFailedRef.current;
    if (failed.length === 0) return;

    const playRecords =
      latestPlayRecordsRef.current ?? (await getAllPlayRecords());
    latestPlayRecordsRef.current = playRecords;

    // 从完整工作列表中取出失败项的最新数据作为重试目标
    const retryTarget: Record<string, any> = {};
    failed.forEach((f) => {
      const latest = latestFollowingsRef.current[f.key];
      if (latest) retryTarget[f.key] = latest;
    });

    if (Object.keys(retryTarget).length === 0) return;
    // 重试失败项：保持 total 与总追更数一致，success/updated 累加
    await runFollowingRefresh(retryTarget, playRecords, true);
  };

  // 手动刷新：重新读取最新追更数据并执行一轮完整刷新
  const handleManualRefresh = async () => {
    if (refreshProgressRef.current.running) return;
    try {
      const allFollowings = await getAllFollowings();
      const allPlayRecords = await getAllPlayRecords();
      await refreshFollowingRecords(allFollowings, allPlayRecords);
    } catch (err) {
      console.error('手动刷新追更失败', err);
    }
  };

  useEffect(() => {
    if (activeTab !== 'favorites') return;

    const loadFavorites = async () => {
      setFavoriteLoading(true);
      try {
        const allFavorites = await getAllFavorites();
        await updateFavoriteItems(allFavorites);
      } finally {
        setFavoriteLoading(false);
      }
    };

    loadFavorites();

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (newFavorites: Record<string, any>) => {
        updateFavoriteItems(newFavorites);
      }
    );

    return unsubscribe;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'following') return;

    const loadFollowings = async () => {
      setFollowingListLoading(true);
      setFollowingUpdatesLoading(true);
      try {
        // 进入追更页时以远端 /api/followings 为准：若有本地缓存则先返回缓存用于立即展示，
        // 后台再以远端覆盖本地缓存（若不一致）；若无缓存则阻塞拉取远端。
        const allFollowings = await getAllFollowings(true);
        const allPlayRecords = await getAllPlayRecords();
        latestPlayRecordsRef.current = allPlayRecords;

        // 从服务端恢复“今日新更”记录（保留一天、跟随账号跨设备）
        try {
          const saved = await getTodayUpdated();
          const todayStr = new Date().toDateString();
          if (saved && saved.items && saved.items.length > 0) {
            // 仅当服务端记录属于今天时才恢复，否则视为跨天自动清空
            const savedDate = new Date(saved.date + 'T00:00:00');
            const isToday =
              savedDate.getFullYear() === new Date().getFullYear() &&
              savedDate.getMonth() === new Date().getMonth() &&
              savedDate.getDate() === new Date().getDate();
            if (isToday) {
              todayUpdatedDateRef.current = todayStr;
              todayUpdatedRef.current = saved.items as TodayUpdatedItem[];
              setTodayUpdatedItems([...todayUpdatedRef.current]);
            }
          }
        } catch (err) {
          console.error('恢复“今日新更”记录失败:', err);
        }

        // 先展示本地追更数据（缓存），避免“全部追更/有未观看”被更新请求阻塞而显示加载中
        await updateFollowingItems(allFollowings, allPlayRecords);
        setFollowingListLoading(false);
        setFollowingUpdatesLoading(false);

        // 网页加载后仅第一次进入追更页自动刷新一次，之后改为手动刷新。
        // 后台执行（不 await），让界面先展示缓存数据，刷新完成后通过事件/回调更新。
        if (!hasAutoRefreshedRef.current) {
          hasAutoRefreshedRef.current = true;
          refreshFollowingRecords(allFollowings, allPlayRecords);
        }
      } finally {
        setFollowingListLoading(false);
        setFollowingUpdatesLoading(false);
      }
    };

    loadFollowings();

    const unsubscribe = subscribeToDataUpdates(
      'followingsUpdated',
      (newFollowings: Record<string, any>) => {
        updateFollowingItems(newFollowings, latestPlayRecordsRef.current);

        // 取消追更后，同步移除“今日新更”中对应的条目并持久化
        const current = todayUpdatedRef.current;
        if (current.length > 0) {
          const kept = current.filter(
            (item) => !!newFollowings[`${item.source}+${item.id}`]
          );
          if (kept.length !== current.length) {
            todayUpdatedRef.current = kept;
            setTodayUpdatedItems([...kept]);
            persistTodayUpdated(kept);
          }
        }
      }
    );

    return unsubscribe;
  }, [activeTab]);

  const handleCloseAnnouncement = (announcement: string) => {
    setShowAnnouncement(false);
    localStorage.setItem('hasSeenAnnouncement', announcement); // 记录已查看弹窗
  };

  // 点击进度圆圈：展示刷新结果（成功/失败明细），失败时可重试
  const handleShowRefreshResult = () => {
    const failed = refreshFailedRef.current;
    const { success, failed: failedCount, updated, total, running } = refreshProgress;

    const failedHtml =
      failed.length > 0
        ? `<div class="mt-3 text-left max-h-60 overflow-y-auto rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
             <div class="text-sm font-semibold mb-2 text-red-500">未成功获取集数 (${failed.length})：</div>
             ${failed
               .map(
                 (f) =>
                   `<div class="flex items-start justify-between gap-2 py-1.5 text-xs border-b border-gray-200 dark:border-gray-700 last:border-0">
                      <div class="flex-1 min-w-0">
                        <div class="text-gray-700 dark:text-gray-300 truncate">${f.title || f.key}</div>
                        <div class="text-red-400 mt-0.5">原因：${f.reason || '未知'}</div>
                      </div>
                    </div>`
               )
               .join('')}
           </div>`
        : '';

    const canRetry = failed.length > 0 && !running;

    Swal.fire({
      title: running ? '正在刷新集数…' : '刷新结果',
      html: `
        <div class="text-sm text-gray-600 dark:text-gray-300">
          <div class="flex items-center justify-center gap-2 mb-2">
            ${running ? '<div class="animate-spin rounded-full h-4 w-4 border-b-2 border-green-500"></div>' : ''}
            <span>成功获取 <b class="text-green-600">${success}</b> / ${total}</span>
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            新更影片数：<b class="text-blue-600">${updated}</b> | 失败：<b class="text-red-500">${failedCount}</b>
          </div>
        </div>
        ${failedHtml}
      `,
      icon: failedCount > 0 ? 'warning' : 'success',
      showCancelButton: canRetry,
      confirmButtonText: canRetry ? '重试失败项' : '知道了',
      cancelButtonText: '关闭',
      confirmButtonColor: '#10b981',
      cancelButtonColor: '#6b7280',
    }).then((result) => {
      if (result.isConfirmed && canRetry) {
        retryFailedFollowings();
      }
    });
  };

  return (
    <PageLayout>
      <div className='px-2 sm:px-10 py-4 sm:py-8 overflow-visible'>
        {/* 顶部 Tab 切换 */}
        <div className='mb-8 flex justify-center'>
          <CapsuleSwitch
            options={simpleMode ? [
              { label: '历史', value: 'history' },
              { label: '追更', value: 'following' },
              { label: '收藏夹', value: 'favorites' },
            ] : [
              { label: '首页', value: 'home' },
              { label: '历史', value: 'history' },
              { label: '追更', value: 'following' },
              { label: '收藏夹', value: 'favorites' },
            ]}
            active={simpleMode && activeTab === 'home' ? 'history' : activeTab}
            onChange={(value) => setActiveTab(value as 'home' | 'history' | 'following' | 'favorites')}
          />
        </div>

        <div className='max-w-[95%] mx-auto'>
          {activeTab === 'history' ? (
            // 历史视图 - 显示所有播放记录的网格布局
            <ContinueWatching showAll={true} />
          ) : activeTab === 'following' ? (
            <section className='mb-8'>
              <div className='mb-4 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  我的追更
                </h2>
                <div className='flex items-center gap-2'>
                  {/* 手动刷新按钮 */}
                  <button
                    onClick={handleManualRefresh}
                    disabled={refreshProgress.running}
                    className='flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:border-green-400 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                    title='手动刷新所有追更集数'
                  >
                    <svg
                      className={`h-3.5 w-3.5 ${refreshProgress.running ? 'animate-spin' : ''}`}
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='2'
                      strokeLinecap='round'
                      strokeLinejoin='round'
                    >
                      <path d='M21 12a9 9 0 1 1-2.64-6.36' />
                      <polyline points='21 3 21 9 15 9' />
                    </svg>
                    <span>刷新</span>
                  </button>
                  {/* 刷新进度圆圈：显示成功获取集数个数，点击查看明细/失败列表 */}
                  {refreshProgress.total > 0 && (
                    <button
                      onClick={handleShowRefreshResult}
                      className='group flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:border-green-400 hover:text-green-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                      title='点击查看刷新明细'
                    >
                      {refreshProgress.running ? (
                        <svg
                          className='h-4 w-4 animate-spin text-green-500'
                          viewBox='0 0 24 24'
                          fill='none'
                        >
                          <circle
                            className='opacity-25'
                            cx='12'
                            cy='12'
                            r='10'
                            stroke='currentColor'
                            strokeWidth='4'
                          />
                          <path
                            className='opacity-75'
                            fill='currentColor'
                            d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z'
                          />
                        </svg>
                      ) : (
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                            refreshProgress.failed > 0
                              ? 'bg-amber-500'
                              : 'bg-green-500'
                          }`}
                        >
                          ✓
                        </span>
                      )}
                      <span>
                        成功 {refreshProgress.success}/{refreshProgress.total}
                      </span>
                      {refreshProgress.failed > 0 && (
                        <span className='text-red-500'>
                          ({refreshProgress.failed} 失败)
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className='space-y-8'>
                <div>
                  <h3 className='mb-4 text-sm font-medium text-gray-600 dark:text-gray-300'>
                    今日新更
                  </h3>
                  {(followingUpdatesLoading || refreshProgress.running) &&
                  todayUpdatedItems.length === 0 ? (
                    <div className='flex justify-center py-8'>
                      <div className='flex items-center gap-2 text-gray-500 dark:text-gray-400'>
                        <div className='animate-spin rounded-full h-5 w-5 border-b-2 border-green-500'></div>
                        <span className='text-sm'>加载中...</span>
                      </div>
                    </div>
                  ) : todayUpdatedItems.length > 0 ? (
                    <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                      {todayUpdatedItems.map((item) => (
                        <div key={`${item.source}-${item.id}-updated`} className='w-full'>
                          <VideoCard
                            id={item.id}
                            title={item.title}
                            poster={item.poster}
                            year={item.year && item.year !== 'unknown' ? item.year : ''}
                            source={item.source}
                            source_name={item.source_name}
                            episodes={item.episodes}
                            currentEpisode={item.watchedEpisodes}
                            from='playrecord'
                            hideProgress
                            type={item.episodes > 1 ? 'tv' : ''}
                          />
                          <div className='mt-2 text-center text-xs font-medium text-green-600 dark:text-green-400'>
                            新更新 {item.newEpisodes - item.oldEpisodes} 集（{item.oldEpisodes} → {item.newEpisodes}）
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className='text-center text-gray-500 py-6 dark:text-gray-400'>
                      暂无新集数更新
                    </div>
                  )}
                </div>

                <div>
                  <h3 className='mb-4 text-sm font-medium text-gray-600 dark:text-gray-300'>
                    有未观看
                  </h3>
                  {(followingUpdatesLoading || refreshProgress.running) &&
                  followingItems.filter((item) => item.unwatchedEpisodes > 0).length === 0 ? (
                    <div className='flex justify-center py-8'>
                      <div className='flex items-center gap-2 text-gray-500 dark:text-gray-400'>
                        <div className='animate-spin rounded-full h-5 w-5 border-b-2 border-green-500'></div>
                        <span className='text-sm'>加载中...</span>
                      </div>
                    </div>
                  ) : followingItems.filter((item) => item.unwatchedEpisodes > 0).length > 0 ? (
                    <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                      {followingItems
                        .filter((item) => item.unwatchedEpisodes > 0)
                        .map((item) => (
                          <div key={item.source + item.id} className='w-full'>
                            <VideoCard
                              id={item.id}
                              title={item.title}
                              poster={item.poster}
                              year={item.year && item.year !== 'unknown' ? item.year : ''}
                              source={item.source}
                              source_name={item.source_name}
                              episodes={item.episodes}
                              currentEpisode={item.watchedEpisodes}
                              from='playrecord'
                              hideProgress
                              type={item.episodes > 1 ? 'tv' : ''}
                            />
                            <div className='mt-2 text-center text-xs font-medium text-red-500 dark:text-red-400'>
                              还有 {item.unwatchedEpisodes} 集未看
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className='text-center text-gray-500 py-6 dark:text-gray-400'>
                      暂无未观看
                    </div>
                  )}
                </div>

                <div>
                  <h3 className='mb-4 text-sm font-medium text-gray-600 dark:text-gray-300'>
                    全部追更
                  </h3>
                  {followingListLoading ? (
                    <div className='flex justify-center py-8'>
                      <div className='flex items-center gap-2 text-gray-500 dark:text-gray-400'>
                        <div className='animate-spin rounded-full h-5 w-5 border-b-2 border-green-500'></div>
                        <span className='text-sm'>加载中...</span>
                      </div>
                    </div>
                  ) : (
                    <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                      {followingItems.map((item) => (
                        <div key={`${item.source}-${item.id}-all`} className='w-full'>
                          <VideoCard
                            id={item.id}
                            title={item.title}
                            poster={item.poster}
                            year={item.year && item.year !== 'unknown' ? item.year : ''}
                            source={item.source}
                            source_name={item.source_name}
                            episodes={item.episodes}
                            currentEpisode={item.watchedEpisodes}
                            from='playrecord'
                            hideProgress
                            type={item.episodes > 1 ? 'tv' : ''}
                          />
                          <div className='mt-2 text-center text-xs text-gray-500 dark:text-gray-400'>
                            已看 {item.watchedEpisodes}/{item.episodes}
                          </div>
                        </div>
                      ))}
                      {followingItems.length === 0 && (
                        <div className='col-span-full text-center text-gray-500 py-8 dark:text-gray-400'>
                          暂无追更内容
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : activeTab === 'favorites' ? (
            // 收藏夹视图
            <section className='mb-8'>
              <div className='mb-4 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  我的收藏
                </h2>
                {favoriteItems.length > 0 && (
                  <button
                    className='text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                    onClick={async () => {
                      const { isConfirmed } = await Swal.fire({
                        title: '确认清空',
                        text: '确定要清空所有收藏吗？',
                        icon: 'warning',
                        showCancelButton: true,
                        confirmButtonText: '确定',
                        cancelButtonText: '取消',
                      });
                      if (isConfirmed) {
                        await clearAllFavorites();
                        setFavoriteItems([]);
                        Swal.fire({
                          icon: 'success',
                          title: '已清空',
                          text: '所有收藏已清空',
                          timer: 2000,
                          showConfirmButton: false,
                        });
                      }
                    }}
                  >
                    清空
                  </button>
                )}
              </div>
              {favoriteLoading ? (
                <div className='flex justify-center py-8'>
                  <div className='flex items-center gap-2 text-gray-500 dark:text-gray-400'>
                    <div className='animate-spin rounded-full h-5 w-5 border-b-2 border-green-500'></div>
                    <span className='text-sm'>加载中...</span>
                  </div>
                </div>
              ) : (
                <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                  {favoriteItems.map((item) => (
                    <div key={item.id + item.source} className='w-full'>
                      <VideoCard
                        query={item.search_title}
                        {...item}
                        from='favorite'
                        type={item.episodes > 1 ? 'tv' : ''}
                      />
                    </div>
                  ))}
                  {favoriteItems.length === 0 && (
                    <div className='col-span-full text-center text-gray-500 py-8 dark:text-gray-400'>
                      暂无收藏内容
                    </div>
                  )}
                </div>
              )}
            </section>
          ) : (
            // 首页视图
            <>
              {/* 继续观看 - 组件内部已处理简洁模式 */}
              <ContinueWatching />

              {/* 简洁模式下只显示收藏夹，但在服务器端渲染时先不渲染 */}
              {isClient && !simpleMode && (
                <>
                  {/* 热门电影 */}
                  <section className='mb-8'>
                    <div className='mb-4 flex items-center justify-between'>
                      <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                        热门电影
                      </h2>
                      <Link
                        href='/douban?type=movie'
                        onClick={startLoading}
                        className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      >
                        查看更多
                        <ChevronRight className='w-4 h-4 ml-1' />
                      </Link>
                    </div>
                    <ScrollableRow>
                      {loading
                        ? // 加载状态显示灰色占位数据
                          Array.from({ length: 8 }).map((_, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                                <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                              </div>
                              <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                            </div>
                          ))
                        : // 显示真实数据
                          hotMovies.map((movie, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
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
                    </ScrollableRow>
                  </section>

                  {/* 热门剧集 */}
                  <section className='mb-8'>
                    <div className='mb-4 flex items-center justify-between'>
                      <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                        热门剧集
                      </h2>
                      <Link
                        href='/douban?type=tv'
                        onClick={startLoading}
                        className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      >
                        查看更多
                        <ChevronRight className='w-4 h-4 ml-1' />
                      </Link>
                    </div>
                    <ScrollableRow>
                      {loading
                        ? // 加载状态显示灰色占位数据
                          Array.from({ length: 8 }).map((_, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                                <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                              </div>
                              <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                            </div>
                          ))
                        : // 显示真实数据
                          hotTvShows.map((show, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <VideoCard
                                from='douban'
                                title={show.title}
                                poster={show.poster}
                                douban_id={Number(show.id)}
                                rate={show.rate}
                                year={show.year}
                              />
                            </div>
                          ))}
                    </ScrollableRow>
                  </section>

                  {/* 每日新番放送 */}
                  <section className='mb-8'>
                    <div className='mb-4 flex items-center justify-between'>
                      <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                        新番放送
                      </h2>
                      <Link
                        href='/douban?type=anime'
                        onClick={startLoading}
                        className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      >
                        查看更多
                        <ChevronRight className='w-4 h-4 ml-1' />
                      </Link>
                    </div>
                    <ScrollableRow>
                      {loading
                        ? // 加载状态显示灰色占位数据
                          Array.from({ length: 8 }).map((_, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                                <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                              </div>
                              <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                            </div>
                          ))
                        : // 展示当前日期的番剧
                          (() => {
                            // 获取当前日期对应的星期
                            const today = new Date();
                            const weekdays = [
                              'Sun',
                              'Mon',
                              'Tue',
                              'Wed',
                              'Thu',
                              'Fri',
                              'Sat',
                            ];
                            const currentWeekday = weekdays[today.getDay()];

                            // 找到当前星期对应的番剧数据
                            const todayAnimes =
                              bangumiCalendarData.find(
                                (item) => item.weekday.en === currentWeekday
                              )?.items || [];

                            return todayAnimes.map((anime, index) => (
                              <div
                                key={`${anime.id}-${index}`}
                                className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                              >
                                <VideoCard
                                  from='douban'
                                  title={anime.name_cn || anime.name}
                                  poster={
                                    anime.images.large ||
                                    anime.images.common ||
                                    anime.images.medium ||
                                    anime.images.small ||
                                    anime.images.grid
                                  }
                                  douban_id={anime.id}
                                  rate={anime.rating?.score?.toString() || ''}
                                  year={anime.air_date?.split('-')?.[0] || ''}
                                  isBangumi={true}
                                />
                              </div>
                            ));
                          })()}
                    </ScrollableRow>
                  </section>

                  {/* 热门综艺 */}
                  <section className='mb-8'>
                    <div className='mb-4 flex items-center justify-between'>
                      <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                        热门综艺
                      </h2>
                      <Link
                        href='/douban?type=show'
                        onClick={startLoading}
                        className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      >
                        查看更多
                        <ChevronRight className='w-4 h-4 ml-1' />
                      </Link>
                    </div>
                    <ScrollableRow>
                      {loading
                        ? // 加载状态显示灰色占位数据
                          Array.from({ length: 8 }).map((_, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                                <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                              </div>
                              <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                            </div>
                          ))
                        : // 显示真实数据
                          hotVarietyShows.map((show, index) => (
                            <div
                              key={index}
                              className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                            >
                              <VideoCard
                                from='douban'
                                title={show.title}
                                poster={show.poster}
                                douban_id={Number(show.id)}
                                rate={show.rate}
                                year={show.year}
                              />
                            </div>
                          ))}
                    </ScrollableRow>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {announcement && showAnnouncement && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm dark:bg-black/70 p-4 transition-opacity duration-300 ${
            showAnnouncement ? '' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900 transform transition-all duration-300 hover:shadow-2xl'>
            <div className='flex justify-between items-start mb-4'>
              <h3 className='text-2xl font-bold tracking-tight text-gray-800 dark:text-white border-b border-green-500 pb-1'>
                提示
              </h3>
              <button
                onClick={() => handleCloseAnnouncement(announcement)}
                className='text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-white transition-colors'
                aria-label='关闭'
              ></button>
            </div>
            <div className='mb-6'>
              <div className='relative overflow-hidden rounded-lg mb-4 bg-green-50 dark:bg-green-900/20'>
                <div className='absolute inset-y-0 left-0 w-1.5 bg-green-500 dark:bg-green-400'></div>
                <p className='ml-4 text-gray-600 dark:text-gray-300 leading-relaxed'>
                  {announcement}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleCloseAnnouncement(announcement)}
              className='w-full rounded-lg bg-gradient-to-r from-green-600 to-green-700 px-4 py-3 text-white font-medium shadow-md hover:shadow-lg hover:from-green-700 hover:to-green-800 dark:from-green-600 dark:to-green-700 dark:hover:from-green-700 dark:hover:to-green-800 transition-all duration-300 transform hover:-translate-y-0.5'
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </PageLayout>
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeClient />
    </Suspense>
  );
}
