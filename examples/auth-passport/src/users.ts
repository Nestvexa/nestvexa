import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/*
 * Accounts, password hashing and one-time tokens. Hashing is argon2id from the
 * `argon2` package (a binding to the reference implementation); nothing here
 * implements cryptography. Tokens are 256-bit values from the OS CSPRNG,
 * stored only as SHA-256 digests, single use and short lived.
 */

export type Role = 'member' | 'admin';
export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  /** Set once the email address is confirmed. */
  readonly verifiedAt: number | undefined;
  /**
   * Bumped on every password change. Sessions and JWTs carry the version they
   * were issued for, so a reset signs out every other device.
   */
  readonly authVersion: number;
}
interface StoredUser extends User {
  readonly passwordHash: string;
}

/** Clock injection point (tests move time forward to expire tokens). */
export const CLOCK = Symbol('CLOCK');
export type Clock = () => number;

/** Public demonstration password of the seeded accounts. Never reuse it. */
export const DEMO_PASSWORD = 'demo-password-2026';
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;

// OWASP Password Storage Cheat Sheet minimum for argon2id: m=19 MiB, t=2, p=1.
const hashing = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function passwordError(password: string): string | undefined {
  if (password.length < MIN_PASSWORD)
    return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD)
    return `Use at most ${MAX_PASSWORD} characters.`;
  return undefined;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

function publicUser(user: StoredUser | undefined): User | undefined {
  if (!user) return undefined;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    verifiedAt: user.verifiedAt,
    authVersion: user.authVersion,
  };
}

/** In-memory accounts. A real host keeps them in its database. */
@Injectable()
export class UserStore {
  readonly #users = new Map<string, StoredUser>();
  /** Verified against for unknown emails, so timing does not reveal accounts. */
  readonly #dummy = argon2.hash(randomBytes(32).toString('hex'), hashing);
  readonly #ready: Promise<void>;

  constructor(@Inject(CLOCK) private readonly now: Clock) {
    this.#ready = this.#seed();
  }
  async #seed(): Promise<void> {
    const seeded = [
      { id: 'u-ada', email: 'ada@example.test', name: 'Ada', role: 'admin' },
      { id: 'u-max', email: 'max@example.test', name: 'Max', role: 'member' },
    ] as const;
    for (const account of seeded)
      this.#users.set(account.id, {
        ...account,
        verifiedAt: this.now(),
        authVersion: 1,
        passwordHash: await argon2.hash(DEMO_PASSWORD, hashing),
      });
  }
  #find(email: string): StoredUser | undefined {
    const wanted = normalizeEmail(email);
    return [...this.#users.values()].find((user) => user.email === wanted);
  }

  async byId(id: string): Promise<User | undefined> {
    await this.#ready;
    return publicUser(this.#users.get(id));
  }
  async byEmail(email: string): Promise<User | undefined> {
    await this.#ready;
    return publicUser(this.#find(email));
  }

  /** The account for these credentials, or undefined (one generic failure). */
  async verifyCredentials(
    email: string,
    password: string,
  ): Promise<User | undefined> {
    await this.#ready;
    const user = this.#find(email);
    if (!user || password.length > MAX_PASSWORD) {
      await argon2.verify(await this.#dummy, password.slice(0, MAX_PASSWORD));
      return undefined;
    }
    return (await argon2.verify(user.passwordHash, password))
      ? publicUser(user)
      : undefined;
  }

  /** Creates an unverified member; undefined when the email is taken. */
  async register(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<User | undefined> {
    await this.#ready;
    if (this.#find(input.email) || this.#users.size >= 1000) return undefined;
    const user: StoredUser = {
      id: `u-${randomUUID()}`,
      email: normalizeEmail(input.email),
      name: input.name,
      role: 'member',
      verifiedAt: undefined,
      authVersion: 1,
      passwordHash: await argon2.hash(input.password, hashing),
    };
    this.#users.set(user.id, user);
    return publicUser(user);
  }

  async setPassword(id: string, password: string): Promise<void> {
    const user = this.#users.get(id);
    if (!user) return;
    const passwordHash = await argon2.hash(password, hashing);
    this.#users.set(id, {
      ...user,
      passwordHash,
      authVersion: user.authVersion + 1,
    });
  }
  markVerified(id: string): void {
    const user = this.#users.get(id);
    if (user && user.verifiedAt === undefined)
      this.#users.set(id, { ...user, verifiedAt: this.now() });
  }
  rename(id: string, name: string): void {
    const user = this.#users.get(id);
    if (user) this.#users.set(id, { ...user, name });
  }
}

export type TokenPurpose = 'password-reset' | 'email-verification';
export const TOKEN_LIFETIME_MS: Readonly<Record<TokenPurpose, number>> = {
  'password-reset': 30 * 60_000,
  'email-verification': 24 * 60 * 60_000,
};
interface TokenRecord {
  readonly userId: string;
  readonly purpose: TokenPurpose;
  readonly expiresAt: number;
}
const digest = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * Single-use, expiring tokens for reset and verification links. Only the
 * SHA-256 digest is stored, so a leaked store does not reveal usable links.
 */
@Injectable()
export class OneTimeTokens {
  readonly #records = new Map<string, TokenRecord>();
  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  /** Issues a token and revokes earlier ones for the same user and purpose. */
  issue(userId: string, purpose: TokenPurpose): string {
    this.revoke(userId, purpose);
    for (const [key, record] of this.#records)
      if (record.expiresAt <= this.now()) this.#records.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.#records.set(digest(token), {
      userId,
      purpose,
      expiresAt: this.now() + TOKEN_LIFETIME_MS[purpose],
    });
    return token;
  }
  revoke(userId: string, purpose: TokenPurpose): void {
    for (const [key, record] of this.#records)
      if (record.userId === userId && record.purpose === purpose)
        this.#records.delete(key);
  }
  /** True while the token is valid (for showing the form; does not consume). */
  check(token: unknown, purpose: TokenPurpose): boolean {
    return this.#find(token, purpose) !== undefined;
  }
  /** Consumes a valid token; unknown, used and expired tokens return undefined. */
  consume(token: unknown, purpose: TokenPurpose): string | undefined {
    const found = this.#find(token, purpose);
    if (!found) return undefined;
    this.#records.delete(found.key);
    return found.record.userId;
  }
  #find(token: unknown, purpose: TokenPurpose) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return undefined;
    const key = digest(token);
    const record = this.#records.get(key);
    if (!record || record.purpose !== purpose) return undefined;
    if (record.expiresAt <= this.now()) {
      this.#records.delete(key);
      return undefined;
    }
    return { key, record };
  }
}
