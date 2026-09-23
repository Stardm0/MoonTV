/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */

/**
 * 官方插件在 config({ fontSize }) 时会 reset()，把正在飞的弹幕全部清掉重排。
 * 这里跳过 reset，已上屏弹幕保持原样；新弹幕用新字号。
 * 字号仅在停止拖动（pointerup）时应用到弹幕并写入本地；拖动过程中滑条数字仍会变。
 * 不透明度拖动时仍即时生效，写入本地延迟 160ms。
 *
 * 官方 getDanmuTop 在找不到等高空隙时，会把新弹幕塞进旧弹幕的 top。
 * 字号变大后轨道实际变高，仍用旧 top 就会压到下一行。因此拦截 postMessage，
 * 按当前弹幕高度重算轨道数，只有整条轨道空闲（或滚动弹幕同轨且不会追上）才占用。
 */

type VisibleDanmu = {
  top: number;
  height: number;
  right: number;
  speed: number;
  distance: number;
  time: number;
  mode: number;
};

type DanmuTopTarget = {
  mode: number;
  height: number;
  speed: number;
};

function isDanmukuInstance(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object') return false;
  const inst = value as Record<string, any>;
  return (
    Array.isArray(inst.queue) &&
    inst.states &&
    inst.$danmuku &&
    typeof inst.config === 'function' &&
    typeof inst.makeWait === 'function' &&
    typeof inst.filter === 'function'
  );
}

function verticalOverlap(
  top: number,
  height: number,
  item: VisibleDanmu
): boolean {
  return item.top < top + height && item.top + item.height > top;
}

/** 与官方一致：滚动弹幕同轨时，判断后发的会不会追上前面的 */
function canShareScrollLane(
  target: DanmuTopTarget,
  item: VisibleDanmu,
  clientWidth: number
): boolean {
  if (clientWidth < item.distance) return false;
  if (target.speed < item.speed) return true;
  const speedDiff = target.speed - item.speed;
  if (speedDiff <= 0) return true;
  return item.right / speedDiff > item.time;
}

function isLaneBlocked(
  top: number,
  target: DanmuTopTarget,
  visibles: VisibleDanmu[],
  clientWidth: number,
  antiOverlap: boolean
): boolean {
  for (let i = 0; i < visibles.length; i += 1) {
    const item = visibles[i];
    if (item.mode !== target.mode) continue;
    if (!verticalOverlap(top, target.height, item)) continue;

    // 不同起点的弹幕落在新轨道高度内：一定纵向重叠，不能占用
    const sameRow = Math.abs(item.top - top) < 1;
    if (!sameRow) return true;

    if (target.mode !== 0) return true;
    if (antiOverlap && !canShareScrollLane(target, item, clientWidth)) {
      return true;
    }
  }
  return false;
}

function computeDanmuTop(payload: {
  target: DanmuTopTarget;
  visibles?: VisibleDanmu[];
  antiOverlap?: boolean;
  clientWidth: number;
  clientHeight: number;
  marginBottom: number;
  marginTop: number;
}): number | undefined {
  const {
    target,
    visibles = [],
    antiOverlap = true,
    clientWidth,
    clientHeight,
    marginBottom,
    marginTop,
  } = payload;

  const height = Math.max(1, Number(target.height) || 0);
  const minTop = Math.max(0, marginTop);
  const maxBottom = Math.max(minTop, clientHeight - marginBottom);
  const usable = maxBottom - minTop;

  const tryLane = (top: number) =>
    !isLaneBlocked(top, target, visibles, clientWidth, antiOverlap);

  if (height > usable) {
    const top = target.mode === 2 ? maxBottom - height : minTop;
    return tryLane(top) ? top : undefined;
  }

  const laneCount = Math.max(1, Math.floor(usable / height));

  if (target.mode === 2) {
    for (let i = 0; i < laneCount; i += 1) {
      const top = maxBottom - height * (i + 1);
      if (top < minTop) continue;
      if (tryLane(top)) return top;
    }
    return undefined;
  }

  for (let i = 0; i < laneCount; i += 1) {
    const top = minTop + i * height;
    if (top + height > maxBottom + 0.5) continue;
    if (tryLane(top)) return top;
  }

  return undefined;
}

