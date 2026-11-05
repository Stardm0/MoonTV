/* eslint-disable react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any, no-console */

'use client';

import { LoaderCircle, RefreshCw } from 'lucide-react';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  cachedMemberId,
  cacheMemberId,
  clearCachedMemberId,
  roomRequest,
} from '@/lib/watch-room/client';
import {
  ControlKind,
  currentPlayPath,
  DEFAULT_ROOM_CAPACITY,
  MAX_MESSAGE_LENGTH,
  MAX_ROOM_CAPACITY,
  MEMBER_PREVIEW_LIMIT,
  normalizeCapacity,
  POLL_HIDDEN_INTERVAL_MS,
  POLL_IDLE_INTERVAL_MS,
  POLL_INTERVAL_MS,
  POLL_JITTER,
  resolveCreateCapacity,
  RoomEvent,
  RoomResponse,
  WatchRoom,
} from '@/lib/watch-room/types';

interface WatchRoomPanelProps {
  /** usePlayEngine 里的 ArtPlayer 实例 ref（新增导出） */
  artPlayerRef: MutableRefObject<any>;
  videoTitle: string;
  currentSource: string;
  currentId: string;
  currentEpisodeIndex: number;
  videoUrl: string;
  /**
   * 紧凑模式：嵌入播放页右侧栏的「一起看」Tab 时使用。
   * 去掉独立卡片外框与「收起」按钮，内容按窄栏单列纵向铺满。
   */
  compact?: boolean;
}

const ROOM_ID_PATTERN = /^[A-Z0-9]{6,7}$/;

/** 轮询尚未挂载时的占位唤醒函数（函数体有返回值，不会触发 no-empty-function） */
const noopWake: () => void = () => undefined;

function readRoomFromUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('room');
  if (!raw) return null;
  const id = raw.toUpperCase();
  return ROOM_ID_PATTERN.test(id) ? id : null;
}

function writeRoomToUrl(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('room', id);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', url.toString());
}

/** 不复用 @/lib/auth：该模块引用 next/server，避免被打进客户端 bundle */
function readUsername(): string {
  try {
    const raw = document.cookie
      .split('; ')
      .find((item) => item.startsWith('auth='))
      ?.slice('auth='.length);
    if (!raw) return '';
    let decoded = decodeURIComponent(raw);
    if (decoded.includes('%')) decoded = decodeURIComponent(decoded);
    const parsed = JSON.parse(decoded);
    return typeof parsed?.username === 'string'
      ? parsed.username.slice(0, 20)
      : '';
  } catch {
    return '';
  }
}

