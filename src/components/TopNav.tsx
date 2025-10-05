/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { Cat, Clover, Film, History, Home, Search, Star, Trash2, Tv, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { getCustomCategories } from '@/lib/config.client';
import {
  addSearchHistory,
  clearSearchHistory,
  deleteSearchHistory,
  getSearchHistory,
  subscribeToDataUpdates,
} from '@/lib/db.client';

import { useNavigationLoading } from './NavigationLoadingProvider';
import SearchSuggestions from './SearchSuggestions';
import { useSite } from './SiteProvider';
import SourceSelector from './SourceSelector';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

interface TopNavProps {
  activePath?: string;
}

const TopNav = ({ activePath = '/' }: TopNavProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteName } = useSite();
  const { startLoading } = useNavigationLoading();

  const [active, setActive] = useState(activePath);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 搜索源选择器状态
  const [searchSources, setSearchSources] = useState<string[]>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);

  // 历史记录状态
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyPopupRef = useRef<HTMLDivElement>(null);

  // 检查是否启用简洁模式
  const [simpleMode, setSimpleMode] = useState(false);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    if (typeof window !== 'undefined') {
      const savedSimpleMode = localStorage.getItem('simpleMode');
      if (savedSimpleMode !== null) {
        setSimpleMode(JSON.parse(savedSimpleMode));
      }
    }

    // 加载搜索历史
    getSearchHistory().then(setSearchHistory);
    const unsubscribe = subscribeToDataUpdates('searchHistoryUpdated', setSearchHistory);
    
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (activePath) {
      setActive(activePath);
    } else {
      const queryString = searchParams.toString();
      const fullPath = queryString ? `${pathname}?${queryString}` : pathname;
      setActive(fullPath);
    }
  }, [activePath, pathname, searchParams]);

  // 同步 URL 中的搜索查询和搜索源到搜索框
  useEffect(() => {
    if (pathname === '/search') {
      const query = searchParams.get('q');
      if (query) {
        setSearchQuery(decodeURIComponent(query));
      } else {
        setSearchQuery('');
      }
      
      const sources = searchParams.get('sources');
      if (sources) {
        setSearchSources(sources.split(','));
      }
    }
  }, [pathname, searchParams]);

  const [menuItems, setMenuItems] = useState([
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
      icon: Cat,
      label: '动漫',
      href: '/douban?type=anime',
    },
    {
      icon: Clover,
      label: '综艺',
      href: '/douban?type=show',
    },
  ]);

  useEffect(() => {
    getCustomCategories().then((categories) => {
      if (categories.length > 0) {
        setMenuItems((prevItems) => [
          ...prevItems,
          {
            icon: Star,
            label: '自定义',
            href: '/douban?type=custom',
          },
        ]);
      }
    });
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery) {
      // 添加到搜索历史
      addSearchHistory(trimmedQuery);
      
      // 如果不在搜索页面，触发加载动画
      if (pathname !== '/search') {
        startLoading();
      }
      
      const params = new URLSearchParams();
      params.set('q', trimmedQuery);
      if (searchSources.length > 0) {
        params.set('sources', searchSources.join(','));
      }
      router.push(`/search?${params.toString()}`);
      setShowSuggestions(false);
      setShowHistory(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    setShowSuggestions(value.trim().length > 0);
    setShowHistory(false); // 输入时关闭历史记录
  };

  const handleSuggestionSelect = (suggestion: string) => {
    setSearchQuery(suggestion);
    setShowSuggestions(false);
    setShowHistory(false); // 选择建议时关闭历史记录
    
    // 添加到搜索历史
    addSearchHistory(suggestion);
    
    // 如果不在搜索页面，触发加载动画
    if (pathname !== '/search') {
      startLoading();
    }
    
    const params = new URLSearchParams();
    params.set('q', suggestion);
    if (searchSources.length > 0) {
      params.set('sources', searchSources.join(','));
    }
    router.push(`/search?${params.toString()}`);
  };

  const handleInputFocus = () => {
    if (searchQuery.trim().length > 0) {
      setShowSuggestions(true);
    }
    setShowHistory(false); // 聚焦输入框时关闭历史记录
  };

  const clearSearch = () => {
    setSearchQuery('');
    setShowSuggestions(false);
    searchInputRef.current?.focus();
  };

  const handleHistoryClick = (item: string) => {
    setSearchQuery(item);
    setShowHistory(false);
    
    // 添加到搜索历史（更新时间戳）
    addSearchHistory(item);
    
    // 如果不在搜索页面，触发加载动画
    if (pathname !== '/search') {
      startLoading();
    }
    
    const params = new URLSearchParams();
    params.set('q', item);
    if (searchSources.length > 0) {
      params.set('sources', searchSources.join(','));
    }
    router.push(`/search?${params.toString()}`);
  };

  const handleDeleteHistory = async (item: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSearchHistory(item);
  };

  const handleClearAllHistory = async () => {
    await clearSearchHistory();
    setShowHistory(false);
  };

  // 点击外部关闭历史弹窗
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        showHistory &&
        historyPopupRef.current &&
        historyButtonRef.current &&
        !historyPopupRef.current.contains(event.target as Node) &&
        !historyButtonRef.current.contains(event.target as Node)
      ) {
        setShowHistory(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showHistory]);

  return (
    <header className='hidden md:block sticky top-0 z-50 w-full bg-white/80 backdrop-blur-xl border-b border-gray-200/50 shadow-sm dark:bg-gray-900/80 dark:border-gray-700/50'>
      <div className='mx-auto px-6 h-16 flex items-center justify-between gap-6'>
        {/* Logo */}
        <Link
          href='/'
          className='flex items-center justify-center select-none hover:opacity-80 transition-opacity duration-200 flex-shrink-0'
          onClick={() => {
            if (active !== '/') {
              startLoading();
            }
          }}
        >
          <span className='text-2xl font-bold text-green-600 tracking-tight'>
            {siteName}
          </span>
        </Link>

        {/* 导航菜单 */}
        <nav className='flex items-center gap-1 flex-shrink-0'>
        <Link
          href='/'
          onClick={() => {
            if (active !== '/') {
              startLoading();
            }
            setActive('/');
          }}
          data-active={active === '/'}
          className='group flex items-center gap-2 px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100/50 hover:text-green-600 data-[active=true]:bg-green-500/10 data-[active=true]:text-green-600 font-medium transition-colors duration-200 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700/50 dark:data-[active=true]:bg-green-500/10 dark:data-[active=true]:text-green-400'
        >
          <Home className='h-4 w-4' />
          <span>首页</span>
        </Link>

          {isClient && !simpleMode && menuItems.map((item) => {
            const typeMatch = item.href.match(/type=([^&]+)/)?.[1];
            const decodedActive = decodeURIComponent(active);
            const decodedItemHref = decodeURIComponent(item.href);
            const isActive =
              decodedActive === decodedItemHref ||
              (decodedActive.startsWith('/douban') &&
                decodedActive.includes(`type=${typeMatch}`));
            const Icon = item.icon;

            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => {
                  if (!isActive) {
                    startLoading();
                  }
                  setActive(item.href);
                }}
                data-active={isActive}
                className='group flex items-center gap-2 px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100/50 hover:text-green-600 data-[active=true]:bg-green-500/10 data-[active=true]:text-green-600 font-medium transition-colors duration-200 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700/50 dark:data-[active=true]:bg-green-500/10 dark:data-[active=true]:text-green-400'
              >
                <Icon className='h-4 w-4' />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* 搜索栏 */}
        <div className='flex-1 max-w-md flex items-center'>
          {/* 搜索源选择器 */}
          <div className='flex-shrink-0'>
            <SourceSelector
              selectedSources={searchSources}
              onChange={setSearchSources}
              openFilter={openFilter}
              setOpenFilter={setOpenFilter}
              size='compact'
            />
          </div>

          {/* 搜索框 */}
          <div className='relative flex-1'>
            <form onSubmit={handleSearch} className='relative'>
              <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
              <input
                ref={searchInputRef}
                type='text'
                value={searchQuery}
                onChange={handleInputChange}
                onFocus={handleInputFocus}
                placeholder='搜索电影、电视剧...'
                className='w-full h-10 rounded-r-lg rounded-l-none bg-gray-100/80 py-2 pl-10 pr-20 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-400 focus:bg-white transition-all duration-200 border border-gray-200/50 border-l-0 dark:bg-gray-800 dark:text-gray-300 dark:placeholder-gray-500 dark:focus:bg-gray-700 dark:border-gray-700'
              />
              <div className='absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1'>
                {searchQuery && (
                  <button
                    type='button'
                    onClick={clearSearch}
                    className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <X className='h-4 w-4' />
                  </button>
                )}
                {/* 历史记录按钮 */}
                <button
                  ref={historyButtonRef}
                  type='button'
                  onClick={() => setShowHistory(!showHistory)}
                  className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors relative'
                  title='搜索历史'
                >
                  <History className='h-4 w-4' />
                  {searchHistory.length > 0 && (
                    <span className='absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full'></span>
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

            {/* 历史记录弹窗 */}
            {showHistory && searchHistory.length > 0 && (
              <div
                ref={historyPopupRef}
                className='absolute top-full right-0 mt-2 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-96 overflow-y-auto z-50'
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
                  {searchHistory.map((item, index) => (
                    <div
                      key={`history-${item}-${index}`}
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

        {/* 右侧按钮组 */}
        <div className='flex items-center gap-2 flex-shrink-0'>
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
};

export default TopNav;

