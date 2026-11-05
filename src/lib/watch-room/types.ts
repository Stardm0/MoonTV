/**
 * 共同观影室：客户端与服务端共享的协议类型与常量。
 *
 * 本文件不依赖任何运行时 API（浏览器 / Node / Edge 均可安全引入）。
 */

/** 房间号为 6 位大写字母数字，方便口头传达与手动输入 */
export const ROOM_ID_LENGTH = 6;

/** 临时观影室最长保留 6 小时；持久房间不设置过期时间 */
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

/** 成员空闲时的轮询间隔（毫秒）。非房主在房间无新事件时逐步退避到这里 */
export const POLL_IDLE_INTERVAL_MS = 3000;

/** 标签页隐藏 / 面板不可见时的轮询间隔（毫秒） */
export const POLL_HIDDEN_INTERVAL_MS = 15_000;

/** 轮询抖动比例：把同一房间 N 个客户端的请求打散，避免整点惊群 */
export const POLL_JITTER = 0.25;

/**
 * 单次响应最多携带的成员明细条数。
 * 大房间只回传这个上限的预览名单 + 精确总人数，不再把整份名单推给每个人。
 */
export const MEMBER_PREVIEW_LIMIT = 20;

/** 同一成员的聊天冷却（毫秒），防止大房间消息风暴打爆事件流 */
export const CHAT_COOLDOWN_MS = 900;

/** 成员元数据 / 在线标记的兜底 TTL（秒），略大于离线判定窗口即可 */
export const MEMBER_META_TTL_SECONDS = 60;

/** 事件批量写入时单次响应的上限 */
export const EVENT_RESPONSE_LIMIT = EVENT_LIMIT;

/** 创建观影室时允许设置的最小 / 最大 / 默认人数上限 */
export const MIN_ROOM_CAPACITY = 1;
export const MAX_ROOM_CAPACITY = 100;
export const DEFAULT_ROOM_CAPACITY = 20;

/**
 * 读取 / 校验口径：把房间对象里存的 maxMembers 转成有效上限。
 *
 * 返回 undefined 表示「不限制」。这个语义必须保留：升级前创建的房间没有
 * maxMembers 字段，若把它也解释成默认上限，历史房间会被凭空限流。
 * 列表展示、容量校验都用这个函数。
 */
export function normalizeCapacity(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const rounded = Math.floor(n);
  if (rounded < MIN_ROOM_CAPACITY) return undefined;
  return Math.min(rounded, MAX_ROOM_CAPACITY);
}

/**
 * 创建口径：输入框留空 / 0 / 非数字一律落到默认上限，填了有效数字则
 * 收敛到 [MIN, MAX]。始终返回具体数字，保证新建房间一定带 maxMembers。
 *
 * 与 normalizeCapacity 分开是为了让「历史房间不限制」和「新房间默认 20 人」
 * 两件事互不干扰：前者是读旧数据，后者是写新数据。
 */
export function resolveCreateCapacity(value: unknown): number {
  return normalizeCapacity(value) ?? DEFAULT_ROOM_CAPACITY;
}

export interface RoomMember {
  id: string;
  name: string;
  joinedAt: number;
  lastSeen: number;
  syncMode: RoomSyncMode;
  /** 内部字段：上次发言时间，用于服务端聊天限流；不参与 UI 展示 */
  lastChatAt?: number;
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
  /** 创建者账号；存在时房间不会因成员离开或 TTL 自动删除 */
  owner?: string;
  persistent?: boolean;
  /** 是否启用，关闭后不再接收心跳；重新打开后继续使用 */
  enabled?: boolean;
  /**
   * 是否公开：公开后房间会出现在「观影室」页面的公开列表里，
   * 任何登录用户都能看到并加入。
   */
  isPublic?: boolean;
  /** 首次公开的时间，用于公开列表排序与展示 */
  publicizedAt?: number;
  /** 自定义房间名，显示在导航与房间列表头；默认为影片名 */
  title: string;
  /** 是否用户显式自定义了房间名称；如果是，则不随影片切换而改写 */
  customName?: boolean;
  /** 当前播放影片标题，用于展示与切集提示，不覆盖房间名 */
  videoTitle?: string;
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
  /**
   * 成员明细预览（最多 MEMBER_PREVIEW_LIMIT 条）。
   * 大房间下持久化层不再保存全量名单，真实名单由 presence 层按成员粒度维护。
   */
  members: RoomMember[];
  /** 活跃成员精确总数，由 presence 层实时统计 */
  memberCount?: number;
  /**
   * 房主创建时设置的在线人数上限。新建房间必定带此字段（默认 20 人）；
   * 字段缺失表示升级前创建的历史房间，按「不限制」处理。
   */
  maxMembers?: number;
  /** 最近一次事件序号，仅作参考；客户端以收到的事件 seq 为准 */
  seq: number;
  /**
   * 房间核心版本号，仅在核心状态（播放状态 / 影片 / 房主 / 配置）变化时递增。
   * 客户端带上它后可以跳过无变化的心跳响应。
   */
  rev?: number;
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

/** 待写入事件：seq 由存储层批量、原子分配 */
export type EventDraft = Omit<RoomEvent, 'seq'>;

export type ControlKind = 'play' | 'pause' | 'seek' | 'episode';
export type RoomSyncMode = 'auto' | 'manual';

export type RoomRequest =
  | {
      action: 'create';
      name: string;
      title: string;
      roomName?: string;
      playPath: string;
      episode: number;
      persistent?: boolean;
      /** 创建时直接公开到观影室页面 */
      isPublic?: boolean;
      /** 在线人数上限；留空 / 0 由服务端落到默认 20 人，最大 100 */
      maxMembers?: number;
    }
  /**
   * 我的房间列表。
   * fresh=true 时跳过服务端列表缓存，并按实时在线状态重新统计人数，
   * 供「观影室」页面的刷新按钮使用。
   */
  | { action: 'myRooms'; fresh?: boolean }
  /** 公开列表：所有已公开且未关闭的房间，任何人可加入 */
  | { action: 'publicRooms'; fresh?: boolean }
  | { action: 'setPublic'; roomId: string; public: boolean }
  | { action: 'close'; roomId: string }
  | { action: 'delete'; roomId: string }
  | { action: 'enterOwned'; roomId: string; name: string }
  | { action: 'activateOwned'; roomId: string }
  | { action: 'hasPersistentRoom' }
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
      /** 房主当前播放影片名称 */
      title?: string;
      episode?: number;
      /** 房主上报本地播放状态作为心跳 */
      local?: { time: number; playing: boolean };
      /** 客户端已持有的核心版本号，用于跳过无变化响应 */
      rev?: number;
      /** 客户端已持有的在线人数，用于判断名单是否需要刷新 */
      memberCount?: number;
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
  rooms?: WatchRoom[];
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
  /** 活跃成员精确总数 */
  memberCount?: number;
  /** 调用者自己的同步模式（即使名单被裁剪也能拿到） */
  mySyncMode?: RoomSyncMode;
  /** 当前房间核心版本号 */
  rev?: number;
  /** 为 true 时 room 省略，客户端可完全跳过状态更新 */
  unchanged?: boolean;
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
