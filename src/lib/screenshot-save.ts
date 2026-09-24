/**
 * 截图保存：一律走浏览器下载目录。
 *
 * ## 为什么从「可选目录」退回到「只有下载」
 *
 * 曾经实现过「让用户选一个目录并记住」的两级策略（File System Access API
 * + IndexedDB 存目录句柄），但**在真机上不可靠**：
 *
 * - 目录权限**不跨会话保留**，刷新后要重新授权，用户感受就是「设置没生效」；
 * - 只有 Chromium 系支持 `showDirectoryPicker`，Firefox / Safari 直接没有；
 * - 授权窗必须落在用户手势的调用栈里，而截图是由按钮/快捷键间接触发的，
 *   中间多一次 `await` 就会静默失败。
 *
 * 结果是设置里写着「当前：电影下载」，实际却存到了浏览器下载文件夹 ——
 * **一个兑现不了的承诺比没有这个设置更糟**，所以去掉该设置，
 * 只保留能确定做对的事：自己生成合法文件名 + 触发下载。
 *
 * ## ArtPlayer 原生截图的两个问题（本模块存在的理由）
 *
 * ```js
 * let dataURL = await this.getDataURL();          // canvas.toDataURL('image/png')
 * let name = name || `artplayer_${secondToTime(currentTime)}`;
 * download(dataURL, `${name}.png`);                // <a download>
 * ```
 *
 * 1. 默认文件名带**冒号**（`artplayer_00:12:34.png`）—— Windows 不允许，
 *    会被浏览器改名甚至写失败；
 * 2. 「截了但忘了去哪找」。浏览器**从不告诉页面**落盘路径（安全模型），
 *    所以文案只敢说「浏览器下载文件夹」，**绝不编造具体路径**。
 */

/** 默认文件名前缀。与 ArtPlayer 原生保持一致，便于用户建立预期。 */
export const SCREENSHOT_FILENAME_PREFIX = 'artplayer';

/** 一次截图的结果 */
export interface ScreenshotSaveResult {
  /** 文件名（含扩展名） */
  filename: string;
  /** 给用户看的提示文案 */
  message: string;
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

/**
 * 触发浏览器下载。
 *
 * 用 `URL.createObjectURL` + `<a download>`，与 ArtPlayer 原生一致；
 * 但我们**自己控制文件名**，并在完成后 revoke 掉 objectURL。
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
 * 保存截图到浏览器下载目录。
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
    return { filename, message: '截图数据无效' };
  }

  const ok = triggerBrowserDownload(blob, filename);
  return {
    filename,
    message: ok
      ? `已截图：${filename}（已保存到浏览器下载文件夹）`
      : // 触发失败时仍要告诉用户文件**本该**去哪，否则他无从下手；
        // 措辞用「请查看」而不是「已保存」，不把没做到的事说成做到了。
        `截图已生成：${filename}，请到浏览器下载文件夹查看`,
  };
}
