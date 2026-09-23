/**
 * 首页左侧导航栏（SideNav）的共享常量与首屏脚本。
 *
 * ## 为什么需要单独一层
 *
 * 侧边栏要「可折叠」，而折叠状态存在 localStorage。如果等 React 挂载后
 * 再读，刷新页面会先按展开态画一遍再收窄 —— 肉眼可见的一次横向抖动。
 *
 * 所以宽度真源放在这里，由 `SIDENAV_INLINE_SCRIPT` 在**首屏绘制前**
 * 同步写进 `<html>`：
 *   - `data-sidenav-collapsed` 属性 → 驱动文字/搜索框的显隐（纯 CSS）
 *   - `--moontv-sidenav-w` 变量     → 驱动侧边栏宽度与内容区左内边距
 *
 * 组件侧只需在用户点折叠时同步同一份状态，视觉与交互因此不会打架。
 *
 * ⚠️ 内联脚本挂在 `document.documentElement` 上。这是本项目踩过的坑：
 * `<head>` 阶段 `document.body` 还是 `null`，挂上去会抛错并被 catch 吞掉，
 * 表现为「设置完全不生效」（见 `theme-palette.ts` 的同款问题）。
 */

/** 折叠状态在 localStorage 中的键 */
export const SIDENAV_COLLAPSED_KEY = 'moontv_sidenav_collapsed';

/** 展开时侧边栏宽度（px） */
export const SIDENAV_WIDTH_EXPANDED = 224;

/** 折叠时侧边栏宽度（px），只放得下图标 */
export const SIDENAV_WIDTH_COLLAPSED = 72;

/** 挂在 `<html>` 上的折叠标记，CSS 依赖它切换视觉 */
export const SIDENAV_COLLAPSED_ATTR = 'data-sidenav-collapsed';

/** 侧边栏宽度对应的 CSS 变量名 */
export const SIDENAV_WIDTH_VAR = '--moontv-sidenav-w';

/**
 * 把 localStorage 里读到的原始字符串收敛成布尔值。
 *
 * 只认显式的真值写法：历史上可能有 `"true"` / `"1"` 等多种来源，
 * 而 `"false"` / 空 / 损坏值都必须落回「展开」——折叠是少数状态，
 * 猜错时保持展开比误折叠安全。
 */
export function normalizeSidenavCollapsed(
  raw: string | null | undefined
): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/** 折叠状态 → 像素宽度 */
export function sidenavWidth(collapsed: boolean): number {
  return collapsed ? SIDENAV_WIDTH_COLLAPSED : SIDENAV_WIDTH_EXPANDED;
}

/**
 * 把折叠状态写到 DOM 上（属性 + CSS 变量）。
 *
 * `root` 可注入，便于测试；浏览器里默认取 `<html>`。
 * 非浏览器环境（SSR / 单测无 DOM）直接跳过，不抛异常。
 */
export function applySidenavCollapsed(
  collapsed: boolean,
  root?: HTMLElement | null
): void {
  const target =
    root ??
    (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return;

  target.setAttribute(SIDENAV_COLLAPSED_ATTR, collapsed ? 'true' : 'false');
  target.style.setProperty(
    SIDENAV_WIDTH_VAR,
    `${sidenavWidth(collapsed)}px`
  );
}

/**
 * 首屏内联脚本：在 React 挂载前就把折叠态落到 `<html>` 上。
 *
 * 宽度字面量直接内联（不引用变量），因此这里**刻意**复用了两个常量，
 * 测试会校验脚本里确实出现了这两个数字，防止改宽度时漏改脚本。
 */
export const SIDENAV_INLINE_SCRIPT = `(function(){try{var c=localStorage.getItem('${SIDENAV_COLLAPSED_KEY}')==='true';var r=document.documentElement;r.setAttribute('${SIDENAV_COLLAPSED_ATTR}',c?'true':'false');r.style.setProperty('${SIDENAV_WIDTH_VAR}',(c?${SIDENAV_WIDTH_COLLAPSED}:${SIDENAV_WIDTH_EXPANDED})+'px');}catch(e){}})();`;
