/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    const auth = getAuthInfoFromCookie(request);
    const username = auth?.username;
    const sites = await getAvailableApiSites(username);
    const cacheTime = await getCacheTime();
    return NextResponse.json(sites, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
      },
    });
  } catch (error) {
    console.error('获取按用户过滤的视频源失败:', error);
    return NextResponse.json(
      { error: '获取视频源失败' },
      { status: 500 }
    );
  }
}