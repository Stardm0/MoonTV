/**
 * 可自定义快捷键。
 *
 * 设计要点：
 * 1) 动作注册表是唯一真源：新增动作只需在这里加一条，
 *    按键解析、设置面板、冲突检测都从它派生。
 * 2) 「按键组合」序列化成稳定字符串作为标识（如 `alt+arrowleft`），
 *    用户覆盖值也用同一套序列化，便于比较与持久化。
 * 3) 冲突检测返回冲突的动作 id，由 UI 决定如何呈现。
 *
 * 注意：本模块只做「解析与匹配」，不执行任何播放器操作 ——
 * 具体行为留在调用方，保持这里是纯函数、可单测。
 */

/** 可绑定的动作 */
export type ShortcutActionId =
  | 'togglePlay'
  | 'seekBackward'
  | 'seekForward'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleFullscreen'
  | 'prevEpisode'
  | 'nextEpisode'
  | 'toggleMute'
  | 'toggleDanmaku'
  | 'screenshot'
  | 'speedUp'
  | 'speedDown';

export interface ShortcutAction {
  id: ShortcutActionId;
  /** 设置面板展示名 */
  label: string;
  /** 默认键位（规范化后的字符串） */
  defaultKeys: string;
  /** 是否允许用户修改 */
  customizable: boolean;
}

/**
 * 动作注册表。顺序即设置面板的展示顺序。
 *
 * `defaultKeys` 必须与改动前 `handleKeyboardShortcuts` 的行为一致，
 * 否则升级后老用户会发现按键变了。
 */
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'togglePlay', label: '播放 / 暂停', defaultKeys: 'space', customizable: true },
  { id: 'seekBackward', label: '快退 10 秒', defaultKeys: 'arrowleft', customizable: true },
  { id: 'seekForward', label: '快进 10 秒', defaultKeys: 'arrowright', customizable: true },
  { id: 'volumeUp', label: '音量 +', defaultKeys: 'arrowup', customizable: true },
  { id: 'volumeDown', label: '音量 -', defaultKeys: 'arrowdown', customizable: true },
  { id: 'toggleFullscreen', label: '全屏切换', defaultKeys: 'f', customizable: true },
  { id: 'prevEpisode', label: '上一集', defaultKeys: 'alt+arrowleft', customizable: true },
  { id: 'nextEpisode', label: '下一集', defaultKeys: 'alt+arrowright', customizable: true },
  { id: 'toggleMute', label: '静音切换', defaultKeys: 'm', customizable: true },
  { id: 'screenshot', label: '截图', defaultKeys: 's', customizable: true },
  { id: 'speedUp', label: '加速播放', defaultKeys: 'shift+arrowright', customizable: true },
  { id: 'speedDown', label: '减速播放', defaultKeys: 'shift+arrowleft', customizable: true },
  { id: 'toggleDanmaku', label: '弹幕开关', defaultKeys: 'd', customizable: true },
];

/** 本地存储键 */
export const SHORTCUT_STORAGE_KEY = 'moontv_shortcut_bindings';

/** 用户覆盖表：动作 id → 按键串 */
export type ShortcutBindings = Partial<Record<ShortcutActionId, string>>;

/**
 * 把键盘事件规范化成按键串。
 *
 * 规则：
 * - 修饰键按固定顺序 alt → ctrl → shift → meta，保证同一组合只有一种写法
 * - 主键取 `e.key` 的小写；空格统一写成 `space`
 * - 只按修饰键本身时返回空串（不构成有效绑定）
 *
 * 刻意**忽略** `meta`（Cmd/Win）与系统快捷键的冲突高发，
 * 但仍记录它，由 UI 层决定是否允许。
 */
export function eventToKeyString(
  e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey'>
): string {
  const key = normalizeKeyName(e.key);
  if (!key) return '';

  const parts: string[] = [];
  if (e.altKey) parts.push('alt');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  parts.push(key);

  return parts.join('+');
}

/** 主键名归一化，返回空串表示这不是一个可用于绑定的键 */
function normalizeKeyName(raw: string): string {
  if (!raw) return '';

  // 单独的修饰键按下时 e.key 就是修饰键名，不构成有效绑定
  if (['Alt', 'Control', 'Shift', 'Meta'].includes(raw)) return '';

  if (raw === ' ' || raw === 'Spacebar') return 'space';

  return raw.toLowerCase();
}

