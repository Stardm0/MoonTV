/**
 * hls.js 码率档位 → ArtPlayer「画质」设置项（P1-6）。
 *
 * 有两个现实约束决定了这个模块的写法：
 *
 * 1. **很多源站的 master playlist 只给 `BANDWIDTH`，不给 `RESOLUTION`。**
 *    这时 hls.js 的 `level.height` 是 `undefined`，任何"按分辨率命名"的实现
 *    都会退化成「档位 1 / 档位 2」，而且记忆与预取联动会整条失效。
 *    因此这里在 height 缺失时**按码率推断高度**（`inferHeightFromBitrate`），
 *    保证菜单、记忆、预取三者始终有可用的档位标识。
 * 2. **记忆的是"画面高度"而不是 level 下标**，因为同一部剧换集/换源后
 *    档位数量和顺序都会变，记住下标会指向错误的档位。
 */

/** `hls.currentLevel = -1` 表示自动（ABR） */
export const AUTO_LEVEL = -1;

/** 「最高画质」快捷项的占位 value（不是真实的 level 下标） */
export const MAX_LEVEL = -2;

/**
 * 「最高画质」在 localStorage 里记录的画面高度。
 *
 * 取值 8K（4320）而不是一个特殊标记，是为了直接复用 `pickLevelIndex` 的
 * 「同高度 → 更高档中最低 → 更低档中最高」匹配规则：请求 4320 时若视频
 * 没有 8K 档，就会落到"所有档位里最高的那一档"，天然等价于"本视频的最高画质"。
 * 于是同一个偏好跨不同码率的视频都能得到正确结果。
 */
export const MAX_QUALITY_HEIGHT = 4320;

/**
 * 标准分辨率阶梯（画面高度 → 展示名），降序。
 * 覆盖到 8K，方便带 8K 源站正确显示。
 */
const RESOLUTION_LADDER: ReadonlyArray<{ height: number; label: string }> = [
  { height: 4320, label: '8K' },
  { height: 2880, label: '5K' },
  { height: 2160, label: '4K' },
  { height: 1440, label: '2K' },
  { height: 1080, label: '1080P' },
  { height: 720, label: '720P' },
  { height: 576, label: '576P' },
  { height: 480, label: '480P' },
  { height: 360, label: '360P' },
  { height: 240, label: '240P' },
  { height: 144, label: '144P' },
];

/**
 * 画质档位中文名（降序）。
 * 命名对齐主流视频 App：超高清 / 高清 / 准高清 / 标清 / 流畅 / 省流。
 */
const QUALITY_TIERS: ReadonlyArray<{ minHeight: number; label: string }> = [
  { minHeight: 2160, label: '超高清' },
  { minHeight: 1080, label: '高清' },
  { minHeight: 720, label: '准高清' },
  { minHeight: 480, label: '标清' },
  { minHeight: 360, label: '流畅' },
  { minHeight: 240, label: '省流' },
];

/** 给不出高度信息时的兜底档位名 */
const LOWEST_TIER = '极速';

/**
 * 码率阶梯（bps → 推断画面高度），降序。
 *
 * 只在 master playlist 缺 `RESOLUTION` 时使用。取值参考常见源站的编码档位，
 * 宁可能粗一点也不要用「档位 3」这种没人能理解的文案。
 */
const BITRATE_LADDER: ReadonlyArray<{ minBps: number; height: number }> = [
  { minBps: 30000000, height: 4320 },
  { minBps: 14000000, height: 2160 },
  { minBps: 8000000, height: 1440 },
  { minBps: 4000000, height: 1080 },
  { minBps: 2000000, height: 720 },
  { minBps: 1000000, height: 480 },
  { minBps: 500000, height: 360 },
  { minBps: 250000, height: 240 },
];

/** 低于最低码率阶梯时的推断高度 */
const LOWEST_INFERRED_HEIGHT = 144;

/**
 * 画面高度 → 标准分辨率名。
 *
 * 允许 5% 的向下偏差，把源站常见的非标准高度归并到最近的上一档
 * （1078 → 1080P、2144 → 4K），避免出现 `1078p` 这种没人认识的文案。
 * 完全对不上阶梯的高度（如 100）才回落成 `{height}P`。
 */
export function formatResolutionName(height: number): string {
  if (!Number.isFinite(height) || height <= 0) return '';
  const matched = RESOLUTION_LADDER.find(
    (item) => height >= item.height * 0.95
  );
  return matched ? matched.label : `${Math.round(height)}P`;
}

/** 画面高度 → 画质档位中文名（如 `高清`）；无有效高度时返回空串 */
export function qualityTierOf(height: number): string {
  if (!Number.isFinite(height) || height <= 0) return '';
  const matched = QUALITY_TIERS.find((item) => height >= item.minHeight * 0.95);
  return matched ? matched.label : LOWEST_TIER;
}

