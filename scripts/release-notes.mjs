// Draft release notes and upgrade/migration notes from pending Changesets.
//
//   node scripts/release-notes.mjs [--dir .changeset] [--from <version>]
//                                  [--to <version>] [--out artifacts/release]
//
// Writes <out>/release-notes.md, <out>/migration-notes.md and
// <out>/release-notes.json. The output is a DRAFT for the maintainer: entries
// are grouped and flagged (security, breaking, deprecation, new default)
// mechanically from the changeset text, and every migration row still needs a
// human-written action and a link to the test that proves it before the
// migration guide (docs/release/migration-<major>.0.md) is final. It never
// edits changesets, versions, tags or publishes anything.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bumps = ['major', 'minor', 'patch'];
const flags = {
  security:
    /\bsecurity\b|\bCVE-\d|\bGHSA-|\badvisor(?:y|ies)\b|\bvulnerab|\bXSS\b|\bCSRF\b|\btraversal\b|\binjection\b/i,
  breaking: /\bBREAKING\b|\bbreaking change/i,
  deprecation: /\bdeprecat/i,
  defaults: /\bdefaults?\b/i,
};
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** Parse one changeset file. Throws on a malformed header or bump type. */
export function parseChangeset(text, id) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${id}: missing changeset front matter`);
  const [, header = '', body = ''] = match;
  const releases = [];
  for (const line of header.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.lastIndexOf(':');
    if (separator <= 0) throw new Error(`${id}: invalid line ${line}`);
    const name = unquote(line.slice(0, separator));
    const type = unquote(line.slice(separator + 1));
    if (!bumps.includes(type) && type !== 'none')
      throw new Error(`${id}: ${name} has unknown bump ${type}`);
    if (type !== 'none') releases.push({ name, type });
  }
  const summary = body.trim();
  if (!summary) throw new Error(`${id}: empty changeset summary`);
  const type =
    bumps.find((bump) => releases.some((release) => release.type === bump)) ??
    'none';
  return {
    id,
    type,
    releases: releases.sort((a, b) => a.name.localeCompare(b.name)),
    summary,
    security: flags.security.test(summary) || /security/i.test(id),
    breaking: type === 'major' || flags.breaking.test(summary),
    deprecation: flags.deprecation.test(summary),
    defaults: flags.defaults.test(summary),
  };
}

/** Every pending changeset in `directory`, sorted by id. */
export function readChangesets(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort()
    .map((file) =>
      parseChangeset(
        readFileSync(join(directory, file), 'utf8'),
        file.replace(/\.md$/, ''),
      ),
    );
}

const firstParagraph = (text) =>
  text.split(/\r?\n\s*\r?\n/)[0].replace(/\s*\r?\n\s*/g, ' ');
const packageList = (entry) =>
  entry.releases.map((release) => `\`${release.name}\``).join(', ');
const cell = (text) => text.replaceAll('|', '\\|');

