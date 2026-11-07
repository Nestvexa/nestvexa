import 'reflect-metadata';
import type {
  DynamicModule,
  INestApplication,
  Provider,
  Type,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { request as httpRequest } from 'node:http';
import type { InertiaSessionAdapter } from '../packages/inertia/dist/index.js';

export type Platform = 'express' | 'fastify';

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface SendOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-encoded unless it is a Buffer, which is sent as is (set content-type). */
  readonly body?: unknown;
}

/** Real HTTP request against a listening Nest application (no injection shortcuts). */
export async function send(
  app: INestApplication,
  path: string,
  options: SendOptions = {},
): Promise<HttpResult> {
  const base = new URL(await app.getUrl());
  const raw = Buffer.isBuffer(options.body) ? options.body : undefined;
  const text =
    options.body === undefined || raw
      ? undefined
      : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: base.hostname === '[::1]' ? '::1' : base.hostname,
        port: base.port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(raw ? { 'content-length': String(raw.length) } : {}),
          ...(text === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(text)),
              }),
          ...options.headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(raw ?? text);
  });
}

export function header(result: HttpResult, name: string): string | undefined {
  const value = result.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

export function json(result: HttpResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** Extracts and parses the page object from an initial HTML response, as the client does. */
export function htmlPage(
  result: HttpResult,
  id = 'app',
): Record<string, unknown> {
  const match = new RegExp(
    `<script data-page="${id}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(result.body);
  if (!match?.[1]) throw new Error('Page script element not found');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** Cookie jar for a single simulated browser. */
export class Browser {
  #cookies = new Map<string, string>();
  constructor(
    private readonly app: INestApplication,
    cookies: Readonly<Record<string, string>> = {},
  ) {
    for (const [name, value] of Object.entries(cookies))
      this.#cookies.set(name, value);
  }
  async send(path: string, options: SendOptions = {}): Promise<HttpResult> {
    const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const result = await send(this.app, path, {
      ...options,
      headers: { ...(cookie ? { cookie } : {}), ...options.headers },
    });
    const setCookie = result.headers['set-cookie'] ?? [];
    for (const entry of setCookie) {
      const [pair] = entry.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair && index > 0)
        this.#cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return result;
  }
  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }
}

/**
 * Host-owned in-memory session keyed by an `sid` cookie supplied by the test.
 * Used on Fastify (no session plugin dependency) to prove the adapter only
 * relies on the `InertiaSessionAdapter` contract.
 */
export function cookieSessionAdapter(): InertiaSessionAdapter {
  const stores = new Map<string, Map<string, unknown>>();
  const sid = (request: object): string | undefined => {
    const cookie = (request as { headers?: Record<string, unknown> }).headers?.[
      'cookie'
    ];
    if (typeof cookie !== 'string') return undefined;
    return /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(cookie)?.[1];
  };
  const store = (request: object): Map<string, unknown> | undefined => {
    const id = sid(request);
    if (!id) return undefined;
    let found = stores.get(id);
    if (!found) stores.set(id, (found = new Map()));
    return found;
  };
  return {
    available: (request) => sid(request) !== undefined,
    get: (request, key) => structuredClone(store(request)?.get(key)),
    set: (request, key, value) =>
      void store(request)?.set(key, structuredClone(value)),
    delete: (request, key) => void store(request)?.delete(key),
  };
}

let browsers = 0;
/** A new simulated browser; Fastify fixtures use the test-owned `sid` cookie session. */
export function browser(app: INestApplication, platform: Platform): Browser {
  browsers += 1;
  return new Browser(
    app,
    platform === 'fastify' ? { sid: `browser${browsers}x${Date.now()}` } : {},
  );
}

/** Session option for `InertiaModule.forRoot` per platform. */
export function sessionOption(platform: Platform): {
  session?: InertiaSessionAdapter;
} {
  return platform === 'fastify' ? { session: cookieSessionAdapter() } : {};
}

export const resources: INestApplication[] = [];

export async function closeAll(): Promise<void> {
  for (const app of resources.splice(0)) await app.close();
}

/** Boots a real Nest application on an ephemeral port. */
export async function boot(
  platform: Platform,
  imports: (DynamicModule | Type)[],
  controllers: Type[],
  options: {
    expressSession?: boolean;
    providers?: Provider[];
    /** Runs before listen (for example to register Fastify content-type parsers). */
    configure?: (app: INestApplication) => void | Promise<void>;
  } = {},
): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports,
    controllers,
    providers: options.providers ?? [],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  if (platform === 'express' && options.expressSession)
    app.use(
      session({
        secret: 'inertia-test-secret-0123456789abcdef',
        resave: false,
        saveUninitialized: true,
        cookie: { httpOnly: true, sameSite: 'lax' },
      }),
    );
  resources.push(app);
  await options.configure?.(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

export const inertiaHeaders = (version?: string): Record<string, string> => ({
  'x-inertia': 'true',
  'x-requested-with': 'XMLHttpRequest',
  accept: 'text/html, application/xhtml+xml',
  ...(version === undefined ? {} : { 'x-inertia-version': version }),
});
