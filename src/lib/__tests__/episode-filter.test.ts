import {
  buildEpisodePageRanges,
  clearEpisodeFilterConfig,
  countEpisodePages,
  createEmptyEpisodeFilterConfig,
  createEpisodeFilterRule,
  doesEpisodeTitleMatchFilterRules,
  EPISODE_FILTER_STORAGE_KEY,
  EpisodeFilterConfig,
  EpisodeFilterRule,
  filterEpisodeIndexes,
  isEpisodeHiddenByFilter,
  isValidEpisodeRegex,
  loadEpisodeFilterConfig,
  MAX_EPISODE_FILTER_RULES,
  MAX_EPISODE_KEYWORD_LENGTH,
  normalizeEpisodeFilterConfig,
  normalizeEpisodeFilterRules,
  saveEpisodeFilterConfig,
  sliceEpisodePage,
} from '../episode-filter';

function rule(
  keyword: string,
  type: EpisodeFilterRule['type'] = 'normal',
  enabled = true,
  id = keyword
): EpisodeFilterRule {
  return { id, keyword, type, enabled };
}

function config(
  rules: EpisodeFilterRule[],
  reverseMode = false
): EpisodeFilterConfig {
  return { rules, reverseMode };
}

describe('isValidEpisodeRegex', () => {
  it('合法正则通过', () => {
    expect(isValidEpisodeRegex('^第\\d+集$')).toBe(true);
  });

  it('非法正则拒绝', () => {
    expect(isValidEpisodeRegex('(')).toBe(false);
    expect(isValidEpisodeRegex('')).toBe(false);
  });
});

describe('doesEpisodeTitleMatchFilterRules', () => {
  it('普通模式子串命中', () => {
    expect(
      doesEpisodeTitleMatchFilterRules('第01集 预告', config([rule('预告')]))
    ).toBe(true);
  });

  it('未命中返回 false', () => {
    expect(
      doesEpisodeTitleMatchFilterRules('第01集 正片', config([rule('预告')]))
    ).toBe(false);
  });

  it('禁用规则不生效', () => {
    expect(
      doesEpisodeTitleMatchFilterRules(
        '第01集 预告',
        config([rule('预告', 'normal', false)])
      )
    ).toBe(false);
  });

  it('正则模式命中', () => {
    expect(
      doesEpisodeTitleMatchFilterRules(
        '第01集',
        config([rule('^第\\d+集$', 'regex')])
      )
    ).toBe(true);
  });

  it('空标题不命中', () => {
    expect(doesEpisodeTitleMatchFilterRules('', config([rule('x')]))).toBe(false);
  });

  it('无配置不命中', () => {
    expect(doesEpisodeTitleMatchFilterRules('任意', null)).toBe(false);
    expect(doesEpisodeTitleMatchFilterRules('任意', undefined)).toBe(false);
  });

  it('非法正则不抛异常', () => {
    expect(() =>
      doesEpisodeTitleMatchFilterRules('任意', config([rule('(', 'regex')]))
    ).not.toThrow();
  });
});

describe('isEpisodeHiddenByFilter', () => {
  it('普通模式：命中则隐藏', () => {
    const c = config([rule('预告')]);
    expect(isEpisodeHiddenByFilter('第01集 预告', c)).toBe(true);
    expect(isEpisodeHiddenByFilter('第01集 正片', c)).toBe(false);
  });

  it('相反模式：只显示命中的', () => {
    const c = config([rule('主线')], true);
    expect(isEpisodeHiddenByFilter('第01集 主线', c)).toBe(false);
    expect(isEpisodeHiddenByFilter('第02集 支线', c)).toBe(true);
  });

  it('无规则时不过滤（即使开了相反模式）', () => {
    // 这是与参考实现的关键取舍：一打开相反模式就变成 0 集会像坏了
    expect(isEpisodeHiddenByFilter('任意标题', config([], true))).toBe(false);
    expect(isEpisodeHiddenByFilter('任意标题', config([]))).toBe(false);
    expect(isEpisodeHiddenByFilter('任意标题', null)).toBe(false);
  });

  it('规则全部禁用时等同于无规则', () => {
    const c = config([rule('预告', 'normal', false)], true);
    expect(isEpisodeHiddenByFilter('任意标题', c)).toBe(false);
  });

  it('空配置对象不过滤', () => {
    expect(isEpisodeHiddenByFilter('任意', createEmptyEpisodeFilterConfig())).toBe(
      false
    );
  });
});

