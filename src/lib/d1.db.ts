/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import { AdminConfig } from './admin.types';
import {
  Favorite,
  Following,
  IStorage,
  PlayRecord,
  SkipConfig,
  TodayUpdatedRecord,
} from './types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

// D1 数据库类型定义
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
  // 批量执行多条语句（一次 API 请求内完成，用于规避单次 Worker invocation 的 subrequest 限制）
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

interface D1PreparedStatement {
  bind(...params: any[]): D1PreparedStatement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

interface D1Result<T = any> {
  success: boolean;
  results?: T[];
  meta?: any;
}

// 获取 D1 数据库绑定
function getD1Database(): D1Database {
  // 在 Cloudflare Pages 环境中，D1 数据库通过环境变量绑定
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as any).DB as D1Database;
  }

  // 在浏览器环境中，D1 不可用
  throw new Error(
    'D1 database is only available in Cloudflare Pages environment'
  );
}

export class D1Storage implements IStorage {
  private db: D1Database;

  constructor() {
    this.db = getD1Database();
  }

  // ---------- 用户相关 ----------
  private async getUserId(username: string): Promise<number | null> {
    const result = await this.db
      .prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first();

    return result ? (result.id as number) : null;
  }

  // 如果用户不存在则自动创建（角色默认为 user）
  private async ensureUser(username: string): Promise<number> {
    let userId = await this.getUserId(username);
    if (userId) return userId;

    await this.db
      .prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .bind(username, '', 'user')
      .run();

    userId = await this.getUserId(username);
    if (!userId) throw new Error('Failed to create user');
    return userId;
  }

  async registerUser(userName: string, password: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO users (username, password) VALUES (?, ?)')
      .bind(userName, password)
      .run();
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    const result = await this.db
      .prepare('SELECT id FROM users WHERE username = ? AND password = ?')
      .bind(userName, password)
      .first();

    return !!result;
  }

  async checkUserExist(userName: string): Promise<boolean> {
    const result = await this.db
      .prepare('SELECT id FROM users WHERE username = ?')
      .bind(userName)
      .first();

    return !!result;
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    const userId = await this.getUserId(userName);
    if (!userId) throw new Error('User not found');

    await this.db
      .prepare('UPDATE users SET password = ? WHERE id = ?')
      .bind(newPassword, userId)
      .run();
  }

  async deleteUser(userName: string): Promise<void> {
    const userId = await this.getUserId(userName);
    if (!userId) return;

    // 删除用户的所有数据
    await this.db
      .prepare('DELETE FROM play_records WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM favorites WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM followings WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM search_history WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM skip_configs WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM today_updated WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  }

  // ---------- 播放记录 ----------
  async getPlayRecord(
    userName: string,
    key: string
  ): Promise<PlayRecord | null> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return null;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return null;

    const result = await this.db
      .prepare(
        `
        SELECT * FROM play_records 
        WHERE user_id = ? AND source = ? AND video_id = ?
      `
      )
      .bind(userId, source, videoId)
      .first();

    if (!result) return null;

    return {
      title: result.title as string,
      source_name: result.source_name as string,
      year: result.year as string,
      cover: result.cover as string,
      index: result.episode_index as number,
      total_episodes: result.total_episodes as number,
      play_time: result.play_time as number,
      total_time: result.total_time as number,
      save_time: result.save_time as number,
      search_title: result.search_title as string,
    };
  }

  async setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      throw new Error('Invalid key format for play record');
    }
    const userId = await this.ensureUser(userName);

    // 删除同名的旧记录
    if (record.title) {
      await this.db
        .prepare(
          `
          DELETE FROM play_records 
          WHERE user_id = ? AND title = ? AND NOT (source = ? AND video_id = ?)
        `
        )
        .bind(userId, record.title, source, videoId)
        .run();
    }

