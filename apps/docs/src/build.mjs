// Builds and verifies the Nestvexa documentation site.
//
//   node apps/docs/src/build.mjs [--check-only] [--out <dir>]
//
// Verification (fails the build): Markdown structure, internal links and
// heading anchors, snippet provenance, CLI command coverage, dependency graph
// and feature matrix drift. Output: a static site in artifacts/docs with the
// generated API reference under api/.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEntries, extractApi } from './api-reference.mjs';
import { analyse, escapeHtml, render } from './markdown.mjs';
import { page, relativeUrl } from './layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const outIndex = args.indexOf('--out');
const outDir = resolve(
  root,
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : 'artifacts/docs',
);
const site = JSON.parse(await readFile(join(here, '..', 'nav.json'), 'utf8'));
const rootDocuments = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'ROADMAP.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
];
// Generated records, coordinator-owned evidence and verbatim notices keep
// their own structure; their links are still checked.
const structureExempt = [
  /^docs\/implementation\//,
  /^CHANGELOG\.md$/,
  /^THIRD_PARTY_NOTICES\.md$/,
];
const problems = [];
const problem = (file, message) => problems.push(`${file}: ${message}`);
const toPosix = (path) => path.replaceAll('\\', '/');

async function walk(directory, found = []) {
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, found);
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

async function sourceDocuments() {
  const documents = await walk('docs');
  for (const file of rootDocuments)
    if (existsSync(join(root, file))) documents.push(file);
  for (const group of ['packages', 'examples'])
    for (const directory of await readdir(join(root, group))) {
      const readme = `${group}/${directory}/README.md`;
      if (existsSync(join(root, readme))) documents.push(readme);
    }
  documents.push('apps/docs/README.md');
  return documents.sort();
}

/** Published path for a source Markdown file. READMEs become index pages. */
function outputPath(source) {
  return source
    .replace(/(^|\/)README\.md$/, '$1index.html')
    .replace(/\.md$/, '.html');
}