/** 把按键串拆成 {修饰键集合, 主键} */
export function parseKeyString(keyString: string): {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
} | null {
  if (!keyString) return null;

  const parts = keyString.split('+').filter(Boolean);
  if (!parts.length) return null;

  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);

  return {
    alt: mods.includes('alt'),
    ctrl: mods.includes('ctrl'),
    shift: mods.includes('shift'),
    meta: mods.includes('meta'),
    key,
  };
}

/**
 * 判断键盘事件是否匹配某个按键串。
 *
 * 必须**精确匹配修饰键**：绑 `f` 时按 `shift+f` 不应触发，
 * 否则会和用户的其它组合键打架。
 */
export function matchesKeyString(
  e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey'>,
  keyString: string
): boolean {
  const parsed = parseKeyString(keyString);
  if (!parsed) return false;

  const key = normalizeKeyName(e.key);
  if (key !== parsed.key) return false;

  return (
    e.altKey === parsed.alt &&
    e.ctrlKey === parsed.ctrl &&
    e.shiftKey === parsed.shift &&
    e.metaKey === parsed.meta
  );
}

/** 合并用户覆盖，得到最终生效的绑定表（动作 id → 按键串） */
export function resolveBindings(
  overrides: ShortcutBindings = {}
): Record<ShortcutActionId, string> {
  const result = {} as Record<ShortcutActionId, string>;

  for (const action of SHORTCUT_ACTIONS) {
    const custom = overrides[action.id];
    result[action.id] =
      action.customizable && typeof custom === 'string' && custom
        ? custom
        : action.defaultKeys;
  }

  return result;
}

/**
 * 找出与给定按键串冲突的动作。
 *
 * 返回**除 excludeId 外**所有已绑定同一按键的动作 id。
 * 用于「改键时提示已占用」，由 UI 决定是拒绝还是接管。
 */
export function findConflicts(
  bindings: Record<ShortcutActionId, string>,
  keyString: string,
  excludeId?: ShortcutActionId
): ShortcutActionId[] {
  if (!keyString) return [];

  const conflicts: ShortcutActionId[] = [];
  for (const [id, bound] of Object.entries(bindings) as Array<
    [ShortcutActionId, string]
  >) {
    if (id === excludeId) continue;
    if (bound === keyString) conflicts.push(id);
  }
  return conflicts;
}

/** 把按键串渲染成人能读的形式，供设置面板展示 */
export function formatKeyString(keyString: string): string {
  if (!keyString) return '未设置';

  const parsed = parseKeyString(keyString);
  if (!parsed) return keyString;

  const MOD_LABEL: Record<string, string> = {
    alt: 'Alt',
    ctrl: 'Ctrl',
    shift: 'Shift',
    meta: 'Cmd',
  };

  const KEY_LABEL: Record<string, string> = {
    space: '空格',
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    arrowdown: '↓',
    enter: '回车',
    escape: 'Esc',
    backspace: '退格',
    delete: 'Delete',
    tab: 'Tab',
  };

  const parts: string[] = [];
  if (parsed.alt) parts.push(MOD_LABEL.alt);
  if (parsed.ctrl) parts.push(MOD_LABEL.ctrl);
  if (parsed.shift) parts.push(MOD_LABEL.shift);
  if (parsed.meta) parts.push(MOD_LABEL.meta);

  parts.push(KEY_LABEL[parsed.key] || parsed.key.toUpperCase());
  return parts.join(' + ');
}

const VALID_IDS = new Set<string>(SHORTCUT_ACTIONS.map((a) => a.id));

/** 读取用户覆盖表（含非法数据清洗） */
export function loadBindings(): ShortcutBindings {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const cleaned: ShortcutBindings = {};
    for (const [id, value] of Object.entries(parsed)) {
      // 丢弃未知动作 id，避免注册表调整后残留脏数据
      if (!VALID_IDS.has(id)) continue;
      if (typeof value !== 'string' || !value) continue;
      // 按键串必须可解析，否则视为无效
      if (!parseKeyString(value)) continue;
      cleaned[id as ShortcutActionId] = value;
    }
    return cleaned;
  } catch {
    return {};
  }
}

/** 保存用户覆盖表 */
export function saveBindings(bindings: ShortcutBindings): void {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(bindings).filter(
      ([, value]) => typeof value === 'string' && value
    );
    if (!entries.length) {
      window.localStorage.removeItem(SHORTCUT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {
    // ignore
  }
}

/** 清除全部自定义键位，恢复默认 */
export function clearBindings(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SHORTCUT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
