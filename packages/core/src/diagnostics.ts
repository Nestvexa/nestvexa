import { Inject, Injectable, Optional } from '@nestjs/common';
import { NestvexaError } from './errors.js';
import { createRedactor, REDACTED } from './redaction.js';
import type { RedactionOptions } from './redaction.js';

/** Primitive attributes only: no objects, so state, HTML or requests cannot leak in. */
export type DiagnosticAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export type DiagnosticOutcome = 'ok' | 'error';
export type DiagnosticRecord =
  | {
      readonly kind: 'event';
      readonly name: string;
      readonly at: number;
      readonly attributes: DiagnosticAttributes;
    }
  | {
      readonly kind: 'metric';
      readonly name: string;
      readonly at: number;
      readonly value: number;
      readonly attributes: DiagnosticAttributes;
    }
  | {
      readonly kind: 'span';
      readonly name: string;
      readonly at: number;
      readonly durationMs: number;
      readonly outcome: DiagnosticOutcome;
      readonly attributes: DiagnosticAttributes;
    };
export type DiagnosticKind = DiagnosticRecord['kind'];
export type DiagnosticListener = (record: DiagnosticRecord) => void;
/** A documented diagnostic name, for devtools catalogs and typo detection. */
export interface DiagnosticDefinition {
  readonly name: string;
  readonly kind: DiagnosticKind;
  readonly description: string;
}
export interface DiagnosticSpan {
  end(outcome: DiagnosticOutcome, attributes?: DiagnosticAttributes): void;
}
export interface DiagnosticsOptions {
  /** Records kept for `recent()` (default 256, 0 disables the buffer). */
  readonly bufferSize?: number;
  /** Reject records whose name was not `define()`d (default false). */
  readonly strict?: boolean;
  /** Extra sensitive attribute key fragments. */
  readonly redaction?: RedactionOptions;
  readonly now?: () => number;
}
export const NESTVEXA_DIAGNOSTICS_OPTIONS = Symbol(
  'NESTVEXA_DIAGNOSTICS_OPTIONS',
);

const namePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const maxAttributes = 32;
const maxStringLength = 256;
const maxListeners = 64;

/**
 * Typed events, metrics and spans for tests, devtools and exporters
 * (master plan 5.2). Attributes are primitives, bounded and redacted by key;
 * listeners are isolated (a throwing listener never breaks the caller or other
 * listeners). `instrumentation()` adapts it to the Live `instrumentation`
 * hook without Live importing core.
 */
