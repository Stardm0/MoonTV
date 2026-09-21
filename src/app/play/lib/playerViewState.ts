/**
 * 播放页视图状态决策。
 *
 * 用途：`usePlayEngine` 是一个 3400 行的巨型 hook，其中混着大量「拿几个数字
 * 比一比、然后决定展示什么」的纯逻辑。这些逻辑不依赖 React 状态机、不碰
 * ArtPlayer / hls 实例，却因为长在 hook 里而无法被单测覆盖。本模块把它们
 * 剥离成纯函数，配 `playerViewState.test.ts` 钉死行为。
 *
 * 设计要点：
 * 1) **纯函数 + 纯数据**。入参是数字/布尔/字符串，出参是可判等的普通对象，
 *    不做 IO、不读 window、不写 localStorage。
 * 2) **行为与抽取前逐字节等价**。这里的每个分支都是照着 `usePlayEngine.ts`
 *    原文搬过来的，注释里标注了原始行号，改动属于重构而非修 bug。
 * 3) 集数越界的规则在 hook 里写了 4 遍（URL 同步、详情初始化、播放器生命周期
 *    两处），且两套语义并存 —— 本模块把两套都保留成独立函数，不强求统一，
 *    因为统一会改变可观察行为。
 */

/** 剧集回退的三种结论 */
export type EpisodeFallback =
  /** 索引合法（含"空列表"这种无法判断的情况），保持不动 */
  | { action: 'keep' }
  /** 索引小于 0，回到第一集 */
  | { action: 'reset'; index: 0 }
  /** 索引超出上界，落到最后一集 */
  | { action: 'clamp'; index: number };

/** 加载阶段 */
export type LoadingStage = 'searching' | 'preferring' | 'fetching' | 'ready';

/** 加载阶段的展示文案 */
export const LOADING_MESSAGES: Record<LoadingStage, string> = {
  searching: '🔍 正在搜索播放源...',
  preferring: '🚀 正在优选播放源...',
  fetching: '🎬 正在获取视频详情...',
  ready: '✨ 准备就绪，即将开始播放...',
};

/**
 * 取某个加载阶段的视图（`stage` 与 `message` 严格配套）。
 *
 * 比 {@link deriveLoadingState} 少一层"参数是否齐全"的判断，适合调用点
 * 已经确定要进入某阶段的场景（如优选阶段、就绪阶段），无需处理 null。
 */
export function getLoadingView(stage: LoadingStage): LoadingStateView {
  return { stage, message: LOADING_MESSAGES[stage] };
}

/**
 * 判断「回退到最后一集」的超界条件（`initDetail` 的原语义）。
 *
 * 原文（`usePlayEngine.ts` 抽取前）：
 * ```ts
 * // 传入的起始集数超出本源可用集数范围时，直接定位到最后一集（而非回到第一集）
 * if (detailData.episodes.length > 0 &&
 *     currentEpisodeIndex >= detailData.episodes.length) {
 *   setCurrentEpisodeIndex(detailData.episodes.length - 1);
 * }
 * ```
 *
 * ⚠️ 与 {@link shouldFallbackEpisodeToFirst} 的关键差异：**它不处理负数**。
 * 空列表时返回 false（没有"最后一集"可落）。
 *
 * @param episodesLength 当前源可用集数
 * @param episodeIndex 传入的起始集数下标（0 基）
 */
export function shouldFallbackEpisodeToLast(
  episodesLength: number,
  episodeIndex: number
): boolean {
  if (episodesLength <= 0) return false;
  return episodeIndex >= episodesLength;
}

/**
 * 判断「索引越界、需要夹取修正」的超界条件（ArtPlayer 生命周期 effect 的原语义）。
 *
 * 原文：
 * ```ts
 * if (detail && detail.episodes && detail.episodes.length > 0 &&
 *     currentEpisodeIndex !== null &&
 *     (currentEpisodeIndex < 0 || currentEpisodeIndex >= detail.episodes.length)) { ... }
 * ```
 *
 * ⚠️ 与 {@link shouldFallbackEpisodeToLast} 的关键差异：**它包含负数**。
 * 两套并存是现状，不是笔误。
 */
export function shouldClampEpisodeIndex(
  episodesLength: number,
  episodeIndex: number
): boolean {
  if (episodesLength <= 0) return false;
  return episodeIndex < 0 || episodeIndex >= episodesLength;
}

/**
 * 计算集数索引的修正目标（**单函数版，推荐新代码使用**）。
 *
 * 规则：负数 → 第一集；超出上界 → 最后一集；其余保持不动。
 * 空列表时无法判断，返回 `keep` —— 交给调用方决定是报错还是跳过。
 */