/** Build the release-notes and migration-notes drafts. */
export function buildNotes(changesets, { from, to, date }) {
  const heading = `${from ?? 'unreleased'} → ${to ?? 'next'}`;
  const bullet = (entry) =>
    `- ${firstParagraph(entry.summary)} (${packageList(entry)}; \`.changeset/${entry.id}.md\`)`;
  const section = (title, entries, empty) => [
    `## ${title}`,
    '',
    ...(entries.length ? entries.map(bullet) : [empty]),
    '',
  ];
  const security = changesets.filter((entry) => entry.security);
  const breaking = changesets.filter((entry) => entry.breaking);
  const rest = changesets.filter((entry) => !entry.security && !entry.breaking);
  const packages = [
    ...new Set(
      changesets.flatMap((entry) => entry.releases.map((r) => r.name)),
    ),
  ].sort();
  const releaseNotes = [
    `# Nestvexa ${to ?? 'next'} release notes (draft)`,
    '',
    `Generated ${date} by \`scripts/release-notes.mjs\` from ${changesets.length} changesets (${heading}).`,
    'Draft: review the wording, then attach SBOMs and link provenance when the',
    'release is published. Security fixes and breaking changes come first.',
    '',
    ...section('Security', security, 'No security-relevant changesets.'),
    ...section('Breaking changes', breaking, 'No breaking changesets.'),
    ...section(
      'Features',
      rest.filter((entry) => entry.type === 'minor'),
      'No feature changesets.',
    ),
    ...section(
      'Fixes',
      rest.filter((entry) => entry.type === 'patch'),
      'No fix changesets.',
    ),
    `## Packages`,
    '',
    `${packages.length} packages have changes; every public package releases`,
    'together under one version (Changesets fixed group).',
    '',
  ].join('\n');
  const table = (entries, empty) =>
    entries.length
      ? [
          '| Changeset | Packages | Change | Action required | Test |',
          '| --------- | -------- | ------ | --------------- | ---- |',
          ...entries.map(
            (entry) =>
              `| \`${entry.id}\` | ${cell(packageList(entry))} | ${cell(firstParagraph(entry.summary))} | _TO FILL_ | _TO FILL_ |`,
          ),
        ]
      : [empty];
  const migrationNotes = [
    `# Upgrade notes ${heading} (generated draft)`,
    '',
    `Generated ${date} by \`scripts/release-notes.mjs\`. Copy the rows into`,
    '`docs/release/migration-<major>.0.md` and replace every _TO FILL_ with the',
    'concrete action and the test that proves it. Rows are selected from the',
    'changeset text mechanically; a missing row is not proof of no change.',
    '',
    '## Before you upgrade',
    '',
    `- Upgrade every \`nestvexa\` / \`@nestvexa/*\` package to ${to ?? 'the new version'} in one step.`,
    '- Deploy server and browser assets together; Live snapshots from the previous',
    '  version are rejected and pages reload.',
    '',
    '## Breaking changes',
    '',
    ...table(breaking, 'No changeset is marked major or BREAKING.'),
    '',
    '## Security-relevant behavior changes',
    '',
    ...table(security, 'No changeset mentions a security fix.'),
    '',
    '## Deprecations',
    '',
    ...table(
      changesets.filter((entry) => entry.deprecation),
      'No changeset mentions a deprecation.',
    ),
    '',
    '## Changed defaults',
    '',
    ...table(
      changesets.filter((entry) => entry.defaults),
      'No changeset mentions a default.',
    ),
    '',
  ].join('\n');
  return {
    releaseNotes,
    migrationNotes,
    summary: {
      from: from ?? null,
      to: to ?? null,
      date,
      changesets: changesets.length,
      packages,
      security: security.map((entry) => entry.id),
      breaking: breaking.map((entry) => entry.id),
      deprecations: changesets
        .filter((entry) => entry.deprecation)
        .map((entry) => entry.id),
      defaults: changesets
        .filter((entry) => entry.defaults)
        .map((entry) => entry.id),
    },
  };
}

/** Write the three draft files into `out`; returns their paths. */
export async function writeNotes(notes, out) {
  await mkdir(out, { recursive: true });
  const files = {
    releaseNotes: join(out, 'release-notes.md'),
    migrationNotes: join(out, 'migration-notes.md'),
    summary: join(out, 'release-notes.json'),
  };
  await writeFile(files.releaseNotes, notes.releaseNotes);
  await writeFile(files.migrationNotes, notes.migrationNotes);
  await writeFile(files.summary, `${JSON.stringify(notes.summary, null, 2)}\n`);
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const changesets = readChangesets(resolve(option('--dir', '.changeset')));
  const notes = buildNotes(changesets, {
    from: option('--from'),
    to: option('--to'),
    date: new Date().toISOString().slice(0, 10),
  });
  const files = await writeNotes(
    notes,
    resolve(option('--out', 'artifacts/release')),
  );
  console.log(
    `${changesets.length} changesets: ${notes.summary.security.length} security, ${notes.summary.breaking.length} breaking. Drafts: ${Object.values(files).join(', ')}`,
  );
}
