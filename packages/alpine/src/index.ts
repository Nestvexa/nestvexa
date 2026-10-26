/** Minimal public client operations consumed by the Alpine magic. */
export interface LiveClientBridge {
  call(element: Element, action: string): Promise<void>;
  get(element: Element, name: string): unknown;
  set(element: Element, name: string, value: string | number | boolean): void;
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
