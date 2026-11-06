import 'reflect-metadata';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FORM_ERROR,
  classValidatorAdapter,
  classValidatorHints,
  defineForm,
  finalizeFileField,
  hintAttributeString,
  hintAttributes,
  hintsFromJsonSchema,
  isUploadError,
  uploadFormErrors,
  zodAdapter,
  zodHints,
} from '../packages/forms/dist/index.js';
import type { FormSnapshot } from '../packages/forms/dist/index.js';

const schema = z.strictObject({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(40),
  email: z.email('Enter a valid email address.'),
  tags: z.array(z.string()).max(3),
  newsletter: z.boolean(),
  avatar: z.string(),
});
const token = (char: string) => `nvu_${char.repeat(43)}`;

describe('defineForm state object', () => {
  const profile = defineForm({
    fields: { name: '', email: '', tags: [], newsletter: false },
    files: { avatar: {} },
    adapter: zodAdapter(schema),
    hints: zodHints(schema),
  });
  it('creates JSON state from defaults and tracks dirty and touched fields', () => {
    const state = profile.create({ email: 'a@example.test' });
    expect(state).toEqual({
      values: {
        name: '',
        email: 'a@example.test',
        tags: [],
        newsletter: false,
        avatar: '',
      },
      initial: {
        name: '',
        email: 'a@example.test',
        tags: [],
        newsletter: false,
        avatar: '',
      },
      errors: {},
      touched: [],
      dirty: [],
      submitted: false,
      submitCount: 0,
      pending: false,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const edited = profile.touch(
      profile.update(state, { name: 'Ada', tags: ['x'] }),
      ['name'],
    );
    expect(edited.dirty).toEqual(['name', 'tags']);
    expect(edited.touched).toEqual(['name']);
    expect(profile.update(edited, { name: '' }).dirty).toEqual(['tags']);
    expect(profile.fields).toEqual([
      'name',
      'email',
      'tags',
      'newsletter',
      'avatar',
    ]);
  });
  it('refuses undeclared, malicious and malformed input', () => {
    const state = profile.create();
    expect(() => profile.update(state, { role: 'admin' })).toThrow();
    expect(() =>
      profile.update(
        state,
        JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>,
      ),
    ).toThrow();
    expect(() => profile.update(state, { name: () => 1 })).toThrow();
    expect(() => profile.touch(state, ['role'])).toThrow();
    expect(() => profile.create({ ['constructor']: 'x' })).toThrow();
    // Stored snapshots are rebuilt from declared fields only.
    const tampered = {
      ...state,
      values: { ...state.values, role: 'admin' },
      submitCount: -4,
      touched: ['name', 'role', 3],
    } as unknown as FormSnapshot;
    const repaired = profile.touch(tampered, []);
    expect(repaired.values).not.toHaveProperty('role');
    expect(repaired.submitCount).toBe(0);
    expect(repaired.touched).toEqual(['name']);
  });
  it('resets to the baseline, clears values and moves the baseline on reset(values)', () => {
    let state = profile.update(profile.create({ name: 'Ada' }), {
      name: 'Grace',
      newsletter: true,
      tags: ['a'],
    });
    state = profile.begin(state);
    state = profile.finish(state, { errors: { name: ['Taken'] } });
    const reset = profile.reset(state);
    expect(reset.values.name).toBe('Ada');
    expect(reset).toMatchObject({
      errors: {},
      touched: [],
      dirty: [],
      submitted: false,
      submitCount: 0,
      pending: false,
    });
    const cleared = profile.clear(state);
    expect(cleared.values).toEqual({
      name: '',
      email: '',
      tags: [],
      newsletter: false,
      avatar: '',
    });
    expect(cleared.dirty).toEqual(['name']);
    expect(cleared.errors).toEqual({});
    const rebased = profile.reset(state, { name: 'Linus' });
    expect(rebased.initial.name).toBe('Linus');
    expect(rebased.dirty).toEqual([]);
  });
  it('tracks pending and submitted around a submit and refuses a concurrent one', async () => {
    const state = profile.update(profile.create(), {
      name: 'Ada',
      email: 'ada@example.test',
    });
    const pending = profile.begin(state);
    expect(pending).toMatchObject({
      pending: true,
      submitted: true,
      submitCount: 1,
    });
    expect(() => profile.begin(pending)).toThrow('already being submitted');
    const handled: unknown[] = [];
    const ok = await profile.submit(state, (value) => {
      handled.push(value);
    });
    expect(ok.ok).toBe(true);
    expect(ok.state).toMatchObject({
      pending: false,
      submitted: true,
      submitCount: 1,
      errors: {},
    });
    expect(handled).toEqual([
      {
        name: 'Ada',
        email: 'ada@example.test',
        tags: [],
        newsletter: false,
        avatar: '',
      },
    ]);
    const invalid = await profile.submit(
      profile.update(state, { name: 'A', email: 'x' }),
      () => {
        throw new Error('must not run');
      },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.state.pending).toBe(false);
    expect(invalid.state.errors).toEqual({
      name: ['Enter at least 2 characters.'],
      email: ['Enter a valid email address.'],
    });
    const rejected = await profile.submit(state, () => ({
      errors: { email: ['Already registered.'] },
    }));
    expect(rejected.ok).toBe(false);
    expect(rejected.state.errors).toEqual({ email: ['Already registered.'] });
  });
  it('builds template data with visibility rules, summary and hints', () => {
    const state = profile.finish(profile.touch(profile.create(), ['name']), {
      errors: { name: ['Too short'], email: ['Bad'] },
    });
    const before = profile.view(state, { idPrefix: 'p-' });
    expect(before.fields['name']).toMatchObject({
      id: 'p-name',
      invalid: true,
      message: 'Too short',
    });
    expect(before.fields['email']?.invalid).toBe(false);
    expect(before.summary.count).toBe(2);
    expect(before.valid).toBe(false);
    expect(before.hints['name']).toEqual({
      required: true,
      minLength: 2,
      maxLength: 40,
    });
    const submitted = profile.view(
      profile.finish(profile.begin(state), { errors: { email: ['Bad'] } }),
    );
    expect(submitted.fields['email']?.invalid).toBe(true);
  });
  it('validates file-field references and maps upload failures to field errors', async () => {
    const one = profile.update(profile.create(), { avatar: token('a') });
    expect(profile.files(one, 'avatar')).toEqual([token('a')]);
    const many = profile.update(profile.create(), {
      avatar: `${token('a')},${token('b')}`,
    });
    expect(() => profile.files(many, 'avatar')).toThrow();
    const result = await profile.validate(
      profile.update(profile.create(), {
        name: 'Ada',
        email: 'ada@example.test',
        avatar: '../../etc/passwd',
      }),
    );
    expect(result.result.ok).toBe(false);
    expect(result.state.errors).toEqual({ avatar: ['Upload the file again.'] });
    expect(() => profile.files(one, 'name')).toThrow('not a file field');

    class UploadError extends Error {
      constructor(readonly code: string) {
        super(code);
        this.name = 'UploadError';
      }
    }
    expect(isUploadError(new UploadError('FILE_TOO_LARGE'))).toBe(true);
    expect(isUploadError(new Error('FILE_TOO_LARGE'))).toBe(false);
    expect(
      uploadFormErrors(new UploadError('FILE_TOO_LARGE'), 'avatar'),
    ).toEqual({ avatar: ['The file is too large.'] });
    expect(
      uploadFormErrors(new UploadError('UPLOAD_INFECTED'), 'avatar', {
        UPLOAD_INFECTED: 'Virus found.',
      }),
    ).toEqual({ avatar: ['Virus found.'] });
    expect(
      uploadFormErrors(new UploadError('SOMETHING_NEW'), 'avatar'),
    ).toEqual({ avatar: ['The file could not be accepted.'] });
    expect(uploadFormErrors(new Error('db down'), 'avatar')).toBeUndefined();

    const finalized = await finalizeFileField(profile, one, 'avatar', (value) =>
      Promise.resolve({ key: value.slice(0, 6) }),
    );
    expect(finalized).toEqual({ ok: true, files: [{ key: 'nvu_aa' }] });
    const failed = await finalizeFileField(profile, one, 'avatar', () =>
      Promise.reject(new UploadError('UPLOAD_EXPIRED')),
    );
    expect(failed).toEqual({
      ok: false,
      errors: { avatar: ['The upload expired. Upload the file again.'] },
      files: [],
    });
    await expect(
      finalizeFileField(profile, one, 'avatar', () =>
        Promise.reject(new Error('storage offline')),
      ),
    ).rejects.toThrow('storage offline');
    expect(
      await finalizeFileField(profile, many, 'avatar', () =>
        Promise.resolve(1),
      ),
    ).toMatchObject({
      ok: false,
      errors: { avatar: ['Upload the file again.'] },
    });
    const multiple = defineForm({ fields: {}, files: { docs: { max: 3 } } });
    expect(
      multiple.files(
        multiple.update(multiple.create(), {
          docs: `${token('a')},${token('b')}`,
        }),
        'docs',
      ),
    ).toHaveLength(2);
    expect(() => defineForm({ fields: { a: '' }, files: { a: {} } })).toThrow();
    expect(() =>
      defineForm({ fields: {}, files: { a: { max: 0 } } }),
    ).toThrow();
  });
});

describe('schema-derived client validation hints', () => {
  it('derives conservative hints from Zod and escapes generated attributes', () => {
    const shape = z.strictObject({
      name: z.string().min(2).max(50),
      email: z.email(),
      site: z.url().optional(),
      age: z.number().int().min(18).max(120).optional(),
      price: z.number().multipleOf(0.5),
      code: z.string().regex(/^[A-Z]{3}$/),
      either: z.string().regex(/^a|b$/),
      loose: z.string().regex(/abc/),
      caseless: z.string().regex(/^[a-z]+$/i),
      negated: z.string().regex(/^[^@]+$/),
      quote: z.string().regex(/^"[a-z]*"$/),
      address: z.object({ city: z.string().min(1) }),
      tags: z.array(z.string()),
      agree: z.boolean(),
    });
    const hints = zodHints(shape, { patterns: true });
    // Zod's JSON Schema drops the `i` flag: without opt-in no pattern is emitted.
    expect(zodHints(shape)['code']).toEqual({ required: true });
    expect(hints).toEqual({
      name: { required: true, minLength: 2, maxLength: 50 },
      email: { required: true, type: 'email' },
      site: { required: false, type: 'url' },
      age: { required: false, type: 'number', min: 18, max: 120, step: 1 },
      price: { required: true, type: 'number', step: 0.5 },
      code: { required: true, pattern: '[A-Z]{3}' },
      either: { required: true },
      loose: { required: true },
      // Lost flag: the opt-in is documented as unsafe for flagged regexes.
      caseless: { required: true, pattern: '[a-z]+' },
      negated: { required: true, pattern: '[^@]+' },
      quote: { required: true, pattern: '"[a-z]*"' },
      'address.city': { required: true, minLength: 1 },
    });
    expect(hintAttributes(hints['age'])).toEqual({
      type: 'number',
      min: '18',
      max: '120',
      step: '1',
    });
    expect(hintAttributeString(hints['name'])).toBe(
      ' required minlength="2" maxlength="50"',
    );
    expect(hintAttributeString(hints['quote'])).toBe(
      ' required pattern="&quot;[a-z]*&quot;"',
    );
    expect(hintAttributeString(undefined)).toBe('');
    expect(() => zodHints({} as never)).toThrow();
    expect(
      hintsFromJsonSchema({
        type: 'object',
        properties: {
          __proto__: { type: 'string' },
          ok: { type: 'string', minLength: -1, maxLength: 1e12 },
        },
      }),
    ).toEqual({ ok: { required: false } });
  });
  it('derives hints from class-validator metadata with groups', async () => {
    class Signup {
      @IsString()
      @MinLength(2)
      @MaxLength(40)
      name!: string;
      @IsEmail()
      email!: string;
      @IsOptional()
      @IsInt()
      @Min(18)
      @Max(120)
      age?: number;
      @Matches(/^[A-Z]{3}$/)
      code!: string;
      @Length(4, 8, { groups: ['strict'] })
      pin!: string;
    }
    expect(await classValidatorHints(Signup)).toEqual({
      name: { required: true, minLength: 2, maxLength: 40 },
      email: { required: true, type: 'email' },
      age: { required: false, type: 'number', step: 1, min: 18, max: 120 },
      code: { required: true, pattern: '[A-Z]{3}' },
      pin: { required: true, minLength: 4, maxLength: 8 },
    });
    expect(
      (await classValidatorHints(Signup, { groups: ['other'] }))['pin'],
    ).toBeUndefined();
  });
});

describe('class-transformer transform failures', () => {
  it('reports a thrown @Transform as a form-level transform issue', async () => {
    class Order {
      @IsString()
      @Transform(({ value }: { value: unknown }) => {
        if (value === 'explode') throw new Error('secret transform detail');
        return value;
      })
      sku!: string;
    }
    const adapter = classValidatorAdapter(Order, {
      messages: { transform: 'We could not read that order.' },
    });
    expect(await adapter.validate({ sku: 'explode' })).toEqual({
      ok: false,
      errors: { [FORM_ERROR]: ['We could not read that order.'] },
    });
    const defaults = classValidatorAdapter(Order);
    const result = await defaults.validate({ sku: 'explode' });
    expect(result).toEqual({
      ok: false,
      errors: { [FORM_ERROR]: ['The submitted values could not be read.'] },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await defaults.validate({ sku: 'ok' })).toMatchObject({ ok: true });
  });
});
