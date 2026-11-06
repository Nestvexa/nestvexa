import { Body } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
  REDIRECT_METADATA,
  RENDER_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
  SSE_OPTIONS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import type { Type, PipeTransform } from '@nestjs/common';
import { cloneState } from './protocol.js';
import type { JsonValue } from './protocol.js';
import { lifecycleHookNames } from './lifecycle.js';
import { isSynthesizer } from './synthesizers.js';
import type { StateSynthesizer } from './synthesizers.js';
import { collectStateContext } from './state-context.js';
import type { StateContextDefinition } from './state-context.js';

export const INTERNAL_SYNC_ACTION = '$sync';
export const INTERNAL_SYNC_PATH = '_sync';

export interface ComponentOptions {
  readonly name: string;
  readonly view: string;
  /**
   * Explicit child allowlist: template alias → registered component class.
   * Templates mount children with the trusted `nvChild` helper; aliases never
   * resolve arbitrary classes.
   */
  readonly children?: Readonly<Record<string, Type<object>>>;
  /** Render a placeholder at mount and the component body on the first client refresh. */
  readonly lazy?: boolean | 'visible';
  /** Optional view rendered with public state while a lazy component waits. */
  readonly placeholder?: string;
  /**
   * Deadline in milliseconds (1–300000) for each lifecycle hook and the action
   * method. Exceeding it aborts `liveAbortSignal(this)` and fails the request
   * with 504; work already started is not undone. Default: no deadline.
   */
  readonly timeoutMs?: number;
}
/** How a parent may initialize or update a child state field. */
export type PropMode = 'mount' | 'reactive' | 'modelable';
export interface StateOptions {
  readonly writable?: boolean;
  /** Pure validation before any component hook/action runs. False rejects without consuming state. */
  readonly validate?: (value: JsonValue) => boolean | Promise<boolean>;
  /**
   * Trusted typed conversion (for example `DateSynthesizer`). The field holds the
   * typed value; snapshots, templates, validation and client updates use JSON.
   */
  readonly synthesizer?: StateSynthesizer;
  /** Spec-name alias of `synthesizer`; set one or the other. */
  readonly serializer?: StateSynthesizer;
  /**
   * Initial value for a field the class leaves uninitialized (`declare` or `!`).
   * JSON values are deep-cloned per instance; a function is called per instance
   * and may return a typed value for a synthesized field. Never applied to
   * client updates and never overrides restored snapshot state.
   */
  readonly default?: JsonValue | (() => unknown);
}
/** Scope of the exclusive lock an action takes while it runs. */
export type ActionConcurrency = 'component' | 'identity';
export interface ActionOptions {
  readonly id?: string;
  /** Acknowledge state without rendering when the client negotiates support. */
  readonly renderless?: boolean;
  /**
   * Replay the stored response when the same identity resends the same
   * request ID with an identical payload after the action committed, instead
   * of failing with a stale revision. A different payload under the same
   * request ID is rejected (422 IDEMPOTENCY_CONFLICT). Single-process, bounded.
   */
  readonly idempotent?: boolean;
  /**
   * `component` (default): one request per component instance at a time.
   * `identity`: additionally at most one execution of this action per
   * identity across all instances and tabs (409 ACTION_BUSY). Overlaps are
   * always rejected, never queued.
   */
  readonly concurrency?: ActionConcurrency;
}
/** Normalized per-action registration. */
export interface ActionDefinition {
  readonly method: string;
  readonly input: boolean;
  readonly renderless?: true;
  readonly idempotent?: true;
  readonly concurrency?: 'identity';
}
/** Derived JSON values; caches never survive the current component request/stage. */
export interface ComputedOptions {
  /** Explicitly opt a zero-argument method into asynchronous evaluation. Getters stay synchronous. */
  readonly async?: boolean;
  /** Default true; false evaluates on every read. */
  readonly cache?: boolean;
  /** Optional cache lifetime in milliseconds, 1–60000, bounded by the current lifecycle stage. */
  readonly ttl?: number;
  /** Public state fields used as the cache key; default is all declared state. */
  readonly dependencies?: readonly string[];
  /** Async evaluation deadline in milliseconds, 1–300000; default 30000. Does not undo server work. */
  readonly timeoutMs?: number;
}
export interface ComputedDefinition {
  readonly async: boolean;
  readonly cache: boolean;
  readonly ttl?: number;
  readonly dependencies?: readonly string[];
  readonly timeoutMs: number;
  readonly read: (this: object) => unknown;
}
export interface ComponentDefinition {
  readonly type: Type<object>;
  readonly name: string;
  readonly view: string;
  readonly children: ReadonlyMap<string, Type<object>>;
  readonly lazy: false | 'load' | 'visible';
  readonly placeholder?: string;
  readonly timeoutMs?: number;
  readonly props: ReadonlyMap<string, PropMode>;
  /** Event name → listening action ids. */
  readonly listeners: ReadonlyMap<string, readonly string[]>;
  /** Method returning the realtime channels that refresh this component. */
  readonly realtime?: string;
  readonly states: ReadonlyMap<string, StateOptions>;
  readonly computed: ReadonlyMap<string, ComputedDefinition>;
  readonly stateContext: StateContextDefinition;
  readonly actions: ReadonlyMap<string, ActionDefinition>;
}
const COMPONENT = Symbol('nv:component');
const STATES = Symbol('nv:states');
const COMPUTED = Symbol('nv:computed');
const COMPUTED_DECLARED = Symbol('nv:computed-declared');
const ACTIONS = Symbol('nv:actions');
const INPUT = Symbol('nv:input');
const ACTION_DECLARED = Symbol('nv:action-declared');
const ACTION_OPTIONS = Symbol('nv:action-options');
const PROPS = Symbol('nv:props');
const LISTENERS = Symbol('nv:listeners');
const REALTIME = Symbol('nv:realtime');
const reservedMembers = new Set([
  ...lifecycleHookNames,
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
  'then',
  'runtime',
  'mount',
  'hydrate',
  'dehydrate',
  'beforeAction',
  'afterAction',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

export function identifier(value: string): void {
  if (
    !/^[a-zA-Z][\w-]{0,63}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    throw new Error('Invalid live identifier');
}
function property(key: string | symbol): string {
  if (typeof key !== 'string')
    throw new Error('Live properties must have string names');
  identifier(key);
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || reservedMembers.has(key))
    throw new Error('Reserved or unsafe live member name');
  return key;
}
function memberDeclaration(
  prototype: object,
  key: string,
): { owner: object; descriptor: PropertyDescriptor } | undefined {
  let current: object | null = prototype;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return { owner: current, descriptor };
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}
function callable(value: unknown): value is (this: object) => unknown {
  return typeof value === 'function';
}
const nestInvocationMetadata = [
  GUARDS_METADATA,
  PIPES_METADATA,
  INTERCEPTORS_METADATA,
  EXCEPTION_FILTERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  REDIRECT_METADATA,
  RENDER_METADATA,
  SSE_METADATA,
  SSE_OPTIONS_METADATA,
  VERSION_METADATA,
] as const;
function hasInvocationMetadata(
  type: Type<object>,
  name: string,
  method: object,
): boolean {
  return (
    nestInvocationMetadata.some((key) => Reflect.hasMetadata(key, method)) ||
    Reflect.hasMetadata(ROUTE_ARGS_METADATA, type, name)
  );
}
/** Register explicitly through LiveModule.register; this decorator never scans other services. */
export function LiveComponent(options: ComponentOptions): ClassDecorator {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.name))
    throw new Error(
      'Component names must use lowercase letters, digits, and hyphens',
    );
  identifier(options.name);
  if (
    !options.view ||
    options.view.includes('..') ||
    options.view.startsWith('/') ||
    options.view.includes('\\')
  )
    throw new Error('Invalid component view');
  if (
    options.lazy !== undefined &&
    options.lazy !== true &&
    options.lazy !== false &&
    options.lazy !== 'visible'
  )
    throw new Error('Component lazy must be a boolean or "visible"');
  if (
    options.placeholder !== undefined &&
    (typeof options.placeholder !== 'string' ||
      !options.placeholder ||
      options.placeholder.includes('..') ||
      options.placeholder.startsWith('/') ||
      options.placeholder.includes('\\') ||
      !options.lazy)
  )
    throw new Error('Component placeholder must be a view and requires lazy');
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 300_000)
  )
    throw new Error('Component timeoutMs must be 1–300000 milliseconds');
  const children = new Map<string, Type<object>>();
  if (options.children !== undefined) {
    if (
      !options.children ||
      typeof options.children !== 'object' ||
      Array.isArray(options.children)
    )
      throw new Error('Component children must be an alias map');
    const entries = Object.entries(
      Object.getOwnPropertyDescriptors(options.children),
    );
    if (entries.length > 64) throw new Error('At most 64 child aliases');
    for (const [alias, descriptor] of entries) {
      identifier(alias);
      if (!('value' in descriptor) || typeof descriptor.value !== 'function')
        throw new Error(
          `Child alias ${alias} must reference a component class`,
        );
      children.set(alias, descriptor.value as Type<object>);
    }
  }
  return (target) => {
    Reflect.defineMetadata(
      COMPONENT,
      Object.freeze({
        name: options.name,
        view: options.view,
        children,
        lazy:
          options.lazy === 'visible'
            ? 'visible'
            : options.lazy === true
              ? 'load'
              : false,
        ...(options.placeholder === undefined
          ? {}
          : { placeholder: options.placeholder }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      }),
      target,
    );
  };
}
/** Public JSON state. Client writes require writable:true. Injected fields are never serialized. */
export function State(options: StateOptions = {}): PropertyDecorator {
  if (options.validate !== undefined && typeof options.validate !== 'function')
    throw new Error('State validate must be a function');
  if (options.validate !== undefined && options.writable !== true)
    throw new Error('State validation requires writable:true');
  if (options.synthesizer !== undefined && options.serializer !== undefined)
    throw new Error('State accepts synthesizer or serializer, not both');
  const synthesizer = options.synthesizer ?? options.serializer;
  if (synthesizer !== undefined && !isSynthesizer(synthesizer))
    throw new Error(
      'State synthesizer must provide name, dehydrate and hydrate',
    );
  let initial: JsonValue | (() => unknown) | undefined;
  if (Object.hasOwn(options, 'default')) {
    const value: unknown = options.default;
    if (typeof value === 'function') initial = value as () => unknown;
    else if (value === undefined)
      throw new Error('State default must be JSON data or a factory function');
    else {
      const cloned = cloneState({ value })['value'];
      if (cloned === undefined) throw new Error('Invalid state default');
      initial = cloned;
    }
  }
  return (target, key) => {
    const name = property(key);
    const prior: Map<string, StateOptions> | undefined = Reflect.getMetadata(
      STATES,
      target,
    );
    const states = new Map(prior);
    states.set(
      name,
      Object.freeze({
        writable: options.writable === true,
        ...(options.validate === undefined
          ? {}
          : { validate: options.validate }),
        ...(synthesizer === undefined ? {} : { synthesizer }),
        ...(initial === undefined ? {} : { default: initial }),
      }),
    );
    Reflect.defineMetadata(STATES, states, target);
  };
}
/** Public, read-only description of one declared `@State` field. */
export interface LiveStateDescription {
  readonly writable: boolean;
  /** True when the field holds a typed value converted by a synthesizer. */
  readonly synthesized: boolean;
}
/**
 * Describe a declared `@State` field of a `@LiveComponent` instance, or return
 * `undefined` for anything else (plain fields, injected services, unknown names,
 * non-components). Integrations such as `@nestvexa/forms` use it to refuse
 * reading or writing members that are not public component state.
 */
