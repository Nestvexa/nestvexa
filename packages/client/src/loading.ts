import { LiveClientError, parseIdentifier } from './grammar.js';
import { boundClasses } from './bindings.js';
import { createFocusController } from './focus.js';
import type { FocusController } from './focus.js';

export type LoadingAttribute =
  'disabled' | 'readonly' | 'aria-disabled' | 'aria-busy';
export type LoadingDirective = (
  | {
      readonly kind: 'loading';
      readonly mode: 'show';
      readonly remove: boolean;
    }
  | {
      readonly kind: 'loading';
      readonly mode: 'class';
      readonly remove: boolean;
      readonly tokens: readonly string[];
    }
  | {
      readonly kind: 'loading';
      readonly mode: 'attr';
      readonly remove: boolean;
      readonly attribute: LoadingAttribute;
    }
) & {
  /** Activation delay; matching work that settles sooner never shows the effect. */
  readonly delayMs?: number;
};
const attributes = new Set<string>([
  'disabled',
  'readonly',
  'aria-disabled',
  'aria-busy',
]);
const readonlyInputTypes = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);
function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}

/** A closed presentation grammar; attribute values never become expressions or executable code. */
export function parseLoadingDirective(
  name: string,
  value: string,
): LoadingDirective {
  const match =
    /^nv:loading(?:\.(class|attr))?(\.remove)?(\.delay(?:\.(\d{1,5})ms)?)?$/.exec(
      name,
    );
  if (!match) return invalid('Unsupported loading directive or modifier');
  const remove = match[2] !== undefined;
  const delayMs = match[3] ? Number(match[4] ?? 200) : undefined;
  if (delayMs !== undefined && (delayMs < 1 || delayMs > 10_000))
    return invalid('Loading delay must be from 1 through 10000ms');
  const delay = delayMs === undefined ? {} : { delayMs };
  if (match[1] === undefined) {
    if (value !== '')
      return invalid('Loading visibility directives require an empty value');
    return { kind: 'loading', mode: 'show', remove, ...delay };
  }
  if (match[1] === 'class') {
    const tokens = value.trim().split(/\s+/);
    if (
      !value.trim() ||
      tokens.length > 16 ||
      new Set(tokens).size !== tokens.length ||
      tokens.some((token) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(token))
    )
      return invalid(
        'Loading classes require 1 through 16 unique simple class tokens',
      );
    return {
      kind: 'loading',
      mode: 'class',
      remove,
      tokens: Object.freeze(tokens),
      ...delay,
    };
  }
  if (!attributes.has(value))
    return invalid('Loading attribute is not allowlisted');
  // Membership in the fixed set above proves this union.
  return {
    kind: 'loading',
    mode: 'attr',
    remove,
    attribute: value as LoadingAttribute,
    ...delay,
  };
}

/** Targets are action identifiers or the explicit synchronization policy name, never method expressions. */
export function parseLoadingTarget(value: string): readonly string[] {
  const targets = value.split(',').map((target) => target.trim());
  if (targets.length > 16 || new Set(targets).size !== targets.length)
    return invalid(
      'Loading targets require 1 through 16 unique action identifiers',
    );
  for (const target of targets) if (target !== '$sync') parseIdentifier(target);
  return Object.freeze(targets);
}

