/**
 * OpenList（AList 分支）私人影库适配层。
 *
 * ## 为什么要走服务端转发
 *
 * OpenList 的 API 需要 `Authorization: <token>` 请求头。浏览器直连的话：
 *   - 跨域（CORS）是否放行取决于对方部署，不可控；
 *   - 网盘直链常带过期签名，且混在页面里请求容易被各家网盘风控。
 * 所以统一走本站的 `/api/openlist` 转发——**同源、无 CORS 问题、token 不进 URL**。
 *
 * ## 部署无关
 *
 * 本模块只用 `fetch`，不碰任何 Node API，因此 Cloudflare Pages / Vercel /
 * Docker 自建都能跑。唯一的部署差异是「能不能访问局域网」：
 *   - 托管环境（Cloudflare/Vercel）访问不到你家 NAS，影库必须是公网 HTTPS；
 *   - 自建（Docker / 同网段）可以访问内网地址，但需要用户在设置里显式勾选
 *     `allowPrivateNetwork`（见 `url-guard.ts` 的同名选项，默认关闭）。
 *
 * ## 纯函数传统
 *
 * 路径拼接、视频识别、集数排序等全部是无副作用纯函数，配 `*.test.ts` 单测；
 * 只有 cookie 读写会碰 `document`，调用方需自行保证在浏览器环境。
 */

import type { SearchResult } from './types';
import { validateMediaUrl } from './url-guard';

/** 影库结果在搜索/播放链路里的来源代号，必须与 `/api/detail`、`/api/search` 一致 */
export const OPENLIST_SOURCE = 'openlist';

/** 影库结果对外展示的来源名 */
export const OPENLIST_SOURCE_NAME = '私人影库';

/** 影库连接配置（存浏览器 cookie，token 不入 localStorage 以免被脚本扫到） */
export interface OpenListConfig {
  /** OpenList 站点地址，如 `https://openlist.example.com` */
  baseUrl: string;
  /** 后台「设置 → 其他 → Token」生成的长期令牌 */
  token: string;
  /** 浏览根路径，默认 `/` */
  rootPath?: string;
  /** 自建部署访问局域网影库时显式开启（默认 false） */
  allowPrivateNetwork?: boolean;
}

/** OpenList 目录项（`POST /api/fs/list` 返回的 content 元素） */
export interface OpenListItem {
  name: string;
  size: number;
  is_dir: boolean;
  modified?: string;
  /** 直链签名，用于拼 `/d/<path>?sign=...` */
  sign?: string;
  thumb?: string;
  type?: number;
}

/** `POST /api/fs/list` 的响应体 */
export interface OpenListListResult {
  content: OpenListItem[];
  total: number;
}

/**
 * `POST /api/fs/get` 的响应体。
 * `raw_url` 是网盘直链（有过期时间），`sign` 用于拼本站可访问的 `/d/` 路径。
 */
export interface OpenListGetResult extends OpenListItem {
  raw_url?: string;
  provider?: string;
  readme?: string;
}

/** 影库连接配置在 cookie 中的键 */
export const OPENLIST_COOKIE_KEY = 'moontv_openlist';

/** 支持的 OpenList 只读动作（search 需要影库已建立索引） */
export const OPENLIST_ACTIONS = ['me', 'list', 'get', 'search'] as const;

/** 只读动作类型（校验用，防止路由把任意字符串传进来） */
export type OpenListAction = (typeof OPENLIST_ACTIONS)[number];

export function isOpenListAction(value: unknown): value is OpenListAction {
  return (
    typeof value === 'string' &&
    (OPENLIST_ACTIONS as readonly string[]).includes(value)
  );
}

/** OpenList 只读动作与端点映射 */
const ACTION_ENDPOINTS: Record<
  OpenListAction,
  { path: string; method: 'GET' | 'POST' }
> = {
  me: { path: '/api/me', method: 'GET' },
  list: { path: '/api/fs/list', method: 'POST' },
  get: { path: '/api/fs/get', method: 'POST' },
  search: { path: '/api/fs/search', method: 'POST' },
};

/** 单次影库请求超时（网盘冷启动可能很慢，但再长就会拖住页面） */
const REQUEST_TIMEOUT_MS = 10_000;

