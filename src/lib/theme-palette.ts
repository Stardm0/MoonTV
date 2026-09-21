/**
 * 第二层主题：用 `src/styles/colors.css` 里现成的 22 套 Tailwind 色阶
 * 替换当前硬编码的主色（sky 蓝），并驱动全局强调色与页面背景渐变。
 *
 * 设计要点：
 * - 业务代码里 `primary-*` 一次都没用过，所以换主色不需要改任何 className，
 *   只要在 `:root` 上重新赋值 `--tw-color-primary-*` 即可整站生效。
 * - 色值只有 `colors.css` 一个真源：`scripts/generate-theme-palette.js` 给每套
 *   色阶补 `--theme-preview-<shade>`，本模块在运行时读取，不在 JS 里再抄一份。
 */

/** 22 套可用色阶，顺序即 UI 展示顺序（中性 → 暖 → 冷）。 */
export const THEME_PALETTES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
] as const;

export type ThemePalette = (typeof THEME_PALETTES)[number];

/**
 * 色阶在 `src/styles/colors.css` 里的**真实类名**。
 *
 * 存在的唯一理由：把"类名怎么拼"收敛成一处。运行时要靠它查 CSS 变量，
 * 测试要靠它去 CSS 真源里核对 —— 两边各写一遍就会重演
 * 「运行时写 `theme-slate`、CSS 里是 `.slate`、测试却断言裸名」三者互不
 * 相符、测试还是绿的的事故。
 */
export function paletteClassName(palette: ThemePalette): string {
  return palette;
}

/** 默认主色。与 `tailwind.config.ts` 里的 sky 色阶一致，保证未设置时观感不变。 */
export const DEFAULT_THEME_PALETTE: ThemePalette = 'sky';

export const THEME_PALETTE_STORAGE_KEY = 'moontv_theme_palette';

/** 色阶的 11 个档位。 */
export const THEME_PALETTE_SHADES = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

/**
 * 色阶中文名，仅用于设置面板展示。
 *
 * 中性色不写「XX灰」：五套中性色并排时，"石板灰/中性灰/锌灰/纯灰/石灰"
 * 既长又难分辨，反而要逐个读。改成单字 + 极短词，一眼扫过即可。
 */
export const THEME_PALETTE_LABELS: Record<ThemePalette, string> = {
  slate: '石板',
  gray: '中性',
  zinc: '锌',
  neutral: '纯',
  stone: '石灰',
  red: '红',
  orange: '橙',
  amber: '琥珀',
  yellow: '黄',
  lime: '青柠',
  green: '绿',
  emerald: '翡翠',
  teal: '青碧',
  cyan: '青',
  sky: '天蓝',
  blue: '蓝',
  indigo: '靛蓝',
  violet: '紫罗兰',
  purple: '紫',
  fuchsia: '洋红',
  pink: '粉',
  rose: '玫瑰',
};

/**
 * 设置面板里实际展示的色阶顺序与分组。
 *
 * 之所以分组：22 个色卡平铺太长（实测要滚动很多屏），而用户挑主色时
 * 真正需要区分的只有"中性 / 暖 / 冷"这三类。分组后每组 4 行，配合
 * `max-h` 滚动，整块能塞进一屏。
 */
export const THEME_PALETTE_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  palettes: readonly ThemePalette[];
}> = [
  {
    id: 'neutral',
    label: '中性',
    palettes: ['slate', 'gray', 'zinc', 'neutral', 'stone'],
  },
  {
    id: 'warm',
    label: '暖色',
    palettes: [
      'red',
      'orange',
      'amber',
      'yellow',
      'lime',
      'green',
      'emerald',
    ],
  },
  {
    id: 'cool',
    label: '冷色',
    palettes: [
      'teal',
      'cyan',
      'sky',
      'blue',
      'indigo',
      'violet',
      'purple',
      'fuchsia',
      'pink',
      'rose',
    ],
  },
];

