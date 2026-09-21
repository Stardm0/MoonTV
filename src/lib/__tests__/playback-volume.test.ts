import {
  clearVolume,
  DEFAULT_VOLUME,
  loadVolume,
  normalizeVolume,
  saveVolume,
  VOLUME_STORAGE_KEY,
} from '../playback-volume';

describe('normalizeVolume 归一化', () => {
  it('正常值原样返回', () => {
    expect(normalizeVolume(0.5)).toBe(0.5);
    expect(normalizeVolume(1)).toBe(1);
    expect(normalizeVolume(0)).toBe(0);
    expect(normalizeVolume(0.75)).toBe(0.75);
  });

  it('字符串数字可解析', () => {
    expect(normalizeVolume('0.35')).toBe(0.35);
  });

  it('越界值被钳制而非丢弃（音量是连续量）', () => {
    expect(normalizeVolume(1.5)).toBe(1);
    expect(normalizeVolume(-0.3)).toBe(0);
    expect(normalizeVolume(999)).toBe(1);
  });

  it('非法输入回退默认', () => {
    expect(normalizeVolume(NaN)).toBe(DEFAULT_VOLUME);
    expect(normalizeVolume(undefined)).toBe(DEFAULT_VOLUME);
    expect(normalizeVolume(null)).toBe(DEFAULT_VOLUME);
    expect(normalizeVolume('abc')).toBe(DEFAULT_VOLUME);
    expect(normalizeVolume(Infinity)).toBe(DEFAULT_VOLUME);
  });

  it('浮点误差被收敛', () => {
    expect(normalizeVolume(0.30000000000000004)).toBe(0.3);
  });
});

describe('localStorage 读写', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未设置时返回默认值', () => {
    expect(loadVolume()).toBe(DEFAULT_VOLUME);
  });

  it('保存后能读回', () => {
    saveVolume(0.35);
    expect(loadVolume()).toBe(0.35);
  });

  it('音量为 0 是刻意静音，必须记住', () => {
    saveVolume(0);
    expect(window.localStorage.getItem(VOLUME_STORAGE_KEY)).toBe('0');
    expect(loadVolume()).toBe(0);
  });

  it('保存默认值时不写入存储', () => {
    saveVolume(DEFAULT_VOLUME);
    expect(window.localStorage.getItem(VOLUME_STORAGE_KEY)).toBeNull();
  });

  it('从非默认值改回默认值时清除记录', () => {
    saveVolume(0.2);
    expect(window.localStorage.getItem(VOLUME_STORAGE_KEY)).toBe('0.2');
    saveVolume(DEFAULT_VOLUME);
    expect(window.localStorage.getItem(VOLUME_STORAGE_KEY)).toBeNull();
  });

  it('脏数据回退默认', () => {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, 'garbage');
    expect(loadVolume()).toBe(DEFAULT_VOLUME);
  });

  it('超范围脏数据被钳制', () => {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, '5');
    expect(loadVolume()).toBe(1);
  });

  it('clearVolume 清除记录', () => {
    saveVolume(0.1);
    clearVolume();
    expect(loadVolume()).toBe(DEFAULT_VOLUME);
  });
});
