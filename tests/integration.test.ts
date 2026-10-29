import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Render,
  Scope,
  UseGuards,
  ForbiddenException,
  Query,
  ParseIntPipe,
  UseInterceptors,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
  CallHandler,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  NestvexaModule,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { map } from 'rxjs';

/** Real TCP requests without fetch's browser-only reserved-port restriction. */
function get(
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else request.destroy(new Error('Unexpected HTTP response chunk'));
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (Array.isArray(value))
            for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.append(name, value);
        resolve(
          new Response(Buffer.concat(chunks).toString('utf8'), {
            status: response.statusCode ?? 500,
            headers,
          }),
        );
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error('MVC fixture HTTP timeout')),
    );
    request.end();
  });
}

@Injectable({ scope: Scope.REQUEST })
class RequestIdentity {
  readonly id = randomUUID();
}

@Injectable()
class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string> }>();
    if (request.headers['x-test-auth'] !== 'allowed')
      throw new ForbiddenException();
    return true;
  }
}

@Injectable()
class ViewInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<Readonly<Record<string, unknown>>>,
  ) {
    return next
      .handle()
      .pipe(map((model) => ({ ...model, intercepted: 'yes' })));
  }
}

@Controller()
class TestController {
  constructor(
    @Inject(RequestIdentity) private readonly request: RequestIdentity,
  ) {}
  @Get()
  @Render('home')
  @UseInterceptors(ViewInterceptor)
  home() {
    return { name: '<script>bad()</script>', requestId: this.request.id };
  }
  @Get('health')
  health() {
    return { ok: true, id: this.request.id };
  }
  @Get('protected')
  @UseGuards(SessionGuard)
  protected() {
    return { ok: true };
  }
  @Get('number')
  number(@Query('value', ParseIntPipe) value: number) {
    return { value };
  }
}

const apps: INestApplication[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.each(['express', 'fastify'] as const)('Nest MVC on %s', (platform) => {
  it('renders escaped layouts while preserving native guards, pipes, interceptors, prefixes and request scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-mvc-'));
    roots.push(root);
    await mkdir(join(root, 'layouts'));
    await writeFile(
      join(root, 'home.hbs'),
      '<h1>{{name}}</h1><span>{{requestId}}</span><b>{{intercepted}}</b>',
    );
    await writeFile(
      join(root, 'layouts/main.hbs'),
      '<!doctype html><html><body>{{{body}}}</body></html>',
    );
    @Module({
      imports: [
        NestvexaModule.forRootAsync({
          useFactory: async () => ({ views: { root, layout: 'layouts/main' } }),
        }),
      ],
      controllers: [TestController],
      providers: [RequestIdentity, SessionGuard, ViewInterceptor],
    })
    class HostModule {}
    const module = await Test.createTestingModule({
      imports: [HostModule],
    }).compile();
    const app =
      platform === 'fastify'
        ? module.createNestApplication(new FastifyAdapter(), { logger: false })
        : module.createNestApplication({ logger: false });
    apps.push(app);
    app.setGlobalPrefix('host');
    await configureNestvexa(app);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const response = await get(`${base}/host`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<b>yes</b>');
    const first = (await get(`${base}/host/health`).then((r) => r.json())) as {
      ok: boolean;
      id: string;
    };
    const second = (await get(`${base}/host/health`).then((r) => r.json())) as {
      ok: boolean;
      id: string;
    };
    expect(first.ok).toBe(true);
    expect(first.id).not.toBe(second.id);
    expect((await get(`${base}/host/protected`)).status).toBe(403);
    expect(
      (
        await get(`${base}/host/protected`, {
          headers: { 'x-test-auth': 'allowed' },
        })
      ).status,
    ).toBe(200);
    expect((await get(`${base}/host/number?value=bad`)).status).toBe(400);
    expect(
      await get(`${base}/host/number?value=42`).then((r) => r.json()),
    ).toEqual({ value: 42 });
    expect((await get(`${base}/health`)).status).toBe(404);
  });
});
