export interface DirectEventBinding {
  readonly element: Element;
  readonly attribute: string;
  readonly event: 'click' | 'submit' | 'keydown';
}

/** Direct listeners are needed for .stop to run before native ancestor listeners. */
export function createDirectEventListeners(
  handle: (event: Event, element: Element, attribute: string) => void,
) {
  const listeners = new Map<
    Element,
    Map<string, { event: string; listener: EventListener }>
  >();
  function dispose(): void {
    for (const [element, entries] of listeners)
      for (const { event, listener } of entries.values())
        element.removeEventListener(event, listener);
    listeners.clear();
  }
  return {
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
            element.removeEventListener(entry.event, entry.listener);
            entries.delete(name);
          }
        if (entries.size === 0) listeners.delete(element);
      }
      for (const { element, attribute, event } of bindings) {
        const entries =
          listeners.get(element) ??
          new Map<string, { event: string; listener: EventListener }>();
        if (entries.has(attribute)) continue;
        const listener: EventListener = (emitted) =>
          handle(emitted, element, attribute);
        element.addEventListener(event, listener);
        entries.set(attribute, { event, listener });
        listeners.set(element, entries);
      }
    },
    dispose,
  };
}
