import { randomUUID } from 'node:crypto';

/*
 * A cookie-keeping HTTP client for in-process example applications: one
 * instance is one browser session. It speaks the Live and server-action wire
 * protocols directly, the way the browser runtime does, so tests can drive
 * reads and writes without launching a browser.
 */

export interface ExampleReply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  json(): Record<string, unknown>;
}

/** A mounted Live component root (`data-nv-name="<name>"`). */
export interface LiveReference {
  readonly snapshot: string;
  readonly revision: number;
  readonly csrf: string;
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Decodes the HTML entities Handlebars and the Live renderer produce. */
export function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#x3D;', '=')
    .replaceAll('&#x2F;', '/')
    .replaceAll('&#x60;', '`')
    .replaceAll('&amp;', '&');
}

export function liveReference(html: string, name: string): LiveReference {
  const tag = new RegExp(`<[a-z]+ [^>]*data-nv-name="${name}"[^>]*>`).exec(
    html,
  )?.[0];
  const snapshot = tag && attribute(tag, 'data-nv-snapshot');
  const revision = tag && attribute(tag, 'data-nv-revision');
  const csrf = tag && attribute(tag, 'data-nv-csrf');
  if (!snapshot || revision === undefined || !csrf)
    throw new Error(`Missing Live component ${name}`);
  return {
    snapshot: decodeEntities(snapshot),
    revision: Number(revision),
    csrf: decodeEntities(csrf),
  };
}

/** The value of `<input name="<name>" value="...">` (hidden CSRF fields). */
export function inputValue(html: string, name: string): string {
  const tag = new RegExp(`<input [^>]*name="${name}"[^>]*>`).exec(html)?.[0];
  const value = tag && attribute(tag, 'value');
  if (value === undefined) throw new Error(`Missing input ${name}`);
  return decodeEntities(value);
}

export class ExampleClient {
  readonly #cookies = new Map<string, string>();
  constructor(
    readonly base: string,
    readonly origin = base,
  ) {}

  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }
  setCookie(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  async request(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: string | Buffer;
    } = {},
  ): Promise<ExampleReply> {
    const headers = new Headers(options.headers);
    if (this.#cookies.size > 0)
      headers.set(
        'cookie',
        [...this.#cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      );
    const response = await fetch(new URL(path, this.base), {
      method,
      headers,
      redirect: 'manual',
      ...(options.body === undefined
        ? {}
        : {
            body:
              typeof options.body === 'string'
                ? options.body
                : new Uint8Array(options.body),
          }),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line))
        this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json() {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error(`Expected a JSON object, got ${text.slice(0, 200)}`);
        return value as Record<string, unknown>;
      },
    };
  }

  get(path: string, headers: Record<string, string> = {}) {
    return this.request('GET', path, { headers });
  }

  /** An urlencoded form POST, as a browser without JavaScript sends it. */
  form(
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return this.request('POST', path, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: this.origin,
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  json(path: string, value: unknown, headers: Record<string, string> = {}) {
    return this.request('POST', path, {
      headers: {
        'content-type': 'application/json',
        origin: this.origin,
        ...headers,
      },
      body: JSON.stringify(value),
    });
  }

  /** One Live request (`POST /_nestvexa/live/<component>/<action>`). */
  live(
    component: string,
    action: string,
    reference: LiveReference,
    extra: { updates?: Record<string, unknown>; input?: unknown } = {},
    headers: Record<string, string> = {},
  ) {
    return this.json(
      `/_nestvexa/live/${component}/${action}`,
      {
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: reference.snapshot,
        revision: reference.revision,
        updates: extra.updates ?? {},
        ...(extra.input === undefined ? {} : { input: extra.input }),
      },
      { 'x-nestvexa-csrf': reference.csrf, ...headers },
    );
  }

  /** One server action call (`POST /_nestvexa/actions/<group>/<action>`). */
  action(
    path: string,
    input: unknown,
    csrf: string,
    headers: Record<string, string> = {},
  ) {
    return this.json(
      `/_nestvexa/actions/${path}`,
      input === undefined ? {} : { input },
      { 'x-nestvexa-csrf': csrf, ...headers },
    );
  }
}

/** The reference to use after a successful Live response. */
export function nextReference(
  previous: LiveReference,
  reply: ExampleReply,
): LiveReference {
  const body = reply.json();
  const component = body['component'];
  const snapshot = body['snapshot'];
  const revision =
    component && typeof component === 'object'
      ? Reflect.get(component, 'revision')
      : undefined;
  if (typeof snapshot !== 'string' || typeof revision !== 'number')
    throw new Error(`Missing Live component in ${reply.text.slice(0, 300)}`);
  return { snapshot, revision, csrf: previous.csrf };
}
