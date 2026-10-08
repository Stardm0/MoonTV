/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

/**
 * 播放页状态视图组件集合：
 * - LoadingView：全屏加载动画
 * - ErrorView：全屏错误提示
 * - VideoLoadingMask：播放器上的视频/换源/优选遮罩
 */

interface LoadingViewProps {
  stage: string;
  message: string;
}

export function LoadingView({ stage, message }: LoadingViewProps) {
  return (
    <div className='flex items-center justify-center min-h-screen bg-transparent'>
      <div className='text-center max-w-md mx-auto px-6'>
        {/* 动画影院图标 */}
        <div className='relative mb-8'>
          <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
            <div className='text-white text-4xl'>
              {stage === 'searching' && '🔍'}
              {stage === 'preferring' && '⚡'}
              {stage === 'fetching' && '🎬'}
              {stage === 'ready' && '✨'}
            </div>
            {/* 旋转光环 */}
            <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
          </div>

          {/* 浮动粒子效果 */}
          <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
            <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
            <div
              className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
              style={{ animationDelay: '0.5s' }}
            ></div>
            <div
              className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
              style={{ animationDelay: '1s' }}
            ></div>
          </div>
        </div>

        {/* 进度指示器 */}
        <div className='mb-6 w-80 mx-auto'>
          <div className='flex justify-center space-x-2 mb-4'>
            <div
              className={`w-3 h-3 rounded-full transition-all duration-500 ${
                stage === 'searching' || stage === 'fetching'
                  ? 'bg-green-500 scale-125'
                  : stage === 'preferring' || stage === 'ready'
                  ? 'bg-green-500'
                  : 'bg-gray-300'
              }`}
            ></div>
            <div
              className={`w-3 h-3 rounded-full transition-all duration-500 ${
                stage === 'preferring'
                  ? 'bg-green-500 scale-125'
                  : stage === 'ready'
                  ? 'bg-green-500'
                  : 'bg-gray-300'
              }`}
            ></div>
            <div
              className={`w-3 h-3 rounded-full transition-all duration-500 ${
                stage === 'ready'
                  ? 'bg-green-500 scale-125'
                  : 'bg-gray-300'
              }`}
            ></div>
          </div>

          {/* 进度条 */}
          <div className='w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden'>
            <div
              className='h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full transition-all duration-1000 ease-out'
              style={{
                width:
                  stage === 'searching' || stage === 'fetching'
                    ? '33%'
                    : stage === 'preferring'
                    ? '66%'
                    : '100%',
              }}
            ></div>
          </div>
        </div>

        {/* 加载消息 */}
        <div className='space-y-2'>
          <p className='text-xl font-semibold text-gray-800 dark:text-gray-200 animate-pulse'>
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  message: string;
  videoTitle: string;
  /** 主要操作：有标题时返回搜索页，否则返回上一页 */
  onPrimary: () => void;
  /** 重新尝试 */
  onRetry: () => void;
}

export function ErrorView({ message, videoTitle, onPrimary, onRetry }: ErrorViewProps) {
  return (
    <div className='flex items-center justify-center min-h-screen bg-transparent'>
      <div className='text-center max-w-md mx-auto px-6'>
        {/* 错误图标 */}
        <div className='relative mb-8'>
          <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
            <div className='text-white text-4xl'>😵</div>
            {/* 脉冲效果 */}
            <div className='absolute -inset-2 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl opacity-20 animate-pulse'></div>
          </div>

          {/* 浮动错误粒子 */}
          <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
            <div className='absolute top-2 left-2 w-2 h-2 bg-red-400 rounded-full animate-bounce'></div>
            <div
              className='absolute top-4 right-4 w-1.5 h-1.5 bg-orange-400 rounded-full animate-bounce'
              style={{ animationDelay: '0.5s' }}
            ></div>
            <div
              className='absolute bottom-3 left-6 w-1 h-1 bg-yellow-400 rounded-full animate-bounce'
              style={{ animationDelay: '1s' }}
            ></div>
          </div>
        </div>

        {/* 错误信息 */}
        <div className='space-y-4 mb-8'>
          <h2 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
            哎呀，出现了一些问题
          </h2>
          <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
            <p className='text-red-600 dark:text-red-400 font-medium'>
              {message}
            </p>
          </div>
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            请检查网络连接或尝试刷新页面
          </p>
        </div>

        {/* 操作按钮 */}
        <div className='space-y-3'>
          <button
            onClick={onPrimary}
            className='w-full px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:from-green-600 hover:to-emerald-700 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl'
          >
            {videoTitle ? '🔍 返回搜索' : '← 返回上页'}
          </button>

          <button
            onClick={onRetry}
            className='w-full px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200'
          >
            🔄 重新尝试
          </button>
        </div>
      </div>
    </div>
  );
}

interface VideoLoadingMaskProps {
  visible: boolean;
  stage: 'initing' | 'sourceChanging' | 'optimizing';
}

/**
 * 播放器上的加载遮罩，覆盖视频区域展示加载/换源/优选状态。
 */
export function VideoLoadingMask({ visible, stage }: VideoLoadingMaskProps) {
  if (!visible) return null;

  return (
    <div className='absolute inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[120] transition-all duration-300'>
      <div className='text-center max-w-md mx-auto px-6'>
        {/* 动画影院图标 */}
        <div className='relative mb-8'>
          <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
            <div className='text-white text-4xl'>🎬</div>
            {/* 旋转光环 */}
            <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
          </div>

          {/* 浮动粒子效果 */}
          <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
            <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
            <div
              className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
              style={{ animationDelay: '0.5s' }}
            ></div>
            <div
              className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
              style={{ animationDelay: '1s' }}
            ></div>
          </div>
        </div>

        {/* 加载消息 */}
        <div className='space-y-2'>
          <p className='text-xl font-semibold text-white animate-pulse'>
            {stage === 'sourceChanging'
              ? '🔄 切换播放源...'
              : stage === 'optimizing'
              ? '⚡ 优选播放源...'
              : '🔄 视频加载中...'}
          </p>
        </div>
      </div>
    </div>
  );
}
