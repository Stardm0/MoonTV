/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { isOpenListAction, requestOpenList } from '@/lib/openlist';

export const runtime = 'edge';

/**
 * 私人影库（OpenList）服务端转发。
 *
 * ## 为什么必须转发而不是浏览器直连
 *
 * OpenList 的 API 要 `Authorization` 头，直连会撞 CORS，且 token 会暴露在
 * 前端请求里。走本站转发后：同源无跨域、token 只在本站与影库之间传递。
 * 只用 `fetch`，Cloudflare / Vercel / Docker 都能跑。
 *
 * ## 安全
 *
 * 目标地址过 `validateMediaUrl`（协议白名单 + 内网黑名单 + 可选主机白名单），
 * 内网默认拒绝，需要用户在影库设置里显式勾选「局域网」。
 */
export async function POST(request: NextRequest) {
  // 与 /api/search 一致：本地存储模式不需要登录，其余模式必须带有效身份
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType !== 'localstorage') {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const action = payload?.action;
  if (!isOpenListAction(action)) {
    return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  }

  const result = await requestOpenList(
    {
      baseUrl: payload?.baseUrl ?? '',
      token: payload?.token ?? '',
      allowPrivateNetwork: payload?.allowPrivateNetwork === true,
    },
    action,
    payload?.path ?? '/'
  );

  if (!result.ok) {
    if (result.status === 403) {
      return NextResponse.json(
        { error: '影库地址不被允许', message: result.error },
        { status: 403 }
      );
    }
    if (result.status === 400) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    console.warn('影库请求失败:', result.error);
    return NextResponse.json(
      { error: result.error, detail: result.data },
      { status: result.status ?? 502 }
    );
  }

  return NextResponse.json(result.data, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
