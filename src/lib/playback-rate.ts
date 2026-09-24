/**
 * 播放倍速设置的本地持久化。
 *
 * 背景：ArtPlayer 的 `playbackRate: true` 只提供菜单，不做记忆。
 * 现状是两个独立的丢失点：
 *   1) 刷新页面 → 回到 1.0x
 *   2) 切集时新源加载会触发一次 ratechange，把 1.0 记进 ref 覆盖用户选择
 *
 * 这里让「用户显式选择的倍速」独立于播放器生命周期存在，
 * 由调用方在播放器就绪后恢复。
 *
 * 为什么不做服务端同步：倍速是很轻的偏好，为它引入 API 与数据结构
 * 得不偿失；真要跨设备同步时，本模块的读写可以整体替换为远端实现，
 * 不影响调用方。
 */

/** 本地存储键 */
export const PLAYBACK_RATE_STORAGE_KEY = 'moontv_preferred_playback_rate';

/** 默认倍速 */
export const DEFAULT_PLAYBACK_RATE = 1;

/** 允许的倍速范围（与 ArtPlayer 倍速菜单保持一致） */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 3;

/**
 * 归一化倍速值。
 *
 * 非法值、越界值一律回退默认，避免把脏数据（手改的存储、历史遗留格式）
 * 直接赋给 video.playbackRate 而抛 DOMException。
 */
export function normalizePlaybackRate(value: unknown): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value)
      : NaN;

  if (!Number.isFinite(num)) return DEFAULT_PLAYBACK_RATE;
  if (num < MIN_PLAYBACK_RATE || num > MAX_PLAYBACK_RATE) {
    return DEFAULT_PLAYBACK_RATE;
  }

  // 保留两位小数，避免浮点误差（1.5000000000000002）
  return Math.round(num * 100) / 100;
}

/** 读取用户偏好的倍速，读不到或非法时返回默认值 */
export function loadPlaybackRate(): number {
  if (typeof window === 'undefined') return DEFAULT_PLAYBACK_RATE;

  try {
    const raw = window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw === null) return DEFAULT_PLAYBACK_RATE;
    return normalizePlaybackRate(raw);
  } catch {
    // 隐私模式等场景下 localStorage 可能抛异常
    return DEFAULT_PLAYBACK_RATE;
  }
}

/**
 * 保存用户偏好的倍速。
 *
 * 只有「非默认值」才写入，并在回到默认值时清除记录 ——
 * 避免存储里长期留着 1.0 这类无意义条目。
 */
export function savePlaybackRate(rate: unknown): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizePlaybackRate(rate);
  try {
    if (normalized === DEFAULT_PLAYBACK_RATE) {
      window.localStorage.removeItem(PLAYBACK_RATE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(normalized));
  } catch {
    // 写入失败不影响播放
  }
}

/** 清除记忆的倍速（供设置面板「恢复默认」使用） */
export function clearPlaybackRate(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PLAYBACK_RATE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
