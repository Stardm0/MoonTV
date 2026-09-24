/**
 * 第二层主题（主色）的单元测试。
 *
 * 这里的重点不是"色值对不对"（那由 `colors.css` 保证），而是：
 * 1. 色阶清单与真实 CSS 类名是否对得上 —— 写错一个字母整站就不会换色，
 *    但页面不会报错，属于最难发现的故障，必须用测试钉死。
 * 2. 存储读写、非法值兜底、RGB 转换这些纯逻辑。
 */

import {
  DEFAULT_THEME_PALETTE,
  isThemePalette,
  loadThemePalette,
  rgbTripletToCss,
  rgbTripletToHex,
  saveThemePalette,
  THEME_PALETTES,
  THEME_PALETTE_LABELS,
  THEME_PALETTE_SHADES,
  THEME_PALETTE_STORAGE_KEY,
} from '../theme-palette';

describe('theme-palette', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  describe('色阶清单', () => {
    it('正好 22 套，与 colors.css 的类名一一对应', () => {
      expect(THEME_PALETTES).toHaveLength(22);
    });

    it('默认主色必须在清单内，否则 applyThemePalette 的兜底会死循环', () => {
      expect(THEME_PALETTES).toContain(DEFAULT_THEME_PALETTE);
    });

    it('每套色阶都有中文名，不能有遗漏', () => {
      for (const palette of THEME_PALETTES) {
        expect(THEME_PALETTE_LABELS[palette]).toBeTruthy();
      }
    });

    it('色阶名不含大写或连字符（CSS 类名是纯小写单词）', () => {
      for (const palette of THEME_PALETTES) {
        expect(palette).toMatch(/^[a-z]+$/);
      }
    });

    it('每个档位都齐全，含 950（很多色阶的 950 是深色模式的底色）', () => {
      expect(THEME_PALETTE_SHADES).toEqual([
        50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
      ]);
    });
  });

  describe('isThemePalette', () => {
    it('接受合法色阶名', () => {
      expect(isThemePalette('sky')).toBe(true);
      expect(isThemePalette('rose')).toBe(true);
    });

    it('拒绝不在清单里的值', () => {
      expect(isThemePalette('SKY')).toBe(false); // 大小写敏感
      expect(isThemePalette('slate ')).toBe(false); // 带空格
      expect(isThemePalette('skyblue')).toBe(false);
      expect(isThemePalette('')).toBe(false);
    });

    it('拒绝非字符串', () => {
      expect(isThemePalette(null)).toBe(false);
      expect(isThemePalette(undefined)).toBe(false);
      expect(isThemePalette(22)).toBe(false);
      expect(isThemePalette({ palette: 'sky' })).toBe(false);
    });
  });

  describe('存储读写', () => {
    it('未存储时返回默认色', () => {
      expect(loadThemePalette()).toBe(DEFAULT_THEME_PALETTE);
    });

    it('存了非默认色时能读回来', () => {
      saveThemePalette('violet');
      expect(loadThemePalette()).toBe('violet');
      expect(window.localStorage.getItem(THEME_PALETTE_STORAGE_KEY)).toBe(
        'violet'
      );
    });

    it('存默认色时删除键而不是写入 —— 避免旧版本残留冗余配置', () => {
      saveThemePalette('violet');
      saveThemePalette(DEFAULT_THEME_PALETTE);
      expect(
        window.localStorage.getItem(THEME_PALETTE_STORAGE_KEY)
      ).toBeNull();
      expect(loadThemePalette()).toBe(DEFAULT_THEME_PALETTE);
    });

    it('存储里是非法值（旧版本残留 / 手工篡改）时退回默认色', () => {
      window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, 'not-a-palette');
      expect(loadThemePalette()).toBe(DEFAULT_THEME_PALETTE);
    });

    it('localStorage 抛异常时读取不炸，静默退回默认色', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(loadThemePalette()).toBe(DEFAULT_THEME_PALETTE);
    });

    it('localStorage 抛异常时写入不炸', () => {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      expect(() => saveThemePalette('red')).not.toThrow();
    });
  });

  describe('rgbTripletToCss', () => {
    it('把空格分隔的三元组包装成 rgb()', () => {
      expect(rgbTripletToCss('2 6 23')).toBe('rgb(2 6 23)');
      expect(rgbTripletToCss('248 250 252')).toBe('rgb(248 250 252)');
    });

    it('容忍首尾空白', () => {
      expect(rgbTripletToCss('  2 6 23  ')).toBe('rgb(2 6 23)');
    });

    it('空值 / 畸形值返回 fallback，绝不产出非法 CSS', () => {
      expect(rgbTripletToCss('')).toBe('transparent');
      expect(rgbTripletToCss('2 6')).toBe('transparent');
      expect(rgbTripletToCss('2 6 23 4')).toBe('transparent');
      expect(rgbTripletToCss('rgb(2,6,23)')).toBe('transparent');
      expect(rgbTripletToCss('a b c')).toBe('transparent');
    });

    it('可以自定义 fallback', () => {
      expect(rgbTripletToCss('', '#fff')).toBe('#fff');
    });

    it('4 位数字也拒绝（防止把 1024 之类的值透传出去）', () => {
      expect(rgbTripletToCss('1024 6 23')).toBe('transparent');
    });
  });

  describe('rgbTripletToHex', () => {
    it('转成 6 位 16 进制并补零', () => {
      expect(rgbTripletToHex('2 6 23')).toBe('#020617');
      expect(rgbTripletToHex('248 250 252')).toBe('#f8fafc');
    });

    it('纯黑 / 纯白正确', () => {
      expect(rgbTripletToHex('0 0 0')).toBe('#000000');
      expect(rgbTripletToHex('255 255 255')).toBe('#ffffff');
    });

    it('容忍多余空白', () => {
      expect(rgbTripletToHex('  255   0   0 ')).toBe('#ff0000');
    });

    it('畸形值返回 fallback', () => {
      expect(rgbTripletToHex('')).toBe('#000000');
      expect(rgbTripletToHex('1 2')).toBe('#000000');
      expect(rgbTripletToHex('a b c')).toBe('#000000');
      expect(rgbTripletToHex('rgb(1,2,3)')).toBe('#000000');
    });

    it('超出 0-255 的值被夹取，不会产出非法 16 进制', () => {
      expect(rgbTripletToHex('300 0 0')).toBe('#ff0000');
      expect(rgbTripletToHex('-5 0 0')).toBe('#000000');
    });
  });
});
