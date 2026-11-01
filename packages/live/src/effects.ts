import { cloneState, freezeJson } from './protocol.js';
import type { JsonValue } from './protocol.js';

/** A browser-routed event. Its payload is public and untrusted when it returns. */
export interface LiveEvent {
  readonly name: string;
  readonly payload: JsonValue;
  /** Deliver only to components with this registered name. */
  readonly to?: string;
  /** Deliver only to the dispatching component. */
  readonly self?: true;
}
export interface DispatchOptions {
  readonly to?: string;
  readonly self?: boolean;
}
/** A one-time attachment created by an action and fetched by the same identity. */
export interface LiveDownload {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}
export interface DownloadOptions {
  readonly filename: string;
  readonly contentType?: string;
  readonly body: string | Uint8Array;
}
interface Effects {
  readonly events: LiveEvent[];
  readonly flash: string[];
  redirect?: string;
  download?: LiveDownload;
}

const maxEvents = 16;
const maxDownloadBytes = 5 * 1024 * 1024;
const maxFlash = 8;
const maxEventBytes = 16_384;
const active = new WeakMap<object, Effects>();

/** Runtime-only: open an effect scope for one component operation. */
export function beginEffects(instance: object): void {
  active.set(instance, { events: [], flash: [] });
}
/** Runtime-only: close the scope and return detached effects. */
export function takeEffects(instance: object): {
  readonly events: readonly LiveEvent[];
  readonly flash: readonly string[];
  readonly redirect?: string;
  readonly download?: LiveDownload;
} {
  const effects = active.get(instance);
  active.delete(instance);
  if (!effects) return { events: [], flash: [] };
  return Object.freeze({
    events: Object.freeze([...effects.events]),
    flash: Object.freeze([...effects.flash]),
    ...(effects.redirect === undefined ? {} : { redirect: effects.redirect }),
    ...(effects.download === undefined ? {} : { download: effects.download }),
  });
}
function scope(instance: object): Effects {
  const effects = active.get(instance);
  if (!effects)
    throw new Error(
      'Live effects can only be recorded while a Live action is executing',
    );
  return effects;
}

/**
 * Ask the browser to deliver an event to listening components (`@OnEvent`).
 * Listeners receive the payload as ordinary action input, so it must pass their
 * pipes and host authorization like any other browser-supplied value.
 */
export function dispatchLiveEvent(
  component: object,
  name: string,
  payload: JsonValue = null,
  options: DispatchOptions = {},
): void {
  const effects = scope(component);
  if (typeof name !== 'string' || !/^[a-z][a-z0-9:.-]{0,63}$/.test(name))
    throw new Error(
      'Event names use lowercase letters, digits, ".", ":" and "-"',
    );
  if (options.to !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(options.to))
    throw new Error('Event target must be a registered component name');
  if (options.self !== undefined && typeof options.self !== 'boolean')
    throw new Error('Event self option must be a boolean');
  if (options.self === true && options.to !== undefined)
    throw new Error('Event self and to options are exclusive');
  if (effects.events.length >= maxEvents)
    throw new Error(`At most ${maxEvents} Live events per action`);
  const detached = freezeJson(cloneState({ payload }))['payload'] ?? null;
  if (Buffer.byteLength(JSON.stringify(detached)) > maxEventBytes)
    throw new Error('Live event payload exceeds 16 KiB');
  effects.events.push(
    Object.freeze({
      name,
      payload: detached,
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.self === true ? { self: true as const } : {}),
    }),
  );
}

/** Validate an application-relative redirect target; absolute and scheme URLs are rejected. */
export function safeRedirectPath(url: string): string {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > 2048 ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('\\') ||
    [...url].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error(
      'Live redirects require an application-relative path such as /items/2',
    );
  const parsed = new URL(url, 'http://nestvexa.invalid');
  if (parsed.origin !== 'http://nestvexa.invalid')
    throw new Error('Live redirects must stay on the current origin');
  return parsed.pathname + parsed.search + parsed.hash;
}

/** Reduce a host-supplied name to a safe attachment filename. */
export function safeFilename(name: string): string {
  if (typeof name !== 'string')
    throw new Error('Download filename is required');
  const cleaned = [...name.normalize('NFC')]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 && !'/\\:*?"<>|'.includes(character);
    })
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  if (!cleaned)
    throw new Error('Download filename is empty after sanitization');
  return cleaned;
}

/**
 * After this action commits, give the same identity a single-use, short-lived
 * attachment URL. Bodies are limited to 5 MiB and kept in process memory.
 */
export function downloadLive(
  component: object,
  options: DownloadOptions,
): void {
  const effects = scope(component);
  const contentType = options.contentType ?? 'application/octet-stream';
  if (
    typeof contentType !== 'string' ||
    !/^[a-z0-9][a-z0-9!#/** After this action commits, navigate the browser to an application-relative path. */^_.+-]{0,63}\/[a-z0-9][a-z0-9!#/** After this action commits, navigate the browser to an application-relative path. */^_.+-]{0,63}(?:;\s*charset=[a-z0-9_-]{1,32})?$/i.test(
      contentType,
    )
  )
    throw new Error('Download content type must be a simple media type');
  const body =
    typeof options.body === 'string'
      ? new TextEncoder().encode(options.body)
      : options.body;
  if (!(body instanceof Uint8Array) || body.byteLength > maxDownloadBytes)
    throw new Error('Download body must be at most 5 MiB of text or bytes');
  if (effects.download) throw new Error('At most one download per action');
  effects.download = Object.freeze({
    filename: safeFilename(options.filename),
    contentType,
    body: new Uint8Array(body),
  });
}

/**
 * Store a short message in the host session for the next document render.
 * Read it in a host controller with `consumeLiveFlash(request)`.
 */
export function flashLive(component: object, message: string): void {
  const effects = scope(component);
  if (typeof message !== 'string' || !message || message.length > 500)
    throw new Error('Flash messages are 1–500 characters');
  if (effects.flash.length >= maxFlash)
    throw new Error(`At most ${maxFlash} flash messages per action`);
  effects.flash.push(message);
}

const flashKey = 'nestvexa:flash';
/** Runtime-only: append messages to the host session after commit. */
export function persistFlash(
  request: object,
  messages: readonly string[],
): void {
  if (!messages.length) return;
  const session: unknown = Reflect.get(request, 'session');
  if (!session || typeof session !== 'object')
    throw new Error('Flash messages require a host session');
  const prior: unknown = Reflect.get(session, flashKey);
  const list = Array.isArray(prior)
    ? prior.filter((item): item is string => typeof item === 'string')
    : [];
  Reflect.set(session, flashKey, [...list, ...messages].slice(-maxFlash));
}
/** Read and remove pending flash messages from the host session. */
export function consumeLiveFlash(request: object): readonly string[] {
  const session: unknown = Reflect.get(request, 'session');
  if (!session || typeof session !== 'object') return [];
  const prior: unknown = Reflect.get(session, flashKey);
  Reflect.deleteProperty(session, flashKey);
  return Array.isArray(prior)
    ? Object.freeze(
        prior
          .filter((item): item is string => typeof item === 'string')
          .slice(-maxFlash),
      )
    : [];
}

/** After this action commits, navigate the browser to an application-relative path. */
export function redirectLive(component: object, url: string): void {
  const effects = scope(component);
  effects.redirect = safeRedirectPath(url);
}
