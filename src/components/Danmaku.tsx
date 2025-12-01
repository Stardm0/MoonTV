/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AnimeOption, colorToHex, getDanmakuBySelectedAnime } from '@/lib/danmaku.client';
import { DanmakuItem } from '@/lib/types';

interface DanmakuProps {
  videoTitle: string;
  currentEpisode: number; // 当前集数（从1开始）
  currentEpisodeTitle?: string; // 当前集数标题（从集数选择按钮获取）
  currentTime: number;
  enabled: boolean;
  playerContainer?: HTMLElement | null;
  onSourceSelected?: (sourceName: string) => void;
  density?: number; // 弹幕密度 (0-100)
  maxTracks?: number; // 最大弹幕行数（轨道数），0表示不限制
}

// 弹幕实例接口
interface DanmakuInstance {
  element: HTMLDivElement;
  item: DanmakuItem;
  key: string;
  type: number; // 1-滚动，2-顶部，3-底部
  track: number; // 轨道编号
  startTime: number; // 开始时间（视频时间）
  startTimestamp: number; // 开始时间戳（实际时间，用于平滑动画）
  duration: number; // 持续时间（秒）
  startX: number; // 起始X位置
  startY: number; // 起始Y位置
  endX: number; // 结束X位置
  endY: number; // 结束Y位置
  width: number; // 弹幕宽度
  height: number; // 弹幕高度
  speed: number; // 速度（px/s）
  opacity: number; // 透明度
  isActive: boolean; // 是否激活
}

// 轨道管理器
class TrackManager {
  private tracks: Map<number, DanmakuInstance[]> = new Map(); // 轨道编号 -> 弹幕列表
  private trackHeights: Map<number, number> = new Map(); // 轨道编号 -> 轨道高度
  private containerHeight = 0;
  private minTrackHeight = 30; // 最小轨道高度
  private maxTracks = 0; // 最大轨道数，0表示不限制

  constructor(containerHeight: number, maxTracks = 0) {
    this.containerHeight = containerHeight;
    this.maxTracks = maxTracks;
    this.updateContainerHeight(containerHeight);
  }

  setMaxTracks(maxTracks: number) {
    this.maxTracks = maxTracks;
    this.updateContainerHeight(this.containerHeight);
  }

  updateContainerHeight(height: number) {
    this.containerHeight = height;
    // 计算轨道数量
    let trackCount = Math.floor(height / this.minTrackHeight);
    // 如果设置了最大轨道数，则限制轨道数量
    if (this.maxTracks > 0 && trackCount > this.maxTracks) {
      trackCount = this.maxTracks;
    }
    // 初始化轨道
    for (let i = 0; i < trackCount; i++) {
      if (!this.tracks.has(i)) {
        this.tracks.set(i, []);
      }
      this.trackHeights.set(i, this.minTrackHeight);
    }
    // 移除超出限制的轨道
    const tracksToRemove: number[] = [];
    for (const track of Array.from(this.tracks.keys())) {
      if (track >= trackCount) {
        tracksToRemove.push(track);
      }
    }
    for (const track of tracksToRemove) {
      this.tracks.delete(track);
      this.trackHeights.delete(track);
    }
  }

  // 查找可用轨道（滚动弹幕）
  findAvailableTrack(
    danmakuWidth: number,
    containerWidth: number,
    speed: number,
    currentTimestamp: number
  ): number | null {
    const trackCount = this.tracks.size;
    
    for (let track = 0; track < trackCount; track++) {
      const trackDanmakus = this.tracks.get(track) || [];
      
      // 检查该轨道是否有足够空间
      let hasConflict = false;
      for (const existing of trackDanmakus) {
        if (!existing.isActive) continue;
        
        // 计算现有弹幕的当前位置（使用实际时间戳）
        const elapsed = (currentTimestamp - existing.startTimestamp) / 1000; // 转换为秒
        if (elapsed < 0 || elapsed > existing.duration) continue;
        
        const existingX = existing.startX - existing.speed * elapsed;
        const existingEndX = existingX + existing.width;
        
        // 新弹幕从右侧进入，检查是否会与现有弹幕重叠
        const newStartX = containerWidth;
        const newEndX = newStartX + danmakuWidth;
        
        // 如果新弹幕的结束位置会与现有弹幕重叠，则冲突
        if (newEndX > existingX && newStartX < existingEndX) {
          hasConflict = true;
          break;
        }
      }
      
      if (!hasConflict) {
        return track;
      }
    }
    
    return null;
  }