export function describeLiveState(
  component: object,
  field: string,
): LiveStateDescription | undefined {
  if (
    component === null ||
    typeof component !== 'object' ||
    typeof field !== 'string'
  )
    return undefined;
  const prototype: unknown = Object.getPrototypeOf(component);
  if (prototype === null || typeof prototype !== 'object') return undefined;
  const type: unknown = Reflect.get(prototype, 'constructor');
  if (typeof type !== 'function' || !Reflect.hasMetadata(COMPONENT, type))
    return undefined;
  const states: Map<string, StateOptions> | undefined = Reflect.getMetadata(
    STATES,
    prototype,
  );
  const entry = states?.get(field);
  if (!entry) return undefined;
  return Object.freeze({
    writable: entry.writable === true,
    synthesized: entry.synthesizer !== undefined,
  });
}
/** Equivalent to read-only public state; it is not an authorization policy. */
export function Locked(): PropertyDecorator {
  return State({ writable: false });
}
function prop(mode: PropMode): PropertyDecorator {
  return (target, key) => {
    const name = property(key);
    const prior: Map<string, PropMode> | undefined = Reflect.getMetadata(
      PROPS,
      target,
    );
    if (prior?.has(name) && prior.get(name) !== mode)
      throw new Error(`State ${name} has conflicting prop modes`);
    const props = new Map(prior);
    props.set(name, mode);
    Reflect.defineMetadata(PROPS, props, target);
  };
}
/** A parent may initialize this declared @State when it mounts the child. */
export function Prop(): PropertyDecorator {
  return prop('mount');
}
/**
 * Parent-owned value: re-sent on every parent render and refreshes the child when
 * it changes. Child actions must not change it (the response is rejected).
 */
