/**
 * 前向片段预取器。
 *
 * 设计要点（这是"视频暂停也继续缓存"的全部秘密）：
 *   预取循环体内**不读取任何播放状态**——不判断 `paused`、不判断
 *   `document.hidden`、不听播放器事件。循环体只有 `await fetch` 与
 *   `cache.put`，因此视频暂停、页面切到后台标签页时，队列仍会继续推进。
 *
 *   `setThrottled()` 是"临时让出带宽"（播放卡顿时调用），与"暂停视频就停缓存"
 *   是两件事，不要混用。
 */

import { parseM3U8 } from './m3u8-downloader';
import {
  type CacheSettings,
  buildSegmentCacheKey,
  enforceQuota,
  ensurePersistentStorage,
  hasCachedSegment,
  loadCacheSettings,
  metaStore,
  putCachedSegment,
  touchMeta,
} from './video-cache';

export type PrefetchState =
  | 'idle'
  | 'parsing'
  | 'running'
  | 'done'
  | 'error'
  | 'disabled';

export interface PrefetchStats {
  state: PrefetchState;
  /** 已就绪的片段数 */
  cached: number;
  /** 本轮计划片段数 */
  total: number;
  /** 本轮写入字节数 */
  bytes: number;
  /** 缓存已覆盖到的播放时间（秒），可直接 formatTime 展示 */
  coverTo: number;
  message?: string;
}

export interface PrefetchOptions {
  m3u8Url: string;
  /** 当前播放位置（秒） */
  currentTime: number;
  /** 剧集标识，用于分集统计与淘汰 */
  episodeKey: string;
  /** 覆盖 settings.horizonSeconds */
  horizonSeconds?: number;
  /** 回看保护时长（秒），默认 30 */
  lookBehindSeconds?: number;
  /** 并发数，默认 2 */
  concurrency?: number;
  /** 覆盖 settings.useProxy */
  useProxy?: boolean;
  onProgress?: (stats: PrefetchStats) => void;
}

const IDLE_STATS: PrefetchStats = {
  state: 'idle',
  cached: 0,
  total: 0,
  bytes: 0,
  coverTo: 0,
};

/** 时长信息缺失时，最多预取多少个片段 */
const FALLBACK_MAX_SEGMENTS = 200;

/** 进度回调最小间隔，避免高频写 React state */
const EMIT_INTERVAL_MS = 250;

/** 淘汰检查间隔 */
const EVICT_INTERVAL_MS = 15_000;

/**
 * 网络环境守卫：省流量模式 / 弱网 / 离线时不做任何预取。
 * 这些条件下预取只会白白消耗用户流量。
 */
export function shouldPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof caches === 'undefined') return false;

  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  if (nav.onLine === false) return false;

  const connection = nav.connection;
  if (connection?.saveData) return false;
  if (
    typeof connection?.effectiveType === 'string' &&
    /(^|-)(2g|slow-2g)$/.test(connection.effectiveType)
  ) {
    return false;
  }

  return true;
}

function toCumulative(durations: number[]): number[] {
  const out = new Array<number>(durations.length);
  let acc = 0;
  for (let i = 0; i < durations.length; i += 1) {
    acc += durations[i] || 0;
    out[i] = acc;
  }
  return out;
}

function indexAtTime(cumulative: number[], time: number): number {
  for (let i = 0; i < cumulative.length; i += 1) {
    if (cumulative[i] > time) return i;
  }
  return Math.max(0, cumulative.length - 1);
}

export class VideoPrefetcher {
  private controller: AbortController | null = null;
  private episodeKey: string | null = null;
  /** 当前已排入队列的覆盖区间 [windowFrom, windowTo]（秒） */
  private windowFrom = 0;
  private windowTo = 0;
  /** 队列已覆盖到播放列表末尾：此时无论请求多大视野都无事可做 */
  private reachedEnd = false;
  private throttled = false;
  private resumeWaiters: Array<() => void> = [];
  private stats: PrefetchStats = { ...IDLE_STATS };
  private lastEmitAt = 0;

