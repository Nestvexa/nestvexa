import { SafeHtml } from '@nestvexa/views';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CONTEXT_ELEMENT_ID,
  DEFAULT_MAX_PROPS_BYTES,
  ISLAND_BUNDLE_PATTERN,
  ISLAND_FRAMEWORKS,
  ISLAND_ID_PATTERN,
  ISLAND_STRATEGIES,
  MAX_PROPS_BYTES,
  SENSITIVE_KEY,
  checkIslandProps,
  isIslandPropSchema,
  parseIslandManifest,
  parseSharedContext,
} from './shared.js';
import type {
  IslandFramework,
  IslandManifest,
  IslandManifestEntry,
  IslandPropSchema,
  IslandSharedContext,
  IslandStrategy,
} from './shared.js';

export {
  CONTEXT_ELEMENT_ID,
  checkIslandProps,
  parseIslandManifest,
  parseSharedContext,
} from './shared.js';
export type {
  IslandFramework,
  IslandManifest,
  IslandManifestEntry,
  IslandPropSchema,
  IslandSharedContext,
  IslandStrategy,
} from './shared.js';

export interface IslandDefinition {
  /** Stable allowlisted identifier used in markup and in the client registry. */
  readonly id: string;
  readonly framework: IslandFramework;
  readonly strategy?: IslandStrategy;
  /** Maximum serialized props size in bytes (default 32 KiB, maximum 256 KiB). */
  readonly maxPropsBytes?: number;
  /** Closed props schema checked on render (server) and before mount (browser). */
  readonly props?: IslandPropSchema;
  /** Sign rendered props (`data-nv-props-token`); requires registry `signingKeys`. */
  readonly signed?: boolean;
  /** Build-time bundle path (from the manifest); never rendered into markup. */
  readonly bundle?: string;
  /**
   * Props keys that look like secrets (password, token, apiKey, session...)
   * are rejected unless this is true. Props are public page data.
   */
  readonly allowSensitiveKeys?: boolean;
  /** Gzip budget for the island's chunk graph (manifest only; checked by scripts). */
  readonly budgetBytes?: number;
}
export interface IslandRenderOptions {
  readonly strategy?: IslandStrategy;
  /** Trusted fallback or server-rendered HTML shown until (and if) the island mounts. */
  readonly fallback?: SafeHtml | string;
  /** Rendered in a sibling `<noscript>` for visitors without JavaScript. */
  readonly noscript?: SafeHtml | string;
  /** Stable key so Live morphs retain the island when siblings change. */
  readonly key?: string;
  /** Accessible label for the island container. */
  readonly label?: string;
}
export interface IslandSsrOptions extends IslandRenderOptions {
  /** Page context passed to the server renderer (same as `contextScript`). */
  readonly context?: IslandSharedContext;
}

/** What server renderers receive besides props. */
export interface IslandServerContext {
  readonly id: string;
  readonly shared: IslandSharedContext;
}
/** Framework SSR function for one island (see `@nestvexa/islands/*-server`). */
export type IslandServerRenderer = (
  props: Readonly<Record<string, unknown>>,
  context: IslandServerContext,
) => string | Promise<string>;