function displayName(): string {
  const username = readUsername();
  if (username) return username;
  try {
    const saved = localStorage.getItem('moontv:watchroom:name');
    if (saved) return saved;
    const generated = `观众${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
    localStorage.setItem('moontv:watchroom:name', generated);
    return generated;
  } catch {
    return '观众';
  }
}

function buildInviteUrl(room: WatchRoom): string {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(room.playPath, window.location.origin);
    url.searchParams.set('room', room.id);
    return url.toString();
  } catch {
    return '';
  }
}

/** 气泡上的 HH:mm。用本地时区手动补零，避免 toLocaleTimeString 的 SSR 差异 */
function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return [hours, minutes, secs]
      .map((v) => String(v).padStart(2, '0'))
      .join(':');
  }
  return [minutes, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export default function WatchRoomPanel({
  artPlayerRef,
  videoTitle,
  currentEpisodeIndex,
  compact = false,
}: WatchRoomPanelProps) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<WatchRoom | null>(null);
  /** 精确在线人数：大房间下名单被裁剪，人数单独维护 */
  const [memberCount, setMemberCount] = useState(0);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [myId, setMyId] = useState('');
  const [connected, setConnected] = useState<
    'idle' | 'connecting' | 'online' | 'error'
  >('idle');
  const [expanded, setExpanded] = useState(compact);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [roomNameInput, setRoomNameInput] = useState('');
  // 创建房间时的人数上限，留空 = 采用默认上限（20 人）
  const [capacityInput, setCapacityInput] = useState('');
  /**
   * 账号已创建的持久观影室。只作展示，不自动激活：换影片进播放页时不再
   * 把用户直接拉回自己的房间，需要用户主动点「加入我的观影室」。
   */
  const [savedRoom, setSavedRoom] = useState<WatchRoom | null>(null);
  const [joiningSaved, setJoiningSaved] = useState(false);
  /** 查询「我的观影室」的加载态与错误态：失败必须显式报错并允许手动重试 */
  const [savedRoomLoading, setSavedRoomLoading] = useState(false);
  const [savedRoomError, setSavedRoomError] = useState('');
  /** 丢弃过期的 hasPersistentRoom 响应，避免卸载 / 快速切换时覆盖状态 */
  const savedRoomReqRef = useRef(0);
  const [errorText, setErrorText] = useState('');
  const [hint, setHint] = useState('');
  const [storeKind, setStoreKind] = useState('');
  const [episodeMismatch, setEpisodeMismatch] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [optimisticSyncMode, setOptimisticSyncMode] = useState<
    'auto' | 'manual' | null
  >(null);

  const memberIdRef = useRef('');
  /**
   * 服务端在实例重启后会重新分配 memberId。把历次自己的 id 都记下来，
   * 这样重连前的历史消息仍会被渲染在右侧，不会突然变成「别人的消息」。
   */
  const myIdsRef = useRef<Set<string>>(new Set());
  const sinceRef = useRef(0);
  /** 客户端已持有的房间核心版本 / 人数，用于跳过无变化的心跳响应 */
  const revRef = useRef(-1);
  const countRef = useRef(-1);
  /** 即使名单被裁剪，也能拿到自己的同步模式 */
  const mySyncModeRef = useRef<'auto' | 'manual' | null>(null);
  /** 连续无新事件的轮询次数，用于非房主退避 */
  const idlePollsRef = useRef(0);
  /** 面板是否可见（侧栏 Tab 收起 / 标签页隐藏时暂停高频轮询） */
  const visibleRef = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 用户主动操作后立即唤醒一次轮询 */
  const wakeRef = useRef<() => void>(noopWake);
  const isHostRef = useRef(false);
  const roomIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const applyingUntilRef = useRef(0);
  const lastCorrectRef = useRef(0);
  const alignedRef = useRef(false);
  const broadcastAfterRef = useRef(0);
  const artBoundRef = useRef<any>(null);
  const handlersRef = useRef<{
    play: () => void;
    pause: () => void;
    seeked: () => void;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    setTimeout(() => setHint(''), 3000);
  }, []);

  const resolveMemberSyncMode = useCallback(
    (nextRoom: WatchRoom | null) => {
      const memberId = memberIdRef.current || myId;
      if (!nextRoom || !memberId) return mySyncModeRef.current || 'auto';
      const member = nextRoom.members.find((item) => item.id === memberId);
      return (
        member?.syncMode ??
        nextRoom.defaultSyncMode ??
        mySyncModeRef.current ??
        'auto'
      );
    },
    [myId]
  );

  /** 接收服务端快照后，把房主的播放状态静默应用到本地播放器 */
  const applyRoomState = useCallback(
    (nextRoom: WatchRoom, host: boolean, forceApply = false) => {
      if (host) return; // 房主是权威，绝不被自己的心跳回拉
      const syncMode = resolveMemberSyncMode(nextRoom);
      if (syncMode === 'manual' && !forceApply) return;

      const art = artPlayerRef.current;
      if (!art || typeof art.currentTime !== 'number') return;
      if (Date.now() < applyingUntilRef.current) return;

      const force = forceApply || !alignedRef.current;
      const video = art.video as HTMLVideoElement | undefined;
      // 缓冲中先别 seek，避免拖到未加载位置反复卡顿
      if (!force && video && video.readyState < 2) return;
      alignedRef.current = true;

      const applyRemote = (fn: () => void) => {
        applyingUntilRef.current = Date.now() + 900;
        fn();
      };

      const state = nextRoom.state;
      const localPlaying = !art.paused;
      if (localPlaying !== state.playing) {
        applyRemote(() => {
          if (state.playing) {
            const result = art.play?.();
            if (result && typeof result.catch === 'function') {
              result.catch(() =>
                showHint('浏览器阻止了自动播放，请点击一下画面以继续同步')
              );
            }
          } else {
            art.pause?.();
          }
        });
      }

      const drift = Math.abs((art.currentTime || 0) - state.time);
      const cooled = Date.now() - lastCorrectRef.current > 3000;
      if (force || (drift > 2 && cooled)) {
        applyRemote(() => {
          try {
            art.currentTime = state.time;
          } catch {
            /* 播放器尚未就绪，下一轮重试 */
          }
        });
        lastCorrectRef.current = Date.now();
      }
    },
    [artPlayerRef, resolveMemberSyncMode, showHint]
  );

  /** 统一处理 create / join 的响应（URL 自动入房由轮询自身完成） */
  const activate = useCallback((res: RoomResponse) => {
    const nextRoom = res.room;
    if (!nextRoom || !res.memberId) return;
    const host = res.isHost === true;
    const newEvents = res.events || [];

    sinceRef.current = newEvents.reduce((max, e) => Math.max(max, e.seq), 0);
    memberIdRef.current = res.memberId;
    myIdsRef.current.add(res.memberId);
    revRef.current = res.rev ?? -1;
    mySyncModeRef.current = res.mySyncMode || null;
    const count =
      res.memberCount ?? nextRoom.memberCount ?? nextRoom.members.length;
    countRef.current = count;
    setMemberCount(count);
    idlePollsRef.current = 0;
    isHostRef.current = host;
    // 房主无需对齐，成员需要按房主进度强制对齐一次
    alignedRef.current = host;
    broadcastAfterRef.current = Date.now() + 1500;
    roomIdRef.current = nextRoom.id;
    cacheMemberId(nextRoom.id, res.memberId);

    setRoom(nextRoom);
    setRoomId(nextRoom.id);
    setMyId(res.memberId);
    setIsHost(host);
    setEvents(newEvents);
    setConnected('online');
    setErrorText('');
    setExpanded(true);
    setStoreKind(res.storeKind || '');
    setSavedRoom(null);
    setSavedRoomError('');
    setSavedRoomLoading(false);
    writeRoomToUrl(nextRoom.id);
  }, []);

  const resetLocal = useCallback(() => {
    const id = roomIdRef.current;
    if (id) clearCachedMemberId(id);
    roomIdRef.current = null;
    memberIdRef.current = '';
    myIdsRef.current.clear();
    sinceRef.current = 0;
    revRef.current = -1;
    countRef.current = -1;
    mySyncModeRef.current = null;
    idlePollsRef.current = 0;
    isHostRef.current = false;
    alignedRef.current = false;
    setRoomId(null);
    setRoom(null);
    setMemberCount(0);
    setEvents([]);
    setIsHost(false);
    setMyId('');
    setConnected('idle');
    setErrorText('');
    writeRoomToUrl(null);
  }, []);

  /**
   * 只查询账号已创建的房间用于展示；不发心跳、不 activateOwned。
   *
   * 失败不再静默回落到创建表单（用户已创建过时点创建只会报「不能重复创建」），
   * 而是显式报错并提供重试按钮。查询期间保留上一次的卡片，避免界面闪空。
   */
  const loadSavedRoom = useCallback(async () => {
    const reqId = ++savedRoomReqRef.current;
    // 重试期间故意保留上一条错误：错误块里的按钮才能显示「正在重试…」，
    // 而不是整块消失、让用户以为点击没生效。成功后在下面清空。
    setSavedRoomLoading(true);

    let res: RoomResponse | null = null;
    try {
      res = await roomRequest({ action: 'hasPersistentRoom' });
    } catch {
      /* roomRequest 内部已兜底，这里只防意外抛出 */
    }
    if (reqId !== savedRoomReqRef.current) return;
    setSavedRoomLoading(false);

    if (!res || !res.ok) {
      // roomRequest 超时文案写的是「正在重试」，但本查询本身没有自动重试，
      // 这里换成准确描述，避免误导用户等着一个不会发生的重试。
      const raw = res?.error || '读取我的观影室失败';
      setSavedRoomError(
        /正在重试/.test(raw) ? '读取观影室超时，请点击重试' : raw
      );
      return;
    }
    // ok=true 且没有 room 是正常结果（账号确实没创建过房间），不是错误
    setSavedRoomError('');
    setSavedRoom(res.room || null);
  }, []);

  /** 用户主动点「加入我的观影室」后才真正建立连接 */
  const joinSavedRoom = useCallback(async () => {
    if (!savedRoom || joiningSaved || busy) return;
    setJoiningSaved(true);
    setErrorText('');
    const res = await roomRequest({
      action: 'activateOwned',
      roomId: savedRoom.id,
    });
    setJoiningSaved(false);
    if (!res.ok || !res.room || !res.memberId) {
      setErrorText(res.error || '加入观影室失败');
      // 房间可能已在别处被删除：刷新一次，让卡片回落到创建表单
      void loadSavedRoom();
      return;
    }
    activate(res);
  }, [savedRoom, joiningSaved, busy, activate, loadSavedRoom]);

  const createRoom = useCallback(async () => {
    if (busy) return;

    const existing = await roomRequest({ action: 'hasPersistentRoom' });
    if (existing.ok && existing.room) {
      setErrorText('你已经创建过观影室了，不能重复创建');
      return;
    }

    const nextRoomName = roomNameInput.trim() || '共同观影室';

    setBusy(true);
    setErrorText('');
    const res = await roomRequest({
      action: 'create',
      name: displayName(),
      title: videoTitle,
      roomName: nextRoomName,
      playPath: currentPlayPath(),
      episode: currentEpisodeIndex + 1,
      persistent: true,
      // 默认不公开：由房主在设置里主动公开
      isPublic: false,
      maxMembers: resolveCreateCapacity(capacityInput),
    });
    setBusy(false);
    if (!res.ok || !res.room || !res.memberId) {
      setErrorText(res.error || '创建房间失败');
      return;
    }
    setRoomNameInput('');
    setCapacityInput('');
    activate(res);
  }, [
    busy,
    roomNameInput,
    capacityInput,
    videoTitle,
    currentEpisodeIndex,
    activate,
  ]);

  const joinRoom = useCallback(
    async (code: string) => {
      const id = code.trim().toUpperCase();
      if (!ROOM_ID_PATTERN.test(id)) {
        setErrorText('请输入 6 位房间号');
        return;
      }
      if (busy) return;
      setBusy(true);
      setErrorText('');
      const res = await roomRequest({
        action: 'join',
        roomId: id,
        name: displayName(),
      });
      setBusy(false);
      if (!res.ok || !res.room || !res.memberId) {
        setErrorText(res.error || '加入房间失败');
        return;
      }
      activate(res);
    },
    [busy, activate]
  );

  const leaveRoom = useCallback(async () => {
    const id = roomIdRef.current;
    if (id && memberIdRef.current) {
      void roomRequest({
        action: 'leave',
        roomId: id,
        memberId: memberIdRef.current,
      });
    }
    resetLocal();
    // 离开后回到「我的观影室」卡片，可再次手动加入
    void loadSavedRoom();
    // 紧凑模式下 Tab 本身就是开关，离开后仍停留在面板上便于重新建房
    if (!compact) setExpanded(false);
  }, [resetLocal, loadSavedRoom, compact]);

  // 邀请链接（URL 带 ?room=）仍按显式意图自动入房；没有邀请链接时只查询
  // 账号已创建的房间并展示卡片，由用户手动点「加入我的观影室」，避免换影片
  // 进入播放页就被自动拉回自己的房间。
  useEffect(() => {
    const initRoomState = () => {
      const inviteId = readRoomFromUrl();
      if (inviteId) {
        roomIdRef.current = inviteId;
        memberIdRef.current = cachedMemberId(inviteId);
        broadcastAfterRef.current = Date.now() + 1500;
        setRoomId(inviteId);
        setConnected('connecting');
        setExpanded(true);
        return;
      }
      void loadSavedRoom();
    };
    initRoomState();
    // 卸载后丢弃在途响应，避免对已卸载组件 setState
    return () => {
      savedRoomReqRef.current += 1;
    };
  }, [loadSavedRoom]);

  // 可见性感知：侧栏 Tab 被隐藏 / 标签页切到后台时，不再高频轮询
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        const wasVisible = visibleRef.current;
        visibleRef.current = visible;
        if (visible && !wasVisible) wakeRef.current();
      },
      { threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 轮询：一次请求同时完成心跳、增量事件拉取与状态同步。
  // 自适应间隔 + 抖动，把同一房间 N 个客户端的请求打散，避免整点惊群。
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (inFlightRef.current || cancelled) return;
      inFlightRef.current = true;
      const art = artPlayerRef.current;
      const host = isHostRef.current;
      const local =
        host && art && typeof art.currentTime === 'number'
          ? { time: art.currentTime || 0, playing: !art.paused }
          : undefined;

      const res = await roomRequest({
        action: 'sync',
        roomId,
        memberId: memberIdRef.current,
        since: sinceRef.current,
        name: displayName(),
        playPath: host ? currentPlayPath() : undefined,
        title: host ? videoTitle : undefined,
        episode: host ? currentEpisodeIndex + 1 : undefined,
        local,
        rev: revRef.current >= 0 ? revRef.current : undefined,
        memberCount: countRef.current >= 0 ? countRef.current : undefined,
      });
      inFlightRef.current = false;
      if (cancelled) return;

      if (res.storeKind) setStoreKind(res.storeKind);

      if (!res.ok) {
        setConnected('error');
        const message = res.error || '连接异常，正在重试';
        setErrorText(message);
        if (/不存在|已解散|房间号无效|人数已满/.test(message)) {
          // 房间满了不要继续反复心跳重试；退出本地房间状态，
          // 并把满员提示留在面板上（resetLocal 会清空错误文案）。
          resetLocal();
          void loadSavedRoom();
          if (/人数已满/.test(message)) setErrorText(message);
        }
        return;
      }

      setConnected('online');
      setErrorText('');
      const hasEvents = !!(res.events && res.events.length);
      idlePollsRef.current = hasEvents
        ? 0
        : Math.min(idlePollsRef.current + 1, 100);

      if (res.rev !== undefined) revRef.current = res.rev;
      if (res.memberCount !== undefined) {
        countRef.current = res.memberCount;
        setMemberCount(res.memberCount);
      }
      if (res.mySyncMode) mySyncModeRef.current = res.mySyncMode;

      if (res.memberId && res.memberId !== memberIdRef.current) {
        memberIdRef.current = res.memberId;
        cacheMemberId(roomId, res.memberId);
        alignedRef.current = false; // 重新入房后重新对齐
      }
      setMyId(res.memberId || memberIdRef.current);
      if (res.memberId) myIdsRef.current.add(res.memberId);
      if (res.isHost !== undefined) {
        const changed = isHostRef.current !== res.isHost;
        isHostRef.current = res.isHost;
        setIsHost(res.isHost);
        if (res.isHost) alignedRef.current = true;
        else if (changed) alignedRef.current = false;
      }

      // 服务端确认核心、人数、事件都没变：连 room 都不下发，直接跳过渲染
      if (res.unchanged) return;

      if (res.room) {
        setRoom(res.room);
        applyRoomState(res.room, res.isHost === true);
      }
      if (hasEvents) {
        sinceRef.current = Math.max(
          sinceRef.current,
          ...(res.events || []).map((e) => e.seq)
        );
        setEvents((prev) => [...prev, ...(res.events || [])].slice(-100));
      }
    };

    const schedule = (delay?: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      let base = POLL_INTERVAL_MS;
      if (
        !visibleRef.current ||
        (typeof document !== 'undefined' && document.hidden)
      ) {
        base = POLL_HIDDEN_INTERVAL_MS;
      } else if (!isHostRef.current) {
        base =
          idlePollsRef.current >= 3 ? POLL_IDLE_INTERVAL_MS : POLL_INTERVAL_MS;
        if (idlePollsRef.current >= 12) base = 4000;
      }
      const jitter = 1 + (Math.random() * 2 - 1) * POLL_JITTER;
      const wait = delay ?? Math.max(600, Math.round(base * jitter));
      timer = setTimeout(async () => {
        if (cancelled) return;
        await tick();
        schedule();
      }, wait);
    };

    const wake = () => {
      idlePollsRef.current = 0;
      schedule(50);
    };
    wakeRef.current = wake;

    const onVisibility = () => {
      if (!document.hidden && visibleRef.current) wake();
    };
    document.addEventListener('visibilitychange', onVisibility);

    schedule(50);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      wakeRef.current = noopWake;
    };
  }, [
    roomId,
    artPlayerRef,
    currentEpisodeIndex,
    videoTitle,
    applyRoomState,
    resetLocal,
    loadSavedRoom,
  ]);

  // 绑定播放器事件：房主的播放 / 暂停 / 拖动立即广播，不等下一轮心跳
  useEffect(() => {
    if (!roomId) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const unbind = () => {
      const art = artBoundRef.current;
      const handlers = handlersRef.current;
      if (art && handlers && typeof art.off === 'function') {
        try {
          art.off('play', handlers.play);
          art.off('pause', handlers.pause);
          art.off('video:seeked', handlers.seeked);
        } catch {
          // 播放器实例可能已被切源 / 切集销毁
        }
      }
      artBoundRef.current = null;
      handlersRef.current = null;
    };

    const bind = () => {
      const art = artPlayerRef.current;
      if (!art || typeof art.on !== 'function') return;
      if (artBoundRef.current === art) return;
      unbind();

      const send = (kind: ControlKind) => {
        if (
          !isHostRef.current ||
          !roomIdRef.current ||
          !memberIdRef.current ||
          !alignedRef.current ||
          Date.now() < broadcastAfterRef.current ||
          Date.now() < applyingUntilRef.current // 屏蔽远端应用产生的回声
        ) {
          return;
        }
        const player = artPlayerRef.current;
        if (!player) return;
        void roomRequest({
          action: 'control',
          roomId: roomIdRef.current,
          memberId: memberIdRef.current,
          kind,
          time: player.currentTime || 0,
          playing: !player.paused,
        });
        wakeRef.current();
      };

      const handlers = {
        play: () => send('play'),
        pause: () => send('pause'),
        seeked: () => send('seek'),
      };
      art.on('play', handlers.play);
      art.on('pause', handlers.pause);
      art.on('video:seeked', handlers.seeked);
      handlersRef.current = handlers;
      artBoundRef.current = art;
    };

    bind();
    // ArtPlayer 为动态 import，且切源 / 切集可能重建实例
    timer = setInterval(bind, 500);
    return () => {
      if (timer) clearInterval(timer);
      unbind();
    };
  }, [roomId, artPlayerRef]);

  // 成员与房主不在同一集时给出提示（不自动跳转，避免打断用户）
  useEffect(() => {
    if (!room || isHost) {
      setEpisodeMismatch(false);
      return;
    }
    setEpisodeMismatch(!!room.playPath && room.playPath !== currentPlayPath());
  }, [room, isHost, currentEpisodeIndex]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events]);

  const sendChat = useCallback(async () => {
    const text = input.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text || !roomIdRef.current || !memberIdRef.current) return;
    setInput('');
    const res = await roomRequest({
      action: 'chat',
      roomId: roomIdRef.current,
      memberId: memberIdRef.current,
      text,
    });
    if (!res.ok) {
      setInput(text);
      setErrorText(res.error || '发送失败');
    } else {
      wakeRef.current();
    }
  }, [input]);

  const copyInvite = useCallback(async () => {
    if (!room) return;
    const url = buildInviteUrl(room);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showHint('邀请链接已复制，发给伙伴即可一起看');
    } catch {
      window.prompt('复制这个链接发给伙伴：', url);
    }
  }, [room, showHint]);

  const followHost = useCallback(() => {
    if (!room) return;
    const url = buildInviteUrl(room);
    if (url) window.location.href = url;
  }, [room]);

  /** 房主快速公开 / 取消公开：公开后会出现在「观影室」页面的公开列表 */
  const togglePublic = useCallback(async () => {
    if (!room || !roomIdRef.current) return;
    const nextPublic = room.isPublic !== true;
    setBusy(true);
    setErrorText('');
    const res = await roomRequest({
      action: 'setPublic',
      roomId: roomIdRef.current,
      public: nextPublic,
    });
    setBusy(false);
    if (!res.ok || !res.room) {
      setErrorText(res.error || '设置公开状态失败');
      return;
    }
    setRoom(res.room);
    if (res.rev !== undefined) revRef.current = res.rev;
    if (res.memberCount !== undefined) {
      countRef.current = res.memberCount;
      setMemberCount(res.memberCount);
    }
    showHint(
      nextPublic ? '房间已公开，其他人可在观影室页面加入' : '房间已取消公开'
    );
  }, [room, showHint]);

  const setSyncMode = useCallback(async (nextMode: 'auto' | 'manual') => {
    if (!roomIdRef.current || !memberIdRef.current) return;
    const requestId = ++latestSyncModeRequestRef.current;
    setOptimisticSyncMode(nextMode);
    const res = await roomRequest({
      action: 'setSyncMode',
      roomId: roomIdRef.current,
      memberId: memberIdRef.current,
      syncMode: nextMode,
    });
    if (requestId !== latestSyncModeRequestRef.current) {
      return;
    }
    if (!res.ok || !res.room) {
      setOptimisticSyncMode(null);
      setErrorText(res.error || '切换同步模式失败');
      return;
    }
    setOptimisticSyncMode(null);
    setRoom(res.room);
    if (res.rev !== undefined) revRef.current = res.rev;
    if (res.memberCount !== undefined) {
      countRef.current = res.memberCount;
      setMemberCount(res.memberCount);
    }
    if (res.mySyncMode) mySyncModeRef.current = res.mySyncMode;
    if (!isHostRef.current) {
      alignedRef.current = false;
    }
    wakeRef.current();
  }, []);

  const syncProgressOnce = useCallback(async () => {
    if (!roomIdRef.current || !memberIdRef.current) return;
    const res = await roomRequest({
      action: 'sync',
      roomId: roomIdRef.current,
      memberId: memberIdRef.current,
      since: sinceRef.current,
      name: displayName(),
      playPath: isHostRef.current ? currentPlayPath() : undefined,
      title: isHostRef.current ? videoTitle : undefined,
      episode: isHostRef.current ? currentEpisodeIndex + 1 : undefined,
      local:
        isHostRef.current && artPlayerRef.current
          ? {
              time: artPlayerRef.current.currentTime || 0,
              playing: !artPlayerRef.current.paused,
            }
          : undefined,
    });

    if (!res.ok || !res.room) {
      setErrorText(res.error || '同步失败');
      showHint('同步失败，请稍后重试');
      return;
    }

    setRoom(res.room);
    if (res.rev !== undefined) revRef.current = res.rev;
    if (res.memberCount !== undefined) {
      countRef.current = res.memberCount;
      setMemberCount(res.memberCount);
    }
    if (res.mySyncMode) mySyncModeRef.current = res.mySyncMode;
    alignedRef.current = false;
    applyRoomState(res.room, res.isHost === true, true);
    const nextEvents = res.events ?? [];
    if (nextEvents.length) {
      sinceRef.current = Math.max(
        sinceRef.current,
        ...nextEvents.map((e) => e.seq)
      );
      setEvents((prev) => [...prev, ...nextEvents].slice(-100));
    }
    showHint('同步成功');
  }, [artPlayerRef, currentEpisodeIndex, videoTitle, applyRoomState, showHint]);

  const myCurrentSyncMode = room ? resolveMemberSyncMode(room) : 'auto';
  const effectiveSyncMode = optimisticSyncMode ?? myCurrentSyncMode;
  const latestSyncModeRequestRef = useRef(0);

  const statusText =
    connected === 'online'
      ? '已连接'
      : connected === 'error'
      ? '重连中'
      : connected === 'connecting'
      ? '连接中'
      : '未连接';

  /** 「我的观影室」卡片的人数：服务端已按 presence 实时统计，0 就明确显示无人 */
  const savedRoomCount = Math.max(0, Number(savedRoom?.memberCount) || 0);
  const savedRoomCap = normalizeCapacity(savedRoom?.maxMembers);
  const savedRoomCountText = savedRoomCount
    ? `当前 ${savedRoomCount}${savedRoomCap ? ` / ${savedRoomCap}` : ''} 人在线`
    : savedRoomCap
    ? `当前无人在线 · 上限 ${savedRoomCap} 人`
    : '当前无人在线';

  return (
    <div
      ref={rootRef}
      className={
        compact
          ? 'flex h-full min-h-0 flex-col'
          : 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 md:p-6 dark:bg-white/[0.03] dark:ring-white/10'
      }
    >
      <div className='flex shrink-0 items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5'>
          <span
            className={`font-semibold ${compact ? 'text-sm' : 'text-base'}`}
          >
            {room?.title || room?.videoTitle || '🎬 共同观影室'}
          </span>
          {room && (
            <span className='truncate text-xs text-gray-500 dark:text-gray-400'>
              房间 {room.id} · {isHost ? '房主' : '成员'} · {statusText} ·{' '}
              {memberCount || room.memberCount || room.members.length}
              {normalizeCapacity(room.maxMembers)
                ? ` / ${normalizeCapacity(room.maxMembers)}`
                : ''}{' '}
              人
            </span>
          )}
        </div>
        {!compact && (
          <button
            type='button'
            onClick={() => setExpanded((v) => !v)}
            className='shrink-0 rounded-lg px-3 py-1.5 text-sm text-gray-600 ring-1 ring-black/10 transition hover:bg-black/5 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/10'
          >
            {expanded ? '收起' : room ? '打开面板' : '一起看'}
          </button>
        )}
      </div>

      {errorText && (
        <p className='mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400'>
          {errorText}
        </p>
      )}
      {hint && (
        <p className='mt-3 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400'>
          {hint}
        </p>
      )}

      {expanded && !room && (
        <div
          className={compact ? 'mt-3 min-h-0 flex-1 overflow-y-auto' : 'mt-4'}
        >
          {/* 查询「我的观影室」失败：显式报错 + 手动重试，不静默回落到创建表单 */}
          {savedRoomError && (
            <div className='mb-4 rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30'>
              <p className='text-sm font-medium text-red-700 dark:text-red-300'>
                读取我的观影室失败
              </p>
              <p className='mt-1 break-words text-xs leading-relaxed text-red-600 dark:text-red-400'>
                {savedRoomError}
              </p>
              <button
                type='button'
                onClick={() => void loadSavedRoom()}
                disabled={savedRoomLoading}
                className='mt-3 inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-white/5 dark:text-red-300 dark:hover:bg-red-950/60'
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${
                    savedRoomLoading ? 'animate-spin' : ''
                  }`}
                />
                {savedRoomLoading ? '正在重试…' : '重试'}
              </button>
            </div>
          )}

          {savedRoomLoading && !savedRoomError && (
            <p className='mb-4 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
              <LoaderCircle className='h-3.5 w-3.5 animate-spin' />
              正在读取我的观影室…
            </p>
          )}

          {/* 已创建房间：只展示，不自动连接，由用户手动点按钮加入 */}
          {savedRoom && (
            <div className='mb-4 rounded-xl border border-green-500/30 bg-green-500/5 p-3 dark:border-green-500/25 dark:bg-green-500/10'>
              <div className='mb-2 flex items-start justify-between gap-2'>
                <div className='min-w-0'>
                  <p className='text-xs font-medium text-green-700 dark:text-green-400'>
                    我的观影室
                  </p>
                  <p className='mt-0.5 truncate text-sm font-semibold text-gray-900 dark:text-white'>
                    {savedRoom.title || savedRoom.videoTitle || '共同观影室'}
                  </p>
                </div>
                <span className='shrink-0 rounded-md bg-white/60 px-2 py-0.5 font-mono text-xs tracking-wider text-green-700 ring-1 ring-green-500/20 dark:bg-white/5 dark:text-green-400'>
                  {savedRoom.id}
                </span>
              </div>
              <p className='truncate text-xs text-gray-500 dark:text-gray-400'>
                当前影片：
                {savedRoom.playPath === '/play'
                  ? '尚未开始播放'
                  : savedRoom.videoTitle || savedRoom.title || '共同观影室'}
                {savedRoom.episode > 1 ? ` · 第 ${savedRoom.episode} 集` : ''}
              </p>
              <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400'>
                <span>{savedRoomCountText}</span>
                {savedRoom.isPublic && <span>· 已公开</span>}
                {savedRoom.enabled === false && (
                  <span className='rounded-full bg-gray-500/10 px-1.5 py-0.5 text-gray-600 dark:text-gray-300'>
                    已关闭（加入后重新开启）
                  </span>
                )}
              </div>
              <button
                type='button'
                onClick={() => void joinSavedRoom()}
                disabled={joiningSaved || busy}
                className='mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50'
              >
                {joiningSaved ? '正在加入…' : '加入我的观影室'}
              </button>
              <p className='mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400'>
                进入其它影片时不会自动连回房间，点上方按钮才会连接并同步。
              </p>
            </div>
          )}

          {/* 一个账号只能有一个持久房间：已有房间时收起创建表单 */}
          {!savedRoom && !savedRoomError && !savedRoomLoading && (
            <>
              <div className='mb-3'>
                <label className='mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400'>
                  房间名称
                </label>
                <input
                  value={roomNameInput}
                  onChange={(e) =>
                    setRoomNameInput(e.target.value.slice(0, 20))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void createRoom();
                  }}
                  aria-label='房间名称'
                  placeholder='共同观影室'
                  className='w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-blue-500 dark:border-white/15 dark:placeholder:text-gray-500'
                />
              </div>
              <div className='mb-3'>
                <label className='mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400'>
                  人数上限（默认 {DEFAULT_ROOM_CAPACITY} 人）
                </label>
                <input
                  value={capacityInput}
                  onChange={(e) =>
                    setCapacityInput(
                      e.target.value.replace(/[^\d]/g, '').slice(0, 3)
                    )
                  }
                  onBlur={() => {
                    const cap = normalizeCapacity(capacityInput);
                    setCapacityInput(cap ? String(cap) : '');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void createRoom();
                  }}
                  inputMode='numeric'
                  aria-label='人数上限'
                  title={`默认 ${DEFAULT_ROOM_CAPACITY} 人，最多 ${MAX_ROOM_CAPACITY} 人`}
                  placeholder={`默认 ${DEFAULT_ROOM_CAPACITY} 人`}
                  className='w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-blue-500 dark:border-white/15 dark:placeholder:text-gray-500'
                />
              </div>
            </>
          )}
          <div
            className={
              compact
                ? 'flex flex-col gap-2'
                : 'flex flex-col gap-3 sm:flex-row sm:items-center'
            }
          >
            {!savedRoom && !savedRoomError && !savedRoomLoading && (
              <button
                type='button'
                onClick={() => void createRoom()}
                disabled={busy}
                className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50'
              >
                {busy ? '处理中…' : '创建房间'}
              </button>
            )}
            <div className='flex flex-1 gap-2'>
              <input
                value={joinCode}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().slice(0, 7))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void joinRoom(joinCode);
                }}
                placeholder={savedRoom ? '输入其它房间号' : '输入 6 位房间号'}
                className='min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15'
              />
              <button
                type='button'
                onClick={() => void joinRoom(joinCode)}
                disabled={busy || !joinCode.trim()}
                className='rounded-lg px-4 py-2 text-sm font-medium text-blue-600 ring-1 ring-blue-500/40 transition hover:bg-blue-500/10 disabled:opacity-40'
              >
                加入
              </button>
            </div>
          </div>
          <p className='mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400'>
            {savedRoom
              ? '也可以输入别人分享的房间号加入其它观影室。'
              : savedRoomError || savedRoomLoading
              ? '也可以直接输入房间号加入其它观影室。'
              : compact
              ? '复制邀请链接发给伙伴，链接自带片源与集数；房主控制播放，其他人自动跟随。'
              : '创建后复制邀请链接发给伙伴。邀请链接会带上当前的片源与集数，保证大家看的是同一集；房间内由房主控制播放，其他人自动跟随进度。'}
          </p>
        </div>
      )}

      {settingsOpen && room && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm'>
          <div className='w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl dark:bg-[#111827]'>
            <div className='mb-4 flex items-center justify-between'>
              <h3 className='text-base font-semibold'>房间设置</h3>
              <button
                type='button'
                onClick={() => setSettingsOpen(false)}
                className='rounded-lg px-2 py-1 text-sm text-gray-500 transition hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/10'
              >
                关闭
              </button>
            </div>

            <div className='space-y-4'>
              <div>
                <p className='mb-2 text-xs font-medium text-gray-500 dark:text-gray-400'>
                  同步模式
                </p>
                <div className='flex gap-2 rounded-xl bg-black/[0.03] p-1 dark:bg-white/[0.04]'>
                  {(['auto', 'manual'] as const).map((mode) => {
                    const selected = isHost
                      ? (optimisticSyncMode ?? room.defaultSyncMode) === mode
                      : effectiveSyncMode === mode;
                    return (
                      <button
                        key={mode}
                        type='button'
                        onClick={() => void setSyncMode(mode)}
                        className={`flex-1 rounded-lg px-3 py-2 text-sm transition ${
                          selected
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-600 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/10'
                        }`}
                      >
                        {mode === 'auto' ? '自动同步' : '手动同步'}
                      </button>
                    );
                  })}
                </div>
                <div className='mt-3 rounded-lg bg-black/[0.03] px-3 py-2 text-sm dark:bg-white/[0.04]'>
                  <div className='flex items-center justify-between gap-2 text-gray-600 dark:text-gray-200'>
                    <span>当前同步时间</span>
                    <span className='font-medium tabular-nums text-blue-600 dark:text-blue-400'>
                      {formatDuration(room.state?.time ?? 0)}
                    </span>
                  </div>
                </div>
                {!isHost && effectiveSyncMode === 'manual' && (
                  <button
                    type='button'
                    onClick={() => {
                      setSettingsOpen(false);
                      void syncProgressOnce();
                    }}
                    className='mt-3 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700'
                  >
                    同步一次
                  </button>
                )}
                <p className='mt-2 text-[11px] leading-relaxed text-gray-400'>
                  {isHost
                    ? '房主设置默认同步模式，其他成员可自行覆盖自己的同步模式。'
                    : '你当前可单独设置自己的同步模式，不会影响房主默认值。'}
                </p>
              </div>

              <div>
                <p className='mb-2 text-xs font-medium text-gray-500 dark:text-gray-400'>
                  在线成员
                </p>
                <div className='space-y-1.5'>
                  {room.members.slice(0, MEMBER_PREVIEW_LIMIT).map((member) => (
                    <div
                      key={member.id}
                      className='flex items-center gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 text-sm dark:bg-white/[0.04]'
                    >
                      <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-green-500' />
                      <span className='min-w-0 flex-1 truncate'>
                        {member.name}
                      </span>
                      {member.id === room.hostId && (
                        <span className='rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400'>
                          房主
                        </span>
                      )}
                      <span className='text-[10px] text-gray-500 dark:text-gray-400'>
                        {member.syncMode === 'manual' ? '手动' : '自动'}
                      </span>
                    </div>
                  ))}
                </div>
                {(memberCount || room.memberCount || 0) >
                  room.members.length && (
                  <p className='mt-1.5 text-[11px] leading-relaxed text-gray-400'>
                    仅显示前 {room.members.length} 人，共{' '}
                    {memberCount || room.memberCount} 人在线
                  </p>
                )}
              </div>

              {isHost && room.persistent && (
                <div>
                  <p className='mb-2 text-xs font-medium text-gray-500 dark:text-gray-400'>
                    公开设置
                  </p>
                  <button
                    type='button'
                    onClick={() => void togglePublic()}
                    disabled={busy || room.enabled === false}
                    className={`w-full rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
                      room.isPublic
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'text-gray-700 ring-1 ring-black/10 hover:bg-black/5 dark:text-gray-200 dark:ring-white/15 dark:hover:bg-white/10'
                    }`}
                  >
                    {room.isPublic
                      ? '已公开到观影室列表（点击取消）'
                      : '公开到观影室列表'}
                  </button>
                  <p className='mt-2 text-[11px] leading-relaxed text-gray-400'>
                    公开后，其他用户可以在「观影室」页面看到这个房间并直接加入。
                  </p>
                </div>
              )}

              <div className='grid grid-cols-2 gap-2'>
                <button
                  type='button'
                  onClick={() => {
                    void copyInvite();
                    setSettingsOpen(false);
                  }}
                  className='rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-green-700'
                >
                  复制链接
                </button>
                <button
                  type='button'
                  onClick={() => {
                    void leaveRoom();
                    setSettingsOpen(false);
                  }}
                  className='rounded-lg px-3 py-2 text-sm text-gray-600 ring-1 ring-black/10 transition hover:bg-black/5 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/10'
                >
                  离开房间
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {expanded && room && (
        <div
          className={
            compact
              ? 'mt-2 flex min-h-0 flex-1 flex-col gap-2'
              : 'mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_240px]'
          }
        >
          <div className={compact ? 'flex min-h-0 flex-1 flex-col' : 'min-w-0'}>
            {episodeMismatch && (
              <button
                type='button'
                onClick={followHost}
                className='mb-2 w-full rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-700 dark:text-amber-300'
              >
                房主已切换到第 {room.episode} 集，点此跟随 →
              </button>
            )}
            <div
              ref={listRef}
              className={`overflow-y-auto rounded-xl bg-black/[0.03] p-3 text-sm dark:bg-white/[0.04] ${
                compact ? 'min-h-[64px] flex-1' : 'h-60'
              }`}
            >
              {events.length === 0 && (
                <p className='text-center text-xs text-gray-400'>
                  还没有消息，打个招呼吧～
                </p>
              )}
              {events.map((event) => {
                const key = `${event.seq}-${event.actorId}`;

                // 系统提示 / 播放控制提示仍保持居中，不参与左右分列，
                // 否则会打断聊天气泡的对话节奏。
                if (event.type !== 'chat') {
                  return (
                    <div key={key} className='mb-2 text-center'>
                      <span
                        className={`inline-block max-w-full rounded-full px-2.5 py-0.5 text-[11px] leading-relaxed ${
                          event.type === 'control'
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'text-gray-400'
                        }`}
                      >
                        {event.type === 'control'
                          ? `• ${event.text}`
                          : `— ${event.text} —`}
                      </span>
                    </div>
                  );
                }

                // 自愈重入会换 memberId，用历次 id 集合判定，避免旧消息跳到左边
                const isMine =
                  event.actorId === myId || myIdsRef.current.has(event.actorId);
                const clock = formatClock(event.at);

                // 四个角显式写全，避免 rounded-2xl 与单角类互相覆盖时
                // 受 Tailwind CSS 声明顺序影响；小角即 QQ 气泡的「尾巴」。
                const bubbleShape = isMine
                  ? 'rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl rounded-br-sm'
                  : 'rounded-tl-2xl rounded-tr-2xl rounded-bl-sm rounded-br-2xl';

                return (
                  <div
                    key={key}
                    className={`mb-2.5 flex ${
                      isMine ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`flex min-w-0 max-w-[88%] flex-col ${
                        isMine ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className='mb-1 flex max-w-full items-center gap-1.5 px-1 text-[11px] leading-none text-gray-400'>
                        {!isMine && (
                          <span className='max-w-[110px] truncate font-medium text-blue-600 dark:text-blue-400'>
                            {event.actorName}
                          </span>
                        )}
                        {clock && (
                          <span className='shrink-0 tabular-nums'>{clock}</span>
                        )}
                      </div>
                      <div
                        className={`${bubbleShape} whitespace-pre-wrap break-words shadow-sm ${
                          compact
                            ? 'px-2.5 py-1.5 text-[13px]'
                            : 'px-3 py-2 text-sm'
                        } leading-relaxed ${
                          isMine
                            ? 'bg-blue-600 text-white'
                            : 'bg-white text-gray-800 ring-1 ring-black/5 dark:bg-white/10 dark:text-gray-100 dark:ring-white/10'
                        }`}
                      >
                        {event.text}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className='mt-2 flex shrink-0 gap-2'>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void sendChat();
                }}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder='说点什么…'
                className='min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15'
              />
              <button
                type='button'
                onClick={() => void sendChat()}
                disabled={!input.trim()}
                className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40'
              >
                发送
              </button>
            </div>
          </div>

          <div className={compact ? 'shrink-0' : 'min-w-0'}>
            <div className={compact ? 'flex gap-2' : 'space-y-2'}>
              <button
                type='button'
                onClick={() => setSettingsOpen(true)}
                className={`rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 ${
                  compact ? 'flex-1' : 'w-full'
                }`}
              >
                设置
              </button>
            </div>
            {storeKind === 'memory' && (
              <p
                className={`text-[11px] leading-relaxed text-gray-400 ${
                  compact ? 'mt-1.5' : 'mt-3'
                }`}
              >
                {compact
                  ? '内存存储：多实例部署需绑定 D1 或配置 Upstash。'
                  : '当前使用单进程内存存储。多实例 / Serverless 部署需在 Cloudflare Pages 绑定 D1，或配置 UPSTASH_URL 与 UPSTASH_TOKEN，否则房间状态无法跨实例共享。'}
              </p>
            )}
            {/* 紧凑模式（侧栏 Tab）空间有限，只保留需要用户处理的警告；
                D1 正常态与「成员跟随」说明在标题栏已能看出，不额外占高度。 */}
            {!compact && storeKind === 'd1' && (
              <p className='mt-3 text-[11px] leading-relaxed text-gray-400'>
                房间状态存储于 Cloudflare D1，可跨实例共享。
              </p>
            )}
            {!compact && !isHost && (
              <p className='mt-3 text-[11px] leading-relaxed text-gray-400'>
                进度由房主统一控制；你拖动进度条后会自动被拉回。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
