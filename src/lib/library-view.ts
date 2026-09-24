/**
 * 影库浏览页的「查看方式」（照 Windows 资源管理器右键 → 查看 的四档）。
 *
 * ## 为什么单独成模块
 *
 * 这是纯偏好数据 + localStorage 读写，与影库协议无关，混进 `openlist.ts`
 * 会让它越来越像杂物抽屉。参照 `src/lib/sidenav.ts` 的做法单独放一份，
 * 判断函数可单测，DOM 部分保持极薄。
 *
 * 四档含义：
 *   - `list`   列表（一行一项，带缩略图与大小）
 *   - `small`  小图标
 *   - `medium` 中等图标
 *   - `large`  大图标
 */
export const LIBRARY_VIEW_KEY = 'moontv_library_view';

export const LIBRARY_VIEWS = ['list', 'small', 'medium', 'large'] as const;

export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/** 默认视图：列表（信息密度最高，也是改造前的形态，老用户无感） */
export const DEFAULT_LIBRARY_VIEW: LibraryView = 'list';

export function isLibraryView(value: unknown): value is LibraryView {
  return (
    typeof value === 'string' &&
    (LIBRARY_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * 读取上次选择的视图。
 *
 * localStorage 在隐私模式下可能直接抛错，读不到就退回默认，不影响浏览。
 */
export function readLibraryView(): LibraryView {
  if (typeof window === 'undefined') return DEFAULT_LIBRARY_VIEW;
  try {
    const raw = window.localStorage.getItem(LIBRARY_VIEW_KEY);
    return isLibraryView(raw) ? raw : DEFAULT_LIBRARY_VIEW;
  } catch {
    return DEFAULT_LIBRARY_VIEW;
  }
}

export function writeLibraryView(view: LibraryView): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIBRARY_VIEW_KEY, view);
  } catch {
    // 存不下就只影响本次会话之后的默认值
  }
}
