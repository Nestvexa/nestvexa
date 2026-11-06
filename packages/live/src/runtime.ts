import {
  HttpException,
  Inject,
  Injectable,
  StreamableFile,
} from '@nestjs/common';
import type { OnApplicationShutdown, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LiveApplicationRegistry } from './registration.js';
import { SafeHtml } from '@nestvexa/views';
import type { ViewEngineAdapter } from '@nestvexa/views';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  cloneState,
  freezeJson,
  LiveProtocolError,
  parseLiveCapabilities,
  parseLiveRequest,
  isSnapshotToken,
} from './protocol.js';
import type { JsonValue, LiveCapability, LiveRequest } from './protocol.js';
import { applyStateDefaults } from './metadata.js';
import {
  beginOperation,
  endOperation,
  withinDeadline,
} from './cancellation.js';
import {
  isLiveActionCoordination,
  memoryActionPolicy,
  sharedActionPolicy,
} from './action-policy.js';
import type { ActionPolicy } from './action-policy.js';
import { MemoryLiveStore } from './store.js';
import type {
  ChildReference,
  LiveStateStore,
  LiveTransactionResult,
  StateSnapshot,
} from './store.js';
import type { ComponentDefinition } from './metadata.js';
import { beginEffects, persistFlash, takeEffects } from './effects.js';
import type { LiveDownload, LiveEvent } from './effects.js';
import { INTERNAL_SYNC_ACTION } from './metadata.js';
import type { LiveLifecycleHooks, LiveUpdateContext } from './lifecycle.js';
import { prepareComputed } from './computed.js';
import {
  hydrateStateContext,
  persistStateContext,
  urlStateEffects,
} from './state-context.js';
import type { UrlStateEffect } from './state-context.js';
import { closeTextStreams } from './text-stream.js';
import type { TextStreamAuthorization } from './text-stream.js';

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
  /**
   * Server-side state storage (default: a process-local `MemoryLiveStore`).
   * Multi-replica deployments need a shared store such as `RedisLiveStore`
   * from @nestvexa/realtime-redis.
   */
  readonly store?: LiveStateStore;
  readonly maxRequestsPerMinute?: number;
  /**
   * Optional realtime signer (for example `RealtimeService` from
   * @nestvexa/realtime). Receives the channels a component declares and returns a
   * subscription token for those the identity may read, or undefined.
   */
  /**
   * Optional tracing hook (see @nestvexa/observability). Receives span names
   * `nestvexa.live.mount`, `nestvexa.live.action` and `nestvexa.live.render` with
   * component/action names, revisions and sizes only — never state, identities,
   * tokens or HTML.
   */
  readonly instrumentation?: {
    start(
      name: string,
      attributes: Readonly<Record<string, string | number | boolean>>,
    ): {
      end(
        outcome: 'ok' | 'error',
        attributes?: Readonly<Record<string, string | number | boolean>>,
      ): void;
    };
  };
  readonly realtime?: {
    sign(
      identity: LiveIdentity,
      channels: readonly string[],
    ): string | undefined | Promise<string | undefined>;
    /** When present (for example `RealtimeService`), also used for `LiveEvents`. */
    publish?(channel: string, data: JsonValue): unknown;
  };
  /**
   * Publisher for server-pushed `@OnEvent` domain events (`LiveEvents`).
   * Structural, so Live never imports a broker: `RealtimeService` from
   * @nestvexa/realtime fits. Defaults to `realtime` when it has `publish`.
   */
  readonly events?: {
    publish(channel: string, data: JsonValue): unknown;
  };
  /**
   * Current client asset version (for example a manifest hash). Rendered on
   * every component root and required back in `x-nestvexa-asset-version`;
   * a different or missing value fails with `409 ASSET_VERSION_MISMATCH` and
   * `x-nestvexa-reload: asset-version`, and the browser reloads the page.
   */
  readonly assetVersion?: string;
}
export interface RuntimeOptions extends LiveHostOptions {
  readonly definitions: readonly ComponentDefinition[];
}
interface Admission {
  readonly identity: LiveIdentity;
  readonly payload: LiveRequest;
  readonly component: ComponentDefinition;
  readonly action: string;
  readonly capabilities: ReadonlySet<LiveCapability>;
}
/** One render tree: shared request/identity, bounded depth and child bookkeeping. */
interface RenderContext {
  readonly request: object;
  readonly identity: LiveIdentity;
  readonly depth: number;
  readonly previous?: Readonly<Record<string, ChildReference>> | undefined;
  /** Snapshot tokens created in this tree; deleted if the operation fails. */
  readonly created: string[];
  /** Tokens of children no longer rendered; deleted after the parent commits. */
  readonly removed: string[];
  /** Total child renders in this tree. */
  readonly budget: { count: number };
}
interface ChildRequest {
  readonly alias: string;
  readonly key: string;
  readonly props: Record<string, JsonValue>;
  readonly model?: string;
}
interface Rendered {
  readonly html: string;
  readonly state: Record<string, JsonValue>;
  readonly url: readonly UrlStateEffect[];
  readonly children?: Readonly<Record<string, ChildReference>>;
  readonly realtime?: string;
}
const maxChildDepth = 8;
/** Upper bound on waiting for in-flight Live requests during shutdown. */
const shutdownDrainMs = 10_000;
/** Shared identity-lock lease without an action deadline (the maximum deadline). */
const maxLeaseMs = 300_000;
const leaseMarginMs = 1_000;
/** Rebuild a stored JSON value into the component field type. */
function hydrated(
  component: ComponentDefinition,
  key: string,
  value: JsonValue,
): unknown {
  const synthesizer = component.states.get(key)?.synthesizer;
  if (!synthesizer) return value;
  try {
    return synthesizer.hydrate(value);
  } catch {
    // Stored state that no longer hydrates was produced by an older schema.
    fail(409, 'STATE_SCHEMA_CHANGED');
  }
}
const downloadLifetime = 60_000;
const maxDownloads = 100;
/** `filename` already passed `safeFilename`; re-check surrogates so encoding can never throw. */
function contentDisposition(filename: string): string {
  const wellFormed = filename.replace(/\p{Cs}/gu, '\uFFFD');
  const fallback =
    wellFormed.replace(/[^\x20-\x7e]|["\\%;]/g, '_').slice(0, 180) ||
    'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(wellFormed).replace(/['()*!]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
const maxChildrenPerTree = 200;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** Parse nvChild(alias, key, props?) from HBS (hash options) or plain engines. */
function childRequest(args: readonly unknown[]): ChildRequest {
  const values = [...args];
  let named: Record<string, unknown> = {};
  const last: unknown = values.at(-1);
  if (
    last !== null &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    Object.hasOwn(last, 'hash') &&
    Object.hasOwn(last, 'data')
  ) {
    values.pop();
    const hash: unknown = Reflect.get(last, 'hash');
    if (hash && typeof hash === 'object') named = { ...hash };
  } else if (values.length === 3) {
    const props = values.pop();
    if (!props || typeof props !== 'object' || Array.isArray(props))
      throw new Error('nvChild props must be an object');
    named = { ...props };
  }
  const [alias, key] = values;
  if (values.length !== 2 || typeof alias !== 'string')
    throw new Error('nvChild requires an alias and a key');
  if (
    (typeof key !== 'string' && typeof key !== 'number') ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(key))
  )
    throw new Error(
      'nvChild key must be 1–128 letters, digits, "_", ".", ":" or "-"',
    );
  let model: string | undefined;
  if (Object.hasOwn(named, 'model')) {
    const field: unknown = named['model'];
    if (typeof field !== 'string')
      throw new Error('nvChild model must name a field');
    model = field;
    delete named['model'];
  }
  const props = cloneState(named);
  return {
    alias,
    key: String(key),
    props,
    ...(model === undefined ? {} : { model }),
  };
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
/** A read-only view of a parent-owned JSON value: any write fails with 409. */
function readOnlyView(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const views = new WeakMap<object, object>();
  const reject = (): never => fail(409, 'REACTIVE_PROP_MUTATED');
  const view = (target: object): object => {
    const known = views.get(target);
    if (known) return known;
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        const result: unknown = Reflect.get(object, key, receiver);
        return result !== null && typeof result === 'object'
          ? view(result)
          : result;
      },
      set: reject,
      defineProperty: reject,
      deleteProperty: reject,
      setPrototypeOf: reject,
    });
    views.set(target, proxy);
    return proxy;
  };
  return view(value);
}
/**
 * During hooks and the action, `@Reactive` fields are accessors over read-only
 * views: assigning a different value or mutating nested data throws
 * `409 REACTIVE_PROP_MUTATED` at the write, so code after it (and its side
 * effects) never runs. Returns a function restoring plain data fields.
 */
