/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  normalizeMediaLibraryConfig,
  summarizeMediaLibrary,
} from '@/lib/media-library';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  console.log('server-config called: ', request.url);

  const config = await getConfig();
  // 影库摘要**只含是否启用与类型**，令牌与地址不下发浏览器
  const mediaLibrary = normalizeMediaLibraryConfig(
    config?.SiteConfig?.MediaLibrary
  );
  const result = {
    SiteName: config.SiteConfig.SiteName,
    StorageType: process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage',
    MediaLibrary: summarizeMediaLibrary(mediaLibrary),
  };
  return NextResponse.json(result);
}
