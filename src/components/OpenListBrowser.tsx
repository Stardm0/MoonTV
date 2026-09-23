/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

'use client';

import { ArrowLeft, Folder, HardDrive, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildLibraryImageUrl,
  isImageFile,
  pickCoverFromItems,
} from '@/lib/library-image';
import {
  type MediaLibrarySummary,
  MEDIA_LIBRARY_TYPE_LABELS,
} from '@/lib/media-library';
import {
  type OpenListConfig,
  type OpenListItem,
  clearOpenListConfigCookie,
  getFileExtension,
  isVideoFile,
  joinOpenListPath,
  readOpenListConfigFromCookie,
  sortOpenListItems,
  writeOpenListConfigToCookie,
} from '@/lib/openlist';

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

function formatSize(size: number): string {
  if (!size || size < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 列表行的小海报。
 *
 * 图片走 `/api/library-image` 代理而不是直连：站点级影库配置下浏览器根本拿不到
 * 影库地址与令牌。加载失败（影库没这图 / 不是图片）就退回文件夹图标，
 * 不让列表里出现破图。
 */
const RowThumb = ({ src, isDir }: { src: string; isDir: boolean }) => {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <Folder
        className={`h-4 w-4 flex-shrink-0 ${
          isDir ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600'
        }`}
      />
    );
  }

  return (
    // 影库图片是同源代理地址且尺寸不可控，用原生 img 而不是 next/image
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=''
      loading='lazy'
      onError={() => setFailed(true)}
      className='h-10 w-7 flex-shrink-0 rounded object-cover'
    />
  );
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
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /**
   * 连接来源：**个人 cookie 优先，管理员站点级配置兜底**。
   *
   * 个人配置优先是为了不让人已有的影库被管理员新加的配置悄悄顶掉；
   * 没配过的人才自动用后台那份（家庭/小团队场景里这是最常见的用法）。
   */
  useEffect(() => {
    let cancelled = false;

    const saved = readOpenListConfigFromCookie();
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

    // 只取摘要：后台那份的令牌与地址不会下发到浏览器
    fetch('/api/server-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const summary = (data?.MediaLibrary ?? null) as MediaLibrarySummary | null;
        setServerSummary(summary);
        if (summary?.Enabled) {
          setConfig(SERVER_LIBRARY_PLACEHOLDER);
          setSource('server');
          setPath('/');
        }
      })
      .catch(() => {
        // 拿不到就当没有站点级影库，用户仍可自己填
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const callOpenList = useCallback(
    async (action: 'me' | 'list' | 'get', baseUrl: string, token: string, target: string, allowPrivateNetwork: boolean) => {
      const response = await fetch('/api/openlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, baseUrl, token, path: target, allowPrivateNetwork }),
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
      try {
        const payload = await callOpenList(
          'list',
          cfg.baseUrl,
          cfg.token,
          target,
          cfg.allowPrivateNetwork === true
        );
        const content = (payload?.data?.content ?? []) as OpenListItem[];
        setItems(
          sortOpenListItems(
            content.filter((item) => item && typeof item.name === 'string')
          )
        );
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

  const goUp = () => {
    const parent = `/${segments.slice(0, -1).join('/')}`;
    if (config) loadDir(config, parent === '' ? '/' : parent);
  };

  const gotoSegment = (index: number) => {
    if (!config) return;
    loadDir(config, `/${segments.slice(0, index + 1).join('/')}`);
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
            className='rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-600'
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
          {source !== 'none' && (
            <button
              type='button'
              onClick={() => loadDir(config ?? SERVER_LIBRARY_PLACEHOLDER, path)}
              className='flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
            >
              <RefreshCw className='h-3.5 w-3.5' />
              刷新
            </button>
          )}
        </div>
        {notice && (
          <p className='mt-2 text-xs text-green-600 dark:text-green-400'>{notice}</p>
        )}
        {error && (
          <p className='mt-2 text-xs text-red-500 dark:text-red-400'>{error}</p>
        )}
        {source === 'server' && (
          <p className='mt-3 text-xs text-green-600 dark:text-green-400'>
            当前用的是管理员在后台配置的影库。想在自己这个浏览器上换一个影库，
            填上面的表单保存即可覆盖。
          </p>
        )}
        {source === 'none' && (
          <p className='mt-3 text-xs text-gray-500 dark:text-gray-400'>
            还没搭影库？先在服务器或 NAS 上装 OpenList，再用 Cloudflare Tunnel
            暴露成 HTTPS 地址（免公网 IP）。填地址和令牌后即可在这里浏览与播放；
            管理员也可以在后台配一份，全站用户自动可用。
          </p>
        )}
      </section>

      {source !== 'none' && (
        <>
          <div className='mb-3 flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400'>
            <button
              type='button'
              onClick={goUp}
              disabled={segments.length === 0}
              className='flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800'
            >
              <ArrowLeft className='h-4 w-4' />
              上级
            </button>
            <button
              type='button'
              onClick={() => config && loadDir(config, '/')}
              className='rounded-lg px-2 py-1 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800'
            >
              根目录
            </button>
            {segments.map((segment, index) => (
              <span key={`${segment}-${index}`} className='flex items-center'>
                <span className='px-1 text-gray-300 dark:text-gray-600'>/</span>
                <button
                  type='button'
                  onClick={() => gotoSegment(index)}
                  className='rounded-lg px-2 py-1 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800'
                >
                  {segment}
                </button>
              </span>
            ))}
          </div>

          {loading ? (
            <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
              正在读取影库…
            </p>
          ) : items.length === 0 ? (
            <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
              这个目录是空的，或者影库拒绝了访问
            </p>
          ) : (
            <ul className='divide-y divide-gray-200/70 rounded-xl border border-gray-200/70 dark:divide-gray-700/60 dark:border-gray-700/60'>
              {items.map((item) => {
                const fullPath = joinOpenListPath(path, item.name);
                const video = !item.is_dir && isVideoFile(item.name);
                return (
                  <li
                    key={fullPath}
                    className='flex items-center gap-3 px-4 py-2.5 text-sm'
                  >
                    <RowThumb src={thumbFor(item)} isDir={item.is_dir} />
                    <span className='min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200'>
                      {item.name}
                      {!item.is_dir && (
                        <span className='ml-2 text-xs text-gray-400'>
                          {formatSize(item.size)}
                          {getFileExtension(item.name)
                            ? ` · ${getFileExtension(item.name)}`
                            : ''}
                        </span>
                      )}
                    </span>
                    {item.is_dir ? (
                      <>
                        <button
                          type='button'
                          onClick={() =>
                            loadDir(
                              config ?? SERVER_LIBRARY_PLACEHOLDER,
                              fullPath
                            )
                          }
                          className='rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                        >
                          进入
                        </button>
                        <button
                          type='button'
                          onClick={() => openDirAsSeries(item)}
                          className='flex items-center gap-1 rounded-lg bg-green-500/10 px-2 py-1 text-xs text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400'
                          title='把目录里的视频按集数顺序排成选集播放'
                        >
                          <Play className='h-3 w-3' />
                          按剧集播放
                        </button>
                      </>
                    ) : video ? (
                      <button
                        type='button'
                        onClick={() => openVideo(item)}
                        className='flex items-center gap-1 rounded-lg bg-green-500/10 px-2 py-1 text-xs text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400'
                      >
                        <Play className='h-3 w-3' />
                        播放
                      </button>
                    ) : (
                      <span className='text-xs text-gray-300 dark:text-gray-600'>
                        不支持
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default OpenListBrowser;
