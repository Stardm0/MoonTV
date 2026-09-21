/**
 * `heroLayout` 单测。
 *
 * 重点在三处**看不见的边界**（这个项目反复吃亏的地方）：
 * 1. 背景层的 768px 断点 —— 差一点就会让手机多下一张用不上的大图。
 * 2. SSR（宽度 0）必须不渲染背景层 —— 否则首帧就发起请求。
 * 3. 简介长度判定要先压平空白 —— 源站 desc 常带大量换行。
 */

import {
  buildBackdropStyle,
  HERO_BACKDROP_MIN_WIDTH,
  HERO_DESC_CLAMP_CHARS,
  shouldClampDescription,
  shouldShowBackdrop,
} from './heroLayout';

describe('shouldShowBackdrop', () => {
  const poster = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';

  it('无海报时不渲染（非豆瓣源没有封面）', () => {
    expect(shouldShowBackdrop('', 1440)).toBe(false);
    expect(shouldShowBackdrop(undefined, 1440)).toBe(false);
    expect(shouldShowBackdrop(null, 1440)).toBe(false);
    expect(shouldShowBackdrop('   ', 1440)).toBe(false);
  });

  it('SSR / 拿不到宽度时不渲染（避免首帧就发起图片请求）', () => {
    expect(shouldShowBackdrop(poster, 0)).toBe(false);
    expect(shouldShowBackdrop(poster, -1)).toBe(false);
    expect(shouldShowBackdrop(poster, Number.NaN)).toBe(false);
    expect(shouldShowBackdrop(poster, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('恰好在断点上渲染，差 1px 不渲染', () => {
    expect(shouldShowBackdrop(poster, HERO_BACKDROP_MIN_WIDTH - 1)).toBe(false);
    expect(shouldShowBackdrop(poster, HERO_BACKDROP_MIN_WIDTH)).toBe(true);
    expect(shouldShowBackdrop(poster, HERO_BACKDROP_MIN_WIDTH + 1)).toBe(true);
  });

  it('断点取 768（Tailwind md），与移动端降级方案一致', () => {
    expect(HERO_BACKDROP_MIN_WIDTH).toBe(768);
    // 常见手机宽度必须落在断点之下
    for (const w of [320, 360, 375, 390, 414, 430, 540, 767]) {
      expect(shouldShowBackdrop(poster, w)).toBe(false);
    }
    // 常见桌面宽度必须落在断点之上
    for (const w of [768, 1024, 1280, 1440, 1920, 2560]) {
      expect(shouldShowBackdrop(poster, w)).toBe(true);
    }
  });
});

describe('buildBackdropStyle', () => {
  it('无海报时返回空样式（调用方据此不渲染背景层）', () => {
    expect(buildBackdropStyle('')).toEqual({});
    expect(buildBackdropStyle(undefined)).toEqual({});
    expect(buildBackdropStyle('  ')).toEqual({});
  });

  it('包成 CSS url() 形式', () => {
    const style = buildBackdropStyle('https://example.com/a.jpg');
    expect(style.backgroundImage).toBe('url("https://example.com/a.jpg")');
  });

  it('非豆瓣图原样返回（processImageUrl 只处理 doubanio.com）', () => {
    const style = buildBackdropStyle('https://img.example.com/poster.jpg');
    expect(style.backgroundImage).toContain('https://img.example.com/poster.jpg');
  });

  it('转义双引号与反斜杠，避免破坏 url()', () => {
    const style = buildBackdropStyle('https://example.com/a"b\\c.jpg');
    const value = String(style.backgroundImage);
    expect(value).toContain('%22');
    expect(value).toContain('%5C');
    // 除包裹用的那一对引号外，不应再有多余引号跑出来
    expect(value?.match(/"/g)).toHaveLength(2);
  });

  it('前后空白被裁掉', () => {
    const style = buildBackdropStyle('  https://example.com/a.jpg  ');
    expect(style.backgroundImage).toBe('url("https://example.com/a.jpg")');
  });
});

describe('shouldClampDescription', () => {
  it('无简介不显示展开', () => {
    expect(shouldClampDescription('')).toBe(false);
    expect(shouldClampDescription(undefined)).toBe(false);
    expect(shouldClampDescription('   \n\n  ')).toBe(false);
  });

  it('短简介不显示展开，超长显示', () => {
    expect(shouldClampDescription('短简介')).toBe(false);
    expect(shouldClampDescription('字'.repeat(HERO_DESC_CLAMP_CHARS))).toBe(false);
    expect(shouldClampDescription('字'.repeat(HERO_DESC_CLAMP_CHARS + 1))).toBe(
      true
    );
  });

  it('先压平空白再比长度（源站 desc 常带换行缩进）', () => {
    // 40 个字符 + 大量空白 = 压平后只有 40，不该被判超长
    const padded = '字'.repeat(40) + '\n'.repeat(200) + ' '.repeat(200);
    expect(shouldClampDescription(padded, 100)).toBe(false);
  });

  it('maxChars 非法时一律不收起（宁可不收，也不要误藏内容）', () => {
    expect(shouldClampDescription('字'.repeat(500), 0)).toBe(false);
    expect(shouldClampDescription('字'.repeat(500), -10)).toBe(false);
    expect(shouldClampDescription('字'.repeat(500), Number.NaN)).toBe(false);
  });

  it('默认阈值是 120', () => {
    expect(HERO_DESC_CLAMP_CHARS).toBe(120);
  });
});
