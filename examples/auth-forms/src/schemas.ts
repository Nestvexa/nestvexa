import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';
import { z } from 'zod';
import {
  classValidatorAdapter,
  customAdapter,
  zodAdapter,
} from '@nestvexa/forms';
import type { UserRepository } from './auth.js';

/** Cross-field rule: this property must equal another property. */
@ValidatorConstraint({ name: 'sameAs' })
class SameAs implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [other] = args.constraints as [string];
    return value === Reflect.get(args.object, other);
  }
  defaultMessage(): string {
    return 'Passwords do not match.';
  }
}

/** Registration DTO validated with class-validator (no implicit conversion). */
export class RegisterDto {
  @IsString()
  @Length(2, 60, { message: 'Enter a name between 2 and 60 characters.' })
  displayName!: string;

  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(12, 128, { message: 'Use a password of 12 to 128 characters.' })
  password!: string;

  @IsString()
  @Validate(SameAs, ['password'])
  passwordConfirmation!: string;
}
export const registerAdapter = classValidatorAdapter(RegisterDto);

/** Sign-in: presence checks only; credentials are verified by the auth policy. */
export const loginAdapter = customAdapter<{ email: string; password: string }>(
  (input, issues) => {
    const email =
      typeof input['email'] === 'string' ? input['email'].trim() : '';
    const password =
      typeof input['password'] === 'string' ? input['password'] : '';
    if (!email || email.length > 254)
      issues.issue('email', 'required', 'Enter your email address.');
    if (!password || password.length > 128)
      issues.issue('password', 'required', 'Enter your password.');
    for (const key of Object.keys(input))
      if (key !== 'email' && key !== 'password')
        issues.issue('', 'unknown', 'Unexpected form field.');
    return { email, password };
  },
);

export const profileFields = ['displayName', 'email', 'bio'] as const;

/**
 * Profile schema shared by the Live editor and the no-JS POST route. The async
 * refinement checks email uniqueness against the repository (excluding the
 * signed-in user). `withVersion` adds the hidden optimistic-concurrency field
 * that only the no-JS form submits.
 */
export function profileAdapter(users: UserRepository, userId: string) {
  return zodAdapter(
    z.strictObject({
      displayName: z
        .string()
        .trim()
        .min(2, 'Enter a name between 2 and 60 characters.')
        .max(60, 'Enter a name between 2 and 60 characters.'),
      email: z
        .string()
        .trim()
        .max(254)
        .pipe(z.email('Enter a valid email address.'))
        .refine(
          (email) => users.emailAvailable(email, userId),
          'Another account already uses this email address.',
        ),
      bio: z.string().max(280, 'Keep your bio to 280 characters.'),
    }),
  );
}
export function profilePostAdapter(users: UserRepository, userId: string) {
  const profile = profileAdapter(users, userId);
  return customAdapter<{
    displayName: string;
    email: string;
    bio: string;
    version: number;
  }>(async (input, issues) => {
    const { version, ...fields } = input;
    const parsed =
      typeof version === 'string' && /^[1-9][0-9]{0,8}$/.test(version)
        ? Number(version)
        : 0;
    if (!parsed) issues.issue('', 'version', 'Reload the page and try again.');
    const result = await profile.validate(fields);
    if (!result.ok) {
      for (const [path, messages] of Object.entries(result.errors))
        for (const message of messages) issues.issue(path, 'profile', message);
      return { displayName: '', email: '', bio: '', version: parsed };
    }
    return { ...result.value, version: parsed };
  });
}