function patchDanmukuConfig(danmuku: Record<string, any>) {
  if (danmuku.__moontvLiveFontSizePatched) return;
  danmuku.__moontvLiveFontSizePatched = true;

  const originalConfig = danmuku.config.bind(danmuku);
  const originalPostMessage = danmuku.postMessage.bind(danmuku);
  const proto = Object.getPrototypeOf(danmuku);
  const originalFontSizeGet = Object.getOwnPropertyDescriptor(proto, 'fontSize')?.get;

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFontSize: unknown;
  let draggingFontSize = false;

  const flushPersist = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (pendingFontSize !== undefined) {
      danmuku.option.fontSize = pendingFontSize;
      pendingFontSize = undefined;
    }
    draggingFontSize = false;
    danmuku.art?.emit('artplayerPluginDanmuku:config', danmuku.option);
  };

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 160);
  };

  const onPointerUp = () => {
    if (pendingFontSize === undefined) return;
    flushPersist();
  };

  // 滑条 onChange 会读 danmuku.fontSize。只返回已生效字号，避免拖动中 pending 被绘制进弹幕。
  // 数字字号不再读 player.clientHeight，以免拖动时强制布局。
  Object.defineProperty(danmuku, 'fontSize', {
    configurable: true,
    enumerable: false,
    get() {
      const raw = danmuku.option?.fontSize;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return Math.round(Math.min(120, Math.max(12, raw)));
      }
      return originalFontSizeGet ? originalFontSizeGet.call(danmuku) : 25;
    },
  });

  danmuku.config = function patchedConfig(option: any, isInit = false) {
    if (isInit || !option || typeof option !== 'object') {
      return originalConfig(option, isInit);
    }

    const hasFontSize = option.fontSize != null;
    const hasOpacity = typeof option.opacity === 'number';
    if (!hasFontSize && !hasOpacity) {
      return originalConfig(option, isInit);
    }

    const { fontSize, opacity, ...rest } = option;
    const hasRest = Object.keys(rest).length > 0;
    const result = hasRest ? originalConfig(rest, isInit) : danmuku;

    if (hasOpacity) {
      danmuku.option.opacity = Math.min(1, Math.max(0, opacity));
      schedulePersist();
    }

    if (hasFontSize) {
      pendingFontSize = fontSize;
      draggingFontSize = true;
    }

    return result;
  };

  danmuku.postMessage = function patchedPostMessage(message: any = {}) {
    if (message?.type === 'getDanmuTop' && message.target) {
      // 拖动字号时把轨道计算交回 Worker，避免和指针事件抢主线程
      if (draggingFontSize) {
        return originalPostMessage(message);
      }
      return Promise.resolve({
        id: message.id ?? Date.now(),
        result: computeDanmuTop(message),
      });
    }
    return originalPostMessage(message);
  };

  // Setting 会在当前同步栈里注册 document:pointerup；推迟到其后，才能在滑条最后一次 onChange 之后应用字号
  queueMicrotask(() => {
    danmuku.art?.on('document:pointerup', onPointerUp);
    danmuku.art?.on('document:pointercancel', onPointerUp);
  });
}

/**
 * 包装官方弹幕插件：在 Danmuku 实例 bind 方法时立刻改写 config / postMessage，
 * 才能拦住设置面板滑条里的 fontSize / opacity。
 */
export function wrapArtplayerPluginDanmuku(factory: any) {
  if (typeof factory !== 'function') return factory;

  const wrapped = (option: any) => (art: any) => {
    const originalBind = Function.prototype.bind;
    Function.prototype.bind = function patchedBind(
      this: Function,
      thisArg: any,
      ...boundArgs: any[]
    ) {
      if (isDanmukuInstance(thisArg)) {
        patchDanmukuConfig(thisArg);
      }
      return originalBind.apply(this, [thisArg, ...boundArgs] as [any, ...any[]]);
    };

    try {
      return factory(option)(art);
    } finally {
      Function.prototype.bind = originalBind;
    }
  };

  wrapped.icons = factory.icons;
  return wrapped;
}
