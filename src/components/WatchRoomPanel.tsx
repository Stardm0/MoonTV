/* eslint-disable react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any, no-console */

'use client';

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { roomRequest } from '@/lib/watch-room/client';
import {
  ControlKind,
  currentPlayPath,
  MAX_MESSAGE_LENGTH,
  POLL_INTERVAL_MS,
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

const memberKey = (roomId: string) => `moontv:watchroom:member:${roomId}`;

function cachedMemberId(roomId: string): string {
  try {
    return sessionStorage.getItem(memberKey(roomId)) || '';
  } catch {
    return '';
  }
}

function cacheMemberId(roomId: string, memberId: string): void {
  try {
    sessionStorage.setItem(memberKey(roomId), memberId);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function clearCachedMemberId(roomId: string): void {
  try {
    sessionStorage.removeItem(memberKey(roomId));
  } catch {
    /* ignore */
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
      if (!nextRoom || !memberId) return 'auto';
      const member = nextRoom.members.find((item) => item.id === memberId);
      return member?.syncMode ?? nextRoom.defaultSyncMode ?? 'auto';
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
    writeRoomToUrl(nextRoom.id);
  }, []);

  const resetLocal = useCallback(() => {
    const id = roomIdRef.current;
    if (id) clearCachedMemberId(id);
    roomIdRef.current = null;
    memberIdRef.current = '';
    myIdsRef.current.clear();
    sinceRef.current = 0;
    isHostRef.current = false;
    alignedRef.current = false;
    setRoomId(null);
    setRoom(null);
    setEvents([]);
    setIsHost(false);
    setMyId('');
    setConnected('idle');
    setErrorText('');
    writeRoomToUrl(null);
  }, []);

  const createRoom = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorText('');
    const res = await roomRequest({
      action: 'create',
      name: displayName(),
      title: videoTitle,
      playPath: currentPlayPath(),
      episode: currentEpisodeIndex + 1,
    });
    setBusy(false);
    if (!res.ok || !res.room || !res.memberId) {
      setErrorText(res.error || '创建房间失败');
      return;
    }
    activate(res);
  }, [busy, videoTitle, currentEpisodeIndex, activate]);

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
    // 紧凑模式下 Tab 本身就是开关，离开后仍停留在面板上便于重新建房
    if (!compact) setExpanded(false);
  }, [resetLocal, compact]);

  // 挂载时：URL 里带 room 参数（邀请链接 / 刷新）则准备自动入房
  useEffect(() => {
    const id = readRoomFromUrl();
    if (!id) return;
    roomIdRef.current = id;
    memberIdRef.current = cachedMemberId(id);
    // 播放器初始化时自动恢复进度会触发一次 seeked，短时间内不广播
    broadcastAfterRef.current = Date.now() + 1500;
    setRoomId(id);
    setConnected('connecting');
    setExpanded(true);
  }, []);

  // 轮询：一次请求同时完成心跳、增量事件拉取与状态同步
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

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
        episode: host ? currentEpisodeIndex + 1 : undefined,
        local,
      });
      inFlightRef.current = false;
      if (cancelled) return;

      if (res.storeKind) setStoreKind(res.storeKind);

      if (!res.ok) {
        setConnected('error');
        setErrorText(res.error || '连接异常，正在重试');
        if (/不存在|已解散|房间号无效/.test(res.error || '')) resetLocal();
        return;
      }

      setConnected('online');
      setErrorText('');

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
      if (res.room) {
        setRoom(res.room);
        applyRoomState(res.room, res.isHost === true);
      }
      if (res.events && res.events.length) {
        sinceRef.current = Math.max(
          sinceRef.current,
          ...res.events.map((e) => e.seq)
        );
        setEvents((prev) => [...prev, ...(res.events || [])].slice(-100));
      }
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomId, artPlayerRef, currentEpisodeIndex, applyRoomState, resetLocal]);

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
    if (!isHostRef.current) {
      alignedRef.current = false;
    }
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
  }, [artPlayerRef, currentEpisodeIndex, applyRoomState, showHint]);

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

  return (
    <div
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
            🎬 共同观影室
          </span>
          {room && (
            <span className='truncate text-xs text-gray-500 dark:text-gray-400'>
              房间 {room.id} · {isHost ? '房主' : '成员'} · {statusText} ·{' '}
              {room.members.length} 人
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
          <div
            className={
              compact
                ? 'flex flex-col gap-2'
                : 'flex flex-col gap-3 sm:flex-row sm:items-center'
            }
          >
            <button
              type='button'
              onClick={createRoom}
              disabled={busy}
              className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50'
            >
              {busy ? '处理中…' : '创建房间'}
            </button>
            <div className='flex flex-1 gap-2'>
              <input
                value={joinCode}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().slice(0, 7))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void joinRoom(joinCode);
                }}
                placeholder='输入 6 位房间号'
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
            {compact
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
                  {room.members.map((member) => (
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
              </div>

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
