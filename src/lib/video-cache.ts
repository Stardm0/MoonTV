/**
 * 视频片段本地缓存层。
 *
 * 职责边界：Cache Storage 读写 + IndexedDB 元数据 + LRU 淘汰 + 设置持久化。
 * 不做任何与播放器状态相关的判断，因此可以在视频暂停、页面切到后台时继续工作。
 *
 * 关于「为什么不用 Service Worker」：
 *   1. 代码里本来就在替换 hls.js 的 loader（做去广告），叠加 cache-first 零注册成本；
 *   2. next-pwa 的 dest 是 public，会在生产构建时覆盖手写的 public/sw.js，scope 会冲突；
 *   3. 跨域片段经 SW 拦截拿到的是 opaque response，cache.put 存不了内容。
 */

/** 片段响应体的 Cache Storage 桶名 */
export const VIDEO_CACHE_NAME = 'moontv-video-v1';

const META_DB = 'moontv-video-meta';
const META_VERSION = 1;
const META_STORE = 'segments';

export const CACHE_SETTINGS_KEY = 'video_cache_settings';

export interface SegmentMeta {
  /** Cache Storage 中的 key（同源代理 URL 或源站绝对 URL） */
  key: string;
  /** 剧集标识 `${source}:${id}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  /** 字节数 */
  bytes: number;
  /** 预取时的实际耗时(ms)，用于给 hls.js 合成 LoaderStats，避免 ABR 高估带宽 */
  costMs: number;
  /** 最后访问时间戳，LRU 依据 */
  lastAccess: number;
}

/**
 * 前向缓存"不设上限"的哨兵值。
 *
 * 传 0 表示一直往后铺，直到播放列表最后一个分片；播放推进时只做增量续跑，
 * 暂停、页面切到后台都不会让队列停下来。真正的兜底交给字节上限
 * （`maxBytesPerEpisode` / `maxTotalBytes`）与 LRU 淘汰，而不是时间。
 */
export const UNLIMITED_HORIZON_SECONDS = 0;

export interface CacheSettings {
  /** 总开关 */
  enabled: boolean;
  /**
   * 前向缓存目标时长（秒）。
   *
   * `UNLIMITED_HORIZON_SECONDS`（0）= 不设时间上限，缓存到片尾。
   */
  horizonSeconds: number;
  /** 单集最大占用（字节） */
  maxBytesPerEpisode: number;
  /** 全部缓存最大占用（字节） */
  maxTotalBytes: number;
  /** 是否走 /api/m3u8 同源代理（false 时直接缓存源站绝对 URL） */
  useProxy: boolean;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  // 默认不设时间上限：暂停后一直往后缓存，直到片尾或触发字节上限淘汰
  horizonSeconds: UNLIMITED_HORIZON_SECONDS,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  useProxy: true,
};

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

export function loadCacheSettings(): CacheSettings {
  if (typeof window === 'undefined') return DEFAULT_CACHE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(CACHE_SETTINGS_KEY);
    if (!raw) return DEFAULT_CACHE_SETTINGS;
    return normalizeCacheSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CACHE_SETTINGS;
  }
}

/** 对可能不可信的配置做字段级校验，避免脏数据导致配额失控 */
export function normalizeCacheSettings(input: unknown): CacheSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CACHE_SETTINGS;
  const raw = input as Record<string, unknown>;

  const settings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };

  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled;
  if (typeof raw.useProxy === 'boolean') settings.useProxy = raw.useProxy;

  const horizon = clampNumber(raw.horizonSeconds, 0, 7200);
  if (horizon !== undefined) {
    // 0 是「无限」哨兵，必须原样保留；其余值低于 1 分钟没有意义，抬到 60s
    settings.horizonSeconds =
      horizon === 0 ? UNLIMITED_HORIZON_SECONDS : Math.max(60, Math.round(horizon));
  }

  const perEpisode = clampNumber(raw.maxBytesPerEpisode, 50 * 1024 * 1024, 8 * 1024 ** 3);
  if (perEpisode !== undefined) settings.maxBytesPerEpisode = Math.round(perEpisode);

  const total = clampNumber(raw.maxTotalBytes, 100 * 1024 * 1024, 20 * 1024 ** 3);
  if (total !== undefined) settings.maxTotalBytes = Math.round(total);

  if (settings.maxBytesPerEpisode > settings.maxTotalBytes) {
    settings.maxBytesPerEpisode = settings.maxTotalBytes;
  }

  return settings;
}

