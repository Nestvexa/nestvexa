// Extra external consumers for `pnpm test:pack` (scripts/pack.mjs). Each runs
// in a fresh temporary directory outside the workspace and installs Nestvexa
// only from the packed tarballs; nothing named nestvexa or @nestvexa/* is ever
// fetched from the registry (npm `overrides` pin every one to its tarball).
//
// - `init` (REL-004): a fresh Nest application runs `npx nestvexa init
//   --install` from the packed umbrella bin and @nestvexa/cli, then builds,
//   passes `nestvexa doctor`, boots and serves its HBS + Alpine + Live page.
// - `third-party` (MAINT-007): a view-engine adapter and an extension written
//   against the public API are compiled and packed out of tree, installed
//   next to the Nestvexa tarballs and booted (tests/pack-consumers/third-party).
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nest = {
  '@nestjs/common': '12.2.0',
  '@nestjs/core': '12.2.0',
  '@nestjs/platform-express': '12.2.0',
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
};
const types = { typescript: '6.0.3', '@types/node': '24.19.2' };
const npmInstall = [
  'exec',
  'npm',
  'install',
  '--ignore-scripts',
  '--no-fund',
  '--no-audit',
];

/**
 * An npm project manifest whose Nestvexa packages all resolve to tarballs:
 * direct dependencies reference themselves (`$name`), every other Nestvexa
 * package is overridden with its tarball.
 */
export function npmManifest(name, localPackages, fields) {
  const direct = { ...fields.dependencies, ...fields.devDependencies };
  return {
    name,
    private: true,
    type: 'module',
    ...fields,
    overrides: {
      ...Object.fromEntries(
        Object.entries(localPackages).map(([pkg, tarball]) => [
          pkg,
          Object.hasOwn(direct, pkg) ? '$' + pkg : tarball,
        ]),
      ),
      multer: '2.5.0',
    },
  };
}

/** Run a Node program; throws with its output when it fails. */
function node(args, cwd, evidence, timeout = 180000) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout,
  });
  evidence.push({
    command: 'node ' + args.join(' ').replaceAll('\\', '/'),
    exitCode: result.status,
  });
  if (result.status !== 0)
    throw new Error(
      'Command failed in ' +
        cwd +
        ': node ' +
        args.join(' ') +
        '\n' +
        [result.stdout, result.stderr, result.error?.message]
          .filter(Boolean)
          .join('\n'),
    );
  return result.stdout;
}
const tsc = (cwd, project, evidence) =>
  node(
    [join(cwd, 'node_modules/typescript/bin/tsc'), '-p', project],
    cwd,
    evidence,
  );

