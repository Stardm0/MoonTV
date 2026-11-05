/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import {
  Cat,
  Clapperboard,
  Clover,
  Compass,
  Film,
  GripVertical,
  Home,
  Search,
  Trophy,
  Tv,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyNavMenuOrder,
  loadNavMenuOrder,
  NAV_ORDER_UPDATED_EVENT,
  saveNavMenuOrder,
} from '@/lib/nav-settings';

import { useNavigationLoading } from './NavigationLoadingProvider';
import useDragScroll from './useDragScroll';

interface MobileBottomNavProps {
  /**
   * 主动指定当前激活的路径。当未提供时，自动使用 usePathname() 获取的路径。
   */
  activePath?: string;
}

const MobileBottomNav = ({ activePath }: MobileBottomNavProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { startLoading } = useNavigationLoading();

  // 当前激活路径：优先使用传入的 activePath，否则使用「路径 + 查询参数」。
  // 必须带上查询参数，否则 /douban?type=xxx 这类导航项永远无法匹配到激活状态。
  const searchQuery = searchParams?.toString() ?? '';
  const currentActive =
    activePath ?? (searchQuery ? `${pathname}?${searchQuery}` : pathname);

  const [navItems] = useState([
    { icon: Home, label: '首页', href: '/' },
    { icon: Search, label: '搜索', href: '/search' },
    {
      icon: Film,
      label: '电影',
      href: '/douban?type=movie',
    },
    {
      icon: Tv,
      label: '剧集',
      href: '/douban?type=tv',
    },
    {
      icon: Clapperboard,
      label: '短剧',
      href: '/douban?type=short',
    },
    {
      icon: Compass,
      label: '纪录片',
      href: '/douban?type=doc',
    },
    {
      icon: Cat,
      label: '动漫',
      href: '/douban?type=anime',
    },
    {
      icon: Clover,
      label: '综艺',
      href: '/douban?type=show',
    },
    {
      icon: Trophy,
      label: '榜单',
      href: '/ranking',
    },
    {
      icon: UsersRound,
      label: '观影室',
      href: '/watch-room',
    },
  ]);

  // 检查是否启用简洁模式 - 使用状态管理
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  // 用户自定义的底部导航顺序（长按拖动调整后持久化）
  const [menuOrder, setMenuOrder] = useState<string[]>([]);

  // 横向滚动容器 + 长按拖动排序
  const [showHint, setShowHint] = useState(false);
  const hintTimerRef = useRef<number | null>(null);

  const {
    containerRef,
    isReordering,
    isLongPressing,
    handleClickCapture,
    updateScrollState,
  } = useDragScroll<HTMLUListElement>({
    onReorder: (order) => {
      setMenuOrder(order);
      // 与桌面端共用同一份顺序（保存时自动合并两端独有的菜单项）
      saveNavMenuOrder(order);
    },
  });

  useEffect(() => {
    setIsClient(true);
    if (typeof window !== 'undefined') {
      const savedSimpleMode = localStorage.getItem('simpleMode');
      if (savedSimpleMode !== null) {
        setSimpleMode(JSON.parse(savedSimpleMode));
      }
    }
    setMenuOrder(loadNavMenuOrder());
    const onOrderUpdated = () => setMenuOrder(loadNavMenuOrder());
    window.addEventListener(NAV_ORDER_UPDATED_EVENT, onOrderUpdated);
    return () =>
      window.removeEventListener(NAV_ORDER_UPDATED_EVENT, onOrderUpdated);
  }, []);

  // 简洁模式下只保留首页 / 搜索 / 观影室，再套用自定义顺序
  const visibleItems = useMemo(
    () =>
      applyNavMenuOrder(
        navItems.filter(
          (item) =>
            !simpleMode || ['/', '/search', '/watch-room'].includes(item.href)
        ),
        (item) => item.href,
        menuOrder
      ),
    [navItems, simpleMode, menuOrder]
  );

  // 排序前后项数变化时刷新溢出提示状态
  useEffect(() => {
    updateScrollState();
  }, [visibleItems.length, updateScrollState]);

  // 首次进入时给一次「长按可调整顺序」的引导（触屏没有 hover，必须主动提示）
  useEffect(() => {
    if (!isClient || menuOrder.length > 0) return;
    if (typeof window === 'undefined') return;

    const seenKey = 'navBottomReorderHintSeen';
    if (window.sessionStorage.getItem(seenKey) === 'true') return;

    setShowHint(true);
    hintTimerRef.current = window.setTimeout(() => {
      setShowHint(false);
      try {
        window.sessionStorage.setItem(seenKey, 'true');
      } catch {
        /* 忽略存储异常 */
      }
    }, 5200);

    return () => {
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    };
  }, [isClient, menuOrder.length]);

  // 一旦开始长按或排序，就不再显示引导
  useEffect(() => {
    if (isLongPressing || isReordering) {
      setShowHint(false);
      try {
        window.sessionStorage.setItem('navBottomReorderHintSeen', 'true');
      } catch {
        /* 忽略存储异常 */
      }
    }
  }, [isLongPressing, isReordering]);

  const isActive = (href: string) => {
    // 解码URL以进行正确的比较
    const decodedActive = decodeURIComponent(currentActive);
    const decodedItemHref = decodeURIComponent(href);

    const [itemPath, itemQuery = ''] = decodedItemHref.split('?');
    const [activePath, activeQuery = ''] = decodedActive.split('?');

    // 带查询参数的导航项（如 /douban?type=movie）：先看完全匹配，
    // 再看路径一致且 type 一致（查询参数顺序可能不同）
    if (itemQuery) {
      if (decodedActive === decodedItemHref) return true;
      if (activePath !== itemPath) return false;
      const itemType = itemQuery.match(/type=([^&]+)/)?.[1] ?? '';
      const activeType =
        activeQuery.match(/type=([^&]+)/)?.[1] ??
        // /douban 未携带 type 时，页面默认展示电影
        (itemPath === '/douban' ? 'movie' : '');
      return itemType !== '' && itemType === activeType;
    }

    // 不带查询参数的导航项（如 /、/search、/ranking）：路径一致即视为激活
    return activePath === itemPath;
  };

  return (
    <nav
      className='mobile-bottom-nav md:hidden fixed left-0 right-0 z-[600] bg-white/90 backdrop-blur-xl border-t border-gray-200/50 overflow-hidden dark:bg-gray-900/80 dark:border-gray-700/50'
      style={{
        /* 紧贴视口底部，同时在内部留出安全区高度 */
        bottom: 0,
        paddingBottom: 'env(safe-area-inset-bottom)',
        minHeight: 'calc(3.5rem + env(safe-area-inset-bottom))',
      }}
    >
      <ul
        ref={containerRef}
        className={`mobile-bottom-nav__list flex items-center overflow-x-auto scrollbar-hide${
          isReordering ? ' is-reordering' : ''
        }`}
        onClickCapture={handleClickCapture}
        onDragStart={(event) => event.preventDefault()}
        data-reordering={isReordering}
      >
        {visibleItems.map((item) => {
          const active = isActive(item.href);

          // 简洁模式下只显示首页和搜索，但在服务器端渲染时先不渲染
          if (!isClient) {
            return null; // 服务器端渲染时不显示任何内容，避免闪烁
          }

          return (
            <li
              key={item.href}
              data-nav-key={item.href}
              className='flex-shrink-0'
              style={{
                width: simpleMode ? '50vw' : '20vw',
                minWidth: simpleMode ? '50vw' : '20vw',
              }}
            >
              <Link
                href={item.href}
                className='mobile-bottom-nav__link relative flex flex-col items-center justify-center w-full h-14 gap-1 text-xs'
                onClick={() => {
                  // 如果不是当前激活的链接，则触发加载动画
                  if (!active) {
                    startLoading();
                  }
                }}
              >
                {/* 拖动把手：触屏没有 hover，常显淡色提示可以长按拖动排序 */}
                <GripVertical
                  aria-hidden
                  className='top-nav__drag-handle h-2.5 w-2.5 absolute top-0.5 right-1'
                />
                <item.icon
                  className={`h-6 w-6 ${
                    active
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                />
                <span
                  className={
                    active
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-gray-600 dark:text-gray-300'
                  }
                >
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* 首次进入的引导：长按可拖动调整顺序 */}
      {showHint && !isReordering && (
        <div className='top-nav__scroll-hint' role='status'>
          <span>
            <b>长按菜单</b>可拖动调整顺序
          </span>
        </div>
      )}

      {/* 长按等待中：提示继续按住 */}
      {isLongPressing && !isReordering && (
        <div
          className='top-nav__reorder-tip top-nav__reorder-tip--pressing'
          role='status'
        >
          继续按住，可拖动调整顺序
        </div>
      )}

      {/* 排序中的状态提示 */}
      {isReordering && (
        <div className='top-nav__reorder-tip' role='status'>
          拖到目标位置后松开，即可保存
        </div>
      )}
    </nav>
  );
};

// 使用 React.memo 优化，避免父组件更新时导致不必要的重新渲染
export default memo(MobileBottomNav);
