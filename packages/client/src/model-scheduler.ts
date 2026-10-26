import { LiveClientError, parseIdentifier } from './grammar.js';

export interface ModelTiming {
  readonly debounceMs?: number;
  readonly throttleMs?: number;
}
export interface ModelSchedulerOptions {
  readonly invoke: (element: Element, field: string) => Promise<void>;
  readonly onError?: (error: Error, element: Element) => void;
}
export interface ModelScheduler {
  /** Invalid identifiers, model configurations and timing options throw synchronously. */
  schedule(element: Element, field: string, timing?: ModelTiming): void;
  cancel(element: Element, field?: string): void;
  prune(root: Document | Element): void;
  /** Terminal: create another scheduler before mounting again. */
  dispose(): void;
}
interface ModelAttribute {
  readonly name: string;
  readonly value: string;
}
interface ModelRecord {
  readonly element: Element;
  readonly field: string;
  readonly attribute: ModelAttribute;
  readonly owner: Element | null;
  readonly debounceMs: number | undefined;
  readonly throttleMs: number | undefined;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
}
function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
function modelAttribute(element: Element): ModelAttribute | undefined {
  const attributes = Array.from(element.attributes).filter(
    ({ name }) => name === 'nv:model' || name.startsWith('nv:model.'),
  );
  if (attributes.length !== 1) return undefined;
  const attribute = attributes[0];
  return attribute === undefined
    ? undefined
    : { name: attribute.name, value: attribute.value };
}
function validateTiming(timing: ModelTiming): void {
  if (timing.debounceMs !== undefined && timing.throttleMs !== undefined)
    invalid('Model debounce and throttle cannot be combined');
  for (const interval of [timing.debounceMs, timing.throttleMs])
    if (
      interval !== undefined &&
      (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000)
    )
      invalid('Model timing must be an integer from 1 to 60000 milliseconds');
}
function sameConfiguration(record: ModelRecord): boolean {
  const attribute = modelAttribute(record.element);
  return (
    attribute?.name === record.attribute.name &&
    attribute.value === record.attribute.value &&
    record.element.closest('[data-nv-component]') === record.owner
  );
}
function eligible(record: ModelRecord): boolean {
  return (
    record.element.isConnected &&
    !record.element.matches(':disabled') &&
    withinOwnership(record.element, record.owner) &&
    sameConfiguration(record)
  );
}
function withinOwnership(element: Element, owner: Element | null): boolean {
  // An island ancestor also excludes a Live owner nested inside that island.
  if (element.closest('[data-nv-island]') !== null) return false;
  for (
    let current: Element | null = element;
    current && current !== owner;
    current = current.parentElement
  )
    if (current.hasAttribute('nv:ignore')) return false;
  return true;
}

/** Bounded model timing state. Throttle is leading-only; failed calls are never retried. */
export function createModelScheduler(
  options: ModelSchedulerOptions,
): ModelScheduler {
  const records = new WeakMap<Element, Map<string, ModelRecord>>();
  const active = new Set<ModelRecord>();
  let disposed = false;
  function remove(record: ModelRecord): void {
    if (record.timer !== undefined) globalThis.clearTimeout(record.timer);
    record.timer = undefined;
    records.get(record.element)?.delete(record.field);
    active.delete(record);
  }
  function cancel(element: Element, field?: string): void {
    const entries = records.get(element);
    if (field !== undefined) {
      const record = entries?.get(field);
      if (record !== undefined) remove(record);
    } else if (entries !== undefined)
      for (const record of entries.values()) remove(record);
  }
  function prune(root?: Document | Element): void {
    for (const record of active)
      if (
        !eligible(record) ||
        (root !== undefined &&
          record.element !== root &&
          !root.contains(record.element))
      )
        remove(record);
  }
  function report(error: unknown, element: Element): void {
    options.onError?.(
      error instanceof Error
        ? error
        : new LiveClientError('DIRECTIVE', 'Live model synchronization failed'),
      element,
    );
  }
  function invoke(record: ModelRecord): void {
    if (disposed || !eligible(record)) return;
    try {
      void options
        .invoke(record.element, record.field)
        .catch((error: unknown) => {
          report(error, record.element);
        });
    } catch (error) {
      report(error, record.element);
    }
  }
  return {
    schedule(element, field, timing = {}): void {
      if (disposed) return;
      parseIdentifier(field);
      validateTiming(timing);
      const attribute = modelAttribute(element);
      if (attribute === undefined || attribute.value !== field)
        invalid('Expected one model directive matching the scheduled field');
      prune();
      if (
        !element.isConnected ||
        element.matches(':disabled') ||
        !withinOwnership(element, element.closest('[data-nv-component]'))
      )
        return;
      let record = records.get(element)?.get(field);
      if (
        record !== undefined &&
        (record.debounceMs !== timing.debounceMs ||
          record.throttleMs !== timing.throttleMs)
      ) {
        remove(record);
        record = undefined;
      }
      if (record !== undefined && timing.throttleMs !== undefined) return;
      if (record === undefined) {
        record = {
          element,
          field,
          attribute,
          owner: element.closest('[data-nv-component]'),
          debounceMs: timing.debounceMs,
          throttleMs: timing.throttleMs,
          timer: undefined,
        };
        if (
          timing.debounceMs !== undefined ||
          timing.throttleMs !== undefined
        ) {
          if (active.size >= 1000)
            invalid('Live model modifier capacity reached');
          let entries = records.get(element);
          if (entries === undefined) {
            entries = new Map();
            records.set(element, entries);
          }
          entries.set(field, record);
          active.add(record);
        }
      }
      if (record.timer !== undefined) globalThis.clearTimeout(record.timer);
      const pending = record;
      if (timing.debounceMs !== undefined) {
        pending.timer = globalThis.setTimeout(() => {
          remove(pending);
          invoke(pending);
        }, timing.debounceMs);
      } else {
        if (timing.throttleMs !== undefined)
          pending.timer = globalThis.setTimeout(
            () => remove(pending),
            timing.throttleMs,
          );
        invoke(pending);
      }
    },
    cancel,
    prune,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const record of active) remove(record);
    },
  };
}
