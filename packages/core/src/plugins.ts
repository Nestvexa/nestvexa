import { NestvexaError } from './errors.js';
import { defineExtension } from './extensions.js';
import type { NestvexaExtension } from './extensions.js';
import type { FeatureCapability } from './registry.js';
import {
  NESTVEXA_VERSION,
  assertVersionRange,
  isSemanticVersion,
  satisfiesVersion,
} from './version.js';

export { satisfiesVersion } from './version.js';

/**
 * Legacy plugin contract (master plan 16.5 and 20.4), kept as a thin adapter
 * over the one public extension model, `NestvexaExtension`: a plugin is an
 * object the application imports and installs explicitly. Nothing here
 * resolves package names, paths or URLs, downloads or evaluates code; a
 * plugin whose declared framework range excludes the running version is
 * rejected. New code should define an extension (`defineExtension`) and pass
 * it to `CoreModule.forRoot(options, { extensions })`; `pluginExtension`
 * converts an existing plugin.
 */
export const PLUGIN_CAPABILITIES = [
  'view-engine',
  'state-synthesizer',
  'action-policy',
  'storage',
  'cache',
  'realtime-transport',
  'island-renderer',
  'cli-generator',
  'instrumentation',
  'ui-kit',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface NestvexaPluginManifest {
  /** npm-style name: `name` or `@scope/name`. */
  readonly name: string;
  /** Plugin version (semver). */
  readonly version: string;
  /** Supported Nestvexa range, for example `^0.1.0` or `>=0.1.0 <1.0.0`. */
  readonly nestvexa: string;
  readonly capabilities: readonly PluginCapability[];
  readonly description?: string;
}
export interface NestvexaPlugin {
  readonly manifest: NestvexaPluginManifest;
  /** Optional synchronous registration hook, run once at install. */
  readonly setup?: (context: PluginSetupContext) => void;
}
export interface PluginSetupContext {
  readonly frameworkVersion: string;
  /** Capabilities already provided by previously installed plugins. */
  readonly provided: ReadonlySet<PluginCapability>;
}

const packageName =
  /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
function own(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
/**
 * Validate a manifest (for example the `nestvexa` field of a plugin's
 * package.json). Only own data properties are read; unknown keys are rejected.
 */
export function parsePluginManifest(input: unknown): NestvexaPluginManifest {
  const fail: (reason: string) => never = (reason) => {
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      `Invalid plugin manifest: ${reason}`,
    );
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return fail('expected an object');
  const allowed = [
    'name',
    'version',
    'nestvexa',
    'capabilities',
    'description',
  ];
  for (const key of Reflect.ownKeys(input))
    if (typeof key !== 'string' || !allowed.includes(key)) fail('unknown key');
  const name = own(input, 'name');
  const pluginVersion = own(input, 'version');
  const range = own(input, 'nestvexa');
  const capabilities = own(input, 'capabilities');
  const description = own(input, 'description');
  if (typeof name !== 'string' || !packageName.test(name)) fail('name');
  if (!isSemanticVersion(pluginVersion)) fail('version');
  if (typeof range !== 'string') fail('nestvexa range');
  assertVersionRange(range);
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > PLUGIN_CAPABILITIES.length ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (entry: unknown) =>
        !PLUGIN_CAPABILITIES.some((capability) => capability === entry),
    )
  )
    fail('capabilities');
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > 512)
  )
    fail('description');
  return Object.freeze({
    name,
    version: pluginVersion,
    nestvexa: range,
    capabilities: Object.freeze([...(capabilities as PluginCapability[])]),
    ...(description === undefined ? {} : { description }),
  });
}

/** Validate and freeze a plugin definition. @deprecated Use `defineExtension`. */
export function definePlugin(plugin: NestvexaPlugin): NestvexaPlugin {
  if (plugin === null || typeof plugin !== 'object')
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'A plugin must be an object',
    );
  const setup = own(plugin, 'setup');
  if (setup !== undefined && typeof setup !== 'function')
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Plugin setup must be a function',
    );
  return Object.freeze({
    manifest: parsePluginManifest(own(plugin, 'manifest')),
    ...(typeof setup === 'function'
      ? {
          setup: (context: PluginSetupContext): void => {
            Reflect.apply(setup, plugin, [context]);
          },
        }
      : {}),
  });
}

