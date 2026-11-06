import { LiveClientError } from './grammar.js';

export type RealtimeTransport = 'auto' | 'sse' | 'websocket' | 'polling';
export interface RealtimeEndpoint {
  /** Trusted same-origin realtime route prefix, for example `/_nestvexa/realtime`. */
  readonly endpoint: string;
  readonly transport?: RealtimeTransport;
}
export interface RealtimeMessage {
  readonly channel: string;
  readonly id: string;
  readonly data: unknown;
}
export interface RealtimeControllerOptions extends RealtimeEndpoint {
  readonly window: Window & typeof globalThis;
  readonly fetch: typeof fetch;
  readonly onMessage: (message: RealtimeMessage) => void;
  /** The server closed the stream because subscriptions expired or were revoked. */
  readonly onExpired: () => void;
}
export interface RealtimeController {
  /** Replace the subscription token set; reconnects only when it changed. */
  update(tokens: readonly string[]): void;
  /** The transport in use; `auto` resolves to `sse` and may fall back to `polling`. */
  readonly transport: Exclude<RealtimeTransport, 'auto'>;
  dispose(): void;
}
/** `auto`: SSE failures before the first `ready` that switch to long-polling. */
const autoFallbackFailures = 2;
/** `auto`: an SSE stream silent this long (for example a buffering proxy) falls back. */
const autoReadyTimeoutMs = 10_000;
/** Consecutive failed reconnects before the circuit opens (long cool-down). */
const circuitThreshold = 10;
const circuitCooldownMs = 300_000;
const tokenPattern = /^[A-Za-z0-9_-]{1,6000}\.[A-Za-z0-9_-]{20,100}$/;
/** Read the (public, server-signed) channel list from a subscription token. */
export function tokenChannels(token: string): readonly string[] {
  if (!tokenPattern.test(token))
    throw new LiveClientError('MARKER', 'Invalid realtime token');
  const body = token.slice(0, token.indexOf('.'));
  const json = atob(body.replaceAll('-', '+').replaceAll('_', '/'));
  const parsed: unknown = JSON.parse(json);
  const channels: unknown =
    parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'c') : undefined;
  if (
    !Array.isArray(channels) ||
    channels.length > 32 ||
    channels.some(
      (channel) =>
        typeof channel !== 'string' ||
        !/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(channel),
    )
  )
    throw new LiveClientError('MARKER', 'Invalid realtime token');
  return channels as string[];
}
function message(value: unknown): RealtimeMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const channel: unknown = Reflect.get(value, 'channel');
  const id: unknown = Reflect.get(value, 'id');
  if (typeof channel !== 'string' || typeof id !== 'string' || id.length > 128)
    return undefined;
  return { channel, id, data: Reflect.get(value, 'data') ?? null };
}

/**
 * One connection per client for all subscribed components. Reconnects with
 * exponential backoff and jitter (1 s doubling to 30 s, ×0.5–1), pauses while
 * offline, drops duplicate event ids and, after ten consecutive failures,
 * opens a circuit: one probe every five minutes until a connection succeeds or
 * the browser comes back online. `auto` starts with SSE and falls back to
 * long-polling for the controller lifetime when SSE never becomes ready.
 */
