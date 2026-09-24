import {
  DEFAULT_LIBRARY_VIEW,
  isLibraryView,
  LIBRARY_VIEW_KEY,
  readLibraryView,
  writeLibraryView,
} from '@/lib/library-view';
import { resolveDriveVisual } from '@/lib/openlist';

describe('isLibraryView', () => {
  it('四档视图名都认', () => {
    expect(isLibraryView('list')).toBe(true);
    expect(isLibraryView('small')).toBe(true);
    expect(isLibraryView('medium')).toBe(true);
    expect(isLibraryView('large')).toBe(true);
  });

  it('其它值一律不认（含 undefined / 空串 / 大小写不符）', () => {
    expect(isLibraryView('List')).toBe(false);
    expect(isLibraryView('')).toBe(false);
    expect(isLibraryView(undefined)).toBe(false);
    expect(isLibraryView(1)).toBe(false);
  });
});

describe('影库视图偏好存取', () => {
  beforeEach(() => {
    window.localStorage.removeItem(LIBRARY_VIEW_KEY);
  });

  it('没存过时返回默认视图（列表）', () => {
    expect(readLibraryView()).toBe(DEFAULT_LIBRARY_VIEW);
  });

  it('写进去能读回', () => {
    writeLibraryView('large');
    expect(readLibraryView()).toBe('large');
  });

  it('存储内容不合法时退回默认', () => {
    window.localStorage.setItem(LIBRARY_VIEW_KEY, 'huge');
    expect(readLibraryView()).toBe(DEFAULT_LIBRARY_VIEW);
  });
});

describe('resolveDriveVisual', () => {
  it('中文网盘名能认出来', () => {
    expect(resolveDriveVisual('阿里云盘')).toEqual({
      icon: 'aliyun',
      tone: 'sky',
    });
    expect(resolveDriveVisual('夸克网盘')).toEqual({
      icon: 'quark',
      tone: 'cyan',
    });
    expect(resolveDriveVisual('小雅')).toEqual({
      icon: 'xiaoya',
      tone: 'purple',
    });
  });

  it('英文 / 大小写混写也能认出来', () => {
    expect(resolveDriveVisual('My AliYun Drive').icon).toBe('aliyun');
    expect(resolveDriveVisual('OneDrive').icon).toBe('onedrive');
    expect(resolveDriveVisual('PikPak').icon).toBe('pikpak');
  });

  it('115 走专属图标', () => {
    expect(resolveDriveVisual('115网盘')).toEqual({
      icon: 'drive115',
      tone: 'blue',
    });
  });

  it('认不出来时给通用云图标 + 中性灰', () => {
    expect(resolveDriveVisual('我的杂七杂八')).toEqual({
      icon: 'cloud',
      tone: 'gray',
    });
    expect(resolveDriveVisual('')).toEqual({ icon: 'cloud', tone: 'gray' });
  });
});
