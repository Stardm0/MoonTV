/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

import { Redis } from '@upstash/redis';

import { D1RoomStore } from './d1-store';
import {
  EVENT_LIMIT,
  EventDraft,
  MEMBER_META_TTL_SECONDS,
  ROOM_TTL_SECONDS,
  RoomEvent,
  RoomMember,
  WatchRoom,
} from './types';

/**
 * 房间存储抽象（大房间优化版）。
 *
 * 核心变化：把「房间核心状态」和「成员在线状态」彻底拆开。
 *
 * - 房间核心（影片、播放状态、房主、配置）是一个几百字节的小对象，只有房主心跳
 *   或配置变更时才写一次；N 个成员的心跳不再重写整份房间对象。
 * - 成员在线状态按成员粒度存储（Upstash 一个 ZSET + 每人一个带 TTL 的 key，
 *   D1 一行一个成员，内存一个 Map），单次心跳是 O(1) 的小写入，并且天然避免
 *   并发 read-modify-write 互相覆盖。
 * - 事件流批量写入、seq 一次原子分配；无新事件时直接跳过事件列表读取。
 *
 * - Upstash：HTTP REST，Edge runtime 可用，多实例共享。
 * - D1：Cloudflare Pages 的 SQLite 绑定（process.env.DB）。
 * - Memory：单进程内存，Docker 单实例、本地开发、localstorage 模式适用。
 *
 * 判定优先级：显式配置的 Upstash 凭据 > D1 binding > 内存。
 */
export interface PresenceView {
  /** 活跃成员精确总数（已剔除超时成员） */
  count: number;
  /** 成员明细预览，最多 limit 条；preferIds 中仍在线的成员一定在其中 */
  members: RoomMember[];
  /** 活跃成员中最早加入者，用于房主移交 */
  earliest: RoomMember | null;
  /** 本次清扫移除的超时成员数，用于聚合「N 人离开」提示 */
  removed: number;
}

export interface RoomStore {
  // ---- 房间核心 ----
  getRoom(roomId: string): Promise<WatchRoom | null>;
  listRooms(): Promise<WatchRoom[]>;
  saveRoom(room: WatchRoom): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;

  // ---- 事件流 ----
  /** 当前事件序号；无新事件时可据此跳过 listEvents */
  getSeq(roomId: string): Promise<number>;
  /** 批量写入事件，连续 seq 由存储层原子分配 */
  appendEvents(
    roomId: string,
    drafts: EventDraft[],
    roomTtlSeconds: number
  ): Promise<RoomEvent[]>;
  /** 只取 since 之后的 limit 条，避免每次心跳都反序列化 100 条旧事件 */
  listEvents(
    roomId: string,
    since: number,
    limit: number
  ): Promise<RoomEvent[]>;

  // ---- 成员存在（presence）----
  /** 新建 / 更新成员元数据并刷新在线标记；roomTtlSeconds>0 时同时续期房间 key */
  putMember(
    roomId: string,
    member: RoomMember,
    roomTtlSeconds: number
  ): Promise<void>;
  /** 读取单个成员；lastSeen 来自在线标记，调用方据此判断是否已超时 */
  getMember(roomId: string, memberId: string): Promise<RoomMember | null>;
  /** 读取在线视图并顺带清扫超时成员（原子、廉价） */
  getPresence(
    roomId: string,
    timeoutMs: number,
    limit: number,
    preferIds?: string[]
  ): Promise<PresenceView>;
  removeMember(roomId: string, memberId: string): Promise<void>;
  /** 选出最早加入且仍在线的成员；仅在房主移交时调用 */
  pickOldestActiveMember(
    roomId: string,
    timeoutMs: number
  ): Promise<RoomMember | null>;
}

const roomKey = (id: string) => `moontv:watchroom:${id}:room`;
const eventsKey = (id: string) => `moontv:watchroom:${id}:events`;
const seqKey = (id: string) => `moontv:watchroom:${id}:seq`;
const seenKey = (id: string) => `moontv:watchroom:${id}:seen`;
const memberKey = (id: string, memberId: string) =>
  `moontv:watchroom:${id}:member:${memberId}`;

