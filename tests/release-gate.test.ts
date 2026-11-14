import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// REL-035 / REL-021: `pnpm release:check` is the last gate before the owner's
// publish approval. These tests run the real script against a fixture
// workspace whose evidence is complete, then remove or weaken one piece of
// evidence at a time and require the gate to refuse.

const repository = resolve(import.meta.dirname, '..');
const sha256 = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex');
const commit = 'a'.repeat(40);
const tarballSha = 'b'.repeat(64);

type Json = Record<string, unknown>;
type Mutation = (files: Map<string, Json>) => void;

function evidence(): Map<string, Json> {
  const sbom: Json = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: {
      component: { hashes: [{ alg: 'SHA-256', content: tarballSha }] },
    },
    components: [],
  };
  const environments = ['linux', 'win32'].flatMap((os) =>
    ['22.23.4', '24.22.1'].map((node) => ({ os, node, commit, passed: true })),
  );
  return new Map<string, Json>([
    [
      'docs/implementation/progress.json',
      {
        phases: Array.from({ length: 18 }, (_, id) => ({ id, state: 'Done' })),
      },
    ],
    [
      'artifacts/reports/vitest.json',
      {
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        numTotalTests: 1,
      },
    ],
    [
      'artifacts/reports/playwright.json',
      { stats: { unexpected: 0, skipped: 0, expected: 1 } },
    ],
    ['artifacts/sbom/nestvexa-1.0.0.cdx.json', sbom],
    [
      'artifacts/reports/pack.json',
      {
        passed: true,
        consumers: [
          { manager: 'npm', passed: true },
          { manager: 'pnpm', passed: true },
        ],
        packages: [
          {
            name: 'nestvexa',
            version: '1.0.0',
            sha256: tarballSha,
            sbom: { file: 'artifacts/sbom/nestvexa-1.0.0.cdx.json' },
          },
        ],
      },
    ],
    [
      'artifacts/reports/release-matrix.json',
      { passed: true, commit, environments },
    ],
    [
      'artifacts/reports/security-review.json',
      {
        schemaVersion: 1,
        reviewedCommit: commit,
        reviewers: [
          {
            name: 'Fixture reviewer',
            organization: 'Fixture',
            independent: true,
          },
        ],
        findings: [{ id: 'NV-1', severity: 'P2', status: 'fixed' }],
        openP0: 0,
        openP1: 0,
        approved: true,
      },
    ],
    [
      'artifacts/reports/load.json',
      {
        passed: true,
        config: { latencyGate: 'enforce' },
        realtimeHub: { passed: true },
        memory: [{ passed: true }],
      },
    ],
  ]);
}

