import {
  buildOpenListBody,
  buildPlayableUrl,
  clearOpenListConfigCookie,
  encodeOpenListPath,
  extractYearFromName,
  getFileExtension,
  isMediaItem,
  isSubtitleFile,
  isVideoFile,
  joinOpenListPath,
  mapOpenListSearchEntries,
  mapOpenListSearchItems,
  naturalCompare,
  normalizeBaseUrl,
  OPENLIST_COOKIE_KEY,
  OPENLIST_SOURCE,
  OPENLIST_SOURCE_NAME,
  readOpenListConfigFromCookie,
  resolveOpenListEntryPath,
  sortOpenListItems,
  stripFileExtension,
  writeOpenListConfigToCookie,
} from '@/lib/openlist';

describe('getFileExtension', () => {
  it('常规文件名取到小写扩展名', () => {
    expect(getFileExtension('movie.MKV')).toBe('mkv');
    expect(getFileExtension('a.b.mp4')).toBe('mp4');
  });

  it('无扩展名与点开头隐藏文件都返回空串', () => {
    expect(getFileExtension('README')).toBe('');
    expect(getFileExtension('.nomedia')).toBe('');
    expect(getFileExtension('folder.')).toBe('');
  });

  it('带路径时只取最后一段', () => {
    expect(getFileExtension('/115/电影/xx.mkv')).toBe('mkv');
  });
});

