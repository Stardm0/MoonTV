'use client';

import {
  Check,
  Clapperboard,
  Copy,
  DoorOpen,
  Globe,
  LoaderCircle,
  Lock,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import Swal from 'sweetalert2';

import {
  cacheMemberId,
  clearCachedMemberId,
  roomRequest,
} from '@/lib/watch-room/client';
import {
  DEFAULT_ROOM_CAPACITY,
  MAX_ROOM_CAPACITY,
  normalizeCapacity,
  resolveCreateCapacity,
  WatchRoom,
} from '@/lib/watch-room/types';

import PageLayout from '@/components/PageLayout';

function readDisplayName(): string {
  try {
    const raw = document.cookie
      .split('; ')
      .find((item) => item.startsWith('auth='))
      ?.slice('auth='.length);
    if (!raw) return '观众';
    let decoded = decodeURIComponent(raw);
    if (decoded.includes('%')) decoded = decodeURIComponent(decoded);
    const username = JSON.parse(decoded)?.username;
    return typeof username === 'string' ? username.slice(0, 20) : '观众';
  } catch {
    return '观众';
  }
}

function inviteUrl(room: WatchRoom): string {
  const url = new URL(room.playPath || '/play', window.location.origin);
  url.searchParams.set('room', room.id);
  return url.toString();
}

/** 房间当前播放内容的展示文案，公开列表与我的房间共用 */
function describeRoom(room: WatchRoom): string {
  const video =
    room.playPath === '/play'
      ? '尚未开始播放'
      : room.videoTitle || room.title || '共同观影室';
  const episode = room.episode > 1 ? ` · 第 ${room.episode} 集` : '';
  // 只认服务端按 presence 实时统计的人数；members 是裁剪过的预览名单，
  // 不能用它的长度冒充在线人数。设置了上限时一并展示容量。
  const count = Math.max(0, Number(room.memberCount) || 0);
  const cap = normalizeCapacity(room.maxMembers);
  const countText = cap ? `${count}/${cap} 人在线` : `${count} 人在线`;
  return `${video}${episode} · ${countText}`;
}

export default function WatchRoomPage() {
  const [rooms, setRooms] = useState<WatchRoom[]>([]);
  const [publicRooms, setPublicRooms] = useState<WatchRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [publicLoading, setPublicLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  // 留空 = 采用默认上限（20 人）；只保留数字，避免移动端带出步进箭头
  const [capacityInput, setCapacityInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // fresh=true：跳过服务端列表缓存，并按 presence 重新统计每个房间的
  // 真实在线人数，保证点刷新后拿到的是「已进入且仍保持连接」的人数。
  const loadPublicRooms = useCallback(async () => {
    setPublicLoading(true);
    const res = await roomRequest({ action: 'publicRooms', fresh: true });
    setPublicLoading(false);
    if (!res.ok) return;
    setPublicRooms(res.rooms || []);
  }, []);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    const res = await roomRequest({ action: 'myRooms', fresh: true });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || '读取观影室失败');
      return;
    }
    setError('');
    setRooms(res.rooms || []);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadRooms(), loadPublicRooms()]);
  }, [loadRooms, loadPublicRooms]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const createRoom = async () => {
    if (busy) return;

    const existing = await roomRequest({ action: 'hasPersistentRoom' });
    if (existing.ok && existing.room) {
      setError('你已经创建过观影室了，不能重复创建');
      return;
    }

    const nextRoomName = roomNameInput.trim() || '共同观影室';

    setBusy(true);
    setError('');
    const res = await roomRequest({
      action: 'create',
      name: readDisplayName(),
      title: '共同观影室',
      roomName: nextRoomName,
      playPath: '/play',
      episode: 1,
      persistent: true,
      // 默认不公开：需要房主手动点「公开」才会出现在公开列表
      isPublic: false,
      maxMembers: resolveCreateCapacity(capacityInput),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || '创建观影室失败');
      return;
    }
    const capacity = resolveCreateCapacity(capacityInput);
    setRoomNameInput('');
    setCapacityInput('');
    setNotice(
      `观影室已创建（未公开，最多 ${capacity} 人），点「公开」后其他人才能在观影室页面看到`
    );
    await refreshAll();
  };

  /** 切换公开状态：公开后房间会出现在本页面的公开列表里 */
  const togglePublic = async (room: WatchRoom) => {
    const nextPublic = room.isPublic !== true;
    if (nextPublic && room.enabled === false) {
      setError('请先开启观影室再公开');
      return;
    }
    setBusy(true);
    setError('');
    const res = await roomRequest({
      action: 'setPublic',
      roomId: room.id,
      public: nextPublic,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || (nextPublic ? '公开观影室失败' : '取消公开失败'));
      return;
    }
    setNotice(nextPublic ? '观影室已公开' : '观影室已取消公开');
    await refreshAll();
  };

  const toggleRoom = async (room: WatchRoom) => {
    const roomIsClosed = room.enabled === false;
    const result = await Swal.fire({
      title: roomIsClosed ? '确认开启观影室？' : '确认关闭观影室？',
      text: roomIsClosed
        ? '开启后房间将重新接收心跳并继续同步。'
        : '关闭后房间将暂停接收心跳，邀请链接也会失效，并从公开列表中移除。',
      icon: roomIsClosed ? 'question' : 'warning',
      showCancelButton: true,
      confirmButtonText: roomIsClosed ? '确认开启' : '确认关闭',
      cancelButtonText: '取消',
      confirmButtonColor: roomIsClosed ? '#16a34a' : '#dc2626',
    });
    if (!result.isConfirmed) return;
    setBusy(true);
    const res = await roomRequest({
      action: roomIsClosed ? 'activateOwned' : 'close',
      roomId: room.id,
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error || (roomIsClosed ? '开启观影室失败' : '关闭观影室失败')
      );
      return;
    }
    await refreshAll();
  };

  const deleteRoom = async (roomId: string) => {
    const result = await Swal.fire({
      title: '确认删除观影室？',
      text: '删除后该房间会从数据库中彻底移除，无法恢复。',
      icon: 'error',
      showCancelButton: true,
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      confirmButtonColor: '#dc2626',
    });
    if (!result.isConfirmed) return;
    setBusy(true);
    const res = await roomRequest({ action: 'delete', roomId });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || '删除观影室失败');
      return;
    }
    clearCachedMemberId(roomId);
    setRooms((current) => current.filter((room) => room.id !== roomId));
    setPublicRooms((current) => current.filter((room) => room.id !== roomId));
  };

  const enterRoom = async (room: WatchRoom) => {
    setBusy(true);
    setError('');
    const res = await roomRequest({
      action: 'enterOwned',
      roomId: room.id,
      name: readDisplayName(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || '进入观影室失败');
      return;
    }
    // enterOwned 可能重新分配了房主 memberId。先写进 sessionStorage，播放页
    // 的 URL 入房才能带着同一个 id 继续心跳，避免首轮 sync 又做一次重接管。
    if (res.memberId) cacheMemberId(room.id, res.memberId);
    const url = new URL(res.room?.playPath || '/play', window.location.origin);
    url.searchParams.set('room', room.id);
    window.location.assign(url.toString());
  };

  /** 公开房间：非创建者直接通过邀请链接入房 */
  const joinPublicRoom = (room: WatchRoom) => {
    const url = new URL(room.playPath || '/play', window.location.origin);
    url.searchParams.set('room', room.id);
    window.location.assign(url.toString());
  };

  const copyInvite = async (room: WatchRoom) => {
    const url = inviteUrl(room);
    try {
      await navigator.clipboard.writeText(url);
      setNotice(`观影室 ${room.id} 邀请链接已复制`);
    } catch {
      window.prompt('复制邀请链接：', url);
    }
  };

  return (
    <PageLayout>
      <main className='mx-auto w-full max-w-5xl px-4 pb-24 pt-6 md:px-6 md:pt-10'>
        {/* 窄屏：标题独占一行，控件区两行铺满（两个输入并排 / 刷新+创建并排），
            避免 flex-wrap 把控件逐个挤到下一行形成参差的多行。
            sm 及以上恢复原来的单行横排布局。 */}
        <header className='mb-6 flex flex-col gap-3 border-b border-gray-200 pb-4 dark:border-gray-700 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between'>
          <div className='flex min-w-0 items-center gap-3'>
            <Clapperboard className='h-6 w-6 shrink-0 text-green-600 dark:text-green-400' />
            <div className='min-w-0'>
              <h1 className='text-xl font-semibold text-gray-900 dark:text-white'>
                观影室
              </h1>
              <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
                你的房间由你管理，公开后会出现在下方列表供其他人加入
              </p>
            </div>
          </div>
          <div className='grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-1 sm:flex-wrap sm:items-center sm:justify-end'>
            <input
              value={roomNameInput}
              onChange={(e) => setRoomNameInput(e.target.value.slice(0, 20))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && rooms.length === 0)
                  void createRoom();
              }}
              aria-label='房间名称'
              placeholder='共同观影室'
              className='h-10 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-green-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 sm:w-auto sm:min-w-[180px] sm:max-w-[280px] sm:flex-1'
            />
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
                if (e.key === 'Enter' && !busy && rooms.length === 0)
                  void createRoom();
              }}
              inputMode='numeric'
              aria-label='人数上限'
              title={`默认 ${DEFAULT_ROOM_CAPACITY} 人，最多 ${MAX_ROOM_CAPACITY} 人`}
              placeholder={`默认 ${DEFAULT_ROOM_CAPACITY} 人`}
              className='h-10 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-green-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 sm:w-[112px] sm:flex-none'
            />
            <div className='col-span-2 flex min-w-0 gap-2 sm:shrink-0'>
              <button
                type='button'
                onClick={() => void refreshAll()}
                disabled={loading || publicLoading}
                title='刷新列表'
                aria-label='刷新列表'
                className='inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
              >
                <RefreshCw
                  className={`h-4 w-4 ${
                    loading || publicLoading ? 'animate-spin' : ''
                  }`}
                />
              </button>
              <button
                type='button'
                onClick={() => void createRoom()}
                disabled={busy || rooms.length > 0}
                className='inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none'
              >
                {busy ? (
                  <LoaderCircle className='h-4 w-4 shrink-0 animate-spin' />
                ) : (
                  <Plus className='h-4 w-4 shrink-0' />
                )}
                创建观影室
              </button>
            </div>
          </div>
        </header>

        {error && (
          <p
            role='alert'
            className='mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300'
          >
            {error}
          </p>
        )}
        {notice && (
          <p className='mb-4 flex items-center gap-2 text-sm text-green-700 dark:text-green-400'>
            <Check className='h-4 w-4' />
            {notice}
          </p>
        )}

        <section className='mb-10'>
          <h2 className='mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white'>
            <UsersRound className='h-4 w-4 text-green-600 dark:text-green-400' />
            我的观影室
          </h2>
          {loading ? (
            <div className='flex items-center gap-2 py-12 text-sm text-gray-500'>
              <LoaderCircle className='h-4 w-4 animate-spin' />
              正在加载观影室
            </div>
          ) : rooms.length === 0 ? (
            <section className='border-y border-gray-200 py-12 text-center dark:border-gray-700'>
              <Clapperboard className='mx-auto h-8 w-8 text-gray-400' />
              <h3 className='mt-3 text-base font-medium text-gray-900 dark:text-white'>
                还没有观影室
              </h3>
              <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
                创建后可分享房间号；之后播放的影片都会继续使用这个房间。
              </p>
            </section>
          ) : (
            <ul className='divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-700 dark:border-gray-700'>
              {rooms.map((room) => (
                <li
                  key={room.id}
                  className='flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between'
                >
                  <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                      <h3 className='text-base font-semibold text-gray-900 dark:text-white'>
                        {room.title || '共同观影室'}
                      </h3>
                      <span className='font-mono text-sm font-semibold tracking-wider text-green-700 dark:text-green-400'>
                        {room.id}
                      </span>
                      <span className='text-xs text-gray-500 dark:text-gray-400'>
                        房主：{room.hostName}
                      </span>
                      {room.isPublic && (
                        <span className='inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400'>
                          <Globe className='h-3 w-3' />
                          已公开
                        </span>
                      )}
                      {normalizeCapacity(room.maxMembers) !== undefined && (
                        <span className='rounded-full bg-gray-500/10 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300'>
                          限 {normalizeCapacity(room.maxMembers)} 人
                        </span>
                      )}
                      {room.enabled === false && (
                        <span className='rounded-full bg-gray-500/10 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300'>
                          已关闭
                        </span>
                      )}
                    </div>
                    <p className='mt-1 truncate text-sm text-gray-500 dark:text-gray-400'>
                      当前影片：{describeRoom(room)}
                    </p>
                    <p className='mt-1 text-xs text-gray-400'>
                      创建于 {new Date(room.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {/* 窄屏：5 个按钮改成规整的 2 列网格，主操作独占整行、
                      其余 2×2 对齐，避免 flex-wrap 把按钮逐个挤到下一行形成
                      参差的多行；sm 及以上恢复原来的单行横排。 */}
                  <div className='grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end'>
                    <button
                      type='button'
                      onClick={() => void enterRoom(room)}
                      disabled={busy}
                      className='col-span-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-green-600 px-3 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 sm:w-auto'
                    >
                      <DoorOpen className='h-4 w-4' />
                      {room.enabled === false ? '恢复播放' : '播放此房间'}
                    </button>
                    <button
                      type='button'
                      onClick={() => void copyInvite(room)}
                      className='inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 sm:w-auto'
                    >
                      <Copy className='h-4 w-4' />
                      邀请
                    </button>
                    <button
                      type='button'
                      onClick={() => void togglePublic(room)}
                      disabled={busy}
                      title={room.isPublic ? '取消公开' : '公开到观影室列表'}
                      className={`inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50 sm:w-auto ${
                        room.isPublic
                          ? 'border-green-300 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-950/40'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800'
                      }`}
                    >
                      {room.isPublic ? (
                        <Globe className='h-4 w-4' />
                      ) : (
                        <Lock className='h-4 w-4' />
                      )}
                      {room.isPublic ? '公开中' : '公开'}
                    </button>
                    <button
                      type='button'
                      onClick={() => void toggleRoom(room)}
                      disabled={busy}
                      title={
                        room.enabled === false ? '开启观影室' : '关闭观影室'
                      }
                      className='inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 sm:w-auto'
                    >
                      {room.enabled === false ? (
                        <Power className='h-4 w-4 sm:hidden' />
                      ) : (
                        <PowerOff className='h-4 w-4 sm:hidden' />
                      )}
                      {room.enabled === false ? '开启' : '关闭'}
                    </button>
                    <button
                      type='button'
                      onClick={() => void deleteRoom(room.id)}
                      disabled={busy}
                      title='删除观影室'
                      className='inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950/40 sm:w-9 sm:gap-0'
                    >
                      <Trash2 className='h-4 w-4' />
                      <span className='sm:hidden'>删除</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className='mb-3 flex items-center justify-between gap-2'>
            <h2 className='flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white'>
              <Globe className='h-4 w-4 text-green-600 dark:text-green-400' />
              公开观影室
            </h2>
            <span className='text-xs text-gray-400'>
              {publicRooms.length} 个房间
            </span>
          </div>
          {publicLoading ? (
            <div className='flex items-center gap-2 py-10 text-sm text-gray-500'>
              <LoaderCircle className='h-4 w-4 animate-spin' />
              正在加载公开观影室
            </div>
          ) : publicRooms.length === 0 ? (
            <section className='border-y border-gray-200 py-10 text-center dark:border-gray-700'>
              <Globe className='mx-auto h-7 w-7 text-gray-400' />
              <p className='mt-2 text-sm text-gray-500 dark:text-gray-400'>
                还没有公开的观影室，创建一个并点「公开」即可出现在这里。
              </p>
            </section>
          ) : (
            <ul className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              {publicRooms.map((room) => (
                <li
                  key={room.id}
                  className='flex flex-col gap-3 rounded-xl border border-gray-200 p-4 transition hover:border-green-400 dark:border-gray-700 dark:hover:border-green-600'
                >
                  <div className='flex items-start justify-between gap-2'>
                    <div className='min-w-0'>
                      <h3 className='truncate text-base font-semibold text-gray-900 dark:text-white'>
                        {room.title || '共同观影室'}
                      </h3>
                      <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
                        房主：{room.hostName} · 房间{' '}
                        <span className='font-mono tracking-wider'>
                          {room.id}
                        </span>
                      </p>
                    </div>
                    <span className='inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400'>
                      <Globe className='h-3 w-3' />
                      公开
                    </span>
                  </div>
                  <p className='truncate text-sm text-gray-500 dark:text-gray-400'>
                    {describeRoom(room)}
                  </p>
                  <div className='flex gap-2'>
                    <button
                      type='button'
                      onClick={() => joinPublicRoom(room)}
                      className='inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-green-600 px-3 text-sm font-medium text-white hover:bg-green-700'
                    >
                      <DoorOpen className='h-4 w-4' />
                      进入房间
                    </button>
                    <button
                      type='button'
                      onClick={() => void copyInvite(room)}
                      className='inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800'
                    >
                      <Copy className='h-4 w-4' />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </PageLayout>
  );
}