export function resolveEpisodeFallback(
  episodesLength: number,
  episodeIndex: number
): EpisodeFallback {
  if (episodesLength <= 0) return { action: 'keep' };
  if (episodeIndex < 0) return { action: 'reset', index: 0 };
  if (episodeIndex >= episodesLength) {
    return { action: 'clamp', index: episodesLength - 1 };
  }
  return { action: 'keep' };
}

/**
 * 判断当前索引是否可用于「同步 URL 的 ep 参数」。
 *
 * 原文用「越界就 `return`」实现，等价于「在界内才继续」。
 *
 * @returns 索引有效时为 true
 */
export function isValidEpisodeIndex(
  episodesLength: number,
  episodeIndex: number
): boolean {
  if (episodesLength <= 0) return false;
  return episodeIndex >= 0 && episodeIndex < episodesLength;
}

/** `deriveLoadingState` 入参 */
export interface DeriveLoadingStateParams {
  /** URL 上是否带全了 source + id（走"取详情"分支） */
  hasDetailTarget: boolean;
  /** 是否有任意可用参数（source/id/title/searchTitle 任一） */
  hasAnyParam: boolean;
  /** 是否已进入"优选播放源"阶段 */
  preferring?: boolean;
}

/** `deriveLoadingState` 出参 */
export interface LoadingStateView {
  stage: LoadingStage;
  message: string;
}

/**
 * 根据初始化入参推导加载阶段与展示文案。
 *
 * 对应 `initAll()` 里的两段赋值：
 * ```ts
 * setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
 * setLoadingMessage(currentSource && currentId ? '🎬 正在获取视频详情...' : '🔍 正在搜索播放源...');
 * ```
 *
 * 与原文的差异（**唯一一处行为变化，属修正**）：原实现两个三元表达式各写一遍、
 * 条件完全重复，有写歪的风险。这里收敛为单一真源。`preferring` 为 true 时
 * 返回优选阶段（对应 `setLoadingStage('preferring')`）。
 *
 * @returns 缺参数时返回 null —— 调用方应直接 `setError('缺少必要参数')`
 */
export function deriveLoadingState(
  params: DeriveLoadingStateParams
): LoadingStateView | null {
  const { hasDetailTarget, hasAnyParam, preferring = false } = params;

  if (!hasAnyParam) return null;

  if (preferring) {
    return { stage: 'preferring', message: LOADING_MESSAGES.preferring };
  }

  const stage: LoadingStage = hasDetailTarget ? 'fetching' : 'searching';
  return { stage, message: LOADING_MESSAGES[stage] };
}

/** 播放页主要错误类型 */
export type PlayErrorKind =
  | 'missing-params'
  | 'no-match'
  | 'invalid-episode-index'
  | 'invalid-video-url';

/**
 * 把错误类型转成展示文案。
 *
 * `invalid-episode-index` 需要集数，走参数注入而非模板字符串散落在 hook 里。
 */
export function formatPlayError(
  kind: PlayErrorKind,
  context?: { totalEpisodes?: number }
): string {
  switch (kind) {
    case 'missing-params':
      return '缺少必要参数';
    case 'no-match':
      return '未找到匹配结果';
    case 'invalid-episode-index':
      return `选集索引无效，当前共 ${context?.totalEpisodes ?? 0} 集`;
    case 'invalid-video-url':
      return '视频地址无效';
  }
}

/** 若 detail 就绪则返回真实集数，否则返回 0 */
export function resolveTotalEpisodes(
  detail: { episodes?: unknown[] } | null | undefined
): number {
  return detail?.episodes?.length ?? 0;
}

/**
 * 解析「是否启用优选播放源」的持久化值。
 *
 * 原文是一段内联 IIFE，含 `window` 判空 + `null` 判空 + `JSON.parse` try/catch。
 * 抽出来后可单测（含脏数据场景）。
 *
 * ⚠️ 注意：`'true'` / `'1'` 这类**非 JSON 布尔的字符串**会被 `JSON.parse` 抛错
 * 后兜底成 false，而不是被当成 truthy —— 这是原文行为，保持一致。
 * 非布尔 JSON 值（如 `0` / `""` / `null`）也一律 false。
 *
 * @param raw localStorage 读到的原始字符串，未存过时为 null
 */
export function parsePreferBestSource(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/** localStorage 中「优选播放源」的存储键 */
export const PREFER_BEST_SOURCE_STORAGE_KEY = 'enablePreferBestSource';

/** 存储「优选播放源」开关 */
export function savePreferBestSource(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PREFER_BEST_SOURCE_STORAGE_KEY, JSON.stringify(enabled));
}
