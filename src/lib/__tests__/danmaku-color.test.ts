import {
  DEFAULT_DANMAKU_COLOR,
  danmakuTypeToMode,
  decimalColorToHex,
  hexColorToDecimal,
} from '../danmaku-color';

describe('decimalColorToHex 补零修复', () => {
  it('白色（B站默认）保持 6 位', () => {
    expect(decimalColorToHex(16777215)).toBe('#ffffff');
  });

  it('纯红正常', () => {
    expect(decimalColorToHex(16711680)).toBe('#ff0000');
  });

  it('纯蓝补齐前导零（修复前是 #ff）', () => {
    expect(decimalColorToHex(255)).toBe('#0000ff');
  });

  it('纯绿补齐前导零（修复前是 #ff00，会渲染成全透明）', () => {
    expect(decimalColorToHex(65280)).toBe('#00ff00');
  });

  it('青色补齐前导零（修复前是 #ffff，会被当成白色）', () => {
    expect(decimalColorToHex(65535)).toBe('#00ffff');
  });

  it('暗紫补齐前导零（修复前是 #8b）', () => {
    expect(decimalColorToHex(0x00008b)).toBe('#00008b');
  });

  it('产出恒为 6 位十六进制', () => {
    // 扫一遍所有「高 8 位为 0」的区间，这类值原本全部是坏的
    for (let color = 0; color <= 0xffff; color += 257) {
      const hex = decimalColorToHex(color);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('越界值按 24 位截断，不产出超长字符串', () => {
    expect(decimalColorToHex(0x1ffffff)).toMatch(/^#[0-9a-f]{6}$/);
    expect(decimalColorToHex(999999999)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('非法输入回退默认白色', () => {
    expect(decimalColorToHex(NaN)).toBe('#ffffff');
    expect(decimalColorToHex(undefined)).toBe('#ffffff');
    expect(decimalColorToHex(null)).toBe('#ffffff');
    expect(decimalColorToHex('abcdef')).toBe('#ffffff');
    expect(decimalColorToHex(-1)).toBe('#ffffff');
    expect(decimalColorToHex(Infinity)).toBe('#ffffff');
  });

  it('小数被截断为整数', () => {
    expect(decimalColorToHex(16711680.9)).toBe('#ff0000');
  });

  it('默认色常量本身是 6 位', () => {
    expect(decimalColorToHex(DEFAULT_DANMAKU_COLOR)).toBe('#ffffff');
  });
});

describe('hexColorToDecimal 反解', () => {
  it('正常往返', () => {
    for (const dec of [16777215, 16711680, 255, 65280, 65535]) {
      expect(hexColorToDecimal(decimalColorToHex(dec))).toBe(dec);
    }
  });

  it('容忍不带 # 前缀', () => {
    expect(hexColorToDecimal('ff0000')).toBe(16711680);
  });

  it('非法输入回退默认', () => {
    expect(hexColorToDecimal('#ff')).toBe(DEFAULT_DANMAKU_COLOR);
    expect(hexColorToDecimal('')).toBe(DEFAULT_DANMAKU_COLOR);
    expect(hexColorToDecimal('#gggggg')).toBe(DEFAULT_DANMAKU_COLOR);
  });
});

describe('danmakuTypeToMode B站类型映射', () => {
  it('1 滚动 / 2 顶部 / 3 底部', () => {
    expect(danmakuTypeToMode(1)).toBe(0);
    expect(danmakuTypeToMode(2)).toBe(1);
    expect(danmakuTypeToMode(3)).toBe(2);
  });

  it('兼容旧值 4=底部 5=顶部', () => {
    expect(danmakuTypeToMode(4)).toBe(2);
    expect(danmakuTypeToMode(5)).toBe(1);
  });

  it('未知值回退滚动', () => {
    expect(danmakuTypeToMode(99)).toBe(0);
    expect(danmakuTypeToMode(undefined)).toBe(0);
    expect(danmakuTypeToMode('2')).toBe(0);
  });
});
