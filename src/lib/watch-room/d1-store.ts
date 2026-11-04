/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RoomStore } from './store';
import { EVENT_LIMIT, ROOM_TTL_SECONDS, RoomEvent, WatchRoom } from './types';

/**
 * Cloudflare D1 房间存储。
 *
 * 绑定获取方式与 `src/lib/d1.db.ts` 的 getD1Database() 完全一致：
 * Cloudflare Pages（@cloudflare/next-on-pages）会把 D1 binding 注入
 * 为 `process.env.DB`，项目现有的所有 D1 API 都是这么取的，因此观影室
 * 沿用同一机制，不需要改 runtime、不需要 getRequestContext、不需要新依赖。
 *
 * 使用前三张表必须已建立：见 watch-room-d1-migration.sql（或已更新的
 * d1-init.sql）。若未执行迁移，房间请求会返回 500「房间服务暂时不可用」。
 */

interface D1ResultLike<T = any> {
  results?: T[];
}

interface D1StatementLike {
  bind(...params: any[]): D1StatementLike;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<D1ResultLike<T>>;
  run(): Promise<unknown>;
}

interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

/** SQLite 的 JSON 列可能以字符串或对象返回，统一解析 */
function parseValue<T>(value: unknown): T | null {
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

/** 每 5 分钟最多做一次过期清扫，避免每次心跳都多三条 SQL */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

export class D1RoomStore implements RoomStore {
  private db: D1DatabaseLike;

  constructor(db?: D1DatabaseLike) {
    const resolved =
      db ??
      ((typeof process !== 'undefined' && process.env
        ? (process.env as any).DB
        : undefined) as D1DatabaseLike | undefined);

    if (!resolved || typeof resolved.prepare !== 'function') {
      throw new Error(
        'D1 binding (DB) 不可用：请在 Cloudflare Pages 中绑定 D1 数据库'
      );
    }
    this.db = resolved;
  }

  /** 级联清理过期房间，防止房间号被复用时读到残留的旧事件 */
  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    const cutoff = now - ROOM_TTL_SECONDS * 1000;

    // 顺序不可颠倒：前两条依赖 watch_rooms 中尚未删除的过期 id
    await this.db
      .prepare(
        'DELETE FROM watch_room_events WHERE room_id IN (SELECT id FROM watch_rooms WHERE updated_at < ?)'
      )
      .bind(cutoff)
      .run();
    await this.db
      .prepare(
        'DELETE FROM watch_room_seqs WHERE room_id IN (SELECT id FROM watch_rooms WHERE updated_at < ?)'
      )
      .bind(cutoff)
      .run();
    await this.db
      .prepare('DELETE FROM watch_rooms WHERE updated_at < ?')
      .bind(cutoff)
      .run();
  }

  async getRoom(roomId: string): Promise<WatchRoom | null> {
    await this.sweepExpired();
    const row = await this.db
      .prepare('SELECT data, updated_at FROM watch_rooms WHERE id = ?')
      .bind(roomId)
      .first<any>();
    if (!row) return null;

    if (Date.now() - Number(row.updated_at || 0) > ROOM_TTL_SECONDS * 1000) {
      await this.deleteRoom(roomId);
      return null;
    }
    return parseValue<WatchRoom>(row.data);
  }

  async saveRoom(room: WatchRoom): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO watch_rooms (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .bind(room.id, JSON.stringify(room), Date.now())
      .run();
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM watch_rooms WHERE id = ?')
      .bind(roomId)
      .run();
    await this.db
      .prepare('DELETE FROM watch_room_events WHERE room_id = ?')
      .bind(roomId)
      .run();
    await this.db
      .prepare('DELETE FROM watch_room_seqs WHERE room_id = ?')
      .bind(roomId)
      .run();
  }

  async nextSeq(roomId: string): Promise<number> {
    // RETURNING 保证「自增 + 读取」原子，避免并发成员拿到重复 seq。
    // 老版本 SQLite 不支持时回退为「先 upsert 再读」，功能等价。
    const upsert =
      'INSERT INTO watch_room_seqs (room_id, seq) VALUES (?, 1) ' +
      'ON CONFLICT(room_id) DO UPDATE SET seq = seq + 1';
    try {
      const row = await this.db
        .prepare(`${upsert} RETURNING seq`)
        .bind(roomId)
        .first<any>();
      if (row?.seq !== undefined) return Number(row.seq);
    } catch {
      // 落到下面的回退分支
    }

    await this.db.prepare(upsert).bind(roomId).run();
    const row = await this.db
      .prepare('SELECT seq FROM watch_room_seqs WHERE room_id = ?')
      .bind(roomId)
      .first<any>();
    return Number(row?.seq || 1);
  }

  async appendEvent(roomId: string, event: RoomEvent): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO watch_room_events (room_id, seq, data) VALUES (?, ?, ?)'
      )
      .bind(roomId, event.seq, JSON.stringify(event))
      .run();

    // 只保留最新 EVENT_LIMIT 条；seq 表独立维护，裁剪不会导致序号回退
    await this.db
      .prepare(
        `DELETE FROM watch_room_events
         WHERE room_id = ?
           AND seq <= (SELECT MAX(seq) - ? FROM watch_room_events WHERE room_id = ?)`
      )
      .bind(roomId, EVENT_LIMIT, roomId)
      .run();
  }

  async listEvents(roomId: string, since: number): Promise<RoomEvent[]> {
    const result = await this.db
      .prepare(
        'SELECT data FROM watch_room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .bind(roomId, since, EVENT_LIMIT)
      .all<any>();
    return (result?.results || [])
      .map((row) => parseValue<RoomEvent>(row?.data))
      .filter((item): item is RoomEvent => !!item && item.seq > since);
  }
}
