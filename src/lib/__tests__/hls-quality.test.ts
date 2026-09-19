/**
 * 「画质档位」纯逻辑回归测试（P1-6 / P1-9）。
 *
 * 重点覆盖：
 *  1. 标准分辨率名（8K / 4K / 2K，以及 1078 → 1080P 的归并）
 *  2. **源站 master 缺 RESOLUTION 时按码率推断档位**——P1-9 修的就是这条：
 *     不推断的话菜单会退化成「档位 1」，记忆与预取联动会一起失效
 *  3. 画质档位中文名 + 分辨率的两段式文案（`高清 1080P`）
 *  4. 「最高画质」哨兵在不同码率视频里都落到该视频最高档
 *  5. selector 选项的**展示顺序**（高度降序）与**value 仍是原始下标**
 */

import {
  AUTO_LEVEL,
  buildQualityOptions,
  describeQualityPreference,
  formatLevelLabel,
  formatQualityLabel,
  formatResolutionName,
  inferHeightFromBitrate,
  MAX_LEVEL,
  MAX_QUALITY_HEIGHT,
  pickHighestLevelIndex,
  pickLevelIndex,
  qualityTierOf,
  resolveLevelHeight,
} from '../hls-quality';

const LADDER = [
  { height: 1080, width: 1920, bitrate: 5_000_000 },
  { height: 720, width: 1280, bitrate: 2_800_000 },
  { height: 480, width: 854, bitrate: 1_200_000 },
  { height: 360, width: 640, bitrate: 700_000 },
];

describe('formatResolutionName', () => {
  it('识别标准分辨率名，最高支持 8K', () => {
    expect(formatResolutionName(4320)).toBe('8K');
    expect(formatResolutionName(2880)).toBe('5K');
    expect(formatResolutionName(2160)).toBe('4K');
    expect(formatResolutionName(1440)).toBe('2K');
    expect(formatResolutionName(1080)).toBe('1080P');
    expect(formatResolutionName(720)).toBe('720P');
    expect(formatResolutionName(480)).toBe('480P');
    expect(formatResolutionName(360)).toBe('360P');
  });

  it('把源站常见的非标准高度归并到最近的上一档', () => {
    expect(formatResolutionName(1078)).toBe('1080P');
    expect(formatResolutionName(2144)).toBe('4K');
  });

  it('完全对不上阶梯的高度回落为 {height}P，非法值返回空串', () => {
    expect(formatResolutionName(100)).toBe('100P');
    expect(formatResolutionName(0)).toBe('');
    expect(formatResolutionName(Number.NaN)).toBe('');
  });
});

describe('qualityTierOf', () => {
  it('按画面高度给出画质档位中文名', () => {
    expect(qualityTierOf(2160)).toBe('超高清');
    expect(qualityTierOf(4320)).toBe('超高清');
    expect(qualityTierOf(1080)).toBe('高清');
    expect(qualityTierOf(720)).toBe('准高清');
    expect(qualityTierOf(480)).toBe('标清');
    expect(qualityTierOf(360)).toBe('流畅');
    expect(qualityTierOf(240)).toBe('省流');
  });

  it('比最低档还低的给兜底名，非法值返回空串', () => {
    expect(qualityTierOf(144)).toBe('极速');
    expect(qualityTierOf(0)).toBe('');
  });
});

describe('inferHeightFromBitrate', () => {
  it('按码率阶梯推断画面高度', () => {
    expect(inferHeightFromBitrate(5_200_000)).toBe(1080);
    expect(inferHeightFromBitrate(2_400_000)).toBe(720);
    expect(inferHeightFromBitrate(1_100_000)).toBe(480);
    expect(inferHeightFromBitrate(700_000)).toBe(360);
    expect(inferHeightFromBitrate(300_000)).toBe(240);
  });

  it('极低码率给最低推断档，无码率信息返回 0', () => {
    expect(inferHeightFromBitrate(120_000)).toBe(144);
    expect(inferHeightFromBitrate(0)).toBe(0);
    expect(inferHeightFromBitrate(null)).toBe(0);
    expect(inferHeightFromBitrate(Number.NaN)).toBe(0);
  });
});

