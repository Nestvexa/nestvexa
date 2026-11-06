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
  readonly cause: 'mount' | 'action' | 'sync';
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
  readonly cause: 'mount' | 'action' | 'sync';
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
export class DevtoolsInspector {
  readonly #renders: InspectedRender[] = [];
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
          input.cause === 'action' || input.cause === 'sync'
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
  get components(): readonly InspectedComponent[] {
    return this.#components;
  }
  /** Recent renders, newest first. */
  get renders(): readonly InspectedRender[] {
    return [...this.#renders].reverse();
  }
  clear(): void {
    this.#renders.length = 0;
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
