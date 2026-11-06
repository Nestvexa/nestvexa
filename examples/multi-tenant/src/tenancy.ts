import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Session, SessionData } from 'express-session';

/*
 * Host-owned tenancy for the multi-tenant example: seeded tenants, demo
 * accounts, memberships with roles and tenant-scoped projects. Everything lives
 * in process memory. A real host keeps these rows in its database, puts a
 * tenant column on every tenant-owned table and filters every query by it.
 */

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    userId?: string;
    /** The workspace the signed-in user opened last; re-checked on every request. */
    activeTenant?: string;
  }
}
export interface SessionRequest {
  session: Session & Partial<SessionData>;
  sessionID: string;
  ip?: string;
  body?: unknown;
  params?: Record<string, string | undefined>;
}

export type Role = 'member' | 'admin';
export interface Tenant {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
}
export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly memberships: Readonly<Record<string, Role>>;
}
export interface Project {
  readonly id: string;
  readonly tenant: string;
  readonly name: string;
  readonly status: 'active' | 'done';
}
/** The resolved, server-verified access of the current request. */
export interface Access {
  readonly userId: string;
  readonly userName: string;
  readonly tenant: Tenant;
  readonly role: Role;
}

/** Public demonstration password for every seeded account. Never reuse it. */
export const DEMO_PASSWORD = 'demo-password-2026';

const tenants: readonly Tenant[] = [
  {
    slug: 'acme',
    name: 'Acme Robotics',
    tagline: 'Warehouse automation, one robot at a time.',
  },
  {
    slug: 'globex',
    name: 'Globex Logistics',
    tagline: 'Freight that arrives before you miss it.',
  },
];
const accounts: readonly Account[] = [
  {
    id: 'u-ada',
    email: 'ada@acme.test',
    name: 'Ada (Acme admin)',
    memberships: { acme: 'admin' },
  },
  {
    id: 'u-max',
    email: 'max@acme.test',
    name: 'Max (Acme member)',
    memberships: { acme: 'member' },
  },
  {
    id: 'u-gus',
    email: 'gus@globex.test',
    name: 'Gus (Globex admin)',
    memberships: { globex: 'admin' },
  },
  {
    id: 'u-liz',
    email: 'liz@globex.test',
    name: 'Liz (Globex member)',
    memberships: { globex: 'member' },
  },
  {
    id: 'u-sam',
    email: 'sam@consult.test',
    name: 'Sam (member of both)',
    memberships: { acme: 'member', globex: 'member' },
  },
];
const seedProjects: Readonly<Record<string, readonly string[]>> = {
  acme: [
    'Warehouse robot firmware',
    'Assembly line audit',
    'Sensor calibration',
  ],
  globex: [
    'Route optimisation',
    'Fleet telematics rollout',
    'Depot safety review',
  ],
};

