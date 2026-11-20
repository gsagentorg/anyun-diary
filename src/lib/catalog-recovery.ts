/**
 * catalog-recovery — 目录请求的有界结算与生命周期恢复基元（backend.svelte.ts 的支撑层）。
 *
 * 背景：浏览器/iOS WebView 长时间后台后，目录请求可能永远不返回（网络栈挂起、原生桥不响应
 * abort、后台定时器被冻结）。这里的原语保证：任何请求阶段与整体操作都在有限时间内 settle，
 * 且超时/外部中止之后旧结果绝不写回。
 *
 * 默认超时是新设计参数（2026-11-21），不是 owner 固定值；可用 configureCatalogTimeouts 调整。
 * - requestMs：单个请求阶段上限（指针 fetch+body、catalog、月份块各算一个阶段）；
 * - operationMs：fetchIndex 整体操作上限；超过即视为「残留请求」，允许被退休并重新发起；
 * - nativeBridgeMs：nativeFetchJSON 单次上限——桥不接受 abort，挂死的桥超时后降级为普通 fetch；
 * - coalesceMs：visibility/pageshow/online 同一瞬间多次事件的合并窗口。
 * 这些原语只让失败的请求「有界地结束」，不引入任何自动重试循环，也不自动 reload 整页。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 60000;
export const DEFAULT_NATIVE_BRIDGE_TIMEOUT_MS = 8000;
export const DEFAULT_RECOVERY_COALESCE_MS = 350;

export interface CatalogTimeouts {
  requestMs: number;
  operationMs: number;
  nativeBridgeMs: number;
  coalesceMs: number;
}

let timeouts: CatalogTimeouts = {
  requestMs: DEFAULT_REQUEST_TIMEOUT_MS,
  operationMs: DEFAULT_OPERATION_TIMEOUT_MS,
  nativeBridgeMs: DEFAULT_NATIVE_BRIDGE_TIMEOUT_MS,
  coalesceMs: DEFAULT_RECOVERY_COALESCE_MS,
};

export function catalogTimeouts(): CatalogTimeouts {
  return { ...timeouts };
}

/** 只接受正有限数，其余输入忽略；给测试与后续调参用。 */
export function configureCatalogTimeouts(overrides: Partial<CatalogTimeouts> = {}): void {
  for (const key of ['requestMs', 'operationMs', 'nativeBridgeMs', 'coalesceMs'] as const) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) timeouts[key] = Math.round(value);
  }
}

export class CatalogTimeoutError extends Error {
  constructor() {
    super('请求超时');
    this.name = 'CatalogTimeoutError';
  }
}

export function abortedError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export interface BoundedOptions {
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

/**
 * 用截止时间和可选外部 abort 运行 task，保证返回的 Promise 一定在有限时间内 settle。
 * 关键点：不假设底层会响应 abort——
 * - 超时到点立即 reject（CatalogTimeoutError），并尽力 abort 传给 task 的信号；
 * - 外部 abort 到点立即 reject（AbortError），同样不等待底层任何响应；
 * - 无论谁先到，task 迟到的结果/异常都被吞掉，绝不交付给调用方（旧结果不写回）；
 * - settle 时定时器与监听器必定清理；
 * - 外部信号已 abort 或 timeoutMs<=0 时 task 根本不会启动。
 */
export function bounded<T>(task: (signal: AbortSignal) => Promise<T> | T, { timeoutMs, signal }: BoundedOptions = {}): Promise<T> {
  const limit = timeoutMs ?? timeouts.requestMs;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    if (!(limit > 0)) {
      reject(new CatalogTimeoutError());
      return;
    }
    const inner = new AbortController();
    let settled = false;
    const settle = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternal);
      deliver();
    };
    const abortInner = () => {
      try {
        inner.abort();
      } catch {
        /* 尽力而为：不支持 abort 的环境由上面的立即 reject 兜底 */
      }
    };
    const onExternal = () => {
      abortInner();
      settle(() => reject(abortedError()));
    };
    const timer = setTimeout(() => {
      abortInner();
      settle(() => reject(new CatalogTimeoutError()));
    }, limit);
    signal?.addEventListener('abort', onExternal, { once: true });
    let running: Promise<T>;
    try {
      running = Promise.resolve(task(inner.signal));
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    running.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });
}

/** fetchIndex 整体操作已超过截止时间 = 残留请求（后台冻结定时器 / 网络栈挂起的典型形态），可以被退休。 */
export function shouldRetireOperation(startedAt: number, now: number = Date.now()): boolean {
  return now - startedAt >= timeouts.operationMs;
}
