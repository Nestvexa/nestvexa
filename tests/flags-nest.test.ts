import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FlagGuard,
  FlagRequestContext,
  FlagsModule,
  RequireFlag,
  StaticFlagProvider,
} from '../packages/flags/dist/index.js';

interface HostRequest {
  readonly headers: Record<string, string | undefined>;
}

async function start(denyStatus?: 403 | 404): Promise<{
  app: INestApplication;
  base: string;
  evaluations: () => number;
}> {
  let evaluations = 0;
  @Controller()
  @UseGuards(FlagGuard)
  class Pages {
    constructor(
      @Inject(FlagRequestContext) private readonly flags: FlagRequestContext,
    ) {}
    @Get('open') open() {
      return { ok: true };
    }
    @Get('export')
    @RequireFlag('bulk-export')
    exportCsv() {
      return { exported: true };
    }
    @Get('assistant')
    @RequireFlag('ai-assistant')
    async assistant(@Req() request: HostRequest) {
      // Memoized: the guard and the handler share one evaluation per request.
      const first = await this.flags.forRequest(request);
      const second = await this.flags.forRequest(request);
      return { same: first === second, flags: { ...first } };
    }
  }
  @Module({
    imports: [
      FlagsModule.forRoot({
        flags: ['ai-assistant', 'bulk-export'],
        provider: new StaticFlagProvider({
          'ai-assistant': true,
          'bulk-export': { allow: ['admin'] },
        }),
        ...(denyStatus ? { denyStatus } : {}),
        // Trusted server identity only; query strings never reach the context.
        context: (request) => {
          evaluations += 1;
          const headers: unknown = Reflect.get(request, 'headers');
          const user: unknown =
            headers && typeof headers === 'object'
              ? Reflect.get(headers, 'x-user')
              : undefined;
          return typeof user === 'string' ? { identity: user } : {};
        },
      }),
    ],
    controllers: [Pages],
  })
  class AppModule {}
  const compiled = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = compiled.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl(), evaluations: () => evaluations };
}

describe('FlagGuard in a real Nest application', () => {
  let hidden: Awaited<ReturnType<typeof start>>;
  let forbidden: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    hidden = await start();
    forbidden = await start(403);
  });
  afterAll(async () => {
    await hidden?.app.close();
    await forbidden?.app.close();
  });
  const get = (base: string, path: string, user?: string) =>
    fetch(base + path, {
      headers: { connection: 'close', ...(user ? { 'x-user': user } : {}) },
    });

  it('leaves undecorated routes untouched', async () => {
    expect((await get(hidden.base, '/open')).status).toBe(200);
  });
  it('hides disabled features with 404 by default and 403 when configured', async () => {
    expect((await get(hidden.base, '/export')).status).toBe(404);
    expect((await get(forbidden.base, '/export')).status).toBe(403);
    expect((await get(hidden.base, '/export', 'admin')).status).toBe(200);
  });
  it('ignores client attempts to override flags', async () => {
    for (const path of [
      '/export?flags=bulk-export',
      '/export?bulk-export=true',
      '/export?flags[bulk-export]=true',
    ])
      expect((await get(hidden.base, path)).status).toBe(404);
  });
  it('memoizes evaluation per request object', async () => {
    const before = hidden.evaluations();
    const response = await get(hidden.base, '/assistant', 'alice');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      same: true,
      flags: { 'ai-assistant': true, 'bulk-export': false },
    });
    expect(hidden.evaluations() - before).toBe(1);
  });
  it('rejects invalid decorator flags and module options at definition time', () => {
    expect(() => RequireFlag('Not A Flag')).toThrow();
    expect(() =>
      FlagsModule.forRoot({
        flags: ['a'],
        provider: new StaticFlagProvider({}),
        context: undefined as unknown as () => object,
      }),
    ).toThrow();
  });
});
