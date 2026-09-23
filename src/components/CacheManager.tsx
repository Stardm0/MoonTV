'use client';

import { Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  type EpisodeCacheStat,
  clearVideoCache,
  deleteEpisodeCache,
  getCacheSummary,
  getEpisodeCacheStats,
} from '@/lib/video-cache';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

interface CacheManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 视频缓存管理面板：展示每个已缓存剧集的占用，支持按剧集删除或一键清空。
 */
export default function CacheManager({ isOpen, onClose }: CacheManagerProps) {
  const [episodes, setEpisodes] = useState<EpisodeCacheStat[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [stats, summary] = await Promise.all([
        getEpisodeCacheStats(),
        getCacheSummary(),
      ]);
      setEpisodes(stats);
      setTotalBytes(summary.bytes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleDeleteEpisode = async (episodeKey: string) => {
    await deleteEpisodeCache(episodeKey);
    void refresh();
  };

  const handleClearAll = async () => {
    await clearVideoCache();
    void refresh();
  };

  return (
    <div className='fixed inset-0 z-[3000] flex items-center justify-center bg-black/50 p-4'>
      <div className='w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-gray-800 shadow-xl'>
        {/* 头部 */}
        <div className='flex items-center justify-between border-b border-gray-200/60 dark:border-gray-700/60 px-5 py-4'>
          <div>
            <h2 className='text-base font-medium text-gray-900 dark:text-gray-100'>
              视频缓存管理
            </h2>
            <p className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
              共占用 {formatBytes(totalBytes)}
            </p>
          </div>
          <button
            onClick={onClose}
            className='rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
            aria-label='关闭'
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        {/* 列表 */}
        <div className='flex-1 overflow-y-auto px-5 py-4'>
          {loading ? (
            <div className='py-10 text-center text-sm text-gray-400'>加载中...</div>
          ) : episodes.length === 0 ? (
            <div className='py-10 text-center text-sm text-gray-400'>
              暂无缓存内容
            </div>
          ) : (
            <ul className='space-y-2'>
              {episodes.map((ep) => (
                <li
                  key={ep.episodeKey}
                  className='flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2'
                >
                  <div className='min-w-0'>
                    <div className='truncate text-sm text-gray-800 dark:text-gray-200'>
                      {ep.episodeKey}
                    </div>
                    <div className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
                      {ep.segments} 片段 · {formatBytes(ep.bytes)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteEpisode(ep.episodeKey)}
                    className='ml-3 shrink-0 rounded-full p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30'
                    aria-label='删除该剧集缓存'
                    title='删除该剧集缓存'
                  >
                    <Trash2 className='h-4 w-4' />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 底部 */}
        <div className='border-t border-gray-200/60 dark:border-gray-700/60 px-5 py-3'>
          <button
            onClick={handleClearAll}
            disabled={episodes.length === 0}
            className='w-full rounded-lg bg-red-500 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40'
          >
            清空全部缓存
          </button>
        </div>
      </div>
    </div>
  );
}
