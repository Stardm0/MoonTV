'use client';

import { useEffect, useState } from 'react';

import { useNavigationLoading } from './NavigationLoadingProvider';

export function NavigationLoadingIndicator() {
  const { isLoading } = useNavigationLoading();
  const [visible, setVisible] = useState(false);
  const [doorsClosed, setDoorsClosed] = useState(false);

  useEffect(() => {
    if (isLoading) {
      setVisible(true);
      setDoorsClosed(true);
    } else {
      setDoorsClosed(false);
      setVisible(false);
    }
  }, [isLoading]);

  if (!visible) return null;

  return (
    <>
      {/* 全屏加载遮罩 */}
      <div
        className='fixed inset-0 z-[50] bg-white/90 backdrop-blur-xl transition-opacity duration-500 dark:bg-gray-900/90'
        style={{
          opacity: doorsClosed ? 1 : 0,
          pointerEvents: doorsClosed ? 'auto' : 'none',
        }}
      >
        {/* 中心加载动画 */}
        <div className='flex items-center justify-center h-full'>
        <div className='relative'>
          {/* 月亮形状 */}
          <div className='relative w-20 h-20'>
            {/* 月亮主体 */}
            <div className='absolute inset-0 bg-gradient-to-br from-yellow-300 to-yellow-500 dark:from-yellow-400 dark:to-yellow-600 rounded-full shadow-lg shadow-yellow-500/30 animate-bounce' 
                 style={{ animationDuration: '2s' }}>
              
              {/* 月亮上的小坑 */}
              <div className='absolute top-3 left-4 w-2 h-2 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
              <div className='absolute top-6 right-5 w-1.5 h-1.5 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
              <div className='absolute bottom-4 left-6 w-1 h-1 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
            </div>
            
            <div className='absolute -bottom-1 -left-1 w-2 h-2 bg-yellow-400 dark:bg-yellow-300 rounded-full animate-spin' 
                 style={{ animationDuration: '4s', animationDirection: 'reverse' }}>
              <div className='absolute inset-0 flex items-center justify-center'>
                <div className='w-0.5 h-0.5 bg-yellow-600 dark:bg-yellow-500 rounded-full' />
              </div>
            </div>
          </div>
        </div>

        {/* 加载文字 */}
        <div className='absolute mt-32 text-gray-700 dark:text-gray-300 font-medium text-sm'>
          <span className='animate-pulse'>🌙</span>
          <span className='animate-pulse' style={{ animationDelay: '0.2s' }}> 月亮正在努力加载中</span>
          <span className='animate-pulse' style={{ animationDelay: '0.4s' }}> ✨</span>
        </div>
        </div>
      </div>

    </>
  );
}

