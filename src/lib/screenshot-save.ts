/**
 * 截图保存：优先「用户选定的目录」，降级「浏览器下载目录」。
 *
 * ## 为什么需要这个模块
 *
 * ArtPlayer 5.3.0 的原生截图实现是：
 * ```js
 * let dataURL = await this.getDataURL();          // canvas.toDataURL('image/png')
 * let name = name || `artplayer_${secondToTime(currentTime)}`;
 * download(dataURL, `${name}.png`);                // <a download> 触发浏览器下载
 * ```
 *
 * 问题在于**浏览器从不告诉页面文件落到哪了**。`<a download>` 只是把字节
 * 交给浏览器的下载管理器，具体目录由浏览器设置决定，页面无从读取 ——
 * 这是浏览器的安全模型，不是实现缺陷。
 *
 * 于是用户的真实痛点是：「截了，但忘了去哪个文件夹找」。
 *
 * ## 两级策略
 *
 * **B —— File System Access API（`showSaveFilePicker`）**
 * 让用户**选一次目录并授权**，把 `FileSystemDirectoryHandle` 存进 IndexedDB。
 * 之后每次截图直接写进那个目录，页面**真的知道路径**，可以把
 * 「文件名 + 目录名」显示出来，并能提供「打开文件夹」。
 * Chromium 系（Chrome / Edge）支持。
 *
 * **A —— 降级：浏览器下载目录**
 * 不支持上述 API、或用户拒绝授权时，退回 `<a download>`，提示里只敢说
 * 「已保存到浏览器下载目录」—— 因为确实不知道路径，**不能编造**。
 *
 * ## 关键约束
 *
 * - 目录句柄**必须存 IndexedDB**，不能存 localStorage：它是结构化对象，
 *   localStorage 只能存字符串；`JSON.stringify` 会把它变成 `{}`。
 * - 权限**不会跨会话自动保留**。即使句柄存下来了，新会话仍需
 *   `requestPermission()` 确认一次；`queryPermission()` 只用来判断当前状态。
 * - 写入必须用 `createWritable()` + `close()`；没 `close()` 文件是空的。
 */

/** IndexedDB 库名 / 对象仓库名（与视频缓存分开，避免互相影响） */
const DB_NAME = 'moontv-screenshot-fs';
const STORE_NAME = 'handles';
const DIR_KEY = 'screenshot-dir';

/** 默认文件名前缀。与 ArtPlayer 原生保持一致，便于用户建立预期。 */
export const SCREENSHOT_FILENAME_PREFIX = 'artplayer';

/** 截图保存模式 */
export type ScreenshotSaveMode =
  /** 已授权目录，直接写入并知道路径 */
  | 'directory'
  /** 退回到浏览器下载目录 */
  | 'download';

/** 一次截图的结果 */
export interface ScreenshotSaveResult {
  mode: ScreenshotSaveMode;
  /** 文件名（含扩展名），两种模式都有 */
  filename: string;
  /** 仅 `directory` 模式有值：用户选定目录的名字 */
  directoryName?: string;
  /** 给用户看的提示文案 */
  message: string;
}

/**
 * 该环境是否支持「选目录保存」。
 *
 * 只认 `showDirectoryPicker` —— 我们**需要目录句柄**才能「下次直接写进去」。
 * `showSaveFilePicker` 只能拿到文件句柄、推不出目录，做不出「记住路径」这件事，
 * 所以不算支持（早前误把它当降级路径，会给出一个兑现不了的承诺）。
 */
