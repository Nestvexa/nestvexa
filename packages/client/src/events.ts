import { LiveClientError, parseIdentifier } from './grammar.js';

/** Trusted dialog host context. This is presentation data, never authorization. */
export interface LiveConfirmation {
  readonly element: Element;
  readonly action: string;
  readonly message: string;
  readonly signal: AbortSignal;
}
export type LiveConfirm = (
  context: LiveConfirmation,
) => boolean | Promise<boolean>;

/** Static plain text only; no interpolation, HTML interpretation or executable modifiers. */
export function parseConfirmation(message: string): string {
  if (
    !message.trim() ||
    message.length > 1024 ||
    [...message].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'Confirmation requires 1–1024 characters of plain text',
    );
  return message;
}

interface ConfirmationRecord {
  readonly element: Element;
  readonly current: () => boolean;
  cancel(): void;
}
/** Bounded approval lifecycle; an uncooperative custom dialog cannot retain an unresolved operation. */
export function createConfirmationController(options: {
  readonly confirm: LiveConfirm;
  readonly timeoutMs?: number;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  readonly clearTimeout: (id: number) => void;
}) {
  const timeout = options.timeoutMs ?? 30_000;
  if (typeof options.confirm !== 'function')
    throw new LiveClientError(
      'DIRECTIVE',
      'Confirmation handler must be a function',
    );
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new LiveClientError(
      'DIRECTIVE',
      'Confirmation timeout must be an integer from 1 through 300000ms',
    );
  const active = new Map<Element, ConfirmationRecord>();
  let disposed = false;
  return {
    approve(
      element: Element,
      action: string,
      message: string,
      current: () => boolean,
    ): Promise<boolean> {
      const isCurrent = () => {
        try {
          return current() === true;
        } catch {
          return false;
        }
      };
      if (disposed || active.has(element) || !isCurrent())
        return Promise.resolve(false);
      if (active.size >= 16)
        return Promise.reject(
          new LiveClientError('DIRECTIVE', 'Confirmation capacity reached'),
        );
      return new Promise<boolean>((resolve, reject) => {
        const abort = new AbortController();
        const started = options.now();
        let done = false;
        function finish(approved: boolean, error?: Error): void {
          if (done) return;
          done = true;
          active.delete(element);
          options.clearTimeout(timer);
          if (!approved) abort.abort();
          if (error) reject(error);
          else resolve(approved);
        }
        active.set(element, {
          element,
          current: isCurrent,
          cancel: () => finish(false),
        });
        const timer = options.setTimeout(() => finish(false), timeout);
        const failed = () =>
          finish(
            false,
            new LiveClientError('DIRECTIVE', 'Live confirmation failed'),
          );
        try {
          void Promise.resolve(
            options.confirm(
              Object.freeze({ element, action, message, signal: abort.signal }),
            ),
          ).then((approved) => {
            if (done) return;
            if (typeof approved !== 'boolean') {
              failed();
              return;
            }
            const elapsed = options.now() - started;
            finish(
              approved &&
                !disposed &&
                isCurrent() &&
                Number.isFinite(elapsed) &&
                elapsed >= 0 &&
                elapsed < timeout,
            );
          }, failed);
        } catch {
          failed();
        }
      });
    },
    prune(): void {
      for (const record of active.values())
        if (!record.current()) record.cancel();
    },
    cancel(root: Element): void {
      for (const record of active.values())
        if (root === record.element || root.contains(record.element))
          record.cancel();
    },
    dispose(): void {
      disposed = true;
      for (const record of active.values()) record.cancel();
    },
  };
}

export interface EventDirective {
  readonly kind: 'click' | 'submit' | 'keydown';
  readonly action: string;
  readonly prevent: boolean;
  readonly stop: boolean;
  readonly self: boolean;
  readonly once: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly key?: string;
  readonly debounceMs?: number;
  readonly throttleMs?: number;
  /** Listen on the owning window/document while the declaring element stays owned. */
  readonly scope?: 'window' | 'document';
}
const keyNames: Readonly<Record<string, string>> = Object.freeze({
  enter: 'Enter',
  escape: 'Escape',
  space: ' ',
  tab: 'Tab',
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown',
});
const flags = new Set([
  'prevent',
  'stop',
  'self',
  'once',
  'ctrl',
  'alt',
  'shift',
  'meta',
]);
const parsedNames = new WeakMap<EventDirective, string>();
function invalid(): never {
  throw new LiveClientError(
    'DIRECTIVE',
    'Invalid or unsupported event modifier configuration',
  );
}

