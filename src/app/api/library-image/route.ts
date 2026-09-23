/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import {
  LIBRARY_IMAGE_MAX_BYTES,
  parseLibraryImageParams,
} from '@/lib/library-image';
import {
  fetchEmbyImage,
  fetchLibraryImage,
} from '@/lib/library-image.server';
import { toEmbyConfig } from '@/lib/media-library';
import {
  getServerMediaLibraryConfig,
  getServerOpenListConfig,
} from '@/lib/media-library.server';
import { parseOpenListConfigFromCookieHeader } from '@/lib/openlist';

export const runtime = 'edge';

/**
 * 私人影库封面代理。
 *
 * `?p=<影库内路径>`  → OpenList：服务端拿令牌换带签名的直链再回源
 * `?e=<条目 ID>`     → Emby：服务端补 api_key 取 `/Items/{id}/Images/Primary`
 *
 * 浏览器只传影库内的相对标识，其余（地址、令牌、签名）全在服务端补齐——
 * 站点级影库配置下，浏览器甚至不知道影库在哪、也就拿不到令牌。
 *
 * 刻意不接受任意 URL：那会变成另一处开放代理，本站已有 `/api/image-proxy`
 * 承担对外图片代理的职责，这里只服务自己的影库。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = parseLibraryImageParams(searchParams);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Emby 只来自站点级配置（个人 cookie 只存 OpenList 结构）
  if ('embyItemId' in parsed) {
    const serverConfig = await getServerMediaLibraryConfig();
    const embyConfig = serverConfig?.Type === 'emby' ? toEmbyConfig(serverConfig) : null;
    if (!embyConfig?.baseUrl) {
      return NextResponse.json(
        { error: '尚未配置 Emby 影库' },
        { status: 400 }
      );
    }
    const result = await fetchEmbyImage(
      embyConfig,
      parsed.embyItemId,
      LIBRARY_IMAGE_MAX_BYTES
    );
    return imageResponse(result);
  }

  // OpenList：个人 cookie 优先，服务端全局兜底
  const cookieHeader = request.headers.get('cookie');
  const fromCookie = parseOpenListConfigFromCookieHeader(cookieHeader);
  const config = fromCookie?.baseUrl
    ? fromCookie
    : await getServerOpenListConfig();

  if (!config?.baseUrl) {
    return NextResponse.json({ error: '尚未配置私人影库' }, { status: 400 });
  }

  const result = await fetchLibraryImage(config, parsed.path, LIBRARY_IMAGE_MAX_BYTES);
  return imageResponse(result);
}

function imageResponse(result: {
  ok: boolean;
  status: number;
  error?: string;
  body?: ArrayBuffer;
  contentType?: string;
}) {
  if (!result.ok || !result.body) {
    return NextResponse.json(
      { error: result.error ?? '读取封面失败' },
      { status: result.status }
    );
  }

  const headers = new Headers();
  headers.set('Content-Type', result.contentType ?? 'image/jpeg');
  // 直链签名会过期，缓存给短一点；CDN 侧多留一会儿也够一轮会话用
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('CDN-Cache-Control', 'public, s-maxage=3600');

  return new Response(result.body, { status: 200, headers });
}
