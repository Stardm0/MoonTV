import {
  describeCacheSwitch,
  describeSkipConfig,
  type SkipConfigLike,
} from './settingsLayout';

const base: SkipConfigLike = { enable: false, intro_time: 0, outro_time: 0 };

describe('describeSkipConfig', () => {
  it('完全没配置时提示未设置（开启但时间为 0）', () => {
    expect(describeSkipConfig({ ...base, enable: true })).toBe('未设置');
  });

  it('关闭且没有任何时间时显示已关闭', () => {
    expect(describeSkipConfig(base)).toBe('已关闭');
  });

  it('只设了片头时只报片头', () => {
    expect(describeSkipConfig({ ...base, enable: true, intro_time: 90 })).toBe(
      '片头 01:30'
    );
  });

  it('只设了片尾时只报片尾，且带负号前缀', () => {
    expect(describeSkipConfig({ ...base, enable: true, outro_time: -45 })).toBe(
      '片尾 -00:45'
    );
  });

  it('两个都设了按 片头 → 片尾 的顺序拼接', () => {
    expect(
      describeSkipConfig({ ...base, enable: true, intro_time: 90, outro_time: -45 })
    ).toBe('片头 01:30 · 片尾 -00:45');
  });

  it('关闭但时间还在时，先说已关闭再列时间', () => {
    expect(
      describeSkipConfig({ ...base, enable: false, intro_time: 90, outro_time: -45 })
    ).toBe('已关闭 · 片头 01:30 · 片尾 -00:45');
  });

  it('超过一小时用三段式时间', () => {
    expect(describeSkipConfig({ ...base, enable: true, intro_time: 3725 })).toBe(
      '片头 01:02:05'
    );
  });

  it('intro_time 为负数时不展示（异常数据不该渲染出负号）', () => {
    expect(describeSkipConfig({ ...base, enable: true, intro_time: -10 })).toBe(
      '未设置'
    );
  });

  it('outro_time 为正数时不展示', () => {
    expect(describeSkipConfig({ ...base, enable: true, outro_time: 30 })).toBe(
      '未设置'
    );
  });
});

describe('describeCacheSwitch', () => {
  it('开启/关闭文案稳定（ArtPlayer 会把 tooltip 写在右边，不能是空串）', () => {
    expect(describeCacheSwitch(true)).toBe('开启');
    expect(describeCacheSwitch(false)).toBe('关闭');
  });
});
