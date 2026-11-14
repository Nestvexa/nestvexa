import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { NestvexaError } from './errors.js';
import { NestvexaExtensionHost } from './extensions.js';
import { FeatureCapabilityRegistry } from './registry.js';
import type { FeatureCapability } from './registry.js';
import { isSemanticVersion } from './version.js';

/**
 * What an installed feature package declares about itself (master plan 5.2
 * `NestvexaRegistry`). Feature packages register one entry each at startup
 * through a structural `featureRegistry` option, so core never imports them.
 * Every field is data: names, never classes, functions or state.
 */
export interface NestvexaFeature {
  /** Unique lowercase name, usually the package's policy owner (`live`, `actions`). */
  readonly name: string;
  /** The package that provides the feature, for example `@nestvexa/live`. */
  readonly package: string;
  /** The package's semantic version, when it reports one. */
  readonly version?: string;
  /** Registered Live components by stable name. */
  readonly components?: readonly string[];
  /** Registered safe server actions (`group/action`, versioned as `group/action/v2`). */
  readonly actions?: readonly string[];
  /** Views the feature renders (template names). */
  readonly views?: readonly string[];
  /** Renderer adapters the feature provides or uses (`hbs`, `react`). */
  readonly renderers?: readonly string[];
  /**
   * Explicit runtime capabilities. Each is also declared in
   * `FeatureCapabilityRegistry` as `<name>.<capability>`, so `require()` and
   * diagnostics see one source.
   */
  readonly capabilities?: Readonly<Record<string, FeatureCapability>>;
}

/** One frozen registry entry; `capabilities` holds the qualified names. */
export interface NestvexaFeatureReport {
  readonly name: string;
  readonly package: string;
  readonly version?: string;
  readonly components: readonly string[];
  readonly actions: readonly string[];
  readonly views: readonly string[];
  readonly renderers: readonly string[];
  readonly capabilities: Readonly<Record<string, FeatureCapability>>;
}
/** Installed extensions (plugins) as the registry lists them. */
export interface NestvexaPluginReport {
  readonly name: string;
  readonly version?: string;
}
/** Data-only snapshot for diagnostics and devtools. */
export interface NestvexaRegistryReport {
  readonly features: readonly NestvexaFeatureReport[];
  readonly plugins: readonly NestvexaPluginReport[];
}

const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const packagePattern =
  /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const entryPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const capabilityPattern = /^[a-z][a-z0-9._-]{0,62}$/;
const keys = [
  'name',
  'package',
  'version',
  'components',
  'actions',
  'views',
  'renderers',
  'capabilities',
];

function invalid(message: string): never {
  throw new NestvexaError('INVALID_CONFIGURATION', message);
}
function list(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 10_000)
    invalid(`Feature ${field} must be a list of names`);
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !entryPattern.test(entry))
      invalid(`Feature ${field} entries must be names`);
    if (seen.has(entry)) invalid(`Duplicate feature ${field} entry ${entry}`);
    seen.add(entry);
  }
  return Object.freeze([...seen].sort());
}

/**
 * `NestvexaRegistry` (CORE-039): the inspectable list of what is installed —
 * feature packages with their components, safe actions, views, renderer
 * adapters and capabilities, plus installed extensions (plugins). Entries are
 * explicit registrations (never discovered from `node_modules`), validated,
 * frozen and unique by name; the registry seals itself once the application
 * has bootstrapped. Feature capabilities land in `FeatureCapabilityRegistry`
 * too, so diagnostics, devtools and `require()` read the same declarations.
 */
@Injectable()
export class NestvexaRegistry implements OnApplicationBootstrap {
  readonly #features = new Map<string, NestvexaFeatureReport>();
  #sealed = false;
  constructor(
    @Inject(FeatureCapabilityRegistry)
    private readonly capabilities: FeatureCapabilityRegistry,
    @Optional()
    @Inject(NestvexaExtensionHost)
    private readonly extensions: NestvexaExtensionHost | null = null,
  ) {}

