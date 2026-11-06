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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinned, run, satisfies } from '../packages/cli/dist/index.js';

const repo = resolve(import.meta.dirname, '..');
const fixtures = join(repo, 'artifacts', 'cli-generators');
const frontend = join(repo, 'examples', 'inertia-mixed', 'node_modules');
// Assigned port range for this suite: 3240-3259.
const port = 3241;

function link(root: string, name: string, target: string): void {
  const path = join(root, 'node_modules', name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(realpathSync(target), path, 'junction');
}
/** A strict ESM Nest app whose node_modules resolve the workspace packages like an install. */
function freshApp(
  name: string,
  type: 'module' | 'commonjs' = 'module',
): string {
  const root = join(fixtures, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
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
  for (const pkg of [
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
  ])
    link(root, pkg, join(frontend, pkg));
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
          '@nestjs/platform-express': '12.2.0',
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
    `import 'reflect-metadata';
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
const read = (root: string, path: string) =>
  readFileSync(join(root, path), 'utf8');
const json = (output: { stdout: string[] }) =>
  JSON.parse(output.stdout.at(-1) ?? '{}') as {
    ok: boolean;
    changes?: string[];
    messages?: string[];
    data?: unknown;
    error?: string;
  };
function ok(output: {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}): void {
  expect(output.exitCode, [...output.stdout, ...output.stderr].join('\n')).toBe(
    0,
  );
}
function node(args: readonly string[], cwd: string) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
/** Applying the same command again changes nothing; the dry run touches nothing. */
function idempotent(root: string, args: readonly string[]): void {
  const before = read(root, 'package.json');
  const dry = run([...args, '--dry-run'], root);
  ok(dry);
  expect(dry.stdout[0]).toMatch(/^(create|update) /);
  expect(read(root, 'package.json')).toBe(before);
  ok(run(args, root));
  const again = json(run([...args, '--json'], root));
  expect(again).toMatchObject({ ok: true, changes: [] });
}

describe('pinned dependency versions', () => {
  it('match the versions the repository examples are built with', () => {
    const versions = new Map<string, Set<string>>();
    const record = (file: string) => {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of ['dependencies', 'devDependencies'])
        for (const [name, range] of Object.entries(pkg[field] ?? {}))
          if (!range.startsWith('workspace:'))
            versions.set(name, new Set([...(versions.get(name) ?? []), range]));
    };
    record(join(repo, 'package.json'));
    for (const example of readdirSync(join(repo, 'examples')))
      if (existsSync(join(repo, 'examples', example, 'package.json')))
        record(join(repo, 'examples', example, 'package.json'));
    for (const [name, version] of Object.entries(pinned)) {
      expect(versions.has(name), `${name} is not used by the repository`).toBe(
        true,
      );
      expect([...(versions.get(name) ?? [])], name).toContain(version);
    }
  });

  it('checks peer ranges like npm for the doctor', () => {
    expect(satisfies('12.2.0', '^12.0.0')).toBe(true);
    expect(satisfies('11.9.0', '^12.0.0')).toBe(false);
    expect(satisfies('0.15.1', '^0.15.0')).toBe(true);
    expect(satisfies('0.16.0', '^0.15.0')).toBe(false);
    expect(satisfies('3.17.9', '~3.17.5')).toBe(true);
    expect(satisfies('3.18.0', '~3.17.5')).toBe(false);
    expect(satisfies('8.22.0', '>=8.18.0 <9')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('0.1.0-alpha.0', '0.1.0-alpha.0')).toBe(true);
  });
});

// Generators run the TypeScript compiler API; allow for loaded hosts.
describe(
  'generators, add and doctor on a strict ESM Nest app',
  { timeout: 90_000 },
  () => {
    let root = '';
    let server: ChildProcess | undefined;
    let logs = '';
    beforeAll(() => {
      root = freshApp('esm-app');
      ok(run(['init'], root));
    }, 60_000);
    afterAll(() => {
      server?.kill();
    });

    it('adds every template engine idempotently and generates engine pages', () => {
      for (const engine of ['ejs', 'pug', 'nunjucks']) {
        idempotent(root, ['add', 'engine', engine]);
        const pkg = JSON.parse(read(root, 'package.json')) as {
          dependencies: Record<string, string>;
        };
        expect(pkg.dependencies[`@nestvexa/engine-${engine}`]).toBe(
          '^0.1.0-alpha.0',
        );
        const name = `Reports-${engine}`;
        ok(run(['make:page', name, '--renderer', engine], root));
      }
      const main = read(root, 'src/main.ts');
      for (const name of [
        'registerEjsEngine',
        'registerPugEngine',
        'registerNunjucksEngine',
      ])
        expect(
          main.match(new RegExp(`await ${name}\\(app\\)`, 'g')),
        ).toHaveLength(1);
      expect(read(root, 'src/pages/reports-ejs.controller.ts')).toContain(
        "@Render('pages/reports-ejs.ejs')",
      );
      expect(existsSync(join(root, 'views/pages/reports-nunjucks.njk'))).toBe(
        true,
      );
      expect(run(['add', 'engine', 'hbs'], root).stdout.join('\n')).toContain(
        'default engine',
      );
      expect(run(['add', 'engine', 'mustache'], root).exitCode).toBe(2);
      ok(run(['make:page', 'Home-hbs'], root));
    });

    it('adds React, Vue and Svelte Inertia roots side by side and generates their pages', () => {
      for (const framework of ['react', 'vue', 'svelte']) {
        idempotent(root, ['add', framework]);
        ok(
          run(
            ['make:page', `${framework}-Dashboard`, '--renderer', framework],
            root,
          ),
        );
      }
      const pkg = JSON.parse(read(root, 'package.json')) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
        scripts: Record<string, string>;
      };
      expect(pkg.dependencies).toMatchObject({
        react: pinned.react,
        vue: pinned.vue,
        svelte: pinned.svelte,
        '@inertiajs/react': pinned['@inertiajs/react'],
        '@nestvexa/inertia': '^0.1.0-alpha.0',
      });
      expect(pkg.devDependencies['vite']).toBe(pinned.vite);
      expect(pkg.scripts['build:client']).toBe(
        'npm run build:react && npm run build:vue && npm run build:svelte',
      );
      expect(pkg.scripts['dev:vue']).toBe('vite -c vite.vue.config.ts');
      const config = read(root, 'src/nestvexa/inertia.config.ts');
      expect(config).toMatch(
        /react: \{ entry: 'client\/react\/app.tsx', devPort: 5173 \},\n\s+vue:/,
      );
      const module = read(root, 'src/app.module.ts');
      expect(module.match(/InertiaModule\.forRoot/g)).toHaveLength(1);
      expect(module).toContain('VueWelcomeController');
      expect(read(root, 'src/pages/svelte-dashboard.controller.ts')).toContain(
        "@InertiaPage('SvelteDashboard', { app: 'svelte' })",
      );
      expect(existsSync(join(root, 'client/vue/pages/VueDashboard.vue'))).toBe(
        true,
      );
      // The server build no longer sees the frontend sources.
      expect(JSON.parse(read(root, 'tsconfig.json'))).toMatchObject({
        exclude: ['node_modules', 'dist', 'client', 'vite.*.config.ts'],
      });
      expect(
        read(root, 'src/main.ts').match(/configureInertia\(app\)/g),
      ).toHaveLength(1);
    });

    it('generates islands for every framework with registry and allowlist entries', () => {
      idempotent(root, ['add', 'islands']);
      ok(run(['make:island', 'Chart', '--renderer', 'react'], root));
      ok(run(['make:island', 'Feed', '--renderer', 'vue'], root));
      ok(run(['make:island', 'Status', '--renderer', 'svelte'], root));
      expect(run(['make:island', 'Nope'], root).exitCode).toBe(2);
      expect(
        json(
          run(['make:island', 'Chart', '--renderer', 'react', '--json'], root),
        ),
      ).toMatchObject({
        ok: true,
        changes: [],
      });
      const chart = read(root, 'client/islands/chart.tsx');
      writeFileSync(join(root, 'client/islands/chart.tsx'), '// edited\n');
      expect(
        run(['make:island', 'Chart', '--renderer', 'react'], root).exitCode,
      ).toBe(1);
      ok(run(['make:island', 'Chart', '--renderer', 'react', '--force'], root));
      expect(read(root, 'client/islands/chart.tsx')).toBe(chart);
      const registry = read(root, 'src/nestvexa/islands.ts');
      expect(registry).toContain("{ id: 'chart', framework: 'react' },");
      expect(registry).toContain("{ id: 'status', framework: 'svelte' },");
      const client = read(root, 'client/islands/index.ts');
      expect(client).toContain(
        "feed: () => import('./feed.island').then((module) => module.default),",
      );
      const vite = read(root, 'vite.islands.config.ts');
      expect(vite).toContain("import react from '@vitejs/plugin-react';");
      expect(vite).toContain(
        "import { svelte } from '@sveltejs/vite-plugin-svelte';",
      );
      expect(vite.match(/react\(\),/g)).toHaveLength(1);
      expect(read(root, 'views/layout.hbs')).toContain('/islands/islands.js');
    });

    it('generates forms, actions, components, resources and tests', () => {
      ok(run(['make:form', 'Contact'], root));
      const config = read(root, 'src/nestvexa/nestvexa.config.ts');
      expect(config).toContain(
        "'contact-form': ['$mount', '$sync', 'submit'],",
      );
      expect(config).toContain('ContactForm,\n  // nestvexa:components');
      ok(run(['make:action', 'Billing'], root));
      ok(run(['make:action', 'Greeter'], root));
      const actions = read(root, 'src/nestvexa/actions.config.ts');
      expect(actions).toContain("billing: ['greet'],");
      expect(actions).toContain('GreeterActions,\n  // nestvexa:action-groups');
      expect(
        read(root, 'src/app.module.ts').match(/ActionsModule\.register/g),
      ).toHaveLength(1);
      ok(run(['make:component', 'Ticker', '--module', 'markets'], root));
      expect(
        existsSync(join(root, 'src/markets/components/ticker.component.ts')),
      ).toBe(true);
      expect(read(root, 'src/nestvexa/nestvexa.config.ts')).toContain(
        "import { TickerComponent } from '../markets/components/ticker.component.js';",
      );
      expect(
        run(['make:component', 'Bad', '--view', 'ejs'], root).exitCode,
      ).toBe(2);
      ok(run(['make:component', 'Clock'], root));
      ok(run(['make:resource', 'Invoice', '--crud'], root));
      expect(
        run(['make:resource', 'Order', '--orm', 'prisma'], root).exitCode,
      ).toBe(2);
      expect(read(root, 'src/app.module.ts')).toContain('InvoiceModule');
      expect(read(root, 'src/nestvexa/nestvexa.config.ts')).toContain(
        'InvoiceModule,\n  // nestvexa:imports',
      );
      ok(run(['make:layout', 'Admin'], root));
      expect(read(root, 'views/layouts/admin.hbs')).toContain('{{nvScripts}}');
      for (const [name, file] of [
        ['Clock', 'src/nestvexa/components/clock.component.spec.ts'],
        ['Home-hbs', 'src/pages/home-hbs.controller.spec.ts'],
        ['Contact', 'src/nestvexa/forms/contact.form.spec.ts'],
        ['Billing', 'src/actions/billing.actions.spec.ts'],
        ['Status', 'test/status.e2e.spec.ts'],
      ] as const) {
        ok(run(['make:test', name], root));
        expect(existsSync(join(root, file)), file).toBe(true);
      }
      expect(read(root, 'src/actions/billing.actions.spec.ts')).toContain(
        "from 'vitest'",
      );
      expect(run(['make:test', 'X', '--kind', 'e2e'], root).exitCode).toBe(2);
    });

    it('adds realtime, uploads, i18n, devtools, forms and actions idempotently', () => {
      for (const feature of ['realtime', 'uploads', 'i18n', 'devtools'])
        idempotent(root, ['add', feature]);
      for (const feature of ['forms', 'actions']) {
        ok(run(['add', feature], root));
        expect(json(run(['add', feature, '--json'], root))).toMatchObject({
          ok: true,
          changes: [],
        });
      }
      const live = read(root, 'src/nestvexa/nestvexa.config.ts');
      expect(live).toContain('inject: [RealtimeService]');
      expect(live).toContain('useFactory: (realtime: RealtimeService) =>');
      expect(live).toMatch(
        /browser: \{ realtime: \{ endpoint: '\/_nestvexa\/realtime' \}, uploads: \{ endpoint: '\/_nestvexa\/uploads' \} \}/,
      );
      const main = read(root, 'src/main.ts');
      expect(main.indexOf('configureI18n(app)')).toBeLessThan(
        main.indexOf('await configureNestvexa(app)'),
      );
      expect(main).toContain('await configureUploads(app);');
      expect(main).toContain('configureDevtools(app);');
      expect(run(['add', 'jquery'], root).exitCode).toBe(2);
    });

    it('type-checks every generated server and client file', () => {
      const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
      const server = node([tsc, '-p', 'tsconfig.json'], root);
      expect(server.status, server.output).toBe(0);
      for (const project of [
        'client/react/tsconfig.json',
        'client/islands/tsconfig.json',
      ]) {
        const result = node([tsc, '-p', project], root);
        expect(result.status, `${project}\n${result.output}`).toBe(0);
      }
      const vue = node(
        [
          join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'),
          '-p',
          'client/vue/tsconfig.json',
        ],
        root,
      );
      expect(vue.status, vue.output).toBe(0);
      const svelte = node(
        [
          join(root, 'node_modules/svelte-check/bin/svelte-check'),
          '--tsconfig',
          'client/svelte/tsconfig.json',
          '--fail-on-warnings',
          '--output',
          'machine',
        ],
        root,
      );
      expect(svelte.status, svelte.output).toBe(0);
      const check = run(['check', '--json'], root);
      expect(json(check), check.stdout.join('\n')).toMatchObject({ ok: true });
    }, 240_000);

    it('runs the generated unit tests against the compiled output', () => {
      const vitest = join(repo, 'node_modules', 'vitest', 'vitest.mjs');
      // Only the compiled unit tests; the HTTP smoke test is compiled but needs a full boot.
      writeFileSync(
        join(root, 'vitest.config.mjs'),
        "export default { test: { include: ['dist/src/**/*.spec.js'] } };\n",
      );
      const result = node(
        [
          vitest,
          'run',
          '--root',
          root,
          '--config',
          'vitest.config.mjs',
          '--reporter',
          'dot',
          '--no-color',
        ],
        root,
      );
      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(/Test Files\s+4 passed/);
    }, 120_000);

    it('boots the generated app: engine pages, Inertia roots, actions and the dev error page', async () => {
      writeFileSync(
        join(root, 'views/pages/home-hbs.hbs'),
        '<h1>{{title}}</h1>\n<p>{{title bar=}}</p>\n',
      );
      server = spawn(process.execPath, ['dist/src/main.js'], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          PORT: String(port),
          NESTVEXA_ORIGIN: `http://127.0.0.1:${port}`,
        },
      });
      server.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (
        let attempt = 0;
        attempt < 1200 && !ready && server.exitCode === null;
        attempt++
      ) {
        await new Promise((done) => setTimeout(done, 100));
        ready = await fetch(origin).then(
          (response) => response.ok,
          () => false,
        );
      }
      expect(ready, `exit ${String(server.exitCode)}: ${logs}`).toBe(true);
      for (const [path, engine] of [
        ['/reports-ejs', 'EJS'],
        ['/reports-pug', 'Pug'],
        ['/reports-nunjucks', 'Nunjucks'],
      ] as const) {
        const response = await fetch(`${origin}${path}`);
        const html = await response.text();
        expect(response.status, html).toBe(200);
        expect(html).toContain(`page rendered by ${engine}`);
        expect(html).toMatch(/<main><h1>Reports(Ejs|Pug|Nunjucks)<\/h1>/);
      }
      const welcome = await fetch(`${origin}/nestvexa`);
      expect(welcome.status).toBe(200);
      expect(await (await fetch(`${origin}/invoice`)).json()).toEqual([]);
      const page = await (await fetch(`${origin}/react`)).text();
      expect(page).toContain('data-page="app"');
      expect(page).toContain(
        '{"component":"Welcome","props":{"errors":{},"title":"Welcome"}',
      );
      expect(page).toContain('http://localhost:5173/build/react/@vite/client');
      const xhr = await fetch(`${origin}/vue-dashboard`, {
        headers: { 'X-Inertia': 'true', 'X-Inertia-Version': 'vue:dev' },
      });
      expect(xhr.status).toBe(200);
      expect(await xhr.json()).toMatchObject({
        component: 'VueDashboard',
        props: { title: 'VueDashboard' },
      });
      const action = await fetch(`${origin}/_nestvexa/actions/billing/greet`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { name: 'Ada' } }),
      });
      expect([401, 403]).toContain(action.status);
      const broken = await fetch(`${origin}/home-hbs`, {
        headers: { accept: 'text/html' },
      });
      const report = await broken.text();
      expect(broken.status).toBe(500);
      expect(broken.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(report).toContain('views/pages/home-hbs.hbs:2');
      expect(report).toMatch(
        /href="vscode:\/\/file\/[^"]+\/views\/pages\/home-hbs\.hbs:2:\d+"/,
      );
      expect(report).toContain(
        '<mark>   2 | &lt;p&gt;{{title bar=}}&lt;/p&gt;</mark>',
      );
      const api = await fetch(`${origin}/home-hbs`, {
        headers: { accept: 'application/json' },
      });
      expect(api.status).toBe(500);
      expect(await api.json()).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
    }, 180_000);

    it('reports doctor checks as JSON, fails production gaps and never prints secrets', () => {
      const report = json(run(['doctor', '--json'], root));
      const checks = report.data as {
        name: string;
        status: string;
        detail: string;
      }[];
      const status = Object.fromEntries(
        checks.map((check) => [check.name, check.status]),
      );
      expect(report.ok).toBe(true);
      expect(status).toMatchObject({
        nest: 'pass',
        platform: 'pass',
        peers: 'pass',
        versions: 'pass',
        engines: 'pass',
        csrf: 'pass',
        devtools: 'pass',
        assets: 'warn',
        'realtime-secret': 'warn',
      });
      const secret = 'short-realtime-secret';
      const session = 'session-secret-that-is-long-enough-to-pass-0123456789';
      const saved = { ...process.env };
      try {
        process.env['REALTIME_SECRET'] = secret;
        process.env['SESSION_SECRET'] = session;
        const production = run(['doctor', '--production', '--json'], root);
        expect(production.exitCode).toBe(1);
        const failed = Object.fromEntries(
          (json(production).data as { name: string; status: string }[]).map(
            (check) => [check.name, check.status],
          ),
        );
        expect(failed).toMatchObject({
          'realtime-secret': 'fail',
          'session-secret': 'pass',
          origin: 'fail',
          assets: 'fail',
        });
        const text = run(['doctor', '--production'], root);
        const output = [...text.stdout, ...text.stderr].join('\n');
        expect(output).toContain('REALTIME_SECRET is 21 bytes');
        expect(output).not.toContain(secret);
        expect(output).not.toContain(session);
      } finally {
        process.env = saved;
      }
      writeFileSync(
        join(root, 'src/nestvexa/unsafe-devtools.ts'),
        "import { DevErrorFilter } from '@nestvexa/observability';\nexport const filter = () => new DevErrorFilter();\n",
      );
      const unsafe = json(run(['doctor', '--json', '--production'], root));
      expect(
        (unsafe.data as { name: string; status: string }[]).find(
          (check) => check.name === 'devtools',
        ),
      ).toMatchObject({
        status: 'fail',
      });
      rmSync(join(root, 'src/nestvexa/unsafe-devtools.ts'));
    });
  },
);

