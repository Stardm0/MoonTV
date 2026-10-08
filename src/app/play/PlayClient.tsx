/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import AddDownloadModal from '@/components/AddDownloadModal';
import { BackButton } from '@/components/BackButton';
import CacheManager from '@/components/CacheManager';
import DanmakuSelector from '@/components/DanmakuSelector';
import EpisodeSelector from '@/components/EpisodeSelector';
import PageLayout from '@/components/PageLayout';

import { PlayerOverlayHeader } from './components/PlayerOverlayHeader';
import { ErrorView, LoadingView, VideoLoadingMask } from './components/PlayStatusView';
import { VideoDetailPanel } from './components/VideoDetailPanel';
import { usePlayEngine } from './usePlayEngine';

/** 避免点到浮层时把点击传到 ArtPlayer（会误触发播放/暂停） */
function stopPlayerPointer(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

/**
 * 播放页客户端组件。
 *
 * 仅负责：调用 {@link usePlayEngine} 获取状态/回调，并按视图分层渲染。
 * 加载、错误、视频遮罩、详情面板等均已拆分为独立展示组件。
 */
export default function PlayClient() {
  const router = useRouter();
  const [showAddDownload, setShowAddDownload] = useState(false);

  const {
    // 加载 / 错误
    loading,
    loadingStage,
    loadingMessage,
    error,
    // 视频与元数据
    detail,
    totalEpisodes,
    videoTitle,
    videoYear,
    videoDoubanId,
    currentSource,
    currentId,
    searchTitle,
    currentEpisodeIndex,
    videoUrl,
    skipConfig,
    // 播放器
    artRef,
    playerHost,
    isVideoLoading,
    videoLoadingStage,
    setLoading,
    setIsVideoLoading,
    setVideoLoadingStage,
    // 源 / 换源
    availableSources,
    sourceSearchLoading,
    sourceSearchError,
    precomputedVideoInfo,
    preferBestSource,
    handleSourceChange,
    handleEpisodeChange,
    // 弹幕
    showDanmakuSelector,
    isDanmakuLoading,
    handleDanmakuSelect,
    handleDanmakuClose,
    // 缓存管理
    showCacheManager,
    setShowCacheManager,
    // 收藏 / 追更
    favorited,
    following,
    handleToggleFavorite,
    handleToggleFollowing,
  } = usePlayEngine();

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        {/* 加载态也留一个返回入口：搜错片/等太久不想等时能直接退出去。
            用绝对定位覆盖，避免给整屏的加载视图额外撑出滚动条。 */}
        <div className='relative'>
          <div className='absolute left-3 top-3 z-10 lg:left-[5rem] lg:top-4 2xl:left-32'>
            <BackButton showLabel />
          </div>
          <LoadingView stage={loadingStage} message={loadingMessage} />
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <ErrorView
          message={error}
          videoTitle={videoTitle}
          onPrimary={() =>
            videoTitle
              ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
              : router.back()
          }
          onRetry={() => window.location.reload()}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col px-0'>
        {/* 播放器和选集：顶对齐导航栏，左右铺满 */}
        <div>
          <div className='grid lg:h-[500px] xl:h-[650px] 2xl:h-[750px] grid-cols-1 md:grid-cols-4 md:gap-0'>
            {/* 播放器 */}
            <div className='h-full md:col-span-3'>
              <div className='relative isolate w-full h-[300px] lg:h-full'>
                <div
                  ref={artRef}
                  className='bg-black w-full h-full overflow-hidden shadow-lg'
                ></div>
                {playerHost &&
                  createPortal(
                    <>
                      <PlayerOverlayHeader
                        title={
                          videoTitle
                            ? totalEpisodes > 1
                              ? `${videoTitle} · 第 ${currentEpisodeIndex + 1} 集`
                              : videoTitle
                            : ''
                        }
                      />
                      {/* 弹幕选择器 / 缓存管理 / 提示：挂进播放器节点，网页全屏与原生全屏都能看见 */}
                      {showDanmakuSelector && (
                        <div
                          className='moontv-player-modal'
                          onClick={stopPlayerPointer}
                          onMouseDown={stopPlayerPointer}
                        >
                          <DanmakuSelector
                            videoTitle={videoTitle}
                            isVisible={showDanmakuSelector}
                            currentEpisode={currentEpisodeIndex + 1}
                            currentEpisodeTitle={
                              detail?.episodes_titles?.[currentEpisodeIndex]
                            }
                            onSelect={handleDanmakuSelect}
                            onClose={handleDanmakuClose}
                          />
                        </div>
                      )}
                      <div
                        onClick={stopPlayerPointer}
                        onMouseDown={stopPlayerPointer}
                      >
                        <VideoLoadingMask
                          visible={isVideoLoading}
                          stage={videoLoadingStage}
                        />
                      </div>
                      {isDanmakuLoading && (
                        <div className='pointer-events-none absolute left-4 right-4 top-16 z-40 flex justify-center'>
                          <div className='rounded-lg bg-gray-800/90 px-4 py-2 text-white shadow-lg'>
                            正在自动加载弹幕...
                          </div>
                        </div>
                      )}
                      {showCacheManager && (
                        <div
                          className='moontv-player-modal'
                          onClick={stopPlayerPointer}
                          onMouseDown={stopPlayerPointer}
                        >
                          <CacheManager
                            isOpen={showCacheManager}
                            onClose={() => setShowCacheManager(false)}
                          />
                        </div>
                      )}
                    </>,
                    playerHost
                  )}
              </div>
            </div>

            {/* 选集和换源 */}
            <div className='h-[300px] lg:h-full md:overflow-hidden md:col-span-1'>
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                episodes_titles={detail?.episodes_titles || []}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
                precomputedVideoInfo={precomputedVideoInfo}
                preferBestSource={preferBestSource}
                setLoading={setLoading}
                setIsVideoLoading={setIsVideoLoading}
                setVideoLoadingStage={setVideoLoadingStage}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='px-0 lg:px-[5rem] 2xl:px-32 mt-4 md:mt-6 xl:mt-8'>
          <VideoDetailPanel
            videoTitle={videoTitle}
            videoYear={videoYear}
            totalEpisodes={totalEpisodes}
            currentEpisodeIndex={currentEpisodeIndex}
            detail={detail}
            favorited={favorited}
            following={following}
            onToggleFavorite={handleToggleFavorite}
            onToggleFollowing={handleToggleFollowing}
            videoUrl={videoUrl}
            videoDoubanId={videoDoubanId}
            currentSource={currentSource}
            currentId={currentId}
            onDownload={() => setShowAddDownload(true)}
          />
        </div>
      </div>

      {/* 添加下载弹窗 */}
      <AddDownloadModal
        isOpen={showAddDownload}
        onClose={() => setShowAddDownload(false)}
        onAddTask={(config) => {
          // 触发自定义事件，通知导航栏的下载管理器
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('addDownloadTask', { detail: config })
            );
          }
          setShowAddDownload(false);
        }}
        initialUrl={videoUrl || ''}
        episodes={(detail?.episodes || []).map((url, i) => ({
          url,
          title: `${videoTitle}_${detail?.episodes_titles?.[i] || `第${i + 1}集`}`,
          label: detail?.episodes_titles?.[i] || `第${i + 1}集`,
        }))}
        currentEpisodeIndex={currentEpisodeIndex}
        initialTitle={`${videoTitle}${
          totalEpisodes > 1
            ? `_${detail?.episodes_titles?.[currentEpisodeIndex] || `第${currentEpisodeIndex + 1}集`}`
            : ''
        }`}
        skipConfig={skipConfig}
      />
    </PageLayout>
  );
}