export function saveCacheSettings(next: Partial<CacheSettings>): CacheSettings {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {
    window.localStorage.setItem(CACHE_SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    // 隐私模式 / 存储配额满时静默失败，不影响播放
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* IndexedDB 元数据                                                    */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase> | null = null;

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openMetaDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(META_DB, META_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'key' });
        store.createIndex('by_episode', 'episodeKey');
        store.createIndex('by_access', 'lastAccess');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // 打开失败时清空缓存句柄，允许下次重试
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openMetaDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(META_STORE, mode);
        const request = fn(transaction.objectStore(META_STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      })
  );
}

export const metaStore = {
  put(record: SegmentMeta): Promise<void> {
    return runTx<void>('readwrite', (store) => store.put(record));
  },
  get(key: string): Promise<SegmentMeta | undefined> {
    return runTx<SegmentMeta | undefined>('readonly', (store) => store.get(key));
  },
  del(key: string): Promise<void> {
    return runTx<void>('readwrite', (store) => store.delete(key));
  },
  all(): Promise<SegmentMeta[]> {
    return runTx<SegmentMeta[]>('readonly', (store) => store.getAll());
  },
  clear(): Promise<void> {
    return runTx<void>('readwrite', (store) => store.clear());
  },
};

/** 30 秒内同一 key 只写一次 lastAccess，避免命中缓存时频繁写盘 */
const lastTouchAt = new Map<string, number>();
const TOUCH_INTERVAL_MS = 30_000;

export async function touchMeta(key: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouchAt.get(key);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouchAt.set(key, now);

  try {
    const record = await metaStore.get(key);
    if (!record) return;
    record.lastAccess = now;
    await metaStore.put(record);
  } catch {
    // 元数据写入失败不影响播放
  }
}

/* ------------------------------------------------------------------ */
/* Cache Storage                                                       */
/* ------------------------------------------------------------------ */

export function isCacheStorageAvailable(): boolean {
  return typeof caches !== 'undefined';
}

export async function openVideoCache(): Promise<Cache | null> {
  if (!isCacheStorageAvailable()) return null;
  try {
    return await caches.open(VIDEO_CACHE_NAME);
  } catch {
    return null;
  }
}

export async function hasCachedSegment(key: string): Promise<boolean> {
  const cache = await openVideoCache();
  if (!cache) return false;
  try {
    return (await cache.match(key)) !== undefined;
  } catch {
    return false;
  }
}

/** 申请持久化存储，降低磁盘紧张时被浏览器整块清理的概率 */
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface CacheStorageEstimate {
  usage: number;
  quota: number;
  ratio: number;
}

export async function estimateStorage(): Promise<CacheStorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 命中率探针                                                          */
/* ------------------------------------------------------------------ */

/**
 * 片段缓存命中/未命中计数。
 *
 * 用途：预取器与 loader 的缓存键必须字节一致，一旦 `applyURL` 之类的
 * URL 解析出现分歧，缓存会静默 0 命中（表现为"预取白跑、播放依旧走网络"）。
 * 命中率是最直接的观测手段，设置面板里会展示。
 */
const segmentProbe = { hits: 0, misses: 0 };

export function recordSegmentProbe(hit: boolean): void {
  if (hit) segmentProbe.hits += 1;
  else segmentProbe.misses += 1;
}

export function getSegmentProbe(): {
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = segmentProbe.hits + segmentProbe.misses;
  return {
    hits: segmentProbe.hits,
    misses: segmentProbe.misses,
    hitRate: total > 0 ? segmentProbe.hits / total : 0,
  };
}

export function resetSegmentProbe(): void {
  segmentProbe.hits = 0;
  segmentProbe.misses = 0;
}

/**
 * LRU 淘汰。
 *
 * 两轮：先按 episodeKey 内淘汰最久未访问的片段满足单集上限，
 * 再按全局最久未访问淘汰满足总上限。
 *
 * @returns 实际删除的片段数量
 */
