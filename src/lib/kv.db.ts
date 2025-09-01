import { AdminConfig } from '@/lib/admin.types';
import {
  type IStorage,
  Favorite,
  IKVDatabase,
  PlayRecord,
  SkipConfig,
} from '@/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse<T = any>(s: string | null): T | null {
  if (s == null) return null;
  return JSON.parse(s);
}

function makeKey(...args: string[]): string {
  return args.join('#');
}

export class StoreageInKV implements IStorage {
  private db: IKVDatabase;
  constructor(db: IKVDatabase) {
    this.db = db;
  }

  private _ParseObjectOrNull<T>(key: string): Promise<T | null> {
    return this.db.get(key).then((value) => {
      return parse(value);
    });
  }
  private _ListToRecord<T>(prefix: string): Promise<Record<string, T>> {
    return this.db.list(prefix).then((arr) => {
      const result: Record<string, T> = Object.create(null);
      for (const [k, v] of arr) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        result[k.substring(prefix.length)] = parse<T>(v)!;
      }
      return result;
    });
  }

  getPlayRecord(userName: string, key: string): Promise<PlayRecord | null> {
    return this._ParseObjectOrNull<PlayRecord>(
      makeKey('playrecord', userName, key)
    );
  }
  setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void> {
    return this.db.set(
      makeKey('playrecord', userName, key),
      JSON.stringify(record)
    );
  }
  async getAllPlayRecords(
    userName: string
  ): Promise<{ [key: string]: PlayRecord }> {
    return this._ListToRecord<PlayRecord>(makeKey('playrecord', userName, ''));
  }
  deletePlayRecord(userName: string, key: string): Promise<void> {
    return this.db.set(makeKey('playrecord', userName, key), null);
  }
  getFavorite(userName: string, key: string): Promise<Favorite | null> {
    return this._ParseObjectOrNull<Favorite>(
      makeKey('favorite', userName, key)
    );
  }
  setFavorite(
    userName: string,
    key: string,
    favorite: Favorite
  ): Promise<void> {
    return this.db.set(
      makeKey('favorite', userName, key),
      JSON.stringify(favorite)
    );
  }
  getAllFavorites(userName: string): Promise<{ [key: string]: Favorite }> {
    return this._ListToRecord<Favorite>(makeKey('favorite', userName));
  }
  deleteFavorite(userName: string, key: string): Promise<void> {
    return this.db.set(makeKey('favorite', userName, key), null);
  }
  registerUser(userName: string, password: string): Promise<void> {
    return this.db.set(makeKey('password', userName), password);
  }
  async verifyUser(userName: string, password: string): Promise<boolean> {
    return (await this.db.get(makeKey('password', userName))) === password;
  }
  async checkUserExist(userName: string): Promise<boolean> {
    return (await this.db.get(makeKey('password', userName))) != null;
  }
  changePassword(userName: string, newPassword: string): Promise<void> {
    return this.db.set(makeKey('password', userName), newPassword);
  }
  deleteUser(userName: string): Promise<void> {
    return this.db.set(makeKey('password', userName), null);
  }
  async getSearchHistory(userName: string): Promise<string[]> {
    const arr = await this.db.list(makeKey('search-history', userName, ''));
    return arr.map((a) => a[1]);
  }
  addSearchHistory(userName: string, keyword: string): Promise<void> {
    return this.db.set(makeKey('search-history', userName, keyword), keyword);
  }
  deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    return this.db.set(
      makeKey('search-history', userName, keyword || ''),
      null
    );
  }
  async getAllUsers(): Promise<string[]> {
    const prefix = makeKey('password', '');
    const arr = await this.db.list(prefix);
    return arr.map((a) => a[0].substring(prefix.length));
  }
  getAdminConfig(): Promise<AdminConfig | null> {
    return this.db.get('admin-config').then((x) => parse(x) as AdminConfig);
  }
  setAdminConfig(config: AdminConfig): Promise<void> {
    return this.db.set('admin-config', JSON.stringify(config));
  }
  getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    const key = makeKey('skip-config', userName, source, id);
    return this.db.get(key).then((x) => parse(x) as SkipConfig);
  }
  setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    const key = makeKey('skip-config', userName, source, id);
    return this.db.set(key, JSON.stringify(config));
  }
  deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = makeKey('skip-config', userName, source, id);
    return this.db.set(key, null);
  }
  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    const prefix = makeKey('skip-config', userName, '');
    const arr = await this.db.list(prefix);
    const obj = Object.create(null);
    for (const [k, v] of arr) {
      const [, , , id] = k.split('#');
      obj[id] = parse(v);
    }
    return obj;
  }
}
