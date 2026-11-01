import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Equals,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FORM_ERROR,
  FormInputError,
  classValidatorAdapter,
  customAdapter,
  localizeIssue,
  validateForm,
  zodAdapter,
} from '../packages/forms/dist/index.js';
import type {
  AdapterOutput,
  SchemaAdapter,
} from '../packages/forms/dist/index.js';

const taken = new Set(['taken@example.com']);
async function emailAvailable(email: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return !taken.has(email.toLowerCase());
}

const signup = z
  .strictObject({
    name: z.string().trim().min(2, 'Enter at least 2 characters.').max(60),
    email: z
      .email('Enter a valid email address.')
      .refine(emailAvailable, 'This email is already registered.'),
    password: z.string().min(12).max(128),
    confirm: z.string(),
    age: z.number().int().min(13).optional(),
    items: z
      .array(z.strictObject({ name: z.string().min(1, 'Name each item.') }))
      .max(3)
      .default([]),
  })
  .refine((value) => value.password === value.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match.',
  });

describe('zodAdapter', () => {
  const adapter = zodAdapter(signup);
  const valid = {
    name: ' Ada ',
    email: 'ada@example.com',
    password: 'correct horse battery',
    confirm: 'correct horse battery',
    items: [{ name: 'Lamp' }],
  };

  it('returns the typed, transformed value', async () => {
    const result = await adapter.validate(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Type-level check: the inferred output carries schema types.
    const name: string = result.value.name;
    const items: readonly { name: string }[] = result.value.items;
    expect(name).toBe('Ada');
    expect(items).toEqual([{ name: 'Lamp' }]);
    type Output = AdapterOutput<typeof adapter>;
    const typed: Output['email'] = result.value.email;
    expect(typed).toBe('ada@example.com');
  });

  it('reports stable dotted paths for nested and cross-field errors', async () => {
    const result = await adapter.validate({
      ...valid,
      name: 'A',
      confirm: 'different value!',
      items: [{ name: 'ok' }, { name: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['name']).toEqual(['Enter at least 2 characters.']);
    expect(result.errors['items.1.name']).toEqual(['Name each item.']);
    // Object-level refinements run only once the shape parsed; fix shape first.
    const crossField = await adapter.validate({
      ...valid,
      confirm: 'different value!',
    });
    expect(crossField.ok).toBe(false);
    if (crossField.ok) return;
    expect(crossField.errors).toEqual({ confirm: ['Passwords do not match.'] });
  });

  it('runs async uniqueness refinements', async () => {
    const result = await adapter.validate({
      ...valid,
      email: 'Taken@example.com',
    });
    expect(result).toEqual({
      ok: false,
      errors: { email: ['This email is already registered.'] },
    });
  });

  it('does not coerce types: strings, numbers and booleans stay distinct', async () => {
    for (const [field, value] of [
      ['age', '18'],
      ['age', true],
      ['name', 42],
      ['name', ['Ada']],
      ['name', { toString: 'Ada' }],
      ['items', 'Lamp'],
      ['items', { 0: { name: 'Lamp' } }],
    ] as const) {
      const result = await adapter.validate({ ...valid, [field]: value });
      expect(result.ok, `${field}=${JSON.stringify(value)}`).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)[0]).toMatch(field);
    }
  });

  it('rejects unknown keys with strictObject (mass assignment)', async () => {
    const result = await adapter.validate({ ...valid, isAdmin: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[FORM_ERROR]?.[0]).toMatch(/isAdmin/);
  });

  it('localizes messages by path:code, then code, with {path}', async () => {
    const localized = zodAdapter(z.strictObject({ name: z.string().min(3) }), {
      messages: {
        too_small: 'Le champ {path} est trop court.',
        'name:invalid_type': 'Nom requis.',
      },
    });
    expect(await localized.validate({ name: 'a' })).toEqual({
      ok: false,
      errors: { name: ['Le champ name est trop court.'] },
    });
    expect(await localized.validate({})).toEqual({
      ok: false,
      errors: { name: ['Nom requis.'] },
    });
    const viaFunction = zodAdapter(
      z.strictObject({ name: z.string().min(3) }),
      {
        messages: (issue) =>
          issue.code === 'too_small' ? `${issue.path}: trop court` : undefined,
      },
    );
    expect(await viaFunction.validate({ name: 'a' })).toEqual({
      ok: false,
      errors: { name: ['name: trop court'] },
    });
    expect(
      localizeIssue({ path: '', code: 'x', message: 'Default {path}' }, {}),
    ).toBe('Default _form');
  });

  it('hardens before parsing: prototype keys never reach the schema', async () => {
    const hostile = JSON.parse(
      '{"name":"Ada","__proto__":{"isAdmin":true}}',
    ) as object;
    await expect(adapter.validate(hostile)).rejects.toBeInstanceOf(
      FormInputError,
    );
    expect(Reflect.get({}, 'isAdmin')).toBeUndefined();
  });

  it('rejects construction without a schema', () => {
    expect(() => zodAdapter({} as never)).toThrow(/Zod schema/);
  });
});

class ItemDto {
  @IsString()
  @Length(1, 40, { message: 'Name each item.' })
  name!: string;
}
class ProfileDto {
  @IsString()
  @Length(2, 60)
  displayName!: string;

  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(130)
  age?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMaxSize(3)
  @Type(() => ItemDto)
  items?: ItemDto[];
}
class PasswordChangeDto {
  @IsString({ groups: ['change'] })
  @Length(12, 128, { groups: ['change'] })
  password!: string;

  @IsString({ groups: ['change'] })
  @Equals('yes', { groups: ['confirm'], message: 'Confirm the change.' })
  confirmed!: string;
}

describe('classValidatorAdapter', () => {
  const adapter = classValidatorAdapter(ProfileDto);

  it('returns a DTO instance on success', async () => {
    const result = await adapter.validate({
      displayName: 'Ada',
      email: 'ada@example.com',
      age: 36,
      items: [{ name: 'Lamp' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeInstanceOf(ProfileDto);
    expect(result.value.items?.[0]).toBeInstanceOf(ItemDto);
    const email: string = result.value.email;
    expect(email).toBe('ada@example.com');
  });

  it('maps nested errors to dotted paths and keeps constraint names for localization', async () => {
    const result = await classValidatorAdapter(ProfileDto, {
      messages: { isLength: 'Longueur invalide ({path}).' },
    }).validate({
      displayName: 'A',
      email: 'nope',
      items: [{ name: 'ok' }, { name: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['displayName']).toEqual([
      'Longueur invalide (displayName).',
    ]);
    expect(result.errors['email']).toEqual(['Enter a valid email address.']);
    expect(result.errors['items.1.name']).toEqual([
      'Longueur invalide (items.1.name).',
    ]);
  });

  it('forbids unknown properties by default and allows stripping explicitly', async () => {
    const strict = await adapter.validate({
      displayName: 'Ada',
      email: 'ada@example.com',
      role: 'admin',
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok)
      expect(strict.errors['role']?.[0]).toMatch(/should not exist/);
    const stripping = await classValidatorAdapter(ProfileDto, {
      forbidNonWhitelisted: false,
    }).validate({
      displayName: 'Ada',
      email: 'ada@example.com',
      role: 'admin',
    });
    expect(stripping.ok).toBe(true);
    if (stripping.ok) expect(Reflect.has(stripping.value, 'role')).toBe(false);
  });

  it('never converts implicitly ("36" is not an integer)', async () => {
    const result = await adapter.validate({
      displayName: 'Ada',
      email: 'ada@example.com',
      age: '36',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(['age']);
  });

  it('runs only the requested validation groups (strict by default)', async () => {
    const change = classValidatorAdapter(PasswordChangeDto, {
      groups: ['change'],
    });
    const changeResult = await change.validate({
      password: 'short',
      confirmed: 'no',
    });
    expect(changeResult.ok).toBe(false);
    if (!changeResult.ok)
      expect(Object.keys(changeResult.errors)).toEqual(['password']);
    const confirm = classValidatorAdapter(PasswordChangeDto, {
      groups: ['confirm'],
    });
    expect(await confirm.validate({ confirmed: 'no' })).toEqual({
      ok: false,
      errors: { confirmed: ['Confirm the change.'] },
    });
    // Whitelisting follows the active groups: fields of other groups are unknown here.
    const outside = await confirm.validate({ password: 'x', confirmed: 'yes' });
    expect(outside).toEqual({
      ok: false,
      errors: { password: ['property password should not exist'] },
    });
    expect(() =>
      classValidatorAdapter(PasswordChangeDto, { groups: [''] }),
    ).toThrow(/groups/);
  });

  it('supports partial validation with skipMissingProperties', async () => {
    const partial = classValidatorAdapter(ProfileDto, {
      skipMissingProperties: true,
    });
    expect((await partial.validate({ displayName: 'Ada' })).ok).toBe(true);
    expect((await adapter.validate({ displayName: 'Ada' })).ok).toBe(false);
  });

  it('rejects non-object input and hostile keys before transformation', async () => {
    expect(await adapter.validate('displayName=Ada')).toEqual({
      ok: false,
      errors: { [FORM_ERROR]: ['Expected form fields.'] },
    });
    expect(await adapter.validate(['Ada'])).toEqual({
      ok: false,
      errors: { [FORM_ERROR]: ['Expected form fields.'] },
    });
    await expect(
      adapter.validate(JSON.parse('{"constructor":{"prototype":{"x":1}}}')),
    ).rejects.toBeInstanceOf(FormInputError);
  });
});

describe('customAdapter and validateForm', () => {
  const login = customAdapter<{ email: string; password: string }>(
    async (input, issues) => {
      const email = typeof input['email'] === 'string' ? input['email'] : '';
      const password =
        typeof input['password'] === 'string' ? input['password'] : '';
      if (!email.includes('@'))
        issues.issue('email', 'email', 'Enter your email address.');
      if (!password)
        issues.issue(['password'], 'required', 'Enter a password.');
      await Promise.resolve();
      return { email, password };
    },
    { messages: { required: 'Mot de passe requis.' } },
  );

  it('collects issues, localizes and returns typed values', async () => {
    expect(await login.validate({ email: 'x' })).toEqual({
      ok: false,
      errors: {
        email: ['Enter your email address.'],
        password: ['Mot de passe requis.'],
      },
    });
    expect(await login.validate({ email: 'a@b.c', password: 'pw' })).toEqual({
      ok: true,
      value: { email: 'a@b.c', password: 'pw' },
    });
  });

  it('places unsafe issue paths on the nearest safe ancestor', async () => {
    const adapter = customAdapter((_input, issues) => {
      issues.issue(['items', 0, '__proto__'], 'x', 'bad nested');
      issues.issue('', 'form', 'whole form');
      return null;
    });
    expect(await adapter.validate({})).toEqual({
      ok: false,
      errors: { 'items.0': ['bad nested'], [FORM_ERROR]: ['whole form'] },
    });
  });

  it('validateForm hardens and bounds third-party adapter output', async () => {
    const noisy: SchemaAdapter<never> = {
      validate: () =>
        Promise.resolve({
          ok: false,
          errors: Object.fromEntries(
            Array.from({ length: 150 }, (_, index) => [
              `field${index}`,
              ['x'.repeat(900), 'second', 'third', 'fourth', 'fifth', 'sixth'],
            ]),
          ),
        }),
    };
    const result = await validateForm(noisy, { a: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors)).toHaveLength(100);
    expect(result.errors['field0']).toHaveLength(5);
    expect(result.errors['field0']?.[0]).toHaveLength(500);
    const empty: SchemaAdapter<never> = {
      validate: () => Promise.resolve({ ok: false, errors: {} }),
    };
    expect(await validateForm(empty, {})).toEqual({
      ok: false,
      errors: { [FORM_ERROR]: ['The form is invalid.'] },
    });
    const broken = {
      validate: () => Promise.resolve('yes'),
    } as unknown as SchemaAdapter<never>;
    await expect(validateForm(broken, {})).rejects.toThrow(/invalid result/);
    await expect(
      validateForm(
        noisy,
        { nested: { deeper: { deepest: 'x' } } },
        {
          limits: { maxDepth: 2 },
        },
      ),
    ).rejects.toMatchObject({ code: 'DEPTH' });
  });
});
