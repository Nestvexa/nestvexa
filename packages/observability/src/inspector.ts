import { redact } from './instrumentation.js';
import { currentRequestId } from './request.js';

/**
 * Structural mirror of `LiveComponentDescription` from @nestvexa/live (this
 * package does not import Live).
 */
export interface InspectedComponent {
  readonly name: string;
  readonly view: string;
  readonly lazy: false | 'load' | 'visible';
  readonly actions: readonly string[];
  readonly states: readonly {
    readonly name: string;
    readonly writable: boolean;
  }[];
  readonly computed: readonly string[];
  readonly children: readonly string[];
  readonly listeners: readonly string[];
  readonly realtime: boolean;
}
/** Structural mirror of `LiveRenderInspection` from @nestvexa/live. */
export interface InspectedRenderInput {
  readonly component: string;
  readonly cause: 'mount' | 'action' | 'sync' | 'refresh';
  readonly action?: string;
  readonly fields: readonly string[];
  readonly revision: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly stateBytes: number;
  readonly htmlBytes: number;
}
/** One render as stored by the inspector: redacted, bounded, with its request id. */
export interface InspectedRender {
  readonly at: number;
  readonly requestId?: string;
  readonly component: string;
  readonly cause: 'mount' | 'action' | 'sync' | 'refresh';
  readonly action?: string;
  readonly fields: readonly string[];
  readonly revision: number;
  readonly stateBytes: number;
  readonly htmlBytes: number;
  /** Public state with sensitive keys replaced by "[redacted]"; large states are elided. */
  readonly state: unknown;
  /** Field → message pairs of a non-empty `errors` state field (form error bags). */
  readonly validationErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}
/**
 * Structural mirror of `CacheEvent` from @nestvexa/cache (this package does
 * not import it): namespace, scope kind, tags and timings, never keys,
 * bindings, tenants or values.
 */
export interface InspectedCacheEventInput {
  readonly type: string;
  readonly namespace?: string;
  readonly scope?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly tags?: readonly string[];
  readonly removed?: number;
}
export type InspectedCacheEventType =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'coalesced'
  | 'bypass'
  | 'refused'
  | 'discarded'
  | 'compute-error'
  | 'refresh-error'
  | 'store-error'
  | 'invalidate';
/** One cache event as stored by the inspector, with its request id. */
export interface InspectedCacheEvent {
  readonly at: number;
  readonly requestId?: string;
  readonly type: InspectedCacheEventType;
  readonly namespace?: string;
  readonly scope?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly tags: readonly string[];
  readonly removed?: number;
}
/** Lookup outcomes of one cache namespace since the inspector started or was cleared. */
export interface InspectedCacheSummary {
  readonly namespace: string;
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly coalesced: number;
  readonly bypassed: number;
  readonly errors: number;
  /** Hits over all lookups (hit, miss, stale, coalesced); 0 without lookups. */
  readonly hitRatio: number;
}
/** Structural input of one Inertia page response (the @nestvexa/inertia `inspector` option). */
export interface InspectedPageInput {
  readonly component: string;
  readonly kind: 'document' | 'json';
  readonly status?: number;
  /** The resolved props sent to the browser; redacted before they are kept. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Prop names a partial reload asked for (absent on full visits). */
  readonly partial?: readonly string[];
  /** Deferred prop groups the page loads later. */
  readonly deferred?: Readonly<Record<string, readonly string[]>>;
  /** Names of the shared props. */
  readonly shared?: readonly string[];
}
/** One Inertia page response as stored by the inspector: redacted and bounded. */
export interface InspectedPage {
  readonly at: number;
  readonly requestId?: string;
  readonly component: string;
  readonly kind: 'document' | 'json';
  readonly status: number;
  readonly propNames: readonly string[];
  readonly propsBytes: number;
  /** Props with sensitive keys replaced by "[redacted]"; large props are elided. */
  readonly props: unknown;
  readonly partial?: readonly string[];
  readonly deferred: readonly string[];
  readonly shared: readonly string[];
}
/** One browser timing as a reporter sends it (see `@nestvexa/observability/devtools-client`). */
export interface InspectedClientTimingInput {
  readonly phase: string;
  readonly outcome: string;
  readonly milliseconds: number;
  readonly component?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly traceId?: string;
}
/**
 * One browser timing kept by the inspector: a Live client `onDiagnostic`
 * sample with the component name, the request and response sizes and the
 * W3C trace id of the request. Anything else a report carries is dropped.
 */
