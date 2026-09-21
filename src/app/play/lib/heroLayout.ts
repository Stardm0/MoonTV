/**
 * Hero 区（播放页详情面板）的纯决策函数。
 *
 * 抽出来的理由不是"为了测试而测试"：这里的两个关键判断都是**断点边界逻辑**
 * ——「要不要渲染背景层」决定手机端会不会白白下载一张大图，「简介要不要收起」
 * 决定长文会不会把页面撑得老长。这类边界靠肉眼在真机上试很容易漏，
 * 而这个项目此前已经在「画质档位」「主题类名」两个看不见的边界上栽过跟头。
 *
 * 本文件**不 import React**，可在 jsdom 之外直接单测。
 */

import type { CSSProperties } from 'react';

import { processImageUrl } from '@/lib/utils';

/**
 * 渲染背景层所需的最小视口宽度（= Tailwind `md`）。
 *
 * 为什么用 JS 判而不是 `hidden md:block`：`display:none` 的元素**是否加载
 * background-image 各家浏览器并不一致**，手机上可能照样把那张大图下下来。
 * 这里直接在窄屏返回 `false`，从源头避免发起请求（省流量是决策 C 的主要目的）。
 */
export const HERO_BACKDROP_MIN_WIDTH = 768;

/** 简介超过这个字数才显示「展开」。简体中文按字符算，约 3 行。 */
export const HERO_DESC_CLAMP_CHARS = 120;

/**
 * Hero 外框：相对定位 + 裁切，作为背景层的锚点。
 *
 * `overflow-hidden` 是必需的 —— 背景层用 `scale-110` 预放大来遮住 `blur`
 * 造成的边缘透明，不放大的话四周会透出底色（一条浅边）。
 */
export const HERO_SECTION_CLASS =
  'relative overflow-hidden rounded-xl border border-gray-200/70 dark:border-white/10';

/**
 * 背景层：同一张竖版海报放大 + 模糊，只取「色彩氛围」。
 *
 * 竖版海报拉满容器必然严重裁切，所以它的清晰度本来就不重要 ——
 * 真正给用户"看图"的是前景那张 `aspect-[2/3]` 海报。
 */
export const HERO_BACKDROP_CLASS =
  'absolute inset-0 bg-cover bg-center scale-110 blur-2xl opacity-60 dark:opacity-40';

/**
 * 背景层之上的遮罩，用来把文字对比度拉回来。
 *
 * 浅色模式收得比深色更紧：模糊后的浅色图很容易把深色正文冲淡。
 */
export const HERO_BACKDROP_OVERLAY_CLASS =
  'absolute inset-0 bg-gradient-to-b from-white/80 via-white/90 to-white dark:from-black/55 dark:via-black/75 dark:to-black';

/** 简介收起时用的行数限制（Tailwind 3.3+ 内置，无需插件）。 */
export const HERO_DESC_CLAMP_CLASS = 'line-clamp-3';

/**
 * 前景海报尺寸。
 *
 * 位置固定在**文字左侧**（标题旁边），所有断点一致 —— 用户明确要求放左侧，
 * 不要再靠 `order-*` 在桌面端挪到右边。
 *
 * ⚠️ 尺寸刻意写成**CSS 断点驱动**而不是算出来的：这样首帧就是正确尺寸，
 * 不会出现「SSR 时小、hydration 后突然变大」的跳动。
 * 唯一需要 JS 判断的只有背景层（因为它牵涉要不要发图片请求）。
 */
export const HERO_POSTER_CLASS =
  'w-24 sm:w-28 md:w-32 lg:w-40 xl:w-48 aspect-[2/3] rounded-lg object-cover shadow-lg flex-shrink-0';

/**
 * 是否渲染背景层。
 *
 * 三道闸：无海报（非豆瓣源常见）→ 不渲染；拿不到视口宽度（SSR）→ 不渲染；
 * 视口窄于 {@link HERO_BACKDROP_MIN_WIDTH} → 不渲染。
 *
 * SSR 阶段返回 `false` 是有意的：宁可桌面端 hydration 后再补上，
 * 也不要让手机先下完一张用不上的大图。
 */
export function shouldShowBackdrop(
  poster: string | null | undefined,
  viewportWidth: number
): boolean {
  const raw = (poster || '').trim();
  if (!raw) return false;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return false;
  return viewportWidth >= HERO_BACKDROP_MIN_WIDTH;
}

/**
 * 背景层的内联样式。
 *
 * **必须走 `processImageUrl()`** —— 豆瓣图有防盗链，直连在部分网络下 403。
 * 背景图面积大，一旦破图视觉冲击远大于一张小缩略图，所以这里不能省。
 *
 * URL 里的 `"` / `\` 会被转义：CSS 的 `url()` 用双引号包裹，
 * 未转义的引号会把后面的样式全吃掉（`custom` 代理模式下 URL 常带 `&` 与特殊字符）。
 */
export function buildBackdropStyle(
  poster: string | null | undefined
): CSSProperties {
  const raw = (poster || '').trim();
  if (!raw) return {};
  const url = processImageUrl(raw).trim();
  if (!url) return {};
  const safe = url.replace(/\\/g, '%5C').replace(/"/g, '%22');
  return { backgroundImage: `url("${safe}")` };
}

/**
 * 简介是否需要「展开」按钮。
 *
 * 先压平空白再比长度：源站的 `desc` 常带大量换行与缩进，不压平会把
 * 「看起来很短」的文本算成超长。
 */
export function shouldClampDescription(
  text: string | null | undefined,
  maxChars: number = HERO_DESC_CLAMP_CHARS
): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return false;
  return normalized.length > maxChars;
}
