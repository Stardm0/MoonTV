/**
 * 下载任务的片段完成状态持久化。
 *
 * 背景：`DownloadManager` 保存任务到 localStorage 时排除了 `parsedTask`
 * （finishList 各片段的 success/error/pending 状态），导致页面刷新后
 * finishList 丢失、断点续传实际从头再来。这里把 finishList 状态和
 * 普通模式下已下载的片段数据单独持久化，使刷新后能真正续传。
 */

import { M3U8Task } from './m3u8-downloader';

const DOWNLOAD_STATE_KEY = 'downloadTaskStates';
/** 普通模式下已下载片段的 Cache Storage 桶名 */
const DOWNLOAD_SEGMENT_CACHE = 'moontv-download-segments';

/** 单个任务持久化的最小状态：只存各片段完成状态，不存 ArrayBuffer 数据 */
export interface DownloadTaskPersistState {
  /** 每个片段的完成状态（与 M3U8Task.finishList 对齐，只留 status 与 retryCount） */
  finishList: Array<{ status: '' | 'downloading' | 'success' | 'error'; retryCount?: number }>;
  /** 片段总数（用于校验 m3u8 是否变更） */
  totalSegments: number;
  /** 最后更新时间戳 */
  updatedAt: number;
}

type StateMap = Record<string, DownloadTaskPersistState>;

function readAll(): StateMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DOWNLOAD_STATE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StateMap;
  } catch {
    return {};
  }
}

function writeAll(map: StateMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DOWNLOAD_STATE_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式 / 配额满时静默失败，不影响下载本身
  }
}

/** 从任务里抽取可持久化的完成状态 */
export function persistDownloadState(taskId: string, task: M3U8Task): void {
  const map = readAll();
  map[taskId] = {
    finishList: task.finishList.map((item) => ({
      status: item.status,
      ...(item.retryCount !== undefined ? { retryCount: item.retryCount } : {}),
    })),
    totalSegments: task.finishList.length,
    updatedAt: Date.now(),
  };
  writeAll(map);
}

/** 读取任务的持久化状态（不存在或片段数不匹配时返回 null） */
export function loadDownloadState(taskId: string): DownloadTaskPersistState | null {
  const state = readAll()[taskId];
  return state && state.totalSegments > 0 ? state : null;
}

/** 任务完成/删除后清理持久化状态 */
export function clearDownloadState(taskId: string): void {
  const map = readAll();
  if (map[taskId]) {
    delete map[taskId];
    writeAll(map);
  }
  // 清理该任务的已下片段缓存
  void clearDownloadSegments(taskId);
}

/* ------------------------------------------------------------------ */
/* 普通模式下已下载片段的 Cache Storage 持久化（用于刷新后续传复用）  */
/* ------------------------------------------------------------------ */

function segmentCacheKey(taskId: string, index: number): string {
  return `${taskId}:${index}`;
}

export async function saveDownloadSegment(
  taskId: string,
  index: number,
  data: ArrayBuffer
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(DOWNLOAD_SEGMENT_CACHE);
    await cache.put(
      segmentCacheKey(taskId, index),
      new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    );
  } catch {
    // 写缓存失败不影响下载，只是无法跨刷新复用
  }
}

export async function loadDownloadSegment(
  taskId: string,
  index: number
): Promise<ArrayBuffer | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(DOWNLOAD_SEGMENT_CACHE);
    const resp = await cache.match(segmentCacheKey(taskId, index));
    if (!resp) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

export async function clearDownloadSegments(taskId: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(DOWNLOAD_SEGMENT_CACHE);
    const keys = await cache.keys();
    const prefix = `${taskId}:`;
    await Promise.all(
      keys
        .filter((req) => req.url.includes(prefix))
        .map((req) => cache.delete(req))
    );
  } catch {
    // ignore
  }
}
