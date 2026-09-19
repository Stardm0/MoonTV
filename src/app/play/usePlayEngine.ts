/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  setSettingSwitch,
  setSettingTooltip,
  updateSettingPreservingPanel,
} from '@/lib/artplayer-setting';
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
import {
  describeHlsError,
  PlaybackRecovery,
} from '@/lib/playback-recovery';
import { getDefaultPlaybackSaveInterval } from '@/lib/playback-settings';
import { SearchResult } from '@/lib/types';
import { getRequestTimeout, getVideoResolutionFromM3u8 } from '@/lib/utils';
import {
  clearVideoCache,
  getSegmentProbe,
  loadCacheSettings,
  resetSegmentProbe,
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
import { useVideoActions } from './hooks/useVideoActions';
import { useWakeLock } from './hooks/useWakeLock';
import {
  calculateSourceScore,
  createCustomHlsLoader,
  createDanmakuInitialConfig,
  DANMAKU_VISIBLE_RESTORE_DELAY_MS,
  formatTime,
  pickDanmakuSettings,
  saveDanmakuSettings,
  SkipConfig,
} from './play-utils';

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

/** 「画质」设置项的 name，`setting.update` 靠它定位 */
const QUALITY_SETTING_NAME = '画质';

/** 「视频缓存」设置项的 name */
const CACHE_SETTING_NAME = '视频缓存';

/** 「弹幕源」设置项的 name */
const DANMAKU_SETTING_NAME = '弹幕源';

/**
 * 下一集预热的覆盖时长（秒）。
 *
 * 这是唯一还保留时间上限的地方：预热只是为了"切过去不卡"，没必要把整集
 * 都拉下来。当前集的预取已改为不设上限（缓存到片尾）；用户真切过去之后，
 * 当前集预取器会接管，按无限视野继续往后铺。
 */
const NEXT_EPISODE_HORIZON_SECONDS = 420;

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
  const hitPart =
    hitRate === null ? '' : ` · 命中 ${Math.round(hitRate * 100)}%`;
  return `${stats.cached}/${stats.total} 段${coverPart}${hitPart}`;
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

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<SkipConfig>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
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

  const [isBlockAdChanged, setIsBlockAdChanged] = useState(false);
  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
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

  // 下一集预热（落地路线第 3 步）。独立实例，避免打断当前集的队列。
  // `nextWarmupKeyRef` 记录"已经为哪一集的哪个档位预热过"，防止重复排队。
  const nextWarmupKeyRef = useRef<string | null>(null);

  // 弹幕源选择相关
  const [selectedDanmakuSource, setSelectedDanmakuSource] = useState<
    string | null
  >(null);
  const [selectedDanmakuAnime, setSelectedDanmakuAnime] =
    useState<AnimeOption | null>(null);
  const [selectedDanmakuEpisode, setSelectedDanmakuEpisode] = useState<number | undefined>(undefined);
  const [showDanmakuSelector, setShowDanmakuSelector] = useState(false);
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
  const [preferredDanmakuPlatform, setPreferredDanmakuPlatform] = useState("bilibili1");

  const [currentTooltip, setCurrentTooltip] = useState('');
  const [selectedState, setSelectedState] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedAuto = localStorage.getItem("autoDanmakuEnabled");
    if (savedAuto !== null) {
      setAutoDanmakuEnabled(JSON.parse(savedAuto));
    }

    const savedPlatform = localStorage.getItem("preferredDanmakuPlatform");
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

    /** ① 用户手动选择某一集（权重大最高） */
    if (selectedDanmakuEpisode !== undefined && selectedState) {
      matchedEpisode = selectedDanmakuAnime.episodes[selectedDanmakuEpisode - 1];
      setSelectedState(false);
    }

    /** ② 自动匹配模式：直接使用第 0 集 */
    else if (autoDanmakuEnabled) {
      matchedEpisode = selectedDanmakuAnime.episodes[0];
    }

    if (!matchedEpisode) return;

    const episodeIndex = selectedDanmakuAnime.episodes.indexOf(matchedEpisode);
    const episodeNumber = episodeIndex + 1;

    // 更新 tooltip（走 DOM setter，不触发面板重建）
    setTimeout(() => {
      setSettingTooltip(artPlayerRef.current, DANMAKU_SETTING_NAME, matchedEpisode.episodeTitle);
    }, 100);

    // 加载弹幕 URL
    (async () => {
      try {
        const url = await getDanmakuBySelectedAnime(
          selectedDanmakuAnime,
          episodeNumber,
          "xml"
        );
        if (danmukuPluginInstanceRef.current && url !== lastDanmakuUrlRef.current) {
          console.log('动态更新弹幕源:', url);
          danmukuPluginInstanceRef.current.config({ danmuku: url });
          danmukuPluginInstanceRef.current.load();
          lastDanmakuUrlRef.current = url;

          if (pendingDanmakuVisibleRestoreRef.current !== null) {
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
          }

          setCurrentTooltip(matchedEpisode.episodeTitle);
        }
      } catch (e) {
        console.error("获取弹幕 URL 失败:", e);
      }
    })();
  }, [currentEpisodeIndex, selectedDanmakuAnime, selectedDanmakuEpisode]);

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

  // 切集时清空"已试过的源"与"自动换源次数"：
  // 某个源只是这一集挂了，不代表下一集也挂，不该把惩罚带到下一集。
  useEffect(() => {
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
  const danmukuPluginInstanceRef = useRef<any>(null); // 弹幕插件实例
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

    const sortedSources = scoredSources.map(item => item.source);

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

    if (artPlayerRef.current) {
      try {
        lastFullscreenRef.current = !!artPlayerRef.current.fullscreen;
        lastFullscreenWebRef.current = !!artPlayerRef.current.fullscreenWeb;
        if (danmukuPluginInstanceRef.current) {
          const inst = danmukuPluginInstanceRef.current as any;
          if (inst.option) {
            const next = { ...inst.option };
            if ('mount' in next) next.mount = undefined;
            if ('danmuku' in next) next.danmuku = "";
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

      try {
        // 发起流式搜索请求
        const timeoutSeconds = getRequestTimeout();
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(
            query.trim()
          )}&timeout=${timeoutSeconds}&stream=1`
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
                      const titleMatch =
                        r.title.trim().replace(/\s+/g, ' ').toLowerCase() ===
                        videoTitleRef.current
                          .trim()
                          .replace(/\s+/g, ' ')
                          .toLowerCase();
                      const yearMatch = videoYearRef.current
                        ? r.year.toLowerCase() ===
                          videoYearRef.current.toLowerCase()
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

      // 传入的起始集数超出本源可用集数范围时，直接定位到最后一集（而非回到第一集）
      if (
        detailData.episodes.length > 0 &&
        currentEpisodeIndex >= detailData.episodes.length
      ) {
        setCurrentEpisodeIndex(detailData.episodes.length - 1);
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

      await fetchSourcesData(videoTitle, (newResults) => {
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
    if (isDanmakuPluginReady && isBlockAdChanged){
      danmukuPluginInstanceRef.current.config({ danmuku: lastDanmakuUrlRef.current });
      danmukuPluginInstanceRef.current.load();
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
      setIsDanmakuLoading(true);
      while (!success && (retryCount === -1 || attempt <= retryCount)) {
        attempt++;
        try {
          const title = videoTitleRef.current;
          const currentEpisodeTitle = detail?.episodes_titles?.[currentEpisodeIndex];
          if (!currentEpisodeTitle) {
            throw new Error("无法获取当前集数标题（episodes_titles 无效）");
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
              await new Promise(res => setTimeout(res, 1500)); // 间隔1.5秒重试
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            console.log('自动加载弹幕已取消');
            return;
          }
          console.error(`自动弹幕匹配第${attempt}次失败:`, err);
          if (retryCount === -1 || attempt <= retryCount) {
            await new Promise(res => setTimeout(res, 1500));
          }
        }
      }
      if (!success) {
        triggerGlobalError("自动加载弹幕失败，请手动选择弹幕源");
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
  }, [currentEpisodeIndex, autoDanmakuEnabled, isDanmakuPluginReady, preferredDanmakuPlatform]);

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

      // 如果当前集数超出新源的范围，则跳转到第一集
      if (!newDetail.episodes || targetIndex >= newDetail.episodes.length) {
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
    console.warn(`[auto-switch] ${reason} → ${candidate.source}:${candidate.id}`);
    try {
      if (artPlayerRef.current) {
        artPlayerRef.current.notice.show = notice;
      }
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
        setCurrentTooltip("");
      }
      // 检查是否有历史播放记录
      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSourceRef.current, currentIdRef.current);
        const record = allRecords[key];
        if (record && record.index - 1 === episodeNumber && record.play_time > 0) {
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
      if(artPlayerRef.current){
        setCurrentTooltip("");
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
      if(artPlayerRef.current){
        setCurrentTooltip("");
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

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
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
        danmukuPluginRef.current =
          wrapArtplayerPluginDanmuku(artplayerPluginDanmuku);
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
      (currentEpisodeIndex < 0 ||
        currentEpisodeIndex >= detail.episodes.length)
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
      artPlayerRef.current.poster = videoCover;
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
      artPlayerRef.current.poster = videoCover;
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
      const updateCacheTooltip = (text: string, switchState?: boolean) => {
        const art = artPlayerRef.current;
        if (!art) return;
        setSettingTooltip(art, CACHE_SETTING_NAME, text);
        if (switchState !== undefined) {
          setSettingSwitch(art, CACHE_SETTING_NAME, switchState);
        }
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
        prefetcherRef.current.ensure({
          m3u8Url,
          currentTime,
          episodeKey: `${currentSourceRef.current}:${currentIdRef.current}:${currentEpisodeIndexRef.current}`,
          preferredHeight: preferredHeightRef.current,
          ...(horizonSeconds === undefined ? {} : { horizonSeconds }),
          onProgress: (stats) => {
            const probe = getSegmentProbe();
            const probed = probe.hits + probe.misses;
            updateCacheTooltip(
              buildCacheTooltip(stats, probed > 0 ? probe.hitRate : null)
            );

            // 当前集的前向视野已经铺满 → 顺手把下一集的前几分钟也预热掉，
            // 这样用户点"下一集"时首屏基本是命中缓存而不是现拉网络。
            if (stats.state === 'done') warmupNextEpisode();
          },
        });
      };

      /**
       * 预热下一集（落地路线第 3 步）。
       *
       * 走独立的预取器实例，因此**不会**打断当前集的队列。
       * 只在当前集队列跑到 `done` 时触发一次（由 `nextWarmupKeyRef` 去重），
       * 并且随集数/画质变化自动失效。
       */
      const warmupNextEpisode = () => {
        if (!loadCacheSettings().enabled) return;

        const data = detailRef.current;
        const episodes = data?.episodes;
        if (!episodes || episodes.length === 0) return;

        const nextIndex = currentEpisodeIndexRef.current + 1;
        if (nextIndex >= episodes.length) return;

        const nextUrl = episodes[nextIndex];
        if (!nextUrl) return;

        const preferred = preferredHeightRef.current;
        // 画质档位也是预热键的一部分：换了档位，预热过的分片 URL 就不同了
        const key = `${currentSourceRef.current}:${currentIdRef.current}:${nextIndex}:${preferred ?? 'auto'}`;
        if (nextWarmupKeyRef.current === key) return;
        nextWarmupKeyRef.current = key;

        getNextEpisodePrefetcher().ensure({
          m3u8Url: nextUrl,
          currentTime: 0,
          episodeKey: `${currentSourceRef.current}:${currentIdRef.current}:${nextIndex}`,
          preferredHeight: preferred,
          horizonSeconds: NEXT_EPISODE_HORIZON_SECONDS,
          useProxy: loadCacheSettings().useProxy,
        });
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
        const matchedIndex =
          preferred === null ? AUTO_LEVEL : pickLevelIndex(levels, preferred);

        const art = artPlayerRef.current;
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
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        theme: '#22c55e',
        lang: 'zh-cn',
        hotkey: false,
        fastForward: true,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        plugins: [
          danmukuPluginRef.current(danmakuConfigRef.current),
        ],
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
            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力

              // VOD 场景关闭低延迟模式：LL-HLS 会主动压缩前向缓冲，与"多缓存"目标相悖
              lowLatencyMode: false,

              /* 缓冲/内存相关 */
              // 真正的"缓存后面的"由 VideoPrefetcher 写入 Cache Storage 承担，
              // 这里只需一个适度的内存缓冲，避免移动端内存压力。
              // 弱网优化：缓冲拉长到 2 分钟，网络抖动时不容易转圈；
              // 实际内存占用仍由 maxBufferSize（90MB）兜底。
              maxBufferLength: 120, // 前向缓冲目标 120s
              maxMaxBufferLength: 600, // 前向缓冲硬上限 600s
              backBufferLength: 30, // 仅保留 30s 已播放内容，避免内存占用
              maxBufferSize: 90 * 1000 * 1000, // 约 90MB，超出后触发清理

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

            // 播放列表解析成功：建立画质档位，并确认链路可用
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
              recovery.markHealthy();
              syncQualitySetting(hls);
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, function (_event: any, data: any) {
              const level = hls.levels?.[data?.level];
              updateQualityTooltip(
                hls.autoLevelEnabled
                  ? `自动${level ? ` · ${describeLevel(level)}` : ''}`
                  : describeLevel(level)
              );

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
            });

            // 分片加载成功（含命中本项目的片段缓存）即视为链路仍在推进
            hls.on(Hls.Events.FRAG_LOADED, function () {
              recovery.markHealthy();
            });

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              if (!data?.fatal) {
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
            tooltip: blockAdEnabled ? '已开启' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad', String(newVal));
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
              return newVal ? '当前开启' : '当前关闭';
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
            // 画质切换（P1-6）。档位列表在 MANIFEST_PARSED 后由
            // syncQualitySetting() 动态写入，这里先给个占位。
            // 占位用 `selector`（而不是 onClick）是刻意为之：ArtPlayer 只有
            // 在 item 带 selector 时才会渲染成可展开的子面板。
            name: QUALITY_SETTING_NAME,
            html: QUALITY_SETTING_NAME,
            tooltip: '自动',
            selector: [{ html: '自动', value: AUTO_LEVEL, default: true }],
            onSelect: function (item: any) {
              const value = Number(item.value);
              const hls = artPlayerRef.current?.video?.hls;
              const levels: any[] = Array.isArray(hls?.levels) ? hls.levels : [];

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
              if (enabled) {
                updateCacheTooltip('未开始');
                ensurePrefetchCurrent(artPlayerRef.current?.currentTime || 0);
              } else {
                prefetcherRef.current.stop();
                getNextEpisodePrefetcher().stop();
                nextWarmupKeyRef.current = null;
                updateCacheTooltip('已关闭');
              }
              return enabled;
            },
          },
          {
            html: '清空视频缓存',
            onClick: function () {
              prefetcherRef.current.stop();
              getNextEpisodePrefetcher().stop();
              nextWarmupKeyRef.current = null;
              resetSegmentProbe();
              void clearVideoCache();
              updateCacheTooltip('未开始');
              return '';
            },
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

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
        setError(null);

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
        prefetcherRef.current.setThrottled(false);
        ensurePrefetchCurrent(
          artPlayerRef.current.currentTime || 0,
          UNLIMITED_HORIZON_SECONDS
        );
      });

      // ---------------------------------------------------------------------
      // 前向预缓存：窗口维护
      // ---------------------------------------------------------------------
      // seek 后窗口可能不再覆盖目标位置；ensure 内部会判断，窗口够用时零成本返回
      artPlayerRef.current.on('video:seeked', () => {
        ensurePrefetchCurrent(artPlayerRef.current.currentTime || 0);
      });

      // 播放卡顿时让出带宽，恢复后继续预取。
      // 注意：这是"临时让路"，不是"视频暂停就停缓存"。
      artPlayerRef.current.on('video:waiting', () => {
        prefetcherRef.current.setThrottled(true);

        // —— 弱网自动降档 ——
        // seek/换源也会触发 waiting，因此 5 秒内的重复事件只记一次；
        // 2 分钟内累计 4 次视为网络跟不上当前档位，把 ABR 上限压一档。
        const now = Date.now();
        const stalls = stallTimesRef.current;
        if (stalls.length === 0 || now - stalls[stalls.length - 1] >= 5_000) {
          stalls.push(now);
        }
        while (stalls.length > 0 && now - stalls[0] > 120_000) {
          stalls.shift();
        }

        const hls = artPlayerRef.current?.video?.hls;
        if (!hls || !hls.autoLevelEnabled) return; // 手动档位由用户自己负责
        if (stalls.length < 4) return;

        const currentLevel =
          typeof hls.loadLevel === 'number' && hls.loadLevel >= 0
            ? hls.loadLevel
            : typeof hls.currentLevel === 'number' && hls.currentLevel >= 0
              ? hls.currentLevel
              : 0;
        const cap =
          typeof hls.autoLevelCapping === 'number' && hls.autoLevelCapping >= 0
            ? hls.autoLevelCapping
            : Number.POSITIVE_INFINITY;
        const nextCap = Math.max(0, Math.min(currentLevel, cap) - 1);

        if (cap === 0) {
          // 已经是最低档还在卡：提示换源，不再重复弹
          if (downshiftNoticeRef.current !== 'min') {
            downshiftNoticeRef.current = 'min';
            artPlayerRef.current.notice.show =
              '已降至最低画质仍卡顿，建议在右侧换一个播放源';
          }
          return;
        }

        hls.autoLevelCapping = nextCap;
        if (downshiftNoticeRef.current !== `cap-${nextCap}`) {
          downshiftNoticeRef.current = `cap-${nextCap}`;
          artPlayerRef.current.notice.show =
            '检测到网络较慢，已自动降低画质以减少卡顿';
        }
      });
      artPlayerRef.current.on('video:playing', () => {
        prefetcherRef.current.setThrottled(false);
      });

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

  // 当组件卸载时清理定时器、Wake Lock 和播放器资源
  useEffect(() => {
    // 监听页面可见性变化
    const handleVisibilityChange = () => {
      if (!document.hidden && artPlayerRef.current && !artPlayerRef.current.paused) {
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
      prefetcherRef.current.stop();
      getNextEpisodePrefetcher().stop();

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  // -----------------------------------------------------------------------------
  // 弹幕选择回调（供渲染层绑定 DanmakuSelector）
  // -----------------------------------------------------------------------------

  const handleDanmakuSelect = (
    anime: AnimeOption,
    episodeNumber?: number
  ) => {
    const sourceName = anime.animeTitle;
    setSelectedDanmakuSource(sourceName);
    selectedDanmakuSourceRef.current = sourceName;
    setShowDanmakuSelector(false);
    setSelectedDanmakuAnime(anime);
    setSelectedDanmakuEpisode(episodeNumber);
    setSelectedState(true);
  };

  const handleDanmakuClose = () => {
    setShowDanmakuSelector(false);
    // 更新 tooltip（走 DOM setter，不触发面板重建）
    setSettingTooltip(artPlayerRef.current, DANMAKU_SETTING_NAME, currentTooltip || '未选择');
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
    // 收藏 / 追更
    favorited,
    following,
    handleToggleFavorite,
    handleToggleFollowing,
  };
}
