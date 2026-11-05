'use client';

import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** 长按多久进入「调整顺序」模式（ms） */
const LONG_PRESS_MS = 420;
/** 长按判定期间允许的抖动位移（px），超过则视为拖拽滚动 */
const MOVE_TOLERANCE_PX = 6;
/** 超过该位移才认为是拖拽滚动（px），否则视为点击 */
const DRAG_THRESHOLD_PX = 5;
/** 拖拽/排序结束后屏蔽紧随其后的 click（ms） */
const CLICK_SUPPRESS_MS = 300;
/** 排序时的边缘自动滚动热区（px） */
const EDGE_SCROLL_ZONE_PX = 28;
/** 排序时的边缘自动滚动步进（px / 帧） */
const EDGE_SCROLL_STEP_PX = 10;
/** 排序时拖动幽灵的缩放比例 */
const GHOST_LIFT_SCALE = 1.06;

type Mode = 'idle' | 'pending' | 'scroll' | 'reorder';

interface InteractionState {
  mode: Mode;
  pointerId: number | null;
  startX: number;
  startY: number;
  lastX: number;
  startScrollLeft: number;
  timer: number | null;
  /** 长按命中的可排序元素 */
  source: HTMLElement | null;
  /** 跟随指针的克隆幽灵 */
  ghost: HTMLElement | null;
  ghostRect: DOMRect | null;
  autoScrollDir: -1 | 0 | 1;
}

const createState = (): InteractionState => ({
  mode: 'idle',
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  startScrollLeft: 0,
  timer: null,
  source: null,
  ghost: null,
  ghostRect: null,
  autoScrollDir: 0,
});

interface UseDragScrollOptions {
  /** 顺序调整完成后回调新的 key 顺序 */
  onReorder?: (order: string[]) => void;
  /** 可排序项的属性选择器 */
  itemSelector?: string;
  /** 记录顺序用的 data 属性名 */
  keyAttribute?: string;
}

/**
 * 导航菜单横向滚动容器的交互能力：
 *
 * 1. 鼠标 / 触控笔「按住拖动」→ 横向滚动；
 * 2. 「长按菜单项」→ 进入调整顺序模式（不与滚动拖拽冲突：长按期间一旦明显移动就转为滚动）；
 * 3. 触屏保留原生横向滑动，长按同样可排序；
 * 4. 暴露左右溢出状态，供渐隐遮罩/箭头提示"可以拖动"。
 */
