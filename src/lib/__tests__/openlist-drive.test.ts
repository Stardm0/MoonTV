import {
  buildDrivePath,
  getDriveNameFromPath,
  isOpenListSystemDir,
  joinOpenListPath,
  normalizeRootPath,
  relativeOpenListPath,
} from '@/lib/openlist';

describe('normalizeRootPath', () => {
  it('空串与斜杠都归一为根', () => {
    expect(normalizeRootPath('')).toBe('/');
    expect(normalizeRootPath('/')).toBe('/');
    expect(normalizeRootPath(undefined)).toBe('/');
  });

  it('去掉首尾多余斜杠并保留层级', () => {
    expect(normalizeRootPath('/media/')).toBe('/media');
    expect(normalizeRootPath('media')).toBe('/media');
    expect(normalizeRootPath('//媒体/网盘//')).toBe('/媒体/网盘');
  });
});

describe('getDriveNameFromPath', () => {
  it('根路径下的第一段就是网盘名', () => {
    expect(getDriveNameFromPath('/阿里云盘/电影', '/')).toBe('阿里云盘');
    expect(getDriveNameFromPath('/阿里云盘', '/')).toBe('阿里云盘');
  });

  it('在根目录（或更浅）时返回空串', () => {
    expect(getDriveNameFromPath('/', '/')).toBe('');
    expect(getDriveNameFromPath('', '/')).toBe('');
  });

  it('配置了子目录根路径时，只认根之下的第一段', () => {
    expect(getDriveNameFromPath('/media/115/电影', '/media')).toBe('115');
    expect(getDriveNameFromPath('/media', '/media')).toBe('');
  });

  it('路径不在根之下时返回空串（逐段比对，不吃前缀相似的路）', () => {
    expect(getDriveNameFromPath('/mediax/电影', '/media')).toBe('');
    expect(getDriveNameFromPath('/other/115', '/media')).toBe('');
  });
});

describe('buildDrivePath', () => {
  it('拼出网盘入口路径', () => {
    expect(buildDrivePath('/', '阿里云盘')).toBe('/阿里云盘');
    expect(buildDrivePath('/media', '115')).toBe('/media/115');
  });

  it('空名或带斜杠的名字视为非法，返回空串', () => {
    expect(buildDrivePath('/', '')).toBe('');
    expect(buildDrivePath('/', '  ')).toBe('');
    expect(buildDrivePath('/', 'a/b')).toBe('');
  });

  it('与 joinOpenListPath 结果一致（同一路径语义）', () => {
    expect(buildDrivePath('/media/', '115')).toBe(
      joinOpenListPath('/media', '115')
    );
  });
});

describe('isOpenListSystemDir', () => {
  it('识别回收站、缩略图缓存与系统目录', () => {
    expect(isOpenListSystemDir('#recycle')).toBe(true);
    expect(isOpenListSystemDir('#Recycle')).toBe(true);
    expect(isOpenListSystemDir('#回收站')).toBe(true);
    expect(isOpenListSystemDir('recycle')).toBe(true);
    expect(isOpenListSystemDir('$RECYCLE.BIN')).toBe(true);
    expect(isOpenListSystemDir('.@__thumb')).toBe(true);
    expect(isOpenListSystemDir('System Volume Information')).toBe(true);
  });

  it('普通目录不误伤', () => {
    expect(isOpenListSystemDir('漫长的季节')).toBe(false);
    expect(isOpenListSystemDir('S01')).toBe(false);
    expect(isOpenListSystemDir('第一季')).toBe(false);
  });
});

describe('relativeOpenListPath', () => {
  it('取播放目录之下的相对路径（用作选集标题）', () => {
    expect(
      relativeOpenListPath('/夸克网盘/漫长的季节/第一季/E01.mkv', '/夸克网盘/漫长的季节')
    ).toBe('第一季/E01.mkv');
    expect(relativeOpenListPath('/115/电影/a.mkv', '/')).toBe('115/电影/a.mkv');
  });

  it('路径不在播放目录之下时退回文件名', () => {
    expect(relativeOpenListPath('/other/a.mkv', '/夸克网盘')).toBe('a.mkv');
    expect(relativeOpenListPath('/夸克网盘x/a.mkv', '/夸克网盘')).toBe('a.mkv');
  });

  it('与播放目录相同（或更浅）时退回文件名', () => {
    expect(relativeOpenListPath('/夸克网盘', '/夸克网盘')).toBe('夸克网盘');
  });
});