interface Plan {
  readonly element: Element;
  readonly directives: readonly LoadingDirective[];
  readonly targets: readonly string[] | undefined;
  readonly delayMs: number | undefined;
  readonly signature: string;
}
function owns(root: Element, element: Element): boolean {
  if (
    root.closest('[data-nv-island]') ||
    element.closest('[data-nv-component]') !== root
  )
    return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute('nv:ignore') ||
      current.hasAttribute('data-nv-island')
    )
      return false;
    if (current === root) return true;
  }
  return false;
}
function plan(element: Element): Plan | undefined {
  const declarations = [...element.attributes].filter(
    (attribute) =>
      attribute.name === 'nv:loading' ||
      attribute.name.startsWith('nv:loading.'),
  );
  const target = element.getAttribute('nv:target');
  if (!declarations.length) {
    if (target !== null)
      invalid('nv:target requires a loading directive on the same element');
    return undefined;
  }
  const directives = declarations.map((attribute) =>
    parseLoadingDirective(attribute.name, attribute.value),
  );
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    invalid('Loading directives require HTML elements');
  const delayMs = directives[0]?.delayMs;
  if (directives.some((directive) => directive.delayMs !== delayMs))
    invalid('Loading declarations on one element share one delay');
  const properties = new Set<string>();
  for (const directive of directives) {
    const owned =
      directive.mode === 'class'
        ? directive.tokens.map((token) => `class:${token}`)
        : directive.mode === 'attr'
          ? [`attr:${directive.attribute}`]
          : ['attr:hidden', 'attr:aria-hidden'];
    for (const property of owned) {
      if (properties.has(property))
        invalid('Loading declarations cannot control the same property');
      properties.add(property);
    }
    if (
      directive.mode === 'class' &&
      boundClasses(element).some((token) => directive.tokens.includes(token))
    )
      invalid('Loading and nv:class cannot control the same class');
    if (
      directive.mode === 'show' &&
      (element.hasAttribute('nv:show') || element.hasAttribute('nv:dirty'))
    )
      invalid(
        'Loading visibility cannot share a target with nv:show or nv:dirty',
      );
    if (
      directive.mode === 'attr' &&
      element.getAttribute('nv:bind')?.split(':')[0] === directive.attribute
    )
      invalid('Loading and nv:bind cannot control the same attribute');
    if (
      directive.mode === 'attr' &&
      directive.attribute === 'disabled' &&
      ![
        'BUTTON',
        'INPUT',
        'SELECT',
        'TEXTAREA',
        'FIELDSET',
        'OPTGROUP',
        'OPTION',
      ].includes(element.tagName)
    )
      invalid('Loading disabled requires a native disableable form control');
    if (
      directive.mode === 'attr' &&
      directive.attribute === 'readonly' &&
      !(
        element.tagName === 'TEXTAREA' ||
        (element.tagName === 'INPUT' &&
          // HTML namespace and native input tag are established above.
          readonlyInputTypes.has((element as HTMLInputElement).type))
      )
    )
      invalid(
        'Loading readonly requires a supported text/date/number input or textarea',
      );
  }
  return {
    element,
    directives,
    targets: target === null ? undefined : parseLoadingTarget(target),
    delayMs,
    signature: JSON.stringify([
      declarations.map((attribute) => [attribute.name, attribute.value]).sort(),
      target,
      element.getAttribute('nv:bind'),
      element.getAttribute('nv:class'),
      element.hasAttribute('nv:show'),
      element.hasAttribute('nv:dirty'),
    ]),
  };
}
function plans(root: Element): Plan[] {
  if (!root.hasAttribute('data-nv-component'))
    invalid('Loading directives require a Live component root');
  const result: Plan[] = [];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!owns(root, element)) continue;
    const entry = plan(element);
    if (entry) {
      if (
        element === root &&
        entry.directives.some((directive) => directive.mode === 'show')
      )
        invalid('Loading visibility cannot hide the Live component root');
      if (
        element === root &&
        entry.directives.some(
          (directive) =>
            directive.mode === 'attr' && directive.attribute === 'aria-busy',
        )
      )
        invalid('The Live client owns aria-busy on the component root');
      result.push(entry);
    }
  }
  return result;
}
/** Validate owned loading grammar and property ownership without changing DOM or capturing state. */
export function validateLoading(root: Element): void {
  plans(root);
}

interface Effect {
  readonly kind: 'attr' | 'class';
  readonly key: string;
  baseline: string | null;
  applied: string | null;
  readonly directive: LoadingDirective;
}
interface RecordEntry {
  readonly root: Element;
  readonly plan: Plan;
  readonly effects: readonly Effect[];
  /** Pending delayed activation and whether the delay elapsed for current work. */
  timer?: ReturnType<typeof globalThis.setTimeout> | undefined;
  shown?: boolean;
}
function read(
  element: Element,
  effect: Pick<Effect, 'kind' | 'key'>,
): string | null {
  return effect.kind === 'class'
    ? element.classList.contains(effect.key)
      ? ''
      : null
    : element.getAttribute(effect.key);
}
function write(element: Element, effect: Effect, value: string | null): void {
  if (effect.kind === 'class')
    element.classList.toggle(effect.key, value !== null);
  else if (value === null) element.removeAttribute(effect.key);
  else element.setAttribute(effect.key, value);
  effect.applied = value;
}
function effects(entry: Plan): Effect[] {
  const result: Effect[] = [];
  const add = (
    kind: Effect['kind'],
    key: string,
    directive: LoadingDirective,
  ): void => {
    const baseline = read(entry.element, { kind, key });
    result.push({ kind, key, baseline, applied: baseline, directive });
  };
  for (const directive of entry.directives) {
    if (directive.mode === 'class')
      for (const token of directive.tokens) add('class', token, directive);
    else if (directive.mode === 'attr')
      add('attr', directive.attribute, directive);
    else {
      add('attr', 'hidden', directive);
      add('attr', 'aria-hidden', directive);
    }
  }
  return result;
}
function desired(effect: Effect, busy: boolean): string | null {
  if (effect.directive.mode === 'show') {
    const hidden = effect.directive.remove ? busy : !busy;
    return effect.key === 'hidden'
      ? hidden
        ? ''
        : null
      : hidden
        ? 'true'
        : 'false';
  }
  if (!busy) return effect.baseline;
  if (effect.directive.remove) return null;
  return effect.kind === 'attr' && effect.key.startsWith('aria-') ? 'true' : '';
}
export interface LoadingController {
  update(root: Element, pending: ReadonlyMap<string, number>): void;
  /** Restore captured properties and forget this root before server markup is applied. */
  restore(root: Element): void;
  /** Release detached, reparented, ignored or reconfigured elements. */
  prune(): void;
  dispose(): void;
}

