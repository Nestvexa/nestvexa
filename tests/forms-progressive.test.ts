import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Redirect,
  Req,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IsEmail, IsString, Length } from 'class-validator';
import {
  MemorySubmissionLedger,
  classValidatorAdapter,
  consumeFlash,
  consumeFormState,
  csrfToken,
  issueSubmissionToken,
  pushFlash,
  rotateCsrfToken,
  safeRedirectPath,
  submitForm,
  verifyCsrf,
  zodAdapter,
} from '../packages/forms/dist/index.js';
import { consumeLiveFlash } from '../packages/live/dist/index.js';

const origin = 'http://forms.test';
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface Reply {
  status: number;
  location?: string;
  cookie?: string;
  json: unknown;
  text: string;
}
function send(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const setCookie = response.headers['set-cookie']?.[0];
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({
          status: response.statusCode ?? 500,
          ...(typeof response.headers.location === 'string'
            ? { location: response.headers.location }
            : {}),
          ...(setCookie ? { cookie: setCookie.split(';')[0] } : {}),
          json,
          text,
        });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
function form(fields: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value])
      params.append(key, item);
  return params.toString();
}

const register = zodAdapter(
  z
    .strictObject({
      name: z.string().trim().min(2, 'Enter at least 2 characters.').max(60),
      email: z.email('Enter a valid email address.'),
      password: z.string().min(12, 'Use at least 12 characters.').max(128),
      confirm: z.string(),
      items: z
        .array(z.strictObject({ name: z.string().min(1, 'Name each item.') }))
        .max(5)
        .optional(),
    })
    .refine((value) => value.password === value.confirm, {
      path: ['confirm'],
      message: 'Passwords do not match.',
    }),
);
class ContactDto {
  @IsString()
  @Length(2, 40, { message: 'Enter a contact name.' })
  contact!: string;
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;
}

@Injectable()
class Accounts {
  readonly created: string[] = [];
  delayMs = 0;
}

@Controller()
class FormsController {
  readonly ledger = new MemorySubmissionLedger();
  constructor(@Inject(Accounts) private readonly accounts: Accounts) {}
  @Get('register')
  page(@Req() request: object) {
    return {
      csrf: csrfToken(request),
      submission: issueSubmissionToken(request, 'register'),
      state: consumeFormState(request, 'register'),
    };
  }
  @Get('welcome')
  welcome(@Req() request: object) {
    return { live: consumeLiveFlash(request), forms: consumeFlash(request) };
  }
  @Post('register')
  @Redirect()
  submit(@Req() request: object) {
    return submitForm(request, {
      form: 'register',
      adapter: register,
      back: '/register',
      allowedOrigins: [origin],
      singleUse: this.ledger,
      handle: async (value) => {
        if (value.email === 'taken@example.com')
          return { errors: { email: ['This email is already registered.'] } };
        await new Promise((resolve) =>
          setTimeout(resolve, this.accounts.delayMs),
        );
        this.accounts.created.push(value.email);
        return { redirect: '/welcome', flash: `Welcome, ${value.name}` };
      },
    });
  }
  @Get('contact')
  contactPage(@Req() request: object) {
    return {
      csrf: csrfToken(request),
      state: consumeFormState(request, 'contact'),
    };
  }
  @Post('contact')
  @Redirect()
  contact(@Req() request: object) {
    return submitForm(request, {
      form: 'contact',
      adapter: classValidatorAdapter(ContactDto),
      back: '/contact',
      remember: ['contact'],
      handle: () => ({ redirect: '//evil.example/steal' }),
    });
  }
}
@Module({ controllers: [FormsController], providers: [Accounts] })
class FormsModule {}

