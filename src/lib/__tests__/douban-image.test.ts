/**
 * `douban-image` 单测。
 *
 * 这个模块是为了修一个**真实的"假修复"**：原实现图片加载失败后
 * `img.src = processImageUrl(poster)` —— 赋的还是同一个 URL，
 * 等于什么都没做，所以「有时图片出不来」一直存在。
 *
 * 重点验证：候选**必须彼此不同**、顺序合理、且非豆瓣图不会被塞进豆瓣 CDN。
 */

import {
  CMLIUSSSS_IMAGE_HOST,
  SERVER_IMAGE_PROXY_PATH,
  applyImageFallback,
  buildCmliussssUrl,
  buildImageCandidates,
  buildServerProxyUrl,
  isDoubanImageUrl,
  nextImageFallback,
} from '../douban-image';

const DOUBAN = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';
const DOUBAN_IMG9 = 'https://img9.doubanio.com/view/photo/l/public/p2.jpg';
const OTHER = 'https://img.example.com/poster.jpg';

describe('isDoubanImageUrl', () => {
  it('识别豆瓣图', () => {
    expect(isDoubanImageUrl(DOUBAN)).toBe(true);
    expect(isDoubanImageUrl(DOUBAN_IMG9)).toBe(true);
    // 大小写不敏感
    expect(isDoubanImageUrl('https://IMG1.DOUBANIO.COM/a.jpg')).toBe(true);
  });

  it('非豆瓣图 / 空值返回 false', () => {
    expect(isDoubanImageUrl(OTHER)).toBe(false);
    expect(isDoubanImageUrl('')).toBe(false);
    expect(isDoubanImageUrl('doubanio.com.evil.com/a.jpg')).toBe(true); // 含子串即算，宁可多兜底
  });
});

describe('buildServerProxyUrl', () => {
  it('包装成自带代理并做 URL 编码', () => {
    const out = buildServerProxyUrl(DOUBAN);
    expect(out.startsWith(`${SERVER_IMAGE_PROXY_PATH}?url=`)).toBe(true);
    expect(out).toContain(encodeURIComponent(DOUBAN));
    // 原始 URL 里的 :// 不能裸着出现，否则会被当参数截断
    expect(out.slice(SERVER_IMAGE_PROXY_PATH.length)).not.toContain('://');
  });

  it('空值返回空串', () => {
    expect(buildServerProxyUrl('')).toBe('');
  });
});

describe('buildCmliussssUrl', () => {
  it('把 img<N>.doubanio.com 换成 CDN 主机', () => {
    expect(buildCmliussssUrl(DOUBAN)).toContain(CMLIUSSSS_IMAGE_HOST);
    expect(buildCmliussssUrl(DOUBAN)).not.toContain('img1.doubanio.com');
    expect(buildCmliussssUrl(DOUBAN_IMG9)).toContain(CMLIUSSSS_IMAGE_HOST);
  });

  it('主机名形状不匹配时返回空串（不硬塞，否则必 404）', () => {
    expect(buildCmliussssUrl('https://movie.douban.com/subject/1/')).toBe('');
    expect(buildCmliussssUrl(OTHER)).toBe('');
    expect(buildCmliussssUrl('')).toBe('');
  });

  it('保留原路径与查询串', () => {
    const withQuery = `https://img2.doubanio.com/view/x.jpg?w=300&h=450`;
    const out = buildCmliussssUrl(withQuery);
    expect(out).toContain('/view/x.jpg?w=300&h=450');
  });
});

