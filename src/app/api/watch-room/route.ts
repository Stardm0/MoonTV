/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { handleRoomAction } from '@/lib/watch-room/service';
import {
  cleanText,
  MAX_NAME_LENGTH,
  RoomRequest,
} from '@/lib/watch-room/types';

// 与项目其余 API 保持一致：Edge runtime 下 Upstash REST 可用，无需 Node 依赖
export const runtime = 'edge';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: '请求体不是合法 JSON' },
      { status: 400, headers: NO_STORE }
    );
  }

  // middleware 已完成站点级认证；这里只取用户名作为默认昵称
  const auth = getAuthInfoFromCookie(request);
  const identity = { name: cleanText(auth?.username, MAX_NAME_LENGTH) };

  try {
    const result = await handleRoomAction(body as RoomRequest, identity);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 400,
      headers: NO_STORE,
    });
  } catch (err) {
    console.error('[watch-room] 处理房间请求失败', err);
    return NextResponse.json(
      { ok: false, error: '房间服务暂时不可用' },
      { status: 500, headers: NO_STORE }
    );
  }
}