  // 添加弹幕到轨道
  addToTrack(track: number, instance: DanmakuInstance) {
    if (!this.tracks.has(track)) {
      this.tracks.set(track, []);
    }
    const trackDanmakus = this.tracks.get(track);
    if (trackDanmakus) {
      trackDanmakus.push(instance);
    }
  }

  // 移除弹幕
  removeFromTrack(instance: DanmakuInstance) {
    const trackDanmakus = this.tracks.get(instance.track);
    if (trackDanmakus) {
      const index = trackDanmakus.indexOf(instance);
      if (index > -1) {
        trackDanmakus.splice(index, 1);
      }
    }
  }

  // 清理不活跃的弹幕
  cleanup() {
    for (const [track, danmakus] of Array.from(this.tracks.entries())) {
      this.tracks.set(
        track,
        danmakus.filter((d: DanmakuInstance) => d.isActive)
      );
    }
  }
}

// 对象池
class DanmakuPool {
  private pool: HTMLDivElement[] = [];
  private maxPoolSize = 100;

  get(): HTMLDivElement {
    if (this.pool.length > 0) {
      const element = this.pool.pop();
      if (element) return element;
    }
    const element = document.createElement('div');
    element.className = 'danmaku-item';
    return element;
  }

  release(element: HTMLDivElement) {
    // 重置元素
    element.style.cssText = '';
    element.textContent = '';
    element.removeAttribute('data-key');
    element.removeAttribute('data-type');
    element.removeAttribute('data-track');
    
    if (this.pool.length < this.maxPoolSize) {
      this.pool.push(element);
    } else {
      // 池已满，直接移除
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    }
  }

  clear() {
    this.pool.forEach((el) => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    });
    this.pool = [];
  }
}

/**
 * 弹幕组件
 * 在视频播放器上方显示弹幕
 */
