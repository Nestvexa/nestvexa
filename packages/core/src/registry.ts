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

export type FeatureCapability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/** Capabilities are adapter-provided facts, never guessed from installed packages. */
@Injectable()
export class FeatureCapabilityRegistry {
  readonly #registry = new CollisionSafeRegistry<FeatureCapability>();

  register(name: string, capability: FeatureCapability): void {
    if (capability.supported !== true && capability.supported !== false) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Capability must declare support',
      );
    }
    if (
      !capability.supported &&
      (typeof capability.reason !== 'string' || !capability.reason.trim())
    ) {
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Unsupported capability requires a reason',
      );
    }
    this.#registry.register(name, Object.freeze({ ...capability }));
  }

  get(name: string): FeatureCapability {
    return this.#registry.get(name);
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
}
