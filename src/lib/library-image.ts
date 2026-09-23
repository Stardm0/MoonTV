/**
 * 私人影库的**封面图处理**（纯函数层，客户端与服务端共用）。
 *
 * ## 为什么要专门做一个影库封面
 *
 * 影库里的海报跟在线源的封面 URL 不是一回事：
 *   - OpenList 的图片走 `/d/<path>?sign=<签名>`，**签名由服务端拿令牌换**，
 *     浏览器既不知道令牌也拿不到签名，直连拿不到图；
 *   - 站点级配置（4.3.6 起）连影库地址都不下发浏览器，浏览器连 URL 都拼不出来；
 *   - 大多数影库压根没有海报文件，这时候应该给出「没有封面」的结论，
 *     让 UI 退回 4.3.5 做的渐变占位。
 *
 * 所以封面统一走 `/api/library-image?p=<影库内路径>`：服务端补令牌与签名，
 * 浏览器只看到一个同源图片地址。
 *
 * ## 封面从哪来
 *
 * 影库没有「元数据」概念，封面只能靠**命名约定**猜。这里沿用刮削器
 * （TinyMediaManager / 小雅 / NAS 厂商）的实际习惯：
 *
 *   `同名.jpg` > `poster.*` > `folder.*` > `cover.*` > `封面.*` > `海报.*` > 任意图片
 *
 * 最后那步「任意图片」是可选项，默认开启——目录里有海报当然好，
 * 实在没有时拿第一张相关图片也强过空白；想要严格匹配可以显式关掉。
 *
 * 本文件只有纯函数，不 import 任何运行时/服务端模块。
 */

/** 可当封面的图片扩展名 */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'];

/**
 * 通用封面文件名（不含扩展名），按优先级排列。
 *
 * 中文名放进去是因为国内影库（尤其网盘转存的资源）大量使用
 * `封面.jpg` / `海报.jpg` 这种命名。
 */
const COVER_BASENAMES = [
  'poster',
  'folder',
  'cover',
  'album',
  'thumb',
  'default',
  '封面',
  '海报',
];

/** 封面图片请求转发后的体积上限：海报再大也不该超过 8MB */
export const LIBRARY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 影库封面代理端点 */
export const LIBRARY_IMAGE_ENDPOINT = '/api/library-image';

/**
 * 允许出现在「同名 + 封面后缀」里的词：`沙丘2-poster.jpg` 可以，
 * 但 `沙丘2剧照01.jpg` 不行（那是剧照不是海报）。
 */
const DERIVED_COVER_SUFFIXES = [
  'poster',
  'cover',
  'folder',
  'thumb',
  '封面',
  '海报',
];

/** 文件名主名（去扩展名、转小写），用于和视频名配对 */
function fileStem(name: string): string {
  const base = String(name ?? '').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** 是否为可当封面的图片文件 */
export function isImageFile(name: string): boolean {
  const base = String(name ?? '').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return IMAGE_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

/** 影库目录项的最小形态（只要名字与是否目录，方便直接喂 OpenList 返回值） */
export interface LibraryCoverCandidate {
  name: string;
  is_dir?: boolean;
  size?: number;
}

/**
 * 从一组目录项里挑封面。
 *
 * @param items 同一目录下的条目（OpenList `fs/list` 的 content）
 * @param targetName 目标视频文件名 / 目录名；给了就优先找同名图片
 * @param allowAnyImage 是否允许退化到「任意第一张图片」，默认 true
 * @returns 封面文件名；没有合适封面时返回空串（调用方据此决定要不要占位）
 */
export function pickCoverFromItems(
  items: unknown,
  targetName?: string,
  allowAnyImage = true
): string {
  if (!Array.isArray(items)) return '';

  // 只有非目录的图片文件才有资格当封面
  const images = (items as LibraryCoverCandidate[]).filter(
    (item) =>
      item &&
      typeof item.name === 'string' &&
      item.is_dir !== true &&
      isImageFile(item.name)
  );
  if (images.length === 0) return '';

  const stem = fileStem(targetName ?? '');

  // ① 与目标同名：`沙丘2.mkv` ↔ `沙丘2.jpg`
  if (stem) {
    const sameStem = images.find((item) => fileStem(item.name) === stem);
    if (sameStem) return sameStem.name;
  }

  // ② 带封面后缀的同名：`沙丘2-poster.jpg` / `沙丘2.poster.jpg`
  if (stem) {
    const derived = images.find((item) => {
      const itemStem = fileStem(item.name);
      if (!itemStem.startsWith(stem)) return false;
      // 去掉分隔符后剩下的必须是封面词，否则 `沙丘2剧照01.jpg` 也会混进来
      const rest = itemStem.slice(stem.length).replace(/[\s._-]+/g, '');
      return (
        rest.length > 0 &&
        DERIVED_COVER_SUFFIXES.some((token) => rest === token)
      );
    });
    if (derived) return derived.name;
  }
  // ③ 通用封面名：poster / folder / cover / 封面 …
  for (const basename of COVER_BASENAMES) {
    const hit = images.find((item) => fileStem(item.name) === basename);
    if (hit) return hit.name;
  }

  // ④ 退化：第一张图片（目录自带的截图/剧照）
  return allowAnyImage ? images[0].name : '';
}

/**
 * 拼浏览器可用的封面地址。
 *
 * 走同源代理而不是直连：影库地址/令牌在站点级配置下浏览器根本不知道，
 * 即使是个人配置，直连也要处理 CORS 与签名。
 */
export function buildLibraryImageUrl(path: string): string {
  if (!path) return '';
  return `${LIBRARY_IMAGE_ENDPOINT}?p=${encodeURIComponent(path)}`;
}

/**
 * 解析代理端点的请求参数。
 *
 * 只接受两种：
 *   - `p`：OpenList 影库内的绝对路径
 *   - `e`：Emby 条目 ID（服务端补 api_key 取海报）
 *
 * 刻意**不支持任意 URL**（`url=`）——那等于再开一个开放代理，而本站已有
 * `/api/image-proxy` 承担那类用途；这里只服务自己的影库。
 */
export function parseLibraryImageParams(searchParams: {
  get(key: string): string | null;
}): { path: string } | { embyItemId: string } | { error: string } {
  const openlistPath = searchParams.get('p');
  const embyItemId = searchParams.get('e');

  if (openlistPath && embyItemId) {
    return { error: 'p 与 e 只能二选一' };
  }
  if (embyItemId) {
    const id = embyItemId.trim();
    if (!id) return { error: '缺少图片条目 ID' };
    if (id.length > 128) return { error: '图片条目 ID 过长' };
    return { embyItemId: id };
  }
  if (openlistPath) {
    const path = openlistPath.trim();
    if (!path) return { error: '缺少图片路径' };
    if (path.length > 2048) return { error: '图片路径过长' };
    if (!path.startsWith('/')) return { error: '图片路径必须是绝对路径' };
    return { path };
  }
  return { error: '缺少图片路径' };
}
