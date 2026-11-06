import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRealtimeController,
  tokenChannels,
} from '../packages/client/dist/realtime.js';
import type { RealtimeMessage } from '../packages/client/dist/realtime.js';

/** Browser stand-ins: just enough of EventSource/WebSocket/window for the controller. */
class FakeEventTarget {
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
class FakeEventSource extends FakeEventTarget {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  ready(): void {
    this.readyState = 1;
    this.emit('ready', { data: '{"channels":[]}' });
  }
  invalidate(channel: string, id: string, data: unknown = null): void {
    this.emit('invalidate', { data: JSON.stringify({ channel, id, data }) });
  }
  fail(closed: boolean): void {
    if (closed) this.readyState = 2;
    this.emit('error');
  }
}
class FakeWebSocket extends FakeEventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.closed = true;
  }
  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }
}
function token(channels: readonly string[]): string {
  const body = Buffer.from(JSON.stringify({ c: channels })).toString(
    'base64url',
  );
  return `${body}.${'A'.repeat(43)}`;
}
function fakeWindow(options: { eventSource?: boolean } = {}) {
  const target = new FakeEventTarget();
  const navigator = { onLine: true };
  const value = {
    location: {
      href: 'https://app.example/page',
      origin: 'https://app.example',
    },
    navigator,
    EventSource: options.eventSource === false ? undefined : FakeEventSource,
    WebSocket: FakeWebSocket,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: number | undefined) => clearTimeout(id),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    // The controller only touches the members above.
    window: value as unknown as Window & typeof globalThis,
    navigator,
    goOnline: () => target.emit('online'),
  };
}
interface Poll {
  readonly url: string;
  readonly respond: (status: number, body?: unknown) => void;
  readonly fail: () => void;
  readonly signal: AbortSignal | undefined;
}
function fakeFetch() {
  const polls: Poll[] = [];
  const fetch = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      polls.push({
        url,
        signal: init?.signal ?? undefined,
        respond: (status, body = { events: [] }) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        fail: () => reject(new TypeError('network')),
      });
    })) as unknown as typeof globalThis.fetch;
  return { fetch, polls };
}
function controller(
  transport: 'auto' | 'sse' | 'websocket' | 'polling' | undefined,
  options: { eventSource?: boolean } = {},
) {
  const win = fakeWindow(options);
  const http = fakeFetch();
  const messages: RealtimeMessage[] = [];
  let expired = 0;
  const instance = createRealtimeController({
    endpoint: '/_nestvexa/realtime',
    ...(transport === undefined ? {} : { transport }),
    window: win.window,
    fetch: http.fetch,
    onMessage: (message) => messages.push(message),
    onExpired: () => expired++,
  });
  return { instance, win, http, messages, expired: () => expired };
}
const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('browser realtime controller', () => {
  it('rejects cross-origin endpoints and reads public token channels', () => {
    const win = fakeWindow();
    expect(() =>
      createRealtimeController({
        endpoint: 'https://evil.example/realtime',
        window: win.window,
        fetch: fakeFetch().fetch,
        onMessage: () => undefined,
        onExpired: () => undefined,
      }),
    ).toThrow(/same-origin/);
    expect(tokenChannels(token(['orders:a', 'job:1']))).toEqual([
      'orders:a',
      'job:1',
    ]);
    expect(() => tokenChannels('not a token')).toThrow();
    expect(() => tokenChannels(token(['Bad Channel']))).toThrow();
  });

  it('opens one SSE connection for all tokens and reconnects only when the set changes', () => {
    const f = controller('sse');
    f.instance.update([token(['b']), token(['a']), token(['a'])]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url.match(/t=/g)).toHaveLength(2);
    f.instance.update([token(['a']), token(['b'])]);
    expect(FakeEventSource.instances).toHaveLength(1);
    f.instance.update([token(['c'])]);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(() =>
      f.instance.update(Array.from({ length: 33 }, (_, i) => token([`c${i}`]))),
    ).toThrow(/Too many/);
    f.instance.dispose();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });

  it('keeps the open connection when a response only re-signs the same channels', () => {
    const f = controller('sse');
    const first = token(['orders', 'job:1']);
    // Same channels, fresh expiry: a different token string.
    const resigned = first.replace(/A{43}$/, 'B'.repeat(43));
    f.instance.update([first]);
    FakeEventSource.instances[0]?.ready();
    f.instance.update([resigned]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    // The next reconnect uses the fresh token.
    FakeEventSource.instances[0]?.fail(true);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toContain('B'.repeat(43));
    // A changed channel set reconnects immediately.
    f.instance.update([token(['orders', 'job:2'])]);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('drops duplicate and malformed events', () => {
    const f = controller('sse');
    f.instance.update([token(['orders'])]);
    const source = FakeEventSource.instances[0];
    source?.ready();
    source?.invalidate('orders', '1', { n: 1 });
    source?.invalidate('orders', '1', { n: 1 });
    source?.invalidate('orders', '2', { n: 2 });
    source?.emit('invalidate', { data: JSON.stringify({ channel: 'orders' }) });
    source?.emit('invalidate', {
      data: JSON.stringify({ channel: 'orders', id: 'x'.repeat(200) }),
    });
    expect(f.messages).toEqual([
      { channel: 'orders', id: '1', data: { n: 1 } },
      { channel: 'orders', id: '2', data: { n: 2 } },
    ]);
  });

  it('backs off exponentially with jitter, caps at 30 s and opens a circuit after repeated failures', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const f = controller('sse');
    f.instance.update([token(['orders'])]);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const source = FakeEventSource.instances.at(-1);
      setTimeoutSpy.mockClear();
      source?.fail(true);
      const delay = Number(setTimeoutSpy.mock.calls.at(-1)?.[1]);
      delays.push(delay);
      vi.advanceTimersByTime(delay);
    }
    // ×(0.5 + random·0.5) with random = 1 gives the full delay.
    expect(delays).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      300_000, 300_000,
    ]);
    random.mockReturnValue(0);
    setTimeoutSpy.mockClear();
    FakeEventSource.instances.at(-1)?.ready();
    FakeEventSource.instances.at(-1)?.fail(true);
    // A successful ready resets the backoff; jitter halves the minimum delay.
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(500);
    f.instance.dispose();
  });

  it('pauses while offline and reconnects when the browser comes back online', () => {
    const f = controller('sse');
    f.instance.update([token(['orders'])]);
    f.win.navigator.onLine = false;
    FakeEventSource.instances[0]?.fail(true);
    vi.advanceTimersByTime(600_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    f.win.navigator.onLine = true;
    f.win.goOnline();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('reports expiry/revocation closes instead of reconnecting', () => {
    const f = controller('sse');
    f.instance.update([token(['orders'])]);
    FakeEventSource.instances[0]?.emit('close', {
      data: JSON.stringify({ reason: 'expired' }),
    });
    expect(f.expired()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    // A transient server close (shutdown) reconnects with backoff.
    f.instance.update([token(['other'])]);
    FakeEventSource.instances[1]?.emit('close', {
      data: JSON.stringify({ reason: 'shutdown' }),
    });
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('auto falls back from SSE to long-polling when SSE never becomes ready', async () => {
    const f = controller('auto');
    f.instance.update([token(['orders'])]);
    expect(f.instance.transport).toBe('sse');
    FakeEventSource.instances[0]?.fail(false);
    expect(f.instance.transport).toBe('sse');
    FakeEventSource.instances[0]?.fail(false);
    expect(f.instance.transport).toBe('polling');
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(f.http.polls).toHaveLength(1);
    expect(f.http.polls[0]?.url).toMatch(/^\/_nestvexa\/realtime\/poll\?t=/);
    f.http.polls[0]?.respond(200, {
      events: [{ channel: 'orders', id: '7', data: null }],
      cursor: 'x',
    });
    // Reading a real Response body is not bounded by a fixed number of microtasks.
    await vi.waitFor(() =>
      expect(f.messages).toEqual([{ channel: 'orders', id: '7', data: null }]),
    );
    // The next long-poll carries the cursor of delivered events.
    await vi.waitFor(() => expect(f.http.polls[1]?.url).toContain('&cursor='));
    // Later token changes stay on polling.
    f.instance.update([token(['other'])]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(f.http.polls[1]?.signal?.aborted).toBe(true);
    f.instance.dispose();
  });

  it('auto falls back when an SSE stream stays silent (buffering proxy), but not once ready', () => {
    const silent = controller('auto');
    silent.instance.update([token(['orders'])]);
    vi.advanceTimersByTime(10_000);
    expect(silent.instance.transport).toBe('polling');
    silent.instance.dispose();
    const healthy = controller(undefined);
    healthy.instance.update([token(['orders'])]);
    FakeEventSource.instances.at(-1)?.ready();
    vi.advanceTimersByTime(20_000);
    FakeEventSource.instances.at(-1)?.fail(false);
    FakeEventSource.instances.at(-1)?.fail(false);
    expect(healthy.instance.transport).toBe('sse');
    // Explicit SSE never falls back.
    const explicit = controller('sse');
    explicit.instance.update([token(['orders'])]);
    vi.advanceTimersByTime(20_000);
    expect(explicit.instance.transport).toBe('sse');
  });

  it('uses polling when EventSource is unavailable and treats 403 as expiry', async () => {
    const f = controller('auto', { eventSource: false });
    expect(f.instance.transport).toBe('polling');
    f.instance.update([token(['orders'])]);
    f.http.polls[0]?.respond(403);
    await vi.waitFor(() => expect(f.expired()).toBe(1));
    const failing = controller('polling');
    failing.instance.update([token(['orders'])]);
    failing.http.polls[0]?.fail();
    await flush();
    expect(failing.http.polls).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(failing.http.polls).toHaveLength(2);
  });

  it('subscribes over WebSocket with tokens and cursor, delivers and deduplicates', () => {
    const f = controller('websocket');
    f.instance.update([token(['orders'])]);
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe('wss://app.example/_nestvexa/realtime/ws');
    socket?.emit('open');
    expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({
      tokens: [token(['orders'])],
    });
    socket?.message({ type: 'ready' });
    socket?.message({
      type: 'invalidate',
      channel: 'orders',
      id: '1',
      data: 1,
    });
    socket?.message({
      type: 'invalidate',
      channel: 'orders',
      id: '1',
      data: 1,
    });
    expect(f.messages).toHaveLength(1);
    socket?.emit('close', { code: 4000, reason: 'revoked' });
    expect(f.expired()).toBe(1);
    // A reconnect after an abnormal close resumes from the cursor.
    f.instance.update([token(['orders']), token(['more'])]);
    const next = FakeWebSocket.instances[1];
    next?.emit('close', { code: 1006, reason: '' });
    vi.advanceTimersByTime(1000);
    const resumed = FakeWebSocket.instances[2];
    resumed?.emit('open');
    const hello = JSON.parse(resumed?.sent[0] ?? '{}') as { cursor: string };
    expect(
      JSON.parse(Buffer.from(hello.cursor, 'base64url').toString()),
    ).toEqual({ orders: '1' });
  });
});
