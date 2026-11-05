// Generates the API reference from the published `.d.ts` entry points of every
// package, using the pinned TypeScript compiler API instead of a separate
// documentation generator (see docs/adr/0027-documentation-site.md).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const kinds = new Map([
  [ts.SyntaxKind.ClassDeclaration, 'class'],
  [ts.SyntaxKind.FunctionDeclaration, 'function'],
  [ts.SyntaxKind.InterfaceDeclaration, 'interface'],
  [ts.SyntaxKind.TypeAliasDeclaration, 'type'],
  [ts.SyntaxKind.VariableDeclaration, 'const'],
  [ts.SyntaxKind.EnumDeclaration, 'enum'],
  [ts.SyntaxKind.ModuleDeclaration, 'namespace'],
]);
const kindOrder = [
  'class',
  'function',
  'const',
  'interface',
  'type',
  'enum',
  'namespace',
];

function typesEntry(target) {
  if (typeof target === 'string')
    return target.endsWith('.js') ? target.replace(/\.js$/, '.d.ts') : null;
  if (target && typeof target === 'object') {
    if (typeof target.types === 'string') return target.types;
    if (typeof target.import === 'string') return typesEntry(target.import);
    if (typeof target.default === 'string') return typesEntry(target.default);
  }
  return null;
}

/** Lists `{ packageDir, name, subpath, file }` for every typed export subpath. */
export async function collectEntries(root) {
  const { readdir } = await import('node:fs/promises');
  const entries = [];
  const missing = [];
  for (const directory of (await readdir(join(root, 'packages'))).sort()) {
    const manifestPath = join(root, 'packages', directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const exportsField =
      typeof manifest.exports === 'object' && manifest.exports
        ? manifest.exports
        : { '.': manifest.exports };
    for (const [subpath, target] of Object.entries(exportsField)) {
      const types = typesEntry(target);
      if (!types) continue;
      const file = resolve(root, 'packages', directory, types);
      if (!existsSync(file)) missing.push(relative(root, file));
      entries.push({
        packageDir: directory,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        subpath,
        specifier:
          subpath === '.'
            ? manifest.name
            : `${manifest.name}${subpath.slice(1)}`,
        file,
      });
    }
  }
  return { entries, missing };
}

/** Declaration source text without JSDoc, `export` and `declare` modifiers. */
function declarationText(declaration) {
  const text = declaration.getText();
  if (ts.isVariableDeclaration(declaration)) {
    const flags = declaration.parent.flags;
    const keyword =
      flags & ts.NodeFlags.Const
        ? 'const'
        : flags & ts.NodeFlags.Let
          ? 'let'
          : 'var';
    return `${keyword} ${text};`;
  }
  return text.replace(/^(?:export\s+)?(?:declare\s+)?/, '');
}

function packageOf(root, fileName) {
  const path = relative(join(root, 'packages'), resolve(fileName));
  if (path.startsWith('..')) return undefined;
  return path.split(sep)[0];
}

/**
 * Extracts the exported API of every entry. Returns one record per package with
 * its subpaths and documented symbols.
 */
export function extractApi(root, entries) {
  const program = ts.createProgram(
    entries.map((entry) => entry.file),
    {
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
      // Declaration text and TSDoc need no lib types; skipping lib.d.ts keeps
      // the extraction fast.
      noLib: true,
    },
  );
  const checker = program.getTypeChecker();
  const packages = new Map();
  for (const entry of entries) {
    const record = packages.get(entry.packageDir) ?? {
      packageDir: entry.packageDir,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      subpaths: [],
    };
    packages.set(entry.packageDir, record);
    const source = program.getSourceFile(entry.file);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    const symbols = [];
    if (moduleSymbol) {
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol =
          exported.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(exported)
            : exported;
        const declarations = (symbol.declarations ?? []).filter((node) =>
          kinds.has(node.kind),
        );
        if (declarations.length === 0) continue;
        const first = declarations[0];
        const origin = packageOf(root, first.getSourceFile().fileName);
        const tags = symbol.getJsDocTags(checker).map((tag) => ({
          name: tag.name,
          text: ts.displayPartsToString(tag.text ?? []),
        }));
        symbols.push({
          name: exported.getName(),
          kind: kinds.get(first.kind) ?? 'other',
          summary: ts.displayPartsToString(
            symbol.getDocumentationComment(checker),
          ),
          deprecated: tags.some((tag) => tag.name === 'deprecated'),
          tags,
          reexportedFrom:
            origin && origin !== entry.packageDir ? origin : undefined,
          signatures: declarations.map(declarationText),
        });
      }
    }
    symbols.sort(
      (left, right) =>
        kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
        left.name.localeCompare(right.name),
    );
    record.subpaths.push({
      subpath: entry.subpath,
      specifier: entry.specifier,
      symbols,
    });
  }
  return [...packages.values()];
}
