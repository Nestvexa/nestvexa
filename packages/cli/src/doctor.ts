import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import type { CommandContext, CommandResult } from './context.js';
import { toPosix } from './plan.js';
import { detectProject } from './project.js';
import type { ProjectInfo } from './project.js';
import { engines } from './templates-app.js';
import type { Engine } from './templates-app.js';

export interface Check {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
  /** What to do about a warning or failure. */
  readonly hint?: string;
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}
function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}
function compare(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    // A release sorts after its prereleases; prereleases compare as text.
    (a.prerelease === b.prerelease
      ? 0
      : !a.prerelease
        ? 1
        : !b.prerelease
          ? -1
          : a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true }))
  );
}
/**
 * Minimal npm range check for peer validation: `*`, exact, `^`, `~`, `>=`,
 * `>`, `<=`, `<`, space-separated intersections and `||` unions. Unknown
 * syntax (tags, URLs, `workspace:`) is treated as satisfied.
 */
export function satisfies(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual) return true;
  return range.split('||').some((alternative) => {
    const parts = alternative.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return true;
    return parts.every((part) => {
      if (part === '*' || part === 'x' || part.startsWith('workspace:'))
        return true;
      const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(part);
      const operator = match?.[1] ?? '';
      const wanted = parseVersion(match?.[2] ?? '');
      if (!wanted) return true;
      const order = compare(actual, wanted);
      if (operator === '>=') return order >= 0;
      if (operator === '>') return order > 0;
      if (operator === '<=') return order <= 0;
      if (operator === '<') return order < 0;
      if (operator === '' || operator === '=') return order === 0;
      if (order < 0) return false;
      if (operator === '~')
        return actual.major === wanted.major && actual.minor === wanted.minor;
      // Caret: same left-most non-zero component.
      if (wanted.major > 0) return actual.major === wanted.major;
      if (wanted.minor > 0)
        return actual.major === 0 && actual.minor === wanted.minor;
      return (
        actual.major === 0 &&
        actual.minor === 0 &&
        actual.patch === wanted.patch
      );
    });
  });
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Package manifest as Node resolves it from the project (hoisted installs included). */
function installedPackage(
  root: string,
  name: string,
): Record<string, unknown> | undefined {
  let directory = root;
  for (let depth = 0; depth < 32; depth++) {
    const file = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(file)) return readJson(file);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
function installedVersion(root: string, name: string): string | undefined {
  const version = installedPackage(root, name)?.['version'];
  return typeof version === 'string' ? version : undefined;
}
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
function sourceTexts(project: ProjectInfo): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (directory: string): void => {
    if (!existsSync(directory) || out.size > 2000) return;
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts'))
        out.set(
          toPosix(relative(project.root, path)),
          readFileSync(path, 'utf8'),
        );
    }
  };
  walk(join(project.root, project.sourceRoot));
  return out;
}
/** Keys of `export const inertiaFrameworks = { ... }` in the generated config. */
function inertiaRoots(text: string): string[] {
  const source = ts.createSourceFile(
    'inertia.config.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'inertiaFrameworks' &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      )
        return declaration.initializer.properties.flatMap((property) =>
          property.name &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [property.name.text]
            : [],
        );
  }
  return [];
}

/**
 * `nestvexa doctor`: environment and configuration checks. Secret values are
 * never printed — only whether they are set and long enough. `--production`
 * (or NODE_ENV=production) turns deployment warnings into failures.
 */
