/**
 * 共同观影室：客户端与服务端共享的协议类型与常量。
 *
 * 本文件不依赖任何运行时 API（浏览器 / Node / Edge 均可安全引入）。
 */

/** 房间号为 6 位大写字母数字，方便口头传达与手动输入 */
export const ROOM_ID_LENGTH = 6;

/** 房间最长保留 6 小时；每次 sync 会顺延 */
export const ROOM_TTL_SECONDS = 6 * 60 * 60;

/** 成员超过 20 秒未 sync 视为离开 */
export const MEMBER_TIMEOUT_MS = 20_000;

/** 每个房间最多保留的事件条数（聊天 + 系统提示） */
export const EVENT_LIMIT = 100;

/** 单条聊天消息最大长度 */
export const MAX_MESSAGE_LENGTH = 200;

/** 昵称最大长度 */
export const MAX_NAME_LENGTH = 20;

/** 客户端轮询间隔（毫秒）。调大可降低 Upstash 命令消耗 */
export const POLL_INTERVAL_MS = 1500;

export interface RoomMember {
  id: string;
  name: string;
  joinedAt: number;
  lastSeen: number;
  syncMode: RoomSyncMode;
}

/** 由房主持续上报的权威播放状态 */
export interface RoomPlayState {
  playing: boolean;
  /** 秒 */
  time: number;
  /** 该状态对应的服务端时间戳 */
  updatedAt: number;
}

export interface WatchRoom {
  id: string;
  hostId: string;
  hostName: string;
  /** 影片标题，仅用于展示 */
  title: string;
  /**
   * 房主当前播放页路径（含 source / id / ep 等查询参数，不含 room）。
   * 邀请链接基于它生成，保证成员与房主处于同一片源、同一集。
   */
  playPath: string;
  /** 1 基集数 */
  episode: number;
  /** 房主设置的默认同步模式；成员可自行覆盖自己的同步模式 */
  defaultSyncMode: RoomSyncMode;
  state: RoomPlayState;
  members: RoomMember[];
  /** 最近一次事件序号，仅作参考；客户端以收到的事件 seq 为准 */
  seq: number;
  createdAt: number;
  lastActiveAt: number;
}

export type RoomEventType = 'system' | 'chat' | 'control';

export interface RoomEvent {
  seq: number;
  type: RoomEventType;
  actorId: string;
  actorName: string;
  text: string;
  at: number;
}

export type ControlKind = 'play' | 'pause' | 'seek' | 'episode';
export type RoomSyncMode = 'auto' | 'manual';

export type RoomRequest =
  | {
      action: 'create';
      name: string;
      title: string;
      playPath: string;
      episode: number;
    }
  | { action: 'join'; roomId: string; name: string }
  | {
      action: 'sync';
      roomId: string;
      memberId: string;
      since: number;
      /** 用于房间重启后自愈重入 */
      name?: string;
      /** 房主上报当前播放页，成员据此判断是否需要换集 */
      playPath?: string;
      episode?: number;
      /** 房主上报本地播放状态作为心跳 */
      local?: { time: number; playing: boolean };
    }
  | {
      action: 'setSyncMode';
      roomId: string;
      memberId: string;
      syncMode: RoomSyncMode;
    }
  | {
      action: 'control';
      roomId: string;
      memberId: string;
      kind: ControlKind;
      time: number;
      playing: boolean;
    }
  | { action: 'chat'; roomId: string; memberId: string; text: string }
  | { action: 'leave'; roomId: string; memberId: string };

export interface RoomResponse {
  ok: boolean;
  error?: string;
  room?: WatchRoom;
  events?: RoomEvent[];
  /** 服务端确认 / 重新分配的成员 id */
  memberId?: string;
  /** 当前调用者是否为房主，由服务端判定 */
  isHost?: boolean;
  serverTime?: number;
  /** 'upstash' / 'd1' 表示状态跨实例共享；'memory' 表示仅当前进程可用 */
  storeKind?: 'upstash' | 'd1' | 'memory';
}

export function isRoomId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[A-Z0-9]{${ROOM_ID_LENGTH}}$`).test(value)
  );
}

/** 清洗用户可控文本：去掉控制字符、压缩空白、限长 */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // 避免 no-control-regex：通过字符码过滤控制字符
  const sanitized = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return sanitized.trim().slice(0, maxLength);
}

export function currentPlayPath(): string {
  if (typeof window === 'undefined') return '/play';
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  return `${url.pathname}${url.search}`;
}
