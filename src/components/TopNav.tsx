/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import {
  Cat,
  Clapperboard,
  Clover,
  Compass,
  Download,
  Film,
  GripVertical,
  History,
  Home,
  Search,
  Trash2,
  Trophy,
  Tv,
  UsersRound,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { memo, useEffect, useRef, useState } from 'react';

import {
  addSearchHistory,
  clearSearchHistory,
  deleteSearchHistory,
  getSearchHistory,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import {
  applyNavMenuOrder,
  loadNavMenuOrder,
  NAV_ORDER_UPDATED_EVENT,
  saveNavMenuOrder,
} from '@/lib/nav-settings';

import { useNavigationLoading } from './NavigationLoadingProvider';
import NavScrollContainer from './NavScrollContainer';
import SearchSuggestions from './SearchSuggestions';
import { useSite } from './SiteProvider';
import SourceSelector from './SourceSelector';
import { ThemeToggle } from './ThemeToggle';
import useNavAutoHide from './useNavAutoHide';
import { UserMenu } from './UserMenu';
interface TopNavProps {
  activePath?: string;
}
const TopNav = ({ activePath }: TopNavProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteName } = useSite();
  const { startLoading } = useNavigationLoading();
  const [active, setActive] = useState(activePath || '/');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchSources, setSearchSources] = useState<string[]>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyPopupRef = useRef<HTMLDivElement>(null);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const searchBarRef = useRef<HTMLDivElement>(null);
  const [downloadTaskCount, setDownloadTaskCount] = useState(0);
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  // 用户自定义的菜单顺序（长按拖动调整后持久化到 localStorage）
  const [menuOrder, setMenuOrder] = useState<string[]>([]);
  // 自动隐藏导航栏（仅桌面端）：默认收起，指针移到屏幕顶部边缘时展开
  const {
    enabled: autoHideNav,
    hidden: autoHideNavHidden,
    navRef,
  } = useNavAutoHide();
  useEffect(() => {
    const updateTaskCount = () => {
      if (typeof window === 'undefined') return;
      const saved = localStorage.getItem('downloadTasks');
      if (!saved) {
        setDownloadTaskCount(0);
        return;
      }
      try {
        const tasks = JSON.parse(saved) as { status: string }[];
        setDownloadTaskCount(
          tasks.filter(
            (t) =>
              t.status === 'downloading' ||
              t.status === 'paused' ||
              t.status === 'waiting' ||
              t.status === 'error'
          ).length
        );
      } catch {
        setDownloadTaskCount(0);
      }
    };
    updateTaskCount();
    const handler = () => updateTaskCount();
    window.addEventListener('storage', handler);
    window.addEventListener('downloadTasksUpdated', handler as EventListener);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(
        'downloadTasksUpdated',
        handler as EventListener
      );
    };
  }, []);
  useEffect(() => {
    setIsClient(true);
    if (typeof window !== 'undefined') {
      const s = localStorage.getItem('simpleMode');
      if (s !== null) setSimpleMode(JSON.parse(s));
    }
    // 读取自定义菜单顺序，并订阅同标签页内的排序变更
    setMenuOrder(loadNavMenuOrder());
    const onOrderUpdated = () => setMenuOrder(loadNavMenuOrder());
    window.addEventListener(NAV_ORDER_UPDATED_EVENT, onOrderUpdated);
    getSearchHistory().then(setSearchHistory);
    const unsubscribe = subscribeToDataUpdates(
      'searchHistoryUpdated',
      setSearchHistory
    );
    return () => {
      window.removeEventListener(NAV_ORDER_UPDATED_EVENT, onOrderUpdated);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (activePath) {
      setActive(activePath);
    } else {
      const qs = searchParams.toString();
      setActive(qs ? `${pathname}?${qs}` : pathname);
    }
  }, [activePath, pathname, searchParams]);
  useEffect(() => {
    if (pathname === '/search') {
      const q = searchParams.get('q');
      setSearchQuery(q ? decodeURIComponent(q) : '');
      const src = searchParams.get('sources');
      if (src) setSearchSources(src.split(','));
    }
  }, [pathname, searchParams]);
  /* ★ 导航左侧菜单：含「首页」，key 用于长按拖动排序后的顺序持久化 */
  const allMenuItems = [
    { icon: Home, label: '首页', href: '/', isHome: true },
    { icon: Film, label: '电影', href: '/douban?type=movie', isHome: false },
    { icon: Tv, label: '剧集', href: '/douban?type=tv', isHome: false },
    {
      icon: Clapperboard,
      label: '短剧',
      href: '/douban?type=short',
      isHome: false,
    },
    { icon: Compass, label: '纪录片', href: '/douban?type=doc', isHome: false },
    { icon: Cat, label: '动漫', href: '/douban?type=anime', isHome: false },
    { icon: Clover, label: '综艺', href: '/douban?type=show', isHome: false },
    { icon: Trophy, label: '榜单', href: '/ranking', isHome: false },
    { icon: UsersRound, label: '观影室', href: '/watch-room', isHome: false },
  ];
  /* 简洁模式：仅保留首页与观影室 */
  const visibleMenuItems = allMenuItems.filter((item) =>
    item.isHome ? !simpleMode : !simpleMode || item.href === '/watch-room'
  );
  /* 套用用户自定义顺序（未记录顺序的项保持原始相对顺序排在后面） */
  const orderedMenuItems = applyNavMenuOrder(
    visibleMenuItems,
    (item) => item.href,
    menuOrder
  );
  /* 长按拖动结束后保存新顺序 */
  const handleMenuReorder = (order: string[]) => {
    setMenuOrder(order);
    saveNavMenuOrder(order);
  };
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    addSearchHistory(q);
    if (pathname !== '/search') startLoading();
    const p = new URLSearchParams();
    p.set('q', q);
    if (searchSources.length > 0) p.set('sources', searchSources.join(','));
    router.push(`/search?${p.toString()}`);
    setShowSuggestions(false);
    setShowHistory(false);
  };
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setShowSuggestions(e.target.value.trim().length > 0);
    setShowHistory(false);
  };
  const handleSuggestionSelect = (s: string) => {
    setSearchQuery(s);
    setShowSuggestions(false);
    setShowHistory(false);
    addSearchHistory(s);
    if (pathname !== '/search') startLoading();
    const p = new URLSearchParams();
    p.set('q', s);
    if (searchSources.length > 0) p.set('sources', searchSources.join(','));
    router.push(`/search?${p.toString()}`);
  };
  const handleInputFocus = () => {
    if (searchQuery.trim().length > 0) setShowSuggestions(true);
    setShowHistory(false);
  };
  const clearSearch = () => {
    setSearchQuery('');
    setShowSuggestions(false);
    searchInputRef.current?.focus();
  };
  const handleHistoryClick = (item: string) => {
    setSearchQuery(item);
    setShowHistory(false);
    addSearchHistory(item);
    if (pathname !== '/search') startLoading();
    const p = new URLSearchParams();
    p.set('q', item);
    if (searchSources.length > 0) p.set('sources', searchSources.join(','));
    router.push(`/search?${p.toString()}`);
  };
  const handleDeleteHistory = async (item: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSearchHistory(item);
  };
  const handleClearAllHistory = async () => {
    await clearSearchHistory();
    setShowHistory(false);
  };
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // 搜索源设置弹窗通过 Portal 挂在 body 上，点击其内部不应关闭搜索栏
      const target = e.target as Element | null;
      if (target?.closest?.('[data-source-settings-modal]')) return;
      if (
        showSearchBar &&
        searchBarRef.current &&
        !searchBarRef.current.contains(e.target as Node)
      ) {
        setShowSearchBar(false);
        setOpenFilter(null);
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSearchBar, openFilter, showHistory]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        showHistory &&
        historyPopupRef.current &&
        historyButtonRef.current &&
        !historyPopupRef.current.contains(e.target as Node) &&
        !historyButtonRef.current.contains(e.target as Node)
      ) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistory]);
  /* ★ 搜索栏：items-stretch 让源选择器与输入框等高，不再各自决定高度 */
  const searchBarContent = (
    <div
      className='top-nav__search flex items-stretch'
      ref={searchBarRef}
      style={{ width: 'var(--nav-search-w)' }}
    >
      <div className='flex-shrink-0 h-full flex items-center'>
        <SourceSelector
          selectedSources={searchSources}
          onChange={setSearchSources}
          openFilter={openFilter}
          setOpenFilter={setOpenFilter}
          size='compact'
        />
      </div>
      <div className='relative flex-1'>
        <form onSubmit={handleSearch} className='relative h-full'>
          <Search className='top-nav__search-icon absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
          <input
            ref={searchInputRef}
            type='text'
            value={searchQuery}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            placeholder='搜索电影、电视剧...'
            className='top-nav__searchbox w-full h-full rounded-r-lg rounded-l-none bg-gray-100/80 py-2 pl-9 pr-9 text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-400 focus:bg-white transition-all duration-200 border border-gray-200/50 border-l-0 dark:bg-gray-800 dark:text-gray-300 dark:focus:bg-gray-700 dark:border-gray-700'
          />
          <div className='absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 h-full justify-end'>
            {searchQuery && (
              <button
                type='button'
                onClick={clearSearch}
                className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex-shrink-0'
              >
                <X className='top-nav__icon' />
              </button>
            )}
            <button
              ref={historyButtonRef}
              type='button'
              onClick={() => setShowHistory((v) => !v)}
              className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors relative flex-shrink-0'
              title='搜索历史'
            >
              <History className='top-nav__icon' />
              {searchHistory.length > 0 && (
                <span className='top-nav__badge w-2 h-2 bg-green-500 rounded-full' />
              )}
            </button>
          </div>
          <SearchSuggestions
            query={searchQuery}
            isVisible={showSuggestions}
            onSelect={handleSuggestionSelect}
            onClose={() => setShowSuggestions(false)}
          />
        </form>
        {showHistory && searchHistory.length > 0 && (
          <div
            ref={historyPopupRef}
            className='absolute top-full right-0 mt-2 w-full min-w-[280px] max-w-[420px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-96 overflow-y-auto z-50'
          >
            <div className='p-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between'>
              <h3 className='text-sm font-semibold text-gray-700 dark:text-gray-300'>
                搜索历史
              </h3>
              <button
                onClick={handleClearAllHistory}
                className='text-xs text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-500 transition-colors'
              >
                清空全部
              </button>
            </div>
            <div className='p-2'>
              {searchHistory.map((item, i) => (
                <div
                  key={`history-${item}-${i}`}
                  className='group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer'
                  onClick={() => handleHistoryClick(item)}
                >
                  <span className='text-sm text-gray-700 dark:text-gray-300 truncate flex-1'>
                    {item}
                  </span>
                  <button
                    onClick={(e) => handleDeleteHistory(item, e)}
                    className='ml-2 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-500 transition-colors'
                    title='删除'
                  >
                    <Trash2 className='h-3 w-3' />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  /* ★ 搜索触发按钮：使用刚性尺寸，展开/收起不影响布局 */
  const searchButton = (
    <button
      onClick={() => {
        setShowSearchBar(true);
        setTimeout(() => searchInputRef.current?.focus(), 300);
      }}
      className='top-nav__search-trigger text-gray-700 hover:bg-gray-100/50 hover:text-green-600 rounded-lg transition-colors duration-200 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700/50 flex-shrink-0'
      title='搜索'
    >
      <Search className='top-nav__icon' />
    </button>
  );
  return (
    <>
      <header
        ref={(element) => {
          navRef.current = element;
        }}
        className={`top-nav hidden md:block z-50 w-full bg-white/80 backdrop-blur-xl border-b border-gray-200/50 shadow-sm dark:bg-gray-900/80 dark:border-gray-700/50 ${
          autoHideNav
            ? 'fixed left-0 right-0 top-0 transition-[transform,opacity] duration-300 ease-out will-change-transform'
            : 'sticky top-0'
        } ${
          autoHideNav && autoHideNavHidden
            ? '-translate-y-full opacity-0 pointer-events-none'
            : 'translate-y-0 opacity-100'
        }`}
      >
        <div className='top-nav__inner mx-auto h-full flex items-center'>
          {simpleMode ? (
            <div className='absolute left-1/2 transform -translate-x-1/2'>
              <Link
                href='/'
                className='flex items-center justify-center select-none hover:opacity-80 transition-opacity duration-200'
                onClick={() => {
                  if (active !== '/') startLoading();
                }}
              >
                <span className='top-nav__logo font-bold text-green-600 tracking-tight'>
                  {siteName}
                </span>
              </Link>
            </div>
          ) : (
            <Link
              href='/'
              className='flex items-center justify-center select-none hover:opacity-80 transition-opacity duration-200 flex-shrink-0'
              onClick={() => {
                if (active !== '/') startLoading();
              }}
            >
              <span className='top-nav__logo font-bold text-green-600 tracking-tight'>
                {siteName}
              </span>
            </Link>
          )}
          {/* ★ 左侧菜单统一放进固定最大宽度的横向滚动容器：
              超出部分隐藏并可拖拽 / 滑动查看，长按菜单项还能拖动调整顺序 */}
          <NavScrollContainer
            className='top-nav__menu-scroll'
            activeKey={active}
            scrollIntoViewSelector='[data-active="true"]'
            onReorder={handleMenuReorder}
          >
            <nav className='flex items-center gap-1'>
              {isClient &&
                orderedMenuItems.map((item) => {
                  const typeMatch = item.href.match(/type=([^&]+)/)?.[1];
                  const decodedActive = decodeURIComponent(active);
                  const decodedHref = decodeURIComponent(item.href);
                  const isActive = item.isHome
                    ? decodedActive === '/'
                    : decodedActive === decodedHref ||
                      (item.href === '/watch-room' &&
                        decodedActive.startsWith('/watch-room')) ||
                      (!!typeMatch &&
                        decodedActive.startsWith('/douban') &&
                        decodedActive.includes(`type=${typeMatch}`));
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-nav-key={item.href}
                      onClick={() => {
                        if (!isActive) startLoading();
                        setActive(item.href);
                      }}
                      data-active={isActive}
                      title='长按可拖动调整位置'
                      className='top-nav__link top-nav__link--sortable group relative flex items-center gap-2 rounded-lg text-gray-700 hover:bg-gray-100/50 hover:text-green-600 data-[active=true]:bg-green-500/10 data-[active=true]:text-green-600 font-medium transition-colors duration-200 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700/50 dark:data-[active=true]:bg-green-500/10 dark:data-[active=true]:text-green-400'
                    >
                      <Icon className='top-nav__icon' />
                      <span className='top-nav__text'>{item.label}</span>
                      {/* 拖动把手：悬停菜单栏时浮现，暗示可以长按拖动排序 */}
                      <GripVertical
                        aria-hidden
                        className='top-nav__drag-handle h-3 w-3 absolute -right-0.5 top-1/2 -translate-y-1/2'
                      />
                    </Link>
                  );
                })}
            </nav>
          </NavScrollContainer>
          <div className='ml-auto flex items-center justify-end flex-shrink-0'>
            {showSearchBar && searchBarContent}
            {!showSearchBar && searchButton}
          </div>
          {/* ========== 【已修复区域】 ========== */}
          <div className='flex items-center gap-1 flex-shrink-0 ml-2'>
            <button
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new Event('showDownloadManager'));
                }
              }}
              className='top-nav__btn-rigid text-gray-700 hover:bg-gray-100/50 hover:text-green-600 rounded-lg transition-colors duration-200 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700/50'
              title='下载管理器'
            >
              <Download className='top-nav__icon' />
              {downloadTaskCount > 0 && (
                <span className='top-nav__badge bg-red-500 text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center'>
                  {downloadTaskCount > 99 ? '99+' : downloadTaskCount}
                </span>
              )}
            </button>
            {/* 外层改为div，移除onClick，ThemeToggle自带button与切换逻辑 */}
            <div className='top-nav__btn-rigid' title='切换主题'>
              <ThemeToggle />
            </div>
            <div className='top-nav__btn-rigid'>
              <UserMenu />
            </div>
          </div>
          {/* ==================================== */}
        </div>
      </header>
      {/* 自动隐藏时导航栏脱离文档流，用占位高度跟随显隐，让页面内容一起上移 / 下移 */}
      {autoHideNav && (
        <div
          aria-hidden
          className='hidden md:block overflow-hidden transition-[height] duration-300 ease-out'
          style={{ height: autoHideNavHidden ? 0 : 'var(--nav-h)' }}
        />
      )}
    </>
  );
};
export default memo(TopNav);
