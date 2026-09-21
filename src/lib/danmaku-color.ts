/**
 * 弹幕颜色工具。
 *
 * 背景：artplayer-plugin-danmuku 解析 B 站 XML 弹幕时用的是
 *     color: `#${Number(t[3]).toString(16)}`
 * 缺少补零。B 站颜色是十进制 RGB，任何 R 通道为 0 的深色系颜色
 * 转十六进制后不足 6 位，产出非法 CSS 色值：
 *
 *     #ff     → 空值，弹幕失去自身颜色（继承容器色）
 *     #8b     → 空值
 *     #ff00   → rgba(255,255,0,0)，alpha 为 0 —— 弹幕彻底隐形
 *     #ffff   → 被当成 4 位简写展开为白色（不报错，静默变色）
 *
 * 因此这里统一做 6 位补零，并防御性地处理越界值。
 *
 * 相关事实由 `src/lib/__tests__/danmaku-color-normalize.test.ts` 固化。
 */

/** B 站弹幕默认颜色（白色） */
export const DEFAULT_DANMAKU_COLOR = 16777215;

/** 合法 #RRGGBB 的最大值 */
const MAX_RGB = 0xffffff;

/**
 * 把十进制 RGB 转成合法的 `#rrggbb` 字符串。
 *
 * - 缺省或非法输入回退为默认白色
 * - 超出 0xffffff 的值按位截断，避免产出超长十六进制
 * - 负数、NaN、非整数一律回退
 */
export function decimalColorToHex(color: unknown): string {
  const value =
    typeof color === 'number' && Number.isFinite(color)
      ? Math.trunc(color)
      : NaN;

  if (!Number.isFinite(value) || value < 0) {
    return `#${DEFAULT_DANMAKU_COLOR.toString(16).padStart(6, '0')}`;
  }

  // 超过 24 位的值按 24 位截断，保证结果恒为 6 位
  const safe = value > MAX_RGB ? value & MAX_RGB : value;
  return `#${safe.toString(16).padStart(6, '0')}`;
}

/**
 * 把插件返回的 `#rrggbb` 反解回十进制，用于调用方需要数字的场景。
 * 解析失败时回退为默认白色。
 */
export function hexColorToDecimal(hex: string): number {
  if (typeof hex !== 'string') return DEFAULT_DANMAKU_COLOR;

  const matched = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!matched) return DEFAULT_DANMAKU_COLOR;

  return parseInt(matched[1], 16);
}

/**
 * B 站弹幕类型 → 插件 mode 的映射。
 *
 * 两套定义并不一致，直接透传会让「顶部/底部」弹幕跑到滚动轨道上：
 *   B 站 type: 1=滚动 2=顶部 3=底部 4=底部(旧) 5=顶部(旧)
 *   插件 mode: 0=滚动 1=顶部 2=底部
 */
export function danmakuTypeToMode(type: unknown): number {
  const value = typeof type === 'number' && Number.isFinite(type) ? type : 1;
  switch (value) {
    case 2:
    case 5:
      return 1; // 顶部
    case 3:
    case 4:
      return 2; // 底部
    default:
      return 0; // 滚动
  }
}
