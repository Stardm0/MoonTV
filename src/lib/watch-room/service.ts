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
  normalizeCapacity,
  resolveCreateCapacity,
  ROOM_TTL_SECONDS,
  RoomEvent,
  RoomMember,
  RoomRequest,
  RoomResponse,
  RoomSyncMode,
  WatchRoom,
} from './types';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 房间列表的全表扫描结果缓存 4 秒，避免大厅页面反复 SCAN / 全表 SELECT */
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
  return freshListRooms(store, now);
}

/** 刷新列表：绕开 4 秒缓存直接读存储，并顺手把缓存更新为最新快照 */
async function freshListRooms(
  store: RoomStore,
  now: number
): Promise<WatchRoom[]> {
  const rooms = await store.listRooms();
  roomsCache = { at: now, rooms };
  return rooms;
}

/**
 * 按 presence 层实时统计每个房间「已进入且保持心跳连接」的人数。
 *
 * 房间核心里的 memberCount 是房主心跳异步回写的快照，加上列表缓存后，
 * 观众离开 / 加入时大厅页面可能长期显示旧值。这里改用成员在线标记
 * （超过 MEMBER_TIMEOUT_MS 未 sync 即视为断开）逐个房间精确计数。
 * limit=0 只取人数、不拉成员明细，避免刷新列表放大存储读取。
 */
async function liveCountsFor(
  store: RoomStore,
  rooms: WatchRoom[]
): Promise<number[]> {
  if (!rooms.length) return [];
  return Promise.all(
    rooms.map(async (room) => {
      const presence = await store.getPresence(room.id, MEMBER_TIMEOUT_MS, 0);
      return Math.max(0, Number(presence.count) || 0);
    })
  );
}

/**
 * 校验房间是否还能再进人。
 *
 * 人数以 presence 层的实时活跃数为准（与列表展示口径一致），而不是核心里
 * 异步回写的 memberCount 快照。selfId 是调用者自己持有的成员 id：若他本来
 * 就算在线，重连时不应把自己当成新占用一个名额，否则满员房间里的在线成员
 * 刷新一下页面就会被自己挤出去。
 *
 * 返回 null 表示可进入，否则返回可直接下发的错误响应。
 */
