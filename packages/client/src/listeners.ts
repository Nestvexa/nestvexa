export interface DirectEventBinding {
  readonly element: Element;
  readonly attribute: string;
  readonly event: 'click' | 'submit' | 'keydown';
  /** Listen on the element's own window/document instead of the element. */
  readonly scope?: 'window' | 'document' | undefined;
}
interface Entry {
  readonly event: string;
  readonly target: EventTarget;
  readonly listener: EventListener;
}

/**
 * Direct listeners are needed for .stop to run before native ancestor listeners,
 * and for .window/.document bindings. Each binding is keyed by its declaring
 * element, so removing or reconfiguring that element releases global listeners.
 */
export function createDirectEventListeners(
  handle: (event: Event, element: Element, attribute: string) => void,
) {
  const listeners = new Map<Element, Map<string, Entry>>();
  function release(entries: Map<string, Entry>): void {
    for (const { event, target, listener } of entries.values())
      target.removeEventListener(event, listener);
  }
  function dispose(): void {
    for (const entries of listeners.values()) release(entries);
    listeners.clear();
  }
  return {
    remove(root: Element): void {
      for (const [element, entries] of listeners)
        if (element === root || root.contains(element)) {
          release(entries);
          listeners.delete(element);
        }
    },
    sync(bindings: readonly DirectEventBinding[]): void {
      if (bindings.length > 1000)
        throw new Error('Live direct event listener capacity reached');
      const wanted = new Map<Element, Set<string>>();
      for (const binding of bindings) {
        const names = wanted.get(binding.element) ?? new Set<string>();
        names.add(binding.attribute);
        wanted.set(binding.element, names);
      }
      for (const [element, entries] of listeners) {
        for (const [name, entry] of entries)
          if (!wanted.get(element)?.has(name)) {
            entry.target.removeEventListener(entry.event, entry.listener);
            entries.delete(name);
          }
        if (entries.size === 0) listeners.delete(element);
      }
      for (const { element, attribute, event, scope } of bindings) {
        const entries = listeners.get(element) ?? new Map<string, Entry>();
        if (entries.has(attribute)) continue;
        const doc = element.ownerDocument;
        const target: EventTarget | null =
          scope === 'window'
            ? doc.defaultView
            : scope === 'document'
              ? doc
              : element;
        if (!target) continue;
        const listener: EventListener = (emitted) =>
          handle(emitted, element, attribute);
        target.addEventListener(event, listener);
        entries.set(attribute, { event, target, listener });
        listeners.set(element, entries);
      }
    },
    dispose,
  };
}
