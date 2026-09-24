/* eslint-disable @typescript-eslint/no-explicit-any */

import { danmakuTypeToMode, decimalColorToHex } from './danmaku-color';
import { DanmakuItem, DanmakuResponse } from './types';

/**
 * 弹幕格式类型
 */
export type DanmakuFormat = 'json' | 'xml';

/**
 * 获取弹幕 API 基础 URL
 * 从环境变量或配置中获取，默认为空（使用相对路径）
 */
function getDanmakuApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  const baseUrl =
    (window as any).RUNTIME_CONFIG?.DANMU_API_BASE_URL ||
    process.env.NEXT_PUBLIC_DANMU_API_BASE_URL ||
    '';

  return baseUrl;
}

/**
 * 获取弹幕格式配置
 * 固定为 xml 格式（允许通过查询参数临时覆盖）
 */
function getDanmakuFormat(format?: string): DanmakuFormat {
  // 查询参数优先级最高（允许临时覆盖）
  if (format === 'xml' || format === 'json') {
    return format;
  }

  // 默认固定为 xml
  return 'xml';
}

/**
 * 解析 JSON 格式的弹幕数据（实际 API 格式）
 *
 * `p` 字段与 XML 同为 8 段（与 danmu_api 文档一致）：
 *   时间, 类型, 字体大小, 颜色, 时间戳, 弹幕池, 用户Hash, 弹幕ID
 * 索引依次为 0..7。**颜色在索引 3，不是索引 2** —— 索引 2 是字号，
 * 取错会把字号（如 25）当成颜色解析。
 */
function parseJsonDanmaku(json: DanmakuResponse): DanmakuItem[] {
  const danmakuList: DanmakuItem[] = [];

  // 处理实际格式：{ count, comments: [{ cid, p, m, t }] }
  if (json.comments && Array.isArray(json.comments)) {
    for (const comment of json.comments) {
      if (!comment.m) continue; // 没有文本内容，跳过

      const pParts = comment.p ? comment.p.split(',') : [];

      // 优先使用 t 字段作为时间，如果没有则从 p 解析
      const time =
        comment.t !== undefined
          ? comment.t
          : pParts[0]
          ? parseFloat(pParts[0])
          : 0;
      const type = pParts[1] ? parseInt(pParts[1]) : 1; // 默认滚动弹幕
      // 索引 3 才是颜色；索引 2 是字体大小
      const color = pParts[3] ? parseInt(pParts[3]) : 16777215; // 默认白色
      const size = pParts[2] ? parseInt(pParts[2]) : 25;
      const pool = pParts.length > 5 ? parseInt(pParts[5]) : 0;

      danmakuList.push({
        time,
        type,
        color,
        text: comment.m,
        size,
        pool,
      });
    }
  }

  // 兼容旧格式：{ data: [...] } 或 { comments: DanmakuItem[] }
  if (json.data && Array.isArray(json.data)) {
    danmakuList.push(...json.data);
  }

  return danmakuList;
}

/**
 * 解析 XML 格式的弹幕数据
 */
function parseXmlDanmaku(xmlText: string): DanmakuItem[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  const danmakuList: DanmakuItem[] = [];

  const danmakuElements = xmlDoc.getElementsByTagName('d');

  for (let i = 0; i < danmakuElements.length; i++) {
    const element = danmakuElements[i];
    const p = element.getAttribute('p') || '';
    const text = element.textContent || '';

    if (!p || !text) continue;

    const parts = p.split(',');
    if (parts.length < 4) continue;

    // p: 时间, 类型, 字体大小, 颜色, 时间戳, 弹幕池, 用户Hash, 弹幕ID
    const time = parseFloat(parts[0]) || 0;
    const type = parseInt(parts[1]) || 1;
    const size = parseInt(parts[2]) || 25;
    const color = parseInt(parts[3]) || 16777215; // 默认白色
    const pool = parts.length > 5 ? parseInt(parts[5]) : 0;

    danmakuList.push({
      time,
      type,
      color,
      text,
      size,
      pool,
    });
  }

  return danmakuList;
}

/**
 * 通过评论 ID 获取弹幕
 * @param commentId 评论 ID
 * @param format 弹幕格式（json 或 xml）
 */
