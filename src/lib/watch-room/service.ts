/* eslint-disable @typescript-eslint/no-explicit-any */

import { getRoomStore, getStoreKind, RoomStore } from './store';
import {
  cleanText,
  EVENT_LIMIT,
  isRoomId,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  MEMBER_TIMEOUT_MS,
  RoomEvent,
  RoomRequest,
  RoomResponse,
  WatchRoom,
} from './types';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeSyncMode(value: unknown): 'auto' | 'manual' {
  return value === 'manual' ? 'manual' : 'auto';
}

function randomString(length: number, alphabet = ID_ALPHABET): string {
  const bytes = new Uint8Array(length);
  const cryptoApi =
    globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function'
      ? globalThis.crypto
      : null;

  if (cryptoApi) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function makeMemberId(): string {
  return `m_${randomString(12, '0123456789abcdef')}`;
}

function safeTime(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 7 * 24 * 3600);
}

function fail(error: string): RoomResponse {
  return { ok: false, error, storeKind: getStoreKind() };
}

async function makeRoomId(store: RoomStore): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = randomString(6);
    if (!(await store.getRoom(id))) return id;
  }
  // 极小概率碰撞，追加一位便于排查
  return randomString(7);
}

function resolveName(identityName: string, fallback: unknown): string {
  return (
    cleanText(identityName, MAX_NAME_LENGTH) ||
    cleanText(fallback, MAX_NAME_LENGTH) ||
    '观众'
  );
}

interface EventDraft {
  type: RoomEvent['type'];
  actorId: string;
  actorName: string;
  text: string;
}

/**
 * 追加一条事件。seq 由存储层原子分配（Upstash 用 INCR，内存用单调计数），
 * 因此并发的成员不会拿到重复序号，客户端按 seq 增量拉取即可。
 */
async function emit(
  store: RoomStore,
  room: WatchRoom,
  draft: EventDraft
): Promise<void> {
  const seq = await store.nextSeq(room.id);
  await store.appendEvent(room.id, {
    ...draft,
    seq,
    at: Date.now(),
  });
  room.seq = seq;
}

function findMember(room: WatchRoom, memberId: string) {
  return room.members.find((m) => m.id === memberId);
}

/** 房主离开时，把控制权交给最早加入的成员，避免房间瘫痪 */
function transferHostIfNeeded(room: WatchRoom, emitter: EventDraft[]) {
  if (room.members.some((m) => m.id === room.hostId)) return;
  const next = [...room.members].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!next) return;
  room.hostId = next.id;
  room.hostName = next.name;
  emitter.push({
    type: 'system',
    actorId: next.id,
    actorName: next.name,
    text: `${next.name} 成为新房主`,
  });
}

