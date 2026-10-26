import { readdir, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';

const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.md')) files.push(path);
  }
}
await walk('docs');
files.push('README.md');
for (const directory of await readdir('packages'))
  files.push(join('packages', directory, 'README.md'));
for (const file of files) {
  const markdown = await readFile(file, 'utf8');
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    if (target) await access(resolve(dirname(file), target));
  }
  const output = join('artifacts/docs', file.replace(/\.md$/, '.html'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(file)} — Nestvexa</title></head><body><main><h1>${escape(file)}</h1><pre style="white-space:pre-wrap;max-width:90ch">${escape(markdown)}</pre></main></body></html>`,
  );
}
await writeFile(
  'artifacts/docs/index.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nestvexa documentation</title></head><body><main><h1>Nestvexa documentation snapshot</h1><p>Implementation preview. Markdown source rendered verbatim; a complete documentation website remains a release requirement.</p><ul>${files.map((file) => `<li><a href="${escape(relative('.', file).replaceAll('\\', '/').replace(/\.md$/, '.html'))}">${escape(file)}</a></li>`).join('')}</ul></main></body></html>`,
);
console.log(
  `Validated internal file links and generated ${files.length} documentation snapshots.`,
);