export async function getDanmakuByCommentId(
  commentId: string,
  format?: string
): Promise<DanmakuItem[]> {
  if (!commentId) {
    throw new Error('评论 ID 不能为空');
  }

  const baseUrl = getDanmakuApiBaseUrl();
  const danmakuFormat = getDanmakuFormat(format);
  const url = `${baseUrl}/api/v2/comment/${commentId}?format=${danmakuFormat}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    if (danmakuFormat === 'xml') {
      const xmlText = await response.text();
      return parseXmlDanmaku(xmlText);
    } else {
      const json: DanmakuResponse = await response.json();
      return parseJsonDanmaku(json);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('获取弹幕失败:', error);
    throw new Error(`获取弹幕失败: ${(error as Error).message}`);
  }
}

/**
 * 交给 artplayer-plugin-danmuku 的弹幕条目。
 *
 * 与 `DanmakuItem` 的区别（两者不可混用）：
 *   - `color` 是 `#rrggbb` 字符串，不是十进制数字
 *   - 用 `mode`（0 滚动 / 1 顶部 / 2 底部），不是 B 站的 `type`
 */
export interface PluginDanmakuItem {
  text: string;
  mode: number;
  time: number;
  color: string;
}

/**
 * 拉取指定弹幕地址并解析成插件可直接消费的格式。
 *
 * 之所以不让插件自行 fetch：插件内部的颜色解析缺少 hex 补零，
 * 任何 R 通道为 0 的深色系弹幕都会产出非法色值（详见
 * `src/lib/danmaku-color.ts` 的说明）。这里接管解析后统一补零。
 *
 * 调用方必须处理失败：解析不可靠时（网络异常、格式变化）应回退为
 * 直接把 URL 交给插件，宁可颜色有损也不能没有弹幕。
 */
export async function fetchPluginDanmaku(
  url: string,
  signal?: AbortSignal
): Promise<PluginDanmakuItem[]> {
  if (!url) throw new Error('弹幕地址不能为空');

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  const text = await response.text();

  // 服务端可能返回 XML（我们请求的就是 xml）也可能返回 JSON，
  // 用首字符粗判，避免为了判型多解析一次。
  const trimmed = text.trimStart();
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  const items: DanmakuItem[] = isJson
    ? parseJsonDanmaku(JSON.parse(trimmed) as DanmakuResponse)
    : parseXmlDanmaku(text);

  return items
    .filter((item) => item.text && item.text.trim().length > 0)
    .map((item) => ({
      text: item.text,
      mode: danmakuTypeToMode(item.type),
      time: Number.isFinite(item.time) ? item.time : 0,
      color: decimalColorToHex(item.color),
    }));
}

/**
 * 搜索动漫接口响应
 */
interface AnimeSearchResult {
  code?: number;
  message?: string;
  data?: Array<{
    id: string;
    name: string;
    name_cn?: string;
    [key: string]: any;
  }>;
  list?: Array<{
    id: string;
    name: string;
    name_cn?: string;
    [key: string]: any;
  }>;
}

/**
 * 剧集信息接口响应（实际 API 格式）
 */
export interface EpisodeSearchResult {
  errorCode: number;
  success: boolean;
  errorMessage: string;
  animes: Array<{
    animeId: number;
    animeTitle: string;
    type: string;
    typeDescription: string;
    episodes: Array<{
      episodeId: number;
      episodeTitle: string;
    }>;
  }>;
}

/**
 * 动漫选项（用于用户选择）
 */
export interface AnimeOption {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription: string;
  episodeCount: number;
  episodes: Array<{
    episodeId: number;
    episodeTitle: string;
  }>;
}

/**
 * 动漫详情接口响应
 */
interface BangumiDetailResult {
  code?: number;
  message?: string;
  data?: {
    id: string;
    name: string;
    name_cn?: string;
    episodes?: Array<{
      id: string;
      name: string;
      episode: number;
      comment_id?: string;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
}

/**
 * 根据关键字搜索动漫
 * @param keyword 搜索关键字（通常是视频标题）
 */
export async function searchAnime(
  keyword: string
): Promise<AnimeSearchResult['data']> {
  if (!keyword) {
    throw new Error('搜索关键字不能为空');
  }

  const baseUrl = getDanmakuApiBaseUrl();
  const url = `${baseUrl}/api/v2/search/anime?keyword=${encodeURIComponent(
    keyword
  )}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const json: AnimeSearchResult = await response.json();
    return json.data || json.list || [];
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('搜索动漫失败:', error);
    throw new Error(`搜索动漫失败: ${(error as Error).message}`);
  }
}

/**
 * 根据关键词搜索所有匹配的剧集信息
 * @param animeTitle 动漫标题（搜索关键字）
 */

export async function matchAnime(fileName: string, signal?: AbortSignal) {
  if (!fileName) {
    throw new Error("fileName 不能为空");
  }

  const baseUrl = getDanmakuApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/api/v2/match`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fileName }),
      signal
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status = ${response.status}`);
    }

    const json = await response.json();

    // 直接返回 matches
    return json.matches || [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("matchAnime 失败:", err);
    throw err;
  }
}

/**
 * 根据关键词搜索所有匹配的剧集信息
 * @param animeTitle 动漫标题（搜索关键字）
 */
export async function searchEpisodes(
  animeTitle: string
): Promise<AnimeOption[]> {
  if (!animeTitle) {
    throw new Error('搜索关键字不能为空');
  }

  const baseUrl = getDanmakuApiBaseUrl();
  const url = `${baseUrl}/api/v2/search/episodes?anime=${encodeURIComponent(
    animeTitle
  )}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const json: EpisodeSearchResult = await response.json();

    if (!json.success || json.errorCode !== 0) {
      throw new Error(json.errorMessage || '搜索失败');
    }

    // 转换为选项格式
    return (json.animes || []).map((anime) => ({
      animeId: anime.animeId,
      animeTitle: anime.animeTitle,
      type: anime.type,
      typeDescription: anime.typeDescription,
      episodeCount: anime.episodes?.length || 0,
      episodes: anime.episodes || [],
    }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('搜索剧集失败:', error);
    throw new Error(`搜索剧集失败: ${(error as Error).message}`);
  }
}

/**
 * 获取指定动漫的详细信息
 * @param animeId 动漫 ID
 */
export async function getBangumiDetail(
  animeId: string
): Promise<BangumiDetailResult['data'] | undefined> {
  if (!animeId) {
    throw new Error('动漫 ID 不能为空');
  }

  const baseUrl = getDanmakuApiBaseUrl();
  const url = `${baseUrl}/api/v2/bangumi/${animeId}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const json: BangumiDetailResult = await response.json();
    return json.data;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('获取动漫详情失败:', error);
    throw new Error(`获取动漫详情失败: ${(error as Error).message}`);
  }
}

/**
 * 根据视频信息获取弹幕
 * @param videoInfo 视频信息
 * @param format 弹幕格式（json 或 xml）
 */
export interface VideoInfo {
  title: string;
  year?: string;
  episode?: number; // 集数（从1开始）
  type?: 'tv' | 'movie'; // 类型：电视剧或电影
}

/**
 * 从标题中提取季数（Season）
 * @param title 动漫标题
 * @returns 季数（从 1 开始），如果无法提取则返回 1
 */
export function extractSeasonFromTitle(title: string): number {
  if (!title) return 1;

  title = title.toLowerCase();

  // 正则1：S01、S1、Season 1、Season01
  const match = title.match(/(?:season|s)\s*?(\d{1,2})/i);
  if (match && match[1]) {
    return Number(match[1]);
  }

  // 正则2：中文“第1季、第2季”
  const cnMatch = title.match(/第\s*(\d+)\s*季/);
  if (cnMatch && cnMatch[1]) {
    return Number(cnMatch[1]);
  }

  // 默认季别
  return 1;
}

/**
 * 从集数标题中提取集数
 * @param episodeTitle 集数标题
 * @returns 集数（从1开始），如果无法提取则返回 null
 */
export function extractEpisodeNumber(episodeTitle: string): number | null {
  if (!episodeTitle) return null;

  // 1. "第X集" 或 "第X话"
  let match = episodeTitle.match(/第(\d+)[集话]/);
  if (match) {
    return parseInt(match[1]);
  }

  // 2. 匹配所有数字，优先选择较大的数字（通常是集数）
  // 支持格式如: "[youku] 166", "166", "EP166", "第166话" 等
  const allNumbers = episodeTitle.match(/\d+/g);
  if (allNumbers && allNumbers.length > 0) {
    // 如果有多个数字，选择最大的（通常是集数）
    const numbers = allNumbers
      .map((n) => parseInt(n))
      .filter((n) => n >= 1 && n <= 10000);
    if (numbers.length > 0) {
      // 优先选择较大的数字（通常是集数），但也要考虑合理性
      const maxNum = Math.max(...numbers);
      // 如果最大数字在合理范围内，使用它
      if (maxNum >= 1 && maxNum <= 10000) {
        return maxNum;
      }
    }
  }

  // 3. 旧的正则匹配（作为备选）
  match = episodeTitle.match(/(?:^|[^0-9])(\d+)(?:[集话]|$)/);
  if (match) {
    const num = parseInt(match[1]);
    // 如果数字在合理范围内（1-10000），认为是集数
    if (num >= 1 && num <= 10000) {
      return num;
    }
  }

  return null;
}

/**
 * 根据选中的动漫和集数获取弹幕 URL 地址
 * @param selectedAnime 选中的动漫选项
 * @param episodeNumber 集数（从1开始，基于弹幕选择器中选择的集数）
 * @param format 弹幕格式（json 或 xml）
 */
export async function getDanmakuBySelectedAnime(
  selectedAnime: AnimeOption,
  episodeNumber: number,
  format?: string
): Promise<string> {
  if (!selectedAnime) {
    throw new Error('未选择动漫');
  }

  const danmakuFormat = getDanmakuFormat(format);

  // 直接使用集数索引（episodeNumber 是从弹幕选择器中选择的，已经是正确的索引）
  if (episodeNumber < 1 || episodeNumber > selectedAnime.episodes.length) {
    throw new Error(
      `集数 ${episodeNumber} 超出范围（共 ${selectedAnime.episodes.length} 集）`
    );
  }

  const targetEpisode = selectedAnime.episodes[episodeNumber - 1];

  if (!targetEpisode) {
    throw new Error(`未找到第 ${episodeNumber} 集的弹幕`);
  }

  const baseUrl = getDanmakuApiBaseUrl();
  const url = `${baseUrl}/api/v2/comment/${targetEpisode.episodeId.toString()}?format=${danmakuFormat}`;
  return url;
}
