'use client';

import { usePathname } from 'next/navigation';
import { memo } from 'react';

import MobileBottomNav from './MobileBottomNav';
import MobileHeader from './MobileHeader';
import TopNav from './TopNav';

/**
 * 条件导航栏组件
 * 根据当前路径决定是否显示导航栏
 * 在登录、警告等特殊页面不显示导航栏
 */
const ConditionalNav = () => {
  const pathname = usePathname();

  // 不显示导航栏的路径列表
  const hideNavPaths = ['/login', '/warning'];

  // 检查当前路径是否需要隐藏导航栏
  const shouldHideNav = hideNavPaths.some(path => pathname.startsWith(path));

  // 如果需要隐藏导航栏，返回 null
  if (shouldHideNav) {
    return null;
  }

  return (
    <>
      {/* 移动端头部 - 固定在根布局，避免页面切换时重新渲染 */}
      <MobileHeader showBackButton={false} />

      {/* 桌面端顶部导航栏 - 固定在根布局，避免页面切换时重新渲染 */}
      <TopNav />

      {/* 移动端底部导航 - 固定在根布局，避免页面切换时重新渲染 */}
      <div className='md:hidden'>
        <MobileBottomNav />
      </div>
    </>
  );
};

// 使用 React.memo 优化，避免不必要的重新渲染
export default memo(ConditionalNav);
