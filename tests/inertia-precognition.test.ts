import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
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
    });
  },
);
