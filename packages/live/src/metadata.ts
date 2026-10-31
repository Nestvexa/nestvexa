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
import { collectStateContext } from './state-context.js';
import type { StateContextDefinition } from './state-context.js';

export const INTERNAL_SYNC_ACTION = '$sync';
export const INTERNAL_SYNC_PATH = '_sync';

export interface ComponentOptions {
  readonly name: string;
  readonly view: string;
}
export interface StateOptions {
  readonly writable?: boolean;
  /** Pure validation before any component hook/action runs. False rejects without consuming state. */
  readonly validate?: (value: JsonValue) => boolean | Promise<boolean>;
}
export interface ActionOptions {
  readonly id?: string;
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
  readonly states: ReadonlyMap<string, StateOptions>;
  readonly computed: ReadonlyMap<string, ComputedDefinition>;
  readonly stateContext: StateContextDefinition;
  readonly actions: ReadonlyMap<
    string,
    { readonly method: string; readonly input: boolean }
  >;
}
const COMPONENT = Symbol('nv:component');
const STATES = Symbol('nv:states');
const COMPUTED = Symbol('nv:computed');
const COMPUTED_DECLARED = Symbol('nv:computed-declared');
const ACTIONS = Symbol('nv:actions');
const INPUT = Symbol('nv:input');
const ACTION_DECLARED = Symbol('nv:action-declared');
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
  return (target) => {
    Reflect.defineMetadata(COMPONENT, Object.freeze({ ...options }), target);
  };
}
/** Public JSON state. Client writes require writable:true. Injected fields are never serialized. */
export function State(options: StateOptions = {}): PropertyDecorator {
  if (options.validate !== undefined && typeof options.validate !== 'function')
    throw new Error('State validate must be a function');
  if (options.validate !== undefined && options.writable !== true)
    throw new Error('State validation requires writable:true');
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
      }),
    );
    Reflect.defineMetadata(STATES, states, target);
  };
}
/** Equivalent to read-only public state; it is not an authorization policy. */
export function Locked(): PropertyDecorator {
  return State({ writable: false });
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
    const name = property(key);
    if (typeof descriptor.value !== 'function')
      throw new Error('@Action requires a method');
    const id = options.id ?? name;
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
  const options: ComponentOptions | undefined = Reflect.getMetadata(
    COMPONENT,
    type,
  );
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
  const actions = new Map<string, { method: string; input: boolean }>();
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
    actions.set(id, { method, input });
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
  return Object.freeze({
    type,
    ...options,
    states,
    computed,
    actions,
    stateContext,
  });
}
