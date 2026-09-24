/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

'use client';

import { Folder, HardDrive, Play, Search, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatFileSize } from '@/lib/file-size';
import {
  buildLibraryImageUrl,
  isImageFile,
  pickCoverFromItems,
} from '@/lib/library-image';
import {
  type LibraryView,
  readLibraryView,
  writeLibraryView,
} from '@/lib/library-view';
import {
  type MediaLibrarySummary,
  MEDIA_LIBRARY_TYPE_LABELS,
} from '@/lib/media-library';
import {
  type OpenListConfig,
  type OpenListItem,
  type OpenListSearchEntry,
  buildDrivePath,
  clearOpenListConfigCookie,
  getDriveNameFromPath,
  isVideoFile,
  joinOpenListPath,
  mapOpenListSearchEntries,
  normalizeRootPath,
  readOpenListConfigFromCookie,
  sortOpenListItems,
  stripFileExtension,
  writeOpenListConfigToCookie,
} from '@/lib/openlist';

import DriveSidebar from '@/components/library/DriveSidebar';
import LibraryItems from '@/components/library/LibraryItems';
import LibraryToolbar from '@/components/library/LibraryToolbar';

/** 播放页来源代号，必须与 `/api/detail` 里的分支一致 */
const OPENLIST_SOURCE = 'openlist';

/**
 * 连的是哪份配置：
 * - `personal` 浏览器 cookie 里自己填的影库
 * - `server` 管理员在后台配的站点级影库（令牌不下发浏览器，请求不带地址由服务端补）
 * - `none` 都没配
 */
type LibrarySource = 'none' | 'personal' | 'server';

/** 服务端影库模式下交给 `/api/openlist` 的空壳配置（地址与令牌由服务端补） */
const SERVER_LIBRARY_PLACEHOLDER: OpenListConfig = {
  baseUrl: '',
  token: '',
  rootPath: '/',
  allowPrivateNetwork: false,
};

/**
 * 私人影库浏览器（OpenList）。
 *
 * ## 部署无关
 *
 * 所有请求都走本站 `/api/openlist` 转发，不直连影库：
 *   - Cloudflare / Vercel：影库需公网 HTTPS（浏览器与边缘函数都得到达）
 *   - Docker 自建 / 同网段：可勾选「局域网地址」访问内网影库
 * 连接配置存 cookie，因此刷新、跨页面、以及服务端 `/api/detail` 都能读到。
 */
