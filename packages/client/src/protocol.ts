import { LiveClientError, parseIdentifier } from './grammar.js';
import { parseBindingDirective } from './bindings.js';
import type { BindingDirective } from './bindings.js';
import { parseConfirmation, parseEventDirective } from './events.js';
import type { EventDirective } from './events.js';
import { parseModelDirective } from './models.js';
import { parseLoadingDirective, parseLoadingTarget } from './loading.js';
import type { LoadingDirective } from './loading.js';
export { LiveClientError, parseIdentifier } from './grammar.js';
export type LiveDirective =
  | { readonly kind: 'click' | 'submit' | 'model'; readonly value: string }
  | { readonly kind: 'loading' | 'ignore'; readonly value: '' }
  | { readonly kind: 'ignore'; readonly self: true; readonly value: '' }
  | BindingDirective
  | EventDirective
  | LoadingDirective
  | ReplacementDirective
  | { readonly kind: 'confirm'; readonly message: string }
  | { readonly kind: 'target'; readonly actions: readonly string[] };
// Additional directives remain data-only configuration.
export type ReplacementDirective = {
  readonly kind: 'replace';
  readonly self: boolean;
};
/** Closed directive grammar: only the implemented data bindings and event modifiers are accepted. */
export function parseDirective(name: string, value: string): LiveDirective {
  const kind = name.slice(3);
  if (!name.startsWith('nv:'))
    throw new LiveClientError('DIRECTIVE', 'Expected an nv: directive');
  if (kind === 'confirm') return { kind, message: parseConfirmation(value) };
  if (kind === 'click' || kind === 'submit' || kind === 'model')
    return { kind, value: parseIdentifier(value) };
  if (/^nv:(?:click|submit|keydown)(?:\.|$)/.test(name))
    return parseEventDirective(name, value);
  if (name.startsWith('nv:model.'))
    return { kind: 'model', value: parseModelDirective(name, value).field };
  if ((kind === 'loading' || kind === 'ignore') && value === '')
    return { kind, value };
  if (name === 'nv:ignore.self' && value === '')
    return { kind: 'ignore', self: true, value };
  if (name === 'nv:target')
    return { kind: 'target', actions: parseLoadingTarget(value) };
  if (name.startsWith('nv:loading.')) return parseLoadingDirective(name, value);
  if ((name === 'nv:replace' || name === 'nv:replace.self') && value === '')
    return { kind: 'replace', self: name === 'nv:replace.self' };
  if (['text', 'show', 'bind', 'dirty', 'cloak', 'ref'].includes(kind))
    return parseBindingDirective(name, value);
  throw new LiveClientError(
    'DIRECTIVE',
    `Unsupported directive or modifier: ${name}`,
  );
}
export interface LiveResponse {
  readonly protocol: 'nestvexa-live/1';
  readonly requestId: string;
  readonly component: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
  };
  readonly snapshot: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly html: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Validates response metadata before it can change snapshots or owned DOM. */
export function parseLiveResponse(value: unknown): LiveResponse {
  if (
    !record(value) ||
    value['protocol'] !== 'nestvexa-live/1' ||
    typeof value['requestId'] !== 'string' ||
    value['requestId'].length > 128 ||
    !record(value['component']) ||
    !record(value['state'])
  )
    throw new LiveClientError('RESPONSE', 'Invalid Live response envelope');
  const component = value['component'];
  if (
    typeof component['id'] !== 'string' ||
    !component['id'] ||
    component['id'].length > 128 ||
    typeof component['name'] !== 'string' ||
    !Number.isSafeInteger(component['revision']) ||
    typeof component['revision'] !== 'number' ||
    component['revision'] < 0
  )
    throw new LiveClientError('RESPONSE', 'Invalid Live component metadata');
  parseIdentifier(component['name']);
  if (
    typeof value['snapshot'] !== 'string' ||
    !value['snapshot'] ||
    value['snapshot'].length > 65_536 ||
    typeof value['html'] !== 'string' ||
    value['html'].length > 1_048_576
  )
    throw new LiveClientError(
      'RESPONSE',
      'Invalid or oversized Live response content',
    );
  for (const key of Object.keys(value['state'])) parseIdentifier(key);
  return {
    protocol: 'nestvexa-live/1',
    requestId: value['requestId'],
    component: {
      id: component['id'],
      name: component['name'],
      revision: component['revision'],
    },
    snapshot: value['snapshot'],
    state: value['state'],
    html: value['html'],
  };
}