describe('filterEpisodeIndexes 保留原集数编号', () => {
  const titles = [
    '第01集 正片',
    '第02集 预告',
    '第03集 正片',
    '第04集 花絮',
    '第05集 正片',
  ];

  it('无规则时返回全量下标', () => {
    expect(filterEpisodeIndexes(titles, null)).toEqual([0, 1, 2, 3, 4]);
  });

  it('隐藏命中的集数，下标保持原值', () => {
    // 隐藏第 2 集(下标1) 和 第 4 集(下标3)，
    // 留下的必须是 0,2,4 —— 不能重新编号成 0,1,2
    const result = filterEpisodeIndexes(
      titles,
      config([rule('预告'), rule('花絮')])
    );
    expect(result).toEqual([0, 2, 4]);
  });

  it('相反模式只留命中的', () => {
    const result = filterEpisodeIndexes(titles, config([rule('正片')], true));
    expect(result).toEqual([0, 2, 4]);
  });

  it('全部命中时返回空数组', () => {
    const result = filterEpisodeIndexes(titles, config([rule('第')]));
    expect(result).toEqual([]);
  });

  it('空列表返回空数组', () => {
    expect(filterEpisodeIndexes([], config([rule('x')]))).toEqual([]);
  });

  it('非数组输入返回空数组', () => {
    expect(
      filterEpisodeIndexes(null as unknown as string[], null)
    ).toEqual([]);
  });

  it('规则全部禁用时返回全量', () => {
    const result = filterEpisodeIndexes(
      titles,
      config([rule('预告', 'normal', false)])
    );
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('normalizeEpisodeFilterRules 清洗', () => {
  it('非数组返回空', () => {
    expect(normalizeEpisodeFilterRules(null)).toEqual([]);
    expect(normalizeEpisodeFilterRules('x')).toEqual([]);
  });

  it('丢弃空关键字', () => {
    expect(normalizeEpisodeFilterRules([{ keyword: '  ' }])).toEqual([]);
  });

  it('丢弃非法正则', () => {
    const r = normalizeEpisodeFilterRules([
      { keyword: '(', type: 'regex' },
      { keyword: 'ok' },
    ]);
    expect(r).toHaveLength(1);
  });

  it('trim 关键字', () => {
    expect(normalizeEpisodeFilterRules([{ keyword: ' 预告 ' }])[0].keyword).toBe(
      '预告'
    );
  });

  it('截断超长关键字', () => {
    const long = 'x'.repeat(MAX_EPISODE_KEYWORD_LENGTH + 30);
    expect(
      normalizeEpisodeFilterRules([{ keyword: long }])[0].keyword
    ).toHaveLength(MAX_EPISODE_KEYWORD_LENGTH);
  });

  it('超出上限被截断', () => {
    const many = Array.from({ length: MAX_EPISODE_FILTER_RULES + 10 }, (_, i) => ({
      keyword: `k${i}`,
    }));
    expect(normalizeEpisodeFilterRules(many)).toHaveLength(
      MAX_EPISODE_FILTER_RULES
    );
  });

  it('重复 id 被替换', () => {
    const r = normalizeEpisodeFilterRules([
      { keyword: 'a', id: 'dup' },
      { keyword: 'b', id: 'dup' },
    ]);
    expect(r[0].id).not.toBe(r[1].id);
  });
});

describe('normalizeEpisodeFilterConfig', () => {
  it('非法输入返回空配置', () => {
    expect(normalizeEpisodeFilterConfig(null)).toEqual({
      rules: [],
      reverseMode: false,
    });
  });

  it('reverseMode 非 true 视为 false', () => {
    expect(normalizeEpisodeFilterConfig({ reverseMode: 'yes' }).reverseMode).toBe(
      false
    );
    expect(normalizeEpisodeFilterConfig({ reverseMode: true }).reverseMode).toBe(
      true
    );
  });
});

describe('持久化', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('保存后读回', () => {
    saveEpisodeFilterConfig(config([rule('预告', 'normal', true, 'a')], true));
    const loaded = loadEpisodeFilterConfig();
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.reverseMode).toBe(true);
  });

  it('全空配置不写存储', () => {
    saveEpisodeFilterConfig(config([]));
    expect(
      window.localStorage.getItem(EPISODE_FILTER_STORAGE_KEY)
    ).toBeNull();
  });

  it('只有相反模式时仍然写入', () => {
    // 相反模式本身是用户的一个设置，不能因为没规则就丢掉
    saveEpisodeFilterConfig(config([], true));
    expect(loadEpisodeFilterConfig().reverseMode).toBe(true);
  });

  it('损坏 JSON 回退空配置', () => {
    window.localStorage.setItem(EPISODE_FILTER_STORAGE_KEY, '{坏');
    expect(loadEpisodeFilterConfig()).toEqual({ rules: [], reverseMode: false });
  });

  it('clear 后读回空配置', () => {
    saveEpisodeFilterConfig(config([rule('预告')]));
    clearEpisodeFilterConfig();
    expect(loadEpisodeFilterConfig()).toEqual({ rules: [], reverseMode: false });
  });
});

describe('createEpisodeFilterRule', () => {
  it('创建成功', () => {
    expect(createEpisodeFilterRule('预告')).not.toBeNull();
  });

  it('空关键字返回 null', () => {
    expect(createEpisodeFilterRule('')).toBeNull();
  });

  it('非法正则返回 null', () => {
    expect(createEpisodeFilterRule('(', 'regex')).toBeNull();
  });
});

describe('countEpisodePages', () => {
  it('整除时页数正确', () => {
    expect(countEpisodePages(100, 50)).toBe(2);
  });

  it('有余数时向上取整', () => {
    expect(countEpisodePages(101, 50)).toBe(3);
  });

  it('空列表仍返回 1 页，避免渲染出空白分页', () => {
    expect(countEpisodePages(0, 50)).toBe(1);
  });

  it('每页 0 或负数时兜底为 1', () => {
    expect(countEpisodePages(10, 0)).toBe(10);
    expect(countEpisodePages(10, -5)).toBe(10);
  });
});

describe('buildEpisodePageRanges', () => {
  it('无间隔时标签就是常规区间', () => {
    const nums = Array.from({ length: 120 }, (_, i) => i + 1);
    expect(buildEpisodePageRanges(nums, 50)).toEqual([
      { start: 1, end: 50 },
      { start: 51, end: 100 },
      { start: 101, end: 120 },
    ]);
  });

  it('中间有空洞时标签用真实集号，不做算式计算', () => {
    // 编号 3、4、5 被隐藏。每页 3 个：第一页装 1/2/6，第二页装 7/8。
    // 标签的 end 若按算式算会写成 6，和网格里实际显示的最后一集（7）对不上。
    expect(buildEpisodePageRanges([1, 2, 6, 7, 8], 3)).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 8 },
    ]);
  });

  it('空数组返回空列表', () => {
    expect(buildEpisodePageRanges([], 50)).toEqual([]);
  });
});

