/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  setSettingSwitch,
  setSettingTooltip,
  updateSettingPreservingPanel,
} from '@/lib/artplayer-setting';
import { getSearchConcurrency } from '@/lib/concurrency';
import {
  AnimeOption,
  extractEpisodeNumber,
  extractSeasonFromTitle,
  getDanmakuBySelectedAnime,
  matchAnime,
} from '@/lib/danmaku.client';
import {
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  savePlayRecord,
  saveSkipConfig,
} from '@/lib/db.client';
import {
  AUTO_LEVEL,
  buildQualityOptions,
  decideDownshift,
  describeLevel,
  describeQualityPreference,
  loadPreferredQualityHeight,
  MAX_LEVEL,
  MAX_QUALITY_HEIGHT,
  pickHighestLevelIndex,
  pickLevelIndex,
  resolveLevelHeight,
  savePreferredQualityHeight,
} from '@/lib/hls-quality';
import { describeHlsError, PlaybackRecovery } from '@/lib/playback-recovery';
import { getDefaultPlaybackSaveInterval } from '@/lib/playback-settings';
import {
  getWarmupConcurrency,
  shouldThrottlePrefetch,
} from '@/lib/prefetch-scheduler';
import { matchesFullSearchTitle } from '@/lib/search-title';
import { SearchResult } from '@/lib/types';
import {
  getRequestTimeout,
  getVideoResolutionFromM3u8,
  processImageUrl,
} from '@/lib/utils';
import {
  CACHE_CONCURRENCY_PRESETS,
  clearVideoCache,
  getSegmentProbe,
  loadCacheSettings,
  saveCacheSettings,
  UNLIMITED_HORIZON_SECONDS,
} from '@/lib/video-cache';
import {
  getNextEpisodePrefetcher,
  getVideoPrefetcher,
  PrefetchStats,
} from '@/lib/video-prefetcher';

import { triggerGlobalError } from '@/components/GlobalErrorIndicator';

import { wrapArtplayerPluginDanmuku } from './danmuku-live-font-size';
import {
  bindDeferredProgressSeek,
  PROGRESS_PREVIEW_END,
  PROGRESS_PREVIEW_MOVE,
  ProgressPreviewMove,
} from './deferred-progress-seek';
import { useVideoActions } from './hooks/useVideoActions';
import { useWakeLock } from './hooks/useWakeLock';
import { bindMobileGestures } from './mobile-gestures';
import {
  applyHlsBufferPlan,
  calculateSourceScore,
  createCustomHlsLoader,
  createDanmakuInitialConfig,
  DANMAKU_DENSITY_LABELS,
  DANMAKU_VISIBLE_RESTORE_DELAY_MS,
  formatTime,
  getDanmakuDensity,
  pickDanmakuSettings,
  planCurrentHlsBuffer,
  saveDanmakuSettings,
  setDanmakuDensity,
  SkipConfig,
} from './play-utils';
import { clearPlayerNotices, pushPlayerNotice } from './player-notice';
import { PreviewThumbnailer } from './preview-thumbnailer';

/** 进度条悬停预览浮层的实时状态 */
export interface PlayPreviewState {
  visible: boolean;
  /** 悬停对应的时间点（秒） */
  time: number;
  /** 相对进度条宽度的百分比水平位置（0-100） */
  left: number;
  /** 已抽取的预览图 dataURL；加载中 / 失败为 null */
  image: string | null;
}

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

/**
 * 同一集内最多自动换源次数（P1-5）。
 *
 * 换满仍未成功就停下来提示用户手动选源：如果所有源都挂了，
 * 无上限的自动换源只会把候选列表扫成死循环（A→B→C→A...）。
 */
const MAX_AUTO_SOURCE_SWITCHES = 3;

/**
 * seek 之后这段时间内的 `waiting` 不计入「网络卡顿」（毫秒）。
 *
 * 拖动进度条会让 hls.js 立刻 flush 前向缓冲并重新取分片，落地分片还没到就会
 * 抛一次 `waiting`——它说明的是「刚跳过去、还在下载」，跟带宽够不够无关。
 * 若把它算成卡顿，拖一次进度条就等于报告一次「网络波动」，会把画质一路降到底。
 */
const STALL_GRACE_AFTER_SEEK_MS = 4_000;

/**
 * ABR 换档之后这段时间内的 `waiting` 同样不计入卡顿。
 *
 * hls.js 换档时会 flush 缓冲并重新下载当前片段，这段时间的缓冲停顿是换档
 * 本身造成的，不能反过来当成「带宽还不够」的证据继续往下压档位。
 */
const STALL_GRACE_AFTER_LEVEL_SWITCH_MS = 3_000;

/**
 * 生成只读的设置说明行。
 *
 * Artplayer 的 setting 行默认是可点击选项；说明文字不应被选中，
 * 因此关掉指针事件并隐藏左侧的勾选图标，只作为静态列表展示。
 */
function buildReadonlySettingRows(items: string[]) {
  return items.map((html) => ({
    html,
    mounted: (item: HTMLElement) => {
      item.style.pointerEvents = 'none';
      item.style.justifyContent = 'center';

      const icon = item.querySelector<HTMLElement>(
        '.art-setting-item-left-icon'
      );
      if (icon) icon.style.display = 'none';

      // 说明文字居中展示，而不是沿用设置项的左侧对齐
      const left = item.querySelector<HTMLElement>('.art-setting-item-left');
      if (left) {
        left.style.flex = '1';
        left.style.justifyContent = 'center';
      }
      const text = item.querySelector<HTMLElement>(
        '.art-setting-item-left-text'
      );
      if (text) {
        text.style.width = '100%';
        text.style.textAlign = 'center';
      }
      const right = item.querySelector<HTMLElement>('.art-setting-item-right');
      if (right) right.style.display = 'none';
    },
  }));
}

/** 「画质」设置项的 name，`setting.update` 靠它定位 */
const QUALITY_SETTING_NAME = '画质';

/** 「视频缓存」设置项的 name */
const CACHE_SETTING_NAME = '视频缓存';

/** 「弹幕源」设置项的 name */
const DANMAKU_SETTING_NAME = '弹幕源';

/** 自动加载弹幕的常驻提示文案 */
const DANMAKU_LOADING_NOTICE_TEXT = '正在自动加载弹幕…';

/** 手动选择弹幕源时的常驻提示文案 */
const DANMAKU_MANUAL_LOADING_NOTICE_TEXT = '正在加载弹幕…';

/**
 * 下一集预热的覆盖时长（秒）。
 *
 * 这是唯一还保留时间上限的地方：预热只是为了"切过去不卡"，没必要把整集
 * 都拉下来。当前集的预取已改为不设上限（缓存到片尾）；用户真切过去之后，
 * 当前集预取器会接管，按无限视野继续往后铺。
 */
const NEXT_EPISODE_HORIZON_SECONDS = 420;

/**
 * 会话级的「上次播放的影片」标记（`source:id`）。
 *
 * 换片通常是回列表再进播放页，`usePlayEngine` 会整页重新挂载，ref 里的
 * 上一次播放位置拿不到；只能靠会话存储判断「上一部片是不是另一部」，
 * 否则新影片开始播放时，上一部片的缓存会一直留在本地。
 */
const LAST_CACHE_VIDEO_KEY = 'moontv:last-cache-video';

/** 首次进入播放页时提示一次帮助入口 */
const HELP_TIP_SEEN_KEY = 'moontv:help-tip-seen';

function readLastCacheVideoKey(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_CACHE_VIDEO_KEY);
  } catch {
    return null;
  }
}

function writeLastCacheVideoKey(videoKey: string): void {
  try {
    window.sessionStorage.setItem(LAST_CACHE_VIDEO_KEY, videoKey);
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用，仅影响换片清理，忽略即可。
  }
}

/**
 * 组装「视频缓存」设置项的 tooltip 文案。
 *
 * `hitRate` 为 null 表示还没有任何片段请求，因此没有命中率可展示。
 */
function buildCacheTooltip(
  stats: PrefetchStats,
  hitRate: number | null
): string {
  switch (stats.state) {
    case 'disabled':
      return stats.message || '已关闭';
    case 'parsing':
      return '解析播放列表中...';
    case 'error':
      return stats.message || '缓存不可用';
    case 'idle':
      return '未开始';
    default:
      break;
  }

  if (stats.total === 0) return '未开始';

  const coverPart =
    stats.coverTo > 0 ? ` · 已覆盖 ${formatTime(stats.coverTo)}` : '';
  // 个别分片坏掉不会终止整轮，但要让用户知道有缺口，而不是以为缓存完整。
  const failedPart = stats.failed > 0 ? ` · ${stats.failed} 段失败` : '';
  const hitPart =
    hitRate === null ? '' : ` · 命中 ${Math.round(hitRate * 100)}%`;
  return `${stats.cached}/${stats.total} 段${coverPart}${failedPart}${hitPart}`;
}

/**
 * 播放页引擎。
 *
 * 负责播放页的全部核心逻辑：源加载/优选、剧集切换、ArtPlayer 生命周期、
 * 弹幕自动匹配、去广告、跳过片头片尾、播放记录、键盘快捷键与状态清理等。
 *
 * 返回一个包含渲染所需状态/回调的对象，供 {@link PlayClient} 组合展示。
 */
