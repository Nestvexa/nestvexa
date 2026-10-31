import { createHash } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { StateOptions } from './metadata.js';
import { cloneState, freezeJson, LiveProtocolError } from './protocol.js';
import type { JsonValue } from './protocol.js';

/** Query state is public, writable state, never an identity or authorization source. */
export interface UrlOptions {
  readonly key?: string;
  readonly history?: 'replace' | 'push';
  /** Omit this primitive value from the query string. */
  readonly except?: string | number | boolean;
}
/** Host-owned session storage; ttl is in milliseconds, default 30 minutes. */
export interface SessionOptions {
  readonly key?: string;
  readonly ttl?: number;
}
export interface UrlStateDefinition {
  readonly key: string;
  readonly history: 'replace' | 'push';
  readonly except?: string | number | boolean;
}
export interface SessionStateDefinition {
  readonly key: string;
  readonly ttl: number;
}
export interface StateContextDefinition {
  readonly url: ReadonlyMap<string, UrlStateDefinition>;
  readonly session: ReadonlyMap<string, SessionStateDefinition>;
}
export interface UrlStateEffect {
  readonly key: string;
  readonly value: string | null;
  readonly history: 'replace' | 'push';
}

const URL_STATE = Symbol('nv:url-state');
const SESSION_STATE = Symbol('nv:session-state');
const forbidden = new Set(['constructor', '__proto__', 'prototype']);
const maxQueryBytes = 8_192;
const maxFields = 64;

function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) ||
    forbidden.has(value)
  )
    throw new Error('Invalid URL/session state name');
  return value;
}
function options(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid URL/session state options');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('URL/session options must be plain data');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor ||
      !('value' in descriptor)
    )
      throw new Error('URL/session options must use known own data properties');
  }
}
function primitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function decorate<T>(
  symbol: symbol,
  make: (field: string) => T,
): PropertyDecorator {
  return (target, key) => {
    const field = name(key);
    const prior: Map<string, T> | undefined = Reflect.getMetadata(
      symbol,
      target,
    );
    const own: Map<string, T> | undefined = Reflect.getOwnMetadata(
      symbol,
      target,
    );
    if (own?.has(field)) throw new Error('Duplicate URL/session decorator');
    const entries = new Map(prior);
    entries.set(field, make(field));
    Reflect.defineMetadata(symbol, entries, target);
  };
}

/** Preserve a primitive @State field in the current document query string. */
export function Url(value: UrlOptions = {}): PropertyDecorator {
  options(value, ['key', 'history', 'except']);
  const selected = Object.freeze(
    Object.assign(Object.create(null) as UrlOptions, value),
  );
  if (selected.key !== undefined) name(selected.key);
  if (
    selected.history !== undefined &&
    selected.history !== 'push' &&
    selected.history !== 'replace'
  )
    throw new Error('URL history must be push or replace');
  if (selected.except !== undefined && !primitive(selected.except))
    throw new Error('URL except must be a finite primitive');
  return decorate(URL_STATE, (field) =>
    Object.freeze({
      key: selected.key ?? field,
      history: selected.history ?? 'replace',
      ...(selected.except === undefined ? {} : { except: selected.except }),
    }),
  );
}

/** Persist public JSON state in the host's authenticated session, scoped to its binding. */
export function Session(value: SessionOptions = {}): PropertyDecorator {
  options(value, ['key', 'ttl']);
  const selected = Object.freeze(
    Object.assign(Object.create(null) as SessionOptions, value),
  );
  if (selected.key !== undefined) name(selected.key);
  if (
    selected.ttl !== undefined &&
    (!Number.isSafeInteger(selected.ttl) ||
      selected.ttl < 1 ||
      selected.ttl > 86_400_000)
  )
    throw new Error('Session state ttl must be 1–86400000 milliseconds');
  return decorate(SESSION_STATE, (field) =>
    Object.freeze({
      key: selected.key ?? field,
      ttl: selected.ttl ?? 1_800_000,
    }),
  );
}