/** Reversible presentation effects, independently counted by target action. Only activation delays use timers; no transport side effects. */
export function createLoadingController(
  sharedFocus?: FocusController,
): LoadingController {
  const focus = sharedFocus ?? createFocusController();
  const records = new Map<Element, RecordEntry>();
  function release(element: Element, record: RecordEntry): void {
    globalThis.clearTimeout(record.timer);
    for (const effect of record.effects)
      if (read(element, effect) === effect.applied)
        write(element, effect, effect.baseline);
    records.delete(element);
  }
  function apply(
    root: Element,
    element: Element,
    record: RecordEntry,
    busy: boolean,
  ): void {
    for (const effect of record.effects) {
      const current = read(element, effect);
      // Preserve later host writes as the next baseline rather than blindly overwriting them on cleanup.
      if (current !== effect.applied) effect.baseline = current;
      const value = desired(effect, busy);
      if (effect.key === 'hidden' && value !== null)
        focus.beforeHiding(root, element);
      write(element, effect, value);
    }
  }
  function prune(): void {
    focus.prune();
    for (const [element, record] of records) {
      let same = false;
      if (
        record.root.isConnected &&
        element.isConnected &&
        owns(record.root, element)
      ) {
        // Invalid replacement configuration is released here and rejected by the next validation/update.
        try {
          same = plan(element)?.signature === record.plan.signature;
        } catch {
          same = false;
        }
      }
      if (!same) release(element, record);
    }
  }
  return {
    update(root, pending): void {
      const next = plans(root);
      for (const [action, count] of pending) {
        if (action !== '$sync') parseIdentifier(action);
        if (!Number.isSafeInteger(count) || count < 0)
          invalid('Loading counts must be nonnegative safe integers');
      }
      // All owned configuration/counts have been checked before restoration or application.
      const selected = new Map(next.map((entry) => [entry.element, entry]));
      for (const [element, record] of records)
        if (
          record.root === root &&
          (!selected.has(element) ||
            selected.get(element)?.signature !== record.plan.signature)
        )
          release(element, record);
      for (const entry of next) {
        let record = records.get(entry.element);
        if (record && record.root !== root) {
          release(entry.element, record);
          record = undefined;
        }
        if (!record) {
          record = { root, plan: entry, effects: effects(entry) };
          records.set(entry.element, record);
        }
        const busy =
          entry.targets === undefined
            ? [...pending.values()].some((count) => count > 0)
            : entry.targets.some((target) => (pending.get(target) ?? 0) > 0);
        if (!busy) {
          globalThis.clearTimeout(record.timer);
          record.timer = undefined;
          record.shown = false;
        } else if (entry.delayMs !== undefined && !record.shown) {
          const delayed = record;
          delayed.timer ??= globalThis.setTimeout(() => {
            delayed.timer = undefined;
            // A released or reconfigured element keeps its restored baseline.
            if (records.get(entry.element) !== delayed) return;
            delayed.shown = true;
            apply(root, entry.element, delayed, true);
          }, entry.delayMs);
        }
        apply(
          root,
          entry.element,
          record,
          busy && (entry.delayMs === undefined || record.shown === true),
        );
      }
    },
    restore(root): void {
      for (const [element, record] of records)
        if (record.root === root) release(element, record);
    },
    prune,
    dispose(): void {
      for (const [element, record] of records) release(element, record);
      if (!sharedFocus) focus.dispose();
    },
  };
}
