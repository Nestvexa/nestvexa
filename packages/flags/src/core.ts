import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** Server-derived evaluation context. Never build it from client input. */
export interface FlagContext {
  readonly identity?: string;
  readonly tenant?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface FlagProvider {
  evaluate(flag: string, context: FlagContext): boolean | Promise<boolean>;
}

export type FlagRule =
  | boolean
  | {
      readonly enabled?: boolean;
      readonly allow?: readonly string[];
      readonly deny?: readonly string[];
      /** 0–100; deterministic per (flag, identity). Requires an identity. */
      readonly percentage?: number;
    };

const flagPattern = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Validate a flag name: lowercase words separated by `-`, `_` or `.`, at most 64 characters. */
export function assertFlagName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length > 64 ||
    !flagPattern.test(name) ||
    forbidden.has(name)
  )
    throw new Error('Invalid feature flag name');
}

function plain(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor))
    throw new Error('Feature flag configuration must use data properties');
  return descriptor?.value;
}
function strings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 10_000 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 512)
  )
    throw new Error(`Invalid feature flag ${label} list`);
  return Object.freeze([...(value as string[])]);
}

interface CompiledRule {
  readonly enabled: boolean | undefined;
  readonly allow: ReadonlySet<string>;
  readonly deny: ReadonlySet<string>;
  readonly percentage: number | undefined;
}

/** Deterministic 0–99 rollout bucket for a flag and identity. */
export function rolloutBucket(flag: string, identity: string): number {
  return (
    createHash('sha256')
      .update(`${flag}:${identity}`)
      .digest()
      .readUInt32BE(0) % 100
  );
}

/**
 * In-process rules: `true`/`false`, or `{ enabled, allow, deny, percentage }`.
 * Precedence: deny, allow, enabled:false, percentage, enabled.
 */
export class StaticFlagProvider implements FlagProvider {
  readonly #rules = new Map<string, CompiledRule>();
  constructor(rules: Readonly<Record<string, FlagRule>>) {
    if (!plain(rules)) throw new Error('Flag rules must be a plain object');
    for (const key of Reflect.ownKeys(rules)) {
      if (typeof key !== 'string') throw new Error('Invalid feature flag name');
      assertFlagName(key);
      const rule = own(rules, key);
      if (typeof rule === 'boolean') {
        this.#rules.set(key, {
          enabled: rule,
          allow: new Set(),
          deny: new Set(),
          percentage: undefined,
        });
        continue;
      }
      if (!plain(rule)) throw new Error(`Invalid rule for flag ${key}`);
      for (const field of Reflect.ownKeys(rule))
        if (
          typeof field !== 'string' ||
          !['enabled', 'allow', 'deny', 'percentage'].includes(field)
        )
          throw new Error(`Unknown field in rule for flag ${key}`);
      const enabled = own(rule, 'enabled');
      const percentage = own(rule, 'percentage');
      if (enabled !== undefined && typeof enabled !== 'boolean')
        throw new Error(`Invalid enabled value for flag ${key}`);
      if (
        percentage !== undefined &&
        (typeof percentage !== 'number' ||
          !Number.isFinite(percentage) ||
          percentage < 0 ||
          percentage > 100)
      )
        throw new Error(`Invalid percentage for flag ${key}`);
      this.#rules.set(key, {
        enabled,
        allow: new Set(strings(own(rule, 'allow'), 'allow')),
        deny: new Set(strings(own(rule, 'deny'), 'deny')),
        percentage,
      });
    }
  }
  evaluate(flag: string, context: FlagContext): boolean {
    const rule = this.#rules.get(flag);
    if (!rule) return false;
    const identity = context.identity;
    if (identity !== undefined && rule.deny.has(identity)) return false;
    if (identity !== undefined && rule.allow.has(identity)) return true;
    if (rule.enabled === false) return false;
    if (rule.percentage !== undefined)
      return (
        identity !== undefined &&
        rolloutBucket(flag, identity) < rule.percentage
      );
    return rule.enabled === true;
  }
}

export interface FlagServiceOptions {
  readonly provider: FlagProvider;
  /** Closed allowlist of known flags; any other name throws. */
  readonly flags: readonly string[];
  readonly onError?: (error: unknown, flag: string) => void;
  /** Provider timeout in milliseconds; default 1000. */
  readonly timeoutMs?: number;
}

