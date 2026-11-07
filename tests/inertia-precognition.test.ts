import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import type {
  CallHandler,
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
  Type,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { of } from 'rxjs';
import type { Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { customAdapter, zodAdapter } from '../packages/forms/dist/index.js';
import {
  InertiaConfigurationError,
  InertiaModule,
  InertiaPage,
  InertiaValidationException,
  PrecognitionHeader,
  Precognitive,
  defaultHeaderLimits,
  inertiaValidationExceptionFactory,
  isPrecognitionRequest,
  parsePrecognitionRequest,
  redirect,
  selectPrecognitionErrors,
} from '../packages/inertia/dist/index.js';
import type {
  PrecognitionSchema,
  PrecognitionValidator,
} from '../packages/inertia/dist/index.js';
import type { INestApplication } from '@nestjs/common';
import {
  boot,
  closeAll,
  header,
  json,
  send,
  sessionOption,
} from './inertia-support.js';
import type { Platform } from './inertia-support.js';

// Precognition semantics follow the Inertia v3 protocol page (request and
// response headers) and the laravel-precognition 2.1.1 client bundled by
// @inertiajs/core 3.10.0: `Precognition: true` on every precognitive reply,
// `204` + `Precognition-Success: true` on a pass, `422` with `errors` otherwise.

const runs: Record<string, number> = {};
const ran = (name: string) => {
  runs[name] = (runs[name] ?? 0) + 1;
};

const signup = zodAdapter(
  z.object({
    name: z.string().min(1, 'Enter a name.'),
    email: z.email('Enter a valid email.'),
    items: z
      .array(z.object({ sku: z.string().min(1, 'Enter a SKU.') }))
      .optional(),
  }),
);

/** A Nest pipe that must never run for Precognition requests. */
class CountingPipe implements PipeTransform {
  transform(value: unknown): unknown {
    ran('pipe');
    return value;
  }
}

const throwing: PrecognitionValidator = () => {
  throw new Error('database password is hunter2');
};

const exceptionValidator: PrecognitionValidator = () => {
  throw new InertiaValidationException({ code: 'Code already used.' });
};

const brokenSchema: PrecognitionSchema = {
  validate: () => ({ ok: 'maybe' }) as never,
};

@Controller()
class PrecognitionController {
  @Post('signup')
  @Precognitive(signup)
  @UsePipes(CountingPipe)
  store(@Body() body: unknown) {
    ran('store');
    return { stored: body };
  }

  @Put('signup/:id')
  @Precognitive(signup)
  update() {
    ran('update');
    return redirect('/signup');
  }

  @Get('search')
  @Precognitive(
    customAdapter((input, issues) => {
      if (input['q'] !== 'nest') issues.issue('q', 'value', 'Search nest.');
      return input;
    }),
  )
  search(@Query() query: unknown) {
    ran('search');
    return { query };
  }

  @Delete('accounts/:id')
  @Precognitive((input) =>
    (input as Record<string, unknown>)['confirm'] === 'yes'
      ? undefined
      : { confirm: 'Confirm the deletion.' },
  )
  remove() {
    ran('remove');
    return { deleted: true };
  }

  @Post('custom-input')
  @Precognitive(
    (input) => (input === 'from-header' ? undefined : { input: 'Wrong.' }),
    {
      input: (request) =>
        (request as { headers: Record<string, unknown> }).headers['x-input'],
    },
  )
  customInput() {
    ran('customInput');
    return {};
  }

  @Post('throws')
  @Precognitive(throwing)
  throws() {
    ran('throws');
    return {};
  }

  @Post('exception')
  @Precognitive(exceptionValidator)
  exception() {
    ran('exception');
    return {};
  }

  @Post('broken')
  @Precognitive(brokenSchema)
  broken() {
    ran('broken');
    return {};
  }

  @Post('page')
  @HttpCode(200)
  @InertiaPage('Signup')
  @Precognitive(signup)
  page() {
    ran('page');
    return { ok: true };
  }

  /** Not declared precognitive: the request reaches the handler, as upstream. */
  @Post('plain')
  plain(@Req() request: object, @Body() body: unknown) {
    ran('plain');
    const name = (body as Record<string, unknown> | undefined)?.['name'];
    if (name !== 'ok')
      throw inertiaValidationExceptionFactory([
        { property: 'name', constraints: { required: 'Name is required.' } },
      ]);
    return { precognitive: isPrecognitionRequest(request) };
  }
}

const precognitive = {
  precognition: 'true',
  accept: 'application/json',
};

describe('Precognition protocol helpers', () => {
  const request = (headers: Record<string, unknown>) => ({ headers });

  it('recognizes only the value the official client sends', () => {
    expect(isPrecognitionRequest(request({ precognition: 'true' }))).toBe(true);
    expect(isPrecognitionRequest(request({ precognition: 'TRUE' }))).toBe(true);
    expect(isPrecognitionRequest(request({ precognition: 'false' }))).toBe(
      false,
    );
    expect(isPrecognitionRequest(request({ precognition: '1' }))).toBe(false);
    expect(
      isPrecognitionRequest(request({ precognition: ['true', 'true'] })),
    ).toBe(false);
    expect(isPrecognitionRequest(request({}))).toBe(false);
    expect(isPrecognitionRequest({})).toBe(false);
  });

  it('parses Precognition-Validate-Only, distinguishing absent from empty', () => {
    const parse = (headers: Record<string, unknown>) =>
      parsePrecognitionRequest(request(headers), defaultHeaderLimits);
    expect(parse({ precognition: 'true' })).toStrictEqual({
      precognitive: true,
      only: undefined,
    });
    expect(
      parse({
        precognition: 'true',
        'precognition-validate-only': 'name,items.*.sku, email',
      }).only,
    ).toStrictEqual(['name', 'items.*.sku', 'email']);
    // laravel-precognition sends an empty list when nothing is touched;
    // Laravel then validates no rule at all.
    expect(
      parse({ precognition: 'true', 'precognition-validate-only': '' }).only,
    ).toStrictEqual([]);
    // Without `Precognition: true` the list is ignored.
    expect(parse({ 'precognition-validate-only': 'name' })).toStrictEqual({
      precognitive: false,
      only: undefined,
    });
  });

  it.each([
    ['repeated header', ['name', 'email']],
    ['control character', 'name\r\nx-injected: 1'],
    ['prototype segment', 'user.__proto__'],
    ['constructor segment', 'constructor'],
    ['empty segment', 'user..name'],
    ['oversized entry', 'a'.repeat(257)],
    ['oversized header', 'a,'.repeat(2100)],
    ['too many entries', Array.from({ length: 129 }, (_, i) => `f${i}`).join()],
  ])('rejects a malformed Validate-Only header: %s', (_label, value) => {
    expect(() =>
      parsePrecognitionRequest(
        request({ precognition: 'true', 'precognition-validate-only': value }),
        defaultHeaderLimits,
      ),
    ).toThrow(/Malformed Precognition-Validate-Only header/);
  });

  it('selects errors by exact path, nested path and single-segment wildcards', () => {
    const errors = {
      name: ['Required.'],
      'address.city': ['Required.'],
      'items.0.sku': ['Required.'],
      'items.1.sku': ['Required.'],
      'items.1.qty': ['Too small.'],
      _form: ['Invalid.'],
    };
    expect(selectPrecognitionErrors(errors, undefined)).toStrictEqual(errors);
    expect(selectPrecognitionErrors(errors, [])).toStrictEqual({});
    expect(selectPrecognitionErrors(errors, ['address'])).toStrictEqual({
      'address.city': ['Required.'],
    });
    expect(selectPrecognitionErrors(errors, ['items.*.sku'])).toStrictEqual({
      'items.0.sku': ['Required.'],
      'items.1.sku': ['Required.'],
    });
    expect(selectPrecognitionErrors(errors, ['items.1'])).toStrictEqual({
      'items.1.sku': ['Required.'],
      'items.1.qty': ['Too small.'],
    });
    // A field never selects its parent or siblings.
    expect(
      selectPrecognitionErrors({ items: ['Too few.'] }, ['items.0.sku']),
    ).toStrictEqual({});
  });

  it('rejects invalid decorator configuration at definition time', () => {
    expect(() => Precognitive(undefined as never)).toThrow(
      InertiaConfigurationError,
    );
    expect(() => Precognitive({} as never)).toThrow(InertiaConfigurationError);
    expect(() =>
      Precognitive(() => undefined, { extra: true } as never),
    ).toThrow(/Unknown @Precognitive option "extra"/);
    expect(() =>
      Precognitive(() => undefined, { input: 'body' } as never),
    ).toThrow(/input must be a function/);
    for (const interceptors of [
      'FileInterceptor',
      ['FileInterceptor'],
      [{ intercept: 'no' }],
      [null],
    ])
      expect(() =>
        Precognitive(() => undefined, { interceptors } as never),
      ).toThrow(/interceptors must be interceptor classes or instances/);
    expect(() =>
      Precognitive(() => undefined, {
        interceptors: [class {} as never, { intercept: () => of(null) }],
      }),
    ).not.toThrow();
  });

  it('exposes the wire names', () => {
    expect(PrecognitionHeader).toStrictEqual({
      precognition: 'Precognition',
      validateOnly: 'Precognition-Validate-Only',
      success: 'Precognition-Success',
    });
  });
});

describe.each(['express', 'fastify'] as const)(
  'Precognition over HTTP on %s',
  (platform: Platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await boot(
        platform,
        [InertiaModule.forRoot({ version: 'v1', ...sessionOption(platform) })],
        [PrecognitionController],
        { expressSession: platform === 'express' },
      );
    });
    afterAll(closeAll);

    const before = () => ({ ...runs });
    const unchanged = (snapshot: Record<string, number>) =>
      expect(runs).toStrictEqual(snapshot);

    it('answers 204 with Precognition-Success and never runs pipes or the handler', async () => {
      const snapshot = before();
      const result = await send(app, '/signup', {
        method: 'POST',
        headers: precognitive,
        body: { name: 'Ada', email: 'ada@example.test' },
      });
      expect(result.status).toBe(204);
      expect(result.body).toBe('');
      expect(header(result, 'precognition')).toBe('true');
      expect(header(result, 'precognition-success')).toBe('true');
      expect(header(result, 'vary')).toBe('Precognition');
      unchanged(snapshot);
    });

    it('answers 422 with every field error as message arrays', async () => {
      const snapshot = before();
      const result = await send(app, '/signup', {
        method: 'POST',
        headers: precognitive,
        body: { name: '', email: 'nope', items: [{ sku: '' }] },
      });
      expect(result.status).toBe(422);
      expect(header(result, 'content-type')).toMatch(/^application\/json/);
      expect(header(result, 'precognition')).toBe('true');
      expect(header(result, 'precognition-success')).toBeUndefined();
      expect(json(result)).toStrictEqual({
        message: 'Enter a name. (and 2 more errors)',
        errors: {
          name: ['Enter a name.'],
          email: ['Enter a valid email.'],
          'items.0.sku': ['Enter a SKU.'],
        },
      });
      unchanged(snapshot);
    });

    it('limits errors to Precognition-Validate-Only and passes when those fields are valid', async () => {
      const body = {
        name: '',
        email: 'ada@example.test',
        items: [{ sku: '' }],
      };
      const only = await send(app, '/signup', {
        method: 'POST',
        headers: {
          ...precognitive,
          'precognition-validate-only': 'items.*.sku',
        },
        body,
      });
      expect(only.status).toBe(422);
      expect(json(only)['errors']).toStrictEqual({
        'items.0.sku': ['Enter a SKU.'],
      });
      const passing = await send(app, '/signup', {
        method: 'POST',
        headers: { ...precognitive, 'precognition-validate-only': 'email' },
        body,
      });
      expect(passing.status).toBe(204);
      const none = await send(app, '/signup', {
        method: 'POST',
        headers: { ...precognitive, 'precognition-validate-only': '' },
        body,
      });
      expect(none.status).toBe(204);
    });

    it('rejects malformed Validate-Only headers with 400 before validating', async () => {
      const snapshot = before();
      const result = await send(app, '/signup', {
        method: 'POST',
        headers: {
          ...precognitive,
          'precognition-validate-only': 'name,__proto__',
        },
        body: {},
      });
      expect(result.status).toBe(400);
      expect(result.body).toContain('Malformed Precognition-Validate-Only');
      unchanged(snapshot);
    });

    it('runs ordinary submissions normally and varies on Precognition', async () => {
      const result = await send(app, '/signup', {
        method: 'POST',
        body: { name: 'Ada', email: 'ada@example.test' },
      });
      // Nest's default POST status is untouched by the Vary header.
      expect(result.status).toBe(201);
      expect(header(result, 'vary')).toBe('Precognition');
      expect(header(result, 'precognition')).toBeUndefined();
      expect(json(result)).toStrictEqual({
        stored: { name: 'Ada', email: 'ada@example.test' },
      });
      const declined = await send(app, '/signup', {
        method: 'POST',
        headers: { precognition: 'false' },
        body: {},
      });
      expect(declined.status).toBe(201);
    });

    it('validates query data for GET and DELETE, as the client sends it', async () => {
      const snapshot = before();
      const failed = await send(app, '/search?q=vue', {
        headers: precognitive,
      });
      expect(failed.status).toBe(422);
      expect(json(failed)['errors']).toStrictEqual({ q: ['Search nest.'] });
      const ok = await send(app, '/search?q=nest', { headers: precognitive });
      expect(ok.status).toBe(204);
      const removal = await send(app, '/accounts/1?confirm=no', {
        method: 'DELETE',
        headers: precognitive,
      });
      expect(json(removal)).toStrictEqual({
        message: 'Confirm the deletion.',
        errors: { confirm: ['Confirm the deletion.'] },
      });
      unchanged(snapshot);
    });

    it('supports PUT routes, custom input readers and @InertiaPage routes', async () => {
      const snapshot = before();
      const put = await send(app, '/signup/1', {
        method: 'PUT',
        headers: precognitive,
        body: { name: 'Ada', email: 'ada@example.test' },
      });
      expect(put.status).toBe(204);
      const custom = await send(app, '/custom-input', {
        method: 'POST',
        headers: { ...precognitive, 'x-input': 'from-header' },
      });
      expect(custom.status).toBe(204);
      const page = await send(app, '/page', {
        method: 'POST',
        headers: { ...precognitive, 'x-inertia': 'true' },
        body: { name: '' },
      });
      expect(page.status).toBe(422);
      expect(header(page, 'x-inertia')).toBeUndefined();
      unchanged(snapshot);
      const visit = await send(app, '/page', {
        method: 'POST',
        headers: { 'x-inertia': 'true', 'x-inertia-version': 'v1' },
        body: {},
      });
      expect(visit.status).toBe(200);
      expect(json(visit)['component']).toBe('Signup');
      expect(header(visit, 'vary')).toMatch(
        /^Precognition, X-Inertia, X-Inertia-Version, /,
      );
    });

    it('turns InertiaValidationException from a validator into 422', async () => {
      const result = await send(app, '/exception', {
        method: 'POST',
        headers: precognitive,
        body: {},
      });
      expect(result.status).toBe(422);
      expect(json(result)['errors']).toStrictEqual({
        code: ['Code already used.'],
      });
      expect(runs['exception']).toBeUndefined();
    });

    it('keeps the Precognition header on validator crashes without leaking details', async () => {
      const crash = await send(app, '/throws', {
        method: 'POST',
        headers: precognitive,
        body: {},
      });
      expect(crash.status).toBe(500);
      expect(header(crash, 'precognition')).toBe('true');
      expect(crash.body).not.toContain('hunter2');
      const broken = await send(app, '/broken', {
        method: 'POST',
        headers: precognitive,
        body: {},
      });
      expect(broken.status).toBe(500);
      expect(runs['throws']).toBeUndefined();
      expect(runs['broken']).toBeUndefined();
    });

    it('answers InertiaValidationException on undeclared routes with 422, not a redirect', async () => {
      const result = await send(app, '/plain', {
        method: 'POST',
        headers: {
          ...precognitive,
          referer: 'http://127.0.0.1/form',
        },
        body: {},
      });
      expect(result.status).toBe(422);
      expect(header(result, 'location')).toBeUndefined();
      expect(header(result, 'precognition')).toBe('true');
      expect(json(result)['errors']).toStrictEqual({
        name: ['Name is required.'],
      });
      // Undeclared routes run their handler (upstream behaviour): only
      // `@Precognitive` routes are validation-only.
      const reached = await send(app, '/plain', {
        method: 'POST',
        headers: precognitive,
        body: { name: 'ok' },
      });
      expect(json(reached)).toStrictEqual({ precognitive: true });
      expect(header(reached, 'precognition')).toBeUndefined();
    });
  },
);

