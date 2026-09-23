'use client';

import { useEffect, useRef, useState } from 'react';

interface ErrorInfo {
  id: string;
  message: string;
  timestamp: number;
}

/** 提示自动消失时间(ms)：避免一次非致命错误长期挂在页面上 */
const AUTO_DISMISS_MS = 4000;

/** 同一条错误的去重窗口(ms)：窗口内重复触发只提示一次 */
const DEDUPE_WINDOW_MS = 5000;

/** 替换动画时长(ms) */
const REPLACE_PULSE_MS = 200;

export function GlobalErrorIndicator() {
  const [currentError, setCurrentError] = useState<ErrorInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  /** 上一次提示过的文案与时间，用于同文案去重 */
  const lastShownRef = useRef<{ message: string; at: number } | null>(null);

  useEffect(() => {
    // 定时器放在 effect 作用域内，卸载时一并清理
    const timers: {
      hide: ReturnType<typeof setTimeout> | null;
      pulse: ReturnType<typeof setTimeout> | null;
    } = { hide: null, pulse: null };

    // 监听自定义错误事件
    const handleError = (event: CustomEvent) => {
      const { message } = event.detail ?? {};
      if (typeof message !== 'string' || !message) return;

      // 同一条文案在短时间内重复触发（如多个请求同时失败）只提示一次
      const now = Date.now();
      const last = lastShownRef.current;
      if (last && last.message === message && now - last.at < DEDUPE_WINDOW_MS) {
        return;
      }
      lastShownRef.current = { message, at: now };

      setCurrentError({ id: String(now), message, timestamp: now });
      setIsVisible(true);
      setIsReplacing(true);
      if (timers.pulse) clearTimeout(timers.pulse);
      timers.pulse = setTimeout(() => setIsReplacing(false), REPLACE_PULSE_MS);

      // 关键：提示必须自己消失。此前要用户手动关闭，配合后台同步失败这种
      // 反复触发的场景，就会一直有一条红字挂在播放页上。
      if (timers.hide) clearTimeout(timers.hide);
      timers.hide = setTimeout(() => {
        setIsVisible(false);
        setIsReplacing(false);
      }, AUTO_DISMISS_MS);
    };

    window.addEventListener('globalError', handleError as EventListener);

    return () => {
      window.removeEventListener('globalError', handleError as EventListener);
      if (timers.hide) clearTimeout(timers.hide);
      if (timers.pulse) clearTimeout(timers.pulse);
    };
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setCurrentError(null);
    setIsReplacing(false);
  };

  if (!isVisible || !currentError) {
    return null;
  }

  return (
    <div className='fixed top-4 right-4 z-[2000]'>
      {/* 错误卡片 */}
      <div
        className={`bg-red-500 text-white px-4 py-3 rounded-lg shadow-lg flex items-center justify-between min-w-[300px] max-w-[400px] transition-all duration-300 ${
          isReplacing ? 'scale-105 bg-red-400' : 'scale-100 bg-red-500'
        } animate-fade-in`}
      >
        <span className='text-sm font-medium flex-1 mr-3'>
          {currentError.message}
        </span>
        <button
          onClick={handleClose}
          className='text-white hover:text-red-100 transition-colors flex-shrink-0'
          aria-label='关闭错误提示'
        >
          <svg
            className='w-5 h-5'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M6 18L18 6M6 6l12 12'
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// 全局错误触发函数
export function triggerGlobalError(message: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('globalError', {
        detail: { message },
      })
    );
  }
}
