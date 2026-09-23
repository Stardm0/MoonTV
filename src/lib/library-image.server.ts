/**
 * 影库封面的**服务端读取**（只可被服务端路由引用）。
 *
 * 与 `library-image.ts` 分开的原因同 `media-library.server.ts`：这里要
 * `import { getConfig }` / 发起真实网络请求，浏览器组件引用会在打包/运行时炸。
 */

import { pickCoverFromItems } from './library-image';
import {
  type OpenListConfig,
  buildPlayableUrl,
  joinOpenListPath,
  requestOpenList,
} from './openlist';
import { validateMediaUrl } from './url-guard';

/** 封面图回源超时：海报不该拖住页面列表渲染 */
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

export interface LibraryImageResult {
  ok: boolean;
  status: number;
  error?: string;
  body?: ArrayBuffer;
  contentType?: string;
}

/**
 * 读取影库里的一张图片。
 *
 * 流程：拿令牌调 `fs/get` 换直链（带签名）→ 校验该地址（内网默认拒绝）→
 * 回源取字节。全程令牌只在服务端，浏览器只看到 `/api/library-image?p=...`。
 */
export async function fetchLibraryImage(
  config: OpenListConfig,
  path: string,
  maxBytes: number
): Promise<LibraryImageResult> {
  const info = await requestOpenList(config, 'get', path);
  if (!info.ok) {
    return {
      ok: false,
      status: info.status ?? 502,
      error: info.error ?? '读取影库失败',
    };
  }

  const entry = (info.data?.data ?? {}) as Record<string, unknown>;
  if (entry?.is_dir === true) {
    return { ok: false, status: 400, error: '不是图片文件' };
  }

  const target = buildPlayableUrl(
    config.baseUrl,
    path,
    typeof entry?.sign === 'string' ? entry.sign : undefined,
    typeof entry?.raw_url === 'string' ? entry.raw_url : undefined
  );
  if (!target) {
    return { ok: false, status: 400, error: '影库地址无效' };
  }

  const guard = validateMediaUrl(target, undefined, {
    allowPrivateNetwork: config.allowPrivateNetwork === true,
  });
  if (!guard.ok) {
    return { ok: false, status: 403, error: guard.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: 502, error: '取回封面失败' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    // 只放行图片：影库里同名 exe / zip 不该被当成封面吐给浏览器
    if (!contentType.toLowerCase().startsWith('image/')) {
      return { ok: false, status: 415, error: '不是图片内容' };
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      return { ok: false, status: 413, error: '封面过大' };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { ok: false, status: 413, error: '封面过大' };
    }

    return { ok: true, status: 200, body: buffer, contentType };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted ? '取回封面超时' : '取回封面失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在一个影库目录下找封面，返回封面文件的**影库内绝对路径**（没有则空串）。
 *
 * 目录 Scenario：剧集目录同级通常就有 `poster.jpg`；
 * 文件 Scenario：单个视频要在它所在目录里按同名规则找。
 */
export async function findLibraryCoverPath(
  config: OpenListConfig,
  dirPath: string,
  targetName?: string
): Promise<string> {
  const listing = await requestOpenList(config, 'list', dirPath);
  if (!listing.ok) return '';
  const content = listing.data?.data?.content;
  if (!Array.isArray(content)) return '';

  const coverName = pickCoverFromItems(content, targetName);
  if (!coverName) return '';
  return joinOpenListPath(dirPath, coverName);
}
