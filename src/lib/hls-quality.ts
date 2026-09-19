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
 * 同高度多档（同分辨率不同码率）时补上码率以便区分。
 */
export function formatLevelLabel(
  level: HlsLevelLike,
  index: number,
  levels: HlsLevelLike[]
): string {
  const height = heightOf(level);
  const duplicated =
    height > 0 && levels.filter((item) => heightOf(item) === height).length > 1;

  const kbps =
    typeof level.bitrate === 'number' && level.bitrate > 0
      ? Math.round(level.bitrate / 1000)
      : 0;

  if (height > 0) {
    return duplicated && kbps > 0 ? `${height}p · ${kbps}kbps` : `${height}p`;
  }
  if (level.name) return level.name;
  if (kbps > 0) return `${kbps}kbps`;
  return `档位 ${index + 1}`;
}

/**
 * 选出与目标高度最匹配的 level 下标。
 *
 * 匹配顺序：同高度 → 更高档位中最低的那个 → 更低档位中最高的那个。
 * 返回 -1 表示无可选项（levels 为空或完全没有分辨率信息）。
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

/** 生成 ArtPlayer `setting.selector` 选项列表，并把偏好档位标记为默认选中 */
export function buildQualityOptions(
  levels: HlsLevelLike[],
  preferredHeight: number | null
): QualityOption[] {
  const preferredIndex =
    preferredHeight === null ? AUTO_LEVEL : pickLevelIndex(levels, preferredHeight);

  const options: QualityOption[] = [
    { html: '自动', value: AUTO_LEVEL, default: preferredIndex === AUTO_LEVEL },
  ];

  levels.forEach((level, index) => {
    options.push({
      html: formatLevelLabel(level, index, levels),
      value: index,
      default: preferredIndex === index,
    });
  });

  return options;
}

/** 单档位的简短描述（恒带码率），用于设置项 tooltip */
export function describeLevel(level: HlsLevelLike | undefined | null): string {
  if (!level) return '自动';
  const height = heightOf(level);
  const kbps =
    typeof level.bitrate === 'number' && level.bitrate > 0
      ? Math.round(level.bitrate / 1000)
      : 0;
  if (height > 0 && kbps > 0) return `${height}p · ${kbps}kbps`;
  if (height > 0) return `${height}p`;
  if (kbps > 0) return `${kbps}kbps`;
  if (level.name) return level.name;
  return '自动';
}
