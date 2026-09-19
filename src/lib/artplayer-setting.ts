/**
 * ArtPlayer 设置面板的「低侵入」更新工具（P1-7）。
 *
 * ## 为什么需要它
 *
 * ArtPlayer 5.3.0 的 `Setting.update()` 生产代码等价于：
 *
 * ```js
 * update(option) {
 *   const item = this.find(option.name)
 *   if (!item) return this.add(option)
 *   this.inactivate(item)          // 解绑该 item 的 DOM 事件
 *   Object.assign(item, option)
 *   this.format()                  // 重建整棵 setting 树
 *   this.createItem(item, true)    // 替换该 item 的 DOM
 *   this.render()                  // ← 不带参数 = 渲染【根面板】
 *   return item
 * }
 * ```
 *
 * 也就是说 **每一次 `update()` 都会把设置面板强制弹回根面板**。
 *
 * 而「视频缓存」的进度提示是在预取回调里刷新的——每缓存一个分片一次，
 * 一集动辄几百个分片。用户刚点进「画质」子面板就被立刻弹回根面板，
 * 表现就是"要点很多次才能进去"。
 *
 * ## 解法
 *
 * 只改 tooltip / switch / html 这类**叶子状态**时，直接写 ArtPlayer 暴露的
 * DOM setter：`createItem()` 里对 `tooltip` / `html` / `switch` 都定义了
 * `Object.defineProperty` 的 setter，setter 内部只改对应节点，不触发 `render()`。
 *
 * 只有必须替换 `selector`（画质档位列表）时才走 `update()`，
 * 并且用 `updateSettingPreservingPanel()` 把面板层级恢复回来。
 */

/** ArtPlayer 实例的宽松类型（官方 .d.ts 未声明 setting 的细节） */
export interface ArtPlayerLike {
  setting?: {
    find?: (name?: string) => SettingItemLike | null;
    update?: (option: Record<string, unknown>) => unknown;
    render?: (option?: unknown) => void;
    show?: boolean;
    active?: unknown;
    option?: unknown;
  } | null;
  [key: string]: unknown;
}

/** 设置项的宽松类型 */
export interface SettingItemLike {
  name?: string;
  html?: unknown;
  tooltip?: unknown;
  switch?: boolean;
  selector?: unknown;
  [key: string]: unknown;
}

/** 取设置项；播放器已销毁 / 尚未就绪时返回 null，不抛异常 */
export function findSettingItem(
  art: ArtPlayerLike | null | undefined,
  name: string
): SettingItemLike | null {
  try {
    const item = art?.setting?.find?.(name);
    return item ?? null;
  } catch {
    return null;
  }
}

/**
 * 更新设置项的右侧提示文案。
 * 走 DOM setter，**不会**触发 `render()`，因此不会打断用户当前所在的面板层级。
 */
export function setSettingTooltip(
  art: ArtPlayerLike | null | undefined,
  name: string,
  text: string
): boolean {
  const item = findSettingItem(art, name);
  if (!item) return false;
  try {
    item.tooltip = text;
    return true;
  } catch {
    return false;
  }
}

/** 更新设置项左侧标题（同样是 DOM setter，不触发 render） */
export function setSettingHtml(
  art: ArtPlayerLike | null | undefined,
  name: string,
  html: string
): boolean {
  const item = findSettingItem(art, name);
  if (!item) return false;
  try {
    item.html = html;
    return true;
  } catch {
    return false;
  }
}

/** 更新开关状态（DOM setter 会同步切换开/关两个图标） */
export function setSettingSwitch(
  art: ArtPlayerLike | null | undefined,
  name: string,
  on: boolean
): boolean {
  const item = findSettingItem(art, name);
  if (!item) return false;
  try {
    item.switch = on;
    return true;
  } catch {
    return false;
  }
}

/**
 * 必须替换 `selector` 等结构性字段时用它。
 *
 * `update()` 之后把面板层级恢复回调用前的位置：
 * - 原来停在根面板 → 恢复根面板
 * - 原来停在该项的**子面板** → 用**更新后的** selector 数组重新进入子面板
 *   （`update()` 会重建 selector 数组，旧的引用已经不在 `cache` 里了）
 *
 * 面板未展开时不做任何恢复，避免把关闭状态的面板顶开。
 */
export function updateSettingPreservingPanel(
  art: ArtPlayerLike | null | undefined,
  patch: Record<string, unknown> & { name: string }
): boolean {
  const setting = art?.setting;
  if (!setting?.update) return false;

  const wasShow = setting.show === true;
  const previousActive = setting.active;
  const previousSelector = findSettingItem(art, patch.name)?.selector;

  try {
    setting.update(patch);
  } catch {
    return false;
  }

  if (!wasShow) return true;

  try {
    const updated = findSettingItem(art, patch.name);
    const stayInSubPanel =
      previousSelector !== undefined &&
      previousActive === previousSelector &&
      updated?.selector !== undefined;

    const target = stayInSubPanel ? updated?.selector : previousActive;
    if (target) setting.render?.(target);
    setting.show = true;
  } catch {
    // 面板结构可能刚被重建，忽略
  }

  return true;
}
