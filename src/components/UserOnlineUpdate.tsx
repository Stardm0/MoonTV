/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
'use client';

import { useEffect } from 'react';
import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

/**
 * 用户在线心跳组件
 * 页面加载时记录一次用户的在线时间
 * 仅执行一次（组件挂载时）
 * 仅在用户登录状态下执行
 */
export default function UserOnlineUpdate() {
  useEffect(() => {
    const updateOnline = async () => {
      try {
        // 检查用户是否已登录
        const authInfo = getAuthInfoFromBrowserCookie();
        if (!authInfo?.username) {
          // 用户未登录，跳过在线时间更新
          return;
        }
        const response = await fetch('/api/user/online', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          cache: 'no-store',
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          console.error('更新用户在线时间失败', {
            status: response.status,
            statusText: response.statusText,
            body,
          });
        }
      } catch (error) {
        console.error('调用更新用户在线时间接口出错', error);
      }
    };
    updateOnline();
  }, []);

  return null;
}


