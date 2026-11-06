import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Render,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IsInt, Min } from 'class-validator';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import {
  csrf,
  envelope,
  marker,
  origin,
  platforms,
  send,
} from './support/live-fixture.js';

/*
 * The master specification's public API samples (sections 4.1, 4.3, 4.4),
 * compiled verbatim apart from fixture identity/authorization policies, and
 * exercised over HTTP on both platforms.
 */

// 4.3 Live component sample.
@LiveComponent({ name: 'counter', view: 'components/counter' })
export class CounterComponent {
  @State() count = 0;
  @Computed() get doubled(): number {
    return this.count * 2;
  }
  @Action() increment(): void {
    this.count += 1;
  }
  @Action() decrement(): void {
    this.count -= 1;
  }
}
const counterTemplate = `<section aria-label="Counter">
  <output>{{count}}</output>
  <p>Double: {{doubled}}</p>
  <button type="button" nv:click="decrement">-</button>
  <button type="button" nv:click="increment">+</button>
</section>`;

// 4.4 Live with NestJS DI and guards.
const removed: number[] = [];
@Injectable()
class UsersService {
  async remove(id: number): Promise<void> {
    await Promise.resolve();
    removed.push(id);
  }
}
@Injectable()
class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    return headers['x-session'] === 'signed-in';
  }
}
@Injectable()
class UsersAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    return headers['x-role'] === 'admin';
  }
}
class RemoveUserDto {
  @IsInt() @Min(1) id!: number;
}
@Module({
  providers: [UsersService, SessionAuthGuard, UsersAdminGuard],
  exports: [UsersService, SessionAuthGuard, UsersAdminGuard],
})
class UsersModule {}

@LiveComponent({ name: 'users-table', view: 'components/users-table' })
export class UsersTable {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @State() query = '';
  @Action()
  @UseGuards(SessionAuthGuard, UsersAdminGuard)
  async remove(
    @ActionInput(new ValidationPipe({ expectedType: RemoveUserDto }))
    input: RemoveUserDto,
  ): Promise<void> {
    await this.users.remove(input.id);
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Render('home')
  async home(@Req() req: object) {
    return {
      counter: await this.live.mount(CounterComponent, req),
      users: await this.live.mount(UsersTable, req),
    };
  }
}

const roots: string[] = [];
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !root.includes('nestvexa-canonical-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(root, { recursive: true, force: true });
  }
  removed.length = 0;
});

async function boot(platform: (typeof platforms)[number]) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-canonical-'));
  roots.push(root);
  await writeFile(join(root, 'home.hbs'), '<main>{{counter}}{{users}}</main>');
  const components = join(root, 'components');
  await mkdir(components, { recursive: true });
  await writeFile(join(components, 'counter.hbs'), counterTemplate);
  await writeFile(
    join(components, 'users-table.hbs'),
    '<input aria-label="Search" value="{{query}}">',
  );
  const module = await Test.createTestingModule({
    imports: [
      // 4.1 Setup and module integration (views.root points at the fixture).
      NestvexaModule.forRoot(
        {
          views: { engine: 'hbs', root },
          live: { enabled: true, client: 'alpine' },
          security: { csrf: true, requireAuthorizedActions: true },
        },
        {
          components: [CounterComponent, UsersTable],
          imports: [UsersModule],
          useFactory: () => ({
            origin,
            // Fixture identity; applications resolve this from their session.
            resolveIdentity: () => ({
              binding: 'canonical/session/user',
              csrfToken: csrf,
            }),
            authorize: () => true,
          }),
        },
      ),
    ],
    controllers: [Pages],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  apps.push(app);
  await configureNestvexa(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

describe.each(platforms)('canonical public API samples on %s', (platform) => {
  it('renders the counter sample and runs its actions with computed values', async () => {
    const app = await boot(platform);
    const page = await send(app, '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<output>0</output>');
    expect(page.body).toContain('<p>Double: 0</p>');
    expect(page.body).toContain('nv:click="increment"');
    const reference = marker(page.body, 'counter');
    const first = await send(
      app,
      '/_nestvexa/live/counter/increment',
      envelope(reference),
    );
    expect(first.status).toBe(201);
    expect(first.json()['html']).toContain('<p>Double: 2</p>');
    const second = await send(
      app,
      '/_nestvexa/live/counter/decrement',
      envelope({ ...reference, revision: 1 }),
    );
    expect(second.json()).toMatchObject({ state: { count: 0 } });
  });

  it('executes the users-table guards and DTO validation before the injected service', async () => {
    const app = await boot(platform);
    const page = await send(app, '/');
    const reference = marker(page.body, 'users-table');
    const path = '/_nestvexa/live/users-table/remove';
    const anonymous = await send(
      app,
      path,
      envelope(reference, { input: { id: 7 } }),
    );
    expect(anonymous.status).toBe(403);
    const member = await send(
      app,
      path,
      envelope(reference, { input: { id: 7 } }),
      { 'x-session': 'signed-in', 'x-role': 'member' },
    );
    expect(member.status).toBe(403);
    const invalid = await send(
      app,
      path,
      envelope(reference, { input: { id: 'seven' } }),
      { 'x-session': 'signed-in', 'x-role': 'admin' },
    );
    expect(invalid.status).toBe(400);
    expect(removed).toEqual([]);
    const accepted = await send(
      app,
      path,
      envelope(reference, { input: { id: 7 } }),
      { 'x-session': 'signed-in', 'x-role': 'admin' },
    );
    expect(accepted.status).toBe(201);
    expect(removed).toEqual([7]);
  });
});
