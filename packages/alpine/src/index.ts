/** Minimal public client operations consumed by the Alpine magic. */
export interface LiveClientBridge {
  call(element: Element, action: string): Promise<void>;
  get(element: Element, name: string): unknown;
  set(element: Element, name: string, value: string | number | boolean): void;
  /** Optional: deliver a browser event to `@OnEvent` listeners. */
  dispatch?(name: string, payload?: unknown): void;
}
export interface AlpineMagicUtilities {
  cleanup(callback: () => void): void;
}
/** Public Alpine extension APIs; neither importing nor installing this plugin starts Alpine. */
export interface AlpineHost {
  readonly version: string;
  magic(
    name: string,
    callback: (
      element: HTMLElement,
      utilities: AlpineMagicUtilities,
    ) => unknown,
  ): void;
  reactive(value: { revision: number }): { revision: number };
}
export interface LiveMagic {
  call(action: string): Promise<void>;
  get(name: string): unknown;
  set(name: string, value: string | number | boolean): void;
  /** Deliver an event to listening components; payloads are validated server-side. */
  dispatch(name: string, payload?: unknown): void;
}

const installed = new WeakMap<object, LiveClientBridge>();

function owner(element: Element): Element {
  const component = element.closest('[data-nv-component]');
  if (!component) throw new Error('$live requires an owning Live component');
  let ignored = false;
  for (
    let node: Element | null = element;
    node && node !== component;
    node = node.parentElement
  ) {
    if (node.hasAttribute('data-nv-island'))
      throw new Error('$live cannot cross a framework island boundary');
    if (node.hasAttribute('nv:ignore')) ignored = true;
  }
  if (!ignored)
    throw new Error('Alpine $live currently requires an nv:ignore subtree');
  return component;
}

/**
 * Register $live.call/get/set before the host calls Alpine.start().
 * Repeated installation with the same host/client is idempotent.
 * Use the CSP build when the page disallows unsafe-eval.
 */
export function installLiveAlpine(
  alpine: AlpineHost,
  client: LiveClientBridge,
): void {
  if (!/^3\.17\.\d+$/.test(alpine.version))
    throw new Error('Nestvexa Alpine supports stable Alpine 3.17.x only');
  if (
    typeof alpine.magic !== 'function' ||
    typeof alpine.reactive !== 'function'
  )
    throw new Error('Alpine public extension APIs are unavailable');
  if (
    typeof client.call !== 'function' ||
    typeof client.get !== 'function' ||
    typeof client.set !== 'function'
  )
    throw new Error('Live client bridge is incomplete');
  const prior = installed.get(alpine);
  if (prior) {
    if (prior !== client)
      throw new Error(
        'This Alpine instance is already bound to another Live client',
      );
    return;
  }
  const facades = new WeakMap<HTMLElement, LiveMagic>();
  alpine.magic('live', (element, utilities) => {
    const priorFacade = facades.get(element);
    if (priorFacade) return priorFacade;
    if (typeof utilities?.cleanup !== 'function')
      throw new Error('Alpine magic cleanup API is unavailable');
    const component = owner(element);
    const signal = alpine.reactive({ revision: 0 });
    let disposed = false;
    const assertActive = (): void => {
      if (disposed || !element.isConnected || owner(element) !== component)
        throw new Error(
          '$live element is no longer attached to its original component',
        );
    };
    const update = (event: Event): void => {
      if (!disposed && event.target === component) signal.revision++;
    };
    const facade: LiveMagic = Object.freeze({
      call(action: string): Promise<void> {
        assertActive();
        return client.call(element, action);
      },
      get(name: string): unknown {
        assertActive();
        // Alpine tracks this read inside x-text/x-effect and reevaluates on a committed update.
        void signal.revision;
        return client.get(element, name);
      },
      set(name: string, value: string | number | boolean): void {
        assertActive();
        client.set(element, name, value);
        signal.revision++;
      },
      dispatch(name: string, payload?: unknown): void {
        assertActive();
        if (typeof client.dispatch !== 'function')
          throw new Error('This Live client does not support events');
        client.dispatch(name, payload);
      },
    });
    component.addEventListener('nestvexa:updated', update);
    utilities.cleanup(() => {
      disposed = true;
      component.removeEventListener('nestvexa:updated', update);
      facades.delete(element);
    });
    facades.set(element, facade);
    return facade;
  });
  installed.set(alpine, client);
}