// ------------------------------------------------- guards and multipart bodies

/** A route guard requiring `x-user: ada` (401 otherwise). */
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    if (request.headers['x-user'] !== 'ada') throw new UnauthorizedException();
    return true;
  }
}

class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('Not allowed.');
  }
}

/** An app-wide guard (like the examples' XSRF guard) that `x-gate: closed` trips. */
class GateGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    if (request.headers['x-gate'] === 'closed')
      throw new ForbiddenException('Gate closed.');
    return true;
  }
}

@Controller('locked')
@UseGuards(DenyGuard)
class LockedController {
  @Post()
  @Precognitive(signup)
  store() {
    ran('locked');
    return {};
  }
}

@Controller()
class GuardedController {
  @Post('guarded')
  @Precognitive(signup)
  @UseGuards(SignedInGuard)
  store() {
    ran('guarded');
    return {};
  }

  /** Not precognitive: its guard rejection must not look like a Precognition reply. */
  @Post('denied')
  @UseGuards(DenyGuard)
  denied() {
    ran('denied');
    return {};
  }

  @Post('open')
  open() {
    ran('open');
    return { open: true };
  }
}

interface UploadRequest {
  readonly headers: Record<string, unknown>;
  readonly raw?: IncomingMessage;
  body?: unknown;
  file?: unknown;
}

