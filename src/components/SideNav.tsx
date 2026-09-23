/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

'use client';

import {
  Cat,
  ChevronDown,
  Clapperboard,
  Clover,
  Compass,
  Download,
  Film,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Trophy,
  Tv,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  applySidenavCollapsed,
  normalizeSidenavCollapsed,
  SIDENAV_COLLAPSED_KEY,
} from '@/lib/sidenav';
import { useDownloadTaskCount } from '@/hooks/useDownloadTaskCount';

import { useNavigationLoading } from './NavigationLoadingProvider';
import { useSite } from './SiteProvider';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * 「影视库」二级菜单的子项 —— 就是原先平铺在顶部导航栏里的那几个分类。
 * 顺序按使用频率排，电影/剧集在最前。
 */
const LIBRARY_ITEMS = [
  { icon: Film, label: '电影', href: '/douban?type=movie' },
  { icon: Tv, label: '剧集', href: '/douban?type=tv' },
  { icon: Clapperboard, label: '短剧', href: '/douban?type=short' },
  { icon: Cat, label: '动漫', href: '/douban?type=anime' },
  { icon: Clover, label: '综艺', href: '/douban?type=show' },
  { icon: Compass, label: '纪录片', href: '/douban?type=doc' },
];

/** 导航项基础样式；折叠态由 globals.css 的 `.moontv-sidenav-item` 覆盖成居中图标 */
const ITEM_CLASS =
  'moontv-sidenav-item group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors duration-200 hover:bg-gray-100/70 hover:text-green-600 dark:text-gray-300 dark:hover:bg-gray-800/70 dark:hover:text-green-400';

/**
 * 全站左侧导航栏（桌面端常驻，4.2.9 起不再限于首页）。
 *
 * ## 为什么全局
 *
 * 用户明确要求：点影视库子项跳到 /douban 后侧边栏必须还在，
 * 不能「跳回」顶部导航的旧界面。所以 `ConditionalNav` 里除播放页
 * （横向空间优先）与管理台（自有布局）外，桌面端一律渲染本组件。
 *
 * ## 导航结构
 *
 * 根级四项：首页 / 搜索 / 影视库 / 榜单，按当前路由高亮。
 * 影视库是**就地展开**（点击展开子分类），不跳页、也不新开一层；
 * 搜索是一级菜单、**单独打开 /search 页面**（与「电影」等平级）；
 * 首页内容区另有居中大搜索框 `HomeSearchHero`（带搜索源选择）。
 *
 * ## 折叠与刷新
 *
 * 折叠态存在 localStorage。为了刷新时不出现「先展开再收窄」的抖动，
 * 视觉（宽度 / 文字显隐）完全由 `<html data-sidenav-collapsed>` 驱动，
 * 而这个属性在首屏绘制前就被 `SIDENAV_INLINE_SCRIPT` 写好了。
 * 组件内的 `collapsed` state 只用于交互判断（如折叠时点可展开项要先展开）。
 *
 * ## 移动端
 *
 * 整块 `hidden md:flex`，手机上仍用 MobileHeader + MobileBottomNav。
 */
