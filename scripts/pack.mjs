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
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { sbomContext, writeSbom } from './sbom.mjs';
import { scanText } from './secrets.mjs';

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
    for (const target of Object.values(manifest.exports))
      if (
        typeof target === 'string' &&
        !contents.includes('package/' + target.replace(/^\.\//, ''))
      )
        throw new Error(tarball + ' missing asset export ' + target);
    // Svelte component sources (`svelte` condition) are compiled by the
    // consumer's bundler, not imported by Node; they must still be packed.
    const bundlerOnly = ([, target]) =>
      typeof target === 'object' && target !== null && 'svelte' in target;
    for (const [key, target] of Object.entries(manifest.exports).filter(
      bundlerOnly,
    ))
      for (const file of [target.svelte, target.types])
        if (
          typeof file === 'string' &&
          !contents.includes('package/' + file.replace(/^\.\//, ''))
        )
          throw new Error(tarball + ' missing ' + key + ' file ' + file);
    // Every `bin` target must be packed (the `nestvexa` and CLI binaries).
    const bins =
      typeof manifest.bin === 'string'
        ? [manifest.bin]
        : Object.values(manifest.bin ?? {});
    for (const target of bins)
      if (!contents.includes('package/' + target.replace(/^\.\//, '')))
        throw new Error(tarball + ' missing bin ' + target);
    // No credential-shaped text in any packed file (same rules as
    // `pnpm secrets:scan`); findings name the file and line, never the value.
    for (const entry of contents) {
      const buffer = await readFile(join(cwd, entry.slice('package/'.length)));
      if (buffer.includes(0)) continue;
      const findings = scanText(buffer.toString('utf8'));
      if (findings.length)
        throw new Error(
          tarball +
            ' contains credential-shaped content: ' +
            findings
              .map((finding) => entry + ':' + finding.line + ' ' + finding.rule)
              .join(', '),
        );
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
      // Static asset exports (for example @nestvexa/ui/theme.css) and Svelte
      // component sources are not Node modules; their presence is checked above.
      entryPoints: Object.entries(manifest.exports)
        .filter((entry) => typeof entry[1] !== 'string' && !bundlerOnly(entry))
        .map(([key]) =>
          key === '.' ? manifest.name : manifest.name + key.slice(1),
        ),
      assets: Object.entries(manifest.exports)
        .filter(([, target]) => typeof target === 'string')
        .map(([, target]) => target),
      tarball,
      directory: cwd,
      sha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
      contents,
    });
  }
}

/**
 * CycloneDX 1.6 SBOM per tarball from the committed lockfile, written after
 * every tarball exists so workspace siblings carry their tarball hashes.
 */
async function writeSboms() {
  const context = sbomContext(root);
  const tarballHashes = new Map(report.packages.map((p) => [p.name, p.sha256]));
  for (const entry of report.packages) {
    const sbom = await writeSbom(context, {
      dir: entry.directory,
      tarball: entry.tarball,
      tarballSha256: entry.sha256,
      timestamp: report.timestamp,
      out: resolve('artifacts/sbom'),
      tarballHashes,
    });
    entry.sbom = {
      format: 'CycloneDX 1.6 JSON',
      file: relative(root, sbom.file).replaceAll('\\', '/'),
      sha256: sbom.sha256,
      components: sbom.components,
    };
    delete entry.directory;
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
    // The generated React hooks and Vue composables run in the full consumer.
    ...(profile === 'full'
      ? { react: '19.3.1', 'react-dom': '19.3.1', vue: '3.5.44' }
      : {}),
  };
  const manifest = {
    name: 'nestvexa-' + manager + '-' + profile + '-pack-consumer',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: {
      typescript: '6.0.3',
      '@types/node': '24.19.2',
      ...(profile === 'full'
        ? { '@types/react': '19.3.0', '@types/react-dom': '19.3.0' }
        : {}),
    },
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
  // Type-checked and run by consumer.ts next to the generated action bindings.
  if (profile === 'full')
    await copyFile(
      join(root, 'tests/pack-consumers/bindings-check.ts'),
      join(consumer, 'bindings-check.ts'),
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
    { cwd: consumer, encoding: 'utf8', timeout: 180000 },
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
  // Generous limits: loaded CI/dev hosts must not turn slowness into false
  // failures. The full smoke also runs the actions codegen and type-checks the
  // generated framework bindings (two TypeScript programs); a heavily loaded
  // Windows host needed about 19 minutes for it.
  const smoke = spawnSync(process.execPath, ['dist/consumer.js'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: profile === 'full' ? 900000 : 120000,
  });
  entry.commands.push({
    command: 'node dist/consumer.js',
    exitCode: smoke.status,
  });
  if (smoke.status !== 0)
    throw new Error(
      'External ' +
        manager +
        ' smoke failed (status ' +
        String(smoke.status) +
        (smoke.error ? ', ' + smoke.error.message : '') +
        '):\n' +
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
  await writeSboms();
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
