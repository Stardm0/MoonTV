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
  clearDanmakuFilterConfig,
  createDanmakuFilterRule,
  DanmakuFilterConfig,
  loadDanmakuFilterConfig,
  saveDanmakuFilterConfig,
} from '@/lib/danmaku-filter';
import {
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  savePlayRecord,
  saveSkipConfig,
} from '@/lib/db.client';
import {
  EXTERNAL_PLAYERS,
  ExternalPlayerId,
  isPlayerLikelySupported,
  launchExternalPlayer,
} from '@/lib/external-player';
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
  DEFAULT_PLAYBACK_RATE,
  loadPlaybackRate,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  savePlaybackRate,
} from '@/lib/playback-rate';
import { describeHlsError, PlaybackRecovery } from '@/lib/playback-recovery';
import { getDefaultPlaybackSaveInterval } from '@/lib/playback-settings';
import { DEFAULT_VOLUME, loadVolume, saveVolume } from '@/lib/playback-volume';
import {
  buildScreenshotFilename,
  sanitizeFilenamePart,
  saveScreenshot,
  SCREENSHOT_FILENAME_PREFIX,
} from '@/lib/screenshot-save';
import {
  clearBindings,
  eventToKeyString,
  findConflicts,
  formatKeyString,
  loadBindings,
  matchesKeyString,
  resolveBindings,
  saveBindings,
  SHORTCUT_ACTIONS,
  ShortcutActionId,
  ShortcutBindings,
} from '@/lib/shortcuts';
import { SearchResult } from '@/lib/types';
import { getRequestTimeout, getVideoResolutionFromM3u8 } from '@/lib/utils';
import {
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
import { useVideoActions } from './hooks/useVideoActions';
import { useWakeLock } from './hooks/useWakeLock';
import {
  deriveLoadingState,
  formatPlayError,
  getLoadingView,
  isValidEpisodeIndex,
  LOADING_MESSAGES,
  parsePreferBestSource,
  PREFER_BEST_SOURCE_STORAGE_KEY,
  resolveEpisodeFallback,
  resolveTotalEpisodes,
  shouldClampEpisodeIndex,
  shouldFallbackEpisodeToLast,
} from './lib/playerViewState';
import { describeCacheSwitch, describeSkipConfig } from './lib/settingsLayout';
import {
  applyDanmakuFilter,
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

/**
 * 「视频缓存」分组项的 name（根面板入口）。
 *
 * 分组后真正的开关在子面板里（`CACHE_SWITCH_SETTING_NAME`），
 * 这一项只承载「缓存进度」摘要 + 展开入口。
 */
const CACHE_SETTING_NAME = '视频缓存';

/** 「视频缓存」子面板里的启用开关 */
const CACHE_SWITCH_SETTING_NAME = '启用缓存';

/** 「弹幕源」设置项的 name */
const DANMAKU_SETTING_NAME = '弹幕源';

/**
 * 「弹幕」分组项的 name（根面板入口）。
 *
 * 弹幕源与弹幕屏蔽都归到它下面，根面板不再同时出现这两个平铺项。
 */
const DANMAKU_GROUP_SETTING_NAME = '弹幕';

/** 「跳过片头片尾」分组项的 name（根面板入口） */
const SKIP_SETTING_NAME = '跳过片头片尾';

/** 「跳过片头片尾」子面板里的启用开关 */
const SKIP_ENABLE_SETTING_NAME = '启用跳过片头片尾';

/** 「设置片头 / 设置片尾」的 name */
const INTRO_SETTING_NAME = '设置片头';
const OUTRO_SETTING_NAME = '设置片尾';

/** 片头/片尾尚未设置时的占位提示 */
const INTRO_PLACEHOLDER = '设置片头时间';
const OUTRO_PLACEHOLDER = '设置片尾时间';

/**
 * 快捷键设置项的 name。
 *
 * 面板里展示的是**当前生效的键位**（默认值叠加上用户覆盖），
 * 点任意一条即可录制新键位，所以文案由 `SHORTCUT_ACTIONS` 派生，
 * 不再是写死的说明表——写死的表迟早会和实际实现漂移。
 */
const SHORTCUT_SETTING_NAME = '快捷键';

/** 「弹幕屏蔽」设置项的 name */
const DANMAKU_FILTER_SETTING_NAME = '弹幕屏蔽';

/**
 * 快捷键子面板里「恢复默认键位」这一条的 value。
 *
 * 用 `__` 包裹以区别于动作 id（`ShortcutActionId` 都是普通单词，不会撞）。
 */
const SHORTCUT_RESET_VALUE = '__reset__';

/**
 * 组装「弹幕屏蔽」子面板的选项列表。
 *
 * 结构：每条已存规则（点击切换启停）+ 添加入口 + 清空入口。
 * `value` 用规则 id，与快捷键面板同理 —— 文案会随启停状态变化，
 * 用稳定 id 才能让 ArtPlayer 的 selector 缓存复用节点。
 */
function buildDanmakuFilterOptions(
  config: DanmakuFilterConfig
): Array<{ html: string; value: string }> {
  const list = config.rules.map((rule) => ({
    html: `${rule.enabled ? '开' : '关'}  ·  ${
      rule.type === 'regex' ? '正则' : '关键词'
    }  ·  ${rule.keyword}`,
    value: rule.id,
  }));

  list.push({ html: '＋ 添加屏蔽词', value: '__add__' });

  if (config.rules.length) {
    list.push({ html: '清空全部规则', value: '__clear__' });
  }

  return list;
}

/** 组装「弹幕屏蔽」设置项的 tooltip */
function buildDanmakuFilterTooltip(config: DanmakuFilterConfig): string {
  const enabled = config.rules.filter((rule) => rule.enabled).length;
  if (!config.rules.length) return '未设置';
  return enabled === config.rules.length
    ? `${enabled} 条生效`
    : `${enabled}/${config.rules.length} 条生效`;
}

/**
 * 组装「外部播放器」下拉项。
 *
 * 用运行时的 `navigator.userAgent` 过滤明显不适用的项：
 * 手机上没有 PotPlayer/MPV，桌面上也没有 MX Player。
 * 但**不做"是否已安装"判断** —— 浏览器不提供这种能力，
 * 声称能检测的写法都是靠超时猜测，误判率高。
 */
function buildExternalPlayerOptions(): Array<{
  html: string;
  value: ExternalPlayerId;
}> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return EXTERNAL_PLAYERS.filter((player) =>
    isPlayerLikelySupported(player.id, ua)
  ).map((player) => ({ html: player.label, value: player.id }));
}

/**
 * 「外部播放器」控制栏按钮的图标。
 *
 * 抽成常量是**必需**的，不是风格偏好：ArtPlayer 的 selector 点击后会
 * 用 `onSelect` 的返回值覆盖按钮内容（见该控制项上的注释），所以这个 HTML
 * 必须同时出现在 `html` 与 `onSelect` 的返回值里。抽成常量可以保证
 * 两处**永远一致** —— 否则改图标时只改一处，点一次就露馅。
 */
const EXTERNAL_PLAYER_CONTROL_ICON =
  '<i class="art-icon flex"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></i>';

/**
 * 组装「快捷键」子面板的选项列表。
 *
 * `value` 用动作 id 而不是按键串：按键串会随改键变化，
 * 而 ArtPlayer 的 selector 缓存是按 value 做键的，用 id 才能稳定复用节点。
 */
function buildShortcutOptions(
  bindings: Record<ShortcutActionId, string>,
  recorderId?: ShortcutActionId | null
): Array<{ html: string; value: string }> {
  const list: Array<{ html: string; value: string }> = SHORTCUT_ACTIONS.map(
    (action) => ({
    html:
      action.id === recorderId
        ? `${action.label}  ·  按下新按键…`
        : `${action.label}  ·  ${formatKeyString(bindings[action.id])}`,
      value: action.id,
    })
  );

  // 「恢复默认」并入键位列表末尾，不再单独占一个根面板行。
  // 它本来就是键位面板的一部分，跟着键位走更好找。
  list.push({ html: '↺  恢复默认键位', value: SHORTCUT_RESET_VALUE });

  return list;
}

/**
 * 组装「快捷键」设置项的 tooltip。
 *
 * 有自定义键位时提示条数，用户才知道自己改过键（否则换了设备会
 * 困惑"为什么按键不一样"）。
 */
function buildShortcutTooltip(overrides: ShortcutBindings): string {
  const count = Object.keys(overrides).length;
  return count > 0 ? `已自定义 ${count} 项` : '点击可改键';
}

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
  const [selectedDanmakuEpisode, setSelectedDanmakuEpisode] = useState<
    number | undefined
  >(undefined);
  const [showDanmakuSelector, setShowDanmakuSelector] = useState(false);
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

  /**
   * 用「颜色已修正」的弹幕数据覆盖插件自行解析的结果。
   *
   * 插件内部的颜色解析是 `#${Number(t[3]).toString(16)}`，缺补零，
   * 深色系弹幕会变成透明或错误颜色。这里改为由我们解析并补零。
   *
   * 失败时静默保留插件已加载的弹幕 —— 宁可颜色有损，也不能没有弹幕。
   *
   * 注意：本函数引用的 ref 均在其下方声明。这只在「函数体延迟执行」时成立，
   * 因此它只能被 effect / 事件回调调用，不可在渲染期直接调用。
   */
  const applyCorrectedDanmaku = async (url: string) => {
    if (!url || correctedDanmakuUrlRef.current === url) return;
    if (!danmukuPluginInstanceRef.current) return;

    try {
      const { fetchPluginDanmaku } = await import('@/lib/danmaku.client');
      const list = await fetchPluginDanmaku(url);

      // 解析期间可能已切集/切源，此时结果已过期，丢弃
      if (lastDanmakuUrlRef.current !== url) return;
      if (!list.length) return;

      // 二次确认插件实例仍在，且没被换集重建
      if (!danmukuPluginInstanceRef.current) return;
      danmukuPluginInstanceRef.current.config({ danmuku: list });
      await danmukuPluginInstanceRef.current.load();

      correctedDanmakuUrlRef.current = url;
      console.log(`弹幕颜色已修正: ${list.length} 条`);
    } catch (err) {
      console.warn('弹幕颜色修正失败，沿用插件原始解析:', err);
    }
  };

  // 用户手动/自动选择弹幕番剧后，加载对应集的弹幕
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
        if (
          danmukuPluginInstanceRef.current &&
          url !== lastDanmakuUrlRef.current
        ) {
          console.log('动态更新弹幕源:', url);
          // 先把地址交给插件：即使后续解析失败，弹幕也已经能显示出来。
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

          // 再用「已修正颜色」的数据覆盖一遍。
          // 插件自行解析时会丢掉 hex 的前导零，导致深色系弹幕
          // 透明/变色（见 lib/danmaku-color.ts）。这里接管解析。
          void applyCorrectedDanmaku(url);
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
  const totalEpisodes = resolveTotalEpisodes(detail);

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量。初值取记住的偏好，保证首次播放就用对音量。
  const lastVolumeRef = useRef<number>(loadVolume());
  // 上次使用的播放速率。同样以记住的偏好为初值。
  const lastPlaybackRateRef = useRef<number>(loadPlaybackRate());
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
  /** 已应用「颜色修正」的弹幕地址，避免同一集重复解析 */
  const correctedDanmakuUrlRef = useRef<string>('');
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
  /**
   * 标记「正在加载新源」。
   *
   * 期间浏览器会把 playbackRate 重置为 1，这个 1 不是用户的选择，
   * 不能写进倍速偏好（否则用户设的 1.5x 会被悄悄清掉）。
   */
  const isSwitchingSourceRef = useRef(false);
  /**
   * 当前生效的快捷键绑定（动作 → 按键串）。
   *
   * keydown 监听器只注册一次，直接读 state 会拿到过期闭包，
   * 因此走 ref；改键后由设置面板同步刷新它。
   */
  const shortcutBindingsRef = useRef<Record<ShortcutActionId, string>>(
    resolveBindings(loadBindings())
  );
  /**
   * 用户的键位覆盖表（只存改过的那几项）。
   *
   * 与 `shortcutBindingsRef`（合并默认值后的全量表）分开存：
   * 「恢复默认」只需要清空覆盖表，不必逐项比对默认值。
   */
  const shortcutOverridesRef = useRef<ShortcutBindings>(loadBindings());
  /**
   * 正在等待用户按键的动作 id。
   *
   * 非 null 时全局 keydown 进入"录制模式"：吞掉按键只做绑定，
   * 不执行任何播放器操作——否则用户按 `←` 想改键，视频会先倒回去 10 秒。
   */
  const shortcutRecorderRef = useRef<ShortcutActionId | null>(null);
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

        // 播放器已销毁，弹幕插件实例随之失效。
        // 必须清掉这两个 ref，否则重建后 URL 与旧值相同会被判定为
        // 「已加载过」而跳过，导致新实例退回插件原始解析（颜色有损）。
        lastDanmakuUrlRef.current = '';
        correctedDanmakuUrlRef.current = '';

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

  /**
   * 把「跳过片头片尾」分组的三处状态一次性刷新到面板上。
   *
   * 全走 DOM setter（`artplayer-setting.ts`），**不**用 `setting.update()`：
   * `update()` 会无条件 `render()` 把面板弹回根面板，而改片头/片尾是在
   * 子面板里操作的，弹回去等于每改一次都要重新点进来。
   */
  const refreshSkipPanel = () => {
    const art = artPlayerRef.current;
    if (!art) return;

    const config = skipConfigRef.current;
    setSettingTooltip(art, SKIP_SETTING_NAME, describeSkipConfig(config));
    setSettingSwitch(art, SKIP_ENABLE_SETTING_NAME, config.enable);
    setSettingTooltip(
      art,
      INTRO_SETTING_NAME,
      config.intro_time === 0
        ? INTRO_PLACEHOLDER
        : formatTime(config.intro_time)
    );
    setSettingTooltip(
      art,
      OUTRO_SETTING_NAME,
      config.outro_time >= 0
        ? OUTRO_PLACEHOLDER
        : `-${formatTime(-config.outro_time)}`
    );
  };

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: SkipConfig) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
      } else {
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          newConfig
        );
      }
      // 无论存/删都同步一次面板：开关、片头、片尾、分组摘要四处状态同源
      refreshSkipPanel();
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
    if (!isValidEpisodeIndex(detail.episodes.length, currentEpisodeIndex)) {
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
        shouldFallbackEpisodeToLast(
          detailData.episodes.length,
          currentEpisodeIndex
        )
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
      setLoadingMessage(LOADING_MESSAGES.ready);
      setTimeout(() => setLoading(false), 500);
    }
    const initAll = async () => {
      const hasAnyParam = Boolean(
        currentSource || currentId || videoTitle || searchTitle
      );
      const initialLoading = deriveLoadingState({
        hasDetailTarget: Boolean(currentSource && currentId),
        hasAnyParam,
      });
      if (!initialLoading) {
        setError(formatPlayError('missing-params'));
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadingStage(initialLoading.stage);
      setLoadingMessage(initialLoading.message);
      // 从 localStorage 读取是否启用优选播放源（避免状态延迟）
      const enablePreferBestSourceFromStorage = parsePreferBestSource(
        typeof window === 'undefined'
          ? null
          : localStorage.getItem(PREFER_BEST_SOURCE_STORAGE_KEY)
      );

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
      // （影库条目在搜索聚合里往往对不上 id：OpenList 的 id 是文件路径，
      //  Emby 的 id 是内部条目 ID。所以先给影库一次直接取详情的机会）
      if (
        !detailData &&
        (currentSource === 'openlist' || currentSource === 'emby') &&
        currentId
      ) {
        try {
          const directRes = await fetch(
            `/api/detail?source=${currentSource}&id=${encodeURIComponent(currentId)}`
          );
          if (directRes.ok) {
            const directData = (await directRes.json()) as SearchResult;
            if (directData?.episodes?.length) {
              allResults.push(directData);
              detailData = directData;
            }
          }
        } catch {
          // 直取失败就继续走原有的 fallback 逻辑
        }
      }

      if (!detailData && allResults.length > 0) {
        detailData = allResults[0];
      }

      // 完全没结果
      if (!detailData) {
        setError(formatPlayError('no-match'));
        setLoading(false);
        return;
      }

      if (enablePreferBestSourceFromStorage && allResults.length > 1) {
        const preferringLoading = getLoadingView('preferring');
        setLoadingStage(preferringLoading.stage);
        setLoadingMessage(preferringLoading.message);
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
      // 新源加载期间 playbackRate 会被重置为 1，不要把它写进偏好
      isSwitchingSourceRef.current = true;

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
    console.warn(
      `[auto-switch] ${reason} → ${candidate.source}:${candidate.id}`
    );
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

  // 处理集数切换
  const handleEpisodeChange = async (episodeNumber: number) => {
    if (episodeNumber === currentEpisodeIndexRef.current) return;
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      isEpisodeSwitchingRef.current = true;
      isSwitchingSourceRef.current = true;
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
      isSwitchingSourceRef.current = true;
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
      isSwitchingSourceRef.current = true;
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

  /**
   * 把「快捷键」子面板刷新成最新键位，并**返回写进去的 tooltip 文本**。
   *
   * 必须走 `updateSettingPreservingPanel` 而不是裸 `update()`：
   * 用户是在子面板里点的某一条改键，裸 `update()` 会把他弹回根面板，
   * 表现就是"改一个键就得重新点进来一次"。
   *
   * 之所以要有返回值：设置面板 selector 的 `onSelect` 返回值会被写成
   * `$parent.tooltip`（见 `onSelect` 处的说明）。若那边 `return ''`，就会把
   * 这里刚写好的摘要清空。返回同一个字符串，保证两处写入一致。
   */
  const refreshShortcutPanel = (): string => {
    updateSettingPreservingPanel(artPlayerRef.current, {
      name: SHORTCUT_SETTING_NAME,
      selector: buildShortcutOptions(shortcutBindingsRef.current),
    });
    const tooltip = buildShortcutTooltip(shortcutOverridesRef.current);
    setSettingTooltip(artPlayerRef.current, SHORTCUT_SETTING_NAME, tooltip);
    return tooltip;
  };

  /** 进入录制态：面板上提示"请按键"，并记住要改哪个动作 */
  const startShortcutRecording = (actionId: ShortcutActionId) => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
    if (!action || !action.customizable) return;

    shortcutRecorderRef.current = actionId;
    if (artPlayerRef.current) {
      artPlayerRef.current.notice.show = `请按下新的按键：${action.label}（Esc 取消）`;
    }

    // 把该条在面板上标成"待录入"，用户才知道系统在等他按键
    updateSettingPreservingPanel(artPlayerRef.current, {
      name: SHORTCUT_SETTING_NAME,
      selector: buildShortcutOptions(shortcutBindingsRef.current, actionId),
    });
  };

  /**
   * 提交录制结果。返回 true 表示这次按键已被录制流程消费。
   *
   * 三种情况：
   * - Esc → 取消录制
   * - 单按修饰键 → 不是有效绑定，继续等待
   * - 其它 → 落库并退出录制
   */
  const commitShortcutRecording = (e: KeyboardEvent): boolean => {
    const actionId = shortcutRecorderRef.current;
    if (!actionId) return false;

    if (e.key === 'Escape') {
      shortcutRecorderRef.current = null;
      if (artPlayerRef.current) {
        artPlayerRef.current.notice.show = '已取消改键';
      }
      return true;
    }

    const keyString = eventToKeyString(e);
    if (!keyString) return false; // 只按了修饰键，继续等

    const conflicts = findConflicts(
      shortcutBindingsRef.current,
      keyString,
      actionId
    );

    // 冲突则接管：把占用该键的**其它**动作恢复默认，
    // 否则两个动作会同时响应同一个键。比直接拒绝更符合直觉
    // （用户想用这个键，那就给他）。
    const nextOverrides: ShortcutBindings = { ...shortcutOverridesRef.current };
    for (const conflictingId of conflicts) {
      delete nextOverrides[conflictingId];
    }

    const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
    if (action && keyString === action.defaultKeys) {
      // 改回默认值 = 取消这项自定义，别在存储里留冗余
      delete nextOverrides[actionId];
    } else {
      nextOverrides[actionId] = keyString;
    }

    shortcutOverridesRef.current = nextOverrides;
    shortcutBindingsRef.current = resolveBindings(nextOverrides);
    saveBindings(nextOverrides);
    shortcutRecorderRef.current = null;

    const conflictNames = conflicts
      .map((id) => SHORTCUT_ACTIONS.find((a) => a.id === id)?.label)
      .filter(Boolean)
      .join('、');

    if (artPlayerRef.current) {
      const suffix = conflictNames ? `（${conflictNames} 已恢复默认）` : '';
      artPlayerRef.current.notice.show = `已绑定 ${formatKeyString(
        keyString
      )}${suffix}`;
    }

    refreshShortcutPanel();
    return true;
  };

  /** 「恢复默认键位」：清空覆盖表并刷新面板 */
  const resetShortcutBindings = () => {
    clearBindings();
    shortcutOverridesRef.current = {};
    shortcutBindingsRef.current = resolveBindings({});
    shortcutRecorderRef.current = null;
    if (artPlayerRef.current) {
      artPlayerRef.current.notice.show = '已恢复默认键位';
    }
    refreshShortcutPanel();
  };

  /**
   * 刷新「弹幕屏蔽」子面板，并**返回写进去的 tooltip 文本**。
   *
   * 与快捷键面板同理必须走 `updateSettingPreservingPanel`：用户是在子面板里
   * 点某条规则切换启停的，裸 `update()` 会把他弹回根面板。
   * 返回值供 `onSelect` 回传，避免返回值把刚写好的摘要清空。
   */
  const refreshDanmakuFilterPanel = (): string => {
    const config = loadDanmakuFilterConfig();
    updateSettingPreservingPanel(artPlayerRef.current, {
      name: DANMAKU_FILTER_SETTING_NAME,
      selector: buildDanmakuFilterOptions(config),
    });
    const tooltip = buildDanmakuFilterTooltip(config);
    setSettingTooltip(
      artPlayerRef.current,
      DANMAKU_FILTER_SETTING_NAME,
      tooltip
    );
    return tooltip;
  };

  /**
   * 用外部播放器打开当前视频。
   *
   * 取地址一律走 `currentVideoUrlRef`（实时地址）而不是闭包里的 `videoUrl` ——
   * 与预取器同理：切集时播放器实例被复用，闭包变量不会更新，
   * 会把**上一集**的地址交给外部播放器。
   *
   * 外链地址优先用原始地址而非同源代理：外部播放器能直连大多数源站，
   * 绕一层代理反而增加失败面（且代理需要 token，很多播放器不会带）。
   */
  const openInExternalPlayer = (playerId: ExternalPlayerId) => {
    const url = currentVideoUrlRef.current;
    if (!url) {
      if (artPlayerRef.current) {
        artPlayerRef.current.notice.show = '当前没有可用的视频地址';
      }
      return;
    }

    const title = detailRef.current?.title || '';
    const ok = launchExternalPlayer(playerId, url, title);
    const playerLabel =
      EXTERNAL_PLAYERS.find((p) => p.id === playerId)?.label || '外部播放器';

    if (artPlayerRef.current) {
      // 浏览器**无法**判断客户端是否真的装了（不提供这种能力），
      // 所以不能在失败时说「未安装」—— 那是猜测。文案只陈述事实：
      // 已经把这个地址交给系统了，没反应就是没装或被拦。
      artPlayerRef.current.notice.show = ok
        ? `已交给系统打开，若无反应请确认已安装 ${playerLabel}`
        : `无法唤起 ${playerLabel}`;
    }
  };

  // 处理全局快捷键
  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    // 忽略输入框中的按键事件
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    const art = artPlayerRef.current;

    // 录制模式优先：此时按键只用于绑定，不触发播放器操作
    if (shortcutRecorderRef.current) {
      const recorded = commitShortcutRecording(e);
      if (recorded) return;
      // 无效按键（单按修饰键）继续往下走，让 Esc 之类的兜底逻辑生效
    }

    const bindings = shortcutBindingsRef.current;

    /**
     * 依次尝试每个动作，命中即执行并阻止默认行为。
     *
     * 用「动作 → 处理器」的映射表替代原先一串 if：新增动作只需
     * 在 lib/shortcuts.ts 注册 + 在这里补一个处理器，
     * 不必再手写按键判断（那正是键位无法自定义的原因）。
     */
    const run = (
      actionId: ShortcutActionId,
      handler: () => boolean
    ): boolean => {
      const keyString = bindings[actionId];
      if (!keyString) return false;
      if (!matchesKeyString(e, keyString)) return false;
      if (!handler()) return false;
      e.preventDefault();
      return true;
    };

    run('prevEpisode', () => {
      if (detailRef.current && currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        return true;
      }
      return false;
    });

    run('nextEpisode', () => {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (d && idx < d.episodes.length - 1) {
        handleNextEpisode();
        return true;
      }
      return false;
    });

    run('seekBackward', () => {
      if (art && art.currentTime > 5) {
        art.currentTime -= 10;
        return true;
      }
      return false;
    });

    run('seekForward', () => {
      if (art && art.currentTime < art.duration - 5) {
        art.currentTime += 10;
        return true;
      }
      return false;
    });

    run('volumeUp', () => {
      if (art && art.volume < 1) {
        art.volume = Math.round((art.volume + 0.1) * 10) / 10;
        art.notice.show = `音量: ${Math.round(art.volume * 100)}`;
        return true;
      }
      return false;
    });

    run('volumeDown', () => {
      if (art && art.volume > 0) {
        art.volume = Math.round((art.volume - 0.1) * 10) / 10;
        art.notice.show = `音量: ${Math.round(art.volume * 100)}`;
        return true;
      }
      return false;
    });

    run('toggleMute', () => {
      if (!art) return false;
      art.muted = !art.muted;
      art.notice.show = art.muted ? '已静音' : '已取消静音';
      return true;
    });

    run('togglePlay', () => {
      if (!art) return false;
      art.toggle();
      return true;
    });

    run('toggleFullscreen', () => {
      if (!art) return false;
      art.fullscreen = !art.fullscreen;
      return true;
    });

    run('screenshot', () => {
      if (!art || typeof art.screenshot !== 'function') return false;
      // 失败提示在 ready 的包装里统一处理（跨域保护 / 数据无效），
      // 这里只兜住 Promise，避免 unhandled rejection。
      void Promise.resolve(art.screenshot()).catch(() => {
        /* 已提示 */
      });
      return true;
    });

    run('toggleDanmaku', () => {
      const plugin = danmukuPluginInstanceRef.current;
      if (!plugin) return false;
      const nextVisible =
        typeof plugin.visible === 'boolean' ? !plugin.visible : true;
      plugin.config({ visible: nextVisible });
      danmakuConfigRef.current.visible = nextVisible;
      if (art) {
        art.notice.show = nextVisible ? '弹幕已开启' : '弹幕已关闭';
      }
      return true;
    });

    // 倍速微调：每次 0.25x，钳制在 [0.5, 3]
    const adjustPlaybackRate = (delta: number) => {
      if (!art) return false;
      const next = Math.round((art.playbackRate + delta) * 100) / 100;
      const clamped = Math.min(
        MAX_PLAYBACK_RATE,
        Math.max(MIN_PLAYBACK_RATE, next)
      );
      if (clamped === art.playbackRate) return false;
      art.playbackRate = clamped;
      art.notice.show = `倍速: ${clamped}x`;
      // 手动调节倍速属于明确意愿，直接记住
      savePlaybackRate(clamped);
      return true;
    };

    run('speedUp', () => adjustPlaybackRate(0.25));
    run('speedDown', () => adjustPlaybackRate(-0.25));
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
    // 监听器只注册一次；内部读 ref，因此不会因为改键而失效
  }, []);

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
      currentEpisodeIndex !== null &&
      shouldClampEpisodeIndex(detail.episodes.length, currentEpisodeIndex)
    ) {
      const fallback = resolveEpisodeFallback(
        detail.episodes.length,
        currentEpisodeIndex
      );
      setCurrentEpisodeIndex(fallback.action === 'keep' ? 0 : fallback.index);
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
      !isValidEpisodeIndex(detail.episodes.length, currentEpisodeIndex)
    ) {
      setError(formatPlayError('invalid-episode-index', { totalEpisodes }));
      return;
    }

    if (!videoUrl) {
      setError(formatPlayError('invalid-video-url'));
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

      // 设置面板尺寸。默认 250×35 太挤：面板里既要放标签，又要放状态摘要
      // （如「当前：电影下载」），250px 下两者必然贴在一起。
      //
      // ⚠️ 必须走这两个**公开静态属性**，不要用 CSS `min-width` 硬撑 ——
      // `setting.resize()` 会用 SETTING_WIDTH 反算面板的 left 与 width，
      // 从 CSS 侧改宽度会让它算出来的位置对不上，面板越出播放器右缘。
      Artplayer.SETTING_WIDTH = 320;
      Artplayer.SETTING_ITEM_HEIGHT = 44;

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
        // 进度写在分组项上（根面板一眼可见），开关状态写在子面板的开关项上
        setSettingTooltip(art, CACHE_SETTING_NAME, text);
        if (switchState !== undefined) {
          setSettingSwitch(art, CACHE_SWITCH_SETTING_NAME, switchState);
          setSettingTooltip(
            art,
            CACHE_SWITCH_SETTING_NAME,
            describeCacheSwitch(switchState)
          );
        }
      };

      // 注：「截图保存位置」（可选目录 / File System Access）能力已整体移除。
      // 原因见 src/lib/screenshot-save.ts 的头部说明：目录权限不跨会话保留、
      // 非 Chromium 浏览器不支持，实际表现为「设置写着某目录、截图却存到下载
      // 文件夹」——一个兑现不了的承诺。现在截图固定走浏览器下载目录。

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
        const key = `${currentSourceRef.current}:${
          currentIdRef.current
        }:${nextIndex}:${preferred ?? 'auto'}`;
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

      /**
       * 「弹幕屏蔽」设置项。
       *
       * 抽成变量是因为它是「弹幕」分组的**子项**，而设置面板是嵌套的对象字面量，
       * 写在 `settings: []` 里就得把整块缩进搬进分组内部。抽出来后分组结构
       * （见下方 `settings`）能一眼看全，也不会在移动时漏掉这段逻辑。
       */
      const danmakuFilterSettingItem = {
        name: DANMAKU_FILTER_SETTING_NAME,
        html: '弹幕屏蔽',
        tooltip: buildDanmakuFilterTooltip(loadDanmakuFilterConfig()),
        selector: buildDanmakuFilterOptions(loadDanmakuFilterConfig()),
        onSelect: function (item: any) {
          const value = item?.value;
          const config = loadDanmakuFilterConfig();

          // 「＋ 添加规则」用 prompt 就地输入。播放页是全屏沉浸场景，
          // 弹一个独立模态会打断观看；prompt 由浏览器渲染在顶层，
          // 也不会被播放器的全屏层遮住。
          if (value === '__add__') {
            const input =
              typeof window !== 'undefined'
                ? window.prompt(
                    '输入要屏蔽的关键词（在词首加 re: 使用正则）',
                    ''
                  )
                : null;
            if (input && input.trim()) {
              const raw = input.trim();
              const isRegex = raw.startsWith('re:');
              const created = createDanmakuFilterRule(
                isRegex ? raw.slice(3) : raw,
                isRegex ? 'regex' : 'normal'
              );
              if (!created) {
                if (artPlayerRef.current) {
                  artPlayerRef.current.notice.show = isRegex
                    ? '正则表达式不合法'
                    : '关键词不能为空';
                }
              } else {
                const next = [...config.rules, created];
                saveDanmakuFilterConfig({ rules: next });
                applyDanmakuFilter(danmukuPluginInstanceRef.current, next);
                if (artPlayerRef.current) {
                  artPlayerRef.current.notice.show = `已屏蔽「${created.keyword}」`;
                }
              }
            }
            // ⚠️ 返回刷新后的摘要，不能返回空串 —— 设置面板 selector 的
            // 返回值会被写成 `$parent.tooltip`，返回 '' 会把刚写好的摘要清空。
            return refreshDanmakuFilterPanel();
          }

          // 「清空」一键移除全部规则
          if (value === '__clear__') {
            clearDanmakuFilterConfig();
            applyDanmakuFilter(danmukuPluginInstanceRef.current, []);
            if (artPlayerRef.current) {
              artPlayerRef.current.notice.show = '已清空屏蔽规则';
            }
            return refreshDanmakuFilterPanel();
          }

          // 点击某条规则 = 切换启用/停用
          const target = config.rules.find((r) => r.id === value);
          if (target) {
            const next = config.rules.map((r) =>
              r.id === value ? { ...r, enabled: !r.enabled } : r
            );
            saveDanmakuFilterConfig({ rules: next });
            applyDanmakuFilter(danmukuPluginInstanceRef.current, next);
            if (artPlayerRef.current) {
              artPlayerRef.current.notice.show = target.enabled
                ? `已停用「${target.keyword}」`
                : `已启用「${target.keyword}」`;
            }
            return refreshDanmakuFilterPanel();
          }
          // 没命中任何规则（选项被重建过）：只回显，不白改 tooltip
          return buildDanmakuFilterTooltip(config);
        },
      };

      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: videoUrl,
        poster: videoCover,
        volume: loadVolume(),
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

            hls.on(
              Hls.Events.LEVEL_SWITCHED,
              function (_event: any, data: any) {
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
              }
            );

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
          // ---- 「跳过片头片尾」分组：开关 + 两个时间点 + 清除入口 ----
          {
            name: SKIP_SETTING_NAME,
            html: SKIP_SETTING_NAME,
            tooltip: describeSkipConfig(skipConfigRef.current),
            selector: [
              {
                name: SKIP_ENABLE_SETTING_NAME,
                html: '启用跳过',
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
                name: INTRO_SETTING_NAME,
                html: INTRO_SETTING_NAME,
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
                tooltip:
                  skipConfigRef.current.intro_time === 0
                    ? INTRO_PLACEHOLDER
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
                name: OUTRO_SETTING_NAME,
                html: OUTRO_SETTING_NAME,
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
                tooltip:
                  skipConfigRef.current.outro_time >= 0
                    ? OUTRO_PLACEHOLDER
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
                html: '删除跳过配置',
                onClick: function () {
                  handleSkipConfigChange({
                    enable: false,
                    intro_time: 0,
                    outro_time: 0,
                  });
                  // 显式返回空串，**不要省略 return**：设置面板 button 项的返回值会被
                  // 写成 `e.tooltip`（`e.tooltip = await onClick(...)`），省略即写入
                  // undefined，而它会被 append 进 tooltip 节点、渲染出字面量 "undefined"。
                  return '';
                },
              },
            ],
          },
          // ---- 「弹幕」分组：弹幕源 + 屏蔽规则 ----
          {
            name: DANMAKU_GROUP_SETTING_NAME,
            html: DANMAKU_GROUP_SETTING_NAME,
            tooltip: '弹幕源 · 屏蔽规则',
            selector: [
              {
                name: DANMAKU_SETTING_NAME,
                html: DANMAKU_SETTING_NAME,
                tooltip: currentTooltip || '未选择',
                onClick: function () {
                  setShowDanmakuSelector(true);
                },
              },
              danmakuFilterSettingItem,
            ],
          },
          // ---- 「视频缓存」分组：开关 + 缓存管理入口 ----
          //
          // 分组项右侧放**进度摘要**（预取回调按分片频率刷新），
          // 开关状态放在子面板里 —— 两处职责不同，不要合并成一处。
          {
            name: CACHE_SETTING_NAME,
            html: CACHE_SETTING_NAME,
            tooltip: loadCacheSettings().enabled ? '未开始' : '已关闭',
            selector: [
              {
                name: CACHE_SWITCH_SETTING_NAME,
                html: CACHE_SWITCH_SETTING_NAME,
                switch: loadCacheSettings().enabled,
                tooltip: describeCacheSwitch(loadCacheSettings().enabled),
                onSwitch: function (item: any) {
                  const enabled = !item.switch;
                  saveCacheSettings({ enabled });
                  if (enabled) {
                    updateCacheTooltip('未开始');
                    ensurePrefetchCurrent(
                      artPlayerRef.current?.currentTime || 0
                    );
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
                html: '缓存管理',
                onClick: function () {
                  setShowCacheManager(true);
                  // 同「删除跳过配置」：空串是刻意返回的，省略 return 会写入 undefined。
                  return '';
                },
              },
            ],
          },
          {
            // 快捷键面板。用 selector 而非 onClick，才能展开成子面板
            // 逐条列出按键（onClick 只会执行动作、不展示内容）。
            // 点某一条进入录制态，再按任意组合键即可完成改键。
            name: SHORTCUT_SETTING_NAME,
            html: SHORTCUT_SETTING_NAME,
            tooltip: buildShortcutTooltip(shortcutOverridesRef.current),
            selector: buildShortcutOptions(shortcutBindingsRef.current),
            onSelect: function (item: any) {
              // 「恢复默认键位」并入了键位列表，作为一条特殊选项
              if (item?.value === SHORTCUT_RESET_VALUE) {
                resetShortcutBindings();
                // 同其它 selector：返回值会被写成 `$parent.tooltip`，
                // 返回 '' 会把刚写好的摘要清空，所以回显摘要本身。
                return buildShortcutTooltip(shortcutOverridesRef.current);
              }

              const actionId = item?.value as ShortcutActionId | undefined;
              if (actionId) {
                startShortcutRecording(actionId);
              }
              // ⚠️ 返回**当前键位摘要**，不能返回空串。
              //
              // 设置面板 selector 的返回值会被写成 `$parent.tooltip`：
              //   e.$parent.tooltip = await e.$parent.onSelect.call(...)
              // 返回 '' 会把本项声明的摘要（当前键位一览）清空。
              // 录制是在 keydown 里完成的（commitShortcutRecording →
              // refreshShortcutPanel），此处只需回显、不要覆盖成空。
              return buildShortcutTooltip(shortcutOverridesRef.current);
            },
          },
          // 去广告放在最后：它会销毁并重建播放器，属于低频操作，
          // 不该挤在高频入口（画质 / 弹幕 / 缓存）前面。
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
          {
            // 外部播放器。做成一个下拉而不是 6 个平铺按钮：
            // 控制栏空间有限，且这些按钮对多数用户根本用不到，
            // 平铺会挤压播放/进度等高频控件。
            position: 'right',
            index: 10,
            name: 'external-player',
            html: EXTERNAL_PLAYER_CONTROL_ICON,
            tooltip: '用外部播放器打开',
            selector: buildExternalPlayerOptions(),
            onSelect: function (item: any) {
              const playerId = item?.value as ExternalPlayerId | undefined;
              if (playerId) {
                openInExternalPlayer(playerId);
              }
              // ⚠️ 必须返回**控制栏图标本身**，不能返回空串。
              //
              // artplayer@5.3.0 的 selector 点击处理是：
              //   this.check(a)                                    // 写入 item.html
              //   o.innerHTML = await e.onSelect.call(...)          // 再用返回值覆盖
              // 其中 `o` 就是承载控制栏按钮内容的 `.art-selector-value`
              // （初始化时 `append(o, e.html)`）。所以**返回值会替换掉按钮的图标** ——
              // 返回 '' 会让图标点一次就消失（用户实际报障的现象）。
              // 这里固定返回图标 HTML，保持按钮外观不变。
              return EXTERNAL_PLAYER_CONTROL_ICON;
            },
          },
        ],
      });

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
        setError(null);

        // 截图：跨域保护翻译 + 存到浏览器下载目录。
        //
        // 两件事必须一起做，否则用户依然困惑：
        // 1) ArtPlayer 的截图是裸的 drawImage + toDataURL，视频被标记为跨域
        //    污染时会抛 SecurityError，用户只看到一句英文报错 —— 翻译成中文。
        // 2) 原生实现走 `<a download>`，文件名带冒号（`artplayer_00:12:34.png`）
        //    会被 Windows 拒绝。这里改成自己生成合法文件名，并明确告知
        //    「存到了浏览器下载文件夹」—— 页面**拿不到落盘路径**（浏览器安全模型），
        //    所以绝不编造具体路径。详见 src/lib/screenshot-save.ts。
        try {
          const art: any = artPlayerRef.current;
          const originalScreenshot = art.screenshot?.bind(art);
          if (typeof originalScreenshot === 'function') {
            art.screenshot = async (name?: string) => {
              let dataUrl: string;
              try {
                // 用 getDataURL 自己取数据，绕开原生 screenshot 的下载行为
                // （我们要自己决定文件名与落盘位置）。
                dataUrl =
                  typeof art.getDataURL === 'function'
                    ? await art.getDataURL()
                    : await originalScreenshot(name);
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : String(err);
                if (/tainted|SecurityError|insecure/i.test(message)) {
                  art.notice.show =
                    '当前片源限制截图（跨域保护），可先下载后再截图';
                } else {
                  art.notice.show = '截图失败';
                  console.warn('截图失败:', err);
                }
                throw err;
              }

              // 自定义了名字就尊重调用方（并补上 .png），否则按进度 + 标题生成
              const filename =
                typeof name === 'string' && name.trim()
                  ? `${
                      sanitizeFilenamePart(name, 60) ||
                      SCREENSHOT_FILENAME_PREFIX
                    }.png`
                  : buildScreenshotFilename({
                      currentTime: art.currentTime || 0,
                      title: detailRef.current?.title || '',
                    });

              const result = await saveScreenshot(dataUrl, filename);
              art.notice.show = result.message;
              // 保留原生事件（下载插件等可能依赖），但不影响上面的提示
              try {
                art.emit?.('screenshot', dataUrl);
              } catch {
                /* 事件订阅方出错不影响截图结果 */
              }
              return dataUrl;
            };
          }
        } catch {
          // 包装失败不应影响播放
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

      // 设置面板关闭时结束改键录制。
      //
      // 录制态是"下一次按键即生效"，如果用户点了某一条之后改主意、
      // 直接点面板外面关掉，那个悬着的录制态会在几分钟后吃掉他
      // 无意间按下的任意键，把快捷键悄悄改掉。宁可什么都不改。
      artPlayerRef.current.on('setting', (show: boolean) => {
        if (!show && shortcutRecorderRef.current) {
          shortcutRecorderRef.current = null;
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
        const volume = artPlayerRef.current.volume;
        lastVolumeRef.current = volume;

        // 与倍速同理：加载新源时的被动重置不写入偏好
        if (isSwitchingSourceRef.current) return;

        saveVolume(volume);
      });
      artPlayerRef.current.on('video:ratechange', () => {
        const rate = artPlayerRef.current.playbackRate;
        lastPlaybackRateRef.current = rate;

        // 加载新源时浏览器会把倍速重置为 1，此时不能覆盖用户偏好。
        // 用「是否处于换源/切集流程」来区分主动切换与被动重置。
        if (isSwitchingSourceRef.current) return;

        savePlaybackRate(rate);
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
          // 恢复音量：优先用记住的偏好，其次沿用会话内的值
          const savedVolume = loadVolume();
          const targetVolume =
            savedVolume !== DEFAULT_VOLUME
              ? savedVolume
              : lastVolumeRef.current;

          if (
            Number.isFinite(targetVolume) &&
            Math.abs(artPlayerRef.current.volume - targetVolume) > 0.01
          ) {
            artPlayerRef.current.volume = targetVolume;
          }

          // 恢复倍速：优先用用户记住的偏好，其次沿用本次会话内的值。
          //
          // 这里不再限定 isWebkit —— 原先只有 WebKit 会走到这段，
          // 但 WebKit 恰恰是「销毁重建」路径，非 WebKit 走 switch 复用实例。
          // 两种情况都可能因新源加载被重置为 1，需要在就绪后统一补回。
          const preferredRateRaw = loadPlaybackRate();
          const targetRate =
            preferredRateRaw !== DEFAULT_PLAYBACK_RATE
              ? preferredRateRaw
              : lastPlaybackRateRef.current;

          if (
            Number.isFinite(targetRate) &&
            targetRate > 0 &&
            Math.abs(artPlayerRef.current.playbackRate - targetRate) > 0.01
          ) {
            artPlayerRef.current.playbackRate = targetRate;
          }

          // 倍速与音量已在上面处理完毕，解除「正在切换」标记，
          // 之后的 ratechange 才是用户主动操作，可以写入偏好。
          isSwitchingSourceRef.current = false;

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
    // 封面（豆瓣海报原图）。Hero 区拿它做背景与前景海报；
    // 使用前**必须**过 `processImageUrl()` 处理防盗链（见 utils.ts）。
    videoCover,
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
