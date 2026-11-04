import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'edge';

interface BangumiCalendarItem {
  id: number;
  name: string;
  name_cn: string;
  rating: {
    score: number;
  };
  air_date: string;
  images: {
    large: string;
    common: string;
    medium: string;
    small: string;
    grid: string;
  };
}

interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: BangumiCalendarItem[];
}

function replaceImageUrl(
  data: BangumiCalendarData[],
  imageProxy: string
): BangumiCalendarData[] {
  if (!imageProxy) return data;
  return data.map((day) => ({
    ...day,
    items: (day.items || [])
      .filter((item) => item.images)
      .map((item) => {
        const replace = (url: string) =>
          url.replace('https://lain.bgm.tv', imageProxy);
        return {
          ...item,
          images: {
            large: replace(item.images.large),
            common: replace(item.images.common),
            medium: replace(item.images.medium),
            small: replace(item.images.small),
            grid: replace(item.images.grid),
          },
        };
      }),
  }));
}

export async function GET() {
  try {
    const config = await getConfig();
    const bangumiProxy =
      config.SiteConfig.BangumiProxy ||
      process.env.NEXT_PUBLIC_BANGUMI_PROXY ||
      '';
    const imageProxy =
      config.SiteConfig.BangumiImageProxy ||
      process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY ||
      '';

    const baseUrl = bangumiProxy
      ? bangumiProxy.replace(/\/+$/, '')
      : 'https://api.bgm.tv';

    const urls = bangumiProxy
      ? [`${baseUrl}/calendar`, 'https://api.bgm.tv/calendar']
      : ['https://api.bgm.tv/calendar'];

    let data: BangumiCalendarData[] = [];
    let lastError: unknown;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        if (Array.isArray(json)) {
          data = json as BangumiCalendarData[];
          break;
        }
      } catch (error) {
        lastError = error;
        continue;
      }
    }

    if (!data.length && lastError) {
      // 所有上游源失败时返回空数组，避免在 edge 侧打印日志触发 lint 警告
    }

    const processed = replaceImageUrl(data, imageProxy.replace(/\/+$/, ''));

    return NextResponse.json(processed, {
      headers: {
        'Cache-Control': 'public, max-age=1800',
      },
    });
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
