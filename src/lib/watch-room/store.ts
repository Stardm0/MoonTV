/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

import { Redis } from '@upstash/redis';

import { D1RoomStore } from './d1-store';
import { EVENT_LIMIT, ROOM_TTL_SECONDS, RoomEvent, WatchRoom } from './types';

/**
 * 房间存储抽象。
 *
 * 之所以不复用 DbManager：观影室是「多成员共享 + 事件流」的临时状态，
 * 与按用户隔离的收藏/播放记录模型不同，单独一层更干净，也不会污染既有数据。
 *
 * - Upstash：HTTP REST，Edge runtime 可用，多实例共享，Vercel / Netlify / Cloudflare 适用。
 * - D1：Cloudflare Pages 的 SQLite 绑定（process.env.DB），与项目原有 D1 存储
 *   取同一个 binding，纯 Cloudflare 部署无需任何外部服务。
 * - Memory：单进程内存，Docker 单实例、本地开发、localstorage 模式适用。
 *   多实例 Serverless 下不共享，此时必须配置 Upstash 或 D1 才能跨实例同步。
 *
 * 判定优先级：显式配置的 Upstash 凭据 > D1 binding > 内存。
 */
export interface RoomStore {
  getRoom(roomId: string): Promise<WatchRoom | null>;
  saveRoom(room: WatchRoom): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  nextSeq(roomId: string): Promise<number>;
  appendEvent(roomId: string, event: RoomEvent): Promise<void>;
  listEvents(roomId: string, since: number): Promise<RoomEvent[]>;
}

const roomKey = (id: string) => `moontv:watchroom:${id}:room`;
const eventsKey = (id: string) => `moontv:watchroom:${id}:events`;
const seqKey = (id: string) => `moontv:watchroom:${id}:seq`;

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

export class UpstashRoomStore implements RoomStore {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async getRoom(roomId: string): Promise<WatchRoom | null> {
    const raw = await this.redis.get<unknown>(roomKey(roomId));
    return parseJsonValue<WatchRoom>(raw);
  }

  async saveRoom(room: WatchRoom): Promise<void> {
    await this.redis.set(roomKey(room.id), room, { ex: ROOM_TTL_SECONDS });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.redis.del(roomKey(roomId), eventsKey(roomId), seqKey(roomId));
  }

  async nextSeq(roomId: string): Promise<number> {
    return this.redis.incr(seqKey(roomId));
  }

  async appendEvent(roomId: string, event: RoomEvent): Promise<void> {
    await this.redis.lpush(eventsKey(roomId), event);
    await this.redis.ltrim(eventsKey(roomId), 0, EVENT_LIMIT - 1);
    await this.redis.expire(eventsKey(roomId), ROOM_TTL_SECONDS);
    await this.redis.expire(seqKey(roomId), ROOM_TTL_SECONDS);
  }

  async listEvents(roomId: string, since: number): Promise<RoomEvent[]> {
    const raw = await this.redis.lrange<unknown>(
      eventsKey(roomId),
      0,
      EVENT_LIMIT - 1
    );
    const list = (raw || [])
      .map((item) => parseJsonValue<RoomEvent>(item))
      .filter((item): item is RoomEvent => !!item && item.seq > since);
    // lpush 是最新的在前
    return list.sort((a, b) => a.seq - b.seq);
  }
}

interface MemoryEntry {
  room: WatchRoom;
  events: RoomEvent[];
  seq: number;
  updatedAt: number;
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
    if (now - entry.updatedAt > ROOM_TTL_SECONDS * 1000) map.delete(id);
  });
}

export class MemoryRoomStore implements RoomStore {
  async getRoom(roomId: string): Promise<WatchRoom | null> {
    const map = memoryMap();
    sweepExpired(map);
    const entry = map.get(roomId);
    return entry ? structuredCloneRoom(entry.room) : null;
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
        updatedAt: Date.now(),
      });
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    memoryMap().delete(roomId);
  }

  async nextSeq(roomId: string): Promise<number> {
    const map = memoryMap();
    const entry = map.get(roomId);
    if (!entry) return 1;
    entry.seq += 1;
    return entry.seq;
  }

  async appendEvent(roomId: string, event: RoomEvent): Promise<void> {
    const map = memoryMap();
    const entry = map.get(roomId);
    if (!entry) return;
    entry.events.unshift(event);
    if (entry.events.length > EVENT_LIMIT) entry.events.length = EVENT_LIMIT;
    entry.seq = Math.max(entry.seq, event.seq);
    entry.updatedAt = Date.now();
  }

  async listEvents(roomId: string, since: number): Promise<RoomEvent[]> {
    const entry = memoryMap().get(roomId);
    if (!entry) return [];
    return entry.events
      .filter((item) => item.seq > since)
      .slice()
      .reverse();
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