describe('resolveLevelHeight', () => {
  it('优先用真实 height', () => {
    expect(resolveLevelHeight({ height: 1080, bitrate: 900_000 })).toBe(1080);
  });

  it('height 缺失时按码率推断（源站只给 BANDWIDTH 的场景）', () => {
    expect(resolveLevelHeight({ bitrate: 5_200_000 })).toBe(1080);
    expect(resolveLevelHeight({ bitrate: 1_100_000 })).toBe(480);
    expect(resolveLevelHeight({ height: 0, bitrate: 2_400_000 })).toBe(720);
  });

  it('两条路径都拿不到时返回 0', () => {
    expect(resolveLevelHeight({})).toBe(0);
    expect(resolveLevelHeight(null)).toBe(0);
  });
});

describe('formatQualityLabel', () => {
  it('输出「档位 分辨率」两段式文案', () => {
    expect(formatQualityLabel(2160)).toBe('超高清 4K');
    expect(formatQualityLabel(1080)).toBe('高清 1080P');
    expect(formatQualityLabel(720)).toBe('准高清 720P');
    expect(formatQualityLabel(480)).toBe('标清 480P');
    expect(formatQualityLabel(360)).toBe('流畅 360P');
    expect(formatQualityLabel(0)).toBe('');
  });
});

describe('pickHighestLevelIndex', () => {
  it('取画面最高的档位', () => {
    expect(pickHighestLevelIndex(LADDER)).toBe(0);
  });

  it('同高度取码率最高的那一档', () => {
    const levels = [
      { height: 1080, bitrate: 3_000_000 },
      { height: 1080, bitrate: 6_000_000 },
      { height: 720, bitrate: 2_000_000 },
    ];
    expect(pickHighestLevelIndex(levels)).toBe(1);
  });

  it('源站只给带宽时也能按码率推断出最高档', () => {
    expect(
      pickHighestLevelIndex([{ bitrate: 1_100_000 }, { bitrate: 5_200_000 }])
    ).toBe(1);
  });

  it('完全没有分辨率也没有码率信息时回退自动', () => {
    expect(pickHighestLevelIndex([])).toBe(AUTO_LEVEL);
    expect(pickHighestLevelIndex([{ bitrate: 0 }])).toBe(AUTO_LEVEL);
  });
});

describe('「最高画质」哨兵在跨码率视频上的语义', () => {
  it('请求 8K 时落到该视频实际存在的最高档', () => {
    expect(pickLevelIndex(LADDER, MAX_QUALITY_HEIGHT)).toBe(0);
  });

  it('换到一个最高只有 720P 的视频时，落到这个视频的最高档', () => {
    const sdOnly = [
      { height: 720, bitrate: 2_800_000 },
      { height: 480, bitrate: 1_200_000 },
    ];
    expect(pickLevelIndex(sdOnly, MAX_QUALITY_HEIGHT)).toBe(0);
  });

  it('视频真的有 8K 时精确命中 8K', () => {
    const with8k = [
      { height: 1080, bitrate: 5_000_000 },
      { height: 4320, bitrate: 60_000_000 },
    ];
    expect(pickLevelIndex(with8k, MAX_QUALITY_HEIGHT)).toBe(1);
  });
});

