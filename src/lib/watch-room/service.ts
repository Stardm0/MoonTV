/* eslint-disable @typescript-eslint/no-explicit-any */

import { getRoomStore, getStoreKind, PresenceView, RoomStore } from './store';
import {
  CHAT_COOLDOWN_MS,
  cleanText,
  EVENT_LIMIT,
  EventDraft,
  isRoomId,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  MEMBER_PREVIEW_LIMIT,
  MEMBER_TIMEOUT_MS,
  ROOM_TTL_SECONDS,
  RoomEvent,
  RoomMember,
  RoomRequest,
  RoomResponse,
  RoomSyncMode,
  WatchRoom,
} from './types';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 公开列表的全表扫描结果缓存 4 秒，避免大厅页面反复 SCAN / 全表 SELECT */
const ROOMS_CACHE_MS = 4_000;
let roomsCache: { at: number; rooms: WatchRoom[] } | null = null;

/** 非房主实例最多每 5 秒帮忙刷新一次持久化的人数，防止大厅人数长期失真 */
const COUNT_REFRESH_MS = 5_000;
const lastCountRefresh = new Map<string, number>();

function invalidateRoomsCache(): void {
  roomsCache = null;
}

async function cachedListRooms(store: RoomStore): Promise<WatchRoom[]> {
  const now = Date.now();
  if (roomsCache && now - roomsCache.at < ROOMS_CACHE_MS)
    return roomsCache.rooms;
  const rooms = await store.listRooms();
  roomsCache = { at: now, rooms };
  return rooms;
}

function allowCountRefresh(roomId: string, now: number): boolean {
  const last = lastCountRefresh.get(roomId) || 0;
  if (now - last < COUNT_REFRESH_MS) return false;
  lastCountRefresh.set(roomId, now);
  if (lastCountRefresh.size > 512) {
    // 简单容量保护，避免长期运行后 Map 无限增长
    // Array.from 生成快照：既兼容低 target，也避免遍历中 delete 影响迭代器
    for (const [id, at] of Array.from(lastCountRefresh.entries())) {
      if (now - at > COUNT_REFRESH_MS * 10) lastCountRefresh.delete(id);
    }
  }
  return true;
}