async function capacityBlock(
  store: RoomStore,
  room: WatchRoom,
  now: number,
  selfId?: string
): Promise<RoomResponse | null> {
  const cap = normalizeCapacity(room.maxMembers);
  if (!cap) return null;

  const presence = await store.getPresence(room.id, MEMBER_TIMEOUT_MS, 0);
  let occupied = Math.max(0, Number(presence.count) || 0);
  if (selfId) {
    const self = await store.getMember(room.id, selfId);
    const lastSeen = Number(self?.lastSeen) || 0;
    if (lastSeen > 0 && now - lastSeen <= MEMBER_TIMEOUT_MS) {
      occupied = Math.max(0, occupied - 1);
    }
  }
  if (occupied >= cap) {
    return fail(`观影室人数已满（上限 ${cap} 人）`);
  }
  return null;
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
    // 创建房间只落核心状态，不预置在线成员：房主 / 成员真正打开播放页并完成
    // 第一次 sync 心跳后才计入在线人数，避免「房间刚建好、没人连接」却显示 1 人。
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
      memberCount: 0,
      // 老客户端不传 maxMembers 时由服务端兜底，保证新房间默认就有上限
      maxMembers: resolveCreateCapacity(input.maxMembers),
      seq: 0,
      rev: 1,
      createdAt: now,
      lastActiveAt: now,
    };

    await store.saveRoom(room);
    await emitDrafts(store, room, [
      makeDraft('system', memberId, name, `${name} 创建了房间，等待伙伴加入`),
    ]);
    invalidateRoomsCache();

    const presence = await presenceFor(store, room);
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
    const room = rooms.find((item) => item.owner === identity.owner);
    if (!room) return { ok: true, ...common };
    // 房间核心里的 memberCount 只是房主心跳异步回写的快照：上次连接断开后
    // 没人再心跳，它不会自动归零，可能永远停在 1。播放页的「我的观影室」
    // 卡片只读这个接口，若直接透传快照就会出现「没加入却显示 1 人在线」。
    // 这里按 presence 实时统计覆盖，口径与 myRooms / publicRooms 一致。
    const [count] = await liveCountsFor(store, [room]);
    return {
      ok: true,
      room: { ...room, memberCount: count },
      ...common,
    };
  }

  if (action === 'myRooms') {
    if (!identity.owner) return fail('请登录后查看自己的观影室');
    const source =
      input.fresh === true
        ? await freshListRooms(store, now)
        : await cachedListRooms(store);
    const rooms = source.filter((room) => room.owner === identity.owner);
    const counts = await liveCountsFor(store, rooms);
    return {
      ok: true,
      rooms: rooms.map((room, index) => ({
        ...room,
        memberCount: counts[index],
      })),
      ...common,
    };
  }

  // 公开大厅：只返回展示所需字段，不暴露 owner、事件序号、成员明细。
  // 在线人数按 presence 实时统计（已进入房间且心跳未超时的连接数），
  // 不再依赖核心里由房主心跳异步回写的快照，保证刷新后拿到真实人数。
  if (action === 'publicRooms') {
    const source =
      input.fresh === true
        ? await freshListRooms(store, now)
        : await cachedListRooms(store);
    const listed = source
      .filter((room) => room.isPublic === true && room.enabled !== false)
      .sort((a, b) => (b.publicizedAt || 0) - (a.publicizedAt || 0));
    const counts = await liveCountsFor(store, listed);
    const rooms = listed.map(
      (room, index): WatchRoom => ({
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
        memberCount: counts[index],
        maxMembers: normalizeCapacity(room.maxMembers),
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
    // 房主回到自己的房间不受人数上限限制：满员时也应能重新接管，
    // 否则房主会被自己设置的容量挡在门外。
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
    // 房主手动输自己的房间号也会走 join。以前这里一律新建普通成员：既会
    // 被人数上限挡在门外，又会在下一轮 sync 触发重接管、留下占名额的僵尸记录。
    // 现在识别创建者账号，直接复用 hostId 并豁免容量校验。
    const isOwner = !!(
      room.persistent &&
      room.owner &&
      identity.owner === room.owner
    );
    if (!isOwner) {
      // 新建成员前先按实时在线人数卡上限，满了直接拒绝，不写入任何 presence
      const blocked = await capacityBlock(store, room, now);
      if (blocked) return blocked;
    }

    const name = resolveName(identity.name, input.name);
    const memberId = isOwner && room.hostId ? room.hostId : makeMemberId();
    // 正常房间创建时 hostId 一定非空；这里只为异常/迁移数据兜底，避免
    // 房主进房后 isHost 判定与后续 sync 的 hostId 对不上。
    if (isOwner && !room.hostId) {
      room.hostId = memberId;
      room.hostName = name;
    }
    const existing = isOwner ? await store.getMember(room.id, memberId) : null;
    const member: RoomMember = {
      id: memberId,
      name,
      joinedAt: Number(existing?.joinedAt) || now,
      lastSeen: now,
      syncMode: normalizeSyncMode(
        existing?.syncMode ?? room.defaultSyncMode ?? 'auto'
      ),
    };
    await store.putMember(room.id, member, ttlOf(room));
    await emitDrafts(store, room, [
      makeDraft(
        'system',
        memberId,
        name,
        isOwner ? `${name} 作为房主进入观影室` : `${name} 加入了房间`
      ),
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
      isHost: isOwner,
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
    // 提前声明：房主重接管会改 hostId / hostName，必须能在这里标脏。否则刚进
    // 播放页、播放器尚未 ready（无 local 上报）且人数没变的前几轮根本不落盘，
    // 下一轮读到的还是旧 hostId，于是每轮都重接管、事件刷屏。
    let coreChanged = false;

    // 持久房间创建者重新接管房主身份。
    // 同一账号的多标签页 / 多设备互相读不到对方的 memberId（sessionStorage
    // 按标签页隔离），若一上来就无条件抢占 hostId，两个连接会按轮询节奏
    // 交替互踢。因此只有「旧房主确认离线」才真正接管；仍在线时直接复用
    // 当前 hostId，让多个连接共用同一房主席位。
    if (room.persistent && room.owner && identity.owner === room.owner) {
      if (!member || member.id !== room.hostId) {
        const hostMember = room.hostId
          ? await store.getMember(roomId, room.hostId)
          : null;
        const hostLastSeen = Number(hostMember?.lastSeen) || 0;
        const hostOnline =
          !!hostMember &&
          hostLastSeen > 0 &&
          now - hostLastSeen <= MEMBER_TIMEOUT_MS;

        if (hostOnline && room.hostId && hostMember) {
          // 复用房主席位：不删在线记录、不改 hostId、不刷「加入了房间」。
          // 两个连接共用同一 memberId 时 presence 只算 1 人，任一方心跳续期。
          const staleId = cleanText(input.memberId, 64);
          if (staleId && staleId !== room.hostId) {
            // 本次连接已放弃这个旧 id，直接清掉，避免它白占一个名额 20 秒。
            // 共用同一旧 id 的其他连接下一轮同样会复用 hostId，删除是安全的。
            await store.removeMember(roomId, staleId);
          }
          memberId = room.hostId;
          member = hostMember;
          member.name = resolveName(identity.name, input.name);
        } else {
          // 旧房主确认离线（或记录已失效）才接管
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
          coreChanged = true;
          rejoined = true;
        }
      }
    } else if (room.persistent && room.owner) {
      // 只能由持久房间创建账号掌控房主身份，普通成员不能继承离线房主权限。
      if (memberId === room.hostId && !member) memberId = '';
    }

    // 自愈：房间重启 / 存储换实例后，旧的 memberId 可能已失效。
    // 邀请链接自动入房走的也是这条路径，所以必须在重新分配成员 id 之前
    // 卡一次容量，否则被拒绝的用户下一轮心跳又会悄悄挤进房间。
    // 前面「持久房间创建者重新接管房主身份」的分支不受此限制，房主永远
    // 能回到自己的房间。
    if (!member) {
      const blocked = await capacityBlock(
        store,
        room,
        now,
        memberId || undefined
      );
      if (blocked) return blocked;
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

    // 房主可能与同一账号的其他标签页 / 设备共用 hostId（见 sync 的席位复用）。
    // 服务端无从判断还有几个连接在用这个 id，因此房主主动离开时保留在线记录，
    // 让它随心跳超时自然清扫，避免关掉一个标签页把其他连接一起注销。
    if (room.persistent && member.id === room.hostId) {
      const presence = await presenceFor(store, room);
      room.memberCount = presence.count;
      await saveCore(store, room);
      return { ok: true, ...common };
    }

    await store.removeMember(roomId, member.id);
    const presence = await presenceFor(store, room);

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