/** Validate decorator pairing and aliases at component registration, never from browser names. */
export function collectStateContext(
  type: Type<object>,
  states: ReadonlyMap<string, StateOptions>,
): StateContextDefinition {
  const url = new Map<string, UrlStateDefinition>(
    Reflect.getMetadata(URL_STATE, type.prototype),
  );
  const session = new Map<string, SessionStateDefinition>(
    Reflect.getMetadata(SESSION_STATE, type.prototype),
  );
  for (const entries of [url, session]) {
    if (entries.size > maxFields)
      throw new Error('At most 64 URL/session state fields per component');
    const aliases = new Set<string>();
    for (const [field, entry] of entries) {
      if (!states.has(field))
        throw new Error(`URL/session field ${field} requires @State`);
      if (aliases.has(entry.key))
        throw new Error(`Duplicate URL/session key ${entry.key}`);
      aliases.add(entry.key);
    }
  }
  for (const field of url.keys())
    if (states.get(field)?.writable !== true)
      throw new Error(`URL state ${field} requires writable:true`);
  return Object.freeze({ url, session });
}

function invalid(code: string, status = 422): never {
  throw new LiveProtocolError(code, status, 'Invalid URL/session state');
}
function ownValue(instance: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(instance, field);
  if (!descriptor || !('value' in descriptor) || descriptor.writable !== true)
    throw new Error(
      `URL/session state ${field} must be an own writable data field`,
    );
  return descriptor.value;
}
function sessionBag(request: object): object {
  const session: unknown = Reflect.get(request, 'session');
  if (!session || typeof session !== 'object' || Array.isArray(session))
    invalid('SESSION_REQUIRED', 503);
  return session;
}
function slot(binding: string, component: string, key: string): string {
  if (
    typeof binding !== 'string' ||
    binding.length < 16 ||
    binding.length > 1024
  )
    invalid('IDENTITY_REQUIRED', 401);
  name(component);
  return `nestvexa:state:${createHash('sha256').update(binding).digest('hex')}:${component}:${key}`;
}
function clock(now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - 86_400_000
  )
    throw new Error('Invalid session clock');
}
function query(request: object): URLSearchParams {
  const original: unknown = Reflect.get(request, 'originalUrl');
  const path: unknown =
    typeof original === 'string' ? original : Reflect.get(request, 'url');
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    Buffer.byteLength(path, 'utf8') > maxQueryBytes ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return (
        code < 32 || code === 127 || character === '\\' || character === '#'
      );
    }) ||
    /%(?![a-f\d]{2})/i.test(path)
  )
    invalid('INVALID_URL_STATE');
  try {
    decodeURIComponent(path);
    encodeURIComponent(path);
  } catch {
    invalid('INVALID_URL_STATE');
  }
  const parameters = new URL(path, 'http://nestvexa.invalid').searchParams;
  if (parameters.size > 128) invalid('INVALID_URL_STATE');
  return parameters;
}
function parse(value: string, initial: unknown): string | number | boolean {
  if (typeof initial === 'string') return value;
  if (typeof initial === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    invalid('INVALID_URL_STATE');
  }
  if (typeof initial === 'number' && Number.isFinite(initial)) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
      invalid('INVALID_URL_STATE');
    const converted = Number(value);
    if (!Number.isFinite(converted)) invalid('INVALID_URL_STATE');
    return converted;
  }
  throw new Error(
    'URL state supports initialized strings, finite numbers, and booleans',
  );
}
function readSession(
  bag: object,
  key: string,
  now: number,
): JsonValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(bag, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) invalid('INVALID_SESSION_STATE');
  const record = cloneState({ record: descriptor.value })['record'];
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).length !== 2 ||
    typeof record['expiresAt'] !== 'number' ||
    !Number.isSafeInteger(record['expiresAt']) ||
    record['expiresAt'] < 0 ||
    !Object.hasOwn(record, 'value')
  )
    invalid('INVALID_SESSION_STATE');
  if (record['expiresAt'] <= now) return undefined;
  return record['value'];
}

