/**
 * 外部播放器跳转。
 *
 * 原理：各播放器注册了自己的 URL scheme，浏览器 `window.open()` 一个
 * 形如 `potplayer://<url>` 的地址，系统就会唤起对应客户端。
 *
 * 为什么单独抽模块：
 * 1) 各播放器的 scheme 格式不一致（见下表），散落在组件里容易写错。
 * 2) iOS 的 nPlayer、安卓的 MX Player 有自己的编码要求，必须集中处理。
 * 3) 纯函数便于单测 —— scheme 拼错是那种"只在真机上才暴露"的问题。
 *
 * ⚠️ 两个关键约束：
 * - URL 里含 `:`（`https://`），部分播放器会把它当 scheme 分隔符吃掉，
 *   所以 nPlayer 这类需要**不做 encode**直接拼，而 IINA 需要 encode。
 *   具体见每个播放器条目上的说明。
 * - 这些跳转只在**用户已安装对应客户端**时才有意义。未安装时浏览器
 *   静默失败（不会有任何提示），所以 UI 上要说明这一点。
 */

/** 支持的外部播放器 */
export type ExternalPlayerId =
  | 'potplayer'
  | 'vlc'
  | 'mpv'
  | 'iina'
  | 'nplayer'
  | 'mxplayer';

export interface ExternalPlayerInfo {
  id: ExternalPlayerId;
  label: string;
  /** 主要适用平台，用于 UI 分组/提示 */
  platform: 'desktop' | 'mobile' | 'both';
}

/** 播放器清单。顺序即 UI 展示顺序 */
export const EXTERNAL_PLAYERS: ExternalPlayerInfo[] = [
  { id: 'potplayer', label: 'PotPlayer', platform: 'desktop' },
  { id: 'vlc', label: 'VLC', platform: 'both' },
  { id: 'mpv', label: 'MPV', platform: 'desktop' },
  { id: 'iina', label: 'IINA', platform: 'desktop' },
  { id: 'nplayer', label: 'nPlayer', platform: 'mobile' },
  { id: 'mxplayer', label: 'MX Player', platform: 'mobile' },
];

/**
 * 生成唤起指定播放器的 URL。
 *
 * @param playerId 目标播放器
 * @param mediaUrl 视频地址（m3u8 直链或代理地址）
 * @param title    仅 MX Player 使用，作为播放标题
 *
 * 返回 null 表示参数非法（空地址 / 未知播放器）。
 */
export function buildExternalPlayerUrl(
  playerId: ExternalPlayerId,
  mediaUrl: string,
  title?: string
): string | null {
  const url = typeof mediaUrl === 'string' ? mediaUrl.trim() : '';
  if (!url) return null;

  switch (playerId) {
    // 这三个直接前缀拼接。地址里的 `:` 由播放器自行解析整个剩余串，
    // 所以**不能** encode —— encode 后播放器拿到的是 %3A%2F%2F，无法识别。
    case 'potplayer':
      return `potplayer://${url}`;
    case 'vlc':
      return `vlc://${url}`;
    case 'mpv':
      return `mpv://${url}`;

    // IINA 的 scheme 要求 url 作为 query 参数，必须 encode
    case 'iina':
      return `iina://weblink?url=${encodeURIComponent(url)}`;

    // nPlayer 的格式是 `nplayer-<url>`，同样是直接拼接
    case 'nplayer':
      return `nplayer-${url}`;

    // 安卓 intent 语法。package 名 com.mxtech.videoplayer.ad 是免费版，
    // 付费版是 com.mxtech.videoplayer.pro —— 这里用免费版（覆盖面更广）。
    case 'mxplayer': {
      const safeTitle = encodeURIComponent(title || '');
      const titlePart = safeTitle ? `S.title=${safeTitle};` : '';
      return `intent://${url}#Intent;package=com.mxtech.videoplayer.ad;${titlePart}end`;
    }

    default:
      return null;
  }
}

/**
 * 唤起外部播放器。
 *
 * 用 `window.open(url, '_blank')` 而非 `location.href`：
 * 后者在未安装客户端时会把当前页面导航到一个无效地址，用户直接丢失播放进度。
 * `_blank` 即使失败也只是开一个空标签页，不会破坏当前页面。
 *
 * 返回 true 表示已尝试唤起。
 */
export function launchExternalPlayer(
  playerId: ExternalPlayerId,
  mediaUrl: string,
  title?: string
): boolean {
  if (typeof window === 'undefined') return false;

  const target = buildExternalPlayerUrl(playerId, mediaUrl, title);
  if (!target) return false;

  try {
    window.open(target, '_blank');
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断当前环境是否可能支持该播放器。
 *
 * 只做**粗粒度**的平台判断（用于 UI 上折叠/禁用明显不适用的项），
 * 不做"是否已安装"的检测 —— 浏览器出于隐私考虑不提供这种能力，
 * 任何声称能检测的写法都是靠超时猜测，不可靠。
 */
export function isPlayerLikelySupported(
  playerId: ExternalPlayerId,
  userAgent: string
): boolean {
  if (!userAgent) return true;

  const ua = userAgent.toLowerCase();
  const isAndroid = ua.includes('android');
  const isIOS =
    /iphone|ipad|ipod/.test(ua) ||
    // iPadOS 13+ 的 Safari 会伪装成 macOS，靠触摸点数区分，
    // 但 UA 层面无法可靠判断，这里只认显式的 iOS 标识。
    (ua.includes('macintosh') && ua.includes('mobile'));

  const info = EXTERNAL_PLAYERS.find((p) => p.id === playerId);
  if (!info) return false;

  if (info.platform === 'both') return true;
  if (info.platform === 'mobile') return isAndroid || isIOS;
  // desktop
  return !isAndroid && !isIOS;
}
