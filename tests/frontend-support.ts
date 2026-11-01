import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InertiaModule, InertiaPage } from '../packages/inertia/dist/index.js';
import type { InertiaSsrRenderer } from '../packages/inertia/dist/index.js';

// Helpers for the framework adapter suites. They exercise the real Vite SSR
// bundles produced by `pnpm build` in examples/inertia-{react,vue,svelte}.

const execFileAsync = promisify(execFile);

export interface SsrBundle {
  render(page: object): Promise<{ head: string[]; body: string }>;
}

export type Example = 'inertia-react' | 'inertia-vue' | 'inertia-svelte';

export function exampleFile(example: Example, path: string): string {
  return fileURLToPath(
    new URL(`../examples/${example}/${path}`, import.meta.url),
  );
}

export async function loadSsrBundle(example: Example): Promise<SsrBundle> {
  const url = pathToFileURL(exampleFile(example, 'dist/ssr/ssr.js')).href;
  return (await import(url)) as SsrBundle;
}

/**
 * Renders `component` with the built SSR bundle in a child process running
 * with `NODE_ENV=production` (framework runtimes pick their production builds
 * there). Resolves `ok:<body length>` or `error:<message>`.
 */
export async function renderInProduction(
  example: Example,
  component: string,
): Promise<string> {
  const url = pathToFileURL(exampleFile(example, 'dist/ssr/ssr.js')).href;
  const page = JSON.stringify(pageObject(component));
  const script = [
    `const { render } = await import(${JSON.stringify(url)});`,
    `try { const out = await render(${page}); console.log('ok:' + out.body.length); }`,
    "catch (error) { console.log('error:' + (error instanceof Error ? error.message : String(error))); }",
  ].join('\n');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 60000,
    },
  );
  return stdout.trim().split(/\r?\n/).pop() ?? '';
}

export function pageObject(
  component: string,
  props: Record<string, unknown> = {},
): {
  component: string;
  props: Record<string, unknown>;
  url: string;
  version: string;
} {
  return {
    component,
    props: {
      errors: {},
      appName: 'Nestvexa Inertia',
      framework: 'Test',
      greeting: 'Hello',
      visits: 1,
      renderedBy: 'test',
      reason: 'boom',
      ...props,
    },
    url: '/',
    version: '1',
  };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Starts a Nest app rendering `Home`/`Broken` pages through `renderer`. */
export async function startInertiaHost(
  renderer: InertiaSsrRenderer,
  mode: 'fallback' | 'strict',
  apps: INestApplication[],
): Promise<string> {
  @Controller()
  class PagesController {
    @Get()
    @InertiaPage('Home')
    home() {
      return {
        appName: 'Nestvexa Inertia',
        framework: 'Test',
        greeting: 'Hello from Nest',
        visits: 1,
        renderedBy: 'test',
      };
    }

    @Get('broken')
    @InertiaPage('Broken')
    broken() {
      return { reason: 'deliberate failure' };
    }
  }
  @Module({
    imports: [InertiaModule.forRoot({ version: '1', ssr: { renderer, mode } })],
    controllers: [PagesController],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
