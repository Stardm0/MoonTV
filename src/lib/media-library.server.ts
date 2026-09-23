/**
 * 站点级私人影库配置的**服务端读取**。
 *
 * 与 `media-library.ts` 分开的原因：这里 `import { getConfig }`，
 * 而 `getConfig` 会拉起存储层（`db`），**只能被服务端路由引用**；
 * 客户端组件引用它会被打进浏览器包并在运行时炸掉。
 * 纯函数部分留在 `media-library.ts`，两边共用。
 */

import { getConfig } from './config';
import {
  type MediaLibraryConfig,
  isMediaLibraryUsable,
  normalizeMediaLibraryConfig,
  toOpenListConfig,
} from './media-library';
import type { OpenListConfig } from './openlist';
import { parseOpenListConfigFromCookieHeader } from './openlist';

/**
 * 读取管理员配置的站点级影库；没配过或已停用返回 `null`。
 *
 * 注意：即使管理员把开关关了，只要地址还在，`getConfig()` 也会读出配置对象，
 * 所以调用方要用 `Enabled` 判断——这里直接把「停用」当成「没有」。
 */
export async function getServerMediaLibraryConfig(): Promise<MediaLibraryConfig | null> {
  try {
    const config = await getConfig();
    const normalized = normalizeMediaLibraryConfig(
      config?.SiteConfig?.MediaLibrary
    );
    if (!normalized || !isMediaLibraryUsable(normalized)) return null;
    return normalized;
  } catch {
    // 配置读不出来时按未配置处理：影库是可选功能，不该让整站报错
    return null;
  }
}

/**
 * 解析本次请求该用哪份影库连接配置。
 *
 * **个人 cookie 优先，服务端全局兜底**——已经配过 cookie 的用户不该被
 * 管理员新加的全局配置悄悄换掉影库。
 */
export async function resolveOpenListConfig(
  cookieHeader: string | null | undefined
): Promise<OpenListConfig | null> {
  const fromCookie = parseOpenListConfigFromCookieHeader(cookieHeader);
  if (fromCookie?.baseUrl) return fromCookie;

  const serverConfig = await getServerMediaLibraryConfig();
  return toOpenListConfig(serverConfig);
}

/**
 * 只取服务端全局配置（`/api/openlist` 用：请求体没带地址时才回退到这里）。
 */
export async function getServerOpenListConfig(): Promise<OpenListConfig | null> {
  return toOpenListConfig(await getServerMediaLibraryConfig());
}