const OpenListBrowser = () => {
  const router = useRouter();

  const [config, setConfig] = useState<OpenListConfig | null>(null);
  const [source, setSource] = useState<LibrarySource>('none');
  const [serverSummary, setServerSummary] =
    useState<MediaLibrarySummary | null>(null);
  const [form, setForm] = useState({
    baseUrl: '',
    token: '',
    rootPath: '/',
    allowPrivateNetwork: false,
  });
  const [path, setPath] = useState('/');
  const [items, setItems] = useState<OpenListItem[]>([]);
  /** 根目录（或配置的根路径）下的目录列表，即「挂载的网盘」，供列表展示与快速切换 */
  const [rootItems, setRootItems] = useState<OpenListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** 影库内搜索：null = 没在搜索（显示目录浏览），数组 = 搜索结果 */
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] =
    useState<OpenListSearchEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  /** 查看方式（列表 / 小中大图标），存 localStorage */
  const [view, setView] = useState<LibraryView>('list');
  /** 单击选中的条目名（只高亮，不跳转） */
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * 连接来源：**个人 cookie 优先，管理员站点级配置兜底**。
   *
   * 个人配置优先是为了不让人已有的影库被管理员新加的配置悄悄顶掉；
   * 没配过的人才自动用后台那份（家庭/小团队场景里这是最常见的用法）。
   *
   * ⚠️ 4.3.12：管理员可以把这条优先级关掉（`AllowPersonalOverride: false`），
   * 关掉后**先读摘要再决定要不要看 cookie**——所以必须先等 `/api/server-config`，
   * 不能像以前那样直接同步读 cookie 就 return。
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 只取摘要：后台那份的令牌与地址不会下发到浏览器
      let summary: MediaLibrarySummary | null = null;
      try {
        const res = await fetch('/api/server-config');
        const data = res.ok ? await res.json() : null;
        summary = (data?.MediaLibrary ?? null) as MediaLibrarySummary | null;
      } catch {
        // 拿不到就当没有站点级影库，用户仍可自己填
      }
      if (cancelled) return;
      setServerSummary(summary);

      // 覆盖被管理员关掉时，本浏览器里的个人配置一律不生效
      const allowOverride = summary?.AllowPersonalOverride !== false;
      const saved = allowOverride ? readOpenListConfigFromCookie() : null;

      // 查看方式是纯本地偏好，与服务端的影库策略无关，先读回来渲染
      setView(readLibraryView());

      if (saved?.baseUrl) {
        setConfig(saved);
        setSource('personal');
        setForm({
          baseUrl: saved.baseUrl,
          token: saved.token,
          rootPath: saved.rootPath || '/',
          allowPrivateNetwork: saved.allowPrivateNetwork === true,
        });
        setPath(saved.rootPath || '/');
        return;
      }

      if (summary?.Enabled) {
        setConfig(SERVER_LIBRARY_PLACEHOLDER);
        setSource('server');
        setPath('/');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const callOpenList = useCallback(
    async (
      action: 'me' | 'list' | 'get' | 'search',
      baseUrl: string,
      token: string,
      target: string,
      allowPrivateNetwork: boolean,
      keyword?: string
    ) => {
      const response = await fetch('/api/openlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          baseUrl,
          token,
          path: target,
          allowPrivateNetwork,
          keyword,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || '影库请求失败');
      }
      return payload;
    },
    []
  );

  const loadDir = useCallback(
    async (cfg: OpenListConfig, target: string) => {
      setLoading(true);
      setError('');
      // 浏览目录即退出搜索态，否则面包屑与结果列表会同时出现
      setSearchResults(null);
      setQuery('');
      setSelected(null);
      try {
        const payload = await callOpenList(
          'list',
          cfg.baseUrl,
          cfg.token,
          target,
          cfg.allowPrivateNetwork === true
        );
        const content = (payload?.data?.content ?? []) as OpenListItem[];
        const cleaned = content.filter(
          (item) => item && typeof item.name === 'string'
        );
        setItems(sortOpenListItems(cleaned));
        // 浏览到根路径时顺手记下挂载的网盘列表（切到深层后仍能快速切换）
        if (normalizeRootPath(target) === normalizeRootPath(cfg.rootPath || '/')) {
          setRootItems(cleaned);
        }
        setPath(target);
      } catch (err) {
        setError((err as Error).message || '读取影库目录失败');
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [callOpenList]
  );

  useEffect(() => {
    // 服务端影库模式没有本地地址，靠 `source` 而不是 `config.baseUrl` 触发
    if (source === 'none') return;
    loadDir(config ?? SERVER_LIBRARY_PLACEHOLDER, path);
    // path 变化由 loadDir 内部设置，这里只在连接来源就绪/切换时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const handleSave = async () => {
    setError('');
    setNotice('');
    if (personalOverrideBlocked) {
      setError('管理员已禁止个人影库覆盖站点级配置，此处的连接设置不会生效');
      return;
    }
    if (!form.baseUrl.trim()) {
      setError('请填写影库地址');
      return;
    }
    const next: OpenListConfig = {
      baseUrl: form.baseUrl.trim(),
      token: form.token.trim(),
      rootPath: form.rootPath.trim() || '/',
      allowPrivateNetwork: form.allowPrivateNetwork,
    };
    writeOpenListConfigToCookie(next);
    setConfig(next);
    setSource('personal');
    setNotice('已保存，正在连接影库…');
    await loadDir(next, next.rootPath || '/');
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setNotice('');
    try {
      await callOpenList(
        'me',
        form.baseUrl.trim(),
        form.token.trim(),
        '/',
        form.allowPrivateNetwork
      );
      setNotice('连接成功：影库可访问，令牌有效');
    } catch (err) {
      setError(`连接失败：${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  /**
   * 影库内搜索（走影库自己的索引，不是遍历目录）。
   *
   * ⚠️ 没建索引时 OpenList 会返回 **HTTP 200 + 业务码非 200**，
   * 所以不能只看 `response.ok`，必须自己判 `code`（与 /api/search 一致）。
   */
  const handleSearch = async () => {
    const keyword = query.trim();
    if (!keyword) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setError('');
    setNotice('');
    try {
      const cfg = config ?? SERVER_LIBRARY_PLACEHOLDER;
      const payload = await callOpenList(
        'search',
        cfg.baseUrl,
        cfg.token,
        rootPrefix,
        cfg.allowPrivateNetwork === true,
        keyword
      );
      if (payload && typeof payload.code === 'number' && payload.code !== 200) {
        setError(
          `影库搜索失败：${payload.message || '未知错误'}（需先在影库「设置 → 索引」建立索引）`
        );
        setSearchResults([]);
        return;
      }
      const entries = mapOpenListSearchEntries(
        payload?.data?.content,
        rootPrefix
      );
      setSearchResults(entries);
      if (entries.length === 0) setNotice('影库里没有匹配的条目');
    } catch (err) {
      setError((err as Error).message || '影库搜索失败');
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setSearchResults(null);
    setNotice('');
    setError('');
  };

  /** 断开个人配置：后台还有站点级影库时退回那份，否则才是真的断开 */
  const handleDisconnect = () => {
    clearOpenListConfigCookie();
    setItems([]);
    if (serverSummary?.Enabled) {
      setConfig(SERVER_LIBRARY_PLACEHOLDER);
      setSource('server');
      setPath('/');
      setNotice('已改用管理员配置的影库');
      return;
    }
    setConfig(null);
    setSource('none');
    setNotice('已断开影库连接');
  };

  /** 放弃个人配置，回到管理员配置的站点级影库 */
  const handleUseServerLibrary = () => {
    clearOpenListConfigCookie();
    setItems([]);
    setConfig(SERVER_LIBRARY_PLACEHOLDER);
    setSource('server');
    setPath('/');
    setNotice('已改用管理员配置的影库');
  };

  /** 打开文件：走 `/api/detail` 的影库分支，复用完整播放链路 */
  const openVideo = (item: OpenListItem) => {
    const fullPath = joinOpenListPath(path, item.name);
    router.push(
      `/play?source=${OPENLIST_SOURCE}&id=${encodeURIComponent(fullPath)}&title=${encodeURIComponent(item.name)}`
    );
  };

  /** 打开目录：整目录按「剧集」播放（目录内视频文件自动成选集） */
  const openDirAsSeries = (item: OpenListItem) => {
    const fullPath = joinOpenListPath(path, item.name);
    router.push(
      `/play?source=${OPENLIST_SOURCE}&id=${encodeURIComponent(fullPath)}&title=${encodeURIComponent(item.name)}`
    );
  };

  /**
   * 条目缩略图（已在该目录列表里返回的内容中挑选，**不额外请求影库**）。
   * - 图片文件：自己就是预览图
   * - 视频文件：按命名约定找同名 / `poster.jpg` 之类的封面
   * - 目录：不推断（那要进子目录才知道，成本不划算）
   */
  const thumbFor = useCallback(
    (item: OpenListItem): string => {
      if (item.is_dir) return '';
      if (isImageFile(item.name)) {
        return buildLibraryImageUrl(joinOpenListPath(path, item.name));
      }
      if (!isVideoFile(item.name)) return '';
      const cover = pickCoverFromItems(items, item.name, false);
      return cover ? buildLibraryImageUrl(joinOpenListPath(path, cover)) : '';
    },
    [items, path]
  );

  const segments = useMemo(
    () => path.split('/').filter(Boolean),
    [path]
  );

  /**
   * 浏览根路径（个人配置可能是 `/media` 这种子目录）。
   * 服务端影库模式下浏览器不知道真实根路径，占位配置的 `/` 恰好就是浏览起点。
   */
  const rootPrefix = normalizeRootPath(config?.rootPath || '/');
  const isAtRoot = path === rootPrefix;
  /** 管理员关掉了「个人影库覆盖站点级配置」：本页的个人连接表单不再生效 */
  const personalOverrideBlocked = serverSummary?.AllowPersonalOverride === false;
  /** 当前所在的网盘名（根路径之下的第一段），在根目录时为空串 */
  const currentDrive = getDriveNameFromPath(path, rootPrefix);
  /** 挂载的网盘 = 根目录里的目录项（sortOpenListItems 已保证目录在前） */
  const driveList = useMemo(
    () => rootItems.filter((item) => item.is_dir),
    [rootItems]
  );
  /** 根目录时目录已进「网盘列表」区块，普通列表只放文件，避免同一批条目出现两遍 */
  const listItems = useMemo(
    () => (isAtRoot ? items.filter((item) => !item.is_dir) : items),
    [items, isAtRoot]
  );

  const goUp = () => {
    const parent = `/${segments.slice(0, -1).join('/')}`;
    // 上一层不能越过根路径（配置了子目录根路径时 `/` 在根之外）
    const target = parent === '' || parent.length < rootPrefix.length
      ? rootPrefix
      : parent;
    if (config) loadDir(config, target);
  };

  const gotoSegment = (index: number) => {
    if (!config) return;
    loadDir(config, `/${segments.slice(0, index + 1).join('/')}`);
  };

  /** 网盘切换：左侧列点根目录（空串）或某个网盘名 */
  const switchDrive = (driveName: string) => {
    const target = driveName
      ? buildDrivePath(rootPrefix, driveName)
      : rootPrefix;
    if (target) loadDir(config ?? SERVER_LIBRARY_PLACEHOLDER, target);
  };

  /** 切换查看方式并记住（列表 / 小 / 中 / 大图标） */
  const changeView = (next: LibraryView) => {
    setView(next);
    writeLibraryView(next);
  };

  return (
    <div className='mx-auto max-w-5xl'>
      <div className='mb-6 flex items-center gap-3'>
        <HardDrive className='h-6 w-6 text-green-600 dark:text-green-400' />
        <h1 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
          私人影库
        </h1>
        {source === 'server' && (
          <span className='ml-auto rounded-full bg-green-500/10 px-2.5 py-1 text-xs text-green-600 dark:text-green-400'>
            管理员已配置
            {serverSummary?.Type
              ? `（${MEDIA_LIBRARY_TYPE_LABELS[serverSummary.Type]}）`
              : ''}
          </span>
        )}
        {source === 'personal' && (
          <span className='rounded-full bg-blue-500/10 px-2.5 py-1 text-xs text-blue-600 dark:text-blue-400'>
            个人配置（仅本浏览器）
          </span>
        )}
        {source === 'personal' && serverSummary?.Enabled && (
          <button
            type='button'
            onClick={handleUseServerLibrary}
            className='ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          >
            改用管理员配置
          </button>
        )}
        {source === 'personal' && (
          <button
            type='button'
            onClick={handleDisconnect}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-red-500 dark:text-gray-400 dark:hover:bg-gray-800 ${
              serverSummary?.Enabled ? '' : 'ml-auto'
            }`}
          >
            <Trash2 className='h-3.5 w-3.5' />
            断开连接
          </button>
        )}
      </div>

      {/* 连接设置：未配置时默认展开，已配置时折叠在下方 */}
      <section className='mb-6 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-700/60 dark:bg-gray-900/40'>
        <h2 className='mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300'>
          影库连接（OpenList / AList）
        </h2>
        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400'>
            影库地址
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder='https://openlist.example.com'
              className='rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-green-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
            />
          </label>
          <label className='flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400'>
            访问令牌（设置 → 其他 → Token）
            <input
              type='password'
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              placeholder='可留空（影库开启访客模式时）'
              className='rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-green-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
            />
          </label>
          <label className='flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400'>
            根路径
            <input
              value={form.rootPath}
              onChange={(e) => setForm({ ...form, rootPath: e.target.value })}
              placeholder='/'
              className='rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-green-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
            />
          </label>
          <label className='flex items-end gap-2 text-xs text-gray-600 dark:text-gray-400'>
            <input
              type='checkbox'
              checked={form.allowPrivateNetwork}
              onChange={(e) =>
                setForm({ ...form, allowPrivateNetwork: e.target.checked })
              }
              className='mb-2 h-4 w-4'
            />
            <span className='mb-2'>
              影库在内网（自建部署访问 192.168.x.x / NAS）
            </span>
          </label>
        </div>
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <button
            type='button'
            onClick={handleSave}
            disabled={personalOverrideBlocked}
            className='rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50'
          >
            保存并打开
          </button>
          <button
            type='button'
            onClick={handleTest}
            disabled={testing}
            className='rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {notice && (
          <p className='mt-2 text-xs text-green-600 dark:text-green-400'>{notice}</p>
        )}
        {error && (
          <p className='mt-2 text-xs text-red-500 dark:text-red-400'>{error}</p>
        )}
        {personalOverrideBlocked && (
          <p className='mt-3 text-xs text-amber-600 dark:text-amber-400'>
            管理员已禁止个人影库覆盖站点级配置：上面这份连接设置不会生效，
            全站统一使用后台配置的那份影库。
          </p>
        )}
        {source === 'server' && (
          <p className='mt-3 text-xs text-green-600 dark:text-green-400'>
            当前用的是管理员在后台配置的影库。
            {personalOverrideBlocked
              ? '管理员已禁止个人覆盖，全站统一用这份。'
              : '想在自己这个浏览器上换一个影库，填上面的表单保存即可覆盖。'}
          </p>
        )}
        {source === 'none' && (
          <p className='mt-3 text-xs text-gray-500 dark:text-gray-400'>
            还没搭影库？先在服务器或 NAS 上装 OpenList，再用 Cloudflare Tunnel
            暴露成 HTTPS 地址（免公网 IP）。填地址和令牌后即可在这里浏览与播放；
            管理员也可以在后台配一份，全站用户自动可用。
            小雅（xiaoya）就是 OpenList / AList 协议，地址直接填小雅即可。
          </p>
        )}
      </section>

      {source !== 'none' && (
        <>
          {/* 影库内搜索：走影库自己的索引，跨目录找文件，不必一层层翻 */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch();
            }}
            className='mb-3 flex items-center gap-2'
          >
            <div className='relative min-w-0 flex-1'>
              <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='在影库里搜索（需要影库已建立索引）'
                className='w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-700 outline-none focus:border-green-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
              />
            </div>
            <button
              type='submit'
              disabled={searching || !query.trim()}
              className='flex-shrink-0 rounded-xl bg-green-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {searching ? '搜索中…' : '搜索'}
            </button>
            {searchResults !== null && (
              <button
                type='button'
                onClick={clearSearch}
                className='flex flex-shrink-0 items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
              >
                <X className='h-4 w-4' />
                清除
              </button>
            )}
          </form>

          {searchResults !== null ? (
            <section className='overflow-hidden rounded-xl border border-gray-200/70 dark:border-gray-700/60'>
              <h2 className='border-b border-gray-200/70 bg-gray-50/60 px-4 py-2 text-xs font-semibold text-gray-500 dark:border-gray-700/60 dark:bg-gray-800/40 dark:text-gray-400'>
                搜索结果（{searchResults.length}）
              </h2>
              {searchResults.length === 0 ? (
                <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
                  没有匹配的条目
                </p>
              ) : (
                <ul className='divide-y divide-gray-200/70 dark:divide-gray-700/60'>
                  {searchResults.map((entry) => (
                    <li
                      key={entry.path}
                      className='flex items-center gap-3 px-4 py-2.5 text-sm'
                    >
                      {entry.isDir ? (
                        <Folder className='h-4 w-4 flex-shrink-0 text-amber-500' />
                      ) : (
                        <Play className='h-4 w-4 flex-shrink-0 text-green-500' />
                      )}
                      <span className='min-w-0 flex-1 truncate'>
                        <span className='text-gray-700 dark:text-gray-200'>
                          {entry.isDir
                            ? entry.name
                            : stripFileExtension(entry.name)}
                        </span>
                        <span className='ml-2 text-xs text-gray-400'>
                          {entry.parent}
                          {!entry.isDir && entry.size
                            ? ` · ${formatFileSize(entry.size)}`
                            : ''}
                        </span>
                      </span>
                      {entry.isDir ? (
                        <button
                          type='button'
                          onClick={() =>
                            loadDir(
                              config ?? SERVER_LIBRARY_PLACEHOLDER,
                              entry.path
                            )
                          }
                          className='rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                        >
                          进入
                        </button>
                      ) : (
                        <button
                          type='button'
                          onClick={() =>
                            router.push(
                              `/play?source=${OPENLIST_SOURCE}&id=${encodeURIComponent(entry.path)}&title=${encodeURIComponent(stripFileExtension(entry.name))}`
                            )
                          }
                          className='flex items-center gap-1 rounded-lg bg-green-500/10 px-2 py-1 text-xs text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400'
                        >
                          <Play className='h-3 w-3' />
                          播放
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <div className='flex gap-3'>
              <DriveSidebar
                drives={driveList}
                currentDrive={currentDrive}
                onSelect={switchDrive}
              />

              <div className='min-w-0 flex-1'>
                <LibraryToolbar
                  segments={segments}
                  canUp={segments.length > 0}
                  onUp={goUp}
                  onRoot={() => config && loadDir(config, rootPrefix)}
                  onSegment={gotoSegment}
                  view={view}
                  onViewChange={changeView}
                  onRefresh={() =>
                    loadDir(config ?? SERVER_LIBRARY_PLACEHOLDER, path)
                  }
                  count={listItems.length}
                />

                {loading ? (
                  <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
                    正在读取影库…
                  </p>
                ) : listItems.length === 0 ? (
                  <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
                    {isAtRoot && driveList.length > 0
                      ? '从左侧选一个网盘，或用上面的搜索框找片子'
                      : '这个目录是空的，或者影库拒绝了访问'}
                  </p>
                ) : (
                  <LibraryItems
                    view={view}
                    items={listItems}
                    selected={selected}
                    onSelect={setSelected}
                    thumbFor={thumbFor}
                    onOpenDir={(item) =>
                      loadDir(
                        config ?? SERVER_LIBRARY_PLACEHOLDER,
                        joinOpenListPath(path, item.name)
                      )
                    }
                    onPlayDir={openDirAsSeries}
                    onPlayVideo={openVideo}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default OpenListBrowser;
