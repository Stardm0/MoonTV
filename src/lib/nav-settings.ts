/**
 * 导航栏本地设置。
 *
 * 目前仅有「自动隐藏导航栏」一项：开启后导航栏默认收起，
 * 指针移到对应屏幕边缘（桌面为顶部、移动端为底部）时再自动弹出，
 * 效果类似操作系统任务栏的自动隐藏。
 */

/** localStorage 中保存自动隐藏开关的键名 */
export const NAV_AUTO_HIDE_STORAGE_KEY = 'autoHideNav';

/** localStorage 中保存「导航菜单自定义顺序」的键名 */
export const NAV_ORDER_STORAGE_KEY = 'navMenuOrder';

/** 设置变更时派发的自定义事件名（同一标签页内即时生效） */
export const NAV_SETTINGS_UPDATED_EVENT = 'navSettingsUpdated';

/** 菜单顺序变更时派发的自定义事件名 */
export const NAV_ORDER_UPDATED_EVENT = 'navMenuOrderUpdated';

export interface NavSettings {
  /** 是否启用导航栏自动隐藏 */
  autoHideNav: boolean;
}

const DEFAULT_NAV_SETTINGS: NavSettings = {
  autoHideNav: false,
};

/** 读取导航栏设置（SSR 或存储不可用时返回默认值） */
export function loadNavSettings(): NavSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_NAV_SETTINGS };

  try {
    return {
      autoHideNav:
        window.localStorage.getItem(NAV_AUTO_HIDE_STORAGE_KEY) === 'true',
    };
  } catch {
    return { ...DEFAULT_NAV_SETTINGS };
  }
}

/**
 * 保存导航栏设置，并通知同一标签页内的导航栏组件立即响应。
 * @param patch 需要更新的字段
 * @returns 合并后的完整设置
 */
export function saveNavSettings(patch: Partial<NavSettings>): NavSettings {
  const next = { ...loadNavSettings(), ...patch };

  if (typeof window === 'undefined') return next;

  try {
    window.localStorage.setItem(
      NAV_AUTO_HIDE_STORAGE_KEY,
      String(next.autoHideNav)
    );
  } catch {
    // 隐私模式等场景写入失败时，本次会话内仍然保持内存状态生效
  }

  window.dispatchEvent(new Event(NAV_SETTINGS_UPDATED_EVENT));
  return next;
}

/**
 * 读取用户自定义的菜单顺序（未设置或存储不可用时返回空数组）。
 *
 * 桌面顶部导航与移动端底部导航共用同一份顺序，这样在手机浏览器里
 * 切换到"桌面版网页"后，刚才调整的顺序依然保留。
 */
export function loadNavMenuOrder(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(NAV_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

/**
 * 把「当前可见项的排序结果」合并进已有顺序。
 *
 * 桌面与移动端的菜单集合并不完全相同（移动端多一个"搜索"），
 * 若直接用新顺序覆盖，另一端的独有项会丢失位置。
 * 这里把未出现在新顺序里的旧项，插到它在旧顺序中最近的相邻项旁边。
 */
function mergeNavOrder(nextOrder: string[], previous: string[]): string[] {
  if (previous.length === 0) return nextOrder;

  const included = new Set(nextOrder);
  const result = [...nextOrder];

  previous.forEach((key, index) => {
    if (included.has(key)) return;

    // 优先插到旧顺序中"后一个已存在项"之前
    let anchor = -1;
    for (let i = index + 1; i < previous.length; i += 1) {
      const pos = result.indexOf(previous[i]);
      if (pos !== -1) {
        anchor = pos;
        break;
      }
    }
    if (anchor !== -1) {
      result.splice(anchor, 0, key);
      return;
    }

    // 否则插到"前一个已存在项"之后
    let prevAnchor = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      const pos = result.indexOf(previous[i]);
      if (pos !== -1) {
        prevAnchor = pos;
        break;
      }
    }
    if (prevAnchor === -1) result.push(key);
    else result.splice(prevAnchor + 1, 0, key);
  });

  return result;
}

/** 保存菜单顺序并通知同页导航栏立即应用 */
export function saveNavMenuOrder(order: string[]): void {
  if (typeof window === 'undefined') return;

  const merged = mergeNavOrder(order, loadNavMenuOrder());

  try {
    window.localStorage.setItem(NAV_ORDER_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // 隐私模式等写入失败场景：本次会话内仍可通过事件即时生效
  }

  window.dispatchEvent(new Event(NAV_ORDER_UPDATED_EVENT));
}

/** 按用户自定义顺序重排列表；未记录的项保持原有相对顺序排在末尾 */
export function applyNavMenuOrder<T>(
  items: T[],
  getKey: (item: T) => string,
  order: string[]
): T[] {
  if (order.length === 0) return items;

  const indexMap = new Map<string, number>();
  order.forEach((key, index) => indexMap.set(key, index));

  const ordered = [...items].sort((a, b) => {
    const ai = indexMap.get(getKey(a));
    const bi = indexMap.get(getKey(b));
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });

  return ordered;
}
