// Release matrix evidence (format: docs/release/evidence-formats.md).
//
//   node scripts/release-matrix.mjs entry <out.json>
//     Run as the last step of a matrix job, after every check passed.
//   node scripts/release-matrix.mjs merge <dir> [out]
//     Combine entry files into artifacts/reports/release-matrix.json.
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [mode, target, output = 'artifacts/reports/release-matrix.json'] =
  process.argv.slice(2);

async function version(name) {
  try {
    const manifest = JSON.parse(
      await readFile(join('node_modules', name, 'package.json'), 'utf8'),
    );
    return manifest.version;
  } catch {
    return null;
  }
}

if (mode === 'entry') {
  if (!target) throw new Error('entry requires an output file');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) throw new Error('git rev-parse HEAD failed');
  const entry = {
    schemaVersion: 1,
    commit: head.stdout.trim(),
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    nest: await version('@nestjs/core'),
    typescript: await version('typescript'),
    httpAdapters: ['express', 'fastify'],
    browsers: ['chromium', 'firefox', 'webkit'],
    checks: (process.env.RELEASE_MATRIX_CHECKS ?? '')
      .split(',')
      .map((check) => check.trim())
      .filter(Boolean),
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    // Written only after the job's previous steps succeeded.
    passed: true,
    timestamp: new Date().toISOString(),
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(entry, null, 2));
  console.log(`matrix entry ${entry.os}/node ${entry.node}: ${entry.commit}`);
} else if (mode === 'merge') {
  if (!target) throw new Error('merge requires an input directory');
  const environments = [];
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.name.endsWith('.json'))
        environments.push(JSON.parse(await readFile(path, 'utf8')));
    }
  };
  await walk(target);
  const commits = new Set(environments.map((entry) => entry.commit));
  const report = {
    schemaVersion: 1,
    commit: commits.size === 1 ? [...commits][0] : null,
    environments,
    passed:
      environments.length > 0 &&
      commits.size === 1 &&
      environments.every((entry) => entry.passed === true),
    timestamp: new Date().toISOString(),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    `release matrix: ${environments.length} environments, passed=${report.passed}`,
  );
  if (!report.passed) process.exitCode = 1;
} else throw new Error('Usage: release-matrix.mjs entry <file> | merge <dir>');
