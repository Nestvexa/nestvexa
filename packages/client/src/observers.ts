import { LiveClientError, parseIdentifier } from './grammar.js';

export type ObserverDirective =
  | {
      readonly kind: 'poll';
      readonly value: string;
      readonly intervalMs: number;
    }
  | {
      readonly kind: 'intersect';
      readonly value: string;
      readonly once: boolean;
    };

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}

/** Background directives contain registered action identifiers, never executable expressions. */
export function parseObserverDirective(
  name: string,
  value: string,
): ObserverDirective {
  const poll = /^nv:poll(?:\.([1-9][0-9]*)(ms|s))?$/.exec(name);
  if (poll) {
    const intervalMs =
      poll[1] === undefined
        ? 2500
        : Number(poll[1]) * (poll[2] === 's' ? 1000 : 1);
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 3_600_000
    )
      invalid(
        'Polling interval must be from 1000 through 3600000 milliseconds',
      );
    return { kind: 'poll', value: parseIdentifier(value), intervalMs };
  }
  if (/^nv:intersect(?:\.once)?$/.test(name))
    return {
      kind: 'intersect',
      value: parseIdentifier(value),
      once: name.endsWith('.once'),
    };
  return invalid('Unsupported polling or intersection directive or modifier');
}

interface Plan {
  readonly element: Element;
  readonly owner: Element;
  readonly attribute: string;
  readonly directive: ObserverDirective;
}
function owned(element: Element, owner: Element): boolean {
  if (
    element.closest('[data-nv-component]') !== owner ||
    element.closest('[data-nv-island]')
  )
    return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (current.hasAttribute('nv:ignore')) return false;
    if (current === owner) return true;
  }
  return false;
}
function plans(root: Element): Plan[] {
  if (!root.hasAttribute('data-nv-component'))
    invalid('Observer directives require a Live component root');
  const result: Plan[] = [];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!owned(element, root)) continue;
    const kinds = new Set<string>();
    for (const attribute of element.attributes) {
      if (!/^nv:(?:poll|intersect)(?:\.|$)/.test(attribute.name)) continue;
      const directive = parseObserverDirective(attribute.name, attribute.value);
      if (kinds.has(directive.kind))
        invalid('Only one observer binding per kind is allowed on an element');
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        invalid('Observer directives require HTML elements');
      if (
        [...element.attributes].some((item) =>
          /^nv:confirm(?:\.|$)/.test(item.name),
        )
      )
        invalid(
          'Background observer actions cannot share an element with nv:confirm',
        );
      kinds.add(directive.kind);
      result.push({
        element,
        owner: root,
        attribute: attribute.name,
        directive,
      });
    }
  }
  return result;
}

/** Check owned directive grammar without creating observers, timers or network work. */
export function validateObservers(root: Element): void {
  plans(root);
}

export interface ObserverControllerOptions {
  readonly window: Window & typeof globalThis;
  readonly invoke: (element: Element, action: string) => Promise<void>;
  /** Must recheck the Live registration and its failure/ownership state before dispatch. */
  readonly usable: (element: Element) => boolean;
  readonly onError: (error: unknown, element: Element) => void;
  readonly maxRegistrations?: number;
}
export interface ObserverController {
  /** Reconcile a document, component or newly inserted subtree. Retained bindings keep their schedule/once status. */
  refresh(root: ParentNode): void;
  /** Release a subtree before detaching, replacing or handing it to another renderer. */
  remove(node: Element): void;
  /** Terminal; disposal never retries or replays an in-flight action. */
  dispose(): void;
}
interface Registration {
  readonly plan: Plan;
  timer: number | undefined;
  pending: boolean;
  failures: number;
  inside: boolean;
  attempted: boolean;
}

