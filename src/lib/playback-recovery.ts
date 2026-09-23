/**
 * HLS 播放错误恢复策略（P1-5）。
 *
 * 解决的问题：原实现遇到致命错误就无条件 `hls.startLoad()`，
 * 源站挂掉时会形成无限重试风暴，而且永远不会换源。
 *
 * 本模块**只做决策，不碰 hls 实例**。调用方拿到 {@link RecoveryDecision}
 * 后自行执行（含延时），这样策略可以独立单测，也便于在 UI 上给出提示。
 *
 * 计数语义："连续失败次数"——收到 `FRAG_LOADED`（无论来自网络还是本项目
 * 的片段缓存）即视为播放链路已恢复，计数归零。因此偶发抖动不会被误判为
 * "源已死"，而源站彻底挂掉时计数会持续累积并最终触发换源。
 */

/** hls.js 的 ErrorTypes 常量值，这里用字面量避免静态引入 hls.js */
export const HLS_ERROR_NETWORK = 'networkError';
export const HLS_ERROR_MEDIA = 'mediaError';

/**
 * 这些致命错误重试没有意义（格式/编码层面的硬失败），直接换源。
 * `manifestLoadError` / `manifestLoadTimeOut` 不在其中——网络抖动值得退避重试。
 */
const HARD_FAIL_DETAILS = new Set([
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'levelEmptyError',
]);

export interface RecoveryPolicy {
  /** 连续网络错误的最大退避重试次数，超出后换源 */
  maxNetworkRetries: number;
  /** 连续媒体错误的最大恢复次数，超出后换源 */
  maxMediaRecoveries: number;
  /** 首次退避时长（毫秒），之后按 2 的幂增长 */
  baseDelayMs: number;
  /** 单次退避时长上限（毫秒） */
  maxDelayMs: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxNetworkRetries: 3,
  maxMediaRecoveries: 2,
  baseDelayMs: 800,
  maxDelayMs: 8000,
};

export type RecoveryDecision =
  | { action: 'retry'; delayMs: number; attempt: number; reason: string }
  | { action: 'recover-media'; swapAudio: boolean; attempt: number; reason: string }
  | { action: 'switch-source'; reason: string }
  | { action: 'ignore'; reason: string };

/**
 * "恢复确认"静默窗口（毫秒）。
 *
 * 触发退避重试后，管道里可能还有上一轮在途的分片成功返回。若立刻把成功
 * 计入"链路已恢复"，计数会被噪声清零，源站彻底挂掉时永远累计不到上限。
 * 因此只在最后一次动作之后过了这个窗口、才把成功分片当作真正的恢复信号。
 */
const HEALTHY_QUIET_MS = 3000;

/**
 * 单实例的恢复状态机。每个 HLS 实例持有一个；换源后由外部销毁重建。
 */
export class PlaybackRecovery {
  private readonly policy: RecoveryPolicy;
  private networkAttempts = 0;
  private mediaAttempts = 0;
  private disposed = false;
  private lastActionAt = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(policy: Partial<RecoveryPolicy> = {}) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
  }

  /**
   * 播放链路恢复的信号（`FRAG_LOADED` 时调用），清空连续失败计数。
   * 动作静默窗口内的成功会被忽略，见 {@link HEALTHY_QUIET_MS}。
   */
  markHealthy(): void {
    if (this.disposed) return;
    if (Date.now() - this.lastActionAt < HEALTHY_QUIET_MS) return;
    this.networkAttempts = 0;
    this.mediaAttempts = 0;
  }

  get accepted(): boolean {
    return !this.disposed;
  }

  /**
   * 处理一次致命错误，返回应当执行的动作。
   *
   * @param type hls.js 的 `data.type`（networkError / mediaError）
   * @param details hls.js 的 `data.details`
   */
  onFatal(type: string, details: string): RecoveryDecision {
    if (this.disposed) {
      return { action: 'ignore', reason: '播放器已销毁' };
    }

    const label = describeHlsError(type, details);

    if (HARD_FAIL_DETAILS.has(details)) {
      this.lastActionAt = Date.now();
      return { action: 'switch-source', reason: `${label}，无法在当前源恢复` };
    }

    if (type === HLS_ERROR_NETWORK) {
      if (this.networkAttempts >= this.policy.maxNetworkRetries) {
        this.lastActionAt = Date.now();
        return {
          action: 'switch-source',
          reason: `${label}，已重试 ${this.networkAttempts} 次仍未恢复`,
        };
      }
      this.networkAttempts += 1;
      this.lastActionAt = Date.now();
      // 指数退避：800ms / 1.6s / 3.2s，封顶 maxDelayMs
      const delayMs = Math.min(
        this.policy.baseDelayMs * 2 ** (this.networkAttempts - 1),
        this.policy.maxDelayMs
      );
      return {
        action: 'retry',
        delayMs,
        attempt: this.networkAttempts,
        reason: label,
      };
    }

    if (type === HLS_ERROR_MEDIA) {
      if (this.mediaAttempts >= this.policy.maxMediaRecoveries) {
        this.lastActionAt = Date.now();
        return {
          action: 'switch-source',
          reason: `${label}，已恢复 ${this.mediaAttempts} 次仍失败`,
        };
      }
      this.mediaAttempts += 1;
      this.lastActionAt = Date.now();
      // 第一次只 recoverMediaError；第二次起同时交换音轨（hls.js 官方推荐链路）
      return {
        action: 'recover-media',
        swapAudio: this.mediaAttempts > 1,
        attempt: this.mediaAttempts,
        reason: label,
      };
    }

    this.lastActionAt = Date.now();
    return { action: 'switch-source', reason: `${label}，无法自动恢复` };
  }

  /**
   * 延时执行重试。使用内部的定时器集合，`dispose()` 会一并取消，
   * 避免播放器销毁后仍向已释放的 hls 实例发指令。
   */
  schedule(delayMs: number, task: () => void): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      task();
    }, delayMs);
    this.timers.add(timer);
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }
}

const ERROR_LABELS: Record<string, string> = {
  manifestLoadError: '播放列表加载失败',
  manifestLoadTimeOut: '播放列表加载超时',
  manifestParsingError: '播放列表格式错误',
  manifestIncompatibleCodecsError: '编码格式不兼容',
  levelLoadError: '码率列表加载失败',
  levelLoadTimeOut: '码率列表加载超时',
  levelEmptyError: '码率列表为空',
  fragLoadError: '视频分片加载失败',
  fragLoadTimeOut: '视频分片加载超时',
  fragParsingError: '视频分片解析失败',
  fragGapTimeout: '视频分片间隙超时',
  bufferAppendError: '解码器写入失败',
  bufferAppendingError: '解码器写入失败',
  bufferStalledError: '缓冲区卡顿',
  bufferSeekOverHole: '拖动位置无可用数据',
  mediaError: '媒体解码错误',
};

/** 把 hls.js 的错误码翻译成可展示给用户的中文文案 */
export function describeHlsError(type: string, details: string): string {
  const known = ERROR_LABELS[details];
  if (known) return known;
  if (type === HLS_ERROR_NETWORK) return '网络错误';
  if (type === HLS_ERROR_MEDIA) return '媒体错误';
  return '播放错误';
}
