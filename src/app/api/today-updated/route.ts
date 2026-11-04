/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { TodayUpdatedItem, TodayUpdatedRecord } from '@/lib/types';

export const runtime = 'edge';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object';
}

// 校验“今日新更”记录结构，返回规范化后的记录；非法则返回 null
function validateRecord(body: unknown): TodayUpdatedRecord | null {
  if (!isRecord(body)) return null;

  const date = typeof body.date === 'string' ? body.date : '';
  // 日期格式校验：YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: TodayUpdatedItem[] = rawItems.filter(isRecord).map((it) => ({
    source: String(it.source ?? ''),
    id: String(it.id ?? ''),
    title: String(it.title ?? ''),
    poster: String(it.poster ?? ''),
    episodes: Number(it.episodes) || 0,
    watchedEpisodes: Number(it.watchedEpisodes) || 0,
    unwatchedEpisodes: Number(it.unwatchedEpisodes) || 0,
    source_name: String(it.source_name ?? ''),
    year: String(it.year ?? ''),
    save_time: Number(it.save_time) || 0,
    oldEpisodes: Number(it.oldEpisodes) || 0,
    newEpisodes: Number(it.newEpisodes) || 0,
  }));

  return { date, items };
}

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const config = await getConfig();
    if (config.UserConfig.Users) {
      // 检查用户是否被封禁
      const user = config.UserConfig.Users.find(
        (u) => u.username === authInfo.username
      );
      if (user && user.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const record = await db.getTodayUpdated(authInfo.username);
    return NextResponse.json(record);
  } catch (error) {
    console.error('获取“今日新更”记录失败:', error);
    return NextResponse.json(
      { error: '获取“今日新更”记录失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const adminConfig = await getConfig();
    if (adminConfig.UserConfig.Users) {
      // 检查用户是否被封禁
      const user = adminConfig.UserConfig.Users.find(
        (u) => u.username === authInfo.username
      );
      if (user && user.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const body = await request.json();
    const record = validateRecord(body);

    if (!record) {
      return NextResponse.json({ error: '无效的记录格式' }, { status: 400 });
    }

    await db.setTodayUpdated(authInfo.username, record);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('保存“今日新更”记录失败:', error);
    return NextResponse.json(
      { error: '保存“今日新更”记录失败' },
      { status: 500 }
    );
  }
}
