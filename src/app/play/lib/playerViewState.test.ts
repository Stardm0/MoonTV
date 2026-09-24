/**
 * `playerViewState` 单测。
 *
 * 重点是把 `usePlayEngine.ts` 里散落的 4 处集数越界规则钉死 —— 这些规则
 * 分两套语义（一套含负数、一套不含），很容易在后人重构时"顺手统一"而改坏。
 */

import {
  deriveLoadingState,
  formatPlayError,
  getLoadingView,
  isValidEpisodeIndex,
  LOADING_MESSAGES,
  parsePreferBestSource,
  resolveEpisodeFallback,
  resolveTotalEpisodes,
  shouldClampEpisodeIndex,
  shouldFallbackEpisodeToLast,
} from './playerViewState';

describe('shouldFallbackEpisodeToLast', () => {
  it('空列表一律 false（没有"最后一集"可落）', () => {
    expect(shouldFallbackEpisodeToLast(0, 0)).toBe(false);
    expect(shouldFallbackEpisodeToLast(0, 5)).toBe(false);
  });

  it('索引等于集数即越界', () => {
    expect(shouldFallbackEpisodeToLast(3, 3)).toBe(true);
  });

  it('索引大于集数越界', () => {
    expect(shouldFallbackEpisodeToLast(3, 99)).toBe(true);
  });

  it('界内不触发', () => {
    expect(shouldFallbackEpisodeToLast(3, 0)).toBe(false);
    expect(shouldFallbackEpisodeToLast(3, 2)).toBe(false);
  });

  it('⚠️ 负数不触发 —— 这是它区别于 shouldClampEpisodeIndex 的关键', () => {
    expect(shouldFallbackEpisodeToLast(3, -1)).toBe(false);
    expect(shouldFallbackEpisodeToLast(3, -100)).toBe(false);
  });
});

describe('shouldClampEpisodeIndex', () => {
  it('空列表一律 false', () => {
    expect(shouldClampEpisodeIndex(0, -1)).toBe(false);
    expect(shouldClampEpisodeIndex(0, 0)).toBe(false);
  });

  it('负数触发（与 shouldFallbackEpisodeToLast 相反）', () => {
    expect(shouldClampEpisodeIndex(3, -1)).toBe(true);
    expect(shouldClampEpisodeIndex(3, -100)).toBe(true);
  });

  it('上界越界触发', () => {
    expect(shouldClampEpisodeIndex(3, 3)).toBe(true);
    expect(shouldClampEpisodeIndex(3, 99)).toBe(true);
  });

  it('界内不触发', () => {
    expect(shouldClampEpisodeIndex(3, 0)).toBe(false);
    expect(shouldClampEpisodeIndex(3, 2)).toBe(false);
  });

  it('两套判定在"负数"上必须分歧（回归保护）', () => {
    const cases: Array<[number, number]> = [
      [3, -1],
      [3, 0],
      [3, 3],
      [0, -1],
    ];
    for (const [len, idx] of cases) {
      const last = shouldFallbackEpisodeToLast(len, idx);
      const clamp = shouldClampEpisodeIndex(len, idx);
      if (idx < 0 && len > 0) {
        expect(last).toBe(false);
        expect(clamp).toBe(true);
      } else {
        expect(last).toBe(clamp);
      }
    }
  });
});

describe('resolveEpisodeFallback', () => {
  it('空列表返回 keep（无法判断）', () => {
    expect(resolveEpisodeFallback(0, 0)).toEqual({ action: 'keep' });
    expect(resolveEpisodeFallback(0, -1)).toEqual({ action: 'keep' });
    expect(resolveEpisodeFallback(0, 5)).toEqual({ action: 'keep' });
  });

  it('负数回到第一集', () => {
    expect(resolveEpisodeFallback(10, -1)).toEqual({ action: 'reset', index: 0 });
    expect(resolveEpisodeFallback(10, -99)).toEqual({
      action: 'reset',
      index: 0,
    });
  });

  it('超出上界落到最后一集', () => {
    expect(resolveEpisodeFallback(10, 10)).toEqual({
      action: 'clamp',
      index: 9,
    });
    expect(resolveEpisodeFallback(10, 999)).toEqual({
      action: 'clamp',
      index: 9,
    });
  });

  it('界内保持不动', () => {
    expect(resolveEpisodeFallback(10, 0)).toEqual({ action: 'keep' });
    expect(resolveEpisodeFallback(10, 9)).toEqual({ action: 'keep' });
  });

  it('单集剧：索引 0 合法，索引 1 落到 0', () => {
    expect(resolveEpisodeFallback(1, 0)).toEqual({ action: 'keep' });
    expect(resolveEpisodeFallback(1, 1)).toEqual({ action: 'clamp', index: 0 });
    expect(resolveEpisodeFallback(1, -1)).toEqual({ action: 'reset', index: 0 });
  });
});

