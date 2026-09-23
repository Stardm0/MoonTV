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
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { addSearchHistory } from '@/lib/db.client';
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
 * 首页左侧导航栏（桌面端）。
 *
 * ## 为什么只在首页用
 *
 * 首页是「浏览」场景，需要常年可见的分类入口 + 后续要往底部加功能按钮；
 * 而详情/播放页是「专注」场景，横向的顶部导航更省纵向空间。所以这里把
 * 导航从顶部搬到左侧**只针对首页**，其他页面继续用 TopNav（见
 * `ConditionalNav` 里的路径判断）。
 *
 * ## 导航结构
 *
 * 根级只有四项：首页 / 搜索 / 影视库 / 榜单。搜索与影视库都是
 * **就地展开**（点击展开输入框 / 子分类），不跳页、也不新开一层；
 * 两者互斥展开，免得侧边栏被撑得过长。
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
  const router = useRouter();
  const { siteName } = useSite();
  const { startLoading } = useNavigationLoading();
  const downloadTaskCount = useDownloadTaskCount();

  const [collapsed, setCollapsed] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
      setSearchOpen(false);
    }
  }, [collapsed, persistCollapsed]);

  /**
   * 就地展开类入口的统一处理。
   *
   * 折叠态下没有文字、也放不下输入框，所以点它先展开侧边栏 ——
   * 否则用户点一下「什么也没发生」，只能看到图标变了个样式。
   */
  const toggleExpandable = useCallback(
    (which: 'search' | 'library') => {
      if (collapsed) {
        persistCollapsed(false);
        setSearchOpen(which === 'search');
        setLibraryOpen(which === 'library');
      } else {
        const isOpenNow = which === 'search' ? searchOpen : libraryOpen;
        const next = !isOpenNow;
        // 两个可展开项互斥，避免侧边栏同时长出两块内容
        setSearchOpen(which === 'search' ? next : false);
        setLibraryOpen(which === 'library' ? next : false);
        if (which === 'search' && next) {
          // 展开后直接聚焦，省掉一次点击
          setTimeout(() => searchInputRef.current?.focus(), 0);
        }
      }
    },
    [collapsed, libraryOpen, searchOpen, persistCollapsed]
  );

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const keyword = query.trim();
    if (keyword) {
      addSearchHistory(keyword);
    }
    startLoading();
    router.push(
      keyword ? `/search?q=${encodeURIComponent(keyword)}` : '/search'
    );
  };

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
          className={`${ITEM_CLASS} bg-green-500/10 text-green-600 dark:text-green-400`}
          title='首页'
        >
          <Home className='h-5 w-5 flex-shrink-0' />
          <span className='sidenav-expanded-only'>首页</span>
        </Link>

        {/* 搜索：就地展开输入框，不跳页 */}
        <button
          type='button'
          onClick={() => toggleExpandable('search')}
          className={`${ITEM_CLASS} w-full`}
          title='搜索'
          aria-expanded={searchOpen}
        >
          <Search className='h-5 w-5 flex-shrink-0' />
          <span className='sidenav-expanded-only flex-1 text-left'>搜索</span>
          <ChevronDown
            className={`sidenav-expanded-only h-4 w-4 flex-shrink-0 transition-transform duration-200 ${
              searchOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {searchOpen && (
          <div className='sidenav-expanded-only mt-1 border-l border-gray-200 pl-2 dark:border-gray-700'>
            <form onSubmit={submitSearch} className='py-1 pr-1'>
              <div className='relative'>
                <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
                <input
                  ref={searchInputRef}
                  type='text'
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='搜索影视…'
                  className='w-full rounded-lg border border-gray-200/70 bg-gray-100/70 py-2 pl-8 pr-7 text-sm text-gray-700 placeholder-gray-400 transition-colors focus:border-green-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-green-400/40 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-200 dark:placeholder-gray-500 dark:focus:bg-gray-800'
                />
                {query && (
                  <button
                    type='button'
                    onClick={() => setQuery('')}
                    className='absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300'
                    title='清空'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            </form>
          </div>
        )}

        {isClient && !simpleMode && (
          <>
            {/* 「影视库」二级菜单：点击展开，不占用根级行数 */}
            <button
              type='button'
              onClick={() => toggleExpandable('library')}
              className={`${ITEM_CLASS} w-full`}
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
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={startLoading}
                      className='flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100/70 hover:text-green-600 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-green-400'
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
              className={ITEM_CLASS}
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
