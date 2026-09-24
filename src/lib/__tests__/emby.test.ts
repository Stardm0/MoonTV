import {
  buildEmbyImageUrl,
  buildEmbySearchParams,
  buildEmbyStreamUrl,
  EMBY_SOURCE,
  EMBY_SOURCE_NAME,
  isEmbyMovie,
  isEmbySeries,
  mapEmbyDetailToResult,
  mapEmbyItemsToSearchResults,
} from '@/lib/emby';

const movie = {
  Id: 'm1',
  Name: '流浪地球 2',
  Type: 'Movie',
  ProductionYear: 2023,
  Overview: '简介',
  MediaSources: [{ Id: 'ms1', Container: 'mkv' }],
};

const series = {
  Id: 's1',
  Name: '漫长的季节',
  Type: 'Series',
  ProductionYear: 2023,
};

const episodes = [
  { Id: 'e1', Name: '第一集', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1, MediaSources: [{ Id: 'mse1' }] },
  { Id: 'e2', Name: '第二集', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 2 },
];

describe('Emby 条目类型判断', () => {
  it('认得电影与剧集', () => {
    expect(isEmbyMovie(movie)).toBe(true);
    expect(isEmbyMovie(series)).toBe(false);
    expect(isEmbySeries(series)).toBe(true);
    expect(isEmbySeries(movie)).toBe(false);
  });

  it('Episode 既不是电影也不是剧集（只在详情展开里出现）', () => {
    expect(isEmbyMovie(episodes[0])).toBe(false);
    expect(isEmbySeries(episodes[0])).toBe(false);
  });
});

describe('Emby 搜索结果映射', () => {
  it('非数组输入返回空', () => {
    expect(mapEmbyItemsToSearchResults(null)).toEqual([]);
    expect(mapEmbyItemsToSearchResults('x')).toEqual([]);
  });

  it('电影映射为单集影片，剧集映射为剧集（空集数）', () => {
    const results = mapEmbyItemsToSearchResults([movie, series]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'm1',
      title: '流浪地球 2',
      source: EMBY_SOURCE,
      source_name: EMBY_SOURCE_NAME,
      class: '影片',
      year: '2023',
    });
    expect(results[0].episodes).toEqual(['']);
    expect(results[1]).toMatchObject({
      id: 's1',
      title: '漫长的季节',
      class: '剧集',
    });
    expect(results[1].episodes).toEqual([]);
  });

  it('海报走同源代理（不直连影库）', () => {
    const results = mapEmbyItemsToSearchResults([movie]);
    expect(results[0].poster).toBe('/api/library-image?e=m1');
  });

  it('缺 Id / Name 或非影片类型的条目被丢弃', () => {
    const results = mapEmbyItemsToSearchResults([
      { Id: 'x1', Name: '音乐', Type: 'MusicAlbum' },
      { Id: '', Name: '无ID', Type: 'Movie' },
      { Name: '无条目', Type: 'Movie' },
      null,
    ]);
    expect(results).toEqual([]);
  });
});

describe('Emby 播放直链', () => {
  it('带 api_key 与 static 参数；mediaSourceId 不同于条目时一并下发', () => {
    const url = buildEmbyStreamUrl('https://emby.example.com', 'm1', 'KEY', 'ms1');
    expect(url).toContain('https://emby.example.com/Videos/m1/stream?');
    expect(url).toContain('static=true');
    expect(url).toContain('api_key=KEY');
    expect(url).toContain('mediaSourceId=ms1');
  });

  it('mediaSourceId 与条目相同时不重复下发', () => {
    const url = buildEmbyStreamUrl('https://emby.example.com', 'm1', 'KEY', 'm1');
    expect(url).not.toContain('mediaSourceId');
  });

  it('缺地址 / 条目 / key 时返回空串', () => {
    expect(buildEmbyStreamUrl('', 'm1', 'KEY')).toBe('');
    expect(buildEmbyStreamUrl('https://e.com', '', 'KEY')).toBe('');
    expect(buildEmbyStreamUrl('https://e.com', 'm1', '')).toBe('');
  });

  it('地址缺协议时补 https，尾斜杠被去掉', () => {
    const url = buildEmbyStreamUrl('emby.example.com/', 'm1', 'KEY');
    expect(url.startsWith('https://emby.example.com/Videos/m1/stream?')).toBe(true);
  });
});

describe('Emby 详情映射', () => {
  const config = { baseUrl: 'https://emby.example.com', token: 'KEY' };

  it('电影 → 单集直链', () => {
    const result = mapEmbyDetailToResult(movie, null, config);
    expect(result).not.toBeNull();
    expect(result?.episodes).toHaveLength(1);
    expect(result?.episodes[0]).toContain('/Videos/m1/stream?');
    expect(result?.episodes_titles).toEqual(['流浪地球 2']);
    expect(result?.poster).toBe(buildEmbyImageUrl('m1'));
  });

  it('剧集 → 展开 Episode 列表，标题带 S/E 编号', () => {
    const result = mapEmbyDetailToResult(series, episodes, config);
    expect(result?.episodes).toHaveLength(2);
    expect(result?.episodes_titles[0]).toContain('S1E1');
    expect(result?.episodes_titles[1]).toContain('S1E2');
    // 第一集的 mediaSourceId 取自 MediaSources
    expect(result?.episodes[0]).toContain('mediaSourceId=mse1');
    expect(result?.episodes[1]).not.toContain('mediaSourceId');
  });

  it('剧集的详情标题用剧集名', () => {
    const result = mapEmbyDetailToResult(
      series,
      episodes,
      config
    );
    expect(result?.title).toBe('漫长的季节');
  });

  it('没有可播放集数时返回 null（404 语义）', () => {
    expect(mapEmbyDetailToResult(series, [], config)).toBeNull();
    expect(
      mapEmbyDetailToResult({ Id: 'x', Name: 'x', Type: 'Series' }, null, config)
    ).toBeNull();
  });
});

describe('Emby 搜索参数', () => {
  it('只搜电影与剧集，带年份与简介字段', () => {
    const params = buildEmbySearchParams('沙丘');
    expect(params).toMatchObject({
      searchTerm: '沙丘',
      IncludeItemTypes: 'Movie,Series',
      Recursive: 'true',
      Fields: 'ProductionYear,Overview',
    });
    expect(params.Limit).toBe('24');
  });
});