/**
 * A dependency-free multipart parser for Fastify (whose Nest adapter has no
 * FileInterceptor): it fills `body` and a multer-style `file`, as multer does.
 */
class WebFormInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    ran('parser');
    const request = context.switchToHttp().getRequest<UploadRequest>();
    const type = request.headers['content-type'];
    if (typeof type === 'string' && type.startsWith('multipart/form-data')) {
      const stream = Readable.toWeb(
        request.raw ?? (request as unknown as IncomingMessage),
      );
      const form = await new Response(stream as unknown as BodyInit, {
        headers: { 'content-type': type },
      }).formData();
      const fields: Record<string, string> = {};
      for (const [name, value] of form)
        if (typeof value === 'string') fields[name] = value;
        else
          request.file = {
            fieldname: name,
            originalname: value.name,
            mimetype: value.type,
            size: value.size,
          };
      request.body = fields;
    }
    return next.handle();
  }
}

/**
 * Sets multer's `request.files` the way `array()`/`any()` (a list) or
 * `fields()` (a record per field) do, picked by the `x-files-shape` header,
 * including a hostile `__proto__` field name.
 */
class FilesFixtureInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<UploadRequest & { files?: unknown }>();
    const file = (fieldname: string, originalname: string) => ({
      fieldname,
      originalname,
      mimetype: 'image/png',
      size: 3,
    });
    request.files =
      request.headers['x-files-shape'] === 'record'
        ? {
            photos: [file('photos', 'a.png'), file('photos', 'b.png')],
            cover: [file('cover', 'c.png')],
            ['__proto__']: [file('__proto__', 'x.png')],
            broken: 'not a list',
          }
        : [
            file('photos', 'a.png'),
            file('cover', 'c.png'),
            file('photos', 'b.png'),
            file('__proto__', 'x.png'),
            { originalname: 'no-field.png' },
          ];
    return next.handle();
  }
}