export async function handleRoomAction(
  input: RoomRequest,
  identity: { name: string }
): Promise<RoomResponse> {
  const store = getRoomStore();
  const storeKind = getStoreKind();
  const now = Date.now();
  const action = input?.action;

  if (!action) return fail('缺少 action');

  // ---------------------------------------------------------------- create
  if (action === 'create') {
    const name = resolveName(identity.name, input.name);
    const playPath = cleanText(input.playPath, 1000);
    if (!playPath.startsWith('/play')) return fail('播放页地址无效');

    const id = await makeRoomId(store);
    const memberId = makeMemberId();
    const room: WatchRoom = {
      id,
      hostId: memberId,
      hostName: name,
      title: cleanText(input.title, 100) || '一起看片',
      playPath,
      episode: Number.isFinite(input.episode) ? Number(input.episode) : 1,
      defaultSyncMode: 'auto',
      state: { playing: false, time: 0, updatedAt: now },
      members: [
        { id: memberId, name, joinedAt: now, lastSeen: now, syncMode: 'auto' },
      ],
      seq: 0,
      createdAt: now,
      lastActiveAt: now,
    };

    // 先落盘再追加事件：内存实现的 nextSeq 依赖房间条目已存在
    await store.saveRoom(room);
    await emit(store, room, {
      type: 'system',
      actorId: memberId,
      actorName: name,
      text: `${name} 创建了房间，等待伙伴加入`,
    });
    await store.saveRoom(room);

    return {
      ok: true,
      room,
      events: await store.listEvents(id, 0),
      memberId,
      isHost: true,
      serverTime: now,
      storeKind,
    };
  }

  // ------------------------------------------------------------------ join
  if (action === 'join') {
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room) return fail('房间不存在或已解散');

    const name = resolveName(identity.name, input.name);
    const memberId = makeMemberId();
    room.members.push({
      id: memberId,
      name,
      joinedAt: now,
      lastSeen: now,
      syncMode: room.defaultSyncMode || 'auto',
    });
    room.lastActiveAt = now;

    await emit(store, room, {
      type: 'system',
      actorId: memberId,
      actorName: name,
      text: `${name} 加入了房间`,
    });
    await store.saveRoom(room);

    return {
      ok: true,
      room,
      events: await store.listEvents(room.id, 0),
      memberId,
      isHost: false,
      serverTime: now,
      storeKind,
    };
  }

  // -------------------------------------------------------------- 公共校验
  if (!isRoomId((input as any).roomId)) return fail('房间号无效');
  const roomId = (input as any).roomId as string;
  const room = await store.getRoom(roomId);
  if (!room) return fail('房间不存在或已解散');

  if (action === 'sync') {
    const pending: EventDraft[] = [];
    let memberId = cleanText(input.memberId, 64);
    let member = findMember(room, memberId);
    let rejoined = false;

    // 自愈：房间重启 / 内存存储换实例后，旧的 memberId 可能已失效。
    // 此时静默重新入房，客户端会收到新的 memberId 并覆盖本地缓存。
    if (!member) {
      const name = resolveName(identity.name, input.name);
      memberId = makeMemberId();
      member = {
        id: memberId,
        name,
        joinedAt: now,
        lastSeen: now,
        syncMode: room.defaultSyncMode || 'auto',
      };
      room.members.push(member);
      rejoined = true;
    }
    member.lastSeen = now;
    member.syncMode = normalizeSyncMode(
      member.syncMode ?? room.defaultSyncMode ?? 'auto'
    );
    room.lastActiveAt = now;

    // 超时成员清理（当前调用者刚上报过，不会被误判）
    const active = room.members.filter(
      (m) => m.id === memberId || now - m.lastSeen <= MEMBER_TIMEOUT_MS
    );
    const departed = room.members.filter((m) => !active.includes(m));
    room.members = active;
    for (const d of departed) {
      pending.push({
        type: 'system',
        actorId: d.id,
        actorName: d.name,
        text: `${d.name} 离开了房间`,
      });
    }
    transferHostIfNeeded(room, pending);

    const isHost = room.hostId === memberId;
    room.defaultSyncMode = normalizeSyncMode(room.defaultSyncMode ?? 'auto');
    member.syncMode = normalizeSyncMode(
      member.syncMode ?? room.defaultSyncMode
    );

    if (isHost) {
      // 房心跳：以房主播放器为准，成员不做权威上报
      if (input.local) {
        room.state = {
          time: safeTime(input.local.time),
          playing: !!input.local.playing,
          updatedAt: now,
        };
      }
      const playPath = cleanText(input.playPath, 1000);
      if (playPath.startsWith('/play') && playPath !== room.playPath) {
        room.playPath = playPath;
        if (Number.isFinite(input.episode)) {
          room.episode = Number(input.episode);
          pending.push({
            type: 'control',
            actorId: memberId,
            actorName: member.name,
            text: `房主切换到第 ${room.episode} 集`,
          });
        }
      }
    }

    if (rejoined) {
      pending.push({
        type: 'system',
        actorId: memberId,
        actorName: member.name,
        text: `${member.name} 加入了房间`,
      });
    }

    for (const draft of pending) await emit(store, room, draft);
    await store.saveRoom(room);

    const since = Number.isFinite(input.since)
      ? Math.max(0, Math.floor(input.since))
      : 0;
    return {
      ok: true,
      room,
      events: (await store.listEvents(roomId, since)).slice(0, EVENT_LIMIT),
      memberId,
      isHost,
      serverTime: now,
      storeKind,
    };
  }

  // -------------------------------------------------------------- setSyncMode
  if (action === 'setSyncMode') {
    const member = findMember(room, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');

    const nextMode = normalizeSyncMode(input.syncMode);
    room.lastActiveAt = now;

    if (room.hostId === member.id) {
      room.defaultSyncMode = nextMode;
      room.members = room.members.map((item) =>
        item.id === member.id ? { ...item, syncMode: nextMode } : item
      );
      await emit(store, room, {
        type: 'control',
        actorId: member.id,
        actorName: member.name,
        text: `房主将默认同步模式切换为${
          nextMode === 'manual' ? '手动同步' : '自动同步'
        }`,
      });
    } else {
      member.syncMode = nextMode;
      await emit(store, room, {
        type: 'control',
        actorId: member.id,
        actorName: member.name,
        text: `${member.name} 将自己的同步模式切换为${
          nextMode === 'manual' ? '手动同步' : '自动同步'
        }`,
      });
    }

    await store.saveRoom(room);

    return {
      ok: true,
      room,
      events: [],
      isHost: room.hostId === member.id,
      serverTime: now,
      storeKind,
    };
  }

  // --------------------------------------------------------------- control
  if (action === 'control') {
    const member = findMember(room, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');
    if (room.hostId !== member.id) return fail('仅房主可以控制播放');

    room.state = {
      time: safeTime(input.time),
      playing: !!input.playing,
      updatedAt: now,
    };
    room.lastActiveAt = now;

    const verb: Record<string, string> = {
      play: '开始播放',
      pause: '暂停了播放',
      seek: '拖动了进度',
      episode: '切换了剧集',
    };
    await emit(store, room, {
      type: 'control',
      actorId: member.id,
      actorName: member.name,
      text: `${member.name} ${verb[input.kind] || '调整了播放'}`,
    });
    await store.saveRoom(room);

    return {
      ok: true,
      room,
      events: [],
      isHost: true,
      serverTime: now,
      storeKind,
    };
  }

  // ------------------------------------------------------------------ chat
  if (action === 'chat') {
    const member = findMember(room, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');
    const text = cleanText(input.text, MAX_MESSAGE_LENGTH);
    if (!text) return fail('消息不能为空');

    room.lastActiveAt = now;
    await emit(store, room, {
      type: 'chat',
      actorId: member.id,
      actorName: member.name,
      text,
    });
    await store.saveRoom(room);

    return {
      ok: true,
      room,
      events: [],
      isHost: room.hostId === member.id,
      serverTime: now,
      storeKind,
    };
  }

  // ----------------------------------------------------------------- leave
  if (action === 'leave') {
    const member = findMember(room, cleanText(input.memberId, 64));
    if (!member) return { ok: true, serverTime: now, storeKind };

    room.members = room.members.filter((m) => m.id !== member.id);
    room.lastActiveAt = now;

    if (room.members.length === 0) {
      await store.deleteRoom(roomId);
      return { ok: true, serverTime: now, storeKind };
    }

    const pending: EventDraft[] = [
      {
        type: 'system',
        actorId: member.id,
        actorName: member.name,
        text: `${member.name} 离开了房间`,
      },
    ];
    transferHostIfNeeded(room, pending);
    for (const draft of pending) await emit(store, room, draft);
    await store.saveRoom(room);

    return { ok: true, serverTime: now, storeKind };
  }

  return fail('未知的 action');
}
