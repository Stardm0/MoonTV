/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';
import { inflate } from 'pako';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { configSelfCheck, setCachedConfig } from '@/lib/config';
import { SimpleCrypto } from '@/lib/crypto';
import { db } from '@/lib/db';

export const runtime = 'edge';

// pako 的 gunzip 是同步的，不需要 promisify

export async function POST(req: NextRequest) {
  try {
    // 检查存储类型
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    if (storageType === 'localstorage') {
      return NextResponse.json(
        { error: '不支持本地存储进行数据迁移' },
        { status: 400 }
      );
    }

    // 验证身份和权限
    const authInfo = getAuthInfoFromCookie(req);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    // 检查用户权限（只有站长可以导入数据）
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json({ error: '权限不足，只有站长可以导入数据' }, { status: 401 });
    }

    // 解析表单数据
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const password = formData.get('password') as string;

    if (!file) {
      return NextResponse.json({ error: '请选择备份文件' }, { status: 400 });
    }

    if (!password) {
      return NextResponse.json({ error: '请提供解密密码' }, { status: 400 });
    }

    // 读取文件内容
    const encryptedData = await file.text();

    // 解密数据
    let decryptedData: string;
    try {
      decryptedData = SimpleCrypto.decrypt(encryptedData, password);
    } catch (error) {
      return NextResponse.json({ error: '解密失败，请检查密码是否正确' }, { status: 400 });
    }

    // 解压缩数据
    const compressedBuffer = Buffer.from(decryptedData, 'base64');
    const decompressedBuffer = inflate(compressedBuffer);
    const decompressedData = new TextDecoder().decode(decompressedBuffer);

    // 解析JSON数据
    let importData: any;
    try {
      importData = JSON.parse(decompressedData);
    } catch (error) {
      return NextResponse.json({ error: '备份文件格式错误' }, { status: 400 });
    }

    // 验证数据格式
    if (!importData.data || !importData.data.adminConfig || !importData.data.userData) {
      return NextResponse.json({ error: '备份文件格式无效' }, { status: 400 });
    }

    // 开始导入数据 - 先清空现有数据
    await db.clearAllData();

    // 导入管理员配置
    importData.data.adminConfig = configSelfCheck(importData.data.adminConfig);
    await db.saveAdminConfig(importData.data.adminConfig);
    await setCachedConfig(importData.data.adminConfig);

    // 导入用户数据
    const userData = importData.data.userData;
    for (const username in userData) {
      const user = userData[username];

      // 重新注册用户（包含密码）
      if (user.password) {
        await db.registerUser(username, String(user.password));
      }

      // 导入播放记录
      if (user.playRecords) {
        for (const [key, record] of Object.entries(user.playRecords)) {
          await (db as any).storage.setPlayRecord(username, key, record);
        }
      }

      // 导入收藏夹
      if (user.favorites) {
        for (const [key, favorite] of Object.entries(user.favorites)) {
          await (db as any).storage.setFavorite(username, key, favorite);
        }
      }

      // 导入搜索历史
      if (user.searchHistory && Array.isArray(user.searchHistory)) {
        for (const keyword of user.searchHistory.reverse()) { // 反转以保持顺序
          await db.addSearchHistory(username, keyword);
        }
      }

      // 导入跳过片头片尾配置
      if (user.skipConfigs) {
        for (const [key, skipConfig] of Object.entries(user.skipConfigs)) {
          const [source, id] = key.split('+');
          if (source && id) {
            await db.setSkipConfig(username, source, id, skipConfig as any);
          }
        }
      }
    }

    return NextResponse.json({
      message: '数据导入成功',
      importedUsers: Object.keys(userData).length,
      timestamp: importData.timestamp,
      serverVersion: typeof importData.serverVersion === 'string' ? importData.serverVersion : '未知版本'
    });

  } catch (error) {
    console.error('数据导入失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导入失败' },
      { status: 500 }
    );
  }
}
