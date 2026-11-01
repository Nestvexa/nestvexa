import {
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Session, SessionData } from 'express-session';

/*
 * Illustrative, host-owned authentication policy for the forms starter. It shows
 * the shape of a careful login flow; it is NOT a production identity provider:
 * accounts live in process memory, there is no email verification, password
 * reset, MFA, breach screening, audit log or distributed throttling.
 */

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    userId?: string;
  }
}
export interface SessionRequest {
  session: Session & Partial<SessionData>;
  sessionID: string;
  ip?: string;
  body?: unknown;
}

export interface Profile {
  readonly displayName: string;
  readonly email: string;
  readonly bio: string;
}
export interface User extends Profile {
  readonly id: string;
  readonly passwordHash: string;
  /** Optimistic-concurrency version of the profile; increases on every save. */
  readonly version: number;
}

// scrypt cost: N=2^14, r=8, p=1 (~16 MiB, tens of milliseconds); 16-byte salt.
const cost = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const keyLength = 64;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keyLength, cost, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** Password hashing with a per-user random salt and constant-time comparison. */
@Injectable()
export class PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }
  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (
      parts.length !== 6 ||
      parts[0] !== 'scrypt' ||
      parts[1] !== String(cost.N) ||
      parts[2] !== String(cost.r) ||
      parts[3] !== String(cost.p)
    )
      return false;
    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (salt.length !== 16 || expected.length !== keyLength) return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  }
}

export class VersionConflictError extends Error {
  constructor() {
    super('Profile version conflict');
  }
}

/** In-memory accounts. A real host uses its database and unique indexes. */
@Injectable()
export class UserRepository {
  readonly #users = new Map<string, User>();
  readonly #byEmail = new Map<string, string>();
  static normalize(email: string): string {
    return email.trim().toLowerCase();
  }
  find(id: string): User | undefined {
    return this.#users.get(id);
  }
  findByEmail(email: string): User | undefined {
    const id = this.#byEmail.get(UserRepository.normalize(email));
    return id === undefined ? undefined : this.#users.get(id);
  }
  /** True when no other account uses the email. */
  async emailAvailable(email: string, exceptId?: string): Promise<boolean> {
    // Simulates an indexed database lookup.
    await Promise.resolve();
    const id = this.#byEmail.get(UserRepository.normalize(email));
    return id === undefined || id === exceptId;
  }
  create(profile: Profile, passwordHash: string): User | undefined {
    const email = UserRepository.normalize(profile.email);
    if (this.#byEmail.has(email)) return undefined;
    if (this.#users.size >= 10_000) throw new Error('Demo account limit');
    const user: User = {
      ...profile,
      email,
      id: randomBytes(12).toString('base64url'),
      passwordHash,
      version: 1,
    };
    this.#users.set(user.id, user);
    this.#byEmail.set(email, user.id);
    return user;
  }
  /** Save a profile only if nobody saved since `expectedVersion`. */
  update(id: string, expectedVersion: number, profile: Profile): User {
    const current = this.#users.get(id);
    if (!current) throw new UnauthorizedException();
    if (current.version !== expectedVersion) throw new VersionConflictError();
    const email = UserRepository.normalize(profile.email);
    const owner = this.#byEmail.get(email);
    if (owner !== undefined && owner !== id) throw new VersionConflictError();
    this.#byEmail.delete(current.email);
    this.#byEmail.set(email, id);
    const next: User = {
      ...current,
      ...profile,
      email,
      version: current.version + 1,
    };
    this.#users.set(id, next);
    return next;
  }
}

/**
 * Failed sign-in throttling: 5 failures per account and 30 per client address
 * in 15 minutes. Process memory only; use a shared store behind a load balancer.
 */
@Injectable()
export class LoginThrottle {
  static readonly window = 15 * 60_000;
  readonly #failures = new Map<string, { count: number; start: number }>();
  #bucket(key: string): { count: number; start: number } | undefined {
    const entry = this.#failures.get(key);
    if (entry && Date.now() - entry.start >= LoginThrottle.window) {
      this.#failures.delete(key);
      return undefined;
    }
    return entry;
  }
  blocked(email: string, address: string): boolean {
    return (
      (this.#bucket(`email:${email}`)?.count ?? 0) >= 5 ||
      (this.#bucket(`ip:${address}`)?.count ?? 0) >= 30
    );
  }
  fail(email: string, address: string): void {
    if (this.#failures.size >= 50_000) this.#failures.clear();
    for (const key of [`email:${email}`, `ip:${address}`]) {
      const entry = this.#bucket(key) ?? { count: 0, start: Date.now() };
      entry.count++;
      this.#failures.set(key, entry);
    }
  }
  succeed(email: string): void {
    this.#failures.delete(`email:${email}`);
  }
}

/** Host-owned sign-in policy. */
@Injectable()
export class AuthService {
  #dummy: Promise<string> | undefined;
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
  ) {}
  async register(
    profile: Profile,
    password: string,
  ): Promise<User | undefined> {
    return this.users.create(profile, await this.hasher.hash(password));
  }
  /**
   * Verify credentials. Unknown accounts still pay for one scrypt derivation so
   * response timing does not reveal which emails exist; callers show one
   * generic message for every failure.
   */
  async authenticate(
    email: string,
    password: string,
    address: string,
  ): Promise<User | 'throttled' | undefined> {
    const normalized = UserRepository.normalize(email);
    if (this.throttle.blocked(normalized, address)) return 'throttled';
    const user = this.users.findByEmail(normalized);
    this.#dummy ??= this.hasher.hash(randomBytes(16).toString('hex'));
    const valid = await this.hasher.verify(
      password,
      user?.passwordHash ?? (await this.#dummy),
    );
    if (!user || !valid) {
      this.throttle.fail(normalized, address);
      return undefined;
    }
    this.throttle.succeed(normalized);
    return user;
  }
}

/** Session fixation protection: issue a new session id, keeping nothing. */
export function regenerateSession(request: SessionRequest): Promise<void> {
  return new Promise((resolve, reject) =>
    request.session.regenerate((error: unknown) =>
      error
        ? reject(error instanceof Error ? error : new Error('Session error'))
        : resolve(),
    ),
  );
}

/** The signed-in user id, read only from the server-side session. */
export function currentUserId(request: unknown): string | undefined {
  const session: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'session')
      : undefined;
  const id: unknown =
    session && typeof session === 'object'
      ? Reflect.get(session, 'userId')
      : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

@Module({
  providers: [UserRepository, PasswordHasher, LoginThrottle, AuthService],
  exports: [UserRepository, AuthService],
})
export class AuthModule {}