function guardReactiveProps(
  instance: object,
  component: ComponentDefinition,
): () => void {
  const restore: (() => void)[] = [];
  for (const [field, mode] of component.props) {
    if (mode !== 'reactive') continue;
    const descriptor = Object.getOwnPropertyDescriptor(instance, field);
    if (!descriptor || !('value' in descriptor)) continue;
    const original: unknown = descriptor.value;
    const guarded = readOnlyView(original);
    Object.defineProperty(instance, field, {
      get: () => guarded,
      set: (next: unknown) => {
        if (canonical(next) !== canonical(original))
          fail(409, 'REACTIVE_PROP_MUTATED');
      },
      enumerable: true,
      configurable: true,
    });
    restore.push(() =>
      Object.defineProperty(instance, field, {
        value: original,
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    );
  }
  return () => {
    for (const step of restore) step();
  };
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
  readonly store: LiveStateStore;
  readonly #admissions = new WeakMap<object, Admission>();
  readonly #rate = new Map<string, { start: number; count: number }>();
  readonly #computed = new WeakMap<object, () => void>();
  readonly #downloads = new Map<
    string,
    {
      readonly binding: Buffer;
      readonly component: string;
      readonly expiresAt: number;
      readonly download: LiveDownload;
    }
  >();
  /** Abort controllers of running operations; aborted when shutdown begins. */
  readonly #controllers = new Set<AbortController>();
  /** Mount/action requests still running; drained (bounded) during shutdown. */
  readonly #inflight = new Set<Promise<unknown>>();
  /** Idempotent replay and identity locks: shared when the store coordinates replicas. */
  readonly #actions: ActionPolicy;
  constructor(
    @Inject(LIVE_OPTIONS) private readonly options: RuntimeOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(LiveApplicationRegistry)
    private readonly registry: LiveApplicationRegistry,
  ) {
    this.store = options.store ?? new MemoryLiveStore();
    this.#actions = isLiveActionCoordination(this.store)
      ? sharedActionPolicy(this.store)
      : memoryActionPolicy();
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
    // After CSRF so only same-origin pages of this identity are told to reload.
    if (
      this.options.assetVersion !== undefined &&
      header(request, 'x-nestvexa-asset-version') !== this.options.assetVersion
    )
      fail(409, 'ASSET_VERSION_MISMATCH');
    this.limit(identity);
    let payload: LiveRequest;
    let capabilities: ReadonlySet<LiveCapability>;
    try {
      capabilities = parseLiveCapabilities(
        header(request, 'x-nestvexa-capabilities'),
      );
      payload = parseLiveRequest(Reflect.get(request, 'body'));
      const snapshot = await this.store.peek(
        payload.snapshot,
        identity.binding,
      );
      if (snapshot.name !== component.name) fail(403, 'COMPONENT_MISMATCH');
    } catch (error) {
      mapped(error);
    }
    if (action !== INTERNAL_SYNC_ACTION && !component.actions.has(action))
      fail(404, 'UNKNOWN_ACTION');
    if (!(await this.options.authorize(identity, component.name, action)))
      fail(403, 'ACTION_FORBIDDEN');
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    this.#admissions.set(request, {
      identity,
      payload,
      component,
      action,
      capabilities,
    });
  }
  /** Authorize a read-only text stream from a normal host Nest route.
   * Type and stream ID are trusted route constants, never client class/method names.
   * The host authorizes `$stream:<id>` and owns its route guards, DTO pipes and producer.
   */
  async authorizeStream(
    request: object,
    type: Type<object>,
    streamId: string,
    reference: Readonly<{ snapshot: string; revision: number }>,
  ): Promise<TextStreamAuthorization> {
    const component = this.options.definitions.find(
      (entry) => entry.type === type,
    );
    if (!component) {
      const owner = this.registry.owner(type);
      if (owner && owner !== this)
        return owner.authorizeStream(request, type, streamId, reference);
      throw new Error(
        'Stream component is not registered in this Nest application',
      );
    }
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(streamId) ||
      ['constructor', 'prototype', '__proto__'].includes(streamId)
    )
      throw new Error('Invalid registered stream identifier');
    if (Reflect.get(request, 'method') !== 'POST') fail(405, 'STREAM_METHOD');
    if (header(request, 'origin') !== this.options.origin)
      fail(403, 'ORIGIN_REJECTED');
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      fail(415, 'CONTENT_TYPE');
    try {
      const ref = cloneState(reference);
      if (
        Object.keys(ref).length !== 2 ||
        !isSnapshotToken(ref['snapshot']) ||
        typeof ref['revision'] !== 'number' ||
        !Number.isSafeInteger(ref['revision']) ||
        ref['revision'] < 0
      )
        fail(400, 'INVALID_STREAM_REFERENCE');
      const token = ref['snapshot'];
      const revision = ref['revision'];
      const identity = await this.identity(request);
      this.limit(identity);
      const inspect = async (current: LiveIdentity) => {
        if (!equal(current.binding, identity.binding))
          fail(403, 'IDENTITY_CHANGED');
        if (!equal(header(request, 'x-nestvexa-csrf') ?? '', current.csrfToken))
          fail(403, 'CSRF_REJECTED');
        const before = await this.store.peek(token, current.binding);
        if (before.name !== component.name) fail(403, 'COMPONENT_MISMATCH');
        if (before.revision !== revision) fail(409, 'STALE_REVISION');
        if (
          !(await this.options.authorize(
            current,
            component.name,
            `$stream:${streamId}`,
          ))
        )
          fail(403, 'STREAM_FORBIDDEN');
        if (this.closed) fail(503, 'LIVE_SHUTDOWN');
        const after = await this.store.peek(token, current.binding);
        if (after.revision !== revision || after.id !== before.id)
          fail(409, 'STALE_REVISION');
        return after;
      };
      const snapshot = await inspect(identity);
      return Object.freeze({
        // Registrations in one Nest application share this registry and quota scope.
        scope: this.registry,
        componentId: snapshot.id,
        revision: snapshot.revision,
        state: snapshot.state,
        revalidate: async (): Promise<void> => {
          try {
            await inspect(await this.identity(request));
          } catch (error) {
            mapped(error);
          }
        },
      });
    } catch (error) {
      mapped(error);
    }
  }
  private async instance(
    component: ComponentDefinition,
    request: object,
  ): Promise<object> {
    const context = this.registry.context(request);
    this.moduleRef.registerRequestByContextId(request, context);
    // Only the owning runtime's explicit registration reaches this path.
    // Creating the component avoids reusing mutable fields across same-type
    // mounts, while its dependencies still share the actual request context.
    const instance = await this.moduleRef.create(component.type, context);
    applyStateDefaults(instance, component);
    return instance;
  }
  private async operation<T>(
    instance: object,
    component: ComponentDefinition,
    execute: () => Promise<T>,
  ): Promise<T> {
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    const controller = beginOperation(instance, component.timeoutMs);
    this.#controllers.add(controller);
    if (this.closed) controller.abort();
    try {
      const clear = this.#computed.get(instance);
      if (clear) clear();
      else this.#computed.set(instance, prepareComputed(instance, component));
      outcome = { ok: true, value: await execute() };
    } catch (error) {
      outcome = { ok: false, error };
      await this.observeError(instance, error);
    }
    try {
      await this.hook(instance, 'dispose', [], true);
    } catch (error) {
      if (outcome.ok) {
        outcome = { ok: false, error };
        await this.observeError(instance, error);
      }
      // Preserve the original operation failure; cleanup must not mask it.
    }
    endOperation(instance);
    this.#controllers.delete(controller);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  private async observeError(instance: object, error: unknown): Promise<void> {
    try {
      await this.hook(instance, 'onError', [error], true);
    } catch {
      // A diagnostic hook is secondary to the original failure. Never log its
      // raw error or replace the original exception/filter semantics.
    }
  }
  private state(
    instance: object,
    component: ComponentDefinition,
  ): Record<string, JsonValue> {
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [name, options] of component.states) {
      const descriptor = Object.getOwnPropertyDescriptor(instance, name);
      if (!descriptor || !('value' in descriptor))
        throw new Error(`State ${name} must be an initialized data field`);
      result[name] = options.synthesizer
        ? options.synthesizer.dehydrate(descriptor.value)
        : descriptor.value;
    }
    return cloneState(result);
  }
  private render(
    instance: object,
    component: ComponentDefinition,
    context: RenderContext,
  ): Promise<Rendered> {
    return this.traced(
      'nestvexa.live.render',
      { 'nestvexa.component': component.name, 'nestvexa.depth': context.depth },
      () => this.renderUntraced(instance, component, context),
      (rendered) => ({
        'nestvexa.html_bytes': Buffer.byteLength(rendered.html),
        // Public state is already client-safe JSON; only its size is recorded.
        'nestvexa.state_bytes': Buffer.byteLength(
          JSON.stringify(rendered.state),
        ),
      }),
    );
  }
  private async renderUntraced(
    instance: object,
    component: ComponentDefinition,
    context: RenderContext,
  ): Promise<Rendered> {
    await this.hook(instance, 'beforeRender');
    const model: Record<string, unknown> = this.state(instance, component);
    this.#computed.get(instance)?.();
    for (const [name, entry] of component.computed) {
      const value: unknown = Reflect.get(instance, name);
      if (entry.async) {
        if (typeof value !== 'function')
          throw new Error('Computed method is not callable');
        model[name] = await Reflect.apply(value, instance, []);
      } else model[name] = value;
      if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    }
    const requests: ChildRequest[] = [];
    const nonce = randomBytes(12).toString('hex');
    const rendered = await this.options.renderer.render(
      component.view,
      cloneState(model),
      {
        layout: false,
        ...(component.children.size
          ? {
              helpers: {
                nvChild: (...args: unknown[]) => {
                  if (requests.length >= maxChildrenPerTree)
                    throw new Error('Too many nvChild mounts in one render');
                  requests.push(childRequest(args));
                  return SafeHtml.trusted(
                    `<!--nv-child:${nonce}:${requests.length - 1}-->`,
                  );
                },
              },
            }
          : {}),
      },
    );
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const state = this.state(instance, component);
    const composed: {
      html: string;
      children?: Readonly<Record<string, ChildReference>>;
    } = component.children.size
      ? await this.renderChildren(
          component,
          state,
          rendered,
          requests,
          nonce,
          context,
        )
      : { html: rendered };
    const html = composed.html;
    if (Buffer.byteLength(html) > 1_048_576) fail(413, 'PAYLOAD_TOO_LARGE');
    const url = urlStateEffects(instance, component.stateContext);
    await this.hook(instance, 'afterRender', [Object.freeze({ html })]);
    const realtime = await this.realtimeToken(
      instance,
      component,
      context.identity,
    );
    return {
      html,
      state,
      url,
      ...(realtime === undefined ? {} : { realtime }),
      ...(composed.children === undefined
        ? {}
        : { children: composed.children }),
    };
  }
  /** Run work inside an instrumentation span; instrumentation failures never break requests. */
  private async traced<T>(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
    work: () => Promise<T>,
    finish?: (value: T) => Readonly<Record<string, string | number | boolean>>,
  ): Promise<T> {
    const hook = this.options.instrumentation;
    if (!hook) return work();
    let span:
      | ReturnType<NonNullable<LiveHostOptions['instrumentation']>['start']>
      | undefined;
    try {
      span = hook.start(name, attributes);
    } catch {
      span = undefined;
    }
    try {
      const value = await work();
      try {
        span?.end('ok', finish?.(value));
      } catch {
        // Telemetry is best effort.
      }
      return value;
    } catch (error) {
      try {
        span?.end(
          'error',
          error instanceof HttpException ? { status: error.getStatus() } : {},
        );
      } catch {
        // Telemetry is best effort.
      }
      throw error;
    }
  }
  /** Ask the host signer for a subscription token covering declared channels. */
  private async realtimeToken(
    instance: object,
    component: ComponentDefinition,
    identity: LiveIdentity,
  ): Promise<string | undefined> {
    if (!component.realtime || !this.options.realtime) return undefined;
    const method: unknown = Reflect.get(instance, component.realtime);
    if (typeof method !== 'function')
      throw new Error('Realtime channel method is not callable');
    const channels: unknown = await Reflect.apply(method, instance, []);
    if (
      !Array.isArray(channels) ||
      channels.length > 32 ||
      channels.some((channel) => typeof channel !== 'string')
    )
      throw new Error('@RealtimeChannels must return up to 32 channel names');
    if (!channels.length) return undefined;
    const token = await this.options.realtime.sign(
      identity,
      channels as string[],
    );
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    if (
      token !== undefined &&
      (typeof token !== 'string' || token.length > 8192)
    )
      throw new Error('Realtime signer returned an invalid token');
    return token;
  }
  private definitionOf(type: Type<object>): ComponentDefinition {
    const found = this.options.definitions.find((entry) => entry.type === type);
    if (!found)
      throw new Error(
        'Child components must be registered in the same LiveModule registration',
      );
    return found;
  }
  /** Replace each trusted placeholder exactly once with a mounted, retained or refreshed child root. */
  private async renderChildren(
    component: ComponentDefinition,
    parentState: Readonly<Record<string, JsonValue>>,
    rendered: string,
    requests: readonly ChildRequest[],
    nonce: string,
    context: RenderContext,
  ): Promise<{
    html: string;
    children: Readonly<Record<string, ChildReference>>;
  }> {
    if (context.depth >= maxChildDepth && requests.length)
      throw new Error('Live child nesting exceeds the depth limit');
    const children: Record<string, ChildReference> = Object.create(
      null,
    ) as Record<string, ChildReference>;
    let html = rendered;
    for (const [index, item] of requests.entries()) {
      const type = component.children.get(item.alias);
      if (!type) throw new Error(`Unknown child alias ${item.alias}`);
      const child = this.definitionOf(type);
      const slot = `${item.alias}:${item.key}`;
      if (Object.hasOwn(children, slot))
        throw new Error(`Duplicate nvChild key ${slot}`);
      if (++context.budget.count > maxChildrenPerTree)
        throw new Error('Too many Live children in one render tree');
      const props: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      for (const [field, value] of Object.entries(item.props)) {
        if (!child.props.has(field) || child.props.get(field) === 'modelable')
          throw new Error(
            `${child.name}.${field} is not a declared @Prop/@Reactive`,
          );
        props[field] = value;
      }
      let model:
        { readonly parent: string; readonly child: string } | undefined;
      if (item.model !== undefined) {
        const target = [...child.props].find(
          ([, mode]) => mode === 'modelable',
        );
        if (!target) throw new Error(`${child.name} has no @Modelable field`);
        if (!component.states.get(item.model)?.writable)
          throw new Error(
            `nvChild model ${item.model} must be writable parent state`,
          );
        const value = parentState[item.model];
        if (value === undefined) throw new Error('Unknown nvChild model field');
        props[target[0]] = value;
        model = { parent: item.model, child: target[0] };
      }
      const previous = context.previous?.[slot];
      const output =
        previous && previous.name === child.name
          ? await this.retainChild(child, previous, props, slot, model, context)
          : await this.mountChild(
              child,
              item.alias,
              props,
              slot,
              model,
              context,
            );
      children[slot] = output.reference;
      const placeholder = `<!--nv-child:${nonce}:${index}-->`;
      const parts = html.split(placeholder);
      if (parts.length !== 2)
        throw new Error('Each nvChild result must be output exactly once');
      html = parts.join(output.html);
    }
    for (const [slot, reference] of Object.entries(context.previous ?? {}))
      if (!Object.hasOwn(children, slot)) context.removed.push(reference.token);
    return { html, children: Object.freeze(children) };
  }
  private applyProps(
    instance: object,
    props: Readonly<Record<string, JsonValue>>,
  ): void {
    for (const [field, value] of Object.entries(cloneState(props)))
      Object.defineProperty(instance, field, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  private wrapper(
    component: ComponentDefinition,
    snapshot: StateSnapshot,
    identity: LiveIdentity,
    html: string,
    extra: {
      readonly key?: string;
      readonly model?: { readonly parent: string; readonly child: string };
      readonly lazy?: boolean;
      readonly refresh?: boolean;
      readonly realtime?: string | undefined;
    } = {},
  ): string {
    const endpoint = `${this.options.basePath ?? ''}${this.options.endpoint ?? '/_nestvexa/live'}/${component.name}`;
    const listeners = Object.fromEntries(component.listeners);
    const attributes = [
      `data-nv-component="${escapeAttribute(snapshot.id)}"`,
      `data-nv-name="${component.name}"`,
      `data-nv-snapshot="${escapeAttribute(snapshot.snapshot)}"`,
      `data-nv-state="${escapeAttribute(JSON.stringify(snapshot.state))}"`,
      `data-nv-revision="${snapshot.revision}"`,
      `data-nv-endpoint="${escapeAttribute(endpoint)}"`,
      `data-nv-csrf="${escapeAttribute(identity.csrfToken)}"`,
      ...(this.options.assetVersion === undefined
        ? []
        : [
            `data-nv-asset-version="${escapeAttribute(this.options.assetVersion)}"`,
          ]),
      ...(extra.key === undefined
        ? []
        : [`data-nv-key="nv-child:${escapeAttribute(extra.key)}"`]),
      ...(component.listeners.size
        ? [`data-nv-listeners="${escapeAttribute(JSON.stringify(listeners))}"`]
        : []),
      ...(extra.model === undefined
        ? []
        : [`data-nv-model="${escapeAttribute(JSON.stringify(extra.model))}"`]),
      ...(extra.refresh ? ['data-nv-refresh=""'] : []),
      ...(extra.realtime === undefined
        ? []
        : [`data-nv-realtime="${escapeAttribute(extra.realtime)}"`]),
      ...(extra.lazy && component.lazy
        ? [`data-nv-lazy="${component.lazy}"`]
        : []),
    ];
    return `<div ${attributes.join(' ')}>${html}</div>`;
  }
  private async placeholder(
    instance: object,
    component: ComponentDefinition,
  ): Promise<Rendered> {
    const state = this.state(instance, component);
    const html = component.placeholder
      ? await this.options.renderer.render(
          component.placeholder,
          cloneState(state),
          {
            layout: false,
          },
        )
      : '<p data-nv-placeholder="" role="status" aria-busy="true">Loading…</p>';
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    if (Buffer.byteLength(html) > 1_048_576) fail(413, 'PAYLOAD_TOO_LARGE');
    return {
      html,
      state,
      url: urlStateEffects(instance, component.stateContext),
    };
  }
  private async mountChild(
    child: ComponentDefinition,
    alias: string,
    props: Readonly<Record<string, JsonValue>>,
    slot: string,
    model: { readonly parent: string; readonly child: string } | undefined,
    context: RenderContext,
  ): Promise<{ html: string; reference: ChildReference }> {
    const { identity, request } = context;
    if (!(await this.options.authorize(identity, child.name, '$mount')))
      fail(403, 'COMPONENT_FORBIDDEN');
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const instance = await this.instance(child, request);
    const captured = await this.operation(instance, child, async () => {
      await this.hook(instance, 'boot');
      await hydrateStateContext(
        instance,
        child.name,
        child.stateContext,
        child.states,
        request,
        identity.binding,
      );
      this.applyProps(instance, props);
      await this.hook(instance, 'mount');
      await this.hook(instance, 'dehydrate');
      return child.lazy
        ? this.placeholder(instance, child)
        : this.render(instance, child, {
            ...context,
            depth: context.depth + 1,
            previous: undefined,
          });
    });
    const snapshot = await this.store.create(
      child.name,
      identity.binding,
      captured.state,
      captured.children,
    );
    context.created.push(snapshot.snapshot);
    persistStateContext(
      captured.state,
      child.name,
      child.stateContext,
      request,
      identity.binding,
    );
    return {
      html: this.wrapper(child, snapshot, identity, captured.html, {
        realtime: captured.realtime,
        key: slot,
        ...(model === undefined ? {} : { model }),
        lazy: true,
      }),
      reference: {
        alias,
        name: child.name,
        id: snapshot.id,
        token: snapshot.snapshot,
      },
    };
  }
  /** Keep the browser-owned child unless a parent-owned value changed. */
  private async retainChild(
    child: ComponentDefinition,
    reference: ChildReference,
    props: Readonly<Record<string, JsonValue>>,
    slot: string,
    model: { readonly parent: string; readonly child: string } | undefined,
    context: RenderContext,
  ): Promise<{ html: string; reference: ChildReference }> {
    const { identity, request } = context;
    let current: StateSnapshot;
    try {
      current = await this.store.peek(reference.token, identity.binding);
    } catch (error) {
      // A shared store outage must surface, not silently reset child state.
      if (!(error instanceof LiveProtocolError)) throw error;
      // Expired or revoked child state: mount a fresh child for this key.
      return this.mountChild(
        child,
        reference.alias,
        props,
        slot,
        model,
        context,
      );
    }
    const changed = Object.entries(props).filter(
      ([field, value]) =>
        child.props.get(field) !== 'mount' &&
        canonical(current.state[field]) !== canonical(value),
    );
    const stub = `<div data-nv-component="${escapeAttribute(current.id)}" data-nv-key="nv-child:${escapeAttribute(slot)}" data-nv-stub=""></div>`;
    if (!changed.length) return { html: stub, reference };
    let result: LiveTransactionResult;
    let refreshedRealtime: string | undefined;
    try {
      result = await this.store.transaction(
        reference.token,
        identity.binding,
        current.revision,
        async (snapshot) => {
          const instance = await this.instance(child, request);
          return this.operation(instance, child, async () => {
            for (const [key, value] of Object.entries(
              cloneState(snapshot.state),
            )) {
              if (!child.states.has(key)) fail(409, 'STATE_SCHEMA_CHANGED');
              Object.defineProperty(instance, key, {
                value: hydrated(child, key, value),
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
            await this.hook(instance, 'boot');
            await this.hook(instance, 'hydrate');
            for (const [field, value] of changed) {
              const update: LiveUpdateContext = Object.freeze({
                field,
                previous: freezeJson(
                  structuredClone(snapshot.state[field] ?? null),
                ),
                value: freezeJson(structuredClone(value)),
              });
              await this.hook(instance, 'beforeUpdate', [update]);
              this.applyProps(instance, { [field]: value });
              await this.hook(instance, 'afterUpdate', [update]);
            }
            await this.hook(instance, 'dehydrate');
            const rendered = await this.render(instance, child, {
              ...context,
              depth: context.depth + 1,
              previous: snapshot.children,
            });
            refreshedRealtime = rendered.realtime;
            return {
              state: rendered.state,
              html: rendered.html,
              ...(rendered.children === undefined
                ? {}
                : { children: rendered.children }),
            };
          });
        },
      );
    } catch (error) {
      // A child with its own request in flight keeps its DOM; its next render
      // receives the parent value through the following parent update.
      if (error instanceof LiveProtocolError && error.code === 'COMPONENT_BUSY')
        return { html: stub, reference };
      throw error;
    }
    return {
      html: this.wrapper(child, result, identity, result.html, {
        realtime: refreshedRealtime,
        key: slot,
        refresh: true,
        ...(model === undefined ? {} : { model }),
      }),
      reference,
    };
  }
  private async hook(
    instance: object,
    name: keyof LiveLifecycleHooks,
    args: readonly unknown[] = [],
    cleanup = false,
  ): Promise<void> {
    if (this.closed && !cleanup) fail(503, 'LIVE_SHUTDOWN');
    this.#computed.get(instance)?.();
    const method: unknown = Reflect.get(instance, name);
    if (method !== undefined && typeof method !== 'function')
      throw new Error(`Lifecycle hook ${name} must be a method`);
    try {
      if (typeof method === 'function')
        await withinDeadline(instance, 'HOOK_TIMEOUT', () =>
          Reflect.apply(method, instance, args),
        );
    } finally {
      this.#computed.get(instance)?.();
    }
    if (this.closed && !cleanup) fail(503, 'LIVE_SHUTDOWN');
  }
  /** Mount only from a host route with host-resolved identity; never from a client class name. */
  async mount(type: Type<object>, request: object): Promise<SafeHtml> {
    const definition = this.options.definitions.find(
      (entry) => entry.type === type,
    );
    if (!definition) return this.mountUntraced(type, request);
    return this.tracked(
      this.traced(
        'nestvexa.live.mount',
        { 'nestvexa.component': definition.name },
        () => this.mountUntraced(type, request),
      ),
    );
  }
  /** Register a running request so shutdown can wait for it to settle. */
  private tracked<T>(work: Promise<T>): Promise<T> {
    this.#inflight.add(work);
    const settle = () => {
      this.#inflight.delete(work);
    };
    work.then(settle, settle);
    return work;
  }
  private async mountUntraced(
    type: Type<object>,
    request: object,
  ): Promise<SafeHtml> {
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
    const context: RenderContext = {
      request,
      identity,
      depth: 0,
      created: [],
      removed: [],
      budget: { count: 0 },
    };
    let captured: Rendered;
    try {
      captured = await this.operation(instance, component, async () => {
        await this.hook(instance, 'boot');
        await hydrateStateContext(
          instance,
          component.name,
          component.stateContext,
          component.states,
          request,
          identity.binding,
        );
        await this.hook(instance, 'mount');
        await this.hook(instance, 'dehydrate');
        return component.lazy
          ? this.placeholder(instance, component)
          : this.render(instance, component, context);
      });
    } catch (error) {
      await this.discard(context.created);
      mapped(error);
    }
    let snapshot: StateSnapshot | undefined;
    try {
      snapshot = await this.store.create(
        component.name,
        identity.binding,
        captured.state,
        captured.children,
      );
      persistStateContext(
        captured.state,
        component.name,
        component.stateContext,
        request,
        identity.binding,
      );
    } catch (error) {
      await this.discard(
        snapshot ? [snapshot.snapshot, ...context.created] : context.created,
      );
      await this.observeError(instance, error);
      mapped(error);
    }
    return SafeHtml.trusted(
      this.wrapper(component, snapshot, identity, captured.html, {
        realtime: captured.realtime,
        lazy: true,
      }),
    );
  }
  async execute(request: object, input: unknown): Promise<unknown> {
    const admitted = this.#admissions.get(request);
    if (!admitted || !this.options.instrumentation)
      return this.tracked(this.executeUntraced(request, input));
    return this.tracked(
      this.traced(
        'nestvexa.live.action',
        {
          'nestvexa.component': admitted.component.name,
          'nestvexa.action': admitted.action,
          'nestvexa.revision': admitted.payload.revision,
        },
        () => this.executeUntraced(request, input),
      ),
    );
  }
  private async executeUntraced(
    request: object,
    input: unknown,
  ): Promise<unknown> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    const admitted = this.#admissions.get(request);
    if (!admitted) fail(403, 'ADMISSION_REQUIRED');
    const { identity, payload, component, action, capabilities } = admitted;
    let completed: object | undefined;
    let release: (() => Promise<void>) | undefined;
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
      const renderless =
        selected?.renderless === true && capabilities.has('renderless-v1');
      // An identical retry of a committed idempotent action replays its result
      // before the (now stale) revision check; nothing executes again.
      const replayed = selected?.idempotent
        ? await this.#actions.lookup(
            identity.binding,
            component.name,
            action,
            payload,
          )
        : undefined;
      if (replayed) return replayed;
      if (selected?.concurrency === 'identity')
        release = await this.#actions.acquire(
          identity.binding,
          component.name,
          action,
          // A shared lease outlives the action deadline slightly; without a
          // deadline it is bounded by the longest supported one.
          component.timeoutMs === undefined
            ? maxLeaseMs
            : component.timeoutMs + leaseMarginMs,
        );
      const updates = await this.validatedUpdates(component, identity, payload);
      let url: readonly UrlStateEffect[] = [];
      let persist: (() => void) | undefined;
      let events: readonly LiveEvent[] = [];
      let redirect: string | undefined;
      let download: LiveDownload | undefined;
      let realtime: string | undefined;
      let flash: readonly string[] = [];
      const context: RenderContext = {
        request,
        identity,
        depth: 0,
        created: [],
        removed: [],
        budget: { count: 0 },
      };
      const result = await this.store
        .transaction(
          payload.snapshot,
          identity.binding,
          payload.revision,
          async (snapshot) => {
            const instance = await this.instance(component, request);
            beginEffects(instance);
            const capturedOperation = await this.operation(
              instance,
              component,
              async () => {
                if (this.closed) fail(503, 'LIVE_SHUTDOWN');
                for (const [key, value] of Object.entries(
                  cloneState(snapshot.state),
                )) {
                  if (!component.states.has(key))
                    fail(409, 'STATE_SCHEMA_CHANGED');
                  Object.defineProperty(instance, key, {
                    value: hydrated(component, key, value),
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
                    value: hydrated(component, key, value),
                    writable: true,
                    enumerable: true,
                    configurable: true,
                  });
                  await this.hook(instance, 'afterUpdate', [update]);
                }
                // Parent-owned values fail at the write, before later effects.
                const restoreReactive = guardReactiveProps(instance, component);
                try {
                  if (!synchronization && selected) {
                    await this.hook(instance, 'beforeAction');
                    const method: unknown = Reflect.get(
                      instance,
                      selected.method,
                    );
                    if (typeof method !== 'function')
                      throw new Error('Registered action is not callable');
                    await withinDeadline(instance, 'ACTION_TIMEOUT', () =>
                      Reflect.apply(
                        method,
                        instance,
                        selected.input ? [input] : [],
                      ),
                    );
                    await this.hook(instance, 'afterAction');
                  }
                  await this.hook(instance, 'dehydrate');
                } finally {
                  restoreReactive();
                }
                for (const [field, mode] of component.props)
                  if (
                    mode === 'reactive' &&
                    canonical(Reflect.get(instance, field)) !==
                      canonical(snapshot.state[field])
                  )
                    fail(409, 'REACTIVE_PROP_MUTATED');
                const captured: Rendered = renderless
                  ? {
                      html: '',
                      state: this.state(instance, component),
                      url: urlStateEffects(instance, component.stateContext),
                    }
                  : await this.render(instance, component, {
                      ...context,
                      previous: snapshot.children,
                    });
                url = captured.url;
                realtime = captured.realtime;
                persist = () =>
                  persistStateContext(
                    captured.state,
                    component.name,
                    component.stateContext,
                    request,
                    identity.binding,
                  );
                return {
                  state: captured.state,
                  html: captured.html,
                  ...(captured.children === undefined
                    ? {}
                    : { children: captured.children }),
                };
              },
            ).finally(() => {
              const effects = takeEffects(instance);
              events = effects.events;
              redirect = effects.redirect;
              download = effects.download;
              flash = effects.flash;
            });
            completed = instance;
            return capturedOperation;
          },
        )
        .catch(async (error: unknown) => {
          await this.discard(context.created);
          throw error;
        });
      try {
        persist?.();
        persistFlash(request, flash);
      } catch (error) {
        // The action may have performed effects. Revoke the advanced token rather
        // than returning a retryable response for an uncommitted host session.
        await this.discard([result.snapshot, ...context.created]);
        throw error;
      }
      await this.discard(context.removed);
      const attachment = download
        ? this.storeDownload(identity, component, download)
        : undefined;
      const response = {
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
        ...(renderless ? { renderless: true } : {}),
        ...(url.length ? { url } : {}),
        ...(events.length ? { events } : {}),
        ...(redirect === undefined ? {} : { redirect }),
        ...(attachment === undefined ? {} : { download: attachment }),
        ...(realtime === undefined ? {} : { realtime }),
      };
      if (selected?.idempotent)
        await this.#actions.remember(
          identity.binding,
          component.name,
          action,
          payload,
          response,
        );
      return response;
    } catch (error) {
      if (completed) await this.observeError(completed, error);
      mapped(error);
    } finally {
      await release?.();
      this.#admissions.delete(request);
    }
  }
  private storeDownload(
    identity: LiveIdentity,
    component: ComponentDefinition,
    download: LiveDownload,
  ): { url: string; filename: string } {
    const now = Date.now();
    for (const [key, entry] of this.#downloads)
      if (entry.expiresAt <= now) this.#downloads.delete(key);
    if (this.#downloads.size >= maxDownloads) fail(503, 'DOWNLOAD_CAPACITY');
    const token = randomBytes(32).toString('base64url');
    this.#downloads.set(token, {
      binding: createHash('sha256').update(identity.binding).digest(),
      component: component.name,
      expiresAt: now + downloadLifetime,
      download,
    });
    return {
      url: `${this.options.basePath ?? ''}${this.options.endpoint ?? '/_nestvexa/live'}/${component.name}/_download/${token}`,
      filename: download.filename,
    };
  }
  /** Single-use attachment for the identity that ran the action. */
  async download(
    request: object,
    component: ComponentDefinition,
    token: unknown,
  ): Promise<StreamableFile> {
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail(404, 'DOWNLOAD_UNAVAILABLE');
    const entry = this.#downloads.get(token);
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      entry.component !== component.name
    ) {
      this.#downloads.delete(token);
      fail(404, 'DOWNLOAD_UNAVAILABLE');
    }
    const identity = await this.identity(request);
    const binding = createHash('sha256').update(identity.binding).digest();
    if (!timingSafeEqual(binding, entry.binding))
      fail(404, 'DOWNLOAD_UNAVAILABLE');
    // Consume before streaming: a token is never served twice.
    this.#downloads.delete(token);
    return new StreamableFile(Buffer.from(entry.download.body), {
      type: entry.download.contentType,
      disposition: contentDisposition(entry.download.filename),
      length: entry.download.body.byteLength,
    });
  }
  private async validatedUpdates(
    component: ComponentDefinition,
    identity: LiveIdentity,
    payload: LiveRequest,
  ): Promise<Record<string, JsonValue>> {
    const snapshot = await this.store.peek(payload.snapshot, identity.binding);
    if (snapshot.revision !== payload.revision) fail(409, 'STALE_REVISION');
    // A validation callback may retain its input; expose detached immutable data only.
    const updates = freezeJson(cloneState(payload.updates));
    for (const [key, value] of Object.entries(updates)) {
      const state = component.states.get(key);
      if (!state?.writable) fail(422, 'STATE_LOCKED');
      const previous = snapshot.state[key];
      // A synthesizer owns the accepted JSON shape (for example nullable or enum).
      if (
        !state.synthesizer &&
        (typeof value !== typeof previous ||
          Array.isArray(value) !== Array.isArray(previous) ||
          (value === null) !== (previous === null))
      )
        fail(422, 'STATE_TYPE');
      if (state.synthesizer)
        try {
          state.synthesizer.hydrate(value);
        } catch {
          fail(422, 'STATE_TYPE');
        }
      if (state.validate && (await state.validate(value)) !== true)
        fail(422, 'STATE_INVALID');
      if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    }
    if (this.closed) fail(503, 'LIVE_SHUTDOWN');
    // Components receive mutable data, independently of the validator's captured references.
    return cloneState(updates);
  }
  /**
   * Best-effort deletion of snapshot tokens created by a failed operation. A
   * store failure here must not mask the original error; entries left behind
   * still expire with the store TTL.
   */
  private async discard(tokens: readonly string[]): Promise<void> {
    await Promise.all(
      tokens.map(async (token) => {
        try {
          await this.store.delete(token);
        } catch {
          // Unreachable shared store: the entry expires with its TTL.
        }
      }),
    );
  }
  /**
   * Graceful shutdown: refuse new work, abort running operations (their next
   * checkpoint answers 503 LIVE_SHUTDOWN) and wait up to `shutdownDrainMs` for
   * in-flight requests to settle before the HTTP server and store close.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.closed = true;
    closeTextStreams(this.registry);
    for (const controller of this.#controllers) controller.abort();
    if (!this.#inflight.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.#inflight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, shutdownDrainMs);
      }),
    ]);
    clearTimeout(timer);
  }
  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    this.registry.release(this);
    this.#rate.clear();
    this.#downloads.clear();
    this.#actions.clear();
    // Memory stores discard state; shared stores close connections only.
    await this.store.close();
  }
}