/** 影库搜索一次最多取多少条（再多对搜索页也没意义，只会拖慢响应） */
const SEARCH_PAGE_SIZE = 40;

export interface OpenListRequestResult<T = any> {
  ok: boolean;
  status?: number;
  error?: string;
  data?: T;
}

/**
 * 构造 OpenList 请求体。
 *
 * 搜索与列目录的参数不同：搜索需要 `keyword` 与分页，其余只要 `path`。
 * 空 path 一律归一到 `/`——OpenList 收到空串会报「路径不存在」。
 */
export function buildOpenListBody(
  action: OpenListAction,
  path: string,
  keyword?: string
): Record<string, unknown> {
  const target = path || '/';
  if (action === 'search') {
    return {
      path: target,
      keyword: keyword ?? '',
      /** OpenList 的 scope 用字符串枚举，`0` = 不限范围 */
      scope: '0',
      page: 1,
      per_page: SEARCH_PAGE_SIZE,
    };
  }
  return { path: target, password: '' };
}

/**
 * 服务端调用 OpenList API（只读动作）。
 *
 * 只依赖 `fetch` 与 `AbortController`，edge / node 运行时都能跑。
 * 目标地址先过 `validateMediaUrl`：内网默认拒绝，需 `allowPrivateNetwork`
 * 显式放行（自建部署访问同网段影库）。
 */
