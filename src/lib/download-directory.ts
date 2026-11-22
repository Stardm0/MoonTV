/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 文件系统直写模式下的「保存文件夹」管理。
 *
 * 批量下载时每集都需要一个写入流，但 `showSaveFilePicker` 每次调用都要求
 * 用户手势；排队/异步解析后的任务无法再次弹窗。这里改为只在用户点击时
 * `showDirectoryPicker` 选一次目录，之后所有任务通过目录句柄创建文件，
 * 从而保证批量任务真正统一使用「文件系统直写」模式。
 */

import type { DirectoryHandleLike } from './stream-saver-fallback';

export type { DirectoryHandleLike } from './stream-saver-fallback';

const DB_NAME = 'moontv-download-directory';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'download-directory';

let cachedHandle: DirectoryHandleLike | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function readHandleFromDb(): Promise<DirectoryHandleLike | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () =>
        resolve((request.result as DirectoryHandleLike) || null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeHandleToDb(handle: DirectoryHandleLike): Promise<void> {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 当前浏览器是否支持选择保存文件夹（File System Access API） */
export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).showDirectoryPicker === 'function'
  );
}

/**
 * 让用户选择保存文件夹。必须在用户手势（点击/change）中调用。
 * 选中的句柄会缓存在内存与 IndexedDB 中，批量任务共用同一个目录。
 */
export async function pickDownloadDirectory(): Promise<DirectoryHandleLike> {
  if (!supportsDirectoryPicker()) {
    throw new Error('当前浏览器不支持选择保存文件夹');
  }

  const handle = (await (window as any).showDirectoryPicker({
    id: 'moontv-downloads',
    mode: 'readwrite',
    startIn: 'downloads',
  })) as DirectoryHandleLike;

  cachedHandle = handle;
  await writeHandleToDb(handle);
  return handle;
}

export function getCachedDownloadDirectory(): DirectoryHandleLike | null {
  return cachedHandle;
}

/** 恢复上次选择的保存文件夹（不主动请求权限，避免无手势时被浏览器拒绝） */
export async function restoreDownloadDirectory(): Promise<DirectoryHandleLike | null> {
  if (cachedHandle) return cachedHandle;

  const handle = await readHandleFromDb();
  if (handle) cachedHandle = handle;
  return handle;
}

/**
 * 检查/申请保存文件夹的读写权限。
 *
 * `request=true` 时会调用 `requestPermission`，需要用户手势；
 * 页面刷新后的自动恢复没有手势，此时返回 false，让任务保持暂停，
 * 等用户手动点击「继续」再申请权限即可。
 */
export async function ensureDirectoryPermission(
  handle: DirectoryHandleLike,
  request = true
): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true;

  try {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') return true;
    if (!request) return false;

    // requestPermission 需要 transient user activation。
    // 自动恢复阶段没有手势，直接返回 false，避免抛异常或静默换模式。
    const activation =
      typeof navigator !== 'undefined'
        ? (navigator as any).userActivation
        : null;
    if (activation && activation.isActive === false) return false;

    if (typeof handle.requestPermission !== 'function') return false;
    permission = await handle.requestPermission({ mode: 'readwrite' });
    return permission === 'granted';
  } catch {
    return false;
  }
}