// Generators run the TypeScript compiler API; allow for loaded hosts.
describe(
  'templates, output modes and Windows paths',
  { timeout: 90_000 },
  () => {
    let root = '';
    beforeAll(() => {
      root = freshApp('templates-app', 'commonjs');
      ok(run(['init', '--quiet'], root));
    });

    it('honors --quiet, --verbose and --json', () => {
      expect(run(['make:layout', 'Quiet', '--quiet'], root)).toMatchObject({
        exitCode: 0,
        stdout: [],
      });
      const verbose = run(
        ['make:resource', 'Ledger', '--crud', '--verbose'],
        root,
      );
      ok(verbose);
      expect(verbose.stdout).toEqual(
        expect.arrayContaining(['create src/ledger/ledger.module.ts']),
      );
      const failure = run(['make:component', 'bad name!', '--json'], root);
      expect(failure.exitCode).toBe(1);
      expect(json(failure)).toMatchObject({ ok: false, exitCode: 1 });
      expect(run(['make:page', '--renderer'], root).exitCode).toBe(2);
      const help = run(['make:island', '--help'], root).stdout.join('\n');
      expect(help).toContain('--renderer <react|vue|svelte>');
    });

    it('ejects and applies a customized template and records its id', () => {
      ok(run(['templates:eject', 'component.class'], root));
      const path = join(root, '.nestvexa/templates/component.class');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '@State() count = 0;',
          '@State() count = 10;',
        ),
      );
      ok(run(['make:component', 'Gauge'], root));
      expect(
        read(root, 'src/nestvexa/components/gauge.component.ts'),
      ).toContain('@State() count = 10;');
      expect(
        read(root, 'src/nestvexa/components/gauge.component.ts'),
      ).toContain('export class GaugeComponent');
      const manifest = JSON.parse(read(root, '.nestvexa/manifest.json')) as {
        files: Record<string, { template?: string; templateVersion?: number }>;
      };
      expect(
        manifest.files['src/nestvexa/components/gauge.component.ts'],
      ).toMatchObject({
        template: 'custom:component.class',
        templateVersion: 1,
      });
      const listed = json(run(['templates', '--json'], root)).data as {
        id: string;
        overridden: boolean;
      }[];
      expect(listed.find((row) => row.id === 'component.class')).toMatchObject({
        overridden: true,
      });
      expect(run(['templates:eject', 'nope'], root).exitCode).toBe(2);
    });

    it('accepts backslash and relative --cwd paths and refuses traversal names', () => {
      const windows = root.replaceAll('/', '\\');
      ok(run(['doctor', '--json', '--cwd', windows], repo));
      ok(
        run(
          [
            'inspect:routes',
            '--json',
            '--cwd',
            'artifacts/cli-generators/templates-app',
          ],
          repo,
        ),
      );
      expect(run(['make:page', '..\\evil'], root).exitCode).toBe(1);
      expect(
        run(['make:component', 'x', '--module', '../outside'], root).exitCode,
      ).toBe(2);
    });

    it('builds through the project script (dry run and real)', () => {
      expect(run(['build', '--dry-run'], root).stdout).toEqual([
        'Would run: npm run build',
      ]);
      const built = run(['build', '--json'], root);
      expect(json(built), built.stdout.join('\n')).toMatchObject({
        ok: true,
        messages: ['Build succeeded.'],
      });
      expect(existsSync(join(root, 'dist/src/main.js'))).toBe(true);
    }, 120_000);
  },
);

