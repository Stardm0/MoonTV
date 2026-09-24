/**
 * 无封面资源的占位封面（影库场景必需）。
 *
 * ## 为什么需要
 *
 * 私人影库（网盘 / OpenList）里的片子**普遍没有海报**——网盘里只有视频文件，
 * 没有元数据。这时 `VideoCard` 会拿到空 `poster`：
 *   - `next/image` 收到空 `src` 会直接抛错；
 *   - 就算兜住了，卡片也是一大块空白，一屏影库结果看起来像没加载出来。
 *
 * 这里按标题派生一个**稳定**的渐变色块 + 首字：同一部片每次进来颜色一致
 * （用标题做哈希，不用随机数），列表因此不会空洞，也能靠颜色区分条目。
 *
 * ## 纯函数传统
 *
 * 两个函数都无副作用、不碰 DOM，配 `src/lib/__tests__/poster-fallback.test.ts`。
 */

/** 取用于展示的首字（中文取首字，英文/数字取首字母大写，取不到给 `?`） */
export function buildPosterInitial(title: string): string {
  const value = String(title ?? '').trim();
  if (!value) return '?';
  const code = value.codePointAt(0);
  if (code === undefined) return '?';
  const char = String.fromCodePoint(code);
  // 拉丁字母统一大写，视觉上更像一张「封面标签」
  return char.length === 1 && char >= 'a' && char <= 'z'
    ? char.toUpperCase()
    : char;
}

/** djb2 哈希：短字符串分布够用，且各平台结果一致（同一标题永远同色） */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface PosterPalette {
  from: string;
  to: string;
}

/**
 * 按标题生成双色渐变。
 *
 * 色相由哈希决定（全色域），饱和度和明度固定在中低区间——这样白字始终可读，
 * 亮色/暗色主题下都不会刺眼。第二个色相固定偏移 40°，保证同色系过渡。
 */
export function buildPosterPalette(seed: string): PosterPalette {
  const value = String(seed ?? '').trim();
  const hue = hashString(value || 'moontv') % 360;
  const hue2 = (hue + 40) % 360;
  return {
    from: `hsl(${hue} 38% 42%)`,
    to: `hsl(${hue2} 42% 26%)`,
  };
}
