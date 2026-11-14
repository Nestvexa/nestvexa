import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthGuard,
  PassportSerializer,
  PassportStrategy,
} from '@nestjs/passport';
import { verifyCsrf } from '@nestvexa/forms';
import passport from 'passport';
import { ExtractJwt, Strategy as JwtPassportStrategy } from 'passport-jwt';
import { Strategy as LocalPassportStrategy } from 'passport-local';
import { UserStore } from './users.js';
import type { Role, User } from './users.js';

/*
 * Authentication is Passport through @nestjs/passport: passport-local checks
 * credentials, express-session + PassportSerializer keep browser sessions and
 * passport-jwt protects the bearer-token API. This file only wires those
 * libraries to the account store and adds authorization guards.
 */

/** What the session stores: the account id and the auth version it was issued for. */
interface SessionPrincipal {
  readonly id: string;
  readonly version: number;
}
/** JWT claims issued by `POST /api/token`. */
export interface TokenClaims {
  readonly sub: string;
  readonly ver: number;
}
export const JWT_SETTINGS = Symbol('JWT_SETTINGS');
export interface JwtSettings {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface AuthRequest {
  user?: User;
  session: { regenerate(callback: (error: unknown) => void): void } & Record<
    string,
    unknown
  >;
  sessionID: string;
  res?: unknown;
  logIn(user: User, callback: (error: unknown) => void): void;
  logOut(callback: (error: unknown) => void): void;
  isAuthenticated(): boolean;
}

const MESSAGE = 'The email or password is incorrect.';

@Injectable()
export class LocalStrategy extends PassportStrategy(
  LocalPassportStrategy,
  'local',
) {
  constructor(@Inject(UserStore) private readonly users: UserStore) {
    super({ usernameField: 'email', passwordField: 'password' });
  }
  async validate(email: string, password: string): Promise<User> {
    const user = await this.users.verifyCredentials(email, password);
    // One generic message: never reveal whether the email has an account.
    if (!user) throw new UnauthorizedException(MESSAGE);
    return user;
  }
}

@Injectable()
export class JwtStrategy extends PassportStrategy(JwtPassportStrategy, 'jwt') {
  constructor(
    @Inject(UserStore) private readonly users: UserStore,
    @Inject(JWT_SETTINGS) settings: JwtSettings,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: settings.secret,
      algorithms: ['HS256'],
      issuer: settings.issuer,
      audience: settings.audience,
      ignoreExpiration: false,
    });
  }
  /** The signature and expiry are verified by passport-jwt before this runs. */
  async validate(claims: TokenClaims): Promise<User> {
    const user =
      typeof claims.sub === 'string'
        ? await this.users.byId(claims.sub)
        : undefined;
    // A password reset bumps the version and revokes older tokens.
    if (!user || user.authVersion !== claims.ver)
      throw new UnauthorizedException();
    return user;
  }
}

/** Session (de)serialization; a stale auth version signs the session out. */
@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(@Inject(UserStore) private readonly users: UserStore) {
    super();
  }
  serializeUser(
    user: User,
    done: (error: unknown, principal?: SessionPrincipal) => void,
  ): void {
    done(null, { id: user.id, version: user.authVersion });
  }
  deserializeUser(
    principal: SessionPrincipal,
    done: (error: unknown, user?: User | false) => void,
  ): void {
    this.users.byId(principal.id).then(
      (user) =>
        done(
          null,
          user && user.authVersion === principal.version ? user : false,
        ),
      (error: unknown) => done(error),
    );
  }
}

/**
 * Runs the registered passport-local strategy for a browser form (custom
 * callback, no automatic session) and resolves the account or false.
 */
export function authenticateLocal(request: AuthRequest): Promise<User | false> {
  return new Promise((resolve, reject) => {
    const middleware = passport.authenticate(
      'local',
      { session: false },
      (error: unknown, user: User | false | undefined) => {
        if (error instanceof UnauthorizedException) resolve(false);
        else if (error)
          reject(
            error instanceof Error ? error : new Error('Authentication failed'),
          );
        else resolve(user ?? false);
      },
    ) as (
      request: unknown,
      response: unknown,
      next: (error?: unknown) => void,
    ) => void;
    middleware(request, request.res, (error?: unknown) =>
      reject(
        error instanceof Error ? error : new Error('Authentication failed'),
      ),
    );
  });
}

/** `req.logIn`: Passport 0.7 regenerates the session id (fixation protection). */
export function logIn(request: AuthRequest, user: User): Promise<void> {
  return new Promise((resolve, reject) =>
    request.logIn(user, (error: unknown) =>
      error
        ? reject(error instanceof Error ? error : new Error('Login failed'))
        : resolve(),
    ),
  );
}
/** `req.logOut`: clears the login and regenerates the session. */
export function logOut(request: AuthRequest): Promise<void> {
  return new Promise((resolve, reject) =>
    request.logOut((error: unknown) =>
      error
        ? reject(error instanceof Error ? error : new Error('Logout failed'))
        : resolve(),
    ),
  );
}
export function regenerate(request: AuthRequest): Promise<void> {
  return new Promise((resolve, reject) =>
    request.session.regenerate((error: unknown) =>
      error
        ? reject(error instanceof Error ? error : new Error('Session error'))
        : resolve(),
    ),
  );
}

/** The signed-in account of a browser request (from the Passport session). */
export function currentUser(request: object): User | undefined {
  const value = request as Partial<AuthRequest>;
  return value.isAuthenticated?.() ? value.user : undefined;
}

/** CSRF for classic forms (`_csrf` field) through @nestvexa/forms. */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!verifyCsrf(context.switchToHttp().getRequest<object>()))
      throw new ForbiddenException('Invalid or missing CSRF token');
    return true;
  }
}

/** Browser pages: 401 (redirected to /login by the page filter) for guests. */
@Injectable()
export class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!currentUser(context.switchToHttp().getRequest<object>()))
      throw new UnauthorizedException('Sign in required');
    return true;
  }
}

/** Pages that need a confirmed email address. */
@Injectable()
export class VerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = currentUser(context.switchToHttp().getRequest<object>());
    if (!user) throw new UnauthorizedException('Sign in required');
    if (user.verifiedAt === undefined)
      throw new ForbiddenException('Confirm your email address first');
    return true;
  }
}

/** `@Roles('admin')` metadata, read by RolesGuard. */
export const Roles = Reflector.createDecorator<Role[]>();

/** Role check for session and bearer routes; runs after authentication. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<{ user?: User }>().user;
    if (!user) throw new UnauthorizedException();
    if (!roles.includes(user.role))
      throw new ForbiddenException('Your role cannot do this');
    return true;
  }
}

/** Bearer-token API: passport-jwt through the standard Nest AuthGuard. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
/** `POST /api/token`: passport-local without a session (credentials in JSON). */
@Injectable()
export class CredentialsGuard extends AuthGuard('local') {}