    await this.db
      .prepare(
        `
        INSERT INTO play_records 
        (user_id, source, video_id, title, source_name, year, cover, episode_index, 
         total_episodes, play_time, total_time, save_time, search_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source, video_id) 
        DO UPDATE SET
          title = excluded.title,
          source_name = excluded.source_name,
          year = excluded.year,
          cover = excluded.cover,
          episode_index = excluded.episode_index,
          total_episodes = excluded.total_episodes,
          play_time = excluded.play_time,
          total_time = excluded.total_time,
          save_time = excluded.save_time,
          search_title = excluded.search_title,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(
        userId,
        source,
        videoId,
        record.title || '',
        record.source_name || '',
        record.year || '',
        record.cover || '',
        record.index ?? 0,
        record.total_episodes ?? 0,
        record.play_time ?? 0,
        record.total_time ?? 0,
        record.save_time ?? Date.now(),
        record.search_title || ''
      )
      .run();
  }

  async getAllPlayRecords(
    userName: string
  ): Promise<Record<string, PlayRecord>> {
    const userId = await this.getUserId(userName);
    if (!userId) return {};

    const results = await this.db
      .prepare('SELECT * FROM play_records WHERE user_id = ?')
      .bind(userId)
      .all();

    const records: Record<string, PlayRecord> = {};
    for (const result of results.results || []) {
      const key = `${result.source}+${result.video_id}`;
      records[key] = {
        title: result.title as string,
        source_name: result.source_name as string,
        year: result.year as string,
        cover: result.cover as string,
        index: result.episode_index as number,
        total_episodes: result.total_episodes as number,
        play_time: result.play_time as number,
        total_time: result.total_time as number,
        save_time: result.save_time as number,
        search_title: result.search_title as string,
      };
    }

    return records;
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return;

    await this.db
      .prepare(
        'DELETE FROM play_records WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, videoId)
      .run();
  }

  // ---------- 收藏 ----------
  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return null;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return null;

    const result = await this.db
      .prepare(
        'SELECT * FROM favorites WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, videoId)
      .first();

    if (!result) return null;

    return {
      title: result.title as string,
      source_name: result.source_name as string,
      year: result.year as string,
      cover: result.cover as string,
      total_episodes: result.total_episodes as number,
      save_time: result.save_time as number,
      search_title: result.search_title as string,
    };
  }

  async setFavorite(
    userName: string,
    key: string,
    favorite: Favorite
  ): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      throw new Error('Invalid key format for favorite');
    }
    const userId = await this.ensureUser(userName);

    await this.db
      .prepare(
        `
        INSERT INTO favorites 
        (user_id, source, video_id, title, source_name, year, cover, total_episodes, save_time, search_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source, video_id) 
        DO UPDATE SET
          title = excluded.title,
          source_name = excluded.source_name,
          year = excluded.year,
          cover = excluded.cover,
          total_episodes = excluded.total_episodes,
          save_time = excluded.save_time,
          search_title = excluded.search_title
      `
      )
      .bind(
        userId,
        source,
        videoId,
        favorite.title || '',
        favorite.source_name || '',
        favorite.year || '',
        favorite.cover || '',
        favorite.total_episodes ?? 0,
        favorite.save_time ?? Date.now(),
        favorite.search_title || ''
      )
      .run();
  }

  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    const userId = await this.getUserId(userName);
    if (!userId) return {};

    const results = await this.db
      .prepare('SELECT * FROM favorites WHERE user_id = ?')
      .bind(userId)
      .all();

    const favorites: Record<string, Favorite> = {};
    for (const result of results.results || []) {
      const key = `${result.source}+${result.video_id}`;
      favorites[key] = {
        title: result.title as string,
        source_name: result.source_name as string,
        year: result.year as string,
        cover: result.cover as string,
        total_episodes: result.total_episodes as number,
        save_time: result.save_time as number,
        search_title: result.search_title as string,
      };
    }

    return favorites;
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return;

    await this.db
      .prepare(
        'DELETE FROM favorites WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, videoId)
      .run();
  }

  // ---------- 追更 ----------
  async getFollowing(userName: string, key: string): Promise<Following | null> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return null;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return null;

    const result = await this.db
      .prepare(
        'SELECT * FROM followings WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, videoId)
      .first();

    if (!result) return null;

    return {
      title: result.title as string,
      source_name: result.source_name as string,
      year: result.year as string,
      cover: result.cover as string,
      total_episodes: result.total_episodes as number,
      watched_episodes: result.watched_episodes as number,
      save_time: result.save_time as number,
      search_title: result.search_title as string,
    };
  }

  async setFollowing(
    userName: string,
    key: string,
    following: Following
  ): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      throw new Error('Invalid key format for following');
    }
    const userId = await this.ensureUser(userName);

    await this.db
      .prepare(
        `
        INSERT INTO followings
        (user_id, source, video_id, title, source_name, year, cover, total_episodes, watched_episodes, save_time, search_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source, video_id)
        DO UPDATE SET
          title = excluded.title,
          source_name = excluded.source_name,
          year = excluded.year,
          cover = excluded.cover,
          total_episodes = excluded.total_episodes,
          watched_episodes = excluded.watched_episodes,
          save_time = excluded.save_time,
          search_title = excluded.search_title,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(
        userId,
        source,
        videoId,
        following.title || '',
        following.source_name || '',
        following.year || '',
        following.cover || '',
        following.total_episodes ?? 0,
        following.watched_episodes ?? 0,
        following.save_time ?? Date.now(),
        following.search_title || ''
      )
      .run();
  }