const SideNav = () => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteName } = useSite();
  const { startLoading } = useNavigationLoading();
  const downloadTaskCount = useDownloadTaskCount();

  const [collapsed, setCollapsed] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // 当前路径高亮：侧边栏 4.2.9 起全局常驻，需要跟随路由变化标出所在位置。
  // 影视库子项按 /douban?type=xxx 的 type 参数逐项匹配。
  const activeType = searchParams.get('type');
  const isHomeActive = pathname === '/';
  const isSearchActive = pathname.startsWith('/search');
  const isRankingActive = pathname.startsWith('/ranking');
  const isLibraryActive = pathname.startsWith('/douban');

  // 首屏内联脚本已经写好 DOM 属性，这里只是把 state 对齐，
  // 免得组件以为自己是展开态、点可展开项时行为与视觉不一致。
  useEffect(() => {
    setIsClient(true);
    if (typeof window === 'undefined') return;

    setCollapsed(
      normalizeSidenavCollapsed(
        window.localStorage.getItem(SIDENAV_COLLAPSED_KEY)
      )
    );

    const savedSimpleMode = window.localStorage.getItem('simpleMode');
    if (savedSimpleMode !== null) {
      try {
        setSimpleMode(JSON.parse(savedSimpleMode));
      } catch {
        // 存储内容损坏时按非简洁模式处理
      }
    }
  }, []);

  const persistCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDENAV_COLLAPSED_KEY, String(next));
    } catch {
      // 隐私模式下可能写入失败，不影响本次会话的视觉
    }
    applySidenavCollapsed(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    persistCollapsed(next);
    // 折叠后展开内容都看不见了，顺手收起来，避免展开时状态与视觉错位
    if (next) {
      setLibraryOpen(false);
    }
  }, [collapsed, persistCollapsed]);

  /**
   * 「影视库」就地展开。
   *
   * 折叠态下没有文字、也放不下子分类，所以点它先展开侧边栏 ——
   * 否则用户点一下「什么也没发生」，只能看到图标变了个样式。
   */
  const toggleLibrary = useCallback(() => {
    if (collapsed) {
      persistCollapsed(false);
      setLibraryOpen(true);
    } else {
      setLibraryOpen((open) => !open);
    }
  }, [collapsed, persistCollapsed]);

  const openDownloadManager = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('showDownloadManager'));
    }
  };

  return (
    <aside
      className='moontv-sidenav hidden md:flex fixed left-0 top-0 z-50 h-screen flex-col border-r border-gray-200/60 bg-white/85 backdrop-blur-xl dark:border-gray-700/50 dark:bg-gray-900/85'
      aria-label='主导航'
    >
      {/* 顶部：站点名 / 展开开关 + 折叠开关。
          折叠态刻意换成「展开」按钮而不是继续显示站点名 —— 站点名是装饰，
          展开是功能，折叠后必须留一个入口。回首页由导航区的「首页」图标承担。 */}
      <div className='moontv-sidenav-head flex h-16 flex-shrink-0 items-center gap-2 border-b border-gray-200/60 px-3 dark:border-gray-700/50'>
        <Link
          href='/'
          className='sidenav-expanded-only flex min-w-0 flex-1 items-center justify-center select-none'
          title={siteName}
        >
          <span className='truncate text-xl font-bold tracking-tight text-green-600'>
            {siteName}
          </span>
        </Link>
        <button
          type='button'
          onClick={toggleCollapsed}
          className='sidenav-expanded-only flex-shrink-0 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'
          title='收起侧边栏'
          aria-label='收起侧边栏'
        >
          <PanelLeftClose className='h-5 w-5' />
        </button>
        <button
          type='button'
          onClick={toggleCollapsed}
          className='sidenav-collapsed-only mx-auto rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'
          title='展开侧边栏'
          aria-label='展开侧边栏'
        >
          <PanelLeftOpen className='h-5 w-5' />
        </button>
      </div>

      {/* 主导航 */}
      <nav className='mt-2 flex-1 overflow-y-auto px-3 pb-4'>
        <Link
          href='/'
          onClick={startLoading}
          className={`${ITEM_CLASS} ${
            isHomeActive
              ? 'bg-green-500/10 text-green-600 dark:text-green-400'
              : ''
          }`}
          title='首页'
        >
          <Home className='h-5 w-5 flex-shrink-0' />
          <span className='sidenav-expanded-only'>首页</span>
        </Link>

        {/* 搜索：一级菜单，单独打开 /search 页面（与「电影」等平级，不是就地展开） */}
        <Link
          href='/search'
          onClick={startLoading}
          className={`${ITEM_CLASS} ${
            isSearchActive
              ? 'bg-green-500/10 text-green-600 dark:text-green-400'
              : ''
          }`}
          title='搜索'
        >
          <Search className='h-5 w-5 flex-shrink-0' />
          <span className='sidenav-expanded-only'>搜索</span>
        </Link>

        {isClient && !simpleMode && (
          <>
            {/* 「影视库」二级菜单：点击展开，不占用根级行数 */}
            <button
              type='button'
              onClick={toggleLibrary}
              className={`${ITEM_CLASS} w-full ${
                isLibraryActive
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : ''
              }`}
              title='影视库'
              aria-expanded={libraryOpen}
            >
              <Clapperboard className='h-5 w-5 flex-shrink-0' />
              <span className='sidenav-expanded-only flex-1 text-left'>
                影视库
              </span>
              <ChevronDown
                className={`sidenav-expanded-only h-4 w-4 flex-shrink-0 transition-transform duration-200 ${
                  libraryOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {libraryOpen && (
              <div className='sidenav-expanded-only mt-1 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-700'>
                {LIBRARY_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const itemType = item.href.split('type=')[1];
                  const isItemActive =
                    isLibraryActive && activeType === itemType;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={startLoading}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-gray-100/70 hover:text-green-600 dark:hover:bg-gray-800/70 dark:hover:text-green-400 ${
                        isItemActive
                          ? 'bg-green-500/10 font-medium text-green-600 dark:text-green-400'
                          : 'text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      <Icon className='h-4 w-4 flex-shrink-0' />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}

            <Link
              href='/ranking'
              onClick={startLoading}
              className={`${ITEM_CLASS} ${
                isRankingActive
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : ''
              }`}
              title='榜单'
            >
              <Trophy className='h-5 w-5 flex-shrink-0' />
              <span className='sidenav-expanded-only'>榜单</span>
            </Link>
          </>
        )}
      </nav>

      {/*
        底部功能区。后续要加的新按钮直接往这里排即可 ——
        展开态是竖排列表、折叠态自动收成居中图标列（布局切换在 globals.css）。
      */}
      <div className='moontv-sidenav-foot flex-shrink-0 border-t border-gray-200/60 px-3 py-3 dark:border-gray-700/50'>
        <button
          type='button'
          onClick={openDownloadManager}
          className={`${ITEM_CLASS} relative w-full`}
          title='下载管理'
        >
          <span className='relative flex-shrink-0'>
            <Download className='h-5 w-5' />
            {downloadTaskCount > 0 && (
              <span className='absolute -right-2 -top-2 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white'>
                {downloadTaskCount > 99 ? '99+' : downloadTaskCount}
              </span>
            )}
          </span>
          <span className='sidenav-expanded-only'>下载管理</span>
        </button>

        <div className='moontv-sidenav-actions mt-1'>
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </aside>
  );
};

export default memo(SideNav);
