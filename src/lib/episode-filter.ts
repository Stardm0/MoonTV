/**
 * 剧集标题过滤。
 *
 * 用途：源站的剧集列表经常混入大量用户不想看的内容 —— 预告、花絮、彩蛋、
 * 番外、广告。把它们从前端列表里隐藏掉，而不是让用户自己一路划过去。
 *
 * 设计要点：
 * 1) 纯函数 + 纯数据。规则可存 localStorage，判定可单测。
 * 2) `reverseMode`（相反模式）把语义翻转：从"隐藏命中的"变成"只显示命中的"。
 *    适合长剧收敛 —— 比如只想看标题带「主线」的那几集。
 * 3) **空规则时一律不隐藏**，即使开了相反模式。
 *
 * 关于第 3 点的取舍：参考实现里 `reverseMode` 会在无规则时返回 `true`（隐藏全部），
 * 结果是用户一打开相反模式、还没添规则，整部剧就变成 0 集 —— 看起来像坏了。
 * 这里刻意改成"无规则则不过滤"：过滤是个「排除性」功能，没有排除条件时
 * 它不应该改变任何东西。
 */

/** 单条过滤规则 */
export interface EpisodeFilterRule {
  id: string;
  keyword: string;
  type: 'normal' | 'regex';
  enabled: boolean;
}

/** 过滤配置 */
export interface EpisodeFilterConfig {
  rules: EpisodeFilterRule[];
  /**
   * 相反模式。
   *
   * false（默认）：隐藏标题命中规则的集数
   * true：只显示标题命中规则的集数
   */
  reverseMode: boolean;
}

/** 本地存储键 */
export const EPISODE_FILTER_STORAGE_KEY = 'moontv_episode_filter';

/** 规则数量上限 */
export const MAX_EPISODE_FILTER_RULES = 50;

/** 单条关键字长度上限 */
export const MAX_EPISODE_KEYWORD_LENGTH = 60;

/** 空白配置（每次返回新对象） */
export function createEmptyEpisodeFilterConfig(): EpisodeFilterConfig {
  return { rules: [], reverseMode: false };
}

/** 生成规则 id */
function createRuleId(): string {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 判断正则是否可用（语法错误不抛异常，只让该条规则失效） */
export function isValidEpisodeRegex(pattern: string): boolean {
  if (!pattern) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** 清洗规则列表 */
export function normalizeEpisodeFilterRules(input: unknown): EpisodeFilterRule[] {
  if (!Array.isArray(input)) return [];

  const result: EpisodeFilterRule[] = [];
  const seenIds = new Set<string>();

  for (const raw of input) {
    if (result.length >= MAX_EPISODE_FILTER_RULES) break;
    if (!raw || typeof raw !== 'object') continue;

    const item = raw as Record<string, unknown>;
    const keyword =
      typeof item.keyword === 'string'
        ? item.keyword.trim().slice(0, MAX_EPISODE_KEYWORD_LENGTH)
        : '';
    // 空关键字普通模式下会命中所有集数，等于全隐藏（或反向全显示），
    // 几乎必然是误操作，直接丢掉。
    if (!keyword) continue;

    const type: EpisodeFilterRule['type'] =
      item.type === 'regex' ? 'regex' : 'normal';

    if (type === 'regex' && !isValidEpisodeRegex(keyword)) continue;

    let id = typeof item.id === 'string' && item.id ? item.id : createRuleId();
    if (seenIds.has(id)) id = createRuleId();
    seenIds.add(id);

    result.push({ id, keyword, type, enabled: item.enabled !== false });
  }

  return result;
}

/** 清洗整个配置 */
export function normalizeEpisodeFilterConfig(
  input: unknown
): EpisodeFilterConfig {
  if (!input || typeof input !== 'object') return createEmptyEpisodeFilterConfig();
  const raw = input as Record<string, unknown>;
  return {
    rules: normalizeEpisodeFilterRules(raw.rules),
    reverseMode: raw.reverseMode === true,
  };
}

/** 标题是否命中任一启用规则 */
export function doesEpisodeTitleMatchFilterRules(
  title: string,
  config?: EpisodeFilterConfig | null
): boolean {
  const rules = config?.rules;
  if (!title || !rules?.length) return false;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.type === 'regex') {
      try {
        if (new RegExp(rule.keyword).test(title)) return true;
      } catch {
        continue;
      }
    } else if (title.includes(rule.keyword)) {
      return true;
    }
  }

  return false;
}

/**
 * 该集是否应被隐藏。
 *
 * 无启用规则时**始终返回 false**（不过滤），无论相反模式是否开启 ——
 * 详见文件头注释里对参考实现取舍的说明。
 */
export function isEpisodeHiddenByFilter(
  title: string,
  config?: EpisodeFilterConfig | null
): boolean {
  const normalized = normalizeEpisodeFilterConfig(config);
  const hasActiveRule = normalized.rules.some((rule) => rule.enabled);
  if (!hasActiveRule) return false;

  const matched = doesEpisodeTitleMatchFilterRules(title, normalized);
  return normalized.reverseMode ? !matched : matched;
}