/** Upstash SDK 会自动反序列化 JSON 字符串，这里兼容两种返回形态 */
function parseJsonValue<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function cloneMember(member: RoomMember): RoomMember {
  return { ...member };
}

function memberFromMeta(meta: RoomMember): RoomMember {
  return cloneMember(meta);
}

/** pipeline.exec() 的结果可能为 Error，统一取安全值 */
function pipeValue<T>(res: unknown, index: number, fallback: T): T {
  if (!Array.isArray(res)) return fallback;
  const value = res[index];
  if (value instanceof Error || value === undefined || value === null) {
    return fallback;
  }
  return value as T;
}

export class UpstashRoomStore implements RoomStore {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async getRoom(roomId: string): Promise<WatchRoom | null> {
    const raw = await this.redis.get<unknown>(roomKey(roomId));
    return parseJsonValue<WatchRoom>(raw);
  }

  async listRooms(): Promise<WatchRoom[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, page] = await this.redis.scan(cursor, {
        match: 'moontv:watchroom:*:room',
        count: 100,
      });
      cursor = String(nextCursor);
      keys.push(...(page || []));
    } while (cursor !== '0');
    if (!keys.length) return [];
    const values = await this.redis.mget<unknown[]>(...keys);
    return (values || [])
      .map((value) => parseJsonValue<WatchRoom>(value))
      .filter((room): room is WatchRoom => !!room?.persistent);
  }

  async saveRoom(room: WatchRoom): Promise<void> {
    if (room.persistent) {
      await this.redis.set(roomKey(room.id), room);
    } else {
      await this.redis.set(roomKey(room.id), room, { ex: ROOM_TTL_SECONDS });
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.redis.del(
      roomKey(roomId),
      eventsKey(roomId),
      seqKey(roomId),
      seenKey(roomId)
    );
    // 成员元数据 key 自带短 TTL，最多残留 MEMBER_META_TTL_SECONDS 后自动消失。
  }

  async getSeq(roomId: string): Promise<number> {
    const raw = await this.redis.get<unknown>(seqKey(roomId));
    return Math.max(0, Number(raw) || 0);
  }

  async appendEvents(
    roomId: string,
    drafts: EventDraft[],
    roomTtlSeconds: number
  ): Promise<RoomEvent[]> {
    if (!drafts.length) return [];
    // INCRBY 一次分配整批序号，并发写入不会撞号
    const last = Number(await this.redis.incrby(seqKey(roomId), drafts.length));
    const start = last - drafts.length + 1;
    const events: RoomEvent[] = drafts.map((draft, i) => ({
      ...draft,
      seq: start + i,
    }));

    const p = this.redis.pipeline();
    p.lpush(eventsKey(roomId), ...events);
    p.ltrim(eventsKey(roomId), 0, EVENT_LIMIT - 1);
    if (roomTtlSeconds > 0) {
      p.expire(eventsKey(roomId), roomTtlSeconds);
      p.expire(seqKey(roomId), roomTtlSeconds);
    }
    await p.exec();
    return events;
  }

  async listEvents(
    roomId: string,
    since: number,
    limit: number
  ): Promise<RoomEvent[]> {
    const size = Math.max(1, Math.min(EVENT_LIMIT, Math.floor(limit)));
    const raw = await this.redis.lrange<unknown>(
      eventsKey(roomId),
      0,
      size - 1
    );
    return (raw || [])
      .map((item) => parseJsonValue<RoomEvent>(item))
      .filter((item): item is RoomEvent => !!item && item.seq > since)
      .sort((a, b) => a.seq - b.seq);
  }

  async putMember(
    roomId: string,
    member: RoomMember,
    roomTtlSeconds: number
  ): Promise<void> {
    const now = Number(member.lastSeen) || Date.now();
    const p = this.redis.pipeline();
    // ZSET 以 lastSeen 为 score：清扫、计数、取预览都是 O(log N + K)
    p.zadd(seenKey(roomId), { score: now, member: member.id });
    p.set(memberKey(roomId, member.id), member, {
      ex: MEMBER_META_TTL_SECONDS,
    });
    // seen 的 TTL 每次心跳续期；活跃房间不会因为长期不写核心而被误清
    p.expire(seenKey(roomId), ROOM_TTL_SECONDS);
    if (roomTtlSeconds > 0) {
      p.expire(roomKey(roomId), roomTtlSeconds);
    }
    await p.exec();
  }

  async getMember(
    roomId: string,
    memberId: string
  ): Promise<RoomMember | null> {
    const p = this.redis.pipeline();
    p.get(memberKey(roomId, memberId));
    if (typeof (p as any).zscore === 'function') {
      (p as any).zscore(seenKey(roomId), memberId);
    } else {
      // 极老版本 SDK 的兜底：一次性取出集合做成员判定
      (p as any).zrange(seenKey(roomId), 0, -1);
    }
    const res = await p.exec();
    const meta = parseJsonValue<RoomMember>(pipeValue<unknown>(res, 0, null));
    if (!meta) return null;
    const scoreOrIds = pipeValue<unknown>(res, 1, null);
    let lastSeen = 0;
    if (typeof scoreOrIds === 'number' || typeof scoreOrIds === 'string') {
      lastSeen = Number(scoreOrIds) || 0;
    } else if (Array.isArray(scoreOrIds)) {
      // 兜底分支：只能知道是否仍在集合里，用当前时间近似
      lastSeen = scoreOrIds.includes(memberId) ? Date.now() : 0;
    }
    return { ...memberFromMeta(meta), lastSeen };
  }

  async getPresence(
    roomId: string,
    timeoutMs: number,
    limit: number,
    preferIds: string[] = []
  ): Promise<PresenceView> {
    const now = Date.now();
    const cutoff = now - timeoutMs;
    const size = Math.max(0, Math.floor(limit));
    const uniquePrefer = Array.from(new Set(preferIds.filter(Boolean))).slice(
      0,
      size
    );

    const p = this.redis.pipeline();
    p.zremrangebyscore(seenKey(roomId), 0, cutoff); // 0: 本次移除数
    p.zcard(seenKey(roomId)); // 1: 活跃总数
    if (size > 0) p.zrange(seenKey(roomId), 0, size - 1); // 2: 预览 id
    for (const id of uniquePrefer) {
      if (typeof (p as any).zscore === 'function') {
        (p as any).zscore(seenKey(roomId), id); // 后续：preferId 是否仍在线
      } else {
        (p as any).zrange(seenKey(roomId), 0, -1);
      }
    }
    const res = await p.exec();

    const removed = Number(pipeValue<unknown>(res, 0, 0)) || 0;
    const count = Number(pipeValue<unknown>(res, 1, 0)) || 0;
    const preferStart = size > 0 ? 3 : 2;
    const rangeIds = size
      ? (pipeValue<unknown>(res, 2, []) as unknown[]) || []
      : [];
    const activePrefer: string[] = [];
    uniquePrefer.forEach((id, i) => {
      const value = pipeValue<unknown>(res, preferStart + i, null);
      let active = false;
      if (typeof value === 'number' || typeof value === 'string') {
        active = Number(value) > cutoff;
      } else if (Array.isArray(value)) {
        active = value.includes(id);
      }
      if (active) activePrefer.push(id);
    });

    const ids = Array.from(
      new Set([...activePrefer, ...rangeIds.map((item) => String(item))])
    ).slice(0, size);

    if (!ids.length) {
      return { count, members: [], earliest: null, removed };
    }
    const raw = await this.redis.mget<unknown[]>(
      ...ids.map((id) => memberKey(roomId, id))
    );
    const members = (raw || [])
      .map((item) => parseJsonValue<RoomMember>(item))
      .filter((item): item is RoomMember => !!item)
      .map(memberFromMeta);
    return {
      count,
      members,
      earliest: pickEarliest(members),
      removed,
    };
  }

  async removeMember(roomId: string, memberId: string): Promise<void> {
    const p = this.redis.pipeline();
    p.zrem(seenKey(roomId), memberId);
    p.del(memberKey(roomId, memberId));
    await p.exec();
  }

  async pickOldestActiveMember(
    roomId: string,
    timeoutMs: number
  ): Promise<RoomMember | null> {
    const cutoff = Date.now() - timeoutMs;
    // 房主移交是低频操作，这里允许一次 O(N) 读取换精确结果
    const p = this.redis.pipeline();
    p.zremrangebyscore(seenKey(roomId), 0, cutoff);
    p.zrange(seenKey(roomId), 0, -1);
    const res = await p.exec();
    const ids = (pipeValue<unknown>(res, 1, []) as unknown[]) || [];
    if (!ids.length) return null;
    const raw = await this.redis.mget<unknown[]>(
      ...ids.map((id) => memberKey(roomId, String(id)))
    );
    const members = (raw || [])
      .map((item) => parseJsonValue<RoomMember>(item))
      .filter((item): item is RoomMember => !!item);
    return pickEarliest(members);
  }
}