export function Reactive(): PropertyDecorator {
  return prop('reactive');
}
/**
 * The single child field bound to a parent `model` field. Parent renders flow
 * down; child changes are proposed back to the writable parent field by the client.
 */
export function Modelable(): PropertyDecorator {
  return prop('modelable');
}
/**
 * Route an event to this registered @Action. Payloads cross the browser and are
 * untrusted: validate them with @ActionInput pipes and authorize the action.
 */
export function OnEvent(event: string): MethodDecorator {
  if (typeof event !== 'string' || !/^[a-z][a-z0-9:.-]{0,63}$/.test(event))
    throw new Error(
      'Event names use lowercase letters, digits, ".", ":" and "-"',
    );
  return (target, key) => {
    const method = property(key);
    const prior: Map<string, string[]> | undefined = Reflect.getMetadata(
      LISTENERS,
      target,
    );
    const listeners = new Map<string, string[]>();
    for (const [name, methods] of prior ?? [])
      listeners.set(name, [...methods]);
    const methods = listeners.get(event) ?? [];
    if (!methods.includes(method)) methods.push(method);
    listeners.set(event, methods);
    Reflect.defineMetadata(LISTENERS, listeners, target);
  };
}
/**
 * Mark a zero-argument method (sync or async) returning server-chosen channel
 * names. When the host configures `realtime`, events on those channels refresh
 * the component through its authorized `$sync` route.
 */