/** Reports what the default input saw: field names and per-field file counts. */
const galleryRules: PrecognitionValidator = (input) => {
  const record = input as Record<string, unknown>;
  const seen = Object.keys(record)
    .sort()
    .map((key) => {
      const value = record[key];
      return Array.isArray(value) ? `${key}:${value.length}` : key;
    });
  return {
    seen: seen.join(','),
    base:
      Object.getPrototypeOf(input) === Object.prototype ? 'plain' : 'changed',
  };
};

/** Never calls next.handle(): a misconfiguration the adapter must report. */
class StuckInterceptor implements NestInterceptor {
  intercept(): Observable<unknown> {
    return of('swallowed');
  }
}

/** Rules for a titled plain-text document; files arrive as multer-style objects. */
const documentRules: PrecognitionValidator = (input) => {
  const { title, document } = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (typeof title !== 'string' || title.trim() === '')
    errors['title'] = 'Enter a title.';
  const file = document as { mimetype?: unknown; size?: unknown } | undefined;
  if (typeof file !== 'object' || file === null)
    errors['document'] = 'Choose a file.';
  else if (file.mimetype !== 'text/plain')
    errors['document'] = 'Only plain text files are accepted.';
  else if (typeof file.size !== 'number' || file.size > 64)
    errors['document'] = 'The file may not be larger than 64 bytes.';
  return Object.keys(errors).length > 0 ? errors : undefined;
};

