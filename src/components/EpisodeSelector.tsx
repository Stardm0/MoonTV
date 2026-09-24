/* eslint-disable @next/next/no-img-element */

import { useRouter } from 'next/navigation';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildEpisodePageRanges,
  clearEpisodeFilterConfig,
  countEpisodePages,
  createEpisodeFilterRule,
  EpisodeFilterConfig,
  filterEpisodeIndexes,
  loadEpisodeFilterConfig,
  saveEpisodeFilterConfig,
  sliceEpisodePage,
} from '@/lib/episode-filter';
import { SearchResult } from '@/lib/types';
import { getVideoResolutionFromM3u8, processImageUrl } from '@/lib/utils';

// 定义视频信息类型
interface VideoInfo {
  quality: string;
  loadSpeed: string;
  pingTime: number;
  hasError?: boolean; // 添加错误状态标识
}

interface EpisodeSelectorProps {
  /** 总集数 */
  totalEpisodes: number;
  /** 剧集标题 */
  episodes_titles: string[];
  /** 每页显示多少集，默认 50 */
  episodesPerPage?: number;
  /** 当前选中的集数（1 开始） */
  value?: number;
  /** 用户点击选集后的回调 */
  onChange?: (episodeNumber: number) => void;
  /** 换源相关 */
  onSourceChange?: (source: string, id: string, title: string) => void;
  currentSource?: string;
  currentId?: string;
  videoTitle?: string;
  videoYear?: string;
  availableSources?: SearchResult[];
  sourceSearchLoading?: boolean;
  sourceSearchError?: string | null;
  /** 预计算的测速结果，避免重复测速 */
  precomputedVideoInfo?: Map<string, VideoInfo>;
  /** 优选播放源相关 */
  preferBestSource?: (sources: SearchResult[], isCancelled?: () => boolean) => Promise<SearchResult>;
  setLoading: (loading: boolean) => void;
  /** 设置视频是否正在加载中的状态 */
  setIsVideoLoading: (loading: boolean) => void;
  /** 设置视频加载阶段的状态 */
  setVideoLoadingStage: (stage: 'initing' | 'sourceChanging' | 'optimizing') => void;
}

/**
 * 选集组件，支持分页、自动滚动聚焦当前分页标签，以及换源功能。
 */