/**
 * 码率（bps）→ 推断的画面高度；无码率信息时返回 0。
 *
 * 源站 master 缺 `RESOLUTION` 时的唯一线索。注意它只是**展示与匹配用的
 * 近似值**，不参与任何实际的解码/渲染决策。
 */
export function inferHeightFromBitrate(bitrate?: number | null): number {
  if (
    typeof bitrate !== 'number' ||
    !Number.isFinite(bitrate) ||
    bitrate <= 0
  ) {
    return 0;
  }
  const matched = BITRATE_LADDER.find((item) => bitrate >= item.minBps);
  return matched ? matched.height : LOWEST_INFERRED_HEIGHT;
}

export interface HlsLevelLike {
  height?: number;
  width?: number;
  bitrate?: number;
  name?: string;
}

/** ArtPlayer setting.selector 的子项结构 */
export interface QualityOption {
  html: string;
  value: number;
  default: boolean;
}

const STORAGE_KEY = 'moontv_preferred_quality_height';

/** 读取用户偏好的画面高度；null 表示自动。异常/脏数据一律回退为自动。 */
export function loadPreferredQualityHeight(): number | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写入偏好。传 null 表示"自动"，此时清除该键。 */
export function savePreferredQualityHeight(height: number | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (height === null || !Number.isFinite(height) || height <= 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, String(Math.round(height)));
  } catch {
    // 隐私模式 / 配额用尽：静默降级为不记忆
  }
}

function heightOf(level: HlsLevelLike | undefined | null): number {
  const height = level?.height;
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return Math.round(height);
  }
  return 0;
}

/**
 * 取一个档位的"有效画面高度"。
 *
 * 优先用 hls.js 解析出的真实 `height`；缺失时按码率推断——源站 master
 * 只写 `BANDWIDTH` 时，这是唯一能区分 480P / 1080P 的线索。
 * 两条路径都拿不到就返回 0，由调用方决定怎么兜底。
 */
export function resolveLevelHeight(level?: HlsLevelLike | null): number {
  const height = heightOf(level);
  if (height > 0) return height;
  return inferHeightFromBitrate(level?.bitrate);
}

/** `{档位} {分辨率}`，如 `高清 1080P`；信息不足时逐级退化 */
export function formatQualityLabel(height: number): string {
  const name = formatResolutionName(height);
  const tier = qualityTierOf(height);
  if (tier && name) return `${tier} ${name}`;
  return name || tier;
}

/** 码率 → 短文案（`5.0Mbps` / `800kbps`）；无值时返回空串 */
function formatBitrate(bitrate?: number | null): string {
  if (
    typeof bitrate !== 'number' ||
    !Number.isFinite(bitrate) ||
    bitrate <= 0
  ) {
    return '';
  }
  if (bitrate >= 1000000) return `${(bitrate / 1000000).toFixed(1)}Mbps`;
  return `${Math.round(bitrate / 1000)}kbps`;
}

/**
 * 为每个档位生成展示文案。
 *
 * 形如 `高清 1080P`（源站给了分辨率）或 `标清 480P`（按码率推断）。
 * 同高度多档（同分辨率不同码率）时补上码率以便区分——否则会出现两个
 * 一模一样的选项，用户无从选择。
 */
export function formatLevelLabel(
  level: HlsLevelLike,
  index: number,
  levels: HlsLevelLike[]
): string {
  const height = resolveLevelHeight(level);
  const label = formatQualityLabel(height);
  const duplicated =
    height > 0 &&
    levels.filter((item) => resolveLevelHeight(item) === height).length > 1;

  if (label) {
    const bitrate = formatBitrate(level.bitrate);
    return duplicated && bitrate ? `${label} · ${bitrate}` : label;
  }
  if (level.name) return level.name;
  const bitrate = formatBitrate(level.bitrate);
  return bitrate || `档位 ${index + 1}`;
}

/** 档位排序权重：高度优先，同高度按码率 */
function compareLevels(
  a: { level: HlsLevelLike },
  b: { level: HlsLevelLike }
): number {
  const diff = resolveLevelHeight(b.level) - resolveLevelHeight(a.level);
  if (diff !== 0) return diff;
  return (b.level.bitrate ?? 0) - (a.level.bitrate ?? 0);
}

/**
 * 选出画面最高的 level 下标（同高度取码率最高的那档）。
 * 无法判断时返回 `AUTO_LEVEL`，交给 ABR。
 */
export function pickHighestLevelIndex(levels: HlsLevelLike[]): number {
  if (!levels || levels.length === 0) return AUTO_LEVEL;

  const candidates = levels
    .map((level, index) => ({ level, index }))
    .filter((item) => resolveLevelHeight(item.level) > 0);

  if (candidates.length === 0) return AUTO_LEVEL;

  return candidates.reduce((best, item) =>
    compareLevels(item, best) < 0 ? item : best
  ).index;
}