function pickEarliest(members: RoomMember[]): RoomMember | null {
  if (!members.length) return null;
  return members.reduce((best, item) =>
    item.joinedAt < best.joinedAt ? item : best
  );
}

interface MemoryEntry {
  room: WatchRoom;
  events: RoomEvent[];
  seq: number;
  updatedAt: number;
  members: Map<string, RoomMember>;
}

/** 挂在 globalThis 上，热更新 / 多模块实例之间仍能共享同一份状态 */
function memoryMap(): Map<string, MemoryEntry> {
  const g = globalThis as any;
  if (!g.__moontvWatchRoomMemory) {
    g.__moontvWatchRoomMemory = new Map<string, MemoryEntry>();
  }
  return g.__moontvWatchRoomMemory as Map<string, MemoryEntry>;
}

function sweepExpired(map: Map<string, MemoryEntry>): void {
  const now = Date.now();
  map.forEach((entry, id) => {
    if (
      !entry.room.persistent &&
      now - entry.updatedAt > ROOM_TTL_SECONDS * 1000
    ) {
      map.delete(id);
    }
  });
}

export class MemoryRoomStore implements RoomStore {
  async getRoom(roomId: string): Promise<WatchRoom | null> {
    const map = memoryMap();
    sweepExpired(map);
    const entry = map.get(roomId);
    return entry ? structuredCloneRoom(entry.room) : null;
  }

