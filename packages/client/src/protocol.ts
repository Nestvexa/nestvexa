import { LiveClientError, parseIdentifier } from './grammar.js';
import { parseBindingDirective } from './bindings.js';
import type { BindingDirective } from './bindings.js';
import { parseConfirmation, parseEventDirective } from './events.js';
import type { EventDirective } from './events.js';
import { parseModelDirective } from './models.js';
import { parseLoadingDirective, parseLoadingTarget } from './loading.js';
import type { LoadingDirective } from './loading.js';
import { parseUrlEffects } from './url-state.js';
import type { UrlStateEffect } from './url-state.js';
import { parseObserverDirective } from './observers.js';
import type { ObserverDirective } from './observers.js';
import { parsePresentationDirective } from './presentation.js';
import type { PresentationDirective } from './presentation.js';
import type { InitializationTiming } from './initialization.js';
import { parseSortDirective } from './sort.js';
import type { SortDirective } from './sort.js';
import { parseStreamDirective } from './stream.js';
import type { StreamDirective } from './stream.js';
import { parseNavigateDirective } from './navigation.js';
import type { NavigateDirective } from './navigation.js';
import { parseOptimisticDirective } from './optimistic.js';
import type { OptimisticDirective } from './optimistic.js';
import { parseUploadDirective } from './upload.js';
import type { UploadDirective } from './upload.js';
export { LiveClientError, parseIdentifier } from './grammar.js';
export type LiveDirective =
  | {
      readonly kind: 'click' | 'submit' | 'model';
      readonly value: string;
    }
  | {
      readonly kind: 'init';
      readonly value: string;
      readonly timing?: InitializationTiming;
    }
  | { readonly kind: 'loading' | 'ignore'; readonly value: '' }
  | { readonly kind: 'ignore'; readonly self: true; readonly value: '' }
  | BindingDirective
  | EventDirective
  | LoadingDirective
  | ObserverDirective
  | PresentationDirective
  | SortDirective
  | StreamDirective
  | ReplacementDirective
  | NavigateDirective
  | OptimisticDirective
  | UploadDirective
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
  if (/^nv:sort(?:\.|$)/.test(name)) return parseSortDirective(name, value);
  if (/^nv:navigate(?:\.|$)/.test(name))
    return parseNavigateDirective(name, value);
  if (/^nv:optimistic(?:\.|$)/.test(name))
    return parseOptimisticDirective(name, value);
  if (/^nv:stream(?:\.|$)/.test(name)) return parseStreamDirective(name, value);
  if (/^nv:upload(?:\.|$)/.test(name)) return parseUploadDirective(name, value);
  if (/^nv:(?:poll|intersect)(?:\.|$)/.test(name))
    return parseObserverDirective(name, value);
  if (/^nv:(?:offline|current|transition)(?:\.|$)/.test(name))
    return parsePresentationDirective(name, value);
  if (/^nv:init(?:\.(visible|idle))?$/.test(name)) {
    const timing =
      name === 'nv:init.visible'
        ? 'visible'
        : name === 'nv:init.idle'
          ? 'idle'
          : undefined;
    return {
      kind: 'init',
      value: parseIdentifier(value),
      ...(timing === undefined ? {} : { timing }),
    };
  }
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
  /** State-only acknowledgement, negotiated by renderless-v1; html must be empty. */
  readonly renderless?: true;
  readonly url?: readonly UrlStateEffect[];
  /** Server-dispatched events for listening components; payloads are public data. */
  readonly events?: readonly LiveEvent[];
  /** Application-relative path to visit after this response commits. */
  readonly redirect?: string;
  /** Fresh realtime subscription token for this component. */
  readonly realtime?: string;
  /** Single-use same-origin attachment created by the action. */
  readonly download?: { readonly url: string; readonly filename: string };
}
export interface LiveEvent {
  readonly name: string;
  readonly payload: unknown;
  readonly to?: string;
  readonly self?: true;
}
const eventName = /^[a-z][a-z0-9:.-]{0,63}$/;
/** Validate an event name used by dispatch APIs and server responses. */
export function parseEventName(value: unknown): string {
  if (typeof value !== 'string' || !eventName.test(value))
    throw new LiveClientError('DIRECTIVE', 'Invalid Live event name');
  return value;
}
function parseEvents(value: unknown): readonly LiveEvent[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new LiveClientError('RESPONSE', 'Invalid Live events');
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      Object.keys(item).some(
        (key) => !['name', 'payload', 'to', 'self'].includes(key),
      ) ||
      typeof item['name'] !== 'string' ||
      !eventName.test(item['name']) ||
      !Object.hasOwn(item, 'payload') ||
      JSON.stringify(item['payload']).length > 16_384 ||
      (item['to'] !== undefined &&
        (typeof item['to'] !== 'string' ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(item['to']))) ||
      (item['self'] !== undefined && item['self'] !== true) ||
      (item['self'] === true && item['to'] !== undefined)
    )
      throw new LiveClientError('RESPONSE', 'Invalid Live event');
    return Object.freeze({
      name: item['name'],
      payload: item['payload'],
      ...(typeof item['to'] === 'string' ? { to: item['to'] } : {}),
      ...(item['self'] === true ? { self: true as const } : {}),
    });
  });
}
/** Same-document application path only; never a scheme, host or protocol-relative URL. */
export function parseRedirect(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.length > 2048 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new LiveClientError('RESPONSE', 'Unsafe Live redirect');
  return value;
}
function parseRealtimeToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,6000}\.[A-Za-z0-9_-]{20,100}$/.test(value)
  )
    throw new LiveClientError('RESPONSE', 'Invalid realtime token');
  return value;
}
function parseDownload(value: unknown): {
  readonly url: string;
  readonly filename: string;
} {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    typeof value['filename'] !== 'string' ||
    !value['filename'] ||
    value['filename'].length > 180 ||
    !/\/_download\/[A-Za-z0-9_-]{43}$/.test(String(value['url']))
  )
    throw new LiveClientError('RESPONSE', 'Invalid Live download');
  return Object.freeze({
    url: parseRedirect(value['url']),
    filename: value['filename'],
  });
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
    value['html'].length > 1_048_576 ||
    (Object.hasOwn(value, 'renderless') && value['renderless'] !== true) ||
    (value['renderless'] === true && value['html'] !== '')
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
    ...(value['renderless'] === true ? { renderless: true } : {}),
    ...(value['url'] === undefined
      ? {}
      : { url: parseUrlEffects(value['url']) }),
    ...(value['events'] === undefined
      ? {}
      : { events: parseEvents(value['events']) }),
    ...(value['redirect'] === undefined
      ? {}
      : { redirect: parseRedirect(value['redirect']) }),
    ...(value['download'] === undefined
      ? {}
      : { download: parseDownload(value['download']) }),
    ...(value['realtime'] === undefined
      ? {}
      : { realtime: parseRealtimeToken(value['realtime']) }),
  };
}
