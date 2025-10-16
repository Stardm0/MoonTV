/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const adminConfig = await getConfig();

  // 本地模式：不强制要求登录，用环境变量返回只读信息
  if (storageType === 'localstorage') {
    const base = new URL(request.url);
    base.pathname = '/api/tvbox/config';
    base.search = '';
    return NextResponse.json({
      enabled:
        (process.env.TVBOX_ENABLED == null || String(process.env.TVBOX_ENABLED).trim() === '')
          ? true
          : String(process.env.TVBOX_ENABLED).toLowerCase() === 'true',
      password: process.env.PASSWORD || '',
      url: base.toString(),
      localMode: true,
    });
  }

  // 非本地模式：需要已登录用户
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 生成接口 URL（基于请求 URL 推导）
  const base = new URL(request.url);
  base.pathname = '/api/tvbox/config';
  base.search = '';
  // 为生成的订阅 URL 添加加密后的 un 查询参数
  const un = Buffer.from(authInfo.username, 'utf8').toString('base64');
  const url = `${base.toString()}?un=${encodeURIComponent(un)}`;

  const payload = {
    enabled:
      adminConfig.SiteConfig.TVBoxEnabled === true,
    password: adminConfig.SiteConfig.TVBoxPassword || '',
    url,
    localMode: false,
  } as any;

  return NextResponse.json(payload);
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminConfig = await getConfig();
  const username = authInfo.username;
  if (username !== process.env.USERNAME) {
    const user = adminConfig.UserConfig.Users.find((u) => u.username === username);
    if (!user || user.role !== 'admin' || user.banned) {
      return NextResponse.json({ error: '权限不足' }, { status: 403 });
    }
  }

  const body = await request.json();
  const { enabled, password, mode } = body as {
    enabled?: boolean;
    password?: string;
    mode?: 'custom' | 'random' | 'keep';
  };

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  // localstorage 模式：开关由环境变量控制，这里只允许返回提示，不修改
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '本地模式下由环境变量 TVBOX_ENABLED 控制开关，口令=PASSWORD' },
      { status: 400 }
    );
  }

  // 非本地模式：允许修改配置并持久化
  if (typeof enabled === 'boolean') {
    (adminConfig.SiteConfig as any).TVBoxEnabled = enabled;
  }

  let finalPassword = (adminConfig.SiteConfig as any).TVBoxPassword || '';
  if (mode === 'random') {
    // 简单随机口令
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    finalPassword = Array.from({ length: 16 })
      .map(() => alphabet[Math.floor(Math.random() * alphabet.length)])
      .join('');
  } else if (mode === 'custom' && typeof password === 'string') {
    finalPassword = password;
  }

  (adminConfig.SiteConfig as any).TVBoxPassword = finalPassword;

  const storage = getStorage();
  if (storage && typeof (storage as any).setAdminConfig === 'function') {
    await (storage as any).setAdminConfig(adminConfig);
  }

  const base = new URL(request.url);
  base.pathname = '/api/tvbox/config';
  base.search = '';

  return NextResponse.json({
    enabled: (adminConfig.SiteConfig as any).TVBoxEnabled === true,
    password: (adminConfig.SiteConfig as any).TVBoxPassword || '',
    url: (() => {
      const un = Buffer.from(username, 'utf8').toString('base64');
      return `${base.toString()}?un=${encodeURIComponent(un)}`;
    })(),
  });
}


