import {
  buildPosterInitial,
  buildPosterPalette,
} from '@/lib/poster-fallback';

describe('buildPosterInitial', () => {
  it('中文取首字', () => {
    expect(buildPosterInitial('流浪地球')).toBe('流');
  });

  it('英文首字母大写', () => {
    expect(buildPosterInitial('interstellar')).toBe('I');
    expect(buildPosterInitial('Interstellar')).toBe('I');
  });

  it('数字开头按原样取（不当字母处理）', () => {
    expect(buildPosterInitial('1917')).toBe('1');
  });

  it('空标题给问号，trim 后仍为空也算空', () => {
    expect(buildPosterInitial('')).toBe('?');
    expect(buildPosterInitial('   ')).toBe('?');
  });

  it('带前后空格的标题取实际首字', () => {
    expect(buildPosterInitial('  沙丘 ')).toBe('沙');
  });
});

describe('buildPosterPalette', () => {
  it('同一标题永远同色（列表刷新不跳色）', () => {
    const a = buildPosterPalette('流浪地球');
    const b = buildPosterPalette('流浪地球');
    expect(a).toEqual(b);
  });

  it('不同标题通常不同色（哈希有区分度）', () => {
    const colors = new Set(
      ['流浪地球', '沙丘', '星际穿越', '奥本海默', '芭比'].map(
        (t) => buildPosterPalette(t).from
      )
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it('返回 hsl 字符串且两个色相相差 40 度内的同色系', () => {
    const palette = buildPosterPalette('沙丘');
    expect(palette.from).toMatch(/^hsl\(\d{1,3} 38% 42%\)$/);
    expect(palette.to).toMatch(/^hsl\(\d{1,3} 42% 26%\)$/);
  });

  it('空标题也能得到合法颜色（不崩、不 NaN）', () => {
    const palette = buildPosterPalette('');
    expect(palette.from).not.toContain('NaN');
    expect(palette.to).not.toContain('NaN');
  });
});