/** Minimal host session for Fastify: cookie id → in-memory object. */
function fastifySessions(app: NestFastifyApplication): void {
  const store = new Map<string, Record<string, unknown>>();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      const cookie = /(?:^|;\s*)sid=([A-Za-z0-9_-]{32})/.exec(
        request.headers.cookie ?? '',
      )?.[1];
      let id = cookie && store.has(cookie) ? cookie : undefined;
      if (!id) {
        id = randomBytes(24).toString('base64url');
        store.set(id, {});
        void reply.header(
          'set-cookie',
          `sid=${id}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      Object.defineProperty(request.raw, 'session', { value: store.get(id) });
      Object.defineProperty(request, 'session', { value: store.get(id) });
      done();
    });
}

async function start(platform: 'express' | 'fastify') {
  const module = await Test.createTestingModule({
    imports: [FormsModule],
  }).compile();
  let app: INestApplication;
  if (platform === 'fastify') {
    const fastify = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    fastifySessions(fastify);
    app = fastify;
  } else {
    const express = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    // Recommended for forms: flat keys reach parseFormBody, which refuses
    // prototype keys loudly instead of qs dropping them silently.
    express.useBodyParser('urlencoded', { extended: false });
    app = express;
    app.use(
      session({
        secret: randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'strict' },
      }),
    );
  }
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const accounts = app.get(Accounts);
  let cookie = '';
  const get = async (path: string) => {
    const reply = await send(base + path, 'GET', cookie ? { cookie } : {});
    if (reply.cookie) cookie = reply.cookie;
    return reply;
  };
  const post = async (
    path: string,
    fields: Record<string, string | string[]> | string,
    headers: Record<string, string> = {},
  ) => {
    const reply = await send(
      base + path,
      'POST',
      {
        'content-type': 'application/x-www-form-urlencoded',
        origin,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      typeof fields === 'string' ? fields : form(fields),
    );
    if (reply.cookie) cookie = reply.cookie;
    return reply;
  };
  const tokens = async () => {
    const page = (await get('/register')).json as {
      csrf: string;
      submission: string;
    };
    return page;
  };
  return { base, accounts, get, post, tokens, cookie: () => cookie };
}

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'correct horse battery',
  confirm: 'correct horse battery',
};

describe.each(['express', 'fastify'] as const)(
  'no-JS form POST fallback on %s',
  (platform) => {
    it('refuses missing, wrong and malformed CSRF tokens without storing anything', async () => {
      const app = await start(platform);
      const { csrf, submission } = await app.tokens();
      for (const extra of [
        {},
        { _csrf: 'x'.repeat(43) },
        { _csrf: csrf.slice(0, -1) },
        { _csrf: [csrf, csrf] },
      ]) {
        const reply = await app.post('/register', {
          ...valid,
          _submission: submission,
          ...extra,
        });
        expect(reply.status, JSON.stringify(extra)).toBe(403);
      }
      // A different session never shares the token.
      const other = await start(platform);
      await other.get('/register');
      expect(
        (
          await other.post('/register', {
            ...valid,
            _csrf: csrf,
            _submission: submission,
          })
        ).status,
      ).toBe(403);
      expect(app.accounts.created).toEqual([]);
      expect((await app.get('/register')).json).toMatchObject({
        state: { errors: {}, old: {} },
      });
      // Boots two Nest applications; allow for cold starts on loaded hosts.
    }, 60_000);

    it('refuses cross-origin submissions even with a valid token', async () => {
      const app = await start(platform);
      const { csrf, submission } = await app.tokens();
      const fields = { ...valid, _csrf: csrf, _submission: submission };
      expect(
        (await app.post('/register', fields, { origin: 'http://evil.test' }))
          .status,
      ).toBe(403);
      expect(
        (
          await app.post('/register', fields, {
            'sec-fetch-site': 'cross-site',
          })
        ).status,
      ).toBe(403);
      expect(app.accounts.created).toEqual([]);
    });

    it('redirects back with read-once errors and old input (never passwords)', async () => {
      const app = await start(platform);
      const { csrf, submission } = await app.tokens();
      const reply = await app.post('/register', {
        ...valid,
        name: 'A',
        confirm: 'something else',
        'items[0][name]': 'Lamp',
        'items[1][name]': '',
        _csrf: csrf,
        _submission: submission,
      });
      expect(reply.status).toBe(303);
      expect(reply.location).toBe('/register');
      const page = (await app.get('/register')).json as {
        state: {
          errors: Record<string, string[]>;
          old: Record<string, unknown>;
        };
      };
      // Zod 4 keeps running object refinements after non-fatal field issues.
      expect(page.state.errors).toEqual({
        name: ['Enter at least 2 characters.'],
        'items.1.name': ['Name each item.'],
        confirm: ['Passwords do not match.'],
      });
      expect(page.state.old).toEqual({
        name: 'A',
        email: 'ada@example.com',
      });
      expect(JSON.stringify(page)).not.toContain('correct horse');
      // Read once: a refresh shows a clean form.
      expect(((await app.get('/register')).json as typeof page).state).toEqual({
        errors: {},
        old: {},
      });
      // Cross-field rule once the shape is valid.
      const second = await app.tokens();
      await app.post('/register', {
        ...valid,
        confirm: 'something else',
        _csrf: second.csrf,
        _submission: second.submission,
      });
      expect(
        ((await app.get('/register')).json as typeof page).state.errors,
      ).toEqual({ confirm: ['Passwords do not match.'] });
    });

    it('answers 400 to prototype pollution, type confusion shapes and oversized input', async () => {
      const app = await start(platform);
      for (const extra of [
        '__proto__%5Badmin%5D=1',
        'constructor%5Bprototype%5D%5Badmin%5D=1',
        `bio=${'x'.repeat(10_001)}`,
        'items%5B7%5D%5Bname%5D=sparse',
        'name%5Bfirst%5D=Ada&name=Ada',
      ]) {
        const { csrf, submission } = await app.tokens();
        const reply = await app.post(
          '/register',
          `${form({ ...valid, _csrf: csrf, _submission: submission })}&${extra}`,
        );
        expect(reply.status, extra.slice(0, 40)).toBe(400);
        expect(reply.text).not.toContain('correct horse');
      }
      expect(Reflect.get({}, 'admin')).toBeUndefined();
      expect(app.accounts.created).toEqual([]);
      // Repeated scalar values are not silently coerced: the schema rejects the array.
      const { csrf, submission } = await app.tokens();
      const repeated = await app.post(
        '/register',
        `${form({ ...valid, _csrf: csrf, _submission: submission })}&name=Mallory`,
      );
      expect(repeated.status).toBe(303);
      expect(
        Object.keys(
          (
            (await app.get('/register')).json as {
              state: { errors: Record<string, string[]> };
            }
          ).state.errors,
        ),
      ).toEqual(['name']);
    });

    it('redirects on success with a flash readable by consumeLiveFlash', async () => {
      const app = await start(platform);
      const { csrf, submission } = await app.tokens();
      const reply = await app.post('/register', {
        ...valid,
        _csrf: csrf,
        _submission: submission,
      });
      expect(reply.status).toBe(303);
      expect(reply.location).toBe('/welcome');
      expect(app.accounts.created).toEqual(['ada@example.com']);
      expect((await app.get('/welcome')).json).toEqual({
        live: ['Welcome, Ada Lovelace'],
        forms: [],
      });
    });

    it('replays the first outcome for duplicate submissions and refuses reused tokens', async () => {
      const app = await start(platform);
      app.accounts.delayMs = 150;
      const { csrf, submission } = await app.tokens();
      const fields = { ...valid, _csrf: csrf, _submission: submission };
      const [first, second] = await Promise.all([
        app.post('/register', fields),
        app.post('/register', fields),
      ]);
      expect([first.status, second.status]).toEqual([303, 303]);
      expect([first.location, second.location]).toEqual([
        '/welcome',
        '/welcome',
      ]);
      expect(app.accounts.created).toEqual(['ada@example.com']);
      // A duplicate whose session was already replaced (for example by a
      // sign-in regeneration) still replays the first redirect: replays happen
      // before CSRF verification and change nothing.
      const afterRegeneration = await app.post('/register', {
        ...fields,
        _csrf: 'stale-session-token-0123456789-0123456789',
      });
      expect(afterRegeneration.status).toBe(303);
      expect(afterRegeneration.location).toBe('/welcome');
      // An unclaimed token with a bad CSRF token is still refused.
      const fresh = await app.tokens();
      expect(
        (
          await app.post('/register', {
            ...fields,
            _submission: fresh.submission,
            _csrf: 'stale-session-token-0123456789-0123456789',
          })
        ).status,
      ).toBe(403);
      // Replaying the token later, or omitting it, never re-runs the handler.
      for (const attempt of [fields, { ...valid, _csrf: csrf }]) {
        const reply = await app.post('/register', attempt);
        expect(reply.status).toBe(303);
        expect(['/welcome', '/register']).toContain(reply.location);
      }
      expect(app.accounts.created).toEqual(['ada@example.com']);
      const page = (await app.get('/register')).json as {
        state: { errors: Record<string, string[]> };
      };
      expect(page.state.errors['_form']?.[0]).toMatch(/expired/);
    });

    it('returns handler domain errors to the form and refuses unsafe redirects', async () => {
      const app = await start(platform);
      const { csrf, submission } = await app.tokens();
      const reply = await app.post('/register', {
        ...valid,
        email: 'taken@example.com',
        _csrf: csrf,
        _submission: submission,
      });
      expect(reply.location).toBe('/register');
      expect(
        (
          (await app.get('/register')).json as {
            state: { errors: Record<string, string[]> };
          }
        ).state.errors,
      ).toEqual({ email: ['This email is already registered.'] });
      // class-validator route: remember allowlist and open-redirect refusal.
      const contact = (await app.get('/contact')).json as { csrf: string };
      const invalid = await app.post('/contact', {
        contact: 'A',
        email: 'nope',
        _csrf: contact.csrf,
      });
      expect(invalid.location).toBe('/contact');
      expect(
        ((await app.get('/contact')).json as { state: unknown }).state,
      ).toEqual({
        errors: {
          contact: ['Enter a contact name.'],
          email: ['Enter a valid email address.'],
        },
        old: { contact: 'A' },
      });
      const unknown = await app.post('/contact', {
        contact: 'Ada',
        email: 'ada@example.com',
        role: 'admin',
        _csrf: contact.csrf,
      });
      expect(unknown.location).toBe('/contact');
      const evil = await app.post('/contact', {
        contact: 'Ada',
        email: 'ada@example.com',
        _csrf: contact.csrf,
      });
      expect(evil.status).toBe(500);
      expect(evil.location).toBeUndefined();
    });
  },
);

describe('session helpers', () => {
  it('fails closed without a session and supports get/set sessions', () => {
    expect(verifyCsrf({ body: { _csrf: 'x'.repeat(43) } })).toBe(false);
    expect(() => csrfToken({})).toThrow(/session/);
    const values = new Map<string, unknown>();
    const request = {
      session: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
      headers: {} as Record<string, string>,
      body: {} as Record<string, unknown>,
    };
    const token = csrfToken(request);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfToken(request)).toBe(token);
    request.headers['x-csrf-token'] = token;
    expect(verifyCsrf(request)).toBe(true);
    const rotated = rotateCsrfToken(request);
    expect(rotated).not.toBe(token);
    expect(verifyCsrf(request)).toBe(false);
    pushFlash(request, 'Saved');
    expect(consumeFlash(request)).toEqual(['Saved']);
    expect(consumeFlash(request)).toEqual([]);
    expect(() => pushFlash(request, '')).toThrow(/1–500/);
    expect(() => csrfToken(request, { sessionKey: 'bad key' })).toThrow();
  });

  it('only allows application-relative redirects', () => {
    expect(safeRedirectPath('/a/b?c=1#d')).toBe('/a/b?c=1#d');
    for (const url of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/a\nb',
      '',
    ])
      expect(() => safeRedirectPath(url)).toThrow();
  });

  it('rejects non-POST submissions and invalid configuration', async () => {
    const request = { method: 'GET', session: {}, body: {}, headers: {} };
    await expect(
      submitForm(request, {
        form: 'x',
        adapter: register,
        back: '/x',
        handle: () => ({ redirect: '/' }),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      submitForm(
        { ...request, method: 'POST' },
        {
          form: 'Bad Form',
          adapter: register,
          back: '/x',
          handle: () => ({ redirect: '/' }),
        },
      ),
    ).rejects.toThrow(/Form ids/);
    await expect(
      submitForm(
        { ...request, method: 'POST' },
        {
          form: 'x',
          adapter: register,
          back: 'https://evil.example',
          handle: () => ({ redirect: '/' }),
        },
      ),
    ).rejects.toThrow(/application-relative/);
  });
});