export async function requestOpenList<T = any>(
  config: OpenListConfig,
  action: OpenListAction,
  path = '/',
  keyword?: string
): Promise<OpenListRequestResult<T>> {
  const endpoint = ACTION_ENDPOINTS[action];
  if (!endpoint) {
    return { ok: false, status: 400, error: '不支持的操作' };
  }

  const base = normalizeBaseUrl(config?.baseUrl ?? '');
  if (!base) {
    return { ok: false, status: 400, error: '缺少影库地址' };
  }

  const guard = validateMediaUrl(base, undefined, {
    allowPrivateNetwork: config?.allowPrivateNetwork === true,
  });
  if (!guard.ok) {
    return { ok: false, status: 403, error: guard.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // 未填 token 时不带头，交由 OpenList 的访客模式决定可见范围
    if (config?.token) headers.Authorization = config.token;

    const response = await fetch(`${base}${endpoint.path}`, {
      method: endpoint.method,
      headers,
      body:
        endpoint.method === 'POST'
          ? JSON.stringify(buildOpenListBody(action, path, keyword))
          : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }

    if (!response.ok) {
      return { ok: false, status: 502, error: '影库返回错误', data };
    }
    return { ok: true, data };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted ? '连接影库超时' : '无法连接影库',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 常见视频扩展名（网盘影库里实际会遇到的） */
const VIDEO_EXTENSIONS = [
  'mp4',
  'mkv',
  'webm',
  'avi',
  'mov',
  'm2ts',
  'ts',
  'flv',
  'rmvb',
  'rm',
  'wmv',
  'mpg',
  'mpeg',
  'm4v',
  'iso',
];

/** 字幕扩展名（M1 只识别、不处理，留作后续挂载字幕用） */
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt', 'sub'];

/**
 * 取文件扩展名（小写，不含点）。
 * 无扩展名、或是点开头的隐藏文件（`.nomedia`）都返回空串。
 */
export function getFileExtension(name: string): string {
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 是否为可播放的视频文件 */
export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(getFileExtension(name));
}

/** 是否为字幕文件 */
export function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTENSIONS.includes(getFileExtension(name));
}

/** 是否为「看起来是媒体资源」的目录项（视频文件，或可能装剧集的目录） */
export function isMediaItem(item: Pick<OpenListItem, 'name' | 'is_dir'>): boolean {
  return item.is_dir || isVideoFile(item.name);
}

/**
 * 网盘里的系统/杂项目录（回收站、缩略图缓存、Windows 挂载残留），
 * 递归展开「按剧集播放」时要跳过，否则会混进一堆非媒体内容。
 */
export function isOpenListSystemDir(name: string): boolean {
  const value = String(name ?? '');
  return (
    value.startsWith('.') ||
    value.startsWith('$') ||
    /^#recycle$/i.test(value) ||
    /^#回收站$/.test(value) ||
    /^recycle$/i.test(value) ||
    /^System Volume Information$/i.test(value)
  );
}

/**
 * 计算文件相对播放目录的路径，用作摊平后的选集标题。
 *
 * 目录里套季/子文件夹时，选集标题要能看出结构（`第一季/E01.mkv`）；
 * 路径不在播放目录之下时退回文件名本身。
 */
export function relativeOpenListPath(fullPath: string, rootPath: string): string {
  const fullSegments = String(fullPath ?? '')
    .split('/')
    .filter(Boolean);
  const rootSegments = String(rootPath ?? '')
    .split('/')
    .filter(Boolean);
  const fallback = fullSegments[fullSegments.length - 1] ?? '';
  // 播放目录就是根（`/`，空段）：整个路径都是相对路径
  if (!rootSegments.length) {
    return fullSegments.join('/') || fallback;
  }
  if (fullSegments.length <= rootSegments.length) {
    return fallback;
  }
  for (let i = 0; i < rootSegments.length; i++) {
    if (fullSegments[i] !== rootSegments[i]) return fallback;
  }
  return fullSegments.slice(rootSegments.length).join('/') || fallback;
}

/**
 * 规范化 OpenList 站点地址。
 *
 * - 去首尾空白与结尾斜杠（拼路径时统一由 `joinOpenListPath` 补）
 * - 没写协议时默认补 `https://`——页面是 HTTPS，影库再给 http 会被浏览器
 *   按混合内容拦掉，所以默认给安全协议
 * - 空串返回空串，由调用方判「未配置」
 */
export function normalizeBaseUrl(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

/**
 * 拼接 OpenList 虚拟路径。
 *
 * 根目录用 `/` 表示；子路径一律带前导斜杠、不留重复斜杠。
 * 名字里的空串直接忽略，避免拼出 `//`。
 */
export function joinOpenListPath(parent: string, name: string): string {
  const segments = `${parent ?? ''}/${name ?? ''}`
    .split('/')
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/**
 * 自然序比较（数字按数值比，而不是按字典序）。
 *
 * 剧集文件名必须用它：`S1E2` 要排在 `S1E10` 前面，字典序会反过来。
 */
export function naturalCompare(a: string, b: string): number {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const lc = left[i];
    const rc = right[j];

    if (lc >= '0' && lc <= '9' && rc >= '0' && rc <= '9') {
      let ni = i;
      let nj = j;
      while (ni < left.length && left[ni] >= '0' && left[ni] <= '9') ni++;
      while (nj < right.length && right[nj] >= '0' && right[nj] <= '9') nj++;
      const ln = Number(left.slice(i, ni));
      const rn = Number(right.slice(j, nj));
      const cmp = ln === rn ? ni - nj : ln - rn;
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
      i = ni;
      j = nj;
      continue;
    }

    if (lc !== rc) {
      return lc.toLowerCase() < rc.toLowerCase() ? -1 : 1;
    }
    i++;
    j++;
  }

  return left.length - right.length;
}

/**
 * 目录项排序：目录在前，同类之内按自然序。
 *
 * 不改原数组（返回新数组），方便在渲染/测试里断言。
 */
export function sortOpenListItems<T extends OpenListItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return naturalCompare(a.name, b.name);
  });
}

/** 路径逐段编码但保留 `/`（OpenList 的 `/d/<path>` 要求这样） */
export function encodeOpenListPath(path: string): string {
  return (path ?? '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * 拼可直接播放的 `/d/` 地址。
 *
 * 优先用网盘直链 `raw_url`（速度最好），没有直链时退回 OpenList 的
 * `/d/<path>?sign=...`（带签名，浏览器可直接取，无需 token）。
 * 直链有过期时间，所以**只在真正要播的时候才取**，别在列表里长期缓存。
 */
export function buildPlayableUrl(
  baseUrl: string,
  path: string,
  sign?: string,
  rawUrl?: string
): string {
  if (rawUrl) return rawUrl;
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  const encoded = encodeOpenListPath(path);
  return sign ? `${base}/d${encoded}?sign=${sign}` : `${base}/d${encoded}`;
}

/**
 * 去掉文件名尾部的扩展名。
 *
 * 影库里搜出来的条目是文件名（`xxx.2024.mkv`），直接当标题会带后缀。
 * 不改动没有扩展名的名字（目录名、无后缀文件）。
 */
export function stripFileExtension(name: string): string {
  const value = String(name ?? '');
  const ext = getFileExtension(value);
  if (!ext) return value;
  return value.slice(0, -(ext.length + 1));
}

/** 分辨率片段（`1920x1080` / `4K`）：先去掉再找年份，否则 `1920` 会被当成年份 */
const RESOLUTION_PATTERN = /\d{3,4}\s*[x×*]\s*\d{3,4}/gi;

/** 年份片段：19xx / 20xx，且两侧不能再接数字（`20241` 不算） */
const YEAR_PATTERN = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g;

/**
 * 从文件/目录名里猜年份，猜不到返回空串。
 *
 * 影库文件名常带年份（`xxx.2024.1080p.mkv`），用它填 `SearchResult.year`，
 * 搜索页的聚合与筛选才能和 Apple CMS 的结果对齐。
 * 注意用 `exec` 循环而不是 `matchAll`——后者在 TS 下会触发 TS2802。
 */
export function extractYearFromName(name: string): string {
  const cleaned = String(name ?? '').replace(RESOLUTION_PATTERN, ' ');
  const re = new RegExp(YEAR_PATTERN.source, 'g');
  let match = re.exec(cleaned);
  while (match) {
    const year = match[1];
    if (year) return year;
    match = re.exec(cleaned);
  }
  return '';
}

/**
 * 归一根路径。
 *
 * 用户可能填 `/media`、`/media/`、`media` 甚至空串，统一成带前导斜杠、
 * 无尾斜杠的标准形（空串按 `/` 处理），路径比较才有唯一基准。
 */
export function normalizeRootPath(rootPath?: string): string {
  const segments = String(rootPath ?? '')
    .split('/')
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/**
 * 从当前浏览路径里解析出「所在的网盘（挂载源）」名字。
 *
 * OpenList 常把多个网盘挂在根目录下（`/阿里云盘`、`/夸克网盘`…），
 * 根路径之下的第一段就是网盘名；还在根目录（或路径不在根之下）时返回空串。
 */
export function getDriveNameFromPath(path: string, rootPath?: string): string {
  const rootSegments = normalizeRootPath(rootPath)
    .split('/')
    .filter(Boolean);
  const pathSegments = String(path ?? '')
    .split('/')
    .filter(Boolean);

  // 路径必须真的落在根路径之下（逐段比对，`/media` 不匹配 `/mediax`）
  if (pathSegments.length <= rootSegments.length) return '';
  for (let i = 0; i < rootSegments.length; i++) {
    if (pathSegments[i] !== rootSegments[i]) return '';
  }
  return pathSegments[rootSegments.length];
}

/** 拼某个网盘的浏览入口路径（网盘名不允许含斜杠，含则视为非法返回空串） */
export function buildDrivePath(rootPath: string, driveName: string): string {
  const name = String(driveName ?? '').trim();
  if (!name || name.includes('/')) return '';
  return joinOpenListPath(normalizeRootPath(rootPath), name);
}

/**
 * 还原搜索结果条目的完整路径。
 *
 * OpenList 的搜索结果里条目只带文件名，所在目录放在 `parent` 字段；
 * 老版本 / AList 可能不给 `parent`，那就退回搜索时指定的根路径。
 */
export function resolveOpenListEntryPath(
  item: { name?: unknown; parent?: unknown },
  fallbackParent = '/'
): string {
  const parent =
    typeof item?.parent === 'string' && item.parent.trim()
      ? item.parent
      : fallbackParent;
  return joinOpenListPath(parent, typeof item?.name === 'string' ? item.name : '');
}

/** 单文件在搜索结果里的占位集数：长度为 1 → 搜索页按「电影」聚合 */
const SINGLE_EPISODE_PLACEHOLDER = [''];

/**
 * 把影库搜索结果映射成 `SearchResult`，与 Apple CMS 的结果混排。
 *
 * - 目录 → 视为剧集（集数留给播放页按目录展开，这里给空数组 → 按「剧」聚合）
 * - 视频文件 → 视为单集影片（占位 `['']`，长度 1 → 按「影」聚合）
 * - 非视频文件（字幕/nfo/图片）直接丢弃
 *
 * ⚠️ 这里的 `episodes` 只用于列表聚合，不含真实播放地址：播放页会自己
 * 调 `/api/detail?source=openlist&id=<路径>` 现取（直链有过期时间）。
 */
export function mapOpenListSearchItems(
  items: unknown,
  fallbackParent = '/'
): SearchResult[] {
  if (!Array.isArray(items)) return [];

  const results: SearchResult[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) continue;

    const isDir = item.is_dir === true;
    if (!isDir && !isVideoFile(name)) continue;

    const fullPath = resolveOpenListEntryPath(item, fallbackParent);
    const title = isDir ? name : stripFileExtension(name);
    const year = extractYearFromName(name);

    results.push({
      id: fullPath,
      title,
      poster: typeof item.thumb === 'string' ? item.thumb : '',
      episodes: isDir ? [] : [...SINGLE_EPISODE_PLACEHOLDER],
      episodes_titles: [],
      source: OPENLIST_SOURCE,
      source_name: OPENLIST_SOURCE_NAME,
      class: isDir ? '剧集' : '影片',
      year,
      desc: isDir ? `影库目录：${fullPath}` : `影库文件：${fullPath}`,
      type_name: isDir ? '剧集' : '影片',
    });
  }
  return results;
}

/**
 * 从服务端请求的 `Cookie` 头里解析影库连接配置。
 *
 * 播放页走的是 `/api/detail?source=openlist&id=<路径>`，服务端路由读不到
 * localStorage，只能读 cookie——这也是连接配置存 cookie 而非 localStorage 的原因。
 */
export function parseOpenListConfigFromCookieHeader(
  cookieHeader: string | null | undefined
): OpenListConfig | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${OPENLIST_COOKIE_KEY}=`));
  if (!match) return null;
  return decodeOpenListConfig(
    decodeURIComponent(match.slice(OPENLIST_COOKIE_KEY.length + 1))
  );
}

/** 把序列化的连接配置还原成对象（格式不对一律返回 null） */
function decodeOpenListConfig(raw: string): OpenListConfig | null {
  try {
    const parsed = JSON.parse(raw) as OpenListConfig;
    if (!parsed || typeof parsed.baseUrl !== 'string') return null;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      token: typeof parsed.token === 'string' ? parsed.token : '',
      rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : '/',
      allowPrivateNetwork: parsed.allowPrivateNetwork === true,
    };
  } catch {
    // cookie 损坏/被手改过时按未配置处理
    return null;
  }
}

/** 从 cookie 读取影库连接配置（非浏览器环境返回 null） */
export function readOpenListConfigFromCookie(): OpenListConfig | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${OPENLIST_COOKIE_KEY}=`));
  if (!match) return null;
  return decodeOpenListConfig(
    decodeURIComponent(match.slice(OPENLIST_COOKIE_KEY.length + 1))
  );
}

/**
 * 把连接配置写进 cookie。
 *
 * 用 cookie 而不是 localStorage，是因为播放页走 `/api/detail?source=openlist`，
 * 服务端路由读不到 localStorage，只能读 cookie。
 * 不设 httpOnly（需要由前端写入），因此只存「影库地址 + token」这一份，
 * 不存任何本站账号信息。
 */
export function writeOpenListConfigToCookie(config: OpenListConfig): void {
  if (typeof document === 'undefined') return;
  const payload: OpenListConfig = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    token: config.token ?? '',
    rootPath: config.rootPath || '/',
    allowPrivateNetwork: config.allowPrivateNetwork === true,
  };
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  document.cookie = `${OPENLIST_COOKIE_KEY}=${encodeURIComponent(
    JSON.stringify(payload)
  )}; path=/; max-age=${60 * 60 * 24 * 180}; samesite=lax${
    secure ? '; secure' : ''
  }`;
}

/** 清除影库连接配置 */
export function clearOpenListConfigCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${OPENLIST_COOKIE_KEY}=; path=/; max-age=0; samesite=lax`;
}