  /** Register one feature (startup only); a duplicate name fails startup. */
  registerFeature(feature: NestvexaFeature): void {
    if (this.#sealed)
      throw new NestvexaError('REGISTRY_SEALED', 'Nestvexa registry is sealed');
    if (typeof feature !== 'object' || feature === null)
      invalid('A feature must be an object');
    for (const key of Reflect.ownKeys(feature))
      if (typeof key !== 'string' || !keys.includes(key))
        invalid(`Unknown feature field ${String(key)}`);
    const { name, version } = feature;
    if (typeof name !== 'string' || !namePattern.test(name))
      invalid('Invalid feature name');
    if (
      typeof feature.package !== 'string' ||
      !packagePattern.test(feature.package)
    )
      invalid(`Feature ${name} needs a package name`);
    if (version !== undefined && !isSemanticVersion(version))
      invalid(`Feature ${name} version must be a semantic version`);
    if (this.#features.has(name))
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Duplicate feature ${name}`,
      );
    const declared = feature.capabilities ?? {};
    if (
      typeof declared !== 'object' ||
      declared === null ||
      Array.isArray(declared)
    )
      invalid(`Feature ${name} capabilities must be a name → declaration map`);
    const entries = Object.entries(declared);
    for (const [capability] of entries)
      if (!capabilityPattern.test(capability))
        invalid(`Invalid capability name ${capability} for feature ${name}`);
    const components = list(feature.components, 'components');
    const actions = list(feature.actions, 'actions');
    const views = list(feature.views, 'views');
    const renderers = list(feature.renderers, 'renderers');
    // Capabilities are validated (and copied) by the capability registry.
    const qualified = Object.create(null) as Record<string, FeatureCapability>;
    for (const [capability, declaration] of entries) {
      const qualifiedName = `${name}.${capability}`;
      this.capabilities.register(qualifiedName, declaration);
      qualified[qualifiedName] = this.capabilities.get(qualifiedName);
    }
    this.#features.set(
      name,
      Object.freeze({
        name,
        package: feature.package,
        ...(version === undefined ? {} : { version }),
        components,
        actions,
        views,
        renderers,
        capabilities: Object.freeze(qualified),
      }),
    );
  }

  has(name: string): boolean {
    return this.#features.has(name);
  }
  get(name: string): NestvexaFeatureReport {
    const feature = this.#features.get(name);
    if (!feature)
      throw new NestvexaError(
        'UNKNOWN_REGISTRATION',
        `Unknown feature ${name}`,
      );
    return feature;
  }
  /** Installed features in registration order. */
  features(): readonly NestvexaFeatureReport[] {
    return Object.freeze([...this.#features.values()]);
  }
  /** `<feature>:<component>` for every registered Live component. */
  components(): readonly string[] {
    return this.#qualified('components');
  }
  /** `<feature>:<group/action>` for every registered safe action. */
  actions(): readonly string[] {
    return this.#qualified('actions');
  }
  views(): readonly string[] {
    return this.#qualified('views');
  }
  /** Distinct renderer adapter names across features. */
  renderers(): readonly string[] {
    return Object.freeze(
      [
        ...new Set(this.features().flatMap((feature) => feature.renderers)),
      ].sort(),
    );
  }
  /** Installed extensions (plugins converted with `pluginExtension` included). */
  plugins(): readonly NestvexaPluginReport[] {
    return this.extensions?.describe() ?? Object.freeze([]);
  }
  /** Fail startup unless `name` is installed. */
  require(name: string): void {
    if (!this.has(name))
      throw new NestvexaError(
        'UNSUPPORTED_CAPABILITY',
        `Feature ${name} is not installed`,
      );
  }
  report(): NestvexaRegistryReport {
    return Object.freeze({
      features: this.features(),
      plugins: this.plugins(),
    });
  }
  seal(): void {
    this.#sealed = true;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
  onApplicationBootstrap(): void {
    this.seal();
  }

  #qualified(field: 'components' | 'actions' | 'views'): readonly string[] {
    return Object.freeze(
      this.features().flatMap((feature) =>
        feature[field].map((entry) => `${feature.name}:${entry}`),
      ),
    );
  }
}
