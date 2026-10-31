import { LiveClientError } from './grammar.js';

export interface UrlStateEffect {
  readonly key: string;
  readonly value: string | null;
  readonly history: 'replace' | 'push';
}
/** Query keys and values only: effects cannot choose an origin, path or fragment. */
export function parseUrlEffects(input: unknown): readonly UrlStateEffect[] {
  if (
    !Array.isArray(input) ||
    input.length > 64 ||
    JSON.stringify(input).length > 8192
  )
    throw new LiveClientError('RESPONSE', 'Invalid URL state effects');
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new LiveClientError('RESPONSE', 'Invalid URL state effect');
    const key: unknown = Reflect.get(item, 'key');
    const value: unknown = Reflect.get(item, 'value');
    const history: unknown = Reflect.get(item, 'history');
    if (
      Object.keys(item).some(
        (name) => !['key', 'value', 'history'].includes(name),
      ) ||
      typeof key !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key) ||
      seen.has(key) ||
      (value !== null && typeof value !== 'string') ||
      (history !== 'replace' && history !== 'push')
    )
      throw new LiveClientError('RESPONSE', 'Invalid URL state effect');
    seen.add(key);
    return Object.freeze({ key, value, history });
  });
}

/** Preserve host history state and unrelated query parameters. No change means no entry. */
export function applyUrlEffects(
  view: Window,
  effects: readonly UrlStateEffect[],
): boolean {
  const next = new URL(view.location.href);
  let push = false;
  for (const effect of effects) {
    const prior = next.searchParams.getAll(effect.key);
    const changed =
      effect.value === null
        ? prior.length > 0
        : prior.length !== 1 || prior[0] !== effect.value;
    if (!changed) continue;
    if (effect.history === 'push') push = true;
    if (effect.value === null) next.searchParams.delete(effect.key);
    else next.searchParams.set(effect.key, effect.value);
  }
  if (next.href === view.location.href) return false;
  // Match the mount-side URL limit including its path. Failure suspends the
  // component so an already executed mutation is never automatically retried.
  if (new TextEncoder().encode(next.pathname + next.search).byteLength > 8192)
    throw new LiveClientError(
      'RESPONSE',
      'URL state exceeds the document URL limit',
    );
  if (push) view.history.pushState(view.history.state, '', next.href);
  else view.history.replaceState(view.history.state, '', next.href);
  return true;
}
