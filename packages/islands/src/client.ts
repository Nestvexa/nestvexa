/** Browser island loader. No Node or Nest imports; safe to bundle for the browser. */
import {
  CONTEXT_ELEMENT_ID,
  ISLAND_BUNDLE_PATTERN,
  checkIslandProps,
  parseIslandManifest,
  parseSharedContext,
} from './shared.js';
import type {
  IslandManifest,
  IslandManifestEntry,
  IslandSharedContext,
} from './shared.js';

export {
  CONTEXT_ELEMENT_ID,
  checkIslandProps,
  parseIslandManifest,
  parseSharedContext,
} from './shared.js';
export type {
  IslandFramework,
  IslandManifest,
  IslandManifestEntry,
  IslandPropSchema,
  IslandSharedContext,
  IslandStrategy,
} from './shared.js';

export interface IslandContext<Services = unknown> {
  readonly id: string;
  /** Aborted when the island is removed or the loader is disposed. */
  readonly signal: AbortSignal;
  /** Page context: theme tokens, locale, direction and display-only user fields. */
  readonly shared: IslandSharedContext;
  /** Application services from `createIslands({ services })`, e.g. a typed actions client. */
  readonly services: Services;
  /** True when the root holds server-rendered HTML that the adapter hydrates. */
  readonly hydrate: boolean;
  /** Adapters report SSR hydration mismatches here (marks the root, calls `onHydrationMismatch`). */
  reportMismatch(detail: string): void;
  /** Signed server props to send back for `IslandRegistry.verifyProps`. */
  readonly signed:
    { readonly props: string; readonly token: string } | undefined;
  /** Send a namespaced event to other islands (`island:<name>`). Detail is cloned. */
  emit(name: string, detail?: unknown): void;
  /**
   * Listen for a namespaced event; removed automatically on unmount. Events
   * whose detail fails `accept` are dropped (counted in diagnostics).
   * Returns a function that removes the listener early.
   */
  on(
    name: string,
    handler: (detail: unknown) => void,
    accept?: (detail: unknown) => boolean,
  ): () => void;
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
export interface IslandHydrationMismatch {
  readonly id: string;
  readonly framework: string;
  readonly detail: string;
}
export interface IslandsOptions<Services = unknown> {
  /** Static allowlist (bundler-resolved dynamic imports). */
  readonly modules?: IslandModules;
  /**
   * Build-time manifest (bundled with the loader, never read from the page).
   * Ids, frameworks, size limits and props schemas are enforced from it, and
   * ids without a `modules` entry load their manifest `bundle` path.
   */
  readonly manifest?: IslandManifest;
  /** Loads a manifest bundle path; default `import(path)`. */
  readonly importModule?: (path: string) => Promise<unknown>;
  readonly root?: Document | HTMLElement;
  readonly services?: Services;
  /** Page context; default: the `#nv-islands-context` JSON script, if present. */
  readonly context?: IslandSharedContext;
  readonly onError?: (error: unknown, element: HTMLElement) => void;
  readonly onHydrationMismatch?: (
    element: HTMLElement,
    mismatch: IslandHydrationMismatch,
  ) => void;
  /** Maximum serialized props characters accepted from markup (default 262144). */
  readonly maxPropsLength?: number;
  /** Maximum listeners per island (default 32, at most 256). */
  readonly maxListeners?: number;
}
export type IslandState = 'scheduled' | 'loading' | 'mounted' | 'error';
export interface IslandDiagnostic {
  readonly id: string;
  readonly element: HTMLElement;
  readonly state: IslandState;
  readonly listeners: number;
  readonly rejectedEvents: number;
  readonly hydration: 'none' | 'hydrated' | 'mismatch';
  /** Milliseconds from scheduling to mounted, once mounted. */
  readonly mountMs: number | undefined;
}
export interface IslandsLoader {
  start(): void;
  dispose(): void;
  emit(name: string, detail?: unknown): void;
  /** Currently mounted island elements. */
  readonly mounted: number;
  /** Per-island state, listener counts and hydration outcome. */
  diagnostics(): readonly IslandDiagnostic[];
}
interface Instance {
  readonly id: string;
  readonly abort: AbortController;
  readonly scheduled: number;
  unmount?: IslandUnmount;
  readonly listeners: Set<() => void>;
  cancelStrategy?: (() => void) | undefined;
  state: IslandState;
  rejectedEvents: number;
  hydration: 'none' | 'hydrated' | 'mismatch';
  mismatches: number;
  mountMs?: number;
}
const eventName = /^[a-z][a-z0-9:.-]{0,63}$/;

function readContext(doc: Document): IslandSharedContext {
  const script = doc.getElementById(CONTEXT_ELEMENT_ID);
  if (!script || script.getAttribute('type') !== 'application/json')
    return Object.freeze({});
  return parseSharedContext(JSON.parse(script.textContent ?? '{}'));
}

export function createIslands<Services = unknown>(
  options: IslandsOptions<Services>,
): IslandsLoader {
  const root = options.root ?? document;
  const doc =
    root.nodeType === 9
      ? (root as Document)
      : (root as HTMLElement).ownerDocument;
  const defaultView = doc.defaultView;
  if (!defaultView) throw new Error('Islands require a browser window');
  const view: Window & typeof globalThis = defaultView;
  const maxProps = options.maxPropsLength ?? 262_144;
  const maxListeners = options.maxListeners ?? 32;
  if (
    !Number.isSafeInteger(maxListeners) ||
    maxListeners < 1 ||
    maxListeners > 256
  )
    throw new Error('maxListeners must be 1-256');
  const manifest: IslandManifest | undefined =
    options.manifest === undefined
      ? undefined
      : parseIslandManifest(options.manifest);
  const modules = options.modules;
  if (!modules && !manifest)
    throw new Error('createIslands requires modules and/or a manifest');
  const importModule =
    options.importModule ?? ((path: string) => import(/* @vite-ignore */ path));
  const shared = options.context
    ? parseSharedContext(options.context)
    : readContext(doc);
  const instances = new Map<HTMLElement, Instance>();
  let observer: MutationObserver | undefined;
  let started = false;
  const report = (error: unknown, element: HTMLElement) => {
    element.setAttribute('data-nv-island-error', '');
    element.removeAttribute('aria-busy');
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
  function entryFor(id: string): IslandManifestEntry | undefined {
    return manifest && Object.hasOwn(manifest.islands, id)
      ? manifest.islands[id]
      : undefined;
  }
  /** Allowlist: the id must be present in every configured source. */
  function loaderFor(id: string): () => Promise<IslandMount> {
    const fromModules =
      modules && Object.hasOwn(modules, id) ? modules[id] : undefined;
    const entry = entryFor(id);
    if ((modules && !fromModules) || (manifest && !entry))
      throw new Error(`Island "${id}" is not in the client allowlist`);
    if (fromModules) return fromModules;
    const bundle = entry?.bundle ?? '';
    if (!ISLAND_BUNDLE_PATTERN.test(bundle))
      throw new Error(`Island "${id}" has an invalid bundle path`);
    return async () => {
      const loaded: unknown = await importModule(bundle);
      const mount: unknown =
        typeof loaded === 'object' && loaded !== null
          ? Reflect.get(loaded, 'default')
          : undefined;
      if (typeof mount !== 'function')
        throw new Error(`Island "${id}" bundle has no default mount export`);
      return mount as IslandMount;
    };
  }
  function applyTheme(element: HTMLElement): void {
    for (const [name, value] of Object.entries(shared.theme ?? {}))
      element.style.setProperty(`--nv-${name}`, value);
    if (shared.direction && !element.hasAttribute('dir'))
      element.setAttribute('dir', shared.direction);
    if (shared.locale && !element.hasAttribute('lang'))
      element.setAttribute('lang', shared.locale);
  }
  async function mount(
    element: HTMLElement,
    instance: Instance,
  ): Promise<void> {
    const id = instance.id;
    const load = loaderFor(id);
    const entry = entryFor(id);
    const framework = element.getAttribute('data-nv-framework') ?? '';
    if (entry && entry.framework !== framework)
      throw new Error(`Island "${id}" framework does not match the manifest`);
    const raw = element.getAttribute('data-nv-props') ?? '{}';
    if (raw.length > maxProps) throw new Error('Island props are too large');
    if (entry && new TextEncoder().encode(raw).byteLength > entry.maxPropsBytes)
      throw new Error('Island props exceed the manifest limit');
    const props: unknown = JSON.parse(raw);
    if (!props || typeof props !== 'object' || Array.isArray(props))
      throw new Error('Island props must be an object');
    if (entry?.props) {
      const problem = checkIslandProps(entry.props, props);
      if (problem) throw new Error(`Island "${id}" props rejected: ${problem}`);
    }
    const token = element.getAttribute('data-nv-props-token');
    instance.state = 'loading';
    element.setAttribute('aria-busy', 'true');
    const mountIsland = await load();
    if (instance.abort.signal.aborted) return;
    const hydrate = element.hasAttribute('data-nv-ssr');
    const context: IslandContext = {
      id,
      signal: instance.abort.signal,
      shared,
      services: options.services,
      hydrate,
      signed: token === null ? undefined : Object.freeze({ props: raw, token }),
      reportMismatch(detail: string) {
        if (!hydrate || instance.abort.signal.aborted) return;
        instance.hydration = 'mismatch';
        element.setAttribute('data-nv-hydration-mismatch', '');
        // Bounded: a broken component cannot flood the reporter.
        if (++instance.mismatches > 10) return;
        try {
          options.onHydrationMismatch?.(element, {
            id,
            framework,
            detail: String(detail).slice(0, 500),
          });
        } catch {
          // Reporting must not break hydration.
        }
      },
      emit,
      on(name, handler, accept) {
        if (!eventName.test(name)) throw new Error('Invalid island event name');
        if (instance.abort.signal.aborted) return () => undefined;
        if (instance.listeners.size >= maxListeners)
          throw new Error('Too many island listeners');
        const listener = (event: Event) => {
          const detail: unknown = (event as CustomEvent).detail;
          if (accept && !accept(detail)) {
            instance.rejectedEvents++;
            return;
          }
          handler(detail);
        };
        doc.addEventListener(`island:${name}`, listener);
        const remove = () => {
          doc.removeEventListener(`island:${name}`, listener);
          instance.listeners.delete(remove);
        };
        instance.listeners.add(remove);
        return remove;
      },
    };
    if (hydrate) instance.hydration = 'hydrated';
    const unmount = await mountIsland(
      element,
      Object.freeze({ ...props }),
      Object.freeze(context),
    );
    if (instance.abort.signal.aborted) {
      unmount();
      return;
    }
    instance.unmount = unmount;
    instance.state = 'mounted';
    instance.mountMs = Math.round(view.performance.now() - instance.scheduled);
    element.removeAttribute('data-nv-island-error');
    element.removeAttribute('aria-busy');
    element.setAttribute('data-nv-island-mounted', '');
  }
  function schedule(element: HTMLElement, instance: Instance): void {
    const run = () => {
      instance.cancelStrategy = undefined;
      void mount(element, instance).catch((error: unknown) => {
        if (instance.abort.signal.aborted) return;
        instance.state = 'error';
        report(error, element);
      });
    };
    // Refuse ids outside the allowlist before any strategy is armed.
    loaderFor(instance.id);
    applyTheme(element);
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
    for (const remove of [...instance.listeners]) remove();
    try {
      instance.unmount?.();
    } catch (error) {
      report(error, element);
    }
    element.removeAttribute('data-nv-island-mounted');
    element.removeAttribute('aria-busy');
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
        id: element.getAttribute('data-nv-island') ?? '',
        abort: new AbortController(),
        scheduled: view.performance.now(),
        listeners: new Set(),
        state: 'scheduled',
        rejectedEvents: 0,
        hydration: 'none',
        mismatches: 0,
      };
      instances.set(element, instance);
      try {
        schedule(element, instance);
      } catch (error) {
        instance.state = 'error';
        report(error, element);
      }
    }
  }
  // Full navigations run island cleanup (unmount effects); pages kept in the
  // back/forward cache keep their islands and rescan when shown again.
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted)
      for (const element of [...instances.keys()]) release(element);
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && started) scan();
  };
  return {
    start(): void {
      if (started) return;
      started = true;
      scan();
      observer = new view.MutationObserver(() => scan());
      observer.observe(root, { childList: true, subtree: true });
      view.addEventListener('pagehide', onPageHide);
      view.addEventListener('pageshow', onPageShow);
    },
    dispose(): void {
      started = false;
      observer?.disconnect();
      observer = undefined;
      view.removeEventListener('pagehide', onPageHide);
      view.removeEventListener('pageshow', onPageShow);
      for (const element of [...instances.keys()]) release(element);
    },
    emit,
    get mounted(): number {
      let count = 0;
      for (const instance of instances.values()) if (instance.unmount) count++;
      return count;
    },
    diagnostics(): readonly IslandDiagnostic[] {
      return [...instances].map(([element, instance]) =>
        Object.freeze({
          id: instance.id,
          element,
          state: instance.state,
          listeners: instance.listeners.size,
          rejectedEvents: instance.rejectedEvents,
          hydration: instance.hydration,
          mountMs: instance.mountMs,
        }),
      );
    },
  };
}