  async getAllFollowings(
    userName: string
  ): Promise<Record<string, Following>> {
    const userId = await this.getUserId(userName);
    if (!userId) return {};

    const results = await this.db
      .prepare('SELECT * FROM followings WHERE user_id = ?')
      .bind(userId)
      .all();

    const followings: Record<string, Following> = {};
    for (const result of results.results || []) {
      const key = `${result.source}+${result.video_id}`;
      followings[key] = {
        title: result.title as string,
        source_name: result.source_name as string,
        year: result.year as string,
        cover: result.cover as string,
        total_episodes: result.total_episodes as number,
        watched_episodes: result.watched_episodes as number,
        save_time: result.save_time as number,
        search_title: result.search_title as string,
      };
    }

    return followings;
  }

  async deleteFollowing(userName: string, key: string): Promise<void> {
    const [source, videoId] = key.split('+');
    if (!source || !videoId) {
      return;
    }
    const userId = await this.getUserId(userName);
    if (!userId) return;

    await this.db
      .prepare(
        'DELETE FROM followings WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, videoId)
      .run();
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    const userId = await this.getUserId(userName);
    if (!userId) return [];

    const results = await this.db
      .prepare(
        `
        SELECT keyword FROM search_history 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ?
      `
      )
      .bind(userId, SEARCH_HISTORY_LIMIT)
      .all();

    return (results.results || []).map(
      (result: any) => result.keyword as string
    );
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    const userId = await this.ensureUser(userName);

    // 先删除已存在的相同关键词
    await this.db
      .prepare('DELETE FROM search_history WHERE user_id = ? AND keyword = ?')
      .bind(userId, keyword)
      .run();

    // 插入新关键词
    await this.db
      .prepare('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)')
      .bind(userId, keyword)
      .run();

    // 保持搜索历史不超过限制
    await this.db
      .prepare(
        `
        DELETE FROM search_history 
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM search_history 
          WHERE user_id = ? 
          ORDER BY created_at DESC 
          LIMIT ?
        )
      `
      )
      .bind(userId, userId, SEARCH_HISTORY_LIMIT)
      .run();
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    const userId = await this.getUserId(userName);
    if (!userId) return;

    if (keyword) {
      await this.db
        .prepare('DELETE FROM search_history WHERE user_id = ? AND keyword = ?')
        .bind(userId, keyword)
        .run();
    } else {
      await this.db
        .prepare('DELETE FROM search_history WHERE user_id = ?')
        .bind(userId)
        .run();
    }
  }

  // ---------- 获取全部用户 ----------
  async getAllUsers(): Promise<string[]> {
    const results = await this.db.prepare('SELECT username FROM users').all();

    return (results.results || []).map(
      (result: any) => result.username as string
    );
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    try {
      const result = await this.db
        .prepare('SELECT config FROM admin_config WHERE id = 1')
        .first<{ config: string }>();

      if (!result) return null;

      return JSON.parse(result.config) as AdminConfig;
    } catch (err) {
      console.error('Failed to get admin config:', err);
      throw err;
    }
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    try {
      await this.db
        .prepare(
          'INSERT OR REPLACE INTO admin_config (id, config) VALUES (1, ?)'
        )
        .bind(JSON.stringify(config))
        .run();
    } catch (err) {
      console.error('Failed to set admin config:', err);
      throw err;
    }
  }

  // ---------- 跳过片头片尾配置 ----------
  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    const userId = await this.getUserId(userName);
    if (!userId) return null;

    const result = await this.db
      .prepare(
        'SELECT * FROM skip_configs WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, id)
      .first();

    if (!result) return null;

    return {
      enable: Boolean(result.enable),
      intro_time: result.intro_time as number,
      outro_time: result.outro_time as number,
    };
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    const userId = await this.ensureUser(userName);

    await this.db
      .prepare(
        `
        INSERT INTO skip_configs (user_id, source, video_id, enable, intro_time, outro_time)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source, video_id)
        DO UPDATE SET
          enable = excluded.enable,
          intro_time = excluded.intro_time,
          outro_time = excluded.outro_time,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(
        userId,
        source,
        id,
        config.enable ? 1 : 0,
        config.intro_time ?? 0,
        config.outro_time ?? 0
      )
      .run();
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const userId = await this.getUserId(userName);
    if (!userId) return;

    await this.db
      .prepare(
        'DELETE FROM skip_configs WHERE user_id = ? AND source = ? AND video_id = ?'
      )
      .bind(userId, source, id)
      .run();
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    const userId = await this.getUserId(userName);
    if (!userId) return {};

    const results = await this.db
      .prepare('SELECT * FROM skip_configs WHERE user_id = ?')
      .bind(userId)
      .all();

    const configs: { [key: string]: SkipConfig } = {};
    for (const result of results.results || []) {
      const key = `${result.source}+${result.video_id}`;
      configs[key] = {
        enable: Boolean(result.enable),
        intro_time: result.intro_time as number,
        outro_time: result.outro_time as number,
      };
    }

    return configs;
  }

  // ---------- “今日新更” ----------
  // 说明：D1 使用 today_updated 表，每个用户一行，整份记录以 JSON 文本存储，
  // 与 redis/upstash 的“固定 key 存 JSON”语义保持一致。
  async getTodayUpdated(
    userName: string
  ): Promise<TodayUpdatedRecord | null> {
    const userId = await this.getUserId(userName);
    if (!userId) return null;

    const result = await this.db
      .prepare('SELECT data FROM today_updated WHERE user_id = ?')
      .bind(userId)
      .first();

    if (!result || !result.data) return null;

    try {
      return JSON.parse(result.data as string) as TodayUpdatedRecord;
    } catch (error) {
      console.error('解析“今日新更”记录失败:', error);
      return null;
    }
  }

  async setTodayUpdated(
    userName: string,
    record: TodayUpdatedRecord
  ): Promise<void> {
    const userId = await this.ensureUser(userName);

    await this.db
      .prepare(
        `
        INSERT INTO today_updated (user_id, date, data, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id)
        DO UPDATE SET
          date = excluded.date,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .bind(userId, record.date, JSON.stringify(record))
      .run();
  }

  // 清空所有数据
  async clearAllData(): Promise<void> {
    // 删除所有表的数据
    await this.db.prepare('DELETE FROM play_records').run();
    await this.db.prepare('DELETE FROM favorites').run();
    await this.db.prepare('DELETE FROM followings').run();
    await this.db.prepare('DELETE FROM search_history').run();
    await this.db.prepare('DELETE FROM skip_configs').run();
    await this.db.prepare('DELETE FROM today_updated').run();
    await this.db.prepare('DELETE FROM users').run();
    await this.db.prepare('DELETE FROM admin_config').run();
  }

  // ============================================================
  // 批量导入（数据迁移专用）
  // 说明：Cloudflare 对单个 Worker invocation 的 subrequest（D1 API 请求）数量
  // 有限制。逐条写入在导入大量数据时会触发
  // “Too many API requests by single Worker invocation”错误。
  // 这里借助 D1 的 batch() 将多条写语句打包成一次 API 请求，从而大幅减少
  // subrequest 数量，规避该限制。
  // ============================================================

  // 将一批已构建好的语句按 D1 batch 上限（100 条/次）分批执行。
  // onProgress 每完成一批回调一次（done 为已执行的语句条数，total 为语句总数），
  // 用于让上层按批次推送进度，避免进度条长时间停滞。
  private async runBatch(
    statements: D1PreparedStatement[],
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const BATCH_LIMIT = 100;
    let done = 0;
    for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
      const chunk = statements.slice(i, i + BATCH_LIMIT);
      await this.db.batch(chunk);
      done += chunk.length;
      if (onProgress) onProgress(done, statements.length);
    }
  }

  // 批量导入播放记录（entries: [key, record][]，key 形如 "source+videoId"）
  async batchImportPlayRecords(
    username: string,
    entries: Array<[string, PlayRecord]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    const statements: D1PreparedStatement[] = [];
    for (const [key, record] of entries) {
      const [source, videoId] = key.split('+');
      if (!source || !videoId) continue;
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO play_records
            (user_id, source, video_id, title, source_name, year, cover, episode_index,
             total_episodes, play_time, total_time, save_time, search_title)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, source, video_id)
            DO UPDATE SET
              title = excluded.title,
              source_name = excluded.source_name,
              year = excluded.year,
              cover = excluded.cover,
              episode_index = excluded.episode_index,
              total_episodes = excluded.total_episodes,
              play_time = excluded.play_time,
              total_time = excluded.total_time,
              save_time = excluded.save_time,
              search_title = excluded.search_title,
              updated_at = CURRENT_TIMESTAMP
            `
          )
          .bind(
            userId,
            source,
            videoId,
            record.title || '',
            record.source_name || '',
            record.year || '',
            record.cover || '',
            record.index ?? 0,
            record.total_episodes ?? 0,
            record.play_time ?? 0,
            record.total_time ?? 0,
            record.save_time ?? Date.now(),
            record.search_title || ''
          )
      );
    }
    await this.runBatch(statements, onProgress);
  }

  // 批量导入收藏（entries: [key, favorite][]）
  async batchImportFavorites(
    username: string,
    entries: Array<[string, Favorite]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    const statements: D1PreparedStatement[] = [];
    for (const [key, favorite] of entries) {
      const [source, videoId] = key.split('+');
      if (!source || !videoId) continue;
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO favorites
            (user_id, source, video_id, title, source_name, year, cover, total_episodes, save_time, search_title)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, source, video_id)
            DO UPDATE SET
              title = excluded.title,
              source_name = excluded.source_name,
              year = excluded.year,
              cover = excluded.cover,
              total_episodes = excluded.total_episodes,
              save_time = excluded.save_time,
              search_title = excluded.search_title
            `
          )
          .bind(
            userId,
            source,
            videoId,
            favorite.title || '',
            favorite.source_name || '',
            favorite.year || '',
            favorite.cover || '',
            favorite.total_episodes ?? 0,
            favorite.save_time ?? Date.now(),
            favorite.search_title || ''
          )
      );
    }
    await this.runBatch(statements, onProgress);
  }

  // 批量导入追更（entries: [key, following][]）
  async batchImportFollowings(
    username: string,
    entries: Array<[string, Following]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    const statements: D1PreparedStatement[] = [];
    for (const [key, following] of entries) {
      const [source, videoId] = key.split('+');
      if (!source || !videoId) continue;
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO followings
            (user_id, source, video_id, title, source_name, year, cover, total_episodes, watched_episodes, save_time, search_title)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, source, video_id)
            DO UPDATE SET
              title = excluded.title,
              source_name = excluded.source_name,
              year = excluded.year,
              cover = excluded.cover,
              total_episodes = excluded.total_episodes,
              watched_episodes = excluded.watched_episodes,
              save_time = excluded.save_time,
              search_title = excluded.search_title,
              updated_at = CURRENT_TIMESTAMP
            `
          )
          .bind(
            userId,
            source,
            videoId,
            following.title || '',
            following.source_name || '',
            following.year || '',
            following.cover || '',
            following.total_episodes ?? 0,
            following.watched_episodes ?? 0,
            following.save_time ?? Date.now(),
            following.search_title || ''
          )
      );
    }
    await this.runBatch(statements, onProgress);
  }

  // 批量导入跳过片头片尾配置（entries: [key, skipConfig][]）
  async batchImportSkipConfigs(
    username: string,
    entries: Array<[string, SkipConfig]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    const statements: D1PreparedStatement[] = [];
    for (const [key, config] of entries) {
      const [source, videoId] = key.split('+');
      if (!source || !videoId) continue;
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO skip_configs (user_id, source, video_id, enable, intro_time, outro_time)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, source, video_id)
            DO UPDATE SET
              enable = excluded.enable,
              intro_time = excluded.intro_time,
              outro_time = excluded.outro_time,
              updated_at = CURRENT_TIMESTAMP
            `
          )
          .bind(
            userId,
            source,
            videoId,
            config.enable ? 1 : 0,
            config.intro_time ?? 0,
            config.outro_time ?? 0
          )
      );
    }
    await this.runBatch(statements, onProgress);
  }

  // 批量导入搜索历史（keywords 需保持原有顺序）
  // 说明：getSearchHistory 按 created_at DESC 返回，故 keywords 为“从新到旧”。
  // 批量插入时若所有 created_at 相同则无法保证顺序，这里为每条显式写入递减的
  // created_at（最新一条时间最大），从而在批量导入后仍能按原顺序正确展示。
  async batchImportSearchHistory(
    username: string,
    keywords: string[],
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    const statements: D1PreparedStatement[] = [];
    // 基准时间（毫秒），最新一条（索引 0）时间最大，后续每条递减 1 秒
    const baseTime = Date.now();
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      if (!keyword) continue;
      // 格式化为 SQLite 可比较的 UTC 时间字符串 YYYY-MM-DD HH:MM:SS
      const created = new Date(baseTime - i * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      statements.push(
        this.db
          .prepare(
            'INSERT INTO search_history (user_id, keyword, created_at) VALUES (?, ?, ?)'
          )
          .bind(userId, keyword, created)
      );
    }
    await this.runBatch(statements, onProgress);
  }

  // 批量导入“今日新更”（每个用户仅一行，直接写入即可）
  async batchImportTodayUpdated(
    username: string,
    record: TodayUpdatedRecord
  ): Promise<void> {
    const userId = await this.ensureUser(username);
    await this.db
      .prepare(
        `
        INSERT INTO today_updated (user_id, date, data, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id)
        DO UPDATE SET
          date = excluded.date,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(userId, record.date, JSON.stringify(record))
      .run();
  }
}