/** Capability names a converted plugin declares: `<capability>:<extension name>`. */
function capabilityName(capability: PluginCapability, owner: string): string {
  return `${capability}:${owner}`;
}
/** `@scope/name` → `scope.name`; other npm names are kept when they are valid extension names. */
function extensionName(packageName: string): string {
  const name = packageName.startsWith('@')
    ? packageName.slice(1).replace('/', '.')
    : packageName;
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name))
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      `Plugin ${packageName} has no valid extension name; pass { name }`,
    );
  return name;
}
function provided(
  names: readonly string[],
  owner: string,
): ReadonlySet<PluginCapability> {
  const result = new Set<PluginCapability>();
  for (const name of names)
    for (const capability of PLUGIN_CAPABILITIES)
      if (
        name.startsWith(`${capability}:`) &&
        name !== capabilityName(capability, owner)
      )
        result.add(capability);
  return result;
}

/**
 * Convert a legacy plugin into a `NestvexaExtension` (the migration path):
 * the extension keeps the plugin's version and `nestvexa` range (checked at
 * startup), declares each manifest capability as `<capability>:<name>`, and
 * runs `setup` from its `register` hook with the capabilities other
 * extensions declared. `@scope/name` becomes the extension name
 * `scope.name` unless `options.name` is given.
 */
export function pluginExtension(
  plugin: NestvexaPlugin,
  options: { readonly name?: string } = {},
): NestvexaExtension {
  const defined = definePlugin(plugin);
  return convert(defined, options.name, true);
}
function convert(
  plugin: NestvexaPlugin,
  name: string | undefined,
  runSetup: boolean,
): NestvexaExtension {
  const { manifest, setup } = plugin;
  const owner = name ?? extensionName(manifest.name);
  const capabilities: Record<string, FeatureCapability> = {};
  for (const capability of manifest.capabilities)
    capabilities[capabilityName(capability, owner)] = { supported: true };
  return defineExtension({
    name: owner,
    version: manifest.version,
    nestvexa: manifest.nestvexa,
    capabilities,
    ...(runSetup && setup
      ? {
          register: (context) => {
            setup({
              frameworkVersion: NESTVEXA_VERSION,
              provided: provided(context.capabilities.names(), owner),
            });
          },
        }
      : {}),
  });
}

/**
 * Explicit, trusted installation only. Install plugins at startup from
 * modules you imported yourself, then `seal()` before serving requests.
 *
 * @deprecated Kept for existing callers as an adapter over the extension
 * model: pass `registry.extensions()` (or `pluginExtension(plugin)` for each
 * plugin) to `CoreModule.forRoot(options, { extensions })` so plugins join
 * the capability, security and diagnostics registries.
 */
export class PluginRegistry {
  readonly #plugins = new Map<string, NestvexaPlugin>();
  readonly #frameworkVersion: string;
  #sealed = false;
  constructor(options: { readonly frameworkVersion?: string } = {}) {
    const frameworkVersion = options.frameworkVersion ?? NESTVEXA_VERSION;
    if (!isSemanticVersion(frameworkVersion))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid framework version',
      );
    this.#frameworkVersion = frameworkVersion;
  }
  install(input: NestvexaPlugin): NestvexaPlugin {
    if (this.#sealed)
      throw new NestvexaError('REGISTRY_SEALED', 'Plugin registry is sealed');
    // Strings are rejected on purpose: names and URLs never become imports.
    if (typeof input !== 'object' || input === null)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Install a plugin object you imported explicitly',
      );
    const plugin = definePlugin(input);
    const { name, nestvexa } = plugin.manifest;
    if (this.#plugins.has(name))
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Duplicate plugin ${name}`,
      );
    if (!satisfiesVersion(this.#frameworkVersion, nestvexa))
      throw new NestvexaError(
        'UNSUPPORTED_CAPABILITY',
        `Plugin ${name} supports Nestvexa ${nestvexa}, not ${this.#frameworkVersion}`,
      );
    const provided = new Set(
      [...this.#plugins.values()].flatMap(
        (entry) => entry.manifest.capabilities,
      ),
    );
    plugin.setup?.({ frameworkVersion: this.#frameworkVersion, provided });
    this.#plugins.set(name, plugin);
    return plugin;
  }
  has(name: string): boolean {
    return this.#plugins.has(name);
  }
  list(): readonly NestvexaPluginManifest[] {
    return Object.freeze(
      [...this.#plugins.values()].map((plugin) => plugin.manifest),
    );
  }
  withCapability(
    capability: PluginCapability,
  ): readonly NestvexaPluginManifest[] {
    return this.list().filter((manifest) =>
      manifest.capabilities.includes(capability),
    );
  }
  /**
   * The installed plugins as extensions, in installation order. `setup`
   * already ran at `install`, so the extensions do not run it again.
   */
  extensions(): readonly NestvexaExtension[] {
    return Object.freeze(
      [...this.#plugins.values()].map((plugin) =>
        convert(plugin, undefined, false),
      ),
    );
  }
  seal(): void {
    this.#sealed = true;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
}