describe('buildImageCandidates', () => {
  it('非豆瓣图只返回首选（不塞豆瓣 CDN）', () => {
    const out = buildImageCandidates(OTHER, OTHER);
    expect(out).toEqual([OTHER]);
  });

  it('豆瓣图给出三级候选，且彼此不同', () => {
    const primary = DOUBAN; // 用户配置是直连
    const out = buildImageCandidates(DOUBAN, primary);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
    // 首选保持在第一位
    expect(out[0]).toBe(primary);
    // 第二位是自带代理
    expect(out[1].startsWith(SERVER_IMAGE_PROXY_PATH)).toBe(true);
    // 第三位是 CDN
    expect(out[2]).toContain(CMLIUSSSS_IMAGE_HOST);
  });

  it('配置已是服务端代理时不会重复（去重）', () => {
    const primary = buildServerProxyUrl(DOUBAN);
    const out = buildImageCandidates(DOUBAN, primary);
    expect(out[0]).toBe(primary);
    expect(out.filter((u) => u.startsWith(SERVER_IMAGE_PROXY_PATH))).toHaveLength(
      1
    );
    // 仍然保留 CDN 这一级
    expect(out.some((u) => u.includes(CMLIUSSSS_IMAGE_HOST))).toBe(true);
  });

  it('全空输入返回空数组', () => {
    expect(buildImageCandidates('', '')).toEqual([]);
  });

  it('originalUrl 为空但有 primaryUrl 时保留 primaryUrl', () => {
    expect(buildImageCandidates('', OTHER)).toEqual([OTHER]);
  });
});

describe('nextImageFallback', () => {
  const candidates = ['a', 'b', 'c'];

  it('step=0（首选刚失败）返回下一个', () => {
    expect(nextImageFallback(candidates, 0)).toBe('b');
    expect(nextImageFallback(candidates, 1)).toBe('c');
  });

  it('候选用尽返回 null（调用方应保留占位图，不再重试）', () => {
    expect(nextImageFallback(candidates, 2)).toBeNull();
    expect(nextImageFallback(candidates, 99)).toBeNull();
  });

  it('非法 step 返回 null，避免下标越界', () => {
    expect(nextImageFallback(candidates, -1)).toBeNull();
    expect(nextImageFallback(candidates, Number.NaN)).toBeNull();
    expect(nextImageFallback(candidates, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('空候选返回 null', () => {
    expect(nextImageFallback([], 0)).toBeNull();
  });
});

describe('applyImageFallback（DOM 侧）', () => {
  function makeImg(attrs: Record<string, string> = {}): HTMLImageElement {
    const img = document.createElement('img');
    for (const [k, v] of Object.entries(attrs)) img.setAttribute(k, v);
    return img;
  }

  it('第一次失败切到服务端代理，第二次切到 CDN，之后返回 false', () => {
    const img = makeImg({ src: DOUBAN });

    expect(applyImageFallback(img, DOUBAN, DOUBAN)).toBe(true);
    expect(img.src).toContain(SERVER_IMAGE_PROXY_PATH);

    expect(applyImageFallback(img, DOUBAN, DOUBAN)).toBe(true);
    expect(img.src).toContain(CMLIUSSSS_IMAGE_HOST);

    // 候选用尽 → 返回 false，调用方保留占位图
    expect(applyImageFallback(img, DOUBAN, DOUBAN)).toBe(false);
  });

  it('非豆瓣图没有后备候选，第一次就返回 false', () => {
    const img = makeImg({ src: OTHER });
    expect(applyImageFallback(img, OTHER, OTHER)).toBe(false);
    expect(img.src).toContain(OTHER);
  });

  it('换海报后计数重置，新图重新从首选的后一级开始', () => {
    const img = makeImg({ src: DOUBAN });
    applyImageFallback(img, DOUBAN, DOUBAN); // 用掉一级
    expect(img.dataset.imgFallbackStep).toBe('1');

    // 换一张海报：计数必须归零，否则新图会平白丢掉首选之后的第 1 级
    applyImageFallback(img, DOUBAN_IMG9, DOUBAN_IMG9);
    expect(img.dataset.imgFallbackStep).toBe('1');
    expect(img.dataset.imgFallbackFor).toBe(DOUBAN_IMG9);
  });

  it('清理 srcset / sizes，否则浏览器可能仍按旧候选集取图', () => {
    const img = makeImg({
      src: DOUBAN,
      srcset: `${DOUBAN} 1x`,
      sizes: '100vw',
    });
    applyImageFallback(img, DOUBAN, DOUBAN);
    expect(img.getAttribute('srcset')).toBeNull();
    expect(img.getAttribute('sizes')).toBeNull();
  });
});