export interface IslandRegistryOptions {
  /**
   * HMAC keys for signed props; the first signs, all verify (rotation).
   * Each key must be at least 32 bytes.
   */
  readonly signingKeys?: readonly (string | Uint8Array)[];
  /** Signed props lifetime in milliseconds, default 3600000 (1 hour). */
  readonly signatureTtlMs?: number;
  /** Server renderers by island id, used by `renderSsr`. */
  readonly renderers?: Readonly<Record<string, IslandServerRenderer>>;
  /** Observes SSR failures; the island then renders its fallback. */
  readonly onRenderError?: (error: unknown, id: string) => void;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export class IslandError extends Error {
  override readonly name = 'IslandError';
}

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
function markup(value: SafeHtml | string | undefined): string {
  return value instanceof SafeHtml
    ? value.value
    : value === undefined
      ? ''
      : escapeText(value);
}

/** JSON-only props: functions, class instances, cycles, symbols and BigInt are rejected. */
export function serializeProps(
  props: unknown,
  maxBytes: number,
  options: { readonly allowSensitiveKeys?: boolean } = {},
): string {
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
      if (
        !Array.isArray(value) &&
        options.allowSensitiveKeys !== true &&
        SENSITIVE_KEY.test(key)
      )
        throw new IslandError(
          `Island props must not include secret-like key "${key}"; props are public page data`,
        );
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

/** `<` and friends escaped so JSON can never end its `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

interface Island {
  readonly id: string;
  readonly framework: IslandFramework;
  readonly strategy: IslandStrategy;
  readonly maxPropsBytes: number;
  readonly props: IslandPropSchema | undefined;
  readonly signed: boolean;
  readonly bundle: string | undefined;
  readonly allowSensitiveKeys: boolean;
  readonly budgetBytes: number | undefined;
}

/**
 * Server-side allowlist. Only registered ids can be rendered; the browser loader
 * keeps its own build-time map of id → module, so markup can never select code.
 */
export class IslandRegistry {
  readonly #islands = new Map<string, Island>();
  readonly #keys: readonly Buffer[];
  readonly #ttl: number;
  readonly #renderers: Readonly<Record<string, IslandServerRenderer>>;
  readonly #onRenderError: IslandRegistryOptions['onRenderError'];
  readonly #now: () => number;

  constructor(
    definitions: readonly IslandDefinition[],
    options: IslandRegistryOptions = {},
  ) {
    for (const definition of definitions) {
      if (!ISLAND_ID_PATTERN.test(definition.id))
        throw new IslandError(`Invalid island id: ${definition.id}`);
      if (this.#islands.has(definition.id))
        throw new IslandError(`Duplicate island id: ${definition.id}`);
      if (!ISLAND_FRAMEWORKS.includes(definition.framework))
        throw new IslandError(`Unknown island framework for ${definition.id}`);
      const strategy = definition.strategy ?? 'visible';
      if (!ISLAND_STRATEGIES.includes(strategy))
        throw new IslandError(`Invalid strategy for ${definition.id}`);
      const maxPropsBytes = definition.maxPropsBytes ?? DEFAULT_MAX_PROPS_BYTES;
      if (
        !Number.isSafeInteger(maxPropsBytes) ||
        maxPropsBytes < 2 ||
        maxPropsBytes > MAX_PROPS_BYTES
      )
        throw new IslandError(`Invalid maxPropsBytes for ${definition.id}`);
      if (
        definition.props !== undefined &&
        !isIslandPropSchema(definition.props)
      )
        throw new IslandError(`Invalid props schema for ${definition.id}`);
      if (
        definition.bundle !== undefined &&
        !ISLAND_BUNDLE_PATTERN.test(definition.bundle)
      )
        throw new IslandError(`Invalid bundle path for ${definition.id}`);
      this.#islands.set(definition.id, {
        id: definition.id,
        framework: definition.framework,
        strategy,
        maxPropsBytes,
        props: definition.props,
        signed: definition.signed === true,
        bundle: definition.bundle,
        allowSensitiveKeys: definition.allowSensitiveKeys === true,
        budgetBytes: definition.budgetBytes,
      });
    }
    this.#keys = (options.signingKeys ?? []).map((key) => {
      const bytes =
        typeof key === 'string' ? Buffer.from(key) : Buffer.from(key);
      if (bytes.byteLength < 32)
        throw new IslandError('Island signing keys must be at least 32 bytes');
      return bytes;
    });
    for (const island of this.#islands.values())
      if (island.signed && this.#keys.length === 0)
        throw new IslandError(
          `Island ${island.id} is signed but the registry has no signingKeys`,
        );
    const ttl = options.signatureTtlMs ?? 3_600_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 2_592_000_000)
      throw new IslandError('signatureTtlMs must be 1000-2592000000');
    this.#ttl = ttl;
    const renderers = options.renderers ?? {};
    for (const [id, renderer] of Object.entries(renderers))
      if (!this.#islands.has(id) || typeof renderer !== 'function')
        throw new IslandError(`Renderer for unknown island ${id}`);
    this.#renderers = Object.freeze({ ...renderers });
    this.#onRenderError = options.onRenderError;
    this.#now = options.now ?? Date.now;
  }

  /** Registry from a build-time manifest (`@nestvexa/islands/build`). */
  static fromManifest(
    manifest: unknown,
    options: IslandRegistryOptions & {
      /** Per-id server-only overrides (for example `allowSensitiveKeys`). */
      readonly overrides?: Readonly<
        Record<string, Pick<IslandDefinition, 'allowSensitiveKeys'>>
      >;
    } = {},
  ): IslandRegistry {
    const parsed = parseIslandManifest(manifest);
    const { overrides, ...registryOptions } = options;
    return new IslandRegistry(
      Object.entries(parsed.islands).map(([id, entry]) => ({
        id,
        ...entry,
        ...overrides?.[id],
      })),
      registryOptions,
    );
  }

  has(id: string): boolean {
    return this.#islands.has(id);
  }
  ids(): readonly string[] {
    return [...this.#islands.keys()];
  }
  /** Manifest view of the registered islands (bundle paths only when known). */
  manifest(): IslandManifest {
    const islands: Record<string, IslandManifestEntry> = {};
    for (const island of this.#islands.values()) {
      if (island.bundle === undefined) continue;
      islands[island.id] = {
        framework: island.framework,
        strategy: island.strategy,
        bundle: island.bundle,
        maxPropsBytes: island.maxPropsBytes,
        ...(island.props ? { props: island.props } : {}),
        ...(island.signed ? { signed: true } : {}),
        ...(island.budgetBytes ? { budgetBytes: island.budgetBytes } : {}),
      };
    }
    return parseIslandManifest({ version: 1, islands });
  }

  #island(id: string): Island {
    const island = this.#islands.get(id);
    if (!island) throw new IslandError(`Unknown island: ${id}`);
    return island;
  }

  #json(island: Island, props: unknown): string {
    const json = serializeProps(props, island.maxPropsBytes, {
      allowSensitiveKeys: island.allowSensitiveKeys,
    });
    if (island.props) {
      const problem = checkIslandProps(island.props, JSON.parse(json));
      if (problem)
        throw new IslandError(
          `Invalid props for island ${island.id}: ${problem}`,
        );
    }
    return json;
  }