describe('isValidEpisodeIndex', () => {
  it('空列表无有效索引', () => {
    expect(isValidEpisodeIndex(0, 0)).toBe(false);
    expect(isValidEpisodeIndex(0, -1)).toBe(false);
  });

  it('闭开区间 [0, length)', () => {
    expect(isValidEpisodeIndex(5, -1)).toBe(false);
    expect(isValidEpisodeIndex(5, 0)).toBe(true);
    expect(isValidEpisodeIndex(5, 4)).toBe(true);
    expect(isValidEpisodeIndex(5, 5)).toBe(false);
  });

  it('与 resolveEpisodeFallback 的 keep 判定一致（回归保护）', () => {
    // ⚠️ 只在「列表非空 + 索引非负」时等价，两个边界各自有理：
    //    - 负数：isValidEpisodeIndex 说"无效"，resolveEpisodeFallback 说"reset"
    //      —— 结论都是"不能用原索引"，但一个拒绝、一个给替代值。
    //    - 空列表：isValidEpisodeIndex 说"无有效索引"，而 resolveEpisodeFallback
    //      说"无法判断（keep）" —— 因为空列表根本不存在可回退的目标。
    //    这里只断言真正等价的区间，不把三套语义硬拧成一条不变式。
    for (let len = 1; len <= 6; len++) {
      for (let idx = 0; idx <= 8; idx++) {
        const keep = resolveEpisodeFallback(len, idx).action === 'keep';
        expect(isValidEpisodeIndex(len, idx)).toBe(keep);
      }
    }
  });

  it('空列表：isValid=false 但 fallback=keep（边界语义差异，刻意保留）', () => {
    expect(isValidEpisodeIndex(0, 0)).toBe(false);
    expect(resolveEpisodeFallback(0, 0)).toEqual({ action: 'keep' });
  });

  it('负数一律无效', () => {
    for (let len = 0; len <= 6; len++) {
      expect(isValidEpisodeIndex(len, -1)).toBe(false);
      expect(isValidEpisodeIndex(len, -99)).toBe(false);
    }
  });
});

describe('deriveLoadingState', () => {
  it('无任何参数返回 null（调用方据此报"缺少必要参数"）', () => {
    expect(
      deriveLoadingState({ hasDetailTarget: false, hasAnyParam: false })
    ).toBeNull();
  });

  it('有 source + id 走 fetching', () => {
    expect(
      deriveLoadingState({ hasDetailTarget: true, hasAnyParam: true })
    ).toEqual({ stage: 'fetching', message: LOADING_MESSAGES.fetching });
  });

  it('只有标题走 searching', () => {
    expect(
      deriveLoadingState({ hasDetailTarget: false, hasAnyParam: true })
    ).toEqual({ stage: 'searching', message: LOADING_MESSAGES.searching });
  });

  it('preferring 优先级高于 fetching', () => {
    expect(
      deriveLoadingState({
        hasDetailTarget: true,
        hasAnyParam: true,
        preferring: true,
      })
    ).toEqual({ stage: 'preferring', message: LOADING_MESSAGES.preferring });
  });

  it('缺参数时 preferring 也不生效', () => {
    expect(
      deriveLoadingState({
        hasDetailTarget: false,
        hasAnyParam: false,
        preferring: true,
      })
    ).toBeNull();
  });

  it('stage 与 message 永远配套', () => {
    const views = [
      deriveLoadingState({ hasDetailTarget: true, hasAnyParam: true }),
      deriveLoadingState({ hasDetailTarget: false, hasAnyParam: true }),
      deriveLoadingState({
        hasDetailTarget: false,
        hasAnyParam: true,
        preferring: true,
      }),
    ];
    for (const view of views) {
      if (view === null) throw new Error('预期非 null');
      expect(view.message).toBe(LOADING_MESSAGES[view.stage]);
    }
  });
});

