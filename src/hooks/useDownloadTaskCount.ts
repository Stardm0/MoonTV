'use client';

import { useEffect, useState } from 'react';

/** 计入角标的「未完成」状态（已完成的 / 已取消的不算） */
const ACTIVE_DOWNLOAD_STATUSES = new Set([
  'downloading',
  'paused',
  'waiting',
  'error',
]);

/** 下载任务在 localStorage 中的键（DownloadManager 写入） */
const DOWNLOAD_TASKS_KEY = 'downloadTasks';

/**
 * 统计未完成的下载任务数量，供导航栏角标使用。
 *
 * 抽成 hook 是因为顶部导航与首页侧边栏都需要这个数字 —— 两边各写一份
 * 监听逻辑迟早会漂移（比如只在一处补了事件名）。角标数据源只有
 * localStorage，因此这里同时监听原生 `storage` 事件（跨标签页）和
 * `downloadTasksUpdated` 自定义事件（同一标签页内任务变更）。
 */
export function useDownloadTaskCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const read = () => {
      if (typeof window === 'undefined') return;
      const saved = window.localStorage.getItem(DOWNLOAD_TASKS_KEY);
      if (!saved) {
        setCount(0);
        return;
      }
      try {
        const tasks = JSON.parse(saved);
        if (!Array.isArray(tasks)) {
          setCount(0);
          return;
        }
        setCount(
          tasks.filter((task: { status?: string }) =>
            ACTIVE_DOWNLOAD_STATUSES.has(task?.status ?? '')
          ).length
        );
      } catch {
        // 存储内容损坏时按 0 处理，不打扰用户
        setCount(0);
      }
    };

    read();
    window.addEventListener('storage', read);
    window.addEventListener('downloadTasksUpdated', read as EventListener);
    return () => {
      window.removeEventListener('storage', read);
      window.removeEventListener('downloadTasksUpdated', read as EventListener);
    };
  }, []);

  return count;
}

export default useDownloadTaskCount;
