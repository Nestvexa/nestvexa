import { NestvexaError } from './errors.js';

/**
 * Minimal plugin contract (master plan 16.5 and 20.4): a plugin is an object
 * the application imports and installs explicitly. The registry never
 * resolves package names, paths or URLs, never downloads or evaluates code,
 * and rejects plugins whose declared framework range does not include the
 * running version.
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
const semverPattern =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}
function version(value: string): Version | undefined {
  const match = semverPattern.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}
function compare(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  // A prerelease sorts before its release (semver 11).
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return b.prerelease.length - a.prerelease.length;
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index++
  ) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    if (numeric) return Number(left) < Number(right) ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
type Comparator = (candidate: Version) => boolean;
function comparator(token: string): Comparator[] {
  const operator = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  const base = operator?.[2] ? version(operator[2]) : undefined;
  if (!operator || !base)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
  const op = operator[1] ?? '=';
  const at = (major: number, minor: number, patch: number): Version => ({
    major,
    minor,
    patch,
    prerelease: ['0'],
  });
  const gte: Comparator = (v) => compare(v, base) >= 0;
  switch (op) {
    case '^': {
      const upper =
        base.major > 0
          ? at(base.major + 1, 0, 0)
          : base.minor > 0
            ? at(0, base.minor + 1, 0)
            : at(0, 0, base.patch + 1);
      return [gte, (v) => compare(v, upper) < 0];
    }
    case '~': {
      const upper = at(base.major, base.minor + 1, 0);
      return [gte, (v) => compare(v, upper) < 0];
    }
    case '>=':
      return [gte];
    case '>':
      return [(v) => compare(v, base) > 0];
    case '<=':
      return [(v) => compare(v, base) <= 0];
    case '<':
      return [(v) => compare(v, base) < 0];
    default:
      return [(v) => compare(v, base) === 0];
  }
}
/**
 * Whether `candidate` satisfies `range` (`||` alternatives of space-separated
 * comparators: `=`, `>`, `>=`, `<`, `<=`, `^`, `~`). Prereleases are compared
 * by semver precedence, so `^0.1.0-alpha.0` accepts `0.1.0-alpha.3`.
 */
export function satisfiesVersion(candidate: string, range: string): boolean {
  const parsed = version(candidate);
  if (!parsed)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version');
  if (typeof range !== 'string' || range.length === 0 || range.length > 256)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
  // Parse every alternative first so a malformed tail is never skipped.
  const alternatives = range.split('||').map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
      throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid version range');
    return tokens.flatMap(comparator);
  });
  return alternatives.some((tests) => tests.every((test) => test(parsed)));
}

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
  if (typeof pluginVersion !== 'string' || !version(pluginVersion))
    fail('version');
  if (typeof range !== 'string') fail('nestvexa range');
  satisfiesVersion('0.0.0', range);
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

/** Validate and freeze a plugin definition. */
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

/**
 * Explicit, trusted installation only. Install plugins at startup from
 * modules you imported yourself, then `seal()` before serving requests.
 */
export class PluginRegistry {
  readonly #plugins = new Map<string, NestvexaPlugin>();
  readonly #frameworkVersion: string;
  #sealed = false;
  constructor(options: { readonly frameworkVersion: string }) {
    if (!version(options.frameworkVersion))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Invalid framework version',
      );
    this.#frameworkVersion = options.frameworkVersion;
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
  seal(): void {
    this.#sealed = true;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
}
