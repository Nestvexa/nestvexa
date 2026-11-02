import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ViteConfigurationError,
  viteStaticMiddleware,
} from '../packages/vite/dist/index.js';

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

// Raw requests so the client never normalizes `..` or encoded separators.
function raw(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let root: string;
let outside: string;
let server: Server;
let port: number;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'nestvexa-vite-static-'));
  root = join(base, 'client');
  outside = join(base, 'secret.txt');
  await mkdir(join(root, 'assets', 'nested'), { recursive: true });
  await mkdir(join(root, '.vite'), { recursive: true });
  await writeFile(join(root, 'assets', 'app-B9xk2Q_a.js'), 'console.log(1);');
  await writeFile(join(root, 'assets', 'app-B9xk2Q_a.js.map'), '{"version":3}');
  await writeFile(join(root, 'assets', 'app-D4e5f6g7.css'), 'body{}');
  await writeFile(
    join(root, 'assets', 'nested', 'logo-AbCdEfGh.svg'),
    '<svg/>',
  );
  await writeFile(join(root, 'robots.txt'), 'User-agent: *');
  await writeFile(join(root, 'file with space.txt'), 'spaced');
  await writeFile(join(root, '.vite', 'manifest.json'), '{}');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(outside, 'TOP SECRET');
  try {
    await symlink(outside, join(root, 'assets', 'link.txt'));
  } catch {
    // Symlink creation needs privileges on some Windows hosts; the index skips links regardless.
  }
  const middleware = viteStaticMiddleware({ root, prefix: '/build/' });
  server = createServer((request, response) =>
    middleware(request, response, (error) => {
      response.statusCode = error ? 500 : 404;
      response.end('fallthrough');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  };
});

describe('viteStaticMiddleware', () => {
  it('serves hashed assets as immutable with type, length, nosniff and ETag', async () => {
    const response = await raw(port, '/build/assets/app-B9xk2Q_a.js');
    expect(response.status).toBe(200);
    expect(response.body).toBe('console.log(1);');
    expect(response.headers['content-type']).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-length']).toBe('15');
    expect(response.headers['etag']).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    const nested = await raw(port, '/build/assets/nested/logo-AbCdEfGh.svg');
    expect(nested.headers['content-type']).toBe('image/svg+xml');
  });

  it('serves unhashed files with no-cache and decodes percent-encoded names', async () => {
    const robots = await raw(port, '/build/robots.txt?v=1');
    expect(robots.status).toBe(200);
    expect(robots.headers['cache-control']).toBe('no-cache');
    const spaced = await raw(port, '/build/file%20with%20space.txt');
    expect(spaced.body).toBe('spaced');
  });

  it('answers conditional requests with 304 and HEAD without a body', async () => {
    const first = await raw(port, '/build/assets/app-D4e5f6g7.css');
    const etag = String(first.headers['etag']);
    const cached = await raw(port, '/build/assets/app-D4e5f6g7.css', 'GET', {
      'If-None-Match': `"other", ${etag}`,
    });
    expect(cached.status).toBe(304);
    expect(cached.body).toBe('');
    const head = await raw(port, '/build/assets/app-D4e5f6g7.css', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('6');
    expect(head.body).toBe('');
  });

  it.each([
    '/build/../secret.txt',
    '/build/assets/../../secret.txt',
    '/build/%2e%2e/secret.txt',
    '/build/..%2fsecret.txt',
    '/build/..%5csecret.txt',
    '/build/assets%5c..%5c..%5csecret.txt',
    '/build/%2fetc%2fpasswd',
    '/build//etc/passwd',
    '/build/C:%5cWindows%5cwin.ini',
    '/build/assets/app-B9xk2Q_a.js%00.txt',
    '/build/.vite/manifest.json',
    '/build/.env',
    '/build/assets/link.txt',
    '/build/assets/app-B9xk2Q_a.js.map',
    '/build/assets/',
    '/build/',
    '/buildassets/app-B9xk2Q_a.js',
    '/other/assets/app-B9xk2Q_a.js',
  ])('never serves %s from outside the index', async (path) => {
    const response = await raw(port, path);
    expect(response.status).toBe(404);
    expect(response.body).toBe('fallthrough');
    expect(response.body).not.toContain('SECRET');
  });

  it('rejects malformed percent-encoding with 400', async () => {
    expect((await raw(port, '/build/%E0%A4%A')).status).toBe(400);
  });

  it('passes non-GET/HEAD methods through untouched', async () => {
    const response = await raw(port, '/build/assets/app-B9xk2Q_a.js', 'POST');
    expect(response.status).toBe(404);
    expect(response.body).toBe('fallthrough');
  });

  it('serves source maps only when explicitly enabled', async () => {
    const middleware = viteStaticMiddleware({
      root,
      prefix: '/m/',
      sourceMaps: true,
    });
    const maps = createServer((request, response) =>
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
    );
    await new Promise<void>((resolve) => maps.listen(0, '127.0.0.1', resolve));
    const mapPort = (maps.address() as AddressInfo).port;
    const response = await raw(mapPort, '/m/assets/app-B9xk2Q_a.js.map');
    await new Promise<void>((resolve) => maps.close(() => resolve()));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('validates its configuration at startup', () => {
    expect(() => viteStaticMiddleware({ root: 'relative/dir' })).toThrow(
      ViteConfigurationError,
    );
    expect(() => viteStaticMiddleware({ root: join(root, 'missing') })).toThrow(
      /does not exist; run `vite build` first/,
    );
    expect(() =>
      viteStaticMiddleware({ root: join(root, 'robots.txt') }),
    ).toThrow(/not a directory/);
    for (const prefix of ['build/', '/build', '//cdn/', '/a b/', '/%2e/'])
      expect(() => viteStaticMiddleware({ root, prefix })).toThrow(
        ViteConfigurationError,
      );
    expect(() => viteStaticMiddleware({ root, maxFiles: 2 })).toThrow(
      /more than 2 files/,
    );
  });
});

describe('viteStaticMiddleware in a Nest Express host', () => {
  let app: NestExpressApplication;
  let nestPort: number;

  @Controller()
  class PagesController {
    @Get('build/fallback')
    fallback() {
      return { route: 'nest' };
    }
  }

  @Module({ controllers: [PagesController] })
  class AppModule {}

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
    });
    app.use(viteStaticMiddleware({ root, prefix: '/build/' }));
    await app.listen(0, '127.0.0.1');
    nestPort = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves build files before routes and falls through to Nest otherwise', async () => {
    const asset = await raw(nestPort, '/build/assets/app-B9xk2Q_a.js');
    expect(asset.status).toBe(200);
    const route = await raw(nestPort, '/build/fallback');
    expect(JSON.parse(route.body)).toEqual({ route: 'nest' });
    const traversal = await raw(nestPort, '/build/..%2f..%2fsecret.txt');
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain('SECRET');
  });
});