describe('isVideoFile / isSubtitleFile / isMediaItem', () => {
  it('识别常见视频与字幕', () => {
    expect(isVideoFile('a.mp4')).toBe(true);
    expect(isVideoFile('a.m2ts')).toBe(true);
    expect(isSubtitleFile('a.ass')).toBe(true);
    expect(isVideoFile('a.ass')).toBe(false);
  });

  it('目录一律算媒体项（可能装剧集），非视频文件不算', () => {
    expect(isMediaItem({ name: '剧集目录', is_dir: true })).toBe(true);
    expect(isMediaItem({ name: '说明.txt', is_dir: false })).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('补齐协议并去掉结尾斜杠', () => {
    expect(normalizeBaseUrl('openlist.example.com')).toBe(
      'https://openlist.example.com'
    );
    expect(normalizeBaseUrl('https://openlist.example.com///')).toBe(
      'https://openlist.example.com'
    );
  });

  it('保留显式 http（内网自建场景）', () => {
    expect(normalizeBaseUrl('http://192.168.1.10:5244')).toBe(
      'http://192.168.1.10:5244'
    );
  });

  it('空值返回空串', () => {
    expect(normalizeBaseUrl('   ')).toBe('');
  });
});

describe('joinOpenListPath', () => {
  it('根目录拼接不产生双斜杠', () => {
    expect(joinOpenListPath('/', '电影')).toBe('/电影');
    expect(joinOpenListPath('/电影', 'xx.mkv')).toBe('/电影/xx.mkv');
  });

  it('缺斜杠也能补上，空段被忽略', () => {
    expect(joinOpenListPath('电影', '子目录')).toBe('/电影/子目录');
    expect(joinOpenListPath('/电影/', '')).toBe('/电影');
  });
});

describe('naturalCompare', () => {
  it('数字按数值比：S1E2 在 S1E10 之前', () => {
    expect(naturalCompare('S01E02.mkv', 'S01E10.mkv')).toBeLessThan(0);
    expect(naturalCompare('第2集.mp4', '第10集.mp4')).toBeLessThan(0);
  });

  it('非数字按大小写不敏感比较', () => {
    expect(naturalCompare('Apple', 'banana')).toBeLessThan(0);
    expect(naturalCompare('same', 'same')).toBe(0);
  });

  it('位数相同时按数值比', () => {
    expect(naturalCompare('9.mp4', '10.mp4')).toBeLessThan(0);
  });
});

describe('sortOpenListItems', () => {
  it('目录在前，文件按自然序', () => {
    const sorted = sortOpenListItems([
      { name: 'S01E10.mkv', size: 1, is_dir: false },
      { name: '子目录', size: 0, is_dir: true },
      { name: 'S01E02.mkv', size: 1, is_dir: false },
    ]);
    expect(sorted.map((i) => i.name)).toEqual([
      '子目录',
      'S01E02.mkv',
      'S01E10.mkv',
    ]);
  });

  it('不修改原数组', () => {
    const original = [
      { name: 'b.mp4', size: 1, is_dir: false },
      { name: 'a.mp4', size: 1, is_dir: false },
    ];
    sortOpenListItems(original);
    expect(original[0].name).toBe('b.mp4');
  });
});

describe('encodeOpenListPath', () => {
  it('保留斜杠、逐段编码', () => {
    expect(encodeOpenListPath('/电影/第 1 集.mkv')).toBe(
      '/%E7%94%B5%E5%BD%B1/%E7%AC%AC%201%20%E9%9B%86.mkv'
    );
  });
});

describe('buildPlayableUrl', () => {
  it('有直链时优先用直链（速度最好）', () => {
    expect(buildPlayableUrl('https://ol.example.com', '/a.mkv', 's', 'https://cdn/a.mkv')).toBe(
      'https://cdn/a.mkv'
    );
  });

  it('无直链时拼带签名的 /d/ 地址', () => {
    expect(buildPlayableUrl('https://ol.example.com', '/电影/a.mkv', 'SIG')).toBe(
      'https://ol.example.com/d/%E7%94%B5%E5%BD%B1/a.mkv?sign=SIG'
    );
  });

  it('无签名时也能拼出地址（OpenList 未开启全局签名）', () => {
    expect(buildPlayableUrl('https://ol.example.com', '/a.mkv')).toBe(
      'https://ol.example.com/d/a.mkv'
    );
  });

  it('地址为空时返回空串', () => {
    expect(buildPlayableUrl('', '/a.mkv')).toBe('');
  });
});

describe('buildOpenListBody', () => {
  it('列目录/取详情只要 path（空 path 归一到 /）', () => {
    expect(buildOpenListBody('list', '/电影')).toEqual({
      path: '/电影',
      password: '',
    });
    expect(buildOpenListBody('get', '')).toEqual({ path: '/', password: '' });
  });

  it('搜索带 keyword 与分页', () => {
    expect(buildOpenListBody('search', '/115', '沙丘')).toEqual({
      path: '/115',
      keyword: '沙丘',
      scope: '0',
      page: 1,
      per_page: 40,
    });
  });
});

describe('stripFileExtension', () => {
  it('去掉尾部扩展名', () => {
    expect(stripFileExtension('沙丘.2024.mkv')).toBe('沙丘.2024');
    expect(stripFileExtension('a.mp4')).toBe('a');
  });

  it('没有扩展名时原样返回（目录名不受影响）', () => {
    expect(stripFileExtension('剧集目录')).toBe('剧集目录');
    expect(stripFileExtension('')).toBe('');
  });
});

describe('extractYearFromName', () => {
  it('从常见文件名里取到年份', () => {
    expect(extractYearFromName('沙丘.2024.1080p.mkv')).toBe('2024');
    expect(extractYearFromName('The.Matrix.1999.mkv')).toBe('1999');
  });

  it('分辨率不会被误当成年份', () => {
    expect(extractYearFromName('Demo.1920x1080.mkv')).toBe('');
  });

  it('多组数字时取第一组合法年份', () => {
    expect(extractYearFromName('2024.某片.2020.mkv')).toBe('2024');
  });

  it('没有年份时返回空串', () => {
    expect(extractYearFromName('某部片.mkv')).toBe('');
    expect(extractYearFromName('')).toBe('');
  });
});

describe('resolveOpenListEntryPath', () => {
  it('有 parent 时用 parent（搜索结果带所在目录）', () => {
    expect(
      resolveOpenListEntryPath({ name: '沙丘.mkv', parent: '/115/电影' }, '/')
    ).toBe('/115/电影/沙丘.mkv');
  });

  it('没有 parent 时退回搜索根路径', () => {
    expect(resolveOpenListEntryPath({ name: '沙丘.mkv' }, '/115')).toBe(
      '/115/沙丘.mkv'
    );
    expect(resolveOpenListEntryPath({ name: '沙丘.mkv', parent: '  ' }, '/')).toBe(
      '/沙丘.mkv'
    );
  });
});

describe('mapOpenListSearchItems', () => {
  it('视频文件映射成单集影片，目录映射成剧集', () => {
    const results = mapOpenListSearchItems(
      [
        { name: '沙丘.2024.mkv', size: 1, is_dir: false, thumb: 'https://t/1.jpg' },
        { name: '三体', size: 0, is_dir: true },
      ],
      '/115'
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: '/115/沙丘.2024.mkv',
      title: '沙丘.2024',
      poster: 'https://t/1.jpg',
      episodes: [''],
      source: OPENLIST_SOURCE,
      source_name: OPENLIST_SOURCE_NAME,
      year: '2024',
      class: '影片',
    });
    expect(results[1]).toMatchObject({
      id: '/115/三体',
      title: '三体',
      episodes: [],
      class: '剧集',
      year: '',
    });
  });

  it('非视频文件被丢弃，非法输入返回空数组', () => {
    expect(
      mapOpenListSearchItems(
        [{ name: '说明.txt', is_dir: false }, { name: 'cover.jpg', is_dir: false }],
        '/'
      )
    ).toEqual([]);
    expect(mapOpenListSearchItems(null, '/')).toEqual([]);
    expect(mapOpenListSearchItems('not-an-array', '/')).toEqual([]);
    expect(mapOpenListSearchItems([null, 1, { name: '' }], '/')).toEqual([]);
  });

  it('缺 parent 时用根路径兜底', () => {
    const results = mapOpenListSearchItems(
      [{ name: 'a.mp4', is_dir: false, parent: '/剧集/S1' }],
      '/'
    );
    expect(results[0].id).toBe('/剧集/S1/a.mp4');
  });
});

describe('影库连接配置 cookie 存取', () => {
  beforeEach(() => {
    clearOpenListConfigCookie();
    // jsdom 下 cookie 清理需要手动清空字符串
    document.cookie = `${OPENLIST_COOKIE_KEY}=; path=/; max-age=0`;
  });

  it('未配置时返回 null', () => {
    expect(readOpenListConfigFromCookie()).toBeNull();
  });

  it('写入后能读回，且地址被规范化', () => {
    writeOpenListConfigToCookie({
      baseUrl: 'openlist.example.com/',
      token: 'tok',
      rootPath: '/115',
      allowPrivateNetwork: false,
    });
    expect(readOpenListConfigFromCookie()).toEqual({
      baseUrl: 'https://openlist.example.com',
      token: 'tok',
      rootPath: '/115',
      allowPrivateNetwork: false,
    });
  });

  it('cookie 内容损坏时按未配置处理', () => {
    document.cookie = `${OPENLIST_COOKIE_KEY}=not-json; path=/`;
    expect(readOpenListConfigFromCookie()).toBeNull();
  });
});

describe('mapOpenListSearchEntries', () => {
  it('目录与视频文件都保留，并拼出完整路径', () => {
    expect(
      mapOpenListSearchEntries([
        { name: '沙丘', parent: '/115/电影', is_dir: true, size: 0 },
        { name: '沙丘2.mkv', parent: '/115/电影', is_dir: false, size: 123 },
      ])
    ).toEqual([
      {
        name: '沙丘',
        path: '/115/电影/沙丘',
        isDir: true,
        size: 0,
        parent: '/115/电影',
      },
      {
        name: '沙丘2.mkv',
        path: '/115/电影/沙丘2.mkv',
        isDir: false,
        size: 123,
        parent: '/115/电影',
      },
    ]);
  });

  it('非视频文件（字幕 / nfo）被丢弃', () => {
    expect(
      mapOpenListSearchEntries([
        { name: 'x.srt', parent: '/a', is_dir: false },
        { name: 'x.nfo', parent: '/a', is_dir: false },
      ])
    ).toEqual([]);
  });

  it('缺 parent 时退回搜索根路径', () => {
    const entries = mapOpenListSearchEntries(
      [{ name: 'a.mp4', is_dir: false }],
      '/media'
    );
    expect(entries[0].path).toBe('/media/a.mp4');
    expect(entries[0].parent).toBe('/media');
  });

  it('非数组与脏数据一律返回空数组', () => {
    expect(mapOpenListSearchEntries(null)).toEqual([]);
    expect(mapOpenListSearchEntries([null, 1, 'x', {}])).toEqual([]);
  });

  it('size 缺失或非数字时归零', () => {
    const entries = mapOpenListSearchEntries([
      { name: 'a.mp4', parent: '/', is_dir: false, size: 'x' },
    ]);
    expect(entries[0].size).toBe(0);
  });
});
