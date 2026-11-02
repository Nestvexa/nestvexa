import { Body, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext, PipeTransform, Type } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  REDIRECT_METADATA,
  RENDER_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants';
import { isActionSchema } from './schema.js';
import type { ActionSchema } from './schema.js';
import {
  ACTION_ID_PATTERN,
  MAX_ACTION_ID_LENGTH,
  actionKey,
  actionPath,
} from './shared/protocol.js';
import { actionContextFor } from './state.js';
import type { ActionContext as ActionContextShape } from './state.js';

export type ActionConcurrency = 'serial' | 'parallel';

export interface ServerActionOptions {
  /** Stable public id, lowercase kebab-case (`add-item`). */
  readonly id: string;
  /** Explicit positive version (1-1000). Versioned routes end in `/v<version>`. */
  readonly version?: number;
  /** Opt into `Idempotency-Key` replay protection; the header becomes mandatory. */
  readonly idempotent?: boolean;
  /** Deadline in milliseconds (1-600000); defaults to the module limit. */
  readonly timeoutMs?: number;
  /** `serial` runs one call at a time per identity and group; default `parallel`. */
  readonly concurrency?: ActionConcurrency;
  /** Optional runtime schema applied to the input after Nest pipes. */
  readonly input?: ActionSchema;
  /** Optional runtime schema applied to the returned data. */
  readonly output?: ActionSchema;
}

export interface ActionDefinition {
  readonly id: string;
  readonly version: number | null;
  /** Client property name (`addItem`, `addItemV2`). */
  readonly key: string;
  /** Route path relative to the actions prefix: `cart/add-item[/v2]`. */
  readonly path: string;
  readonly method: string;
  readonly idempotent: boolean;
  readonly timeoutMs: number | undefined;
  readonly concurrency: ActionConcurrency;
  readonly input: ActionSchema | undefined;
  readonly output: ActionSchema | undefined;
  /** Parameter index of `@ActionInput()`, when declared. */
  readonly inputIndex: number | undefined;
}

export interface ActionGroupDefinition {
  readonly id: string;
  readonly type: Type<object>;
  readonly actions: readonly ActionDefinition[];
}

/** Public, non-sensitive description passed to host policies. */
export interface ActionDescriptor {
  readonly group: string;
  readonly action: string;
  readonly version: number | null;
  readonly idempotent: boolean;
}

const GROUP = 'nestvexa:actions:group';
const ACTIONS = 'nestvexa:actions:actions';
const INPUT = 'nestvexa:actions:input';

interface DeclaredAction {
  readonly method: string;
  readonly options: Readonly<ServerActionOptions>;
  readonly implementation: unknown;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'version',
  'idempotent',
  'timeoutMs',
  'concurrency',
  'input',
  'output',
]);

const RESERVED_METHODS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
  'then',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/** Nest metadata that would reshape the generated route; the module owns routing. */
const ROUTE_SHAPING_METADATA = [
  PATH_METADATA,
  METHOD_METADATA,
  SSE_METADATA,
  RENDER_METADATA,
  REDIRECT_METADATA,
  HTTP_CODE_METADATA,
];

export function assertActionId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ACTION_ID_LENGTH ||
    !ACTION_ID_PATTERN.test(value)
  )
    throw new Error(
      `${label} must be lowercase kebab-case (for example "add-item"), at most ${MAX_ACTION_ID_LENGTH} characters; received ${JSON.stringify(value)}`,
    );
  return value;
}

