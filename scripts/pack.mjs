import { spawnSync } from 'node:child_process';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  mkdtemp,
  access,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const pnpm = process.env.npm_execpath;
if (!pnpm)
  throw new Error(
    'Run with pnpm test:pack so the package manager entry is explicit.',
  );
const root = process.cwd();
const directory = resolve('artifacts/packages');
const reportPath = resolve('artifacts/reports/pack.json');
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  passed: false,
  packages: [],
  consumers: [],
};

// Never pass generated paths through a command shell; pnpm's Node entry performs executable lookup.
function command(args, cwd, evidence) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd,
    encoding: 'utf8',
    // Full-profile consumers also install the frontend adapters' peers
    // (React, Vue, Svelte and the official Inertia clients) from the registry.
    timeout: 600000,
  });
  evidence?.push({
    command: 'pnpm ' + args.join(' '),
    exitCode: result.status,
    milliseconds: Math.round(performance.now() - start),
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n')
      .replace(/npm_[A-Za-z0-9]+/g, '[redacted npm token]');
    throw new Error(
      'Package command failed: pnpm ' + args.join(' ') + '\n' + output,
    );
  }
  return result.stdout;
}

async function packPackages() {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir('packages')) {
    const cwd = resolve('packages', name);
    const manifest = JSON.parse(
      await readFile(join(cwd, 'package.json'), 'utf8'),
    );
    if (manifest.private) continue;
    // Missing build output is a failure, never an excuse to silently omit a package.
    await access(join(cwd, 'dist/index.js'));
    await copyFile('LICENSE', join(cwd, 'LICENSE'));
    if (manifest.name === 'nestvexa')
      await copyFile(
        'THIRD_PARTY_NOTICES.md',
        join(cwd, 'THIRD_PARTY_NOTICES.md'),
      );
    command(['pack', '--pack-destination', directory], cwd);
    const tarball = join(
      directory,
      manifest.name.replace('@', '').replace('/', '-') +
        '-' +
        manifest.version +
        '.tgz',
    );
    const archive = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    if (archive.status !== 0)
      throw new Error(
        'Cannot inspect tarball ' + tarball + ': ' + archive.stderr,
      );
    const contents = archive.stdout.trim().split(/\r?\n/);
    for (const required of [
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      ...(manifest.name === 'nestvexa'
        ? ['package/THIRD_PARTY_NOTICES.md']
        : []),
    ]) {
      if (!contents.includes(required))
        throw new Error(tarball + ' missing ' + required);
    }
    if (
      /^package\/(?:src|tests|node_modules)\/|(?:^|\/)\.env(?:\.|$)/m.test(
        archive.stdout,
      )
    )
      throw new Error('Unexpected private or repository files in ' + tarball);
    report.packages.push({
      name: manifest.name,
      version: manifest.version,
      entryPoints: Object.keys(manifest.exports).map((key) =>
        key === '.' ? manifest.name : manifest.name + key.slice(1),
      ),
      tarball,
      sha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
      contents,
    });
  }
}