/** NESTVEXA_PACK_PORT, else a port the OS reports free. */
async function port() {
  if (process.env.NESTVEXA_PACK_PORT)
    return Number(process.env.NESTVEXA_PACK_PORT);
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? done(address.port)
          : fail(new Error('No free port')),
      );
    });
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** REL-004: `npx nestvexa init` from the packed bin in a fresh Nest app. */
export async function initConsumer({ root, command, localPackages, entry }) {
  const app = await mkdtemp(join(tmpdir(), 'nestvexa-npm-init-app-'));
  entry.directory = app;
  // The files `nest new` creates (strict ESM variant), before Nestvexa.
  const fixture = join(root, 'tests/pack-consumers/init-app');
  await cp(join(fixture, 'src'), join(app, 'src'), { recursive: true });
  await copyFile(join(fixture, 'tsconfig.json'), join(app, 'tsconfig.json'));
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify(
      npmManifest('nestvexa-init-app', localPackages, {
        scripts: { build: 'tsc -p tsconfig.json' },
        // `npm install nestvexa` and `npm install -D @nestvexa/cli`, from tarballs.
        dependencies: { ...nest, nestvexa: localPackages['nestvexa'] },
        devDependencies: {
          ...types,
          '@nestvexa/cli': localPackages['@nestvexa/cli'],
        },
      }),
      null,
      2,
    ),
  );
  command(npmInstall, app, entry.commands);
  // `--no`: npx must run the installed bin and never download a package.
  const init = command(
    ['exec', 'npx', '--no', 'nestvexa', 'init', '--install'],
    app,
    entry.commands,
  );
  check(
    init.includes('Nestvexa is configured') &&
      init.includes('Dependencies installed.'),
    'nestvexa init did not configure and install:\n' + init,
  );
  const manifest = JSON.parse(
    await readFile(join(app, 'package.json'), 'utf8'),
  );
  check(
    manifest.dependencies.nestvexa === localPackages['nestvexa'] &&
      typeof manifest.dependencies['express-session'] === 'string' &&
      typeof manifest.devDependencies['@types/express-session'] === 'string',
    'init changed the nestvexa dependency or did not add the session packages',
  );
  const module = await readFile(join(app, 'src/app.module.ts'), 'utf8');
  check(
    module.includes('NestvexaModule.forRoot(nestvexaOptions, nestvexaLive)') &&
      module.includes('AppController'),
    'init did not patch the existing app module:\n' + module,
  );
  command(['exec', 'npm', 'run', 'build'], app, entry.commands);
  const doctor = command(
    ['exec', 'npx', '--no', 'nestvexa', 'doctor', '--json'],
    app,
    entry.commands,
  );
  const checks = JSON.parse(doctor.trim().split(/\r?\n/).at(-1) ?? '{}').data;
  const statuses = Object.fromEntries(
    (Array.isArray(checks) ? checks : []).map((item) => [
      item.name,
      item.status,
    ]),
  );
  for (const name of ['nest', 'nestvexa', 'configure', 'session', 'layout'])
    check(
      statuses[name] === 'pass',
      `doctor ${name}: ${statuses[name]}\n${doctor}`,
    );

  const listen = await port();
  const origin = `http://127.0.0.1:${listen}`;
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: app,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(listen),
      NESTVEXA_ORIGIN: origin,
    },
  });
  let logs = '';
  child.stdout.on('data', (chunk) => (logs += chunk));
  child.stderr.on('data', (chunk) => (logs += chunk));
  const started = Date.now();
  try {
    let ready = false;
    // Cold module loading is slow on loaded Windows hosts.
    while (!ready && child.exitCode === null && Date.now() - started < 180000) {
      await new Promise((done) => setTimeout(done, 200));
      ready = await fetch(origin).then(
        (response) => response.ok,
        () => false,
      );
    }
    check(
      ready,
      `The generated app did not start (exit ${child.exitCode}):\n${logs}`,
    );
    entry.commands.push({ command: 'node dist/src/main.js', exitCode: null });
    // Existing routes are untouched.
    check(
      (await (await fetch(origin)).text()) === 'Hello World!',
      'GET / changed',
    );
    const page = await fetch(`${origin}/nestvexa`);
    const html = await page.text();
    check(page.status === 200, `GET /nestvexa: ${page.status}\n${html}`);
    check(html.startsWith('<!doctype html>'), 'The layout was not applied');
    check(html.includes('<h1>Nestvexa is ready</h1>'), 'Welcome view missing');
    check(html.includes('data-nv-name="counter"'), 'Live counter missing');
    const boot = /<script type="module" src="([^"]+boot\.js)"><\/script>/.exec(
      html,
    )?.[1];
    check(boot, 'Boot script tag missing');
    const script = await fetch(origin + boot);
    const source = await script.text();
    check(
      script.status === 200 && source.includes('startLiveAlpine(Alpine'),
      'The boot script does not start Alpine with Live',
    );
    const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
    const csrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1] ?? '';
    check(
      cookie && snapshot && csrf,
      'Session cookie, snapshot or CSRF token missing',
    );
    const action = (token) =>
      fetch(`${origin}/_nestvexa/live/counter/increment`, {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': token,
        },
        body: JSON.stringify({
          protocol: 'nestvexa-live/1',
          requestId: randomUUID(),
          snapshot,
          revision: 0,
          updates: {},
          input: null,
        }),
      });
    check(
      (await action('forged')).status === 403,
      'A forged CSRF token was accepted',
    );
    const updated = await action(csrf);
    check(updated.status === 201, `Live action: ${updated.status}`);
    const result = await updated.json();
    check(result?.state?.count === 1, 'The Live counter did not increment');
  } finally {
    child.kill();
  }
  entry.passed = true;
  return 'npx nestvexa init --install in a fresh Nest app built, passed doctor, booted and served HBS + Alpine + Live from the packed tarballs.';
}

