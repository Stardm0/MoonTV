/**
 * 「画质档位」纯逻辑回归测试（P1-6 / P1-7）。
 *
 * 覆盖三个容易回归的点：
 *  1. 标准分辨率命名（含 8K / 4K / 2K，以及 1078 → 1080P 的归并）
 *  2. 「最高画质」哨兵（MAX_QUALITY_HEIGHT）在不同码率视频里都落到该视频最高档
 *  3. selector 选项的**展示顺序**（高度降序）与**value 仍是原始下标**
 */

import {
  AUTO_LEVEL,
  buildQualityOptions,
  describeQualityPreference,
  formatLevelLabel,
  formatResolutionName,
  MAX_LEVEL,
  MAX_QUALITY_HEIGHT,
  pickHighestLevelIndex,
  pickLevelIndex,
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

  it('完全没有分辨率信息时回退自动', () => {
    expect(pickHighestLevelIndex([])).toBe(AUTO_LEVEL);
    expect(pickHighestLevelIndex([{ bitrate: 800_000 }])).toBe(AUTO_LEVEL);
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
      '1080P',
      '720P',
      '360P',
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
    expect(formatLevelLabel(levels[0], 0, levels)).toBe('1080P · 3000kbps');
    expect(formatLevelLabel(levels[1], 1, levels)).toBe('1080P · 6000kbps');
  });

  it('唯一档位只显示分辨率名', () => {
    expect(formatLevelLabel(LADDER[0], 0, LADDER)).toBe('1080P');
  });

  it('无高度信息时回落 name / 码率 / 序号', () => {
    expect(formatLevelLabel({ name: 'hd' }, 0, [])).toBe('hd');
    expect(formatLevelLabel({ bitrate: 900_000 }, 1, [])).toBe('900kbps');
    expect(formatLevelLabel({}, 2, [])).toBe('档位 3');
  });
});

describe('describeQualityPreference', () => {
  it('自动 / 最高画质 / 具体档位三种文案', () => {
    expect(describeQualityPreference(LADDER, null)).toBe('自动');
    expect(describeQualityPreference(LADDER, MAX_QUALITY_HEIGHT)).toBe(
      '最高画质 (1080P)'
    );
    expect(describeQualityPreference(LADDER, 720)).toBe('720P · 2800kbps');
  });

  it('levels 为空时不抛异常', () => {
    expect(describeQualityPreference([], null)).toBe('自动');
    expect(describeQualityPreference([], MAX_QUALITY_HEIGHT)).toBe('最高画质');
  });
});
