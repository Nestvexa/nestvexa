import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LiveApplicationRegistry } from './registration.js';
import { SafeHtml } from '@nestvexa/views';
import type { ViewEngineAdapter } from '@nestvexa/views';
import { timingSafeEqual } from 'node:crypto';
import {
  cloneState,
  freezeJson,
  LiveProtocolError,
  parseLiveRequest,
} from './protocol.js';
import type { JsonValue, LiveRequest } from './protocol.js';
import { MemoryLiveStore } from './store.js';
import type { ComponentDefinition } from './metadata.js';
import { INTERNAL_SYNC_ACTION } from './metadata.js';
import type { LiveLifecycleHooks, LiveUpdateContext } from './lifecycle.js';

export const LIVE_OPTIONS = Symbol('nv:live-options');
export interface LiveIdentity {
  readonly binding: string;
  readonly csrfToken: string;
}
export interface LiveHostOptions {
  readonly origin: string;
  readonly endpoint?: string;
  /** Public host prefix (for example /app/v1); does not change registered Nest route paths. */
  readonly basePath?: string;
  readonly resolveIdentity: (
    request: object,
  ) => LiveIdentity | Promise<LiveIdentity>;
  readonly authorize: (
    identity: LiveIdentity,
    component: string,
    action: string,
  ) => boolean | Promise<boolean>;
  readonly renderer: ViewEngineAdapter;
  readonly store?: MemoryLiveStore;
  readonly maxRequestsPerMinute?: number;
}
export interface RuntimeOptions extends LiveHostOptions {
  readonly definitions: readonly ComponentDefinition[];
}
interface Admission {
  readonly identity: LiveIdentity;
  readonly payload: LiveRequest;
  readonly component: ComponentDefinition;
  readonly action: string;
}
function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function fail(status: number, code: string): never {
  throw new HttpException({ statusCode: status, code }, status);
}
function mapped(error: unknown): never {
  if (error instanceof LiveProtocolError)
    throw new HttpException(
      { statusCode: error.status, code: error.code },
      error.status,
    );
  throw error;
}
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