/** Alpine instance selected by an application that delegates startup to Nestvexa. */
export interface AlpineRuntime extends AlpineHost {
  start(): void;
}
/** Live operations and explicit lifecycle consumed by the default bootstrap. */
export interface ManagedLiveClient extends LiveClientBridge {
  mount(): void;
  dispose(): void;
}
export interface StartLiveAlpineOptions {
  readonly document?: Document;
  /** Trusted application extension hook, called after bridge registration and before startup. */
  readonly configure?: (
    alpine: AlpineRuntime,
    client: ManagedLiveClient,
  ) => void;
}
export interface LiveAlpineApplication {
  readonly alpine: AlpineRuntime;
  readonly client: ManagedLiveClient;
  /** Release Live transport and page lifecycle listeners. This does not tear down Alpine DOM. */
  dispose(): void;
}

interface BootstrapRecord {
  readonly contract: 'nestvexa.alpine.application/1';
  readonly application: LiveAlpineApplication;
  status: 'starting' | 'active' | 'disposed' | 'failed';
}
const bootstrapKey = Symbol.for('nestvexa.alpine.application/1');

function bootstrapRecord(value: unknown): value is BootstrapRecord {
  if (typeof value !== 'object' || value === null) return false;
  const own = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const contract = own(value, 'contract');
  const status = own(value, 'status');
  const application = own(value, 'application');
  if (typeof application !== 'object' || application === null) return false;
  const alpine = own(application, 'alpine');
  const client = own(application, 'client');
  return (
    contract === 'nestvexa.alpine.application/1' &&
    typeof status === 'string' &&
    ['starting', 'active', 'disposed', 'failed'].includes(status) &&
    typeof own(application, 'dispose') === 'function' &&
    typeof alpine === 'object' &&
    alpine !== null &&
    typeof client === 'object' &&
    client !== null
  );
}

/**
 * Start one default Live/Alpine pair for an attached browser document.
 * Existing host Alpine ownership must use installLiveAlpine instead.
 * Persisted pagehide keeps the same client and drafts for BFCache restoration;
 * ordinary departure disposes Live without pretending Alpine has a public stop API.
 * A failed or disposed document cannot be restarted safely: reload it instead.
 */
export function startLiveAlpine(
  alpine: AlpineRuntime,
  client: ManagedLiveClient,
  options: StartLiveAlpineOptions = {},
): LiveAlpineApplication {
  const doc = options.document ?? globalThis.document;
  const view = doc?.defaultView;
  if (!doc || !view || view.document !== doc)
    throw new Error(
      'Default Live/Alpine startup requires an attached browser document',
    );
  const descriptor = Object.getOwnPropertyDescriptor(doc, bootstrapKey);
  if (descriptor) {
    const prior: unknown = descriptor.value;
    if (!bootstrapRecord(prior))
      throw new Error(
        'This document has an incompatible Live/Alpine bootstrap owner',
      );
    if (prior.status !== 'active')
      throw new Error(
        `Live/Alpine startup is ${prior.status}; reload the document before starting again`,
      );
    if (prior.application.alpine !== alpine)
      throw new Error(
        'This document already belongs to another Alpine runtime',
      );
    return prior.application;
  }
  if (Reflect.has(view, 'Alpine'))
    throw new Error(
      'The host already owns Alpine; use installLiveAlpine with its existing startup lifecycle',
    );
  if (
    typeof alpine?.start !== 'function' ||
    typeof client?.mount !== 'function' ||
    typeof client?.dispose !== 'function' ||
    (options.configure !== undefined && typeof options.configure !== 'function')
  )
    throw new Error(
      'Default Live/Alpine startup requires complete lifecycle APIs',
    );

  const application: LiveAlpineApplication = Object.freeze({
    alpine,
    client,
    dispose(): void {
      if (record.status === 'disposed' || record.status === 'failed') return;
      record.status = 'disposed';
      view.removeEventListener('pagehide', pagehide);
      client.dispose();
    },
  });
  const record: BootstrapRecord = {
    contract: 'nestvexa.alpine.application/1',
    application,
    status: 'starting',
  };
  const pagehide = (event: PageTransitionEvent): void => {
    if (!event.persisted) application.dispose();
  };
  Object.defineProperty(doc, bootstrapKey, { value: record });
  try {
    installLiveAlpine(alpine, client);
    options.configure?.(alpine, client);
    if (record.status !== 'starting')
      throw new Error('Live/Alpine startup was disposed during configuration');
    client.mount();
    if (record.status !== 'starting')
      throw new Error('Live/Alpine startup was disposed while mounting');
    alpine.start();
    if (record.status !== 'starting')
      throw new Error(
        'Live/Alpine startup was disposed while initializing Alpine',
      );
    view.addEventListener('pagehide', pagehide);
    record.status = 'active';
    return application;
  } catch (error) {
    const alreadyDisposed = record.status === 'disposed';
    record.status = 'failed';
    view.removeEventListener('pagehide', pagehide);
    if (!alreadyDisposed) {
      try {
        client.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Live/Alpine startup and Live cleanup failed; reload the document',
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