describe('buildQualityOptions', () => {
  it('结构为 自动 → 最高画质 → 各档位（高度降序）', () => {
    const options = buildQualityOptions(LADDER, null);

    expect(options.map((item) => item.value)).toEqual([
      AUTO_LEVEL,
      MAX_LEVEL,
      0, // 1080P
      1, // 720P
      2, // 480P
      3, // 360P
    ]);
    expect(options[0].html).toBe('自动');
    expect(options[1].html).toBe('最高画质 (1080P)');
    expect(options[2].html).toBe('高清 1080P');
  });

  it('源站 master 缺 RESOLUTION 时菜单仍有可读的档位名（P1-9）', () => {
    const bitrateOnly = [
      { bitrate: 5_200_000 },
      { bitrate: 2_400_000 },
      { bitrate: 1_100_000 },
    ];
    const options = buildQualityOptions(bitrateOnly, null);

    expect(options.map((item) => item.html)).toEqual([
      '自动',
      '最高画质 (1080P)',
      '高清 1080P',
      '准高清 720P',
      '标清 480P',
    ]);
  });

  it('value 始终是原始 levels 下标，排序只影响展示顺序', () => {
    // 故意给一个乱序的 levels：最低档排在最前
    const shuffled = [
      { height: 360, bitrate: 700_000 },
      { height: 1080, bitrate: 5_000_000 },
      { height: 720, bitrate: 2_800_000 },
    ];
    const options = buildQualityOptions(shuffled, null);
    const levelOptions = options.filter((item) => item.value >= 0);

    expect(levelOptions.map((item) => item.html)).toEqual([
      '高清 1080P',
      '准高清 720P',
      '流畅 360P',
    ]);
    // 1080P 的 value 必须是它在原数组里的下标 1
    expect(levelOptions[0].value).toBe(1);
  });

  it('默认选中项跟随偏好高度', () => {
    const options = buildQualityOptions(LADDER, 720);
    expect(options[0].default).toBe(false); // 自动
    expect(options[1].default).toBe(false); // 最高画质
    expect(options.find((item) => item.value === 1)?.default).toBe(true);
  });

  it('偏好为 null 时默认选中「自动」', () => {
    const options = buildQualityOptions(LADDER, null);
    expect(options[0].default).toBe(true);
    expect(options[1].default).toBe(false);
  });

  it('偏好为「最高画质」时不高亮具体档位', () => {
    const options = buildQualityOptions(LADDER, MAX_QUALITY_HEIGHT);
    expect(options[1].default).toBe(true);
    expect(options.slice(2).every((item) => !item.default)).toBe(true);
  });

  it('levels 为空时只剩两个快捷项', () => {
    const options = buildQualityOptions([], null);
    expect(options).toHaveLength(2);
    expect(options[1].html).toBe('最高画质');
  });
});

describe('formatLevelLabel', () => {
  it('同高度多档时补码率以便区分', () => {
    const levels = [
      { height: 1080, bitrate: 3_000_000 },
      { height: 1080, bitrate: 6_000_000 },
    ];
    expect(formatLevelLabel(levels[0], 0, levels)).toBe('高清 1080P · 3.0Mbps');
    expect(formatLevelLabel(levels[1], 1, levels)).toBe('高清 1080P · 6.0Mbps');
  });

  it('唯一档位只显示「档位 + 分辨率」', () => {
    expect(formatLevelLabel(LADDER[0], 0, LADDER)).toBe('高清 1080P');
  });

  it('只有码率的档位靠推断命名，而不是显示「档位 N」', () => {
    expect(formatLevelLabel({ bitrate: 1_100_000 }, 0, [])).toBe('标清 480P');
  });

  it('连码率都没有时才回落 name / 序号', () => {
    expect(formatLevelLabel({ name: 'hd' }, 0, [])).toBe('hd');
    expect(formatLevelLabel({}, 2, [])).toBe('档位 3');
  });
});

describe('describeQualityPreference', () => {
  it('自动 / 最高画质 / 具体档位三种文案', () => {
    expect(describeQualityPreference(LADDER, null)).toBe('自动');
    expect(describeQualityPreference(LADDER, MAX_QUALITY_HEIGHT)).toBe(
      '最高画质 (1080P)'
    );
    expect(describeQualityPreference(LADDER, 720)).toBe(
      '准高清 720P · 2.8Mbps'
    );
  });

  it('levels 为空时不抛异常', () => {
    expect(describeQualityPreference([], null)).toBe('自动');
    expect(describeQualityPreference([], MAX_QUALITY_HEIGHT)).toBe('最高画质');
  });
});
