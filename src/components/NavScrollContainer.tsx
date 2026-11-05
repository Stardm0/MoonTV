'use client';

import { ChevronLeft, ChevronRight, MousePointer2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import useDragScroll from './useDragScroll';

interface NavScrollContainerProps {
  children: React.ReactNode;
  className?: string;
  /** 路由/激活项变化时，自动把激活项滚动到可视区域 */
  activeKey?: string;
  /** 激活项选择器，配合 activeKey 使用 */
  scrollIntoViewSelector?: string;
  /** 顺序调整完成后的回调（传入新的 key 顺序） */
  onReorder?: (order: string[]) => void;
}

/** 每次点击箭头滚动的距离 */
const SCROLL_STEP = 240;
/** 让激活项两侧留出的呼吸空间 */
const EDGE_PADDING = 8;
/** 首次提示的展示时长（ms） */
const HINT_DURATION_MS = 5200;

/**
 * 导航菜单横向滚动容器
 *
 * - 固定最大宽度，超出部分隐藏并可横向滚动查看；
 * - 鼠标按住拖拽 = 滚动；长按菜单项 = 拿起并调整顺序；
 * - 触屏原生横滑 + 长按排序；
 * - 多重可发现性提示：左右渐隐、悬停箭头、拖动把手、长按进度环、操作气泡。
 */
export default function NavScrollContainer({
  children,
  className = '',
  activeKey,
  scrollIntoViewSelector,
  onReorder,
}: NavScrollContainerProps) {
  const {
    containerRef,
    isDragging,
    isReordering,
    isLongPressing,
    canScrollLeft,
    canScrollRight,
    scrollBy,
    handleClickCapture,
  } = useDragScroll({ onReorder });

  const [showHint, setShowHint] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(true);
  const firstRunRef = useRef(true);

  // 首次出现溢出时展示一次操作提示；用户一旦拖动即永久收起
  useEffect(() => {
    if (isReordering) {
      setShowHint(false);
      return;
    }
    if (!canScrollRight || !firstRunRef.current) return;
    if (typeof window === 'undefined') return;

    const seenKey = 'navScrollHintSeen.v2';
    if (window.sessionStorage.getItem(seenKey) === 'true') {
      firstRunRef.current = false;
      return;
    }

    firstRunRef.current = false;
    setHintDismissed(false);
    setShowHint(true);
    const timer = window.setTimeout(() => {
      setShowHint(false);
      try {
        window.sessionStorage.setItem(seenKey, 'true');
      } catch {
        /* 忽略存储异常 */
      }
    }, HINT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [canScrollRight, isReordering]);

  // 开始拖动 / 排序后立刻收起提示
  useEffect(() => {
    if (isDragging || isReordering) setShowHint(false);
  }, [isDragging, isReordering]);

  // 激活项自动滚入可视区域（例如直接访问 /douban?type=show）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollIntoViewSelector || isReordering) return;
    const target = el.querySelector<HTMLElement>(scrollIntoViewSelector);
    if (!target) return;

    const elRect = el.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    if (targetRect.left < elRect.left + EDGE_PADDING) {
      el.scrollTo({
        left: el.scrollLeft - (elRect.left - targetRect.left) - EDGE_PADDING,
        behavior: 'smooth',
      });
    } else if (targetRect.right > elRect.right - EDGE_PADDING) {
      el.scrollTo({
        left: el.scrollLeft + (targetRect.right - elRect.right) + EDGE_PADDING,
        behavior: 'smooth',
      });
    }
  }, [activeKey, scrollIntoViewSelector, containerRef, isReordering]);

  return (
    <div
      className={`top-nav__scroll-wrap ${className}`.trim()}
      data-reordering={isReordering}
      data-long-pressing={isLongPressing}
    >
      <div
        ref={containerRef}
        className={`top-nav__scroll scrollbar-hide${
          isDragging ? ' is-dragging' : ''
        }${isReordering ? ' is-reordering' : ''}`}
        onClickCapture={handleClickCapture}
        // 阻止浏览器把菜单项当成可拖拽的链接（否则会拖出链接幽灵图并触发跳转）
        onDragStart={(event) => event.preventDefault()}
        title='拖动可横向查看，长按菜单可调整顺序'
        // 溢出时才给内容加渐隐（mask 实现，不会盖住半透明导航的底色）
        data-fade-left={canScrollLeft && !isReordering}
        data-fade-right={canScrollRight && !isReordering}
      >
        {children}
      </div>

      {/* 悬停时出现的滚动箭头：进一步降低"看不出可拖动"的困惑 */}
      <button
        type='button'
        aria-label='向左滚动菜单'
        tabIndex={-1}
        data-visible={canScrollLeft && !isReordering}
        className='top-nav__scroll-btn top-nav__scroll-btn--left'
        onClick={() => scrollBy(-SCROLL_STEP)}
      >
        <ChevronLeft className='h-3.5 w-3.5' />
      </button>
      <button
        type='button'
        aria-label='向右滚动菜单'
        tabIndex={-1}
        data-visible={canScrollRight && !isReordering}
        className='top-nav__scroll-btn top-nav__scroll-btn--right'
        onClick={() => scrollBy(SCROLL_STEP)}
      >
        <ChevronRight className='h-3.5 w-3.5' />
      </button>

      {/* 首次溢出的操作提示（拖动查看 + 长按排序） */}
      {showHint && !hintDismissed && (
        <div className='top-nav__scroll-hint' role='status'>
          <MousePointer2 className='h-3 w-3' />
          <span>
            <b>拖动</b>横向查看 · <b>长按菜单</b>调整顺序
          </span>
          <button
            type='button'
            className='top-nav__scroll-hint-close'
            aria-label='知道了'
            onClick={() => {
              setShowHint(false);
              setHintDismissed(true);
              try {
                window.sessionStorage.setItem('navScrollHintSeen.v2', 'true');
              } catch {
                /* 忽略存储异常 */
              }
            }}
          >
            知道了
          </button>
        </div>
      )}

      {/* 长按等待中：提示"继续按住即可调整顺序" */}
      {isLongPressing && !isReordering && (
        <div
          className='top-nav__reorder-tip top-nav__reorder-tip--pressing'
          role='status'
        >
          继续按住，可拖动调整顺序
        </div>
      )}

      {/* 排序进行中的状态条 */}
      {isReordering && (
        <div className='top-nav__reorder-tip' role='status'>
          拖到目标位置后松开，即可保存
        </div>
      )}
    </div>
  );
}