function uploadController(
  parser: Type<NestInterceptor> | NestInterceptor,
  limited: Type<NestInterceptor> | NestInterceptor,
): Type {
  @Controller('documents')
  class DocumentsController {
    @Post()
    @Precognitive(documentRules, { interceptors: [parser] })
    @UseInterceptors(parser)
    store(@Req() request: UploadRequest) {
      ran('documents');
      const file = request.file as { originalname?: unknown } | undefined;
      return {
        title: (request.body as Record<string, unknown>)['title'],
        file: file?.originalname,
      };
    }

    @Post('limited')
    @Precognitive(documentRules, { interceptors: [limited] })
    limitedStore() {
      ran('limited');
      return {};
    }

    @Post('gallery')
    @Precognitive(galleryRules, {
      interceptors: [FilesFixtureInterceptor],
    })
    gallery() {
      ran('gallery');
      return {};
    }

    @Post('stuck')
    @Precognitive(documentRules, { interceptors: [new StuckInterceptor()] })
    stuck() {
      ran('stuck');
      return {};
    }
  }
  return DocumentsController;
}

/** A multipart/form-data body like the official client's FormData requests. */
function multipart(
  parts: readonly (
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly filename: string;
        readonly type: string;
        readonly content: string;
      }
  )[],
): { body: Buffer; type: string } {
  const boundary = '----nestvexa-precognition-boundary';
  const chunks = parts.map((part) =>
    'filename' in part
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n${part.content}\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
  );
  return {
    body: Buffer.from(`${chunks.join('')}--${boundary}--\r\n`),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

describe.each(['express', 'fastify'] as const)(
  'Precognition guard rejections and multipart validateFiles() on %s',
  (platform: Platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      const parser =
        platform === 'express'
          ? FileInterceptor('document', { limits: { fileSize: 1024 } })
          : new WebFormInterceptor();
      const limited =
        platform === 'express'
          ? FileInterceptor('document', { limits: { fileSize: 8 } })
          : new WebFormInterceptor();
      app = await boot(
        platform,
        [InertiaModule.forRoot({ version: 'v1', ...sessionOption(platform) })],
        [
          LockedController,
          GuardedController,
          uploadController(parser, limited),
        ],
        {
          expressSession: platform === 'express',
          providers: [{ provide: APP_GUARD, useClass: GateGuard }],
          configure: (target) => {
            if (platform !== 'fastify') return;
            // Leave multipart bodies unparsed for the parser interceptor.
            (target as NestFastifyApplication)
              .getHttpAdapter()
              .getInstance()
              .addContentTypeParser('multipart/form-data', (_r, _p, done) =>
                done(null),
              );
          },
        },
      );
    });
    afterAll(closeAll);

    const valid = { name: 'Ada', email: 'ada@example.test' };

    it('keeps Precognition: true on route, controller and app guard rejections of precognitive routes', async () => {
      const snapshot = { ...runs };
      const unauthorized = await send(app, '/guarded', {
        method: 'POST',
        headers: precognitive,
        body: valid,
      });
      expect(unauthorized.status).toBe(401);
      expect(header(unauthorized, 'precognition')).toBe('true');
      expect(header(unauthorized, 'vary')).toBe('Precognition');
      expect(header(unauthorized, 'precognition-success')).toBeUndefined();
      const forbidden = await send(app, '/locked', {
        method: 'POST',
        headers: precognitive,
        body: valid,
      });
      expect(forbidden.status).toBe(403);
      expect(header(forbidden, 'precognition')).toBe('true');
      expect(header(forbidden, 'vary')).toBe('Precognition');
      // An app-wide guard rejects whether it runs before or after Inertia's.
      const gated = await send(app, '/guarded', {
        method: 'POST',
        headers: { ...precognitive, 'x-user': 'ada', 'x-gate': 'closed' },
        body: valid,
      });
      expect(gated.status).toBe(403);
      expect(header(gated, 'precognition')).toBe('true');
      expect(runs).toStrictEqual(snapshot);
      // Past the guards, the route still answers validation-only.
      const passed = await send(app, '/guarded', {
        method: 'POST',
        headers: { ...precognitive, 'x-user': 'ada' },
        body: valid,
      });
      expect(passed.status).toBe(204);
      expect(header(passed, 'precognition-success')).toBe('true');
      expect(header(passed, 'vary')).toBe('Precognition');
      expect(runs).toStrictEqual(snapshot);
    });

    it('leaves undeclared routes without Precognition headers, rejected or reached', async () => {
      const denied = await send(app, '/denied', {
        method: 'POST',
        headers: precognitive,
        body: {},
      });
      expect(denied.status).toBe(403);
      expect(header(denied, 'precognition')).toBeUndefined();
      expect(header(denied, 'vary')).toBeUndefined();
      expect(runs['denied']).toBeUndefined();
      const reached = await send(app, '/open', {
        method: 'POST',
        headers: precognitive,
        body: {},
      });
      // The handler ran, so the reply must not pass for a validation-only one.
      expect(reached.status).toBe(201);
      expect(json(reached)).toStrictEqual({ open: true });
      expect(header(reached, 'precognition')).toBeUndefined();
      expect(header(reached, 'vary')).toBeUndefined();
      const plain = await send(app, '/open', { method: 'POST', body: {} });
      expect(header(plain, 'precognition')).toBeUndefined();
    });

    it('validates uploaded files parsed by the declared interceptors without running the handler', async () => {
      const snapshot = { ...runs };
      const html = multipart([
        { name: 'title', value: 'Notes' },
        {
          name: 'document',
          filename: 'evil.html',
          type: 'text/html',
          content: '<script>alert(1)</script>',
        },
      ]);
      const rejected = await send(app, '/documents', {
        method: 'POST',
        headers: { ...precognitive, 'content-type': html.type },
        body: html.body,
      });
      expect(rejected.status).toBe(422);
      expect(header(rejected, 'precognition')).toBe('true');
      expect(json(rejected)['errors']).toStrictEqual({
        document: ['Only plain text files are accepted.'],
      });
      const text = multipart([
        { name: 'title', value: 'Notes' },
        {
          name: 'document',
          filename: 'notes.txt',
          type: 'text/plain',
          content: 'hello',
        },
      ]);
      const accepted = await send(app, '/documents', {
        method: 'POST',
        headers: { ...precognitive, 'content-type': text.type },
        body: text.body,
      });
      expect(accepted.status).toBe(204);
      expect(header(accepted, 'precognition-success')).toBe('true');
      // Precognition-Validate-Only still filters the file errors.
      const titleOnly = await send(app, '/documents', {
        method: 'POST',
        headers: {
          ...precognitive,
          'precognition-validate-only': 'title',
          'content-type': html.type,
        },
        body: html.body,
      });
      expect(titleOnly.status).toBe(204);
      // Without validateFiles() the client sends JSON without the file.
      const withoutFile = await send(app, '/documents', {
        method: 'POST',
        headers: precognitive,
        body: { title: '' },
      });
      expect(json(withoutFile)['errors']).toStrictEqual({
        title: ['Enter a title.'],
        document: ['Choose a file.'],
      });
      expect(runs['documents']).toBe(snapshot['documents']);
      expect((runs['parser'] ?? 0) - (snapshot['parser'] ?? 0)).toBe(
        platform === 'fastify' ? 4 : 0,
      );
      // The real submission goes through the route's own interceptor.
      const stored = await send(app, '/documents', {
        method: 'POST',
        headers: { 'content-type': text.type },
        body: text.body,
      });
      expect(stored.status).toBe(201);
      expect(json(stored)).toStrictEqual({ title: 'Notes', file: 'notes.txt' });
      expect(header(stored, 'precognition')).toBeUndefined();
      expect(runs['documents']).toBe((snapshot['documents'] ?? 0) + 1);
    });

    // Multer's size limit is an express parser; fastify has its own per-app.
    if (platform === 'express')
      it('keeps the Precognition header when the parser rejects an oversized file', async () => {
        const large = multipart([
          { name: 'title', value: 'Notes' },
          {
            name: 'document',
            filename: 'large.txt',
            type: 'text/plain',
            content: 'more than eight bytes',
          },
        ]);
        const result = await send(app, '/documents/limited', {
          method: 'POST',
          headers: { ...precognitive, 'content-type': large.type },
          body: large.body,
        });
        expect(result.status).toBe(413);
        expect(header(result, 'precognition')).toBe('true');
        expect(runs['limited']).toBeUndefined();
      });

    it('merges multer request.files lists and records by field name, never prototype keys', async () => {
      for (const shape of ['array', 'record']) {
        const result = await send(app, '/documents/gallery', {
          method: 'POST',
          headers: { ...precognitive, 'x-files-shape': shape },
          body: { title: 'Trip', photos: 'shadowed by the files' },
        });
        expect(result.status).toBe(422);
        expect(json(result)['errors']).toStrictEqual({
          seen: ['cover:1,photos:2,title'],
          base: ['plain'],
        });
      }
      expect(runs['gallery']).toBeUndefined();
    });

    it('reports an interceptor that never calls next.handle() as a server error', async () => {
      const result = await send(app, '/documents/stuck', {
        method: 'POST',
        headers: precognitive,
        body: { title: 'Notes' },
      });
      expect(result.status).toBe(500);
      expect(header(result, 'precognition')).toBe('true');
      expect(result.body).not.toContain('swallowed');
      expect(runs['stuck']).toBeUndefined();
    });
  },
);