/**
 * 浅色模式页面背景渐变的三段色，取色阶的 100 / 50 / 200。
 *
 * 为什么是这三档：原硬编码渐变（`#e6f3fb → #f7f7f3 → #d3dde6`）本身就是
 * 极浅的蓝-灰过渡，对应 sky 色阶的 100 / 50 / 200 附近。照这个映射换色，
 * 22 套色阶都能得到同等强度的背景，不会出现某套色阶背景过深压住正文。
 */
const SURFACE_SHADE_MAP = {
  '--theme-surface-from': 100,
  '--theme-surface-via': 50,
  '--theme-surface-to': 200,
} as const;

export function isThemePalette(value: unknown): value is ThemePalette {
  return (
    typeof value === 'string' &&
    (THEME_PALETTES as readonly string[]).includes(value)
  );
}

/** 从 `readPaletteShades()` 的结果里取某个档位的值（如 100 → shades[1]）。 */
function shadeAt(shades: string[], shade: number): string {
  const index = (THEME_PALETTE_SHADES as readonly number[]).indexOf(shade);
  return index >= 0 ? shades[index] : '';
}

/**
 * 读出某套色阶的 11 个 RGB 三元组。
 *
 * 依赖 `colors.css` 里的 `.slate` / `.gray` / … 裸类名（由配套脚本补的
 * `--theme-preview-*`），真正生效的色彩由 `applyThemePalette()` 写进
 * `:root` 的 `--tw-color-primary-*`。
 *
 * ⚠️ 类名**不带 `theme-` 前缀** —— 这是 `colors.css` 的原始形态。
 * 曾经这里写的是 `theme-${palette}`，与 CSS 对不上，导致：
 * `getPropertyValue()` 全部返回空 → 色卡一律走 fallback 渲染成同一个灰 →
 * `applyThemePalette()` 撞到"读不到就退回默认色"的保护 → **换色完全无效**。
 * 而 `theme-palette-css.test.ts` 当时断言的是裸类名，所以测试是绿的。
 * 现在测试会**用真实类名查真源**，见该文件的 `paletteClassName()`。
 *
 * 之所以不在 JS 里再抄一份色值表：抄一份就是 22 × 11 = 242 个常量，
 * 与 `colors.css` 变成两个真源，迟早漂移。
 */
export function readPaletteShades(palette: ThemePalette): string[] {
  if (typeof document === 'undefined') return [];
  const el = document.createElement('div');
  el.className = paletteClassName(palette);
  el.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none';
  document.body.appendChild(el);
  const styles = window.getComputedStyle(el);
  const result = THEME_PALETTE_SHADES.map((shade) =>
    styles.getPropertyValue(`--theme-preview-${shade}`).trim()
  );
  document.body.removeChild(el);
  return result;
}

/**
 * 把某套色阶写入 `:root`，使全站 `primary-*` 立即换色。
 *
 * 写入的是 `--tw-color-primary-<shade>`，`colors.css` / `tailwind.config.ts`
 * 消费的正是这一组变量（`--color-primary-*` 是它的二次派生，会自动跟随）。
 */
export function applyThemePalette(palette: ThemePalette): void {
  if (typeof document === 'undefined') return;
  const shades = readPaletteShades(palette);
  if (shades.length === 0 || shades.some((s) => !s)) {
    // 读不到预览变量就退回默认色阶，避免把主色写成空值导致整站变透明。
    if (palette !== DEFAULT_THEME_PALETTE) {
      applyThemePalette(DEFAULT_THEME_PALETTE);
    }
    return;
  }
  const root = document.documentElement;
  THEME_PALETTE_SHADES.forEach((shade, index) => {
    root.style.setProperty(`--tw-color-primary-${shade}`, shades[index]);
  });
  // 背景渐变跟随主色，浅色模式下换主题时整页氛围一起变。
  for (const [cssVar, shade] of Object.entries(SURFACE_SHADE_MAP)) {
    const value = shadeAt(shades, shade);
    if (value) root.style.setProperty(cssVar, value);
  }
}

/** 清除运行时覆盖，回到 `globals.css` 里声明的默认色。 */
export function resetThemePalette(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  THEME_PALETTE_SHADES.forEach((shade) => {
    root.style.removeProperty(`--tw-color-primary-${shade}`);
  });
  Object.keys(SURFACE_SHADE_MAP).forEach((cssVar) => {
    root.style.removeProperty(cssVar);
  });
}

