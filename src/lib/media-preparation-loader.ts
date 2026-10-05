import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
} from 'hls.js';

type LoaderConstructor = new (config: HlsConfig) => Loader<LoaderContext>;
export type PreparationState = {
  id: symbol;
  phase: 'waiting' | 'ready' | 'cancelled' | 'failed';
  elapsedSeconds: number;
};
type Options = {
  maxWaitMs?: number;
  filterPlaylist?: (text: string) => string;
  onState?: (state: PreparationState) => void;
  onTerminal?: (reason: string) => void;
};

/** Extend the normal HLS loader only for explicitly marked preparation responses. */
export function createPreparationLoader(
  Base: LoaderConstructor,
  options: Options = {}
) {
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  if (!(maxWaitMs > 0 && Number.isFinite(maxWaitMs)))
    throw new Error('INVALID_WAIT_LIMIT');
  return class PreparationLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    private inner: Loader<LoaderContext>;
    private id = Symbol('preparation');
    private started = 0;
    private used = false;
    private done = false;
    private waiting = false;
    private notifyAbort = false;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private deadlineTimer?: ReturnType<typeof setTimeout>;
    private statusTimer?: ReturnType<typeof setInterval>;

    constructor(private hlsConfig: HlsConfig) {
      this.inner = new Base(hlsConfig);
    }
    get stats() {
      return this.inner.stats;
    }
    getResponseHeader(name: string) {
      return this.inner.getResponseHeader?.(name) ?? null;
    }
    getCacheAge() {
      return this.inner.getCacheAge?.() ?? null;
    }
    private state(phase: PreparationState['phase']) {
      options.onState?.({
        id: this.id,
        phase,
        elapsedSeconds: Math.floor((performance.now() - this.started) / 1000),
      });
    }
    private clear() {
      clearTimeout(this.retryTimer);
      clearTimeout(this.deadlineTimer);
      clearInterval(this.statusTimer);
    }
    abort() {
      if (this.done) return;
      this.done = true;
      this.clear();
      if (this.waiting) this.state('cancelled');
      this.notifyAbort = true;
      try {
        this.inner.abort();
      } finally {
        this.notifyAbort = false;
      }
    }
    destroy() {
      this.abort();
      this.inner.destroy();
      this.context = null;
    }
    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ) {
      if (this.used) throw new Error('Loader can only be used once.');
      this.used = true;
      this.started = performance.now();
      this.context = context;
      const terminal = (reason: string, details: unknown, code = 503) => {
        if (this.done) return;
        this.done = true;
        this.clear();
        const stats = this.stats;
        this.inner.abort();
        this.state('failed');
        options.onTerminal?.(reason);
        callbacks.onError({ code, text: reason }, context, details, stats);
      };
      const attempt = (retry: boolean) => {
        if (this.done) return;
        if (retry) {
          this.inner.destroy();
          // Default XHR loader instances cannot be loaded twice.
          this.inner = new Base(this.hlsConfig);
        }
        const inner = this.inner;
        const live = () => !this.done && this.inner === inner;
        const requestConfig = this.waiting
          ? {
              ...config,
              loadPolicy: {
                ...config.loadPolicy,
                errorRetry: null,
                timeoutRetry: null,
              },
            }
          : config;
        inner.load(context, requestConfig, {
          onSuccess: (response, stats, ctx, details) => {
            if (!live()) return;
            this.done = true;
            this.clear();
            if (this.waiting) this.state('ready');
            const type = (ctx as LoaderContext & { type?: string }).type;
            if (
              options.filterPlaylist &&
              (type === 'manifest' || type === 'level') &&
              typeof response.data === 'string'
            ) {
              response.data = options.filterPlaylist(response.data);
            }
            callbacks.onSuccess(response, stats, ctx, details);
          },
          onError: (error, ctx, details, stats) => {
            if (!live()) return;
            const header = (name: string) => {
              try {
                return (
                  inner.getResponseHeader?.(name) ??
                  details?.getResponseHeader?.(name) ??
                  null
                );
              } catch {
                return null;
              }
            };
            if (
              error.code === 503 &&
              header('X-Media-Preparation') === 'retry-after'
            ) {
              if (performance.now() - this.started >= maxWaitMs) {
                terminal('MEDIA_PREPARATION_TIMEOUT', details);
                return;
              }
              if (!this.waiting) {
                this.waiting = true;
                this.deadlineTimer = setTimeout(
                  () => terminal('MEDIA_PREPARATION_TIMEOUT', details),
                  maxWaitMs - (performance.now() - this.started)
                );
                this.statusTimer = setInterval(
                  () => this.state('waiting'),
                  1000
                );
              }
              // Keep the resolved session, so retries do not mint playback sessions.
              if (details?.responseURL) {
                try {
                  const resolved = new URL(details.responseURL);
                  if (
                    resolved.origin === new URL(ctx.url).origin &&
                    !resolved.username &&
                    !resolved.password
                  )
                    ctx.url = resolved.href;
                } catch {
                  /* Keep the original URL when no valid resolved URL exists. */
                }
              }
              const raw = header('Retry-After');
              const seconds =
                raw && /^\d+(\.\d+)?$/.test(raw.trim())
                  ? Number(raw)
                  : raw
                  ? (Date.parse(raw) - Date.now()) / 1000
                  : 2;
              const delay = Math.min(
                10_000,
                Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 2000)
              );
              this.state('waiting');
              if (!live()) return;
              this.retryTimer = setTimeout(() => attempt(true), delay);
              return;
            }
            if (this.waiting && [403, 404, 410, 424].includes(error.code)) {
              terminal('MEDIA_PREPARATION_FAILED', details, error.code);
              return;
            }
            this.done = true;
            this.clear();
            if (this.waiting) this.state('failed');
            callbacks.onError(error, ctx, details, stats);
          },
          onTimeout: (stats, ctx, details) => {
            if (!live()) return;
            if (this.waiting) {
              terminal('MEDIA_PREPARATION_TIMEOUT', details);
              return;
            }
            this.done = true;
            callbacks.onTimeout(stats, ctx, details);
          },
          onProgress: (stats, ctx, data, details) => {
            if (live()) callbacks.onProgress?.(stats, ctx, data, details);
          },
          onAbort: (stats, ctx, details) => {
            if (live() || this.notifyAbort)
              callbacks.onAbort?.(stats, ctx, details);
          },
        });
      };
      attempt(false);
    }
  };
}
