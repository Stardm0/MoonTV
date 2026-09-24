import {
  buildDrivePath,
  getDriveNameFromPath,
  joinOpenListPath,
  normalizeRootPath,
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
