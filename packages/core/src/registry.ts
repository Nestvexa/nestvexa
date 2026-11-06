import { Injectable } from '@nestjs/common';
import { NestvexaError } from './errors.js';

/** Explicit registration only: browser input must never become a class/import path. */
export class CollisionSafeRegistry<T> {
  readonly #entries = new Map<string, T>();
  #sealed = false;

  register(name: string, value: T): void {
    if (this.#sealed)
      throw new NestvexaError('REGISTRY_SEALED', 'Registry is sealed');
    if (
      !/^[a-z][a-z0-9:._-]{0,127}$/.test(name) ||
      ['constructor', 'prototype', '__proto__'].includes(name)
    ) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid registration identifier',
      );
    }
    if (this.#entries.has(name))
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Duplicate registration: ${name}`,
      );
    this.#entries.set(name, value);
  }

  get(name: string): T {
    if (!this.#entries.has(name))
      throw new NestvexaError('UNKNOWN_REGISTRATION', 'Unknown registration');
    // Map.has proves registration even when T itself includes undefined.
    return this.#entries.get(name) as T;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }
  names(): readonly string[] {
    return Object.freeze([...this.#entries.keys()]);
  }
  seal(): void {
    this.#sealed = true;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
}

/**
 * Adapter-declared support. `degraded` marks a supported feature that works with a
 * documented limitation (for example a fallback transport); it still satisfies
 * `require()` and is reported by `report()` for diagnostics.
 */
export type FeatureCapability =
  | { readonly supported: true; readonly degraded?: string }
  | { readonly supported: false; readonly reason: string };

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Capabilities are adapter-provided facts, never guessed from installed packages. */
@Injectable()
export class FeatureCapabilityRegistry {
  readonly #registry = new CollisionSafeRegistry<FeatureCapability>();

  register(name: string, capability: FeatureCapability): void {
    if (
      typeof capability !== 'object' ||
      capability === null ||
      (capability.supported !== true && capability.supported !== false)
    ) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Capability must declare support',
      );
    }
    if (!capability.supported && !text(capability.reason)) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Unsupported capability requires a reason',
      );
    }
    if (
      capability.supported &&
      capability.degraded !== undefined &&
      !text(capability.degraded)
    ) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Degraded capability requires a description',
      );
    }
    // Copy only declared fields: adapter objects never leak extra properties.
    this.#registry.register(
      name,
      Object.freeze(
        capability.supported
          ? {
              supported: true as const,
              ...(capability.degraded === undefined
                ? {}
                : { degraded: capability.degraded }),
            }
          : { supported: false as const, reason: capability.reason },
      ),
    );
  }

  get(name: string): FeatureCapability {
    return this.#registry.get(name);
  }
  has(name: string): boolean {
    return this.#registry.has(name);
  }
  names(): readonly string[] {
    return this.#registry.names();
  }
  seal(): void {
    this.#registry.seal();
  }
  require(name: string): void {
    const capability = this.get(name);
    if (!capability.supported)
      throw new NestvexaError(
        'UNSUPPORTED_CAPABILITY',
        `${name}: ${capability.reason}`,
      );
  }
  /** Frozen name → declaration snapshot for diagnostics, devtools and startup logs. */
  report(): Readonly<Record<string, FeatureCapability>> {
    const result = Object.create(null) as Record<string, FeatureCapability>;
    for (const name of this.names()) result[name] = this.get(name);
    return Object.freeze(result);
  }
}