/** Mount only: session values load first, then explicit query values, with atomic validation. */
export async function hydrateStateContext(
  instance: object,
  component: string,
  definition: StateContextDefinition,
  states: ReadonlyMap<string, StateOptions>,
  request: object,
  binding: string,
  now = Date.now(),
): Promise<void> {
  clock(now);
  const pending: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  const initials = new Map<string, unknown>();
  for (const field of new Set([
    ...definition.session.keys(),
    ...definition.url.keys(),
  ]))
    initials.set(field, ownValue(instance, field));
  if (definition.session.size) {
    const bag = sessionBag(request);
    for (const [field, entry] of definition.session) {
      const value = readSession(bag, slot(binding, component, entry.key), now);
      if (value !== undefined) pending[field] = value;
    }
  }
  if (definition.url.size) {
    const parameters = query(request);
    for (const [field, entry] of definition.url) {
      const initial = initials.get(field);
      if (!primitive(initial))
        throw new Error(
          'URL state supports initialized strings, finite numbers, and booleans',
        );
      if (entry.except !== undefined && typeof entry.except !== typeof initial)
        throw new Error('URL except must match the initialized state type');
      const values = parameters.getAll(entry.key);
      if (values.length > 1) invalid('INVALID_URL_STATE');
      if (values.length) pending[field] = parse(values[0] ?? '', initial);
      else if (
        Object.hasOwn(pending, field) &&
        typeof pending[field] !== typeof initial
      )
        invalid('INVALID_SESSION_STATE');
    }
  }
  const detached = freezeJson(cloneState(pending));
  for (const [field, value] of Object.entries(detached)) {
    const validate = states.get(field)?.validate;
    if (validate && (await validate(value)) !== true)
      invalid('STATE_VALIDATION');
  }
  for (const [field, value] of Object.entries(cloneState(detached)))
    Object.defineProperty(instance, field, { value });
}

/** Persist only after a successful action/render/store commit, and after mount has completed. */
export function persistStateContext(
  instance: object,
  component: string,
  definition: StateContextDefinition,
  request: object,
  binding: string,
  now = Date.now(),
): void {
  clock(now);
  if (!definition.session.size) return;
  const bag = sessionBag(request);
  const pending: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [field, entry] of definition.session) {
    const key = slot(binding, component, entry.key);
    const descriptor = Object.getOwnPropertyDescriptor(bag, key);
    if (
      descriptor
        ? !('value' in descriptor) || !descriptor.writable
        : !Object.isExtensible(bag)
    )
      invalid('SESSION_WRITE_FAILED', 503);
    pending[key] = {
      value: cloneState({ value: ownValue(instance, field) })['value'] ?? null,
      expiresAt: now + entry.ttl,
    };
  }
  const values = cloneState(pending);
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(
      bag,
      key,
      Object.hasOwn(bag, key)
        ? { value }
        : { value, enumerable: true, writable: true, configurable: true },
    );
}

/** Client consumes these fixed key/value effects; no URL/path or executable expression is supplied. */
export function urlStateEffects(
  instance: object,
  definition: StateContextDefinition,
): readonly UrlStateEffect[] {
  const effects: UrlStateEffect[] = [];
  for (const [field, entry] of definition.url) {
    const value = ownValue(instance, field);
    if (!primitive(value)) invalid('INVALID_URL_STATE');
    if (
      typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') > maxQueryBytes
    )
      invalid('INVALID_URL_STATE');
    effects.push(
      Object.freeze({
        key: entry.key,
        value: value === entry.except ? null : String(value),
        history: entry.history,
      }),
    );
  }
  if (Buffer.byteLength(JSON.stringify(effects), 'utf8') > maxQueryBytes)
    invalid('INVALID_URL_STATE');
  return Object.freeze(effects);
}
