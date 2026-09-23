import {
  buildPlayableUrl,
  clearOpenListConfigCookie,
  encodeOpenListPath,
  getFileExtension,
  isMediaItem,
  isSubtitleFile,
  isVideoFile,
  joinOpenListPath,
  naturalCompare,
  normalizeBaseUrl,
  OPENLIST_COOKIE_KEY,
  readOpenListConfigFromCookie,
  sortOpenListItems,
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