export function usePlayEngine() {
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);
  const [isDanmakuPluginReady, setIsDanmakuPluginReady] = useState(false);
  const [isDanmakuLoading, setIsDanmakuLoading] = useState(false);
  /** 弹幕加载来源：自动匹配 / 手动选择，决定加载提示文案 */
  const [danmakuLoadingKind, setDanmakuLoadingKind] = useState<
    'auto' | 'manual'
  >('auto');

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<SkipConfig>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  const restartPrefetchForSkipRef = useRef<(() => void) | null>(null);
  /** 已提示过的缓存停止原因（状态 + 文案），避免同一原因反复闪现 */
  const cacheNoticeRef = useRef<string | null>(null);
  /** 进入播放页时是否已就「缓存已开启」提示过（切集不重复） */
  const cacheEnabledNoticeShownRef = useRef(false);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
    restartPrefetchForSkipRef.current?.();
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);
  // 预缓存窗口续跑的时间间隔控制（播放自然推进时定期检查窗口余量）
  const lastPrefetchCheckRef = useRef(0);
  // —— 弱网自动降档 ——
  // 最近 2 分钟内的卡顿时间戳；反复卡顿时把 ABR 上限压一档，宁可糊一点不要一直转圈
  const stallTimesRef = useRef<number[]>([]);
  // 记录已提示过的降档状态，避免 notice 反复弹
  const downshiftNoticeRef = useRef<string | null>(null);
  // 最近一次 seek / ABR 换档的时间戳：用于把「seek、换档引起的重新缓冲」
  // 与「播放中真的网络跟不上」区分开，见 STALL_GRACE_AFTER_* 常量。
  const lastSeekAtRef = useRef(0);
  const lastLevelSwitchAtRef = useRef(0);

  const [isBlockAdChanged, setIsBlockAdChanged] = useState(false);
  /**
   * 「去广告」开关。
   *
   * 开启后从点播播放列表中剔除广告分片，识别依据：
   *  - SCTE-35 `#EXT-X-CUE-OUT` / `#EXT-X-CUE-IN` 广告窗；
   *  - 广告特征 URL（`/ad/`、`preroll`、`guanggao` 等）；
   *  - 被长内容夹住的 15–30s 中插短块。
   * 不连续标记、KEY、MAP 全部保留，因此不会产生旧实现那种时间轴空洞。
   *
   * 使用 v2 key：旧 key 对应"只删 `#EXT-X-DISCONTINUITY`"的旧实现，
   * 不再沿用旧值。
   */
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('enable_blockad_v2') === 'true';
    }
    return false;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 视频预缓存（Cache Storage）。
  // 预取器与播放状态完全解耦：视频暂停、页面切后台时仍会继续把前向片段写进缓存。
  // 进度不走 React state——它会以 250ms 的节奏回调，走 state 会让整页高频重渲染，
  // 这里直接更新 ArtPlayer 的设置项 tooltip。
  const prefetcherRef = useRef(getVideoPrefetcher());
  const cacheClearPromiseRef = useRef<Promise<void> | null>(null);
  /** 上次触发缓存清理时的播放位置：影片标识 + 集数 */
  const previousCacheEpisodeRef = useRef<{
    videoKey: string;
    episodeIndex: number;
  } | null>(null);

  // 下一集预热（落地路线第 3 步）。独立实例，避免打断当前集的队列。
  // `nextWarmupKeyRef` 记录"已经为哪一集的哪个档位预热过"，防止重复排队。
  const nextWarmupKeyRef = useRef<string | null>(null);

  // 弹幕源选择相关
  const [selectedDanmakuSource, setSelectedDanmakuSource] = useState<
    string | null
  >(null);
  const [selectedDanmakuAnime, setSelectedDanmakuAnime] =
    useState<AnimeOption | null>(null);
  const [selectedDanmakuEpisode, setSelectedDanmakuEpisode] = useState<
    number | undefined
  >(undefined);
  const [showDanmakuSelector, setShowDanmakuSelector] = useState(false);
  /** 手动选择弹幕源的版本号：即使重复选中同一番剧/集数也重新走一遍加载流程 */
  const [danmakuSelectNonce, setDanmakuSelectNonce] = useState(0);
  const [showCacheManager, setShowCacheManager] = useState(false);
  const selectedDanmakuSourceRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 同步 ref
  useEffect(() => {
    selectedDanmakuSourceRef.current = selectedDanmakuSource;
  }, [selectedDanmakuSource]);

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [videoDoubanId, setVideoDoubanId] = useState(0);
  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);

  // 自动匹配弹幕设置
  const [autoDanmakuEnabled, setAutoDanmakuEnabled] = useState(false);
  const [preferredDanmakuPlatform, setPreferredDanmakuPlatform] =
    useState('bilibili1');

  const [currentTooltip, setCurrentTooltip] = useState('');
  const [selectedState, setSelectedState] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const savedAuto = localStorage.getItem('autoDanmakuEnabled');
    if (savedAuto !== null) {
      setAutoDanmakuEnabled(JSON.parse(savedAuto));
    }

    const savedPlatform = localStorage.getItem('preferredDanmakuPlatform');
    if (savedPlatform) {
      setPreferredDanmakuPlatform(savedPlatform);
    }
  }, []);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  // 用户手动/自动选择弹幕番剧后，加载对应集的弹幕
  useEffect(() => {
    if (!selectedDanmakuAnime || !detail) return;

    const currentEpisodeTitle = detail?.episodes_titles?.[currentEpisodeIndex];
    if (!currentEpisodeTitle) return;

    let matchedEpisode: any = null;
    /** 是否为用户手动选择：与切集自动加载一致，先隐藏旧弹幕、显示加载提示 */
    let isManualSelect = false;

    /** ① 用户手动选择某一集（权重大最高） */
    if (selectedDanmakuEpisode !== undefined && selectedState) {
      matchedEpisode =
        selectedDanmakuAnime.episodes[selectedDanmakuEpisode - 1];
      isManualSelect = true;
      setSelectedState(false);
    } else if (autoDanmakuEnabled) {
      /** ② 自动匹配模式：直接使用第 0 集 */
      matchedEpisode = selectedDanmakuAnime.episodes[0];
    }

    if (!matchedEpisode) return;

    const episodeIndex = selectedDanmakuAnime.episodes.indexOf(matchedEpisode);
    const episodeNumber = episodeIndex + 1;

    // 更新 tooltip（走 DOM setter，不触发面板重建）
    setTimeout(() => {
      setSettingTooltip(
        artPlayerRef.current,
        DANMAKU_SETTING_NAME,
        matchedEpisode.episodeTitle
      );
    }, 100);

    // 加载弹幕 URL
    (async () => {
      try {
        const url = await getDanmakuBySelectedAnime(
          selectedDanmakuAnime,
          episodeNumber,
          'xml'
        );
        const inst = danmukuPluginInstanceRef.current;

        // 插件未就绪时无法加载，避免手动选择后一直停留在「加载中」
        if (!inst) {
          if (isManualSelect) setIsDanmakuLoading(false);
          return;
        }

        // 与当前已加载的弹幕源相同：无需重新加载，直接恢复可见性
        if (url === lastDanmakuUrlRef.current) {
          if (isManualSelect) {
            setIsDanmakuLoading(false);
            scheduleDanmakuVisibleRestore();
          }
          return;
        }

        // 手动选择时与切集自动加载一致：先隐藏旧弹幕并提示加载
        if (isManualSelect) beginManualDanmakuLoad();

        console.log('动态更新弹幕源:', url);
        inst.config({ danmuku: url });

        // 切集/手动选择时弹幕已隐藏，load() 内部会在远端返回后 reset 并写入
        // 新队列，完成后再恢复可见性，因此这里不需要额外 reset（避免重复清屏卡顿）
        inst
          .load()
          .then(() => {
            if (lastDanmakuUrlRef.current === url) {
              if (isManualSelect) setIsDanmakuLoading(false);
              scheduleDanmakuVisibleRestore();
            }
          })
          .catch((e: unknown) => {
            console.error('加载弹幕失败:', e);
            if (lastDanmakuUrlRef.current === url) {
              // 加载失败时清空旧集弹幕再恢复，避免恢复后显示错误内容
              try {
                inst.reset?.();
              } catch (_) {
                // 忽略：插件版本差异
              }
              if (isManualSelect) setIsDanmakuLoading(false);
              scheduleDanmakuVisibleRestore();
            }
          });

        lastDanmakuUrlRef.current = url;
        setCurrentTooltip(matchedEpisode.episodeTitle);
      } catch (e) {
        console.error('获取弹幕 URL 失败:', e);
        // 手动选择失败时同样要恢复弹幕，避免一直处于隐藏状态
        if (isManualSelect) {
          setIsDanmakuLoading(false);
          scheduleDanmakuVisibleRestore();
        }
      }
    })();
  }, [
    currentEpisodeIndex,
    selectedDanmakuAnime,
    selectedDanmakuEpisode,
    danmakuSelectNonce,
  ]);

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 切集/换片时清空"已试过的源"与"自动换源次数"：
  // 某个源只是这一集挂了，不代表下一集也挂，不该把惩罚带到下一集。
  useEffect(() => {
    const previous = previousCacheEpisodeRef.current;
    const videoKey = `${currentSource}:${currentId}`;
    const hasVideoIdentity = Boolean(currentSource && currentId);
    // 换片一般会整页重新挂载，此时 previous 还是空的，
    // 用会话里记下的上一部片补出「换片」这个事实；
    // 连会话记忆都没有（新标签页/新会话）说明本次播放与之前无从比对，
    // 同样按换片处理，顺手清掉上一次会话残留的缓存。
    const previousVideoKey =
      previous !== null ? previous.videoKey : readLastCacheVideoKey();
    previousCacheEpisodeRef.current = {
      videoKey,
      episodeIndex: currentEpisodeIndex,
    };
    if (hasVideoIdentity) writeLastCacheVideoKey(videoKey);
    // 切集、换片或换源立即中止旧下载，是否删除已落盘缓存由清理开关单独决定。
    prefetcherRef.current.stop();
    getNextEpisodePrefetcher().stop();
    // 集号变了要清（保留新的当前集与下一集预热）；
    // 换了一部影片（源或 id 变了）时，上一部片的缓存没有任何复用价值，
    // 即便集号恰好相同也必须清掉。
    const isDifferentEpisode =
      previous !== null && previous.episodeIndex !== currentEpisodeIndex;
    const isDifferentVideo = previousVideoKey !== videoKey;
    if (
      hasVideoIdentity &&
      (isDifferentEpisode || isDifferentVideo) &&
      loadCacheSettings().autoClearOnEpisodeChange
    ) {
      const previousClear = cacheClearPromiseRef.current;
      const stopped = Promise.all([
        prefetcherRef.current.stopAndWait(),
        getNextEpisodePrefetcher().stopAndWait(),
      ]);
      // 新当前集可能正是已预热的下一集，同时保留它之后一集的预热。
      const episodePrefix = videoKey;
      const keepEpisodeKeys = [
        `${episodePrefix}:${currentEpisodeIndex}`,
        `${episodePrefix}:${currentEpisodeIndex + 1}`,
      ];
      const clearing = (async () => {
        await previousClear;
        await stopped;
        await clearVideoCache(keepEpisodeKeys);
      })().catch((error) => {
        console.error('切集/换片自动清理缓存失败:', error);
      });
      cacheClearPromiseRef.current = clearing;
      void clearing.finally(() => {
        if (cacheClearPromiseRef.current === clearing) {
          cacheClearPromiseRef.current = null;
        }
      });
    }
    triedSourcesRef.current = new Set();
    autoSwitchCountRef.current = 0;
    // 切集/换源后"下一集"的目标变了，旧的预热队列立刻作废。
    // 已经落盘的分片不受影响（缓存键与集数无关），不会白费。
    nextWarmupKeyRef.current = null;
    getNextEpisodePrefetcher().stop();
  }, [currentEpisodeIndex, currentSource, currentId]);

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 0.7
  const lastVolumeRef = useRef<number>(0.7);
  // 上次使用的播放速率，默认 1.0
  const lastPlaybackRateRef = useRef<number>(1.0);
  const lastFullscreenRef = useRef<boolean>(false);
  const lastFullscreenWebRef = useRef<boolean>(false);
  // 弹幕插件配置：默认配置叠加本地持久化的用户设置，保证刷新后自动恢复
  const danmakuConfigRef = useRef<any>(createDanmakuInitialConfig());

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 自动换源的候选列表（P1-5）：必须走 ref，因为读取它的是注册在
  // ArtPlayer 创建时（早于后续渲染）的 HLS 错误回调。
  useEffect(() => {
    availableSourcesRef.current = availableSources;
  }, [availableSources]);

  // 当前集数的播放地址。监听器（timeupdate/seeked/pause）是在创建播放器
  // 那一刻注册的，闭包里的 videoUrl 会随切集而过期；预取必须按实时地址走，
  // 否则会把上一集的片段写进缓存，白烧带宽。
  const currentVideoUrlRef = useRef<string>('');
  useEffect(() => {
    currentVideoUrlRef.current = videoUrl;
  }, [videoUrl]);

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  // 换源加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging' | 'optimizing'
  >('initing');

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  const artPlayerRef = useRef<any>(null);
  const artRef = useRef<HTMLDivElement | null>(null);
  /** ArtPlayer 根节点，供把返回/标题 portal 进播放器（全屏也能看见） */
  const [playerHost, setPlayerHost] = useState<HTMLElement | null>(null);
  const danmukuPluginInstanceRef = useRef<any>(null); // 弹幕插件实例

  // ---- 进度条悬停预览 ----
  const previewThumbnailerRef = useRef<PreviewThumbnailer | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const [preview, setPreview] = useState<PlayPreviewState | null>(null);
  const lastDanmakuUrlRef = useRef<string>(''); // 上一次加载的弹幕 URL
  const pendingDanmakuVisibleRestoreRef = useRef<boolean | null>(null); // 切集后待恢复的弹幕可见状态

  // ---- P1-5 / P1-6 相关 ----
  /** 当前 HLS 实例的错误恢复状态机（换源/重建时销毁重建） */
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  /** 最近一次渲染的 availableSources，供早于本轮渲染注册的回调读取 */
  const availableSourcesRef = useRef<SearchResult[]>([]);
  /** 最近一次渲染的 handleSourceChange，供 HLS 错误回调读取（避免闭包过期） */
  const handleSourceChangeRef = useRef<
    | ((
        newSource: string,
        newId: string,
        newTitle: string,
        options?: { auto?: boolean }
      ) => Promise<void>)
    | null
  >(null);
  /** 本集内已经尝试过的源（`source:id`），防止自动换源来回横跳 */
  const triedSourcesRef = useRef<Set<string>>(new Set());
  /** 本集内已自动换源次数 */
  const autoSwitchCountRef = useRef<number>(0);
  /** 当前期望的画质高度，null 表示自动 */
  const preferredHeightRef = useRef<number | null>(
    loadPreferredQualityHeight()
  );
  const isEpisodeSwitchingRef = useRef(false); // 标记当前是否为切集切换
  const danmakuVisibleRestoreTimerRef = useRef<NodeJS.Timeout | null>(null); // 延迟恢复弹幕可见性的定时器

  // Wake Lock（屏幕常亮）
  const { requestWakeLock, releaseWakeLock } = useWakeLock();

  // 切换集数时临时隐藏弹幕，待弹幕获取成功后恢复
  const hideDanmakuDuringEpisodeSwitch = () => {
    if (danmakuVisibleRestoreTimerRef.current) {
      clearTimeout(danmakuVisibleRestoreTimerRef.current);
      danmakuVisibleRestoreTimerRef.current = null;
    }

    const inst = danmukuPluginInstanceRef.current as any;

    // 手动模式下切集不会自动加载新弹幕源，没有恢复时机：
    // 保持原可见性，异步清空旧弹幕。reset() 可能遍历大量弹幕，
    // 同步执行会让切集点击明显卡顿
    if (!autoDanmakuEnabled) {
      pendingDanmakuVisibleRestoreRef.current = null;
      setTimeout(() => {
        try {
          danmukuPluginInstanceRef.current?.reset?.();
        } catch (_) {
          // ignore
        }
      }, 0);
      return;
    }

    const currentVisible =
      typeof inst?.visible === 'boolean'
        ? inst.visible
        : !!danmakuConfigRef.current.visible;

    pendingDanmakuVisibleRestoreRef.current = currentVisible;
    danmakuConfigRef.current.visible = false;

    if (!inst) return;

    try {
      inst.config({ visible: false });
    } catch (_) {
      // ignore
    }

    try {
      if (typeof inst.visible === 'boolean') {
        inst.visible = false;
      }
    } catch (_) {
      // ignore
    }
  };

  /** 恢复切集时临时隐藏的弹幕（延迟执行，避免遮挡加载提示） */
  const scheduleDanmakuVisibleRestore = () => {
    if (pendingDanmakuVisibleRestoreRef.current === null) return;
    const visible = pendingDanmakuVisibleRestoreRef.current;

    if (danmakuVisibleRestoreTimerRef.current) {
      clearTimeout(danmakuVisibleRestoreTimerRef.current);
    }

    danmakuVisibleRestoreTimerRef.current = setTimeout(() => {
      danmakuConfigRef.current.visible = visible;
      danmukuPluginInstanceRef.current?.config({ visible });
      pendingDanmakuVisibleRestoreRef.current = null;
      danmakuVisibleRestoreTimerRef.current = null;
    }, DANMAKU_VISIBLE_RESTORE_DELAY_MS);
  };

  /**
   * 手动选择弹幕源时，沿用切集自动加载的同一套流程：
   * 先隐藏旧弹幕并展示加载提示，待新弹幕加载完成后再恢复可见性。
   */
  const beginManualDanmakuLoad = () => {
    setDanmakuLoadingKind('manual');

    // 切集流程已经隐藏过弹幕时沿用其待恢复状态，
    // 不能把隐藏后的 false 当成用户原本的可见性
    if (pendingDanmakuVisibleRestoreRef.current === null) {
      const currentInst = danmukuPluginInstanceRef.current as any;
      const currentVisible =
        typeof currentInst?.visible === 'boolean'
          ? currentInst.visible
          : !!danmakuConfigRef.current.visible;
      pendingDanmakuVisibleRestoreRef.current = currentVisible;
    }

    if (danmakuVisibleRestoreTimerRef.current) {
      clearTimeout(danmakuVisibleRestoreTimerRef.current);
      danmakuVisibleRestoreTimerRef.current = null;
    }

    danmakuConfigRef.current.visible = false;

    const inst = danmukuPluginInstanceRef.current as any;
    if (!inst) return;

    try {
      inst.config({ visible: false });
    } catch (_) {
      // ignore
    }

    try {
      if (typeof inst.visible === 'boolean') {
        inst.visible = false;
      }
    } catch (_) {
      // ignore
    }

    setIsDanmakuLoading(true);
  };

  // -----------------------------------------------------------------------------
  // 播放源优选
  // -----------------------------------------------------------------------------

  // 播放源优选函数
  const preferBestSource = async (
    sources: SearchResult[],
    isCancelled?: () => boolean
  ): Promise<SearchResult> => {
    if (sources.length === 1) return sources[0];

    // 检查是否已取消
    if (isCancelled?.()) {
      throw new Error('优选已取消');
    }

    // 将播放源均分为两批，并发测速各批，避免一次性过多请求
    const batchSize = Math.ceil(sources.length / 2);
    const allResults: Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    } | null> = [];

    for (let start = 0; start < sources.length; start += batchSize) {
      // 检查是否已取消
      if (isCancelled?.()) {
        throw new Error('优选已取消');
      }
      const batchSources = sources.slice(start, start + batchSize);
      const batchResults = await Promise.all(
        batchSources.map(async (source) => {
          try {
            // 检查是否有第一集的播放地址
            if (!source.episodes || source.episodes.length === 0) {
              console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
              return null;
            }

            const episodeUrl =
              source.episodes.length > 1
                ? source.episodes[1]
                : source.episodes[0];
            const testResult = await getVideoResolutionFromM3u8(episodeUrl);

            return {
              source,
              testResult,
            };
          } catch (error) {
            return null;
          }
        })
      );
      allResults.push(...batchResults);
    }

    // 等待所有测速完成，包含成功和失败的结果
    // 保存所有测速结果到 precomputedVideoInfo，供 EpisodeSelector 使用（包含错误结果）
    const newVideoInfoMap = new Map<
      string,
      {
        quality: string;
        loadSpeed: string;
        pingTime: number;
        hasError?: boolean;
      }
    >();
    allResults.forEach((result, index) => {
      const source = sources[index];
      const sourceKey = `${source.source}-${source.id}`;

      if (result) {
        // 成功的结果
        newVideoInfoMap.set(sourceKey, result.testResult);
      }
    });

    // 过滤出成功的结果用于优选计算
    const successfulResults = allResults.filter(Boolean) as Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    }>;

    // 检查是否已取消
    if (isCancelled?.()) {
      throw new Error('优选已取消');
    }
    setPrecomputedVideoInfo(newVideoInfoMap);

    if (successfulResults.length === 0) {
      console.warn('所有播放源测速都失败，使用第一个播放源');
      // 虽然没有测速结果，但仍更新 availableSources 以保持一致性（顺序不变）
      setAvailableSources(sources);
      return sources[0];
    }

    // 找出所有有效速度的最大值，用于线性映射
    const validSpeeds = successfulResults
      .map((result) => {
        const speedStr = result.testResult.loadSpeed;
        if (speedStr === '未知' || speedStr === '测量中...') return 0;

        const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
        if (!match) return 0;

        const value = parseFloat(match[1]);
        const unit = match[2];
        return unit === 'MB/s' ? value * 1024 : value; // 统一转换为 KB/s
      })
      .filter((speed) => speed > 0);

    const maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 1024; // 默认1MB/s作为基准

    // 找出所有有效延迟的最小值和最大值，用于线性映射
    const validPings = successfulResults
      .map((result) => result.testResult.pingTime)
      .filter((ping) => ping > 0);

    const minPing = validPings.length > 0 ? Math.min(...validPings) : 50;
    const maxPing = validPings.length > 0 ? Math.max(...validPings) : 1000;

    // 计算每个结果的评分
    const resultsWithScore = successfulResults.map((result) => ({
      ...result,
      score: calculateSourceScore(
        result.testResult,
        maxSpeed,
        minPing,
        maxPing
      ),
    }));

    // 按综合评分排序，选择最佳播放源
    resultsWithScore.sort((a, b) => b.score - a.score);

    // 构建评分映射
    const scoreMap = new Map<string, number>();
    resultsWithScore.forEach((result) => {
      const key = `${result.source.source}-${result.source.id}`;
      scoreMap.set(key, result.score);
    });

    // 为所有源（包括测速失败的）添加评分，失败源评分设为 -1
    const scoredSources = sources.map((source, index) => {
      const key = `${source.source}-${source.id}`;
      const score = scoreMap.get(key) ?? -1;
      return { source, score, index };
    });

    // 按评分降序排序，评分相同则保持原顺序
    scoredSources.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.index - b.index;
    });

    const sortedSources = scoredSources.map((item) => item.source);

    // 检查是否已取消
    if (isCancelled?.()) {
      throw new Error('优选已取消');
    }
    // 更新 availableSources 状态，使列表按评分排序
    setAvailableSources(sortedSources);

    return resultsWithScore[0].source;
  };

  // 更新视频地址
  const updateVideoUrl = (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= detailData.episodes.length
    ) {
      setVideoUrl('');
      return;
    }
    const newUrl = detailData?.episodes[episodeIndex] || '';
    if (newUrl !== videoUrl) {
      setVideoUrl(newUrl);
    }
  };

  const ensureVideoSource = (video: HTMLVideoElement | null, url: string) => {
    if (!video || !url) return;
    const sources = Array.from(video.getElementsByTagName('source'));
    const existed = sources.some((s) => s.src === url);
    if (!existed) {
      // 移除旧的 source，保持唯一
      sources.forEach((s) => s.remove());
      const sourceEl = document.createElement('source');
      sourceEl.src = url;
      video.appendChild(sourceEl);
    }

    // 始终允许远程播放（AirPlay / Cast）
    video.disableRemotePlayback = false;
    // 如果曾经有禁用属性，移除之
    if (video.hasAttribute('disableRemotePlayback')) {
      video.removeAttribute('disableRemotePlayback');
    }
  };

  // 清理播放器资源的统一函数
  const cleanupPlayer = () => {
    // 先取消待执行的退避重试，避免定时器醒来后操作已销毁的 hls 实例
    recoveryRef.current?.dispose();
    recoveryRef.current = null;
    setPlayerHost(null);

    if (artPlayerRef.current) {
      try {
        lastFullscreenRef.current = !!artPlayerRef.current.fullscreen;
        lastFullscreenWebRef.current = !!artPlayerRef.current.fullscreenWeb;
        if (danmukuPluginInstanceRef.current) {
          const inst = danmukuPluginInstanceRef.current as any;
          if (inst.option) {
            const next = { ...inst.option };
            if ('mount' in next) next.mount = undefined;
            if ('danmuku' in next) next.danmuku = '';
            danmakuConfigRef.current = next;
          } else if (typeof inst.visible === 'boolean') {
            danmakuConfigRef.current.visible = inst.visible;
          }
        }
        // 销毁 HLS 实例
        if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
          artPlayerRef.current.video.hls.destroy();
        }

        // 销毁 ArtPlayer 实例
        artPlayerRef.current.destroy();
        artPlayerRef.current = null;

        console.log('播放器资源已清理');
      } catch (err) {
        console.warn('清理播放器资源时出错:', err);
        artPlayerRef.current = null;
      }
    }
  };

  // -----------------------------------------------------------------------------
  // 跳过片头片尾
  // -----------------------------------------------------------------------------

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: SkipConfig) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
        artPlayerRef.current.setting.update({
          name: '跳过片头片尾',
          html: '跳过片头片尾',
          switch: skipConfigRef.current.enable,
          onSwitch: function (item: any) {
            const newConfig = {
              ...skipConfigRef.current,
              enable: !item.switch,
            };
            handleSkipConfigChange(newConfig);
            return !item.switch;
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片头',
          html: '设置片头',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
          tooltip:
            skipConfigRef.current.intro_time === 0
              ? '设置片头时间'
              : `${formatTime(skipConfigRef.current.intro_time)}`,
          onClick: function () {
            const currentTime = artPlayerRef.current?.currentTime || 0;
            if (currentTime > 0) {
              const newConfig = {
                ...skipConfigRef.current,
                intro_time: currentTime,
              };
              handleSkipConfigChange(newConfig);
              return `${formatTime(currentTime)}`;
            }
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片尾',
          html: '设置片尾',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
          tooltip:
            skipConfigRef.current.outro_time >= 0
              ? '设置片尾时间'
              : `-${formatTime(-skipConfigRef.current.outro_time)}`,
          onClick: function () {
            const outroTime =
              -(
                artPlayerRef.current?.duration -
                artPlayerRef.current?.currentTime
              ) || 0;
            if (outroTime < 0) {
              const newConfig = {
                ...skipConfigRef.current,
                outro_time: outroTime,
              };
              handleSkipConfigChange(newConfig);
              return `-${formatTime(-outroTime)}`;
            }
          },
        });
      } else {
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          newConfig
        );
      }
      console.log('跳过片头片尾配置已保存:', newConfig);
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
    }
  };

  // 当集数索引变化时自动更新视频地址
  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 集数切换时同步 URL 中的 ep 参数（1 基），便于刷新/分享后仍停留在当前集（不刷新页面）
  useEffect(() => {
    if (loading || !detail || !detail.episodes) return;
    if (
      currentEpisodeIndex < 0 ||
      currentEpisodeIndex >= detail.episodes.length
    ) {
      return;
    }
    const ep = currentEpisodeIndex + 1;
    const newUrl = new URL(window.location.href);
    const currentEp = newUrl.searchParams.get('ep');
    if (currentEp === String(ep)) return;
    newUrl.searchParams.set('ep', String(ep));
    window.history.replaceState({}, '', newUrl.toString());
  }, [loading, detail, currentEpisodeIndex]);

  // -----------------------------------------------------------------------------
  // 初始化：拉取全部源并确定播放数据
  // -----------------------------------------------------------------------------

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    const fetchSourcesData = async (
      query: string,
      onResult?: (results: SearchResult[]) => void
    ): Promise<SearchResult[]> => {
      setSourceSearchLoading(true);
      setSourceSearchError('');

      const aggregatedResults: SearchResult[] = [];
      const targetYear = videoYearRef.current;

      try {
        // 发起流式搜索请求
        const timeoutSeconds = getRequestTimeout();
        const searchConcurrency = getSearchConcurrency();
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(
            query.trim()
          )}&timeout=${timeoutSeconds}&stream=1&concurrency=${searchConcurrency}`
        );
        if (!response.ok) throw new Error('搜索失败');

        const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
          response.body?.getReader();
        if (!reader) throw new Error('无法读取搜索流');

        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines: string[] = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                const data = JSON.parse(line) as {
                  pageResults?: SearchResult[];
                };
                if (data.pageResults) {
                  const filteredResults: SearchResult[] =
                    data.pageResults.filter((r: SearchResult) => {
                      const titleMatch = matchesFullSearchTitle(r.title, query);
                      const yearMatch = targetYear
                        ? r.year.toLowerCase() === targetYear.toLowerCase()
                        : true;
                      const typeMatch = searchType
                        ? (searchType === 'tv' && r.episodes.length > 1) ||
                          (searchType === 'movie' && r.episodes.length === 1)
                        : true;
                      return titleMatch && yearMatch && typeMatch;
                    });

                  if (filteredResults.length > 0) {
                    const newOnes = filteredResults.filter(
                      (r) =>
                        !aggregatedResults.some(
                          (item) => item.source === r.source && item.id === r.id
                        )
                    );

                    if (newOnes.length > 0) {
                      aggregatedResults.push(...newOnes);
                      setAvailableSources([...aggregatedResults]);
                      setSourceSearchLoading(false);
                      onResult?.(newOnes);
                    }
                  }
                }
              } catch (err) {
                console.warn('解析行 JSON 失败:', err);
              }
            }
          }
        }
        setSourceSearchLoading(false);

        return aggregatedResults;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        setAvailableSources([]);
        return [];
      }
    };

    /**
     * 初始化播放数据
     */
    function initDetail(detailData: SearchResult) {
      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(detailData.title || videoTitleRef.current);
      setVideoCover(detailData.poster);
      setVideoDoubanId(detailData.douban_id || 0);
      setDetail(detailData);

      // 传入的起始集数超出本源可用集数范围时，直接定位到最后一集（而非回到第一集）。
      // 以 URL 的 ep 为准，避免依赖可能尚未写入的 state / 播放记录。
      const requestedEp = Number(
        new URLSearchParams(window.location.search).get('ep')
      );
      const requestedIndex =
        Number.isInteger(requestedEp) && requestedEp >= 1
          ? requestedEp - 1
          : currentEpisodeIndex;
      if (
        detailData.episodes.length > 0 &&
        (requestedIndex < 0 || requestedIndex >= detailData.episodes.length)
      ) {
        setCurrentEpisodeIndex(
          requestedIndex < 0 ? 0 : detailData.episodes.length - 1
        );
      }

      // 规范 URL 参数
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      window.history.replaceState({}, '', newUrl.toString());

      setLoadingStage('ready');
      setLoadingMessage('✨ 准备就绪，即将开始播放...');
      setTimeout(() => setLoading(false), 500);
    }

    const initAll = async () => {
      if (!currentSource && !currentId && !videoTitle && !searchTitle) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
      setLoadingMessage(
        currentSource && currentId
          ? '🎬 正在获取视频详情...'
          : '🔍 正在搜索播放源...'
      );
      // 从 localStorage 读取是否启用优选播放源（避免状态延迟）
      const enablePreferBestSourceFromStorage = (() => {
        if (typeof window === 'undefined') return false;
        const saved = localStorage.getItem('enablePreferBestSource');
        if (saved === null) return false;
        try {
          return JSON.parse(saved);
        } catch {
          return false;
        }
      })();

      let detailData: SearchResult | null = null;
      let allResults: SearchResult[] = [];
      let hasInitialized = false; // 标记是否已经初始化过播放数据

      await fetchSourcesData(videoTitle || searchTitle, (newResults) => {
        allResults = [...allResults, ...newResults];

        // 如果还没确定 detailData，就尝试找目标源
        if (!detailData && currentSource && currentId) {
          const match = newResults.find(
            (item) => item.source === currentSource && item.id === currentId
          );
          if (match) {
            detailData = match;
            // 如果未启用优选，立即初始化播放数据
            if (!enablePreferBestSourceFromStorage) {
              initDetail(detailData);
              hasInitialized = true;
            }
            // 如果启用优选，则等待所有源收集完再决定是否优选
          }
        }
      });

      // 流式搜索结束：如果目标源没找到，就 fallback
      if (!detailData && allResults.length > 0) {
        detailData = allResults[0];
      }

      // 完全没结果
      if (!detailData) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      }

      if (enablePreferBestSourceFromStorage && allResults.length > 1) {
        setLoadingStage('preferring');
        setLoadingMessage('🚀 正在优选播放源...');
        try {
          const bestSource = await preferBestSource(allResults);
          // preferBestSource 内部已经排序了 availableSources 并设置了 precomputedVideoInfo
          detailData = bestSource;
        } catch (err) {
          console.error('优选播放源失败:', err);
          // 失败时使用原来的 detailData
        }
      }

      // 如果尚未初始化播放数据，则初始化
      if (!hasInitialized) {
        initDetail(detailData);
      }
    };

    initAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------------
  // 弹幕自动匹配
  // -----------------------------------------------------------------------------

  // 视频初始化后即可匹配弹幕
  useEffect(() => {
    if (isDanmakuPluginReady && isBlockAdChanged) {
      // 没有弹幕源时不要调用 load()：空地址会发起一次必然失败的请求
      const url = lastDanmakuUrlRef.current;
      if (url) {
        danmukuPluginInstanceRef.current.config({ danmuku: url });
        danmukuPluginInstanceRef.current.load().catch((e: unknown) => {
          console.error('加载弹幕失败:', e);
        });
      }
      setIsBlockAdChanged(false);
      return;
    }
    if (!autoDanmakuEnabled || !detail || !isDanmakuPluginReady) return;

    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // 获取尝试次数设置
    let retryCount = 3;
    try {
      const saved = localStorage.getItem('danmakuRetryCount');
      if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) retryCount = parsed;
      }
    } catch {
      // ignore
    }

    let attempt = 0;
    let success = false;

    const fetchDanmaku = async () => {
      setDanmakuLoadingKind('auto');
      setIsDanmakuLoading(true);
      while (!success && (retryCount === -1 || attempt <= retryCount)) {
        attempt++;
        try {
          const title = videoTitleRef.current;
          const currentEpisodeTitle =
            detail?.episodes_titles?.[currentEpisodeIndex];
          if (!currentEpisodeTitle) {
            throw new Error('无法获取当前集数标题（episodes_titles 无效）');
          }
          let epNum = extractEpisodeNumber(currentEpisodeTitle);
          if (!epNum) {
            epNum = currentEpisodeIndex + 1;
          }
          const platform = preferredDanmakuPlatform;
          const season = extractSeasonFromTitle(title);
          const fileName = `${title} S${season}E${epNum} @${platform}`;
          const matches = await matchAnime(fileName, abortController.signal);
          console.log(`自动弹幕匹配尝试第${attempt}次:`, matches);
          if (abortController.signal.aborted) return;
          if (matches.length > 0) {
            const m = matches[0];
            const animeOption = {
              animeId: m.animeId,
              animeTitle: m.animeTitle,
              type: m.type,
              typeDescription: m.typeDescription,
              episodeCount: 1,
              episodes: [
                {
                  episodeId: m.episodeId,
                  episodeTitle: m.episodeTitle,
                },
              ],
            };
            setSelectedDanmakuAnime(animeOption);
            setSelectedDanmakuSource(platform);
            success = true;
            break;
          } else {
            if (retryCount === -1 || attempt <= retryCount) {
              await new Promise((res) => setTimeout(res, 1500)); // 间隔1.5秒重试
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            console.log('自动加载弹幕已取消');
            return;
          }
          console.error(`自动弹幕匹配第${attempt}次失败:`, err);
          if (retryCount === -1 || attempt <= retryCount) {
            await new Promise((res) => setTimeout(res, 1500));
          }
        }
      }
      if (!success) {
        triggerGlobalError('自动加载弹幕失败，请手动选择弹幕源');
        // 全屏下页面级浮层不可见，播放器内再提示一次
        pushPlayerNotice(
          artPlayerRef.current,
          '自动加载弹幕失败，请手动选择弹幕源',
          { key: 'danmaku-auto-load-failed', durationMs: 8000 }
        );
        // 匹配失败也要恢复切集时隐藏的弹幕，避免一直不可见
        scheduleDanmakuVisibleRestore();
      }
      if (!abortController.signal.aborted) {
        setIsDanmakuLoading(false);
      }
    };
    fetchDanmaku();

    // 清理函数：当依赖项变化或组件卸载时中止请求
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [
    currentEpisodeIndex,
    autoDanmakuEnabled,
    isDanmakuPluginReady,
    preferredDanmakuPlatform,
  ]);

  // 自动加载弹幕期间在播放器右上角常驻提示，不顶掉其它提示
  useEffect(() => {
    const art = artPlayerRef.current;
    if (!art) return;

    if (!isDanmakuLoading) {
      clearPlayerNotices(art, 'danmaku-loading');
      return;
    }

    pushPlayerNotice(
      art,
      danmakuLoadingKind === 'manual'
        ? DANMAKU_MANUAL_LOADING_NOTICE_TEXT
        : DANMAKU_LOADING_NOTICE_TEXT,
      {
        key: 'danmaku-loading',
        durationMs: 0,
      }
    );

    return () => {
      clearPlayerNotices(art, 'danmaku-loading');
    };
  }, [isDanmakuLoading, danmakuLoadingKind, playerHost]);

  // -----------------------------------------------------------------------------
  // 播放记录与跳过配置恢复
  // -----------------------------------------------------------------------------

  // 播放记录处理
  useEffect(() => {
    // 仅在初次挂载时检查播放记录
    const initFromHistory = async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

        // URL 携带的起始集数（1 基，如追更页按标题匹配到的当前播放集数），优先采用
        const requestedEp = Number(searchParams.get('ep'));
        const requestedIndex =
          Number.isInteger(requestedEp) && requestedEp >= 1
            ? requestedEp - 1
            : -1;

        if (requestedIndex >= 0) {
          // 仅当本地记录与指定集数一致时才恢复播放进度，否则从该集开头播放
          const targetTime =
            record && record.index - 1 === requestedIndex
              ? record.play_time
              : 0;
          if (requestedIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(requestedIndex);
          }
          resumeTimeRef.current = targetTime;
          return;
        }

        if (record) {
          const targetIndex = record.index - 1;
          const targetTime = record.play_time;

          // 更新当前选集索引
          if (targetIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(targetIndex);
          }

          // 保存待恢复的播放进度，待播放器就绪后跳转
          resumeTimeRef.current = targetTime;
        }
      } catch (err) {
        console.error('读取播放记录失败:', err);
      }
    };

    initFromHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 跳过片头片尾配置处理
  useEffect(() => {
    // 仅在初次挂载时检查跳过片头片尾配置
    const initSkipConfig = async () => {
      if (!currentSource || !currentId) return;

      try {
        const config = await getSkipConfig(currentSource, currentId);
        if (config) {
          setSkipConfig(config);
        }
      } catch (err) {
        console.error('读取跳过片头片尾配置失败:', err);
      }
    };

    initSkipConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------------
  // 换源与剧集切换
  // -----------------------------------------------------------------------------

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string,
    options?: { auto?: boolean }
  ) => {
    try {
      // 用户手动换源时清空自动换源的"已试过"记录与次数；
      // 自动换源则保留，否则会在 A→B→A 之间反复横跳。
      if (!options?.auto) {
        triedSourcesRef.current.clear();
        autoSwitchCountRef.current = 0;
      }

      // 显示换源加载状态
      setVideoLoadingStage('sourceChanging');
      setIsVideoLoading(true);

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;
      console.log('换源前当前播放时间:', currentPlayTime);

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, skipConfigRef.current);
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        return;
      }

      // 尝试跳转到当前正在播放的集数
      let targetIndex = currentEpisodeIndex;

      // 集数越界时夹取：大于新源最大集数则跳转最后一集，负数则回到第一集
      if (!newDetail.episodes || newDetail.episodes.length === 0) {
        targetIndex = 0;
      } else if (targetIndex >= newDetail.episodes.length) {
        targetIndex = newDetail.episodes.length - 1;
      } else if (targetIndex < 0) {
        targetIndex = 0;
      }

      // 如果仍然是同一集数且播放进度有效，则在播放器就绪后恢复到原始进度
      if (targetIndex !== currentEpisodeIndex) {
        resumeTimeRef.current = 0;
      } else if (
        (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
        currentPlayTime > 1
      ) {
        resumeTimeRef.current = currentPlayTime;
      }

      // 更新URL参数（不刷新页面）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', newSource);
      newUrl.searchParams.set('id', newId);
      newUrl.searchParams.set('year', newDetail.year);
      window.history.replaceState({}, '', newUrl.toString());

      setVideoTitle(newDetail.title || newTitle);
      setVideoYear(newDetail.year);
      setVideoCover(newDetail.poster);
      setVideoDoubanId(newDetail.douban_id || 0);
      setCurrentSource(newSource);
      setCurrentId(newId);
      setDetail(newDetail);
      setCurrentEpisodeIndex(targetIndex);

      // 设置一个短暂的延时，确保DOM已更新
      setTimeout(() => {
        setIsVideoLoading(false);
      }, 100);
    } catch (err) {
      // 隐藏换源加载状态
      setIsVideoLoading(false);
      setError(err instanceof Error ? err.message : '换源失败');
    }
  };

  // 让 HLS 错误回调始终能拿到最新的 handleSourceChange
  // （播放器只在创建时注册一次错误回调，直接引用会拿到过期闭包）
  useEffect(() => {
    handleSourceChangeRef.current = handleSourceChange;
  });

  /**
   * 当前源被判定为"不可自动恢复"后，自动切到下一个候选源（P1-5）。
   *
   * 候选来自已搜索到的全部源（`availableSources`，已按优选评分排序），
   * 依次排除：本集已试过的、没有剧集列表的、集数短于当前集数的
   * （切过去只能回到第一集，体验反而更差）。
   *
   * 只读 ref，因此可以被注册在任意时刻的回调安全调用。
   */
  const autoSwitchSource = (reason: string) => {
    const currentKey = `${currentSourceRef.current}:${currentIdRef.current}`;
    triedSourcesRef.current.add(currentKey);

    if (autoSwitchCountRef.current >= MAX_AUTO_SOURCE_SWITCHES) {
      setError(
        `播放失败：${reason}。已自动尝试 ${autoSwitchCountRef.current} 个片源仍未成功，请手动切换片源`
      );
      return;
    }

    const episodeIndex = currentEpisodeIndexRef.current;
    const candidate = availableSourcesRef.current.find((item) => {
      const key = `${item.source}:${item.id}`;
      if (triedSourcesRef.current.has(key)) return false;
      if (!item.episodes || item.episodes.length === 0) return false;
      return item.episodes.length > episodeIndex;
    });

    if (!candidate) {
      setError(`播放失败：${reason}。已无可用备用片源，请手动选择`);
      return;
    }

    autoSwitchCountRef.current += 1;
    triedSourcesRef.current.add(`${candidate.source}:${candidate.id}`);

    const notice = `播放失败，已自动切换到「${candidate.source}」`;
    console.warn(
      `[auto-switch] ${reason} → ${candidate.source}:${candidate.id}`
    );
    try {
      pushPlayerNotice(artPlayerRef.current, notice, { key: 'auto-switch' });
    } catch {
      // ArtPlayer 可能已销毁
    }

    void handleSourceChangeRef.current?.(
      candidate.source,
      candidate.id,
      candidate.title || '',
      { auto: true }
    );
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, []);

  // 处理集数切换
  const handleEpisodeChange = async (episodeNumber: number) => {
    if (episodeNumber === currentEpisodeIndexRef.current) return;
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      isEpisodeSwitchingRef.current = true;
      hideDanmakuDuringEpisodeSwitch();
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current && artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        setCurrentTooltip('');
      }
      // 检查是否有历史播放记录
      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(
          currentSourceRef.current,
          currentIdRef.current
        );
        const record = allRecords[key];
        if (
          record &&
          record.index - 1 === episodeNumber &&
          record.play_time > 0
        ) {
          resumeTimeRef.current = record.play_time;
        } else {
          resumeTimeRef.current = 0;
        }
      } catch {
        resumeTimeRef.current = 0;
      }
      setCurrentEpisodeIndex(episodeNumber);
    }
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      isEpisodeSwitchingRef.current = true;
      hideDanmakuDuringEpisodeSwitch();
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        setCurrentTooltip('');
      }
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      isEpisodeSwitchingRef.current = true;
      hideDanmakuDuringEpisodeSwitch();
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        setCurrentTooltip('');
      }
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  // -----------------------------------------------------------------------------
  // 键盘快捷键
  // -----------------------------------------------------------------------------

  // 处理全局快捷键
  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    // 忽略输入框中的按键事件
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
      if (detailRef.current && currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        e.preventDefault();
      }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (d && idx < d.episodes.length - 1) {
        handleNextEpisode();
        e.preventDefault();
      }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
      if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
        artPlayerRef.current.currentTime -= 10;
        e.preventDefault();
      }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
      if (
        artPlayerRef.current &&
        artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
      ) {
        artPlayerRef.current.currentTime += 10;
        e.preventDefault();
      }
    }

    // 上箭头 = 音量+（提示由 ArtPlayer 内置 notice 负责）
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停
    // 用 e.code 判定，避免中文输入法等场景下 e.key 不是 ' ' 导致失效
    if (e.code === 'Space' || e.key === ' ') {
      if (artPlayerRef.current) {
        artPlayerRef.current.toggle();
        e.preventDefault();
      }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
      if (artPlayerRef.current) {
        artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
        e.preventDefault();
      }
    }
  };

  // -----------------------------------------------------------------------------
  // 播放进度保存
  // -----------------------------------------------------------------------------

  // 保存播放进度
  const saveCurrentPlayProgress = async () => {
    if (
      !artPlayerRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current ||
      !videoTitleRef.current ||
      !detailRef.current?.source_name
    ) {
      return;
    }

    const player = artPlayerRef.current;
    const currentTime = player.currentTime || 0;
    const duration = player.duration || 0;

    // 如果播放时间太短（少于5秒）或者视频时长无效，不保存
    if (currentTime < 1 || !duration) {
      return;
    }

    try {
      await savePlayRecord(currentSourceRef.current, currentIdRef.current, {
        title: videoTitleRef.current,
        source_name: detailRef.current?.source_name || '',
        year: detailRef.current?.year,
        cover: detailRef.current?.poster || '',
        index: currentEpisodeIndexRef.current + 1, // 转换为1基索引
        total_episodes: detailRef.current?.episodes.length || 1,
        play_time: Math.floor(currentTime),
        total_time: Math.floor(duration),
        save_time: Date.now(),
        search_title: searchTitle,
      });

      lastSaveTimeRef.current = Date.now();
      console.log('播放进度已保存:', {
        title: videoTitleRef.current,
        episode: currentEpisodeIndexRef.current + 1,
        year: detailRef.current?.year,
        progress: `${Math.floor(currentTime)}/${Math.floor(duration)}`,
      });
    } catch (err) {
      console.error('保存播放进度失败:', err);
    }
  };

  useEffect(() => {
    // 页面即将卸载时保存播放进度和清理资源
    const handleBeforeUnload = () => {
      saveCurrentPlayProgress();
      releaseWakeLock();
      cleanupPlayer();
    };

    // 页面可见性变化时保存播放进度和释放 Wake Lock
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentPlayProgress();
        releaseWakeLock();
      } else if (document.visibilityState === 'visible') {
        // 页面重新可见时，如果正在播放则重新请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      }
    };

    // 添加事件监听器
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // 清理事件监听器
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentEpisodeIndex, detail, artPlayerRef.current]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, []);

  // -----------------------------------------------------------------------------
  // 收藏与追更
  // -----------------------------------------------------------------------------

  const { favorited, following, handleToggleFavorite, handleToggleFollowing } =
    useVideoActions({
      source: currentSource,
      id: currentId,
      sourceRef: currentSourceRef,
      idRef: currentIdRef,
      titleRef: videoTitleRef,
      detailRef: detailRef,
      episodeIndexRef: currentEpisodeIndexRef,
      searchTitle,
    });

  // -----------------------------------------------------------------------------
  // 动态加载播放器库
  // -----------------------------------------------------------------------------

  const artLibRef = useRef<any>(null);
  const hlsLibRef = useRef<any>(null);
  const danmukuPluginRef = useRef<any>(null);
  const [libsReady, setLibsReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [
          { default: Art },
          { default: Hls },
          { default: artplayerPluginDanmuku },
        ] = await Promise.all([
          import('artplayer'),
          import('hls.js'),
          import('artplayer-plugin-danmuku'),
        ]);
        if (!mounted) return;
        artLibRef.current = Art;
        hlsLibRef.current = Hls;
        danmukuPluginRef.current = wrapArtplayerPluginDanmuku(
          artplayerPluginDanmuku
        );
        setLibsReady(true);
      } catch (err) {
        console.error('加载播放器库失败:', err);
        setLibsReady(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // -----------------------------------------------------------------------------
  // ArtPlayer 生命周期
  // -----------------------------------------------------------------------------

  useEffect(() => {
    const Artplayer = artLibRef.current;
    const Hls = hlsLibRef.current;

    // 选集索引越界时夹取：传入的起始集数大于当前播放源最大集数时播放最后一集，
    // 负数则回到第一集。需在就绪/视频地址判断之前修正，避免越界集数导致无法生成视频地址。
    if (
      detail &&
      detail.episodes &&
      detail.episodes.length > 0 &&
      currentEpisodeIndex !== null &&
      (currentEpisodeIndex < 0 || currentEpisodeIndex >= detail.episodes.length)
    ) {
      setCurrentEpisodeIndex(
        currentEpisodeIndex < 0 ? 0 : detail.episodes.length - 1
      );
      return;
    }

    if (
      !libsReady ||
      !Artplayer ||
      !Hls ||
      !videoUrl ||
      loading ||
      currentEpisodeIndex === null ||
      !artRef.current
    ) {
      return;
    }

    // 确保选集索引有效（仅在剧集列表为空等异常时触发）
    if (
      !detail ||
      !detail.episodes ||
      detail.episodes.length === 0 ||
      currentEpisodeIndex >= detail.episodes.length ||
      currentEpisodeIndex < 0
    ) {
      setError(`选集索引无效，当前共 ${totalEpisodes} 集`);
      return;
    }

    if (!videoUrl) {
      setError('视频地址无效');
      return;
    }
    console.log(videoUrl);

    // 检测是否为WebKit浏览器
    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 切集时无论浏览器类型都优先复用实例，避免销毁播放器
    if (artPlayerRef.current && isEpisodeSwitchingRef.current) {
      artPlayerRef.current.switch = videoUrl;
      artPlayerRef.current.title = `${videoTitle} - 第${
        currentEpisodeIndex + 1
      }集`;
      artPlayerRef.current.poster = processImageUrl(videoCover);
      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
      isEpisodeSwitchingRef.current = false;
      return;
    }

    // 非WebKit浏览器且播放器已存在，使用switch方法切换
    if (!isWebkit && artPlayerRef.current) {
      artPlayerRef.current.switch = videoUrl;
      artPlayerRef.current.title = `${videoTitle} - 第${
        currentEpisodeIndex + 1
      }集`;
      artPlayerRef.current.poster = processImageUrl(videoCover);
      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
      return;
    }

    // WebKit浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      cleanupPlayer();
    }

    try {
      // 创建新的播放器实例
      Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
      Artplayer.USE_RAF = true;

      // 在这里定义自定义 Loader，确保 Hls 已就绪。
      // blockAd 反映当前开关（切换时会重建播放器），useProxy 需与预取器保持一致。
      const CustomHlsJsLoader = createCustomHlsLoader(Hls, {
        blockAd: blockAdEnabledRef.current,
        useProxy: loadCacheSettings().useProxy,
      });

      /**
       * 刷新「视频缓存」设置项的进度提示。
       *
       * ⚠️ 这里必须走 DOM setter，不能用 `setting.update()`：
       * 本函数由预取回调按**分片频率**调用（一集几百次），而 `update()`
       * 内部会无条件 `render()` 把设置面板弹回根面板，导致用户刚点进
       * 「画质」子面板就被踢出来，需要连点很多次。详见 `artplayer-setting.ts`。
       */
      let lastCacheTooltip = '';
      const updateCacheTooltip = (text: string, switchState?: boolean) => {
        const art = artPlayerRef.current;
        if (!art) return;
        if (text !== lastCacheTooltip) {
          setSettingTooltip(art, CACHE_SETTING_NAME, text);
          lastCacheTooltip = text;
        }
        if (switchState !== undefined) {
          setSettingSwitch(art, CACHE_SETTING_NAME, switchState);
        }
      };

      /**
       * 按当前档位码率重算内存缓冲计划。
       *
       * 码率变了，同样的字节预算能装多少秒就变了：固定 90MB 在 8Mbps 下只有
       * 约 90s，`maxBufferLength: 120` 永远达不成。这里在播放列表解析完成、
       * ABR 换档、缓存开关变化时都重算一次，保证两个阈值始终自洽。
       */
      const syncHlsBufferBudget = (
        target?: any,
        cacheEnabled?: boolean
      ): void => {
        const hls = target || artPlayerRef.current?.video?.hls;
        if (!hls?.config) return;
        const levelIndex =
          Number.isInteger(hls.currentLevel) && hls.currentLevel >= 0
            ? hls.currentLevel
            : Number.isInteger(hls.loadLevel) && hls.loadLevel >= 0
            ? hls.loadLevel
            : 0;
        const level = Array.isArray(hls.levels) ? hls.levels[levelIndex] : null;
        const plan = planCurrentHlsBuffer({
          cacheEnabled: cacheEnabled ?? loadCacheSettings().enabled,
          levelBitrate: Number(level?.bitrate) || null,
        });
        // MSE 配额已经报过警：换档时不要把运行时收缩过的值又放宽回去
        if (hls.__moontvQuotaDegraded) {
          plan.maxBufferLength = Math.min(
            plan.maxBufferLength,
            Number(hls.config.maxBufferLength) || plan.maxBufferLength
          );
          plan.maxMaxBufferLength = Math.min(
            plan.maxMaxBufferLength,
            Number(hls.config.maxMaxBufferLength) || plan.maxMaxBufferLength
          );
          plan.backBufferLength = Math.min(
            plan.backBufferLength,
            Number(hls.config.backBufferLength) || plan.backBufferLength
          );
          plan.maxBufferSize = Math.min(
            plan.maxBufferSize,
            Number(hls.config.maxBufferSize) || plan.maxBufferSize
          );
        }
        applyHlsBufferPlan(hls, plan);
      };

      let cacheBandwidthThrottled = false;
      let lastBufferCheckAt = 0;
      const setCacheBandwidthThrottled = (value: boolean) => {
        cacheBandwidthThrottled = value;
        prefetcherRef.current.setThrottled(value);
        getNextEpisodePrefetcher().setThrottled(value);
      };
      const syncCacheBandwidth = (force = false) => {
        const video = artPlayerRef.current?.video;
        if (!video) return;
        const now = Date.now();
        if (!force && now - lastBufferCheckAt < 1_000) return;
        lastBufferCheckAt = now;
        setCacheBandwidthThrottled(
          shouldThrottlePrefetch(video, cacheBandwidthThrottled)
        );
      };

      /**
       * 启动 / 续跑前向预缓存。
       * ensure 是幂等的：窗口仍然够用时直接返回，可以放心高频调用。
       *
       * `preferredHeight` 必须一起传：多码率源里预取器默认取最高带宽，
       * 用户把画质切到低档后缓存键就对不上了（P1-6 与缓存的耦合点）。
       *
       * `episodeKey` 从 ref 实时取——播放器可能跨集复用，闭包里的集数会过期。
       */
      const ensurePrefetch = (
        m3u8Url: string,
        currentTime: number,
        horizonSeconds?: number
      ) => {
        if (artPlayerRef.current?.video?.seeking) return;
        const clearing = cacheClearPromiseRef.current;
        if (clearing) {
          const episodeIndex = currentEpisodeIndexRef.current;
          void clearing.then(() => {
            if (
              episodeIndex === currentEpisodeIndexRef.current &&
              m3u8Url === currentVideoUrlRef.current &&
              artPlayerRef.current
            ) {
              ensurePrefetch(m3u8Url, currentTime, horizonSeconds);
            }
          });
          return;
        }
        prefetcherRef.current.ensure({
          m3u8Url,
          currentTime,
          lookBehindSeconds: 0,
          skipIntroSeconds: skipConfigRef.current.enable
            ? Math.max(0, skipConfigRef.current.intro_time)
            : 0,
          skipOutroSeconds: skipConfigRef.current.enable
            ? Math.max(0, -skipConfigRef.current.outro_time)
            : 0,
          title: videoTitleRef.current || '未知影片',
          source:
            detailRef.current?.source_name ||
            currentSourceRef.current ||
            '未知来源',
          episodeKey: `${currentSourceRef.current}:${currentIdRef.current}:${currentEpisodeIndexRef.current}`,
          preferredHeight: preferredHeightRef.current,
          // 与播放器的「去广告」保持一致，否则预取时间轴会多出一段广告时长
          dropAds: blockAdEnabledRef.current,
          ...(horizonSeconds === undefined ? {} : { horizonSeconds }),
          onProgress: (stats) => {
            const probe = getSegmentProbe();
            const probed = probe.hits + probe.misses;
            updateCacheTooltip(
              buildCacheTooltip(stats, probed > 0 ? probe.hitRate : null)
            );

            // 首次进入缓存队列时提示一次「已开启」；手动开启时已在开关处提示。
            // 播放器未就绪（首帧 ensure 可能早于实例赋值）时不消耗这次机会。
            if (
              !cacheEnabledNoticeShownRef.current &&
              (stats.state === 'parsing' || stats.state === 'running')
            ) {
              const art = artPlayerRef.current;
              if (art?.template?.$player) {
                cacheEnabledNoticeShownRef.current = true;
                pushPlayerNotice(art, '已开启视频缓存', {
                  key: 'cache-state',
                });
              }
            }

            // 缓存停止（error / disabled）的原因同步到右上角提示；
            // 同一原因只提示一次，避免 ensure 高频调用时刷屏。
            let stopMessage: string | null = null;
            if (stats.state === 'error') {
              stopMessage = `视频缓存已终止：${stats.message || '未知原因'}`;
            } else if (
              stats.state === 'disabled' &&
              stats.message !== '已关闭视频缓存'
            ) {
              // 功能处于关闭状态是默认情况，不提示；弱网 / 省流量跳过才提示
              stopMessage = stats.message || null;
            }

            if (stopMessage) {
              const noticeKey = `${stats.state}:${stats.message}`;
              if (cacheNoticeRef.current !== noticeKey) {
                cacheNoticeRef.current = noticeKey;
                pushPlayerNotice(artPlayerRef.current, stopMessage, {
                  key: 'cache-state',
                });
              }
            } else {
              // 新一轮任务开始后允许再次提示同样的停止原因
              cacheNoticeRef.current = null;
            }

            // 当前集的前向视野已经铺满 → 顺手把下一集的前几分钟也预热掉，
            // 这样用户点"下一集"时首屏基本是命中缓存而不是现拉网络。
            if (stats.state === 'done') warmupNextEpisode();
          },
        });
        syncCacheBandwidth(true);
      };

      /**
       * 预热下一集（落地路线第 3 步）。
       *
       * 走独立的预取器实例，因此**不会**打断当前集的队列。
       * 只在当前集队列跑到 `done` 时触发一次（由 `nextWarmupKeyRef` 去重），
       * 并且随集数/画质变化自动失效。
       *
       * 并发取用户档位的一半（`getWarmupConcurrency`）：预热是二等消费者，
       * 播放器 seek / 换档仍要抢带宽；共享下载额度保证两轮之和仍受档位封顶。
       */
      const warmupNextEpisode = () => {
        if (cacheClearPromiseRef.current) return;
        const settings = loadCacheSettings();
        if (!settings.enabled) return;

        const data = detailRef.current;
        const episodes = data?.episodes;
        if (!episodes || episodes.length === 0) return;

        const nextIndex = currentEpisodeIndexRef.current + 1;
        if (nextIndex >= episodes.length) return;

        const nextUrl = episodes[nextIndex];
        if (!nextUrl) return;

        const preferred = preferredHeightRef.current;
        // 画质档位也是预热键的一部分：换了档位，预热过的分片 URL 就不同了
        const skip = skipConfigRef.current;
        const skipIntroSeconds = skip.enable ? Math.max(0, skip.intro_time) : 0;
        const skipOutroSeconds = skip.enable
          ? Math.max(0, -skip.outro_time)
          : 0;
        const key = `${currentSourceRef.current}:${
          currentIdRef.current
        }:${nextIndex}:${
          preferred ?? 'auto'
        }:${skipIntroSeconds}:${skipOutroSeconds}:${
          blockAdEnabledRef.current ? 'noads' : 'ads'
        }`;
        if (nextWarmupKeyRef.current === key) return;
        nextWarmupKeyRef.current = key;

        getNextEpisodePrefetcher().ensure({
          m3u8Url: nextUrl,
          currentTime: 0,
          skipIntroSeconds,
          skipOutroSeconds,
          title: videoTitleRef.current || '未知影片',
          source:
            detailRef.current?.source_name ||
            currentSourceRef.current ||
            '未知来源',
          episodeKey: `${currentSourceRef.current}:${currentIdRef.current}:${nextIndex}`,
          preferredHeight: preferred,
          dropAds: blockAdEnabledRef.current,
          horizonSeconds: NEXT_EPISODE_HORIZON_SECONDS,
          useProxy: settings.useProxy,
          concurrency: getWarmupConcurrency(settings.concurrency),
        });
        syncCacheBandwidth(true);
      };

      /**
       * 供播放器事件监听器使用的入口。
       *
       * 监听器闭包里的 `videoUrl` 是创建播放器那一刻的快照，切集后已过期，
       * 因此以 ref 里的实时地址为准。
       */
      const ensurePrefetchCurrent = (
        currentTime: number,
        horizonSeconds?: number
      ) => {
        const live = currentVideoUrlRef.current;
        if (!live) return;
        ensurePrefetch(live, currentTime, horizonSeconds);
      };

      const cacheModeLabels = {
        low: '低档',
        medium: '中档',
        high: '高档',
      };
      const restartCacheQueue = () => {
        prefetcherRef.current.stop();
        getNextEpisodePrefetcher().stop();
        nextWarmupKeyRef.current = null;
        if (loadCacheSettings().enabled) {
          ensurePrefetchCurrent(artPlayerRef.current?.currentTime || 0);
        }
      };
      restartPrefetchForSkipRef.current = () => {
        prefetcherRef.current.stop(true);
        getNextEpisodePrefetcher().stop();
        nextWarmupKeyRef.current = null;
        if (loadCacheSettings().enabled) {
          ensurePrefetchCurrent(artPlayerRef.current?.currentTime || 0);
        }
      };

      /** 刷新「画质」设置项的 tooltip（同样走 DOM setter，不打断面板层级） */
      const updateQualityTooltip = (text: string) => {
        const art = artPlayerRef.current;
        if (!art) return;
        setSettingTooltip(art, QUALITY_SETTING_NAME, text);
      };

      /**
       * 把 hls.js 的码率档位同步到「画质」设置项（P1-6）。
       *
       * 必须等 MANIFEST_PARSED：在那之前 `hls.levels` 是空的。
       * 同时把本地记住的档位重新应用，使换集/换源后用户的选择得以延续。
       *
       * 这里是少数**必须**调用 `setting.update()` 的地方（要替换 selector 数组），
       * 所以用 `updateSettingPreservingPanel` 把面板层级恢复回来，避免顺手
       * 把正在看子面板的用户弹回根面板。
       */
      const syncQualitySetting = (hls: any) => {
        const levels = Array.isArray(hls.levels) ? hls.levels : [];
        const preferred = preferredHeightRef.current;
        const art = artPlayerRef.current;

        // 单档位源：没有"可切换的画质"，也没有"可降的档"。
        // 此时仍摆出「自动 / 最高画质 / 唯一档位」三项纯属误导，所以把设置项
        // 退化成只读一行（✓ + 当前清晰度）——不替换成空 selector，否则
        // ArtPlayer 会渲染出一个 0 项的子面板。
        if (levels.length <= 1) {
          if (art) {
            updateSettingPreservingPanel(art, {
              name: QUALITY_SETTING_NAME,
              tooltip:
                levels.length === 1 ? describeLevel(levels[0]) : '未提供',
              selector: undefined,
            });
          }
          // 唯一一档由 ABR 直接锁死，不需要写 currentLevel（那会关掉 autoLevel）
          return;
        }

        const matchedIndex =
          preferred === null ? AUTO_LEVEL : pickLevelIndex(levels, preferred);

        if (art) {
          updateSettingPreservingPanel(art, {
            name: QUALITY_SETTING_NAME,
            tooltip: describeQualityPreference(levels, preferred),
            selector: buildQualityOptions(levels, preferred),
          });
        }

        // 记住的档位在本次播放列表里存在时直接套用，否则交给 ABR 自动选择
        if (matchedIndex >= 0) {
          try {
            hls.currentLevel = matchedIndex;
          } catch (_) {
            // 忽略：极端情况下 levels 正在重建
          }
        }
      };

      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: videoUrl,
        poster: videoCover,
        volume: 0.7,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: true,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: true,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        theme: '#22c55e',
        lang: 'zh-cn',
        // 关闭 Artplayer 内置快捷键：空格/方向键/F 已由全局 handleKeyboardShortcuts 接管。
        // 若同时开启，播放器获得焦点后两个监听器都会执行，空格会被 toggle 两次
        // （播放→暂停→播放），表现为「空格无法控制播放」。
        hotkey: false,
        // 长按倍速由 mobile-gestures 统一接管，避免与内置 fastForward 叠加
        fastForward: false,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        plugins: [danmukuPluginRef.current(danmakuConfigRef.current)],
        // HLS 支持配置
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
            if (!Hls) {
              console.error('HLS.js 未加载');
              return;
            }

            if (video.hls) {
              video.hls.destroy();
            }
            /**
             * 内存缓冲预算按「当前档位码率」动态计算（见 planHlsBuffer）。
             *
             * 旧实现固定 maxBufferSize = 90MB，同时要求 maxBufferLength = 120s。
             * hls.js 实际取 min(120s, 90MB / 码率)：8Mbps 时只有约 90s，
             * 120s 永远达不成，两套阈值互相打架；配额一紧就抛 bufferFullError，
             * 进而走 flush 整段缓冲的分支（画面回退 + 音画错位）。
             *
             * 现在由码率反推字节预算：装得下就放大到刚好覆盖目标时长（上限为
             * 设备 MSE 预算），装不下就把时长目标回压到能兑现的值。播放列表
             * 解析完成和每次换档后会重新计算。
             */
            const cacheEnabled = loadCacheSettings().enabled;
            const bufferPlan = planCurrentHlsBuffer({ cacheEnabled });
            const hls = new Hls({
              debug: false, // 关闭日志
              // 分片处理移到 Worker；自定义 loader 仍在主线程读取缓存。
              enableWorker: true,

              // VOD 场景关闭低延迟模式：LL-HLS 会主动压缩前向缓冲，与"多缓存"目标相悖
              lowLatencyMode: false,

              /* 缓冲/内存相关 */
              // 真正的"缓存后面的"由 VideoPrefetcher 写入 Cache Storage 承担，
              // 这里只需一个适度的内存缓冲，避免移动端内存压力。
              maxBufferLength: bufferPlan.maxBufferLength, // 前向缓冲目标（按码率兑现）
              maxMaxBufferLength: bufferPlan.maxMaxBufferLength,
              backBufferLength: bufferPlan.backBufferLength, // 已播放内容的保留时长
              maxBufferSize: bufferPlan.maxBufferSize, // 字节预算，与目标时长自洽

              /* 自定义 loader：去广告 + 缓存优先 */
              loader: CustomHlsJsLoader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            ensureVideoSource(video, url);

            // 启动前向预缓存。注意：这里只读取一次当前时间用于计算窗口起点，
            // 之后的预取循环不会再读取任何播放状态，因此暂停后仍会继续缓存。
            ensurePrefetch(url, video.currentTime || 0);

            // ---- P1-5：带指数退避 + 重试上限 + 自动换源的错误恢复 ----
            // 每个 HLS 实例配一个状态机；换源/重建时旧实例在 cleanupPlayer 里销毁。
            const recovery = new PlaybackRecovery();
            recoveryRef.current?.dispose();
            recoveryRef.current = recovery;

            // 新实例 = 新的 ABR 环境：清掉上一集的卡顿记录与降档上限，
            // 否则换源后 ABR 会被上一个源的网络状况压着
            stallTimesRef.current = [];
            downshiftNoticeRef.current = null;
            // seek / 换档的时间戳同样要清空：新实例挂载时的那次 buffering
            // 属于初始化，不该被当成网络卡顿
            lastSeekAtRef.current = 0;
            lastLevelSwitchAtRef.current = Date.now();

            // 播放列表解析成功：建立画质档位，并确认链路可用
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
              recovery.markHealthy();
              syncQualitySetting(hls);
              // 拿到 levels 的 BANDWIDTH 后才能按真实码率换算字节预算
              syncHlsBufferBudget(hls);
            });

            hls.on(
              Hls.Events.LEVEL_SWITCHED,
              function (_event: any, data: any) {
                // 换档会 flush 缓冲重新下载，这段时间的停顿不算网络卡顿
                lastLevelSwitchAtRef.current = Date.now();
                const level = hls.levels?.[data?.level];
                // 单档位源没有"自动/手动"之别，直接显示该档清晰度即可
                const singleLevel =
                  Array.isArray(hls.levels) && hls.levels.length <= 1;
                updateQualityTooltip(
                  hls.autoLevelEnabled && !singleLevel
                    ? `自动${level ? ` · ${describeLevel(level)}` : ''}`
                    : describeLevel(level)
                );
                // 换档后码率变了：字节预算与时长目标要重新对齐
                syncHlsBufferBudget(hls);

                // 暂停状态下切换档位时，浏览器不会自动重绘新解码的帧，
                // 画面会停在旧档位，用户容易误判成"切了没反应"。
                // 用一次 10ms 的微 seek 强制刷新——偏移落在同一分片内，
                // 不会触发重新加载。
                const media = artPlayerRef.current?.video;
                if (media?.paused && media.currentTime > 0.05) {
                  try {
                    media.currentTime = media.currentTime - 0.01;
                  } catch {
                    // 忽略：极端情况下媒体尚未就绪
                  }
                }
              }
            );

            // 分片加载成功（含命中本项目的片段缓存）即视为链路仍在推进
            hls.on(Hls.Events.FRAG_LOADED, function () {
              recovery.markHealthy();
            });

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              if (!data?.fatal) {
                /**
                 * MSE 写入配额已满（SourceBuffer append 抛 QuotaExceededError）。
                 *
                 * hls.js 自带的自救（`reduceMaxBufferLength`）只收缩「时长」上限，
                 * 不会收缩「字节」上限。命中缓存时分片是"秒到"的，几秒内就能把
                 * 90MB 前向缓冲写满；反复触发后，只要当前位置恰好不在已缓冲区间，
                 * hls.js 会 flush 整个 main buffer 来恢复——用户看到的就是画面
                 * 回退、音画错位。这里直接按比例收紧字节与时长上限，从源头避免
                 * 再次写爆（缓存可以秒读，牺牲一点内存缓冲几乎不影响体验）。
                 */
                if (data?.details === 'bufferFullError') {
                  // 记录降级，避免后续换档时 syncHlsBufferBudget 把上限又放宽
                  hls.__moontvQuotaDegraded = true;
                  const config = hls.config;
                  // 连续触发说明上一次仍不够：按比例继续收缩，直到 32MB / 30s
                  config.maxBufferSize = Math.max(
                    32 * 1024 * 1024,
                    Math.floor(
                      (Number(config.maxBufferSize) || 64 * 1024 * 1024) * 0.75
                    )
                  );
                  config.maxBufferLength = Math.max(
                    30,
                    Math.floor((Number(config.maxBufferLength) || 60) * 0.75)
                  );
                  config.maxMaxBufferLength = Math.max(
                    config.maxBufferLength * 2,
                    Math.min(
                      Number(config.maxMaxBufferLength) || 300,
                      config.maxBufferLength * 2
                    )
                  );
                  // 回看缓冲同样占用 MSE 配额，先收紧让下一次 trim 立刻释放空间
                  if (Number(config.backBufferLength) > 20) {
                    config.backBufferLength = 20;
                  }
                  console.info(
                    `MSE 缓冲已满，前向缓冲收紧为 ${Math.round(
                      config.maxBufferSize / 1024 / 1024
                    )}MB / ${config.maxBufferLength}s，回看 ${
                      config.backBufferLength
                    }s`
                  );
                }
                // 非致命错误 hls.js 会自行重试，这里只留痕便于排障
                console.warn(
                  'HLS 非致命错误:',
                  describeHlsError(data?.type, data?.details),
                  data?.details
                );
                return;
              }

              const decision = recovery.onFatal(data.type, data.details);
              switch (decision.action) {
                case 'retry': {
                  // 指数退避，避免源站挂掉时形成重试风暴
                  console.log(
                    `HLS 网络错误（${decision.reason}），${decision.delayMs}ms 后第 ${decision.attempt} 次重试`
                  );
                  recovery.schedule(decision.delayMs, () => hls.startLoad());
                  break;
                }
                case 'recover-media': {
                  console.log(
                    `HLS 媒体错误（${decision.reason}），第 ${decision.attempt} 次恢复`
                  );
                  if (decision.swapAudio) {
                    hls.swapAudioCodec();
                  }
                  hls.recoverMediaError();
                  break;
                }
                case 'switch-source': {
                  console.error('HLS 错误无法恢复，准备换源:', decision.reason);
                  recovery.dispose();
                  hls.destroy();
                  autoSwitchSource(decision.reason);
                  break;
                }
                default:
                  break;
              }
            });
          },
        },
        icons: {
          loading:
            '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cGF0aCBkPSJNMjUuMjUxIDYuNDYxYy0xMC4zMTggMC0xOC42ODMgOC4zNjUtMTguNjgzIDE4LjY4M2g0LjA2OGMwLTguMDcgNi41NDUtMTQuNjE1IDE0LjYxNS0xNC42MTVWNi40NjF6IiBmaWxsPSIjMDA5Njg4Ij48YW5pbWF0ZVRyYW5zZm9ybSBhdHRyaWJ1dGVOYW1lPSJ0cmFuc2Zvcm0iIGF0dHJpYnV0ZVR5cGU9IlhNTCIgZHVyPSIxcyIgZnJvbT0iMCAyNSAyNSIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiIHRvPSIzNjAgMjUgMjUiIHR5cGU9InJvdGF0ZSIvPjwvcGF0aD48L3N2Zz4=">',
        },
        settings: [
          {
            html: '去广告',
            icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
            tooltip: blockAdEnabled ? '已开启 · 自动剔除广告分片' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad_v2', String(newVal));
                if (artPlayerRef.current) {
                  resumeTimeRef.current = artPlayerRef.current.currentTime;
                  if (
                    artPlayerRef.current.video &&
                    artPlayerRef.current.video.hls
                  ) {
                    artPlayerRef.current.video.hls.destroy();
                  }
                  artPlayerRef.current.destroy();
                  artPlayerRef.current = null;
                }
                setBlockAdEnabled(newVal);
                setIsDanmakuPluginReady(false);
                setIsBlockAdChanged(true);
              } catch (_) {
                // ignore
              }
              return newVal ? '已开启 · 自动剔除广告分片' : '已关闭';
            },
          },
          {
            name: '跳过片头片尾',
            html: '跳过片头片尾',
            switch: skipConfigRef.current.enable,
            onSwitch: function (item: any) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              handleSkipConfigChange(newConfig);
              return !item.switch;
            },
          },
          {
            html: '删除跳过配置',
            onClick: function () {
              handleSkipConfigChange({
                enable: false,
                intro_time: 0,
                outro_time: 0,
              });
              return '';
            },
          },
          {
            name: '设置片头',
            html: '设置片头',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? '设置片头时间'
                : `${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              const currentTime = artPlayerRef.current?.currentTime || 0;
              if (currentTime > 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  intro_time: currentTime,
                };
                handleSkipConfigChange(newConfig);
                return `${formatTime(currentTime)}`;
              }
            },
          },
          {
            name: '设置片尾',
            html: '设置片尾',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? '设置片尾时间'
                : `-${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              const outroTime =
                -(
                  artPlayerRef.current?.duration -
                  artPlayerRef.current?.currentTime
                ) || 0;
              if (outroTime < 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  outro_time: outroTime,
                };
                handleSkipConfigChange(newConfig);
                return `-${formatTime(-outroTime)}`;
              }
            },
          },
          {
            name: '弹幕源',
            html: '弹幕源',
            tooltip: currentTooltip || '未选择',
            onClick: function () {
              setShowDanmakuSelector(true);
            },
          },
          {
            name: '弹幕密度',
            html: '弹幕密度',
            tooltip: DANMAKU_DENSITY_LABELS[getDanmakuDensity()],
            selector: (['sparse', 'normal', 'dense'] as const).map(
              (density) => ({
                html: DANMAKU_DENSITY_LABELS[density],
                value: density,
                default: density === getDanmakuDensity(),
              })
            ),
            onSelect: function (item: any) {
              // 密度门控在弹幕上屏前读取当前挡位，切换后立即生效，
              // 无需重新加载弹幕源
              const density = setDanmakuDensity(item.value);
              saveDanmakuSettings({ density });
              return DANMAKU_DENSITY_LABELS[density];
            },
          },
          {
            // 画质切换（P1-6）。档位列表在 MANIFEST_PARSED 后由
            // syncQualitySetting() 动态写入。
            // 这里**不预设 selector**：否则播放列表解析完成前会短暂出现一个
            // 只有「自动」一项的子面板，而单档位源根本不支持切换画质。
            // （item 的 kind 由 ArtPlayer 按 selector/switch/onClick 推断，
            // 先只有 onSelect 就渲染成不可展开的普通行，等价于"只读"。）
            name: QUALITY_SETTING_NAME,
            html: QUALITY_SETTING_NAME,
            tooltip: '自动',
            onSelect: function (item: any) {
              const value = Number(item.value);
              const hls = artPlayerRef.current?.video?.hls;
              const levels: any[] = Array.isArray(hls?.levels)
                ? hls.levels
                : [];

              const isAuto = value === AUTO_LEVEL || Number.isNaN(value);
              const isMax = value === MAX_LEVEL;

              let nextLevel = AUTO_LEVEL;
              let preferred: number | null = null;

              if (isMax) {
                // 「最高画质」落到本视频实际存在的最高档。
                // 记忆用 MAX_QUALITY_HEIGHT(8K) 作哨兵：换到没有 8K 的剧集时，
                // pickLevelIndex 会落到该剧最高档，语义自动成立。
                const highest = pickHighestLevelIndex(levels);
                if (highest >= 0) {
                  nextLevel = highest;
                  preferred = MAX_QUALITY_HEIGHT;
                }
              } else if (!isAuto && levels[value]) {
                nextLevel = value;
                // 记的是「有效高度」：源站 master 常缺 RESOLUTION，
                // 那时只能按码率推断。用 `level.height` 会让偏好退化成
                // "自动"，连带把预取档位与跨集记忆一起弄丢。
                preferred = resolveLevelHeight(levels[value]) || null;
              }

              try {
                if (hls) {
                  hls.currentLevel = nextLevel;
                  // 用户手动选了档位 = 明确表达意愿，清掉自动降档的上限，
                  // 否则 ABR 会被之前的卡顿记录一直压着达不到所选档位
                  hls.autoLevelCapping = -1;
                }
              } catch {
                // 忽略：极端情况下 levels 正在重建
              }
              stallTimesRef.current = [];
              downshiftNoticeRef.current = null;

              // 记忆的是"画面高度"而非档位下标：换集/换源后档位数量与顺序都会变，
              // 记下标会指向错误的档位。
              preferredHeightRef.current = preferred;
              savePreferredQualityHeight(preferred);
              updateQualityTooltip(
                preferred === null
                  ? '自动'
                  : describeQualityPreference(levels, preferred)
              );

              // 档位变了，已缓存的分片属于旧档位，按新档位重排队列
              ensurePrefetchCurrent(artPlayerRef.current?.currentTime || 0);
              return item.html;
            },
          },
          {
            name: '视频缓存',
            html: '视频缓存',
            switch: loadCacheSettings().enabled,
            tooltip: loadCacheSettings().enabled ? '未开始' : '已关闭',
            onSwitch: function (item: any) {
              const enabled = !item.switch;
              saveCacheSettings({ enabled });
              // 缓存开关会改变内存缓冲目标（本地读取 vs 网络抗抖动），立即生效
              syncHlsBufferBudget(undefined, enabled);
              if (enabled) {
                cacheNoticeRef.current = null;
                cacheEnabledNoticeShownRef.current = true;
                updateCacheTooltip('未开始');
                pushPlayerNotice(artPlayerRef.current, '已开启视频缓存', {
                  key: 'cache-state',
                });
                ensurePrefetchCurrent(artPlayerRef.current?.currentTime || 0);
              } else {
                try {
                  prefetcherRef.current.stop();
                  getNextEpisodePrefetcher().stop();
                  nextWarmupKeyRef.current = null;
                  updateCacheTooltip('已关闭');
                  // 与预取器 disabled 的文案一致，重复下发时只续期
                  cacheNoticeRef.current = 'disabled:已关闭视频缓存';
                  pushPlayerNotice(artPlayerRef.current, '已关闭视频缓存', {
                    key: 'cache-state',
                  });
                } catch (error) {
                  // 终止失败：回滚开关（缓存仍在跑），并把原因显示在右上角
                  saveCacheSettings({ enabled: true });
                  updateCacheTooltip('终止失败', true);
                  const reason =
                    error instanceof Error ? error.message : '未知错误';
                  pushPlayerNotice(
                    artPlayerRef.current,
                    `终止视频缓存失败：${reason}`,
                    { key: 'cache-state', durationMs: 8000 }
                  );
                  return true;
                }
              }
              return enabled;
            },
          },
          {
            name: '缓存模式',
            html: '缓存模式',
            tooltip: `${
              cacheModeLabels[loadCacheSettings().concurrencyMode]
            } · ${loadCacheSettings().concurrency} 个`,
            selector: (['low', 'medium', 'high'] as const).map((mode) => ({
              html: `${cacheModeLabels[mode]}（${CACHE_CONCURRENCY_PRESETS[mode]} 个）`,
              value: mode,
              default: mode === loadCacheSettings().concurrencyMode,
            })),
            onSelect: function (item: any) {
              const settings = saveCacheSettings({
                concurrencyMode: item.value,
              });
              restartCacheQueue();
              return `${cacheModeLabels[settings.concurrencyMode]} · ${
                settings.concurrency
              } 个`;
            },
          },
          {
            html: '缓存管理',
            onClick: function () {
              setShowCacheManager(true);
              return '';
            },
          },
          {
            name: '操作说明',
            html: '操作说明',
            tooltip: '点击查看',
            selector: buildReadonlySettingRows([
              '左右滑动画面：快进 / 快退',
              '双击左侧 / 右侧：快退 / 快进 10 秒',
              '左半屏上下滑：亮度（全屏）',
              '右半屏上下滑：音量（全屏）',
              '长按画面：2x 倍速，松手恢复',
              '空格：播放 / 暂停',
              '← / →：快退 / 快进 5 秒',
              '↑ / ↓：音量 + / -',
              'Esc：退出网页全屏',
            ]),
          },
        ],
        // 控制栏配置
        controls: [
          {
            position: 'left',
            index: 13,
            html: '<i class="art-icon flex"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/></svg></i>',
            tooltip: '播放下一集',
            click: function () {
              handleNextEpisode();
            },
          },
        ],
      });

      // 移动端手势反馈（双击快退/快进、全屏竖滑音量/亮度）与拖动共用一套状态机
      const gestures = bindMobileGestures(artPlayerRef.current);
      bindDeferredProgressSeek(artPlayerRef.current, {
        vertical: gestures.vertical,
        longPress: gestures.longPress,
      });

      const playerEl =
        (artPlayerRef.current.template?.$player as HTMLElement | undefined) ||
        (artRef.current?.querySelector(
          '.art-video-player'
        ) as HTMLElement | null);
      if (playerEl) {
        setPlayerHost(playerEl);
      }

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
        setError(null);

        // 首次进入播放页时只提示一次帮助入口
        try {
          if (window.localStorage.getItem(HELP_TIP_SEEN_KEY) !== '1') {
            pushPlayerNotice(
              artPlayerRef.current,
              '偷偷告诉你：设置里藏着一些小惊喜，翻一翻能解锁更多隐藏操作～',
              { key: 'help-entry-tip', durationMs: 6000 }
            );
            window.localStorage.setItem(HELP_TIP_SEEN_KEY, '1');
          }
        } catch {
          // 隐私模式下 localStorage 不可用时忽略
        }

        // 捕获弹幕插件实例
        if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
          danmukuPluginInstanceRef.current =
            artPlayerRef.current.plugins.artplayerPluginDanmuku;
          console.log('弹幕插件实例已捕获', danmukuPluginInstanceRef.current);
          setIsDanmakuPluginReady(true);
          if (danmukuPluginInstanceRef.current) {
            try {
              danmukuPluginInstanceRef.current.config(danmakuConfigRef.current);
            } catch (_) {
              // ignore
            }
          }
        }

        // 播放器就绪后，如果正在播放则请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
        try {
          if (lastFullscreenWebRef.current) {
            artPlayerRef.current.fullscreenWeb = true;
          }
          if (lastFullscreenRef.current) {
            setTimeout(() => {
              artPlayerRef.current.fullscreen = true;
            }, 0);
          }
        } catch (_) {
          // ignore
        }
      });

      // 监听弹幕配置变化：同步到 ref（供重建播放器时恢复）并持久化到本地，
      // 使用户调整的弹幕设置（不透明度、字号、速度、显示区域等）刷新后依然生效。
      artPlayerRef.current.on(
        'artplayerPluginDanmuku:config',
        (option: any) => {
          if (!option || typeof option !== 'object') return;

          // 更新恢复用配置，剔除运行时字段，避免重建播放器时引用已销毁的节点
          const next = { ...option };
          delete next.mount;
          next.danmuku = '';
          danmakuConfigRef.current = next;

          const picked = pickDanmakuSettings(option);
          // 切集时会临时隐藏弹幕，此时不持久化可见性，避免把临时状态写入本地
          if (pendingDanmakuVisibleRestoreRef.current !== null) {
            delete picked.visible;
          }
          saveDanmakuSettings(picked);
        }
      );

      // 监听播放状态变化，控制 Wake Lock
      artPlayerRef.current.on('play', () => {
        requestWakeLock();
        syncCacheBandwidth(true);
      });

      artPlayerRef.current.on('pause', () => {
        releaseWakeLock();
        saveCurrentPlayProgress();

        // 暂停是预缓存的"黄金窗口"：播放不再抢带宽，缓存应当全速继续。
        // 1) 解除 stall 让路。否则若用户正好在卡顿时按暂停，video:playing
        //    永远不会再触发，预取会被永久挂起——恰好违背"暂停也继续缓存"。
        // 2) 明确要求"不设时间上限"：把整集剩余分片全部排进队列，暂停越久
        //    缓存铺得越远；字节上限与 LRU 淘汰才是这条路的兜底。
        //    走 ensurePrefetchCurrent 而不是闭包里的 videoUrl——播放器跨集复用，
        //    闭包里的地址可能是上一集的。
        setCacheBandwidthThrottled(false);
        ensurePrefetchCurrent(
          artPlayerRef.current.currentTime || 0,
          UNLIMITED_HORIZON_SECONDS
        );
      });

      // ---------------------------------------------------------------------
      // 前向预缓存：窗口维护
      // ---------------------------------------------------------------------
      // 跳转开始即中止旧请求，保留统计和已写入缓存；落点确定后重新排队。
      artPlayerRef.current.on('video:seeking', () => {
        // 记录 seek 时间：紧接着的 waiting 是"跳过去还在下载"，不是网络波动
        lastSeekAtRef.current = Date.now();
        prefetcherRef.current.stop(true);
        setCacheBandwidthThrottled(true);
      });
      artPlayerRef.current.on('video:seeked', () => {
        lastSeekAtRef.current = Date.now();
        prefetcherRef.current.stop(true);
        ensurePrefetchCurrent(artPlayerRef.current.currentTime || 0);
      });

      // 播放卡顿时让出带宽，恢复后继续预取。
      // 注意：这是"临时让路"，不是"视频暂停就停缓存"。
      artPlayerRef.current.on('video:waiting', () => {
        const media = artPlayerRef.current?.video;
        setCacheBandwidthThrottled(!media?.paused);

        // —— 弱网自动降档 ——
        // 只有"边播边等"才算卡顿：seek、ABR 换档、换源都会让 hls.js 重新
        // 缓冲并立刻抛一次 waiting，它们说明不了带宽。把这类等待算成卡顿，
        // 每拖一次进度条就会压一次 ABR 上限；而每次换档又会 flush 前向缓冲，
        // 正在等数据的 seek 因此被打回旧位置——这就是"越拖越回退"的死循环。
        const now = Date.now();
        if (
          !media ||
          media.seeking ||
          media.readyState === 0 ||
          now - lastSeekAtRef.current < STALL_GRACE_AFTER_SEEK_MS ||
          now - lastLevelSwitchAtRef.current < STALL_GRACE_AFTER_LEVEL_SWITCH_MS
        ) {
          return;
        }
        // 5 秒内的重复事件只记一次；2 分钟内累计 4 次视为网络跟不上当前档位，
        // 把 ABR 上限压一档。
        const stalls = stallTimesRef.current;
        if (stalls.length === 0 || now - stalls[stalls.length - 1] >= 5_000) {
          stalls.push(now);
        }
        while (stalls.length > 0 && now - stalls[0] > 120_000) {
          stalls.shift();
        }

        const hls = artPlayerRef.current?.video?.hls;
        if (!hls) return;
        if (stalls.length < 4) return;

        // 决策下沉到 decideDownshift()：手动锁档不插手，
        // **单档位源直接判定"无可降档"**（压 ABR 上限只会把唯一一档钉死，
        // 还会白触发一次换档 flush），只有真正多档位时才压上限。
        const decision = decideDownshift({
          levels: Array.isArray(hls.levels) ? hls.levels : [],
          autoLevelEnabled: hls.autoLevelEnabled === true,
          currentLevel:
            typeof hls.loadLevel === 'number' && hls.loadLevel >= 0
              ? hls.loadLevel
              : typeof hls.currentLevel === 'number' && hls.currentLevel >= 0
              ? hls.currentLevel
              : 0,
          autoLevelCapping: hls.autoLevelCapping,
        });

        if (decision.action === 'none') return;

        if (decision.action === 'advise-source') {
          // 已经无可降，只能提示换源；同一个原因只弹一次
          if (downshiftNoticeRef.current !== decision.reason) {
            downshiftNoticeRef.current = decision.reason;
            pushPlayerNotice(
              artPlayerRef.current,
              decision.reason === 'single-level'
                ? '当前片源只有一档画质，卡顿建议更换播放源'
                : '已降至最低画质仍卡顿，建议在右侧换一个播放源',
              { key: 'downshift' }
            );
          }
          return;
        }

        hls.autoLevelCapping = decision.nextCap;
        if (downshiftNoticeRef.current !== `cap-${decision.nextCap}`) {
          downshiftNoticeRef.current = `cap-${decision.nextCap}`;
          pushPlayerNotice(
            artPlayerRef.current,
            '检测到网络较慢，已自动降低画质以减少卡顿',
            { key: 'downshift' }
          );
        }
      });
      artPlayerRef.current.on('video:playing', () => {
        syncCacheBandwidth(true);
      });
      artPlayerRef.current.on('video:progress', () => syncCacheBandwidth());

      // 如果播放器初始化时已经在播放状态，则请求 Wake Lock
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        requestWakeLock();
      }

      artPlayerRef.current.on('video:volumechange', () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
      });
      artPlayerRef.current.on('video:ratechange', () => {
        lastPlaybackRateRef.current = artPlayerRef.current.playbackRate;
      });

      // 监听视频可播放事件，这时恢复播放进度更可靠
      artPlayerRef.current.on('video:canplay', () => {
        // 若存在需要恢复的播放进度，则跳转
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
            console.log('成功恢复播放进度到:', resumeTimeRef.current);
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        resumeTimeRef.current = null;

        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(
              artPlayerRef.current.playbackRate - lastPlaybackRateRef.current
            ) > 0.01 &&
            isWebkit
          ) {
            artPlayerRef.current.playbackRate = lastPlaybackRateRef.current;
          }
          artPlayerRef.current.notice.show = '';
        }, 0);

        // 隐藏换源加载状态
        setIsVideoLoading(false);
      });

      // 监听视频时间更新事件：播放进度自动保存 + 跳过片头片尾
      // （两个逻辑合并到同一个监听器，避免重复注册 timeupdate）
      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        syncCacheBandwidth();

        // —— 播放进度自动保存 ——
        // 间隔优先读取站点配置（RUNTIME_CONFIG.PLAYBACK_SAVE_INTERVAL，单位秒），
        // 未配置时回退到存储类型默认值（Upstash 20s，其余 5s）
        const configuredInterval =
          typeof window !== 'undefined'
            ? Number((window as any).RUNTIME_CONFIG?.PLAYBACK_SAVE_INTERVAL)
            : 0;
        const saveInterval =
          configuredInterval > 0
            ? configuredInterval * 1000
            : getDefaultPlaybackSaveInterval(
                process.env.NEXT_PUBLIC_STORAGE_TYPE
              ) * 1000;
        if (now - lastSaveTimeRef.current > saveInterval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }

        // —— 前向预缓存窗口续跑 ——
        // 播放自然推进（未触发 seek）时，每 30 秒检查一次窗口余量并续跑
        if (now - lastPrefetchCheckRef.current > 30_000) {
          lastPrefetchCheckRef.current = now;
          ensurePrefetchCurrent(artPlayerRef.current.currentTime || 0);
        }

        // —— 跳过片头片尾 ——
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime >
            artPlayerRef.current.duration + skipConfigRef.current.outro_time
        ) {
          if (
            currentEpisodeIndexRef.current <
            (detailRef.current?.episodes?.length || 1) - 1
          ) {
            handleNextEpisode();
          } else {
            artPlayerRef.current.pause();
          }
          artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
            skipConfigRef.current.outro_time
          )})`;
        }
      });

      artPlayerRef.current.on('error', (err: any) => {
        console.error('播放器错误:', err);
        if (artPlayerRef.current.currentTime > 0) {
          return;
        }
      });

      // 监听视频播放结束事件：释放 Wake Lock 并自动播放下一集
      artPlayerRef.current.on('video:ended', () => {
        releaseWakeLock();
        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (d && d.episodes && idx < d.episodes.length - 1) {
          setTimeout(() => {
            handleNextEpisode();
          }, 1000);
        }
      });

      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
    } catch (err) {
      console.error('创建播放器失败:', err);
      setError('播放器初始化失败');
    }
  }, [
    libsReady,
    videoUrl,
    loading,
    blockAdEnabled,
    currentEpisodeIndex,
    detail,
  ]);

  // -----------------------------------------------------------------------------
  // 进度条悬停预览
  // -----------------------------------------------------------------------------

  // 抽帧器实例生命周期：切集 / 换源 / 去广告开关变化时重建，
  // 其 loader 配置与主播放器完全一致，保证预览分片同样命中 Cache Storage / 同源代理。
  useEffect(() => {
    if (!libsReady || !videoUrl) return;
    const Hls = hlsLibRef.current;
    if (!Hls) return;

    const thumb = new PreviewThumbnailer();
    previewThumbnailerRef.current?.destroy();
    previewThumbnailerRef.current = thumb;
    thumb.load(
      videoUrl,
      Hls,
      createCustomHlsLoader(Hls, {
        blockAd: blockAdEnabledRef.current,
        useProxy: loadCacheSettings().useProxy,
        // 预览抽帧不计入「缓存命中率」诊断，避免污染主播放器统计
        onProbe: () => undefined,
      })
    );
    setPreview(null);

    return () => {
      thumb.destroy();
      if (previewThumbnailerRef.current === thumb) {
        previewThumbnailerRef.current = null;
      }
    };
  }, [libsReady, videoUrl, blockAdEnabled]);

  // 鼠标悬停及拖动处理器共享预览；触摸抽帧串行执行，避免移动时反复取消。
  // playerHost 变化代表播放器已重建（进度条 DOM 换新），需重新绑定。
  useEffect(() => {
    if (!playerHost) return;
    const progressEl =
      (artPlayerRef.current?.template?.$progress as HTMLElement | null) ||
      (playerHost.querySelector('.art-progress') as HTMLElement | null);
    if (!progressEl) return;

    let dragging = false;
    let touchTime: number | null = null;
    let capturingTouch = false;
    let capturedTouchTime: number | null = null;

    const scheduleTouchCapture = () => {
      if (
        touchTime === null ||
        capturingTouch ||
        previewTimerRef.current !== null ||
        touchTime === capturedTouchTime
      ) {
        return;
      }
      const id = previewRequestIdRef.current;
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        const thumb = previewThumbnailerRef.current;
        const time = touchTime;
        if (!thumb || time === null) return;
        capturingTouch = true;
        capturedTouchTime = time;
        thumb.capture(time).then((image) => {
          if (id !== previewRequestIdRef.current) return;
          capturingTouch = false;
          // 保留上一帧直到新帧就绪；移动中的时间标签仍实时更新。
          if (image) {
            setPreview((p) => (p?.visible ? { ...p, image } : p));
          }
          scheduleTouchCapture();
        });
      }, 120);
    };

    const showPreview = (ratio: number, input: 'mouse' | 'touch') => {
      const duration = artPlayerRef.current?.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const time = ratio * duration;
      setPreview((p) => ({
        visible: true,
        time,
        left:
          input === 'touch' || artLibRef.current?.utils?.isMobile
            ? 50
            : ratio * 100,
        image: p?.visible ? p.image : null,
      }));
      if (input === 'touch') {
        touchTime = time;
        scheduleTouchCapture();
        return;
      }
      // 先使已在进行中的抽帧失效，避免旧图串到新位置
      const id = ++previewRequestIdRef.current;
      previewThumbnailerRef.current?.cancel();

      if (previewTimerRef.current != null)
        clearTimeout(previewTimerRef.current);
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        const thumb = previewThumbnailerRef.current;
        if (!thumb) return;
        thumb.capture(time).then((image) => {
          if (id !== previewRequestIdRef.current) return;
          setPreview((p) =>
            image && p && p.visible && Math.abs(p.time - time) < 0.5
              ? { ...p, image }
              : p
          );
        });
      }, 120);
    };

    const hidePreview = () => {
      dragging = false;
      touchTime = null;
      capturedTouchTime = null;
      capturingTouch = false;
      if (previewTimerRef.current != null) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      previewRequestIdRef.current++;
      previewThumbnailerRef.current?.cancel();
      setPreview((p) => (p ? { ...p, visible: false } : p));
    };

    const onDragMove = (event: Event) => {
      const { ratio, input } = (event as CustomEvent<ProgressPreviewMove>)
        .detail;
      if (!dragging && input === 'touch') hidePreview();
      dragging = true;
      showPreview(ratio, input);
    };
    const onPointerMove = (e: PointerEvent) => {
      // 触摸由拖动处理器驱动，不依赖浏览器是否产生 pointermove。
      if (e.pointerType === 'touch' || dragging) return;
      const rect = progressEl.getBoundingClientRect();
      const rotated = artPlayerRef.current?.isRotate;
      const size = rotated ? rect.height : rect.width;
      if (size <= 0) return;
      const offset = rotated ? e.clientY - rect.top : e.clientX - rect.left;
      showPreview(Math.min(1, Math.max(0, offset / size)), 'mouse');
    };
    const onPointerLeave = () => {
      if (!dragging) hidePreview();
    };

    progressEl.addEventListener(PROGRESS_PREVIEW_MOVE, onDragMove);
    progressEl.addEventListener(PROGRESS_PREVIEW_END, hidePreview);
    progressEl.addEventListener('pointermove', onPointerMove);
    progressEl.addEventListener('pointerleave', onPointerLeave);

    return () => {
      progressEl.removeEventListener(PROGRESS_PREVIEW_MOVE, onDragMove);
      progressEl.removeEventListener(PROGRESS_PREVIEW_END, hidePreview);
      progressEl.removeEventListener('pointermove', onPointerMove);
      progressEl.removeEventListener('pointerleave', onPointerLeave);
      hidePreview();
      setPreview(null);
    };
  }, [playerHost]);

  // 当组件卸载时清理定时器、Wake Lock 和播放器资源
  useEffect(() => {
    // 监听页面可见性变化
    const handleVisibilityChange = () => {
      if (
        !document.hidden &&
        artPlayerRef.current &&
        !artPlayerRef.current.paused
      ) {
        // 页面变为可见且视频正在播放时，重新请求 Wake Lock
        requestWakeLock();
      } else if (document.hidden) {
        // 页面隐藏时，释放 Wake Lock（系统会自动释放，但我们也主动释放）
        releaseWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (danmakuVisibleRestoreTimerRef.current) {
        clearTimeout(danmakuVisibleRestoreTimerRef.current);
        danmakuVisibleRestoreTimerRef.current = null;
      }

      // 清理定时器
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }

      // 释放 Wake Lock
      releaseWakeLock();

      // 移除可见性监听
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      // 停止前向预缓存（含下一集预热队列）
      restartPrefetchForSkipRef.current = null;
      prefetcherRef.current.stop();
      getNextEpisodePrefetcher().stop();

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  // -----------------------------------------------------------------------------
  // 弹幕选择回调（供渲染层绑定 DanmakuSelector）
  // -----------------------------------------------------------------------------

  const handleDanmakuSelect = (anime: AnimeOption, episodeNumber?: number) => {
    const sourceName = anime.animeTitle;
    setSelectedDanmakuSource(sourceName);
    selectedDanmakuSourceRef.current = sourceName;
    setShowDanmakuSelector(false);
    setSelectedDanmakuAnime(anime);
    setSelectedDanmakuEpisode(episodeNumber);
    setSelectedState(true);
    // 重复确认同一来源时依赖项不会变化，这里显式触发一次加载流程
    setDanmakuSelectNonce((n) => n + 1);
  };

  const handleDanmakuClose = () => {
    setShowDanmakuSelector(false);
    // 更新 tooltip（走 DOM setter，不触发面板重建）
    setSettingTooltip(
      artPlayerRef.current,
      DANMAKU_SETTING_NAME,
      currentTooltip || '未选择'
    );
  };

  // -----------------------------------------------------------------------------
  // 返回给渲染层
  // -----------------------------------------------------------------------------

  return {
    // 加载 / 错误
    loading,
    loadingStage,
    loadingMessage,
    error,
    // 视频与元数据
    detail,
    totalEpisodes,
    videoTitle,
    videoYear,
    videoDoubanId,
    currentSource,
    currentId,
    searchTitle,
    currentEpisodeIndex,
    videoUrl,
    skipConfig,
    // 播放器
    artRef,
    // ArtPlayer 实例：共同观影室需要监听播放/暂停/跳转并静默应用远端指令
    artPlayerRef,
    playerHost,
    preview,
    isVideoLoading,
    videoLoadingStage,
    setLoading,
    setIsVideoLoading,
    setVideoLoadingStage,
    // 源 / 换源
    availableSources,
    sourceSearchLoading,
    sourceSearchError,
    precomputedVideoInfo,
    preferBestSource,
    handleSourceChange,
    handleEpisodeChange,
    // 弹幕
    showDanmakuSelector,
    isDanmakuLoading,
    handleDanmakuSelect,
    handleDanmakuClose,
    // 缓存管理
    showCacheManager,
    setShowCacheManager,
    // 收藏 / 追更
    favorited,
    following,
    handleToggleFavorite,
    handleToggleFollowing,
  };
}