@Injectable()
export class DiagnosticsRegistry {
  readonly #definitions = new Map<string, DiagnosticDefinition>();
  readonly #listeners = new Set<DiagnosticListener>();
  readonly #buffer: DiagnosticRecord[] = [];
  readonly #size: number;
  readonly #strict: boolean;
  readonly #now: () => number;
  readonly #redactor: ReturnType<typeof createRedactor>;
  constructor(
    @Optional()
    @Inject(NESTVEXA_DIAGNOSTICS_OPTIONS)
    options: DiagnosticsOptions | null = null,
  ) {
    const selected = options ?? {};
    const size = selected.bufferSize ?? 256;
    if (!Number.isSafeInteger(size) || size < 0 || size > 100_000)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid diagnostics buffer size',
      );
    this.#size = size;
    this.#strict = selected.strict === true;
    this.#now = selected.now ?? Date.now;
    this.#redactor = createRedactor(selected.redaction);
  }

  define(definition: DiagnosticDefinition): void {
    if (
      !definition ||
      !namePattern.test(definition.name) ||
      !['event', 'metric', 'span'].includes(definition.kind) ||
      typeof definition.description !== 'string' ||
      !definition.description.trim()
    )
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid diagnostic definition',
      );
    const prior = this.#definitions.get(definition.name);
    if (prior && prior.kind !== definition.kind)
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Diagnostic ${definition.name} is already defined as a ${prior.kind}`,
      );
    this.#definitions.set(
      definition.name,
      Object.freeze({
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
      }),
    );
  }
  /** Frozen catalog of defined diagnostics. */
  definitions(): readonly DiagnosticDefinition[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  event(name: string, attributes?: DiagnosticAttributes): void {
    this.#emit({
      kind: 'event',
      name: this.#name(name, 'event'),
      at: this.#now(),
      attributes: this.#attributes(attributes),
    });
  }
  metric(name: string, value: number, attributes?: DiagnosticAttributes): void {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Diagnostic metric values must be finite numbers',
      );
    this.#emit({
      kind: 'metric',
      name: this.#name(name, 'metric'),
      at: this.#now(),
      value,
      attributes: this.#attributes(attributes),
    });
  }
  span(name: string, attributes?: DiagnosticAttributes): DiagnosticSpan {
    const checked = this.#name(name, 'span');
    const start = this.#now();
    const initial = this.#attributes(attributes);
    let ended = false;
    return {
      end: (outcome, extra) => {
        if (ended) return;
        ended = true;
        this.#emit({
          kind: 'span',
          name: checked,
          at: start,
          durationMs: Math.max(0, this.#now() - start),
          outcome: outcome === 'error' ? 'error' : 'ok',
          attributes: this.#attributes({ ...initial, ...extra }),
        });
      },
    };
  }
  subscribe(listener: DiagnosticListener): () => void {
    if (typeof listener !== 'function')
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Diagnostic listener must be a function',
      );
    if (this.#listeners.size >= maxListeners)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Too many diagnostic listeners',
      );
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  /** Buffered records, oldest first, optionally filtered by name prefix or kind. */
  recent(
    filter: { readonly prefix?: string; readonly kind?: DiagnosticKind } = {},
  ): readonly DiagnosticRecord[] {
    return Object.freeze(
      this.#buffer.filter(
        (record) =>
          (filter.prefix === undefined ||
            record.name.startsWith(filter.prefix)) &&
          (filter.kind === undefined || record.kind === filter.kind),
      ),
    );
  }
  clear(): void {
    this.#buffer.length = 0;
  }
  /**
   * Structural adapter for `LiveHostOptions.instrumentation` (and any hook of
   * the same shape): each started span becomes a diagnostics span.
   */
  instrumentation(): {
    start(name: string, attributes: DiagnosticAttributes): DiagnosticSpan;
  } {
    return {
      start: (name, attributes) => this.span(name, attributes),
    };
  }

  #name(name: string, kind: DiagnosticKind): string {
    if (typeof name !== 'string' || !namePattern.test(name))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid diagnostic name',
      );
    const definition = this.#definitions.get(name);
    if (definition && definition.kind !== kind)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        `Diagnostic ${name} is a ${definition.kind}`,
      );
    if (!definition && this.#strict)
      throw new NestvexaError(
        'UNKNOWN_REGISTRATION',
        `Undefined diagnostic ${name}`,
      );
    return name;
  }
  #attributes(input: DiagnosticAttributes | undefined): DiagnosticAttributes {
    const result = Object.create(null) as Record<
      string,
      string | number | boolean
    >;
    if (input === undefined) return Object.freeze(result);
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Diagnostic attributes must be an object',
      );
    let count = 0;
    for (const key of Object.keys(input)) {
      if (++count > maxAttributes) break;
      if (!keyPattern.test(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      const value: unknown = descriptor?.value;
      if (this.#redactor.sensitive(key)) result[key] = REDACTED;
      else if (typeof value === 'string')
        result[key] = this.#redactor.text(value).slice(0, maxStringLength);
      else if (typeof value === 'boolean') result[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value))
        result[key] = value;
      // Objects, functions and non-finite numbers are dropped.
    }
    return Object.freeze(result);
  }
  #emit(record: DiagnosticRecord): void {
    const frozen = Object.freeze(record);
    if (this.#size) {
      this.#buffer.push(frozen);
      if (this.#buffer.length > this.#size) this.#buffer.shift();
    }
    for (const listener of [...this.#listeners])
      try {
        listener(frozen);
      } catch {
        // Diagnostics never change application behavior.
      }
  }
}