export interface InspectedClientTiming {
  /** Server receive time. */
  readonly at: number;
  readonly phase: 'queue' | 'request' | 'morph';
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly milliseconds: number;
  readonly component?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly traceId?: string;
}
/** Network batches of one component: its Live requests with sizes and timings. */
export interface InspectedNetworkSummary {
  readonly component: string;
  readonly requests: number;
  readonly failed: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly averageMs: number;
  readonly maxMs: number;
}
/** Browser DOM morph timing of one component. */
export interface InspectedMorphSummary {
  readonly component: string;
  readonly morphs: number;
  readonly p50: number;
  readonly max: number;
}
export interface DevtoolsInspectorOptions {
  /** Renders kept (oldest dropped first). Default 100. */
  readonly capacity?: number;
  /** Largest redacted state kept per render, in bytes. Default 8192. */
  readonly maxStateBytes?: number;
  /** Defaults to `process.env.NODE_ENV`; construction throws in production. */
  readonly environment?: string;
}

const componentName = /^[a-z][a-z0-9-]{0,99}$/;
const identifier = /^[$A-Za-z_][\w$.-]{0,99}$/;
/** Cache namespaces and tags (the @nestvexa/cache grammar). */
const cacheName = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const cacheReason = /^[a-z][a-z0-9_-]{0,63}$/;
/** Inertia page component names (`Users/Index`, `dashboard.home`). */
const pageName = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const cacheTypes = new Set<string>([
  'hit',
  'miss',
  'stale',
  'coalesced',
  'bypass',
  'refused',
  'discarded',
  'compute-error',
  'refresh-error',
  'store-error',
  'invalidate',
]);
/** Most browser timings accepted from one report. */
export const DEVTOOLS_CLIENT_BATCH_LIMIT = 50;
const byteCount = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1_073_741_824
    ? value
    : undefined;
const milliseconds = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 3_600_000
    ? Math.round(value * 10) / 10
    : undefined;
const own = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
function text(value: unknown, max = 200): string {
  const string = typeof value === 'string' ? value : JSON.stringify(value);
  return (string ?? '').slice(0, max);
}
/** Hook input is structural: tolerate a missing list (Live ignores hook errors). */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return value ?? [];
}
function names(
  values: readonly unknown[] | undefined,
  limit = 100,
): readonly string[] {
  return Object.freeze(
    list(values)
      .filter(
        (value): value is string =>
          typeof value === 'string' && identifier.test(value),
      )
      .slice(0, limit),
  );
}

/**
 * Development-only Live inspector. Pass the same instance as Live's
 * `inspector` option and as `DevtoolsModule.register({ inspector })`. It keeps
 * the registered component catalog and the last renders' public state, with
 * sensitive keys (tokens, passwords, cookies, sessions, CSRF, snapshots,
 * bindings, ...) redacted and sizes bounded. Live never passes identities,
 * tokens, snapshots or HTML to it.
 */
type CacheTotals = Record<
  Exclude<keyof InspectedCacheSummary, 'namespace' | 'hitRatio'>,
  number
>;

