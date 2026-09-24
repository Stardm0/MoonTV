'use client';

/* eslint-disable @next/next/no-img-element */

import { File, FileVideo, Folder, Play } from 'lucide-react';
import { useMemo, useState } from 'react';

import { formatFileSize } from '@/lib/file-size';
import type { LibraryView } from '@/lib/library-view';
import type { OpenListItem } from '@/lib/openlist';
import {
  getFileExtension,
  isVideoFile,
  stripFileExtension,
} from '@/lib/openlist';
import {
  buildPosterInitial,
  buildPosterPalette,
} from '@/lib/poster-fallback';

/**
 * 影库右侧的条目区：按「查看方式」在列表与三种图标尺寸之间切换。
 *
 * ## 交互（照文件管理器）
 *
 * - **单击** = 选中（只高亮，不做任何跳转，避免误触就跳走）
 * - **双击** = 打开：目录进入、视频播放
 * - 列表视图额外保留行内按钮（进入 / 按剧集播放 / 播放），
 *   因为「按剧集播放」在纯双击语义下没法表达。
 */
export interface LibraryItemsProps {
  view: LibraryView;
  items: OpenListItem[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** 条目缩略图地址（由父组件按当前目录内容推断，无图给空串） */
  thumbFor: (item: OpenListItem) => string;
  onOpenDir: (item: OpenListItem) => void;
  /** 目录整目录按剧集播放 */
  onPlayDir: (item: OpenListItem) => void;
  onPlayVideo: (item: OpenListItem) => void;
}

/** 图标视图的三档尺寸（卡片宽 / 封面高 / 图标大小） */
const GRID_SIZE: Record<
  Exclude<LibraryView, 'list'>,
  { card: string; cover: string; icon: string }
> = {
  small: { card: 'w-24', cover: 'h-16', icon: 'h-6 w-6' },
  medium: { card: 'w-36', cover: 'h-24', icon: 'h-8 w-8' },
  large: { card: 'w-48', cover: 'h-32', icon: 'h-12 w-12' },
};

/**
 * 列表行的小海报。
 *
 * 图片走 `/api/library-image` 代理而不是直连：站点级影库配置下浏览器根本拿不到
 * 影库地址与令牌。加载失败（影库没这图 / 不是图片）就退回文件图标，
 * 不让列表里出现破图。
 */
const ListThumb = ({
  src,
  item,
}: {
  src: string;
  item: OpenListItem;
}) => {
  const [failed, setFailed] = useState(false);

  if (item.is_dir) {
    return <Folder className='h-4 w-4 flex-shrink-0 text-amber-500' />;
  }

  if (!src || failed) {
    const Icon = isVideoFile(item.name) ? FileVideo : File;
    return (
      <Icon className='h-4 w-4 flex-shrink-0 text-gray-300 dark:text-gray-600' />
    );
  }

  return (
    <img
      src={src}
      alt=''
      loading='lazy'
      onError={() => setFailed(true)}
      className='h-10 w-7 flex-shrink-0 rounded object-cover'
    />
  );
};

/** 网格卡片封面：目录→文件夹图标，有图→图，没图→按标题生成的渐变块 */
const GridThumb = ({
  item,
  src,
  coverClass,
  iconClass,
}: {
  item: OpenListItem;
  src: string;
  coverClass: string;
  iconClass: string;
}) => {
  const [failed, setFailed] = useState(false);
  const title = stripFileExtension(item.name);
  const palette = useMemo(() => buildPosterPalette(title), [title]);

  if (item.is_dir) {
    return (
      <div
        className={`flex w-full items-center justify-center rounded-md bg-amber-500/10 ${coverClass}`}
      >
        <Folder className={`${iconClass} text-amber-500`} />
      </div>
    );
  }

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=''
        loading='lazy'
        onError={() => setFailed(true)}
        className={`w-full rounded-md object-cover ${coverClass}`}
      />
    );
  }

  return (
    <div
      className={`flex w-full items-center justify-center rounded-md ${coverClass}`}
      style={{
        backgroundImage: `linear-gradient(135deg, ${palette.from}, ${palette.to})`,
      }}
    >
      <span className='text-lg font-semibold text-white/90'>
        {buildPosterInitial(title)}
      </span>
    </div>
  );
};

const LibraryItems = ({
  view,
  items,
  selected,
  onSelect,
  thumbFor,
  onOpenDir,
  onPlayDir,
  onPlayVideo,
}: LibraryItemsProps) => {
  /** 双击的「打开」语义：目录进入，视频播放，其它不动 */
  const activate = (item: OpenListItem) => {
    if (item.is_dir) {
      onOpenDir(item);
      return;
    }
    if (isVideoFile(item.name)) onPlayVideo(item);
  };

  if (view === 'list') {
    return (
      <ul className='divide-y divide-gray-200/70 rounded-xl border border-gray-200/70 dark:divide-gray-700/60 dark:border-gray-700/60'>
        {items.map((item) => {
          const video = !item.is_dir && isVideoFile(item.name);
          const active = selected === item.name;
          return (
            <li
              key={item.name}
              onClick={() => onSelect(item.name)}
              onDoubleClick={() => activate(item)}
              className={`flex cursor-default items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                active ? 'bg-green-500/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
              }`}
            >
              <ListThumb src={thumbFor(item)} item={item} />
              <span className='min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200'>
                {item.name}
                {!item.is_dir && (
                  <span className='ml-2 text-xs text-gray-400'>
                    {formatFileSize(item.size)}
                    {getFileExtension(item.name)
                      ? ` · ${getFileExtension(item.name)}`
                      : ''}
                  </span>
                )}
              </span>
              {item.is_dir ? (
                <>
                  <button
                    type='button'
                    onClick={() => onOpenDir(item)}
                    className='rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                  >
                    进入
                  </button>
                  <button
                    type='button'
                    onClick={() => onPlayDir(item)}
                    className='flex items-center gap-1 rounded-lg bg-green-500/10 px-2 py-1 text-xs text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400'
                    title='把目录里的视频按集数顺序排成选集播放'
                  >
                    <Play className='h-3 w-3' />
                    按剧集播放
                  </button>
                </>
              ) : video ? (
                <button
                  type='button'
                  onClick={() => onPlayVideo(item)}
                  className='flex items-center gap-1 rounded-lg bg-green-500/10 px-2 py-1 text-xs text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400'
                >
                  <Play className='h-3 w-3' />
                  播放
                </button>
              ) : (
                <span className='text-xs text-gray-300 dark:text-gray-600'>
                  不支持
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const size = GRID_SIZE[view];
  return (
    <div className='flex flex-wrap gap-2'>
      {items.map((item) => {
        const active = selected === item.name;
        return (
          <div
            key={item.name}
            onClick={() => onSelect(item.name)}
            onDoubleClick={() => activate(item)}
            title={item.name}
            className={`${size.card} flex cursor-default flex-col rounded-lg p-1.5 text-center transition-colors ${
              active
                ? 'bg-green-500/10 ring-1 ring-green-400/60'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <GridThumb
              item={item}
              src={thumbFor(item)}
              coverClass={size.cover}
              iconClass={size.icon}
            />
            <p className='mt-1 truncate text-xs text-gray-700 dark:text-gray-200'>
              {item.is_dir ? item.name : stripFileExtension(item.name)}
            </p>
            {!item.is_dir && (
              <p className='text-[10px] text-gray-400'>
                {formatFileSize(item.size)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default LibraryItems;
