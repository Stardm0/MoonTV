import { RoomRequest, RoomResponse } from './types';

const REQUEST_TIMEOUT_MS = 6_000;

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
