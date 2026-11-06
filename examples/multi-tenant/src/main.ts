import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import type { LiveIdentity } from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import { TenantBoard, TenantProject } from './board.js';
import { origin, port } from './config.js';
import { Api, Pages } from './pages.js';
import { Directory, TenancyModule } from './tenancy.js';
import type { SessionRequest } from './tenancy.js';

const root = fileURLToPath(new URL('../views', import.meta.url));

/**
 * The Live identity binds every snapshot to the account, the active tenant,
 * the role in that tenant and the session id. A snapshot rendered for one of
 * them is unavailable to any other (410 INVALID_SNAPSHOT), so state cannot be
 * replayed across accounts, tenants, role changes or sign-in/out.
 */
function liveIdentity(directory: Directory, request: object): LiveIdentity {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID)
    throw new UnauthorizedException();
  const access = directory.activeAccess(request);
  const subject = access
    ? `user:${access.userId}:tenant:${access.tenant.slug}:role:${access.role}`
    : 'guest';
  return {
    binding: `${subject}:session:${value.sessionID}`,
    csrfToken: value.session.csrf,
  };
}
const memberActions: Readonly<Record<string, readonly string[]>> = {
  'tenant-board': ['$mount', '$sync', 'create', 'changed'],
  'tenant-project': [
    '$mount',
    '$sync',
    'startEdit',
    'cancelEdit',
    'saveEdit',
    'toggleStatus',
  ],
};
/** Role policy per component action; guests may do nothing. */
function authorizeLive(
  identity: LiveIdentity,
  component: string,
  action: string,
): boolean {
  const role = /:role:(member|admin):session:/.exec(identity.binding)?.[1];
  if (!role) return false;
  if (component === 'tenant-project' && action === 'remove')
    return role === 'admin';
  return memberActions[component]?.includes(action) ?? false;
}

@Controller()
class Assets {
  @Get('app.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return [
      'body{font-family:system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:1rem;line-height:1.5;color:#1b1b1b;background:#fff}',
      'header nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}',
      'header form,header form button{margin:0}',
      'label{display:block;font-weight:600;margin-top:.75rem}',
      'input{padding:.4rem;border:2px solid #555;border-radius:4px;font:inherit}',
      'button{padding:.4rem .8rem;font:inherit;margin:.25rem .25rem .25rem 0}',
      '[aria-invalid="true"]{border-color:#b00020}',
      '.error{color:#b00020}',
      '.flash{border-left:4px solid #26a269;padding:.25rem .75rem}',
      '.project{border:1px solid #ccc;border-radius:6px;padding:.5rem .75rem;margin:.5rem 0}',
      ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}',
    ].join('');
  }
}

@Module({
  imports: [
    TenancyModule,
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [TenantBoard, TenantProject],
        imports: [TenancyModule],
        inject: [Directory],
        useFactory: (directory: Directory) => ({
          origin,
          maxRequestsPerMinute: 240,
          resolveIdentity: (request: object) =>
            liveIdentity(directory, request),
          authorize: authorizeLive,
        }),
      },
    ),
  ],
  controllers: [Pages, Api, Assets],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Flat urlencoded keys: @nestvexa/forms parses brackets itself.
app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
// Local demonstration: production hosts supply a persistent session store, a
// deployment secret, HTTPS-only cookies and trusted proxy configuration.
app.use(
  session({
    name: 'nvtenant.sid',
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 30 * 60_000,
    },
  }),
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Multi-tenant example: ${await app.getUrl()}`);