export default function Danmaku({
  videoTitle,
  currentEpisode,
  currentEpisodeTitle: _currentEpisodeTitle,
  currentTime,
  enabled,
  playerContainer,
  onSourceSelected,
  density = 100, // 默认密度100%
  maxTracks = 0, // 默认不限制轨道数
}: DanmakuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [danmakuList, setDanmakuList] = useState<DanmakuItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAnime, setSelectedAnime] = useState<AnimeOption | null>(null);
  const danmakuLoadedRef = useRef(false);
  const displayedDanmakuRef = useRef<Set<string>>(new Set()); // 记录已显示的弹幕
  const originalParentRef = useRef<HTMLElement | null>(null); // 保存原始父容器
  const isInFullscreenRef = useRef(false); // 记录是否在全屏状态
  const lastDanmakuTimeRef = useRef<number>(0); // 上次显示弹幕的时间
  const [maxTracksState, setMaxTracksState] = useState(maxTracks); // 弹幕行数状态
  const lastCurrentTimeRef = useRef<number>(0); // 记录上一次的 currentTime，用于检测回退

  // 核心系统
  const activeInstancesRef = useRef<Map<string, DanmakuInstance>>(new Map());
  const trackManagerRef = useRef<TrackManager | null>(null);
  const poolRef = useRef<DanmakuPool>(new DanmakuPool());
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // 顶部/底部弹幕管理
  const topDanmakusRef = useRef<DanmakuInstance[]>([]);
  const bottomDanmakusRef = useRef<DanmakuInstance[]>([]);
  const topTrackIndexRef = useRef<number>(0);
  const bottomTrackIndexRef = useRef<number>(0);

  // 手动选择的集数（优先级高于 currentEpisode）
  const [manualEpisode, setManualEpisode] = useState<{ number: number; title?: string } | null>(null);

  // 暴露方法给父组件
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // 设置弹幕源
      (window as any).__setDanmakuSource = (anime: AnimeOption) => {
        setSelectedAnime(anime);
        danmakuLoadedRef.current = false;
        setDanmakuList([]);
        displayedDanmakuRef.current.clear();
        onSourceSelected?.(anime.animeTitle);
      };
      // 设置弹幕集数
      (window as any).__setDanmakuEpisode = (episodeNumber: number, episodeTitle?: string) => {
        setManualEpisode({ number: episodeNumber, title: episodeTitle });
        danmakuLoadedRef.current = false;
        setDanmakuList([]);
        displayedDanmakuRef.current.clear();
        // 重置弹幕显示时间，确保切换集数后弹幕从正确的时间开始显示
        lastDanmakuTimeRef.current = 0;
        lastCurrentTimeRef.current = 0;
      };
      // 获取当前弹幕源
      (window as any).__getDanmakuSource = () => {
        return selectedAnime;
      };
      // 设置弹幕行数
      (window as any).__setDanmakuMaxTracks = (tracks: number) => {
        setMaxTracksState(tracks);
      };
      // 获取当前弹幕行数
      (window as any).__getDanmakuMaxTracks = () => {
        return maxTracksState;
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as any).__setDanmakuSource;
        delete (window as any).__setDanmakuEpisode;
        delete (window as any).__getDanmakuSource;
        delete (window as any).__setDanmakuMaxTracks;
        delete (window as any).__getDanmakuMaxTracks;
      }
    };
  }, [videoTitle, selectedAnime, onSourceSelected, maxTracksState]);

  // 确定实际使用的集数（手动选择优先）
  const actualEpisode = manualEpisode?.number || currentEpisode;

  // 加载弹幕数据
  useEffect(() => {
    if (!selectedAnime || !actualEpisode || !enabled || danmakuLoadedRef.current) return;

    const loadDanmaku = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getDanmakuBySelectedAnime(selectedAnime, actualEpisode);
        setDanmakuList(data);
        danmakuLoadedRef.current = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('加载弹幕失败:', err);
        setError(err instanceof Error ? err.message : '加载弹幕失败');
      } finally {
        setLoading(false);
      }
    };

    loadDanmaku();
  }, [selectedAnime, actualEpisode, enabled]);

  // 当集数变化时，重新加载弹幕（如果未手动选择集数）
  useEffect(() => {
    if (selectedAnime && currentEpisode && !manualEpisode) {
      danmakuLoadedRef.current = false;
      setDanmakuList([]);
      displayedDanmakuRef.current.clear();
      // 重置弹幕显示时间，确保切换集数后弹幕从正确的时间开始显示
      lastDanmakuTimeRef.current = 0;
      lastCurrentTimeRef.current = 0;
    }
  }, [currentEpisode, selectedAnime, manualEpisode]);

  // 错误提示在3秒后自动消失
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        setError(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // 初始化轨道管理器
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const height = container.offsetHeight || 400;
    trackManagerRef.current = new TrackManager(height, maxTracksState);
  }, [maxTracksState]);

  // 当 maxTracksState 变化时，更新轨道管理器
  useEffect(() => {
    if (trackManagerRef.current) {
      trackManagerRef.current.setMaxTracks(maxTracksState);
    }
  }, [maxTracksState]);

  // 当外部传入的 maxTracks 变化时，同步到状态
  useEffect(() => {
    setMaxTracksState(maxTracks);
  }, [maxTracks]);

  // 组件挂载时，确保应用初始的 maxTracks 值
  useEffect(() => {
    if (maxTracksState > 0 && trackManagerRef.current) {
      trackManagerRef.current.setMaxTracks(maxTracksState);
    }
  }, []);

  // 创建弹幕实例
  const createDanmakuInstance = useCallback((
    item: DanmakuItem,
    container: HTMLDivElement,
    track?: number
  ): DanmakuInstance | null => {
    const key = `${item.time}-${item.text}`;
    if (displayedDanmakuRef.current.has(key)) return null;

    const element = poolRef.current.get();
    element.textContent = item.text;
    element.setAttribute('data-key', key);
    element.setAttribute('data-type', String(item.type));

    const color = colorToHex(item.color);
    const fontSize = item.size || 25;
    const containerWidth = container.offsetWidth;
    const containerHeight = container.offsetHeight;

    // 基础样式
    element.style.cssText = `
      position: absolute;
      color: ${color};
      font-size: ${fontSize}px;
      font-weight: bold;
      white-space: nowrap;
      pointer-events: none;
      text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
      z-index: 1000;
      user-select: none;
      will-change: transform, opacity;
    `;

    container.appendChild(element);

    // 获取实际尺寸
    const width = element.offsetWidth;
    const height = element.offsetHeight;

    let instance: DanmakuInstance;

    if (item.type === 1) {
      // 滚动弹幕
      const speed = 100; // px/s
      const duration = (containerWidth + width) / speed;
      const y = track !== undefined && track !== null
        ? track * 30 + 15
        : Math.random() * (containerHeight - height - 20) + 10;

      instance = {
        element,
        item,
        key,
        type: 1,
        track: track ?? -1,
        startTime: currentTime,
        startTimestamp: performance.now(), // 记录实际开始时间戳
        duration,
        startX: containerWidth,
        startY: y,
        endX: -width,
        endY: y,
        width,
        height,
        speed,
        opacity: 1,
        isActive: true,
      };

      element.setAttribute('data-track', String(instance.track));
      element.style.transform = `translate(${containerWidth}px, ${y}px)`;
    } else if (item.type === 2) {
      // 顶部弹幕
      const trackIndex = topTrackIndexRef.current;
      const y = 10 + trackIndex * 35;
      topTrackIndexRef.current = (trackIndex + 1) % 5; // 最多5条同时显示

      instance = {
        element,
        item,
        key,
        type: 2,
        track: -1,
        startTime: currentTime,
        startTimestamp: performance.now(), // 记录实际开始时间戳
        duration: 3.5,
        startX: containerWidth / 2,
        startY: y,
        endX: containerWidth / 2,
        endY: y,
        width,
        height,
        speed: 0,
        opacity: 1,
        isActive: true,
      };

      element.style.textAlign = 'center';
      element.style.transform = `translate(-50%, ${y}px)`;
      element.style.left = '50%';
      topDanmakusRef.current.push(instance);
    } else if (item.type === 3) {
      // 底部弹幕
      const trackIndex = bottomTrackIndexRef.current;
      const y = containerHeight - 10 - (trackIndex * 35) - height;
      bottomTrackIndexRef.current = (trackIndex + 1) % 5; // 最多5条同时显示

      instance = {
        element,
        item,
        key,
        type: 3,
        track: -1,
        startTime: currentTime,
        startTimestamp: performance.now(), // 记录实际开始时间戳
        duration: 3.5,
        startX: containerWidth / 2,
        startY: y,
        endX: containerWidth / 2,
        endY: y,
        width,
        height,
        speed: 0,
        opacity: 1,
        isActive: true,
      };

      element.style.textAlign = 'center';
      element.style.transform = `translate(-50%, ${y}px)`;
      element.style.left = '50%';
      bottomDanmakusRef.current.push(instance);
    } else {
      poolRef.current.release(element);
      return null;
    }

    displayedDanmakuRef.current.add(key);
    activeInstancesRef.current.set(key, instance);

    return instance;
  }, [currentTime]);

  // RAF 动画循环
  const animate = useCallback(() => {
    if (!containerRef.current) {
      rafIdRef.current = null;
      return;
    }

    const now = performance.now();
    lastFrameTimeRef.current = now;

    const container = containerRef.current;
    const containerHeight = container.offsetHeight;

    // 更新轨道管理器容器高度
    if (trackManagerRef.current) {
      trackManagerRef.current.updateContainerHeight(containerHeight);
    }

    // 如果弹幕开关关闭，只更新弹幕显示状态，不执行动画
    if (!enabled) {
      // 将所有弹幕设置为隐藏状态
      for (const instance of Array.from(activeInstancesRef.current.values())) {
        if (instance.isActive) {
          instance.element.style.opacity = '0';
        }
      }
      rafIdRef.current = requestAnimationFrame(animate);
      return;
    }

    // 弹幕开关开启时，执行正常动画
    const instancesToRemove: string[] = [];

    for (const [key, instance] of Array.from(activeInstancesRef.current.entries())) {
      if (!instance.isActive) {
        instancesToRemove.push(key);
        continue;
      }

      // 使用实际时间戳计算经过的时间，确保动画平滑
      const elapsed = (now - instance.startTimestamp) / 1000; // 转换为秒

      // 检查视频时间是否到达弹幕显示时间
      const videoElapsed = currentTime - instance.startTime;
      if (videoElapsed < 0) {
        // 还未到显示时间，隐藏弹幕
        instance.element.style.opacity = '0';
        continue;
      }
      
      // 如果弹幕已经显示过但当前时间回退到弹幕显示时间之前，重新显示
      if (videoElapsed >= 0 && instance.element.style.opacity === '0') {
        instance.element.style.opacity = String(instance.opacity);
      }

      if (elapsed > instance.duration) {
        // 超过持续时间，标记为不活跃
        instancesToRemove.push(key);
        continue;
      }

      instance.element.style.opacity = String(instance.opacity);

      if (instance.type === 1) {
        // 滚动弹幕 - 使用实际时间戳计算位置，确保平滑
        const progress = elapsed / instance.duration;
        const x = instance.startX - (instance.startX - instance.endX) * progress;
        instance.element.style.transform = `translate(${x}px, ${instance.startY}px)`;
      } else if (instance.type === 2 || instance.type === 3) {
        // 顶部/底部弹幕 - 淡出效果
        if (elapsed > instance.duration - 0.5) {
          const fadeProgress = (elapsed - (instance.duration - 0.5)) / 0.5;
          instance.opacity = 1 - fadeProgress;
          instance.element.style.opacity = String(instance.opacity);
        }
      }
    }

    // 清理不活跃的弹幕
    for (const key of instancesToRemove) {
      const instance = activeInstancesRef.current.get(key);
      if (instance) {
        instance.isActive = false;
        if (instance.type === 1 && trackManagerRef.current) {
          trackManagerRef.current.removeFromTrack(instance);
        }
        poolRef.current.release(instance.element);
        activeInstancesRef.current.delete(key);
      }
    }

    // 清理顶部/底部弹幕数组
    topDanmakusRef.current = topDanmakusRef.current.filter((d) => d.isActive);
    bottomDanmakusRef.current = bottomDanmakusRef.current.filter((d) => d.isActive);

    // 清理轨道
    if (trackManagerRef.current) {
      trackManagerRef.current.cleanup();
    }

    rafIdRef.current = requestAnimationFrame(animate);
  }, [currentTime, enabled]);

  // 启动/停止动画循环
  useEffect(() => {
    if (containerRef.current) {
      lastFrameTimeRef.current = performance.now();
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(animate);
      }
    } else {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    }

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [animate]);

  // 显示弹幕
  useEffect(() => {
    if (!containerRef.current || loading || !trackManagerRef.current) return;

    // 如果弹幕开关关闭，不创建新弹幕，但保留现有弹幕
    if (!enabled) return;

    const container = containerRef.current;
    if (!container.parentElement) {
      return;
    }

    const currentSecond = Math.floor(currentTime);

    // 检测是否是回退操作
    const isSeekingBackward = currentTime < lastCurrentTimeRef.current;
    lastCurrentTimeRef.current = currentTime;

    // 根据密度计算显示间隔
    const displayInterval = density > 0 ? Math.max(0.5, 100 / density) : Infinity;
    const timeSinceLastDanmaku = currentTime - lastDanmakuTimeRef.current;

    // 如果是回退操作，强制显示弹幕，不受显示间隔限制
    if (!isSeekingBackward && timeSinceLastDanmaku < displayInterval) {
      return;
    }

    // 检查滚动弹幕数量
    const scrollCount = Array.from(activeInstancesRef.current.values()).filter(
      (d) => d.type === 1 && d.isActive
    ).length;

    const maxConcurrent = Math.max(5, Math.floor((density / 100) * 50));
    if (!isSeekingBackward && scrollCount >= maxConcurrent) {
      return;
    }

    // 获取当前时间应该显示的弹幕
    const timeWindow = Math.max(1, Math.ceil(displayInterval));
    let currentDanmaku = danmakuList.filter(
      (item) => Math.floor(item.time) >= currentSecond && Math.floor(item.time) < currentSecond + timeWindow
    );

    // 当进度条向左移动时，重新显示之前时间段的弹幕
    if (isSeekingBackward) {
      // 清除当前时间之后的所有弹幕，因为它们还没有到达显示时间
      for (const [key, instance] of Array.from(activeInstancesRef.current.entries())) {
        if (instance.startTime > currentTime) {
          instance.isActive = false;
          if (instance.type === 1 && trackManagerRef.current) {
            trackManagerRef.current.removeFromTrack(instance);
          }
          poolRef.current.release(instance.element);
          activeInstancesRef.current.delete(key);
          displayedDanmakuRef.current.delete(key);
        }
      }
      
      // 重新获取当前时间段的弹幕，允许之前显示过的弹幕重新显示
      // 清除当前时间段的已显示记录，让它们可以重新显示
      for (const item of danmakuList) {
        if (Math.floor(item.time) === currentSecond) {
          const key = `${item.time}-${item.text}`;
          displayedDanmakuRef.current.delete(key);
        }
      }
      
      // 重新获取当前时间段的弹幕
      currentDanmaku = danmakuList.filter(
        (item) => Math.floor(item.time) === currentSecond
      );
    }

    // 根据密度过滤
    if (currentDanmaku.length > 0) {
      const remainingCapacity = maxConcurrent - scrollCount;
      const densityBasedCount = Math.ceil((currentDanmaku.length * density) / 100);
      const targetCount = Math.min(remainingCapacity, densityBasedCount, 3);

      const shuffled = [...currentDanmaku].sort(() => Math.random() - 0.5);
      currentDanmaku = shuffled.slice(0, targetCount);
    }

    if (currentDanmaku.length === 0) {
      return;
    }

    lastDanmakuTimeRef.current = currentTime;

    const containerWidth = container.offsetWidth;
    const speed = 100; // px/s

    // 创建弹幕实例
    for (const item of currentDanmaku) {
      const key = `${item.time}-${item.text}`;
      if (displayedDanmakuRef.current.has(key)) continue;
      if (activeInstancesRef.current.has(key)) continue;

      if (item.type === 1) {
        // 滚动弹幕 - 使用轨道算法
        // 先创建临时元素测量宽度
        const tempEl = document.createElement('div');
        tempEl.style.cssText = `
          position: absolute;
          visibility: hidden;
          white-space: nowrap;
          font-size: ${item.size || 25}px;
          font-weight: bold;
        `;
        tempEl.textContent = item.text;
        document.body.appendChild(tempEl);
        const width = tempEl.offsetWidth;
        document.body.removeChild(tempEl);

        const track = trackManagerRef.current.findAvailableTrack(
          width,
          containerWidth,
          speed,
          performance.now() // 使用实际时间戳
        );

        if (track !== null) {
          const instance = createDanmakuInstance(item, container, track);
          if (instance) {
            trackManagerRef.current.addToTrack(track, instance);
          }
        }
      } else {
        // 顶部/底部弹幕
        createDanmakuInstance(item, container);
      }
    }
  }, [currentTime, danmakuList, enabled, loading, density, createDanmakuInstance]);

  // 当密度变化时，重置显示间隔
  useEffect(() => {
    lastDanmakuTimeRef.current = 0;
  }, [density]);

  // 重置弹幕加载状态当视频标题变化时
  useEffect(() => {
    danmakuLoadedRef.current = false;
    setDanmakuList([]);
    setError(null);
    setSelectedAnime(null);
    displayedDanmakuRef.current.clear();
    
    // 清理所有弹幕
    for (const instance of Array.from(activeInstancesRef.current.values())) {
      instance.isActive = false;
      poolRef.current.release(instance.element);
    }
    activeInstancesRef.current.clear();
    topDanmakusRef.current = [];
    bottomDanmakusRef.current = [];
  }, [videoTitle]);

  // 清理资源
  useEffect(() => {
    return () => {
      // 停止动画
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      
      // 清理所有弹幕
      for (const instance of Array.from(activeInstancesRef.current.values())) {
        instance.isActive = false;
        poolRef.current.release(instance.element);
      }
      activeInstancesRef.current.clear();
      
      // 清理对象池
      poolRef.current.clear();
    };
  }, []);

  // 将弹幕容器挂载到播放器容器
  useEffect(() => {
    if (!containerRef.current || !playerContainer) return;

    const container = containerRef.current;

    if (container.parentElement !== playerContainer) {
      if (container.parentElement && !originalParentRef.current) {
        originalParentRef.current = container.parentElement;
      }
      playerContainer.appendChild(container);
    }
  }, [playerContainer]);

  // 处理全屏状态变化（优化版）
  useEffect(() => {
    if (!containerRef.current || !playerContainer) return;

    const container = containerRef.current;
    let checkTimeout: NodeJS.Timeout | null = null;
    
    const checkAndMoveContainer = () => {
      const isBrowserFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );

      const artFullscreen = document.querySelector('.art-fullscreen') as HTMLElement;
      const artFullscreenWeb = document.querySelector('.art-fullscreen-web') as HTMLElement;
      
      const fullscreenContainer = artFullscreenWeb || artFullscreen;
      const isInFullscreen = !!(fullscreenContainer || isBrowserFullscreen);

      if (isInFullscreen && fullscreenContainer && !isInFullscreenRef.current) {
        if (container.parentElement && container.parentElement !== fullscreenContainer) {
          originalParentRef.current = container.parentElement;
        }
        
        const playerInFullscreen = fullscreenContainer.querySelector('.artplayer') as HTMLElement ||
          fullscreenContainer.querySelector('[data-media-provider]') as HTMLElement ||
          fullscreenContainer;
        
        if (playerInFullscreen && container.parentElement !== playerInFullscreen) {
          const currentPosition = window.getComputedStyle(playerInFullscreen).position;
          if (currentPosition === 'static') {
            playerInFullscreen.style.position = 'relative';
          }
          playerInFullscreen.appendChild(container);
          isInFullscreenRef.current = true;
          
          // 更新轨道管理器
          if (trackManagerRef.current) {
            trackManagerRef.current.updateContainerHeight(playerInFullscreen.offsetHeight);
          }
        }
      } else if (!isInFullscreen && isInFullscreenRef.current) {
        if (originalParentRef.current && container.parentElement) {
          originalParentRef.current.appendChild(container);
          originalParentRef.current = null;
          isInFullscreenRef.current = false;
          
          // 更新轨道管理器
          if (trackManagerRef.current) {
            trackManagerRef.current.updateContainerHeight(container.offsetHeight);
          }
        } else if (playerContainer && container.parentElement !== playerContainer) {
          playerContainer.appendChild(container);
          isInFullscreenRef.current = false;
          
          // 更新轨道管理器
          if (trackManagerRef.current) {
            trackManagerRef.current.updateContainerHeight(container.offsetHeight);
          }
        }
      }
    };

    const handleFullscreenChange = () => {
      if (checkTimeout) {
        clearTimeout(checkTimeout);
      }
      checkTimeout = setTimeout(checkAndMoveContainer, 100);
    };

    // 监听全屏事件
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    // 使用 ResizeObserver 监听容器尺寸变化
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && trackManagerRef.current) {
        trackManagerRef.current.updateContainerHeight(containerRef.current.offsetHeight);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    // 使用 MutationObserver 监听页面全屏
    let mutationTimeout: NodeJS.Timeout | null = null;
    const observer = new MutationObserver((mutations) => {
      const hasRelevantChange = mutations.some((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const target = mutation.target as HTMLElement;
          return target.classList.contains('art-fullscreen-web') || 
                 target.classList.contains('art-fullscreen') ||
                 target.querySelector('.art-fullscreen-web') ||
                 target.querySelector('.art-fullscreen');
        }
        if (mutation.type === 'childList') {
          return Array.from(mutation.addedNodes).some((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              return el.classList.contains('art-fullscreen-web') ||
                     el.classList.contains('art-fullscreen') ||
                     el.querySelector('.art-fullscreen-web') ||
                     el.querySelector('.art-fullscreen');
            }
            return false;
          });
        }
        return false;
      });

      if (hasRelevantChange) {
        if (mutationTimeout) {
          clearTimeout(mutationTimeout);
        }
        mutationTimeout = setTimeout(handleFullscreenChange, 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    setTimeout(checkAndMoveContainer, 200);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      observer.disconnect();
      resizeObserver.disconnect();
      if (checkTimeout) clearTimeout(checkTimeout);
      if (mutationTimeout) clearTimeout(mutationTimeout);
    };
  }, [playerContainer]);

  return (
    <>
      {/* 弹幕显示容器 */}
      <div
        ref={containerRef}
        className="danmaku-container"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'hidden',
          // 容器始终存在，弹幕开关只控制弹幕动画的显示与隐藏
        }}
      >
        {error && (
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              color: '#ff4444',
              fontSize: '12px',
              background: 'rgba(0, 0, 0, 0.6)',
              padding: '4px 8px',
              borderRadius: '4px',
            }}
          >
            弹幕加载失败
          </div>
        )}
      </div>
    </>
  );
}
