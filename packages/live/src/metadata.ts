import { Body } from '@nestjs/common';
import type { Type, PipeTransform } from '@nestjs/common';
import type { JsonValue } from './protocol.js';
import { lifecycleHookNames } from './lifecycle.js';

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
export interface ComponentDefinition {
  readonly type: Type<object>;
  readonly name: string;
  readonly view: string;
  readonly states: ReadonlyMap<string, StateOptions>;
  readonly computed: ReadonlySet<string>;
  readonly actions: ReadonlyMap<
    string,
    { readonly method: string; readonly input: boolean }
  >;
}
const COMPONENT = Symbol('nv:component');
const STATES = Symbol('nv:states');
const COMPUTED = Symbol('nv:computed');
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
export function Computed(): MethodDecorator {
  return (target, key, descriptor) => {
    if (!descriptor.get)
      throw new Error('@Computed requires a synchronous getter');
    const prior: Set<string> | undefined = Reflect.getMetadata(
      COMPUTED,
      target,
    );
    const names = new Set(prior);
    names.add(property(key));
    Reflect.defineMetadata(COMPUTED, names, target);
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
    if (declaration && typeof declaration.descriptor.value !== 'function')
      throw new Error(`Lifecycle hook ${name} must be a method`);
  }
  const states: Map<string, StateOptions> = new Map(
    Reflect.getMetadata(STATES, type.prototype),
  );
  const computed: Set<string> = new Set(
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
  for (const name of computed)
    if (
      typeof memberDeclaration(type.prototype, name)?.descriptor.get !==
      'function'
    )
      throw new Error(`Computed ${name} must remain a getter`);
  return Object.freeze({ type, ...options, states, computed, actions });
}
