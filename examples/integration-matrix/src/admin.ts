import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  defer,
  optional,
  redirect,
} from '@nestvexa/inertia';
import { randomBytes } from 'node:crypto';
import type { SessionRequest } from './identity.js';
import { sameToken } from './identity.js';
import type { AdminUser } from './page-types.js';

export const frameworks = {
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
} as const;
export type Framework = keyof typeof frameworks;

function framework(value: string): Framework {
  if (!Object.hasOwn(frameworks, value)) throw new NotFoundException();
  return value as Framework;
}

/**
 * Host-owned CSRF protection for the official Inertia clients: a per-session
 * token mirrored into the readable `XSRF-TOKEN` cookie, which `@inertiajs/core`
 * echoes in `X-XSRF-TOKEN`. Applied to the admin controller only; Live and
 * actions use their own CSRF headers.
 */
@Injectable()
class XsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<SessionRequest>();
    const response = http.getResponse<{
      cookie(name: string, value: string, options: object): void;
    }>();
    request.session.xsrf ??= randomBytes(32).toString('base64url');
    const token = request.session.xsrf;
    if (['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      response.cookie('XSRF-TOKEN', token, {
        sameSite: 'strict',
        path: '/admin',
      });
      return true;
    }
    const sent = request.headers?.['x-xsrf-token'];
    if (
      !sameToken(
        typeof sent === 'string' ? decodeURIComponent(sent) : '',
        token,
      )
    )
      throw new ForbiddenException('CSRF token mismatch');
    return true;
  }
}

/** Demonstration users per root, bounded and in process memory. */
const users: Record<Framework, AdminUser[]> = {
  react: [],
  vue: [],
  svelte: [],
};
for (const key of Object.keys(users) as Framework[])
  users[key].push(
    { id: 1, name: 'Ada Lovelace', email: 'ada@example.test' },
    { id: 2, name: 'Grace Hopper', email: 'grace@example.test' },
  );

function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, name)
      : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

/** Server validation; errors travel back through the session to the form. */
function validateUser(body: unknown): { name: string; email: string } {
  const name = field(body, 'name');
  const email = field(body, 'email');
  const errors: Record<string, string> = {};
  if (!name) errors['name'] = 'The name field is required.';
  else if (name.length > 40)
    errors['name'] = 'The name may not be greater than 40 characters.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 80)
    errors['email'] = 'The email must be a valid email address.';
  if (Object.keys(errors).length) throw new InertiaValidationException(errors);
  return { name, email };
}

@Controller('admin/:framework')
@UseGuards(XsrfGuard)
export class AdminController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get()
  @InertiaPage('Dashboard')
  dashboard(@Param('framework') value: string) {
    const key = framework(value);
    return {
      heading: `${frameworks[key]} admin dashboard`,
      framework: frameworks[key],
      root: `/admin/${key}`,
      stats: defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          users: users[key].length,
          computedAt: new Date().toISOString(),
        };
      }),
      extra: optional(
        () => `Partial reload served at ${new Date().toISOString()}`,
      ),
    };
  }

  @Get('users')
  @InertiaPage('Users')
  list(@Param('framework') value: string) {
    const key = framework(value);
    return {
      root: `/admin/${key}`,
      users: () => users[key].map((user) => ({ ...user })),
    };
  }

  @Get('users/create')
  @InertiaPage('CreateUser')
  create(@Param('framework') value: string) {
    return { root: `/admin/${framework(value)}` };
  }

  @Post('users')
  store(
    @Param('framework') value: string,
    @Req() request: SessionRequest,
    @Body() body: unknown,
  ) {
    const key = framework(value);
    const { name, email } = validateUser(body);
    const list = users[key];
    list.push({ id: (list.at(-1)?.id ?? 0) + 1, name, email });
    // Keep the demonstration store bounded (two seeded users stay).
    if (list.length > 40) list.splice(2, list.length - 40);
    this.inertia.flash(request, 'success', `User ${name} created`);
    return redirect(`/admin/${key}/users`);
  }
}
