/* eslint-disable @typescript-eslint/no-explicit-any */

import { PresenceView, RoomStore } from './store';
import {
  EVENT_LIMIT,
  EventDraft,
  ROOM_TTL_SECONDS,
  RoomEvent,
  RoomMember,
  RoomSyncMode,
  WatchRoom,
} from './types';

/**
 * Cloudflare D1 房间存储（大房间优化版）。
 *
 * 绑定获取方式与 `src/lib/d1.db.ts` 的 getD1Database() 完全一致：
 * Cloudflare Pages（@cloudflare/next-on-pages）会把 D1 binding 注入
 * 为 `process.env.DB`，项目现有的所有 D1 API 都是这么取的。
 *
 * 大房间下每个成员心跳只 UPDATE 一行 `watch_room_members`，
 * 不再重写包含全量成员名单的房间 JSON。`watch_room_members` 需要执行
 * 同目录下的 watch-room-d1-migration.sql 建立表与索引。
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
  /** Cloudflare D1 支持 batch；本地 mock 可能没有，按顺序回退 */
  batch?(statements: D1StatementLike[]): Promise<unknown[]>;
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

function rowToMember(row: any): RoomMember | null {
  if (!row || typeof row.member_id !== 'string') return null;
  return {
    id: String(row.member_id),
    name: String(row.name || '观众'),
    joinedAt: Number(row.joined_at) || 0,
    lastSeen: Number(row.last_seen) || 0,
    syncMode: (row.sync_mode === 'manual' ? 'manual' : 'auto') as RoomSyncMode,
    lastChatAt: Number(row.last_chat_at) || undefined,
  };
}

