/**
 * hls.js 码率档位 → ArtPlayer「画质」设置项（P1-6）。
 *
 * 之前的实现只把 hls.js 的 `levels` 用于**优选打分**（`getVideoResolutionFromM3u8`），
 * 播放过程中没有任何画质切换入口。本模块把 levels 转换成 ArtPlayer
 * `settings` 的 selector 选项，并提供"按高度记忆"的持久化：
 *
 * 记住的是**画面高度**而不是 level 下标，因为同一部剧换集/换源后
 * 档位数量和顺序都会变，记住下标会指向错误的档位。
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
 * 为每个档位生成展示文案。
 *
 * 统一用标准分辨率名（`1080P` / `720P` / `4K` / `8K`）而不是 `1280x720`
 * 或裸高度；同高度多档（同分辨率不同码率）时补上码率以便区分。
 */
export function formatLevelLabel(
  level: HlsLevelLike,
  index: number,
  levels: HlsLevelLike[]
): string {
  const height = heightOf(level);
  const name = formatResolutionName(height);
  const duplicated =
    height > 0 && levels.filter((item) => heightOf(item) === height).length > 1;

  const kbps =
    typeof level.bitrate === 'number' && level.bitrate > 0
      ? Math.round(level.bitrate / 1000)
      : 0;

  if (name) {
    return duplicated && kbps > 0 ? `${name} · ${kbps}kbps` : name;
  }
  if (level.name) return level.name;
  if (kbps > 0) return `${kbps}kbps`;
  return `档位 ${index + 1}`;
}

/** 档位排序权重：高度优先，同高度按码率 */
function compareLevels(
  a: { level: HlsLevelLike },
  b: { level: HlsLevelLike }
): number {
  const diff = heightOf(b.level) - heightOf(a.level);
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
    .filter((item) => heightOf(item.level) > 0);

  if (candidates.length === 0) return AUTO_LEVEL;

  return candidates.reduce((best, item) =>
    compareLevels(item, best) < 0 ? item : best
  ).index;
}

/**
 * 选出与目标高度最匹配的 level 下标。
 *
 * 匹配顺序：同高度 → 更高档位中最低的那个 → 更低档位中最高的那个。
 * 返回 -1 表示无可选项（levels 为空或完全没有分辨率信息）。
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
    .map((level, index) => ({ index, height: heightOf(level) }))
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
      : formatResolutionName(heightOf(levels[highestIndex]));

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
  const name = formatResolutionName(heightOf(level));
  const kbps =
    typeof level.bitrate === 'number' && level.bitrate > 0
      ? Math.round(level.bitrate / 1000)
      : 0;
  if (name && kbps > 0) return `${name} · ${kbps}kbps`;
  if (name) return name;
  if (kbps > 0) return `${kbps}kbps`;
  if (level.name) return level.name;
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
    const name = index === AUTO_LEVEL ? '' : formatResolutionName(heightOf(levels[index]));
    return name ? `最高画质 (${name})` : '最高画质';
  }

  return describeLevel(index === AUTO_LEVEL ? null : levels[index]);
}
