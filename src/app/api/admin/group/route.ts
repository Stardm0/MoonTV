/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

type Action =
  | 'create'
  | 'delete'
  | 'rename'
  | 'setSources'
  | 'assignUsers' // 批量分配用户到某个组
  | 'removeUsers'; // 批量将用户从其组移除

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行管理员配置' },
      { status: 400 }
    );
  }

  try {
    const body = (await request.json()) as Record<string, any>;
    const { action } = body as { action?: Action };

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;

    const adminConfig = await getConfig();
    const storage: IStorage | null = getStorage();

    // 权限与身份校验：站长或管理员
    if (username !== process.env.USERNAME) {
      const userEntry = adminConfig.UserConfig.Users.find(
        (u) => u.username === username
      );
      if (!userEntry || userEntry.role !== 'admin' || userEntry.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    if (!action) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // 确保分组数组存在
    if (!adminConfig.UserConfig.Groups) {
      adminConfig.UserConfig.Groups = [];
    }

    switch (action) {
      case 'create': {
        const { name, sourceKeys } = body as {
          name?: string;
          sourceKeys?: string[];
        };
        if (!name) return NextResponse.json({ error: '缺少分组名称' }, { status: 400 });
        if (adminConfig.UserConfig.Groups.some((g) => g.name === name)) {
          return NextResponse.json({ error: '分组已存在' }, { status: 400 });
        }
        adminConfig.UserConfig.Groups.push({ name, sourceKeys: Array.isArray(sourceKeys) ? sourceKeys : [] });
        break;
      }
      case 'delete': {
        const { name } = body as { name?: string };
        if (!name) return NextResponse.json({ error: '缺少分组名称' }, { status: 400 });
        const idx = adminConfig.UserConfig.Groups.findIndex((g) => g.name === name);
        if (idx === -1) return NextResponse.json({ error: '分组不存在' }, { status: 404 });
        adminConfig.UserConfig.Groups.splice(idx, 1);
        // 同步清除用户上的该组标记
        adminConfig.UserConfig.Users.forEach((u) => {
          if (u.group === name) delete (u as any).group;
        });
        break;
      }
      case 'rename': {
        const { name, newName } = body as { name?: string; newName?: string };
        if (!name || !newName) return NextResponse.json({ error: '缺少分组名称' }, { status: 400 });
        if (adminConfig.UserConfig.Groups.some((g) => g.name === newName)) {
          return NextResponse.json({ error: '新分组名已存在' }, { status: 400 });
        }
        const group = adminConfig.UserConfig.Groups.find((g) => g.name === name);
        if (!group) return NextResponse.json({ error: '分组不存在' }, { status: 404 });
        group.name = newName;
        // 同步用户上的分组名
        adminConfig.UserConfig.Users.forEach((u) => {
          if (u.group === name) (u as any).group = newName;
        });
        break;
      }
      case 'setSources': {
        const { name, sourceKeys } = body as { name?: string; sourceKeys?: string[] };
        if (!name || !Array.isArray(sourceKeys)) {
          return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
        }
        const group = adminConfig.UserConfig.Groups.find((g) => g.name === name);
        if (!group) return NextResponse.json({ error: '分组不存在' }, { status: 404 });
        group.sourceKeys = sourceKeys;
        break;
      }
      case 'assignUsers': {
        const { name, users } = body as { name?: string; users?: string[] };
        if (!name || !Array.isArray(users)) {
          return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
        }
        const group = adminConfig.UserConfig.Groups.find((g) => g.name === name);
        if (!group) return NextResponse.json({ error: '分组不存在' }, { status: 404 });
        const userSet = new Set(users);
        adminConfig.UserConfig.Users.forEach((u) => {
          if (userSet.has(u.username)) (u as any).group = name;
        });
        break;
      }
      case 'removeUsers': {
        const { users } = body as { users?: string[] };
        if (!Array.isArray(users)) {
          return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
        }
        const userSet = new Set(users);
        adminConfig.UserConfig.Users.forEach((u) => {
          if (userSet.has(u.username)) delete (u as any).group;
        });
        break;
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);
    }
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('分组管理操作失败:', error);
    return NextResponse.json({ error: '分组管理操作失败', details: (error as Error).message }, { status: 500 });
  }
}


