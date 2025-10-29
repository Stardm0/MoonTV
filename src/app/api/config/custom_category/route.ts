import { NextRequest, NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';

export const runtime = 'edge';

export async function GET(_req: NextRequest) {
  const config = await getConfig();
  const cacheTime = await getCacheTime();

  return NextResponse.json(config.CustomCategories, {
    headers: {
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
    },
  });
}