export default function useDragScroll<T extends HTMLElement = HTMLDivElement>({
  onReorder,
  itemSelector = '[data-nav-key]',
  keyAttribute = 'data-nav-key',
}: UseDragScrollOptions = {}) {
  const containerRef = useRef<T | null>(null);
  const stateRef = useRef<InteractionState>(createState());
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);
  const autoScrollTimerRef = useRef<number | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const [isDragging, setIsDragging] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  /** 长按计时中（已按住但还没到长按时长），用于给用户"继续按住"的反馈 */
  const [isLongPressing, setIsLongPressing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    const threshold = 1; // 容差，避免浮点误差导致提示闪烁
    setCanScrollLeft(scrollLeft > threshold);
    setCanScrollRight(
      maxScroll > threshold && scrollLeft < maxScroll - threshold
    );
  }, []);

  /* ========== 溢出状态监听（尺寸 / 内容 / 滚动） ========== */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const scheduleUpdate = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updateScrollState();
      });
    };

    scheduleUpdate();
    el.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    resizeObserver?.observe(el);
    // 内层内容宽度变化（菜单项增减、字体加载完成）也要重新判断
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) resizeObserver?.observe(inner);

    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(scheduleUpdate)
        : null;
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      el.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [updateScrollState]);

  /* ========== 指针交互 ========== */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const state = stateRef.current;

    const queryItems = () =>
      Array.from(el.querySelectorAll<HTMLElement>(itemSelector));

    const clearLongPressTimer = () => {
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
    };

    const clearSuppressTimer = () => {
      if (suppressTimerRef.current !== null) {
        window.clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = null;
      }
    };

    const suppressNextClick = () => {
      suppressClickRef.current = true;
      clearSuppressTimer();
      suppressTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressTimerRef.current = null;
      }, CLICK_SUPPRESS_MS);
    };

    /* ---------- 排序：幽灵 + 目标位移 ---------- */
    const createGhost = (source: HTMLElement) => {
      const rect = source.getBoundingClientRect();
      const ghost = source.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-nav-key');
      ghost.removeAttribute('tabindex');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('top-nav__reorder-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      document.body.appendChild(ghost);
      state.ghost = ghost;
      state.ghostRect = rect;
    };

    const removeGhost = () => {
      state.ghost?.remove();
      state.ghost = null;
      state.ghostRect = null;
    };

    const moveGhost = (clientX: number) => {
      const ghost = state.ghost;
      const rect = state.ghostRect;
      if (!ghost || !rect) return;
      const dx = clientX - state.startX;
      const maxLeft = window.innerWidth - rect.width - 4;
      const left = Math.min(Math.max(4, rect.left + dx), Math.max(4, maxLeft));
      ghost.style.transform = `translate3d(${
        left - rect.left
      }px, 0, 0) scale(${GHOST_LIFT_SCALE})`;
    };

    /** 依据指针位置把 source 插到合适的位置（带 FLIP 过渡） */
    const updateReorderTarget = (clientX: number) => {
      const source = state.source;
      const parent = source?.parentElement;
      if (!source || !parent) return;

      const items = queryItems().filter(
        (item) => item.parentElement === parent
      );
      if (items.length < 2) return;

      let reference: HTMLElement | null = null;
      for (const item of items) {
        if (item === source) continue;
        const rect = item.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          reference = item;
          break;
        }
      }

      const nextSibling = reference ?? null;
      const currentNext = source.nextElementSibling as HTMLElement | null;
      if (nextSibling === currentNext) return;
      if (!nextSibling && !currentNext) return;
      if (nextSibling && currentNext === nextSibling) return;

      const beforeRects = new Map<HTMLElement, DOMRect>();
      items.forEach((item) => {
        if (item !== source)
          beforeRects.set(item, item.getBoundingClientRect());
      });

      if (nextSibling) {
        parent.insertBefore(source, nextSibling);
      } else {
        parent.appendChild(source);
      }

      // FLIP：让兄弟项平滑让位，避免生硬跳变
      beforeRects.forEach((before, item) => {
        const after = item.getBoundingClientRect();
        const dx = before.left - after.left;
        if (Math.abs(dx) < 1) return;
        if (typeof item.animate !== 'function') return;
        item.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
          { duration: 170, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' }
        );
      });
    };

    /* ---------- 排序：边缘自动滚动 ---------- */
    const stopAutoScroll = () => {
      if (autoScrollTimerRef.current !== null) {
        window.clearInterval(autoScrollTimerRef.current);
        autoScrollTimerRef.current = null;
      }
      state.autoScrollDir = 0;
    };

    const startAutoScroll = (dir: -1 | 1) => {
      if (state.autoScrollDir === dir) return;
      stopAutoScroll();
      state.autoScrollDir = dir;
      autoScrollTimerRef.current = window.setInterval(() => {
        const container = containerRef.current;
        if (!container) return;
        container.scrollLeft += dir * EDGE_SCROLL_STEP_PX;
        updateReorderTarget(state.lastX);
      }, 16);
    };

    const updateAutoScroll = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + EDGE_SCROLL_ZONE_PX) {
        startAutoScroll(-1);
      } else if (clientX > rect.right - EDGE_SCROLL_ZONE_PX) {
        startAutoScroll(1);
      } else {
        stopAutoScroll();
      }
    };

    /* ---------- 长按等待的视觉反馈 ---------- */
    const markPressed = (source: HTMLElement) => {
      source.classList.add('top-nav__longpress');
      setIsLongPressing(true);
    };

    const clearPressed = () => {
      state.source?.classList.remove('top-nav__longpress');
      // 兜底：清掉可能残留的进度环
      containerRef.current
        ?.querySelectorAll('.top-nav__longpress')
        .forEach((node) => node.classList.remove('top-nav__longpress'));
      setIsLongPressing(false);
    };

    /* ---------- 进入排序模式 ---------- */
    const enterReorder = () => {
      const source = state.source;
      if (!source) return;
      state.mode = 'reorder';
      clearPressed();
      source.classList.add('top-nav__reorder-source');
      document.documentElement.classList.add('top-nav__is-reordering');
      createGhost(source);
      setIsReordering(true);
      updateScrollState();
      // 移动端轻微震动反馈，告诉用户"已拿起"
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate?.(12);
        } catch {
          /* 忽略不支持振动的环境 */
        }
      }
    };

    const finishInteraction = () => {
      clearLongPressTimer();
      clearPressed();
      stopAutoScroll();

      const wasReorder = state.mode === 'reorder';
      const wasScroll = state.mode === 'scroll';

      if (wasReorder) {
        state.source?.classList.remove('top-nav__reorder-source');
        document.documentElement.classList.remove('top-nav__is-reordering');
        removeGhost();
        setIsReordering(false);

        const keys = queryItems()
          .map((item) => item.getAttribute(keyAttribute))
          .filter((key): key is string => !!key);
        if (keys.length > 0) onReorderRef.current?.(keys);
        suppressNextClick();
      }

      if (wasScroll) {
        suppressNextClick();
        setIsDragging(false);
      }

      state.mode = 'idle';
      state.pointerId = null;
      state.source = null;
      updateScrollState();
    };

    /* ---------- 指针事件 ---------- */
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      stopAutoScroll();
      clearLongPressTimer();

      const target = event.target as HTMLElement | null;
      const itemEl = target?.closest<HTMLElement>(itemSelector) ?? null;
      const inside = itemEl && el.contains(itemEl) ? itemEl : null;

      const canScroll = el.scrollWidth - el.clientWidth > 1;
      if (!canScroll && !inside) return;

      state.mode = 'pending';
      state.pointerId = event.pointerId;
      state.startX = event.clientX;
      state.startY = event.clientY;
      state.lastX = event.clientX;
      state.startScrollLeft = el.scrollLeft;
      state.source = inside;

      if (inside) {
        // 长按 → 进入调整顺序（触屏与鼠标一致）
        markPressed(inside);
        state.timer = window.setTimeout(() => {
          state.timer = null;
          if (state.mode !== 'pending') return;
          enterReorder();
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (state.mode === 'idle') return;
      if (state.pointerId !== null && event.pointerId !== state.pointerId)
        return;

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      state.lastX = event.clientX;

      /* ---- 排序中 ---- */
      if (state.mode === 'reorder') {
        event.preventDefault();
        moveGhost(event.clientX);
        updateReorderTarget(event.clientX);
        updateAutoScroll(event.clientX);
        return;
      }

      /* ---- 长按等待中 ---- */
      if (state.mode === 'pending') {
        if (
          Math.abs(dx) < MOVE_TOLERANCE_PX &&
          Math.abs(dy) < MOVE_TOLERANCE_PX
        ) {
          return;
        }
        clearLongPressTimer();
        clearPressed();
        // 触屏：交给浏览器原生横向滑动，不接管
        if (event.pointerType === 'touch' || !state.source) {
          state.mode = 'idle';
          return;
        }
        if (Math.abs(dy) > Math.abs(dx)) {
          // 纵向手势不是水平滚动的意图
          state.mode = 'idle';
          return;
        }
        state.mode = 'scroll';
        setIsDragging(true);
      }

      /* ---- 拖动滚动 ---- */
      if (state.mode === 'scroll') {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        el.scrollLeft = state.startScrollLeft - dx;
        event.preventDefault();
      }
    };

    const onPointerUp = () => {
      if (state.mode === 'idle') return;
      finishInteraction();
    };

    const onPointerCancel = () => {
      if (state.mode === 'idle') return;
      finishInteraction();
    };

    // 触屏：排序中阻止页面/容器滚动，其余情况保留原生滑动
    const onTouchMove = (event: TouchEvent) => {
      if (state.mode === 'reorder' && event.cancelable) {
        event.preventDefault();
      }
    };

    // 长按结束后浏览器可能弹出上下文菜单，排序中需要屏蔽
    const onContextMenu = (event: Event) => {
      if (state.mode === 'reorder') event.preventDefault();
    };

    // 长按等待期间避免选中文本
    const onSelectStart = (event: Event) => {
      if (state.mode !== 'idle') event.preventDefault();
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('selectstart', onSelectStart);

    return () => {
      clearLongPressTimer();
      clearPressed();
      clearSuppressTimer();
      stopAutoScroll();
      removeGhost();
      document.documentElement.classList.remove('top-nav__is-reordering');
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('selectstart', onSelectStart);
    };
  }, [itemSelector, keyAttribute, updateScrollState]);

  /** 按距离平滑滚动（供左右提示按钮使用） */
  const scrollBy = useCallback((distance: number) => {
    containerRef.current?.scrollBy({ left: distance, behavior: 'smooth' });
  }, []);

  /** 捕获阶段拦截"拖拽/排序结束后的点击"，避免误触发链接跳转 */
  const handleClickCapture = useCallback((event: ReactMouseEvent<T>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    containerRef,
    isDragging,
    isReordering,
    /** 已按住菜单项、正在等待长按判定完成 */
    isLongPressing,
    canScrollLeft,
    canScrollRight,
    scrollBy,
    handleClickCapture,
    updateScrollState,
  };
}
