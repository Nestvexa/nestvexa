import { LiveClientError } from './grammar.js';

export type InitializationTiming = 'eager' | 'visible' | 'idle';
export interface InitializationScheduler {
  /** The caller consumes its component attempt and capacity before scheduling. */
  schedule(
    element: Element,
    timing: InitializationTiming,
    run: () => void,
    eligible: () => boolean,
  ): void;
  prune(): void;
  remove(node: Element): void;
  dispose(): void;
}
interface PendingInitialization {
  readonly element: Element;
  readonly timing: InitializationTiming;
  readonly run: () => void;
  readonly eligible: () => boolean;
  timer: number | undefined;
  idle: number | undefined;
  intersects: boolean;
}

/** Lifecycle-owned initialization scheduling. It never retries canceled/failed attempts. */
export function createInitializationScheduler(options: {
  readonly window: Window & typeof globalThis;
  readonly onError: (error: unknown, element: Element) => void;
}): InitializationScheduler {
  const view = options.window;
  const records = new Set<PendingInitialization>();
  let observer: IntersectionObserver | undefined;
  let disposed = false;
  function release(record: PendingInitialization): void {
    records.delete(record);
    if (record.timer !== undefined) view.clearTimeout(record.timer);
    if (
      record.idle !== undefined &&
      typeof view.cancelIdleCallback === 'function'
    )
      view.cancelIdleCallback(record.idle);
    if (record.timing === 'visible') observer?.unobserve(record.element);
    record.timer = undefined;
    record.idle = undefined;
  }
  function eligible(record: PendingInitialization): boolean {
    if (disposed || !records.has(record)) return false;
    try {
      if (record.element.isConnected && record.eligible()) return true;
    } catch (error) {
      options.onError(error, record.element);
    }
    release(record);
    return false;
  }
  function run(record: PendingInitialization): void {
    if (!eligible(record)) return;
    release(record);
    try {
      record.run();
    } catch (error) {
      options.onError(error, record.element);
    }
  }
  function visibilityChanged(): void {
    for (const record of records)
      if (
        record.timing === 'visible' &&
        record.intersects &&
        view.document.visibilityState !== 'hidden'
      )
        view.queueMicrotask(() => run(record));
  }
  view.document.addEventListener('visibilitychange', visibilityChanged);
  return {
    schedule(element, timing, callback, isEligible): void {
      if (disposed) return;
      if (!['eager', 'visible', 'idle'].includes(timing))
        throw new LiveClientError(
          'DIRECTIVE',
          'Unsupported initialization timing',
        );
      if (records.size >= 1000)
        throw new LiveClientError(
          'DIRECTIVE',
          'Pending initialization capacity reached',
        );
      if (
        timing === 'visible' &&
        typeof view.IntersectionObserver !== 'function'
      )
        throw new LiveClientError(
          'DIRECTIVE',
          'nv:init.visible requires IntersectionObserver support',
        );
      const record: PendingInitialization = {
        element,
        timing,
        run: callback,
        eligible: isEligible,
        timer: undefined,
        idle: undefined,
        intersects: false,
      };
      records.add(record);
      if (timing === 'eager') view.queueMicrotask(() => run(record));
      else if (timing === 'idle') {
        if (typeof view.requestIdleCallback === 'function')
          record.idle = view.requestIdleCallback(() => run(record), {
            timeout: 1000,
          });
        else record.timer = view.setTimeout(() => run(record), 100);
      } else {
        observer ??= new view.IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const candidate = [...records].find(
                (pending) =>
                  pending.timing === 'visible' &&
                  pending.element === entry.target,
              );
              if (!candidate || !eligible(candidate)) continue;
              candidate.intersects = entry.isIntersecting;
              if (
                candidate.intersects &&
                view.document.visibilityState !== 'hidden'
              )
                run(candidate);
            }
          },
          { threshold: [0] },
        );
        observer.observe(element);
      }
    },
    prune(): void {
      for (const record of records) eligible(record);
    },
    remove(node): void {
      for (const record of records)
        if (record.element === node || node.contains(record.element))
          release(record);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      view.document.removeEventListener('visibilitychange', visibilityChanged);
      for (const record of records) release(record);
      observer?.disconnect();
      observer = undefined;
    },
  };
}