/**
 * 过滤整个剧集列表，返回保留下来的**下标**。
 *
 * 返回下标而不是过滤后的新数组，是为了让调用方保留原有的集数编号 ——
 * 隐藏「第 3 集」之后，第 4 集的编号必须还是 4，不能变成 3。
 * 播放记录、预取、续播都依赖稳定的集数下标。
 */
export function filterEpisodeIndexes(
  titles: string[],
  config?: EpisodeFilterConfig | null
): number[] {
  if (!Array.isArray(titles)) return [];

  const normalized = normalizeEpisodeFilterConfig(config);
  const hasActiveRule = normalized.rules.some((rule) => rule.enabled);
  // 无启用规则时直接返回全量下标，省掉逐条判定的开销
  if (!hasActiveRule) return titles.map((_, index) => index);

  const result: number[] = [];
  for (let index = 0; index < titles.length; index += 1) {
    if (!isEpisodeHiddenByFilter(titles[index], normalized)) {
      result.push(index);
    }
  }
  return result;
}

/**
 * 分页：按 `episodesPerPage` 把集号切成页，返回每页的**真实集号区间**。
 *
 * 为什么不用 `1-50 / 51-100` 这种算式：过滤掉中间的集数后，
 * 第 2 页里装的可能只有 3 集，算式标签会和网格里实际显示的集号对不上。
 * 这里改成返回每页首尾的**真实集号**，标签直接拿来用。
 *
 * @param visibleNumbers 保留下来的集号（1 起算，升序）
 */
export function buildEpisodePageRanges(
  visibleNumbers: number[],
  episodesPerPage: number
): Array<{ start: number; end: number }> {
  if (!Array.isArray(visibleNumbers) || visibleNumbers.length === 0) return [];
  const size = Math.max(1, Math.floor(episodesPerPage) || 1);

  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < visibleNumbers.length; i += size) {
    const slice = visibleNumbers.slice(i, i + size);
    ranges.push({ start: slice[0], end: slice[slice.length - 1] });
  }
  return ranges;
}

/** 分页：截取第 `pageIndex` 页（0 起算）的集号。越界返回空数组 */
export function sliceEpisodePage(
  visibleNumbers: number[],
  pageIndex: number,
  episodesPerPage: number
): number[] {
  if (!Array.isArray(visibleNumbers)) return [];
  const size = Math.max(1, Math.floor(episodesPerPage) || 1);
  const start = Math.max(0, pageIndex) * size;
  return visibleNumbers.slice(start, start + size);
}

/**
 * 过滤后的总页数。**最少为 1**，避免调用方在空列表上算出 0 页、
 * 把分页标签整块渲染成空白。
 */
export function countEpisodePages(
  visibleCount: number,
  episodesPerPage: number
): number {
  const size = Math.max(1, Math.floor(episodesPerPage) || 1);
  return Math.max(1, Math.ceil(Math.max(0, visibleCount) / size));
}

// -----------------------------------------------------------------------------
// 持久化
// -----------------------------------------------------------------------------

/** 读取配置（含脏数据清洗） */
export function loadEpisodeFilterConfig(): EpisodeFilterConfig {
  if (typeof window === 'undefined') return createEmptyEpisodeFilterConfig();

  try {
    const raw = window.localStorage.getItem(EPISODE_FILTER_STORAGE_KEY);
    if (!raw) return createEmptyEpisodeFilterConfig();
    return normalizeEpisodeFilterConfig(JSON.parse(raw));
  } catch {
    return createEmptyEpisodeFilterConfig();
  }
}

/** 保存配置。无规则且非相反模式时移除存储项 */
export function saveEpisodeFilterConfig(config: EpisodeFilterConfig): void {
  if (typeof window === 'undefined') return;

  try {
    const normalized = normalizeEpisodeFilterConfig(config);
    if (!normalized.rules.length && !normalized.reverseMode) {
      window.localStorage.removeItem(EPISODE_FILTER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      EPISODE_FILTER_STORAGE_KEY,
      JSON.stringify(normalized)
    );
  } catch {
    // 存储不可用不应影响播放
  }
}

/** 清除配置 */
export function clearEpisodeFilterConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(EPISODE_FILTER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 新建一条规则，非法输入返回 null */
export function createEpisodeFilterRule(
  keyword: string,
  type: EpisodeFilterRule['type'] = 'normal'
): EpisodeFilterRule | null {
  const trimmed = keyword.trim().slice(0, MAX_EPISODE_KEYWORD_LENGTH);
  if (!trimmed) return null;
  if (type === 'regex' && !isValidEpisodeRegex(trimmed)) return null;

  return { id: createRuleId(), keyword: trimmed, type, enabled: true };
}
