/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';
import { Download, Heart } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import {
  AnimeOption,
  extractEpisodeNumber,
  extractSeasonFromTitle,
  getDanmakuBySelectedAnime,
  matchAnime,
} from '@/lib/danmaku.client';
import {
  deleteFavorite,
  deletePlayRecord,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  isFavorited,
  saveFavorite,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { createPreparationLoader } from '@/lib/media-preparation-loader';
import { SearchResult } from '@/lib/types';
import {
  getRequestTimeout,
  getVideoResolutionFromM3u8,
  videoQualityFromWidth,
} from '@/lib/utils';

import AddDownloadModal from '@/components/AddDownloadModal';
import DanmakuSelector from '@/components/DanmakuSelector';
import EpisodeSelector from '@/components/EpisodeSelector';
import { triggerGlobalError } from '@/components/GlobalErrorIndicator';
import PageLayout from '@/components/PageLayout';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

// Wake Lock API 类型声明
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

function PlayPageClient() {
  const router = useRouter();
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

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 添加下载弹窗状态
  const [showAddDownload, setShowAddDownload] = useState(false);

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<{
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }>({
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

  useEffect(() => {
    if (!selectedDanmakuAnime || !detail) return;

    const currentEpisodeTitle = detail?.episodes_titles?.[currentEpisodeIndex];
    if (!currentEpisodeTitle) return;

    let matchedEpisode: any = null;

    /** ① 用户手动选择某一集（权重大最高） */
    if (selectedDanmakuEpisode !== undefined && selectedState) {
      matchedEpisode =
        selectedDanmakuAnime.episodes[selectedDanmakuEpisode - 1];
      setSelectedState(false);
    } else if (autoDanmakuEnabled) {
      /** ② 自动匹配模式：直接使用第 0 集 */
      matchedEpisode = selectedDanmakuAnime.episodes[0];
    }

    if (!matchedEpisode) return;

    const episodeIndex = selectedDanmakuAnime.episodes.indexOf(matchedEpisode);
    const episodeNumber = episodeIndex + 1;

    // 更新 tooltip
    setTimeout(() => {
      if (artPlayerRef.current) {
        artPlayerRef.current.setting.update({
          name: '弹幕源',
          tooltip: matchedEpisode.episodeTitle,
        });
      }
    }, 100);

    // 加载弹幕 URL
    (async () => {
      try {
        const url = await getDanmakuBySelectedAnime(
          selectedDanmakuAnime,
          episodeNumber,
          'xml'
        );
        if (
          danmukuPluginInstanceRef.current &&
          url !== lastDanmakuUrlRef.current
        ) {
          console.log('动态更新弹幕源:', url);
          danmukuPluginInstanceRef.current.config({ danmuku: url });
          danmukuPluginInstanceRef.current.load();
          lastDanmakuUrlRef.current = url;
          setCurrentTooltip(matchedEpisode.episodeTitle);
        }
      } catch (e) {
        console.error('获取弹幕 URL 失败:', e);
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
  const danmakuConfigRef = useRef<any>({
    danmuku: '',
    speed: 5,
    margin: [10, '25%'],
    opacity: 1,
    color: '#FFFFFF',
    mode: 0,
    modes: [0, 1, 2],
    fontSize: 25,
    antiOverlap: true,
    synchronousPlayback: false,
    mount: undefined,
    heatmap: false,
    width: 512,
    points: [],
    filter: (danmu: any) => danmu.text.length <= 100,
    beforeVisible: () => true,
    visible: true,
    emitter: false,
    maxLength: 200,
    lockTime: 5,
    theme: 'dark',
    OPACITY: {},
    FONT_SIZE: {},
    MARGIN: {},
    SPEED: {},
    COLOR: [],
    beforeEmit(_danmu: any) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, 1000);
      });
    },
  });

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  // 换源加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [preparationMessage, setPreparationMessage] = useState('');
  const preparationWaitsRef = useRef(new Map<symbol, number>());
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

  // Wake Lock 相关
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // -----------------------------------------------------------------------------
  // 工具函数（Utils）
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

  // 计算播放源综合评分
  const calculateSourceScore = (
    testResult: {
      quality: string;
      loadSpeed: string;
      pingTime: number;
    },
    maxSpeed: number,
    minPing: number,
    maxPing: number
  ): number => {
    let score = 0;

    // 分辨率评分 (40% 权重)
    const qualityScore = (() => {
      switch (testResult.quality) {
        case '4K':
          return 100;
        case '2K':
          return 85;
        case '1080p':
          return 75;
        case '720p':
          return 60;
        case '480p':
          return 40;
        case 'SD':
          return 20;
        default:
          return 0;
      }
    })();
    score += qualityScore * 0.4;

    // 下载速度评分 (40% 权重) - 基于最大速度线性映射
    const speedScore = (() => {
      const speedStr = testResult.loadSpeed;
      if (speedStr === '未知' || speedStr === '测量中...') return 30;

      // 解析速度值
      const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
      if (!match) return 30;

      const value = parseFloat(match[1]);
      const unit = match[2];
      const speedKBps = unit === 'MB/s' ? value * 1024 : value;

      // 基于最大速度线性映射，最高100分
      const speedRatio = speedKBps / maxSpeed;
      return Math.min(100, Math.max(0, speedRatio * 100));
    })();
    score += speedScore * 0.4;

    // 网络延迟评分 (20% 权重) - 基于延迟范围线性映射
    const pingScore = (() => {
      const ping = testResult.pingTime;
      if (ping <= 0) return 0; // 无效延迟给默认分

      // 如果所有延迟都相同，给满分
      if (maxPing === minPing) return 100;

      // 线性映射：最低延迟=100分，最高延迟=0分
      const pingRatio = (maxPing - ping) / (maxPing - minPing);
      return Math.min(100, Math.max(0, pingRatio * 100));
    })();
    score += pingScore * 0.2;

    return Math.round(score * 100) / 100; // 保留两位小数
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

  // Wake Lock 相关函数
  const requestWakeLock = async () => {
    try {
      // 检查页面是否可见
      if (document.hidden) {
        console.log('页面不可见，跳过 Wake Lock 请求');
        return;
      }

      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request(
          'screen'
        );
        console.log('Wake Lock 已启用');
      }
    } catch (err) {
      console.warn('Wake Lock 请求失败:', err);
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake Lock 已释放');
      }
    } catch (err) {
      console.warn('Wake Lock 释放失败:', err);
    }
  };

  // 清理播放器资源的统一函数
  const cleanupPlayer = () => {
    preparationWaitsRef.current.clear();
    setPreparationMessage('');
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

  // 去广告相关函数
  function filterAdsFromM3U8(m3u8Content: string): string {
    if (!m3u8Content) return '';

    // 按行分割M3U8内容
    const lines = m3u8Content.split('\n');
    const filteredLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 只过滤#EXT-X-DISCONTINUITY标识
      if (!line.includes('#EXT-X-DISCONTINUITY')) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join('\n');
  }

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }) => {
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

  const formatTime = (seconds: number): string => {
    if (seconds === 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  // 注意：自定义 HLS Loader 会在确保 Hls 动态加载成功后再定义

  // 当集数索引变化时自动更新视频地址
  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    // 已不再使用的函数移除（避免 SSR 与 linter 报错）

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

      if (currentEpisodeIndex >= detailData.episodes.length) {
        setCurrentEpisodeIndex(0);
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
  }, []);

  // 视频初始化后即可匹配弹幕
  useEffect(() => {
    if (isDanmakuPluginReady && isBlockAdChanged) {
      danmukuPluginInstanceRef.current.config({
        danmuku: lastDanmakuUrlRef.current,
      });
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
            const animeOption = m;
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

  // 播放记录处理
  useEffect(() => {
    // 仅在初次挂载时检查播放记录
    const initFromHistory = async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

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
  }, []);

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    try {
      // 显示换源加载状态
      setVideoLoadingStage('sourceChanging');
      setIsVideoLoading(true);

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;
      console.log('换源前当前播放时间:', currentPlayTime);

      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
          console.log('已清除前一个播放记录');
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

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

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 处理集数切换
  const handleEpisodeChange = async (episodeNumber: number) => {
    if (episodeNumber === currentEpisodeIndexRef.current) return;
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current && artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        cleanupPlayer();
        setIsDanmakuPluginReady(false);
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
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        cleanupPlayer();
        setIsDanmakuPluginReady(false);
        setCurrentTooltip('');
      }
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      if (artPlayerRef.current) {
        cleanupPlayer();
        setIsDanmakuPluginReady(false);
        setCurrentTooltip('');
      }
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 播放记录相关
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 收藏相关
  // ---------------------------------------------------------------------------
  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!currentSource || !currentId) return;
    (async () => {
      try {
        const fav = await isFavorited(currentSource, currentId);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [currentSource, currentId]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!currentSource || !currentId) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(currentSource, currentId);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [currentSource, currentId]);

  // 切换收藏
  const handleToggleFavorite = async () => {
    if (
      !videoTitleRef.current ||
      !detailRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(currentSourceRef.current, currentIdRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(currentSourceRef.current, currentIdRef.current, {
          title: videoTitleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  // 动态加载播放器相关库，仅在客户端
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
        danmukuPluginRef.current = artplayerPluginDanmuku;
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

  useEffect(() => {
    const Artplayer = artLibRef.current;
    const Hls = hlsLibRef.current;
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

    // 确保选集索引有效
    if (
      !detail ||
      !detail.episodes ||
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
            preparationWaitsRef.current.clear();
            setPreparationMessage('');
            let preparationTerminal = false;
            let hadPreparation = false;
            const PreparationLoader = createPreparationLoader(
              Hls.DefaultConfig.loader,
              {
                maxWaitMs: 120_000,
                filterPlaylist: blockAdEnabledRef.current
                  ? filterAdsFromM3U8
                  : undefined,
                onState: ({ id, phase, elapsedSeconds }) => {
                  if (phase === 'waiting') {
                    hadPreparation = true;
                    preparationWaitsRef.current.set(id, elapsedSeconds);
                  } else preparationWaitsRef.current.delete(id);
                  if (!preparationTerminal) {
                    const waits = Array.from(
                      preparationWaitsRef.current.values()
                    );
                    setPreparationMessage(
                      waits.length
                        ? `正在准备视频 · 已等待 ${Math.max(...waits)} 秒`
                        : ''
                    );
                  }
                },
                onTerminal: (reason) => {
                  preparationTerminal = true;
                  setPreparationMessage(
                    reason === 'MEDIA_PREPARATION_TIMEOUT'
                      ? '视频准备超时，请稍后重试或切换播放源'
                      : '视频准备失败或链接已失效，请重新选择资源'
                  );
                },
              }
            );
            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力
              lowLatencyMode: true, // 开启低延迟 LL-HLS

              /* 缓冲/内存相关 */
              maxBufferLength: 30, // 前向缓冲最大 30s，过大容易导致高延迟
              backBufferLength: 30, // 仅保留 30s 已播放内容，避免内存占用
              maxBufferSize: 60 * 1000 * 1000, // 约 60MB，超出后触发清理

              /* 自定义loader */
              loader: PreparationLoader,
            });

            const sourceKey = `${currentSourceRef.current}-${currentIdRef.current}`;
            const refreshPreparedQuality = () => {
              if (!hadPreparation || video.hls !== hls) return;
              setPrecomputedVideoInfo((previous) =>
                new Map(previous).set(sourceKey, {
                  quality: videoQualityFromWidth(video.videoWidth),
                  loadSpeed: '未知',
                  pingTime: 0,
                })
              );
            };
            video.addEventListener('loadedmetadata', refreshPreparedQuality, {
              once: true,
            });
            hls.on(Hls.Events.DESTROYING, () =>
              video.removeEventListener(
                'loadedmetadata',
                refreshPreparedQuality
              )
            );

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            ensureVideoSource(video, url);

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);
              if (preparationTerminal) {
                hls.stopLoad();
                return;
              }
              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
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

      // 监听播放状态变化，控制 Wake Lock
      artPlayerRef.current.on('play', () => {
        requestWakeLock();
      });

      artPlayerRef.current.on('pause', () => {
        releaseWakeLock();
        saveCurrentPlayProgress();
      });

      artPlayerRef.current.on('video:ended', () => {
        releaseWakeLock();
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

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on('video:timeupdate', () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        const now = Date.now();

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

      // 监听视频播放结束事件，自动播放下一集
      artPlayerRef.current.on('video:ended', () => {
        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (d && d.episodes && idx < d.episodes.length - 1) {
          setTimeout(() => {
            handleNextEpisode();
          }, 1000);
        }
      });

      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        let interval = 5000;
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }
        if (now - lastSaveTimeRef.current > interval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      artPlayerRef.current.on('pause', () => {
        saveCurrentPlayProgress();
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
      // 清理定时器
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }

      // 释放 Wake Lock
      releaseWakeLock();

      // 移除可见性监听
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 动画影院图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>
                  {loadingStage === 'searching' && '🔍'}
                  {loadingStage === 'preferring' && '⚡'}
                  {loadingStage === 'fetching' && '🎬'}
                  {loadingStage === 'ready' && '✨'}
                </div>
                {/* 旋转光环 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
              </div>

              {/* 浮动粒子效果 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>

                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 进度指示器 */}
            <div className='mb-6 w-80 mx-auto'>
              <div className='flex justify-center space-x-2 mb-4'>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${
                    loadingStage === 'searching' || loadingStage === 'fetching'
                      ? 'bg-green-500 scale-125'
                      : loadingStage === 'preferring' ||
                        loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                  }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${
                    loadingStage === 'preferring'
                      ? 'bg-green-500 scale-125'
                      : loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                  }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${
                    loadingStage === 'ready'
                      ? 'bg-green-500 scale-125'
                      : 'bg-gray-300'
                  }`}
                ></div>
              </div>

              {/* 进度条 */}
              <div className='w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden'>
                <div
                  className='h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full transition-all duration-1000 ease-out'
                  style={{
                    width:
                      loadingStage === 'searching' ||
                      loadingStage === 'fetching'
                        ? '33%'
                        : loadingStage === 'preferring'
                        ? '66%'
                        : '100%',
                  }}
                ></div>
              </div>
            </div>

            {/* 加载消息 */}
            <div className='space-y-2'>
              <p className='text-xl font-semibold text-gray-800 dark:text-gray-200 animate-pulse'>
                {loadingMessage}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 错误图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>😵</div>
                {/* 脉冲效果 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl opacity-20 animate-pulse'></div>
              </div>

              {/* 浮动错误粒子 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-red-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-orange-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-yellow-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 错误信息 */}
            <div className='space-y-4 mb-8'>
              <h2 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
                哎呀，出现了一些问题
              </h2>
              <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
                <p className='text-red-600 dark:text-red-400 font-medium'>
                  {error}
                </p>
              </div>
              <p className='text-sm text-gray-500 dark:text-gray-400'>
                请检查网络连接或尝试刷新页面
              </p>
            </div>

            {/* 操作按钮 */}
            <div className='space-y-3'>
              <button
                onClick={() =>
                  videoTitle
                    ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                    : router.back()
                }
                className='w-full px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:from-green-600 hover:to-emerald-700 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl'
              >
                {videoTitle ? '🔍 返回搜索' : '← 返回上页'}
              </button>

              <button
                onClick={() => window.location.reload()}
                className='w-full px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200'
              >
                🔄 重新尝试
              </button>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col px-0 lg:px-[5rem] 2xl:px-32'>
        {/* 播放器和选集 */}
        <div>
          <div className='grid lg:h-[500px] xl:h-[650px] 2xl:h-[750px] grid-cols-1 md:grid-cols-4 md:gap-0'>
            {/* 播放器 */}
            <div className='h-full border-0 md:border-t md:border-b md:border-l md:border-white/0 md:dark:border-white/30 md:col-span-3'>
              <div className='relative w-full h-[300px] lg:h-full'>
                <div
                  ref={artRef}
                  className='bg-black w-full h-full overflow-hidden shadow-lg'
                ></div>

                {preparationMessage && (
                  <div
                    role='status'
                    aria-live='polite'
                    className='absolute bottom-14 left-3 right-3 z-20 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-white pointer-events-none'
                  >
                    {preparationMessage}
                  </div>
                )}

                {/* 弹幕选择器 */}
                {showDanmakuSelector && (
                  <DanmakuSelector
                    videoTitle={videoTitle}
                    isVisible={showDanmakuSelector}
                    currentEpisode={currentEpisodeIndex + 1}
                    currentEpisodeTitle={
                      detail?.episodes_titles?.[currentEpisodeIndex]
                    }
                    onSelect={async (
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
                    }}
                    onClose={() => {
                      setShowDanmakuSelector(false);
                      // 更新 tooltip
                      if (artPlayerRef.current) {
                        artPlayerRef.current.setting.update({
                          name: '弹幕源',
                          tooltip: currentTooltip || '未选择',
                        });
                      }
                    }}
                  />
                )}

                {/* 换源加载蒙层 */}
                {isVideoLoading && (
                  <div className='absolute inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[500] transition-all duration-300'>
                    <div className='text-center max-w-md mx-auto px-6'>
                      {/* 动画影院图标 */}
                      <div className='relative mb-8'>
                        <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                          <div className='text-white text-4xl'>🎬</div>
                          {/* 旋转光环 */}
                          <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
                        </div>

                        {/* 浮动粒子效果 */}
                        <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                          <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
                          <div
                            className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
                            style={{ animationDelay: '0.5s' }}
                          ></div>
                          <div
                            className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
                            style={{ animationDelay: '1s' }}
                          ></div>
                        </div>
                      </div>

                      {/* 换源消息 */}
                      <div className='space-y-2'>
                        <p className='text-xl font-semibold text-white animate-pulse'>
                          {videoLoadingStage === 'sourceChanging'
                            ? '🔄 切换播放源...'
                            : videoLoadingStage === 'optimizing'
                            ? '⚡ 优选播放源...'
                            : '🔄 视频加载中...'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {/* 弹幕加载提示 */}
                {isDanmakuLoading && (
                  <div className='absolute top-4 left-4 right-4 z-[400] flex justify-center'>
                    <div className='bg-gray-800/90 text-white px-4 py-2 rounded-lg shadow-lg'>
                      正在自动加载弹幕...
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 选集和换源 */}
            <div className='h-[300px] lg:h-full md:overflow-hidden md:col-span-1'>
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                episodes_titles={detail?.episodes_titles || []}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
                precomputedVideoInfo={precomputedVideoInfo}
                preferBestSource={preferBestSource}
                setLoading={setLoading}
                setIsVideoLoading={setIsVideoLoading}
                setVideoLoadingStage={setVideoLoadingStage}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='grid grid-cols-1 gap-4'>
          {/* 文字区 */}
          <div className='w-full'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                {totalEpisodes > 1 && (
                  <span className='text-gray-500 dark:text-gray-400 text-2xl ml-3'>
                    {detail?.episodes_titles?.[currentEpisodeIndex] ||
                      `第 ${currentEpisodeIndex + 1} 集`}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite();
                  }}
                  className='ml-3 flex-shrink-0 hover:opacity-80 transition-opacity'
                >
                  <FavoriteIcon filled={favorited} />
                </button>
                {/* 下载按钮 */}
                {videoUrl && (
                  <button
                    onClick={() => setShowAddDownload(true)}
                    className='ml-3 flex-shrink-0 bg-blue-500 text-white p-2 rounded-full hover:bg-blue-600 hover:scale-[1.1] transition-all duration-300 ease-out shadow-md'
                    title='下载视频'
                  >
                    <Download className='h-4 w-4' />
                  </button>
                )}
                {/* 豆瓣链接按钮 */}
                {videoDoubanId !== 0 && (
                  <a
                    href={`https://movie.douban.com/subject/${videoDoubanId.toString()}`}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='ml-3 flex-shrink-0'
                  >
                    <div className='bg-green-500 text-white text-xs font-bold w-8 h-8 rounded-full flex items-center justify-center shadow-md hover:bg-green-600 hover:scale-[1.1] transition-all duration-300 ease-out'>
                      <svg
                        width='16'
                        height='16'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                      >
                        <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
                        <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
                      </svg>
                    </div>
                  </a>
                )}
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-3 text-base mb-4 opacity-80 flex-shrink-0'>
                {detail?.class && (
                  <span className='text-green-600 font-semibold'>
                    {detail.class}
                  </span>
                )}
                {(detail?.year || videoYear) && (
                  <span>{detail?.year || videoYear}</span>
                )}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
                {detail?.type_name && <span>{detail.type_name}</span>}
              </div>
              {/* 剧情简介 */}
              {detail?.desc && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {detail.desc}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 添加下载弹窗 */}
      <AddDownloadModal
        isOpen={showAddDownload}
        onClose={() => setShowAddDownload(false)}
        onAddTask={(config) => {
          // 触发自定义事件，通知导航栏的下载管理器
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('addDownloadTask', { detail: config })
            );
          }
          setShowAddDownload(false);
        }}
        initialUrl={videoUrl || ''}
        initialTitle={`${videoTitle}${
          totalEpisodes > 1
            ? `_${
                detail?.episodes_titles?.[currentEpisodeIndex] ||
                `第${currentEpisodeIndex + 1}集`
              }`
            : ''
        }`}
        skipConfig={skipConfig}
      />
    </PageLayout>
  );
}

// FavoriteIcon 组件
const FavoriteIcon = ({ filled }: { filled: boolean }) => {
  if (filled) {
    return (
      <svg
        className='h-7 w-7'
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444' /* Tailwind red-500 */
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return (
    <Heart className='h-7 w-7 stroke-[1] text-gray-600 dark:text-gray-300' />
  );
};

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
