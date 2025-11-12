/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    // 检查用户权限
    const adminConfig = await getConfig();
    const storage = getStorage();

    if (username !== process.env.USERNAME) {
      const user = adminConfig.UserConfig.Users.find((u) => u.username === username);
      if (!user || user.role !== 'admin' || user.banned) {
        return NextResponse.json(
          { error: '权限不足，只有管理员可以修改配置文件' },
          { status: 403 }
        );
      }
    }

    // 获取请求体
    const body = await request.json();
    const { configFile } = body;

    if (!configFile || typeof configFile !== 'string') {
      return NextResponse.json(
        { error: '配置文件内容不能为空' },
        { status: 400 }
      );
    }

    // 验证 JSON 格式
    try {
      JSON.parse(configFile);
    } catch (e) {
      return NextResponse.json(
        { error: '配置文件格式错误，请检查 JSON 语法' },
        { status: 400 }
      );
    }

    // 更新配置文件
    adminConfig.ConfigFile = configFile;
    
    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);

      return NextResponse.json({
        success: true,
        message: '配置文件更新成功',
      });
    } else {
      return NextResponse.json(
        { error: '存储服务不可用' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('更新配置文件失败:', error);
    return NextResponse.json(
      {
        error: '更新配置文件失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