/** Copies own data options without evaluating accessors or inherited values. */
function ownOptions(options: unknown): Readonly<ServerActionOptions> {
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new Error('@ServerAction requires an options object with an id');
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('@ServerAction options must be a plain object');
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_KEYS.has(key))
      throw new Error(`Unknown @ServerAction option ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error('@ServerAction options must be own data properties');
    if (descriptor.value !== undefined) copy[key] = descriptor.value;
  }
  const id = assertActionId(copy['id'], 'Server action id');
  const version = copy['version'];
  if (
    version !== undefined &&
    (typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 1000)
  )
    throw new Error(`Server action ${id} version must be an integer 1-1000`);
  const idempotent = copy['idempotent'];
  if (idempotent !== undefined && typeof idempotent !== 'boolean')
    throw new Error(`Server action ${id} idempotent must be a boolean`);
  const timeoutMs = copy['timeoutMs'];
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000)
  )
    throw new Error(
      `Server action ${id} timeoutMs must be an integer 1-600000`,
    );
  const concurrency = copy['concurrency'];
  if (
    concurrency !== undefined &&
    concurrency !== 'serial' &&
    concurrency !== 'parallel'
  )
    throw new Error(
      `Server action ${id} concurrency must be "serial" or "parallel"`,
    );
  for (const name of ['input', 'output'] as const)
    if (copy[name] !== undefined && !isActionSchema(copy[name]))
      throw new Error(
        `Server action ${id} ${name} schema must expose safeParseAsync, safeParse or parse`,
      );
  return Object.freeze(copy) as Readonly<ServerActionOptions>;
}

/**
 * Marks a class as an explicitly registrable action group. Only methods
 * decorated with `@ServerAction` become routes, and only after the class is
 * listed in `ActionsModule.register({ groups })`.
 */
export function ActionGroup(id: string): ClassDecorator {
  const groupId = assertActionId(id, 'Action group id');
  return (target) => {
    if (Reflect.hasOwnMetadata(GROUP, target))
      throw new Error(`${target.name} declares @ActionGroup more than once`);
    Reflect.defineMetadata(GROUP, groupId, target);
  };
}

/** Exposes one method of an `@ActionGroup` as an authorized POST action route. */
export function ServerAction(options: ServerActionOptions): MethodDecorator {
  const copy = ownOptions(options);
  return (target, key, descriptor) => {
    if (typeof key !== 'string')
      throw new Error('Server action methods must have string names');
    if (RESERVED_METHODS.has(key) || key.startsWith('#'))
      throw new Error(`Method name ${key} cannot be a server action`);
    if (typeof descriptor.value !== 'function')
      throw new Error(`@ServerAction ${copy.id} must decorate a method`);
    const declared: DeclaredAction[] =
      Reflect.getOwnMetadata(ACTIONS, target) ?? [];
    if (declared.some((entry) => entry.method === key))
      throw new Error(`Method ${key} declares @ServerAction more than once`);
    Reflect.defineMetadata(
      ACTIONS,
      [
        ...declared,
        { method: key, options: copy, implementation: descriptor.value },
      ],
      target,
    );
  };
}

/**
 * Binds the request body's `input` member to this parameter using Nest's own
 * `@Body('input', ...pipes)`, so global, method and parameter pipes (for
 * example `ValidationPipe` with DTO classes) run exactly as on a controller.
 */
export function ActionInput(
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ParameterDecorator {
  return (target, key, index) => {
    if (typeof key !== 'string')
      throw new Error('@ActionInput must decorate a named method parameter');
    if (Reflect.hasOwnMetadata(INPUT, target, key))
      throw new Error(`Method ${key} declares @ActionInput more than once`);
    Reflect.defineMetadata(INPUT, index, target, key);
    Body('input', ...pipes)(target, key, index);
  };
}

/** Read-only per-request context: request id, identity, descriptor, signal, idempotency key. */
export type ActionContext = ActionContextShape;
/** Injects the per-request `ActionContext` (request id, identity, signal, descriptor). */
export const ActionContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    actionContextFor(context.switchToHttp().getRequest<object>()),
);

/** Injects the per-request `AbortSignal` (timeout, client disconnect, shutdown). */
export const ActionSignal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    actionContextFor(context.switchToHttp().getRequest<object>()).signal,
);

function memberDeclaration(
  prototype: object,
  key: string,
): PropertyDescriptor | undefined {
  let current: object | null = prototype;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

export function isActionGroup(type: unknown): type is Type<object> {
  return typeof type === 'function' && Reflect.hasOwnMetadata(GROUP, type);
}

/** Validated, frozen definition for an explicitly registered group class. */
export function actionGroupDefinition(
  type: Type<object>,
): ActionGroupDefinition {
  if (typeof type !== 'function')
    throw new Error('Action groups must be classes');
  const id: unknown = Reflect.getOwnMetadata(GROUP, type);
  if (typeof id !== 'string')
    throw new Error(
      `${type.name || 'Anonymous class'} is not an @ActionGroup. Decorate it with @ActionGroup('<id>') before registering it; @Injectable alone never exposes methods.`,
    );
  if (Reflect.getMetadata('__controller__', type) === true)
    throw new Error(
      `Action group ${id} (${type.name}) is also a Nest @Controller; a class must not expose routes twice`,
    );
  const prototype = type.prototype as object;
  const actions: ActionDefinition[] = [];
  const methods = new Set<string>();
  for (
    let level: object | null = prototype;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    const declared: DeclaredAction[] =
      Reflect.getOwnMetadata(ACTIONS, level) ?? [];
    for (const entry of declared) {
      if (methods.has(entry.method)) continue;
      methods.add(entry.method);
      const current = memberDeclaration(prototype, entry.method);
      if (!current || current.value !== entry.implementation)
        throw new Error(
          `${type.name}.${entry.method} overrides server action ${entry.options.id} without @ServerAction; redeclare it explicitly`,
        );
      for (const key of ROUTE_SHAPING_METADATA)
        if (
          Reflect.getMetadata(key, entry.implementation as object) !== undefined
        )
          throw new Error(
            `${type.name}.${entry.method} declares Nest route metadata (${key}); ActionsModule owns action routes, methods and status codes`,
          );
      const inputIndex: unknown = Reflect.getMetadata(
        INPUT,
        prototype,
        entry.method,
      );
      if (entry.options.input !== undefined && typeof inputIndex !== 'number')
        throw new Error(
          `${type.name}.${entry.method} declares an input schema but no @ActionInput parameter`,
        );
      const version = entry.options.version ?? null;
      actions.push(
        Object.freeze({
          id: entry.options.id,
          version,
          key: actionKey(entry.options.id, version),
          path: actionPath(id, entry.options.id, version).slice(id.length + 1),
          method: entry.method,
          idempotent: entry.options.idempotent ?? false,
          timeoutMs: entry.options.timeoutMs,
          concurrency: entry.options.concurrency ?? 'parallel',
          input: entry.options.input,
          output: entry.options.output,
          inputIndex: typeof inputIndex === 'number' ? inputIndex : undefined,
        }),
      );
    }
  }
  if (actions.length === 0)
    throw new Error(
      `Action group ${id} (${type.name}) has no @ServerAction methods`,
    );
  if (actions.length > 256)
    throw new Error(`Action group ${id} declares more than 256 actions`);
  const seenRoutes = new Map<string, string>();
  const seenKeys = new Map<string, string>();
  for (const action of actions) {
    const label = `${type.name}.${action.method}`;
    const route = seenRoutes.get(action.path);
    if (route)
      throw new Error(
        `Duplicate server action ${id}/${action.id}${action.version === null ? '' : ` version ${action.version}`}: declared by ${route} and ${label}. Give each action a unique id or explicit version.`,
      );
    seenRoutes.set(action.path, label);
    const key = seenKeys.get(action.key);
    if (key)
      throw new Error(
        `Server actions ${key} and ${label} in group ${id} map to the same client name "${action.key}"; rename one action id`,
      );
    seenKeys.set(action.key, label);
  }
  actions.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return Object.freeze({ id, type, actions: Object.freeze(actions) });
}
