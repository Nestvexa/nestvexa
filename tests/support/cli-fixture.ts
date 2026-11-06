import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect } from 'vitest';
import { run } from '../../packages/cli/dist/index.js';

/**
 * Fixture apps for the CLI end-to-end suites: strict Nest projects (ESM or
 * CommonJS, Express or Fastify) whose node_modules junction the workspace
 * packages and the frontend toolchain of examples/inertia-mixed, so generated
 * code resolves like an install. Nest, Fastify and session plugins resolve from
 * the repository root.
 */
export const repo = resolve(import.meta.dirname, '..', '..');
const frontend = join(repo, 'examples', 'inertia-mixed', 'node_modules');
export const frontendPackages = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  'vite',
  'vue-tsc',
  'svelte-check',
  '@inertiajs/core',
  '@inertiajs/react',
  '@inertiajs/vue3',
  '@inertiajs/svelte',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
  '@sveltejs/vite-plugin-svelte',
] as const;

function link(root: string, name: string, target: string): void {
  const path = join(root, 'node_modules', name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(realpathSync(target), path, 'junction');
}
/** Junction every workspace package and the frontend toolchain into `root`. */
export function linkWorkspace(root: string): void {
  link(root, 'nestvexa', join(repo, 'packages', 'nestvexa'));
  for (const directory of readdirSync(join(repo, 'packages'))) {
    const manifest = join(repo, 'packages', directory, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name: pkg } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
    };
    if (pkg.startsWith('@nestvexa/'))
      link(root, pkg, join(repo, 'packages', directory));
  }
  for (const pkg of frontendPackages) link(root, pkg, join(frontend, pkg));
}

export interface FreshAppOptions {
  readonly type?: 'module' | 'commonjs';
  readonly platform?: 'express' | 'fastify';
  /** Parent directory under `artifacts/`. */
  readonly directory?: string;
}
/** A strict Nest app whose node_modules resolve the workspace packages like an install. */
export function freshApp(name: string, options: FreshAppOptions = {}): string {
  const type = options.type ?? 'module';
  const platform = options.platform ?? 'express';
  const root = join(
    repo,
    'artifacts',
    options.directory ?? 'cli-generators',
    name,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  linkWorkspace(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        type,
        scripts: { build: 'tsc -p tsconfig.json' },
        dependencies: {
          '@nestjs/common': '12.2.0',
          '@nestjs/core': '12.2.0',
          [`@nestjs/platform-${platform}`]: '12.2.0',
          'reflect-metadata': '0.2.2',
          rxjs: '7.8.2',
        },
        devDependencies: { typescript: '6.0.3' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2023',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          rootDir: '.',
          outDir: 'dist',
          types: ['node'],
        },
      },
      null,
      2,
    ) + '\n',
  );
  const ext = type === 'module' ? '.js' : '';
  writeFileSync(
    join(root, 'src', 'main.ts'),
    platform === 'fastify'
      ? `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module${ext}';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['error'],
  });
  await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1');
}
void bootstrap();
`
      : `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module${ext}';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1');
}
void bootstrap();
`,
  );
  writeFileSync(
    join(root, 'src', 'app.module.ts'),
    `import { Module } from '@nestjs/common';
import { AppController } from './app.controller${ext}';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
`,
  );
  writeFileSync(
    join(root, 'src', 'app.controller.ts'),
    `import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello(): string {
    return 'Hello World!';
  }
}
`,
  );
  return root;
}

export const read = (root: string, path: string) =>
  readFileSync(join(root, path), 'utf8');
export const json = (output: { stdout: string[] }) =>
  JSON.parse(output.stdout.at(-1) ?? '{}') as {
    ok: boolean;
    changes?: string[];
    messages?: string[];
    data?: unknown;
    error?: string;
  };
export function ok(output: {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}): void {
  expect(output.exitCode, [...output.stdout, ...output.stderr].join('\n')).toBe(
    0,
  );
}
export function node(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
/** Applying the same command again changes nothing; the dry run touches nothing. */
export function idempotent(root: string, args: readonly string[]): void {
  const before = read(root, 'package.json');
  const dry = run([...args, '--dry-run'], root);
  ok(dry);
  expect(dry.stdout[0]).toMatch(/^(create|update) /);
  expect(read(root, 'package.json')).toBe(before);
  ok(run(args, root));
  const again = json(run([...args, '--json'], root));
  expect(again).toMatchObject({ ok: true, changes: [] });
}
/** Compile with the repository's TypeScript. */
export function tsc(root: string, project = 'tsconfig.json') {
  return node(
    [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project],
    root,
  );
}

export interface BootedApp {
  readonly origin: string;
  readonly process: ChildProcess;
  logs(): string;
  stop(): void;
}
/** Start `dist/src/main.js` on `port` and wait until `/` answers. */
export async function boot(
  root: string,
  port: number,
  env: NodeJS.ProcessEnv = {},
): Promise<BootedApp> {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      NESTVEXA_ORIGIN: origin,
      ...env,
    },
  });
  let logs = '';
  child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  let ready = false;
  for (
    let attempt = 0;
    attempt < 1200 && !ready && child.exitCode === null;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 100));
    ready = await fetch(origin).then(
      (response) => response.ok,
      () => false,
    );
  }
  expect(ready, `exit ${String(child.exitCode)}: ${logs}`).toBe(true);
  return {
    origin,
    process: child,
    logs: () => logs,
    stop: () => {
      child.kill();
    },
  };
}