export function createRealtimeController(
  options: RealtimeControllerOptions,
): RealtimeController {
  const { window } = options;
  const endpoint = new URL(options.endpoint, window.location.href);
  if (
    endpoint.origin !== window.location.origin ||
    endpoint.search ||
    endpoint.hash
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'Realtime endpoint must be same-origin without query or fragment',
    );
  const base = endpoint.pathname.replace(/\/$/, '');
  const auto = options.transport === undefined || options.transport === 'auto';
  let transport: Exclude<RealtimeTransport, 'auto'> =
    options.transport === 'websocket' && window.WebSocket
      ? 'websocket'
      : options.transport === 'polling' || !window.EventSource
        ? 'polling'
        : 'sse';
  let sseFailures = 0;
  let tokens: string[] = [];
  let attempt = 0;
  let timer: number | undefined;
  let close: (() => void) | undefined;
  let disposed = false;
  const cursor = new Map<string, string>();
  const seen: string[] = [];
  function deliver(item: RealtimeMessage): void {
    const key = `${item.channel}\n${item.id}`;
    if (seen.includes(key)) return;
    seen.push(key);
    if (seen.length > 256) seen.shift();
    cursor.set(item.channel, item.id);
    options.onMessage(item);
  }
  function query(): string {
    return tokens.map((token) => `t=${encodeURIComponent(token)}`).join('&');
  }
  function encodedCursor(): string {
    return btoa(JSON.stringify(Object.fromEntries(cursor)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  }
  function retry(): void {
    close?.();
    close = undefined;
    if (disposed || !tokens.length) return;
    if (timer !== undefined) window.clearTimeout(timer);
    if (!window.navigator.onLine) return;
    const delay =
      attempt >= circuitThreshold
        ? circuitCooldownMs
        : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt++;
    timer = window.setTimeout(connect, delay * (0.5 + Math.random() * 0.5));
  }
  function closed(reason: unknown): void {
    if (
      reason === 'expired' ||
      reason === 'revoked' ||
      reason === 'forbidden'
    ) {
      close?.();
      close = undefined;
      // Fresh tokens arrive with the next component render.
      options.onExpired();
      return;
    }
    retry();
  }
  function connect(): void {
    timer = undefined;
    close?.();
    close = undefined;
    if (disposed || !tokens.length) return;
    if (transport === 'sse') {
      const source = new window.EventSource(`${base}/sse?${query()}`);
      let ready = false;
      let readyTimer: number | undefined;
      const fallBack = (): void => {
        window.clearTimeout(readyTimer);
        source.close();
        transport = 'polling';
        attempt = 0;
        connect();
      };
      if (auto) readyTimer = window.setTimeout(fallBack, autoReadyTimeoutMs);
      source.addEventListener('ready', () => {
        ready = true;
        sseFailures = 0;
        attempt = 0;
        window.clearTimeout(readyTimer);
      });
      source.addEventListener('invalidate', (event) => {
        const item = message(JSON.parse((event as MessageEvent<string>).data));
        if (item) deliver(item);
      });
      source.addEventListener('close', (event) => {
        source.close();
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        closed(
          data && typeof data === 'object' ? Reflect.get(data, 'reason') : '',
        );
      });
      source.addEventListener('error', () => {
        // Under `auto`, SSE that never becomes ready (blocked, unsupported by
        // a proxy, rejected) is replaced by long-polling.
        if (auto && !ready && ++sseFailures >= autoFallbackFailures) {
          fallBack();
          return;
        }
        ready = false;
        // EventSource reconnects transient failures itself; a closed source
        // (HTTP rejection) needs the bounded backoff instead.
        if (source.readyState === window.EventSource.CLOSED) retry();
      });
      close = () => {
        window.clearTimeout(readyTimer);
        source.close();
      };
      return;
    }
    if (transport === 'websocket') {
      const url = new URL(`${base}/ws`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new window.WebSocket(url.href);
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ tokens, cursor: encodedCursor() })),
      );
      socket.addEventListener('message', (event) => {
        const data: unknown = JSON.parse(String(event.data));
        if (
          data &&
          typeof data === 'object' &&
          Reflect.get(data, 'type') === 'ready'
        )
          attempt = 0;
        else if (
          data &&
          typeof data === 'object' &&
          Reflect.get(data, 'type') === 'invalidate'
        ) {
          const item = message(data);
          if (item) deliver(item);
        }
      });
      socket.addEventListener('close', (event) => {
        if (close === undefined) return;
        close = undefined;
        closed(event.code === 4000 ? event.reason : '');
      });
      close = () => {
        close = undefined;
        socket.close();
      };
      return;
    }
    const abort = new AbortController();
    close = () => abort.abort();
    const poll = async (): Promise<void> => {
      const response = await options.fetch(
        `${base}/poll?${query()}${cursor.size ? `&cursor=${encodedCursor()}` : ''}`,
        {
          credentials: 'same-origin',
          signal: abort.signal,
          headers: { accept: 'application/json' },
        },
      );
      if (response.status === 403) {
        closed('expired');
        return;
      }
      if (!response.ok)
        throw new LiveClientError('NETWORK', 'Realtime poll failed');
      attempt = 0;
      const body: unknown = await response.json();
      const events: unknown =
        body && typeof body === 'object'
          ? Reflect.get(body, 'events')
          : undefined;
      if (Array.isArray(events))
        for (const event of events.slice(0, 64)) {
          const item = message(event);
          if (item) deliver(item);
        }
      if (!abort.signal.aborted)
        void poll().catch(() => !abort.signal.aborted && retry());
    };
    void poll().catch(() => !abort.signal.aborted && retry());
  }
  const online = (): void => {
    attempt = 0;
    if (!close) connect();
  };
  window.addEventListener('online', online);
  return {
    update(next: readonly string[]): void {
      const sorted = [...new Set(next)].sort();
      if (sorted.length > 32)
        throw new LiveClientError(
          'DIRECTIVE',
          'Too many realtime subscriptions',
        );
      if (sorted.join('\n') === tokens.join('\n')) return;
      const channels = (list: readonly string[]) =>
        [...new Set(list.flatMap(tokenChannels))].sort().join('\n');
      const unchanged = channels(sorted) === channels(tokens);
      tokens = sorted;
      // Responses re-sign tokens with a fresh expiry. Reconnecting for those
      // would open a window in which events are missed; the open connection
      // keeps its channels and the fresh tokens are used on the next connect.
      if (unchanged && close) return;
      attempt = 0;
      connect();
    },
    get transport() {
      return transport;
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      close?.();
      close = undefined;
      window.removeEventListener('online', online);
    },
  };
}