export function supportsDirectorySave(
  win: unknown = typeof window === 'undefined' ? null : window
): boolean {
  if (!win || typeof win !== 'object') return false;
  const w = win as Record<string, unknown>;
  return typeof w.showDirectoryPicker === 'function';
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/**
 * 把秒数转成 `HH_MM_SS` 片段，用于文件名。
 *
 * 用下划线而不是冒号 —— Windows 文件名不允许冒号，会直接写失败。
 * ArtPlayer 自己的 `secondToTime()` 产出 `00:12:34`，那种名字在 Windows
 * 上会被浏览器替换掉，这里主动规整。
 */
export function formatTimestampSegment(seconds: number): string {
  const safe =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join('_');
}

/**
 * 生成截图文件名（含 `.png`）。
 *
 * @param options.currentTime 当前播放进度（秒）
 * @param options.title       剧集标题，可选。会被清洗成合法文件名
 * @param options.now         注入当前时间，便于测试
 */
export function buildScreenshotFilename(options: {
  currentTime?: number;
  title?: string;
  now?: Date;
}): string {
  const { currentTime = 0, title, now = new Date() } = options;

  const parts = [SCREENSHOT_FILENAME_PREFIX];

  const safeTitle = sanitizeFilenamePart(title ?? '', 40);
  if (safeTitle) parts.push(safeTitle);

  parts.push(formatTimestampSegment(currentTime));

  // 加日期前缀避免同名覆盖（同一天同一进度截两次也能区分）
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  parts.splice(1, 0, date);

  return `${parts.join('_')}.png`;
}

/**
 * 清洗文件名片段：去掉路径分隔符与 Windows 非法字符，压缩空白，截断长度。
 *
 * 不依赖任何浏览器 API，纯字符串处理，可直接单测。
 */
export function sanitizeFilenamePart(input: string, maxLength = 40): string {
  if (typeof input !== 'string') return '';
  let out = input
    // 路径分隔符与 Windows 保留字符
    .replace(/[\\/:*?"<>|]/g, '')
    // 控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 空白（含全角空格）压成单个下划线
    .replace(/[\s\u3000]+/g, '_')
    // 连续下划线合并
    .replace(/_+/g, '_')
    // 首尾下划线与点（Windows 不允许结尾点）
    .replace(/^[_.]+|[_.]+$/g, '');
  if (out.length > maxLength) out = out.slice(0, maxLength);
  // 截断后可能又出现结尾下划线
  out = out.replace(/[_.]+$/g, '');
  return out;
}

// ---------------------------------------------------------------------------
// IndexedDB 存取目录句柄
// ---------------------------------------------------------------------------

/**
 * 目录句柄的宽松类型（`FileSystemDirectoryHandle` 在 TS DOM lib 里
 * 随版本差异较大，这里只用得到 name / 写入相关方法）。
 */
export interface DirectoryHandleLike {
  name?: string;
  getFileHandle?: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<FileHandleLike>;
  queryPermission?: (descriptor?: { mode?: string }) => Promise<string>;
  requestPermission?: (descriptor?: { mode?: string }) => Promise<string>;
}

export interface FileHandleLike {
  createWritable?: () => Promise<WritableLike>;
}

export interface WritableLike {
  write?: (data: unknown) => Promise<void> | void;
  close?: () => Promise<void> | void;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // 某些隐私模式下会一直挂起，超时兜底
      setTimeout(() => resolve(null), 2000);
    } catch {
      resolve(null);
    }
  });
}

