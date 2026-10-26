import { morphChildren, validateFragment } from './morph.js';
import { applyBindings, queryRefs } from './bindings.js';
import { createEventDispatcher, parseEventDirective } from './events.js';
import type { EventDispatcher, EventDirective } from './events.js';
import { createDirectEventListeners } from './listeners.js';
import type { DirectEventBinding } from './listeners.js';
export { parseEventDirective } from './events.js';
export type { EventDirective } from './events.js';
import {
  LiveClientError,
  parseDirective,
  parseIdentifier,
  parseLiveResponse,
} from './protocol.js';
export {
  LiveClientError,
  parseDirective,
  parseIdentifier,
  parseLiveResponse,
} from './protocol.js';
export type { LiveDirective, LiveResponse } from './protocol.js';

export interface LiveClientOptions {
  readonly root?: Document | Element;
  readonly fetch?: typeof fetch;
  readonly onError?: (error: Error, component: Element | null) => void;
}
export interface LiveClient {
  mount(): void;
  dispose(): void;
  call(element: Element, action: string): Promise<void>;
  get(element: Element, name: string): unknown;
  set(element: Element, name: string, value: string | number | boolean): void;
  refs(element: Element): ReadonlyMap<string, Element>;
}
type Field = string | number | boolean;
const componentOwners = new WeakMap<Element, symbol>();
interface Component {
  readonly root: Element;
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly csrf: string;
  snapshot: string;
  revision: number;
  values: Readonly<Record<string, unknown>>;
  readonly dirty: Map<string, { value: Field; version: number }>;
  fieldVersion: number;
  queue: Promise<void>;
  pending: number;
  submitting: boolean;
  active: boolean;
  request: AbortController | null;
}
function owner(element: Element): Element | null {
  return element.closest('[data-nv-component]');
}
function owned(component: Element): Element[] {
  return [component, ...component.querySelectorAll('*')].filter(
    (element) => owner(element) === component && !ignored(element, component),
  );
}
function ignored(element: Element, component: Element): boolean {
  for (
    let parent: Element | null = element;
    parent && parent !== component;
    parent = parent.parentElement
  )
    if (
      parent.hasAttribute('nv:ignore') ||
      parent.hasAttribute('data-nv-island')
    )
      return true;
  return false;
}
function validateDirectives(component: Element): void {
  for (const element of owned(component)) {
    for (const kind of ['click', 'submit', 'keydown'])
      if (
        [...element.attributes].filter(
          (attribute) =>
            attribute.name === `nv:${kind}` ||
            attribute.name.startsWith(`nv:${kind}.`),
        ).length > 1
      )
        throw new LiveClientError(
          'DIRECTIVE',
          'Only one binding per event type is allowed on an element',
        );
    for (const attribute of element.attributes)
      if (attribute.name.startsWith('nv:')) {
        const directive = parseDirective(attribute.name, attribute.value);
        if (directive.kind === 'submit' && element.tagName !== 'FORM')
          throw new LiveClientError('DIRECTIVE', 'nv:submit requires a form');
        if (directive.kind === 'model') {
          const input = element as HTMLInputElement;
          if (
            element.tagName !== 'TEXTAREA' &&
            !(
              element.tagName === 'INPUT' &&
              [
                'text',
                'number',
                'checkbox',
                'email',
                'search',
                'tel',
                'url',
                'password',
              ].includes(input.type)
            )
          )
            throw new LiveClientError(
              'DIRECTIVE',
              'nv:model supports text, number, checkbox inputs and textareas',
            );
        }
      }
  }
}
function selection(element: Element | null): {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
} | null {
  if (!element || !['INPUT', 'TEXTAREA'].includes(element.tagName)) return null;
  const field = element as HTMLInputElement;
  if (field.selectionStart === null || field.selectionEnd === null) return null;
  return {
    start: field.selectionStart,
    end: field.selectionEnd,
    direction: field.selectionDirection ?? 'none',
  };
}