/** MAINT-007: out-of-tree adapter and extension packages from their own tarballs. */
export async function thirdPartyConsumer({
  root,
  command,
  localPackages,
  entry,
}) {
  const fixture = join(root, 'tests/pack-consumers/third-party');
  // 1. The third-party author's checkout: build and pack both packages
  //    against the packed Nestvexa declarations.
  const author = await mkdtemp(join(tmpdir(), 'nestvexa-third-party-author-'));
  for (const name of ['engine', 'extension']) {
    await mkdir(join(author, name, 'src'), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json', 'src/index.ts'])
      await copyFile(join(fixture, name, file), join(author, name, file));
  }
  await writeFile(
    join(author, 'package.json'),
    JSON.stringify(
      npmManifest('nestvexa-third-party-author', localPackages, {
        devDependencies: {
          '@nestvexa/core': localPackages['@nestvexa/core'],
          '@nestvexa/views': localPackages['@nestvexa/views'],
          ...nest,
          ...types,
        },
      }),
      null,
      2,
    ),
  );
  command(npmInstall, author, entry.commands);
  for (const name of ['engine', 'extension'])
    tsc(author, join(name, 'tsconfig.json'), entry.commands);
  command(
    [
      'exec',
      'npm',
      'pack',
      './engine',
      './extension',
      '--pack-destination',
      '.',
    ],
    author,
    entry.commands,
  );
  const tarballs = {
    'nestvexa-engine-mini': join(author, 'nestvexa-engine-mini-1.0.0.tgz'),
    'nestvexa-extension-mini': join(
      author,
      'nestvexa-extension-mini-1.0.0.tgz',
    ),
  };
  for (const tarball of Object.values(tarballs)) {
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    check(
      listing.status === 0,
      'Cannot inspect ' + tarball + ': ' + listing.stderr,
    );
    const files = listing.stdout.trim().split(/\r?\n/);
    check(
      files.includes('package/dist/index.js') &&
        files.includes('package/dist/index.d.ts') &&
        !files.some((file) => file.startsWith('package/src/')),
      tarball + ' has unexpected contents: ' + files.join(', '),
    );
  }

  // 2. An application that installs them from those tarballs only.
  const consumer = await mkdtemp(
    join(tmpdir(), 'nestvexa-npm-third-party-consumer-'),
  );
  entry.directory = consumer;
  const file = (path) => 'file:' + path.replaceAll('\\', '/');
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      npmManifest('nestvexa-npm-third-party-consumer', localPackages, {
        dependencies: {
          ...nest,
          '@nestvexa/core': localPackages['@nestvexa/core'],
          '@nestvexa/views': localPackages['@nestvexa/views'],
          '@nestvexa/live': localPackages['@nestvexa/live'],
          'nestvexa-engine-mini': file(tarballs['nestvexa-engine-mini']),
          'nestvexa-extension-mini': file(tarballs['nestvexa-extension-mini']),
        },
        devDependencies: types,
      }),
      null,
      2,
    ),
  );
  await copyFile(join(fixture, 'consumer.ts'), join(consumer, 'consumer.ts'));
  await copyFile(
    join(root, 'tests/pack-consumers/tsconfig.json'),
    join(consumer, 'tsconfig.json'),
  );
  await mkdir(join(consumer, 'views'));
  await writeFile(
    join(consumer, 'views/layout.mini'),
    '<!doctype html><main>{{ body }}</main>',
  );
  await writeFile(
    join(consumer, 'views/home.mini'),
    '<h1>{{ title }}</h1><p>tenant {{ tenant }}</p>{{ widget }}',
  );
  await writeFile(
    join(consumer, 'views/counter.mini'),
    '<output>{{ count }}</output>',
  );
  command(npmInstall, consumer, entry.commands);
  tsc(consumer, 'tsconfig.json', entry.commands);
  const output = node(['dist/consumer.js'], consumer, entry.commands, 300000);
  entry.passed = true;
  return output.trim();
}
