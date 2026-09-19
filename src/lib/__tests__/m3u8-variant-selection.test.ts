/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 主播放列表选档回归测试。
 *
 * 覆盖 P1-6（画质切换）与片段预缓存之间的耦合点：预取器解析主播放列表时
 * 必须按"用户当前选择的高度"取子播放列表，否则用户切到 480p 后缓存的仍是
 * 1080p 分片，缓存命中率会直接掉到 0。
 */

import { parseM3U8 } from '../m3u8-downloader';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080',
  'v1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  'v720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=854x480',
  'v480/index.m3u8',
].join('\n');

const MEDIA = (tag: string) =>
  [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    `#EXTINF:10.0,${tag}`,
    `${tag}-0.ts`,
    `#EXTINF:10.0,${tag}`,
    `${tag}-1.ts`,
    '#EXT-X-ENDLIST',
  ].join('\n');

beforeEach(() => {
  (global as any).fetch = jest.fn(async (input: any) => {
    const url = String(input);
    const body = url.endsWith('master.m3u8')
      ? MASTER
      : MEDIA(url.split('/').slice(-2)[0] || 'seg');
    return { ok: true, text: async () => body };
  });
});

describe('主播放列表选档（P1-6 × 片段预缓存）', () => {
  it('不传偏好时取最高带宽（保持历史行为）', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8');
    expect(task.url).toBe('http://cdn.test/v1080/index.m3u8');
  });

  it('传 height=720 时命中同高度档位', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 720,
    });
    expect(task.url).toBe('http://cdn.test/v720/index.m3u8');
  });

  it('没有同高度时取最近的更高档，而不是回退到最高带宽', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 600,
    });
    expect(task.url).toBe('http://cdn.test/v720/index.m3u8');
  });

  it('目标是最高档时命中 1080', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 2000,
    });
    expect(task.url).toBe('http://cdn.test/v1080/index.m3u8');
  });

  it('height 为 null 时等价于不传', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: null,
    });
    expect(task.url).toBe('http://cdn.test/v1080/index.m3u8');
  });

  it('子播放列表可被正常解析出分片', async () => {
    const task = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 480,
    });
    expect(task.url).toBe('http://cdn.test/v480/index.m3u8');
    expect(task.tsUrlList).toEqual([
      'http://cdn.test/v480/v480-0.ts',
      'http://cdn.test/v480/v480-1.ts',
    ]);
  });

  it('主播放列表没有 RESOLUTION 时按带宽推断高度选档', async () => {
    (global as any).fetch = jest.fn(async (input: any) => {
      const url = String(input);
      const body = url.endsWith('master.m3u8')
        ? [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=5200000',
            'v1080/index.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=1100000',
            'v480/index.m3u8',
          ].join('\n')
        : MEDIA('x');
      return { ok: true, text: async () => body };
    });

    // 5200000bps → 推断 1080；1100000bps → 推断 480。
    // 这条与播放侧 resolveLevelHeight 共用同一套阶梯，两边必须一致，
    // 否则预取的档位和用户选中的档位会错开。
    const sd = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 480,
    });
    expect(sd.url).toBe('http://cdn.test/v480/index.m3u8');

    const hd = await parseM3U8('http://cdn.test/master.m3u8', 0, {
      height: 1080,
    });
    expect(hd.url).toBe('http://cdn.test/v1080/index.m3u8');
  });
});
