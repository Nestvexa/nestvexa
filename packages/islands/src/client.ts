/** Browser island loader. No Node or Nest imports; safe to bundle for the browser. */
export interface IslandContext {
  /** Aborted when the island is removed or the loader is disposed. */
  readonly signal: AbortSignal;
  /** Send a namespaced event to other islands (`island:<name>`). Detail is cloned. */
  emit(name: string, detail?: unknown): void;
  /** Listen for a namespaced event; listeners are removed automatically on unmount. */
  on(name: string, handler: (detail: unknown) => void): void;
}
export type IslandUnmount = () => void;
export type IslandMount = (
  element: HTMLElement,
  props: Readonly<Record<string, unknown>>,
  context: IslandContext,
) => IslandUnmount | Promise<IslandUnmount>;
/** Build-time allowlist: id → lazy module loader. Markup can only select from it. */
export type IslandModules = Readonly<
  Record<string, () => Promise<IslandMount>>
>;
export interface IslandsOptions {
  readonly modules: IslandModules;
  readonly root?: Document | HTMLElement;
  readonly onError?: (error: unknown, element: HTMLElement) => void;
  /** Maximum serialized props characters accepted from markup (default 262144). */
  readonly maxPropsLength?: number;
}
export interface IslandsLoader {
  start(): void;
  dispose(): void;
  emit(name: string, detail?: unknown): void;
  /** Currently mounted island elements. */
  readonly mounted: number;
}
interface Instance {
  readonly abort: AbortController;
  unmount?: IslandUnmount;
  readonly listeners: (() => void)[];
  cancelStrategy?: (() => void) | undefined;
}
const eventName = /^[a-z][a-z0-9:.-]{0,63}$/;

export function createIslands(options: IslandsOptions): IslandsLoader {
  const root = options.root ?? document;
  const doc =
    root.nodeType === 9
      ? (root as Document)
      : (root as HTMLElement).ownerDocument;
  const defaultView = doc.defaultView;
  if (!defaultView) throw new Error('Islands require a browser window');
  const view: Window & typeof globalThis = defaultView;
  const maxProps = options.maxPropsLength ?? 262_144;
  const instances = new Map<HTMLElement, Instance>();
  let observer: MutationObserver | undefined;
  let started = false;
  const report = (error: unknown, element: HTMLElement) => {
    element.setAttribute('data-nv-island-error', '');
    try {
      options.onError?.(error, element);
    } catch {
      // Error reporting must not break other islands.
    }
  };
  function emit(name: string, detail?: unknown): void {
    if (!eventName.test(name)) throw new Error('Invalid island event name');
    doc.dispatchEvent(
      new view.CustomEvent(`island:${name}`, {
        detail: detail === undefined ? null : structuredClone(detail),
      }),
    );
  }
  async function mount(
    element: HTMLElement,
    instance: Instance,
  ): Promise<void> {
    const id = element.getAttribute('data-nv-island') ?? '';
    const load = Object.hasOwn(options.modules, id)
      ? options.modules[id]
      : undefined;
    if (!load) throw new Error(`Island "${id}" is not in the client allowlist`);
    const raw = element.getAttribute('data-nv-props') ?? '{}';
    if (raw.length > maxProps) throw new Error('Island props are too large');
    const props: unknown = JSON.parse(raw);
    if (!props || typeof props !== 'object' || Array.isArray(props))
      throw new Error('Island props must be an object');
    const mountIsland = await load();
    if (instance.abort.signal.aborted) return;
    const context: IslandContext = {
      signal: instance.abort.signal,
      emit,
      on(name, handler) {
        if (!eventName.test(name)) throw new Error('Invalid island event name');
        if (instance.listeners.length >= 32)
          throw new Error('Too many island listeners');
        const listener = (event: Event) =>
          handler((event as CustomEvent).detail);
        doc.addEventListener(`island:${name}`, listener);
        instance.listeners.push(() =>
          doc.removeEventListener(`island:${name}`, listener),
        );
      },
    };
    const unmount = await mountIsland(
      element,
      Object.freeze({ ...props }),
      context,
    );
    if (instance.abort.signal.aborted) {
      unmount();
      return;
    }
    instance.unmount = unmount;
    element.removeAttribute('data-nv-island-error');
    element.setAttribute('data-nv-island-mounted', '');
  }
  function schedule(element: HTMLElement, instance: Instance): void {
    const run = () => {
      instance.cancelStrategy = undefined;
      void mount(element, instance).catch((error: unknown) =>
        report(error, element),
      );
    };
    const strategy = element.getAttribute('data-nv-mount') ?? 'visible';
    if (strategy === 'immediate') return run();
    if (strategy === 'idle') {
      // Safari lacks requestIdleCallback; the DOM typings assume it exists.
      const idle =
        typeof (view as { requestIdleCallback?: unknown })
          .requestIdleCallback === 'function';
      const handle = idle
        ? view.requestIdleCallback(run, { timeout: 2000 })
        : view.setTimeout(run, 200);
      instance.cancelStrategy = () =>
        idle ? view.cancelIdleCallback(handle) : view.clearTimeout(handle);
      return;
    }
    if (strategy === 'interaction') {
      const events = [
        'pointerdown',
        'focusin',
        'keydown',
        'mouseenter',
      ] as const;
      const trigger = () => {
        for (const name of events) element.removeEventListener(name, trigger);
        run();
      };
      for (const name of events)
        element.addEventListener(name, trigger, { once: true });
      instance.cancelStrategy = () => {
        for (const name of events) element.removeEventListener(name, trigger);
      };
      return;
    }
    if (!view.IntersectionObserver) return run();
    const visibility = new view.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visibility.disconnect();
        run();
      }
    });
    visibility.observe(element);
    instance.cancelStrategy = () => visibility.disconnect();
  }
  function release(element: HTMLElement): void {
    const instance = instances.get(element);
    if (!instance) return;
    instances.delete(element);
    instance.abort.abort();
    instance.cancelStrategy?.();
    for (const remove of instance.listeners.splice(0)) remove();
    try {
      instance.unmount?.();
    } catch (error) {
      report(error, element);
    }
    element.removeAttribute('data-nv-island-mounted');
  }
  function scan(): void {
    for (const [element] of instances)
      if (!element.isConnected) release(element);
    const scope =
      root.nodeType === 9 ? (root as Document) : (root as HTMLElement);
    for (const element of scope.querySelectorAll<HTMLElement>(
      '[data-nv-island]',
    )) {
      // One owner per subtree: nested islands inside another island are ignored.
      if (
        instances.has(element) ||
        element.parentElement?.closest('[data-nv-island]')
      )
        continue;
      const instance: Instance = {
        abort: new AbortController(),
        listeners: [],
      };
      instances.set(element, instance);
      try {
        schedule(element, instance);
      } catch (error) {
        report(error, element);
      }
    }
  }
  return {
    start(): void {
      if (started) return;
      started = true;
      scan();
      observer = new view.MutationObserver(() => scan());
      observer.observe(root, { childList: true, subtree: true });
    },
    dispose(): void {
      started = false;
      observer?.disconnect();
      observer = undefined;
      for (const element of [...instances.keys()]) release(element);
    },
    emit,
    get mounted(): number {
      let count = 0;
      for (const instance of instances.values()) if (instance.unmount) count++;
      return count;
    },
  };
}