  async listRooms(): Promise<WatchRoom[]> {
    const map = memoryMap();
    sweepExpired(map);
    return Array.from(map.values())
      .map((entry) => structuredCloneRoom(entry.room))
      .filter((room) => room.persistent);
  }

  async saveRoom(room: WatchRoom): Promise<void> {
    const map = memoryMap();
    const entry = map.get(room.id);
    if (entry) {
      entry.room = structuredCloneRoom(room);
      entry.updatedAt = Date.now();
    } else {
      map.set(room.id, {
        room: structuredCloneRoom(room),
        events: [],
        seq: 0,
        members: new Map<string, RoomMember>(),
        updatedAt: Date.now(),
      });
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    memoryMap().delete(roomId);
  }

  async getSeq(roomId: string): Promise<number> {
    return memoryMap().get(roomId)?.seq || 0;
  }

  async appendEvents(
    roomId: string,
    drafts: EventDraft[],
    _roomTtlSeconds: number
  ): Promise<RoomEvent[]> {
    if (!drafts.length) return [];
    const entry = memoryMap().get(roomId);
    if (!entry) return [];
    const start = entry.seq + 1;
    const events = drafts.map((draft, i) => ({ ...draft, seq: start + i }));
    entry.seq += drafts.length;
    entry.events.unshift(...events.slice().reverse());
    if (entry.events.length > EVENT_LIMIT) entry.events.length = EVENT_LIMIT;
    entry.updatedAt = Date.now();
    return events;
  }

  async listEvents(
    roomId: string,
    since: number,
    limit: number
  ): Promise<RoomEvent[]> {
    const entry = memoryMap().get(roomId);
    if (!entry) return [];
    const size = Math.max(1, Math.min(EVENT_LIMIT, Math.floor(limit)));
    return entry.events
      .filter((item) => item.seq > since)
      .slice()
      .reverse()
      .slice(0, size);
  }

  async putMember(
    roomId: string,
    member: RoomMember,
    _roomTtlSeconds: number
  ): Promise<void> {
    const map = memoryMap();
    sweepExpired(map);
    const entry = map.get(roomId);
    if (!entry) return;
    entry.members.set(member.id, cloneMember(member));
    entry.updatedAt = Date.now();
  }

  async getMember(
    roomId: string,
    memberId: string
  ): Promise<RoomMember | null> {
    const entry = memoryMap().get(roomId);
    const member = entry?.members.get(memberId);
    return member ? cloneMember(member) : null;
  }

  async getPresence(
    roomId: string,
    timeoutMs: number,
    limit: number,
    preferIds: string[] = []
  ): Promise<PresenceView> {
    const map = memoryMap();
    sweepExpired(map);
    const entry = map.get(roomId);
    if (!entry) {
      return { count: 0, members: [], earliest: null, removed: 0 };
    }
    const cutoff = Date.now() - timeoutMs;
    let removed = 0;
    // Array.from 生成快照：兼容低 target，且遍历中 delete 不影响快照
    for (const [id, member] of Array.from(entry.members.entries())) {
      if (member.lastSeen < cutoff) {
        entry.members.delete(id);
        removed += 1;
      }
    }
    const all = Array.from(entry.members.values()).sort(
      (a, b) => a.joinedAt - b.joinedAt
    );
    const size = Math.max(0, Math.floor(limit));
    const chosen = new Set<string>();
    for (const id of preferIds) {
      if (entry.members.has(id)) chosen.add(id);
      if (chosen.size >= size) break;
    }
    for (const member of all) {
      if (chosen.size >= size) break;
      chosen.add(member.id);
    }
    const members = all
      .filter((member) => chosen.has(member.id))
      .slice(0, size)
      .map(cloneMember);
    return {
      count: all.length,
      members,
      earliest: all.length ? cloneMember(all[0]) : null,
      removed,
    };
  }

  async removeMember(roomId: string, memberId: string): Promise<void> {
    memoryMap().get(roomId)?.members.delete(memberId);
  }

  async pickOldestActiveMember(
    roomId: string,
    timeoutMs: number
  ): Promise<RoomMember | null> {
    const view = await this.getPresence(roomId, timeoutMs, 1);
    return view.earliest;
  }
}

function structuredCloneRoom(room: WatchRoom): WatchRoom {
  return JSON.parse(JSON.stringify(room)) as WatchRoom;
}

let cachedStore: RoomStore | null = null;
let cachedKind: 'upstash' | 'd1' | 'memory' = 'memory';

export function getRoomStore(): RoomStore {
  if (cachedStore) return cachedStore;

  // Vercel 集成 Upstash 时会自动注入 KV_* 变量，一并兼容
  const url = process.env.UPSTASH_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_TOKEN || process.env.KV_REST_API_TOKEN;

  if (url && token) {
    cachedStore = new UpstashRoomStore(url, token);
    cachedKind = 'upstash';
  } else {
    // Cloudflare Pages 把 D1 binding 注入为 process.env.DB，
    // 与 src/lib/d1.db.ts 的 getD1Database() 取法完全一致。
    const d1Binding = (process.env as any)?.DB;
    if (d1Binding && typeof d1Binding.prepare === 'function') {
      try {
        cachedStore = new D1RoomStore(d1Binding);
        cachedKind = 'd1';
      } catch (err) {
        console.warn('[watch-room] D1 绑定不可用，回退到内存存储', err);
      }
    }

    if (!cachedStore) {
      cachedStore = new MemoryRoomStore();
      cachedKind = 'memory';
      console.warn(
        '[watch-room] 未检测到 Upstash 凭据或 D1 绑定，使用单进程内存存储；多实例部署需配置 UPSTASH_URL / UPSTASH_TOKEN 或绑定 D1'
      );
    }
  }
  return cachedStore;
}

export function getStoreKind(): 'upstash' | 'd1' | 'memory' {
  getRoomStore();
  return cachedKind;
}