// scrypt: N=2^14, r=8, p=1, 16-byte salt, constant-time comparison.
const cost = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 64, cost, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** Accounts, tenants and memberships. */
@Injectable()
export class Directory {
  readonly #hashes = new Map<string, Promise<{ salt: Buffer; key: Buffer }>>();
  readonly #dummy = (async () => {
    const salt = randomBytes(16);
    return { salt, key: await derive(randomBytes(16).toString('hex'), salt) };
  })();
  constructor() {
    // Seeded demo accounts hash the public demo password with their own salt.
    for (const account of accounts) {
      const salt = randomBytes(16);
      this.#hashes.set(
        account.id,
        derive(DEMO_PASSWORD, salt).then((key) => ({ salt, key })),
      );
    }
  }
  tenants(): readonly Tenant[] {
    return tenants;
  }
  tenant(slug: string): Tenant | undefined {
    return tenants.find((tenant) => tenant.slug === slug);
  }
  account(id: string): Account | undefined {
    return accounts.find((account) => account.id === id);
  }
  /**
   * Verify demo credentials. Unknown emails still pay for one derivation so
   * timing does not reveal which accounts exist.
   */
  async authenticate(
    email: string,
    password: string,
  ): Promise<Account | undefined> {
    const account = accounts.find(
      (item) => item.email === email.trim().toLowerCase(),
    );
    const stored = await (account
      ? (this.#hashes.get(account.id) ?? this.#dummy)
      : this.#dummy);
    const actual = await derive(password, stored.salt);
    return timingSafeEqual(actual, stored.key) && account ? account : undefined;
  }
  /** The signed-in account, read only from the server-side session. */
  currentUser(request: object): Account | undefined {
    const session: unknown = Reflect.get(request, 'session');
    const id: unknown =
      session && typeof session === 'object'
        ? Reflect.get(session, 'userId')
        : undefined;
    return typeof id === 'string' ? this.account(id) : undefined;
  }
  /** Role of an account in a tenant, or undefined when it is not a member. */
  role(account: Account, tenant: string): Role | undefined {
    return Object.hasOwn(account.memberships, tenant)
      ? account.memberships[tenant]
      : undefined;
  }
  /**
   * Access for a tenant named by a trusted route parameter. Throws 401 for
   * guests and 403 for accounts without a membership in that tenant.
   */
  accessTo(request: object, slug: string): Access {
    const account = this.currentUser(request);
    if (!account) throw new UnauthorizedException('Sign in required');
    const tenant = this.tenant(slug);
    const role = tenant ? this.role(account, tenant.slug) : undefined;
    if (!tenant || !role)
      throw new ForbiddenException('You are not a member of this workspace');
    return { userId: account.id, userName: account.name, tenant, role };
  }
  /**
   * Access for Live requests: the active tenant recorded in the session by the
   * page route, re-verified against current memberships. Never client state.
   */
  activeAccess(request: object): Access | undefined {
    const session: unknown = Reflect.get(request, 'session');
    const slug: unknown =
      session && typeof session === 'object'
        ? Reflect.get(session, 'activeTenant')
        : undefined;
    if (typeof slug !== 'string') return undefined;
    try {
      return this.accessTo(request, slug);
    } catch {
      return undefined;
    }
  }
}

/** Tenant-scoped projects: every method takes the tenant and filters by it. */
@Injectable()
export class ProjectRepository {
  readonly #projects: Project[] = Object.entries(seedProjects).flatMap(
    ([tenant, names]) =>
      names.map((name, index) => ({
        id: `${tenant}-${index + 1}`,
        tenant,
        name,
        status: index === 2 ? ('done' as const) : ('active' as const),
      })),
  );
  #next = 100;
  list(tenant: string): readonly Project[] {
    return this.#projects.filter((project) => project.tenant === tenant);
  }
  find(tenant: string, id: string): Project | undefined {
    return this.#projects.find(
      (project) => project.tenant === tenant && project.id === id,
    );
  }
  nameTaken(tenant: string, name: string, exceptId = ''): boolean {
    return this.list(tenant).some(
      (project) =>
        project.id !== exceptId &&
        project.name.toLowerCase() === name.toLowerCase(),
    );
  }
  add(tenant: string, name: string): Project {
    if (this.list(tenant).length >= 50)
      throw new BadRequestException('Project limit reached');
    const project: Project = {
      id: `${tenant}-${this.#next++}`,
      tenant,
      name,
      status: 'active',
    };
    this.#projects.push(project);
    return project;
  }
  update(
    tenant: string,
    id: string,
    change: Partial<Pick<Project, 'name' | 'status'>>,
  ): Project {
    const index = this.#projects.findIndex(
      (project) => project.tenant === tenant && project.id === id,
    );
    const current = this.#projects[index];
    if (!current) throw new BadRequestException('Unknown project');
    const next = { ...current, ...change };
    this.#projects[index] = next;
    return next;
  }
  remove(tenant: string, id: string): boolean {
    const index = this.#projects.findIndex(
      (project) => project.tenant === tenant && project.id === id,
    );
    if (index < 0) return false;
    this.#projects.splice(index, 1);
    return true;
  }
}

/** Project names: 2–60 characters after trimming, unique per tenant. */
export function projectNameError(
  projects: ProjectRepository,
  tenant: string,
  name: string,
  exceptId = '',
): string | undefined {
  if (name.length < 2 || name.length > 60)
    return 'Use a project name of 2 to 60 characters.';
  if (projects.nameTaken(tenant, name, exceptId))
    return 'This workspace already has a project with that name.';
  return undefined;
}

/**
 * Native Nest guard for tenant routes (`:tenant` parameter): 401 for guests,
 * 403 for accounts that are not members. Runs before the handler, so a
 * forbidden request never reads tenant data.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(Directory) private readonly directory: Directory) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const slug = request.params?.['tenant'];
    if (typeof slug !== 'string') throw new ForbiddenException();
    this.directory.accessTo(request, slug);
    return true;
  }
}

@Module({
  providers: [Directory, ProjectRepository, TenantGuard],
  exports: [Directory, ProjectRepository, TenantGuard],
})
export class TenancyModule {}
