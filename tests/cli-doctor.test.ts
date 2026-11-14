import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  run,
  supportedNode,
} from '../packages/cli/dist/index.js';
import { json } from './support/cli-fixture.js';

/**
 * Doctor checks and package-manager detection on synthetic projects: only
 * package.json files under node_modules, no install. The projects live in the
 * OS temporary directory so nothing resolves from the repository's own
 * node_modules.
 */
const base = mkdtempSync(join(tmpdir(), 'nestvexa-doctor-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
type Files = Record<string, string | object>;
function project(files: Files, parent = base): string {
  const root = join(parent, `p${++count}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return root;
}
const installed = (
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Files => ({
  [`node_modules/${name}/package.json`]: { name, version, ...extra },
});
const healthyMain = `import session from 'express-session';
import { configureNestvexa } from 'nestvexa';
async function bootstrap(app: { use(handler: unknown): void; listen(port: number): Promise<void> }) {
  app.use(session({ secret: sessionSecret(), cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto' } }));
  await configureNestvexa(app);
  await app.listen(3000);
}
`;
/** A healthy Express project: Nest 12, nestvexa, sessions, layout. */
function healthy(overrides: Files = {}, dependencies: Files = {}): string {
  return project({
    'package.json': {
      name: 'app',
      dependencies: {
        '@nestjs/core': '12.2.0',
        '@nestjs/platform-express': '12.2.0',
        nestvexa: '^0.1.0-alpha.0',
        ...dependencies,
      },
    },
    ...installed('@nestjs/core', '12.2.0'),
    ...installed('@nestjs/platform-express', '12.2.0'),
    ...installed('nestvexa', '0.1.0-alpha.0'),
    'views/layout.hbs': '<body>{{{body}}}{{nvScripts}}</body>',
    'src/main.ts': healthyMain,
    ...overrides,
  });
}
interface Check {
  readonly name: string;
  readonly status: string;
  readonly detail: string;
}
function doctor(root: string, ...args: string[]) {
  const output = run(['doctor', '--json', ...args], root);
  const report = json(output);
  const checks = report.data as Check[];
  const byName = (name: string) => checks.find((check) => check.name === name);
  return { output, report, checks, byName };
}

const environment = [
  'NODE_ENV',
  'SESSION_SECRET',
  'REALTIME_SECRET',
  'NESTVEXA_ORIGIN',
  'REDIS_URL',
] as const;
let saved: Partial<Record<string, string>> = {};
beforeEach(() => {
  saved = Object.fromEntries(
    environment.map((name) => [name, process.env[name]]),
  );
  for (const name of environment) delete process.env[name];
});
afterEach(() => {
  for (const name of environment) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('package manager detection', { timeout: 180_000 }, () => {
  const app = (extra: Files = {}, parent?: string) =>
    project(
      {
        'package.json': { name: 'app', dependencies: { '@nestjs/core': '1' } },
        ...extra,
      },
      parent,
    );

  it('reads the lockfile of the project', () => {
    expect(detectPackageManager(app({ 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(detectPackageManager(app({ 'yarn.lock': '' }))).toBe('yarn');
    expect(detectPackageManager(app({ 'bun.lock': '{}' }))).toBe('bun');
    expect(detectPackageManager(app({ 'bun.lockb': '' }))).toBe('bun');
    expect(detectPackageManager(app({ 'package-lock.json': '{}' }))).toBe(
      'npm',
    );
    expect(detectPackageManager(app({ '.git/HEAD': '' }))).toBe('npm');
  });

  it('prefers the Corepack packageManager field and validates it', () => {
    const declared = (packageManager: string, extra: Files = {}) =>
      detectPackageManager(
        project({
          'package.json': {
            name: 'app',
            packageManager,
            dependencies: { '@nestjs/core': '1' },
          },
          ...extra,
        }),
      );
    expect(declared('yarn@4.9.1', { 'package-lock.json': '{}' })).toBe('yarn');
    expect(declared('bun@1.3.0')).toBe('bun');
    expect(declared('pnpm@10.26.1+sha512.abc')).toBe('pnpm');
    // Unknown managers fall back to the lockfile.
    expect(declared('deno@2.0.0', { 'yarn.lock': '' })).toBe('yarn');
  });

  it('finds the workspace lockfile above a workspace package and stops at the repository root', () => {
    const workspace = project({ 'pnpm-lock.yaml': '', '.git/HEAD': '' });
    mkdirSync(join(workspace, 'apps'), { recursive: true });
    expect(detectPackageManager(app({}, join(workspace, 'apps')))).toBe('pnpm');
    const yarnWorkspace = project({ 'yarn.lock': '' });
    const inner = project({ '.git/HEAD': '' }, yarnWorkspace);
    // The inner repository boundary hides the outer yarn.lock.
    expect(detectPackageManager(app({}, inner))).toBe('npm');
  });

  it('uses the detected manager in install, build and doctor hints', () => {
    const root = healthy({
      'yarn.lock': '',
      'vite.islands.config.ts': 'export default {};\n',
    });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: { build: 'tsc' },
        dependencies: {
          '@nestjs/core': '12.2.0',
          '@nestjs/platform-express': '12.2.0',
          nestvexa: '^0.1.0-alpha.0',
        },
      }),
    );
    expect(run(['build', '--dry-run'], root).stdout).toContain(
      'Would run: yarn run build',
    );
    const added = run(['add', 'cache', '--dry-run'], root).stdout.join('\n');
    expect(added).toContain('Run `yarn install`');
    const output = run(['doctor'], root).stdout.join('\n');
    expect(output).toContain('Run `yarn run build:client`');
  });
});

describe('doctor checks', { timeout: 180_000 }, () => {
  it('passes a healthy project and supports only Node 22.13+ and 24', () => {
    const { report, byName } = doctor(healthy());
    expect(report.ok).toBe(true);
    for (const name of [
      'nest',
      'platform',
      'nestvexa',
      'peers',
      'versions',
      'client-duplicates',
      'layout',
      'engines',
      'configure',
      'session',
      'csrf',
      'session-secret',
      'origin',
    ])
      expect(byName(name)?.status, name).toBe('pass');
    expect(supportedNode('22.13.0')).toBe(true);
    expect(supportedNode('22.12.9')).toBe(false);
    expect(supportedNode('24.0.0')).toBe(true);
    expect(supportedNode('23.11.0')).toBe(false);
    expect(supportedNode('20.19.0')).toBe(false);
    expect(supportedNode('25.0.0')).toBe(false);
  });

  it('fails a non-Nest directory and missing or outdated Nest packages', () => {
    const empty = doctor(project({ 'package.json': { name: 'x' } }));
    expect(empty.output.exitCode).toBe(1);
    expect(empty.byName('nest')).toMatchObject({ status: 'fail' });
    const old = doctor(healthy(installed('@nestjs/core', '11.1.0')));
    expect(old.byName('nest')).toMatchObject({ status: 'fail' });
    const root = project({
      'package.json': {
        dependencies: {
          '@nestjs/core': '12.2.0',
          '@nestjs/platform-fastify': '12.2.0',
        },
      },
      ...installed('@nestjs/core', '12.2.0'),
    });
    const missing = doctor(root);
    expect(missing.byName('nest')?.detail).toContain('fastify');
    expect(missing.byName('platform')).toMatchObject({
      status: 'fail',
      detail: '@nestjs/platform-fastify is not installed',
    });
    expect(missing.byName('nestvexa')).toMatchObject({ status: 'fail' });
  });

  it('checks peer ranges, optional peers and version alignment', () => {
    const forms = (peer: Files) =>
      healthy(
        {
          ...installed('@nestvexa/forms', '0.1.0-alpha.0', {
            peerDependencies: { '@nestjs/common': '^12.0.0', zod: '^4.0.0' },
            peerDependenciesMeta: { zod: { optional: true } },
          }),
          ...peer,
        },
        { '@nestvexa/forms': '^0.1.0-alpha.0', '@nestjs/common': '12.2.0' },
      );
    const ok = doctor(forms(installed('@nestjs/common', '12.2.0')));
    expect(ok.byName('peers')).toMatchObject({ status: 'pass' });
    expect(ok.byName('peers')?.detail).toContain('zod (@nestvexa/forms)');
    const wrong = doctor(
      forms({
        ...installed('@nestjs/common', '12.2.0'),
        ...installed('zod', '3.25.0'),
      }),
    );
    expect(wrong.byName('peers')).toMatchObject({ status: 'fail' });
    expect(wrong.byName('peers')?.detail).toContain(
      "zod 3.25.0 does not satisfy @nestvexa/forms's ^4.0.0",
    );
    const absent = doctor(forms({}));
    expect(absent.byName('peers')?.detail).toContain(
      '@nestjs/common required by @nestvexa/forms is not installed',
    );
    const notInstalled = doctor(
      healthy({}, { '@nestvexa/cache': '^0.1.0-alpha.0' }),
    );
    expect(notInstalled.byName('peers')?.detail).toContain(
      '@nestvexa/cache is declared but not installed',
    );
    const mixed = doctor(
      healthy(installed('@nestvexa/cache', '0.1.0-alpha.1'), {
        '@nestvexa/cache': '^0.1.0-alpha.0',
      }),
    );
    expect(mixed.byName('versions')).toMatchObject({ status: 'warn' });
    expect(mixed.byName('versions')?.detail).toContain(
      '@nestvexa/cache@0.1.0-alpha.1',
    );
  });

  it('fails when two browser runtimes are installed', () => {
    const { byName } = doctor(
      healthy({
        ...installed('@nestvexa/client', '0.1.0-alpha.0'),
        ...installed('nestvexa/node_modules/@nestvexa/client', '0.1.0-alpha.1'),
      }),
    );
    expect(byName('client-duplicates')).toMatchObject({
      status: 'fail',
      detail:
        'Multiple @nestvexa/client versions: 0.1.0-alpha.0, 0.1.0-alpha.1',
    });
  });

  it('checks the layout, engines and configureNestvexa', () => {
    const plain = doctor(
      healthy({
        'views/layout.hbs': '<body>{{{body}}}</body>',
        'src/main.ts': 'await app.listen(3000);\n',
      }),
    );
    expect(plain.byName('layout')).toMatchObject({ status: 'warn' });
    expect(plain.byName('configure')).toMatchObject({ status: 'fail' });
    expect(plain.output.exitCode).toBe(1);
    const noLayout = healthy();
    rmSync(join(noLayout, 'views'), { recursive: true });
    expect(doctor(noLayout).byName('layout')).toMatchObject({
      status: 'warn',
      detail: 'views/layout.hbs not found',
    });
    const declared = doctor(
      healthy({}, { '@nestvexa/engine-ejs': '^0.1.0-alpha.0' }),
    );
    expect(declared.byName('engines')).toMatchObject({ status: 'fail' });
    expect(declared.byName('engines')?.detail).toContain(
      '@nestvexa/engine-ejs is declared but not installed',
    );
    const unused = doctor(
      healthy(installed('@nestvexa/engine-pug', '0.1.0-alpha.0'), {
        '@nestvexa/engine-pug': '^0.1.0-alpha.0',
      }),
    );
    expect(unused.byName('engines')).toMatchObject({ status: 'warn' });
    const used = doctor(
      healthy(
        {
          ...installed('@nestvexa/engine-pug', '0.1.0-alpha.0'),
          'src/nestvexa/engines/pug.engine.ts':
            'export const pugEngine = new PugEngine({});\n',
        },
        { '@nestvexa/engine-pug': '^0.1.0-alpha.0' },
      ),
    );
    expect(used.byName('engines')).toMatchObject({
      status: 'pass',
      detail: 'hbs (default); pug 0.1.0-alpha.0',
    });
  });

  it('checks sessions, CSRF, authorization and cookie flags', () => {
    const noSession = doctor(
      healthy({
        'src/main.ts': 'await configureNestvexa(app);\nawait app.listen(1);\n',
      }),
    );
    expect(noSession.byName('session')).toMatchObject({ status: 'warn' });
    const csrf = doctor(
      healthy({
        'src/nestvexa/nestvexa.config.ts':
          'export const options = { security: { csrf: false } };\n',
      }),
    );
    expect(csrf.byName('csrf')).toMatchObject({
      status: 'fail',
      detail: 'CSRF protection is disabled (csrf: false)',
    });
    const authorization = doctor(
      healthy({
        'src/actions.ts':
          'export const options = { requireAuthorizedActions: false };\n',
      }),
    );
    expect(authorization.byName('csrf')?.detail).toContain(
      'requireAuthorizedActions: false',
    );
    const cookie = doctor(
      healthy({
        'src/main.ts': healthyMain.replace(
          "cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto' }",
          'cookie: { maxAge: 1000 }',
        ),
      }),
    );
    expect(cookie.byName('csrf')).toMatchObject({
      status: 'warn',
      detail:
        'Session cookie: httpOnly is not true, sameSite is not set, secure is not set',
    });
    const fastify = project({
      'package.json': {
        dependencies: {
          '@nestjs/core': '12.2.0',
          '@nestjs/platform-fastify': '12.2.0',
          nestvexa: '^0.1.0-alpha.0',
        },
      },
      ...installed('@nestjs/core', '12.2.0'),
      ...installed('@nestjs/platform-fastify', '12.2.0'),
      ...installed('nestvexa', '0.1.0-alpha.0'),
      'src/main.ts': 'await configureNestvexa(app);\n',
      'src/nestvexa/session.ts':
        "await app.register(fastifySession, { secret: 'literal-secret-value', cookie: { httpOnly: true, sameSite: 'lax', secure: false } });\n",
    });
    const report = doctor(fastify);
    expect(report.byName('session')).toMatchObject({
      status: 'pass',
      detail: '@fastify/session is registered',
    });
    expect(report.byName('session-secret')).toMatchObject({ status: 'warn' });
  });

  it('checks secrets and the origin without printing their values', () => {
    const literal = healthy({
      'src/main.ts': healthyMain.replace(
        'sessionSecret()',
        "'keyboard-cat-literal'",
      ),
    });
    expect(doctor(literal).byName('session-secret')).toMatchObject({
      status: 'warn',
    });
    expect(
      doctor(literal, '--production').byName('session-secret'),
    ).toMatchObject({ status: 'fail' });
    process.env['SESSION_SECRET'] = 'too-short-secret';
    const short = doctor(healthy());
    expect(short.byName('session-secret')).toMatchObject({
      status: 'fail',
      detail: 'SESSION_SECRET is set but only 16 characters',
    });
    expect(short.output.stdout.join('\n')).not.toContain('too-short-secret');
    delete process.env['SESSION_SECRET'];
    expect(
      doctor(healthy(), '--production').byName('session-secret'),
    ).toMatchObject({ status: 'fail', detail: 'SESSION_SECRET is not set' });
    process.env['NESTVEXA_ORIGIN'] = 'https://app.example.com/path';
    expect(doctor(healthy()).byName('origin')).toMatchObject({
      status: 'fail',
    });
    process.env['NESTVEXA_ORIGIN'] = 'http://app.example.com';
    expect(doctor(healthy(), '--production').byName('origin')).toMatchObject({
      status: 'warn',
    });
    process.env['NODE_ENV'] = 'production';
    process.env['NESTVEXA_ORIGIN'] = 'https://app.example.com';
    const production = doctor(healthy());
    expect(production.byName('origin')).toMatchObject({ status: 'pass' });
    // NODE_ENV=production behaves like --production.
    expect(production.byName('session-secret')).toMatchObject({
      status: 'fail',
    });
  });

  it('checks realtime and Redis settings only when those packages are used', () => {
    expect(doctor(healthy()).byName('realtime-secret')).toBeUndefined();
    const realtime = (files: Files = {}) =>
      healthy(files, {
        '@nestvexa/realtime': '^0.1.0-alpha.0',
        '@nestvexa/realtime-redis': '^0.1.0-alpha.0',
      });
    const literal = doctor(
      realtime({
        'src/nestvexa/realtime.config.ts':
          "export const options = { secrets: ['inline-signing-secret'] };\n",
      }),
    );
    expect(literal.byName('realtime-secret')).toMatchObject({
      status: 'fail',
      detail: 'A literal realtime signing secret appears in the source',
    });
    expect(literal.output.stdout.join('\n')).not.toContain(
      'inline-signing-secret',
    );
    process.env['REALTIME_SECRET'] = 'x'.repeat(40);
    process.env['REDIS_URL'] = 'http://user:hunter2@cache:6379'; // trufflehog:ignore (fake credential the doctor must redact)
    const report = doctor(realtime());
    expect(report.byName('realtime-secret')).toMatchObject({
      status: 'pass',
      detail: 'REALTIME_SECRET is set (40 bytes, value not displayed)',
    });
    expect(report.byName('redis')).toMatchObject({ status: 'fail' });
    expect(report.output.stdout.join('\n')).not.toContain('hunter2');
  });

  it('checks Vite manifests and SSR bundles of every frontend root and islands', () => {
    const config = `export const inertiaFrameworks = {
  react: { entry: 'client/react/app.tsx', ssr: 'client/react/ssr.tsx', devPort: 5173 },
  vue: { entry: 'client/vue/app.ts', devPort: 5174 },
};
`;
    const files: Files = {
      'src/nestvexa/inertia.config.ts': config,
      'vite.islands.config.ts': 'export default {};\n',
    };
    const missing = doctor(healthy(files));
    expect(missing.byName('assets')).toMatchObject({
      status: 'warn',
      detail: 'Missing Vite builds: react, react (SSR bundle), vue, islands',
    });
    expect(
      doctor(healthy(files), '--production').byName('assets'),
    ).toMatchObject({ status: 'fail' });
    const built = doctor(
      healthy({
        ...files,
        'dist/react/client/.vite/manifest.json': '{}',
        'dist/react/ssr/ssr.mjs': '',
        'dist/vue/client/.vite/manifest.json': '{}',
        'dist/islands/.vite/manifest.json': '{}',
      }),
    );
    expect(built.byName('assets')).toMatchObject({
      status: 'pass',
      detail: 'Vite builds present for react, vue, islands',
    });
  });
});