@Injectable()
export class LiveRuntime implements OnApplicationShutdown {
  private closed = false;
  readonly store: MemoryLiveStore;
  readonly #admissions = new WeakMap<object, Admission>();
  readonly #rate = new Map<string, { start: number; count: number }>();
  constructor(
    @Inject(LIVE_OPTIONS) private readonly options: RuntimeOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(LiveApplicationRegistry)
    private readonly registry: LiveApplicationRegistry,
  ) {
    this.store = options.store ?? new MemoryLiveStore();
    this.registry.register(
      this,
      options.definitions,
      options.endpoint ?? '/_nestvexa/live',
    );
  }
  private async identity(request: object): Promise<LiveIdentity> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const identity = await this.options.resolveIdentity(request);
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    if (
      !identity ||
      typeof identity.binding !== 'string' ||
      identity.binding.length < 16 ||
      identity.binding.length > 1024 ||
      typeof identity.csrfToken !== 'string' ||
      identity.csrfToken.length < 32 ||
      identity.csrfToken.length > 256
    )
      fail(401, 'IDENTITY_REQUIRED');
    return Object.freeze({
      binding: identity.binding,
      csrfToken: identity.csrfToken,
    });
  }
  private limit(identity: LiveIdentity): void {
    const now = Date.now();
    for (const [key, value] of this.#rate)
      if (now - value.start >= 60_000) this.#rate.delete(key);
    let bucket = this.#rate.get(identity.binding);
    if (!bucket) {
      if (this.#rate.size >= 1000) fail(429, 'RATE_LIMIT');
      bucket = { start: now, count: 0 };
      this.#rate.set(identity.binding, bucket);
    }
    if (++bucket.count > (this.options.maxRequestsPerMinute ?? 60))
      fail(429, 'RATE_LIMIT');
  }
  /** Runs as a real Nest class guard, before application component/method guards. */
  async admit(
    request: object,
    component: ComponentDefinition,
    action: string,
  ): Promise<void> {
    if (header(request, 'origin') !== this.options.origin)
      fail(403, 'ORIGIN_REJECTED');
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      fail(415, 'CONTENT_TYPE');
    const identity = await this.identity(request);
    if (!equal(header(request, 'x-nestvexa-csrf') ?? '', identity.csrfToken))
      fail(403, 'CSRF_REJECTED');
    this.limit(identity);
    let payload: LiveRequest;
    try {
      payload = parseLiveRequest(Reflect.get(request, 'body'));
      const snapshot = this.store.peek(payload.snapshot, identity.binding);
      if (snapshot.name !== component.name) fail(403, 'COMPONENT_MISMATCH');
    } catch (error) {
      mapped(error);
    }
    if (action !== INTERNAL_SYNC_ACTION && !component.actions.has(action))
      fail(404, 'UNKNOWN_ACTION');
    if (!(await this.options.authorize(identity, component.name, action)))
      fail(403, 'ACTION_FORBIDDEN');
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    this.#admissions.set(request, { identity, payload, component, action });
  }
  private async instance(
    component: ComponentDefinition,
    request: object,
  ): Promise<object> {
    const context = this.registry.context(request);
    this.moduleRef.registerRequestByContextId(request, context);
    return this.moduleRef.resolve(component.type, context, { strict: true });
  }
  private state(
    instance: object,
    component: ComponentDefinition,
  ): Record<string, JsonValue> {
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of component.states.keys()) {
      const descriptor = Object.getOwnPropertyDescriptor(instance, name);
      if (!descriptor || !('value' in descriptor))
        throw new Error(`State ${name} must be an initialized data field`);
      result[name] = descriptor.value;
    }
    return cloneState(result);
  }
  private async render(
    instance: object,
    component: ComponentDefinition,
  ): Promise<string> {
    const model: Record<string, unknown> = this.state(instance, component);
    for (const name of component.computed)
      model[name] = Reflect.get(instance, name);
    const html = await this.options.renderer.render(
      component.view,
      cloneState(model),
      {
        layout: false,
      },
    );
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    if (Buffer.byteLength(html) > 1_048_576) fail(413, 'PAYLOAD_TOO_LARGE');
    return html;
  }
  private async hook(
    instance: object,
    name: keyof LiveLifecycleHooks,
    args: readonly unknown[] = [],
  ): Promise<void> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const method: unknown = Reflect.get(instance, name);
    if (method !== undefined && typeof method !== 'function')
      throw new Error(`Lifecycle hook ${name} must be a method`);
    if (typeof method === 'function')
      await Reflect.apply(method, instance, args);
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
  }
  /** Mount only from a host route with host-resolved identity; never from a client class name. */
  async mount(type: Type<object>, request: object): Promise<SafeHtml> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const component = this.options.definitions.find(
      (entry) => entry.type === type,
    );
    if (!component) {
      const owner = this.registry.owner(type);
      if (owner && owner !== this) return owner.mount(type, request);
      throw new Error('Component is not registered in this Nest application');
    }
    const identity = await this.identity(request);
    this.limit(identity);
    if (!(await this.options.authorize(identity, component.name, '$mount')))
      fail(403, 'COMPONENT_FORBIDDEN');
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const instance = await this.instance(component, request);
    await this.hook(instance, 'boot');
    await this.hook(instance, 'mount');
    await this.hook(instance, 'dehydrate');
    const html = await this.render(instance, component);
    const snapshot = this.store.create(
      component.name,
      identity.binding,
      this.state(instance, component),
    );
    const endpoint = `${this.options.basePath ?? ''}${this.options.endpoint ?? '/_nestvexa/live'}/${component.name}`;
    return SafeHtml.trusted(
      `<div data-nv-component="${escapeAttribute(snapshot.id)}" data-nv-name="${component.name}" data-nv-snapshot="${escapeAttribute(snapshot.snapshot)}" data-nv-state="${escapeAttribute(JSON.stringify(snapshot.state))}" data-nv-revision="0" data-nv-endpoint="${escapeAttribute(endpoint)}" data-nv-csrf="${escapeAttribute(identity.csrfToken)}">${html}</div>`,
    );
  }
  async execute(request: object, input: unknown): Promise<unknown> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const admitted = this.#admissions.get(request);
    if (!admitted) fail(403, 'ADMISSION_REQUIRED');
    const { identity, payload, component, action } = admitted;
    try {
      const synchronization = action === INTERNAL_SYNC_ACTION;
      const selected = component.actions.get(action);
      if (!synchronization && !selected) fail(404, 'UNKNOWN_ACTION');
      if (
        (synchronization || !selected?.input) &&
        payload.input !== undefined &&
        payload.input !== null
      )
        fail(400, 'UNEXPECTED_INPUT');
      const updates = await this.validatedUpdates(component, identity, payload);
      const result = await this.store.transaction(
        payload.snapshot,
        identity.binding,
        payload.revision,
        async (snapshot) => {
          const instance = await this.instance(component, request);
          if (this.closed) fail(503, 'LIVE_SHUTDOWN');
          for (const [key, value] of Object.entries(
            cloneState(snapshot.state),
          )) {
            if (!component.states.has(key)) fail(409, 'STATE_SCHEMA_CHANGED');
            Object.defineProperty(instance, key, {
              value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
          await this.hook(instance, 'boot');
          await this.hook(instance, 'hydrate');
          for (const [key, value] of Object.entries(updates)) {
            const previous = snapshot.state[key];
            if (previous === undefined) fail(409, 'STATE_SCHEMA_CHANGED');
            const update: LiveUpdateContext = Object.freeze({
              field: key,
              previous: freezeJson(structuredClone(previous)),
              value: freezeJson(structuredClone(value)),
            });
            await this.hook(instance, 'beforeUpdate', [update]);
            Object.defineProperty(instance, key, {
              value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
            await this.hook(instance, 'afterUpdate', [update]);
          }
          if (!synchronization && selected) {
            await this.hook(instance, 'beforeAction');
            const method: unknown = Reflect.get(instance, selected.method);
            if (typeof method !== 'function')
              throw new Error('Registered action is not callable');
            await Reflect.apply(
              method,
              instance,
              selected.input ? [input] : [],
            );
            await this.hook(instance, 'afterAction');
          }
          await this.hook(instance, 'dehydrate');
          const html = await this.render(instance, component);
          return { state: this.state(instance, component), html };
        },
      );
      return {
        protocol: 'nestvexa-live/1',
        requestId: payload.requestId,
        component: {
          id: result.id,
          name: result.name,
          revision: result.revision,
        },
        snapshot: result.snapshot,
        state: result.state,
        html: result.html,
      };
    } catch (error) {
      mapped(error);
    } finally {
      this.#admissions.delete(request);
    }
  }
  private async validatedUpdates(
    component: ComponentDefinition,
    identity: LiveIdentity,
    payload: LiveRequest,
  ): Promise<Record<string, JsonValue>> {
    const snapshot = this.store.peek(payload.snapshot, identity.binding);
    if (snapshot.revision !== payload.revision) fail(409, 'STALE_REVISION');
    // A validation callback may retain its input; expose detached immutable data only.
    const updates = freezeJson(cloneState(payload.updates));
    for (const [key, value] of Object.entries(updates)) {
      const state = component.states.get(key);
      if (!state?.writable) fail(422, 'STATE_LOCKED');
      const previous = snapshot.state[key];
      if (
        typeof value !== typeof previous ||
        Array.isArray(value) !== Array.isArray(previous) ||
        (value === null) !== (previous === null)
      )
        fail(422, 'STATE_TYPE');
      if (state.validate && (await state.validate(value)) !== true)
        fail(422, 'STATE_INVALID');
      if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    }
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    // Components receive mutable data, independently of the validator's captured references.
    return cloneState(updates);
  }
  onApplicationShutdown(): void {
    this.closed = true;
    this.registry.release(this);
    this.store.clear();
    this.#rate.clear();
  }
}
