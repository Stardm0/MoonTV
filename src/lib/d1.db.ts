/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import { AdminConfig } from './admin.types';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

// D1 数据库类型定义
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
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
      .prepare('DELETE FROM search_history WHERE user_id = ?')
      .bind(userId)
      .run();

    await this.db
      .prepare('DELETE FROM skip_configs WHERE user_id = ?')
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

  // 清空所有数据
  async clearAllData(): Promise<void> {
    // 删除所有表的数据
    await this.db.prepare('DELETE FROM play_records').run();
    await this.db.prepare('DELETE FROM favorites').run();
    await this.db.prepare('DELETE FROM search_history').run();
    await this.db.prepare('DELETE FROM skip_configs').run();
    await this.db.prepare('DELETE FROM users').run();
    await this.db.prepare('DELETE FROM admin_config').run();
  }
}