/**
 * 选出与目标高度最匹配的 level 下标。
 *
 * 匹配顺序：同高度 → 更高档位中最低的那个 → 更低档位中最高的那个。
 * 返回 -1 表示无可选项（levels 为空或完全没有分辨率/码率信息）。
 *
 * 传入 `MAX_QUALITY_HEIGHT`(4320) 时会走"没有更高档"这一支，
 * 于是落到**本视频最高的那一档**，即「最高画质」的语义。
 */
export function pickLevelIndex(
  levels: HlsLevelLike[],
  height: number | null
): number {
  if (!levels || levels.length === 0) return AUTO_LEVEL;
  if (height === null || !Number.isFinite(height) || height <= 0) {
    return AUTO_LEVEL;
  }

  const candidates = levels
    .map((level, index) => ({ index, height: resolveLevelHeight(level) }))
    .filter((item) => item.height > 0);

  if (candidates.length === 0) return AUTO_LEVEL;

  const exact = candidates.filter((item) => item.height === height);
  const pool =
    exact.length > 0
      ? exact
      : (() => {
          const higher = candidates
            .filter((item) => item.height > height)
            .sort((a, b) => a.height - b.height);
          if (higher.length > 0) {
            return higher.filter((item) => item.height === higher[0].height);
          }
          const lower = candidates
            .filter((item) => item.height < height)
            .sort((a, b) => b.height - a.height);
          return lower.filter((item) => item.height === lower[0].height);
        })();

  if (pool.length === 0) return AUTO_LEVEL;

  // 同高度取码率最高的那一档
  return pool.reduce((best, item) => {
    const bestBitrate = levels[best.index]?.bitrate ?? 0;
    const itemBitrate = levels[item.index]?.bitrate ?? 0;
    return itemBitrate > bestBitrate ? item : best;
  }).index;
}

/**
 * 生成 ArtPlayer `setting.selector` 选项列表。
 *
 * 结构：`自动` → `最高画质 (1080P)` → 各档位（按画面高度**降序**）。
 *
 * - 「自动」交给 hls.js 的 ABR，`value = AUTO_LEVEL`
 * - 「最高画质」`value = MAX_LEVEL`，落到本视频实际存在的最高档
 *   （不同剧集档位不同，标签会带上实际分辨率，方便用户确认）
 * - 其余档位的 `value` 是**原始 levels 下标**，因为 `hls.currentLevel`
 *   用的就是原始下标，排序只影响展示顺序
 */
export function buildQualityOptions(
  levels: HlsLevelLike[],
  preferredHeight: number | null
): QualityOption[] {
  const isAuto = preferredHeight === null;
  const isMax = preferredHeight === MAX_QUALITY_HEIGHT;
  const matchedIndex = isAuto
    ? AUTO_LEVEL
    : pickLevelIndex(levels, preferredHeight);

  const highestIndex = pickHighestLevelIndex(levels);
  const highestName =
    highestIndex === AUTO_LEVEL
      ? ''
      : formatResolutionName(resolveLevelHeight(levels[highestIndex]));

  const options: QualityOption[] = [
    { html: '自动', value: AUTO_LEVEL, default: isAuto },
    {
      html: highestName ? `最高画质 (${highestName})` : '最高画质',
      value: MAX_LEVEL,
      default: isMax,
    },
  ];

  levels
    .map((level, index) => ({ level, index }))
    .sort(compareLevels)
    .forEach(({ level, index }) => {
      options.push({
        html: formatLevelLabel(level, index, levels),
        value: index,
        // 「最高画质」选中时不高亮具体档位：用户选的是语义而非某个下标
        default: !isAuto && !isMax && matchedIndex === index,
      });
    });

  return options;
}

/** 单档位的简短描述（恒带码率），用于设置项 tooltip */
export function describeLevel(level: HlsLevelLike | undefined | null): string {
  if (!level) return '自动';
  const label = formatQualityLabel(resolveLevelHeight(level));
  const bitrate = formatBitrate(level.bitrate);
  if (label && bitrate) return `${label} · ${bitrate}`;
  if (label) return label;
  if (level.name) return level.name;
  if (bitrate) return bitrate;
  return '自动';
}

/**
 * 把「用户偏好」翻译成设置项的 tooltip 文案。
 *
 * 用户偏好有三个来源：自动(null) / 最高画质(MAX_QUALITY_HEIGHT) / 某个具体高度。
 * 「最高画质」要带上本视频实际落到的分辨率，否则换集之后用户无法确认
 * 到底是 1080P 还是 4K。
 */
export function describeQualityPreference(
  levels: HlsLevelLike[],
  preferredHeight: number | null
): string {
  if (preferredHeight === null) return '自动';

  const index = pickLevelIndex(levels, preferredHeight);

  if (preferredHeight === MAX_QUALITY_HEIGHT) {
    const name =
      index === AUTO_LEVEL
        ? ''
        : formatResolutionName(resolveLevelHeight(levels[index]));
    return name ? `最高画质 (${name})` : '最高画质';
  }

  return describeLevel(index === AUTO_LEVEL ? null : levels[index]);
}
