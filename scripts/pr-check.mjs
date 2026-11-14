import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseChangeset } from './release-notes.mjs';

/**
 * Pull-request policy (MAINT-010), run by the `pr-policy` job of ci.yml on
 * `pull_request` only:
 *
 * 1. the PR title is a Conventional Commit (`type(scope)!: subject`), because
 *    squash merges use it as the commit message;
 * 2. every published package whose `src/` the PR changes is named by a
 *    changeset the PR adds or edits, unless the PR has the `no-changeset`
 *    label (internal refactors, tests-only behaviour, docs in src comments).
 *
 * Inputs come from the environment so the workflow never interpolates
 * untrusted PR text into a shell command: PR_TITLE, PR_LABELS (JSON array of
 * names), PR_BASE_SHA and optionally PR_HEAD_SHA (default HEAD).
 */
export const commitTypes = Object.freeze([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]);
export const skipLabel = 'no-changeset';
const titlePattern = new RegExp(
  '^(?:' +
    commitTypes.join('|') +
    ')(?:\\([a-z0-9][a-z0-9._/-]{0,39}\\))?!?: \\S',
);

/** Problems with a PR title; empty when it is a Conventional Commit header. */
export function checkTitle(title) {
  if (typeof title !== 'string' || !title.trim())
    return ['The pull request has no title.'];
  // GitHub's own revert PRs: Revert "feat(live): ...".
  const reverted = /^Revert "(.+)"$/.exec(title);
  const header = reverted?.[1] ?? title;
  const errors = [];
  if (!titlePattern.test(header))
    errors.push(
      'The title must be a Conventional Commit, for example "feat(live): add polling" or "fix!: reject empty names". Types: ' +
        commitTypes.join(', ') +
        '; the optional scope is lowercase.',
    );
  if (title.length > 100)
    errors.push('The title must be at most 100 characters.');
  if (/\.\s*$/.test(header))
    errors.push('The title must not end with a period.');
  return errors;
}

/** Published (non-private) workspace packages: directory name → package name. */
export function publishedPackages(root) {
  const packages = new Map();
  const directory = join(root, 'packages');
  if (!existsSync(directory)) return packages;
  for (const name of readdirSync(directory).sort()) {
    const manifest = join(directory, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg.private && typeof pkg.name === 'string')
      packages.set(name, pkg.name);
  }
  return packages;
}

/** Names of published packages with a changed file under `packages/<dir>/src/`. */
export function changedPackages(files, packages) {
  const changed = new Set();
  for (const file of files) {
    const match = /^packages\/([^/]+)\/src\//.exec(file.replaceAll('\\', '/'));
    const name = match?.[1] === undefined ? undefined : packages.get(match[1]);
    if (name) changed.add(name);
  }
  return [...changed].sort();
}

/** Changeset files (`.changeset/<id>.md`, not README.md) among `files`. */
export function changesetFiles(files) {
  return files
    .map((file) => file.replaceAll('\\', '/'))
    .filter(
      (file) =>
        /^\.changeset\/[^/]+\.md$/.test(file) && !file.endsWith('/README.md'),
    );
}

/**
 * Problems with the PR's changesets. `changesets` are the parsed changesets
 * the PR adds or edits (`{ id, text }` items are parsed here).
 */
export function checkChangesets({ files, changesets, labels, packages }) {
  if (labels.includes(skipLabel)) return [];
  const errors = [];
  const covered = new Set();
  for (const { id, text } of changesets) {
    try {
      for (const release of parseChangeset(text, id).releases)
        covered.add(release.name);
    } catch (error) {
      errors.push(
        'Invalid changeset: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  for (const name of covered)
    if (![...packages.values()].includes(name))
      errors.push(
        `A changeset names ${name}, which is not a published package.`,
      );
  const missing = changedPackages(files, packages).filter(
    (name) => !covered.has(name),
  );
  if (missing.length)
    errors.push(
      `The pull request changes the source of ${missing.join(', ')} without a changeset naming ` +
        (missing.length === 1 ? 'it' : 'them') +
        '. Run `pnpm changeset` (minor for features, patch for fixes), or add the `' +
        skipLabel +
        '` label when no published behaviour changes.',
    );
  return errors;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr);
  return result.stdout;
}

/** Files changed between the merge base of `base` and `head` (both commits). */
export function changedFiles(root, base, head = 'HEAD') {
  for (const ref of [base, head])
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.startsWith('-'))
      throw new Error('Invalid git revision: ' + ref);
  return git(
    ['diff', '--name-only', '--no-renames', base + '...' + head, '--'],
    root,
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

/** Labels from PR_LABELS: a JSON array of strings (`toJSON(...labels.*.name)`). */
export function parseLabels(value) {
  if (value === undefined || value === '') return [];
  const labels = JSON.parse(value);
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== 'string')
  )
    throw new Error('PR_LABELS must be a JSON array of label names');
  return labels;
}

/** The whole policy for one checkout; returns `{ errors, notes }`. */
export function checkPullRequest(root, env) {
  const notes = [];
  const errors = checkTitle(env.PR_TITLE);
  if (!env.PR_BASE_SHA) throw new Error('PR_BASE_SHA is required');
  const labels = parseLabels(env.PR_LABELS);
  const head = env.PR_HEAD_SHA || 'HEAD';
  const files = changedFiles(root, env.PR_BASE_SHA, head);
  const packages = publishedPackages(root);
  // Deleted changesets (consumed by a release PR) are not read.
  const changesets = changesetFiles(files)
    .filter((file) => existsSync(join(root, file)))
    .map((file) => ({
      id: file.slice('.changeset/'.length, -'.md'.length),
      text: readFileSync(join(root, file), 'utf8'),
    }));
  errors.push(...checkChangesets({ files, changesets, labels, packages }));
  const changed = changedPackages(files, packages);
  notes.push(
    `${files.length} changed file(s); package sources changed: ${changed.join(', ') || 'none'}; changesets: ${changesets.map((entry) => entry.id).join(', ') || 'none'}` +
      (labels.includes(skipLabel)
        ? `; the ${skipLabel} label skips the changeset check`
        : ''),
  );
  return { errors, notes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { errors, notes } = checkPullRequest(resolve('.'), process.env);
  for (const note of notes) console.log(note);
  if (errors.length) {
    for (const error of errors) console.error('PR policy: ' + error);
    process.exitCode = 1;
  } else console.log('PR policy passed.');
}
