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

/** Rejects absolute paths, traversal, alternate separators, drive/stream syntax and NUL bytes. */
export function normalizeViewId(view: string, extension: string): string {
  if (
    typeof view !== 'string' ||
    !view ||
    view.length > maxViewIdLength ||
    view.includes('\\') ||
    view.includes(':') ||
    view.includes('\0') ||
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

/**
 * Resolves a template-authored include/extends reference to a root-relative ID.
 * A leading `/` means root-relative; otherwise the reference is relative to the
 * including template's directory. `..`, `.`, backslashes, drive letters and
 * NUL bytes are rejected exactly as for browser-reachable view names.
 */
export function resolveTemplateReference(
  parentId: string | undefined,
  reference: string,
): string {
  if (typeof reference !== 'string')
    throw new ViewError('INVALID_VIEW', 'Template reference must be a string');
  const local = reference.startsWith('/') ? reference.slice(1) : reference;
  const directory =
    reference.startsWith('/') || parentId === undefined
      ? '.'
      : path.posix.dirname(parentId);
  const candidate = directory === '.' ? local : `${directory}/${local}`;
  // Validation (including of the stripped reference) happens in normalizeViewId.
  normalizeViewId(candidate, '');
  normalizeViewId(local, '');
  return candidate;
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

export interface TemplateRootOptions {
  /** Operating-system directory, including Windows paths. Never browser input. */
  readonly root: string;
  /** Default extension appended to IDs that omit it, for example `.ejs`. */
  readonly extension: string;
  /** Defaults to 1 MiB. */
  readonly maxTemplateBytes?: number;
}

/** Owns one trusted template directory; every lookup is contained by real path. */
export class TemplateRoot {
  readonly path: string;
  readonly extension: string;
  readonly maxTemplateBytes: number;
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
  }
  id(view: string): string {
    return normalizeViewId(view, this.extension);
  }
  async assertDirectory(): Promise<void> {
    if (!(await stat(this.path)).isDirectory())
      throw new ViewError('INVALID_VIEW', 'Template root is not a directory');
  }
  #candidate(view: string, extension: string): string {
    const candidate = path.resolve(this.path, normalizeViewId(view, extension));
    if (!inside(this.path, candidate))
      throw new ViewError('INVALID_VIEW', 'Template escapes root');
    return candidate;
  }
  /**
   * Real path of a validated view ID; rejects symlink/junction escapes. Pass an
   * empty extension for references that already name their file extension.
   */
  async resolve(view: string, extension = this.extension): Promise<string> {
    const candidate = this.#candidate(view, extension);
    const [root, filename] = await Promise.all([
      realpath(this.path),
      realpath(candidate),
    ]);
    if (!inside(root, filename))
      throw new ViewError('INVALID_VIEW', 'Template symlink escapes root');
    return filename;
  }
  /** Synchronous variant for engines whose include hooks are synchronous. */
  resolveSync(view: string, extension = this.extension): string {
    const candidate = this.#candidate(view, extension);
    const filename = realpathSync(candidate);
    if (!inside(realpathSync(this.path), filename))
      throw new ViewError('INVALID_VIEW', 'Template symlink escapes root');
    return filename;
  }
  #checkSize(size: number, isFile: boolean): void {
    if (!isFile || size > this.maxTemplateBytes)
      throw new ViewError('INVALID_VIEW', 'Invalid or oversized template');
  }
  #checkSource(source: string): string {
    if (Buffer.byteLength(source) > this.maxTemplateBytes)
      throw new ViewError('INVALID_VIEW', 'Oversized template');
    return source.startsWith('\uFEFF') ? source.slice(1) : source;
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
   * Maps an absolute filename (lexical or real) back to a root-relative ID.
   * Returns undefined for anything outside the root.
   */
  viewFromFile(filename: string): string | undefined {
    const absolute = path.resolve(filename);
    for (const root of this.#roots()) {
      if (inside(root, absolute))
        return path.relative(root, absolute).split(path.sep).join('/');
    }
    return undefined;
  }
  #roots(): string[] {
    try {
      const real = realpathSync(this.path);
      return real === this.path ? [this.path] : [this.path, real];
    } catch {
      return [this.path];
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