// Generators run the TypeScript compiler API; allow for loaded hosts.
describe('nestvexa migrate', { timeout: 90_000 }, () => {
  let root = '';
  const legacy =
    "secret: process.env['SESSION_SECRET'] ?? randomBytes(48).toString('base64url'),";
  beforeAll(() => {
    root = freshApp('migrate-app', 'commonjs');
    ok(run(['init'], root));
    // Reproduce a project initialized by the first alpha CLI.
    const main = read(root, 'src/main.ts')
      .replace('secret: sessionSecret(),', legacy)
      .replace(
        ", sessionSecret } from './nestvexa/nestvexa.config';",
        " } from './nestvexa/nestvexa.config';",
      )
      .replace(
        "import { sessionSecret } from './nestvexa/nestvexa.config';\n",
        '',
      )
      .replace(
        "import { configureNestvexa } from 'nestvexa';",
        "import { configureNestvexa } from 'nestvexa';\nimport { randomBytes } from 'node:crypto';",
      );
    writeFileSync(join(root, 'src/main.ts'), main);
    const config = read(root, 'src/nestvexa/nestvexa.config.ts');
    writeFileSync(
      join(root, 'src/nestvexa/nestvexa.config.ts'),
      config.slice(0, config.indexOf('/**\n * Session signing secret')) +
        config.slice(config.indexOf('export const nestvexaOptions')),
    );
    const manifest = JSON.parse(read(root, '.nestvexa/manifest.json')) as {
      files: Record<string, { sha256: string; feature: string }>;
    };
    writeFileSync(
      join(root, '.nestvexa/manifest.json'),
      JSON.stringify(
        {
          version: 1,
          files: Object.fromEntries(
            Object.entries(manifest.files).map(([path, entry]) => [
              path,
              { sha256: entry.sha256, feature: entry.feature },
            ]),
          ),
        },
        null,
        2,
      ),
    );
  });

  it('lists pending versioned steps in a dry run without writing', () => {
    const before = read(root, 'src/main.ts');
    const dry = run(['migrate', '--dry-run', '--json'], root);
    ok(dry);
    const result = json(dry) as {
      changes: string[];
      data: { pending: { id: string }[]; manifestVersion: number };
    };
    expect(result.data.pending.map((step) => step.id)).toEqual([
      '0001-manifest-v2',
      '0002-session-secret-required-in-production',
    ]);
    expect(result.data.manifestVersion).toBe(1);
    expect(result.changes).toEqual(
      expect.arrayContaining(['update src/main.ts']),
    );
    expect(read(root, 'src/main.ts')).toBe(before);
  });

  it('applies the steps, records them and keeps the project compiling', () => {
    ok(run(['migrate'], root));
    const main = read(root, 'src/main.ts');
    expect(main).toContain('secret: sessionSecret(),');
    expect(main).not.toContain('randomBytes');
    expect(main).toContain(
      "import { sessionSecret } from './nestvexa/nestvexa.config';",
    );
    expect(read(root, 'src/nestvexa/nestvexa.config.ts')).toContain(
      'export function sessionSecret()',
    );
    const manifest = JSON.parse(read(root, '.nestvexa/manifest.json')) as {
      version: number;
      cli: string;
      migrations: { id: string }[];
    };
    expect(manifest.version).toBe(2);
    expect(manifest.cli).toBe('0.1.0-alpha.0');
    expect(manifest.migrations.map((step) => step.id)).toEqual([
      '0001-manifest-v2',
      '0002-session-secret-required-in-production',
    ]);
    expect(run(['migrate'], root).stdout.join('\n')).toContain('Up to date');
    const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    const compiled = node([tsc, '-p', 'tsconfig.json', '--noEmit'], root);
    expect(compiled.status, compiled.output).toBe(0);
  }, 60_000);

  it('reverts newest first and refuses to overwrite later edits without --force', () => {
    expect(
      run(['migrate', '--revert', '0001-manifest-v2'], root).exitCode,
    ).toBe(1);
    expect(run(['migrate', '--revert', '9999-unknown'], root).exitCode).toBe(1);
    writeFileSync(
      join(root, 'src/main.ts'),
      `${read(root, 'src/main.ts')}// edited\n`,
    );
    const refused = run(
      ['migrate', '--revert', '0002-session-secret-required-in-production'],
      root,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join('\n')).toContain('src/main.ts');
    ok(
      run(
        [
          'migrate',
          '--revert',
          '0002-session-secret-required-in-production',
          '--force',
        ],
        root,
      ),
    );
    expect(read(root, 'src/main.ts')).toContain(legacy);
    expect(read(root, 'src/nestvexa/nestvexa.config.ts')).not.toContain(
      'export function sessionSecret()',
    );
    ok(run(['migrate', '--revert', '0001-manifest-v2'], root));
    expect(JSON.parse(read(root, '.nestvexa/manifest.json'))).toMatchObject({
      version: 1,
    });
    // A v1 manifest stays v1 when other commands write to it.
    ok(run(['make:layout', 'Legacy'], root));
    const manifest = JSON.parse(read(root, '.nestvexa/manifest.json')) as {
      version: number;
      files: Record<string, object>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.files['views/layouts/legacy.hbs']).toEqual({
      sha256: expect.any(String),
      feature: 'layout:legacy',
    });
    ok(run(['migrate'], root));
    expect(read(root, 'src/main.ts')).toContain('secret: sessionSecret(),');
  });
});
