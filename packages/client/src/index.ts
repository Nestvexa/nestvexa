import {
  morphChildren,
  prepareMorph,
  validateFragment,
  validateIgnore,
} from './morph.js';
import { applyBindings, prepareBindings, queryRefs } from './bindings.js';
import {
  createConfirmationController,
  createEventDispatcher,
  parseEventDirective,
} from './events.js';
import type { EventDispatcher, EventDirective, LiveConfirm } from './events.js';
export type { LiveConfirmation, LiveConfirm } from './events.js';
import { createDirectEventListeners } from './listeners.js';
import type { DirectEventBinding } from './listeners.js';
import {
  changedFromDefault,
  getModelDirective,
  isCheckbox,
  readModelValue,
} from './models.js';
import {
  copyModelArray,
  planModelSelection,
  sameModelValue,
} from './models.js';
import type { ModelDirective, ModelValue } from './models.js';
import { createModelScheduler } from './model-scheduler.js';
import { createLoadingController, validateLoading } from './loading.js';
import { LiveHttpError, requestLive, requestTimeout } from './transport.js';
import { planFormReset, resetSignature, resetValue } from './form-reset.js';
import type { ResetField } from './form-reset.js';
import { createObserverController, validateObservers } from './observers.js';
import {
  createPresentationController,
  validatePresentation,
} from './presentation.js';
import { applyUrlEffects } from './url-state.js';
import { cloneActionInput } from './action-input.js';
import { createNavigationController } from './navigation.js';
// Only the small parsers, option copies and token reader of the optional
// features are bundled into the entry; their controllers and structural
// validators load on demand (see `loadFeature`).
import { tokenChannels } from './realtime.js';
import type { RealtimeController, RealtimeEndpoint } from './realtime.js';
import { parseOptimisticDirective, projectOptimistic } from './optimistic.js';
import type { LiveActionInput } from './action-input.js';
export type { LiveActionInput } from './action-input.js';
import { createInitializationScheduler } from './initialization.js';
import type { SortController } from './sort.js';
export { parseSortDirective } from './sort.js';
export type { SortDirective } from './sort.js';
import { copyStreamEndpoints } from './stream.js';
import type {
  StreamController,
  StreamEndpoint,
  StreamResult,
} from './stream.js';
import { copyUploadEndpoint } from './upload.js';
import type { UploadController, UploadEndpoint } from './upload.js';
export { parseStreamDirective } from './stream.js';
export { parseUploadDirective } from './upload.js';
export type { UploadDirective, UploadEndpoint } from './upload.js';
export type {
  StreamDirective,
  StreamEndpoint,
  StreamResult,
} from './stream.js';
export { parseObserverDirective } from './observers.js';
export type { ObserverDirective } from './observers.js';
export { parsePresentationDirective } from './presentation.js';
export type { PresentationDirective } from './presentation.js';
import {
  availableForFocus,
  captureEditorSelection,
  createFocusController,
  focusFirstInvalid,
  focusMoved,
} from './focus.js';
export { LiveHttpError } from './transport.js';
export { parseLoadingDirective, parseLoadingTarget } from './loading.js';
export type { LoadingDirective } from './loading.js';
export { parseModelDirective } from './models.js';
export type { ModelDirective } from './models.js';
export { parseEventDirective } from './events.js';
export type { EventDirective } from './events.js';
import {
  LiveClientError,
  parseDirective,
  parseEventName,
  parseIdentifier,
  parseLiveResponse,
} from './protocol.js';
import type { LiveEvent } from './protocol.js';
import { parsePath, readPath, trustedHTML } from './grammar.js';
export {
  LiveClientError,
  parseDirective,
  parseIdentifier,
  parseLiveResponse,
} from './protocol.js';
export type {
  LiveDirective,
  LiveEvent,
  LiveResponse,
  ReplacementDirective,
} from './protocol.js';

export type { RealtimeEndpoint, RealtimeTransport } from './realtime.js';
export interface LiveClientOptions {
  /** Trusted realtime route (from @nestvexa/realtime) for component invalidation. */
  readonly realtime?: RealtimeEndpoint;
  readonly root?: Document | Element;
  readonly fetch?: typeof fetch;
  readonly onError?: (error: Error, component: Element | null) => void;
  /** Total fetch/body deadline per dispatched request: 1–300000ms; default 30000ms. */
  readonly requestTimeoutMs?: number;
  /** Opt-in timings only; no DOM, identities, tokens, URLs, state or action names. Sink errors are isolated. */
  readonly onDiagnostic?: (event: LiveDiagnostic) => void;
  /** Trusted custom dialog. Default: native window.confirm; only literal true approves. */
  readonly confirm?: LiveConfirm;
  /** Approval deadline, 1–300000ms; default 30000ms. No request is sent on expiry. */
  readonly confirmationTimeoutMs?: number;
  /** Automatic init attempts per mount lifecycle: 1–1000; default 64. Server quotas still apply. */
  readonly maxInitializations?: number;
  /** Total polling/intersection bindings per client: 1–1000; default 256. */
  readonly maxObservers?: number;
  /** Active sortable lists per client: 1–256; default 64. */
  readonly maxSortLists?: number;
  /** Trusted static same-origin POST routes. Markup names a registered ID, never a URL. */
  readonly streams?: Readonly<Record<string, StreamEndpoint>>;
  /** Trusted same-origin upload API prefix for `nv:upload` (from @nestvexa/uploads). */
  readonly uploads?: UploadEndpoint;
  /**
   * Development instrumentation (keep false in production): enables inspect()
   * and mirrors reported errors to console.warn. Neither exposes state values,
   * snapshot references, CSRF tokens, endpoints or payloads.
   */
  readonly development?: boolean;
}
/** Development-only, sanitized description of one registered component. */
export interface LiveInspection {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  /** Queued or running requests per action (`$sync` for model synchronization). */
  readonly pending: Readonly<Record<string, number>>;
  /** Names (never values) of fields and nested paths with local drafts. */
  readonly dirty: readonly string[];
  readonly invalid: number;
  /** Error code that suspended the component, if any. */
  readonly failure: string | null;
  readonly idempotent: readonly string[];
}
/** One bounded timing sample per phase of a dispatched request; no retained buffer. */
export interface LiveDiagnostic {
  readonly phase: 'queue' | 'request' | 'morph';
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly milliseconds: number;
}
/**
 * Detail of the bubbling `nestvexa:request` event dispatched on a component
 * root: `start` before the first attempt, `retry` before each automatic resend
 * of an idempotent action (1-based attempt), `end` after application/cleanup.
 * It carries no state, tokens, URLs or payloads.
 */
export type LiveRequestProgress =
  | {
      readonly action: string;
      readonly phase: 'start' | 'retry';
      readonly attempt: number;
    }
  | {
      readonly action: string;
      readonly phase: 'end';
      readonly outcome: LiveDiagnostic['outcome'];
    };
export interface LiveClient {
  mount(): void;
  dispose(): void;
  call(element: Element, action: string, input?: unknown): Promise<void>;
  get(element: Element, name: string): unknown;
  set(element: Element, name: string, value: string | number | boolean): void;
  refs(element: Element): ReadonlyMap<string, Element>;
  /** Await a trusted CSS enter/leave phase before host-managed removal. */
  transition(element: Element, phase: 'enter' | 'leave'): Promise<boolean>;
  /** Start an explicitly requested read-only text stream; no automatic retry. */
  startStream(target: Element): Promise<StreamResult>;
  cancelStream(target: Element): void;
  /** Upload the files selected in an owned `nv:upload` input, then set its field to the tokens. */
  upload(input: Element): Promise<readonly string[]>;
  /** Abort an active upload and discard unfinalized tokens for the element's field. */
  cancelUpload(element: Element): void;
  /**
   * Deliver a browser event to components whose `@OnEvent` listeners match.
   * Listener actions validate and authorize the payload on the server.
   */
  dispatch(name: string, payload?: unknown): void;
  /** Visit a same-origin path with `nv:navigate` semantics (full-load fallback). */
  navigate(url: string): Promise<void>;
  /** Development only (`development: true`): sanitized component summaries. */
  inspect(): readonly LiveInspection[];
}
type Field = ModelValue;
const componentOwners = new WeakMap<Element, symbol>();

/**
 * Optional feature chunks (ADR 0036). Each is a separate content-addressed
 * asset beside the entry, imported once on first use and shared by every
 * client on the page. The production build rewrites these specifiers to
 * `./live-<feature>.js`; a chunk imports its shared error class back from the
 * entry, so `instanceof LiveClientError` keeps one identity.
 */
