import { SafeHtml } from '@nestvexa/views';

export type IslandFramework = 'react' | 'vue' | 'svelte' | 'custom';
export type IslandStrategy = 'immediate' | 'visible' | 'idle' | 'interaction';
export interface IslandDefinition {
  /** Stable allowlisted identifier used in markup and in the client registry. */
  readonly id: string;
  readonly framework: IslandFramework;
  readonly strategy?: IslandStrategy;
  /** Maximum serialized props size in bytes (default 32 KiB, maximum 256 KiB). */
  readonly maxPropsBytes?: number;
}
export interface IslandRenderOptions {
  readonly strategy?: IslandStrategy;
  /** Trusted fallback or server-rendered HTML shown until (and if) the island mounts. */
  readonly fallback?: SafeHtml | string;
  /** Stable key so Live morphs retain the island when siblings change. */
  readonly key?: string;
  /** Accessible label for the island container. */
  readonly label?: string;
}
export class IslandError extends Error {
  override readonly name = 'IslandError';
}
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const strategies: readonly IslandStrategy[] = [
  'immediate',
  'visible',
  'idle',
  'interaction',
];

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
/** JSON-only props: functions, class instances, cycles, symbols and BigInt are rejected. */
export function serializeProps(props: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  const check = (value: unknown, depth: number): void => {
    if (depth > 32) throw new IslandError('Island props are nested too deeply');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new IslandError('Island props must be finite numbers');
      return;
    }
    if (typeof value !== 'object')
      throw new IslandError('Island props must be JSON data');
    if (seen.has(value))
      throw new IslandError('Island props must not be cyclic');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new IslandError('Island props must be plain objects and arrays');
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new IslandError('Unsafe island prop key');
      check(item, depth + 1);
    }
    seen.delete(value);
  };
  check(props ?? {}, 0);
  const json = JSON.stringify(props ?? {});
  if (Buffer.byteLength(json) > maxBytes)
    throw new IslandError(`Island props exceed ${maxBytes} bytes`);
  return json;
}

/**
 * Server-side allowlist. Only registered ids can be rendered; the browser loader
 * keeps its own build-time map of id → module, so markup can never select code.
 */
export class IslandRegistry {
  readonly #islands = new Map<
    string,
    Required<Omit<IslandDefinition, 'maxPropsBytes'>> & {
      maxPropsBytes: number;
    }
  >();
  constructor(definitions: readonly IslandDefinition[]) {
    for (const definition of definitions) {
      if (!idPattern.test(definition.id))
        throw new IslandError(`Invalid island id: ${definition.id}`);
      if (this.#islands.has(definition.id))
        throw new IslandError(`Duplicate island id: ${definition.id}`);
      if (!['react', 'vue', 'svelte', 'custom'].includes(definition.framework))
        throw new IslandError(`Unknown island framework for ${definition.id}`);
      const strategy = definition.strategy ?? 'visible';
      if (!strategies.includes(strategy))
        throw new IslandError(`Invalid strategy for ${definition.id}`);
      const maxPropsBytes = definition.maxPropsBytes ?? 32_768;
      if (
        !Number.isSafeInteger(maxPropsBytes) ||
        maxPropsBytes < 2 ||
        maxPropsBytes > 262_144
      )
        throw new IslandError(`Invalid maxPropsBytes for ${definition.id}`);
      this.#islands.set(definition.id, {
        id: definition.id,
        framework: definition.framework,
        strategy,
        maxPropsBytes,
      });
    }
  }
  has(id: string): boolean {
    return this.#islands.has(id);
  }
  ids(): readonly string[] {
    return [...this.#islands.keys()];
  }
  /** Trusted markup for a registered island; props are escaped JSON in an attribute. */
  render(
    id: string,
    props: unknown = {},
    options: IslandRenderOptions = {},
  ): SafeHtml {
    const island = this.#islands.get(id);
    if (!island) throw new IslandError(`Unknown island: ${id}`);
    const strategy = options.strategy ?? island.strategy;
    if (!strategies.includes(strategy))
      throw new IslandError('Invalid island strategy');
    if (
      options.key !== undefined &&
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key)
    )
      throw new IslandError('Invalid island key');
    const json = serializeProps(props, island.maxPropsBytes);
    const fallback =
      options.fallback instanceof SafeHtml
        ? options.fallback.value
        : options.fallback === undefined
          ? ''
          : escapeText(options.fallback);
    const attributes = [
      `data-nv-island="${escapeAttribute(id)}"`,
      `data-nv-framework="${island.framework}"`,
      `data-nv-mount="${strategy}"`,
      `data-nv-props="${escapeAttribute(json)}"`,
      ...(options.key === undefined
        ? []
        : [`data-nv-key="island:${escapeAttribute(options.key)}"`]),
      ...(options.label === undefined
        ? []
        : [`role="region"`, `aria-label="${escapeAttribute(options.label)}"`]),
    ];
    return SafeHtml.trusted(`<div ${attributes.join(' ')}>${fallback}</div>`);
  }
  /**
   * Template helpers: `{{nvIsland "revenue-chart" key="chart" label="Revenue" title=title}}`
   * in Handlebars, or `nvIsland('revenue-chart', { title })` in other engines.
   */
  helpers(): { readonly nvIsland: (...args: unknown[]) => SafeHtml } {
    return Object.freeze({
      nvIsland: (...args: unknown[]): SafeHtml => {
        const values = [...args];
        let named: Record<string, unknown> = {};
        const last = values.at(-1);
        if (
          last &&
          typeof last === 'object' &&
          Object.hasOwn(last, 'hash') &&
          Object.hasOwn(last, 'data')
        ) {
          values.pop();
          const hash: unknown = Reflect.get(last, 'hash');
          if (hash && typeof hash === 'object') named = { ...hash };
        } else if (values.length === 2 && last && typeof last === 'object') {
          values.pop();
          named = { ...(last as Record<string, unknown>) };
        }
        const [id] = values;
        if (typeof id !== 'string' || values.length !== 1)
          throw new IslandError('nvIsland requires an island id');
        const options: Record<string, unknown> = {};
        for (const name of ['key', 'label', 'strategy', 'fallback'] as const)
          if (Object.hasOwn(named, name)) {
            options[name] = named[name];
            delete named[name];
          }
        return this.render(id, named, options as IslandRenderOptions);
      },
    });
  }
}
