import {
  clearPlaybackRate,
  DEFAULT_PLAYBACK_RATE,
  loadPlaybackRate,
  normalizePlaybackRate,
  PLAYBACK_RATE_STORAGE_KEY,
  savePlaybackRate,
} from '../playback-rate';

describe('normalizePlaybackRate 归一化', () => {
  it('正常值原样返回', () => {
    expect(normalizePlaybackRate(1.5)).toBe(1.5);
    expect(normalizePlaybackRate(2)).toBe(2);
    expect(normalizePlaybackRate(0.5)).toBe(0.5);
    expect(normalizePlaybackRate(3)).toBe(3);
  });

  it('字符串数字可解析', () => {
    expect(normalizePlaybackRate('1.25')).toBe(1.25);
  });

  it('越界回退默认', () => {
    expect(normalizePlaybackRate(0.1)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(normalizePlaybackRate(10)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(normalizePlaybackRate(-1)).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it('非法输入回退默认', () => {
    expect(normalizePlaybackRate(NaN)).toBe(1);
    expect(normalizePlaybackRate(undefined)).toBe(1);
    expect(normalizePlaybackRate(null)).toBe(1);
    expect(normalizePlaybackRate('abc')).toBe(1);
    expect(normalizePlaybackRate({})).toBe(1);
    expect(normalizePlaybackRate(Infinity)).toBe(1);
  });

  it('浮点误差被收敛到两位小数', () => {
    expect(normalizePlaybackRate(1.5000000000000002)).toBe(1.5);
    expect(normalizePlaybackRate(0.30000000000000004)).toBe(1);
  });
});

describe('localStorage 读写', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未设置时返回默认值', () => {
    expect(loadPlaybackRate()).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it('保存后能读回', () => {
    savePlaybackRate(1.5);
    expect(loadPlaybackRate()).toBe(1.5);
    expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBe('1.5');
  });

  it('保存默认值时不写入存储（避免留无意义条目）', () => {
    savePlaybackRate(1);
    expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBeNull();
  });

  it('从非默认值改回默认值时清除记录', () => {
    savePlaybackRate(2);
    expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBe('2');
    savePlaybackRate(1);
    expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBeNull();
  });

  it('存储里被手改成脏数据时回退默认', () => {
    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, 'not-a-number');
    expect(loadPlaybackRate()).toBe(DEFAULT_PLAYBACK_RATE);

    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, '99');
    expect(loadPlaybackRate()).toBe(DEFAULT_PLAYBACK_RATE);

    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, '-2');
    expect(loadPlaybackRate()).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it('clearPlaybackRate 清除记录', () => {
    savePlaybackRate(1.75);
    clearPlaybackRate();
    expect(loadPlaybackRate()).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it('保存脏值时不会污染存储', () => {
    savePlaybackRate('garbage');
    // 归一化后等于默认值 → 不写入
    expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBeNull();
  });
});