/** 每 5 分钟最多做一次过期清扫，避免每次心跳都多几条 SQL */
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

  private async runBatch(statements: D1StatementLike[]): Promise<void> {
    if (!statements.length) return;
    if (typeof this.db.batch === 'function') {
      await this.db.batch(statements);
      return;
    }
    for (const statement of statements) await statement.run();
  }

  /** 级联清理过期房间，防止房间号被复用时读到残留的旧事件 / 旧成员 */
  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    const cutoff = now - ROOM_TTL_SECONDS * 1000;
    const expiredRooms =
      "SELECT id FROM watch_rooms WHERE updated_at < ? AND json_extract(data, '$.persistent') IS NOT 1";

    // 顺序不可颠倒：前三条依赖 watch_rooms 中尚未删除的过期 id
    await this.db
      .prepare(
        `DELETE FROM watch_room_events WHERE room_id IN (${expiredRooms})`
      )
      .bind(cutoff)
      .run();
    await this.db
      .prepare(`DELETE FROM watch_room_seqs WHERE room_id IN (${expiredRooms})`)
      .bind(cutoff)
      .run();
    await this.db
      .prepare(
        `DELETE FROM watch_room_members WHERE room_id IN (${expiredRooms})`
      )
      .bind(cutoff)
      .run();
    await this.db
      .prepare(
        `DELETE FROM watch_rooms WHERE updated_at < ? AND json_extract(data, '$.persistent') IS NOT 1`
      )
      .bind(cutoff)
      .run();
  }

  async listRooms(): Promise<WatchRoom[]> {
    await this.sweepExpired();
    const result = await this.db
      .prepare('SELECT data FROM watch_rooms')
      .all<any>();
    return (result?.results || [])
      .map((row) => parseValue<WatchRoom>(row?.data))
      .filter((room): room is WatchRoom => !!room?.persistent);
  }

  async getRoom(roomId: string): Promise<WatchRoom | null> {
    await this.sweepExpired();
    const row = await this.db
      .prepare('SELECT data, updated_at FROM watch_rooms WHERE id = ?')
      .bind(roomId)
      .first<any>();
    if (!row) return null;

    const room = parseValue<WatchRoom>(row.data);
    if (
      !room?.persistent &&
      Date.now() - Number(row.updated_at || 0) > ROOM_TTL_SECONDS * 1000
    ) {
      await this.deleteRoom(roomId);
      return null;
    }
    return room;
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
    await this.runBatch([
      this.db.prepare('DELETE FROM watch_rooms WHERE id = ?').bind(roomId),
      this.db
        .prepare('DELETE FROM watch_room_events WHERE room_id = ?')
        .bind(roomId),
      this.db
        .prepare('DELETE FROM watch_room_seqs WHERE room_id = ?')
        .bind(roomId),
      this.db
        .prepare('DELETE FROM watch_room_members WHERE room_id = ?')
        .bind(roomId),
    ]);
  }

  async getSeq(roomId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT seq FROM watch_room_seqs WHERE room_id = ?')
      .bind(roomId)
      .first<any>();
    return Math.max(0, Number(row?.seq) || 0);
  }

  async appendEvents(
    roomId: string,
    drafts: EventDraft[],
    _roomTtlSeconds: number
  ): Promise<RoomEvent[]> {
    if (!drafts.length) return [];
    const count = drafts.length;
    const upsert =
      'INSERT INTO watch_room_seqs (room_id, seq) VALUES (?, ?) ' +
      'ON CONFLICT(room_id) DO UPDATE SET seq = seq + excluded.seq';

    let last = 0;
    try {
      const row = await this.db
        .prepare(`${upsert} RETURNING seq`)
        .bind(roomId, count)
        .first<any>();
      if (row?.seq !== undefined) last = Number(row.seq) || 0;
    } catch {
      // 老版本 SQLite 不支持 RETURNING，落到下面的回退分支
    }
    if (!last) {
      await this.db.prepare(upsert).bind(roomId, count).run();
      last = await this.getSeq(roomId);
    }

    const start = last - count + 1;
    const events: RoomEvent[] = drafts.map((draft, i) => ({
      ...draft,
      seq: start + i,
    }));

    const statements: D1StatementLike[] = events.map((event) =>
      this.db
        .prepare(
          'INSERT INTO watch_room_events (room_id, seq, data) VALUES (?, ?, ?)'
        )
        .bind(roomId, event.seq, JSON.stringify(event))
    );
    // 只保留最新 EVENT_LIMIT 条；seq 表独立维护，裁剪不会导致序号回退
    statements.push(
      this.db
        .prepare(
          `DELETE FROM watch_room_events
           WHERE room_id = ?
             AND seq <= (SELECT MAX(seq) - ? FROM watch_room_events WHERE room_id = ?)`
        )
        .bind(roomId, EVENT_LIMIT, roomId)
    );
    await this.runBatch(statements);
    return events;
  }

  async listEvents(
    roomId: string,
    since: number,
    limit: number
  ): Promise<RoomEvent[]> {
    const size = Math.max(1, Math.min(EVENT_LIMIT, Math.floor(limit)));
    const result = await this.db
      .prepare(
        'SELECT data FROM watch_room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .bind(roomId, since, size)
      .all<any>();
    return (result?.results || [])
      .map((row) => parseValue<RoomEvent>(row?.data))
      .filter((item): item is RoomEvent => !!item && item.seq > since);
  }

  async putMember(
    roomId: string,
    member: RoomMember,
    _roomTtlSeconds: number
  ): Promise<void> {
    await this.runBatch([
      this.db
        .prepare(
          `INSERT INTO watch_room_members
             (room_id, member_id, name, joined_at, sync_mode, last_seen, last_chat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id, member_id) DO UPDATE SET
             name = excluded.name,
             sync_mode = excluded.sync_mode,
             last_seen = excluded.last_seen,
             last_chat_at = excluded.last_chat_at`
        )
        .bind(
          roomId,
          member.id,
          member.name,
          Number(member.joinedAt) || Date.now(),
          member.syncMode === 'manual' ? 'manual' : 'auto',
          Number(member.lastSeen) || Date.now(),
          Number(member.lastChatAt) || 0
        ),
      // 心跳顺带续期房间 updated_at，避免活跃临时房间被 TTL 清扫误删
      this.db
        .prepare('UPDATE watch_rooms SET updated_at = ? WHERE id = ?')
        .bind(Date.now(), roomId),
    ]);
  }

  async getMember(
    roomId: string,
    memberId: string
  ): Promise<RoomMember | null> {
    const row = await this.db
      .prepare(
        `SELECT member_id, name, joined_at, sync_mode, last_seen, last_chat_at
         FROM watch_room_members WHERE room_id = ? AND member_id = ?`
      )
      .bind(roomId, memberId)
      .first<any>();
    return rowToMember(row);
  }

  async getPresence(
    roomId: string,
    timeoutMs: number,
    limit: number,
    preferIds: string[] = []
  ): Promise<PresenceView> {
    const cutoff = Date.now() - timeoutMs;
    const size = Math.max(0, Math.floor(limit));
    const uniquePrefer = Array.from(new Set(preferIds.filter(Boolean))).slice(
      0,
      size
    );

    const stats = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN last_seen <= ? THEN 1 ELSE 0 END), 0) AS expired,
           COALESCE(SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END), 0) AS active
         FROM watch_room_members WHERE room_id = ?`
      )
      .bind(cutoff, cutoff, roomId)
      .first<any>();
    const removed = Number(stats?.expired) || 0;
    const count = Number(stats?.active) || 0;

    const deleteStmt =
      removed > 0
        ? this.db
            .prepare(
              'DELETE FROM watch_room_members WHERE room_id = ? AND last_seen <= ?'
            )
            .bind(roomId, cutoff)
        : null;
    const previewStmt =
      size > 0
        ? this.db
            .prepare(
              `SELECT member_id, name, joined_at, sync_mode, last_seen, last_chat_at
             FROM watch_room_members WHERE room_id = ?
             ORDER BY joined_at ASC LIMIT ?`
            )
            .bind(roomId, size)
        : null;

    let rows: any[] = [];
    if (typeof this.db.batch === 'function') {
      const statements: D1StatementLike[] = [];
      if (deleteStmt) statements.push(deleteStmt);
      if (previewStmt) statements.push(previewStmt);
      if (statements.length) {
        const results = await this.db.batch(statements);
        const previewIndex = deleteStmt ? 1 : 0;
        const previewResult = results[previewIndex] as
          | D1ResultLike<any>
          | undefined;
        rows = previewResult?.results || [];
      }
    } else {
      if (deleteStmt) await deleteStmt.run();
      if (previewStmt) rows = (await previewStmt.all<any>())?.results || [];
    }

    const members = rows
      .map(rowToMember)
      .filter((item): item is RoomMember => !!item);
    // preferIds（房主、调用者）不一定落在按 joined_at 排序的前 N 条里，单独补齐
    const missing = uniquePrefer.filter(
      (id) => !members.some((member) => member.id === id)
    );
    for (const id of missing) {
      const row = await this.db
        .prepare(
          `SELECT member_id, name, joined_at, sync_mode, last_seen, last_chat_at
           FROM watch_room_members
           WHERE room_id = ? AND member_id = ? AND last_seen > ?`
        )
        .bind(roomId, id, cutoff)
        .first<any>();
      const member = rowToMember(row);
      if (member) members.push(member);
    }
    const preview = members.slice(0, size);

    let earliest: RoomMember | null = preview[0] || null;
    if (!earliest) {
      const row = await this.db
        .prepare(
          `SELECT member_id, name, joined_at, sync_mode, last_seen, last_chat_at
           FROM watch_room_members WHERE room_id = ? AND last_seen > ?
           ORDER BY joined_at ASC LIMIT 1`
        )
        .bind(roomId, cutoff)
        .first<any>();
      earliest = rowToMember(row);
    }

    return { count, members: preview, earliest, removed };
  }

  async removeMember(roomId: string, memberId: string): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM watch_room_members WHERE room_id = ? AND member_id = ?'
      )
      .bind(roomId, memberId)
      .run();
  }

  async pickOldestActiveMember(
    roomId: string,
    timeoutMs: number
  ): Promise<RoomMember | null> {
    const row = await this.db
      .prepare(
        `SELECT member_id, name, joined_at, sync_mode, last_seen, last_chat_at
         FROM watch_room_members WHERE room_id = ? AND last_seen > ?
         ORDER BY joined_at ASC LIMIT 1`
      )
      .bind(roomId, Date.now() - timeoutMs)
      .first<any>();
    return rowToMember(row);
  }
}
