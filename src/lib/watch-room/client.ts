import { RoomRequest, RoomResponse } from './types';

const REQUEST_TIMEOUT_MS = 6_000;

/**
 * 成员 id 按标签页缓存在 sessionStorage。
 *
 * 抽到共享模块是为了让「观影室页面点播放此房间」和「播放页面板」读写同一把
 * key：前者通过 enterOwned 拿到服务端确认的 memberId 后必须先落盘，否则跳转
 * 到播放页时 URL 入房会带着空 / 旧 id，触发不必要的房主重接管。
 */
const memberKey = (roomId: string) => `moontv:watchroom:member:${roomId}`;

export function cachedMemberId(roomId: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(memberKey(roomId)) || '';
  } catch {
    return '';
  }
}

export function cacheMemberId(roomId: string, memberId: string): void {
  if (typeof window === 'undefined' || !memberId) return;
  try {
    window.sessionStorage.setItem(memberKey(roomId), memberId);
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function clearCachedMemberId(roomId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(memberKey(roomId));
  } catch {
    /* ignore */
  }
}

/**
 * 观影室唯一请求入口。统一走 POST + no-store，避免被 PWA Service Worker
 * 或 CDN 缓存成旧状态。
 */
export async function roomRequest(
  payload: RoomRequest | Record<string, unknown>
): Promise<RoomResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('/api/watch-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });

    let data: RoomResponse | null = null;
    try {
      data = (await res.json()) as RoomResponse;
    } catch {
      // middleware 返回的是纯文本 Unauthorized
      return {
        ok: false,
        error:
          res.status === 401
            ? '登录状态已失效，请重新登录'
            : `请求失败 (${res.status})`,
      };
    }

    if (!res.ok && !data?.ok) {
      return { ok: false, error: data?.error || `请求失败 (${res.status})` };
    }
    return data;
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? '请求超时，正在重试' : '网络连接异常',
    };
  } finally {
    clearTimeout(timer);
  }
}