function copyContext(context: FlagContext): FlagContext {
  if (!plain(context)) throw new Error('Flag context must be a plain object');
  const identity = own(context, 'identity');
  const tenant = own(context, 'tenant');
  const attributes = own(context, 'attributes');
  if (identity !== undefined && typeof identity !== 'string')
    throw new Error('Flag context identity must be text');
  if (tenant !== undefined && typeof tenant !== 'string')
    throw new Error('Flag context tenant must be text');
  let copied: Record<string, string | number | boolean> | undefined;
  if (attributes !== undefined) {
    if (!plain(attributes)) throw new Error('Flag attributes must be plain');
    copied = Object.create(null) as Record<string, string | number | boolean>;
    for (const key of Reflect.ownKeys(attributes)) {
      const value = typeof key === 'string' ? own(attributes, key) : undefined;
      if (
        typeof key !== 'string' ||
        forbidden.has(key) ||
        !['string', 'number', 'boolean'].includes(typeof value)
      )
        throw new Error('Invalid flag attribute');
      copied[key] = value as string | number | boolean;
    }
    Object.freeze(copied);
  }
  return Object.freeze({
    ...(identity === undefined ? {} : { identity }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(copied === undefined ? {} : { attributes: copied }),
  });
}

/** Evaluates known flags through a provider and fails closed. */
export class FlagService {
  readonly flags: readonly string[];
  readonly #provider: FlagProvider;
  readonly #onError: ((error: unknown, flag: string) => void) | undefined;
  readonly #timeout: number;
  constructor(options: FlagServiceOptions) {
    if (!options || typeof options.provider?.evaluate !== 'function')
      throw new Error('FlagService requires a provider');
    if (!Array.isArray(options.flags) || options.flags.length > 1000)
      throw new Error('FlagService requires a flag allowlist');
    for (const flag of options.flags) assertFlagName(flag);
    if (new Set(options.flags).size !== options.flags.length)
      throw new Error('Duplicate feature flag');
    this.flags = Object.freeze([...options.flags].sort());
    this.#provider = options.provider;
    this.#onError = options.onError;
    this.#timeout = options.timeoutMs ?? 1000;
    if (
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 60_000
    )
      throw new Error('Flag timeout must be 1–60000 milliseconds');
  }
  #known(flag: unknown): asserts flag is string {
    if (typeof flag !== 'string' || !this.flags.includes(flag))
      throw new Error(`Unknown feature flag: ${String(flag).slice(0, 64)}`);
  }
  #report(error: unknown, flag: string): void {
    try {
      this.#onError?.(error, flag);
    } catch {
      // Reporting must never turn a closed flag into a thrown request.
    }
  }
  async isEnabled(flag: string, context: FlagContext): Promise<boolean> {
    this.#known(flag);
    const safe = copyContext(context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Feature flag provider timed out')),
          this.#timeout,
        );
      });
      timeout.catch(() => undefined);
      const result: unknown = await Promise.race([
        Promise.resolve().then(() => this.#provider.evaluate(flag, safe)),
        timeout,
      ]);
      if (typeof result !== 'boolean') {
        this.#report(new Error('Non-boolean flag value'), flag);
        return false;
      }
      return result;
    } catch (error) {
      this.#report(error, flag);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async evaluate(
    context: FlagContext,
    flags: readonly string[] = this.flags,
  ): Promise<Readonly<Record<string, boolean>>> {
    for (const flag of flags) this.#known(flag);
    const values = await Promise.all(
      flags.map((flag) => this.isEnabled(flag, context)),
    );
    const result = Object.create(null) as Record<string, boolean>;
    flags.forEach((flag, index) => {
      result[flag] = values[index] === true;
    });
    return Object.freeze(result);
  }
  async assert(flag: string, context: FlagContext): Promise<void> {
    if (!(await this.isEnabled(flag, context)))
      throw new ForbiddenException('Feature unavailable');
  }
}

/** Order-independent short hash of evaluated flags, for shared cache keys. */
export function flagFingerprint(
  values: Readonly<Record<string, boolean>>,
): string {
  const entries = Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key] === true ? 1 : 0}`);
  return createHash('sha256')
    .update(entries.join('\n'))
    .digest('hex')
    .slice(0, 16);
}

export type FlagHelper = (...args: unknown[]) => unknown;

/**
 * HBS helpers. `{{#if (flag "bulk-export")}}` reads the precomputed `flags`
 * object of the root view model; only an own `true` value enables content.
 */
export function flagHelpers(): Readonly<Record<string, FlagHelper>> {
  return Object.freeze({
    flag: (...args: unknown[]): boolean => {
      const name = args[0];
      const options = args.at(-1);
      if (typeof name !== 'string' || args.length < 2 || !isObject(options))
        return false;
      const data = read(options, 'data');
      const root = isObject(data) ? read(data, 'root') : undefined;
      const flags = isObject(root) ? read(root, 'flags') : undefined;
      return isObject(flags) && read(flags, name) === true;
    },
  });
}
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
function read(value: object, key: string): unknown {
  if (forbidden.has(key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
