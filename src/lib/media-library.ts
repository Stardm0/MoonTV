/**
 * 私人影库的**连接配置模型**（纯函数层，客户端与服务端共用）。
 *
 * ## 为什么要有「服务端全局配置」
 *
 * 4.3.4/4.3.5 的影库配置只存在浏览器 cookie 里，带来两个现实问题：
 *   - 每个用户都要自己填一遍地址和令牌（同一个家庭影库，人人配一遍）；
 *   - 换浏览器 / 清 cookie / 换设备就丢，而影库明明是站点级资源。
 *
 * 所以给管理员一份**站点级配置**（存在 `AdminConfig.SiteConfig.MediaLibrary`），
 * 配好之后全站用户自动可用；个人 cookie 仍然保留，作为「我自己另有一个影库」
 * 的覆盖手段。
 *
 * ## 优先级
 *
 * **个人 cookie > 服务端全局**。
 * 理由：已经配过 cookie 的用户不能因为管理员新增了全局配置就被悄悄换掉影库
 * （那会让人以为「我的片子不见了」）。反过来，没配过的用户自动拿到全局配置。
 *
 * ## 令牌不落前端
 *
 * 服务端配置里的 `Token` **永远不下发给浏览器**。浏览器只拿到
 * `MediaLibrarySummary`（是否启用 / 什么类型 / 是否已配置），
 * 真正的请求一律走 `/api/openlist` 由服务端带上令牌。
 *
 * 本文件只含纯函数，不 import 任何服务端模块（`db` / `config`），
 * 因此客户端组件可以直接引用。服务端读取在 `media-library.server.ts`。
 */

import type { EmbyConfig } from './emby';
import type { OpenListConfig } from './openlist';
import { normalizeBaseUrl } from './openlist';

export type { EmbyConfig };

/** 支持的影库类型 */
export const MEDIA_LIBRARY_TYPES = ['openlist', 'emby'] as const;

export type MediaLibraryType = (typeof MEDIA_LIBRARY_TYPES)[number];

/** 影库类型展示名（管理台下拉、影库页标题复用） */
export const MEDIA_LIBRARY_TYPE_LABELS: Record<MediaLibraryType, string> = {
  openlist: 'OpenList / AList',
  emby: 'Emby / Jellyfin',
};

/** 管理员配置的站点级影库连接 */
export interface MediaLibraryConfig {
  /** 是否启用（关闭时全站都不再请求影库） */
  Enabled: boolean;
  /** 影库类型 */
  Type: MediaLibraryType;
  /** 影库站点地址 */
  BaseUrl: string;
  /** 访问令牌（OpenList Token / Emby API Key），**不下发浏览器** */
  Token: string;
  /** 浏览根路径（OpenList 用，Emby 用媒体库根） */
  RootPath: string;
  /** 自建部署访问局域网影库时显式开启 */
  AllowPrivateNetwork: boolean;
  /** Emby 用户 ID（Emby 的部分接口需要，留空则由服务端取第一个用户） */
  UserId?: string;
}

/** 浏览器可见的影库摘要（不含任何凭据） */
export interface MediaLibrarySummary {
  Enabled: boolean;
  Type: MediaLibraryType;
  /** 是否已填好可用地址（没填地址时管理员可能只开了开关） */
  Configured: boolean;
}

export function isMediaLibraryType(value: unknown): value is MediaLibraryType {
  return (
    typeof value === 'string' &&
    (MEDIA_LIBRARY_TYPES as readonly string[]).includes(value)
  );
}

/** 归一类型：未知值一律退回 `openlist`（4.3.6 起唯一可用的类型） */
export function normalizeMediaLibraryType(value: unknown): MediaLibraryType {
  return isMediaLibraryType(value) ? value : 'openlist';
}

/** 空配置（管理台没配过时的默认形态） */
export function createEmptyMediaLibraryConfig(): MediaLibraryConfig {
  return {
    Enabled: false,
    Type: 'openlist',
    BaseUrl: '',
    Token: '',
    RootPath: '/',
    AllowPrivateNetwork: false,
  };
}

/**
 * 校验并归一影库配置。
 *
 * 返回 `null` 表示「这份配置不可用」——目前唯一的不可用例是地址为空：
 * 没地址就没法连，等同于未配置，调用方按未配置处理即可。
 * 开关关闭**不算**不可用：管理员可能只是临时关掉，配置要留着。
 */
export function normalizeMediaLibraryConfig(
  raw: unknown
): MediaLibraryConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const baseUrl = normalizeBaseUrl(
    typeof input.BaseUrl === 'string' ? input.BaseUrl : ''
  );
  if (!baseUrl) return null;

  const rootPath =
    typeof input.RootPath === 'string' && input.RootPath.trim()
      ? input.RootPath.trim()
      : '/';

  return {
    Enabled: input.Enabled === true,
    Type: normalizeMediaLibraryType(input.Type),
    BaseUrl: baseUrl,
    Token: typeof input.Token === 'string' ? input.Token : '',
    RootPath: rootPath,
    AllowPrivateNetwork: input.AllowPrivateNetwork === true,
    UserId: typeof input.UserId === 'string' ? input.UserId : '',
  };
}

/** 这份配置是否真的能用（启用 + 有地址） */
export function isMediaLibraryUsable(
  config: MediaLibraryConfig | null | undefined
): boolean {
  return !!config && config.Enabled === true && !!config.BaseUrl;
}

/** 转成 OpenList 适配器要的配置；类型不是 openlist 时返回 null */
export function toOpenListConfig(
  config: MediaLibraryConfig | null | undefined
): OpenListConfig | null {
  if (!config || !config.BaseUrl) return null;
  if (config.Type !== 'openlist') return null;
  return {
    baseUrl: config.BaseUrl,
    token: config.Token,
    rootPath: config.RootPath || '/',
    allowPrivateNetwork: config.AllowPrivateNetwork === true,
  };
}

/**
 * 转成 Emby / Jellyfin 适配器要的配置；类型不是 emby 时返回 null。
 *
 * Emby 配置目前只来自管理台（站点级）：个人 cookie 只存 OpenList 结构，
 * 没有必要为个人场景再开一份含用户 ID 的 cookie。
 */
export function toEmbyConfig(
  config: MediaLibraryConfig | null | undefined
): EmbyConfig | null {
  if (!config || !config.BaseUrl) return null;
  if (config.Type !== 'emby') return null;
  return {
    baseUrl: config.BaseUrl,
    token: config.Token,
    userId: config.UserId || '',
    allowPrivateNetwork: config.AllowPrivateNetwork === true,
  };
}

/** 生成浏览器可见摘要（不含令牌与地址） */
export function summarizeMediaLibrary(
  config: MediaLibraryConfig | null | undefined
): MediaLibrarySummary {
  return {
    Enabled: isMediaLibraryUsable(config),
    Type: config?.Type ?? 'openlist',
    Configured: !!config?.BaseUrl,
  };
}
