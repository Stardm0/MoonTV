-- D1 数据库初始化脚本
-- 为 MoonTV 应用创建所有必要的表结构
--
-- 【本版本差异】观影室段落已合并「大房间性能优化」表结构：
--   新增 watch_room_members（一行一个成员），其余表结构与原版完全一致。

-- 创建用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  banned BOOLEAN DEFAULT false,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建播放记录表
CREATE TABLE IF NOT EXISTS play_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  year TEXT,
  cover TEXT,
  episode_index INTEGER,
  total_episodes INTEGER,
  play_time INTEGER,
  total_time INTEGER,
  save_time INTEGER,
  search_title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, video_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建收藏表
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  year TEXT,
  cover TEXT,
  total_episodes INTEGER,
  save_time INTEGER,
  search_title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, video_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建追更表
CREATE TABLE IF NOT EXISTS followings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  year TEXT,
  cover TEXT,
  total_episodes INTEGER,
  watched_episodes INTEGER,
  save_time INTEGER,
  search_title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, video_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建搜索历史表
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, keyword),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建跳过片头片尾配置表
CREATE TABLE IF NOT EXISTS skip_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  video_id TEXT NOT NULL,
  enable BOOLEAN DEFAULT false,
  intro_time INTEGER DEFAULT 0,
  outro_time INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, video_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建“今日新更”记录表（每个用户一行，整份记录以 JSON 文本存储，保留一天、跨设备跟随账号）
CREATE TABLE IF NOT EXISTS today_updated (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 创建管理员配置表
CREATE TABLE IF NOT EXISTS admin_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  config TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 共同观影室（watch-room）表结构
-- 房间核心快照 / 事件流 / 每房间自增序号 / 成员在线状态
--
-- 大房间优化：成员不再塞在 watch_rooms.data 的 members 数组里，
-- 改为 watch_room_members 一行一个成员。单次心跳只 UPDATE 一行，
-- 房间核心只由房主心跳 / 配置变更写入，避免 N 人并发重写整份 JSON。
-- ============================================================
CREATE TABLE IF NOT EXISTS watch_rooms (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_room_events (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE IF NOT EXISTS watch_room_seqs (
  room_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

-- 成员在线状态表：presence 层按成员粒度读写
CREATE TABLE IF NOT EXISTS watch_room_members (
  room_id       TEXT    NOT NULL,
  member_id     TEXT    NOT NULL,
  name          TEXT    NOT NULL DEFAULT '观众',
  joined_at     INTEGER NOT NULL,
  sync_mode     TEXT    NOT NULL DEFAULT 'auto',
  last_seen     INTEGER NOT NULL,
  last_chat_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_rooms_updated ON watch_rooms (updated_at);

-- 事件流按 (room_id, seq) 增量拉取；这个索引已覆盖所需查询，
-- 不要再建同列的第二个索引（旧迁移脚本曾多建一个 idx_watch_room_events_seq）。
CREATE INDEX IF NOT EXISTS idx_watch_room_events_order ON watch_room_events (room_id, seq);

-- 超时清扫 / 活跃人数统计走 (room_id, last_seen)
CREATE INDEX IF NOT EXISTS idx_watch_room_members_seen
  ON watch_room_members (room_id, last_seen);

-- 成员预览 / 房主移交按加入时间排序
CREATE INDEX IF NOT EXISTS idx_watch_room_members_joined
  ON watch_room_members (room_id, joined_at);

-- 输出成功信息
SELECT '✅ D1 数据库表结构创建完成' as status;

-- 显示创建的表列表
SELECT '📋 创建的数据库表:' as info;
SELECT '  • users - 用户表' as table_info;
SELECT '  • play_records - 播放记录表' as table_info;
SELECT '  • favorites - 收藏表' as table_info;
SELECT '  • followings - 追更表' as table_info;
SELECT '  • search_history - 搜索历史表' as table_info;
SELECT '  • skip_configs - 跳过片头片尾配置表' as table_info;
SELECT '  • today_updated - 今日新更记录表' as table_info;
SELECT '  • admin_config - 管理员配置表' as table_info;
SELECT '  • source_configs - 源配置表' as table_info;
SELECT '  • custom_categories - 自定义分类表' as table_info;
SELECT '  • watch_rooms - 观影室房间表' as table_info;
SELECT '  • watch_room_events - 观影室事件表' as table_info;
SELECT '  • watch_room_seqs - 观影室序号表' as table_info;
SELECT '  • watch_room_members - 观影室成员在线状态表' as table_info;
