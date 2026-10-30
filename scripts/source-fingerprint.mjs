import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Bind a checkpoint to its actual source/tests/configuration, excluding generated output. */
export async function sourceFingerprint() {
  const paths = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:ts|mjs|json|hbs|css|yaml)$/.test(path)) paths.push(path);
    }
  }
  for (const directory of ['packages', 'examples', 'tests', 'scripts'])
    await visit(directory);
  for (const entry of await readdir('.', { withFileTypes: true }))
    if (entry.isFile() && /\.(?:ts|mjs|json|yaml)$/.test(entry.name))
      paths.push(entry.name);
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash
      .update(path)
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  }
  return hash.digest('hex');
}