function globToRegExp(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (pattern.startsWith('**/', index)) {
      expression += '(?:.*/)?';
      index += 2;
    } else if (character === '*') expression += '[^/]*';
    else expression += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`);
}

// ---------------------------------------------------------------------------
// Load and analyse every document.
const documents = new Map();
for (const source of await sourceDocuments()) {
  const markdown = await readFile(join(root, source), 'utf8');
  const analysis = analyse(markdown);
  const firstHeading = analysis.headings.find((heading) => heading.depth === 1);
  documents.set(source, {
    source,
    markdown,
    analysis,
    output: outputPath(source),
    title: firstHeading?.text ?? posix.basename(source, '.md'),
  });
}

// ---------------------------------------------------------------------------
// Structure: one leading H1, no skipped heading levels.
for (const document of documents.values()) {
  if (structureExempt.some((pattern) => pattern.test(document.source)))
    continue;
  const { headings } = document.analysis;
  const firstLine = document.markdown.trimStart().split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith('# '))
    problem(document.source, 'must start with a single "# " title');
  const titles = headings.filter((heading) => heading.depth === 1);
  if (titles.length !== 1)
    problem(document.source, `expected one H1, found ${titles.length}`);
  let previous = 1;
  for (const heading of headings) {
    if (heading.depth > previous + 1)
      problem(
        document.source,
        `heading "${heading.text}" skips from H${previous} to H${heading.depth}`,
      );
    previous = heading.depth;
  }
}

// ---------------------------------------------------------------------------
// Links: relative targets exist; anchors match a heading or explicit id.
for (const document of documents.values()) {
  for (const { href } of document.analysis.links) {
    if (/^(?:https?:|mailto:)/.test(href)) continue;
    if (href.startsWith('/')) {
      problem(
        document.source,
        `absolute link "${href}" breaks on GitHub and the site`,
      );
      continue;
    }
    const [rawTarget = '', anchor] = href.split('#');
    let target = document.source;
    if (rawTarget) {
      let decoded;
      try {
        decoded = decodeURIComponent(rawTarget);
      } catch {
        problem(document.source, `malformed link "${href}"`);
        continue;
      }
      target = posix.normalize(
        posix.join(posix.dirname(document.source), decoded),
      );
      if (target.startsWith('..') || !existsSync(join(root, target))) {
        problem(document.source, `broken link "${href}"`);
        continue;
      }
    }
    if (anchor) {
      const linked = documents.get(target);
      if (!linked && target.endsWith('.md'))
        problem(
          document.source,
          `anchor "${href}" points into an unpublished file`,
        );
      else if (linked && !linked.analysis.anchors.has(anchor))
        problem(document.source, `missing anchor "#${anchor}" in ${target}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Snippet provenance: a fence after <!-- snippet: path --> must be a verbatim
// (whitespace-insensitive) excerpt of that compiled/tested file.
const squash = (value) => value.replace(/\s+/g, '');
const snippetCache = new Map();
let snippetCount = 0;
for (const document of documents.values()) {
  for (const snippet of document.analysis.snippets) {
    snippetCount++;
    if (snippet.code === undefined) {
      problem(
        document.source,
        `snippet marker for ${snippet.source} is not followed by a code fence`,
      );
      continue;
    }
    const file = join(root, snippet.source);
    if (!existsSync(file)) {
      problem(
        document.source,
        `snippet source ${snippet.source} does not exist`,
      );
      continue;
    }
    if (!snippetCache.has(file))
      snippetCache.set(file, squash(await readFile(file, 'utf8')));
    if (!snippetCache.get(file).includes(squash(snippet.code)))
      problem(document.source, `snippet no longer matches ${snippet.source}`);
  }
}

// ---------------------------------------------------------------------------
// Drift checks against the workspace itself.
const packageDirs = (await readdir(join(root, 'packages')))
  .filter((directory) =>
    existsSync(join(root, 'packages', directory, 'package.json')),
  )
  .sort();
const manifests = new Map();
for (const directory of packageDirs)
  manifests.set(
    directory,
    JSON.parse(
      await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'),
    ),
  );
const nameToDir = new Map(
  [...manifests].map(([directory, manifest]) => [manifest.name, directory]),
);

// Dependency graph: every package is a node and every workspace edge is drawn
// (solid for dependencies, dotted for peer dependencies), with no stale edges.
{
  const graphFile = 'docs/architecture/package-dependency-graph.md';
  const graph = documents.get(graphFile);
  if (!graph) problem(graphFile, 'missing');
  else {
    const mermaid = [...graph.markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join('\n');
    const nodes = new Set();
    const drawn = new Set();
    for (const match of mermaid.matchAll(
      /([\w-]+)(?:\[[^\]]*\])?\s*(-->|-\.->)\s*([\w-]+)/g,
    )) {
      nodes.add(match[1]);
      nodes.add(match[3]);
      drawn.add(`${match[1]} ${match[2]} ${match[3]}`);
    }
    for (const match of mermaid.matchAll(/^\s*([\w-]+)\[/gm))
      nodes.add(match[1]);
    const expected = new Set();
    for (const [directory, manifest] of manifests) {
      if (!nodes.has(directory))
        problem(graphFile, `package ${directory} is not in the graph`);
      for (const [field, arrow] of [
        ['dependencies', '-->'],
        ['peerDependencies', '-.->'],
      ])
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const target = nameToDir.get(dependency);
          if (!target) continue;
          expected.add(`${directory} ${arrow} ${target}`);
          if (!drawn.has(`${directory} ${arrow} ${target}`))
            problem(
              graphFile,
              `missing edge ${directory} ${arrow} ${target} (${field})`,
            );
        }
    }
    for (const edge of drawn) {
      const [from, , to] = edge.split(' ');
      if (manifests.has(from) && manifests.has(to) && !expected.has(edge))
        problem(
          graphFile,
          `edge "${edge}" is not declared in packages/${from}/package.json`,
        );
    }
  }
}

// Feature matrix and architecture overview cover every package.
for (const file of [
  'docs/feature-matrix.md',
  'docs/architecture/overview.md',
]) {
  const document = documents.get(file);
  if (!document) {
    problem(file, 'missing');
    continue;
  }
  for (const [directory, manifest] of manifests)
    if (
      !document.markdown.includes(`packages/${directory}/`) &&
      !document.markdown.includes(`\`${manifest.name}\``)
    )
      problem(file, `does not mention package ${manifest.name}`);
}

// CLI reference: every documented command is known to the built CLI.
{
  const cliFile = 'docs/reference/cli.md';
  const bin = join(root, 'packages/cli/dist/bin.js');
  const reference = documents.get(cliFile);
  if (!existsSync(bin))
    problem(
      cliFile,
      'packages/cli is not built; run `pnpm build` before `pnpm docs:build`',
    );
  else if (reference) {
    const help = execFileSync(process.execPath, [bin, '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    const documented = new Set();
    for (const match of reference.markdown.matchAll(
      /`nestvexa ([a-z][\w:-]*)/g,
    ))
      documented.add(match[1]);
    // Copy-paste commands anywhere in the docs must be real commands too.
    for (const document of documents.values())
      for (const match of document.markdown.matchAll(
        /npx nestvexa ([a-z][\w:-]*)/g,
      ))
        documented.add(match[1]);
    for (const command of documented)
      if (
        !new RegExp(
          `(^|\\s)${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|\\b)`,
          'm',
        ).test(help)
      )
        problem(
          cliFile,
          `documents "nestvexa ${command}" but \`nestvexa --help\` does not list it`,
        );
  }
}

// ---------------------------------------------------------------------------
// API reference from the built declaration files.
const { entries, missing } = await collectEntries(root);
for (const file of missing)
  problem(
    'api',
    `${toPosix(file)} missing; run \`pnpm build\` before \`pnpm docs:build\``,
  );

if (problems.length > 0) {
  console.error(`Documentation checks failed (${problems.length}):`);
  for (const message of problems) console.error(`  - ${message}`);
  process.exit(1);
}
const api = extractApi(root, entries);
const symbolCount = api.reduce(
  (total, record) =>
    total +
    record.subpaths.reduce((sum, entry) => sum + entry.symbols.length, 0),
  0,
);
console.log(
  `Checked ${documents.size} documents, ${snippetCount} provenance snippets, ${packageDirs.length} packages and ${symbolCount} exported API symbols.`,
);
if (checkOnly) process.exit(0);

// ---------------------------------------------------------------------------
// Navigation: explicit pages first, then `include` globs; anything left over
// is listed under "More" so every page stays reachable.
const placed = new Set();
const sections = [];
for (const section of site.sections) {
  const items = [];
  for (const source of section.pages ?? []) {
    const document = documents.get(source);
    if (!document) {
      problem('apps/docs/nav.json', `page ${source} does not exist`);
      continue;
    }
    if (placed.has(source)) continue;
    placed.add(source);
    items.push(document);
  }
  for (const link of section.links ?? [])
    items.push({ title: link.title, output: link.href });
  if (section.include) {
    const pattern = globToRegExp(section.include);
    const matched = [...documents.values()]
      .filter(
        (document) =>
          pattern.test(document.source) && !placed.has(document.source),
      )
      .sort((left, right) => left.title.localeCompare(right.title));
    for (const document of matched) {
      placed.add(document.source);
      items.push(document);
    }
  }
  sections.push({ title: section.title, items });
}
const leftovers = [...documents.values()].filter(
  (document) => !placed.has(document.source),
);
if (leftovers.length > 0) sections.push({ title: 'More', items: leftovers });
if (problems.length > 0) {
  for (const message of problems) console.error(`  - ${message}`);
  process.exit(1);
}

const rootManifest = JSON.parse(
  await readFile(join(root, 'packages/nestvexa/package.json'), 'utf8'),
);
const shell = {
  ...site,
  status: `${rootManifest.version} (alpha, not release-ready)`,
  sections,
};

// ---------------------------------------------------------------------------
// Render.
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'assets'), { recursive: true });
await copyFile(
  join(here, '..', 'assets', 'site.css'),
  join(outDir, 'assets', 'site.css'),
);
await copyFile(
  join(here, '..', 'assets', 'site.js'),
  join(outDir, 'assets', 'site.js'),
);

for (const document of documents.values()) {
  const resolveHref = (href) => {
    if (/^(?:https?:|mailto:|#)/.test(href)) return href;
    const [rawTarget = '', anchor] = href.split('#');
    const suffix = anchor ? `#${anchor}` : '';
    const target = posix.normalize(
      posix.join(posix.dirname(document.source), decodeURIComponent(rawTarget)),
    );
    const linked =
      documents.get(target) ?? documents.get(posix.join(target, 'README.md'));
    if (linked) return relativeUrl(document.output, linked.output) + suffix;
    const kind =
      existsSync(join(root, target)) &&
      statSync(join(root, target)).isDirectory()
        ? 'tree'
        : 'blob';
    return `${site.repository}/${kind}/${site.branch}/${target.replace(/\/$/, '')}${suffix}`;
  };
  const body = render(document.markdown, resolveHref);
  const toc = document.analysis.headings.filter(
    (heading) => heading.depth === 2 || heading.depth === 3,
  );
  const output = join(outDir, document.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    page(shell, {
      output: document.output,
      title: document.title,
      body,
      source: document.source,
      toc,
    }),
  );
}

// API reference pages.
await mkdir(join(outDir, 'api'), { recursive: true });
const apiRows = [];
for (const record of api) {
  const symbols = record.subpaths.flatMap((entry) => entry.symbols);
  const documented = symbols.filter((symbol) => symbol.summary).length;
  apiRows.push(
    `<tr><td><a href="${escapeHtml(record.packageDir)}.html"><code>${escapeHtml(record.name)}</code></a></td><td>${escapeHtml(record.description)}</td><td>${record.subpaths.length}</td><td>${symbols.length}</td><td>${documented}</td></tr>`,
  );
  const readme = documents.get(`packages/${record.packageDir}/README.md`);
  const readmeLink = readme
    ? `<p>Guide: <a href="${escapeHtml(relativeUrl(`api/${record.packageDir}.html`, readme.output))}">${escapeHtml(record.name)} README</a>.</p>`
    : '';
  const sectionsHtml = record.subpaths
    .map((entry) => {
      const list = entry.symbols
        .map((symbol) => {
          const id = `${entry.subpath === '.' ? '' : `${entry.subpath.slice(2)}-`}${symbol.name}`;
          const from = symbol.reexportedFrom
            ? `<p class="meta">Re-exported from <a href="${escapeHtml(symbol.reexportedFrom)}.html">${escapeHtml(manifests.get(symbol.reexportedFrom)?.name ?? symbol.reexportedFrom)}</a>.</p>`
            : '';
          const deprecated = symbol.deprecated
            ? '<p class="meta deprecated">Deprecated.</p>'
            : '';
          const summary = symbol.summary
            ? `<p>${escapeHtml(symbol.summary)}</p>`
            : '<p class="meta">No documentation comment.</p>';
          const signatures = symbol.signatures
            .map(
              (signature) =>
                `<pre data-language="ts"><code>${escapeHtml(signature)}</code></pre>`,
            )
            .join('');
          return `<section class="symbol" id="${escapeHtml(id)}"><h3><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a><span class="kind">${escapeHtml(symbol.kind)}</span> <code>${escapeHtml(symbol.name)}</code></h3>${deprecated}${from}${summary}${signatures}</section>`;
        })
        .join('');
      return `<h2 id="${escapeHtml(entry.subpath === '.' ? 'main' : entry.subpath.slice(2))}"><code>${escapeHtml(entry.specifier)}</code></h2><p class="meta">${entry.symbols.length} exports.</p>${list}`;
    })
    .join('');
  const output = `api/${record.packageDir}.html`;
  await writeFile(
    join(outDir, output),
    page(shell, {
      output,
      title: `${record.name} API`,
      body: `<h1><code>${escapeHtml(record.name)}</code> API reference</h1><p>${escapeHtml(record.description)}</p><p class="meta">Generated from the package's published <code>.d.ts</code> entry points at version ${escapeHtml(record.version)}. Signatures are the declaration text; comments are the source TSDoc.</p>${readmeLink}${sectionsHtml}`,
      toc: record.subpaths.map((entry) => ({
        depth: 2,
        id: entry.subpath === '.' ? 'main' : entry.subpath.slice(2),
        text: entry.specifier,
      })),
    }),
  );
}
await writeFile(
  join(outDir, 'api/index.html'),
  page(shell, {
    output: 'api/index.html',
    title: 'API reference',
    body: `<h1>API reference</h1><p>Generated by <code>pnpm docs:build</code> from the TypeScript declarations each package publishes (every <code>exports</code> subpath with types). It lists what a consumer can import; the package READMEs and guides explain how to use it.</p><table><thead><tr><th>Package</th><th>Purpose</th><th>Entry points</th><th>Exports</th><th>With doc comment</th></tr></thead><tbody>${apiRows.join('')}</tbody></table>`,
  }),
);
await writeFile(
  join(outDir, 'api/api.json'),
  `${JSON.stringify(api, null, 2)}\n`,
);

console.log(
  `Generated ${documents.size} pages and ${api.length + 1} API reference pages in ${toPosix(relative(root, outDir)) || '.'}.`,
);