  #mac(
    key: Buffer,
    id: string,
    iat: number,
    exp: number,
    json: string,
  ): Buffer {
    return createHmac('sha256', key)
      .update(['nv-island/1', id, String(iat), String(exp), json].join('\n'))
      .digest();
  }

  /** Token binding island id, props JSON and expiry: `v1.<iat>.<exp>.<mac>`. */
  signProps(id: string, json: string): string {
    this.#island(id);
    const key = this.#keys[0];
    if (!key) throw new IslandError('Island registry has no signingKeys');
    const iat = Math.floor(this.#now() / 1000);
    const exp = iat + Math.ceil(this.#ttl / 1000);
    return `v1.${iat}.${exp}.${this.#mac(key, id, iat, exp, json).toString('base64url')}`;
  }

  /**
   * Verifies props an island sends back to the server (`context.signed`).
   * Throws `IslandError` for tampered, foreign-island or expired tokens and
   * returns the parsed props otherwise. Re-check authorization regardless:
   * a valid signature proves origin, not current permission.
   */
  verifyProps(
    id: string,
    json: string,
    token: string,
  ): Record<string, unknown> {
    const island = this.#island(id);
    const match = /^v1\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(
      typeof token === 'string' ? token : '',
    );
    if (
      !match ||
      typeof json !== 'string' ||
      json.length > island.maxPropsBytes * 2
    )
      throw new IslandError('Invalid island props token');
    const iat = Number(match[1]);
    const exp = Number(match[2]);
    const given = Buffer.from(match[3] ?? '', 'base64url');
    const valid = this.#keys.some((key) => {
      const expected = this.#mac(key, id, iat, exp, json);
      return (
        expected.length === given.length && timingSafeEqual(expected, given)
      );
    });
    if (!valid) throw new IslandError('Island props signature mismatch');
    const now = Math.floor(this.#now() / 1000);
    if (exp <= now || iat > now + 60)
      throw new IslandError('Island props token expired');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new IslandError('Island props must be an object');
    return parsed as Record<string, unknown>;
  }

  #root(
    island: Island,
    json: string,
    options: IslandRenderOptions,
    inner: string,
    ssr: boolean,
  ): SafeHtml {
    const strategy = options.strategy ?? island.strategy;
    if (!ISLAND_STRATEGIES.includes(strategy))
      throw new IslandError('Invalid island strategy');
    if (
      options.key !== undefined &&
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.key)
    )
      throw new IslandError('Invalid island key');
    const attributes = [
      `data-nv-island="${escapeAttribute(island.id)}"`,
      `data-nv-framework="${island.framework}"`,
      `data-nv-mount="${strategy}"`,
      `data-nv-props="${escapeAttribute(json)}"`,
      ...(island.signed
        ? [`data-nv-props-token="${this.signProps(island.id, json)}"`]
        : []),
      ...(ssr ? ['data-nv-ssr=""'] : []),
      ...(options.key === undefined
        ? []
        : [`data-nv-key="island:${escapeAttribute(options.key)}"`]),
      ...(options.label === undefined
        ? []
        : [`role="region"`, `aria-label="${escapeAttribute(options.label)}"`]),
    ];
    const noscript =
      options.noscript === undefined
        ? ''
        : `<noscript data-nv-island-noscript="${escapeAttribute(island.id)}">${markup(options.noscript)}</noscript>`;
    return SafeHtml.trusted(
      `<div ${attributes.join(' ')}>${inner}</div>${noscript}`,
    );
  }

  /** Trusted markup for a registered island; props are escaped JSON in an attribute. */
  render(
    id: string,
    props: unknown = {},
    options: IslandRenderOptions = {},
  ): SafeHtml {
    const island = this.#island(id);
    return this.#root(
      island,
      this.#json(island, props),
      options,
      markup(options.fallback),
      false,
    );
  }

  /**
   * Server-renders the island with its registered renderer and marks the
   * root `data-nv-ssr` so the browser adapter hydrates instead of mounting.
   * The same props travel in `data-nv-props` (hydration state). On renderer
   * failure the island degrades to `render()` with its fallback.
   */
  async renderSsr(
    id: string,
    props: unknown = {},
    options: IslandSsrOptions = {},
  ): Promise<SafeHtml> {
    const island = this.#island(id);
    const json = this.#json(island, props);
    const renderer = this.#renderers[id];
    if (!renderer) throw new IslandError(`No server renderer for island ${id}`);
    const shared = parseSharedContext(options.context ?? {});
    try {
      const html = await renderer(
        Object.freeze(JSON.parse(json) as Record<string, unknown>),
        Object.freeze({ id, shared }),
      );
      if (typeof html !== 'string')
        throw new IslandError(`Renderer for ${id} must return a string`);
      return this.#root(island, json, options, html, true);
    } catch (error) {
      try {
        this.#onRenderError?.(error, id);
      } catch {
        // Reporting must not break the page.
      }
      return this.#root(island, json, options, markup(options.fallback), false);
    }
  }

  /**
   * `<script type="application/json" id="nv-islands-context">` with the
   * validated page context (theme tokens, locale, direction, display-only
   * user fields). JSON scripts never execute, so CSP is unaffected.
   */
  contextScript(context: IslandSharedContext): SafeHtml {
    const parsed = parseSharedContext(context);
    return SafeHtml.trusted(
      `<script type="application/json" id="${CONTEXT_ELEMENT_ID}">${scriptJson(parsed)}</script>`,
    );
  }

  /** `<link rel="modulepreload">` for islands whose manifest bundle is known. */
  preload(ids: readonly string[]): SafeHtml {
    return SafeHtml.trusted(
      ids
        .map((id) => this.#island(id).bundle)
        .filter((bundle): bundle is string => bundle !== undefined)
        .map(
          (bundle) =>
            `<link rel="modulepreload" href="${escapeAttribute(bundle)}">`,
        )
        .join(''),
    );
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
        for (const name of [
          'key',
          'label',
          'strategy',
          'fallback',
          'noscript',
        ] as const)
          if (Object.hasOwn(named, name)) {
            options[name] = named[name];
            delete named[name];
          }
        return this.render(id, named, options as IslandRenderOptions);
      },
    });
  }
}
