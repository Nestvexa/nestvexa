import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * examples/showcase `pnpm seed` and `pnpm reset` (the compiled scripts in
 * dist/scripts, built by `pnpm build`), each run in its own temporary data
 * directory without Redis or S3.
 */
const example = fileURLToPath(
  new URL('../examples/showcase/', import.meta.url),
);
const scripts = join(example, 'dist/scripts');

function run(
  script: 'seed' | 'reset',
  dataDir: string,
  extra: string[] = [],
  env: Record<string, string> = {},
) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean))
    if (/^(REDIS_|S3_|SHOWCASE_|SESSION_STORE)/.test(name)) delete clean[name];
  return spawnSync(
    process.execPath,
    [join(scripts, `${script}.js`), ...extra],
    {
      cwd: example,
      env: { ...clean, SHOWCASE_DATA_DIR: dataDir, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
}
interface State {
  version: number;
  tasks: { id: string; title: string; workspace: string }[];
  goals: unknown[];
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as State;

// Each case starts several Node processes (they load @nestjs/common).
describe('showcase seed and reset scripts', { timeout: 240_000 }, () => {
  let dataDir = '';
  let dataFile = '';
  beforeEach(() => {
    if (!existsSync(join(scripts, 'seed.js')))
      throw new Error(
        'Build the showcase first: pnpm --filter @nestvexa/example-showcase... build',
      );
    dataDir = mkdtempSync(join(tmpdir(), 'nestvexa-showcase-scripts-'));
    dataFile = join(dataDir, 'showcase.json');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('seeds deterministic data for both workspaces into an empty directory', () => {
    const result = run('seed', dataDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Seeded \d+ tasks and \d+ goals into /);
    const state = read(dataFile);
    expect(state.version).toBe(1);
    expect(new Set(state.tasks.map((task) => task.workspace))).toEqual(
      new Set(['harbor', 'summit']),
    );
    expect(state.goals.length).toBeGreaterThan(0);
    // Deterministic: a second directory gets byte-identical data.
    const other = mkdtempSync(join(tmpdir(), 'nestvexa-showcase-scripts-'));
    try {
      expect(run('seed', other).status).toBe(0);
      expect(readFileSync(join(other, 'showcase.json'), 'utf8')).toBe(
        readFileSync(dataFile, 'utf8'),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing data without --force, and overwrites with it', () => {
    expect(run('seed', dataDir).status).toBe(0);
    const state = read(dataFile);
    state.tasks.push({ id: 'tx', title: 'Local change', workspace: 'harbor' });
    writeFileSync(dataFile, JSON.stringify(state));
    const refused = run('seed', dataDir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already exists');
    expect(read(dataFile).tasks.map((task) => task.title)).toContain(
      'Local change',
    );
    const forced = run('seed', dataDir, ['--force']);
    expect(forced.status).toBe(0);
    expect(read(dataFile).tasks.map((task) => task.title)).not.toContain(
      'Local change',
    );
  });

  it('reset removes data, sessions and local uploads, then writes fresh seed data', () => {
    expect(run('seed', dataDir).status).toBe(0);
    const fresh = readFileSync(dataFile, 'utf8');
    const state = read(dataFile);
    state.tasks = [];
    writeFileSync(dataFile, JSON.stringify(state));
    mkdirSync(join(dataDir, 'uploads', 'objects'), { recursive: true });
    writeFileSync(join(dataDir, 'uploads', 'objects', 'file.bin'), 'upload');
    writeFileSync(join(dataDir, 'sessions.json'), '{}');
    const outside = join(
      dataDir,
      '..',
      `${dataDir.split(/[\\/]/).pop() ?? 'x'}-keep.txt`,
    );
    writeFileSync(outside, 'not ours');
    try {
      const result = run('reset', dataDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Removed data, sessions and local uploads',
      );
      expect(result.stdout).toContain('Wrote fresh seed data.');
      expect(result.stdout).not.toContain('Redis');
      expect(existsSync(join(dataDir, 'uploads'))).toBe(false);
      expect(existsSync(join(dataDir, 'sessions.json'))).toBe(false);
      expect(readFileSync(dataFile, 'utf8')).toBe(fresh);
      // Nothing outside the data directory is touched.
      expect(readFileSync(outside, 'utf8')).toBe('not ours');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('fails before touching anything when the configuration is invalid', () => {
    expect(run('seed', dataDir).status).toBe(0);
    const before = readFileSync(dataFile, 'utf8');
    // A partial S3 configuration is refused at startup.
    const partial = run('reset', dataDir, [], {
      S3_ENDPOINT: 'http://127.0.0.1:1',
    });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('S3 storage is partially configured');
    // An invalid Redis key prefix is refused (it scopes the keys reset deletes).
    const prefix = run('reset', dataDir, [], {
      REDIS_PORT: '6399',
      REDIS_PREFIX: '*',
    });
    expect(prefix.status).not.toBe(0);
    expect(prefix.stderr).toContain('REDIS_PREFIX');
    expect(readFileSync(dataFile, 'utf8')).toBe(before);
  });
});
