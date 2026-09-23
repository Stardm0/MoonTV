import {
  buildLibraryImageUrl,
  isImageFile,
  LIBRARY_IMAGE_ENDPOINT,
  parseLibraryImageParams,
  pickCoverFromItems,
} from '@/lib/library-image';

const items = [
  { name: '沙丘2.mkv', size: 1, is_dir: false },
  { name: '沙丘2.jpg', size: 1, is_dir: false },
  { name: 'poster.png', size: 1, is_dir: false },
  { name: '幕后花絮.mp4', size: 1, is_dir: false },
  { name: '花絮封面.jpg', size: 1, is_dir: false },
  { name: 'Season 01', size: 0, is_dir: true },
];

describe('影库封面文件识别', () => {
  it('常见图片扩展名算封面', () => {
    expect(isImageFile('poster.jpg')).toBe(true);
    expect(isImageFile('cover.JPEG')).toBe(true);
    expect(isImageFile('a.webp')).toBe(true);
    expect(isImageFile('b.avif')).toBe(true);
  });

  it('视频与无后缀文件不算封面', () => {
    expect(isImageFile('movie.mkv')).toBe(false);
    expect(isImageFile('nomedia')).toBe(false);
    // 点开头但没有名字的文件（.png）不算
    expect(isImageFile('.png')).toBe(false);
  });
});

describe('影库封面挑选', () => {
  it('非数组输入返回空串', () => {
    expect(pickCoverFromItems(null)).toBe('');
    expect(pickCoverFromItems(undefined)).toBe('');
    expect(pickCoverFromItems('abc')).toBe('');
  });

  it('目录里没有任何图片时返回空串', () => {
    expect(pickCoverFromItems([{ name: 'a.mkv', is_dir: false }])).toBe('');
  });

  it('目录项本身被排除（只认文件）', () => {
    expect(
      pickCoverFromItems([{ name: 'poster.jpg', is_dir: true }], undefined, false)
    ).toBe('');
  });

  it('同名图片优先于通用封面名', () => {
    expect(pickCoverFromItems(items, '沙丘2.mkv')).toBe('沙丘2.jpg');
  });

  it('没有同名图时退回 poster / cover 这类通用名', () => {
    expect(pickCoverFromItems(items, '其它影片.mkv')).toBe('poster.png');
  });

  it('带封面后缀的同名图也算数', () => {
    const list = [
      { name: '沙丘2.mkv', is_dir: false },
      { name: '沙丘2-poster.jpg', is_dir: false },
      { name: 'folder.jpg', is_dir: false },
    ];
    expect(pickCoverFromItems(list, '沙丘2.mkv')).toBe('沙丘2-poster.jpg');
  });

  it('同名但后缀不是封面词的剧照不算封面', () => {
    const list = [
      { name: '沙丘2.mkv', is_dir: false },
      { name: '沙丘2剧照01.jpg', is_dir: false },
    ];
    expect(pickCoverFromItems(list, '沙丘2.mkv', false)).toBe('');
    // 即便允许退化，也只能拿到那张剧照本身
    expect(pickCoverFromItems(list, '沙丘2.mkv', true)).toBe('沙丘2剧照01.jpg');
  });

  it('认得中文封面名', () => {
    const list = [
      { name: '剧.mkv', is_dir: false },
      { name: '封面.jpg', is_dir: false },
    ];
    expect(pickCoverFromItems(list, '剧.mkv')).toBe('封面.jpg');
  });

  it('严格模式下不退化到无关图片（交给 UI 出渐变占位）', () => {
    const list = [
      { name: 'a.mkv', is_dir: false },
      { name: '截图.png', is_dir: false },
    ];
    expect(pickCoverFromItems(list, 'a.mkv', false)).toBe('');
    // 允许退化时才会拿第一张图片兜底
    expect(pickCoverFromItems(list, 'a.mkv', true)).toBe('截图.png');
  });
});

describe('影库封面地址', () => {
  it('走同源代理并对路径编码', () => {
    expect(buildLibraryImageUrl('/电影/沙丘2/poster.jpg')).toBe(
      `${LIBRARY_IMAGE_ENDPOINT}?p=${encodeURIComponent('/电影/沙丘2/poster.jpg')}`
    );
  });

  it('空路径返回空串（调用方据此用占位）', () => {
    expect(buildLibraryImageUrl('')).toBe('');
  });
});

describe('封面代理参数校验', () => {
  const parse = (params: Record<string, string>) =>
    parseLibraryImageParams({
      get: (key: string) => params[key] ?? null,
    });

  it('缺少路径时报错', () => {
    expect(parse({})).toEqual({ error: '缺少图片路径' });
    expect(parse({ p: '   ' })).toEqual({ error: '缺少图片路径' });
  });

  it('不接受相对路径（避免出现另一处开放代理）', () => {
    expect(parse({ p: 'movie/poster.jpg' })).toEqual({
      error: '图片路径必须是绝对路径',
    });
  });

  it('拒绝超长路径', () => {
    expect(parse({ p: `/${'a'.repeat(3000)}` })).toEqual({
      error: '图片路径过长',
    });
  });

  it('正常路径返回去空白后的值', () => {
    expect(parse({ p: ' /电影/poster.jpg ' })).toEqual({
      path: '/电影/poster.jpg',
    });
  });
});
