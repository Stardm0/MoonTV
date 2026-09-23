'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface BackButtonProps {
  /**
   * 没有上一页历史时跳转的兜底地址。
   *
   * 直接打开播放页（新标签、外部链接进来）时 `history.length` 为 1，
   * 此时 `router.back()` 什么都不做，必须兜底跳转。
   */
  fallbackHref?: string;
  /** 是否在图标旁显示文字标签 */
  showLabel?: boolean;
  /** 文字标签内容 */
  label?: string;
  /** 追加的样式类 */
  className?: string;
}

/**
 * 返回上一级按钮。
 *
 * 播放页此前没有任何返回入口，退出只能回主页重新点进来，非常不方便。
 */
export function BackButton({
  fallbackHref = '/',
  showLabel = false,
  label = '返回',
  className = '',
}: BackButtonProps) {
  const router = useRouter();

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  };

  const baseClass = showLabel
    ? 'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors'
    : 'flex h-10 w-10 items-center justify-center rounded-full p-2 transition-colors';

  return (
    <button
      type='button'
      onClick={handleBack}
      className={`${baseClass} bg-gray-200/70 text-gray-700 hover:bg-gray-300/80 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-600/80 ${className}`}
      aria-label={label}
      title={label}
    >
      <ArrowLeft className={showLabel ? 'h-4 w-4' : 'h-full w-full'} />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
