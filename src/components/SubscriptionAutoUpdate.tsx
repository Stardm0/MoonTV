/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
'use client';

import { useEffect } from 'react';

/**
 * 订阅自动更新检查组件
 * 在页面加载时检查是否需要自动更新订阅，并执行导入（如果需要）
 * 仅执行一次（组件挂载时）
 */
export default function SubscriptionAutoUpdate() {
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const response = await fetch('/api/admin/subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.updated) {
            
            console.log('订阅自动更新已执行', data);
          } else {
            console.log('订阅自动更新未执行:', data.reason);
          }
        } else {
          console.warn('订阅自动更新检查失败:', response.status);
        }
      } catch (error) {
        // 静默失败，不影响用户体验
        console.error('订阅自动更新检查异常:', error);
      }
    };

    checkUpdate();
  }, []); // 空依赖数组确保只运行一次

  // 该组件不渲染任何内容
  return null;
}