/** Parse only registered action identifiers and a closed modifier grammar. No expression evaluation. */
export function parseEventDirective(
  name: string,
  value: string,
): EventDirective {
  const [event, ...modifiers] = name.split('.');
  const kind = event?.slice(3);
  if (
    !event?.startsWith('nv:') ||
    (kind !== 'click' && kind !== 'submit' && kind !== 'keydown')
  )
    invalid();
  const enabled = new Set<string>();
  let key: string | undefined;
  let debounceMs: number | undefined;
  let throttleMs: number | undefined;
  let scope: 'window' | 'document' | undefined;
  for (let index = 0; index < modifiers.length; index++) {
    const modifier = modifiers[index];
    if (!modifier || enabled.has(modifier)) invalid();
    enabled.add(modifier);
    if (flags.has(modifier)) continue;
    if (modifier === 'window' || modifier === 'document') {
      // Global listeners exist for click/keydown only; one scope per binding.
      if (kind === 'submit' || scope !== undefined) invalid();
      scope = modifier;
      continue;
    }
    if (Object.hasOwn(keyNames, modifier)) {
      if (kind !== 'keydown' || key !== undefined) invalid();
      key = keyNames[modifier];
      continue;
    }
    if (modifier !== 'debounce' && modifier !== 'throttle') invalid();
    if (debounceMs !== undefined || throttleMs !== undefined) invalid();
    let interval = 250;
    const next = modifiers[index + 1];
    if (next !== undefined && /^\d+ms$/.test(next)) {
      interval = Number(next.slice(0, -2));
      index++;
    }
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000)
      invalid();
    if (modifier === 'debounce') debounceMs = interval;
    else throttleMs = interval;
  }
  // `.self` cannot match a global target and a window listener runs too late to stop propagation.
  if (scope !== undefined && (enabled.has('self') || enabled.has('stop')))
    invalid();
  const directive: EventDirective = Object.freeze({
    kind,
    action: parseIdentifier(value),
    prevent: enabled.has('prevent'),
    stop: enabled.has('stop'),
    self: enabled.has('self'),
    once: enabled.has('once'),
    ctrl: enabled.has('ctrl'),
    alt: enabled.has('alt'),
    shift: enabled.has('shift'),
    meta: enabled.has('meta'),
    ...(key === undefined ? {} : { key }),
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(throttleMs === undefined ? {} : { throttleMs }),
    ...(scope === undefined ? {} : { scope }),
  });
  parsedNames.set(directive, name);
  return directive;
}

export interface EventDispatcherOptions {
  readonly invoke: (element: Element, action: string) => Promise<void>;
  readonly onError?: (error: Error, element: Element) => void;
  /** Prevent native defaults for matching confirmation bindings, including suppressed repeats. */
  readonly preventDefault?: (element: Element) => boolean;
}
export interface EventDispatcher {
  /** True means this event was accepted, possibly scheduled for later execution. */
  handle(event: Event, element: Element, directive: EventDirective): boolean;
  /** Cancel timers and forget modifiers for detached or no-longer-owned nodes. */
  prune(root: Document | Element): void;
  /** Forget all modifier state for a subtree before it is removed. */
  cancel(root: Element): void;
  dispose(): void;
}
interface DispatchRecord {
  readonly element: Element;
  readonly signature: string;
  readonly directive: EventDirective;
  readonly owner: Element | null;
  readonly attribute: string | undefined;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  lastInvocation: number | undefined;
  consumed: boolean;
}
function signature(directive: EventDirective): string {
  return JSON.stringify([
    directive.kind,
    directive.action,
    directive.prevent,
    directive.stop,
    directive.self,
    directive.once,
    directive.ctrl,
    directive.alt,
    directive.shift,
    directive.meta,
    directive.key,
    directive.debounceMs,
    directive.throttleMs,
    directive.scope,
  ]);
}
function keyboard(event: Event, directive: EventDirective): boolean {
  // Public Event fields are read only for filtering and never copied into a server payload.
  const key: unknown = Reflect.get(event, 'key');
  if (
    directive.key !== undefined &&
    key !== directive.key &&
    !(directive.key === ' ' && key === 'Spacebar')
  )
    return false;
  for (const modifier of ['ctrl', 'alt', 'shift', 'meta'] as const)
    if (directive[modifier] && Reflect.get(event, `${modifier}Key`) !== true)
      return false;
  return true;
}
function currentAttribute(
  element: Element,
  directive: EventDirective,
): string | undefined {
  const attribute = parsedNames.get(directive);
  return attribute !== undefined && typeof element.getAttribute === 'function'
    ? attribute
    : undefined;
}
function sameConfiguration(record: DispatchRecord): boolean {
  return (
    record.element.closest('[data-nv-component]') === record.owner &&
    (record.attribute === undefined ||
      record.element.getAttribute(record.attribute) === record.directive.action)
  );
}

