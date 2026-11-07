import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { RequestContextFactory } from './context.js';
import type { RequestContextContributor } from './context.js';
import { DiagnosticsRegistry } from './diagnostics.js';
import { NestvexaError } from './errors.js';
import { FeatureCapabilityRegistry } from './registry.js';
import type { FeatureCapability } from './registry.js';
import { SecurityPolicyRegistry } from './security.js';
import {
  NESTVEXA_VERSION,
  assertVersionRange,
  isSemanticVersion,
  satisfiesVersion,
} from './version.js';

/** Registries an extension may use while it registers (startup only). */
export interface NestvexaExtensionContext {
  readonly capabilities: FeatureCapabilityRegistry;
  readonly security: SecurityPolicyRegistry;
  readonly diagnostics: DiagnosticsRegistry;
}

/**
 * The public extension model (CORE-034); the legacy `PluginRegistry` is a
 * deprecated adapter over it (`pluginExtension`). Every hook is optional and
 * runs in a defined order:
 *
 * 0. `nestvexa` (a version range) is checked against `NESTVEXA_VERSION` when
 *    the extension host is created; an excluded version fails startup;
 * 1. `capabilities` are declared in the capability registry (explicit flags,
 *    never inferred from installed packages);
 * 2. `register(context)` runs once at module init, in installation order;
 * 3. `contributeContext(request)` adds primitive fields to each request
 *    context under `context.extensions[name]`;
 * 4. `shutdown()` runs once on application shutdown, in reverse order.
 *
 * After all extensions registered, the capability and security registries
 * are sealed, so nothing changes policy while serving requests.
 */
export interface NestvexaExtension {
  /** Unique lowercase name (`a-z0-9._-`, up to 64 characters). */
  readonly name: string;
  /** The extension's own semantic version, reported for diagnostics. */
  readonly version?: string;
  /** Supported Nestvexa range, for example `^0.1.0`; checked at startup. */
  readonly nestvexa?: string;
  readonly capabilities?: Readonly<Record<string, FeatureCapability>>;
  register?(context: NestvexaExtensionContext): void | Promise<void>;
  contributeContext?: RequestContextContributor;
  shutdown?(): void | Promise<void>;
}
export const NESTVEXA_EXTENSIONS = Symbol('NESTVEXA_EXTENSIONS');

const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const hooks = ['register', 'contributeContext', 'shutdown'] as const;

/** Validate and freeze an extension definition. */
export function defineExtension(
  extension: NestvexaExtension,
): NestvexaExtension {
  if (typeof extension !== 'object' || extension === null)
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'An extension must be an object',
    );
  for (const key of Reflect.ownKeys(extension))
    if (
      typeof key !== 'string' ||
      !['name', 'version', 'nestvexa', 'capabilities', ...hooks].includes(key)
    )
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Extensions accept only name, version, nestvexa, capabilities and the documented hooks',
      );
  if (typeof extension.name !== 'string' || !namePattern.test(extension.name))
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid extension name');
  if (extension.version !== undefined && !isSemanticVersion(extension.version))
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      `Extension ${extension.name} version must be a semantic version`,
    );
  if (extension.nestvexa !== undefined) assertVersionRange(extension.nestvexa);
  for (const hook of hooks)
    if (extension[hook] !== undefined && typeof extension[hook] !== 'function')
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        `Extension hook ${hook} must be a function`,
      );
  if (
    extension.capabilities !== undefined &&
    (typeof extension.capabilities !== 'object' ||
      extension.capabilities === null ||
      Array.isArray(extension.capabilities))
  )
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Extension capabilities must be a name → declaration map',
    );
  return Object.freeze({ ...extension });
}

/** Installs configured extensions into the core registries. */
@Injectable()
export class NestvexaExtensionHost
  implements OnModuleInit, OnApplicationShutdown
{
  readonly #extensions: readonly NestvexaExtension[];
  #installed: NestvexaExtension[] = [];
  constructor(
    @Inject(FeatureCapabilityRegistry)
    private readonly capabilities: FeatureCapabilityRegistry,
    @Inject(SecurityPolicyRegistry)
    private readonly security: SecurityPolicyRegistry,
    @Inject(DiagnosticsRegistry)
    private readonly diagnostics: DiagnosticsRegistry,
    @Inject(RequestContextFactory)
    private readonly context: RequestContextFactory,
    @Optional()
    @Inject(NESTVEXA_EXTENSIONS)
    extensions: readonly NestvexaExtension[] | null = null,
  ) {
    const list = (extensions ?? []).map(defineExtension);
    const names = new Set<string>();
    for (const extension of list) {
      if (names.has(extension.name))
        throw new NestvexaError(
          'DUPLICATE_REGISTRATION',
          `Duplicate extension ${extension.name}`,
        );
      names.add(extension.name);
      if (
        extension.nestvexa !== undefined &&
        !satisfiesVersion(NESTVEXA_VERSION, extension.nestvexa)
      )
        throw new NestvexaError(
          'UNSUPPORTED_CAPABILITY',
          `Extension ${extension.name} supports Nestvexa ${extension.nestvexa}, not ${NESTVEXA_VERSION}`,
        );
    }
    this.#extensions = Object.freeze(list);
  }

  /** Names of installed extensions, in order. */
  names(): readonly string[] {
    return Object.freeze(this.#installed.map((extension) => extension.name));
  }

  async onModuleInit(): Promise<void> {
    const context: NestvexaExtensionContext = Object.freeze({
      capabilities: this.capabilities,
      security: this.security,
      diagnostics: this.diagnostics,
    });
    for (const extension of this.#extensions) {
      for (const [name, capability] of Object.entries(
        extension.capabilities ?? {},
      ))
        this.capabilities.register(name, capability);
      await extension.register?.(context);
      if (extension.contributeContext)
        this.context.contribute(extension.name, extension.contributeContext);
      this.#installed.push(extension);
      this.diagnostics.event('nestvexa.extension.installed', {
        extension: extension.name,
      });
    }
    if (this.#extensions.length) {
      this.capabilities.seal();
      this.security.seal();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const extension of [...this.#installed].reverse())
      try {
        await extension.shutdown?.();
      } catch {
        // One extension's cleanup failure never blocks the others.
        this.diagnostics.event('nestvexa.extension.shutdown_failed', {
          extension: extension.name,
        });
      }
    this.#installed = [];
  }
}
