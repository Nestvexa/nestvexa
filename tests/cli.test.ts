import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangePlan, run } from '../packages/cli/dist/index.js';

const repo = resolve(import.meta.dirname, '..');
const fixtures = join(repo, 'artifacts', 'cli-e2e');
function freshApp(name: string): string {
  const root = join(fixtures, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  // Resolve the workspace umbrella like an installed dependency.
  symlinkSync(
    join(repo, 'packages', 'nestvexa'),
    join(root, 'node_modules', 'nestvexa'),
    'junction',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        scripts: { build: 'tsc -p tsconfig.json' },
        dependencies: {
          '@nestjs/common': '12.2.0',
          '@nestjs/core': '12.2.0',
          '@nestjs/platform-express': '12.2.0',
          'reflect-metadata': '0.2.2',
          rxjs: '7.8.2',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'src', 'main.ts'),
    `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1');
}
void bootstrap();
`,
  );
  writeFileSync(
    join(root, 'src', 'app.module.ts'),
    `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

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
const read = (root: string, path: string) =>
  readFileSync(join(root, path), 'utf8');

describe('nestvexa CLI basics', () => {
  it('prints help/version and rejects unknown commands and options', () => {
    expect(run(['--version']).stdout).toEqual(['0.1.0-alpha.0']);
    expect(run(['--help']).stdout.join('\n')).toContain(
      'make:component <Name>',
    );
    expect(run(['init', '--help']).stdout.join('\n')).toContain('Idempotent');
    expect(run(['explode']).exitCode).toBe(2);
    expect(run(['doctor', '--surprise']).exitCode).toBe(2);
  });

  it('refuses non-Nest projects and paths outside the project', () => {
    const root = join(fixtures, 'not-nest');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"plain"}');
    const result = run(['init'], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join('')).toContain(
      'does not look like a NestJS project',
    );
    const plan = new ChangePlan(root, 'x');
    expect(() => plan.create('../escape.ts', 'x')).toThrow(
      /outside the project/,
    );
  });

  it('rolls back every write when one change fails', () => {
    const root = join(fixtures, 'rollback');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'existing.txt'), 'original');
    writeFileSync(join(root, 'blocker'), 'a file, not a directory');
    const plan = new ChangePlan(root, 'test');
    plan.update('existing.txt', 'changed');
    plan.create('fresh.txt', 'new');
    plan.create('blocker/inside.txt', 'cannot be written');
    expect(() => plan.apply()).toThrow(/rolled back/);
    expect(read(root, 'existing.txt')).toBe('original');
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false);
  });
});

describe('nestvexa init and generators on a fresh CommonJS Nest app', () => {
  let root = '';
  let server: ChildProcess | undefined;
  beforeAll(() => {
    root = freshApp('fresh-app');
  });
  afterAll(() => {
    server?.kill();
  });

  it('dry-runs, applies idempotently and patches module and main once', () => {
    const before = read(root, 'src/app.module.ts');
    const dry = run(['init', '--dry-run'], root);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.join('\n')).toContain('create views/layout.hbs');
    expect(read(root, 'src/app.module.ts')).toBe(before);
    const applied = run(['init'], root);
    expect(applied.exitCode, applied.stderr.join('\n')).toBe(0);
    const module = read(root, 'src/app.module.ts');
    expect(module.match(/NestvexaModule\.forRoot/g)).toHaveLength(1);
    expect(module).toContain(
      'controllers: [AppController, NestvexaWelcomeController]',
    );
    expect(
      read(root, 'src/main.ts').match(/configureNestvexa\(app\)/g),
    ).toHaveLength(1);
    const pkg = JSON.parse(read(root, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['nestvexa']).toBe('^0.1.0-alpha.0');
    const again = run(['init', '--json'], root);
    expect(JSON.parse(again.stdout[0] ?? '{}')).toMatchObject({
      ok: true,
      changes: [],
    });
  });

  it('generates components with registration, conflicts and safe removal', () => {
    expect(run(['make:component', 'StockTicker'], root).exitCode).toBe(0);
    const config = read(root, 'src/nestvexa/nestvexa.config.ts');
    expect(config).toContain('StockTickerComponent,');
    expect(config).toContain("'stock-ticker': ['$mount', 'increment']");
    const conflict = run(['make:component', 'StockTicker'], root);
    expect(conflict.exitCode).toBe(0);
    expect(run(['make:component', 'bad name!'], root).exitCode).toBe(1);
    expect(run(['make:page', 'Reports'], root).exitCode).toBe(0);
    expect(
      run(['make:page', 'Admin', '--renderer', 'jsx'], root).exitCode,
    ).toBe(2);
    expect(run(['make:policy', 'Editors'], root).exitCode).toBe(0);
    expect(run(['make:resource', 'Invoice'], root).exitCode).toBe(0);
    // The Zod DTOs need @nestvexa/forms and zod: the generator declares them,
    // and the install the fixture skips is simulated with a junction (zod
    // resolves from the repository root).
    const declared = JSON.parse(read(root, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(declared.dependencies).toMatchObject({
      '@nestvexa/forms': '^0.1.0-alpha.0',
      zod: expect.any(String),
    });
    mkdirSync(join(root, 'node_modules', '@nestvexa'), { recursive: true });
    symlinkSync(
      join(repo, 'packages', 'forms'),
      join(root, 'node_modules', '@nestvexa', 'forms'),
      'junction',
    );
    writeFileSync(
      join(root, 'views/components/stock-ticker.hbs'),
      '<p>edited by the user</p>',
    );
    const removed = run(['remove', 'component:stock-ticker'], root);
    expect(removed.exitCode).toBe(0);
    expect(
      existsSync(
        join(root, 'src/nestvexa/components/stock-ticker.component.ts'),
      ),
    ).toBe(false);
    expect(read(root, 'views/components/stock-ticker.hbs')).toBe(
      '<p>edited by the user</p>',
    );
    expect(removed.stdout.join('\n')).toContain('Kept 1 file(s) you modified');
    // Keep the project compiling after removing the class.
    writeFileSync(
      join(root, 'src/nestvexa/nestvexa.config.ts'),
      read(root, 'src/nestvexa/nestvexa.config.ts')
        .replace(
          "import { StockTickerComponent } from './components/stock-ticker.component';\n",
          '',
        )
        .replace('  StockTickerComponent,\n', ''),
    );
  });

  it('inspects components, routes and actions statically', () => {
    const components = JSON.parse(
      run(['inspect:components', '--json'], root).stdout[0] ?? '{}',
    ) as {
      data: { name: string }[];
    };
    expect(components.data.map((row) => row.name)).toContain('counter');
    const routes = JSON.parse(
      run(['inspect:routes', '--json'], root).stdout[0] ?? '{}',
    ) as {
      data: { path: string }[];
    };
    expect(routes.data.map((row) => row.path)).toEqual(
      expect.arrayContaining(['/', '/nestvexa', '/reports']),
    );
    const actions = run(['inspect:actions'], root).stdout.join('\n');
    expect(actions).toContain('POST /_nestvexa/live/counter/increment');
  });

  it('builds, boots and serves a working Live counter', async () => {
    const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    const compiled = spawnSync(
      process.execPath,
      [tsc, '-p', join(root, 'tsconfig.json')],
      { encoding: 'utf8' },
    );
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() =>
          done(typeof address === 'object' && address ? address.port : 0),
        );
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['dist/main.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        NESTVEXA_ORIGIN: origin,
        SESSION_SECRET: 'cli-e2e-secret-0123456789abcdefghijklmnop',
      },
    });
    let ready = false;
    for (let attempt = 0; attempt < 450 && !ready; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      ready = await fetch(origin).then(
        (response) => response.ok,
        () => false,
      );
    }
    expect(ready).toBe(true);
    expect(await (await fetch(origin)).text()).toBe('Hello World!');
    const page = await fetch(`${origin}/nestvexa`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<h1>Nestvexa is ready</h1>');
    expect(html).toContain('data-nv-name="counter"');
    expect(html).toMatch(
      /<script type="module" src="[^"]+boot\.js"><\/script>/,
    );
    const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
    const csrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1];
    const action = await fetch(`${origin}/_nestvexa/live/counter/increment`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf ?? '',
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: crypto.randomUUID(),
        snapshot,
        revision: 0,
        updates: {},
        input: null,
      }),
    });
    expect(action.status).toBe(201);
    expect(
      ((await action.json()) as { state: { count: number } }).state.count,
    ).toBe(1);
    const doctor = JSON.parse(
      run(['doctor', '--json'], root).stdout[0] ?? '{}',
    ) as {
      data: { name: string; status: string }[];
    };
    const statuses = Object.fromEntries(
      doctor.data.map((check) => [check.name, check.status]),
    );
    expect(statuses).toMatchObject({
      nest: 'pass',
      nestvexa: 'pass',
      configure: 'pass',
      session: 'pass',
      layout: 'pass',
    });
  }, 120_000);
});
