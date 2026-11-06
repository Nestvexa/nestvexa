/*
 * The application shared by examples/express-host and examples/fastify-host.
 * This file is byte-identical in both examples (tests/examples-hosts.test.ts
 * enforces it); only main.ts chooses the HTTP platform. Nothing here imports
 * Express or Fastify: requests are read through `headers`, and responses are
 * written through Nest's HttpAdapterHost.
 */
import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
  Render,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  DynamicModule,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
} from '@nestjs/common';
import { HttpAdapterHost, REQUEST } from '@nestjs/core';
import {
  Action,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
} from 'nestvexa';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

export type Platform = 'express' | 'fastify';
export interface HostOptions {
  readonly platform: Platform;
  readonly port: number;
  /** HMAC key for the guest cookie and CSRF token. At least 32 bytes. */
  readonly secret: Buffer;
}

const views = fileURLToPath(new URL('../views', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const cookieName = 'nv_guest';
const guestIdPattern = /^[A-Za-z0-9_-]{22}$/;

function headerValue(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (!headers || typeof headers !== 'object') return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Anonymous guest identity in an HMAC-signed, HttpOnly cookie. It replaces a
 * platform-specific session middleware so the same code runs on Express and
 * Fastify. It is a demonstration identity, not authentication: production
 * hosts bind Live to their real session/user and rotate the secret.
 */
@Injectable()
export class GuestIdentity {
  /** Guests issued during the current request (before the browser has the cookie). */
  readonly #issued = new WeakMap<object, string>();
  constructor(private readonly secret: Buffer) {
    if (secret.byteLength < 32)
      throw new Error('The guest cookie secret must be at least 32 bytes');
  }
  #mac(purpose: string, id: string): string {
    return createHmac('sha256', this.secret)
      .update(`${purpose}:${id}`)
      .digest('base64url');
  }
  read(request: object): string | undefined {
    const issued = this.#issued.get(request);
    if (issued) return issued;
    for (const part of (headerValue(request, 'cookie') ?? '').split(';')) {
      const [name, value] = part.trim().split('=', 2);
      if (name !== cookieName || !value) continue;
      const [id, mac] = value.split('.', 2);
      if (!id || !mac || !guestIdPattern.test(id)) return undefined;
      const expected = Buffer.from(this.#mac('cookie', id));
      const actual = Buffer.from(mac);
      return actual.byteLength === expected.byteLength &&
        timingSafeEqual(actual, expected)
        ? id
        : undefined;
    }
    return undefined;
  }
  /** Returns the guest id, issuing a signed cookie through the platform adapter if needed. */
  ensure(request: object, response: object, host: HttpAdapterHost): string {
    const existing = this.read(request);
    if (existing) return existing;
    const id = randomBytes(16).toString('base64url');
    this.#issued.set(request, id);
    host.httpAdapter.setHeader(
      response,
      'Set-Cookie',
      `${cookieName}=${id}.${this.#mac('cookie', id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    );
    return id;
  }
  /** Live identity policy: never derived from request bodies. */
  identity(request: object): { binding: string; csrfToken: string } {
    const id = this.read(request);
    if (!id) throw new UnauthorizedException();
    return { binding: `guest:${id}`, csrfToken: this.#mac('csrf', id) };
  }
}

/** Demonstration storage: bounded, per guest, in process memory. */
@Injectable()
export class GuestbookStore {
  readonly #entries = new Map<string, { id: number; text: string }[]>();
  #next = 1;
  list(owner: string): readonly { id: number; text: string }[] {
    return this.#entries.get(owner) ?? [];
  }
  add(owner: string, text: string): void {
    if (!this.#entries.has(owner) && this.#entries.size >= 1000)
      this.#entries.clear();
    const entries = [{ id: this.#next++, text }, ...this.list(owner)];
    this.#entries.set(owner, entries.slice(0, 20));
  }
}

@LiveComponent({ name: 'counter', view: 'counter' })
export class Counter {
  @State() count = 0;
  @Computed() get doubled(): number {
    return this.count * 2;
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() decrement(): void {
    this.count = Math.max(0, this.count - 1);
  }
}

@LiveComponent({ name: 'guestbook', view: 'guestbook' })
export class Guestbook {
  constructor(
    @Inject(REQUEST) private readonly request: object,
    @Inject(GuestIdentity) private readonly guests: GuestIdentity,
    @Inject(GuestbookStore) private readonly store: GuestbookStore,
  ) {}
  /** Transport bound only; the product rule is checked in `sign`. */
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 200,
  })
  draft = '';
  @State() error = '';
  @Computed() get entries(): { id: number; text: string }[] {
    return this.store.list(this.#owner()).map((entry) => ({ ...entry }));
  }
  #owner(): string {
    return this.guests.identity(this.request).binding;
  }
  @Action() sign(): void {
    const text = this.draft.trim();
    if (text.length < 2) this.error = 'Write at least 2 characters.';
    else if (text.length > 120) this.error = 'Keep it under 120 characters.';
    else {
      this.store.add(this.#owner(), text);
      this.draft = '';
      this.error = '';
    }
  }
}

@Controller()
export class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(GuestIdentity) private readonly guests: GuestIdentity,
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    @Inject('HOST_PLATFORM') private readonly platform: Platform,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(
    @Req() request: object,
    @Res({ passthrough: true }) response: object,
  ) {
    this.guests.ensure(request, response, this.adapter);
    return {
      title: `Nestvexa on ${this.platform}`,
      platform: this.platform,
      counter: await this.live.mount(Counter, request),
      guestbook: await this.live.mount(Guestbook, request),
    };
  }
  @Get('about')
  @Header('Content-Security-Policy', csp)
  @Render('about')
  about() {
    return { title: 'About this host', platform: this.platform };
  }
  @Get('assets/site.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  stylesheet(): string {
    return 'body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:48rem;padding:1rem}button,input{font:inherit;min-height:2.5rem}button{padding:.25rem .75rem}input{padding:.25rem .5rem}[aria-invalid="true"]{outline:2px solid #b00020}.error{color:#b00020}output{font-variant-numeric:tabular-nums;font-weight:700}nav a{margin-inline-end:1rem}';
  }
  @Get('api/health')
  health() {
    return { status: 'ok', platform: this.platform };
  }
}

/* ---------- Native Nest REST API: guard, pipe, interceptor, filter ---------- */

/** Demonstration API key. A real API uses its own authentication. */
export const demoApiKey = 'demo-key-not-a-secret';

@Injectable()
class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (
      headerValue(context.switchToHttp().getRequest(), 'x-api-key') !==
      demoApiKey
    )
      throw new UnauthorizedException('A valid x-api-key header is required');
    return true;
  }
}

@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  constructor(@Inject('HOST_PLATFORM') private readonly platform: Platform) {}
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(map((data: unknown) => ({ data, platform: this.platform })));
  }
}

/** Formats every API error the same way on both platforms. */
@Catch(HttpException)
class ApiErrorFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
  ) {}
  catch(exception: HttpException, host: ArgumentsHost): void {
    const status = exception.getStatus();
    const body = exception.getResponse();
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? Reflect.get(body, 'message')
        : exception.message;
    this.adapter.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      { error: { status, message } },
      status,
    );
  }
}

interface NoteInput {
  readonly text: string;
}
class NoteInputPipe implements PipeTransform<unknown, NoteInput> {
  transform(value: unknown): NoteInput {
    const text: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'text')
        : undefined;
    if (
      typeof text !== 'string' ||
      text.trim().length < 1 ||
      text.length > 200 ||
      Object.keys(value ?? {}).length !== 1
    )
      throw new BadRequestException('Expected { "text": string (1-200) }');
    return { text: text.trim() };
  }
}

@Injectable()
export class NotesStore {
  readonly #notes: { id: number; text: string }[] = [
    { id: 1, text: 'Nest guards still run' },
    { id: 2, text: 'Pipes, interceptors and filters too' },
  ];
  find(id: number): { id: number; text: string } | undefined {
    return this.#notes.find((note) => note.id === id);
  }
  add(text: string): { id: number; text: string } {
    if (this.#notes.length >= 100) this.#notes.splice(2);
    const note = { id: (this.#notes.at(-1)?.id ?? 0) + 1, text };
    this.#notes.push(note);
    return note;
  }
}

@Controller('api/notes')
@UseFilters(ApiErrorFilter)
@UseGuards(ApiKeyGuard)
@UseInterceptors(EnvelopeInterceptor)
export class NotesApi {
  constructor(@Inject(NotesStore) private readonly notes: NotesStore) {}
  @Get(':id')
  find(@Param('id', ParseIntPipe) id: number) {
    const note = this.notes.find(id);
    if (!note) throw new HttpException('Note not found', HttpStatus.NOT_FOUND);
    return note;
  }
  @Post()
  create(@Body(new NoteInputPipe()) input: NoteInput) {
    return this.notes.add(input.text);
  }
}

/* ---------------------------- Composition root ---------------------------- */

export function createAppModule(options: HostOptions): DynamicModule {
  const guests = new GuestIdentity(options.secret);
  const store = new GuestbookStore();
  const platform = { provide: 'HOST_PLATFORM', useValue: options.platform };

  /** Providers shared with Live components (their DI comes from `imports`). */
  @Module({
    providers: [
      { provide: GuestIdentity, useValue: guests },
      { provide: GuestbookStore, useValue: store },
      platform,
    ],
    exports: [GuestIdentity, GuestbookStore, 'HOST_PLATFORM'],
  })
  class HostModule {}

  @Module({})
  class AppModule {}

  return {
    module: AppModule,
    imports: [
      HostModule,
      NestvexaModule.forRoot(
        { views: { root: views, layout: 'layout' }, live: { enabled: true } },
        {
          components: [Counter, Guestbook],
          imports: [HostModule],
          useFactory: () => ({
            origin: `http://127.0.0.1:${options.port}`,
            resolveIdentity: (request: object) => guests.identity(request),
            authorize: (_identity, component, action) =>
              (component === 'counter' &&
                ['$mount', 'increment', 'decrement'].includes(action)) ||
              (component === 'guestbook' &&
                ['$mount', '$sync', 'sign'].includes(action)),
          }),
        },
      ),
    ],
    controllers: [Pages, NotesApi],
    providers: [NotesStore, ApiKeyGuard, EnvelopeInterceptor, ApiErrorFilter],
  };
}