describe('sliceEpisodePage', () => {
  const nums = [1, 2, 3, 4, 5, 6, 7];

  it('取第一页', () => {
    expect(sliceEpisodePage(nums, 0, 3)).toEqual([1, 2, 3]);
  });

  it('取中间页', () => {
    expect(sliceEpisodePage(nums, 1, 3)).toEqual([4, 5, 6]);
  });

  it('最后一页不足整页时只返回剩余部分', () => {
    expect(sliceEpisodePage(nums, 2, 3)).toEqual([7]);
  });

  it('越界返回空数组', () => {
    expect(sliceEpisodePage(nums, 9, 3)).toEqual([]);
  });

  it('负数页码当作第 0 页', () => {
    expect(sliceEpisodePage(nums, -1, 3)).toEqual([1, 2, 3]);
  });
});

describe('分页与过滤联动', () => {
  it('过滤后每页装的都是保留下来的集号，且编号不变', () => {
    const titles = [
      '第01集',
      '第02集 预告',
      '第03集',
      '第04集 花絮',
      '第05集',
    ];
    const cfg = config([rule('预告'), rule('花絮')]);

    const indexes = filterEpisodeIndexes(titles, cfg);
    const visible = indexes.map((i) => i + 1);

    // 第 2、4 集被隐藏，剩下的集号仍是 1/3/5 —— 不能重排成 1/2/3
    expect(visible).toEqual([1, 3, 5]);
    expect(buildEpisodePageRanges(visible, 2)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
    ]);
    expect(sliceEpisodePage(visible, 1, 2)).toEqual([5]);
  });
});
