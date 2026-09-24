/**
 * 播放音量的本地持久化。
 *
 * 与倍速同病：ArtPlayer 只提供音量调节 UI，不做记忆。
 * 现状是 `lastVolumeRef` 初始 0.7，只在单次会话内保持，
 * 刷新页面后用户调好的音量丢失。
 *
 * 静音状态（muted）**不**持久化：用户调音量后又静音，
 * 下次打开期望听到声音的概率更高；而且浏览器对自动播放的
 * 静音策略本身会覆盖这个设置，持久化它反而制造矛盾。
 */

/** 本地存储键 */
export const VOLUME_STORAGE_KEY = 'moontv_preferred_volume';

/** 默认音量（与 ArtPlayer 的 volume 默认值保持一致） */
export const DEFAULT_VOLUME = 0.7;

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;

/**
 * 归一化音量值。
 *
 * 越界值钳制到 [0,1] 而不是回退默认 —— 音量是连续量，
 * 0.999 这种值被丢弃没有意义。只有完全非法的输入才回退。
 */
export function normalizeVolume(value: unknown): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value)
      : NaN;

  if (!Number.isFinite(num)) return DEFAULT_VOLUME;
  if (num < MIN_VOLUME) return MIN_VOLUME;
  if (num > MAX_VOLUME) return MAX_VOLUME;

  // 收敛浮点误差，避免 0.30000000000000004 这类值进存储
  return Math.round(num * 100) / 100;
}

/** 读取用户偏好的音量 */
export function loadVolume(): number {
  if (typeof window === 'undefined') return DEFAULT_VOLUME;

  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    return normalizeVolume(raw);
  } catch {
    return DEFAULT_VOLUME;
  }
}

/**
 * 保存用户偏好的音量。
 *
 * 音量为 0 的用户是刻意静音，必须记住（这与倍速「回到默认就清除」不同）。
 * 只有恰好等于默认值时才清除记录，保持存储干净。
 */
export function saveVolume(volume: unknown): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeVolume(volume);
  try {
    if (normalized === DEFAULT_VOLUME) {
      window.localStorage.removeItem(VOLUME_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(normalized));
  } catch {
    // 写入失败不影响播放
  }
}

/** 清除记忆的音量 */
export function clearVolume(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(VOLUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}
