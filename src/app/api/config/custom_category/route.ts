/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  console.log('custom_category', req.url);
  const config = await getConfig();
  const cacheTime = await getCacheTime();

  return NextResponse.json(config.CustomCategories, {
    headers: {
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
    },
  });
}
