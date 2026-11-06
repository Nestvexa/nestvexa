import { LiveClientError } from './grammar.js';
import { createFocusController } from './focus.js';
import type { FocusController } from './focus.js';
import { parseLoadingDirective } from './loading.js';
import type { LoadingDirective } from './loading.js';

type TransitionStage =
  'enter' | 'enter-start' | 'enter-end' | 'leave' | 'leave-start' | 'leave-end';
export type PresentationDirective =
  | { readonly kind: 'offline'; readonly effect: LoadingDirective }
  | {
      readonly kind: 'current';
      readonly exact: boolean;
      readonly tokens: readonly string[];
    }
  | {
      readonly kind: 'transition';
      readonly stage: TransitionStage;
      readonly tokens: readonly string[];
    };

function invalid(message: string): never {
  throw new LiveClientError('DIRECTIVE', message);
}
/** Static class tokens only. Values never become JavaScript, URLs or inline styles. */
function classes(value: string): readonly string[] {
  const tokens = value.trim().split(/\s+/);
  if (
    !value.trim() ||
    tokens.length > 16 ||
    new Set(tokens).size !== tokens.length ||
    tokens.some((token) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(token))
  )
    invalid('Presentation classes require 1 through 16 unique simple tokens');
  return Object.freeze(tokens);
}

/** Closed grammar. Unsupported modifiers fail before effects are applied. */
export function parsePresentationDirective(
  name: string,
  value: string,
): PresentationDirective {
  // Connectivity hints have no activation delay; `.delay` is loading-only.
  if (
    (name === 'nv:offline' || name.startsWith('nv:offline.')) &&
    !name.includes('.delay')
  )
    return {
      kind: 'offline',
      effect: parseLoadingDirective(
        name.replace('nv:offline', 'nv:loading'),
        value,
      ),
    };
  if (name === 'nv:current' || name === 'nv:current.exact')
    return {
      kind: 'current',
      exact: name.endsWith('.exact'),
      tokens: classes(value),
    };
  const match =
    /^nv:transition\.(enter|enter-start|enter-end|leave|leave-start|leave-end)$/.exec(
      name,
    );
  if (match) {
    // The regular expression restricts this value to the published stage union.
    return {
      kind: 'transition',
      stage: match[1] as TransitionStage,
      tokens: classes(value),
    };
  }
  return invalid('Unsupported presentation directive or modifier');
}