  /**
   * 幂等入口。同一集且窗口仍然够用时直接返回，因此可以放心地在
   * seek / timeupdate / pause 里高频调用。
   */
  ensure(options: PrefetchOptions): void {
    if (!options.m3u8Url) return;

    const settings = loadCacheSettings();
    if (!settings.enabled) {
      this.emit(options, { state: 'disabled', message: '已关闭视频缓存' }, true);
      return;
    }
    if (!shouldPrefetch()) {
      this.emit(
        options,
        { state: 'disabled', message: '当前网络环境已跳过缓存' },
        true
      );
      return;
    }

    const sameEpisode = this.episodeKey === options.episodeKey;

    // 队列已经覆盖到播放列表末尾，且当前播放位置落在已覆盖区间内：
    // 再叫也不会多出可缓存的片段。
    // 必须先短路，否则下面"窗口够不够大"的判断在短播放列表上永不成立，
    // 会导致每次 ensure 都重启一轮队列。
    // 注意要带上"位置在覆盖区间内"这一条：末尾覆盖 + 向后拖进度条 仍然需要重建队列。
    if (
      sameEpisode &&
      this.reachedEnd &&
      options.currentTime >= this.windowFrom - 60 &&
      options.currentTime <= this.windowTo
    ) {
      this.emit(options, this.stats);
      return;
    }

    const requestedTo =
      options.currentTime +
      (options.horizonSeconds ?? settings.horizonSeconds);

    // 窗口仍然够用的条件：
    // 1) 前向还有 60s 以上余量（避免刚排完就重启）
    // 2) 已覆盖区间已经够到本轮要求的视野（暂停时会要求更大的视野）
    // 3) 当前播放位置没有退到已覆盖区间之前（否则会出现缓存盲区）
    const windowStillUseful =
      sameEpisode &&
      this.controller !== null &&
      !this.controller.signal.aborted &&
      options.currentTime + 60 < this.windowTo &&
      this.windowTo + 60 >= requestedTo &&
      options.currentTime >= this.windowFrom;

    if (windowStillUseful) {
      this.emit(options, this.stats);
      return;
    }

    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    this.episodeKey = options.episodeKey;

    // 先写入近似窗口边界，让窗口判断在 run() 完成解析前就生效。
    // 否则解析期间（await parseM3U8）连续的 ensure 调用会反复重启队列。
    // run() 拿到真实片段时长后会覆盖为精确值。
    this.windowFrom = Math.max(
      0,
      options.currentTime - (options.lookBehindSeconds ?? 30)
    );
    this.windowTo = requestedTo;

    void this.run(options, settings, controller.signal);
  }

  /** 完整停止并重置（切集、换源、卸载时调用） */
  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.episodeKey = null;
    this.windowFrom = 0;
    this.windowTo = 0;
    this.reachedEnd = false;
    this.throttled = false;

    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((resolve) => resolve());