export function loadThemePalette(): ThemePalette {
  if (typeof window === 'undefined') return DEFAULT_THEME_PALETTE;
  try {
    const raw = window.localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
    if (isThemePalette(raw)) return raw;
  } catch {
    // localStorage 被禁用（隐私模式 / 配额满）时静默退回默认值。
  }
  return DEFAULT_THEME_PALETTE;
}

export function saveThemePalette(palette: ThemePalette): void {
  if (typeof window === 'undefined') return;
  try {
    // 默认色不落库：省得旧版本残留一个等于默认值的键。
    if (palette === DEFAULT_THEME_PALETTE) {
      window.localStorage.removeItem(THEME_PALETTE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);
    }
  } catch {
    // 写不进去不影响本次会话的视觉，忽略。
  }
}

/**
 * 一次性把 22 套色阶的预览色读出来，给设置面板渲染色卡。
 * 结果缓存在模块级变量里 —— 每个色卡读一次 CSS 变量太浪费。
 */
let previewCache: Record<string, string[]> | null = null;

export function getAllPalettePreviews(): Record<string, string[]> {
  if (previewCache) return previewCache;
  if (typeof document === 'undefined') return {};
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.appendChild(el);
  const result: Record<string, string[]> = {};
  for (const palette of THEME_PALETTES) {
    el.className = paletteClassName(palette);
    const styles = window.getComputedStyle(el);
    result[palette] = THEME_PALETTE_SHADES.map((shade) =>
      styles.getPropertyValue(`--theme-preview-${shade}`).trim()
    );
  }
  document.body.removeChild(el);
  previewCache = result;
  return result;
}

/** 把 `"2 6 23"` 形式的 RGB 三元组转成 `rgb(2 6 23)`，读不到时返回 fallback。 */
export function rgbTripletToCss(
  triplet: string,
  fallback = 'transparent'
): string {
  const trimmed = (triplet || '').trim();
  if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(trimmed)) return fallback;
  return `rgb(${trimmed})`;
}

/** 把 `"2 6 23"` 转成 `#020617`，给需要 16 进制的场景（如 theme-color meta）用。 */
export function rgbTripletToHex(triplet: string, fallback = '#000000'): string {
  const parts = (triplet || '').trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return fallback;
  }
  return (
    '#' +
    parts
      .map((n) => Math.max(0, Math.min(255, Math.round(n))))
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * 供 `<head>` 内联脚本调用的极简版本 —— 必须**在首屏绘制前**跑完，
 * 否则会先闪一下默认色再跳到用户选的颜色。
 *
 * 刻意不引打包产物：内联脚本要尽量小，且不能有额外请求。
 * 与 `applyThemePalette()` 是同一套逻辑的压缩版，改一处要同步另一处。
 */
export const THEME_PALETTE_INLINE_SCRIPT = `(function(){try{var P=${JSON.stringify(
  THEME_PALETTES
)},S=${JSON.stringify(
  THEME_PALETTE_SHADES
)},D=${JSON.stringify(THEME_PALETTE_STORAGE_KEY)};var p=localStorage.getItem(D);if(!p||P.indexOf(p)<0)return;var e=document.createElement('div');e.className=p;e.style.cssText='position:absolute;visibility:hidden;pointer-events:none';document.body.appendChild(e);var g=getComputedStyle(e),v=S.map(function(n){return g.getPropertyValue('--theme-preview-'+n).trim()});document.body.removeChild(e);if(v.some(function(x){return !x}))return;var r=document.documentElement;S.forEach(function(n,i){r.style.setProperty('--tw-color-primary-'+n,v[i])});var M={'--theme-surface-from':100,'--theme-surface-via':50,'--theme-surface-to':200};Object.keys(M).forEach(function(k){var i=S.indexOf(M[k]);if(i>=0&&v[i])r.style.setProperty(k,v[i])});}catch(e){}})();`;
