/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { Download, Heart } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

import { SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';

import { FollowingIconButton } from '@/components/FollowingIcon';

import {
  buildBackdropStyle,
  HERO_BACKDROP_CLASS,
  HERO_BACKDROP_OVERLAY_CLASS,
  HERO_DESC_CLAMP_CLASS,
  HERO_POSTER_CLASS,
  HERO_SECTION_CLASS,
  shouldClampDescription,
  shouldShowBackdrop,
} from '../lib/heroLayout';

interface VideoDetailPanelProps {
  videoTitle: string;
  videoYear: string;
  totalEpisodes: number;
  currentEpisodeIndex: number;
  detail: SearchResult | null;
  favorited: boolean;
  following: boolean;
  onToggleFavorite: () => void;
  onToggleFollowing: () => void;
  videoUrl: string;
  videoDoubanId: number;
  currentSource: string;
  currentId: string;
  onDownload: () => void;
  /** 当前封面（豆瓣海报）；换源后会更新。见 usePlayEngine 的 videoCover */
  videoCover?: string;
}

// ---------------------------------------------------------------------------
// 视口宽度
// ---------------------------------------------------------------------------

/**
 * 三个函数必须定义在**模块作用域**：`useSyncExternalStore` 用引用相等判断
 * 要不要重新订阅，写成内联箭头函数会导致每次渲染都重新订阅。
 *
 * server snapshot 固定返回 0 —— 见 `shouldShowBackdrop` 的说明：宁可桌面端
 * 等 hydration 后再补背景，也不要让手机先下一张用不上的大图。
 */
function subscribeViewport(onStoreChange: () => void) {
  window.addEventListener('resize', onStoreChange);
  return () => window.removeEventListener('resize', onStoreChange);
}

function getViewportWidth() {
  return window.innerWidth;
}

function getServerViewportWidth() {
  return 0;
}

/**
 * 播放页下方的影片 Hero 区：封面背景 + 前景海报 + 标题/操作/简介。
 *
 * 结构（决策 A1/B1/C/D1）：
 *
 * ```
 * section（relative + overflow-hidden，背景层的锚点）
 * ├─ 背景层  同一张竖版海报 放大+模糊+遮罩   ← ≥768px 才渲染，手机不下载
 * └─ 内容层  flex
 *            ├─ 前景海报  order-1 md:order-2   ← 手机在标题左侧，桌面到右侧（B1）
 *            └─ 文字      order-2 md:order-1
 * ```
 *
 * 两处刻意与旧实现不同：
 * - **操作按钮移出了 `<h1>`**。`<div>`/`<button>` 不是 phrasing content，
 *   塞进 `h1` 是非法 HTML，浏览器会自行纠正 DOM（可能造成意外嵌套）。
 * - **标题左对齐**，与下方信息行同一条基线；旧实现是 `text-center md:text-left`，
 *   手机上标题居中、信息行左对齐，视觉上对不齐。
 */
export function VideoDetailPanel(props: VideoDetailPanelProps) {
  const {
    videoTitle,
    videoYear,
    totalEpisodes,
    currentEpisodeIndex,
    detail,
    favorited,
    following,
    onToggleFavorite,
    onToggleFollowing,
    videoUrl,
    videoDoubanId,
    currentSource,
    currentId,
    onDownload,
    videoCover,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const viewportWidth = useSyncExternalStore(
    subscribeViewport,
    getViewportWidth,
    getServerViewportWidth
  );

  // 引擎的 videoCover 是权威值（换源后会被替换）；没有时退回详情里的封面。
  const rawPoster = (videoCover || detail?.poster || '').trim();
  const posterUrl = rawPoster ? processImageUrl(rawPoster) : '';

  const backdropStyle = buildBackdropStyle(rawPoster);
  const showBackdrop =
    shouldShowBackdrop(rawPoster, viewportWidth) &&
    Boolean(backdropStyle.backgroundImage);

  const episodeLabel =
    detail?.episodes_titles?.[currentEpisodeIndex] ||
    `第 ${currentEpisodeIndex + 1} 集`;

  const canExpand = shouldClampDescription(detail?.desc);
  const clamped = canExpand && !expanded;

  return (
    <section className={`${HERO_SECTION_CLASS} mt-4 mb-6`}>
      {/* 背景层：同一张竖版海报放大模糊，只取色彩氛围（清晰度由前景海报负责） */}
      {showBackdrop && (
        <div aria-hidden='true' className='absolute inset-0'>
          <div className={HERO_BACKDROP_CLASS} style={backdropStyle} />
          <div className={HERO_BACKDROP_OVERLAY_CLASS} />
        </div>
      )}

      {/* 内容层 */}
      <div className='relative z-10 flex flex-row items-start gap-4 p-4 md:gap-6 md:p-6'>
        {/* 前景海报：手机上小图在标题左侧，桌面端移到大图放右侧 */}
        {posterUrl && (
          <img
            src={posterUrl}
            alt=''
            loading='lazy'
            className={`${HERO_POSTER_CLASS} order-1 md:order-2`}
          />
        )}

        <div className='order-2 min-w-0 flex-1 md:order-1'>
          {/* 标题（只放 phrasing content —— 按钮已移出） */}
          <h1 className='text-xl font-bold tracking-wide break-words md:text-3xl'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='ml-2 align-middle text-base font-normal text-gray-500 dark:text-gray-400 md:text-xl'>
                {episodeLabel}
              </span>
            )}
          </h1>

          {/* 操作按钮 */}
          <div className='mt-3 flex flex-wrap items-center gap-2.5'>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-full shadow-md transition-all duration-300 ease-out hover:scale-[1.1] ${
                favorited
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
              }`}
              title={favorited ? '取消收藏' : '加入收藏'}
              aria-label={favorited ? '取消收藏' : '加入收藏'}
            >
              <Heart
                className={`h-4 w-4 ${
                  favorited
                    ? 'fill-white stroke-white'
                    : 'fill-transparent stroke-current stroke-[1.5]'
                }`}
              />
            </button>
            {videoUrl && (
              <button
                type='button'
                onClick={() => onDownload()}
                className='flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-white shadow-md transition-all duration-300 ease-out hover:scale-[1.1] hover:bg-blue-600'
                title='下载视频'
                aria-label='下载视频'
              >
                <Download className='h-4 w-4' />
              </button>
            )}
            {videoDoubanId !== 0 && (
              <a
                href={`https://movie.douban.com/subject/${videoDoubanId.toString()}`}
                target='_blank'
                rel='noopener noreferrer'
                className='flex h-8 w-8 items-center justify-center rounded-full bg-green-500 text-white shadow-md transition-all duration-300 ease-out hover:scale-[1.1] hover:bg-green-600'
                title='打开豆瓣页面'
                aria-label='打开豆瓣页面'
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
                  aria-hidden='true'
                >
                  <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
                  <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
                </svg>
              </a>
            )}
            {currentSource && currentId && (
              <FollowingIconButton
                following={following}
                size={16}
                padding={8}
                theme='detail'
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFollowing();
                }}
              />
            )}
          </div>

          {/* 关键信息行 */}
          <div className='mt-3 flex flex-wrap items-center gap-3 text-sm opacity-80 md:text-base'>
            {detail?.class && (
              <span className='font-semibold text-green-600'>{detail.class}</span>
            )}
            {(detail?.year || videoYear) && (
              <span>{detail?.year || videoYear}</span>
            )}
            {detail?.source_name && (
              <span className='rounded border border-gray-500/60 px-2 py-[1px]'>
                {detail.source_name}
              </span>
            )}
            {detail?.type_name && <span>{detail.type_name}</span>}
          </div>

          {/* 剧情简介：限高 + 展开（旧实现的 overflow-y-auto 因祖先链无确定高度而失效，
              长简介会直接把整页撑长；这里改为限行，超出给显式「展开」） */}
          {detail?.desc && (
            <div className='mt-3'>
              <p
                className={`whitespace-pre-line text-sm leading-relaxed opacity-90 md:text-base ${
                  clamped ? HERO_DESC_CLAMP_CLASS : ''
                }`}
              >
                {detail.desc}
              </p>
              {canExpand && (
                <button
                  type='button'
                  onClick={() => setExpanded((v) => !v)}
                  className='mt-1.5 text-sm text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300'
                >
                  {expanded ? '收起' : '展开'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
