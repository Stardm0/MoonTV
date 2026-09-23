import {
  createEmptyMediaLibraryConfig,
  isMediaLibraryType,
  isMediaLibraryUsable,
  MEDIA_LIBRARY_TYPE_LABELS,
  normalizeMediaLibraryConfig,
  normalizeMediaLibraryType,
  summarizeMediaLibrary,
  toOpenListConfig,
} from '@/lib/media-library';

describe('影库类型判定', () => {
  it('认得已支持的类型', () => {
    expect(isMediaLibraryType('openlist')).toBe(true);
    expect(isMediaLibraryType('emby')).toBe(true);
  });

  it('不认得的类型与非法值返回 false', () => {
    expect(isMediaLibraryType('plex')).toBe(false);
    expect(isMediaLibraryType('')).toBe(false);
    expect(isMediaLibraryType(undefined)).toBe(false);
    expect(isMediaLibraryType(1)).toBe(false);
  });

  it('未知类型一律归一成 openlist，而不是抛错', () => {
    expect(normalizeMediaLibraryType('emby')).toBe('emby');
    expect(normalizeMediaLibraryType('plex')).toBe('openlist');
    expect(normalizeMediaLibraryType(undefined)).toBe('openlist');
  });

  it('每种类型都有展示名（管理台下拉直接取用）', () => {
    expect(MEDIA_LIBRARY_TYPE_LABELS.openlist).toBeTruthy();
    expect(MEDIA_LIBRARY_TYPE_LABELS.emby).toBeTruthy();
  });
});

describe('影库配置归一', () => {
  it('非对象与空值一律返回 null（等于未配置）', () => {
    expect(normalizeMediaLibraryConfig(null)).toBeNull();
    expect(normalizeMediaLibraryConfig(undefined)).toBeNull();
    expect(normalizeMediaLibraryConfig('openlist')).toBeNull();
    expect(normalizeMediaLibraryConfig(42)).toBeNull();
  });

  it('没填地址等同于未配置——没地址就没法连', () => {
    expect(normalizeMediaLibraryConfig({ Enabled: true })).toBeNull();
    expect(normalizeMediaLibraryConfig({ Enabled: true, BaseUrl: '   ' })).toBeNull();
  });

  it('补协议并去掉结尾斜杠（与 OpenList 适配器同一套规则）', () => {
    const result = normalizeMediaLibraryConfig({
      BaseUrl: 'openlist.example.com/',
      Enabled: true,
    });
    expect(result?.BaseUrl).toBe('https://openlist.example.com');
  });

  it('缺省字段有安全默认值', () => {
    const result = normalizeMediaLibraryConfig({
      BaseUrl: 'https://openlist.example.com',
    });
    expect(result).toEqual({
      Enabled: false,
      Type: 'openlist',
      BaseUrl: 'https://openlist.example.com',
      Token: '',
      RootPath: '/',
      AllowPrivateNetwork: false,
      UserId: '',
    });
  });

  it('根路径为空串时退回 /', () => {
    const result = normalizeMediaLibraryConfig({
      BaseUrl: 'https://x.com',
      RootPath: '  ',
    });
    expect(result?.RootPath).toBe('/');
  });

  it('开关关闭不算不可用：配置要留着，只是不生效', () => {
    const result = normalizeMediaLibraryConfig({
      BaseUrl: 'https://x.com',
      Enabled: false,
    });
    expect(result).not.toBeNull();
    expect(isMediaLibraryUsable(result)).toBe(false);
  });

  it('空配置模板默认关闭且类型是 openlist', () => {
    const empty = createEmptyMediaLibraryConfig();
    expect(empty.Enabled).toBe(false);
    expect(empty.Type).toBe('openlist');
    expect(empty.BaseUrl).toBe('');
  });
});

describe('可用性与类型转换', () => {
  const usable = {
    Enabled: true,
    Type: 'openlist' as const,
    BaseUrl: 'https://x.com',
    Token: 't',
    RootPath: '/movie',
    AllowPrivateNetwork: true,
  };

  it('启用且有地址才算可用', () => {
    expect(isMediaLibraryUsable(usable)).toBe(true);
    expect(isMediaLibraryUsable({ ...usable, Enabled: false })).toBe(false);
    expect(isMediaLibraryUsable(null)).toBe(false);
    expect(isMediaLibraryUsable(undefined)).toBe(false);
  });

  it('转成 OpenList 配置时带上根路径与内网开关', () => {
    expect(toOpenListConfig(usable)).toEqual({
      baseUrl: 'https://x.com',
      token: 't',
      rootPath: '/movie',
      allowPrivateNetwork: true,
    });
  });

  it('类型不是 openlist 时不产出 OpenList 配置', () => {
    expect(toOpenListConfig({ ...usable, Type: 'emby' })).toBeNull();
  });

  it('地址为空时不产出 OpenList 配置', () => {
    expect(toOpenListConfig({ ...usable, BaseUrl: '' })).toBeNull();
    expect(toOpenListConfig(null)).toBeNull();
  });
});

describe('下发浏览器的摘要', () => {
  it('只含开关与类型，不含地址与令牌', () => {
    const summary = summarizeMediaLibrary({
      Enabled: true,
      Type: 'openlist',
      BaseUrl: 'https://secret.example.com',
      Token: 'super-secret-token',
      RootPath: '/',
      AllowPrivateNetwork: false,
    });
    expect(summary).toEqual({ Enabled: true, Type: 'openlist', Configured: true });
    expect(JSON.stringify(summary)).not.toContain('super-secret-token');
    expect(JSON.stringify(summary)).not.toContain('secret.example.com');
  });

  it('停用或没地址时 Enabled 为 false', () => {
    expect(
      summarizeMediaLibrary({
        Enabled: false,
        Type: 'openlist',
        BaseUrl: 'https://x.com',
        Token: '',
        RootPath: '/',
        AllowPrivateNetwork: false,
      }).Enabled
    ).toBe(false);
    expect(summarizeMediaLibrary(null)).toEqual({
      Enabled: false,
      Type: 'openlist',
      Configured: false,
    });
  });
});