    this.stats = { ...IDLE_STATS };
  }

  /**
   * 播放出现 stall 时让出带宽，恢复后解除。
   * 这不是"暂停视频就停缓存"。
   */
  setThrottled(value: boolean): void {
    this.throttled = value;
    if (!value) {
      const waiters = this.resumeWaiters;
      this.resumeWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  getStats(): PrefetchStats {
    return this.stats;
  }

  private waitWhileThrottled(signal: AbortSignal): Promise<void> {
    if (!this.throttled || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  private emit(
    options: PrefetchOptions,
    patch: Partial<PrefetchStats>,
    force = false
  ): void {
    this.stats = { ...this.stats, ...patch };
    const now = Date.now();
    if (!force && now - this.lastEmitAt < EMIT_INTERVAL_MS) return;
    this.lastEmitAt = now;
    options.onProgress?.(this.stats);
  }

  private async run(
    options: PrefetchOptions,
    settings: CacheSettings,
    signal: AbortSignal
  ): Promise<void> {
    const useProxy = options.useProxy ?? settings.useProxy;
    const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
    const lookBehind = Math.max(0, options.lookBehindSeconds ?? 30);

    this.emit(
      options,
      { state: 'parsing', cached: 0, total: 0, bytes: 0, coverTo: 0 },
      true
    );

    let task: Awaited<ReturnType<typeof parseM3U8>>;
    try {
      task = await parseM3U8(options.m3u8Url);
    } catch {
      this.emit(options, { state: 'error', message: '播放列表解析失败' }, true);
      return;
    }
    if (signal.aborted) return;

    if (task.tsUrlList.length === 0) {
      this.emit(options, { state: 'error', message: '播放列表为空' }, true);
      return;
    }

    // EXT-X-BYTERANGE 场景下多个片段共用同一 URL，URL 不能作为缓存键。
    // 支持它需要把 (url, rangeStart, rangeEnd) 一起编码进 key，此处直接降级。
    if (new Set(task.tsUrlList).size !== task.tsUrlList.length) {
      this.emit(
        options,
        { state: 'error', message: '该播放列表使用字节范围分片，暂不支持预缓存' },
        true
      );
      return;
    }

    const cumulative = toCumulative(task.segmentDurations);
    const durationsUsable = task.durationSecond > 0 && cumulative[cumulative.length - 1] > 0;

    let queue: number[];

    if (durationsUsable) {
      const startIndex = indexAtTime(cumulative, options.currentTime);
      const fromIndex = indexAtTime(
        cumulative,
        Math.max(0, options.currentTime - lookBehind)
      );

      const horizonTime = options.currentTime + (options.horizonSeconds ?? settings.horizonSeconds);
      let endIndex = task.tsUrlList.length - 1;
      for (let i = startIndex; i < cumulative.length; i += 1) {
        if (cumulative[i] > horizonTime) {
          endIndex = i;
          break;
        }
      }

      this.windowFrom = Math.max(0, options.currentTime - lookBehind);
      this.windowTo = cumulative[endIndex] ?? cumulative[cumulative.length - 1];
      // 已排到播放列表最后一个片段，说明不存在"更远但还没缓存"的内容了
      this.reachedEnd = endIndex >= task.tsUrlList.length - 1;

      // 队列顺序：先前向（急），再回看（缓）
      queue = [];
      for (let i = startIndex; i <= endIndex; i += 1) queue.push(i);
      for (let i = startIndex - 1; i >= fromIndex; i -= 1) queue.push(i);
    } else {
      // 时长信息缺失：退化为"从头预取固定数量片段"，至少保证有缓存可用
      const limit = Math.min(task.tsUrlList.length, FALLBACK_MAX_SEGMENTS);
      queue = [];
      for (let i = 0; i < limit; i += 1) queue.push(i);
      this.windowFrom = 0;
      this.windowTo = Number.MAX_SAFE_INTEGER;
      this.reachedEnd = limit >= task.tsUrlList.length;
    }

    if (queue.length === 0) {
      this.emit(options, { state: 'done', message: '没有需要预取的片段' }, true);
      return;
    }

    void ensurePersistentStorage();

    this.emit(
      options,
      {
        state: 'running',
        total: queue.length,
        cached: 0,
        bytes: 0,
        coverTo: 0,
        message: undefined,
      },
      true
    );

    let cursor = 0;
    let cached = 0;
    let bytes = 0;
    let maxCachedIndex = -1;
    let lastEvictAt = Date.now();

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        await this.waitWhileThrottled(signal);
        if (signal.aborted) return;

        const slot = cursor;
        cursor += 1;
        if (slot >= queue.length) return;

        const segmentIndex = queue[slot];
        const cacheKey = buildSegmentCacheKey(task.tsUrlList[segmentIndex], useProxy);

        try {
          if (await hasCachedSegment(cacheKey)) {
            cached += 1;
            if (segmentIndex > maxCachedIndex) maxCachedIndex = segmentIndex;
            void touchMeta(cacheKey);
            this.emit(options, {
              cached,
              coverTo: durationsUsable ? cumulative[maxCachedIndex] ?? 0 : 0,
            });
            continue;
          }

          const startedAt = Date.now();
          const response = await fetch(cacheKey, {
            signal,
            credentials: 'omit',
            cache: 'no-store',
          });
          if (!response.ok) {
            this.emit(options, {
              message: `片段 ${segmentIndex + 1} 预取失败 ${response.status}`,
            });
            continue;
          }

          const buffer = await response.arrayBuffer();
          const costMs = Math.max(1, Date.now() - startedAt);

          await putCachedSegment(
            cacheKey,
            buffer,
            response.headers.get('Content-Type')
          );

          await metaStore.put({
            key: cacheKey,
            episodeKey: options.episodeKey,
            index: segmentIndex + 1,
            bytes: buffer.byteLength,
            costMs,
            lastAccess: Date.now(),
          });

          cached += 1;
          bytes += buffer.byteLength;
          if (segmentIndex > maxCachedIndex) maxCachedIndex = segmentIndex;

          this.emit(options, {
            cached,
            bytes,
            coverTo: durationsUsable ? cumulative[maxCachedIndex] ?? 0 : 0,
          });
        } catch {
          // 单个片段失败（含 abort）不影响整轮，继续下一个
          if (signal.aborted) return;
        }

        if (Date.now() - lastEvictAt > EVICT_INTERVAL_MS) {
          lastEvictAt = Date.now();
          void enforceQuota(settings);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, worker)
    );
    if (signal.aborted) return;

    void enforceQuota(settings);
    this.emit(options, { state: 'done', message: `已缓存 ${cached} 个片段` }, true);
  }
}

/** 全站单例：跨组件 / 跨路由复用同一份队列，避免重复预取同一片段 */
let singleton: VideoPrefetcher | null = null;

export function getVideoPrefetcher(): VideoPrefetcher {
  if (!singleton) singleton = new VideoPrefetcher();
  return singleton;
}