async function runGate(mutate: Mutation = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-release-gate-'));
  try {
    await mkdir(join(root, 'scripts'));
    for (const script of ['release-check.mjs', 'ledger.mjs'])
      await copyFile(
        join(repository, 'scripts', script),
        join(root, 'scripts', script),
      );
    // A source with no requirement units and a matching empty ledger: the
    // ledger gate passes, so every refusal below comes from the evidence.
    const source = '# Fixture specification\n';
    await writeFile(
      join(root, 'NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md'),
      source,
    );
    const files = evidence();
    files.set('docs/implementation/feature-ledger.json', {
      schemaVersion: 1,
      sourceSha256: sha256(source),
      features: [],
    });
    mutate(files);
    const sbomPath = 'artifacts/sbom/nestvexa-1.0.0.cdx.json';
    for (const [path, value] of files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      const text = JSON.stringify(value, null, 2);
      await writeFile(join(root, path), text);
      if (path === sbomPath) {
        const pack = files.get('artifacts/reports/pack.json');
        const entry = (pack?.['packages'] as Json[] | undefined)?.[0];
        const sbom = entry?.['sbom'] as Json | undefined;
        if (sbom && !('sha256' in sbom)) sbom['sha256'] = sha256(text);
      }
    }
    // pack.json is written after the SBOM hash is known.
    const pack = files.get('artifacts/reports/pack.json');
    if (pack)
      await writeFile(
        join(root, 'artifacts/reports/pack.json'),
        JSON.stringify(pack, null, 2),
      );
    else await rm(join(root, 'artifacts/reports/pack.json'), { force: true });
    const result = spawnSync(process.execPath, ['scripts/release-check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const report = JSON.parse(
      await readFile(
        join(root, 'artifacts/reports/release-check.json'),
        'utf8',
      ),
    ) as { ready: boolean; failures: string[]; publicationAuthorized: boolean };
    return { status: result.status, stdout: result.stdout, report };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const review = (files: Map<string, Json>) => {
  const value = files.get('artifacts/reports/security-review.json');
  if (!value) throw new Error('fixture lacks security-review.json');
  return value;
};

describe('release-check gate', () => {
  it('passes complete evidence but never authorizes publication', async () => {
    const { status, stdout, report } = await runGate();
    expect(report.failures).toEqual([]);
    expect(status).toBe(0);
    expect(stdout).toContain('READY FOR OWNER RELEASE REVIEW');
    expect(stdout).toContain('no publication performed or authorized');
    expect(report.ready).toBe(true);
    expect(report.publicationAuthorized).toBe(false);
  });

  const refusals: readonly (readonly [string, Mutation, string])[] = [
    [
      'the owner-supplied security review is missing',
      (files) => files.delete('artifacts/reports/security-review.json'),
      'Missing readable evidence: artifacts/reports/security-review.json',
    ],
    [
      'no reviewer is independent (an internal review)',
      (files) => {
        review(files)['reviewers'] = [
          { name: 'Internal', organization: 'Nestvexa', independent: false },
        ];
      },
      'Failed or incomplete evidence: artifacts/reports/security-review.json',
    ],
    [
      'the review has an open P1',
      (files) => {
        review(files)['openP1'] = 1;
      },
      'Failed or incomplete evidence: artifacts/reports/security-review.json',
    ],
    [
      'a P0 finding is only accepted, not fixed',
      (files) => {
        review(files)['findings'] = [
          { id: 'NV-2', severity: 'P0', status: 'accepted' },
        ];
      },
      'Failed or incomplete evidence: artifacts/reports/security-review.json',
    ],
    [
      'the review is not approved',
      (files) => {
        review(files)['approved'] = false;
      },
      'Failed or incomplete evidence: artifacts/reports/security-review.json',
    ],
    [
      'the review names no exact commit',
      (files) => {
        review(files)['reviewedCommit'] = 'main';
      },
      'Failed or incomplete evidence: artifacts/reports/security-review.json',
    ],
    [
      'an SBOM does not hash the tarball',
      (files) => {
        files.set('artifacts/sbom/nestvexa-1.0.0.cdx.json', {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          metadata: { component: { hashes: [] } },
          components: [],
        });
      },
      'Failed or incomplete evidence: artifacts/reports/pack.json',
    ],
    [
      'the SBOM file changed after pack.json recorded it',
      (files) => {
        const pack = files.get('artifacts/reports/pack.json');
        const entry = (pack?.['packages'] as Json[])[0];
        if (entry)
          entry['sbom'] = {
            file: 'artifacts/sbom/nestvexa-1.0.0.cdx.json',
            sha256: '0'.repeat(64),
          };
      },
      'Failed or incomplete evidence: artifacts/reports/pack.json',
    ],
    [
      'the matrix never ran on Windows',
      (files) => {
        const matrix = files.get('artifacts/reports/release-matrix.json');
        if (matrix)
          matrix['environments'] = (matrix['environments'] as Json[]).filter(
            (environment) => environment['os'] !== 'win32',
          );
      },
      'Failed or incomplete evidence: artifacts/reports/release-matrix.json',
    ],
    [
      'load latency budgets were only advisory',
      (files) => {
        const load = files.get('artifacts/reports/load.json');
        if (load) load['config'] = { latencyGate: 'advisory' };
      },
      'Failed or incomplete evidence: artifacts/reports/load.json',
    ],
    [
      'a test was skipped',
      (files) => {
        files.set('artifacts/reports/playwright.json', {
          stats: { unexpected: 0, skipped: 1, expected: 1 },
        });
      },
      'Failed or incomplete evidence: artifacts/reports/playwright.json',
    ],
    [
      'a phase is not Done',
      (files) => {
        files.set('docs/implementation/progress.json', {
          phases: Array.from({ length: 18 }, (_, id) => ({
            id,
            state: id === 17 ? 'InProgress' : 'Done',
          })),
        });
      },
      'Phase 17: InProgress',
    ],
  ];
  it.each(refusals)('refuses when %s', async (_, mutate, failure) => {
    const { status, report } = await runGate(mutate);
    expect(status).toBe(1);
    expect(report.ready).toBe(false);
    expect(report.publicationAuthorized).toBe(false);
    expect(report.failures).toContain(failure);
  });

  it('refuses an incomplete requirement ledger', async () => {
    const { status, report } = await runGate((files) => {
      files.set('docs/implementation/feature-ledger.json', {
        sourceSha256: '0'.repeat(64),
        features: [],
      });
    });
    expect(status).toBe(1);
    expect(report.failures).toContain(
      'Requirement ledger has missing evidence or incomplete requirements.',
    );
  });
});

describe('repository release posture', () => {
  it('commits no security-review evidence, so the real gate refuses today', () => {
    // Only the owner may add this file, after an independent review.
    expect(
      existsSync(
        join(repository, 'docs/release/evidence/security-review.json'),
      ),
    ).toBe(false);
  });

  const jobs = (text: string) => {
    const body = text.slice(text.indexOf('\njobs:\n'));
    const found = new Map<string, string>();
    const pattern = /^ {2}([\w-]+):\n/gm;
    const starts = [...body.matchAll(pattern)];
    for (const [index, match] of starts.entries()) {
      const name = match[1];
      if (name === undefined) continue;
      found.set(
        name,
        body.slice(match.index, starts[index + 1]?.index ?? body.length),
      );
    }
    return found;
  };

  it('publishes only from the approved release job with OIDC provenance', async () => {
    const text = await readFile(
      join(repository, '.github/workflows/release.yml'),
      'utf8',
    );
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    const workflowJobs = jobs(text);
    expect([...workflowJobs.keys()]).toEqual(['matrix', 'verify', 'publish']);
    for (const [name, job] of workflowJobs) {
      expect(job, name).toContain('persist-credentials: false');
      if (name !== 'publish') expect(job, name).not.toContain('id-token');
    }
    const verify = workflowJobs.get('verify') ?? '';
    const copy = verify.indexOf(
      'cp docs/release/evidence/security-review.json artifacts/reports/security-review.json',
    );
    expect(copy).toBeGreaterThan(0);
    expect(verify.indexOf('pnpm release:check')).toBeGreaterThan(copy);
    const publish = workflowJobs.get('publish') ?? '';
    expect(publish).toContain('needs: verify');
    expect(publish).toContain('environment: npm-release');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain(
      'scripts/release-publish.mjs --tag "$TAG" --dry-run',
    );
    // The dry run is the default; a real publish needs an explicit false.
    expect(text).toMatch(/dry_run:[\s\S]*?default: true/);
  });

  it('keeps the scheduled dry run unable to publish', async () => {
    const text = await readFile(
      join(repository, '.github/workflows/release-dry-run.yml'),
      'utf8',
    );
    // Comments explain why these are absent; only the YAML itself counts.
    const yaml = text
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(yaml).not.toMatch(
      /id-token|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|environment:/,
    );
    expect(text).toMatch(/permissions:\n {2}contents: read\n/);
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain('pnpm release:dry-run --pack');
  });
});

describe('release paths carry no stubs or skipped tests', () => {
  // REL-026 / LEDGER-025: a repository-wide check, not only for the ledger's
  // Done evidence. A conditional Playwright skip with a reason is
  // allowed in specs (it still counts as skipped in the release gate).
  const walk = async (directory: string, suffix: RegExp): Promise<string[]> => {
    const { readdir } = await import('node:fs/promises');
    const found: string[] = [];
    for (const entry of await readdir(join(repository, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'fixtures'].includes(entry.name))
          found.push(...(await walk(path, suffix)));
      } else if (suffix.test(entry.name)) found.push(path);
    }
    return found;
  };
  const offending = async (files: string[], pattern: RegExp) => {
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(join(repository, file), 'utf8');
      for (const [index, line] of text.split(/\r?\n/).entries())
        if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
    }
    return hits;
  };

  it('has no TODO/FIXME markers or not-implemented throws in package sources and release scripts', async () => {
    const packages = await walk('packages', /\.(?:ts|tsx|mts|svelte|vue)$/);
    // ledger.mjs is the stub detector itself; its self-test fixture contains
    // the not-implemented throw it must reject.
    const scripts = (await walk('scripts', /\.mjs$/)).filter(
      (file) => file !== 'scripts/ledger.mjs',
    );
    expect(packages.length).toBeGreaterThan(100);
    expect(
      await offending(
        [...packages, ...scripts],
        /\b(?:TODO|FIXME)\b|throw\s+new\s+Error\(\s*['"`]not implemented/i,
      ),
    ).toEqual([]);
  }, 180_000);

  it('has no skipped, focused or todo vitest tests and no focused browser tests', async () => {
    const unit = await walk('tests', /\.test\.ts$/);
    const browser = await walk('tests', /\.spec\.ts$/);
    expect(
      await offending(unit, /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(/),
    ).toEqual([]);
    expect(
      await offending(browser, /\b(?:test|describe)\.(?:only|fixme)\s*\(/),
    ).toEqual([]);
  }, 180_000);
});