export async function enforceQuota(
  settings: CacheSettings = loadCacheSettings()
): Promise<number> {
  const cache = await openVideoCache();
  if (!cache) return 0;

  let records: SegmentMeta[];
  try {
    records = await metaStore.all();
  } catch {
    return 0;
  }
  if (records.length === 0) return 0;

  const victims = new Set<string>();
  let total = records.reduce((sum, record) => sum + (record.bytes || 0), 0);

  // ① 单集超限
  const grouped = new Map<string, SegmentMeta[]>();
  for (const record of records) {
    const list = grouped.get(record.episodeKey);
    if (list) list.push(record);
    else grouped.set(record.episodeKey, [record]);
  }

  for (const list of Array.from(grouped.values())) {
    list.sort((a, b) => a.lastAccess - b.lastAccess);
    let size = list.reduce((sum, record) => sum + (record.bytes || 0), 0);
    for (const record of list) {
      if (size <= settings.maxBytesPerEpisode) break;
      victims.add(record.key);
      size -= record.bytes || 0;
      total -= record.bytes || 0;
    }
  }

  // ② 全局超限
  if (total > settings.maxTotalBytes) {
    const rest = records
      .filter((record) => !victims.has(record.key))
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const record of rest) {
      if (total <= settings.maxTotalBytes) break;
      victims.add(record.key);
      total -= record.bytes || 0;
    }
  }

  if (victims.size === 0) return 0;

  let removed = 0;
  await Promise.all(
    Array.from(victims).map(async (key) => {
      try {
        if (await cache.delete(key)) removed += 1;
      } catch {
        // ignore
      }
      try {
        await metaStore.del(key);
      } catch {
        // ignore
      }
      lastTouchAt.delete(key);
    })
  );

  return removed;
}

export async function clearVideoCache(): Promise<void> {
  try {
    await caches.delete(VIDEO_CACHE_NAME);
  } catch {
    // ignore
  }
  try {
    await metaStore.clear();
  } catch {
    // ignore
  }
  lastTouchAt.clear();
}

/** 统计已缓存字节数与片段数（设置面板展示用） */
export async function getCacheSummary(): Promise<{
  bytes: number;
  segments: number;
  episodes: number;
}> {
  try {
    const records = await metaStore.all();
    return {
      bytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
      segments: records.length,
      episodes: new Set(records.map((record) => record.episodeKey)).size,
    };
  } catch {
    return { bytes: 0, segments: 0, episodes: 0 };
  }
}

/** 单集缓存的聚合统计 */
export interface EpisodeCacheStat {
  /** 剧集标识 `${source}:${id}:${episodeIndex}` */
  episodeKey: string;
  /** 片段数 */
  segments: number;
  /** 占用字节数 */
  bytes: number;
  /** 最近访问时间（用于排序） */
  lastAccess: number;
}