function owns(root: Element, element: Element): boolean {
  if (element.closest('[data-nv-component]') !== root) return false;
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
    if (current === root)
      return !root.parentElement?.closest('[data-nv-island]');
  }
  return false;
}
function declarations(element: Element): readonly Attr[] {
  return [...element.attributes].filter((attribute) =>
    /^(nv:offline|nv:current|nv:transition)(\.|$)/.test(attribute.name),
  );
}
interface Plan {
  readonly root: Element;
  readonly element: Element;
  readonly directives: readonly PresentationDirective[];
  readonly signature: string;
}
function properties(directive: PresentationDirective): string[] {
  if (directive.kind !== 'offline')
    return directive.tokens.map((token) => `class:${token}`);
  const effect = directive.effect;
  return effect.mode === 'class'
    ? effect.tokens.map((token) => `class:${token}`)
    : effect.mode === 'attr'
      ? [`attr:${effect.attribute}`]
      : ['attr:hidden', 'attr:aria-hidden'];
}
function plan(root: Element, element: Element): Plan | undefined {
  const attrs = declarations(element);
  if (!attrs.length) return undefined;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    invalid('Presentation directives require HTML elements');
  const directives = attrs.map((attribute) =>
    parsePresentationDirective(attribute.name, attribute.value),
  );
  const claimed = new Set<string>();
  // Transition stage classes may intentionally overlap each other, but cannot
  // share a token with an independently managed presentation effect.
  const transitionTokens = new Set(
    directives
      .filter((entry) => entry.kind === 'transition')
      .flatMap(properties),
  );
  for (const directive of directives) {
    if (directive.kind === 'transition') continue;
    for (const property of properties(directive)) {
      if (claimed.has(property) || transitionTokens.has(property))
        invalid('Presentation directives cannot control the same property');
      claimed.add(property);
    }
    if (directive.kind === 'current') {
      if (element.tagName !== 'A' || !element.hasAttribute('href'))
        invalid('nv:current requires an anchor with href');
      route(element, root.ownerDocument.defaultView);
    }
    if (directive.kind === 'offline') {
      const effect = directive.effect;
      if (effect.mode === 'show') {
        if (
          element === root ||
          ['nv:show', 'nv:dirty'].some((name) => element.hasAttribute(name)) ||
          [...element.attributes].some((attribute) =>
            /^nv:loading(?:\.remove)?$/.test(attribute.name),
          )
        )
          invalid(
            'Offline visibility requires a non-root element with exclusive visibility ownership',
          );
      } else if (effect.mode === 'attr') {
        if (effect.attribute === 'aria-busy' && element === root)
          invalid('The Live client owns root aria-busy');
        if (
          effect.attribute === 'disabled' &&
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
          invalid('Offline disabled requires a native form control');
        if (
          effect.attribute === 'readonly' &&
          !(
            element.tagName === 'TEXTAREA' ||
            (element.tagName === 'INPUT' &&
              /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/.test(
                element.getAttribute('type') ?? 'text',
              ))
          )
        )
          invalid(
            'Offline readonly requires a supported native input or textarea',
          );
      }
    }
  }
  for (const attribute of [...element.attributes]) {
    if (attribute.name.startsWith('nv:loading')) {
      if (attribute.name === 'nv:target') continue;
      const loading = parseLoadingDirective(attribute.name, attribute.value);
      for (const property of properties({ kind: 'offline', effect: loading }))
        if (claimed.has(property) || transitionTokens.has(property))
          invalid(
            'Loading and presentation effects cannot control the same property',
          );
    }
  }
  const binding = element.getAttribute('nv:bind')?.split(':')[0];
  if (binding && claimed.has(`attr:${binding}`))
    invalid(
      'Binding and presentation effects cannot control the same attribute',
    );
  return {
    root,
    element,
    directives,
    signature: JSON.stringify([
      attrs.map((attribute) => [attribute.name, attribute.value]).sort(),
      element.getAttribute('href'),
      element.getAttribute('nv:bind'),
      element.getAttribute('nv:show'),
      element.getAttribute('nv:dirty'),
      [...element.attributes]
        .filter((attribute) => attribute.name.startsWith('nv:loading'))
        .map((attribute) => [attribute.name, attribute.value]),
    ]),
  };
}
function plans(root: Element): Plan[] {
  if (!root.hasAttribute('data-nv-component'))
    invalid('Presentation requires a Live root');
  const result: Plan[] = [];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!owns(root, element)) continue;
    const entry = plan(root, element);
    if (entry) result.push(entry);
  }
  return result;
}
/** Validate owned declarations, HTML applicability, URL safety and effect conflicts. */
export function validatePresentation(root: Element): void {
  plans(root);
}
function route(element: Element, view: Window | null): URL {
  if (!view) return invalid('A browser window is required for nv:current');
  const href = element.getAttribute('href') ?? '';
  if (
    !href.trim() ||
    [...href].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid(
      'Current links require a nonempty URL without control characters or spaces',
    );
  let target: URL;
  try {
    target = new URL(href, view.location.href);
  } catch {
    return invalid('Invalid current link URL');
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.origin !== view.location.origin ||
    target.username ||
    target.password
  )
    invalid(
      'Current links must use same-origin HTTP(S) URLs without credentials',
    );
  return target;
}
function current(entry: Plan, exact: boolean, view: Window): boolean {
  const path = (value: string): string =>
    value.length > 1 ? value.replace(/\/+$/, '') : value;
  const target = path(route(entry.element, view).pathname);
  const location = path(view.location.pathname);
  return (
    location === target ||
    (!exact && target !== '/' && location.startsWith(`${target}/`))
  );
}
interface Effect {
  readonly key: string;
  readonly kind: 'class' | 'attr';
  readonly directive: Exclude<PresentationDirective, { kind: 'transition' }>;
  baseline: string | null;
  applied: string | null;
}
interface RecordEntry {
  readonly plan: Plan;
  readonly effects: readonly Effect[];
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
  return entry.directives
    .filter((directive) => directive.kind !== 'transition')
    .flatMap((directive) =>
      properties(directive).map((property) => {
        const separator = property.indexOf(':');
        const kind =
          property.slice(0, separator) === 'class' ? 'class' : 'attr';
        const key = property.slice(separator + 1);
        const baseline = read(entry.element, { kind, key });
        return { kind, key, baseline, applied: baseline, directive };
      }),
    );
}

export interface PresentationController {
  refresh(component: Element): void;
  /** Commit initial visibility immediately, then animate later visibility changes. */
  show(element: Element, shown: boolean, apply: () => void): void;
  /** Restore effects before applying fresh server markup; retain request connectivity state. */
  restore(component: Element): void;
  setNetworkFailure(component: Element, failed: boolean): void;
  /** Run owned CSS enter/leave phases; false means cancellation, rejection or disposal. */
  enter(node: Element): Promise<boolean>;
  leave(node: Element): Promise<boolean>;
  remove(node: Element): void;
  dispose(): void;
}
export interface PresentationOptions {
  readonly window: Window;
  readonly onError: (error: unknown, element: Element) => void;
  readonly focus?: FocusController;
}
interface RunningTransition {
  cancel(): void;
}
interface VisibilityState {
  readonly shown: boolean;
  apply(): void;
  release?: () => void;
}
/** Reversible effects and bounded CSS transitions. Connectivity indicators never suppress requests. */
export function createPresentationController(
  options: PresentationOptions,
): PresentationController {
  const view = options.window;
  const focus = options.focus ?? createFocusController();
  const records = new Map<Element, RecordEntry>();
  const roots = new Set<Element>();
  const failures = new Set<Element>();
  const running = new Map<Element, RunningTransition>();
  const visibility = new Map<Element, VisibilityState>();
  const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  function release(element: Element, record: RecordEntry): void {
    for (const effect of record.effects)
      if (read(element, effect) === effect.applied)
        write(element, effect, effect.baseline);
    records.delete(element);
  }
  function prune(): void {
    focus.prune();
    for (const root of roots)
      if (!root.isConnected || !owns(root, root)) {
        roots.delete(root);
        failures.delete(root);
      }
    for (const [element, record] of records) {
      let same = false;
      try {
        same =
          element.isConnected &&
          owns(record.plan.root, element) &&
          plan(record.plan.root, element)?.signature === record.plan.signature;
      } catch {
        /* Release obsolete declarations; refresh reports the new validation error. */
      }
      if (!same) release(element, record);
    }
    for (const [element, transition] of running)
      if (
        !element.isConnected ||
        !owns(element.closest('[data-nv-component]') ?? element, element)
      )
        transition.cancel();
    for (const [element, state] of visibility)
      if (
        !element.isConnected ||
        !owns(element.closest('[data-nv-component]') ?? element, element)
      ) {
        state.release?.();
        visibility.delete(element);
      }
  }
  function refresh(root: Element): void {
    if (disposed) return;
    prune();
    let next: Plan[];
    try {
      next = plans(root);
    } catch (error) {
      options.onError(error, root);
      return;
    }
    roots.add(root);
    for (const entry of next) {
      let record = records.get(entry.element);
      if (!record) {
        record = { plan: entry, effects: effects(entry) };
        records.set(entry.element, record);
      }
      let blockedVisibility = false;
      for (const effect of record.effects) {
        if (blockedVisibility && effect.key === 'aria-hidden') continue;
        const actual = read(entry.element, effect);
        if (actual !== effect.applied) effect.baseline = actual;
        let value: string | null;
        if (effect.directive.kind === 'current')
          value = current(entry, effect.directive.exact, view)
            ? ''
            : effect.baseline;
        else {
          const directive = effect.directive.effect;
          const offline = !view.navigator.onLine || failures.has(root);
          if (directive.mode === 'show') {
            const hidden = directive.remove ? offline : !offline;
            value =
              effect.key === 'hidden'
                ? hidden
                  ? ''
                  : null
                : hidden
                  ? 'true'
                  : 'false';
          } else
            value = !offline
              ? effect.baseline
              : directive.remove
                ? null
                : effect.key.startsWith('aria-')
                  ? 'true'
                  : '';
        }
        if (
          (effect.key === 'hidden' && value !== null) ||
          (effect.key === 'disabled' && value !== null)
        ) {
          focus.beforeHiding(root, entry.element);
          const active = root.ownerDocument.activeElement;
          if (active && entry.element.contains(active)) {
            if (effect.key === 'hidden') blockedVisibility = true;
            options.onError(
              new LiveClientError(
                'DIRECTIVE',
                'Cannot make focused content unavailable without a focus fallback',
              ),
              entry.element,
            );
            continue;
          }
        }
        write(entry.element, effect, value);
      }
    }
  }
  function restore(root: Element): void {
    for (const [element, record] of records)
      if (record.plan.root === root) release(element, record);
    for (const element of visibility.keys())
      if (element.closest('[data-nv-component]') === root) {
        const state = visibility.get(element);
        state?.release?.();
        if (state)
          visibility.set(element, { shown: state.shown, apply: state.apply });
      }
    for (const [element, transition] of running)
      if (element.closest('[data-nv-component]') === root) transition.cancel();
  }
  function refreshAll(): void {
    for (const root of [...roots]) refresh(root);
  }
  function reduced(): void {
    if (!motion.matches) return;
    for (const transition of running.values()) transition.cancel();
    for (const [element, state] of visibility) {
      const root = element.closest('[data-nv-component]');
      if (!state.shown && state.release && root && owns(root, element)) {
        delete state.release;
        state.apply();
      }
    }
  }
  view.addEventListener('online', refreshAll);
  view.addEventListener('offline', refreshAll);
  view.addEventListener('popstate', refreshAll);
  motion.addEventListener('change', reduced);
  function run(element: Element, phase: 'enter' | 'leave'): Promise<boolean> {
    running.get(element)?.cancel();
    const root = element.closest('[data-nv-component]');
    if (disposed || !root || !owns(root, element) || !element.isConnected)
      return Promise.resolve(false);
    let entry: Plan | undefined;
    try {
      entry = plan(root, element);
    } catch (error) {
      options.onError(error, element);
      return Promise.resolve(false);
    }
    const directives = entry?.directives.filter(
      (directive) => directive.kind === 'transition',
    );
    if (!directives?.length || motion.matches) return Promise.resolve(true);
    const active = directives
      .filter((directive) => directive.stage === phase)
      .flatMap((directive) => [...directive.tokens]);
    const start = directives
      .filter((directive) => directive.stage === `${phase}-start`)
      .flatMap((directive) => [...directive.tokens]);
    const end = directives
      .filter((directive) => directive.stage === `${phase}-end`)
      .flatMap((directive) => [...directive.tokens]);
    if (!active.length && !start.length && !end.length)
      return Promise.resolve(true);
    const baselines = new Map(
      [...new Set([...active, ...start, ...end])].map((token) => [
        token,
        element.classList.contains(token),
      ]),
    );
    const applied = new Map<string, boolean>();
    return new Promise<boolean>((resolve) => {
      let frame = 0;
      let timer = 0;
      let settled = false;
      function set(tokens: readonly string[], present: boolean): void {
        for (const token of tokens) {
          element.classList.toggle(token, present);
          applied.set(token, present);
        }
      }
      function finish(success: boolean): void {
        if (settled) return;
        settled = true;
        view.cancelAnimationFrame(frame);
        view.clearTimeout(timer);
        element.removeEventListener('transitioncancel', cancelled);
        for (const [token, baseline] of baselines)
          if (element.classList.contains(token) === applied.get(token))
            element.classList.toggle(token, baseline);
        running.delete(element);
        resolve(success);
      }
      function cancelled(event: Event): void {
        if (event.target === element) finish(false);
      }
      running.set(element, { cancel: () => finish(false) });
      element.addEventListener('transitioncancel', cancelled);
      set(end, false);
      set(active, true);
      set(start, true);
      // Two animation frames commit the start styles before the end styles.
      frame = view.requestAnimationFrame(() => {
        frame = view.requestAnimationFrame(() => {
          if (!element.isConnected || !owns(root, element)) {
            finish(false);
            return;
          }
          set(start, false);
          set(end, true);
          const style = view.getComputedStyle(element);
          const milliseconds = (value: string): number =>
            Number.parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
          const durations = style.transitionDuration
            .split(',')
            .map(milliseconds);
          const delays = style.transitionDelay.split(',').map(milliseconds);
          const duration = Math.max(
            0,
            ...style.transitionProperty
              .split(',')
              .map((property, index) =>
                property.trim() === 'none'
                  ? 0
                  : (durations[index % durations.length] ?? 0) +
                    (delays[index % delays.length] ?? 0),
              ),
          );
          if (!Number.isFinite(duration) || duration > 5000) {
            options.onError(
              new LiveClientError(
                'DIRECTIVE',
                'Presentation transitions require a finite CSS duration of at most 5 seconds',
              ),
              element,
            );
            finish(false);
            return;
          }
          if (duration === 0) finish(true);
          else
            timer = view.setTimeout(
              () => finish(element.isConnected && owns(root, element)),
              duration + 34,
            );
        });
      });
    });
  }
  function transition(
    node: Element,
    phase: 'enter' | 'leave',
  ): Promise<boolean> {
    const root = node.closest('[data-nv-component]');
    if (!root) return Promise.resolve(false);
    return Promise.all(
      [node, ...node.querySelectorAll('*')]
        .filter((element) => owns(root, element))
        .map((element) => run(element, phase)),
    ).then((results) => results.every(Boolean));
  }
  return {
    refresh,
    restore,
    show(element, shown, apply): void {
      if (disposed) return;
      const root = element.closest('[data-nv-component]');
      if (!root || !owns(root, element)) return;
      const previous = visibility.get(element);
      if (previous?.shown === shown) {
        previous.apply = apply;
        if (!previous.release) apply();
        return;
      }
      previous?.release?.();
      running.get(element)?.cancel();
      const state: VisibilityState = { shown, apply };
      visibility.set(element, state);
      let animated = false;
      try {
        animated =
          plan(root, element)?.directives.some(
            (directive) =>
              directive.kind === 'transition' &&
              directive.stage.startsWith(shown ? 'enter' : 'leave'),
          ) ?? false;
      } catch (error) {
        options.onError(error, element);
      }
      if (!previous || !animated || motion.matches) {
        apply();
        return;
      }
      if (shown) {
        apply();
        void run(element, 'enter');
      } else {
        focus.beforeHiding(root, element);
        const active = root.ownerDocument.activeElement;
        if (active && element.contains(active)) {
          visibility.delete(element);
          options.onError(
            new LiveClientError(
              'DIRECTIVE',
              'Cannot hide focused content without a focus fallback',
            ),
            element,
          );
          return;
        }
        const baseline = element.getAttribute('aria-hidden');
        state.release = () => {
          if (element.getAttribute('aria-hidden') !== 'true') return;
          if (baseline === null) element.removeAttribute('aria-hidden');
          else element.setAttribute('aria-hidden', baseline);
        };
        // A synchronous morph may already have projected the new hidden
        // attribute. Prior desired visibility still owns this retained leave.
        element.removeAttribute('hidden');
        element.setAttribute('aria-hidden', 'true');
        void run(element, 'leave').then((completed) => {
          if (
            completed &&
            !disposed &&
            visibility.get(element) === state &&
            element.isConnected &&
            owns(root, element)
          ) {
            delete state.release;
            state.apply();
          } else if (visibility.get(element) === state) {
            state.release?.();
            visibility.delete(element);
          }
        });
      }
    },
    setNetworkFailure(root, failed): void {
      if (disposed) return;
      if (failed) failures.add(root);
      else failures.delete(root);
      refresh(root);
    },
    enter: (node) => transition(node, 'enter'),
    leave: (node) => transition(node, 'leave'),
    remove(node): void {
      for (const [element, entry] of records)
        if (node === element || node.contains(element)) release(element, entry);
      for (const root of roots)
        if (node === root || node.contains(root)) {
          roots.delete(root);
          failures.delete(root);
        }
      for (const [element, entry] of running)
        if (node === element || node.contains(element)) entry.cancel();
      for (const [element, state] of visibility)
        if (node === element || node.contains(element)) {
          state.release?.();
          visibility.delete(element);
        }
      focus.release(node);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      view.removeEventListener('online', refreshAll);
      view.removeEventListener('offline', refreshAll);
      view.removeEventListener('popstate', refreshAll);
      motion.removeEventListener('change', reduced);
      for (const [element, entry] of records) release(element, entry);
      for (const entry of running.values()) entry.cancel();
      roots.clear();
      failures.clear();
      for (const state of visibility.values()) state.release?.();
      visibility.clear();
      if (!options.focus) focus.dispose();
    },
  };
}