/** Explicit, idempotent browser startup. Importing this module does not touch DOM globals. */
export function createLiveClient(options: LiveClientOptions = {}): LiveClient {
  const ownership = Symbol('nestvexa-client');
  let rejected = new WeakSet<Element>();
  const root = options.root ?? globalThis.document;
  if (!root)
    throw new LiveClientError(
      'MARKER',
      'Live client requires a browser document',
    );
  const ownerDocument =
    root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!ownerDocument?.defaultView)
    throw new LiveClientError(
      'MARKER',
      'Live client requires an attached document',
    );
  const doc = ownerDocument;
  const view = doc.defaultView;
  if (!view)
    throw new LiveClientError(
      'MARKER',
      'Live client requires a browser window',
    );
  const window = view;
  const transport = options.fetch ?? window.fetch.bind(window);
  const components = new Map<Element, Component>();
  let mounted = false;
  let observer: MutationObserver | null = null;
  let dispatcher: EventDispatcher | undefined;
  const handledEvents = new WeakSet<Event>();
  const direct = createDirectEventListeners((event, element, attribute) => {
    try {
      const binding = resolveEvent(event);
      if (binding?.element === element && binding.attribute === attribute)
        dispatchEvent(event, binding);
    } catch (error) {
      report(error, element);
    }
  });
  function report(error: unknown, component: Element | null): void {
    const safe =
      error instanceof Error
        ? error
        : new LiveClientError('RESPONSE', 'Live request failed');
    if (options.onError) options.onError(safe, component);
    else
      component?.dispatchEvent(
        new window.CustomEvent('nestvexa:error', {
          bubbles: true,
          detail: {
            code: safe instanceof LiveClientError ? safe.code : 'NETWORK',
          },
        }),
      );
  }
  function contains(element: Element): boolean {
    return element.isConnected && (element === root || root.contains(element));
  }
  function busy(state: Component): void {
    state.root.setAttribute('aria-busy', state.pending ? 'true' : 'false');
    for (const element of owned(state.root))
      if (element.hasAttribute('nv:loading')) {
        element.toggleAttribute('hidden', state.pending === 0);
        element.setAttribute('aria-hidden', state.pending ? 'false' : 'true');
      }
  }
  function discover(): void {
    dispatcher?.prune(root);
    for (const [element, state] of components)
      if (!contains(element)) {
        state.active = false;
        state.request?.abort();
        components.delete(element);
        if (componentOwners.get(element) === ownership)
          componentOwners.delete(element);
      }
    const markers = [...root.querySelectorAll('[data-nv-component]')];
    if (
      root.nodeType === 1 &&
      (root as Element).hasAttribute('data-nv-component')
    )
      markers.unshift(root as Element);
    for (const element of markers)
      if (
        contains(element) &&
        !components.has(element) &&
        !rejected.has(element) &&
        !element.closest('[data-nv-island]')
      ) {
        try {
          if (componentOwners.has(element))
            throw new LiveClientError(
              'MARKER',
              'Live component already belongs to another client instance',
            );
          validateDirectives(element);
          const id = element.getAttribute('data-nv-component');
          const name = element.getAttribute('data-nv-name');
          const snapshot = element.getAttribute('data-nv-snapshot');
          const csrf = element.getAttribute('data-nv-csrf');
          const revision = element.getAttribute('data-nv-revision');
          const endpointValue = element.getAttribute('data-nv-endpoint');
          const encodedState = element.getAttribute('data-nv-state');
          if (
            !id ||
            !name ||
            !snapshot ||
            !csrf ||
            !revision ||
            !/^\d+$/.test(revision) ||
            !Number.isSafeInteger(Number(revision)) ||
            !endpointValue
          )
            throw new LiveClientError(
              'MARKER',
              'Incomplete Live component marker',
            );
          if ([...components.values()].some((component) => component.id === id))
            throw new LiveClientError(
              'MARKER',
              'Duplicate Live component identity',
            );
          const endpoint = new URL(endpointValue, doc.baseURI);
          if (
            endpoint.origin !== window.location.origin ||
            endpoint.search ||
            endpoint.hash ||
            endpoint.username ||
            endpoint.password
          )
            throw new LiveClientError(
              'MARKER',
              'Live endpoint must be same-origin without query, fragment or credentials',
            );
          if (!encodedState || encodedState.length > 65_536)
            throw new LiveClientError(
              'MARKER',
              'Missing or oversized initial state',
            );
          const values: unknown = JSON.parse(encodedState);
          if (!values || typeof values !== 'object' || Array.isArray(values))
            throw new LiveClientError(
              'MARKER',
              'Initial state must be an object',
            );
          for (const key of Object.keys(values)) parseIdentifier(key);
          const state: Component = {
            root: element,
            id,
            name,
            snapshot,
            csrf,
            revision: Number(revision),
            values: values as Record<string, unknown>,
            endpoint: endpoint.href.replace(/\/$/, ''),
            dirty: new Map(),
            fieldVersion: 0,
            queue: Promise.resolve(),
            pending: 0,
            submitting: false,
            active: true,
            request: null,
          };
          refreshBindings(state);
          components.set(element, state);
          componentOwners.set(element, ownership);
          busy(state);
        } catch (error) {
          rejected.add(element);
          report(error, element);
        }
      }
    try {
      syncDirectListeners();
    } catch (error) {
      report(error, null);
    }
  }
  async function invoke(state: Component, action: string): Promise<void> {
    if (!state.active || !mounted || !contains(state.root)) return;
    const sent = new Map(state.dirty);
    const updates: Record<string, Field> = Object.create(null) as Record<
      string,
      Field
    >;
    for (const [key, field] of sent) updates[key] = field.value;
    const requestId = window.crypto.randomUUID();
    const abort = new AbortController();
    state.request = abort;
    try {
      const response = await transport(`${state.endpoint}/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-nestvexa-csrf': state.csrf,
        },
        signal: abort.signal,
        body: JSON.stringify({
          protocol: 'nestvexa-live/1',
          requestId,
          snapshot: state.snapshot,
          revision: state.revision,
          updates,
          input: null,
        }),
      });
      if (!response.ok)
        throw new LiveClientError(
          'HTTP',
          `Live request failed (${response.status})`,
        );
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new LiveClientError('RESPONSE', 'Expected a JSON Live response');
      const text = await response.text();
      if (text.length > 2_097_152)
        throw new LiveClientError(
          'RESPONSE',
          'Live response exceeds size limit',
        );
      const result = parseLiveResponse(JSON.parse(text) as unknown);
      if (!state.active || !mounted || !contains(state.root)) return;
      if (
        result.requestId !== requestId ||
        result.component.id !== state.id ||
        result.component.name !== state.name ||
        result.component.revision !== state.revision + 1
      )
        throw new LiveClientError(
          'RESPONSE',
          'Mismatched or stale Live response',
        );
      const template = doc.createElement('template');
      template.innerHTML = result.html;
      validateFragment(template.content);
      const preview = state.root.cloneNode(false) as Element;
      preview.append(template.content.cloneNode(true));
      validateDirectives(preview);
      const dirty = new Map<string, unknown>();
      for (const [key, field] of state.dirty)
        if (sent.get(key)?.version !== field.version)
          dirty.set(key, field.value);
      const differs = (field: string): boolean =>
        dirty.has(field) && !Object.is(dirty.get(field), result.state[field]);
      applyBindings(
        preview,
        (field) => (dirty.has(field) ? dirty.get(field) : result.state[field]),
        (field) =>
          field === undefined
            ? [...dirty.keys()].some(differs)
            : differs(field),
      );
      const focused = state.root.contains(doc.activeElement)
        ? doc.activeElement
        : null;
      const caret = selection(focused);
      const scroll = { top: state.root.scrollTop, left: state.root.scrollLeft };
      morphChildren(state.root, template.content, dirty);
      if (focused?.isConnected && 'focus' in focused) {
        (focused as HTMLElement).focus({ preventScroll: true });
        if (caret)
          (focused as HTMLInputElement).setSelectionRange(
            caret.start,
            caret.end,
            caret.direction,
          );
      }
      state.root.scrollTop = scroll.top;
      state.root.scrollLeft = scroll.left;
      for (const [key, field] of sent)
        if (state.dirty.get(key)?.version === field.version)
          state.dirty.delete(key);
      state.snapshot = result.snapshot;
      state.revision = result.component.revision;
      state.values = result.state;
      refreshBindings(state);
      state.root.setAttribute('data-nv-state', JSON.stringify(result.state));
      state.root.setAttribute('data-nv-snapshot', result.snapshot);
      state.root.setAttribute('data-nv-revision', String(state.revision));
      discover();
      state.root.dispatchEvent(
        new window.CustomEvent('nestvexa:updated', {
          bubbles: true,
          detail: { requestId, revision: state.revision },
        }),
      );
    } finally {
      state.request = null;
    }
  }
  function schedule(
    state: Component,
    action: string,
    submit: boolean,
  ): Promise<void> {
    if (state.pending >= 16)
      throw new LiveClientError('DIRECTIVE', 'Live request queue is full');
    if (submit && state.submitting) return Promise.resolve();
    if (submit) state.submitting = true;
    state.pending++;
    busy(state);
    const task = state.queue
      .then(() => invoke(state, action))
      .finally(() => {
        state.pending--;
        if (submit) state.submitting = false;
        if (state.active && mounted) busy(state);
      });
    state.queue = task.catch((error: unknown) => {
      if (state.active && mounted) report(error, state.root);
    });
    return task;
  }
  function target(event: Event): Element | null {
    return event.target instanceof window.Element ? event.target : null;
  }
  function input(event: Event): void {
    const element = target(event);
    if (!element?.hasAttribute('nv:model')) return;
    const component = owner(element);
    const state = component ? components.get(component) : undefined;
    if (!state || ignored(element, state.root)) return;
    try {
      const name = parseIdentifier(element.getAttribute('nv:model') ?? '');
      const field = element as HTMLInputElement;
      const value: Field =
        field.type === 'checkbox'
          ? field.checked
          : field.type === 'number' && field.value !== ''
            ? field.valueAsNumber
            : field.value;
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new LiveClientError('DIRECTIVE', 'Number input is invalid');
      state.dirty.set(name, { value, version: ++state.fieldVersion });
      refreshBindings(state);
    } catch (error) {
      report(error, state.root);
    }
  }
  function resolveEvent(
    event: Event,
  ):
    | { element: Element; attribute: string; directive: EventDirective }
    | undefined {
    const origin = target(event);
    const scope = origin ? owner(origin) : null;
    if (!origin || !scope || !components.has(scope) || ignored(origin, scope))
      return;
    let element: Element | null = origin;
    while (element && contains(element)) {
      const attribute = [...element.attributes].find(
        (item) =>
          item.name === `nv:${event.type}` ||
          item.name.startsWith(`nv:${event.type}.`),
      );
      if (attribute)
        return {
          element,
          attribute: attribute.name,
          directive: parseEventDirective(attribute.name, attribute.value),
        };
      if (element === scope) break;
      element = element.parentElement;
    }
  }
  function dispatchEvent(
    event: Event,
    binding: { element: Element; directive: EventDirective },
  ): void {
    if (handledEvents.has(event)) return;
    if (event.type === 'submit') event.preventDefault();
    if (dispatcher?.handle(event, binding.element, binding.directive))
      handledEvents.add(event);
  }
  function syncDirectListeners(): void {
    const bindings: DirectEventBinding[] = [];
    for (const state of components.values())
      for (const element of owned(state.root))
        for (const attribute of element.attributes) {
          if (!/^nv:(?:click|submit|keydown)(?:\.|$)/.test(attribute.name))
            continue;
          const directive = parseEventDirective(
            attribute.name,
            attribute.value,
          );
          if (directive.stop)
            bindings.push({
              element,
              attribute: attribute.name,
              event: directive.kind,
            });
        }
    direct.sync(bindings);
  }
  function action(event: Event): void {
    if (handledEvents.has(event)) return;
    try {
      const binding = resolveEvent(event);
      if (binding) dispatchEvent(event, binding);
    } catch (error) {
      report(error, target(event));
    }
  }
  function componentFor(element: Element): Component {
    const parent = owner(element);
    const state = parent ? components.get(parent) : undefined;
    if (!mounted || !state?.active || !contains(state.root))
      throw new LiveClientError(
        'MARKER',
        'Element is not owned by an active Live client',
      );
    return state;
  }
  function refreshBindings(state: Component): void {
    const differs = (field: string): boolean =>
      state.dirty.has(field) &&
      !Object.is(state.dirty.get(field)?.value, state.values[field]);
    applyBindings(
      state.root,
      (field) =>
        state.dirty.has(field)
          ? state.dirty.get(field)?.value
          : state.values[field],
      (field) =>
        field === undefined
          ? [...state.dirty.keys()].some(differs)
          : differs(field),
    );
  }
  return {
    refs(element: Element): ReadonlyMap<string, Element> {
      return queryRefs(componentFor(element).root);
    },
    call(element: Element, action: string): Promise<void> {
      try {
        return schedule(componentFor(element), parseIdentifier(action), false);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    get(element: Element, name: string): unknown {
      const state = componentFor(element);
      const key = parseIdentifier(name);
      if (!Object.hasOwn(state.values, key))
        throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      return structuredClone(
        state.dirty.has(key) ? state.dirty.get(key)?.value : state.values[key],
      );
    },
    set(element: Element, name: string, value: Field): void {
      const state = componentFor(element);
      const key = parseIdentifier(name);
      if (!Object.hasOwn(state.values, key))
        throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      if (
        !['string', 'boolean', 'number'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new LiveClientError(
          'DIRECTIVE',
          'Expected finite primitive state',
        );
      state.dirty.set(key, { value, version: ++state.fieldVersion });
      refreshBindings(state);
    },
    mount(): void {
      if (mounted) return;
      mounted = true;
      dispatcher = createEventDispatcher({
        invoke: (element, action) =>
          schedule(componentFor(element), action, element.tagName === 'FORM'),
        onError: (error, element) => report(error, element),
      });
      discover();
      root.addEventListener('click', action);
      root.addEventListener('submit', action);
      root.addEventListener('keydown', action);
      root.addEventListener('input', input);
      root.addEventListener('change', input);
      observer = new window.MutationObserver((mutations) => {
        if (
          mounted &&
          mutations.some(
            (mutation) =>
              mutation.type === 'childList' ||
              mutation.attributeName?.startsWith('nv:'),
          )
        )
          discover();
      });
      observer.observe(doc, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    },
    dispose(): void {
      if (!mounted) return;
      mounted = false;
      observer?.disconnect();
      observer = null;
      dispatcher?.dispose();
      dispatcher = undefined;
      direct.dispose();
      root.removeEventListener('click', action);
      root.removeEventListener('submit', action);
      root.removeEventListener('keydown', action);
      root.removeEventListener('input', input);
      root.removeEventListener('change', input);
      for (const state of components.values()) {
        state.active = false;
        state.request?.abort();
        state.root.removeAttribute('aria-busy');
        if (componentOwners.get(state.root) === ownership)
          componentOwners.delete(state.root);
      }
      components.clear();
      rejected = new WeakSet<Element>();
    },
  };
}