export function RealtimeChannels(): MethodDecorator {
  return (target, key, descriptor) => {
    const name = property(key);
    if (typeof descriptor.value !== 'function' || descriptor.value.length !== 0)
      throw new Error('@RealtimeChannels requires a zero-argument method');
    if (Reflect.getMetadata(REALTIME, target) !== undefined)
      throw new Error('Only one @RealtimeChannels method per component');
    Reflect.defineMetadata(REALTIME, name, target);
  };
}
/** A synchronous getter, or an explicit async:true zero-argument method, rendered as derived JSON. */
export function Computed(options: ComputedOptions = {}): MethodDecorator {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid computed options');
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid computed options');
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      typeof key !== 'string' ||
      !['async', 'cache', 'ttl', 'dependencies', 'timeoutMs'].includes(key) ||
      !descriptor ||
      !('value' in descriptor)
    )
      throw new Error('Computed options must use known own data properties');
  }
  const selected = { ...options };
  Object.setPrototypeOf(selected, null);
  if (
    (selected.async !== undefined && typeof selected.async !== 'boolean') ||
    (selected.cache !== undefined && typeof selected.cache !== 'boolean')
  )
    throw new Error('Computed async/cache options must be booleans');
  for (const [name, maximum] of [
    ['ttl', 60_000],
    ['timeoutMs', 300_000],
  ] as const) {
    const value = selected[name];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    )
      throw new Error(`Invalid computed ${name}`);
  }
  if (selected.timeoutMs !== undefined && selected.async !== true)
    throw new Error('Computed timeoutMs requires async:true');
  if (
    selected.cache === false &&
    (selected.ttl !== undefined || selected.dependencies !== undefined)
  )
    throw new Error('Computed ttl/dependencies require caching');
  let dependencies: string[] | undefined;
  if (selected.dependencies !== undefined) {
    const values = cloneState({ dependencies: selected.dependencies })[
      'dependencies'
    ];
    if (
      !Array.isArray(values) ||
      values.length > 64 ||
      new Set(values).size !== values.length
    )
      throw new Error('Invalid computed dependencies');
    dependencies = [];
    for (const name of values) {
      if (typeof name !== 'string')
        throw new Error('Invalid computed dependency');
      property(name);
      dependencies.push(name);
    }
  }
  const normalized = Object.freeze({
    async: selected.async ?? false,
    cache: selected.cache ?? true,
    timeoutMs: selected.timeoutMs ?? 30_000,
    ...(selected.ttl === undefined ? {} : { ttl: selected.ttl }),
    ...(dependencies === undefined
      ? {}
      : { dependencies: Object.freeze([...dependencies]) }),
  });
  return (target, key, descriptor) => {
    const name = property(key);
    const read: unknown = normalized.async ? descriptor.value : descriptor.get;
    if (
      !callable(read) ||
      read.length !== 0 ||
      descriptor.set !== undefined ||
      (normalized.async && descriptor.get !== undefined)
    )
      throw new Error(
        '@Computed requires a synchronous getter or async:true zero-argument method',
      );
    const prior: Map<string, ComputedDefinition> | undefined =
      Reflect.getMetadata(COMPUTED, target);
    const names = new Map(prior);
    names.set(name, Object.freeze({ ...normalized, read }));
    Reflect.defineMetadata(COMPUTED, names, target);
    Reflect.defineMetadata(COMPUTED_DECLARED, true, target, key);
  };
}
export function Action(options: ActionOptions = {}): MethodDecorator {
  return (target, key, descriptor) => {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new Error('Invalid action options');
    const prototype: unknown = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Invalid action options');
    const selected: ActionOptions = Object.create(null) as ActionOptions;
    for (const key of Reflect.ownKeys(options)) {
      const option = Object.getOwnPropertyDescriptor(options, key);
      if (
        typeof key !== 'string' ||
        !['id', 'renderless', 'idempotent', 'concurrency'].includes(key) ||
        !option ||
        !('value' in option)
      )
        throw new Error('Action options must use known own data properties');
      Object.defineProperty(selected, key, { value: option.value });
    }
    Object.freeze(selected);
    if (selected.id !== undefined && typeof selected.id !== 'string')
      throw new Error('Action id must be a string');
    if (
      selected.renderless !== undefined &&
      typeof selected.renderless !== 'boolean'
    )
      throw new Error('Action renderless must be a boolean');
    if (
      selected.idempotent !== undefined &&
      typeof selected.idempotent !== 'boolean'
    )
      throw new Error('Action idempotent must be a boolean');
    if (
      selected.concurrency !== undefined &&
      selected.concurrency !== 'component' &&
      selected.concurrency !== 'identity'
    )
      throw new Error('Action concurrency must be "component" or "identity"');
    const name = property(key);
    if (typeof descriptor.value !== 'function')
      throw new Error('@Action requires a method');
    const id = selected.id ?? name;
    identifier(id);
    const prior: Map<string, string> | undefined = Reflect.getMetadata(
      ACTIONS,
      target,
    );
    const actions = new Map(prior);
    if (actions.has(id) && actions.get(id) !== name)
      throw new Error(`Duplicate live action ${id}`);
    if (
      [...actions].some(
        ([priorId, priorName]) => priorName === name && priorId !== id,
      )
    )
      throw new Error(`Multiple action IDs for live method ${name}`);
    actions.set(id, name);
    Reflect.defineMetadata(ACTIONS, actions, target);
    Reflect.defineMetadata(ACTION_DECLARED, true, target, key);
    Reflect.defineMetadata(
      ACTION_OPTIONS,
      Object.freeze({
        ...(selected.renderless === true ? { renderless: true as const } : {}),
        ...(selected.idempotent === true ? { idempotent: true as const } : {}),
        ...(selected.concurrency === 'identity'
          ? { concurrency: 'identity' as const }
          : {}),
      }),
      target,
      key,
    );
  };
}
/** A single DTO input at argument zero, transformed by ordinary Nest pipes. */
export function ActionInput(
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ParameterDecorator {
  return (target, key, index) => {
    if (key === undefined || index !== 0)
      throw new Error('@ActionInput must be action argument zero');
    Reflect.defineMetadata(INPUT, true, target, key);
    Body('input', ...pipes)(target, key, index);
  };
}
export function definition(type: Type<object>): ComponentDefinition {
  const options:
    | {
        readonly name: string;
        readonly view: string;
        readonly children?: ReadonlyMap<string, Type<object>>;
        readonly lazy?: false | 'load' | 'visible';
        readonly placeholder?: string;
        readonly timeoutMs?: number;
      }
    | undefined = Reflect.getMetadata(COMPONENT, type);
  if (!options) throw new Error(`Missing @LiveComponent on ${type.name}`);
  for (const name of lifecycleHookNames) {
    const declaration = memberDeclaration(type.prototype, name);
    if (!declaration) continue;
    const method: unknown = declaration.descriptor.value;
    if (typeof method !== 'function')
      throw new Error(`Lifecycle hook ${name} must be a method`);
    const argumentsAllowed = [
      'beforeUpdate',
      'afterUpdate',
      'afterRender',
      'onError',
    ].includes(name)
      ? 1
      : 0;
    if (method.length > argumentsAllowed)
      throw new Error(`Lifecycle hook ${name} has unsupported arguments`);
    if (hasInvocationMetadata(type, name, method))
      throw new Error(
        `Lifecycle hook ${name} cannot use Nest route/parameter/enhancer decorators; authorize the host route or action instead`,
      );
  }
  const states: Map<string, StateOptions> = new Map(
    Reflect.getMetadata(STATES, type.prototype),
  );
  const computed: Map<string, ComputedDefinition> = new Map(
    Reflect.getMetadata(COMPUTED, type.prototype),
  );
  const methods: Map<string, string> = new Map(
    Reflect.getMetadata(ACTIONS, type.prototype),
  );
  const actions = new Map<string, ActionDefinition>();
  for (const [id, method] of methods) {
    const declaration = memberDeclaration(type.prototype, method);
    if (
      !declaration ||
      Reflect.getOwnMetadata(ACTION_DECLARED, declaration.owner, method) !==
        true
    )
      throw new Error(
        `${type.name}.${method} overrides an action without @Action`,
      );
    const input =
      Reflect.getOwnMetadata(INPUT, declaration.owner, method) === true;
    const fn: unknown = declaration.descriptor.value;
    if (typeof fn !== 'function' || fn.length > (input ? 1 : 0))
      throw new Error(
        `${type.name}.${method} must have zero arguments or one @ActionInput`,
      );
    const selected: Omit<ActionDefinition, 'method' | 'input'> =
      Reflect.getOwnMetadata(ACTION_OPTIONS, declaration.owner, method) ?? {};
    actions.set(id, Object.freeze({ method, input, ...selected }));
  }
  for (const name of states.keys())
    if (computed.has(name) || [...methods.values()].includes(name))
      throw new Error(`Duplicate live member ${name}`);
  if (computed.size > 64)
    throw new Error('At most 64 computed members per component');
  for (const [name, entry] of computed) {
    const declaration = memberDeclaration(type.prototype, name);
    if (
      !declaration ||
      Reflect.getOwnMetadata(COMPUTED_DECLARED, declaration.owner, name) !==
        true ||
      (entry.async
        ? declaration.descriptor.value
        : declaration.descriptor.get) !== entry.read
    )
      throw new Error(`Computed ${name} overrides a member without @Computed`);
    if ([...methods.values()].includes(name) || methods.has(name))
      throw new Error(`Duplicate live member ${name}`);
    if (hasInvocationMetadata(type, name, entry.read))
      throw new Error(
        `Computed ${name} cannot use Nest route/parameter/enhancer decorators; authorize the host route or service instead`,
      );
    for (const field of entry.dependencies ?? [])
      if (!states.has(field))
        throw new Error(
          `Computed ${name} dependency ${field} must be declared state`,
        );
  }
  const stateContext = collectStateContext(type, states);
  const props: Map<string, PropMode> = new Map(
    Reflect.getMetadata(PROPS, type.prototype),
  );
  for (const [field, entry] of states)
    if (
      entry.synthesizer &&
      (stateContext.url.has(field) ||
        stateContext.session.has(field) ||
        props.has(field))
    )
      throw new Error(
        `Synthesized state ${field} cannot also be @Url, @Session or a prop`,
      );
  for (const [field, mode] of props) {
    if (!states.has(field))
      throw new Error(`Prop ${field} must also be declared @State`);
    if (mode === 'reactive' && states.get(field)?.writable)
      throw new Error(`Reactive prop ${field} cannot be client-writable`);
    if (stateContext.url.has(field) || stateContext.session.has(field))
      throw new Error(`Prop ${field} cannot also use @Url or @Session`);
  }
  if ([...props.values()].filter((mode) => mode === 'modelable').length > 1)
    throw new Error(`${type.name} declares more than one @Modelable field`);
  const listenerMethods: Map<string, string[]> = new Map(
    Reflect.getMetadata(LISTENERS, type.prototype),
  );
  const listeners = new Map<string, readonly string[]>();
  for (const [event, names] of listenerMethods) {
    const ids: string[] = [];
    for (const method of names) {
      const id = [...methods].find(([, name]) => name === method)?.[0];
      if (id === undefined)
        throw new Error(`${type.name}.${method} uses @OnEvent without @Action`);
      ids.push(id);
    }
    listeners.set(event, Object.freeze(ids));
  }
  const realtime: unknown = Reflect.getMetadata(REALTIME, type.prototype);
  if (typeof realtime === 'string') {
    if (
      states.has(realtime) ||
      computed.has(realtime) ||
      [...methods.values()].includes(realtime)
    )
      throw new Error(`Duplicate live member ${realtime}`);
    if (
      hasInvocationMetadata(
        type,
        realtime,
        Reflect.get(type.prototype, realtime) as object,
      )
    )
      throw new Error(
        '@RealtimeChannels cannot use Nest route/enhancer decorators',
      );
  }
  return Object.freeze({
    type,
    name: options.name,
    ...(typeof realtime === 'string' ? { realtime } : {}),
    view: options.view,
    children: options.children ?? new Map<string, Type<object>>(),
    lazy: options.lazy ?? false,
    ...(options.placeholder === undefined
      ? {}
      : { placeholder: options.placeholder }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    props,
    listeners,
    states,
    computed,
    actions,
    stateContext,
  });
}

/**
 * Runtime-only: apply `@State({ default })` to fields the class left
 * uninitialized. Called once per freshly created instance, before hooks.
 */
export function applyStateDefaults(
  instance: object,
  component: ComponentDefinition,
): void {
  for (const [name, options] of component.states) {
    if (options.default === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(instance, name);
    if (
      descriptor &&
      (!('value' in descriptor) || descriptor.value !== undefined)
    )
      continue;
    const initial = options.default;
    Object.defineProperty(instance, name, {
      value:
        typeof initial === 'function'
          ? initial()
          : cloneState({ value: initial })['value'],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