/** Bounded per-client modifier state. Throttling is leading-edge only, with no trailing invocation. */
export function createEventDispatcher(
  options: EventDispatcherOptions,
): EventDispatcher {
  const records = new WeakMap<Element, Map<string, DispatchRecord>>();
  const active = new Set<DispatchRecord>();
  let disposed = false;
  function remove(record: DispatchRecord): void {
    if (record.timer !== undefined) globalThis.clearTimeout(record.timer);
    record.timer = undefined;
    records.get(record.element)?.delete(record.signature);
    active.delete(record);
  }
  function prune(root?: Document | Element): void {
    for (const record of active)
      if (
        !record.element.isConnected ||
        !sameConfiguration(record) ||
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
        : new LiveClientError('DIRECTIVE', 'Live event action failed'),
      element,
    );
  }
  function invoke(record: DispatchRecord): void {
    record.timer = undefined;
    if (
      disposed ||
      !record.element.isConnected ||
      !sameConfiguration(record) ||
      record.element.matches(':disabled') ||
      record.consumed
    )
      return;
    if (record.directive.once) record.consumed = true;
    record.lastInvocation = Date.now();
    try {
      void options
        .invoke(record.element, record.directive.action)
        .catch((error: unknown) => report(error, record.element));
    } catch (error) {
      report(error, record.element);
    }
  }
  return {
    handle(event, element, directive): boolean {
      if (
        disposed ||
        !element.isConnected ||
        event.type !== directive.kind ||
        element.matches(':disabled') ||
        (directive.self && event.target !== element) ||
        !keyboard(event, directive)
      )
        return false;
      const attribute = currentAttribute(element, directive);
      if (
        attribute !== undefined &&
        element.getAttribute(attribute) !== directive.action
      )
        return false;
      if (options.preventDefault?.(element)) event.preventDefault();
      prune();
      const id = signature(directive);
      let entries = records.get(element);
      let record = entries?.get(id);
      if (!record) {
        if (active.size >= 1000) {
          report(
            new LiveClientError(
              'DIRECTIVE',
              'Live event modifier capacity reached',
            ),
            element,
          );
          return false;
        }
        entries ??= new Map();
        records.set(element, entries);
        record = {
          element,
          signature: id,
          directive,
          owner: element.closest('[data-nv-component]'),
          attribute,
          timer: undefined,
          lastInvocation: undefined,
          consumed: false,
        };
        entries.set(id, record);
        active.add(record);
      }
      if (
        record.consumed ||
        (directive.throttleMs !== undefined &&
          record.lastInvocation !== undefined &&
          Date.now() - record.lastInvocation < directive.throttleMs)
      )
        return false;
      if (directive.prevent) event.preventDefault();
      if (directive.stop) event.stopPropagation();
      if (directive.debounceMs !== undefined) {
        if (record.timer !== undefined) globalThis.clearTimeout(record.timer);
        const pending = record;
        pending.timer = globalThis.setTimeout(
          () => invoke(pending),
          directive.debounceMs,
        );
      } else invoke(record);
      return true;
    },
    prune(root): void {
      prune(root);
    },
    cancel(root): void {
      for (const record of active)
        if (record.element === root || root.contains(record.element))
          remove(record);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const record of active) remove(record);
    },
  };
}