describe('getLoadingView', () => {
  it('四个阶段的 stage / message 都配套', () => {
    for (const stage of [
      'searching',
      'fetching',
      'preferring',
      'ready',
    ] as const) {
      expect(getLoadingView(stage)).toEqual({
        stage,
        message: LOADING_MESSAGES[stage],
      });
    }
  });

  it('preferring 视图与 deriveLoadingState 的 preferring 分支一致', () => {
    expect(getLoadingView('preferring')).toEqual(
      deriveLoadingState({
        hasDetailTarget: true,
        hasAnyParam: true,
        preferring: true,
      })
    );
  });

  it('永不返回 null（调用方无需断言）', () => {
    expect(getLoadingView('ready')).not.toBeNull();
  });
});

describe('formatPlayError', () => {
  it('固定文案', () => {
    expect(formatPlayError('missing-params')).toBe('缺少必要参数');
    expect(formatPlayError('no-match')).toBe('未找到匹配结果');
    expect(formatPlayError('invalid-video-url')).toBe('视频地址无效');
  });

  it('选集索引错误带集数', () => {
    expect(
      formatPlayError('invalid-episode-index', { totalEpisodes: 24 })
    ).toBe('选集索引无效，当前共 24 集');
  });

  it('缺 context 时集数兜底为 0', () => {
    expect(formatPlayError('invalid-episode-index')).toBe(
      '选集索引无效，当前共 0 集'
    );
  });

  it('totalEpisodes 为 0 时不吞掉', () => {
    expect(
      formatPlayError('invalid-episode-index', { totalEpisodes: 0 })
    ).toBe('选集索引无效，当前共 0 集');
  });
});

describe('resolveTotalEpisodes', () => {
  it('null / undefined → 0', () => {
    expect(resolveTotalEpisodes(null)).toBe(0);
    expect(resolveTotalEpisodes(undefined)).toBe(0);
  });

  it('无 episodes 字段 → 0', () => {
    expect(resolveTotalEpisodes({})).toBe(0);
    expect(resolveTotalEpisodes({ episodes: undefined })).toBe(0);
  });

  it('空数组 → 0', () => {
    expect(resolveTotalEpisodes({ episodes: [] })).toBe(0);
  });

  it('返回真实长度', () => {
    expect(resolveTotalEpisodes({ episodes: [1, 2, 3] })).toBe(3);
  });
});

describe('parsePreferBestSource', () => {
  it('未存过（null）→ false', () => {
    expect(parsePreferBestSource(null)).toBe(false);
  });

  it('JSON true → true', () => {
    expect(parsePreferBestSource('true')).toBe(true);
  });

  it('JSON false → false', () => {
    expect(parsePreferBestSource('false')).toBe(false);
  });

  it('⚠️ 非 JSON 的字符串 "true" 会被解析成 true（JSON.parse 接受裸 true）', () => {
    // JSON.parse('true') 合法，所以这里其实是 true
    expect(parsePreferBestSource('true')).toBe(true);
  });

  it('脏数据（非 JSON）→ false，不抛异常', () => {
    expect(parsePreferBestSource('')).toBe(false);
    expect(parsePreferBestSource('yes')).toBe(false);
    expect(parsePreferBestSource('{')).toBe(false);
    expect(parsePreferBestSource('undefined')).toBe(false);
  });

  it('非布尔的合法 JSON 值一律 false', () => {
    expect(parsePreferBestSource('1')).toBe(false);
    expect(parsePreferBestSource('0')).toBe(false);
    expect(parsePreferBestSource('"true"')).toBe(false);
    expect(parsePreferBestSource('null')).toBe(false);
    expect(parsePreferBestSource('{}')).toBe(false);
    expect(parsePreferBestSource('[]')).toBe(false);
  });
});