/** Bounded, visibility-aware scheduling. Existing Live transport owns admission, queues and cancellation. */
export function createObserverController(
  options: ObserverControllerOptions,
): ObserverController {
  const view = options.window;
  const document = view.document;
  const limit = options.maxRegistrations ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    invalid(
      'Observer registration capacity must be an integer from 1 through 1000',
    );
  const records = new Set<Registration>();
  let observer: IntersectionObserver | undefined;
  let disposed = false;
  function clearTimer(record: Registration): void {
    if (record.timer !== undefined) view.clearTimeout(record.timer);
    record.timer = undefined;
  }
  function release(record: Registration): void {
    clearTimer(record);
    if (record.plan.directive.kind === 'intersect')
      observer?.unobserve(record.plan.element);
    records.delete(record);
  }
  function valid(record: Registration): boolean {
    const { element, owner, attribute, directive } = record.plan;
    const declarations = [...element.attributes].filter(
      (item) =>
        item.name === `nv:${directive.kind}` ||
        item.name.startsWith(`nv:${directive.kind}.`),
    );
    return (
      element.isConnected &&
      owned(element, owner) &&
      declarations.length === 1 &&
      element.getAttribute(attribute) === directive.value &&
      ![...element.attributes].some((item) =>
        /^nv:confirm(?:\.|$)/.test(item.name),
      ) &&
      options.usable(element)
    );
  }
  function available(): boolean {
    return document.visibilityState !== 'hidden' && view.navigator.onLine;
  }
  function ready(record: Registration): boolean {
    return available() && !record.plan.element.matches(':disabled');
  }
  function arm(record: Registration): void {
    clearTimer(record);
    if (
      disposed ||
      !records.has(record) ||
      record.pending ||
      record.plan.directive.kind !== 'poll' ||
      !available()
    )
      return;
    const delay = Math.min(
      record.plan.directive.intervalMs * 2 ** Math.min(record.failures, 6),
      3_600_000,
    );
    record.timer = view.setTimeout(() => {
      record.timer = undefined;
      if (!valid(record)) {
        release(record);
        return;
      }
      if (ready(record)) invoke(record);
      else arm(record);
    }, delay);
  }
  function invoke(record: Registration): void {
    if (
      disposed ||
      !records.has(record) ||
      record.pending ||
      !valid(record) ||
      !ready(record)
    )
      return;
    record.pending = true;
    record.attempted = true;
    if (
      record.plan.directive.kind === 'intersect' &&
      record.plan.directive.once
    )
      observer?.unobserve(record.plan.element);
    // Promise normalization also handles synchronous host callbacks without leaking an unhandled rejection.
    void Promise.resolve()
      .then(() => {
        if (!disposed && records.has(record) && valid(record) && ready(record))
          return options.invoke(
            record.plan.element,
            record.plan.directive.value,
          );
        return undefined;
      })
      .then(
        () => {
          record.failures = 0;
        },
        (error: unknown) => {
          record.failures = Math.min(record.failures + 1, 6);
          if (!disposed && records.has(record) && valid(record))
            options.onError(error, record.plan.element);
        },
      )
      .finally(() => {
        record.pending = false;
        if (!disposed && records.has(record)) {
          if (valid(record)) arm(record);
          else release(record);
        }
      });
  }
  function intersections(entries: readonly IntersectionObserverEntry[]): void {
    if (disposed) return;
    for (const entry of entries) {
      const record = [...records].find(
        (candidate) =>
          candidate.plan.element === entry.target &&
          candidate.plan.directive.kind === 'intersect',
      );
      if (!record) continue;
      if (!valid(record)) {
        release(record);
        continue;
      }
      const inside = entry.isIntersecting;
      const entered = inside && !record.inside;
      record.inside = inside;
      if (
        entered &&
        !(
          record.plan.directive.kind === 'intersect' &&
          record.plan.directive.once &&
          record.attempted
        )
      )
        invoke(record);
    }
  }
  function environmentChanged(): void {
    for (const record of records) {
      if (!valid(record)) release(record);
      else arm(record);
    }
  }
  document.addEventListener('visibilitychange', environmentChanged);
  view.addEventListener('online', environmentChanged);
  view.addEventListener('offline', environmentChanged);
  return {
    refresh(root): void {
      if (disposed) return;
      const elements =
        root instanceof view.Element
          ? [root, ...root.querySelectorAll('[data-nv-component]')]
          : [...root.querySelectorAll('[data-nv-component]')];
      const owners = new Set(
        elements
          .map((element) => element.closest('[data-nv-component]'))
          .filter((element): element is Element => element !== null),
      );
      const next = [...owners]
        .filter((owner) => options.usable(owner))
        .flatMap((owner) => plans(owner))
        .filter((plan) => options.usable(plan.element));
      for (const record of records)
        if (
          !valid(record) ||
          (owners.has(record.plan.owner) &&
            !next.some(
              (plan) =>
                plan.element === record.plan.element &&
                plan.attribute === record.plan.attribute &&
                plan.directive.value === record.plan.directive.value,
            ))
        )
          release(record);
      const additions = next.filter(
        (plan) =>
          ![...records].some(
            (record) =>
              record.plan.element === plan.element &&
              record.plan.attribute === plan.attribute,
          ),
      );
      if (records.size + additions.length > limit)
        invalid('Live observer registration capacity reached');
      if (additions.some((plan) => plan.directive.kind === 'intersect')) {
        if (typeof view.IntersectionObserver !== 'function')
          invalid('nv:intersect requires IntersectionObserver support');
        observer ??= new view.IntersectionObserver(intersections, {
          threshold: [0],
        });
      }
      for (const plan of additions) {
        const record: Registration = {
          plan,
          timer: undefined,
          pending: false,
          failures: 0,
          inside: false,
          attempted: false,
        };
        records.add(record);
        if (plan.directive.kind === 'poll') arm(record);
        else observer?.observe(plan.element);
      }
    },
    remove(node): void {
      for (const record of records)
        if (record.plan.element === node || node.contains(record.plan.element))
          release(record);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('visibilitychange', environmentChanged);
      view.removeEventListener('online', environmentChanged);
      view.removeEventListener('offline', environmentChanged);
      for (const record of records) release(record);
      observer?.disconnect();
      observer = undefined;
    },
  };
}