interface FeatureModules {
  readonly sort: typeof import('./sort.js');
  readonly stream: typeof import('./stream.js');
  readonly upload: typeof import('./upload.js');
  readonly realtime: typeof import('./realtime.js');
}
type Feature = keyof FeatureModules;
const featureImports: {
  readonly [K in Feature]: () => Promise<FeatureModules[K]>;
} = {
  sort: () => import('./sort.js'),
  stream: () => import('./stream.js'),
  upload: () => import('./upload.js'),
  realtime: () => import('./realtime.js'),
};
const featureModules: { [K in Feature]?: FeatureModules[K] } = {};
const featureRequests = new Map<Feature, Promise<void>>();
function importFeature<K extends Feature>(name: K): Promise<void> {
  return featureImports[name]().then((module) => {
    featureModules[name] = module;
  });
}
function loadFeature(name: Feature): Promise<void> {
  if (featureModules[name]) return Promise.resolve();
  let request = featureRequests.get(name);
  if (!request) {
    request = importFeature(name).catch(() => {
      // A later discovery may retry, for example after connectivity returns.
      featureRequests.delete(name);
      throw new LiveClientError(
        'NETWORK',
        'A Live feature module failed to load',
      );
    });
    featureRequests.set(name, request);
  }
  return request;
}
const directiveFeatures: readonly (readonly [Feature, RegExp])[] = [
  ['sort', /^nv:sort(?:\.|$)/],
  ['stream', /^nv:stream(?:\.|$)/],
  ['upload', /^nv:upload(?:\.|$)/],
];
/** Features named by any directive in a subtree: a superset of what their validators read. */
function directiveFeaturesIn(subtree: Element | DocumentFragment): Feature[] {
  const found = new Set<Feature>();
  const elements =
    subtree.nodeType === 1
      ? [subtree as Element, ...subtree.querySelectorAll('*')]
      : subtree.querySelectorAll('*');
  for (const element of elements)
    for (const attribute of element.attributes)
      if (attribute.name.startsWith('nv:'))
        for (const [feature, pattern] of directiveFeatures)
          if (pattern.test(attribute.name)) found.add(feature);
  return [...found];
}
const markerAttributes = new Set([
  'data-nv-component',
  'data-nv-name',
  'data-nv-endpoint',
  'data-nv-csrf',
  'data-nv-snapshot',
  'data-nv-revision',
  'data-nv-state',
]);
interface Component {
  readonly root: Element;
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly csrf: string;
  snapshot: string;
  revision: number;
  values: Readonly<Record<string, unknown>>;
  readonly markers: Map<string, string | null>;
  readonly dirty: Map<string, { value: Field; version: number }>;
  readonly invalid: Map<Element, string>;
  fieldVersion: number;
  queue: Promise<void>;
  pending: number;
  readonly pendingActions: Map<string, number>;
  submitting: boolean;
  active: boolean;
  request: AbortController | null;
  failure: Error | null;
  initialized: boolean;
  /** Event name → listening action ids declared by the server. */
  readonly listeners: ReadonlyMap<string, readonly string[]>;
  /** Local optimistic projections shown until the server acknowledges. */
  readonly optimistic: Map<string, { value: unknown; token: symbol }>;
  /** Parent model binding for a @Modelable child. */
  readonly model?:
    { readonly parent: string; readonly child: string } | undefined;
  /** Server-declared idempotent actions: only these are retried automatically. */
  readonly idempotent: ReadonlySet<string>;
  /** The newest queued request that has not started; later syncs fold into it. */
  waiting?: Promise<void> | undefined;
}
function parseIdempotent(value: string | null): ReadonlySet<string> {
  const actions: unknown = JSON.parse(value ?? '[]');
  if (
    !Array.isArray(actions) ||
    actions.length > 64 ||
    actions.some((action) => typeof action !== 'string')
  )
    throw new LiveClientError('MARKER', 'Invalid Live idempotent marker');
  return new Set(actions.map((action: string) => parseIdentifier(action)));
}
function parseListeners(value: string | null): Map<string, readonly string[]> {
  const listeners = new Map<string, readonly string[]>();
  if (value === null) return listeners;
  if (value.length > 8192)
    throw new LiveClientError('MARKER', 'Oversized Live listener marker');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new LiveClientError('MARKER', 'Invalid Live listener marker');
  for (const [name, actions] of Object.entries(parsed)) {
    parseEventName(name);
    if (
      !Array.isArray(actions) ||
      !actions.length ||
      actions.length > 16 ||
      actions.some((action) => typeof action !== 'string')
    )
      throw new LiveClientError('MARKER', 'Invalid Live listener marker');
    listeners.set(
      name,
      Object.freeze(actions.map((action: string) => parseIdentifier(action))),
    );
  }
  return listeners;
}
function parseModelMarker(
  value: string | null,
): { readonly parent: string; readonly child: string } | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    typeof Reflect.get(parsed, 'parent') !== 'string' ||
    typeof Reflect.get(parsed, 'child') !== 'string'
  )
    throw new LiveClientError('MARKER', 'Invalid Live model marker');
  return Object.freeze({
    parent: parseIdentifier(String(Reflect.get(parsed, 'parent'))),
    child: parseIdentifier(String(Reflect.get(parsed, 'child'))),
  });
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
function validateDirectives(
  component: Element,
  streams: Readonly<Record<string, StreamEndpoint>>,
  uploads: boolean,
): void {
  let initializers = 0;
  if (component.hasAttribute('nv:ignore'))
    throw new LiveClientError(
      'DIRECTIVE',
      'nv:ignore cannot own the Live component root',
    );
  validateLoading(component);
  validateObservers(component);
  validatePresentation(component);
  // Callers load a feature before validating markup that names it (discovery
  // defers the component; a server response awaits the chunk before morphing).
  featureModules.sort?.validateSort(component);
  featureModules.stream?.validateStreams(component, streams);
  featureModules.upload?.validateUploads(component, uploads);
  validateReplacement(component, component);
  for (const element of owned(component)) {
    getModelDirective(element);
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
        if (
          directive.kind === 'init' &&
          (++initializers > 1 || element.hasAttribute('nv:confirm'))
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'Use one owned nv:init per component, separate from nv:confirm',
          );
        if (
          directive.kind === 'confirm' &&
          ![...element.attributes].some((item) =>
            /^nv:(?:click|submit|keydown)(?:\.|$)/.test(item.name),
          )
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'nv:confirm requires a same-element action binding',
          );
        if (directive.kind === 'submit' && element.tagName !== 'FORM')
          throw new LiveClientError('DIRECTIVE', 'nv:submit requires a form');
        if (
          directive.kind === 'optimistic' &&
          ![...element.attributes].some((item) =>
            /^nv:(?:click|submit|keydown)(?:.|$)/.test(item.name),
          )
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'nv:optimistic requires a same-element action binding',
          );
        if (directive.kind === 'navigate' && element.tagName !== 'A')
          throw new LiveClientError('DIRECTIVE', 'nv:navigate requires a link');
      }
  }
}
function validateReplacement(element: Element, component: Element): void {
  validateIgnore(element, element === component);
  const attributes = [...element.attributes].filter(
    (attribute) =>
      attribute.name === 'nv:replace' ||
      attribute.name.startsWith('nv:replace.'),
  );
  const isolated =
    element.hasAttribute('nv:ignore') ||
    element.hasAttribute('data-nv-island') ||
    (element !== component && element.hasAttribute('data-nv-component'));
  if (
    attributes.length > 1 ||
    (attributes.length && (isolated || element === component))
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'Replacement requires one directive on an owned inner element',
    );
  for (const attribute of attributes)
    parseDirective(attribute.name, attribute.value);
  if (isolated) return;
  for (const child of element.children) validateReplacement(child, component);
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
function controlSignature(element: Element): string {
  return JSON.stringify([
    element.tagName,
    element.tagName === 'INPUT'
      ? (element as HTMLInputElement).type
      : element.tagName === 'SELECT'
        ? (element as HTMLSelectElement).multiple
        : null,
    getModelDirective(element)?.cast,
  ]);
}

/** Validate array aliases and all projections before applying any native selection. */
function modelSelections(
  component: Element,
  read: (field: string) => unknown,
  invalid: ReadonlyMap<Element, string> = new Map(),
): readonly (() => void)[] {
  const groups = new Map<string, { multiple: boolean; cast: string }[]>();
  const operations: (() => void)[] = [];
  for (const element of owned(component)) {
    if (invalid.has(element)) continue;
    const directive = getModelDirective(element);
    if (!directive) continue;
    // Multiple selects and checkbox groups (checkboxes modelling array state).
    const multiple =
      (element.tagName === 'SELECT' &&
        (element as HTMLSelectElement).multiple) ||
      (isCheckbox(element) && Array.isArray(read(directive.field)));
    const entries = groups.get(directive.field) ?? [];
    entries.push({ multiple, cast: directive.cast });
    groups.set(directive.field, entries);
    const apply = planModelSelection(element, directive, read(directive.field));
    if (apply) operations.push(apply);
  }
  for (const entries of groups.values())
    if (
      entries.some((entry) => entry.multiple) &&
      entries.some(
        (entry) => !entry.multiple || entry.cast !== entries[0]?.cast,
      )
    )
      throw new LiveClientError(
        'DIRECTIVE',
        'Array model aliases require the same array shape and cast',
      );
  return operations;
}

/** A path is covered by itself and by each ancestor path; every path by `undefined`. */
function covers(field: string | undefined, key: string): boolean {
  return field === undefined || key === field || key.startsWith(`${field}.`);
}
/** Whether a covered draft differs from the server value at its own path. */
function changed(
  drafts: Iterable<readonly [string, unknown]>,
  values: unknown,
  field?: string,
): boolean {
  for (const [key, value] of drafts)
    if (covers(field, key) && !sameModelValue(value, readPath(values, key)))
      return true;
  return false;
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
  const timeout = requestTimeout(options.requestTimeoutMs);
  const initLimit = options.maxInitializations ?? 64;
  if (!Number.isSafeInteger(initLimit) || initLimit < 1 || initLimit > 1000)
    throw new LiveClientError(
      'DIRECTIVE',
      'maxInitializations must be an integer from 1 through 1000',
    );
  let initializations = 0;
  const observerLimit = options.maxObservers ?? 256;
  if (
    !Number.isSafeInteger(observerLimit) ||
    observerLimit < 1 ||
    observerLimit > 1000
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'maxObservers must be an integer from 1 through 1000',
    );
  const components = new Map<Element, Component>();
  const sortLimit = options.maxSortLists ?? 64;
  if (!Number.isSafeInteger(sortLimit) || sortLimit < 1 || sortLimit > 256)
    throw new LiveClientError(
      'DIRECTIVE',
      'maxSortLists must be an integer from 1 through 256',
    );
  let focus = createFocusController();
  let mounted = false;
  let observer: MutationObserver | null = null;
  let dispatcher: EventDispatcher | undefined;
  let composing = new WeakSet<Element>();
  let models = makeModels();
  let confirmations = makeConfirmations();
  let loading = createLoadingController(focus);
  let background: ReturnType<typeof createObserverController> | undefined;
  let sorting: SortController | undefined;
  let lazyObserver: IntersectionObserver | undefined;
  let navigation: ReturnType<typeof createNavigationController> | undefined;
  let realtime: RealtimeController | undefined;
  const realtimeRefresh = new WeakMap<Component, number>();
  let lastRealtimeRenewal = 0;
  let streaming: StreamController | undefined;
  const streams = copyStreamEndpoints(options.streams ?? Object.freeze({}));
  const uploadEndpoint = copyUploadEndpoint(options.uploads);
  let uploading: UploadController | undefined;
  /** Features this mounted client uses; their controllers start once loaded. */
  const needed = new Set<Feature>();
  /** Markers waiting for a feature chunk; registered by the discovery that follows the load. */
  let deferred = new WeakSet<Element>();
  let awaitingFeatures = new Set<Feature>();
  let presentation: ReturnType<typeof createPresentationController> | undefined;
  let initialization:
    ReturnType<typeof createInitializationScheduler> | undefined;
  const reportedBackground = new WeakSet<object>();
  let urlHistory = false;
  const restoreUrl = (event: PopStateEvent): void => {
    // Navigation entries are revisited by the navigation controller instead.
    const entry: unknown = event.state;
    if (
      navigation &&
      entry &&
      typeof entry === 'object' &&
      Reflect.get(entry, 'nestvexaNavigate') === true
    )
      return;
    // Historical snapshots are not replayed: revisit the host route and hydrate
    // authoritative URL state under its normal guards and identity resolver.
    if (mounted && urlHistory) window.location.reload();
  };
  let generation = 0;
  let resetTimer: number | undefined;
  const resets = new Map<
    HTMLFormElement,
    {
      event: Event;
      fields: readonly ResetField<Component>[];
      generation: number;
    }
  >();
  function resetOwner(element: Element): Component | undefined {
    if (!contains(element)) return undefined;
    const state = registeredScope(element);
    return state && !ignored(element, state.root) ? state : undefined;
  }
  function flushResets(): void {
    for (const [form, plan] of resets) {
      // Getters called inside a reset listener must not preempt a later veto.
      if (plan.event.eventPhase !== 0) continue;
      resets.delete(form);
      if (
        !mounted ||
        plan.generation !== generation ||
        plan.event.defaultPrevented ||
        !form.isConnected
      )
        continue;
      const changed = new Set<Component>();
      for (const entry of plan.fields) {
        const state = entry.owner;
        if (
          !usable(state) ||
          !entry.controls.every(
            ({ element, signature }) =>
              resetOwner(element) === state &&
              'form' in element &&
              element.form === form &&
              resetSignature(element) === signature,
          )
        )
          continue;
        try {
          const value = resetValue(
            entry.controls,
            Array.isArray(current(state, entry.field)),
          );
          state.dirty.set(entry.field, {
            value,
            version: ++state.fieldVersion,
          });
          for (const control of entry.controls) {
            state.invalid.delete(control.element);
            composing.delete(control.element);
          }
          // Reset acts on a shared public field, even when another form has an alias.
          for (const element of owned(state.root)) {
            const model = getModelDirective(element);
            if (model?.field === entry.field) models.cancel(element);
          }
          changed.add(state);
        } catch (error) {
          // Defaults changed during the reset event and no longer describe a
          // representable model. Do not dispatch stale hidden state afterward.
          suspend(
            state,
            error instanceof Error
              ? error
              : new LiveClientError(
                  'DIRECTIVE',
                  'Native reset could not reconcile model state',
                ),
          );
        }
      }
      for (const state of changed) refreshBindings(state);
    }
    if (!resets.size && resetTimer !== undefined) {
      window.clearTimeout(resetTimer);
      resetTimer = undefined;
    }
  }
  function reset(event: Event): void {
    const form = event.target;
    if (
      !mounted ||
      event.defaultPrevented ||
      !event.isTrusted ||
      !(form instanceof window.HTMLFormElement)
    )
      return;
    try {
      const fields = planFormReset(form, resetOwner, (state, field) =>
        Array.isArray(current(state, field)),
      );
      if (!fields.length) return;
      if (!resets.has(form) && resets.size >= 1000)
        throw new LiveClientError(
          'DIRECTIVE',
          'Native reset queue capacity reached',
        );
      for (const entry of fields)
        if (readPath(entry.owner.values, entry.field) === undefined)
          throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      resets.set(form, { event, fields, generation });
      window.queueMicrotask(flushResets);
      // Native button dispatch can run microtasks between reset listeners.
      // One task per client also flushes after dispatch and the default action.
      resetTimer ??= window.setTimeout(() => {
        resetTimer = undefined;
        flushResets();
      }, 0);
    } catch (error) {
      event.preventDefault();
      report(error, registeredScope(form)?.root ?? null);
    }
  }
  function makeModels(): ReturnType<typeof createModelScheduler> {
    return createModelScheduler({
      invoke: async (element) => {
        const state = componentFor(element);
        if (!contains(element) || ignored(element, state.root)) return;
        if (!hasChanges(state)) return;
        // The queue reports transport failures once and never retries a mutation.
        await schedule(state, '_sync', false).catch(() => undefined);
      },
      onError: (error, element) => report(error, element),
    });
  }
  const handledEvents = new WeakSet<Event>();
  const direct = createDirectEventListeners((event, element, attribute) => {
    try {
      const value = element.getAttribute(attribute);
      const scoped =
        value === null ? undefined : parseEventDirective(attribute, value);
      if (scoped?.scope) {
        // Global bindings accept trusted input only, and only while the
        // declaring element remains owned by a healthy registration.
        const state = registeredScope(element);
        if (
          event.isTrusted &&
          state &&
          !failureFor(state) &&
          !ignored(element, state.root)
        )
          dispatcher?.handle(event, element, scoped);
        return;
      }
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
    if (options.development)
      window.console.warn(
        '[nestvexa]',
        safe instanceof LiveClientError ? safe.code : safe.name,
        safe.message,
      );
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
  function failureFor(state: Component): Error | null {
    if (state.failure) return state.failure;
    for (
      let parent = state.root.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const failure = components.get(parent)?.failure;
      if (failure) return failure;
    }
    return null;
  }
  function busy(state: Component): void {
    if (failureFor(state)) {
      loading.restore(state.root);
      state.root.setAttribute('aria-busy', 'false');
      return;
    }
    state.root.setAttribute('aria-busy', state.pending ? 'true' : 'false');
    loading.update(state.root, state.pendingActions);
  }
  function releaseComponent(state: Component): void {
    state.active = false;
    state.request?.abort();
    loading.restore(state.root);
    background?.remove(state.root);
    sorting?.remove(state.root);
    streaming?.remove(state.root);
    initialization?.remove(state.root);
    presentation?.restore(state.root);
    state.root.removeAttribute('aria-busy');
    focus.release(state.root);
    components.delete(state.root);
    if (componentOwners.get(state.root) === ownership)
      componentOwners.delete(state.root);
  }
  /**
   * Cancel scheduled work for a subtree. A suspended (still rendered) component
   * keeps its presentation state, so nv:offline keeps reflecting connectivity
   * instead of reverting to markup that may announce a false outage.
   */
  function cancelSubtree(node: Element, suspended = false): void {
    initialization?.remove(node);
    background?.remove(node);
    sorting?.remove(node);
    streaming?.remove(node);
    if (!suspended) presentation?.remove(node);
    confirmations.cancel(node);
    focus.release(node);
    dispatcher?.cancel(node);
    direct.remove(node);
    for (const element of [node, ...node.querySelectorAll('*')])
      models.cancel(element);
  }
  function releaseSubtree(node: Element, reject: boolean): void {
    cancelSubtree(node);
    for (const state of [...components.values()])
      if (node === state.root || node.contains(state.root)) {
        if (reject) rejected.add(state.root);
        releaseComponent(state);
      }
  }
  function suspend(state: Component, error: Error): void {
    if (state.failure || !state.active || !mounted) return;
    cancelSubtree(state.root, true);
    for (const child of components.values())
      if (child === state || state.root.contains(child.root)) {
        child.failure = error;
        child.request?.abort();
        busy(child);
      }
    report(error, state.root);
  }
  function validMarker(state: Component): boolean {
    return [...state.markers].every(
      ([name, value]) => state.root.getAttribute(name) === value,
    );
  }
  function usable(state: Component): boolean {
    if (!mounted || !state.active) return false;
    if (!contains(state.root)) {
      releaseSubtree(state.root, false);
      return false;
    }
    if (state.root.closest('[data-nv-island]')) {
      releaseSubtree(state.root, true);
      return false;
    }
    if (
      state.root.hasAttribute('nv:ignore') ||
      state.root.hasAttribute('nv:ignore.self') ||
      !validMarker(state)
    ) {
      releaseSubtree(state.root, true);
      report(
        new LiveClientError(
          'MARKER',
          'Live component marker changed; reload or reconcile authoritative server state before remounting',
        ),
        state.root,
      );
      return false;
    }
    for (
      let parent = state.root.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const ancestor = components.get(parent);
      if (ancestor && !usable(ancestor)) return false;
      if (ancestor?.failure && !state.failure) {
        state.failure = ancestor.failure;
        cancelSubtree(state.root, true);
        state.request?.abort();
        busy(state);
      }
    }
    return state.active;
  }
  function registeredScope(element: Element): Component | undefined {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      // A removed marker must not redirect a child's calls to its live ancestor.
      if (rejected.has(current)) return undefined;
      const state = components.get(current);
      if (state) return usable(state) ? state : undefined;
      if (current.hasAttribute('data-nv-component') || current === root)
        return undefined;
    }
    return undefined;
  }
  function beforeRemove(node: Node): void {
    if (!(node instanceof window.Element)) return;
    releaseSubtree(node, false);
    node.dispatchEvent(
      new window.CustomEvent('nestvexa:before-remove', { bubbles: true }),
    );
  }
  function afterInsert(node: Node): void {
    if (node instanceof window.Element) {
      node.dispatchEvent(
        new window.CustomEvent('nestvexa:after-insert', { bubbles: true }),
      );
      void presentation
        ?.enter(node)
        .catch((error: unknown) => report(error, owner(node)));
    }
  }
  /** Record features in use and return those whose chunk has not loaded yet. */
  function useFeatures(features: readonly Feature[]): Feature[] {
    for (const feature of features) needed.add(feature);
    return features.filter((feature) => !featureModules[feature]);
  }
  /**
   * A marker naming a feature whose chunk is not loaded waits, unregistered and
   * inert like server HTML before boot, until the chunk arrives; the next
   * discovery validates and registers it. A failed load rejects the marker.
   */
  function deferForFeatures(element: Element): boolean {
    if (deferred.has(element)) return true;
    const missing = useFeatures(directiveFeaturesIn(element));
    if (!missing.length) return false;
    deferred.add(element);
    const at = generation;
    void Promise.all(missing.map((feature) => loadFeature(feature))).then(
      () => {
        if (!mounted || generation !== at) return;
        deferred.delete(element);
        discover();
      },
      (error: unknown) => {
        if (!mounted || generation !== at) return;
        deferred.delete(element);
        rejected.add(element);
        report(error, element);
      },
    );
    return true;
  }
  function requestFeatures(features: readonly Feature[]): void {
    const at = generation;
    for (const feature of useFeatures(features)) {
      if (awaitingFeatures.has(feature)) continue;
      awaitingFeatures.add(feature);
      void loadFeature(feature).then(
        () => {
          if (!mounted || generation !== at) return;
          awaitingFeatures.delete(feature);
          discover();
        },
        (error: unknown) => {
          if (!mounted || generation !== at) return;
          awaitingFeatures.delete(feature);
          report(error, null);
        },
      );
    }
  }
  /** Start the controller of every used feature whose chunk is available. */
  function startFeatures(): void {
    if (!mounted) return;
    const { sort, stream, upload } = featureModules;
    if (stream && needed.has('stream') && !streaming)
      streaming = stream.createStreamController({
        window,
        streams,
        fetch: transport,
        component: (target) => {
          const state = registeredScope(target);
          if (!state || failureFor(state) || ignored(target, state.root))
            return undefined;
          return {
            root: state.root,
            id: state.id,
            name: state.name,
            snapshot: state.snapshot,
            revision: state.revision,
            csrf: state.csrf,
          };
        },
        onError: (error, target) => report(error, owner(target)),
      });
    if (upload && needed.has('upload') && !uploading)
      uploading = upload.createUploadController({
        root,
        window,
        endpoint: uploadEndpoint,
        component: (element) => {
          const state = registeredScope(element);
          if (!state || failureFor(state) || ignored(element, state.root))
            return undefined;
          return { root: state.root, name: state.name, csrf: state.csrf };
        },
        set: (element, field, value) => api.set(element, field, value),
        onError: (error, element) => report(error, owner(element)),
      });
    if (sort && needed.has('sort') && !sorting)
      sorting = sort.createSortController({
        window,
        maxLists: sortLimit,
        usable: (element) => {
          const state = registeredScope(element);
          return (
            state !== undefined &&
            !failureFor(state) &&
            !ignored(element, state.root)
          );
        },
        invoke: async (element, action, input) => {
          try {
            await schedule(
              componentFor(element),
              action,
              false,
              cloneActionInput(input),
              false,
            );
          } catch (error) {
            if (error && typeof error === 'object')
              reportedBackground.add(error);
            throw error;
          }
        },
        onError: (error, element) => {
          if (
            error &&
            typeof error === 'object' &&
            reportedBackground.has(error)
          )
            return;
          report(error, owner(element));
        },
      });
  }
  /** Load a feature on explicit API use (stream/upload calls), then start its controller. */
  function featureController<T>(
    feature: Feature,
    controller: () => T | undefined,
  ): Promise<T> {
    if (!mounted)
      return Promise.reject(
        new LiveClientError('DIRECTIVE', 'Live client is not mounted'),
      );
    const at = generation;
    useFeatures([feature]);
    return loadFeature(feature).then(() => {
      if (mounted && generation === at) startFeatures();
      const started = mounted && generation === at ? controller() : undefined;
      if (started === undefined)
        throw new LiveClientError('DIRECTIVE', 'Live client is not mounted');
      return started;
    });
  }
  function startRealtime(
    module: FeatureModules['realtime'],
    endpoint: RealtimeEndpoint,
  ): RealtimeController {
    return module.createRealtimeController({
      ...endpoint,
      window,
      fetch: transport,
      onMessage: (message) => {
        window.dispatchEvent(
          new window.CustomEvent('nestvexa:realtime', {
            detail: Object.freeze({ ...message }),
          }),
        );
        // `{ nvEvent, payload }` is a server-pushed domain event: subscribed
        // listeners run their @OnEvent actions (authorized server-side);
        // other subscribers refresh.
        const data = message.data;
        const name: unknown =
          data && typeof data === 'object'
            ? Reflect.get(data, 'nvEvent')
            : undefined;
        let event: LiveEvent | undefined;
        try {
          if (name !== undefined)
            event = {
              name: parseEventName(name),
              payload: Reflect.get(Object(data), 'payload') ?? null,
            };
        } catch (error) {
          report(error, null);
        }
        const listening = new Set<Component>();
        for (const state of components.values())
          if (realtimeChannels(state).includes(message.channel)) {
            if (event && state.listeners.has(event.name)) listening.add(state);
            else invalidate(state);
          }
        if (event && listening.size)
          deliverEvents([event], undefined, listening);
      },
      onExpired: () => {
        // Renew tokens through ordinary authorized refreshes, at most every 30 s.
        if (Date.now() - lastRealtimeRenewal < 30_000) return;
        lastRealtimeRenewal = Date.now();
        for (const state of components.values())
          if (realtimeChannels(state).length) invalidate(state);
      },
    });
  }
  function discover(): void {
    initialization?.prune();
    confirmations.prune();
    focus.prune();
    dispatcher?.prune(root);
    models.prune(root);
    loading.prune();
    for (const state of [...components.values()]) usable(state);
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
        !element.hasAttribute('data-nv-stub') &&
        !element.closest('[data-nv-island]')
      ) {
        try {
          if (componentOwners.has(element))
            throw new LiveClientError(
              'MARKER',
              'Live component already belongs to another client instance',
            );
          if (deferForFeatures(element)) continue;
          validateDirectives(element, streams, uploadEndpoint !== undefined);
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
            markers: new Map(
              [...markerAttributes].map((name) => [
                name,
                element.getAttribute(name),
              ]),
            ),
            endpoint: endpoint.href.replace(/\/$/, ''),
            dirty: new Map(),
            invalid: new Map(),
            fieldVersion: 0,
            queue: Promise.resolve(),
            pending: 0,
            pendingActions: new Map(),
            submitting: false,
            active: true,
            request: null,
            failure: null,
            initialized: false,
            listeners: parseListeners(
              element.getAttribute('data-nv-listeners'),
            ),
            optimistic: new Map(),
            idempotent: parseIdempotent(
              element.getAttribute('data-nv-idempotent'),
            ),
            ...(element.hasAttribute('data-nv-model')
              ? {
                  model: parseModelMarker(
                    element.getAttribute('data-nv-model'),
                  ),
                }
              : {}),
          };
          const lazyTiming = element.getAttribute('data-nv-lazy');
          if (lazyTiming !== null && !['load', 'visible'].includes(lazyTiming))
            throw new LiveClientError('MARKER', 'Invalid Live lazy marker');
          const restored = restoreDrafts(state);
          refreshBindings(state);
          components.set(element, state);
          componentOwners.set(element, ownership);
          busy(state);
          if (restored.length)
            element.dispatchEvent(
              new window.CustomEvent('nestvexa:restored', {
                bubbles: true,
                detail: Object.freeze({ fields: Object.freeze(restored) }),
              }),
            );
          if (lazyTiming === 'visible' && window.IntersectionObserver) {
            lazyObserver ??= new window.IntersectionObserver((entries) => {
              for (const entry of entries)
                if (entry.isIntersecting) {
                  lazyObserver?.unobserve(entry.target);
                  const pending = components.get(entry.target);
                  if (pending) loadLazy(pending);
                }
            });
            lazyObserver.observe(element);
          } else if (lazyTiming !== null) loadLazy(state);
        } catch (error) {
          rejected.add(element);
          report(error, element);
        }
      }
    // Registered markup can gain a feature directive from a script; load it
    // without suspending the component (its controller validates on refresh).
    if (directiveFeatures.some(([feature]) => !needed.has(feature)))
      for (const state of components.values())
        if (usable(state)) requestFeatures(directiveFeaturesIn(state.root));
    startFeatures();
    refreshRealtime();
    try {
      syncDirectListeners();
      background?.refresh(root);
      sorting?.refresh(root);
      for (const state of components.values())
        if (usable(state)) {
          presentation?.refresh(state.root);
          streaming?.refresh(state.root);
        }
    } catch (error) {
      report(error, null);
    }
    const initializers = new Map<
      Component,
      { target: Element; attribute: string; value: string }[]
    >();
    for (const state of components.values()) {
      if (state.initialized || !usable(state)) continue;
      const entries: { target: Element; attribute: string; value: string }[] =
        [];
      for (const target of owned(state.root))
        for (const attribute of target.attributes)
          if (/^nv:init(?:\.|$)/.test(attribute.name))
            entries.push({
              target,
              attribute: attribute.name,
              value: attribute.value,
            });
      if (entries.length) initializers.set(state, entries);
    }
    for (const [state, targets] of initializers) {
      state.initialized = true;
      try {
        const entry = targets[0];
        if (
          !entry ||
          targets.length !== 1 ||
          entry.target.hasAttribute('nv:confirm')
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'Use one owned nv:init per component, separate from nv:confirm',
          );
        const { target, attribute, value } = entry;
        const directive = parseDirective(attribute, value);
        if (directive.kind !== 'init')
          throw new LiveClientError(
            'DIRECTIVE',
            'Expected an initialization directive',
          );
        const action = directive.value;
        if (++initializations > initLimit)
          throw new LiveClientError(
            'DIRECTIVE',
            'Automatic initialization capacity reached',
          );
        initialization?.schedule(
          target,
          directive.timing ?? 'eager',
          () => {
            void schedule(state, action, false).catch(() => undefined);
          },
          () => {
            if (
              registeredScope(target) !== state ||
              failureFor(state) ||
              ignored(target, state.root) ||
              target.getAttribute(attribute) !== value ||
              target.hasAttribute('nv:confirm')
            )
              return false;
            validateDirectives(
              state.root,
              streams,
              uploadEndpoint !== undefined,
            );
            return true;
          },
        );
      } catch (error) {
        report(error, state.root);
      }
    }
  }
  /** Progress hook for UI: `nestvexa:request` with the action name and phase only. */
  function progress(state: Component, detail: LiveRequestProgress): void {
    state.root.dispatchEvent(
      new window.CustomEvent('nestvexa:request', {
        bubbles: true,
        detail: Object.freeze(detail),
      }),
    );
  }
  function diagnostic(
    phase: LiveDiagnostic['phase'],
    outcome: LiveDiagnostic['outcome'],
    start: number | undefined,
    end: number | undefined,
  ): void {
    if (start === undefined || end === undefined || !options.onDiagnostic)
      return;
    const milliseconds = end - start;
    if (!Number.isFinite(milliseconds)) return;
    try {
      options.onDiagnostic(
        Object.freeze({
          phase,
          outcome,
          milliseconds: Math.max(0, milliseconds),
        }),
      );
    } catch {
      // An optional instrumentation sink must not change mutation/retry semantics.
    }
  }
  async function invoke(
    state: Component,
    action: string,
    queuedAt?: number,
    input: LiveActionInput = null,
    allowRenderless = true,
    /** Render even without dirty fields (lazy first render). */
    force = false,
  ): Promise<void> {
    flushResets();
    if (!usable(state)) return;
    const failure = failureFor(state);
    if (failure) throw failure;
    for (const [element] of state.invalid)
      if (!contains(element) || owner(element) !== state.root)
        state.invalid.delete(element);
    if (state.invalid.size)
      throw new LiveClientError(
        'DIRECTIVE',
        'Correct invalid model values before submitting',
      );
    modelSelections(state.root, (field) => current(state, field));
    if (action === '_sync' && !force && !hasChanges(state)) return;
    const sent = new Map(state.dirty);
    const updates = Object.create(null) as Record<string, unknown>;
    // Nested model paths are sent as their whole top-level field: the current
    // server value with every dirty leaf applied. The server accepts it only
    // when each difference lies on a writable path of its allowlist.
    for (const [key, field] of sent) {
      const path = key.split('.');
      const top = path.shift() ?? key;
      const leaf = path.pop();
      if (leaf === undefined) {
        updates[top] = field.value;
        continue;
      }
      let target = (updates[top] ??= structuredClone(state.values[top]));
      for (const part of path) target = readPath(target, part);
      if (
        !target ||
        typeof target !== 'object' ||
        readPath(target, leaf) === undefined
      )
        throw new LiveClientError(
          'DIRECTIVE',
          'Nested model path is not public object state',
        );
      Reflect.set(target, leaf, field.value);
    }
    const requestId = window.crypto.randomUUID();
    const body = JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId,
      snapshot: state.snapshot,
      revision: state.revision,
      updates,
      input,
    });
    if (new TextEncoder().encode(body).byteLength > 65_536)
      throw new LiveClientError(
        'DIRECTIVE',
        'Live request exceeds the 65536-byte envelope limit',
      );
    let abort = new AbortController();
    state.request = abort;
    const name = action === '_sync' ? '$sync' : action;
    progress(state, { action: name, phase: 'start', attempt: 0 });
    const startedAt = options.onDiagnostic
      ? window.performance.now()
      : undefined;
    let responseAt: number | undefined;
    let morphAt: number | undefined;
    let applied = false;
    let failed = false;
    /** The browser reported no connectivity, so nothing reached the server. */
    let unsent = false;
    const assetVersion = state.root.getAttribute('data-nv-asset-version');
    try {
      if (window.navigator.onLine === false) {
        unsent = true;
        throw new LiveClientError('NETWORK', 'Offline: request not sent');
      }
      let payload: unknown;
      for (let attempt = 0; ; attempt++)
        try {
          payload = await requestLive(
            transport,
            `${state.endpoint}/${action}`,
            {
              method: 'POST',
              credentials: 'same-origin',
              redirect: 'error',
              headers: {
                'content-type': 'application/json',
                'x-nestvexa-csrf': state.csrf,
                ...(allowRenderless
                  ? { 'x-nestvexa-capabilities': 'renderless-v1' }
                  : {}),
                ...(assetVersion === null
                  ? {}
                  : { 'x-nestvexa-asset-version': assetVersion }),
              },
              body,
            },
            abort,
            {
              setTimeout: (callback, milliseconds) =>
                window.setTimeout(callback, milliseconds),
              clearTimeout: (timer) => window.clearTimeout(timer),
            },
            timeout,
          );
          break;
        } catch (error) {
          // Only server-declared idempotent actions are resent, with the same
          // requestId and bytes: the server replays a committed result instead
          // of running it twice. Two retries with full jitter, never for $sync.
          if (
            attempt > 1 ||
            !state.idempotent.has(action) ||
            !(error instanceof LiveClientError) ||
            !(error instanceof LiveHttpError
              ? !error.reload &&
                [409, 429, 502, 503, 504].includes(error.status)
              : error.code === 'NETWORK' || error.code === 'TIMEOUT')
          )
            throw error;
          progress(state, {
            action: name,
            phase: 'retry',
            attempt: attempt + 1,
          });
          await new Promise((resolve) =>
            window.setTimeout(
              resolve,
              100 + Math.random() * 400 * 2 ** attempt,
            ),
          );
          if (!usable(state) || failureFor(state)) throw error;
          abort = new AbortController();
          state.request = abort;
        }
      responseAt = options.onDiagnostic ? window.performance.now() : undefined;
      if (!usable(state)) return;
      // A parent may suspend this registration after the transport race won
      // but before this continuation runs. Never apply that settled response.
      const interrupted = failureFor(state);
      if (interrupted) throw interrupted;
      morphAt = options.onDiagnostic ? window.performance.now() : undefined;
      const result = parseLiveResponse(payload);
      if (result.renderless && !allowRenderless)
        throw new LiveClientError(
          'RESPONSE',
          'This interaction requires server-rendered HTML',
        );
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
      // Renderless acknowledgements never parse HTML.
      let template: HTMLTemplateElement | undefined;
      if (!result.renderless) {
        template = doc.createElement('template');
        template.innerHTML = trustedHTML(window, result.html);
        // Markup naming a feature whose chunk has not loaded waits for it, so
        // the response is validated exactly as if every chunk were present.
        const missing = useFeatures(directiveFeaturesIn(template.content));
        if (missing.length) {
          await Promise.all(missing.map((feature) => loadFeature(feature)));
          if (!usable(state)) return;
          const suspended = failureFor(state);
          if (suspended) throw suspended;
          startFeatures();
        }
      }
      const dirty = new Map<string, unknown>();
      for (const [key, field] of state.dirty)
        if (sent.get(key)?.version !== field.version)
          dirty.set(key, field.value);
      for (const element of owned(state.root))
        if (composing.has(element)) {
          const model = getModelDirective(element);
          if (model) dirty.set(model.field, current(state, model.field));
        }
      const read = (field: string): unknown =>
        dirty.has(field) ? dirty.get(field) : readPath(result.state, field);
      const differs = (field?: string): boolean =>
        changed(dirty, result.state, field);
      // Binding visibility changes can trigger browser scroll anchoring.
      let retainedScroll: { top: number; left: number } | undefined;
      if (result.renderless) {
        // A state acknowledgement must not clone widgets or run HTML morph
        // lifecycle. Validate its local bindings against the retained subtree.
        morphAt = undefined;
        retainedScroll = {
          top: state.root.scrollTop,
          left: state.root.scrollLeft,
        };
        validateDirectives(state.root, streams, uploadEndpoint !== undefined);
        modelSelections(state.root, read, state.invalid);
        prepareBindings(state.root, read, differs, focus);
      } else {
        if (!template)
          throw new LiveClientError('RESPONSE', 'Missing Live response HTML');
        validateFragment(template.content);
        const incoming = prepareMorph(state.root, template.content);
        const preview = state.root.cloneNode(false) as Element;
        preview.append(incoming.cloneNode(true));
        validateDirectives(preview, streams, uploadEndpoint !== undefined);
        // A changed model shape/cast has no compatible array draft. Validate its
        // authoritative response value rather than projecting the old scalar/cast.
        const arrayCasts = new Map<string, string>();
        for (const element of owned(state.root)) {
          const model = getModelDirective(element);
          if (
            model &&
            element.tagName === 'SELECT' &&
            (element as HTMLSelectElement).multiple
          )
            arrayCasts.set(model.field, model.cast);
        }
        for (const element of owned(preview)) {
          const model = getModelDirective(element);
          if (
            model &&
            element.tagName === 'SELECT' &&
            (element as HTMLSelectElement).multiple &&
            arrayCasts.get(model.field) !== model.cast
          )
            dirty.delete(model.field);
        }
        const selections = modelSelections(preview, read);
        applyBindings(preview, read, differs, focus);
        for (const apply of selections) apply();
        const focused = state.root.contains(doc.activeElement)
          ? doc.activeElement
          : null;
        const caret = selection(focused);
        const editorSelection = captureEditorSelection(focused, state.root);
        const scroll = {
          top: state.root.scrollTop,
          left: state.root.scrollLeft,
        };
        const previousControls = new Map<
          string,
          { element: Element; signature: string }[]
        >();
        for (const element of owned(state.root)) {
          const model = getModelDirective(element);
          if (
            model &&
            (state.dirty.has(model.field) || state.invalid.has(element))
          ) {
            const controls = previousControls.get(model.field) ?? [];
            controls.push({ element, signature: controlSignature(element) });
            previousControls.set(model.field, controls);
          }
        }
        loading.restore(state.root);
        presentation?.restore(state.root);
        // Reconcile drag attributes against fresh server baselines after morphing.
        sorting?.remove(state.root);
        morphChildren(state.root, incoming, dirty, {
          beforeRemove(node): void {
            if (editorSelection)
              editorSelection.observe(() => beforeRemove(node));
            else beforeRemove(node);
          },
          afterInsert(node): void {
            if (editorSelection)
              editorSelection.observe(() => afterInsert(node));
            else afterInsert(node);
          },
        });
        for (const [field, controls] of previousControls) {
          let survives = false;
          for (const { element, signature } of controls) {
            const retained =
              element.isConnected &&
              owner(element) === state.root &&
              getModelDirective(element)?.field === field &&
              controlSignature(element) === signature;
            if (retained) survives = true;
            else state.invalid.delete(element);
          }
          if (!survives) state.dirty.delete(field);
        }
        for (const [element] of state.invalid)
          if (!element.isConnected || owner(element) !== state.root)
            state.invalid.delete(element);
        // A refreshed child root replaced the focused subtree: follow the
        // same keyed child and element id into the replacement.
        if (
          focused &&
          !focused.isConnected &&
          focused.id &&
          !focusMoved(doc, focused)
        ) {
          const key = owner(focused)?.getAttribute('data-nv-key');
          const child = key
            ? [...state.root.querySelectorAll('[data-nv-key]')].find(
                (element) => element.getAttribute('data-nv-key') === key,
              )
            : undefined;
          const next = child
            ? [...child.querySelectorAll('[id]')].find(
                (element) => element.id === focused.id,
              )
            : undefined;
          if (next instanceof window.HTMLElement && availableForFocus(next))
            next.focus({ preventScroll: true });
        }
        // Lifecycle hooks may deliberately choose a different focus target. Preserve it.
        if (focused && !focusMoved(doc, focused)) {
          const retained =
            focused instanceof window.HTMLElement && availableForFocus(focused);
          if (retained) {
            editorSelection?.restore();
            if (!focusMoved(doc, focused))
              focused.focus({ preventScroll: true });
          }
          // A retained INPUT may now have a type without the selection API.
          if (
            retained &&
            doc.activeElement === focused &&
            caret &&
            selection(focused) !== null
          )
            (focused as HTMLInputElement).setSelectionRange(
              caret.start,
              caret.end,
              caret.direction,
            );
          if (
            (!retained || doc.activeElement !== focused) &&
            !focusMoved(doc, focused) &&
            state.root instanceof window.HTMLElement &&
            availableForFocus(state.root)
          ) {
            focus.focus(state.root, state.root);
          }
        }
        state.root.scrollTop = scroll.top;
        state.root.scrollLeft = scroll.left;
      }
      for (const [key, field] of sent)
        if (state.dirty.get(key)?.version === field.version)
          state.dirty.delete(key);
      if (!usable(state)) return;
      const interruptedBeforeCommit = failureFor(state);
      if (interruptedBeforeCommit) throw interruptedBeforeCommit;
      state.snapshot = result.snapshot;
      state.revision = result.component.revision;
      const previousValues = state.values;
      state.values = result.state;
      refreshBindings(state);
      if (retainedScroll) {
        state.root.scrollTop = retainedScroll.top;
        state.root.scrollLeft = retainedScroll.left;
      }
      busy(state);
      const encodedState = JSON.stringify(result.state);
      state.markers.set('data-nv-state', encodedState);
      state.markers.set('data-nv-snapshot', result.snapshot);
      state.markers.set('data-nv-revision', String(state.revision));
      state.root.setAttribute('data-nv-state', encodedState);
      state.root.setAttribute('data-nv-snapshot', result.snapshot);
      state.root.setAttribute('data-nv-revision', String(state.revision));
      discover();
      presentation?.setNetworkFailure(state.root, false);
      if (result.url?.length) {
        applyUrlEffects(window, result.url);
        urlHistory = true;
        for (const item of components.values())
          presentation?.refresh(item.root);
      }
      applied = true;
      state.root.dispatchEvent(
        new window.CustomEvent('nestvexa:updated', {
          bubbles: true,
          detail: { requestId, revision: state.revision },
        }),
      );
      if (result.realtime !== undefined) {
        state.root.setAttribute('data-nv-realtime', result.realtime);
        refreshRealtime();
      }
      if (
        result.title !== undefined &&
        !state.root.parentElement?.closest('[data-nv-component]')
      )
        doc.title = result.title;
      propagateModel(state, previousValues);
      if (result.events?.length) deliverEvents(result.events, state);
      if (result.download) {
        const anchor = doc.createElement('a');
        anchor.href = result.download.url;
        anchor.download = result.download.filename;
        anchor.rel = 'noopener';
        anchor.hidden = true;
        doc.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
      if (result.redirect !== undefined) {
        if (navigation) void navigation.visit(result.redirect);
        else window.location.assign(result.redirect);
      }
    } catch (error) {
      if (!usable(state)) return;
      failed = true;
      const networkFailure =
        error instanceof LiveClientError &&
        (error.code === 'NETWORK' || error.code === 'TIMEOUT');
      const previous = failureFor(state);
      if (previous) throw previous;
      if (error instanceof LiveHttpError && error.reload)
        if (
          window.dispatchEvent(
            new window.CustomEvent('nestvexa:reload', {
              cancelable: true,
              detail: { reason: 'asset-version' },
            }),
          )
        )
          window.location.reload();
      // Without a response, an unsent request or a `$sync` (no action method
      // runs; a committed one is caught by the next revision check) stays
      // usable. An action that may have reached the server suspends.
      const recoverable =
        (networkFailure && (unsent || action === '_sync')) ||
        (error instanceof LiveHttpError &&
          [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status));
      if (!recoverable)
        suspend(
          state,
          error instanceof Error
            ? error
            : new LiveClientError(
                'RESPONSE',
                'Live response could not be applied; reconcile server state before further actions',
              ),
        );
      if (networkFailure)
        for (const child of components.values())
          if (child === state || state.root.contains(child.root))
            presentation?.setNetworkFailure(child.root, true);
      throw error;
    } finally {
      state.request = null;
      const finishedAt = options.onDiagnostic
        ? window.performance.now()
        : undefined;
      const outcome = applied
        ? 'succeeded'
        : failed
          ? 'failed'
          : abort.signal.aborted || !state.active || !mounted
            ? 'cancelled'
            : 'failed';
      // Emit after application/cleanup: observers cannot interleave a partial morph.
      diagnostic('queue', outcome, queuedAt, startedAt);
      diagnostic(
        'request',
        responseAt === undefined ? outcome : 'succeeded',
        startedAt,
        responseAt ?? finishedAt,
      );
      diagnostic('morph', outcome, morphAt, finishedAt);
      progress(state, { action: name, phase: 'end', outcome });
    }
  }
  function schedule(
    state: Component,
    action: string,
    submit: boolean,
    input: LiveActionInput = null,
    allowRenderless = true,
    force = false,
  ): Promise<void> {
    const failure = failureFor(state);
    if (failure) return Promise.reject(failure);
    if (action !== '_sync')
      for (const element of owned(state.root)) models.cancel(element);
    // Bundling: every request carries all drafts at the moment it starts, so a
    // model synchronization queued behind a request that has not started yet
    // is redundant and folds into it (one request instead of several).
    if (action === '_sync' && !force && state.waiting) return state.waiting;
    if (state.pending >= 16)
      throw new LiveClientError('DIRECTIVE', 'Live request queue is full');
    if (submit && state.submitting) return Promise.resolve();
    if (submit) state.submitting = true;
    const targetAction = action === '_sync' ? '$sync' : action;
    state.pending++;
    state.pendingActions.set(
      targetAction,
      (state.pendingActions.get(targetAction) ?? 0) + 1,
    );
    try {
      busy(state);
    } catch (error) {
      state.pending--;
      const count = (state.pendingActions.get(targetAction) ?? 1) - 1;
      if (count) state.pendingActions.set(targetAction, count);
      else state.pendingActions.delete(targetAction);
      if (submit) state.submitting = false;
      throw error;
    }
    const queuedAt = options.onDiagnostic
      ? window.performance.now()
      : undefined;
    const task: Promise<void> = state.queue
      .then(() => {
        if (state.waiting === task) state.waiting = undefined;
        return invoke(state, action, queuedAt, input, allowRenderless, force);
      })
      .finally(() => {
        state.pending--;
        const count = (state.pendingActions.get(targetAction) ?? 1) - 1;
        if (count) state.pendingActions.set(targetAction, count);
        else state.pendingActions.delete(targetAction);
        if (submit) state.submitting = false;
        if (state.active && mounted) busy(state);
      });
    state.waiting = task;
    state.queue = task.catch((error: unknown) => {
      if (state.active && mounted && error !== failureFor(state))
        report(error, state.root);
    });
    return task;
  }
  function target(event: Event): Element | null {
    return event.target instanceof window.Element ? event.target : null;
  }
  function input(event: Event, control?: Element, type = event.type): void {
    flushResets();
    const element = control ?? target(event);
    if (
      !element ||
      composing.has(element) ||
      ('isComposing' in event && event.isComposing)
    )
      return;
    const state = registeredScope(element);
    if (!state || ignored(element, state.root)) return;
    try {
      let directive: ModelDirective | undefined;
      try {
        directive = getModelDirective(element);
      } catch (error) {
        // A mutated invalid catalog must not silently submit an earlier value.
        state.invalid.set(element, '');
        models.cancel(element);
        throw error;
      }
      if (!directive) return;
      const name = directive.field;
      const previous = current(state, name);
      if (readPath(state.values, name) === undefined)
        throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      let value: Field | undefined;
      try {
        value = readModelValue(
          element,
          directive,
          group(state, element, name, previous),
        );
      } catch (error) {
        state.invalid.set(element, name);
        models.cancel(element);
        // Preserve an invalid in-progress edit against an older response without sending it.
        if (
          typeof previous === 'string' ||
          typeof previous === 'number' ||
          typeof previous === 'boolean' ||
          Array.isArray(previous)
        )
          state.dirty.set(name, {
            value: Array.isArray(previous)
              ? copyModelArray(previous)
              : previous,
            version: ++state.fieldVersion,
          });
        refreshBindings(state);
        throw error;
      }
      if (value === undefined) return;
      state.invalid.delete(element);
      if (!sameModelValue(previous, value))
        state.dirty.set(name, { value, version: ++state.fieldVersion });
      refreshBindings(state);
      if (
        !failureFor(state) &&
        ((directive.mode === 'live' && type === 'input') ||
          (directive.mode === 'change' && type === 'change') ||
          (directive.mode === 'blur' && type === 'focusout'))
      )
        models.schedule(element, name, directive);
    } catch (error) {
      report(error, state.root);
    }
  }
  function composition(event: Event): void {
    const element = target(event);
    if (!element) return;
    if (event.type === 'compositionstart') {
      composing.add(element);
      models.cancel(element);
    } else {
      composing.delete(element);
      input(event, element, 'input');
    }
  }
  function resolveEvent(
    event: Event,
  ):
    | { element: Element; attribute: string; directive: EventDirective }
    | undefined {
    const origin = target(event);
    const state = origin ? registeredScope(origin) : undefined;
    const scope = state?.root;
    if (!origin || !scope || ignored(origin, scope)) return;
    let element: Element | null = origin;
    while (element && contains(element)) {
      const attribute = [...element.attributes].find(
        (item) =>
          item.name === `nv:${event.type}` ||
          item.name.startsWith(`nv:${event.type}.`),
      );
      const directive = attribute
        ? parseEventDirective(attribute.name, attribute.value)
        : undefined;
      // Window/document bindings run from their own listener only.
      if (attribute && directive && !directive.scope)
        return { element, attribute: attribute.name, directive };
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
    const state = registeredScope(binding.element);
    if (state && failureFor(state)) return;
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
          if (directive.stop || directive.scope)
            bindings.push({
              element,
              attribute: attribute.name,
              event: directive.kind,
              scope: directive.scope,
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
    const state = registeredScope(element);
    if (!state)
      throw new LiveClientError(
        'MARKER',
        'Element is not owned by an active Live client',
      );
    return state;
  }
  function makeConfirmations(): ReturnType<
    typeof createConfirmationController
  > {
    return createConfirmationController({
      confirm:
        options.confirm ?? ((context) => window.confirm(context.message)),
      ...(options.confirmationTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.confirmationTimeoutMs }),
      now: () => window.performance.now(),
      setTimeout: (callback, milliseconds) =>
        window.setTimeout(callback, milliseconds),
      clearTimeout: (id) => window.clearTimeout(id),
    });
  }
  function confirmationSignature(element: Element): string {
    return JSON.stringify(
      [...element.attributes]
        .filter((attribute) =>
          /^nv:(?:click|submit|keydown|confirm)(?:\.|$)/.test(attribute.name),
        )
        .map(({ name, value }) => [name, value])
        .sort(),
    );
  }
  /** Apply declared nv:optimistic projections; returns the settle callback. */
  function applyOptimistic(
    state: Component,
    element: Element,
    action: string,
  ): (succeeded: boolean) => void {
    const directives = [...element.attributes]
      .filter((attribute) => attribute.name.startsWith('nv:optimistic.'))
      .map((attribute) =>
        parseOptimisticDirective(attribute.name, attribute.value),
      );
    if (!directives.length) return () => undefined;
    const token = Symbol('optimistic');
    const read = (field: string): unknown =>
      state.optimistic.has(field)
        ? state.optimistic.get(field)?.value
        : current(state, field);
    const projected = new Map<string, unknown>();
    for (const directive of directives) {
      if (!Object.hasOwn(state.values, directive.field))
        throw new LiveClientError('DIRECTIVE', 'Unknown optimistic field');
      projected.set(
        directive.field,
        projectOptimistic(directive, read(directive.field)),
      );
    }
    for (const [field, value] of projected)
      state.optimistic.set(field, { value, token });
    refreshBindings(state);
    return (succeeded) => {
      const fields: string[] = [];
      for (const [field, entry] of state.optimistic)
        if (entry.token === token) {
          state.optimistic.delete(field);
          fields.push(field);
        }
      if (!fields.length) return;
      if (components.get(state.root) === state) refreshBindings(state);
      if (!succeeded)
        state.root.dispatchEvent(
          new window.CustomEvent('nestvexa:rollback', {
            bubbles: true,
            detail: Object.freeze({ action, fields: Object.freeze(fields) }),
          }),
        );
    };
  }
  function invokeEvent(element: Element, action: string): Promise<void> {
    const state = componentFor(element);
    const invoke = () => {
      const submit = element.tagName === 'FORM';
      if (submit && state.submitting) return Promise.resolve();
      const settle = applyOptimistic(state, element, action);
      const previous = doc.activeElement;
      const revision = state.revision;
      return schedule(state, action, submit).then(
        () => {
          settle(true);
          // Accessible validation: move to the first invalid field of the
          // submitted form unless the user already moved focus.
          if (
            submit &&
            components.get(state.root) === state &&
            state.revision !== revision
          )
            focusFirstInvalid(
              element,
              previous,
              state.root,
              (node) =>
                owner(node) === state.root && !ignored(node, state.root),
            );
        },
        () => settle(false),
      );
    };
    const declarations = [...element.attributes].filter((attribute) =>
      /^nv:confirm(?:\.|$)/.test(attribute.name),
    );
    if (!declarations.length) return invoke();
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration?.name !== 'nv:confirm')
      throw new LiveClientError(
        'DIRECTIVE',
        'Use one unmodified nv:confirm declaration',
      );
    const message = declaration.value;
    parseDirective('nv:confirm', message);
    if (failureFor(state) || state.submitting) return Promise.resolve();
    const signature = confirmationSignature(element);
    const current = () =>
      registeredScope(element) === state &&
      !failureFor(state) &&
      !ignored(element, state.root) &&
      !element.matches(':disabled') &&
      !element.closest('[hidden],[inert]') &&
      confirmationSignature(element) === signature;
    return confirmations
      .approve(element, action, message, current)
      .then((approved) => {
        if (approved && current()) return invoke();
      });
  }
  function realtimeChannels(state: Component): readonly string[] {
    const token = state.root.getAttribute('data-nv-realtime');
    if (token === null) return [];
    try {
      return tokenChannels(token);
    } catch (error) {
      report(error, state.root);
      return [];
    }
  }
  function refreshRealtime(): void {
    const endpoint = options.realtime;
    if (!mounted || !endpoint || root.nodeType !== 9) return;
    const tokens: string[] = [];
    for (const state of components.values()) {
      const token = state.root.getAttribute('data-nv-realtime');
      if (token !== null && usable(state) && realtimeChannels(state).length)
        tokens.push(token);
    }
    try {
      if (!realtime) {
        // The transport chunk loads with the first subscribed component.
        if (!tokens.length) return;
        const module = featureModules.realtime;
        if (!module) {
          requestFeatures(['realtime']);
          return;
        }
        realtime = startRealtime(module, endpoint);
      }
      realtime.update(tokens.slice(0, 32));
    } catch (error) {
      report(error, null);
    }
  }
  /** Coalesce bursts: one forced refresh per component per 50 ms window. */
  function invalidate(state: Component): void {
    if (realtimeRefresh.has(state)) return;
    realtimeRefresh.set(
      state,
      window.setTimeout(() => {
        realtimeRefresh.delete(state);
        if (usable(state) && !failureFor(state))
          void schedule(state, '_sync', false, null, false, true).catch(
            () => undefined,
          );
      }, 50),
    );
  }
  function loadLazy(state: Component): void {
    void schedule(state, '_sync', false, null, false, true).then(
      () => {
        if (components.get(state.root) === state)
          state.root.removeAttribute('data-nv-lazy');
      },
      () => undefined,
    );
  }
  function deliverEvents(
    events: readonly LiveEvent[],
    source: Component | undefined,
    /** Deliver only to these subscribed components (server-pushed events). */
    only?: ReadonlySet<Component>,
  ): void {
    for (const event of events) {
      window.dispatchEvent(
        new window.CustomEvent('nestvexa:event', {
          detail: Object.freeze({
            name: event.name,
            payload: structuredClone(event.payload),
            source: source?.name ?? null,
          }),
        }),
      );
      let delivered = 0;
      for (const target of [...components.values()]) {
        if (!usable(target) || failureFor(target)) continue;
        if (only && !only.has(target)) continue;
        if (event.self === true && target !== source) continue;
        if (event.to !== undefined && target.name !== event.to) continue;
        for (const action of target.listeners.get(event.name) ?? []) {
          if (++delivered > 64) {
            report(
              new LiveClientError(
                'DIRECTIVE',
                'Live event delivery exceeded 64 listener actions',
              ),
              target.root,
            );
            return;
          }
          const input =
            event.payload === null ? null : cloneActionInput(event.payload);
          void schedule(target, action, false, input).catch(() => undefined);
        }
      }
    }
  }
  function propagateModel(
    state: Component,
    previous: Readonly<Record<string, unknown>>,
  ): void {
    if (!state.model) return;
    const { parent: field, child } = state.model;
    const value = state.values[child];
    if (JSON.stringify(previous[child]) === JSON.stringify(value)) return;
    const parentState = state.root.parentElement
      ? registeredScope(state.root.parentElement)
      : undefined;
    if (!parentState || !Object.hasOwn(parentState.values, field)) return;
    const scalar = (item: unknown): boolean =>
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item));
    if (!scalar(value) && !(Array.isArray(value) && value.every(scalar))) {
      report(
        new LiveClientError(
          'DIRECTIVE',
          'Modelable values must be primitives or primitive arrays',
        ),
        state.root,
      );
      return;
    }
    parentState.dirty.set(field, {
      value: structuredClone(value) as Field,
      version: ++parentState.fieldVersion,
    });
    refreshBindings(parentState);
    void schedule(parentState, '_sync', false).catch(() => undefined);
  }
  /** Every owned checkbox of an array field, when `element` is one of them. */
  function group(
    state: Component,
    element: Element,
    field: string,
    value: unknown,
  ): Element[] | undefined {
    return isCheckbox(element) && Array.isArray(value)
      ? owned(state.root).filter(
          (item) =>
            isCheckbox(item) && getModelDirective(item)?.field === field,
        )
      : undefined;
  }
  /**
   * Values the browser restored into model controls before mount (reload,
   * history or autofill form restoration) differ from server state without a
   * user edit in this lifecycle. Keep them as drafts, so nv:dirty shows them
   * and the next request carries them, and announce the fields.
   */
  function restoreDrafts(state: Component): readonly string[] {
    const fields: string[] = [];
    for (const element of owned(state.root)) {
      const directive = getModelDirective(element);
      if (!directive || !changedFromDefault(element)) continue;
      const field = directive.field;
      try {
        const prior = current(state, field);
        const value = readModelValue(
          element,
          directive,
          group(state, element, field, prior),
        );
        if (
          value !== undefined &&
          prior !== undefined &&
          !sameModelValue(value, prior)
        ) {
          state.dirty.set(field, { value, version: ++state.fieldVersion });
          fields.push(field);
        }
      } catch {
        // An unrepresentable restored value stays native-only and is never sent.
      }
    }
    return fields;
  }
  /** The local draft of a field or nested path, else its server value. */
  function current(state: Component, field: string): unknown {
    return state.dirty.has(field)
      ? state.dirty.get(field)?.value
      : readPath(state.values, field);
  }
  /** nv:dirty for a field also reflects drafts of its nested paths. */
  function isDirty(state: Component, field?: string): boolean {
    return (
      [...state.invalid.values()].some((key) => covers(field, key)) ||
      changed(
        [...state.dirty].map(([key, item]) => [key, item.value] as const),
        state.values,
        field,
      )
    );
  }
  function refreshBindings(state: Component): void {
    const read = (field: string): unknown => current(state, field);
    // Optimistic projections affect display bindings only, never sent drafts.
    const display = (field: string): unknown =>
      state.optimistic.has(field)
        ? state.optimistic.get(field)?.value
        : read(field);
    const selections = modelSelections(state.root, read, state.invalid);
    applyBindings(
      state.root,
      display,
      (field) => isDirty(state, field),
      focus,
      (element, shown, apply) => {
        if (presentation) presentation.show(element, shown, apply);
        else apply();
      },
    );
    for (const apply of selections) apply();
  }
  function hasChanges(state: Component): boolean {
    return state.invalid.size > 0 || isDirty(state);
  }
  const api: LiveClient = {
    refs(element: Element): ReadonlyMap<string, Element> {
      return queryRefs(componentFor(element).root);
    },
    startStream(target: Element): Promise<StreamResult> {
      try {
        componentFor(target);
        if (streaming) return streaming.start(target);
        return featureController('stream', () => streaming).then((controller) =>
          controller.start(target),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    cancelStream(target: Element): void {
      streaming?.cancel(target);
    },
    upload(input: Element): Promise<readonly string[]> {
      if (uploading) return uploading.start(input);
      return featureController('upload', () => uploading).then((controller) =>
        controller.start(input),
      );
    },
    cancelUpload(element: Element): void {
      uploading?.cancel(element);
    },
    inspect(): readonly LiveInspection[] {
      if (options.development !== true)
        throw new LiveClientError(
          'DIRECTIVE',
          'inspect() requires the development option',
        );
      return Object.freeze(
        [...components.values()].map((state) => {
          const failure = failureFor(state);
          return Object.freeze({
            id: state.id,
            name: state.name,
            revision: state.revision,
            pending: Object.freeze(Object.fromEntries(state.pendingActions)),
            dirty: Object.freeze([...state.dirty.keys()]),
            invalid: state.invalid.size,
            failure: failure
              ? failure instanceof LiveClientError
                ? failure.code
                : failure.name
              : null,
            idempotent: Object.freeze([...state.idempotent]),
          });
        }),
      );
    },
    navigate(url: string): Promise<void> {
      if (!navigation)
        return Promise.reject(
          new LiveClientError('DIRECTIVE', 'Live client is not mounted'),
        );
      return navigation.visit(url);
    },
    dispatch(name: string, payload: unknown = null): void {
      if (!mounted)
        throw new LiveClientError('DIRECTIVE', 'Live client is not mounted');
      deliverEvents(
        [
          {
            name: parseEventName(name),
            payload: payload === null ? null : cloneActionInput(payload),
          },
        ],
        undefined,
      );
    },
    call(element: Element, action: string, input?: unknown): Promise<void> {
      try {
        return schedule(
          componentFor(element),
          parseIdentifier(action),
          false,
          input === undefined ? null : cloneActionInput(input),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    get(element: Element, name: string): unknown {
      flushResets();
      const state = componentFor(element);
      const key = parsePath(name);
      if (readPath(state.values, key) === undefined)
        throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      return structuredClone(current(state, key));
    },
    set(
      element: Element,
      name: string,
      value: string | number | boolean,
    ): void {
      flushResets();
      const state = componentFor(element);
      const key = parsePath(name);
      if (readPath(state.values, key) === undefined)
        throw new LiveClientError('DIRECTIVE', 'Unknown public state field');
      if (
        !['string', 'boolean', 'number'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new LiveClientError(
          'DIRECTIVE',
          'Expected finite primitive state',
        );
      // Preserve the previous valid draft if a primitive cannot describe an
      // active multiple-select field. Public set remains primitive-only.
      modelSelections(state.root, (field) =>
        field === key ? value : current(state, field),
      );
      state.dirty.set(key, { value, version: ++state.fieldVersion });
      refreshBindings(state);
    },
    transition(element: Element, phase: 'enter' | 'leave'): Promise<boolean> {
      try {
        const state = componentFor(element);
        if (
          ignored(element, state.root) ||
          !presentation ||
          (phase !== 'enter' && phase !== 'leave')
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'Transition requires an owned element and enter/leave phase',
          );
        return presentation[phase](element);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    mount(): void {
      if (mounted) return;
      if (options.realtime && root.nodeType === 9) {
        // Fail at mount, as before the transport moved into its own chunk.
        const endpoint = new URL(
          options.realtime.endpoint,
          window.location.href,
        );
        if (
          endpoint.origin !== window.location.origin ||
          endpoint.search ||
          endpoint.hash
        )
          throw new LiveClientError(
            'DIRECTIVE',
            'Realtime endpoint must be same-origin without query or fragment',
          );
      }
      models = makeModels();
      confirmations = makeConfirmations();
      focus = createFocusController();
      loading = createLoadingController(focus);
      presentation = createPresentationController({
        window,
        focus,
        onError: report,
      });
      initialization = createInitializationScheduler({
        window,
        onError: (error, element) => report(error, owner(element)),
      });
      background = createObserverController({
        window,
        maxRegistrations: observerLimit,
        usable: (element) => {
          const state = registeredScope(element);
          return (
            state !== undefined &&
            !failureFor(state) &&
            !ignored(element, state.root)
          );
        },
        invoke: async (element, action) => {
          const task = schedule(componentFor(element), action, false);
          try {
            await task;
          } catch (error) {
            if (error && typeof error === 'object')
              reportedBackground.add(error);
            throw error;
          }
        },
        onError: (error, element) => {
          if (
            error &&
            typeof error === 'object' &&
            reportedBackground.has(error)
          )
            return;
          report(error, owner(element));
        },
      });
      mounted = true;
      // Sort, stream, upload and realtime controllers start from discovery
      // once their chunk has loaded (startFeatures/refreshRealtime).
      generation++;
      initializations = 0;
      if (root.nodeType === 9)
        navigation = createNavigationController({
          window,
          fetch: transport,
          hasUnsavedChanges: () =>
            [...components.values()].some(
              (state) => usable(state) && hasChanges(state),
            ),
          confirmLeave: (message) => window.confirm(message),
          onError: (error) => report(error, null),
          onNavigated: () => {
            // A swapped document starts a fresh URL-state history scope.
            urlHistory = false;
          },
        });
      dispatcher = createEventDispatcher({
        // The component queue reports transport errors once and suppresses released work.
        invoke: invokeEvent,
        preventDefault: (element) =>
          [...element.attributes].some((attribute) =>
            /^nv:confirm(?:\.|$)/.test(attribute.name),
          ),
        onError: (error, element) => report(error, element),
      });
      discover();
      root.addEventListener('click', action);
      root.addEventListener('submit', action);
      root.addEventListener('keydown', action);
      root.addEventListener('input', input);
      root.addEventListener('change', input);
      root.addEventListener('focusout', input);
      root.addEventListener('compositionstart', composition);
      root.addEventListener('compositionend', composition);
      doc.addEventListener('reset', reset, true);
      window.addEventListener('popstate', restoreUrl);
      observer = new window.MutationObserver((mutations) => {
        if (mounted) confirmations.prune();
        if (
          mounted &&
          mutations.some(
            (mutation) =>
              mutation.type === 'childList' ||
              mutation.attributeName?.startsWith('nv:') ||
              markerAttributes.has(mutation.attributeName ?? '') ||
              mutation.attributeName === 'data-nv-island',
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
      generation++;
      resets.clear();
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      resetTimer = undefined;
      observer?.disconnect();
      observer = null;
      lazyObserver?.disconnect();
      lazyObserver = undefined;
      navigation?.dispose();
      navigation = undefined;
      realtime?.dispose();
      realtime = undefined;
      dispatcher?.dispose();
      dispatcher = undefined;
      direct.dispose();
      models.dispose();
      confirmations.dispose();
      loading.dispose();
      background?.dispose();
      sorting?.dispose();
      sorting = undefined;
      streaming?.dispose();
      streaming = undefined;
      uploading?.dispose();
      uploading = undefined;
      needed.clear();
      deferred = new WeakSet<Element>();
      awaitingFeatures = new Set<Feature>();
      initialization?.dispose();
      initialization = undefined;
      background = undefined;
      presentation?.dispose();
      presentation = undefined;
      focus.dispose();
      composing = new WeakSet<Element>();
      root.removeEventListener('click', action);
      root.removeEventListener('submit', action);
      root.removeEventListener('keydown', action);
      root.removeEventListener('input', input);
      root.removeEventListener('change', input);
      root.removeEventListener('focusout', input);
      root.removeEventListener('compositionstart', composition);
      root.removeEventListener('compositionend', composition);
      doc.removeEventListener('reset', reset, true);
      window.removeEventListener('popstate', restoreUrl);
      urlHistory = false;
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
  return api;
}
