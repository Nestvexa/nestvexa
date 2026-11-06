import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { SafeHtml, ViewError } from './index.js';

/**
 * Hardened building blocks shared by first-party and third-party adapters.
 * They implement the same trust boundary as the default Handlebars adapter:
 * forward-slash root-relative template IDs, real-path containment, bounded
 * template sizes and public-data-only view models.
 */
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const maxViewIdLength = 240;

/**
 * Controls, unpaired surrogates and noncharacters never name a template. They
 * are refused before any filesystem call: on Windows, Node 22/24 (libuv) abort
 * the whole process with a failed assertion for any path containing U+10FFFF.
 */
const unsafeViewCharacter = /[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/u;

/**
 * Rejects absolute paths, traversal, alternate separators, drive/stream syntax,
 * NUL and other control bytes, unpaired surrogates and noncharacters.
 */
export function normalizeViewId(view: string, extension: string): string {
  if (
    typeof view !== 'string' ||
    !view ||
    view.length > maxViewIdLength ||
    view.includes('\\') ||
    view.includes(':') ||
    unsafeViewCharacter.test(view) ||
    path.posix.isAbsolute(view) ||
    view.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ViewError(
      'INVALID_VIEW',
      'View must be a root-relative forward-slash identifier',
    );
  return view.endsWith(extension) ? view : `${view}${extension}`;
}

/** Helper, filter, partial and slot names: identifier-like, no prototype keys. */
export function assertViewAliases(
  value: Readonly<Record<string, unknown>>,
): void {
  for (const key of Object.keys(value))
    if (!/^[a-zA-Z][\w/-]*$/.test(key) || forbiddenKeys.has(key))
      throw new ViewError(
        'INVALID_VIEW',
        'Invalid helper, partial or slot alias',
      );
}

/** Namespace and theme names: lowercase identifiers such as `admin` or `dark-mode`. */
const scopeName = /^[a-z][a-z0-9-]{0,63}$/;

/** A view name split into its optional namespace and root-relative path. */
export interface ViewName {
  readonly namespace: string | undefined;
  readonly path: string;
}

/**
 * Splits `admin::users/index` into `{ namespace: 'admin', path: 'users/index' }`.
 * Names without `::` belong to the default namespace. Only the syntax is
 * checked here; {@link TemplateRoot} rejects namespaces that are not registered.
 */
export function parseViewName(view: string): ViewName {
  if (typeof view !== 'string')
    throw new ViewError('INVALID_VIEW', 'View name must be a string');
  const separator = view.indexOf('::');
  if (separator === -1) return { namespace: undefined, path: view };
  const namespace = view.slice(0, separator);
  if (!scopeName.test(namespace) || forbiddenKeys.has(namespace))
    throw new ViewError('INVALID_VIEW', 'Invalid view namespace');
  return { namespace, path: view.slice(separator + 2) };
}

/**
 * {@link normalizeViewId} for names that may carry a namespace prefix. The
 * result is canonical: `admin::users/index.hbs` or `users/index.hbs`.
 */
export function normalizeQualifiedViewId(
  view: string,
  extension: string,
): string {
  const name = parseViewName(view);
  const id = normalizeViewId(name.path, extension);
  return name.namespace === undefined ? id : `${name.namespace}::${id}`;
}

/**
 * Resolves a template-authored include/extends reference to a root-relative ID.
 * A leading `/` means relative to the root of the including template's
 * namespace; `ns::x` names another namespace explicitly; otherwise the reference
 * is relative to the including template's directory. `..`, `.`, backslashes,
 * drive letters and NUL bytes are rejected exactly as for browser-reachable
 * view names.
 */
export function resolveTemplateReference(
  parentId: string | undefined,
  reference: string,
): string {
  if (typeof reference !== 'string')
    throw new ViewError('INVALID_VIEW', 'Template reference must be a string');
  const target = parseViewName(reference);
  if (target.namespace !== undefined) {
    normalizeViewId(target.path, '');
    return reference;
  }
  const parent = parentId === undefined ? undefined : parseViewName(parentId);
  const prefix = parent?.namespace === undefined ? '' : `${parent.namespace}::`;
  const local = reference.startsWith('/') ? reference.slice(1) : reference;
  const directory =
    reference.startsWith('/') || parent === undefined
      ? '.'
      : path.posix.dirname(parent.path);
  const candidate = directory === '.' ? local : `${directory}/${local}`;
  // Validation (including of the stripped reference) happens in normalizeViewId.
  normalizeViewId(candidate, '');
  normalizeViewId(local, '');
  return prefix + candidate;
}

function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function missingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export interface TemplateRootOptions {
  /** Operating-system directory, including Windows paths. Never browser input. */
  readonly root: string;
  /** Default extension appended to IDs that omit it, for example `.ejs`. */
  readonly extension: string;
  /** Defaults to 1 MiB. */
  readonly maxTemplateBytes?: number;
  /**
   * Namespace -> trusted directory. `admin::users/index` resolves inside the
   * `admin` directory (for example a feature module or package's own views).
   * The application may override any namespaced view at
   * `<root>/vendor/<namespace>/<path>`.
   */
  readonly namespaces?: Readonly<Record<string, string>>;
  /**
   * Theme -> trusted override directory. A render that selects a theme looks
   * in `<theme>/<path>` (and `<theme>/vendor/<namespace>/<path>` for
   * namespaced views) before the normal locations.
   */
  readonly themes?: Readonly<Record<string, string>>;
}

/** One searchable directory: `base` is the configured directory it lives in. */
interface Mount {
  readonly base: string;
  readonly directory: string;
  readonly namespace: string | undefined;
}

function scopes(
  value: Readonly<Record<string, string>> | undefined,
  label: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ViewError('INVALID_VIEW', `Invalid view ${label} map`);
  for (const [name, directory] of Object.entries(value)) {
    if (!scopeName.test(name) || forbiddenKeys.has(name))
      throw new ViewError('INVALID_VIEW', `Invalid view ${label} name`);
    if (typeof directory !== 'string' || !directory)
      throw new ViewError(
        'INVALID_VIEW',
        `View ${label} ${name} needs a directory`,
      );
    result.set(name, path.resolve(directory));
  }
  return result;
}

/**
 * Owns the trusted template directories of one engine: the default root,
 * optional namespaces and optional theme override directories. Every lookup is
 * contained by real path in the configured directory it was found in.
 */
export class TemplateRoot {
  readonly path: string;
  readonly extension: string;
  readonly maxTemplateBytes: number;
  readonly #namespaces: ReadonlyMap<string, string>;
  readonly #themes: ReadonlyMap<string, string>;
  constructor(options: TemplateRootOptions) {
    if (!options.root || typeof options.root !== 'string')
      throw new ViewError('INVALID_VIEW', 'A template root is required');
    if (!/^\.[a-z0-9]+$/i.test(options.extension))
      throw new ViewError('INVALID_VIEW', 'Invalid template extension');
    this.maxTemplateBytes = options.maxTemplateBytes ?? 1_048_576;
    if (
      !Number.isSafeInteger(this.maxTemplateBytes) ||
      this.maxTemplateBytes < 1
    )
      throw new ViewError(
        'INVALID_VIEW',
        'Template limits must be positive integers',
      );
    this.path = path.resolve(options.root);
    this.extension = options.extension;
    this.#namespaces = scopes(options.namespaces, 'namespace');
    this.#themes = scopes(options.themes, 'theme');
  }
  /** Registered namespace names. */
  get namespaces(): readonly string[] {
    return Object.freeze([...this.#namespaces.keys()]);
  }
  /** Registered theme names. */
  get themes(): readonly string[] {
    return Object.freeze([...this.#themes.keys()]);
  }
  /** Canonical ID (`ns::path.ext` or `path.ext`); unknown namespaces are rejected. */
  id(view: string): string {
    const id = normalizeQualifiedViewId(view, this.extension);
    const { namespace } = parseViewName(id);
    if (namespace !== undefined && !this.#namespaces.has(namespace))
      throw new ViewError(
        'INVALID_VIEW',
        `Unknown view namespace: ${namespace}`,
      );
    return id;
  }
  /** Validates a theme name; `undefined` selects no theme. */
  theme(theme: string | undefined): string | undefined {
    if (theme === undefined) return undefined;
    if (typeof theme !== 'string' || !this.#themes.has(theme))
      throw new ViewError('INVALID_VIEW', 'Unknown view theme');
    return theme;
  }
  async assertDirectory(): Promise<void> {
    for (const directory of [
      this.path,
      ...this.#namespaces.values(),
      ...this.#themes.values(),
    ])
      if (!(await stat(directory)).isDirectory())
        throw new ViewError('INVALID_VIEW', 'Template root is not a directory');
  }
  /** Search order for one namespace: theme overrides, app vendor override, namespace root. */
  #mounts(namespace: string | undefined, theme: string | undefined): Mount[] {
    const themeDirectory =
      theme === undefined ? undefined : this.#themes.get(theme);
    if (namespace === undefined) {
      const mounts: Mount[] = [];
      if (themeDirectory !== undefined)
        mounts.push({
          base: themeDirectory,
          directory: themeDirectory,
          namespace,
        });
      mounts.push({ base: this.path, directory: this.path, namespace });
      return mounts;
    }
    const directory = this.#namespaces.get(namespace);
    if (directory === undefined)
      throw new ViewError(
        'INVALID_VIEW',
        `Unknown view namespace: ${namespace}`,
      );
    const vendor = (base: string): Mount => ({
      base,
      directory: path.join(base, 'vendor', namespace),
      namespace,
    });
    return [
      ...(themeDirectory === undefined ? [] : [vendor(themeDirectory)]),
      vendor(this.path),
      { base: directory, directory, namespace },
    ];
  }
  #locate(
    view: string,
    extension: string,
    theme: string | undefined,
  ): { relative: string; mounts: Mount[] } {
    const name = parseViewName(normalizeQualifiedViewId(view, extension));
    return {
      relative: name.path,
      mounts: this.#mounts(name.namespace, this.theme(theme)),
    };
  }
  #candidate(mount: Mount, relative: string): string {
    const candidate = path.resolve(mount.directory, relative);
    if (!inside(mount.directory, candidate))
      throw new ViewError('INVALID_VIEW', 'Template escapes root');
    return candidate;
  }
  /**
   * Real path of a validated view ID; rejects symlink/junction escapes. Pass an
   * empty extension for references that already name their file extension.
   * With a theme, the theme's override directory is searched first.
   */
  async resolve(
    view: string,
    extension = this.extension,
    theme?: string,
  ): Promise<string> {
    const { relative, mounts } = this.#locate(view, extension, theme);
    let missing: unknown;
    for (const mount of mounts) {
      const candidate = this.#candidate(mount, relative);
      let filename: string;
      try {
        filename = await realpath(candidate);
      } catch (error) {
        if (!missingFile(error)) throw error;
        missing = error;
        continue;
      }
      if (!inside(await realpath(mount.base), filename))
        throw new ViewError('INVALID_VIEW', 'Template symlink escapes root');
      return filename;
    }
    throw missing ?? new ViewError('INVALID_VIEW', 'Template not found');
  }
  /** Synchronous variant for engines whose include hooks are synchronous. */
  resolveSync(
    view: string,
    extension = this.extension,
    theme?: string,
  ): string {
    const { relative, mounts } = this.#locate(view, extension, theme);
    let missing: unknown;
    for (const mount of mounts) {
      const candidate = this.#candidate(mount, relative);
      // The native variant matches async realpath (libuv): it expands Windows 8.3
      // short names, so sync and async resolution agree.
      let filename: string;
      try {
        filename = realpathSync.native(candidate);
      } catch (error) {
        if (!missingFile(error)) throw error;
        missing = error;
        continue;
      }
      if (!inside(realpathSync.native(mount.base), filename))
        throw new ViewError('INVALID_VIEW', 'Template symlink escapes root');
      return filename;
    }
    throw missing ?? new ViewError('INVALID_VIEW', 'Template not found');
  }
  #checkSize(size: number, isFile: boolean): void {
    if (!isFile || size > this.maxTemplateBytes)
      throw new ViewError('INVALID_VIEW', 'Invalid or oversized template');
  }
  #checkSource(source: string): string {
    if (Buffer.byteLength(source) > this.maxTemplateBytes)
      throw new ViewError('INVALID_VIEW', 'Oversized template');
    return source.startsWith('﻿') ? source.slice(1) : source;
  }
  async read(filename: string): Promise<string> {
    const info = await stat(filename);
    this.#checkSize(info.size, info.isFile());
    return this.#checkSource(await readFile(filename, 'utf8'));
  }
  readSync(filename: string): string {
    const info = statSync(filename);
    this.#checkSize(info.size, info.isFile());
    return this.#checkSource(readFileSync(filename, 'utf8'));
  }
  /**
   * Maps an absolute filename (lexical or real) back to a canonical ID such as
   * `users/index.hbs` or `admin::users/index.hbs`; the most specific directory
   * wins, so theme and vendor overrides map to the view they override.
   * Returns undefined for anything outside every configured directory.
   */
  viewFromFile(filename: string): string | undefined {
    const absolute = path.resolve(filename);
    const mounts: Mount[] = [
      { base: this.path, directory: this.path, namespace: undefined },
    ];
    for (const [namespace, directory] of this.#namespaces) {
      mounts.push(
        { base: directory, directory, namespace },
        {
          base: this.path,
          directory: path.join(this.path, 'vendor', namespace),
          namespace,
        },
      );
      for (const theme of this.#themes.values())
        mounts.push({
          base: theme,
          directory: path.join(theme, 'vendor', namespace),
          namespace,
        });
    }
    for (const theme of this.#themes.values())
      mounts.push({ base: theme, directory: theme, namespace: undefined });
    let best: { length: number; id: string } | undefined;
    for (const mount of mounts)
      for (const directory of this.#forms(mount.directory)) {
        if (!inside(directory, absolute)) continue;
        if (best && best.length >= directory.length) continue;
        const relative = path
          .relative(directory, absolute)
          .split(path.sep)
          .join('/');
        best = {
          length: directory.length,
          id:
            mount.namespace === undefined
              ? relative
              : `${mount.namespace}::${relative}`,
        };
      }
    return best?.id;
  }
  /** Lexical and real spelling of a directory (they differ for symlinks and 8.3 names). */
  #forms(directory: string): string[] {
    try {
      const real = realpathSync.native(directory);
      return real === directory ? [directory] : [directory, real];
    } catch {
      return [directory];
    }
  }
}

export interface ViewModelLimits {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

/**
 * Copies only public JSON-like data into null-prototype objects. Accessors are
 * inspected without being invoked. `SafeHtml` is the only accepted class and is
 * mapped through `trusted` into the engine's own trusted-markup representation.
 */
export function copyViewModel(
  model: unknown,
  trusted: (html: SafeHtml) => unknown,
  limits: ViewModelLimits = {},
): Record<string, unknown> {
  const maxNodes = limits.maxNodes ?? 10_000;
  const maxDepth = limits.maxDepth ?? 32;
  const budget = { nodes: 0 };
  const active = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++budget.nodes > maxNodes || depth > maxDepth)
      throw new ViewError(
        'UNSAFE_MODEL',
        'View model exceeds structural limits',
      );
    if (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof SafeHtml) return trusted(value);
    if (typeof value !== 'object')
      throw new ViewError(
        'UNSAFE_MODEL',
        'Only finite JSON values and trusted HTML may enter a view',
      );
    if (active.has(value))
      throw new ViewError('UNSAFE_MODEL', 'Cyclic view model');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new ViewError(
        'UNSAFE_MODEL',
        'Class instances are not public view models',
      );
    if (Object.getOwnPropertySymbols(value).length)
      throw new ViewError('UNSAFE_MODEL', 'Symbol keys are unsupported');
    active.add(value);
    const output: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : (Object.create(null) as Record<string, unknown>);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (Array.isArray(value) && key === 'length') continue;
      if (forbiddenKeys.has(key) || descriptor.get || descriptor.set)
        throw new ViewError('UNSAFE_MODEL', 'Unsafe view model property');
      if (!descriptor.enumerable) continue;
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    active.delete(value);
    return output;
  };
  const result = copy(model, 0);
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    throw new ViewError('UNSAFE_MODEL', 'View model must be an object');
  return result as Record<string, unknown>;
}

/**
 * Express `app.engine` passes host settings and locals metadata with the view
 * data. Strip them so they never reach templates or engine options.
 */
export function expressViewModel(
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const model: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(options),
  )) {
    if (key === 'settings' || key === '_locals' || key === 'cache') continue;
    Object.defineProperty(model, key, descriptor);
  }
  return model;
}

/** Calls a trusted synchronous helper; async helpers belong in view composers. */
export function invokeViewHelper(
  helper: (...args: unknown[]) => unknown,
  args: readonly unknown[],
): unknown {
  const result = helper(...args);
  if (
    result instanceof Promise ||
    (typeof result === 'object' &&
      result !== null &&
      typeof Reflect.get(result, 'then') === 'function')
  )
    throw new ViewError(
      'RENDER_FAILED',
      'Async helpers are unsupported; use a view composer',
    );
  return result;
}
