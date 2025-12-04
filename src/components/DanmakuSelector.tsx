/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AnimeOption, extractEpisodeNumber, searchEpisodes } from '@/lib/danmaku.client';

interface DanmakuSelectorProps {
  videoTitle: string;
  currentEpisode?: number; // 当前集数（从1开始）
  currentEpisodeTitle?: string; // 当前集数标题
  onSelect: (anime: AnimeOption, episodeNumber?: number, episodeTitle?: string) => void;
  onClose: () => void;
  isVisible?: boolean; // 弹幕选择器是否可见（用于控制自动搜索时机）
}

/**
 * 弹幕选择器组件
 * 显示搜索结果，让用户选择匹配的动漫
 */
export default function DanmakuSelector({
  videoTitle,
  currentEpisode,
  currentEpisodeTitle,
  onSelect,
  onClose,
  isVisible = false,
}: DanmakuSelectorProps) {
  const [animeOptions, setAnimeOptions] = useState<AnimeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAnime, setSelectedAnime] = useState<AnimeOption | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(
    currentEpisode || null
  );
  const [searchKeyword, setSearchKeyword] = useState<string>(''); // 手动搜索关键词
  const [hasManualSearched, setHasManualSearched] = useState(false); // 是否已经手动搜索过
  const [hasSearched, setHasSearched] = useState(false); // 是否已经执行过任何搜索
  const lastAutoSearchTitleRef = useRef<string>(''); // 记录上次自动搜索的标题

  // 执行搜索的函数
  const performSearch = async (keyword: string, isManual = false) => {
    if (!keyword.trim()) return;

    try {
      setLoading(true);
      setError(null);
      const options = await searchEpisodes(keyword.trim());
      setAnimeOptions(options);
      setHasSearched(true);
      if (isManual) {
        setHasManualSearched(true);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('搜索弹幕选项失败:', err);
      setError(err instanceof Error ? err.message : '搜索失败');
      setHasSearched(true); // 即使失败也标记为已搜索
    } finally {
      setLoading(false);
    }
  };

  // 当 videoTitle 变化时，重置状态（无论可见性如何）
  useEffect(() => {
    if (videoTitle && videoTitle !== lastAutoSearchTitleRef.current) {
      lastAutoSearchTitleRef.current = videoTitle;
      setHasManualSearched(false);
      setHasSearched(false); // 重置搜索状态
      setSearchKeyword(''); // 清空搜索框
    }
  }, [videoTitle]);

  // 当弹幕选择器变为可见时，执行自动搜索（如果尚未手动搜索）
  useEffect(() => {
    if (!isVisible) return;
    if (!videoTitle) return;
    if (hasManualSearched) return;

    performSearch(videoTitle, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, videoTitle, hasManualSearched]);

  // 处理手动搜索
  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (searchKeyword.trim()) {
      performSearch(searchKeyword, true);
    }
  };

  const handleAnimeSelect = (anime: AnimeOption) => {
    setSelectedAnime(anime);
    // 如果当前集数存在，尝试匹配到该动漫的集数
    if (currentEpisode && currentEpisodeTitle) {
      // 从当前集数标题中提取集数
      const extractedNumber = extractEpisodeNumber(currentEpisodeTitle);
      
      // 尝试找到匹配的集数
      let matchedEpisode = anime.episodes.find((ep) => {
        // 1. 完全匹配标题
        if (ep.episodeTitle === currentEpisodeTitle) {
          return true;
        }
        return false;
      });
      
      // 2. 如果完全匹配失败，但提取到了集数，使用集数匹配
      if (!matchedEpisode && extractedNumber !== null) {
        matchedEpisode = anime.episodes.find((ep) => {
          const epNumber = extractEpisodeNumber(ep.episodeTitle);
          return epNumber === extractedNumber;
        });
      }
      
      if (matchedEpisode) {
        // 找到匹配的集数索引
        const episodeIndex = anime.episodes.indexOf(matchedEpisode);
        setSelectedEpisode(episodeIndex + 1);
      } else {
        // 如果找不到匹配，使用当前集数（如果在该动漫的范围内）
        if (currentEpisode <= anime.episodes.length) {
          setSelectedEpisode(currentEpisode);
        } else {
          setSelectedEpisode(1);
        }
      }
    } else {
      // 如果没有当前集数，默认选择第一集
      setSelectedEpisode(1);
    }
  };

  const handleEpisodeSelect = (episodeNumber: number) => {
    setSelectedEpisode(episodeNumber);
  };

  const handleConfirm = () => {
    if (selectedAnime && selectedEpisode) {
      // 获取选中集数的标题
      const episode = selectedAnime.episodes[selectedEpisode - 1];
      const episodeTitle = episode?.episodeTitle || '';
      onSelect(selectedAnime, selectedEpisode, episodeTitle);
      onClose();
    }
  };

  const handleBack = () => {
    setSelectedAnime(null);
    setSelectedEpisode(null);
    // 返回时不清空搜索结果，但可以重新搜索
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl max-h-[80vh] mx-4 bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            {selectedAnime && (
              <button
                onClick={handleBack}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                aria-label="返回"
              >
                <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {selectedAnime ? '选择集数' : '选择弹幕源'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-4 overflow-y-auto max-h-[calc(80vh-80px)]">
          {/* 搜索框 - 只在未选择动漫时显示 */}
          {!selectedAnime && (
            <form onSubmit={handleSearch} className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <input
                  type="text"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  placeholder={videoTitle ? `自动搜索: ${videoTitle} (可输入其他关键词)` : '输入关键词搜索弹幕源...'}
                  className="w-full h-12 pl-10 pr-20 rounded-lg bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
                <button
                  type="submit"
                  disabled={loading || !searchKeyword.trim()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                >
                  搜索
                </button>
              </div>
            </form>
          )}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
              <span className="ml-3 text-gray-600 dark:text-gray-400">搜索中...</span>
            </div>
          )}

          {error && (
            <div className="py-8 text-center">
              <p className="text-red-500 dark:text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && animeOptions.length === 0 && hasSearched && (
            <div className="py-8 text-center">
              <p className="text-gray-500 dark:text-gray-400">未找到匹配的弹幕源</p>
            </div>
          )}

          {!loading && !error && !selectedAnime && animeOptions.length > 0 && (
            <div className="space-y-2">
              {animeOptions.map((anime) => (
                <button
                  key={anime.animeId}
                  onClick={() => handleAnimeSelect(anime)}
                  className="w-full text-left p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-green-500 dark:hover:border-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                        {anime.animeTitle}
                      </h4>
                      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">
                          {anime.typeDescription}
                        </span>
                        <span>
                          共{anime.episodeCount}集
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {selectedAnime && (
            <div className="space-y-4">
              <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                  {selectedAnime.animeTitle}
                </h4>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  共 {selectedAnime.episodes.length} 集
                </p>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-[400px] overflow-y-auto">
                {selectedAnime.episodes.map((episode, index) => {
                  const episodeNumber = index + 1;
                  const isSelected = selectedEpisode === episodeNumber;
                  return (
                    <button
                      key={episode.episodeId}
                      onClick={() => handleEpisodeSelect(episodeNumber)}
                      className={`p-3 text-sm font-medium rounded-lg transition-all ${
                        isSelected
                          ? 'bg-green-500 text-white shadow-lg'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {episode.episodeTitle || `第${episodeNumber}集`}
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={handleBack}
                  className="flex-1 px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  返回
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!selectedEpisode}
                  className="flex-1 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                >
                  确认
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