/** 保存目录句柄。句柄是结构化对象，**不能**走 localStorage。 */
export async function saveDirectoryHandle(
  handle: DirectoryHandleLike | null
): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      if (handle) store.put(handle, DIR_KEY);
      else store.delete(DIR_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** 读取已保存的目录句柄（不校验权限，权限要单独查） */
export async function loadDirectoryHandle(): Promise<DirectoryHandleLike | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(DIR_KEY);
      req.onsuccess = () =>
        resolve((req.result as DirectoryHandleLike) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** 清除已保存的目录（用户改主意 / 句柄失效时用） */
export async function clearDirectoryHandle(): Promise<void> {
  await saveDirectoryHandle(null);
}

/** 权限状态 */
export type DirPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** 查询当前权限（不会弹窗） */
export async function queryDirectoryPermission(
  handle: DirectoryHandleLike | null
): Promise<DirPermission> {
  if (!handle?.queryPermission) return 'unknown';
  try {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || state === 'denied' || state === 'prompt') {
      return state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 申请权限（**会弹窗**，必须由用户手势触发）。
 *
 * 必须在 click 的调用栈里直接 await，不能先 await 别的东西再调 ——
 * 否则浏览器认为不是用户手势，直接拒绝。调用方注意顺序。
 */
export async function requestDirectoryPermission(
  handle: DirectoryHandleLike | null
): Promise<DirPermission> {
  if (!handle?.requestPermission) return 'unknown';
  try {
    const state = await handle.requestPermission({ mode: 'readwrite' });
    if (state === 'granted' || state === 'denied' || state === 'prompt') {
      return state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

/** dataURL → Blob，避免再走一次 canvas */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    if (!/^data:image\//i.test(meta)) return null;
    const isBase64 = /;base64/i.test(meta);
    const mime = meta.slice(5).split(';')[0] || 'image/png';
    if (!isBase64) {
      return new Blob([decodeURIComponent(body)], { type: mime });
    }
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/** 把 Blob 写进指定目录，返回是否成功 */
export async function writeBlobToDirectory(
  dir: DirectoryHandleLike,
  filename: string,
  blob: Blob
): Promise<boolean> {
  if (!dir?.getFileHandle) return false;
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle?.createWritable?.();
    if (!writable?.write) return false;
    await writable.write(blob);
    // ⚠️ 不 close() 文件是空的 —— 最容易被忘的一步
    await writable.close?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * 触发浏览器下载（降级路径 A）。
 *
 * 用 `URL.createObjectURL` + `<a download>`，与 ArtPlayer 原生一致；
 * 但我们**自己控制文件名**，并会在完成后 revoke 掉 objectURL。
 */
export function triggerBrowserDownload(blob: Blob, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined')
    return false;
  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    return false;
  } finally {
    // 稍后释放，太早会让下载拿不到数据
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

/**
 * 保存截图：有授权目录就写进去（B），否则退回下载目录（A）。
 *
 * @param dataUrl  ArtPlayer `getDataURL()` 的产物
 * @param filename 目标文件名（含扩展名），由 {@link buildScreenshotFilename} 生成
 */
export async function saveScreenshot(
  dataUrl: string,
  filename: string
): Promise<ScreenshotSaveResult> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) {
    return {
      mode: 'download',
      filename,
      message: '截图数据无效',
    };
  }

  // B：已保存目录 + 权限仍有效 → 直接写入，且我们知道路径
  const handle = await loadDirectoryHandle();
  if (handle) {
    const permission = await queryDirectoryPermission(handle);
    if (permission === 'granted') {
      const ok = await writeBlobToDirectory(handle, filename, blob);
      if (ok) {
        const dirName = handle.name || '所选文件夹';
        return {
          mode: 'directory',
          filename,
          directoryName: dirName,
          message: `已截图：${filename}（保存在「${dirName}」）`,
        };
      }
    }
  }

  // A：降级到浏览器下载目录。**不能声称知道路径** —— 浏览器不告诉我们。
  const ok = triggerBrowserDownload(blob, filename);
  return {
    mode: 'download',
    filename,
    message: ok
      ? `已截图：${filename}（已保存到浏览器下载文件夹）`
      : // 触发失败时仍要告诉用户文件**本该**去哪，否则他无从下手；
        // 措辞用「请查看」而不是「已保存」，不把没做到的事说成做到了。
        `截图已生成：${filename}，请到浏览器下载文件夹查看`,
  };
}

/**
 * 读取当前截图保存目录的状态，用于设置面板展示。
 *
 * 只做**查询**，不会弹权限窗 —— 设置面板渲染时调用它是安全的。
 * 权限需要在用户点击时单独 {@link requestDirectoryPermission}。
 */
export async function describeScreenshotDirectory(): Promise<{
  /** 是否支持选目录（Chromium 系） */
  supported: boolean;
  /** 已保存目录的名字，无则为 null */
  directoryName: string | null;
  /** 已保存目录当前的权限状态 */
  permission: DirPermission;
}> {
  const supported = supportsDirectorySave();
  const handle = await loadDirectoryHandle();
  if (!handle) {
    return { supported, directoryName: null, permission: 'unknown' };
  }
  const permission = await queryDirectoryPermission(handle);
  return {
    supported,
    directoryName: handle.name || '所选文件夹',
    permission,
  };
}

export async function pickScreenshotDirectory(
  win: unknown = typeof window === 'undefined' ? null : window
): Promise<{ name: string } | null> {
  if (!supportsDirectorySave(win)) return null;
  try {
    const showDirectoryPicker = (
      win as {
        showDirectoryPicker: (o?: unknown) => Promise<DirectoryHandleLike>;
      }
    ).showDirectoryPicker;
    const dir = await showDirectoryPicker({ mode: 'readwrite' });
    if (!dir) return null;
    // 句柄存不下来（隐私模式 / IndexedDB 不可用）时，不能假装设置成功 ——
    // 否则下次截图会退回下载目录，用户以为设过了却找不到文件。
    const saved = await saveDirectoryHandle(dir);
    if (!saved) return null;
    return { name: dir.name || '所选文件夹' };
  } catch {
    // 用户取消（AbortError）或权限拒绝都走这里
    return null;
  }
}
