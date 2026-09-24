/**
 * 站点级私人影库配置的**服务端读取**。
 *
 * 与 `media-library.ts` 分开的原因：这里 `import { getConfig }`，
 * 而 `getConfig` 会拉起存储层（`db`），**只能被服务端路由引用**；
 * 客户端组件引用它会被打进浏览器包并在运行时炸掉。
 * 纯函数部分留在 `media-library.ts`，两边共用。
 */

import { getConfig } from './config';
import type { EmbyConfig } from './emby';
import {
  type MediaLibraryConfig,
  isMediaLibraryUsable,
  normalizeMediaLibraryConfig,
  toEmbyConfig,
  toOpenListConfig,
} from './media-library';
import type { OpenListConfig } from './openlist';
import { parseOpenListConfigFromCookieHeader } from './openlist';

/** 站点级影库的「可用配置 + 覆盖策略」 */
export interface MediaLibraryPolicy {
  /** 站点级可用配置（没配过或已停用时为 `null`） */
  server: MediaLibraryConfig | null;
  /** 是否允许浏览器里的个人配置覆盖站点级配置 */
  allowPersonalOverride: boolean;
}

/**
 * 一次读完站点级影库配置与覆盖策略（只读一次配置，避免重复拉存储）。
 *
 * `server` 与 `getServerMediaLibraryConfig()` 同义（停用 = 没有）；
 * `allowPersonalOverride` 取自**未过滤**的归一结果——管理员可以在停用
 * 站点级影库的同时禁止个人覆盖，这时策略仍然要生效。
 */
export async function resolveMediaLibraryPolicy(): Promise<MediaLibraryPolicy> {
  try {
    const config = await getConfig();
    const normalized = normalizeMediaLibraryConfig(
      config?.SiteConfig?.MediaLibrary
    );
    return {
      server:
        normalized && isMediaLibraryUsable(normalized) ? normalized : null,
      allowPersonalOverride: normalized?.AllowPersonalOverride !== false,
    };
  } catch {
    // 配置读不出来时按「未配置 + 允许覆盖」处理：影库是可选功能，不该让整站报错
    return { server: null, allowPersonalOverride: true };
  }
}

/**
 * 读取管理员配置的站点级影库；没配过或已停用返回 `null`。
 *
 * 注意：即使管理员把开关关了，只要地址还在，`getConfig()` 也会读出配置对象，
 * 所以调用方要用 `Enabled` 判断——这里直接把「停用」当成「没有」。
 */
export async function getServerMediaLibraryConfig(): Promise<MediaLibraryConfig | null> {
  return (await resolveMediaLibraryPolicy()).server;
}

/**
 * 解析本次请求该用哪份影库连接配置。
 *
 * **个人 cookie 优先，服务端全局兜底**——已经配过 cookie 的用户不该被
 * 管理员新加的全局配置悄悄换掉影库。
 *
 * 4.3.12 起管理员可以用 `AllowPersonalOverride: false` 关掉这条优先级：
 * 关掉后忽略 cookie，全站强制站点级影库（详见 `media-library.ts`）。
 */
export async function resolveOpenListConfig(
  cookieHeader: string | null | undefined
): Promise<OpenListConfig | null> {
  const { server, allowPersonalOverride } = await resolveMediaLibraryPolicy();

  if (allowPersonalOverride) {
    const fromCookie = parseOpenListConfigFromCookieHeader(cookieHeader);
    if (fromCookie?.baseUrl) return fromCookie;
  }

  return toOpenListConfig(server);
}

/**
 * 只取服务端全局配置（`/api/openlist` 用：请求体没带地址时才回退到这里）。
 */
export async function getServerOpenListConfig(): Promise<OpenListConfig | null> {
  return toOpenListConfig(await getServerMediaLibraryConfig());
}

/**
 * 解析本次请求该用哪份 Emby 连接配置。
 *
 * Emby 目前只有站点级配置（个人 cookie 只存 OpenList 结构），
 * 将来若开放个人 Emby 配置，再在这里按「个人优先」补一层。
 */
export async function getServerEmbyConfig(): Promise<EmbyConfig | null> {
  return toEmbyConfig(await getServerMediaLibraryConfig());
}