/** 按剧集聚合已缓存内容的统计（缓存管理面板用），按最近访问倒序 */
export async function getEpisodeCacheStats(): Promise<EpisodeCacheStat[]> {
  try {
    const records = await metaStore.all();
    const grouped = new Map<string, EpisodeCacheStat>();
    for (const record of records) {
      const stat = grouped.get(record.episodeKey);
      if (stat) {
        stat.segments += 1;
        stat.bytes += record.bytes || 0;
        if (record.lastAccess > stat.lastAccess) stat.lastAccess = record.lastAccess;
      } else {
        grouped.set(record.episodeKey, {
          episodeKey: record.episodeKey,
          segments: 1,
          bytes: record.bytes || 0,
          lastAccess: record.lastAccess,
        });
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.lastAccess - a.lastAccess);
  } catch {
    return [];
  }
}

/** 删除指定剧集的全部缓存（片段 + 元数据） */
export async function deleteEpisodeCache(episodeKey: string): Promise<number> {
  const cache = await openVideoCache();
  if (!cache) return 0;

  let records: SegmentMeta[];
  try {
    records = await metaStore.all();
  } catch {
    return 0;
  }

  const victims = records.filter((record) => record.episodeKey === episodeKey);
  if (victims.length === 0) return 0;

  let removed = 0;
  await Promise.all(
    victims.map(async (record) => {
      try {
        if (await cache.delete(record.key)) removed += 1;
      } catch {
        // ignore
      }
      try {
        await metaStore.del(record.key);
      } catch {
        // ignore
      }
      lastTouchAt.delete(record.key);
    })
  );
  return removed;
}


/* ------------------------------------------------------------------ */
/* 缓存键                                                              */
/* ------------------------------------------------------------------ */

/**
 * 归一化片段 URL。
 *
 * 预取器（从 m3u8 文本解析）与读取侧（hls.js 的 context.url）必须得到
 * **字节完全一致**的 key，否则缓存永远 0 命中。统一走 URL 构造器，
 * 让默认端口、百分号编码、路径 `..` 的差异都被抹平。
 */
export function normalizeSegmentUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * 生成片段缓存键。
 *
 * - `useProxy = true`：转成同源的 `/api/m3u8?url=...`，键稳定，且天然规避源站
 *   的 Referer / CORS 校验；
 * - `useProxy = false`：直接用源站绝对 URL 作为键，省掉服务端带宽。
 */
export function buildSegmentCacheKey(segmentUrl: string, useProxy = true): string {
  const normalized = normalizeSegmentUrl(segmentUrl);
  return useProxy ? `/api/m3u8?url=${encodeURIComponent(normalized)}` : normalized;
}

/* ------------------------------------------------------------------ */
/* 片段读写                                                            */
/* ------------------------------------------------------------------ */

/**
 * 缓存一个片段响应。仅保留渲染/解码必需的头，避免把源站的
 * CSP、鉴权相关头一起带进缓存。
 */
export async function putCachedSegment(
  key: string,
  buffer: ArrayBuffer,
  contentType?: string | null
): Promise<void> {
  const cache = await openVideoCache();
  if (!cache) return;

  await cache.put(
    key,
    new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(buffer.byteLength),
      },
    })
  );
}

/** 判断是否为 Cache Storage 配额耗尽（各浏览器报错类型不一，按 name + message 双判） */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'QuotaExceededError') return true;
  const name = (err as { name?: unknown }).name;
  if (name === 'QuotaExceededError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /quota/i.test(message);
}

export type PutSegmentResult = 'ok' | 'quota' | 'failed';

/**
 * 带配额自救的分片写入。
 *
 * 前向缓存在"无限模式"下会把整集都铺下来，必然更容易撞到存储配额。
 * 直接 `cache.put` 抛 QuotaExceededError 的话，worker 的 try/catch 会
 * 把每个后续分片都吞掉——表现为"缓存悄悄停在某个位置不动了"，
 * 很难排查。这里先按 LRU 淘汰一批再重试一次，真腾不出空间才上报。
 */
export async function putCachedSegmentResilient(
  key: string,
  buffer: ArrayBuffer,
  contentType?: string | null,
  settings: CacheSettings = loadCacheSettings()
): Promise<PutSegmentResult> {
  try {
    await putCachedSegment(key, buffer, contentType);
    return 'ok';
  } catch (err) {
    if (!isQuotaExceededError(err)) return 'failed';

    const removed = await enforceQuota(settings);
    if (removed === 0) return 'quota';

    try {
      await putCachedSegment(key, buffer, contentType);
      return 'ok';
    } catch {
      return 'quota';
    }
  }
}

export interface CachedFragment {
  data: ArrayBuffer;
  costMs: number;
}

/** 读取缓存片段，同时取回预取时记录的真实耗时（供合成 LoaderStats 用） */
export async function readCachedSegment(key: string): Promise<CachedFragment | null> {
  const cache = await openVideoCache();
  if (!cache) return null;

  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch {
    return null;
  }
  if (!hit) return null;

  try {
    const [data, record] = await Promise.all([
      hit.arrayBuffer(),
      metaStore.get(key).catch(() => undefined),
    ]);
    return { data, costMs: record?.costMs ?? 150 };
  } catch {
    return null;
  }
}

/** 供调试：indexedDB 是否可用 */
export function isMetaStoreAvailable(): boolean {
  return indexedDbAvailable();
}