async function consume(manager, profile) {
  const consumer = await mkdtemp(
    join(tmpdir(), 'nestvexa-' + manager + '-' + profile + '-consumer-'),
  );
  const entry = {
    manager,
    profile,
    directory: consumer,
    passed: false,
    commands: [],
  };
  report.consumers.push(entry);
  const localPackages = Object.fromEntries(
    report.packages.map((p) => [
      p.name,
      'file:' + p.tarball.replaceAll('\\', '/'),
    ]),
  );
  const dependencies = {
    ...(profile === 'minimal'
      ? { nestvexa: localPackages['nestvexa'] }
      : localPackages),
    '@nestjs/common': '12.2.0',
    '@nestjs/core': '12.2.0',
    '@nestjs/platform-express': '12.2.0',
    'reflect-metadata': '0.2.2',
    rxjs: '7.8.2',
  };
  const manifest = {
    name: 'nestvexa-' + manager + '-' + profile + '-pack-consumer',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: { typescript: '6.0.3', '@types/node': '24.19.2' },
    ...(manager === 'pnpm'
      ? { pnpm: { overrides: { ...localPackages, multer: '2.5.0' } } }
      : {
          overrides: {
            ...Object.fromEntries(
              Object.entries(localPackages).map(([name, tarball]) => [
                name,
                Object.hasOwn(dependencies, name) ? '$' + name : tarball,
              ]),
            ),
            multer: '2.5.0',
          },
        }),
  };
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(manifest, null, 2),
  );
  await copyFile(
    join(
      root,
      'tests/pack-consumers',
      profile === 'minimal' ? 'assets.ts' : 'consumer.ts',
    ),
    join(consumer, 'consumer.ts'),
  );
  await copyFile(
    join(root, 'tests/pack-consumers/tsconfig.json'),
    join(consumer, 'tsconfig.json'),
  );
  await mkdir(join(consumer, 'views'));
  await writeFile(
    join(consumer, 'views/home.hbs'),
    '<h1>{{message}}</h1>{{{widget}}}',
  );
  await writeFile(
    join(consumer, 'views/counter.hbs'),
    '<output>{{count}}</output><b>{{doubled}}</b>',
  );
  if (profile === 'minimal') {
    await writeFile(
      join(consumer, 'views/default-home.hbs'),
      '<h1>{{message}}</h1>{{{widget}}}',
    );
    await writeFile(
      join(consumer, 'views/default-counter.hbs'),
      '<output>{{count}}</output>',
    );
    await writeFile(
      join(consumer, 'views/default-layout.hbs'),
      '<!doctype html><html lang="en"><head><title>Default packed setup</title></head><body>{{{body}}}{{nvScripts}}</body></html>',
    );
  }
  const install =
    manager === 'pnpm'
      ? ['install', '--ignore-scripts']
      : [
          'exec',
          'npm',
          'install',
          '--ignore-scripts',
          '--no-fund',
          '--no-audit',
        ];
  command(install, consumer, entry.commands);
  // The compiler must resolve declarations exclusively from the external tarball install.
  const compilation = spawnSync(
    process.execPath,
    [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: consumer, encoding: 'utf8', timeout: 60000 },
  );
  entry.commands.push({
    command: 'node node_modules/typescript/bin/tsc -p tsconfig.json',
    exitCode: compilation.status,
  });
  if (compilation.status !== 0)
    throw new Error(
      'External ' +
        manager +
        ' TypeScript failed:\n' +
        compilation.stdout +
        '\n' +
        compilation.stderr,
    );
  const smoke = spawnSync(process.execPath, ['dist/consumer.js'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 30000,
  });
  entry.commands.push({
    command: 'node dist/consumer.js',
    exitCode: smoke.status,
  });
  if (smoke.status !== 0)
    throw new Error(
      'External ' +
        manager +
        ' smoke failed:\n' +
        smoke.stdout +
        '\n' +
        smoke.stderr,
    );
  // All public package entries, including optional adapters, must be safe to import in Node.
  await writeFile(
    join(consumer, 'imports.mjs'),
    (profile === 'minimal'
      ? ['nestvexa', 'nestvexa/assets']
      : report.packages.flatMap((p) => p.entryPoints)
    )
      .map((name) => 'await import(' + JSON.stringify(name) + ');')
      .join('\n'),
  );
  // Cold first loads of every entry (including React, Vue and Svelte peers of
  // the frontend adapters) can exceed 30 s on Windows hosts with file scanning.
  const imports = spawnSync(process.execPath, ['imports.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 120000,
  });
  entry.commands.push({
    command: 'node imports.mjs',
    exitCode: imports.status,
  });
  if (imports.status !== 0)
    throw new Error(
      'External ' +
        manager +
        ' entry import failed:\n' +
        imports.stdout +
        '\n' +
        imports.stderr,
    );
  entry.passed = true;
  console.log(manager + ' ' + profile + ': ' + smoke.stdout.trim());
}

await mkdir('artifacts/reports', { recursive: true });
try {
  await packPackages();
  for (const manager of ['pnpm', 'npm'])
    for (const profile of ['full', 'minimal']) await consume(manager, profile);
  report.passed = true;
  console.log(
    'Inspected ' +
      report.packages.length +
      ' tarballs; npm/pnpm full MVC/Live and minimal umbrella-only default setup consumers passed.',
  );
} catch (error) {
  report.error =
    error instanceof Error
      ? error.message
      : 'Unknown package verification failure';
  throw error;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