export function doctor(context: CommandContext): CommandResult {
  const checks: Check[] = [];
  const add = (
    name: string,
    status: Check['status'],
    detail: string,
    hint?: string,
  ) => checks.push({ name, status, detail, ...(hint ? { hint } : {}) });
  const production =
    context.options['production'] === true ||
    process.env['NODE_ENV'] === 'production';
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    'node',
    (major === 22 && minor >= 13) || major === 24 ? 'pass' : 'fail',
    `Node ${process.versions.node} (supported: ^22.13 or ^24)`,
    'Install a Node LTS release (22.13+ or 24).',
  );
  let project: ProjectInfo | undefined;
  try {
    project = detectProject(context.cwd);
  } catch (error) {
    add('nest', 'fail', error instanceof Error ? error.message : String(error));
  }
  if (!project) return report(checks);
  const root = project.root;
  const nest = installedVersion(root, '@nestjs/core');
  add(
    'nest',
    nest === undefined ? 'fail' : satisfies(nest, '^12.0.0') ? 'pass' : 'fail',
    nest === undefined
      ? `@nestjs/core ${project.dependencies['@nestjs/core'] ?? ''} is not installed`
      : `@nestjs/core ${nest}, ${project.platform}`,
    `Nestvexa needs NestJS 12; run \`${project.packageManager} install\`.`,
  );
  const platform = `@nestjs/platform-${project.platform}`;
  add(
    'platform',
    installedVersion(root, platform) ? 'pass' : 'fail',
    installedVersion(root, platform)
      ? `${platform} ${installedVersion(root, platform) ?? ''}`
      : `${platform} is not installed`,
    `Install ${platform}.`,
  );
  const umbrella = installedVersion(root, 'nestvexa');
  add(
    'nestvexa',
    umbrella ? 'pass' : 'fail',
    umbrella ? `nestvexa ${umbrella}` : 'nestvexa is not installed',
    'Run `nestvexa init` and install dependencies.',
  );

  // Peer versions of every installed Nestvexa package.
  const firstParty = Object.keys(project.dependencies).filter(
    (name) => name === 'nestvexa' || name.startsWith('@nestvexa/'),
  );
  const versions = new Map<string, string>();
  const peerProblems: string[] = [];
  const optionalMissing: string[] = [];
  for (const name of firstParty) {
    const manifest = installedPackage(root, name);
    const installed = manifest?.['version'];
    if (typeof installed !== 'string') {
      peerProblems.push(`${name} is declared but not installed`);
      continue;
    }
    versions.set(name, installed);
    const meta = manifest?.['peerDependenciesMeta'];
    for (const [peer, wanted] of Object.entries(
      stringRecord(manifest?.['peerDependencies']),
    )) {
      if (peer.startsWith('@nestvexa/') || peer === 'nestvexa') continue;
      const found = installedVersion(root, peer);
      const optional =
        meta && typeof meta === 'object'
          ? Reflect.get(Reflect.get(meta, peer) ?? {}, 'optional') === true
          : false;
      if (found === undefined) {
        if (optional || !project.dependencies[peer])
          optionalMissing.push(`${peer} (${name})`);
        else peerProblems.push(`${peer} required by ${name} is not installed`);
      } else if (!satisfies(found, wanted))
        peerProblems.push(
          `${peer} ${found} does not satisfy ${name}'s ${wanted}`,
        );
    }
  }
  add(
    'peers',
    peerProblems.length ? 'fail' : 'pass',
    peerProblems.length
      ? peerProblems.join('; ')
      : `${versions.size} Nestvexa package(s) with compatible peers${optionalMissing.length ? `; not installed (optional unless used): ${optionalMissing.join(', ')}` : ''}`,
    'Install the listed peers at a compatible version.',
  );
  const distinct = new Set(versions.values());
  add(
    'versions',
    distinct.size > 1 ? 'warn' : 'pass',
    distinct.size > 1
      ? `Nestvexa packages are on different versions: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`
      : 'Nestvexa packages share one version',
    'Upgrade all Nestvexa packages together, then run `nestvexa migrate`.',
  );
  const clients = new Set<string>();
  for (const path of [
    'node_modules/@nestvexa/client',
    'node_modules/nestvexa/node_modules/@nestvexa/client',
  ]) {
    const version = readJson(join(root, path, 'package.json'))?.['version'];
    if (typeof version === 'string') clients.add(version);
  }
  add(
    'client-duplicates',
    clients.size > 1 ? 'fail' : 'pass',
    clients.size > 1
      ? `Multiple @nestvexa/client versions: ${[...clients].join(', ')}`
      : 'One browser runtime',
    'Dedupe @nestvexa/client so only one browser runtime ships.',
  );

  // Template engines.
  const views = join(root, 'views');
  const layout = join(views, 'layout.hbs');
  add(
    'layout',
    existsSync(layout) && readFileSync(layout, 'utf8').includes('{{nvScripts')
      ? 'pass'
      : 'warn',
    existsSync(layout)
      ? 'views/layout.hbs should include {{nvScripts}} once'
      : 'views/layout.hbs not found',
    'Add {{nvScripts}} (or {{nvScripts nonce=cspNonce}}) to the document layout.',
  );
  const mainText = existsSync(join(root, project.mainFile))
    ? readFileSync(join(root, project.mainFile), 'utf8')
    : '';
  const sources = sourceTexts(project);
  const allSource = [...sources.values()].join('\n');
  const engineNotes: string[] = [];
  let engineStatus: Check['status'] = 'pass';
  for (const engine of Object.keys(engines) as Engine[]) {
    const { package: name, className } = engines[engine];
    if (!project.dependencies[name]) continue;
    const installed = installedVersion(root, name);
    const used = allSource.includes(className);
    if (!installed) {
      engineStatus = 'fail';
      engineNotes.push(`${name} is declared but not installed`);
    } else if (!used) {
      engineStatus = engineStatus === 'fail' ? 'fail' : 'warn';
      engineNotes.push(
        `${name} is installed but ${className} is never constructed`,
      );
    } else engineNotes.push(`${engine} ${installed}`);
  }
  add(
    'engines',
    engineStatus,
    `hbs (default)${engineNotes.length ? `; ${engineNotes.join('; ')}` : ''}`,
    'Run `nestvexa add engine <name>` to wire an adapter, or remove the unused dependency.',
  );
  add(
    'configure',
    mainText.includes('configureNestvexa(') ? 'pass' : 'fail',
    'main.ts must call configureNestvexa(app) before listen()',
    'Run `nestvexa init` or add `await configureNestvexa(app)`.',
  );

  // Sessions, CSRF and secrets (values are never printed).
  add(
    'session',
    /session\(/.test(mainText) ? 'pass' : 'warn',
    /session\(/.test(mainText)
      ? 'A session middleware is registered'
      : 'No session middleware found in main.ts',
    'Live, actions and forms need host sessions for identity and CSRF tokens.',
  );
  const cookie = /cookie:\s*\{([^}]*)\}/.exec(mainText)?.[1] ?? '';
  const cookieIssues = [
    ...(cookie && !/httpOnly:\s*true/.test(cookie)
      ? ['httpOnly is not true']
      : []),
    ...(cookie && !/sameSite:/.test(cookie) ? ['sameSite is not set'] : []),
    ...(cookie && !/secure:/.test(cookie) ? ['secure is not set'] : []),
  ];
  const csrfDisabled = /csrf:\s*false/.test(allSource);
  const authorizeDisabled = /requireAuthorizedActions:\s*false/.test(allSource);
  add(
    'csrf',
    csrfDisabled || authorizeDisabled
      ? 'fail'
      : cookieIssues.length
        ? 'warn'
        : 'pass',
    csrfDisabled
      ? 'CSRF protection is disabled (csrf: false)'
      : authorizeDisabled
        ? 'Action authorization is disabled (requireAuthorizedActions: false)'
        : cookieIssues.length
          ? `Session cookie: ${cookieIssues.join(', ')}`
          : 'CSRF and action authorization are enabled; session cookie flags look safe',
    'Keep security.csrf and requireAuthorizedActions enabled; use httpOnly, sameSite and secure (in production) session cookies.',
  );
  const literal = /secret:\s*['"`][^'"`]+['"`]/.test(mainText);
  const sessionSecret = process.env['SESSION_SECRET'];
  add(
    'session-secret',
    literal
      ? production
        ? 'fail'
        : 'warn'
      : sessionSecret === undefined
        ? production
          ? 'fail'
          : 'pass'
        : sessionSecret.length < 32
          ? 'fail'
          : 'pass',
    literal
      ? 'A literal session secret appears in main.ts'
      : sessionSecret === undefined
        ? production
          ? 'SESSION_SECRET is not set'
          : 'SESSION_SECRET is not set (development uses a random per-process secret)'
        : sessionSecret.length < 32
          ? `SESSION_SECRET is set but only ${sessionSecret.length} characters`
          : 'SESSION_SECRET is set (value not displayed)',
    'Load a random secret of at least 32 characters from the environment.',
  );
  const origin = process.env['NESTVEXA_ORIGIN'];
  add(
    'origin',
    origin === undefined
      ? production
        ? 'fail'
        : 'pass'
      : /^https?:\/\/[^/]+$/.test(origin)
        ? production && origin.startsWith('http:')
          ? 'warn'
          : 'pass'
        : 'fail',
    origin === undefined
      ? 'NESTVEXA_ORIGIN is not set (generated config falls back to http://localhost:3000)'
      : `NESTVEXA_ORIGIN is ${origin}`,
    'Set NESTVEXA_ORIGIN to the exact public origin (https://app.example.com).',
  );
  if (project.dependencies['@nestvexa/realtime']) {
    const secret = process.env['REALTIME_SECRET'];
    const literalSecret = /secrets:\s*\[\s*['"`]([^'"`]*)['"`]/.exec(allSource);
    const bytes = secret === undefined ? 0 : Buffer.byteLength(secret);
    add(
      'realtime-secret',
      literalSecret
        ? 'fail'
        : secret === undefined
          ? production
            ? 'fail'
            : 'warn'
          : bytes < 32
            ? 'fail'
            : 'pass',
      literalSecret
        ? 'A literal realtime signing secret appears in the source'
        : secret === undefined
          ? 'REALTIME_SECRET is not set'
          : bytes < 32
            ? `REALTIME_SECRET is ${bytes} bytes; at least 32 are required`
            : `REALTIME_SECRET is set (${bytes} bytes, value not displayed)`,
      'Set REALTIME_SECRET to a random value of at least 32 bytes; rotate by listing old secrets after the new one.',
    );
  }

  // Built frontend assets.
  const inertiaConfig = [...sources].find(([path]) =>
    path.endsWith('inertia.config.ts'),
  );
  const roots = inertiaConfig ? inertiaRoots(inertiaConfig[1]) : [];
  const missing = roots.filter(
    (key) =>
      !existsSync(join(root, 'dist', key, 'client', '.vite', 'manifest.json')),
  );
  const islands = existsSync(join(root, 'vite.islands.config.ts'));
  if (
    islands &&
    !existsSync(join(root, 'dist', 'islands', '.vite', 'manifest.json'))
  )
    missing.push('islands');
  if (roots.length || islands)
    add(
      'assets',
      missing.length ? (production ? 'fail' : 'warn') : 'pass',
      missing.length
        ? `No Vite manifest for: ${missing.join(', ')}`
        : `Vite manifests present for ${[...roots, ...(islands ? ['islands'] : [])].join(', ')}`,
      `Run \`${project.packageManager === 'npm' ? 'npm run' : `${project.packageManager} run`} build:client\` before starting in production.`,
    );

  // Development tooling must stay out of production.
  const devtools = [...sources].filter(([, text]) =>
    /DevtoolsModule\.register\(|new DevErrorFilter\(/.test(text),
  );
  const unguarded = devtools.filter(([, text]) => !text.includes('NODE_ENV'));
  if (devtools.length)
    add(
      'devtools',
      unguarded.length ? (production ? 'fail' : 'warn') : 'pass',
      unguarded.length
        ? `Development tooling without a NODE_ENV guard: ${unguarded.map(([path]) => path).join(', ')}`
        : 'Development tooling is disabled when NODE_ENV=production',
      'Register DevtoolsModule and DevErrorFilter only when NODE_ENV !== "production" (both refuse to start in production).',
    );
  return report(checks);
}
function report(checks: readonly Check[]): CommandResult {
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  return {
    ok: failed === 0,
    messages: [
      ...checks.map(
        (check) =>
          `${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}${check.status !== 'pass' && check.hint ? `\n     ${check.hint}` : ''}`,
      ),
      `${checks.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s).`,
    ],
    data: checks,
  };
}