function normalizeSyncMode(value: unknown): RoomSyncMode {
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

function ttlOf(room: WatchRoom): number {
  return room.persistent ? 0 : ROOM_TTL_SECONDS;
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

function makeDraft(
  type: RoomEvent['type'],
  actorId: string,
  actorName: string,
  text: string
): EventDraft {
  return { type, actorId, actorName, text, at: Date.now() };
}

/** 所有房间核心写入统一走这里：递增版本号，供客户端判断是否需要刷新 */
async function saveCore(store: RoomStore, room: WatchRoom): Promise<void> {
  room.rev = (Number.isFinite(room.rev) ? Number(room.rev) : 0) + 1;
  room.lastActiveAt = Date.now();
  await store.saveRoom(room);
}

/** 响应里永远只带裁剪后的名单预览 + 精确人数，不再推全量成员 */
function toView(
  room: WatchRoom,
  presence: PresenceView,
  seq: number
): WatchRoom {
  return {
    ...room,
    members: presence.members,
    memberCount: presence.count,
    seq,
  };
}

async function readEvents(
  store: RoomStore,
  roomId: string,
  since: number
): Promise<{ events: RoomEvent[]; latest: number }> {
  const latest = await store.getSeq(roomId);
  // 绝大多数心跳没有新事件：一次轻量 GET/SELECT 即可完全跳过列表读取
  if (latest <= since) return { events: [], latest };
  const limit = Math.min(EVENT_LIMIT, Math.max(1, latest - since));
  const events = await store.listEvents(roomId, since, limit);
  return { events, latest };
}

function presenceFor(
  store: RoomStore,
  room: WatchRoom,
  extraIds: string[] = []
): Promise<PresenceView> {
  return store.getPresence(room.id, MEMBER_TIMEOUT_MS, MEMBER_PREVIEW_LIMIT, [
    room.hostId,
    ...extraIds,
  ]);
}

/** 批量、原子分配 seq，一次写完所有事件；大房间批量离线不再逐条往返 */
async function emitDrafts(
  store: RoomStore,
  room: WatchRoom,
  drafts: EventDraft[]
): Promise<void> {
  if (!drafts.length) return;
  await store.appendEvents(room.id, drafts, ttlOf(room));
}

/** 临时房间房主离线时，把控制权交给最早加入的活跃成员 */
async function transferHostIfNeeded(
  store: RoomStore,
  room: WatchRoom,
  presence: PresenceView,
  drafts: EventDraft[]
): Promise<boolean> {
  if (room.persistent) return false;
  // presenceFor 会把 hostId 放进 preferIds，仍在线就一定出现在预览里
  if (presence.members.some((m) => m.id === room.hostId)) return false;
  const next = await store.pickOldestActiveMember(room.id, MEMBER_TIMEOUT_MS);
  if (!next) return false;
  room.hostId = next.id;
  room.hostName = next.name;
  drafts.push(
    makeDraft('system', next.id, next.name, `${next.name} 成为新房主`)
  );
  return true;
}

export async function handleRoomAction(
  input: RoomRequest,
  identity: { name: string; owner?: string }
): Promise<RoomResponse> {
  const store = getRoomStore();
  const storeKind = getStoreKind();
  const now = Date.now();
  const action = input?.action;
  const common = { serverTime: now, storeKind };

  if (!action) return fail('缺少 action');

  // ---------------------------------------------------------------- create
  if (action === 'create') {
    const name = resolveName(identity.name, input.name);
    if (input.persistent && !identity.owner) {
      return fail('请登录后创建长期观影室');
    }
    if (input.persistent && identity.owner) {
      const existing = (await cachedListRooms(store)).find(
        (item) => item.owner === identity.owner
      );
      if (existing) {
        return fail('你已经创建过观影室了，不能重复创建');
      }
    }
    const playPath = cleanText(input.playPath, 1000);
    if (!playPath.startsWith('/play')) return fail('播放页地址无效');

    const id = await makeRoomId(store);
    const memberId = makeMemberId();
    const videoTitle = cleanText(input.title, 100) || '一起看片';
    const customNameValue = cleanText(input.roomName, 100);
    const roomName = customNameValue || videoTitle;
    // 只有登录创建的持久房间才可以公开（临时房间无法在列表中持久展示）
    const publicAtCreate = input.persistent === true && input.isPublic === true;
    const hostMember: RoomMember = {
      id: memberId,
      name,
      joinedAt: now,
      lastSeen: now,
      syncMode: 'auto',
    };
    const room: WatchRoom = {
      id,
      hostId: memberId,
      hostName: name,
      owner: input.persistent ? identity.owner : undefined,
      persistent: input.persistent === true,
      enabled: true,
      isPublic: publicAtCreate,
      publicizedAt: publicAtCreate ? now : undefined,
      title: roomName,
      customName: !!customNameValue,
      videoTitle,
      playPath,
      episode: Number.isFinite(input.episode) ? Number(input.episode) : 1,
      defaultSyncMode: 'auto',
      state: { playing: false, time: 0, updatedAt: now },
      members: [],
      memberCount: 1,
      seq: 0,
      rev: 1,
      createdAt: now,
      lastActiveAt: now,
    };

    await store.saveRoom(room);
    await store.putMember(id, hostMember, ttlOf(room));
    await emitDrafts(store, room, [
      makeDraft('system', memberId, name, `${name} 创建了房间，等待伙伴加入`),
    ]);
    invalidateRoomsCache();

    const presence = await presenceFor(store, room, [memberId]);
    const { events, latest } = await readEvents(store, id, 0);
    return {
      ok: true,
      room: toView(room, presence, latest),
      events,
      memberId,
      isHost: true,
      memberCount: presence.count,
      mySyncMode: 'auto',
      rev: room.rev,
      ...common,
    };
  }

  if (action === 'hasPersistentRoom') {
    if (!identity.owner) return { ok: true, ...common };
    const rooms = await cachedListRooms(store);
    return {
      ok: true,
      room: rooms.find((item) => item.owner === identity.owner),
      ...common,
    };
  }

  if (action === 'myRooms') {
    if (!identity.owner) return fail('请登录后查看自己的观影室');
    const rooms = (await cachedListRooms(store)).filter(
      (room) => room.owner === identity.owner
    );
    return { ok: true, rooms, ...common };
  }

  // 公开大厅：只返回展示所需字段，不暴露 owner、事件序号、成员明细。
  // 人数用核心里由房主心跳维护的 memberCount，避免为列表里每个房间再查一次 presence。
  if (action === 'publicRooms') {
    const rooms = (await cachedListRooms(store))
      .filter((room) => room.isPublic === true && room.enabled !== false)
      .sort((a, b) => (b.publicizedAt || 0) - (a.publicizedAt || 0))
      .map(
        (room): WatchRoom => ({
          id: room.id,
          hostId: '',
          hostName: room.hostName,
          persistent: true,
          enabled: true,
          isPublic: true,
          publicizedAt: room.publicizedAt,
          title: room.title,
          customName: room.customName,
          videoTitle: room.videoTitle,
          playPath: room.playPath,
          episode: room.episode,
          defaultSyncMode: room.defaultSyncMode,
          state: {
            playing: false,
            time: 0,
            updatedAt: room.state?.updatedAt || now,
          },
          members: [],
          memberCount: Number(room.memberCount) || 0,
          seq: 0,
          rev: room.rev,
          createdAt: room.createdAt,
          lastActiveAt: room.lastActiveAt,
        })
      );
    return { ok: true, rooms, ...common };
  }

  // 公开 / 取消公开：仅创建者可以操作，且仅限持久观影室。
  if (action === 'setPublic') {
    if (!identity.owner) return fail('请登录后设置观影室公开状态');
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room) return fail('房间不存在或已删除');
    if (!room.persistent || room.owner !== identity.owner) {
      return fail('只有创建者可以设置此观影室');
    }
    const nextPublic = input.public === true;
    if (nextPublic && room.enabled === false) {
      return fail('请先开启观影室再公开');
    }
    room.isPublic = nextPublic;
    room.publicizedAt = nextPublic ? now : undefined;
    await saveCore(store, room);
    invalidateRoomsCache();

    const presence = await presenceFor(store, room);
    const latest = await store.getSeq(room.id);
    return {
      ok: true,
      room: toView(room, presence, latest),
      memberCount: presence.count,
      rev: room.rev,
      ...common,
    };
  }

  if (action === 'close') {
    if (!identity.owner) return fail('请登录后关闭观影室');
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room) return fail('房间不存在或已删除');
    if (!room.persistent || room.owner !== identity.owner) {
      return fail('只有创建者可以关闭此观影室');
    }
    room.enabled = false;
    room.isPublic = false;
    room.publicizedAt = undefined;
    await saveCore(store, room);
    invalidateRoomsCache();
    return { ok: true, room, ...common };
  }

  if (action === 'delete') {
    if (!identity.owner) return fail('请登录后删除观影室');
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room) return fail('房间不存在或已删除');
    if (!room.persistent || room.owner !== identity.owner) {
      return fail('只有创建者可以删除此观影室');
    }
    invalidateRoomsCache();
    await store.deleteRoom(room.id);
    return { ok: true, ...common };
  }

  if (action === 'enterOwned' || action === 'activateOwned') {
    if (!identity.owner) return fail('请登录后进入自己的观影室');
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room?.persistent || room.owner !== identity.owner) {
      return fail('观影室不存在或不属于当前账号');
    }
    const name = resolveName(
      identity.name,
      action === 'enterOwned' ? input.name : room.hostName
    );
    let member = await store.getMember(room.id, room.hostId);
    let memberId: string;
    const drafts: EventDraft[] = [];

    if (!member) {
      memberId = makeMemberId();
      member = {
        id: memberId,
        name,
        joinedAt: now,
        lastSeen: now,
        syncMode: normalizeSyncMode(room.defaultSyncMode || 'auto'),
      };
      room.hostId = memberId;
      room.hostName = name;
      drafts.push(
        makeDraft('system', memberId, name, `${name} 作为房主重新进入观影室`)
      );
    } else {
      memberId = member.id;
      member.name = name;
      member.lastSeen = now;
      member.syncMode = normalizeSyncMode(
        member.syncMode ?? room.defaultSyncMode ?? 'auto'
      );
      room.hostName = name;
    }
    await store.putMember(room.id, member, ttlOf(room));
    room.enabled = true;
    await saveCore(store, room);
    await emitDrafts(store, room, drafts);
    invalidateRoomsCache();

    const presence = await presenceFor(store, room, [memberId]);
    const { events, latest } = await readEvents(store, room.id, 0);
    return {
      ok: true,
      room: toView(room, presence, latest),
      events,
      memberId,
      isHost: true,
      memberCount: presence.count,
      mySyncMode: member.syncMode,
      rev: room.rev,
      ...common,
    };
  }

  // ------------------------------------------------------------------ join
  if (action === 'join') {
    if (!isRoomId(input.roomId)) return fail('房间号无效');
    const room = await store.getRoom(input.roomId);
    if (!room) return fail('房间不存在或已解散');
    if (room.enabled === false) {
      return fail('观影室已关闭，重新开启后才可继续使用');
    }

    const name = resolveName(identity.name, input.name);
    const memberId = makeMemberId();
    const member: RoomMember = {
      id: memberId,
      name,
      joinedAt: now,
      lastSeen: now,
      syncMode: normalizeSyncMode(room.defaultSyncMode || 'auto'),
    };
    await store.putMember(room.id, member, ttlOf(room));
    await emitDrafts(store, room, [
      makeDraft('system', memberId, name, `${name} 加入了房间`),
    ]);
    const presence = await presenceFor(store, room, [memberId]);
    room.memberCount = presence.count;
    await saveCore(store, room);
    invalidateRoomsCache();

    const { events, latest } = await readEvents(store, room.id, 0);
    return {
      ok: true,
      room: toView(room, presence, latest),
      events,
      memberId,
      isHost: false,
      memberCount: presence.count,
      mySyncMode: member.syncMode,
      rev: room.rev,
      ...common,
    };
  }

  // -------------------------------------------------------------- 公共校验
  if (!isRoomId((input as any).roomId)) return fail('房间号无效');
  const roomId = (input as any).roomId as string;
  const room = await store.getRoom(roomId);
  if (!room) return fail('房间不存在或已解散');
  // 关闭 / 删除 / 重新开启 / 公开设置均在前面的分支处理并直接 return，
  // 走到这里的只可能是成员侧动作，因此关闭的房间一律拒绝。
  if (room.enabled === false) {
    return fail('观影室已关闭，重新开启后才可继续使用');
  }

  // ---------------------------------------------------------------- sync
  if (action === 'sync') {
    const drafts: EventDraft[] = [];
    let memberId = cleanText(input.memberId, 64);
    let member = memberId ? await store.getMember(roomId, memberId) : null;
    // 元数据 key 的 TTL 比离线判定宽，在线标记已清掉时要当作未入房处理
    if (member && now - (member.lastSeen || 0) > MEMBER_TIMEOUT_MS * 2) {
      member = null;
    }
    let rejoined = false;

    // 持久房间创建者重新接管房主身份
    if (room.persistent && room.owner && identity.owner === room.owner) {
      if (!member || member.id !== room.hostId) {
        const oldHostId = room.hostId;
        memberId = makeMemberId();
        member = {
          id: memberId,
          name: resolveName(identity.name, input.name),
          joinedAt: now,
          lastSeen: now,
          syncMode: normalizeSyncMode(room.defaultSyncMode ?? 'auto'),
        };
        if (oldHostId && oldHostId !== memberId) {
          await store.removeMember(roomId, oldHostId);
        }
        room.hostId = memberId;
        room.hostName = member.name;
        rejoined = true;
      }
    } else if (room.persistent && room.owner) {
      // 只能由持久房间创建账号掌控房主身份，普通成员不能继承离线房主权限。
      if (memberId === room.hostId && !member) memberId = '';
    }

    // 自愈：房间重启 / 存储换实例后，旧的 memberId 可能已失效
    if (!member) {
      memberId = makeMemberId();
      member = {
        id: memberId,
        name: resolveName(identity.name, input.name),
        joinedAt: now,
        lastSeen: now,
        syncMode: normalizeSyncMode(room.defaultSyncMode ?? 'auto'),
      };
      rejoined = true;
    }

    member.lastSeen = now;
    member.syncMode = normalizeSyncMode(
      member.syncMode ?? room.defaultSyncMode ?? 'auto'
    );
    // 每个成员只写自己那一条小记录，不再重写整份房间对象
    await store.putMember(roomId, member, ttlOf(room));

    // 一次读取完成：超时清扫 + 精确人数 + 裁剪后的名单预览
    const presence = await presenceFor(store, room, [memberId]);
    let coreChanged = false;

    const normalizedDefault = normalizeSyncMode(room.defaultSyncMode ?? 'auto');
    if (room.defaultSyncMode !== normalizedDefault) {
      room.defaultSyncMode = normalizedDefault;
      coreChanged = true;
    }

    // 临时房间房主离线时移交控制权
    if (await transferHostIfNeeded(store, room, presence, drafts)) {
      coreChanged = true;
    }
    const isHost = room.hostId === memberId;

    // 人数变化主要由房主心跳持久化，其他实例低频兜底，避免 N 个成员同时抢写核心
    if (
      presence.count !== (Number(room.memberCount) || 0) &&
      (isHost || allowCountRefresh(room.id, now))
    ) {
      room.memberCount = presence.count;
      coreChanged = true;
    }

    if (rejoined) {
      drafts.push(
        makeDraft('system', memberId, member.name, `${member.name} 加入了房间`)
      );
    }

    // 超时离开聚合为一条系统提示；大房间散场时不会生成 N 条事件。
    // 只让房主上报，避免多实例并发清扫产生重复提示。
    if (presence.removed > 0 && isHost) {
      drafts.push(
        makeDraft(
          'system',
          '',
          '',
          presence.removed === 1
            ? '有 1 位观众离开了房间'
            : `有 ${presence.removed} 位观众离开了房间`
        )
      );
    }

    if (isHost) {
      // 房主心跳：以房主播放器为准，成员不做权威上报
      if (input.local) {
        room.state = {
          time: safeTime(input.local.time),
          playing: !!input.local.playing,
          updatedAt: now,
        };
        coreChanged = true;
      }
      const playPath = cleanText(input.playPath, 1000);
      const nextVideoTitle = cleanText(input.title, 100);
      const pathChanged =
        playPath.startsWith('/play') && playPath !== room.playPath;
      if (pathChanged) {
        room.playPath = playPath;
        coreChanged = true;
      }
      if (nextVideoTitle && nextVideoTitle !== room.videoTitle) {
        room.videoTitle = nextVideoTitle;
        if (room.customName !== true) room.title = nextVideoTitle;
        coreChanged = true;
      }
      if (pathChanged && Number.isFinite(input.episode)) {
        room.episode = Number(input.episode);
        drafts.push(
          makeDraft(
            'control',
            memberId,
            member.name,
            `房主切换了影片《${room.videoTitle || room.title}》第 ${
              room.episode
            } 集`
          )
        );
      }
    }

    if (coreChanged) await saveCore(store, room);
    await emitDrafts(store, room, drafts);

    const since = Number.isFinite(input.since)
      ? Math.max(0, Math.floor(input.since))
      : 0;
    const { events, latest } = await readEvents(store, roomId, since);

    const currentRev = Number.isFinite(room.rev) ? Number(room.rev) : 0;
    // 用 typeof 收窄成 number（Number.isFinite 不做类型收窄），既避免非空断言，
    // 也顺手挡掉字符串等非法输入。
    const rawRev = input.rev;
    const rawCount = input.memberCount;
    const clientRev =
      typeof rawRev === 'number' && Number.isFinite(rawRev)
        ? Math.max(0, Math.floor(rawRev))
        : -1;
    const clientCount =
      typeof rawCount === 'number' && Number.isFinite(rawCount)
        ? Math.max(0, Math.floor(rawCount))
        : -1;
    // 老客户端不带 rev / memberCount，一律返回完整（但仍是裁剪过的）快照
    const unchanged =
      clientRev >= 0 &&
      clientRev === currentRev &&
      clientCount === presence.count &&
      events.length === 0;

    if (unchanged) {
      return {
        ok: true,
        events: [],
        memberId,
        isHost,
        memberCount: presence.count,
        mySyncMode: member.syncMode,
        rev: currentRev,
        unchanged: true,
        ...common,
      };
    }

    return {
      ok: true,
      room: toView(room, presence, latest),
      events,
      memberId,
      isHost,
      memberCount: presence.count,
      mySyncMode: member.syncMode,
      rev: currentRev,
      ...common,
    };
  }

  // -------------------------------------------------------------- setSyncMode
  if (action === 'setSyncMode') {
    const member = await store.getMember(roomId, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');

    const nextMode = normalizeSyncMode(input.syncMode);
    member.syncMode = nextMode;
    member.lastSeen = now;
    await store.putMember(roomId, member, ttlOf(room));

    const drafts: EventDraft[] = [];
    let coreChanged = false;
    if (room.hostId === member.id) {
      if (room.defaultSyncMode !== nextMode) {
        room.defaultSyncMode = nextMode;
        coreChanged = true;
      }
      drafts.push(
        makeDraft(
          'control',
          member.id,
          member.name,
          `房主将默认同步模式切换为${
            nextMode === 'manual' ? '手动同步' : '自动同步'
          }`
        )
      );
    } else {
      drafts.push(
        makeDraft(
          'control',
          member.id,
          member.name,
          `${member.name} 将自己的同步模式切换为${
            nextMode === 'manual' ? '手动同步' : '自动同步'
          }`
        )
      );
    }
    if (coreChanged) await saveCore(store, room);
    await emitDrafts(store, room, drafts);

    const presence = await presenceFor(store, room, [member.id]);
    const latest = await store.getSeq(roomId);
    return {
      ok: true,
      room: toView(room, presence, latest),
      events: [],
      isHost: room.hostId === member.id,
      memberCount: presence.count,
      mySyncMode: nextMode,
      rev: Number(room.rev) || 0,
      ...common,
    };
  }

  // --------------------------------------------------------------- control
  if (action === 'control') {
    const member = await store.getMember(roomId, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');
    if (room.hostId !== member.id) return fail('仅房主可以控制播放');

    room.state = {
      time: safeTime(input.time),
      playing: !!input.playing,
      updatedAt: now,
    };
    await saveCore(store, room);

    const verb: Record<string, string> = {
      play: '开始播放',
      pause: '暂停了播放',
      seek: '拖动了进度',
      episode: '切换了剧集',
    };
    await emitDrafts(store, room, [
      makeDraft(
        'control',
        member.id,
        member.name,
        `${member.name} ${verb[input.kind] || '调整了播放'}`
      ),
    ]);

    // 控制动作不需要回传房间快照，下一次 sync 自然会带上最新状态
    return {
      ok: true,
      events: [],
      isHost: true,
      rev: Number(room.rev) || 0,
      ...common,
    };
  }

  // ------------------------------------------------------------------ chat
  if (action === 'chat') {
    const member = await store.getMember(roomId, cleanText(input.memberId, 64));
    if (!member) return fail('请先加入房间');
    const text = cleanText(input.text, MAX_MESSAGE_LENGTH);
    if (!text) return fail('消息不能为空');
    // 大房间的消息风暴保护：同一成员短时间内只允许一条
    if (member.lastChatAt && now - member.lastChatAt < CHAT_COOLDOWN_MS) {
      return fail('发送太快了，请稍后再试');
    }

    member.lastChatAt = now;
    member.lastSeen = now;
    await store.putMember(roomId, member, ttlOf(room));
    await emitDrafts(store, room, [
      makeDraft('chat', member.id, member.name, text),
    ]);

    return {
      ok: true,
      events: [],
      isHost: room.hostId === member.id,
      ...common,
    };
  }

  // ----------------------------------------------------------------- leave
  if (action === 'leave') {
    const member = await store.getMember(roomId, cleanText(input.memberId, 64));
    if (!member) return { ok: true, ...common };

    await store.removeMember(roomId, member.id);
    const presence = await presenceFor(store, room);

    if (room.persistent && member.id === room.hostId) {
      room.memberCount = presence.count;
      await saveCore(store, room);
      return { ok: true, ...common };
    }

    if (presence.count === 0) {
      if (room.persistent) {
        room.memberCount = 0;
        await saveCore(store, room);
      } else {
        invalidateRoomsCache();
        await store.deleteRoom(roomId);
      }
      return { ok: true, ...common };
    }

    const drafts: EventDraft[] = [
      makeDraft('system', member.id, member.name, `${member.name} 离开了房间`),
    ];
    await transferHostIfNeeded(store, room, presence, drafts);
    room.memberCount = presence.count;
    await emitDrafts(store, room, drafts);
    await saveCore(store, room);

    return { ok: true, ...common };
  }

  return fail('未知的 action');
}