export class DevtoolsInspector {
  readonly #renders: InspectedRender[] = [];
  readonly #cache: InspectedCacheEvent[] = [];
  readonly #cacheTotals = new Map<string, CacheTotals>();
  readonly #pages: InspectedPage[] = [];
  readonly #client: InspectedClientTiming[] = [];
  #components: readonly InspectedComponent[] = [];
  readonly #capacity: number;
  readonly #maxStateBytes: number;
  constructor(options: DevtoolsInspectorOptions = {}) {
    const environment =
      options.environment ?? process.env['NODE_ENV'] ?? 'development';
    if (environment === 'production')
      throw new Error(
        'Nestvexa DevtoolsInspector must not be created in production',
      );
    this.#capacity = options.capacity ?? 100;
    this.#maxStateBytes = options.maxStateBytes ?? 8192;
    for (const [name, value] of [
      ['capacity', this.#capacity],
      ['maxStateBytes', this.#maxStateBytes],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)
        throw new Error(`Invalid inspector ${name}`);
  }
  /** Live hook: the registered component catalog. */
  registered(components: readonly InspectedComponent[]): void {
    this.#components = Object.freeze(
      list(components)
        .filter(
          (component) =>
            typeof component?.name === 'string' &&
            componentName.test(component.name),
        )
        .slice(0, 500)
        .map((component) =>
          Object.freeze({
            name: component.name,
            view: text(component.view, 200),
            lazy:
              component.lazy === 'load' || component.lazy === 'visible'
                ? component.lazy
                : false,
            actions: names(component.actions),
            states: Object.freeze(
              list(component.states)
                .filter((state) => identifier.test(state?.name ?? ''))
                .slice(0, 100)
                .map((state) =>
                  Object.freeze({
                    name: state.name,
                    writable: state.writable === true,
                  }),
                ),
            ),
            computed: names(component.computed),
            children: names(component.children),
            listeners: names(component.listeners),
            realtime: component.realtime === true,
          }),
        ),
    );
  }
  /** Live hook: one top-level render with its public state. */
  rendered(input: InspectedRenderInput): void {
    if (
      typeof input?.component !== 'string' ||
      !componentName.test(input.component)
    )
      return;
    const redacted = redact(input.state);
    const json = JSON.stringify(redacted) ?? 'null';
    const state =
      Buffer.byteLength(json) > this.#maxStateBytes
        ? { '[elided]': `${Buffer.byteLength(json)} bytes` }
        : redacted;
    const requestId = currentRequestId();
    this.#renders.push(
      Object.freeze({
        at: Date.now(),
        ...(requestId === undefined ? {} : { requestId }),
        component: input.component,
        cause:
          input.cause === 'action' ||
          input.cause === 'sync' ||
          input.cause === 'refresh'
            ? input.cause
            : 'mount',
        ...(typeof input.action === 'string' && identifier.test(input.action)
          ? { action: input.action }
          : {}),
        fields: names(input.fields),
        revision: Number.isSafeInteger(input.revision) ? input.revision : 0,
        stateBytes: Number.isSafeInteger(input.stateBytes)
          ? input.stateBytes
          : 0,
        htmlBytes: Number.isSafeInteger(input.htmlBytes) ? input.htmlBytes : 0,
        state,
        validationErrors: validationErrors(redacted),
      }),
    );
    if (this.#renders.length > this.#capacity) this.#renders.shift();
  }
  /**
   * @nestvexa/cache hook: `new Cache({ onEvent: (event) => inspector.cacheEvent(event) })`
   * (or `RenderCache`). Keeps the event type, namespace, scope kind, tags,
   * timings and the request id; values and keys never reach it.
   */
  cacheEvent(event: InspectedCacheEventInput): void {
    const type = own(event, 'type');
    if (typeof type !== 'string' || !cacheTypes.has(type)) return;
    const namespace = own(event, 'namespace');
    const scope = own(event, 'scope');
    const reason = own(event, 'reason');
    const tags = own(event, 'tags');
    const durationMs = milliseconds(own(event, 'durationMs'));
    const removed = byteCount(own(event, 'removed'));
    const requestId = currentRequestId();
    const record: InspectedCacheEvent = Object.freeze({
      at: Date.now(),
      ...(requestId === undefined ? {} : { requestId }),
      type: type as InspectedCacheEventType,
      ...(typeof namespace === 'string' && cacheName.test(namespace)
        ? { namespace }
        : {}),
      ...(typeof scope === 'string' && identifier.test(scope) ? { scope } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof reason === 'string' && cacheReason.test(reason)
        ? { reason }
        : {}),
      tags: Object.freeze(
        (Array.isArray(tags) ? (tags as unknown[]) : [])
          .filter(
            (tag): tag is string =>
              typeof tag === 'string' && cacheName.test(tag),
          )
          .slice(0, 20),
      ),
      ...(removed === undefined ? {} : { removed }),
    });
    this.#cache.push(record);
    if (this.#cache.length > this.#capacity) this.#cache.shift();
    if (record.namespace === undefined) return;
    let totals = this.#cacheTotals.get(record.namespace);
    if (!totals) {
      // Namespaces come from code; the bound only guards against a runaway caller.
      if (this.#cacheTotals.size >= 200) return;
      totals = {
        hits: 0,
        misses: 0,
        stale: 0,
        coalesced: 0,
        bypassed: 0,
        errors: 0,
      };
      this.#cacheTotals.set(record.namespace, totals);
    }
    if (type === 'hit') totals.hits++;
    else if (type === 'miss') totals.misses++;
    else if (type === 'stale') totals.stale++;
    else if (type === 'coalesced') totals.coalesced++;
    else if (type === 'bypass') totals.bypassed++;
    else if (type.endsWith('-error')) totals.errors++;
  }
  /**
   * @nestvexa/inertia hook (its `inspector` option): one page response with
   * its resolved props, redacted like Live state (tokens, passwords,
   * cookies, sessions, CSRF, ...) and bounded.
   */
  page(input: InspectedPageInput): void {
    const component = own(input, 'component');
    if (typeof component !== 'string' || !pageName.test(component)) return;
    const props = own(input, 'props');
    const redacted: unknown =
      typeof props === 'object' && props !== null && !Array.isArray(props)
        ? redact(props)
        : {};
    const json = JSON.stringify(redacted) ?? '{}';
    const size = Buffer.byteLength(json);
    const status = own(input, 'status');
    const partial = own(input, 'partial');
    const deferred = own(input, 'deferred');
    const shared = own(input, 'shared');
    const requestId = currentRequestId();
    this.#pages.push(
      Object.freeze({
        at: Date.now(),
        ...(requestId === undefined ? {} : { requestId }),
        component,
        kind: own(input, 'kind') === 'json' ? 'json' : 'document',
        status:
          typeof status === 'number' &&
          Number.isInteger(status) &&
          status >= 100 &&
          status <= 599
            ? status
            : 200,
        propNames: names(Object.keys(Object(redacted))),
        propsBytes: size,
        props:
          size > this.#maxStateBytes
            ? { '[elided]': `${size} bytes` }
            : redacted,
        ...(Array.isArray(partial)
          ? { partial: names(partial as unknown[]) }
          : {}),
        deferred: names(
          typeof deferred === 'object' && deferred !== null
            ? Object.values(deferred).flatMap((group: unknown) =>
                Array.isArray(group) ? (group as unknown[]) : [],
              )
            : [],
        ),
        shared: names(Array.isArray(shared) ? (shared as unknown[]) : []),
      } satisfies InspectedPage),
    );
    if (this.#pages.length > this.#capacity) this.#pages.shift();
  }
  /**
   * Browser timings from `devtoolsReporter` (the DevtoolsModule `client`
   * endpoint calls this). Every field is checked against a closed shape and
   * anything else is dropped; returns how many timings were kept.
   */
  clientReport(entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    let kept = 0;
    for (const entry of (entries as unknown[]).slice(
      0,
      DEVTOOLS_CLIENT_BATCH_LIMIT,
    )) {
      const phase = own(entry, 'phase');
      const outcome = own(entry, 'outcome');
      const duration = milliseconds(own(entry, 'milliseconds'));
      if (
        (phase !== 'queue' && phase !== 'request' && phase !== 'morph') ||
        (outcome !== 'succeeded' &&
          outcome !== 'failed' &&
          outcome !== 'cancelled') ||
        duration === undefined
      )
        continue;
      const component = own(entry, 'component');
      const requestBytes = byteCount(own(entry, 'requestBytes'));
      const responseBytes = byteCount(own(entry, 'responseBytes'));
      const trace = own(entry, 'traceId');
      this.#client.push(
        Object.freeze({
          at: Date.now(),
          phase,
          outcome,
          milliseconds: duration,
          ...(typeof component === 'string' && componentName.test(component)
            ? { component }
            : {}),
          ...(requestBytes === undefined ? {} : { requestBytes }),
          ...(responseBytes === undefined ? {} : { responseBytes }),
          ...(typeof trace === 'string' && traceIdPattern.test(trace)
            ? { traceId: trace }
            : {}),
        }),
      );
      kept++;
      if (this.#client.length > this.#capacity * 3) this.#client.shift();
    }
    return kept;
  }
  get components(): readonly InspectedComponent[] {
    return this.#components;
  }
  /** Recent renders, newest first. */
  get renders(): readonly InspectedRender[] {
    return [...this.#renders].reverse();
  }
  /** Recent cache events, newest first. */
  get cacheEvents(): readonly InspectedCacheEvent[] {
    return [...this.#cache].reverse();
  }
  /** Hit and miss counts per cache namespace. */
  get cacheSummary(): readonly InspectedCacheSummary[] {
    return [...this.#cacheTotals].map(([namespace, totals]) => {
      const lookups =
        totals.hits + totals.misses + totals.stale + totals.coalesced;
      return Object.freeze({
        namespace,
        ...totals,
        hitRatio: lookups
          ? Math.round((totals.hits / lookups) * 1000) / 1000
          : 0,
      });
    });
  }
  /** Recent Inertia page responses, newest first. */
  get pages(): readonly InspectedPage[] {
    return [...this.#pages].reverse();
  }
  /** Recent browser timings, newest first. */
  get clientTimings(): readonly InspectedClientTiming[] {
    return [...this.#client].reverse();
  }
  /** Live requests per component with their sizes (browser `request` timings). */
  get network(): readonly InspectedNetworkSummary[] {
    const groups = new Map<string, InspectedClientTiming[]>();
    for (const timing of this.#client)
      if (timing.phase === 'request') {
        const key = timing.component ?? '(unnamed)';
        const group = groups.get(key) ?? [];
        group.push(timing);
        groups.set(key, group);
      }
    return [...groups].map(([component, group]) =>
      Object.freeze({
        component,
        requests: group.length,
        failed: group.filter((timing) => timing.outcome !== 'succeeded').length,
        requestBytes: group.reduce(
          (total, timing) => total + (timing.requestBytes ?? 0),
          0,
        ),
        responseBytes: group.reduce(
          (total, timing) => total + (timing.responseBytes ?? 0),
          0,
        ),
        averageMs:
          Math.round(
            (group.reduce((total, timing) => total + timing.milliseconds, 0) /
              group.length) *
              10,
          ) / 10,
        maxMs: Math.max(...group.map((timing) => timing.milliseconds)),
      }),
    );
  }
  /** Browser DOM morph timing per component (succeeded `morph` timings). */
  get morphs(): readonly InspectedMorphSummary[] {
    const groups = new Map<string, number[]>();
    for (const timing of this.#client)
      if (timing.phase === 'morph' && timing.outcome === 'succeeded') {
        const key = timing.component ?? '(unnamed)';
        const group = groups.get(key) ?? [];
        group.push(timing.milliseconds);
        groups.set(key, group);
      }
    return [...groups].map(([component, group]) => {
      const sorted = [...group].sort((a, b) => a - b);
      return Object.freeze({
        component,
        morphs: sorted.length,
        p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
        max: sorted.at(-1) ?? 0,
      });
    });
  }
  clear(): void {
    this.#renders.length = 0;
    this.#cache.length = 0;
    this.#cacheTotals.clear();
    this.#pages.length = 0;
    this.#client.length = 0;
  }
}

/** Field → message pairs of a form error bag (`errors: { email: 'Invalid' }`). */
function validationErrors(
  state: unknown,
): readonly { readonly field: string; readonly message: string }[] {
  const errors: unknown =
    typeof state === 'object' && state !== null
      ? Reflect.get(state, 'errors')
      : undefined;
  if (typeof errors !== 'object' || errors === null || Array.isArray(errors))
    return [];
  return Object.freeze(
    Object.entries(errors)
      .filter(([, message]) => message !== undefined && message !== null)
      .slice(0, 50)
      .map(([field, message]) =>
        Object.freeze({
          field: field.slice(0, 100),
          message: text(Array.isArray(message) ? message[0] : message, 300),
        }),
      ),
  );
}