const EpisodeSelector: React.FC<EpisodeSelectorProps> = ({
  totalEpisodes,
  episodes_titles,
  episodesPerPage = 50,
  value = 1,
  onChange,
  onSourceChange,
  currentSource,
  currentId,
  videoTitle,
  availableSources = [],
  sourceSearchLoading = false,
  sourceSearchError = null,
  precomputedVideoInfo,
  preferBestSource,
  setLoading,
  setIsVideoLoading,
  setVideoLoadingStage
}) => {
  const router = useRouter();

  // 存储每个源的视频信息
  const [videoInfoMap, setVideoInfoMap] = useState<Map<string, VideoInfo>>(
    new Map()
  );
  const [attemptedSources, setAttemptedSources] = useState<Set<string>>(
    new Set()
  );

  // 使用 ref 来避免闭包问题
  const attemptedSourcesRef = useRef<Set<string>>(new Set());
  const videoInfoMapRef = useRef<Map<string, VideoInfo>>(new Map());

  // 同步状态到 ref
  useEffect(() => {
    attemptedSourcesRef.current = attemptedSources;
  }, [attemptedSources]);

  useEffect(() => {
    videoInfoMapRef.current = videoInfoMap;
  }, [videoInfoMap]);

  // 主要的 tab 状态：'episodes' 或 'sources'
  // 当只有一集时默认展示 "换源"，并隐藏 "选集" 标签
  const [activeTab, setActiveTab] = useState<'episodes' | 'sources'>(
    totalEpisodes > 1 ? 'episodes' : 'sources'
  );

  // 当前分页索引（0 开始）
  const initialPage = Math.floor((value - 1) / episodesPerPage);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);

  // 是否倒序显示
  const [descending, setDescending] = useState<boolean>(false);
  // 优选播放源加载状态
  const [isOptimizing, setIsOptimizing] = useState<boolean>(false);
  // 取消优选标志
  const cancelOptimizationRef = useRef<boolean>(false);

  // 剧集标题过滤配置（预告/花絮/番外等）
  const [filterConfig, setFilterConfig] = useState<EpisodeFilterConfig>(() =>
    loadEpisodeFilterConfig()
  );
  // 过滤面板是否展开
  const [showFilterPanel, setShowFilterPanel] = useState<boolean>(false);
  // 添加屏蔽词输入框
  const [filterKeywordInput, setFilterKeywordInput] = useState<string>('');

  // 需要排除的集数下标（1 起算的集号）
  const hiddenEpisodeNumbers = useMemo(() => {
    const hidden = new Set<number>();
    const titles = episodes_titles || [];
    if (!filterConfig.rules.some((rule) => rule.enabled)) return hidden;

    const visibleIndexes = new Set(filterEpisodeIndexes(titles, filterConfig));
    for (let i = 0; i < totalEpisodes; i += 1) {
      // 不是"被隐藏"，就是"因为规则被筛掉"
      if (!visibleIndexes.has(i)) hidden.add(i + 1);
    }
    return hidden;
  }, [episodes_titles, filterConfig, totalEpisodes]);

  const activeFilterCount = useMemo(
    () => filterConfig.rules.filter((rule) => rule.enabled).length,
    [filterConfig]
  );

  // 保留下来的集号（1 起算），已按升序排列。无过滤时等价于 [1..totalEpisodes]
  const visibleEpisodeNumbers = useMemo(() => {
    if (hiddenEpisodeNumbers.size === 0) {
      return Array.from({ length: totalEpisodes }, (_, i) => i + 1);
    }
    const result: number[] = [];
    for (let n = 1; n <= totalEpisodes; n += 1) {
      if (!hiddenEpisodeNumbers.has(n)) result.push(n);
    }
    return result;
  }, [hiddenEpisodeNumbers, totalEpisodes]);

  // 分页必须按「过滤后」的集数来算，否则隐藏掉一半集数后会多出一堆空页
  const pageCount = useMemo(
    () => countEpisodePages(visibleEpisodeNumbers.length, episodesPerPage),
    [visibleEpisodeNumbers.length, episodesPerPage]
  );

  // 过滤条件变化时立刻落盘；内部已处理"空配置则清空存储项"
  useEffect(() => {
    saveEpisodeFilterConfig(filterConfig);
  }, [filterConfig]);

  const handleAddFilterRule = useCallback(() => {
    const raw = filterKeywordInput.trim();
    if (!raw) return;
    // 以 re: 前缀标记正则，和弹幕屏蔽保持同一套书写习惯
    const isRegex = raw.startsWith('re:');
    const rule = createEpisodeFilterRule(
      isRegex ? raw.slice(3) : raw,
      isRegex ? 'regex' : 'normal'
    );
    if (!rule) return;

    setFilterConfig((prev) => ({ ...prev, rules: [...prev.rules, rule] }));
    setFilterKeywordInput('');
  }, [filterKeywordInput]);

  // 根据 descending 状态计算实际显示的分页索引
  const displayPage = useMemo(() => {
    if (descending) {
      return pageCount - 1 - currentPage;
    }
    return currentPage;
  }, [currentPage, descending, pageCount]);

  // 过滤后总页数可能变少，当前页要收敛回有效范围，否则会停在空页上
  useEffect(() => {
    setCurrentPage((prev) => Math.min(prev, pageCount - 1));
  }, [pageCount]);

  // 获取视频信息的函数 - 移除 attemptedSources 依赖避免不必要的重新创建
  const getVideoInfo = useCallback(async (source: SearchResult) => {
    const sourceKey = `${source.source}-${source.id}`;

    // 使用 ref 获取最新的状态，避免闭包问题
    if (attemptedSourcesRef.current.has(sourceKey)) {
      return;
    }

    // 获取第一集的URL
    if (!source.episodes || source.episodes.length === 0) {
      return;
    }
    const episodeUrl =
      source.episodes.length > 1 ? source.episodes[1] : source.episodes[0];

    // 标记为已尝试
    setAttemptedSources((prev) => new Set(prev).add(sourceKey));

    try {
      const info = await getVideoResolutionFromM3u8(episodeUrl);
      setVideoInfoMap((prev) => new Map(prev).set(sourceKey, info));
    } catch (error) {
      // 失败时保存错误状态
      setVideoInfoMap((prev) =>
        new Map(prev).set(sourceKey, {
          quality: '错误',
          loadSpeed: '未知',
          pingTime: 0,
          hasError: true,
        })
      );
    }
  }, []);

  // 当有预计算结果时，先合并到videoInfoMap中
  useEffect(() => {
    if (precomputedVideoInfo && precomputedVideoInfo.size > 0) {
      // 原子性地更新两个状态，避免时序问题
      setVideoInfoMap((prev) => {
        const newMap = new Map(prev);
        precomputedVideoInfo.forEach((value, key) => {
          newMap.set(key, value);
        });
        return newMap;
      });

      setAttemptedSources((prev) => {
        const newSet = new Set(prev);
        precomputedVideoInfo.forEach((info, key) => {
          if (!info.hasError) {
            newSet.add(key);
          }
        });
        return newSet;
      });

      // 同步更新 ref，确保 getVideoInfo 能立即看到更新
      precomputedVideoInfo.forEach((info, key) => {
        if (!info.hasError) {
          attemptedSourcesRef.current.add(key);
        }
      });
    }
  }, [precomputedVideoInfo]);

  // 读取本地“优选和测速”开关，默认开启
  const [optimizationEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('enableOptimization');
      if (saved !== null) {
        try {
          return JSON.parse(saved);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  });

  // 当切换到换源tab并且有源数据时，异步获取视频信息 - 移除 attemptedSources 依赖避免循环触发
  useEffect(() => {
    const fetchVideoInfosInBatches = async () => {
      if (
        !optimizationEnabled || // 若关闭测速则直接退出
        activeTab !== 'sources' ||
        availableSources.length === 0
      )
        return;

      // 筛选出尚未测速的播放源
      const pendingSources = availableSources.filter((source) => {
        const sourceKey = `${source.source}-${source.id}`;
        return !attemptedSourcesRef.current.has(sourceKey);
      });

      if (pendingSources.length === 0) return;

      const batchSize = Math.ceil(pendingSources.length / 2);

      for (let start = 0; start < pendingSources.length; start += batchSize) {
        const batch = pendingSources.slice(start, start + batchSize);
        await Promise.all(batch.map(getVideoInfo));
      }
    };

    fetchVideoInfosInBatches();
    // 依赖项保持与之前一致
  }, [activeTab, availableSources, getVideoInfo, optimizationEnabled]);

  // 升序分页标签。
  // 标签显示的是「过滤后第 N 集到第 M 集」在原始列表里的**真实集号**，
  // 而不是 1-50 / 51-100 这种理想区间 —— 过滤掉中间的集数后，
  // 直接用算式算出来的区间会和网格里实际显示的集号对不上。
  const categoriesAsc = useMemo(
    () => buildEpisodePageRanges(visibleEpisodeNumbers, episodesPerPage),
    [visibleEpisodeNumbers, episodesPerPage]
  );

  // 根据 descending 状态决定分页标签的排序和内容
  const categories = useMemo(() => {
    if (descending) {
      // 倒序时，label 也倒序显示
      return [...categoriesAsc]
        .reverse()
        .map(({ start, end }) => `${end}-${start}`);
    }
    return categoriesAsc.map(({ start, end }) => `${start}-${end}`);
  }, [categoriesAsc, descending]);

  const categoryContainerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 当分页切换时，将激活的分页标签滚动到视口中间
  useEffect(() => {
    const btn = buttonRefs.current[displayPage];
    const container = categoryContainerRef.current;
    if (btn && container) {
      // 手动计算滚动位置，只滚动分页标签容器
      const containerRect = container.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const scrollLeft = container.scrollLeft;

      // 计算按钮相对于容器的位置
      const btnLeft = btnRect.left - containerRect.left + scrollLeft;
      const btnWidth = btnRect.width;
      const containerWidth = containerRect.width;

      // 计算目标滚动位置，使按钮居中
      const targetScrollLeft = btnLeft - (containerWidth - btnWidth) / 2;

      // 平滑滚动到目标位置
      container.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth',
      });
    }
  }, [displayPage, pageCount]);

  // 处理换源tab点击，只在点击时才搜索
  const handleSourceTabClick = () => {
    setActiveTab('sources');
  };

  const handleCategoryClick = useCallback(
    (index: number) => {
      if (descending) {
        // 在倒序时，需要将显示索引转换为实际索引
        setCurrentPage(pageCount - 1 - index);
      } else {
        setCurrentPage(index);
      }
    },
    [descending, pageCount]
  );

  const handleEpisodeClick = useCallback(
    (episodeNumber: number) => {
      onChange?.(episodeNumber);
    },
    [onChange]
  );

  const handleSourceClick = useCallback(
    (source: SearchResult) => {
      if (!source || !source.source || !source.id) return;
      // 确保传递完整的参数
      onSourceChange?.(
        source.source,
        source.id,
        source.title || source.source_name || ''
      );
    },
    [onSourceChange]
  );

  // 当前页实际要渲染的集号（升序）。descending 时在渲染处翻转，不在这里反向。
  const currentPageEpisodes = useMemo(
    () => sliceEpisodePage(visibleEpisodeNumbers, currentPage, episodesPerPage),
    [visibleEpisodeNumbers, currentPage, episodesPerPage]
  );

  return (
    <div className='px-4 py-0 h-full bg-black/10 dark:bg-white/5 flex flex-col border-t border-b md:border-r border-white/0 dark:border-white/30 overflow-hidden'>
      {/* 主要的 Tab 切换 - 无缝融入设计 */}
      <div className='flex mb-1 -mx-6 flex-shrink-0'>
        {totalEpisodes > 1 && (
          <div
            onClick={() => setActiveTab('episodes')}
            className={`flex-1 py-3 px-6 text-center cursor-pointer transition-all duration-200 font-medium
              ${
                activeTab === 'episodes'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-gray-700 hover:text-green-600 bg-black/5 dark:bg-white/5 dark:text-gray-300 dark:hover:text-green-400 hover:bg-black/3 dark:hover:bg-white/3'
              }
            `.trim()}
          >
            选集
          </div>
        )}
        <div
          onClick={handleSourceTabClick}
          className={`flex-1 py-3 px-6 text-center cursor-pointer transition-all duration-200 font-medium flex items-center justify-center
            ${
              activeTab === 'sources'
                ? 'text-green-600 dark:text-green-400'
                : 'text-gray-700 hover:text-green-600 bg-black/5 dark:bg-white/5 dark:text-gray-300 dark:hover:text-green-400 hover:bg-black/3 dark:hover:bg-white/3'
            }
          `.trim()}
        >
          <span>换源</span>
          {preferBestSource && availableSources && availableSources.length > 0 && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                if (isOptimizing) return; // 防止重复点击
                if (!availableSources || availableSources.length === 0) return;
                // 重置取消标志
                cancelOptimizationRef.current = false;
                setIsOptimizing(true);
                preferBestSource(availableSources, () => cancelOptimizationRef.current)
                  .then((bestSource) => {
                    // 如果已取消，则忽略结果
                    if (cancelOptimizationRef.current) return;
                    // 确保bestSource有效
                    if (bestSource && (bestSource.source !== currentSource || bestSource.id !== currentId)) {
                      // 切换到最佳播放源
                      handleSourceClick(bestSource);
                    }
                  })
                  .catch((_err: Error) => {
                    // 静默处理错误，因为已经有UI提示
                  })
                  .finally(() => {
                    if (!cancelOptimizationRef.current) {
                      setIsOptimizing(false);
                      if (setLoading) setLoading(false);
                    }
                    // 重置取消标志
                    cancelOptimizationRef.current = false;
                  });
              }}
              className={`ml-2 bg-blue-500 text-white text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center shadow-md transition-all duration-300 ease-out ${
                isOptimizing
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-blue-600 hover:scale-110 cursor-pointer'
              }`}
              title={isOptimizing ? '优选进行中...' : '优选播放源'}
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* 选集 Tab 内容 */}
      {activeTab === 'episodes' && (
        <>
          {/* 分类标签 */}
          <div className='flex items-center gap-4 mb-4 border-b border-gray-300 dark:border-gray-700 -mx-6 px-6 flex-shrink-0'>
            <div className='flex-1 overflow-x-auto scrollbar-hide' ref={categoryContainerRef}>
              <div className='flex gap-2 min-w-max'>
                {categories.map((label, idx) => {
                  const isActive = idx === displayPage;
                  return (
                    <button
                      key={label}
                      ref={(el) => {
                        buttonRefs.current[idx] = el;
                      }}
                      onClick={() => handleCategoryClick(idx)}
                      className={`w-20 relative py-2 text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0 text-center 
                        ${
                          isActive
                            ? 'text-green-500 dark:text-green-400'
                            : 'text-gray-700 hover:text-green-600 dark:text-gray-300 dark:hover:text-green-400'
                        }
                      `.trim()}
                    >
                      {label}
                      {isActive && (
                        <div className='absolute bottom-0 left-0 right-0 h-0.5 bg-green-500 dark:bg-green-400' />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 向上/向下按钮 */}
            <button
              className='flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-gray-700 hover:text-green-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-white/20 transition-colors transform translate-y-[-4px]'
              onClick={() => {
                // 切换集数排序（正序/倒序）
                setDescending((prev) => !prev);
              }}
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4'
                />
              </svg>
            </button>
            {/* 剧集过滤按钮：有生效规则时高亮，并显示条数 */}
            <button
              className={`flex-shrink-0 h-8 rounded-md flex items-center justify-center gap-1 px-1.5 text-xs transition-colors transform translate-y-[-4px] ${
                activeFilterCount > 0
                  ? 'text-green-600 hover:bg-gray-100 dark:text-green-400 dark:hover:bg-white/20'
                  : 'text-gray-700 hover:text-green-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-white/20'
              }`}
              onClick={() => setShowFilterPanel((prev) => !prev)}
              title='按标题过滤剧集'
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M3 5h18M6 12h12M10 19h4'
                />
              </svg>
              {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
            </button>
          </div>

          {/* 过滤设置面板 */}
          {showFilterPanel && (
            <div className='mb-3 -mx-6 px-6 py-3 bg-black/5 dark:bg-white/5 flex flex-col gap-3 flex-shrink-0'>
              <div className='flex items-center justify-between'>
                <span className='text-xs font-medium text-gray-700 dark:text-gray-300'>
                  按标题过滤剧集
                </span>
                {/* 相反模式：隐藏命中的 → 只看命中的 */}
                <button
                  onClick={() =>
                    setFilterConfig((prev) => ({
                      ...prev,
                      reverseMode: !prev.reverseMode,
                    }))
                  }
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    filterConfig.reverseMode
                      ? 'border-green-500 text-green-600 dark:text-green-400'
                      : 'border-gray-400 text-gray-600 dark:border-gray-600 dark:text-gray-400'
                  }`}
                  title={
                    filterConfig.reverseMode
                      ? '当前：只显示命中规则的剧集'
                      : '当前：隐藏命中规则的剧集'
                  }
                >
                  {filterConfig.reverseMode ? '相反模式 开' : '相反模式 关'}
                </button>
              </div>

              {/* 新增屏蔽词。以 re: 前缀切正则 */}
              <div className='flex items-center gap-2'>
                <input
                  value={filterKeywordInput}
                  onChange={(e) => setFilterKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddFilterRule();
                  }}
                  placeholder='屏蔽词，如 预告；加 re: 前缀用正则'
                  className='flex-1 min-w-0 h-7 px-2 text-xs rounded border border-gray-300 bg-white text-gray-800 placeholder-gray-400 focus:border-green-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:placeholder-gray-500'
                />
                <button
                  onClick={handleAddFilterRule}
                  disabled={!filterKeywordInput.trim()}
                  className='flex-shrink-0 h-7 px-2 text-xs rounded border border-gray-300 text-gray-700 hover:border-green-500 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                >
                  添加
                </button>
              </div>

              {/* 规则列表 */}
              {filterConfig.rules.length > 0 ? (
                <div className='flex flex-col gap-1.5 max-h-40 overflow-y-auto scrollbar-hide'>
                  {filterConfig.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className='flex items-center gap-2 text-xs'
                    >
                      <button
                        onClick={() =>
                          setFilterConfig((prev) => ({
                            ...prev,
                            rules: prev.rules.map((r) =>
                              r.id === rule.id ? { ...r, enabled: !r.enabled } : r
                            ),
                          }))
                        }
                        className={`flex-1 min-w-0 text-left truncate px-2 py-1 rounded transition-colors ${
                          rule.enabled
                            ? 'text-gray-800 bg-white/60 dark:text-gray-200 dark:bg-white/10'
                            : 'text-gray-400 line-through dark:text-gray-500'
                        }`}
                        title={rule.enabled ? '点击停用' : '点击启用'}
                      >
                        {rule.type === 'regex' ? `re: ${rule.keyword}` : rule.keyword}
                      </button>
                      <button
                        onClick={() =>
                          setFilterConfig((prev) => ({
                            ...prev,
                            rules: prev.rules.filter((r) => r.id !== rule.id),
                          }))
                        }
                        className='flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400'
                        title='删除该规则'
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className='text-xs text-gray-500 dark:text-gray-400'>
                  暂无规则。添加后会立即从下面的集数列表里隐藏。
                </p>
              )}

              {hiddenEpisodeNumbers.size > 0 && (
                <p className='text-xs text-gray-500 dark:text-gray-400'>
                  已隐藏 {hiddenEpisodeNumbers.size} 集
                </p>
              )}

              {filterConfig.rules.length > 0 && (
                <button
                  onClick={() => {
                    clearEpisodeFilterConfig();
                    setFilterConfig({ rules: [], reverseMode: false });
                  }}
                  className='self-start text-xs text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400 transition-colors'
                >
                  清空全部规则
                </button>
              )}
            </div>
          )}

          {/* 集数网格 */}
          <div className='overflow-y-auto flex-1 pb-4 scrollbar-hide'>
            {currentPageEpisodes.length === 0 ? (
              <div className='flex items-center justify-center py-8'>
                <p className='text-sm text-gray-600 dark:text-gray-300'>
                  全部剧集都被过滤规则隐藏了
                </p>
              </div>
            ) : (
            <div className='grid grid-cols-3 sm:grid-cols-4 gap-3'>
              {(descending
                ? [...currentPageEpisodes].reverse()
                : currentPageEpisodes
              ).map((episodeNumber) => {
                const isActive = episodeNumber === value;
                return (
                  <button
                    key={episodeNumber}
                    onClick={() => handleEpisodeClick(episodeNumber - 1)}
                    className={`h-9 px-1 py-1 flex items-center justify-center text-xs font-medium rounded transition-all duration-200 whitespace-nowrap font-mono
                      ${
                        isActive
                          ? 'bg-green-500 text-white shadow-lg shadow-green-500/25 dark:bg-green-600'
                          : 'bg-gray-200 text-gray-700 hover:bg-gray-300 hover:scale-105 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/20'
                      }`.trim()}
                  >
                    {(() => {
                      const title = episodes_titles?.[episodeNumber - 1];
                      if (!title) {
                        return episodeNumber;
                      }
                      // 如果匹配"第X集"格式，提取中间的数字
                      const match = title.match(/第(\d+)集/);
                      if (match) {
                        return match[1];
                      }
                      return title;
                    })()}
                  </button>
                );
              })}
            </div>
            )}
          </div>
        </>
      )}

      {/* 换源 Tab 内容 */}
      {activeTab === 'sources' && (
        <div className='flex flex-col h-full mt-4'>
          {sourceSearchLoading && (
            <div className='flex items-center justify-center py-8'>
              <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-green-500'></div>
              <span className='ml-2 text-sm text-gray-600 dark:text-gray-300'>
                搜索中...
              </span>
            </div>
          )}

          {isOptimizing && (
            <div className='flex items-center justify-center py-3'>
              <div className='flex items-center'>
                <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500'></div>
                <span className='ml-2 text-sm text-gray-600 dark:text-gray-300'>
                  优选播放源中...
                </span>
              </div>
              <button
                onClick={() => {
                  cancelOptimizationRef.current = true;
                  setIsOptimizing(false);
                  if (setLoading) setLoading(false);
                }}
                className='ml-4 text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 px-2 py-1 rounded border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors'
              >
                取消
              </button>
            </div>
          )}

          {sourceSearchError && (
            <div className='flex items-center justify-center py-8'>
              <div className='text-center'>
                <div className='text-red-500 text-2xl mb-2'>⚠️</div>
                <p className='text-sm text-red-600 dark:text-red-400'>
                  {sourceSearchError}
                </p>
              </div>
            </div>
          )}

          {!sourceSearchLoading &&
            !sourceSearchError &&
            availableSources.length === 0 && (
              <div className='flex items-center justify-center py-8'>
                <div className='text-center'>
                  <div className='text-gray-400 text-2xl mb-2'>📺</div>
                  <p className='text-sm text-gray-600 dark:text-gray-300'>
                    暂无可用的换源
                  </p>
                </div>
              </div>
            )}

          {!sourceSearchLoading &&
            !sourceSearchError &&
            availableSources.length > 0 && (
              <div className='flex-1 overflow-y-auto space-y-2 pb-20 scrollbar-hide'>
                {availableSources
                  .sort((a, b) => {
                    const aIsCurrent =
                      a.source?.toString() === currentSource?.toString() &&
                      a.id?.toString() === currentId?.toString();
                    const bIsCurrent =
                      b.source?.toString() === currentSource?.toString() &&
                      b.id?.toString() === currentId?.toString();
                    if (aIsCurrent && !bIsCurrent) return -1;
                    if (!aIsCurrent && bIsCurrent) return 1;
                    return 0;
                  })
                  .map((source, index) => {
                    const isCurrentSource =
                      source.source?.toString() === currentSource?.toString() &&
                      source.id?.toString() === currentId?.toString();
                    return (
                      <div
                        key={`${source.source}-${source.id}`}
                        onClick={() =>
                          !isCurrentSource && handleSourceClick(source)
                        }
                        className={`flex items-start gap-3 px-2 py-3 rounded-lg transition-all select-none duration-200 relative
                      ${
                        isCurrentSource
                          ? 'bg-green-500/10 dark:bg-green-500/20 border-green-500/30 border'
                          : 'hover:bg-gray-200/50 dark:hover:bg-white/10 hover:scale-[1.02] cursor-pointer'
                      }`.trim()}
                      >
                        {/* 封面 */}
                        <div className='flex-shrink-0 w-12 h-20 bg-gray-300 dark:bg-gray-600 rounded overflow-hidden'>
                          {source.episodes && source.episodes.length > 0 && (
                            <img
                              src={processImageUrl(source.poster)}
                              alt={source.title}
                              className='w-full h-full object-cover'
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.style.display = 'none';
                              }}
                            />
                          )}
                        </div>

                        {/* 信息区域 */}
                        <div className='flex-1 min-w-0 flex flex-col justify-between h-20'>
                          {/* 标题和分辨率 - 顶部 */}
                          <div className='flex items-start justify-between gap-3 h-6'>
                            <div className='flex-1 min-w-0 relative group/title'>
                              <h3 className='font-medium text-base truncate text-gray-900 dark:text-gray-100 leading-none'>
                                {source.title}
                              </h3>
                              {/* 标题级别的 tooltip - 第一个元素不显示 */}
                              {index !== 0 && (
                                <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1 bg-gray-800 text-white text-xs rounded-md shadow-lg opacity-0 invisible group-hover/title:opacity-100 group-hover/title:visible transition-all duration-200 ease-out delay-100 whitespace-nowrap z-[500] pointer-events-none'>
                                  {source.title}
                                  <div className='absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-800'></div>
                                </div>
                              )}
                            </div>
                            {(() => {
                              const sourceKey = `${source.source}-${source.id}`;
                              const videoInfo = videoInfoMap.get(sourceKey);

                              if (videoInfo && videoInfo.quality !== '未知') {
                                if (videoInfo.hasError) {
                                  return (
                                    <div className='bg-gray-500/10 dark:bg-gray-400/20 text-red-600 dark:text-red-400 px-1.5 py-0 rounded text-xs flex-shrink-0 min-w-[50px] text-center'>
                                      检测失败
                                    </div>
                                  );
                                } else {
                                  // 根据分辨率设置不同颜色：2K、4K为紫色，1080p、720p为绿色，其他为黄色
                                  const isUltraHigh = ['4K', '2K'].includes(
                                    videoInfo.quality
                                  );
                                  const isHigh = ['1080p', '720p'].includes(
                                    videoInfo.quality
                                  );
                                  const textColorClasses = isUltraHigh
                                    ? 'text-purple-600 dark:text-purple-400'
                                    : isHigh
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-yellow-600 dark:text-yellow-400';

                                  return (
                                    <div
                                      className={`bg-gray-500/10 dark:bg-gray-400/20 ${textColorClasses} px-1.5 py-0 rounded text-xs flex-shrink-0 min-w-[50px] text-center`}
                                    >
                                      {videoInfo.quality}
                                    </div>
                                  );
                                }
                              }

                              return null;
                            })()}
                          </div>

                          {/* 源名称和集数信息 - 垂直居中 */}
                          <div className='flex items-center justify-between'>
                            <span className='text-xs px-2 py-1 border border-gray-500/60 rounded text-gray-700 dark:text-gray-300'>
                              {source.source_name}
                            </span>
                            {source.episodes.length > 1 && (
                              <span className='text-xs text-gray-500 dark:text-gray-400 font-medium'>
                                {source.episodes.length} 集
                              </span>
                            )}
                          </div>

                          {/* 网络信息 - 底部 */}
                          <div className='flex items-end h-6'>
                            {(() => {
                              const sourceKey = `${source.source}-${source.id}`;
                              const videoInfo = videoInfoMap.get(sourceKey);
                              if (videoInfo) {
                                if (!videoInfo.hasError) {
                                  return (
                                    <div className='flex items-end gap-3 text-xs'>
                                      <div className='text-green-600 dark:text-green-400 font-medium text-xs'>
                                        {videoInfo.loadSpeed}
                                      </div>
                                      <div className='text-orange-600 dark:text-orange-400 font-medium text-xs'>
                                        {videoInfo.pingTime}ms
                                      </div>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <div className='text-red-500/90 dark:text-red-400 font-medium text-xs'>
                                      无测速数据
                                    </div>
                                  ); // 占位div
                                }
                              }
                            })()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                <div className='flex-shrink-0 mt-auto pt-2 border-t border-gray-400 dark:border-gray-700'>
                  <button
                    onClick={() => {
                      if (videoTitle) {
                        router.push(
                          `/search?q=${encodeURIComponent(videoTitle)}`
                        );
                      }
                    }}
                    className='w-full text-center text-xs text-gray-500 dark:text-gray-400 hover:text-green-500 dark:hover:text-green-400 transition-colors py-2'
                  >
                    影片匹配有误？点击去搜索
                  </button>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

export default EpisodeSelector;
