/**
 * Browser- and SSR-safe page registry over an explicit `import.meta.glob`
 * result. Component names come from the server (the Inertia page object), so
 * they are only ever looked up in the map built from the glob keys at startup —
 * never turned into a module path — and a client cannot load an arbitrary
 * module by naming it.
 */

/**
 * The Inertia v3 page object fields adapters read. Declared here so adapter
 * declarations stay independent of upstream client type packages.
 */
export interface InertiaPageLike {
  readonly component: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly url: string;
  readonly version: string | number | null;
}

/** Protocol SSR output: `head` elements and the page script plus root `body`. */
export interface SsrRenderResult {
  readonly head: string[];
  readonly body: string;
}

/** `render(page)` exported by an SSR entry. */
export type SsrRender = (page: InertiaPageLike) => Promise<SsrRenderResult>;

/** Official progress bar options (`createInertiaApp({ progress })`). */
export interface ProgressOptionsLike {
  readonly delay?: number;
  readonly color?: string;
  readonly includeCSS?: boolean;
  readonly showSpinner?: boolean;
}

/** An `import.meta.glob` result: lazy loaders, or modules with `{ eager: true }`. */
export type PageGlob<TModule> = Readonly<
  Record<string, TModule | (() => Promise<TModule>)>
>;

export interface PageRegistryOptions {
  /** Glob key prefix to strip, e.g. `./pages/`. Every key must start with it. */
  readonly base: string;
  /** File extensions to strip, e.g. `['.tsx']`. Default: the last extension. */
  readonly extensions?: readonly string[];
}

export interface PageRegistry<TModule> {
  /** Registered component names, e.g. `Users/Index`. */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** Loads a registered page; rejects with `PageNotFoundError` otherwise. */
  load(name: string): Promise<TModule>;
}

/** The server named a component that is not in the page registry. */
export class PageNotFoundError extends Error {
  constructor(readonly component: string) {
    super(`Page component "${component.slice(0, 200)}" is not registered`);
    this.name = 'PageNotFoundError';
  }
}

/** Invalid page registry (bad base, duplicate names, unsafe keys). */
export class PageRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRegistryError';
  }
}

const namePattern = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** True for an Inertia component name the registry can hold (`Users/Index`). */
export function isPageName(name: unknown): name is string {
  return (
    typeof name === 'string' && name.length <= 200 && namePattern.test(name)
  );
}

function stripExtension(
  path: string,
  extensions: readonly string[] | undefined,
): string | undefined {
  if (extensions) {
    const match = extensions.find((extension) => path.endsWith(extension));
    return match === undefined ? undefined : path.slice(0, -match.length);
  }
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') + 1 ? path.slice(0, dot) : undefined;
}

/**
 * Builds a registry from `import.meta.glob('./pages/**\/*.tsx')`. Lazy globs
 * keep each page in its own chunk (code splitting); eager globs are accepted
 * too. Throws `PageRegistryError` for keys outside `base`, unsupported
 * extensions, names with unsafe characters or duplicate names.
 */
export function createPageRegistry<TModule>(
  glob: PageGlob<TModule>,
  options: PageRegistryOptions,
): PageRegistry<TModule> {
  if (typeof glob !== 'object' || glob === null)
    throw new PageRegistryError('Page glob must be an import.meta.glob object');
  const base = options?.base;
  if (typeof base !== 'string' || !base.endsWith('/'))
    throw new PageRegistryError('Page registry base must end with "/"');
  const entries = new Map<string, TModule | (() => Promise<TModule>)>();
  for (const [key, value] of Object.entries(glob)) {
    if (!key.startsWith(base))
      throw new PageRegistryError(`Page ${key} is outside ${base}`);
    const name = stripExtension(key.slice(base.length), options.extensions);
    if (name === undefined || !isPageName(name))
      throw new PageRegistryError(`Page ${key} has an unsupported name`);
    if (entries.has(name))
      throw new PageRegistryError(`Duplicate page name ${name}`);
    entries.set(name, value);
  }
  const names = Object.freeze([...entries.keys()].sort());
  return Object.freeze({
    names,
    has: (name: string) => isPageName(name) && entries.has(name),
    async load(name: string): Promise<TModule> {
      const entry = isPageName(name) ? entries.get(name) : undefined;
      if (entry === undefined) throw new PageNotFoundError(String(name));
      return typeof entry === 'function'
        ? await (entry as () => Promise<TModule>)()
        : entry;
    },
  });
}
