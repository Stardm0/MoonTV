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

  // 首页桌面端改用左侧导航栏（SideNav），顶部导航会让位。
  // 移动端不受影响：TopNav 本身是 `hidden md:block`，手机上只走 MobileHeader。
  const isHome = pathname === '/';

  // 如果需要隐藏导航栏，返回 null
  if (shouldHideNav) {
    return null;
  }

  return (
    <>
      {/* 移动端头部 - 固定在根布局，避免页面切换时重新渲染 */}
      <MobileHeader showBackButton={false} />

      {/* 桌面端顶部导航栏 - 固定在根布局，避免页面切换时重新渲染 */}
      {!isHome && <TopNav />}

      {/* 移动端底部导航 - 固定在根布局，避免页面切换时重新渲染 */}
      <div className='md:hidden'>
        <MobileBottomNav />
      </div>
    </>
  );
};

// 使用 React.memo 优化，避免不必要的重新渲染
export default memo(ConditionalNav);
